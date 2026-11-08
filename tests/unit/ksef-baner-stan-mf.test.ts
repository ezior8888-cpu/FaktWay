import { describe, expect, it } from 'vitest';

import { ksefBannerContent, ksefBannerKey } from '@/lib/ksef/health-banner';
import { toPublicKsefHealth, type KsefHealthPublic, type KsefHealthSnapshot } from '@/lib/ksef/health-status';

/**
 * Plan „zero zgubionych faktur”, sesja B3. Baner rozróżnia to, co ogłosiło MF (Latarnia),
 * od tego, co zmierzyła nasza sonda: tylko ogłoszenie MF wyznacza tryb prawny.
 */
const base: KsefHealthPublic = {
  level: 'operational',
  lastCheckedAt: '2026-11-05T10:00:00.000Z',
  responseTimeMs: 120,
  consecutiveFailures: 0,
  isMfOutage: false,
  env: 'production',
};

describe('ksefBannerContent', () => {
  it('zdrowy KSeF: brak banera', () => {
    expect(ksefBannerContent(base)).toBeNull();
    expect(ksefBannerContent({ ...base, officialStatus: 'AVAILABLE' })).toBeNull();
    expect(ksefBannerContent({ ...base, officialStatus: null })).toBeNull();
  });

  it('awaria ogłoszona przez MF pokazuje się także przy działającej sondzie', () => {
    const content = ksefBannerContent({ ...base, officialStatus: 'FAILURE' });
    expect(content?.title).toBe('Ministerstwo Finansów ogłosiło awarię KSeF');
    expect(content?.severity).toBe('critical');
  });

  it('awaria całkowita mówi, że fakturę wystawia się poza KSeF i bez dosyłania (art. 106ng)', () => {
    const content = ksefBannerContent({ ...base, level: 'down', officialStatus: 'TOTAL_FAILURE' });
    expect(content?.title).toBe('Ministerstwo Finansów ogłosiło awarię całkowitą KSeF');
    expect(content?.description).toContain('poza KSeF');
    expect(content?.description).toContain('nie dosyłasz');
    expect(content?.severity).toBe('critical');
  });

  it('planowana przerwa podaje koniec w czasie polskim', () => {
    const content = ksefBannerContent({
      ...base,
      officialStatus: 'MAINTENANCE',
      officialEnd: '2026-11-06T17:30:00.000Z',
    });
    expect(content?.title).toBe('Planowana przerwa w KSeF');
    expect(content?.description).toContain('06.11.2026');
    expect(content?.description).toContain('18:30');
    expect(content?.severity).toBe('warning');
  });

  it('planowana przerwa bez końca nie wymyśla daty', () => {
    const content = ksefBannerContent({ ...base, officialStatus: 'MAINTENANCE' });
    expect(content?.description).not.toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  it('503 z naszej sondy to nie ogłoszenie MF', () => {
    const content = ksefBannerContent({ ...base, level: 'down', isMfOutage: true, officialStatus: 'AVAILABLE' });
    expect(content?.title).toBe('KSeF jest niedostępny');
    expect(content?.title).not.toContain('Ministerstwo');
    const unknown = ksefBannerContent({ ...base, level: 'down', isMfOutage: true, officialStatus: null });
    expect(unknown?.title).toBe('KSeF jest niedostępny');
  });

  it('wolny KSeF: dotychczasowe ostrzeżenie z czasem odpowiedzi', () => {
    const content = ksefBannerContent({ ...base, level: 'degraded', responseTimeMs: 3200 });
    expect(content?.title).toBe('KSeF działa wolno');
    expect(content?.description).toContain('3200');
    expect(content?.severity).toBe('warning');
  });

  it('klucz schowania zmienia się przy zmianie stanu MF, więc baner wraca', () => {
    const down = { ...base, level: 'down' as const };
    expect(ksefBannerKey(down)).not.toBe(ksefBannerKey({ ...down, officialStatus: 'FAILURE' }));
    expect(ksefBannerKey({ ...down, officialStatus: 'FAILURE' })).not.toBe(
      ksefBannerKey({ ...down, officialStatus: 'TOTAL_FAILURE' }),
    );
  });
});

describe('toPublicKsefHealth', () => {
  it('przekazuje stan MF, ale nie tekst błędu dla operatora', () => {
    const snapshot: KsefHealthSnapshot = {
      ...base,
      error: 'ECONNRESET 10.0.0.1',
      officialStatus: 'FAILURE',
      officialEnd: '2026-11-06T17:30:00.000Z',
    };
    const result = toPublicKsefHealth(snapshot);
    expect(result.officialStatus).toBe('FAILURE');
    expect(result.officialEnd).toBe('2026-11-06T17:30:00.000Z');
    expect(result).not.toHaveProperty('error');
  });
});
