import { getAnthropic } from '@/lib/anthropic/client';
import { SUPPORT_EMAIL } from '@/lib/site';
import { buildKnowledgeBaseContext } from './knowledge-base';
import { META_LINE_PREFIX, UNCERTAIN_PREFIX } from './meta';
import { czyPytanieOPorade, ODPOWIEDZ_PORADA } from './porada-podatkowa';

/**
 * Rdzeń AI support chatu (Faza 30 Krok 5).
 *
 * Model: Haiku (decyzja z planowania — support to Q&A z dostarczonym
 * kontekstem, nie wymaga Sonneta). Konfigurowalny przez env — gdyby nazwa
 * modelu się zmieniła, nie trzeba deployu.
 */
export const SUPPORT_MODEL =
  process.env.ANTHROPIC_SUPPORT_MODEL?.trim() || 'claude-haiku-4-5';

const MAX_TOKENS = 1024;

export interface SupportTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Buduje bloki system prompt. KB jest osobnym blokiem z `cache_control`
 * — Anthropic prompt caching nalicza pełną cenę KB raz na ~5 min,
 * kolejne wywołania w oknie ~10% ceny.
 */
function buildSystemBlocks() {
  const kb = buildKnowledgeBaseContext();

  const instructions = [
    'Jesteś asystentem wsparcia FaktWay — polskiego SaaS do wystawiania',
    'i odbierania faktur VAT przez Krajowy System e-Faktur (KSeF).',
    'Użytkownicy to mikrofirmy, freelancerzy i księgowi.',
    '',
    'ZASADY:',
    '- Odpowiadaj PO POLSKU, zwięźle (zwykle 2-5 zdań), konkretnie i ciepło.',
    '- Opieraj odpowiedzi WYŁĄCZNIE na bazie wiedzy poniżej. Nie wymyślaj',
    '  funkcji, cen ani zachowań, których w niej nie ma.',
    `- Gdy nie znasz odpowiedzi albo pytanie wykracza poza bazę wiedzy:`,
    `  ZACZNIJ odpowiedź dokładnie od frazy "${UNCERTAIN_PREFIX}" i zaproponuj`,
    '  kontakt z zespołem wsparcia.',
    '- NIE udzielaj porad podatkowych ani prawnych — przy takich pytaniach',
    '  odeślij do księgowego lub doradcy podatkowego.',
    '- Nie proś użytkownika o hasło, dane karty ani dane logowania.',
    '- Nie udawaj człowieka. Zapytany, kim jesteś, odpowiedz, że jesteś automatem',
    '  (AI), który podpowiada na podstawie centrum pomocy FaktWay (art. 50 AI Act).',
    '- Gdy użytkownik prosi o człowieka, potwierdź, że to możliwe, i wskaż drogę:',
    `  przycisk "Połącz z człowiekiem" pod rozmową albo e-mail ${SUPPORT_EMAIL}.`,
    '',
    'FORMAT ODPOWIEDZI:',
    '- Najpierw normalna odpowiedź dla użytkownika.',
    `- Na samym końcu dodaj DOKŁADNIE jedną linię zaczynającą się od`,
    `  "${META_LINE_PREFIX}" w formacie:`,
    `  ${META_LINE_PREFIX} uncertain=<true|false> articles=<slug,slug lub puste> category=<kategoria>`,
    '  gdzie:',
    '  - "articles" to slugi artykułów z bazy wiedzy, z których faktycznie',
    '    skorzystałeś (pole "slug:" przy artykule),',
    '  - "category" to jedna z: onboarding, ksef, invoicing, ocr_kpir,',
    '    billing, team, security, other — najlepiej pasująca do pytania.',
    '  Linia META jest metadanymi — użytkownik jej nie zobaczy.',
  ].join('\n');

  return [
    { type: 'text' as const, text: instructions },
    {
      type: 'text' as const,
      text: `BAZA WIEDZY (${kb.count} artykułów):\n\n${kb.text}`,
      // KB jest stałe między requestami — cache'ujemy żeby nie płacić
      // pełnej ceny ~14k tokenów przy każdej wiadomości.
      cache_control: { type: 'ephemeral' as const },
    },
  ];
}

/**
 * Streamuje odpowiedź AI. Yielduje fragmenty tekstu w miarę generowania.
 * Caller odpowiada za zapis do DB (parsowanie META robi `parseMeta`).
 */
export async function* streamSupportReply(
  history: SupportTurn[],
): AsyncGenerator<string> {
  // S-12: pytanie o poradę podatkową nie trafia do modelu; stała odpowiedź z META.
  const ostatnie = [...history].reverse().find((t) => t.role === 'user');
  if (ostatnie && czyPytanieOPorade(ostatnie.content)) {
    yield `${ODPOWIEDZ_PORADA}\n${META_LINE_PREFIX} uncertain=false articles= category=other`;
    return;
  }
  const anthropic = getAnthropic();
  const stream = anthropic.messages.stream({
    model: SUPPORT_MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemBlocks(),
    messages: history.map((t) => ({ role: t.role, content: t.content })),
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      yield event.delta.text;
    }
  }
}

export { parseMeta, type ParsedMeta } from './meta';
