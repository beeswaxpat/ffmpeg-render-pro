/**
 * Dashboard Server — Zero-dependency HTTP server for the render dashboard
 *
 * Serves the HTML dashboard and JSON progress files.
 * Auto-opens the browser before rendering starts.
 * Cross-platform: Windows, macOS, Linux.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
};

/**
 * Open a URL in the default browser. Cross-platform.
 * @param {string} url
 */
function openBrowser(url) {
  const platform = os.platform();
  let cmd;
  switch (platform) {
    case 'win32':
      cmd = `start "" "${url}"`;
      break;
    case 'darwin':
      cmd = `open "${url}"`;
      break;
    default: // linux, freebsd, etc.
      // Try xdg-open first, fall back to sensible-browser, then x-www-browser
      cmd = `xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null || x-www-browser "${url}" 2>/dev/null`;
      break;
  }

  exec(cmd, (err) => {
    // Silently ignore errors — headless servers won't have a browser
    if (err && process.env.FFMPEG_RENDER_PRO_DEBUG) {
      console.warn('  Could not auto-open browser:', err.message);
    }
  });
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
      let filePath = path.join(previewDir, req.url === '/' ? 'dashboard.html' : req.url.split('?')[0]);
      filePath = path.normalize(filePath);

      // Security: prevent directory traversal
      if (!filePath.startsWith(path.normalize(previewDir))) {
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

        const ext = path.extname(filePath);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        // No cache for JSON (progress data)
        if (ext === '.json') {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
        } else {
          res.writeHead(200, { 'Content-Type': contentType });
        }

        res.end(data);
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

      server.listen(port, () => {
        const url = `http://localhost:${port}`;
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
          stop: () => new Promise(r => server.close(r)),
        });
      });
    }

    tryListen(0);
  });
}

module.exports = { startDashboard, openBrowser };
