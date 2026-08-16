const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

export const resolveProductionBaseUrl = (raw) => {
  const candidate = raw?.trim();
  if (!candidate)
    throw new Error(
      "PRODUCTION_BASE_URL is required; production smoke has no local fallback",
    );
  const url = new URL(candidate);
  if (url.protocol !== "https:")
    throw new Error("PRODUCTION_BASE_URL must use HTTPS");
  if (LOCAL_HOSTS.has(url.hostname))
    throw new Error("PRODUCTION_BASE_URL must be a deployed, non-local host");
  url.hash = "";
  url.search = "";
  return url.href;
};
