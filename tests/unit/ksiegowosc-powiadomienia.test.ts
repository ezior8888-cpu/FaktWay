import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Crony modułu księgowości (plan księgowości JDG, K5, sekcja 9): push
 * „rozliczenie wyliczone” i przypomnienia o terminach. Atrapy dla bazy,
 * pusha, maila, wyłącznika i odczytu miesiąca; idempotencja
 * (`tax_notifications`, 00169), plan terminów i treści są prawdziwe.
 * UNIQUE i RLS tabeli sprawdza `tests/rls-ksiegowosc-powiadomienia.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  dzis: '2026-11-02',
  pilot: ['t1'] as string[],
  wlaczony: true,
  dane: null as unknown,
  profil: [] as unknown[],
  wpisy: new Map<string, Record<string, unknown>>(),
  pushe: [] as { tenantId: string; type: string; payload: Record<string, unknown> }[],
  maile: [] as { email: string; payload: Record<string, unknown>; opcje: Record<string, unknown> }[],
  bladPusha: null as Error | null,
  odczytyFirm: 0,
  zwolnienie: null as string | null,
  vatWKodzie: true,
  // Dzwonek w aplikacji (krok 8.1 planu kompletnej aplikacji, część 2, 00188).
  dzwonek: [] as { fn: string; args: Record<string, unknown> }[],
  bladDzwonka: null as { message: string } | null,
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => mocks.dzis,
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: async () => ({ wlaczony: mocks.wlaczony }),
  statusObszaru: (obszar: string) => ({ wlaczony: obszar !== 'vat' || mocks.vatWKodzie }),
}));
vi.mock('@/lib/invoices/vat-exemption', async (orig) => ({
  ...(await orig<typeof import('@/lib/invoices/vat-exemption')>()),
  readTenantVatExemption: async () => mocks.zwolnienie,
}));
vi.mock('@/lib/ksiegowosc/ten-miesiac-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/ten-miesiac-dane')>()),
  czytajTenMiesiac: async () => mocks.dane,
}));
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: async () => mocks.profil,
}));
vi.mock('@/lib/push/sender', () => ({
  sendPushToTenant: async (tenantId: string, type: string, payload: Record<string, unknown>) => {
    if (mocks.bladPusha) throw mocks.bladPusha;
    mocks.pushe.push({ tenantId, type, payload });
    return { sent: 1, failed: 0 };
  },
}));
vi.mock('@/lib/email/send', () => ({
  sendTerminRozliczeniaEmail: async (email: string, payload: Record<string, unknown>, opcje: Record<string, unknown>) => {
    mocks.maile.push({ email, payload, opcje });
    return { sent: true, messageId: 'm1' };
  },
}));

const klucz = (w: Record<string, unknown>) => `${w.tenant_id}|${w.rozliczenie}|${w.etap}`;

/** Atrapa bazy: tax_notifications z UNIQUE (tenant_id, rozliczenie, etap) w pamięci. */
const baza = {
  from: (tabela: string) => {
    if (tabela === 'tenant_feature_flags') {
      mocks.odczytyFirm++;
      const l = { select: () => l, eq: () => l, limit: async () => ({ data: mocks.pilot.map((tenant_id) => ({ tenant_id })), error: null }) };
      return l;
    }
    if (tabela === 'memberships') {
      const l: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) l[m] = () => l;
      l.maybeSingle = async () => ({ data: { user_id: 'u1' }, error: null });
      return l;
    }
    if (tabela !== 'tax_notifications') throw new Error(`nieoczekiwana tabela ${tabela}`);
    return {
      insert: async (w: Record<string, unknown>) => {
        if (mocks.wpisy.has(klucz(w))) return { error: { code: '23505', message: 'duplicate key' } };
        mocks.wpisy.set(klucz(w), { ...w });
        return { error: null };
      },
      update: (zmiana: Record<string, unknown>) => {
        const filtry: Record<string, unknown> = {};
        let statusy: string[] | null = null;
        const wykonaj = () => {
          const wpis = mocks.wpisy.get(klucz(filtry));
          if (!wpis || (statusy && !statusy.includes(String(wpis.status)))) return [];
          Object.assign(wpis, zmiana);
          return [{ id: klucz(filtry) }];
        };
        const b: Record<string, unknown> = {
          eq: (k: string, v: unknown) => ((filtry[k] = v), b),
          in: (_k: string, l: string[]) => ((statusy = l), b),
          select: async () => ({ data: wykonaj(), error: null }),
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: (wykonaj(), null), error: null }).then(ok),
        };
        return b;
      },
    };
  },
  auth: { admin: { getUserById: async () => ({ data: { user: { email: 'wlasciciel@faktway.test' } }, error: null }) } },
  // Zapis w dzwonku (00188): UNIQUE i ON CONFLICT sprawdza test na bazie, tu tylko wywołanie.
  rpc: async (fn: string, args: Record<string, unknown>) => {
    mocks.dzwonek.push({ fn, args });
    return mocks.bladDzwonka ? { data: null, error: mocks.bladDzwonka } : { data: 1, error: null };
  },
};
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => baza }));

const { runKsiegowoscMiesiac } = await import('@/lib/jobs/runners/ksiegowosc-miesiac');
const { runKsiegowoscTerminy } = await import('@/lib/jobs/runners/ksiegowosc-terminy');

const ctx = { step: { run: (_n: string, fn: () => unknown) => fn() }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as JobContext;

const PROFIL = { id: 'p1', validFrom: '2026-01-01', forma: 'ryczalt', stawkaDomyslna: 1200, zusEtap: 'pelny', zusOd: null, chorobowe: true, nrsZus: null, najem: false };
const H = 'a'.repeat(64);
const pozycja = (rodzaj: string, kwotaGr: number) => ({ ok: true, rodzaj, kwotaGr, termin: null, wejscia: {}, wejsciaHash: H });
const POLICZONE = {
  ok: true,
  wynik: {},
  pozycje: [pozycja('ryczalt', 153_600), pozycja('zus_spoleczne', 192_676), pozycja('zdrowotna', 83_058)],
  parametryWersja: 'x',
  rozliczenia: [],
};

beforeEach(() => {
  mocks.dzis = '2026-11-02';
  mocks.pilot = ['t1'];
  mocks.wlaczony = true;
  mocks.dane = POLICZONE;
  mocks.profil = [PROFIL];
  mocks.wpisy = new Map();
  mocks.pushe = [];
  mocks.maile = [];
  mocks.bladPusha = null;
  mocks.odczytyFirm = 0;
  mocks.zwolnienie = null;
  mocks.vatWKodzie = true;
  mocks.dzwonek = [];
  mocks.bladDzwonka = null;
});

describe('F11-B1: składki społeczne po końcu ulgi na start', () => {
  // Profil bez nowej wersji: „ulga na start” od 1.01.2026 trwa 6 miesięcy
  // (art. 18 ust. 1 Prawa przedsiębiorców), więc za lipiec silnik daje brak
  // składek społecznych. Przypomnienie nie może ich wtedy pominąć po cichu.
  const brak = { ok: false, rodzaj: 'zus_spoleczne', brak: 'Etap „Ulga na start” trwał do 30.06.2026. Dodaj nową wersję ustawień ZUS.' };

  it('lipiec po uldze: przypomnienie wymienia składki społeczne (bez kwoty), a nie tylko ryczałt i zdrowotną', async () => {
    mocks.dzis = '2026-08-15';
    mocks.profil = [{ ...PROFIL, zusEtap: 'ulga_na_start', zusOd: '2026-01-01' }];
    mocks.dane = { ...POLICZONE, pozycje: [pozycja('ryczalt', 120_000), brak, pozycja('zdrowotna', 49_835)] };
    expect(await runKsiegowoscTerminy(ctx)).toMatchObject({ terminy: 1, wyslane: 1 });
    expect(mocks.pushe[0].payload.body).toContain('składki społeczne');
  });

  it('w trakcie ulgi silnik liczy 0 zł: bez przypomnienia o składkach społecznych (jak dotąd)', async () => {
    mocks.dzis = '2026-03-15';
    mocks.profil = [{ ...PROFIL, zusEtap: 'ulga_na_start', zusOd: '2026-01-01' }];
    mocks.dane = { ...POLICZONE, pozycje: [pozycja('ryczalt', 120_000), pozycja('zus_spoleczne', 0), pozycja('zdrowotna', 49_835)] };
    expect(await runKsiegowoscTerminy(ctx)).toMatchObject({ wyslane: 1 });
    expect(mocks.pushe[0].payload.body).not.toContain('składki społeczne');
  });
});

describe('cron.ksiegowosc-miesiac', () => {
  it('push o wyliczonym październiku raz, mimo trzech dni uruchomień', async () => {
    expect(await runKsiegowoscMiesiac(ctx)).toMatchObject({ miesiac: '2026-10', wyslane: 1 });
    mocks.dzis = '2026-11-03';
    expect(await runKsiegowoscMiesiac(ctx)).toMatchObject({ wyslane: 0, duplikaty: 1 });
    expect(mocks.pushe).toHaveLength(1);
    expect(mocks.pushe[0]).toMatchObject({
      tenantId: 't1',
      type: 'ksiegowosc',
      payload: {
        title: 'Rozliczenie za październik 2026 jest wyliczone',
        url: '/reports/ten-miesiac?month=10&year=2026',
        tag: 'ksiegowosc-2026-10-wyliczone',
      },
    });
    expect(mocks.wpisy.get('t1|2026-10|wyliczone')).toMatchObject({ status: 'sent', wynik: { push: 1 } });
  });

  it('bez kwot (parametry czekają na księgową) i poza pilotażem: nic nie wychodzi', async () => {
    mocks.dane = { ok: false, braki: ['Stawki czekają na sprawdzenie.'], rozliczenia: [] };
    expect(await runKsiegowoscMiesiac(ctx)).toMatchObject({ pominiete: 1 });
    mocks.dane = POLICZONE;
    mocks.wlaczony = false;
    expect(await runKsiegowoscMiesiac(ctx)).toMatchObject({ pominiete: 1 });
    expect(mocks.pushe).toEqual([]);
    expect(mocks.wpisy.size).toBe(0);
  });

  it('błąd pusha: wpis „failed” i zadanie do ponowienia; ponowienie przejmuje wpis i wysyła raz', async () => {
    mocks.bladPusha = new Error('push padł');
    await expect(runKsiegowoscMiesiac(ctx)).rejects.toThrow('1 firm do ponowienia');
    expect(mocks.wpisy.get('t1|2026-10|wyliczone')).toMatchObject({ status: 'failed', blad: 'push padł' });
    mocks.bladPusha = null;
    expect(await runKsiegowoscMiesiac(ctx)).toMatchObject({ wyslane: 1 });
    expect(mocks.pushe).toHaveLength(1);
    expect(mocks.wpisy.get('t1|2026-10|wyliczone')).toMatchObject({ status: 'sent' });
  });
});

describe('cron.ksiegowosc-terminy', () => {
  it('5 dni przed terminem: jedno przypomnienie o ryczałcie i składkach, push i mail do właściciela, potem już nic', async () => {
    mocks.dzis = '2026-11-15';
    expect(await runKsiegowoscTerminy(ctx)).toMatchObject({ terminy: 1, wyslane: 1 });
    expect(await runKsiegowoscTerminy(ctx)).toMatchObject({ wyslane: 0, duplikaty: 1 });
    expect(mocks.pushe).toHaveLength(1);
    expect(mocks.pushe[0].payload).toMatchObject({
      title: 'Termin 20.11.2026: rozliczenie za październik 2026',
      body: 'Za 5 dni, 20.11.2026, mija termin za październik 2026. Bez oznaczonej zapłaty: ryczałt 1536,00 zł, składki społeczne 1926,76 zł, składka zdrowotna 830,58 zł.',
    });
    expect(mocks.maile).toEqual([
      {
        email: 'wlasciciel@faktway.test',
        payload: expect.objectContaining({ rok: 2026, adres: '/reports/ten-miesiac?month=10&year=2026' }),
        opcje: { userId: 'u1', idempotencyKey: 'ksiegowosc/t1/2026-10/termin-5:2026-11-20' },
      },
    ]);
    expect(mocks.wpisy.get('t1|2026-10|termin-5:2026-11-20')).toMatchObject({ status: 'sent', wynik: { push: 1, mail: true } });
  });

  it('wszystko zapłacone: bez przypomnienia; skala (K7): przypomnienie o zaliczce PIT i składkach, bez ryczałtu', async () => {
    mocks.dzis = '2026-11-19';
    const zaplacone = (rodzaj: string, kwotaGr: number) => ({
      id: rodzaj,
      miesiac: '2026-10',
      rodzaj,
      wersja: 1,
      kwotaGr,
      termin: '2026-11-20',
      status: 'zaplacone',
      wejsciaHash: H,
      zatwierdzoneO: '2026-11-02T10:00:00Z',
      zaplaconeO: '2026-11-10',
      spoleczneBezFpGr: 0,
    });
    mocks.dane = { ...POLICZONE, rozliczenia: [zaplacone('ryczalt', 153_600), zaplacone('zus_spoleczne', 192_676), zaplacone('zdrowotna', 83_058)] };
    expect(await runKsiegowoscTerminy(ctx)).toMatchObject({ pominiete: 1 });
    expect([mocks.pushe, mocks.maile, mocks.wpisy.size]).toEqual([[], [], 0]);
    mocks.dane = POLICZONE;
    mocks.profil = [{ ...PROFIL, forma: 'skala', stawkaDomyslna: null }];
    expect(await runKsiegowoscTerminy(ctx)).toMatchObject({ wyslane: 1 });
    expect(mocks.pushe[0].payload.body).toContain('zaliczka PIT');
    expect(mocks.pushe[0].payload.body).not.toContain('ryczałt');
  });

  it('VAT (K7.1): 20.11 przypomnienie o VAT za październik z kwotą; firma zwolniona (art. 113) albo VAT zablokowany w kodzie: nic', async () => {
    mocks.dzis = '2026-11-20';
    mocks.dane = { ...POLICZONE, pozycje: [...POLICZONE.pozycje, pozycja('vat', 374_500)] };
    await runKsiegowoscTerminy(ctx);
    expect(mocks.pushe).toHaveLength(1);
    expect(String(mocks.pushe[0].payload.body)).toContain('VAT');
    expect(String(mocks.pushe[0].payload.body)).not.toMatch(/ryczałt|składki/);
    expect([...mocks.wpisy.keys()]).toEqual(['t1|2026-10|termin-5:2026-11-25']);

    mocks.wpisy = new Map();
    mocks.pushe = [];
    mocks.zwolnienie = 'art. 113 ust. 1';
    await runKsiegowoscTerminy(ctx);
    expect(mocks.pushe).toEqual([]);
    expect(mocks.wpisy.size).toBe(0);

    mocks.zwolnienie = null;
    mocks.vatWKodzie = false;
    await runKsiegowoscTerminy(ctx);
    expect(mocks.pushe).toEqual([]);
  });

  it('dzień bez terminu: zadanie kończy się bez odczytu firm', async () => {
    mocks.dzis = '2026-11-16';
    expect(await runKsiegowoscTerminy(ctx)).toEqual({ dzis: '2026-11-16', terminy: 0 });
    expect(mocks.odczytyFirm).toBe(0);
  });

  it('błąd odczytu rozliczeń: bez przypomnienia „bez zapłaty”, zadanie do ponowienia', async () => {
    mocks.dzis = '2026-11-19';
    mocks.dane = {
      ok: false,
      braki: ['Nie udało się odczytać rozliczeń, więc nie pokazujemy kwot. Strona spróbuje ponownie przy następnym otwarciu.'],
      rozliczenia: [],
    };
    await expect(runKsiegowoscTerminy(ctx)).rejects.toThrow('do ponowienia');
    expect([mocks.pushe, mocks.wpisy.size]).toEqual([[], 0]);
  });

  it('wyliczony miesiąc w uldze: push bez pozycji z kwotą zero', async () => {
    mocks.dane = { ...POLICZONE, pozycje: [pozycja('ryczalt', 120_000), pozycja('zus_spoleczne', 0), pozycja('zdrowotna', 49_835)] };
    await runKsiegowoscMiesiac(ctx);
    expect(mocks.pushe[0].payload.body).toBe(
      'Według Twoich danych: ryczałt 1200,00 zł, składka zdrowotna 498,35 zł. Szczegóły i zatwierdzenie są w zakładce „Ten miesiąc”.',
    );
  });

  it('parametry czekają na księgową: przypomnienie o terminie bez kwot', async () => {
    mocks.dzis = '2026-11-19';
    mocks.dane = { ok: false, braki: ['Stawki czekają na sprawdzenie.'], rozliczenia: [] };
    await runKsiegowoscTerminy(ctx);
    expect(mocks.pushe[0].payload.body).toBe(
      'Jutro, 20.11.2026, mija termin za październik 2026. Bez oznaczonej zapłaty: ryczałt, składki społeczne, składka zdrowotna.',
    );
  });
});

describe('dzwonek w aplikacji: termin podatku (krok 8.1 planu kompletnej aplikacji, część 2, 00188)', () => {
  it('po wysłanym przypomnieniu: ten sam tekst w dzwonku firmy, klucz = rozliczenie i etap; drugi przebieg bez zapisu', async () => {
    mocks.dzis = '2026-11-15';
    await runKsiegowoscTerminy(ctx);
    await runKsiegowoscTerminy(ctx);
    expect(mocks.dzwonek).toEqual([
      {
        fn: 'app_notification_publish',
        args: {
          p_tenant_id: 't1',
          p_kind: 'tax_deadline',
          p_object_key: '2026-10:termin-5:2026-11-20',
          p_title: 'Termin 20.11.2026: rozliczenie za październik 2026',
          p_body: 'Za 5 dni, 20.11.2026, mija termin za październik 2026. Bez oznaczonej zapłaty: ryczałt 1536,00 zł, składki społeczne 1926,76 zł, składka zdrowotna 830,58 zł.',
          p_link: '/reports/ten-miesiac?month=10&year=2026',
        },
      },
    ]);
  });

  it('błąd zapisu w dzwonku nie przerywa przypomnienia: push i mail wyszły, wpis „sent”, bez ponowienia', async () => {
    mocks.dzis = '2026-11-15';
    mocks.bladDzwonka = { message: 'relation "app_notifications" does not exist' };
    await expect(runKsiegowoscTerminy(ctx)).resolves.toMatchObject({ wyslane: 1 });
    expect(mocks.dzwonek).toHaveLength(1);
    expect(mocks.pushe).toHaveLength(1);
    expect(mocks.wpisy.get('t1|2026-10|termin-5:2026-11-20')).toMatchObject({ status: 'sent' });
  });

  it('moduł wyłączony: bez wpisu; rozliczenie „wyliczone” (cron miesiąca) nie trafia do dzwonka', async () => {
    mocks.dzis = '2026-11-15';
    mocks.wlaczony = false;
    await runKsiegowoscTerminy(ctx);
    mocks.wlaczony = true;
    mocks.dzis = '2026-11-02';
    await runKsiegowoscMiesiac(ctx);
    expect(mocks.pushe).toHaveLength(1);
    expect(mocks.dzwonek).toEqual([]);
  });
});
