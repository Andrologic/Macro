export type PilotClientErrorCode =
  | 'extension_unavailable'
  | 'snapshot_expired'
  | 'resource_limit'
  | 'context_changed'
  | 'invalid_configuration'
  | 'invalid_response'
  | 'response_too_large'
  | 'redirect_refused'
  | 'unauthorized'
  | 'session_revoked'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'stale_revision'
  | 'unavailable'
  | 'vault_unavailable'
  | 'vault_intervention_required'
  | 'vault_cancelled'
  | 'vault_suspended'
  | 'offline';

export class PilotClientError extends Error {
  constructor(
    public readonly code: PilotClientErrorCode,
    public readonly status?: number,
    public readonly retryable = false,
    public readonly requestId?: string,
  ) {
    super(code);
    this.name = 'PilotClientError';
  }
}
