import { useCallback, useEffect, useRef, useState } from 'react';
import { loadPreference, savePreference, PREF_KEYS } from '../services/preferences';
import { emptyBlueprintFolders, normalizeBlueprintFolders, type BlueprintFolderOrganization } from '../services/blueprintFolders';

/** Keep writes serial and retain the last confirmed organization on failure. */
export function useBlueprintFolders(onError: () => void) {
  const [organization, setOrganization] = useState(emptyBlueprintFolders);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const errorHandler = useRef(onError);
  useEffect(() => { errorHandler.current = onError; }, [onError]);
  useEffect(() => {
    let active = true;
    void loadPreference(PREF_KEYS.ARCHITECT_BLUEPRINT_FOLDERS).then(value => {
      if (!active) return;
      setOrganization(normalizeBlueprintFolders(value));
      setReady(true);
    }).catch(() => { if (active) errorHandler.current(); });
    return () => { active = false; };
  }, []);
  const update = useCallback(async (next: BlueprintFolderOrganization): Promise<boolean> => {
    if (!ready || writing.current) return false;
    writing.current = true;
    setBusy(true);
    try {
      await savePreference(PREF_KEYS.ARCHITECT_BLUEPRINT_FOLDERS, next);
      setOrganization(next);
      return true;
    } catch {
      errorHandler.current();
      return false;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }, [ready]);
  return { organization, ready, busy, update };
}
