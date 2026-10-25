import type { TemplateId } from "./template.ts";

export type Route =
  | { kind: "gallery" }
  | { kind: "editor"; id: string }
  | { kind: "login"; next: string }
  | { kind: "new" }
  | { kind: "job"; id: TemplateId }
  | { kind: "edit"; id: TemplateId };

const authorRoute = (hash: string): Route | null => {
  if (hash === "#/new") return { kind: "new" };
  const edit = /^#\/edit\/([a-z0-9-]+)$/.exec(hash);
  if (edit !== null) return { kind: "edit", id: edit[1] as TemplateId };
  const job = /^#\/new\/([a-z0-9-]+)$/.exec(hash);
  return job === null ? null : { kind: "job", id: job[1] as TemplateId };
};

export const loginHash = (next: string): string => `#/login?next=${encodeURIComponent(next)}`;

function loginNext(hash: string): string | null {
  const m = /^#\/login(?:\?next=(.*))?$/.exec(hash);
  if (m === null) return null;
  const next = decodeURIComponent(m[1] ?? "");
  return next.startsWith("#/") ? next : "#/";
}

export function parseRoute(hash: string, author: boolean): Route {
  const m = /^#\/t\/([a-z0-9-]+)$/.exec(hash);
  if (m !== null) return { kind: "editor", id: m[1] };
  const next = loginNext(hash);
  if (next !== null) return { kind: "login", next };
  const route = authorRoute(hash);
  if (route === null) return { kind: "gallery" };
  return author ? route : { kind: "login", next: hash };
}
