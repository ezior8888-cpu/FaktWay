import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * S-12 (sygnał żelaznego filtra, decyzja „wariant B” przyjęta do potwierdzenia
 * przy scalaniu): czat pomocy miał zakaz porad podatkowych tylko w poleceniu
 * dla modelu. Klasyfikator FLO (`lib/flo/tax-topic.ts`) jest celowo szeroki
 * i odesłałby do księgowej każde pytanie z „VAT” albo „JPK”, a w czacie pomocy
 * aplikacji do faktur to większość pytań o obsługę. Tu wąski klasyfikator
 * pytań o PORADĘ (czy mogę odliczyć, jaką stawkę wybrać, czy to koszt, ile
 * zapłacę, co się bardziej opłaca): takie pytanie nie trafia do modelu.
 */
const mocks = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@/lib/anthropic/client', () => ({ getAnthropic: () => ({ messages: { stream: mocks.stream } }) }));
vi.mock('@/lib/support/knowledge-base', () => ({ buildKnowledgeBaseContext: () => ({ count: 0, text: '' }) }));

const { czyPytanieOPorade } = await import('@/lib/support/porada-podatkowa');
const { streamSupportReply, parseMeta } = await import('@/lib/support/chat');

beforeEach(() => {
  mocks.stream.mockReset();
});

const PORADY = [
  'Czy mogę odliczyć VAT od samochodu?',
  'Jaką stawkę VAT mam wybrać dla usług programistycznych?',
  'Czy laptop to jest koszt?',
  'Ile zapłacę podatku na ryczałcie przy 10 tys. przychodu?',
  'Co bardziej się opłaca: ryczałt czy skala?',
  'Czy muszę być czynnym podatnikiem VAT?',
  'czy trzeba rozliczyć tę fakturę w tym miesiącu',
];

const O_APLIKACJE = [
  'Jak wysłać JPK do urzędu?',
  'Gdzie ustawić stawkę VAT na fakturze?',
  'Jak wystawić fakturę korygującą?',
  'Nie widzę faktury w KSeF',
  'Jak dodać koszt ze zdjęcia paragonu?',
  'Czy mogę zmienić numer faktury przed wysyłką?',
];

describe('S-12: pytania o poradę podatkową w czacie pomocy', () => {
  it.each(PORADY)('porada: „%s”', (pytanie) => {
    expect(czyPytanieOPorade(pytanie)).toBe(true);
  });

  it.each(O_APLIKACJE)('obsługa aplikacji: „%s”', (pytanie) => {
    expect(czyPytanieOPorade(pytanie)).toBe(false);
  });

  it('pytanie o poradę: bez wywołania modelu, stała odpowiedź z drogą do człowieka i linia META', async () => {
    let full = '';
    for await (const kawalek of streamSupportReply([{ role: 'user', content: 'Czy mogę odliczyć VAT od samochodu?' }])) full += kawalek;
    expect(mocks.stream).not.toHaveBeenCalled();
    const meta = parseMeta(full);
    expect(meta.cleanText).toContain('księgow');
    expect(meta.cleanText).toContain('Połącz z człowiekiem');
    expect(meta.uncertain).toBe(false);
  });
});
