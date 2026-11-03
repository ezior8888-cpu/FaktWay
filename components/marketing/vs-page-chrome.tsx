import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { PRICE_PER_MONTH, TRIAL_DAYS } from '@/lib/billing/pricing';

/**
 * Wspólny układ podstron /vs/* — ciemny motyw marketingu (BUG-002 fix).
 * Wcześniej używał jasnych kolorów (text-zinc-600, bg-emerald-50) na CIEMNYM
 * tle `.marketing-landing` → nieczytelne. Teraz tokeny --marketing-*.
 */

interface VsHeroProps {
  competitorName: string;
  eyebrow?: string;
  subtitle: string;
}

export function VsHero({ competitorName, eyebrow, subtitle }: VsHeroProps) {
  return (
    <header className="relative bg-transparent pt-12 pb-16 lg:pt-20 lg:pb-24">
      <div className="mx-auto max-w-5xl px-6 text-center lg:px-8">
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--marketing-accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--marketing-accent)_12%,transparent)] px-4 py-1.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3 text-[var(--marketing-accent)]">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <span className="marketing-section-label">{eyebrow ?? 'Analiza rynkowa 2026'}</span>
        </div>

        <h1 className="marketing-hero-title text-4xl md:text-6xl lg:text-7xl">
          FaktWay vs{' '}
          <span className="marketing-gradient-emerald">{competitorName}</span>
        </h1>
        <p className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-[var(--marketing-muted)] md:text-xl">
          {subtitle}
        </p>
      </div>
    </header>
  );
}

interface VsTldrProps {
  children: React.ReactNode;
}

export function VsTldr({ children }: VsTldrProps) {
  return (
    <div className="mx-auto max-w-4xl px-6 lg:px-8">
      <div className="marketing-glass-card relative rounded-2xl p-8">
        <div className="mb-3 inline-flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--marketing-accent)]" />
          <span className="marketing-section-label">TL;DR</span>
        </div>
        <p className="text-base leading-relaxed text-[var(--marketing-text)] md:text-lg">
          {children}
        </p>
      </div>
    </div>
  );
}

export function VsSectionHeader({
  num,
  eyebrow,
  title,
}: {
  num: string;
  eyebrow?: string;
  title: string;
}) {
  return (
    <div className="mb-8 mt-20">
      <div className="mb-3 flex items-baseline gap-3">
        <span className="marketing-section-label text-[var(--marketing-accent)]">{num}.</span>
        <span className="marketing-section-label">{eyebrow ?? title}</span>
      </div>
      <h2 className="marketing-hero-title max-w-3xl text-3xl md:text-4xl">
        {title}
      </h2>
    </div>
  );
}

interface VsChooseColumnsProps {
  competitorName: string;
  whenChooseCompetitor: string[];
  whenChooseUs: string[];
}

export function VsChooseColumns({
  competitorName,
  whenChooseCompetitor,
  whenChooseUs,
}: VsChooseColumnsProps) {
  return (
    <div className="mx-auto mt-20 grid max-w-6xl grid-cols-1 gap-6 px-6 md:grid-cols-2 lg:px-8">
      <div className="marketing-glass-card rounded-2xl p-7">
        <h3 className="mb-5 text-lg font-semibold text-[var(--marketing-text)]">
          Wybierz {competitorName}, jeśli&hellip;
        </h3>
        <ul className="space-y-3">
          {whenChooseCompetitor.map((item) => (
            <li key={item} className="flex items-start gap-2.5 text-sm text-[var(--marketing-muted)]">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[var(--marketing-muted)]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </span>
              {item}
            </li>
          ))}
        </ul>
      </div>
      <div className="marketing-emerald-card rounded-2xl p-7">
        <h3 className="mb-5 text-lg font-semibold text-[var(--marketing-accent)]">
          Wybierz FaktWay, jeśli&hellip;
        </h3>
        <ul className="space-y-3">
          {whenChooseUs.map((item) => (
            <li key={item} className="flex items-start gap-2.5 text-sm text-[var(--marketing-text)]">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--marketing-accent)_18%,transparent)] text-[var(--marketing-accent)] ring-1 ring-[color-mix(in_srgb,var(--marketing-accent)_30%,transparent)]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-3 w-3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface VsMigrationCtaProps {
  competitorName: string;
  copy?: string;
}

export function VsMigrationCta({ competitorName, copy }: VsMigrationCtaProps) {
  return (
    <div className="mx-auto mt-20 max-w-6xl px-6 lg:px-8">
      <div className="relative overflow-hidden rounded-3xl">
        <div className="absolute inset-0 bg-gradient-to-br from-emerald-400 via-emerald-500 to-teal-500" aria-hidden />
        <div
          className="absolute inset-0 opacity-30 mix-blend-overlay"
          style={{
            backgroundImage:
              'radial-gradient(circle at 30% 20%, white 0%, transparent 50%), radial-gradient(circle at 70% 80%, white 0%, transparent 50%)',
          }}
          aria-hidden
        />
        <div className="relative px-8 py-16 text-center text-emerald-950 lg:px-16 lg:py-24">
          <h3 className="mx-auto max-w-3xl text-3xl font-bold leading-tight tracking-tight md:text-5xl">
            Przeprowadzka z {competitorName}
          </h3>
          <p className="mx-auto mt-5 max-w-xl text-base font-medium text-emerald-950/80 md:text-lg">
            {copy ??
              `FaktWay sam pobierze Twoje faktury z KSeF, a starsze wgrasz plikiem CSV z ${competitorName}.`}
          </p>
          <div className="mt-8 flex flex-col items-center gap-3">
            <Link
              href="/register"
              className="inline-flex items-center gap-2 rounded-full bg-white px-7 py-3.5 text-sm font-semibold text-emerald-700 shadow-lg transition-transform hover:scale-105"
            >
              Wypróbuj {TRIAL_DAYS} dni za darmo
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-950/70">
              Potem {PRICE_PER_MONTH} · bez umowy na rok
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
