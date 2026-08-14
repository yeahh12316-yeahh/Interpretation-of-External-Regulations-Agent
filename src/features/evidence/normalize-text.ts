const PROTECTED_TOKEN_CHARACTER = /[A-Za-z0-9〇零一二三四五六七八九两]/u;

const shouldPreserveWhitespace = (
  previous: string | undefined,
  next: string | undefined,
): boolean =>
  Boolean(
    previous &&
    next &&
    PROTECTED_TOKEN_CHARACTER.test(previous) &&
    PROTECTED_TOKEN_CHARACTER.test(next),
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
  "万亿元|千亿元|百亿元|亿元|千万元|百万元|万元|元|%|‰|项|个|次|笔|家|人|倍|年|月|日|条|万|亿";

const VALUE_PATTERN =
  "(?:\\d+(?:,\\d{3})*(?:\\.\\d+)?|[〇零一二三四五六七八九十百千万亿兆两]+(?:点[〇零一二三四五六七八九两]+)?)";
const UNIT_VALUE_PATTERN =
  "(?:\\d+(?:,\\d{3})*(?:\\.\\d+)?|[〇零一二三四五六七八九十百千万亿兆两]+?(?:点[〇零一二三四五六七八九两]+)?)";

const chineseInteger = (value: string): bigint | null => {
  if (!value) return null;
  if (![...value].some((character) => "十百千万亿兆".includes(character))) {
    const digits = [...value].map((character) => CHINESE_DIGITS[character]);
    return digits.some((digit) => digit === undefined)
      ? null
      : BigInt(digits.join(""));
  }
  for (const [unit, multiplier] of [
    ["兆", 1_000_000_000_000n],
    ["亿", 100_000_000n],
    ["万", 10_000n],
  ] as const) {
    const unitIndex = value.indexOf(unit);
    if (unitIndex >= 0) {
      const left = value.slice(0, unitIndex);
      const right = value.slice(unitIndex + 1);
      const leftValue = left ? chineseInteger(left) : 1n;
      const rightValue = right ? chineseInteger(right) : 0n;
      return leftValue === null || rightValue === null
        ? null
        : leftValue * multiplier + rightValue;
    }
  }

  let section = 0n;
  let number = 0n;
  for (const character of value) {
    const digit = CHINESE_DIGITS[character];
    if (digit !== undefined) {
      number = BigInt(digit);
      continue;
    }
    const smallUnit = CHINESE_SMALL_UNITS[character];
    if (smallUnit) {
      section += (number || 1n) * BigInt(smallUnit);
      number = 0n;
      continue;
    }
    return null;
  }
  return section + number;
};

const normalizedDecimal = (value: string): string | null => {
  const nfkc = value.normalize("NFKC").replaceAll(",", "");
  if (/^\d+(?:\.\d+)?$/u.test(nfkc)) {
    const [integer, fraction = ""] = nfkc.split(".");
    const cleanInteger = integer.replace(/^0+(?=\d)/u, "") || "0";
    const cleanFraction = fraction.replace(/0+$/u, "");
    return cleanFraction ? `${cleanInteger}.${cleanFraction}` : cleanInteger;
  }
  const [integerPart, fractionPart] = nfkc.split("点");
  const integer = chineseInteger(integerPart);
  if (integer === null) return null;
  if (fractionPart === undefined) return integer.toString();
  const fraction = [...fractionPart]
    .map((character) => CHINESE_DIGITS[character])
    .join("");
  if (!fraction || !/^\d+$/u.test(fraction)) return null;
  return normalizedDecimal(`${integer}.${fraction}`);
};

const scaleDecimal = (value: string, exponent: number): string => {
  const [integer, fraction = ""] = value.split(".");
  const unscaled = BigInt(`${integer}${fraction}`);
  const scale = fraction.length - exponent;
  if (scale <= 0) return `${unscaled}${"0".repeat(-scale)}`;
  const digits = unscaled.toString().padStart(scale + 1, "0");
  return normalizedDecimal(
    `${digits.slice(0, -scale)}.${digits.slice(-scale)}`,
  )!;
};

const currencyExponent = (unit: string): number | undefined =>
  ({
    元: 0,
    万元: 4,
    百万元: 6,
    千万元: 7,
    亿元: 8,
    百亿元: 10,
    千亿元: 11,
    万亿元: 12,
  })[unit];

interface NumberMatch {
  start: number;
  end: number;
  token: string;
}

export const extractNumbers = (value: string): string[] => {
  const normalized = value.normalize("NFKC");
  const matches: NumberMatch[] = [];
  const overlaps = (start: number, end: number) =>
    matches.some((item) => start < item.end && end > item.start);
  const add = (match: RegExpMatchArray, token: string | null) => {
    const start = match.index ?? -1;
    if (start < 0) return;
    const end = start + match[0].length;
    if (token && !overlaps(start, end)) matches.push({ start, end, token });
  };

  const ratioPattern = new RegExp(
    `(百分之|千分之)\\s*(${VALUE_PATTERN})`,
    "gu",
  );
  for (const match of normalized.matchAll(ratioPattern)) {
    const number = normalizedDecimal(match[2]);
    add(
      match,
      number
        ? `${scaleDecimal(number, match[1] === "百分之" ? -2 : -3)}比例`
        : null,
    );
  }

  const unitPattern = new RegExp(
    `(${UNIT_VALUE_PATTERN})\\s*(${NUMBER_UNIT})`,
    "gu",
  );
  for (const match of normalized.matchAll(unitPattern)) {
    const number = normalizedDecimal(match[1]);
    const unit = match[2];
    if (!number) {
      add(match, null);
      continue;
    }
    const exponent = currencyExponent(unit);
    const token =
      exponent !== undefined
        ? `${scaleDecimal(number, exponent)}元`
        : unit === "%" || unit === "‰"
          ? `${scaleDecimal(number, unit === "%" ? -2 : -3)}比例`
          : unit === "万" || unit === "亿"
            ? scaleDecimal(number, unit === "万" ? 4 : 8)
            : `${number}${unit}`;
    add(match, token);
  }

  const prefixedPattern = new RegExp(
    `(人民币|￥|¥|\\$)\\s*(${VALUE_PATTERN})`,
    "gu",
  );
  for (const match of normalized.matchAll(prefixedPattern)) {
    const number = normalizedDecimal(match[2]);
    add(match, number ? `${number}${match[1] === "$" ? "美元" : "元"}` : null);
  }

  for (const match of normalized.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/gu)) {
    add(match, normalizedDecimal(match[0]));
  }

  return unique(
    matches
      .sort((left, right) => left.start - right.start)
      .map(({ token }) => token),
  );
};

const NON_MODAL_COMPOUNDS =
  /响应|供应|适应|对应|相应|应用|应急|应对|应付|应邀|应聘|应答|应验|反应/gu;

export const extractModalTerms = (value: string): string[] => {
  const normalized = value.normalize("NFKC");
  const excluded = [...normalized.matchAll(NON_MODAL_COMPOUNDS)].map(
    (match) => [match.index, match.index + match[0].length] as const,
  );
  return [
    ...normalized.matchAll(/严禁|不得|禁止|必须|应当|可以|不应|宜|须|应/gu),
  ]
    .filter(
      (match) =>
        !excluded.some(
          ([start, end]) => match.index >= start && match.index < end,
        ),
    )
    .map(([term]) => term);
};

export const protectedClaimSkeleton = (value: string): string => {
  const normalized = value.normalize("NFKC");
  const datePattern =
    /(?:\d{4}[-/.年]\s*\d{1,2}[-/.月]\s*\d{1,2}日?|[〇零一二三四五六七八九]{4}年\s*[〇零一二三四五六七八九十]{1,3}月\s*[〇零一二三四五六七八九十]{1,3}日)/gu;
  const ratioPattern = new RegExp(
    `(?:百分之|千分之)\\s*${VALUE_PATTERN}`,
    "gu",
  );
  const unitPattern = new RegExp(
    `${VALUE_PATTERN}\\s*(?:${NUMBER_UNIT})`,
    "gu",
  );
  return normalizeText(
    normalized
      .replace(datePattern, "¤日期¤")
      .replace(ratioPattern, "¤数值¤")
      .replace(unitPattern, "¤数值¤")
      .replace(/\d+(?:,\d{3})*(?:\.\d+)?/gu, "¤数值¤")
      .replace(/严禁|不得|禁止|必须|应当|可以|不应|宜|须|应/gu, "¤模态¤"),
  );
};

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
