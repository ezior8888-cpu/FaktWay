import { fakeSupabase, type MemoryDb, type Row } from './fake-supabase-memory';

/**
 * Atrapy do testów pomiaru (FAKTWAY-1-0, sekcja 3 pkt 7): baza w pamięci z RPC
 * właściciela firmy i PostHog, który sklei zdarzenia tak jak jego magazyn.
 * Prawdziwe uprawnienia, wyzwalacze i SQL sprawdza tests/rls-lejek-analityka.test.ts.
 */

/** Klient admina: tabele z `fakeSupabase`, RPC właściciela jak w 00161. */
export function lejekClient(db: MemoryDb, inne: Record<string, unknown> = {}) {
  return {
    ...fakeSupabase(db),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'analytics_tenant_owner') {
        const failure = db.failures['rpc:analytics_tenant_owner'];
        if (failure) return { data: null, error: failure };
        const owners = (db.tables.memberships ?? [])
          .filter((m) => m.organization_id === args.p_tenant_id && m.role === 'owner' && m.status === 'active')
          .sort((a, b) => String(a.joined_at).localeCompare(String(b.joined_at)));
        return { data: owners[0]?.user_id ?? null, error: null };
      }
      if (fn in inne) return { data: inne[fn], error: null };
      throw new Error('Nieoczekiwane RPC: ' + fn);
    },
  };
}

export interface PosthogMessage {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown> & { $set?: Row; $set_once?: Row };
  groups?: Record<string, string>;
  uuid?: string;
  timestamp?: Date;
}

/**
 * Klient PostHog: zapisuje każde wywołanie. `sklejone()` liczy zdarzenia po
 * kluczu sortowania magazynu PostHog (data z `timestamp`, nazwa, distinct id,
 * uuid), czyli tak, jak zobaczy je wykres po scaleniu duplikatów.
 */
export function fakePosthog() {
  const messages: PosthogMessage[] = [];
  return {
    messages,
    capture: (message: PosthogMessage) => {
      messages.push(message);
    },
    identify: () => undefined,
    flush: async () => undefined,
    nazwy: () => messages.map((m) => m.event),
    sklejone(event?: string): PosthogMessage[] {
      const seen = new Map<string, PosthogMessage>();
      for (const m of messages) {
        if (event && m.event !== event) continue;
        const day = (m.timestamp ?? new Date()).toISOString().slice(0, 10);
        // Bez uuid SDK nadaje świeży uuidv7, więc takie zdarzenia nigdy się nie sklejają.
        const key = [day, m.event, m.distinctId, m.uuid ?? `brak-${seen.size}`].join('|');
        if (!seen.has(key)) seen.set(key, m);
      }
      return [...seen.values()];
    },
  };
}
