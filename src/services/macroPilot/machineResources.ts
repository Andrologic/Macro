import { validateContentMessage, type ContentHostTelemetry, type ContentProjectIcon, type ContentProjectRef } from './contentProtocol';

export const MACHINE_CAPABILITIES = ['host-telemetry-1', 'project-icons-1'] as const;
export const MACHINE_OPERATIONS = new Set(['instance.telemetry', 'project.icon']);
export const ICON_LIMIT = { encodedBytes: 131072, rawBytes: 98304, entries: 64, cacheBytes: 8 * 1024 * 1024, ttlMs: 300000 } as const;
export interface MachineResourceSource {
  /** Local-only native monotonic budget. Omitted by sources without that guarantee. */
  telemetry(): Promise<Omit<ContentHostTelemetry, 'instance_id'> & { reuseForMs?: number | null }>;
  /** Local fingerprint changes when the project disappears, moves or changes workspace. */
  projectKey(ref: ContentProjectRef): string | null;
  icon(projectId: string): Promise<{ dataUrl: string; revision: string } | null>;
}
const digest = async (bytes: Uint8Array): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('');
const supportedSignature = (mime: string, bytes: Uint8Array): boolean => {
  if (mime === 'image/png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  if (mime === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  if (mime === 'image/webp') return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP' && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 === bytes.length;
  return false;
};
/** Per-host cache bounds wire resources and keeps local context out of responses. */
export class MachineResources {
  private readonly icons = new Map<string, { context: string; expires: number; icon: NonNullable<ContentProjectIcon['icon']> }>();
  private sample?: { value: Omit<ContentHostTelemetry, 'instance_id'>; deadline: number; generation: number };
  private readonly telemetryLifetimes = new WeakMap<object, { deadline: number; generation: number }>();
  private generation = 0;
  private previousClock?: { utc: number; monotonic: number };
  constructor(private readonly source: MachineResourceSource, private readonly now = Date.now, private readonly monotonicNow = () => performance.now()) {}
  clear(): void { this.icons.clear(); this.sample = undefined; this.generation++; }
  private clock(): { utc: number; monotonic: number } {
    const current = { utc: this.now(), monotonic: this.monotonicNow() };
    if (!Number.isFinite(current.utc) || !Number.isFinite(current.monotonic) ||
      (this.previousClock && (current.utc < this.previousClock.utc || current.monotonic < this.previousClock.monotonic))) this.clear();
    this.previousClock = current;
    return current;
  }
  /** The response keeps its own lifetime even after another sample replaces the slot. */
  validateTelemetry(sample: ContentHostTelemetry): void {
    const clock = this.clock();
    const lifetime = this.telemetryLifetimes.get(sample);
    if (lifetime && (lifetime.generation !== this.generation || !Number.isFinite(lifetime.deadline) ||
      !Number.isFinite(clock.monotonic) || clock.monotonic >= lifetime.deadline)) throw new Error('snapshot_expired');
    if (!Number.isFinite(clock.utc) || !Number.isFinite(Date.parse(sample.observed_at)) || !Number.isFinite(Date.parse(sample.expires_at)) ||
      Date.parse(sample.observed_at) > clock.utc || Date.parse(sample.expires_at) <= clock.utc) throw new Error('snapshot_expired');
  }
  async telemetry(instanceId: string): Promise<ContentHostTelemetry> {
    // The native budget starts inside the IPC. Anchoring before it also pays
    // for measurement and transport instead of extending the sample on return.
    const started = this.clock();
    let entry = this.sample;
    if (entry && (entry.generation !== this.generation || started.monotonic >= entry.deadline ||
      started.utc < Date.parse(entry.value.observed_at) || started.utc >= Date.parse(entry.value.expires_at))) this.sample = entry = undefined;
    if (!entry) {
      const generation = this.generation;
      const { reuseForMs, ...value } = await this.source.telemetry();
      const returned = this.clock();
      const response = { ...value, instance_id: instanceId };
      if (typeof reuseForMs === 'number' && Number.isInteger(reuseForMs) && reuseForMs >= 0 && reuseForMs <= 5000) {
        const lifetime = { deadline: started.monotonic + reuseForMs, generation };
        this.telemetryLifetimes.set(response, lifetime);
        if (generation === this.generation && Number.isFinite(returned.monotonic) && returned.monotonic < lifetime.deadline &&
          Date.parse(value.observed_at) <= returned.utc && returned.utc < Date.parse(value.expires_at) &&
          validateContentMessage({ contract_version: '2.0', type: 'response', account_id: 'validation', request_id: 'validation', operation: 'instance.telemetry', result: response })) {
          this.sample = { value, ...lifetime };
        }
      }
      return response;
    }
    const response = { ...entry.value, instance_id: instanceId };
    this.telemetryLifetimes.set(response, { deadline: entry.deadline, generation: entry.generation });
    return response;
  }
  context(ref: ContentProjectRef): string {
    const key = this.source.projectKey(ref);
    const cacheKey = JSON.stringify(ref);
    if (key === null) { this.icons.delete(cacheKey); throw new Error('not_found'); }
    if (this.icons.get(cacheKey)?.context !== key) this.icons.delete(cacheKey);
    return key;
  }
  validate(ref: ContentProjectRef, context: string): void {
    if (this.context(ref) !== context) { this.icons.delete(JSON.stringify(ref)); throw new Error('snapshot_expired'); }
  }
  async icon(ref: ContentProjectRef, context: string): Promise<ContentProjectIcon> {
    this.validate(ref, context);
    // Resolve each consultation to detect file/hash changes even inside the cache TTL.
    const candidate = await this.source.icon(ref.project_id);
    this.validate(ref, context);
    const observed = this.now();
    const result: ContentProjectIcon = { ref, observed_at: new Date(observed).toISOString(), expires_at: new Date(observed + ICON_LIMIT.ttlMs).toISOString(), availability: 'unavailable', icon: null };
    const key = JSON.stringify(ref);
    for (const [id, entry] of this.icons) if (entry.expires <= observed) this.icons.delete(id);
    if (!candidate || candidate.dataUrl.length > ICON_LIMIT.encodedBytes + 32) { this.icons.delete(key); return result; }
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(candidate.dataUrl);
    if (!match || match[2].length > ICON_LIMIT.encodedBytes || match[2].length % 4 !== 0) { this.icons.delete(key); return result; }
    let binary: string;
    try { binary = atob(match[2]); } catch { this.icons.delete(key); return result; }
    if (btoa(binary) !== match[2] || binary.length === 0 || binary.length > ICON_LIMIT.rawBytes) { this.icons.delete(key); return result; }
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    if (!supportedSignature(match[1], bytes)) { this.icons.delete(key); return result; }
    const hash = await digest(bytes);
    this.validate(ref, context);
    if (candidate.revision !== hash) { this.icons.delete(key); return result; }
    const previous = this.icons.get(key);
    const icon = previous?.context === context && previous.icon.sha256 === hash ? previous.icon : {
      resource_id: `icon:${await digest(new TextEncoder().encode(JSON.stringify([ref, hash])))}`,
      sha256: hash, mime_type: match[1] as NonNullable<ContentProjectIcon['icon']>['mime_type'], size_bytes: bytes.length, data_base64: match[2],
    };
    this.icons.delete(key);
    this.icons.set(key, { context, expires: observed + ICON_LIMIT.ttlMs, icon });
    while (this.icons.size > ICON_LIMIT.entries || [...this.icons.values()].reduce((size, entry) => size + entry.icon.data_base64.length, 0) > ICON_LIMIT.cacheBytes) this.icons.delete(this.icons.keys().next().value!);
    return { ...result, availability: 'available', icon };
  }
}
