import { lookup as lookupDns } from "node:dns/promises";
import { isIP } from "node:net";

const ipv4Integer = (address) =>
  address
    .split(".")
    .map(Number)
    .reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);

const ipv4InCidr = (address, base, prefix) => {
  const shift = 32 - prefix;
  return ipv4Integer(address) >>> shift === ipv4Integer(base) >>> shift;
};

const NON_GLOBAL_IPV4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const GLOBAL_IPV4_EXCEPTIONS = new Set(["192.0.0.9", "192.0.0.10"]);

const isGlobalIpv4 = (address) =>
  GLOBAL_IPV4_EXCEPTIONS.has(address) ||
  !NON_GLOBAL_IPV4.some(([base, prefix]) => ipv4InCidr(address, base, prefix));

const ipv6Integer = (address) => {
  const normalized = address.replace(/^\[|\]$/gu, "").toLowerCase();
  const [left = "", right = ""] = normalized.split("::");
  if (normalized.split("::").length > 2) throw new Error("invalid IPv6");
  const expandSide = (side) =>
    side
      ? side.split(":").flatMap((part) => {
          if (isIP(part) !== 4) return [part];
          const value = ipv4Integer(part);
          return [
            ((value >>> 16) & 0xffff).toString(16),
            (value & 0xffff).toString(16),
          ];
        })
      : [];
  const leftParts = expandSide(left);
  const rightParts = expandSide(right);
  const missing = 8 - leftParts.length - rightParts.length;
  if (
    missing < 0 ||
    (!normalized.includes("::") && missing !== 0) ||
    [...leftParts, ...rightParts].some((part) => !/^[0-9a-f]{1,4}$/u.test(part))
  )
    throw new Error("invalid IPv6");
  const parts = [
    ...leftParts,
    ...Array.from({ length: missing }, () => "0"),
    ...rightParts,
  ];
  return parts.reduce(
    (value, part) => (value << 16n) | BigInt(Number.parseInt(part, 16)),
    0n,
  );
};

const ipv6InCidr = (address, base, prefix) => {
  const shift = BigInt(128 - prefix);
  return ipv6Integer(address) >> shift === ipv6Integer(base) >> shift;
};

const NON_GLOBAL_IPV6 = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

// IANA's 2001::/23 protocol-assignment block is not globally reachable by
// default. Keep the small, explicitly globally reachable assignments closed.
const GLOBAL_IETF_PROTOCOL_IPV6 = [
  ["2001:1::1", 128],
  ["2001:1::2", 128],
  ["2001:1::3", 128],
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:20::", 28],
  ["2001:30::", 28],
];

const isGlobalIpv6 = (address) =>
  ipv6InCidr(address, "2000::", 3) &&
  (!ipv6InCidr(address, "2001::", 23) ||
    GLOBAL_IETF_PROTOCOL_IPV6.some(([base, prefix]) =>
      ipv6InCidr(address, base, prefix),
    )) &&
  !NON_GLOBAL_IPV6.some(([base, prefix]) => ipv6InCidr(address, base, prefix));

export const isGlobalUnicastIp = (address) => {
  const normalized = address.replace(/^\[|\]$/gu, "");
  const version = isIP(normalized);
  if (version === 4) return isGlobalIpv4(normalized);
  if (version === 6) return isGlobalIpv6(normalized);
  return false;
};

const isNonPublicHost = (hostname) => {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa") ||
    normalized.endsWith(".example") ||
    normalized.endsWith(".invalid") ||
    normalized.endsWith(".test")
  )
    return true;
  const unbracketed = normalized.replace(/^\[|\]$/gu, "");
  const version = isIP(unbracketed);
  if (version !== 0) return !isGlobalUnicastIp(unbracketed);
  return !normalized.includes(".");
};

export const resolveProductionBaseUrl = (raw) => {
  const candidate = raw?.trim();
  if (!candidate)
    throw new Error(
      "PRODUCTION_BASE_URL is required; production smoke has no local fallback",
    );
  const url = new URL(candidate);
  if (url.protocol !== "https:")
    throw new Error("PRODUCTION_BASE_URL must use HTTPS");
  if (url.username || url.password)
    throw new Error("PRODUCTION_BASE_URL must not include credentials");
  if (url.search || url.hash)
    throw new Error("PRODUCTION_BASE_URL must not include query or fragment");
  if (isNonPublicHost(url.hostname))
    throw new Error("PRODUCTION_BASE_URL must be a deployed, non-local host");
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.href;
};

export const resolveAndValidateProductionBaseUrl = async (
  raw,
  lookup = lookupDns,
) => {
  const resolved = resolveProductionBaseUrl(raw);
  const url = new URL(resolved);
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(hostname) !== 0) return resolved;
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("PRODUCTION_BASE_URL DNS resolution failed");
  }
  if (!Array.isArray(records) || records.length === 0)
    throw new Error("PRODUCTION_BASE_URL DNS resolution failed");
  if (
    records.some(
      (record) =>
        !record ||
        typeof record.address !== "string" ||
        !isGlobalUnicastIp(record.address),
    )
  )
    throw new Error("PRODUCTION_BASE_URL DNS returned a non-global address");
  return resolved;
};
