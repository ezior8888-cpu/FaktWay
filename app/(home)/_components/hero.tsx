import { PRICE_PER_MONTH } from '@/lib/billing/pricing';
import { HASLO, PROBA } from '@/lib/marketing/oferta';
import { MarkerStroke } from '@/components/site/marker-stroke';
import { Reveal } from '@/components/site/motion';
import { ButtonLink, Container } from '@/components/site/ui';

import { HeroPreview } from './hero-preview';

// Nagłówek to hasło (lib/marketing/oferta.ts, decyzja Bartosza z 03.11.2026)
// w formacie dawnego „bez stresu”: duże litery i wyróżnione zakończenie. Pod
// przyciskami podgląd panelu, żeby początek strony nie był pusty. Wejście przy
// załadowaniu: nagłówek, opis, przyciski po kolei, potem rysuje się podkreślenie.
export function Hero() {
  return (
    <Container className="pt-16 pb-20 text-center sm:pt-24 lg:pt-32 lg:pb-28">
      <Reveal onLoad>
        <h1 className="mx-auto max-w-4xl text-5xl font-semibold tracking-tight text-balance text-foreground sm:text-7xl">
          {HASLO.przed}
          <span className="relative whitespace-nowrap text-primary">
            <MarkerStroke className="absolute -bottom-[0.06em] left-[-3%] h-[0.42em] w-[106%] text-primary/20" />
            <span className="relative">{HASLO.wyroznienie}</span>
          </span>
        </h1>
      </Reveal>

      <Reveal onLoad delay={0.1}>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-pretty text-muted-foreground">
          Wystawiasz fakturę, a FaktWay wysyła ją do KSeF i pilnuje potwierdzenia. Koszty dodajesz
          ze zdjęcia, a faktury po terminie widzisz w jednym miejscu.
        </p>
      </Reveal>

      <Reveal onLoad delay={0.2} className="mt-10 flex flex-wrap justify-center gap-3">
        <ButtonLink href="/register">Wypróbuj za darmo</ButtonLink>
        <ButtonLink href="#funkcje" variant="outline">
          Zobacz, jak to działa
        </ButtonLink>
      </Reveal>

      <Reveal onLoad delay={0.3}>
        <p className="mt-6 text-sm text-muted-foreground">
          {PROBA}, potem {PRICE_PER_MONTH}. Rezygnujesz, kiedy chcesz.
        </p>
      </Reveal>

      <Reveal onLoad delay={0.4}>
        <HeroPreview />
      </Reveal>
    </Container>
  );
}
