import type { PlanNode } from '../../types';
import type { ProjectExecutionContext } from '../../services/projectExecutionContext';
import { getPlanExecutionModesByProjectId } from '../../services/planExecutionModes';
import { buildArchitectPlanToolFollowUpInstruction } from '../../services/architectChat';
import { getArchitectPlanTargetDisplay, type ArchitectPlanRecord } from '../../services/architectPlanService';

type PlanPromptContext = Pick<ArchitectPlanRecord,
  'id' | 'planKind' | 'title' | 'label' | 'description' |
  'targetBranch' | 'targetBranchesByProjectId' | 'executionModesByProjectId' | 'projectId' | 'projectIds'> & { status: string; slug?: string };

export function buildArchitectPlanPrompt(
  activePlanContext: PlanPromptContext,
  options: Parameters<typeof getArchitectPlanTargetDisplay>[2],
): string {
  const planKind = activePlanContext.planKind || "feature";
  const targetDisplay = getArchitectPlanTargetDisplay(activePlanContext, null, options);
  const typedPlanInstruction =
    planKind === "release"
      ? "This is a Release plan. First inspect likely version files and relevant repositories. If important version or repository scope information remains missing, use the question tool for focused clarification; do not force confirmation when the conversation and inspected code already establish it. Do not create tags or GitHub releases."
      : planKind === "hotfix"
        ? "This is a Hotfix plan. Ask the user to describe the production bug if they have not already done so. Then inspect from the main-branch mindset, infer affected repositories, and propose a concise hotfix slug and patch versions per repository. Use the question tool only when important scope, version, or slug information remains missing; do not impose a confirmation step before strategy generation."
        : planKind === "bugfix"
          ? "This is a Bugfix plan. Ask the user to describe the bug if they have not already done so. Then inspect from the development-branch mindset, infer affected repositories, and propose a concise bugfix slug. Use the question tool only when important scope or slug information remains missing; do not impose a confirmation step before strategy generation."
          : "This is a Feature plan. Keep the existing lightweight planning flow; do not force an initial questionnaire unless a clarification is blocking.";
  return (
    `[Active Plan] id="${activePlanContext.id}", kind="${planKind}", slug="${activePlanContext.slug || activePlanContext.id}", title="${activePlanContext.title}", label="${activePlanContext.label || "none"}", description="${activePlanContext.description || "none"}", status="${activePlanContext.status}", storageTargetBranch="${activePlanContext.targetBranch}", effectiveTargetBranch="${targetDisplay.effectiveTargetBranch || targetDisplay.targetBranch}", targetBranchesByProjectId=${JSON.stringify(targetDisplay.targetBranchesByProjectId)}. ${typedPlanInstruction} Use plan_update.label (or title as legacy alias) for the optional display label. For Release/Hotfix/Bugfix, plan_update may also update project_ids, context_project_ids, and git_flow metadata while the plan is still a draft. Only update plan slug through \`plan_update.slug\` or \`strategy_generate.plan_slug\` while the plan is still a mutable draft.`
  );
}

export function buildArchitectPlanInstructions(
  activePlanContext: PlanPromptContext | null | undefined,
  nodes: PlanNode[],
  executionContext: ProjectExecutionContext,
  options: Parameters<typeof getArchitectPlanTargetDisplay>[2],
): string[] {
  const systemInstructions: string[] = [];
  systemInstructions.push(buildArchitectPlanToolFollowUpInstruction());
  systemInstructions.push(
    "In Architect mode, discuss the plan directly with the user. Inspect the selected project code when it provides useful context, and use the `question` tool for focused clarifications when important information is missing. Generate or regenerate strategy only after an explicit user request, using the plan conversation, expressed intent, plan scope, selected projects, inspected code context, and clarification answers.",
  );
  systemInstructions.push(
    "In Architect mode, do not call `strategy_generate` automatically. Only call it after an explicit user request to generate/regenerate strategy (for example via the Generate Strategy button or a direct instruction in chat).",
  );
  systemInstructions.push(
    "In Architect mode, the plan lifecycle remains UI-only for this iteration. Never call `plan_create`, `plan_delete`, `plan_restore`, or `plan_set_active`; ask the user to use the plan selector instead.",
  );
  systemInstructions.push(
    "In Architect mode, `plan_update` may change the optional label/title alias, description, mutable draft slug, and draft-only scope metadata. Never use it to change plan status or activate a plan.",
  );
  systemInstructions.push(
    "In Architect mode, if a strategy tool reports frozen-node conflicts and explicitly requests a repair retry, immediately call the same strategy tool one more time with a corrected full strategy that preserves all frozen nodes verbatim. If the tool stages a preview or blocks the mutation, stop retrying and explain that the user must review the preview.",
  );
  const persistedArchitectExecutionModes = Object.values(
    getPlanExecutionModesByProjectId(
      nodes,
      activePlanContext?.executionModesByProjectId,
    ),
  );
  const architectExecutionModes = persistedArchitectExecutionModes.length > 0
    ? persistedArchitectExecutionModes
    : executionContext.projectMounts
      .filter((mount) => executionContext.projectIds.includes(mount.projectId))
      .flatMap((mount) =>
        mount.executionMode === 'git' || mount.executionMode === 'direct'
          ? [mount.executionMode]
          : []
      );
  const hasDirectArchitectTarget = architectExecutionModes.includes('direct');
  const hasGitArchitectTarget = architectExecutionModes.includes('git');
  if (hasDirectArchitectTarget && hasGitArchitectTarget) {
    systemInstructions.push(
      "This plan mixes Git and direct targets. Propose branch slugs only for Git targets. Direct targets run in their project directory without branches, worktrees, commits, or merges. Preserve each project's execution mode when defining nodes and dependencies.",
    );
  } else if (hasDirectArchitectTarget) {
    systemInstructions.push(
      "This is a direct-only plan. Do not propose branches, worktrees, commits, merges, or other Git operations. Each node runs in its project directory and Macro finalizes the work by accepting its direct checkpoint.",
    );
  } else {
    systemInstructions.push(
      "Git workflow for plans is strict: each plan has an immutable technical id plus a logical `slug` once it is locked. In mainline mode, where the development target and main branch are the same, create feature work only and do not propose release, hotfix, or bugfix branches. Feature plans integrate on rendered `plan/*` branches. The Architect AI should propose `plan_slug` and unique per-node `featureSlug` values, not raw git branch names. Task work branches are rendered later from each project's Git workflow profile and merge into the plan integration branch.",
    );
  }
  systemInstructions.push(
    "Express sequential work with `dependencies`. Include concrete per-node `todos` for the Implement checklist; each todo should be task-local and use `pending`, `in-progress`, or `done`. Do not create a `Finalize plan` node yourself. Macro adds a synthetic finalization task after the terminal strategy nodes and finalizes each target according to its persisted execution mode.",
  );
  if (activePlanContext) systemInstructions.push(buildArchitectPlanPrompt(activePlanContext, options));
  return systemInstructions;
}
