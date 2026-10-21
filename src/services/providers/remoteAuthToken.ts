// This secret is supplied at runtime and kept only in memory. Vite environment
// variables and browser storage are unsuitable for a bearer token.
let remoteAuthToken: string | null = null;

export const setRemoteAuthToken = (token: string | null): void => {
  remoteAuthToken = token?.trim() || null;
};

export const getRemoteAuthToken = (): string | null => {
  if (remoteAuthToken) return remoteAuthToken;
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') return null;

  const supplied = window.prompt('Macro headless bearer token');
  setRemoteAuthToken(supplied);
  return remoteAuthToken;
};
