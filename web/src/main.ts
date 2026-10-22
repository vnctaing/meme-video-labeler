import "./style.css";
import { type View, el } from "./dom.ts";
import type { ExportSupport } from "./export.ts";
import { loadLabelFont } from "./labels.ts";
import { mountPreview } from "./preview.ts";
import { type IndexEntry, type SubjectId, type TemplateId, loadIndex, loadTemplate } from "./template.ts";

type Route = { kind: "gallery" } | { kind: "editor"; id: string } | { kind: "new" } | { kind: "job"; id: TemplateId };

const AUTHORING = import.meta.env.VITE_AUTHOR === "1";

type ExportState =
  | { kind: "idle" }
  | { kind: "running"; fraction: number }
  | { kind: "done"; url: string; filename: string }
  | { kind: "failed"; message: string };

type SupportState = { kind: "checking" } | ({ kind: "checked" } & ExportSupport);

const BASE_URL = new URL(import.meta.env.BASE_URL, location.href).href;

function parseRoute(hash: string): Route {
  const m = /^#\/t\/([a-z0-9-]+)$/.exec(hash);
  if (m !== null) return { kind: "editor", id: m[1] };
  if (!AUTHORING) return { kind: "gallery" };
  if (hash === "#/new") return { kind: "new" };
  const job = /^#\/new\/([a-z0-9-]+)$/.exec(hash);
  return job === null ? { kind: "gallery" } : { kind: "job", id: job[1] as TemplateId };
}

async function routeView(route: Route): Promise<View> {
  switch (route.kind) {
    case "gallery":
      return galleryView();
    case "editor":
      return editorView(route.id);
    case "new":
      return AUTHORING ? (await import("./author.ts")).newView() : galleryView();
    case "job":
      return AUTHORING ? (await import("./author.ts")).jobView(route.id) : galleryView();
    default: {
      const _exhaustive: never = route;
      return _exhaustive;
    }
  }
}

function formatDuration(frameCount: number, fps: number): string {
  return `${(frameCount / fps).toFixed(1)} s`;
}

function subjectCount(n: number): string {
  return `${n} ${n === 1 ? "subject" : "subjects"}`;
}

function galleryCard(t: IndexEntry): HTMLElement {
  return el(
    "a",
    { className: "card", href: `#/t/${t.id}` },
    el("img", { src: t.thumbUrl, alt: "", width: t.width, height: t.height, loading: "lazy" }),
    el("h2", {}, t.title),
    el("p", { className: "credit" }, t.credit),
    el("p", { className: "meta" }, `${formatDuration(t.frameCount, t.fps)} · ${subjectCount(t.subjectCount)}`),
  );
}

async function galleryView(): Promise<View> {
  const templates = await loadIndex(BASE_URL);
  return {
    nodes: [
      el("header", {}, el("h1", {}, "labelmeme"), el("p", { className: "tagline" }, "Pick a clip, name the things in it, download the meme.")),
      el(
        "main",
        { className: "gallery" },
        ...(AUTHORING ? [el("a", { className: "card new-card", href: "#/new" }, el("h2", {}, "+ New template"), el("p", { className: "meta" }, "From a YouTube link"))] : []),
        ...templates.map(galleryCard),
      ),
    ],
    teardown: () => {},
  };
}

function errorView(e: unknown): View {
  return {
    nodes: [el("main", { className: "error" }, el("p", {}, e instanceof Error ? e.message : String(e)), el("a", { href: "#/" }, "Back to all clips"))],
    teardown: () => {},
  };
}

async function editorView(id: string): Promise<View> {
  const [template] = await Promise.all([loadTemplate(id, BASE_URL), loadLabelFont(BASE_URL)]);
  const labels = new Map<SubjectId, string>();
  const abort = new AbortController();
  let exportState: ExportState = { kind: "idle" };
  let support: SupportState = { kind: "checking" };

  const previewBox = el("div", { className: "preview" });
  const preview = mountPreview(previewBox, template, labels);

  const inputs = template.subjects.map((s) => {
    const input = el("input", { id: `label-${s.id}`, type: "text", placeholder: s.name, autocomplete: "off", maxLength: 60 });
    input.addEventListener("input", () => {
      labels.set(s.id, input.value);
      preview.setLabels(new Map(labels));
    });
    return el("div", { className: "field" }, el("label", { htmlFor: input.id }, s.name), input);
  });

  const downloadButton = el("button", { type: "button", className: "download" }, "Download MP4");
  const progress = el("progress", { max: 1, value: 0 });
  const status = el("p", { className: "status", role: "status" });

  const renderExport = () => {
    const running = exportState.kind === "running";
    downloadButton.disabled = running || support.kind === "checking" || !support.ok;
    progress.hidden = !running;
    if (exportState.kind === "running") progress.value = exportState.fraction;
    status.textContent = statusText(exportState, support);
  };

  const setExportState = (next: ExportState) => {
    if (exportState.kind === "done") URL.revokeObjectURL(exportState.url);
    exportState = next;
    renderExport();
  };

  downloadButton.addEventListener("click", async () => {
    setExportState({ kind: "running", fraction: 0 });
    try {
      const { exportMp4 } = await import("./export.ts");
      const blob = await exportMp4(
        template,
        new Map(labels),
        (fraction) => {
          if (exportState.kind === "running") setExportState({ kind: "running", fraction });
        },
        abort.signal,
      );
      if (abort.signal.aborted) return;
      const filename = `labelmeme-${template.id}.mp4`;
      const url = URL.createObjectURL(blob);
      setExportState({ kind: "done", url, filename });
      el("a", { href: url, download: filename }).click();
    } catch (e) {
      if (!abort.signal.aborted) setExportState({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  });

  const nodes = [
    el("header", {}, el("a", { className: "back", href: "#/" }, "← All clips"), el("h1", {}, template.title), el("p", { className: "credit" }, template.credit)),
    el(
      "main",
      { className: "editor" },
      previewBox,
      el("section", { className: "labels" }, ...inputs),
      el("section", { className: "export" }, downloadButton, progress, status),
    ),
  ];
  renderExport();

  void import("./export.ts")
    .then(({ canExportHere }) => canExportHere(template))
    .catch((e: unknown): ExportSupport => ({ ok: false, reason: `Export is unavailable: ${e instanceof Error ? e.message : String(e)}` }))
    .then((result) => {
      support = { kind: "checked", ...result };
      renderExport();
    });

  return {
    nodes,
    teardown: () => {
      abort.abort();
      setExportState({ kind: "idle" });
      preview.destroy();
    },
  };
}

function statusText(state: ExportState, support: SupportState): string {
  if (support.kind === "checked" && !support.ok) return support.reason;
  switch (state.kind) {
    case "idle":
      return "";
    case "running":
      return `Rendering ${Math.round(state.fraction * 100)}%`;
    case "done":
      return `Saved ${state.filename}`;
    case "failed":
      return `Export failed: ${state.message}`;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

async function start(root: HTMLElement) {
  let teardown: () => void = () => {};
  let latest = 0;
  const render = async () => {
    const token = ++latest;
    teardown();
    teardown = () => {};
    const route = parseRoute(location.hash);
    const view = await routeView(route).catch(errorView);
    if (token !== latest) {
      view.teardown();
      return;
    }
    root.replaceChildren(...view.nodes);
    teardown = view.teardown;
  };
  window.addEventListener("hashchange", () => void render());
  await render();
}

const root = document.getElementById("app");
if (root !== null) void start(root);
