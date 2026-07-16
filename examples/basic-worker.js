/**
 * Basic Worker - Procedural test scene for ffmpeg-render-pro
 *
 * Generates animated gradient bars + floating particles using raw pixel buffers.
 * No external dependencies (no canvas, no images, no npm packages).
 * Works on any OS - just needs Node.js and ffmpeg.
 *
 * This worker is spawned by the parallel renderer. It receives frame range
 * via workerData and pipes raw BGRA frames to an ffmpeg encoder subprocess.
 */
const { workerData, parentPort } = require('worker_threads');
const { spawn } = require('child_process');

const {
  width, height, fps, seed,
  startFrame, endFrame, segmentPath,
  workerId, totalFrames, duration,
} = workerData;

// --- Seeded RNG (Mulberry32) for deterministic output ---
function mulberry32(seed) {
  let s = seed | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(seed);

// Post at most one terminal error and never send 'done' after 'error':
// the parent treats the first terminal message as the worker's outcome.
let sentError = false;
function postError(message) {
  if (sentError) return;
  sentError = true;
  parentPort.postMessage({ type: 'error', workerId, error: message });
}

// --- Particle system ---
const NUM_PARTICLES = 80;
const particles = [];
for (let i = 0; i < NUM_PARTICLES; i++) {
  particles.push({
    x: rng() * width,
    y: rng() * height,
    vx: (rng() - 0.5) * 60,
    vy: (rng() - 0.5) * 60,
    radius: 2 + rng() * 6,
    hue: rng() * 360,
    alpha: 0.3 + rng() * 0.7,
  });
}

// --- Color helpers ---
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function blend(bgR, bgG, bgB, fgR, fgG, fgB, alpha) {
  return [
    Math.round(bgR * (1 - alpha) + fgR * alpha),
    Math.round(bgG * (1 - alpha) + fgG * alpha),
    Math.round(bgB * (1 - alpha) + fgB * alpha),
  ];
}

// --- Frame renderer ---
// `px32` is a Uint32Array view over the same memory as `buffer`. Each element
// is one BGRA pixel (little-endian: B | G<<8 | R<<16 | A<<24), so the solid
// background bars and progress bar are painted with native Uint32Array.fill
// span writes: one fill per (row, bar) span instead of 4 byte writes per
// pixel. On 1080p this cuts frame generation time roughly in half.
function renderFrame(frameNum, buffer, px32) {
  const t = frameNum / fps; // time in seconds
  const progress = frameNum / totalFrames;

  // Background: animated vertical gradient bars
  const barWidth = Math.max(4, Math.floor(width / 40));
  const numBars = Math.ceil(width / barWidth) + 1;
  const hueShift = t * 30; // slow rotation

  // Per-bar values that don't change down a column (the sin term was
  // previously recomputed for every row of every bar).
  const barHues = new Float64Array(numBars);
  const barSins = new Float64Array(numBars);
  for (let b = 0; b < numBars; b++) {
    barHues[b] = (b * 9 + hueShift) % 360;
    barSins[b] = Math.sin(t * 2 + b * 0.3) * 0.05;
  }

  for (let y = 0; y < height; y++) {
    const yNorm = y / height;
    const rowStart = y * width;
    for (let b = 0; b < numBars; b++) {
      const xStart = b * barWidth;
      if (xStart >= width) break;
      const lightness = 0.08 + yNorm * 0.15 + barSins[b];
      const [r, g, bl] = hslToRgb(barHues[b], 0.7, lightness);
      const color = (0xFF000000 | (r << 16) | (g << 8) | bl) >>> 0;
      px32.fill(color, rowStart + xStart, rowStart + Math.min(xStart + barWidth, width));
    }
  }

  // Draw particles
  const dt = 1 / fps;
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Bounce off walls
    if (p.x < 0 || p.x > width)  p.vx *= -1;
    if (p.y < 0 || p.y > height) p.vy *= -1;
    p.x = Math.max(0, Math.min(width - 1, p.x));
    p.y = Math.max(0, Math.min(height - 1, p.y));

    // Shift hue over time
    p.hue = (p.hue + 20 * dt) % 360;

    // Draw filled circle
    const [pr, pg, pb] = hslToRgb(p.hue, 0.9, 0.6);
    const r = Math.ceil(p.radius);
    const cx = Math.round(p.x);
    const cy = Math.round(p.y);

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;

        const idx = (py * width + px) * 4;
        const dist = Math.sqrt(dx * dx + dy * dy) / r;
        const a = p.alpha * (1 - dist * 0.6); // soft edge

        const [br2, bg2, bb2] = blend(buffer[idx + 2], buffer[idx + 1], buffer[idx], pr, pg, pb, a);
        buffer[idx]     = bb2;
        buffer[idx + 1] = bg2;
        buffer[idx + 2] = br2;
      }
    }
  }

  // Progress bar at bottom (span fills: cyan for done, dark for remaining)
  const barH = 4;
  const barY = height - barH;
  const barFillW = Math.round(progress * width);
  const CYAN = (0xFF000000 | (0 << 16) | (255 << 8) | 255) >>> 0;
  const DARK = (0xFF000000 | (30 << 16) | (30 << 8) | 30) >>> 0;
  for (let y = barY; y < height; y++) {
    const rowStart = y * width;
    px32.fill(CYAN, rowStart, rowStart + barFillW);
    px32.fill(DARK, rowStart + barFillW, rowStart + width);
  }
}

// --- Main: fast-forward to startFrame, then render + encode ---
async function main() {
  const frameSize = width * height * 4; // BGRA
  const buffer = Buffer.alloc(frameSize);
  // One u32 per pixel over the same memory (Buffer.alloc is non-pooled, so
  // byteOffset is 0 and the view is always 4-byte aligned).
  const px32 = new Uint32Array(buffer.buffer, buffer.byteOffset, width * height);

  // Fast-forward particle state to startFrame (update-only, no render)
  if (startFrame > 0) {
    // Structured message so the parent doesn't have to substring-match.
    parentPort.postMessage({ type: 'fast-forward-start', workerId, frames: startFrame });
    const dt = 1 / fps;
    for (let f = 0; f < startFrame; f++) {
      for (const p of particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < 0 || p.x > width)  p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;
        p.x = Math.max(0, Math.min(width - 1, p.x));
        p.y = Math.max(0, Math.min(height - 1, p.y));
        p.hue = (p.hue + 20 * dt) % 360;
      }
    }
  }

  // Spawn ffmpeg encoder. Callers can override the encoder args by passing
  // workerData: { codecArgs: ['-c:v', ..., ...] } to renderParallel; the
  // default matches the parallel-segment recipe (CPU x264, fast, crf 20).
  const codecArgs = Array.isArray(workerData.codecArgs) && workerData.codecArgs.length > 0
    ? workerData.codecArgs
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20'];
  const ffmpeg = spawn(process.env.FFMPEG_RENDER_PRO_FFMPEG || 'ffmpeg', [
    '-y',
    '-f', 'rawvideo',
    '-pixel_format', 'bgra',
    '-video_size', `${width}x${height}`,
    '-framerate', String(fps),
    '-i', 'pipe:0',
    ...codecArgs,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    segmentPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  // Keep only the last 8KB of stderr: ffmpeg writes stats lines continuously,
  // so an uncapped buffer grows unbounded on long renders. The tail carries
  // the error message when ffmpeg fails.
  const STDERR_CAP = 8192;
  let stderrData = '';
  ffmpeg.stderr.on('data', (chunk) => {
    stderrData += chunk.toString();
    if (stderrData.length > STDERR_CAP) stderrData = stderrData.slice(-STDERR_CAP);
  });

  // Capture stdin stream errors (EPIPE when ffmpeg dies mid-pipe) so the
  // write loop can surface the captured ffmpeg stderr instead of crashing
  // the worker with an unhandled stream 'error' event.
  let streamError = null;
  ffmpeg.stdin.on('error', (err) => { if (!streamError) streamError = err; });

  // Track exit state from a single early listener: the final close-wait must
  // not attach 'close' after ffmpeg already exited (it would hang forever).
  let closed = false;
  let closeCode = null;
  ffmpeg.on('close', (code) => { closed = true; closeCode = code; });

  // Surface spawn failures (e.g. ffmpeg missing mid-run) instead of crashing
  // the worker with an unhandled 'error' event.
  ffmpeg.on('error', (err) => {
    postError('ffmpeg spawn failed: ' + err.message);
  });

  const framesToRender = endFrame - startFrame;
  const reportInterval = Math.max(1, Math.floor(framesToRender / 100)); // ~100 progress updates
  const startTime = Date.now();

  // Buffer-reuse constraint: write() returning true does NOT mean the chunk
  // was flushed; the stream may still hold it by reference. Frames under the
  // pipe highWaterMark can return true while queued, so those must be copied.
  // Bigger frames keep the zero-copy reuse: write() returns false and the
  // drain wait guarantees a full flush before the buffer is mutated again.
  const copyFrames = frameSize < 64 * 1024;

  for (let f = startFrame; f < endFrame; f++) {
    if (streamError || closed) {
      const cause = streamError ? streamError.message : `exited early with code ${closeCode}`;
      throw new Error(`ffmpeg encode failed (${cause}): ${stderrData.slice(-500)}`);
    }

    renderFrame(f, buffer, px32);

    // Write with backpressure
    const ok = ffmpeg.stdin.write(copyFrames ? Buffer.from(buffer) : buffer);
    if (!ok) {
      // Also wake on error/close so a dead ffmpeg cannot hang the drain wait;
      // the check at the top of the loop surfaces the failure.
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

    // Report progress
    if ((f - startFrame) % reportInterval === 0 || f === endFrame - 1) {
      const done = f - startFrame + 1;
      const pct = (done / framesToRender) * 100;
      const elapsed = (Date.now() - startTime) / 1000;
      const currentFps = elapsed > 0 ? done / elapsed : 0;
      const remaining = currentFps > 0 ? (framesToRender - done) / currentFps : 0;

      parentPort.postMessage({
        type: 'progress',
        workerId,
        pct: pct.toFixed(1),
        fps: currentFps.toFixed(1),
        frame: done,
        eta: remaining.toFixed(0),
      });
    }
  }

  // Close encoder. Resolve from the captured state when ffmpeg already
  // exited; attaching 'close' after the event fired would hang forever.
  ffmpeg.stdin.end();
  await new Promise((resolve, reject) => {
    const finish = (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderrData.slice(-500)}`));
    };
    if (closed) return finish(closeCode);
    ffmpeg.once('close', finish);
  });

  if (!sentError) parentPort.postMessage({ type: 'done', workerId });
}

main().catch(err => {
  postError(err.message);
});
