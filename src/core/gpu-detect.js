/**
 * GPU Detection - Cross-platform encoder discovery
 *
 * Probes ffmpeg for available hardware encoders, validates each with a
 * 1-frame test encode using the encoder's real production args, and returns
 * the best available option.
 *
 * Priority: h264_nvenc > h264_videotoolbox > h264_amf > h264_vaapi > h264_qsv > libx264
 *
 * Force modes:
 *   forceEncoder: 'cpu'  - skip GPU probing, always use libx264
 *   forceEncoder: 'gpu'  - fail if no GPU encoder found
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ffmpegBin } = require('./ffmpeg-bin');

const ENCODER_PRIORITY = [
  { name: 'h264_nvenc',         label: 'NVIDIA NVENC',           platform: ['win32', 'linux'] },
  { name: 'h264_videotoolbox',  label: 'Apple VideoToolbox',     platform: ['darwin'] },
  { name: 'h264_amf',           label: 'AMD AMF',                platform: ['win32'] },
  { name: 'h264_vaapi',         label: 'VA-API (Linux)',         platform: ['linux'] },
  { name: 'h264_qsv',           label: 'Intel Quick Sync',      platform: ['win32', 'linux'] },
];

const HEVC_ENCODERS = [
  { name: 'hevc_nvenc',         label: 'NVIDIA NVENC (HEVC)',    platform: ['win32', 'linux'] },
  { name: 'hevc_videotoolbox',  label: 'Apple VideoToolbox (HEVC)', platform: ['darwin'] },
  { name: 'hevc_amf',           label: 'AMD AMF (HEVC)',         platform: ['win32'] },
  { name: 'hevc_vaapi',         label: 'VA-API HEVC (Linux)',    platform: ['linux'] },
  { name: 'hevc_qsv',           label: 'Intel Quick Sync (HEVC)', platform: ['win32', 'linux'] },
];

/**
 * Encoder candidates for a platform, in priority order.
 * @param {string} platform - Node platform string ('win32', 'linux', 'darwin')
 * @returns {{ h264: object[], hevc: object[] }}
 */
function getEncoderCandidates(platform) {
  return {
    h264: ENCODER_PRIORITY.filter(e => e.platform.includes(platform)),
    hevc: HEVC_ENCODERS.filter(e => e.platform.includes(platform)),
  };
}

// Cache paths are resolved at call time, not module load, so tests (and
// multi-user setups) can redirect them via FFMPEG_RENDER_PRO_CACHE_DIR after
// the module is already required.
function getCacheDir() {
  return process.env.FFMPEG_RENDER_PRO_CACHE_DIR || path.join(os.homedir(), '.ffmpeg-render-pro');
}
function getCacheFile() {
  return path.join(getCacheDir(), 'gpu-cache.json');
}
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Bump when detection logic changes so upgraded installs re-probe instead of
// trusting up to 7 days of results from the old logic. v2: 256x256 probe frame
// (the 64x64 probe was below NVENC's minimum resolution and cached false
// negatives on NVIDIA hardware). v3: probes now validate with the encoder's
// real production args from getCodecArgs; v2 results may claim encoders that
// fail with production args (VideoToolbox -q:v on Intel Macs) or deny
// encoders that need device init to work at all (VA-API).
const CACHE_SCHEMA_VERSION = 3;

// Maximum supported resolution (8K)
const MAX_WIDTH = 7680;
const MAX_HEIGHT = 4320;

/**
 * Check if ffmpeg is installed and available on PATH.
 * Returns { available: boolean, version: string|null, path: string|null }
 *
 * The result is memoized for the process lifetime: a render invokes this
 * from renderParallel, detectGPU's cache validation, and the CLI banner,
 * and each `ffmpeg -version` spawn costs 100-300ms on Windows. ffmpeg
 * appearing or vanishing mid-process is not a case worth re-probing for.
 */
let _ffmpegCheckCache = null;
function ffmpegMissingError(bin) {
  return bin === 'ffmpeg'
    ? 'ffmpeg not found on PATH. Install ffmpeg (https://ffmpeg.org/download.html) or set FFMPEG_RENDER_PRO_FFMPEG to its full path.'
    : `ffmpeg not found at FFMPEG_RENDER_PRO_FFMPEG=${bin}. Fix the path, or unset the variable to use ffmpeg from PATH.`;
}
function checkFFmpeg() {
  if (_ffmpegCheckCache !== null) return _ffmpegCheckCache;
  const bin = ffmpegBin();
  try {
    const result = spawnSync(bin, ['-version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error) {
      // Not cached: a missing ffmpeg could be installed while the process
      // (e.g. a long-lived MCP server) is still running.
      return { available: false, version: null, path: null, error: ffmpegMissingError(bin) };
    }
    const versionMatch = (result.stdout || '').match(/ffmpeg version (\S+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    _ffmpegCheckCache = { available: true, version, path: bin, error: null };
    return _ffmpegCheckCache;
  } catch {
    return { available: false, version: null, path: null, error: ffmpegMissingError(bin) };
  }
}

/**
 * Get ffmpeg version string for cache invalidation.
 */
function getFFmpegVersion() {
  const check = checkFFmpeg();
  return check.version || 'unknown';
}

// Cache `ffmpeg -encoders` output for the lifetime of this process.
// Avoids spawning ffmpeg once per candidate encoder.
let _encodersListCache = null;
function getEncodersList() {
  if (_encodersListCache !== null) return _encodersListCache;
  try {
    const result = spawnSync(ffmpegBin(), ['-encoders'], {
      encoding: 'utf-8', timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    _encodersListCache = result.stdout || '';
  } catch {
    _encodersListCache = '';
  }
  return _encodersListCache;
}

/**
 * Check if an encoder is listed in ffmpeg -encoders output.
 */
function isEncoderListed(encoderName) {
  return getEncodersList().includes(encoderName);
}

/**
 * Validate an encoder by running a 1-frame test encode.
 * This catches cases where the encoder is listed but the driver/hardware is missing.
 *
 * The probe runs the encoder's REAL production args from getCodecArgs, not a
 * bare '-c:v <name>'. A bare probe certifies arg sets that fail at render
 * time (VideoToolbox rejects -q:v on Intel Macs) and fails encoders that
 * need device init and an upload filter to run at all (VA-API), so the probe
 * and the production invocation must be the same command.
 *
 * The probe frame is 256x256: hardware encoders enforce MINIMUM dimensions
 * (H.264 NVENC rejects anything narrower than 145px with a bare "Invalid
 * argument"), so a tiny probe frame reports healthy GPUs as unavailable and
 * silently downgrades every render to CPU. 256x256 clears every known
 * hardware minimum and still encodes in a few milliseconds.
 */
function validateEncoder(encoderName) {
  try {
    const result = spawnSync(ffmpegBin(), [
      '-f', 'lavfi', '-i', 'nullsrc=s=256x256:d=0.04',
      ...getCodecArgs(encoderName),
      '-f', 'null', os.platform() === 'win32' ? 'NUL' : '/dev/null',
    ], { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Load cached GPU detection result.
 */
function loadCache() {
  try {
    const cacheFile = getCacheFile();
    if (!fs.existsSync(cacheFile)) return null;
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (data.cacheSchemaVersion !== CACHE_SCHEMA_VERSION) return null;
    const age = Date.now() - (data.timestamp || 0);
    if (age > CACHE_MAX_AGE_MS) return null;
    if (data.ffmpegVersion !== getFFmpegVersion()) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Save GPU detection result to cache.
 */
function saveCache(result) {
  try {
    const cacheDir = getCacheDir();
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(getCacheFile(), JSON.stringify({
      ...result,
      timestamp: Date.now(),
      ffmpegVersion: getFFmpegVersion(),
      cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    }, null, 2));
  } catch {}
}

/**
 * Detect the best available GPU encoder.
 *
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - Ignore cache, re-probe
 * @param {boolean} [options.verbose=false] - Log probe details
 * @param {string} [options.forceEncoder] - 'cpu' to skip GPU, 'gpu' to require GPU
 * @returns {{ h264: string, hevc: string|null, label: string, isGpu: boolean, all: object[] }}
 */
function detectGPU(options = {}) {
  const { force = false, verbose = false, forceEncoder } = options;

  // Re-probing? Clear the encoders cache so we re-read ffmpeg -encoders.
  if (force) _encodersListCache = null;

  // Force CPU mode - skip all probing
  if (forceEncoder === 'cpu') {
    if (verbose) console.log('  GPU detection: forced CPU mode (--cpu)');
    return {
      h264: 'libx264',
      hevc: null,
      label: 'CPU (libx264) [forced]',
      isGpu: false,
      all: [{ name: 'libx264', label: 'CPU (libx264)', codec: 'h264' }],
    };
  }

  // Check cache first (unless forcing)
  if (!force && forceEncoder !== 'gpu') {
    const cached = loadCache();
    if (cached) {
      if (verbose) console.log('  GPU detection: using cached result');
      return cached.result;
    }
  }

  if (verbose) console.log('  GPU detection: probing available encoders...');

  const { h264: candidates, hevc: hevcCandidates } = getEncoderCandidates(os.platform());
  const available = [];

  // Test H.264 encoders
  let bestH264 = 'libx264';
  let bestLabel = 'CPU (libx264)';
  let isGpu = false;

  for (const encoder of candidates) {
    if (verbose) console.log(`  Testing ${encoder.name} (${encoder.label})...`);
    if (isEncoderListed(encoder.name) && validateEncoder(encoder.name)) {
      bestH264 = encoder.name;
      bestLabel = encoder.label;
      isGpu = true;
      available.push({ name: encoder.name, label: encoder.label, codec: 'h264' });
      if (verbose) console.log(`    \u2713 ${encoder.label} available and validated`);
      break;
    } else {
      if (verbose) console.log(`    \u2717 not available`);
    }
  }

  // Force GPU mode - fail if none found
  if (forceEncoder === 'gpu' && !isGpu) {
    throw new Error(
      'GPU encoding forced (--gpu) but no hardware encoder found.\n' +
      '  Tested: ' + candidates.map(c => c.label).join(', ') + '\n' +
      '  Install GPU drivers or remove --gpu to fall back to CPU.'
    );
  }

  // Test HEVC encoders
  let bestHevc = null;
  for (const encoder of hevcCandidates) {
    if (isEncoderListed(encoder.name) && validateEncoder(encoder.name)) {
      bestHevc = encoder.name;
      available.push({ name: encoder.name, label: encoder.label, codec: 'hevc' });
      if (verbose) console.log(`    \u2713 ${encoder.label} (HEVC) available`);
      break;
    }
  }

  // libx264 is always available as fallback
  available.push({ name: 'libx264', label: 'CPU (libx264)', codec: 'h264' });

  const result = {
    h264: bestH264,
    hevc: bestHevc,
    label: bestLabel,
    isGpu,
    all: available,
  };

  saveCache({ result });
  return result;
}

/**
 * Validate render dimensions are within safe bounds.
 * @param {number} width
 * @param {number} height
 * @throws {Error} if dimensions exceed 8K
 */
function validateResolution(width, height) {
  if (width <= 0 || height <= 0 || isNaN(width) || isNaN(height)) {
    throw new Error(`Invalid resolution: ${width}x${height}. Width and height must be positive numbers.`);
  }
  if (width > MAX_WIDTH || height > MAX_HEIGHT) {
    throw new Error(`Resolution ${width}x${height} exceeds maximum (${MAX_WIDTH}x${MAX_HEIGHT}). Reduce dimensions.`);
  }
}

// VideoToolbox constant-quality: -q:v runs 1..100 where HIGHER is better,
// the inverse of the package-wide cq/crf convention (lower is better). Map
// the x264 crf domain [0..51] onto VT's [100..1]: q = 100 - 2*cq, clamped to
// VT's valid range. Anchors: cq 0 -> 100 (near lossless), cq 18 -> 64
// (community guidance puts crf 18 near q:v 65), default cq 20 -> 60,
// cq >= 50 clamps to 1. Note: VT implements -q:v only on Apple Silicon;
// Intel Macs reject it, which the real-args probe catches (CPU fallback).
function vtQuality(cq) {
  return String(Math.max(1, Math.min(100, Math.round(100 - cq * 2))));
}

/**
 * Get the full ffmpeg invocation recipe for an encoder, split by role:
 *   inputArgs  - args that must run before encoding starts. These are ffmpeg
 *                GLOBAL options (hardware device init), which ffmpeg accepts
 *                at any argv position, so flattening them into output args
 *                is also valid.
 *   filter     - a -vf chain the encoder REQUIRES to receive frames it can
 *                accept (null for encoders that take software frames).
 *   outputArgs - the '-c:v ...' output options.
 *
 * Callers that build their own -vf chain (color grading etc.) must merge
 * `filter` into that chain rather than passing a second -vf: ffmpeg only
 * honors the LAST -vf per stream and silently drops the others.
 *
 * @param {string} encoder - Encoder name (e.g. 'h264_vaapi')
 * @param {Object} [options] - Same options as getCodecArgs
 * @returns {{ inputArgs: string[], filter: string|null, outputArgs: string[] }}
 */
function getEncoderIO(encoder, options = {}) {
  const { crf = 20, cq = 20, preset } = options;
  const soft = (outputArgs) => ({ inputArgs: [], filter: null, outputArgs });
  // VA-API encoders accept only VAAPI hardware surfaces: they need a device
  // plus an nv12 upload filter or every invocation fails. No device path is
  // given so ffmpeg auto-picks the default DRM render node or X11 display.
  const vaapi = (outputArgs) => ({
    inputArgs: ['-init_hw_device', 'vaapi=va', '-filter_hw_device', 'va'],
    filter: 'format=nv12,hwupload',
    outputArgs,
  });

  switch (encoder) {
    case 'libx264':
      return soft(['-c:v', 'libx264', '-preset', preset || 'fast', '-crf', String(crf)]);
    case 'h264_nvenc':
      return soft(['-c:v', 'h264_nvenc', '-preset', preset || 'p4', '-cq', String(cq)]);
    case 'hevc_nvenc':
      return soft(['-c:v', 'hevc_nvenc', '-preset', preset || 'p4', '-cq', String(cq), '-tag:v', 'hvc1']);
    case 'h264_videotoolbox':
      return soft(['-c:v', 'h264_videotoolbox', '-q:v', vtQuality(cq)]);
    case 'h264_amf':
      return soft(['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(cq), '-qp_p', String(cq)]);
    case 'h264_vaapi':
      return vaapi(['-c:v', 'h264_vaapi', '-qp', String(cq)]);
    case 'h264_qsv':
      return soft(['-c:v', 'h264_qsv', '-global_quality', String(cq)]);
    case 'hevc_videotoolbox':
      return soft(['-c:v', 'hevc_videotoolbox', '-q:v', vtQuality(cq), '-tag:v', 'hvc1']);
    case 'hevc_amf':
      return soft(['-c:v', 'hevc_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(cq), '-qp_p', String(cq), '-tag:v', 'hvc1']);
    case 'hevc_vaapi':
      return vaapi(['-c:v', 'hevc_vaapi', '-qp', String(cq), '-tag:v', 'hvc1']);
    case 'hevc_qsv':
      return soft(['-c:v', 'hevc_qsv', '-global_quality', String(cq), '-tag:v', 'hvc1']);
    default:
      return soft(['-c:v', encoder, '-preset', preset || 'fast', '-crf', String(crf)]);
  }
}

/**
 * Get codec args for the given encoder as a flat array to splice in front
 * of the output path (the shape every existing caller expects).
 *
 * For VA-API the array also carries the device init (global options, valid
 * at any argv position) and a '-vf format=nv12,hwupload' pair, because the
 * encoder cannot run without them. Callers that pass their own -vf must use
 * getEncoderIO() and merge `filter` into their chain instead; ffmpeg only
 * honors the last -vf per stream. A trailing '-pix_fmt yuv420p' after these
 * args is safe: ffmpeg downgrades an unsupported requested format to an
 * "Incompatible pixel format ... auto-selecting" warning (verified on 8.0.1).
 */
function getCodecArgs(encoder, options = {}) {
  const io = getEncoderIO(encoder, options);
  return [
    ...io.inputArgs,
    ...(io.filter ? ['-vf', io.filter] : []),
    ...io.outputArgs,
  ];
}

module.exports = {
  detectGPU,
  getCodecArgs,
  getEncoderIO,
  getEncoderCandidates,
  validateEncoder,
  getFFmpegVersion,
  checkFFmpeg,
  validateResolution,
  MAX_WIDTH,
  MAX_HEIGHT,
};
