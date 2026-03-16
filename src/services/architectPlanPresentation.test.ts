import { describe, expect, it } from 'bun:test';
import {
  getArchitectPlanConversationTitle,
  getArchitectPlanDisplayName,
  getArchitectPlanEditableName,
  getArchitectPlanPrimaryName,
  getArchitectPlanSecondaryLabel,
  isCanonicalArchitectPlan,
} from './architectPlanPresentation';

describe('architectPlanPresentation', () => {
  it('uses identifier-first presentation for canonical plans', () => {
    const plan = {
      id: '1710000000000',
      slug: '1710000000000',
      title: '1710000000000',
      label: 'Checkout refresh',
    };

    expect(isCanonicalArchitectPlan(plan)).toBe(true);
    expect(getArchitectPlanPrimaryName(plan)).toBe('1710000000000');
    expect(getArchitectPlanSecondaryLabel(plan)).toBe('Checkout refresh');
    expect(getArchitectPlanDisplayName(plan)).toBe('1710000000000 - Checkout refresh');
    expect(getArchitectPlanEditableName(plan)).toBe('Checkout refresh');
    expect(getArchitectPlanConversationTitle(plan)).toBe('Plan - 1710000000000 - Checkout refresh');
  });

  it('keeps legacy title-first presentation for legacy plans', () => {
    const plan = {
      id: 'legacy-plan',
      slug: 'checkout',
      title: 'Checkout',
      label: 'Ignored secondary label',
    };

    expect(isCanonicalArchitectPlan(plan)).toBe(false);
    expect(getArchitectPlanPrimaryName(plan)).toBe('Checkout');
    expect(getArchitectPlanSecondaryLabel(plan)).toBeNull();
    expect(getArchitectPlanDisplayName(plan)).toBe('Checkout');
    expect(getArchitectPlanEditableName(plan)).toBe('Checkout');
    expect(getArchitectPlanConversationTitle(plan)).toBe('Plan - Checkout');
  });
});
