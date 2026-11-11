import type { ReactNode } from 'react';
import { RiBriefcase4Line } from '@remixicon/react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  ETYKIETY_ROL,
  czytajMoichKlientow,
  opisTerminu,
  type FirmaKlienta,
  type KlientRpc,
  type PoTerminie,
  type StatusKsef,
  type TerminFirmy,
} from '@/lib/dashboard/moi-klienci';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlInt, formatPlMoney } from '@/lib/format/pl';
import { countLabel, type PluralForms } from '@/lib/i18n/plural';
import { getPageContext } from '@/lib/supabase/page-context';

import { OtworzFirme } from './_components/otworz-firme';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Moi klienci' };

const FAKTURY: PluralForms = ['faktura', 'faktury', 'faktur'];
// Kolory plakietki KSeF jak w Ustawieniach, KSeF.
const BADGE_OK = 'bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400';
const BADGE_WARN = 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400';

/** Certyfikat wgrywa i potwierdza tylko właściciel firmy (kreator KSeF), więc wskazówka mówi, kto to robi. */
const KSEF: Readonly<Record<StatusKsef, { etykieta: string; klasa: string; wskazowka?: string }>> = {
  polaczono: { etykieta: 'Połączono', klasa: BADGE_OK },
  certyfikat_wygasl: {
    etykieta: 'Certyfikat wygasł',
    klasa: BADGE_WARN,
    wskazowka: 'Nowy certyfikat wgrywa właściciel firmy w Ustawieniach, w zakładce KSeF.',
  },
  wymaga_potwierdzenia: {
    etykieta: 'Wymaga potwierdzenia',
    klasa: BADGE_WARN,
    wskazowka: 'Certyfikat potwierdza właściciel firmy w Ustawieniach, w zakładce KSeF.',
  },
  brak: {
    etykieta: 'Brak certyfikatu',
    klasa: BADGE_WARN,
    wskazowka: 'Certyfikat wgrywa właściciel firmy w Ustawieniach, w zakładce KSeF.',
  },
};

function poTerminie(p: PoTerminie): { wartosc: string; opis?: string } {
  if (p.stan === 'srodowisko') {
    return {
      wartosc: 'Bez sumy',
      opis: 'Przyjęte faktury tej firmy wymagają uzgodnienia środowiska KSeF. Napisz do nas przez Pomoc.',
    };
  }
  const opis = p.walutaObca > 0 ? `Poza sumą: ${countLabel(p.walutaObca, FAKTURY)} w walucie obcej` : undefined;
  if (p.liczba === 0) return { wartosc: 'Brak', opis };
  return { wartosc: `${countLabel(p.liczba, FAKTURY)}, ${formatPlMoney(p.sumaGr / 100)} zł`, opis };
}

function termin(t: TerminFirmy): string {
  if (t.stan === 'ok') return `${formatIsoDatePl(t.data)}, ${opisTerminu(t.rodzaje)}`;
  if (t.stan === 'nieznany') return 'Nie udało się sprawdzić terminów. Odśwież stronę za chwilę.';
  return 'Kalendarz nie zna jeszcze terminów na ten dzień.';
}

function Pozycja({ etykieta, opis, children }: { etykieta: string; opis?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{etykieta}</dt>
      <dd className="text-sm font-medium">{children}</dd>
      {opis ? <dd className="text-muted-foreground text-xs">{opis}</dd> : null}
    </div>
  );
}

function KartaFirmy({ firma }: { firma: FirmaKlienta }) {
  const zalegle = poTerminie(firma.poTerminie);
  const ksef = KSEF[firma.ksef];
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="min-w-0 truncate text-base" title={firma.nazwa}>
          {firma.nazwa}
        </CardTitle>
        <CardDescription>
          NIP <span className="font-mono">{firma.nip}</span> · {ETYKIETY_ROL[firma.rola]}
        </CardDescription>
        {firma.aktywna ? (
          <CardAction>
            <Badge variant="secondary">Otwarta</Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex-1">
        <dl className="grid gap-3">
          <Pozycja etykieta="Koszty do opisania">{formatPlInt(firma.kosztyDoOpisania)}</Pozycja>
          <Pozycja etykieta="Po terminie" opis={zalegle.opis}>
            {zalegle.wartosc}
          </Pozycja>
          {/* Termin tylko przy włączonym module księgowości (wyłącznik `ksiegowosc`, D2). */}
          {firma.termin ? (
            <Pozycja
              etykieta="Najbliższy termin"
              opis={firma.termin.stan === 'ok' ? 'Data z kalendarza terminów, bez sprawdzania, czy już zapłacone.' : undefined}
            >
              {termin(firma.termin)}
            </Pozycja>
          ) : null}
          <Pozycja etykieta="KSeF" opis={ksef.wskazowka}>
            <Badge className={ksef.klasa}>{ksef.etykieta}</Badge>
          </Pozycja>
        </dl>
      </CardContent>
      <CardFooter>
        <OtworzFirme organizationId={firma.organizationId} nazwa={firma.nazwa} />
      </CardFooter>
    </Card>
  );
}

/**
 * „Moi klienci” (krok 6.2 planu kompletnej aplikacji, część 2): firmy, do
 * których zalogowany ma dostęp, z najważniejszymi sprawami każdej z nich.
 * Dane z funkcji bazy `my_organizations_summary` (00185) przez
 * `czytajMoichKlientow`; klient z sesji, więc baza bierze firmy z `auth.uid()`.
 *
 * Ekran pokazuje każdemu tylko jego firmy, a link w menu dostaje księgowa
 * w co najmniej dwóch firmach (`pokazMoichKlientow`). Nowy ekran z kart
 * Finory (D1 dotyczy istniejących ekranów); w telefonie jedna kolumna.
 */
export default async function MoiKlienciPage() {
  const { supabase, tenantId } = await getPageContext();
  const wynik = await czytajMoichKlientow(supabase as unknown as KlientRpc, { aktywnaFirma: tenantId });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Moi klienci</h1>
        <p className="text-muted-foreground text-sm">
          Firmy, do których masz dostęp, i najważniejsze sprawy każdej z nich. „Otwórz” przełącza FaktWay na wybraną
          firmę.
        </p>
      </div>

      {!wynik.ok ? (
        <Alert>
          <AlertDescription>Nie udało się wczytać firm. Odśwież stronę za chwilę.</AlertDescription>
        </Alert>
      ) : wynik.firmy.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RiBriefcase4Line aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Nie masz jeszcze firm klientów</EmptyTitle>
            <EmptyDescription>
              Firma pojawi się tutaj, gdy klient zaprosi Cię do niej w FaktWay. Zaproszenie przychodzi mailem.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul aria-label="Firmy" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {wynik.firmy.map((firma) => (
            <li key={firma.organizationId} className="min-w-0">
              <KartaFirmy firma={firma} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
