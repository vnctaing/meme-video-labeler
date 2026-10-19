# labelmeme

labelmeme puts your own labels on the people in a short video clip, meme style, and exports an MP4. Each template is a clip plus per-frame boxes for every person in it. A Python pipeline builds templates offline. A static web app previews and exports the labelled video in the browser.

## Run the web app

```sh
cd web && npm install && npm run dev
```

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
- Every run lies inside `[0, frameCount)`.
- No run crosses a cut. A run may start or end at a cut, so a subject visible on both sides of a cut has two runs.
- Boxes are integer pixels in template coordinates with a top-left origin. `w` and `h` are at least 1, and the box lies inside the frame.

### Frame mapping

One rule maps a time to a frame everywhere: `frameIndex = clamp(round(seconds * fps), 0, frameCount - 1)`. The preview passes the `mediaTime` from `requestVideoFrameCallback`. The export passes the decoded sample's timestamp.

### Fades and cuts

A label fades over `FADE_FRAMES = 4` frames. Its alpha ramps linearly over the first and last 4 frames of a run. A run edge that touches a cut, frame 0 or `frameCount` is a hard edge with alpha 1, so a label disappears on a cut instead of fading across it. The pipeline never interpolates a box across a cut.
