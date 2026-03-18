import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_NEW_PLAN_LABEL,
  getDefaultNewPlanLabelNumber,
  getNextDefaultNewPlanLabel,
  getArchitectPlanConversationTitle,
  getArchitectPlanDisplayName,
  getArchitectPlanEditableName,
  getArchitectPlanPrimaryName,
  getArchitectPlanSecondaryLabel,
  isDefaultNewPlanBaseLabel,
  isDefaultNewPlanFamilyLabel,
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

  it('uses the placeholder name directly for default new-plan drafts', () => {
    const plan = {
      id: '1710000000001',
      slug: '1710000000001',
      title: '1710000000001',
      label: 'new plan 2',
    };

    expect(isCanonicalArchitectPlan(plan)).toBe(true);
    expect(isDefaultNewPlanFamilyLabel(plan.label)).toBe(true);
    expect(isDefaultNewPlanBaseLabel(DEFAULT_NEW_PLAN_LABEL)).toBe(true);
    expect(getDefaultNewPlanLabelNumber('new plan')).toBe(0);
    expect(getDefaultNewPlanLabelNumber('new plan 2')).toBe(2);
    expect(getArchitectPlanPrimaryName(plan)).toBe('new plan 2');
    expect(getArchitectPlanSecondaryLabel(plan)).toBeNull();
    expect(getArchitectPlanDisplayName(plan)).toBe('new plan 2');
    expect(getArchitectPlanConversationTitle(plan)).toBe('Plan - new plan 2');
    expect(
      getNextDefaultNewPlanLabel([
        { label: 'new plan' },
        { label: 'new plan 2' },
        { label: 'something else' },
      ])
    ).toBe('new plan 3');
  });
});
