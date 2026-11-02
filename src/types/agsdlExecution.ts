/** Shared public identity types. Brands carry no native authority. */
export type Identity<Kind extends string> = string & { readonly __identity: Kind };
export type SystemStartId = Identity<'systemStart'>;
export type FlowInvocationId = Identity<'flowInvocation'>;
export type AgentInstanceId = Identity<'agentInstance'>;
export type ActivationId = Identity<'activation'>;
export type DeliveryId = Identity<'delivery'>;
export type ProviderAttemptId = Identity<'providerAttempt'>;
export type ToolInvocationId = Identity<'toolInvocation'>;
export type ResponseMessageId = Identity<'responseMessage'>;
/** Canonical nonnegative decimal integers on the wire, never JS numbers. */
export type Sequence = Identity<'sequence'>;
export type OwnerEpoch = Identity<'ownerEpoch'>;
/** Validated with the exact vendor reader; never JSON.parse/structuredClone. */
export type ExactJsonText = Identity<'exactJsonText'>;
export type Sha256 = Identity<'sha256'>;
export interface SourceOwner {
  readonly projectId: string;
  readonly planId: string;
  readonly branch: string;
}
export interface SourceRevision {
  readonly owner: SourceOwner;
  readonly revision: string;
  readonly sourceSha256: Sha256;
}
