import { invoke, isBrowserRuntimeBridgeEnabled } from '../tauriRuntimeBridge';
import type { ReviewCaptureRequest, ReviewCaptureInfo, ReviewCapturePage, ReviewCaptureFragment } from '../macroPilot/reviewCapture';

export type PilotSecretKind = 'session_token' | 'instance_key' | 'claim_secret' | 'poll_secret';
export interface PilotSecretScope {
  configuration_id: string;
  relay_origin: string;
  kind: PilotSecretKind;
  resource_id: string;
}
export type PilotSecretError = 'invalid_scope' | 'invalid_secret' | 'intervention_required' | 'cancelled' | 'vault_unavailable' | 'context_changed' | 'suspended';
export type PilotVaultStatus = 'ready' | 'intervention_required' | 'cancelled' | 'vault_unavailable' | 'suspended';
export interface PilotVaultContext {
  configuration_id: string;
  relay_origin: string;
  owner_id: string;
}
export interface PilotVaultLease { generation: string; status: PilotVaultStatus }

function requireNativePilotVault(): void {
  if (typeof window === 'undefined' || isBrowserRuntimeBridgeEnabled() ||
      typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke !== 'function') {
    throw new Error('Pilot credential storage requires the native desktop runtime.');
  }
}
export async function pilotVaultActivate(context: PilotVaultContext, generation?: string): Promise<PilotVaultLease> {
  requireNativePilotVault(); return invoke('pilot_vault_activate', { context, generation });
}
export async function pilotVaultInvalidate(generation: string): Promise<PilotVaultLease> {
  requireNativePilotVault(); return invoke('pilot_vault_invalidate', { generation });
}
export async function pilotVaultResume(scopes: PilotSecretScope[], generation: string): Promise<PilotVaultLease> {
  requireNativePilotVault(); return invoke('pilot_vault_resume', { scopes, generation });
}
export async function pilotVaultSubscribe(listener: (state: PilotVaultLease) => void): Promise<() => void> {
  requireNativePilotVault();
  const { listen } = await import('@tauri-apps/api/event');
  return listen<PilotVaultLease>('pilot-vault-state', event => listener(event.payload));
}
export async function pilotSecretRead(scope: PilotSecretScope, generation?: string): Promise<string | null> {
  requireNativePilotVault(); return invoke('pilot_secret_read', { scope, generation });
}
export async function pilotSecretWrite(scope: PilotSecretScope, secret: string, generation?: string): Promise<void> {
  requireNativePilotVault(); return invoke('pilot_secret_write', { scope, secret, generation });
}
export async function pilotSecretDelete(scope: PilotSecretScope, generation?: string): Promise<void> {
  requireNativePilotVault(); return invoke('pilot_secret_delete', { scope, generation });
}
export async function pilotReviewCapture(repoPath: string, request: ReviewCaptureRequest): Promise<ReviewCaptureInfo> {
  return invoke('pilot_review_capture', { repoPath, request });
}
export async function pilotReviewFiles(snapshotId: string, cursor?: string): Promise<ReviewCapturePage> {
  return invoke('pilot_review_files', { snapshotId, cursor: cursor ?? null });
}
export async function pilotReviewRead(snapshotId: string, fileId: string, offsetBytes: number): Promise<ReviewCaptureFragment> {
  return invoke('pilot_review_read', { snapshotId, fileId, offsetBytes });
}
export async function pilotReviewFresh(snapshotId: string, request: ReviewCaptureRequest): Promise<boolean> {
  return invoke('pilot_review_fresh', { snapshotId, request });
}
export async function pilotReviewRelease(snapshotId: string): Promise<void> {
  return invoke('pilot_review_release', { snapshotId });
}
export async function pilotContentPolicy(): Promise<string[]> {
  return invoke('pilot_content_policy');
}
export async function pilotReviewCommit(input: {
  snapshotId: string; request: ReviewCaptureRequest;
  key: string; expectedValueJson: string | null; valueJson: string; executeBefore: string;
  branches?: { base: string; head: string };
}): Promise<boolean> {
  return invoke('pilot_review_commit', { input });
}
export interface PilotToolTraceMetadata {
  message_id: string; trace_index: number; tool_call_id: string; tool_name: string;
  status: 'running' | 'pending_approval' | 'denied' | 'done'; has_detail: boolean; detail_bytes: number;
}
function pilotToolTraceError(error: unknown): never {
  const message = typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? error.message : undefined;
  const codes = ['not_found', 'content_unavailable', 'resource_limit', 'stale_revision'];
  throw new Error(typeof message === 'string' && codes.includes(message) ? message : 'unavailable');
}
export async function pilotToolTracesList(conversationId: string): Promise<{ revision: number; traces: PilotToolTraceMetadata[] }> {
  return invoke<{ revision: number; traces: PilotToolTraceMetadata[] }>('pilot_tool_traces_list', { conversationId }).catch(pilotToolTraceError);
}
export async function pilotToolTraceRead(params: { conversationId: string; messageId: string; traceIndex: number; expectedRevision: number }): Promise<{ revision: number; detail: string }> {
  return invoke<{ revision: number; detail: string }>('pilot_tool_trace_read', params).catch(pilotToolTraceError);
}
