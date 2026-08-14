import {
  abortError,
  isAbortError,
  raceWithAbort,
  throwIfAborted,
} from "../../lib/abort";

export async function hashFile(
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);

  try {
    const bytes = await raceWithAbort(
      Promise.resolve().then(() => file.arrayBuffer()),
      signal,
    );
    if (!globalThis.crypto?.subtle) throw new Error("Web Crypto unavailable");
    const digest = await raceWithAbort(
      globalThis.crypto.subtle.digest("SHA-256", bytes),
      signal,
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw abortError();
    }
    throw new Error("无法计算文件哈希");
  }
}
