# labelmeme

labelmeme puts your own labels on the people in a short video clip, meme style, and exports an MP4. Each template is a clip plus per-frame boxes for every person in it. A Python pipeline builds templates offline. A static web app previews and exports the labelled video in the browser.

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

The e2e specs need `ffmpeg` and `ffprobe` on the `PATH`. For every template in `index.json`, they label each person, play the clip, export it, and check the MP4. They write `gallery.png`, and for each template `<id>-editor.png`, `<id>-export.mp4` and a `<id>/` proof directory, to `web/test-results/`.

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

## Author a template from a real clip

Authoring a template takes five steps. The pipeline does the detection and shaping, and you name the people. All paths below are relative to `pipeline/`. `work/` and `models/` are gitignored.

1. `prep` trims the source and re-encodes it to the frame grid the web app expects. It writes `work/<id>/video.mp4`, `thumb.jpg`, `SOURCE.md` and `video.json`.
2. `track` finds the cuts and tracks every person. It writes `work/<id>/cuts.json`, `tracks.json`, the contact sheets in `work/<id>/sheets/`, and a `subjects.json` stub. On the first run it downloads `yolo11m.pt` into `models/`.
3. Open `work/<id>/sheets/overview.jpg`. It shows one crop per track id, captioned with the id and its frame range. When a crop is ambiguous, open `sheets/track_<id>.jpg`, which shows 8 crops spread over that track.
4. Edit `work/<id>/subjects.json`. Give each person a slug `id`, a display `name`, and the list of track ids that belong to them. Delete the entries for people who are not subjects. Keep the `tracksId` field. It identifies the cuts and tracks that the ids refer to.
5. `build` merges and shapes the tracks, writes `web/public/templates/<id>/`, and regenerates `index.json`. Open `work/<id>/sheets/built.jpg` to check the boxes and names on sample frames from every shot.

`track` keeps an existing `cuts.json` and an existing `subjects.json`, so your edits survive a rerun. If the scene detector misses a cut or finds a false one, edit the `frame` values in `cuts.json` and run `track` again. To detect the cuts again, delete `cuts.json`.

A rerun of `track` can renumber the shots and the tracks, so a kept `subjects.json` can name the wrong people. `build` computes a `tracksId` from the current `cuts.json` and `tracks.json` and refuses to run when it differs from the `tracksId` in `subjects.json`. The error prints the new value. Check every track id in `subjects.json` against the new `overview.jpg`, then set `tracksId` to that value. A `subjects.json` without a `tracksId` field is refused the same way.

The tracker restarts at every cut, so a track id never spans two shots. Track ids have the form `s<shot>-<n>`, for example `s3-2` for track 2 in the third shot. A person who is visible on both sides of a cut has one id per shot, and `subjects.json` lists them all.

### Commands for `tos-lab`

The source is the 720p Tears of Steel film, CC-BY 3.0, (c) Blender Foundation.

```sh
curl -o tos720.mov https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov
uv run python -m labelmeme prep tos720.mov --start 225.1 --duration 19.4 --id tos-lab \
	--title 'Tears of Steel: the lab' \
	--credit 'Tears of Steel (c) Blender Foundation, CC-BY 3.0, mango.blender.org' \
	--source-url https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov \
	--license 'CC-BY 3.0'
uv run python -m labelmeme track tos-lab
```

`track` found cuts at frames 228 and 326. These ids went into `work/tos-lab/subjects.json`. The three ids in the street shot (`s2-*`) are not subjects.

```json
{
	"subjects": [
		{"id": "thom", "name": "Thom", "tracks": ["s1-1", "s3-1"]},
		{"id": "barley", "name": "Barley", "tracks": ["s1-2", "s1-6", "s3-2"]},
		{"id": "celia", "name": "Celia", "tracks": ["s1-3", "s1-4", "s3-3"]}
	]
}
```

The file also keeps the `tracksId` field from the stub.

```sh
uv run python -m labelmeme build tos-lab
```

Track ids come from your own `track` run. Check them against your `overview.jpg` before you reuse this file.

### Parameters

| Parameter | Value | Where | Why |
| --- | --- | --- | --- |
| Scene threshold | 0.3 | `SCENE_THRESHOLD` in `track.py` | On `tos-lab` the two real cuts score 0.53 and 0.45, and no other frame scores above 0.07. |
| Detector | `yolo11m.pt`, `imgsz=1280`, person class only | `track.py` | 1280 is the native width of the 720p source, so small people still register. |
| Tracker | ByteTrack, `new_track_thresh: 0.5`, `track_buffer: 48` | `bytetrack_labelmeme.yaml` | A higher new-track threshold gives fewer one-frame ids to sort through. A 48-frame buffer keeps an id through a 2 s occlusion. The other values are the defaults from the Ultralytics 8.4.182 `bytetrack.yaml`. |
| Max gap | 6 frames | `ShapeParams.max_gap` | `build` fills a gap of up to 6 frames inside one shot by linear interpolation, so a short detector dropout does not make a label flicker. |
| Min run | 8 frames | `ShapeParams.min_run` | `build` drops a run shorter than 8 frames, because a label that shows for a third of a second cannot be read. |
| Smoothing window | 5 frames | `ShapeParams.smooth_window` | `build` applies a centered mean inside each run to remove detector jitter. The mean never crosses a run edge, so a box never drifts across a cut. |

When two tracks of one subject overlap on a frame, `build` keeps the larger box and prints a warning with the frame range.

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
| `subjects` | The people a user can label. |

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
