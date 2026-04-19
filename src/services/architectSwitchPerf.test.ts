import { describe, expect, it, mock } from 'bun:test';
import {
  createArchitectSwitchPerfRuntime,
  summarizeArchitectSwitchPerfReports,
  type ArchitectPlanSwitchPerfReport,
} from './architectSwitchPerf';

const createNow = () => {
  let current = 0;
  return () => {
    current += 5;
    return current;
  };
};

const createBaseReport = (
  overrides: Partial<ArchitectPlanSwitchPerfReport> = {},
): ArchitectPlanSwitchPerfReport => ({
  requestId: overrides.requestId ?? 1,
  startedAtMs: overrides.startedAtMs ?? 0,
  completedAtMs: overrides.completedAtMs ?? 20,
  totalDurationMs: overrides.totalDurationMs ?? 20,
  outcome: overrides.outcome ?? 'complete',
  scenario: overrides.scenario ?? 'progress_to_progress_cold',
  selectionSource: overrides.selectionSource ?? 'plan_selector',
  sourcePlanId: overrides.sourcePlanId ?? 'plan-a',
  sourcePlanType: overrides.sourcePlanType ?? 'progress',
  targetPlanId: overrides.targetPlanId ?? 'plan-b',
  targetPlanType: overrides.targetPlanType ?? 'progress',
  targetBranch: overrides.targetBranch ?? 'develop',
  hasSummaryHint: overrides.hasSummaryHint ?? true,
  resolutionMode: overrides.resolutionMode ?? 'full',
  indexCacheState: overrides.indexCacheState ?? 'miss',
  activationCacheState: overrides.activationCacheState ?? 'miss',
  fallbackReplica: overrides.fallbackReplica ?? false,
  chatPayloadSource: overrides.chatPayloadSource ?? 'service',
  sharedConversation: overrides.sharedConversation ?? false,
  nodeCount: overrides.nodeCount ?? 2,
  needCount: overrides.needCount ?? 1,
  chatMessageCount: overrides.chatMessageCount ?? 3,
  stale: overrides.stale ?? false,
  cancelledByRequestId: overrides.cancelledByRequestId ?? null,
  errorMessage: overrides.errorMessage ?? null,
  visualReady: overrides.visualReady ?? {
    chat: 10,
    needs: 12,
    strategy: 15,
  },
  phases: overrides.phases ?? [
    {
      name: 'app_activation_payload_load',
      startedAtMs: 0,
      completedAtMs: 9,
      durationMs: 9,
      metadata: null,
    },
    {
      name: 'chat_architect_resolution',
      startedAtMs: 10,
      completedAtMs: 18,
      durationMs: 8,
      metadata: null,
    },
  ],
  events: overrides.events ?? [],
});

describe('architectSwitchPerf', () => {
  it('is a no-op when disabled', async () => {
    const logger = { info: mock(() => undefined) };
    const runtime = createArchitectSwitchPerfRuntime({
      enabled: false,
      logger,
      now: createNow(),
    });
    const phaseFn = mock(async () => 'ok');

    const started = runtime.startSwitchSession({ requestId: 1 });
    const result = await runtime.measureSwitchPhase(
      1,
      'app_prehydrate',
      phaseFn,
    );
    runtime.markVisualReady({ requestId: 1, surface: 'chat' });

    expect(started).toBeNull();
    expect(result).toBe('ok');
    expect(phaseFn).toHaveBeenCalledTimes(1);
    expect(runtime.getReports()).toHaveLength(0);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('correlates phases under one request and finalizes only after all visual surfaces are ready', async () => {
    const logger = { info: mock(() => undefined) };
    const mark = mock(() => undefined);
    const measure = mock(() => undefined);
    const runtime = createArchitectSwitchPerfRuntime({
      enabled: true,
      logger,
      performanceApi: { mark, measure },
      now: createNow(),
    });

    runtime.startSwitchSession({
      requestId: 7,
      sourcePlanId: 'blank-plan',
      sourcePlanType: 'blank',
      targetPlanId: 'progress-plan',
      targetPlanType: 'progress',
      targetBranch: 'develop',
      hasSummaryHint: true,
      selectionSource: 'plan_selector',
    });

    await runtime.measureSwitchPhase(7, 'app_prehydrate', async () => undefined);
    runtime.annotateSwitchSession(7, {
      activationCacheState: 'hit',
      chatPayloadSource: 'app_store',
      resolutionMode: 'full',
    });

    runtime.markVisualReady({ requestId: 7, surface: 'chat' });
    runtime.markVisualReady({ requestId: 7, surface: 'needs' });

    expect(runtime.getReports()).toHaveLength(0);

    runtime.markVisualReady({ requestId: 7, surface: 'strategy' });

    const reports = runtime.getReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.requestId).toBe(7);
    expect(reports[0]?.outcome).toBe('complete');
    expect(reports[0]?.scenario).toBe('blank_to_progress');
    expect(reports[0]?.chatPayloadSource).toBe('app_store');
    expect(reports[0]?.phases.map((phase) => phase.name)).toEqual([
      'app_prehydrate',
    ]);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalled();
    expect(measure).toHaveBeenCalled();
  });

  it('marks stale sessions as rapid switches', () => {
    const runtime = createArchitectSwitchPerfRuntime({
      enabled: true,
      logger: { info: mock(() => undefined) },
      now: createNow(),
    });

    runtime.startSwitchSession({
      requestId: 11,
      sourcePlanType: 'progress',
      targetPlanType: 'progress',
      targetPlanId: 'plan-b',
    });

    runtime.cancelSwitchSession(11, {
      cancelledByRequestId: 12,
    });

    const report = runtime.getReports()[0];
    expect(report?.outcome).toBe('stale');
    expect(report?.stale).toBe(true);
    expect(report?.cancelledByRequestId).toBe(12);
    expect(report?.scenario).toBe('rapid_a_b_c');
  });

  it('summarizes durations, cache hit rate and slow phases by scenario', () => {
    const summary = summarizeArchitectSwitchPerfReports([
      createBaseReport({
        requestId: 1,
        scenario: 'progress_to_progress_cold',
        totalDurationMs: 40,
        activationCacheState: 'miss',
        phases: [
          {
            name: 'app_activation_payload_load',
            startedAtMs: 0,
            completedAtMs: 20,
            durationMs: 20,
            metadata: null,
          },
          {
            name: 'chat_architect_resolution',
            startedAtMs: 21,
            completedAtMs: 31,
            durationMs: 10,
            metadata: null,
          },
        ],
      }),
      createBaseReport({
        requestId: 2,
        scenario: 'progress_to_progress_cold',
        totalDurationMs: 20,
        activationCacheState: 'hit',
        phases: [
          {
            name: 'app_activation_payload_load',
            startedAtMs: 0,
            completedAtMs: 10,
            durationMs: 10,
            metadata: null,
          },
          {
            name: 'chat_architect_resolution',
            startedAtMs: 11,
            completedAtMs: 16,
            durationMs: 5,
            metadata: null,
          },
        ],
      }),
    ]);

    expect(summary.totalReports).toBe(2);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]?.scenario).toBe('progress_to_progress_cold');
    expect(summary.rows[0]?.count).toBe(2);
    expect(summary.rows[0]?.min).toBe(20);
    expect(summary.rows[0]?.avg).toBe(30);
    expect(summary.rows[0]?.p50).toBe(20);
    expect(summary.rows[0]?.p95).toBe(40);
    expect(summary.rows[0]?.cacheHitRate).toBe(0.5);
    expect(summary.rows[0]?.topSlowestPhases[0]?.name).toBe(
      'app_activation_payload_load',
    );
  });
});
