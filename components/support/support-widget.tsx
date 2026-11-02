'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  HelpCircle,
  MessageCircle,
  Send,
  ThumbsDown,
  ThumbsUp,
  UserRound,
  Video,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePortalContainer } from '@/components/ui/portal-container';
import { cn } from '@/lib/utils';
import { ANALYTICS_EVENTS, track } from '@/lib/analytics/client';
import { SUPPORT_EMAIL } from '@/lib/site';
import { getContextualArticleSlugs } from '@/lib/support/contextual-help';
import { OTWORZ_POMOC } from '@/lib/support/open-support-event';
import { parseMeta, stripMetaLine } from '@/lib/support/meta';
import {
  escalateConversationAction,
  submitCsatAction,
} from '@/lib/support/support-actions';

/**
 * Floating AI support widget — dostępny w całym panelu (dashboard).
 *
 * Stan welcome (brak wiadomości): intro + przykładowe pytania + sekcja
 * "Wideo poradniki" (placeholdery — user nagra 5 tutoriali przed launchem,
 * Fazy 41-43) + link do pełnego centrum pomocy.
 *
 * Chat: streaming odpowiedzi z `/api/support/chat`. Cytowania KB pokazujemy
 * jako klikalne chipsy prowadzące do `/pomoc/<slug>`.
 *
 * FaktWay 1.0, decyzja 3: czat to podpowiedź z bazy wiedzy, oznaczona jako
 * automat (art. 50 ust. 1 AI Act), z przejściem do człowieka. `ContactHuman`
 * stoi pod rozmową cały czas, bo eskalacja wymaga rozmowy i działającej akcji
 * serwera: przy błędzie czatu klient nie zostaje bez drogi.
 */

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  uncertain?: boolean;
  citations?: string[];
}

const SAMPLE_QUESTIONS = [
  'Jak wystawić pierwszą fakturę?',
  'Co zrobić, gdy KSeF jest niedostępny?',
  'Jak zaimportować dane z Fakturowni?',
  'Jak włączyć weryfikację dwuetapową?',
];

// 5 tutoriali — user nagra je przed launchem (Fazy 41-43). Do tego czasu
// karty są w stanie "Wkrótce". Po nagraniu wystarczy podmienić `href`.
const VIDEO_TUTORIALS = [
  'Pierwsze 5 minut w FaktWay',
  'Skanowanie paragonu (OCR)',
  'Pierwsza faktura do KSeF',
  'Eksport KPiR dla księgowego',
  'Import z Fakturowni',
];

export function SupportWidget({
  articleTitles,
}: {
  /** Mapa slug → tytuł artykułu KB — do ładnych chipsów cytowań. */
  articleTitles: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);

  // Otwarcie z zewnątrz — dolna nawigacja („Więcej” → „Pomoc”) na telefonie,
  // gdzie pływający bąbelek jest ukryty. Zdarzenie zamiast kontekstu, bo
  // widget siedzi w layoucie, a nawigacja to zupełnie inne poddrzewo.
  useEffect(() => {
    const otworz = () => setOpen(true);
    window.addEventListener(OTWORZ_POMOC, otworz);
    return () => window.removeEventListener(OTWORZ_POMOC, otworz);
  }, []);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [csatGiven, setCsatGiven] = useState<boolean | null>(null);
  const [escalation, setEscalation] = useState<'idle' | 'done' | 'failed'>('idle');
  const [, startAction] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const [portalReady, setPortalReady] = useState(false);
  const kontener = usePortalContainer();

  useLayoutEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    // Pierwsza wiadomość w sesji widgetu = start konwersacji support.
    if (!conversationId) {
      track(ANALYTICS_EVENTS.supportChatStarted);
    }
    setInput('');
    setMessages((m) => [
      ...m,
      { role: 'user', content: trimmed },
      { role: 'assistant', content: '', streaming: true },
    ]);
    setIsStreaming(true);

    const patchLast = (patch: Partial<ChatMessage>) =>
      setMessages((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          next[next.length - 1] = { ...last, ...patch };
        }
        return next;
      });

    try {
      const res = await fetch('/api/support/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversationId ?? undefined,
          message: trimmed,
        }),
      });

      if (res.status === 429) {
        patchLast({
          content:
            'Za dużo wiadomości w krótkim czasie. Poczekaj chwilę i spróbuj ponownie.',
          streaming: false,
        });
        return;
      }
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const cid = res.headers.get('X-Conversation-Id');
      if (cid) setConversationId(cid);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        patchLast({ content: stripMetaLine(acc), streaming: true });
      }

      const meta = parseMeta(acc);
      patchLast({
        content: meta.cleanText,
        streaming: false,
        uncertain: meta.uncertain,
        citations: meta.articles,
      });
    } catch {
      patchLast({
        content:
          'Przepraszam, wystąpił błąd połączenia. Spróbuj ponownie za chwilę.',
        streaming: false,
      });
    } finally {
      setIsStreaming(false);
    }
  }

  const hasAiReply = messages.some(
    (m) => m.role === 'assistant' && !m.streaming && m.content.length > 0,
  );

  const shell = (
    <>
      {/* Floating button — portal do kontenera portali panelu (body bez providera) + z nad banerem zgody (z-[60]),
          żeby `fixed` nie był wycinany przez stacking / layout dashboardu
          (localhost z PostHog vs prod bez klucza). */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Otwórz pomoc"
          /* Warstwa 45: nad treścią i nad dolną nawigacją (40), ale POD
             arkuszami i oknami dialogowymi (50). Przy z-70 bąbelek
             pływał nad otwartym arkuszem „Więcej" i zasłaniał w nim
             przełącznik motywu. */
          /* `hidden lg:flex` — na telefonie bąbelek NIE PŁYWA. Każdy formularz
             w panelu ma przyklejony pasek akcji przy dolnej krawędzi, a koło
             56 px w prawym dolnym rogu siadało dokładnie na przycisku
             „Zapisz”. Wejście do pomocy jest zamiast tego w arkuszu „Więcej”
             i otwiera ten sam panel przez zdarzenie `OTWORZ_POMOC`. */
          className="fixed bottom-[calc(1.25rem+var(--ff-bottom-nav-h)+var(--ff-safe-b))] right-5 z-[45] hidden h-14 w-14 items-center justify-center rounded-full bg-foreground text-background shadow-lg transition-transform hover:scale-105 lg:flex"
        >
          <MessageCircle className="h-6 w-6" />
        </button>
      )}

      {/* Panel */}
      {open && (
        <div className="fixed bottom-[calc(1.25rem+var(--ff-bottom-nav-h)+var(--ff-safe-b))] right-5 z-[45] flex h-[600px] max-h-[calc(100dvh-2.5rem-var(--ff-bottom-nav-h)-var(--ff-safe-b))] w-[380px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-3xl border border-glass-border bg-glass-white shadow-2xl backdrop-blur-glass-lg">
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-glass-border px-4 py-3">
            <div className="flex items-center gap-2">
              <HelpCircle className="h-5 w-5 text-muted-foreground" />
              <span className="font-medium">Pomoc FaktWay</span>
              {/* Art. 50 ust. 1 AI Act (od 2.08.2026): rozmówca ma wiedzieć,
                  że pisze z systemem AI — widoczne przez całą rozmowę. */}
              <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Odpowiada automat (AI)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Zamknij pomoc"
              className="rounded-full p-1.5 transition-colors hover:bg-foreground/10"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div
            ref={scrollRef}
            className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
          >
            {messages.length === 0 ? (
              <WelcomeState
                onPick={(q) => void send(q)}
                contextualSlugs={getContextualArticleSlugs(pathname)}
                articleTitles={articleTitles}
              />
            ) : (
              messages.map((m, i) => (
                <MessageBubble
                  key={i}
                  message={m}
                  articleTitles={articleTitles}
                />
              ))
            )}

            {/* CSAT + eskalacja — po pierwszej odpowiedzi AI */}
            {hasAiReply && !isStreaming && conversationId && (
              <ConversationFooter
                escalation={escalation}
                csatGiven={csatGiven}
                onCsat={(positive) => {
                  setCsatGiven(positive);
                  startAction(() => {
                    void submitCsatAction(conversationId, positive);
                  });
                }}
                onEscalate={() => {
                  // „Zgłoszono” dopiero po zapisie: odmowa (np. wygasła sesja)
                  // albo błąd sieci nie może udawać, że ktoś się odezwie.
                  startAction(async () => {
                    const result = await escalateConversationAction(conversationId).catch(() => null);
                    setEscalation(result?.ok ? 'done' : 'failed');
                  });
                }}
              />
            )}
          </div>

          <ContactHuman />

          {/* Input */}
          <form
            className="flex shrink-0 items-end gap-2 border-t border-glass-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              maxLength={2000}
              placeholder="Zadaj pytanie…"
              className="max-h-28 min-h-[40px] flex-1 resize-none rounded-xl border border-glass-border bg-background/50 px-3 py-2 text-sm outline-none focus:border-foreground/30"
            />
            <Button
              type="submit"
              size="icon"
              disabled={isStreaming || input.trim().length === 0}
              aria-label="Wyślij"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      )}
    </>
  );

  if (!portalReady || typeof document === 'undefined') {
    return null;
  }

  // Ten sam kontener co okna i menu Base UI (wewnątrz `.ff-dashboard`, plan
  // Finora E2) — inaczej bąbelek maluje się nad oknami, arkuszami i ⌘K.
  // undefined = brak providera (body); null = kontener jeszcze się montuje.
  const target = kontener === undefined ? document.body : kontener;
  if (target === null) {
    return null;
  }

  return createPortal(shell, target);
}

/** Droga do człowieka widoczna przez całą rozmowę, także gdy sam czat nie działa. */
function ContactHuman() {
  return (
    <p className="shrink-0 border-t border-glass-border px-4 py-2 text-xs text-muted-foreground">
      Wolisz człowieka? Napisz:{' '}
      <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-2 hover:text-foreground">
        {SUPPORT_EMAIL}
      </a>
    </p>
  );
}

function WelcomeState({
  onPick,
  contextualSlugs,
  articleTitles,
}: {
  onPick: (q: string) => void;
  contextualSlugs: string[];
  articleTitles: Record<string, string>;
}) {
  const contextual = contextualSlugs.filter((s) => articleTitles[s]);

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm">
          Cześć! Odpowiada automat (AI), nie człowiek. Podpowiadam na podstawie
          centrum pomocy FaktWay: KSeF, faktury, koszty ze zdjęcia i abonament.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Moje odpowiedzi mogą zawierać błędy i nie są poradą podatkową ani
          prawną. W każdej chwili możesz napisać do człowieka, adres jest pod
          rozmową. Treść rozmowy przetwarza dostawca AI (Anthropic):{' '}
          <Link href="/legal/polityka-prywatnosci#cele" target="_blank" className="underline underline-offset-2">
            szczegóły
          </Link>
          .
        </p>
      </div>

      {/* Pomoc do tej strony — kontekstowa (Krok 8) */}
      {contextual.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Pomoc do tej strony
          </p>
          {contextual.map((slug) => (
            <Link
              key={slug}
              href={`/pomoc/${slug}`}
              target="_blank"
              className="flex items-center gap-2 rounded-xl border border-glass-border bg-background/40 px-3 py-2 text-sm transition-colors hover:bg-foreground/5"
            >
              <HelpCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>{articleTitles[slug]}</span>
            </Link>
          ))}
        </div>
      )}

      {/* Przykładowe pytania */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Przykładowe pytania
        </p>
        {SAMPLE_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onPick(q)}
            className="block w-full rounded-xl border border-glass-border bg-background/40 px-3 py-2 text-left text-sm transition-colors hover:bg-foreground/5"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Wideo poradniki — placeholdery (user nagra przed launchem) */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Wideo poradniki
        </p>
        {VIDEO_TUTORIALS.map((title) => (
          <div
            key={title}
            className="flex items-center gap-2 rounded-xl border border-glass-border bg-background/20 px-3 py-2 text-sm text-muted-foreground"
          >
            <Video className="h-4 w-4 shrink-0" />
            <span className="flex-1">{title}</span>
            <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] uppercase tracking-wide">
              Wkrótce
            </span>
          </div>
        ))}
      </div>

      <Link
        href="/pomoc"
        className="block text-center text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Przejdź do pełnego centrum pomocy
      </Link>
    </div>
  );
}

function ConversationFooter({
  escalation,
  csatGiven,
  onCsat,
  onEscalate,
}: {
  escalation: 'idle' | 'done' | 'failed';
  csatGiven: boolean | null;
  onCsat: (positive: boolean) => void;
  onEscalate: () => void;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-glass-border bg-background/30 px-3 py-2.5">
      {csatGiven === null ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Czy to pomogło?</span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => onCsat(true)}
              aria-label="Tak, pomogło"
              className="rounded-lg p-1.5 transition-colors hover:bg-foreground/10"
            >
              <ThumbsUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onCsat(false)}
              aria-label="Nie pomogło"
              className="rounded-lg p-1.5 transition-colors hover:bg-foreground/10"
            >
              <ThumbsDown className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Dziękujemy za ocenę.
        </p>
      )}

      {escalation === 'done' ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <UserRound className="h-3.5 w-3.5" />
          Zgłoszono do zespołu. Odezwiemy się mailem.
        </p>
      ) : escalation === 'failed' ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <UserRound className="h-3.5 w-3.5 shrink-0" />
          Nie udało się zgłosić rozmowy. Napisz do nas na adres poniżej.
        </p>
      ) : (
        <button
          type="button"
          onClick={onEscalate}
          className="flex items-center gap-1.5 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          <UserRound className="h-3.5 w-3.5" />
          Połącz z człowiekiem
        </button>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  articleTitles,
}: {
  message: ChatMessage;
  articleTitles: Record<string, string>;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm',
          isUser
            ? 'bg-foreground text-background'
            : 'border border-glass-border bg-background/40',
        )}
      >
        {message.content ? (
          <p className="whitespace-pre-wrap leading-relaxed">
            {message.content}
          </p>
        ) : message.streaming ? (
          <span className="text-muted-foreground">Piszę…</span>
        ) : null}

        {/* Cytowania KB */}
        {!isUser &&
          !message.streaming &&
          message.citations &&
          message.citations.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-glass-border/50 pt-2">
              {message.citations.map((slug) => (
                <Link
                  key={slug}
                  href={`/pomoc/${slug}`}
                  target="_blank"
                  className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs hover:bg-foreground/20"
                >
                  {articleTitles[slug] ?? 'Artykuł pomocy'}
                </Link>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}
