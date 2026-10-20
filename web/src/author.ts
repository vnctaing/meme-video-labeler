import {
  ApiError,
  type Clip,
  type Destination,
  type Issue,
  type Job,
  type JobState,
  type People,
  type Person,
  type Running,
  ServerNotAnswering,
  type SourceFacts,
  type TrackCard,
  type TrackId,
  chooseClip,
  createJob,
  getJob,
  getPeople,
  ignored,
  listJobs,
  moveTrack,
  renamePerson,
  reopen,
  requestBuild,
  retry,
  savePeople,
  sourceUrl,
} from "./authoring.ts";
import { type View, el } from "./dom.ts";
import type { TemplateId } from "./template.ts";

const MAX_CLIP_SECONDS = 30;
const DEFAULT_LICENSE = "unknown, personal use";
const POLL_MS = 500;
const SAVE_DEBOUNCE_MS = 300;
const COLORS = ["#f5b800", "#2f7df6", "#3cc46a", "#e054d8", "#ff6a3d", "#20c4c4", "#a77bff", "#c9a36b"];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function header(title: string): HTMLElement {
  return el("header", {}, el("a", { className: "back", href: "#/" }, "← All clips"), el("h1", {}, title));
}

function stateLabel(state: JobState): string {
  return state.kind === "failed" ? `failed at ${state.step}` : state.kind;
}

export async function newView(): Promise<View> {
  const urlInput = el("input", { id: "source-url", type: "url", required: true, placeholder: "https://www.youtube.com/watch?v=…", autocomplete: "off" });
  const idInput = el("input", { id: "short-name", type: "text", placeholder: "derived from the video title", pattern: "[a-z0-9-]+", maxLength: 40, autocomplete: "off" });
  const urlError = el("p", { className: "field-error", id: "source-url-error" });
  const idError = el("p", { className: "field-error" });
  const submit = el("button", { type: "submit" }, "Fetch video");
  const form = el(
    "form",
    { className: "author-form" },
    el("div", { className: "field" }, el("label", { htmlFor: urlInput.id }, "YouTube link"), urlInput, urlError),
    el("div", { className: "field" }, el("label", { htmlFor: idInput.id }, "Short name (optional)"), idInput, idError),
    submit,
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    urlError.textContent = idError.textContent = "";
    submit.disabled = true;
    submit.textContent = "Checking the video…";
    try {
      const job = await createJob(urlInput.value, idInput.value.trim() === "" ? null : idInput.value.trim());
      location.hash = `#/new/${job.id}`;
    } catch (e) {
      (e instanceof ApiError && e.field === "id" ? idError : urlError).textContent = message(e);
      submit.disabled = false;
      submit.textContent = "Fetch video";
    }
  });

  const list = el("section", { className: "job-list" });
  try {
    const jobs = await listJobs();
    if (jobs.length > 0) {
      list.append(
        el("h2", {}, "Drafts"),
        el("ul", {}, ...jobs.map((j) => el("li", {}, el("a", { href: `#/new/${j.id}` }, j.id), " ", el("span", { className: `badge ${j.state.kind}` }, stateLabel(j.state))))),
      );
    }
  } catch (e) {
    list.append(el("p", { className: "field-error" }, `The authoring server is not answering (${message(e)}). Start it with npm run dev:author.`));
  }

  return {
    nodes: [header("New template"), el("main", { className: "author" }, form, list)],
    teardown: () => {},
  };
}

export async function jobView(id: TemplateId): Promise<View> {
  let job: Job | null = await getJob(id).catch((e: unknown) => {
    if (e instanceof ServerNotAnswering) return null;
    throw e;
  });
  let alive = true;
  let timer = 0;
  let teardownPanel: () => void = () => {};
  const title = el("h1", {}, id);
  const panel = el("main", { className: "author" });

  const show = (next: Job) => {
    const previous = job?.state.kind;
    job = next;
    if (previous === "building" && next.state.kind === "ready") {
      location.hash = `#/t/${id}`;
      return;
    }
    teardownPanel();
    const built = stepPanel(next, show);
    teardownPanel = built.teardown;
    panel.replaceChildren(built.node);
    schedule();
  };

  const schedule = () => {
    clearTimeout(timer);
    if (!alive || (job !== null && !isRunning(job.state))) return;
    timer = window.setTimeout(async () => {
      try {
        const next = await getJob(id);
        if (!alive) return;
        if (job === null || next.state.kind !== job.state.kind) show(next);
        else {
          job = next;
          updateProgress(panel, next);
          schedule();
        }
      } catch {
        if (alive) {
          updateProgress(panel, null);
          schedule();
        }
      }
    }, POLL_MS);
  };

  if (job === null) {
    panel.replaceChildren(el("section", { className: "progress-panel" }, el("p", { className: "progress-text", role: "status" }, progressText(null))));
    schedule();
  } else show(job);
  return {
    nodes: [el("header", {}, el("a", { className: "back", href: "#/new" }, "← New template"), title), panel],
    teardown: () => {
      alive = false;
      clearTimeout(timer);
      teardownPanel();
    },
  };
}

function isRunning(state: JobState): state is Running {
  return state.kind === "downloading" || state.kind === "tracking" || state.kind === "building";
}

interface Panel {
  readonly node: HTMLElement;
  readonly teardown: () => void;
}

const still = (node: HTMLElement): Panel => ({ node, teardown: () => {} });

function stepPanel(job: Job, show: (job: Job) => void): Panel {
  const state = job.state;
  switch (state.kind) {
    case "downloading":
    case "tracking":
    case "building":
      return still(progressPanel(job));
    case "downloaded":
      return still(clipPanel(job.id, state.source, null, show));
    case "tracked":
      return peoplePanel(job.id, state.source, state.clip, show);
    case "ready":
      return still(readyPanel(job.id, state.source, state.clip, show));
    case "failed":
      return still(failedPanel(job, state, show));
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function progressText(job: Job | null): string {
  if (job === null) return "The authoring server is not answering. It resumes this step when it starts again.";
  const p = job.progress;
  if (p?.status === "queued") return "Waiting for another job to finish";
  const done = p?.done ?? 0;
  const total = p?.total ?? null;
  switch (job.state.kind) {
    case "downloading": {
      const mb = (n: number) => (n / 1e6).toFixed(0);
      return total === null ? `Downloading ${mb(done)} MB` : `Downloading ${mb(done)} / ${mb(total)} MB`;
    }
    case "tracking":
      if (total === null || done === 0) return "Encoding the clip, finding cuts, loading the model";
      if (done >= total) return "Writing crop sheets";
      return `Tracking people: frame ${done} of ${total}`;
    case "building":
      return "Building the template";
    default:
      return job.state.kind;
  }
}

function progressPanel(job: Job): HTMLElement {
  const node = el(
    "section",
    { className: "progress-panel" },
    el("h2", {}, stepTitle(job.state)),
    el("p", { className: "progress-text", role: "status" }),
    el("progress", { max: 1 }),
    el("p", { className: "resumed" }),
  );
  updateProgress(node, job);
  return node;
}

function stepTitle(state: JobState): string {
  switch (state.kind) {
    case "downloading":
      return "1. Download";
    case "downloaded":
      return "2. Choose the clip";
    case "tracking":
      return "3. Track people";
    case "tracked":
      return "4. Name the people";
    case "building":
    case "ready":
      return "5. Build";
    case "failed":
      return `Failed at ${state.step}`;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function updateProgress(root: HTMLElement, job: Job | null): void {
  const text = root.querySelector(".progress-text");
  const bar = root.querySelector("progress");
  const resumed = root.querySelector(".resumed");
  if (text === null || bar === null || resumed === null) return;
  text.textContent = progressText(job);
  const p = job?.progress ?? null;
  if (p !== null && p.total !== null && p.total > 0) bar.value = Math.min(1, p.done / p.total);
  else bar.removeAttribute("value");
  resumed.textContent = p?.resumed ? "The server restarted, so this step started again." : "";
}

const seconds = (n: number) => `${n.toFixed(1)} s`;

function clipPanel(id: TemplateId, source: SourceFacts, current: Clip | null, show: (job: Job) => void): HTMLElement {
  const video = el("video", { src: sourceUrl(id), controls: true, preload: "metadata", className: "source-video" });
  const duration = source.duration;
  const initialStart = current?.start ?? 0;
  const numberInput = (idAttr: string, value: number) =>
    el("input", { id: idAttr, type: "number", min: "0", max: String(duration), step: "0.1", value: value.toFixed(1) });
  const rangeInput = (label: string, value: number) =>
    el("input", { type: "range", min: "0", max: String(duration), step: "0.1", value: String(value), ariaLabel: label });
  const startInput = numberInput("clip-start", initialStart);
  const endInput = numberInput("clip-end", current?.end ?? Math.min(duration, initialStart + 10));
  const startRange = rangeInput("Start slider", Number(startInput.value));
  const endRange = rangeInput("End slider", Number(endInput.value));
  const length = el("p", { className: "clip-length" });
  const error = el("p", { className: "field-error" });
  const text = (idAttr: string, label: string, value: string) => {
    const input = el("input", { id: idAttr, type: "text", value, maxLength: 200 });
    return { input, field: el("div", { className: "field" }, el("label", { htmlFor: idAttr }, label), input) };
  };
  const titleField = text("clip-title", "Title", current?.title ?? source.title);
  const creditField = text("clip-credit", "Credit", current?.credit ?? `${source.title}, ${source.channel}, YouTube`);
  const licenseField = text("clip-license", "License", current?.license ?? DEFAULT_LICENSE);
  const submit = el("button", { type: "submit" }, current === null ? "Track people" : "Track this clip again");

  const range = () => ({ start: Number(startInput.value), end: Number(endInput.value) });
  const problem = (): string | null => {
    const { start, end } = range();
    if (!(end > start)) return "The end must be after the start.";
    if (end - start > MAX_CLIP_SECONDS) return `A clip is at most ${MAX_CLIP_SECONDS} s.`;
    if (end - start < 1) return "A clip is at least 1 s.";
    if (end > duration) return `The video is ${seconds(duration)} long.`;
    return null;
  };
  const sync = (from: "number" | "range") => {
    if (from === "range") {
      startInput.value = Number(startRange.value).toFixed(1);
      endInput.value = Number(endRange.value).toFixed(1);
    } else {
      startRange.value = startInput.value;
      endRange.value = endInput.value;
    }
    const { start, end } = range();
    length.textContent = `${seconds(Math.max(0, end - start))} of ${MAX_CLIP_SECONDS} s max`;
    error.textContent = problem() ?? "";
    submit.disabled = problem() !== null;
  };
  const dragEnd = () => {
    if (Number(endRange.value) - Number(startRange.value) > MAX_CLIP_SECONDS) endRange.value = String(Math.min(duration, Number(startRange.value) + MAX_CLIP_SECONDS));
    sync("range");
  };
  const dragStart = () => {
    if (Number(endRange.value) - Number(startRange.value) > MAX_CLIP_SECONDS) startRange.value = String(Math.max(0, Number(endRange.value) - MAX_CLIP_SECONDS));
    sync("range");
  };
  startRange.addEventListener("input", () => {
    dragEnd();
    video.currentTime = Number(startRange.value);
  });
  endRange.addEventListener("input", () => {
    dragStart();
    video.currentTime = Number(endRange.value);
  });
  startInput.addEventListener("input", () => sync("number"));
  endInput.addEventListener("input", () => sync("number"));

  const setStart = el("button", { type: "button" }, "Set start here");
  const setEnd = el("button", { type: "button" }, "Set end here");
  const playClip = el("button", { type: "button" }, "Play clip");
  setStart.addEventListener("click", () => {
    startInput.value = video.currentTime.toFixed(1);
    sync("number");
  });
  setEnd.addEventListener("click", () => {
    endInput.value = video.currentTime.toFixed(1);
    sync("number");
  });
  let previewing = false;
  playClip.addEventListener("click", () => {
    previewing = true;
    video.currentTime = range().start;
    void video.play();
  });
  video.addEventListener("timeupdate", () => {
    if (previewing && video.currentTime >= range().end) {
      video.pause();
      previewing = false;
    }
  });

  const form = el(
    "form",
    { className: "clip-form" },
    video,
    el("div", { className: "clip-buttons" }, setStart, setEnd, playClip),
    el("div", { className: "field" }, el("label", { htmlFor: startInput.id }, "Start (s)"), startInput, startRange),
    el("div", { className: "field" }, el("label", { htmlFor: endInput.id }, "End (s)"), endInput, endRange),
    length,
    titleField.field,
    creditField.field,
    licenseField.field,
    error,
    submit,
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    try {
      show(await chooseClip(id, { ...range(), title: titleField.input.value, credit: creditField.input.value, license: licenseField.input.value }));
    } catch (e) {
      error.textContent = message(e);
      submit.disabled = false;
    }
  });
  sync("number");
  return el(
    "section",
    { className: "clip-panel" },
    el("h2", {}, current === null ? "2. Choose the clip" : "Change the clip"),
    el("p", { className: "hint" }, `${source.title} · ${source.channel} · ${seconds(duration)}`),
    current === null ? "" : el("p", { className: "hint" }, "Tracking again discards the current people groups."),
    form,
  );
}

function trackCard(card: TrackCard, fps: number, color: string | null, destinations: readonly [string, Destination][], selected: Destination, onMove: (to: Destination) => void): HTMLElement {
  const select = el("select", { ariaLabel: `Move ${card.id} to` });
  destinations.forEach(([label, value], i) => {
    select.append(el("option", { value: String(i), selected: value === selected }, label));
  });
  select.addEventListener("change", () => onMove(destinations[Number(select.value)][1]));
  const span = (card.last - card.first + 1) / fps;
  const node = el(
    "figure",
    { className: "track-card" },
    el("img", { src: card.sheetUrl, alt: `crops of track ${card.id}`, loading: "lazy" }),
    el("figcaption", {}, `${card.id} · shot ${card.shot} · frames ${card.first}-${card.last} · ${seconds(span)}`, select),
  );
  node.dataset.track = card.id;
  if (color !== null) node.style.borderColor = color;
  return node;
}

function timeline(tracks: readonly TrackCard[], frameCount: number, cuts: readonly number[], color: string): HTMLElement {
  const bar = el("div", { className: "timeline" });
  const pct = (f: number) => `${(100 * f) / frameCount}%`;
  for (const cut of cuts) {
    const tick = el("span", { className: "cut" });
    tick.style.left = pct(cut);
    bar.append(tick);
  }
  for (const t of tracks) {
    const overlapped = tracks.some((o) => o !== t && o.shot === t.shot && Math.min(o.last, t.last) - Math.max(o.first, t.first) > 4);
    const span = el("span", { className: overlapped ? "span overlap" : "span", title: t.id });
    span.style.left = pct(t.first);
    span.style.width = pct(t.last - t.first + 1);
    span.style.background = color;
    bar.append(span);
  }
  return bar;
}

function peoplePanel(id: TemplateId, source: SourceFacts, clip: Clip, show: (job: Job) => void): Panel {
  const node = el("section", { className: "people-panel" }, el("h2", {}, "4. Name the people"), el("p", { role: "status" }, "Loading tracks…"));
  let board: People | null = null;
  let timer = 0;
  let saving: Promise<void> = Promise.resolve();
  let saveSeq = 0;
  const buildButton = el("button", { type: "button", className: "build" }, "Build template");
  const buildError = el("p", { className: "field-error" });
  const issueBoxes: HTMLElement[] = [];
  const globalIssues = el("div", { className: "issues" });

  const renderIssues = (issues: readonly Issue[]) => {
    for (const [i, box] of issueBoxes.entries()) box.replaceChildren(...issues.filter((x) => x.person === i).map(issueLine));
    globalIssues.replaceChildren(...issues.filter((x) => x.person === -1).map(issueLine));
    buildButton.disabled = issues.some((x) => x.blocking);
  };

  const save = () => {
    clearTimeout(timer);
    if (board === null) return saving;
    const snapshot = board;
    const seq = ++saveSeq;
    saving = saving
      .then(() => savePeople(id, snapshot.tracksId, snapshot.people))
      .then((next) => {
        if (seq !== saveSeq || board === null) return;
        board = { ...board, issues: next.issues };
        renderIssues(next.issues);
        buildError.textContent = "";
      })
      .catch((e: unknown) => {
        buildError.textContent = `Could not save: ${message(e)}`;
      });
    return saving;
  };
  const scheduleSave = () => {
    clearTimeout(timer);
    buildButton.disabled = true;
    timer = window.setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  };

  const render = () => {
    if (board === null) return;
    const b = board;
    const byId = new Map(b.tracks.map((t) => [t.id, t]));
    const destinations: [string, Destination][] = [
      ...b.people.map((p, i): [string, Destination] => [`Person ${i + 1}${p.name ? `: ${p.name}` : ""}`, i]),
      ["New person", "new"],
      ["Ignore", "ignore"],
    ];
    const move = (track: TrackId) => (to: Destination) => {
      if (board === null) return;
      board = { ...board, people: moveTrack(board.people, track, to) };
      render();
      scheduleSave();
    };
    issueBoxes.length = 0;
    const rows = b.people.map((p: Person, i) => {
      const color = COLORS[i % COLORS.length];
      const name = el("input", { type: "text", value: p.name, placeholder: "Who is this?", ariaLabel: `Name of person ${i + 1}`, maxLength: 60 });
      name.addEventListener("input", () => {
        if (board === null) return;
        board = { ...board, people: renamePerson(board.people, i, name.value) };
        scheduleSave();
      });
      name.addEventListener("change", render);
      const cards = p.tracks.flatMap((t) => byId.get(t) ?? []);
      const issues = el("div", { className: "issues" });
      issueBoxes.push(issues);
      const row = el(
        "section",
        { className: "person" },
        el("div", { className: "person-head" }, el("span", { className: "swatch" }), name),
        timeline(cards, b.frameCount, b.cuts, color),
        issues,
        el("div", { className: "cards" }, ...cards.map((c) => trackCard(c, b.fps, color, destinations, i, move(c.id)))),
      );
      row.style.setProperty("--person", color);
      row.dataset.person = String(i);
      return row;
    });
    const ignoredCards = ignored(b).flatMap((t) => byId.get(t) ?? []);
    const tray = el(
      "section",
      { className: "ignored" },
      el("h3", {}, `Ignored (${ignoredCards.length})`),
      el("div", { className: "cards" }, ...ignoredCards.map((c) => trackCard(c, b.fps, null, destinations, "ignore", move(c.id)))),
    );
    node.replaceChildren(
      el("h2", {}, "4. Name the people"),
      el("p", { className: "hint" }, "Each row is one person. Give it a name, and use “Move to” on a card to put the same person from another shot, or seen from behind, in that row. Cards in the Ignored tray do not get a label."),
      globalIssues,
      ...rows,
      tray,
      el("div", { className: "build-row" }, buildButton, buildError, changeClipLink(id, source, clip, show)),
    );
    renderIssues(b.issues);
  };

  buildButton.addEventListener("click", async () => {
    buildButton.disabled = true;
    await save();
    try {
      show(await requestBuild(id));
    } catch (e) {
      buildError.textContent = message(e);
      buildButton.disabled = false;
    }
  });

  getPeople(id)
    .then((people) => {
      board = people;
      render();
    })
    .catch((e: unknown) => node.replaceChildren(el("p", { className: "field-error" }, message(e))));

  return { node, teardown: () => clearTimeout(timer) };
}

function issueLine(issue: Issue): HTMLElement {
  return el("p", { className: issue.blocking ? "issue blocking" : "issue" }, issue.message);
}

function changeClipLink(id: TemplateId, source: SourceFacts, clip: Clip, show: (job: Job) => void): HTMLElement {
  const details = el("details", { className: "change-clip" }, el("summary", {}, "Change the clip"));
  details.addEventListener("toggle", () => {
    if (details.open && details.childElementCount === 1) details.append(clipPanel(id, source, clip, show));
  });
  return details;
}

function readyPanel(id: TemplateId, source: SourceFacts, clip: Clip, show: (job: Job) => void): HTMLElement {
  const regroup = el("button", { type: "button" }, "Regroup people");
  regroup.addEventListener("click", async () => show(await reopen(id)));
  return el(
    "section",
    {},
    el("h2", {}, "Template ready"),
    el("p", {}, el("a", { href: `#/t/${id}` }, "Open it in the editor")),
    regroup,
    changeClipLink(id, source, clip, show),
  );
}

function failedPanel(job: Job, state: Extract<JobState, { kind: "failed" }>, show: (job: Job) => void): HTMLElement {
  const error = el("p", { className: "field-error" });
  const button = (label: string, action: () => Promise<Job>) => {
    const b = el("button", { type: "button" }, label);
    b.addEventListener("click", async () => {
      try {
        show(await action());
      } catch (e) {
        error.textContent = message(e);
      }
    });
    return b;
  };
  const resume = state.resume;
  return el(
    "section",
    { className: "failed-panel" },
    el("h2", {}, `The ${state.step} step failed`),
    el("p", { className: "failure", role: "alert" }, state.message),
    button("Retry", () => retry(job.id)),
    state.step === "build" ? button("Back to people", () => reopen(job.id)) : "",
    resume.kind === "downloading" ? "" : changeClipLink(job.id, resume.source, resume.clip, show),
    error,
  );
}
