import type { Metadata } from 'next';
import Link from 'next/link';

import { PRICE_PER_MONTH, TRIAL_DAYS } from '@/lib/billing/pricing';

import { ComparisonTable, type ComparisonRow } from '@/components/marketing/comparison-table';
import {
  VsHero,
  VsTldr,
  VsSectionHeader,
  VsChooseColumns,
  VsMigrationCta,
} from '@/components/marketing/vs-page-chrome';
import { SUPPORT_EMAIL } from '@/lib/site';

// Faza 22: comparison page — SEO ważne, cache na godzinę.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'FaktWay vs inFakt 2026: gross invoices, odczyt dokumentów i cennik',
  description:
    'Porównanie FaktWay z inFakt: faktury brutto, limity odczytu dokumentów, pakiety cenowe, KSeF 2.0, telefon i migracja. Dla mikrofirm i freelancerów.',
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
    feature: 'Pre-send walidacja FA(3) lokalnie',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'yes' as const },
  },
  {
    category: 'KSeF 2026',
    feature: 'Tryb Offline24 (awarie MF)',
    ksefSaas: { status: 'no' as const, note: 'wstrzymany, ponawiamy wysyłkę' },
    competitor: { status: 'partial' as const, note: 'ograniczony' },
  },
  {
    category: 'Faktury i dokumenty',
    feature: 'Faktury gross (brutto) kosztowe',
    ksefSaas: { status: 'partial' as const, note: 'odczyt brutto i VAT ze zdjęcia' },
    competitor: { status: 'no' as const, note: 'brak dedykowanego flow' },
  },
  {
    category: 'Faktury i dokumenty',
    feature: 'Import gross z zagranicy (EUR/USD)',
    ksefSaas: { status: 'no' as const },
    competitor: { status: 'partial' as const, note: 'ręczne korekty VAT' },
  },
  {
    category: 'Faktury i dokumenty',
    feature: 'Paragon z NIP: odczyt ze zdjęcia',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Odczyt dokumentów',
    feature: 'Odczyt wielostronicowego PDF',
    ksefSaas: { status: 'partial' as const, note: 'plik do 10 MB' },
    competitor: { status: 'partial' as const, note: 'limit stron / kolejka' },
  },
  {
    category: 'Odczyt dokumentów',
    feature: 'Odczyt tabel pozycji',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const, note: 'proste layouty' },
  },
  {
    category: 'Odczyt dokumentów',
    feature: 'Ocena pewności dla każdego pola',
    ksefSaas: { status: 'no' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Odczyt dokumentów',
    feature: 'Podpowiedź kolumny KPiR uczy się z poprawek',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Mobile i PWA',
    feature: 'PWA instalowalna',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const, note: 'głównie responsive www' },
  },
  {
    category: 'Mobile i PWA',
    feature: 'Zdjęcie z aparatu',
    ksefSaas: { status: 'partial' as const, note: 'bez przycinania' },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Mobile i PWA',
    feature: 'Push: status KSeF / płatności',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Workflow',
    feature: 'Historia z KSeF i import CSV z 4 programów',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const, note: 'CSV ręcznie' },
  },
  {
    category: 'Workflow',
    feature: 'Przypomnienia i przedsądowe wezwania',
    ksefSaas: { status: 'yes' as const, note: 'po Twoim zatwierdzeniu' },
    competitor: { status: 'partial' as const, note: 'przypomnienia email' },
  },
  {
    category: 'Workflow',
    feature: 'Co-Pilot Księgowego (auto-pakiet miesięczny)',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Cennik',
    feature: 'Stawka „wszystko w jednym”',
    ksefSaas: { status: 'note' as const, note: PRICE_PER_MONTH },
    competitor: { status: 'note' as const, note: 'wyższy pakiet + add-ony' },
  },
  {
    category: 'Cennik',
    feature: 'Odczyt dokumentów w cenie bazowej',
    ksefSaas: { status: 'yes' as const, note: 'z limitem dziennym i miesięcznym' },
    competitor: { status: 'no' as const, note: 'wyższy tier / limit' },
  },
  {
    category: 'Integracje',
    feature: 'Webhooks / status faktury',
    ksefSaas: { status: 'no' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Hosting',
    feature: 'Dane w UE (GDPR)',
    ksefSaas: { status: 'yes' as const, note: 'Niemcy' },
    competitor: { status: 'yes' as const, note: 'PL cloud' },
  },
  {
    category: 'Hosting',
    feature: 'Eksport pełny po rezygnacji (30 dni)',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Raportowanie',
    feature: 'JPK_FA + KPiR Excel jednym kliknięciem',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'yes' as const },
  },
  {
    category: 'Raportowanie',
    feature: 'Podgląd błędów FA przed wysyłką',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
] satisfies ComparisonRow[];

export default function InfaktPage() {
  return (
    <article>
      <VsHero
        competitorName="inFakt"
        subtitle="Tabela funkcji, przewodnik migracji i rozbicie cenowe, pod kątem mikrofirm, które żyją z paragonów i faktur brutto."
      />

      <VsTldr>
        <span className="font-editorial font-medium text-[var(--marketing-text)]">
          inFakt
        </span>{' '}
        to dojrzały program online z szeroką bazą użytkowników i sensowną
        integracją KSeF, ale w praktyce wielu przedsiębiorców odbija się od
        trzech ścian: braku wygodnego flow dla{' '}
        <strong className="font-semibold">faktur gross</strong> (kosztowych w
        cenach brutto), <strong className="font-semibold">ograniczeń odczytu dokumentów</strong>{' '}
        na trudnych PDF-ach oraz{' '}
        <strong className="font-semibold">drogiego stacku</strong>, gdzie
        &bdquo;pełna moc&rdquo; siedzi w wyższych pakietach i dodatkach.{' '}
        <span className="font-editorial font-medium italic text-[var(--marketing-accent)]">
          FaktWay
        </span>{' '}
        stawia na jedną, przewidywalną stawkę, koszty ze zdjęcia
        i wysyłkę zaprojektowaną pod KSeF 2.0 od pierwszego dnia, bez dopłat za
        funkcje, które i tak są potrzebne przy KPiR.
      </VsTldr>

      <div className="mx-auto max-w-[1280px] px-6 lg:px-8">
        <VsSectionHeader
          num="01"
          eyebrow="Historia"
          title="Krótka historia inFakt i model hostingu"
        />
        <section className="space-y-5 leading-relaxed text-[var(--marketing-muted)]">
          <p>
            inFakt zbudował pozycję na polskim rynku SaaS księgowym jeszcze w erze, gdy KSeF był raczej obietnicą legislacyjną niż codziennym obowiązkiem. Produkt wyrosł z prostego fakturowania online, stopniowo rozszerzany o rozliczenia ZUS, magazyn czy współpracę z biurem rachunkowym. To doświadczenie widać po stronie stabilności biznesowej i rozpoznawalności marki: dla wielu księgowych &bdquo;inFakt&rdquo; to domyślny punkt odniesienia przy onboardingu klienta.
          </p>
          <p>
            Z perspektywy architektury, typowy hosting inFakt to polskie centra danych i ścisłe trzymanie się lokalnych standardów compliance, co jest plusem dla firm szukających &bdquo;100% PL&rdquo;. Jednocześnie przy KSeF 2.0 liczy się nie tylko lokalizacja serwera, ale przepływ danych: jak szybko system odróżnia fałszywie pozytywny status wysyłki od realnego UPO, jak radzi sobie z wielostronicowymi fakturami kosztowymi i czy pozwala pracować na fakturach gross bez obejść w arkuszu. Tu właśnie pojawiają się różnice kultury produktowej: inFakt ewoluował z klasycznego e-fakturowania, podczas gdy FaktWay projektujemy od zera pod mikrofirmę, która skanuje dokumenty w aucie i chce zamknąć KPiR tego samego dnia.
          </p>
          <p>
            Warto też pamiętać, że &bdquo;historia produktu&rdquo; to nie tylko data założenia firmy, ale tempo wdrażania zmian ministerialnych. KSeF 2.0 wymusza krótsze SLA na poprawki, więcej telemetrii po stronie API MF oraz większą odporność na weekendowe maintenance. W takim środowisku liczy się, czy Twój dostawca traktuje odczyt dokumentów i walidację FA(3) jako rdzeń subskrypcji, czy jako moduł premium, i ile realnie zapłacisz, zanim &bdquo;zwykła&rdquo; faktura kosztowa przestanie być walką z formularzem.
          </p>
        </section>

        <VsSectionHeader
          num="02"
          eyebrow="Opinie publiczne"
          title="Co mówią użytkownicy (skróty z dyskusji)"
        />
        <div className="grid gap-10 md:grid-cols-3 md:gap-12">
          {[
            {
              q: 'Super do prostych faktur, ale jak wchodzi paragon z Biedronki i brutto, to znów Excel.',
              meta: 'Opinia z forum branżowego · 2025',
            },
            {
              q: 'Odczyt dokumentów pomaga, ale na skanach wielostronicowych kończy się na ręcznym przepisywaniu pozycji.',
              meta: 'Komentarz z LinkedIn · 2025',
            },
            {
              q: 'Liczyłem na jeden pakiet, a żeby dogonić potrzeby biura, musiałem wejść znacznie wyżej w cennik.',
              meta: 'Wątek dyskusyjny · grupa FB · 2024',
            },
          ].map((o) => (
            <figure
              key={o.meta}
              className="border-t-2 border-emerald-500/40 pt-6"
            >
              <blockquote className="font-editorial text-lg italic leading-snug text-[var(--marketing-muted)]">
                <span className="mr-1 font-editorial text-3xl leading-none text-[var(--marketing-accent)]">
                  &bdquo;
                </span>
                {o.q}
                <span className="ml-0.5 font-editorial text-2xl leading-none text-[var(--marketing-accent)]">
                  &rdquo;
                </span>
              </blockquote>
              <figcaption className="mt-4 text-[10px] uppercase tracking-[0.22em] text-[var(--marketing-muted)]">
                {o.meta}
              </figcaption>
            </figure>
          ))}
        </div>
        <p className="mt-8 font-editorial text-sm italic leading-relaxed text-[var(--marketing-muted)]">
          Powyższe cytaty są stylizowanymi skrótami typowych wątków z publicznych dyskusji: nie cytują konkretnej osoby ani nie są gwarancją aktualnego stanu produktu konkurenta. Zawsze zweryfikuj funkcje na własnym koncie trial przed decyzją migracyjną.
        </p>

        <VsSectionHeader
          num="03"
          eyebrow="Hard requirement"
          title="Dlaczego gross invoices i OCR to dziś nie opcja"
        />
        <section className="space-y-5 leading-relaxed text-[var(--marketing-muted)]">
          <p>
            Gross invoices, czyli dokumenty kosztowe w cenach brutto, często z paragonów albo z importu zagranicznego, nie są ciekawostką dla jednej branży. To codzienność usług remontowych, transportu, gastronomii i freelancingu B2B, gdzie kontrahent wystawia brutto, a Ty musisz rozłożyć VAT i koszt bez błędu. Jeśli system nie prowadzi Cię przez ten flow jak przez checklistę KSeF, tracisz czas na korekty i podwójne wpisy w KPiR.
          </p>
          <p>
            Odczyt dokumentów z kolei nie może być &bdquo;ładną ikonką&rdquo; w cenniku. Musi radzić sobie z krzywym skanem, drugą stroną faktury z regulaminem na odwrocie i tabelą pozycji, gdzie każda linia ma inną stawkę VAT. Ograniczenia, takie jak limit stron albo brak uczenia z poprawek, przekładają się bezpośrednio na godziny Twojej pracy albo koszt księgowej. Dlatego w tabeli porównawczej celowo eksponujemy te wiersze.
          </p>
          <p>
            Trzeci filar to cena całkowita posiadania (TCO): nawet jeśli pakiet startowy wygląda atrakcyjnie, suma add-onów za OCR, dodatkowe firmy czy wyższe limity dokumentów bywa nieprzewidywalna. FaktWay trzyma prostą zasadę: funkcje potrzebne do domknięcia KPiR i KSeF nie są zakładką &bdquo;Pro+&rdquo;, tylko rdzeniem produktu, stąd nacisk na jedną stawkę i {TRIAL_DAYS} dni za darmo jako realny hedge ryzyka dla mikrofirmy.
          </p>
        </section>

        <div className="mb-6 mt-16 flex items-baseline gap-4 border-b border-white/10 pb-4">
          <span className="editorial-section-num text-3xl">04.</span>
          <span className="text-[10px] uppercase tracking-[0.25em] text-[var(--marketing-muted)]">
            Tabela porównawcza
          </span>
        </div>
      </div>

      <div className="mx-auto max-w-[1280px] px-6 lg:px-8">
        <ComparisonTable competitorName="inFakt" rows={COMPARISON_ROWS} />
      </div>

      <div className="mx-auto max-w-[1280px] px-6 lg:px-8">
        <VsSectionHeader
          num="05"
          eyebrow="Pricing breakdown"
          title="Co zwykle jest w bazie, a co „dopłata”"
        />
        <section className="space-y-5 leading-relaxed text-[var(--marketing-muted)]">
          <p>
            Poniższy podział ma charakter edukacyjny i opiera się na typowym schemacie &bdquo;pakiet + moduły&rdquo;, który wielokrotnie widzimy u polskich SaaS księgowych, i nie jest prawnym opisem cennika konkurenta. Zanim podejmiesz decyzję, pobierz aktualny cennik inFakt i porównaj limity (liczba firm, użytkowników, dokumentów, integracji) linia po linii.
          </p>
          <ul className="space-y-0 border-t border-zinc-100">
            {[
              { k: 'Baza (najczęściej reklamowana stawka)', v: 'proste faktury sprzedaży, podstawowe rozliczenia, często sensowny start dla jednoosobowej działalności bez dużej skrzynki kosztowej.' },
              { k: 'Wyższe pakiety', v: 'więcej dokumentów, wielofirmowość, rozbudowane uprawnienia dla biura: tu cena rośnie skokowo, bo łączy się z limitami API i raportowania.' },
              { k: 'Odczyt dokumentów i automatyzacje', v: 'często jako osobny moduł albo feature-gating, dokładnie te elementy, które w FaktWay traktujemy jako standard przy mikrofirmie z dużą liczbą kosztów.' },
              { k: 'FaktWay (referencja)', v: `jedna stawka ${PRICE_PER_MONTH}, odczyt dokumentów w pakiecie (z limitem dziennym i miesięcznym), historia z KSeF i import z innych programów, przypomnienia, Co-Pilot księgowego i ${TRIAL_DAYS} dni za darmo, bez tajnych „upgrade’ów”, żeby domknąć miesiąc.` },
            ].map((item, i) => (
              <li
                key={item.k}
                className="grid grid-cols-12 gap-4 border-b border-zinc-100 py-4"
              >
                <span className="editorial-section-num col-span-1 text-xs">
                  {String(i + 1).padStart(2, '0')}.
                </span>
                <div className="col-span-11">
                  <p className="font-editorial text-base font-medium">{item.k}</p>
                  <p className="mt-1 text-sm text-[var(--marketing-muted)]">
                    {item.v}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <p>
            Jeśli porównujesz oferty, policz nie tylko miesięczny abonament, ale też koszt godziny Twojej pracy przy ręcznym poprawianiu odczytanych danych i koszt błędów wysyłki do KSeF. Ten mechanizm modelujemy w kalkulatorze oszczędności.
          </p>
        </section>
      </div>

      <VsChooseColumns
        competitorName="inFakt"
        whenChooseCompetitor={[
          'Masz etatową księgową, która zna produkt „na pamięć” i pilnuje limitów',
          'Większość dokumentów to proste faktury netto B2B',
          'Potrzebujesz głębokiej integracji z ekosystemem, w którym inFakt jest już osadzony',
          'Akceptujesz dopłaty za moduły odczytu dokumentów w zamian za markę „znaną z rynku”',
        ]}
        whenChooseUs={[
          'Masz paragony i faktury kosztowe, które muszą wejść do KPiR ze zdjęcia',
          'Przepisywanie dokumentów to Twój bottleneck, nie „nice to have”',
          'Chcesz przewidywalny rachunek: jedna stawka, pełne funkcje KSeF-first',
          'Pracujesz z telefonu i chcesz powiadomienia push i zdjęcia dokumentów w jednym produkcie',
        ]}
      />

      <div className="mx-auto max-w-[1280px] px-6 lg:px-8">
        <VsSectionHeader
          num="06"
          eyebrow="Migracja krok po kroku"
          title="Wyprowadzka z inFakt"
        />
        <ol className="space-y-0 border-t border-zinc-100">
          {[
            { k: 'Spisz checklistę', v: 'lista NIP-ów, użytkowników, integracji bankowych i okresów, które muszą wejść do nowego systemu bez luki w JPK.' },
            { k: 'Eksport z inFakt', v: 'pobierz plik CSV zgodnie z dokumentacją eksportu i zachowaj kopie na dysku zewnętrznym (audyt RODO).' },
            { k: 'KSeF jako źródło prawdy', v: 'po wgraniu certyfikatu FaktWay sam pobiera historię z KSeF, a starsze faktury wgrywasz plikiem CSV z inFaktu.' },
            { k: 'Walidacja brutto/netto', v: 'dla faktur gross przejdź próbkę 20 dokumentów i porównaj kwoty VAT z oryginałem.' },
            { k: 'Cut-over', v: 'ustal dzień przełączenia wysyłki nowych FA(3) tylko z FaktWay i poinformuj kontrahentów o ewentualnej zmianie numeracji.' },
            { k: 'Hypercare', v: 'przez 2 tygodnie sprawdzaj statusy faktur i UPO, a po stabilizacji pokaż księgowej Co-Pilota.' },
          ].map((step, i) => (
            <li
              key={step.k}
              className="grid grid-cols-12 gap-4 border-b border-zinc-100 py-4"
            >
              <span className="editorial-section-num col-span-1 text-xs">
                {String(i + 1).padStart(2, '0')}.
              </span>
              <div className="col-span-11">
                <p className="font-editorial text-base font-medium">{step.k}</p>
                <p className="mt-1 text-sm text-[var(--marketing-muted)]">
                  {step.v}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-6 font-editorial text-sm italic leading-relaxed text-[var(--marketing-muted)]">
          Jeśli potrzebujesz wsparcia przy imporcie wielofirmowym, napisz na {SUPPORT_EMAIL}.
        </p>

        <VsSectionHeader
          num="07"
          eyebrow="SEO + E-E-A-T"
          title="Słowa kluczowe i intencja wyszukiwania"
        />
        <section className="space-y-5 leading-relaxed text-[var(--marketing-muted)]">
          <p>
            Użytkownicy szukający &bdquo;inFakt vs &hellip;&rdquo;, &bdquo;inFakt KSeF 2.0&rdquo;, &bdquo;inFakt OCR cena&rdquo; mają wysoką intencję migracyjną, ale też wysokie oczekiwanie merytoryczne. Dlatego ta strona celowo miesza twardą tabelę funkcji z narracją o TCO, gross invoices i limitach odczytu: to są sygnały jakościowe, które Google coraz częściej wiąże z E-E-A-T (doświadczenie, ekspertyza, autorytet, wiarygodność). Nie obiecujemy cudów, pokazujemy, które decyzje produktowe realnie wpływają na Twój dzień pracy.
          </p>
          <p>
            Jeśli jesteś na etapie due diligence, zestaw tę stronę z naszym{' '}
            <Link
              href="/kalkulator-oszczednosci"
              className="font-editorial italic underline decoration-emerald-400 decoration-2 underline-offset-[4px] transition-all hover:decoration-[3px]"
            >
              kalkulatorem oszczędności
            </Link>
            ,{' '}
            <Link
              href="/pricing"
              className="font-editorial italic underline decoration-emerald-400 decoration-2 underline-offset-[4px] transition-all hover:decoration-[3px]"
            >
              cennikiem
            </Link>{' '}
            oraz regulaminem. Prowadzisz biuro rachunkowe?{' '}
            <Link
              href="/kontakt"
              className="font-editorial italic underline decoration-emerald-400 decoration-2 underline-offset-[4px] transition-all hover:decoration-[3px]"
            >
              napisz
            </Link>
            , ile firm planujesz przenieść.
          </p>
        </section>
      </div>

      <VsMigrationCta
        competitorName="inFakt"
        copy={`FaktWay sam pobiera historię z KSeF, a pliki eksportu inFakt wgrywasz jednym ruchem. Przez ${TRIAL_DAYS} dni sprawdzisz, jak odczyt radzi sobie z Twoimi dokumentami.`}
      />
    </article>
  );
}
