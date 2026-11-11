import { describe, expect, it } from 'vitest';

import { ucieknijTekst, zawinLinie, zbudujKalendarz, type ZdarzenieIcal } from '@/lib/kalendarz/ical';

/**
 * Krok 7.3 planu kompletnej aplikacji: format iCalendar (RFC 5545) dla adresu
 * kalendarza klienta. Generator jest czysty: ten sam wejściowy zestaw daje te
 * same UID-y, a czas generowania wchodzi tylko do DTSTAMP.
 */

const TERAZ = new Date('2026-11-10T12:00:00Z');
const ZDARZENIE: ZdarzenieIcal = {
  uid: 'faktura-aaaa@faktway.pl',
  data: '2026-11-20',
  tytul: 'Płatność: FV/1/2026',
  opis: 'Kwota 123,00 zł',
};

function oktety(linia: string): number {
  return Buffer.byteLength(linia, 'utf8');
}

/** Rozwija zawinięte linie (RFC 5545, 3.1): CRLF i jedna spacja znikają. */
function rozwin(tekst: string): string {
  return tekst.replace(/\r\n[ \t]/g, '');
}

describe('zbudujKalendarz', () => {
  it('daje VCALENDAR z VEVENT, linie kończą się CRLF i nie ma samotnego LF', () => {
    const ics = zbudujKalendarz({ nazwa: 'FaktWay: terminy', zdarzenia: [ZDARZENIE], teraz: TERAZ });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(true);
    expect(ics).toMatch(/PRODID:/);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const linie = rozwin(ics).split('\r\n');
    expect(linie).toContain('UID:faktura-aaaa@faktway.pl');
    expect(linie).toContain('DTSTAMP:20261110T120000Z');
    expect(linie).toContain('DTSTART;VALUE=DATE:20261120');
    expect(linie).toContain('SUMMARY:Płatność: FV/1/2026');
    expect(linie).toContain('DESCRIPTION:Kwota 123\\,00 zł');
  });

  it('żadna fizyczna linia nie ma więcej niż 75 oktetów, a rozwinięcie oddaje treść', () => {
    const dlugi = { ...ZDARZENIE, tytul: 'Zażółć gęślą jaźń '.repeat(12), opis: 'ąęćłńóśźż, '.repeat(30) };
    const ics = zbudujKalendarz({ nazwa: 'X', zdarzenia: [dlugi], teraz: TERAZ });
    for (const linia of ics.split('\r\n')) expect(oktety(linia)).toBeLessThanOrEqual(75);
    expect(ics).not.toContain('�');
    expect(rozwin(ics)).toContain(`SUMMARY:${dlugi.tytul}`);
  });

  it('UID jest stabilny między pobraniami, zmienia się tylko DTSTAMP', () => {
    const a = zbudujKalendarz({ nazwa: 'X', zdarzenia: [ZDARZENIE], teraz: TERAZ });
    const b = zbudujKalendarz({ nazwa: 'X', zdarzenia: [ZDARZENIE], teraz: new Date('2026-11-11T08:00:00Z') });
    const uid = (s: string) => s.split('\r\n').filter((l) => l.startsWith('UID:'));
    expect(uid(a)).toEqual(uid(b));
    expect(a).not.toEqual(b);
  });

  it('porządkuje zdarzenia po dacie i UID, niezależnie od kolejności wejścia', () => {
    const z2 = { ...ZDARZENIE, uid: 'b@faktway.pl', data: '2026-11-19' };
    const a = zbudujKalendarz({ nazwa: 'X', zdarzenia: [ZDARZENIE, z2], teraz: TERAZ });
    const b = zbudujKalendarz({ nazwa: 'X', zdarzenia: [z2, ZDARZENIE], teraz: TERAZ });
    expect(a).toEqual(b);
    expect(a.indexOf('UID:b@faktway.pl')).toBeLessThan(a.indexOf('UID:faktura-aaaa@faktway.pl'));
  });
});

describe('ucieknijTekst', () => {
  it('ucieka przecinek, średnik, ukośnik i nowy wiersz', () => {
    expect(ucieknijTekst('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    expect(ucieknijTekst('a\r\nb')).toBe('a\\nb');
  });

  it('nie wpuszcza do wartości sztucznej linii (wstrzyknięcie właściwości)', () => {
    const ics = zbudujKalendarz({
      nazwa: 'X',
      zdarzenia: [{ ...ZDARZENIE, tytul: 'x\r\nATTENDEE:mailto:zly@example.test' }],
      teraz: TERAZ,
    });
    expect(ics.split('\r\n').some((l) => l.startsWith('ATTENDEE'))).toBe(false);
  });
});

describe('zawinLinie', () => {
  it('krótką linię zostawia bez zmian', () => {
    expect(zawinLinie('SUMMARY:krótko')).toBe('SUMMARY:krótko');
  });

  it('dłuższą dzieli CRLF i spacją, nie rozcinając znaku wielobajtowego', () => {
    const wynik = zawinLinie(`SUMMARY:${'ł'.repeat(100)}`);
    const fizyczne = wynik.split('\r\n');
    expect(fizyczne.length).toBeGreaterThan(1);
    for (const f of fizyczne.slice(1)) expect(f.startsWith(' ')).toBe(true);
    for (const f of fizyczne) expect(oktety(f)).toBeLessThanOrEqual(75);
    expect(rozwin(wynik)).toBe(`SUMMARY:${'ł'.repeat(100)}`);
  });
});
