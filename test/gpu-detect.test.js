#!/usr/bin/env node
/**
 * GPU Detection Tests - ffmpeg-render-pro
 *
 * Covers the gpu-detect module: cache lifecycle (schema version, 7-day
 * expiry, ffmpeg-version binding, FFMPEG_RENDER_PRO_CACHE_DIR override),
 * codec arg shapes for every encoder (including the inverted VideoToolbox
 * quality mapping and the VA-API device/hwupload chain), real-args probing,
 * and platform filtering.
 *
 * Zero-dependency, no GPU required: probe assertions only target libx264
 * (always present in ffmpeg) and a nonexistent encoder, and are skipped
 * entirely when ffmpeg is not on PATH. Run with: node test/gpu-detect.test.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Required BEFORE FFMPEG_RENDER_PRO_CACHE_DIR is set below: proves the
// override is read at call time, not module load.
const gpu = require('../src/core/gpu-detect.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write('.');
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write('x');
  }
}

function main() {
  console.log('\n  ffmpeg-render-pro - gpu-detect tests\n');

  // =========================================================================
  // Cache lifecycle (via FFMPEG_RENDER_PRO_CACHE_DIR override)
  // =========================================================================
  const cacheDir = path.join(os.tmpdir(), 'ffmpeg-render-pro-gpu-test-' + Date.now());
  fs.mkdirSync(cacheDir, { recursive: true });
  process.env.FFMPEG_RENDER_PRO_CACHE_DIR = cacheDir;
  const cacheFile = path.join(cacheDir, 'gpu-cache.json');

  // A sentinel encoder name proves whether detectGPU served the cache (it
  // returns the cached result verbatim) or fell through to a real probe
  // (which can never produce this name).
  const SENTINEL = {
    h264: 'sentinel-encoder',
    hevc: null,
    label: 'SENTINEL (cache test)',
    isGpu: false,
    all: [{ name: 'sentinel-encoder', label: 'SENTINEL', codec: 'h264' }],
  };
  const writeCache = (overrides = {}) => {
    fs.writeFileSync(cacheFile, JSON.stringify({
      result: SENTINEL,
      timestamp: Date.now(),
      ffmpegVersion: gpu.getFFmpegVersion(),
      cacheSchemaVersion: 3,
      ...overrides,
    }, null, 2));
  };

  writeCache();
  test('valid cache is accepted (schema 3, fresh, matching ffmpeg version)', () => {
    assert.strictEqual(gpu.detectGPU().h264, 'sentinel-encoder');
  });

  test('cache dir override is read at call time (module was required first)', () => {
    assert.ok(fs.existsSync(cacheFile), 'cache file exists in the override dir');
  });

  writeCache({ cacheSchemaVersion: 2 });
  test('cache with an old schema version is rejected', () => {
    assert.notStrictEqual(gpu.detectGPU().h264, 'sentinel-encoder');
  });

  test('rejected cache triggers a re-probe that saves schema 3 into the override dir', () => {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    assert.strictEqual(data.cacheSchemaVersion, 3);
    assert.notStrictEqual(data.result.h264, 'sentinel-encoder');
  });

  writeCache({ timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000 });
  test('cache older than 7 days is rejected', () => {
    assert.notStrictEqual(gpu.detectGPU().h264, 'sentinel-encoder');
  });

  writeCache({ ffmpegVersion: 'not-the-real-version-0.0.0' });
  test('cache from a different ffmpeg version is rejected', () => {
    assert.notStrictEqual(gpu.detectGPU().h264, 'sentinel-encoder');
  });

  fs.writeFileSync(cacheFile, 'not json {{{');
  test('corrupt cache file falls through to probing without throwing', () => {
    assert.notStrictEqual(gpu.detectGPU().h264, 'sentinel-encoder');
  });

  delete process.env.FFMPEG_RENDER_PRO_CACHE_DIR;
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}

  // =========================================================================
  // getCodecArgs shapes
  // =========================================================================
  test('libx264 args (crf path)', () => {
    assert.deepStrictEqual(gpu.getCodecArgs('libx264'),
      ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20']);
  });
  test('h264_nvenc args', () => {
    assert.deepStrictEqual(gpu.getCodecArgs('h264_nvenc', { cq: 19 }),
      ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '19']);
  });
  test('hevc_nvenc args tag hvc1', () => {
    assert.deepStrictEqual(gpu.getCodecArgs('hevc_nvenc'),
      ['-c:v', 'hevc_nvenc', '-preset', 'p4', '-cq', '20', '-tag:v', 'hvc1']);
  });
  test('h264_amf args (cqp)', () => {
    assert.deepStrictEqual(gpu.getCodecArgs('h264_amf', { cq: 22 }),
      ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '22']);
  });
  test('hevc_amf args tag hvc1', () => {
    const args = gpu.getCodecArgs('hevc_amf');
    assert.ok(args.includes('hevc_amf') && args.includes('cqp') && args.includes('hvc1'));
  });
  test('h264_qsv args (global_quality)', () => {
    assert.deepStrictEqual(gpu.getCodecArgs('h264_qsv', { cq: 23 }),
      ['-c:v', 'h264_qsv', '-global_quality', '23']);
  });
  test('hevc_qsv args tag hvc1', () => {
    assert.deepStrictEqual(gpu.getCodecArgs('hevc_qsv', { cq: 23 }),
      ['-c:v', 'hevc_qsv', '-global_quality', '23', '-tag:v', 'hvc1']);
  });
  test('unknown encoder falls back to the crf path', () => {
    assert.deepStrictEqual(gpu.getCodecArgs('libx265', { crf: 22 }),
      ['-c:v', 'libx265', '-preset', 'fast', '-crf', '22']);
  });
  test('preset override is honored', () => {
    assert.ok(gpu.getCodecArgs('libx264', { preset: 'veryslow' }).includes('veryslow'));
    assert.ok(gpu.getCodecArgs('h264_nvenc', { preset: 'p7' }).includes('p7'));
  });

  // --- VideoToolbox quality mapping: q = clamp(round(100 - 2*cq), 1, 100) ---
  const vtq = (cq, enc = 'h264_videotoolbox') => {
    const args = gpu.getCodecArgs(enc, cq === undefined ? {} : { cq });
    const i = args.indexOf('-q:v');
    assert.ok(i !== -1, enc + ' emits -q:v');
    return Number(args[i + 1]);
  };
  test('videotoolbox: default cq 20 maps to -q:v 60', () => {
    assert.deepStrictEqual(gpu.getCodecArgs('h264_videotoolbox'),
      ['-c:v', 'h264_videotoolbox', '-q:v', '60']);
  });
  test('videotoolbox: q = clamp(round(100 - 2*cq), 1, 100)', () => {
    assert.strictEqual(vtq(0), 100);
    assert.strictEqual(vtq(18), 64);
    assert.strictEqual(vtq(20), 60);
    assert.strictEqual(vtq(50), 1);
    assert.strictEqual(vtq(80), 1); // clamped at VT's minimum
  });
  test('videotoolbox: lower cq (better) maps to higher -q:v (better)', () => {
    assert.ok(vtq(10) > vtq(30), 'quality knob direction matches the package convention');
  });
  test('hevc_videotoolbox: same mapping plus hvc1 tag', () => {
    assert.deepStrictEqual(gpu.getCodecArgs('hevc_videotoolbox', { cq: 18 }),
      ['-c:v', 'hevc_videotoolbox', '-q:v', '64', '-tag:v', 'hvc1']);
  });

  // --- VA-API: device init + hwupload chain baked into the args ---
  test('h264_vaapi args carry device init + hwupload chain', () => {
    assert.deepStrictEqual(gpu.getCodecArgs('h264_vaapi', { cq: 24 }), [
      '-init_hw_device', 'vaapi=va', '-filter_hw_device', 'va',
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi', '-qp', '24',
    ]);
  });
  test('hevc_vaapi args carry device init + hwupload chain + hvc1', () => {
    assert.deepStrictEqual(gpu.getCodecArgs('hevc_vaapi', { cq: 24 }), [
      '-init_hw_device', 'vaapi=va', '-filter_hw_device', 'va',
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'hevc_vaapi', '-qp', '24', '-tag:v', 'hvc1',
    ]);
  });

  // --- getEncoderIO: the split view getCodecArgs is built from ---
  test('getEncoderIO: vaapi splits input args / filter / output args', () => {
    const io = gpu.getEncoderIO('h264_vaapi');
    assert.deepStrictEqual(io.inputArgs, ['-init_hw_device', 'vaapi=va', '-filter_hw_device', 'va']);
    assert.strictEqual(io.filter, 'format=nv12,hwupload');
    assert.deepStrictEqual(io.outputArgs, ['-c:v', 'h264_vaapi', '-qp', '20']);
  });
  test('getEncoderIO: software-frame encoders have no input args or filter', () => {
    for (const enc of ['libx264', 'h264_nvenc', 'h264_videotoolbox', 'h264_amf', 'h264_qsv']) {
      const io = gpu.getEncoderIO(enc);
      assert.deepStrictEqual(io.inputArgs, [], enc);
      assert.strictEqual(io.filter, null, enc);
      assert.ok(io.outputArgs.includes(enc), enc);
    }
  });
  test('getCodecArgs === inputArgs + [-vf filter] + outputArgs for every encoder', () => {
    const encoders = [
      'libx264',
      'h264_nvenc', 'hevc_nvenc',
      'h264_videotoolbox', 'hevc_videotoolbox',
      'h264_amf', 'hevc_amf',
      'h264_vaapi', 'hevc_vaapi',
      'h264_qsv', 'hevc_qsv',
    ];
    for (const enc of encoders) {
      const io = gpu.getEncoderIO(enc, { cq: 21, crf: 21 });
      const expected = [
        ...io.inputArgs,
        ...(io.filter ? ['-vf', io.filter] : []),
        ...io.outputArgs,
      ];
      assert.deepStrictEqual(gpu.getCodecArgs(enc, { cq: 21, crf: 21 }), expected, enc);
    }
  });

  // =========================================================================
  // validateEncoder probes with real production args
  // =========================================================================
  const ff = gpu.checkFFmpeg();
  if (ff.available) {
    test('validateEncoder(libx264) passes with real production args', () => {
      assert.strictEqual(gpu.validateEncoder('libx264'), true);
    });
    test('validateEncoder rejects a nonexistent encoder', () => {
      assert.strictEqual(gpu.validateEncoder('h264_not_a_real_encoder'), false);
    });
  } else {
    console.log('\n  !! ffmpeg not on PATH - skipping probe tests');
  }

  // =========================================================================
  // Platform filtering (filter logic, independent of the host OS)
  // =========================================================================
  test('darwin candidates exclude Quick Sync (no QSV on macOS)', () => {
    const c = gpu.getEncoderCandidates('darwin');
    const names = [...c.h264, ...c.hevc].map(e => e.name);
    assert.ok(!names.some(n => n.includes('qsv')), 'qsv listed on darwin: ' + names.join(','));
    assert.ok(names.includes('h264_videotoolbox'));
    assert.ok(names.includes('hevc_videotoolbox'));
  });
  test('win32 candidates include nvenc/amf/qsv, exclude videotoolbox/vaapi', () => {
    const c = gpu.getEncoderCandidates('win32');
    const names = c.h264.map(e => e.name);
    assert.deepStrictEqual(names, ['h264_nvenc', 'h264_amf', 'h264_qsv']);
  });
  test('linux candidates include nvenc/vaapi/qsv, exclude videotoolbox/amf', () => {
    const c = gpu.getEncoderCandidates('linux');
    const names = c.h264.map(e => e.name);
    assert.deepStrictEqual(names, ['h264_nvenc', 'h264_vaapi', 'h264_qsv']);
  });
  test('candidates preserve priority order for hevc too', () => {
    const c = gpu.getEncoderCandidates('linux');
    assert.deepStrictEqual(c.hevc.map(e => e.name), ['hevc_nvenc', 'hevc_vaapi', 'hevc_qsv']);
  });

  // --- Summary ---
  console.log(`\n\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const f of failures) {
      console.error(`  ✗ ${f.name}`);
      console.error('    ', f.err.message);
    }
    process.exit(1);
  }
  console.log('  All gpu-detect tests passed.\n');
}

try {
  main();
} catch (err) {
  console.error('gpu-detect test harness error:', err);
  process.exit(1);
}
