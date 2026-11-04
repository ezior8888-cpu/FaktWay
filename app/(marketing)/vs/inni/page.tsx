import type { Metadata } from 'next';

import { ComparisonTable, type ComparisonRow } from '@/components/marketing/comparison-table';
import {
  VsHero,
  VsTldr,
  VsSectionHeader,
  VsChooseColumns,
  VsMigrationCta,
} from '@/components/marketing/vs-page-chrome';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'FaktWay vs Inni: porównanie KSeF 2.0, kosztów i KPiR (2026)',
  description:
    'Pełne porównanie FaktWay z innymi apkami (Fakturownia, inFakt, wFirma, iFirma): KSeF 2.0, koszty ze zdjęcia, KPiR, telefon, ceny. Funkcje jeden do jednego.',
};

const COMPARISON_ROWS = [
  {
    category: 'KSeF 2026',
    feature: 'Wsparcie KSeF 2.0 (luty 2026)',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'yes' as const },
  },
  {
    category: 'KSeF 2026',
    feature: 'Pre-send walidacja FA(3)',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'KSeF 2026',
    feature: 'Post-send monitoring (false positives)',
    ksefSaas: { status: 'yes' as const, note: 'sprawdzamy status w KSeF po wysyłce' },
    competitor: { status: 'no' as const, note: 'znany bug' },
  },
  {
    category: 'KSeF 2026',
    feature: 'Automatyczne UPO + archiwizacja',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const, note: 'manual download' },
  },
  {
    category: 'KSeF 2026',
    feature: 'Tryb Offline24 (awarie MF)',
    ksefSaas: { status: 'no' as const, note: 'wstrzymany, ponawiamy wysyłkę' },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'KSeF 2026',
    feature: 'Odświeżanie sesji KSeF',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'no' as const, note: 'znane zawieszenia 24h' },
  },
  {
    category: 'Koszty i KPiR',
    feature: 'Odczyt faktur kosztowych ze zdjęcia',
    ksefSaas: { status: 'yes' as const, note: 'z limitem dziennym i miesięcznym' },
    competitor: { status: 'partial' as const, note: '$9/mc dodatkowo' },
  },
  {
    category: 'Koszty i KPiR',
    feature: 'Podpowiedź kolumny KPiR',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Koszty i KPiR',
    feature: 'Podpowiedź uczy się z poprawek',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Koszty i KPiR',
    feature: 'Eksport JPK_FA + KPiR Excel',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'yes' as const },
  },
  {
    category: 'Mobile',
    feature: 'Dodanie do ekranu głównego telefonu',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Mobile',
    feature: 'Zdjęcie prosto z aparatu',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Mobile',
    feature: 'Push notifications',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Mobile',
    feature: 'Offline mode',
    ksefSaas: { status: 'no' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Workflow',
    feature: 'Przeprowadzka z innego programu',
    ksefSaas: { status: 'yes' as const, note: 'historia z KSeF + CSV' },
    competitor: { status: 'partial' as const, note: 'manual CSV import' },
  },
  {
    category: 'Workflow',
    feature: 'Przypomnienia i przedsądowe wezwania',
    ksefSaas: { status: 'yes' as const, note: 'po Twoim zatwierdzeniu' },
    competitor: { status: 'partial' as const, note: 'manual' },
  },
  {
    category: 'Workflow',
    feature: 'Co-Pilot Księgowego',
    ksefSaas: { status: 'yes' as const, note: 'paczka mailem co miesiąc' },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Workflow',
    feature: 'Korekta jednym klikiem',
    ksefSaas: { status: 'no' as const, note: 'wysyłka korekt wstrzymana' },
    competitor: { status: 'no' as const, note: '8+ kroków' },
  },
  {
    category: 'Cennik',
    feature: 'Wszystkie funkcje w cenie',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'no' as const, note: 'OCR osobno' },
  },
  {
    category: 'Hosting',
    feature: 'Dane w UE',
    ksefSaas: { status: 'yes' as const, note: 'Niemcy' },
    competitor: { status: 'yes' as const, note: 'Polska' },
  },
  {
    category: 'Hosting',
    feature: 'Eksport pełnych danych',
    ksefSaas: { status: 'yes' as const, note: '30 dni po anulowaniu' },
    competitor: { status: 'partial' as const },
  },
] satisfies ComparisonRow[];

export default function InniPage() {
  return (
    <article>
      <VsHero
        competitorName="Inni"
        subtitle="Funkcje porównane jeden do jednego: Fakturownia, inFakt, wFirma, iFirma i FaktWay pod KSeF 2.0."
      />

      <VsTldr>
        <span className="font-semibold text-[var(--marketing-text)]">Inni</span> (Fakturownia,
        inFakt, wFirma, iFirma) są dobre dla firm, które potrzebują klasycznego
        programu do faktur i nie mają dużo paragonów. Mają znane problemy ze
        stabilnością autoryzacji KSeF i bugi w korektach.{' '}
        <span className="font-semibold text-[var(--marketing-accent)]">FaktWay</span> jest
        dla freelancerów i mikrofirm, które chcą kosztów ze zdjęcia, pracy
        w przeglądarce telefonu i przypomnień o płatnościach, wszystko w cenie
        podstawowej, bez dodatków.
      </VsTldr>

      <div className="mx-auto max-w-6xl px-6 pb-24 lg:px-8">
        <VsSectionHeader num="02" title="Tabela porównawcza" />
        <ComparisonTable competitorName="Inni" rows={COMPARISON_ROWS} />

        <VsChooseColumns
          competitorName="innych apek"
          whenChooseCompetitor={[
            'Masz duży zespół księgowy i potrzebujesz audit trail',
            'Twoja firma istnieje od 5+ lat z dużą historią',
            'Wystawiasz głównie faktury B2B (mało paragonów)',
            'Akceptujesz workflow z lat 2010-2015',
          ]}
          whenChooseUs={[
            'Jesteś freelancerem / solo founderem / mikrofirmą',
            'Masz dużo paragonów do księgowania',
            'Pracujesz z telefonu / w terenie',
            'Chcesz wszystko w cenie, bez upgrade’ów',
            'Wartość Twojego czasu > 100 PLN/h',
          ]}
        />
      </div>

      <VsMigrationCta competitorName="innych apek" />
    </article>
  );
}
