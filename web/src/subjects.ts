import type { AuthoringView, Keyframe, SegmentView, SubjectDoc } from "./authoring.ts";
import { type FrameIndex, type Labels, type SubjectId, type Template, type TemplateId, placementAt } from "./template.ts";

export const COLORS = ["#f5a524", "#4c8dff", "#3ecf8e", "#e054d8", "#ff6a3d", "#20c4c4", "#a77bff", "#c9a36b"] as const;

export interface Doc {
  readonly title: string;
  readonly subjects: readonly SubjectDoc[];
}

export interface EditorState {
  readonly doc: Doc;
  readonly past: readonly Doc[];
  readonly future: readonly Doc[];
  readonly lastEdit: Coalesce | null;
  readonly selected: SubjectId | null;
  readonly frame: FrameIndex;
}

type Coalesce = { readonly kind: "rename"; readonly id: SubjectId } | { readonly kind: "retitle" };

export const HISTORY_LIMIT = 100;

export function editorState(doc: Doc): EditorState {
  return { doc, past: [], future: [], lastEdit: null, selected: doc.subjects[0]?.id ?? null, frame: 0 as FrameIndex };
}

export type Action =
  | { readonly kind: "place"; readonly point: readonly [number, number] }
  | { readonly kind: "hide" }
  | { readonly kind: "removeKey" }
  | { readonly kind: "seek"; readonly frame: number }
  | { readonly kind: "step"; readonly delta: -1 | 1 }
  | { readonly kind: "select"; readonly id: SubjectId }
  | { readonly kind: "rename"; readonly id: SubjectId; readonly name: string }
  | { readonly kind: "addSubject" }
  | { readonly kind: "deleteSubject"; readonly id: SubjectId }
  | { readonly kind: "retitle"; readonly title: string }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" };

export function setKeyframe(keys: readonly Keyframe[], k: Keyframe): readonly Keyframe[] {
  return [...keys.filter((x) => x.frame !== k.frame), k].sort((a, b) => a.frame - b.frame);
}

export function removeKeyframe(keys: readonly Keyframe[], frame: FrameIndex): readonly Keyframe[] {
  return keys.filter((k) => k.frame !== frame);
}

export function newSubject(existing: readonly SubjectDoc[]): SubjectDoc {
  const ids = new Set(existing.map((s) => s.id));
  let n = 1;
  while (ids.has(`s${n}` as SubjectId)) n++;
  return { id: `s${n}` as SubjectId, name: `Subject ${n}`, color: COLORS[(n - 1) % COLORS.length], keyframes: [] };
}

const clampFrame = (frame: number, frameCount: number) => Math.min(Math.max(Math.round(frame), 0), frameCount - 1) as FrameIndex;

const sameEdit = (a: Coalesce | null, b: Coalesce | null) =>
  a !== null && b !== null && a.kind === b.kind && (a.kind === "retitle" || (b.kind === "rename" && a.id === b.id));

function commit(s: EditorState, doc: Doc, edit: Coalesce | null = null): EditorState {
  if (doc === s.doc) return s;
  if (sameEdit(s.lastEdit, edit)) return { ...s, doc, future: [], lastEdit: edit };
  return { ...s, doc, past: [...s.past, s.doc].slice(-HISTORY_LIMIT), future: [], lastEdit: edit };
}

function editSelected(s: EditorState, edit: (keys: readonly Keyframe[]) => readonly Keyframe[]): EditorState {
  if (s.selected === null) return s;
  const subjects = s.doc.subjects.map((x) => (x.id === s.selected ? { ...x, keyframes: edit(x.keyframes) } : x));
  return commit(s, { ...s.doc, subjects });
}

function travel(s: EditorState, doc: Doc, past: readonly Doc[], future: readonly Doc[]): EditorState {
  const changed = doc.subjects.find((x) => !s.doc.subjects.includes(x));
  const selected = changed?.id ?? (doc.subjects.some((x) => x.id === s.selected) ? s.selected : (doc.subjects.at(-1)?.id ?? null));
  return { ...s, doc, past, future, lastEdit: null, selected };
}

export const keyframeAt = (subject: SubjectDoc, frame: FrameIndex): Keyframe | undefined => subject.keyframes.find((k) => k.frame === frame);

export function reduce(s: EditorState, a: Action, frameCount: number): EditorState {
  switch (a.kind) {
    case "place":
      return editSelected(s, (keys) => setKeyframe(keys, { frame: s.frame, point: [Math.round(a.point[0]), Math.round(a.point[1])] }));
    case "hide":
      return editSelected(s, (keys) => setKeyframe(keys, { frame: s.frame, hidden: true }));
    case "removeKey":
      if (!s.doc.subjects.some((x) => x.id === s.selected && keyframeAt(x, s.frame) !== undefined)) return s;
      return editSelected(s, (keys) => removeKeyframe(keys, s.frame));
    case "seek":
      return { ...s, frame: clampFrame(a.frame, frameCount) };
    case "step":
      return { ...s, frame: clampFrame(s.frame + a.delta, frameCount) };
    case "select":
      return s.doc.subjects.some((x) => x.id === a.id) ? { ...s, selected: a.id } : s;
    case "rename":
      return commit(s, { ...s.doc, subjects: s.doc.subjects.map((x) => (x.id === a.id ? { ...x, name: a.name } : x)) }, { kind: "rename", id: a.id });
    case "addSubject": {
      const added = newSubject(s.doc.subjects);
      return { ...commit(s, { ...s.doc, subjects: [...s.doc.subjects, added] }), selected: added.id };
    }
    case "deleteSubject": {
      const index = s.doc.subjects.findIndex((x) => x.id === a.id);
      if (index === -1) return s;
      const subjects = s.doc.subjects.filter((x) => x.id !== a.id);
      const selected = s.selected === a.id ? (subjects[Math.min(index, subjects.length - 1)]?.id ?? null) : s.selected;
      return { ...commit(s, { ...s.doc, subjects }), selected };
    }
    case "retitle":
      return commit(s, { ...s.doc, title: a.title }, { kind: "retitle" });
    case "undo": {
      const doc = s.past.at(-1);
      return doc === undefined ? s : travel(s, doc, s.past.slice(0, -1), [s.doc, ...s.future]);
    }
    case "redo": {
      const [doc, ...future] = s.future;
      return doc === undefined ? s : travel(s, doc, [...s.past, s.doc], future);
    }
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

export function toTemplate(view: AuthoringView, doc: Doc, id: TemplateId, videoUrl: string): Template {
  return {
    id,
    title: doc.title,
    credit: "",
    width: view.width,
    height: view.height,
    fps: view.fps,
    frameCount: view.frameCount,
    cuts: new Set(view.cuts),
    subjects: doc.subjects.map((s) => ({
      id: s.id,
      name: s.name,
      runs: (view.tracks.get(s.id)?.runs ?? []).map((r) => ({ from: r.from as FrameIndex, boxes: r.boxes.map(([x, y, w, h]) => ({ x, y, w, h })) })),
    })),
    videoUrl,
  };
}

export function labelsOf(doc: Doc): Labels {
  return new Map(doc.subjects.map((s) => [s.id, s.name]));
}

export function shotAt(cuts: readonly number[], frameCount: number, frame: number): readonly [number, number] {
  const start = [0, ...cuts].filter((c) => c <= frame).at(-1) ?? 0;
  const end = cuts.find((c) => c > frame) ?? frameCount;
  return [start, end];
}

type Polyline = readonly (readonly [number, number])[];

export function pathLines(t: Template, id: SubjectId, frame: FrameIndex): readonly Polyline[] {
  const subject = t.subjects.find((s) => s.id === id);
  if (subject === undefined) return [];
  const [start, end] = shotAt([...t.cuts].sort((a, b) => a - b), t.frameCount, frame);
  const lines: [number, number][][] = [];
  let current: [number, number][] | null = null;
  for (let f = start; f < end; f++) {
    const p = placementAt(subject, f as FrameIndex, t);
    if (p === null) {
      current = null;
      continue;
    }
    if (current === null) {
      current = [];
      lines.push(current);
    }
    current.push([p.box.x + p.box.w / 2, p.box.y + p.box.h / 2]);
  }
  return lines;
}

export type Mode =
  | { readonly kind: "empty" }
  | { readonly kind: "placing"; readonly subject: SubjectDoc }
  | { readonly kind: "tracking"; readonly subject: SubjectDoc; readonly percent: number }
  | { readonly kind: "idle"; readonly subject: SubjectDoc };

const pending = (g: SegmentView) => g.status === "queued" || g.status === "running";

function trackedPercent(segments: readonly SegmentView[]): number {
  let total = 0;
  let done = 0;
  for (const g of segments) {
    const span = g.to - g.from;
    total += span;
    if (g.status === "done") done += span;
    else if (g.status === "running" && g.total !== null && g.total > 0) done += (span * g.done) / g.total;
  }
  return total === 0 ? 0 : Math.floor((100 * done) / total);
}

export function modeOf(s: EditorState, view: AuthoringView): Mode {
  const subject = s.doc.subjects.find((x) => x.id === s.selected) ?? s.doc.subjects[0];
  if (subject === undefined) return { kind: "empty" };
  const [start, end] = shotAt(view.cuts, view.frameCount, s.frame);
  if (!subject.keyframes.some((k) => "point" in k && k.frame >= start && k.frame < end)) return { kind: "placing", subject };
  const segmentsOf = (x: SubjectDoc) => view.tracks.get(x.id)?.segments ?? [];
  const busy =
    s.doc.subjects.find((x) => segmentsOf(x).some((g) => g.status === "running")) ?? s.doc.subjects.find((x) => segmentsOf(x).some(pending));
  if (busy !== undefined) return { kind: "tracking", subject: busy, percent: trackedPercent(segmentsOf(busy)) };
  return { kind: "idle", subject };
}
