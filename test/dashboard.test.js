#!/usr/bin/env node
/**
 * Dashboard Tests - ffmpeg-render-pro
 *
 * Functional coverage for the dashboard HTTP server and the
 * ProgressTracker -> dashboard JSON contract (the two surfaces smoke.js
 * only unit-tests). Real HTTP requests against a real server on a local
 * port; no ffmpeg needed. Zero-dependency, same harness style as the
 * other tests: `node test/dashboard.test.js` exits 0 on success, 1 on
 * failure, printing PASS/FAIL per test.
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startDashboard } = require('../src/core/dashboard-server.js');
const { ProgressTracker } = require('../src/core/progress.js');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

/** One-shot HTTP request against 127.0.0.1. agent:false forces
 *  Connection: close so servers shut down promptly on every Node version. */
function request(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, agent: false },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function mkTmp(label) {
  const dir = path.join(
    os.tmpdir(),
    `ffmpeg-render-pro-dashtest-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The ProgressTracker terminal ticker writes ANSI cursor movement to
 *  stdout; silence it during tracker calls so test output stays readable. */
function withQuietStdout(fn) {
  const orig = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = orig; }
}

async function main() {
  console.log('\n  ffmpeg-render-pro - dashboard tests\n');

  const tmpDirs = [];

  // ======================================================================
  // Dashboard HTTP server (functional, real sockets)
  // ======================================================================
  const tmpHttp = mkTmp('http');
  tmpDirs.push(tmpHttp);
  const basePort = 18100 + Math.floor(Math.random() * 20000);
  const dash = await startDashboard({ dir: tmpHttp, port: basePort, silent: true, autoOpen: false });

  await test('startDashboard resolves with server, url, port, stop', () => {
    assert.ok(dash.server, 'server');
    assert.strictEqual(typeof dash.port, 'number');
    assert.strictEqual(dash.url, `http://127.0.0.1:${dash.port}`);
    assert.strictEqual(typeof dash.stop, 'function');
  });

  await test('GET / returns 200 text/html (dashboard.html copied into preview/)', async () => {
    const r = await request(dash.port, 'GET', '/');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type'].includes('text/html'), `content-type: ${r.headers['content-type']}`);
    assert.ok(r.body.includes('<!DOCTYPE html>'), 'serves the dashboard HTML');
  });

  await test('GET / carries the CSP + nosniff security headers', async () => {
    const r = await request(dash.port, 'GET', '/');
    assert.ok(r.headers['content-security-policy'], 'Content-Security-Policy present');
    assert.ok(r.headers['content-security-policy'].includes("default-src 'self'"));
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
  });

  await test('GET missing file returns 404', async () => {
    const r = await request(dash.port, 'GET', '/no-such-file.json');
    assert.strictEqual(r.status, 404);
  });

  await test('GET path-traversal attempt returns 403', async () => {
    const r = await request(dash.port, 'GET', '/../secret.txt');
    assert.strictEqual(r.status, 403);
  });

  await test('GET encoded traversal attempt returns 403', async () => {
    const r = await request(dash.port, 'GET', '/%2e%2e/secret.txt');
    assert.strictEqual(r.status, 403);
  });

  await test('GET a .json file returns Cache-Control: no-store', async () => {
    fs.writeFileSync(path.join(tmpHttp, 'preview', 'global.json'), JSON.stringify({ phase: 'rendering' }));
    const r = await request(dash.port, 'GET', '/global.json');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.ok(r.headers['content-type'].includes('application/json'));
    assert.strictEqual(JSON.parse(r.body).phase, 'rendering');
  });

  await test('HEAD / returns 200 with empty body', async () => {
    const r = await request(dash.port, 'HEAD', '/');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, '');
  });

  await test('POST returns 405 with Allow header', async () => {
    const r = await request(dash.port, 'POST', '/');
    assert.strictEqual(r.status, 405);
    assert.strictEqual(r.headers['allow'], 'GET, HEAD');
  });

  await test('server error after listen is consumed (one warning, no crash)', () => {
    assert.ok(dash.server.listenerCount('error') > 0, 'post-listen error handler is attached');
    const origErr = console.error;
    let warnings = 0;
    let lastMsg = '';
    console.error = (...args) => { warnings++; lastMsg = args.join(' '); };
    try {
      assert.doesNotThrow(() => dash.server.emit('error', new Error('synthetic post-listen error')));
      dash.server.emit('error', new Error('second synthetic error'));
    } finally {
      console.error = origErr;
    }
    assert.strictEqual(warnings, 1, 'warns exactly once');
    assert.ok(lastMsg.includes('synthetic post-listen error'), `warning names the error: ${lastMsg}`);
  });

  await test('port increments on EADDRINUSE', async () => {
    const dash2 = await startDashboard({ dir: tmpHttp, port: dash.port, silent: true, autoOpen: false });
    try {
      assert.ok(dash2.port > dash.port, `expected a port above ${dash.port}, got ${dash2.port}`);
    } finally {
      await dash2.stop();
    }
  });

  await test('stop() releases the port', async () => {
    await dash.stop();
    await assert.rejects(request(dash.port, 'GET', '/'));
  });

  // ======================================================================
  // ProgressTracker -> dashboard JSON contract
  // ======================================================================

  // Derive the field names the dashboard actually consumes from its source,
  // so a rename on either side of the contract fails this suite.
  const dashboardSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'dashboard', 'dashboard.html'), 'utf8');

  const globalFields = new Set();
  for (const m of dashboardSrc.matchAll(/\bglobal\.([A-Za-z_$][\w$]*)/g)) {
    if (m[1] !== 'json') globalFields.add(m[1]); // 'global.json' is the filename
  }
  const workerFields = new Set();
  for (const m of dashboardSrc.matchAll(/\bd\.([A-Za-z_$][\w$]*)/g)) {
    workerFields.add(m[1]); // `const d = responses[i]` in the poll loop
  }

  await test('field extraction from dashboard.html source is sane', () => {
    for (const f of ['startTime', 'totalFrames', 'numWorkers', 'phase', 'phaseDetail']) {
      assert.ok(globalFields.has(f), `expected dashboard to read global.${f}`);
    }
    for (const f of ['pct', 'fps', 'eta', 'done', 'status']) {
      assert.ok(workerFields.has(f), `expected dashboard to read worker field ${f}`);
    }
  });

  const tmpTracker = mkTmp('tracker');
  tmpDirs.push(tmpTracker);
  const previewDir = path.join(tmpTracker, 'preview');
  const tracker = new ProgressTracker({
    numWorkers: 2, totalFrames: 100, framesPerWorker: 50,
    outputDir: tmpTracker, title: 'contract-test', resolution: '320x240',
  });

  await test('constructor creates no preview dir or files before start()', () => {
    assert.ok(!fs.existsSync(previewDir));
  });

  // Simulate a previous completed render into the same output dir.
  fs.mkdirSync(previewDir, { recursive: true });
  fs.writeFileSync(path.join(previewDir, 'global.json'), JSON.stringify({ phase: 'complete', totalFrames: 999 }));
  fs.writeFileSync(path.join(previewDir, 'worker-0.json'), JSON.stringify({ pct: 100, done: true, status: 'done' }));
  fs.writeFileSync(path.join(previewDir, 'worker-7.json'), JSON.stringify({ pct: 100, done: true, status: 'done' }));
  fs.writeFileSync(path.join(previewDir, 'dashboard.html'), '<html>keep me</html>');

  withQuietStdout(() => tracker.start());

  await test('start() deletes surplus stale worker-*.json from a previous run', () => {
    assert.ok(!fs.existsSync(path.join(previewDir, 'worker-7.json')));
  });

  await test('start() leaves non-progress files (dashboard.html) alone', () => {
    assert.strictEqual(fs.readFileSync(path.join(previewDir, 'dashboard.html'), 'utf8'), '<html>keep me</html>');
  });

  await test('start() overwrites stale global.json with fresh state', () => {
    const g = JSON.parse(fs.readFileSync(path.join(previewDir, 'global.json'), 'utf8'));
    assert.strictEqual(g.phase, 'initializing');
    assert.strictEqual(g.totalFrames, 100);
  });

  await test('global.json carries every field dashboard.html reads', () => {
    const g = JSON.parse(fs.readFileSync(path.join(previewDir, 'global.json'), 'utf8'));
    for (const f of globalFields) {
      assert.ok(f in g, `global.json missing field read by dashboard.html: ${f}`);
    }
    assert.strictEqual(g.numWorkers, 2);
    assert.strictEqual(g.resolution, '320x240');
    assert.strictEqual(g.title, 'contract-test');
    assert.strictEqual(typeof g.startTime, 'number');
  });

  await test('start() writes a fresh waiting worker-N.json for every worker', () => {
    for (let i = 0; i < 2; i++) {
      const w = JSON.parse(fs.readFileSync(path.join(previewDir, `worker-${i}.json`), 'utf8'));
      assert.strictEqual(w.done, false, `worker-${i} done resets to false`);
      assert.strictEqual(w.status, 'waiting');
      assert.strictEqual(w.pct, 0);
    }
  });

  await test('updateWorker writes every worker field dashboard.html reads', () => {
    tracker.updateWorker(0, { pct: 50, fps: 12.5, frame: 25, eta: 3, status: 'rendering' });
    const w = JSON.parse(fs.readFileSync(path.join(previewDir, 'worker-0.json'), 'utf8'));
    for (const f of workerFields) {
      assert.ok(f in w, `worker-0.json missing field read by dashboard.html: ${f}`);
    }
    assert.strictEqual(w.pct, 50);
    assert.strictEqual(w.fps, 12.5);
    assert.strictEqual(w.eta, 3);
    assert.strictEqual(w.done, false);
    assert.strictEqual(w.status, 'rendering');
    assert.strictEqual(w.framesRendered, 25);
  });

  await test('updateWorker out-of-range workerId is a no-op', () => {
    tracker.updateWorker(99, { pct: 1 });
    tracker.updateWorker(-1, { pct: 1 });
    assert.ok(!fs.existsSync(path.join(previewDir, 'worker-99.json')));
    assert.ok(!fs.existsSync(path.join(previewDir, 'worker--1.json')));
  });

  await test('workerDone marks pct 100 / done / eta 0', () => {
    tracker.workerDone(1);
    const w = JSON.parse(fs.readFileSync(path.join(previewDir, 'worker-1.json'), 'utf8'));
    assert.strictEqual(w.done, true);
    assert.strictEqual(w.pct, 100);
    assert.strictEqual(w.status, 'done');
    assert.strictEqual(w.eta, 0);
  });

  await test('setPhase writes phase + phaseDetail to global.json', () => {
    tracker.setPhase('grading', 'Applying color grade');
    const g = JSON.parse(fs.readFileSync(path.join(previewDir, 'global.json'), 'utf8'));
    assert.strictEqual(g.phase, 'grading');
    assert.strictEqual(g.phaseDetail, 'Applying color grade');
  });

  await test('fail() writes the terminal error phase and stops the ticker', () => {
    tracker.fail('worker 1 exploded');
    const g = JSON.parse(fs.readFileSync(path.join(previewDir, 'global.json'), 'utf8'));
    assert.strictEqual(g.phase, 'error');
    assert.ok(g.phaseDetail.includes('worker 1 exploded'));
    assert.strictEqual(tracker._dashboardInterval, null, 'ticker interval cleared');
  });

  await test('fail() accepts an Error object', () => {
    const t = new ProgressTracker({ numWorkers: 1, outputDir: mkTmp('failerr') });
    tmpDirs.push(t.outputDir);
    withQuietStdout(() => t.start());
    t.fail(new Error('boom from Error'));
    withQuietStdout(() => t.stop());
    const g = JSON.parse(fs.readFileSync(path.join(t.outputDir, 'preview', 'global.json'), 'utf8'));
    assert.strictEqual(g.phase, 'error');
    assert.strictEqual(g.phaseDetail, 'boom from Error');
  });

  withQuietStdout(() => tracker.stop());

  await test('dashboard.html renders every phase progress.js can emit', () => {
    // Authoritative vocabulary: setPhase docstring in src/core/progress.js
    // plus the 'spawning' phase emitted by parallel-renderer.js.
    const phases = ['initializing', 'spawning', 'fast-forward', 'rendering',
      'concatenating', 'grading', 'merging-audio', 'complete'];
    for (const p of phases) {
      assert.ok(dashboardSrc.includes(`'${p}'`), `dashboard.html PHASE_ORDER missing phase: ${p}`);
      assert.ok(dashboardSrc.includes(`dot-${p}`), `dashboard.html has no phase dot for: ${p}`);
    }
    assert.ok(dashboardSrc.includes("'error'"), 'dashboard.html handles the error phase');
    assert.ok(dashboardSrc.includes('error-banner'), 'dashboard.html has the error banner');
    assert.ok(dashboardSrc.includes('activeIdx === -1'), 'dashboard.html degrades gracefully on unknown phases');
  });

  await test('first progress-write failure warns once on stderr, then stays quiet', () => {
    const tmpBroken = mkTmp('brokenwrites');
    tmpDirs.push(tmpBroken);
    // Make outputDir/preview a FILE so every JSON write fails (ENOTDIR).
    fs.writeFileSync(path.join(tmpBroken, 'preview'), 'not a directory');
    const t = new ProgressTracker({ numWorkers: 1, outputDir: tmpBroken });
    const origErr = console.error;
    let warnings = 0;
    console.error = () => { warnings++; };
    try {
      withQuietStdout(() => t.start());
      t.updateWorker(0, { pct: 10 });
      t.updateWorker(0, { pct: 20 });
      t.setPhase('rendering', 'still failing writes');
      withQuietStdout(() => t.stop());
    } finally {
      console.error = origErr;
    }
    assert.strictEqual(warnings, 1, `expected exactly one stderr warning, got ${warnings}`);
  });

  await test('terminalStream: null produces zero stdout writes but still writes JSON', () => {
    const tmpQuiet = mkTmp('quiet');
    tmpDirs.push(tmpQuiet);
    const t = new ProgressTracker({
      numWorkers: 2, totalFrames: 10, outputDir: tmpQuiet, terminalStream: null,
    });
    const orig = process.stdout.write;
    let stdoutWrites = 0;
    process.stdout.write = () => { stdoutWrites++; return true; };
    try {
      t.start();
      t.updateWorker(0, { pct: 40, fps: 5, frame: 4, eta: 2, status: 'rendering' });
      t.workerDone(1);
      t.stop();
    } finally {
      process.stdout.write = orig;
    }
    assert.strictEqual(stdoutWrites, 0, `expected zero stdout writes, got ${stdoutWrites}`);
    const g = JSON.parse(fs.readFileSync(path.join(tmpQuiet, 'preview', 'global.json'), 'utf8'));
    assert.strictEqual(g.numWorkers, 2);
    const w0 = JSON.parse(fs.readFileSync(path.join(tmpQuiet, 'preview', 'worker-0.json'), 'utf8'));
    assert.strictEqual(w0.pct, 40);
    const w1 = JSON.parse(fs.readFileSync(path.join(tmpQuiet, 'preview', 'worker-1.json'), 'utf8'));
    assert.strictEqual(w1.done, true);
  });

  await test('terminalStream routes ticker output to a custom stream', () => {
    const tmpRoute = mkTmp('route');
    tmpDirs.push(tmpRoute);
    const chunks = [];
    const fakeStream = { write: (s) => { chunks.push(String(s)); return true; } };
    const t = new ProgressTracker({
      numWorkers: 1, totalFrames: 10, outputDir: tmpRoute, terminalStream: fakeStream,
    });
    const orig = process.stdout.write;
    let stdoutWrites = 0;
    process.stdout.write = () => { stdoutWrites++; return true; };
    try {
      t.start();
      t.stop();
    } finally {
      process.stdout.write = orig;
    }
    assert.strictEqual(stdoutWrites, 0, 'nothing leaks to process.stdout');
    assert.ok(chunks.length > 0, 'ticker output reaches the custom stream');
    assert.ok(chunks.some(c => c.includes('elapsed')), 'ticker header line routed');
  });

  // ======================================================================
  // Cleanup + summary
  // ======================================================================
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const f of failures) {
      console.error(`  ✗ ${f.name}`);
      console.error('    ', f.err.message);
    }
    process.exit(1);
  }
  console.log('  All dashboard tests passed.\n');
}

main().catch((err) => {
  console.error('Dashboard test harness error:', err);
  process.exit(2);
});
