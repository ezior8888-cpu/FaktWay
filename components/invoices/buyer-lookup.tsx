'use client';

import { useTransition } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { NipValidatedInput } from '@/components/validation/nip-validated-input';
import { Button } from '@/components/ui/button';

import type { CachedValidationResult } from '@/lib/validation/cache';

import { lookupBuyerAction } from './actions';

interface Props {
  nip: string;
  onNipChange: (digits: string) => void;
  onSelected: (data: {
    nip: string;
    name: string;
    addressLine1: string;
    addressLine2: string;
  }) => void;
  nipError?: string;
  onValidationComplete?: (result: CachedValidationResult | null) => void;
  /** `id` pola NIP — dla `<Label htmlFor>` (WCAG 1.3.1). */
  inputId?: string;
}

export function BuyerLookup({
  nip,
  onNipChange,
  onSelected,
  nipError,
  onValidationComplete,
  inputId,
}: Props) {
  const [isLoading, startLoading] = useTransition();

  const handleLookup = () => {
    startLoading(async () => {
      const result = await lookupBuyerAction(nip);
      if (result.success) {
        onSelected(result.data);
        toast.success(
          result.source === 'cache'
            ? 'Uzupełniono z historii kontrahentów'
            : 'Uzupełniono danymi z GUS',
        );
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <NipValidatedInput
            id={inputId}
            value={nip}
            onChange={(v) =>
              onNipChange(v.replace(/\D/g, '').slice(0, 10))
            }
            onValidationComplete={onValidationComplete}
            placeholder="1234567890"
            disabled={isLoading}
            className={
              nipError
                ? 'border-red-500/60 focus-visible:border-red-500/60 focus-visible:ring-red-500/20'
                : ''
            }
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleLookup}
          disabled={nip.length !== 10 || isLoading}
          className="h-10 w-10 shrink-0 rounded-lg"
          aria-label="Wyszukaj w GUS lub historii kontrahentów"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4 text-muted-foreground" />
          )}
        </Button>
      </div>
      {nipError ? (
        <p className="text-xs text-red-600 dark:text-red-400">{nipError}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Wpisz NIP — weryfikacja VAT w tle — i opcjonalnie kliknij lupę, żeby
          uzupełnić nazwę i adres (GUS / historia).
        </p>
      )}
    </div>
  );
}
