import { z } from "zod";

import type { ClaimType } from "./finding";

export const HUMAN_JUDGMENT_PURPOSES = [
  "generic",
  "recommended_action",
] as const;
export const HumanJudgmentPurposeSchema = z.enum(HUMAN_JUDGMENT_PURPOSES);
export type HumanJudgmentPurpose = z.infer<typeof HumanJudgmentPurposeSchema>;

export const HUMAN_JUDGMENT_CATEGORIES = [
  "human_review",
  "recommended_action:priority",
] as const;
export const HumanJudgmentCategorySchema = z.enum(HUMAN_JUDGMENT_CATEGORIES);
export type HumanJudgmentCategory = z.infer<typeof HumanJudgmentCategorySchema>;

const HUMAN_CATEGORY_BY_PURPOSE: Readonly<
  Record<HumanJudgmentPurpose, HumanJudgmentCategory>
> = {
  generic: "human_review",
  recommended_action: "recommended_action:priority",
};

export const humanJudgmentCategoryForPurpose = (
  purpose: HumanJudgmentPurpose,
): HumanJudgmentCategory => {
  const parsed = HumanJudgmentPurposeSchema.safeParse(purpose);
  if (!parsed.success) throw new Error("人工判断用途不在允许范围内");
  return HUMAN_CATEGORY_BY_PURPOSE[parsed.data];
};

/**
 * Resolves the only approved human-judgment purpose/category bindings.
 * `purpose` may be absent only when the caller explicitly identifies an exact,
 * pre-purpose legal record; the closed category then supplies the migration.
 */
export const resolveHumanJudgmentPurpose = (input: {
  readonly claimType: ClaimType;
  readonly category: string;
  readonly purpose?: unknown;
  readonly allowLegacyMissingPurpose?: boolean;
}): HumanJudgmentPurpose => {
  if (input.claimType !== "human_judgment") {
    throw new Error("人工判断用途只能绑定 human_judgment claimType");
  }
  const parsedCategory = HumanJudgmentCategorySchema.safeParse(input.category);
  if (!parsedCategory.success)
    throw new Error("人工判断类别不在闭合用途映射内");
  const category = parsedCategory.data;
  const derivedPurpose: HumanJudgmentPurpose =
    category === "recommended_action:priority"
      ? "recommended_action"
      : "generic";
  if (input.purpose === undefined) {
    if (!input.allowLegacyMissingPurpose)
      throw new Error("当前人工判断动作缺少结构化用途");
  } else {
    const parsedPurpose = HumanJudgmentPurposeSchema.safeParse(input.purpose);
    if (!parsedPurpose.success || parsedPurpose.data !== derivedPurpose) {
      throw new Error("人工判断用途与闭合类别不匹配");
    }
  }
  return derivedPurpose;
};

export const INSTITUTION_IMPACT_DIMENSIONS = [
  "governance",
  "institution",
  "process",
  "system",
  "data",
  "people",
  "reporting",
] as const;
export const InstitutionImpactDimensionSchema = z.enum(
  INSTITUTION_IMPACT_DIMENSIONS,
);
export type InstitutionImpactDimension = z.infer<
  typeof InstitutionImpactDimensionSchema
>;

export const INSTITUTION_IMPACT_CATEGORIES = [
  "institution_impact:governance",
  "institution_impact:institution",
  "institution_impact:process",
  "institution_impact:system",
  "institution_impact:data",
  "institution_impact:people",
  "institution_impact:reporting",
] as const;
export const InstitutionImpactCategorySchema = z.enum(
  INSTITUTION_IMPACT_CATEGORIES,
);
export type InstitutionImpactCategory = z.infer<
  typeof InstitutionImpactCategorySchema
>;

export const institutionImpactCategoryForDimension = (
  dimension: InstitutionImpactDimension,
): InstitutionImpactCategory => `institution_impact:${dimension}`;

export const institutionImpactDimensionForCategory = (
  category: string,
): InstitutionImpactDimension | undefined => {
  const parsed = InstitutionImpactCategorySchema.safeParse(category);
  if (!parsed.success) return undefined;
  return InstitutionImpactDimensionSchema.parse(
    parsed.data.slice("institution_impact:".length),
  );
};

export const INSTITUTION_IMPACT_LABELS: Readonly<
  Record<InstitutionImpactDimension, string>
> = {
  governance: "治理",
  institution: "制度",
  process: "流程",
  system: "系统",
  data: "数据",
  people: "人员",
  reporting: "报告",
};
