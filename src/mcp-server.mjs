#!/usr/bin/env node
/**
 * ffmpeg-render-pro MCP Server
 *
 * Exposes the ffmpeg-render-pro toolkit as Model Context Protocol tools.
 * Runs over stdio transport - compatible with Claude Code, Claude Desktop,
 * and any MCP client.
 *
 * Tools:
 *   detect_gpu          - Probe available hardware encoders
 *   system_info         - Get render system capabilities (workers, RAM, CPU, ffmpeg)
 *   render_video        - Parallel render with progress notifications + cancellation
 *   get_worker_template - Worker script contract + bundled reference worker source
 *   color_grade         - Apply color grading presets or custom filters
 *   merge_audio         - Combine video + audio (no video re-encode)
 *   concat_videos       - Stream-copy concatenate multiple video files
 *
 * Protocol hygiene: stdout is the JSON-RPC channel. All console output is
 * redirected to stderr below, and renders run with quiet: true, so no
 * library code can ever write a non-protocol byte to stdout.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// stdout IS the MCP protocol channel. Route every console method that
// targets stdout to stderr BEFORE loading any core module, so no library
// banner, warning, or stray log can corrupt JSON-RPC framing.
const toStderr = console.error.bind(console);
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;

const { detectGPU, checkFFmpeg, validateResolution } = require('./core/gpu-detect');
const { getConfig } = require('./core/config');
const { renderParallel } = require('./core/parallel-renderer');
const { colorGrade, PRESETS } = require('./core/color-grade');
const { mergeAudio } = require('./core/audio-merge');
const { concatSegments } = require('./core/concat');
const path = require('path');
const fs = require('fs');

// Keep the MCP server's advertised version in sync with package.json
// so we don't ship stale version metadata to MCP clients.
let pkgVersion = '0.0.0';
try {
  pkgVersion = require('../package.json').version || pkgVersion;
} catch {}

const server = new McpServer({
  name: 'ffmpeg-render-pro',
  version: pkgVersion,
});

// ── Shared helpers ──────────────────────────────────────────────────

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function okResult(text, structuredContent) {
  return { content: [{ type: 'text', text }], structuredContent };
}

/** Returns an isError result with install guidance when ffmpeg is missing, else null. */
function ffmpegGate() {
  const ffmpeg = checkFFmpeg();
  if (!ffmpeg.available) return errorResult(`Error: ${ffmpeg.error}`);
  return null;
}

/**
 * Read the render progress snapshot the ProgressTracker writes for the HTML
 * dashboard (<outputDir>/preview/global.json + worker-N.json). Returns
 * { pct, message } or null when no snapshot exists yet. In-flight pct is
 * capped at 99 so 100 is reserved for the final completion notification.
 */
function readRenderProgress(previewDir) {
  let global;
  try {
    global = JSON.parse(fs.readFileSync(path.join(previewDir, 'global.json'), 'utf-8'));
  } catch {
    return null;
  }
  const phase = global.phase || 'rendering';
  const detail = global.phaseDetail || phase;
  let pct = 0;
  if (phase === 'complete') {
    pct = 100;
  } else {
    const total = Number(global.totalFrames);
    const numWorkers = Number(global.numWorkers);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(numWorkers) && numWorkers > 0) {
      let rendered = 0;
      for (let i = 0; i < numWorkers; i++) {
        try {
          const w = JSON.parse(fs.readFileSync(path.join(previewDir, `worker-${i}.json`), 'utf-8'));
          rendered += Number(w.framesRendered) || 0;
        } catch {}
      }
      pct = Math.min(99, Math.round((rendered / total) * 1000) / 10);
    }
  }
  return { pct, message: `${phase}: ${detail}` };
}

// ── Tool 1: detect_gpu ──────────────────────────────────────────────
server.registerTool(
  'detect_gpu',
  {
    title: 'Detect GPU Encoders',
    description: 'Detect the best available hardware video encoder on this machine. Probes NVENC, VideoToolbox, AMF, VA-API, and QSV with a 1-frame validation encode and falls back to CPU (libx264) when no GPU encoder works. Use before rendering or grading to confirm hardware acceleration. Results are cached for 7 days in ~/.ffmpeg-render-pro/gpu-cache.json. Requires ffmpeg on PATH or FFMPEG_RENDER_PRO_FFMPEG.',
    inputSchema: {
      force_mode: z.enum(['auto', 'cpu', 'gpu']).default('auto').describe('auto probes hardware then falls back to CPU (default). cpu skips probing and always returns libx264. gpu fails if no hardware encoder is found.'),
    },
    outputSchema: {
      h264: z.string().describe('Best available H.264 encoder name'),
      hevc: z.string().nullable().describe('Best available HEVC encoder name, or null'),
      isGpu: z.boolean().describe('True when a hardware encoder validated'),
      label: z.string().describe('Human-readable label of the selected encoder'),
      all: z.array(z.object({
        name: z.string(),
        label: z.string(),
        codec: z.string(),
      })).describe('All validated encoders including the CPU fallback'),
      ffmpegVersion: z.string().describe('Detected ffmpeg version string'),
    },
    // readOnlyHint stays true: the GPU probe cache file (~/.ffmpeg-render-pro/gpu-cache.json)
    // is internal plumbing, not user-visible environment mutation, and flipping the hint
    // would force approval prompts on a harmless probe.
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ force_mode }) => {
    try {
      const gate = ffmpegGate();
      if (gate) return gate;
      const ffmpeg = checkFFmpeg();

      const forceEncoder = force_mode === 'auto' ? undefined : force_mode;
      const result = detectGPU({ force: true, verbose: false, forceEncoder });

      const text = [
        `GPU Detection Results:`,
        `  H.264 encoder: ${result.h264} (${result.label})`,
        `  HEVC encoder:  ${result.hevc || 'not available'}`,
        `  GPU available: ${result.isGpu ? 'YES' : 'NO (CPU fallback)'}`,
        `  All encoders:  ${result.all.map(e => e.name).join(', ')}`,
        `  ffmpeg version: ${ffmpeg.version}`,
      ].join('\n');

      return okResult(text, {
        h264: result.h264,
        hevc: result.hevc ?? null,
        isGpu: result.isGpu,
        label: result.label,
        all: result.all.map(e => ({ name: e.name, label: e.label, codec: e.codec })),
        ffmpegVersion: ffmpeg.version || 'unknown',
      });
    } catch (error) {
      return errorResult(`Error: ${error.message}`);
    }
  }
);

// ── Tool 2: system_info ─────────────────────────────────────────────
server.registerTool(
  'system_info',
  {
    title: 'Get Render System Capabilities',
    description: 'Get render system capabilities: CPU cores, total and free RAM, the recommended parallel worker count for a target resolution, detected GPU encoder, segment and final codecs, and ffmpeg version. Use before render_video to choose a worker count or check whether this machine can handle a resolution. Requires ffmpeg on PATH or FFMPEG_RENDER_PRO_FFMPEG.',
    inputSchema: {
      width: z.number().int().min(1).max(7680).default(1920).describe('Target render width in pixels for the worker recommendation. Default 1920, max 7680.'),
      height: z.number().int().min(1).max(4320).default(1080).describe('Target render height in pixels for the worker recommendation. Default 1080, max 4320.'),
    },
    outputSchema: {
      platform: z.string().describe('Node platform string (win32, linux, darwin)'),
      arch: z.string().describe('CPU architecture'),
      cpuCores: z.number().int().describe('Logical CPU core count'),
      totalRamMB: z.number().describe('Total RAM in MB'),
      freeRamMB: z.number().describe('Free RAM in MB'),
      ffmpegVersion: z.string().describe('Detected ffmpeg version string'),
      gpuLabel: z.string().describe('Label of the detected GPU encoder or CPU fallback'),
      isGpu: z.boolean().describe('True when a hardware encoder is available'),
      workers: z.number().int().describe('Recommended parallel worker count for the target resolution'),
      tier: z.string().describe('Resolution tier used for the recommendation (480p to 4k)'),
      segmentCodec: z.string().describe('Codec used for parallel segment encoding'),
      finalCodec: z.string().describe('Codec used for final single-file passes'),
    },
    // Same rationale as detect_gpu: the GPU cache file is internal plumbing,
    // so readOnlyHint stays true.
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ width, height }) => {
    try {
      const gate = ffmpegGate();
      if (gate) return gate;
      const ffmpeg = checkFFmpeg();

      validateResolution(width, height);
      const gpu = detectGPU();
      const config = getConfig({ width, height, gpuResult: gpu });

      const text = [
        `System Info:`,
        `  Platform:      ${config.system.platform} (${config.system.arch})`,
        `  CPU cores:     ${config.system.cpuCores}`,
        `  RAM:           ${config.system.totalRamMB}MB total, ${config.system.freeRamMB}MB free`,
        `  ffmpeg:        ${ffmpeg.version}`,
        `  GPU encoder:   ${config.gpuLabel}`,
        `  Workers:       ${config.workers} (for ${config.tier} @ ${width}x${height})`,
        `  Segment codec: ${config.segmentCodec}`,
        `  Final codec:   ${config.finalCodec}`,
      ].join('\n');

      return okResult(text, {
        platform: config.system.platform,
        arch: config.system.arch,
        cpuCores: config.system.cpuCores,
        totalRamMB: config.system.totalRamMB,
        freeRamMB: config.system.freeRamMB,
        ffmpegVersion: ffmpeg.version || 'unknown',
        gpuLabel: config.gpuLabel,
        isGpu: config.isGpu,
        workers: config.workers,
        tier: config.tier,
        segmentCodec: config.segmentCodec,
        finalCodec: config.finalCodec,
      });
    } catch (error) {
      return errorResult(`Error: ${error.message}`);
    }
  }
);

// ── Tool 3: render_video ────────────────────────────────────────────
server.registerTool(
  'render_video',
  {
    title: 'Render Video (Parallel Workers)',
    description: 'Render a video by running a frame-generating worker script across parallel worker threads. Splits the frame range across N workers, encodes one MP4 segment per worker, then joins segments with stream copy. Prerequisites: ffmpeg installed, plus a worker script implementing the ffmpeg-render-pro worker contract; call get_worker_template first if you need to author a worker, or use its templatePath for a ready-made test scene. Side effects: overwrites output_path if it already exists and writes dashboard files under <output dir>/preview. Long renders emit MCP progress notifications when the client supplies a progressToken (enable resetTimeoutOnProgress for renders longer than the client request timeout; per-frame progress detail requires dashboard true, the default). Client cancellation stops all workers and removes temp files. Note: this tool defaults to 30 fps; the CLI defaults to 60.',
    inputSchema: {
      worker_script: z.string().describe('Absolute path to the worker .js file that generates frames. Must implement the contract returned by get_worker_template.'),
      output_path: z.string().describe('Output video file path. Overwritten if it already exists.'),
      width: z.number().int().min(1).max(7680).default(1920).describe('Frame width in pixels. Must be even (yuv420p). Default 1920, max 7680.'),
      height: z.number().int().min(1).max(4320).default(1080).describe('Frame height in pixels. Must be even (yuv420p). Default 1080, max 4320.'),
      fps: z.number().min(1).max(240).default(30).describe('Framerate in frames per second, 1-240. Default 30 for this tool (CLI default is 60).'),
      duration: z.number().positive().describe('Video duration in seconds. Required.'),
      workers: z.number().int().min(1).optional().describe('Exact worker thread count, overriding auto-detection. Omit to auto-detect from CPU/RAM.'),
      seed: z.number().int().default(42).describe('RNG seed passed to workers for deterministic output. Default 42.'),
      title: z.string().default('Render').describe('Title shown in the dashboard. Default "Render".'),
      dashboard: z.boolean().default(true).describe('Serve the live HTML progress dashboard and write preview JSON files. Default true.'),
      auto_open: z.boolean().default(true).describe('Open the dashboard in a browser. Default true; set false for headless or server use.'),
      max_workers: z.number().int().min(1).optional().describe('Cap for the auto-detected worker count. Ignored when workers is set. Default 8.'),
      dashboard_port: z.number().int().min(1).max(65535).optional().describe('Dashboard starting port, 1-65535. Default 8080; increments if occupied.'),
      linger_ms: z.number().int().min(0).optional().describe('How long the dashboard stays up after completion, in milliseconds. Default 30000; 0 stops it immediately.'),
    },
    outputSchema: {
      outputPath: z.string().describe('Absolute path of the rendered video file'),
      totalFrames: z.number().int().describe('Total frames rendered'),
      elapsedSeconds: z.number().describe('Wall-clock render time in seconds'),
      avgFps: z.number().describe('Average frames encoded per second across the whole render'),
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ worker_script, output_path, width, height, fps, duration, workers, seed, title, dashboard, auto_open, max_workers, dashboard_port, linger_ms }, extra) => {
    let progressTimer = null;
    try {
      validateResolution(width, height);

      const resolvedWorker = path.resolve(worker_script);
      const resolvedOutput = path.resolve(output_path);

      if (!fs.existsSync(resolvedWorker)) {
        return errorResult(`Error: Worker script not found: ${resolvedWorker}. Call get_worker_template for the contract and a bundled reference worker path.`);
      }

      // MCP progress notifications: only when the client asked for them by
      // sending a progressToken. A 2s poll of the ProgressTracker's dashboard
      // JSON (preview/global.json + worker-N.json) feeds pct/phase to the
      // client; an immediate 0% and a final 100% bracket the render so even
      // sub-2s renders emit at least one frame of progress.
      const progressToken = extra?._meta?.progressToken;
      const sendProgress = (progress, message) => {
        if (progressToken === undefined || !extra?.sendNotification) return Promise.resolve();
        return extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress, total: 100, message },
        }).catch(() => {});
      };

      if (progressToken !== undefined) {
        await sendProgress(0, 'initializing: render starting');
        const previewDir = path.join(path.dirname(resolvedOutput), 'preview');
        progressTimer = setInterval(() => {
          const snap = readRenderProgress(previewDir);
          if (snap) void sendProgress(snap.pct, snap.message);
        }, 2000);
        // Never hold the server's event loop open for the poller.
        if (typeof progressTimer.unref === 'function') progressTimer.unref();
      }

      const result = await renderParallel({
        workerScript: resolvedWorker,
        outputPath: resolvedOutput,
        width, height, fps, duration,
        workerCount: workers,
        maxWorkers: max_workers,
        seed,
        title,
        dashboard,
        autoOpen: auto_open,
        dashboardPort: dashboard_port,
        dashboardLingerMs: linger_ms,
        // stdout is the MCP protocol channel: status goes to stderr, the
        // ANSI terminal ticker is disabled, dashboard JSON still written.
        quiet: true,
        // Client-side cancellation (notifications/cancelled or timeout)
        // aborts the render: workers stopped, temp files removed.
        signal: extra?.signal,
      });

      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      const elapsedSeconds = result.elapsed;
      const avgFps = elapsedSeconds > 0 ? result.totalFrames / elapsedSeconds : 0;
      await sendProgress(100, `complete: ${result.totalFrames} frames in ${elapsedSeconds.toFixed(1)}s`);

      const text = [
        `Render Complete:`,
        `  Output:       ${result.outputPath}`,
        `  Total frames: ${result.totalFrames.toLocaleString()}`,
        `  Render time:  ${elapsedSeconds.toFixed(1)}s`,
        `  Average FPS:  ${avgFps.toFixed(1)}`,
      ].join('\n');

      return okResult(text, {
        outputPath: path.resolve(result.outputPath),
        totalFrames: result.totalFrames,
        elapsedSeconds,
        avgFps,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        return errorResult('Render cancelled: the client aborted the request. All workers were stopped and temp files removed. No output file was produced.');
      }
      return errorResult(`Render error: ${error.message}`);
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
  }
);

// ── Tool 4: get_worker_template ─────────────────────────────────────

const WORKER_DATA_FIELDS = {
  width: 'Frame width in pixels',
  height: 'Frame height in pixels',
  fps: 'Framerate in frames per second',
  seed: 'RNG seed; derive all randomness from it for deterministic output',
  startFrame: 'First frame index this worker must render (inclusive)',
  endFrame: 'Frame index to stop before (exclusive); render exactly [startFrame, endFrame)',
  segmentPath: 'Absolute path of the MP4 segment file this worker MUST write its frames to',
  workerId: 'Zero-based index of this worker; include it in every message posted to the parent',
  totalFrames: 'Total frame count across all workers (for global effects like progress bars)',
  duration: 'Total video duration in seconds',
};

const WORKER_MESSAGES = [
  {
    type: 'progress',
    fields: { workerId: 'number', pct: 'string|number, 0-100 within this worker\'s range', fps: 'string|number, current encode speed', frame: 'number, frames completed by this worker', eta: 'string|number, estimated seconds remaining' },
    when: 'Post periodically while rendering (roughly every 1% of this worker\'s frames)',
  },
  {
    type: 'done',
    fields: { workerId: 'number' },
    when: 'Post exactly once after the segment file at segmentPath is fully written and the encoder has exited cleanly',
  },
  {
    type: 'error',
    fields: { workerId: 'number', error: 'string, failure description' },
    when: 'Post on any failure instead of done; never post done after error',
  },
  {
    type: 'fast-forward-start',
    fields: { workerId: 'number', frames: 'number, frames of state being replayed' },
    when: 'Optional: post before replaying simulation state to reach startFrame, so the dashboard shows a fast-forward phase',
  },
];

server.registerTool(
  'get_worker_template',
  {
    title: 'Get Worker Script Template',
    description: 'Get the worker script contract required by render_video, plus the full source of the bundled reference worker (a procedural test scene with no dependencies). Use this before authoring a custom worker script, or pass the returned templatePath directly as render_video\'s worker_script to render the test scene. Read-only: returns documentation and source text, touches nothing.',
    inputSchema: {},
    outputSchema: {
      workerData: z.record(z.string()).describe('Fields injected into the worker via worker_threads workerData, mapped to their meaning'),
      messages: z.array(z.object({
        type: z.string(),
        fields: z.record(z.string()),
        when: z.string(),
      })).describe('Messages the worker must post to parentPort, their fields, and when to send them'),
      templatePath: z.string().describe('Absolute path of the bundled reference worker; usable directly as render_video worker_script'),
      templateSource: z.string().describe('Full source code of the bundled reference worker'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const templatePath = require.resolve('../examples/basic-worker.js');
      const templateSource = fs.readFileSync(templatePath, 'utf-8');

      const contractLines = [
        'render_video worker contract',
        '',
        'The worker script runs as a Node worker_thread. It must:',
        '  1. Read its assignment from workerData (fields below).',
        '  2. Render frames [startFrame, endFrame) and encode them into an MP4 at segmentPath',
        '     (the reference worker pipes raw BGRA frames to an ffmpeg child process).',
        '  3. Post progress/done/error messages to parentPort (shapes below).',
        '',
        'workerData fields injected by the renderer:',
        ...Object.entries(WORKER_DATA_FIELDS).map(([k, v]) => `  ${k}: ${v}`),
        '',
        'Messages the worker posts via parentPort.postMessage:',
        ...WORKER_MESSAGES.map(m => `  { type: '${m.type}', ${Object.keys(m.fields).join(', ')} } - ${m.when}`),
        '',
        'Notes:',
        '  - Segments from all workers are stream-copy concatenated, so every worker must',
        '    encode with identical codec, resolution, framerate, and pixel format.',
        '  - Library callers can pass extra workerData keys via renderParallel({ workerData });',
        '    the reference worker honors workerData.codecArgs to override encoder args.',
        '',
        `Bundled reference worker: ${templatePath}`,
        '',
        '--- basic-worker.js source ---',
        templateSource,
      ];

      return okResult(contractLines.join('\n'), {
        workerData: WORKER_DATA_FIELDS,
        messages: WORKER_MESSAGES,
        templatePath,
        templateSource,
      });
    } catch (error) {
      return errorResult(`Error reading worker template: ${error.message}`);
    }
  }
);

// ── Tool 5: color_grade ─────────────────────────────────────────────
server.registerTool(
  'color_grade',
  {
    title: 'Color Grade Video',
    description: `Apply a color grade to a video file and write the result to a new file. Provide either a built-in preset (${Object.keys(PRESETS).join(', ')}) or a custom ffmpeg -vf filter string (filter overrides preset). Re-encodes the video stream with the chosen codec; audio is stripped unless keep_audio is true. Prerequisite: ffmpeg installed. Side effect: overwrites output_path if it already exists.`,
    inputSchema: {
      input_path: z.string().describe('Input video file path. Must exist.'),
      output_path: z.string().describe('Output video file path. Overwritten if it already exists.'),
      preset: z.enum(['noir', 'warm', 'cool', 'cinematic', 'vintage']).optional().describe('Built-in color grade preset'),
      filter: z.string().optional().describe('Custom ffmpeg -vf filter string. Overrides preset when both are given.'),
      codec: z.string().default('libx264').describe('Video encoder for the output. Default libx264.'),
      crf: z.number().int().min(0).max(51).optional().describe('CRF/CQ quality, 0-51. Lower is higher quality. Default 18.'),
      keep_audio: z.boolean().default(false).describe('Stream-copy the input audio track instead of stripping it. Default false (audio stripped).'),
    },
    outputSchema: {
      inputPath: z.string().describe('Absolute input file path'),
      outputPath: z.string().describe('Absolute output file path'),
      preset: z.string().nullable().describe('Preset applied, or null when a custom filter was used'),
      filter: z.string().nullable().describe('Custom filter applied, or null when a preset was used'),
      codec: z.string().describe('Encoder used for the output'),
      crf: z.number().int().describe('CRF/CQ quality value applied'),
      audioKept: z.boolean().describe('True when the input audio track was stream-copied into the output'),
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ input_path, output_path, preset, filter, codec, crf, keep_audio }) => {
    try {
      const gate = ffmpegGate();
      if (gate) return gate;

      if (!preset && !filter) {
        return errorResult(`Error: Provide either a preset (${Object.keys(PRESETS).join(', ')}) or a custom filter string.`);
      }

      const resolvedInput = path.resolve(input_path);
      const resolvedOutput = path.resolve(output_path);

      if (!fs.existsSync(resolvedInput)) {
        return errorResult(`Error: Input file not found: ${resolvedInput}`);
      }

      await colorGrade({
        inputPath: resolvedInput,
        outputPath: resolvedOutput,
        preset,
        filter,
        codec,
        crf,
        cq: crf,
        keepAudio: keep_audio,
      });

      const appliedCrf = crf ?? 18;
      const text = [
        `Color Grade Complete:`,
        `  Input:  ${resolvedInput}`,
        `  Output: ${resolvedOutput}`,
        `  ${filter ? `Filter: ${filter}` : `Preset: ${preset}`}`,
        `  Codec:  ${codec} (crf ${appliedCrf})`,
        `  Audio:  ${keep_audio ? 'kept (stream copy)' : 'stripped'}`,
      ].join('\n');

      return okResult(text, {
        inputPath: resolvedInput,
        outputPath: resolvedOutput,
        preset: filter ? null : (preset ?? null),
        filter: filter ?? null,
        codec,
        crf: appliedCrf,
        audioKept: keep_audio,
      });
    } catch (error) {
      return errorResult(`Color grade error: ${error.message}`);
    }
  }
);

// ── Tool 6: merge_audio ─────────────────────────────────────────────
server.registerTool(
  'merge_audio',
  {
    title: 'Merge Audio into Video',
    description: 'Combine a video file and an audio file into one output file. The video stream is copied without re-encoding; audio is encoded to AAC at the given bitrate. Loops audio shorter than the video when loop is true, and can apply loudness normalization (ffmpeg loudnorm) for YouTube-style targets. Prerequisite: ffmpeg installed. Side effect: overwrites output_path if it already exists.',
    inputSchema: {
      video_path: z.string().describe('Input video file path. Must exist.'),
      audio_path: z.string().describe('Input audio file path. Must exist.'),
      output_path: z.string().describe('Output file path. Overwritten if it already exists.'),
      bitrate: z.number().int().min(8).max(1024).default(320).describe('Audio bitrate in kbps, 8-1024. Default 320.'),
      loop: z.boolean().default(true).describe('Loop the audio if it is shorter than the video. Default true.'),
      normalize: z.boolean().default(false).describe('Apply loudness normalization (loudnorm I=-22 TP=-2 LRA=7). Default false.'),
    },
    outputSchema: {
      videoPath: z.string().describe('Absolute input video path'),
      audioPath: z.string().describe('Absolute input audio path'),
      outputPath: z.string().describe('Absolute output file path'),
      bitrateKbps: z.number().int().describe('Audio bitrate applied, in kbps'),
      looped: z.boolean().describe('True when audio looping was enabled'),
      normalized: z.boolean().describe('True when loudness normalization was applied'),
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ video_path, audio_path, output_path, bitrate, loop, normalize }) => {
    try {
      const gate = ffmpegGate();
      if (gate) return gate;

      const resolvedVideo = path.resolve(video_path);
      const resolvedAudio = path.resolve(audio_path);
      const resolvedOutput = path.resolve(output_path);

      if (!fs.existsSync(resolvedVideo)) {
        return errorResult(`Error: Video file not found: ${resolvedVideo}`);
      }
      if (!fs.existsSync(resolvedAudio)) {
        return errorResult(`Error: Audio file not found: ${resolvedAudio}`);
      }

      await mergeAudio({
        videoPath: resolvedVideo,
        audioPath: resolvedAudio,
        outputPath: resolvedOutput,
        bitrate,
        loop,
        normalize,
      });

      const text = [
        `Audio Merge Complete:`,
        `  Video:     ${resolvedVideo}`,
        `  Audio:     ${resolvedAudio}`,
        `  Output:    ${resolvedOutput}`,
        `  Bitrate:   ${bitrate}kbps`,
        `  Loop:      ${loop}`,
        `  Normalize: ${normalize}`,
      ].join('\n');

      return okResult(text, {
        videoPath: resolvedVideo,
        audioPath: resolvedAudio,
        outputPath: resolvedOutput,
        bitrateKbps: bitrate,
        looped: loop,
        normalized: normalize,
      });
    } catch (error) {
      return errorResult(`Audio merge error: ${error.message}`);
    }
  }
);

// ── Tool 7: concat_videos ───────────────────────────────────────────
server.registerTool(
  'concat_videos',
  {
    title: 'Concatenate Videos',
    description: 'Join multiple video files into one with stream copy: no re-encoding, completes in seconds regardless of file size. All inputs must share the same codec, resolution, framerate, and pixel format. By default each input is probed with ffprobe and mismatches are rejected before ffmpeg runs, because ffmpeg itself accepts mismatched inputs and writes a silently corrupt file; set validate false to skip the probes for inputs known to be uniform. Prerequisite: ffmpeg installed. Side effect: overwrites output_path if it already exists.',
    inputSchema: {
      input_files: z.array(z.string()).min(1).describe('Video file paths to concatenate, in playback order. All must exist.'),
      output_path: z.string().describe('Output file path. Overwritten if it already exists.'),
      validate: z.boolean().default(true).describe('Probe every input with ffprobe and reject codec/resolution/framerate/pixel-format mismatches before concatenating. Default true. Skipped with a warning when ffprobe is not installed.'),
    },
    outputSchema: {
      segments: z.array(z.string()).describe('Absolute paths of the concatenated inputs, in order'),
      outputPath: z.string().describe('Absolute output file path'),
      validated: z.boolean().describe('True when segment compatibility validation was requested'),
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ input_files, output_path, validate }) => {
    try {
      const gate = ffmpegGate();
      if (gate) return gate;

      const resolvedFiles = input_files.map(f => path.resolve(f));
      const resolvedOutput = path.resolve(output_path);

      for (const f of resolvedFiles) {
        if (!fs.existsSync(f)) {
          return errorResult(`Error: File not found: ${f}`);
        }
      }

      await concatSegments(resolvedFiles, resolvedOutput, { validate });

      const text = [
        `Concatenation Complete:`,
        `  Segments:  ${resolvedFiles.length}`,
        `  Output:    ${resolvedOutput}`,
        `  Method:    stream copy (no re-encode)`,
        `  Validated: ${validate ? 'yes (ffprobe compatibility check)' : 'no (skipped by request)'}`,
      ].join('\n');

      return okResult(text, {
        segments: resolvedFiles,
        outputPath: resolvedOutput,
        validated: validate,
      });
    } catch (error) {
      return errorResult(`Concat error: ${error.message}`);
    }
  }
);

// ── Start server ────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ffmpeg-render-pro MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
