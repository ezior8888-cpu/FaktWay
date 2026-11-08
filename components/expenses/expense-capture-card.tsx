'use client';

import { RiCameraLine, RiImageLine, RiLoader4Line, RiReceiptLine } from '@remixicon/react';

import { useExpenseCapture } from '@/components/expenses/use-expense-capture';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';

/**
 * Kafel „Wydatek” na ekranie wyboru dokumentu (`/invoices/new`), w układzie
 * kart rodzajów faktur (poprawka Bartosza 25.10.2026: plus dolnego paska
 * prowadzi tutaj, a na telefonie ludzie głównie wrzucają koszty).
 *
 * Wgranie, odczyt i przejście do rozpoznanego wydatku robi ten sam hak co
 * „+ Dodaj wydatek” na Kosztach (`useExpenseCapture`). Przyciski wołają
 * `click()` pola pliku wprost w obsłudze dotknięcia — inaczej iOS nie otworzy
 * aparatu.
 */
export function ExpenseCaptureCard() {
  const { state, busy, openCamera, openGallery, inputs } = useExpenseCapture();

  return (
    <Card className="h-full shadow-none">
      <CardHeader>
        <Avatar className="size-9.5 after:border-0">
          <AvatarFallback className="bg-primary/10 text-primary size-9.5 shrink-0 [&>svg]:size-4.75">
            <RiReceiptLine />
          </AvatarFallback>
        </Avatar>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-1">
        <h2 className="text-lg font-semibold">Wydatek</h2>
        <p className="text-muted-foreground text-sm">
          Zdjęcie paragonu albo faktury kosztowej. Dane odczytamy sami.
        </p>
        {state.kind === 'failed' ? (
          <p role="alert" className="text-destructive text-sm">
            {state.error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <Button onClick={openCamera} disabled={busy}>
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
        <Button variant="outline" onClick={openGallery} disabled={busy}>
          <RiImageLine aria-hidden />
          Wybierz plik
        </Button>
      </CardFooter>
      {inputs}
    </Card>
  );
}
