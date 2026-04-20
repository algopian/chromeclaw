type NetworkStatus = 'online' | 'offline';

interface NetworkStatusMessage {
  type: 'NETWORK_STATUS';
  status: NetworkStatus;
}

export type { NetworkStatus, NetworkStatusMessage };
