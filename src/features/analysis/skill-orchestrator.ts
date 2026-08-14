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
    subject: z.string().min(1).nullable(),
    action: z.string().min(1).nullable(),
    object: z.string().min(1).nullable(),
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
  .strict()
  .superRefine((requirement, context) => {
    if (
      new Set(requirement.missingFacts).size !== requirement.missingFacts.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["missingFacts"],
        message: "missingFacts 不得重复",
      });
    }
    for (const field of requirement.missingFacts) {
      if (requirement[field] !== null) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} 列入 missingFacts 时必须为 null`,
        });
      }
    }
    for (const field of ["subject", "action", "object"] as const) {
      const isMissing = requirement.missingFacts.includes(field);
      if ((requirement[field] === null) !== isMissing) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} 的 null 状态必须与 missingFacts 完全一致`,
        });
      }
    }
  });

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

const InstitutionImpactItemSchema = z
  .object({
    findingId: z.string().min(1),
    relationshipId: z.string().min(1),
    category: z.enum([
      "governance",
      "process",
      "system",
      "data",
      "people",
      "reporting",
    ]),
    possibility: z.enum(["potential", "not_established"]),
    inferenceParents: z.array(z.string().min(1)).min(1),
    sourceAnchors: z.array(SourceAnchorSchema).min(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const InstitutionImpactResponseSchema = z
  .object({ impacts: z.array(InstitutionImpactItemSchema) })
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
  officialPrimaryContext?: Readonly<Record<string, readonly string[]>>;
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

const resolveChunkPolicy = (
  options: Partial<ChunkOptions> | undefined,
): ChunkOptions => {
  const policy = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  if (!Number.isInteger(policy.maxChars) || policy.maxChars < 3) {
    throw new Error("maxChars 必须是至少为 3 的整数");
  }
  if (policy.maxChars > 24_000) {
    throw new Error("生产分析分块 maxChars 不得超过 24000");
  }
  if (policy.overlapUnits !== 2) {
    throw new Error("生产分析分块 overlapUnits 必须固定为 2 个重叠单元");
  }
  return policy;
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

const normalizeOfficialPrimaryContext = (
  raw: AnalysisInput["officialPrimaryContext"],
  sourceById: ReadonlyMap<string, SourceUnit>,
): Record<string, string[]> => {
  const normalized: Record<string, string[]> = {};
  for (const [officialSourceId, regulatorySourceIds] of Object.entries(
    raw ?? {},
  )) {
    const official = sourceById.get(officialSourceId);
    if (official?.sourceType !== "official_interpretation") {
      throw new Error(
        `官方解读配对键必须是已提供的官方解读 source ID：${officialSourceId}`,
      );
    }
    const paired = unique(regulatorySourceIds).sort();
    for (const regulatorySourceId of paired) {
      if (
        sourceById.get(regulatorySourceId)?.sourceType !== "regulatory_text"
      ) {
        throw new Error(
          `官方解读只能配对已提供的监管原文 source ID：${regulatorySourceId}`,
        );
      }
    }
    normalized[officialSourceId] = paired;
  }
  return Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
};

const executionPlanFingerprint = async (
  sources: readonly SourceUnit[],
  policy: ChunkOptions,
  nodes: readonly AnalysisNode[],
  officialPrimaryContext: Readonly<Record<string, readonly string[]>>,
): Promise<string> => {
  const sourceManifest = await Promise.all(
    sources.map(async (source) => ({
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      titleHash: await sha256(source.title),
      contentHash: await sha256(source.content),
    })),
  );
  const nodeManifest = await Promise.all(
    nodes.map(async (node) => ({
      nodeId: node.nodeId,
      stage: node.stage,
      promptVersion: node.promptVersion,
      chunkId: node.chunk.chunkId,
      sourceType: node.chunk.sourceType,
      characterCount: node.chunk.characterCount,
      inputSourceIds: node.chunk.inputSourceIds,
      segments: await Promise.all(
        node.chunk.units.map(async (unit) => ({
          segmentId: unit.segmentId,
          sourceId: unit.sourceId,
          sourceType: unit.sourceType,
          sourceStartOffset: unit.sourceStartOffset,
          sourceEndOffset: unit.sourceEndOffset,
          contentHash: await sha256(unit.content),
        })),
      ),
    })),
  );
  return sha256(
    canonicalJson({
      policy,
      sourceManifest,
      nodeManifest,
      officialPrimaryContext,
    }),
  );
};

interface AuthorizedSourceEvidence {
  sourceType: SourceType;
  texts: string[];
}

type AuthorizedSourceScope = ReadonlyMap<string, AuthorizedSourceEvidence>;

const normalizedEvidenceText = (value: string): string =>
  value.normalize("NFKC").replace(/\s+/g, "").trim();

const scopeForChunk = (
  chunk: DocumentChunk,
): Map<string, AuthorizedSourceEvidence> => {
  const scope = new Map<string, AuthorizedSourceEvidence>();
  for (const unit of chunk.units) {
    const existing = scope.get(unit.sourceId);
    if (existing) {
      existing.texts.push(unit.content);
    } else {
      scope.set(unit.sourceId, {
        sourceType: unit.sourceType,
        texts: [unit.content],
      });
    }
  }
  for (const evidence of scope.values()) {
    if (evidence.texts.length > 1) {
      evidence.texts.push(evidence.texts.join(""));
    }
  }
  return scope;
};

const scopeWithPrimaryFindings = (
  chunk: DocumentChunk,
  primaryFindings: readonly Finding[],
): Map<string, AuthorizedSourceEvidence> => {
  const scope = scopeForChunk(chunk);
  for (const anchor of primaryFindings.flatMap(
    (finding) => finding.sourceAnchors,
  )) {
    const existing = scope.get(anchor.sourceId);
    if (existing) {
      existing.texts.push(anchor.quote);
    } else {
      scope.set(anchor.sourceId, {
        sourceType: anchor.sourceType,
        texts: [anchor.quote],
      });
    }
  }
  return scope;
};

const anchorIsAuthorized = (
  anchor: SourceAnchor,
  scope: AuthorizedSourceScope,
): boolean => {
  const authorized = scope.get(anchor.sourceId);
  if (!authorized || authorized.sourceType !== anchor.sourceType) return false;
  const quote = normalizedEvidenceText(anchor.quote);
  return (
    quote.length > 0 &&
    authorized.texts.some((text) =>
      normalizedEvidenceText(text).includes(quote),
    )
  );
};

const validateAnchors = (
  anchors: readonly SourceAnchor[],
  scope: AuthorizedSourceScope,
): void => {
  for (const anchor of anchors) {
    const source = scope.get(anchor.sourceId);
    if (!source) {
      throw new Error(`结论引用了当前节点未授权的来源 ID：${anchor.sourceId}`);
    }
    if (source.sourceType !== anchor.sourceType) {
      throw new Error(`当前节点来源 ${anchor.sourceId} 的来源类型不一致`);
    }
    if (!anchorIsAuthorized(anchor, scope)) {
      throw new Error(
        `来源 ${anchor.sourceId} 的引用未在当前节点授权文本中反向匹配`,
      );
    }
  }
};

const SENSITIVE_REGULATORY_ASSERTION =
  /生效|施行|废止|有效|失效|效力|适用|罚款|处罚|执法|监管措施|责令|没收|吊销|警告|限期|期限|截止|日期|日内|月内|年内|发布|印发|颁布|制定|主管|负责|发文|总局|委员会|人民银行|国务院|政府|\d{4}|(?:元|万元|亿元)|[%％]|比例/;
const OFFICIAL_STATUS_ASSERTION =
  /生效|施行|废止|现行有效|失效|效力状态|适用范围/;
const SENSITIVE_CATEGORY =
  /effect|status|applic|penalt|enforce|deadline|date|amount|authority|效力|适用|处罚|执法|期限|日期|金额|机关/i;
const OFFICIAL_STATUS_CATEGORY = /effect|status|applic|效力|适用/i;

const validateSensitiveClaim = (finding: Finding): void => {
  if (
    finding.claimType === "official_explanation" &&
    (OFFICIAL_STATUS_CATEGORY.test(finding.category) ||
      OFFICIAL_STATUS_ASSERTION.test(finding.statement))
  ) {
    throw new Error("官方解读不得建立或覆盖监管文件效力与适用状态");
  }
  if (
    finding.claimType !== "regulatory_fact" ||
    (!SENSITIVE_CATEGORY.test(finding.category) &&
      !SENSITIVE_REGULATORY_ASSERTION.test(finding.statement))
  ) {
    return;
  }
  const statement = normalizedEvidenceText(finding.statement);
  const exactRegulatoryMatch = finding.sourceAnchors.some(
    (anchor) =>
      anchor.sourceType === "regulatory_text" &&
      normalizedEvidenceText(anchor.quote).includes(statement),
  );
  if (!exactRegulatoryMatch) {
    throw new Error(
      "敏感监管事实的陈述与 claimed value 必须在授权监管原文引用中确定性反向匹配",
    );
  }
};

const validateFindings = (
  findings: readonly Finding[],
  scope: AuthorizedSourceScope,
): void => {
  for (const finding of findings) {
    if (finding.findingId.startsWith("SYS-")) {
      throw new Error("模型不得使用系统保留的 Finding ID");
    }
    validateAnchors(finding.sourceAnchors, scope);
    validateSensitiveClaim(finding);
  }
};

const assertUniqueIds = (ids: readonly string[], label: string): void => {
  if (new Set(ids).size !== ids.length) throw new Error(`${label} ID 必须唯一`);
};

const validateAtomicResponse = (
  response: z.infer<typeof AtomicClausesResponseSchema>,
  scope: AuthorizedSourceScope,
): void => {
  validateFindings(response.findings, scope);
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
    validateAnchors(requirement.sourceAnchors, scope);
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
    const linkedAnchorKeys = new Set(
      linkedFinding.sourceAnchors.map((item) => anchorIdentity(item)),
    );
    if (
      requirement.sourceAnchors.some(
        (item) => !linkedAnchorKeys.has(anchorIdentity(item)),
      )
    ) {
      throw new Error(
        "AtomicRequirement 锚点必须是关联 Finding 锚点的相等或已验证子集",
      );
    }
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

const IMPACT_LABELS = {
  governance: "治理",
  process: "流程",
  system: "系统",
  data: "数据",
  people: "人员",
  reporting: "报告",
} as const;

const buildStructuredImpacts = (
  response: z.infer<typeof InstitutionImpactResponseSchema>,
  upstreamFindings: readonly Finding[],
  scope: AuthorizedSourceScope,
): { findings: Finding[]; relationships: InferenceRelationship[] } => {
  const upstreamIds = new Set(
    upstreamFindings.map((finding) => finding.findingId),
  );
  assertUniqueIds(
    response.impacts.map((item) => item.findingId),
    "结构化机构影响 Finding",
  );
  assertUniqueIds(
    response.impacts.map((item) => item.relationshipId),
    "结构化机构影响推导关系",
  );

  const findings: Finding[] = [];
  const relationships: InferenceRelationship[] = [];
  for (const impact of response.impacts) {
    validateAnchors(impact.sourceAnchors, scope);
    if (
      impact.inferenceParents.some((parentId) => !upstreamIds.has(parentId))
    ) {
      throw new Error("机构影响引用了不存在或未授权的上游 Finding");
    }
    const label = IMPACT_LABELS[impact.category];
    const statement =
      impact.possibility === "potential"
        ? `可能需要评估${label}维度的相关影响（AI推导，尚未建立机构实际情况）。`
        : `尚无法建立${label}维度的具体机构影响，需补充机构材料并人工确认。`;
    findings.push(
      FindingSchema.parse({
        findingId: impact.findingId,
        category: `institution_impact:${impact.category}`,
        statement,
        claimType: "ai_inference",
        sourceAnchors: impact.sourceAnchors,
        inferenceParents: impact.inferenceParents,
        reviewStatus: "unreviewed",
        requiredReview: true,
        revisionRecords: [],
      }),
    );
    relationships.push(
      InferenceRelationshipSchema.parse({
        relationshipId: impact.relationshipId,
        fromFindingIds: impact.inferenceParents,
        toFindingId: impact.findingId,
        relationshipType: impact.possibility,
        sourceAnchors: impact.sourceAnchors,
        rationale:
          impact.possibility === "potential"
            ? `监管要求与${label}维度可能相关，具体机构影响尚待核实。`
            : `现有材料不足以建立监管要求与${label}维度的具体机构影响。`,
        confidence: impact.confidence,
        manualVerificationRequired: true,
      }),
    );
  }
  validateFindings(findings, scope);
  return { findings, relationships };
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

const atomicStructureSignature = (item: AtomicRequirement): string =>
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

interface ExpandedAtomicState {
  findings: Finding[];
  requirements: AtomicRequirement[];
  pendingConflicts: Finding[];
}

const expandConflictingAtomicIds = (
  findings: readonly Finding[],
  requirements: readonly AtomicRequirement[],
): ExpandedAtomicState => {
  const requirementsByFinding = new Map<string, AtomicRequirement[]>();
  for (const requirement of requirements) {
    const group = requirementsByFinding.get(requirement.findingId) ?? [];
    group.push(requirement);
    requirementsByFinding.set(requirement.findingId, group);
  }

  const expandedFindings = findings.filter(
    (finding) => !requirementsByFinding.has(finding.findingId),
  );
  const expandedRequirements: AtomicRequirement[] = [];
  const pendingConflicts: Finding[] = [];
  let conflictIndex = 0;

  for (const [
    originalFindingId,
    groupedRequirements,
  ] of requirementsByFinding) {
    const sourceFinding = findings.find(
      (finding) => finding.findingId === originalFindingId,
    );
    if (!sourceFinding) {
      throw new Error(
        `AtomicRequirement ${originalFindingId} 缺少关联 Finding`,
      );
    }
    const byStructure = new Map<string, AtomicRequirement[]>();
    for (const requirement of groupedRequirements) {
      const signature = atomicStructureSignature(requirement);
      const variants = byStructure.get(signature) ?? [];
      variants.push(requirement);
      byStructure.set(signature, variants);
    }

    const variants = [...byStructure.values()];
    variants.forEach((variantRequirements, variantIndex) => {
      const findingId =
        variantIndex === 0
          ? originalFindingId
          : `${originalFindingId}~atomic-${variantIndex + 1}`;
      const anchors = new Map(
        variantRequirements
          .flatMap((requirement) => requirement.sourceAnchors)
          .map((item) => [anchorIdentity(item), item] as const),
      );
      expandedFindings.push(
        FindingSchema.parse({
          ...sourceFinding,
          findingId,
          sourceAnchors: [...anchors.values()],
          requiredReview: sourceFinding.requiredReview || variants.length > 1,
        }),
      );
      variantRequirements.forEach((requirement, requirementIndex) => {
        expandedRequirements.push(
          AtomicRequirementSchema.parse({
            ...requirement,
            requirementId:
              variantIndex === 0 || requirementIndex > 0
                ? requirement.requirementId
                : `${requirement.requirementId}~atomic-${variantIndex + 1}`,
            findingId,
            manualVerificationRequired:
              requirement.manualVerificationRequired || variants.length > 1,
          }),
        );
      });
    });

    if (variants.length > 1) {
      conflictIndex += 1;
      pendingConflicts.push(
        FindingSchema.parse({
          findingId: `SYS-PENDING-ATOMIC-CONFLICT-${conflictIndex}`,
          category: "pending_confirmation:atomic_conflict",
          statement: `待确认：原子要求 ${originalFindingId} 在分块间产生 ${variants.length} 个结构差异版本，系统已分别保留，禁止静默合并。`,
          claimType: "pending_confirmation",
          sourceAnchors: unique(
            groupedRequirements.flatMap((requirement) =>
              requirement.sourceAnchors.map(anchorIdentity),
            ),
          ).map((key) => JSON.parse(key) as SourceAnchor),
          inferenceParents: variants.map((_, index) =>
            index === 0
              ? originalFindingId
              : `${originalFindingId}~atomic-${index + 1}`,
          ),
          reviewStatus: "unreviewed",
          requiredReview: true,
          revisionRecords: [],
        }),
      );
    }
  }

  return {
    findings: expandedFindings,
    requirements: expandedRequirements,
    pendingConflicts,
  };
};

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
    if (
      atomicStructureSignature(existing) !==
      atomicStructureSignature(requirement)
    ) {
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
  const expandedAtomicState = expandConflictingAtomicIds(
    checkpoint.findings,
    checkpoint.atomicRequirements,
  );
  const withSystemFindings = [
    ...expandedAtomicState.findings,
    ...conflictFindings,
    ...expandedAtomicState.pendingConflicts,
    fileProfilePendingFinding(),
  ];

  const atomicSignatureByFindingId = new Map<string, string>();
  for (const requirement of expandedAtomicState.requirements) {
    const signature = atomicStructureSignature(requirement);
    const existing = atomicSignatureByFindingId.get(requirement.findingId);
    if (existing && existing !== signature) {
      throw new Error(
        `原子要求 ${requirement.findingId} 未能按结构差异安全展开`,
      );
    }
    atomicSignatureByFindingId.set(requirement.findingId, signature);
  }
  const canonicalizationKey = (finding: Finding): string =>
    JSON.stringify([
      findingDeduplicationKey(finding),
      finding.category === "atomic_requirement"
        ? (atomicSignatureByFindingId.get(finding.findingId) ?? null)
        : null,
    ]);

  const idToKey = new Map<string, string>();
  const keyToCanonicalId = new Map<string, string>();
  for (const finding of withSystemFindings) {
    const key = canonicalizationKey(finding);
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

  const findings = mergeFindings(withSystemFindings, canonicalizationKey).map(
    (finding) =>
      FindingSchema.parse({
        ...finding,
        inferenceParents: unique(
          finding.inferenceParents.map((id) => findingAliases[id] ?? id),
        ),
      }),
  );
  const atomicRequirements = mergeAtomicRequirements(
    expandedAtomicState.requirements,
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
  officialPrimaryContext: Readonly<Record<string, readonly string[]>>,
): void => {
  if (
    checkpoint.inputFingerprint !== inputFingerprint ||
    checkpoint.model !== input.model.trim() ||
    checkpoint.hasOfficialInterpretation !== input.hasOfficialInterpretation
  ) {
    throw new Error(
      "重启元数据与当前模型、来源、分块策略、执行计划或官方解读状态不一致",
    );
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
    const pairedRegulatorySourceIds = new Set(
      node.chunk.sourceType === "official_interpretation"
        ? node.chunk.inputSourceIds.flatMap(
            (sourceId) => officialPrimaryContext[sourceId] ?? [],
          )
        : [],
    );
    const priorFindingIds = new Set(
      checkpoint.runs
        .slice(0, index)
        .flatMap((priorRun) => priorRun.findingIds),
    );
    const primaryFindings = checkpoint.findings.filter(
      (finding) =>
        priorFindingIds.has(finding.findingId) &&
        finding.claimType === "regulatory_fact" &&
        finding.sourceAnchors.length > 0 &&
        finding.sourceAnchors.every((anchor) =>
          pairedRegulatorySourceIds.has(anchor.sourceId),
        ),
    );
    const expectedInputSourceIds = [
      ...(node.chunk.sourceType === "official_interpretation"
        ? scopeWithPrimaryFindings(node.chunk, primaryFindings).keys()
        : node.chunk.inputSourceIds),
    ];
    if (
      run.model !== input.model.trim() ||
      run.promptVersion !== node.promptVersion ||
      run.inputSourceIds.join("\u0000") !==
        expectedInputSourceIds.join("\u0000")
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

  const chunkOptions = resolveChunkPolicy(input.chunkOptions);
  const officialPrimaryContext = normalizeOfficialPrimaryContext(
    input.officialPrimaryContext,
    sourceById,
  );
  const chunks = chunkDocument(input.sourceUnits, chunkOptions);
  const nodes = nodesFor(chunks);
  const inputFingerprint = await executionPlanFingerprint(
    input.sourceUnits,
    chunkOptions,
    nodes,
    officialPrimaryContext,
  );
  let checkpoint = input.resumeFrom
    ? AnalysisCheckpointSchema.parse(input.resumeFrom)
    : initialCheckpoint(
        inputFingerprint,
        model,
        input.hasOfficialInterpretation,
      );
  if (input.resumeFrom)
    validateResume(
      checkpoint,
      nodes,
      inputFingerprint,
      input,
      officialPrimaryContext,
    );

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
    let requestScope: AuthorizedSourceScope = scopeForChunk(node.chunk);

    if (node.stage === "document_identity") {
      const pairedRegulatorySourceIds = new Set(
        node.chunk.sourceType === "official_interpretation"
          ? node.chunk.inputSourceIds.flatMap(
              (sourceId) => officialPrimaryContext[sourceId] ?? [],
            )
          : [],
      );
      const primaryFindings =
        node.chunk.sourceType === "official_interpretation"
          ? checkpoint.findings.filter(
              (finding) =>
                finding.claimType === "regulatory_fact" &&
                finding.sourceAnchors.length > 0 &&
                finding.sourceAnchors.every((anchor) =>
                  pairedRegulatorySourceIds.has(anchor.sourceId),
                ),
            )
          : [];
      requestScope = scopeWithPrimaryFindings(node.chunk, primaryFindings);
      requestInputSourceIds = [...requestScope.keys()];
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
      validateFindings(findings, requestScope);
      conflicts.forEach((conflict) => {
        validateAnchors(conflict.sourceAnchors, requestScope);
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
      validateAtomicResponse(parsed, requestScope);
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
      validateFindings(findings, requestScope);
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
      const upstreamFindings = checkpoint.findings.filter(
        (finding) =>
          finding.claimType === "regulatory_fact" &&
          finding.sourceAnchors.length > 0 &&
          finding.sourceAnchors.every((anchor) =>
            anchorIsAuthorized(anchor, requestScope),
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
      const structured = buildStructuredImpacts(
        parsed,
        upstreamFindings,
        requestScope,
      );
      findings = structured.findings;
      inferenceRelationships = structured.relationships;
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
