#!/usr/bin/env node
/**
 * Render assets/banner.txt into assets/banner.svg.
 *
 * The README banner used to sit in a fenced code block. That renders fine in a
 * terminal and on GitHub, but directory sites (Glama among them) wrap <pre>
 * instead of scrolling it, and a 58-column box wrapped at ~40 columns on a
 * phone is unreadable. An SVG scales instead of wrapping, so the same art
 * survives every surface.
 *
 * Block characters become rects, so the letterforms do not depend on the
 * viewer having any particular monospace font. The two label rows are real
 * text with textLength pinned to their grid width, which keeps them aligned
 * whatever font resolves.
 *
 * Usage: node tools/gen-banner.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'assets', 'banner.txt');
const OUT = path.join(root, 'assets', 'banner.svg');

// Grid geometry. CW/CH are the character cell size in SVG units; adjacent
// full blocks share edges so letters come out solid.
const CW = 10;
const CH = 18;
const PAD = 26;

const COLORS = {
  bg: '#0b0e14',
  border: '#2b3440',
  glyph: '#e6edf3',
  barFill: '#3fb950',
  barTrack: '#30363d',
  label: '#8b949e',
};

// Shade characters map to an opacity on the accent color; the full block is
// the letterform itself.
const SHADES = { '▓': 1, '▒': 0.6, '░': 1 };
const FULL = '█';

function loadInterior() {
  const lines = readFileSync(SRC, 'utf-8').replace(/\r\n/g, '\n').split('\n');
  // Drop the drawn box: the top and bottom rules, the leading indent, and the
  // vertical rules on each side. The border is redrawn as one rect.
  const body = lines.filter((l) => l.includes('║'));
  return body.map((l) => {
    const start = l.indexOf('║') + 1;
    const end = l.lastIndexOf('║');
    return [...l.slice(start, end)];
  });
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The cell grid, drawn in the background color over the glyphs.
 *
 * The blocks themselves are merged into solid runs, so the grid is not an
 * artifact of abutting rects: it is drawn on purpose, at a fixed width, and
 * therefore looks the same at every scale and in every renderer. Labels are
 * emitted after this so no rule crosses the text.
 */
function gridOverlay(cols, rowCount) {
  const lines = [];
  const x0 = PAD;
  const y0 = PAD;
  const x1 = PAD + cols * CW;
  const y1 = PAD + rowCount * CH;
  for (let c = 1; c < cols; c++) {
    const x = x0 + c * CW;
    lines.push(`<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}"/>`);
  }
  for (let r = 1; r < rowCount; r++) {
    const y = y0 + r * CH;
    lines.push(`<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/>`);
  }
  return `<g stroke="${COLORS.bg}" stroke-width="1">\n${lines.join('\n')}\n</g>`;
}

function build(rows) {
  const cols = Math.max(...rows.map((r) => r.length));
  const w = cols * CW + PAD * 2;
  const h = rows.length * CH + PAD * 2;
  const parts = [];
  const labels = [];

  rows.forEach((row, y) => {
    const top = PAD + y * CH;
    let run = null;

    const flush = () => {
      if (!run) return;
      const raw = run.chars.join('');
      const text = raw.trim();
      if (text) {
        // Pin the run to the columns it actually occupies. Padding spaces on
        // either side must not stretch the glyphs, or textLength spreads a
        // short label across the whole run.
        const lead = raw.length - raw.trimStart().length;
        labels.push(
          `<text x="${PAD + (run.start + lead) * CW}" y="${top + CH - 5}" ` +
            `textLength="${text.length * CW}" lengthAdjust="spacingAndGlyphs" ` +
            `font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" ` +
            `font-size="${CH - 5}" fill="${COLORS.label}">${esc(text)}</text>`
        );
      }
      run = null;
    };

    for (let x = 0; x < row.length; x++) {
      const ch = row[x];

      // Consecutive identical block cells become ONE rect. Separate rects
      // that merely abut each other show hairline seams once the SVG is
      // scaled down to a phone, because the shared edge lands on a
      // fractional device pixel.
      if (ch === FULL || ch in SHADES) {
        flush();
        let end = x;
        while (end + 1 < row.length && row[end + 1] === ch) end++;
        const span = (end - x + 1) * CW;
        const left = PAD + x * CW;
        if (ch === FULL) {
          // A half-unit of vertical bleed closes the seam between stacked rows.
          parts.push(
            `<rect x="${left}" y="${top}" width="${span}" height="${CH + 0.5}" fill="${COLORS.glyph}"/>`
          );
        } else {
          // The progress bar: dark shade is elapsed, light shade is the track.
          const fill = ch === '░' ? COLORS.barTrack : COLORS.barFill;
          const inset = 3;
          parts.push(
            `<rect x="${left}" y="${top + inset}" width="${span}" height="${CH - inset * 2}" ` +
              `fill="${fill}" opacity="${SHADES[ch]}"/>`
          );
        }
        x = end;
      } else if (ch === ' ') {
        // A space inside a text run is part of the label; a space outside one
        // is just grid padding.
        if (run) run.chars.push(ch);
      } else {
        if (!run) run = { start: x, chars: [] };
        run.chars.push(ch);
      }
    }
    flush();
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="ffmpeg-render-pro">
<title>ffmpeg-render-pro</title>
<rect width="${w}" height="${h}" rx="10" fill="${COLORS.bg}"/>
<rect x="5.5" y="5.5" width="${w - 11}" height="${h - 11}" rx="7" fill="none" stroke="${COLORS.border}"/>
${parts.join('\n')}
${gridOverlay(cols, rows.length)}
${labels.join('\n')}
</svg>
`;
}

const rows = loadInterior();
if (rows.length === 0) throw new Error(`no bordered rows found in ${SRC}`);
writeFileSync(OUT, build(rows), 'utf-8');
console.log(`wrote ${OUT} (${rows.length} rows x ${Math.max(...rows.map((r) => r.length))} cols)`);
