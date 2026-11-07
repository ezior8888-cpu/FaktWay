// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Przełącznik push „Księgowość” (plan księgowości JDG, K5, 00169): widzi go
 * tylko firma w pilotażu; brak kolumny w wierszu (przed 00169) znaczy
 * „włączone”, tak jak domyślna wartość w bazie.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/actions/push-subscriptions', () => ({ updatePushPreferencesAction: vi.fn(), unsubscribePushAction: vi.fn() }));
vi.mock('@/hooks/use-push-notifications', () => ({
  usePushNotifications: () => ({ isSupported: true, permission: 'granted', isSubscribed: true, isLoading: false, subscribe: vi.fn(), unsubscribe: vi.fn() }),
}));

const { NotificationsSettings } = await import('@/components/pwa/notifications-settings');

const subskrypcja = {
  id: 's1',
  endpoint: 'https://fcm.googleapis.com/fcm/send/x',
  device_type: 'mobile',
  device_name: 'Telefon',
  created_at: '2026-11-01T10:00:00Z',
  notify_invoice_accepted: true,
  notify_invoice_rejected: true,
  notify_payment_received: true,
  notify_cert_expiry: true,
  notify_inbox_new: false,
} as never;

/** Stan przełącznika po id: Switch daje `aria-checked`, `data-checked` albo ukryte pole wyboru. */
function wlaczony(html: string, id: string): boolean | null {
  const div = document.createElement('div');
  div.innerHTML = html;
  const el = div.querySelector(`#${id}`);
  if (!el) return null;
  if (el.hasAttribute('aria-checked')) return el.getAttribute('aria-checked') === 'true';
  if (el instanceof HTMLInputElement) return el.checked;
  return el.hasAttribute('data-checked');
}

describe('ustawienia push', () => {
  it('firma w pilotażu: przełącznik „Księgowość”, domyślnie włączony; poza pilotażem go nie ma', () => {
    const wPilotazu = renderToStaticMarkup(<NotificationsSettings subscriptions={[subskrypcja]} ksiegowosc />);
    expect(wPilotazu).toContain('Księgowość');
    expect(wlaczony(wPilotazu, 'push-s1-notify_ksiegowosc')).toBe(true);
    expect(renderToStaticMarkup(<NotificationsSettings subscriptions={[subskrypcja]} />)).not.toContain('Księgowość');
  });

  it('wyłączona zgoda zostaje wyłączona, a pozostałe przełączniki działają jak dotąd', () => {
    const html = renderToStaticMarkup(
      <NotificationsSettings subscriptions={[{ ...(subskrypcja as object), notify_ksiegowosc: false } as never]} ksiegowosc />,
    );
    expect(wlaczony(html, 'push-s1-notify_ksiegowosc')).toBe(false);
    expect(wlaczony(html, 'push-s1-notify_inbox_new')).toBe(false);
    expect(wlaczony(html, 'push-s1-notify_cert_expiry')).toBe(true);
  });
});
