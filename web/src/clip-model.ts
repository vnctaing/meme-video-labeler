export const MAX_CLIP_SECONDS = 30;
export const MIN_CLIP_SECONDS = 1;
export const MIN_VIEW_SECONDS = 5;
export const STEP_SECONDS = 0.1;
const DEFAULT_CLIP_SECONDS = 10;
const WHOLE_VIDEO_LIMIT_SECONDS = 120;
const WIRE_EPSILON = 1e-9;

export interface Range {
  readonly start: number;
  readonly end: number;
}

export interface View {
  readonly from: number;
  readonly to: number;
}

export type Pulled = "start" | "end" | null;

export interface Pull {
  readonly range: Range;
  readonly pulled: Pulled;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const snap = (x: number) => Math.round(x * 10) / 10;
// Times are multiples of 0.1 s, so the last fraction of a tenth of the source cannot be reached.
const usable = (duration: number) => Math.floor(duration * 10 + 1e-9) / 10;
const snapUnder = (x: number, duration: number) => Math.min(duration, snap(x));

const minLength = (duration: number) => Math.min(MIN_CLIP_SECONDS, duration);
export const maxLength = (duration: number) => Math.min(MAX_CLIP_SECONDS, duration);

export function initialRange(duration: number, current: Range | null): Range {
  return current ?? { start: 0, end: Math.min(DEFAULT_CLIP_SECONDS, duration) };
}

export function dragStart(r: Range, t: number, total: number): Range {
  const duration = usable(total);
  return { start: clamp(snap(t), Math.max(0, snap(r.end - maxLength(duration))), r.end - minLength(duration)), end: r.end };
}

export function dragEnd(r: Range, t: number, total: number): Range {
  const duration = usable(total);
  return { start: r.start, end: clamp(snap(t), r.start + minLength(duration), Math.min(duration, snap(r.start + maxLength(duration)))) };
}

export function moveWindow(r: Range, start: number, total: number): Range {
  const duration = usable(total);
  const length = r.end - r.start;
  const s = clamp(snap(start), 0, Math.max(0, duration - length));
  return { start: s, end: Math.min(duration, snap(s + length)) };
}

export function setIn(r: Range, t: number, total: number): Pull {
  const duration = usable(total);
  const min = minLength(duration);
  const length = Math.max(min, r.end - r.start);
  const start = clamp(snap(t), 0, duration - min);
  let end = r.end;
  if (end - start < min) end = snapUnder(start + length, duration);
  if (end - start > maxLength(duration)) return { range: { start, end: snapUnder(start + maxLength(duration), duration) }, pulled: "end" };
  return { range: { start, end }, pulled: null };
}

export function setOut(r: Range, t: number, total: number): Pull {
  const duration = usable(total);
  const min = minLength(duration);
  const length = Math.max(min, r.end - r.start);
  const end = clamp(snap(t), min, duration);
  let start = r.start;
  if (end - start < min) start = Math.max(0, snap(end - length));
  if (end - start > maxLength(duration)) return { range: { start: Math.max(0, snap(end - maxLength(duration))), end }, pulled: "start" };
  return { range: { start, end }, pulled: null };
}

export const isAtMax = (r: Range, total: number) => r.end - r.start >= maxLength(usable(total)) - WIRE_EPSILON;

// The server compares end - start to 1 and 30 with plain floats, and a pair like 0.1 and 30.1 differs by 30.000000000000004.
export function toWire(r: Range): Range {
  let { start, end } = r;
  if (end - start > MAX_CLIP_SECONDS) end -= WIRE_EPSILON;
  if (end - start < MIN_CLIP_SECONDS) start -= WIRE_EPSILON;
  return { start, end };
}

export function formatTime(t: number): string {
  const tenths = Math.round(Math.max(0, t) * 10);
  const minutes = Math.floor(tenths / 600);
  return `${minutes}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
}

export function parseTime(text: string): number | null {
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(text.trim());
  return m === null ? null : Number(m[1] ?? 0) * 60 + Number(m[2]);
}

export function setView(from: number, to: number, duration: number): View {
  const span = clamp(to - from, Math.min(MIN_VIEW_SECONDS, duration), duration);
  const a = clamp((from + to) / 2 - span / 2, 0, duration - span);
  return { from: a, to: a + span };
}

export const wholeView = (duration: number): View => ({ from: 0, to: duration });

export function fitView(r: Range, duration: number): View {
  const span = Math.max((r.end - r.start) * 3, 12);
  const mid = (r.start + r.end) / 2;
  return setView(mid - span / 2, mid + span / 2, duration);
}

export const initialView = (r: Range, duration: number): View =>
  duration > WHOLE_VIDEO_LIMIT_SECONDS ? fitView(r, duration) : wholeView(duration);

export function zoomView(v: View, factor: number, around: number, duration: number): View {
  const span = (v.to - v.from) * factor;
  const k = (around - v.from) / (v.to - v.from);
  return setView(around - k * span, around + (1 - k) * span, duration);
}

export function panView(v: View, delta: number, duration: number): View {
  return setView(v.from + delta, v.to + delta, duration);
}

export function revealInView(v: View, t: number, duration: number): View {
  if (t < v.from) return panView(v, t - v.from, duration);
  if (t > v.to) return panView(v, t - v.to, duration);
  return v;
}

export const isZoomed = (v: View, duration: number) => v.to - v.from < duration - 0.01;
export const canZoomIn = (v: View, duration: number) => v.to - v.from > Math.min(MIN_VIEW_SECONDS, duration) + 1e-6;

export function isFitView(v: View, r: Range, duration: number): boolean {
  const fit = fitView(r, duration);
  return Math.abs(v.from - fit.from) < 0.01 && Math.abs(v.to - fit.to) < 0.01;
}
