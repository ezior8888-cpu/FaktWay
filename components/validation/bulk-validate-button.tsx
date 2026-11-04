'use client';

import { useTransition } from 'react';

import { RiLoader4Line, RiShieldCheckLine } from '@remixicon/react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { bulkValidateContractorsAction } from '@/app/actions/validation';
import { Button } from '@/components/ui/button';

export function BulkValidateButton({
  className,
}: {
  className?: string;
} = {}) {
  const router = useRouter();
  const [isStarting, startBulk] = useTransition();

  const handleBulkValidate = () => {
    startBulk(async () => {
      const result = await bulkValidateContractorsAction({ forceRefresh: false });
      if (result.success) {
        toast.success(`Sprawdzam ${result.total} kontrahentów w tle...`);
        setTimeout(() => {
          router.refresh();
        }, 30000);
      } else {
        toast.error(result.error);
      }
    });
  };

  // Przycisk Finory (`outline`, jak akcje paska data-table) — bez dawnego „szkła”.
  return (
    <Button
      type="button"
      onClick={handleBulkValidate}
      variant="outline"
      disabled={isStarting}
      className={className}
    >
      {isStarting ? (
        <RiLoader4Line className="animate-spin" aria-hidden />
      ) : (
        <RiShieldCheckLine aria-hidden />
      )}
      Sprawdź wszystkich
    </Button>
  );
}
