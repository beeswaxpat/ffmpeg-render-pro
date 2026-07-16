/**
 * FFmpeg binary resolution - supports non-PATH installs via env vars
 *
 *   ffmpegBin()  -> FFMPEG_RENDER_PRO_FFMPEG when set and non-empty,
 *                   else 'ffmpeg' (PATH lookup, the historical behavior).
 *   ffprobeBin() -> FFMPEG_RENDER_PRO_FFPROBE when set and non-empty;
 *                   else, when FFMPEG_RENDER_PRO_FFMPEG is set, the sibling
 *                   ffprobe next to it (same directory, same extension,
 *                   'ffmpeg' -> 'ffprobe' in the basename) if that file
 *                   exists; else 'ffprobe'.
 *
 * Env vars are read at CALL time, never cached at module load, so tests and
 * long-lived processes (e.g. the MCP server) pick up changes without a
 * restart. Resolution is a few string ops plus at most one existsSync, so
 * per-spawn cost is negligible next to spawning ffmpeg itself.
 */
const fs = require('fs');
const path = require('path');

function isSet(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Resolve the ffmpeg executable to spawn.
 * @returns {string} Full path from FFMPEG_RENDER_PRO_FFMPEG, or 'ffmpeg'.
 */
function ffmpegBin() {
  const env = process.env.FFMPEG_RENDER_PRO_FFMPEG;
  return isSet(env) ? env : 'ffmpeg';
}

/**
 * Resolve the ffprobe executable to spawn.
 * @returns {string} Full path from FFMPEG_RENDER_PRO_FFPROBE, a derived
 *   sibling of FFMPEG_RENDER_PRO_FFMPEG, or 'ffprobe'.
 */
function ffprobeBin() {
  const explicit = process.env.FFMPEG_RENDER_PRO_FFPROBE;
  if (isSet(explicit)) return explicit;

  // A custom ffmpeg build ships ffprobe in the same directory, so derive it:
  // same dir, 'ffmpeg' -> 'ffprobe' in the basename (extension preserved).
  // Only trust the derivation when the basename actually changed (otherwise
  // we would return the ffmpeg binary itself) and the file exists on disk.
  const ffmpegPath = process.env.FFMPEG_RENDER_PRO_FFMPEG;
  if (isSet(ffmpegPath)) {
    const base = path.basename(ffmpegPath);
    const probeBase = base.replace('ffmpeg', 'ffprobe');
    if (probeBase !== base) {
      const candidate = path.join(path.dirname(ffmpegPath), probeBase);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {}
    }
  }
  return 'ffprobe';
}

module.exports = { ffmpegBin, ffprobeBin };
