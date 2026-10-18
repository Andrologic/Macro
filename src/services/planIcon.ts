import type { IconName } from '../components/ui/Icon';
import { getArchitectPlanKind, type ArchitectPlanKindRef } from './architectPlanKinds';
import { getPlanKindIconName } from './planKindPresentation';

export const PLAN_ICONS = ['sparkles', 'workflow', 'network', 'layers', 'pencil-ruler', 'code', 'terminal', 'flag', 'target', 'zap', 'shield', 'tool', 'cpu', 'database', 'globe', 'cloud', 'message-square', 'book-open'] as const satisfies readonly IconName[];
export type PlanIcon = typeof PLAN_ICONS[number];
export const normalizePlanIcon = (value: unknown): PlanIcon | undefined =>
  typeof value === 'string' && (PLAN_ICONS as readonly string[]).includes(value) ? value as PlanIcon : undefined;
export const getPlanIcon = (plan: ArchitectPlanKindRef & { icon?: string }): IconName =>
  normalizePlanIcon(plan.icon) ?? getPlanKindIconName(getArchitectPlanKind(plan));
