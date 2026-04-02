/**
 * GPU Detection — Cross-platform encoder discovery
 *
 * Probes ffmpeg for available hardware encoders, validates each with
 * a 1-frame test encode, and returns the best available option.
 *
 * Priority: h264_nvenc > h264_videotoolbox > h264_amf > h264_vaapi > h264_qsv > libx264
 *
 * Force modes:
 *   forceEncoder: 'cpu'  — skip GPU probing, always use libx264
 *   forceEncoder: 'gpu'  — fail if no GPU encoder found
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ENCODER_PRIORITY = [
  { name: 'h264_nvenc',         label: 'NVIDIA NVENC',           platform: ['win32', 'linux'] },
  { name: 'h264_videotoolbox',  label: 'Apple VideoToolbox',     platform: ['darwin'] },
  { name: 'h264_amf',           label: 'AMD AMF',                platform: ['win32'] },
  { name: 'h264_vaapi',         label: 'VA-API (Linux)',         platform: ['linux'] },
  { name: 'h264_qsv',           label: 'Intel Quick Sync',      platform: ['win32', 'linux', 'darwin'] },
];

const HEVC_ENCODERS = [
  { name: 'hevc_nvenc',         label: 'NVIDIA NVENC (HEVC)',    platform: ['win32', 'linux'] },
  { name: 'hevc_videotoolbox',  label: 'Apple VideoToolbox (HEVC)', platform: ['darwin'] },
  { name: 'hevc_amf',           label: 'AMD AMF (HEVC)',         platform: ['win32'] },
  { name: 'hevc_vaapi',         label: 'VA-API HEVC (Linux)',    platform: ['linux'] },
  { name: 'hevc_qsv',           label: 'Intel Quick Sync (HEVC)', platform: ['win32', 'linux', 'darwin'] },
];

const CACHE_DIR = path.join(os.homedir(), '.ffmpeg-render-pro');
const CACHE_FILE = path.join(CACHE_DIR, 'gpu-cache.json');
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Maximum supported resolution (8K)
const MAX_WIDTH = 7680;
const MAX_HEIGHT = 4320;

/**
 * Check if ffmpeg is installed and available on PATH.
 * Returns { available: boolean, version: string|null, path: string|null }
 */
function checkFFmpeg() {
  try {
    const result = spawnSync('ffmpeg', ['-version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error) {
      return { available: false, version: null, path: null, error: 'ffmpeg not found on PATH. Install ffmpeg: https://ffmpeg.org/download.html' };
    }
    const versionMatch = (result.stdout || '').match(/ffmpeg version (\S+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    return { available: true, version, path: 'ffmpeg', error: null };
  } catch {
    return { available: false, version: null, path: null, error: 'ffmpeg not found on PATH. Install ffmpeg: https://ffmpeg.org/download.html' };
  }
}

/**
 * Get ffmpeg version string for cache invalidation.
 */
function getFFmpegVersion() {
  const check = checkFFmpeg();
  return check.version || 'unknown';
}

/**
 * Check if an encoder is listed in ffmpeg -encoders output.
 */
function isEncoderListed(encoderName) {
  try {
    const result = spawnSync('ffmpeg', ['-encoders'], {
      encoding: 'utf-8', timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return (result.stdout || '').includes(encoderName);
  } catch {
    return false;
  }
}

/**
 * Validate an encoder by running a 1-frame test encode.
 * This catches cases where the encoder is listed but the driver/hardware is missing.
 */
function validateEncoder(encoderName) {
  try {
    const result = spawnSync('ffmpeg', [
      '-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.04',
      '-c:v', encoderName,
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
    if (!fs.existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
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
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      ...result,
      timestamp: Date.now(),
      ffmpegVersion: getFFmpegVersion(),
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

  // Force CPU mode — skip all probing
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

  const platform = os.platform();
  const available = [];

  // Test H.264 encoders
  const candidates = ENCODER_PRIORITY.filter(e => e.platform.includes(platform));
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

  // Force GPU mode — fail if none found
  if (forceEncoder === 'gpu' && !isGpu) {
    throw new Error(
      'GPU encoding forced (--gpu) but no hardware encoder found.\n' +
      '  Tested: ' + candidates.map(c => c.label).join(', ') + '\n' +
      '  Install GPU drivers or remove --gpu to fall back to CPU.'
    );
  }

  // Test HEVC encoders
  let bestHevc = null;
  const hevcCandidates = HEVC_ENCODERS.filter(e => e.platform.includes(platform));
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

/**
 * Get codec args for the given encoder.
 */
function getCodecArgs(encoder, options = {}) {
  const { crf = 20, cq = 20, preset } = options;

  switch (encoder) {
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', preset || 'fast', '-crf', String(crf)];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', preset || 'p4', '-cq', String(cq)];
    case 'hevc_nvenc':
      return ['-c:v', 'hevc_nvenc', '-preset', preset || 'p4', '-cq', String(cq), '-tag:v', 'hvc1'];
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-q:v', String(Math.round(cq * 2.5))];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(cq), '-qp_p', String(cq)];
    case 'h264_vaapi':
      return ['-c:v', 'h264_vaapi', '-qp', String(cq)];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', String(cq)];
    default:
      return ['-c:v', encoder, '-preset', preset || 'fast', '-crf', String(crf)];
  }
}

module.exports = { detectGPU, getCodecArgs, getFFmpegVersion, checkFFmpeg, validateResolution, MAX_WIDTH, MAX_HEIGHT };
