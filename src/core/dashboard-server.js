/**
 * Dashboard Server — Zero-dependency HTTP server for the render dashboard
 *
 * Serves the HTML dashboard and JSON progress files.
 * Auto-opens the browser before rendering starts.
 * Cross-platform: Windows, macOS, Linux.
 *
 * Security posture:
 *   - Binds to 127.0.0.1 (not 0.0.0.0) — never reachable off the local machine.
 *   - Static-file server rooted at the render's `preview/` directory; requests
 *     are URL-decoded and reject path-traversal attempts.
 *   - CORS is same-origin only (no wildcard `*`). Connect-src CSP lets the
 *     dashboard script fetch only from itself.
 *   - Browser is launched with `spawn` + argv array (no shell interpolation).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const BIND_HOST = '127.0.0.1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
};

// Tight CSP — only allow resources from the dashboard's own origin.
// `unsafe-inline` is required for the bundled <style> and <script> blocks.
const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

/**
 * Open a URL in the default browser. Cross-platform.
 * Uses `spawn` with an argv array — no shell interpolation, no injection.
 *
 * @param {string} url
 */
function openBrowser(url) {
  const platform = os.platform();
  let cmd, args;

  switch (platform) {
    case 'win32':
      // cmd.exe /c start "" "<url>" — the empty title arg is required by `start`
      // when the first quoted arg would otherwise be misinterpreted as the title.
      cmd = 'cmd.exe';
      args = ['/c', 'start', '', url];
      break;
    case 'darwin':
      cmd = 'open';
      args = [url];
      break;
    default:
      cmd = 'xdg-open';
      args = [url];
      break;
  }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      if (process.env.FFMPEG_RENDER_PRO_DEBUG) {
        console.warn('  Could not auto-open browser:', err.message);
      }
    });
    child.unref();
  } catch (err) {
    if (process.env.FFMPEG_RENDER_PRO_DEBUG) {
      console.warn('  Could not auto-open browser:', err.message);
    }
  }
}

/**
 * Resolve a URL path safely to a file inside `previewDir`.
 * Returns `null` if the path escapes the root or is otherwise invalid.
 *
 * Defense stack:
 *   1. Strip query + fragment from the raw string (do NOT use WHATWG URL —
 *      it auto-normalizes `/../x` to `/x`, hiding traversal intent).
 *   2. Recursively percent-decode until stable (defeats double encoding like
 *      `%252E%252E` → `%2E%2E` → `..`).
 *   3. Reject null bytes + any other ASCII control characters.
 *   4. Normalize backslashes to forward slashes, split on `/`, reject any
 *      `..` segment regardless of casing or encoding path.
 *   5. Belt-and-braces: after resolving with `path.join`, compute
 *      `path.relative(root, candidate)` and reject `..` / absolute escapes.
 */
function resolveSafePath(rawUrl, previewDir) {
  try {
    if (typeof rawUrl !== 'string') return null;

    // 1. Strip query + fragment (the raw string — no URL normalization).
    let raw = rawUrl;
    const qIdx = raw.indexOf('?');
    if (qIdx !== -1) raw = raw.slice(0, qIdx);
    const hIdx = raw.indexOf('#');
    if (hIdx !== -1) raw = raw.slice(0, hIdx);

    // 2. Recursively decode until stable. Cap iterations to avoid pathological input.
    let decoded = raw;
    for (let i = 0; i < 5; i++) {
      let next;
      try { next = decodeURIComponent(decoded); } catch { return null; }
      if (next === decoded) break;
      decoded = next;
    }

    // 3. Reject control characters (including NUL).
    if (/[\x00-\x1f]/.test(decoded)) return null;

    // 4. Segment-level `..` rejection. Normalize both slash flavors first
    //    so `/..\secret` on Windows (or `\..` style) is caught.
    const segmentable = decoded.replace(/\\/g, '/');
    for (const seg of segmentable.split('/')) {
      if (seg === '..') return null;
    }

    // Default to dashboard.html at root.
    let urlPath = decoded;
    if (urlPath === '/' || urlPath === '') urlPath = '/dashboard.html';

    // Strip leading slashes so path.join treats it as relative.
    const relPath = urlPath.replace(/^[/\\]+/, '');

    // 5. Final resolved-path check.
    const candidate = path.normalize(path.join(previewDir, relPath));
    const rel = path.relative(previewDir, candidate);

    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

    return candidate;
  } catch {
    return null;
  }
}

/**
 * Start a dashboard server.
 *
 * @param {Object} options
 * @param {string} options.dir - Directory to serve (where preview/ JSON files are)
 * @param {number} [options.port=8080] - Starting port (increments if occupied)
 * @param {boolean} [options.silent=false] - Suppress console output
 * @param {boolean} [options.autoOpen=true] - Auto-open browser
 * @returns {Promise<{ server, url, port, stop }>}
 */
function startDashboard(options) {
  const { dir, port: startPort = 8080, silent = false, autoOpen = true } = options;

  if (typeof startPort !== 'number' || !Number.isInteger(startPort) || startPort < 1 || startPort > 65535) {
    return Promise.reject(new Error(`Invalid port: ${startPort}. Must be an integer 1-65535.`));
  }

  // Copy dashboard.html into the preview directory
  const dashboardSrc = path.join(__dirname, '..', 'dashboard', 'dashboard.html');
  const previewDir = path.join(dir, 'preview');
  if (!fs.existsSync(previewDir)) {
    fs.mkdirSync(previewDir, { recursive: true });
  }
  if (fs.existsSync(dashboardSrc)) {
    try {
      fs.copyFileSync(dashboardSrc, path.join(previewDir, 'dashboard.html'));
    } catch {}
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Only GET/HEAD are meaningful for this static server
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Allow': 'GET, HEAD' });
        res.end('Method Not Allowed');
        return;
      }

      const filePath = resolveSafePath(req.url, previewDir);
      if (!filePath) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        // Same-origin only. The server listens on BIND_HOST:port; echoing
        // back the request Origin when it matches avoids wildcard CORS
        // while still allowing the browser's own XHRs.
        const origin = `http://${BIND_HOST}:${server.address().port}`;

        const headers = {
          'Content-Type': contentType,
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Access-Control-Allow-Origin': origin,
        };

        // No cache for JSON (progress data)
        if (ext === '.json') {
          headers['Cache-Control'] = 'no-store';
        }

        res.writeHead(200, headers);
        if (req.method === 'HEAD') {
          res.end();
        } else {
          res.end(data);
        }
      });
    });

    // Try ports starting from startPort
    let port = startPort;
    const maxAttempts = 20;

    function tryListen(attempt) {
      if (attempt >= maxAttempts) {
        reject(new Error(`Could not find open port after ${maxAttempts} attempts`));
        return;
      }

      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          port++;
          tryListen(attempt + 1);
        } else {
          reject(err);
        }
      });

      server.listen(port, BIND_HOST, () => {
        const url = `http://${BIND_HOST}:${port}`;
        if (!silent) {
          console.log('');
          console.log(`  \x1b[36m\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510\x1b[0m`);
          console.log(`  \x1b[36m\u2502\x1b[0m  Dashboard: \x1b[4m${url}\x1b[0m`);
          console.log(`  \x1b[36m\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518\x1b[0m`);
          console.log('');
        }

        // Auto-open browser BEFORE render starts
        if (autoOpen) {
          openBrowser(url);
        }

        resolve({
          server,
          url,
          port,
          stop: () => new Promise(r => server.close(() => r())),
        });
      });
    }

    tryListen(0);
  });
}

module.exports = { startDashboard, openBrowser, resolveSafePath };
