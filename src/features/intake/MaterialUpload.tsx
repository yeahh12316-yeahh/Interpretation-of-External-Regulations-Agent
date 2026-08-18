import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type JSX,
  useEffect,
  useRef,
  useState,
} from "react";

import type { SourceType, SourceUnit } from "../../domain/source";
import {
  parseDocument,
  type ParseProgress,
  type ParseResult,
} from "../parsing/parse-document";

type UploadStatus =
  "idle" | "parsing" | "complete" | "blocked" | "cancelled" | "error";

interface UploadState {
  status: UploadStatus;
  file?: File;
  result?: ParseResult;
  error?: string;
  progress?: ParseProgress;
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
  initialResults?: Partial<Record<SourceType, ParseResult>>;
  initialSources?: readonly SourceUnit[];
}

const stateFromResult = (result: ParseResult): UploadState => ({
  status: result.quality.finalizationBlocked ? "blocked" : "complete",
  result,
});

export function MaterialUpload({
  parseFile = parseDocument,
  onParsed,
  initialResults,
  initialSources = [],
}: MaterialUploadProps = {}): JSX.Element {
  const [uploads, setUploads] = useState<Record<SourceType, UploadState>>(() => ({
    regulatory_text: initialResults?.regulatory_text
      ? stateFromResult(initialResults.regulatory_text)
      : EMPTY_STATE,
    official_interpretation: initialResults?.official_interpretation
      ? stateFromResult(initialResults.official_interpretation)
      : EMPTY_STATE,
  }));
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

  useEffect(() => {
    if (!initialResults) return;
    setUploads((current) => {
      const next = { ...current };
      let changed = false;
      (Object.keys(SOURCE_LABEL) as SourceType[]).forEach((sourceType) => {
        const result = initialResults[sourceType];
        if (!result || current[sourceType].status === "parsing") return;
        if (current[sourceType].result?.fileHash === result.fileHash) return;
        next[sourceType] = {
          ...stateFromResult(result),
          file: current[sourceType].file,
        };
        changed = true;
      });
      return changed ? next : current;
    });
  }, [initialResults]);

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
    update(sourceType, {
      status: "parsing",
      file,
      progress: {
        stage: "validating",
        completed: 0,
        total: 1,
        detail: "准备检查文件",
      },
    });

    try {
      const result = await parseFile(
        file,
        sourceType,
        controller.signal,
        (progress) => {
          if (
            !controller.signal.aborted &&
            controllers.current[sourceType] === controller
          ) {
            update(sourceType, { status: "parsing", file, progress });
          }
        },
      );
      if (
        !controller.signal.aborted &&
        controllers.current[sourceType] === controller
      ) {
        update(sourceType, {
          status: result.quality.finalizationBlocked ? "blocked" : "complete",
          file,
          result,
          progress: undefined,
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
          progress: undefined,
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
    const restoredSource = initialSources.find(
      ({ sourceType: candidateType }) => candidateType === sourceType,
    );
    return (
      <section
        className="upload-box"
        aria-label={`${label}上传`}
        data-testid={`${sourceType}-upload-state`}
        data-finalization-ready={state.status === "complete"}
        onPaste={pasted(sourceType)}
      >
        <h2 className="upload-box-title">
          {label}{" "}
          <small className={required ? "required" : "optional"}>
            {required ? "必填" : "选填"}
          </small>
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

        {!state.file && !state.result && restoredSource ? (
          <div className="upload-alert" role="alert">
            已恢复来源“{restoredSource.title}”，但当前保存记录缺少权威解析证据；
            请重新选择该文件以继续。
          </div>
        ) : null}

        {state.file || state.result ? (
          <dl className="upload-meta">
            <dt>文件名</dt>
            <dd>
              {state.file?.name ?? `${state.result?.source.title ?? label}（已恢复）`}
            </dd>
            <dt>类型</dt>
            <dd>{state.file ? fileType(state.file) : "已恢复解析记录"}</dd>
            <dt>大小</dt>
            <dd>{state.file ? formatBytes(state.file.size) : "已随解析结果恢复"}</dd>
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
          <div
            className="upload-status upload-progress"
            role="status"
            aria-live="polite"
          >
            <div className="upload-progress-heading">
              <strong>{state.progress?.detail ?? "正在浏览器内解析…"}</strong>
              <span>
                {state.progress && state.progress.total > 0
                  ? `${Math.min(100, Math.round((state.progress.completed / state.progress.total) * 100))}%`
                  : "处理中"}
              </span>
            </div>
            <progress
              max={Math.max(1, state.progress?.total ?? 1)}
              value={Math.max(0, state.progress?.completed ?? 0)}
            />
            <p className="upload-progress-note">
              {state.progress?.stage === "ocr"
                ? "扫描页正在本地 OCR；首次使用会加载中文识别模型，期间可以取消。"
                : "文件只在当前浏览器内处理，不会上传到本平台。"}
            </p>
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
    <div className="upload-grid" data-testid="material-upload-grid">
      {uploadRegion("regulatory_text", true)}
      {uploadRegion("official_interpretation", false)}
    </div>
  );
}
