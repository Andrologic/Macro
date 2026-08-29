#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function selectReusableRun(runs, expected) {
  if (!Array.isArray(runs)) {
    return undefined;
  }

  return runs.find((run) => (
    run?.head_sha === expected.sha
    && run?.head_branch === expected.branch
    && run?.event === expected.event
    && run?.status === 'completed'
    && run?.conclusion === 'success'
  ));
}

export function hasSuccessfulJobStep(jobs, requiredJob, requiredStep) {
  if (!Array.isArray(jobs)) {
    return false;
  }

  const job = jobs.find((candidate) => (
    candidate?.name === requiredJob
    && candidate?.status === 'completed'
    && candidate?.conclusion === 'success'
  ));
  if (!job) {
    return false;
  }
  if (!requiredStep) {
    return true;
  }

  return Array.isArray(job.steps) && job.steps.some((step) => (
    step?.name === requiredStep
    && step?.status === 'completed'
    && step?.conclusion === 'success'
  ));
}

async function requestJson(url, options, request) {
  const response = await request(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${options.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status}.`);
  }

  return response.json();
}

export async function findReusableRun(options, request = fetch) {
  const workflow = encodeURIComponent(options.workflow);
  const query = new URLSearchParams({
    branch: options.branch,
    event: options.event,
    head_sha: options.sha,
    per_page: '10',
    status: 'success',
  });
  const payload = await requestJson(
    `https://api.github.com/repos/${options.repository}/actions/workflows/${workflow}/runs?${query}`,
    options,
    request,
  );
  const candidates = Array.isArray(payload.workflow_runs)
    ? payload.workflow_runs.filter((run) => selectReusableRun([run], options))
    : [];
  if (!options.requiredJob) {
    return candidates[0];
  }

  for (const candidate of candidates) {
    if (!candidate.jobs_url) {
      continue;
    }
    const separator = candidate.jobs_url.includes('?') ? '&' : '?';
    const jobsPayload = await requestJson(
      `${candidate.jobs_url}${separator}filter=latest&per_page=100`,
      options,
      request,
    );
    if (hasSuccessfulJobStep(jobsPayload.jobs, options.requiredJob, options.requiredStep)) {
      return candidate;
    }
  }

  return undefined;
}

function appendOutput(file, name, value) {
  appendFileSync(file, `${name}=${value}\n`, 'utf8');
}

async function main() {
  const outputFile = argumentValue('--github-output') || process.env.GITHUB_OUTPUT;
  const options = {
    branch: argumentValue('--branch'),
    event: argumentValue('--event') || 'push',
    repository: process.env.GITHUB_REPOSITORY,
    requiredJob: argumentValue('--required-job'),
    requiredStep: argumentValue('--required-step'),
    sha: argumentValue('--sha'),
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    workflow: argumentValue('--workflow') || 'ci.yml',
  };

  if (!outputFile) {
    throw new Error('GITHUB_OUTPUT or --github-output is required.');
  }

  let reusableRun;
  try {
    if (!options.repository || !options.token || !options.branch || !/^[0-9a-f]{40}$/i.test(options.sha || '')) {
      throw new Error('Repository, token, branch, and a full commit SHA are required.');
    }
    reusableRun = await findReusableRun(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`::warning::Unable to reuse an earlier CI result. Full validation will run. ${message}`);
  }

  appendOutput(outputFile, 'reusable', reusableRun ? 'true' : 'false');
  if (reusableRun?.html_url) {
    appendOutput(outputFile, 'run_url', reusableRun.html_url);
    console.log(`Reusing successful CI run ${reusableRun.html_url} for ${options.sha}.`);
  } else {
    console.log(`No reusable ${options.workflow} result found for ${options.sha || 'the requested commit'}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
