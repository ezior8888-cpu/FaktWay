import Link from 'next/link';

/**
 * Pasek informacyjny dla użytkownika bez żadnej organizacji (link do utworzenia firmy).
 */
export default function DashboardNoOrgBanner() {
  return (
    <div
      className="ff-glass-pane mb-8 mt-8 flex flex-col gap-3 rounded-xl border border-[color-mix(in_srgb,var(--ff-secondary)_20%,transparent)] bg-[color-mix(in_srgb,var(--ff-secondary-container)_10%,transparent)] p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
      role="status"
    >
      <div className="flex min-w-0 items-start gap-3 sm:items-center">
        <span
          className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--ff-secondary)] sm:mt-0"
          aria-hidden
        />
        <p className="text-[15px] leading-relaxed text-[var(--ff-on-surface)]">
          <span className="font-bold text-[var(--ff-secondary)]">
            Brak aktywnej organizacji.
          </span>{' '}
          Możesz przeglądać menu i widoki aplikacji. Faktury, wydatki i ustawienia
          firmy będą dostępne po założeniu pierwszej organizacji.
        </p>
      </div>
      <Link
        href="/onboarding"
        prefetch={false}
        className="shrink-0 text-[15px] font-bold text-[var(--ff-secondary)] underline decoration-[color-mix(in_srgb,var(--ff-secondary)_30%,transparent)] underline-offset-4 transition-colors hover:decoration-[var(--ff-secondary)]"
      >
        Załóż organizację →
      </Link>
    </div>
  );
}
