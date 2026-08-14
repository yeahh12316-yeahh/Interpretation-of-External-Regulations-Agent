export const normalizeText = (value: string): string =>
  value.normalize("NFKC").replace(/\s+/gu, "").trim();

const unique = (values: readonly string[]): string[] => [...new Set(values)];

export const extractDates = (value: string): string[] => {
  const normalized = value.normalize("NFKC");
  const patterns = [
    /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/gu,
    /\b\d{4}年\d{1,2}月\d{1,2}日/gu,
    /\b\d{4}年\d{1,2}月/gu,
    /\b\d{4}年/gu,
    /\b\d{1,2}月\d{1,2}日/gu,
  ];

  return unique(
    patterns
      .flatMap((pattern) => normalized.match(pattern) ?? [])
      .map(normalizeText),
  );
};

export const extractNumbers = (value: string): string[] =>
  unique(
    value
      .normalize("NFKC")
      .match(/\d+(?:\.\d+)?(?:%|％)?/gu)
      ?.map((item) => item.replace("％", "%")) ?? [],
  );

export const extractModalTerms = (value: string): string[] =>
  value
    .normalize("NFKC")
    .match(/严禁|不得|禁止|必须|应当|不应|可以|须|宜|应/gu) ?? [];

export interface TextRange {
  start: number;
  end: number;
}

/** Finds a normalized query while preserving offsets into the original text. */
export function findNormalizedTextRange(
  text: string,
  query: string,
): TextRange | null {
  const normalizedCharacters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;

  for (const character of text) {
    const start = offset;
    offset += character.length;
    const normalized = character.normalize("NFKC");
    for (const normalizedCharacter of normalized) {
      if (/\s/u.test(normalizedCharacter)) continue;
      normalizedCharacters.push(normalizedCharacter);
      starts.push(start);
      ends.push(offset);
    }
  }

  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return null;
  const normalizedText = normalizedCharacters.join("");
  const normalizedStart = normalizedText.indexOf(normalizedQuery);
  if (normalizedStart < 0) return null;
  const normalizedEnd = normalizedStart + [...normalizedQuery].length - 1;
  return { start: starts[normalizedStart], end: ends[normalizedEnd] };
}
