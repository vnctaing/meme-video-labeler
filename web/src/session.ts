import { isRecord } from "./template.ts";

export interface Session {
  readonly maxUploadBytes: number;
}

export async function loadSession(): Promise<Session | null> {
  try {
    const res = await fetch("/api/session");
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const maxUploadBytes = isRecord(json) ? json.maxUploadBytes : undefined;
    return typeof maxUploadBytes === "number" && maxUploadBytes > 0 ? { maxUploadBytes } : null;
  } catch {
    return null;
  }
}

export async function signIn(password: string): Promise<void> {
  const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }).catch(() => {
    throw new Error("The server is not answering. Try again in a moment.");
  });
  if (res.status === 401) throw new Error("Wrong password");
  if (!res.ok) throw new Error(`Signing in failed with HTTP ${res.status}`);
}
