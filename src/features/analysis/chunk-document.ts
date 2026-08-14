import type { SourceType, SourceUnit } from "../../domain/source";

export interface ChunkOptions {
  maxChars: number;
  overlapUnits: number;
}

export interface ChunkSourceUnit extends SourceUnit {
  segmentId: string;
  sourceStartOffset: number;
  sourceEndOffset: number;
}

export interface DocumentChunk {
  chunkId: string;
  sourceType: SourceType;
  units: ChunkSourceUnit[];
  inputSourceIds: string[];
  characterCount: number;
}

const sourceTypeOrder: readonly SourceType[] = [
  "regulatory_text",
  "official_interpretation",
];

const segmentSource = (
  source: SourceUnit,
  sourceIndex: number,
  maxSegmentChars: number,
): ChunkSourceUnit[] => {
  if (source.content.length === 0) {
    return [
      {
        ...source,
        segmentId: `${source.sourceId}:${sourceIndex}:0`,
        sourceStartOffset: 0,
        sourceEndOffset: 0,
      },
    ];
  }

  const segments: ChunkSourceUnit[] = [];
  for (
    let start = 0, segmentIndex = 0;
    start < source.content.length;
    segmentIndex += 1
  ) {
    const end = Math.min(start + maxSegmentChars, source.content.length);
    segments.push({
      ...source,
      content: source.content.slice(start, end),
      segmentId: `${source.sourceId}:${sourceIndex}:${segmentIndex}`,
      sourceStartOffset: start,
      sourceEndOffset: end,
    });
    start = end;
  }
  return segments;
};

const uniqueSourceIds = (units: readonly ChunkSourceUnit[]): string[] => [
  ...new Set(units.map((unit) => unit.sourceId)),
];

export function chunkDocument(
  units: readonly SourceUnit[],
  options: ChunkOptions,
): DocumentChunk[] {
  if (!Number.isInteger(options.maxChars) || options.maxChars < 1) {
    throw new Error("maxChars 必须为正整数");
  }
  if (!Number.isInteger(options.overlapUnits) || options.overlapUnits < 0) {
    throw new Error("overlapUnits 必须为非负整数");
  }

  // Splitting to at most 1/(overlap + 1) of the budget guarantees that the
  // requested overlap and at least one new segment can coexist under maxChars.
  const maxSegmentChars = Math.max(
    1,
    Math.floor(options.maxChars / (options.overlapUnits + 1)),
  );
  const chunks: DocumentChunk[] = [];

  for (const sourceType of sourceTypeOrder) {
    const segments = units
      .map((unit, sourceIndex) => ({ unit, sourceIndex }))
      .filter(({ unit }) => unit.sourceType === sourceType)
      .flatMap(({ unit, sourceIndex }) =>
        segmentSource(unit, sourceIndex, maxSegmentChars),
      );
    let start = 0;
    let chunkIndex = 0;

    while (start < segments.length) {
      let end = start;
      let characterCount = 0;
      while (
        end < segments.length &&
        characterCount + segments[end].content.length <= options.maxChars
      ) {
        characterCount += segments[end].content.length;
        end += 1;
      }

      if (end === start) {
        throw new Error("无法在 maxChars 限制内生成分块");
      }

      const chunkUnits = segments.slice(start, end);
      chunks.push({
        chunkId: `${sourceType}:${chunkIndex}`,
        sourceType,
        units: chunkUnits,
        inputSourceIds: uniqueSourceIds(chunkUnits),
        characterCount,
      });
      chunkIndex += 1;

      if (end === segments.length) break;
      start = Math.max(start + 1, end - options.overlapUnits);
    }
  }

  return chunks;
}
