import { devLogger } from '../utils/devLogger';
import { isDevelopmentBuild } from '../utils/devLogger';

export type ArchitectPlanSwitchPerfScenario =
  | 'blank_to_blank'
  | 'progress_to_blank'
  | 'blank_to_progress'
  | 'progress_to_progress_cold'
  | 'progress_to_progress_warm'
  | 'rapid_a_b_c'
  | 'unknown';

export type ArchitectPlanSwitchPerfPlanType =
  | 'blank'
  | 'progress'
  | 'unknown';

export type ArchitectPlanSwitchPerfCacheState =
  | 'unknown'
  | 'hit'
  | 'miss'
  | 'in_flight';

export type ArchitectPlanSwitchPerfPayloadSource =
  | 'unknown'
  | 'app_store'
  | 'service';

export type ArchitectPlanSwitchPerfSelectionSource =
  | 'unknown'
  | 'plan_selector'
  | 'tool_runtime';

export type ArchitectPlanSwitchPerfResolutionMode =
  | 'unknown'
  | 'blank_fast_path'
  | 'full';

export type ArchitectPlanSwitchPerfSurface =
  | 'chat'
  | 'needs'
  | 'strategy';

export type ArchitectPlanSwitchPerfOutcome =
  | 'pending'
  | 'complete'
  | 'stale'
  | 'error';

export type ArchitectPlanSwitchPerfPhaseName =
  | 'app_prehydrate'
  | 'app_activation_payload_load'
  | 'app_hydrate_store'
  | 'service_registry_snapshot'
  | 'service_index_read'
  | 'service_scope_resolution'
  | 'service_activation_snapshot'
  | 'service_needs_read'
  | 'service_chat_read'
  | 'chat_architect_resolution'
  | 'chat_blank_conversation_create'
  | 'chat_transcript_reconcile';

export interface ArchitectPlanSwitchPerfPhase {
  name: ArchitectPlanSwitchPerfPhaseName;
  startedAtMs: number;
  completedAtMs: number;
  durationMs: number;
  metadata: Record<string, unknown> | null;
}

export interface ArchitectPlanSwitchPerfEvent {
  name: string;
  atMs: number;
  metadata: Record<string, unknown> | null;
}

export interface ArchitectPlanSwitchPerfReport {
  requestId: number;
  startedAtMs: number;
  completedAtMs: number | null;
  totalDurationMs: number | null;
  outcome: ArchitectPlanSwitchPerfOutcome;
  scenario: ArchitectPlanSwitchPerfScenario;
  selectionSource: ArchitectPlanSwitchPerfSelectionSource;
  sourcePlanId: string | null;
  sourcePlanType: ArchitectPlanSwitchPerfPlanType;
  targetPlanId: string | null;
  targetPlanType: ArchitectPlanSwitchPerfPlanType;
  targetBranch: string | null;
  hasSummaryHint: boolean;
  resolutionMode: ArchitectPlanSwitchPerfResolutionMode;
  indexCacheState: ArchitectPlanSwitchPerfCacheState;
  activationCacheState: ArchitectPlanSwitchPerfCacheState;
  fallbackReplica: boolean;
  chatPayloadSource: ArchitectPlanSwitchPerfPayloadSource;
  sharedConversation: boolean | null;
  nodeCount: number | null;
  needCount: number | null;
  chatMessageCount: number | null;
  stale: boolean;
  cancelledByRequestId: number | null;
  errorMessage: string | null;
  visualReady: Record<ArchitectPlanSwitchPerfSurface, number | null>;
  phases: ArchitectPlanSwitchPerfPhase[];
  events: ArchitectPlanSwitchPerfEvent[];
}

export interface ArchitectPlanSwitchPerfSummaryRow {
  scenario: ArchitectPlanSwitchPerfScenario;
  count: number;
  min: number;
  avg: number;
  p50: number;
  p95: number;
  cacheHitRate: number;
  topSlowestPhases: Array<{
    name: string;
    avgDurationMs: number;
  }>;
}

export interface ArchitectPlanSwitchPerfSummary {
  rows: ArchitectPlanSwitchPerfSummaryRow[];
  totalReports: number;
}

interface PerfLike {
  mark?: (name: string) => void;
  measure?: (
    name: string,
    startMark?: string,
    endMark?: string,
  ) => void;
}

interface CreateArchitectSwitchPerfRuntimeOptions {
  enabled?: boolean;
  logger?: Pick<typeof devLogger, 'info'>;
  performanceApi?: PerfLike | null;
  now?: () => number;
}

const isArchitectSwitchPerfForced = (): boolean =>
  Boolean(
    (globalThis as { __MACRO_ENABLE_ARCHITECT_SWITCH_PERF__?: boolean })
      .__MACRO_ENABLE_ARCHITECT_SWITCH_PERF__ === true ||
      (typeof process !== 'undefined' &&
        process.env.MACRO_ARCHITECT_SWITCH_PERF === '1'),
  );

type SwitchSessionPatch = Partial<
  Omit<
    ArchitectPlanSwitchPerfReport,
    'requestId' | 'startedAtMs' | 'completedAtMs' | 'totalDurationMs' | 'phases' | 'events' | 'visualReady'
  >
>;

type InternalSession = {
  report: ArchitectPlanSwitchPerfReport;
  finalized: boolean;
};

const DEFAULT_VISUAL_READY: Record<ArchitectPlanSwitchPerfSurface, number | null> = {
  chat: null,
  needs: null,
  strategy: null,
};

const isPromiseLike = <T>(
  value: Promise<T> | T,
): value is Promise<T> =>
  Boolean(
    value &&
      typeof (value as PromiseLike<unknown>).then === 'function',
  );

const cloneVisualReady = (): Record<
  ArchitectPlanSwitchPerfSurface,
  number | null
> => ({
  ...DEFAULT_VISUAL_READY,
});

const createDefaultReport = (
  requestId: number,
  startedAtMs: number,
): ArchitectPlanSwitchPerfReport => ({
  requestId,
  startedAtMs,
  completedAtMs: null,
  totalDurationMs: null,
  outcome: 'pending',
  scenario: 'unknown',
  selectionSource: 'unknown',
  sourcePlanId: null,
  sourcePlanType: 'unknown',
  targetPlanId: null,
  targetPlanType: 'unknown',
  targetBranch: null,
  hasSummaryHint: false,
  resolutionMode: 'unknown',
  indexCacheState: 'unknown',
  activationCacheState: 'unknown',
  fallbackReplica: false,
  chatPayloadSource: 'unknown',
  sharedConversation: null,
  nodeCount: null,
  needCount: null,
  chatMessageCount: null,
  stale: false,
  cancelledByRequestId: null,
  errorMessage: null,
  visualReady: cloneVisualReady(),
  phases: [],
  events: [],
});

const percentile = (values: number[], ratio: number): number => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index] ?? 0;
};

const hasWarmActivationCache = (
  report: Pick<ArchitectPlanSwitchPerfReport, 'activationCacheState'>,
): boolean =>
  report.activationCacheState === 'hit' ||
  report.activationCacheState === 'in_flight';

const classifyScenario = (
  report: Pick<
    ArchitectPlanSwitchPerfReport,
    'stale' | 'sourcePlanType' | 'targetPlanType' | 'activationCacheState'
  >,
): ArchitectPlanSwitchPerfScenario => {
  if (report.stale) {
    return 'rapid_a_b_c';
  }

  if (
    report.sourcePlanType === 'blank' &&
    report.targetPlanType === 'blank'
  ) {
    return 'blank_to_blank';
  }

  if (
    report.sourcePlanType === 'progress' &&
    report.targetPlanType === 'blank'
  ) {
    return 'progress_to_blank';
  }

  if (
    report.sourcePlanType === 'blank' &&
    report.targetPlanType === 'progress'
  ) {
    return 'blank_to_progress';
  }

  if (
    report.sourcePlanType === 'progress' &&
    report.targetPlanType === 'progress'
  ) {
    return hasWarmActivationCache(report)
      ? 'progress_to_progress_warm'
      : 'progress_to_progress_cold';
  }

  return 'unknown';
};

const safePerformanceMark = (
  performanceApi: PerfLike | null,
  name: string,
): void => {
  if (!performanceApi?.mark) {
    return;
  }

  try {
    performanceApi.mark(name);
  } catch {
    // Ignore dev-only perf marks when the environment does not support them.
  }
};

const safePerformanceMeasure = (
  performanceApi: PerfLike | null,
  name: string,
  startMark: string,
  endMark: string,
): void => {
  if (!performanceApi?.measure) {
    return;
  }

  try {
    performanceApi.measure(name, startMark, endMark);
  } catch {
    // Ignore dev-only perf marks when the environment does not support them.
  }
};

export const summarizeArchitectSwitchPerfReports = (
  reports: ArchitectPlanSwitchPerfReport[],
): ArchitectPlanSwitchPerfSummary => {
  const byScenario = new Map<
    ArchitectPlanSwitchPerfScenario,
    ArchitectPlanSwitchPerfReport[]
  >();

  for (const report of reports) {
    const current = byScenario.get(report.scenario) ?? [];
    current.push(report);
    byScenario.set(report.scenario, current);
  }

  const rows = Array.from(byScenario.entries())
    .map(([scenario, scenarioReports]) => {
      const completedDurations = scenarioReports
        .map((report) => report.totalDurationMs ?? 0)
        .filter((duration) => duration > 0);
      const phaseAverages = new Map<string, number[]>();
      let activationCacheHits = 0;

      for (const report of scenarioReports) {
        if (
          report.activationCacheState === 'hit' ||
          report.activationCacheState === 'in_flight'
        ) {
          activationCacheHits += 1;
        }

        for (const phase of report.phases) {
          const current = phaseAverages.get(phase.name) ?? [];
          current.push(phase.durationMs);
          phaseAverages.set(phase.name, current);
        }
      }

      const topSlowestPhases = Array.from(phaseAverages.entries())
        .map(([name, durations]) => ({
          name,
          avgDurationMs:
            durations.reduce((sum, duration) => sum + duration, 0) /
            Math.max(1, durations.length),
        }))
        .sort((left, right) => right.avgDurationMs - left.avgDurationMs)
        .slice(0, 3);

      const min =
        completedDurations.length > 0
          ? Math.min(...completedDurations)
          : 0;
      const avg =
        completedDurations.length > 0
          ? completedDurations.reduce(
              (sum, duration) => sum + duration,
              0,
            ) / completedDurations.length
          : 0;

      return {
        scenario,
        count: scenarioReports.length,
        min,
        avg,
        p50: percentile(completedDurations, 0.5),
        p95: percentile(completedDurations, 0.95),
        cacheHitRate:
          scenarioReports.length > 0
            ? activationCacheHits / scenarioReports.length
            : 0,
        topSlowestPhases,
      } satisfies ArchitectPlanSwitchPerfSummaryRow;
    })
    .sort((left, right) => left.scenario.localeCompare(right.scenario));

  return {
    rows,
    totalReports: reports.length,
  };
};

export const createArchitectSwitchPerfRuntime = (
  options: CreateArchitectSwitchPerfRuntimeOptions = {},
) => {
  const enabled =
    options.enabled ??
    (isDevelopmentBuild || isArchitectSwitchPerfForced());
  const logger = options.logger ?? devLogger;
  const performanceApi =
    options.performanceApi ??
    (typeof performance === 'object' ? performance : null);
  const now =
    options.now ??
    (() =>
      typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
        ? performance.now()
        : Date.now());
  const sessions = new Map<number, InternalSession>();
  const reports: ArchitectPlanSwitchPerfReport[] = [];

  const getTimestamp = (): number => now();

  const updateScenario = (
    report: ArchitectPlanSwitchPerfReport,
  ): void => {
    report.scenario = classifyScenario(report);
  };

  const getSession = (requestId: number): InternalSession | null =>
    sessions.get(requestId) ?? null;

  const emitFinalReport = (
    session: InternalSession,
  ): ArchitectPlanSwitchPerfReport => {
    if (session.finalized) {
      return session.report;
    }

    session.finalized = true;
    const completedAtMs = getTimestamp();
    session.report.completedAtMs = completedAtMs;
    session.report.totalDurationMs =
      completedAtMs - session.report.startedAtMs;
    updateScenario(session.report);
    reports.push({
      ...session.report,
      visualReady: { ...session.report.visualReady },
      phases: [...session.report.phases],
      events: [...session.report.events],
    });
    logger.info(
      `[architect-switch-perf] ${JSON.stringify(session.report)}`,
    );
    sessions.delete(session.report.requestId);
    return session.report;
  };

  const maybeFinalizeOnVisualReady = (
    session: InternalSession,
  ): ArchitectPlanSwitchPerfReport | null => {
    if (session.finalized) {
      return session.report;
    }

    if (session.report.outcome === 'stale' || session.report.outcome === 'error') {
      return emitFinalReport(session);
    }

    const allVisualSurfacesReady = (
      Object.values(session.report.visualReady) as Array<number | null>
    ).every((value) => typeof value === 'number');

    if (!allVisualSurfacesReady) {
      return null;
    }

    if (session.report.outcome === 'pending') {
      session.report.outcome = 'complete';
    }

    return emitFinalReport(session);
  };

  return {
    isEnabled: (): boolean => enabled,
    getTimestamp,
    startSwitchSession: (input: {
      requestId: number;
      startedAtMs?: number | null;
      selectionSource?: ArchitectPlanSwitchPerfSelectionSource;
      hasSummaryHint?: boolean;
      sourcePlanId?: string | null;
      sourcePlanType?: ArchitectPlanSwitchPerfPlanType;
      targetPlanId?: string | null;
      targetPlanType?: ArchitectPlanSwitchPerfPlanType;
      targetBranch?: string | null;
    }): ArchitectPlanSwitchPerfReport | null => {
      if (!enabled || input.requestId <= 0) {
        return null;
      }

      const report = createDefaultReport(
        input.requestId,
        input.startedAtMs ?? getTimestamp(),
      );
      report.selectionSource = input.selectionSource ?? 'unknown';
      report.hasSummaryHint = input.hasSummaryHint ?? false;
      report.sourcePlanId = input.sourcePlanId ?? null;
      report.sourcePlanType = input.sourcePlanType ?? 'unknown';
      report.targetPlanId = input.targetPlanId ?? null;
      report.targetPlanType = input.targetPlanType ?? 'unknown';
      report.targetBranch = input.targetBranch ?? null;
      updateScenario(report);
      sessions.set(input.requestId, {
        report,
        finalized: false,
      });
      safePerformanceMark(
        performanceApi,
        `architect-switch:${input.requestId}:start`,
      );
      return report;
    },
    annotateSwitchSession: (
      requestId: number | null | undefined,
      patch: SwitchSessionPatch,
    ): ArchitectPlanSwitchPerfReport | null => {
      if (!enabled || !requestId) {
        return null;
      }

      const session = getSession(requestId);
      if (!session || session.finalized) {
        return null;
      }

      Object.assign(session.report, patch);
      updateScenario(session.report);
      return session.report;
    },
    markSwitchEvent: (
      requestId: number | null | undefined,
      name: string,
      metadata?: Record<string, unknown> | null,
    ): ArchitectPlanSwitchPerfReport | null => {
      if (!enabled || !requestId) {
        return null;
      }

      const session = getSession(requestId);
      if (!session || session.finalized) {
        return null;
      }

      const atMs = getTimestamp();
      session.report.events.push({
        name,
        atMs,
        metadata: metadata ?? null,
      });
      safePerformanceMark(
        performanceApi,
        `architect-switch:${requestId}:event:${name}`,
      );
      return session.report;
    },
    measureSwitchPhase: <T>(
      requestId: number | null | undefined,
      phaseName: ArchitectPlanSwitchPerfPhaseName,
      run: () => T | Promise<T>,
      metadata?: Record<string, unknown> | null,
    ): T | Promise<T> => {
      if (!enabled || !requestId) {
        return run();
      }

      const session = getSession(requestId);
      if (!session || session.finalized) {
        return run();
      }

      const phaseStartMark = `architect-switch:${requestId}:phase:${phaseName}:start`;
      const phaseEndMark = `architect-switch:${requestId}:phase:${phaseName}:end`;
      const phaseMeasureName = `architect-switch:${requestId}:phase:${phaseName}`;
      const startedAtMs = getTimestamp();
      safePerformanceMark(performanceApi, phaseStartMark);

      const completePhase = (): void => {
        const completedAtMs = getTimestamp();
        session.report.phases.push({
          name: phaseName,
          startedAtMs,
          completedAtMs,
          durationMs: completedAtMs - startedAtMs,
          metadata: metadata ?? null,
        });
        safePerformanceMark(performanceApi, phaseEndMark);
        safePerformanceMeasure(
          performanceApi,
          phaseMeasureName,
          phaseStartMark,
          phaseEndMark,
        );
      };

      const result = run();
      if (isPromiseLike(result)) {
        return result.then(
          (value) => {
            completePhase();
            return value;
          },
          (error) => {
            completePhase();
            throw error;
          },
        );
      }

      completePhase();
      return result;
    },
    markVisualReady: (input: {
      requestId: number | null | undefined;
      surface: ArchitectPlanSwitchPerfSurface;
      metadata?: Record<string, unknown> | null;
    }): ArchitectPlanSwitchPerfReport | null => {
      if (!enabled || !input.requestId) {
        return null;
      }

      const session = getSession(input.requestId);
      if (!session || session.finalized) {
        return null;
      }

      if (session.report.visualReady[input.surface] !== null) {
        return session.report;
      }

      const atMs = getTimestamp();
      session.report.visualReady[input.surface] = atMs;
      session.report.events.push({
        name: `visual_ready:${input.surface}`,
        atMs,
        metadata: input.metadata ?? null,
      });
      safePerformanceMark(
        performanceApi,
        `architect-switch:${input.requestId}:visual:${input.surface}`,
      );
      return maybeFinalizeOnVisualReady(session);
    },
    finalizeSwitchSession: (
      requestId: number | null | undefined,
      patch?: SwitchSessionPatch,
    ): ArchitectPlanSwitchPerfReport | null => {
      if (!enabled || !requestId) {
        return null;
      }

      const session = getSession(requestId);
      if (!session || session.finalized) {
        return null;
      }

      Object.assign(session.report, patch);
      if (session.report.outcome === 'pending') {
        session.report.outcome = 'complete';
      }
      updateScenario(session.report);
      return emitFinalReport(session);
    },
    cancelSwitchSession: (
      requestId: number | null | undefined,
      patch?: SwitchSessionPatch & {
        cancelledByRequestId?: number | null;
      },
    ): ArchitectPlanSwitchPerfReport | null => {
      if (!enabled || !requestId) {
        return null;
      }

      const session = getSession(requestId);
      if (!session || session.finalized) {
        return null;
      }

      Object.assign(session.report, patch);
      session.report.outcome =
        patch?.outcome === 'error' ? 'error' : 'stale';
      session.report.stale = session.report.outcome === 'stale';
      session.report.cancelledByRequestId =
        patch?.cancelledByRequestId ?? session.report.cancelledByRequestId;
      updateScenario(session.report);
      return emitFinalReport(session);
    },
    getReports: (): ArchitectPlanSwitchPerfReport[] =>
      reports.map((report) => ({
        ...report,
        visualReady: { ...report.visualReady },
        phases: [...report.phases],
        events: [...report.events],
      })),
    clearReports: (): void => {
      sessions.clear();
      reports.length = 0;
    },
  };
};

export const architectSwitchPerf = createArchitectSwitchPerfRuntime();

export const getArchitectSwitchPerfTimestamp = (): number =>
  architectSwitchPerf.getTimestamp();
