'use client';

// Plan Finora P15 (E10b): przycisk i błąd na prymitywach Finory. Logika bez
// zmian: `acceptInvitationAction`, potem Pulpit.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiArrowRightLine, RiLoader4Line } from '@remixicon/react';

import { acceptInvitationAction } from '@/app/actions/organizations';
import { AuthMessage } from '@/components/auth/finora/auth-message';
import { Button } from '@/components/ui/button';

export function InviteAcceptForm({
  token,
  orgName,
}: {
  token: string;
  orgName: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  const handleAccept = () => {
    setError(null);
    start(async () => {
      const r = await acceptInvitationAction(token);
      if (r.success) {
        router.push('/dashboard');
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  };

  return (
    <div className="space-y-3">
      {error ? <AuthMessage tone="error">{error}</AuthMessage> : null}
      <Button
        onClick={handleAccept}
        disabled={isPending}
        size="lg"
        className="w-full"
      >
        {isPending ? (
          <>
            <RiLoader4Line className="animate-spin" />
            Akceptuję...
          </>
        ) : (
          <>
            Dołącz do {orgName}
            <RiArrowRightLine />
          </>
        )}
      </Button>
    </div>
  );
}
