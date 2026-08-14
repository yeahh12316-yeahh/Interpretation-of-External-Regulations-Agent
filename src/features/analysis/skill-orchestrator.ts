import { z } from "zod";

import type { Finding } from "../../domain/finding";
import { FindingSchema } from "../../domain/schemas";
import type { SourceAnchor, SourceType, SourceUnit } from "../../domain/source";
import { throwIfAborted } from "../../lib/abort";
import type { ModelGateway } from "../model/model-gateway";
import {
  chunkDocument,
  type ChunkOptions,
  type DocumentChunk,
} from "./chunk-document";
import { findingDeduplicationKey, mergeFindings } from "./merge-findings";
import {
  ATOMIC_CLAUSES_PROMPT_VERSION,
  buildAtomicClausesMessages,
} from "./prompts/atomic-clauses";
import {
  buildDocumentIdentityMessages,
  DOCUMENT_IDENTITY_PROMPT_VERSION,
} from "./prompts/document-identity";
import {
  buildInstitutionImpactMessages,
  INSTITUTION_IMPACT_PROMPT_VERSION,
} from "./prompts/institution-impact";
import {
  buildKeyMattersMessages,
  KEY_MATTERS_PROMPT_VERSION,
} from "./prompts/key-matters";

const SourceTypeSchema = z.enum(["regulatory_text", "official_interpretation"]);

const SourceAnchorSchema = z
  .object({
    sourceId: z.string().min(1),
    sourceType: SourceTypeSchema,
    page: z.number().int().positive().nullable(),
    article: z.string().min(1).nullable(),
    paragraphIndex: z.number().int().nonnegative(),
    quote: z.string().min(1),
  })
  .strict();

const atomicFieldNames = [
  "subject",
  "action",
  "object",
  "condition",
  "frequency",
  "deadline",
  "strength",
  "responsibility",
  "exceptions",
] as const;

export const AtomicRequirementSchema = z
  .object({
    requirementId: z.string().min(1),
    findingId: z.string().min(1),
    subject: z.string().min(1),
    action: z.string().min(1),
    object: z.string().min(1),
    condition: z.string().min(1).nullable(),
    frequency: z.string().min(1).nullable(),
    deadline: z.string().min(1).nullable(),
    strength: z.string().min(1).nullable(),
    responsibility: z.string().min(1).nullable(),
    exceptions: z.string().min(1).nullable(),
    sharedContext: z.string().min(1).nullable(),
    missingFacts: z.array(z.enum(atomicFieldNames)),
    sourceAnchors: z.array(SourceAnchorSchema).min(1),
    confidence: z.number().min(0).max(1),
    manualVerificationRequired: z.boolean(),
  })
  .strict();

export type AtomicRequirement = z.infer<typeof AtomicRequirementSchema>;

export const InferenceRelationshipSchema = z
  .object({
    relationshipId: z.string().min(1),
    fromFindingIds: z.array(z.string().min(1)).min(1),
    toFindingId: z.string().min(1),
    relationshipType: z.enum(["direct", "potential", "not_established"]),
    sourceAnchors: z.array(SourceAnchorSchema).min(1),
    rationale: z.string().min(1),
    confidence: z.number().min(0).max(1),
    manualVerificationRequired: z.boolean(),
  })
  .strict();

export type InferenceRelationship = z.infer<typeof InferenceRelationshipSchema>;

export const SourceConflictSchema = z
  .object({
    conflictId: z.string().min(1),
    regulatoryFindingId: z.string().min(1),
    interpretationFindingId: z.string().min(1),
    summary: z.string().min(1),
    sourceAnchors: z.array(SourceAnchorSchema).min(2),
    confidence: z.number().min(0).max(1),
    manualVerificationRequired: z.literal(true),
  })
  .strict();

export type SourceConflict = z.infer<typeof SourceConflictSchema>;

const DocumentIdentityResponseSchema = z
  .object({
    findings: z.array(FindingSchema),
    conflicts: z.array(SourceConflictSchema),
  })
  .strict();

const AtomicClausesResponseSchema = z
  .object({
    findings: z.array(FindingSchema),
    atomicRequirements: z.array(AtomicRequirementSchema),
  })
  .strict();

const KeyMattersResponseSchema = z
  .object({ findings: z.array(FindingSchema) })
  .strict();

const InstitutionImpactResponseSchema = z
  .object({
    findings: z.array(FindingSchema),
    inferenceRelationships: z.array(InferenceRelationshipSchema),
  })
  .strict();

const AnalysisStageSchema = z.enum([
  "document_identity",
  "atomic_clauses",
  "key_matters",
  "institution_impact",
]);

export type AnalysisStage = z.infer<typeof AnalysisStageSchema>;

export const AnalysisRunMetadataSchema = z
  .object({
    nodeId: z.string().min(1),
    stage: AnalysisStageSchema,
    chunkId: z.string().min(1),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    inputSourceIds: z.array(z.string().min(1)).min(1),
    responseHash: z.string().regex(/^[a-f0-9]{64}$/),
    findingIds: z.array(z.string().min(1)),
    atomicRequirementIds: z.array(z.string().min(1)),
    inferenceRelationshipIds: z.array(z.string().min(1)),
    conflictIds: z.array(z.string().min(1)),
  })
  .strict();

export type AnalysisRunMetadata = z.infer<typeof AnalysisRunMetadataSchema>;

const checkpointShape = {
  checkpointVersion: z.literal(1),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().min(1),
  hasOfficialInterpretation: z.boolean(),
  findings: z.array(FindingSchema),
  atomicRequirements: z.array(AtomicRequirementSchema),
  inferenceRelationships: z.array(InferenceRelationshipSchema),
  conflicts: z.array(SourceConflictSchema),
  runs: z.array(AnalysisRunMetadataSchema),
  limitations: z.array(z.string().min(1)),
  lastSuccessfulNode: z.string().min(1).nullable(),
};

const addCheckpointLinkIssues = (
  checkpoint: {
    findings: Finding[];
    atomicRequirements: AtomicRequirement[];
    inferenceRelationships: InferenceRelationship[];
    conflicts: SourceConflict[];
    runs: AnalysisRunMetadata[];
    lastSuccessfulNode: string | null;
  },
  context: z.RefinementCtx,
): void => {
  const findingIds = new Set(
    checkpoint.findings.map((finding) => finding.findingId),
  );
  const atomicFindingIds = new Set(
    checkpoint.findings
      .filter((finding) => finding.category === "atomic_requirement")
      .map((finding) => finding.findingId),
  );

  checkpoint.atomicRequirements.forEach((requirement, index) => {
    if (!atomicFindingIds.has(requirement.findingId)) {
      context.addIssue({
        code: "custom",
        path: ["atomicRequirements", index, "findingId"],
        message: "AtomicRequirement 只能关联 atomic_requirement Finding",
      });
    }
  });
  atomicFindingIds.forEach((findingId) => {
    if (
      !checkpoint.atomicRequirements.some(
        (item) => item.findingId === findingId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["atomicRequirements"],
        message: `原子要求 Finding ${findingId} 缺少 AtomicRequirement`,
      });
    }
  });

  checkpoint.inferenceRelationships.forEach((relationship, index) => {
    if (!findingIds.has(relationship.toFindingId)) {
      context.addIssue({
        code: "custom",
        path: ["inferenceRelationships", index, "toFindingId"],
        message: "推导关系目标 Finding 不存在",
      });
    }
    relationship.fromFindingIds.forEach((findingId, parentIndex) => {
      if (!findingIds.has(findingId)) {
        context.addIssue({
          code: "custom",
          path: [
            "inferenceRelationships",
            index,
            "fromFindingIds",
            parentIndex,
          ],
          message: "推导关系父 Finding 不存在",
        });
      }
    });
  });

  checkpoint.conflicts.forEach((conflict, index) => {
    if (
      !findingIds.has(conflict.regulatoryFindingId) ||
      !findingIds.has(conflict.interpretationFindingId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["conflicts", index],
        message: "来源冲突必须关联已保留的监管原文与官方解读 Finding",
      });
    }
  });

  const lastRun = checkpoint.runs.at(-1)?.nodeId ?? null;
  if (lastRun !== checkpoint.lastSuccessfulNode) {
    context.addIssue({
      code: "custom",
      path: ["lastSuccessfulNode"],
      message: "最后成功节点必须与运行记录一致",
    });
  }
};

export const AnalysisCheckpointSchema = z
  .object(checkpointShape)
  .strict()
  .superRefine(addCheckpointLinkIssues);

export type AnalysisCheckpoint = z.infer<typeof AnalysisCheckpointSchema>;

export const AnalysisDraftSchema = z
  .object({
    ...checkpointShape,
    findingAliases: z.record(z.string(), z.string().min(1)),
    completed: z.literal(true),
  })
  .strict()
  .superRefine((draft, context) => {
    addCheckpointLinkIssues(draft, context);
    const ids = new Set(draft.findings.map((finding) => finding.findingId));
    if (ids.size !== draft.findings.length) {
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "最终 Finding ID 必须唯一",
      });
    }
    const requirementIds = new Set(
      draft.atomicRequirements.map((requirement) => requirement.requirementId),
    );
    if (requirementIds.size !== draft.atomicRequirements.length) {
      context.addIssue({
        code: "custom",
        path: ["atomicRequirements"],
        message: "最终 AtomicRequirement ID 必须唯一",
      });
    }
    const atomicLinks = draft.atomicRequirements.map(
      (requirement) => requirement.findingId,
    );
    if (new Set(atomicLinks).size !== atomicLinks.length) {
      context.addIssue({
        code: "custom",
        path: ["atomicRequirements"],
        message: "最终 AtomicRequirement 与要求 Finding 必须一一关联",
      });
    }
    const relationshipIds = new Set(
      draft.inferenceRelationships.map(
        (relationship) => relationship.relationshipId,
      ),
    );
    if (relationshipIds.size !== draft.inferenceRelationships.length) {
      context.addIssue({
        code: "custom",
        path: ["inferenceRelationships"],
        message: "最终推导关系 ID 必须唯一",
      });
    }
    draft.inferenceRelationships.forEach((relationship, relationshipIndex) => {
      const target = draft.findings.find(
        (finding) => finding.findingId === relationship.toFindingId,
      );
      if (target?.claimType !== "ai_inference") {
        context.addIssue({
          code: "custom",
          path: ["inferenceRelationships", relationshipIndex, "toFindingId"],
          message: "推导关系目标必须是 ai_inference Finding",
        });
      }
      for (const parentId of relationship.fromFindingIds) {
        if (!ids.has(parentId)) {
          context.addIssue({
            code: "custom",
            path: [
              "inferenceRelationships",
              relationshipIndex,
              "fromFindingIds",
            ],
            message: "推导关系父 Finding 必须保留在最终草稿",
          });
        }
      }
    });
  });

export type AnalysisDraft = z.infer<typeof AnalysisDraftSchema>;

export interface AnalysisInput {
  sourceUnits: readonly SourceUnit[];
  gateway: ModelGateway;
  model: string;
  hasOfficialInterpretation: boolean;
  resumeFrom?: AnalysisCheckpoint;
  chunkOptions?: Partial<ChunkOptions>;
}

export interface AnalysisProgress {
  stage: AnalysisStage;
  nodeId: string;
  completedNodes: number;
  totalNodes: number;
  checkpoint: AnalysisCheckpoint;
}

export type AnalysisProgressHandler = (
  progress: AnalysisProgress,
) => void | Promise<void>;

interface AnalysisNode {
  nodeId: string;
  stage: AnalysisStage;
  chunk: DocumentChunk;
  promptVersion: string;
}

const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxChars: 24_000,
  overlapUnits: 2,
};

const NO_OFFICIAL_INTERPRETATION_LIMITATION =
  "未提供官方解读，政策背景与监管意图仅依据监管原文，不扩展为官方观点。";

const fileProfilePendingFinding = (): Finding =>
  FindingSchema.parse({
    findingId: "SYS-PENDING-FILE-PROFILE",
    category: "pending_confirmation:file_profile",
    statement:
      "待确认：上传材料的官方来源状态、发布日期、当前效力/生效或废止状态，以及对具体机构的适用性维度（机构类型、业务范围、地域和主体画像）未由已提供资料完整建立。",
    claimType: "pending_confirmation",
    sourceAnchors: [],
    inferenceParents: [],
    reviewStatus: "unreviewed",
    requiredReview: true,
    revisionRecords: [],
  });

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const canonicalJson = (value: unknown): string => JSON.stringify(value);

const sha256 = async (value: string): Promise<string> => {
  if (!globalThis.crypto?.subtle) {
    throw new Error("当前环境不支持 SHA-256，无法记录可重启分析元数据");
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const serializeChunk = (chunk: DocumentChunk): object => ({
  chunkId: chunk.chunkId,
  sourceType: chunk.sourceType,
  units: chunk.units.map((unit) => ({
    sourceId: unit.sourceId,
    sourceType: unit.sourceType,
    title: unit.title,
    segmentId: unit.segmentId,
    sourceStartOffset: unit.sourceStartOffset,
    sourceEndOffset: unit.sourceEndOffset,
    content: unit.content,
  })),
});

const nodesFor = (chunks: readonly DocumentChunk[]): AnalysisNode[] => {
  const regulatoryChunks = chunks.filter(
    (chunk) => chunk.sourceType === "regulatory_text",
  );
  const definitions: Array<{
    stage: AnalysisStage;
    promptVersion: string;
    chunks: readonly DocumentChunk[];
  }> = [
    {
      stage: "document_identity",
      promptVersion: DOCUMENT_IDENTITY_PROMPT_VERSION,
      chunks,
    },
    {
      stage: "atomic_clauses",
      promptVersion: ATOMIC_CLAUSES_PROMPT_VERSION,
      chunks: regulatoryChunks,
    },
    {
      stage: "key_matters",
      promptVersion: KEY_MATTERS_PROMPT_VERSION,
      chunks: regulatoryChunks,
    },
    {
      stage: "institution_impact",
      promptVersion: INSTITUTION_IMPACT_PROMPT_VERSION,
      chunks: regulatoryChunks,
    },
  ];

  return definitions.flatMap(({ stage, promptVersion, chunks: stageChunks }) =>
    stageChunks.map((chunk) => ({
      nodeId: `${stage}:${chunk.chunkId}`,
      stage,
      chunk,
      promptVersion,
    })),
  );
};

const validateAnchors = (
  anchors: readonly SourceAnchor[],
  sourceById: ReadonlyMap<string, SourceUnit>,
): void => {
  for (const anchor of anchors) {
    const source = sourceById.get(anchor.sourceId);
    if (!source) {
      throw new Error(`结论引用了未提供的来源 ID：${anchor.sourceId}`);
    }
    if (source.sourceType !== anchor.sourceType) {
      throw new Error(`来源 ${anchor.sourceId} 的来源类型与输入不一致`);
    }
  }
};

const validateFindings = (
  findings: readonly Finding[],
  sourceById: ReadonlyMap<string, SourceUnit>,
): void => {
  for (const finding of findings) {
    if (finding.findingId.startsWith("SYS-")) {
      throw new Error("模型不得使用系统保留的 Finding ID");
    }
    validateAnchors(finding.sourceAnchors, sourceById);
  }
};

const assertUniqueIds = (ids: readonly string[], label: string): void => {
  if (new Set(ids).size !== ids.length) throw new Error(`${label} ID 必须唯一`);
};

const validateAtomicResponse = (
  response: z.infer<typeof AtomicClausesResponseSchema>,
  sourceById: ReadonlyMap<string, SourceUnit>,
): void => {
  validateFindings(response.findings, sourceById);
  assertUniqueIds(
    response.findings.map((finding) => finding.findingId),
    "原子要求 Finding",
  );
  assertUniqueIds(
    response.atomicRequirements.map((requirement) => requirement.requirementId),
    "AtomicRequirement",
  );
  const requirementFindingIds = response.findings.map((finding) => {
    if (finding.category !== "atomic_requirement") {
      throw new Error(
        "原子化阶段不得为非要求类 Finding 伪造 AtomicRequirement",
      );
    }
    if (
      finding.claimType !== "regulatory_fact" &&
      finding.claimType !== "pending_confirmation"
    ) {
      throw new Error("原子要求只能是监管事实或待确认事项");
    }
    return finding.findingId;
  });
  const atomicFindingIds = response.atomicRequirements.map((requirement) => {
    validateAnchors(requirement.sourceAnchors, sourceById);
    if (
      requirement.sourceAnchors.some(
        (item) => item.sourceType !== "regulatory_text",
      )
    ) {
      throw new Error("AtomicRequirement 只能引用监管原文");
    }
    const linkedFinding = response.findings.find(
      (finding) => finding.findingId === requirement.findingId,
    );
    if (!linkedFinding) throw new Error("AtomicRequirement 缺少关联 Finding");
    if (
      requirement.missingFacts.length > 0 &&
      linkedFinding.claimType !== "pending_confirmation"
    ) {
      throw new Error("原子字段缺失时关联 Finding 必须是 pending_confirmation");
    }
    return requirement.findingId;
  });
  if (
    [...requirementFindingIds].sort().join("\u0000") !==
    [...atomicFindingIds].sort().join("\u0000")
  ) {
    throw new Error(
      "AtomicRequirement 必须与要求 Finding 通过 findingId 一一关联",
    );
  }
};

const IMPACT_CATEGORIES = new Set([
  "institution_impact:governance",
  "institution_impact:process",
  "institution_impact:system",
  "institution_impact:data",
  "institution_impact:people",
  "institution_impact:reporting",
]);

const ACTUAL_INTERNAL_FACT_PATTERN =
  /现有[^。；]*(?:失效|缺口|不符合)|已形成[^。；]*缺口|该(?:银行|机构)[^。；]*(?:存在|缺失|未建立)/;

const validateImpactResponse = (
  response: z.infer<typeof InstitutionImpactResponseSchema>,
  upstreamFindings: readonly Finding[],
  sourceById: ReadonlyMap<string, SourceUnit>,
): void => {
  validateFindings(response.findings, sourceById);
  const upstreamIds = new Set(
    upstreamFindings.map((finding) => finding.findingId),
  );
  const impactById = new Map(
    response.findings.map((finding) => [finding.findingId, finding]),
  );

  for (const finding of response.findings) {
    if (finding.claimType !== "ai_inference") {
      throw new Error("机构影响必须标为 ai_inference");
    }
    if (!IMPACT_CATEGORIES.has(finding.category)) {
      throw new Error("机构影响只能使用治理、流程、系统、数据、人员或报告类别");
    }
    if (!finding.requiredReview) {
      throw new Error("机构影响必须进入人工复核");
    }
    if (ACTUAL_INTERNAL_FACT_PATTERN.test(finding.statement)) {
      throw new Error("机构影响不得编造机构内部事实或实际缺口");
    }
    if (
      finding.inferenceParents.some((parentId) => !upstreamIds.has(parentId))
    ) {
      throw new Error("机构影响引用了不存在的上游 Finding");
    }
  }

  assertUniqueIds(
    response.inferenceRelationships.map((item) => item.relationshipId),
    "推导关系",
  );
  for (const relationship of response.inferenceRelationships) {
    validateAnchors(relationship.sourceAnchors, sourceById);
    const impact = impactById.get(relationship.toFindingId);
    if (!impact) throw new Error("推导关系目标不是本次机构影响 Finding");
    if (relationship.relationshipType === "direct") {
      throw new Error("缺少机构画像时机构影响关系不得标为 direct");
    }
    if (!relationship.manualVerificationRequired) {
      throw new Error("不确定推导关系必须要求人工复核");
    }
    const relationshipParents = [...relationship.fromFindingIds].sort();
    const findingParents = [...impact.inferenceParents].sort();
    if (relationshipParents.join("\u0000") !== findingParents.join("\u0000")) {
      throw new Error("推导关系父结论必须与 Finding inferenceParents 一致");
    }
  }
  for (const finding of response.findings) {
    if (
      !response.inferenceRelationships.some(
        (relationship) => relationship.toFindingId === finding.findingId,
      )
    ) {
      throw new Error("每项机构影响必须有可追溯推导关系");
    }
  }
};

const checkpointFrom = (state: AnalysisCheckpoint): AnalysisCheckpoint =>
  AnalysisCheckpointSchema.parse(state);

const conflictFinding = (conflict: SourceConflict): Finding =>
  FindingSchema.parse({
    findingId: conflict.conflictId,
    category: "pending_confirmation:source_conflict",
    statement: `待确认：${conflict.summary}`,
    claimType: "pending_confirmation",
    sourceAnchors: conflict.sourceAnchors,
    inferenceParents: [
      conflict.regulatoryFindingId,
      conflict.interpretationFindingId,
    ],
    reviewStatus: "unreviewed",
    requiredReview: true,
    revisionRecords: [],
  });

const anchorIdentity = (anchor: SourceAnchor): string => JSON.stringify(anchor);

const mergeAtomicRequirements = (
  requirements: readonly AtomicRequirement[],
  aliases: Readonly<Record<string, string>>,
): AtomicRequirement[] => {
  const grouped = new Map<string, AtomicRequirement>();
  for (const raw of requirements) {
    const requirement = AtomicRequirementSchema.parse({
      ...raw,
      findingId: aliases[raw.findingId] ?? raw.findingId,
    });
    const existing = grouped.get(requirement.findingId);
    if (!existing) {
      grouped.set(requirement.findingId, requirement);
      continue;
    }
    const structural = (item: AtomicRequirement): string =>
      JSON.stringify({
        subject: item.subject,
        action: item.action,
        object: item.object,
        condition: item.condition,
        frequency: item.frequency,
        deadline: item.deadline,
        strength: item.strength,
        responsibility: item.responsibility,
        exceptions: item.exceptions,
        sharedContext: item.sharedContext,
        missingFacts: [...item.missingFacts].sort(),
      });
    if (structural(existing) !== structural(requirement)) {
      throw new Error(
        `原子要求 ${requirement.findingId} 在分块间存在冲突，必须进入人工确认后再合并`,
      );
    }
    const anchors = new Map(
      [...existing.sourceAnchors, ...requirement.sourceAnchors].map((item) => [
        anchorIdentity(item),
        item,
      ]),
    );
    grouped.set(
      requirement.findingId,
      AtomicRequirementSchema.parse({
        ...existing,
        sourceAnchors: [...anchors.values()],
        confidence: Math.min(existing.confidence, requirement.confidence),
        manualVerificationRequired:
          existing.manualVerificationRequired ||
          requirement.manualVerificationRequired,
      }),
    );
  }
  return [...grouped.values()];
};

const mergeRelationships = (
  relationships: readonly InferenceRelationship[],
  aliases: Readonly<Record<string, string>>,
): InferenceRelationship[] => {
  const byId = new Map<string, InferenceRelationship>();
  for (const raw of relationships) {
    const normalized = InferenceRelationshipSchema.parse({
      ...raw,
      fromFindingIds: unique(raw.fromFindingIds.map((id) => aliases[id] ?? id)),
      toFindingId: aliases[raw.toFindingId] ?? raw.toFindingId,
    });
    const existing = byId.get(normalized.relationshipId);
    if (!existing) {
      byId.set(normalized.relationshipId, normalized);
      continue;
    }
    if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
      throw new Error(`推导关系 ${normalized.relationshipId} 在分块间存在冲突`);
    }
  }
  return [...byId.values()];
};

const finalizeDraft = (checkpoint: AnalysisCheckpoint): AnalysisDraft => {
  const conflictFindings = checkpoint.conflicts.map(conflictFinding);
  const withSystemFindings = [
    ...checkpoint.findings,
    ...conflictFindings,
    fileProfilePendingFinding(),
  ];

  const idToKey = new Map<string, string>();
  const keyToCanonicalId = new Map<string, string>();
  for (const finding of withSystemFindings) {
    const key = findingDeduplicationKey(finding);
    const existingKey = idToKey.get(finding.findingId);
    if (existingKey && existingKey !== key) {
      throw new Error(`Finding ID ${finding.findingId} 对应了不同结论`);
    }
    idToKey.set(finding.findingId, key);
    if (!keyToCanonicalId.has(key))
      keyToCanonicalId.set(key, finding.findingId);
  }
  const findingAliases = Object.fromEntries(
    [...idToKey.entries()].map(([id, key]) => [id, keyToCanonicalId.get(key)!]),
  );

  const findings = mergeFindings(withSystemFindings).map((finding) =>
    FindingSchema.parse({
      ...finding,
      inferenceParents: unique(
        finding.inferenceParents.map((id) => findingAliases[id] ?? id),
      ),
    }),
  );
  const atomicRequirements = mergeAtomicRequirements(
    checkpoint.atomicRequirements,
    findingAliases,
  );
  const inferenceRelationships = mergeRelationships(
    checkpoint.inferenceRelationships,
    findingAliases,
  );

  return AnalysisDraftSchema.parse({
    ...checkpoint,
    findings,
    atomicRequirements,
    inferenceRelationships,
    conflicts: checkpoint.conflicts.map((conflict) => ({
      ...conflict,
      regulatoryFindingId:
        findingAliases[conflict.regulatoryFindingId] ??
        conflict.regulatoryFindingId,
      interpretationFindingId:
        findingAliases[conflict.interpretationFindingId] ??
        conflict.interpretationFindingId,
    })),
    findingAliases,
    completed: true,
  });
};

const initialCheckpoint = (
  inputFingerprint: string,
  model: string,
  hasOfficialInterpretation: boolean,
): AnalysisCheckpoint =>
  checkpointFrom({
    checkpointVersion: 1,
    inputFingerprint,
    model,
    hasOfficialInterpretation,
    findings: [],
    atomicRequirements: [],
    inferenceRelationships: [],
    conflicts: [],
    runs: [],
    limitations: hasOfficialInterpretation
      ? []
      : [NO_OFFICIAL_INTERPRETATION_LIMITATION],
    lastSuccessfulNode: null,
  });

const validateResume = (
  checkpoint: AnalysisCheckpoint,
  nodes: readonly AnalysisNode[],
  inputFingerprint: string,
  input: AnalysisInput,
): void => {
  if (
    checkpoint.inputFingerprint !== inputFingerprint ||
    checkpoint.model !== input.model.trim() ||
    checkpoint.hasOfficialInterpretation !== input.hasOfficialInterpretation
  ) {
    throw new Error("重启元数据与当前模型、来源或官方解读状态不一致");
  }
  const expectedPrefix = nodes
    .slice(0, checkpoint.runs.length)
    .map((node) => node.nodeId);
  if (
    checkpoint.runs.map((run) => run.nodeId).join("\u0000") !==
    expectedPrefix.join("\u0000")
  ) {
    throw new Error("只能从最后一个连续成功节点重启分析");
  }
  checkpoint.runs.forEach((run, index) => {
    const node = nodes[index];
    if (
      run.model !== input.model.trim() ||
      run.promptVersion !== node.promptVersion ||
      node.chunk.inputSourceIds.some(
        (sourceId) => !run.inputSourceIds.includes(sourceId),
      ) ||
      run.inputSourceIds.some(
        (sourceId) =>
          !input.sourceUnits.some((source) => source.sourceId === sourceId),
      )
    ) {
      throw new Error("重启节点的模型、提示词版本或输入来源已变化");
    }
  });
};

export async function runAnalysis(
  input: AnalysisInput,
  signal?: AbortSignal,
  onProgress?: AnalysisProgressHandler,
): Promise<AnalysisDraft> {
  throwIfAborted(signal);
  const model = input.model.trim();
  if (!model) throw new Error("分析必须记录非空模型名称");
  if (input.sourceUnits.length === 0) throw new Error("请先提供监管原文");

  const sourceById = new Map<string, SourceUnit>();
  for (const source of input.sourceUnits) {
    if (sourceById.has(source.sourceId)) throw new Error("来源 ID 必须唯一");
    sourceById.set(source.sourceId, source);
  }
  if (
    ![...sourceById.values()].some(
      (item) => item.sourceType === "regulatory_text",
    )
  ) {
    throw new Error("监管原文必填");
  }
  const actualHasOfficial = [...sourceById.values()].some(
    (item) => item.sourceType === "official_interpretation",
  );
  if (actualHasOfficial !== input.hasOfficialInterpretation) {
    throw new Error("官方解读存在标志与输入来源不一致");
  }

  const chunkOptions: ChunkOptions = {
    ...DEFAULT_CHUNK_OPTIONS,
    ...input.chunkOptions,
  };
  const chunks = chunkDocument(input.sourceUnits, chunkOptions);
  const nodes = nodesFor(chunks);
  const inputFingerprint = await sha256(
    canonicalJson(
      input.sourceUnits.map((source) => ({
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        title: source.title,
        content: source.content,
      })),
    ),
  );
  let checkpoint = input.resumeFrom
    ? AnalysisCheckpointSchema.parse(input.resumeFrom)
    : initialCheckpoint(
        inputFingerprint,
        model,
        input.hasOfficialInterpretation,
      );
  if (input.resumeFrom)
    validateResume(checkpoint, nodes, inputFingerprint, input);

  for (
    let nodeIndex = checkpoint.runs.length;
    nodeIndex < nodes.length;
    nodeIndex += 1
  ) {
    throwIfAborted(signal);
    const node = nodes[nodeIndex];
    let findings: Finding[] = [];
    let atomicRequirements: AtomicRequirement[] = [];
    let inferenceRelationships: InferenceRelationship[] = [];
    let conflicts: SourceConflict[] = [];
    let response: unknown;
    let requestInputSourceIds = node.chunk.inputSourceIds;

    if (node.stage === "document_identity") {
      const primaryFindings =
        node.chunk.sourceType === "official_interpretation"
          ? checkpoint.findings.filter(
              (finding) => finding.claimType === "regulatory_fact",
            )
          : [];
      requestInputSourceIds = unique([
        ...node.chunk.inputSourceIds,
        ...primaryFindings.flatMap((finding) =>
          finding.sourceAnchors.map((item) => item.sourceId),
        ),
      ]);
      response = await input.gateway.requestStructured({
        schema: DocumentIdentityResponseSchema,
        schemaName: "analysis_document_identity_v1",
        signal,
        messages: buildDocumentIdentityMessages(
          canonicalJson({
            sourceChunk: serializeChunk(node.chunk),
            primaryRegulatoryFindings: primaryFindings,
          }),
        ),
      });
      const parsed = DocumentIdentityResponseSchema.parse(response);
      findings = parsed.findings;
      conflicts = parsed.conflicts;
      validateFindings(findings, sourceById);
      conflicts.forEach((conflict) => {
        validateAnchors(conflict.sourceAnchors, sourceById);
        if (
          !conflict.sourceAnchors.some(
            (item) => item.sourceType === "regulatory_text",
          ) ||
          !conflict.sourceAnchors.some(
            (item) => item.sourceType === "official_interpretation",
          )
        ) {
          throw new Error("来源冲突必须同时保留监管原文和官方解读锚点");
        }
      });
    } else if (node.stage === "atomic_clauses") {
      response = await input.gateway.requestStructured({
        schema: AtomicClausesResponseSchema,
        schemaName: "analysis_atomic_clauses_v1",
        signal,
        messages: buildAtomicClausesMessages(
          canonicalJson(serializeChunk(node.chunk)),
        ),
      });
      const parsed = AtomicClausesResponseSchema.parse(response);
      findings = parsed.findings;
      atomicRequirements = parsed.atomicRequirements;
      validateAtomicResponse(parsed, sourceById);
    } else if (node.stage === "key_matters") {
      response = await input.gateway.requestStructured({
        schema: KeyMattersResponseSchema,
        schemaName: "analysis_key_matters_v1",
        signal,
        messages: buildKeyMattersMessages(
          canonicalJson({
            sourceChunk: serializeChunk(node.chunk),
            upstreamAtomicRequirements: checkpoint.atomicRequirements.filter(
              (requirement) =>
                requirement.sourceAnchors.some((anchor) =>
                  node.chunk.inputSourceIds.includes(anchor.sourceId),
                ),
            ),
          }),
        ),
      });
      const parsed = KeyMattersResponseSchema.parse(response);
      findings = parsed.findings;
      validateFindings(findings, sourceById);
      if (
        findings.some(
          (finding) =>
            finding.claimType !== "regulatory_fact" &&
            finding.claimType !== "pending_confirmation",
        )
      ) {
        throw new Error("重点事项只能来自监管原文或标为 pending_confirmation");
      }
    } else {
      const relevantSourceIds = new Set(node.chunk.inputSourceIds);
      const upstreamFindings = checkpoint.findings.filter(
        (finding) =>
          finding.claimType === "regulatory_fact" &&
          finding.sourceAnchors.some((anchor) =>
            relevantSourceIds.has(anchor.sourceId),
          ),
      );
      response = await input.gateway.requestStructured({
        schema: InstitutionImpactResponseSchema,
        schemaName: "analysis_institution_impact_v1",
        signal,
        messages: buildInstitutionImpactMessages(
          canonicalJson({
            sourceChunk: serializeChunk(node.chunk),
            upstreamFindings,
          }),
        ),
      });
      const parsed = InstitutionImpactResponseSchema.parse(response);
      findings = parsed.findings;
      inferenceRelationships = parsed.inferenceRelationships;
      validateImpactResponse(parsed, upstreamFindings, sourceById);
    }

    throwIfAborted(signal);
    const responseHash = await sha256(canonicalJson(response));
    checkpoint = checkpointFrom({
      ...checkpoint,
      findings: [...checkpoint.findings, ...findings],
      atomicRequirements: [
        ...checkpoint.atomicRequirements,
        ...atomicRequirements,
      ],
      inferenceRelationships: [
        ...checkpoint.inferenceRelationships,
        ...inferenceRelationships,
      ],
      conflicts: [...checkpoint.conflicts, ...conflicts],
      runs: [
        ...checkpoint.runs,
        {
          nodeId: node.nodeId,
          stage: node.stage,
          chunkId: node.chunk.chunkId,
          model,
          promptVersion: node.promptVersion,
          inputSourceIds: requestInputSourceIds,
          responseHash,
          findingIds: findings.map((finding) => finding.findingId),
          atomicRequirementIds: atomicRequirements.map(
            (requirement) => requirement.requirementId,
          ),
          inferenceRelationshipIds: inferenceRelationships.map(
            (relationship) => relationship.relationshipId,
          ),
          conflictIds: conflicts.map((conflict) => conflict.conflictId),
        },
      ],
      lastSuccessfulNode: node.nodeId,
    });

    await onProgress?.({
      stage: node.stage,
      nodeId: node.nodeId,
      completedNodes: checkpoint.runs.length,
      totalNodes: nodes.length,
      checkpoint,
    });
    throwIfAborted(signal);
  }

  return finalizeDraft(checkpoint);
}
