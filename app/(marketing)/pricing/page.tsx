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
import { METODA_PLATNOSCI, OFERTA } from '@/lib/marketing/oferta';

import { Reveal, RevealGroup, RevealItem } from '@/components/site/motion';
import { PageHero } from '@/components/site/page-hero';
import { ButtonLink, Container, SectionHeading } from '@/components/site/ui';

// Faza 22: cennik się rzadko zmienia, więc godzinny revalidate na edge.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: `Cennik FaktWay: ${PRICE_PER_MONTH}, wszystkie funkcje, ${TRIAL_DAYS} dni za darmo`,
  description: OFERTA,
};

/**
 * Lista funkcji: każda pozycja ma pokrycie w kodzie, plik do każdej jest
 * w opisie PR (FaktWay 1.0, decyzja 4; przegląd prawny 15.10.2026).
 * Usunięte wtedy: „Bez limitu paragonów” (OCR ma limit dzienny i miesięczny,
 * lib/ai/tenant-ai-budget.ts), eksporty JPK_V7M / Optima / Subiekt / Symfonia /
 * Wapro (wyłączone, lib/exports/suspended-formats.ts; pilnuje test
 * marketing-bez-fikcji), „Retencja 10 lat” (dane trzymamy przez czas umowy),
 * „GDPR-compliant”, „Bank EU”, „Live chat” (czat jest automatyczny).
 * Usunięte przy FaktWay 1.0: „Tryb Offline24” (wstrzymany wszędzie,
 * lib/ksef/offline24-policy.ts), korekty i faktury rozliczające (wysyłka
 * wstrzymana, lib/ksef/kind-holds.ts). Wracają razem ze zdjęciem blokad.
 */
const FEATURES = [
  {
    category: 'Faktury',
    items: [
      'Bez limitu faktur sprzedaży i zakupu',
      'Faktury zaliczkowe',
      'Wystawianie B2B i dla konsumentów',
      'Dane kontrahenta z GUS po NIP',
    ],
  },
  {
    category: 'KSeF 2.0',
    items: [
      'Walidacja FA(3) przed wysyłką',
      'Sprawdzanie statusu po wysyłce',
      'UPO pobierane samo i archiwizowane',
      'Ponawianie wysyłki, gdy KSeF nie odpowiada',
      'Faktury zakupowe z KSeF przychodzą same',
      'Historia faktur z KSeF pobiera się sama',
    ],
  },
  {
    category: 'Koszty i KPiR',
    items: [
      'Odczyt faktur kosztowych i paragonów ze zdjęcia, z limitem dziennym i miesięcznym',
      'Podpowiedź kolumny KPiR, która uczy się Twoich poprawek',
      'KPiR z faktur i kosztów',
    ],
  },
  {
    category: 'Należności',
    items: [
      'Lista faktur po terminie',
      'Zapłacone jednym dotknięciem',
      'Przypomnienia i przedsądowe wezwania do zapłaty, wysyłane po Twoim zatwierdzeniu',
      'Walidacja NIP (biała lista VAT, VIES)',
      'Sprawdzanie rachunków na białej liście',
    ],
  },
  {
    category: 'Telefon',
    items: [
      'Działa w przeglądarce telefonu',
      'Można dodać do ekranu głównego',
      'Logowanie biometrią',
      'Zdjęcie dokumentu prosto z aparatu',
      'Powiadomienia push w przeglądarce',
    ],
  },
  {
    category: 'Księgowa i eksport',
    items: [
      'Paczka dla księgowej co miesiąc',
      'Portal księgowej bez zakładania konta',
      'JPK_FA(4)',
      'KPiR (Excel)',
      'Uniwersalny CSV dla księgowej',
      'Import z Fakturowni, inFaktu, wFirmy i iFirmy (CSV)',
    ],
  },
  {
    category: 'Bezpieczeństwo',
    items: [
      'Serwery w UE (Niemcy)',
      'Umowa powierzenia danych (RODO) w standardzie',
      'Eksport faktur i danych konta w każdej chwili',
      'Weryfikacja dwuetapowa (2FA)',
      'Dziennik zdarzeń',
    ],
  },
  {
    category: 'Wsparcie',
    items: [
      'E-mail po polsku, zwykle w ciągu 2 dni roboczych',
      'Centrum pomocy po polsku',
      'Automatyczny czat z podpowiedziami i przejście do człowieka',
    ],
  },
];

const PROMISES = [
  {
    value: `${TRIAL_DAYS} dni`,
    label: `Pełen dostęp do wszystkich funkcji (${METODA_PLATNOSCI}). Pierwsza płatność dopiero po ${TRIAL_DAYS} dniach.`,
  },
  {
    value: `${TRIAL_DAYS} dni`,
    label: 'Tyle masz na sprawdzenie FaktWay obok obecnego programu, zanim się przeniesiesz.',
  },
];

export default function PricingPage() {
  return (
    <>
      <PageHero title="Jeden plan. Wszystkie funkcje." lead={OFERTA} />

      {/* Karta planu w tym samym kroju co cennik na stronie głównej, obok dwie obietnice. */}
      <section aria-labelledby="plan-title" className="pb-20 sm:pb-28">
        <Container>
          <div className="mx-auto grid max-w-5xl items-center gap-10 lg:grid-cols-2 lg:gap-16">
            <Reveal
              y={40}
              className="rounded-3xl bg-primary p-8 text-primary-foreground shadow-xl shadow-primary/20 sm:p-10"
            >
              <h2 id="plan-title" className="text-lg font-semibold">
                FaktWay
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
            title={<>Co dostajesz w{' '}{PRICE_GROSS}</>}
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
              W przygotowaniu (jeszcze niedostępne): wysyłka korekt i faktur rozliczających do KSeF,
              tryb Offline24, eksport JPK_V7M(3), eksport do Comarch Optima i Subiekta (EDI++).
              Odczyt dokumentów ze zdjęcia ma limit dzienny i miesięczny na firmę. Po jego
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
