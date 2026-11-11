import type { WynikProguOss } from '@/lib/oss/prog';

/** Ustawa o VAT (Dz.U. 2004 nr 54 poz. 535): art. 22a ust. 1 pkt 3, art. 28k ust. 2 pkt 3. */
export const OSS_ZRODLO_URL = 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20040540535';

const MIESIACE_MIEJSCOWNIK = [
  'styczniu', 'lutym', 'marcu', 'kwietniu', 'maju', 'czerwcu',
  'lipcu', 'sierpniu', 'wrześniu', 'październiku', 'listopadzie', 'grudniu',
];

function pln(amount: number): string {
  const text = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  return `${text.replace(/[  ]/g, ' ')} zł`;
}

const STAN_KLASA = {
  below: 'bg-primary',
  near: 'bg-amber-500',
  exceeded: 'bg-destructive',
} as const;

/**
 * Licznik sprzedaży dla konsumentów z innych państw UE z progiem 10 000 euro
 * (42 000 zł), krok 9.4, R2. Tylko fakty z ustawy, bez porad.
 */
export function ProgOssKarta({ wynik }: { wynik: WynikProguOss }) {
  const percent = Math.min(100, Math.round(wynik.share * 100));
  const [rok, miesiac] = (wynik.exceededMonth ?? '').split('-');
  const { withoutRate } = wynik;
  return (
    <section aria-label="Próg sprzedaży do konsumentów z UE" className="space-y-3 rounded-xl border bg-card p-4 sm:p-6">
      <h2 className="text-base font-semibold">Sprzedaż dla konsumentów z innych państw UE: próg 10 000 euro</h2>
      <p className="text-sm">
        Sprzedaż netto w {wynik.year} r.: {pln(wynik.sum)} z {pln(wynik.limit)} (10 000 euro w złotych).
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        data-state={wynik.state}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full ${STAN_KLASA[wynik.state]}`} style={{ width: `${percent}%` }} />
      </div>
      {wynik.state === 'near' && <p className="text-sm">Sprzedaż jest blisko progu ({percent} %).</p>}
      {wynik.state === 'exceeded' && wynik.exceededMonth && (
        <p className="text-sm">
          Próg został przekroczony w {MIESIACE_MIEJSCOWNIK[Number(miesiac) - 1]} {rok}.
        </p>
      )}
      {wynik.previousYearExceeded && (
        <p className="text-sm">
          W {wynik.year - 1} r. sprzedaż wyniosła {pln(wynik.sumPrevYear)}, czyli przekroczyła próg. Przepis bierze pod
          uwagę także rok poprzedni.
        </p>
      )}
      {withoutRate.count > 0 && (
        <p className="text-sm">
          {withoutRate.count} {withoutRate.count === 1 ? 'faktura' : 'faktur'} dla konsumentów z UE
          {withoutRate.currencies.length > 0 ? ` w walucie ${withoutRate.currencies.join(', ')}` : ' bez waluty'} jest bez kursu
          do złotych, więc nie wchodzi do sumy. Rzeczywista sprzedaż może być wyższa.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Zgodnie z ustawą o VAT (art. 22a ust. 1 pkt 3 i art. 28k ust. 2 pkt 3) liczy się wartość bez podatku dostaw
        towarów wysyłanych do innego państwa UE i usług telekomunikacyjnych, nadawczych i elektronicznych dla osób
        niebędących podatnikami. Po przekroczeniu progu w roku bieżącym lub poprzednim te sprzedaże opodatkowuje się
        w państwie nabywcy. Licznik liczy wszystkie faktury dla konsumentów z UE (nabywca bez NIP i numeru VAT-UE),
        bez rozróżnienia rodzaju sprzedaży, według daty wystawienia. To informacja, nie porada podatkowa: szczegóły
        i zastosowanie przepisu ustala księgowa.
      </p>
      <p className="text-sm">
        <a href={OSS_ZRODLO_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
          Ustawa o VAT w ISAP (art. 22a i art. 28k)
        </a>
      </p>
    </section>
  );
}
