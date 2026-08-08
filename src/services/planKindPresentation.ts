import type { IconName } from '../components/ui/Icon';
import type { ArchitectPlanKind } from './architectPlanKinds';

export const planKindIconName: Record<ArchitectPlanKind, IconName> = {
  feature: 'sparkles',
  release: 'flag',
  hotfix: 'zap',
  bugfix: 'tool',
};

export const getPlanKindIconName = (planKind: ArchitectPlanKind = 'feature'): IconName =>
  planKindIconName[planKind] ?? planKindIconName.feature;
