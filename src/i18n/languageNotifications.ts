import { createNotificationDelivery } from '../services/notificationDelivery';

const delivery = createNotificationDelivery<string>();
let sequence = 0;

/** Translated at the time of the change, including changes before composition. */
export function reportLanguageChange(message: string): void {
  delivery.deliver(++sequence, message);
}

export function installLanguageNotifications(success: (message: string) => void): () => void {
  return delivery.attach((_id, message) => success(message));
}
