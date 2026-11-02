// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SUPPORT_EMAIL } from '@/lib/site';

/**
 * FaktWay 1.0, decyzja 3: czat wsparcia zostaje jako podpowiedź z bazy wiedzy,
 * ale ma być oznaczony jako automatyczny (AI Act, art. 50 ust. 1) i mieć
 * przejście do człowieka. Do tej pory powitanie obiecywało kontakt
 * „w każdej chwili”, a jedyny przycisk pojawiał się dopiero po pierwszej
 * odpowiedzi modelu: przy błędzie czatu klient zostawał bez drogi. Odmowa
 * eskalacji (np. wygasła sesja) i tak kończyła się napisem „Zgłoszono”.
 */

const mocks = vi.hoisted(() => ({
  escalate: vi.fn(),
  csat: vi.fn(async () => ({ ok: true })),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('next/link', () => ({
  default: ({ children, ...p }: { children: React.ReactNode }) => <a {...p}>{children}</a>,
}));
vi.mock('@/lib/support/support-actions', () => ({
  escalateConversationAction: mocks.escalate,
  submitCsatAction: mocks.csat,
}));
vi.mock('@/lib/analytics/client', () => ({
  ANALYTICS_EVENTS: { supportChatStarted: 'x' },
  track: () => {},
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SupportWidget } = await import('@/components/support/support-widget');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.escalate.mockResolvedValue({ ok: true });
  // jsdom nie ma scrollTo na elementach, a widget przewija listę wiadomości.
  Element.prototype.scrollTo = () => {};
});

async function openWidget() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<SupportWidget articleTitles={{}} />));
  await act(async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Otwórz pomoc"]')!.click();
  });
}

const czlowiek = () => document.querySelector<HTMLAnchorElement>(`a[href="mailto:${SUPPORT_EMAIL}"]`);
const tekst = () => document.body.textContent ?? '';

function odpowiedz(conversationId: string) {
  const body = 'Odpowiedź.\n[META] uncertain=false articles= category=other';
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'X-Conversation-Id': conversationId },
  });
}

async function zapytaj() {
  const pole = document.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(pole, 'Jak wystawić fakturę?');
    pole.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  // Odczyt strumienia odpowiedzi kończy się po kilku mikrozadaniach.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function polaczZCzlowiekiem() {
  const przycisk = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Połącz z człowiekiem'),
  );
  expect(przycisk).toBeDefined();
  await act(async () => {
    przycisk!.click();
  });
}

describe('czat wsparcia: oznaczenie i człowiek', () => {
  it('przez całą rozmowę widać, że odpowiada automat (AI)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => odpowiedz('c-1')));
    await openWidget();
    expect(tekst()).toContain('Odpowiada automat (AI)');
    expect(tekst()).toContain('nie człowiek');
    await zapytaj();
    expect(tekst()).toContain('Odpowiada automat (AI)');
  });

  it('adres do człowieka jest od razu, jeszcze przed pierwszym pytaniem', async () => {
    await openWidget();
    expect(czlowiek()).not.toBeNull();
    expect(czlowiek()!.textContent).toContain(SUPPORT_EMAIL);
  });

  it('gdy czat padnie, adres do człowieka dalej jest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await openWidget();
    await zapytaj();
    expect(tekst()).toContain('wystąpił błąd połączenia');
    expect(czlowiek()).not.toBeNull();
  });

  it('po odpowiedzi „Połącz z człowiekiem” potwierdza zgłoszenie dopiero po zapisie', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => odpowiedz('c-1')));
    await openWidget();
    await zapytaj();
    await polaczZCzlowiekiem();
    expect(mocks.escalate).toHaveBeenCalledWith('c-1');
    expect(tekst()).toContain('Zgłoszono do zespołu');
  });

  it('odmowa eskalacji nie udaje zgłoszenia, tylko podaje adres', async () => {
    mocks.escalate.mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', vi.fn(async () => odpowiedz('c-1')));
    await openWidget();
    await zapytaj();
    await polaczZCzlowiekiem();
    expect(tekst()).not.toContain('Zgłoszono do zespołu');
    expect(tekst()).toContain('Nie udało się zgłosić');
    expect(czlowiek()).not.toBeNull();
  });

  it('błąd eskalacji (np. sieć) też kończy się adresem, nie zgłoszeniem', async () => {
    mocks.escalate.mockRejectedValue(new Error('sieć'));
    vi.stubGlobal('fetch', vi.fn(async () => odpowiedz('c-1')));
    await openWidget();
    await zapytaj();
    await polaczZCzlowiekiem();
    expect(tekst()).not.toContain('Zgłoszono do zespołu');
    expect(tekst()).toContain('Nie udało się zgłosić');
  });

  it('w trakcie zgłaszania przycisk jest zablokowany i mówi, co się dzieje, a drugi klik nie woła akcji', async () => {
    let dokoncz: (wynik: { ok: boolean }) => void = () => {};
    mocks.escalate.mockImplementation(
      () => new Promise<{ ok: boolean }>((resolve) => { dokoncz = resolve; }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => odpowiedz('c-1')));
    await openWidget();
    await zapytaj();
    await polaczZCzlowiekiem();

    const trwa = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Zgłaszam'));
    expect(trwa).toBeDefined();
    expect(trwa!.disabled).toBe(true);
    await act(async () => {
      trwa!.click();
    });
    expect(mocks.escalate).toHaveBeenCalledTimes(1);

    await act(async () => {
      dokoncz({ ok: true });
    });
    expect(tekst()).toContain('Zgłoszono do zespołu');
  });

  it('teksty dla klienta bez długich myślników', async () => {
    await openWidget();
    expect(tekst()).not.toMatch(/[—–]/);
  });
});

describe('czat wsparcia: instrukcje modelu', () => {
  it('model nie udaje człowieka, podaje drogę do człowieka i nie zna artykułów o FLO', async () => {
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } };
      },
    }));
    vi.doMock('@/lib/anthropic/client', () => ({ getAnthropic: () => ({ messages: { stream } }) }));
    const { streamSupportReply } = await import('@/lib/support/chat');
    for await (const fragment of streamSupportReply([{ role: 'user', content: 'Czy jesteś człowiekiem?' }])) {
      expect(fragment).toBe('ok');
    }
    const call = (stream.mock.calls as unknown as Array<[{ system: Array<{ text: string }> }]>)[0]![0];
    const [instrukcje, baza] = call.system;
    expect(instrukcje!.text).toContain('automatem');
    expect(instrukcje!.text).toContain('Połącz z człowiekiem');
    expect(instrukcje!.text).toContain(SUPPORT_EMAIL);
    expect(baza!.text).not.toMatch(/slug: flo-/);
    expect(baza!.text).not.toMatch(/\bFlo\b/);
  });
});
