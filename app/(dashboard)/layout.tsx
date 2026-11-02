import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { assertDashboardShellAccess, getDashboardSessionUser } from '@/lib/dashboard-shell-data';
import DashboardProfileMenu from '@/app/(dashboard)/_components/dashboard-profile-menu';
import { DashboardRouteFlags } from '@/components/dashboard/dashboard-route-flags';
import { KsefHealthBanner } from '@/app/(dashboard)/_components/ksef-health-banner';
import { AppHeader } from '@/components/dashboard/app-header';
import { ProfileMenu } from '@/components/dashboard/profile-menu';
import { AppSidebar } from '@/components/dashboard/app-sidebar';
import { BottomNav } from '@/components/dashboard/bottom-nav';
import { Footer } from '@/components/dashboard/footer';
import { PrefetchDashboardRoutes } from '@/components/dashboard/prefetch-dashboard-routes';
import { ShellScrollMemory } from '@/components/dashboard/shell-scroll-memory';
import { PrefetchExportsRoute } from '@/components/dashboard/exports-route-client';
import { WelcomeModal } from '@/components/dashboard/welcome-modal';
import { IdleWatcher } from '@/components/auth/idle-watcher';
import { InstallPrompt } from '@/components/pwa/install-prompt-lazy';
import { AnalyticsIdentify } from '@/components/analytics/analytics-identify';
import { SupportWidget } from '@/components/support/support-widget';
import { PortalContainerProvider } from '@/components/ui/portal-container';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getAllHelpArticles } from '@/lib/help/articles';
import { getActiveOrgIdFromCookies } from '@/lib/supabase/active-org';

/**
 * Dashboard layout dla wszystkich chronionych podstron `(dashboard)/...`.
 *
 * Decyzja "czy user może być na tej trasie" jest podejmowana DETERMINISTYCZNIE
 * przez admin client (omija RLS). Bezpieczeństwo:
 * - cookie `ksef.active_org` jest httpOnly (klient nie może go modyfikować
 *   z JS) — sfałszowanie wymaga przejęcia sesji,
 * - dane biznesowe (faktury, expenses, kontrahenci) i tak są chronione przez
 *   RLS na ich tabelach (`get_current_tenant_id() = is_member_of`), więc
 *   nawet sfałszowane cookie nie da dostępu do cudzych danych.
 *
 * Uzasadnienie admin client: query memberships/tenants przez user-context
 * Supabase z RLS jest niedeterministyczne tuż po INSERT przez admin (cache
 * PostgREST, propagacja). Skutkiem była pętla onboarding ↔ /invoices.
 *
 * Płynność: `assertDashboardShellAccess()` — jedno zapytanie memberships+tenants
 * na request (`cache`); nagłówek org i baner w `Suspense` z tym samym cache.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await assertDashboardShellAccess();

  // Identity dla PostHog (Faza 31 Krok 5) i imię do menu. `assertDashboardShellAccess`
  // już potwierdziło sesję i aktywną org — tu ten sam użytkownik z `cache()`
  // na żądanie (bez drugiego wywołania GoTrue) i aktywna org z cookie.
  const [user, activeOrg] = await Promise.all([
    getDashboardSessionUser(),
    getActiveOrgIdFromCookies(),
  ]);

  // Stan paska bocznego (rozwinięty / zwinięty do ikon) z ciasteczka, które
  // zapisuje `SidebarProvider` — bez tego pasek „skakałby" po hydracji.
  const sidebarOpen = (await cookies()).get('sidebar_state')?.value !== 'false';

  // Imię do menu avatara, jeśli GoTrue je ma (Google OAuth: `full_name`).
  const metaName: unknown =
    user?.user_metadata?.full_name ?? user?.user_metadata?.name;
  const userName =
    typeof metaName === 'string' && metaName.trim() ? metaName.trim() : undefined;

  // Mapa slug → tytuł dla chipsów cytowań w support widgecie.
  const helpArticleTitles: Record<string, string> = Object.fromEntries(
    getAllHelpArticles().map((a) => [a.slug, a.title]),
  );

  // `100dvh`, nie `100vh`: na iOS Safari `100vh` to wysokość okna BEZ pasków
  // przeglądarki, więc dolna krawędź szkieletu chowa się pod paskiem adresu.
  // `ff-app-shell` blokuje przewijanie samego dokumentu (`globals.css`, „Pasek
  // górny stoi w miejscu”) — przewija się tylko `.ff-shell-scroll`.
  // Wysokość nagłówka niesie `.ff-shell-header` (tokeny `--ff-header-h`
  // i `--ff-safe-t`), stąd brak `h-20` w `AppHeader`.
  //
  // SZKIELET FINORY (plan Finora P0, E2). `SidebarProvider` jest korzeniem
  // i nosi `ff-dashboard` (tokeny, skala SM, motyw). `PortalContainerProvider`
  // stoi w środku korzenia, ale POZA animowanym `.ff-route-template`, żeby
  // menu, okna i podpowiedzi Base UI dziedziczyły tokeny, a `transform`
  // animacji trasy nie przypinał ich do pudełka strony.
  //
  // STOPKA NA DOLE (poprawka Bartosza 21.10.2026): `.ff-shell-scroll` jest
  // kolumną flex, kontener treści rośnie (`grow`, bez `min-h-0` — nie może
  // skurczyć się poniżej treści i wjechać na stopkę), więc „Regulamin ·
  // Polityka · Pomoc” stoją przy dolnej krawędzi także na krótkiej stronie.
  // `ff-shell-content` niesie łańcuch „pełnego arkusza” list Faktur
  // (`globals.css`, `.ff-page-fill`).
  return (
    <TooltipProvider>
      <SidebarProvider
        defaultOpen={sidebarOpen}
        className="ff-dashboard ff-app-shell relative h-[100dvh] min-h-0 overflow-hidden text-[var(--ff-on-surface)]"
      >
        <PortalContainerProvider>
          <AppSidebar />

          <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
            <AppHeader
              profile={
                user?.email ? (
                  // Do czasu wczytania firm menu działa bez nich (e‑mail,
                  // Ustawienia, Analiza, Wyloguj) — pasek nie czeka na bazę.
                  <Suspense
                    fallback={
                      <ProfileMenu email={user.email} name={userName} company={null} memberships={[]} />
                    }
                  >
                    <DashboardProfileMenu email={user.email} name={userName} />
                  </Suspense>
                ) : null
              }
            />

            <div className="ff-shell-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
              {/* Kontener treści 1:1 z `<main>` Finory (układ „compact”). */}
              <div className="ff-shell-content mx-auto w-full max-w-360 grow px-4 py-6 sm:px-6">
                <Suspense fallback={null}>
                  <KsefHealthBanner />
                </Suspense>
                {children}
              </div>
              <Footer />
            </div>
          </SidebarInset>

          <BottomNav />
          {/* Za treścią: jego efekt układu biegnie po przewinięciu Nexta. */}
          <ShellScrollMemory />
          <DashboardRouteFlags />
          <InstallPrompt />
          <PrefetchDashboardRoutes />
          <PrefetchExportsRoute />
          <IdleWatcher />
          {user && activeOrg && (
            <AnalyticsIdentify
              userId={user.id}
              tenantId={activeOrg}
            />
          )}
          <SupportWidget articleTitles={helpArticleTitles} />
          <Suspense fallback={null}>
            <WelcomeModal />
          </Suspense>
        </PortalContainerProvider>
      </SidebarProvider>
    </TooltipProvider>
  );
}
