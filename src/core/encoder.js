/**
 * Encoder — Pipe raw frames to ffmpeg for encoding
 *
 * Accepts raw BGRA frames via stdin pipe. Supports CPU and GPU codecs
 * with backpressure handling for memory-safe rendering.
 */
const { spawn } = require('child_process');
const { getCodecArgs } = require('./gpu-detect');

const STDERR_CAP = 8192;

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
    if (stderrData.length > STDERR_CAP) stderrData = stderrData.slice(-STDERR_CAP);
  });

  // Capture stream-level errors so writeFrame can surface them.
  let streamError = null;
  const onStreamError = (err) => { streamError = err; };
  ffmpeg.stdin.on('error', onStreamError);

  // Track the close state so finish() can resolve correctly even if ffmpeg
  // has already exited by the time it's called.
  let closed = false;
  let closeCode = null;
  ffmpeg.on('close', (code) => {
    closed = true;
    closeCode = code;
  });

  ffmpeg.on('error', (err) => {
    streamError = err;
    if (process.env.FFMPEG_RENDER_PRO_DEBUG) {
      console.error('ffmpeg encoder error:', err.message);
    }
  });

  return {
    process: ffmpeg,
    stdin: ffmpeg.stdin,

    // Returns undefined on a successful synchronous write (no backpressure),
    // or a Promise that resolves on drain / rejects on stream error.
    // `await` on undefined is a no-op, so callers can always `await` safely.
    writeFrame(buffer) {
      if (streamError) return Promise.reject(streamError);
      const ok = ffmpeg.stdin.write(buffer);
      if (ok) return undefined;
      return new Promise((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (err) => { cleanup(); reject(err); };
        const cleanup = () => {
          ffmpeg.stdin.off('drain', onDrain);
          ffmpeg.stdin.off('error', onError);
        };
        ffmpeg.stdin.once('drain', onDrain);
        ffmpeg.stdin.once('error', onError);
      });
    },

    finish() {
      return new Promise((resolve, reject) => {
        // If ffmpeg already exited (race: the caller awaited writeFrame errors
        // and then called finish()), resolve/reject using the captured exit code
        // rather than hanging forever on a close event that already fired.
        if (closed) {
          if (closeCode === 0) resolve();
          else reject(new Error(`ffmpeg exited with code ${closeCode}\n${stderrData.slice(-500)}`));
          return;
        }
        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`ffmpeg exited with code ${code}\n${stderrData.slice(-500)}`));
          }
        });
        try {
          ffmpeg.stdin.end();
        } catch (err) {
          reject(err);
        }
      });
    },
  };
}

module.exports = { createEncoder };
