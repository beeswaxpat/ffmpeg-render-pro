#!/usr/bin/env node
/**
 * MCP smoke test - boots the stdio MCP server and exercises EVERY tool:
 *   - initialize handshake + tools/list metadata (annotations, outputSchema)
 *   - detect_gpu / system_info / get_worker_template success paths
 *   - unknown tool name and invalid arguments (JSON-RPC error surface)
 *   - missing-input error paths for color_grade / merge_audio / concat_videos
 *     / render_video
 *   - a REAL tiny render (64x64, 0.5s @ 4fps) with structured output + file
 *     on disk, then a second render asserting notifications/progress frames
 *   - a REAL stream-copy concat with validation
 *   - version drift guards (package.json vs MCP serverInfo vs server.json)
 *   - CRITICAL protocol hygiene: every byte the server writes to stdout must
 *     parse as a JSON-RPC frame (regression test for stdout pollution)
 *
 * No external test framework. Prints one PASS line per check and exits 0/1.
 * Requires ffmpeg (same assumption as the rest of the suite).
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function request(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

let passCount = 0;
function pass(name) {
  passCount++;
  console.log('PASS ' + name);
}

function main() {
  return new Promise((resolve, reject) => {
    const mcp = spawn('node', [path.join(__dirname, '..', 'src', 'mcp-server.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // rawStdout keeps EVERY byte for the protocol-hygiene assertion; the
    // line parser below additionally collects parsed frames for waitFor.
    let rawStdout = '';
    let stdoutBuf = '';
    const messages = [];
    mcp.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      rawStdout += s;
      stdoutBuf += s;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try { messages.push(JSON.parse(line)); } catch {}
      }
    });

    let stderrBuf = '';
    mcp.stderr.on('data', c => { stderrBuf += c.toString(); });

    mcp.on('error', reject);
    mcp.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error('MCP exited ' + code + ': ' + stderrBuf));
    });

    const waitFor = (id, timeoutMs = 15000) => new Promise((res, rej) => {
      const deadline = Date.now() + timeoutMs;
      (function poll() {
        const msg = messages.find(m => m.id === id);
        if (msg) return res(msg);
        if (Date.now() > deadline) return rej(new Error('timeout waiting for id=' + id));
        setTimeout(poll, 50);
      })();
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-mcp-smoke-'));
    const workerScript = path.join(__dirname, '..', 'examples', 'basic-worker.js');

    (async () => {
      // 1. initialize
      mcp.stdin.write(request(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0.0.0' },
      }));
      const init = await waitFor(1);
      if (!init.result) throw new Error('initialize failed: ' + JSON.stringify(init));
      if (!init.result.serverInfo) throw new Error('initialize missing serverInfo');
      const serverVersion = init.result.serverInfo.version;
      pass('initialize  (server version: ' + serverVersion + ')');

      // notifications/initialized
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      // 2. tools/list
      mcp.stdin.write(request(2, 'tools/list', {}));
      const list = await waitFor(2);
      if (!list.result || !Array.isArray(list.result.tools)) throw new Error('tools/list failed');
      const tools = list.result.tools;
      const toolNames = tools.map(t => t.name).sort();
      const expected = ['color_grade', 'concat_videos', 'detect_gpu', 'get_worker_template', 'merge_audio', 'render_video', 'system_info'];
      for (const t of expected) {
        if (!toolNames.includes(t)) throw new Error('missing tool: ' + t);
      }
      pass('tools/list  (' + toolNames.length + ' tools: ' + toolNames.join(', ') + ')');

      // 3. every tool advertises annotations AND outputSchema
      for (const t of tools) {
        if (!t.annotations || typeof t.annotations !== 'object') {
          throw new Error('tool ' + t.name + ' missing annotations');
        }
        if (!t.outputSchema || typeof t.outputSchema !== 'object' || !t.outputSchema.properties) {
          throw new Error('tool ' + t.name + ' missing outputSchema');
        }
      }
      pass('tool-metadata (annotations + outputSchema on all ' + tools.length + ' tools)');

      // 4. annotation values: writers destructive, probes read-only
      const byName = Object.fromEntries(tools.map(t => [t.name, t]));
      for (const name of ['render_video', 'color_grade', 'merge_audio', 'concat_videos']) {
        const a = byName[name].annotations;
        if (a.destructiveHint !== true) throw new Error(name + ' should have destructiveHint: true');
        if (a.idempotentHint !== false) throw new Error(name + ' should have idempotentHint: false');
        if (a.openWorldHint !== false) throw new Error(name + ' should have openWorldHint: false');
      }
      for (const name of ['detect_gpu', 'system_info', 'get_worker_template']) {
        const a = byName[name].annotations;
        if (a.readOnlyHint !== true) throw new Error(name + ' should have readOnlyHint: true');
        if (a.openWorldHint !== false) throw new Error(name + ' should have openWorldHint: false');
      }
      pass('tool-annotations (destructive writers, read-only probes)');

      // 5. input schemas advertise the expected params
      const renderProps = (byName.render_video.inputSchema && byName.render_video.inputSchema.properties) || {};
      for (const p of ['max_workers', 'dashboard_port', 'linger_ms', 'dashboard', 'auto_open', 'workers', 'seed', 'fps']) {
        if (!renderProps[p]) throw new Error('render_video schema missing param: ' + p);
      }
      const gradeProps = (byName.color_grade.inputSchema && byName.color_grade.inputSchema.properties) || {};
      for (const p of ['keep_audio', 'crf']) {
        if (!gradeProps[p]) throw new Error('color_grade schema missing param: ' + p);
      }
      const concatProps = (byName.concat_videos.inputSchema && byName.concat_videos.inputSchema.properties) || {};
      if (!concatProps.validate) throw new Error('concat_videos schema missing param: validate');
      pass('tool-schemas (optional params + concat validate advertised)');

      // 6. detect_gpu: text + structured output
      mcp.stdin.write(request(3, 'tools/call', { name: 'detect_gpu', arguments: { force_mode: 'auto' } }));
      const gpu = await waitFor(3, 20000);
      if (!gpu.result) throw new Error('detect_gpu failed: ' + JSON.stringify(gpu));
      const gpuText = gpu.result.content.map(c => c.text).join('\n');
      if (!gpuText.includes('H.264 encoder')) throw new Error('detect_gpu response missing expected text');
      const gpuSc = gpu.result.structuredContent;
      if (!gpuSc) throw new Error('detect_gpu missing structuredContent');
      if (typeof gpuSc.h264 !== 'string') throw new Error('detect_gpu structuredContent.h264 not a string');
      if (typeof gpuSc.isGpu !== 'boolean') throw new Error('detect_gpu structuredContent.isGpu not a boolean');
      if (!Array.isArray(gpuSc.all) || gpuSc.all.length === 0) throw new Error('detect_gpu structuredContent.all not a non-empty array');
      if (typeof gpuSc.ffmpegVersion !== 'string') throw new Error('detect_gpu structuredContent.ffmpegVersion not a string');
      pass('detect_gpu  (text + structuredContent: ' + gpuSc.h264 + ', isGpu=' + gpuSc.isGpu + ')');

      // 7. detect_gpu force cpu mode
      mcp.stdin.write(request(4, 'tools/call', { name: 'detect_gpu', arguments: { force_mode: 'cpu' } }));
      const cpuMode = await waitFor(4, 20000);
      const cpuSc = cpuMode.result.structuredContent;
      if (!cpuSc || cpuSc.h264 !== 'libx264' || cpuSc.isGpu !== false) {
        throw new Error('detect_gpu cpu mode should report libx264/isGpu=false, got ' + JSON.stringify(cpuSc));
      }
      pass('detect_gpu (force cpu -> libx264 in structuredContent)');

      // 8. system_info: text + structured output
      mcp.stdin.write(request(5, 'tools/call', { name: 'system_info', arguments: { width: 1920, height: 1080 } }));
      const info = await waitFor(5, 20000);
      if (!info.result) throw new Error('system_info failed: ' + JSON.stringify(info));
      const infoText = info.result.content.map(c => c.text).join('\n');
      if (!infoText.includes('CPU cores')) throw new Error('system_info response missing CPU cores');
      const infoSc = info.result.structuredContent;
      if (!infoSc) throw new Error('system_info missing structuredContent');
      if (!Number.isInteger(infoSc.cpuCores) || infoSc.cpuCores < 1) throw new Error('system_info cpuCores invalid');
      if (!Number.isInteger(infoSc.workers) || infoSc.workers < 1) throw new Error('system_info workers invalid');
      if (typeof infoSc.platform !== 'string' || typeof infoSc.segmentCodec !== 'string' || typeof infoSc.finalCodec !== 'string') {
        throw new Error('system_info structuredContent missing platform/codecs');
      }
      pass('system_info (text + structuredContent: ' + infoSc.cpuCores + ' cores, ' + infoSc.workers + ' workers)');

      // 9. get_worker_template: contract + bundled worker source
      mcp.stdin.write(request(6, 'tools/call', { name: 'get_worker_template', arguments: {} }));
      const tmpl = await waitFor(6);
      if (!tmpl.result || tmpl.result.isError) throw new Error('get_worker_template failed: ' + JSON.stringify(tmpl));
      const tmplSc = tmpl.result.structuredContent;
      if (!tmplSc) throw new Error('get_worker_template missing structuredContent');
      for (const field of ['width', 'height', 'fps', 'seed', 'startFrame', 'endFrame', 'segmentPath', 'workerId', 'totalFrames', 'duration']) {
        if (typeof tmplSc.workerData[field] !== 'string') throw new Error('get_worker_template workerData missing field: ' + field);
      }
      const msgTypes = tmplSc.messages.map(m => m.type);
      for (const t of ['progress', 'done', 'error']) {
        if (!msgTypes.includes(t)) throw new Error('get_worker_template messages missing type: ' + t);
      }
      if (!fs.existsSync(tmplSc.templatePath)) throw new Error('get_worker_template templatePath does not exist: ' + tmplSc.templatePath);
      if (!tmplSc.templateSource.includes('parentPort.postMessage')) throw new Error('get_worker_template templateSource does not look like a worker script');
      const tmplText = tmpl.result.content.map(c => c.text).join('\n');
      if (!tmplText.includes('segmentPath') || !tmplText.includes('startFrame')) throw new Error('get_worker_template text missing contract fields');
      pass('get_worker_template (contract + bundled source, ' + tmplSc.templateSource.length + ' chars)');

      // 10. unknown tool name -> JSON-RPC error
      mcp.stdin.write(request(7, 'tools/call', { name: 'no_such_tool', arguments: {} }));
      const unknown = await waitFor(7);
      if (!unknown.error && !(unknown.result && unknown.result.isError)) {
        throw new Error('unknown tool should produce a JSON-RPC error or isError result');
      }
      pass('unknown-tool (no_such_tool -> error)');

      // 11. invalid args: missing required duration -> zod validation error
      mcp.stdin.write(request(8, 'tools/call', { name: 'render_video', arguments: {
        worker_script: workerScript,
        output_path: path.join(tmpDir, 'never.mp4'),
      } }));
      const missingArg = await waitFor(8);
      if (!missingArg.error && !(missingArg.result && missingArg.result.isError)) {
        throw new Error('render_video without duration should produce a validation error');
      }
      pass('invalid-args (missing duration -> validation error)');

      // 12. invalid args: bad enum value
      mcp.stdin.write(request(9, 'tools/call', { name: 'detect_gpu', arguments: { force_mode: 'banana' } }));
      const badEnum = await waitFor(9);
      if (!badEnum.error && !(badEnum.result && badEnum.result.isError)) {
        throw new Error('detect_gpu with force_mode=banana should produce a validation error');
      }
      pass('invalid-args (bad enum -> validation error)');

      // 13. color_grade with a missing input file -> isError with actionable text
      mcp.stdin.write(request(10, 'tools/call', { name: 'color_grade', arguments: {
        input_path: path.join(tmpDir, 'definitely-not-real-' + Date.now() + '.mp4'),
        output_path: path.join(tmpDir, 'out.mp4'),
        preset: 'noir',
      } }));
      const gradeErr = await waitFor(10, 20000);
      if (!gradeErr.result || !gradeErr.result.isError) throw new Error('color_grade should return isError for a missing input');
      if (!/not found/i.test(gradeErr.result.content[0].text)) throw new Error('color_grade error text not actionable: ' + gradeErr.result.content[0].text);
      pass('color_grade (missing input -> isError with path)');

      // 14. merge_audio with missing input files -> isError
      mcp.stdin.write(request(11, 'tools/call', { name: 'merge_audio', arguments: {
        video_path: path.join(tmpDir, 'no-video-' + Date.now() + '.mp4'),
        audio_path: path.join(tmpDir, 'no-audio-' + Date.now() + '.mp3'),
        output_path: path.join(tmpDir, 'merged.mp4'),
      } }));
      const mergeErr = await waitFor(11, 20000);
      if (!mergeErr.result || !mergeErr.result.isError) throw new Error('merge_audio should return isError for missing inputs');
      if (!/not found/i.test(mergeErr.result.content[0].text)) throw new Error('merge_audio error text not actionable: ' + mergeErr.result.content[0].text);
      pass('merge_audio (missing inputs -> isError with path)');

      // 15. concat_videos with a missing input -> isError
      mcp.stdin.write(request(12, 'tools/call', { name: 'concat_videos', arguments: {
        input_files: [path.join(tmpDir, 'no-segment-' + Date.now() + '.mp4')],
        output_path: path.join(tmpDir, 'joined.mp4'),
      } }));
      const concatErr = await waitFor(12, 20000);
      if (!concatErr.result || !concatErr.result.isError) throw new Error('concat_videos should return isError for a missing input');
      if (!/not found/i.test(concatErr.result.content[0].text)) throw new Error('concat_videos error text not actionable: ' + concatErr.result.content[0].text);
      pass('concat_videos (missing input -> isError with path)');

      // 16. render_video with a nonexistent worker script -> isError
      mcp.stdin.write(request(13, 'tools/call', { name: 'render_video', arguments: {
        worker_script: path.join(tmpDir, 'no-worker-' + Date.now() + '.js'),
        output_path: path.join(tmpDir, 'never.mp4'),
        duration: 0.5,
      } }));
      const workerErr = await waitFor(13, 20000);
      if (!workerErr.result || !workerErr.result.isError) throw new Error('render_video should return isError for a missing worker script');
      if (!/Worker script not found/i.test(workerErr.result.content[0].text)) throw new Error('render_video error text unexpected: ' + workerErr.result.content[0].text);
      pass('render_video (missing worker script -> isError)');

      // 17. REAL tiny render: 64x64, 0.5s @ 4fps = 2 frames, 1 worker, headless
      const renderOutA = path.join(tmpDir, 'render-a.mp4');
      mcp.stdin.write(request(14, 'tools/call', { name: 'render_video', arguments: {
        worker_script: workerScript,
        output_path: renderOutA,
        width: 64, height: 64, fps: 4, duration: 0.5,
        workers: 1, seed: 7,
        dashboard: false, auto_open: false, linger_ms: 0,
      } }));
      const render = await waitFor(14, 90000);
      if (!render.result) throw new Error('render_video failed: ' + JSON.stringify(render));
      if (render.result.isError) throw new Error('render_video returned isError: ' + render.result.content[0].text);
      const renderText = render.result.content.map(c => c.text).join('\n');
      if (!renderText.includes('Render Complete')) throw new Error('render_video text missing Render Complete');
      const rsc = render.result.structuredContent;
      if (!rsc) throw new Error('render_video missing structuredContent');
      if (typeof rsc.outputPath !== 'string') throw new Error('render_video structuredContent.outputPath not a string');
      if (rsc.totalFrames !== 2) throw new Error('render_video structuredContent.totalFrames expected 2, got ' + rsc.totalFrames);
      if (typeof rsc.elapsedSeconds !== 'number' || rsc.elapsedSeconds < 0) throw new Error('render_video structuredContent.elapsedSeconds invalid');
      if (typeof rsc.avgFps !== 'number') throw new Error('render_video structuredContent.avgFps invalid');
      if (!fs.existsSync(rsc.outputPath)) throw new Error('render_video output file missing: ' + rsc.outputPath);
      if (fs.statSync(rsc.outputPath).size < 500) throw new Error('render_video output file suspiciously small');
      pass('render_video (real 2-frame render, structuredContent + file on disk, ' + fs.statSync(rsc.outputPath).size + ' bytes)');

      // 18. render_video with a progressToken -> notifications/progress frames
      const renderOutB = path.join(tmpDir, 'render-b.mp4');
      mcp.stdin.write(request(15, 'tools/call', {
        name: 'render_video',
        arguments: {
          worker_script: workerScript,
          output_path: renderOutB,
          width: 64, height: 64, fps: 4, duration: 0.5,
          workers: 1, seed: 7,
          dashboard: false, auto_open: false, linger_ms: 0,
        },
        _meta: { progressToken: 'smoke-progress' },
      }));
      const renderB = await waitFor(15, 90000);
      if (!renderB.result || renderB.result.isError) throw new Error('progress render failed: ' + JSON.stringify(renderB));
      const progressFrames = messages.filter(m =>
        m.method === 'notifications/progress' && m.params && m.params.progressToken === 'smoke-progress'
      );
      if (progressFrames.length < 1) throw new Error('expected at least one notifications/progress frame, got 0');
      for (const f of progressFrames) {
        if (typeof f.params.progress !== 'number') throw new Error('progress notification missing numeric progress');
      }
      pass('render_video (progressToken -> ' + progressFrames.length + ' notifications/progress frames)');

      // 19. REAL concat: join the rendered file with itself, validation on
      const concatOut = path.join(tmpDir, 'concat.mp4');
      mcp.stdin.write(request(16, 'tools/call', { name: 'concat_videos', arguments: {
        input_files: [renderOutA, renderOutA],
        output_path: concatOut,
        validate: true,
      } }));
      const concat = await waitFor(16, 30000);
      if (!concat.result || concat.result.isError) throw new Error('concat_videos failed: ' + JSON.stringify(concat));
      const csc = concat.result.structuredContent;
      if (!csc || csc.validated !== true || !Array.isArray(csc.segments) || csc.segments.length !== 2) {
        throw new Error('concat_videos structuredContent unexpected: ' + JSON.stringify(csc));
      }
      if (!fs.existsSync(csc.outputPath)) throw new Error('concat_videos output file missing: ' + csc.outputPath);
      pass('concat_videos (real stream-copy concat, validated, file on disk)');

      // 20. Version should match package.json
      const pkg = require('../package.json');
      if (serverVersion !== pkg.version) {
        throw new Error('MCP server version (' + serverVersion + ') != package.json (' + pkg.version + ')');
      }
      pass('version-sync (MCP reports ' + serverVersion + ' = package.json)');

      // 21. server.json drift guard: version + mcpName must match package.json
      const serverJson = require('../server.json');
      if (serverJson.version !== pkg.version) {
        throw new Error('server.json version (' + serverJson.version + ') != package.json (' + pkg.version + ')');
      }
      if (serverJson.name !== pkg.mcpName) {
        throw new Error('server.json name (' + serverJson.name + ') != package.json mcpName (' + pkg.mcpName + ')');
      }
      const pkgEntry = (serverJson.packages || [])[0];
      if (pkgEntry && pkgEntry.version !== pkg.version) {
        throw new Error('server.json packages[0].version (' + pkgEntry.version + ') != package.json (' + pkg.version + ')');
      }
      pass('server-json-sync (server.json name + version match package.json)');

      // 22. CRITICAL protocol hygiene: every stdout byte must be JSON-RPC.
      // Give the transport a beat to flush, then audit the full transcript.
      await new Promise(r => setTimeout(r, 250));
      const lines = rawStdout.split('\n');
      const junk = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch {
          junk.push(trimmed.slice(0, 120));
          continue;
        }
        if (!parsed || parsed.jsonrpc !== '2.0') junk.push(trimmed.slice(0, 120));
      }
      if (junk.length > 0) {
        throw new Error('stdout protocol channel polluted with ' + junk.length + ' non-JSON-RPC line(s):\n  ' + junk.slice(0, 5).join('\n  '));
      }
      pass('stdout-protocol-hygiene (every stdout line is a JSON-RPC frame, ' + lines.filter(l => l.trim()).length + ' frames audited)');

      mcp.kill();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      console.log('\n  All ' + passCount + ' MCP smoke tests passed.');
      resolve();
    })().catch((err) => {
      try { mcp.kill(); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      reject(err);
    });
  });
}

main().then(() => process.exit(0), (err) => {
  console.error('\n  MCP smoke test FAILED:', err.message);
  process.exit(1);
});
