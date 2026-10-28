import {
  type Range,
  type View,
  STEP_SECONDS,
  canZoomIn,
  dragEnd,
  dragStart,
  fitView,
  formatTime,
  initialRange,
  initialView,
  isAtMax,
  isFitView,
  isZoomed,
  maxLength,
  moveWindow,
  panView,
  parseTime,
  revealInView,
  setIn,
  setOut,
  setView,
  snap,
  wholeView,
  zoomView,
} from "./clip-model.ts";
import { el } from "./dom.ts";

const TRACK_PAD = 16;
const NOTE_MS = 2500;
const LOOP_GUARD_SECONDS = 0.03;
const EDGE_PX = 24;
const AUTOSCROLL_FRACTION = 0.02;
const FINE_DRAG = 0.1;
const RULER_STEPS = [0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const RULER_MIN_LABEL_PX = 80;

export interface Trimmer {
  readonly node: HTMLElement;
  readonly range: () => Range;
}

interface TrimmerOptions {
  readonly src: string;
  readonly duration: number;
  readonly current: Range | null;
  readonly onChange: (range: Range) => void;
  readonly globalKeys: boolean;
}

type Handle = "start" | "end";
type DragKind = Handle | "move" | "scrub";

interface Drag {
  readonly kind: DragKind;
  x0: number;
  anchor: number;
  fine: boolean;
  clientX: number;
  edge: -1 | 0 | 1;
  pinned: boolean;
}

const div = (className: string, ...children: (Node | string)[]) => el("div", { className }, ...children);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function svgIcon(className: string, path: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}

const PLAY_PATH = "M6 4l14 8-14 8z";
const PAUSE_PATH = "M6 4h4v16H6zM14 4h4v16h-4z";

export function mountTrimmer(options: TrimmerOptions): Trimmer {
  const { duration, globalKeys } = options;
  const limit = maxLength(duration);
  let range = initialRange(duration, options.current);
  let view: View = initialView(range, duration);
  let head = range.start;
  let playing = false;
  let drag: Drag | null = null;
  let noteTimer = 0;

  const video = el("video", { src: options.src, preload: "auto", className: "source-video" });
  video.playsInline = true;
  const timecode = div("trim-tc");
  const bigPlay = div("trim-big", el("span", {}, svgIcon("", PLAY_PATH)));
  const stage = div("trim-stage", video, bigPlay, timecode);
  const videoError = el("p", { className: "field-error" });

  const playButton = el("button", { type: "button", className: "trim-play" });
  const ruler = div("trim-ruler");
  const dimLeft = div("trim-dim");
  const dimRight = div("trim-dim");
  const reachLabel = el("b");
  const reach = div("trim-reach", reachLabel);
  const startHandle = el("div", { className: "trim-handle start", tabIndex: 0, ariaLabel: "Clip start" });
  const endHandle = el("div", { className: "trim-handle end", tabIndex: 0, ariaLabel: "Clip end" });
  startHandle.setAttribute("role", "slider");
  endHandle.setAttribute("role", "slider");
  const selection = el("div", { className: "trim-sel", tabIndex: 0, ariaLabel: "Selected clip. Arrow keys move the whole clip." }, startHandle, endHandle);
  selection.setAttribute("role", "group");
  const playhead = div("trim-head");
  const track = div("trim-track", dimLeft, dimRight, reach, selection, playhead);
  const overviewMark = div("trim-mark");
  const overviewThumb = div("trim-thumb");
  const overview = div("trim-overview", overviewMark, overviewThumb);
  const timeline = div("trim-timeline", ruler, track, overview);

  const timeInput = (id: string) => el("input", { id, type: "text", inputMode: "decimal", autocomplete: "off", className: "trim-time" });
  const startInput = timeInput("clip-start");
  const endInput = timeInput("clip-end");
  const lengthText = el("strong");
  const lengthLimit = el("small");
  const meterFill = el("i");
  const note = el("div", { className: "trim-note", role: "status" });
  const length = div("trim-length", lengthText, div("trim-meter", meterFill), note);
  const button = (label: string, text: string) => el("button", { type: "button", ariaLabel: label }, text);
  const zoomOutButton = button("Zoom out", "−");
  const zoomInButton = button("Zoom in", "+");
  const zoomFitButton = el("button", { type: "button" }, "Zoom to clip");
  const zoomAllButton = el("button", { type: "button" }, "Whole video");
  const readout = div(
    "trim-readout",
    div("trim-field", el("label", { htmlFor: startInput.id }, "Start"), startInput),
    length,
    div("trim-field", el("label", { htmlFor: endInput.id }, "End"), endInput),
    div("trim-zoom", zoomOutButton, zoomInButton, zoomFitButton, zoomAllButton),
  );
  const key = (k: string) => el("kbd", {}, k);
  const keys = el(
    "p",
    { className: "trim-keys" },
    key("Space"),
    " play the clip on a loop · ",
    key("I"),
    " start here · ",
    key("O"),
    " end here · ",
    key("←"),
    key("→"),
    " step 0.1 s (",
    key("Shift"),
    " 1 s) · hold ",
    key("Shift"),
    " while dragging for fine control · ",
    key("Z"),
    " zoom to clip",
  );
  const node = div("trimmer loading", stage, videoError, div("trim-row", playButton, timeline), readout, keys);

  const pps = () => track.clientWidth / (view.to - view.from);
  const xOf = (t: number) => (t - view.from) * pps();
  const tOf = (clientX: number) => view.from + (clientX - track.getBoundingClientRect().left) / pps();

  const say = (text: string) => {
    note.textContent = text;
    clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => {
      note.textContent = "";
    }, NOTE_MS);
  };

  const place = (target: HTMLElement, left: number, width: number) => {
    target.style.left = `${left}px`;
    target.style.width = `${Math.max(0, width)}px`;
  };

  function renderRuler() {
    const major = RULER_STEPS.find((s) => s * pps() >= RULER_MIN_LABEL_PX) ?? 300;
    const divisor = major === 0.1 ? 1 : major === 15 || major === 30 ? 3 : major === 2 ? 2 : 5;
    const minor = major / divisor;
    const ticks: HTMLElement[] = [];
    for (let t = Math.ceil(view.from / minor) * minor; t <= view.to + 1e-6; t += minor) {
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      const tick = el("i", { className: isMajor ? "" : "minor" }, isMajor ? formatTime(t).replace(/\.0$/, "") : "");
      tick.style.left = `${TRACK_PAD + xOf(t)}px`;
      ticks.push(tick);
    }
    ruler.replaceChildren(...ticks);
  }

  function renderHead() {
    const x = xOf(head);
    playhead.style.display = x < 0 || x > track.clientWidth ? "none" : "block";
    playhead.style.left = `${x}px`;
    timecode.textContent = formatTime(head);
  }

  function render() {
    const width = track.clientWidth;
    const xs = xOf(range.start);
    const xe = xOf(range.end);
    place(selection, xs, xe - xs);
    place(dimLeft, 0, clamp(xs, 0, width));
    place(dimRight, clamp(xe, 0, width), width - clamp(xe, 0, width));
    for (const [handle, t] of [[startHandle, range.start], [endHandle, range.end]] as const) {
      handle.setAttribute("aria-valuemin", "0");
      handle.setAttribute("aria-valuemax", String(duration));
      handle.setAttribute("aria-valuenow", String(t));
      handle.setAttribute("aria-valuetext", formatTime(t));
    }
    const len = range.end - range.start;
    lengthText.textContent = `${len.toFixed(1)} s `;
    lengthLimit.textContent = `of ${trim(limit)} s max`;
    lengthText.append(lengthLimit);
    length.classList.toggle("max", isAtMax(range, duration));
    meterFill.style.width = `${(len / limit) * 100}%`;
    if (document.activeElement !== startInput) startInput.value = formatTime(range.start);
    if (document.activeElement !== endInput) endInput.value = formatTime(range.end);
    const zoomed = isZoomed(view, duration);
    node.classList.toggle("zoomed", zoomed);
    node.classList.toggle("playing", playing);
    playButton.replaceChildren(svgIcon(playing ? "pause" : "go", playing ? PAUSE_PATH : PLAY_PATH));
    playButton.ariaLabel = playing ? "Pause" : "Play the clip";
    const w = overview.clientWidth;
    place(overviewThumb, (view.from / duration) * w, ((view.to - view.from) / duration) * w);
    place(overviewMark, (range.start / duration) * w, (len / duration) * w);
    zoomAllButton.disabled = !zoomed;
    zoomOutButton.disabled = !zoomed;
    zoomInButton.disabled = !canZoomIn(view, duration);
    renderRuler();
    renderHead();
  }

  let seeking = false;
  let pending: number | null = null;
  function flushSeek() {
    if (pending === null || video.readyState < 1) return;
    seeking = true;
    video.currentTime = pending;
    pending = null;
  }
  function seek(t: number) {
    head = clamp(t, 0, duration);
    pending = head;
    if (!seeking) flushSeek();
  }
  video.addEventListener("seeked", () => {
    seeking = false;
    flushSeek();
  });
  video.addEventListener("loadedmetadata", () => {
    node.classList.remove("loading");
    flushSeek();
  });
  video.addEventListener("error", () => {
    node.classList.remove("loading");
    videoError.textContent = "The video could not be loaded.";
  });
  video.addEventListener("ended", () => {
    if (!playing) return;
    video.currentTime = range.start;
    void video.play();
  });

  function pause() {
    video.pause();
    playing = false;
    render();
  }
  function play() {
    if (head < range.start || head >= range.end - 0.05) seek(range.start);
    playing = true;
    render();
    video.play().catch(() => {
      playing = false;
      render();
    });
  }
  const togglePlay = () => (playing ? pause() : play());

  const commit = (next: Range) => {
    range = next;
    options.onChange(range);
  };
  const reveal = (t: number) => {
    view = revealInView(view, t, duration);
  };

  function applyDrag(d: Drag, clientX: number) {
    const dt = ((clientX - d.x0) / pps()) * (d.fine ? FINE_DRAG : 1);
    const target = d.anchor + dt;
    if (d.kind === "start") {
      commit(dragStart(range, target, duration));
      d.pinned = Math.abs(range.start - snap(target)) > 1e-6;
      seek(range.start);
    } else if (d.kind === "end") {
      commit(dragEnd(range, target, duration));
      d.pinned = Math.abs(range.end - snap(target)) > 1e-6;
      seek(range.end);
    } else if (d.kind === "move") {
      commit(moveWindow(range, target, duration));
      seek(range.start);
    }
    const atLimit = d.pinned && isAtMax(range, duration);
    startHandle.classList.toggle("hit", atLimit && d.kind === "start");
    endHandle.classList.toggle("hit", atLimit && d.kind === "end");
    const showReach = d.kind === "start" || d.kind === "end";
    reach.classList.toggle("on", showReach);
    if (showReach) {
      const from = d.kind === "start" ? Math.max(0, range.end - limit) : range.start;
      const to = d.kind === "start" ? range.end : Math.min(duration, range.start + limit);
      place(reach, xOf(from), xOf(to) - xOf(from));
      reachLabel.textContent = `${trim(limit)} s max`;
    }
  }

  function beginDrag(kind: DragKind, ev: PointerEvent, owner: HTMLElement) {
    ev.preventDefault();
    if (kind !== "scrub" && playing) pause();
    const anchor = kind === "end" ? range.end : range.start;
    drag = { kind, x0: ev.clientX, anchor, fine: ev.shiftKey, clientX: ev.clientX, edge: 0, pinned: false };
    owner.setPointerCapture(ev.pointerId);
    if (kind === "start") startHandle.focus();
    if (kind === "end") endHandle.focus();
    if (kind === "move") selection.classList.add("dragging");
    if (kind === "scrub") {
      seek(tOf(ev.clientX));
      render();
    }
  }

  function dragMove(ev: PointerEvent) {
    const d = drag;
    if (d === null || track.clientWidth === 0) return;
    d.clientX = ev.clientX;
    if (d.kind === "scrub") {
      seek(tOf(ev.clientX));
      render();
      return;
    }
    if (ev.shiftKey !== d.fine) {
      d.fine = ev.shiftKey;
      d.x0 = ev.clientX;
      d.anchor = d.kind === "end" ? range.end : range.start;
    }
    const box = track.getBoundingClientRect();
    const px = ev.clientX - box.left;
    d.edge = px < EDGE_PX ? -1 : px > box.width - EDGE_PX ? 1 : 0;
    applyDrag(d, ev.clientX);
    render();
  }

  function dragStop() {
    if (drag !== null && drag.kind !== "scrub") {
      reveal(drag.kind === "end" ? range.end : range.start);
      render();
    }
    drag = null;
    reach.classList.remove("on");
    startHandle.classList.remove("hit");
    endHandle.classList.remove("hit");
    selection.classList.remove("dragging");
  }

  const wire = (target: HTMLElement, down: (ev: PointerEvent) => void) => {
    target.addEventListener("pointerdown", down);
    target.addEventListener("pointermove", dragMove);
    target.addEventListener("pointerup", dragStop);
    target.addEventListener("pointercancel", dragStop);
  };
  wire(startHandle, (ev) => beginDrag("start", ev, startHandle));
  wire(endHandle, (ev) => beginDrag("end", ev, endHandle));
  wire(selection, (ev) => {
    if (ev.target === selection) beginDrag("move", ev, selection);
  });
  wire(track, (ev) => {
    if (ev.target === track || ev.target === dimLeft || ev.target === dimRight) beginDrag("scrub", ev, track);
  });

  overviewThumb.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const x0 = ev.clientX;
    const from0 = view.from;
    const span = view.to - view.from;
    overviewThumb.setPointerCapture(ev.pointerId);
    const move = (m: PointerEvent) => {
      const from = from0 + ((m.clientX - x0) / overview.clientWidth) * duration;
      view = setView(from, from + span, duration);
      render();
    };
    const up = () => {
      overviewThumb.removeEventListener("pointermove", move);
      overviewThumb.removeEventListener("pointerup", up);
    };
    overviewThumb.addEventListener("pointermove", move);
    overviewThumb.addEventListener("pointerup", up);
  });

  timeline.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) view = zoomView(view, Math.exp(ev.deltaY * 0.01), tOf(ev.clientX), duration);
      else view = panView(view, (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY) / pps(), duration);
      render();
    },
    { passive: false },
  );

  playButton.addEventListener("click", togglePlay);
  stage.addEventListener("click", togglePlay);
  const zoom = (factor: number) => {
    view = zoomView(view, factor, (view.from + view.to) / 2, duration);
    render();
  };
  zoomInButton.addEventListener("click", () => zoom(0.5));
  zoomOutButton.addEventListener("click", () => zoom(2));
  zoomFitButton.addEventListener("click", () => {
    view = fitView(range, duration);
    render();
  });
  zoomAllButton.addEventListener("click", () => {
    view = wholeView(duration);
    render();
  });

  for (const [input, handle] of [[startInput, "start"], [endInput, "end"]] as const) {
    const current = () => (handle === "start" ? range.start : range.end);
    const apply = () => {
      const t = parseTime(input.value);
      if (t !== null) {
        const pull = handle === "start" ? setIn(range, t, duration) : setOut(range, t, duration);
        commit(pull.range);
        if (pull.pulled !== null) say(`${pull.pulled === "end" ? "End" : "Start"} moved to keep the clip at ${trim(limit)} s`);
        reveal(current());
        seek(current());
      }
      input.classList.remove("bad");
      input.value = formatTime(current());
      render();
    };
    input.addEventListener("input", () => input.classList.toggle("bad", parseTime(input.value) === null));
    input.addEventListener("change", apply);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        apply();
        input.blur();
      }
      ev.stopPropagation();
    });
  }

  function nudge(kind: DragKind, dt: number) {
    if (kind === "start") {
      commit(dragStart(range, range.start + dt, duration));
      seek(range.start);
      reveal(range.start);
    } else if (kind === "end") {
      commit(dragEnd(range, range.end + dt, duration));
      seek(range.end);
      reveal(range.end);
    } else if (kind === "move") {
      commit(moveWindow(range, range.start + dt, duration));
      seek(range.start);
      reveal(range.start);
    } else {
      seek(head + dt);
      reveal(head);
    }
    render();
  }

  function mark(handle: Handle) {
    const pull = handle === "start" ? setIn(range, head, duration) : setOut(range, head, duration);
    commit(pull.range);
    if (pull.pulled !== null) say(`${pull.pulled === "end" ? "End" : "Start"} moved to keep the clip at ${trim(limit)} s`);
    reveal(handle === "start" ? range.start : range.end);
    render();
  }

  function onKey(ev: KeyboardEvent): boolean {
    const target = ev.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return false;
    if (ev.metaKey || ev.ctrlKey || ev.altKey || !node.checkVisibility()) return false;
    const interactive = target instanceof HTMLButtonElement || (target instanceof HTMLElement && target.tagName === "SUMMARY");
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      const step = (ev.shiftKey ? 1 : STEP_SECONDS) * (ev.key === "ArrowLeft" ? -1 : 1);
      nudge(target === startHandle ? "start" : target === endHandle ? "end" : target === selection ? "move" : "scrub", step);
      return true;
    }
    switch (ev.key.toLowerCase()) {
      case " ":
        if (interactive) return false;
        togglePlay();
        return true;
      case "i":
        mark("start");
        return true;
      case "o":
        mark("end");
        return true;
      case "z":
        view = isZoomed(view, duration) && isFitView(view, range, duration) ? wholeView(duration) : fitView(range, duration);
        render();
        return true;
      case "=":
      case "+":
        zoom(0.5);
        return true;
      case "-":
        zoom(2);
        return true;
      default:
        return false;
    }
  }
  const handleKey = (ev: KeyboardEvent) => {
    if (onKey(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };
  node.addEventListener("keydown", handleKey);
  const documentKey = (ev: KeyboardEvent) => {
    if (ev.target instanceof Node && node.contains(ev.target)) return;
    handleKey(ev);
  };
  if (globalKeys) document.addEventListener("keydown", documentKey);

  const isInView = (t: number) => t >= view.from && t <= view.to;
  let wasConnected = false;
  function frame() {
    if (node.isConnected) wasConnected = true;
    else if (wasConnected) {
      document.removeEventListener("keydown", documentKey);
      removeEventListener("resize", onResize);
      clearTimeout(noteTimer);
      video.pause();
      return;
    }
    if (playing) {
      if (video.currentTime >= range.end - LOOP_GUARD_SECONDS || video.currentTime < range.start - 0.5) video.currentTime = range.start;
      head = video.currentTime;
      renderHead();
    }
    const d = drag;
    if (d !== null && d.edge !== 0 && (d.kind === "start" || d.kind === "end") && (!d.pinned || !isInView(d.kind === "end" ? range.end : range.start))) {
      const before = view.from;
      const span = view.to - view.from;
      view = panView(view, span * AUTOSCROLL_FRACTION * d.edge, duration);
      const moved = view.from - before;
      if (moved !== 0) {
        d.anchor += moved;
        applyDrag(d, d.clientX);
        render();
      }
    }
    requestAnimationFrame(frame);
  }
  const onResize = () => render();
  addEventListener("resize", onResize);

  seek(range.start);
  render();
  requestAnimationFrame(frame);
  if (video.readyState >= 1) node.classList.remove("loading");

  return { node, range: () => range };
}
