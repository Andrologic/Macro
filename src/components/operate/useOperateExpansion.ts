import { useCallback, useEffect, useRef, useState } from 'react';
import { pruneOperateExpansion } from './operateColumnModel';

export const OPERATE_EXPANSION_STORAGE_KEY = 'macro.operate.expanded';
const DEFAULT_EXPANDED: readonly string[] = ['section:active'];

// A per-machine comfort setting: never required, so every access tolerates a blocked store.
function readExpanded(): readonly string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(OPERATE_EXPANSION_STORAGE_KEY) ?? 'null');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : DEFAULT_EXPANDED;
  } catch {
    return DEFAULT_EXPANDED;
  }
}
function writeExpanded(ids: readonly string[]) {
  try { window.localStorage.setItem(OPERATE_EXPANSION_STORAGE_KEY, JSON.stringify(ids)); } catch { /* not remembered */ }
}

/**
 * Which sections and runs are unfolded. Ids are `section:<name>` and
 * `run:<runKey>`; runs that disappeared are forgotten when the list is saved.
 */
export function useOperateExpansion(knownRunKeys: ReadonlySet<string>) {
  const [expanded, setExpanded] = useState(readExpanded);
  const latest = useRef(expanded);
  const known = useRef(knownRunKeys);
  useEffect(() => { known.current = knownRunKeys; }, [knownRunKeys]);
  const toggle = useCallback((id: string) => {
    const current = latest.current;
    const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id];
    latest.current = next;
    setExpanded(next);
    // While runs are still loading nothing is known yet: keep every remembered id.
    writeExpanded(known.current.size ? pruneOperateExpansion(next, known.current) : next);
  }, []);
  return { isExpanded: (id: string) => expanded.includes(id), toggle };
}
