/**
 * Skrócony adres IP na liście urządzeń i w historii logowań (krok 8.5).
 *
 * Baza oddaje już tylko sieć (00174, `account_ip_prefix`: IPv4 do /24, IPv6
 * do /48, jak anonimizacja adresów w Google Analytics). Tu powstaje napis do
 * pokazania, a każdy pełny adres i tak traci część hosta: „83.21.104.x”,
 * „2a02:a311:4a3f:…”. Wartość, której nie da się odczytać, to `null`, nie
 * zgadywanie.
 */

const IPV4_OCTET = /^(0|[1-9]\d{0,2})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

function ipv4Octets(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4 || !parts.every((part) => IPV4_OCTET.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function hexGroups(part: string): number[] | null {
  if (part === '') return [];
  const groups = part.split(':');
  return groups.every((group) => IPV6_GROUP.test(group)) ? groups.map((group) => parseInt(group, 16)) : null;
}

/** Osiem grup adresu IPv6, także z „::” i z IPv4 na końcu (`::ffff:1.2.3.4`). */
function ipv6Groups(value: string): number[] | null {
  let text = value;
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const octets = ipv4Octets(last);
    if (!octets) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = hexGroups(halves[0]!);
  const tail = halves.length === 2 ? hexGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  return missing >= 1 ? [...head, ...Array<number>(missing).fill(0), ...tail] : null;
}

/**
 * Pełny adres IPv4 albo IPv6 (bez maski, portu i strefy `%eth0`): tylko taki
 * przyjmie kolumna INET `audit_logs.ip_address` bez wywrócenia zapisu.
 */
export function isIpAddress(value: string): boolean {
  if (!value || value.includes('/')) return false;
  return value.includes(':') ? ipv6Groups(value) !== null : ipv4Octets(value) !== null;
}

export function formatIpPrefix(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim().split('/')[0] ?? '';
  if (!address) return null;

  if (!address.includes(':')) {
    const octets = ipv4Octets(address);
    return octets ? `${octets[0]}.${octets[1]}.${octets[2]}.x` : null;
  }

  const groups = ipv6Groups(address);
  if (!groups) return null;
  // IPv4 zapisany jako IPv6 (::ffff:a.b.c.d) pokazujemy jak IPv4.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.x`;
  }
  return `${groups.slice(0, 3).map((group) => group.toString(16)).join(':')}:…`;
}
