import type { WireRun } from "./schema.ts";
import { type FrameIndex, type SubjectId, type TemplateId, TemplateError, array, int, isRecord, record, slug, string } from "./template.ts";

export interface SourceFacts {
  readonly videoId: string;
  readonly url: string;
  readonly title: string;
  readonly channel: string;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
}

export interface Clip {
  readonly start: number;
  readonly end: number;
  readonly title: string;
  readonly credit: string;
  readonly license: string;
}

export type Step = "download" | "prepare";

export type Running =
  | { readonly kind: "downloading"; readonly source: SourceFacts }
  | { readonly kind: "preparing"; readonly source: SourceFacts; readonly clip: Clip };

export type JobState =
  | Running
  | { readonly kind: "downloaded"; readonly source: SourceFacts }
  | { readonly kind: "editing"; readonly source: SourceFacts; readonly clip: Clip }
  | { readonly kind: "ready"; readonly source: SourceFacts; readonly clip: Clip }
  | { readonly kind: "failed"; readonly step: Step; readonly message: string; readonly resume: Running };

export interface Progress {
  readonly status: "queued" | "running";
  readonly done: number;
  readonly total: number | null;
  readonly resumed: boolean;
}

export interface Job {
  readonly id: TemplateId;
  readonly url: string;
  readonly createdAt: string;
  readonly state: JobState;
  readonly progress: Progress | null;
}

export type Keyframe =
  | { readonly frame: FrameIndex; readonly point: readonly [number, number] }
  | { readonly frame: FrameIndex; readonly hidden: true };

export interface SubjectDoc {
  readonly id: SubjectId;
  readonly name: string;
  readonly color: string;
  readonly keyframes: readonly Keyframe[];
}

interface SegmentSpan {
  readonly key: string;
  readonly from: FrameIndex;
  readonly to: FrameIndex;
}

export type SegmentView = SegmentSpan &
  (
    | { readonly status: "done" | "queued" }
    | { readonly status: "running"; readonly done: number; readonly total: number | null }
    | { readonly status: "failed"; readonly message: string }
  );

export interface SubjectTrack {
  readonly runs: readonly WireRun[];
  readonly segments: readonly SegmentView[];
}

export interface AuthoringView {
  readonly rev: number;
  readonly title: string;
  readonly fps: number;
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
  readonly cuts: readonly number[];
  readonly subjects: readonly SubjectDoc[];
  readonly tracks: ReadonlyMap<SubjectId, SubjectTrack>;
}

export class ServerNotAnswering extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerNotAnswering";
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly field: string | null;
  constructor(status: number, message: string, field: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.field = field;
  }
}

function number(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new TemplateError(path, "expected a number");
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new TemplateError(path, "expected a boolean");
  return v;
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  const found = allowed.find((a) => a === v);
  if (found === undefined) throw new TemplateError(path, `expected one of ${allowed.join(", ")}, got ${JSON.stringify(v)}`);
  return found;
}

function parseSource(v: unknown, path: string): SourceFacts {
  const o = record(v, path);
  return {
    videoId: string(o.videoId, `${path}.videoId`),
    url: string(o.url, `${path}.url`),
    title: string(o.title, `${path}.title`),
    channel: string(o.channel, `${path}.channel`),
    duration: number(o.duration, `${path}.duration`),
    width: int(o.width, `${path}.width`, 0),
    height: int(o.height, `${path}.height`, 0),
  };
}

function parseClip(v: unknown, path: string): Clip {
  const o = record(v, path);
  return {
    start: number(o.start, `${path}.start`),
    end: number(o.end, `${path}.end`),
    title: string(o.title, `${path}.title`),
    credit: string(o.credit, `${path}.credit`),
    license: string(o.license, `${path}.license`),
  };
}

const RUNNING_KINDS = ["downloading", "preparing"] as const;
const KINDS = [...RUNNING_KINDS, "downloaded", "editing", "ready", "failed"] as const;

function parseRunning(v: unknown, path: string): Running {
  const o = record(v, path);
  const kind = oneOf(o.kind, `${path}.kind`, RUNNING_KINDS);
  const source = parseSource(o.source, `${path}.source`);
  if (kind === "downloading") return { kind, source };
  return { kind, source, clip: parseClip(o.clip, `${path}.clip`) };
}

function parseState(v: unknown, path: string): JobState {
  const o = record(v, path);
  const kind = oneOf(o.kind, `${path}.kind`, KINDS);
  switch (kind) {
    case "failed":
      return {
        kind,
        step: oneOf(o.step, `${path}.step`, ["download", "prepare"] as const),
        message: string(o.message, `${path}.message`),
        resume: parseRunning(o.resume, `${path}.resume`),
      };
    case "downloading":
    case "downloaded":
      return { kind, source: parseSource(o.source, `${path}.source`) };
    case "preparing":
    case "editing":
    case "ready":
      return { kind, source: parseSource(o.source, `${path}.source`), clip: parseClip(o.clip, `${path}.clip`) };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function parseProgress(v: unknown, path: string): Progress | null {
  if (v === null) return null;
  const o = record(v, path);
  return {
    status: oneOf(o.status, `${path}.status`, ["queued", "running"] as const),
    done: int(o.done, `${path}.done`, 0),
    total: o.total === null ? null : int(o.total, `${path}.total`, 0),
    resumed: bool(o.resumed, `${path}.resumed`),
  };
}

export function parseJob(json: unknown, path = "$"): Job {
  const o = record(json, path);
  return {
    id: slug(o.id, `${path}.id`) as TemplateId,
    url: string(o.url, `${path}.url`),
    createdAt: string(o.createdAt, `${path}.createdAt`),
    state: parseState(o.state, `${path}.state`),
    progress: parseProgress(o.progress, `${path}.progress`),
  };
}

function parseKeyframe(v: unknown, path: string): Keyframe {
  const o = record(v, path);
  const frame = int(o.frame, `${path}.frame`, 0) as FrameIndex;
  if (o.hidden === true) return { frame, hidden: true };
  const p = array(o.point, `${path}.point`);
  if (p.length !== 2) throw new TemplateError(`${path}.point`, "expected [x, y]");
  return { frame, point: [int(p[0], `${path}.point[0]`, 0), int(p[1], `${path}.point[1]`, 0)] };
}

function parseSubjectDoc(v: unknown, path: string): SubjectDoc {
  const o = record(v, path);
  return {
    id: slug(o.id, `${path}.id`) as SubjectId,
    name: string(o.name, `${path}.name`),
    color: string(o.color, `${path}.color`),
    keyframes: array(o.keyframes, `${path}.keyframes`).map((k, i) => parseKeyframe(k, `${path}.keyframes[${i}]`)),
  };
}

function parseSegment(v: unknown, path: string): SegmentView {
  const o = record(v, path);
  const span = { key: string(o.key, `${path}.key`), from: int(o.from, `${path}.from`, 0) as FrameIndex, to: int(o.to, `${path}.to`, 1) as FrameIndex };
  const status = oneOf(o.status, `${path}.status`, ["done", "queued", "running", "failed"] as const);
  switch (status) {
    case "done":
    case "queued":
      return { ...span, status };
    case "running":
      return { ...span, status, done: int(o.done, `${path}.done`, 0), total: o.total === null ? null : int(o.total, `${path}.total`, 1) };
    case "failed":
      return { ...span, status, message: string(o.message, `${path}.message`) };
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function parseRun(v: unknown, path: string): WireRun {
  const o = record(v, path);
  return {
    from: int(o.from, `${path}.from`, 0),
    boxes: array(o.boxes, `${path}.boxes`).map((b, i) => {
      const a = array(b, `${path}.boxes[${i}]`);
      if (a.length !== 4) throw new TemplateError(`${path}.boxes[${i}]`, "expected [x, y, w, h]");
      return [int(a[0], `${path}.boxes[${i}][0]`, 0), int(a[1], `${path}.boxes[${i}][1]`, 0), int(a[2], `${path}.boxes[${i}][2]`, 1), int(a[3], `${path}.boxes[${i}][3]`, 1)];
    }),
  };
}

export function parseAuthoring(json: unknown): AuthoringView {
  const o = record(json, "$");
  const tracks = record(o.tracks, "$.tracks");
  return {
    rev: int(o.rev, "$.rev", 0),
    title: string(o.title, "$.title"),
    fps: int(o.fps, "$.fps", 1),
    frameCount: int(o.frameCount, "$.frameCount", 1),
    width: int(o.width, "$.width", 1),
    height: int(o.height, "$.height", 1),
    cuts: array(o.cuts, "$.cuts").map((c, i) => int(c, `$.cuts[${i}]`, 1)),
    subjects: array(o.subjects, "$.subjects").map((s, i) => parseSubjectDoc(s, `$.subjects[${i}]`)),
    tracks: new Map(
      Object.entries(tracks).map(([id, t]): [SubjectId, SubjectTrack] => {
        const p = `$.tracks.${id}`;
        const r = record(t, p);
        return [
          id as SubjectId,
          {
            runs: array(r.runs, `${p}.runs`).map((run, i) => parseRun(run, `${p}.runs[${i}]`)),
            segments: array(r.segments, `${p}.segments`).map((seg, i) => parseSegment(seg, `${p}.segments[${i}]`)),
          },
        ];
      }),
    ),
  };
}

const PROXY_UPSTREAM_DOWN = new Set([502, 503, 504]);

async function request(method: string, url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((e: unknown) => {
    throw new ServerNotAnswering(`${method} ${url}: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (PROXY_UPSTREAM_DOWN.has(res.status)) throw new ServerNotAnswering(`${method} ${url} failed with HTTP ${res.status}`);
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const o = isRecord(json) ? json : {};
    const message = typeof o.error === "string" ? o.error : `${method} ${url} failed with HTTP ${res.status}`;
    throw new ApiError(res.status, message, typeof o.field === "string" ? o.field : null);
  }
  return json;
}

const jobUrl = (id: TemplateId, rest = "") => `/api/jobs/${id}${rest}`;

export const listJobs = async (): Promise<readonly Job[]> =>
  array(await request("GET", "/api/jobs"), "$").map((j, i) => parseJob(j, `$[${i}]`));
export const createJob = async (url: string, id: string | null): Promise<Job> =>
  parseJob(await request("POST", "/api/jobs", id === null ? { url } : { url, id }));
export const getJob = async (id: TemplateId): Promise<Job> => parseJob(await request("GET", jobUrl(id)));
export const chooseClip = async (id: TemplateId, clip: Clip): Promise<Job> =>
  parseJob(await request("PUT", jobUrl(id, "/clip"), clip));
export const getAuthoring = async (id: TemplateId): Promise<AuthoringView> => parseAuthoring(await request("GET", jobUrl(id, "/authoring")));
export const putAuthoring = async (id: TemplateId, title: string, subjects: readonly SubjectDoc[]): Promise<AuthoringView> =>
  parseAuthoring(await request("PUT", jobUrl(id, "/authoring"), { title, subjects }));
export const clipUrl = (id: TemplateId): string => jobUrl(id, "/clip.mp4");
export const save = async (id: TemplateId): Promise<Job> => parseJob(await request("POST", jobUrl(id, "/save")));
export const retry = async (id: TemplateId): Promise<Job> => parseJob(await request("POST", jobUrl(id, "/retry")));
export const sourceUrl = (id: TemplateId): string => jobUrl(id, "/source.mp4");
