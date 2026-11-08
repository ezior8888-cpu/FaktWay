'use client';

import Script from 'next/script';
import { useCallback, useEffect, useRef } from 'react';

/**
 * Widget Cloudflare Turnstile dla formularzy auth.
 *
 * Rysowany jawnie (`render=explicit`), nie przez `class="cf-turnstile"`.
 * Tryb automatyczny szuka widżetów tylko raz, przy pierwszym wczytaniu
 * skryptu, a Next.js zmienia strony bez przeładowania: po przejściu
 * z rejestracji na logowanie formularz zostawał bez widżetu, a po błędnym
 * haśle ze zużytym tokenem (token działa tylko raz). Zgłoszenie Bartosza
 * z 25.10.2026, test: `tests/unit/turnstile-widget.test.tsx`.
 *
 * `interaction-only`: zwykły użytkownik nic nie widzi, okienko pokazuje się
 * tylko wtedy, gdy Cloudflare chce dodatkowego potwierdzenia.
 */

type TurnstileAction = 'login' | 'register' | 'forgot-password' | 'reauth';
type TurnstileTheme = 'light' | 'dark' | 'auto';

interface TurnstileRenderOptions {
  sitekey: string;
  action?: TurnstileAction;
  theme?: TurnstileTheme;
  size?: 'normal' | 'flexible' | 'compact';
  appearance?: 'always' | 'execute' | 'interaction-only';
  callback?: (token: string) => void;
  'error-callback'?: () => boolean | void;
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string | null | undefined;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
  getResponse: (widgetId: string) => string | undefined;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const REFRESH_EVENT = 'faktway:turnstile-refresh';

/**
 * Nowy token po akcji wysłanej poza zdarzeniem `submit` (np. przycisk
 * „Wyślij kod” w zmianie hasła). Wołać zaraz po odczytaniu tokenu z formularza.
 */
export function refreshTurnstileToken(form: HTMLFormElement | null) {
  form?.dispatchEvent(new Event(REFRESH_EVENT));
}

export function TurnstileWidget({
  action,
  theme = 'light',
}: {
  action?: TurnstileAction;
  theme?: TurnstileTheme;
}) {
  // Lokalnie nie renderujemy widżetu: na localhost Cloudflare często nie
  // potrafi dokończyć weryfikacji i formularz zostaje bez tokenu, przez co
  // nie da się zalogować. Dwa warunki naraz, żeby nie mogło to zadziałać
  // na produkcji: build produkcyjny ma `NODE_ENV=production`, a wdrożenie
  // dodatkowo oznaczone jest markerem środowiska.
  const lokalnie =
    process.env.NODE_ENV === 'development' &&
    process.env.NEXT_PUBLIC_APP_ENV !== 'production';
  if (lokalnie) return null;

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  if (!siteKey || siteKey.includes('xxx')) return null;

  return <ExplicitTurnstile siteKey={siteKey} action={action} theme={theme} />;
}

function ExplicitTurnstile({
  siteKey,
  action,
  theme,
}: {
  siteKey: string;
  action?: TurnstileAction;
  theme: TurnstileTheme;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Wysyłka przed gotowym tokenem czeka i rusza sama po `callback`.
  const pendingSubmitRef = useRef<HTMLFormElement | null>(null);
  // Po błędzie widżetu nie blokujemy formularza: serwer odmówi i pokaże
  // komunikat z tym, co zrobić.
  const failedRef = useRef(false);

  const releasePendingSubmit = useCallback(() => {
    const form = pendingSubmitRef.current;
    pendingSubmitRef.current = null;
    form?.requestSubmit();
  }, []);

  const renderWidget = useCallback(() => {
    const container = containerRef.current;
    const turnstile = window.turnstile;
    if (!container || !turnstile || widgetIdRef.current !== null) return;
    failedRef.current = false;
    widgetIdRef.current = turnstile.render(container, {
      sitekey: siteKey,
      action,
      theme,
      size: 'flexible',
      appearance: 'interaction-only',
      callback: () => {
        failedRef.current = false;
        releasePendingSubmit();
      },
      'error-callback': () => {
        failedRef.current = true;
        releasePendingSubmit();
      },
    }) ?? null;
  }, [siteKey, action, theme, releasePendingSubmit]);

  useEffect(() => {
    renderWidget();
    return () => {
      const widgetId = widgetIdRef.current;
      widgetIdRef.current = null;
      pendingSubmitRef.current = null;
      if (widgetId !== null) window.turnstile?.remove(widgetId);
    };
  }, [renderWidget]);

  useEffect(() => {
    const form = containerRef.current?.closest('form');
    if (!form) return;
    const onSubmit = (event: Event) => {
      const widgetId = widgetIdRef.current;
      const turnstile = window.turnstile;
      if (widgetId === null || !turnstile || failedRef.current) return;
      if (!turnstile.getResponse(widgetId)) {
        event.preventDefault();
        pendingSubmitRef.current = form;
        return;
      }
      // React czyta FormData w tym samym zdarzeniu, więc token już poszedł.
      // Nowy bierzemy po nim, na następną próbę (np. po błędnym haśle).
      setTimeout(() => {
        if (widgetIdRef.current === widgetId) window.turnstile?.reset(widgetId);
      }, 0);
    };
    const onRefresh = () => {
      const widgetId = widgetIdRef.current;
      if (widgetId !== null) window.turnstile?.reset(widgetId);
    };
    form.addEventListener('submit', onSubmit);
    form.addEventListener(REFRESH_EVENT, onRefresh);
    return () => {
      form.removeEventListener('submit', onSubmit);
      form.removeEventListener(REFRESH_EVENT, onRefresh);
    };
  }, []);

  return (
    <>
      <Script src={SCRIPT_SRC} strategy="afterInteractive" onReady={renderWidget} />
      <div ref={containerRef} className="flex justify-center empty:hidden" />
    </>
  );
}
