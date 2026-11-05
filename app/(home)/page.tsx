import type { Metadata } from 'next';

import { SiteShell } from '@/components/site/site-shell';
import { OFERTA } from '@/lib/marketing/oferta';

import { Hero } from './_components/hero';
import { Phone } from './_components/phone-section';
import { CallToAction, Faq, Features, Pricing } from './_components/sections';

export const metadata: Metadata = {
  title: 'FaktWay: program do faktur z KSeF',
  description: OFERTA,
};

/**
 * Strona główna od 23.10.2026: prosty układ w duchu szablonu Salient
 * (TaxPal), napisany od zera na tokenach aplikacji. Z Salient nie ma tu kodu,
 * grafik ani tekstów, tylko ogólny układ sekcji. Bez opinii klientów,
 * logotypów i liczb, bo nie mamy prawdziwych (tests/unit/strona-glowna).
 *
 * FaktWay 1.0 (decyzja z 29.10.2026): bez FLO, asystenta i AI w obietnicach,
 * jedno zdanie oferty, każda funkcja ma pokrycie w kodzie. Niebieski pas po
 * dawnej sekcji FLO opisuje telefon, żeby strona nie straciła rytmu.
 *
 * Osobna grupa tras, bo `(landing)/layout.tsx` owija strony w motyw Zova,
 * a ta strona używa motywu aplikacji (jasny i ciemny).
 */
export default function HomePage() {
  return (
    <SiteShell>
      <Hero />
      <Features />
      <Phone />
      <Pricing />
      <Faq />
      <CallToAction />
    </SiteShell>
  );
}
