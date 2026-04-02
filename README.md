# ffmpeg-render-pro

Parallel video rendering with live dashboard, GPU auto-detection, checkpoint system, and stream-copy concat. The most powerful free ffmpeg rendering toolkit.

Built from real production experience rendering 2-hour, 432,000-frame ambient videos for YouTube.

## Features

- **Parallel rendering** — Split frames across N worker threads, concat with zero re-encoding
- **GPU auto-detection** — Probes NVENC, VideoToolbox, AMF, VA-API, QSV with 1-frame validation
- **Live dashboard** — Auto-opens in your browser with per-worker progress, FPS chart, ETA
- **Checkpoint system** — 93% reduction in fast-forward overhead for long renders
- **Color grading** — 5 built-in presets (noir, warm, cool, cinematic, vintage) + custom filters
- **Audio merge** — Combine video + audio with loudness normalization, no video re-encode
- **Deterministic output** — Seeded RNG ensures parallel workers produce identical results to sequential
- **Cross-platform** — Windows, macOS, Linux. Any GPU or CPU-only.

## Requirements

- **Node.js** >= 18
- **ffmpeg** installed and on PATH

## Quick Start

```bash
# Clone or install
git clone https://github.com/beeswaxpat/ffmpeg-render-pro.git
cd ffmpeg-render-pro

# Run the benchmark (5s test render, dashboard auto-opens)
node examples/render-test.js

# Run a longer test
node examples/render-test.js --duration=30

# YouTube Shorts format (vertical 1080x1920)
node examples/render-test.js --width=1080 --height=1920 --fps=30 --duration=60

# Check your GPU
node bin/ffmpeg-render-pro.js detect-gpu

# System info (workers, RAM, CPU)
node bin/ffmpeg-render-pro.js info
```

## CLI

```bash
ffmpeg-render-pro detect-gpu          # Probe hardware encoders
ffmpeg-render-pro info                # Show system config
ffmpeg-render-pro render <worker.js>  # Render with your worker script
ffmpeg-render-pro benchmark           # Quick 5s test render
```

## API

```js
const {
  renderParallel,    // Core: parallel rendering engine
  createEncoder,     // Pipe raw frames to ffmpeg
  detectGPU,         // Cross-platform GPU detection
  getConfig,         // Auto-tune workers, codec selection
  concatSegments,    // Stream-copy segment joining
  colorGrade,        // Apply color grades (presets or custom)
  mergeAudio,        // Combine video + audio
  startDashboard,    // Live progress dashboard
  saveCheckpoint,    // Checkpoint serialization
  loadCheckpoint,    // Checkpoint restoration
} = require('ffmpeg-render-pro');
```

### renderParallel(options)

The main entry point. Splits a render across workers, shows a live dashboard, and produces a final MP4.

```js
await renderParallel({
  workerScript: './my-worker.js',  // Your frame generator
  outputPath: './output.mp4',
  width: 1920,
  height: 1080,
  fps: 60,
  duration: 60,        // seconds
  title: 'My Render',
  autoOpen: true,      // auto-open dashboard in browser
});
```

### Writing a Worker

Workers receive frame ranges via `workerData` and pipe raw BGRA frames to ffmpeg:

```js
const { workerData, parentPort } = require('worker_threads');
const { spawn } = require('child_process');

const { width, height, fps, startFrame, endFrame, segmentPath, workerId } = workerData;

// Spawn ffmpeg encoder
const ffmpeg = spawn('ffmpeg', [
  '-y', '-f', 'rawvideo', '-pixel_format', 'bgra',
  '-video_size', `${width}x${height}`, '-framerate', String(fps),
  '-i', 'pipe:0',
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  segmentPath,
], { stdio: ['pipe', 'pipe', 'pipe'] });

const buffer = Buffer.alloc(width * height * 4);

for (let f = startFrame; f < endFrame; f++) {
  // Fill buffer with your frame data (BGRA format)
  renderMyFrame(f, buffer);

  // Write with backpressure
  const ok = ffmpeg.stdin.write(buffer);
  if (!ok) await new Promise(r => ffmpeg.stdin.once('drain', r));

  // Report progress
  parentPort.postMessage({ type: 'progress', workerId, pct: ..., fps: ..., frame: ..., eta: ... });
}

ffmpeg.stdin.end();
ffmpeg.on('close', () => parentPort.postMessage({ type: 'done', workerId }));
```

See `examples/basic-worker.js` for a complete working example.

## Modules

| Module | Purpose |
|--------|---------|
| `parallel-renderer` | N-worker thread pool with progress tracking |
| `encoder` | Raw frame pipe to ffmpeg with backpressure |
| `gpu-detect` | Cross-platform hardware encoder discovery + validation |
| `config` | Auto-tune workers based on resolution, RAM, CPU |
| `concat` | Stream-copy segment joining (instant) |
| `color-grade` | ffmpeg video filter presets + custom chains |
| `audio-merge` | Video + audio merge with loudnorm support |
| `dashboard-server` | Zero-dep HTTP server with auto-open browser |
| `progress` | Per-worker terminal + JSON progress tracking |
| `checkpoint` | State serialization for long renders |

## Benchmarks

Run your own:

```bash
node examples/render-test.js --duration=5
node examples/render-test.js --duration=30
node examples/render-test.js --duration=60 --width=1080 --height=1920
```

## Production Stats

From real YouTube renders using this toolkit:

| Render | Frames | Resolution | Workers | Time | Avg FPS |
|--------|--------|-----------|---------|------|---------|
| COLOSSUS (2hr) | 432,000 | 1920x1080 | 8 | 11h 46m | 10.4 |

*More benchmarks coming — run `render-test.js` and share yours!*

## License

MIT

## Author

[Beeswax Pat](https://github.com/beeswaxpat)
