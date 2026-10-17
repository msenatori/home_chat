// LAN-only guard. The server listens dual-stack, and the home network hands out
// *global* IPv6 addresses, so binding to "::" alone could make the app reachable
// from the internet if the router lets inbound IPv6 through. We only accept
// clients from private IPv4 ranges, loopback, IPv6 link-local / ULA, and global
// IPv6 addresses inside the same /64 prefixes as this machine's own interfaces.
import os from 'node:os';
import net from 'node:net';

function v4ToInt(ip) {
  return ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
}

const V4_PRIVATE = [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16],
].map(([base, bits]) => [v4ToInt(base), bits]);

function v4Allowed(ip) {
  const n = v4ToInt(ip);
  return V4_PRIVATE.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
}

// Expand an IPv6 address to 8 groups of 16 bits.
function v6Groups(ip) {
  ip = ip.split('%')[0].toLowerCase();
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
}

let localPrefixes = new Set();
function refreshPrefixes() {
  const set = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv6' && !a.internal) set.add(v6Groups(a.address).slice(0, 4).join(':'));
    }
  }
  localPrefixes = set;
}
refreshPrefixes();
setInterval(refreshPrefixes, 5 * 60_000).unref();

export function isLanAddress(addr) {
  if (!addr) return false;
  if (addr.startsWith('::ffff:') && net.isIPv4(addr.slice(7))) return v4Allowed(addr.slice(7));
  if (net.isIPv4(addr)) return v4Allowed(addr);
  if (!net.isIPv6(addr.split('%')[0])) return false;
  const g = v6Groups(addr);
  if (g.every((x, i) => (i < 7 ? x === 0 : x === 1))) return true;  // ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true;                      // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true;                      // ULA fc00::/7
  return localPrefixes.has(g.slice(0, 4).join(':'));                 // same /64 as this host
}
