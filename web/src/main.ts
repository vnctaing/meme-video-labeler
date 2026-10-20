import "./style.css";
import type { ExportSupport } from "./export.ts";
import { loadLabelFont } from "./labels.ts";
import { mountPreview } from "./preview.ts";
import { type IndexEntry, type SubjectId, loadIndex, loadTemplate } from "./template.ts";

type Route = { kind: "gallery" } | { kind: "editor"; id: string };

type ExportState =
  | { kind: "idle" }
  | { kind: "running"; fraction: number }
  | { kind: "done"; url: string; filename: string }
  | { kind: "failed"; message: string };

type SupportState = { kind: "checking" } | ({ kind: "checked" } & ExportSupport);

interface View {
  readonly nodes: readonly Node[];
  readonly teardown: () => void;
}

const BASE_URL = new URL(import.meta.env.BASE_URL, location.href).href;

function parseRoute(hash: string): Route {
  const m = /^#\/t\/([a-z0-9-]+)$/.exec(hash);
  return m === null ? { kind: "gallery" } : { kind: "editor", id: m[1] };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function formatDuration(frameCount: number, fps: number): string {
  return `${(frameCount / fps).toFixed(1)} s`;
}

function people(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

function galleryCard(t: IndexEntry): HTMLElement {
  return el(
    "a",
    { className: "card", href: `#/t/${t.id}` },
    el("img", { src: t.thumbUrl, alt: "", width: t.width, height: t.height, loading: "lazy" }),
    el("h2", {}, t.title),
    el("p", { className: "credit" }, t.credit),
    el("p", { className: "meta" }, `${formatDuration(t.frameCount, t.fps)} · ${people(t.subjectCount)}`),
  );
}

async function galleryView(): Promise<View> {
  const templates = await loadIndex(BASE_URL);
  return {
    nodes: [
      el("header", {}, el("h1", {}, "labelmeme"), el("p", { className: "tagline" }, "Pick a clip, name the people, download the meme.")),
      el("main", { className: "gallery" }, ...templates.map(galleryCard)),
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
    const view = await (route.kind === "gallery" ? galleryView() : editorView(route.id)).catch(errorView);
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
