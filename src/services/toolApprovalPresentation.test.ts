import { describe, expect, it } from 'bun:test';
import {
  getToolApprovalPresentation,
  getToolRiskLevelPresentation,
} from './toolApprovalPresentation';

const t = (_key: string, fallback: string) => fallback;

describe('toolApprovalPresentation', () => {
  it('maps risk levels to distinct icons', () => {
    expect(getToolRiskLevelPresentation('strict', t).riskIcon).toBe('lock');
    expect(getToolRiskLevelPresentation('balanced', t).riskIcon).toBe(
      'shield'
    );
    expect(getToolRiskLevelPresentation('yolo', t).riskIcon).toBe('zap');
  });

  it('maps destructive requests to the delete category', () => {
    expect(
      getToolApprovalPresentation(
        {
          toolId: 'apply_patch',
          riskLevel: 'balanced',
          isDestructive: true,
        },
        t
      ).category
    ).toBe('delete');
  });

  it('maps web requests to the web category', () => {
    expect(
      getToolApprovalPresentation(
        {
          toolId: 'web_fetch',
          riskLevel: 'balanced',
        },
        t
      ).category
    ).toBe('web');
  });

  it('maps terminal and git runtime requests to the system category', () => {
    expect(
      getToolApprovalPresentation(
        {
          toolId: 'terminal_run',
          riskLevel: 'balanced',
        },
        t
      ).category
    ).toBe('system');

    expect(
      getToolApprovalPresentation(
        {
          toolId: 'git_reset',
          riskLevel: 'balanced',
        },
        t
      ).category
    ).toBe('system');
  });

  it('falls back to modify for normal change approvals', () => {
    expect(
      getToolApprovalPresentation(
        {
          toolId: 'git_commit',
          riskLevel: 'strict',
        },
        t
      ).category
    ).toBe('modify');
  });
});
