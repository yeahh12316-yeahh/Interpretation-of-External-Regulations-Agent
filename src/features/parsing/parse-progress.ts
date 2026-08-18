export type ParseStage =
  "validating" | "hashing" | "loading" | "extracting" | "ocr" | "finalizing";

export interface ParseProgress {
  stage: ParseStage;
  completed: number;
  total: number;
  page?: number;
  detail?: string;
}

export type ParseProgressCallback = (progress: ParseProgress) => void;
