'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { RiFileZipLine, RiLoader4Line } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { saveBlob } from '@/lib/download';

/** Komunikat dla klienta z kodu błędu endpointu `/api/invoices/batch-pdf`. */
export function batchPdfErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'no_invoices':
      return 'Brak faktur w tym miesiącu.';
    case 'too_many':
      return 'Za dużo faktur w miesiącu (limit 100). Skontaktuj się z pomocą.';
    case 'offline_qr_unavailable':
      return 'Paczka zawiera fakturę offline bez wymaganego kodu CERTYFIKAT. Pobierz ją po nadaniu numeru KSeF.';
    case 'not_found':
      return 'Nie znaleziono zaznaczonych faktur. Odśwież listę i spróbuj ponownie.';
    case 'invalid_ids':
      return 'Zaznacz od 1 do 100 faktur.';
    case 'busy':
    case 'rate_limited':
      return 'Za dużo paczek naraz. Odczekaj chwilę i spróbuj ponownie.';
    case 'pdf_state_changed':
      return 'Faktura zmieniła stan w trakcie przygotowania paczki. Spróbuj ponownie.';
    default:
      return 'Nie udało się przygotować paczki ZIP.';
  }
}

/**
 * Pobranie ZIP z PDF wszystkich faktur wybranego miesiąca (Faza 33 Krok 7).
 *
 * Domyślnie bieżący miesiąc. ZIP buduje endpoint `/api/invoices/batch-pdf`.
 */
export function BatchPdfDownload() {
  const [month, setMonth] = useState<string>(() =>
    new Date().toISOString().slice(0, 7),
  );
  const [isPending, start] = useTransition();

  const download = () => {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      toast.error('Wybierz miesiąc.');
      return;
    }
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    // Ostatni dzień miesiąca: dzień 0 kolejnego miesiąca.
    const to = `${month}-${String(new Date(y!, m!, 0).getDate()).padStart(2, '0')}`;

    start(async () => {
      try {
        const res = await fetch(
          `/api/invoices/batch-pdf?from=${from}&to=${to}`,
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(batchPdfErrorMessage(body.error));
          return;
        }
        const blob = await res.blob();
        saveBlob(blob, `Faktury_${month}.zip`);
      } catch {
        toast.error('Błąd połączenia przy pobieraniu paczki.');
      }
    });
  };

  // Plan Finora E3b: jeden rząd z przyciskami paska listy (Finora: „Show” + „Create Invoice”).
  // Stoi w formularzu GET filtrów, więc pole miesiąca nie należy do niego (`form` bez takiego
  // formularza) — Enter i „Filtruj” nie wysyłają miesiąca paczki jako filtra.
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="batch-month" className="sr-only">
        Pobierz PDF za miesiąc
      </label>
      <Input
        id="batch-month"
        type="month"
        form="paczka-pdf-za-miesiac"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        className="w-40"
      />
      <Button type="button" variant="outline" onClick={download} disabled={isPending} title="Pobierz PDF za miesiąc (ZIP)">
        {isPending ? (
          <RiLoader4Line className="animate-spin" />
        ) : (
          <RiFileZipLine />
        )}
        PDF za miesiąc (ZIP)
      </Button>
    </div>
  );
}

/**
 * „Pobierz PDF zaznaczonych (N)” — ZIP z faktur zaznaczonych w tabeli
 * (`/api/invoices/batch-pdf?ids=…`; serwer sprawdza, że wszystkie należą do
 * aktywnej firmy). Ukryty, gdy nic nie zaznaczono.
 */
export function SelectedPdfDownload({ ids }: { ids: readonly string[] }) {
  const [isPending, start] = useTransition();
  if (ids.length === 0) return null;

  const download = () => {
    start(async () => {
      try {
        const res = await fetch(`/api/invoices/batch-pdf?ids=${ids.join(',')}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(batchPdfErrorMessage(body.error));
          return;
        }
        const cd = res.headers.get('Content-Disposition') ?? '';
        const filename = cd.match(/filename="(.+?)"/)?.[1] ?? 'Faktury_zaznaczone.zip';
        saveBlob(await res.blob(), filename);
      } catch {
        toast.error('Błąd połączenia przy pobieraniu paczki.');
      }
    });
  };

  return (
    <Button variant="outline" size="sm" onClick={download} disabled={isPending}>
      {isPending ? <RiLoader4Line className="animate-spin" /> : <RiFileZipLine />}
      {`Pobierz PDF zaznaczonych (${ids.length})`}
    </Button>
  );
}
