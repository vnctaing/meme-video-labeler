import { afterEach, describe, expect, test, vi } from "vitest";
import { loadSession, signIn } from "./session.ts";

afterEach(() => vi.unstubAllGlobals());

describe("loadSession", () => {
  test("a signed-in author gets the upload cap", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ maxUploadBytes: 209715200 }));
    await expect(loadSession()).resolves.toEqual({ maxUploadBytes: 209715200 });
  });

  test.each([
    ["a 401", async () => Response.json({ error: "sign in first", field: null }, { status: 401 })],
    ["a refused connection", async () => Promise.reject(new TypeError("Failed to fetch"))],
    ["the static site's index.html", async () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["JSON without the cap", async () => Response.json({})],
  ])("%s means a visitor", async (_what, reply) => {
    vi.stubGlobal("fetch", reply);
    await expect(loadSession()).resolves.toBeNull();
  });
});

describe("signIn", () => {
  test("posts the password as JSON", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(null, { status: 204 });
    });
    await signIn("hunter2");
    expect(sent.map(({ url, init }) => [url, init.method, init.body])).toEqual([["/api/login", "POST", JSON.stringify({ password: "hunter2" })]]);
  });

  test("a wrong password says so", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "wrong password", field: "password" }, { status: 401 }));
    await expect(signIn("nope")).rejects.toThrow(/^Wrong password$/);
  });

  test("a server that does not answer says so instead of blaming the password", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(signIn("pw")).rejects.toThrow(/not answering/);
  });
});
