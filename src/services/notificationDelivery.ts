/** Session-only pending deliveries. Attaching a renderer drains each ID once. */
export function createNotificationDelivery<T>() {
  const pending = new Map<string | number, T>();
  let renderer: ((id: string | number, payload: T) => void) | undefined;
  return {
    deliver(id: string | number, payload: T): void {
      if (renderer) renderer(id, payload);
      else pending.set(id, payload);
    },
    dismiss(id?: string | number): void {
      if (id === undefined) pending.clear();
      else pending.delete(id);
    },
    attach(next: (id: string | number, payload: T) => void): () => void {
      if (renderer) throw new Error('Notification renderer already attached');
      renderer = next;
      try {
        for (const [id, payload] of pending) {
          next(id, payload);
          pending.delete(id);
        }
      } catch (error) {
        renderer = undefined;
        throw error;
      }
      return () => { if (renderer === next) renderer = undefined; };
    },
  };
}
