#!/usr/bin/env bun

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const PINNED_ACTION = /^[^@\s]+@[0-9a-f]{40}$/i;

const entries = (value) => value && typeof value === 'object' ? Object.entries(value) : [];

function workflowFiles(root) {
  const directory = join(root, '.github', 'workflows');
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
}

export function validateWorkflowDocument(document, filePath) {
  const errors = [];
  const fail = (message) => errors.push(`${filePath}: ${message}`);

  if (!document || typeof document !== 'object') {
    return [`${filePath}: workflow must be a YAML object.`];
  }
  if (typeof document.name !== 'string' || !document.name.trim()) {
    fail('workflow must have a non-empty name.');
  }
  if (!document.on || typeof document.on !== 'object') {
    fail('workflow must declare structured triggers under "on".');
  }
  if (document.on?.pull_request_target) {
    fail('pull_request_target is forbidden because it can expose privileged workflow context to untrusted changes.');
  }
  if (!document.permissions) {
    fail('workflow must declare explicit root permissions.');
  }
  if (!document.jobs || typeof document.jobs !== 'object') {
    fail('workflow must declare jobs.');
    return errors;
  }

  for (const [jobName, job] of entries(document.jobs)) {
    if (!job || typeof job !== 'object') {
      fail(`job "${jobName}" must be an object.`);
      continue;
    }
    if (job['runs-on'] && !job['timeout-minutes']) {
      fail(`job "${jobName}" must declare timeout-minutes.`);
    }

    for (const [permission, level] of entries(job.permissions)) {
      const allowedReleaseWrite = filePath.endsWith('release.yml')
        && jobName === 'draft-release'
        && permission === 'contents'
        && level === 'write';
      const allowedChannelWrite = filePath.endsWith('publish-update-channel.yml')
        && jobName === 'publish'
        && permission === 'contents'
        && level === 'write';
      const allowedPreviewWrite = filePath.endsWith('preview.yml')
        && jobName === 'publish'
        && permission === 'contents'
        && level === 'write';
      if (level === 'write' && !allowedReleaseWrite && !allowedChannelWrite && !allowedPreviewWrite) {
        fail(`job "${jobName}" requests unexpected ${permission}: write permission.`);
      }
    }

    for (const [index, workflowStep] of (job.steps || []).entries()) {
      if (!workflowStep?.uses) {
        continue;
      }
      const action = String(workflowStep.uses);
      if (action.startsWith('./') || action.startsWith('docker://')) {
        continue;
      }
      if (!PINNED_ACTION.test(action)) {
        fail(`job "${jobName}" step ${index + 1} must pin action "${action}" to a full commit SHA.`);
      }
      if (action.startsWith('actions/checkout@') && workflowStep.with?.['persist-credentials'] !== false) {
        fail(`job "${jobName}" checkout step must set persist-credentials: false.`);
      }
    }
  }

  if (filePath.endsWith('ci.yml')) {
    if (document.permissions?.contents !== 'read') {
      fail('ordinary CI must keep contents: read permissions.');
    }
    if (document.on?.push?.tags) {
      fail('ordinary CI must not run for tags.');
    }
  }

  if (filePath.endsWith('release.yml')) {
    const tags = document.on?.push?.tags;
    if (!Array.isArray(tags) || !tags.includes('v*')) {
      fail('release workflow must be triggered by v* tags.');
    }
    if (document.on?.pull_request || document.on?.workflow_dispatch) {
      fail('production release workflow must remain tag-only.');
    }
    if (document.jobs.build?.environment !== 'release') {
      fail('release build matrix must use the protected "release" environment.');
    }
    if (document.jobs.build?.needs !== 'validate') {
      fail('release build matrix must wait for the validation job.');
    }
    const validationSteps = document.jobs.validate?.steps || [];
    const checkoutIndex = validationSteps.findIndex((step) => (
      typeof step?.uses === 'string' && step.uses.startsWith('actions/checkout@')
    ));
    const annotatedTagFetchIndex = validationSteps.findIndex((step) => (
      typeof step?.run === 'string'
      && step.run.includes('git fetch --force --no-tags origin')
      && step.run.includes('refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}')
    ));
    if (checkoutIndex === -1 || annotatedTagFetchIndex <= checkoutIndex) {
      fail('release validation must explicitly fetch the annotated tag object after checkout.');
    }

    const finalizationSteps = document.jobs['draft-release']?.steps || [];
    const finalizationCheckoutIndex = finalizationSteps.findIndex((step) => (
      typeof step?.uses === 'string' && step.uses.startsWith('actions/checkout@')
    ));
    const finalizationBunIndex = finalizationSteps.findIndex((step) => (
      typeof step?.uses === 'string' && step.uses.startsWith('oven-sh/setup-bun@')
    ));
    const updaterManifestIndex = finalizationSteps.findIndex((step) => (
      typeof step?.run === 'string' && step.run.includes('dev/release/updater-manifest.mjs')
    ));
    if (
      finalizationCheckoutIndex === -1
      || finalizationBunIndex <= finalizationCheckoutIndex
      || updaterManifestIndex <= finalizationBunIndex
    ) {
      fail('release finalization must check out the tagged sources and set up Bun before generating the updater manifest.');
    }
  }

  if (filePath.endsWith('release.yml') || filePath.endsWith('preview.yml')) {
    const buildJob = document.jobs.build;
    const linuxBuild = buildJob?.strategy?.matrix?.include?.find((entry) => entry?.key === 'linux');
    if (typeof linuxBuild?.args !== 'string' || !linuxBuild.args.includes('--verbose')) {
      fail('Linux package builds must keep verbose Tauri output so linuxdeploy failures remain diagnosable.');
    }

    const bundleStep = buildJob?.steps?.find((step) => (
      step?.name === 'Build desktop bundles' || step?.name === 'Build preview bundles'
    ));
    if (bundleStep?.env?.NO_STRIP !== "${{ matrix.key == 'linux' && 'true' || '' }}") {
      fail('Linux package builds must disable linuxdeploy stripping for embedded sidecars.');
    }

    const macVerification = buildJob?.steps?.find((step) => step?.name === 'Verify macOS bundle and notarization');
    const macVerificationScript = typeof macVerification?.run === 'string' ? macVerification.run : '';
    const dmgSubmitIndex = macVerificationScript.indexOf('xcrun notarytool submit "$DMG_PATH"');
    const dmgStapleIndex = macVerificationScript.indexOf('xcrun stapler staple "$DMG_PATH"');
    const dmgValidateIndex = macVerificationScript.indexOf('xcrun stapler validate "$DMG_PATH"');
    if (dmgSubmitIndex === -1 || dmgStapleIndex <= dmgSubmitIndex || dmgValidateIndex <= dmgStapleIndex) {
      fail('macOS package verification must notarize, staple, and then validate the DMG.');
    }
  }

  return errors;
}

export function validateWorkflows(root = process.cwd()) {
  const errors = [];
  const files = workflowFiles(root);
  if (files.length === 0) {
    return ['No GitHub workflow files found.'];
  }

  for (const file of files) {
    const displayPath = relative(root, file).replaceAll('\\', '/');
    try {
      const document = parse(readFileSync(file, 'utf8'));
      errors.push(...validateWorkflowDocument(document, displayPath));
    } catch (error) {
      errors.push(`${displayPath}: invalid YAML: ${error instanceof Error ? error.message : error}`);
    }
  }
  return errors;
}

function main() {
  const errors = validateWorkflows();
  if (errors.length > 0) {
    console.error('GitHub workflow validation failed:');
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log('GitHub workflow validation passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
