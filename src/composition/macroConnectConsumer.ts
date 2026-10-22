import type { MacroPilotNativeClient } from '../services/macroPilot/nativeClient';
import { ConsumerConnections } from '../services/macroPilot/consumerConnections';
import type { ConsumerClock, ConsumerLimits, ConsumerRetryPolicy } from '../services/macroPilot/consumerPolicy';

/** Inert factory. The caller owns disposal; no product limits or startup side effect. */
export function createMacroConnectConsumer(native: MacroPilotNativeClient, limits: ConsumerLimits, retry: ConsumerRetryPolicy, clock?: ConsumerClock): ConsumerConnections {
  return new ConsumerConnections(native.consumerTransport(), native.consumerDirectoryTransport(), limits, retry, clock);
}
