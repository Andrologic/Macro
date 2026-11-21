import type { ArchitectPlanRecord } from '../../services/architectPlanService';

type PlanPromptContext = Pick<ArchitectPlanRecord, 'id' | 'title' | 'label' | 'description' | 'targetBranch'> & { status: string };

export function buildArchitectPlanInstructions(plan: PlanPromptContext | null | undefined): string[] {
  if (!plan) return ['Ask the user to create or select a system in the Architect navigator to start designing it.'];
  return [
    `[Active Plan] id="${plan.id}", title="${plan.label || plan.title}", description="${plan.description}", status="${plan.status}", storageTargetBranch="${plan.targetBranch}".`,
    AGSDL_AUTHORING_INSTRUCTION,
    'Ask focused questions when important details are missing. Use the Architect navigator to create, select, rename, or archive systems.',
  ];
}

const AGSDL_AUTHORING_INSTRUCTION =
  "For AgSDL process design or editing, read agsdl_get with the plan_id and target_branch (storageTargetBranch) from this conversation. Read section: guide for the source contract before structural changes; empty sources default to AgSDL 0.3; it is available even when a scoped source read omits the overview. Follow its authoring guide, edit through agsdl_update using the returned revision, and report scoped diagnostics. The right panel visualizes this document; focused manual edits share the same versioned session. Handle structural changes through the authoring tools. Explain changed missions, data transfers and routes in plain language. Document authoring does not execute agents.";
