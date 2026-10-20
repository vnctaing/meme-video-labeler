# labelmeme

labelmeme puts your own labels on the people and things in a short video clip, meme style, and exports an MP4. Each template is a clip plus per-frame boxes for every subject in it. A local authoring tool builds templates: you click a subject once and a tracker follows it. A static web app previews and exports the labelled video in the browser.

## Run the web app

```sh
cd web && npm install && npm run dev
```

Other commands, run from `web/`:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-checks the app, the tests and the configs, then writes the production build to `dist/`. |
| `npm test` | Runs the vitest unit tests in `src/*.test.ts`. |
| `npm run e2e` | Builds, serves `dist/` with `vite preview` on port 4173, and runs the Playwright specs in `e2e/`. |
| `npm run dev:author` | Starts the authoring API on port 8787 and Vite on port 5174 with the **New template** page turned on. Set `AUTHOR_API_PORT` and `AUTHOR_WEB_PORT` to use other ports. See [Author a template from a YouTube link](#author-a-template-from-a-youtube-link). |

The e2e specs need `ffmpeg` and `ffprobe` on the `PATH`. For every template in `index.json`, they label each subject, play the clip, export it, and check the MP4. They write `gallery.png`, and for each template `<id>-editor.png`, `<id>-export.mp4` and a `<id>/` proof directory, to `web/test-results/`.

The proof script `web/e2e/proof.mjs` checks one exported MP4 against its template. Run it as `node e2e/proof.mjs <exported.mp4> <template-dir> <out-dir>` from `web/`. It prints a `PASS` or `FAIL` line for the H.264 codec, the AAC audio, the frame size, the frame count and the duration, and exits with status 1 on any `FAIL`. It also compares the audio md5 with the source `video.mp4` and prints `INFO` when they differ. It writes `ffprobe.txt` with the exact command and its JSON, `frames.json`, and `sheet.png`, a contact sheet of 8 to 12 frames captioned with the frame number and time. The frames come from the first subject's runs and the cuts in `template.json`. They show the label early and late in its first run, two frames before the run ends, the frame after it ends, inside the gap, the first frame back, inside the next run, and on the last frame. `frames.json` says why each frame was picked.

### Export runs in the browser

The **Download MP4** button decodes `video.mp4`, draws each frame and its labels onto a canvas, and encodes the result to H.264 with [mediabunny](https://mediabunny.dev) on top of WebCodecs. The AAC audio track is copied, not re-encoded. The preview and the export call the same `paintFrame` function, so the preview shows the pixels the export writes.

Export needs the WebCodecs H.264 encoder, which in practice means a Chromium browser such as Chrome or Edge. In other browsers the button stays disabled and the page says why.

Playwright runs its bundled `chromium-headless-shell`, which has only a software H.264 encoder. That encoder is enough for the specs. If a future Chromium build drops it, run the specs on Google Chrome instead:

```sh
PW_CHANNEL=chrome npm run e2e
```

`PW_CHANNEL` sets the Playwright `channel`. Leave it unset to use the bundled headless shell.

Labels use the Anton font from `web/public/fonts/` (SIL Open Font License, see `web/public/fonts/LICENSE`), with Impact as the fallback.

## Run the pipeline

The pipeline needs [uv](https://docs.astral.sh/uv/) and `ffmpeg`/`ffprobe` on the `PATH`.

```sh
cd pipeline && uv sync
uv run pytest
```

`uv sync` installs the EdgeTAM tracker from its pinned GitHub commit, with `torch`, `torchvision` and `timm` pinned in `pyproject.toml`. The tracker tests that load the model are skipped by default. To run them, put the `tos-lab` clip in `pipeline/work/tos-lab/video.mp4` (see [Commands for `tos-lab`](#commands-for-tos-lab)) and run:

```sh
LABELMEME_SLOW=1 uv run pytest -s tests/test_tracker_slow.py
```

Generate the synthetic fixture template into `web/public/templates/fixture/`:

```sh
cd pipeline && uv run python -m labelmeme fixture
```

The command is idempotent. A second run writes the same bytes.

## Author a template from a YouTube link

The **New template** page turns a YouTube link into a template in the gallery without a terminal. It runs a small API in `pipeline/labelmeme/server.py`. It is a local tool for the person who runs the app. Production builds, `npm run dev` and `vite preview` do not include it.

### Run it

You need everything that [Run the pipeline](#run-the-pipeline) needs, plus `node_modules` in `web/`.

```sh
cd web && npm run dev:author
```

The command starts two processes and stops both when either one exits or you press Ctrl-C:

- `uv run python -m labelmeme serve --port 8787 --web-port 5174`, the API. It listens on 127.0.0.1 only and refuses requests whose `Origin` is not the authoring page.
- `vite --port 5174 --strictPort` with `VITE_AUTHOR=1`. Vite forwards `/api` to the API. Port 5174 leaves a plain `npm run dev` on 5173 alone.

To run a second copy next to the first, set both ports, for example `AUTHOR_API_PORT=8797 AUTHOR_WEB_PORT=5184 npm run dev:author`.

Open http://localhost:5174/ and click **New template**.

1. Paste a YouTube link and, if you want a shorter id than the one derived from the video title, a short name. The API checks the video before it creates a job, so a bad link, a private video or an unavailable video shows an error under the field. The download keeps the best H.264 stream at 720p or below in `pipeline/work/.sources/<video id>/source.mp4`. A second job from the same video downloads nothing.
2. Choose the start and end of the clip, at most 30 s, and click **Use this clip**. The title, credit and license fields start from the video title, the channel, and `unknown, personal use`. The API encodes the clip and finds the camera cuts.
3. Place the subjects in the editor. Click **+ Add subject** and type a name. Move the playhead to a frame where the subject is visible, then click the subject in the video. The tracker follows it backward to the start of the shot and forward to the next cut. The subject's lane shows the progress of each tracked span, and you can keep working while it tracks.
4. Correct the path. If a label drifts off its subject, move to that frame and click the subject again. Only the spans next to that click are tracked again. If the subject comes back after a cut, click it once in that shot. Press **H** to hide the subject from the playhead until its next click. Press **Delete** to remove the keyframe at the playhead.
5. Click **Save**. Save stays disabled until every span is tracked and every placed subject has a name. The template is written to `web/public/templates/<id>/` and `index.json`, and the page opens it. You can come back to the job and save again.

The editor keys are **Space** to play and pause, **Left** and **Right** to step one frame, **H** to hide, and **Delete** or **Backspace** to remove a keyframe. Click or drag in a lane to move the playhead, and click a diamond to jump to its keyframe.

### How tracking works

A subject is a name, a color and a list of keyframes sorted by frame. A keyframe is a click (`{frame, point: [x, y]}`) or a hide (`{frame, hidden: true}`). The planner in `pipeline/labelmeme/plan.py` turns the keyframes into segments, one shot at a time, and never lets a segment cross a cut:

- A `lead` runs backward from the first click in a shot to the start of the shot.
- A `bridge` runs forward between two clicks and uses both clicks.
- A `tail` runs forward from a click to the next hide or to the end of the shot.

A click after a hide gets no lead, so a hide lasts until the next click. A segment's key names its kind, its frame range and its clicks, for example `bridge|114-190|114@230,210;190@310,200`. The tracked boxes are cached by key in `pipeline/work/<id>/authoring.json`. An edit changes the keys of the segments next to the edited keyframe and of no other segment, so only those segments are tracked again. A segment that an edit replaces while it tracks is cancelled within one tracked frame.

The worker tracks one segment at a time, nearest the last edit first. Save shapes the boxes the same way the editor shows them, with gaps of up to 6 frames filled and a 5-frame smoothing window, and writes `template.json`.

### Tracker and weights

The tracker is [EdgeTAM](https://github.com/facebookresearch/EdgeTAM) at commit `7711e01`. It tracks every second frame and fills the frames between by linear interpolation, and it runs its memory attention in fp16 on the Apple GPU (MPS), or on the CPU when MPS is absent. A comparison on the 15 s `tos-lab` clip on an Apple M1 with 16 GB, with a person and an object, chose it:

| Model | First track, 15 s clip | Correction |
| --- | --- | --- |
| SAM 2.1 tiny | about 0.5 frames/s, 450 s for one 228-frame shot | not run |
| EdgeTAM, every frame | 194 to 242 s | 14 to 15 s |
| EdgeTAM, every frame, fp16 memory attention | 176 s | 13 s |
| EdgeTAM, every second frame, fp16 memory attention | 78 s | 6.5 s forward, 12 s back to the previous click |

In this tool the same clip takes about 73 s for the first track of two subjects, and a correction click about 18 s for its two segments. Peak memory is about 2.3 GB.

The installed EdgeTAM package does not include its model config, so `pipeline/labelmeme/edgetam.yaml` is a copy from the pinned commit. The first segment the worker tracks downloads the weights (56 MB) from the pinned commit to `pipeline/models/edgetam.pt` and checks their sha256. The editor shows that segment as loading until the model is ready. To download them ahead of time, run:

```sh
cd pipeline && uv run python -c "from pathlib import Path; from labelmeme.tracker import ensure_weights; print(ensure_weights(Path('models')))"
```

### Job states

Each job lives in `pipeline/work/<id>/job.json`, and `<id>` is also the template id. A job is always in exactly one state.

| State | Meaning | What you can do |
| --- | --- | --- |
| `downloading` | The worker is downloading the video. | Wait. |
| `downloaded` | The video is in the source cache. | Choose the clip. |
| `preparing` | The worker is encoding the clip and finding the cuts. | Wait. |
| `editing` | The clip is ready. The editor is open and the worker tracks the segments that the keyframes need. | Add subjects and keyframes, save, or choose another clip. |
| `ready` | The template is in `web/public/templates/<id>/` and in `index.json`. | Open it, edit and save again, or choose another clip. |
| `failed` | The download or the prepare step failed. The page shows the step and the error. | Retry the step. After a failed prepare, you can also choose another clip. |

One worker thread runs one step or one segment at a time for all jobs, because one tracker run already fills the GPU. A job that waits for another shows "Waiting for another job to finish".

When the API stops in the middle of a step, the job file still names that step. The next `npm run dev:author` runs the step again from its start and the page says so. When the API stops while a segment tracks, `authoring.json` keeps every finished segment, and the next start tracks the missing ones again. A tracking error does not fail the job. The editor marks that segment as failed, and the next edit to the job tries it again.

A new clip replaces the job's `cuts.json` and `authoring.json`, so it removes every subject.

### Check the whole flow

`web/e2e/author-flow.mjs` drives the page in Chromium with Playwright. It pastes the Tears of Steel link, downloads it, and chooses 225.1 s to 240.1 s. Then it adds Thom with a click at frame 114 and the robot man's eyepiece with a click at frame 114, and checks that a correction click on Thom at frame 190 re-tracks only Thom's two segments next to it. It adds a click on Thom in the third shot, kills the API with `kill -9` while that segment tracks, starts `npm run dev:author` again, and waits for the segment to finish. It hides Thom from frame 200, saves, labels the template in the editor, and exports the MP4. `npm run e2e` does not run it, because it needs the network and takes about 5 minutes. The two ports must be free.

```sh
cd web && node e2e/author-flow.mjs ../proof/authoring
node e2e/proof.mjs ../proof/authoring/labelmeme-tos-lab-ui.mp4 public/templates/tos-lab-ui ../proof/authoring
```

The script writes a screenshot of each step, `server.log` with the segments the worker tracked, and the exported MP4 to the directory you give it. It writes the template `tos-lab-ui` into `web/public/templates/` and `index.json`. Delete `web/public/templates/tos-lab-ui/` and `pipeline/work/tos-lab-ui/`, and restore `index.json` with `git checkout`, before you run `npm run e2e`, which needs a label for every subject in `index.json`.

### Rights of YouTube clips

A template made from a YouTube clip carries the rights of that clip. The page sets its license to `unknown, personal use` unless you change it, and `SOURCE.md` records the video URL, the license and the credit. Do not publish such a template unless you know that the clip's license allows it. The Tears of Steel clips in this repository are CC-BY 3.0, (c) Blender Foundation.

## Command-line steps

All paths below are relative to `pipeline/`. `work/` and `models/` are gitignored.

- `prep` trims a source and re-encodes it to the frame grid the web app expects. It writes `work/<id>/video.mp4`, `thumb.jpg`, `SOURCE.md` and `video.json`.
- `build` reads `work/<id>/authoring.json` and `cuts.json`, writes `web/public/templates/<id>/`, regenerates `index.json`, and writes `work/<id>/sheets/built.jpg` with the boxes and names on sample frames from every shot. **Save** in the editor runs the same code.
- `serve` runs the authoring API that `npm run dev:author` starts.

### Commands for `tos-lab`

The source is the 720p Tears of Steel film, CC-BY 3.0, (c) Blender Foundation.

```sh
curl -o tos720.mov https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov
uv run python -m labelmeme prep tos720.mov --start 225.1 --duration 19.4 --id tos-lab \
	--title 'Tears of Steel: the lab' \
	--credit 'Tears of Steel (c) Blender Foundation, CC-BY 3.0, mango.blender.org' \
	--source-url https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov \
	--license 'CC-BY 3.0'
```

The shipped `tos-lab` and `tos-robot` templates were made with an earlier detection-based version of this pipeline. Their `template.json`, `video.mp4` and `thumb.jpg` are kept as they are.

### Parameters

| Parameter | Value | Where | Why |
| --- | --- | --- | --- |
| Scene threshold | 0.3 | `SCENE_THRESHOLD` in `cuts.py` | On `tos-lab` the two real cuts score 0.53 and 0.45, and no other frame scores above 0.07. |
| Tracker | EdgeTAM `7711e01`, every second frame, fp16 memory attention, MPS | `tracker.py` | See [Tracker and weights](#tracker-and-weights). |
| Weights | `edgetam.pt`, sha256 `ed2d4850…80df` | `WEIGHTS_SHA256` in `tracker.py` | Downloaded on first use. A changed upstream file fails the check instead of loading. |
| Max gap | 6 frames | `ShapeParams.max_gap` | A gap of up to 6 frames inside one shot is filled by linear interpolation, so a frame where the mask blinks out does not make a label flicker. |
| Min run | 1 frame | `ShapeParams.min_run` | Every run comes from a deliberate click, so no run is dropped for being short. |
| Smoothing window | 5 frames | `ShapeParams.smooth_window` | A centered mean inside each run removes tracker jitter. The mean never crosses a run edge, so a box never drifts across a cut. |

## Template schema

`web/src/schema.ts` and `pipeline/labelmeme/schema.py` define the wire format. Both describe the same JSON.

### Files

Each template lives in `web/public/templates/<id>/`:

- `template.json` holds the template described below.
- `video.mp4` is H.264 with no B-frames, constant frame rate at `fps`, first frame at time 0, plus an AAC track.
- `thumb.jpg` is frame 0.
- `SOURCE.md` names the source, license, time range and the command that produced the clip.

The pipeline regenerates `web/public/templates/index.json` from every `*/template.json` each time it writes a template. It contains `{ "version": 1, "templates": [...] }`, one entry per template sorted by id, each with `id`, `title`, `credit`, `width`, `height`, `fps`, `frameCount` and `subjectCount`.

### template.json

| Field | Meaning |
| --- | --- |
| `version` | Always `1`. |
| `id` | Slug (`[a-z0-9-]+`), equal to the directory name. |
| `title` | Title shown in the gallery and editor. |
| `credit` | Attribution line. The gallery and editor show it, because CC-BY requires it. |
| `width`, `height` | Frame size in pixels, at least 1. |
| `fps` | Integer frames per second, at least 1. |
| `frameCount` | Number of frames in `video.mp4`, measured by decoding the file. |
| `cuts` | Frame indices where a new shot starts. Sorted, unique, each in `(0, frameCount)`. |
| `subjects` | The subjects a user can label. |

Each subject has an `id` (slug, unique within the template), a display `name`, and `runs`. A run is a stretch of consecutive frames where the subject is visible: `{ "from": f, "boxes": [[x, y, w, h], ...] }`. `boxes[i]` is the box at frame `from + i`, so the run covers frames `[from, from + boxes.length)`. A frame outside every run means the subject is off screen.

Invariants, enforced by `validate_template` before any write:

- Runs of a subject are sorted by `from` and do not overlap.
- Two runs of a subject touch only at a cut. Anywhere else at least one frame separates them, so a label never fades out and straight back in.
- Every run lies inside `[0, frameCount)`.
- No run crosses a cut. A run may start or end at a cut, so a subject visible on both sides of a cut has two runs.
- Boxes are integer pixels in template coordinates with a top-left origin. `w` and `h` are at least 1, and the box lies inside the frame.

### Frame mapping

One rule maps a time to a frame everywhere: `frameIndex = clamp(round(seconds * fps), 0, frameCount - 1)`. The preview passes the `mediaTime` from `requestVideoFrameCallback`. The export passes the decoded sample's timestamp.

### Fades and cuts

A label fades over `FADE_FRAMES = 4` frames. Its alpha ramps linearly over the first and last 4 frames of a run. A run edge that touches a cut, frame 0 or `frameCount` is a hard edge with alpha 1, so a label disappears on a cut instead of fading across it. The pipeline never interpolates a box across a cut.
