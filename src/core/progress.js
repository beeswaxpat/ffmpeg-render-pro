/**
 * Progress Tracker — Per-worker progress collection and reporting
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

    this.workers = new Array(this.numWorkers).fill(null).map(() => ({
      pct: 0, fps: 0, frame: 0, eta: 0, status: 'waiting', done: false,
    }));

    // Pipeline phase tracking
    this.phase = 'initializing';
    this.phaseDetail = 'Starting up...';

    this._dashboardInterval = null;
    this._previewDir = path.join(this.outputDir, 'preview');
  }

  /**
   * Start the progress tracker (terminal + JSON output).
   */
  start() {
    if (!fs.existsSync(this._previewDir)) {
      fs.mkdirSync(this._previewDir, { recursive: true });
    }

    // Write global config for HTML dashboard
    this._writeGlobalJSON();

    // Terminal dashboard — tick once/sec: terminal redraw + fresh global.json
    for (let i = 0; i < this.numWorkers + 1; i++) process.stdout.write('\n');
    this._dashboardInterval = setInterval(() => {
      this._drawTerminal();
      this._writeGlobalJSON();
    }, 1000);
  }

  /**
   * Set the current pipeline phase.
   * @param {string} phase - Phase key (initializing, fast-forward, rendering, concatenating, grading, merging-audio, complete)
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
   * Stop the tracker and write final state.
   */
  stop() {
    if (this._dashboardInterval) {
      clearInterval(this._dashboardInterval);
      this._dashboardInterval = null;
    }
    this._drawTerminal();
    this._writeGlobalJSON();
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
    } catch {}
  }

  _writeWorkerJSON(workerId) {
    try {
      const w = this.workers[workerId];
      fs.writeFileSync(path.join(this._previewDir, `worker-${workerId}.json`), JSON.stringify({
        pct: w.pct, fps: w.fps, eta: w.eta, done: w.done,
        framesRendered: w.frame, status: w.status,
      }));
    } catch {}
  }

  _drawTerminal() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
    const lines = [];
    lines.push(`\x1b[2K  [${elapsed}s elapsed]`);

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

    process.stdout.write(`\x1b[${this.numWorkers + 1}A`);
    for (const line of lines) {
      process.stdout.write(line + '\n');
    }
  }
}

module.exports = { ProgressTracker };
