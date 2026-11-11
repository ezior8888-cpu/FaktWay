import { describe, expect, it } from 'vitest';

/**
 * Krok 1.4, część 2 planu kompletnej aplikacji (RP-PLAT-02): identyfikator
 * zbiorczy KSeF, czyli numer, który KSeF nadaje kilku fakturom jednego
 * sprzedawcy do tytułu jednego przelewu (art. 108g ustawy o VAT).
 *
 * Format ze specyfikacji KSeF 2.0 (OpenAPI TEST, pole
 * `GenerateCollectiveIdentifierResponse.collectiveIdentifierNumber`):
 * 35 znaków, `9999999999-IZRRRRMM-FFFFFFFFFFFF-FF` (NIP sprzedawcy, stałe
 * „IZ”, rok i miesiąc, 12 znaków HEX, suma kontrolna CRC-8: wielomian 0x07,
 * start 0x00, wielkie litery HEX).
 *
 * Wyrocznia: wektor z dokumentacji `1111111111-IZ202607-65ED02180000-E7`
 * i sumy policzone niezależnie od kodu FaktWay (Python, CRC-8 bit po bicie,
 * po pierwszych 32 znakach razem z myślnikami). Bez myślników wektor dałby
 * `D7`, więc test rozstrzyga też, z których znaków liczyć.
 */

const WEKTOR = '1111111111-IZ202607-65ED02180000-E7';

describe('identyfikator zbiorczy: wektor z dokumentacji KSeF', () => {
  it('wektor przechodzi i wraca bez zmian', async () => {
    const { poprawnyIdentyfikatorZbiorczy, DLUGOSC_IDENTYFIKATORA_ZBIORCZEGO } = await import('@/lib/invoices/identyfikator-zbiorczy');
    expect(poprawnyIdentyfikatorZbiorczy(WEKTOR)).toBe(WEKTOR);
    expect(WEKTOR).toHaveLength(DLUGOSC_IDENTYFIKATORA_ZBIORCZEGO);
    expect(DLUGOSC_IDENTYFIKATORA_ZBIORCZEGO).toBe(35);
  });

  it('CRC-8 (0x07, start 0x00) po pierwszych 32 znakach z myślnikami daje E7', async () => {
    const { sumaKontrolnaIdentyfikatora } = await import('@/lib/invoices/identyfikator-zbiorczy');
    expect(sumaKontrolnaIdentyfikatora('1111111111-IZ202607-65ED02180000')).toBe('E7');
    // Bez myślników wychodzi D7: suma nie jest liczona po samych cyfrach i literach.
    expect(sumaKontrolnaIdentyfikatora('1111111111IZ20260765ED02180000')).toBe('D7');
  });

  it.each([
    ['1234567890-IZ202611-0A1B2C3D4E5F', 'A0'],
    ['1234567890-IZ202612-00000000A001', '91'],
    ['1111111111-IZ202611-ABCDEF012345', '1C'],
    // Przykład z MF i blogów ma na końcu FF, a jego suma to 63: to atrapa.
    ['9999999999-IZ202602-FFFFFFFFFFFF', '63'],
  ])('suma policzona niezależnie: %s → %s', async (poczatek, suma) => {
    const { sumaKontrolnaIdentyfikatora, poprawnyIdentyfikatorZbiorczy } = await import('@/lib/invoices/identyfikator-zbiorczy');
    expect(sumaKontrolnaIdentyfikatora(poczatek)).toBe(suma);
    expect(poprawnyIdentyfikatorZbiorczy(`${poczatek}-${suma}`)).toBe(`${poczatek}-${suma}`);
  });

  it('NIP sprzedawcy to pierwsze 10 cyfr identyfikatora', async () => {
    const { nipZIdentyfikatora } = await import('@/lib/invoices/identyfikator-zbiorczy');
    expect(nipZIdentyfikatora(WEKTOR)).toBe('1111111111');
  });

  it('białe znaki z brzegów odpadają, jak przy numerze KSeF', async () => {
    const { poprawnyIdentyfikatorZbiorczy } = await import('@/lib/invoices/identyfikator-zbiorczy');
    expect(poprawnyIdentyfikatorZbiorczy(` ${WEKTOR}\n`)).toBe(WEKTOR);
  });
});

describe('identyfikator zbiorczy: przypadki błędne', () => {
  it.each([
    ['przykład MF z sumą FF (atrapa)', '9999999999-IZ202602-FFFFFFFFFFFF-FF'],
    ['zła suma kontrolna', '1111111111-IZ202607-65ED02180000-E8'],
    ['zmieniony znak w części HEX, suma ta sama', '1111111111-IZ202607-65ED02180001-E7'],
    ['zmieniona cyfra NIP, suma ta sama', '1111111112-IZ202607-65ED02180000-E7'],
    ['zamienione miejscami dwa znaki', '1111111111-IZ202607-56ED02180000-E7'],
    ['małe litery w części HEX', '1111111111-IZ202607-65ed02180000-E7'],
    ['małe litery w sumie', '1111111111-IZ202607-65ED02180000-e7'],
    ['bez myślników', '1111111111IZ20260765ED02180000E7'],
    ['NIP od zera', '0111111111-IZ202607-65ED02180000-E7'],
    ['NIP z 9 cyfr', '111111111-IZ202607-65ED02180000-E7'],
    ['miesiąc 13', '1111111111-IZ202613-65ED02180000-E7'],
    ['miesiąc 00', '1111111111-IZ202600-65ED02180000-E7'],
    ['rok spoza 20xx', '1111111111-IZ199907-65ED02180000-E7'],
    ['inny prefiks niż IZ', '1111111111-IX202607-65ED02180000-E7'],
    ['numer KSeF faktury zamiast identyfikatora', '1111111111-20260612-6310EC800000-DA'],
    ['11 znaków HEX', '1111111111-IZ202607-65ED0218000-E7'],
    ['13 znaków HEX', '1111111111-IZ202607-65ED021800000-E7'],
    ['spacja w środku', '1111111111-IZ202607-65ED0218 000-E7'],
    ['cyfry arabskie wschodnie zamiast zwykłych', '١١١١١١١١١١-IZ202607-65ED02180000-E7'],
    ['pusty napis', ''],
  ])('%s: odrzucony', async (_opis, wartosc) => {
    const { poprawnyIdentyfikatorZbiorczy } = await import('@/lib/invoices/identyfikator-zbiorczy');
    expect(poprawnyIdentyfikatorZbiorczy(wartosc)).toBeNull();
  });

  it.each([[null], [undefined], [123], [{ collectiveIdentifierNumber: WEKTOR }], [[WEKTOR]]])(
    'wartość spoza napisu (%j): odrzucona',
    async (wartosc) => {
      const { poprawnyIdentyfikatorZbiorczy } = await import('@/lib/invoices/identyfikator-zbiorczy');
      expect(poprawnyIdentyfikatorZbiorczy(wartosc)).toBeNull();
    },
  );

  it('każda pojedyncza zmiana znaku w części liczonej psuje sumę (CRC-8 wykrywa błąd jednego znaku)', async () => {
    const { poprawnyIdentyfikatorZbiorczy } = await import('@/lib/invoices/identyfikator-zbiorczy');
    const zamiany = '0123456789ABCDEF';
    let sprawdzone = 0;
    // Zmiana jednego bajtu to błąd w 8 kolejnych bitach, a CRC stopnia 8 wykrywa każdy taki błąd.
    // Zmiana, która psuje format (litera w NIP, miesiąc 13), też musi dać odrzucenie.
    for (let i = 0; i < 32; i++) {
      const znak = WEKTOR[i]!;
      if (!/[0-9A-F]/.test(znak)) continue; // „IZ” i myślniki zostają
      for (const inny of zamiany) {
        if (inny === znak) continue;
        const zly = `${WEKTOR.slice(0, i)}${inny}${WEKTOR.slice(i + 1)}`;
        expect(poprawnyIdentyfikatorZbiorczy(zly), zly).toBeNull();
        sprawdzone += 1;
      }
    }
    expect(sprawdzone).toBeGreaterThan(300);
  });

  it('limity KSeF ze specyfikacji: od 2 do 500 faktur, najwyżej 132 identyfikatory na fakturę', async () => {
    const { MIN_FAKTUR_W_IDENTYFIKATORZE, MAKS_FAKTUR_W_IDENTYFIKATORZE, MAKS_IDENTYFIKATOROW_FAKTURY } = await import(
      '@/lib/invoices/identyfikator-zbiorczy'
    );
    expect([MIN_FAKTUR_W_IDENTYFIKATORZE, MAKS_FAKTUR_W_IDENTYFIKATORZE, MAKS_IDENTYFIKATOROW_FAKTURY]).toEqual([2, 500, 132]);
  });
});
