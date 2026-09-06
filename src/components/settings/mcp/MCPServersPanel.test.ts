import { describe, expect, it } from 'bun:test';
import { getMCPErrorAction } from './MCPServersPanel';

describe('MCP settings error actions', () => {
  it('maps preserved runtime codes to an appropriate recovery action', () => {
    expect(getMCPErrorAction({
      authorization: { type: 'oauth' },
      lastErrorCode: 'MCP_OAUTH_AUTHORIZATION_REQUIRED',
    })).toBe('authorize');
    expect(getMCPErrorAction({
      lastErrorCode: 'MCP_RUNTIME_CONFIG_CHANGED',
    })).toBe('edit');
    expect(getMCPErrorAction({
      lastErrorCode: 'MCP_RUNTIME_CALL_TOOL_FAILED',
    })).toBe('retry');
  });

  it('keeps legacy snapshots without a code retryable', () => {
    expect(getMCPErrorAction({ lastErrorCode: null })).toBe('retry');
  });
});
