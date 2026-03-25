import { readVersionState } from './shared.mjs';

const state = readVersionState();

if (state.issues.length > 0) {
  console.error(`Version check failed for ${state.packageVersion}:`);
  state.issues.forEach((issue) => {
    console.error(`- ${issue}`);
  });
  process.exitCode = 1;
} else {
  console.log(`Version check passed (${state.packageVersion}).`);
}
