import type * as tauriIpc from './tauriIpc';

interface DurableGenerationTransport {
  dbGetAppSetting: typeof tauriIpc.dbGetAppSetting;
  dbCompareAndSwapAppSetting: typeof tauriIpc.dbCompareAndSwapAppSetting;
}

interface DurableGenerationRegistry {
  version: 1;
  counters: Record<string, number>;
}

const MAX_CAS_ATTEMPTS = 32;

const emptyRegistry = (): DurableGenerationRegistry => ({ version: 1, counters: {} });

const parseRegistry = (value: string | null | undefined): DurableGenerationRegistry => {
  if (!value) return emptyRegistry();
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Le registre des générations durables est corrompu.');
  }
  const registry = parsed as Partial<DurableGenerationRegistry>;
  if (
    registry.version !== 1 || !registry.counters || typeof registry.counters !== 'object' ||
    !Object.values(registry.counters).every(
      (generation) => Number.isSafeInteger(generation) && generation >= 0,
    )
  ) {
    throw new Error('Le registre des générations durables est corrompu.');
  }
  return registry as DurableGenerationRegistry;
};

export const isDurableGeneration = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

export const allocateDurableGeneration = async (params: {
  settingKey: string;
  identityKey: string;
  transport: DurableGenerationTransport;
}): Promise<number> => {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const setting = await params.transport.dbGetAppSetting(params.settingKey);
    const expectedValueJson = setting?.value_json ?? null;
    const registry = parseRegistry(expectedValueJson);
    const generation = (registry.counters[params.identityKey] ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new Error(`Le compteur de génération durable est épuisé pour ${params.identityKey}.`);
    }
    const result = await params.transport.dbCompareAndSwapAppSetting({
      key: params.settingKey,
      expectedValueJson,
      valueJson: JSON.stringify({
        ...registry,
        counters: {
          ...registry.counters,
          [params.identityKey]: generation,
        },
      }),
    });
    if (result.applied) return generation;
  }
  throw new Error(`Conflit persistant pendant l'allocation de génération pour ${params.identityKey}.`);
};
