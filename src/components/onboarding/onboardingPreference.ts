export const ONBOARDING_VERSION = 1;

export interface OnboardingPreferenceState {
  version: number;
  completedAt: string | null;
  dismissedAt: string | null;
  lastStepId: string | null;
}

export const hasFinishedCurrentOnboarding = (
  state: OnboardingPreferenceState | null | undefined,
): boolean =>
  state?.version === ONBOARDING_VERSION &&
  Boolean(state.completedAt || state.dismissedAt);
