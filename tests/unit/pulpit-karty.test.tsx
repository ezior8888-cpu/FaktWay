import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RiFileList3Line } from '@remixicon/react';

import { ReceivablesAgingCard } from '@/components/dashboard/pulpit/receivables-aging-card';
import { RecentInvoicesCard, type RecentInvoice } from '@/components/dashboard/pulpit/recent-invoices-card';
import { formatPlMoney } from '@/lib/format/pl';
import { StatTile } from '@/components/dashboard/pulpit/stat-tile';
import { TopListsCard } from '@/components/dashboard/pulpit/top-lists-card';
import { PULPIT_EMPTY } from '@/components/dashboard/pulpit/card-states';

const tile = (change: Parameters<typeof StatTile>[0]['change']) =>
  renderToStaticMarkup(
    <StatTile icon={RiFileList3Line} title="Faktury" value="12" badge="Ten miesiąc" footnote="+ 2 szkice poza KSeF" change={change} />,
  );

describe('StatTile', () => {
  it('pokazuje wartość, tytuł, plakietkę i przypis', () => {
    const html = tile(null);
    expect(html).toContain('Faktury');
    expect(html).toContain('>12<');
    expect(html).toContain('Ten miesiąc');
    expect(html).toContain('+ 2 szkice poza KSeF');
    expect(html).not.toContain('$');
  });
  it('wzrost jest zielony, spadek czerwony, brak zmiany wyciszony', () => {
    expect(tile({ pct: 12 })).toMatch(/text-green-700[^>]*>\+12%/);
    expect(tile({ pct: -8 })).toMatch(/text-destructive[^>]*>−8%/);
    expect(tile({ pct: 0 })).toMatch(/text-muted-foreground[^>]*>0%/);
  });
  it('notatka zamiast procentu', () => {
    const html = tile({ note: 'Brak poprzedniego miesiąca' });
    expect(html).toContain('Brak poprzedniego miesiąca');
    expect(html).not.toContain('%');
  });
});

const buckets = [
  { key: 'notDue', label: 'Przed terminem', amount: 1000, count: 2, pct: 20 },
  { key: 'upTo30', label: 'Do 30 dni po terminie', amount: 1500, count: 1, pct: 30 },
  { key: 'over30', label: 'Ponad 30 dni po terminie', amount: 2500, count: 3, pct: 50 },
] as const;

describe('ReceivablesAgingCard', () => {
  it('pokazuje sumę, kolumny w kolejności, procenty i link Szczegóły', () => {
    const html = renderToStaticMarkup(
      <ReceivablesAgingCard total={5000} count={6} buckets={[...buckets]} note="Bez importów" />,
    );
    expect(html).toContain('Należności według terminu');
    expect(html).toContain(`${formatPlMoney(5000)} zł`);
    expect(html).toContain('Liczba faktur: 6');
    expect(html).toContain('href="/payments/overdue"');
    expect(html).toContain('Bez importów');
    const a = html.indexOf('Przed terminem');
    const b = html.indexOf('Do 30 dni');
    const c = html.indexOf('Ponad 30 dni');
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(html).toContain('>50%<');
    expect(html).toContain('height:50%');
    expect(html).toContain('bg-chart-1/20');
    expect(html).not.toContain('$');
  });
  it('total 0 daje pusty stan bez słupków', () => {
    const html = renderToStaticMarkup(
      <ReceivablesAgingCard total={0} count={0} buckets={[]} note="x" />,
    );
    expect(html).toContain('Brak otwartych należności');
    expect(html).not.toContain('height:');
  });
});

describe('TopListsCard', () => {
  const html = renderToStaticMarkup(
    <TopListsCard
      productsNote="Pozycje z faktur wystawionych"
      products={[{ key: 'p1', name: 'Usługa programistyczna', unit: 'godz.', net: 4200 }]}
      clients={[
        { key: 'c1', name: 'Alfa Sp. z o.o.', nip: '1234567890', consumers: false, net: 9000, changePct: 15 },
        { key: 'c2', name: 'Konsumenci', nip: null, consumers: true, net: 300, changePct: null },
      ]}
    />,
  );
  it('pokazuje obie listy, j.m., NIP, kwoty i procent', () => {
    expect(html).toContain('Najlepiej sprzedające się');
    expect(html).toContain('Najwięksi klienci');
    expect(html).toContain('Ostatnie 12 miesięcy');
    expect(html).toContain('j.m.: godz.');
    expect(html).toContain('NIP 1234567890');
    expect(html).toContain(`${formatPlMoney(4200)} zł`);
    expect(html).toContain('+15%');
    expect(html).toContain('Pozycje z faktur wystawionych');
  });
  it('klient bez historii dostaje „nowy”', () => {
    expect(html).toContain('>nowy<');
  });
  it('puste listy: pusty stan i akcja', () => {
    const empty = renderToStaticMarkup(<TopListsCard products={[]} clients={[]} productsNote="n" />);
    expect(empty.match(/Pokażemy to, gdy wystawisz pierwszą fakturę/g)).toHaveLength(2);
    expect(empty).toContain('href="/invoices/new"');
  });
});

describe('TopListsCard — brak produktów przy klientach', () => {
  it('same zaliczki/korekty: noProductSales zamiast „wystaw pierwszą fakturę”', () => {
    const out = renderToStaticMarkup(
      <TopListsCard
        products={[]}
        productsNote="n"
        clients={[{ key: 'c1', name: 'Alfa', nip: null, consumers: false, net: 100, changePct: 10 }]}
      />,
    );
    expect(out).toContain(PULPIT_EMPTY.noProductSales);
    expect(out).not.toContain('Pokażemy to, gdy wystawisz pierwszą fakturę');
    expect(out).toContain('bg-green-700/10 text-green-800');
    expect(out).not.toContain('text-green-600');
  });
});

describe('RecentInvoicesCard', () => {
  const invoices: RecentInvoice[] = [
    { id: 'i1', internalNumber: 'FV/1/2026', buyerName: 'Alfa', gross: 123, currency: 'PLN', paymentDueDate: '2026-10-31', payment: 'unpaid', ksefStatus: 'accepted' },
    { id: 'i2', internalNumber: null, buyerName: null, gross: 50, currency: 'EUR', paymentDueDate: null, payment: null, ksefStatus: null },
  ];
  const html = renderToStaticMarkup(<RecentInvoicesCard invoices={invoices} />);
  it('link do faktury, termin DD.MM.RRRR, brutto z walutą', () => {
    expect(html).toContain('href="/invoices/i1"');
    expect(html).toContain('FV/1/2026');
    expect(html).toContain('31.10.2026');
    expect(html).toContain('123,00 zł');
    expect(html).toContain('50,00 EUR');
    expect(html).toContain('(bez numeru)');
  });
  it('płatność null to „—”, status KSeF po polsku', () => {
    expect(html).toContain('Brak płatności do rozliczenia');
    expect(html).toContain('Zaakceptowana');
  });
  it('link „Wszystkie faktury” i pusty stan', () => {
    expect(html).toContain('Wszystkie faktury');
    expect(html).toContain('href="/invoices"');
    const empty = renderToStaticMarkup(<RecentInvoicesCard invoices={[]} />);
    expect(empty).toContain('Pokażemy to, gdy wystawisz pierwszą fakturę');
    expect(empty).toContain('Wszystkie faktury');
  });
});
