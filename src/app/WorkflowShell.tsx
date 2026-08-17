import {
  Component,
  useEffect,
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
  hasAuthoritativeParsingEvidence,
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
import { OcrReview } from "../features/parsing/OcrReview";
import { ReviewPage } from "../features/review/ReviewPage";
import { ReportPage } from "../features/reports/ReportPage";
import { canPreviewReportDraft } from "../features/reports/report-model";
import {
  cancelReanalysis,
  completeReanalysis,
  createAnalysisVersion,
  type ReviewWorkflowState,
} from "../features/review/review-actions";
import {
  createEmptyWorkflowSession,
  sealWorkflowSession,
  workflowSessionRepository,
  type WorkflowSession,
  type WorkflowSessionRepository,
} from "./workflow-store";

export const workflowSteps: readonly { key: WorkflowStep; label: string }[] = [
  { key: "intake", label: "材料上传" },
  { key: "parsing", label: "解析与OCR" },
  { key: "analysis", label: "监管分析" },
  { key: "review", label: "人工复核" },
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
      <section role="alert" className="workflow-dialog">
        <h1 className="dialog-title">页面发生错误</h1>
        <p>最近已保存的数据仍然保留。</p>
        <button
          className="btn btn-secondary"
          type="button"
          onClick={() => this.setState({ error: null })}
        >
          重试
        </button>
        <button
          className="btn btn-primary"
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
      ? sealWorkflowSession(structuredClone(initialSession))
      : createEmptyWorkflowSession(),
  );
  const [recovering, setRecovering] = useState(initialSession === undefined);
  const [message, setMessage] = useState<{
    kind: "status" | "error";
    text: string;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [ocrReviewer, setOcrReviewer] = useState("");
  const [progress, setProgress] = useState<{
    stage: string;
    completed: number;
    total: number;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [draftReportOpen, setDraftReportOpen] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const persistenceQueue = useRef<Promise<void>>(Promise.resolve());
  const persistedRevision = useRef(session.revision);
  const analysisBaseline = useRef<string | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const currentIndex = workflowSteps.findIndex(
    ({ key }) => key === session.project.workflowStep,
  );
  const ready = useMemo(
    () => hasAuthoritativeParsingEvidence(session),
    [session],
  );
  const evidenceReady = useMemo(
    () => session.project.findings.length > 0 && canFinalizeSession(session),
    [session],
  );
  const draftReportAvailable = useMemo(
    () => canPreviewReportDraft(session) && !evidenceReady,
    [session, evidenceReady],
  );
  const hasOcrReviews = session.parseResults.some(
    ({ ocrReviews }) => ocrReviews.length > 0,
  );
  const ocrReviewerMissing = hasOcrReviews && !ocrReviewer.trim();
  const transitionContext = {
    parsingReady: ready,
    evidenceReady,
    reanalysisPending: session.pendingReanalysis !== null,
  };
  const persist = (next: WorkflowSession) => {
    const saved = sealWorkflowSession({
      ...qualityBound(next),
      revision: sessionRef.current.revision,
      lastSavedAt: new Date().toISOString(),
    });
    sessionRef.current = saved;
    setSession(saved);
    persistenceQueue.current = persistenceQueue.current
      .catch(() => undefined)
      .then(async () => {
        const latest = sessionRef.current;
        const candidate = sealWorkflowSession({
          ...latest,
          revision: persistedRevision.current,
        });
        const stored = await repository.save(
          candidate,
          persistedRevision.current,
        );
        persistedRevision.current = stored.revision;
        if (sessionRef.current.contentHash === latest.contentHash) {
          const synchronized = sealWorkflowSession({
            ...sessionRef.current,
            revision: stored.revision,
          });
          sessionRef.current = synchronized;
          setSession(synchronized);
        }
      })
      .catch(() =>
        setMessage({ kind: "error", text: "本地保存冲突或失败，请恢复后重试" }),
      );
  };
  const move = (nextStep: WorkflowStep) => {
    if (running) {
      setMessage({ kind: "error", text: "分析运行中，不能切换步骤或复核" });
      return;
    }
    setDraftReportOpen(false);
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
  useEffect(() => {
    if (initialSession !== undefined) {
      setRecovering(false);
      return;
    }
    let active = true;
    void repository
      .load(sessionRef.current.project.projectId)
      .then((restored) => {
        if (!active) return;
        if (restored) {
          persistedRevision.current = restored.revision;
          sessionRef.current = restored;
          setSession(restored);
          setMessage({ kind: "status", text: "已自动恢复最近有效保存" });
        } else {
          setMessage({
            kind: "status",
            text: "未找到最近保存，已新建本地项目",
          });
        }
      })
      .catch(() => {
        if (active)
          setMessage({
            kind: "error",
            text: "自动恢复失败：记录缺失、冲突或完整性校验未通过",
          });
      })
      .finally(() => active && setRecovering(false));
    return () => {
      active = false;
    };
  }, [initialSession, repository]);
  const handleParsed = (result: ParseResult) => {
    const current = sessionRef.current;
    if (
      result.source.sourceType === "official_interpretation" &&
      !current.project.sourceUnits.some(
        ({ sourceType }) => sourceType === "regulatory_text",
      )
    ) {
      setMessage({
        kind: "error",
        text: "请先上传监管原文，再上传并显式配对官方解读",
      });
      return;
    }
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
    const officialPrimarySourceIds = Object.fromEntries(
      sourceUnits
        .filter(({ sourceType }) => sourceType === "official_interpretation")
        .map(({ sourceId }) => [
          sourceId,
          sourceUnits
            .filter(({ sourceType }) => sourceType === "regulatory_text")
            .map(({ sourceId: regulatoryId }) => regulatoryId),
        ]),
    );
    let candidate: WorkflowSession = {
      ...current,
      parseResults,
      parsedUnits: parseResults.flatMap(({ units }) => units),
      project: {
        ...current.project,
        sourceUnits,
        parsingCompleted: true,
        findings: [],
        qualityMetrics: {
          ...current.project.qualityMetrics,
          requiredReviewCompletionRate: 0,
        },
      },
      atomicRequirements: [],
      reviewAudits: [],
      reviewActions: [],
      ruleReviewAttestations: [],
      analysisVersions: [],
      pendingReanalysis: null,
      officialPrimarySourceIds,
      selectedFindingId: null,
    };
    candidate = {
      ...candidate,
      project: {
        ...candidate.project,
        parsingCompleted: hasAuthoritativeParsingEvidence(candidate),
      },
    };
    persist(candidate);
  };
  const applyReviewState = (next: ReviewWorkflowState) => {
    if (running) {
      setMessage({ kind: "error", text: "分析运行中，复核操作已锁定" });
      return;
    }
    const current = sessionRef.current;
    persist({
      ...current,
      ...next,
      selectedFindingId: next.project.findings.some(
        ({ findingId }) => findingId === current.selectedFindingId,
      )
        ? current.selectedFindingId
        : (next.project.findings[0]?.findingId ?? null),
    });
  };
  const analysisStateToken = (value: WorkflowSession): string =>
    JSON.stringify({
      project: value.project,
      parseResults: value.parseResults,
      atomicRequirements: value.atomicRequirements,
      reviewAudits: value.reviewAudits,
      reviewActions: value.reviewActions,
      ruleReviewAttestations: value.ruleReviewAttestations,
      analysisVersions: value.analysisVersions,
      pendingReanalysis: value.pendingReanalysis,
      officialPrimarySourceIds: value.officialPrimarySourceIds,
    });
  const executeAnalysis = async () => {
    if (!hasAuthoritativeParsingEvidence(sessionRef.current)) {
      setMessage({
        kind: "error",
        text: "权威解析或 OCR 质量未通过，不能发送分析",
      });
      return;
    }
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
    const startingSession = sessionRef.current;
    controller.current = abort;
    analysisBaseline.current = analysisStateToken(startingSession);
    setRunning(true);
    setMessage(null);
    setProgress({ stage: "准备分析", completed: 0, total: 1 });
    try {
      const request = startingSession.pendingReanalysis;
      const sourceUnits = request
        ? startingSession.project.sourceUnits.filter(({ sourceId }) =>
            request.sourceIds.includes(sourceId),
          )
        : startingSession.project.sourceUnits;
      const selectedSourceIds = new Set(
        sourceUnits.map(({ sourceId }) => sourceId),
      );
      const draft = await runAnalysisImpl(
        {
          sourceUnits,
          parsedUnits: startingSession.parsedUnits.filter(({ sourceId }) =>
            selectedSourceIds.has(sourceId),
          ),
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
          officialPrimaryContext: Object.fromEntries(
            Object.entries(startingSession.officialPrimarySourceIds).filter(
              ([officialId]) => request?.sourceIds.includes(officialId) ?? true,
            ),
          ),
          reanalysisDirective: request
            ? {
                reason: request.reason,
                targetFindingIds: [...request.targetFindingIds],
                allowedStages: [...request.scope],
                allowedSourceIds: [...request.sourceIds],
                priorFindings: request.priorFindings.map((prior) => ({
                  findingId: prior.findingId,
                  category: prior.category,
                  claimType: prior.claimType,
                  atomicKind: prior.atomicKind,
                  statement: prior.statement,
                  sourceIds: [...prior.sourceIds],
                  findingHash: prior.findingHash,
                })),
              }
            : undefined,
        },
        abort.signal,
        (update: AnalysisProgress) =>
          setProgress({
            stage: update.stage,
            completed: update.completedNodes,
            total: update.totalNodes,
          }),
      );
      if (analysisBaseline.current !== analysisStateToken(sessionRef.current))
        throw new Error("analysis_state_changed");
      applyDraft(draft, sessionRef.current);
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
      analysisBaseline.current = null;
      setRunning(false);
      setProgress(null);
    }
  };
  const applyDraft = (draft: AnalysisDraft, current: WorkflowSession) => {
    if (current.pendingReanalysis) {
      persist({
        ...current,
        ...completeReanalysis(current, {
          findings: draft.findings,
          atomicRequirements: draft.atomicRequirements,
          inferenceRelationships: draft.inferenceRelationships,
          conflicts: draft.conflicts,
        }),
      });
      setMessage({ kind: "status", text: "定向重分析完成，已生成新版本" });
      return;
    }
    const createdAt = new Date().toISOString();
    persist({
      ...current,
      project: {
        ...current.project,
        findings: draft.findings,
        workflowStep: "analysis",
      },
      atomicRequirements: draft.atomicRequirements,
      selectedFindingId: draft.findings[0]?.findingId ?? null,
      reviewAudits: [],
      reviewActions: [],
      ruleReviewAttestations: [],
      analysisVersions: [
        ...current.analysisVersions,
        createAnalysisVersion({
          versionId: `V${current.analysisVersions.length + 1}`,
          projectId: current.project.projectId,
          parentVersionHash:
            current.analysisVersions.at(-1)?.versionHash ?? null,
          createdAt,
          reason: "监管分析",
          findings: draft.findings,
          atomicRequirements: draft.atomicRequirements,
          inferenceRelationships: draft.inferenceRelationships,
          conflicts: draft.conflicts,
          replacedFindingIds: draft.findings.map(({ findingId }) => findingId),
          sourceIds: current.project.sourceUnits.map(
            ({ sourceId }) => sourceId,
          ),
          scope: [
            "document_identity",
            "key_matters",
            "atomic_clauses",
            "institution_impact",
          ],
          reanalysisProvenance: null,
        }),
      ],
    });
    setMessage({ kind: "status", text: "监管分析完成" });
  };
  const cancelActiveAnalysis = () => {
    controller.current?.abort();
    const current = sessionRef.current;
    if (current.pendingReanalysis) {
      persist({ ...current, ...cancelReanalysis(current) });
    }
  };
  const restore = async () => {
    try {
      const restored = await repository.load(session.project.projectId);
      if (!restored) throw new Error("missing");
      persistedRevision.current = restored.revision;
      sessionRef.current = restored;
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
  const workflowStateLabel =
    session.project.workflowStep === "intake"
      ? "等待上传材料"
      : session.project.workflowStep === "parsing"
        ? "解析与OCR校验中"
        : session.project.workflowStep === "analysis"
          ? "AI监管分析草稿"
          : session.project.workflowStep === "review"
            ? "待合规复核"
            : "报告导出";
  const selectFinding = (id: string | null) => {
    if (running) return;
    const current = sessionRef.current;
    persist({ ...current, selectedFindingId: id });
  };
  const page = draftReportOpen ? (
    <>
      <ReportPage session={session} />
      <button
        className="btn btn-secondary"
        type="button"
        onClick={() => setDraftReportOpen(false)}
      >
        返回人工复核
      </button>
    </>
  ) : recovering ? (
    <section className="workflow-step-page screen active" aria-live="polite">
      <div className="title">
        <h1 className="workflow-section-title">正在恢复最近保存</h1>
        <p className="analysis-subtitle">
          正在校验本地工作流版本、解析证据与复核链。
        </p>
      </div>
    </section>
  ) : session.project.workflowStep === "intake" ? (
    <section className="workflow-step-page screen active">
      <div className="title">
        <h1 className="workflow-section-title">材料上传</h1>
        <p className="analysis-subtitle">监管文件必填，官方解读选填；文件仅在浏览器本地解析。</p>
      </div>
      <p className="helper-text">材料版本、效力与重大判断需合规复核。</p>
      <MaterialUpload parseFile={parseFile} onParsed={handleParsed} />
    </section>
  ) : session.project.workflowStep === "parsing" ? (
    <section className="workflow-step-page screen active">
      <div className="title">
        <h1 className="workflow-section-title">解析与OCR</h1>
        <p className="analysis-subtitle">确认解析质量后，再进入监管分析。</p>
      </div>
      {hasOcrReviews ? (
        <label className="ocr-reviewer">
          OCR复核人
          <input
            aria-label="OCR复核人"
            aria-describedby={
              ocrReviewerMissing ? "ocr-reviewer-required" : undefined
            }
            aria-invalid={ocrReviewerMissing}
            value={ocrReviewer}
            onChange={(event) => setOcrReviewer(event.target.value)}
          />
          {ocrReviewerMissing ? (
            <p id="ocr-reviewer-required" role="alert">
              请先填写 OCR 复核人
            </p>
          ) : null}
        </label>
      ) : null}
      {session.parseResults.map((result) => (
        <article key={result.source.sourceId}>
          <h2 className="analysis-subtitle">{result.source.title}</h2>
          <p>
            {result.quality.finalizationBlocked
              ? "解析或 OCR 质量未通过"
              : "解析质量通过"}
          </p>
          <p>
            解析段落 {result.units.length}；失败页 {result.failedPages.length}
          </p>
          {result.ocrReviews.map((review) => (
            <OcrReview
              key={review.unitId}
              result={result}
              reviewId={review.unitId}
              reviewer={ocrReviewer}
              onChange={handleParsed}
            />
          ))}
        </article>
      ))}
      {!ready ? (
        <p role="alert">解析或 OCR 质量未通过，不能进入监管分析。</p>
      ) : null}
    </section>
  ) : session.project.workflowStep === "analysis" ? (
    <>
      <AnalysisPage
        state={session}
        selectedFindingId={session.selectedFindingId}
        onSelectedFindingIdChange={selectFinding}
        onRun={() => void executeAnalysis()}
        onCancel={cancelActiveAnalysis}
        running={running}
        progress={progress}
      />
      {session.pendingReanalysis && !running ? (
        <button
          className="btn btn-secondary"
          type="button"
          onClick={() => {
            const current = sessionRef.current;
            persist({ ...current, ...cancelReanalysis(current) });
            setMessage({ kind: "status", text: "已取消重分析请求并恢复复核" });
          }}
        >
          取消重分析请求
        </button>
      ) : null}
    </>
  ) : session.project.workflowStep === "review" ? (
    <ReviewPage
      state={session}
      onChange={applyReviewState}
      selectedFindingId={session.selectedFindingId}
      onSelectedFindingIdChange={selectFinding}
    />
  ) : (
    <ReportPage session={session} />
  );
  return (
    <WorkflowErrorBoundary onBack={() => prior && move(prior.key)}>
        <div className="workflow-shell">
        <header className="top app-header">
          <div className="app-header-meta">
              <div className="app-project">{session.project.projectName}</div>
            <p className="app-project-subtitle">
              本地文件处理 · 用户自带模型接口
            </p>
            <span className="state-pill state">{workflowStateLabel}</span>
          </div>
          <div className="app-header-actions">
            <button
              className="btn btn-secondary"
              disabled={running || recovering}
              type="button"
              onClick={() => setSettingsOpen(true)}
            >
              模型接口设置
            </button>
            <button
              className="btn btn-secondary"
              disabled={running || recovering}
              type="button"
              onClick={() => void restore()}
            >
              恢复最近保存
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={running || recovering}
              onClick={() => move("report")}
            >
              查看报告
            </button>
          </div>
        </header>
        <div
          className={
            session.project.workflowStep === "analysis" ||
            session.project.workflowStep === "review"
              ? "shell workflow-frame with-evidence"
              : "shell workflow-frame"
          }
        >
          <nav aria-label="外规解读工作流" className="side workflow-sidebar">
            <div className="logo">Deloitte<i>.</i></div>
            <h1 className="agent">外规解读agent</h1>
            <div className="side-label">工作流程</div>
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
                      className={`nav ${key === session.project.workflowStep ? "active" : ""}`}
                      aria-current={
                        key === session.project.workflowStep
                          ? "step"
                          : undefined
                      }
                      data-allowed={gate.allowed}
                      disabled={running || recovering}
                      type="button"
                      onClick={() => move(key)}
                    >
                      <span className="n">{index + 1}</span>
                      {label}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <main className="main app-content">
            {message ? (
              <p role={message.kind === "error" ? "alert" : "status"}>
                {message.text}
              </p>
            ) : null}
            {page}
            <footer className="page-controls">
              {session.project.workflowStep === "review" &&
              draftReportAvailable &&
              !draftReportOpen ? (
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={running || recovering}
                  onClick={() => setDraftReportOpen(true)}
                >
                  预览/导出 AI 草稿
                </button>
              ) : null}
              <button
                className="btn btn-secondary"
                disabled={!prior || running || recovering}
                type="button"
                onClick={() => prior && move(prior.key)}
              >
                上一步
              </button>
              <button
                className="btn btn-primary"
                disabled={!next || !nextGate.allowed || running || recovering}
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
