import type { Metadata } from 'next';

import { StatusScreen } from '@/components/site/status-screen';
import { ButtonLink } from '@/components/site/ui';

export const metadata: Metadata = {
  title: 'Przerwa techniczna | FaktWay',
  robots: { index: false, follow: false },
};

/**
 * Tu proxy kieruje panel, gdy operator włączy `maintenanceMode` (AUD-63).
 * Strona jest statyczna i publiczna — nie czyta flagi, więc po końcu
 * przerwy „Spróbuj ponownie” po prostu wraca do panelu.
 */
export default function MaintenancePage() {
  return (
    <StatusScreen
      title="Panel jest chwilowo niedostępny"
      lead="Trwają prace techniczne. Twoje faktury i dane są bezpieczne. Spróbuj ponownie za kilka minut."
      actions={
        <ButtonLink href="/dashboard" prefetch={false}>
          Spróbuj ponownie
        </ButtonLink>
      }
    />
  );
}
