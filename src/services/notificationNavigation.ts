import type { WorkflowNotificationNavigation } from './workflowNotificationNavigation';

type OpenNotificationContext = (navigation: WorkflowNotificationNavigation) => Promise<void>;
let openContext: OpenNotificationContext | undefined;

export function installNotificationNavigation(open: OpenNotificationContext): () => void {
  if (openContext) throw new Error('Notification navigation already installed');
  openContext = open;
  return () => { if (openContext === open) openContext = undefined; };
}

export function navigateFromNotification(navigation: WorkflowNotificationNavigation): Promise<void> {
  if (!openContext) return Promise.reject(new Error('Notification navigation is not initialized'));
  return openContext(navigation);
}
