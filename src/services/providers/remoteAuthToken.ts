// This secret is supplied at runtime and kept only in memory. Vite environment
// variables and browser storage are unsuitable for a bearer token.
import i18n from '../../i18n';

let remoteAuthToken: string | null = null;
let remoteApprovalToken: string | null = null;

export const setRemoteAuthToken = (token: string | null): void => {
  remoteAuthToken = token?.trim() || null;
};

export const getRemoteAuthToken = (): string | null => {
  if (remoteAuthToken) return remoteAuthToken;
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') return null;

  const supplied = window.prompt(i18n.t('remoteAuth.agentPrompt'));
  setRemoteAuthToken(supplied);
  return remoteAuthToken;
};

export const setRemoteApprovalToken = (token: string | null): void => {
  remoteApprovalToken = token?.trim() || null;
};

export const takeRemoteApprovalToken = (): string | null => {
  const configured = remoteApprovalToken;
  remoteApprovalToken = null;
  if (configured) return configured;
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') return null;

  const supplied = window.prompt(i18n.t('remoteAuth.approvalPrompt'));
  return supplied?.trim() || null;
};
