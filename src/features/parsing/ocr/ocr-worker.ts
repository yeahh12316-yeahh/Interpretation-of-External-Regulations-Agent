import { createWorker, OEM } from "tesseract.js";

import { OCR_ASSET_PUBLIC_PATH } from "./ocr-assets";

export interface OcrWorkerProgress {
  status: string;
  progress: number;
}

const sameOriginOcrUrl = (path: string): string => {
  const base = new URL(import.meta.env.BASE_URL, window.location.origin);
  const url = new URL(path, base);
  if (url.origin !== window.location.origin) {
    throw new Error("OCR 资源必须与应用同源");
  }
  return url.toString();
};

export async function createLocalOcrWorker(
  onProgress: (progress: OcrWorkerProgress) => void = () => undefined,
) {
  return createWorker(["chi_sim", "eng"], OEM.LSTM_ONLY, {
    workerPath: sameOriginOcrUrl(
      `${OCR_ASSET_PUBLIC_PATH}/tesseract/worker.min.js`,
    ),
    corePath: sameOriginOcrUrl(`${OCR_ASSET_PUBLIC_PATH}/tesseract-core/`),
    langPath: sameOriginOcrUrl(`${OCR_ASSET_PUBLIC_PATH}/lang/`),
    workerBlobURL: false,
    logger: ({ status, progress }) => onProgress({ status, progress }),
  });
}
