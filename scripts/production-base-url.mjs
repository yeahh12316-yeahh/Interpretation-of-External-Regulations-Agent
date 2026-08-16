import { isIP } from "node:net";

const isNonPublicIpv4 = (hostname) => {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet)))
    return true;
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
};

const isNonPublicIpv6 = (hostname) => {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return true;
  const firstHextet = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (!Number.isFinite(firstHextet)) return true;
  if (firstHextet < 0x2000 || firstHextet > 0x3fff) return true;
  return normalized.startsWith("2001:db8:") || normalized === "2001:db8::";
};

const isNonPublicHost = (hostname) => {
  const normalized = hostname.toLowerCase();
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
  if (version === 4) return isNonPublicIpv4(unbracketed);
  if (version === 6) return isNonPublicIpv6(normalized);
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
