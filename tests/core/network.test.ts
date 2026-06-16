import { describe, expect, it, mock } from 'bun:test';
import type { NetworkInterfaceInfo } from 'node:os';

// ─── Mock node:os ──────────────────────────────────────────────────────────

const mockNetworkInterfaces = mock<() => NodeJS.Dict<NetworkInterfaceInfo[]>>();

mock.module('node:os', () => ({
  networkInterfaces: mockNetworkInterfaces,
}));

// ─── Import after mock ─────────────────────────────────────────────────────

import { getLocalNetworkIP } from '../../packages/engine/src/core/network.js';

// ─── Test data ─────────────────────────────────────────────────────────────

function makeLoopback(): NetworkInterfaceInfo[] {
  return [
    {
      family: 'IPv4',
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      mac: '00:00:00:00:00:00',
      internal: true,
      cidr: '127.0.0.1/8',
    },
  ];
}

function makeLanIPv4(): NetworkInterfaceInfo[] {
  return [
    {
      family: 'IPv4',
      address: '192.168.1.100',
      netmask: '255.255.255.0',
      mac: 'aa:bb:cc:dd:ee:ff',
      internal: false,
      cidr: '192.168.1.100/24',
    },
  ];
}

function makeLinkLocal(): NetworkInterfaceInfo[] {
  return [
    {
      family: 'IPv4',
      address: '169.254.1.42',
      netmask: '255.255.0.0',
      mac: '11:22:33:44:55:66',
      internal: false,
      cidr: '169.254.1.42/16',
    },
  ];
}

function makeIPv6Only(): NetworkInterfaceInfo[] {
  return [
    {
      family: 'IPv6',
      address: 'fe80::1',
      netmask: 'ffff:ffff:ffff:ffff::',
      mac: 'aa:bb:cc:dd:ee:ff',
      internal: false,
      cidr: 'fe80::1/64',
      scopeid: 2,
    },
  ];
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('getLocalNetworkIP', () => {
  it('returns the LAN IPv4 address when loopback, LAN, and link-local are present', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: makeLoopback(),
      eth0: makeLanIPv4(),
      docker0: makeLoopback(),
    });

    const result = getLocalNetworkIP();
    expect(result).toBe('192.168.1.100');
  });

  it('skips loopback interfaces (names starting with "lo")', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: makeLoopback(),
      lo0: makeLoopback(),
    });

    const result = getLocalNetworkIP();
    expect(result).toBeNull();
  });

  it('skips docker interfaces (names starting with "docker")', () => {
    mockNetworkInterfaces.mockReturnValue({
      docker0: makeLanIPv4(),
      docker_gwbridge: makeLanIPv4(),
    });

    const result = getLocalNetworkIP();
    expect(result).toBeNull();
  });

  it('skips link-local addresses (169.254.x.x)', () => {
    mockNetworkInterfaces.mockReturnValue({
      eth0: makeLinkLocal(),
    });

    const result = getLocalNetworkIP();
    expect(result).toBeNull();
  });

  it('returns null when no suitable interface exists', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: makeLoopback(),
    });

    const result = getLocalNetworkIP();
    expect(result).toBeNull();
  });

  it('returns null when networkInterfaces returns empty object', () => {
    mockNetworkInterfaces.mockReturnValue({});

    const result = getLocalNetworkIP();
    expect(result).toBeNull();
  });

  it('skips IPv6-only interfaces', () => {
    mockNetworkInterfaces.mockReturnValue({
      eth0: makeIPv6Only(),
    });

    const result = getLocalNetworkIP();
    expect(result).toBeNull();
  });

  it('returns the first suitable IPv4 when multiple interfaces exist', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: makeLoopback(),
      wlan0: [
        {
          family: 'IPv4',
          address: '10.0.0.5',
          netmask: '255.0.0.0',
          mac: '11:22:33:44:55:66',
          internal: false,
          cidr: '10.0.0.5/8',
        },
      ],
      eth0: makeLanIPv4(),
    });

    // wlan0 comes before eth0 in iteration order
    const result = getLocalNetworkIP();
    expect(result).toBe('10.0.0.5');
  });

  it('ignores entries with null/undefined address array', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: null as unknown as NetworkInterfaceInfo[],
      eth0: makeLanIPv4(),
    });

    const result = getLocalNetworkIP();
    expect(result).toBe('192.168.1.100');
  });

  it('returns null when all interfaces are either loopback, docker, link-local, or internal', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: makeLoopback(),
      docker0: makeLoopback(),
      eth0: [
        {
          family: 'IPv4',
          address: '169.254.0.1',
          netmask: '255.255.0.0',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: '169.254.0.1/16',
        },
        {
          family: 'IPv4',
          address: '127.0.0.2',
          netmask: '255.0.0.0',
          mac: '00:00:00:00:00:01',
          internal: true,
          cidr: '127.0.0.2/8',
        },
      ],
    });

    const result = getLocalNetworkIP();
    expect(result).toBeNull();
  });
});
