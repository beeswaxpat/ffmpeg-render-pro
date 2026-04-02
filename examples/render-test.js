/**
 * render-test.js — Quick benchmark render to test the full pipeline
 *
 * Renders a short procedural video using the basic-worker, with the
 * live dashboard, parallel workers, and stream-copy concat.
 *
 * Usage:
 *   node examples/render-test.js                    # 5s benchmark at 1080p 30fps
 *   node examples/render-test.js --duration=10      # 10s render
 *   node examples/render-test.js --width=1080 --height=1920 --fps=30  # Shorts format
 *   node examples/render-test.js --workers=4        # Override worker count
 */
const path = require('path');
const { renderParallel } = require('../src/core/parallel-renderer');
const { detectGPU } = require('../src/core/gpu-detect');
const { getOptimalWorkers } = require('../src/core/config');

// Parse CLI flags
const flags = {};
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    flags[key] = val !== undefined ? val : true;
  }
}

const width = parseInt(flags.width) || 1920;
const height = parseInt(flags.height) || 1080;
const fps = parseInt(flags.fps) || 30;
const duration = parseInt(flags.duration) || 5;
const workerCount = flags.workers ? parseInt(flags.workers) : undefined;
const outputPath = path.resolve(flags.output || 'benchmark-output.mp4');

async function main() {
  // Show system info
  const gpu = detectGPU({ verbose: true });
  const auto = getOptimalWorkers({ width, height });

  console.log('');
  console.log('  ffmpeg-render-pro — Benchmark Test');
  console.log('  ==================================');
  console.log(`  GPU:       ${gpu.label} (${gpu.isGpu ? 'hardware' : 'software'})`);
  console.log(`  Workers:   ${workerCount || auto.workers} (auto: ${auto.workers})`);
  console.log(`  Video:     ${width}x${height} @ ${fps}fps, ${duration}s`);
  console.log(`  Frames:    ${(fps * duration).toLocaleString()}`);
  console.log(`  Output:    ${outputPath}`);
  console.log('');

  const result = await renderParallel({
    workerScript: path.join(__dirname, 'basic-worker.js'),
    outputPath,
    width,
    height,
    fps,
    duration,
    workerCount,
    seed: 42,
    title: 'Benchmark Test',
    autoOpen: true,
  });

  const avgFps = (result.totalFrames / result.elapsed).toFixed(1);
  console.log('');
  console.log('  === BENCHMARK RESULTS ===');
  console.log(`  Total frames:  ${result.totalFrames.toLocaleString()}`);
  console.log(`  Render time:   ${result.elapsed.toFixed(1)}s`);
  console.log(`  Average FPS:   ${avgFps}`);
  console.log(`  Output file:   ${result.outputPath}`);
  console.log('');
}

main().catch(err => {
  console.error('Benchmark failed:', err.message);
  process.exit(1);
});
