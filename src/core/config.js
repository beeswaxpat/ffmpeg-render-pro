/**
 * Auto-Configuration — Dynamic worker count and resource allocation
 *
 * Determines optimal worker count based on resolution, available RAM,
 * and CPU core count. Respects GPU session limits.
 */
const os = require('os');

const RAM_PER_WORKER = {
  '480p':  200 * 1024 * 1024,   // ~200MB
  '720p':  400 * 1024 * 1024,   // ~400MB
  '1080p': 800 * 1024 * 1024,   // ~800MB
  '1440p': 1.5 * 1024 * 1024 * 1024, // ~1.5GB
  '4k':    2.5 * 1024 * 1024 * 1024, // ~2.5GB
};

/**
 * Map resolution to tier name.
 */
function getResolutionTier(width, height) {
  const pixels = width * height;
  if (pixels <= 640 * 480)   return '480p';
  if (pixels <= 1280 * 720)  return '720p';
  if (pixels <= 1920 * 1080) return '1080p';
  if (pixels <= 2560 * 1440) return '1440p';
  return '4k';
}

/**
 * Calculate optimal worker count.
 */
function getOptimalWorkers(options = {}) {
  const {
    width = 1920,
    height = 1080,
    maxWorkers = 8,
    reservedCores = 2,
  } = options;

  const tier = getResolutionTier(width, height);
  const ramPerWorker = RAM_PER_WORKER[tier] || RAM_PER_WORKER['1080p'];

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usableMem = Math.max(freeMem, totalMem * 0.6); // Use at least 60% of total
  const cpuCount = os.cpus().length;

  const byRam = Math.floor(usableMem / ramPerWorker);
  const byCpu = Math.max(1, cpuCount - reservedCores);

  const optimal = Math.min(byRam, byCpu, maxWorkers);
  const workers = Math.max(1, optimal);

  return {
    workers,
    tier,
    ramPerWorker: Math.round(ramPerWorker / 1024 / 1024),
    totalRamMB: Math.round(totalMem / 1024 / 1024),
    freeRamMB: Math.round(freeMem / 1024 / 1024),
    cpuCores: cpuCount,
    reasoning: `${tier} @ ${workers} workers (RAM: ${byRam} max, CPU: ${byCpu} max, cap: ${maxWorkers})`,
  };
}

/**
 * Get the full render configuration.
 */
function getConfig(options = {}) {
  const {
    width = 1920,
    height = 1080,
    fps = 60,
    duration = 60,
    workerCount,
    gpuResult,
  } = options;

  const auto = getOptimalWorkers({ width, height });
  const workers = workerCount || auto.workers;
  const totalFrames = fps * duration;
  const framesPerWorker = Math.ceil(totalFrames / workers);

  // For parallel segments: always use CPU (GPU session limits).
  // For final passes (color grade, single-file encode): use GPU if available.
  const segmentCodec = 'libx264';
  const finalCodec = gpuResult?.h264 || 'libx264';

  return {
    width,
    height,
    fps,
    duration,
    totalFrames,
    workers,
    framesPerWorker,
    segmentCodec,
    finalCodec,
    isGpu: gpuResult?.isGpu || false,
    gpuLabel: gpuResult?.label || 'CPU (libx264)',
    tier: auto.tier,
    system: {
      cpuCores: auto.cpuCores,
      totalRamMB: auto.totalRamMB,
      freeRamMB: auto.freeRamMB,
      platform: os.platform(),
      arch: os.arch(),
    },
  };
}

module.exports = { getOptimalWorkers, getConfig, getResolutionTier };
