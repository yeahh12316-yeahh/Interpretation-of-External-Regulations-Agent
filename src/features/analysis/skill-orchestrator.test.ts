import { describe, expect, it } from "vitest";

import { FindingSchema } from "../../domain/schemas";
import type { SourceAnchor, SourceUnit } from "../../domain/source";
import {
  createModelGateway,
  modelDataFlowConsent,
  type ModelGateway,
  type StructuredModelRequest,
} from "../model/model-gateway";
import {
  AnalysisCheckpointSchema,
  AnalysisDraftSchema,
  runAnalysis,
  type AnalysisProgress,
} from "./skill-orchestrator";

const regulatorySource: SourceUnit = {
  sourceId: "REG-1",
  sourceType: "regulatory_text",
  title: "监管办法",
  content: "第一条 商业银行应当建立数据治理机制。",
};

const officialSource: SourceUnit = {
  sourceId: "OFF-1",
  sourceType: "official_interpretation",
  title: "监管办法官方解读",
  content: "本解读称该条不要求建立数据治理机制。",
};

const anchor = (
  sourceId = "REG-1",
  sourceType: SourceAnchor["sourceType"] = "regulatory_text",
): SourceAnchor => ({
  sourceId,
  sourceType,
  page: 1,
  article: "第一条",
  paragraphIndex: 0,
  quote:
    sourceType === "regulatory_text"
      ? "第一条 商业银行应当建立数据治理机制。"
      : "本解读称该条不要求建立数据治理机制。",
});

const baseFinding = {
  inferenceParents: [] as string[],
  reviewStatus: "unreviewed" as const,
  requiredReview: false,
  revisionRecords: [] as never[],
};

class RecordingGateway implements ModelGateway {
  readonly requests: StructuredModelRequest<unknown>[] = [];

  constructor(
    private readonly respond: (
      request: StructuredModelRequest<unknown>,
      callIndex: number,
    ) => unknown,
  ) {}

  async requestStructured<T>(request: StructuredModelRequest<T>): Promise<T> {
    this.requests.push(request as StructuredModelRequest<unknown>);
    return request.schema.parse(
      this.respond(
        request as StructuredModelRequest<unknown>,
        this.requests.length - 1,
      ),
    ) as T;
  }
}

const successfulResponse = (
  request: StructuredModelRequest<unknown>,
): unknown => {
  switch (request.schemaName) {
    case "analysis_document_identity_v1":
      return { findings: [], conflicts: [] };
    case "analysis_atomic_clauses_v1":
      return {
        findings: [
          {
            ...baseFinding,
            findingId: "REQ-1",
            category: "atomic_requirement",
            statement: "商业银行应当建立数据治理机制",
            claimType: "regulatory_fact",
            sourceAnchors: [anchor()],
          },
        ],
        atomicRequirements: [
          {
            requirementId: "AR-REQ-1",
            findingId: "REQ-1",
            subject: "商业银行",
            action: "建立",
            object: "数据治理机制",
            condition: null,
            frequency: null,
            deadline: null,
            strength: "应当",
            responsibility: null,
            exceptions: null,
            sharedContext: "第一条",
            missingFacts: [],
            sourceAnchors: [anchor()],
            confidence: 0.94,
            manualVerificationRequired: false,
          },
        ],
      };
    case "analysis_key_matters_v1":
      return { findings: [] };
    case "analysis_institution_impact_v1":
      return {
        findings: [
          {
            ...baseFinding,
            findingId: "IMP-1",
            category: "institution_impact:system",
            statement: "可能需要评估数据治理相关系统配置",
            claimType: "ai_inference",
            sourceAnchors: [anchor()],
            inferenceParents: ["REQ-1"],
            requiredReview: true,
          },
        ],
        inferenceRelationships: [
          {
            relationshipId: "REL-IMP-1",
            fromFindingIds: ["REQ-1"],
            toFindingId: "IMP-1",
            relationshipType: "potential",
            sourceAnchors: [anchor()],
            rationale: "监管要求可能涉及相关系统配置",
            confidence: 0.72,
            manualVerificationRequired: true,
          },
        ],
      };
    default:
      throw new Error(`unexpected schema ${request.schemaName}`);
  }
};

describe("runAnalysis", () => {
  it("runs stages in order, preserves atomic/inference provenance, and records restart metadata", async () => {
    const gateway = new RecordingGateway(successfulResponse);
    const progress: AnalysisProgress[] = [];

    const draft = await runAnalysis(
      {
        sourceUnits: [regulatorySource],
        gateway,
        model: "user-model",
        hasOfficialInterpretation: false,
      },
      undefined,
      (event) => {
        progress.push(event);
      },
    );

    expect(gateway.requests.map((request) => request.schemaName)).toEqual([
      "analysis_document_identity_v1",
      "analysis_atomic_clauses_v1",
      "analysis_key_matters_v1",
      "analysis_institution_impact_v1",
    ]);
    expect(
      gateway.requests.every(
        (request) =>
          !request.messages
            .find((message) => message.role === "system")
            ?.content.includes(regulatorySource.content),
      ),
    ).toBe(true);
    expect(
      gateway.requests.every((request) =>
        request.messages
          .find((message) => message.role === "system")
          ?.content.includes("不可信数据"),
      ),
    ).toBe(true);
    expect(draft.limitations).toContain(
      "未提供官方解读，政策背景与监管意图仅依据监管原文，不扩展为官方观点。",
    );
    expect(
      draft.findings.every(
        (finding) => FindingSchema.safeParse(finding).success,
      ),
    ).toBe(true);
    expect(draft.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          findingId: "REQ-1",
          claimType: "regulatory_fact",
        }),
        expect.objectContaining({
          findingId: "IMP-1",
          claimType: "ai_inference",
          requiredReview: true,
        }),
        expect.objectContaining({
          category: "pending_confirmation:file_profile",
          claimType: "pending_confirmation",
        }),
      ]),
    );
    expect(draft.atomicRequirements).toEqual([
      expect.objectContaining({ findingId: "REQ-1", strength: "应当" }),
    ]);
    expect(draft.inferenceRelationships).toEqual([
      expect.objectContaining({
        fromFindingIds: ["REQ-1"],
        toFindingId: "IMP-1",
        relationshipType: "potential",
        manualVerificationRequired: true,
      }),
    ]);
    expect(draft.runs).toHaveLength(4);
    expect(
      draft.runs.every(
        (run) =>
          run.model === "user-model" &&
          run.inputSourceIds.join(",") === "REG-1" &&
          /^[a-f0-9]{64}$/.test(run.responseHash),
      ),
    ).toBe(true);
    expect(progress).toHaveLength(4);
    expect(() => AnalysisDraftSchema.parse(draft)).not.toThrow();
  });

  it("rejects citations to unsupplied source IDs", async () => {
    const gateway = new RecordingGateway((request) => {
      if (request.schemaName === "analysis_document_identity_v1") {
        return {
          conflicts: [],
          findings: [
            {
              ...baseFinding,
              findingId: "BAD-1",
              category: "background",
              statement: "引用了未提供的来源",
              claimType: "regulatory_fact",
              sourceAnchors: [anchor("REG-NOT-SUPPLIED")],
            },
          ],
        };
      }
      return successfulResponse(request);
    });

    await expect(
      runAnalysis({
        sourceUnits: [regulatorySource],
        gateway,
        model: "user-model",
        hasOfficialInterpretation: false,
      }),
    ).rejects.toThrow(/未提供的来源 ID/);
  });

  it("turns declared original-versus-interpretation conflicts into pending confirmation", async () => {
    const gateway = new RecordingGateway((request) => {
      if (request.schemaName !== "analysis_document_identity_v1") {
        return successfulResponse(request);
      }
      const userContent = request.messages.find(
        (message) => message.role === "user",
      )?.content;
      if (userContent?.includes('"sourceType":"official_interpretation"')) {
        return {
          findings: [
            {
              ...baseFinding,
              findingId: "OFF-CLAIM",
              category: "background",
              statement: "官方解读称不要求建立该机制",
              claimType: "official_explanation",
              sourceAnchors: [anchor("OFF-1", "official_interpretation")],
            },
          ],
          conflicts: [
            {
              conflictId: "CONFLICT-1",
              regulatoryFindingId: "REG-CLAIM",
              interpretationFindingId: "OFF-CLAIM",
              summary: "官方解读表述与监管原文要求存在冲突",
              sourceAnchors: [
                anchor(),
                anchor("OFF-1", "official_interpretation"),
              ],
              confidence: 0.8,
              manualVerificationRequired: true,
            },
          ],
        };
      }
      return {
        findings: [
          {
            ...baseFinding,
            findingId: "REG-CLAIM",
            category: "background",
            statement: "监管原文要求建立该机制",
            claimType: "regulatory_fact",
            sourceAnchors: [anchor()],
          },
        ],
        conflicts: [],
      };
    });

    const draft = await runAnalysis({
      sourceUnits: [regulatorySource, officialSource],
      gateway,
      model: "user-model",
      hasOfficialInterpretation: true,
    });

    expect(draft.findings).toContainEqual(
      expect.objectContaining({
        findingId: "CONFLICT-1",
        claimType: "pending_confirmation",
        requiredReview: true,
      }),
    );
    expect(
      draft.findings.find((finding) => finding.findingId === "REG-CLAIM")
        ?.claimType,
    ).toBe("regulatory_fact");
    const officialRequest = gateway.requests.find((request) =>
      request.messages
        .find((message) => message.role === "user")
        ?.content.includes('"sourceType":"official_interpretation"'),
    );
    expect(
      officialRequest?.messages.find((message) => message.role === "user")
        ?.content,
    ).toContain("REG-CLAIM");
    expect(
      draft.runs.find(
        (run) =>
          run.stage === "document_identity" &&
          run.inputSourceIds.includes("OFF-1"),
      )?.inputSourceIds,
    ).toEqual(["OFF-1", "REG-1"]);
  });

  it("cancels between nodes and resumes from the last validated checkpoint", async () => {
    const controller = new AbortController();
    const firstGateway = new RecordingGateway((request) => {
      if (request.schemaName === "analysis_document_identity_v1") {
        return { findings: [], conflicts: [] };
      }
      return successfulResponse(request);
    });
    let checkpoint: AnalysisProgress["checkpoint"] | undefined;

    await expect(
      runAnalysis(
        {
          sourceUnits: [regulatorySource],
          gateway: firstGateway,
          model: "user-model",
          hasOfficialInterpretation: false,
        },
        controller.signal,
        (event) => {
          checkpoint = event.checkpoint;
          controller.abort();
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(firstGateway.requests).toHaveLength(1);
    expect(() => AnalysisCheckpointSchema.parse(checkpoint)).not.toThrow();

    const resumedGateway = new RecordingGateway(successfulResponse);
    const resumed = await runAnalysis({
      sourceUnits: [regulatorySource],
      gateway: resumedGateway,
      model: "user-model",
      hasOfficialInterpretation: false,
      resumeFrom: checkpoint,
    });

    expect(
      resumedGateway.requests.map((request) => request.schemaName),
    ).toEqual([
      "analysis_atomic_clauses_v1",
      "analysis_key_matters_v1",
      "analysis_institution_impact_v1",
    ]);
    expect(resumed.runs).toHaveLength(4);
  });

  it("does not let the orchestrator bypass the gateway data-flow consent gate", async () => {
    modelDataFlowConsent.clear();
    const gateway = createModelGateway(
      {
        baseUrl: "https://models.example.test/v1",
        model: "user-model",
        temperature: 0,
        maxOutputTokens: 2_000,
      },
      "session-only-key",
    );

    await expect(
      runAnalysis({
        sourceUnits: [regulatorySource],
        gateway,
        model: "user-model",
        hasOfficialInterpretation: false,
      }),
    ).rejects.toMatchObject({ kind: "consent_required" });
  });

  it("rejects fabricated actual institution gaps and direct impact relationships", async () => {
    const gateway = new RecordingGateway((request) => {
      if (request.schemaName !== "analysis_institution_impact_v1") {
        return successfulResponse(request);
      }
      const valid = successfulResponse(request) as {
        findings: Array<Record<string, unknown>>;
        inferenceRelationships: Array<Record<string, unknown>>;
      };
      return {
        findings: valid.findings.map((finding) => ({
          ...finding,
          statement: "该银行现有控制失效并已形成制度缺口",
        })),
        inferenceRelationships: valid.inferenceRelationships.map(
          (relationship) => ({
            ...relationship,
            relationshipType: "direct",
            manualVerificationRequired: false,
          }),
        ),
      };
    });

    await expect(
      runAnalysis({
        sourceUnits: [regulatorySource],
        gateway,
        model: "user-model",
        hasOfficialInterpretation: false,
      }),
    ).rejects.toThrow(/机构内部事实|direct/);
  });
});
