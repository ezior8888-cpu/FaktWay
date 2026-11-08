// Plan Finora P15 (E10b, §2.2): kreator firmy po rejestracji w układzie
// logowania Finory (`AuthSplitLayout`) zamiast dawnego szkła z mesh
// gradientem. Logika bez zmian: `OnboardingForm` i akcje
// `app/actions/organizations.ts`.

import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { RiArrowLeftSLine, RiCheckboxCircleLine } from '@remixicon/react';

import { AuthSplitLayout } from '@/components/auth/finora/auth-split-layout';
import { OnboardingForm } from '@/components/onboarding/form';
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert';
import { FIRST_COMPANY_CLOSED_MESSAGE, isSignupClosed } from '@/lib/feature-flags/signups';
import { ACTIVE_ORG_COOKIE, isUuid } from '@/lib/supabase/active-org';
import { requireVerifiedUserForPage } from '@/lib/auth/verified-user';
import { LEGAL_GATE_PATH, needsTermsAcceptance } from '@/lib/legal/acceptance';

interface OnboardingPageProps {
  searchParams: Promise<{
    invite?: string;
    action?: 'new' | 'invite' | 'join';
  }>;
}

/**
 * Strona onboardingu — celowo NIE robi redirectu na "/" gdy user ma cookie:
 * tu wpada zarówno (a) nowy user bez membership (zakłada pierwszą firmę),
 * jak i (b) user z aktywną org który chce dodać kolejną organizację /
 * zaakceptować zaproszenie.
 *
 * Baner „masz aktywną org” tylko przy `?action=new` (celowy flow z pulpitu),
 * żeby pierwszy ekran po rejestracji nie był zasłonięty paskiem.
 *
 * Brak `redirect()` zapobiega soft-nav loop (URL pasek na /onboarding,
 * RSC zwracający redirect do /, browser wraca na /onboarding ad infinitum).
 */
export default async function OnboardingPage(props: OnboardingPageProps) {
  const sp = await props.searchParams;
  const query = new URLSearchParams();
  if (sp.invite) query.set('invite', sp.invite);
  if (sp.action) query.set('action', sp.action);
  const returnTo = '/onboarding' + (query.size ? '?' + query.toString() : '');
  const { user } = await requireVerifiedUserForPage(returnTo);
  // Konto z Google zakłada się bez naszego formularza — tu łapiemy je przed
  // utworzeniem pierwszej firmy (bramka śpi, dopóki dokumenty są robocze).
  if (needsTermsAcceptance(user.app_metadata)) {
    redirect(`${LEGAL_GATE_PATH}?next=${encodeURIComponent(returnTo)}`);
  }

  const cookieStore = await cookies();
  const activeOrg = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;
  const hasActiveOrg = isUuid(activeOrg);
  const showActiveOrgBanner = hasActiveOrg && sp.action === 'new';
  // Wyłącznik rejestracji — sama blokada siedzi w akcjach zakładania firmy.
  const showSignupsClosed = !hasActiveOrg && (await isSignupClosed());

  return (
    <AuthSplitLayout
      panelTitle="Jeszcze chwila i wystawisz pierwszą fakturę"
      panelText="Podaj NIP, a dane firmy pobierzemy z GUS. Masz zaproszenie? Dołączysz do firmy jednym kliknięciem."
    >
      {showActiveOrgBanner ? (
        <Alert role="status" className="border-primary/30 px-3 py-2.5 pr-24">
          <RiCheckboxCircleLine className="text-primary" />
          <AlertDescription className="text-sm/relaxed text-foreground">
            Masz już aktywną organizację. Możesz dodać kolejną poniżej albo
            wrócić do panelu.
          </AlertDescription>
          <AlertAction>
            <Link
              href="/dashboard"
              prefetch={false}
              className="inline-flex items-center gap-1 whitespace-nowrap text-sm font-medium text-primary hover:underline"
            >
              <RiArrowLeftSLine className="size-4" />
              Pulpit
            </Link>
          </AlertAction>
        </Alert>
      ) : null}

      {showSignupsClosed ? (
        <Alert role="status" className="px-3 py-2.5">
          <AlertDescription className="text-sm/relaxed text-foreground">
            {FIRST_COMPANY_CLOSED_MESSAGE}
          </AlertDescription>
        </Alert>
      ) : null}

      <div>
        <h1 className="mb-2 text-2xl font-semibold">
          {showActiveOrgBanner ? 'Dodaj kolejną organizację' : 'Witaj w FaktWay'}
        </h1>
        <p className="text-muted-foreground">
          Wybierz, jak chcesz zacząć: załóż nową organizację, akceptuj
          zaproszenie albo poproś o dostęp do firmy, która już używa
          FaktWay.
        </p>
      </div>

      <OnboardingForm initialInviteToken={sp.invite} />
    </AuthSplitLayout>
  );
}
