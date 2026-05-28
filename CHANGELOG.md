# Changelog

All notable changes to `ffmpeg-render-pro` are documented in this file.
This project follows [Semantic Versioning](https://semver.org/).

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
