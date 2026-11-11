// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ekrany not (krok 2.9, część 1): lista, podgląd i formularz. Tekst ekranu
 * mówi, że nota nie jest fakturą, nie trafia do KSeF ani do KPiR i raportów,
 * a ujęcie w księgach ustala księgowa. Formularz odsyła firmę strony (UX-01).
 */

const m = vi.hoisted(() => ({ save: vi.fn(), push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push, refresh: m.refresh, replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/noty', () => ({
  saveNoteDraftAction: m.save,
  addNoteContractorAction: vi.fn(),
  issueNoteAction: vi.fn(),
  deleteNoteDraftAction: vi.fn(),
  sendNoteEmailAction: vi.fn(),
}));

import { NoteDocument } from '@/app/(dashboard)/noty/_components/note-document';
import { NoteForm } from '@/app/(dashboard)/noty/_components/note-form';
import { NotesList } from '@/app/(dashboard)/noty/_components/notes-list';
import type { AccountingNote, NoteListItem } from '@/lib/noty/model';
import { NOTE_BOOKS_NOTICE, NOTE_NOT_INVOICE_NOTICE } from '@/lib/noty/teksty';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KONTRAHENT = '0b8a3f4e-2c1d-4e5f-8a9b-0c1d2e3f4a5b';
const NOTA = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
const SZKIC = '6e1f9b9d-8b4c-4a72-8e3f-2d5c6b7a8f91';

const plain = (html: string) => html.replace(/ /g, ' ').replace(/&quot;/g, '"');

function wiersz(extra: Partial<NoteListItem> = {}): NoteListItem {
  return {
    id: NOTA,
    kind: 'debit',
    status: 'issued',
    number: 'NO/1/2026',
    issueDate: '2026-11-11',
    title: 'Kara umowna',
    counterpartyName: 'Kontrahent Testowy',
    total: 12_099.99,
    ...extra,
  };
}

function nota(extra: Partial<AccountingNote> = {}): AccountingNote {
  return {
    id: NOTA,
    tenantId: TENANT,
    kind: 'debit',
    status: 'issued',
    number: 'NO/1/2026',
    issueDate: '2026-11-11',
    title: 'Kara umowna',
    items: [{ description: 'Kara za opóźnienie dostawy', amount: 12_099.99 }],
    total: 12_099.99,
    currency: 'PLN',
    contractorId: KONTRAHENT,
    counterparty: {
      name: 'Kontrahent Testowy',
      nip: '1234567890',
      countryCode: 'PL',
      addressLine1: 'ul. Klienta 10',
      addressLine2: '02-001 Warszawa',
      email: 'ksiegowosc@kontrahent.test',
    },
    issuer: {
      name: 'Moja Firma',
      nip: '1234567890',
      countryCode: 'PL',
      addressLine1: 'ul. Przykładowa 1',
      addressLine2: '00-001 Warszawa',
    },
    relatedDocument: 'FV/2026/11/3',
    dueDate: '2026-11-25',
    bankAccount: 'PL61109010140000071219812874',
    issuedAt: '2026-11-11T09:30:00.000Z',
    createdAt: '2026-11-11T09:00:00.000Z',
    ...extra,
  };
}

describe('lista not', () => {
  it('wiersz: numer, rodzaj, kontrahent, tytuł, data, kwota, stan i link do podglądu', () => {
    const html = plain(renderToStaticMarkup(<NotesList rows={[wiersz(), wiersz({ id: SZKIC, status: 'draft', number: null, kind: 'credit' })]} />));
    for (const tekst of ['NO/1/2026', 'Nota obciążeniowa', 'Nota uznaniowa', 'Kontrahent Testowy', 'Kara umowna', '11.11.2026', '12 099,99 zł', 'Wystawiona', 'Szkic']) {
      expect(html, tekst).toContain(tekst);
    }
    expect(html).toContain(`href="/noty/${NOTA}"`);
    expect(html).toContain(`href="/noty/${SZKIC}"`);
  });

  it('pusta lista: zachęta z linkiem do nowej noty', () => {
    const html = renderToStaticMarkup(<NotesList rows={[]} />);
    expect(html).toContain('href="/noty/nowa"');
    expect(html).toMatch(/Nie masz jeszcze not/);
  });

  it('teksty bez długich myślników', () => {
    expect(renderToStaticMarkup(<NotesList rows={[wiersz()]} />)).not.toMatch(/[—–]/);
  });
});

describe('podgląd noty', () => {
  it('wystawiona: numer, strony, pozycje, suma, termin i rachunek, adnotacja i informacja o księgach', () => {
    const html = plain(renderToStaticMarkup(<NoteDocument note={nota()} issuer={nota().issuer} />));
    for (const tekst of [
      'Nota obciążeniowa',
      'NO/1/2026',
      'Moja Firma',
      'Kontrahent Testowy',
      'Kara za opóźnienie dostawy',
      '12 099,99 PLN',
      '25.11.2026',
      'PL61 1090 1014 0000 0712 1981 2874',
      'FV/2026/11/3',
      NOTE_NOT_INVOICE_NOTICE,
      NOTE_BOOKS_NOTICE,
    ]) {
      expect(html, tekst).toContain(tekst);
    }
    expect(NOTE_BOOKS_NOTICE).toMatch(/KPiR/);
    expect(NOTE_BOOKS_NOTICE).toMatch(/księgow/);
  });

  it('szkic: bez numeru, z informacją, że numer nada wystawienie', () => {
    const html = renderToStaticMarkup(
      <NoteDocument note={nota({ status: 'draft', number: null, issuer: null, issuedAt: null })} issuer={nota().issuer} />,
    );
    expect(html).toMatch(/Szkic/);
    expect(html).toMatch(/numer nada/i);
    expect(html).not.toContain('NO/1/2026');
  });
});

describe('formularz noty', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    m.save.mockReset().mockResolvedValue({ success: true, id: SZKIC });
    m.push.mockReset();
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('bez kontrahentów w bazie: komunikat z wyjściem, bez pustej listy', () => {
    const html = renderToStaticMarkup(<NoteForm tenantId={TENANT} contractors={[]} today='2026-11-11' />);
    expect(html).toMatch(/Nie masz jeszcze kontrahentów/);
    expect(html).toMatch(/NIP/);
  });

  it('pokazuje ostrzeżenie: nota nie zastępuje faktury za towar albo usługę', () => {
    const html = renderToStaticMarkup(
      <NoteForm tenantId={TENANT} contractors={[{ id: KONTRAHENT, name: 'Kontrahent Testowy', nip: '1234567890', email: null }]} today='2026-11-11' />,
    );
    expect(html).toMatch(/fakturą, nie notą/);
    expect(html).toMatch(/PLN/);
  });

  it('zapis szkicu odsyła dane, firmę strony i identyfikator szkicu, potem przechodzi do podglądu', async () => {
    await act(async () => {
      root.render(
        <NoteForm
          tenantId={TENANT}
          contractors={[{ id: KONTRAHENT, name: 'Kontrahent Testowy', nip: '1234567890', email: null }]}
          today='2026-11-11'
          noteId={SZKIC}
          initial={{
            kind: 'debit',
            contractorId: KONTRAHENT,
            issueDate: '2026-11-11',
            title: 'Kara umowna',
            items: [{ description: 'Kara za opóźnienie', amount: '150,00' }],
            currency: 'PLN',
            relatedDocument: '',
            dueDate: '',
            bankAccount: '',
          }}
        />,
      );
    });
    const zapisz = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Zapisz szkic'));
    expect(zapisz).toBeTruthy();
    await act(async () => {
      zapisz!.click();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(m.save).toHaveBeenCalledTimes(1);
    const [wartosci, firma, id] = m.save.mock.calls[0]!;
    expect(firma).toBe(TENANT);
    expect(id).toBe(SZKIC);
    expect(wartosci).toMatchObject({ kind: 'debit', contractorId: KONTRAHENT, title: 'Kara umowna', currency: 'PLN' });
    expect(m.push).toHaveBeenCalledWith(`/noty/${SZKIC}`);
  });
});
