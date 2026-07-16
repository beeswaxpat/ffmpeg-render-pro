/**
 * Concat - Stream-copy segment concatenation (instant, no re-encode)
 *
 * Uses ffmpeg concat demuxer with -c copy. This is the ONLY correct way
 * to join MP4 segments. Never re-encode on concat.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ffmpegBin, ffprobeBin } = require('./ffmpeg-bin');

const STDERR_CAP = 8192;

// Stream properties that must agree across every segment for -c copy concat
// to produce a playable file. ffmpeg itself does not enforce this: it exits 0
// and writes a container whose header describes only the first segment, so a
// mismatch surfaces as silent corruption in the player, not as an error here.
// Values are compared as strings (r_frame_rate arrives as e.g. "30/1").
const STREAM_PROPS = [
  ['codec_name', 'codec'],
  ['width', 'width'],
  ['height', 'height'],
  ['r_frame_rate', 'fps'],
  ['pix_fmt', 'pixel format'],
];

// Cached across calls so repeated concats don't re-spawn `ffprobe -version`.
let ffprobeAvailable = null;

function hasFfprobe() {
  if (ffprobeAvailable === null) {
    ffprobeAvailable = spawnSync(ffprobeBin(), ['-version'], { timeout: 5000 }).status === 0;
  }
  return ffprobeAvailable;
}

/** Probe one segment's first video stream. Resolves to the stream object. */
function probeSegment(segmentPath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(ffprobeBin(), [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,r_frame_rate,pix_fmt',
      '-of', 'json',
      segmentPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderrData = '';
    ffprobe.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    ffprobe.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
      if (stderrData.length > STDERR_CAP) stderrData = stderrData.slice(-STDERR_CAP);
    });

    ffprobe.on('error', (err) => {
      reject(new Error(`concatSegments: ffprobe error on ${segmentPath}: ${err.message}`));
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(
          `concatSegments: ffprobe failed on ${segmentPath} (code ${code})\n${stderrData.slice(-500)}`,
        ));
      }
      let stream;
      try {
        stream = JSON.parse(stdout).streams?.[0];
      } catch {}
      if (!stream) {
        return reject(new Error(`concatSegments: no video stream found in ${segmentPath}`));
      }
      resolve(stream);
    });
  });
}

/** Reject if any segment's stream properties differ from the first segment's. */
async function validateStreamCompat(segmentPaths) {
  const ref = await probeSegment(segmentPaths[0]);
  for (let i = 1; i < segmentPaths.length; i++) {
    const probe = await probeSegment(segmentPaths[i]);
    for (const [key, label] of STREAM_PROPS) {
      if (String(probe[key]) !== String(ref[key])) {
        throw new Error(
          `concatSegments: ${label} mismatch: ${segmentPaths[i]} is ${probe[key]}, ` +
          `but ${segmentPaths[0]} is ${ref[key]}. Stream-copy concat requires identical ` +
          `codec, resolution, fps, and pixel format; pass { validate: false } to skip this check.`,
        );
      }
    }
  }
}

/**
 * Concatenate multiple MP4 segments into one file.
 * Uses stream copy - instant regardless of file size.
 *
 * @param {string[]} segmentPaths - Array of segment file paths
 * @param {string} outputPath - Output file path
 * @param {object} [options]
 * @param {boolean} [options.validate=true] - Probe every segment with ffprobe
 *   and reject on codec/resolution/fps/pixel-format mismatch before invoking
 *   ffmpeg. Pass false to skip the probes (e.g. segments known to be uniform
 *   by construction). Skipped with a stderr warning when ffprobe is not on
 *   PATH, since ffmpeg-only installs exist.
 * @returns {Promise<void>}
 */
async function concatSegments(segmentPaths, outputPath, { validate = true } = {}) {
  if (!Array.isArray(segmentPaths) || segmentPaths.length === 0) {
    throw new Error('concatSegments: at least one segment is required');
  }

  // Validate every segment exists and is non-empty before invoking ffmpeg.
  // A worker that crashed mid-encode can leave a missing or 0-byte segment;
  // catching it here yields a clear error instead of a cryptic ffmpeg
  // concat failure (or, worse, a silently truncated output).
  const badSegments = [];
  for (const p of segmentPaths) {
    let size = -1;
    try { size = fs.statSync(p).size; } catch {}
    if (size <= 0) badSegments.push(p);
  }
  if (badSegments.length > 0) {
    throw new Error(
      `concatSegments: ${badSegments.length} of ${segmentPaths.length} segment(s) missing or empty:\n  ` +
      badSegments.join('\n  '),
    );
  }

  if (validate) {
    if (hasFfprobe()) {
      await validateStreamCompat(segmentPaths);
    } else {
      process.stderr.write(
        'concatSegments: ffprobe not found (install it on PATH or set FFMPEG_RENDER_PRO_FFPROBE); skipping segment compatibility validation\n',
      );
    }
  }

  return runConcat(segmentPaths, outputPath);
}

function runConcat(segmentPaths, outputPath) {
  return new Promise((resolve, reject) => {
    // Write the list file to os.tmpdir() with a random suffix. This avoids
    // (a) collisions when multiple concats run concurrently with the same output
    // (b) polluting the output directory with a stray .txt file.
    const listPath = path.join(
      os.tmpdir(),
      `ffmpeg-render-pro-concat-${crypto.randomBytes(8).toString('hex')}.txt`,
    );

    // Backslash is the path separator on Windows but a legal filename
    // character on POSIX, so only rewrite separators on win32.
    const listContent = segmentPaths
      .map((p) => {
        const norm = process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
        return `file '${norm.replace(/'/g, "'\\''")}'`;
      })
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

    const ffmpeg = spawn(ffmpegBin(), args, {
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
