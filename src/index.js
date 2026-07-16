/**
 * ffmpeg-render-pro - Parallel video rendering with live dashboard,
 * GPU auto-detection, checkpoint system, and stream-copy concat.
 *
 * @module ffmpeg-render-pro
 */
const { renderParallel } = require('./core/parallel-renderer');
const { createEncoder } = require('./core/encoder');
const { detectGPU, getCodecArgs, getEncoderIO, getEncoderCandidates, validateEncoder, getFFmpegVersion, checkFFmpeg, validateResolution } = require('./core/gpu-detect');
const { getOptimalWorkers, getConfig, getResolutionTier, computeTotalFrames } = require('./core/config');
const { ffmpegBin, ffprobeBin } = require('./core/ffmpeg-bin');
const { concatSegments } = require('./core/concat');
const { colorGrade, PRESETS: COLOR_PRESETS } = require('./core/color-grade');
const { mergeAudio } = require('./core/audio-merge');
const { startDashboard } = require('./core/dashboard-server');
const { ProgressTracker } = require('./core/progress');
const { saveCheckpoint, loadCheckpoint, restoreCheckpoint, generateCheckpoints, listCheckpoints, CHECKPOINT_INTERVAL } = require('./core/checkpoint');

module.exports = {
  // Core rendering
  renderParallel,
  createEncoder,

  // GPU detection
  detectGPU,
  getCodecArgs,
  getEncoderIO,
  getEncoderCandidates,
  validateEncoder,
  getFFmpegVersion,
  checkFFmpeg,
  validateResolution,

  // Configuration
  getOptimalWorkers,
  getConfig,
  getResolutionTier,
  computeTotalFrames,

  // ffmpeg binary resolution (FFMPEG_RENDER_PRO_FFMPEG / _FFPROBE aware)
  ffmpegBin,
  ffprobeBin,

  // Post-processing
  concatSegments,
  colorGrade,
  COLOR_PRESETS,
  mergeAudio,

  // Dashboard
  startDashboard,
  ProgressTracker,

  // Checkpoints
  saveCheckpoint,
  loadCheckpoint,
  restoreCheckpoint,
  generateCheckpoints,
  listCheckpoints,
  CHECKPOINT_INTERVAL,
};
