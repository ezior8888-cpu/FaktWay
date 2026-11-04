import Link from 'next/link';
import { ArrowRight, Check, ShieldCheck } from 'lucide-react';

/**
 * Hero głównej strony — tekst + mockup faktury renderowany kodem (BUG-001).
 *
 * Wcześniej był tu zdjęciowy JPG (`/marketing/hero.jpg`) w twardej ramce
 * `border + glow` — wyglądał nieostro i „doklejony". Zamiast tego pokazujemy
 * realistyczny podgląd faktury FaktWay: ostry na każdym DPI (wektory + CSS),
 * związany z produktem (faktura + status KSeF) i spójny z ciemnym motywem.
 */
export function LandingHero() {
  return (
    <section>
      <div className="mx-auto grid max-w-7xl items-center gap-12 px-6 py-14 lg:grid-cols-2 lg:gap-16 lg:px-8 lg:py-20">
        <div className="max-w-xl">
          <p className="marketing-hero-eyebrow">KSeF 2.0 · faktury i KPiR</p>
          <h1 className="marketing-hero-title mt-5 text-4xl sm:text-5xl lg:text-[3.25rem]">
            Wystawiaj faktury w&nbsp;KSeF jednym kliknięciem
          </h1>
          <p className="marketing-hero-body mt-6 max-w-lg">
            Zdjęcie paragonu trafia do&nbsp;KPiR. Wkurzacz Dłużników pilnuje płatności.
            Walidacja FA(3) przed wysyłką — bez stresu z&nbsp;urzędem skarbowym.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Link href="/register" className="marketing-cta-primary">
              Wypróbuj za darmo
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link
              href="/kalkulator-oszczednosci"
              className="text-[15px] font-semibold text-[var(--marketing-muted)] underline decoration-white/20 underline-offset-4 transition-colors hover:text-[var(--marketing-accent)] hover:decoration-[var(--marketing-accent)]"
            >
              Sprawdź oszczędności
            </Link>
          </div>
          <p className="mt-5 text-xs font-medium text-[color-mix(in_srgb,var(--marketing-muted)_75%,transparent)]">
            30 dni bez karty · migracja z Fakturowni / inFakt · dane w UE (Frankfurt)
          </p>
        </div>

        <div className="relative mx-auto w-full max-w-xl lg:max-w-none">
          {/* Miękka poświata zamiast twardej ramki — wkomponowana w tło, nie „doklejona". */}
          <div
            className="pointer-events-none absolute -inset-10 -z-10 rounded-[3rem] bg-[radial-gradient(60%_60%_at_70%_30%,color-mix(in_srgb,var(--marketing-accent)_18%,transparent),transparent_70%)] blur-2xl"
            aria-hidden
          />
          <InvoiceMockup />
        </div>
      </div>
    </section>
  );
}

/** Podgląd faktury — czysto wektorowy/CSS, ostry na każdym ekranie. */
function InvoiceMockup() {
  return (
    <div className="relative rounded-3xl border border-white/10 bg-[#16171f] p-3 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.7)]">
      {/* Pasek okna */}
      <div className="flex items-center gap-1.5 px-3 pb-3 pt-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="ml-3 text-[11px] font-medium text-[var(--marketing-muted)]">
          faktway.pl · Faktura
        </span>
      </div>

      {/* „Kartka" faktury */}
      <div className="rounded-2xl border border-white/8 bg-[#1d1e27] p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--marketing-muted)]">
              Faktura VAT
            </p>
            <p className="mt-1 font-mono text-lg font-semibold text-[var(--marketing-text)]">
              FV&nbsp;07/2026
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--marketing-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--marketing-accent)_14%,transparent)] px-3 py-1 text-[11px] font-semibold text-[var(--marketing-accent)]">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            Wysłano do KSeF
          </span>
        </div>

        {/* Sprzedawca / Nabywca */}
        <div className="mt-6 grid grid-cols-2 gap-4 text-[12px] leading-relaxed">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-[var(--marketing-muted)]">
              Sprzedawca
            </p>
            <p className="mt-1 font-medium text-[var(--marketing-text)]">Twoja Firma</p>
            <p className="text-[var(--marketing-muted)]">NIP 123-456-78-90</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-[var(--marketing-muted)]">
              Nabywca
            </p>
            <p className="mt-1 font-medium text-[var(--marketing-text)]">Kontrahent Sp. z o.o.</p>
            <p className="text-[var(--marketing-muted)]">NIP 987-654-32-10</p>
          </div>
        </div>

        {/* Pozycje */}
        <div className="mt-6 overflow-hidden rounded-xl border border-white/8">
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 bg-white/[0.03] px-4 py-2.5 text-[10px] uppercase tracking-wider text-[var(--marketing-muted)]">
            <span>Nazwa</span>
            <span className="text-right">VAT</span>
            <span className="text-right">Brutto</span>
          </div>
          {[
            { name: 'Usługa doradcza', vat: '23%', gross: '6 150,00' },
            { name: 'Wdrożenie KSeF', vat: '23%', gross: '2 460,00' },
          ].map((row, i) => (
            <div
              key={row.name}
              className={`grid grid-cols-[1fr_auto_auto] gap-3 px-4 py-3 text-[12px] ${
                i === 0 ? 'border-b border-white/6' : ''
              }`}
            >
              <span className="text-[var(--marketing-text)]">{row.name}</span>
              <span className="text-right text-[var(--marketing-muted)]">{row.vat}</span>
              <span className="text-right font-medium text-[var(--marketing-text)]">
                {row.gross}
              </span>
            </div>
          ))}
        </div>

        {/* Suma */}
        <div className="mt-5 flex items-end justify-between">
          <div className="space-y-1.5">
            {[
              'Walidacja FA(3) — OK',
              'UPO pobrane automatycznie',
            ].map((t) => (
              <p
                key={t}
                className="flex items-center gap-1.5 text-[11px] text-[var(--marketing-muted)]"
              >
                <Check className="h-3.5 w-3.5 text-[var(--marketing-accent)]" aria-hidden />
                {t}
              </p>
            ))}
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-[var(--marketing-muted)]">
              Do zapłaty
            </p>
            <p className="font-mono text-2xl font-semibold text-[var(--marketing-text)]">
              8&nbsp;610,00 zł
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
