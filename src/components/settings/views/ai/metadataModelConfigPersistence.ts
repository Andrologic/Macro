import {
  metadataModelConfigsEqual,
  type MetadataModelConfig,
} from '../../../../services/metadataModelConfig';

type MetadataModelConfigPersistenceOptions = {
  save: (config: MetadataModelConfig) => Promise<unknown>;
  applyConfig: (config: MetadataModelConfig | null) => void;
  onSaveError: (error: unknown) => void;
};

/**
 * Serializes local metadata-model writes while keeping the latest UI choice
 * authoritative over persistence echoes from older writes.
 */
export class MetadataModelConfigPersistence {
  private version = 0;
  private queue: Promise<void> = Promise.resolve();
  private latestRequested: MetadataModelConfig | null = null;
  private persisted: MetadataModelConfig | null = null;

  constructor(private readonly options: MetadataModelConfigPersistenceOptions) {}

  hydrate(config: MetadataModelConfig | null, hydrationVersion: number): boolean {
    if (hydrationVersion !== this.version) return false;
    this.persisted = config;
    this.options.applyConfig(config);
    return true;
  }

  getVersion(): number {
    return this.version;
  }

  acceptExternal(config: MetadataModelConfig | null): boolean {
    if (
      this.latestRequested &&
      !metadataModelConfigsEqual(config, this.latestRequested)
    ) {
      return false;
    }

    this.latestRequested = null;
    this.version += 1;
    this.persisted = config;
    this.options.applyConfig(config);
    return true;
  }

  persist(config: MetadataModelConfig): Promise<void> {
    const requestVersion = this.version + 1;
    this.version = requestVersion;
    this.latestRequested = config;
    this.options.applyConfig(config);

    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        await this.options.save(config);
        this.persisted = config;
        if (this.version === requestVersion && this.latestRequested === config) {
          this.latestRequested = null;
        }
      })
      .catch((error) => {
        if (this.version === requestVersion && this.latestRequested === config) {
          this.latestRequested = null;
          this.options.applyConfig(this.persisted);
        }
        this.options.onSaveError(error);
      });

    return this.queue;
  }
}
