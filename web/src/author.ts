import {
  ApiError,
  type Clip,
  type Job,
  type OpenedEdit,
  type JobState,
  type Running,
  ServerNotAnswering,
  type SourceFacts,
  chooseClip,
  createJob,
  defaultCredit,
  getDraft,
  getJob,
  jobSession,
  listJobs,
  openTemplateEdit,
  retry,
  shortNameToId,
  sourceUrl,
  uploadJob,
  uploadProblem,
} from "./authoring.ts";
import { toWire } from "./clip-model.ts";
import { mountTrimmer } from "./clip-trimmer.ts";
import { type View, el } from "./dom.ts";
import { type Session, signIn } from "./session.ts";
import { mountSubjectEditor } from "./subject-editor.ts";
import type { TemplateId } from "./template.ts";

const BASE_URL = new URL(import.meta.env.BASE_URL, location.href).href;
const DEFAULT_LICENSE = "unknown, personal use";
const POLL_MS = 500;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function header(title: string): HTMLElement {
  return el("header", {}, el("a", { className: "back", href: "#/" }, "← All clips"), el("h1", {}, title));
}

function stateLabel(state: JobState): string {
  return state.kind === "failed" ? `failed at ${state.step}` : state.kind;
}

export function loginView(next: string): View {
  const password = el("input", { id: "password", type: "password", required: true, autocomplete: "current-password" });
  const error = el("p", { className: "field-error", id: "password-error", role: "alert" });
  const submit = el("button", { type: "submit" }, "Sign in");
  const form = el(
    "form",
    { className: "author-form login-form" },
    el("p", { className: "hint" }, "Only the owner of this site makes and edits templates. Anyone can make memes from the gallery without signing in."),
    el("div", { className: "field" }, el("label", { htmlFor: password.id }, "Password"), password, error),
    submit,
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    submit.textContent = "Signing in…";
    try {
      await signIn(password.value);
      location.hash = next;
      location.reload();
    } catch (e) {
      error.textContent = message(e);
      submit.disabled = false;
      submit.textContent = "Sign in";
      password.select();
    }
  });
  requestAnimationFrame(() => password.focus());
  return { nodes: [header("Sign in"), el("main", { className: "author" }, form)], teardown: () => {} };
}

const MB = 1024 * 1024;

export async function newView(session: Session): Promise<View> {
  const idInput = el("input", { id: "short-name", type: "text", placeholder: "derived from the video title", maxLength: 80, autocomplete: "off" });
  const idError = el("p", { className: "field-error" });
  const idHint = el("p", { className: "field-hint" });
  idInput.addEventListener("input", () => {
    const id = shortNameToId(idInput.value);
    idHint.textContent = id === "" || id === idInput.value ? "" : `Saved as ${id}`;
  });
  const shortName = () => shortNameToId(idInput.value) || null;
  const showIdError = (e: unknown) => {
    if (!(e instanceof ApiError && e.field === "id")) return false;
    idError.textContent = message(e);
    return true;
  };

  const fileInput = el("input", { id: "source-file", type: "file", accept: "video/*", required: true });
  const fileError = el("p", { className: "field-error", id: "source-file-error", role: "alert" });
  const uploadProgress = el("progress", { max: 1, value: 0, hidden: true });
  const uploadStatus = el("p", { className: "field-hint", role: "status" });
  const uploadButton = el("button", { type: "submit" }, "Upload video");
  const capMb = Math.round(session.maxUploadBytes / MB);
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    const problem = file === undefined ? null : uploadProblem(file.size, session.maxUploadBytes);
    fileError.textContent = problem ?? "";
    uploadStatus.textContent = file === undefined || problem !== null ? "" : `${file.name}, ${(file.size / MB).toFixed(1)} MB`;
  });
  const uploadForm = el(
    "form",
    { className: "author-form source-option" },
    el("h2", {}, "Upload a video file"),
    el("p", { className: "hint" }, `An MP4, MOV or WebM file from your computer or phone, up to ${capMb} MB.`),
    el("div", { className: "field" }, el("label", { htmlFor: fileInput.id }, "Video file"), fileInput, fileError),
    uploadProgress,
    uploadStatus,
    uploadButton,
  );
  uploadForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const file = fileInput.files?.[0];
    if (file === undefined) return;
    fileError.textContent = idError.textContent = "";
    const problem = uploadProblem(file.size, session.maxUploadBytes);
    if (problem !== null) {
      fileError.textContent = problem;
      return;
    }
    uploadButton.disabled = true;
    uploadButton.textContent = "Uploading…";
    uploadProgress.hidden = false;
    uploadProgress.removeAttribute("value");
    const total = (file.size / MB).toFixed(1);
    uploadStatus.textContent = `Uploading ${total} MB`;
    try {
      const job = await uploadJob(file, shortName(), (fraction) => {
        uploadProgress.value = fraction;
        uploadStatus.textContent = fraction < 1 ? `Uploading ${Math.round(fraction * 100)}% of ${total} MB` : "Checking the video…";
      });
      location.hash = `#/new/${job.id}`;
    } catch (e) {
      if (!showIdError(e)) fileError.textContent = message(e);
      uploadStatus.textContent = "";
      uploadProgress.hidden = true;
      uploadButton.disabled = false;
      uploadButton.textContent = "Upload video";
    }
  });

  const urlInput = el("input", { id: "source-url", type: "url", required: true, placeholder: "https://www.youtube.com/watch?v=…", autocomplete: "off" });
  const urlError = el("p", { className: "field-error", id: "source-url-error", role: "alert" });
  const submit = el("button", { type: "submit" }, "Fetch video");
  const urlForm = el(
    "form",
    { className: "author-form source-option" },
    el("h2", {}, "Or use a YouTube link"),
    el("p", { className: "hint" }, "YouTube sometimes blocks this server. If it does, upload the video file instead."),
    el("div", { className: "field" }, el("label", { htmlFor: urlInput.id }, "YouTube link"), urlInput, urlError),
    submit,
  );
  urlForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    urlError.textContent = idError.textContent = "";
    submit.disabled = true;
    submit.textContent = "Checking the video…";
    try {
      const job = await createJob(urlInput.value, shortName());
      location.hash = `#/new/${job.id}`;
    } catch (e) {
      if (!showIdError(e)) urlError.textContent = message(e);
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
    nodes: [
      header("New template"),
      el(
        "main",
        { className: "author" },
        el("div", { className: "source-options" }, uploadForm, urlForm),
        el("div", { className: "field" }, el("label", { htmlFor: idInput.id }, "Short name (optional)"), idInput, idHint, idError),
        list,
      ),
    ],
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
  const header = el("header", {}, el("a", { className: "back", href: "#/new" }, "← New template"), title);
  const panel = el("main", { className: "author" });

  const show = (next: Job) => {
    job = next;
    header.hidden = next.state.kind === "editing" || next.state.kind === "ready";
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
    nodes: [header, panel],
    teardown: () => {
      alive = false;
      clearTimeout(timer);
      teardownPanel();
    },
  };
}

function isRunning(state: JobState): state is Running {
  return state.kind === "downloading" || state.kind === "preparing";
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
    case "preparing":
      return still(progressPanel(job));
    case "downloaded":
      return still(clipPanel(job.id, state.source, null, show));
    case "editing":
      return editorPanel(
        getDraft(job.id).then((opened) => ({ ...opened, session: jobSession(job.id) })),
        changeClipLink(job.id, state.source, state.clip, show),
      );
    case "ready":
      return editorPanel(openTemplateEdit(job.id, BASE_URL), null);
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
    case "preparing":
      return "Encoding the clip and finding cuts";
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
    case "preparing":
      return "Preparing the clip";
    case "editing":
    case "ready":
      return "3. Subjects";
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
  const text = (idAttr: string, label: string, value: string) => {
    const input = el("input", { id: idAttr, type: "text", value, maxLength: 200 });
    return { input, field: el("div", { className: "field" }, el("label", { htmlFor: idAttr }, label), input) };
  };
  const titleField = text("clip-title", "Title", current?.title ?? source.title);
  const creditField = text("clip-credit", "Credit", current?.credit ?? defaultCredit(source));
  const licenseField = text("clip-license", "License", current?.license ?? DEFAULT_LICENSE);
  const fields = [titleField.input, creditField.input, licenseField.input];
  const error = el("p", { className: "field-error" });
  const submit = el("button", { type: "submit" });
  const summaryLine = el("span");
  const details = el(
    "details",
    { className: "clip-details" },
    el("summary", {}, summaryLine, el("em", {}, "Edit")),
    el("div", { className: "clip-fields" }, titleField.field, creditField.field, licenseField.field),
  );

  const trimmer = mountTrimmer({ src: sourceUrl(id), duration: source.duration, current, onChange: () => sync(), globalKeys: current === null });
  const sync = () => {
    const { start, end } = trimmer.range();
    submit.textContent = current === null ? `Use this ${seconds(end - start)} clip` : "Use this clip instead";
    summaryLine.textContent = fields.map((f) => f.value).join(" · ");
    const empty = fields.some((f) => f.value.trim() === "");
    submit.disabled = empty;
    if (empty) details.open = true;
    error.textContent = empty ? "Title, Credit and License cannot be empty." : "";
  };
  for (const f of fields) f.addEventListener("input", sync);

  const form = el("form", { className: "clip-form" }, trimmer.node, details, submit, error);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    try {
      show(await chooseClip(id, { ...toWire(trimmer.range()), title: titleField.input.value, credit: creditField.input.value, license: licenseField.input.value }));
    } catch (e) {
      error.textContent = message(e);
      submit.disabled = false;
    }
  });
  sync();
  return el(
    "section",
    { className: "clip-panel" },
    el("h2", {}, current === null ? "2. Choose the clip" : "Change the clip"),
    el("p", { className: "hint" }, `${source.title} · ${source.channel} · ${seconds(source.duration)}`),
    current === null ? "" : el("p", { className: "hint" }, "A new clip discards every drawing."),
    form,
  );
}

function editorPanel(opening: Promise<OpenedEdit>, below: HTMLElement | null): Panel {
  const node = el("section", { className: "subject-editor" }, el("p", { role: "status" }, "Loading the editor…"));
  let alive = true;
  let destroy = () => {};
  opening
    .then((opened) => {
      if (!alive) return;
      node.replaceChildren();
      destroy = mountSubjectEditor(node, opened.session, opened).destroy;
      if (below !== null) node.append(below);
    })
    .catch((e: unknown) => node.replaceChildren(el("p", { className: "field-error" }, message(e)), below ?? "", el("a", { href: "#/" }, "Back to all clips")));
  return {
    node,
    teardown: () => {
      alive = false;
      destroy();
    },
  };
}

export async function editTemplateView(id: TemplateId): Promise<View> {
  const panel = editorPanel(openTemplateEdit(id, BASE_URL), null);
  return { nodes: [el("main", { className: "author" }, panel.node)], teardown: panel.teardown };
}

function changeClipLink(id: TemplateId, source: SourceFacts, clip: Clip, show: (job: Job) => void): HTMLElement {
  const details = el("details", { className: "change-clip" }, el("summary", {}, "Change the clip"));
  details.addEventListener("toggle", () => {
    if (details.open && details.childElementCount === 1) details.append(clipPanel(id, source, clip, show));
  });
  return details;
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
    resume.kind === "downloading" ? el("a", { className: "upload-instead", href: "#/new" }, "Upload the video file instead") : changeClipLink(job.id, resume.source, resume.clip, show),
    error,
  );
}
