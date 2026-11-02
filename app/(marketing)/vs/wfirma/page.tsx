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

// Faza 22: comparison page — SEO ważne, cache na godzinę.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'FaktWay vs wFirma 2026: telefon, odczyt dokumentów i KSeF',
  description:
    'Porównanie FaktWay z wFirmą: praca w telefonie, odczyt dokumentów kosztowych, KSeF 2.0, cennik i migracja dla JDG i mikrofirm.',
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
    feature: 'Walidacja FA(3) przed wysyłką',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'yes' as const },
  },
  {
    category: 'KSeF 2026',
    feature: 'Retry kolejki przy 5xx MF',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Mobile',
    feature: 'Natywna aplikacja iOS / Android',
    ksefSaas: { status: 'partial' as const, note: 'przeglądarka telefonu i ekran główny' },
    competitor: { status: 'no' as const, note: 'brak app store' },
  },
  {
    category: 'Mobile',
    feature: 'Skan z aparatu „w terenie”',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const, note: 'przeglądarka' },
  },
  {
    category: 'Mobile',
    feature: 'Offline queue dokumentów',
    ksefSaas: { status: 'no' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Mobile',
    feature: 'Push: faktura opłacona / KSeF',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const, note: 'email/SMS' },
  },
  {
    category: 'Mobile',
    feature: 'Biometria / Face ID w flow logowania',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'OCR i dokumenty',
    feature: 'Odczyt wielostronicowych kosztów',
    ksefSaas: { status: 'partial' as const, note: 'plik do 10 MB' },
    competitor: { status: 'partial' as const, note: 'prostsze szablony' },
  },
  {
    category: 'OCR i dokumenty',
    feature: 'Odczyt przy słabym oświetleniu / cienie',
    ksefSaas: { status: 'partial' as const, note: 'dane sprawdzasz przed zapisem' },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'OCR i dokumenty',
    feature: 'Odczyt wielu plików naraz',
    ksefSaas: { status: 'no' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'OCR i dokumenty',
    feature: 'Ocena pewności + podświetlenie pól',
    ksefSaas: { status: 'no' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'KPiR',
    feature: 'Podpowiedź kolumny KPiR po odczycie',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'KPiR',
    feature: 'Poprawa wpisu KPiR po odczycie',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'yes' as const },
  },
  {
    category: 'Workflow',
    feature: 'Historia z KSeF i import CSV z 4 programów',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Workflow',
    feature: 'Przypomnienia i przedsądowe wezwania',
    ksefSaas: { status: 'yes' as const, note: 'po Twoim zatwierdzeniu' },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Workflow',
    feature: 'Co-Pilot Księgowego',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Cennik',
    feature: 'Przejrzysta stawka „wszystko w jednym”',
    ksefSaas: { status: 'note' as const, note: PRICE_PER_MONTH },
    competitor: { status: 'note' as const, note: 'pakiety wg skali' },
  },
  {
    category: 'Cennik',
    feature: 'Odczyt dokumentów bez osobnej faktury',
    ksefSaas: { status: 'yes' as const, note: 'z limitem dziennym i miesięcznym' },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Desktop',
    feature: 'Pełny back-office web (JDG)',
    ksefSaas: { status: 'partial' as const, note: 'faktury, koszty, KPiR' },
    competitor: { status: 'yes' as const },
  },
  {
    category: 'Desktop',
    feature: 'Zaawansowany moduł kadrowy',
    ksefSaas: { status: 'no' as const },
    competitor: { status: 'yes' as const, note: 'silna strona wFirma' },
  },
  {
    category: 'Hosting',
    feature: 'Dane w UE',
    ksefSaas: { status: 'yes' as const, note: 'Niemcy' },
    competitor: { status: 'yes' as const, note: 'PL' },
  },
  {
    category: 'Hosting',
    feature: 'Eksport po rezygnacji (30 dni)',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
] satisfies ComparisonRow[];

export default function WfirmaPage() {
  return (
    <article>
      <VsHero
        competitorName="wFirma"
        subtitle="Punkty porównawcze, historia produktu, cennik warstwowy i migracja, z naciskiem na telefon oraz odczyt kosztów."
      />

      <VsTldr>
        <span className="font-editorial font-medium text-[var(--marketing-text)]">
          wFirma
        </span>{' '}
        to potężny kombajn dla biur i większych JDG: kadry, pełniejszy
        back-office i doświadczenie w polskim compliance. Jednocześnie
        mikrofirmy mobilne często słyszą dwa argumenty przeciw:{' '}
        <strong className="font-semibold">brak dedykowanej aplikacji mobilnej</strong>{' '}
        w stylu &bdquo;otwieram, skanuję, wysyłam do KSeF w windzie&rdquo; oraz{' '}
        <strong className="font-semibold">ograniczenia odczytu</strong> na trudnych
        kosztach (wielostronicowe PDF-y, słabe zdjęcia, batch).{' '}
        <span className="font-editorial font-medium italic text-[var(--marketing-accent)]">
          FaktWay
        </span>{' '}
        nie próbuje zastąpić całego ERP, tylko koncentruje się na głównej ścieżce:
        KSeF, koszty ze zdjęcia, KPiR, przypomnienia i księgowa, także w przeglądarce
        telefonu.
      </VsTldr>

      <div className="mx-auto max-w-[1280px] px-6 lg:px-8">
        <VsSectionHeader
          num="01"
          eyebrow="Historia"
          title="Krótka historia wFirma i infrastruktura"
        />
        <section className="space-y-5 leading-relaxed text-[var(--marketing-muted)]">
          <p>
            wFirma wyrosła z potrzeby połączenia księgowości, kadrowej i rozliczeń ZUS w jednym ekosystemie dla
            polskiego przedsiębiorcy. Z biegiem lat produkt rozrósł się o moduły, które dla biura rachunkowego są
            błogosławieństwem: jeden login, spójne dane, rozbudowane raporty. To sprawia, że wFirma pozostaje
            silnym graczem w segmencie „wszystko w jednym oknie przeglądarki na desktopie”.
          </p>
          <p>
            Hosting i przetwarzanie danych utrzymywane są zwykle w polskiej chmurze lub u lokalnych operatorów,
            co ułatwia argumentację „dane nie opuszczają granic”. W erze KSeF 2.0 kluczowe staje się jednak nie
            tylko „gdzie leży backup”, ale jak szybko pracownik w terenie może dodać koszt: czy musi wracać do
            biura, czy może zamknąć sprawę na telefonie ze zdjęciem dokumentu i podglądem statusu wysyłki do Ministerstwa
            Finansów. Tu strategia mobile-first zaczyna dominować nad liczbą zakładek w menu desktopowym.
          </p>
          <p>
            Z perspektywy roadmapy, wFirma konsekwentnie rozbudowuje moduły kadrowe i integracje z bankami. To
            świetny wybór, gdy firma ma etat i skomplikowane listy płac. Natomiast jednoosobowa działalność
            usługowa, która żyje z telefonu i paragonów, często płaci ukrytym podatkiem czasu: brak natywnej apki
            oznacza walkę z zoomem w PDF-ie na małym ekranie i rezygnację z batch OCR, bo po prostu nie ma gdzie
            tego wygodnie ugryźć w drodze na budowę.
          </p>
        </section>

        <VsSectionHeader
          num="02"
          eyebrow="Głosy użytkowników"
          title="Zsyntetyzowane wątki publiczne"
        />
        <div className="grid gap-10 md:grid-cols-3 md:gap-12">
          {[
            { q: 'Na biurku wFirma jest super, ale jak jestem na budowie, wolę zrobić zdjęcie i wrzucić później. Szkoda, że nie ma normalnej apki.', meta: 'Dyskusja branżowa · 2025' },
            { q: 'OCR działa, ale jak dostaję 15-stronicowy cennik jako załącznik, to i tak robię ręcznie.', meta: 'Komentarz na grupie Facebook · 2024' },
            { q: 'Liczyłem, że telefon wystarczy do całego KPiR w podróży, a okazało się, że to raczej desktop first.', meta: 'Forum przedsiębiorców · 2025' },
          ].map((o) => (
            <figure
              key={o.meta}
              className="border-t-2 border-emerald-500/40 pt-6"
            >
              <blockquote className="font-editorial text-lg italic leading-snug text-[var(--marketing-muted)]">
                <span className="mr-1 font-editorial text-3xl leading-none text-[var(--marketing-accent)]">&bdquo;</span>
                {o.q}
                <span className="ml-0.5 font-editorial text-2xl leading-none text-[var(--marketing-accent)]">&rdquo;</span>
              </blockquote>
              <figcaption className="mt-4 text-[10px] uppercase tracking-[0.22em] text-[var(--marketing-muted)]">
                {o.meta}
              </figcaption>
            </figure>
          ))}
        </div>
        <p className="mt-8 font-editorial text-sm italic leading-relaxed text-[var(--marketing-muted)]">
          To nie są cytaty z konkretnych osób, lecz stylizowane streszczenia częstych obserwacji. Zawsze potwierdź stan funkcji na świeżym koncie trial i swoim zestawie dokumentów.
        </p>

        <VsSectionHeader
          num="03"
          eyebrow="Mobile vs desktop"
          title="Mobile-first vs desktop-first w erze KSeF"
        />
        <section className="space-y-5 leading-relaxed text-[var(--marketing-muted)]">
          <p>
            KSeF 2.0 zmienia psychologię pracy: status faktury nie jest już „pdf w mailu”, tylko rekord w systemie
            ministerialnym z numerem referencyjnym i audytem czasu. Oznacza to, że przedsiębiorca potrzebuje
            natychmiastowego feedbacku na telefonie: czy wysyłka się udała, czy wróciła walidacja FA(3), czy trzeba
            poprawić NIP kontrahenta. Powiadomienia push nie są już „fajnym dodatkiem”, tylko redukcją ryzyka
            utraty płynności, bo faktura nieopłacona często wynika z tego, że dokument utknął w
            „później zrobię na komputerze”.
          </p>
          <p>
            Odczyt w telefonie musi być tolerancyjny na złe warunki: lampka w aucie, papier termiczny paragonu,
            cień dłoni na kadrze. Ograniczenia w sensie „działa na idealnych skanach” przekładają się na
            powrót do ręcznego przepisywania. Dlatego w tabeli porównujemy nie tylko checkbox „OCR jest”,
            ale też trudne zdjęcia i wiele plików naraz.
          </p>
          <p>
            wFirma pozostaje mocna, gdy organizacja ma biuro, które zbiera dokumenty centralnie. FaktWay celuje
            w scenariusz „ja jestem biurem”: sam robisz zdjęcia, sprawdzasz kategorie, wysyłasz do KSeF, a księgowa
            dostaje gotową paczkę przez Co-Pilota. To dwa różne modele operacyjne: ważne, żebyś wybrał świadomie,
            a nie przez przypadek, bo „tak robi znajomy”.
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
        <ComparisonTable competitorName="wFirma" rows={COMPARISON_ROWS} />
      </div>

      <div className="mx-auto max-w-[1280px] px-6 lg:px-8">
        <VsSectionHeader
          num="05"
          eyebrow="Pricing breakdown"
          title="Gdzie rośnie koszt przy większej skali"
        />
        <section className="space-y-5 leading-relaxed text-[var(--marketing-muted)]">
          <p>
            wFirma stosuje klasyczny model pakietów zależnych od liczby dokumentów, użytkowników i modułów kadrowych. To uczciwe przy biurze obsługującym wiele spółek, ale bywa mniej przewidywalne dla JDG, która eksploduje liczbą kosztów w jednym kwartale (remont, import sprzętu, delegacje). Przy porównaniu zawsze policz: ile kosztuje dopięcie modułu, którego potrzebujesz tylko przez 3 miesiące, oraz czy odczyt dokumentów jest limitowany licznikami.
          </p>
          <ul className="space-y-0 border-t border-zinc-100">
            {[
              { k: 'Warstwa podstawowa', v: 'rozliczenia, faktury, często sensowny start bez pełnej „maszyny mobilnej”.' },
              { k: 'Warstwa rozszerzeń', v: 'wyższe limity dokumentów, integracje: koszt skokowy przy wzroście skali.' },
              { k: 'Kadry i płace', v: 'mocna strona wFirma: jeśli tego potrzebujesz, może to uzasadniać wyższy abonament.' },
              { k: 'FaktWay', v: `jedna stawka ${PRICE_PER_MONTH}, telefon, koszty ze zdjęcia i KSeF w jednym programie, ${TRIAL_DAYS} dni za darmo, czyli przewidywalny koszt dla mikrofirmy bez działu IT.` },
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
            Nie traktuj tego rozdziału jako aktualnego cennika: to mapa mentalna przy negocjacjach z księgową i przy szacowaniu kosztu migracji. Zawsze pobierz oficjalny cennik i regulamin z dnia dzisiejszego.
          </p>
        </section>
      </div>

      <VsChooseColumns
        competitorName="wFirma"
        whenChooseCompetitor={[
          'Prowadzisz lub obsługujesz biuro z pełnym modułem kadrowym',
          'Pracujesz głównie na desktopie i zbieracie dokumenty centralnie',
          'Potrzebujesz głębokiej integracji z polskim stackiem bankowo-księgowym',
          'Odczyt kosztów w telefonie nie jest Twoim głównym KPI (np. mało kosztów)',
        ]}
        whenChooseUs={[
          'Pracujesz z telefonu: budowy, dostawy, serwisy, taxi flota',
          'Przepisywanie kosztów to Twój bottleneck operacyjny',
          'Chcesz powiadomienia push i zdjęcia dokumentów bez obejść',
          'Szukasz prostszego TCO niż rosnące pakiety przy skoku dokumentów',
        ]}
      />

      <div className="mx-auto max-w-[1280px] px-6 lg:px-8">
        <VsSectionHeader
          num="06"
          eyebrow="Migracja krok po kroku"
          title="Wyprowadzka z wFirma"
        />
        <ol className="space-y-0 border-t border-zinc-100">
          {[
            { k: 'Inwentaryzacja modułów', v: 'zaznacz, które funkcje wFirma są krytyczne (np. kadry) i czy zostają równolegle na okres przejściowy.' },
            { k: 'Eksport danych', v: 'pobierz plik CSV z fakturami, który wczyta Import danych, i zachowaj kopie offline.' },
            { k: 'Import z KSeF', v: 'po wgraniu certyfikatu FaktWay sam pobiera historię z KSeF.' },
            { k: 'Test odczytu', v: 'weź 30 najtrudniejszych dokumentów z ostatniego kwartału i sprawdź, jak FaktWay je odczytuje.' },
            { k: 'Cut-over komunikacji', v: 'poinformuj kontrahentów o ewentualnej zmianie danych do płatności.' },
            { k: 'Okno stabilizacji', v: 'przez 14 dni sprawdzaj statusy faktur i UPO. Dopiero potem wyłączaj stary rutynowy eksport z wFirmy.' },
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

        <VsSectionHeader
          num="07"
          eyebrow="SEO + E-E-A-T"
          title="Długa fala wokół „wFirma vs …”"
        />
        <section className="space-y-5 leading-relaxed text-[var(--marketing-muted)]">
          <p>
            Zapytania porównawcze mają to do siebie, że użytkownik już zna oba brandy i szuka argumentów &bdquo;czy warto przesiadać się teraz, czy po lutym 2026&rdquo;. Dlatego ta strona łączy historię produktu, realne wątki mobilne, breakdown cenowy i procedurę migracji: to sygnały dla wyszukiwarki, że treść jest procesowa, a nie tylko landingiem z jednym CTA.
          </p>
          <p>
            Dodatkowo połącz tę analizę z{' '}
            <Link
              href="/kalkulator-oszczednosci"
              className="font-editorial italic underline decoration-emerald-400 decoration-2 underline-offset-[4px] transition-all hover:decoration-[3px]"
            >
              kalkulatorem oszczędności
            </Link>{' '}
            oraz{' '}
            <Link
              href="/pricing"
              className="font-editorial italic underline decoration-emerald-400 decoration-2 underline-offset-[4px] transition-all hover:decoration-[3px]"
            >
              stroną cennika
            </Link>
            . Masz pytania migracyjne?{' '}
            <Link
              href="/kontakt"
              className="font-editorial italic underline decoration-emerald-400 decoration-2 underline-offset-[4px] transition-all hover:decoration-[3px]"
            >
              Napisz do nas
            </Link>
            .
          </p>
          <p>
            Jeśli jesteś biurem rachunkowym i rozważasz hybrydę (część klientów na wFirma, część na FaktWay), opisz nam profil dokumentów.
          </p>
        </section>
      </div>

      <VsMigrationCta
        competitorName="wFirma"
        copy="Załóż konto, wgraj certyfikat KSeF i sprawdź odczyt na swoich dokumentach, zanim wypowiesz umowę u obecnego dostawcy."
      />
    </article>
  );
}
