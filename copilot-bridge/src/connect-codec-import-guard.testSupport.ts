// Real child mode selection must not evaluate the historical bridge or an I/O adapter.
Bun.plugin({ name: 'closed-codec-imports', setup(builder) {
  builder.onResolve({ filter: /@github\/copilot-sdk|\.\/index$|credentials|tauri|stores|streamingChat|httpTransport|nativeClient/ }, args => {
    throw new Error(`forbidden_codec_import:${args.path}`);
  });
} });
