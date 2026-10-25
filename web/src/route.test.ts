import { describe, expect, test } from "vitest";
import { parseRoute } from "./route.ts";

describe("parseRoute", () => {
  test.each([
    ["#/new", { kind: "new" }],
    ["#/new/tos-lab", { kind: "job", id: "tos-lab" }],
    ["#/edit/tos-lab", { kind: "edit", id: "tos-lab" }],
    ["#/t/tos-lab", { kind: "editor", id: "tos-lab" }],
    ["#/login", { kind: "login", next: "#/" }],
    ["", { kind: "gallery" }],
  ])("an author opens %j", (hash, route) => {
    expect(parseRoute(hash, true)).toEqual(route);
  });

  test.each([
    ["#/new", { kind: "login", next: "#/new" }],
    ["#/new/tos-lab", { kind: "login", next: "#/new/tos-lab" }],
    ["#/edit/tos-lab", { kind: "login", next: "#/edit/tos-lab" }],
    ["#/t/tos-lab", { kind: "editor", id: "tos-lab" }],
    ["#/login", { kind: "login", next: "#/" }],
    ["#/login?next=%23%2Fnew%2Ftos-lab", { kind: "login", next: "#/new/tos-lab" }],
    ["#/login?next=https%3A%2F%2Fevil.example", { kind: "login", next: "#/" }],
    ["#/nonsense", { kind: "gallery" }],
  ])("a visitor opens %j", (hash, route) => {
    expect(parseRoute(hash, false)).toEqual(route);
  });
});
