import type { Metadata } from 'next';
import { HeartHandshake, ListChecks, ScrollText, ShieldCheck } from 'lucide-react';

import { TRIAL_DAYS } from '@/lib/billing/pricing';
import { SUPPORT_EMAIL } from '@/lib/site';

import { Reveal, RevealGroup, RevealItem } from '@/components/site/motion';
import { PageHero } from '@/components/site/page-hero';
import { BandGlow, ButtonLink, Container, SectionHeading } from '@/components/site/ui';

// „| FaktWay” dopisuje szablon tytułu z layoutu stron marketingowych.
export const metadata: Metadata = {
  title: 'O nas',
  description:
    'Kto stoi za FaktWay, w co wierzymy i dla kogo robimy program do faktur w KSeF.',
};

/*
 * Strona O nas na tokenach aplikacji (23.10.2026), w kroju strony głównej.
 * Tylko teksty, które przeszły przegląd 15.10.2026: bez zdjęć i filmów
 * z dawnego szablonu (licencja niepotwierdzona), bez liczb, bez siatki
 * zespołu i bez portretów. Wracają tylko prawdziwe dane, zdjęcia i zgody.
 */
const VALUES = [
  {
    icon: ScrollText,
    title: 'Jasne zasady',
    body: 'Mówimy wprost, ile co kosztuje i co dzieje się z danymi. Bez gwiazdek i drobnego druku.',
  },
  {
    icon: ShieldCheck,
    title: 'Niezawodność',
    body: 'Faktura musi wyjść wtedy, kiedy jej potrzebujesz. Dlatego pilnujemy wysyłki nawet, gdy KSeF ma gorszy dzień.',
  },
  {
    icon: ListChecks,
    title: 'Prostota',
    body: 'Zamieniamy urzędowe formularze w kilka pól do wypełnienia. Resztę robimy w tle.',
  },
  {
    icon: HeartHandshake,
    title: 'Blisko użytkownika',
    body: 'Czytamy każdą wiadomość i poprawiamy to, co realnie przeszkadza w pracy.',
  },
] as const;

export default function AboutPage() {
  return (
    <>
      <PageHero title="Robimy program do faktur, którego sami chcieliśmy używać" />

      {/* W co wierzymy: myśl założyciela obok czterech zasad. */}
      <section aria-labelledby="wartosci-title" className="pb-20 sm:pb-28">
        <Container>
          <div className="mx-auto grid max-w-5xl gap-12 lg:grid-cols-12 lg:gap-16">
            <Reveal className="lg:col-span-5">
              <h2 id="wartosci-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">
                W co wierzymy
              </h2>
              <figure className="mt-8">
                <blockquote className="text-xl font-medium tracking-tight text-pretty sm:text-2xl">
                  <p>
                    Faktury to obowiązek, nie zajęcie. Chcemy, żeby zajmowały kilka minut dziennie, a nie
                    cały wieczór na koniec miesiąca.
                  </p>
                </blockquote>
                <figcaption className="mt-8 flex items-center gap-4">
                  {/* Inicjały zamiast portretu. */}
                  <span
                    aria-hidden
                    className="flex size-12 items-center justify-center rounded-full bg-accent font-semibold text-accent-foreground"
                  >
                    BG
                  </span>
                  <span className="flex flex-col">
                    <span className="font-semibold">Bartosz Gierszewski</span>
                    <span className="text-sm text-muted-foreground">Założyciel FaktWay</span>
                  </span>
                </figcaption>
              </figure>
            </Reveal>

            <RevealGroup as="ul" className="grid gap-4 sm:grid-cols-2 lg:col-span-7">
              {VALUES.map(({ icon: Icon, title, body }) => (
                <RevealItem as="li" key={title} className="rounded-2xl bg-muted/50 p-6 ring-1 ring-border sm:p-8">
                  <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                    <Icon aria-hidden className="size-5" />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold">{title}</h3>
                  <p className="mt-2 text-pretty text-muted-foreground">{body}</p>
                </RevealItem>
              ))}
            </RevealGroup>
          </div>
        </Container>
      </section>

      {/* Ludzie za FaktWay: bez siatki zespołu, tylko zaproszenie do kontaktu. */}
      <section aria-labelledby="ludzie-title" className="bg-muted/50 py-20 sm:py-28">
        <Container>
          <SectionHeading
            id="ludzie-title"
            title="Ludzie za FaktWay"
            lead="Mały zespół, który zna KSeF od podszewki i sam prowadzi firmę."
          />
          <Reveal className="mx-auto mt-14 max-w-3xl rounded-3xl bg-card p-8 text-center ring-1 ring-border sm:p-12">
            <h3 className="text-2xl font-semibold tracking-tight">Dołącz do nas</h3>
            <p className="mx-auto mt-4 max-w-xl text-pretty text-muted-foreground">
              Lubisz upraszczać skomplikowane rzeczy? Napisz do nas. Nie prowadzimy teraz rekrutacji, ale
              chętnie poznamy ludzi, którzy chcą współtworzyć FaktWay.
            </p>
            <ButtonLink href={`mailto:${SUPPORT_EMAIL}`} variant="outline" className="mt-8">
              Napisz: {SUPPORT_EMAIL}
            </ButtonLink>
          </Reveal>
        </Container>
      </section>

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
              Konto jest bezpłatne, a subskrypcja zaczyna się od {TRIAL_DAYS} dni bez opłat. Zrezygnujesz
              przed ich końcem, nie zapłacisz nic.
            </p>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <ButtonLink href="/register" variant="inverse">
                Zacznij za darmo
              </ButtonLink>
              <ButtonLink
                href="/pricing"
                variant="outline"
                className="text-primary-foreground ring-primary-foreground/40 hover:bg-primary-foreground/10"
              >
                Zobacz cennik
              </ButtonLink>
            </div>
          </Reveal>
        </Container>
      </section>
    </>
  );
}
