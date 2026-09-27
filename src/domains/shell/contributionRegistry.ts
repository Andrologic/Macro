/** Internal trusted contributions only. IDs are UI identities, never tool modes. */
export interface Contribution<Context = void> {
  readonly id: string;
  readonly owner: string;
  readonly order: number;
  readonly available?: (context: Context) => boolean;
}

export class ContributionRegistry<T extends Contribution<Context>, Context = void> {
  private entries = new Map<string, { value: T; active: boolean }>();
  private listeners = new Set<() => void>();
  private revision = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getRevision = (): number => this.revision;

  private changed(): void {
    this.revision += 1;
    this.listeners.forEach((listener) => listener());
  }

  register(contribution: T): () => void {
    if (!contribution.id.trim() || !contribution.owner.trim() || !Number.isFinite(contribution.order)) {
      throw new Error('A contribution requires a stable ID, owner and finite order');
    }
    if (this.entries.has(contribution.id)) throw new Error(`Duplicate contribution: ${contribution.id}`);
    const entry = { value: Object.freeze({ ...contribution }) as T, active: true };
    this.entries.set(contribution.id, entry);
    this.changed();
    return () => {
      if (this.entries.get(contribution.id) !== entry) return;
      this.entries.delete(contribution.id);
      this.changed();
    };
  }

  setActive(id: string, active: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown contribution: ${id}`);
    if (entry.active === active) return;
    entry.active = active;
    this.changed();
  }

  removeOwner(owner: string): void {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (entry.value.owner !== owner) continue;
      this.entries.delete(id);
      changed = true;
    }
    if (changed) this.changed();
  }

  all(): readonly T[] {
    return [...this.entries.values()].map((entry) => entry.value).sort((a, b) =>
      a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get(id: string, context: Context): T | undefined {
    const entry = this.entries.get(id);
    return entry?.active && (entry.value.available?.(context) ?? true) ? entry.value : undefined;
  }

  list(context: Context): readonly T[] {
    return this.all().filter((value) => this.get(value.id, context) !== undefined);
  }
}
