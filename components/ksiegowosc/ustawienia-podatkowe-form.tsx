'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { zapiszProfilPodatkowyAction } from '@/app/actions/ksiegowosc-profil';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  ETAPY_ZUS,
  FORMY,
  NAZWY_ETAPOW_ZUS,
  NAZWY_FORM,
  OPISY_ETAPOW_ZUS,
  PROFIL_OD_MIN,
  profilSchema,
  STAWKI_RYCZALTU,
  STAWKI_RYCZALTU_ZRODLO,
  type EtapZus,
  type Forma,
  type WersjaProfilu,
} from '@/lib/ksiegowosc/profil';

/**
 * Kreator ustawień podatkowych (plan księgowości JDG, K2, sekcja 8).
 *
 * Wygląd: wiersze Finory jak w ustawieniach firmy (`Field` z etykietą i opisem
 * po lewej, pole po prawej). Walidacja w przeglądarce tym samym schematem co
 * w akcji. Teksty bez porad (D8): program nie dobiera stawki ani formy.
 */
export function UstawieniaPodatkoweForm({
  poczatkowa,
  domyslnyOd,
  canEdit,
  statusVat,
}: {
  poczatkowa: WersjaProfilu | null;
  domyslnyOd: string;
  /** Właściciel i administrator; pozostali widzą ustawienia bez zmiany. */
  canEdit: boolean;
  /** Status VAT z ustawień firmy (D3). */
  statusVat: string;
}) {
  const [validFrom, setValidFrom] = useState(domyslnyOd);
  const [forma, setForma] = useState<Forma | ''>(poczatkowa?.forma ?? '');
  const [stawka, setStawka] = useState<string>(poczatkowa?.stawkaDomyslna ? String(poczatkowa.stawkaDomyslna) : '');
  const [zusEtap, setZusEtap] = useState<EtapZus | ''>(poczatkowa?.zusEtap ?? '');
  const [zusOd, setZusOd] = useState(poczatkowa?.zusOd ?? '');
  const [chorobowe, setChorobowe] = useState(poczatkowa?.chorobowe ?? false);
  const [najem, setNajem] = useState(poczatkowa?.najem ?? false);
  const [nrsZus, setNrsZus] = useState(poczatkowa?.nrsZus ?? '');
  const [bledy, setBledy] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const zSkladkamiSpolecznymi = zusEtap === 'preferencyjny' || zusEtap === 'pelny';

  // Komunikat znika, gdy klient zmieni pole, którego dotyczy, albo pole, od którego ono zależy.
  const wyczysc = (...pola: string[]) =>
    setBledy((b) => {
      if (!pola.some((p) => p in b)) return b;
      const reszta = { ...b };
      for (const p of pola) delete reszta[p];
      return reszta;
    });

  const wejscie = () => ({
    validFrom,
    forma: forma as Forma,
    stawkaDomyslna: forma === 'ryczalt' && stawka !== '' ? Number(stawka) : null,
    zusEtap: zusEtap as EtapZus,
    zusOd: zusOd === '' ? null : zusOd,
    chorobowe: zSkladkamiSpolecznymi ? chorobowe : false,
    najem: forma === 'ryczalt' ? najem : false,
    nrsZus: nrsZus.trim() === '' ? null : nrsZus,
  });

  const zapisz = () => {
    const parsed = profilSchema.safeParse(wejscie());
    if (!parsed.success) {
      const nowe: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const pole = String(issue.path[0] ?? 'formularz');
        nowe[pole] ??= issue.message;
      }
      setBledy(nowe);
      return;
    }
    setBledy({});
    startTransition(async () => {
      const wynik = await zapiszProfilPodatkowyAction(wejscie());
      if (wynik.success) {
        toast.success('Ustawienia podatkowe zapisane');
      } else {
        if (wynik.pole) setBledy({ [wynik.pole]: wynik.error });
        toast.error(wynik.error);
      }
    });
  };

  // Komunikat stoi pod opisem pola, w szerokiej kolumnie: odmowa z wyjściem
  // bywa długa, a kolumna kontrolki ma szerokość pola daty.
  const blad = (pole: string) =>
    bledy[pole] ? (
      <p id={`blad-${pole}`} role="alert" className="text-destructive text-xs">
        {bledy[pole]}
      </p>
    ) : null;
  const opisBledu = (pole: string) => (bledy[pole] ? `blad-${pole}` : undefined);

  return (
    <FieldGroup>
      <div>
        <FieldLabel>Ustawienia podatkowe</FieldLabel>
        <FieldDescription>
          Z nich liczymy ryczałt albo zaliczkę na PIT, składki ZUS i składkę zdrowotną. Zapis z inną datą tworzy
          nową wersję od tego dnia, a z tą samą datą poprawia obecną.
        </FieldDescription>
        {canEdit ? null : <FieldDescription>Zmienić je może właściciel albo administrator firmy.</FieldDescription>}
      </div>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="profil-od">Obowiązują od</FieldLabel>
          <FieldDescription>Formę opodatkowania zmienia się tylko od 1 stycznia.</FieldDescription>
          {blad('validFrom')}
        </FieldContent>
        <div className="flex w-full flex-col gap-2 sm:w-64">
          <Input
            id="profil-od"
            type="date"
            min={PROFIL_OD_MIN}
            value={validFrom}
            disabled={!canEdit || pending}
            onChange={(e) => {
              setValidFrom(e.target.value);
              wyczysc('validFrom');
            }}
            aria-invalid={bledy.validFrom ? true : undefined}
            aria-describedby={opisBledu('validFrom')}
          />
        </div>
      </Field>

      <Separator />

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel id="profil-forma">Forma opodatkowania</FieldLabel>
          {blad('forma')}
        </FieldContent>
        <div className="flex w-full flex-col gap-2 sm:w-64">
          <RadioGroup
            aria-labelledby="profil-forma"
            aria-describedby={opisBledu('forma')}
            value={forma}
            disabled={!canEdit || pending}
            onValueChange={(v) => {
              setForma(v as Forma);
              wyczysc('forma', 'stawkaDomyslna');
            }}
          >
            {FORMY.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <RadioGroupItem value={f} />
                {NAZWY_FORM[f]}
              </label>
            ))}
          </RadioGroup>
        </div>
      </Field>

      {forma === 'ryczalt' ? (
        <Field orientation="responsive">
          <FieldContent>
            <FieldLabel id="profil-stawka">Stawka ryczałtu</FieldLabel>
            <FieldDescription>
              Stawka zależy od rodzaju przychodu, zwykle od symbolu PKWiU usługi. FaktWay jej nie dobiera. Pełny opis
              grup:{' '}
              <Link href={STAWKI_RYCZALTU_ZRODLO} target="_blank" rel="noopener noreferrer" className="underline">
                podatki.gov.pl
              </Link>
              .
            </FieldDescription>
            {blad('stawkaDomyslna')}
          </FieldContent>
          <div className="flex w-full flex-col gap-2 sm:w-96">
            <RadioGroup
              aria-labelledby="profil-stawka"
              aria-describedby={opisBledu('stawkaDomyslna')}
              value={stawka}
              disabled={!canEdit || pending}
              onValueChange={(v) => {
                setStawka(String(v));
                wyczysc('stawkaDomyslna');
              }}
            >
              {STAWKI_RYCZALTU.map((s) => (
                <label key={s.pb} className="flex items-start gap-2 text-sm">
                  <RadioGroupItem value={String(s.pb)} className="mt-0.5" />
                  <span>
                    <span className="font-medium">{s.etykieta}</span>
                    <span className="text-muted-foreground block text-xs">{s.opis}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>
        </Field>
      ) : null}

      {forma === 'ryczalt' ? (
        <Field orientation="horizontal">
          <Switch
            id="profil-najem"
            checked={najem}
            disabled={!canEdit || pending}
            onCheckedChange={(v) => setNajem(Boolean(v))}
          />
          <FieldContent>
            <FieldLabel htmlFor="profil-najem">Przychody ze stawką 8,5 % to najem, dzierżawa albo zakwaterowanie</FieldLabel>
            <FieldDescription>
              Od nadwyżki takich przychodów ponad 100 000 zł w roku stawka wynosi 12,5 %. Ewidencja liczy to sama.
            </FieldDescription>
          </FieldContent>
        </Field>
      ) : null}

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>Status VAT</FieldLabel>
          <FieldDescription>
            Zmienia się w{' '}
            <Link href="/settings" className="underline">
              ustawieniach firmy
            </Link>
            .
          </FieldDescription>
        </FieldContent>
        <span className="text-sm sm:w-64">{statusVat}</span>
      </Field>

      <Separator />

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel id="profil-zus">Składki ZUS</FieldLabel>
          {blad('zusEtap')}
        </FieldContent>
        <div className="flex w-full flex-col gap-2 sm:w-96">
          <RadioGroup
            aria-labelledby="profil-zus"
            aria-describedby={opisBledu('zusEtap')}
            value={zusEtap}
            disabled={!canEdit || pending}
            onValueChange={(v) => {
              setZusEtap(v as EtapZus);
              wyczysc('zusEtap', 'zusOd');
            }}
          >
            {ETAPY_ZUS.map((e) => (
              <label key={e} className="flex items-start gap-2 text-sm">
                <RadioGroupItem value={e} className="mt-0.5" />
                <span>
                  <span className="font-medium">{NAZWY_ETAPOW_ZUS[e]}</span>
                  <span className="text-muted-foreground block text-xs">{OPISY_ETAPOW_ZUS[e]}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </div>
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="profil-zus-od">Od kiedy ten rodzaj składek</FieldLabel>
          <FieldDescription>Przy uldze na start i składkach preferencyjnych ta data jest potrzebna.</FieldDescription>
          {blad('zusOd')}
        </FieldContent>
        <div className="flex w-full flex-col gap-2 sm:w-64">
          <Input
            id="profil-zus-od"
            type="date"
            value={zusOd}
            disabled={!canEdit || pending}
            onChange={(e) => {
              setZusOd(e.target.value);
              wyczysc('zusOd');
            }}
            aria-invalid={bledy.zusOd ? true : undefined}
            aria-describedby={opisBledu('zusOd')}
          />
        </div>
      </Field>

      {zSkladkamiSpolecznymi ? (
        <Field orientation="horizontal">
          <Switch
            id="profil-chorobowe"
            checked={chorobowe}
            disabled={!canEdit || pending}
            onCheckedChange={(v) => setChorobowe(Boolean(v))}
          />
          <FieldContent>
            <FieldLabel htmlFor="profil-chorobowe">Dobrowolne ubezpieczenie chorobowe</FieldLabel>
          </FieldContent>
        </Field>
      ) : null}

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="profil-nrs">Rachunek składkowy ZUS</FieldLabel>
          <FieldDescription>Nieobowiązkowo. Numer jest w PUE ZUS; pokażemy go przy danych do przelewu.</FieldDescription>
          {blad('nrsZus')}
        </FieldContent>
        <div className="flex w-full flex-col gap-2 sm:w-64">
          <Input
            id="profil-nrs"
            inputMode="numeric"
            autoComplete="off"
            value={nrsZus}
            disabled={!canEdit || pending}
            onChange={(e) => {
              setNrsZus(e.target.value);
              wyczysc('nrsZus');
            }}
            aria-invalid={bledy.nrsZus ? true : undefined}
            aria-describedby={opisBledu('nrsZus')}
          />
        </div>
      </Field>

      {canEdit ? (
        <div className="flex justify-end">
          <Button type="button" onClick={zapisz} disabled={pending}>
            {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
            Zapisz
          </Button>
        </div>
      ) : null}
    </FieldGroup>
  );
}
