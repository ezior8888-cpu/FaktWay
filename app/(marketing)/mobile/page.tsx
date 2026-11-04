import type { Metadata } from 'next';

import { PageHero } from '@/components/site/page-hero';
import { ButtonLink } from '@/components/site/ui';

export const metadata: Metadata = {
  title: 'FaktWay na telefonie',
  description:
    'FaktWay działa w przeglądarce telefonu. Dodaj go do ekranu głównego, żeby otwierać jak aplikację.',
  robots: { index: false },
};

/**
 * Krótka instrukcja dla telefonu. Od FaktWay 1.0 panel jest dostępny w każdej
 * przeglądarce, a bramka BUG-008 (przekierowanie telefonów tutaj) nie istnieje.
 * Strona zostaje, bo ktoś musi powiedzieć, jak dodać FaktWay do ekranu głównego:
 * manifest PWA (`app/manifest.ts`) robi z niego okno bez paska przeglądarki.
 * Bez odznak sklepów: osobnej aplikacji w App Store ani Google Play nie ma.
 */
const PLATFORMS = [
  {
    name: 'iPhone',
    steps: [
      'Otwórz FaktWay w Safari i zaloguj się.',
      'Stuknij Udostępnij na dolnym pasku.',
      'Wybierz Do ekranu początkowego, potem Dodaj.',
    ],
  },
  {
    name: 'Android',
    steps: [
      'Otwórz FaktWay w Chrome i zaloguj się.',
      'Stuknij menu z trzema kropkami w rogu.',
      'Wybierz Zainstaluj aplikację, potem Zainstaluj.',
    ],
  },
] as const;

export default function MobilePage() {
  return (
    <div className="pb-20 sm:pb-28">
      <PageHero
        title="FaktWay działa na telefonie"
        lead="Otwórz FaktWay w przeglądarce telefonu i zaloguj się jak zawsze. Faktury, koszty i KSeF są pod ręką, a po dodaniu do ekranu głównego otwiera się jak zwykła aplikacja."
      >
        <div className="mx-auto grid max-w-3xl gap-4 text-left sm:grid-cols-2">
          {PLATFORMS.map((platform) => (
            <section
              key={platform.name}
              aria-labelledby={`telefon-${platform.name}`}
              className="rounded-2xl bg-muted/40 p-5 ring-1 ring-border"
            >
              <h2 id={`telefon-${platform.name}`} className="text-base font-semibold text-foreground">
                {platform.name}
              </h2>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-pretty text-muted-foreground marker:font-medium marker:text-foreground">
                {platform.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </section>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <ButtonLink href="/login" className="min-h-[44px]">
            Zaloguj się
          </ButtonLink>
          <ButtonLink href="/" variant="outline" className="min-h-[44px]">
            Wróć na stronę główną
          </ButtonLink>
        </div>
      </PageHero>
    </div>
  );
}
