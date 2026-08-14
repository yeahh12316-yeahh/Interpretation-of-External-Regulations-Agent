const abortError = (): DOMException =>
  new DOMException("文件处理已取消", "AbortError");

export async function hashFile(
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw abortError();

  try {
    const bytes = await file.arrayBuffer();
    if (signal?.aborted) throw abortError();
    if (!globalThis.crypto?.subtle) throw new Error("Web Crypto unavailable");
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    if (signal?.aborted) throw abortError();
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw abortError();
    }
    throw new Error("无法计算文件哈希");
  }
}
