#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function probe(command, args = []) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return {
    command: [command, ...args].join(' '),
    ok: result.status === 0,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n')[0] || null,
  };
}

export function declaredRustChannel(contents) {
  return contents.match(/^channel\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

export function requiredRustTargets(platform, architecture) {
  if (platform === 'darwin') return ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
  if (platform === 'win32') {
    return [architecture === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'];
  }
  if (platform === 'linux') {
    return [architecture === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'];
  }
  return [];
}

export function evaluateToolchainDiagnostic(input) {
  const missingTargets = input.requiredTargets.filter((target) => !input.installedTargets.includes(target));
  const failedProbes = input.probes.filter((entry) => !entry.ok).map((entry) => entry.command);
  const versionMatches = Boolean(
    input.declaredChannel && input.rustcVersion.includes(`rustc ${input.declaredChannel}`),
  );
  return {
    ok: versionMatches && missingTargets.length === 0 && failedProbes.length === 0,
    declaredRustChannel: input.declaredChannel,
    resolvedRustc: input.rustcVersion.split('\n')[0] || null,
    resolvedCargo: input.cargoVersion.split('\n')[0] || null,
    requiredTargets: input.requiredTargets,
    installedTargets: input.installedTargets,
    missingTargets,
    failedProbes,
    probes: input.probes,
  };
}

export function collectToolchainDiagnostic(platform = process.platform, architecture = process.arch) {
  const declaredChannel = declaredRustChannel(readFileSync('rust-toolchain.toml', 'utf8'));
  const rustc = probe('rustc', ['--version', '--verbose']);
  const cargo = probe('cargo', ['--version']);
  const targets = probe('rustup', ['target', 'list', '--installed']);
  const probes = [probe('bun', ['--version']), probe('git', ['--version']), rustc, cargo, targets];
  if (platform === 'darwin') {
    probes.push(probe('xcode-select', ['-p']), probe('xcrun', ['--find', 'lipo']));
  } else if (platform === 'linux') {
    probes.push(
      probe('pkg-config', ['--exists', 'gtk+-3.0']),
      probe('pkg-config', ['--exists', 'webkit2gtk-4.1']),
      probe('dpkg-deb', ['--version']),
      probe('rpmbuild', ['--version']),
    );
  } else if (platform === 'win32') {
    probes.push(probe('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']));
  }
  return evaluateToolchainDiagnostic({
    declaredChannel,
    rustcVersion: `${rustc.output || ''}\n${rustc.ok ? '' : 'unavailable'}`,
    cargoVersion: cargo.output || 'unavailable',
    installedTargets: targets.ok
      ? spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8', windowsHide: true })
        .stdout.trim().split(/\s+/).filter(Boolean)
      : [],
    requiredTargets: requiredRustTargets(platform, architecture),
    probes,
  });
}

function main() {
  const diagnostic = collectToolchainDiagnostic();
  console.log(JSON.stringify(diagnostic, null, 2));
  if (!diagnostic.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
