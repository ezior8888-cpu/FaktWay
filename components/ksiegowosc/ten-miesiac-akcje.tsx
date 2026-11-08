'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { dodajZaplateRecznaAction, oznaczZaplaconeAction, zatwierdzMiesiacAction } from '@/app/actions/ksiegowosc-ten-miesiac';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { zaplataRecznaSchema, type RodzajZaplatyRecznej } from '@/lib/ksiegowosc/zaplata-reczna';

/**
 * „Zatwierdź miesiąc” (D6): zapisuje wersje rozliczeń, których dane się
 * zmieniły, i tylko te kwoty, które są na ekranie (`skroty`). Po odmowie
 * strona się odświeża, więc widać aktualny stan.
 */
export function ZatwierdzMiesiac({
  miesiac,
  skroty,
  etykieta,
  nadwyzkaVat = null,
}: {
  miesiac: string;
  skroty: Record<string, string>;
  etykieta: string;
  /** P_39 wpisane na ekranie (K7.1); akcja liczy VAT z tą samą kwotą. */
  nadwyzkaVat?: number | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const zatwierdz = () =>
    startTransition(async () => {
      const wynik = await zatwierdzMiesiacAction({ miesiac, skroty, nadwyzkaVat });
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

/**
 * Zapłata spoza wyliczenia (K7.2, D15): składki za okres, którego FaktWay nie
 * liczy, z kwotą z PUE ZUS. Ten sam schemat Zod co akcja; po zapisie strona
 * się odświeża i zapłata pomniejsza podatek jak każda oznaczona zapłata.
 */
export function ZaplataReczna({ domyslnyMiesiac, domyslnaData, dzis }: { domyslnyMiesiac: string; domyslnaData: string; dzis: string }) {
  const router = useRouter();
  const [zaMiesiac, setZaMiesiac] = useState(domyslnyMiesiac);
  const [rodzaj, setRodzaj] = useState<RodzajZaplatyRecznej>('zus_spoleczne');
  const [kwota, setKwota] = useState('');
  const [bezFp, setBezFp] = useState('');
  const [dataZaplaty, setDataZaplaty] = useState(domyslnaData);
  const [bledy, setBledy] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const wejscie = () => ({ zaMiesiac, rodzaj, kwota, bezFp: rodzaj === 'zus_spoleczne' ? bezFp : '', dataZaplaty });
  const blad = (pole: string) =>
    bledy[pole] ? (
      <p id={`zaplata-blad-${pole}`} role="alert" className="text-destructive text-xs">
        {bledy[pole]}
      </p>
    ) : null;

  const zapisz = () => {
    const parsed = zaplataRecznaSchema.safeParse(wejscie());
    if (!parsed.success) {
      const nowe: Record<string, string> = {};
      for (const issue of parsed.error.issues) nowe[String(issue.path[0] ?? 'formularz')] ??= issue.message;
      setBledy(nowe);
      return;
    }
    setBledy({});
    startTransition(async () => {
      const wynik = await dodajZaplateRecznaAction(wejscie());
      if (wynik.success) {
        toast.success('Zapłata zapisana');
        setKwota('');
        setBezFp('');
        router.refresh();
      } else {
        setBledy({ [wynik.pole ?? 'formularz']: wynik.error });
        toast.error(wynik.error);
      }
    });
  };

  return (
    <FieldGroup>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="zaplata-za-miesiac">Składki za miesiąc</FieldLabel>
          <Input id="zaplata-za-miesiac" type="month" value={zaMiesiac} max={dzis.slice(0, 7)} disabled={pending} onChange={(e) => setZaMiesiac(e.target.value)} />
          {blad('zaMiesiac')}
        </Field>
        <Field>
          <FieldLabel htmlFor="zaplata-data">Data zapłaty</FieldLabel>
          <Input id="zaplata-data" type="date" value={dataZaplaty} max={dzis} disabled={pending} onChange={(e) => setDataZaplaty(e.target.value)} />
          {blad('dataZaplaty')}
        </Field>
      </div>
      <Field>
        <FieldLabel id="zaplata-rodzaj">Rodzaj składek</FieldLabel>
        <RadioGroup
          aria-labelledby="zaplata-rodzaj"
          value={rodzaj}
          disabled={pending}
          onValueChange={(v) => setRodzaj(v as RodzajZaplatyRecznej)}
          className="sm:flex sm:gap-6"
        >
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="zus_spoleczne" />
            Składki społeczne
          </label>
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="zdrowotna" />
            Składka zdrowotna
          </label>
        </RadioGroup>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="zaplata-kwota">Zapłacona kwota (zł)</FieldLabel>
          <Input id="zaplata-kwota" inputMode="decimal" value={kwota} disabled={pending} onChange={(e) => setKwota(e.target.value)} />
          {blad('kwota')}
        </Field>
        {rodzaj === 'zus_spoleczne' ? (
          <Field>
            <FieldLabel htmlFor="zaplata-bez-fp">W tym bez Funduszu Pracy i FS (zł)</FieldLabel>
            <Input id="zaplata-bez-fp" inputMode="decimal" value={bezFp} disabled={pending} onChange={(e) => setBezFp(e.target.value)} />
            <FieldDescription>Kwota składek na ubezpieczenia społeczne z DRA, bez Funduszu Pracy i FS.</FieldDescription>
            {blad('bezFp')}
          </Field>
        ) : null}
      </div>
      {blad('formularz')}
      <div className="flex justify-end">
        <Button type="button" onClick={zapisz} disabled={pending}>
          {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Zapisz zapłatę
        </Button>
      </div>
    </FieldGroup>
  );
}

