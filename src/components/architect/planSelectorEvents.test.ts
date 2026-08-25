import { describe, expect, it } from 'bun:test';
import {
  ARCHITECT_PLAN_SELECTOR_STATE_EVENT,
  registerArchitectPlanSelectorStatePublisher,
  requestArchitectPlanSelectorState,
  type ArchitectPlanSelectorStateDetail,
} from './planSelectorEvents';

describe('planSelectorEvents', () => {
  it('replays the current selector state when a consumer mounts after the initial publication', () => {
    const detail: ArchitectPlanSelectorStateDetail = {
      status: 'ready',
      planCount: 0,
      canCreate: true,
      canSelect: false,
    };
    const received: ArchitectPlanSelectorStateDetail[] = [];
    const handleState = (event: Event) => {
      received.push((event as CustomEvent<ArchitectPlanSelectorStateDetail>).detail);
    };
    window.addEventListener(ARCHITECT_PLAN_SELECTOR_STATE_EVENT, handleState);
    const unregister = registerArchitectPlanSelectorStatePublisher(detail);

    try {
      expect(received).toEqual([detail]);
      received.length = 0;
      requestArchitectPlanSelectorState();
      expect(received).toEqual([detail]);

      unregister();
      received.length = 0;
      requestArchitectPlanSelectorState();
      expect(received).toEqual([]);
    } finally {
      unregister();
      window.removeEventListener(ARCHITECT_PLAN_SELECTOR_STATE_EVENT, handleState);
    }
  });
});
