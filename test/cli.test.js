#!/usr/bin/env node
/**
 * CLI Tests - ffmpeg-render-pro
 *
 * Tests the pure helpers exported by bin/ffmpeg-render-pro.js (parseFlags,
 * validateFlags, buildCodecArgs, safe* coercers) plus the version command
 * end to end via spawnSync. No renders are spawned here.
 *
 * Intentionally zero-dependency (no mocha/jest): node test/cli.test.js
 */
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const cli = require('../bin/ffmpeg-render-pro.js');
const pkg = require('../package.json');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

console.log('\n  ffmpeg-render-pro - CLI tests\n');

// --- parseFlags: split on the FIRST '=' only ---
test('parseFlags splits on the first = only (--title=A=B)', () => {
  assert.strictEqual(cli.parseFlags(['--title=A=B']).title, 'A=B');
});
test('parseFlags keeps = inside path values', () => {
  assert.strictEqual(cli.parseFlags(['--output=C:\\out\\a=b.mp4']).output, 'C:\\out\\a=b.mp4');
});
test('parseFlags plain --key=value', () => {
  assert.strictEqual(cli.parseFlags(['--fps=30']).fps, '30');
});
test('parseFlags --key= yields empty string', () => {
  assert.strictEqual(cli.parseFlags(['--title=']).title, '');
});

// --- parseFlags: boolean flags and space-separated values ---
test('parseFlags bare flag is boolean true', () => {
  assert.strictEqual(cli.parseFlags(['--no-dashboard'])['no-dashboard'], true);
});
test('parseFlags --key value space form', () => {
  assert.strictEqual(cli.parseFlags(['--width', '1920']).width, '1920');
});
test('parseFlags bare flag followed by another flag stays boolean', () => {
  const flags = cli.parseFlags(['--no-open', '--fps=30']);
  assert.strictEqual(flags['no-open'], true);
  assert.strictEqual(flags.fps, '30');
});
test('parseFlags ignores non-flag tokens (positionals)', () => {
  const flags = cli.parseFlags(['worker.js', '--fps=30']);
  assert.strictEqual(flags.fps, '30');
  assert.strictEqual(Object.keys(flags).length, 1);
});

// --- Numeric coercion behavior as implemented ---
test('safeInt parses integers', () => {
  assert.strictEqual(cli.safeInt('42', 1), 42);
});
test('safeInt substitutes default for valueless (true) flags', () => {
  assert.strictEqual(cli.safeInt(true, 7), 7);
});
test('safeInt rejects zero and negatives', () => {
  assert.strictEqual(cli.safeInt('0', 7), 7);
  assert.strictEqual(cli.safeInt('-3', 7), 7);
});
test('safeInt truncates fractional strings', () => {
  assert.strictEqual(cli.safeInt('100.5', 1), 100);
});
test('safeNum allows fractions', () => {
  assert.strictEqual(cli.safeNum('2.5', 60), 2.5);
});
test('safeSeed accepts 0 and negatives', () => {
  assert.strictEqual(cli.safeSeed('0', 42), 0);
  assert.strictEqual(cli.safeSeed('-5', 42), -5);
});
test('safeStr falls back on non-string or empty values', () => {
  assert.strictEqual(cli.safeStr(true, 'default'), 'default');
  assert.strictEqual(cli.safeStr('', 'default'), 'default');
  assert.strictEqual(cli.safeStr('x.mp4', 'default'), 'x.mp4');
});

// --- validateFlags: unknown-flag warning path ---
test('validateFlags warns on an unknown flag and names it', () => {
  const { warnings, errors } = cli.validateFlags('render', { durration: '300' });
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes('--durration'), warnings[0]);
});
test('validateFlags accepts every documented render flag', () => {
  const flags = {
    width: '1920', height: '1080', fps: '60', duration: '2.5', output: 'o.mp4',
    workers: '4', 'max-workers': '8', seed: '0', title: 'T',
    'no-dashboard': true, 'no-open': true, port: '8080', 'linger-ms': '0',
    crf: '18', 'encoder-preset': 'slow',
  };
  const { warnings, errors } = cli.validateFlags('render', flags);
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(errors, []);
});
test('validateFlags accepts encoder-mode flags for detect-gpu and info', () => {
  for (const command of ['detect-gpu', 'info']) {
    const { warnings, errors } = cli.validateFlags(command, { cpu: true });
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(errors, []);
  }
});
test('validateFlags returns nothing for commands without a known-flag list', () => {
  const { warnings, errors } = cli.validateFlags('no-such-command', { whatever: '1' });
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(errors, []);
});

// --- validateFlags: NaN numeric values are errors ---
test('validateFlags errors on NaN integer value (--fps=abc)', () => {
  const { errors } = cli.validateFlags('render', { fps: 'abc' });
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].includes('--fps'), errors[0]);
});
test('validateFlags errors on NaN duration', () => {
  const { errors } = cli.validateFlags('benchmark', { duration: 'abc' });
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].includes('--duration'), errors[0]);
});
test('validateFlags valueless numeric flag is not an error (default applies)', () => {
  const { errors } = cli.validateFlags('render', { fps: true });
  assert.strictEqual(errors.length, 0);
});

// --- validateFlags: quality flags ---
test('validateFlags accepts crf bounds 0 and 51', () => {
  assert.strictEqual(cli.validateFlags('render', { crf: '0' }).errors.length, 0);
  assert.strictEqual(cli.validateFlags('render', { crf: '51' }).errors.length, 0);
});
test('validateFlags errors on out-of-range crf', () => {
  assert.strictEqual(cli.validateFlags('render', { crf: '99' }).errors.length, 1);
  assert.strictEqual(cli.validateFlags('render', { crf: '-1' }).errors.length, 1);
});
test('validateFlags errors on valueless --crf', () => {
  assert.strictEqual(cli.validateFlags('render', { crf: true }).errors.length, 1);
});
test('validateFlags errors on NaN crf exactly once', () => {
  assert.strictEqual(cli.validateFlags('render', { crf: 'abc' }).errors.length, 1);
});
test('validateFlags errors on unknown encoder preset', () => {
  const { errors } = cli.validateFlags('render', { 'encoder-preset': 'bogus' });
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].includes('encoder-preset'), errors[0]);
});
test('validateFlags accepts every known x264 preset', () => {
  for (const preset of cli.X264_PRESETS) {
    const { errors } = cli.validateFlags('benchmark', { 'encoder-preset': preset });
    assert.deepStrictEqual(errors, [], `preset ${preset}`);
  }
});

// --- buildCodecArgs ---
test('buildCodecArgs returns null when neither quality flag is set', () => {
  assert.strictEqual(cli.buildCodecArgs({}), null);
  assert.strictEqual(cli.buildCodecArgs({ fps: '30' }), null);
});
test('buildCodecArgs with crf only defaults preset to fast', () => {
  assert.deepStrictEqual(
    cli.buildCodecArgs({ crf: '18' }),
    ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18'],
  );
});
test('buildCodecArgs with preset only defaults crf to 20', () => {
  assert.deepStrictEqual(
    cli.buildCodecArgs({ 'encoder-preset': 'slow' }),
    ['-c:v', 'libx264', '-preset', 'slow', '-crf', '20'],
  );
});
test('buildCodecArgs with both flags', () => {
  assert.deepStrictEqual(
    cli.buildCodecArgs({ crf: '28', 'encoder-preset': 'veryfast' }),
    ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28'],
  );
});

// --- version command end to end (no render spawned) ---
test('version command prints the package.json version and exits 0', () => {
  const binPath = path.join(__dirname, '..', 'bin', 'ffmpeg-render-pro.js');
  const result = spawnSync(process.execPath, [binPath, 'version'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `exit code ${result.status}, stderr: ${result.stderr}`);
  assert.strictEqual(result.stdout.trim(), pkg.version);
});

// --- init: starter worker scaffold ---
const fs = require('fs');
const os = require('os');
const initTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-cli-init-'));
try {
  test('STARTER_WORKER points at a shipped file that looks like a worker', () => {
    assert.ok(fs.existsSync(cli.STARTER_WORKER), 'starter worker file exists');
    const src = fs.readFileSync(cli.STARTER_WORKER, 'utf8');
    assert.ok(src.includes('function renderFrame('), 'has renderFrame');
    assert.ok(src.includes("type: 'done'"), 'posts done');
    assert.ok(src.includes("type: 'error'"), 'posts error');
  });
  test('writeStarterWorker copies the starter byte-for-byte', () => {
    const dest = cli.writeStarterWorker(path.join(initTmp, 'w.js'));
    assert.ok(fs.readFileSync(dest).equals(fs.readFileSync(cli.STARTER_WORKER)), 'identical bytes');
  });
  test('writeStarterWorker refuses to overwrite without force', () => {
    assert.throws(() => cli.writeStarterWorker(path.join(initTmp, 'w.js')), /already exists/);
  });
  test('writeStarterWorker overwrites with force', () => {
    fs.writeFileSync(path.join(initTmp, 'w.js'), 'garbage');
    cli.writeStarterWorker(path.join(initTmp, 'w.js'), { force: true });
    assert.ok(fs.readFileSync(path.join(initTmp, 'w.js'), 'utf8').includes('renderFrame'));
  });
  test('writeStarterWorker creates missing parent directories', () => {
    const dest = cli.writeStarterWorker(path.join(initTmp, 'nested', 'deep', 'w.js'));
    assert.ok(fs.existsSync(dest));
  });
  test('KNOWN_FLAGS registers init with only --force', () => {
    assert.deepStrictEqual([...cli.KNOWN_FLAGS.init], ['force']);
  });
  test('init command end to end: default name, next-steps text, exit 0', () => {
    const binPath = path.join(__dirname, '..', 'bin', 'ffmpeg-render-pro.js');
    const cwd = path.join(initTmp, 'e2e');
    fs.mkdirSync(cwd, { recursive: true });
    const r = spawnSync(process.execPath, [binPath, 'init'], { encoding: 'utf8', cwd });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(cwd, 'my-worker.js')), 'my-worker.js written');
    assert.ok(r.stdout.includes('renderFrame'), 'tells the user which function to edit');
    assert.ok(r.stdout.includes('render my-worker.js'), 'shows the render command');
  });
  test('init command with explicit path and a second run refusing overwrite (exit 1)', () => {
    const binPath = path.join(__dirname, '..', 'bin', 'ffmpeg-render-pro.js');
    const target = path.join(initTmp, 'custom.js');
    const first = spawnSync(process.execPath, [binPath, 'init', target], { encoding: 'utf8' });
    assert.strictEqual(first.status, 0, first.stderr);
    const second = spawnSync(process.execPath, [binPath, 'init', target], { encoding: 'utf8' });
    assert.strictEqual(second.status, 1, 'refuses overwrite');
    assert.ok(second.stderr.includes('already exists'));
    const forced = spawnSync(process.execPath, [binPath, 'init', target, '--force'], { encoding: 'utf8' });
    assert.strictEqual(forced.status, 0, forced.stderr);
  });
  test('help text leads with the three-command start path and lists init', () => {
    const binPath = path.join(__dirname, '..', 'bin', 'ffmpeg-render-pro.js');
    const r = spawnSync(process.execPath, [binPath], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('Start here'), 'has a Start here block');
    assert.ok(r.stdout.includes('init [my-worker.js]'), 'lists init');
  });
} finally {
  try { fs.rmSync(initTmp, { recursive: true, force: true }); } catch {}
}

// --- Summary ---
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
console.log('  All CLI tests passed.\n');
