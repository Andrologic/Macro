#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CHECK_PROFILES, stepsForProfile } from './check-profiles.mjs';
import { formatDuration } from '../format-duration.mjs';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function displayCommand(command, args) {
  return [command, ...args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

export function runProfile(profile, options = {}) {
  const steps = stepsForProfile(profile, options);
  const environment = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'Macro Local CI',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'macro-local-ci@example.invalid',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'Macro Local CI',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'macro-local-ci@example.invalid',
  };

  console.log(`Running local CI profile: ${profile}`);
  const profileStartedAt = Date.now();
  for (const check of steps) {
    const githubGroup = process.env.GITHUB_ACTIONS === 'true';
    console.log(githubGroup ? `::group::${check.name}` : `\n==> ${check.name}`);
    console.log(displayCommand(check.command, check.args));

    const stepStartedAt = Date.now();
    const result = spawnSync(check.command, check.args, {
      cwd: options.cwd || process.cwd(),
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
    });
    const stepDuration = formatDuration(Date.now() - stepStartedAt);

    if (githubGroup) {
      console.log('::endgroup::');
    }
    console.log(`<== ${check.name} (${stepDuration})`);
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`${check.name} failed with exit code ${result.status ?? 'unknown'} after ${stepDuration}.`);
    }
  }
  console.log(`\nLocal CI profile "${profile}" passed in ${formatDuration(Date.now() - profileStartedAt)}.`);
}

function main() {
  const profile = argumentValue('--profile') || 'full';
  if (!CHECK_PROFILES.includes(profile)) {
    throw new Error(`Usage: run-checks.mjs --profile <${CHECK_PROFILES.join('|')}> [--skip-install]`);
  }
  runProfile(profile, { skipInstall: hasFlag('--skip-install') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
