#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const web = path.resolve(import.meta.dirname, "..");
const children = [
  spawn("uv", ["run", "python", "-m", "labelmeme", "serve", "--port", "8787"], { cwd: path.join(web, "../pipeline"), stdio: "inherit" }),
  spawn("npx", ["vite", "--port", "5174", "--strictPort"], { cwd: web, stdio: "inherit", env: { ...process.env, VITE_AUTHOR: "1" } }),
];

let exiting = false;
const stopAll = (code) => {
  if (exiting) return;
  exiting = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  process.exitCode = code;
};
for (const child of children) child.on("exit", (code) => stopAll(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stopAll(0));
