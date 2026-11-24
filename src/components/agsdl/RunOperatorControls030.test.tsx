import { expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunOperatorControls030 } from './RunOperatorControls030';
import { humanFixture030, inspectionFixture030, ready } from '../../services/agsdl/runInspection030.testSupport';

it('shows the pause and the approval deadline in the graph controls', () => {
  const base = inspectionFixture030();
  const run = {
    ...base, capture: { ...base.capture, versions: { ...base.capture.versions, contract: 'agsdl-0.4.0' as const } },
    state: { ...base.state, paused: true, stopping: false, humans: ready([{
      ...humanFixture030(base),
      content: { kind: 'flowChoice' as const, title: 'Approve', description: '', messageJson: '{}', choices: ['yes'] },
      clock: { kind: 'available' as const, value: { openedAtMs: '0', observedAtMs: '1', timeoutMs: '100', works: [] } },
    }]) },
  };
  const html = renderToStaticMarkup(<RunOperatorControls030 run={run} local stale={false} />);
  expect(html).toContain('No new work will start.');
  expect(html).toContain('Pending approvals can still expire');
  expect(html).toContain('Resume</button>');
});

it('shows what a hold does and disables individual resume during a run pause', () => {
  const base = inspectionFixture030();
  const instance = { ...base.state.instances[0], currentActivationId: 'active', discarded: false };
  const run = {
    ...base, capture: { ...base.capture, versions: { ...base.capture.versions, contract: 'agsdl-0.4.0' as const } },
    state: { ...base.state, stopping: false, operatorWorks: { active: { kind: 'held' as const } } },
  };
  const held = renderToStaticMarkup(<RunOperatorControls030 run={run} instance={instance} local stale={false} />);
  expect(held).toContain('machine-time budget is suspended');
  expect(held).toContain('Resume</button>');
  const paused = renderToStaticMarkup(<RunOperatorControls030 run={{ ...run, state: { ...run.state, paused: true } }}
    instance={instance} local stale={false} />);
  expect(paused).toContain('machine-time budget is suspended');
  expect(paused).not.toContain('Resume</button>');
});
