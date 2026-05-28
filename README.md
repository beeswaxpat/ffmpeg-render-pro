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

Built by [Beeswax Pat](https://github.com/beeswaxpat) with [Claude Code](https://claude.ai/claude-code) · Free and open source forever

## Features

- **Parallel rendering**: Split frames across N worker threads, concat with zero re-encoding
- **GPU auto-detection**: Probes NVENC, VideoToolbox, AMF, VA-API, QSV with 1-frame validation
- **Live dashboard**: Auto-opens in your browser with per-worker progress, FPS chart, ETA
- **Checkpoint system**: 93% reduction in fast-forward overhead for long renders
- **Color grading**: 5 built-in presets (noir, warm, cool, cinematic, vintage) plus custom filters
- **Audio merge**: Combine video + audio with loudness normalization, no video re-encode
- **Deterministic output**: Seeded RNG ensures parallel workers produce identical results to sequential
- **MCP server**: Model Context Protocol server with 6 tools, works with Claude Code, Claude Desktop, and any MCP client
- **Cross-platform**: Windows, macOS, Linux. Any GPU or CPU-only. Requires Node.js >= 18 plus ffmpeg.

## What's new in v1.3.0

An Opus 4.8 review pass. Fully backward-compatible, no worker scripts or MCP integrations need changes.

- Accurate worker count on small renders (no more idle "phantom" worker cards)
- Even-dimension guard with a clear error up front (`yuv420p` needs even width and height)
- `dashboardLingerMs` option so library calls can return immediately instead of holding the process open for 30s
- `concatSegments` validates that every segment exists and is non-empty before joining
- New `maxWorkers` / `--max-workers`, a `version` command, and full HEVC codec-arg coverage
- MCP `render_video` gains `dashboard` / `auto_open` flags for headless use
- `npm test` now runs the smoke suite and the MCP handshake; 39 to 49 tests

See [CHANGELOG.md](CHANGELOG.md) for the complete list.

## Requirements

- **Node.js** >= 18
- **ffmpeg** installed and on PATH

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
  duration: 60,         // seconds
  title: 'My Render',
  autoOpen: true,       // auto-open dashboard in browser
  maxWorkers: 8,        // cap for auto worker count (override with workerCount)
  dashboardLingerMs: 0, // 0 = resolve immediately; CLI default keeps it up 30s
});
```

Width and height must be even (the pipeline encodes `yuv420p`). For library use, set `dashboardLingerMs: 0` so the call resolves without holding the process open. `renderParallel` resolves with `{ outputPath, elapsed, totalFrames }`. Set `FFMPEG_RENDER_PRO_DEBUG=1` in the environment for full stack traces on error.

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

**Worker data** (injected via `worker_threads` `workerData`): `width`, `height`, `fps`, `seed`, `startFrame`, `endFrame`, `segmentPath`, `workerId`, `totalFrames`, `duration`, plus anything you pass in `renderParallel({ workerData })`.

**Messages a worker posts** to the parent via `parentPort.postMessage(...)`:

| Message | When | Fields |
|---------|------|--------|
| `{ type: 'progress' }` | periodically while encoding | `workerId`, `pct`, `fps`, `frame`, `eta` |
| `{ type: 'fast-forward-start' }` | before replaying state up to `startFrame` (optional) | `workerId`, `frames` |
| `{ type: 'done' }` | after the segment is fully written (required) | `workerId` |
| `{ type: 'error' }` | on failure | `workerId`, `error` |

Each worker writes its frame range to `segmentPath`; the renderer stream-copy concats the segments in order.

## Post-processing API

Use these directly, or via the CLI and MCP tools. Video is stream-copied where possible, so there is no quality loss.

```js
const { colorGrade, mergeAudio, concatSegments } = require('ffmpeg-render-pro');

// Color grade with a built-in preset (noir, warm, cool, cinematic, vintage)
await colorGrade({ inputPath: 'raw.mp4', outputPath: 'graded.mp4', preset: 'cinematic' });

// ...or a custom ffmpeg -vf filter chain
await colorGrade({ inputPath: 'raw.mp4', outputPath: 'graded.mp4', filter: 'eq=contrast=1.08:saturation=0.9', crf: 18 });

// Merge audio: video is stream-copied, audio encoded to AAC. loop + loudnorm are optional.
await mergeAudio({ videoPath: 'graded.mp4', audioPath: 'track.mp3', outputPath: 'final.mp4', bitrate: 320, loop: true, normalize: true });

// Concatenate same-codec, same-resolution segments with stream copy (instant)
await concatSegments(['part-000.mp4', 'part-001.mp4'], 'joined.mp4');
```

## Checkpoints (long renders)

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

`systems` is an object of named modules, each implementing `getState()` and `setState()` (plus `update(dt)` for `generateCheckpoints`).

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

## Tests

```bash
npm test          # smoke suite + MCP stdio handshake
npm run test:smoke # smoke suite only
npm run test:mcp   # MCP server handshake only
```

A zero-dependency suite covering module exports, input validation (including odd-dimension and worker-count math), dashboard path-safety (traversal + null-byte + double-encoding vectors), checkpoint round-trip, and the MCP server stdio handshake. `npm test` runs both the smoke suite and the MCP server test.

## MCP Server

ffmpeg-render-pro includes a Model Context Protocol (MCP) server with 6 tools. Works with Claude Code, Claude Desktop, and any MCP client.

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
| `render_video` | Parallel render with live dashboard |
| `color_grade` | Apply presets (noir, warm, cool, cinematic, vintage) or custom filters |
| `merge_audio` | Combine video + audio with loudness normalization |
| `concat_videos` | Stream-copy join multiple videos (instant, no re-encode) |

Each tool's full input schema (parameter names, types, defaults) is advertised by the server at runtime via the MCP `tools/list` method, so an agent can introspect it directly. `render_video` also accepts `dashboard` and `auto_open` booleans for headless use.

## Claude Code Skill

This repo includes a ready-to-use [Claude Code](https://claude.ai/claude-code) skill. To install it, copy the skill folder into your Claude skills directory:

```bash
# macOS / Linux
cp -r .claude/skills/ffmpeg-render-pipeline ~/.claude/skills/

# Windows
xcopy .claude\skills\ffmpeg-render-pipeline %USERPROFILE%\.claude\skills\ffmpeg-render-pipeline\ /E /I
```

Once installed, Claude Code will automatically use the skill when you ask it to render video or audio with ffmpeg.

## Security Notes

- **Dashboard server binds to `127.0.0.1` only.** It is never reachable from other machines on your network.
- **No telemetry, no phone-home, no CDN loads.** Dashboard runs entirely from local files using system fonts.
- **MCP server is a local-filesystem tool.** When wired into an AI agent, it will render, read, and write files anywhere the current user has access. Treat it like any other filesystem-enabled tool: only run it with a trusted agent, and consider restricting the process's working directory if you use it with untrusted prompts.
- **Stream-copy concat uses temp files under `os.tmpdir()`.** Output paths you pass are still written as-is, so make sure your output path is where you want it.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes. Latest: **v1.3.0** (review pass: phantom-worker fix, even-dimension guard, configurable dashboard linger, segment validation, HEVC codec args, `version` command).

## License

MIT

## Author

[Beeswax Pat](https://github.com/beeswaxpat)
