# Changelog

All notable changes to `ffmpeg-render-pro` are documented in this file.
This project follows [Semantic Versioning](https://semver.org/).

## [1.4.0] - 2026-07-03

A Claude Fable 5 review pass: GPU detection fixed on modern ffmpeg, faster frame generation, and new dashboard controls. Fully backward-compatible: every CLI command, API signature, MCP tool name, and worker contract from 1.3.x works unchanged.

### Fixed (the important one)

- **GPU encoders were reported as unavailable on healthy NVIDIA systems.** The 1-frame validation encode probed at 64x64, which is below H.264 NVENC's minimum resolution (145px wide), so the probe failed with `Invalid argument` and every render silently fell back to CPU. The probe now uses 256x256, which clears every known hardware minimum. Verified on a GTX 1660 SUPER with ffmpeg 8.0.1: 1.3.2 reported "NO (CPU fallback)", 1.4.0 detects both `h264_nvenc` and `hevc_nvenc`. The detection cache carries a schema version now, so upgraded installs re-probe immediately instead of trusting up to 7 days of cached false negatives.

### Fixed (correctness)

- **Concurrent renders into the same output directory no longer collide.** The segment temp dir was a fixed `.parallel-temp` name, so two simultaneous renders overwrote each other's segments and deleted each other's temp dir. Each render now gets a random-suffixed temp dir, and stale dirs left by hard-killed renders are swept once they are over a day old.
- **`mergeAudio` now maps streams explicitly.** Without `-map`, ffmpeg's default stream selection picks the audio track with the most channels across ALL inputs, so merging new audio into a video that already had audio could silently keep the old track. The new track always wins now (covered by an e2e test that fails against 1.3.2).
- **`dashboard: false` renders no longer scribble on the terminal.** The progress tracker's stop path redrew worker bars with cursor-up escapes even when the ticker never started, overwriting unrelated console output in library use. It also no longer writes `preview/*.json` files nobody serves.
- **A corrupted checkpoint file no longer crashes the render.** `loadCheckpoint` skips unparseable files and falls back to the next-nearest checkpoint, or to a full fast-forward.
- **CLI flag edge cases**: `--seed=0` is honored instead of silently becoming 42, `--duration=2.5` keeps its fraction instead of truncating to 2, and `--output` with no value falls back to the default instead of crashing.

### Performance

- **Example worker frame generation is 3.1x faster** (13.1ms to 4.2ms per 1080p frame, measured single-threaded). The background and progress bar are painted with native `Uint32Array.fill` span writes instead of 4 byte writes per pixel, and the per-bar sine term is hoisted out of the row loop. Output is byte-identical to 1.3.x (verified with `framemd5`), so seeded renders reproduce exactly across versions. Wall-clock gains depend on your bottleneck: when all cores are saturated by x264 encoding, generation speed is not the limit; with fewer workers or hardware encoders it is.
- **The ffmpeg availability check is memoized per process.** A single render invoked `ffmpeg -version` up to four times (renderer preflight, cache validation, cache save, CLI banner) at 100-300ms per spawn on Windows.

### Added

- **CLI dashboard flags** on `render` and `benchmark`: `--no-dashboard`, `--no-open`, `--port=N`, and `--linger-ms=N` (0 exits immediately after the render).
- **`benchmark` accepts `--workers=N`** (previously ignored).
- **`colorGrade` gains `keepAudio`** (default false, matching the old strip-audio behavior): stream-copies the input's audio track through the grade.
- **MCP `render_video` gains `max_workers`, `dashboard_port`, and `linger_ms`; `color_grade` gains `crf` and `keep_audio`.** All optional; existing calls are unaffected. `detect_gpu` and `system_info` now carry `readOnlyHint` annotations.
- **`renderParallel` resolves with `avgFps`** alongside `outputPath`, `elapsed`, and `totalFrames`.
- **Example worker accepts `workerData.codecArgs`** to override the segment encoder args (the default is unchanged: `libx264 -preset fast -crf 20`).
- **`mergeAudio` and `colorGrade` validate their path arguments** and fail with a clear message before spawning ffmpeg.
- **MCP registry metadata**: `mcpName` in package.json, a `server.json` manifest, `glama.json`, and a GitHub Actions workflow that publishes to the official MCP Registry on version tags.

### Meta

- **New end-to-end suite (`npm run test:e2e`, included in `npm test`)**: real parallel renders probed with ffprobe (codec, dimensions, exact frame count), same-seed determinism via `framemd5`, stream-copy concat, color grade presets, the audio-replacement case, keep-audio and strip-audio grades, CLI invocations, and the stale temp-dir sweep. Skips cleanly when ffmpeg is not installed.
- Dashboard page: worker cards build in one DOM write, HTML is served with `Cache-Control: no-cache` so package updates are not shadowed by a stale browser cache, and the tab has a favicon instead of a 404.
- 49 tests grew to 81 (57 smoke, 8 MCP, 16 e2e).

## [1.3.2] - 2026-05-28

Documentation only.

- Removed two dead `claude.ai/claude-code` links from the README (they returned 404). Functional references to Claude Code and Claude Desktop as MCP clients are unchanged.
- De-versioned the README changelog pointer so it no longer goes stale on each release.

## [1.3.1] - 2026-05-28

Documentation only. No code changes; the published API is identical to 1.3.0.

- README is now a complete standalone reference for both human and agent use. Added: the full worker contract (every `workerData` field plus the worker-to-parent message protocol), a Post-processing API section (`colorGrade`, `mergeAudio`, `concatSegments` signatures), a Checkpoints example for long renders, the `renderParallel` return shape, the `FFMPEG_RENDER_PRO_DEBUG` env var, a note that MCP tool schemas are introspectable at runtime, and a "What's new" summary.

## [1.3.0] - 2026-05-28

An Opus 4.8 review pass: correctness, robustness, and developer experience.
Fully backward-compatible. No worker scripts or MCP integrations need changes.

### Fixed (Correctness)

- **Phantom worker count on small renders.** `ceil()` frame chunking could leave trailing workers with zero frames (for example, 10 frames across 8 requested workers spawns only 5). The console banner, progress tracker, and dashboard were still initialized with the requested count, leaving idle "Waiting" cards and a misleading "N workers" line. The renderer now derives the true worker count from the actual chunk size via a new `planWorkers()` helper.
- **Odd dimensions failed deep inside a worker.** The pipeline encodes `yuv420p`, which requires even width and height. Passing an odd dimension (for example, `1921x1080`) produced a cryptic `height not divisible by 2` error from ffmpeg. `renderParallel` now rejects odd dimensions up front with a clear message and a suggested even resolution.
- **`renderParallel` now validates `outputPath`.** A missing or non-string `outputPath` previously threw an opaque `path.resolve` error; it now fails with a clear message.
- **Dashboard server leaked its port-scan error listener.** The retry handler registered during port selection was never removed on success, so a later runtime error could re-enter the listen loop on an already-bound socket. It is now removed once listening succeeds.
- **`getCodecArgs` covers every HEVC encoder.** `hevc_videotoolbox`, `hevc_amf`, `hevc_vaapi`, and `hevc_qsv` previously fell through to the libx264 argument path (which those encoders reject). Each now returns correct arguments and tags `hvc1`.

### Added

- **`dashboardLingerMs` option on `renderParallel`** (default 30000). The post-render dashboard linger held the event loop open, so library callers saw `await renderParallel(...)` block for 30 seconds after it resolved. Pass `0` to return immediately; the CLI keeps the default so users still see the final state.
- **`maxWorkers` option on `renderParallel`** plus a `--max-workers` CLI flag, to cap the auto worker count without hardcoding `workerCount`.
- **`version` command** (`ffmpeg-render-pro version`, `--version`, `-v`) prints the installed package version without requiring ffmpeg.
- **`dashboard` and `auto_open` parameters on the MCP `render_video` tool**, so headless or server deployments can disable the browser auto-open.

### Robustness

- **`concatSegments` validates its inputs.** It now rejects with a clear, enumerated error when any segment is missing or zero bytes, instead of producing a cryptic ffmpeg failure or a silently truncated output.
- **The example worker handles ffmpeg spawn errors.** `examples/basic-worker.js` forwards a structured error message instead of crashing on an unhandled `error` event.

### Meta

- **`npm test` now runs both the smoke suite and the MCP stdio handshake.** It previously ran only the smoke suite despite the README claiming MCP coverage. Added `test:smoke` and `test:mcp` scripts and a `prepublishOnly` hook that runs the full suite before publish.
- Added smoke tests for `planWorkers`, odd-dimension rejection, missing-output rejection, empty-segment rejection, and HEVC codec arguments (39 to 49 tests).
- Removed em-dashes from all user-facing output (README, CHANGELOG, CLI, dashboard) for consistent project style.

---

## [1.2.0] - 2026-04-18

A comprehensive hardening pass: correctness, security, and performance.
API is fully backward-compatible; no worker scripts or MCP integrations need changes.

### Fixed (Critical)

- **Dashboard no longer crashes at render completion.** `overallPct` was declared `const` and reassigned on completion, throwing `TypeError: Assignment to constant variable` and breaking the final state render.
- **Hardened the dashboard static-file server against path traversal.** Requests are now URL-decoded, null-byte-filtered, and resolved via `path.relative` before serving; percent-encoded `../` sequences and Windows-case tricks are rejected.
- **Removed shell interpolation from the browser launcher.** The cross-platform `open` helper now uses `spawn` with an argv array instead of `exec` with a template string; no more shell metacharacter exposure.

### Fixed (Correctness)

- `writeFrame` in the `createEncoder` helper now surfaces stdin/stream errors instead of hanging on a never-resolved Promise.
- `createEncoder().finish()` no longer hangs if ffmpeg already closed before it was called; it resolves/rejects with the captured exit code.
- `SIGINT`/`SIGTERM` handlers are now scoped to each `renderParallel` call and removed on completion; no handler accumulation across repeated renders.
- MCP server advertises the real package version (read from `package.json`) instead of a hardcoded string.
- Worker fast-forward state is reported via a structured `{ type: 'fast-forward-start' }` message; the old substring-matched `log` message is still accepted for backward compatibility.
- Temp-dir cleanup uses `fs.rmSync({recursive, force})`, which handles locked files on Windows.
- Concat list file is now written to `os.tmpdir()` with a random suffix, avoiding collisions when multiple concats target the same output name.
- Stricter input validation on `fps`, `duration`, and `dashboardPort`: rejects non-finite numbers and out-of-range values with clear errors.
- Workers that exit without sending a `done` message no longer hang the render promise.

### Performance

- Dashboard polls all worker JSONs **in parallel** per tick (was sequential, `N x RTT`).
- `ffmpeg -encoders` is now called once per `detectGPU` run, not once per candidate encoder (~5x fewer subprocess spawns on probe).
- `basic-worker` precomputes per-bar colors once per frame: roughly 25% faster frame generation at 1080p.
- `writeFrame` skips Promise allocation when there's no backpressure.
- `ProgressTracker` writes `global.json` once per tick (was twice).
- Capped per-subprocess stderr buffer at 8KB: no more unbounded string growth on long renders.

### Security

- Dashboard HTTP server now binds to `127.0.0.1` explicitly (never reachable off-host).
- Added a tight **Content-Security-Policy** header to all dashboard responses.
- `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` on every response.
- CORS: same-origin only, not wildcard. Localhost-to-localhost XHRs still work.
- Documented MCP server's filesystem-access posture (see README).

### Meta

- Added `CHANGELOG.md` (this file).
- Added smoke-test suite (`npm test` / `test/smoke.js`) plus MCP stdio smoke test (`test/mcp-smoke.js`).
- Loose-pinned runtime deps so users pick up patch releases automatically.
- Cleaned stale `preview/*.json` files from the repo.
- Fixed placeholder README badge links.
- Added `ffmpeg-render-pro-mcp` as an additional bin alias so the MCP invocation matches the README (the existing `ffmpeg-render-mcp` alias still works, no breakage).
- Tightened Quick Start: `npm install -g ffmpeg-render-pro` is now the primary install route, with CLI examples using the installed binaries.
- Corrected MCP install snippets in the README (`npx --package=ffmpeg-render-pro ffmpeg-render-pro-mcp`; the old `npx -y ffmpeg-render-pro-mcp` was never a valid invocation).

---

## [1.1.1] - 2026-04-03

- Dashboard bugfixes (completion detection, progress calc).

## [1.1.0] - 2026-04-03

- Added MCP server with 6 tools: `detect_gpu`, `system_info`, `render_video`, `color_grade`, `merge_audio`, `concat_videos`.

## [1.0.x] - 2026-04-03

- Initial public release.
- Parallel rendering with N worker threads and stream-copy concat.
- Cross-platform GPU detection (NVENC, VideoToolbox, AMF, VA-API, QSV).
- Live dashboard with per-worker progress, FPS chart, ETA.
- Checkpoint system for long renders.
- Color grading presets and audio merge helpers.
