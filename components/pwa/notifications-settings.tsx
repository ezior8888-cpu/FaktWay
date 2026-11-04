'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  RiComputerLine,
  RiDeleteBinLine,
  RiLoader4Line,
  RiSmartphoneLine,
  RiTabletLine,
} from '@remixicon/react';
import { toast } from 'sonner';

import {
  unsubscribePushAction,
  updatePushPreferencesAction,
} from '@/app/actions/push-subscriptions';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { formatSettingsDate } from '@/components/settings/finora/format-date';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePushNotifications } from '@/hooks/use-push-notifications';
import type { Tables } from '@/types/database';

/**
 * Powiadomienia push. Wygląd z Finory: stan na tym urządzeniu jak wiersz
 * `security/two-factor-card.tsx` (opis po lewej, przycisk po prawej), lista
 * urządzeń jak `security/sessions-card.tsx` (ramka `border p-3`, ikona
 * urządzenia w `bg-muted`), a rodzaje powiadomień jak przełączniki
 * `notifications/quiet-hours-card.tsx`.
 */

type PushSubscription = Tables<'push_subscriptions'>;

const NOTIFICATION_TYPES = [
  {
    key: 'notify_invoice_accepted' as const,
    label: 'Faktura zaakceptowana',
    desc: 'Gdy KSeF zaakceptuje fakturę',
  },
  {
    key: 'notify_invoice_rejected' as const,
    label: 'Faktura odrzucona',
    desc: 'Gdy KSeF odrzuci fakturę z powodu błędu',
  },
  {
    key: 'notify_payment_received' as const,
    label: 'Otrzymana płatność',
    desc: 'Gdy klient zapłaci za fakturę',
  },
  {
    key: 'notify_cert_expiry' as const,
    label: 'Wygasanie certyfikatu',
    desc: 'Na 30 i 7 dni przed wygaśnięciem certyfikatu KSeF',
  },
  {
    key: 'notify_inbox_new' as const,
    label: 'Nowa faktura zakupowa',
    desc: 'Gdy ktoś wystawi fakturę na Twój NIP (może być spam)',
  },
] as const;

interface Props {
  subscriptions: PushSubscription[];
}

export function NotificationsSettings({ subscriptions }: Props) {
  const router = useRouter();
  const {
    isSupported,
    permission,
    isSubscribed,
    isLoading,
    subscribe,
    unsubscribe,
  } = usePushNotifications();

  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>
            {!isSupported
              ? 'Twoja przeglądarka nie wspiera powiadomień'
              : isSubscribed
                ? 'Powiadomienia włączone na tym urządzeniu'
                : 'Powiadomienia wyłączone na tym urządzeniu'}
          </FieldLabel>
          <FieldDescription>
            {!isSupported
              ? 'Spróbuj Chrome, Edge lub Safari 16.4+'
              : permission === 'denied'
                ? 'Powiadomienia są zablokowane w ustawieniach przeglądarki'
                : isSubscribed
                  ? 'Otrzymasz alerty nawet gdy apka jest zamknięta'
                  : 'Włącz aby dostawać alerty na telefon'}
          </FieldDescription>
        </FieldContent>
        {isSupported && permission !== 'denied' && (
          <div className="flex items-center gap-3">
            {isSubscribed ? (
              <Badge className="bg-green-600/10 text-green-600 dark:bg-green-400/10 dark:text-green-400">
                Włączone
              </Badge>
            ) : null}
            <Button
              variant={isSubscribed ? 'outline' : 'default'}
              type="button"
              onClick={isSubscribed ? unsubscribe : subscribe}
              disabled={isLoading}
            >
              {isLoading && <RiLoader4Line className="animate-spin" aria-hidden />}
              {isSubscribed ? 'Wyłącz' : 'Włącz powiadomienia'}
            </Button>
          </div>
        )}
      </Field>

      {subscriptions.length > 0 && (
        <div className="flex flex-col gap-4">
          <div>
            <FieldLabel>Twoje urządzenia ({subscriptions.length})</FieldLabel>
            <FieldDescription>Każde urządzenie ma własne preferencje powiadomień</FieldDescription>
          </div>

          <div className="flex flex-col gap-3">
            {subscriptions.map((sub) => (
              <DeviceRow
                key={sub.id}
                subscription={sub}
                onUpdate={() => router.refresh()}
              />
            ))}
          </div>
        </div>
      )}
    </FieldGroup>
  );
}

function DeviceRow({
  subscription,
  onUpdate,
}: {
  subscription: PushSubscription;
  onUpdate: () => void;
}) {
  const [isUpdating, startUpdate] = useTransition();
  const [isRemoving, startRemove] = useTransition();

  const DeviceIcon =
    subscription.device_type === 'mobile'
      ? RiSmartphoneLine
      : subscription.device_type === 'tablet'
        ? RiTabletLine
        : RiComputerLine;

  const togglePref = (
    key: (typeof NOTIFICATION_TYPES)[number]['key'],
    current: boolean,
  ) => {
    startUpdate(async () => {
      await updatePushPreferencesAction(subscription.id, { [key]: !current });
      onUpdate();
    });
  };

  const remove = () => {
    if (!confirm('Wyłączyć powiadomienia na tym urządzeniu?')) return;
    startRemove(async () => {
      await unsubscribePushAction(subscription.endpoint);
      onUpdate();
      toast.success('Urządzenie usunięte');
    });
  };

  return (
    <div className="flex flex-col gap-3 border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="bg-muted flex size-10 shrink-0 items-center justify-center">
            <DeviceIcon className="text-muted-foreground size-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {subscription.device_name ?? 'Urządzenie'}
            </p>
            <p className="text-muted-foreground text-xs">
              Dodane{' '}
              {formatSettingsDate(subscription.created_at)}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          onClick={remove}
          disabled={isRemoving}
          aria-label="Usuń urządzenie"
        >
          {isRemoving ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiDeleteBinLine aria-hidden />}
        </Button>
      </div>

      <FieldGroup className="gap-3 border-t pt-3">
        {NOTIFICATION_TYPES.map((type) => {
          const enabled = subscription[type.key];
          const id = `push-${subscription.id}-${type.key}`;
          return (
            <Field key={type.key} orientation="horizontal" className="items-center!">
              <FieldContent>
                <FieldLabel htmlFor={id}>{type.label}</FieldLabel>
                <FieldDescription>{type.desc}</FieldDescription>
              </FieldContent>
              <Switch
                id={id}
                checked={enabled}
                disabled={isUpdating}
                onCheckedChange={() => togglePref(type.key, enabled)}
              />
            </Field>
          );
        })}
      </FieldGroup>
    </div>
  );
}
