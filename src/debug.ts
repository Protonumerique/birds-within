import type { StreamStats } from './sky-stream';

const WINDOW = 180; // frames, ~3 s at 60 fps

/**
 * `?debug`: rolling frame-time percentiles and what the sky worker is doing.
 *
 * Exists because smoothness is the thing Step 2 is for, and it cannot be judged by
 * eye or from a hidden browser pane. Not part of the piece.
 */
export function createDebugPanel(parent: HTMLElement, catalog: string) {
  const el = document.createElement('div');
  el.id = 'debug';
  parent.append(el);

  const samples = new Float32Array(WINDOW);
  let head = 0;
  let filled = 0;
  let lastPaint = 0;

  return {
    frame(dtMs: number, stats: Readonly<StreamStats>) {
      samples[head] = dtMs;
      head = (head + 1) % WINDOW;
      filled = Math.min(filled + 1, WINDOW);

      const now = performance.now();
      if (now - lastPaint < 250) return;
      lastPaint = now;

      const sorted = Array.from(samples.subarray(0, filled)).sort((a, b) => a - b);
      const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
      const slow = sorted.filter((d) => d > 25).length;

      el.textContent =
        // Which sky this is and how old its elements are. It used to sit in the panel
        // and is internal: see the note in ui.ts.
        `${catalog}\n` +
        `frame  p50 ${pct(0.5).toFixed(1)} ms   p95 ${pct(0.95).toFixed(1)} ms   ${slow}/${filled} over 25 ms\n` +
        `tick   ${stats.computeMs.toFixed(1)} ms in worker   ${stats.hz} Hz   ${stats.stepSeconds.toFixed(1)} s scene per tick\n` +
        `queue  ${stats.queued} ready   ${stats.inflight} in flight`;
    },
  };
}
