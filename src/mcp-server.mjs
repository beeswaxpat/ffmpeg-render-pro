#!/usr/bin/env node
/**
 * ffmpeg-render-pro MCP Server
 *
 * Exposes the ffmpeg-render-pro toolkit as Model Context Protocol tools.
 * Runs over stdio transport — compatible with Claude Code, Claude Desktop,
 * and any MCP client.
 *
 * Tools:
 *   detect_gpu       — Probe available hardware encoders
 *   system_info      — Show system config (workers, RAM, CPU, ffmpeg version)
 *   render_video     — Parallel render with live dashboard
 *   color_grade      — Apply color grading presets or custom filters
 *   merge_audio      — Combine video + audio (no video re-encode)
 *   concat_videos    — Stream-copy concatenate multiple video files
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { detectGPU, checkFFmpeg, getCodecArgs, validateResolution } = require('./core/gpu-detect');
const { getOptimalWorkers, getConfig } = require('./core/config');
const { renderParallel } = require('./core/parallel-renderer');
const { colorGrade, PRESETS } = require('./core/color-grade');
const { mergeAudio } = require('./core/audio-merge');
const { concatSegments } = require('./core/concat');
const path = require('path');
const fs = require('fs');

const server = new McpServer({
  name: 'ffmpeg-render-pro',
  version: '1.1.0',
});

// ── Tool 1: detect_gpu ──────────────────────────────────────────────
server.registerTool(
  'detect_gpu',
  {
    title: 'Detect GPU Encoders',
    description: 'Probe available hardware video encoders on this system. Tests NVENC, VideoToolbox, AMF, VA-API, and QSV with a 1-frame validation encode. Returns the best available encoder or CPU fallback.',
    inputSchema: {
      force_mode: z.enum(['auto', 'cpu', 'gpu']).default('auto').describe('Force CPU-only, GPU-only, or auto-detect'),
    },
  },
  async ({ force_mode }) => {
    try {
      const ffmpeg = checkFFmpeg();
      if (!ffmpeg.available) {
        return { content: [{ type: 'text', text: `Error: ${ffmpeg.error}` }], isError: true };
      }

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

      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ── Tool 2: system_info ─────────────────────────────────────────────
server.registerTool(
  'system_info',
  {
    title: 'System Info',
    description: 'Show system configuration for video rendering: CPU cores, RAM, recommended worker count, detected GPU encoder, and ffmpeg version.',
    inputSchema: {
      width: z.number().default(1920).describe('Target render width for worker calculation'),
      height: z.number().default(1080).describe('Target render height for worker calculation'),
    },
  },
  async ({ width, height }) => {
    try {
      const ffmpeg = checkFFmpeg();
      if (!ffmpeg.available) {
        return { content: [{ type: 'text', text: `Error: ${ffmpeg.error}` }], isError: true };
      }

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

      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ── Tool 3: render_video ────────────────────────────────────────────
server.registerTool(
  'render_video',
  {
    title: 'Render Video (Parallel)',
    description: 'Render a video using parallel workers with live dashboard. Requires a worker script that generates frames. Splits frames across N workers, encodes segments, and concatenates with stream copy. Dashboard auto-opens in the browser.',
    inputSchema: {
      worker_script: z.string().describe('Absolute path to the worker .js file that generates frames'),
      output_path: z.string().describe('Output video file path'),
      width: z.number().default(1920).describe('Frame width (max 7680)'),
      height: z.number().default(1080).describe('Frame height (max 4320)'),
      fps: z.number().default(30).describe('Framerate (1-240)'),
      duration: z.number().describe('Duration in seconds'),
      workers: z.number().optional().describe('Override auto-detected worker count'),
      seed: z.number().default(42).describe('RNG seed for deterministic output'),
      title: z.string().default('Render').describe('Title shown in dashboard'),
    },
  },
  async ({ worker_script, output_path, width, height, fps, duration, workers, seed, title }) => {
    try {
      validateResolution(width, height);

      const resolvedWorker = path.resolve(worker_script);
      const resolvedOutput = path.resolve(output_path);

      if (!fs.existsSync(resolvedWorker)) {
        return { content: [{ type: 'text', text: `Error: Worker script not found: ${resolvedWorker}` }], isError: true };
      }

      const result = await renderParallel({
        workerScript: resolvedWorker,
        outputPath: resolvedOutput,
        width, height, fps, duration,
        workerCount: workers,
        seed,
        title,
        dashboard: true,
        autoOpen: true,
      });

      const avgFps = (result.totalFrames / result.elapsed).toFixed(1);
      const text = [
        `Render Complete:`,
        `  Output:       ${result.outputPath}`,
        `  Total frames: ${result.totalFrames.toLocaleString()}`,
        `  Render time:  ${result.elapsed.toFixed(1)}s`,
        `  Average FPS:  ${avgFps}`,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Render error: ${error.message}` }], isError: true };
    }
  }
);

// ── Tool 4: color_grade ─────────────────────────────────────────────
server.registerTool(
  'color_grade',
  {
    title: 'Color Grade Video',
    description: `Apply a color grade to a video file. Built-in presets: ${Object.keys(PRESETS).join(', ')}. Or provide a custom ffmpeg -vf filter string.`,
    inputSchema: {
      input_path: z.string().describe('Input video file path'),
      output_path: z.string().describe('Output video file path'),
      preset: z.enum(['noir', 'warm', 'cool', 'cinematic', 'vintage']).optional().describe('Built-in color grade preset'),
      filter: z.string().optional().describe('Custom ffmpeg -vf filter string (overrides preset)'),
      codec: z.string().default('libx264').describe('Encoder for output'),
    },
  },
  async ({ input_path, output_path, preset, filter, codec }) => {
    try {
      if (!preset && !filter) {
        return { content: [{ type: 'text', text: `Error: Provide either a preset (${Object.keys(PRESETS).join(', ')}) or a custom filter string.` }], isError: true };
      }

      const resolvedInput = path.resolve(input_path);
      const resolvedOutput = path.resolve(output_path);

      if (!fs.existsSync(resolvedInput)) {
        return { content: [{ type: 'text', text: `Error: Input file not found: ${resolvedInput}` }], isError: true };
      }

      await colorGrade({
        inputPath: resolvedInput,
        outputPath: resolvedOutput,
        preset,
        filter,
        codec,
      });

      const text = [
        `Color Grade Complete:`,
        `  Input:  ${resolvedInput}`,
        `  Output: ${resolvedOutput}`,
        `  ${preset ? `Preset: ${preset}` : `Filter: ${filter}`}`,
        `  Codec:  ${codec}`,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Color grade error: ${error.message}` }], isError: true };
    }
  }
);

// ── Tool 5: merge_audio ─────────────────────────────────────────────
server.registerTool(
  'merge_audio',
  {
    title: 'Merge Audio with Video',
    description: 'Combine a video file with an audio file. Video is stream-copied (no re-encode). Supports looping short audio, loudness normalization for YouTube.',
    inputSchema: {
      video_path: z.string().describe('Input video file path'),
      audio_path: z.string().describe('Input audio file path'),
      output_path: z.string().describe('Output file path'),
      bitrate: z.number().default(320).describe('Audio bitrate in kbps'),
      loop: z.boolean().default(true).describe('Loop audio if shorter than video'),
      normalize: z.boolean().default(false).describe('Apply YouTube loudness normalization (loudnorm)'),
    },
  },
  async ({ video_path, audio_path, output_path, bitrate, loop, normalize }) => {
    try {
      const resolvedVideo = path.resolve(video_path);
      const resolvedAudio = path.resolve(audio_path);
      const resolvedOutput = path.resolve(output_path);

      if (!fs.existsSync(resolvedVideo)) {
        return { content: [{ type: 'text', text: `Error: Video file not found: ${resolvedVideo}` }], isError: true };
      }
      if (!fs.existsSync(resolvedAudio)) {
        return { content: [{ type: 'text', text: `Error: Audio file not found: ${resolvedAudio}` }], isError: true };
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

      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Audio merge error: ${error.message}` }], isError: true };
    }
  }
);

// ── Tool 6: concat_videos ───────────────────────────────────────────
server.registerTool(
  'concat_videos',
  {
    title: 'Concatenate Videos',
    description: 'Join multiple video files with stream copy (instant, no re-encoding). All segments must have the same codec, resolution, and framerate.',
    inputSchema: {
      input_files: z.array(z.string()).describe('Array of video file paths to concatenate'),
      output_path: z.string().describe('Output file path'),
    },
  },
  async ({ input_files, output_path }) => {
    try {
      const resolvedFiles = input_files.map(f => path.resolve(f));
      const resolvedOutput = path.resolve(output_path);

      for (const f of resolvedFiles) {
        if (!fs.existsSync(f)) {
          return { content: [{ type: 'text', text: `Error: File not found: ${f}` }], isError: true };
        }
      }

      await concatSegments(resolvedFiles, resolvedOutput);

      const text = [
        `Concatenation Complete:`,
        `  Segments: ${resolvedFiles.length}`,
        `  Output:   ${resolvedOutput}`,
        `  Method:   stream copy (no re-encode)`,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Concat error: ${error.message}` }], isError: true };
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
