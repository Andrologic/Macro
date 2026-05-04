#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";

const TEN_MIB = 10 * 1024 * 1024;
const args = new Set(process.argv.slice(2));

const blockedDirectories = [
  "output/",
  "dist/",
  "dist-ssr/",
  "target/",
  "src-tauri/target/",
  "src-tauri/binaries/",
];

const blockedExtensions = new Set([
  ".7z",
  ".appimage",
  ".deb",
  ".dmg",
  ".exe",
  ".ipa",
  ".msi",
  ".pkg",
  ".rpm",
  ".tar",
  ".tgz",
  ".zip",
]);

function git(args) {
  return execFileSync("git", args, { encoding: "buffer" });
}

function decodePathList(output) {
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"));
}

function trackedFiles() {
  if (args.has("--staged")) {
    return decodePathList(
      git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]),
    );
  }

  return decodePathList(git(["ls-files", "-z"]));
}

function stagedSize(path) {
  const objectName = `:${path}`;
  try {
    return Number(execFileSync("git", ["cat-file", "-s", objectName], { encoding: "utf8" }).trim());
  } catch {
    return fileSize(path);
  }
}

function fileSize(path) {
  if (!existsSync(path)) {
    return 0;
  }

  return statSync(path).size;
}

function isBlockedPath(path) {
  return blockedDirectories.some((directory) => path === directory.slice(0, -1) || path.startsWith(directory));
}

function isBlockedExtension(path) {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".tar.gz") || lowerPath.endsWith(".tar.xz") || lowerPath.endsWith(".tar.bz2")) {
    return true;
  }

  return blockedExtensions.has(extname(lowerPath));
}

const violations = [];

for (const path of trackedFiles()) {
  const size = args.has("--staged") ? stagedSize(path) : fileSize(path);

  if (isBlockedPath(path)) {
    violations.push(`${path} is inside a generated artifact directory`);
    continue;
  }

  if (isBlockedExtension(path)) {
    violations.push(`${path} looks like a release/archive binary`);
    continue;
  }

  if (size > TEN_MIB) {
    violations.push(`${path} is ${(size / 1024 / 1024).toFixed(2)} MiB, above the 10 MiB tracked-file limit`);
  }
}

if (violations.length > 0) {
  console.error("Refusing generated binaries or oversized files in Git:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error("");
  console.error("Publish installers and archives through GitHub Releases instead of committing them.");
  process.exit(1);
}

console.log("No generated binaries or oversized tracked files found.");
