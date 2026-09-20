import type { ChatToolExecutionPorts, PendingToolApprovalResolution } from "./chatToolExecutionContracts";
import type { PendingToolApproval } from "../types";
import { persistToolApprovalRecovery } from "./toolApprovalRecovery";

/** Keep the recovery action until both the closed trace and its marker are durable. */
export async function requestChatToolApproval({
  ports, pendingApproval, approvalEpoch, isCurrentOperation, revalidate,
}: {
  ports: Pick<ChatToolExecutionPorts, "runtime" | "approvals">;
  pendingApproval: PendingToolApproval;
  approvalEpoch: number;
  isCurrentOperation(): boolean;
  revalidate(result: PendingToolApprovalResolution): Promise<PendingToolApprovalResolution>;
}): Promise<PendingToolApprovalResolution> {
  const { conversationId, assistantMessageId } = pendingApproval;
  return ports.approvals.serialize(
    conversationId,
    async () => {
      if (!isCurrentOperation()) {
        return Promise.resolve<PendingToolApprovalResolution>({ kind: "expired" });
      }
      if (ports.approvals.pending(conversationId)?.recoveryState === "interrupted") {
        return { kind: "deny", reason: "Resolve the interrupted tool request before continuing." } as PendingToolApprovalResolution;
      }
      // Persist the transcript first. The recovery marker contains identifiers only.
      ports.runtime.updateTrace(assistantMessageId, pendingApproval.toolCallId, "pending_approval", { tool_name: pendingApproval.toolId, detail: pendingApproval.detail });
      const assistantMessage = ports.runtime.messages(conversationId).find((message) => message.id === assistantMessageId);
      try {
        if (assistantMessage) await ports.runtime.persistPartial(assistantMessage);
        await persistToolApprovalRecovery(conversationId, pendingApproval);
      } catch (error) {
        if (approvalEpoch !== ports.approvals.epoch) return { kind: "expired" } as PendingToolApprovalResolution;
        ports.runtime.updateTrace(assistantMessageId, pendingApproval.toolCallId, "denied");
        const closedMessage = ports.runtime.messages(conversationId).find((message) => message.id === assistantMessageId);
        try {
          if (closedMessage) await ports.runtime.persistPartial(closedMessage);
        } catch {
          // Persistence is unavailable; retain an explicit recovery action in this session.
          ports.approvals.publish(conversationId, { ...pendingApproval, recoveryState: "interrupted", canApproveForConversation: false });
        }
        throw error;
      }
      if (approvalEpoch !== ports.approvals.epoch) return { kind: "expired" } as PendingToolApprovalResolution;
      if (!isCurrentOperation()) {
        await persistToolApprovalRecovery(conversationId, null);
        return { kind: "deny" } as PendingToolApprovalResolution;
      }
      ports.approvals.mutationVersions.set(conversationId, (ports.approvals.mutationVersions.get(conversationId) ?? 0) + 1);
      let revoked: PendingToolApprovalResolution | null = null;
      return new Promise<PendingToolApprovalResolution>((resolve) => {
        ports.approvals.resolvers.set(
          `${conversationId}::${pendingApproval.toolCallId}`,
          (decision) => {
            // A refusal offered while persistence is pending remains effective.
            if (decision.kind === "deny" || decision.kind === "expired") revoked = decision;
            resolve(decision);
          },
        );
        ports.approvals.publish(conversationId, pendingApproval);
      }).then(async (result) => {
        try {
          if (result.kind === "expired" || approvalEpoch !== ports.approvals.epoch) return { kind: "expired" } as PendingToolApprovalResolution;
          if (result.kind !== "deny" && isCurrentOperation()) {
            result = await revalidate(result);
          }
          if (approvalEpoch !== ports.approvals.epoch) return { kind: "expired" } as PendingToolApprovalResolution;
          // Close the durable trace before dropping its only recovery action.
          ports.runtime.updateTrace(assistantMessageId, pendingApproval.toolCallId, "denied");
          const closedMessage = ports.runtime.messages(conversationId).find((message) => message.id === assistantMessageId);
          if (closedMessage) await ports.runtime.persistPartial(closedMessage);
          if (approvalEpoch !== ports.approvals.epoch) return { kind: "expired" } as PendingToolApprovalResolution;
          await persistToolApprovalRecovery(conversationId, null);
          ports.approvals.publish(conversationId, null, pendingApproval);
          return revoked ?? result;
        } catch (error) {
          if (approvalEpoch !== ports.approvals.epoch) return { kind: "expired" } as PendingToolApprovalResolution;
          ports.approvals.publish(conversationId, { ...pendingApproval, recoveryState: "interrupted", canApproveForConversation: false }, pendingApproval);
          throw error;
        } finally {
          if (approvalEpoch === ports.approvals.epoch) ports.approvals.resolvers.delete(`${conversationId}::${pendingApproval.toolCallId}`);
        }
      });
    },
  );
}
