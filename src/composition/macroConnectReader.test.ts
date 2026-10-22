import { expect, it, mock } from 'bun:test';
import type { MacroPilotNativeClient } from '../services/macroPilot/nativeClient';
import { createConnectConsumerFixture } from '../../dev/fixtures/connectConsumer';
import { macroConnectReaderPorts } from './macroConnectReader';
it('binds the opening context before lazy UI loading and refuses a late factory after account change', () => {
  const h = createConnectConsumerFixture(); const directory = mock(() => { throw new Error('No owner before opening'); });
  const native = { consumerTransport: () => h.transport, consumerDirectoryTransport: directory, getState: () => ({ instance: null }) } as unknown as MacroPilotNativeClient;
  const ports = macroConnectReaderPorts(native);
  expect(ports.context().key).toBe('context:synthetic'); expect(directory).not.toHaveBeenCalled(); expect(h.calls).toHaveLength(0);
  h.changeAccount(); expect(() => ports.context()).toThrow('context_changed'); expect(() => ports.createOwner()).toThrow('context_changed'); expect(directory).not.toHaveBeenCalled();
});
