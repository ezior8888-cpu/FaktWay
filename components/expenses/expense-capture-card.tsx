'use client';

import { RiCameraLine, RiImageLine, RiLoader4Line } from '@remixicon/react';

import { useExpenseCapture } from '@/components/expenses/use-expense-capture';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * Pas „Wydatek” na ekranie wyboru dokumentu (`/invoices/new`). Plus dolnego
 * paska telefonu prowadzi tutaj, a na telefonie ludzie głównie wrzucają koszty
 * (poprawka Bartosza 25.10.2026), więc pas stoi tam na górze.
 *
 * Od 11.11.2026 to niski pas pod kartami faktur, nie szósty kafel: tekst po
 * lewej, przyciski po prawej (na telefonie pod tekstem, na całą szerokość).
 *
 * Wgranie, odczyt i przejście do rozpoznanego wydatku robi ten sam hak co
 * „+ Dodaj wydatek” na Kosztach (`useExpenseCapture`). Przyciski wołają
 * `click()` pola pliku wprost w obsłudze dotknięcia, inaczej iOS nie otworzy
 * aparatu.
 */
export function ExpenseCaptureCard() {
  const { state, busy, openCamera, openGallery, inputs } = useExpenseCapture();

  return (
    <Card className="flex-col gap-4 px-5 py-5 shadow-none sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 space-y-1">
        <h2 className="text-base font-semibold tracking-tight">Wydatek</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Zdjęcie paragonu albo faktury kosztowej. Dane odczytamy sami.
        </p>
        {state.kind === 'failed' ? (
          <p role="alert" className="text-destructive text-sm">
            {state.error}
          </p>
        ) : null}
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
        <Button size="lg" onClick={openCamera} disabled={busy}>
          {busy ? (
            <>
              <RiLoader4Line aria-hidden className="animate-spin" />
              {state.kind === 'uploading' ? 'Wgrywanie…' : 'Rozpoznaję…'}
            </>
          ) : (
            <>
              <RiCameraLine aria-hidden />
              Zrób zdjęcie
            </>
          )}
        </Button>
        <Button size="lg" variant="outline" onClick={openGallery} disabled={busy}>
          <RiImageLine aria-hidden />
          Wybierz plik
        </Button>
      </div>
      {inputs}
    </Card>
  );
}
