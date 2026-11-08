import { ProfileMenu } from '@/components/dashboard/profile-menu';
import { getDashboardOrgSwitcherProps } from '@/lib/dashboard-shell-data';

/**
 * Menu profilu w pasku górnym z danymi firm (nazwa aktywnej, lista do
 * przełączania). Te same dane i to samo zachowanie co dawny przełącznik
 * firmy w pasku: bez aktywnej organizacji `getDashboardOrgSwitcherProps`
 * przekierowuje do onboardingu.
 */
export default async function DashboardProfileMenu({ email, name }: { email: string; name?: string }) {
  const { memberships, activeName } = await getDashboardOrgSwitcherProps();
  return <ProfileMenu email={email} name={name} company={activeName} memberships={memberships} />;
}
