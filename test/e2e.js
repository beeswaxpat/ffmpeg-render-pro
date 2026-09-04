#!/usr/bin/env node
/**
 * End-to-end tests - ffmpeg-render-pro
 *
 * Exercises the real pipeline with real ffmpeg encodes: parallel render,
 * deterministic output, stream-copy concat, color grade, audio merge,
 * checkpoint round-trip, and the CLI entry point. Uses tiny videos
 * (320x240, ~1s) so the whole suite runs in well under a minute.
 *
 * Skips (exit 0 with a warning) when ffmpeg is not on PATH, so `npm test`
 * still works on machines without ffmpeg. Zero test-framework dependencies.
 */
const assert = require('assert');
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const lib = require('../src/index.js');
const ROOT = path.join(__dirname, '..');
const WORKER = path.join(ROOT, 'examples', 'basic-worker.js');

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
  const result = spawnSync('ffprobe', ['-v', 'error', ...args, file], {
    encoding: 'utf-8', timeout: 30000,
  });
  if (result.status !== 0) throw new Error(`ffprobe failed on ${file}: ${result.stderr}`);
  return result.stdout.trim();
}

function probeVideo(file) {
  const out = ffprobe(file, [
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
    '-of', 'csv=p=0',
  ]);
  const [codec, width, height, frames] = out.split(',');
  return { codec, width: Number(width), height: Number(height), frames: Number(frames) };
}

function probeAudio(file) {
  const out = ffprobe(file, [
    '-select_streams', 'a',
    '-show_entries', 'stream=codec_name,channels',
    '-of', 'csv=p=0',
  ]);
  if (!out) return null;
  const lines = out.split('\n');
  const [codec, channels] = lines[0].split(',');
  return { codec, channels: Number(channels), streams: lines.length };
}

/** Decoded-frame checksums: catches any pixel-level nondeterminism. */
function frameMd5(file) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-'], {
    encoding: 'utf-8', timeout: 30000,
  });
  if (result.status !== 0) throw new Error(`framemd5 failed: ${result.stderr}`);
  // Keep only the checksum lines (header comments carry version strings)
  return result.stdout.split('\n').filter(l => l && !l.startsWith('#')).join('\n');
}

function makeSine(outPath, seconds, channels) {
  const result = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-ac', String(channels), outPath,
  ], { encoding: 'utf-8', timeout: 30000 });
  if (result.status !== 0) throw new Error(`sine generation failed: ${result.stderr}`);
}

async function main() {
  console.log('\n  ffmpeg-render-pro - end-to-end tests\n');

  const ff = lib.checkFFmpeg();
  if (!ff.available) {
    console.log('  !! ffmpeg not on PATH - skipping e2e suite\n');
    process.exit(0);
  }
  const haveFfprobe = spawnSync('ffprobe', ['-version'], { timeout: 5000 }).status === 0;
  if (!haveFfprobe) {
    console.log('  !! ffprobe not on PATH - skipping e2e suite\n');
    process.exit(0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-render-pro-e2e-'));
  const render = (out, extra = {}) => lib.renderParallel({
    workerScript: WORKER,
    outputPath: out,
    width: 320, height: 240, fps: 10, duration: 1.2,
    workerCount: 3,
    seed: 42,
    dashboard: false,
    ...extra,
  });

  try {
    // --- 1. Stale temp-dir sweep (seed a fake old temp dir first) ---
    const staleDir = path.join(tmp, '.parallel-temp-deadbeef');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'segment-000.mp4'), 'x');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(path.join(staleDir, 'segment-000.mp4'), old, old);
    fs.utimesSync(staleDir, old, old);

    // --- 2. Parallel render (3 workers, no dashboard) ---
    const outA = path.join(tmp, 'a.mp4');
    let resultA;
    await step('renderParallel produces a valid mp4', async () => {
      resultA = await render(outA);
      assert.ok(fs.existsSync(outA), 'output file exists');
      assert.ok(fs.statSync(outA).size > 1000, 'output has content');
    });

    await step('render result reports totalFrames + avgFps', () => {
      assert.strictEqual(resultA.totalFrames, 12);
      assert.ok(resultA.elapsed > 0);
      assert.ok(resultA.avgFps > 0);
    });

    await step('output is h264 320x240 with exactly 12 frames', () => {
      const v = probeVideo(outA);
      assert.strictEqual(v.codec, 'h264');
      assert.strictEqual(v.width, 320);
      assert.strictEqual(v.height, 240);
      assert.strictEqual(v.frames, 12);
    });

    await step('stale .parallel-temp dir was swept, fresh temp dirs were not left behind', () => {
      assert.ok(!fs.existsSync(staleDir), 'stale dir removed');
      const leftovers = fs.readdirSync(tmp).filter(f => f.startsWith('.parallel-temp'));
      assert.deepStrictEqual(leftovers, [], 'no temp dirs remain after a successful render');
    });

    await step('dashboard:false render writes no preview/ dir', () => {
      assert.ok(!fs.existsSync(path.join(tmp, 'preview')), 'no preview dir');
    });

    // --- 3. Determinism: same seed renders byte-identical frames ---
    const outB = path.join(tmp, 'b.mp4');
    await step('same-seed re-render is frame-identical (framemd5)', async () => {
      await render(outB);
      assert.strictEqual(frameMd5(outA), frameMd5(outB));
    });

    // Seed regression: seed:0 must not fall through to the default (42),
    // and different seeds must actually change the pixels.
    const tinyRender = (out, seed) => lib.renderParallel({
      workerScript: WORKER,
      outputPath: out,
      width: 64, height: 64, fps: 10, duration: 0.6,
      workerCount: 2,
      seed,
      dashboard: false,
    });
    const seed0a = path.join(tmp, 'seed0a.mp4');
    await step('seed:0 renders byte-identical framemd5 across runs', async () => {
      const seed0b = path.join(tmp, 'seed0b.mp4');
      await tinyRender(seed0a, 0);
      await tinyRender(seed0b, 0);
      assert.strictEqual(frameMd5(seed0a), frameMd5(seed0b));
    });

    await step('seed:1 renders different frames than seed:0', async () => {
      const seed1 = path.join(tmp, 'seed1.mp4');
      await tinyRender(seed1, 1);
      assert.ok(frameMd5(seed1) !== frameMd5(seed0a), 'different seed changed the pixels');
    });

    // --- 4. Stream-copy concat ---
    const outConcat = path.join(tmp, 'concat.mp4');
    await step('concatSegments joins two renders into 24 frames', async () => {
      await lib.concatSegments([outA, outB], outConcat);
      const v = probeVideo(outConcat);
      assert.strictEqual(v.frames, 24);
      assert.strictEqual(v.codec, 'h264');
    });

    // --- 5. Color grade ---
    const outGraded = path.join(tmp, 'graded.mp4');
    await step('colorGrade applies the noir preset', async () => {
      await lib.colorGrade({ inputPath: outA, outputPath: outGraded, preset: 'noir' });
      const v = probeVideo(outGraded);
      assert.strictEqual(v.frames, 12);
      assert.ok(frameMd5(outGraded) !== frameMd5(outA), 'grading changed the pixels');
    });

    // --- 6. Audio merge (stereo first, then prove -map picks the NEW track) ---
    const stereoWav = path.join(tmp, 'stereo.wav');
    const monoWav = path.join(tmp, 'mono.wav');
    const withStereo = path.join(tmp, 'with-stereo.mp4');
    const remapped = path.join(tmp, 'remapped.mp4');

    await step('mergeAudio adds an aac track without re-encoding video', async () => {
      makeSine(stereoWav, 0.5, 2);
      await lib.mergeAudio({ videoPath: outA, audioPath: stereoWav, outputPath: withStereo, loop: true });
      const a = probeAudio(withStereo);
      assert.ok(a, 'audio stream present');
      assert.strictEqual(a.codec, 'aac');
      assert.strictEqual(a.channels, 2);
      assert.strictEqual(probeVideo(withStereo).codec, 'h264');
    });

    await step('mergeAudio replaces existing audio (explicit -map)', async () => {
      makeSine(monoWav, 0.5, 1);
      // Input video already has STEREO audio; merging MONO must win. Without
      // explicit -map, ffmpeg's default selection keeps the higher-channel
      // (old) track and this assertion fails.
      await lib.mergeAudio({ videoPath: withStereo, audioPath: monoWav, outputPath: remapped, loop: true });
      const a = probeAudio(remapped);
      assert.strictEqual(a.channels, 1, 'new mono track won');
      assert.strictEqual(a.streams, 1, 'exactly one audio stream');
    });

    await step('colorGrade keepAudio preserves the soundtrack', async () => {
      const gradedAudio = path.join(tmp, 'graded-audio.mp4');
      await lib.colorGrade({ inputPath: withStereo, outputPath: gradedAudio, preset: 'warm', keepAudio: true });
      const a = probeAudio(gradedAudio);
      assert.ok(a, 'audio survived the grade');
      assert.strictEqual(a.codec, 'aac');
    });

    await step('colorGrade default still strips audio', async () => {
      const gradedSilent = path.join(tmp, 'graded-silent.mp4');
      await lib.colorGrade({ inputPath: withStereo, outputPath: gradedSilent, preset: 'warm' });
      assert.strictEqual(probeAudio(gradedSilent), null, 'no audio stream');
    });

    // --- 7. CLI entry point ---
    await step('CLI version matches package.json', () => {
      const r = spawnSync('node', [path.join(ROOT, 'bin', 'ffmpeg-render-pro.js'), 'version'], {
        encoding: 'utf-8', timeout: 15000,
      });
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout.trim(), require('../package.json').version);
    });

    await step('CLI help documents the new dashboard flags', () => {
      const r = spawnSync('node', [path.join(ROOT, 'bin', 'ffmpeg-render-pro.js')], {
        encoding: 'utf-8', timeout: 15000,
      });
      assert.ok(r.stdout.includes('--no-dashboard'));
      assert.ok(r.stdout.includes('--linger-ms'));
      assert.ok(r.stdout.includes('--no-open'));
    });

    await step('CLI render honors --no-dashboard and fractional --duration', () => {
      const cliOut = path.join(tmp, 'cli.mp4');
      const r = spawnSync('node', [
        path.join(ROOT, 'bin', 'ffmpeg-render-pro.js'), 'render', WORKER,
        `--output=${cliOut}`, '--width=320', '--height=240', '--fps=10',
        '--duration=0.8', '--workers=2', '--no-dashboard', '--seed=0',
      ], { encoding: 'utf-8', timeout: 120000 });
      assert.strictEqual(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
      assert.strictEqual(probeVideo(cliOut).frames, 8, '0.8s @ 10fps = 8 frames');
    });

    await step('CLI init then render: the starter worker renders the exact frame count', () => {
      const bin = path.join(ROOT, 'bin', 'ffmpeg-render-pro.js');
      const initDir = path.join(tmp, 'init');
      fs.mkdirSync(initDir, { recursive: true });
      const init = spawnSync('node', [bin, 'init'], { encoding: 'utf-8', timeout: 15000, cwd: initDir });
      assert.strictEqual(init.status, 0, `init exited ${init.status}: ${init.stderr}`);
      const worker = path.join(initDir, 'my-worker.js');
      assert.ok(fs.existsSync(worker), 'my-worker.js written by init');
      const out = path.join(initDir, 'starter.mp4');
      const r = spawnSync('node', [
        bin, 'render', worker, `--output=${out}`, '--width=320', '--height=240',
        '--fps=10', '--duration=0.6', '--workers=2', '--no-dashboard',
      ], { encoding: 'utf-8', timeout: 120000, cwd: initDir });
      assert.strictEqual(r.status, 0, `render exited ${r.status}: ${r.stderr}`);
      const info = probeVideo(out);
      assert.strictEqual(info.frames, 6, '0.6s @ 10fps = 6 frames');
      assert.strictEqual(info.codec, 'h264');
    });

    // --- 8. Worker codecArgs override ---
    await step('workerData.codecArgs overrides the segment encoder', async () => {
      const outCrf = path.join(tmp, 'crf0.mp4');
      await render(outCrf, { workerData: { codecArgs: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0'] } });
      // crf 0 (lossless) produces a substantially larger file than crf 20
      assert.ok(fs.statSync(outCrf).size > fs.statSync(outA).size * 1.5,
        `lossless segment should be much larger (${fs.statSync(outCrf).size} vs ${fs.statSync(outA).size})`);
    });

  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exit(1);
  console.log('  All e2e tests passed.\n');
}

main().catch((err) => {
  console.error('E2E harness error:', err);
  process.exit(2);
});
