/** Consumer lifetime; durable operations keep their own immutable domain identity. */
export interface LifecycleContext {
  readonly signal: AbortSignal;
  isActive(): boolean;
  assertActive(): void;
}
