import Link from 'next/link';

import { OFERTA_TEKST } from '@/lib/marketing/oferta';

import { Container, Wordmark } from './ui';

const COLUMNS = [
  {
    title: 'Produkt',
    links: [
      { label: 'Funkcje', href: '/#funkcje' },
      { label: 'Telefon', href: '/#telefon' },
      { label: 'Cennik', href: '/#pricing' },
      { label: 'Pytania', href: '/#faq' },
    ],
  },
  {
    title: 'Firma',
    links: [
      { label: 'O nas', href: '/about' },
      { label: 'Blog', href: '/blog' },
      { label: 'Kontakt', href: '/kontakt' },
    ],
  },
  {
    title: 'Dokumenty',
    links: [
      { label: 'Regulamin', href: '/legal/regulamin' },
      { label: 'Polityka prywatności', href: '/legal/polityka-prywatnosci' },
      { label: 'Umowa powierzenia', href: '/legal/umowa-powierzenia' },
      { label: 'Cookies', href: '/legal/cookies' },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <Container>
        <div className="flex flex-col gap-12 py-14 md:flex-row md:justify-between">
          <div className="max-w-xs">
            <Wordmark />
            <p className="mt-3 text-sm text-muted-foreground">{OFERTA_TEKST}</p>
          </div>
          <nav aria-label="Stopka" className="grid grid-cols-2 gap-10 sm:grid-cols-3 sm:gap-16">
            {COLUMNS.map((column) => (
              <div key={column.title}>
                <p className="text-sm font-semibold">{column.title}</p>
                <ul className="mt-4 space-y-3">
                  {column.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <p className="border-t border-border py-8 text-sm text-muted-foreground">
          FaktWay. Wszystkie prawa zastrzeżone.
        </p>
      </Container>
    </footer>
  );
}
