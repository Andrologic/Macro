/** Synthetic identity and context helpers shared by controller tests. */
import type { ExactJsonText,ExecutionContext,Identity } from './contracts';
export const json = (value: string) => value as ExactJsonText;
export const id = <K extends string>(value: string) => value as Identity<K>;
export const contextFixture = (): ExecutionContext => ({ owner: { systemStartId: id('system'), ownerEpoch: id('3') }, work: { systemStartId: id('system'), flowInvocationId: id('flow'), activationId: id('activation'), step: ['work'], agentInstanceId: id('worker-instance') }, permissionsJson: json('["read"]'), scopeJson: json('{}'), registryVersion: 'synthetic-captured/1' });
