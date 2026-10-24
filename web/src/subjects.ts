import type { WireRun } from "./schema.ts";
import type { FrameIndex, Labels, SubjectId, Template, TemplateId } from "./template.ts";
import {
  type Cell,
  type Clip,
  DEFAULT_SIZE_PER_HEIGHT,
  DEFAULT_TUNING,
  HIDDEN,
  type Rate,
  SIZE_STEP,
  type Sample,
  type Track,
  type Tuning,
  anchorOf,
  isPlaced,
  isSample,
  processTrack,
  shotOf,
  sizeRange,
  toRuns,
} from "./track.ts";

export const COLORS = ["#f5a524", "#4c8dff", "#3ecf8e", "#e054d8", "#ff6a3d", "#20c4c4", "#a77bff", "#c9a36b"] as const;

export interface SubjectDraft {
  readonly id: SubjectId;
  readonly name: string;
  readonly color: string;
  readonly track: Track;
}

export interface Doc {
  readonly title: string;
  readonly subjects: readonly SubjectDraft[];
}

export interface Draft {
  readonly doc: Doc;
  readonly tuning: Tuning;
}

type Drawn = Sample | typeof HIDDEN;

export interface Stroke {
  readonly subject: SubjectId;
  readonly rate: Rate;
  readonly size: number;
  readonly last: FrameIndex;
  readonly cells: ReadonlyMap<FrameIndex, Drawn>;
}

type Coalesce = { readonly kind: "rename"; readonly id: SubjectId } | { readonly kind: "retitle" };

export interface EditorState {
  readonly doc: Doc;
  readonly tuning: Tuning;
  readonly past: readonly Doc[];
  readonly future: readonly Doc[];
  readonly lastEdit: Coalesce | null;
  readonly selected: SubjectId | null;
  readonly frame: FrameIndex;
  readonly stroke: Stroke | null;
  readonly strokeFrom: FrameIndex | null;
  readonly brush: ReadonlyMap<SubjectId, number>;
}

export const HISTORY_LIMIT = 100;

export function editorState({ doc, tuning }: Draft): EditorState {
  return {
    doc,
    tuning,
    past: [],
    future: [],
    lastEdit: null,
    selected: null,
    frame: 0 as FrameIndex,
    stroke: null,
    strokeFrom: null,
    brush: new Map(),
  };
}

type Point = readonly [x: number, y: number];

export type Action =
  | { readonly kind: "strokeBegin"; readonly at: Point; readonly erase: boolean; readonly rate: Rate }
  | { readonly kind: "strokeSample"; readonly frame: number; readonly at: Point; readonly erase: boolean }
  | { readonly kind: "strokeEnd" }
  | { readonly kind: "resize"; readonly steps: number }
  | { readonly kind: "tune"; readonly tuning: Partial<Tuning> }
  | { readonly kind: "clearSubject"; readonly id: SubjectId }
  | { readonly kind: "addSubject" }
  | { readonly kind: "deleteSubject"; readonly id: SubjectId }
  | { readonly kind: "rename"; readonly id: SubjectId; readonly name: string }
  | { readonly kind: "retitle"; readonly title: string }
  | { readonly kind: "select"; readonly id: SubjectId }
  | { readonly kind: "seek"; readonly frame: number }
  | { readonly kind: "step"; readonly delta: -1 | 1 }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" };

export function newSubject(existing: readonly SubjectDraft[], frameCount: number): SubjectDraft {
  const ids = new Set(existing.map((s) => s.id));
  let n = 1;
  while (ids.has(`s${n}` as SubjectId)) n++;
  const used = new Set(existing.map((s) => s.color));
  const color = COLORS.find((c) => !used.has(c)) ?? COLORS[existing.length % COLORS.length];
  return { id: `s${n}` as SubjectId, name: `Subject ${n}`, color, track: Array<Cell>(frameCount).fill(null) };
}

export function importDraft(t: Template): Draft {
  const subjects = t.subjects.map((x, i): SubjectDraft => {
    const track = Array<Cell>(t.frameCount).fill(null);
    for (const run of x.runs) run.boxes.forEach(({ x: bx, y, w, h }, j) => (track[run.from + j] = { box: [bx, y, w, h] }));
    return { id: x.id, name: x.name, color: COLORS[i % COLORS.length], track };
  });
  return { doc: { title: t.title, subjects }, tuning: DEFAULT_TUNING };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const tenth = (v: number) => Math.round(v * 10) / 10;
const clampFrame = (frame: number, frameCount: number) => clamp(Math.round(frame), 0, frameCount - 1) as FrameIndex;

const sameEdit = (a: Coalesce | null, b: Coalesce | null) =>
  a !== null && b !== null && a.kind === b.kind && (a.kind === "retitle" || (b.kind === "rename" && a.id === b.id));

function commit(s: EditorState, doc: Doc, edit: Coalesce | null = null): EditorState {
  if (doc === s.doc) return s;
  if (sameEdit(s.lastEdit, edit)) return { ...s, doc, future: [], lastEdit: edit };
  return { ...s, doc, past: [...s.past, s.doc].slice(-HISTORY_LIMIT), future: [], lastEdit: edit };
}

function travel(s: EditorState, doc: Doc, past: readonly Doc[], future: readonly Doc[]): EditorState {
  const changed = doc.subjects.find((x) => !s.doc.subjects.includes(x));
  const selected = changed?.id ?? (doc.subjects.some((x) => x.id === s.selected) ? s.selected : (doc.subjects.at(-1)?.id ?? null));
  return { ...s, doc, past, future, lastEdit: null, selected };
}

function editSubject(s: EditorState, id: SubjectId, edit: (x: SubjectDraft) => SubjectDraft): EditorState {
  let changed = false;
  const subjects = s.doc.subjects.map((x) => {
    if (x.id !== id) return x;
    const next = edit(x);
    changed ||= next !== x;
    return next;
  });
  return changed ? commit(s, { ...s.doc, subjects }) : s;
}

export function brushSize(s: EditorState, id: SubjectId, clip: Clip): number {
  const { min, max } = sizeRange(clip.height);
  const set = s.brush.get(id);
  if (set !== undefined) return clamp(set, min, max);
  const track = s.doc.subjects.find((x) => x.id === id)?.track ?? [];
  const { from, to } = shotOf(clip, s.frame);
  for (let d = 0; s.frame - d >= from || s.frame + d < to; d++) {
    for (const f of [s.frame - d, s.frame + d]) {
      const cell = f >= from && f < to ? track[f] : null;
      if (isPlaced(cell)) return clamp(anchorOf(cell, clip)[2], min, max);
    }
  }
  return clamp(DEFAULT_SIZE_PER_HEIGHT * clip.height, min, max);
}

function drawn(at: Point, erase: boolean, stroke: Pick<Stroke, "rate" | "size">, clip: Clip): Drawn {
  if (erase) return HIDDEN;
  return [tenth(clamp(at[0], 0, clip.width)), tenth(clamp(at[1], 0, clip.height)), tenth(stroke.size), stroke.rate];
}

const sameCell = (a: Cell, b: Cell) => a === b || (isSample(a) && isSample(b) && a.every((v, i) => v === b[i]));

function endStroke(s: EditorState, stroke: Stroke): EditorState {
  const ended = { ...s, stroke: null };
  return editSubject(ended, stroke.subject, (x) => {
    if (![...stroke.cells].some(([f, cell]) => !sameCell(x.track[f], cell))) return x;
    const track = x.track.slice();
    for (const [f, cell] of stroke.cells) track[f] = cell;
    return { ...x, track };
  });
}

export function liveTrack(s: EditorState, subject: SubjectDraft): Track {
  if (s.stroke === null || s.stroke.subject !== subject.id) return subject.track;
  const track = subject.track.slice();
  for (const [f, cell] of s.stroke.cells) track[f] = cell;
  return track;
}

export function reduce(s: EditorState, a: Action, clip: Clip): EditorState {
  switch (a.kind) {
    case "strokeBegin": {
      if (s.selected === null || s.stroke !== null) return s;
      const stroke = { subject: s.selected, rate: a.rate, size: brushSize(s, s.selected, clip) };
      return { ...s, strokeFrom: s.frame, stroke: { ...stroke, last: s.frame, cells: new Map([[s.frame, drawn(a.at, a.erase, stroke, clip)]]) } };
    }
    case "strokeSample": {
      const stroke = s.stroke;
      if (stroke === null) return s;
      const frame = clampFrame(a.frame, clip.frameCount);
      const cells = new Map(stroke.cells);
      const cell = drawn(a.at, a.erase, stroke, clip);
      const from = frame <= stroke.last ? frame : Math.max(stroke.last + 1, shotOf(clip, frame).from);
      for (let f = from; f <= frame; f++) cells.set(f as FrameIndex, cell);
      return { ...s, frame, stroke: { ...stroke, cells, last: frame > stroke.last ? frame : stroke.last } };
    }
    case "strokeEnd":
      return s.stroke === null ? s : endStroke(s, s.stroke);
    case "resize": {
      if (s.selected === null) return s;
      const { min, max } = sizeRange(clip.height);
      const current = s.stroke?.size ?? brushSize(s, s.selected, clip);
      const size = clamp(current * SIZE_STEP ** a.steps, min, max);
      const brush = new Map(s.brush).set(s.selected, size);
      return { ...s, brush, stroke: s.stroke === null ? null : { ...s.stroke, size } };
    }
    case "tune":
      return { ...s, tuning: { ...s.tuning, ...a.tuning } };
    case "clearSubject":
      if (s.stroke !== null) return s;
      return editSubject(s, a.id, (x) => (x.track.every((c) => c === null) ? x : { ...x, track: Array<Cell>(clip.frameCount).fill(null) }));
    case "seek":
      return { ...s, frame: clampFrame(a.frame, clip.frameCount) };
    case "step":
      return { ...s, frame: clampFrame(s.frame + a.delta, clip.frameCount) };
    case "select":
      return s.stroke === null && s.doc.subjects.some((x) => x.id === a.id) ? { ...s, selected: a.id } : s;
    case "rename":
      return commit(s, { ...s.doc, subjects: s.doc.subjects.map((x) => (x.id === a.id ? { ...x, name: a.name } : x)) }, { kind: "rename", id: a.id });
    case "addSubject": {
      if (s.stroke !== null) return s;
      const added = newSubject(s.doc.subjects, clip.frameCount);
      return { ...commit(s, { ...s.doc, subjects: [...s.doc.subjects, added] }), selected: added.id };
    }
    case "deleteSubject": {
      const index = s.doc.subjects.findIndex((x) => x.id === a.id);
      if (index === -1 || s.stroke !== null) return s;
      const subjects = s.doc.subjects.filter((x) => x.id !== a.id);
      const selected = s.selected === a.id ? (subjects[Math.min(index, subjects.length - 1)]?.id ?? null) : s.selected;
      return { ...commit(s, { ...s.doc, subjects }), selected };
    }
    case "retitle":
      return commit(s, { ...s.doc, title: a.title }, { kind: "retitle" });
    case "undo": {
      const doc = s.past.at(-1);
      return doc === undefined || s.stroke !== null ? s : travel(s, doc, s.past.slice(0, -1), [s.doc, ...s.future]);
    }
    case "redo": {
      const [doc, ...future] = s.future;
      return doc === undefined || s.stroke !== null ? s : travel(s, doc, [...s.past, s.doc], future);
    }
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

export function processed(s: EditorState, subject: SubjectDraft, clip: Clip): Track {
  return processTrack(liveTrack(s, subject), clip, s.tuning);
}

export function runsOf(s: EditorState, clip: Clip): ReadonlyMap<SubjectId, WireRun[]> {
  return new Map(s.doc.subjects.map((x) => [x.id, toRuns(processed(s, x, clip), clip)]));
}

export function toTemplate(runs: ReadonlyMap<SubjectId, readonly WireRun[]>, s: EditorState, clip: Clip, id: TemplateId, videoUrl: string): Template {
  const recording = s.stroke?.subject ?? null;
  return {
    id,
    title: s.doc.title,
    credit: "",
    width: clip.width,
    height: clip.height,
    fps: clip.fps,
    frameCount: clip.frameCount,
    cuts: new Set(clip.cuts),
    subjects: s.doc.subjects
      .filter((x) => x.id !== recording)
      .map((x) => ({
        id: x.id,
        name: x.name,
        runs: (runs.get(x.id) ?? []).map((r) => ({ from: r.from as FrameIndex, boxes: r.boxes.map(([bx, by, w, h]) => ({ x: bx, y: by, w, h })) })),
      })),
    videoUrl,
  };
}

export function labelsOf(doc: Doc): Labels {
  return new Map(doc.subjects.map((s) => [s.id, s.name]));
}

export interface SaveBody {
  readonly title: string;
  readonly subjects: readonly { readonly id: SubjectId; readonly name: string; readonly runs: readonly WireRun[] }[];
}

export function saveBody(s: EditorState, runs: ReadonlyMap<SubjectId, readonly WireRun[]>): SaveBody {
  return {
    title: s.doc.title,
    subjects: s.doc.subjects.flatMap((x) => {
      const r = runs.get(x.id) ?? [];
      return r.length === 0 ? [] : [{ id: x.id, name: x.name, runs: r }];
    }),
  };
}

export function saveBlocker(s: EditorState, runs: ReadonlyMap<SubjectId, readonly WireRun[]>): string | null {
  if (s.stroke !== null) return "Release to finish drawing first";
  const { subjects } = saveBody(s, runs);
  if (subjects.length === 0) return "Draw at least one subject first";
  if (subjects.some((x) => x.name.trim() === "")) return "Every drawn subject needs a name";
  if (s.doc.title.trim() === "") return "Give the template a title first";
  return null;
}

export type Mode =
  | { readonly kind: "empty" }
  | { readonly kind: "pick" }
  | { readonly kind: "follow"; readonly subject: SubjectDraft }
  | { readonly kind: "paused"; readonly subject: SubjectDraft }
  | { readonly kind: "recording"; readonly subject: SubjectDraft; readonly erasing: boolean }
  | { readonly kind: "playing" };

export function modeOf(s: EditorState, clip: Clip, ui: { readonly playing: boolean; readonly erasing: boolean }): Mode {
  if (ui.playing && s.stroke === null) return { kind: "playing" };
  if (s.doc.subjects.length === 0) return { kind: "empty" };
  const subject = s.doc.subjects.find((x) => x.id === s.selected);
  if (subject === undefined) return { kind: "pick" };
  if (s.stroke !== null) return { kind: "recording", subject, erasing: ui.erasing };
  const { from, to } = shotOf(clip, s.frame);
  return processed(s, subject, clip).slice(from, to).some(isPlaced) ? { kind: "paused", subject } : { kind: "follow", subject };
}
