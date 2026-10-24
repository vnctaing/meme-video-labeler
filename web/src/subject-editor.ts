import { clipUrl, putDraft, save } from "./authoring.ts";
import { el } from "./dom.ts";
import { drawLabel, layoutLabel, loadLabelFont, measureOn, paintFrame } from "./labels.ts";
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
import { type SubjectId, type TemplateId, frameIndexAt } from "./template.ts";
import { type Clip, type Rate, anchorOf, isPlaced, shotOf, toWireBox } from "./track.ts";

const SAVE_DEBOUNCE_MS = 300;
const TYPED_EDITS: ReadonlySet<Action["kind"]> = new Set(["retitle", "rename", "tune"]);
const RETRY_MS = 2000;
const SVG_NS = "http://www.w3.org/2000/svg";
const SPEEDS: readonly Rate[] = [0.25, 0.5, 1];
const DEFAULT_SPEED: Rate = 0.5;

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

export function mountSubjectEditor(container: HTMLElement, id: TemplateId, initial: { readonly draft: Draft; readonly clip: Clip }): { destroy(): void } {
  const clip = initial.clip;
  let state: EditorState = editorState(initial.draft);
  let runs: ReadonlyMap<SubjectId, readonly WireRun[]> = runsOf(state, clip);
  let alive = true;
  let dirty = false;
  let queued = 0;
  let putTimer = 0;
  let inflight: Promise<void> = Promise.resolve();
  let frameRequest: number | null = null;
  let playing = false;
  let eraseToggle = false;
  let altHeld = false;
  let pointer: readonly [number, number] | null = null;
  const touchOnly = matchMedia("(pointer: coarse)").matches;
  const erasing = () => altHeld || eraseToggle;
  const pct = (f: number) => `${(100 * f) / clip.frameCount}%`;
  const scale = clip.width / 1280;

  const titleInput = el("input", { id: "tpl-title", className: "title-input", value: state.doc.title, maxLength: 200, autocomplete: "off" });
  const saveButton = el("button", { type: "button", className: "save" }, "Save");
  const undoButton = shortcutButton("Undo", isMac ? "⌘Z" : "Ctrl+Z", isMac ? "Meta+Z" : "Control+Z", "history undo");
  const redoButton = shortcutButton("Redo", isMac ? "⇧⌘Z" : "Shift+Ctrl+Z", isMac ? "Shift+Meta+Z" : "Shift+Control+Z", "history redo");
  const bar = el(
    "header",
    { className: "editor-bar" },
    el("a", { className: "back-icon", href: "#/new", ariaLabel: "Back to templates" }, icon("M15 18l-6-6 6-6")),
    el("label", { htmlFor: titleInput.id, className: "visually-hidden" }, "Template title"),
    titleInput,
    undoButton,
    redoButton,
    saveButton,
  );

  const video = el("video", { className: "editor-video", src: clipUrl(id), preload: "auto", playsInline: true });
  const canvas = el("canvas", { className: "editor-canvas", width: clip.width, height: clip.height });
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("2D canvas is not available");
  const playLabel = el("span", {}, "Play result");
  const playButton = el("button", { type: "button", className: "play-result", ariaKeyShortcuts: "Space" }, playLabel, " ", el("kbd", {}, "Space"));
  const speed = el(
    "select",
    { id: "speed", className: "speed" },
    ...SPEEDS.map((r) => el("option", { value: String(r), selected: r === DEFAULT_SPEED }, `${r}×`)),
  );
  const lag = slider("lag", "Reaction lag", 400, 10);
  const smoothing = slider("smoothing", "Smoothing", 12, 1);
  const timecode = el("span", { className: "timecode" });
  const hint = el("p", { className: "editor-hint" });
  const status = el("p", { className: "editor-status", role: "status" });
  const notice = el("p", { className: "editor-notice", role: "status" });
  const emptyAdd = el("button", { type: "button", className: "add-first" }, "+ Add subject");
  const emptyPrompt = el("div", { className: "empty-prompt" }, el("p", {}, "Add the first thing to label"), emptyAdd);
  const banner = el("p", { className: "stage-banner", role: "status" });
  const stage = el("div", { className: "stage" }, video, canvas, emptyPrompt, banner);
  const actionsName = el("strong", { className: "actions-name" });
  const eraseButton = shortcutButton("Erase", "Alt", "Alt E", "action erase");
  const smallerButton = shortcutButton("Size −", "-", "-", "action smaller");
  const biggerButton = shortcutButton("Size +", "+", "+", "action bigger");
  const clearButton = el("button", { type: "button", className: "action clear" }, "Clear subject");
  const deleteButton = el("button", { type: "button", className: "action delete" }, "Delete subject");
  const actions = el(
    "div",
    { className: "subject-actions", ariaLabel: "Selected subject" },
    actionsName,
    eraseButton,
    smallerButton,
    biggerButton,
    clearButton,
    deleteButton,
  );
  const lanes = el("div", { className: "lanes" });
  const overlay = el("div", { className: "timeline-overlay" });
  const playhead = el("div", { className: "playhead" });
  const addButton = el("button", { type: "button", className: "add-subject" }, "+ Add subject");
  const timeline = el("section", { className: "timeline", ariaLabel: "Subjects timeline" }, lanes, el("div", { className: "lane add-row" }, addButton), overlay);

  container.append(
    bar,
    stage,
    el("div", { className: "transport" }, playButton, el("label", { className: "slider", htmlFor: speed.id }, "Speed", speed), timecode, lag.field, smoothing.field),
    actions,
    hint,
    status,
    notice,
    timeline,
  );

  const selectedDoc = () => state.doc.subjects.find((s) => s.id === state.selected) ?? null;

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
    const t = toTemplate(runs, state, clip, id, clipUrl(id));
    paintFrame(ctx, (c) => c.drawImage(video, 0, 0, clip.width, clip.height), t, labelsOf(state.doc), state.frame);
    if (!playing) {
      strokePaths();
      const s = selectedDoc();
      if (s !== null && pointer !== null) cursorLabel(s, pointer);
    }
    canvas.dataset.frame = String(state.frame);
  };

  const coloured = (text: string, color: string) => {
    const b = el("strong", {}, text);
    b.style.color = color;
    return b;
  };

  const renderMode = () => {
    const mode = modeOf(state, clip, { playing, erasing: erasing() });
    stage.dataset.mode = mode.kind;
    emptyPrompt.hidden = mode.kind !== "empty";
    actions.hidden = mode.kind === "empty";
    banner.hidden = mode.kind === "empty" || mode.kind === "paused";
    hint.textContent = "";
    switch (mode.kind) {
      case "empty":
        break;
      case "follow":
        banner.replaceChildren(`Hold ${touchOnly ? "your finger" : "the mouse"} on `, coloured(displayName(mode.subject), mode.subject.color), " and follow it");
        break;
      case "recording":
        banner.replaceChildren(
          ...(mode.erasing
            ? ["Erasing ", coloured(displayName(mode.subject), mode.subject.color), "…"]
            : ["Recording ", coloured(displayName(mode.subject), mode.subject.color), "… release to pause"]),
        );
        break;
      case "paused":
        hint.textContent = "Hold to continue, or scrub back to redo a stretch";
        break;
      case "playing":
        banner.replaceChildren("Playing the result");
        break;
      default: {
        const _exhaustive: never = mode;
        return _exhaustive;
      }
    }
    const s = selectedDoc();
    if (s !== null) {
      actionsName.textContent = displayName(s);
      actionsName.style.color = s.color;
    }
    eraseButton.ariaPressed = String(eraseToggle);
    eraseButton.classList.toggle("on", eraseToggle);
    const recording = state.stroke !== null;
    undoButton.disabled = recording || state.past.length === 0;
    redoButton.disabled = recording || state.future.length === 0;
    clearButton.disabled = recording;
    deleteButton.disabled = recording;
    const blocker = saveBlocker(state, runs);
    saveButton.disabled = blocker !== null;
    saveButton.title = blocker ?? "Write the template and open it";
    playLabel.textContent = playing ? "Pause" : "Play result";
  };

  const renderFrame = () => {
    paint();
    renderMode();
    timecode.replaceChildren(clock(state.frame / clip.fps), el("span", { className: "muted" }, ` / ${clock(clip.frameCount / clip.fps)}`));
    playhead.style.left = pct(state.frame + 0.5);
  };

  const showNotice = (text: string) => {
    const undo = el("button", { type: "button", className: "notice-undo" }, "Undo");
    undo.addEventListener("click", () => dispatch({ kind: "undo" }));
    notice.replaceChildren(text, " ", undo);
  };

  const laneNodes = new Map<SubjectId, { lane: HTMLElement; name: HTMLInputElement; track: HTMLElement }>();

  const seekFromPointer = (track: HTMLElement, ev: PointerEvent) => {
    const rect = track.getBoundingClientRect();
    dispatch({ kind: "seek", frame: Math.floor(((ev.clientX - rect.left) / rect.width) * clip.frameCount) });
  };

  const laneFor = (s: SubjectDraft, index: number) => {
    const existing = laneNodes.get(s.id);
    if (existing !== undefined) return existing;
    const name = el("input", { id: `subject-${s.id}`, className: "lane-name", maxLength: 60, autocomplete: "off" });
    name.addEventListener("input", () => dispatch({ kind: "rename", id: s.id, name: name.value }));
    name.addEventListener("focus", () => dispatch({ kind: "select", id: s.id }));
    name.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") name.blur();
    });
    const track = el("div", { className: "lane-track" });
    track.addEventListener("pointerdown", (ev) => {
      if (state.stroke !== null) return;
      track.setPointerCapture(ev.pointerId);
      video.pause();
      dispatch({ kind: "select", id: s.id });
      seekFromPointer(track, ev);
    });
    track.addEventListener("pointermove", (ev) => {
      if (track.hasPointerCapture(ev.pointerId)) seekFromPointer(track, ev);
    });
    const lane = el("div", { className: "lane" }, el("label", { htmlFor: name.id, className: "visually-hidden" }, `Subject ${index + 1} name`), name, track);
    lane.dataset.subject = s.id;
    const nodes = { lane, name, track };
    laneNodes.set(s.id, nodes);
    return nodes;
  };

  const renderLanes = () => {
    const present = new Set(state.doc.subjects.map((s) => s.id));
    for (const [sid, nodes] of laneNodes) {
      if (!present.has(sid)) {
        nodes.lane.remove();
        laneNodes.delete(sid);
      }
    }
    state.doc.subjects.forEach((s, i) => {
      const { lane, name, track } = laneFor(s, i);
      if (document.activeElement !== name) name.value = s.name;
      lane.classList.toggle("selected", s.id === state.selected);
      lane.style.setProperty("--subject", s.color);
      track.replaceChildren(
        ...(runs.get(s.id) ?? []).map((r) => {
          const b = el("div", { className: "bar" });
          b.style.left = pct(r.from);
          b.style.width = pct(r.boxes.length);
          return b;
        }),
      );
      if (lanes.children[i] !== lane) lanes.insertBefore(lane, lanes.children[i] ?? null);
    });
    overlay.hidden = state.doc.subjects.length === 0;
    overlay.replaceChildren(
      ...clip.cuts.map((c) => {
        const line = el("div", { className: "cut" });
        line.style.left = pct(c);
        return line;
      }),
      playhead,
    );
  };

  const renderTuning = () => {
    lag.input.value = String(state.tuning.lagMs);
    lag.value.textContent = `${state.tuning.lagMs} ms`;
    smoothing.input.value = String(state.tuning.smoothRadius);
    smoothing.value.textContent = String(state.tuning.smoothRadius);
  };

  const send = (): Promise<void> =>
    putDraft(id, { doc: state.doc, tuning: state.tuning })
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

  const stopPlaying = () => {
    playing = false;
    video.pause();
  };

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
  video.addEventListener("pause", () => {
    if (!playing) return;
    playing = false;
    renderFrame();
  });
  video.addEventListener("ended", () => {
    endStroke();
    playing = false;
    renderFrame();
  });

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    ev.preventDefault();
    if (playing) stopPlaying();
    if (state.selected === null || state.stroke !== null || state.frame >= clip.frameCount - 1) return;
    canvas.setPointerCapture(ev.pointerId);
    pointer = toTemplatePx(ev);
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

  const togglePlayResult = () => {
    if (state.stroke !== null) return;
    if (playing) {
      stopPlaying();
      renderFrame();
      return;
    }
    playing = true;
    video.playbackRate = 1;
    video.currentTime = 0;
    dispatch({ kind: "seek", frame: 0 });
    void video.play();
  };
  playButton.addEventListener("click", togglePlayResult);
  speed.addEventListener("change", () => speed.blur());
  lag.input.addEventListener("input", () => dispatch({ kind: "tune", tuning: { lagMs: Number(lag.input.value) } }));
  smoothing.input.addEventListener("input", () => dispatch({ kind: "tune", tuning: { smoothRadius: Number(smoothing.input.value) } }));
  titleInput.addEventListener("input", () => dispatch({ kind: "retitle", title: titleInput.value }));
  const addSubject = () => {
    dispatch({ kind: "addSubject" });
    const added = state.selected === null ? undefined : laneNodes.get(state.selected);
    added?.name.focus();
    added?.name.select();
  };
  addButton.addEventListener("click", addSubject);
  emptyAdd.addEventListener("click", addSubject);
  const toggleErase = () => {
    eraseToggle = !eraseToggle;
    renderFrame();
  };
  eraseButton.addEventListener("click", toggleErase);
  smallerButton.addEventListener("click", () => dispatch({ kind: "resize", steps: -1 }));
  biggerButton.addEventListener("click", () => dispatch({ kind: "resize", steps: 1 }));
  clearButton.addEventListener("click", () => {
    if (state.selected !== null) dispatch({ kind: "clearSubject", id: state.selected });
  });
  deleteButton.addEventListener("click", () => {
    if (state.selected !== null) dispatch({ kind: "deleteSubject", id: state.selected });
  });
  undoButton.addEventListener("click", () => dispatch({ kind: "undo" }));
  redoButton.addEventListener("click", () => dispatch({ kind: "redo" }));

  const onAlt = (ev: KeyboardEvent) => {
    if (ev.key !== "Alt" || altHeld === (ev.type === "keydown")) return;
    altHeld = ev.type === "keydown";
    renderFrame();
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
    switch (ev.key) {
      case " ":
        ev.preventDefault();
        togglePlayResult();
        return;
      case "ArrowLeft":
      case "ArrowRight":
        if (state.stroke !== null) return;
        ev.preventDefault();
        stopPlaying();
        dispatch({ kind: "step", delta: ev.key === "ArrowLeft" ? -1 : 1 });
        return;
      case "+":
      case "=":
      case "-":
        dispatch({ kind: "resize", steps: ev.key === "-" ? -1 : 1 });
        return;
      case "e":
      case "E":
        toggleErase();
        return;
    }
  };
  document.addEventListener("keydown", onKey);
  document.addEventListener("keyup", onAlt);

  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    await flush();
    try {
      await save(id, saveBody(state, runs));
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
