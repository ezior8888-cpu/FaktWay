'use client';

import { useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { dodajSpisAction, usunSpisAction } from '@/app/actions/ksiegowosc-ewidencja';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { spisSchema } from '@/lib/ksiegowosc/spis-z-natury';

/**
 * Spis z natury (plan księgowości JDG, K7.4, D19): data, wartość i opis. Ten
 * sam schemat Zod co akcja; poprawka to usunięcie spisu i dodanie nowego.
 */
export function SpisZNaturyForm({ domyslnaData, dzis }: { domyslnaData: string; dzis: string }) {
  const [data, setData] = useState(domyslnaData);
  const [kwota, setKwota] = useState('');
  const [opis, setOpis] = useState('');
  const [bledy, setBledy] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const wejscie = () => ({ data, kwota, opis: opis.trim() === '' ? null : opis });
  const blad = (pole: string) =>
    bledy[pole] ? (
      <p id={`spis-blad-${pole}`} role="alert" className="text-destructive text-xs">
        {bledy[pole]}
      </p>
    ) : null;

  const zapisz = () => {
    const parsed = spisSchema.safeParse(wejscie());
    if (!parsed.success) {
      const nowe: Record<string, string> = {};
      for (const issue of parsed.error.issues) nowe[String(issue.path[0] ?? 'formularz')] ??= issue.message;
      setBledy(nowe);
      return;
    }
    setBledy({});
    startTransition(async () => {
      const wynik = await dodajSpisAction(wejscie());
      if (wynik.success) {
        toast.success('Spis z natury zapisany');
        setKwota('');
        setOpis('');
      } else {
        setBledy({ [wynik.pole ?? 'formularz']: wynik.error });
        toast.error(wynik.error);
      }
    });
  };

  return (
    <FieldGroup>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="spis-data">Data spisu</FieldLabel>
          <Input id="spis-data" type="date" value={data} max={dzis} disabled={pending} onChange={(e) => setData(e.target.value)} />
          {blad('data')}
        </Field>
        <Field>
          <FieldLabel htmlFor="spis-kwota">Wartość (zł)</FieldLabel>
          <Input id="spis-kwota" inputMode="decimal" value={kwota} disabled={pending} onChange={(e) => setKwota(e.target.value)} />
          {blad('kwota')}
        </Field>
        <Field>
          <FieldLabel htmlFor="spis-opis">Uwagi</FieldLabel>
          <Input id="spis-opis" value={opis} maxLength={256} disabled={pending} onChange={(e) => setOpis(e.target.value)} />
          {blad('opis')}
        </Field>
      </div>
      {blad('formularz')}
      <div className="flex justify-end">
        <Button type="button" onClick={zapisz} disabled={pending}>
          {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Zapisz spis
        </Button>
      </div>
    </FieldGroup>
  );
}

export function UsunSpisPrzycisk({ id, data }: { id: string; data: string }) {
  const [pending, startTransition] = useTransition();
  const usun = () =>
    startTransition(async () => {
      const wynik = await usunSpisAction(id);
      if (wynik.success) toast.success('Spis z natury usunięty');
      else toast.error(wynik.error);
    });
  return (
    <Button type="button" variant="ghost" size="sm" onClick={usun} disabled={pending} aria-label={`Usuń spis z ${data}`}>
      {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
      Usuń
    </Button>
  );
}
