#!/usr/bin/env node
/**
 * Audio-merge tests - ffmpeg-render-pro
 *
 * Covers the mergeAudio option paths the e2e suite never touches:
 * loop:false (-shortest truncation to the shorter input) and normalize:true
 * (the loudnorm filter string must parse and still yield an aac stream).
 *
 * Skips (exit 0 with a warning) when ffmpeg is not on PATH.
 * Zero test-framework dependencies. Run: node test/audio-merge.test.js
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

function ffprobe(file, args) {
  const r = spawnSync('ffprobe', ['-v', 'error', ...args, file], {
    encoding: 'utf-8', timeout: 30000,
  });
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  return r.stdout.trim();
}

function formatDuration(file) {
  return Number(ffprobe(file, ['-show_entries', 'format=duration', '-of', 'csv=p=0']));
}

function probeAudio(file) {
  const out = ffprobe(file, [
    '-select_streams', 'a',
    '-show_entries', 'stream=codec_name,channels',
    '-of', 'csv=p=0',
  ]);
  if (!out) return null;
  const [codec, channels] = out.split('\n')[0].split(',');
  return { codec, channels: Number(channels) };
}

function run(args, what) {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf-8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr}`);
}

function makeVideo(outPath, seconds, fps) {
  run([
    '-y', '-f', 'lavfi', '-i', `color=c=blue:s=64x64:r=${fps}`,
    '-frames:v', String(Math.round(seconds * fps)),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    outPath,
  ], 'video generation');
}

function makeSine(outPath, seconds) {
  run([
    '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-ac', '2', outPath,
  ], 'sine generation');
}

async function main() {
  console.log('\n  ffmpeg-render-pro - audio-merge tests\n');

  const ff = lib.checkFFmpeg();
  if (!ff.available) {
    console.log('  !! ffmpeg not on PATH - skipping audio-merge test suite\n');
    process.exit(0);
  }
  const haveFfprobe = spawnSync('ffprobe', ['-version'], { timeout: 5000 }).status === 0;
  if (!haveFfprobe) {
    console.log('  !! ffprobe not on PATH - skipping audio-merge test suite\n');
    process.exit(0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-render-pro-audio-'));

  try {
    const video1s = path.join(tmp, 'video-1s.mp4');
    const audio2s = path.join(tmp, 'sine-2s.wav');
    const audioHalfs = path.join(tmp, 'sine-0.5s.wav');
    makeVideo(video1s, 1, 10);
    makeSine(audio2s, 2);
    makeSine(audioHalfs, 0.5);

    // --- 1. loop:false with SHORT audio: -shortest truncates to the audio ---
    await step('loop:false with 0.5s audio truncates the 1s video to ~0.5s', async () => {
      const out = path.join(tmp, 'noloop-short-audio.mp4');
      await lib.mergeAudio({ videoPath: video1s, audioPath: audioHalfs, outputPath: out, loop: false });
      const d = formatDuration(out);
      assert.ok(Math.abs(d - 0.5) <= 0.2, `expected ~0.5s, got ${d}s`);
      assert.ok(d < 0.85, `output must be truncated below the 1s video length, got ${d}s`);
      const a = probeAudio(out);
      assert.ok(a, 'audio stream present');
      assert.strictEqual(a.codec, 'aac');
    });

    // --- 2. loop:false with LONG audio: -shortest stops at the video ---
    await step('loop:false with 2s audio stops at the 1s video length', async () => {
      const out = path.join(tmp, 'noloop-long-audio.mp4');
      await lib.mergeAudio({ videoPath: video1s, audioPath: audio2s, outputPath: out, loop: false });
      const d = formatDuration(out);
      assert.ok(Math.abs(d - 1.0) <= 0.2, `expected ~1.0s, got ${d}s`);
    });

    // --- 3. loop:true with SHORT audio: audio loops to fill the full video ---
    await step('loop:true with 0.5s audio covers the full 1s video', async () => {
      const out = path.join(tmp, 'loop-short-audio.mp4');
      await lib.mergeAudio({ videoPath: video1s, audioPath: audioHalfs, outputPath: out, loop: true });
      const d = formatDuration(out);
      assert.ok(Math.abs(d - 1.0) <= 0.2, `expected ~1.0s, got ${d}s`);
      const a = probeAudio(out);
      assert.ok(a, 'audio stream present');
    });

    // --- 4. normalize:true: the loudnorm filter parses and encodes ---
    await step('normalize:true completes and produces an aac audio stream', async () => {
      const out = path.join(tmp, 'normalized.mp4');
      await lib.mergeAudio({
        videoPath: video1s, audioPath: audio2s, outputPath: out,
        loop: false, normalize: true,
      });
      const a = probeAudio(out);
      assert.ok(a, 'audio stream present');
      assert.strictEqual(a.codec, 'aac');
      assert.strictEqual(a.channels, 2);
      // Video must remain untouched stream copy
      const vcodec = ffprobe(out, ['-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0']);
      assert.strictEqual(vcodec, 'h264');
      const d = formatDuration(out);
      assert.ok(Math.abs(d - 1.0) <= 0.25, `expected ~1.0s, got ${d}s`);
    });

  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exit(1);
  console.log('  All audio-merge tests passed.\n');
}

main().catch((err) => {
  console.error('Audio-merge test harness error:', err);
  process.exit(2);
});
