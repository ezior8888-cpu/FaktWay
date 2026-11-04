import Link from 'next/link';

/**
 * WŁAŚCICIEL: Bartosz — stan pusty ekranu agenta (rama, nie treść propozycji).
 * Masło: jeśli uznasz, że to należy do `components/flo/`, przenieś i powiedz
 * w dzienniku — nie będę tego pliku pilnował.
 *
 * Pokazywane, gdy klient nie ma ANI JEDNEJ sprawy od agenta. Zamiast pustego
 * pola tłumaczy, czym FLO jest i czego pilnuje, żeby cisza nie wyglądała na
 * zepsuty ekran.
 *
 * ⚠️ CZĘSTOTLIWOŚCI SĄ PRAWDZIWE, nie ozdobne. Puls agenta (`cron.flo-tick`)
 * chodzi RAZ NA DOBĘ, o 7:30 czasu polskiego — dlatego nie ma tu „co 15 minut”
 * z sierpniowej makiety. Obiecanie częstotliwości, której silnik nie dowozi,
 * jest kłamstwem, które klient wyłapie pierwszego dnia.
 *
 * ⚠️ NIE MA TU „TRYB 3” ANI „Pracuje sam · informuje”. Oba są na makiecie
 * i oba zostały odrzucone przez właściciela produktu (część II.3 planu).
 */
const PILNUJE = [
  {
    icon: 'inbox',
    title: 'Skrzynka KSeF',
    body: 'Nowe koszty i faktury zakupu',
    when: 'codziennie rano',
  },
  {
    icon: 'event_available',
    title: 'Terminy płatności',
    body: 'Zgłoszę dzień po terminie',
    when: 'codziennie',
  },
  {
    icon: 'autorenew',
    title: 'Faktury cykliczne',
    body: 'Gdy kontrahent wypadnie z rytmu',
    when: 'raz w miesiącu',
  },
] as const;

export function FloWelcome() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center-safe overflow-y-auto px-6 py-8 text-center">
      <span
        aria-hidden
        className="flex size-[72px] shrink-0 items-center justify-center rounded-[22px] bg-[var(--ff-accent)] text-[32px] font-semibold text-[var(--ff-on-primary)]"
      >
        F
      </span>

      <h2 className="mt-6 text-[24px] font-bold tracking-[-0.02em] text-[var(--ff-text-strong)]">
        Cześć, jestem Flo — Twój asystent finansowy
      </h2>
      <p className="mt-3 max-w-[34rem] text-[14.5px] leading-[1.6] text-[var(--ff-text-muted)]">
        Pracuję w tle: przeglądam dokumenty firmy i przygotowuję gotowe rzeczy
        do zatwierdzenia. Nie musisz tu zaglądać — odezwę się, kiedy będzie
        sprawa. Cisza znaczy, że wszystko gra.
      </p>

      <section className="mt-8 w-full shrink-0 max-w-[34rem] overflow-hidden rounded-2xl border border-[var(--ff-border)] bg-[var(--ff-surface-inset)] text-left">
        <h3 className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ff-text-muted)]">
          Czego pilnuję
        </h3>
        <ul>
          {PILNUJE.map((p) => (
            <li
              key={p.title}
              className="flex items-center gap-3 border-t border-[var(--ff-border)] bg-[var(--ff-surface)] px-5 py-3.5"
            >
              <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-[var(--ff-accent-tint)] text-[var(--ff-accent)]"
              >
                <span className="material-symbols-outlined text-[19px]">
                  {p.icon}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-[var(--ff-text-strong)]">
                  {p.title}
                </span>
                <span className="block truncate text-[12px] text-[var(--ff-text-dim)]">
                  {p.body}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[11.5px] text-[var(--ff-text-dim)]">
                {p.when}
              </span>
            </li>
          ))}
        </ul>
        <p className="border-t border-[var(--ff-border)] bg-[var(--ff-surface)] px-5 py-3 text-[12.5px] text-[var(--ff-text-muted)]">
          Chcesz zmienić zakres?{' '}
          <Link
            href="/settings/flo"
            className="font-medium text-[var(--ff-accent)] underline-offset-4 hover:underline"
          >
            Ustawienia agenta
          </Link>
        </p>
      </section>
    </div>
  );
}
