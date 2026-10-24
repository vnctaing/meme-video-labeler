# labelmeme

labelmeme puts your own labels on the people and things in a short video clip, meme style, and exports an MP4. Each template is a clip plus per-frame boxes for every subject in it. A local authoring tool builds templates. You follow each subject with the pointer while the clip plays. A static web app previews and exports the labelled video in the browser.

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
3. Draw the subjects. A subject does not have to be on screen at the first frame. Move to the frame where it appears first: press **Space** to play and pause at 1x, drag the timeline under the video, or press **Left** and **Right** to step one frame. Then click **+ Add subject**. The new subject is named "Subject 1", "Subject 2" and so on, with the name selected, so you can type a new name and press Enter. The video says "Hold the mouse on <name> and follow it" until the subject has a label in the current shot.
   - Hold the mouse button on the subject, or your finger on a touch screen. The clip plays at the speed in **Speed** (0.25x, 0.5x or 1x, 0.5x by default), and each video frame records where you point. Keep the pointer on the subject while it moves. Release to pause, and hold again to continue.
   - To hide the subject on some frames, hold **Alt** while you draw, or turn on **Erase** (**E**) and draw. Erased frames have no label.
   - To correct a stretch, scrub back and draw over it. The new drawing replaces the old one on those frames and keeps the rest.
   - To change the label size, turn the mouse wheel or press **+** and **-** (**Size +** and **Size −**), also while you draw. The label at the pointer shows the size, and each frame keeps the size it was drawn at. The size stays between 4% and 11% of the frame height, so a label stays readable.
4. Check the result. The video shows the path of every subject in the current shot, with the selected one brighter. Each lane shows where its subject has a label. Click a lane to select its subject. Selecting never moves the playhead. The timeline under the video shows the cuts and the playhead, even before the first subject. Click or drag it to move the playhead. **Play** (**Space**) plays at 1x from the current frame, records nothing, and keeps the position when you pause. **Play result** (**R**) plays the whole clip from the start at 1x with the labels only. **Undo** (Cmd+Z or Ctrl+Z) undoes one whole stroke, and **Redo** (Shift+Cmd+Z or Shift+Ctrl+Z) redoes it. **Clear subject** removes the drawing of the selected subject, and **Delete subject** removes the subject. Both show a notice with **Undo**. **Reaction lag** and **Smoothing** change how the drawing becomes boxes, see [How drawing works](#how-drawing-works).
5. Click **Save**. The editor saves the drawing to `pipeline/work/<id>/draft.json` 300 ms after each change, so a reload or a restart resumes where you stopped. **Save** stays disabled while you draw, until a subject has a label, and while a subject with a label has no name. The template is written to `web/public/templates/<id>/` and `index.json`, and the page opens it. You can come back to the job and save again.

The editor keys are **Space** to play and pause from the current frame, **R** to play and pause the result from the start, **Left** and **Right** to step one frame, **+**, **=** and **-** to change the label size, **E** to turn **Erase** on and off, **Alt** held to erase while you draw, and Cmd+Z or Ctrl+Z to undo, with Shift to redo. The row under the timeline lists the single-key shortcuts.

### How drawing works

The raw drawing is the source of truth. Each subject has one cell per frame in `draft.json`. A cell is `null` for a frame never drawn, `"hidden"` for an erased frame, or `[x, y, size, rate]`. `x` and `y` are the pointer position in template pixels, `size` is the label font size in pixels, and `rate` is the playback speed of the frame when you drew it. The browser turns the cells into runs with `processTrack` in `web/src/track.ts`, in three steps. No step crosses a cut.

1. Reaction lag. Your pointer trails the subject by your reaction time, which is wall-clock time. The shift for a cell is `round(lag / 1000 × fps × rate)` frames, so 150 ms is 4 frames at 1x and 2 frames at 0.5x on a 24 fps clip. Each cell moves back by its own shift. Where the speed changes inside a shot, each frame still gets exactly one cell, in order. The last frames of a shot keep the shot's last cell, so a drawing that reaches a cut keeps its label up to the cut.
2. Smoothing. Each sample becomes the mean of the samples within the smoothing radius on both sides. The window shrinks at the edges of a stretch, so the first and last points stay where you drew them. The window never reaches across a cut, an erased frame or an undrawn frame.
3. Bridging. A gap of 1 or 2 undrawn frames between two samples in the same shot is filled by linear interpolation, because the browser can skip a video frame callback under load. An erased frame is never filled.

The drawn point is the bottom centre of the label, and the size is the font size that the renderer uses. `toWireBox` turns a sample into a box of width `size / 0.28`, centred on `x`, with its top at `y` and a height of 1. The renderer lays that box out as the same label. Near the left and right edges the box stays inside the frame, so the label centre can stop short of the pointer, by up to `0.2 × height` at the largest size. Near the top edge the renderer puts the label under the point instead of above it. The browser posts the runs, and the API checks them with `validate_template` before it writes the template.

### Job states

Each job lives in `pipeline/work/<id>/job.json`, and `<id>` is also the template id. A job is always in exactly one state.

| State | Meaning | What you can do |
| --- | --- | --- |
| `downloading` | The worker is downloading the video. | Wait. |
| `downloaded` | The video is in the source cache. | Choose the clip. |
| `preparing` | The worker is encoding the clip and finding the cuts. | Wait. |
| `editing` | The clip is ready and the editor saves the drawing as you go. | Draw subjects, save, or choose another clip. |
| `ready` | The template is in `web/public/templates/<id>/` and in `index.json`. | Open it, edit and save again, or choose another clip. |
| `failed` | The download or the prepare step failed. The page shows the step and the error. | Retry the step. After a failed prepare, you can also choose another clip. |

One worker thread runs one download or prepare step at a time for all jobs, so two encodes never compete. A job that waits for another shows "Waiting for another job to finish".

When the API stops in the middle of a step, the job file still names that step. The next `npm run dev:author` runs the step again from its start and the page says so.

A new clip replaces the job's `cuts.json` and removes `draft.json`, so it removes every drawing.

### Check the whole flow

`web/e2e/draw-flow.mjs` drives the page in Chromium with Playwright. It pastes the Tears of Steel link, downloads it, chooses 225.1 s to 244.5 s, and checks that the clip matches the `tos-lab` clip: 466 frames, cuts at 228 and 326, and an average PSNR of at least 25 dB. Then it draws the way a person would. It holds the mouse on Barley through shot 1 and moves the real pointer to the centre of Barley's box in `web/public/templates/tos-lab/template.json`, 150 ms behind in wall-clock time. It turns the wheel mid-stroke, erases a stretch with Alt and with **Erase**, draws Thom in shot 3, undoes a stray stroke, clears and deletes Thom and undoes both from the notice, plays the result, and reloads the page to check that the draft resumes. It saves with **Reaction lag** at 0 ms and at 150 ms and measures each saved template against the reference box centres. Last, it labels the template in the gallery and exports the MP4. `npm run e2e` does not run it, because it needs the network and takes about 2 minutes. The two ports must be free.

```sh
cd web && AUTHOR_API_PORT=8817 AUTHOR_WEB_PORT=5204 node e2e/draw-flow.mjs ../proof/draw-flow
```

The script prints a `PASS` or `FAIL` line for each check. It writes these files to the directory you give it:

- `flow.txt` with the command and every check, and `server.log`.
- A screenshot of each step, `NN-<step>.png`, and `follow.webm`, a video of the whole session.
- `metric.json` with the mean distance in pixels between the saved label point and the reference box centre, with the lag fix on and off, for Barley and for Thom.
- The exported `labelmeme-tos-draw.mp4`, the output of `e2e/proof.mjs` (`sheet.png`, `frames.json` and `ffprobe.txt`), and `follow-sheet.png`. That sheet shows frames of the export with the reference centre as a red cross and the saved point as a green dot.
- The saved `template.json` and the final `draft.json`.

At the end the script deletes `web/public/templates/tos-draw/` and `pipeline/work/tos-draw/` and regenerates `index.json`, so `npm run e2e` still passes. To keep them, pass `--keep`. To follow `n` ms behind instead of 150 ms, pass `--delay-ms <n>`. The downloaded source stays in `pipeline/work/.sources/`, so a second run downloads nothing.

### History

The first authoring tool tracked each subject with [EdgeTAM](https://github.com/facebookresearch/EdgeTAM) from one click per shot. On an Apple M1, the first track of a 15 s clip took about 73 s and a correction about 18 s. The measurements are in `docs/edgetam-spike-numbers.tsv`, and the tracker code is in git history up to commit `9943ab6`. Following by hand replaced it.

### Rights of YouTube clips

A template made from a YouTube clip carries the rights of that clip. The page sets its license to `unknown, personal use` unless you change it, and `SOURCE.md` records the video URL, the license and the credit. Do not publish such a template unless you know that the clip's license allows it. The Tears of Steel clips in this repository are CC-BY 3.0, (c) Blender Foundation.

## Command-line steps

All paths below are relative to `pipeline/`. `work/` is gitignored.

- `prep` trims a source and re-encodes it to the frame grid the web app expects. It writes `work/<id>/video.mp4`, `thumb.jpg`, `SOURCE.md` and `video.json`.
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
| Reaction lag | 150 ms, slider from 0 to 400 ms | `DEFAULT_TUNING.lagMs` in `track.ts` | A typical human reaction time. In a `draw-flow.mjs` run, a pointer 150 ms behind Barley lands 4.47 px from the box centre with the fix off and 3.02 px with the fix on. |
| Smoothing radius | 4 frames, slider from 0 to 12 | `DEFAULT_TUNING.smoothRadius` in `track.ts` | A 9-frame mean, 0.375 s at 24 fps, removes hand jitter. A larger radius rounds off fast turns. |
| Bridge | 2 frames | `BRIDGE_FRAMES` in `track.ts` | The video frame callback can skip a frame under load. A longer hole is a gap you left on purpose. |
| Label size | 0.04 to 0.11 of the height, 0.06 by default | `MIN_FONT_PER_HEIGHT` and `MAX_FONT_PER_HEIGHT` in `labels.ts`, `DEFAULT_SIZE_PER_HEIGHT` in `track.ts` | The renderer uses the same limits, so the drawn size is the size the export shows. |
| Size step | 1.08 per wheel notch or key press | `SIZE_STEP` in `track.ts` | Three notches make the label 26% bigger, which is easy to see while you draw. |

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
