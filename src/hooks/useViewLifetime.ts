import { useCallback, useLayoutEffect, useRef } from 'react';

/** Capture a view operation without changing the lifetime of its domain session. */
export function useViewLifetime(key: string): () => (() => boolean) {
  const lifetime = useRef({ key, active: false });
  useLayoutEffect(() => {
    const owner = { key, active: true };
    lifetime.current = owner;
    return () => { lifetime.current = { key, active: false }; };
  }, [key]);
  return useCallback(() => {
    const owner = lifetime.current;
    return () => owner.active && owner.key === key && lifetime.current === owner;
  }, [key]);
}
