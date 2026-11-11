import { createHash } from 'node:crypto';

/**
 * Harness „pełnej ścieżki” wysyłki do KSeF dla testów runnera: atrapa HTTP
 * KSeF (sesje, faktury, wykrywanie duplikatu po numerze faktury jak w KSeF,
 * lista faktur sesji, pobranie faktury po numerze KSeF) i baza w pamięci dla
 * klienta serwisowego (`@/lib/supabase/admin`). Prawdziwe zostają runner,
 * `submitInvoiceFullFlow`, `submitInvoice`, generator FA(3), `submission-log`.
 *
 * Użycie w pliku testu (fabryki `vi.mock` importują ten moduł dynamicznie,
 * stan żyje w `vi.hoisted`):
 *
 *   const m = vi.hoisted(() => ({ ksef: null as unknown as FakeKsef, db: {}, failWrite: null }));
 *   vi.mock('@/lib/ksef/client', async (orig) =>
 *     (await import('./helpers/ksef-pelna-sciezka')).ksefClientModule(await orig(), () => m.ksef));
 */

export type Row = Record<string, unknown>;

export interface StoredInvoice {
  referenceNumber: string;
  invoiceNumber: string;
  invoiceHash: string;
  code: number;
  ksefNumber: string | null;
  /** Treść pliku, którą KSeF oddaje przy `GET /invoices/ksef/{ksefNumber}`. */
  xml: string;
  /** Data nadania numeru KSeF (status i metadane). */
  acquisitionDate?: string;
  originalSession?: string;
  originalKsef?: string;
  /** Odrzucenie w statusie (kod 4xx): opis i szczegóły, które KSeF oddaje w `status`. */
  rejection?: { description: string; details: string[] };
}

/** Odrzucenie faktury w statusie, jak odpowiada walidator KSeF (np. 450 ze szczegółami). */
export interface StatusRejection {
  code: number;
  description: string;
  details: string[];
}

export interface FakeKsef {
  sessions: Map<string, { open: boolean; invoices: StoredInvoice[] }>;
  invoicePosts: number;
  downloads: number;
  seq: number;
  /** KSeF przyjmuje plik, ale odpowiedź nie dociera (nasz timeout 408). */
  loseInvoicePostResponse: boolean;
  /** Żądanie nie dociera do KSeF (timeout 408 przed przyjęciem pliku). */
  dropInvoicePost: boolean;
  /** KSeF odmawia przyjęcia pliku (HTTP 4xx). */
  rejectInvoicePost: number | null;
  statusFails: boolean;
  listFails: boolean;
  /** Pobranie faktury po numerze KSeF kończy się tym statusem HTTP (i kodem KSeF), zamiast pliku. */
  downloadFailure: { status: number; code?: number } | null;
  /** Zapytanie o metadane faktur kończy się błędem HTTP. */
  metadataFails: boolean;
  /** KSeF przyjmuje plik, a potem odrzuca fakturę w statusie (bez numeru KSeF). */
  statusRejection: StatusRejection | null;
}

export function freshKsef(): FakeKsef {
  return {
    sessions: new Map(),
    invoicePosts: 0,
    downloads: 0,
    seq: 0,
    loseInvoicePostResponse: false,
    dropInvoicePost: false,
    rejectInvoicePost: null,
    statusFails: false,
    listFails: false,
    downloadFailure: null,
    metadataFails: false,
    statusRejection: null,
  };
}

export const sha256Base64 = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64');
export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Faktura, którą KSeF już ma — np. wystawiona w innym programie albo przed historią wysyłek. */
export const SEEDED_ACQUISITION = '2026-09-30T08:00:00.000Z';

export function seedKsefInvoice(
  k: FakeKsef,
  input: { session: string; ksefNumber: string; xml: string; acquisitionDate?: string },
): void {
  const invoiceNumber = /<(?:\w+:)?P_2>([^<]*)<\/(?:\w+:)?P_2>/.exec(input.xml)?.[1] ?? '';
  const session = k.sessions.get(input.session) ?? { open: false, invoices: [] };
  session.invoices.push({
    referenceNumber: `I-${input.session}`,
    invoiceNumber,
    invoiceHash: sha256Base64(input.xml),
    code: 200,
    ksefNumber: input.ksefNumber,
    xml: input.xml,
    acquisitionDate: input.acquisitionDate ?? SEEDED_ACQUISITION,
  });
  k.sessions.set(input.session, session);
}

function statusReply(inv: StoredInvoice) {
  return {
    referenceNumber: inv.referenceNumber,
    invoiceHash: inv.invoiceHash,
    ksefNumber: inv.ksefNumber ?? undefined,
    acquisitionTimestamp: inv.ksefNumber ? (inv.acquisitionDate ?? '2026-10-01T10:00:00Z') : undefined,
    status: inv.code === 440
      ? { code: 440, description: 'Duplikat faktury', details: ['Duplikat faktury'],
          extensions: { originalSessionReferenceNumber: inv.originalSession, originalKsefNumber: inv.originalKsef } }
      : inv.rejection
        ? { code: inv.code, description: inv.rejection.description, details: inv.rejection.details }
        : { code: inv.code, description: inv.code === 200 ? 'Sukces' : 'Status' },
  };
}

type ClientModule = typeof import('@/lib/ksef/client');

export function ksefClientModule(real: ClientModule, state: () => FakeKsef): ClientModule {
  const { KsefApiError } = real;
  const ksefFetch = async (
    path: string,
    opts: { method?: string; body?: { encryptedInvoiceContent?: string; invoiceHash?: string }; responseType?: string } = {},
  ): Promise<unknown> => {
    const k = state();
    const method = opts.method ?? 'GET';
    const route = path.split('?')[0]!;
    if (route === '/sessions/online' && method === 'POST') {
      k.seq += 1;
      const ref = `S-${k.seq}`;
      k.sessions.set(ref, { open: true, invoices: [] });
      return { referenceNumber: ref };
    }
    let hit = /^\/sessions\/online\/([^/]+)\/invoices$/.exec(route);
    if (hit && method === 'POST') {
      k.invoicePosts += 1;
      const session = k.sessions.get(hit[1]!);
      if (k.dropInvoicePost) throw new KsefApiError(408, 'Request timeout', 'timeout');
      if (k.rejectInvoicePost) throw new KsefApiError(k.rejectInvoicePost, { exceptionDetailList: [{ exceptionCode: 21405 }] } as never, 'Błąd walidacji');
      if (!session?.open) throw new KsefApiError(400, 'Sesja zamknięta', 'Sesja zamknięta');
      const xml = String(opts.body?.encryptedInvoiceContent ?? '');
      const invoiceNumber = /<P_2>([^<]*)<\/P_2>/.exec(xml)?.[1] ?? '';
      k.seq += 1;
      const earlier = [...k.sessions.entries()]
        .flatMap(([s, v]) => v.invoices.map((i) => ({ s, i })))
        .find(({ i }) => i.invoiceNumber === invoiceNumber && i.code === 200);
      const rejection = k.statusRejection;
      const stored: StoredInvoice = earlier
        ? { referenceNumber: `I-${k.seq}`, invoiceNumber, invoiceHash: String(opts.body?.invoiceHash), code: 440,
            ksefNumber: null, xml, originalSession: earlier.s, originalKsef: earlier.i.ksefNumber ?? undefined }
        : rejection
          ? { referenceNumber: `I-${k.seq}`, invoiceNumber, invoiceHash: String(opts.body?.invoiceHash), code: rejection.code,
              ksefNumber: null, xml, rejection: { description: rejection.description, details: rejection.details } }
          : { referenceNumber: `I-${k.seq}`, invoiceNumber, invoiceHash: String(opts.body?.invoiceHash), code: 200,
              ksefNumber: `K-${k.seq}`, xml };
      session.invoices.push(stored);
      if (k.loseInvoicePostResponse) throw new KsefApiError(408, 'Request timeout', 'timeout');
      return { referenceNumber: stored.referenceNumber };
    }
    hit = /^\/sessions\/online\/([^/]+)\/close$/.exec(route);
    if (hit && method === 'POST') {
      const session = k.sessions.get(decodeURIComponent(hit[1]!));
      if (session) session.open = false;
      return {};
    }
    hit = /^\/sessions\/([^/]+)\/invoices$/.exec(route);
    if (hit && method === 'GET') {
      if (k.listFails) throw new KsefApiError(503, 'Service Unavailable', 'KSeF niedostępny');
      const session = k.sessions.get(decodeURIComponent(hit[1]!));
      if (!session) {
        throw new KsefApiError(400, { exception: { exceptionDetailList: [{ exceptionCode: 21173 }] } } as never, 'Brak sesji');
      }
      return {
        continuationToken: null,
        invoices: session.invoices.map((inv, n) => ({
          ordinalNumber: n + 1, invoicingDate: '2026-10-01T10:00:00Z', invoiceNumber: inv.invoiceNumber, ...statusReply(inv),
        })),
      };
    }
    hit = /^\/sessions\/([^/]+)\/invoices\/([^/]+)$/.exec(route);
    if (hit && method === 'GET') {
      if (k.statusFails) throw new KsefApiError(503, 'Service Unavailable', 'KSeF niedostępny');
      const ref = decodeURIComponent(hit[2]!);
      const inv = k.sessions.get(decodeURIComponent(hit[1]!))?.invoices.find((i) => i.referenceNumber === ref);
      if (!inv) throw new KsefApiError(404, 'Not found', 'Brak faktury');
      return statusReply(inv);
    }
    if (route === '/invoices/query/metadata' && method === 'POST') {
      if (k.metadataFails) throw new KsefApiError(503, 'Service Unavailable', 'KSeF niedostępny');
      const wanted = (opts.body as { ksefNumber?: string } | undefined)?.ksefNumber;
      const found = [...k.sessions.values()].flatMap((s) => s.invoices)
        .filter((i) => i.code === 200 && i.ksefNumber && (!wanted || i.ksefNumber === wanted));
      return {
        hasMore: false,
        isTruncated: false,
        invoices: found.map((i) => ({
          ksefNumber: i.ksefNumber, invoiceNumber: i.invoiceNumber, invoiceHash: i.invoiceHash,
          acquisitionDate: i.acquisitionDate ?? '2026-10-01T10:00:00Z', invoicingDate: i.acquisitionDate ?? '2026-10-01T10:00:00Z',
        })),
      };
    }
    hit = /^\/invoices\/ksef\/([^/]+)$/.exec(route);
    if (hit && method === 'GET') {
      k.downloads += 1;
      if (k.downloadFailure) {
        const { status, code } = k.downloadFailure;
        throw new KsefApiError(status, (code ? { exception: { exceptionDetailList: [{ exceptionCode: code }] } } : 'Błąd') as never, `HTTP ${status}`);
      }
      const ksefNumber = decodeURIComponent(hit[1]!);
      const inv = [...k.sessions.values()].flatMap((s) => s.invoices).find((i) => i.ksefNumber === ksefNumber && i.code === 200);
      if (!inv) throw new KsefApiError(400, { exception: { exceptionDetailList: [{ exceptionCode: 21164 }] } } as never, 'Faktura nie istnieje');
      return Buffer.from(inv.xml, 'utf8');
    }
    throw new Error(`Nieobsłużone żądanie KSeF w teście: ${method} ${path}`);
  };
  return { ...real, ksefFetch: ksefFetch as ClientModule['ksefFetch'] };
}

/** „Szyfrowanie” zostawia XML jawny, żeby atrapa KSeF odczytała numer faktury (P_2). */
export function encryptionModule() {
  return {
    generateSessionEncryption: async () => ({ encryptedSymmetricKey: 'k', initializationVector: 'iv' }),
    encryptInvoiceXml: (xml: string) => ({
      invoiceHash: sha256Base64(xml),
      invoiceSize: xml.length,
      encryptedInvoiceHash: 'eh',
      encryptedInvoiceSize: xml.length,
      encryptedInvoiceContent: xml,
    }),
  };
}

export interface MemoryDb {
  db: Record<string, Row[]>;
  /** Zwraca błąd bazy dla wybranych zapisów. */
  failWrite: null | ((table: string, op: 'insert' | 'update', payload: Row) => boolean);
}

/** Klient serwisowy na tabelach w pamięci: select/insert/update z filtrami eq/neq/in/is/not, order, limit. */
export function adminClientModule(state: () => MemoryDb) {
  function from(table: string) {
    const s = state();
    const rows = (s.db[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Row = {};
    let order: { key: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    const exec = () => {
      if (op !== 'select' && s.failWrite?.(table, op, payload)) return { data: null, error: { message: 'db down' } };
      if (op === 'insert') {
        rows.push({ id: `${table}-${rows.length + 1}`, attempted_at: new Date(Date.now() + rows.length).toISOString(), ...payload });
        return { data: null, error: null };
      }
      let hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') {
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (order) {
        const { key, ascending } = order;
        hit = [...hit].sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1));
      }
      if (limit !== null) hit = hit.slice(0, limit);
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const q = {
      select: () => q,
      insert: (p: Row) => { op = 'insert'; payload = p; return q; },
      update: (p: Row) => { op = 'update'; payload = p; return q; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      neq: (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return q; },
      in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
      not: (k: string, _op: string, v: unknown) => { filters.push((r) => (r[k] ?? null) !== v); return q; },
      order: (key: string, o?: { ascending?: boolean }) => { order = { key, ascending: o?.ascending ?? true }; return q; },
      limit: (n: number) => { limit = n; return q; },
      maybeSingle: async () => { const r = exec(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
      single: async () => { const r = exec(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
      then: <A, B>(ok: (v: ReturnType<typeof exec>) => A, fail?: (e: unknown) => B) => Promise.resolve(exec()).then(ok, fail),
    };
    return q;
  }
  return { createAdminClient: () => ({ from }) };
}
