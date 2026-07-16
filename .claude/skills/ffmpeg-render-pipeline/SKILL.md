---
name: ffmpeg-render-pipeline
description: Use when rendering video or audio with ffmpeg - parallel rendering, GPU encoding, audio mixing, checkpoint systems, live dashboards, minterpolate optical flow, color grading, and YouTube-optimized output. Trigger on any video/audio render task.
argument-hint: [task-description]
---

# ffmpeg Render Pipeline - Complete Reference

You are an expert video/audio render engineer. This skill covers the **ffmpeg-render-pro** toolkit - a parallel rendering system optimized for YouTube Shorts and long-form videos.

**Toolkit location:** The user may have `ffmpeg-render-pro` installed globally (`npm install -g ffmpeg-render-pro` provides the `ffmpeg-render-pro` CLI) or as a local dependency. Check with `ffmpeg-render-pro version` or `node -e "require('ffmpeg-render-pro')"`. In a repo checkout, `node bin/ffmpeg-render-pro.js` is equivalent to the installed CLI.

## Prerequisites

Before any render task, verify:
1. **Node.js >= 18** - `node --version`
2. **ffmpeg available** - `ffmpeg -version`. If ffmpeg is installed but not on PATH, set `FFMPEG_RENDER_PRO_FFMPEG` to its full path (a sibling ffprobe is auto-derived; `FFMPEG_RENDER_PRO_FFPROBE` overrides it explicitly). Both are read at call time.
3. If ffmpeg is missing entirely, tell the user: "Install ffmpeg from https://ffmpeg.org/download.html and ensure it's on your PATH, or set FFMPEG_RENDER_PRO_FFMPEG to its full path."

## Quick Start (for any render task)

```bash
# Check system capabilities
ffmpeg-render-pro info

# Run a benchmark to test the setup (5s test render)
ffmpeg-render-pro benchmark

# Render a YouTube Short shape (vertical, 60s) with the bundled test worker
ffmpeg-render-pro benchmark --width=1080 --height=1920 --fps=30 --duration=60

# Render with your own worker script
ffmpeg-render-pro render my-worker.js --duration=60 --output=video.mp4

# Force CPU or GPU encoding during detection
ffmpeg-render-pro detect-gpu --cpu
ffmpeg-render-pro detect-gpu --gpu
```

---

## Core Rules (ALWAYS follow)

1. **Pre-scale BEFORE heavy processing** - Never run expensive filters (minterpolate, color grading) on source resolution. Downscale to target resolution FIRST.
2. **Parallel rendering when possible** - 8-worker parallel pipeline with segment concat for procedural video. Single process for minterpolate (segment overhead dominates).
3. **GPU encoding when available** - Use `detectGPU()` to auto-detect. Parallel segment encoding always uses CPU x264 by design (GPU encoder session limits); GPU encoders apply to final single-pass encodes (color grades, single-file renders). The `--cpu`/`--gpu` CLI flags exist on `detect-gpu` and `info` only; in the API pass `forceEncoder: 'cpu'` or `'gpu'` to `detectGPU()`.
4. **Live render dashboard REQUIRED** - The dashboard auto-opens in the browser before rendering starts. Every render gets a live progress view. (Headless/CI runs can opt out with `--no-dashboard` or `--no-open`, and `--linger-ms=0` exits immediately after completion.)
5. **One render at a time** - Sequential is faster than competing for cores.
6. **`-movflags +faststart` on EVERYTHING** - Required for YouTube uploads and streaming.

---

## Encoder Selection

The toolkit auto-detects the best encoder for the user's system:

| Platform | GPU Encoders Tested (in priority order) |
|----------|----------------------------------------|
| Windows  | NVENC, AMF, Quick Sync, then CPU fallback |
| macOS    | VideoToolbox, then CPU fallback |
| Linux    | NVENC, VA-API, Quick Sync, then CPU fallback |

Each encoder is validated with a 1-frame test encode using its real production args - not just checked for existence (this is what makes VA-API device init and Intel-Mac VideoToolbox quirks surface at detection time instead of render time). Results are cached for 7 days in `~/.ffmpeg-render-pro` (override the directory with `FFMPEG_RENDER_PRO_CACHE_DIR`); the cache invalidates itself on ffmpeg version changes and detection-logic upgrades.

### Force Modes
- `--cpu` (CLI: `detect-gpu`/`info` only) or `forceEncoder: 'cpu'` (API) - Skip all GPU detection, use libx264. Use this if GPU encoding produces artifacts or errors.
- `--gpu` (CLI: `detect-gpu`/`info` only) or `forceEncoder: 'gpu'` (API) - Require a hardware encoder. Fails with a clear error if none found. Use this when you know the user has a GPU and want maximum speed.

### Encoding Presets

| Scenario | Encoder | Settings |
|:---------|:--------|:---------|
| Parallel segments | libx264 | `-preset fast -crf 20` |
| Final grade pass | libx264 | `-preset medium -crf 18` |
| GPU single-pass | h264_nvenc | `-preset p4 -cq 20` |
| Shorts (GPU) | h264_nvenc | `-cq 18` |

### Worker Count (auto-detected)

| Resolution | Typical workers | RAM budget |
|:-----------|:----------------|:-----------|
| 480p | 8 | ~200MB per worker |
| 720p | 8 | ~400MB per worker |
| 1080p | 8 | ~800MB per worker |
| 1440p | 4-8 | ~1.5GB per worker |
| 4K | 4 | ~2.5GB per worker |

Auto-detection takes the minimum of the RAM budget, CPU cores minus 2, and `maxWorkers` (default cap 8). `workerCount` is a request, not a guarantee: the renderer never spawns more workers than there are frames, so short renders use fewer (10 frames across 8 requested workers spawns 5).

### CLI quality flags (render + benchmark)

- `--crf=NN` - x264 quality, 0-51, lower is higher quality (default 20)
- `--encoder-preset=NAME` - x264 speed preset: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow, placebo (default fast)

Both flow to workers via `workerData.codecArgs`. Unknown flags warn on stderr and continue; unparseable numeric values (e.g. `--fps=abc`) exit 1.

### Environment variables

- `FFMPEG_RENDER_PRO_FFMPEG` - full path to ffmpeg when it is not on PATH
- `FFMPEG_RENDER_PRO_FFPROBE` - full path to ffprobe (auto-derived as the ffmpeg sibling when unset)
- `FFMPEG_RENDER_PRO_CACHE_DIR` - GPU detection cache directory (default `~/.ffmpeg-render-pro`)
- `FFMPEG_RENDER_PRO_DEBUG=1` - full stack traces on CLI errors

---

## How to Use the API

```js
const {
  renderParallel,     // Core parallel rendering engine
  createEncoder,      // Raw frame pipe to ffmpeg
  detectGPU,          // Cross-platform GPU detection
  checkFFmpeg,        // Verify ffmpeg is installed
  validateResolution, // Sanity check dimensions
  getConfig,          // Auto-tune workers + codec selection
  computeTotalFrames, // Float-safe frame count for fps x duration
  concatSegments,     // Stream-copy segment joining (validates by default)
  colorGrade,         // Apply color grades
  COLOR_PRESETS,      // Built-in presets: noir, warm, cool, cinematic, vintage
  mergeAudio,         // Combine video + audio (no video re-encode)
  startDashboard,     // Live progress dashboard
  ProgressTracker,    // Progress + dashboard JSON (fail(), terminalStream)
  saveCheckpoint,     // Checkpoint state serialization
  loadCheckpoint,     // Checkpoint restoration
  restoreCheckpoint,  // Restore systems from checkpoint
  generateCheckpoints,// Update-only pass that writes checkpoints
  getEncoderIO,       // Encoder recipe as { inputArgs, filter, outputArgs }
  getCodecArgs,       // Encoder recipe as one flat arg array
  ffmpegBin,          // Resolved ffmpeg binary (env-var aware)
  ffprobeBin,         // Resolved ffprobe binary (env-var aware)
} = require('ffmpeg-render-pro');
```

### renderParallel(options)

```js
await renderParallel({
  workerScript: './my-worker.js',  // Your frame generator (required)
  outputPath: './output.mp4',      // Final output path (required)
  width: 1920,          // Frame width (max 7680, must be even)
  height: 1080,         // Frame height (max 4320, must be even)
  fps: 60,              // Framerate (1-240)
  duration: 60,         // Seconds
  seed: 42,             // RNG seed for deterministic output
  title: 'My Render',   // Dashboard title
  dashboard: true,       // Enable live dashboard
  autoOpen: true,        // Auto-open browser
  workerCount: 8,       // Requested count (never exceeds frame count)
  maxWorkers: 8,        // Cap for the auto-detected count
  dashboardLingerMs: 0, // 0 = resolve immediately (library use); CLI keeps 30s
  quiet: false,         // true = byte-clean stdout, status to stderr
  signal: undefined,    // AbortSignal; abort() stops workers + cleans temp
  workerData: {},        // Extra data for workers (e.g. codecArgs)
});
```

Resolves with `{ outputPath, elapsed, totalFrames, avgFps }`. A failed worker's frame range is retried once automatically before the render fails; failures show a RENDER FAILED banner on the live dashboard.

### Writing a Worker Script

Workers receive `workerData` from `worker_threads` and must:
1. Render frames from `startFrame` to `endFrame`
2. Pipe raw BGRA frames to an ffmpeg encoder
3. Report progress via `parentPort.postMessage()`
4. Signal completion with `{ type: 'done', workerId }`

See `examples/basic-worker.js` inside the installed package for a complete, working template (hardened: stderr tail capture, stdin error handling, sub-64KB frame-buffer copies). If the MCP server is wired in, the `get_worker_template` tool returns the same contract plus the full template source.

---

## Color Grading (no external editor)

### Built-in Presets
```js
await colorGrade({ inputPath: 'raw.mp4', outputPath: 'graded.mp4', preset: 'noir' });
// Available: noir, warm, cool, cinematic, vintage
// Grading a final cut that already has audio? Pass keepAudio: true
// (default strips audio, which is right for pre-merge pipeline order)
```

### Custom Filter
```js
await colorGrade({
  inputPath: 'raw.mp4',
  outputPath: 'graded.mp4',
  filter: 'eq=brightness=-0.015:contrast=1.07:saturation=0.92',
});
```

---

## Audio Pipeline

### Merge Audio (no video re-encode)
```js
await mergeAudio({
  videoPath: 'graded.mp4',
  audioPath: 'audio.mp3',
  outputPath: 'final.mp4',
  bitrate: 320,       // kbps
  loop: true,          // Loop if audio is shorter
  normalize: false,    // Apply loudnorm
});
```

### 3-Layer Audio Architecture
1. **Main Layer (100% volume)** - Close, textured, rhythmic. Long recordings (20+ min).
2. **Background Layer (45% volume)** - Diffuse atmosphere. Short loops work.
3. **Accents (12-20% volume)** - Sparse one-shots. Fade in/out. Never in first 3 min or last 2 min.

### Critical Audio Rules
- `amix normalize=0` - Prevents auto-level crushing
- `alimiter=limit=0.95` - Prevent clipping
- `loudnorm=I=-22:TP=-2:LRA=7` for YouTube normalization
- 320kbps stereo, 44100 Hz output

---

## Concat (stream copy, instant)

```js
// Validates codec/resolution/fps/pixel format with ffprobe first (default),
// because ffmpeg happily concats mismatched inputs into a corrupt file.
await concatSegments(['a.mp4', 'b.mp4'], 'joined.mp4');

// Inputs known uniform by construction? Skip the probes:
await concatSegments(['a.mp4', 'b.mp4'], 'joined.mp4', { validate: false });
```

Missing and zero-byte inputs are always rejected. If ffprobe is unavailable the compatibility check is skipped with a stderr warning.

---

## Checkpoint System

For renders longer than ~10 minutes, use checkpoints to avoid redundant fast-forwarding:

```js
// Generate checkpoints (update-only pass, no rendering)
generateCheckpoints({
  systems: { camera, particles, weather },  // Objects with getState()/setState()/update()
  totalFrames: 432000,
  fps: 60,
  checkpointDir: './.checkpoints',
  interval: 60000,  // Every 60k frames (~16.7 min at 60fps)
});

// In worker: load nearest checkpoint
const checkpoint = loadCheckpoint('./.checkpoints', startFrame);
if (checkpoint) {
  const resumeFrame = restoreCheckpoint(checkpoint, systems);
  // Fast-forward only from resumeFrame to startFrame (instead of from 0)
}
```

Rules: `_frame` and `_timestamp` are reserved checkpoint metadata keys, so no system may use either name. A checkpoint labeled frame F contains exactly F update() calls (fixed in 1.5.0; regenerate checkpoint dirs created by older versions, since they embedded one extra update).

---

## Minterpolate (Optical Flow)

For timelapse/slow-motion:
```bash
ffmpeg -y -i input.mp4 \
  -vf "scale=1080:1920,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1" \
  -c:v h264_nvenc -cq 18 -movflags +faststart output.mp4
```
**Always** pre-scale to target resolution first, then minterpolate.

---

## YouTube Shorts Optimization

For Shorts (vertical, 30-60s):
- Resolution: **1080x1920** (9:16 portrait)
- FPS: **30** (YouTube Shorts standard)
- Duration: **30-60 seconds**
- Audio: **loudnorm -14 LUFS** for Shorts
- Encoding: **GPU (cq 18)** for best quality, or **CPU (crf 18)** as fallback
- Always: **`-movflags +faststart`**

```bash
ffmpeg-render-pro benchmark --width=1080 --height=1920 --fps=30 --duration=60
```

---

## Safety & Cross-Platform Notes

- **Zero-dependency core** - The render pipeline needs only Node.js + ffmpeg (the optional MCP server uses the official MCP SDK).
- **No network calls** - Dashboard is localhost-only. No telemetry, no phone-home.
- **No CDN loads** - Dashboard uses system fonts, no external resources.
- **Path handling** - All paths use `path.join()` for cross-platform safety.
- **Graceful shutdown** - SIGINT/SIGTERM handlers clean up temp files and kill workers.
- **Input validation** - Resolution capped at 8K, fps 1-240, NaN-safe flag parsing.
- **Works offline** - Everything runs locally.
