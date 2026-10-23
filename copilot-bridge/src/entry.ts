// Select the private mode before importing any Copilot SDK or credential module.
const command = process.argv[2];
if (command === 'connect-codec') {
  if (process.argv.length !== 3) {
    process.stderr.write('connect_codec_arguments\n'); process.exitCode = 1;
  } else {
    try {
      const { runCodec } = await import('./connect-codec');
      await runCodec();
    } catch {
      process.stderr.write('connect_codec_startup\n'); process.exitCode = 1;
    }
  }
} else if (command?.startsWith('connect-')) {
  process.stderr.write('connect_codec_unknown_mode\n'); process.exitCode = 1;
} else {
  await import('./index');
}
export {};
