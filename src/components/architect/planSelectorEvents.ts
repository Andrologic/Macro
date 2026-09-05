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

const SELECTOR_REQUEST_MAX_AGE_MS = 5_000;

let pendingSelectorRequest: {
  detail: ArchitectPlanSelectorRequestDetail;
  expiresAt: number;
} | null = null;

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
  pendingSelectorRequest = {
    detail,
    expiresAt: Date.now() + SELECTOR_REQUEST_MAX_AGE_MS,
  };
  const wasHandled = !window.dispatchEvent(
    new CustomEvent<ArchitectPlanSelectorRequestDetail>(
      ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT,
      { detail, cancelable: true },
    ),
  );
  if (wasHandled) {
    pendingSelectorRequest = null;
  }
};

export const registerArchitectPlanSelectorRequestHandler = (
  handler: (detail: ArchitectPlanSelectorRequestDetail) => void,
): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const handleRequest = (event: Event) => {
    if (event.defaultPrevented) return;
    const detail = (event as CustomEvent<ArchitectPlanSelectorRequestDetail>).detail;
    if (!detail) return;
    event.preventDefault();
    pendingSelectorRequest = null;
    handler(detail);
  };
  window.addEventListener(ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT, handleRequest);
  if (pendingSelectorRequest && pendingSelectorRequest.expiresAt >= Date.now()) {
    const { detail } = pendingSelectorRequest;
    pendingSelectorRequest = null;
    handler(detail);
  } else {
    pendingSelectorRequest = null;
  }
  return () => window.removeEventListener(ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT, handleRequest);
};
