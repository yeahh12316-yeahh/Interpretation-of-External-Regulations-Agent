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
  | "modal_strength"
  | "dates"
  | "numbers"
  | "inference_parent";

export type ValidationSeverity = "info" | "warning" | "error";

export interface ValidationResult {
  rule: ValidationRule;
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
  passed: boolean,
  success: string,
  failure: string,
  failureSeverity: ValidationSeverity = "error",
): ValidationResult => ({
  rule,
  passed,
  message: passed ? success : failure,
  severity: passed ? "info" : failureSeverity,
});

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

const structuredModifierValues = (
  requirement: AtomicRequirement,
): readonly string[] =>
  [
    requirement.condition,
    requirement.frequency,
    requirement.deadline,
    requirement.responsibility,
    requirement.exceptions,
    requirement.sharedContext,
  ].flatMap((value) => {
    if (!value) return [];
    const normalized = normalizeText(value).replace(/[\p{P}\s]/gu, "");
    return normalized ? [normalized] : [];
  });

const gapUsesOnlyStructuredModifiers = (
  gap: string,
  requirement: AtomicRequirement,
): boolean => {
  const compactGap = normalizeText(gap).replace(/[\p{P}\s]/gu, "");
  if (!compactGap) return true;
  const modifiers = [...new Set(structuredModifierValues(requirement))];
  const matches = (remaining: string, available: readonly string[]): boolean =>
    remaining.length === 0 ||
    available.some(
      (modifier, index) =>
        remaining.startsWith(modifier) &&
        matches(remaining.slice(modifier.length), [
          ...available.slice(0, index),
          ...available.slice(index + 1),
        ]),
    );
  return matches(compactGap, modifiers);
};

const structuredStrengthLocated = (
  text: string,
  requirement: AtomicRequirement,
): boolean => {
  if (!requirement.strength) return extractModalTerms(text).length === 0;
  const strength = normalizeText(requirement.strength);
  if (!canonicalAtomicStrength(strength)) return false;
  const subject = requirement.subject
    ? normalizeText(requirement.subject)
    : null;
  const action = requirement.action ? normalizeText(requirement.action) : null;
  const object = requirement.object ? normalizeText(requirement.object) : null;
  if (!subject || !action || !object) return false;
  const normalized = normalizeText(text);
  if (strength === "应" || strength === "须") {
    let subjectIndex = normalized.indexOf(subject);
    while (subjectIndex >= 0) {
      const subjectEnd = subjectIndex + subject.length;
      let strengthIndex = normalized.indexOf(strength, subjectEnd);
      while (strengthIndex >= 0) {
        const strengthEnd = strengthIndex + strength.length;
        const actionIndex = normalized.indexOf(action, strengthEnd);
        if (actionIndex >= strengthEnd) {
          const actionEnd = actionIndex + action.length;
          const objectIndex = normalized.indexOf(object, actionEnd);
          if (
            subjectIndex >= 0 &&
            strengthIndex >= subjectEnd &&
            actionIndex >= strengthEnd &&
            objectIndex >= actionEnd &&
            gapUsesOnlyStructuredModifiers(
              normalized.slice(subjectEnd, strengthIndex),
              requirement,
            ) &&
            gapUsesOnlyStructuredModifiers(
              normalized.slice(strengthEnd, actionIndex),
              requirement,
            )
          ) {
            return true;
          }
        }
        strengthIndex = normalized.indexOf(
          strength,
          strengthIndex + strength.length,
        );
      }
      subjectIndex = normalized.indexOf(subject, subjectIndex + subject.length);
    }
    return false;
  }
  let subjectIndex = normalized.indexOf(subject);
  while (subjectIndex >= 0) {
    const strengthIndex = normalized.indexOf(
      strength,
      subjectIndex + subject.length,
    );
    const actionIndex =
      strengthIndex < 0
        ? -1
        : normalized.indexOf(action, strengthIndex + strength.length);
    const objectIndex =
      actionIndex < 0
        ? -1
        : normalized.indexOf(object, actionIndex + action.length);
    if (strengthIndex >= 0 && actionIndex >= 0 && objectIndex >= 0) return true;
    subjectIndex = normalized.indexOf(subject, subjectIndex + subject.length);
  }
  return false;
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

const modalTermsPreserved = (finding: Finding, index: SourceIndex): boolean => {
  if (
    finding.claimType === "ai_inference" ||
    finding.claimType === "human_judgment"
  ) {
    return true;
  }
  if (finding.claimType === "official_explanation") {
    return officialWrapperValid(finding);
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
    return false;
  }
  if (finding.category === "atomic_requirement") {
    const requirements =
      index.atomicRequirementsByFindingId.get(finding.findingId) ?? [];
    if (requirements.length !== 1) return false;
    const [requirement] = requirements;
    if (!anchorSetMatches(finding, requirement)) return false;
    const structuredStrength = requirement.strength
      ? canonicalAtomicStrength(requirement.strength)
      : null;
    if (requirement.strength && !structuredStrength) return false;
    if (
      !structuredStrengthLocated(finding.statement, requirement) ||
      !finding.sourceAnchors.every((anchor) =>
        structuredStrengthLocated(anchor.quote, requirement),
      )
    ) {
      return false;
    }
    if (requirement.strength === null) {
      return statementTerms.length === 0 && evidenceTerms.length === 0;
    }
    if (["应", "须"].includes(requirement.strength.normalize("NFKC"))) {
      return statementTerms.length === 0 && evidenceTerms.length === 0;
    }
    const structuredTerms = extractModalTerms(requirement.strength);
    return (
      structuredTerms.length === 1 &&
      structuredTerms.join("\u0000") === statementTerms.join("\u0000") &&
      structuredTerms.join("\u0000") === evidenceTerms.join("\u0000")
    );
  }
  return (
    evidenceTerms.join("\u0000") === statementTerms.join("\u0000") &&
    evidenceSingleCharacterContexts.join("\u0000") ===
      statementSingleCharacterContexts.join("\u0000")
  );
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
      "modal_strength",
      modalTermsPreserved(finding, index),
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
