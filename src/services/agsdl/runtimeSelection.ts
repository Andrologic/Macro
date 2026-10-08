import type { AgsdlRuntimeReference, AgsdlSelectionReference } from "../../types";
import type { PublicSnapshot, SourceRevision, EngineVersions } from "../agsdlExecution/contracts";
import type { PublicExecutionDiagnostic, PublicDiagnostic } from "../../types/generated/ipc";
import { sourceAt } from "./document";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown, limit = 2048): value is string => typeof value === "string" && value.length <= limit;
const identity = (value: unknown): value is string => string(value) && value.length > 0;
export const canonicalSequence = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 128;
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
export function isSourceRevision(value: unknown): value is SourceRevision {
  return record(value) && keys(value, ["owner", "revision", "sourceSha256"]) && record(value.owner) &&
    keys(value.owner, ["projectId", "planId", "branch"]) && [value.owner.projectId, value.owner.planId, value.owner.branch].every(identity) &&
    canonicalSequence(value.revision) && typeof value.sourceSha256 === "string" && /^[a-f0-9]{64}$/.test(value.sourceSha256);
}
export function sameSource(left: SourceRevision, right: SourceRevision): boolean {
  return left.owner.projectId === right.owner.projectId && left.owner.planId === right.owner.planId && left.owner.branch === right.owner.branch &&
    left.revision === right.revision && left.sourceSha256 === right.sourceSha256;
}
export function isAgsdlReference(value: unknown): value is AgsdlSelectionReference {
  if (!record(value) || value.document !== "agsdl" || ![value.id, value.conversationId, value.planId, value.branchName].every(identity) ||
      !string(value.path) || !string(value.title, 4096) || (value.relatedPaths !== undefined && (!Array.isArray(value.relatedPaths) || value.relatedPaths.length > 64 || !value.relatedPaths.every(path => string(path))))) return false;
  const common = ["id", "conversationId", "planId", "branchName", "document", "path", "title", "relatedPaths", "contextKind"];
  if (value.contextKind === undefined || value.contextKind === "document") return keys(value, [...common, "version", "persistedRevision", "diagnostic"]) &&
    identity(value.version) && Number.isSafeInteger(value.persistedRevision) && Number(value.persistedRevision) >= 0 && (value.diagnostic === undefined || string(value.diagnostic, 65536));
  if (value.contextKind !== "runtime" || !keys(value, [...common, "systemStartId", "source", "activationId", "cursor", "diagnosticSelection"]) ||
      !identity(value.systemStartId) || !isSourceRevision(value.source) || value.source.owner.planId !== value.planId || value.source.owner.branch !== value.branchName ||
      (value.activationId !== undefined && !identity(value.activationId)) || !canonicalSequence(value.cursor)) return false;
  const cursor = value.cursor;
  const selected = value.diagnosticSelection;
  return selected === undefined || (Array.isArray(selected) && selected.length <= 64 && new Set(selected.map(item => record(item) ? item.id : null)).size === selected.length &&
    selected.every(item => record(item) && keys(item, ["id", "sequence"]) && canonicalSequence(item.sequence) && item.id === `${value.systemStartId}:${item.sequence}` &&
      (item.sequence.length < cursor.length || (item.sequence.length === cursor.length && item.sequence <= cursor))));
}
export interface RuntimeSelectionCapture {
  reference: AgsdlRuntimeReference;
  fragments: { path: string; sourceText: string }[];
  versions: EngineVersions;
  diagnostics: Pick<PublicDiagnostic, "id" | "sequence" | "code" | "pointer" | "message">[];
}
export function sameRuntimeReference(left: AgsdlRuntimeReference, right: AgsdlRuntimeReference): boolean {
  return left.id === right.id && left.conversationId === right.conversationId && left.planId === right.planId && left.branchName === right.branchName &&
    left.document === right.document && left.path === right.path && left.title === right.title && left.systemStartId === right.systemStartId &&
    sameSource(left.source, right.source) && left.activationId === right.activationId && left.cursor === right.cursor &&
    JSON.stringify(left.relatedPaths ?? []) === JSON.stringify(right.relatedPaths ?? []) &&
    JSON.stringify((left.diagnosticSelection ?? []).map(item => [item.id, item.sequence])) === JSON.stringify((right.diagnosticSelection ?? []).map(item => [item.id, item.sequence]));
}
export async function captureRuntimeSelection(reference: AgsdlRuntimeReference, port: {
  snapshot: (id: AgsdlRuntimeReference["systemStartId"]) => Promise<PublicSnapshot>;
  diagnostic: (request: import("../../types/generated/ipc").DiagnosticRequest) => Promise<PublicExecutionDiagnostic>;
}): Promise<RuntimeSelectionCapture> {
  if (!isAgsdlReference(reference)) throw new Error("Invalid runtime selection");
  const captured = structuredClone(reference);
  const selected = (captured.diagnosticSelection ?? []).map(item => ({ ...item }));
  const snapshot = await port.snapshot(captured.systemStartId);
  if (snapshot.systemStartId !== captured.systemStartId || !sameSource(snapshot.source, captured.source) ||
      (snapshot.associations.conversationId !== undefined && snapshot.associations.conversationId !== captured.conversationId)) throw new Error("Runtime snapshot identity changed");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot.authoredSource))), byte => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== captured.source.sourceSha256) throw new Error("Runtime snapshot source differs");
  const diagnostic = await port.diagnostic({ systemStartId: captured.systemStartId, source: captured.source,
    activationId: captured.activationId ?? null, through: captured.cursor, selected, before: null, recent: false });
  if (diagnostic.systemStartId !== captured.systemStartId || !sameSource(diagnostic.source as SourceRevision, captured.source) || diagnostic.through !== captured.cursor ||
      (diagnostic.activation?.activationId ?? undefined) !== captured.activationId || (diagnostic.activation && diagnostic.activation.systemStartId !== captured.systemStartId) || diagnostic.incomplete || diagnostic.nextBefore !== null ||
      diagnostic.diagnostics.length !== selected.length || diagnostic.diagnostics.some((item, index) => item.id !== selected[index].id || item.sequence !== selected[index].sequence ||
        (item.work && item.work.systemStartId !== captured.systemStartId) || (captured.activationId && item.work?.activationId !== captured.activationId))) throw new Error("Runtime diagnostic identity changed");
  return { reference: captured, fragments: [...new Set([captured.path, ...(captured.relatedPaths ?? [])])].map(path => ({ path, sourceText: sourceAt(snapshot.authoredSource, path) })),
    versions: { snapshot: snapshot.versions.snapshot, contract: snapshot.versions.contract, compiler: snapshot.versions.compiler, runtime: snapshot.versions.runtime,
      registry: snapshot.versions.registry, profile: snapshot.versions.profile },
    diagnostics: diagnostic.diagnostics.map(({ id, sequence, code, pointer, message }) => ({ id, sequence, code, pointer, message })) };
}


/** Revalidate destination metadata before a new acceptance; execution replay never resolves live payloads. */
export async function assertRuntimeSelectionDestination(refs: readonly import("../../types").PersistedContextReference[] | undefined, conversationId: string, ports: {
  conversation: () => { project_id?: string | null } | undefined;
  plan: (branch: string, planId: string) => Promise<{ conversationId?: string | null; status: string } | null>;
}): Promise<void> {
  const reference = refs?.find(ref => ref.kind === "agsdl")?.agsdl;
  if (reference?.contextKind !== "runtime") return;
  if (!isAgsdlReference(reference) || reference.conversationId !== conversationId || ports.conversation()?.project_id !== reference.source.owner.projectId) throw new Error("Runtime selection destination differs");
  const plan = await ports.plan(reference.branchName, reference.planId);
  if (!plan || plan.status === "deleted" || plan.conversationId !== conversationId || ports.conversation()?.project_id !== reference.source.owner.projectId) throw new Error("Runtime selection destination differs");
}
