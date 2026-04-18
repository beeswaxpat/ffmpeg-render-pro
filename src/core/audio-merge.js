/**
 * Audio Merge — Combine video with audio track
 *
 * Merges audio into video with stream-loop for short audio files,
 * optional loudness normalization, and no video re-encoding.
 */
const { spawn } = require('child_process');

const STDERR_CAP = 8192;

/**
 * Merge video with audio file.
 *
 * @param {Object} options
 * @param {string} options.videoPath - Input video file
 * @param {string} options.audioPath - Input audio file
 * @param {string} options.outputPath - Output file path
 * @param {number} [options.bitrate=320] - Audio bitrate in kbps
 * @param {boolean} [options.loop=true] - Loop audio if shorter than video
 * @param {boolean} [options.normalize=false] - Apply loudnorm filter
 * @returns {Promise<void>}
 */
function mergeAudio(options) {
  const {
    videoPath, audioPath, outputPath,
    bitrate = 320,
    loop = true,
    normalize = false,
  } = options;

  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', videoPath];

    if (loop) {
      args.push('-stream_loop', '-1');
    }
    args.push('-i', audioPath);

    args.push('-c:v', 'copy');

    if (normalize) {
      args.push('-af', 'loudnorm=I=-22:TP=-2:LRA=7');
    }

    args.push(
      '-c:a', 'aac',
      '-b:a', `${bitrate}k`,
      '-shortest',
      '-movflags', '+faststart',
      outputPath,
    );

    const ffmpeg = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrData = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
      if (stderrData.length > STDERR_CAP) stderrData = stderrData.slice(-STDERR_CAP);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Audio merge failed (code ${code})\n${stderrData.slice(-500)}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`Audio merge error: ${err.message}`));
    });
  });
}

module.exports = { mergeAudio };
