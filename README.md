```
  ╔══════════════════════════════════════════════════════╗
  ║                                                      ║
  ║   ████████ ████████ ██    ██ ██████  ████████  ████  ║
  ║   ██       ██       ███  ███ ██   ██ ██       ██     ║
  ║   ██████   ██████   ██ ██ ██ ██████  ██████   ██  ██ ║
  ║   ██       ██       ██    ██ ██      ██       ██  ██ ║
  ║   ██       ██       ██    ██ ██      ████████  ████  ║
  ║                                                      ║
  ║   ██████  ████████ ██    ██ ██████  ████████ ██████  ║
  ║   ██   ██ ██       ███   ██ ██   ██ ██       ██   ██ ║
  ║   ██████  ██████   ██ ██ ██ ██   ██ ██████   ██████  ║
  ║   ██   ██ ██       ██  ████ ██   ██ ██       ██   ██ ║
  ║   ██   ██ ████████ ██    ██ ██████  ████████ ██   ██ ║
  ║                                                      ║
  ║        ██████  ██████   ████                         ║
  ║        ██   ██ ██   ██ ██  ██                        ║
  ║        ██████  ██████  ██  ██                        ║
  ║        ██      ██   ██ ██  ██                        ║
  ║        ██      ██   ██  ████                         ║
  ║                                                      ║
  ║  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░ 8 WRKRS    ║
  ║  GPU: AUTO   DASHBOARD: LIVE   CONCAT: INSTANT       ║
  ╚══════════════════════════════════════════════════════╝
```

# ffmpeg-render-pro

[![npm version](https://img.shields.io/npm/v/ffmpeg-render-pro.svg)](https://www.npmjs.com/package/ffmpeg-render-pro)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Cross-platform](https://img.shields.io/badge/Platform-Win%20%7C%20Mac%20%7C%20Linux-brightgreen)](https://github.com/beeswaxpat/ffmpeg-render-pro)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP Server](https://img.shields.io/badge/MCP-Server-purple)](https://modelcontextprotocol.io)

Parallel video rendering with live dashboard, GPU auto-detection, checkpoint system, and stream-copy concat. Includes an MCP server, a Claude Code skill, and a CLI.

Built by [Beeswax Pat](https://github.com/beeswaxpat) · Free and open source forever

## Features

- **Parallel rendering**: Split frames across N worker threads, concat with zero re-encoding
- **GPU auto-detection**: Probes NVENC, VideoToolbox, AMF, VA-API, QSV with 1-frame validation
- **Live dashboard**: Auto-opens in your browser with per-worker progress, FPS chart, ETA
- **Checkpoint system**: 93% reduction in fast-forward overhead for long renders
- **Color grading**: 5 built-in presets (noir, warm, cool, cinematic, vintage) plus custom filters
- **Audio merge**: Combine video + audio with loudness normalization, no video re-encode
- **Deterministic output**: Seeded RNG ensures parallel workers produce identical results to sequential
- **MCP server**: Model Context Protocol server with 7 tools, works with Claude Code, Claude Desktop, and any MCP client
- **Cross-platform**: Windows, macOS, Linux. Any GPU or CPU-only. Requires Node.js >= 18 plus ffmpeg.

## What's New in v1.5.0

A reliability and agent-integration pass. Fully backward-compatible: every CLI command, API signature, MCP tool name, worker contract, and checkpoint file format from 1.4.x works unchanged.

- **Checkpoint resume is exact again.** `generateCheckpoints` saved state one frame ahead of its label, so checkpoint-resumed workers rendered one frame out of sync with a sequential render. Regenerate checkpoint dirs created before 1.5.0 to pick up the fix.
- **VA-API actually works on Linux.** The probe and codec args now include device init plus `hwupload`; previously every AMD/Intel GPU on Linux silently fell back to CPU.
- **VideoToolbox quality mapping fixed** (it was inverted), and every encoder is now validated with its real production args, so Intel Macs fall back to CPU at detection time instead of failing at render time.
- **`concatSegments` validates segment compatibility** (codec, resolution, fps, pixel format) with ffprobe before joining; mismatched inputs used to produce silently corrupt output.
- **The MCP server is agent-native**: structured output and output schemas on every tool, progress notifications, clean cancellation, a new `get_worker_template` tool, and guaranteed protocol hygiene (stdout carries only JSON-RPC frames).
- New `renderParallel` options: `signal` (AbortSignal) and `quiet` (byte-clean stdout). A failed worker's frame range is retried once automatically, and failures surface on the live dashboard.
- New CLI flags `--crf` and `--encoder-preset`; `FFMPEG_RENDER_PRO_FFMPEG` / `FFMPEG_RENDER_PRO_FFPROBE` env vars support ffmpeg installs that are not on PATH.
- Fractional fps x duration no longer drops a frame to float error (25fps x 4.6s renders 115 frames, not 114).
- 81 tests grew to 241 across 12 suites, plus a GitHub Actions test matrix (Ubuntu/Windows/macOS x Node 18/20/22) with real ffmpeg installs.

See [CHANGELOG.md](CHANGELOG.md) for the complete list.

## Requirements

- **Node.js** >= 18
- **ffmpeg** installed and on PATH (or pointed to via env var, below)

### Using ffmpeg That Is Not on PATH

ffmpeg and ffprobe binaries are resolved at call time from two env vars (one exception: the best-effort post-render output check, noted below):

```bash
# Full path to the ffmpeg executable (used by every render, grade, merge, concat, probe)
FFMPEG_RENDER_PRO_FFMPEG=/opt/ffmpeg/bin/ffmpeg

# Optional: full path to ffprobe. When unset and FFMPEG_RENDER_PRO_FFMPEG is set,
# the sibling ffprobe next to that ffmpeg is used automatically if it exists.
FFMPEG_RENDER_PRO_FFPROBE=/opt/ffmpeg/bin/ffprobe
```

Because the vars are read at call time (never cached at module load), a long-lived process such as the MCP server picks up changes without a restart. Error messages name these variables when a binary cannot be found. A third variable, `FFMPEG_RENDER_PRO_CACHE_DIR`, overrides the GPU detection cache directory (default `~/.ffmpeg-render-pro`).

## Install

```bash
# Global install gives you the ffmpeg-render-pro + ffmpeg-render-pro-mcp binaries
npm install -g ffmpeg-render-pro

# Or clone the repo directly
git clone https://github.com/beeswaxpat/ffmpeg-render-pro.git
cd ffmpeg-render-pro
```

## Quick Start

```bash
# System info (workers, RAM, CPU, ffmpeg version)
ffmpeg-render-pro info

# Probe hardware encoders
ffmpeg-render-pro detect-gpu

# 5s benchmark render (dashboard auto-opens at http://127.0.0.1:8080)
ffmpeg-render-pro benchmark

# Longer render, custom resolution
ffmpeg-render-pro benchmark --duration=30 --width=1080 --height=1920 --fps=30

# Force CPU / GPU encoding
ffmpeg-render-pro detect-gpu --cpu
ffmpeg-render-pro detect-gpu --gpu
```

## CLI

```bash
ffmpeg-render-pro info                # System snapshot
ffmpeg-render-pro detect-gpu          # Probe hardware encoders
ffmpeg-render-pro render <worker.js>  # Render with your worker script
ffmpeg-render-pro benchmark           # Quick 5s test render
ffmpeg-render-pro version             # Print the installed version
```

Dashboard control flags for `render` and `benchmark`: `--no-dashboard` (disable entirely), `--no-open` (serve but don't open a browser), `--port=8080`, and `--linger-ms=30000` (how long the dashboard stays up after completion; `0` exits immediately). Run `ffmpeg-render-pro` with no arguments for the full flag reference.

Quality flags for `render` and `benchmark`: `--crf=NN` (0-51, lower is higher quality) and `--encoder-preset=NAME` (any x264 preset name: ultrafast through placebo). Both are passed to workers via `workerData.codecArgs`; the bundled worker honors them, and custom workers can too.

Flag validation: an unknown flag prints a warning on stderr and execution continues (scripts stay forward compatible), but an unparseable value like `--fps=abc` or an out-of-range `--crf=99` exits 1 with a clear error instead of silently rendering at the default.

Installed binaries: `ffmpeg-render-pro` (this CLI) and `ffmpeg-render-pro-mcp` (the MCP server). A legacy `ffmpeg-render-mcp` alias for the MCP server also exists and is kept permanently so older MCP configs never break.

## API

```js
const {
  renderParallel,       // Core: parallel rendering engine
  createEncoder,        // Pipe raw frames to ffmpeg
  detectGPU,            // Cross-platform GPU detection
  getConfig,            // Auto-tune workers, codec selection
  computeTotalFrames,   // Float-safe frame count for an fps/duration pair
  concatSegments,       // Stream-copy segment joining (validates by default)
  colorGrade,           // Apply color grades (presets or custom)
  mergeAudio,           // Combine video + audio
  startDashboard,       // Live progress dashboard
  ProgressTracker,      // Per-worker progress + dashboard JSON writer
  saveCheckpoint,       // Checkpoint serialization
  loadCheckpoint,       // Checkpoint restoration
  getEncoderIO,         // Encoder recipe split into inputArgs/filter/outputArgs
  getCodecArgs,         // Encoder recipe as one flat arg array
  getEncoderCandidates, // Platform's encoder candidates in priority order
  validateEncoder,      // 1-frame probe of one encoder with production args
  ffmpegBin,            // Resolved ffmpeg binary (env-var aware)
  ffprobeBin,           // Resolved ffprobe binary (env-var aware)
} = require('ffmpeg-render-pro');
```

### renderParallel(options)

The main entry point. Splits a render across workers, shows a live dashboard, and produces a final MP4.

```js
const controller = new AbortController();

await renderParallel({
  workerScript: './my-worker.js',  // Your frame generator
  outputPath: './output.mp4',
  width: 1920,
  height: 1080,
  fps: 60,
  duration: 60,         // seconds
  title: 'My Render',
  autoOpen: true,       // auto-open dashboard in browser
  maxWorkers: 8,        // cap for auto worker count (override with workerCount)
  dashboardLingerMs: 0, // 0 = resolve immediately; CLI default keeps it up 30s
  signal: controller.signal, // optional: abort stops workers + cleans temp files
  quiet: false,         // true keeps stdout byte-clean (status goes to stderr)
});
```

Width and height must be even (the pipeline encodes `yuv420p`). For library use, set `dashboardLingerMs: 0` so the call resolves without holding the process open. `renderParallel` resolves with `{ outputPath, elapsed, totalFrames, avgFps }`. Set `FFMPEG_RENDER_PRO_DEBUG=1` in the environment for full stack traces from the CLI on error (library rejections carry the stack either way).

Reliability behavior baked into every render:

- **Abort**: pass an `AbortSignal` as `signal`. Calling `abort()` stops all workers, removes temp files, and rejects the promise with an error whose `name` is `'AbortError'`.
- **Quiet mode**: `quiet: true` routes all status lines to stderr and disables the terminal progress ticker, so stdout stays byte-clean for protocol use (this is how the MCP server runs). Dashboard JSON files are still written.
- **One-shot retry**: a failed worker's frame range is respawned once (to a fresh segment path) before the render is failed; a stderr warning names the worker and attempt.
- **Output verification**: after concat, one cheap ffprobe metadata read warns on stderr if the output is shorter than requested. It never fails the render and is silent when ffprobe is missing. This best-effort check looks for ffprobe on PATH only; it is the one spawn that does not consult `FFMPEG_RENDER_PRO_FFPROBE`.
- **Failure surfaces live**: on error the dashboard shows a red RENDER FAILED banner (and the browser tab title flips to FAILED) instead of freezing at the last good state.

The `workerCount` option is a request, not a guarantee: the renderer never spawns more workers than there are frames, so short renders may use fewer. Auto-detection caps at `maxWorkers` (default 8), free RAM, and CPU cores minus 2.

### Encoder Helpers

`getCodecArgs(encoder, { crf, cq, preset })` returns the full production arg array for any of the 11 supported encoders (libx264, NVENC, VideoToolbox, AMF, VA-API, QSV in H.264 and HEVC variants). For VA-API that array includes device init and a `-vf format=nv12,hwupload` pair, because the encoder cannot run without them.

`getEncoderIO(encoder, opts)` returns the same recipe split into `{ inputArgs, filter, outputArgs }`. If you build your own `-vf` chain (color grading, scaling), merge `getEncoderIO().filter` into that chain instead of passing two `-vf` flags: ffmpeg only honors the last `-vf` per stream and silently drops the others. This also applies to `colorGrade` with a VA-API codec; keep the default `libx264` for grading, or compose the invocation yourself via `getEncoderIO`.

`computeTotalFrames(fps, duration)` is the float-safe frame count the renderer itself uses (25fps x 4.6s correctly yields 115, not 114).

`ProgressTracker` accepts a `terminalStream` constructor option (default `process.stdout`; pass `null` to disable the terminal ticker while JSON keeps writing) and has a `fail(message)` method that writes a terminal `error` phase for the dashboard.

### Writing a Worker

Workers receive frame ranges via `workerData` and pipe raw BGRA frames to ffmpeg:

```js
const { workerData, parentPort } = require('worker_threads');
const { spawn } = require('child_process');

const { width, height, fps, startFrame, endFrame, segmentPath, workerId } = workerData;

async function main() {
  // Spawn ffmpeg encoder (env-var aware, falls back to PATH)
  const ffmpeg = spawn(process.env.FFMPEG_RENDER_PRO_FFMPEG || 'ffmpeg', [
    '-y', '-f', 'rawvideo', '-pixel_format', 'bgra',
    '-video_size', `${width}x${height}`, '-framerate', String(fps),
    '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    segmentPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  // Keep the last 8KB of ffmpeg stderr: it carries the error message on
  // failure, and an uncapped buffer grows unbounded on long renders.
  let stderrTail = '';
  ffmpeg.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-8192); });

  // Capture stdin errors (EPIPE when ffmpeg dies mid-pipe) and track the exit
  // from an EARLY close listener, so the final wait never attaches 'close'
  // after the event already fired (which would hang forever).
  let streamError = null;
  ffmpeg.stdin.on('error', (err) => { if (!streamError) streamError = err; });
  let closed = false;
  let closeCode = null;
  ffmpeg.on('close', (code) => { closed = true; closeCode = code; });

  const frameSize = width * height * 4; // BGRA
  const buffer = Buffer.alloc(frameSize);
  // Frames under the pipe's high-water mark can be queued BY REFERENCE even
  // when write() returns true, so small frames must be copied before writing.
  // Bigger frames keep zero-copy reuse: write() returns false and the drain
  // wait guarantees a full flush before the buffer is mutated again.
  const copyFrames = frameSize < 64 * 1024;

  for (let f = startFrame; f < endFrame; f++) {
    if (streamError || closed) {
      const cause = streamError ? streamError.message : `exited early with code ${closeCode}`;
      throw new Error(`ffmpeg encode failed (${cause}): ${stderrTail.slice(-500)}`);
    }

    renderMyFrame(f, buffer); // fill buffer with your frame data (BGRA)

    // Write with backpressure
    const ok = ffmpeg.stdin.write(copyFrames ? Buffer.from(buffer) : buffer);
    if (!ok) await new Promise((r) => ffmpeg.stdin.once('drain', r));

    // Report progress
    const done = f - startFrame + 1;
    parentPort.postMessage({
      type: 'progress', workerId,
      pct: (done / (endFrame - startFrame)) * 100,
      fps: 0, frame: done, eta: 0,
    });
  }

  // Close the encoder; resolve from captured state if it already exited.
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
```

See `examples/basic-worker.js` for the complete hardened reference worker (its drain wait also wakes on error/close, it never posts `done` after `error`, and it honors `workerData.codecArgs`). The MCP `get_worker_template` tool returns this contract plus the full reference source.

**Worker data** (injected via `worker_threads` `workerData`): `width`, `height`, `fps`, `seed`, `startFrame`, `endFrame`, `segmentPath`, `workerId`, `totalFrames`, `duration`, plus anything you pass in `renderParallel({ workerData })`.

**Messages a worker posts** to the parent via `parentPort.postMessage(...)`:

| Message | When | Fields |
|---------|------|--------|
| `{ type: 'progress' }` | periodically while encoding | `workerId`, `pct`, `fps`, `frame`, `eta` |
| `{ type: 'fast-forward-start' }` | before replaying state up to `startFrame` (optional) | `workerId`, `frames` |
| `{ type: 'done' }` | after the segment is fully written (required) | `workerId` |
| `{ type: 'error' }` | on failure | `workerId`, `error` |

Each worker writes its frame range to `segmentPath`; the renderer stream-copy concats the segments in order.

## Post-Processing API

Use these directly, or via the MCP tools (`color_grade`, `merge_audio`, `concat_videos`). Video is stream-copied where possible, so there is no quality loss.

```js
const { colorGrade, mergeAudio, concatSegments } = require('ffmpeg-render-pro');

// Color grade with a built-in preset (noir, warm, cool, cinematic, vintage)
await colorGrade({ inputPath: 'raw.mp4', outputPath: 'graded.mp4', preset: 'cinematic' });

// ...or a custom ffmpeg -vf filter chain
await colorGrade({ inputPath: 'raw.mp4', outputPath: 'graded.mp4', filter: 'eq=contrast=1.08:saturation=0.9', crf: 18 });

// Keep the soundtrack through the grade (default strips audio)
await colorGrade({ inputPath: 'final.mp4', outputPath: 'graded.mp4', preset: 'noir', keepAudio: true });

// Merge audio: video is stream-copied, audio encoded to AAC. loop + loudnorm are optional.
await mergeAudio({ videoPath: 'graded.mp4', audioPath: 'track.mp3', outputPath: 'final.mp4', bitrate: 320, loop: true, normalize: true });

// Concatenate same-codec, same-resolution segments with stream copy (instant)
await concatSegments(['part-000.mp4', 'part-001.mp4'], 'joined.mp4');

// Inputs known to be uniform by construction? Skip the ffprobe probes:
await concatSegments(['part-000.mp4', 'part-001.mp4'], 'joined.mp4', { validate: false });
```

By default `concatSegments` probes every input with ffprobe (one spawn per segment) and rejects codec, resolution, framerate, or pixel-format mismatches before ffmpeg runs, because ffmpeg itself accepts mismatched inputs and writes a silently corrupt file. Pass `{ validate: false }` to skip the probes. When ffprobe is not installed the check is skipped with a stderr warning; missing and zero-byte segments are always rejected.

## Checkpoints (Long Renders)

For multi-hour renders, pre-generate state snapshots so each worker replays only the frames since the nearest checkpoint instead of from frame 0.

```js
const { generateCheckpoints, loadCheckpoint, restoreCheckpoint } = require('ffmpeg-render-pro');

// One-time update-only pass: advance your systems and snapshot every `interval` frames
generateCheckpoints({ systems, totalFrames: 432000, fps: 60, checkpointDir: './.checkpoints', interval: 60000 });

// Inside a worker: jump to the nearest snapshot at or below startFrame
const cp = loadCheckpoint('./.checkpoints', startFrame);
if (cp) {
  const resumeFrame = restoreCheckpoint(cp, systems); // returns the snapshot's frame number
  // fast-forward systems from resumeFrame to startFrame, then render
}
```

`systems` is an object of named modules, each implementing `getState()` and `setState()` (plus `update(dt)` for `generateCheckpoints`). The keys `_frame` and `_timestamp` are reserved checkpoint metadata; do not name a system either of those.

A checkpoint labeled frame F contains exactly F `update()` calls, matching the fast-forward convention above. Checkpoints written before 1.5.0 embedded one extra update (state one frame ahead); regenerate old checkpoint dirs to restore the identical-to-sequential guarantee. The file format itself is unchanged.

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
| `ffmpeg-bin` | ffmpeg/ffprobe binary resolution (env-var aware) |

## Benchmarks

Run your own:

```bash
node examples/render-test.js --duration=5
node examples/render-test.js --duration=30
node examples/render-test.js --duration=60 --width=1080 --height=1920
```

## Tests

```bash
npm test           # smoke suite + MCP suite + end-to-end renders
npm run test:smoke # smoke suite only
npm run test:mcp   # MCP server suite only
npm run test:e2e   # real renders verified with ffprobe + framemd5

# Focused unit suites (zero-dependency, run directly):
node test/checkpoint.test.js   # checkpoint save/load/restore + off-by-one regression
node test/concat.test.js       # validation, quoting (spaces/apostrophes), list-file paths
node test/gpu-detect.test.js   # cache lifecycle + codec args for all 11 encoders
node test/dashboard.test.js    # HTTP server + ProgressTracker JSON contract
node test/cli.test.js          # flag parsing and validation
node test/ffmpeg-bin.test.js   # FFMPEG_RENDER_PRO_FFMPEG / _FFPROBE resolution
node test/renderer.test.js     # failure injection: worker error/throw/silent-exit/retry/abort
node test/encoder.test.js      # createEncoder backpressure + error paths
node test/audio-merge.test.js  # mergeAudio loop/normalize paths
```

A zero-dependency suite, 241 tests across 12 files (81 in 1.4.0). Coverage includes module exports, input validation, dashboard path-safety (traversal + null-byte + double-encoding vectors), checkpoint semantics, concat validation, GPU cache lifecycle, CLI parsing, env-var binary resolution, renderer failure injection (including quiet-stdout hygiene), and encoder backpressure. The MCP suite runs 22 checks including a real render over stdio, progress notifications, a full stdout protocol-hygiene audit, and server.json drift guards. The e2e suite renders real videos and checks codec, dimensions, exact frame counts, seed determinism (seed 0 byte-identical across runs via `framemd5`, seed 1 differs), concat, color grades, and audio merges; it skips itself cleanly on machines without ffmpeg. CI runs the suite on Ubuntu, Windows, and macOS against Node 18, 20, and 22 with real ffmpeg installs.

## MCP Server

ffmpeg-render-pro includes a Model Context Protocol (MCP) server with 7 tools. Works with Claude Code, Claude Desktop, and any MCP client.

### Add to Claude Code

```bash
# After `npm install -g ffmpeg-render-pro` the MCP binary is on your PATH:
claude mcp add --transport stdio ffmpeg-render-pro -- ffmpeg-render-pro-mcp

# Or without global install (uses npx):
claude mcp add --transport stdio ffmpeg-render-pro -- npx --yes --package=ffmpeg-render-pro ffmpeg-render-pro-mcp
```

### Add to Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ffmpeg-render-pro": {
      "command": "ffmpeg-render-pro-mcp"
    }
  }
}
```

Or, if you prefer not to install globally:

```json
{
  "mcpServers": {
    "ffmpeg-render-pro": {
      "command": "npx",
      "args": ["--yes", "--package=ffmpeg-render-pro", "ffmpeg-render-pro-mcp"]
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `detect_gpu` | Probe hardware encoders (NVENC, VideoToolbox, AMF, VA-API, QSV) |
| `system_info` | Show CPU cores, RAM, recommended workers, ffmpeg version |
| `render_video` | Parallel render with live dashboard, progress notifications, and cancellation |
| `get_worker_template` | Return the worker contract plus the bundled reference worker source |
| `color_grade` | Apply presets (noir, warm, cool, cinematic, vintage) or custom filters |
| `merge_audio` | Combine video + audio with loudness normalization |
| `concat_videos` | Stream-copy join multiple videos (instant, no re-encode), validated by default |

Each tool's full input schema (parameter names, types, defaults, runtime min/max limits) is advertised at runtime via `tools/list`. Every tool also declares an `outputSchema` and returns `structuredContent` alongside its text, so results parse as typed JSON without regex. Annotations mark the four writers (`render_video`, `color_grade`, `merge_audio`, `concat_videos`) as destructive (they overwrite `output_path` if it exists) and the three probes as read-only.

Behavior worth knowing when wiring an agent:

- **Progress notifications**: when the client sends a `progressToken`, `render_video` emits `notifications/progress` every 2 seconds plus start and end frames. Clients should enable `resetTimeoutOnProgress` so long renders do not hit request timeouts.
- **Cancellation**: client-side cancellation aborts the render cleanly; workers stop and temp files are removed.
- **fps default**: `render_video` defaults to 30 fps; the CLI `render` command defaults to 60.
- **GPU probe caching**: probe results are cached for 7 days in `~/.ffmpeg-render-pro` (override the directory with `FFMPEG_RENDER_PRO_CACHE_DIR`). `detect_gpu` re-probes on every call and refreshes the cache; `system_info` reads the cached result.
- **Protocol hygiene**: stdout carries only JSON-RPC frames; all library and console output is routed to stderr, and renders run in quiet mode automatically.
- **Missing ffmpeg**: every tool that needs ffmpeg returns an actionable error naming the install page and the `FFMPEG_RENDER_PRO_FFMPEG` env var instead of a raw spawn error (`get_worker_template` works without ffmpeg).

## For AI Agents

Wire the server in with the `claude mcp add` one-liners or the Claude Desktop JSON above. Then the working recipe is:

1. `detect_gpu` to confirm hardware acceleration (optional; each call re-probes and refreshes the 7-day cache).
2. `get_worker_template` to fetch the worker contract and the bundled reference worker. Its `templatePath` is directly usable as `worker_script` for a test scene, or write a custom worker against the returned contract.
3. `render_video` with `dashboard: false` and `auto_open: false` for headless runs (stdout hygiene is automatic). Pass a `progressToken` for live progress.
4. `color_grade` and/or `merge_audio` for post-processing.
5. `concat_videos` to join multiple outputs (validation is on by default).

Every response includes `structuredContent` matching the tool's `outputSchema`, so parse the JSON instead of scraping text. The npm tarball ships a ready-made Claude Code skill (see the next section for the copy path) and an `llms.txt` orientation file at the package root for agent consumption.

## Claude Code Skill

This package includes a ready-to-use Claude Code skill (shipped in the npm tarball as well as the repo). To install it, copy the skill folder into your Claude skills directory:

```bash
# From a repo clone (macOS / Linux)
cp -r .claude/skills/ffmpeg-render-pipeline ~/.claude/skills/

# From a repo clone (Windows)
xcopy .claude\skills\ffmpeg-render-pipeline %USERPROFILE%\.claude\skills\ffmpeg-render-pipeline\ /E /I

# From a global npm install (macOS / Linux)
cp -r "$(npm root -g)/ffmpeg-render-pro/.claude/skills/ffmpeg-render-pipeline" ~/.claude/skills/
```

Once installed, Claude Code will automatically use the skill when you ask it to render video or audio with ffmpeg.

## Security Notes

- **Dashboard server binds to `127.0.0.1` only.** It is never reachable from other machines on your network.
- **No telemetry, no phone-home, no CDN loads.** Dashboard runs entirely from local files using system fonts.
- **MCP server is a local-filesystem tool.** When wired into an AI agent, it will render, read, and write files anywhere the current user has access. Treat it like any other filesystem-enabled tool: only run it with a trusted agent, and consider restricting the process's working directory if you use it with untrusted prompts.
- **`render_video` executes the given worker script with the full privileges of the current user.** A worker script is arbitrary Node code running in a worker thread; only run worker scripts you wrote or trust. The same applies to `renderParallel` in library use.
- **Custom filter strings are file access.** ffmpeg `-vf` filters can read local files through sources like `movie=` and `subtitles=`, so a custom `filter` passed to `color_grade`/`colorGrade` can reference files on disk. Treat filter input from untrusted agents or users the same way you would treat a file path.
- **Stream-copy concat uses temp files under `os.tmpdir()`.** Output paths you pass are still written as-is, so make sure your output path is where you want it.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## License

MIT

## Author

[Beeswax Pat](https://github.com/beeswaxpat)
