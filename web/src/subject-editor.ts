import type { EditSession } from "./authoring.ts";
import { el } from "./dom.ts";
import { type LabelLayout, drawLabel, layoutLabel, loadLabelFont, measureOn, paintFrame } from "./labels.ts";
import type { WireRun } from "./schema.ts";
import {
  type Action,
  type Draft,
  type EditorState,
  type SubjectDraft,
  brushSize,
  editorState,
  labelsOf,
  modeOf,
  processed,
  reduce,
  runsOf,
  saveBlocker,
  saveBody,
  toTemplate,
} from "./subjects.ts";
import { type SubjectId, type Template, frameIndexAt, placementAt } from "./template.ts";
import { type Clip, type Rate, anchorOf, isPlaced, shotOf, toWireBox } from "./track.ts";

const SAVE_DEBOUNCE_MS = 300;
const TYPED_EDITS: ReadonlySet<Action["kind"]> = new Set(["retitle", "rename", "tune"]);
const RETRY_MS = 2000;
const SVG_NS = "http://www.w3.org/2000/svg";
const SPEEDS: readonly Rate[] = [0.25, 0.5, 1];
const DEFAULT_SPEED: Rate = 0.5;

const ICONS = {
  back: "M15 18l-6-6 6-6",
  rename: "M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4",
  clear: "M15 4l5 5-9 9H7l-3-3L15 4zM10 18h10",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  tuning: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
} as const;

type PlayMode = "plain" | "result";

type Command = "play" | "playResult" | "stepBack" | "stepForward" | "backToStroke" | "erase" | "smaller" | "bigger";

const SHORTCUTS: readonly { readonly hint: string; readonly label: string; readonly keys: Readonly<Record<string, Command>> }[] = [
  { hint: "Space", label: "play / pause", keys: { " ": "play" } },
  { hint: "← →", label: "step a frame", keys: { ArrowLeft: "stepBack", ArrowRight: "stepForward" } },
  { hint: "B", label: "back to where the last stroke began", keys: { b: "backToStroke", B: "backToStroke" } },
  { hint: "R", label: "play result", keys: { r: "playResult", R: "playResult" } },
  { hint: "E", label: "erase, or hold Alt", keys: { e: "erase", E: "erase" } },
  { hint: "− +", label: "size", keys: { "-": "smaller", "+": "bigger", "=": "bigger" } },
];
const COMMAND_OF: ReadonlyMap<string, Command> = new Map(SHORTCUTS.flatMap((s) => Object.entries(s.keys)));

interface LabelBox {
  readonly layout: LabelLayout;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}

const displayName = (s: SubjectDraft) => (s.name.trim() === "" ? "this subject" : s.name);

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function shortcutButton(label: string, hint: string, keys: string, className: string): HTMLButtonElement {
  return el("button", { type: "button", className, ariaKeyShortcuts: keys }, label, " ", el("kbd", {}, hint));
}

function iconButton(path: string, className: string, title: string): HTMLButtonElement {
  return el("button", { type: "button", className: `icon ${className}`, title, ariaLabel: title }, icon(path));
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

function slider(id: string, label: string, max: number, step: number): { field: HTMLElement; input: HTMLInputElement; value: HTMLElement } {
  const input = el("input", { id, type: "range", min: "0", max: String(max), step: String(step) });
  const value = el("span", { className: "slider-value" });
  return { field: el("label", { className: "slider", htmlFor: id }, label, input, value), input, value };
}

export function mountSubjectEditor(container: HTMLElement, session: EditSession, initial: { readonly draft: Draft; readonly clip: Clip }): { destroy(): void } {
  const { id, videoUrl } = session;
  const clip = initial.clip;
  let state: EditorState = editorState(initial.draft);
  let runs: ReadonlyMap<SubjectId, readonly WireRun[]> = runsOf(state, clip);
  let alive = true;
  let dirty = false;
  let queued = 0;
  let putTimer = 0;
  let inflight: Promise<void> = Promise.resolve();
  let frameRequest: number | null = null;
  let playMode: PlayMode = "plain";
  let eraseToggle = false;
  let altHeld = false;
  let pointer: readonly [number, number] | null = null;
  let labels: ReadonlyMap<SubjectId, LabelBox> = new Map();
  const touchOnly = matchMedia("(pointer: coarse)").matches;
  const erasing = () => altHeld || eraseToggle;
  const playing = (): PlayMode | null => (video.paused || state.stroke !== null ? null : playMode);
  const pct = (f: number) => `${(100 * f) / clip.frameCount}%`;
  const scale = clip.width / 1280;

  const titleInput = el("input", { id: "tpl-title", className: "title-input", value: state.doc.title, maxLength: 200, autocomplete: "off" });
  const saveButton = el("button", { type: "button", className: "save" }, "Save");
  const undoButton = shortcutButton("Undo", isMac ? "⌘Z" : "Ctrl+Z", isMac ? "Meta+Z" : "Control+Z", "history undo");
  const redoButton = shortcutButton("Redo", isMac ? "⇧⌘Z" : "Shift+Ctrl+Z", isMac ? "Shift+Meta+Z" : "Shift+Control+Z", "history redo");
  const status = el("p", { className: "editor-status", role: "status" });
  const bar = el(
    "header",
    { className: "editor-bar" },
    el("a", { className: "back-icon", href: session.backHref, ariaLabel: "Back to templates" }, icon(ICONS.back)),
    el("label", { htmlFor: titleInput.id, className: "visually-hidden" }, "Template title"),
    titleInput,
    status,
    undoButton,
    redoButton,
    saveButton,
  );

  const video = el("video", { className: "editor-video", src: videoUrl, preload: "auto", playsInline: true });
  const canvas = el("canvas", { className: "editor-canvas", width: clip.width, height: clip.height });
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("2D canvas is not available");
  const bannerText = el("span", { className: "banner-main" });
  const bannerHint = el("span", { className: "banner-hint" });
  const banner = el("p", { className: "stage-banner", role: "status" }, bannerText, bannerHint);
  const frameBox = el("div", { className: "stage-frame" }, video, canvas, banner);
  const stage = el("div", { className: "stage" }, frameBox);
  stage.style.setProperty("--aspect", `${clip.width} / ${clip.height}`);

  const playLabel = el("span", {}, "Play");
  const playButton = el("button", { type: "button", className: "play", ariaKeyShortcuts: "Space" }, playLabel, " ", el("kbd", {}, "Space"));
  const resultLabel = el("span", {}, "Play result");
  const resultButton = el("button", { type: "button", className: "play-result", ariaKeyShortcuts: "R" }, resultLabel, " ", el("kbd", {}, "R"));
  const backLabel = el("span", {});
  const backButton = el("button", { type: "button", className: "back-to-stroke", ariaKeyShortcuts: "B" }, backLabel, " ", el("kbd", {}, "B"));
  const timecode = el("span", { className: "timecode" });
  const eraseButton = shortcutButton("Erase", "E", "E Alt", "action erase");
  eraseButton.title = "Erase: press E, or hold Alt while drawing";
  const smallerButton = el("button", { type: "button", className: "icon action smaller", title: "Smaller label (−)", ariaKeyShortcuts: "-" }, "−");
  const biggerButton = el("button", { type: "button", className: "icon action bigger", title: "Bigger label (+)", ariaKeyShortcuts: "+" }, "+");
  const speed = el(
    "select",
    { id: "speed", className: "speed" },
    ...SPEEDS.map((r) => el("option", { value: String(r), selected: r === DEFAULT_SPEED }, `${r}×`)),
  );
  const lag = slider("lag", "Reaction lag", 400, 10);
  const smoothing = slider("smoothing", "Smoothing", 12, 1);
  const tuningPanel = el("div", { id: "tuning", className: "tuning", popover: "auto" }, el("p", { className: "tuning-title" }, "Tracking feel"), lag.field, smoothing.field);
  const tuningButton = iconButton(ICONS.tuning, "tuning-toggle", "Tracking feel: reaction lag and smoothing");
  tuningButton.popoverTargetElement = tuningPanel;
  const transport = el(
    "div",
    { className: "transport" },
    playButton,
    resultButton,
    backButton,
    timecode,
    el("span", { className: "spacer" }),
    eraseButton,
    smallerButton,
    biggerButton,
    el("label", { className: "slider", htmlFor: speed.id }, "Speed", speed),
    tuningButton,
    tuningPanel,
  );
  const keyHints = el(
    "p",
    { className: "key-hints" },
    ...SHORTCUTS.flatMap((x) => [el("kbd", {}, x.hint), ` ${x.label} · `]),
    `hold ${touchOnly ? "your finger" : "the mouse"} on the video to draw`,
  );

  const scrubber = el("div", {
    className: "scrubber",
    role: "slider",
    tabIndex: 0,
    ariaLabel: "Timeline",
    ariaValueMin: "0",
    ariaValueMax: String(clip.frameCount - 1),
  });
  const cutsAndPlayhead = () => [
    ...clip.cuts.map((c) => {
      const line = el("div", { className: "cut" });
      line.style.left = pct(c);
      return line;
    }),
    el("div", { className: "playhead" }),
  ];
  scrubber.append(...cutsAndPlayhead());
  const lanes = el("div", { className: "lanes" });
  const addButton = el("button", { type: "button", className: "add-subject" }, "+ Add subject");
  const emptyPrompt = el("p", { className: "empty-prompt" }, "Move to the frame where your first subject appears, then add it");
  const notice = el("p", { className: "editor-notice", role: "status" });
  const timeline = el(
    "section",
    { className: "timeline", ariaLabel: "Subjects timeline" },
    el("span", { className: "ruler-gap" }),
    scrubber,
    lanes,
    addButton,
    el("div", { className: "timeline-foot" }, emptyPrompt, notice),
  );

  container.append(bar, stage, transport, keyHints, timeline);

  const selectedDoc = () => state.doc.subjects.find((s) => s.id === state.selected) ?? null;

  const labelBoxes = (t: Template): ReadonlyMap<SubjectId, LabelBox> => {
    const measure = measureOn(ctx);
    const boxes = new Map<SubjectId, LabelBox>();
    for (const s of t.subjects) {
      const text = s.name.trim().toUpperCase();
      const placement = text === "" ? null : placementAt(s, state.frame, t);
      if (placement === null) continue;
      const layout = layoutLabel(measure, text, placement.box, clip.width, clip.height);
      const { width, ascent } = measure(text, layout.fontPx);
      const pad = layout.lineWidth + 4 * scale;
      boxes.set(s.id, {
        layout,
        x0: layout.centerX - width / 2 - pad,
        y0: layout.baseline - ascent - pad,
        x1: layout.centerX + width / 2 + pad,
        y1: layout.baseline + pad,
      });
    }
    return boxes;
  };

  const labelAt = ([x, y]: readonly [number, number]): SubjectId | null => {
    let hit: SubjectId | null = null;
    for (const [sid, b] of labels) if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) hit = sid;
    return hit;
  };

  const hoveredOther = () => {
    const hit = pointer === null ? null : labelAt(pointer);
    return hit !== null && hit !== state.selected;
  };

  const strokePaths = () => {
    const { from, to } = shotOf(clip, state.frame);
    for (const s of state.doc.subjects) {
      const selected = s.id === state.selected;
      const track = processed(state, s, clip);
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = selected ? 0.9 : 0.35;
      ctx.lineWidth = (selected ? 3 : 2) * scale;
      ctx.beginPath();
      let open = false;
      for (let f = from; f < to; f++) {
        const cell = track[f];
        if (!isPlaced(cell)) {
          open = false;
          continue;
        }
        const [x, y] = anchorOf(cell, clip);
        if (open) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        open = true;
      }
      ctx.stroke();
      ctx.restore();
    }
  };

  const selectionOutline = (s: SubjectDraft, b: LabelBox) => {
    const px = canvas.width / (canvas.clientWidth || canvas.width);
    const chipPx = 12 * px;
    const chipH = chipPx * 1.6;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.roundRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 6 * px);
    ctx.stroke();
    ctx.font = `600 ${chipPx}px system-ui, sans-serif`;
    const chipW = ctx.measureText(s.name).width + chipPx;
    const chipX = Math.min(Math.max(b.x0, 0), clip.width - chipW);
    const chipY = b.y0 - chipH - 4 * px >= 0 ? b.y0 - chipH - 4 * px : b.y1 + 4 * px;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.roundRect(chipX, chipY, chipW, chipH, 4 * px);
    ctx.fill();
    ctx.fillStyle = "#111214";
    ctx.textBaseline = "middle";
    ctx.fillText(s.name, chipX + chipPx / 2, chipY + chipH / 2);
    ctx.restore();
  };

  const cursorLabel = (s: SubjectDraft, at: readonly [number, number]) => {
    if (erasing()) {
      ctx.save();
      ctx.strokeStyle = "#ff5d5d";
      ctx.lineWidth = 3 * scale;
      ctx.beginPath();
      ctx.arc(at[0], at[1], 14 * scale, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.restore();
      return;
    }
    const size = state.stroke?.size ?? brushSize(state, s.id, clip);
    const [x, y, w, h] = toWireBox([at[0], at[1], size, 1], clip);
    const text = (s.name.trim() || "Subject").toUpperCase();
    drawLabel(ctx, layoutLabel(measureOn(ctx), text, { x, y, w, h }, clip.width, clip.height), state.stroke === null ? 0.5 : 1);
  };

  const paint = () => {
    const t = toTemplate(runs, state, clip, id, videoUrl);
    paintFrame(ctx, (c) => c.drawImage(video, 0, 0, clip.width, clip.height), t, labelsOf(state.doc), state.frame);
    labels = labelBoxes(t);
    if (playing() !== "result") {
      strokePaths();
      const s = selectedDoc();
      const box = s === null ? undefined : labels.get(s.id);
      if (s !== null && box !== undefined && state.stroke === null) selectionOutline(s, box);
      if (s !== null && pointer !== null && !hoveredOther()) cursorLabel(s, pointer);
    }
    canvas.style.cursor = state.stroke === null && hoveredOther() ? "pointer" : state.selected === null ? "default" : "crosshair";
    canvas.dataset.frame = String(state.frame);
  };

  const coloured = (text: string, color: string) => {
    const b = el("strong", {}, text);
    b.style.color = color;
    return b;
  };

  const renderMode = () => {
    const mode = modeOf(state, clip, { playing: playing() === "result", erasing: erasing() });
    stage.dataset.mode = mode.kind;
    emptyPrompt.hidden = mode.kind !== "empty";
    bannerHint.textContent = "";
    switch (mode.kind) {
      case "empty":
        bannerText.replaceChildren("Press Space to play and pause, or drag the timeline under the video.");
        break;
      case "pick":
        bannerText.replaceChildren("Pick a subject: click its label on the video or its row below");
        break;
      case "follow":
        bannerText.replaceChildren(`Hold ${touchOnly ? "your finger" : "the mouse"} on `, coloured(displayName(mode.subject), mode.subject.color), " and follow it");
        bannerHint.textContent = "Not on screen yet? Press Space or drag the timeline to where it appears.";
        break;
      case "recording":
        bannerText.replaceChildren(
          ...(mode.erasing
            ? ["Erasing ", coloured(displayName(mode.subject), mode.subject.color), "…"]
            : ["Recording ", coloured(displayName(mode.subject), mode.subject.color), "… release to pause"]),
        );
        break;
      case "paused":
        bannerText.replaceChildren("Hold to continue, or scrub back to redo a stretch");
        break;
      case "playing":
        bannerText.replaceChildren("Playing the result");
        break;
      default: {
        const _exhaustive: never = mode;
        return _exhaustive;
      }
    }
    eraseButton.ariaPressed = String(eraseToggle);
    eraseButton.classList.toggle("on", eraseToggle);
    const recording = state.stroke !== null;
    const unselected = state.selected === null;
    undoButton.disabled = recording || state.past.length === 0;
    redoButton.disabled = recording || state.future.length === 0;
    eraseButton.disabled = unselected;
    smallerButton.disabled = unselected;
    biggerButton.disabled = unselected;
    addButton.disabled = recording;
    const blocker = saveBlocker(state, runs);
    saveButton.disabled = blocker !== null;
    saveButton.title = blocker ?? "Write the template and open it";
    playLabel.textContent = playing() === "plain" ? "Pause" : "Play";
    resultLabel.textContent = playing() === "result" ? "Pause" : "Play result";
    const canGoBack = state.strokeFrom !== null && state.strokeFrom !== state.frame;
    backButton.style.visibility = canGoBack ? "visible" : "hidden";
    backButton.disabled = recording || !canGoBack;
    if (canGoBack) backLabel.textContent = `Back to frame ${state.strokeFrom}`;
  };

  const renderFrame = () => {
    paint();
    renderMode();
    timecode.replaceChildren(clock(state.frame / clip.fps), el("span", { className: "muted" }, ` / ${clock(clip.frameCount / clip.fps)}`));
    timeline.style.setProperty("--playhead", pct(state.frame + 0.5));
    scrubber.ariaValueNow = String(state.frame);
    scrubber.ariaValueText = `frame ${state.frame}`;
  };

  const showNotice = (text: string) => {
    const undo = el("button", { type: "button", className: "notice-undo" }, "Undo");
    undo.addEventListener("click", () => dispatch({ kind: "undo" }));
    notice.replaceChildren(text, " ", undo);
  };

  const laneNodes = new Map<SubjectId, { lane: HTMLElement; name: HTMLElement; rename: HTMLInputElement; deleteButton: HTMLButtonElement; clearButton: HTMLButtonElement; bars: HTMLElement }>();

  const seekFromPointer = (ev: PointerEvent) => {
    const rect = scrubber.getBoundingClientRect();
    dispatch({ kind: "seek", frame: Math.floor(((ev.clientX - rect.left) / rect.width) * clip.frameCount) });
  };

  const startRename = (sid: SubjectId) => {
    const nodes = laneNodes.get(sid);
    const s = state.doc.subjects.find((x) => x.id === sid);
    if (nodes === undefined || s === undefined || state.stroke !== null) return;
    dispatch({ kind: "select", id: sid });
    nodes.rename.value = s.name;
    nodes.rename.hidden = false;
    nodes.name.hidden = true;
    nodes.rename.focus();
    nodes.rename.select();
  };

  const laneFor = (s: SubjectDraft) => {
    const existing = laneNodes.get(s.id);
    if (existing !== undefined) return existing;
    const name = el("span", { className: "lane-name", title: "Double-click to rename" });
    const rename = el("input", { className: "lane-rename", maxLength: 60, autocomplete: "off", ariaLabel: "Subject name", hidden: true });
    name.addEventListener("dblclick", () => startRename(s.id));
    rename.addEventListener("input", () => dispatch({ kind: "rename", id: s.id, name: rename.value }));
    rename.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === "Escape") rename.blur();
    });
    rename.addEventListener("blur", () => {
      rename.hidden = true;
      name.hidden = false;
      renderLanes();
    });
    const renameButton = iconButton(ICONS.rename, "rename", "Rename");
    const clearButton = iconButton(ICONS.clear, "clear", "Clear");
    const deleteButton = iconButton(ICONS.trash, "delete", "Delete");
    renameButton.addEventListener("click", () => startRename(s.id));
    clearButton.addEventListener("click", () => dispatch({ kind: "clearSubject", id: s.id }));
    deleteButton.addEventListener("click", () => dispatch({ kind: "deleteSubject", id: s.id }));
    const acts = el("span", { className: "lane-actions" }, renameButton, clearButton, deleteButton);
    acts.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    const head = el("div", { className: "lane-head" }, el("span", { className: "dot" }), name, rename, acts);
    const bars = el("div", { className: "bars" });
    const track = el("div", { className: "lane-track" }, bars, ...cutsAndPlayhead());
    for (const part of [head, track]) part.addEventListener("pointerdown", () => dispatch({ kind: "select", id: s.id }));
    const lane = el("div", { className: "lane" }, head, track);
    lane.dataset.subject = s.id;
    const nodes = { lane, name, rename, deleteButton, clearButton, bars };
    laneNodes.set(s.id, nodes);
    return nodes;
  };

  function renderLanes() {
    const present = new Set(state.doc.subjects.map((s) => s.id));
    for (const [sid, nodes] of laneNodes) {
      if (!present.has(sid)) {
        nodes.lane.remove();
        laneNodes.delete(sid);
      }
    }
    const recording = state.stroke !== null;
    state.doc.subjects.forEach((s, i) => {
      const { lane, name, rename, deleteButton, clearButton, bars } = laneFor(s);
      name.textContent = s.name.trim() === "" ? "Unnamed" : s.name;
      name.classList.toggle("unnamed", s.name.trim() === "");
      if (document.activeElement !== rename) rename.value = s.name;
      deleteButton.title = deleteButton.ariaLabel = `Delete ${displayName(s)}`;
      clearButton.title = clearButton.ariaLabel = `Clear ${displayName(s)}'s drawing`;
      deleteButton.disabled = recording;
      clearButton.disabled = recording;
      lane.classList.toggle("selected", s.id === state.selected);
      lane.style.setProperty("--subject", s.color);
      bars.replaceChildren(
        ...(runs.get(s.id) ?? []).map((r) => {
          const b = el("div", { className: "bar" });
          b.style.left = pct(r.from);
          b.style.width = pct(r.boxes.length);
          return b;
        }),
      );
      if (lanes.children[i] !== lane) lanes.insertBefore(lane, lanes.children[i] ?? null);
    });
  }

  const renderTuning = () => {
    lag.input.value = String(state.tuning.lagMs);
    lag.value.textContent = `${state.tuning.lagMs} ms`;
    smoothing.input.value = String(state.tuning.smoothRadius);
    smoothing.value.textContent = String(state.tuning.smoothRadius);
  };

  const send = (): Promise<void> =>
    session
      .putDraft({ doc: state.doc, tuning: state.tuning })
      .then(() => {
        if (alive && !dirty) status.textContent = "";
      })
      .catch((e: unknown) => {
        dirty = true;
        status.textContent = `Could not save the drawing: ${message(e)}`;
        if (alive) putTimer = window.setTimeout(() => void flush(), RETRY_MS);
      });

  const flush = (): Promise<void> => {
    clearTimeout(putTimer);
    if (!dirty) return inflight;
    dirty = false;
    queued++;
    inflight = inflight.then(() => {
      queued--;
      return send();
    });
    return inflight;
  };

  const onPageHide = () => {
    if (!dirty && queued === 0) return;
    clearTimeout(putTimer);
    dirty = false;
    void send();
  };
  window.addEventListener("pagehide", onPageHide);

  function dispatch(a: Action) {
    const prev = state;
    const prevRuns = runs;
    state = reduce(state, a, clip);
    if (state.doc !== prev.doc || state.tuning !== prev.tuning || state.stroke !== prev.stroke) runs = runsOf(state, clip);
    if (state.doc !== prev.doc) {
      const removed = prev.doc.subjects.find((x) => x.id === (a.kind === "deleteSubject" || a.kind === "clearSubject" ? a.id : null));
      if (removed === undefined) notice.replaceChildren();
      else showNotice(`${a.kind === "deleteSubject" ? "Deleted" : "Cleared"} ${displayName(removed)}.`);
    }
    if (state.doc !== prev.doc || state.tuning !== prev.tuning) {
      dirty = true;
      clearTimeout(putTimer);
      if (TYPED_EDITS.has(a.kind)) putTimer = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
      else void flush();
    }
    if (state.tuning !== prev.tuning || a.kind === "undo" || a.kind === "redo") renderTuning();
    if (state.doc !== prev.doc || state.selected !== prev.selected || runs !== prevRuns) renderLanes();
    if (state.frame !== prev.frame && (a.kind === "seek" || a.kind === "step")) {
      video.currentTime = (state.frame + 0.1) / clip.fps;
    }
    renderFrame();
  }

  const toTemplatePx = (ev: PointerEvent | WheelEvent): readonly [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [((ev.clientX - rect.left) * canvas.width) / rect.width, ((ev.clientY - rect.top) * canvas.height) / rect.height];
  };

  const currentSpeed = (): Rate => SPEEDS.find((r) => String(r) === speed.value) ?? DEFAULT_SPEED;

  const releaseFocus = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  container.addEventListener("mousedown", (ev) => {
    if (!(ev.target instanceof Element) || ev.target.closest("button") === null) return;
    ev.preventDefault();
    releaseFocus();
  });

  scrubber.addEventListener("pointerdown", (ev) => {
    if (state.stroke !== null) return;
    video.pause();
    scrubber.setPointerCapture(ev.pointerId);
    seekFromPointer(ev);
  });
  scrubber.addEventListener("pointermove", (ev) => {
    if (state.stroke === null && scrubber.hasPointerCapture(ev.pointerId)) seekFromPointer(ev);
  });

  const endStroke = () => {
    if (state.stroke === null) return;
    video.pause();
    dispatch({ kind: "strokeEnd" });
  };

  const onVideoFrame: VideoFrameRequestCallback = (_now, metadata) => {
    const frame = frameIndexAt(metadata.mediaTime, clip);
    if (state.stroke !== null && pointer !== null) dispatch({ kind: "strokeSample", frame, at: pointer, erase: erasing() });
    else if (!video.paused) {
      state = { ...state, frame };
      renderFrame();
    } else paint();
    frameRequest = video.requestVideoFrameCallback(onVideoFrame);
  };
  frameRequest = video.requestVideoFrameCallback(onVideoFrame);
  video.addEventListener("loadeddata", paint);
  video.addEventListener("seeked", paint);
  video.addEventListener("play", renderFrame);
  video.addEventListener("pause", renderFrame);
  video.addEventListener("ended", () => {
    endStroke();
    renderFrame();
  });

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    ev.preventDefault();
    if (state.stroke !== null) return;
    releaseFocus();
    video.pause();
    pointer = toTemplatePx(ev);
    const hit = labelAt(pointer);
    if (hit !== null && hit !== state.selected) {
      dispatch({ kind: "select", id: hit });
      return;
    }
    if (state.selected === null || state.frame >= clip.frameCount - 1) return;
    canvas.setPointerCapture(ev.pointerId);
    altHeld = ev.altKey;
    dispatch({ kind: "strokeBegin", at: pointer, erase: erasing(), rate: currentSpeed() });
    video.playbackRate = currentSpeed();
    void video.play();
  });
  canvas.addEventListener("pointermove", (ev) => {
    pointer = toTemplatePx(ev);
    altHeld = ev.altKey;
    if (state.stroke === null) {
      paint();
      renderMode();
    }
  });
  canvas.addEventListener("pointerleave", () => {
    if (state.stroke !== null) return;
    pointer = null;
    paint();
  });
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      pointer = toTemplatePx(ev);
      dispatch({ kind: "resize", steps: -ev.deltaY / 100 });
    },
    { passive: false },
  );

  const togglePlay = () => {
    if (state.stroke !== null) return;
    if (playing() === "plain") {
      video.pause();
      renderFrame();
      return;
    }
    if (state.frame >= clip.frameCount - 1) dispatch({ kind: "seek", frame: 0 });
    playMode = "plain";
    video.playbackRate = 1;
    void video.play();
    renderFrame();
  };

  const togglePlayResult = () => {
    if (state.stroke !== null) return;
    if (playing() === "result") {
      video.pause();
      renderFrame();
      return;
    }
    playMode = "result";
    video.playbackRate = 1;
    video.currentTime = 0;
    dispatch({ kind: "seek", frame: 0 });
    void video.play();
  };
  const backToStroke = () => {
    if (state.stroke !== null || state.strokeFrom === null) return;
    video.pause();
    dispatch({ kind: "seek", frame: state.strokeFrom });
  };
  playButton.addEventListener("click", togglePlay);
  backButton.addEventListener("click", backToStroke);
  resultButton.addEventListener("click", togglePlayResult);
  speed.addEventListener("change", () => speed.blur());
  lag.input.addEventListener("input", () => dispatch({ kind: "tune", tuning: { lagMs: Number(lag.input.value) } }));
  smoothing.input.addEventListener("input", () => dispatch({ kind: "tune", tuning: { smoothRadius: Number(smoothing.input.value) } }));
  tuningPanel.addEventListener("beforetoggle", (ev) => {
    if (ev.newState !== "open") return;
    const r = tuningButton.getBoundingClientRect();
    tuningPanel.style.right = `${innerWidth - r.right}px`;
    tuningPanel.style.bottom = `${innerHeight - r.top + 8}px`;
  });
  titleInput.addEventListener("input", () => dispatch({ kind: "retitle", title: titleInput.value }));
  addButton.addEventListener("click", () => dispatch({ kind: "addSubject" }));
  const toggleErase = () => {
    eraseToggle = !eraseToggle;
    renderFrame();
  };
  eraseButton.addEventListener("click", toggleErase);
  smallerButton.addEventListener("click", () => dispatch({ kind: "resize", steps: -1 }));
  biggerButton.addEventListener("click", () => dispatch({ kind: "resize", steps: 1 }));
  undoButton.addEventListener("click", () => dispatch({ kind: "undo" }));
  redoButton.addEventListener("click", () => dispatch({ kind: "redo" }));

  const onAlt = (ev: KeyboardEvent) => {
    if (ev.key !== "Alt" || altHeld === (ev.type === "keydown")) return;
    altHeld = ev.type === "keydown";
    renderFrame();
  };
  const run = (command: Command) => {
    switch (command) {
      case "play":
        togglePlay();
        return;
      case "playResult":
        togglePlayResult();
        return;
      case "stepBack":
      case "stepForward":
        if (state.stroke !== null) return;
        video.pause();
        dispatch({ kind: "step", delta: command === "stepBack" ? -1 : 1 });
        return;
      case "backToStroke":
        backToStroke();
        return;
      case "erase":
        toggleErase();
        return;
      case "smaller":
      case "bigger":
        dispatch({ kind: "resize", steps: command === "smaller" ? -1 : 1 });
        return;
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  };
  const onKey = (ev: KeyboardEvent) => {
    onAlt(ev);
    const target = ev.target as HTMLElement | null;
    if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      dispatch({ kind: ev.shiftKey ? "redo" : "undo" });
      return;
    }
    if (ev.metaKey || ev.ctrlKey) return;
    const command = COMMAND_OF.get(ev.key);
    if (command === undefined) return;
    ev.preventDefault();
    run(command);
  };
  document.addEventListener("keydown", onKey);
  document.addEventListener("keyup", onAlt);

  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    await flush();
    try {
      await session.save(saveBody(state, runs));
      location.hash = `#/t/${id}`;
    } catch (e) {
      status.textContent = message(e);
      renderMode();
    }
  });

  renderTuning();
  renderLanes();
  renderFrame();
  void loadLabelFont(new URL(import.meta.env.BASE_URL, location.href).href).then(() => alive && paint());

  return {
    destroy() {
      alive = false;
      void flush();
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keyup", onAlt);
      if (frameRequest !== null) video.cancelVideoFrameCallback(frameRequest);
      video.pause();
      video.removeAttribute("src");
      video.load();
    },
  };
}
