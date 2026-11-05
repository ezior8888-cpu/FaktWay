'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  subscribePushAction,
  unsubscribePushAction,
} from '@/app/actions/push-subscriptions';

/** Konwersja base64url VAPID key → `Uint8Array<ArrayBuffer>` wymaganego przez PushManager. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function detectDeviceType(): 'mobile' | 'tablet' | 'desktop' {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/iPhone|iPod|Android|Mobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

function detectDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Urządzenie';
}

export function usePushNotifications() {
  const [permission, setPermission] =
    useState<NotificationPermission>('default');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const supported =
      'Notification' in window &&
      'serviceWorker' in navigator &&
      'PushManager' in window;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- odczyt API przeglądarki (Notification, serviceWorker) po zamontowaniu; na serwerze ich nie ma
    setIsSupported(supported);

    if (!supported) return;

    setPermission(Notification.permission);

    navigator.serviceWorker.ready
      .then(async (reg) => {
        const sub = await reg.pushManager.getSubscription();
        setIsSubscribed(sub !== null);
      })
      .catch(() => {
        // SW jeszcze nie zarejestrowany (np. dev bez webpack)
      });
  }, []);

  const subscribe = async () => {
    if (!isSupported) {
      toast.error('Twoja przeglądarka nie wspiera powiadomień push');
      return;
    }

    setIsLoading(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        toast.error(
          'Powiadomienia odrzucone. Zmień w ustawieniach przeglądarki.',
        );
        return;
      }

      const reg = await navigator.serviceWorker.ready;

      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapidKey?.trim()) {
        toast.error('VAPID key nie jest skonfigurowany');
        return;
      }

      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });

      const subJson = subscription.toJSON();
      const keys = subJson.keys;
      if (!keys?.p256dh || !keys.auth) {
        toast.error('Błąd odczytu kluczy subskrypcji');
        return;
      }

      const result = await subscribePushAction({
        endpoint: subscription.endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: navigator.userAgent,
        deviceType: detectDeviceType(),
        deviceName: detectDeviceName(),
      });

      if (result.success) {
        setIsSubscribed(true);
        toast.success('Powiadomienia włączone');
      } else {
        toast.error(result.error ?? 'Błąd subskrypcji');
      }
    } catch (err) {
      console.error('Push subscribe error:', err);
      toast.error('Nie udało się włączyć powiadomień');
    } finally {
      setIsLoading(false);
    }
  };

  const unsubscribe = async () => {
    setIsLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        await unsubscribePushAction(sub.endpoint);
      }
      setIsSubscribed(false);
      toast.success('Powiadomienia wyłączone');
    } catch {
      toast.error('Błąd wyłączania powiadomień');
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isSupported,
    permission,
    isSubscribed,
    isLoading,
    subscribe,
    unsubscribe,
  };
}
