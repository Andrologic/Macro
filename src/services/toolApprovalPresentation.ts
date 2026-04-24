import type {
  PendingToolApproval,
  ToolApprovalCategory,
  ToolRiskLevel,
} from "../types";

type Translate = (key: string, defaultValue: string) => string;

export type ToolApprovalCategoryTone =
  | "neutral"
  | "info"
  | "warning"
  | "danger";

export type ToolRiskIconName = "lock" | "shield" | "zap";

export interface ToolRiskPresentation {
  riskIcon: ToolRiskIconName;
  riskIconLabel: string;
  riskIconContainerClassName: string;
  riskIconClassName: string;
}

export interface ToolApprovalPresentation extends ToolRiskPresentation {
  category: ToolApprovalCategory;
  categoryLabel: string;
  categoryTone: ToolApprovalCategoryTone;
}

const WEB_TOOL_IDS = new Set(["web_search", "web_fetch"]);
const SYSTEM_TOOL_IDS = new Set([
  "terminal_create_session",
  "terminal_run",
  "terminal_read",
  "terminal_kill",
  "git_checkout",
  "git_merge",
  "git_reset",
  "git_stash",
]);
const DELETE_TOOL_IDS = new Set([
  "delete",
  "need_delete",
  "strategy_delete",
  "plan_delete",
]);
const CONDITIONAL_DELETE_TOOL_IDS = new Set([
  "apply_patch",
  "edit_source_passage",
]);

const getApprovalCategory = (
  pendingApproval: Pick<PendingToolApproval, "toolId" | "isDestructive">,
): ToolApprovalCategory => {
  if (
    DELETE_TOOL_IDS.has(pendingApproval.toolId) ||
    (pendingApproval.isDestructive === true &&
      CONDITIONAL_DELETE_TOOL_IDS.has(pendingApproval.toolId))
  ) {
    return "delete";
  }

  if (WEB_TOOL_IDS.has(pendingApproval.toolId)) {
    return "web";
  }

  if (SYSTEM_TOOL_IDS.has(pendingApproval.toolId)) {
    return "system";
  }

  return "modify";
};

export const getToolRiskLevelPresentation = (
  riskLevel: ToolRiskLevel,
  t: Translate,
): ToolRiskPresentation => {
  if (riskLevel === "strict") {
    return {
      riskIcon: "lock",
      riskIconLabel: t("tools.security.strictIconLabel", "Strict security"),
      riskIconContainerClassName:
        "bg-destructive/10 ring-1 ring-destructive/20",
      riskIconClassName: "text-destructive",
    };
  }

  if (riskLevel === "yolo") {
    return {
      riskIcon: "zap",
      riskIconLabel: t("tools.security.yoloIconLabel", "YOLO security"),
      riskIconContainerClassName: "bg-red-500/10 ring-1 ring-red-500/20",
      riskIconClassName: "text-red-600 dark:text-red-300",
    };
  }

  return {
    riskIcon: "shield",
    riskIconLabel: t("tools.security.balancedIconLabel", "Balanced security"),
    riskIconContainerClassName: "bg-amber-500/10 ring-1 ring-amber-500/20",
    riskIconClassName: "text-amber-600 dark:text-amber-300",
  };
};

export const getToolApprovalPresentation = (
  pendingApproval: Pick<
    PendingToolApproval,
    "toolId" | "riskLevel" | "isDestructive"
  >,
  t: Translate,
): ToolApprovalPresentation => {
  const category = getApprovalCategory(pendingApproval);
  const riskPresentation = getToolRiskLevelPresentation(
    pendingApproval.riskLevel,
    t,
  );

  switch (category) {
    case "delete":
      return {
        ...riskPresentation,
        category,
        categoryLabel: t("chat.toolApprovalCategoryDelete", "Delete"),
        categoryTone: "danger",
      };
    case "web":
      return {
        ...riskPresentation,
        category,
        categoryLabel: t("chat.toolApprovalCategoryWeb", "Web"),
        categoryTone: "info",
      };
    case "system":
      return {
        ...riskPresentation,
        category,
        categoryLabel: t("chat.toolApprovalCategorySystem", "System"),
        categoryTone: "neutral",
      };
    default:
      return {
        ...riskPresentation,
        category,
        categoryLabel: t("chat.toolApprovalCategoryModify", "Modify"),
        categoryTone: "warning",
      };
  }
};
