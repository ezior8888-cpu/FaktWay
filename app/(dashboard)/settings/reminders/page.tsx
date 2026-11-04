import { ReminderSettingsForm } from '@/components/reminders/reminder-settings-form';
import { getPageContextWithRole } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

export default async function ReminderSettingsPage() {
  const { supabase, tenantId } = await getPageContextWithRole('owner', '/settings');

  const [{ data: settings }, { data: tenant }] = await Promise.all([
    supabase
      .from('reminder_settings')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    supabase.from('tenants').select('name').eq('id', tenantId).maybeSingle(),
  ]);

  const tenantName = tenant?.name ?? '';

  return (
    <ReminderSettingsForm initialSettings={settings} tenantName={tenantName} />
  );
}
