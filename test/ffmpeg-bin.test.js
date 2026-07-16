#!/usr/bin/env node
/**
 * ffmpeg-bin Tests - ffmpeg-render-pro
 *
 * Covers binary resolution via FFMPEG_RENDER_PRO_FFMPEG and
 * FFMPEG_RENDER_PRO_FFPROBE: PATH defaults, verbatim overrides, call-time
 * env reads (no module-load caching), sibling ffprobe derivation next to a
 * custom ffmpeg path, and an integration check that a bogus
 * FFMPEG_RENDER_PRO_FFMPEG makes checkFFmpeg report unavailable. The
 * integration check runs in a CHILD node process so gpu-detect's
 * module-level memoization cannot leak into or out of this test run.
 *
 * Zero-dependency, no ffmpeg required. Run with: node test/ffmpeg-bin.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Required BEFORE any env vars are touched below: proves the vars are read
// at call time, not captured at module load.
const { ffmpegBin, ffprobeBin } = require('../src/core/ffmpeg-bin.js');

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
  console.log('\n  ffmpeg-render-pro - ffmpeg-bin tests\n');

  const savedFfmpeg = process.env.FFMPEG_RENDER_PRO_FFMPEG;
  const savedFfprobe = process.env.FFMPEG_RENDER_PRO_FFPROBE;
  delete process.env.FFMPEG_RENDER_PRO_FFMPEG;
  delete process.env.FFMPEG_RENDER_PRO_FFPROBE;

  // =========================================================================
  // Defaults (env unset)
  // =========================================================================
  test('ffmpegBin() defaults to "ffmpeg" when env is unset', () => {
    assert.strictEqual(ffmpegBin(), 'ffmpeg');
  });
  test('ffprobeBin() defaults to "ffprobe" when env is unset', () => {
    assert.strictEqual(ffprobeBin(), 'ffprobe');
  });

  test('empty and whitespace-only values count as unset', () => {
    process.env.FFMPEG_RENDER_PRO_FFMPEG = '';
    process.env.FFMPEG_RENDER_PRO_FFPROBE = '   ';
    assert.strictEqual(ffmpegBin(), 'ffmpeg');
    assert.strictEqual(ffprobeBin(), 'ffprobe');
    delete process.env.FFMPEG_RENDER_PRO_FFMPEG;
    delete process.env.FFMPEG_RENDER_PRO_FFPROBE;
  });

  // =========================================================================
  // Overrides (returned verbatim, path need not exist)
  // =========================================================================
  const customFfmpeg = path.join(os.tmpdir(), 'custom-builds', 'ffmpeg.exe');
  const customFfprobe = path.join(os.tmpdir(), 'custom-builds', 'ffprobe.exe');

  test('ffmpegBin() returns FFMPEG_RENDER_PRO_FFMPEG verbatim', () => {
    process.env.FFMPEG_RENDER_PRO_FFMPEG = customFfmpeg;
    assert.strictEqual(ffmpegBin(), customFfmpeg);
  });
  test('ffprobeBin() returns FFMPEG_RENDER_PRO_FFPROBE verbatim', () => {
    process.env.FFMPEG_RENDER_PRO_FFPROBE = customFfprobe;
    assert.strictEqual(ffprobeBin(), customFfprobe);
    delete process.env.FFMPEG_RENDER_PRO_FFPROBE;
    delete process.env.FFMPEG_RENDER_PRO_FFMPEG;
  });

  // =========================================================================
  // Call-time reads (no module-load caching)
  // =========================================================================
  test('env is read at call time: changes between calls are honored', () => {
    assert.strictEqual(ffmpegBin(), 'ffmpeg');
    process.env.FFMPEG_RENDER_PRO_FFMPEG = '/opt/ffmpeg/bin/ffmpeg';
    assert.strictEqual(ffmpegBin(), '/opt/ffmpeg/bin/ffmpeg');
    process.env.FFMPEG_RENDER_PRO_FFMPEG = '/somewhere/else/ffmpeg';
    assert.strictEqual(ffmpegBin(), '/somewhere/else/ffmpeg');
    delete process.env.FFMPEG_RENDER_PRO_FFMPEG;
    assert.strictEqual(ffmpegBin(), 'ffmpeg');
  });

  // =========================================================================
  // Sibling ffprobe derivation (real files in a temp dir)
  // =========================================================================
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-bin-test-'));
  const fakeFfmpegExe = path.join(dir, 'ffmpeg.exe');
  const fakeFfprobeExe = path.join(dir, 'ffprobe.exe');
  fs.writeFileSync(fakeFfmpegExe, 'fake');
  fs.writeFileSync(fakeFfprobeExe, 'fake');

  test('sibling ffprobe is derived next to FFMPEG_RENDER_PRO_FFMPEG (extension preserved)', () => {
    process.env.FFMPEG_RENDER_PRO_FFMPEG = fakeFfmpegExe;
    assert.strictEqual(ffprobeBin(), fakeFfprobeExe);
  });

  test('explicit FFMPEG_RENDER_PRO_FFPROBE beats sibling derivation', () => {
    process.env.FFMPEG_RENDER_PRO_FFMPEG = fakeFfmpegExe;
    process.env.FFMPEG_RENDER_PRO_FFPROBE = '/explicit/ffprobe';
    assert.strictEqual(ffprobeBin(), '/explicit/ffprobe');
    delete process.env.FFMPEG_RENDER_PRO_FFPROBE;
  });

  test('derivation works for extensionless binaries too', () => {
    const bareFfmpeg = path.join(dir, 'ffmpeg');
    const bareFfprobe = path.join(dir, 'ffprobe');
    fs.writeFileSync(bareFfmpeg, 'fake');
    fs.writeFileSync(bareFfprobe, 'fake');
    process.env.FFMPEG_RENDER_PRO_FFMPEG = bareFfmpeg;
    assert.strictEqual(ffprobeBin(), bareFfprobe);
  });

  test('missing sibling on disk falls back to "ffprobe"', () => {
    fs.unlinkSync(fakeFfprobeExe);
    process.env.FFMPEG_RENDER_PRO_FFMPEG = fakeFfmpegExe;
    assert.strictEqual(ffprobeBin(), 'ffprobe');
  });

  test('basename without "ffmpeg" never derives (would return the ffmpeg binary itself)', () => {
    const oddBin = path.join(dir, 'custom-encoder.exe');
    fs.writeFileSync(oddBin, 'fake');
    process.env.FFMPEG_RENDER_PRO_FFMPEG = oddBin;
    assert.strictEqual(ffprobeBin(), 'ffprobe');
  });

  delete process.env.FFMPEG_RENDER_PRO_FFMPEG;
  delete process.env.FFMPEG_RENDER_PRO_FFPROBE;

  // =========================================================================
  // Integration: checkFFmpeg honors the env var (child process, so
  // gpu-detect's module-level memoization stays out of this process)
  // =========================================================================
  const gpuDetectPath = path.join(__dirname, '..', 'src', 'core', 'gpu-detect.js');
  const childScript =
    `const g = require(${JSON.stringify(gpuDetectPath)});` +
    'process.stdout.write(JSON.stringify(g.checkFFmpeg()));';
  const runChild = (envOverrides) => spawnSync(process.execPath, ['-e', childScript], {
    encoding: 'utf-8',
    timeout: 20000,
    env: { ...process.env, ...envOverrides },
  });

  test('integration: bogus FFMPEG_RENDER_PRO_FFMPEG makes checkFFmpeg unavailable', () => {
    const bogus = path.join(dir, 'no-such-dir', 'no-such-ffmpeg.exe');
    const child = runChild({ FFMPEG_RENDER_PRO_FFMPEG: bogus, FFMPEG_RENDER_PRO_FFPROBE: '' });
    assert.strictEqual(child.status, 0, 'child exited non-zero: ' + (child.stderr || ''));
    const res = JSON.parse(child.stdout);
    assert.strictEqual(res.available, false);
    assert.ok(
      String(res.error).includes('FFMPEG_RENDER_PRO_FFMPEG'),
      'error mentions the env var: ' + res.error,
    );
  });

  test('integration: with the env var unset, checkFFmpeg matches the PATH reality', () => {
    const pathHasFfmpeg = (() => {
      try {
        return spawnSync('ffmpeg', ['-version'], { timeout: 5000 }).status === 0;
      } catch {
        return false;
      }
    })();
    const child = runChild({ FFMPEG_RENDER_PRO_FFMPEG: '', FFMPEG_RENDER_PRO_FFPROBE: '' });
    assert.strictEqual(child.status, 0, 'child exited non-zero: ' + (child.stderr || ''));
    const res = JSON.parse(child.stdout);
    assert.strictEqual(res.available, pathHasFfmpeg);
    if (res.available) assert.strictEqual(res.path, 'ffmpeg');
  });

  // --- Cleanup ---
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  if (savedFfmpeg !== undefined) process.env.FFMPEG_RENDER_PRO_FFMPEG = savedFfmpeg;
  if (savedFfprobe !== undefined) process.env.FFMPEG_RENDER_PRO_FFPROBE = savedFfprobe;

  // --- Summary ---
  console.log(`\n\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const f of failures) {
      console.error(`  ✗ ${f.name}`);
      console.error('    ', f.err.message);
    }
    process.exit(1);
  }
  console.log('  All ffmpeg-bin tests passed.\n');
}

try {
  main();
} catch (err) {
  console.error('ffmpeg-bin test harness error:', err);
  process.exit(1);
}
