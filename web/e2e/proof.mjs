#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [exportMp4, templateDir, outDir] = process.argv.slice(2);
if (outDir === undefined) {
  console.error("usage: node e2e/proof.mjs <exported.mp4> <template-dir> <out-dir>");
  process.exit(2);
}

const template = JSON.parse(readFileSync(path.join(templateDir, "template.json"), "utf8"));
const sourceMp4 = path.join(templateDir, "video.mp4");
const { fps, frameCount, cuts } = template;
mkdirSync(outDir, { recursive: true });

const run = (cmd, args) => execFileSync(cmd, args, { maxBuffer: 1 << 26 }).toString();
const lerp = (from, to, t) => from + Math.floor((to - from) * t);

function pickFrames() {
  const subject = template.subjects[0];
  const [first, next] = subject.runs;
  const end = first.from + first.boxes.length;
  const gapEnd = next === undefined ? frameCount : next.from;
  const edge = (f) => (cuts.includes(f) ? "hard edge at a cut" : f === 0 || f === frameCount ? "hard edge at the clip end" : "fade");
  const picks = [
    { frame: lerp(first.from, end, 0.15), why: `${subject.id} early in run [${first.from}, ${end})` },
    { frame: lerp(first.from, end, 0.75), why: `${subject.id} late in run [${first.from}, ${end})` },
    { frame: end - 2, why: `${subject.id} two frames before the run ends (${edge(end)})` },
  ];
  if (end < frameCount) picks.push({ frame: end, why: `${subject.id} gone: first frame after the run` });
  if (end < gapEnd) {
    const innerCut = cuts.find((c) => end < c && c < gapEnd);
    if (innerCut === undefined) {
      picks.push({ frame: lerp(end, gapEnd, 1 / 3), why: `inside the gap [${end}, ${gapEnd})` });
      picks.push({ frame: lerp(end, gapEnd, 2 / 3), why: `inside the gap [${end}, ${gapEnd})` });
    } else {
      const shotEnd = cuts.find((c) => c > innerCut && c <= gapEnd) ?? gapEnd;
      picks.push({ frame: lerp(end, innerCut, 0.5), why: `inside the gap, before the cut at ${innerCut}` });
      picks.push({ frame: lerp(innerCut, shotEnd, 0.5), why: `inside the gap, in the shot after the cut at ${innerCut}` });
    }
  }
  if (next !== undefined) {
    const nextEnd = next.from + next.boxes.length;
    picks.push({ frame: next.from, why: `${subject.id} back: first frame of run [${next.from}, ${nextEnd}) (${edge(next.from)})` });
    picks.push({ frame: lerp(next.from, nextEnd, 1 / 3), why: `${subject.id} well inside run [${next.from}, ${nextEnd})` });
    picks.push({ frame: lerp(next.from, nextEnd, 2 / 3), why: `${subject.id} well inside run [${next.from}, ${nextEnd})` });
  }
  picks.push({ frame: frameCount - 1, why: "last frame" });

  const byFrame = new Map();
  for (const p of picks) {
    const seen = byFrame.get(p.frame);
    byFrame.set(p.frame, seen === undefined ? p : { frame: p.frame, why: `${seen.why}; ${p.why}` });
  }
  while (byFrame.size < 8) {
    const taken = [...byFrame.keys(), -1, frameCount].sort((a, b) => a - b);
    let best = 0;
    for (let i = 1; i < taken.length; i++) if (taken[i] - taken[i - 1] > taken[best + 1] - taken[best]) best = i - 1;
    const frame = Math.floor((taken[best] + taken[best + 1]) / 2);
    byFrame.set(frame, { frame, why: "filler: middle of the widest unsampled span" });
  }
  return { subject: subject.id, picks: [...byFrame.values()].sort((a, b) => a.frame - b.frame).slice(0, 12) };
}

function writeSheet(picks) {
  const tmp = mkdtempSync(path.join(tmpdir(), "labelmeme-proof-"));
  picks.forEach(({ frame }, i) => {
    const caption = `frame ${frame}   t ${(frame / fps).toFixed(3)} s`;
    run("ffmpeg", [
      "-v", "error", "-y", "-i", exportMp4,
      "-vf", `select=eq(n\\,${frame}),scale=640:-2,drawtext=text='${caption}':x=8:y=h-th-8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=4`,
      "-frames:v", "1", path.join(tmp, `${String(i).padStart(2, "0")}.png`),
    ]);
  });
  const cols = 4;
  run("ffmpeg", [
    "-v", "error", "-y", "-i", path.join(tmp, "%02d.png"),
    "-vf", `tile=${cols}x${Math.ceil(picks.length / cols)}:padding=4`,
    "-frames:v", "1", path.join(outDir, "sheet.png"),
  ]);
  rmSync(tmp, { recursive: true });
}

const audioMd5 = (file) => run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-c", "copy", "-f", "md5", "-"]).trim();

const probeArgs = [
  "-v", "error", "-count_frames",
  "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames:format=duration",
  "-of", "json", exportMp4,
];
const probeJson = run("ffprobe", probeArgs);
writeFileSync(path.join(outDir, "ffprobe.txt"), `$ ffprobe ${probeArgs.join(" ")}\n${probeJson}`);
const probe = JSON.parse(probeJson);
const video = probe.streams.find((s) => s.codec_type === "video");
const audio = probe.streams.find((s) => s.codec_type === "audio");
const duration = Number(probe.format.duration);

const { subject, picks } = pickFrames();
writeFileSync(path.join(outDir, "frames.json"), `${JSON.stringify({ template: template.id, subject, fps, frameCount, cuts, frames: picks }, null, 2)}\n`);
writeSheet(picks);

const checks = [
  [video?.codec_name === "h264", `video codec is h264 (got ${video?.codec_name})`],
  [audio?.codec_name === "aac", `audio stream present and aac (got ${audio?.codec_name ?? "none"})`],
  [video?.width === template.width && video?.height === template.height, `video size ${video?.width}x${video?.height} equals template ${template.width}x${template.height}`],
  [Number(video?.nb_read_frames) === frameCount, `nb_read_frames ${video?.nb_read_frames} equals frameCount ${frameCount}`],
  [Math.abs(duration - frameCount / fps) <= 0.1, `duration ${duration} s within 0.1 s of ${(frameCount / fps).toFixed(3)} s`],
];
for (const [ok, what] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${what}`);

if (audio !== undefined) {
  const exported = audioMd5(exportMp4);
  const source = audioMd5(sourceMp4);
  if (exported === source) console.log(`PASS audio copied, not re-encoded (${exported})`);
  else console.log(`INFO audio md5 differs from the source, so the audio was not copied bit for bit: export ${exported}, source ${source}`);
}
console.log(`wrote ffprobe.txt, frames.json and sheet.png (${picks.length} frames of ${subject}) to ${outDir}`);
process.exitCode = checks.every(([ok]) => ok) ? 0 : 1;
