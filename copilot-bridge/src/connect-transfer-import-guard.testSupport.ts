Bun.plugin({ name: 'closed-transfer-imports', setup(builder) {
  builder.onResolve({ filter: /@github\/copilot-sdk|\.\/index$|credentials|tauri|stores|streamingChat|httpTransport|nativeClient|providerApi/ }, args => {
    throw new Error(`forbidden_transfer_import:${args.path}`);
  });
} });
// A synthetic child can only use inherited fd 0/1 and local computation.
globalThis.fetch = Object.assign(() => { throw Error('forbidden_transfer_fetch'); }, { preconnect: () => { throw Error('forbidden_transfer_preconnect'); } });
