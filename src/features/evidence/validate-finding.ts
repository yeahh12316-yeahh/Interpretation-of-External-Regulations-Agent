import type { Finding } from "../../domain/finding";
import type { SourceAnchor, SourceUnit } from "../../domain/source";
import type { AtomicRequirement } from "../analysis/skill-orchestrator";
import type { ParsedSourceUnit } from "../parsing/build-anchors";
import {
  canonicalAtomicStrength,
  extractDates,
  extractModalTerms,
  extractNumbers,
  normalizeText,
  protectedClaimSkeleton,
  singleCharacterModalContexts,
} from "./normalize-text";

export type ValidationRule =
  | "source_id"
  | "source_type"
  | "locator_page"
  | "locator_paragraph"
  | "locator_article"
  | "quote_match"
  | "atomic_structure"
  | "modal_strength"
  | "dates"
  | "numbers"
  | "inference_parent";

export type ValidationSeverity = "info" | "warning" | "error";
export type ValidationStatus = "passed" | "failed" | "manual_review_required";

export interface ValidationResult {
  rule: ValidationRule;
  status: ValidationStatus;
  /** Compatibility projection only. `status` is authoritative. */
  passed: boolean;
  message: string;
  severity: ValidationSeverity;
}

export type OfficialPrimarySourceIds = Readonly<
  Record<string, readonly string[]>
>;

export interface SourceIndexInput {
  sources: readonly SourceUnit[];
  parsedUnits: readonly ParsedSourceUnit[];
  findings?: readonly Finding[];
  officialPrimarySourceIds?: OfficialPrimarySourceIds;
  atomicRequirements?: readonly AtomicRequirement[];
}

export interface IndexedParsedUnit {
  unit: ParsedSourceUnit;
  effectiveArticle: string | null;
}

export interface SourceIndex {
  readonly sources: readonly SourceUnit[];
  readonly parsedUnits: readonly ParsedSourceUnit[];
  readonly findings: readonly Finding[];
  readonly sourceById: ReadonlyMap<string, readonly SourceUnit[]>;
  readonly findingById: ReadonlyMap<string, Finding>;
  readonly indexedUnits: readonly IndexedParsedUnit[];
  readonly officialPrimarySourceIds?: OfficialPrimarySourceIds;
  readonly atomicRequirementsByFindingId: ReadonlyMap<
    string,
    readonly AtomicRequirement[]
  >;
}

const anchorKey = (anchor: SourceAnchor): string => JSON.stringify(anchor);

export function createSourceIndex({
  sources,
  parsedUnits,
  findings = [],
  officialPrimarySourceIds,
  atomicRequirements = [],
}: SourceIndexInput): SourceIndex {
  const sourceById = new Map<string, SourceUnit[]>();
  for (const source of sources) {
    sourceById.set(source.sourceId, [
      ...(sourceById.get(source.sourceId) ?? []),
      source,
    ]);
  }

  const articleBySource = new Map<string, string>();
  const indexedUnits = parsedUnits.map((unit) => {
    if (unit.article) articleBySource.set(unit.sourceId, unit.article);
    return {
      unit,
      effectiveArticle:
        unit.article ?? articleBySource.get(unit.sourceId) ?? null,
    };
  });

  return {
    sources,
    parsedUnits,
    findings,
    sourceById,
    findingById: new Map(
      findings.map((finding) => [finding.findingId, finding]),
    ),
    indexedUnits,
    officialPrimarySourceIds,
    atomicRequirementsByFindingId: new Map(
      [...new Set(atomicRequirements.map(({ findingId }) => findingId))].map(
        (findingId) => [
          findingId,
          atomicRequirements.filter(
            (requirement) => requirement.findingId === findingId,
          ),
        ],
      ),
    ),
  };
}

const result = (
  rule: ValidationRule,
  statusOrPassed: ValidationStatus | boolean,
  success: string,
  failure: string,
  failureSeverity: ValidationSeverity = "error",
  manualMessage = "该规则无法由确定性证据自动证明，需人工确认。",
): ValidationResult => {
  const status: ValidationStatus =
    typeof statusOrPassed === "boolean"
      ? statusOrPassed
        ? "passed"
        : "failed"
      : statusOrPassed;
  return {
    rule,
    status,
    passed: status === "passed",
    message:
      status === "passed"
        ? success
        : status === "manual_review_required"
          ? manualMessage
          : failure,
    severity:
      status === "passed"
        ? "info"
        : status === "manual_review_required"
          ? "warning"
          : failureSeverity,
  };
};

const unitsForAnchor = (
  anchor: SourceAnchor,
  index: SourceIndex,
): readonly IndexedParsedUnit[] =>
  index.indexedUnits.filter(({ unit }) => {
    const authorizedSources = index.sourceById.get(unit.sourceId) ?? [];
    const [source] = authorizedSources;
    return (
      authorizedSources.length === 1 &&
      source.sourceType === unit.sourceType &&
      normalizeText(source.content).includes(normalizeText(unit.text)) &&
      unit.sourceId === anchor.sourceId &&
      unit.sourceType === anchor.sourceType
    );
  });

const pageMatches = (
  anchor: SourceAnchor,
  indexed: IndexedParsedUnit,
): boolean => indexed.unit.page === anchor.page;

const paragraphMatches = (
  anchor: SourceAnchor,
  indexed: IndexedParsedUnit,
): boolean =>
  pageMatches(anchor, indexed) &&
  indexed.unit.paragraphIndex === anchor.paragraphIndex;

const articleMatches = (
  anchor: SourceAnchor,
  indexed: IndexedParsedUnit,
): boolean =>
  paragraphMatches(anchor, indexed) &&
  normalizeText(indexed.effectiveArticle ?? "") ===
    normalizeText(anchor.article ?? "");

export const findParsedUnitForAnchor = (
  anchor: SourceAnchor,
  index: SourceIndex,
): ParsedSourceUnit | undefined =>
  findIndexedParsedUnitForAnchor(anchor, index)?.unit;

export const findIndexedParsedUnitForAnchor = (
  anchor: SourceAnchor,
  index: SourceIndex,
): IndexedParsedUnit | undefined =>
  unitsForAnchor(anchor, index).find(
    (indexed) =>
      articleMatches(anchor, indexed) &&
      normalizeText(indexed.unit.text).includes(normalizeText(anchor.quote)),
  );

const everyAnchor = (
  anchors: readonly SourceAnchor[],
  predicate: (anchor: SourceAnchor) => boolean,
): boolean => anchors.length > 0 && anchors.every(predicate);

const tokensAreAuthorizedInOrder = (
  statementTokens: readonly string[],
  evidenceTokens: readonly string[],
): boolean => {
  let evidenceIndex = 0;
  for (const statementToken of statementTokens) {
    while (
      evidenceIndex < evidenceTokens.length &&
      evidenceTokens[evidenceIndex] !== statementToken
    ) {
      evidenceIndex += 1;
    }
    if (evidenceIndex === evidenceTokens.length) return false;
    evidenceIndex += 1;
  }
  return true;
};

const evidenceFor = (finding: Finding, index: SourceIndex): string => {
  const parentEvidence =
    finding.claimType === "ai_inference"
      ? finding.inferenceParents.flatMap((parentId) => {
          const parent = index.findingById.get(parentId);
          return parent
            ? [
                parent.statement,
                ...parent.sourceAnchors.map(({ quote }) => quote),
              ]
            : [];
        })
      : [];
  return [
    ...finding.sourceAnchors.map(({ quote }) => quote),
    ...parentEvidence,
  ].join("\n");
};

const OFFICIAL_WRAPPER_LABELS: Readonly<Record<string, string>> = {
  "official_context:policy_background": "政策背景",
  "official_context:regulatory_intent": "监管意图",
  "official_context:implementation_guidance": "实施说明",
};

const officialWrapperValid = (finding: Finding): boolean => {
  const label = OFFICIAL_WRAPPER_LABELS[finding.category];
  if (!label || finding.sourceAnchors.length !== 1) return false;
  const excerpt = finding.sourceAnchors[0].quote;
  return (
    finding.statement ===
    `官方解读材料摘录（${label}）：“${excerpt}”。该摘录仅作为官方说明材料，不建立或覆盖监管文件效力、适用性或其他法律结论，须经人工合规复核。`
  );
};

const anchorSetMatches = (
  finding: Finding,
  requirement: AtomicRequirement,
): boolean => {
  const requirementAnchors = new Set(requirement.sourceAnchors.map(anchorKey));
  return (
    requirementAnchors.size === finding.sourceAnchors.length &&
    finding.sourceAnchors.every((anchor) =>
      requirementAnchors.has(anchorKey(anchor)),
    )
  );
};

const ATOMIC_FIELD_ORDER = [
  "subject",
  "strength",
  "action",
  "object",
  "condition",
  "frequency",
  "deadline",
  "responsibility",
  "exceptions",
  "sharedContext",
] as const;

type AtomicFieldName = (typeof ATOMIC_FIELD_ORDER)[number];

interface AtomicAllocation {
  field: AtomicFieldName;
  start: number;
  end: number;
}

interface AtomicStructureResult {
  status: ValidationStatus;
  message: string;
}

const compactAtomicText = (value: string): string =>
  normalizeText(value).replace(/\p{P}/gu, "");

const occurrencesOf = (text: string, value: string): AtomicAllocation[] => {
  const matches: AtomicAllocation[] = [];
  let start = text.indexOf(value);
  while (start >= 0) {
    matches.push({ field: "subject", start, end: start + value.length });
    start = text.indexOf(value, start + 1);
  }
  return matches;
};

const atomicStructure = (
  finding: Finding,
  index: SourceIndex,
): AtomicStructureResult => {
  if (finding.category !== "atomic_requirement") {
    return { status: "passed", message: "该结论不适用原子结构校验。" };
  }
  const requirements =
    index.atomicRequirementsByFindingId.get(finding.findingId) ?? [];
  if (requirements.length !== 1) {
    return {
      status: "failed",
      message: "原子要求缺少唯一的结构化记录。",
    };
  }
  const [requirement] = requirements;
  if (
    requirement.manualVerificationRequired ||
    ["应", "须"].includes(requirement.strength?.normalize("NFKC") ?? "")
  ) {
    return {
      status: "manual_review_required",
      message: "单字强度或上游人工复核标记不能由词法规则自动证明。",
    };
  }
  if (!anchorSetMatches(finding, requirement)) {
    return {
      status: "failed",
      message: "原子要求与当前来源引用不一致。",
    };
  }
  if (finding.sourceAnchors.length !== 1) {
    return {
      status: "manual_review_required",
      message: "原子要求跨多个引用，无法确定唯一的无损字段分配。",
    };
  }
  const quote = finding.sourceAnchors[0].quote;
  if (normalizeText(finding.statement) !== normalizeText(quote)) {
    return {
      status: "manual_review_required",
      message: "原子结论不是来源引用的确定性等值文本，需人工确认。",
    };
  }
  if (!requirement.strength || !canonicalAtomicStrength(requirement.strength)) {
    return {
      status: "manual_review_required",
      message: "原子要求强度缺失或无法确定分类，需人工确认。",
    };
  }
  const text = compactAtomicText(quote);
  const fields = ATOMIC_FIELD_ORDER.flatMap((field) => {
    const rawValue = requirement[field];
    if (!rawValue) return [];
    const value = compactAtomicText(rawValue);
    return value ? [{ field, value }] : [];
  });
  if (
    !requirement.subject ||
    !requirement.action ||
    !requirement.object ||
    fields.some(
      ({ field, value }) => field !== "strength" && value.length === 1,
    )
  ) {
    return {
      status: "manual_review_required",
      message: "原子字段缺失或可拆分为歧义单字，需人工确认。",
    };
  }
  const candidates = fields.map(({ field, value }) => ({
    field,
    matches: occurrencesOf(text, value).map((match) => ({ ...match, field })),
  }));
  if (candidates.some(({ matches }) => matches.length === 0)) {
    return {
      status: "failed",
      message: "至少一个原子字段无法在当前来源引用中精确匹配。",
    };
  }

  const solutions: AtomicAllocation[][] = [];
  let allocationBudgetExceeded = false;
  let allocationAttempts = 0;
  const allocate = (fieldIndex: number, selected: AtomicAllocation[]) => {
    if (solutions.length > 1 || allocationBudgetExceeded) return;
    if (fieldIndex === candidates.length) {
      const covered = new Set<number>();
      selected.forEach(({ start, end }) => {
        for (let index = start; index < end; index += 1) covered.add(index);
      });
      const byField = new Map(selected.map((item) => [item.field, item]));
      const core = ["subject", "strength", "action", "object"]
        .map((field) => byField.get(field as AtomicFieldName))
        .filter((item): item is AtomicAllocation => item !== undefined);
      const coreOrdered = core.every(
        (item, index) => index === 0 || core[index - 1].end <= item.start,
      );
      if (covered.size === text.length && core.length === 4 && coreOrdered) {
        solutions.push(selected);
      }
      return;
    }
    for (const match of candidates[fieldIndex].matches) {
      allocationAttempts += 1;
      if (allocationAttempts > 10_000) {
        allocationBudgetExceeded = true;
        return;
      }
      if (
        selected.some(
          (item) => match.start < item.end && match.end > item.start,
        )
      ) {
        continue;
      }
      allocate(fieldIndex + 1, [...selected, match]);
    }
  };
  allocate(0, []);

  if (solutions.length !== 1 || allocationBudgetExceeded) {
    return {
      status: "manual_review_required",
      message: allocationBudgetExceeded
        ? "原子字段候选过多，无法确定唯一分配，需人工确认。"
        : solutions.length === 0
          ? "原子字段不能对来源引用形成唯一、无重叠、无遗漏的覆盖。"
          : "原子字段存在多种分配或已标记需人工复核。",
    };
  }
  return {
    status: "passed",
    message: "原子字段已对来源引用形成唯一、无重叠、无遗漏的自动覆盖。",
  };
};

const protectedSkeletonSupported = (
  finding: Finding,
  text: string = finding.statement,
): boolean => {
  const statementSkeleton = protectedClaimSkeleton(text);
  return finding.sourceAnchors.some((anchor) =>
    protectedClaimSkeleton(anchor.quote).includes(statementSkeleton),
  );
};

const modalTermsPreserved = (
  finding: Finding,
  index: SourceIndex,
  structure: AtomicStructureResult,
): ValidationStatus => {
  if (
    finding.claimType === "ai_inference" ||
    finding.claimType === "human_judgment"
  ) {
    return "passed";
  }
  if (finding.claimType === "official_explanation") {
    return officialWrapperValid(finding) ? "passed" : "failed";
  }
  const evidenceTerms = extractModalTerms(evidenceFor(finding, index));
  const statementTerms = extractModalTerms(finding.statement);
  const evidenceSingleCharacterContexts = singleCharacterModalContexts(
    evidenceFor(finding, index),
  );
  const statementSingleCharacterContexts = singleCharacterModalContexts(
    finding.statement,
  );
  const hasProtectedClaim =
    statementTerms.length > 0 ||
    extractDates(finding.statement).length > 0 ||
    extractNumbers(finding.statement).length > 0;
  if (hasProtectedClaim && !protectedSkeletonSupported(finding)) {
    return "failed";
  }
  if (finding.category === "atomic_requirement") {
    const requirements =
      index.atomicRequirementsByFindingId.get(finding.findingId) ?? [];
    if (requirements.length !== 1) return "failed";
    const [requirement] = requirements;
    if (
      requirement.manualVerificationRequired ||
      ["应", "须"].includes(requirement.strength?.normalize("NFKC") ?? "")
    ) {
      return "manual_review_required";
    }
    if (!anchorSetMatches(finding, requirement)) return "failed";
    const structuredStrength = requirement.strength
      ? canonicalAtomicStrength(requirement.strength)
      : null;
    if (requirement.strength && !structuredStrength) return "failed";
    if (structure.status !== "passed") return structure.status;
    if (requirement.strength === null) {
      return statementTerms.length === 0 && evidenceTerms.length === 0
        ? "passed"
        : "failed";
    }
    const structuredTerms = extractModalTerms(requirement.strength);
    return structuredTerms.length === 1 &&
      structuredTerms.join("\u0000") === statementTerms.join("\u0000") &&
      structuredTerms.join("\u0000") === evidenceTerms.join("\u0000")
      ? "passed"
      : "failed";
  }
  return evidenceTerms.join("\u0000") === statementTerms.join("\u0000") &&
    evidenceSingleCharacterContexts.join("\u0000") ===
      statementSingleCharacterContexts.join("\u0000")
    ? "passed"
    : "failed";
};

const sourceTypeMatchesClaim = (finding: Finding): boolean => {
  if (finding.claimType === "regulatory_fact") {
    return everyAnchor(
      finding.sourceAnchors,
      (anchor) => anchor.sourceType === "regulatory_text",
    );
  }
  if (finding.claimType === "official_explanation") {
    return everyAnchor(
      finding.sourceAnchors,
      (anchor) => anchor.sourceType === "official_interpretation",
    );
  }
  return true;
};

const inferenceProvenanceMatches = (
  finding: Finding,
  index: SourceIndex,
): boolean => {
  if (finding.claimType === "official_explanation") {
    if (finding.inferenceParents.length === 0) return false;
    if (!index.officialPrimarySourceIds) return false;
    const parents = finding.inferenceParents.map((id) =>
      index.findingById.get(id),
    );
    if (
      parents.some(
        (parent) =>
          !parent ||
          parent.findingId === finding.findingId ||
          !["regulatory_fact", "pending_confirmation"].includes(
            parent.claimType,
          ) ||
          parent.sourceAnchors.length === 0 ||
          parent.sourceAnchors.some(
            (anchor) =>
              anchor.sourceType !== "regulatory_text" ||
              findParsedUnitForAnchor(anchor, index) === undefined,
          ),
      )
    ) {
      return false;
    }
    const parentSourceIds = [
      ...new Set(
        parents.flatMap((parent) =>
          parent!.sourceAnchors.map(({ sourceId }) => sourceId),
        ),
      ),
    ].sort();
    return finding.sourceAnchors.every((officialAnchor) => {
      const allowed = index.officialPrimarySourceIds?.[officialAnchor.sourceId];
      if (!allowed) return false;
      const uniqueAllowed = [...new Set(allowed)].sort();
      return (
        uniqueAllowed.length === allowed.length &&
        uniqueAllowed.join("\u0000") === parentSourceIds.join("\u0000")
      );
    });
  }
  if (finding.inferenceParents.length === 0) {
    return finding.claimType !== "ai_inference";
  }
  const parents = finding.inferenceParents.map((id) =>
    index.findingById.get(id),
  );
  if (
    parents.some((parent) => !parent || parent.findingId === finding.findingId)
  ) {
    return false;
  }
  if (finding.claimType !== "ai_inference") return true;
  const parentAnchorKeys = new Set(
    parents.flatMap((parent) => parent!.sourceAnchors.map(anchorKey)),
  );
  return (
    finding.sourceAnchors.length > 0 &&
    finding.sourceAnchors.every((anchor) =>
      parentAnchorKeys.has(anchorKey(anchor)),
    )
  );
};

export function validateFinding(
  finding: Finding,
  index: SourceIndex,
): ValidationResult[] {
  const anchors = finding.sourceAnchors;
  const sourceIdPassed = everyAnchor(
    anchors,
    (anchor) => (index.sourceById.get(anchor.sourceId)?.length ?? 0) === 1,
  );
  const sourceTypePassed =
    sourceIdPassed &&
    everyAnchor(anchors, (anchor) => {
      const [source] = index.sourceById.get(anchor.sourceId) ?? [];
      return source?.sourceType === anchor.sourceType;
    }) &&
    sourceTypeMatchesClaim(finding);

  const pagePassed = everyAnchor(anchors, (anchor) =>
    unitsForAnchor(anchor, index).some((unit) => pageMatches(anchor, unit)),
  );
  const paragraphPassed = everyAnchor(anchors, (anchor) =>
    unitsForAnchor(anchor, index).some((unit) =>
      paragraphMatches(anchor, unit),
    ),
  );
  const articlePassed = everyAnchor(anchors, (anchor) =>
    unitsForAnchor(anchor, index).some((unit) => articleMatches(anchor, unit)),
  );
  const quotePassed = everyAnchor(
    anchors,
    (anchor) => findParsedUnitForAnchor(anchor, index) !== undefined,
  );

  const evidence = evidenceFor(finding, index);
  const protectedClaimText =
    finding.claimType === "official_explanation"
      ? finding.sourceAnchors.map(({ quote }) => quote).join("\n")
      : finding.claimType === "human_judgment"
        ? ""
        : finding.statement;
  const statementDates = extractDates(protectedClaimText);
  const statementNumbers = extractNumbers(protectedClaimText);
  const protectedAssociationPassed =
    statementDates.length === 0 && statementNumbers.length === 0
      ? true
      : protectedSkeletonSupported(finding, protectedClaimText);
  const datesPassed =
    protectedAssociationPassed &&
    tokensAreAuthorizedInOrder(statementDates, extractDates(evidence));
  const numbersPassed =
    protectedAssociationPassed &&
    tokensAreAuthorizedInOrder(statementNumbers, extractNumbers(evidence));
  const inferencePassed = inferenceProvenanceMatches(finding, index);
  const structure = atomicStructure(finding, index);

  return [
    result(
      "source_id",
      sourceIdPassed,
      "全部引用均绑定唯一的项目来源 ID。",
      "引用缺少唯一授权来源，来源可能已删除或 ID 重复。",
    ),
    result(
      "source_type",
      sourceTypePassed,
      "来源类型与文件及结论类型一致。",
      "来源类型与文件或结论类型不一致，监管原文与官方解读不得混用。",
    ),
    result(
      "locator_page",
      pagePassed,
      "页码定位与解析单元一致；无固定页码材料已按 null 定位确认。",
      "页码定位缺失或与解析单元冲突，待校验。",
    ),
    result(
      "locator_paragraph",
      paragraphPassed,
      "段落序号与解析单元一致。",
      "段落序号缺失或与解析单元冲突，待校验。",
    ),
    result(
      "locator_article",
      articlePassed,
      "条款定位与解析单元一致；无条款材料已按 null 定位确认。",
      "条款定位缺失或与解析单元冲突，待校验。",
    ),
    result(
      "quote_match",
      quotePassed,
      "引用已在相同来源、页码、条款和段落的解析原文中反向匹配。",
      "引用未在权威解析定位中反向匹配，待校验。",
    ),
    result(
      "atomic_structure",
      structure.status,
      structure.message,
      structure.message,
      "error",
      structure.message,
    ),
    result(
      "modal_strength",
      modalTermsPreserved(finding, index, structure),
      "可以、宜、应、须、应当、必须、不得、禁止、严禁等方向与强度保持一致。",
      "结论新增、遗漏或改变了监管方向或强度词。",
    ),
    result(
      "dates",
      datesPassed,
      "结论中的日期均有来源依据。",
      "结论包含来源依据中不存在的日期。",
    ),
    result(
      "numbers",
      numbersPassed,
      "结论中的数字和比例均有来源依据。",
      "结论包含来源依据中不存在的数字或比例。",
    ),
    result(
      "inference_parent",
      inferencePassed,
      finding.claimType === "ai_inference"
        ? "AI 推导父项存在，且引用属于父项证据。"
        : finding.claimType === "official_explanation"
          ? "官方解读已绑定经权威解析确认的监管原文父项。"
          : "该结论无需 AI 推导父项校验。",
      finding.claimType === "official_explanation"
        ? "官方解读缺少有效监管原文父项，或来源配对不一致。"
        : "AI 推导缺少有效父项，或引用超出父项证据范围。",
    ),
  ];
}
