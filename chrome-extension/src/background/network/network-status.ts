import { createLogger } from '../logging';
import type { NetworkStatus, NetworkStatusMessage } from '@extension/shared';

const log = createLogger('general');

let wasOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

const broadcast = (status: NetworkStatus): void => {
  if (status === 'online') log.debug('network online (offline→online transition)');
  else log.warn('network offline (online→offline transition)');

  const message: NetworkStatusMessage = { type: 'NETWORK_STATUS', status };
  chrome.runtime.sendMessage(message).catch(() => {});
};

const initNetworkStatus = (): void => {
  self.addEventListener('online', () => {
    if (!wasOffline) return;
    wasOffline = false;
    broadcast('online');
  });
  self.addEventListener('offline', () => {
    if (wasOffline) return;
    wasOffline = true;
    broadcast('offline');
  });
};

export { initNetworkStatus };
