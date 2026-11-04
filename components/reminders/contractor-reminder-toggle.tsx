'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { toggleContractorRemindersAction } from '@/app/actions/reminders';
import { Switch } from '@/components/ui/switch';

interface Props {
  contractorId: string;
  /** Nazwa kontrahenta w nazwie przełącznika — każdy wiersz ma inną (WCAG 2.4.6). */
  contractorName: string;
  excluded: boolean;
}

/**
 * Przełącznik przypomnień kontrahenta (P13: „Przypomnienia (przełącznik)”).
 * Włączony = przypomnienia idą; wyłączony = kontrahent wykluczony
 * (`reminder_excluded`). Akcja i komunikaty bez zmian.
 *
 * Nazwa stała, z kontrahentem (jak „Auto-sync {instytucja}” w Finorze);
 * stan ogłasza rola switch, więc nie powtarzamy go w nazwie.
 */
export function ContractorReminderToggle({ contractorId, contractorName, excluded }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [localExcluded, setLocalExcluded] = useState(excluded);

  const handleToggle = () => {
    startTransition(async () => {
      const newValue = !localExcluded;

      const result = await toggleContractorRemindersAction(
        contractorId,
        newValue,
        undefined,
      );

      if (result.success) {
        setLocalExcluded(newValue);
        toast.success(
          newValue
            ? 'Przypomnienia wyłączone dla tego kontrahenta'
            : 'Przypomnienia włączone dla tego kontrahenta',
        );
        router.refresh();
      } else {
        toast.error(result.error ?? 'Błąd');
      }
    });
  };

  const state = localExcluded ? 'Przypomnienia wyłączone' : 'Przypomnienia włączone';

  return (
    <Switch
      checked={!localExcluded}
      onCheckedChange={handleToggle}
      disabled={isPending}
      aria-label={`Przypomnienia dla ${contractorName}`}
      title={state}
    />
  );
}
