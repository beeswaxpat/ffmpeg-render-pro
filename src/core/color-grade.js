/**
 * Color Grade — Apply ffmpeg video filter chains
 *
 * Accepts arbitrary ffmpeg -vf filter strings. Includes built-in presets
 * for common color grades.
 */
const { spawn } = require('child_process');
const { getCodecArgs } = require('./gpu-detect');

const STDERR_CAP = 8192;

const PRESETS = {
  'noir': [
    'eq=brightness=-0.015:contrast=1.07:saturation=0.92',
    "colorbalance=rs=-0.04:gs=0.01:bs=0.06:rm=-0.025:gm=0.005:bm=0.04",
    "curves=m='0/0 0.25/0.21 0.5/0.51 0.75/0.80 1/1'",
  ].join(','),
  'warm': [
    'eq=brightness=0.02:contrast=1.05:saturation=1.1',
    'colorbalance=rs=0.05:gs=0.02:bs=-0.03:rm=0.03:gm=0.01:bm=-0.02',
  ].join(','),
  'cool': [
    'eq=brightness=-0.01:contrast=1.04:saturation=0.95',
    'colorbalance=rs=-0.03:gs=0.0:bs=0.05:rm=-0.02:gm=0.0:bm=0.03',
  ].join(','),
  'cinematic': [
    'eq=brightness=-0.01:contrast=1.08:saturation=0.88',
    "curves=m='0/0 0.15/0.12 0.5/0.52 0.85/0.88 1/1'",
    'colorbalance=rs=-0.02:gs=0.01:bs=0.04',
  ].join(','),
  'vintage': [
    'eq=brightness=0.01:contrast=0.95:saturation=0.7',
    'colorbalance=rs=0.06:gs=0.02:bs=-0.04',
    "curves=m='0/0.03 0.25/0.22 0.5/0.50 0.75/0.78 1/0.95'",
  ].join(','),
};

/**
 * Apply a color grade / video filter to a video file.
 *
 * @param {Object} options
 * @param {string} options.inputPath - Input video file
 * @param {string} options.outputPath - Output file path
 * @param {string} [options.filter] - Custom ffmpeg -vf filter string
 * @param {string} [options.preset] - Named preset ('noir', 'warm', 'cool', 'cinematic', 'vintage')
 * @param {string} [options.codec='libx264'] - Encoder for output
 * @param {number} [options.crf=18] - CRF quality
 * @param {string} [options.encoderPreset='medium'] - Encoder speed preset
 * @returns {Promise<void>}
 */
function colorGrade(options) {
  const {
    inputPath, outputPath,
    filter,
    preset,
    codec = 'libx264',
    crf = 18,
    cq = 18,
    encoderPreset = 'medium',
  } = options;

  const filterChain = filter || PRESETS[preset];
  if (!filterChain) {
    return Promise.reject(new Error(
      `No filter provided. Use 'filter' for custom, or 'preset' from: ${Object.keys(PRESETS).join(', ')}`
    ));
  }

  return new Promise((resolve, reject) => {
    const codecArgs = getCodecArgs(codec, { crf, cq, preset: encoderPreset });

    const args = [
      '-y',
      '-i', inputPath,
      '-vf', filterChain,
      ...codecArgs,
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an',
      outputPath,
    ];

    const ffmpeg = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrData = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
      if (stderrData.length > STDERR_CAP) stderrData = stderrData.slice(-STDERR_CAP);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Color grade failed (code ${code})\n${stderrData.slice(-500)}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`Color grade error: ${err.message}`));
    });
  });
}

module.exports = { colorGrade, PRESETS };
