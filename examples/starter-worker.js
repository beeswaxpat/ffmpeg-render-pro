/**
 * Starter worker for ffmpeg-render-pro.
 *
 * `ffmpeg-render-pro init` writes this file so you have something that
 * renders on the first try. You only need to change ONE function:
 * renderFrame(), marked below. Everything else is the plumbing that turns
 * your pixels into an MP4 segment and reports progress to the renderer.
 *
 * Run it:   ffmpeg-render-pro render my-worker.js --duration=5
 *
 * How a render works: the renderer starts N copies of this file, each in
 * its own worker thread, and hands each one a frame range through
 * workerData. Each copy pipes raw BGRA frames into its own ffmpeg process,
 * which writes one MP4 segment. The renderer then joins the segments
 * without re-encoding. Deterministic output only needs one rule: derive
 * every random value from `seed`, never from Math.random().
 *
 * For a bigger reference (particles, seeded RNG, fast-forward), read
 * examples/basic-worker.js in the installed package.
 */
const { workerData, parentPort } = require('worker_threads');
const { spawn } = require('child_process');

const {
  width, height, fps, seed,
  startFrame, endFrame, segmentPath,
  workerId, totalFrames, duration,
} = workerData;

// ---------------------------------------------------------------------
// YOUR CODE GOES HERE.
//
// Fill `buffer` with the pixels of frame `frameNum`. The buffer holds
// width * height pixels, 4 bytes each, in B, G, R, A order, top row first.
// `frameNum` counts from 0 across the whole video, so `frameNum / fps` is
// the time in seconds and `frameNum / totalFrames` is 0..1 progress.
// ---------------------------------------------------------------------
function renderFrame(frameNum, buffer) {
  const t = frameNum / fps;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      buffer[i]     = Math.floor(128 + 127 * Math.sin(x / 60 + t));        // B
      buffer[i + 1] = Math.floor(128 + 127 * Math.sin(y / 60 + t * 0.7));  // G
      buffer[i + 2] = Math.floor(255 * (frameNum / totalFrames));          // R
      buffer[i + 3] = 255;                                                  // A
    }
  }
}

// ---------------------------------------------------------------------
// Plumbing below. Leave it alone unless you know why you are changing it.
// ---------------------------------------------------------------------
async function main() {
  const codecArgs = Array.isArray(workerData.codecArgs) && workerData.codecArgs.length > 0
    ? workerData.codecArgs
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20'];

  const ffmpeg = spawn(process.env.FFMPEG_RENDER_PRO_FFMPEG || 'ffmpeg', [
    '-y',
    '-f', 'rawvideo', '-pixel_format', 'bgra',
    '-video_size', `${width}x${height}`, '-framerate', String(fps),
    '-i', 'pipe:0',
    ...codecArgs,
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    segmentPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  // Keep the last 8KB of ffmpeg's stderr: it carries the error text on failure.
  let stderrTail = '';
  ffmpeg.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-8192); });

  // Track stream errors and exit from early listeners so nothing hangs.
  let streamError = null;
  ffmpeg.stdin.on('error', (err) => { if (!streamError) streamError = err; });
  let closed = false;
  let closeCode = null;
  ffmpeg.on('close', (code) => { closed = true; closeCode = code; });
  ffmpeg.on('error', (err) => { if (!streamError) streamError = err; });

  const frameSize = width * height * 4;
  const buffer = Buffer.alloc(frameSize);
  // Small frames can be queued by reference even when write() returns true,
  // so they are copied. Large frames block on drain, which flushes them.
  const copyFrames = frameSize < 64 * 1024;

  const framesToRender = endFrame - startFrame;
  const reportEvery = Math.max(1, Math.floor(framesToRender / 100));
  const started = Date.now();

  for (let f = startFrame; f < endFrame; f++) {
    if (streamError || closed) {
      const cause = streamError ? streamError.message : `exited early with code ${closeCode}`;
      throw new Error(`ffmpeg encode failed (${cause}): ${stderrTail.slice(-500)}`);
    }

    renderFrame(f, buffer);

    const ok = ffmpeg.stdin.write(copyFrames ? Buffer.from(buffer) : buffer);
    if (!ok) {
      await new Promise((resolve) => {
        const settle = () => {
          ffmpeg.stdin.off('drain', settle);
          ffmpeg.stdin.off('error', settle);
          ffmpeg.off('close', settle);
          resolve();
        };
        ffmpeg.stdin.once('drain', settle);
        ffmpeg.stdin.once('error', settle);
        ffmpeg.once('close', settle);
      });
    }

    const done = f - startFrame + 1;
    if (done % reportEvery === 0 || done === framesToRender) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = elapsed > 0 ? done / elapsed : 0;
      parentPort.postMessage({
        type: 'progress', workerId,
        pct: (done / framesToRender) * 100,
        fps: rate, frame: done,
        eta: rate > 0 ? (framesToRender - done) / rate : 0,
      });
    }
  }

  ffmpeg.stdin.end();
  await new Promise((resolve, reject) => {
    const finish = (code) => (code === 0
      ? resolve()
      : reject(new Error(`ffmpeg exited ${code}: ${stderrTail.slice(-500)}`)));
    if (closed) return finish(closeCode);
    ffmpeg.once('close', finish);
  });

  parentPort.postMessage({ type: 'done', workerId });
}

main().catch((err) => {
  parentPort.postMessage({ type: 'error', workerId, error: err.message });
});
