import { type AuthoringView, type SubjectDoc, type SubjectTrack, ServerNotAnswering, clipUrl, getAuthoring, putAuthoring, save } from "./authoring.ts";
import { el } from "./dom.ts";
import { loadLabelFont, paintFrame } from "./labels.ts";
import { type Action, type EditorState, editorState, keyframeAt, labelsOf, modeOf, pathLines, reduce, shotAt, toTemplate } from "./subjects.ts";
import { type SubjectId, type Template, type TemplateId, frameIndexAt, placementAt } from "./template.ts";

const POLL_MS = 500;
const SAVE_DEBOUNCE_MS = 300;
const SVG_NS = "http://www.w3.org/2000/svg";

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

const PLAY = "M7 4l13 8-13 8z";
const PAUSE = "M6 4h4v16H6zM14 4h4v16h-4z";
const GHOST_ALPHA = 0.2;

const isPending = (t: SubjectTrack | undefined) => t?.segments.some((g) => g.status === "queued" || g.status === "running") ?? false;

const displayName = (s: SubjectDoc) => (s.name.trim() === "" ? "this subject" : s.name);

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function shortcutButton(label: string, key: string, className: string): HTMLButtonElement {
  return el("button", { type: "button", className, ariaKeyShortcuts: key }, label, " ", el("kbd", {}, key));
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

const busy = (view: AuthoringView) => [...view.tracks.values()].some((t) => t.segments.some((s) => s.status === "queued" || s.status === "running"));

function saveBlocker(view: AuthoringView, subjects: readonly SubjectDoc[], dirty: boolean): string | null {
  if (dirty || busy(view)) return "Wait until every segment is tracked";
  const failed = [...view.tracks.values()].flatMap((t) => t.segments).find((s) => s.status === "failed");
  if (failed?.status === "failed") return `A segment failed to track: ${failed.message}. Click again to retry.`;
  const placed = subjects.filter((s) => (view.tracks.get(s.id)?.runs.length ?? 0) > 0);
  if (placed.length === 0) return "Click the video to place a subject first";
  if (placed.some((s) => s.name.trim() === "")) return "Every placed subject needs a name";
  return null;
}

export function mountSubjectEditor(container: HTMLElement, id: TemplateId, initial: AuthoringView): { destroy(): void } {
  let view = initial;
  let state: EditorState = editorState({ title: initial.title, subjects: initial.subjects });
  const settled = new Map<SubjectId, SubjectTrack>();
  const rememberSettled = (v: AuthoringView) => {
    for (const [sid, t] of v.tracks) if (!isPending(t)) settled.set(sid, t);
  };
  rememberSettled(initial);
  let alive = true;
  let dirty = false;
  let lastPutRev = -1;
  let putTimer = 0;
  let pollTimer = 0;
  let inflight: Promise<void> = Promise.resolve();
  let frameRequest: number | null = null;
  const pct = (f: number) => `${(100 * f) / view.frameCount}%`;

  const titleInput = el("input", { id: "tpl-title", className: "title-input", value: state.doc.title, maxLength: 200, autocomplete: "off" });
  const saveButton = el("button", { type: "button", className: "save" }, "Save");
  const undoButton = el("button", { type: "button", className: "history", ariaKeyShortcuts: isMac ? "Meta+Z" : "Control+Z", title: isMac ? "Undo (⌘Z)" : "Undo (Ctrl+Z)" }, "Undo");
  const redoButton = el("button", { type: "button", className: "history", ariaKeyShortcuts: isMac ? "Shift+Meta+Z" : "Shift+Control+Z", title: isMac ? "Redo (⇧⌘Z)" : "Redo (Shift+Ctrl+Z)" }, "Redo");
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
  const canvas = el("canvas", { className: "editor-canvas", width: view.width, height: view.height });
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("2D canvas is not available");
  const playButton = el("button", { type: "button", className: "play", ariaLabel: "Play" }, icon(PLAY));
  const timecode = el("span", { className: "timecode" });
  const hint = el("span", { className: "editor-hint" });
  const status = el("p", { className: "editor-status", role: "status" });
  const notice = el("p", { className: "editor-notice", role: "status" });
  const emptyAdd = el("button", { type: "button", className: "add-first" }, "+ Add subject");
  const emptyPrompt = el("div", { className: "empty-prompt" }, el("p", {}, "Add the first thing to label"), emptyAdd);
  const banner = el("p", { className: "stage-banner", role: "status" });
  const stage = el("div", { className: "stage" }, video, canvas, emptyPrompt, banner);
  const actionsName = el("strong", { className: "actions-name" });
  const hideButton = shortcutButton("Hide from here", "H", "action hide");
  const removeButton = shortcutButton("Remove this point", "Delete", "action remove");
  const deleteButton = el("button", { type: "button", className: "action delete" }, "Delete subject");
  const actions = el("div", { className: "subject-actions", ariaLabel: "Selected subject" }, actionsName, hideButton, removeButton, deleteButton);
  const lanes = el("div", { className: "lanes" });
  const overlay = el("div", { className: "timeline-overlay" });
  const playhead = el("div", { className: "playhead" });
  const addButton = el("button", { type: "button", className: "add-subject" }, "+ Add subject");
  const timeline = el("section", { className: "timeline", ariaLabel: "Subjects timeline" }, lanes, el("div", { className: "lane add-row" }, addButton), overlay);

  container.append(
    bar,
    stage,
    el("div", { className: "transport" }, playButton, timecode, hint),
    actions,
    status,
    notice,
    timeline,
  );

  const template = (): Template => toTemplate(view, state.doc, id, clipUrl(id));
  const selectedDoc = () => state.doc.subjects.find((s) => s.id === state.selected) ?? null;

  const strokeTrack = (t: Template, s: SubjectDoc, alpha: number) => {
    const scale = view.width / 1280;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.45 * alpha;
    ctx.lineWidth = 5 * scale;
    for (const line of pathLines(t, s.id, state.frame)) {
      ctx.beginPath();
      line.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
    }
    ctx.globalAlpha = alpha;
    const subject = t.subjects.find((x) => x.id === s.id);
    const placement = subject === undefined ? null : placementAt(subject, state.frame, t);
    if (placement !== null) {
      ctx.lineWidth = 4 * scale;
      ctx.setLineDash([14 * scale, 10 * scale]);
      const { x, y, w, h } = placement.box;
      ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();
  };

  const paint = () => {
    const t = template();
    const frame = state.frame;
    paintFrame(ctx, (c) => c.drawImage(video, 0, 0, view.width, view.height), t, labelsOf(state.doc), frame);
    const s = selectedDoc();
    if (s !== null) {
      const scale = view.width / 1280;
      const previous = settled.get(s.id);
      if (previous !== undefined && isPending(view.tracks.get(s.id))) {
        strokeTrack(toTemplate({ ...view, tracks: new Map([[s.id, previous]]) }, state.doc, id, clipUrl(id)), s, GHOST_ALPHA);
      }
      strokeTrack(t, s, 1);
      ctx.save();
      const [start, end] = shotAt(view.cuts, view.frameCount, frame);
      for (const k of s.keyframes) {
        if (!("point" in k) || k.frame < start || k.frame >= end) continue;
        ctx.beginPath();
        ctx.fillStyle = k.frame === frame ? "#ffffff" : s.color;
        ctx.arc(k.point[0], k.point[1], 7 * scale, 0, 2 * Math.PI);
        ctx.fill();
        ctx.lineWidth = 2 * scale;
        ctx.strokeStyle = "#0f1013";
        ctx.stroke();
      }
      ctx.restore();
    }
    canvas.dataset.frame = String(frame);
  };

  const renderFrame = () => {
    paint();
    renderMode();
    timecode.replaceChildren(clock(state.frame / view.fps), el("span", { className: "muted" }, ` / ${clock(view.frameCount / view.fps)}`));
    playhead.style.left = pct(state.frame + 0.5);
  };

  const renderMode = () => {
    const mode = modeOf(state, view);
    stage.dataset.mode = mode.kind;
    emptyPrompt.hidden = mode.kind !== "empty";
    actions.hidden = mode.kind === "empty";
    switch (mode.kind) {
      case "empty":
        banner.hidden = true;
        hint.textContent = "";
        break;
      case "placing":
        banner.hidden = false;
        banner.replaceChildren("Click ", coloured(displayName(mode.subject), mode.subject.color), " in the video");
        hint.textContent = "";
        break;
      case "tracking":
        banner.hidden = false;
        banner.replaceChildren("Tracking ", coloured(displayName(mode.subject), mode.subject.color), `… ${mode.percent}%`);
        hint.textContent = "You can keep working while it tracks";
        break;
      case "idle":
        banner.hidden = true;
        hint.replaceChildren("Click ", coloured(displayName(mode.subject), mode.subject.color), " again to correct its path");
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
      removeButton.disabled = keyframeAt(s, state.frame) === undefined;
    }
    undoButton.disabled = state.past.length === 0;
    redoButton.disabled = state.future.length === 0;
  };

  const coloured = (text: string, color: string) => {
    const b = el("strong", {}, text);
    b.style.color = color;
    return b;
  };

  const renderSave = () => {
    const blocker = saveBlocker(view, state.doc.subjects, dirty);
    saveButton.disabled = blocker !== null;
    saveButton.title = blocker ?? "Write the template and open it";
  };

  const showNotice = (text: string) => {
    const undo = el("button", { type: "button", className: "notice-undo" }, "Undo");
    undo.addEventListener("click", () => dispatch({ kind: "undo" }));
    notice.replaceChildren(text, " ", undo);
  };

  const laneNodes = new Map<SubjectId, { lane: HTMLElement; name: HTMLInputElement; track: HTMLElement }>();

  const seekFromPointer = (track: HTMLElement, ev: PointerEvent) => {
    const rect = track.getBoundingClientRect();
    dispatch({ kind: "seek", frame: Math.floor(((ev.clientX - rect.left) / rect.width) * view.frameCount) });
  };

  const laneFor = (s: SubjectDoc, index: number) => {
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
      if ((ev.target as Element).closest("button.key") !== null) return;
      track.setPointerCapture(ev.pointerId);
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
      const t = view.tracks.get(s.id);
      const bars = (t?.runs ?? []).map((r) => {
        const b = el("div", { className: "bar" });
        b.style.left = pct(r.from);
        b.style.width = pct(r.boxes.length);
        return b;
      });
      const segs = (t?.segments ?? [])
        .filter((g) => g.status !== "done")
        .map((g) => {
          const fill = el("div", { className: "seg-fill" });
          const seg = el("div", { className: "seg" }, fill);
          seg.dataset.status = g.status;
          seg.dataset.key = g.key;
          seg.style.left = pct(g.from);
          seg.style.width = pct(g.to - g.from);
          if (g.status === "running") fill.style.width = g.total === null ? "0%" : `${(100 * g.done) / g.total}%`;
          if (g.status === "failed") seg.title = g.message;
          return seg;
        });
      const keys = s.keyframes.map((k) => {
        const key = el("button", { type: "button", className: "hidden" in k ? "key hollow" : "key", ariaLabel: `${s.name || s.id} keyframe at frame ${k.frame}${"hidden" in k ? " (hidden from here)" : ""}` });
        key.dataset.frame = String(k.frame);
        key.style.left = pct(k.frame + 0.5);
        key.addEventListener("click", () => {
          dispatch({ kind: "select", id: s.id });
          dispatch({ kind: "seek", frame: k.frame });
        });
        return key;
      });
      track.replaceChildren(...bars, ...segs, ...keys);
      if (lanes.children[i] !== lane) lanes.insertBefore(lane, lanes.children[i] ?? null);
    });
    overlay.hidden = state.doc.subjects.length === 0;
    overlay.replaceChildren(
      ...view.cuts.map((c) => {
        const line = el("div", { className: "cut" });
        line.style.left = pct(c);
        return line;
      }),
      playhead,
    );
    renderSave();
  };

  const applyView = (next: AuthoringView) => {
    if (!alive || next.rev < lastPutRev) return;
    view = next;
    rememberSettled(next);
    status.textContent = "";
    renderLanes();
    renderFrame();
  };

  const flush = (): Promise<void> => {
    clearTimeout(putTimer);
    if (!dirty) return inflight;
    dirty = false;
    const doc = state.doc;
    inflight = inflight
      .then(() => putAuthoring(id, doc.title, doc.subjects))
      .then((v) => {
        lastPutRev = Math.max(lastPutRev, v.rev);
        applyView(v);
      })
      .catch((e: unknown) => {
        dirty = true;
        status.textContent = `Could not save the subjects: ${message(e)}`;
        putTimer = window.setTimeout(() => void flush(), 2000);
      });
    return inflight;
  };

  const poll = () => {
    pollTimer = window.setTimeout(async () => {
      if (!alive) return;
      if (busy(view) && !dirty) {
        try {
          applyView(await getAuthoring(id));
        } catch (e) {
          status.textContent = e instanceof ServerNotAnswering ? "The authoring server is not answering. Tracking resumes when it starts again." : message(e);
        }
      }
      poll();
    }, POLL_MS);
  };

  function dispatch(a: Action) {
    const prev = state;
    state = reduce(state, a, view.frameCount);
    if (state.doc !== prev.doc) {
      const deleted = a.kind === "deleteSubject" ? prev.doc.subjects.find((x) => x.id === a.id) : undefined;
      if (deleted === undefined) notice.replaceChildren();
      else showNotice(`Deleted ${displayName(deleted)}.`);
      dirty = true;
      clearTimeout(putTimer);
      putTimer = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    }
    if (state.doc !== prev.doc || state.selected !== prev.selected) renderLanes();
    if (state.frame !== prev.frame && (a.kind === "seek" || a.kind === "step")) {
      video.currentTime = (state.frame + 0.1) / view.fps;
    }
    renderFrame();
  }

  const onVideoFrame: VideoFrameRequestCallback = (_now, metadata) => {
    if (!video.paused) {
      state = { ...state, frame: frameIndexAt(metadata.mediaTime, view) };
      renderFrame();
    } else paint();
    frameRequest = video.requestVideoFrameCallback(onVideoFrame);
  };
  frameRequest = video.requestVideoFrameCallback(onVideoFrame);
  video.addEventListener("loadeddata", paint);
  video.addEventListener("seeked", paint);
  const syncPlay = () => {
    playButton.replaceChildren(icon(video.paused ? PLAY : PAUSE));
    playButton.ariaLabel = video.paused ? "Play" : "Pause";
  };
  video.addEventListener("play", syncPlay);
  video.addEventListener("pause", syncPlay);
  const togglePlay = () => {
    if (video.paused) void video.play();
    else video.pause();
  };
  playButton.addEventListener("click", togglePlay);

  canvas.addEventListener("click", (ev) => {
    const rect = canvas.getBoundingClientRect();
    video.pause();
    dispatch({ kind: "place", point: [((ev.clientX - rect.left) * canvas.width) / rect.width, ((ev.clientY - rect.top) * canvas.height) / rect.height] });
  });
  titleInput.addEventListener("input", () => dispatch({ kind: "retitle", title: titleInput.value }));
  const addSubject = () => {
    dispatch({ kind: "addSubject" });
    const added = state.selected === null ? undefined : laneNodes.get(state.selected);
    added?.name.select();
  };
  addButton.addEventListener("click", addSubject);
  emptyAdd.addEventListener("click", addSubject);
  const hide = () => {
    video.pause();
    dispatch({ kind: "hide" });
  };
  hideButton.addEventListener("click", hide);
  removeButton.addEventListener("click", () => dispatch({ kind: "removeKey" }));
  deleteButton.addEventListener("click", () => {
    if (state.selected !== null) dispatch({ kind: "deleteSubject", id: state.selected });
  });
  undoButton.addEventListener("click", () => dispatch({ kind: "undo" }));
  redoButton.addEventListener("click", () => dispatch({ kind: "redo" }));

  const onKey = (ev: KeyboardEvent) => {
    const target = ev.target as HTMLElement | null;
    if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      dispatch({ kind: ev.shiftKey ? "redo" : "undo" });
      return;
    }
    switch (ev.key) {
      case " ":
        ev.preventDefault();
        togglePlay();
        return;
      case "ArrowLeft":
      case "ArrowRight":
        ev.preventDefault();
        video.pause();
        dispatch({ kind: "step", delta: ev.key === "ArrowLeft" ? -1 : 1 });
        return;
      case "h":
      case "H":
        hide();
        return;
      case "Delete":
      case "Backspace":
        ev.preventDefault();
        dispatch({ kind: "removeKey" });
        return;
    }
  };
  document.addEventListener("keydown", onKey);

  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    await flush();
    try {
      await save(id);
      location.hash = `#/t/${id}`;
    } catch (e) {
      status.textContent = message(e);
      renderSave();
    }
  });

  renderLanes();
  renderFrame();
  poll();
  void loadLabelFont(new URL(import.meta.env.BASE_URL, location.href).href).then(() => alive && paint());

  return {
    destroy() {
      alive = false;
      clearTimeout(putTimer);
      clearTimeout(pollTimer);
      void flush();
      document.removeEventListener("keydown", onKey);
      if (frameRequest !== null) video.cancelVideoFrameCallback(frameRequest);
      video.pause();
      video.removeAttribute("src");
      video.load();
    },
  };
}
