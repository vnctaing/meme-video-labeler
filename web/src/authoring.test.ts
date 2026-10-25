import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, ServerNotAnswering, defaultCredit, getJob, listJobs, openTemplateEdit, parseDraftView, parseJob, putDraft, shortNameToId, uploadJob, uploadProblem } from "./authoring.ts";
import { importDraft } from "./subjects.ts";
import { TemplateError, type TemplateId, parseTemplate } from "./template.ts";

const SOURCE = {
  videoId: "R6MlUcmOul8",
  url: "https://www.youtube.com/watch?v=R6MlUcmOul8",
  title: "Tears of Steel - Blender VFX Open Movie",
  channel: "Blender",
  duration: 734.0,
  width: 1280,
  height: 534,
};
const CLIP = {
  start: 225.1,
  end: 240.1,
  title: "Tears of Steel: the lab",
  credit: "Tears of Steel - Blender VFX Open Movie, Blender, YouTube",
  license: "unknown, personal use",
};
const failedJob = () => ({
  id: "tos-curl",
  url: SOURCE.url,
  createdAt: "2026-10-20T00:52:44.112667+00:00",
  state: { kind: "failed", step: "prepare", message: "start_time 0.041, expected 0", resume: { kind: "preparing", source: SOURCE, clip: CLIP } },
  progress: null,
});

describe("parseJob", () => {
  test("parses a failed job with its resume state as the server sends it", () => {
    const job = parseJob(failedJob());
    expect(job.state).toEqual({ kind: "failed", step: "prepare", message: "start_time 0.041, expected 0", resume: { kind: "preparing", source: SOURCE, clip: CLIP } });
  });

  test("parses a running job with progress", () => {
    const job = parseJob({ ...failedJob(), state: { kind: "downloading", source: SOURCE }, progress: { status: "running", done: 10, total: null, resumed: true } });
    expect(job.progress).toEqual({ status: "running", done: 10, total: null, resumed: true });
  });

  test.each([
    [(j: ReturnType<typeof failedJob>) => ({ ...j, state: { ...j.state, resume: { kind: "editing", source: SOURCE, clip: CLIP } } }), "$.state.resume.kind"],
    [(j: ReturnType<typeof failedJob>) => ({ ...j, state: { kind: "preparing", source: SOURCE } }), "$.state.clip"],
    [(j: ReturnType<typeof failedJob>) => ({ ...j, state: { kind: "downloaded", source: { ...SOURCE, duration: "734" } } }), "$.state.source.duration"],
    [(j: ReturnType<typeof failedJob>) => ({ ...j, progress: { status: "paused", done: 0, total: null, resumed: false } }), "$.progress.status"],
    [(j: ReturnType<typeof failedJob>) => ({ ...j, id: "Not A Slug" }), "$.id"],
  ])("rejects a malformed response at %#", (mutate, path) => {
    expect(() => parseJob(mutate(failedJob()))).toThrow(TemplateError);
    try {
      parseJob(mutate(failedJob()));
    } catch (e) {
      expect(e instanceof TemplateError && e.path).toBe(path);
    }
  });
});

describe("getJob when the request fails", () => {
  const LAB = "tos-lab" as TemplateId;
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, body: string) => vi.stubGlobal("fetch", async () => new Response(body, { status }));

  test.each([502, 503, 504])("HTTP %i from the dev proxy means the server is not answering", async (status) => {
    respond(status, "");
    await expect(getJob(LAB)).rejects.toBeInstanceOf(ServerNotAnswering);
  });

  test("a refused connection means the server is not answering", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(getJob(LAB)).rejects.toBeInstanceOf(ServerNotAnswering);
  });

  test.each([404, 500])("HTTP %i from the server is an API error with its message", async (status) => {
    respond(status, JSON.stringify({ error: "no job named 'tos-lab'", field: null }));
    const failure = getJob(LAB);
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.not.toBeInstanceOf(ServerNotAnswering);
    await expect(failure).rejects.toThrow("no job named 'tos-lab'");
  });
});

describe("shortNameToId", () => {
  test("turns a typed name into a slug", () => {
    expect(shortNameToId("Kakashi vs Obito")).toBe("kakashi-vs-obito");
    expect(shortNameToId("  Pokémon: Ash & Pikachu!! ")).toBe("pokemon-ash-pikachu");
    expect(shortNameToId("already-a-slug")).toBe("already-a-slug");
  });

  test("is empty when nothing usable was typed", () => {
    expect(shortNameToId(" !? ")).toBe("");
  });

  test("stays within 40 characters without a trailing dash", () => {
    const id = shortNameToId("a".repeat(39) + " bcd");
    expect(id).toBe("a".repeat(39));
  });
});

describe("draft cells", () => {
  const clip = { width: 640, height: 360, fps: 24, frameCount: 3, cuts: [] };
  const view = (cell: unknown) => ({
    clip,
    draft: { version: 1, title: "T", tuning: { lagMs: 150, smoothRadius: 4 }, subjects: [{ id: "s1", name: "A", color: "#f5a524", track: [null, "hidden", cell] }] },
  });
  const cellOf = (cell: unknown) => parseDraftView(view(cell)).draft.doc.subjects[0].track[2];
  const failurePath = (cell: unknown) => {
    try {
      parseDraftView(view(cell));
    } catch (e) {
      if (e instanceof TemplateError) return e.path;
      throw e;
    }
    return null;
  };

  test("a box cell is an imported frame and keeps its box as written", () => {
    expect(cellOf({ box: [0, 10, 640, 350] })).toEqual({ box: [0, 10, 640, 350] });
    expect(cellOf([10.5, 20, 30.2, 0.5])).toEqual([10.5, 20, 30.2, 0.5]);
  });

  test.each([
    [{ box: [1.5, 0, 10, 10] }, "$.draft.subjects[0].track[2].box[0]"],
    [{ box: [0, 0, 0, 10] }, "$.draft.subjects[0].track[2].box[2]"],
    [{ box: [600, 0, 41, 10] }, "$.draft.subjects[0].track[2].box"],
    [{ box: [0, 0, 10, 10], rate: 1 }, "$.draft.subjects[0].track[2].rate"],
    [{}, "$.draft.subjects[0].track[2].box"],
    [[0, 0, 10, 10], "$.draft.subjects[0].track[2][3]"],
  ])("rejects %j at its path", (cell, path) => {
    expect(failurePath(cell)).toBe(path);
  });
});

describe("putDraft of an imported template", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("tos-lab's import stays small enough to be written while the page closes", async () => {
    const json = JSON.parse(readFileSync(new URL("../public/templates/tos-lab/template.json", import.meta.url), "utf8"));
    const sent: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(init);
      return new Response(null, { status: 204 });
    });
    await putDraft("tos-lab" as TemplateId, importDraft(parseTemplate(json, "http://x/")));
    expect(new TextEncoder().encode(String(sent[0].body)).length).toBeLessThan(32_768);
    expect(sent[0].keepalive).toBe(true);
  });
});

describe("openTemplateEdit", () => {
  afterEach(() => vi.unstubAllGlobals());
  const BASE = "http://x/";
  const ID = "fixture" as TemplateId;
  const templateJson = JSON.parse(readFileSync(new URL("../public/templates/fixture/template.json", import.meta.url), "utf8"));
  const clip = { width: 640, height: 360, fps: 24, frameCount: 48, cuts: [24] };
  const unsaved = { version: 1, title: "Unsaved title", tuning: { lagMs: 0, smoothRadius: 0 }, subjects: [{ id: "s1", name: "Carol", color: "#4c8dff", track: Array(48).fill(null) }] };

  const serve = (draft: unknown) => {
    const sent: { method: string; url: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      sent.push({ method, url });
      if (url === `${BASE}templates/fixture/template.json`) return Response.json(templateJson);
      if (method === "GET" && url === "/api/templates/fixture/draft") return Response.json({ draft, clip });
      if (method === "PUT" && url === "/api/templates/fixture/draft") return new Response(null, { status: 204 });
      if (method === "POST" && url === "/api/templates/fixture/save") return Response.json({ id: "fixture" });
      return Response.json({ error: `unexpected ${method} ${url}` }, { status: 404 });
    });
    return sent;
  };

  test("opens a template with no draft filled with its own subjects", async () => {
    serve(null);
    const opened = await openTemplateEdit(ID, BASE);
    expect(opened.draft.doc.subjects.map((s) => s.name)).toEqual(["Alice", "Bob"]);
    expect(opened.draft).toEqual(importDraft(parseTemplate(templateJson, BASE)));
  });

  test("reopens the unsaved draft instead of the template", async () => {
    serve(unsaved);
    const opened = await openTemplateEdit(ID, BASE);
    expect(opened.draft.doc.title).toBe("Unsaved title");
    expect(opened.draft.doc.subjects.map((s) => s.name)).toEqual(["Carol"]);
  });

  test("its session plays the template's video and writes the draft and the save to the template", async () => {
    const sent = serve(null);
    const { draft, session } = await openTemplateEdit(ID, BASE);
    expect(session.videoUrl).toBe(`${BASE}templates/fixture/video.mp4`);
    sent.length = 0;
    await session.putDraft(draft);
    await session.save({ title: "Fixture", subjects: [] });
    expect(sent).toEqual([
      { method: "PUT", url: "/api/templates/fixture/draft" },
      { method: "POST", url: "/api/templates/fixture/save" },
    ]);
  });
});

const UPLOADED = {
  videoId: "upload-3f2a9c0d1e4b5a67",
  url: "upload:Robot dance.mov",
  title: "Robot dance",
  channel: "uploaded file",
  duration: 92.4,
  width: 1920,
  height: 1080,
};

describe("defaultCredit", () => {
  test("an uploaded file is not credited to YouTube", () => {
    expect(defaultCredit(UPLOADED)).toBe("Robot dance, uploaded file");
  });

  test("a YouTube video keeps its YouTube credit", () => {
    expect(defaultCredit(SOURCE)).toBe("Tears of Steel - Blender VFX Open Movie, Blender, YouTube");
  });
});

describe("uploadProblem", () => {
  const MB = 1024 * 1024;
  test("a file at the cap is fine", () => {
    expect(uploadProblem(200 * MB, 200 * MB)).toBeNull();
  });

  test("a file one byte over the cap names both sizes", () => {
    expect(uploadProblem(200 * MB + 1, 200 * MB)).toBe("This file is 200.0 MB, and the limit is 200 MB. Choose a shorter or smaller video.");
  });

  test("an empty file is refused", () => {
    expect(uploadProblem(0, 200 * MB)).toBe("This file is empty.");
  });
});

class FakeXhr {
  static last: FakeXhr | null = null;
  static reply: { status: number; body: string } | "network error" = { status: 201, body: "" };
  method = "";
  url = "";
  body: unknown = null;
  status = 0;
  responseText = "";
  readonly upload: { onprogress: ((ev: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: unknown) {
    this.body = body;
    this.upload.onprogress?.({ loaded: 5, total: 10, lengthComputable: true });
    const reply = FakeXhr.reply;
    queueMicrotask(() => {
      if (reply === "network error") return this.onerror?.();
      this.status = reply.status;
      this.responseText = reply.body;
      this.onload?.();
    });
  }
}

describe("uploadJob", () => {
  const file = new File([new Uint8Array(10)], "Robot dance.mov", { type: "video/quicktime" });
  const uploadedJob = { id: "robot-dance", url: UPLOADED.url, createdAt: "2026-10-24T00:00:00+00:00", state: { kind: "downloaded", source: UPLOADED }, progress: null };
  const location = { hash: "#/new" };
  afterEach(() => {
    vi.unstubAllGlobals();
    location.hash = "#/new";
  });
  const stub = (reply: typeof FakeXhr.reply) => {
    FakeXhr.reply = reply;
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("location", location);
  };

  test("posts the raw file with its name and the short name, reports progress, and returns the downloaded job", async () => {
    stub({ status: 201, body: JSON.stringify(uploadedJob) });
    const progress: number[] = [];
    const job = await uploadJob(file, "robot-dance", (fraction) => progress.push(fraction));
    expect([FakeXhr.last?.method, FakeXhr.last?.url, FakeXhr.last?.body]).toEqual(["POST", "/api/uploads?name=Robot+dance.mov&id=robot-dance", file]);
    expect(progress).toEqual([0.5]);
    expect(job.state).toEqual({ kind: "downloaded", source: UPLOADED });
  });

  test("leaves the id out when no short name was typed", async () => {
    stub({ status: 201, body: JSON.stringify(uploadedJob) });
    await uploadJob(file, null);
    expect(FakeXhr.last?.url).toBe("/api/uploads?name=Robot+dance.mov");
  });

  test("a server refusal is an API error naming the field", async () => {
    stub({ status: 422, body: JSON.stringify({ error: "This file is not a video ffmpeg can read.", field: "file" }) });
    const failure = uploadJob(file, null);
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 422, field: "file", message: "This file is not a video ffmpeg can read." });
  });

  test("a dropped connection means the server is not answering", async () => {
    stub("network error");
    await expect(uploadJob(file, null)).rejects.toBeInstanceOf(ServerNotAnswering);
  });

  test("an expired sign-in sends the author to the login form, which returns to the page", async () => {
    stub({ status: 401, body: JSON.stringify({ error: "sign in first", field: null }) });
    await expect(uploadJob(file, null)).rejects.toBeInstanceOf(ApiError);
    expect(location.hash).toBe("#/login?next=%23%2Fnew");
  });

  test("any other API call with an expired sign-in also sends the author to the login form", async () => {
    location.hash = "#/new/robot-dance";
    stub({ status: 201, body: "" });
    vi.stubGlobal("fetch", async () => Response.json({ error: "sign in first", field: null }, { status: 401 }));
    await expect(listJobs()).rejects.toBeInstanceOf(ApiError);
    expect(location.hash).toBe("#/login?next=%23%2Fnew%2Frobot-dance");
  });
});
