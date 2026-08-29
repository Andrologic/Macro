import { describe, expect, test } from 'bun:test';
import { findReusableRun, hasSuccessfulJobStep, selectReusableRun } from './find-reusable-ci.mjs';

const expected = {
  branch: 'main',
  event: 'push',
  repository: 'Andrologic/Macro',
  sha: 'a'.repeat(40),
  token: 'test-token',
  workflow: 'ci.yml',
};

describe('reusable CI lookup', () => {
  test('accepts only a completed successful run for the exact branch, event, and SHA', () => {
    const reusable = selectReusableRun([
      { ...expected, head_branch: 'main', head_sha: expected.sha, status: 'completed', conclusion: 'failure' },
      { ...expected, head_branch: 'develop', head_sha: expected.sha, status: 'completed', conclusion: 'success' },
      { ...expected, head_branch: 'main', head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'success' },
      {
        event: 'push',
        head_branch: 'main',
        head_sha: expected.sha,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/Andrologic/Macro/actions/runs/1',
      },
    ], expected);

    expect(reusable?.html_url).toBe('https://github.com/Andrologic/Macro/actions/runs/1');
  });

  test('queries the selected workflow with restrictive filters', async () => {
    let requestedUrl = '';
    const request = async (url: string | URL) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
    };

    expect(await findReusableRun(expected, request as typeof fetch)).toBeUndefined();
    const url = new URL(requestedUrl);
    expect(url.pathname).toEndWith('/actions/workflows/ci.yml/runs');
    expect(url.searchParams.get('branch')).toBe('main');
    expect(url.searchParams.get('event')).toBe('push');
    expect(url.searchParams.get('head_sha')).toBe(expected.sha);
    expect(url.searchParams.get('status')).toBe('success');
  });

  test('rejects an unsuccessful GitHub response', async () => {
    const request = async () => new Response('', { status: 403 });
    await expect(findReusableRun(expected, request as typeof fetch)).rejects.toThrow('HTTP 403');
  });

  test('requires the selected job and step to have completed successfully', () => {
    const jobs = [{
      name: 'Linux validation',
      status: 'completed',
      conclusion: 'success',
      steps: [
        { name: 'Run conservative validation profile', status: 'completed', conclusion: 'skipped' },
        { name: 'Run shared frontend validation profile', status: 'completed', conclusion: 'success' },
      ],
    }];

    expect(hasSuccessfulJobStep(jobs, 'Linux validation', 'Run conservative validation profile')).toBe(false);
    expect(hasSuccessfulJobStep(jobs, 'Linux validation', 'Run shared frontend validation profile')).toBe(true);
    expect(hasSuccessfulJobStep(jobs, 'Windows native check', undefined)).toBe(false);
  });

  test('does not reuse a green workflow when the required full-validation step was skipped', async () => {
    const candidate = {
      event: 'push',
      head_branch: 'main',
      head_sha: expected.sha,
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/Andrologic/Macro/actions/runs/1',
      jobs_url: 'https://api.github.com/repos/Andrologic/Macro/actions/runs/1/jobs',
    };
    const request = async (url: string | URL) => {
      if (String(url).includes('/jobs?')) {
        return new Response(JSON.stringify({
          jobs: [{
            name: 'Linux validation',
            status: 'completed',
            conclusion: 'success',
            steps: [{
              name: 'Run conservative validation profile',
              status: 'completed',
              conclusion: 'skipped',
            }],
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ workflow_runs: [candidate] }), { status: 200 });
    };

    const reusable = await findReusableRun({
      ...expected,
      requiredJob: 'Linux validation',
      requiredStep: 'Run conservative validation profile',
    }, request as typeof fetch);
    expect(reusable).toBeUndefined();
  });

  test('reuses a green workflow after verifying the required full-validation step', async () => {
    const candidate = {
      event: 'push',
      head_branch: 'main',
      head_sha: expected.sha,
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/Andrologic/Macro/actions/runs/2',
      jobs_url: 'https://api.github.com/repos/Andrologic/Macro/actions/runs/2/jobs',
    };
    const request = async (url: string | URL) => new Response(JSON.stringify(
      String(url).includes('/jobs?')
        ? {
            jobs: [{
              name: 'Linux validation',
              status: 'completed',
              conclusion: 'success',
              steps: [{
                name: 'Run conservative validation profile',
                status: 'completed',
                conclusion: 'success',
              }],
            }],
          }
        : { workflow_runs: [candidate] },
    ), { status: 200 });

    const reusable = await findReusableRun({
      ...expected,
      requiredJob: 'Linux validation',
      requiredStep: 'Run conservative validation profile',
    }, request as typeof fetch);
    expect(reusable?.html_url).toBe(candidate.html_url);
  });
});
