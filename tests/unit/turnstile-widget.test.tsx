// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Turnstile na formularzach logowania (zgłoszenie Bartosza 25.10.2026:
 * „znaczek nawet się nie ładuje i trzeba odświeżać, jest brzydki”).
 *
 * Tryb automatyczny (`class="cf-turnstile"`) szuka widżetów tylko raz, przy
 * pierwszym wczytaniu skryptu. Next.js zmienia strony bez przeładowania, więc
 * po przejściu z rejestracji na logowanie formularz zostawał bez widżetu,
 * a po błędnym haśle ze zużytym tokenem. Oba przypadki kończyły się
 * „Nie udało się potwierdzić, że nie jesteś botem”.
 *
 * Widżet jest teraz rysowany jawnie (`turnstile.render`) przy każdym wejściu
 * na stronę, niewidoczny dla zwykłego użytkownika (`interaction-only`),
 * a po każdej wysyłce pobiera nowy token.
 */

const script = vi.hoisted(() => ({ src: '', onReady: undefined as undefined | (() => void) }));
vi.mock('next/script', () => ({
  default: (props: { src: string; onReady?: () => void }) => {
    script.src = props.src;
    script.onReady = props.onReady;
    return null;
  },
}));

const { TurnstileWidget, refreshTurnstileToken } = await import('@/components/auth/turnstile-widget');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RenderOptions = {
  sitekey: string;
  action?: string;
  theme?: string;
  appearance?: string;
  callback?: (token: string) => void;
  'error-callback'?: () => boolean | void;
};

function fakeTurnstile() {
  const widgets = new Map<string, { opts: RenderOptions; input: HTMLInputElement }>();
  let next = 0;
  return {
    render: vi.fn((el: HTMLElement, opts: RenderOptions) => {
      const id = `w${++next}`;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'cf-turnstile-response';
      el.append(input);
      widgets.set(id, { opts, input });
      return id;
    }),
    reset: vi.fn((id: string) => {
      const widget = widgets.get(id);
      if (widget) widget.input.value = '';
    }),
    remove: vi.fn((id: string) => {
      widgets.get(id)?.input.remove();
      widgets.delete(id);
    }),
    getResponse: vi.fn((id: string) => widgets.get(id)?.input.value || undefined),
    solve(id: string, token: string) {
      const widget = widgets.get(id)!;
      widget.input.value = token;
      widget.opts.callback?.(token);
    },
    fail(id: string) {
      widgets.get(id)!.opts['error-callback']?.();
    },
  };
}

type FakeTurnstile = ReturnType<typeof fakeTurnstile>;

let form: HTMLFormElement;
let root: Root;
let turnstile: FakeTurnstile;

function mount() {
  act(() => root.render(<TurnstileWidget action='login' theme='light' />));
}

function setTurnstile(api: FakeTurnstile | undefined) {
  (window as { turnstile?: FakeTurnstile }).turnstile = api;
}

function submit() {
  const event = new Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '0x4AAAAAAAfixture-site-key');
  script.src = '';
  script.onReady = undefined;
  turnstile = fakeTurnstile();
  form = document.createElement('form');
  document.body.append(form);
  root = createRoot(form);
});

afterEach(() => {
  act(() => root.unmount());
  form.remove();
  setTurnstile(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('TurnstileWidget', () => {
  it('rysuje widżet, gdy skrypt jest już wczytany (wejście bez przeładowania strony)', () => {
    setTurnstile(turnstile);
    mount();

    expect(script.src).toContain('render=explicit');
    expect(turnstile.render).toHaveBeenCalledTimes(1);
    const [container, options] = turnstile.render.mock.calls[0]!;
    expect(form.contains(container)).toBe(true);
    expect(options).toMatchObject({
      sitekey: '0x4AAAAAAAfixture-site-key',
      action: 'login',
      theme: 'light',
      appearance: 'interaction-only',
    });
  });

  it('rysuje widżet raz, gdy skrypt dojdzie później', () => {
    mount();
    expect(turnstile.render).not.toHaveBeenCalled();

    setTurnstile(turnstile);
    act(() => script.onReady?.());
    act(() => script.onReady?.());

    expect(turnstile.render).toHaveBeenCalledTimes(1);
  });

  it('usuwa widżet przy wyjściu ze strony', () => {
    setTurnstile(turnstile);
    mount();
    act(() => root.unmount());
    root = createRoot(form);

    expect(turnstile.remove).toHaveBeenCalledWith('w1');
  });

  it('wysyłka dostaje token, a widżet zaraz potem bierze nowy (token działa tylko raz)', async () => {
    setTurnstile(turnstile);
    mount();
    turnstile.solve('w1', 'token-1');

    let sent: FormDataEntryValue | null = null;
    // React czyta FormData w słuchaczu na korzeniu, czyli po słuchaczu formularza.
    const reactRoot = (event: Event) => {
      sent = new FormData(form).get('cf-turnstile-response');
      event.preventDefault();
    };
    document.addEventListener('submit', reactRoot);
    const event = submit();
    document.removeEventListener('submit', reactRoot);

    expect(sent).toBe('token-1');
    expect(event.defaultPrevented).toBe(true);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(turnstile.reset).toHaveBeenCalledWith('w1');
  });

  it('zbyt szybka wysyłka czeka na token i wysyła formularz sama', () => {
    setTurnstile(turnstile);
    mount();
    const requestSubmit = vi.spyOn(form, 'requestSubmit').mockImplementation(() => undefined);

    expect(submit().defaultPrevented).toBe(true);
    expect(requestSubmit).not.toHaveBeenCalled();

    act(() => turnstile.solve('w1', 'token-1'));
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  it('błąd widżetu nie blokuje formularza, serwer pokaże komunikat', () => {
    setTurnstile(turnstile);
    mount();
    const requestSubmit = vi.spyOn(form, 'requestSubmit').mockImplementation(() => undefined);

    expect(submit().defaultPrevented).toBe(true);
    act(() => turnstile.fail('w1'));

    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(submit().defaultPrevented).toBe(false);
  });

  it('na żądanie bierze nowy token (akcja wysłana przyciskiem, nie przez submit)', () => {
    setTurnstile(turnstile);
    mount();
    turnstile.solve('w1', 'token-1');

    refreshTurnstileToken(form);

    expect(turnstile.reset).toHaveBeenCalledWith('w1');
  });

  it('bez wczytanego skryptu (np. zablokowany) nie blokuje wysyłki', () => {
    mount();
    expect(submit().defaultPrevented).toBe(false);
  });
});
