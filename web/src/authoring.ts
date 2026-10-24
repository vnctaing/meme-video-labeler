import { type Draft, type SaveBody, type SubjectDraft, importDraft } from "./subjects.ts";
import { type SubjectId, type Template, type TemplateId, TemplateError, array, int, isRecord, loadTemplate, parseBox, record, slug, string } from "./template.ts";
import { type Cell, type Clip as ClipFacts, HIDDEN, type Rate } from "./track.ts";

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

const RATES: readonly Rate[] = [0.25, 0.5, 1];

function parseCell(v: unknown, path: string, clip: ClipFacts): Cell {
  if (v === null || v === HIDDEN) return v;
  if (isRecord(v)) {
    const extra = Object.keys(v).find((k) => k !== "box");
    if (extra !== undefined) throw new TemplateError(`${path}.${extra}`, "expected only a box");
    const { x, y, w, h } = parseBox(v.box, `${path}.box`, clip.width, clip.height);
    return { box: [x, y, w, h] };
  }
  const a = array(v, path);
  if (a.length !== 4) throw new TemplateError(path, "expected null, \"hidden\", [x, y, size, rate] or {\"box\": [x, y, w, h]}");
  const rate = RATES.find((r) => r === a[3]);
  if (rate === undefined) throw new TemplateError(`${path}[3]`, `expected a rate in ${RATES.join(", ")}`);
  return [number(a[0], `${path}[0]`), number(a[1], `${path}[1]`), number(a[2], `${path}[2]`), rate];
}

function parseSubjectDraft(v: unknown, path: string, clip: ClipFacts): SubjectDraft {
  const o = record(v, path);
  const track = array(o.track, `${path}.track`).map((c, f) => parseCell(c, `${path}.track[${f}]`, clip));
  if (track.length !== clip.frameCount) throw new TemplateError(`${path}.track`, `expected ${clip.frameCount} cells, got ${track.length}`);
  return { id: slug(o.id, `${path}.id`) as SubjectId, name: string(o.name, `${path}.name`), color: string(o.color, `${path}.color`), track };
}

function parseClipFacts(v: unknown, path: string): ClipFacts {
  const o = record(v, path);
  return {
    width: int(o.width, `${path}.width`, 1),
    height: int(o.height, `${path}.height`, 1),
    fps: int(o.fps, `${path}.fps`, 1),
    frameCount: int(o.frameCount, `${path}.frameCount`, 1),
    cuts: array(o.cuts, `${path}.cuts`).map((c, i) => int(c, `${path}.cuts[${i}]`, 1)),
  };
}

function parseDraft(v: unknown, clip: ClipFacts): Draft {
  const d = record(v, "$.draft");
  const t = record(d.tuning, "$.draft.tuning");
  return {
    doc: { title: string(d.title, "$.draft.title"), subjects: array(d.subjects, "$.draft.subjects").map((s, i) => parseSubjectDraft(s, `$.draft.subjects[${i}]`, clip)) },
    tuning: { lagMs: int(t.lagMs, "$.draft.tuning.lagMs", 0), smoothRadius: int(t.smoothRadius, "$.draft.tuning.smoothRadius", 0) },
  };
}

export function parseDraftView(json: unknown): { readonly draft: Draft; readonly clip: ClipFacts } {
  const o = record(json, "$");
  const clip = parseClipFacts(o.clip, "$.clip");
  return { clip, draft: parseDraft(o.draft, clip) };
}

export function parseTemplateDraftView(json: unknown): { readonly draft: Draft | null; readonly clip: ClipFacts } {
  const o = record(json, "$");
  const clip = parseClipFacts(o.clip, "$.clip");
  return { clip, draft: o.draft === null ? null : parseDraft(o.draft, clip) };
}

const draftJson = ({ doc, tuning }: Draft) => ({ version: 1, title: doc.title, tuning, subjects: doc.subjects });

const PROXY_UPSTREAM_DOWN = new Set([502, 503, 504]);

// Fetch fails a keepalive request once in-flight keepalive bodies sum past 64 KiB; a page-hide write can overlap one autosave.
const KEEPALIVE_MAX_BYTES = 32 * 1024;

async function request(method: string, url: string, body?: unknown, outliveThePage = false): Promise<unknown> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, {
    method,
    headers: text === undefined ? {} : { "content-type": "application/json" },
    body: text,
    keepalive: outliveThePage && text !== undefined && new TextEncoder().encode(text).length <= KEEPALIVE_MAX_BYTES,
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
const MAX_ID_LENGTH = 40;

export function shortNameToId(name: string): string {
  const words = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.join("-").slice(0, MAX_ID_LENGTH).replace(/-+$/, "");
}

export const createJob = async (url: string, id: string | null): Promise<Job> =>
  parseJob(await request("POST", "/api/jobs", id === null ? { url } : { url, id }));
export const getJob = async (id: TemplateId): Promise<Job> => parseJob(await request("GET", jobUrl(id)));
export const chooseClip = async (id: TemplateId, clip: Clip): Promise<Job> =>
  parseJob(await request("PUT", jobUrl(id, "/clip"), clip));
export const getDraft = async (id: TemplateId) => parseDraftView(await request("GET", jobUrl(id, "/draft")));
export const putDraft = async (id: TemplateId, draft: Draft): Promise<void> => {
  await request("PUT", jobUrl(id, "/draft"), draftJson(draft), true);
};
const clipUrl = (id: TemplateId): string => jobUrl(id, "/clip.mp4");
export const retry = async (id: TemplateId): Promise<Job> => parseJob(await request("POST", jobUrl(id, "/retry")));
export const sourceUrl = (id: TemplateId): string => jobUrl(id, "/source.mp4");

export interface EditSession {
  readonly id: TemplateId;
  readonly videoUrl: string;
  readonly backHref: string;
  putDraft(draft: Draft): Promise<void>;
  save(body: SaveBody): Promise<void>;
}

export const jobSession = (id: TemplateId): EditSession => ({
  id,
  videoUrl: clipUrl(id),
  backHref: "#/new",
  putDraft: (draft) => putDraft(id, draft),
  save: async (body) => {
    parseJob(await request("POST", jobUrl(id, "/save"), body));
  },
});

const templateUrl = (id: TemplateId, rest: string) => `/api/templates/${id}${rest}`;

export const templateSession = (id: TemplateId, videoUrl: string): EditSession => ({
  id,
  videoUrl,
  backHref: "#/",
  putDraft: async (draft) => {
    await request("PUT", templateUrl(id, "/draft"), draftJson(draft), true);
  },
  save: async (body) => {
    await request("POST", templateUrl(id, "/save"), body);
  },
});

export interface OpenedEdit {
  readonly draft: Draft;
  readonly clip: ClipFacts;
  readonly template: Template;
}

export async function openTemplateEdit(id: TemplateId, baseUrl: string): Promise<OpenedEdit> {
  const [template, view] = await Promise.all([loadTemplate(id, baseUrl), request("GET", templateUrl(id, "/draft")).then(parseTemplateDraftView)]);
  return { template, clip: view.clip, draft: view.draft ?? importDraft(template) };
}
