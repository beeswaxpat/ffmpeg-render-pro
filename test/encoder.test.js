#!/usr/bin/env node
/**
 * Encoder tests - ffmpeg-render-pro
 *
 * Functional coverage for createEncoder: end-to-end raw-frame piping with a
 * real ffmpeg encode, the backpressure (drain) path, and stream-error /
 * finish-after-close propagation with the captured stderr tail.
 *
 * Skips (exit 0 with a warning) when ffmpeg is not on PATH.
 * Zero test-framework dependencies. Run: node test/encoder.test.js
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const lib = require('../src/index.js');

let passed = 0;
const failures = [];

function report(name, err) {
  if (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}: ${err.message}`);
  } else {
    passed++;
    console.log(`  PASS ${name}`);
  }
}

async function step(name, fn) {
  try {
    await fn();
    report(name, null);
  } catch (err) {
    report(name, err);
  }
}

function probeVideo(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
    '-of', 'csv=p=0', file,
  ], { encoding: 'utf-8', timeout: 30000 });
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  const [codec, width, height, frames] = r.stdout.trim().split(',');
  return { codec, width: Number(width), height: Number(height), frames: Number(frames) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n  ffmpeg-render-pro - encoder tests\n');

  const ff = lib.checkFFmpeg();
  if (!ff.available) {
    console.log('  !! ffmpeg not on PATH - skipping encoder test suite\n');
    process.exit(0);
  }
  const haveFfprobe = spawnSync('ffprobe', ['-version'], { timeout: 5000 }).status === 0;
  if (!haveFfprobe) {
    console.log('  !! ffprobe not on PATH - skipping encoder test suite\n');
    process.exit(0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-render-pro-encoder-'));

  try {
    // --- 1. End-to-end encode + backpressure ---
    // 640x480 BGRA frames are ~1.2MB, far above the stdin pipe buffer, so
    // every write engages the drain path and writeFrame must return a Promise
    // at least once.
    await step('createEncoder pipes N raw frames into a valid h264 file (with backpressure)', async () => {
      const W = 640, H = 480, N = 12;
      const out = path.join(tmp, 'enc.mp4');
      const enc = lib.createEncoder({
        width: W, height: H, fps: 10, outputPath: out,
        codec: 'libx264', preset: 'ultrafast',
      });
      const frame = Buffer.alloc(W * H * 4, 0x80);
      let backpressured = 0;
      for (let i = 0; i < N; i++) {
        const r = enc.writeFrame(frame);
        if (r !== undefined) {
          backpressured++;
          await r;
        }
      }
      await enc.finish();

      assert.ok(backpressured >= 1, `expected at least one backpressured write, saw ${backpressured}`);
      const v = probeVideo(out);
      assert.strictEqual(v.codec, 'h264');
      assert.strictEqual(v.width, W);
      assert.strictEqual(v.height, H);
      assert.strictEqual(v.frames, N);
    });

    // --- 2. Small frames: the synchronous (undefined) write path also lands N frames ---
    await step('small-frame writes (no forced drain) still produce exact frame count', async () => {
      const W = 64, H = 64, N = 5;
      const out = path.join(tmp, 'enc-small.mp4');
      const enc = lib.createEncoder({
        width: W, height: H, fps: 10, outputPath: out,
        codec: 'libx264', preset: 'ultrafast',
      });
      const frame = Buffer.alloc(W * H * 4, 0x20);
      for (let i = 0; i < N; i++) {
        // awaiting undefined is a no-op by contract; callers may always await
        await enc.writeFrame(frame);
      }
      await enc.finish();
      assert.strictEqual(probeVideo(out).frames, N);
    });

    // --- 3. Stream error surfaces + finish() rejects with the stderr tail ---
    // An unwritable output path kills ffmpeg immediately; writes then hit the
    // dead pipe (EPIPE) and finish() must reject from the CAPTURED close code
    // (the finish-after-close race) with ffmpeg's stderr in the message.
    await step('dead ffmpeg surfaces a writeFrame rejection and finish() rejects with stderr tail', async () => {
      const badOut = path.join(tmp, 'no-such-dir', 'nested', 'x.mp4');
      const enc = lib.createEncoder({
        width: 64, height: 64, fps: 10, outputPath: badOut,
        codec: 'libx264', preset: 'ultrafast',
      });
      const frame = Buffer.alloc(64 * 64 * 4, 0x10);

      let writeError = null;
      try {
        for (let i = 0; i < 300; i++) {
          const r = enc.writeFrame(frame);
          if (r !== undefined) await r;
          await sleep(10);
        }
      } catch (err) {
        writeError = err;
      }
      assert.ok(writeError, 'writeFrame surfaced the stream error');

      // streamError is now latched: the next writeFrame rejects immediately.
      await assert.rejects(() => Promise.resolve(enc.writeFrame(frame)));

      let finishError = null;
      try {
        await enc.finish();
      } catch (err) {
        finishError = err;
      }
      assert.ok(finishError, 'finish() rejected');
      assert.match(finishError.message, /exited with code \d+/);
      assert.ok(finishError.message.includes('no-such-dir'), 'stderr tail names the bad path');
    });

  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exit(1);
  console.log('  All encoder tests passed.\n');
}

main().catch((err) => {
  console.error('Encoder test harness error:', err);
  process.exit(2);
});
