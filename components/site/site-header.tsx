import Link from 'next/link';

import { MobileMenu } from './mobile-menu';
import { Reveal } from './motion';
import { ButtonLink, Container, Wordmark } from './ui';

export const NAV_LINKS = [
  { label: 'Funkcje', href: '/#funkcje' },
  { label: 'Telefon', href: '/#telefon' },
  { label: 'Cennik', href: '/#pricing' },
  { label: 'Pytania', href: '/#faq' },
  { label: 'Blog', href: '/blog' },
] as const;

export function SiteHeader() {
  return (
    <header className="py-6 sm:py-8">
      <Container>
        <Reveal onLoad y={-12}>
        <nav aria-label="Główna" className="relative flex items-center justify-between">
          <div className="flex items-center gap-10">
            <Link href="/" aria-label="FaktWay, strona główna">
              <Wordmark />
            </Link>
            <ul className="hidden items-center gap-1 md:flex">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="rounded-full px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center gap-3 sm:gap-5">
            <Link
              href="/login"
              className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground md:block"
            >
              Zaloguj się
            </Link>
            <ButtonLink href="/register">
              {/* Jeden element, bo `gap` przycisku rozsunąłby oba słowa. */}
              <span>
                Wypróbuj<span className="hidden lg:inline"> za darmo</span>
              </span>
            </ButtonLink>
            <MobileMenu links={NAV_LINKS} />
          </div>
        </nav>
        </Reveal>
      </Container>
    </header>
  );
}
