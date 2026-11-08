import type { Metadata } from 'next';
import { ShieldAlert } from 'lucide-react';

import { requireAdmin } from '@/lib/auth/admin-guard';

import { AdminNav } from './_components/admin-nav';

export const metadata: Metadata = {
  title: 'Admin — FaktWay',
  description: 'Wewnętrzny panel operatora platformy.',
  // Bezwzględny zakaz indeksacji `/admin/*` — strona nie powinna trafić nawet
  // przypadkiem do Google ani archive.org.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Admin layout (Faza 24). Kontroluje dostęp do interfejsu przez `requireAdmin()`.
 * Nie gwarantuje kolejności wykonania odczytów w komponentach potomnych.
 * Funkcje odczytu danych i akcje muszą sprawdzać uprawnienia przed użyciem service_role.
 *
 * Renderujemy własny header/footer (NIE używamy `(dashboard)/layout.tsx`),
 * żeby admin nie widział menu firm, dolnej nawigacji i innych elementów,
 * które są bez znaczenia w trybie operatorskim.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requireAdmin();

  return (
    <div className="min-h-screen bg-mesh-surface text-foreground">
      <header className="sticky top-0 z-40 border-b border-red-500/30 bg-red-500/5 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3 px-4 py-2 sm:px-6">
          <div className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
            <ShieldAlert className="h-4 w-4" aria-hidden />
            <span className="uppercase tracking-wider">Admin mode</span>
            <span className="text-muted-foreground font-normal">
              · {admin.email}
            </span>
          </div>
          <p className="hidden text-xs text-muted-foreground sm:block">
            Operacje wpływają na produkcję i są logowane (audit_logs)
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
        <AdminNav />
        <main className="mt-6">{children}</main>
      </div>
    </div>
  );
}
