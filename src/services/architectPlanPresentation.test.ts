import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_NEW_PLAN_LABEL,
  getDefaultNewPlanLabelNumber,
  getNextDefaultNewPlanLabel,
  getArchitectPlanConversationTitle,
  getArchitectPlanDisplayName,
  getArchitectPlanEditableName,
  getArchitectPlanLifecyclePhase,
  getArchitectPlanPrimaryName,
  getArchitectPlanSecondaryLabel,
  isDefaultNewPlanBaseLabel,
  isDefaultNewPlanFamilyLabel,
  isCanonicalArchitectPlan,
} from './architectPlanPresentation';

describe('architectPlanPresentation', () => {
  it('uses llm-name-first presentation for canonical plans', () => {
    const plan = {
      id: '1710000000000',
      slug: '1710000000000',
      title: '1710000000000',
      label: 'Checkout refresh',
    };

    expect(isCanonicalArchitectPlan(plan)).toBe(true);
    expect(getArchitectPlanPrimaryName(plan)).toBe('Checkout refresh');
    expect(getArchitectPlanSecondaryLabel(plan)).toBe('1710000000000');
    expect(getArchitectPlanDisplayName(plan)).toBe('Checkout refresh - 1710000000000');
    expect(getArchitectPlanEditableName(plan)).toBe('Checkout refresh');
    expect(getArchitectPlanConversationTitle(plan)).toBe('Plan - Checkout refresh - 1710000000000');
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
    expect(getNextDefaultNewPlanLabel([])).toBe('new plan');
    expect(getNextDefaultNewPlanLabel([{ label: 'new plan' }])).toBe('new plan 2');
  });

  it('derives compact lifecycle phases without using conversation id alone', () => {
    expect(
      getArchitectPlanLifecyclePhase({
        status: 'draft',
        conversationId: 'empty-conversation',
        nodeCount: 0,
        predictedBranchCount: 0,
        chatMessageCount: 0,
      })
    ).toBe('blank');
    expect(
      getArchitectPlanLifecyclePhase({
        status: 'draft',
        nodeCount: 0,
        predictedBranchCount: 0,
        chatMessageCount: 1,
      })
    ).toBe('editing');
    expect(getArchitectPlanLifecyclePhase({ status: 'validated' })).toBe('validated');
    expect(getArchitectPlanLifecyclePhase({ status: 'in_progress' })).toBe('in_progress');
    expect(getArchitectPlanLifecyclePhase({ status: 'completed' })).toBe('completed');
    expect(getArchitectPlanLifecyclePhase({ status: 'archived' })).toBe('archived');
    expect(getArchitectPlanLifecyclePhase({ status: 'deleted' })).toBe('deleted');
  });
});
