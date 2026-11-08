import Link from 'next/link';
import { redirect } from 'next/navigation';

import { signOut } from '@/app/(auth)/login/actions';
import { FaktWayLogo } from '@/components/brand/faktway-logo';
import { LegalInline } from '@/components/legal/legal-document';
import { Button } from '@/components/ui/button';
import { requireVerifiedUserForPage } from '@/lib/auth/verified-user';
import { needsTermsAcceptance, readLegalMetadata } from '@/lib/legal/acceptance';
import { REGULAMIN } from '@/lib/legal/documents';
import { LEGAL_ENTITY } from '@/lib/legal/entity';
import { safeNextPath } from '@/lib/legal/safe-next';
import { CONTRACT_VERSION, MARKETING_STATEMENT, TERMS_STATEMENT } from '@/lib/legal/versions';

import { acceptTermsAction } from './actions';

const ERRORS: Record<string, string> = {
  terms_required: 'Zaznacz pole akceptacji Regulaminu i Umowy powierzenia, żeby przejść dalej.',
  save_failed: 'Nie udało się zapisać akceptacji. Spróbuj ponownie za chwilę.',
};

/**
 * Bramka dokumentów prawnych (lib/legal/acceptance.ts). Trafia tu konto bez
 * akceptacji bieżącej wersji: założone przez Google, sprzed wprowadzenia
 * dokumentów albo po zmianie regulaminu.
 *
 * „Blokada bez wyjścia to nowy błąd” (AGENTS.md, protokół, pkt 4): kto nie
 * akceptuje, może pobrać kopię danych, wylogować się i zlecić rozwiązanie
 * umowy — panel jest za bramką, więc wszystkie trzy drogi są tutaj.
 */
export default async function LegalGatePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const next = safeNextPath(sp.next);
  const { user } = await requireVerifiedUserForPage('/onboarding/zgody');
  if (!needsTermsAcceptance(user.app_metadata)) redirect(next);

  const previous = readLegalMetadata(user.app_metadata).terms;
  const isUpdate = previous !== undefined && !previous.draft && previous.version !== CONTRACT_VERSION;
  const error = sp.error ? ERRORS[sp.error] : undefined;

  return (
    <div className="ff-dashboard relative flex min-h-screen items-center justify-center overflow-hidden p-4 text-[var(--ff-on-surface)]">
      <div className="ff-mesh-gradient" aria-hidden />
      <div className="relative z-[1] w-full max-w-2xl">
        <div className="ff-glass-pane rounded-3xl p-8 lg:p-12">
          <div className="mb-6 flex justify-center">
            <Link href="/" aria-label="FaktWay, strona główna" className="transition-opacity hover:opacity-80">
              <FaktWayLogo className="h-8" />
            </Link>
          </div>
          <h1 className="mb-3 text-center text-2xl font-semibold tracking-tight">
            {isUpdate ? 'Zmieniliśmy dokumenty FaktWay' : 'Zanim zaczniesz — dokumenty FaktWay'}
          </h1>
          <p className="mb-6 leading-relaxed text-muted-foreground">
            {isUpdate
              ? `Od ${CONTRACT_VERSION} obowiązuje nowa wersja Regulaminu i Umowy powierzenia. Żeby dalej korzystać z serwisu, zaakceptuj ją.`
              : 'Żeby korzystać z serwisu, zaakceptuj Regulamin i Umowę powierzenia przetwarzania danych osobowych.'}
          </p>

          {REGULAMIN.summary ? (
            <ul className="mb-6 list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
              {REGULAMIN.summary.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          ) : null}

          {error ? (
            <p role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm">
              {error}
            </p>
          ) : null}

          <form action={acceptTermsAction} className="space-y-4">
            <input type="hidden" name="next" value={next} />
            <label className="flex items-start gap-2.5 text-sm leading-relaxed">
              <input type="checkbox" name="terms" value="on" required className="mt-1 h-4 w-4 shrink-0" />
              <span>
                <LegalInline text={TERMS_STATEMENT.text} linkClassName="underline underline-offset-2" /> (wymagane)
              </span>
            </label>
            <label className="flex items-start gap-2.5 text-sm leading-relaxed text-muted-foreground">
              <input type="checkbox" name="marketing" value="on" className="mt-1 h-4 w-4 shrink-0" />
              <span>{MARKETING_STATEMENT.text} (dobrowolne)</span>
            </label>
            <Button type="submit" size="lg" className="w-full">
              Akceptuję i przechodzę dalej
            </Button>
          </form>

          <div className="mt-8 border-t border-[var(--ff-border)] pt-6 text-sm leading-relaxed text-muted-foreground">
            <p className="font-medium text-[var(--ff-on-surface)]">Nie akceptujesz?</p>
            <p className="mt-1">
              Możesz <a href="/api/gdpr/export" className="underline underline-offset-2">pobrać kopię swoich danych</a>{' '}
              i wylogować się. Aby rozwiązać umowę i usunąć dane firmy, napisz na{' '}
              <a href={`mailto:${LEGAL_ENTITY.email}`} className="underline underline-offset-2">{LEGAL_ENTITY.email}</a>.
              Pełna treść dokumentów:{' '}
              <Link href="/legal/regulamin" target="_blank" className="underline underline-offset-2">
                strona dokumentów prawnych
              </Link>
              .
            </p>
            <form action={signOut} className="mt-3">
              <Button type="submit" variant="outline" size="sm">
                Wyloguj się
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
