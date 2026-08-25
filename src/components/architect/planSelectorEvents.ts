export const ARCHITECT_PLAN_SELECTOR_STATE_EVENT =
  'macro:architect-plan-selector-state';
export const ARCHITECT_PLAN_SELECTOR_STATE_REQUEST_EVENT =
  'macro:architect-plan-selector-state-request';
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
  anchorRect?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
  };
};

export const dispatchArchitectPlanSelectorState = (
  detail: ArchitectPlanSelectorStateDetail,
): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ArchitectPlanSelectorStateDetail>(
      ARCHITECT_PLAN_SELECTOR_STATE_EVENT,
      { detail },
    ),
  );
};

export const requestArchitectPlanSelectorState = (): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(ARCHITECT_PLAN_SELECTOR_STATE_REQUEST_EVENT));
};

export const registerArchitectPlanSelectorStatePublisher = (
  detail: ArchitectPlanSelectorStateDetail,
): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const publishState = () => dispatchArchitectPlanSelectorState(detail);
  publishState();
  window.addEventListener(ARCHITECT_PLAN_SELECTOR_STATE_REQUEST_EVENT, publishState);
  return () => {
    window.removeEventListener(ARCHITECT_PLAN_SELECTOR_STATE_REQUEST_EVENT, publishState);
  };
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
