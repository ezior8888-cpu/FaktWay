import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';

import {
  PRICE_GROSS,
  PRICE_NET,
  PRICE_PER_MONTH,
  PRICE_VAT,
  TRIAL_DAYS,
} from '@/lib/billing/pricing';

import { Reveal, RevealGroup, RevealItem } from '@/components/site/motion';
import { PageHero } from '@/components/site/page-hero';
import { ButtonLink, Container, SectionHeading } from '@/components/site/ui';

// Faza 22: cennik się rzadko zmienia — godzinny revalidate na edge.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: `Cennik FaktWay: ${PRICE_PER_MONTH}, wszystkie funkcje, ${TRIAL_DAYS} dni za darmo`,
  description:
    `Jeden plan dla wszystkich: ${PRICE_PER_MONTH}, płatne co miesiąc. ${TRIAL_DAYS} dni za darmo. OCR, KSeF 2.0, KPiR, Wkurzacz Dłużników w cenie. Bez ukrytych dodatków.`,
};

/**
 * Lista funkcji — każda pozycja musi działać dziś (przegląd prawny 15.10.2026).
 * Usunięte wtedy: „Bez limitu paragonów” (OCR ma limit dzienny i miesięczny,
 * lib/ai/tenant-ai-budget.ts), eksporty JPK_V7M / Optima / Subiekt / Symfonia /
 * Wapro (wyłączone, lib/exports/suspended-formats.ts — pilnuje test
 * marketing-bez-fikcji), „Mobile” (do FaktWay 1.0 panel na telefonach był wyłączony),
 * „Retencja 10 lat” (dane trzymamy przez czas umowy), „GDPR-compliant”,
 * „Bank EU”, „Live chat” (czat prowadzi asystent AI).
 */
const FEATURES = [
  {
    category: 'Faktury',
    items: [
      'Bez limitu faktur sprzedaży i zakupu',
      'Korekty, zaliczki i faktury rozliczające',
      'Wystawianie B2B i B2C',
    ],
  },
  {
    category: 'KSeF 2.0',
    items: [
      'Pre-send walidacja FA(3)',
      'Post-send monitoring',
      'UPO automatyczne + archiwizacja',
      'Tryb Offline24',
      'Auto-retry przy błędach',
    ],
  },
  {
    category: 'OCR + KPiR',
    items: [
      'Odczyt faktur kosztowych i paragonów (AI), z limitem dziennym i miesięcznym',
      'Podpowiedź kolumny KPiR, która uczy się Twoich poprawek',
      'Automatyczny import faktur zakupowych z KSeF',
      'Eksport JPK_FA i KPiR (Excel)',
    ],
  },
  {
    category: 'Workflow',
    items: [
      'Magiczny Import z 4 innych programów (CSV)',
      'Wkurzacz Dłużników (przypomnienia i przedsądowe wezwania do zapłaty, wysyłane po Twoim zatwierdzeniu)',
      'Co-Pilot Księgowego (paczka dla księgowej co miesiąc)',
      'Walidacja NIP (biała lista VAT, VIES)',
      'Sprawdzanie rachunków na białej liście',
      'Powiadomienia push w przeglądarce',
    ],
  },
  {
    category: 'Eksport',
    items: [
      'JPK_FA(4)',
      'KPiR (Excel)',
      'Uniwersalny CSV dla księgowej',
    ],
  },
  {
    category: 'Bezpieczeństwo',
    items: [
      'Serwery w UE (Niemcy)',
      'Umowa powierzenia danych (RODO) w standardzie',
      'Eksport pełnych danych w każdej chwili',
      'Weryfikacja dwuetapowa (2FA)',
      'Dziennik zdarzeń',
    ],
  },
  {
    category: 'Wsparcie',
    items: [
      'E-mail po polsku (dni robocze)',
      'Centrum pomocy po polsku',
      'Czat z asystentem AI i kontakt z człowiekiem',
    ],
  },
];

const PROMISES = [
  {
    value: `${TRIAL_DAYS} dni`,
    label: `Pełen dostęp do wszystkich funkcji. Kartę podajesz na starcie, pierwsza płatność dopiero po ${TRIAL_DAYS} dniach.`,
  },
  {
    value: `${TRIAL_DAYS} dni`,
    label: 'Parallel Run: możesz używać równolegle z poprzednią apką, by porównać przed migracją.',
  },
];

export default function PricingPage() {
  return (
    <>
      <PageHero
        title="Jeden plan. Wszystkie funkcje."
        lead={<>Bez tierów. Bez &bdquo;premium&rdquo; toggle. Bez umowy na rok.</>}
      />

      {/* Karta planu w tym samym kroju co cennik na stronie głównej, obok dwie obietnice. */}
      <section aria-labelledby="plan-title" className="pb-20 sm:pb-28">
        <Container>
          <div className="mx-auto grid max-w-5xl items-center gap-10 lg:grid-cols-2 lg:gap-16">
            <Reveal
              y={40}
              className="rounded-3xl bg-primary p-8 text-primary-foreground shadow-xl shadow-primary/20 sm:p-10"
            >
              <h2 id="plan-title" className="text-lg font-semibold">
                Plan podstawowy
              </h2>
              <p className="mt-6 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-5xl font-semibold tracking-tight whitespace-nowrap sm:text-6xl">
                  {PRICE_GROSS}
                </span>
                <span className="text-sm text-primary-foreground">/ miesiąc · z VAT</span>
              </p>
              <p className="mt-3 text-sm text-primary-foreground">
                {PRICE_NET} netto + {PRICE_VAT} VAT · faktura VAT co miesiąc
              </p>
              <ButtonLink href="/register" variant="inverse" className="mt-8 w-full">
                Wypróbuj {TRIAL_DAYS} dni za darmo
                <ArrowRight aria-hidden className="size-4" />
              </ButtonLink>
              <p className="mt-4 text-center text-xs text-primary-foreground">
                Pierwsza płatność po {TRIAL_DAYS} dniach · Bez umowy na rok
              </p>
            </Reveal>

            <RevealGroup as="ul" className="flex flex-col gap-4">
              {PROMISES.map((promise) => (
                <RevealItem as="li" key={promise.label} className="rounded-2xl bg-muted/50 p-6 ring-1 ring-border sm:p-8">
                  <p className="text-3xl font-semibold tracking-tight text-primary">{promise.value}</p>
                  <p className="mt-2 text-pretty text-muted-foreground">{promise.label}</p>
                </RevealItem>
              ))}
            </RevealGroup>
          </div>
        </Container>
      </section>

      <section aria-labelledby="features-title" className="bg-muted/50 py-20 sm:py-28">
        <Container>
          {/* Twarda spacja po „w”: przyimek nie zostaje sam na końcu linii. */}
          <SectionHeading
            id="features-title"
            title={<>Co dostajesz w{' '}{PRICE_GROSS}</>}
            lead={`${FEATURES.length} kategorii. Wszystko od pierwszego dnia.`}
          />

          <div className="mx-auto mt-14 max-w-5xl rounded-3xl bg-card p-8 ring-1 ring-border sm:p-12">
            <RevealGroup as="ul" className="grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((cat) => (
                <RevealItem as="li" key={cat.category}>
                  <h3 className="text-lg font-semibold tracking-tight">{cat.category}</h3>
                  <ul className="mt-4 space-y-3 text-sm">
                    {cat.items.map((item) => (
                      <li key={item} className="flex gap-3">
                        <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                        <span className="text-pretty text-muted-foreground">{item}</span>
                      </li>
                    ))}
                  </ul>
                </RevealItem>
              ))}
            </RevealGroup>
          </div>

          <Reveal className="mx-auto mt-8 max-w-3xl">
            <p className="text-center text-sm text-pretty text-muted-foreground">
              W przygotowaniu (jeszcze niedostępne): eksport JPK_V7M(3) oraz eksport
              do Comarch Optima i Subiekta (EDI++). Odczyt
              dokumentów przez AI ma limit dzienny i miesięczny na firmę. Po jego
              wyczerpaniu dane wpisujesz ręcznie. Szczegóły w{' '}
              <Link href="/legal/regulamin" className="font-medium text-primary underline-offset-4 hover:underline">
                regulaminie
              </Link>
              .
            </p>
          </Reveal>
        </Container>
      </section>
    </>
  );
}
