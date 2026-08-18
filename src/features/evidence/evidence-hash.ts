const appendStableValue = (value: unknown, output: string[]): void => {
  if (Array.isArray(value)) {
    output.push("[");
    value.forEach((item, index) => {
      if (index > 0) output.push(",");
      appendStableValue(item, output);
    });
    output.push("]");
    return;
  }
  if (value && typeof value === "object") {
    output.push("{");
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([key, item], index) => {
        if (index > 0) output.push(",");
        output.push(JSON.stringify(key), ":");
        appendStableValue(item, output);
      });
    output.push("}");
    return;
  }
  output.push(JSON.stringify(value) ?? "undefined");
};

const stableValue = (value: unknown): string => {
  const output: string[] = [];
  appendStableValue(value, output);
  return output.join("");
};

/**
 * Stable client-side binding digest. This detects stale/tampered review input;
 * it is deliberately not described as authentication or a digital signature.
 */
export const evidenceDigest = (value: unknown): string => {
  // Keep the existing FNV-1a 64-bit output format, but use two 32-bit limbs
  // instead of a BigInt multiply for every byte. This is materially cheaper
  // for large OCR sessions restored and saved in the browser.
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (const byte of new TextEncoder().encode(stableValue(value))) {
    low = (low ^ byte) >>> 0;
    const lowWord = low;
    const lowProduct = lowWord * 0x1b3;
    const carry = Math.floor(lowProduct / 0x100000000);
    low = lowProduct >>> 0;
    high = (high * 0x1b3 + lowWord * 0x100 + carry) >>> 0;
  }
  return `fnv1a64:${high.toString(16).padStart(8, "0")}${low
    .toString(16)
    .padStart(8, "0")}`;
};

export { stableValue };
