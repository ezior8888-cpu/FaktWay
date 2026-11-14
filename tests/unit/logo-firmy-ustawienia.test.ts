import { readFileSync } from 'node:fs';

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';
import { KONFIGURACJA_MAGAZYNU, bladMagazynu, klientMagazynu, nowyMagazyn, type Magazyn } from '../helpers/magazyn-atrapa';
import { kodujPng } from '../helpers/png-proby';

/**
 * Logo firmy w ustawieniach (plan kompletnej aplikacji, krok 2.2, część 1)
 * na prawdziwej ścieżce: trasa `/api/uploads/logo` z bramką wgrywania
 * (`lib/uploads/server.ts`: Origin, rozmiar przed odczytem ciała, sesja,
 * 2FA, firma, limit), sprawdzenie pliku po sygnaturze, zapis w magazynie
 * pod kluczem z prefiksem firmy, wskaźnik w `tenants.logo_storage_key`,
 * audyt, usunięcie i sprzątanie. Atrapy tylko dla sesji, bazy (w pamięci)
 * i magazynu (polecenia S3). Wyzwalacz i CHECK kolumny na prawdziwej bazie:
 * tests/rls-logo-firmy.test.ts.
 *
 * Ponowienie od zera: każda próba wgrania ma nowy klucz; błąd zapisu w bazie
 * usuwa plik tej próby, więc ponowienie nie zostawia sierot.
 */

const TENANT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const INNA_FIRMA = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORIGIN = 'https://faktway.test';
const PREFIKS = `tenants/${TENANT}/logo/`;
const KLUCZ = /^tenants\/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d\/logo\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$/;

const m = vi.hoisted(() => ({
  db: null as unknown as MemoryDb,
  magazyn: null as unknown as Magazyn,
  sesja: null as null | { userId: string; role: 'owner' | 'admin' | 'member' | 'accountant' } | { odmowa: string },
  revalidate: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/feature-flags/maintenance', () => ({ MAINTENANCE_PATH: '/przerwa-techniczna', isMaintenanceMode: async () => false }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => fakeSupabase(m.db) }));
vi.mock('@/lib/storage/r2-client', () => ({
  getR2Client: () => klientMagazynu(m.magazyn),
  getR2Config: () => KONFIGURACJA_MAGAZYNU,
}));
// Podpisany adres podglądu: podpis liczy SDK S3 z prawdziwym klientem, tu sam adres pliku.
vi.mock('@/lib/storage/signed-file-url', () => ({
  getSignedFileUrl: async (klucz: string, _tenant: string, opcje: { contentType: string }) =>
    `https://magazyn.test/${klucz}?typ=${encodeURIComponent(opcje.contentType)}`,
}));
vi.mock('@/lib/supabase/auth-context', async (orig) => {
  const actual = await orig<typeof import('@/lib/supabase/auth-context')>();
  const sesja = async () => {
    const s = m.sesja;
    if (!s) throw new actual.ActionAuthError('Niezalogowany');
    if ('odmowa' in s) throw new actual.ActionAuthError(s.odmowa);
    return { user: { id: s.userId }, tenantId: TENANT, role: s.role, supabase: fakeSupabase(m.db) };
  };
  return {
    ...actual,
    requireUserAndActiveOrg: sesja,
    requireOrgRole: async (roles: string | string[]) => {
      const ctx = await sesja();
      const dozwolone = Array.isArray(roles) ? roles : [roles];
      if (!dozwolone.includes(ctx.role)) throw new actual.ActionAuthError('Niewystarczające uprawnienia');
      return ctx;
    },
  };
});

import { deleteCompanyLogoAction } from '@/app/actions/company-logo';
import { POST } from '@/app/api/uploads/logo/route';
import { readCompanyLogoForSettings } from '@/lib/invoices/logo-firmy';
import { checkStoredLogo } from '@/lib/pdf/logo-obraz';

const LOGO_PNG = readFileSync('docs/brand/logo/zestaw/png/faktway-logo-1200.png');
const JPEG = readFileSync('public/marketing/hero.jpg');

let seq = 0;

beforeEach(() => {
  seq += 1;
  m.db = memoryDb({ tenants: [{ id: TENANT, name: 'Moja Firma', logo_storage_key: null }, { id: INNA_FIRMA, name: 'Inna', logo_storage_key: null }] });
  m.magazyn = nowyMagazyn();
  // Każdy test z innym kontem: limit wgrań liczy się w pamięci procesu.
  m.sesja = { userId: `u-${seq}`, role: 'owner' };
  m.revalidate.mockClear();
});

function tenant(): Row {
  return m.db.tables.tenants!.find((t) => t.id === TENANT)!;
}

function audyt(): Row[] {
  return m.db.tables.audit_logs ?? [];
}

function klucze(): string[] {
  return [...m.magazyn.obiekty.keys()].sort();
}

async function zadanie(pola: Record<string, string | File>, naglowki: Record<string, string | null> = {}): Promise<NextRequest> {
  const form = new FormData();
  for (const [k, v] of Object.entries(pola)) form.set(k, v);
  const zakodowane = new Request(`${ORIGIN}/api/uploads/logo`, { method: 'POST', body: form });
  const body = await zakodowane.arrayBuffer();
  const wszystkie: Record<string, string | null> = {
    'content-type': zakodowane.headers.get('content-type')!,
    'content-length': String(body.byteLength),
    origin: ORIGIN,
    host: 'faktway.test',
    ...naglowki,
  };
  return new NextRequest(`${ORIGIN}/api/uploads/logo`, {
    method: 'POST',
    body,
    headers: Object.fromEntries(Object.entries(wszystkie).filter((e): e is [string, string] => e[1] !== null)),
  });
}

const plik = (bajty: Uint8Array, nazwa = 'logo.png', typ = 'image/png') => new File([new Uint8Array(bajty)], nazwa, { type: typ });

async function wgraj(bajty: Uint8Array, nazwa?: string, typ?: string, pola: Record<string, string> = {}) {
  const res = await POST(await zadanie({ logo: plik(bajty, nazwa, typ), tenantId: TENANT, ...pola }));
  expect(res.headers.get('cache-control')).toContain('no-store');
  return { status: res.status, body: (await res.json()) as { success: boolean; error?: string; logo?: { previewUrl: string; format: string; width: number; height: number } } };
}

describe('POST /api/uploads/logo', () => {
  it('właściciel wgrywa PNG: plik przygotowany w magazynie firmy, wskaźnik w bazie, audyt, podgląd', async () => {
    const { status, body } = await wgraj(LOGO_PNG);
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, logo: { format: 'png', width: 1200, height: 266 } });
    const [klucz] = klucze();
    expect(klucz).toMatch(KLUCZ);
    expect(tenant().logo_storage_key).toBe(klucz);
    const obiekt = m.magazyn.obiekty.get(klucz!)!;
    expect(obiekt).toMatchObject({ contentType: 'image/png', cacheControl: 'private, no-store' });
    expect(checkStoredLogo(obiekt.body)).toMatchObject({ format: 'png', width: 1200, height: 266 });
    expect(body.logo?.previewUrl).toContain(klucz);
    expect(audyt()).toEqual([
      expect.objectContaining({
        action: 'tenant.updated', tenant_id: TENANT, user_id: `u-${seq}`, entity_type: 'tenant', entity_id: TENANT,
        metadata: expect.objectContaining({ field: 'logo', change: 'added', from: null, to: klucz, format: 'png', width: 1200, height: 266 }),
      }),
    ]);
    expect(m.revalidate).toHaveBeenCalledWith('/settings');
  });

  it('administrator zmienia logo: nowy klucz, stary plik usunięty od razu, audyt zmiany', async () => {
    await wgraj(LOGO_PNG);
    const [stary] = klucze();
    m.sesja = { userId: `u-${seq}-admin`, role: 'admin' };
    const { status, body } = await wgraj(JPEG, 'logo.jpg', 'image/jpeg');
    expect(status).toBe(200);
    expect(body.logo?.format).toBe('jpeg');
    const [nowy] = klucze();
    expect(klucze()).toHaveLength(1);
    expect(nowy).not.toBe(stary);
    expect(nowy).toMatch(/\.jpg$/);
    expect(tenant().logo_storage_key).toBe(nowy);
    expect(audyt().at(-1)).toMatchObject({ metadata: expect.objectContaining({ field: 'logo', change: 'replaced', from: stary, to: nowy }) });
  });

  it('typ z zawartości pliku: JPEG nazwany logo.png z typem image/png zapisuje się jako JPEG', async () => {
    const { status, body } = await wgraj(JPEG, 'logo.png', 'image/png');
    expect(status).toBe(200);
    expect(body.logo?.format).toBe('jpeg');
    expect(klucze()[0]).toMatch(/\.jpg$/);
    expect(m.magazyn.obiekty.get(klucze()[0]!)?.contentType).toBe('image/jpeg');
  });

  it.each([
    ['GIF z nazwą logo.png i typem image/png', Buffer.from('GIF89a\x10\x00\x10\x00\x80\x00\x00', 'latin1'), /PNG albo JPEG/],
    ['SVG z nazwą logo.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), /SVG/],
    ['uszkodzony PNG', Buffer.concat([LOGO_PNG.subarray(0, 200)]), /uszkodzony/],
  ])('%s: odmowa z komunikatem, nic w magazynie i w bazie', async (_opis, bajty, komunikat) => {
    const { status, body } = await wgraj(bajty);
    expect(status).toBe(422);
    expect(body).toMatchObject({ success: false, error: expect.stringMatching(komunikat) });
    expect(klucze()).toEqual([]);
    expect(tenant().logo_storage_key).toBeNull();
    expect(audyt()).toEqual([]);
  });

  it.each([['member'], ['accountant']] as const)('rola %s: 403, plik nie jest czytany ani zapisany', async (role) => {
    m.sesja = { userId: `u-${seq}`, role };
    const { status, body } = await wgraj(LOGO_PNG);
    expect(status).toBe(403);
    expect(body.error).toMatch(/właściciel albo administrator/);
    expect(m.magazyn.wywolania).toEqual([]);
  });

  it('bez sesji 401, bez drugiego kroku 2FA 403, z innej strony 403', async () => {
    m.sesja = null;
    expect((await wgraj(LOGO_PNG)).status).toBe(401);
    m.sesja = { odmowa: 'Wymagana weryfikacja dwuetapowa' };
    expect((await wgraj(LOGO_PNG)).status).toBe(403);
    m.sesja = { userId: `u-${seq}`, role: 'owner' };
    const res = await POST(await zadanie({ logo: plik(LOGO_PNG), tenantId: TENANT }, { origin: 'https://obca.example' }));
    expect(res.status).toBe(403);
    expect(klucze()).toEqual([]);
  });

  it('ciało ponad limit logo (2 MB): 413 przed sesją i bez zapisu', async () => {
    m.sesja = null;
    const res = await POST(await zadanie({ logo: plik(Buffer.alloc(2_100_000, 1)), tenantId: TENANT }));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/2 MB/);
    expect(klucze()).toEqual([]);
  });

  it('formularz z innej firmy niż aktywna: odmowa z komunikatem i bez zapisu', async () => {
    const { status, body } = await wgraj(LOGO_PNG, undefined, undefined, { tenantId: INNA_FIRMA });
    expect(status).toBe(409);
    expect(body.error).toMatch(/Aktywna firma zmieniła się/);
    expect(klucze()).toEqual([]);
  });

  it('błąd zapisu w bazie: plik tej próby usunięty (bez sieroty), ponowienie od zera zapisuje jeden plik', async () => {
    m.db.failures['tenants:update'] = { code: '08006', message: 'connection failure' };
    const pierwsza = await wgraj(LOGO_PNG);
    expect(pierwsza.status).toBe(503);
    expect(pierwsza.body.error).toMatch(/Spróbuj ponownie/);
    expect(klucze()).toEqual([]);
    expect(tenant().logo_storage_key).toBeNull();
    expect(audyt()).toEqual([]);

    delete m.db.failures['tenants:update'];
    const druga = await wgraj(LOGO_PNG);
    expect(druga.status).toBe(200);
    expect(klucze()).toEqual([tenant().logo_storage_key]);
  });

  it('przed migracją 00203 (brak kolumny): komunikat o aktualizacji bazy i bez pliku', async () => {
    m.db.failures['tenants:select'] = { code: '42703', message: 'column tenants.logo_storage_key does not exist' };
    const { status, body } = await wgraj(LOGO_PNG);
    expect(status).toBe(503);
    expect(body.error).toMatch(/aktualizację bazy/);
    expect(klucze()).toEqual([]);
  });

  it('logo zmienione w innej karcie w trakcie wgrania: 409, plik tej próby usunięty, cudza zmiana zostaje', async () => {
    const wInnejKarcie = `${PREFIKS}11111111-2222-4333-8444-555555555555.png`;
    m.magazyn.przed = (polecenie, klucz) => {
      if (polecenie === 'PUT' && klucz !== wInnejKarcie) tenant().logo_storage_key = wInnejKarcie;
    };
    const { status, body } = await wgraj(LOGO_PNG);
    expect(status).toBe(409);
    expect(body.error).toMatch(/Odśwież stronę/);
    expect(tenant().logo_storage_key).toBe(wInnejKarcie);
    expect(klucze()).toEqual([]);
  });

  it('błąd zapisu w magazynie: 503 i baza bez zmian', async () => {
    m.magazyn.awarie.set('PUT', bladMagazynu());
    const { status } = await wgraj(LOGO_PNG);
    expect(status).toBe(503);
    expect(tenant().logo_storage_key).toBeNull();
  });

  it('sprzątanie: stare sieroty w katalogu logo firmy znikają, świeże i cudze zostają', async () => {
    const godzineTemu = new Date(Date.now() - 60 * 60 * 1000);
    const sierota = `${PREFIKS}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png`;
    const swieza = `${PREFIKS}bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.png`;
    const cudza = `tenants/${INNA_FIRMA}/logo/cccccccc-dddd-4eee-8fff-000000000000.png`;
    const innyPlik = `tenants/${TENANT}/expenses/2026/11/zdjecie.jpg`;
    for (const k of [sierota, cudza, innyPlik]) m.magazyn.obiekty.set(k, { body: Buffer.from('x'), lastModified: godzineTemu });
    m.magazyn.obiekty.set(swieza, { body: Buffer.from('x'), lastModified: new Date() });

    expect((await wgraj(LOGO_PNG)).status).toBe(200);
    const biezacy = String(tenant().logo_storage_key);
    expect(klucze()).toEqual([biezacy, swieza, cudza, innyPlik].sort());
  });

  it('nieudane usunięcie starego pliku nie cofa zmiany; następna zmiana go sprząta', async () => {
    await wgraj(LOGO_PNG);
    const stary = String(tenant().logo_storage_key);
    m.magazyn.awarie.set(`DELETE ${stary}`, bladMagazynu());
    expect((await wgraj(JPEG, 'logo.jpg', 'image/jpeg')).status).toBe(200);
    expect(klucze()).toContain(stary);

    m.magazyn.awarie.clear();
    m.magazyn.obiekty.get(stary)!.lastModified = new Date(Date.now() - 60 * 60 * 1000);
    expect((await wgraj(LOGO_PNG)).status).toBe(200);
    expect(klucze()).toEqual([tenant().logo_storage_key]);
  });
});

describe('deleteCompanyLogoAction', () => {
  it('usuwa plik z magazynu, potem wskaźnik w bazie; audyt usunięcia', async () => {
    await wgraj(LOGO_PNG);
    const klucz = String(tenant().logo_storage_key);
    expect(await deleteCompanyLogoAction()).toEqual({ success: true });
    expect(klucze()).toEqual([]);
    expect(tenant().logo_storage_key).toBeNull();
    expect(audyt().at(-1)).toMatchObject({
      action: 'tenant.updated',
      metadata: expect.objectContaining({ field: 'logo', change: 'removed', from: klucz, to: null }),
    });
  });

  it('bez logo: sukces bez zmian i bez audytu (ponowienie po udanym usunięciu)', async () => {
    expect(await deleteCompanyLogoAction()).toEqual({ success: true });
    expect(audyt()).toEqual([]);
  });

  it('błąd magazynu: odmowa, wskaźnik i plik zostają (można ponowić)', async () => {
    await wgraj(LOGO_PNG);
    const klucz = String(tenant().logo_storage_key);
    m.magazyn.awarie.set('DELETE', bladMagazynu());
    expect(await deleteCompanyLogoAction()).toMatchObject({ success: false, error: expect.stringMatching(/Spróbuj ponownie/) });
    expect(tenant().logo_storage_key).toBe(klucz);
    expect(klucze()).toEqual([klucz]);
  });

  it('błąd bazy po usunięciu pliku: odmowa; ponowienie od zera kończy usunięcie', async () => {
    await wgraj(LOGO_PNG);
    m.db.failures['tenants:update'] = { code: '08006', message: 'connection failure' };
    expect(await deleteCompanyLogoAction()).toMatchObject({ success: false });
    expect(klucze()).toEqual([]);
    delete m.db.failures['tenants:update'];
    expect(await deleteCompanyLogoAction()).toEqual({ success: true });
    expect(tenant().logo_storage_key).toBeNull();
  });

  it('rola member: odmowa bez zmian', async () => {
    await wgraj(LOGO_PNG);
    m.sesja = { userId: `u-${seq}`, role: 'member' };
    expect(await deleteCompanyLogoAction()).toMatchObject({ success: false, error: expect.stringMatching(/właściciel albo administrator/) });
    expect(klucze()).toHaveLength(1);
  });
});

describe('readCompanyLogoForSettings', () => {
  it('logo w magazynie: podgląd z podpisanym adresem i typem z formatu', async () => {
    await wgraj(LOGO_PNG);
    const klucz = String(tenant().logo_storage_key);
    expect(await readCompanyLogoForSettings(fakeSupabase(m.db), TENANT)).toEqual({
      status: 'ok', format: 'png', previewUrl: `https://magazyn.test/${klucz}?typ=image%2Fpng`,
    });
  });

  it('bez logo, brak pliku w magazynie, brak kolumny', async () => {
    expect(await readCompanyLogoForSettings(fakeSupabase(m.db), TENANT)).toEqual({ status: 'none' });
    tenant().logo_storage_key = `${PREFIKS}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png`;
    expect(await readCompanyLogoForSettings(fakeSupabase(m.db), TENANT)).toEqual({ status: 'missing' });
    m.db.failures['tenants:select'] = { code: '42703', message: 'column tenants.logo_storage_key does not exist' };
    expect(await readCompanyLogoForSettings(fakeSupabase(m.db), TENANT)).toEqual({ status: 'unavailable' });
  });

  it('klucz spoza firmy w wierszu: bez podpisanego adresu', async () => {
    tenant().logo_storage_key = `tenants/${INNA_FIRMA}/logo/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png`;
    expect(await readCompanyLogoForSettings(fakeSupabase(m.db), TENANT)).toEqual({ status: 'missing' });
    expect(m.magazyn.wywolania).toEqual([]);
  });
});

describe('logo większe niż wydruk', () => {
  it('PNG 2400 × 531 zapisuje się zmniejszony; mały PNG RGB bez zmian wymiarów', async () => {
    const duze = await wgraj(readFileSync('docs/brand/logo/zestaw/png/faktway-logo-2400.png'));
    expect(duze.body.logo).toMatchObject({ height: 400 });
    const male = await wgraj(kodujPng({ width: 64, height: 32, colorType: 2, bitDepth: 8, probki: () => [1, 2, 3] }));
    expect(male.body.logo).toMatchObject({ width: 64, height: 32 });
  });
});
