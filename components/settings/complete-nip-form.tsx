'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  RiArrowRightLine,
  RiErrorWarningLine,
  RiLoader4Line,
  RiSearchLine,
} from '@remixicon/react';
import { toast } from 'sonner';

import {
  lookupNipAction,
  type OnboardingCompanyData,
} from '@/components/onboarding/actions';
import { completeCompanyNipAction } from '@/app/actions/organizations';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';

/**
 * Uzupełnienie NIP-u organizacji-szkicu (BUG-007) — ten sam flow co w
 * onboardingu (GUS lookup → potwierdzenie), ale UPDATE istniejącego tenanta
 * zamiast tworzenia nowego. Renderowane na /settings/ksef, gdy nip = ''.
 */
export function CompleteNipForm() {
  const router = useRouter();
  const [nipInput, setNipInput] = useState('');
  const [company, setCompany] = useState<OnboardingCompanyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, startSearching] = useTransition();
  const [isSaving, startSaving] = useTransition();

  const handleLookup = () => {
    setError(null);
    setCompany(null);
    startSearching(async () => {
      const result = await lookupNipAction(nipInput);
      if (result.success) {
        setCompany(result.data);
      } else {
        setError(result.error);
      }
    });
  };

  const handleConfirm = () => {
    if (!company) return;
    startSaving(async () => {
      const result = await completeCompanyNipAction(company);
      if (result.success) {
        toast.success('NIP uzupełniony — możesz teraz wgrać certyfikat KSeF.');
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  // Wygląd z Finory: pole z przyciskiem jak `InputGroup`, błąd i wynik GUS
  // w `Alert`, przyciski jak w jej oknach dialogowych.
  return (
    <FieldGroup>
      <Field orientation="responsive" className="flex-col!">
        <FieldContent>
          <FieldLabel htmlFor="complete-nip">NIP firmy</FieldLabel>
          <FieldDescription>
            Pobierzemy dane firmy z bazy GUS REGON i przypiszemy je do Twojej
            organizacji.
          </FieldDescription>
        </FieldContent>
        <div className="w-full!">
          <InputGroup>
            <InputGroupInput
              id="complete-nip"
              value={nipInput}
              onChange={(e) => setNipInput(e.target.value.replace(/\D/g, ''))}
              placeholder="Wpisz 10 cyfr NIP"
              maxLength={10}
              disabled={isSearching || !!company}
              className="font-mono"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                onClick={handleLookup}
                size="icon-xs"
                disabled={nipInput.length !== 10 || isSearching || !!company}
                aria-label="Szukaj w GUS"
              >
                {isSearching ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiSearchLine aria-hidden />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </Field>

      {error && (
        <Alert variant="destructive">
          <RiErrorWarningLine aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {company && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 border p-3">
            <Badge className="bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400">
              Znaleziono w bazie GUS
            </Badge>
            <dl className="grid grid-cols-1 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs">Nazwa firmy</dt>
                <dd className="mt-0.5 font-medium">{company.name}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Adres siedziby</dt>
                <dd className="mt-0.5 leading-relaxed">
                  {company.street} {company.buildingNumber}
                  {company.localNumber ? `/${company.localNumber}` : ''}
                  <br />
                  {company.postalCode} {company.city}
                </dd>
              </div>
            </dl>
          </div>

          <div className="flex gap-3 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCompany(null);
                setNipInput('');
                setError(null);
              }}
            >
              Wpisz inny NIP
            </Button>
            <Button onClick={handleConfirm} disabled={isSaving}>
              {isSaving ? (
                <>
                  <RiLoader4Line className="animate-spin" aria-hidden />
                  Zapisuję dane firmy...
                </>
              ) : (
                <>
                  Przypisz NIP do organizacji
                  <RiArrowRightLine aria-hidden />
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {!company && (
        <FieldDescription>
          Twoja organizacja to na razie szkic bez NIP-u. Po przypisaniu NIP-u
          odblokujesz wgrywanie certyfikatu KSeF, wysyłkę faktur i automatyczne
          pobieranie historii z KSeF.
        </FieldDescription>
      )}
    </FieldGroup>
  );
}
