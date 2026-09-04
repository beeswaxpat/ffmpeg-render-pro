![ffmpeg-render-pro](https://raw.githubusercontent.com/beeswaxpat/ffmpeg-render-pro/main/assets/banner.svg)

# ffmpeg-render-pro

[![npm version](https://img.shields.io/npm/v/ffmpeg-render-pro.svg)](https://www.npmjs.com/package/ffmpeg-render-pro)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Cross-platform](https://img.shields.io/badge/Platform-Win%20%7C%20Mac%20%7C%20Linux-brightgreen)](https://github.com/beeswaxpat/ffmpeg-render-pro)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP Server](https://img.shields.io/badge/MCP-Server-purple)](https://modelcontextprotocol.io)

Render video from code, in parallel. You write one function that paints a frame; ffmpeg-render-pro splits the frame range across worker threads, encodes one MP4 segment per worker, joins the segments with stream copy (no re-encode), and shows a live dashboard in your browser while it runs. It also detects GPU encoders, grades color, merges audio, and ships as a CLI, a Node library, an MCP server for AI agents, and a Claude Code skill.

Built by [Beeswax Pat](https://github.com/beeswaxpat). Free and open source.

## Start here

Three commands. You need Node.js 18 or newer and [ffmpeg](https://ffmpeg.org/download.html) on your PATH.

```bash
# 1. Prove the setup works: a 5 second test render. The dashboard opens in your browser.
npx ffmpeg-render-pro benchmark

# 2. Write a starter worker script into the current folder.
npx ffmpeg-render-pro init my-worker.js

# 3. Render it. Output lands in output.mp4.
npx ffmpeg-render-pro render my-worker.js --duration=5
```

Open `my-worker.js`. The only function you need to change is `renderFrame(frameNum, buffer)`: fill the buffer with your pixels (B, G, R, A, one row after another) and everything else is already done. Derive any randomness from the `seed` it receives and parallel output stays identical to a sequential render.

Install it globally if you would rather not type `npx`:

```bash
npm install -g ffmpeg-render-pro
```

## Using an ffmpeg that is not on PATH

```bash
FFMPEG_RENDER_PRO_FFMPEG=/opt/ffmpeg/bin/ffmpeg     # ffmpeg binary
FFMPEG_RENDER_PRO_FFPROBE=/opt/ffmpeg/bin/ffprobe   # optional; the sibling ffprobe is found automatically
FFMPEG_RENDER_PRO_CACHE_DIR=~/.ffmpeg-render-pro    # optional; where GPU probe results are cached
```

The variables are read at call time, so a long-running process such as the MCP server picks up changes without a restart.

## CLI

```bash
ffmpeg-render-pro init [my-worker.js]   # write the starter worker (--force overwrites)
ffmpeg-render-pro benchmark             # 5 second test render with the bundled worker
ffmpeg-render-pro render <worker.js>    # render with your worker
ffmpeg-render-pro info                  # cores, RAM, recommended workers, ffmpeg version, GPU
ffmpeg-render-pro detect-gpu            # probe hardware encoders (--cpu / --gpu force a mode)
ffmpeg-render-pro version
```

Render and benchmark flags: `--width=1920 --height=1080` (must be even), `--fps=60`, `--duration=60` (fractions allowed), `--output=out.mp4`, `--workers=N`, `--max-workers=8`, `--seed=42`, `--title="..."`, `--crf=20` (0-51, lower is higher quality), `--encoder-preset=fast` (any x264 preset). Dashboard flags: `--no-dashboard`, `--no-open`, `--port=8080`, `--linger-ms=30000` (`0` exits as soon as the render finishes). Run `ffmpeg-render-pro` with no arguments for the full list.

An unknown flag warns and continues. A value that does not parse, such as `--fps=abc`, exits 1 instead of rendering at the default.

Installed binaries: `ffmpeg-render-pro` (this CLI) and `ffmpeg-render-pro-mcp` (the MCP server). The older `ffmpeg-render-mcp` name still works so existing MCP configs never break.

## How a render works

1. `renderParallel` checks ffmpeg, validates the resolution, and picks a worker count from your CPU cores and RAM (never more workers than frames).
2. It starts the dashboard server on `127.0.0.1` and opens your browser.
3. Each worker thread runs your script with a frame range in `workerData`, pipes raw BGRA frames into its own ffmpeg process, and writes one MP4 segment.
4. Segments are joined with the concat demuxer and `-c copy`, which takes seconds regardless of length.
5. Temp files are removed. A failed worker's range is retried once before the render fails.

## Your worker

A worker is a Node script that runs in a `worker_threads` thread. `init` gives you one where only `renderFrame` needs editing; `examples/basic-worker.js` in the installed package is a larger reference with a particle system and seeded RNG.

Fields the renderer injects through `workerData`:

| Field | Meaning |
|---|---|
| `width`, `height`, `fps` | Frame size and rate |
| `seed` | Derive every random value from this |
| `startFrame`, `endFrame` | Render exactly `[startFrame, endFrame)` |
| `segmentPath` | Write this worker's MP4 here |
| `workerId` | Include it in every message you post |
| `totalFrames`, `duration` | Whole-video totals, for global effects such as a progress bar |
| anything in `renderParallel({ workerData })` | Your own extra keys (the bundled workers honor `codecArgs`) |

Messages the worker posts with `parentPort.postMessage`:

| Message | When | Fields |
|---|---|---|
| `{ type: 'progress' }` | periodically | `workerId`, `pct`, `fps`, `frame`, `eta` |
| `{ type: 'fast-forward-start' }` | optional, before replaying state to reach `startFrame` | `workerId`, `frames` |
| `{ type: 'done' }` | once, after the segment is fully written | `workerId` |
| `{ type: 'error' }` | on failure, never followed by `done` | `workerId`, `error` |

Every worker must encode with the same codec, resolution, framerate, and pixel format, because the segments are stream-copied together.

## Library

```js
const {
  renderParallel,       // the render engine
  createEncoder,        // pipe raw frames into ffmpeg with backpressure
  detectGPU,            // hardware encoder discovery, cached 7 days
  getConfig,            // worker count and codec choice for a resolution
  computeTotalFrames,   // float-safe fps x duration
  concatSegments,       // stream-copy join (validates inputs by default)
  colorGrade,           // presets or a custom -vf chain
  mergeAudio,           // add a soundtrack without re-encoding video
  startDashboard,       // the local progress server
  ProgressTracker,      // per-worker progress plus dashboard JSON
  saveCheckpoint, loadCheckpoint, restoreCheckpoint, generateCheckpoints,
  getEncoderIO,         // encoder recipe as { inputArgs, filter, outputArgs }
  getCodecArgs,         // the same recipe as one flat array
  ffmpegBin, ffprobeBin // resolved binaries, env-var aware
} = require('ffmpeg-render-pro');
```

### renderParallel(options)

```js
const controller = new AbortController();

const result = await renderParallel({
  workerScript: './my-worker.js',   // required
  outputPath: './output.mp4',       // required
  width: 1920, height: 1080,        // even numbers, up to 7680x4320
  fps: 60, duration: 60,
  seed: 42,
  title: 'My Render',               // shown in the dashboard
  workerCount: undefined,           // exact count; omit to auto-detect
  maxWorkers: 8,                    // cap for auto-detect
  dashboard: true, autoOpen: true, dashboardPort: 8080,
  dashboardLingerMs: 0,             // 0 resolves as soon as the render ends (the CLI keeps it up 30s)
  quiet: false,                     // true keeps stdout byte-clean; status goes to stderr
  signal: controller.signal,        // abort() stops workers and removes temp files
  workerData: {},                   // extra keys for your worker
});
// result: { outputPath, elapsed, totalFrames, avgFps }
```

Abort rejects with an error whose `name` is `'AbortError'`. In library use set `dashboardLingerMs: 0` so the call returns without holding the process open. Set `FFMPEG_RENDER_PRO_DEBUG=1` for full stack traces from the CLI.

### Post-processing

```js
// Color grade with a preset (noir, warm, cool, cinematic, vintage) or a custom -vf chain
await colorGrade({ inputPath: 'raw.mp4', outputPath: 'graded.mp4', preset: 'cinematic' });
await colorGrade({ inputPath: 'raw.mp4', outputPath: 'graded.mp4', filter: 'eq=contrast=1.08:saturation=0.9', crf: 18 });
await colorGrade({ inputPath: 'final.mp4', outputPath: 'graded.mp4', preset: 'noir', keepAudio: true }); // default strips audio

// Merge audio: video is stream-copied, audio becomes AAC. loop and normalize (loudnorm) are optional.
await mergeAudio({ videoPath: 'graded.mp4', audioPath: 'track.mp3', outputPath: 'final.mp4', bitrate: 320, loop: true, normalize: true });

// Join same-codec, same-size videos with stream copy. Inputs are probed with ffprobe first; pass { validate: false } to skip.
await concatSegments(['part-000.mp4', 'part-001.mp4'], 'joined.mp4');
```

`colorGrade` accepts any encoder name in `codec`; encoders that need their own filter (VA-API) get it merged into the grade chain automatically.

### Checkpoints for long renders

For multi-hour renders, snapshot your simulation state every N frames once, so each worker replays only the frames since the nearest snapshot instead of starting from frame 0.

```js
generateCheckpoints({ systems, totalFrames: 432000, fps: 60, checkpointDir: './.checkpoints', interval: 60000 });

// inside a worker
const cp = loadCheckpoint('./.checkpoints', startFrame);
if (cp) {
  const resumeFrame = restoreCheckpoint(cp, systems);
  // fast-forward from resumeFrame to startFrame, then render
}
```

`systems` is an object of named modules with `getState()`, `setState()`, and `update(dt)`. A checkpoint labeled frame F holds exactly F updates. `_frame` and `_timestamp` are reserved keys.

## MCP server (for AI agents)

Seven tools over stdio, usable from Claude Code, Claude Desktop, or any MCP client.

```bash
# Claude Code, no install needed
claude mcp add --transport stdio ffmpeg-render-pro -- npx --yes --package=ffmpeg-render-pro ffmpeg-render-pro-mcp

# Claude Code, after npm install -g ffmpeg-render-pro
claude mcp add --transport stdio ffmpeg-render-pro -- ffmpeg-render-pro-mcp
```

Claude Desktop (`claude_desktop_config.json`):

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

| Tool | What it does |
|---|---|
| `get_worker_template` | Returns the worker contract, the starter worker source, and paths to both bundled workers. Start here. |
| `render_video` | Parallel render from a worker script, with progress notifications and cancellation |
| `detect_gpu` | Probe hardware encoders (NVENC, VideoToolbox, AMF, VA-API, QSV) |
| `system_info` | Cores, RAM, recommended worker count, ffmpeg version |
| `color_grade` | Presets or a custom filter |
| `merge_audio` | Add a soundtrack, video stream-copied |
| `concat_videos` | Stream-copy join, inputs validated by default |

The agent recipe: call `get_worker_template`, copy `starterSource` to a file and replace `renderFrame`, then call `render_video` with that file as `worker_script` (`dashboard: false`, `auto_open: false` for headless runs). To render without writing code, pass the returned `starterPath` or `templatePath` straight to `render_video`. Post-process with `color_grade`, `merge_audio`, and `concat_videos`.

Every tool declares an `outputSchema` and returns `structuredContent`, so parse JSON instead of text. Writers overwrite `output_path`. `render_video` defaults to 30 fps (the CLI defaults to 60), emits `notifications/progress` every 2 seconds when the client sends a `progressToken` (turn on `resetTimeoutOnProgress` for long renders), and stops all workers on client cancellation. stdout carries only JSON-RPC frames. Missing ffmpeg returns an error that names the install page and the env var.

The tarball also ships `llms.txt` at the package root and a Claude Code skill:

```bash
# from a global install (macOS / Linux)
cp -r "$(npm root -g)/ffmpeg-render-pro/.claude/skills/ffmpeg-render-pipeline" ~/.claude/skills/
# from a repo clone (Windows)
xcopy .claude\skills\ffmpeg-render-pipeline %USERPROFILE%\.claude\skills\ffmpeg-render-pipeline\ /E /I
```

## NVENC quick reference

The renderer detects NVENC by itself. For one-off encodes outside it:

```bash
# confirm the encoder exists before relying on it
ffmpeg -y -f lavfi -i testsrc=size=256x256:rate=30:d=1 -c:v h264_nvenc -cq 23 probe.mp4

# encode: presets p1 (fastest) to p7 (best); -cq works like CRF, lower is better
ffmpeg -i in.mp4 -c:v h264_nvenc -preset p5 -cq 21 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart out.mp4
```

`h264_nvenc` rejects very narrow frames (145px minimum on a Turing card) by writing a zero-byte file and exiting, so keep probes at 256x256. Both commands come from the [ffmpeg Render Cookbook](https://store.chronoverify.com/l/ffmpeg-render-cookbook?utm_source=npm&utm_medium=npm&utm_campaign=ffmpeg-render-cookbook) ($12): 29 recipes, each run on ffmpeg 8.0.1 before publication.

## Security notes

- Releases are published to npm by GitHub Actions through npm trusted publishing (OIDC). There is no publish token, and every version from 1.5.2 on carries a provenance attestation that ties the tarball on npm to the exact commit and workflow run that built it (see the Provenance panel on the npm page).
- The dashboard binds to `127.0.0.1` only and loads nothing from the network. No telemetry.
- `render_video` and `renderParallel` execute the worker script you name with the privileges of the current user. Only run workers you wrote or trust.
- The MCP server reads and writes files anywhere the current user can. Run it with a trusted agent, and consider restricting its working directory when prompts are untrusted.
- A custom `filter` string is file access: ffmpeg filters such as `movie=` and `subtitles=` read local files. Treat filter input the way you treat a file path.
- Concat list files are written under `os.tmpdir()`; output paths are written exactly where you point them.

## Tests

`npm test` runs 12 zero-dependency suites (255 checks): unit, smoke, a real MCP session over stdio with a byte audit of stdout, and end-to-end renders verified with ffprobe and `framemd5`. It skips the render suites cleanly on machines without ffmpeg. CI runs the same on Ubuntu, Windows, and macOS against Node 18, 20, 22, and 24.

## Changelog and license

See [CHANGELOG.md](CHANGELOG.md). MIT.
