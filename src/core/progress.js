/**
 * Progress Tracker - Per-worker progress collection and reporting
 *
 * Emits events for the dashboard and terminal display.
 * Writes JSON progress files for the HTML dashboard to consume.
 */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

class ProgressTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.numWorkers = options.numWorkers || 8;
    this.totalFrames = options.totalFrames || 0;
    this.framesPerWorker = options.framesPerWorker || 0;
    this.outputDir = options.outputDir || '.';
    this.startTime = Date.now();
    this.title = options.title || 'ffmpeg-render-pro';
    this.resolution = options.resolution || '1920x1080';
    // Where the ANSI terminal ticker is written. Default: process.stdout
    // (unchanged behavior). Pass null to disable ALL terminal output while
    // keeping the dashboard JSON writes - required when stdout is a
    // protocol channel (MCP stdio) rather than a console.
    this._terminalStream = options.terminalStream === undefined ? process.stdout : options.terminalStream;

    this.workers = new Array(this.numWorkers).fill(null).map(() => ({
      pct: 0, fps: 0, frame: 0, eta: 0, status: 'waiting', done: false,
    }));

    // Pipeline phase tracking
    this.phase = 'initializing';
    this.phaseDetail = 'Starting up...';

    this._dashboardInterval = null;
    this._previewDir = path.join(this.outputDir, 'preview');
    // JSON files and the terminal ticker only exist after start(). Guarding on
    // this keeps a dashboard-less render from writing preview files it never
    // serves, and from cursor-up redrawing bars that were never drawn (which
    // overwrote unrelated console output in library use).
    this._started = false;
    // Progress writes are best-effort (a failed write must never kill a
    // render), but the first failure gets one stderr warning instead of
    // the dashboard silently going dark forever.
    this._writeWarned = false;
  }

  /**
   * Start the progress tracker (terminal + JSON output).
   */
  start() {
    this._started = true;
    if (!fs.existsSync(this._previewDir)) {
      fs.mkdirSync(this._previewDir, { recursive: true });
    }

    // Clear stale progress JSON from a previous render into the same output
    // dir. Leftover worker-*.json files saying done:true made the dashboard
    // declare RENDER COMPLETE on its first poll of a fresh run.
    try {
      for (const name of fs.readdirSync(this._previewDir)) {
        if (name === 'global.json' || /^worker-\d+\.json$/.test(name)) {
          try { fs.unlinkSync(path.join(this._previewDir, name)); } catch {}
        }
      }
    } catch (err) {
      this._warnWriteFailure(err);
    }

    // Write global config for HTML dashboard, plus a clean per-worker slate
    // (status 'waiting', done false) so the dashboard starts from zero.
    this._writeGlobalJSON();
    for (let i = 0; i < this.numWorkers; i++) {
      this._writeWorkerJSON(i);
    }

    // Terminal dashboard - tick once/sec: terminal redraw + fresh global.json
    if (this._terminalStream) {
      for (let i = 0; i < this.numWorkers + 1; i++) this._terminalStream.write('\n');
    }
    this._dashboardInterval = setInterval(() => {
      this._drawTerminal();
      this._writeGlobalJSON();
    }, 1000);
  }

  /**
   * Set the current pipeline phase.
   * @param {string} phase - Phase key (initializing, spawning, fast-forward,
   *   rendering, concatenating, grading, merging-audio, complete). The
   *   terminal 'error' phase is set via fail(), not here. The dashboard
   *   renders all of these; unknown phases degrade to detail text only.
   * @param {string} [detail] - Human-readable detail string
   */
  setPhase(phase, detail) {
    this.phase = phase;
    this.phaseDetail = detail || phase;
    this._writeGlobalJSON();
  }

  /**
   * Update a worker's progress.
   */
  updateWorker(workerId, data) {
    if (workerId < 0 || workerId >= this.numWorkers) return;
    const w = this.workers[workerId];
    w.pct = data.pct ?? w.pct;
    w.fps = data.fps ?? w.fps;
    w.frame = data.frame ?? w.frame;
    w.eta = data.eta ?? w.eta;
    w.status = data.status ?? w.status;
    w.done = data.done ?? w.done;

    this._writeWorkerJSON(workerId);
    this.emit('worker-progress', { workerId, ...w });
  }

  /**
   * Mark a worker as done.
   */
  workerDone(workerId) {
    this.updateWorker(workerId, { pct: 100, status: 'done', done: true, eta: 0 });
  }

  /**
   * Mark the render as failed (terminal). Stops the ticker and writes an
   * 'error' phase to global.json so the dashboard shows the failure instead
   * of freezing at the last good state. Call before stopping the dashboard
   * server so the page gets at least one poll of the error state.
   * @param {string|Error} [message] - Human-readable failure description
   */
  fail(message) {
    if (this._dashboardInterval) {
      clearInterval(this._dashboardInterval);
      this._dashboardInterval = null;
    }
    const msg = (message && message.message) ? message.message : String(message || 'Render failed');
    this.phase = 'error';
    this.phaseDetail = msg.slice(0, 300);
    this._writeGlobalJSON();
  }

  /**
   * Stop the tracker and write final state.
   */
  stop() {
    if (this._dashboardInterval) {
      clearInterval(this._dashboardInterval);
      this._dashboardInterval = null;
    }
    if (this._started) {
      this._drawTerminal();
      this._writeGlobalJSON();
    }
  }

  /**
   * Get summary stats.
   */
  getSummary() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const totalFps = this.workers.reduce((sum, w) => sum + (w.fps || 0), 0);
    const totalFramesRendered = this.workers.reduce((sum, w) => sum + (w.frame || 0), 0);
    const overallPct = this.totalFrames > 0 ? (totalFramesRendered / this.totalFrames * 100) : 0;
    const allDone = this.workers.every(w => w.done);
    const maxEta = Math.max(...this.workers.map(w => w.eta || 0));

    return { elapsed, totalFps, totalFramesRendered, overallPct, allDone, maxEta };
  }

  // --- Private ---

  _writeGlobalJSON() {
    if (!this._started) return;
    try {
      fs.writeFileSync(path.join(this._previewDir, 'global.json'), JSON.stringify({
        startTime: this.startTime,
        totalFrames: this.totalFrames,
        elapsed: (Date.now() - this.startTime) / 1000,
        resolution: this.resolution,
        title: this.title,
        numWorkers: this.numWorkers,
        phase: this.phase,
        phaseDetail: this.phaseDetail,
      }));
    } catch (err) {
      this._warnWriteFailure(err);
    }
  }

  _writeWorkerJSON(workerId) {
    if (!this._started) return;
    try {
      const w = this.workers[workerId];
      fs.writeFileSync(path.join(this._previewDir, `worker-${workerId}.json`), JSON.stringify({
        pct: w.pct, fps: w.fps, eta: w.eta, done: w.done,
        framesRendered: w.frame, status: w.status,
      }));
    } catch (err) {
      this._warnWriteFailure(err);
    }
  }

  _warnWriteFailure(err) {
    if (this._writeWarned) return;
    this._writeWarned = true;
    console.error(`  Warning: cannot write dashboard progress files (${err.message}); render continues, live dashboard may not update.`);
  }

  _drawTerminal() {
    if (!this._terminalStream) return;
    const s = this.getSummary();
    const lines = [];
    // Overall summary on the existing header line (same line count as
    // before, so the cursor-up redraw math is untouched).
    const etaStr = s.maxEta > 0 ? `${Math.round(s.maxEta)}s` : '--';
    lines.push(`\x1b[2K  [${s.elapsed.toFixed(0)}s elapsed] ${s.overallPct.toFixed(1)}% overall | ${s.totalFps.toFixed(1)} fps | ETA ${etaStr}`);

    // Note: global.json is written by the caller (setPhase / interval tick),
    // not here. Writing it in both places caused 2 disk writes per tick.

    for (let i = 0; i < this.numWorkers; i++) {
      const w = this.workers[i];
      const pctNum = w.pct || 0;
      const barLen = 20;
      const filled = Math.round(pctNum / 100 * barLen);
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barLen - filled);

      let statusStr;
      if (w.done) {
        statusStr = '\x1b[32mDONE\x1b[0m';
      } else if (w.status === 'fast-forward') {
        statusStr = '\x1b[33mFF\x1b[0m';
      } else if (w.status === 'waiting') {
        statusStr = '\x1b[90mWAITING\x1b[0m';
      } else {
        statusStr = `${pctNum.toFixed(1)}% | ${(w.fps || 0).toFixed(1)} fps | ETA ${Math.round(w.eta || 0)}s`;
      }

      lines.push(`\x1b[2K  W${i} [${bar}] ${statusStr}`);
    }

    this._terminalStream.write(`\x1b[${this.numWorkers + 1}A`);
    for (const line of lines) {
      this._terminalStream.write(line + '\n');
    }
  }
}

module.exports = { ProgressTracker };
