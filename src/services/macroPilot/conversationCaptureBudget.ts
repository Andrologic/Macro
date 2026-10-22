// Declared conservative units, not a JavaScript heap/RSS measurement. Count
// UTF-16 lengths before serializing; six covers JSON escaping and UTF-8.
export function captureCost(value: unknown, limit: number): { retained: number; scratch: number } {
  const ancestors = new Set<object>();
  const bounded = (n: number) => { if (!Number.isSafeInteger(n) || n > limit) throw new Error('resource_limit'); return n; };
  const walk = (value: unknown, depth: number): { json: number; retained: number; fragments: number; nodes: number } => {
    if (depth > 64) throw new Error('resource_limit');
    if (value === null || typeof value !== 'object') {
      if (!['undefined', 'string', 'number', 'boolean'].includes(typeof value) && value !== null) throw new Error('unavailable');
      const json = bounded(typeof value === 'string' ? 2 + 6 * value.length : 32);
      return { json, retained: json, fragments: json, nodes: 1 };
    }
    if (ancestors.has(value)) throw new Error('unavailable');
    ancestors.add(value);
    let json = 2, retained = 64, fragments = 0, nodes = 1;
    const field = (entry: unknown, key?: string) => {
      const cost = walk(entry, depth + 1); const keyBytes = key === undefined ? 0 : 3 + 6 * key.length;
      json = bounded(json + cost.json + keyBytes + 1);
      retained = bounded(retained + cost.retained + keyBytes + 32);
      fragments += cost.fragments + keyBytes; nodes = bounded(nodes + cost.nodes);
    };
    if (Array.isArray(value)) {
      bounded(value.length * 32);
      for (let i = 0; i < value.length; i++) field(value[i]);
    } else {
      for (const key in value) if (Object.hasOwn(value, key)) field((value as Record<string, unknown>)[key], key);
    }
    ancestors.delete(value);
    return { json, retained, fragments: fragments + json, nodes };
  };
  const cost = walk(value, 0);
  return { retained: cost.retained, scratch: 4 * cost.fragments + cost.json + 32 * cost.nodes };
}
/** Upper bound before JSON.parse, including containers and keys. Counting syntax
 * inside strings can only overcharge; no second parser or large array is needed. */
export function parsedCaptureCost(text: string, limit: number): number {
  let bytes = 64 + 6 * text.length;
  for (let i = 0; i < text.length && bytes <= limit; i++) {
    if (text[i] === '{' || text[i] === '[') bytes += 96;
    else if (text[i] === ':' || text[i] === ',') bytes += 32;
  }
  if (!Number.isSafeInteger(bytes) || bytes > limit) throw new Error('resource_limit');
  return bytes;
}
