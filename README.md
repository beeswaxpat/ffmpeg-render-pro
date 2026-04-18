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

Parallel video rendering with live dashboard, GPU auto-detection, checkpoint system, and stream-copy concat. The most powerful free ffmpeg rendering toolkit.

Built by [Beeswax Pat](https://github.com/beeswaxpat) with [Claude Code](https://claude.ai/claude-code) · Free and open source forever

## Features

- **Parallel rendering** — Split frames across N worker threads, concat with zero re-encoding
- **GPU auto-detection** — Probes NVENC, VideoToolbox, AMF, VA-API, QSV with 1-frame validation
- **Live dashboard** — Auto-opens in your browser with per-worker progress, FPS chart, ETA
- **Checkpoint system** — 93% reduction in fast-forward overhead for long renders
- **Color grading** — 5 built-in presets (noir, warm, cool, cinematic, vintage) + custom filters
- **Audio merge** — Combine video + audio with loudness normalization, no video re-encode
- **Deterministic output** — Seeded RNG ensures parallel workers produce identical results to sequential
- **MCP server** — Model Context Protocol server with 6 tools, works with Claude Code, Claude Desktop, and any MCP client
- **Cross-platform** — Windows, macOS, Linux. Any GPU or CPU-only. Requires Node.js >= 18 + ffmpeg.

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

## Tests

```bash
npm test
```

A zero-dependency smoke suite covering module exports, input validation, dashboard path-safety (traversal + null-byte + double-encoding vectors), checkpoint round-trip, and MCP server stdio handshake.

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
- **Stream-copy concat uses temp files under `os.tmpdir()`.** Output paths you pass are still written as-is — make sure your output path is where you want it.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes. Latest: **v1.2.0** — hardening pass (critical dashboard fix, path-traversal defense, performance improvements).

## License

MIT

## Author

[Beeswax Pat](https://github.com/beeswaxpat)
