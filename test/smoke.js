#!/usr/bin/env node
/**
 * Smoke Tests - ffmpeg-render-pro
 *
 * Fast tests that don't render full videos. Meant to catch obvious
 * regressions: module exports, input validation, path-safety,
 * ffmpeg availability, config math. Runs in ~5-10s on a cold machine.
 *
 * Intentionally zero-dependency (no mocha/jest) so `npm test` just works.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => { passed++; process.stdout.write('.'); },
        (err) => { failed++; failures.push({ name, err }); process.stdout.write('x'); }
      );
    }
    passed++;
    process.stdout.write('.');
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write('x');
  }
}

async function main() {
  console.log('\n  ffmpeg-render-pro - smoke tests\n');

  // --- Module exports ---
  const lib = require('../src/index.js');
  test('index exports renderParallel', () => assert.strictEqual(typeof lib.renderParallel, 'function'));
  test('index exports detectGPU',      () => assert.strictEqual(typeof lib.detectGPU, 'function'));
  test('index exports getConfig',      () => assert.strictEqual(typeof lib.getConfig, 'function'));
  test('index exports concatSegments', () => assert.strictEqual(typeof lib.concatSegments, 'function'));
  test('index exports colorGrade',     () => assert.strictEqual(typeof lib.colorGrade, 'function'));
  test('index exports mergeAudio',     () => assert.strictEqual(typeof lib.mergeAudio, 'function'));
  test('index exports startDashboard', () => assert.strictEqual(typeof lib.startDashboard, 'function'));
  test('index exports saveCheckpoint', () => assert.strictEqual(typeof lib.saveCheckpoint, 'function'));
  test('COLOR_PRESETS has 5 presets',  () => assert.deepStrictEqual(Object.keys(lib.COLOR_PRESETS).sort(), ['cinematic', 'cool', 'noir', 'vintage', 'warm']));

  // --- checkFFmpeg ---
  const ff = lib.checkFFmpeg();
  test('checkFFmpeg returns object',   () => assert.strictEqual(typeof ff, 'object'));
  test('checkFFmpeg has available',    () => assert.strictEqual(typeof ff.available, 'boolean'));
  if (!ff.available) {
    console.log('\n  !! ffmpeg not on PATH - skipping tests that require it');
  }

  // --- validateResolution ---
  test('validateResolution accepts 1920x1080', () => lib.validateResolution(1920, 1080));
  test('validateResolution accepts 1x1',        () => lib.validateResolution(1, 1));
  test('validateResolution rejects negatives',  () => assert.throws(() => lib.validateResolution(-1, 100)));
  test('validateResolution rejects 0',          () => assert.throws(() => lib.validateResolution(0, 100)));
  test('validateResolution rejects NaN',        () => assert.throws(() => lib.validateResolution(NaN, 100)));
  test('validateResolution rejects >8K',        () => assert.throws(() => lib.validateResolution(99999, 1080)));

  // --- getConfig / getOptimalWorkers ---
  const cfg = lib.getConfig({ width: 1920, height: 1080, fps: 30, duration: 5 });
  test('getConfig returns totalFrames', () => assert.strictEqual(cfg.totalFrames, 150));
  test('getConfig returns tier',        () => assert.strictEqual(cfg.tier, '1080p'));
  test('getConfig workers >= 1',        () => assert.ok(cfg.workers >= 1));
  test('getConfig workers <= 8',        () => assert.ok(cfg.workers <= 8));

  test('getResolutionTier 480p',  () => assert.strictEqual(lib.getResolutionTier(640, 480), '480p'));
  test('getResolutionTier 720p',  () => assert.strictEqual(lib.getResolutionTier(1280, 720), '720p'));
  test('getResolutionTier 1080p', () => assert.strictEqual(lib.getResolutionTier(1920, 1080), '1080p'));
  test('getResolutionTier 4k',    () => assert.strictEqual(lib.getResolutionTier(3840, 2160), '4k'));

  // --- planWorkers: true worker count after ceil() chunking (no phantoms) ---
  const { planWorkers } = require('../src/core/config.js');
  test('planWorkers 150f/8 -> 8 workers', () => assert.strictEqual(planWorkers(150, 8).workers, 8));
  test('planWorkers 10f/8 -> 5 real workers', () => assert.strictEqual(planWorkers(10, 8).workers, 5));
  test('planWorkers 1f/8 -> 1 worker', () => assert.strictEqual(planWorkers(1, 8).workers, 1));
  test('planWorkers covers every frame with no idle worker', () => {
    const { workers, framesPerWorker } = planWorkers(10, 8);
    assert.ok(workers * framesPerWorker >= 10, 'all frames covered');
    assert.ok((workers - 1) * framesPerWorker < 10, 'no worker starts past the end');
  });

  // --- getCodecArgs: HEVC variants carry the hvc1 tag ---
  test('getCodecArgs libx264',                () => assert.ok(lib.getCodecArgs('libx264').includes('libx264')));
  test('getCodecArgs hevc_qsv tags hvc1',     () => assert.ok(lib.getCodecArgs('hevc_qsv', { cq: 18 }).includes('hvc1')));
  test('getCodecArgs hevc_videotoolbox hvc1', () => assert.ok(lib.getCodecArgs('hevc_videotoolbox', { cq: 18 }).includes('hvc1')));

  // --- Dashboard path-safety (the critical security fix) ---
  const { resolveSafePath } = require('../src/core/dashboard-server.js');
  const tmp = path.join(os.tmpdir(), 'ffmpeg-render-pro-smoke-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  test('resolveSafePath: /dashboard.html is allowed',
    () => assert.ok(resolveSafePath('/dashboard.html', tmp)));
  test('resolveSafePath: / defaults to dashboard.html',
    () => assert.ok(resolveSafePath('/', tmp).endsWith('dashboard.html')));
  test('resolveSafePath: worker-0.json is allowed',
    () => assert.ok(resolveSafePath('/worker-0.json', tmp)));
  test('resolveSafePath: /../secret is rejected',
    () => assert.strictEqual(resolveSafePath('/../secret', tmp), null));
  test('resolveSafePath: URL-encoded ../ is rejected',
    () => assert.strictEqual(resolveSafePath('/%2E%2E/secret', tmp), null));
  test('resolveSafePath: double-encoded ../ is rejected',
    () => assert.strictEqual(resolveSafePath('/%252E%252E/secret', tmp), null));
  test('resolveSafePath: null byte is rejected',
    () => assert.strictEqual(resolveSafePath('/dashboard.html%00.txt', tmp), null));
  test('resolveSafePath: backslash traversal rejected',
    () => assert.strictEqual(resolveSafePath('/..%5Csecret', tmp), null));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  // --- Checkpoint round-trip ---
  const cpDir = path.join(os.tmpdir(), 'ffmpeg-render-pro-cp-' + Date.now());
  fs.mkdirSync(cpDir, { recursive: true });
  const systems = {
    camera: {
      state: { x: 10, y: 20 },
      getState() { return { ...this.state }; },
      setState(s) { this.state = { ...s }; },
    },
  };
  lib.saveCheckpoint(cpDir, 500, systems);
  const loaded = lib.loadCheckpoint(cpDir, 999);
  test('saveCheckpoint + loadCheckpoint round-trips', () => {
    assert.strictEqual(loaded._frame, 500);
    assert.deepStrictEqual(loaded.camera, { x: 10, y: 20 });
  });
  test('loadCheckpoint returns null for empty dir', () => {
    const emptyDir = path.join(os.tmpdir(), 'ffmpeg-render-pro-cp-empty-' + Date.now());
    fs.mkdirSync(emptyDir, { recursive: true });
    const result = lib.loadCheckpoint(emptyDir, 100);
    fs.rmSync(emptyDir, { recursive: true, force: true });
    assert.strictEqual(result, null);
  });
  test('loadCheckpoint skips a corrupted checkpoint and falls back to an older one', () => {
    // frame 800 is truncated garbage; frame 500 (saved above) is valid
    fs.writeFileSync(path.join(cpDir, 'checkpoint-00000800.json'), '{"_frame":800,"camera":{"x"');
    const result = lib.loadCheckpoint(cpDir, 999);
    assert.ok(result, 'fell back to a valid checkpoint');
    assert.strictEqual(result._frame, 500);
  });
  test('loadCheckpoint returns null when every checkpoint is corrupt', () => {
    const corruptDir = path.join(os.tmpdir(), 'ffmpeg-render-pro-cp-corrupt-' + Date.now());
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, 'checkpoint-00000100.json'), 'not json');
    const result = lib.loadCheckpoint(corruptDir, 999);
    fs.rmSync(corruptDir, { recursive: true, force: true });
    assert.strictEqual(result, null);
  });
  try { fs.rmSync(cpDir, { recursive: true, force: true }); } catch {}

  // --- mergeAudio / colorGrade input validation (fails before spawning ffmpeg) ---
  await test('mergeAudio rejects missing videoPath', async () => {
    await assert.rejects(() => lib.mergeAudio({ audioPath: 'a.mp3', outputPath: 'o.mp4' }), /videoPath is required/);
  });
  await test('mergeAudio rejects non-string audioPath', async () => {
    await assert.rejects(() => lib.mergeAudio({ videoPath: 'v.mp4', audioPath: 42, outputPath: 'o.mp4' }), /audioPath is required/);
  });
  await test('colorGrade rejects missing inputPath', async () => {
    await assert.rejects(() => lib.colorGrade({ outputPath: 'o.mp4', preset: 'noir' }), /inputPath is required/);
  });
  await test('colorGrade still rejects when no filter or preset given', async () => {
    await assert.rejects(() => lib.colorGrade({ inputPath: 'i.mp4', outputPath: 'o.mp4' }), /No filter provided/);
  });

  // --- colorGrade argv composition (no ffmpeg spawned) ---
  {
    const { buildColorGradeArgs, PRESETS } = require('../src/core/color-grade.js');
    const base = { inputPath: 'in.mp4', outputPath: 'out.mp4', crf: 18, cq: 18, encoderPreset: 'medium', keepAudio: false };
    const countVf = (args) => args.filter((a) => a === '-vf').length;
    const vfOf = (args) => args[args.indexOf('-vf') + 1];

    test('colorGrade libx264 argv: one -vf carrying the grade, historical shape', () => {
      const args = buildColorGradeArgs({ ...base, filterChain: PRESETS.noir, codec: 'libx264' });
      assert.strictEqual(countVf(args), 1);
      assert.strictEqual(vfOf(args), PRESETS.noir);
      assert.deepStrictEqual(args.slice(0, 3), ['-y', '-i', 'in.mp4']);
      assert.ok(args.includes('-an'), 'default strips audio');
      assert.strictEqual(args[args.length - 1], 'out.mp4');
    });
    test('colorGrade VA-API argv: grade and hwupload merged into ONE -vf (regression: grade was dropped)', () => {
      const args = buildColorGradeArgs({ ...base, filterChain: PRESETS.warm, codec: 'h264_vaapi' });
      assert.strictEqual(countVf(args), 1, 'exactly one -vf');
      assert.strictEqual(vfOf(args), `${PRESETS.warm},format=nv12,hwupload`);
      const initIdx = args.indexOf('-init_hw_device');
      assert.ok(initIdx !== -1 && initIdx < args.indexOf('-i'), 'device init precedes -i');
      assert.ok(args.includes('h264_vaapi'));
    });
    test('colorGrade keepAudio argv maps video + optional audio with stream copy', () => {
      const args = buildColorGradeArgs({ ...base, filterChain: 'eq=contrast=1.1', codec: 'libx264', keepAudio: true });
      assert.ok(!args.includes('-an'));
      assert.ok(args.includes('0:a?') && args.includes('copy'));
    });
  }

  // --- Backward-compat guard: every 1.3.x export must still exist ---
  test('all v1.3.x exports are still present', () => {
    const expected = [
      'renderParallel', 'createEncoder',
      'detectGPU', 'getCodecArgs', 'getFFmpegVersion', 'checkFFmpeg', 'validateResolution',
      'getOptimalWorkers', 'getConfig', 'getResolutionTier',
      'concatSegments', 'colorGrade', 'COLOR_PRESETS', 'mergeAudio',
      'startDashboard', 'ProgressTracker',
      'saveCheckpoint', 'loadCheckpoint', 'restoreCheckpoint', 'generateCheckpoints', 'listCheckpoints', 'CHECKPOINT_INTERVAL',
    ];
    for (const name of expected) {
      assert.ok(name in lib, `missing export: ${name}`);
    }
  });

  test('planWorkers 0 frames clamps to 1 worker', () => {
    const { planWorkers: pw } = require('../src/core/config.js');
    assert.strictEqual(pw(0, 8).workers, 1);
  });

  // --- renderParallel input validation (without actually rendering) ---
  await test('renderParallel rejects invalid fps', async () => {
    await assert.rejects(
      () => lib.renderParallel({
        workerScript: path.join(__dirname, '..', 'examples', 'basic-worker.js'),
        outputPath: path.join(os.tmpdir(), 'smoke-invalid-fps.mp4'),
        fps: 0, duration: 1, dashboard: false,
      }),
      /Invalid fps/,
    );
  });
  await test('renderParallel rejects invalid duration', async () => {
    await assert.rejects(
      () => lib.renderParallel({
        workerScript: path.join(__dirname, '..', 'examples', 'basic-worker.js'),
        outputPath: path.join(os.tmpdir(), 'smoke-invalid-duration.mp4'),
        fps: 30, duration: -1, dashboard: false,
      }),
      /Invalid duration/,
    );
  });
  await test('renderParallel rejects missing worker script', async () => {
    await assert.rejects(
      () => lib.renderParallel({
        workerScript: '/no/such/path/worker.js',
        outputPath: path.join(os.tmpdir(), 'smoke-missing-worker.mp4'),
        fps: 30, duration: 1, dashboard: false,
      }),
      /Worker script not found/,
    );
  });
  await test('renderParallel rejects invalid port', async () => {
    await assert.rejects(
      () => lib.renderParallel({
        workerScript: path.join(__dirname, '..', 'examples', 'basic-worker.js'),
        outputPath: path.join(os.tmpdir(), 'smoke-invalid-port.mp4'),
        fps: 30, duration: 1, dashboardPort: 99999, dashboard: false,
      }),
      /Invalid dashboardPort/,
    );
  });
  await test('renderParallel rejects odd dimensions (yuv420p)', async () => {
    await assert.rejects(
      () => lib.renderParallel({
        workerScript: path.join(__dirname, '..', 'examples', 'basic-worker.js'),
        outputPath: path.join(os.tmpdir(), 'smoke-odd.mp4'),
        width: 1921, height: 1080, fps: 30, duration: 1, dashboard: false,
      }),
      /even width and height/,
    );
  });
  await test('renderParallel rejects missing outputPath', async () => {
    await assert.rejects(
      () => lib.renderParallel({
        workerScript: path.join(__dirname, '..', 'examples', 'basic-worker.js'),
        fps: 30, duration: 1, dashboard: false,
      }),
      /outputPath is required/,
    );
  });

  // --- concatSegments guards against missing/empty segments ---
  await test('concatSegments rejects missing/empty segments', async () => {
    await assert.rejects(
      () => lib.concatSegments(
        [path.join(os.tmpdir(), 'ffmpeg-render-pro-not-a-real-segment-' + Date.now() + '.mp4')],
        path.join(os.tmpdir(), 'smoke-concat-out.mp4'),
      ),
      /missing or empty/,
    );
  });

  // --- Summary ---
  console.log(`\n\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const f of failures) {
      console.error(`  \u2717 ${f.name}`);
      console.error('    ', f.err.message);
    }
    process.exit(1);
  }
  console.log('  All smoke tests passed.\n');
}

main().catch((err) => {
  console.error('Smoke test harness error:', err);
  process.exit(2);
});
