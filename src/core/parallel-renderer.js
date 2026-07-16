/**
 * Parallel Renderer - Split renders across N worker threads
 *
 * The core engine. Splits frame ranges across workers, each encoding
 * independently to a segment MP4, then stream-copy concats the result.
 *
 * This module is GENERIC - it doesn't know what generates frames.
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
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { concatSegments } = require('./concat');
const { getOptimalWorkers, planWorkers, computeTotalFrames } = require('./config');
const { ProgressTracker } = require('./progress');
const { startDashboard } = require('./dashboard-server');
const { checkFFmpeg, validateResolution } = require('./gpu-detect');

const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;

function makeAbortError() {
  const err = new Error('Render aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Remove leftover `.parallel-temp*` dirs from renders that were hard-killed
 * (no cleanup ran). A dir is only swept when its newest entry is over a day
 * old, so a concurrent render's still-encoding segments are never touched.
 */
function sweepStaleTempDirs(outputDir) {
  let entries;
  try { entries = fs.readdirSync(outputDir); } catch { return; }
  for (const name of entries) {
    if (!/^\.parallel-temp(-[0-9a-f]+)?$/.test(name)) continue;
    const dir = path.join(outputDir, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      let newest = fs.statSync(dir).mtimeMs;
      for (const f of fs.readdirSync(dir)) {
        const m = fs.statSync(path.join(dir, f)).mtimeMs;
        if (m > newest) newest = m;
      }
      if (Date.now() - newest > STALE_TEMP_AGE_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {}
  }
}

/**
 * Best-effort output verification: one ffprobe read of container metadata
 * (stream nb_frames, falling back to format duration). Deliberately NOT
 * -count_packets / -count_frames, which decode the whole file and are far
 * too slow for long-form output. Prints a one-line stderr WARNING when the
 * output disagrees with the requested length by more than one frame; never
 * fails the render; silent when ffprobe is missing or metadata is unreadable.
 */
function verifyOutput(outputPath, totalFrames, fps) {
  let result;
  try {
    result = spawnSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_frames',
      '-show_entries', 'format=duration',
      '-of', 'json',
      outputPath,
    ], { encoding: 'utf-8', timeout: 15000 });
  } catch { return; }
  if (!result || result.error || result.status !== 0 || !result.stdout) return;

  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { return; }

  const nbFrames = Number(parsed.streams?.[0]?.nb_frames);
  if (Number.isFinite(nbFrames) && nbFrames > 0) {
    if (Math.abs(nbFrames - totalFrames) > 1) {
      process.stderr.write(`  WARNING: output has ${nbFrames} frames but ${totalFrames} were requested; a segment may be incomplete.\n`);
    }
    return;
  }

  const outDuration = Number(parsed.format?.duration);
  if (Number.isFinite(outDuration) && outDuration > 0) {
    const expected = totalFrames / fps;
    if (Math.abs(outDuration - expected) > 1 / fps + 0.001) {
      process.stderr.write(`  WARNING: output duration is ${outDuration.toFixed(3)}s but ${expected.toFixed(3)}s was requested; a segment may be incomplete.\n`);
    }
  }
}

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
 * @param {number} [options.maxWorkers=8] - Cap for auto worker count (ignored when workerCount is set)
 * @param {number} [options.dashboardLingerMs=30000] - How long to keep the dashboard alive after completion. Pass 0 to return immediately (library use).
 * @param {AbortSignal} [options.signal] - Abort the render: workers are stopped, temp files removed, and the promise rejects with an Error whose name is 'AbortError'.
 * @param {boolean} [options.quiet=false] - Write banner/status lines to stderr instead of stdout and disable the terminal progress ticker (dashboard JSON files are still written). Keeps stdout byte-clean for protocol use, e.g. MCP stdio.
 * @returns {Promise<{ outputPath: string, elapsed: number, totalFrames: number, avgFps: number }>}
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
    maxWorkers = 8,
    dashboardLingerMs = 30000,
    signal,
    quiet = false,
  } = options;

  // --- Validate inputs ---
  const ffmpegStatus = checkFFmpeg();
  if (!ffmpegStatus.available) {
    throw new Error(ffmpegStatus.error);
  }

  validateResolution(width, height);

  // The encode pipeline emits yuv420p, which requires even dimensions.
  // Catch it here with a clear message instead of letting ffmpeg fail deep
  // inside a worker with "height not divisible by 2".
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error(
      `Resolution ${width}x${height} must have even width and height for yuv420p encoding. ` +
      `Try ${width - (width % 2)}x${height - (height % 2)}.`
    );
  }

  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('outputPath is required and must be a string.');
  }

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

  if (signal !== undefined && signal !== null) {
    if (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean') {
      throw new Error('Invalid signal: expected an AbortSignal.');
    }
    if (signal.aborted) throw makeAbortError();
  }

  // All human-facing status output funnels through here: quiet renders keep
  // stdout byte-clean (MCP stdio treats stdout as a protocol channel) and
  // route these lines to stderr instead.
  const say = quiet
    ? (line = '') => process.stderr.write(line + '\n')
    : (line = '') => console.log(line);

  const totalFrames = computeTotalFrames(fps, duration);
  const auto = getOptimalWorkers({ width, height, maxWorkers });
  const requestedN = Number.isInteger(requestedWorkers) && requestedWorkers > 0 ? requestedWorkers : auto.workers;
  // planWorkers() returns the TRUE worker count after ceil() chunking, so the
  // console banner, progress tracker, and dashboard never show idle phantom
  // workers (e.g. 10 frames / 8 requested -> 5 real workers).
  const { workers: numWorkers, framesPerWorker } = planWorkers(totalFrames, requestedN);

  // Ensure output directory exists
  const outputDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // Temp directory for segments. The name carries a random suffix so two
  // renders targeting the same output directory can't overwrite each other's
  // segments or delete each other's temp dir during cleanup.
  sweepStaleTempDirs(outputDir);
  const tempDir = path.join(outputDir, `.parallel-temp-${crypto.randomBytes(4).toString('hex')}`);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  if (quiet) {
    process.stderr.write(
      `  ffmpeg-render-pro: ${totalFrames.toLocaleString()} frames (${duration}s @ ${fps}fps, ${width}x${height}), ${numWorkers} workers -> ${outputPath}\n`
    );
  } else {
    console.log('');
    console.log('='.repeat(60));
    console.log(`  ffmpeg-render-pro - ${numWorkers} workers`);
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
  }

  // Progress tracker. terminalStream: null disables the ANSI ticker while
  // keeping the dashboard JSON writes.
  const progress = new ProgressTracker({
    numWorkers,
    totalFrames,
    framesPerWorker,
    outputDir,
    title,
    resolution: `${width}x${height}`,
    terminalStream: quiet ? null : process.stdout,
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

  // --- Graceful shutdown on SIGINT/SIGTERM + error-path cleanup ---
  // Install scoped handlers and remove them when renderParallel finishes.
  // This prevents handler accumulation across repeated calls.
  let cleanedUp = false;

  // Error-path cleanup. Awaits worker termination BEFORE removing the temp
  // dir: terminate() is async, and each worker's ffmpeg child holds its
  // segment file open until the pipe closes, so an early rmSync hits
  // EBUSY/EPERM on Windows and silently leaks the multi-GB temp dir.
  async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    say('\n  Shutting down gracefully...');
    progress.stop();
    await Promise.allSettled(workers.map((w) => w.terminate()));
    // Use rmSync (recursive, force) - handles locked files gracefully on Windows.
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }

  // Signal handlers stay synchronous by design: awaiting terminate() here
  // would mean process.exit() runs from a promise callback, and a second
  // Ctrl+C (or the OS) can kill the process mid-await regardless, so the
  // await buys nothing it can guarantee. Best-effort terminate + rmSync;
  // sweepStaleTempDirs reclaims anything a lost race leaves behind.
  const onSignal = (exitCode) => {
    cleanedUp = true;
    say('\n  Shutting down gracefully...');
    progress.stop();
    if (dashboardHandle) dashboardHandle.stop().catch(() => {});
    for (const w of workers) {
      try { w.terminate(); } catch {}
    }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    process.exit(exitCode);
  };

  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  const removeSignalHandlers = () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };

  // --- Abort wiring ---
  let onAbort = null;
  let abortPromise = null;
  if (signal) {
    abortPromise = new Promise((_, reject) => {
      onAbort = () => reject(makeAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    // The race below can settle on the render side first; without this no-op
    // handler a later abort() would raise an unhandled rejection.
    abortPromise.catch(() => {});
  }

  // Spawn one attempt of one worker's frame range.
  const spawnAttempt = (index, startFrame, endFrame, segmentPath) => new Promise((resolve, reject) => {
    const worker = new Worker(workerScript, {
      workerData: {
        ...extraWorkerData,
        width, height, fps, seed,
        startFrame, endFrame, segmentPath,
        workerId: index, totalFrames, duration,
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
        progress.setPhase('fast-forward', `Fast-forwarding worker state (${forwardingWorkers.size}/${numWorkers} workers) - this is the slow part...`);
      } else if (msg.type === 'log') {
        // Backwards-compat: old workers used type:'log' with a 'Fast-forward' substring.
        if (msg.msg && msg.msg.includes('Fast-forward')) {
          forwardingWorkers.add(msg.workerId);
          progress.updateWorker(msg.workerId, { status: 'fast-forward' });
          progress.setPhase('fast-forward', `Fast-forwarding worker state (${forwardingWorkers.size}/${numWorkers} workers) - this is the slow part...`);
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
      reject(new Error(`Worker ${index} error: ${err.message}`));
    });

    worker.on('exit', (code) => {
      // If a worker exits without sending a `done` message, resolve anyway
      // (the segment file will still be checked during concat). This prevents
      // the Promise.all from hanging forever on silent exits.
      if (!doneWorkers.has(index)) {
        if (code === 0 || code === null) {
          resolve({ type: 'done', workerId: index, implicit: true });
        } else {
          reject(new Error(`Worker ${index} exited with code ${code}`));
        }
      }
    });
  });

  // One-shot retry: a failed worker's range is respawned once before the
  // render is failed. The retry writes to a FRESH segment path because the
  // first attempt's ffmpeg child may still hold the original file open.
  // Skipped once shutdown has begun - at that point the "failure" is our
  // own terminate() call.
  const runWorker = (index, startFrame, endFrame, segmentPath) =>
    spawnAttempt(index, startFrame, endFrame, segmentPath).catch((err) => {
      if (cleanedUp || (signal && signal.aborted)) throw err;
      const firstLine = String(err.message).split('\n')[0];
      process.stderr.write(`  Warning: worker ${index} failed on attempt 1 (${firstLine}); retrying once\n`);
      const retryPath = segmentPath.replace(/\.mp4$/, '-retry.mp4');
      segmentPaths[index] = retryPath;
      // Reset this worker's progress entry so the tracker doesn't
      // double-count attempt 1's frames.
      progress.updateWorker(index, { pct: 0, fps: 0, frame: 0, eta: 0, status: 'waiting', done: false });
      return spawnAttempt(index, startFrame, endFrame, retryPath).catch((retryErr) => {
        progress.updateWorker(index, { status: 'error' });
        throw retryErr;
      });
    });

  // Spawn workers
  progress.setPhase('spawning', `Launching ${numWorkers} worker threads...`);
  const workerPromises = [];
  for (let i = 0; i < numWorkers; i++) {
    const startFrame = i * framesPerWorker;
    const endFrame = Math.min(startFrame + framesPerWorker, totalFrames);
    if (startFrame >= totalFrames) break;

    const segmentPath = path.join(tempDir, `segment-${String(i).padStart(3, '0')}.mp4`);
    segmentPaths.push(segmentPath);
    workerPromises.push(runWorker(i, startFrame, endFrame, segmentPath));
  }

  try {
    const allWorkers = Promise.all(workerPromises);
    await (abortPromise ? Promise.race([allWorkers, abortPromise]) : allWorkers);
    progress.stop();

    const renderTime = ((Date.now() - startTime) / 1000).toFixed(1);
    say('');
    say(`  All ${numWorkers} workers done in ${renderTime}s. Concatenating...`);

    progress.setPhase('concatenating', `Joining ${numWorkers} segments with stream copy (instant, no re-encode)...`);
    // validate:false - the segments are uniform by construction (same worker
    // recipe), so concat's per-segment ffprobe compatibility pass is skipped.
    // Its missing/empty-segment check still runs.
    await concatSegments(segmentPaths, outputPath, { validate: false });

    // Cleanup temp dir (recursive, force - handles any stray files + Windows locks)
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

    verifyOutput(outputPath, totalFrames, fps);

    const elapsed = (Date.now() - startTime) / 1000;
    const minutes = (elapsed / 60).toFixed(1);
    progress.setPhase('complete', `Done! ${totalFrames.toLocaleString()} frames in ${elapsed.toFixed(1)}s (${minutes}min)`);
    say(`  Render complete: ${totalFrames.toLocaleString()} frames in ${elapsed.toFixed(1)}s (${minutes}min)`);
    say(`  Output: ${outputPath}`);

    // Keep the dashboard alive briefly after completion so the user can see
    // the final state. The timer intentionally holds the event loop open for
    // the CLI; library callers that want renderParallel() to resolve and
    // return immediately can pass dashboardLingerMs: 0.
    if (dashboardHandle) {
      if (dashboardLingerMs > 0) {
        setTimeout(() => {
          dashboardHandle.stop().catch(() => {});
        }, dashboardLingerMs);
      } else {
        dashboardHandle.stop().catch(() => {});
      }
    }

    return { outputPath, elapsed, totalFrames, avgFps: elapsed > 0 ? totalFrames / elapsed : 0 };

  } catch (err) {
    // Mark the failure FIRST so the dashboard's next poll (1.5s cadence)
    // shows the error phase instead of a frozen last-good state.
    if (typeof progress.fail === 'function') progress.fail(err);
    await cleanup();
    // Leave the dashboard server up for the linger window so the browser can
    // display the failure; the rejection below is immediate either way.
    if (dashboardHandle) {
      if (dashboardLingerMs > 0) {
        setTimeout(() => {
          dashboardHandle.stop().catch(() => {});
        }, dashboardLingerMs);
      } else {
        dashboardHandle.stop().catch(() => {});
      }
    }
    throw err;
  } finally {
    removeSignalHandlers();
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { renderParallel };
