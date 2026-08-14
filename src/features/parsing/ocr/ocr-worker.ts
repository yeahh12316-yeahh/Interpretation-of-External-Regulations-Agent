import { createWorker, OEM } from "tesseract.js";

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
    workerPath: sameOriginOcrUrl("ocr/tesseract/worker.min.js"),
    corePath: sameOriginOcrUrl("ocr/tesseract-core/"),
    langPath: sameOriginOcrUrl("ocr/lang/"),
    workerBlobURL: false,
    logger: ({ status, progress }) => onProgress({ status, progress }),
  });
}
