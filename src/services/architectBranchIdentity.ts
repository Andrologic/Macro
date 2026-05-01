import type { PlanNode, PredictedBranch, ProjectGitFlowSettings } from "../types";
import {
  compileGitFlowTemplateTokenMatch,
  normalizeFeatureSlugInput,
  normalizeGitBranchName,
  renderGitFlowBranchName,
  renderStandaloneFeatureBranchName,
  resolveProjectGitFlowSettings,
  sanitizeBranchSlugInput,
  validateProjectGitFlowParsing as validateProjectGitFlowParsingSettings,
} from "./architectGitNaming";
import {
  getPlanNodeBranchIntent,
  resolveWorkBranchIntent,
  type WorkBranchType,
  type WorkBranchIntent,
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

const normalizePlanTaskKeyInput = (
  value?: string | null,
  fallback = "task",
): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

export const buildPlanTaskFeatureBranchKey = (
  planSlug: string,
  taskId: string,
  featureSlug: string,
): string =>
  `plan::${normalizePlanSlugInput(planSlug)}::task::${normalizePlanTaskKeyInput(taskId)}::feature::${normalizeFeatureSlugInput(featureSlug)}`;

export const buildStandaloneFeatureBranchKey = (featureSlug: string): string =>
  `standalone::${normalizeFeatureSlugInput(featureSlug)}`;

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const shouldPreserveExistingNodeBranchSlug = (
  node: Pick<PlanNode, "status">,
): boolean => node.status !== "pending";

export const resolvePlanNodeTaskBranchIntents = (
  nodes: Array<
    Pick<
      PlanNode,
      "id" | "assignedBranch" | "branchSlug" | "branchType" | "status" | "title"
    >
  >,
): Map<string, WorkBranchIntent> => {
  const entries = nodes.map((node, index) => ({
    node,
    index,
    intent: getPlanNodeBranchIntent(node),
  }));
  const entriesByBaseKey = new Map<string, typeof entries>();
  entries.forEach((entry) => {
    const existing = entriesByBaseKey.get(entry.intent.key) || [];
    existing.push(entry);
    entriesByBaseKey.set(entry.intent.key, existing);
  });

  const result = new Map<string, WorkBranchIntent>();
  const usedKeys = new Set<string>();

  for (const group of entriesByBaseKey.values()) {
    const preservedEntries = group.filter((entry) =>
      shouldPreserveExistingNodeBranchSlug(entry.node),
    );
    const pendingBaseEntry = [...group].sort((left, right) =>
      left.node.id.localeCompare(right.node.id),
    )[0]!;
    const entriesKeepingBaseSlug =
      preservedEntries.length > 0 ? new Set(preservedEntries) : new Set([pendingBaseEntry]);

    for (const entry of group) {
      if (entriesKeepingBaseSlug.has(entry)) {
        result.set(entry.node.id, entry.intent);
        usedKeys.add(entry.intent.key);
        continue;
      }

      const suffix = stableHash(entry.node.id).slice(0, 6);
      let attempt = 1;
      let candidateSlug = sanitizeBranchSlugInput(
        `${entry.intent.branchSlug}-${suffix}`,
        entry.intent.branchType,
      );
      let candidate = resolveWorkBranchIntent({
        branchType: entry.intent.branchType,
        branchSlug: candidateSlug,
        fallbackSlug: entry.node.title,
      });

      while (usedKeys.has(candidate.key)) {
        attempt += 1;
        candidateSlug = sanitizeBranchSlugInput(
          `${entry.intent.branchSlug}-${suffix}-${attempt}`,
          entry.intent.branchType,
        );
        candidate = resolveWorkBranchIntent({
          branchType: entry.intent.branchType,
          branchSlug: candidateSlug,
          fallbackSlug: entry.node.title,
        });
      }

      result.set(entry.node.id, candidate);
      usedKeys.add(candidate.key);
    }
  }

  return result;
};

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
  const branchIntentsByNodeId = resolvePlanNodeTaskBranchIntents(params.nodes);

  params.nodes.forEach((node) => {
    const branchIntent = branchIntentsByNodeId.get(node.id) || getPlanNodeBranchIntent(node);
    normalizeNodeProjectIds(node).forEach((projectId) => {
      const settings = params.getProjectGitFlowSettings?.(projectId);
      const branchKey = buildPlanTaskFeatureBranchKey(
        params.planSlug,
        node.id,
        branchIntent.branchSlug,
      );
      const key = `${projectId}::${branchKey}`;
      const existing = descriptors.get(key);
      if (existing) {
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
  node: Pick<PlanNode, "assignedBranch" | "branchSlug" | "title"> & {
    id?: string | null;
  };
}): ParsedBranchIdentity => {
  const branchIntent = getPlanNodeBranchIntent(params.node);
  const taskId = params.node.id?.trim();
  return {
    kind: "plan_feature",
    key: taskId
      ? buildPlanTaskFeatureBranchKey(
          params.planSlug,
          taskId,
          branchIntent.branchSlug,
        )
      : buildPlanFeatureBranchKey(params.planSlug, branchIntent.branchSlug),
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
  branch: Pick<PredictedBranch, "name" | "branchSlug"> & {
    taskIds?: string[];
  };
  settings?: Partial<ProjectGitFlowSettings> | null;
}): ParsedBranchIdentity => {
  const normalizedPlanSlug = normalizePlanSlugInput(
    params.planSlug,
    PLAN_SLUG_FALLBACK,
  );
  const explicitBranchSlug = params.branch.branchSlug?.trim();
  if (explicitBranchSlug) {
    const taskId =
      Array.isArray(params.branch.taskIds) && params.branch.taskIds.length === 1
        ? params.branch.taskIds[0]?.trim()
        : "";
    return {
      kind: "plan_feature",
      key: taskId
        ? buildPlanTaskFeatureBranchKey(
            normalizedPlanSlug,
            taskId,
            explicitBranchSlug,
          )
        : buildPlanFeatureBranchKey(normalizedPlanSlug, explicitBranchSlug),
      branchName: normalizeGitBranchName(params.branch.name),
      planSlug: normalizedPlanSlug,
      featureSlug: normalizeFeatureSlugInput(explicitBranchSlug),
    };
  }
  const parsed = parseRenderedBranchIdentity(params.branch.name, params.settings);
  const taskId =
    Array.isArray(params.branch.taskIds) && params.branch.taskIds.length === 1
      ? params.branch.taskIds[0]?.trim()
      : "";
  if (parsed.kind === "plan_feature" && taskId) {
    return {
      ...parsed,
      key: buildPlanTaskFeatureBranchKey(
        normalizedPlanSlug,
        taskId,
        parsed.featureSlug,
      ),
      planSlug: normalizedPlanSlug,
    };
  }
  return parsed;
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
