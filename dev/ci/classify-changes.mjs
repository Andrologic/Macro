#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const normalizePath = (path) => path.replaceAll('\\', '/').replace(/^\.\//, '');

const matchesAny = (path, patterns) => patterns.some((pattern) => pattern.test(path));

const DOCUMENTATION_PATTERNS = [
  /^docs\//,
  /^[^/]+\.md$/i,
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/PULL_REQUEST_TEMPLATE(?:\/|\.md$)/,
  /^(?:LICENSE|CODE_OF_CONDUCT|SECURITY)(?:\.|$)/i,
];

const FRONTEND_PATTERNS = [
  /^src\//,
  /^public\//,
  /^vite\.config(?:\.[^/]+)?$/,
  /^tsconfig(?:\.[^/]+)?\.json$/,
  /^(?:eslint|postcss|tailwind)\.config(?:\.[^/]+)?$/,
  /^dev\/i18n\//,
];

const NATIVE_PATTERNS = [
  /^src-tauri\//,
  /^copilot-bridge\//,
  /^dev\/(?:build-ai-runtime|tauri-cli|verify-macos-bundle)\.mjs$/,
  /^(?:Cargo\.toml|Cargo\.lock|rust-toolchain\.toml)$/,
];

const CONFIG_PATTERNS = [
  /^\.github\/workflows\//,
  /^(?:package\.json|bun\.lock|Cargo\.toml|Cargo\.lock|rust-toolchain\.toml)$/,
  /^dev\//,
  /^scripts\//,
  /^(?:vite|eslint|postcss|tailwind)\.config(?:\.[^/]+)?$/,
  /^tsconfig(?:\.[^/]+)?\.json$/,
];

export function classifyPaths(inputPaths) {
  const paths = [...new Set(inputPaths.map(normalizePath).filter(Boolean))];
  const documentationOnly = paths.length > 0 && paths.every((path) => matchesAny(path, DOCUMENTATION_PATTERNS));
  const frontend = paths.some((path) => matchesAny(path, FRONTEND_PATTERNS));
  const native = paths.some((path) => matchesAny(path, NATIVE_PATTERNS));
  const explicitlyConfigured = paths.some((path) => matchesAny(path, CONFIG_PATTERNS));
  const hasUnknownPath = paths.length === 0 || paths.some((path) => !matchesAny(path, [
    ...DOCUMENTATION_PATTERNS,
    ...FRONTEND_PATTERNS,
    ...NATIVE_PATTERNS,
    ...CONFIG_PATTERNS,
  ]));
  const configuration = explicitlyConfigured || hasUnknownPath;

  return {
    documentation_only: documentationOnly,
    frontend,
    native,
    configuration,
    linux: !documentationOnly && (frontend || native || configuration),
    windows: !documentationOnly && (native || configuration),
  };
}

export function parseNameStatus(output) {
  const fields = output.split('\0').filter(Boolean);
  const paths = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (/^[RC]/.test(status)) {
      paths.push(fields[index++], fields[index++]);
    } else {
      paths.push(fields[index++]);
    }
  }

  return paths.filter(Boolean);
}

export function buildDiffArgs(base, head, mode = 'direct') {
  if (!['direct', 'merge-base'].includes(mode)) {
    throw new Error(`Unsupported diff mode "${mode}".`);
  }

  const emptyBase = /^0+$/.test(base);
  if (emptyBase) {
    return null;
  }

  return mode === 'merge-base'
    ? ['diff', '--name-status', '-z', '--find-renames', `${base}...${head}`]
    : ['diff', '--name-status', '-z', '--find-renames', base, head];
}

export function changedPaths(base, head, mode, options = {}) {
  const args = buildDiffArgs(base, head, mode);
  // An all-zero base means a newly created ref. Classify it conservatively by
  // returning no paths, which maps to configuration=true and runs every check.
  if (!args) {
    return [];
  }
  return parseNameStatus(execFileSync('git', args, {
    encoding: 'utf8',
    env: options.env,
  }));
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const base = argumentValue('--base');
  const head = argumentValue('--head');
  const mode = argumentValue('--mode') || 'direct';
  const outputPath = argumentValue('--github-output');
  if (!base || !head) {
    throw new Error('Usage: classify-changes.mjs --base <sha> --head <sha> [--mode direct|merge-base] [--github-output <path>]');
  }

  const paths = changedPaths(base, head, mode);
  const classification = classifyPaths(paths);
  const output = Object.entries(classification)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  console.log(`Changed paths (${paths.length}):`);
  paths.forEach((path) => console.log(`- ${path}`));
  console.log(output);

  if (outputPath) {
    appendFileSync(outputPath, `${output}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
