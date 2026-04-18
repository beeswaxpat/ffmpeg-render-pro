#!/usr/bin/env node
/**
 * MCP smoke test — boots the stdio MCP server, runs through:
 *   1. initialize handshake
 *   2. tools/list
 *   3. tools/call detect_gpu
 *   4. tools/call system_info
 * and asserts each response.
 *
 * No external test framework. Prints a one-line summary and exits 0/1.
 */
const { spawn } = require('child_process');
const path = require('path');

function request(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

function main() {
  return new Promise((resolve, reject) => {
    const mcp = spawn('node', [path.join(__dirname, '..', 'src', 'mcp-server.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    const messages = [];
    mcp.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
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

    const waitFor = (id, timeoutMs = 10000) => new Promise((res, rej) => {
      const deadline = Date.now() + timeoutMs;
      (function poll() {
        const msg = messages.find(m => m.id === id);
        if (msg) return res(msg);
        if (Date.now() > deadline) return rej(new Error('timeout waiting for id=' + id));
        setTimeout(poll, 50);
      })();
    });

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
      console.log('PASS initialize  (server version: ' + serverVersion + ')');

      // notifications/initialized
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      // 2. tools/list
      mcp.stdin.write(request(2, 'tools/list', {}));
      const list = await waitFor(2);
      if (!list.result || !Array.isArray(list.result.tools)) throw new Error('tools/list failed');
      const toolNames = list.result.tools.map(t => t.name).sort();
      const expected = ['color_grade', 'concat_videos', 'detect_gpu', 'merge_audio', 'render_video', 'system_info'];
      for (const t of expected) {
        if (!toolNames.includes(t)) throw new Error('missing tool: ' + t);
      }
      console.log('PASS tools/list  (' + toolNames.length + ' tools: ' + toolNames.join(', ') + ')');

      // 3. detect_gpu
      mcp.stdin.write(request(3, 'tools/call', { name: 'detect_gpu', arguments: { force_mode: 'auto' } }));
      const gpu = await waitFor(3, 15000);
      if (!gpu.result) throw new Error('detect_gpu failed: ' + JSON.stringify(gpu));
      const gpuText = gpu.result.content.map(c => c.text).join('\n');
      if (!gpuText.includes('H.264 encoder')) throw new Error('detect_gpu response missing expected text');
      console.log('PASS detect_gpu  (got encoder info)');

      // 4. system_info
      mcp.stdin.write(request(4, 'tools/call', { name: 'system_info', arguments: { width: 1920, height: 1080 } }));
      const info = await waitFor(4, 15000);
      if (!info.result) throw new Error('system_info failed: ' + JSON.stringify(info));
      const infoText = info.result.content.map(c => c.text).join('\n');
      if (!infoText.includes('CPU cores')) throw new Error('system_info response missing CPU cores');
      console.log('PASS system_info (got system snapshot)');

      // Version should match package.json
      const pkgVersion = require('../package.json').version;
      if (serverVersion !== pkgVersion) {
        throw new Error('MCP server version (' + serverVersion + ') != package.json (' + pkgVersion + ')');
      }
      console.log('PASS version-sync (MCP reports ' + serverVersion + ' = package.json)');

      mcp.kill();
      console.log('\n  All MCP smoke tests passed.');
      resolve();
    })().catch((err) => {
      try { mcp.kill(); } catch {}
      reject(err);
    });
  });
}

main().then(() => process.exit(0), (err) => {
  console.error('\n  MCP smoke test FAILED:', err.message);
  process.exit(1);
});
