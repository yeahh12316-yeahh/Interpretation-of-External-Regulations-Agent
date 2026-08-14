const stableValue = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
};

/**
 * Stable client-side binding digest. This detects stale/tampered review input;
 * it is deliberately not described as authentication or a digital signature.
 */
export const evidenceDigest = (value: unknown): string => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(stableValue(value))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
};

export { stableValue };
