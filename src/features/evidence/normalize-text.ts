const NUMERIC_DIGIT = /[0-9〇零一二三四五六七八九两]/u;

const shouldPreserveWhitespace = (
  previous: string | undefined,
  next: string | undefined,
): boolean =>
  Boolean(
    previous &&
    next &&
    NUMERIC_DIGIT.test(previous) &&
    NUMERIC_DIGIT.test(next),
  );

export const normalizeText = (value: string): string => {
  const normalized = value.normalize("NFKC");
  return normalized
    .replace(/\s+/gu, (whitespace, offset: number) => {
      const previous = normalized.slice(0, offset).match(/\S(?=\s*$)/u)?.[0];
      const next = normalized
        .slice(offset + whitespace.length)
        .match(/^\s*(\S)/u)?.[1];
      return shouldPreserveWhitespace(previous, next) ? " " : "";
    })
    .trim();
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const CHINESE_SMALL_UNITS: Readonly<Record<string, number>> = {
  十: 10,
  百: 100,
  千: 1_000,
};

const chineseNumber = (value: string): number | null => {
  if (!value) return null;
  if (![...value].some((character) => "十百千万亿兆".includes(character))) {
    const digits = [...value].map((character) => CHINESE_DIGITS[character]);
    return digits.some((digit) => digit === undefined)
      ? null
      : Number(digits.join(""));
  }

  let total = 0;
  let section = 0;
  let number = 0;
  for (const character of value) {
    const digit = CHINESE_DIGITS[character];
    if (digit !== undefined) {
      number = digit;
      continue;
    }
    const smallUnit = CHINESE_SMALL_UNITS[character];
    if (smallUnit) {
      section += (number || 1) * smallUnit;
      number = 0;
      continue;
    }
    const largeUnit =
      character === "万" ? 10_000 : character === "亿" ? 100_000_000 : 0;
    if (!largeUnit) return null;
    section += number;
    total += (section || 1) * largeUnit;
    section = 0;
    number = 0;
  }
  return total + section + number;
};

const dateToken = (year: number, month?: number, day?: number): string => {
  const yearToken = String(year).padStart(4, "0");
  if (month === undefined) return yearToken;
  const monthToken = String(month).padStart(2, "0");
  if (day === undefined) return `${yearToken}-${monthToken}`;
  return `${yearToken}-${monthToken}-${String(day).padStart(2, "0")}`;
};

export const extractDates = (value: string): string[] => {
  const normalized = value.normalize("NFKC");
  const matches: Array<{ index: number; token: string }> = [];
  const collect = (
    pattern: RegExp,
    convert: (match: RegExpMatchArray) => string | null,
  ) => {
    for (const match of normalized.matchAll(pattern)) {
      const token = convert(match);
      if (token) matches.push({ index: match.index, token });
    }
  };

  collect(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/gu, (match) =>
    dateToken(Number(match[1]), Number(match[2]), Number(match[3])),
  );
  collect(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/gu, (match) =>
    dateToken(Number(match[1]), Number(match[2]), Number(match[3])),
  );
  collect(
    /([〇零一二三四五六七八九]{4})年\s*([〇零一二三四五六七八九十]{1,3})月\s*([〇零一二三四五六七八九十]{1,3})日/gu,
    (match) => {
      const year = chineseNumber(match[1]);
      const month = chineseNumber(match[2]);
      const day = chineseNumber(match[3]);
      return year === null || month === null || day === null
        ? null
        : dateToken(year, month, day);
    },
  );
  collect(/(\d{4})年\s*(\d{1,2})月/gu, (match) =>
    dateToken(Number(match[1]), Number(match[2])),
  );
  collect(
    /([〇零一二三四五六七八九]{4})年\s*([〇零一二三四五六七八九十]{1,3})月/gu,
    (match) => {
      const year = chineseNumber(match[1]);
      const month = chineseNumber(match[2]);
      return year === null || month === null ? null : dateToken(year, month);
    },
  );
  collect(/\b(\d{4})年/gu, (match) => dateToken(Number(match[1])));
  collect(/([〇零一二三四五六七八九]{4})年/gu, (match) => {
    const year = chineseNumber(match[1]);
    return year === null ? null : dateToken(year);
  });

  return unique(
    matches
      .sort((left, right) => left.index - right.index)
      .map(({ token }) => token),
  );
};

const NUMBER_UNIT =
  "万亿元|千亿元|百亿元|亿元|千万元|百万元|万元|元|%|‰|项|个|次|笔|家|人|倍|年|月|日|条";

export const extractNumbers = (value: string): string[] => {
  const normalized = value.normalize("NFKC");
  const matches: Array<{ index: number; token: string }> = [];

  const arabicPattern = new RegExp(
    `([￥¥$]?)(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(${NUMBER_UNIT})?`,
    "gu",
  );
  for (const match of normalized.matchAll(arabicPattern)) {
    const prefix = match[1];
    const number = match[2].replaceAll(",", "");
    const unit = match[3] ?? "";
    matches.push({ index: match.index, token: `${prefix}${number}${unit}` });
  }

  const chinesePattern = new RegExp(
    `(?<![0-9])([〇零一二三四五六七八九十百千万亿兆两]+?)\\s*(${NUMBER_UNIT})`,
    "gu",
  );
  for (const match of normalized.matchAll(chinesePattern)) {
    const number = chineseNumber(match[1]);
    if (number !== null) {
      matches.push({ index: match.index, token: `${number}${match[2]}` });
    }
  }

  return unique(
    matches
      .sort((left, right) => left.index - right.index)
      .map(({ token }) => token),
  );
};

export const extractModalTerms = (value: string): string[] =>
  value
    .normalize("NFKC")
    .match(/严禁|不得|禁止|必须|应当|可以|不应|宜|须|应/gu) ?? [];

export interface TextRange {
  start: number;
  end: number;
}

/** Finds a normalized query while preserving offsets into the original text. */
export function findNormalizedTextRange(
  text: string,
  query: string,
): TextRange | null {
  const characters = [...text];
  const normalizedCharacters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const start = offset;
    offset += character.length;
    const normalized = character.normalize("NFKC");
    if (/\s/u.test(normalized)) {
      let previous: string | undefined;
      for (
        let previousIndex = index - 1;
        previousIndex >= 0;
        previousIndex -= 1
      ) {
        if (!/\s/u.test(characters[previousIndex])) {
          previous = characters[previousIndex];
          break;
        }
      }
      const next = characters
        .slice(index + 1)
        .find((item) => !/\s/u.test(item));
      if (
        shouldPreserveWhitespace(
          previous?.normalize("NFKC"),
          next?.normalize("NFKC"),
        ) &&
        normalizedCharacters.at(-1) !== " "
      ) {
        normalizedCharacters.push(" ");
        starts.push(start);
        ends.push(offset);
      }
      continue;
    }
    for (const normalizedCharacter of normalized) {
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
