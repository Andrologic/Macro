import { create } from 'zustand';

export const usePersistenceHealth = create<{ issues: Record<string, string> }>(() => ({ issues: {} }));

/** Keep recovery failures visible until the affected storage succeeds again. */
export const reportPersistenceIssue = (key: string, message: string): void => {
  usePersistenceHealth.setState(({ issues }) => ({ issues: { ...issues, [key]: message } }));
};

export const clearPersistenceIssue = (key: string): void => {
  usePersistenceHealth.setState(({ issues }) => {
    const next = { ...issues };
    delete next[key];
    return { issues: next };
  });
};
