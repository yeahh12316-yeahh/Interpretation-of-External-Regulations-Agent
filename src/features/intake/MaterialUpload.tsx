import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type JSX,
  useRef,
  useState,
} from "react";

import type { SourceType } from "../../domain/source";
import { parseDocument, type ParseResult } from "../parsing/parse-document";

type UploadStatus = "idle" | "parsing" | "complete" | "cancelled" | "error";

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

export function MaterialUpload(): JSX.Element {
  const [uploads, setUploads] = useState<Record<SourceType, UploadState>>({
    regulatory_text: EMPTY_STATE,
    official_interpretation: EMPTY_STATE,
  });
  const controllers = useRef<Record<SourceType, AbortController | null>>({
    regulatory_text: null,
    official_interpretation: null,
  });

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
      const result = await parseDocument(file, sourceType, controller.signal);
      if (
        !controller.signal.aborted &&
        controllers.current[sourceType] === controller
      ) {
        update(sourceType, { status: "complete", file, result });
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
        aria-label={`${label}上传`}
        onPaste={pasted(sourceType)}
        style={{
          minWidth: 0,
          maxWidth: "100%",
          border: "1px solid #111",
          padding: "1rem",
        }}
      >
        <h2>
          {label} <small>{required ? "必填" : "选填"}</small>
        </h2>
        <div
          data-testid="drop-zone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={dropped(sourceType)}
          style={{
            border: "1px dashed #444",
            padding: "1rem",
            overflowWrap: "anywhere",
          }}
        >
          <label>
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
          <dl>
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
          <div role="status">
            正在浏览器内解析…
            <button onClick={() => cancel(sourceType)} type="button">
              {`取消解析 ${state.file?.name ?? label}`}
            </button>
          </div>
        ) : null}
        {state.status === "cancelled" ? <p role="status">已取消解析</p> : null}
        {state.status === "error" ? <p role="alert">{state.error}</p> : null}
      </section>
    );
  };

  return (
    <div
      data-testid="material-upload-grid"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
        gap: "1rem",
        width: "100%",
        maxWidth: "100%",
      }}
    >
      {uploadRegion("regulatory_text", true)}
      {uploadRegion("official_interpretation", false)}
    </div>
  );
}
