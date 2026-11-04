import Link from 'next/link';
import {
  BellRing,
  Check,
  CloudOff,
  FileCheck2,
  FileInput,
  Receipt,
  Users,
} from 'lucide-react';

import { PRICE_GROSS, TRIAL_DAYS } from '@/lib/billing/pricing';
import { PROBA } from '@/lib/marketing/oferta';

import { Reveal, RevealGroup, RevealItem } from '@/components/site/motion';
import { BandGlow, ButtonLink, Container, SectionHeading } from '@/components/site/ui';

/*
 * Każda funkcja ma pokrycie w kodzie, plik do każdej jest w opisie PR
 * (FaktWay 1.0, decyzja 4). Przed dopisaniem nowej znajdź plik, który ją
 * realizuje. Pilnują tests/unit/strony-publiczne-obietnice
 * i tests/unit/marketing-bez-fikcji.
 */

const FEATURES = [
  {
    icon: FileCheck2,
    title: 'Wysyłka do KSeF',
    text: 'Wystawiasz fakturę, my wysyłamy ją do KSeF i sami pobieramy UPO.',
  },
  {
    icon: CloudOff,
    title: 'Ponawianie, gdy KSeF nie działa',
    text: 'Gdy KSeF nie odpowiada, ponawiamy wysyłkę sami, w coraz dłuższych odstępach. Możesz też wysłać fakturę ponownie jednym przyciskiem.',
  },
  {
    icon: BellRing,
    title: 'Należności pod kontrolą',
    text: 'Faktury po terminie masz w jednym miejscu, a zapłacone oznaczasz jednym dotknięciem.',
  },
  {
    icon: Receipt,
    title: 'Koszty ze zdjęcia',
    text: 'Robisz zdjęcie paragonu albo faktury, a odczytany koszt trafia do KPiR od razu. Na liście wydatków czeka z oznaczeniem „Do opisania”, żebyś go sprawdził. Faktury zakupowe z KSeF przychodzą same.',
  },
  {
    icon: Users,
    title: 'Dostęp dla księgowej',
    text: 'Zapraszasz ją na konto, a ona sama pobiera komplet dokumentów za wybrany okres.',
  },
  {
    icon: FileInput,
    title: 'Przeprowadzka z innego programu',
    text: 'Historię z KSeF pobieramy sami. Starsze faktury wgrywasz plikiem z Fakturowni, inFaktu, wFirmy albo iFirmy.',
  },
] as const;

export function Features() {
  return (
    <section id="funkcje" aria-labelledby="funkcje-title" className="py-20 sm:py-28">
      <Container>
        <SectionHeading
          id="funkcje-title"
          title="Od faktury do księgowej, bez przepisywania"
          lead="FaktWay prowadzi fakturę przez KSeF aż do Twojej księgowej. Ty wystawiasz, my pilnujemy reszty."
        />
        <RevealGroup as="ul" className="mx-auto mt-16 grid max-w-5xl gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <RevealItem as="li" key={title}>
              <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                <Icon aria-hidden className="size-5" />
              </span>
              <h3 className="mt-5 text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-pretty text-muted-foreground">{text}</p>
            </RevealItem>
          ))}
        </RevealGroup>
      </Container>
    </section>
  );
}

// Jeden plan dla wszystkich (decyzja z 1 października 2026), cena
// z lib/billing/pricing.ts.
const PLAN_FEATURES = [
  'Faktury bez limitu',
  'Wysyłka do KSeF i pobieranie UPO',
  'Zdjęcie paragonu do KPiR',
  'Faktury po terminie',
  'Paczka dla księgowej',
  'Import z Fakturowni, inFaktu, wFirmy i iFirmy',
  'Działa w przeglądarce telefonu',
  PROBA,
];

export function Pricing() {
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="py-20 sm:py-28">
      <Container>
        <SectionHeading
          id="pricing-title"
          title="Jeden plan, jedna cena"
          lead="Wszystkie funkcje od pierwszego dnia. Płacisz co miesiąc, bez umowy na rok."
        />
        <Reveal y={40} className="mx-auto mt-14 max-w-md rounded-3xl bg-primary p-8 text-primary-foreground shadow-xl shadow-primary/20 sm:p-10">
          <h3 className="text-lg font-semibold">FaktWay</h3>
          <p className="mt-1 text-sm text-primary-foreground">Dla firm i księgowych. Cena za jedną firmę (NIP).</p>
          <p className="mt-6 flex items-baseline gap-2">
            <span className="text-5xl font-semibold tracking-tight">{PRICE_GROSS}</span>
            <span className="text-sm text-primary-foreground">/mies. z VAT</span>
          </p>
          <ButtonLink href="/register" variant="inverse" className="mt-8 w-full">
            Wypróbuj za darmo
          </ButtonLink>
          <ul className="mt-8 space-y-3 text-sm">
            {PLAN_FEATURES.map((feature) => (
              <li key={feature} className="flex gap-3">
                <Check aria-hidden className="size-5 shrink-0" />
                {feature}
              </li>
            ))}
          </ul>
        </Reveal>
      </Container>
    </section>
  );
}

const QUESTIONS = [
  [
    {
      q: 'Czy FaktWay działa w telefonie?',
      a: 'Tak, w przeglądarce telefonu. Możesz też dodać FaktWay do ekranu głównego i otwierać go jak zwykły program.',
    },
    {
      q: 'Czy muszę mieć podpis elektroniczny?',
      a: 'Podpis kwalifikowany nie jest potrzebny. Do Aplikacji Podatnika KSeF wejdziesz profilem zaufanym, wygenerujesz tam certyfikat KSeF i dodasz go w ustawieniach FaktWay. Przy wgrywaniu plików działa klucz prywatny RSA w formacie PEM (PKCS#8) bez hasła.',
    },
  ],
  [
    {
      q: 'Co się dzieje, gdy KSeF nie odpowiada?',
      a: 'Ponawiamy wysyłkę sami: najpierw kilka razy w ciągu około półtorej godziny, potem co kilka godzin. Fakturę możesz też wysłać ponownie jednym przyciskiem.',
    },
    {
      q: 'Przeniesiecie moje dane z innego programu?',
      a: 'Tak. Faktury z KSeF pobieramy sami, a starsze wgrywasz plikiem CSV z Fakturowni, inFaktu, wFirmy albo iFirmy.',
    },
  ],
  [
    {
      q: 'Gdzie trzymacie moje dane?',
      a: 'Na serwerach w Niemczech. Połączenia są szyfrowane, a certyfikat KSeF zapisujemy zaszyfrowany. Dokumenty trzymamy przez cały czas korzystania z FaktWay i w każdej chwili możesz je wyeksportować. Faktury wysłane do KSeF przechowuje też Ministerstwo Finansów. Odczyt kosztów ze zdjęcia i wysyłka e-maili korzystają z dostawców spoza UE, a ich listę znajdziesz w dokumentach prawnych, na stronie „Podmioty przetwarzające”.',
    },
    {
      q: 'Czy mogę zrezygnować w każdej chwili?',
      a: 'Tak. Nie ma umowy na czas określony ani opłaty za wyjście.',
    },
  ],
] as const;

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="bg-muted/50 py-20 sm:py-28">
      <Container>
        <Reveal className="max-w-2xl">
          <h2 id="faq-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Pytania i odpowiedzi
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Nie ma tu Twojego pytania?{' '}
            <Link href="/kontakt" className="font-medium text-primary underline-offset-4 hover:underline">
              Napisz do nas
            </Link>
            .
          </p>
        </Reveal>
        <RevealGroup className="mt-14 grid gap-10 lg:grid-cols-3 lg:gap-8">
          {QUESTIONS.map((column, i) => (
            <RevealItem key={i}>
            <dl className="flex flex-col gap-10">
              {column.map(({ q, a }) => (
                <div key={q}>
                  <dt className="text-lg font-semibold">{q}</dt>
                  <dd className="mt-3 text-pretty text-muted-foreground">{a}</dd>
                </div>
              ))}
            </dl>
            </RevealItem>
          ))}
        </RevealGroup>
      </Container>
    </section>
  );
}

export function CallToAction() {
  return (
    <section
      aria-labelledby="start-title"
      className="relative overflow-hidden bg-primary py-20 text-primary-foreground sm:py-28"
    >
      <BandGlow className="rotate-180" />
      <Container className="relative">
        <Reveal className="mx-auto max-w-xl text-center">
          <h2 id="start-title" className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Wystaw pierwszą fakturę jeszcze dziś
          </h2>
          <p className="mt-4 text-lg text-pretty text-primary-foreground">
            {TRIAL_DAYS} dni za darmo. Rezygnujesz, kiedy chcesz.
          </p>
          <ButtonLink href="/register" variant="inverse" className="mt-10">
            Wypróbuj za darmo
          </ButtonLink>
        </Reveal>
      </Container>
    </section>
  );
}
