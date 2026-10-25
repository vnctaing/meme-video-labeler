import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const run = (cmd, args, cwd) => execFileSync(cmd, args, { stdio: "inherit", cwd });
const isTracked = (path) => {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

run("npm", ["run", "build"]);
rmSync("site", { recursive: true, force: true });
cpSync("dist", "site", { recursive: true });

// Only clips whose video is committed are licensed for a public site; the fixture is a test pattern.
const isPublic = (id) => id !== "fixture" && isTracked(`public/templates/${id}/video.mp4`);
const index = JSON.parse(readFileSync("site/templates/index.json", "utf8"));
index.templates = index.templates.filter((t) => isPublic(t.id));
writeFileSync("site/templates/index.json", `${JSON.stringify(index, null, 2)}\n`);
for (const entry of readdirSync("site/templates", { withFileTypes: true })) {
  if (entry.isDirectory() && !isPublic(entry.name)) rmSync(`site/templates/${entry.name}`, { recursive: true });
}
console.log(`publishing ${index.templates.map((t) => t.id).join(", ")}`);

run("fly", ["deploy", "--remote-only", "--ha=false"], "..");
