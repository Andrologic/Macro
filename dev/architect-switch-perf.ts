import {
  architectSwitchPerf,
  summarizeArchitectSwitchPerfReports,
  type ArchitectPlanSwitchPerfPlanType,
  type ArchitectPlanSwitchPerfReport,
} from '../src/services/architectSwitchPerf';
import { DEFAULT_NEW_PLAN_LABEL } from '../src/services/architectPlanPresentation';

interface LocalStorageMock {
  clear: () => void;
  getItem: (key: string) => string | null;
  key: (index: number) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
  readonly length: number;
}

type ArchitectPlanServiceModule = Awaited<
  typeof import('../src/services/architectPlanService')
>;

type ArchitectPlanServiceInstance =
  ArchitectPlanServiceModule['createArchitectPlanService'] extends (
    ...args: never[]
  ) => infer TService
    ? TService
    : never;

const BRANCH_NAME = 'develop';
const REPEATS = Math.max(
  3,
  Number.parseInt(process.env.MACRO_ARCHITECT_SWITCH_PERF_REPEATS ?? '5', 10),
);

const createLocalStorageMock = (): LocalStorageMock => {
  const store = new Map<string, string>();

  return {
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    get length() {
      return store.size;
    },
  };
};

const installStorage = (storage: LocalStorageMock): void => {
  const existingWindow =
    (globalThis as { window?: Record<string, unknown> }).window ?? {};

  (globalThis as { localStorage?: LocalStorageMock }).localStorage = storage;
  (globalThis as { window?: Record<string, unknown> }).window = {
    ...existingWindow,
    localStorage: storage,
    addEventListener:
      typeof existingWindow.addEventListener === 'function'
        ? existingWindow.addEventListener
        : () => undefined,
    removeEventListener:
      typeof existingWindow.removeEventListener === 'function'
        ? existingWindow.removeEventListener
        : () => undefined,
  };
};

const loadFreshArchitectPlanService = async (
  label: string,
): Promise<ArchitectPlanServiceInstance> => {
  const module = await import(
    `../src/services/architectPlanService.ts?architect-switch-perf=${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return module.createArchitectPlanService();
};

const createBlankPlanFixture = async (
  service: ArchitectPlanServiceInstance,
  planId: string,
) => {
  const created = await service.createArchitectPlan({
    branchName: BRANCH_NAME,
    planId,
    label: DEFAULT_NEW_PLAN_LABEL,
  });
  const listed = await service.listArchitectPlans(BRANCH_NAME, true, true);
  const summary = listed.plans.find((plan) => plan.id === created.id) ?? null;

  return {
    created,
    summary,
  };
};

const createProgressPlanFixture = async (
  service: ArchitectPlanServiceInstance,
  planId: string,
) => {
  const created = await service.createArchitectPlan({
    branchName: BRANCH_NAME,
    planId,
    title: `Checkout resiliency ${planId}`,
    nodes: [
      {
        id: `task-${planId}`,
        title: 'Retry payment intent safely',
        description: 'Preserve retries and idempotency when the payment fails.',
        type: 'task',
        status: 'pending',
        dependencies: [],
        assignedBranch: `feature/retry-payment-${planId}`,
        projectId: 'web',
        projectIds: ['web'],
      },
    ],
  });

  await service.saveArchitectPlanNeeds(BRANCH_NAME, created.id, [
    {
      id: `need-${planId}`,
      planId: created.id,
      title: 'Clarify payment retry UX',
      description: 'Need a clean recovery path after a retryable payment failure.',
      category: 'functional',
      status: 'identified',
      priority: 'high',
      tags: ['checkout'],
      createdAt: '2026-04-19T08:00:00.000Z',
      updatedAt: '2026-04-19T08:00:00.000Z',
    },
  ]);
  await service.saveArchitectPlanChatMessages(BRANCH_NAME, created.id, [
    {
      id: `msg-${planId}`,
      role: 'assistant',
      content: 'We should recover payment retries without losing context.',
      createdAt: '2026-04-19T08:05:00.000Z',
    },
  ]);

  const listed = await service.listArchitectPlans(BRANCH_NAME, true, true);
  const summary = listed.plans.find((plan) => plan.id === created.id) ?? null;

  return {
    created,
    summary,
  };
};

const runMeasuredSwitch = async (params: {
  requestId: number;
  service: ArchitectPlanServiceInstance;
  sourcePlanId?: string | null;
  sourcePlanType: ArchitectPlanSwitchPerfPlanType;
  targetPlanId: string;
  targetSummary: Awaited<ReturnType<ArchitectPlanServiceInstance['listArchitectPlans']>>['plans'][number] | null;
}) => {
  architectSwitchPerf.startSwitchSession({
    requestId: params.requestId,
    selectionSource: 'plan_selector',
    hasSummaryHint: Boolean(params.targetSummary),
    sourcePlanId: params.sourcePlanId ?? null,
    sourcePlanType: params.sourcePlanType,
    targetPlanId: params.targetPlanId,
    targetPlanType: params.targetSummary
      ? (params.targetSummary.needCount ?? 0) === 0 &&
        (params.targetSummary.chatMessageCount ?? 0) === 0 &&
        params.targetSummary.nodeCount === 0
        ? 'blank'
        : 'progress'
      : 'unknown',
    targetBranch: BRANCH_NAME,
  });

  await architectSwitchPerf.measureSwitchPhase(
    params.requestId,
    'app_prehydrate',
    async () => undefined,
  );
  const payload = await architectSwitchPerf.measureSwitchPhase(
    params.requestId,
    'app_activation_payload_load',
    () =>
      params.service.getArchitectPlanActivationPayload(
        BRANCH_NAME,
        params.targetPlanId,
        {
          summaryHint: params.targetSummary,
          switchRequestId: params.requestId,
        },
      ),
  );

  if (!payload) {
    throw new Error(`Activation payload missing for ${params.targetPlanId}`);
  }

  architectSwitchPerf.annotateSwitchSession(params.requestId, {
    resolutionMode: payload.resolutionMode,
    targetPlanType:
      payload.resolutionMode === 'blank_fast_path' ||
      (payload.plan.nodes.length === 0 &&
        payload.needs.length === 0 &&
        payload.chatMessages.length === 0 &&
        !payload.conversationId)
        ? 'blank'
        : 'progress',
    nodeCount: payload.plan.nodes.length,
    needCount: payload.needs.length,
    chatMessageCount: payload.chatMessages.length,
    sharedConversation: payload.sharedConversation,
  });

  await architectSwitchPerf.measureSwitchPhase(
    params.requestId,
    'app_hydrate_store',
    async () => undefined,
  );
  await architectSwitchPerf.measureSwitchPhase(
    params.requestId,
    'chat_architect_resolution',
    async () => undefined,
  );

  architectSwitchPerf.markVisualReady({
    requestId: params.requestId,
    surface: 'chat',
    metadata: { planId: params.targetPlanId },
  });
  architectSwitchPerf.markVisualReady({
    requestId: params.requestId,
    surface: 'needs',
    metadata: { planId: params.targetPlanId },
  });
  architectSwitchPerf.markVisualReady({
    requestId: params.requestId,
    surface: 'strategy',
    metadata: { planId: params.targetPlanId },
  });

  const report = architectSwitchPerf
    .getReports()
    .find((candidate) => candidate.requestId === params.requestId);
  if (!report) {
    throw new Error(`Missing perf report for request ${params.requestId}`);
  }

  return report;
};

const runScenario = async (
  label: string,
  iterations: (iterationIndex: number) => Promise<ArchitectPlanSwitchPerfReport>,
): Promise<ArchitectPlanSwitchPerfReport[]> => {
  const reports: ArchitectPlanSwitchPerfReport[] = [];

  for (let iterationIndex = 0; iterationIndex < REPEATS; iterationIndex += 1) {
    const report = await iterations(iterationIndex);
    reports.push(report);
  }

  return reports;
};

const run = async () => {
  const scenarioReports: ArchitectPlanSwitchPerfReport[] = [];

  scenarioReports.push(
    ...(
      await runScenario('blank_to_blank', async (iterationIndex) => {
        const storage = createLocalStorageMock();
        installStorage(storage);
        architectSwitchPerf.clearReports();
        const service = await loadFreshArchitectPlanService(
          `blank-to-blank-${iterationIndex}`,
        );
        const blank = await createBlankPlanFixture(
          service,
          `blank-blank-${iterationIndex}`,
        );

        return await runMeasuredSwitch({
          requestId: 1_000 + iterationIndex,
          service,
          sourcePlanId: `blank-source-${iterationIndex}`,
          sourcePlanType: 'blank',
          targetPlanId: blank.created.id,
          targetSummary: blank.summary,
        });
      })
    ),
  );

  scenarioReports.push(
    ...(
      await runScenario('progress_to_blank', async (iterationIndex) => {
        const storage = createLocalStorageMock();
        installStorage(storage);
        architectSwitchPerf.clearReports();
        const service = await loadFreshArchitectPlanService(
          `progress-to-blank-${iterationIndex}`,
        );
        const blank = await createBlankPlanFixture(
          service,
          `progress-blank-${iterationIndex}`,
        );

        return await runMeasuredSwitch({
          requestId: 2_000 + iterationIndex,
          service,
          sourcePlanId: `progress-source-${iterationIndex}`,
          sourcePlanType: 'progress',
          targetPlanId: blank.created.id,
          targetSummary: blank.summary,
        });
      })
    ),
  );

  scenarioReports.push(
    ...(
      await runScenario('blank_to_progress', async (iterationIndex) => {
        const storage = createLocalStorageMock();
        installStorage(storage);
        architectSwitchPerf.clearReports();
        const service = await loadFreshArchitectPlanService(
          `blank-to-progress-${iterationIndex}`,
        );
        const progress = await createProgressPlanFixture(
          service,
          `blank-progress-${iterationIndex}`,
        );

        return await runMeasuredSwitch({
          requestId: 3_000 + iterationIndex,
          service,
          sourcePlanId: `blank-source-${iterationIndex}`,
          sourcePlanType: 'blank',
          targetPlanId: progress.created.id,
          targetSummary: progress.summary,
        });
      })
    ),
  );

  scenarioReports.push(
    ...(
      await runScenario(
        'progress_to_progress_cold',
        async (iterationIndex) => {
          const storage = createLocalStorageMock();
          installStorage(storage);
          architectSwitchPerf.clearReports();
          const service = await loadFreshArchitectPlanService(
            `progress-to-progress-cold-${iterationIndex}`,
          );
          const progress = await createProgressPlanFixture(
            service,
            `progress-cold-${iterationIndex}`,
          );

          return await runMeasuredSwitch({
            requestId: 4_000 + iterationIndex,
            service,
            sourcePlanId: `progress-source-${iterationIndex}`,
            sourcePlanType: 'progress',
            targetPlanId: progress.created.id,
            targetSummary: progress.summary,
          });
        },
      )
    ),
  );

  scenarioReports.push(
    ...(
      await runScenario(
        'progress_to_progress_warm',
        async (iterationIndex) => {
          const storage = createLocalStorageMock();
          installStorage(storage);
          architectSwitchPerf.clearReports();
          const service = await loadFreshArchitectPlanService(
            `progress-to-progress-warm-${iterationIndex}`,
          );
          const progress = await createProgressPlanFixture(
            service,
            `progress-warm-${iterationIndex}`,
          );

          await service.getArchitectPlanActivationPayload(
            BRANCH_NAME,
            progress.created.id,
            {
              summaryHint: progress.summary,
            },
          );
          architectSwitchPerf.clearReports();

          return await runMeasuredSwitch({
            requestId: 5_000 + iterationIndex,
            service,
            sourcePlanId: `progress-source-${iterationIndex}`,
            sourcePlanType: 'progress',
            targetPlanId: progress.created.id,
            targetSummary: progress.summary,
          });
        },
      )
    ),
  );

  scenarioReports.push(
    ...(
      await runScenario('rapid_a_b_c', async (iterationIndex) => {
        const storage = createLocalStorageMock();
        installStorage(storage);
        architectSwitchPerf.clearReports();
        const service = await loadFreshArchitectPlanService(
          `rapid-a-b-c-${iterationIndex}`,
        );
        const planA = await createProgressPlanFixture(
          service,
          `rapid-a-${iterationIndex}`,
        );
        const planB = await createBlankPlanFixture(
          service,
          `rapid-b-${iterationIndex}`,
        );
        const planC = await createProgressPlanFixture(
          service,
          `rapid-c-${iterationIndex}`,
        );

        architectSwitchPerf.startSwitchSession({
          requestId: 6_000 + iterationIndex * 10,
          selectionSource: 'plan_selector',
          sourcePlanType: 'progress',
          targetPlanId: planA.created.id,
          targetPlanType: 'progress',
          targetBranch: BRANCH_NAME,
        });
        await architectSwitchPerf.measureSwitchPhase(
          6_000 + iterationIndex * 10,
          'app_prehydrate',
          async () => undefined,
        );
        architectSwitchPerf.cancelSwitchSession(
          6_000 + iterationIndex * 10,
          {
            cancelledByRequestId: 6_001 + iterationIndex * 10,
          },
        );

        architectSwitchPerf.startSwitchSession({
          requestId: 6_001 + iterationIndex * 10,
          selectionSource: 'plan_selector',
          sourcePlanType: 'progress',
          targetPlanId: planB.created.id,
          targetPlanType: 'blank',
          targetBranch: BRANCH_NAME,
        });
        await architectSwitchPerf.measureSwitchPhase(
          6_001 + iterationIndex * 10,
          'app_prehydrate',
          async () => undefined,
        );
        architectSwitchPerf.cancelSwitchSession(
          6_001 + iterationIndex * 10,
          {
            cancelledByRequestId: 6_002 + iterationIndex * 10,
          },
        );

        await runMeasuredSwitch({
          requestId: 6_002 + iterationIndex * 10,
          service,
          sourcePlanId: planB.created.id,
          sourcePlanType: 'blank',
          targetPlanId: planC.created.id,
          targetSummary: planC.summary,
        });

        const report = architectSwitchPerf
          .getReports()
          .filter((candidate) => candidate.scenario === 'rapid_a_b_c')
          .at(-1);
        if (!report) {
          throw new Error('Missing rapid_a_b_c perf report');
        }
        return report;
      })
    ),
  );

  const summary = summarizeArchitectSwitchPerfReports(scenarioReports);
  const rows = summary.rows.map((row) => ({
    scenario: row.scenario,
    count: row.count,
    min_ms: row.min.toFixed(2),
    avg_ms: row.avg.toFixed(2),
    p50_ms: row.p50.toFixed(2),
    p95_ms: row.p95.toFixed(2),
    cache_hit_rate: row.cacheHitRate.toFixed(2),
    slowest_phases: row.topSlowestPhases
      .map((phase) => `${phase.name}:${phase.avgDurationMs.toFixed(2)}ms`)
      .join(', '),
  }));

  console.log(
    `Architect switch perf benchmark (${REPEATS} runs per scenario)`,
  );
  console.table(rows);
  console.log('JSON summary:');
  console.log(JSON.stringify(summary, null, 2));
};

await run();
