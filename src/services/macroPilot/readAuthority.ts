import type { ContentReadAuthority, ContentPage } from './contentProtocol';
import { PilotClientError } from './clientError';
import { stableJson, validateA1 } from './protocol';
import type { ConsumerIdentity } from './consumerTransport';

export interface ConsumerSessionObservation { deviceId: string; sessionRevision: number }
/** Only an independently verified lifecycle barrier may opt in. Native stays closed. */
export interface ReadAuthoritySupport { suspensionBarrierVerified: true }
export interface ReadStart { monotonic: number; wall: number }
export interface AdmittedReadAuthority { proof: ContentReadAuthority; started: number; deadline: number }
export class CapabilityCompatibilityError extends PilotClientError {
  constructor(requestId: string) { super('extension_unavailable', 400, false, requestId); }
}
/** The old relay negotiates errors in the closed v1 envelope, including poll. */
export function capabilityCompatibilityError(status: number, header: string | null, requestId: string, data: unknown): CapabilityCompatibilityError | null {
  if (status !== 400 || header !== requestId || !validateA1(data)) return null;
  const value = data as { type?: string; request_id?: string; error?: { code: string; retryable: boolean } };
  return value.type === 'error' && value.request_id === requestId && value.error?.retryable === false &&
    ['validation_failed', 'unsupported_version'].includes(value.error.code) ? new CapabilityCompatibilityError(requestId) : null;
}
export function admitReadAuthority(proof: ContentReadAuthority, identity: ConsumerIdentity, session: ConsumerSessionObservation,
  instanceId: string, accessRevision: number | undefined, started: number, now: number, previous?: AdmittedReadAuthority): AdmittedReadAuthority {
  const duration = Date.parse(proof.expires_at) - Date.parse(proof.issued_at);
  if (!Number.isFinite(started) || !Number.isFinite(now) || now < started || duration < 1 || duration > 30000 ||
    now >= started + duration || proof.account_id !== identity.accountId || proof.session_id !== identity.sessionId ||
    proof.device_id !== session.deviceId || proof.session_revision !== session.sessionRevision || proof.access_revision !== accessRevision ||
    proof.instance_id !== instanceId || stableJson(proof.permissions) !== stableJson(['supervise'])) throw new PilotClientError('invalid_response');
  if (previous) {
    const bound = (value: ContentReadAuthority) => { const { issued_at: _issued, expires_at: _expires, ...rest } = value; return rest; };
    if (stableJson(bound(previous.proof)) !== stableJson(bound(proof))) throw new PilotClientError('context_changed');
  }
  return { proof: structuredClone(proof), started, deadline: started + duration };
}
/** Original logical start, including accepted/poll/retry. A continuation only tightens. */
export function captureDeadline(page: ContentPage, start: ReadStart, authority: AdmittedReadAuthority | undefined, previous?: number): number {
  const expiry = Date.parse(page.expires_at), observed = Date.parse(page.observed_at);
  const bounds = [start.monotonic + Math.min(expiry - observed, 300000), start.monotonic + Math.max(0, expiry - start.wall), previous ?? Infinity];
  if (authority) bounds.push(authority.started + Math.max(0, expiry - Date.parse(authority.proof.issued_at)));
  const result = Math.min(...bounds);
  if (!Number.isFinite(result) || !Number.isFinite(start.monotonic) || !Number.isFinite(start.wall)) throw new PilotClientError('invalid_response');
  return result;
}
