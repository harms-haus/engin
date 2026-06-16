import { networkInterfaces } from 'node:os';

/**
 * Returns the first non-loopback, non-docker, non-link-local IPv4 address
 * found on the system, or `null` if no suitable interface exists.
 */
export function getLocalNetworkIP(): string | null {
  const interfaces = networkInterfaces();

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue;

    if (name.startsWith('lo') || name.startsWith('docker')) {
      continue;
    }

    for (const addr of addresses) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
        return addr.address;
      }
    }
  }

  return null;
}
