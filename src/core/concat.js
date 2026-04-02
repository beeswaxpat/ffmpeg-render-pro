/**
 * Concat — Stream-copy segment concatenation (instant, no re-encode)
 *
 * Uses ffmpeg concat demuxer with -c copy. This is the ONLY correct way
 * to join MP4 segments. Never re-encode on concat.
 */
const { spawn } = require('child_process');
const fs = require('fs');

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
    // Escape single quotes in paths and normalize to forward slashes for ffmpeg
    const listContent = segmentPaths
      .map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    const listPath = outputPath.replace(/\.mp4$/, '') + '-concat-list.txt';
    fs.writeFileSync(listPath, listContent);

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
      reject(new Error(`Concat error: ${err.message}`));
    });
  });
}

module.exports = { concatSegments };
