#!/usr/bin/env node
/**
 * ffmpeg-render-pro CLI
 *
 * Commands:
 *   detect-gpu        Probe available hardware encoders
 *   info              Show system config (workers, RAM, CPU)
 *   render <script>   Run a render using the given worker script
 *   benchmark         Run a quick benchmark render (5s test video)
 */
const path = require('path');
const { detectGPU, checkFFmpeg } = require('../src/core/gpu-detect');
const { getOptimalWorkers, getConfig } = require('../src/core/config');
const { renderParallel } = require('../src/core/parallel-renderer');

const args = process.argv.slice(2);
const command = args[0];

/**
 * Parse CLI flags from args array.
 * Handles --key=value and --key value formats.
 */
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');
      flags[key] = val !== undefined ? val : (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
    }
  }
  return flags;
}

/**
 * Safely parse an integer from a flag value.
 * Returns the default if the value is missing, empty, or NaN.
 */
function safeInt(value, defaultValue) {
  if (value === undefined || value === null || value === true) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}

/**
 * Get the forceEncoder mode from flags.
 */
function getForceEncoder(flags) {
  if (flags.cpu === true || flags['cpu-only'] === true) return 'cpu';
  if (flags.gpu === true || flags['gpu-only'] === true) return 'gpu';
  return undefined;
}

async function main() {
  // Pre-flight: check ffmpeg for all commands except help
  if (command && command !== 'help') {
    const status = checkFFmpeg();
    if (!status.available) {
      console.error(`\n  Error: ${status.error}\n`);
      process.exit(1);
    }
  }

  switch (command) {
    case 'detect-gpu': {
      const flags = parseFlags(args.slice(1));
      console.log('\n  ffmpeg-render-pro \u2014 GPU Detection\n');
      const forceEncoder = getForceEncoder(flags);
      const result = detectGPU({ force: true, verbose: true, forceEncoder });
      console.log('\n  Result:');
      console.log(`    H.264:  ${result.h264} (${result.label})`);
      console.log(`    HEVC:   ${result.hevc || 'not available'}`);
      console.log(`    GPU:    ${result.isGpu ? 'YES' : 'NO (CPU fallback)'}`);
      console.log(`    All:    ${result.all.map(e => e.name).join(', ')}`);
      console.log('');
      break;
    }

    case 'info': {
      const flags = parseFlags(args.slice(1));
      const forceEncoder = getForceEncoder(flags);
      const gpu = detectGPU({ forceEncoder });
      const config = getConfig({ gpuResult: gpu });
      const ffmpeg = checkFFmpeg();
      console.log('\n  ffmpeg-render-pro \u2014 System Info\n');
      console.log(`    Platform:     ${config.system.platform} (${config.system.arch})`);
      console.log(`    CPU cores:    ${config.system.cpuCores}`);
      console.log(`    RAM:          ${config.system.totalRamMB}MB total, ${config.system.freeRamMB}MB free`);
      console.log(`    ffmpeg:       ${ffmpeg.version || 'not found'}`);
      console.log(`    GPU encoder:  ${config.gpuLabel}`);
      console.log(`    Workers:      ${config.workers} (for ${config.tier})`);
      console.log(`    Seg codec:    ${config.segmentCodec}`);
      console.log(`    Final codec:  ${config.finalCodec}`);
      if (forceEncoder) console.log(`    Force mode:   ${forceEncoder.toUpperCase()}`);
      console.log('');
      break;
    }

    case 'render': {
      const flags = parseFlags(args.slice(1));
      const workerScript = args[1] && !args[1].startsWith('--') ? path.resolve(args[1]) : null;
      if (!workerScript) {
        console.error('  Usage: ffmpeg-render-pro render <worker-script.js> [options]');
        console.error('  Run ffmpeg-render-pro without arguments to see all options.');
        process.exit(1);
      }

      await renderParallel({
        workerScript,
        outputPath: path.resolve(flags.output || 'output.mp4'),
        width: safeInt(flags.width, 1920),
        height: safeInt(flags.height, 1080),
        fps: safeInt(flags.fps, 60),
        duration: safeInt(flags.duration, 60),
        workerCount: flags.workers ? safeInt(flags.workers) : undefined,
        seed: safeInt(flags.seed, 42),
        title: (typeof flags.title === 'string') ? flags.title : path.basename(workerScript, '.js'),
      });
      break;
    }

    case 'benchmark': {
      const flags = parseFlags(args.slice(1));
      const exampleWorker = path.join(__dirname, '..', 'examples', 'basic-worker.js');
      const outputPath = path.resolve(flags.output || 'benchmark-output.mp4');
      const duration = safeInt(flags.duration, 5);
      const width = safeInt(flags.width, 1920);
      const height = safeInt(flags.height, 1080);
      const fps = safeInt(flags.fps, 30);

      console.log('\n  ffmpeg-render-pro \u2014 Benchmark\n');
      console.log(`  Rendering ${duration}s test video at ${width}x${height} @ ${fps}fps\n`);

      const result = await renderParallel({
        workerScript: exampleWorker,
        outputPath,
        width, height, fps, duration,
        title: 'Benchmark',
        seed: 42,
      });

      const avgFps = (result.totalFrames / result.elapsed).toFixed(1);
      console.log('');
      console.log('  === Benchmark Results ===');
      console.log(`  Frames:    ${result.totalFrames.toLocaleString()}`);
      console.log(`  Time:      ${result.elapsed.toFixed(1)}s`);
      console.log(`  Avg FPS:   ${avgFps}`);
      console.log(`  Output:    ${result.outputPath}`);
      console.log('');
      break;
    }

    default:
      console.log(`
  ffmpeg-render-pro \u2014 Parallel video rendering toolkit

  Commands:
    detect-gpu                Probe available hardware encoders
    info                      Show system config (workers, RAM, CPU)
    render <worker.js>        Run a render with the given worker script
    benchmark                 Quick 5s test render

  Render options:
    --width=1920              Frame width (max 7680)
    --height=1080             Frame height (max 4320)
    --fps=60                  Framerate (1-240)
    --duration=60             Duration in seconds
    --output=output.mp4       Output file path
    --workers=8               Override worker count
    --seed=42                 RNG seed for determinism
    --title="My Render"       Dashboard title

  Encoder options:
    --cpu                     Force CPU encoding (libx264), skip GPU detection
    --gpu                     Force GPU encoding, fail if no hardware encoder

  Benchmark options:
    --duration=5              Override benchmark duration
    --width=1920              Frame width
    --height=1080             Frame height
    --fps=30                  Framerate

  Examples:
    ffmpeg-render-pro detect-gpu
    ffmpeg-render-pro detect-gpu --cpu
    ffmpeg-render-pro info
    ffmpeg-render-pro render my-worker.js --duration=60 --output=video.mp4
    ffmpeg-render-pro render my-worker.js --cpu --width=1080 --height=1920
    ffmpeg-render-pro benchmark
    ffmpeg-render-pro benchmark --duration=30
`);
  }
}

main().catch(err => {
  console.error('\n  Error:', err.message);
  if (!process.env.FFMPEG_RENDER_PRO_DEBUG) {
    console.error('  (Set FFMPEG_RENDER_PRO_DEBUG=1 for a full stack trace.)\n');
  } else {
    console.error(err.stack || err);
  }
  process.exit(1);
});
