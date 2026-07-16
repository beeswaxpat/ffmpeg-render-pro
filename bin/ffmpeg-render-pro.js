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
      // Split on the FIRST '=' only so values may contain '=' (--title=A=B).
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const key = eq === -1 ? body : body.slice(0, eq);
      const val = eq === -1 ? undefined : body.slice(eq + 1);
      flags[key] = val !== undefined ? val : (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
    }
  }
  return flags;
}

/**
 * Safely parse a positive integer from a flag value.
 * Returns the default if the value is missing, empty, or NaN.
 */
function safeInt(value, defaultValue) {
  if (value === undefined || value === null || value === true) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}

/**
 * Safely parse a positive number (fractions allowed, e.g. --duration=2.5).
 */
function safeNum(value, defaultValue) {
  if (value === undefined || value === null || value === true) return defaultValue;
  const parsed = parseFloat(value);
  return !Number.isFinite(parsed) || parsed <= 0 ? defaultValue : parsed;
}

/**
 * Safely parse a seed. Unlike safeInt, 0 (and negatives) are valid seeds.
 */
function safeSeed(value, defaultValue) {
  if (value === undefined || value === null || value === true) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * String flag value or default ("--output" with no value must not crash).
 */
function safeStr(value, defaultValue) {
  return typeof value === 'string' && value.length > 0 ? value : defaultValue;
}

/**
 * Get the forceEncoder mode from flags.
 */
function getForceEncoder(flags) {
  if (flags.cpu === true || flags['cpu-only'] === true) return 'cpu';
  if (flags.gpu === true || flags['gpu-only'] === true) return 'gpu';
  return undefined;
}

const X264_PRESETS = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
  'medium', 'slow', 'slower', 'veryslow', 'placebo',
];

const DASHBOARD_FLAGS = ['no-dashboard', 'no-open', 'port', 'linger-ms'];
const QUALITY_FLAGS = ['crf', 'encoder-preset'];
const ENCODER_MODE_FLAGS = ['cpu', 'cpu-only', 'gpu', 'gpu-only'];

const KNOWN_FLAGS = {
  'detect-gpu': new Set(ENCODER_MODE_FLAGS),
  'info': new Set(ENCODER_MODE_FLAGS),
  'render': new Set(['width', 'height', 'fps', 'duration', 'output', 'workers',
    'max-workers', 'seed', 'title', ...DASHBOARD_FLAGS, ...QUALITY_FLAGS]),
  'benchmark': new Set(['width', 'height', 'fps', 'duration', 'output', 'workers',
    ...DASHBOARD_FLAGS, ...QUALITY_FLAGS]),
};

// Flags whose values must parse as integers when given one.
const INT_FLAGS = ['width', 'height', 'fps', 'workers', 'max-workers', 'seed', 'port', 'linger-ms', 'crf'];

/**
 * Validate parsed flags for a command.
 * Returns { warnings, errors }. Warnings (unknown flags) are printed and
 * execution continues, so scripts stay forward compatible with future flags.
 * Errors (unparseable values) are fatal: a typo like --fps=abc must not
 * silently render at the default framerate.
 */
function validateFlags(command, flags) {
  const warnings = [];
  const errors = [];
  const known = KNOWN_FLAGS[command];
  if (!known) return { warnings, errors };

  for (const key of Object.keys(flags)) {
    if (!known.has(key)) warnings.push(`Unknown flag --${key} (ignored)`);
  }

  for (const key of INT_FLAGS) {
    if (typeof flags[key] === 'string' && isNaN(parseInt(flags[key], 10))) {
      errors.push(`Invalid value for --${key}: "${flags[key]}" is not a number`);
    }
  }
  if (typeof flags.duration === 'string' && !Number.isFinite(parseFloat(flags.duration))) {
    errors.push(`Invalid value for --duration: "${flags.duration}" is not a number`);
  }

  if (flags.crf !== undefined) {
    if (flags.crf === true) {
      errors.push('--crf requires a numeric value (0-51)');
    } else {
      const crf = parseInt(flags.crf, 10);
      // NaN already reported by the INT_FLAGS check above.
      if (!isNaN(crf) && (crf < 0 || crf > 51)) {
        errors.push(`Invalid value for --crf: ${crf} (must be 0-51)`);
      }
    }
  }
  if (flags['encoder-preset'] !== undefined) {
    const preset = flags['encoder-preset'];
    if (preset === true || !X264_PRESETS.includes(preset)) {
      errors.push(
        `Invalid value for --encoder-preset: ${preset === true ? '(none)' : `"${preset}"`}` +
        ` (valid: ${X264_PRESETS.join(', ')})`,
      );
    }
  }
  return { warnings, errors };
}

/**
 * Print flag validation results to stderr. Warnings continue; errors exit 1.
 */
function reportFlagIssues(command, flags) {
  const { warnings, errors } = validateFlags(command, flags);
  for (const w of warnings) console.error(`  Warning: ${w}`);
  for (const e of errors) console.error(`  Error: ${e}`);
  if (errors.length > 0) process.exit(1);
}

/**
 * Build workerData.codecArgs from --crf / --encoder-preset.
 * Returns null when neither flag is given so the worker default applies.
 * Defaults mirror the example worker's recipe (libx264, fast, crf 20).
 */
function buildCodecArgs(flags) {
  const hasCrf = flags.crf !== undefined && flags.crf !== true;
  const hasPreset = flags['encoder-preset'] !== undefined && flags['encoder-preset'] !== true;
  if (!hasCrf && !hasPreset) return null;
  const crf = hasCrf ? String(parseInt(flags.crf, 10)) : '20';
  const preset = hasPreset ? flags['encoder-preset'] : 'fast';
  return ['-c:v', 'libx264', '-preset', preset, '-crf', crf];
}

const VERSION_COMMANDS = new Set(['version', '--version', '-v']);

async function main() {
  // Version is answerable without ffmpeg installed.
  if (VERSION_COMMANDS.has(command)) {
    console.log(require('../package.json').version);
    return;
  }

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
      reportFlagIssues('detect-gpu', flags);
      console.log('\n  ffmpeg-render-pro - GPU Detection\n');
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
      reportFlagIssues('info', flags);
      const forceEncoder = getForceEncoder(flags);
      const gpu = detectGPU({ forceEncoder });
      const config = getConfig({ gpuResult: gpu });
      const ffmpeg = checkFFmpeg();
      console.log('\n  ffmpeg-render-pro - System Info\n');
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
      reportFlagIssues('render', flags);
      const workerScript = args[1] && !args[1].startsWith('--') ? path.resolve(args[1]) : null;
      if (!workerScript) {
        console.error('  Usage: ffmpeg-render-pro render <worker-script.js> [options]');
        console.error('  Run ffmpeg-render-pro without arguments to see all options.');
        process.exit(1);
      }
      const codecArgs = buildCodecArgs(flags);

      await renderParallel({
        workerScript,
        outputPath: path.resolve(safeStr(flags.output, 'output.mp4')),
        width: safeInt(flags.width, 1920),
        height: safeInt(flags.height, 1080),
        fps: safeInt(flags.fps, 60),
        duration: safeNum(flags.duration, 60),
        workerCount: flags.workers ? safeInt(flags.workers) : undefined,
        maxWorkers: flags['max-workers'] ? safeInt(flags['max-workers'], 8) : undefined,
        seed: safeSeed(flags.seed, 42),
        title: safeStr(flags.title, path.basename(workerScript, '.js')),
        dashboard: flags['no-dashboard'] !== true,
        autoOpen: flags['no-open'] !== true && flags['no-dashboard'] !== true,
        dashboardPort: safeInt(flags.port, 8080),
        dashboardLingerMs: flags['linger-ms'] !== undefined ? safeSeed(flags['linger-ms'], 30000) : undefined,
        workerData: codecArgs ? { codecArgs } : undefined,
      });
      break;
    }

    case 'benchmark': {
      const flags = parseFlags(args.slice(1));
      reportFlagIssues('benchmark', flags);
      const exampleWorker = path.join(__dirname, '..', 'examples', 'basic-worker.js');
      const outputPath = path.resolve(safeStr(flags.output, 'benchmark-output.mp4'));
      const duration = safeNum(flags.duration, 5);
      const width = safeInt(flags.width, 1920);
      const height = safeInt(flags.height, 1080);
      const fps = safeInt(flags.fps, 30);
      const codecArgs = buildCodecArgs(flags);

      console.log('\n  ffmpeg-render-pro - Benchmark\n');
      console.log(`  Rendering ${duration}s test video at ${width}x${height} @ ${fps}fps\n`);

      const result = await renderParallel({
        workerScript: exampleWorker,
        outputPath,
        width, height, fps, duration,
        workerCount: flags.workers ? safeInt(flags.workers) : undefined,
        title: 'Benchmark',
        seed: 42,
        dashboard: flags['no-dashboard'] !== true,
        autoOpen: flags['no-open'] !== true && flags['no-dashboard'] !== true,
        dashboardPort: safeInt(flags.port, 8080),
        dashboardLingerMs: flags['linger-ms'] !== undefined ? safeSeed(flags['linger-ms'], 30000) : undefined,
        workerData: codecArgs ? { codecArgs } : undefined,
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
  ffmpeg-render-pro - Parallel video rendering toolkit

  Commands:
    detect-gpu                Probe available hardware encoders
    info                      Show system config (workers, RAM, CPU)
    render <worker.js>        Run a render with the given worker script
    benchmark                 Quick 5s test render
    version                   Print the installed version

  Render options:
    --width=1920              Frame width (max 7680, must be even)
    --height=1080             Frame height (max 4320, must be even)
    --fps=60                  Framerate (1-240)
    --duration=60             Duration in seconds (fractions allowed, e.g. 2.5)
    --output=output.mp4       Output file path
    --workers=8               Override worker count
    --max-workers=8           Cap for auto worker count
    --seed=42                 RNG seed for determinism (0 is valid)
    --title="My Render"       Dashboard title

  Dashboard options (render + benchmark):
    --no-dashboard            Disable the live dashboard entirely
    --no-open                 Serve the dashboard but don't auto-open a browser
    --port=8080               Dashboard starting port
    --linger-ms=30000         How long the dashboard stays up after completion (0 = exit immediately)

  Quality options (render + benchmark):
    --crf=20                  x264 quality, 0-51 (lower is higher quality)
    --encoder-preset=fast     x264 speed preset (ultrafast, superfast, veryfast,
                              faster, fast, medium, slow, slower, veryslow, placebo)

  Encoder options (detect-gpu + info):
    --cpu                     Force CPU encoding (libx264), skip GPU detection
    --gpu                     Force GPU encoding, fail if no hardware encoder
    Note: parallel segment encoding always uses CPU by design (GPU encoder
    session limits); GPU encoders apply to final single-pass encodes.

  Benchmark options:
    --duration=5              Override benchmark duration
    --width=1920              Frame width
    --height=1080             Frame height
    --fps=30                  Framerate
    --workers=8               Override worker count

  Examples:
    ffmpeg-render-pro detect-gpu
    ffmpeg-render-pro detect-gpu --cpu
    ffmpeg-render-pro info
    ffmpeg-render-pro render my-worker.js --duration=60 --output=video.mp4
    ffmpeg-render-pro render my-worker.js --width=1080 --height=1920
    ffmpeg-render-pro render my-worker.js --no-dashboard --linger-ms=0
    ffmpeg-render-pro render my-worker.js --crf=18 --encoder-preset=slow
    ffmpeg-render-pro benchmark
    ffmpeg-render-pro benchmark --duration=30 --workers=4
`);
  }
}

// Pure helpers exported for tests (test/cli.test.js); the CLI only runs when
// executed directly.
module.exports = {
  parseFlags,
  validateFlags,
  buildCodecArgs,
  safeInt,
  safeNum,
  safeSeed,
  safeStr,
  KNOWN_FLAGS,
  X264_PRESETS,
};

if (require.main === module) {
  main().catch(err => {
    console.error('\n  Error:', err.message);
    if (!process.env.FFMPEG_RENDER_PRO_DEBUG) {
      console.error('  (Set FFMPEG_RENDER_PRO_DEBUG=1 for a full stack trace.)\n');
    } else {
      console.error(err.stack || err);
    }
    process.exit(1);
  });
}
