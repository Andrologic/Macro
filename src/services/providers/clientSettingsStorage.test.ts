import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  clampBoundedNumber,
  MCP_MAX_CONCURRENT_OPERATIONS_RANGE,
  MCP_OPERATION_TIMEOUT_MS_RANGE,
  MCP_PROBE_TIMEOUT_MS_RANGE,
  MCP_STARTUP_TIMEOUT_MS_RANGE,
  normalizeMCPDisabledTools,
  normalizeMCPProtocolMode,
  normalizeMCPProtocolSettings,
  normalizeMCPServerPolicy,
  normalizeMCPServerSettingsInput,
  PersistedMCPServer,
  toPersistedMCPServers,
  toRuntimeMCPServers,
} from './clientSettingsStorage';

type SchemaNode = {
  $ref?: string;
  anyOf?: SchemaNode[];
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
  items?: SchemaNode;
  minimum?: number;
  maximum?: number;
};

type SchemaRoot = { definitions: Record<string, SchemaNode> };

const loadToolsSchema = (): SchemaRoot =>
  JSON.parse(
    readFileSync(
      new URL('../../../src-tauri/config-schemas/v1/tools.schema.json', import.meta.url),
      'utf8'
    )
  );

const resolveSchemaNode = (
  node: SchemaNode,
  root: SchemaRoot
): SchemaNode => {
  if (!node.$ref) return node;
  const name = node.$ref.replace('#/definitions/', '');
  const resolved = root.definitions[name];
  if (!resolved) throw new Error(`Unknown schema reference: ${node.$ref}`);
  return resolved;
};

const matchesType = (value: unknown, typeName: string): boolean => {
  switch (typeName) {
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    default:
      return false;
  }
};

const validateAgainstSchema = (
  value: unknown,
  rawNode: SchemaNode,
  root: SchemaRoot,
  path = ''
): string[] => {
  const node = resolveSchemaNode(rawNode, root);
  const label = path || '$';

  if (node.anyOf) {
    const branchErrors = node.anyOf.map((branch) =>
      validateAgainstSchema(value, branch, root, path)
    );
    if (branchErrors.some((errors) => errors.length === 0)) {
      return [];
    }
    return Array.from(new Set(branchErrors.flat()));
  }

  if (node.type) {
    const typeNames = Array.isArray(node.type) ? node.type : [node.type];
    if (!typeNames.some((typeName) => matchesType(value, typeName))) {
      return [`${label}: expected type ${typeNames.join('|')}`];
    }
  }

  if (node.enum && !node.enum.includes(value)) {
    return [`${label}: ${JSON.stringify(value)} is not one of ${JSON.stringify(node.enum)}`];
  }

  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) {
      return [`${label}: ${value} is below minimum ${node.minimum}`];
    }
    if (node.maximum !== undefined && value > node.maximum) {
      return [`${label}: ${value} is above maximum ${node.maximum}`];
    }
  }

  if (Array.isArray(value)) {
    if (!node.items) return [];
    return value.flatMap((entry, index) =>
      validateAgainstSchema(entry, node.items as SchemaNode, root, `${label}[${index}]`)
    );
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const errors: string[] = [];
    const record = value as Record<string, unknown>;
    for (const key of node.required ?? []) {
      if (!(key in record)) {
        errors.push(`${label}: missing required property "${key}"`);
      }
    }
    for (const [key, entry] of Object.entries(record)) {
      const propertySchema = node.properties?.[key];
      if (propertySchema) {
        errors.push(...validateAgainstSchema(entry, propertySchema, root, `${label}.${key}`));
        continue;
      }
      if (node.additionalProperties === false) {
        errors.push(`${label}: unexpected property "${key}"`);
        continue;
      }
      if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        errors.push(
          ...validateAgainstSchema(entry, node.additionalProperties, root, `${label}.${key}`)
        );
      }
    }
    return errors;
  }

  return [];
};

import type { MCPStdioTransportConfig } from '../../types';

const stdioTransport: MCPStdioTransportConfig = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'server-legacy'],
};

describe('persisted MCP server policy helpers', () => {
  it('clamps bounded numeric settings into their range', () => {
    expect(clampBoundedNumber(1, MCP_PROBE_TIMEOUT_MS_RANGE)).toBe(MCP_PROBE_TIMEOUT_MS_RANGE.min);
    expect(clampBoundedNumber(99_999, MCP_PROBE_TIMEOUT_MS_RANGE)).toBe(
      MCP_PROBE_TIMEOUT_MS_RANGE.max
    );
    expect(clampBoundedNumber('fast', MCP_STARTUP_TIMEOUT_MS_RANGE)).toBeUndefined();
    expect(clampBoundedNumber(Number.NaN, MCP_OPERATION_TIMEOUT_MS_RANGE)).toBeUndefined();
    expect(clampBoundedNumber(2.6, MCP_MAX_CONCURRENT_OPERATIONS_RANGE)).toBe(3);
  });

  it('accepts only known protocol modes', () => {
    expect(normalizeMCPProtocolMode('auto')).toBe('auto');
    expect(normalizeMCPProtocolMode('legacy')).toBe('legacy');
    expect(normalizeMCPProtocolMode('modern')).toBe('modern');
    expect(normalizeMCPProtocolMode('experimental')).toBeUndefined();
    expect(normalizeMCPProtocolMode(42)).toBeUndefined();
  });

  it('keeps valid parts of a protocol block and drops invalid ones', () => {
    expect(normalizeMCPProtocolSettings({ mode: 'auto', probeTimeoutMs: 2000 })).toEqual({
      mode: 'auto',
      probeTimeoutMs: 2000,
    });
    expect(normalizeMCPProtocolSettings({ mode: 'bogus', probeTimeoutMs: 2000 })).toEqual({
      probeTimeoutMs: 2000,
    });
    expect(normalizeMCPProtocolSettings({ mode: 'bogus' })).toBeUndefined();
    expect(normalizeMCPProtocolSettings('modern')).toBeUndefined();
    expect(normalizeMCPProtocolSettings(null)).toBeUndefined();
  });

  it('normalizes disabled tool lists without inventing entries', () => {
    expect(normalizeMCPDisabledTools(['a', 'a ', ' b', ''])).toEqual(['a', 'b']);
    expect(normalizeMCPDisabledTools([])).toEqual([]);
    expect(normalizeMCPDisabledTools('search')).toBeUndefined();
    expect(normalizeMCPDisabledTools([1, 2])).toEqual([]);
  });

  it('returns an empty policy for missing or empty inputs', () => {
    expect(normalizeMCPServerPolicy(undefined)).toEqual({});
    expect(Object.keys(normalizeMCPServerPolicy({}))).toEqual([]);
  });
});

describe('persisted MCP definition mapping', () => {
  it('loads existing definitions without protocol fields unchanged', () => {
    const servers = toRuntimeMCPServers({
      legacy: {
        name: 'Legacy',
        enabled: true,
        transport: stdioTransport,
      },
    });

    const server = servers.legacy;
    expect(server.id).toBe('legacy');
    expect(server.name).toBe('Legacy');
    expect(server.transport).toEqual(stdioTransport);
    expect(server.config).toEqual({ enabled: true });
    expect('protocol' in server).toBe(false);
    expect('startupTimeoutMs' in server).toBe(false);
    expect('operationTimeoutMs' in server).toBe(false);
    expect('maxConcurrentOperations' in server).toBe(false);
    expect('disabledTools' in server).toBe(false);
    expect(server.status).toBe('offline');
    expect(server.tools).toEqual([]);
  });

  it('maps a fully specified dual-era definition into runtime fields', () => {
    const persisted: Record<string, PersistedMCPServer> = {
      files: {
        name: 'Files',
        description: 'Filesystem tools',
        category: 'development',
        icon: 'server',
        website: 'https://example.com',
        enabled: true,
        transport: { type: 'streamable_http', url: 'https://mcp.example.com/mcp' },
        protocol: { mode: 'auto', probeTimeoutMs: 2000 },
        startupTimeoutMs: 30_000,
        operationTimeoutMs: 60_000,
        maxConcurrentOperations: 4,
        disabledTools: ['write_file'],
      },
    };

    const server = toRuntimeMCPServers(persisted).files;
    expect(server.protocol).toEqual({ mode: 'auto', probeTimeoutMs: 2000 });
    expect(server.startupTimeoutMs).toBe(30_000);
    expect(server.operationTimeoutMs).toBe(60_000);
    expect(server.maxConcurrentOperations).toBe(4);
    expect(server.disabledTools).toEqual(['write_file']);
    expect(server.status).toBe('offline');
  });

  it('clamps out-of-range persisted values back into documented bounds', () => {
    const server = toRuntimeMCPServers({
      tuned: {
        transport: { type: 'sse', url: 'https://mcp.example.com/sse' },
        protocol: { mode: 'legacy', probeTimeoutMs: 1 },
        startupTimeoutMs: 999_999_999,
        operationTimeoutMs: 0,
        maxConcurrentOperations: 99,
      },
    }).tuned;

    expect(server.protocol).toEqual({
      mode: 'legacy',
      probeTimeoutMs: MCP_PROBE_TIMEOUT_MS_RANGE.min,
    });
    expect(server.startupTimeoutMs).toBe(MCP_STARTUP_TIMEOUT_MS_RANGE.max);
    expect(server.operationTimeoutMs).toBe(MCP_OPERATION_TIMEOUT_MS_RANGE.min);
    expect(server.maxConcurrentOperations).toBe(MCP_MAX_CONCURRENT_OPERATIONS_RANGE.max);
  });

  it('drops an unusable protocol block instead of guessing an era', () => {
    const server = toRuntimeMCPServers({
      broken: {
        transport: stdioTransport,
        protocol: { mode: 'warp' } as unknown as PersistedMCPServer['protocol'],
      },
    }).broken;

    expect('protocol' in server).toBe(false);
  });

  it('persists legacy-shaped servers without introducing new keys', () => {
    const payload = toPersistedMCPServers(
      toRuntimeMCPServers({
        legacy: {
          name: 'Legacy',
          enabled: true,
          transport: stdioTransport,
        },
      })
    );

    const serialized = JSON.parse(JSON.stringify(payload.legacy)) as Record<string, unknown>;
    expect(Object.keys(serialized).sort()).toEqual([
      'category',
      'description',
      'enabled',
      'icon',
      'name',
      'transport',
    ]);
    expect(serialized.enabled).toBe(true);
  });

  it('persists declared policy but never observed runtime state', () => {
    const runtime = toRuntimeMCPServers({
      files: {
        name: 'Files',
        enabled: true,
        transport: { type: 'streamable_http', url: 'https://mcp.example.com/mcp' },
        protocol: { mode: 'modern' },
        startupTimeoutMs: 45_000,
        operationTimeoutMs: 90_000,
        maxConcurrentOperations: 8,
        disabledTools: ['delete_file'],
      },
    }).files;

    runtime.status = 'online';
    runtime.lastError = 'boom';
    runtime.discoveredAt = '2026-08-24T00:00:00Z';
    runtime.tools = [
      {
        id: 'mcp__files__read_file',
        serverId: 'files',
        name: 'read_file',
      },
    ];

    const payload = toPersistedMCPServers({ files: runtime }).files;
    expect(payload.protocol).toEqual({ mode: 'modern' });
    expect(payload.startupTimeoutMs).toBe(45_000);
    expect(payload.operationTimeoutMs).toBe(90_000);
    expect(payload.maxConcurrentOperations).toBe(8);
    expect(payload.disabledTools).toEqual(['delete_file']);
    expect('status' in payload).toBe(false);
    expect('lastError' in payload).toBe(false);
    expect('discoveredAt' in payload).toBe(false);
    expect('tools' in payload).toBe(false);
  });

  it('round-trips a dual-era definition without drift', () => {
    const original: Record<string, PersistedMCPServer> = {
      files: {
        name: 'Files',
        description: 'Filesystem tools',
        category: 'development',
        icon: 'server',
        website: 'https://example.com',
        enabled: true,
        transport: { type: 'streamable_http', url: 'https://mcp.example.com/mcp' },
        protocol: { mode: 'auto', probeTimeoutMs: 2_500 },
        startupTimeoutMs: 20_000,
        operationTimeoutMs: 120_000,
        maxConcurrentOperations: 6,
        disabledTools: ['delete_file', 'move_file'],
      },
    };

    const repersisted = toPersistedMCPServers(toRuntimeMCPServers(original));
    expect(JSON.parse(JSON.stringify(repersisted))).toEqual(
      JSON.parse(JSON.stringify(original))
    );
  });

  it('preserves policy fields through the settings input pipeline', () => {
    const runtime = toRuntimeMCPServers({
      files: {
        name: 'Files',
        enabled: true,
        transport: { type: 'streamable_http', url: 'https://mcp.example.com/mcp' },
        protocol: { mode: 'auto', probeTimeoutMs: 3_000 },
        disabledTools: ['delete_file'],
      },
    }).files;

    const normalized = normalizeMCPServerSettingsInput({ servers: { files: runtime } });
    expect(normalized.files.protocol).toEqual({ mode: 'auto', probeTimeoutMs: 3_000 });
    expect(normalized.files.disabledTools).toEqual(['delete_file']);

    const placeholder = normalizeMCPServerSettingsInput({ servers: { example: true } });
    expect('protocol' in placeholder.example).toBe(false);
    expect(placeholder.example.config).toEqual({ enabled: true });
  });
});

describe('tools.schema.json MCP server definition', () => {
  const schema = loadToolsSchema();
  const serverDefinition = schema.definitions.McpServerDefinition;
  const serverValidator = (server: unknown): string[] =>
    validateAgainstSchema(server, serverDefinition, schema);

  it('keeps existing configurations valid without the new fields', () => {
    expect(serverDefinition.required).toEqual(['transport']);
    expect(
      serverValidator({
        transport: stdioTransport,
        enabled: true,
      })
    ).toEqual([]);
  });

  it('declares bounded protocol, timeout, concurrency and disabled tool fields', () => {
    const protocolProperty = serverDefinition.properties?.protocol;
    const protocolBranches = protocolProperty?.anyOf ?? [];
    expect(
      protocolBranches.some(
        (branch) => resolveSchemaNode(branch, schema) === schema.definitions.McpProtocolSettings
      )
    ).toBe(true);
    expect(serverDefinition.properties?.disabledTools).toMatchObject({
      type: ['array', 'null'],
      items: { type: 'string' },
    });

    const expectBounded = (
      property: string,
      range: { min: number; max: number }
    ) => {
      expect(serverDefinition.properties?.[property]).toMatchObject({
        minimum: range.min,
        maximum: range.max,
      });
    };

    expectBounded('startupTimeoutMs', MCP_STARTUP_TIMEOUT_MS_RANGE);
    expectBounded('operationTimeoutMs', MCP_OPERATION_TIMEOUT_MS_RANGE);
    expectBounded('maxConcurrentOperations', MCP_MAX_CONCURRENT_OPERATIONS_RANGE);

    const protocolSettings = schema.definitions.McpProtocolSettings;
    expect(protocolSettings.additionalProperties).toBe(false);
    const probe = protocolSettings.properties?.probeTimeoutMs;
    expect(probe).toMatchObject({
      minimum: MCP_PROBE_TIMEOUT_MS_RANGE.min,
      maximum: MCP_PROBE_TIMEOUT_MS_RANGE.max,
    });
    const modeProperty = protocolSettings.properties?.mode;
    expect(modeProperty?.anyOf?.length).toBe(2);
    expect(
      modeProperty?.anyOf?.some(
        (branch) => resolveSchemaNode(branch, schema) === schema.definitions.McpProtocolMode
      )
    ).toBe(true);
    expect(schema.definitions.McpProtocolMode).toMatchObject({
      enum: ['auto', 'legacy', 'modern'],
    });
  });

  it('accepts a fully specified dual-era definition', () => {
    expect(
      serverValidator({
        name: 'Modern',
        enabled: true,
        transport: { type: 'streamable_http', url: 'https://mcp.example.com/mcp' },
        protocol: { mode: 'auto', probeTimeoutMs: 2_000 },
        startupTimeoutMs: 30_000,
        operationTimeoutMs: 60_000,
        maxConcurrentOperations: 4,
        disabledTools: [],
      })
    ).toEqual([]);
  });

  it('rejects out-of-bounds timings and concurrency', () => {
    const base = {
      transport: stdioTransport,
      protocol: { mode: 'auto', probeTimeoutMs: 100 },
      startupTimeoutMs: 100,
      operationTimeoutMs: 700_000,
      maxConcurrentOperations: 32,
    };
    const errors = serverValidator(base);
    expect(errors.some((message) => message.includes('probeTimeoutMs'))).toBe(true);
    expect(errors.some((message) => message.includes('startupTimeoutMs'))).toBe(true);
    expect(errors.some((message) => message.includes('operationTimeoutMs'))).toBe(true);
    expect(errors.some((message) => message.includes('maxConcurrentOperations'))).toBe(true);
  });

  it('rejects unknown protocol modes', () => {
    const errors = serverValidator({
      transport: stdioTransport,
      protocol: { mode: 'warp' },
    });
    expect(errors.some((message) => message.includes('mode'))).toBe(true);
  });

  it('rejects observed runtime fields in the persisted document', () => {
    const errors = serverValidator({
      transport: stdioTransport,
      status: 'ready',
      lastError: 'boom',
      discoveredAt: '2026-08-24T00:00:00Z',
    });
    expect(errors).toContain('$: unexpected property "status"');
    expect(errors).toContain('$: unexpected property "lastError"');
    expect(errors).toContain('$: unexpected property "discoveredAt"');
  });
});
