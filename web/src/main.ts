import "./style.css";
import { type View, el } from "./dom.ts";
import type { ExportSupport } from "./export.ts";
import { loadLabelFont } from "./labels.ts";
import { mountPreview } from "./preview.ts";
import { type Route, parseRoute } from "./route.ts";
import { type Session, loadSession } from "./session.ts";
import { type IndexEntry, type SubjectId, loadIndex, loadTemplate } from "./template.ts";

type ExportState =
  | { kind: "idle" }
  | { kind: "running"; fraction: number }
  | { kind: "done"; url: string; filename: string }
  | { kind: "failed"; message: string };

type SupportState = { kind: "checking" } | ({ kind: "checked" } & ExportSupport);

const BASE_URL = new URL(import.meta.env.BASE_URL, location.href).href;

async function routeView(route: Route, session: Session | null): Promise<View> {
  const author = session !== null;
  switch (route.kind) {
    case "gallery":
      return galleryView(author);
    case "editor":
      return editorView(route.id);
    case "login":
      return (await import("./author.ts")).loginView(route.next);
    case "new":
      return session === null ? galleryView(false) : (await import("./author.ts")).newView(session);
    case "job":
      return author ? (await import("./author.ts")).jobView(route.id) : galleryView(false);
    case "edit":
      return author ? (await import("./author.ts")).editTemplateView(route.id) : galleryView(false);
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

function galleryCard(t: IndexEntry, author: boolean): HTMLElement {
  return el(
    "article",
    { className: "card" },
    el(
      "a",
      { className: "card-link", href: `#/t/${t.id}` },
      el("img", { src: t.thumbUrl, alt: "", width: t.width, height: t.height, loading: "lazy" }),
      el("h2", {}, t.title),
      el("p", { className: "credit" }, t.credit),
      el("p", { className: "meta" }, `${formatDuration(t.frameCount, t.fps)} · ${subjectCount(t.subjectCount)}`),
    ),
    ...(author ? [el("a", { className: "card-edit", href: `#/edit/${t.id}`, title: `Edit ${t.title}` }, "Edit")] : []),
  );
}

async function galleryView(author: boolean): Promise<View> {
  const templates = await loadIndex(BASE_URL);
  return {
    nodes: [
      el("header", {}, el("h1", {}, "labelmeme"), el("p", { className: "tagline" }, "Pick a clip, name the things in it, download the meme.")),
      el(
        "main",
        { className: "gallery" },
        ...(author ? [el("a", { className: "card new-card", href: "#/new" }, el("h2", {}, "+ New template"), el("p", { className: "meta" }, "From a video file or a YouTube link"))] : []),
        ...templates.map((t) => galleryCard(t, author)),
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
  const session = await loadSession();
  let teardown: () => void = () => {};
  let latest = 0;
  const render = async () => {
    const token = ++latest;
    teardown();
    teardown = () => {};
    const view = await routeView(parseRoute(location.hash, session !== null), session).catch(errorView);
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
