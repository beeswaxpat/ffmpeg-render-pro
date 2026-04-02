/**
 * Encoder — Pipe raw frames to ffmpeg for encoding
 *
 * Accepts raw BGRA frames via stdin pipe. Supports CPU and GPU codecs
 * with backpressure handling for memory-safe rendering.
 */
const { spawn } = require('child_process');
const { getCodecArgs } = require('./gpu-detect');

/**
 * Create an ffmpeg encoder that accepts raw BGRA frames via stdin pipe.
 *
 * @param {Object} options
 * @param {number} options.width - Frame width
 * @param {number} options.height - Frame height
 * @param {number} options.fps - Framerate
 * @param {string} options.outputPath - Output file path
 * @param {string} [options.codec='libx264'] - Encoder name
 * @param {string} [options.pixelFormat='bgra'] - Input pixel format
 * @param {number} [options.crf=20] - CRF for CPU encoders
 * @param {number} [options.cq=20] - CQ for GPU encoders
 * @param {string} [options.preset] - Encoder preset override
 * @returns {{ writeFrame, finish, process }}
 */
function createEncoder(options) {
  const {
    width, height, fps, outputPath,
    codec = 'libx264',
    pixelFormat = 'bgra',
    crf = 20,
    cq = 20,
    preset,
  } = options;

  const codecArgs = getCodecArgs(codec, { crf, cq, preset });

  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pixel_format', pixelFormat,
    '-video_size', `${width}x${height}`,
    '-framerate', String(fps),
    '-i', 'pipe:0',
    ...codecArgs,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ];

  const ffmpeg = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrData = '';
  ffmpeg.stderr.on('data', (chunk) => {
    stderrData += chunk.toString();
  });

  ffmpeg.on('error', (err) => {
    console.error('ffmpeg encoder error:', err.message);
  });

  return {
    process: ffmpeg,
    stdin: ffmpeg.stdin,

    writeFrame(buffer) {
      return new Promise((resolve, reject) => {
        const ok = ffmpeg.stdin.write(buffer);
        if (ok) {
          resolve();
        } else {
          ffmpeg.stdin.once('drain', resolve);
        }
      });
    },

    finish() {
      return new Promise((resolve, reject) => {
        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`ffmpeg exited with code ${code}\n${stderrData.slice(-500)}`));
          }
        });
        ffmpeg.stdin.end();
      });
    },
  };
}

module.exports = { createEncoder };
