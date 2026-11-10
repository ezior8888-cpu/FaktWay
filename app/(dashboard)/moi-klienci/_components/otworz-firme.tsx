'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { setActiveOrganizationAction } from '@/app/actions/organizations';
import { Button } from '@/components/ui/button';

/**
 * „Otwórz” na ekranie „Moi klienci”: ta sama akcja co przełączanie w „Moje
 * firmy” (sesja po 2FA, członkostwo sprawdzone w bazie, ciasteczko aktywnej
 * firmy), potem pulpit tej firmy. Przycisk, nie link: link z przełączeniem
 * firmy byłby żądaniem GET ze skutkiem, które `next/link` potrafi wywołać
 * samym wstępnym pobraniem.
 */
export function OtworzFirme({ organizationId, nazwa }: { organizationId: string; nazwa: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const otworz = () => {
    startTransition(async () => {
      const wynik = await setActiveOrganizationAction(organizationId);
      if (wynik.success) router.push('/dashboard');
      else toast.error(wynik.error);
    });
  };

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full sm:w-auto [@media(pointer:coarse)]:h-11"
      disabled={pending}
      aria-label={`Otwórz firmę ${nazwa}`}
      onClick={otworz}
    >
      {pending ? 'Otwieram…' : 'Otwórz'}
    </Button>
  );
}
