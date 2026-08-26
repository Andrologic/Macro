import { describe, expect, test } from 'bun:test';
import { validateWorkflowDocument, validateWorkflows } from './validate-workflows.mjs';

describe('GitHub workflow validation', () => {
  test('current workflows satisfy repository policy', () => {
    expect(validateWorkflows()).toEqual([]);
  });

  test('rejects unpinned actions and missing timeouts', () => {
    const errors = validateWorkflowDocument({
      name: 'Unsafe',
      on: { push: { branches: ['develop'] } },
      permissions: { contents: 'read' },
      jobs: {
        validate: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: 'actions/checkout@v4' }],
        },
      },
    }, '.github/workflows/unsafe.yml');

    expect(errors.some((error) => error.includes('timeout-minutes'))).toBe(true);
    expect(errors.some((error) => error.includes('full commit SHA'))).toBe(true);
  });

  test('rejects pull_request_target', () => {
    const errors = validateWorkflowDocument({
      name: 'Unsafe',
      on: { pull_request_target: {} },
      permissions: { contents: 'read' },
      jobs: {},
    }, '.github/workflows/unsafe.yml');

    expect(errors.some((error) => error.includes('pull_request_target'))).toBe(true);
  });

  test('requires release validation to fetch the annotated tag object', () => {
    const errors = validateWorkflowDocument({
      name: 'Release',
      on: { push: { tags: ['v*'] } },
      permissions: { contents: 'read' },
      jobs: {
        validate: {
          'runs-on': 'ubuntu-latest',
          'timeout-minutes': 10,
          steps: [
            {
              run: 'git fetch --force --no-tags origin "refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"',
            },
            {
              uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
              with: { 'persist-credentials': false },
            },
          ],
        },
        build: {
          needs: 'validate',
          environment: 'release',
        },
      },
    }, '.github/workflows/release.yml');

    expect(errors.some((error) => error.includes('annotated tag object'))).toBe(true);
  });

  test('requires release finalization to check out scripts and install Bun', () => {
    const errors = validateWorkflowDocument({
      name: 'Release',
      on: { push: { tags: ['v*'] } },
      permissions: { contents: 'read' },
      jobs: {
        validate: {
          steps: [
            {
              uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
              with: { 'persist-credentials': false },
            },
            {
              run: 'git fetch --force --no-tags origin "refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"',
            },
          ],
        },
        build: {
          needs: 'validate',
          environment: 'release',
        },
        'draft-release': {
          steps: [{ run: 'bun dev/release/updater-manifest.mjs' }],
        },
      },
    }, '.github/workflows/release.yml');

    expect(errors.some((error) => error.includes('release finalization'))).toBe(true);
  });

  test('requires diagnosable Linux bundles and a stapled macOS disk image', () => {
    const errors = validateWorkflowDocument({
      name: 'Preview',
      on: { workflow_dispatch: {} },
      permissions: { contents: 'read' },
      jobs: {
        build: {
          'runs-on': '${{ matrix.runner }}',
          'timeout-minutes': 90,
          strategy: {
            matrix: {
              include: [{ key: 'linux', args: '--bundles appimage,deb,rpm' }],
            },
          },
          steps: [
            { name: 'Build preview bundles', env: {} },
            {
              name: 'Verify macOS bundle and notarization',
              run: 'xcrun stapler validate "$DMG_PATH"',
            },
          ],
        },
      },
    }, '.github/workflows/preview.yml');

    expect(errors.some((error) => error.includes('verbose Tauri output'))).toBe(true);
    expect(errors.some((error) => error.includes('disable linuxdeploy stripping'))).toBe(true);
    expect(errors.some((error) => error.includes('notarize, staple, and then validate'))).toBe(true);
  });
});
