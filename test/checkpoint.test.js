#!/usr/bin/env node
/**
 * Checkpoint Tests - ffmpeg-render-pro
 *
 * Unit tests for src/core/checkpoint.js: generateCheckpoints determinism
 * (a checkpoint labeled frame F contains exactly F updates, so the
 * documented restore + fast-forward recipe matches a from-zero run),
 * falsy-state restoration, frame fallbacks, listing, and nearest-below
 * selection. Zero-dependency, same harness style as test/smoke.js.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  saveCheckpoint,
  loadCheckpoint,
  restoreCheckpoint,
  generateCheckpoints,
  listCheckpoints,
} = require('../src/core/checkpoint.js');

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

// generateCheckpoints prints progress banners; silence them so test
// output stays readable.
function quiet(fn) {
  const orig = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = orig;
  }
}

// Counter system: state is exactly the number of update() calls applied,
// which makes off-by-one checkpoint labeling directly observable.
function makeCounter() {
  return {
    n: 0,
    update() { this.n++; },
    getState() { return this.n; },
    setState(s) { this.n = s; },
  };
}

function main() {
  console.log('\n  ffmpeg-render-pro - checkpoint tests\n');

  const tmp = path.join(os.tmpdir(), 'ffmpeg-render-pro-cptest-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  try {
    // --- generateCheckpoints determinism ---
    const genDir = path.join(tmp, 'gen');
    const interval = 10;
    const totalFrames = 100;
    const result = quiet(() => generateCheckpoints({
      systems: { counter: makeCounter() },
      totalFrames,
      fps: 60,
      checkpointDir: genDir,
      interval,
    }));

    test('generateCheckpoints returns count/elapsed/dir', () => {
      assert.strictEqual(result.count, 9); // frames 10..90; f=0 is skipped
      assert.strictEqual(result.dir, genDir);
      assert.strictEqual(typeof result.elapsed, 'number');
    });

    test('checkpoint labeled frame F contains exactly F updates', () => {
      const cps = listCheckpoints(genDir);
      assert.strictEqual(cps.length, 9);
      for (const cp of cps) {
        const state = JSON.parse(fs.readFileSync(cp.path, 'utf-8'));
        assert.strictEqual(state._frame, cp.frame);
        assert.strictEqual(state.counter, cp.frame,
          `checkpoint at frame ${cp.frame} holds ${state.counter} updates`);
      }
    });

    test('restore + fast-forward matches a direct from-zero run', () => {
      // Direct path: F updates = state at frame F.
      for (const startFrame of [37, 50, 99]) {
        const direct = makeCounter();
        for (let f = 0; f < startFrame; f++) direct.update();

        // Documented recipe (README "Checkpoints"): load nearest at or
        // below startFrame, restore, fast-forward the remainder.
        const resumed = makeCounter();
        const cp = loadCheckpoint(genDir, startFrame);
        assert.ok(cp, `checkpoint found for startFrame ${startFrame}`);
        const resumeFrame = restoreCheckpoint(cp, { counter: resumed });
        for (let f = resumeFrame; f < startFrame; f++) resumed.update();

        assert.strictEqual(resumed.getState(), direct.getState(),
          `startFrame ${startFrame}: resumed ${resumed.getState()} vs direct ${direct.getState()}`);
      }
    });

    test('onCheckpoint callback receives ascending frame numbers', () => {
      const frames = [];
      quiet(() => generateCheckpoints({
        systems: { counter: makeCounter() },
        totalFrames: 30,
        fps: 60,
        checkpointDir: path.join(tmp, 'gen-cb'),
        interval: 10,
        onCheckpoint: (frameNum) => frames.push(frameNum),
      }));
      assert.deepStrictEqual(frames, [10, 20]);
    });

    // --- restoreCheckpoint falsy states ---
    test('restoreCheckpoint restores falsy states (0, empty string, false)', () => {
      const restored = {};
      const systems = {
        zero:  { setState(s) { restored.zero = s; } },
        empty: { setState(s) { restored.empty = s; } },
        flag:  { setState(s) { restored.flag = s; } },
      };
      restoreCheckpoint({ _frame: 5, zero: 0, empty: '', flag: false }, systems);
      assert.strictEqual(restored.zero, 0);
      assert.strictEqual(restored.empty, '');
      assert.strictEqual(restored.flag, false);
    });

    test('falsy states survive a save/load/restore round-trip', () => {
      const dir = path.join(tmp, 'falsy');
      const store = { getState() { return 0; }, setState(s) { this.value = s; } };
      saveCheckpoint(dir, 7, { store });
      const cp = loadCheckpoint(dir, 7);
      restoreCheckpoint(cp, { store });
      assert.strictEqual(store.value, 0);
    });

    test('restoreCheckpoint skips systems absent from the checkpoint', () => {
      const untouched = { setState() { throw new Error('must not be called'); } };
      restoreCheckpoint({ _frame: 1 }, { untouched });
    });

    // --- restoreCheckpoint return value ---
    test('restoreCheckpoint returns checkpoint._frame', () =>
      assert.strictEqual(restoreCheckpoint({ _frame: 42 }, {}), 42));
    test('restoreCheckpoint falls back to 0 when _frame missing', () =>
      assert.strictEqual(restoreCheckpoint({}, {}), 0));

    // --- listCheckpoints ---
    test('listCheckpoints parses frames and sorts ascending', () => {
      const dir = path.join(tmp, 'list');
      const sys = { counter: makeCounter() };
      saveCheckpoint(dir, 3000, sys);
      saveCheckpoint(dir, 20, sys);
      saveCheckpoint(dir, 100, sys);
      fs.writeFileSync(path.join(dir, 'not-a-checkpoint.json'), '{}');
      const cps = listCheckpoints(dir);
      assert.deepStrictEqual(cps.map(c => c.frame), [20, 100, 3000]);
      for (const cp of cps) assert.ok(fs.existsSync(cp.path));
    });

    test('listCheckpoints returns [] for a missing dir', () =>
      assert.deepStrictEqual(listCheckpoints(path.join(tmp, 'no-such-dir')), []));

    // --- loadCheckpoint nearest-below selection ---
    test('loadCheckpoint picks the nearest checkpoint at or below target', () => {
      const dir = path.join(tmp, 'nearest');
      const sys = { counter: makeCounter() };
      saveCheckpoint(dir, 10, sys);
      saveCheckpoint(dir, 20, sys);
      saveCheckpoint(dir, 30, sys);
      assert.strictEqual(loadCheckpoint(dir, 25)._frame, 20);
      assert.strictEqual(loadCheckpoint(dir, 20)._frame, 20); // at-or-below includes equal
      assert.strictEqual(loadCheckpoint(dir, 999)._frame, 30);
      assert.strictEqual(loadCheckpoint(dir, 5), null);
    });

    test('loadCheckpoint skips a corrupt nearest and falls back below it', () => {
      const dir = path.join(tmp, 'corrupt-nearest');
      const sys = { counter: makeCounter() };
      saveCheckpoint(dir, 10, sys);
      saveCheckpoint(dir, 30, sys);
      fs.writeFileSync(path.join(dir, 'checkpoint-00000020.json'), '{"_frame":20,"counter"');
      assert.strictEqual(loadCheckpoint(dir, 25)._frame, 10);
    });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // --- Summary ---
  console.log(`\n\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const f of failures) {
      console.error(`  ✗ ${f.name}`);
      console.error('    ', f.err.message);
    }
    process.exit(1);
  }
  console.log('  All checkpoint tests passed.\n');
}

main();
