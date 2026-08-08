import type { MCPServer } from '../../types';

export const MCP_ENV_SECRET_REF_PREFIX = 'macro-secret://mcp-env/';
export const MCP_SECRET_DISPLAY_VALUE = '********';
export const SENSITIVE_MCP_ENV_KEY_PATTERN =
  /(TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|ACCESS[_-]?KEY|AUTH|CREDENTIAL)/i;

export const isSensitiveMCPEnvKey = (key: string): boolean =>
  SENSITIVE_MCP_ENV_KEY_PATTERN.test(key);

export const isMCPEnvSecretRef = (value: string): boolean =>
  value.startsWith(MCP_ENV_SECRET_REF_PREFIX);

export const shouldMaskMCPEnvValue = (key: string, value: string): boolean =>
  isSensitiveMCPEnvKey(key) || isMCPEnvSecretRef(value);

export const parseMCPEnvSecretRef = (
  value: string
): { serverId: string; key: string; id: string } | null => {
  if (!isMCPEnvSecretRef(value)) return null;
  const suffix = value.slice(MCP_ENV_SECRET_REF_PREFIX.length);
  const separator = suffix.indexOf('/');
  if (separator <= 0 || separator === suffix.length - 1) return null;
  const serverId = suffix.slice(0, separator);
  const key = suffix.slice(separator + 1);
  return { serverId, key, id: `${serverId}/${key}` };
};

export const collectMCPEnvSecretRefs = (
  servers: Record<string, MCPServer>
): Map<string, { serverId: string; key: string }> => {
  const refs = new Map<string, { serverId: string; key: string }>();
  Object.values(servers).forEach((server) => {
    if (server.transport?.type !== 'stdio') return;
    Object.values(server.transport.env ?? {}).forEach((value) => {
      const ref = parseMCPEnvSecretRef(value);
      if (ref) {
        refs.set(ref.id, { serverId: ref.serverId, key: ref.key });
      }
    });
  });
  return refs;
};

export const parseMCPArgs = (value: string): string[] => {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return trimmed.split(/\s+/);
    }
  }
  return trimmed.split(/\s+/);
};

export const parseMCPEnv = (
  value: string,
  previousEnv: Record<string, string> = {}
): Record<string, string> =>
  Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator < 0) {
          return [line, ''];
        }
        const key = line.slice(0, separator).trim();
        const nextValue = line.slice(separator + 1).trim();
        return [
          key,
          nextValue === MCP_SECRET_DISPLAY_VALUE && previousEnv[key]
            ? previousEnv[key]
            : nextValue,
        ];
      })
      .filter(([key]) => key.length > 0)
  );

export const formatMCPEnvForEdit = (env: Record<string, string> = {}): string =>
  Object.entries(env)
    .map(([key, value]) =>
      `${key}=${shouldMaskMCPEnvValue(key, value) ? MCP_SECRET_DISPLAY_VALUE : value}`
    )
    .join('\n');
