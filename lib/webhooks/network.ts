import { lookup } from 'node:dns/promises';

import { createHttpsTransport } from '@/lib/webhooks/transport';
import type { ResolvedAddress } from '@/lib/webhooks/url-guard';

/**
 * Prawdziwa sieć webhooków: DNS systemu (wszystkie adresy A i AAAA) i transport
 * HTTPS. Osobny moduł, żeby testy podmieniały tylko sieć (atrapa DNS i HTTP),
 * a całą resztę ścieżki sprawdzały naprawdę.
 *
 * IPv4 najpierw: kontenery na Hetznerze nie mają domyślnie łączności IPv6,
 * a transport łączy się z pierwszym adresem. Sprawdzane są i tak wszystkie.
 */

export async function resolveHost(hostname: string): Promise<ResolvedAddress[]> {
  const entries = await lookup(hostname, { all: true, order: 'ipv4first' });
  return entries
    .filter((entry) => entry.family === 4 || entry.family === 6)
    .map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

export const httpsTransport = createHttpsTransport();
