#!/usr/bin/env bun
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  normalizeMacroExtensionPackagePath,
  parseMacroExtensionManifest,
  validateMacroExtensionManifest,
} from '../src/manifest';

const args = process.argv.slice(2);
const manifestArg = args.find((arg) => !arg.startsWith('--'));
const sourceFlagIndex = args.indexOf('--source');
const sourceRoot = sourceFlagIndex >= 0 ? args[sourceFlagIndex + 1] : null;

if (!manifestArg) {
  console.error('Usage: validate-manifest.ts <macro.extension.json> [--source <package-root>]');
  process.exit(2);
}

const manifestPath = resolve(process.cwd(), manifestArg);
const manifest = parseMacroExtensionManifest(await readFile(manifestPath, 'utf8'));
const validation = validateMacroExtensionManifest(manifest);

if (sourceRoot && typeof manifest.main === 'string') {
  const packageRoot = resolve(process.cwd(), sourceRoot);
  const normalizedMain = normalizeMacroExtensionPackagePath(manifest.main);
  const candidates = [
    resolve(process.cwd(), normalizedMain),
    join(packageRoot, normalizedMain),
    join(packageRoot, normalizedMain.replace(/^dist\//, '')),
  ];
  const exists = await Promise.any(candidates.map((candidate) => access(candidate).then(() => true))).catch(
    () => false,
  );
  if (!exists) {
    validation.errors.push(`Manifest main points to a missing file under source root: ${manifest.main}`);
    validation.valid = false;
  }
}

if (!validation.valid) {
  console.error(`Invalid Macro extension manifest:\n${validation.errors.join('\n')}`);
  process.exit(1);
}

console.log(`Valid Macro extension manifest: ${manifest.id}@${manifest.version}`);
