import type { WynikLimituKasy } from '@/lib/kasa-fiskalna/limit';

/** Rozporządzenie MF z 17.12.2024 (Dz.U. 2024 poz. 1902); lista czynności bez zwolnienia: § 4. */
export const KASA_ZRODLO_URL = 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20240001902';

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
 * Licznik sprzedaży dla osób prywatnych z limitem zwolnienia z kasy
 * (krok 9.3, R2). Tylko fakty z rozporządzenia, bez porad.
 */
export function LimitKasyKarta({ wynik }: { wynik: WynikLimituKasy }) {
  const percent = Math.min(100, Math.round(wynik.share * 100));
  const [rok, miesiac] = (wynik.exceededMonth ?? '').split('-');
  return (
    <section aria-label="Limit zwolnienia z kasy rejestrującej" className="space-y-3 rounded-xl border bg-card p-4 sm:p-6">
      <h2 className="text-base font-semibold">Kasa rejestrująca: limit sprzedaży dla osób prywatnych</h2>
      <p className="text-sm">
        Sprzedaż dla osób prywatnych w {wynik.year} r.: {pln(wynik.sum)} z {pln(wynik.limit)}.
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
      {wynik.state === 'near' && <p className="text-sm">Sprzedaż jest blisko limitu ({percent} %).</p>}
      {wynik.state === 'exceeded' && (
        <p className="text-sm">
          Limit został przekroczony w {MIESIACE_MIEJSCOWNIK[Number(miesiac) - 1]} {rok}.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Zwolnienie z kasy traci moc po upływie dwóch miesięcy następujących po miesiącu, w którym sprzedaż dla osób
        prywatnych przekroczyła limit (rozporządzenie MF, § 5 ust. 1). Kwoty brutto z faktur sprzedaży przyjętych przez KSeF.
      </p>
      {wynik.proportional && (
        <p className="text-sm text-muted-foreground">
          W roku rozpoczęcia działalności limit jest proporcjonalny do okresu jej wykonywania (§ 3 ust. 1 pkt 2).
        </p>
      )}
      {wynik.startUnknown && (
        <p className="text-sm text-muted-foreground">
          Brak daty rozpoczęcia działalności w ustawieniach, więc liczony jest pełny limit.
        </p>
      )}
      <p className="text-sm">
        <a href={KASA_ZRODLO_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
          Czynności, które wymagają kasy od pierwszej sprzedaży (§ 4 rozporządzenia)
        </a>
      </p>
    </section>
  );
}
