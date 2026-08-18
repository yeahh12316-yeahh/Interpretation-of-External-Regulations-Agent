import initLiteParse, {
  LiteParse,
  type ParsedPage,
} from "@llamaindex/liteparse-wasm";
import liteParseWasmUrl from "@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm?url";

import {
  abortError,
  isAbortError,
  raceWithAbort,
  throwIfAborted,
} from "../../lib/abort";

export interface LiteParsePage {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
}

export interface LiteParsePdfResult {
  pageCount: number;
  pages: LiteParsePage[];
}

let initPromise: Promise<unknown> | undefined;

const ensureInitialized = (): Promise<unknown> => {
  initPromise ??= initLiteParse(liteParseWasmUrl);
  return initPromise;
};

const pageFrom = (page: ParsedPage): LiteParsePage => ({
  pageNumber: page.pageNum,
  width: page.width,
  height: page.height,
  text: page.text,
});

/**
 * Recover pages whose PDF.js text layer is malformed or unsupported.
 *
 * LiteParse is deliberately used only as a fallback. It runs locally in a
 * WASM module and does not upload bytes or require the model API key. OCR is
 * still handled by the existing local Tesseract pipeline for scanned pages.
 */
export async function parsePdfWithLiteParse(
  bytes: ArrayBuffer,
  signal: AbortSignal,
): Promise<LiteParsePdfResult> {
  throwIfAborted(signal);
  try {
    await raceWithAbort(ensureInitialized(), signal);
    throwIfAborted(signal);
    const parser = new LiteParse({
      ocrEnabled: false,
      outputFormat: "json",
      quiet: true,
    });
    try {
      const result = await raceWithAbort(
        parser.parse(new Uint8Array(bytes)),
        signal,
      );
      return {
        pageCount: result.totalPages,
        pages: result.pages.map(pageFrom),
      };
    } finally {
      parser.free();
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError();
    throw new Error("LiteParse PDF 备用解析失败");
  }
}
