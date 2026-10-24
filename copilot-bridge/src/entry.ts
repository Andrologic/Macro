// Select the private mode before importing any Copilot SDK or credential module.
const command = process.argv[2];
if (command === 'connect-codec' || command === 'connect-bootstrap') {
  if (process.argv.length !== 3) {
    process.stderr.write('connect_codec_arguments\n'); process.exitCode = 1;
  } else {
    try {
      if (command === 'connect-bootstrap') {
        const { runBootstrapCodec } = await import('./connect-bootstrap');
        await runBootstrapCodec();
      } else {
        const { runPersistentCodec } = await import('./connect-codec');
        await runPersistentCodec();
      }
    } catch {
      process.stderr.write('connect_codec_startup\n'); process.exitCode = 1;
    }
  }
} else if (command === 'connect-transfer') {
  if (process.argv.length !== 3) {
    process.stderr.write('connect_transfer_arguments\n'); process.exitCode = 1;
  } else {
    try {
      const { runTransfer } = await import('./connect-transfer');
      await runTransfer();
    } catch {
      process.stderr.write('connect_transfer_startup\n'); process.exitCode = 1;
    }
  }
} else if (command?.startsWith('connect-')) {
  process.stderr.write('connect_codec_unknown_mode\n'); process.exitCode = 1;
} else {
  await import('./index');
}
export {};
