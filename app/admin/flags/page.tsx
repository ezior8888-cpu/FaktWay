import { requireAdmin } from '@/lib/auth/admin-guard';
import Link from 'next/link';
import { Building2, Flag, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { listTenantsWithFlags } from '@/lib/admin/flags';

import { FlagToggle } from './_components/flag-toggle';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface SearchParams {
  q?: string;
  page?: string;
}

export default async function AdminFlagsPage(props: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdmin();

  const params = await props.searchParams;
  const page = Math.max(0, Number.parseInt(params.page ?? '0', 10) || 0);

  const { items, total } = await listTenantsWithFlags({
    q: params.q,
    page,
    pageSize: PAGE_SIZE,
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tighter-display">
          Feature flags
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Per-tenant kill-switch dla modułów. Default = wyłączone (opt-in
          roll-out). {total.toLocaleString('pl-PL')} aktywnych organizacji.
        </p>
      </header>

      <div className="rounded-2xl border border-glass-border bg-foreground/3 p-4 backdrop-blur-glass">
        <form className="flex gap-2" action="/admin/flags">
          <input
            type="text"
            name="q"
            defaultValue={params.q}
            placeholder="Nazwa organizacji lub NIP…"
            className="flex-1 rounded-xl border border-glass-border bg-background/50 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-xl border border-glass-border bg-foreground/3 px-4 py-2 text-sm font-medium hover:bg-foreground/5"
          >
            Szukaj
          </button>
        </form>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Flag}
          title="Brak organizacji"
          description={
            params.q
              ? `Nic nie pasuje do „${params.q}".`
              : 'Brak aktywnych organizacji w bazie.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass">
          <table className="w-full text-sm">
            <thead className="border-b border-glass-border">
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Organizacja</th>
                <th className="px-4 py-2.5 font-medium">NIP</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-center">Co-Pilot</th>
                <th className="px-4 py-2.5 font-medium text-center">Magic Import</th>
                <th className="px-4 py-2.5 font-medium text-center">Exports</th>
                <th
                  className="px-4 py-2.5 font-medium text-center"
                  title="Pilotaż księgowości JDG (plan, K8): klientom dopiero po bramie z sekcji 11 planu (spółka, prawnik, OC, podpis księgowej)"
                >
                  Księgowość (pilotaż)
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr
                  key={t.tenantId}
                  className="border-b border-glass-border last:border-0 hover:bg-foreground/5"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium">{t.tenantName}</span>
                      {t.ksefVerified ? (
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{t.tenantNip}</td>
                  <td className="px-4 py-3">
                    {t.isActive ? (
                      <Badge variant="secondary" className="text-xs">
                        Aktywna
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        Nieaktywna
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <FlagToggle
                      tenantId={t.tenantId}
                      flag="co_pilot_enabled"
                      initialEnabled={t.flags.co_pilot_enabled}
                      label="Co-Pilot"
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <FlagToggle
                      tenantId={t.tenantId}
                      flag="magic_import_enabled"
                      initialEnabled={t.flags.magic_import_enabled}
                      label="Magic Import"
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <FlagToggle
                      tenantId={t.tenantId}
                      flag="exports_enabled"
                      initialEnabled={t.flags.exports_enabled}
                      label="Exports"
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <FlagToggle
                      tenantId={t.tenantId}
                      flag="ksiegowosc_enabled"
                      initialEnabled={t.flags.ksiegowosc_enabled}
                      label="Księgowość"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Strona {page + 1} z {Math.ceil(total / PAGE_SIZE)}
          </span>
          <div className="flex gap-2">
            {page > 0 ? (
              <Link
                href={`/admin/flags?${new URLSearchParams({
                  ...(params.q ? { q: params.q } : {}),
                  ...(page - 1 > 0 ? { page: String(page - 1) } : {}),
                }).toString()}`}
                className="rounded-xl border border-glass-border bg-foreground/3 px-3 py-1.5 hover:bg-foreground/5"
              >
                Poprzednia
              </Link>
            ) : null}
            {page < Math.ceil(total / PAGE_SIZE) - 1 ? (
              <Link
                href={`/admin/flags?${new URLSearchParams({
                  ...(params.q ? { q: params.q } : {}),
                  page: String(page + 1),
                }).toString()}`}
                className="rounded-xl border border-glass-border bg-foreground/3 px-3 py-1.5 hover:bg-foreground/5"
              >
                Następna
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
