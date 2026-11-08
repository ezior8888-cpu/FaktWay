import type { Metadata } from 'next';
import type { LucideIcon } from 'lucide-react';
import { BookOpen, Mail, MapPin, MessageCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { SUPPORT_EMAIL } from '@/lib/site';

import { RevealGroup, RevealItem } from '@/components/site/motion';
import { PageHero } from '@/components/site/page-hero';
import { Container } from '@/components/site/ui';

// Faza 22: kontakt to czysto statyczna strona, więc cache na dobę.
// Czas odpowiedzi taki sam jak w regulaminie (lib/legal/documents/regulamin.ts).
export const revalidate = 86400;

// „| FaktWay” dopisuje szablon tytułu z layoutu stron marketingowych.
export const metadata: Metadata = {
  title: 'Kontakt',
};

type ContactCardProps = {
  icon: LucideIcon;
  title: string;
  value: string;
  href?: string;
  note?: string;
};

const CARDS: ContactCardProps[] = [
  {
    icon: Mail,
    title: 'Email',
    value: SUPPORT_EMAIL,
    href: `mailto:${SUPPORT_EMAIL}`,
    note: 'Odpisuje człowiek, w dni robocze, zwykle w ciągu 2 dni roboczych',
  },
  {
    icon: MessageCircle,
    title: 'Czat pomocy',
    value: 'W panelu, po zalogowaniu',
    href: '/login',
    note: 'Podpowiedzi z centrum pomocy. Odpowiada automat, a z czatu przejdziesz do człowieka',
  },
  {
    icon: BookOpen,
    title: 'Centrum pomocy',
    value: 'Instrukcje krok po kroku',
    href: '/pomoc',
    note: 'KSeF, faktury, import, konto',
  },
  {
    icon: MapPin,
    title: 'Adres',
    value: 'Poznań',
    note: 'Polska',
  },
];

export default function ContactPage() {
  return (
    <>
      <PageHero title="Pomożemy" lead="Czytamy każdą wiadomość. Odpowiadamy w dni robocze, zwykle w ciągu 2 dni roboczych." />

      <section aria-label="Kanały kontaktu" className="pb-20 sm:pb-28">
        <Container>
          <RevealGroup as="ul" className="mx-auto grid max-w-4xl gap-6 sm:grid-cols-2">
            {CARDS.map((card) => (
              <RevealItem as="li" key={card.title}>
                <ContactCard {...card} />
              </RevealItem>
            ))}
          </RevealGroup>
        </Container>
      </section>
    </>
  );
}

function ContactCard({ icon: Icon, title, value, href, note }: ContactCardProps) {
  const inner = (
    <>
      <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
        <Icon aria-hidden className="size-5" />
      </span>
      <h2 className="mt-6 text-lg font-semibold tracking-tight">{title}</h2>
      <p className={cn('mt-1 font-medium break-words', href ? 'text-primary' : 'text-foreground')}>{value}</p>
      {note ? <p className="mt-2 text-sm text-muted-foreground">{note}</p> : null}
    </>
  );

  const cardClass = 'block h-full rounded-3xl bg-card p-8 ring-1 ring-border';

  if (href) {
    return (
      <a
        href={href}
        className={cn(
          cardClass,
          'transition-shadow hover:shadow-lg hover:shadow-primary/5 hover:ring-primary/40',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        )}
      >
        {inner}
      </a>
    );
  }

  return <div className={cardClass}>{inner}</div>;
}
