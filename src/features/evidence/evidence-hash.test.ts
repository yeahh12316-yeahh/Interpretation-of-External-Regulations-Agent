// @vitest-environment node

import { expect, it } from "vitest";

import { evidenceDigest, stableValue } from "./evidence-hash";

it("keeps stable values independent of object key order", () => {
  expect(stableValue({ b: 2, a: ["x", true] })).toBe(
    '{"a":["x",true],"b":2}',
  );
  expect(stableValue({ a: ["x", true], b: 2 })).toBe(
    '{"a":["x",true],"b":2}',
  );
});

it("keeps the established FNV-1a 64-bit digest output", () => {
  expect(evidenceDigest("hello")).toBe("fnv1a64:dcdd4ba1ec7623eb");
});
