import {
  validateContentMessage, validateContentResponse,
  type ContentNegotiate, type ContentNegotiated, type ContentRequest,
  type ContentResponse, type ContentEventsRequest,
} from './contentProtocol';
import { PilotClientError } from './clientError';
import type { ReadAuthoritySupport } from './readAuthority';

// D1 deliberately implements no commands, files, reflections or interactions.
export const CONSUMER_READ_OPERATIONS = [
  'projects.list', 'conversations.list', 'conversation.read',
  'conversations.catalog', 'conversation.window',
] as const;
export const CONSUMER_CAPABILITIES = [
  'network-reliability-1', 'conversations-1', 'conversation-history-1', 'read-authority-1',
] as const;
export type ConsumerOperation = typeof CONSUMER_READ_OPERATIONS[number];
export type ConsumerCapability = typeof CONSUMER_CAPABILITIES[number];
export type ConsumerReadRequest = ContentRequest<ConsumerOperation>;
export type ConsumerReadRequestFor<O extends ConsumerOperation> = Extract<ConsumerReadRequest, { operation: O }> & ConsumerReadRequest;
export type ConsumerReadResponse<O extends ConsumerOperation = ConsumerOperation> = Extract<ContentResponse, { operation: O }> & Extract<ContentResponse, { operation: ConsumerOperation }>;

/** Non-secret native context. Account ID is the relay's account incarnation. */
export interface ConsumerIdentity {
  key: string;
  configurationId: string;
  relayOrigin: string;
  accountId: string;
  sessionId: string;
  epoch: number;
  /** Non-secret fence, retired before credential replacement or suspension. */
  credentialGeneration?: number;
}
export type ConsumerDispatch =
  | { kind: 'negotiate'; request: ContentNegotiate }
  | { kind: 'submit' | 'poll'; request: ConsumerReadRequest }
  | { kind: 'events'; request: ContentEventsRequest };
export interface ConsumerTransport {
  readAuthority?: ReadAuthoritySupport;
  context(): ConsumerIdentity;
  subscribe(listener: () => void): () => void;
  id(): string;
  now(): number;
  send(context: ConsumerIdentity, instanceId: string, dispatch: ConsumerDispatch, signal: AbortSignal): Promise<{ status: number; data: unknown }>;
}

export function checkConsumerCapabilities(capabilities: readonly string[]): asserts capabilities is readonly ConsumerCapability[] {
  if (new Set(capabilities).size !== capabilities.length ||
    capabilities.some(capability => !CONSUMER_CAPABILITIES.includes(capability as ConsumerCapability)) ||
    (capabilities.includes('conversation-history-1') && !capabilities.includes('conversations-1'))) {
    throw new PilotClientError('invalid_configuration');
  }
}

// Use the canonical opaque ID rules, including length bounds, even for events
// whose body intentionally carries no instance ID.
export function checkConsumerTarget(instanceId: string): void {
  if (!validateContentMessage({ negotiation_version: '1.0', type: 'negotiate', request_id: 'request:target-check',
    instance_id: instanceId, supported_versions: ['2.0'] })) throw new PilotClientError('invalid_configuration');
}

/** Only these routes can use the native consumer credentials port. */
export function consumerWire(instanceId: string, dispatch: ConsumerDispatch) {
  const request = dispatch.request;
  checkConsumerTarget(instanceId);
  if (!validateContentMessage(request) ||
    new TextEncoder().encode(JSON.stringify(request)).byteLength > 256 * 1024) {
    throw new PilotClientError('invalid_configuration');
  }
  const base = `/pilot/v2/instances/${encodeURIComponent(instanceId)}`;
  if (dispatch.kind === 'negotiate') {
    if (request.type !== 'negotiate' || request.instance_id !== instanceId || request.commands?.length) throw new PilotClientError('invalid_configuration');
    checkConsumerCapabilities(request.capabilities ?? []);
    return { method: 'POST', path: '/pilot/extensions/negotiate', body: request };
  }
  if (dispatch.kind === 'events') {
    if (request.type !== 'events.request') throw new PilotClientError('invalid_configuration');
    return { method: 'POST', path: `${base}/events`, body: request };
  }
  if (request.type !== 'request' || !CONSUMER_READ_OPERATIONS.includes(request.operation as ConsumerOperation)) throw new PilotClientError('invalid_configuration');
  const body = request.body as { instance_id?: string; ref?: { instance_id: string } };
  if ((body.ref?.instance_id ?? body.instance_id) !== instanceId) throw new PilotClientError('invalid_configuration');
  if (dispatch.kind === 'poll') return { method: 'GET', path: `${base}/requests/${encodeURIComponent(request.request_id)}`, body: undefined };
  if (dispatch.kind !== 'submit') throw new PilotClientError('invalid_configuration');
  return { method: 'POST', path: `${base}/requests`, body: request };
}

/** Accepted is a transport phase, not a terminal response in validateExchange. */
export function validConsumerResponse(dispatch: ConsumerDispatch, status: number, data: unknown): boolean {
  if (!validateContentMessage(data)) return false;
  if (data.type === 'accepted') {
    return (dispatch.kind === 'submit' || dispatch.kind === 'poll') && status === 202 &&
      data.request_id === dispatch.request.request_id && data.exchange_id === dispatch.request.request_id;
  }
  if (status === 202 || data.type !== 'error' && status !== 200) return false;
  if (dispatch.kind === 'negotiate' && data.type === 'negotiated') {
    try { checkConsumerCapabilities(data.capabilities ?? []); } catch { return false; }
    if (data.commands?.length) return false;
  }
  return validateContentResponse(dispatch.request, data);
}
export function selectedConsumerCapabilities(response: ContentNegotiated): ConsumerCapability[] {
  checkConsumerCapabilities(response.capabilities ?? []);
  return [...response.capabilities ?? []] as ConsumerCapability[];
}
