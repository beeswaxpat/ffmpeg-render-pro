/**
 * Concat — Stream-copy segment concatenation (instant, no re-encode)
 *
 * Uses ffmpeg concat demuxer with -c copy. This is the ONLY correct way
 * to join MP4 segments. Never re-encode on concat.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STDERR_CAP = 8192;

/**
 * Concatenate multiple MP4 segments into one file.
 * Uses stream copy — instant regardless of file size.
 *
 * @param {string[]} segmentPaths - Array of segment file paths
 * @param {string} outputPath - Output file path
 * @returns {Promise<void>}
 */
function concatSegments(segmentPaths, outputPath) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(segmentPaths) || segmentPaths.length === 0) {
      return reject(new Error('concatSegments: at least one segment is required'));
    }

    // Write the list file to os.tmpdir() with a random suffix. This avoids
    // (a) collisions when multiple concats run concurrently with the same output
    // (b) polluting the output directory with a stray .txt file.
    const listPath = path.join(
      os.tmpdir(),
      `ffmpeg-render-pro-concat-${crypto.randomBytes(8).toString('hex')}.txt`,
    );

    const listContent = segmentPaths
      .map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');

    try {
      fs.writeFileSync(listPath, listContent);
    } catch (err) {
      return reject(new Error(`Concat: failed to write list file: ${err.message}`));
    }

    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ];

    const ffmpeg = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrData = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
      if (stderrData.length > STDERR_CAP) stderrData = stderrData.slice(-STDERR_CAP);
    });

    ffmpeg.on('close', (code) => {
      try { fs.unlinkSync(listPath); } catch {}
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Concat failed (code ${code})\n${stderrData.slice(-500)}`));
      }
    });

    ffmpeg.on('error', (err) => {
      try { fs.unlinkSync(listPath); } catch {}
      reject(new Error(`Concat error: ${err.message}`));
    });
  });
}

module.exports = { concatSegments };
