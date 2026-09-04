#!/usr/bin/env node
/**
 * Renderer failure-injection tests - ffmpeg-render-pro
 *
 * Exercises the renderParallel paths no happy-path suite touches: worker
 * error messages, worker crashes, silent exits without a segment, one-shot
 * retry, AbortSignal, quiet mode stdout hygiene, float-safe totalFrames,
 * and signal-handler accounting. Uses tiny renders (64x64, a few frames)
 * with purpose-built worker scripts written to a temp dir.
 *
 * Skips (exit 0 with a warning) when ffmpeg is not on PATH.
 * Zero test-framework dependencies. Run: node test/renderer.test.js
 */
const assert = require('assert');
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const lib = require('../src/index.js');
const { computeTotalFrames } = require('../src/core/config.js');
const ROOT = path.join(__dirname, '..');
const BASIC_WORKER = path.join(ROOT, 'examples', 'basic-worker.js');

let passed = 0;
let skippedCount = 0;
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

function skip(name, reason) {
  skippedCount++;
  console.log(`  SKIP ${name}: ${reason}`);
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function countFrames(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
  ], { encoding: 'utf-8', timeout: 30000 });
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  return Number(r.stdout.trim());
}

function tempLeftovers(dir) {
  return fs.readdirSync(dir).filter((f) => f.startsWith('.parallel-temp'));
}

async function main() {
  console.log('\n  ffmpeg-render-pro - renderer failure-injection tests\n');

  const ff = lib.checkFFmpeg();
  if (!ff.available) {
    console.log('  !! ffmpeg not on PATH - skipping renderer test suite\n');
    process.exit(0);
  }
  const haveFfprobe = spawnSync('ffprobe', ['-version'], { timeout: 5000 }).status === 0;
  if (!haveFfprobe) {
    console.log('  !! ffprobe not on PATH - skipping renderer test suite\n');
    process.exit(0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-render-pro-renderer-'));
  const fixture = (name, code) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, code);
    return p;
  };

  // --- Fixture workers ---
  const errorMsgWorker = fixture('worker-error-msg.js', `
const { workerData, parentPort } = require('worker_threads');
parentPort.postMessage({ type: 'error', workerId: workerData.workerId, error: 'injected' });
`);

  const throwWorker = fixture('worker-throw.js', `
throw new Error('boom');
`);

  // Exits 0 without writing a segment or posting any message.
  const silentExitWorker = fixture('worker-silent-exit.js', '');

  // Crashes on attempt 1 (leaves a marker), renders a real segment on attempt 2.
  const retryWorker = fixture('worker-retry.js', `
const { workerData, parentPort } = require('worker_threads');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const marker = path.join(workerData.markerDir, 'attempt-' + workerData.workerId);
if (workerData.workerId === 0 && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1');
  throw new Error('injected first-attempt crash');
}
const frames = workerData.endFrame - workerData.startFrame;
const r = spawnSync('ffmpeg', [
  '-y', '-f', 'lavfi',
  '-i', 'color=c=red:s=' + workerData.width + 'x' + workerData.height + ':r=' + workerData.fps,
  '-frames:v', String(frames),
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  workerData.segmentPath,
], { timeout: 60000 });
if (r.status !== 0) {
  parentPort.postMessage({ type: 'error', workerId: workerData.workerId, error: 'segment encode failed' });
} else {
  parentPort.postMessage({ type: 'done', workerId: workerData.workerId });
}
`);

  // Records every attempt, then crashes. Proves the retry is one-shot.
  const alwaysFailWorker = fixture('worker-always-fail.js', `
const { workerData } = require('worker_threads');
const fs = require('fs');
fs.appendFileSync(workerData.attemptsPath, 'x');
throw new Error('always fails');
`);

  // Never finishes: posts progress forever so an abort has something to stop.
  const slowWorker = fixture('worker-slow.js', `
const { workerData, parentPort } = require('worker_threads');
setInterval(() => {
  parentPort.postMessage({ type: 'progress', workerId: workerData.workerId, pct: '1.0', fps: '1.0', frame: 1, eta: '99' });
}, 100);
`);

  const render = (workerScript, out, extra = {}) => lib.renderParallel({
    workerScript,
    outputPath: out,
    width: 64, height: 64, fps: 10, duration: 0.5,
    workerCount: 1,
    seed: 1,
    dashboard: false,
    ...extra,
  });

  try {
    // --- 1. totalFrames float safety (pure) ---
    await step('computeTotalFrames absorbs float error on integral products', () => {
      assert.strictEqual(computeTotalFrames(25, 4.6), 115, '25fps x 4.6s (114.99999999999999 in doubles)');
      assert.strictEqual(computeTotalFrames(10, 0.3), 3, '10fps x 0.3s (2.9999999999999996 in doubles)');
      assert.strictEqual(computeTotalFrames(60, 60), 3600);
      assert.strictEqual(computeTotalFrames(10, 1.2), 12);
    });

    await step('computeTotalFrames still floors genuinely fractional products', () => {
      assert.strictEqual(computeTotalFrames(10, 0.35), 3, '3.5 floors to 3');
      assert.strictEqual(computeTotalFrames(24, 1.99), 47, '47.76 floors to 47');
      assert.strictEqual(computeTotalFrames(30, 0.001), 1, 'clamps to at least 1 frame');
    });

    // --- 2. Float case end-to-end: 10fps x 0.3s must render 3 frames, not 2 ---
    await step('render at 10fps x 0.3s produces 3 frames (float fix, real ffprobe count)', async () => {
      const out = path.join(tmp, 'float.mp4');
      const result = await render(BASIC_WORKER, out, { duration: 0.3 });
      assert.strictEqual(result.totalFrames, 3);
      assert.strictEqual(countFrames(out), 3);
    });

    // --- 3. Worker posts {type:'error'} ---
    await step('worker error message rejects, cleans temp dir, restores signal handlers', async () => {
      const sigintBefore = process.listenerCount('SIGINT');
      const sigtermBefore = process.listenerCount('SIGTERM');
      await assert.rejects(
        () => withTimeout(render(errorMsgWorker, path.join(tmp, 'err-msg.mp4')), 60000, 'error-message render'),
        /Worker 0 failed: injected/,
      );
      assert.deepStrictEqual(tempLeftovers(tmp), [], 'temp dir removed');
      assert.strictEqual(process.listenerCount('SIGINT'), sigintBefore, 'SIGINT handler removed');
      assert.strictEqual(process.listenerCount('SIGTERM'), sigtermBefore, 'SIGTERM handler removed');
    });

    // --- 4. Worker throws (worker 'error' event) ---
    await step('throwing worker rejects with the worker error', async () => {
      await assert.rejects(
        () => withTimeout(render(throwWorker, path.join(tmp, 'throw.mp4')), 60000, 'throwing render'),
        /Worker 0 error: boom/,
      );
      assert.deepStrictEqual(tempLeftovers(tmp), [], 'temp dir removed');
    });

    // --- 5. Silent exit 0 without a segment: funnels into concat's check ---
    await step('silent-exit worker yields a clear missing-segment error, not a hang', async () => {
      await assert.rejects(
        () => withTimeout(render(silentExitWorker, path.join(tmp, 'silent.mp4')), 60000, 'silent-exit render'),
        /missing or empty/,
      );
      assert.deepStrictEqual(tempLeftovers(tmp), [], 'temp dir removed');
    });

    // --- 6. One-shot retry: crash on attempt 1, succeed on attempt 2 ---
    await step('worker crash on attempt 1 is retried once and the render completes', async () => {
      const markerDir = path.join(tmp, 'markers');
      fs.mkdirSync(markerDir, { recursive: true });
      const out = path.join(tmp, 'retried.mp4');
      const result = await withTimeout(
        render(retryWorker, out, { duration: 0.8, workerCount: 2, workerData: { markerDir } }),
        120000, 'retry render',
      );
      assert.strictEqual(result.totalFrames, 8);
      assert.ok(fs.existsSync(path.join(markerDir, 'attempt-0')), 'attempt 1 crash marker written');
      assert.strictEqual(countFrames(out), 8, 'all frames present after retry');
      assert.deepStrictEqual(tempLeftovers(tmp), [], 'temp dir removed after success');
    });

    // --- 7. Retry is one-shot: a worker that always fails runs exactly twice ---
    await step('always-failing worker is attempted exactly twice, then the render fails', async () => {
      const attemptsPath = path.join(tmp, 'attempts.txt');
      fs.writeFileSync(attemptsPath, '');
      await assert.rejects(
        () => withTimeout(
          render(alwaysFailWorker, path.join(tmp, 'always-fail.mp4'), { workerData: { attemptsPath } }),
          60000, 'always-fail render',
        ),
        /Worker 0 error: always fails/,
      );
      assert.strictEqual(fs.readFileSync(attemptsPath, 'utf-8'), 'xx', 'exactly 2 attempts (1 original + 1 retry)');
      assert.deepStrictEqual(tempLeftovers(tmp), [], 'temp dir removed');
    });

    // --- 8. AbortSignal mid-render ---
    await step('abort mid-render rejects with AbortError and cleans up', async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 250);
      let caught = null;
      try {
        await withTimeout(
          render(slowWorker, path.join(tmp, 'aborted.mp4'), { duration: 30, signal: controller.signal }),
          30000, 'aborted render',
        );
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'render rejected');
      assert.strictEqual(caught.name, 'AbortError');
      assert.deepStrictEqual(tempLeftovers(tmp), [], 'temp dir removed');
    });

    await step('pre-aborted signal rejects immediately with AbortError', async () => {
      const controller = new AbortController();
      controller.abort();
      let caught = null;
      try {
        await render(BASIC_WORKER, path.join(tmp, 'pre-aborted.mp4'), { signal: controller.signal });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'render rejected');
      assert.strictEqual(caught.name, 'AbortError');
      assert.deepStrictEqual(tempLeftovers(tmp), [], 'no temp dir created');
    });

    // --- 9. quiet:true keeps stdout byte-clean (spawned child, captured pipes) ---
    await step('quiet:true render writes zero bytes to stdout, banner goes to stderr', () => {
      const out = path.join(tmp, 'quiet.mp4');
      const childScript = fixture('quiet-child.js', `
const lib = require(${JSON.stringify(path.join(ROOT, 'src', 'index.js'))});
lib.renderParallel({
  workerScript: ${JSON.stringify(BASIC_WORKER)},
  outputPath: ${JSON.stringify(out)},
  width: 64, height: 64, fps: 10, duration: 0.3,
  workerCount: 1, seed: 1, dashboard: false, quiet: true,
}).then(
  () => process.exit(0),
  (err) => { process.stderr.write('CHILD FAIL: ' + err.message + '\\n'); process.exit(1); },
);
`);
      const r = spawnSync('node', [childScript], { encoding: 'utf-8', timeout: 120000 });
      assert.strictEqual(r.status, 0, `child exited ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.stdout, '', 'stdout is byte-clean');
      assert.ok(r.stderr.includes('ffmpeg-render-pro'), 'status banner went to stderr');
      assert.ok(fs.existsSync(out), 'output rendered');
    });

    // --- 9b. quiet:true with the DASHBOARD ON is also byte-clean ---
    // Regression: renderParallel never passed silent to startDashboard, so
    // the cyan "Dashboard: http://..." box reached stdout in quiet mode.
    await step('quiet:true with dashboard:true writes zero bytes to stdout, URL goes to stderr', () => {
      const out = path.join(tmp, 'quiet-dash.mp4');
      const childScript = fixture('quiet-dash-child.js', `
const lib = require(${JSON.stringify(path.join(ROOT, 'src', 'index.js'))});
lib.renderParallel({
  workerScript: ${JSON.stringify(BASIC_WORKER)},
  outputPath: ${JSON.stringify(out)},
  width: 64, height: 64, fps: 10, duration: 0.3,
  workerCount: 1, seed: 1, quiet: true,
  dashboard: true, autoOpen: false, dashboardLingerMs: 0, dashboardPort: 18790,
}).then(
  () => process.exit(0),
  (err) => { process.stderr.write('CHILD FAIL: ' + err.message + '\\n'); process.exit(1); },
);
`);
      const r = spawnSync('node', [childScript], { encoding: 'utf-8', timeout: 120000 });
      assert.strictEqual(r.status, 0, `child exited ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.stdout, '', 'stdout is byte-clean with the dashboard on');
      assert.ok(/Dashboard: http:\/\/127\.0\.0\.1:\d+/.test(r.stderr), 'dashboard URL announced on stderr');
      assert.ok(fs.existsSync(out), 'output rendered');
    });

    // --- 10. Signal handler accounting after a SUCCESSFUL render ---
    await step('successful render leaves SIGINT/SIGTERM listener counts unchanged', async () => {
      const sigintBefore = process.listenerCount('SIGINT');
      const sigtermBefore = process.listenerCount('SIGTERM');
      await render(BASIC_WORKER, path.join(tmp, 'sig-count.mp4'), { duration: 0.3 });
      assert.strictEqual(process.listenerCount('SIGINT'), sigintBefore);
      assert.strictEqual(process.listenerCount('SIGTERM'), sigtermBefore);
    });

    // --- 11. Graceful shutdown on a real signal (POSIX only) ---
    if (process.platform === 'win32') {
      // child.kill() on win32 is TerminateProcess: no signal handler ever
      // runs, so the graceful path is untestable here. Hard kills are covered
      // by the sweepStaleTempDirs backstop instead (exercised in e2e).
      skip('SIGTERM graceful shutdown', 'win32 child.kill() is a hard terminate; POSIX-only test');
    } else {
      await step('SIGTERM mid-render exits 143 and leaves no temp dirs', async () => {
        const sigOutDir = path.join(tmp, 'sig-out');
        fs.mkdirSync(sigOutDir, { recursive: true });
        const childScript = fixture('sig-child.js', `
const lib = require(${JSON.stringify(path.join(ROOT, 'src', 'index.js'))});
lib.renderParallel({
  workerScript: ${JSON.stringify(slowWorker)},
  outputPath: ${JSON.stringify(path.join(sigOutDir, 'sig.mp4'))},
  width: 64, height: 64, fps: 10, duration: 30,
  workerCount: 1, seed: 1, dashboard: false,
}).then(() => process.exit(0), () => process.exit(1));
`);
        const child = spawn('node', [childScript], { stdio: ['ignore', 'pipe', 'pipe'] });
        // Wait until the temp dir exists (banner printed after mkdir), then signal.
        await withTimeout(new Promise((resolve) => {
          let seen = '';
          child.stdout.on('data', (chunk) => {
            seen += chunk.toString();
            if (seen.includes('Temp dir:')) resolve();
          });
        }), 30000, 'waiting for render banner');
        await new Promise((r) => setTimeout(r, 500));
        child.kill('SIGTERM');
        const code = await withTimeout(new Promise((resolve) => {
          child.on('exit', (c) => resolve(c));
        }), 30000, 'waiting for child exit');
        assert.strictEqual(code, 143, 'graceful SIGTERM exit code');
        assert.deepStrictEqual(tempLeftovers(sigOutDir), [], 'temp dir cleaned on SIGTERM');
      });
    }

  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  const skippedNote = skippedCount > 0 ? `, ${skippedCount} skipped` : '';
  console.log(`\n  ${passed} passed, ${failures.length} failed${skippedNote}\n`);
  if (failures.length > 0) process.exit(1);
  console.log('  All renderer tests passed.\n');
}

main().catch((err) => {
  console.error('Renderer test harness error:', err);
  process.exit(2);
});
