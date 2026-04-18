/**
 * Basic Worker — Procedural test scene for ffmpeg-render-pro
 *
 * Generates animated gradient bars + floating particles using raw pixel buffers.
 * No external dependencies (no canvas, no images, no npm packages).
 * Works on any OS — just needs Node.js and ffmpeg.
 *
 * This worker is spawned by the parallel renderer. It receives frame range
 * via workerData and pipes raw BGRA frames to an ffmpeg encoder subprocess.
 */
const { workerData, parentPort } = require('worker_threads');
const { spawn } = require('child_process');
const path = require('path');

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
function renderFrame(frameNum, buffer) {
  const t = frameNum / fps; // time in seconds
  const progress = frameNum / totalFrames;

  // Background: animated vertical gradient bars
  const barWidth = Math.max(4, Math.floor(width / 40));
  const numBars = Math.ceil(width / barWidth) + 1;
  const hueShift = t * 30; // slow rotation

  // Precompute per-bar × per-row colors ONCE, not per pixel.
  // (numBars * height) hslToRgb calls instead of (width * height) — 20-40× less
  // work on 1080p+, a ~25% frame-rendering speedup.
  const barColorsBGR = new Uint8ClampedArray(numBars * height * 3);
  for (let b = 0; b < numBars; b++) {
    const barHue = (b * 9 + hueShift) % 360;
    for (let y = 0; y < height; y++) {
      const yNorm = y / height;
      const lightness = 0.08 + yNorm * 0.15 + Math.sin(t * 2 + b * 0.3) * 0.05;
      const [r, g, bl] = hslToRgb(barHue, 0.7, lightness);
      const ci = (b * height + y) * 3;
      barColorsBGR[ci]     = bl;
      barColorsBGR[ci + 1] = g;
      barColorsBGR[ci + 2] = r;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const barIndex = Math.floor(x / barWidth);
      const ci = (barIndex * height + y) * 3;
      // BGRA format
      buffer[idx]     = barColorsBGR[ci];
      buffer[idx + 1] = barColorsBGR[ci + 1];
      buffer[idx + 2] = barColorsBGR[ci + 2];
      buffer[idx + 3] = 255;
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

  // Progress bar at bottom
  const barH = 4;
  const barY = height - barH;
  const barFillW = Math.round(progress * width);
  for (let y = barY; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (x < barFillW) {
        buffer[idx] = 255; buffer[idx + 1] = 255; buffer[idx + 2] = 0; // cyan in BGRA
      } else {
        buffer[idx] = 30; buffer[idx + 1] = 30; buffer[idx + 2] = 30;
      }
      buffer[idx + 3] = 255;
    }
  }
}

// --- Main: fast-forward to startFrame, then render + encode ---
async function main() {
  const frameSize = width * height * 4; // BGRA
  const buffer = Buffer.alloc(frameSize);

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

  // Spawn ffmpeg encoder
  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-f', 'rawvideo',
    '-pixel_format', 'bgra',
    '-video_size', `${width}x${height}`,
    '-framerate', String(fps),
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    segmentPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderrData = '';
  ffmpeg.stderr.on('data', (chunk) => { stderrData += chunk.toString(); });

  const framesToRender = endFrame - startFrame;
  const reportInterval = Math.max(1, Math.floor(framesToRender / 100)); // ~100 progress updates
  const startTime = Date.now();

  for (let f = startFrame; f < endFrame; f++) {
    renderFrame(f, buffer);

    // Write with backpressure
    const ok = ffmpeg.stdin.write(buffer);
    if (!ok) {
      await new Promise(r => ffmpeg.stdin.once('drain', r));
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

  // Close encoder
  ffmpeg.stdin.end();
  await new Promise((resolve, reject) => {
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderrData.slice(-300)}`));
    });
  });

  parentPort.postMessage({ type: 'done', workerId });
}

main().catch(err => {
  parentPort.postMessage({ type: 'error', workerId, error: err.message });
});
