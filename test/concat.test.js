#!/usr/bin/env node
/**
 * Concat tests - ffmpeg-render-pro
 *
 * Focused coverage for concatSegments: pre-concat stream validation
 * (codec/resolution/fps/pixel format via ffprobe), the { validate: false }
 * escape hatch, list-file quoting with spaces and apostrophes in paths,
 * and the existing missing/empty-segment guard. Generates tiny real
 * segments (128x128, 0.2s) with ffmpeg's lavfi color source, so the
 * whole suite runs in a few seconds.
 *
 * Skips (exit 0 with a warning) when ffmpeg or ffprobe is not on PATH,
 * so `npm test` still works on machines without them. Zero
 * test-framework dependencies.
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const lib = require('../src/index.js');
const { concatSegments } = require('../src/core/concat.js');

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
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
    '-of', 'csv=p=0',
    file,
  ], { encoding: 'utf-8', timeout: 30000 });
  if (result.status !== 0) throw new Error(`ffprobe failed on ${file}: ${result.stderr}`);
  const [codec, width, height, frames] = result.stdout.trim().split(',');
  return { codec, width: Number(width), height: Number(height), frames: Number(frames) };
}

/** 0.2s @ 10fps = 2 frames per segment. */
function makeSegment(outPath, { width = 128, height = 128, color = 'red' } = {}) {
  const result = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi',
    '-i', `color=c=${color}:size=${width}x${height}:rate=10:duration=0.2`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    outPath,
  ], { encoding: 'utf-8', timeout: 30000 });
  if (result.status !== 0) throw new Error(`segment generation failed: ${result.stderr}`);
}

async function main() {
  console.log('\n  ffmpeg-render-pro - concat tests\n');

  const ff = lib.checkFFmpeg();
  if (!ff.available) {
    console.log('  !! ffmpeg not on PATH - skipping concat suite\n');
    process.exit(0);
  }
  const haveFfprobe = spawnSync('ffprobe', ['-version'], { timeout: 5000 }).status === 0;
  if (!haveFfprobe) {
    console.log('  !! ffprobe not on PATH - skipping concat suite\n');
    process.exit(0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-render-pro-concat-test-'));
  try {
    const segA = path.join(tmp, 'seg-a.mp4');
    const segB = path.join(tmp, 'seg-b.mp4');
    const segWide = path.join(tmp, 'seg-wide.mp4');
    makeSegment(segA, { color: 'red' });
    makeSegment(segB, { color: 'blue' });
    makeSegment(segWide, { width: 256, color: 'green' });

    // --- 1. Happy path: default (2-arg) call validates and concats ---
    await step('2-arg concat of matching segments produces 4 frames', async () => {
      const out = path.join(tmp, 'happy.mp4');
      await concatSegments([segA, segB], out);
      assert.ok(fs.existsSync(out), 'output exists');
      const v = probeVideo(out);
      assert.strictEqual(v.codec, 'h264');
      assert.strictEqual(v.width, 128);
      assert.strictEqual(v.height, 128);
      assert.strictEqual(v.frames, 4);
    });

    // --- 2. Mismatched resolution is caught before ffmpeg runs ---
    await step('mismatched-resolution segments are rejected with a clear error', async () => {
      const out = path.join(tmp, 'mismatch.mp4');
      await assert.rejects(
        () => concatSegments([segA, segWide], out),
        (err) => {
          assert.match(err.message, /width mismatch/, 'error names the differing property');
          assert.ok(err.message.includes(segWide), 'error names the offending file');
          assert.match(err.message, /validate: false/, 'error mentions the escape hatch');
          return true;
        },
      );
      assert.ok(!fs.existsSync(out), 'no output written on rejection');
    });

    // --- 3. Escape hatch: validate: false skips the probes entirely ---
    await step('{ validate: false } skips validation and proceeds', async () => {
      const out = path.join(tmp, 'novalidate.mp4');
      // ffmpeg stream-copies mismatched segments without complaint (that is
      // the corruption this validation exists to catch), so this resolves.
      await concatSegments([segA, segWide], out, { validate: false });
      assert.ok(fs.existsSync(out), 'output exists');
      assert.ok(fs.statSync(out).size > 0, 'output has content');
    });

    // --- 4. List-file quoting: spaces and apostrophes in every path ---
    await step('paths with spaces and apostrophes concat successfully', async () => {
      const weirdDir = path.join(tmp, "weird 'dir name");
      fs.mkdirSync(weirdDir, { recursive: true });
      const weirdA = path.join(weirdDir, "part one's clip.mp4");
      const weirdB = path.join(weirdDir, "part two's clip.mp4");
      fs.copyFileSync(segA, weirdA);
      fs.copyFileSync(segB, weirdB);
      const out = path.join(weirdDir, "final cut's output.mp4");
      await concatSegments([weirdA, weirdB], out);
      assert.strictEqual(probeVideo(out).frames, 4);
    });

    // --- 5. Existing guard: missing/empty segments still rejected ---
    await step('missing segment is still rejected', async () => {
      await assert.rejects(
        () => concatSegments(
          [segA, path.join(tmp, 'no-such-segment.mp4')],
          path.join(tmp, 'never.mp4'),
        ),
        /missing or empty/,
      );
    });

    await step('empty (0-byte) segment is still rejected', async () => {
      const empty = path.join(tmp, 'empty.mp4');
      fs.writeFileSync(empty, '');
      await assert.rejects(
        () => concatSegments([segA, empty], path.join(tmp, 'never2.mp4')),
        /missing or empty/,
      );
    });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exit(1);
  console.log('  All concat tests passed.\n');
}

main().catch((err) => {
  console.error('Concat test harness error:', err);
  process.exit(2);
});
