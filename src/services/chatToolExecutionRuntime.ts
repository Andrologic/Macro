import type { FrozenToolCallContext } from "./chatStreamContracts";
import type { ToolCallResolution } from "./streamingChat";
import type { PendingToolApproval } from "../types";
import type { ChatToolExecutionPorts, PendingToolApprovalResolution } from "./chatToolExecutionContracts";
import { requestChatToolApproval } from "./chatToolApproval";
import { executeChatAgentTerminal } from "./chatAgentTerminal";
import { normalizeArchitectToolId } from "./architectToolNames";
import { isToolAllowedForImplementAgent } from "./toolModePolicy";
import { isMCPToolId } from "./mcpToolNames";
import { applyScopedToolRestrictions, loadScopedTurnConfiguration } from "./configurationClient";
import { evaluateToolSecurity } from "./toolSecurityPolicy";
import { sameApprovalExecutionScope } from "./toolApprovalRecovery";
import { validateQuestionToolArgs, buildQuestionnaireHiddenContextBlock, DEFAULT_QUESTIONNAIRE_INTRO } from "./chatQuestionnaires";
import { webSearch, fetchWebPage, formatSearchResultsAsContext } from "./webSearch";
import { handleConfigToolCall } from "./configToolIntegration";

export type { ChatToolExecutionPorts } from "./chatToolExecutionContracts";

const AGENT_TERMINAL_TOOL_IDS = new Set([
  "terminal_create_session",
  "terminal_run",
  "terminal_read",
  "terminal_kill",
]);
const GIT_STAGE_COMMIT_CHALLENGE_TOOL_IDS = new Set(["git_add", "git_commit"]);
const GIT_STAGE_COMMIT_CHALLENGE_MESSAGE =
  "Do not stage or commit unless the user explicitly asked for it in this task. Re-read the latest user instruction. If the user did explicitly ask to stage/commit, call this tool again; otherwise stop and ask for confirmation.";
const TOOL_EXECUTION_ABORTED_RESULT: ToolCallResolution = {
  kind: "result",
  result: "Tool execution aborted",
  isError: true,
  errorKind: "aborted",
  toString: () => "Tool execution aborted",
};

const toolFailure = (
  result: string,
  errorKind: "execution" | "permission" | "validation" = "execution",
): ToolCallResolution => ({
  kind: "result",
  result,
  isError: true,
  errorKind,
  toString: () => result,
});
const IMPLEMENT_PLAN_TOOL_DENIAL_MESSAGE =
  "Plan mode is read-only. This assistant turn cannot edit files, update todos, run terminal commands, stage, commit, checkout, merge, reset, or stash. Inspect the repo and produce a concrete implementation plan instead.";

const shouldChallengeGitStageCommitToolCall = (
  challenges: Set<string>,
  conversationId: string,
  assistantTurnId: string | null,
  assistantMessageId: string,
  toolName: string,
): boolean => {
  if (!GIT_STAGE_COMMIT_CHALLENGE_TOOL_IDS.has(toolName)) {
    return false;
  }

  const turnKey = assistantTurnId || assistantMessageId;
  const challengeKey = `${conversationId}::${turnKey}::${toolName}`;
  if (challenges.has(challengeKey)) {
    return false;
  }

  challenges.add(challengeKey);
  return true;
};


export function createChatToolExecution(ports: ChatToolExecutionPorts) {
  return async (
    operation: FrozenToolCallContext,
    toolName: string,
    args: Record<string, unknown>,
    toolCallId?: string,
    acceptsAttempt: () => boolean = () => true,
  ): Promise<ToolCallResolution | string | void> => {
    const {
      conversationId,
      assistantMessageId,
      mode: modeAtSend,
      agentType: agentTypeAtSend,
      taskId: taskIdAtSend,
      signal,
    } = operation;
    const isCurrentOperation = () => {
      const runtime = ports.runtime.read(conversationId);
      return !signal.aborted && acceptsAttempt() &&
        runtime.sessionId === operation.sessionId &&
        runtime.turnId === operation.turnId &&
        runtime.assistantMessageId === assistantMessageId &&
        runtime.phase === "streaming";
    };
    if (!isCurrentOperation()) {
      return TOOL_EXECUTION_ABORTED_RESULT;
    }
    const normalizedToolName = normalizeArchitectToolId(toolName);
    const assistantTurnId = operation.turnId;

    if (!operation.allowedToolIds.includes(normalizedToolName)) {
      return toolFailure(
        `Tool ${normalizedToolName} is not available for this turn.`,
        "permission",
      );
    }

    if (
      applyScopedToolRestrictions(
        [normalizedToolName],
        operation.scopedTurnConfiguration,
      ).length === 0
    ) {
      return toolFailure(
        `Tool ${normalizedToolName} is disabled for this turn's project scope.`,
        "permission",
      );
    }

    if (
      modeAtSend === "Implement" &&
      agentTypeAtSend === "plan" &&
      !isToolAllowedForImplementAgent("plan", normalizedToolName)
    ) {
      if (toolCallId) {
        ports.runtime.updateTrace(
          assistantMessageId,
          toolCallId,
          "denied",
        );
      }
      return toolFailure(IMPLEMENT_PLAN_TOOL_DENIAL_MESSAGE, "permission");
    }

    if (
      !isMCPToolId(normalizedToolName) &&
      !(await ports.policy.isSourceToolEnabled(
        normalizedToolName,
        modeAtSend,
        agentTypeAtSend,
      ))
    ) {
      if (!isCurrentOperation()) {
        return TOOL_EXECUTION_ABORTED_RESULT;
      }
      return toolFailure(
        `Tool ${normalizedToolName} is disabled for the current mode.`,
        "permission",
      );
    }

    let executionContext = operation.executionContext;
    let executionMcpServers = operation.mcpServers;
    let executionMcpProjectIds = operation.scopedTurnConfiguration?.projectIds ?? executionContext.projectIds;
    const riskLevel = operation.riskLevel;
    if (!isCurrentOperation()) {
      return TOOL_EXECUTION_ABORTED_RESULT;
    }
    let approvalScope: string | null = null;
    if (
      normalizedToolName === "write" ||
      normalizedToolName === "edit" ||
      normalizedToolName === "delete" ||
      normalizedToolName === "apply_patch" ||
      normalizedToolName === "git_add" ||
      normalizedToolName === "git_commit" ||
      normalizedToolName === "git_checkout" ||
      normalizedToolName === "git_merge" ||
      normalizedToolName === "git_reset" ||
      normalizedToolName === "git_stash"
    ) {
      const workspaceToolExecutor = await ports.workspace.executor();
      if (!isCurrentOperation()) return TOOL_EXECUTION_ABORTED_RESULT;
      approvalScope = workspaceToolExecutor.resolveMutatingToolApprovalScope(
        normalizedToolName,
        args,
        {
          workspacePath: executionContext.workspacePath,
          defaultWorkspacePath: executionContext.defaultWorkspacePath,
          projectId: executionContext.projectId,
          focusedProjectId: executionContext.focusedProjectId,
          groupId: executionContext.groupId,
          projectMounts: executionContext.projectMounts,
          virtualRootEnabled: executionContext.virtualRootEnabled,
          workspacePathsByProjectId: executionContext.workspacePathsByProjectId,
        },
      );
    }
    const securityEvaluation = evaluateToolSecurity(normalizedToolName, args, {
      mode: modeAtSend,
      riskLevel,
      workspacePath: executionContext.workspacePath,
      defaultWorkspacePath: executionContext.defaultWorkspacePath,
      projectMounts: executionContext.projectMounts,
      approvalScope,
      grants:
        ports.approvals.grants(conversationId),
    });

    if (securityEvaluation.decision === "deny") {
      if (toolCallId) {
        ports.runtime.updateTrace(
          assistantMessageId,
          toolCallId,
          "denied",
        );
      }
      return toolFailure(
        securityEvaluation.denialReason ?? `Tool ${normalizedToolName} was denied by policy.`,
        "permission",
      );
    }

    if (
      shouldChallengeGitStageCommitToolCall(ports.approvals.challenges,
        conversationId,
        assistantTurnId,
        assistantMessageId,
        normalizedToolName,
      )
    ) {
      if (toolCallId) {
        ports.runtime.updateTrace(
          assistantMessageId,
          toolCallId,
          "denied",
        );
      }
      return toolFailure(GIT_STAGE_COMMIT_CHALLENGE_MESSAGE, "permission");
    }

    if (securityEvaluation.decision === "ask") {
      const approvalEpoch = ports.approvals.epoch;
      const resolvedToolCallId =
        toolCallId ??
        `${normalizedToolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const mcpApprovalTool = executionMcpServers.flatMap((server) => server.tools ?? [])
        .find((tool) => tool.id === normalizedToolName);
      const pendingApproval: PendingToolApproval = {
        ...(mcpApprovalTool ? { mcpIdentity: { serverId: mcpApprovalTool.serverId, toolName: mcpApprovalTool.name } } : {}),
        conversationId,
        assistantMessageId,
        toolCallId: resolvedToolCallId,
        toolId: normalizedToolName,
        actionGroup: securityEvaluation.normalizedCall.actionGroup,
        riskLevel,
        isDestructive: securityEvaluation.normalizedCall.isDestructive,
        summary: securityEvaluation.normalizedCall.summary,
        detail: securityEvaluation.normalizedCall.detail,
        args,
        rememberKey: securityEvaluation.normalizedCall.rememberKey,
        canApproveForConversation:
          securityEvaluation.normalizedCall.canApproveForConversation,
      };

      const resolution = await requestChatToolApproval({
        ports, pendingApproval, approvalEpoch, isCurrentOperation,
        revalidate: async (result) => {
          const currentExecutionContext = ports.policy.executionContext(conversationId);
          const currentConfiguration = await loadScopedTurnConfiguration({
            projectIds: currentExecutionContext.projectIds,
            focusProjectId: currentExecutionContext.focusedProjectId,
            mode: modeAtSend,
          });
          if (operation.scopedTurnConfiguration && !currentConfiguration) {
            throw new Error("The current project tool policy could not be verified.");
          }
          const currentRiskLevel = currentConfiguration?.riskLevel ?? await ports.policy.loadRiskLevel();
          let currentToolEnabled = applyScopedToolRestrictions([normalizedToolName], currentConfiguration).length > 0;
          if (isMCPToolId(normalizedToolName)) {
            const toolsState = ports.policy.mcpRuntime();
            const currentMcpRuntime = currentConfiguration
              ? await ports.policy.resolveMcpRuntime(currentConfiguration.mcpServers, toolsState.servers, { projectIds: currentConfiguration.projectIds })
              : { servers: toolsState.servers, tools: toolsState.tools };
            currentToolEnabled = currentToolEnabled && currentMcpRuntime.tools.some((tool) =>
              tool.id === normalizedToolName && tool.name === mcpApprovalTool?.name && tool.serverId === mcpApprovalTool?.serverId);
            executionMcpServers = currentMcpRuntime.servers;
            executionMcpProjectIds = currentConfiguration?.projectIds ?? currentExecutionContext.projectIds;
          } else {
            currentToolEnabled = currentToolEnabled && await ports.policy.isSourceToolEnabled(normalizedToolName, modeAtSend, agentTypeAtSend);
          }
          if (!isCurrentOperation()) return { kind: "deny" } as PendingToolApprovalResolution;
          if (currentRiskLevel !== riskLevel || !currentToolEnabled ||
            !sameApprovalExecutionScope(currentExecutionContext, executionContext)) {
            return { kind: "deny", reason: "The tool policy or workspace changed while approval was pending. Inspect the current context and request approval again." } as PendingToolApprovalResolution;
          }

          return result;
        },
      });

      if (resolution.kind === "expired") return TOOL_EXECUTION_ABORTED_RESULT;
      if (resolution.kind === "deny") {
        if (toolCallId) {
          ports.runtime.updateTrace(
            assistantMessageId,
            resolvedToolCallId,
            "denied",
          );
        }
        const denialPrefix = `Tool ${normalizedToolName} was denied by the user.`;
        return toolFailure(
          resolution.reason?.trim()
            ? `${denialPrefix} User reason: ${resolution.reason.trim()}`
            : denialPrefix,
          "permission",
        );
      }

      if (!isCurrentOperation()) {
        if (toolCallId) {
          ports.runtime.updateTrace(
            assistantMessageId,
            resolvedToolCallId,
            "denied",
          );
        }
        return TOOL_EXECUTION_ABORTED_RESULT;
      }


      if (
        resolution.kind === "allow_conversation" &&
        pendingApproval.canApproveForConversation !== false
      ) {
        const currentGrants = ports.approvals.grants(conversationId);
        if (!currentGrants.some((grant) =>
          grant.toolId === pendingApproval.toolId && grant.rememberKey === pendingApproval.rememberKey)) {
          ports.approvals.writeGrants(conversationId, [...currentGrants, {
            toolId: pendingApproval.toolId,
            rememberKey: pendingApproval.rememberKey,
            createdAt: new Date().toISOString(),
          }]);
        }
      }

      if (toolCallId) {
        ports.runtime.updateTrace(
          assistantMessageId,
          resolvedToolCallId,
          "running",
        );
      }
    }

    if (normalizedToolName === "question") {
      const questionnaire = validateQuestionToolArgs(args);
      return {
        kind: "interrupt",
        result: `Questionnaire queued for the user with ${questionnaire.questions.length} question(s).`,
        visibleContent: questionnaire.intro || DEFAULT_QUESTIONNAIRE_INTRO,
        hiddenContext: buildQuestionnaireHiddenContextBlock(questionnaire),
      };
    }

    if (normalizedToolName === "web_search") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return "Missing query for web_search.";
      const { enableWebSearch, webSearchOptions } = ports.policy.webConfig();
      if (
        !enableWebSearch ||
        (!webSearchOptions?.configured &&
          !webSearchOptions?.tavilyApiKey &&
          !webSearchOptions?.braveApiKey)
      ) {
        return "Web search is not configured for this provider.";
      }
      const results = await webSearch(query, { ...webSearchOptions, signal });
      if (!isCurrentOperation()) {
        return TOOL_EXECUTION_ABORTED_RESULT;
      }
      if (results.length > 0) {
        ports.sources.addWebCitations(results, assistantMessageId, conversationId);
      }
      return formatSearchResultsAsContext(results);
    }

    if (normalizedToolName === "web_fetch") {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) return "Missing URL for web_fetch.";
      const { enableWebFetch } = ports.policy.webConfig();
      if (!enableWebFetch) {
        return "Web fetch is disabled for this provider.";
      }
      const fetched = await fetchWebPage(url, signal);
      if (!isCurrentOperation()) {
        return TOOL_EXECUTION_ABORTED_RESULT;
      }
      ports.sources.addCitation({
        type: "web",
        scope: "context",
        source: fetched.url,
        title: fetched.title,
        snippet: fetched.snippet,
        content: fetched.content,
        url: fetched.url,
        favicon: fetched.favicon,
        messageId: assistantMessageId,
        conversationId,
      });
      return `TITLE: ${fetched.title}\nURL: ${fetched.url}\n\n${fetched.content}`;
    }

    if (normalizedToolName === "read_file") {
      return ports.sources.readFile(conversationId, args);
    }

    const configToolResult = await handleConfigToolCall(normalizedToolName, args);
    if (!isCurrentOperation()) return TOOL_EXECUTION_ABORTED_RESULT;
    if (configToolResult !== undefined) {
      return configToolResult;
    }

    const configVirtualScopeResult = await ports.handlers.configVirtualScope(
      normalizedToolName,
      args,
    );
    if (!isCurrentOperation()) return TOOL_EXECUTION_ABORTED_RESULT;
    if (configVirtualScopeResult !== undefined) {
      return configVirtualScopeResult;
    }

    const skillToolResult = await ports.handlers.skill(
      normalizedToolName,
      args,
      conversationId,
      undefined,
      executionContext,
    );
    if (!isCurrentOperation()) return TOOL_EXECUTION_ABORTED_RESULT;
    if (skillToolResult !== undefined) {
      return skillToolResult;
    }

    if (isMCPToolId(normalizedToolName)) {
      const result = await ports.handlers.mcp(
        normalizedToolName,
        args,
        executionMcpServers,
        {
          projectIds: executionMcpProjectIds,
          signal,
        },
      );
      return isCurrentOperation() ? result : TOOL_EXECUTION_ABORTED_RESULT;
    }

    if (normalizedToolName === "mark_source_passage") {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const passage = typeof args.passage === "string" ? args.passage.trim() : "";
      if (!title || !passage) {
        return "Missing title or passage for mark_source_passage.";
      }
      if (!(await ports.sources.containsPassage(conversationId, passage))) {
        return "Error executing tool mark_source_passage: passage is not present in any read source content.";
      }
      if (!isCurrentOperation()) {
        return TOOL_EXECUTION_ABORTED_RESULT;
      }
      const kind = (args.kind === "interesting" || args.kind === "used" ? args.kind : undefined) || "used";
      const citationId = ports.sources.addSourcePassage({
        conversationId,
        messageId: assistantMessageId,
        title,
        passage,
        source: typeof args.source === "string" ? args.source : undefined,
        url: typeof args.url === "string" ? args.url : undefined,
        kind,
        reason: typeof args.reason === "string" ? args.reason : undefined,
      });
      return `Source passage marked successfully (citation_id=${citationId}, kind=${kind}).`;
    }

    if (normalizedToolName === "read_sources") {
      return await ports.sources.readSources(conversationId, args);
    }

    if (normalizedToolName === "edit_source_passage") {
      return ports.sources.editSource(conversationId, args);
    }

    const taskTodoToolResult = await ports.handlers.taskTodo(
      conversationId,
      normalizedToolName,
      args,
    );
    if (!isCurrentOperation()) return TOOL_EXECUTION_ABORTED_RESULT;
    if (taskTodoToolResult !== undefined) {
      return taskTodoToolResult;
    }

    const taskArtifactToolResult = await ports.handlers.taskArtifact(
      conversationId,
      normalizedToolName,
      args,
    );
    if (!isCurrentOperation()) return TOOL_EXECUTION_ABORTED_RESULT;
    if (taskArtifactToolResult !== undefined) {
      return taskArtifactToolResult;
    }

    const architectToolResult = await ports.handlers.architect({
      assistantMessageId,
      toolName: normalizedToolName,
      args,
      turnContext: {
        planId: operation.architectPlanAtSend?.planId ?? null,
        targetBranch: operation.architectPlanAtSend?.targetBranch ?? executionContext.branchName,
        projectId: executionContext.focusedProjectId ?? executionContext.projectId,
        groupId: executionContext.groupId,
        isCurrent: isCurrentOperation,
      },
    }).catch((error) => {
      if (!isCurrentOperation()) return undefined;
      if (!ports.policy.isPlanReplicaDivergence(error)) {
        throw error;
      }

      return [
        `Plan metadata replica issue for plan ${error.divergence.planId}: ${error.message}`,
        '',
        'Structured context:',
        JSON.stringify(
          {
            error: 'architect_plan_replica_divergence',
            plan_id: error.divergence.planId,
            branch_name: error.divergence.branchName,
            reason: error.divergence.reason,
            repair_action: 'repair_metadata',
            replicas: error.divergence.replicas,
          },
          null,
          2
        ),
      ].join('\n');
    });

    if (!isCurrentOperation()) return TOOL_EXECUTION_ABORTED_RESULT;
    if (architectToolResult !== undefined) {
      return architectToolResult;
    }

    if (AGENT_TERMINAL_TOOL_IDS.has(normalizedToolName)) {
      return executeChatAgentTerminal(ports.terminal, normalizedToolName, args, signal, isCurrentOperation);
    }

    if (
      normalizedToolName === "list" ||
      normalizedToolName === "read" ||
      normalizedToolName === "write" ||
      normalizedToolName === "edit" ||
      normalizedToolName === "delete" ||
      normalizedToolName === "apply_patch" ||
      normalizedToolName === "glob" ||
      normalizedToolName === "grep" ||
      normalizedToolName === "ast_grep" ||
      normalizedToolName.startsWith("git_")
    ) {
      const workspaceToolExecutor = await ports.workspace.executor();
      if (!isCurrentOperation()) return TOOL_EXECUTION_ABORTED_RESULT;
      const mode = modeAtSend;
      let promotedProjectIdsForTool: string[] = [];

      if (mode === "Implement") {
        const promotionRequest = ports.workspace.resolvePromotion({
          conversationId,
          executionContext,
          selectedTaskId: taskIdAtSend,
          toolName: normalizedToolName,
          args,
          resolveExplicitMutatingToolProjectTargets:
            workspaceToolExecutor.resolveExplicitMutatingToolProjectTargets,
        });

        if (promotionRequest.unavailableResult) {
          return promotionRequest.unavailableResult;
        }

        if (promotionRequest.task && promotionRequest.projectIds.length > 0) {
          const promotion = await ports.workspace.promote(promotionRequest.task.id, promotionRequest.projectIds, {
            triggerTool: normalizedToolName,
          });
          promotedProjectIdsForTool = promotion?.promotedProjectIds || [];
          // The promotion result is the only permitted scope change during an
          // operation. Derive it from the frozen snapshot, never from the
          // current project selection.
          executionContext = {
            ...operation.executionContext,
            actionableProjectIds: Array.from(
              new Set([
                ...operation.executionContext.actionableProjectIds,
                ...promotedProjectIdsForTool,
              ]),
            ),
            contextProjectIds: operation.executionContext.contextProjectIds.filter(
              (projectId) => !promotedProjectIdsForTool.includes(projectId),
            ),
            projectMounts: operation.executionContext.projectMounts.map(
              (mount) =>
                promotedProjectIdsForTool.includes(mount.projectId)
                  ? { ...mount, isReadOnly: false }
                  : mount,
            ),
          };
          if (!isCurrentOperation()) {
            return TOOL_EXECUTION_ABORTED_RESULT;
          }
        }
      }

      const withPromotionNotice = (result: string): string => {
        if (promotedProjectIdsForTool.length === 0) {
          return result;
        }
        return `[macro_scope_promotion] ${JSON.stringify({
          promoted_project_ids: promotedProjectIdsForTool,
          retried_tool: normalizedToolName,
        })}\n${result}`;
      };

      const result = await workspaceToolExecutor.executeWorkspaceTool(
        normalizedToolName,
        args,
        mode,
        {
          signal,
          workspacePath: executionContext.workspacePath,
          defaultWorkspacePath: executionContext.defaultWorkspacePath,
          projectId: executionContext.projectId,
          focusedProjectId: executionContext.focusedProjectId,
          groupId: executionContext.groupId,
          projectMounts: executionContext.projectMounts,
          virtualRootEnabled: executionContext.virtualRootEnabled,
          workspacePathsByProjectId: executionContext.workspacePathsByProjectId,
          invocationId: toolCallId
            ? `${conversationId}:${assistantTurnId}:${toolCallId}`
            : undefined,
          onCodeCheckpoint: async (checkpoint) => {
            await ports.workspace.recordCheckpoint({
              conversationId,
              turnId: assistantTurnId,
              assistantMessageId,
              toolCallId,
              toolName: checkpoint.toolName,
              files: checkpoint.files,
            });
          },
        },
      );
      if (!isCurrentOperation()) {
        return TOOL_EXECUTION_ABORTED_RESULT;
      }
      return result === undefined ? result : withPromotionNotice(result);
    }
  };

}
