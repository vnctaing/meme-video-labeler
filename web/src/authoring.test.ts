import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, ServerNotAnswering, getJob, parseJob } from "./authoring.ts";
import { TemplateError, type TemplateId } from "./template.ts";

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
