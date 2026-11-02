import { expect, test } from 'bun:test';
import { compileFixture, documentFixture, registryFixture } from './conformanceFixtures';
import { decode, record } from './exact';

test('an explicit Edition supplies missing settings without rewriting authored declarations', async () => {
  const document = documentFixture();
  const compiled = await compileFixture(document);
  expect(compiled.runtime.supported).toBe(true);
  const agent = compiled.plan!.agents[0];
  expect(record(decode(agent.settingsJson)).providerId).toBe('synthetic-provider');
  expect(record(decode(agent.settingsJson)).modelId).toBe('synthetic-model');
  expect(record(record(record(decode(agent.configurationJson)).configuration).settings).providerId).toBeUndefined();
});

test('authored and effective identities must agree exactly with the selected Edition', async () => {
  for (const key of ['providerId', 'modelId']) {
    for (const value of [null, '', decode('7'), 'another-provider']) {
      const document = documentFixture();
      record(record(record(document.configurations).fixed).settings)[key] = value;
      expect((await compileFixture(document)).runtime.supported).toBe(false);
    }
    const document = documentFixture();
    const registry = registryFixture(document);
    const changed = { ...registry, configurations: registry.configurations.map(configuration => ({ ...configuration, effectiveSettingsJson: JSON.stringify({ [key]: 'conflicting' }) as typeof configuration.effectiveSettingsJson })) };
    expect((await compileFixture(document, changed)).runtime.supported).toBe(false);
  }
});
