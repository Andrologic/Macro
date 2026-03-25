import { readPackageVersion, syncVersionFiles } from './shared.mjs';

const version = readPackageVersion();
const updatedFiles = syncVersionFiles(version);

if (updatedFiles.length === 0) {
  console.log(`Version sync already up to date (${version}).`);
} else {
  console.log(`Synchronized version ${version} across:`);
  updatedFiles.forEach((path) => {
    console.log(`- ${path}`);
  });
}
