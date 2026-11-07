'use client';

import { useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { dodajWpisRecznyAction, usunWpisRecznyAction } from '@/app/actions/ksiegowosc-ewidencja';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { etykietaStawki, STAWKI_JPK_EWP_PB } from '@/lib/ksiegowosc/ewidencja';
import { NAZWY_RODZAJOW_WPISU, RODZAJE_WPISU, wpisSchema, type RodzajWpisu } from '@/lib/ksiegowosc/wpisy-reczne';

const STAWKI = STAWKI_JPK_EWP_PB.map((pb) => ({ label: etykietaStawki(pb), value: String(pb) }));

/**
 * Wpis ręczny ewidencji (plan księgowości JDG, K3): raport z kasy
 * rejestrującej albo inny dowód bez faktury z KSeF. Ten sam schemat Zod co
 * akcja; stawkę wybiera klient (D4), pole startuje od stawki z profilu.
 */
export function WpisRecznyForm({
  domyslnaData,
  domyslnaStawkaPb,
}: {
  domyslnaData: string;
  domyslnaStawkaPb: number | null;
}) {
  const [rodzaj, setRodzaj] = useState<RodzajWpisu>('raport_kasy');
  const [dataPrzychodu, setDataPrzychodu] = useState(domyslnaData);
  const [dokument, setDokument] = useState('');
  const [kwota, setKwota] = useState('');
  const [stawka, setStawka] = useState(domyslnaStawkaPb ? String(domyslnaStawkaPb) : '');
  const [opis, setOpis] = useState('');
  const [bledy, setBledy] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  // Komunikat znika, gdy klient zmieni pole, którego dotyczy.
  const wyczysc = (pole: string) =>
    setBledy((b) => {
      if (!(pole in b)) return b;
      const reszta = { ...b };
      delete reszta[pole];
      return reszta;
    });

  const wejscie = () => ({
    rodzaj,
    dataPrzychodu,
    dokument,
    kwota,
    stawkaPb: stawka === '' ? Number.NaN : Number(stawka),
    opis: opis.trim() === '' ? null : opis,
  });

  const dodaj = () => {
    const parsed = wpisSchema.safeParse(wejscie());
    if (!parsed.success) {
      const nowe: Record<string, string> = {};
      for (const issue of parsed.error.issues) nowe[String(issue.path[0] ?? 'formularz')] ??= issue.message;
      setBledy(nowe);
      return;
    }
    setBledy({});
    startTransition(async () => {
      const wynik = await dodajWpisRecznyAction(wejscie());
      if (wynik.success) {
        toast.success('Wpis dodany do ewidencji');
        setDokument('');
        setKwota('');
        setOpis('');
      } else {
        if (wynik.pole) setBledy({ [wynik.pole]: wynik.error });
        toast.error(wynik.error);
      }
    });
  };

  const blad = (pole: string) =>
    bledy[pole] ? (
      <p id={`wpis-blad-${pole}`} role="alert" className="text-destructive text-xs">
        {bledy[pole]}
      </p>
    ) : null;
  const opisBledu = (pole: string) => (bledy[pole] ? `wpis-blad-${pole}` : undefined);

  return (
    <FieldGroup>
      <Field>
        <FieldLabel id="wpis-rodzaj">Rodzaj dowodu</FieldLabel>
        <RadioGroup
          aria-labelledby="wpis-rodzaj"
          value={rodzaj}
          disabled={pending}
          onValueChange={(v) => setRodzaj(v as RodzajWpisu)}
          className="sm:flex sm:gap-6"
        >
          {RODZAJE_WPISU.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm">
              <RadioGroupItem value={r} />
              {NAZWY_RODZAJOW_WPISU[r]}
            </label>
          ))}
        </RadioGroup>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="wpis-data">Data przychodu</FieldLabel>
          <Input
            id="wpis-data"
            type="date"
            value={dataPrzychodu}
            disabled={pending}
            onChange={(e) => {
              setDataPrzychodu(e.target.value);
              wyczysc('dataPrzychodu');
            }}
            aria-invalid={bledy.dataPrzychodu ? true : undefined}
            aria-describedby={opisBledu('dataPrzychodu')}
          />
          {blad('dataPrzychodu')}
        </Field>
        <Field>
          <FieldLabel htmlFor="wpis-dokument">Numer dowodu</FieldLabel>
          <Input
            id="wpis-dokument"
            value={dokument}
            placeholder="np. raport miesięczny 03/2026"
            disabled={pending}
            onChange={(e) => {
              setDokument(e.target.value);
              wyczysc('dokument');
            }}
            aria-invalid={bledy.dokument ? true : undefined}
            aria-describedby={opisBledu('dokument')}
          />
          {blad('dokument')}
        </Field>
        <Field>
          <FieldLabel htmlFor="wpis-kwota">Kwota przychodu (zł)</FieldLabel>
          <Input
            id="wpis-kwota"
            inputMode="decimal"
            value={kwota}
            placeholder="np. 1 234,56"
            disabled={pending}
            onChange={(e) => {
              setKwota(e.target.value);
              wyczysc('kwota');
            }}
            aria-invalid={bledy.kwota ? true : undefined}
            aria-describedby={opisBledu('kwota')}
          />
          <FieldDescription>Zwrot zapisuje się kwotą ujemną.</FieldDescription>
          {blad('kwota')}
        </Field>
        <Field>
          <FieldLabel htmlFor="wpis-stawka">Stawka ryczałtu</FieldLabel>
          <Select
            items={STAWKI}
            value={stawka}
            disabled={pending}
            onValueChange={(v) => {
              if (v) setStawka(v);
              wyczysc('stawkaPb');
            }}
          >
            <SelectTrigger id="wpis-stawka" className="w-full" aria-describedby={opisBledu('stawkaPb')}>
              <SelectValue placeholder="Stawka ryczałtu" />
            </SelectTrigger>
            <SelectContent className="p-1" alignItemWithTrigger={false}>
              <SelectGroup>
                {STAWKI.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {blad('stawkaPb')}
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor="wpis-opis">Uwagi</FieldLabel>
        <Input
          id="wpis-opis"
          value={opis}
          placeholder="Nieobowiązkowo"
          disabled={pending}
          onChange={(e) => {
            setOpis(e.target.value);
            wyczysc('opis');
          }}
          aria-invalid={bledy.opis ? true : undefined}
          aria-describedby={opisBledu('opis')}
        />
        {blad('opis')}
      </Field>

      <div className="flex justify-end">
        <Button type="button" onClick={dodaj} disabled={pending}>
          {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Dodaj wpis
        </Button>
      </div>
    </FieldGroup>
  );
}

/** Usunięcie wpisu ręcznego z potwierdzeniem; poprawka to usunięcie i nowy wpis. */
export function UsunWpisPrzycisk({ id, dokument }: { id: string; dokument: string }) {
  const [otwarty, setOtwarty] = useState(false);
  const [pending, startTransition] = useTransition();

  const usun = () =>
    startTransition(async () => {
      const wynik = await usunWpisRecznyAction(id);
      if (wynik.success) {
        toast.success('Wpis usunięty z ewidencji');
        setOtwarty(false);
      } else {
        toast.error(wynik.error);
      }
    });

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOtwarty(true)} aria-label={`Usuń wpis ${dokument}`}>
        Usuń
      </Button>
      <AlertDialog open={otwarty} onOpenChange={setOtwarty}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Usunąć wpis {dokument}?</AlertDialogTitle>
            <AlertDialogDescription>
              Wpis zniknie z ewidencji i z pliku JPK_EWP. Usunięcie zostaje w historii zmian firmy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Anuluj</AlertDialogCancel>
            <Button type="button" variant="destructive" onClick={usun} disabled={pending}>
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Usuń
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
