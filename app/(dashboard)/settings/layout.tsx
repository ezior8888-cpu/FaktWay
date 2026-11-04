import SettingsView from '@/components/settings/finora/settings-view';
import { settingsTabsForRole } from '@/components/settings/finora/settings-tabs';
import { getPageContext } from '@/lib/supabase/page-context';

/**
 * Ramka ustawień = strona Settings szablonu Finora (plan P14): zakładki po
 * lewej, treść po prawej, na telefonie menu w Sheet. Zakładki to linki do
 * istniejących adresów `/settings/*`; listę liczymy tutaj, na serwerze, z roli
 * w aktywnej firmie. Każda strona dalej sama sprawdza uprawnienia i czyta
 * dane klientem z sesji (RLS).
 */
export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { role } = await getPageContext();

  return <SettingsView tabs={settingsTabsForRole(role)}>{children}</SettingsView>;
}
