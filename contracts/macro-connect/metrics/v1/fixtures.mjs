import { readFileSync } from 'node:fs';
export const profiles = JSON.parse(readFileSync(new URL('./profiles.json', import.meta.url), 'utf8'));

/** Portable generated fixture. No application profiles, provider or filesystem. */
export function fixtureMessages(size, conversation = 'active') {
  if (!profiles.fixture.sizes.includes(size) || !profiles.fixture.conversations.includes(conversation)) throw new Error('Unknown fixture');
  return Array.from({ length: size }, (_, index) => ({
    id: `seed-${String(index).padStart(6, '0')}`,
    conversation_id: `synthetic-${conversation}`,
    role: 'user',
    content: 'x'.repeat(profiles.fixture.content_bytes),
    created_at: profiles.fixture.seed_timestamp,
  }));
}

/** Deterministic schedule only. It executes no product operation and measures no
 * latency. Adapters apply the returned events through their actual runtime. */
export function scenarioSchedule(scenario, profile) {
  const spec = profiles.scenarios[scenario];
  const network = profiles.profiles[profile];
  if (!spec || !network) throw new Error('Unknown scenario/profile');
  const events = spec.steps.map(([at_ms, action, target, conversation]) => ({ at_ms, action, target, conversation }));
  if (network.disconnect_at_ms !== null) events.push({ at_ms: network.disconnect_at_ms, action: 'disconnect', target: 'all', conversation: 'all' });
  if (network.reconnect_at_ms !== null) events.push({ at_ms: network.reconnect_at_ms, action: 'reconnect', target: 'all', conversation: 'all' });
  return { window_ms: spec.window_ms, network: structuredClone(network), events: events.sort((a, b) => a.at_ms - b.at_ms) };
}
