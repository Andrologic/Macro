import type { InternalAgentProfile } from "../internalAgentProfile";
import type { AgentDefinition } from "./types";

const AUDITOR_CAPABILITIES = ["workspace.read", "git.read"] as const;

const AUDITOR_DEFINITIONS: Partial<Record<InternalAgentProfile, AgentDefinition>> = {
  repo_auditor: {
    id: "repo_auditor",
    role: "Repository auditor",
    description: "Inspects repository state and reports evidence without changing it.",
    capabilities: [...AUDITOR_CAPABILITIES],
    limitations: ["Read-only", "No terminal commands", "No recursive delegation"],
    limits: {
      maxChildDepth: 1,
      maxConcurrencyPerParent: 1,
      maxContextBytes: 64 * 1024,
    },
  },
  goal_auditor: {
    id: "goal_auditor",
    role: "Goal auditor",
    description: "Audits goal progress from repository evidence without changing it.",
    capabilities: [...AUDITOR_CAPABILITIES],
    limitations: ["Read-only", "No terminal commands", "No recursive delegation"],
    limits: {
      maxChildDepth: 1,
      maxConcurrencyPerParent: 1,
      maxContextBytes: 64 * 1024,
    },
  },
};

export const getDelegatableInternalAgentDefinition = (
  profile: InternalAgentProfile
): AgentDefinition | null => {
  const definition = AUDITOR_DEFINITIONS[profile];
  if (!definition) return null;
  return {
    ...definition,
    capabilities: [...definition.capabilities],
    limitations: [...definition.limitations],
    limits: { ...definition.limits },
  };
};
