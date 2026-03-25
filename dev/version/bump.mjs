import {
  assertValidSemver,
  bumpVersion,
  readPackageVersion,
  readVersionState,
  syncVersionFiles,
  writePackageVersion,
} from './shared.mjs';

const args = process.argv.slice(2);
const [target, preid] = args;

if (!target || target === '--help' || target === '-h') {
  console.error(
    'Usage: bun run version:bump <major|minor|patch|premajor|preminor|prepatch|prerelease|rc|weekly|x.y.z[-tag]> [preid|YYYYMMDD]'
  );
  process.exitCode = 1;
} else {
  const currentVersion = readPackageVersion();
  const nextVersion = (() => {
    const releaseTypes = new Set([
      'major',
      'minor',
      'patch',
      'premajor',
      'preminor',
      'prepatch',
      'prerelease',
      'rc',
      'weekly',
    ]);

    if (releaseTypes.has(target)) {
      return bumpVersion(currentVersion, target, preid);
    }

    return assertValidSemver(target);
  })();

  writePackageVersion(nextVersion);
  syncVersionFiles(nextVersion);

  const state = readVersionState();
  if (state.issues.length > 0) {
    console.error(`Version bump completed but validation failed for ${nextVersion}:`);
    state.issues.forEach((issue) => {
      console.error(`- ${issue}`);
    });
    process.exitCode = 1;
  } else {
    console.log(`Bumped version: ${currentVersion} -> ${nextVersion}`);
  }
}
