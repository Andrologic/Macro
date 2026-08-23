import { describe, expect, it } from 'bun:test';
import {
  hasFinishedCurrentOnboarding,
  ONBOARDING_VERSION,
} from './onboardingPreference';

describe('onboarding preference', () => {
  it('accepts completion or dismissal for the current onboarding version', () => {
    expect(
      hasFinishedCurrentOnboarding({
        version: ONBOARDING_VERSION,
        completedAt: '2026-08-19T00:00:00.000Z',
        dismissedAt: null,
        lastStepId: 'finish',
      }),
    ).toBe(true);
    expect(
      hasFinishedCurrentOnboarding({
        version: ONBOARDING_VERSION,
        completedAt: null,
        dismissedAt: '2026-08-19T00:00:00.000Z',
        lastStepId: 'welcome',
      }),
    ).toBe(true);
  });

  it('rejects incomplete and obsolete onboarding state', () => {
    expect(hasFinishedCurrentOnboarding(null)).toBe(false);
    expect(
      hasFinishedCurrentOnboarding({
        version: ONBOARDING_VERSION,
        completedAt: null,
        dismissedAt: null,
        lastStepId: null,
      }),
    ).toBe(false);
    expect(
      hasFinishedCurrentOnboarding({
        version: ONBOARDING_VERSION - 1,
        completedAt: '2026-08-19T00:00:00.000Z',
        dismissedAt: null,
        lastStepId: 'finish',
      }),
    ).toBe(false);
  });
});
