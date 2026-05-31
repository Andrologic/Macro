export const ARCHITECT_PLAN_SELECTOR_STATE_EVENT =
  'macro:architect-plan-selector-state';
export const ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT =
  'macro:architect-plan-selector-request';

export type ArchitectPlanSelectorStateDetail = {
  status: 'loading' | 'ready' | 'error';
  planCount: number;
  canCreate: boolean;
  canSelect: boolean;
};

export type ArchitectPlanSelectorRequestDetail = {
  action: 'primary';
};

export const dispatchArchitectPlanSelectorRequest = (
  detail: ArchitectPlanSelectorRequestDetail,
): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ArchitectPlanSelectorRequestDetail>(
      ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT,
      { detail },
    ),
  );
};
