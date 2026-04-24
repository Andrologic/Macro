import type { PlanNode, PredictedBranch, ProjectGitFlowSettings } from "../types";
import {
  compileGitFlowTemplateTokenMatch,
  normalizeFeatureSlugInput,
  normalizeGitBranchName,
  renderGitFlowBranchName,
  renderStandaloneFeatureBranchName,
  resolveProjectGitFlowSettings,
  validateProjectGitFlowParsing as validateProjectGitFlowParsingSettings,
} from "./architectGitNaming";
import {
  getPlanNodeBranchIntent,
  type WorkBranchType,
} from "./gitFlowBranchIntents";

const PLAN_SLUG_FALLBACK = "plan";

const normalizeNodeProjectIds = (
  node: Pick<PlanNode, "projectId" | "projectIds">,
): string[] =>
  Array.from(
    new Set(
      [
        ...(Array.isArray(node.projectIds) ? node.projectIds : []),
        ...(node.projectId ? [node.projectId] : []),
      ]
        .filter((projectId): projectId is string => typeof projectId === "string")
        .map((projectId) => projectId.trim())
        .filter((projectId) => projectId.length > 0),
    ),
  );

export const normalizePlanSlugInput = (
  value?: string | null,
  fallback = PLAN_SLUG_FALLBACK,
): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

export const buildPlanFeatureBranchKey = (
  planSlug: string,
  featureSlug: string,
): string =>
  `plan::${normalizePlanSlugInput(planSlug)}::feature::${normalizeFeatureSlugInput(featureSlug)}`;

export const buildStandaloneFeatureBranchKey = (featureSlug: string): string =>
  `standalone::${normalizeFeatureSlugInput(featureSlug)}`;

export type ParsedBranchIdentity =
  | {
      kind: "plan";
      key: string;
      branchName: string;
      planSlug: string;
    }
  | {
      kind: "plan_feature";
      key: string;
      branchName: string;
      planSlug: string;
      featureSlug: string;
    }
  | {
      kind: "standalone_feature";
      key: string;
      branchName: string;
      featureSlug: string;
    }
  | {
      kind: "unknown";
      key: string;
      branchName: string;
    };

export interface RenderedPlanPredictedBranchDescriptor {
  key: string;
  projectId: string;
  taskIds: string[];
  branchType: WorkBranchType;
  branchSlug: string;
  name: string;
  parentBranch: string;
}

export const collectRenderedPlanPredictedBranchDescriptors = (params: {
  nodes: PlanNode[];
  planSlug: string;
  getProjectGitFlowSettings?: (
    projectId: string,
  ) => ProjectGitFlowSettings | undefined;
  getPlanIntegrationBranchName?: (projectId: string) => string;
}): RenderedPlanPredictedBranchDescriptor[] => {
  const descriptors = new Map<string, RenderedPlanPredictedBranchDescriptor>();

  params.nodes.forEach((node) => {
    const branchIntent = getPlanNodeBranchIntent(node);
    normalizeNodeProjectIds(node).forEach((projectId) => {
      const settings = params.getProjectGitFlowSettings?.(projectId);
      const key = `${projectId}::${branchIntent.key}`;
      const existing = descriptors.get(key);
      if (existing) {
        existing.taskIds.push(node.id);
        return;
      }

      descriptors.set(key, {
        key,
        projectId,
        taskIds: [node.id],
        branchType: branchIntent.branchType,
        branchSlug: branchIntent.branchSlug,
        name: renderPlanFeatureBranchName({
          planSlug: params.planSlug,
          featureSlug: branchIntent.branchSlug,
          settings,
        }),
        parentBranch:
          params.getPlanIntegrationBranchName?.(projectId) ||
          renderPlanIntegrationBranchName({
            planSlug: params.planSlug,
            settings,
          }),
      });
    });
  });

  return Array.from(descriptors.values()).map((descriptor) => ({
    ...descriptor,
    taskIds: Array.from(new Set(descriptor.taskIds)),
  }));
};

const parsePlanBranchName = (
  branchName: string,
  settings?: Partial<ProjectGitFlowSettings> | null,
): ParsedBranchIdentity | null => {
  const normalizedBranchName = normalizeGitBranchName(branchName);
  if (!normalizedBranchName) return null;
  const resolvedSettings = resolveProjectGitFlowSettings(settings);
  const compiled = compileGitFlowTemplateTokenMatch(resolvedSettings.planBranchTemplate, [
    "planSlug",
  ]);
  if (compiled.duplicateTokens.length > 0 || compiled.unsupportedTokens.length > 0) return null;
  const match = compiled.regex.exec(normalizedBranchName);
  const planSlug = match?.groups?.planSlug;
  if (!planSlug) return null;
  return {
    kind: "plan",
    key: `plan::${normalizePlanSlugInput(planSlug)}`,
    branchName: normalizedBranchName,
    planSlug: normalizePlanSlugInput(planSlug),
  };
};

const parsePlanFeatureBranchName = (
  branchName: string,
  settings?: Partial<ProjectGitFlowSettings> | null,
): ParsedBranchIdentity | null => {
  const normalizedBranchName = normalizeGitBranchName(branchName);
  if (!normalizedBranchName) return null;
  const resolvedSettings = resolveProjectGitFlowSettings(settings);
  const compiled = compileGitFlowTemplateTokenMatch(resolvedSettings.featureBranchTemplate, [
    "planSlug",
    "featureSlug",
  ]);
  if (compiled.duplicateTokens.length > 0 || compiled.unsupportedTokens.length > 0) return null;
  const match = compiled.regex.exec(normalizedBranchName);
  const planSlug = match?.groups?.planSlug;
  const featureSlug = match?.groups?.featureSlug;
  if (!planSlug || !featureSlug) return null;
  return {
    kind: "plan_feature",
    key: buildPlanFeatureBranchKey(planSlug, featureSlug),
    branchName: normalizedBranchName,
    planSlug: normalizePlanSlugInput(planSlug),
    featureSlug: normalizeFeatureSlugInput(featureSlug),
  };
};

const parseStandaloneFeatureBranchName = (
  branchName: string,
  settings?: Partial<ProjectGitFlowSettings> | null,
): ParsedBranchIdentity | null => {
  const normalizedBranchName = normalizeGitBranchName(branchName);
  if (!normalizedBranchName) return null;
  const resolvedSettings = resolveProjectGitFlowSettings(settings);
  const compiled = compileGitFlowTemplateTokenMatch(
    resolvedSettings.standaloneFeatureBranchTemplate,
    ["featureSlug"],
  );
  if (compiled.duplicateTokens.length > 0 || compiled.unsupportedTokens.length > 0) return null;
  const match = compiled.regex.exec(normalizedBranchName);
  const featureSlug = match?.groups?.featureSlug;
  if (!featureSlug) return null;
  return {
    kind: "standalone_feature",
    key: buildStandaloneFeatureBranchKey(featureSlug),
    branchName: normalizedBranchName,
    featureSlug: normalizeFeatureSlugInput(featureSlug),
  };
};

export const parseRenderedBranchIdentity = (
  branchName: string,
  settings?: Partial<ProjectGitFlowSettings> | null,
): ParsedBranchIdentity => {
  const normalizedBranchName = normalizeGitBranchName(branchName);
  if (!normalizedBranchName) {
    return {
      kind: "unknown",
      key: "unknown::work",
      branchName: "",
    };
  }

  return (
    parsePlanFeatureBranchName(normalizedBranchName, settings) ||
    parseStandaloneFeatureBranchName(normalizedBranchName, settings) ||
    parsePlanBranchName(normalizedBranchName, settings) || {
      kind: "unknown",
      key: `unknown::${normalizedBranchName}`,
      branchName: normalizedBranchName,
    }
  );
};

export const getPlanNodeLogicalBranchIdentity = (params: {
  planSlug: string;
  node: Pick<PlanNode, "assignedBranch" | "branchSlug" | "title">;
}): ParsedBranchIdentity => {
  const branchIntent = getPlanNodeBranchIntent(params.node);
  return {
    kind: "plan_feature",
    key: buildPlanFeatureBranchKey(params.planSlug, branchIntent.branchSlug),
    branchName: renderGitFlowBranchName({
      branchType: "feature",
      planSlug: params.planSlug,
      branchSlug: branchIntent.branchSlug,
    }),
    planSlug: normalizePlanSlugInput(params.planSlug),
    featureSlug: branchIntent.branchSlug,
  };
};

export const getPredictedBranchLogicalIdentity = (params: {
  planSlug?: string | null;
  branch: Pick<PredictedBranch, "name" | "branchSlug">;
  settings?: Partial<ProjectGitFlowSettings> | null;
}): ParsedBranchIdentity => {
  const normalizedPlanSlug = normalizePlanSlugInput(
    params.planSlug,
    PLAN_SLUG_FALLBACK,
  );
  const explicitBranchSlug = params.branch.branchSlug?.trim();
  if (explicitBranchSlug) {
    return {
      kind: "plan_feature",
      key: buildPlanFeatureBranchKey(normalizedPlanSlug, explicitBranchSlug),
      branchName: normalizeGitBranchName(params.branch.name),
      planSlug: normalizedPlanSlug,
      featureSlug: normalizeFeatureSlugInput(explicitBranchSlug),
    };
  }
  return parseRenderedBranchIdentity(params.branch.name, params.settings);
};

export const renderPlanFeatureBranchName = (params: {
  planSlug: string;
  featureSlug: string;
  settings?: Partial<ProjectGitFlowSettings> | null;
}): string =>
  renderGitFlowBranchName({
    branchType: "feature",
    planSlug: params.planSlug,
    branchSlug: params.featureSlug,
    settings: params.settings,
  });

export const renderPlanIntegrationBranchName = (params: {
  planSlug: string;
  settings?: Partial<ProjectGitFlowSettings> | null;
}): string =>
  renderGitFlowBranchName({
    branchType: "plan",
    planSlug: params.planSlug,
    settings: params.settings,
  });

export const renderStandaloneFeatureLogicalBranchName = (params: {
  featureSlug: string;
  settings?: Partial<ProjectGitFlowSettings> | null;
}): string =>
  renderStandaloneFeatureBranchName({
    featureSlug: params.featureSlug,
    settings: params.settings,
  });

export const validateProjectGitFlowParsing = (
  settings?: Partial<ProjectGitFlowSettings> | null,
): string[] => validateProjectGitFlowParsingSettings(settings);
