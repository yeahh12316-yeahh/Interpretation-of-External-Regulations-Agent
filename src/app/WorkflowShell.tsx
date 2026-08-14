import {
  Component,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type JSX,
  type ReactNode,
} from "react";

import type { WorkflowStep } from "../domain/project";
import { canTransition } from "../domain/state-machine";
import { AnalysisPage } from "../features/analysis/AnalysisPage";
import {
  runAnalysis,
  type AnalysisDraft,
  type AnalysisProgress,
} from "../features/analysis/skill-orchestrator";
import {
  calculateSessionQuality,
  canFinalizeSession,
} from "../features/evidence/calculate-quality";
import {
  MaterialUpload,
  type MaterialUploadProps,
} from "../features/intake/MaterialUpload";
import {
  ApiSettingsDialog,
  ThirdPartyDataFlowDialog,
} from "../features/model/ApiSettingsDialog";
import { DEFAULT_MODEL_CONFIG } from "../features/model/model-config";
import {
  ModelGatewayError,
  modelErrorMessage,
} from "../features/model/model-errors";
import {
  modelDataFlowConsent,
  createModelGateway,
} from "../features/model/model-gateway";
import { sessionCredentials } from "../features/model/session-credentials";
import type { ParseResult } from "../features/parsing/parse-document";
import { ReviewPage } from "../features/review/ReviewPage";
import {
  completeReanalysis,
  type ReviewWorkflowState,
} from "../features/review/review-actions";
import {
  createEmptyWorkflowSession,
  workflowSessionRepository,
  type WorkflowSession,
  type WorkflowSessionRepository,
} from "./workflow-store";

export const workflowSteps: readonly { key: WorkflowStep; label: string }[] = [
  { key: "intake", label: "材料上传" },
  { key: "parsing", label: "解析与OCR" },
  { key: "analysis", label: "监管分析" },
  { key: "review", label: "人工复核与修正" },
  { key: "report", label: "报告导出" },
];

interface ErrorBoundaryProps {
  children: ReactNode;
  onBack: () => void;
}
interface ErrorBoundaryState {
  error: Error | null;
}
export class WorkflowErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    /* UI-only boundary: never log sensitive state. */
  }
  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <section role="alert">
        <h1>页面发生错误</h1>
        <p>最近已保存的数据仍然保留。</p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          重试
        </button>
        <button
          type="button"
          onClick={() => {
            this.setState({ error: null });
            this.props.onBack();
          }}
        >
          返回上一步
        </button>
      </section>
    );
  }
}

export interface WorkflowShellProps {
  initialSession?: WorkflowSession;
  repository?: WorkflowSessionRepository;
  parseFile?: MaterialUploadProps["parseFile"];
  runAnalysisImpl?: typeof runAnalysis;
}

const parsingReady = (session: WorkflowSession): boolean => {
  if (
    !session.project.sourceUnits.length ||
    session.parseResults.length !== session.project.sourceUnits.length
  )
    return false;
  return session.parseResults.every(
    (result) =>
      result.source.sourceId &&
      session.project.sourceUnits.some(
        ({ sourceId, sourceType }) =>
          sourceId === result.source.sourceId &&
          sourceType === result.source.sourceType,
      ) &&
      !result.quality.finalizationBlocked &&
      result.failedPages.length === 0 &&
      result.quality.failedPageCount === 0 &&
      result.quality.ocrFailedPages.length === 0 &&
      result.quality.extractionCoverage === 1 &&
      result.units.length > 0 &&
      result.quality.lowTextPages.every((page) =>
        result.ocrReviews.some(
          (review) =>
            review.page === page && review.reviewStatus === "corrected",
        ),
      ),
  );
};

const qualityBound = (session: WorkflowSession): WorkflowSession => {
  if (!session.project.findings.length) return session;
  const metrics = calculateSessionQuality(session);
  return {
    ...session,
    project: {
      ...session.project,
      qualityMetrics: {
        factCitationCoverage: metrics.factCitationCoverage,
        citationReverseCheckRate: metrics.citationReverseCheckRate,
        unsupportedFindingCount: metrics.unsupportedFindingCount,
        inferenceMarkingRate: metrics.inferenceMarkingRate,
        requiredReviewCompletionRate: metrics.requiredReviewCompletionRate,
      },
    },
  };
};

export function WorkflowShell({
  initialSession,
  repository = workflowSessionRepository,
  parseFile,
  runAnalysisImpl = runAnalysis,
}: WorkflowShellProps): JSX.Element {
  const [session, setSession] = useState<WorkflowSession>(() =>
    initialSession
      ? structuredClone(initialSession)
      : createEmptyWorkflowSession(),
  );
  const [message, setMessage] = useState<{
    kind: "status" | "error";
    text: string;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{
    stage: string;
    completed: number;
    total: number;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const currentIndex = workflowSteps.findIndex(
    ({ key }) => key === session.project.workflowStep,
  );
  const ready = useMemo(() => parsingReady(session), [session]);
  const evidenceReady = useMemo(
    () => session.project.findings.length > 0 && canFinalizeSession(session),
    [session],
  );
  const transitionContext = {
    parsingReady: ready,
    evidenceReady,
    reanalysisPending: session.pendingReanalysis !== null,
  };
  const persist = (next: WorkflowSession) => {
    const saved = {
      ...qualityBound(next),
      lastSavedAt: new Date().toISOString(),
    };
    sessionRef.current = saved;
    setSession(saved);
    void repository
      .save(saved)
      .catch(() => setMessage({ kind: "error", text: "本地保存失败，请重试" }));
  };
  const move = (nextStep: WorkflowStep) => {
    const gate = canTransition(session.project, nextStep, transitionContext);
    if (!gate.allowed) {
      setMessage({ kind: "error", text: gate.reason });
      return;
    }
    setMessage(null);
    persist({
      ...session,
      project: { ...session.project, workflowStep: nextStep },
    });
  };
  const handleParsed = (result: ParseResult) => {
    const current = sessionRef.current;
    const parseResults = [
      ...current.parseResults.filter(
        ({ source }) => source.sourceType !== result.source.sourceType,
      ),
      result,
    ];
    const sourceUnits = [
      ...current.project.sourceUnits.filter(
        ({ sourceType }) => sourceType !== result.source.sourceType,
      ),
      result.source,
    ];
    const candidate: WorkflowSession = {
      ...current,
      parseResults,
      parsedUnits: parseResults.flatMap(({ units }) => units),
      project: {
        ...current.project,
        sourceUnits,
        parsingCompleted: parseResults.every(
          (item) => !item.quality.finalizationBlocked,
        ),
        findings: [],
        qualityMetrics: {
          ...current.project.qualityMetrics,
          requiredReviewCompletionRate: 0,
        },
      },
      atomicRequirements: [],
      reviewAudits: [],
      ruleReviewAttestations: [],
      analysisVersions: [],
      pendingReanalysis: null,
      selectedFindingId: null,
    };
    persist(candidate);
  };
  const applyReviewState = (next: ReviewWorkflowState) =>
    persist({
      ...session,
      ...next,
      selectedFindingId: next.project.findings.some(
        ({ findingId }) => findingId === session.selectedFindingId,
      )
        ? session.selectedFindingId
        : (next.project.findings[0]?.findingId ?? null),
    });
  const executeAnalysis = async () => {
    const credentials = sessionCredentials.get();
    if (!credentials) {
      setMessage({ kind: "error", text: "请先配置并测试模型接口" });
      setSettingsOpen(true);
      return;
    }
    if (modelDataFlowConsent.needsAcknowledgement()) {
      setConsentOpen(true);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setMessage(null);
    setProgress({ stage: "准备分析", completed: 0, total: 1 });
    try {
      const request = session.pendingReanalysis;
      const sourceUnits = request
        ? session.project.sourceUnits.filter(({ sourceId }) =>
            request.sourceIds.includes(sourceId),
          )
        : session.project.sourceUnits;
      const draft = await runAnalysisImpl(
        {
          sourceUnits,
          gateway: createModelGateway(
            {
              ...DEFAULT_MODEL_CONFIG,
              baseUrl: credentials.baseUrl,
              model: credentials.model,
            },
            credentials.apiKey,
          ),
          model: credentials.model,
          hasOfficialInterpretation: sourceUnits.some(
            ({ sourceType }) => sourceType === "official_interpretation",
          ),
          stages: request?.scope,
        },
        abort.signal,
        (update: AnalysisProgress) =>
          setProgress({
            stage: update.stage,
            completed: update.completedNodes,
            total: update.totalNodes,
          }),
      );
      applyDraft(draft);
    } catch (error) {
      if (
        abort.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      )
        setMessage({ kind: "status", text: "分析已取消，先前版本未改变" });
      else
        setMessage({
          kind: "error",
          text:
            error instanceof ModelGatewayError
              ? modelErrorMessage(error)
              : "监管分析失败，请检查模型响应、证据范围或网络后重试",
        });
    } finally {
      controller.current = null;
      setRunning(false);
      setProgress(null);
    }
  };
  const applyDraft = (draft: AnalysisDraft) => {
    if (session.pendingReanalysis) {
      persist({
        ...session,
        ...completeReanalysis(
          session,
          draft.findings.filter(({ findingId }) =>
            session.pendingReanalysis!.targetFindingIds.includes(findingId),
          ),
        ),
      });
      setMessage({ kind: "status", text: "定向重分析完成，已生成新版本" });
      return;
    }
    const createdAt = new Date().toISOString();
    persist({
      ...session,
      project: {
        ...session.project,
        findings: draft.findings,
        workflowStep: "analysis",
      },
      atomicRequirements: draft.atomicRequirements,
      selectedFindingId: draft.findings[0]?.findingId ?? null,
      reviewAudits: [],
      ruleReviewAttestations: [],
      analysisVersions: [
        ...session.analysisVersions,
        {
          versionId: `V${session.analysisVersions.length + 1}`,
          createdAt,
          reason: "监管分析",
          findings: draft.findings,
          sourceIds: session.project.sourceUnits.map(
            ({ sourceId }) => sourceId,
          ),
          scope: [
            "document_identity",
            "key_matters",
            "atomic_clauses",
            "institution_impact",
          ],
        },
      ],
    });
    setMessage({ kind: "status", text: "监管分析完成" });
  };
  const restore = async () => {
    try {
      const restored = await repository.load(session.project.projectId);
      if (!restored) throw new Error("missing");
      setSession(restored);
      setMessage({ kind: "status", text: "已恢复最近保存" });
    } catch {
      setMessage({ kind: "error", text: "恢复失败：本地记录不存在或格式无效" });
    }
  };
  const prior = workflowSteps[currentIndex - 1];
  const next = workflowSteps[currentIndex + 1];
  const nextGate = next
    ? canTransition(session.project, next.key, transitionContext)
    : { allowed: false as const, reason: "已是最后一步" };
  const page =
    session.project.workflowStep === "intake" ? (
      <section>
        <h1>材料上传</h1>
        <p>监管文件必填，官方解读选填；文件仅在浏览器本地解析。</p>
        <MaterialUpload parseFile={parseFile} onParsed={handleParsed} />
      </section>
    ) : session.project.workflowStep === "parsing" ? (
      <section>
        <h1>解析与OCR</h1>
        {session.parseResults.map((result) => (
          <article key={result.source.sourceId}>
            <h2>{result.source.title}</h2>
            <p>
              {result.quality.finalizationBlocked
                ? "解析或 OCR 质量未通过"
                : "解析质量通过"}
            </p>
            <p>
              解析段落 {result.units.length}；失败页 {result.failedPages.length}
            </p>
          </article>
        ))}
        {!ready ? (
          <p role="alert">解析或 OCR 质量未通过，不能进入监管分析。</p>
        ) : null}
      </section>
    ) : session.project.workflowStep === "analysis" ? (
      <AnalysisPage
        state={session}
        selectedFindingId={session.selectedFindingId}
        onSelectedFindingIdChange={(id) =>
          setSession((current) => ({ ...current, selectedFindingId: id }))
        }
        onRun={() => void executeAnalysis()}
        onCancel={() => controller.current?.abort()}
        running={running}
        progress={progress}
      />
    ) : session.project.workflowStep === "review" ? (
      <ReviewPage
        state={session}
        onChange={applyReviewState}
        selectedFindingId={session.selectedFindingId}
        onSelectedFindingIdChange={(id) =>
          setSession((current) => ({ ...current, selectedFindingId: id }))
        }
      />
    ) : (
      <section>
        <h1>报告导出</h1>
        <p>
          证据质量门禁已通过。报告包含复核历史与来源锚点，不包含模型 API Key。
        </p>
        <button
          type="button"
          onClick={() => {
            const blob = new Blob(
              [
                JSON.stringify(
                  {
                    project: session.project,
                    reviewAudits: session.reviewAudits,
                    ruleReviewAttestations: session.ruleReviewAttestations,
                  },
                  null,
                  2,
                ),
              ],
              { type: "application/json" },
            );
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `${session.project.projectName}-报告.json`;
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          导出报告
        </button>
      </section>
    );
  return (
    <WorkflowErrorBoundary onBack={() => prior && move(prior.key)}>
      <div className="workflow-shell">
        <header className="app-header">
          <div>
            <p className="eyebrow">Deloitte Regulatory Intelligence</p>
            <h1>外规解读agent</h1>
          </div>
          <div>
            <button type="button" onClick={() => setSettingsOpen(true)}>
              模型接口设置
            </button>
            <button type="button" onClick={() => void restore()}>
              恢复最近保存
            </button>
          </div>
        </header>
        <div className="workflow-frame">
          <nav aria-label="外规解读工作流" className="workflow-sidebar">
            <ol>
              {workflowSteps.map(({ key, label }, index) => {
                const gate = canTransition(
                  session.project,
                  key,
                  transitionContext,
                );
                return (
                  <li key={key}>
                    <button
                      aria-current={
                        key === session.project.workflowStep
                          ? "step"
                          : undefined
                      }
                      data-allowed={gate.allowed}
                      type="button"
                      onClick={() => move(key)}
                    >
                      <span>{index + 1}</span>
                      {label}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <main className="app-content">
            {message ? (
              <p role={message.kind === "error" ? "alert" : "status"}>
                {message.text}
              </p>
            ) : null}
            {page}
            <footer className="page-controls">
              <button
                disabled={!prior}
                type="button"
                onClick={() => prior && move(prior.key)}
              >
                上一步
              </button>
              <button
                disabled={!next || !nextGate.allowed}
                type="button"
                onClick={() => next && move(next.key)}
              >
                下一步
              </button>
            </footer>
          </main>
        </div>
        <ApiSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
        <ThirdPartyDataFlowDialog
          open={consentOpen}
          endpoint={sessionCredentials.get()?.baseUrl ?? ""}
          model={sessionCredentials.get()?.model ?? ""}
          onCancel={() => setConsentOpen(false)}
          onConfirm={() => {
            setConsentOpen(false);
            void executeAnalysis();
          }}
        />
      </div>
    </WorkflowErrorBoundary>
  );
}
