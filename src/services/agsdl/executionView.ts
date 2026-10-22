import type { PublicProjection, PublicSnapshot, PublicActivation, SourceRevision } from "../agsdlExecution/contracts";
import type { PublicApproval, PublicExecutionDiagnostic, PublicRunSummary } from "../../types/generated/ipc";
import type { ViewerCard } from "./viewer";
import { pointerPart, readDocument, object } from "./document";
import type { ExactJsonText } from "../agsdlExecution/contracts";
import { sameSource } from "./runtimeSelection";

export function assertProjection(page: PublicProjection, snapshot: PublicSnapshot): void {
  if (page.systemStartId !== snapshot.systemStartId || !sameSource(page.source, snapshot.source) || page.agents.length > 64 || page.activations.length > 64 ||
      page.activations.some(item => item.work.systemStartId !== snapshot.systemStartId) || (page.nextPage && page.nextPage.cursor !== page.cursor)) throw new Error("Invalid public projection page");
}
/** Append only the exact continuation of the captured cursor; never merge current and historical pages. */
export function appendProjection(previous: PublicProjection, page: PublicProjection, snapshot: PublicSnapshot): PublicProjection {
  assertProjection(page, snapshot);
  if (!previous.nextPage || page.cursor !== previous.cursor || (page.nextPage && page.nextPage.offset !== previous.nextPage.offset + 64) ||
      page.agents.some(item => previous.agents.some(old => old.agentInstanceId === item.agentInstanceId)) ||
      page.activations.some(item => previous.activations.some(old => old.work.activationId === item.work.activationId))) throw new Error("Projection page is stale; restart explicitly");
  return { ...page, agents: [...previous.agents, ...page.agents], activations: [...previous.activations, ...page.activations] };
}
export function assertDiagnosticPage(page: PublicExecutionDiagnostic, snapshot: PublicSnapshot, through: string, activationId: string | null = null): void {
  if (page.systemStartId !== snapshot.systemStartId || !sameSource(page.source as SourceRevision, snapshot.source) || page.through !== through ||
      (page.activation?.activationId ?? null) !== activationId || page.diagnostics.length > 64) throw new Error("Invalid public diagnostic page");
}
export type NativeCardState = "queued" | "active" | "uncertain" | "completed" | "failed" | "stopped" | "stopRequested" | "approval";
export interface NativeCardActivation { state: NativeCardState; activations: PublicActivation[]; partial?: boolean }
const priority: NativeCardState[] = ["approval", "uncertain", "failed", "stopRequested", "active", "queued", "stopped", "completed"];
export function nativeActivationState(item: PublicActivation, approvals: readonly PublicApproval[]): NativeCardState {
  if (approvals.some(approval => approval.status === "pending" && approval.work.activationId === item.work.activationId)) return "approval";
  if (item.stopState.kind === "uncertain" || item.workState === "uncertain") return "uncertain";
  if (item.workState === "terminal" && item.terminalKind) return item.terminalKind;
  if (item.stopState.kind === "requested") return "stopRequested";
  return item.workState === "active" ? "active" : "queued";
}
export function nativeCardActivations(cards: readonly ViewerCard[], projection: PublicProjection, approvals: readonly PublicApproval[]): Record<string, NativeCardActivation> {
  const result: Record<string, NativeCardActivation> = {};
  for (const card of cards) {
    const activations = projection.activations.filter(item => item.work.step
      ? card.path === `/flow/steps/${item.work.step.map(pointerPart).join("/steps/")}`
      : projection.agents.some(agent => agent.agentInstanceId === item.work.agentInstanceId && card.path === `/agents/${pointerPart(agent.agentName)}`));
    if (!activations.length) continue;
    const states = activations.map(item => nativeActivationState(item, approvals));
    result[card.path] = { activations, partial: projection.nextPage !== null, state: states.reduce((a, b) => priority.indexOf(a) <= priority.indexOf(b) ? a : b) };
  }
  return result;
}
export function groupNativeState(items: NativeCardActivation[], members: number): NativeCardActivation | undefined {
  if (!items.length) return;
  const state = items.map(item => item.state).reduce((a, b) => priority.indexOf(a) <= priority.indexOf(b) ? a : b);
  if (state === "completed" && items.length < members) return;
  return { state, partial: items.some(item => item.partial), activations: items.flatMap(item => item.activations) };
}

/** Intent comes from public authored declarations; native compilation validates the Message. */
export function executionInput(source: string): { hasEntry: boolean; graphless: boolean; agents: string[] } {
  const document = readDocument(source);
  const flow = object(document.flow);
  return { hasEntry: typeof flow.entry === "string" && flow.entry.length > 0, graphless: document.flow === undefined,
    agents: Object.keys(object(document.agents)) };
}
export function executionPrompt(prompt: string): ExactJsonText {
  if (!prompt.trim() || new TextEncoder().encode(prompt).length > 65536) throw new Error("agsdl.execution.promptRequired");
  return JSON.stringify({ prompt: [{ value: prompt, mediaType: "text/plain" }] }) as ExactJsonText;
}


/** Use native totals, never a partial projection or the number of successful steps. */
export function nativeRunState(run: PublicRunSummary): NativeCardState | undefined {
  if (run.systemStop.kind === 'uncertain' || run.counts.uncertain !== '0') return 'uncertain';
  if (run.systemStop.kind === 'requested') return 'stopRequested';
  if (run.counts.active !== '0') return 'active';
  if (run.counts.queued !== '0') return 'queued';
  if (run.systemStop.kind === 'confirmed') return 'stopped';
  if (run.counts.failed !== '0') return 'failed';
  if (run.counts.stopped !== '0') return 'stopped';
  if (run.counts.completed !== '0') return 'completed';
}
