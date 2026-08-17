import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type JSX,
  useEffect,
  useRef,
  useState,
} from "react";

import type { SourceType } from "../../domain/source";
import { parseDocument, type ParseResult } from "../parsing/parse-document";

type UploadStatus =
  "idle" | "parsing" | "complete" | "blocked" | "cancelled" | "error";

interface UploadState {
  status: UploadStatus;
  file?: File;
  result?: ParseResult;
  error?: string;
}

const EMPTY_STATE: UploadState = { status: "idle" };
const SOURCE_LABEL: Record<SourceType, string> = {
  regulatory_text: "监管文件",
  official_interpretation: "官方解读",
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const fileType = (file: File): string =>
  file.name.split(".").pop()?.toUpperCase() ?? "未知";

export interface MaterialUploadProps {
  parseFile?: typeof parseDocument;
  onParsed?: (result: ParseResult) => void;
}

export function MaterialUpload({
  parseFile = parseDocument,
  onParsed,
}: MaterialUploadProps = {}): JSX.Element {
  const [uploads, setUploads] = useState<Record<SourceType, UploadState>>({
    regulatory_text: EMPTY_STATE,
    official_interpretation: EMPTY_STATE,
  });
  const controllers = useRef<Record<SourceType, AbortController | null>>({
    regulatory_text: null,
    official_interpretation: null,
  });

  useEffect(
    () => () => {
      controllers.current.regulatory_text?.abort();
      controllers.current.official_interpretation?.abort();
    },
    [],
  );

  const update = (sourceType: SourceType, state: UploadState) => {
    setUploads((current) => ({ ...current, [sourceType]: state }));
  };

  const processFile = async (
    file: File | undefined,
    sourceType: SourceType,
  ) => {
    if (!file) return;
    controllers.current[sourceType]?.abort();
    const controller = new AbortController();
    controllers.current[sourceType] = controller;
    update(sourceType, { status: "parsing", file });

    try {
      const result = await parseFile(file, sourceType, controller.signal);
      if (
        !controller.signal.aborted &&
        controllers.current[sourceType] === controller
      ) {
        update(sourceType, {
          status: result.quality.finalizationBlocked ? "blocked" : "complete",
          file,
          result,
        });
        onParsed?.(result);
      }
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        if (controllers.current[sourceType] === controller) {
          update(sourceType, { status: "cancelled", file });
        }
      } else if (controllers.current[sourceType] === controller) {
        update(sourceType, {
          status: "error",
          file,
          error: error instanceof Error ? error.message : "文件处理失败",
        });
      }
    }
  };

  const cancel = (sourceType: SourceType) => {
    const controller = controllers.current[sourceType];
    controller?.abort();
    const file = uploads[sourceType].file;
    update(sourceType, { status: "cancelled", file });
  };

  const selected =
    (sourceType: SourceType) => (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      void processFile(file, sourceType);
    };

  const dropped =
    (sourceType: SourceType) => (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      void processFile(event.dataTransfer.files[0], sourceType);
    };

  const pasted =
    (sourceType: SourceType) => (event: ClipboardEvent<HTMLElement>) => {
      const file = event.clipboardData.files[0];
      if (file) {
        event.preventDefault();
        void processFile(file, sourceType);
      }
    };

  const uploadRegion = (
    sourceType: SourceType,
    required: boolean,
  ): JSX.Element => {
    const state = uploads[sourceType];
    const label = SOURCE_LABEL[sourceType];
    return (
      <section
        className="upload-box"
        aria-label={`${label}上传`}
        data-testid={`${sourceType}-upload-state`}
        data-finalization-ready={state.status === "complete"}
        onPaste={pasted(sourceType)}
      >
        <h2 className="upload-box-title">
          {label} <small className={required ? "required" : "optional"}>{required ? "必填" : "选填"}</small>
        </h2>
        <div
          className="upload-drop-zone"
          data-testid="drop-zone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={dropped(sourceType)}
        >
          <label className="upload-control-label">
            {`选择${label}`}
            <input
              accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
              aria-label={`选择${label}`}
              onChange={selected(sourceType)}
              required={required}
              type="file"
            />
          </label>
          <p>可拖拽、选择或粘贴 PDF、DOCX、TXT 文件</p>
        </div>

        {state.file ? (
          <dl className="upload-meta">
            <dt>文件名</dt>
            <dd>{state.file.name}</dd>
            <dt>类型</dt>
            <dd>{fileType(state.file)}</dd>
            <dt>大小</dt>
            <dd>{formatBytes(state.file.size)}</dd>
            <dt>来源</dt>
            <dd>{label}</dd>
            {state.result ? (
              <>
                <dt>SHA-256</dt>
                <dd>{state.result.fileHash}</dd>
                <dt>页数</dt>
                <dd>{state.result.pageCount ?? "无固定页码"}</dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {state.status === "parsing" ? (
          <div className="upload-status" role="status">
            正在浏览器内解析…
            <button
              className="btn btn-small"
              onClick={() => cancel(sourceType)}
              type="button"
            >
              {`取消解析 ${state.file?.name ?? label}`}
            </button>
          </div>
        ) : null}
        {state.status === "cancelled" ? (
          <p className="upload-notice" role="status">
            已取消解析
          </p>
        ) : null}
        {state.status === "complete" ? (
          <p className="upload-notice success" role="status">
            解析完成
          </p>
        ) : null}
        {state.status === "blocked" && state.result ? (
          <div className="upload-alert" role="alert">
            <p>解析质量未通过，禁止进入定稿</p>
            <p>
              OCR 失败页：
              {state.result.quality.ocrFailedPages.length > 0
                ? state.result.quality.ocrFailedPages.join("、")
                : "无"}
            </p>
            <p>
              全部失败页：
              {state.result.failedPages.length > 0
                ? state.result.failedPages.map(({ page }) => page).join("、")
                : "无"}
            </p>
          </div>
        ) : null}
        {state.status === "error" ? (
          <p className="upload-alert" role="alert">
            {state.error}
          </p>
        ) : null}
      </section>
    );
  };

  return (
    <div
      className="upload-grid"
      data-testid="material-upload-grid"
    >
      {uploadRegion("regulatory_text", true)}
      {uploadRegion("official_interpretation", false)}
    </div>
  );
}
