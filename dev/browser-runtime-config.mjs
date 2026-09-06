import { join } from 'node:path';

export const QA_IDENTIFIER = /^com\.macro\.desktop\.qa\.[a-z0-9-]{6,48}$/;

export function validateQaBrowserRuntimeConfig(config) {
  if (!config || typeof config !== 'object' || !QA_IDENTIFIER.test(config.identifier || '')) {
    throw new Error('A custom browser runtime config requires an isolated com.macro.desktop.qa.* identifier.');
  }
  const permissions = config.app?.security?.capabilities
    ?.flatMap((capability) => capability?.permissions || []) || [];
  if (!permissions.includes('tauri-remote-ui:allow-complete-rpc')) {
    throw new Error('The custom browser runtime config must enable the debug RPC capability.');
  }
  return config;
}

export function resolveQaBrowserLogDirectory(config, temporaryDirectory) {
  const validated = validateQaBrowserRuntimeConfig(config);
  if (typeof temporaryDirectory !== 'string' || temporaryDirectory.length === 0) {
    throw new Error('The browser runtime log root must be a temporary directory.');
  }
  return join(temporaryDirectory, 'macro-browser-runtime', validated.identifier, 'logs');
}
