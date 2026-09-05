import { describe, expect, it } from 'bun:test';
import {
  ARCHITECT_PLAN_SELECTOR_STATE_EVENT,
  dispatchArchitectPlanSelectorRequest,
  registerArchitectPlanSelectorStatePublisher,
  registerArchitectPlanSelectorRequestHandler,
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

  it('replays a primary request when the selector mounts after the panel opens', () => {
    const detail = {
      action: 'primary' as const,
      anchorRect: {
        top: 10,
        right: 30,
        bottom: 20,
        left: 0,
        width: 30,
        height: 10,
      },
    };
    const received: typeof detail[] = [];

    dispatchArchitectPlanSelectorRequest(detail);
    const unregister = registerArchitectPlanSelectorRequestHandler((request) => {
      received.push(request as typeof detail);
    });

    try {
      expect(received).toEqual([detail]);
    } finally {
      unregister();
    }
  });

  it('does not replay an expired selector request', () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      dispatchArchitectPlanSelectorRequest({ action: 'primary' });
      now = 7_000;
      const received: unknown[] = [];
      const unregister = registerArchitectPlanSelectorRequestHandler((request) => {
        received.push(request);
      });
      unregister();
      expect(received).toEqual([]);
    } finally {
      Date.now = originalNow;
    }
  });

  it('does not replay a request that a mounted selector already handled', () => {
    const handled: unknown[] = [];
    const unregisterFirst = registerArchitectPlanSelectorRequestHandler((request) => {
      handled.push(request);
    });
    dispatchArchitectPlanSelectorRequest({ action: 'primary' });
    unregisterFirst();

    const replayed: unknown[] = [];
    const unregisterSecond = registerArchitectPlanSelectorRequestHandler((request) => {
      replayed.push(request);
    });
    unregisterSecond();

    expect(handled).toEqual([{ action: 'primary' }]);
    expect(replayed).toEqual([]);
  });

  it('delivers a request to only the first mounted selector handler', () => {
    const firstHandlerRequests: unknown[] = [];
    const secondHandlerRequests: unknown[] = [];
    const unregisterFirst = registerArchitectPlanSelectorRequestHandler((request) => {
      firstHandlerRequests.push(request);
    });
    const unregisterSecond = registerArchitectPlanSelectorRequestHandler((request) => {
      secondHandlerRequests.push(request);
    });

    try {
      dispatchArchitectPlanSelectorRequest({ action: 'primary' });
      expect(firstHandlerRequests).toEqual([{ action: 'primary' }]);
      expect(secondHandlerRequests).toEqual([]);
    } finally {
      unregisterFirst();
      unregisterSecond();
    }
  });
});
