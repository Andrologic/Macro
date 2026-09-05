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
