import { FONT_PER_BOX_WIDTH, MAX_FONT_PER_HEIGHT, MIN_FONT_PER_HEIGHT } from "./labels.ts";
import type { WireBox, WireRun } from "./schema.ts";

export const HIDDEN = "hidden";
export const RATES = [0.25, 0.5, 1] as const;
export type Rate = (typeof RATES)[number];
export type Sample = readonly [x: number, y: number, size: number, rate: Rate];
export interface Imported {
  readonly box: WireBox;
}
export type Placed = Sample | Imported;
export type Cell = Placed | typeof HIDDEN | null;
export type Track = readonly Cell[];

export interface Clip {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frameCount: number;
  readonly cuts: readonly number[];
}

export interface Shot {
  readonly from: number;
  readonly to: number;
}

export interface Tuning {
  readonly lagMs: number;
  readonly smoothRadius: number;
}

export const DEFAULT_TUNING: Tuning = { lagMs: 150, smoothRadius: 4 };
export const BRIDGE_FRAMES = 2;
export const SIZE_STEP = 1.08;
export const DEFAULT_SIZE_PER_HEIGHT = 0.06;

export const isSample = (c: Cell): c is Sample => Array.isArray(c);
export const isImported = (c: Cell): c is Imported => typeof c === "object" && c !== null && !Array.isArray(c);
export const isPlaced = (c: Cell): c is Placed => isSample(c) || isImported(c);

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function shotsOf(clip: Clip): readonly Shot[] {
  const bounds = [0, ...clip.cuts, clip.frameCount];
  return bounds.slice(1).map((to, i) => ({ from: bounds[i], to }));
}

export function shotOf(clip: Clip, frame: number): Shot {
  const from = clip.cuts.filter((c) => c <= frame).at(-1) ?? 0;
  return { from, to: clip.cuts.find((c) => c > frame) ?? clip.frameCount };
}

export function lagFrames(lagMs: number, fps: number, rate: Rate): number {
  return Math.round((lagMs / 1000) * fps * rate);
}

export function sizeRange(height: number): { readonly min: number; readonly max: number } {
  return { min: MIN_FONT_PER_HEIGHT * height, max: MAX_FONT_PER_HEIGHT * height };
}
function shiftsOf(track: Track, { from, to }: Shot, lagMs: number, fps: number): number[] {
  const shifts: (number | null)[] = Array(to - from).fill(null);
  let next: number | null = null;
  for (let g = to - 1; g >= from; g--) {
    const cell = track[g];
    if (isSample(cell)) next = lagFrames(lagMs, fps, cell[3]);
    shifts[g - from] = next;
  }
  let previous = 0;
  return shifts.map((k) => (k === null ? previous : (previous = k)));
}
export function compensateLag(track: Track, shots: readonly Shot[], { lagMs, fps }: { lagMs: number; fps: number }): Track {
  const out = track.slice();
  for (const shot of shots) {
    const shifts = shiftsOf(track, shot, lagMs, fps);
    const landsBefore = (g: number, f: number) => g - shifts[g - shot.from] < f;
    for (let f = shot.from, source = shot.from; f < shot.to; f++) {
      source = Math.max(source, f);
      while (source < shot.to && landsBefore(source, f)) source++;
      out[f] = track[Math.min(source, shot.to - 1)];
    }
  }
  return out;
}

export function smooth(track: Track, shots: readonly Shot[], radius: number): Track {
  const out = track.slice();
  for (const { from, to } of shots) {
    let a = from;
    while (a < to) {
      let b = a;
      while (b < to && isSample(track[b])) b++;
      const stretch = track.slice(a, b).filter(isSample);
      stretch.forEach((sample, i) => {
        const r = Math.min(radius, i, stretch.length - 1 - i);
        const window = stretch.slice(i - r, i + r + 1);
        const mean = (k: 0 | 1 | 2) => window.reduce((sum, c) => sum + c[k], 0) / window.length;
        out[a + i] = [mean(0), mean(1), mean(2), sample[3]];
      });
      a = b + 1;
    }
  }
  return out;
}

export function bridge(track: Track, shots: readonly Shot[], maxGap: number): Track {
  const out = track.slice();
  for (const { from, to } of shots) {
    let last: { readonly frame: number; readonly sample: Sample } | null = null;
    for (let f = from; f < to; f++) {
      const cell = track[f];
      if (cell === HIDDEN) last = null;
      if (!isSample(cell)) continue;
      const n = last === null ? 0 : f - last.frame;
      if (last !== null && n > 1 && n - 1 <= maxGap) {
        const a = last.sample;
        for (let i = 1; i < n; i++) {
          const lerp = (p: number, q: number) => p + ((q - p) * i) / n;
          out[last.frame + i] = [lerp(a[0], cell[0]), lerp(a[1], cell[1]), lerp(a[2], cell[2]), a[3]];
        }
      }
      last = { frame: f, sample: cell };
    }
  }
  return out;
}

export function drawnSpans(track: Track, shots: readonly Shot[]): readonly Shot[] {
  const spans: Shot[] = [];
  for (const { from, to } of shots) {
    let start = from;
    for (let f = from; f <= to; f++) {
      if (f < to && !isImported(track[f])) continue;
      if (f > start) spans.push({ from: start, to: f });
      start = f + 1;
    }
  }
  return spans;
}

export function processTrack(track: Track, clip: Clip, tuning: Tuning): Track {
  const spans = drawnSpans(track, shotsOf(clip));
  const shifted = compensateLag(track, spans, { lagMs: tuning.lagMs, fps: clip.fps });
  return bridge(smooth(shifted, spans, tuning.smoothRadius), spans, BRIDGE_FRAMES);
}

export function anchorOf(cell: Placed, { height }: Clip): readonly [x: number, y: number, size: number] {
  if (isSample(cell)) return [cell[0], cell[1], cell[2]];
  const [x, y, w] = cell.box;
  const { min, max } = sizeRange(height);
  return [x + w / 2, y, clamp(FONT_PER_BOX_WIDTH * w, min, max)];
}

export function toWireBox([px, py, size]: Sample, { width: W, height: H }: Clip): WireBox {
  const { min, max } = sizeRange(H);
  const font = clamp(size, min, max);
  const w = clamp(Math.round(font / FONT_PER_BOX_WIDTH), 1, W);
  const x = clamp(Math.round(px - w / 2), 0, W - w);
  const y = clamp(Math.round(py), 0, H - 1);
  return [x, y, w, 1];
}

export function toRuns(processed: Track, clip: Clip): WireRun[] {
  const runs: WireRun[] = [];
  for (const { from, to } of shotsOf(clip)) {
    let run: WireRun | null = null;
    for (let f = from; f < to; f++) {
      const cell = processed[f];
      if (!isPlaced(cell)) {
        run = null;
        continue;
      }
      if (run === null) {
        run = { from: f, boxes: [] };
        runs.push(run);
      }
      run.boxes.push(isSample(cell) ? toWireBox(cell, clip) : [...cell.box]);
    }
  }
  return runs;
}
