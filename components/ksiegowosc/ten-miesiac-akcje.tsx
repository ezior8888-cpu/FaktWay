'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { oznaczZaplaconeAction, zatwierdzMiesiacAction } from '@/app/actions/ksiegowosc-ten-miesiac';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * „Zatwierdź miesiąc” (D6): zapisuje wersje rozliczeń, których dane się
 * zmieniły, i tylko te kwoty, które są na ekranie (`skroty`). Po odmowie
 * strona się odświeża, więc widać aktualny stan.
 */
export function ZatwierdzMiesiac({ miesiac, skroty, etykieta }: { miesiac: string; skroty: Record<string, string>; etykieta: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const zatwierdz = () =>
    startTransition(async () => {
      const wynik = await zatwierdzMiesiacAction({ miesiac, skroty });
      if (wynik.success) {
        toast.success(wynik.nowe > 0 ? 'Miesiąc zatwierdzony' : 'Miesiąc był już zatwierdzony w tej wersji');
      } else {
        toast.error(wynik.error);
        router.refresh();
      }
    });
  return (
    <Button type="button" onClick={zatwierdz} disabled={pending}>
      {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
      {etykieta}
    </Button>
  );
}

/** Oznaczenie zapłaty z datą (domyślnie dziś) albo jego cofnięcie. */
export function ZaplaconeRozliczenie({
  id,
  nazwa,
  zaplacone,
  dzis,
  najwczesniej,
}: {
  id: string;
  nazwa: string;
  zaplacone: boolean;
  dzis: string;
  /** Pierwszy dzień miesiąca rozliczenia: wcześniejszej daty zapłaty akcja nie przyjmie. */
  najwczesniej: string;
}) {
  const router = useRouter();
  const [data, setData] = useState(dzis);
  const [pending, startTransition] = useTransition();
  const zapisz = (zaplacono: boolean) =>
    startTransition(async () => {
      const wynik = await oznaczZaplaconeAction({ id, zaplacone: zaplacono, data: zaplacono ? data : null });
      if (wynik.success) {
        toast.success(zaplacono ? 'Zapłata zapisana' : 'Zapłata cofnięta');
      } else {
        toast.error(wynik.error);
        router.refresh();
      }
    });

  if (zaplacone) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => zapisz(false)} disabled={pending} aria-label={`Cofnij zapłatę: ${nazwa}`}>
        Cofnij
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="date"
        value={data}
        min={najwczesniej}
        max={dzis}
        onChange={(e) => setData(e.target.value)}
        disabled={pending}
        aria-label={`Data zapłaty: ${nazwa}`}
        className="w-40"
      />
      <Button type="button" size="sm" variant="outline" onClick={() => zapisz(true)} disabled={pending || !data} aria-label={`Zapłacone: ${nazwa}`}>
        {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
        Zapłacone
      </Button>
    </div>
  );
}
