import { afterEach, describe, expect, it } from 'bun:test';
import i18n from '../i18n';
import en from '../i18n/locales/en.json';
import fr from '../i18n/locales/fr.json';

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

i18n.addResourceBundle('en', 'translation', en, true, true);
i18n.addResourceBundle('fr', 'translation', fr, true, true);
afterEach(async () => { await i18n.changeLanguage('en'); });

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
    expect(getArchitectPlanPrimaryName(plan)).toBe('New plan 2');
    expect(getArchitectPlanSecondaryLabel(plan)).toBeNull();
    expect(getArchitectPlanDisplayName(plan)).toBe('New plan 2');
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

  it('localizes only provisional display names and preserves editable values and stored titles', async () => {
    const plan = { id: '123', title: '123', slug: '123', label: 'new plan 2' };
    await i18n.changeLanguage('fr');
    expect(getArchitectPlanPrimaryName(plan)).toBe('Nouveau plan 2');
    expect(getArchitectPlanDisplayName(plan)).toBe('Nouveau plan 2');
    expect(getArchitectPlanDisplayName({ ...plan, label: 'new plan' })).toBe('Nouveau plan');
    expect(getArchitectPlanEditableName(plan)).toBe('new plan 2');
    expect(getArchitectPlanConversationTitle(plan)).toBe('Plan - new plan 2');
    expect(getNextDefaultNewPlanLabel([plan])).toBe('new plan 3');
    expect(getArchitectPlanDisplayName({ ...plan, label: 'Mon titre manuel' })).toBe('Mon titre manuel - 123');
    expect(getArchitectPlanDisplayName({ ...plan, title: 'new plan 2' })).toBe('new plan 2');
    expect(plan).toEqual({ id: '123', title: '123', slug: '123', label: 'new plan 2' });
    await i18n.changeLanguage('en');
    expect(getArchitectPlanDisplayName(plan)).toBe('New plan 2');
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
