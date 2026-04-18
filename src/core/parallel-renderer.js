/**
 * Parallel Renderer — Split renders across N worker threads
 *
 * The core engine. Splits frame ranges across workers, each encoding
 * independently to a segment MP4, then stream-copy concats the result.
 *
 * This module is GENERIC — it doesn't know what generates frames.
 * You provide a workerScript path that handles frame generation.
 *
 * Architecture:
 *   1. Validate inputs + check ffmpeg availability
 *   2. Calculate optimal workers (or use override)
 *   3. Start dashboard + auto-open browser BEFORE render
 *   4. Split totalFrames into N ranges
 *   5. Spawn N workers, each renders its range to a segment
 *   6. Collect progress via message passing -> feed to ProgressTracker
 *   7. Concat segments with stream copy (instant)
 *   8. Cleanup temp files
 */
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { concatSegments } = require('./concat');
const { getOptimalWorkers } = require('./config');
const { ProgressTracker } = require('./progress');
const { startDashboard } = require('./dashboard-server');
const { checkFFmpeg, validateResolution } = require('./gpu-detect');

/**
 * Render a video using parallel workers.
 *
 * @param {Object} options
 * @param {string} options.workerScript - Path to worker .js file (receives workerData via worker_threads)
 * @param {string} options.outputPath - Final output video path
 * @param {number} [options.width=1920] - Frame width
 * @param {number} [options.height=1080] - Frame height
 * @param {number} [options.fps=60] - Framerate
 * @param {number} [options.duration=60] - Duration in seconds
 * @param {number} [options.workerCount] - Override auto-detected worker count
 * @param {number} [options.seed=42] - RNG seed for deterministic output
 * @param {string} [options.title='Render'] - Title shown in dashboard
 * @param {Object} [options.workerData={}] - Extra data passed to each worker
 * @param {boolean} [options.dashboard=true] - Enable live dashboard
 * @param {boolean} [options.autoOpen=true] - Auto-open dashboard in browser
 * @param {number} [options.dashboardPort=8080] - Dashboard starting port
 * @returns {Promise<{ outputPath: string, elapsed: number, totalFrames: number }>}
 */
async function renderParallel(options) {
  const {
    workerScript,
    outputPath,
    width = 1920,
    height = 1080,
    fps = 60,
    duration = 60,
    workerCount: requestedWorkers,
    seed = 42,
    title = 'Render',
    workerData: extraWorkerData = {},
    dashboard = true,
    autoOpen = true,
    dashboardPort = 8080,
  } = options;

  // --- Validate inputs ---
  const ffmpegStatus = checkFFmpeg();
  if (!ffmpegStatus.available) {
    throw new Error(ffmpegStatus.error);
  }

  validateResolution(width, height);

  if (!workerScript || !fs.existsSync(workerScript)) {
    throw new Error(`Worker script not found: ${workerScript}`);
  }

  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 1 || fps > 240) {
    throw new Error(`Invalid fps: ${fps}. Must be a finite number between 1 and 240.`);
  }

  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid duration: ${duration}. Must be a positive finite number.`);
  }

  if (typeof dashboardPort !== 'number' || !Number.isInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65535) {
    throw new Error(`Invalid dashboardPort: ${dashboardPort}. Must be an integer in 1-65535.`);
  }

  const totalFrames = Math.max(1, Math.floor(fps * duration));
  const auto = getOptimalWorkers({ width, height });
  const requestedN = Number.isInteger(requestedWorkers) && requestedWorkers > 0 ? requestedWorkers : auto.workers;
  const numWorkers = Math.max(1, Math.min(requestedN, totalFrames));
  const framesPerWorker = Math.ceil(totalFrames / numWorkers);

  // Ensure output directory exists
  const outputDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // Temp directory for segments
  const tempDir = path.join(outputDir, '.parallel-temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  console.log('');
  console.log('='.repeat(60));
  console.log(`  ffmpeg-render-pro \u2014 ${numWorkers} workers`);
  console.log('='.repeat(60));
  console.log(`  Title:         ${title}`);
  console.log(`  Total frames:  ${totalFrames.toLocaleString()} (${duration}s @ ${fps}fps)`);
  console.log(`  Resolution:    ${width}x${height} (${auto.tier})`);
  console.log(`  Per worker:    ~${framesPerWorker.toLocaleString()} frames`);
  console.log(`  System:        ${auto.cpuCores} cores, ${auto.totalRamMB}MB RAM`);
  console.log(`  ffmpeg:        ${ffmpegStatus.version}`);
  console.log(`  Temp dir:      ${tempDir}`);
  console.log('='.repeat(60));
  console.log('');

  // Progress tracker
  const progress = new ProgressTracker({
    numWorkers,
    totalFrames,
    framesPerWorker,
    outputDir,
    title,
    resolution: `${width}x${height}`,
  });

  // Start dashboard and auto-open browser BEFORE rendering begins
  let dashboardHandle = null;
  if (dashboard) {
    progress.setPhase('initializing', `Setting up ${numWorkers} workers...`);
    progress.start();
    try {
      dashboardHandle = await startDashboard({
        dir: outputDir,
        port: dashboardPort,
        autoOpen,
      });
    } catch (err) {
      console.warn('  Warning: could not start dashboard:', err.message);
    }
  }

  const startTime = Date.now();
  const segmentPaths = [];
  const workers = [];

  // Track worker states with Set to avoid race condition double-counting
  const renderingWorkers = new Set();
  const forwardingWorkers = new Set();
  const doneWorkers = new Set();

  // --- Graceful shutdown on SIGINT/SIGTERM ---
  // Install scoped handlers and remove them when renderParallel finishes.
  // This prevents handler accumulation across repeated calls.
  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    console.log('\n  Shutting down gracefully...');
    progress.stop();
    if (dashboardHandle) dashboardHandle.stop().catch(() => {});
    for (const w of workers) {
      try { w.terminate(); } catch {}
    }
    // Use rmSync (recursive, force) — handles locked files gracefully on Windows.
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }

  const onSigint = () => { cleanup(); process.exit(130); };
  const onSigterm = () => { cleanup(); process.exit(143); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  const removeSignalHandlers = () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };

  // Spawn workers
  progress.setPhase('spawning', `Launching ${numWorkers} worker threads...`);
  const workerPromises = [];
  for (let i = 0; i < numWorkers; i++) {
    const startFrame = i * framesPerWorker;
    const endFrame = Math.min(startFrame + framesPerWorker, totalFrames);
    if (startFrame >= totalFrames) break;

    const segmentPath = path.join(tempDir, `segment-${String(i).padStart(3, '0')}.mp4`);
    segmentPaths.push(segmentPath);

    const promise = new Promise((resolve, reject) => {
      const worker = new Worker(workerScript, {
        workerData: {
          ...extraWorkerData,
          width, height, fps, seed,
          startFrame, endFrame, segmentPath,
          workerId: i, totalFrames, duration,
        },
      });
      workers.push(worker);

      worker.on('message', (msg) => {
        if (msg.type === 'progress') {
          if (!renderingWorkers.has(msg.workerId)) {
            renderingWorkers.add(msg.workerId);
            if (renderingWorkers.size === 1) {
              // First worker to start rendering
              progress.setPhase('rendering', `Rendering ${totalFrames.toLocaleString()} frames across ${numWorkers} workers...`);
            }
          }
          progress.updateWorker(msg.workerId, {
            pct: parseFloat(msg.pct) || 0,
            fps: parseFloat(msg.fps) || 0,
            frame: msg.frame || 0,
            eta: parseFloat(msg.eta) || 0,
            status: 'rendering',
          });
        } else if (msg.type === 'fast-forward-start') {
          // Structured message from workers that are fast-forwarding state.
          forwardingWorkers.add(msg.workerId);
          progress.updateWorker(msg.workerId, { status: 'fast-forward' });
          progress.setPhase('fast-forward', `Fast-forwarding worker state (${forwardingWorkers.size}/${numWorkers} workers) \u2014 this is the slow part...`);
        } else if (msg.type === 'log') {
          // Backwards-compat: old workers used type:'log' with a 'Fast-forward' substring.
          if (msg.msg && msg.msg.includes('Fast-forward')) {
            forwardingWorkers.add(msg.workerId);
            progress.updateWorker(msg.workerId, { status: 'fast-forward' });
            progress.setPhase('fast-forward', `Fast-forwarding worker state (${forwardingWorkers.size}/${numWorkers} workers) \u2014 this is the slow part...`);
          }
        } else if (msg.type === 'done') {
          doneWorkers.add(msg.workerId);
          progress.workerDone(msg.workerId);
          resolve(msg);
        } else if (msg.type === 'error') {
          reject(new Error(`Worker ${msg.workerId} failed: ${msg.error}`));
        }
      });

      worker.on('error', (err) => {
        reject(new Error(`Worker ${i} error: ${err.message}`));
      });

      worker.on('exit', (code) => {
        // If a worker exits without sending a `done` message, resolve anyway
        // (the segment file will still be checked during concat). This prevents
        // the Promise.all from hanging forever on silent exits.
        if (!doneWorkers.has(i)) {
          if (code === 0 || code === null) {
            resolve({ type: 'done', workerId: i, implicit: true });
          } else {
            reject(new Error(`Worker ${i} exited with code ${code}`));
          }
        }
      });
    });

    workerPromises.push(promise);
  }

  try {
    await Promise.all(workerPromises);
    progress.stop();

    const renderTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log(`  All ${numWorkers} workers done in ${renderTime}s. Concatenating...`);

    progress.setPhase('concatenating', `Joining ${numWorkers} segments with stream copy (instant, no re-encode)...`);
    await concatSegments(segmentPaths, outputPath);

    // Cleanup temp dir (recursive, force — handles any stray files + Windows locks)
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

    const elapsed = (Date.now() - startTime) / 1000;
    const minutes = (elapsed / 60).toFixed(1);
    progress.setPhase('complete', `Done! ${totalFrames.toLocaleString()} frames in ${elapsed.toFixed(1)}s (${minutes}min)`);
    console.log(`  Render complete: ${totalFrames.toLocaleString()} frames in ${elapsed.toFixed(1)}s (${minutes}min)`);
    console.log(`  Output: ${outputPath}`);

    // Keep dashboard alive for 30s after completion so user can see final state
    if (dashboardHandle) {
      setTimeout(() => {
        dashboardHandle.stop().catch(() => {});
      }, 30000);
    }

    removeSignalHandlers();
    return { outputPath, elapsed, totalFrames };

  } catch (err) {
    cleanup();
    removeSignalHandlers();
    throw err;
  }
}

module.exports = { renderParallel };
