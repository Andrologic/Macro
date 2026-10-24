// Real child mode selection must not evaluate the historical bridge or an I/O adapter.
Bun.plugin({ name: 'closed-codec-imports', setup(builder) {
  if (process.argv[2] === 'connect-codec') builder.onResolve({ filter: /macroPilot\/(protocol|schemaValidators)/ }, args => {
    throw new Error(`persistent_imports_A1:${args.path}`);
  });
  builder.onResolve({ filter: /@github\/copilot-sdk|\.\/index$|credentials|tauri|stores|streamingChat|httpTransport|nativeClient|^ajv(?:\/|$)|^ajv-formats(?:\/|$)|dev\/generate/ }, args => {
    throw new Error(`forbidden_codec_import:${args.path}`);
  });
} });
