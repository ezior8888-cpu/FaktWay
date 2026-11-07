'use client';

import { useState, useSyncExternalStore } from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';

import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { addPasskeyDevice, removePasskeyDevice } from '@/lib/auth/passkey/client';
import { PASSKEY_ALREADY_ON_DEVICE_MESSAGE, passkeyServerMessage } from '@/lib/auth/passkey/messages';
import type { PasskeyDevice } from '@/lib/auth/passkey/types';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';

const RETURN_TO = '/settings/security';
const subscribeToNothing = () => () => {};

interface Props {
  initialDevices: PasskeyDevice[];
  /** Sesja po biometrii: konto ma 2FA, a ta sesja go nie potwierdziła. */
  stepUpRequired: boolean;
  loadFailed: boolean;
}

/**
 * Lista urządzeń do logowania biometrią: nazwa, ostatnie użycie, dodaj, usuń.
 * Końcówki sprawdzają AAL2 same; `stepUpRequired` tylko oszczędza klientowi
 * okno systemowe, które i tak skończyłoby się odmową.
 */
export function PasskeysCard({ initialDevices, stepUpRequired, loadFailed }: Props) {
  const [devices, setDevices] = useState(initialDevices);
  // Na serwerze zakładamy, że tak: przycisk nie znika po hydracji u prawie nikogo.
  const supported = useSyncExternalStore(subscribeToNothing, browserSupportsWebAuthn, () => true);
  const [isPending, setIsPending] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState(false);

  const clearMessages = () => {
    setError(null);
    setNotice(null);
    setNeedsCode(false);
  };

  const onAdd = async () => {
    clearMessages();
    if (stepUpRequired) {
      setNeedsCode(true);
      return;
    }
    setIsPending(true);
    const result = await addPasskeyDevice();
    setIsPending(false);
    if (result.ok) {
      const { device } = result;
      // `device` puste: telefon ma już klucz tego konta (`addPasskeyDevice`).
      if (device) setDevices((current) => [...current, device]);
      setNotice(device
        ? 'Urządzenie dodane. Przy następnym logowaniu użyj przycisku „Zaloguj biometrią”.'
        : PASSKEY_ALREADY_ON_DEVICE_MESSAGE);
      return;
    }
    if (result.code === 'mfa_required') setNeedsCode(true);
    else if (result.message) setError(result.message);
  };

  const onRemove = async (id: string) => {
    clearMessages();
    setConfirmingId(null);
    if (stepUpRequired) {
      setNeedsCode(true);
      return;
    }
    setIsPending(true);
    const result = await removePasskeyDevice(id);
    setIsPending(false);
    if (result.ok) {
      setDevices((current) => current.filter((device) => device.id !== id));
      setNotice(result.othersSignedOut
        ? 'Urządzenie usunięte. Wylogowaliśmy pozostałe urządzenia.'
        : 'Urządzenie usunięte, ale nie udało się wylogować pozostałych urządzeń. Wyloguj się na nich ręcznie albo zmień hasło.');
      return;
    }
    if (result.code === 'mfa_required') setNeedsCode(true);
    else setError(result.message ?? passkeyServerMessage(result.code, 'registration'));
  };

  return (
    <div className="flex flex-col gap-4">
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>Logowanie biometrią</FieldLabel>
          <FieldDescription>
            {supported
              ? 'Zaloguj się odciskiem palca, twarzą albo blokadą ekranu, bez hasła i kodu. Dane biometryczne zostają na Twoim urządzeniu.'
              : 'Ta przeglądarka nie obsługuje logowania biometrią. Otwórz FaktWay na urządzeniu z odciskiem palca lub rozpoznawaniem twarzy.'}
          </FieldDescription>
        </FieldContent>
        {supported && (
          <div>
            <Button type="button" variant="outline" className="min-h-[44px]" disabled={isPending} onClick={onAdd}>
              {isPending ? 'Potwierdź na urządzeniu...' : 'Dodaj urządzenie'}
            </Button>
          </div>
        )}
      </Field>

      {needsCode && (
        <MfaStepUpNotice returnTo={RETURN_TO}>
          Dodawanie i usuwanie urządzeń wymaga kodu z aplikacji. Po potwierdzeniu wrócisz tutaj.
        </MfaStepUpNotice>
      )}
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      {notice && (
        <Alert role="status" className="border-none bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400">
          <AlertDescription className="text-green-800 dark:text-green-400/80">{notice}</AlertDescription>
        </Alert>
      )}
      {loadFailed && <p role="alert" className="text-destructive text-xs">Nie udało się wczytać listy urządzeń. Odśwież stronę.</p>}

      {devices.length > 0 && (
        <ul className="divide-border flex flex-col divide-y border">
          {devices.map((device) => (
            <li key={device.id} data-testid="passkey-device" className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium break-words">{device.deviceLabel}</span>
                <span className="text-muted-foreground text-xs">
                  {device.lastUsedAt
                    ? `Ostatnio użyte: ${formatWarsawDateTime(device.lastUsedAt)}`
                    : 'Jeszcze nieużywane'}
                  {' · '}Dodane: {formatWarsawDateTime(device.createdAt)}
                </span>
              </div>
              {confirmingId === device.id ? (
                <div className="flex flex-col gap-2 sm:items-end">
                  <p className="text-muted-foreground text-xs">Wylogujemy też pozostałe urządzenia.</p>
                  <div className="flex gap-2">
                    <Button type="button" variant="destructive" className="min-h-[44px]" disabled={isPending} onClick={() => onRemove(device.id)}>
                      Tak, usuń
                    </Button>
                    <Button type="button" variant="outline" className="min-h-[44px]" disabled={isPending} onClick={() => setConfirmingId(null)}>
                      Anuluj
                    </Button>
                  </div>
                </div>
              ) : (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-[44px]"
                    disabled={isPending}
                    aria-label={`Usuń ${device.deviceLabel}`}
                    onClick={() => { clearMessages(); setConfirmingId(device.id); }}
                  >
                    Usuń
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
