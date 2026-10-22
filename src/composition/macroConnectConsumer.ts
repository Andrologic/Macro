import type { MacroPilotNativeClient } from '../services/macroPilot/nativeClient';
import { ConsumerConnections } from '../services/macroPilot/consumerConnections';
import type { ConsumerClock, ConsumerLimits, ConsumerRetryPolicy } from '../services/macroPilot/consumerPolicy';

/** Inert factory. The caller owns disposal; no product limits or startup side effect. */
export function createMacroConnectConsumer(native: MacroPilotNativeClient, limits: ConsumerLimits, retry: ConsumerRetryPolicy, clock?: ConsumerClock): ConsumerConnections {
  return new ConsumerConnections(native.consumerTransport(), native.consumerDirectoryTransport(), limits, retry, clock);
}

// Explicit UI admission choices. Serialized bytes/counts, not a measured heap budget.
export const connectReaderLimits: ConsumerLimits = Object.freeze({ targets: 2, subscribers: 4, activeReads: 2,
  directoryPages: 16, directoryItems: 256, directoryBytes: 262144, pageItems: 50, pageBytes: 65536, identities: 512, cursors: 32 });
export const connectReaderRetry: ConsumerRetryPolicy = Object.freeze({ delaysMs: Object.freeze([1000, 3000]), maxDelayMs: 5000,
  deadlineMs: 30000, jitterRatio: 0.2, pollIntervalMs: 250 });
