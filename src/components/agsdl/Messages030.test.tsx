import { expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Messages030 } from './Messages030';
import { inspectionFixture030, ready } from '../../services/agsdl/runInspection030.testSupport';
it('renders consumption, queue fallback and the agent response without inventing another work', () => {
  const run = inspectionFixture030();
  const row = run.state.occurrences.kind === 'ready' ? run.state.occurrences.value[0] : undefined;
  if (!row) throw new Error('missing fixture');
  const html = renderToStaticMarkup(<Messages030 run={{ ...run, state: { ...run.state, occurrences: ready([{ ...row, activation: { ...row.activation, agent: 'worker', message: { sequence: '1', delivery: 'steer', sender: 'host', messageJson: '{"prompt":"Change the summary"}', statuses: ['sent', 'fallback', 'delivered', 'consumed'], targetActivationId: 'first' }, workText: 'Updated summary' } }]) } }} stale={false} refresh={() => {}} />);
  for (const text of ['Sent', 'Moved to queue', 'Delivered', 'Consumed', 'Change the summary', 'Updated summary']) expect(html).toContain(text);
  expect(html).not.toContain('steerPending');
});
