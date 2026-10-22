import type { MacroPilotNativeClient } from '../services/macroPilot/nativeClient';
import { PilotClientError } from '../services/macroPilot/clientError';
import type { ConsumerReaderPorts } from '../services/macroPilot/consumerReader';
import { createMacroConnectConsumer, connectReaderLimits, connectReaderRetry } from './macroConnectConsumer';

/** Called only by the open action. No producer, singleton, vault or HTTP work at import. */
export function macroConnectReaderPorts(native: MacroPilotNativeClient): ConsumerReaderPorts {
  const transport = native.consumerTransport();
  const opened = transport.context();
  const context = () => { const current = transport.context(); if (current.key !== opened.key || current.credentialGeneration !== opened.credentialGeneration) throw new PilotClientError('context_changed'); return current; };
  return { createOwner: () => { context(); return createMacroConnectConsumer(native, connectReaderLimits, connectReaderRetry); },
    context, subscribe: transport.subscribe, localInstanceId: native.getState().instance?.ref.instance_id };
}
