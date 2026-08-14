import { describe, expect, it } from "vitest";

import type { SourceUnit } from "../../domain/source";
import { chunkDocument } from "./chunk-document";

const source = (
  sourceId: string,
  sourceType: SourceUnit["sourceType"],
  content: string,
): SourceUnit => ({ sourceId, sourceType, title: sourceId, content });

describe("chunkDocument", () => {
  it("keeps regulatory originals ahead of interpretations and never mixes source types", () => {
    const chunks = chunkDocument(
      [
        source("OFF-1", "official_interpretation", "官方解读"),
        source("REG-1", "regulatory_text", "监管原文一"),
        source("REG-2", "regulatory_text", "监管原文二"),
      ],
      { maxChars: 24_000, overlapUnits: 2 },
    );

    expect(chunks.map((chunk) => chunk.sourceType)).toEqual([
      "regulatory_text",
      "official_interpretation",
    ]);
    expect(
      chunks.every((chunk) =>
        chunk.units.every((unit) => unit.sourceType === chunk.sourceType),
      ),
    ).toBe(true);
  });

  it("caps every long-document chunk at 24000 characters", () => {
    const chunks = chunkDocument(
      [source("REG-LONG", "regulatory_text", "规".repeat(72_005))],
      { maxChars: 24_000, overlapUnits: 2 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.characterCount <= 24_000)).toBe(true);
    expect(
      chunks
        .flatMap((chunk) => chunk.units)
        .every((unit) => unit.content.length > 0),
    ).toBe(true);
    expect(new Set(chunks.flatMap((chunk) => chunk.inputSourceIds))).toEqual(
      new Set(["REG-LONG"]),
    );
  });

  it("carries the last two source segments into the next same-type chunk", () => {
    const chunks = chunkDocument(
      Array.from({ length: 5 }, (_, index) =>
        source(`REG-${index + 1}`, "regulatory_text", "监管要求"),
      ),
      { maxChars: 12, overlapUnits: 2 },
    );

    expect(chunks).toHaveLength(3);
    expect(chunks[0].units.map((unit) => unit.sourceId)).toEqual([
      "REG-1",
      "REG-2",
      "REG-3",
    ]);
    expect(chunks[1].units.map((unit) => unit.sourceId)).toEqual([
      "REG-2",
      "REG-3",
      "REG-4",
    ]);
    expect(chunks[2].units.map((unit) => unit.sourceId)).toEqual([
      "REG-3",
      "REG-4",
      "REG-5",
    ]);
  });

  it("rejects options that cannot make forward progress", () => {
    expect(() =>
      chunkDocument([source("REG-1", "regulatory_text", "文本")], {
        maxChars: 0,
        overlapUnits: 2,
      }),
    ).toThrow(/maxChars/);
    expect(() =>
      chunkDocument([source("REG-1", "regulatory_text", "文本")], {
        maxChars: 24_000,
        overlapUnits: -1,
      }),
    ).toThrow(/overlapUnits/);
  });
});
