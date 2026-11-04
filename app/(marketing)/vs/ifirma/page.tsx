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
  title: 'FaktWay vs iFirma 2026: interfejs, push i KSeF',
  description:
    'Porównanie FaktWay z iFirmą: interfejs, powiadomienia push, KSeF 2.0, odczyt dokumentów, cennik i migracja dla JDG oraz biur rachunkowych.',
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
    feature: 'Monitoring statusu po wysyłce',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Interfejs i UX',
    feature: 'Odświeżony wygląd panelu (2026)',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const, note: 'starszy UI' },
  },
  {
    category: 'Interfejs i UX',
    feature: 'Tryb ciemny spójny w całej aplikacji',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Interfejs i UX',
    feature: 'Skróty klawiszowe dla power userów',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Interfejs i UX',
    feature: 'Focus states / czytelność formularzy',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Powiadomienia',
    feature: 'Push web: status KSeF / UPO',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'no' as const, note: 'brak push' },
  },
  {
    category: 'Powiadomienia',
    feature: 'Push: wpłata na fakturze',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const, note: 'email/SMS' },
  },
  {
    category: 'Powiadomienia',
    feature: 'Ciche godziny / kanały per użytkownik',
    ksefSaas: { status: 'partial' as const, note: 'wybór powiadomień, bez cichych godzin' },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Mobile',
    feature: 'PWA instalowalna',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Mobile',
    feature: 'Zdjęcie z aparatu',
    ksefSaas: { status: 'partial' as const, note: 'bez przycinania' },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Koszty i KPiR',
    feature: 'Odczyt wielostronicowych kosztów',
    ksefSaas: { status: 'partial' as const, note: 'plik do 10 MB' },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Koszty i KPiR',
    feature: 'Ocena pewności dla każdego pola',
    ksefSaas: { status: 'no' as const },
    competitor: { status: 'no' as const },
  },
  {
    category: 'Koszty i KPiR',
    feature: 'Podpowiedź kolumny KPiR',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
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
    feature: 'Jedna stawka za całość',
    ksefSaas: { status: 'note' as const, note: PRICE_PER_MONTH },
    competitor: { status: 'note' as const, note: 'pakiety modułowe' },
  },
  {
    category: 'Integracje',
    feature: 'Webhooks / API dla automatyzacji',
    ksefSaas: { status: 'no' as const },
    competitor: { status: 'partial' as const },
  },
  {
    category: 'Hosting',
    feature: 'Dane w UE (GDPR)',
    ksefSaas: { status: 'yes' as const, note: 'Niemcy' },
    competitor: { status: 'yes' as const, note: 'PL' },
  },
  {
    category: 'Hosting',
    feature: 'Eksport pełny po rezygnacji (30 dni)',
    ksefSaas: { status: 'yes' as const },
    competitor: { status: 'partial' as const },
  },
] satisfies ComparisonRow[];

export default function IfirmaPage() {
  return (
    <article>
      <VsHero
        competitorName="iFirma"
        subtitle="Tabela porównania, historia marki, głosy użytkowników, rozbicie cen i migracja, z naciskiem na odświeżony interfejs oraz powiadomienia push."
      />

      <VsTldr>
        <span className="font-editorial font-medium text-[var(--marketing-text)]">
          iFirma
        </span>{' '}
        to jedna z najstarszych marek fakturowych w Polsce: stabilna,
        rozpoznawalna, z szeroką gamą funkcji &bdquo;wszystko w jednym
        panelu&rdquo;. Jednak w rozmowach z przedsiębiorcami mobilnymi pojawiają
        się dwa wątki:{' '}
        <strong className="font-semibold">postarzały interfejs</strong>{' '}
        (wolniejsza nawigacja, mniej współczesnych mikrointerakcji) oraz{' '}
        <strong className="font-semibold">brak sensownych pushy</strong> w
        modelu web-first, co oznacza, że status KSeF odkrywasz dopiero po
        wejściu na skrzynkę mailową.{' '}
        <span className="font-editorial font-medium italic text-[var(--marketing-accent)]">
          FaktWay
        </span>{' '}
        stawia na świeży interfejs, powiadomienia push i wysyłkę zaprojektowaną
        pod KSeF 2.0 w jednym pakiecie, bo &bdquo;widziałem status
        wysyłki&rdquo; nie może być funkcją premium.
      </VsTldr>

      <div className="mx-auto max-w-[1280px] px-6 lg:px-8">
        <VsSectionHeader
          num="01"
          eyebrow="Historia"
          title="Krótka historia iFirma i hosting"
        />
        <section className="space-y-5 leading-relaxed text-[var(--marketing-muted)]">
          <p>
            iFirma funkcjonuje na rynku od lat: przez dekadę zdążyła przejść przez wiele iteracji funkcjonalnych i
            integracji z polskimi systemami bankowymi. To ogromna zaleta dla użytkowników, którzy cenią
            przewidywalność marki i szeroką dokumentację. Jednocześnie długa historia produktu często oznacza
            narastającą złożoność menu, starsze wzorce UI oraz techniczny dług w warstwie front-end, który trudno
            przebudować bez szoku dla milionów użytkowników.
          </p>
          <p>
            Hosting i przetwarzanie danych utrzymywane są zwykle w polskiej infrastrukturze, co jest plusem przy
            negocjacjach z księgową i przy wymaganiach dotyczących lokalizacji kopii zapasowych. W erze KSeF 2.0
            kluczowe staje się jednak nie tylko „gdzie stoi serwer”, ale jak szybko widzisz błąd walidacji FA(3) na
            telefonie i czy naprawisz go bez przeklikiwania pięciu ekranów zaprojektowanych
            w czasach, gdy smartfon był jeszcze gadżetem.
          </p>
          <p>
            FaktWay nie próbuje sklonować całej historii iFirma. Celujemy w główną ścieżkę mikrofirmy: faktura,
            koszt, KPiR, KSeF, przypomnienia, księgowa. Dzięki temu możemy poświęcić więcej uwagi detalom (focus,
            tryb ciemny) oraz powiadomieniom push, które w codziennym życiu przedsiębiorcy zastępują
            „sprawdzę maila wieczorem”.
          </p>
        </section>

        <VsSectionHeader
          num="02"
          eyebrow="Opinie publiczne"
          title="Co mówią użytkownicy (parafrazy)"
        />
        <div className="grid gap-10 md:grid-cols-3 md:gap-12">
          {[
            { q: 'Wszystko jest, tylko szukanie tej jednej opcji zajmuje mi za dużo czasu. Czuję, że to UI z poprzedniej epoki.', meta: 'Wątek forum · 2025' },
            { q: 'Mail przychodzi, ale wolałbym push jak w banku. Wtedy od razu wiem, że KSeF przyjął fakturę.', meta: 'Komentarz LinkedIn · 2024' },
            { q: 'Jak już się nauczyłem, działa stabilnie, ale onboarding nowej osoby w firmie zajął tydzień.', meta: 'Grupa Facebook · 2025' },
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
          Cytaty są stylizowane i nie identyfikują konkretnych osób. Traktuj je jako ilustrację typowych frustracji UX / powiadomień, a nie jako ocenę sądową produktu konkurenta.
        </p>

        <VsSectionHeader
          num="03"
          eyebrow="UX + push"
          title="Dlaczego UI i push mają znaczenie przy KSeF"
        />
        <section className="space-y-5 leading-relaxed text-[var(--marketing-muted)]">
          <p>
            Interfejs to nie kwestia „ładnych ikonek”, tylko koszt błędu ludzkiego: im więcej kroków i rozproszenia
            uwagi, tym wyższe ryzyko pomyłki NIP, stawki VAT lub numeru faktury zaliczkowej. Przy KSeF 2.0 błąd
            walidacji oznacza stratę czasu na poprawkę, a czasem także problem z płynnością, jeśli kontrahent
            czeka na poprawny dokument. Nowoczesny layout z wyraźnymi stanami focusu i czytelną hierarchią sekcji
            redukuje ten koszt, szczególnie u przedsiębiorców pracujących wieczorami na laptopie w półświetle.
          </p>
          <p>
            Push z kolei zmienia model uwagi: zamiast „sprawdzę skrzynkę co godzinę”, dostajesz atomowy komunikat o
            statusie KSeF lub przypomnieniu o płatności. To nie zastępuje pełnego audytu w panelu, ale obniża latency
            Twojej reakcji, a przy windykacji i łańcuchu dostaw latency przekłada się bezpośrednio na cash flow.
            Dlatego w tabeli eksponujemy brak pushy jako twardy wiersz, a nie marketingowy przymiotnik.
          </p>
          <p>
            Starszy UI bywa jednocześnie zaletą dla użytkowników przyzwyczajonych do konkretnych ścieżek: jeśli
            pracujesz 10 lat w tym samym menu, zmiana może boleć. FaktWay adresuje osoby, które wolą odświeżone
            wzorce nawigacji i są gotowe na migrację, gdy historię z KSeF pobieramy sami, a resztę wgrywasz plikiem.
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
        <ComparisonTable competitorName="iFirma" rows={COMPARISON_ROWS} />
      </div>

      <div className="mx-auto max-w-[1280px] px-6 lg:px-8">
        <VsSectionHeader
          num="05"
          eyebrow="Pricing breakdown"
          title="Moduły vs jeden pakiet"
        />
        <section className="space-y-5 leading-relaxed text-[var(--marketing-muted)]">
          <p>
            iFirma tradycyjnie sprzedaje szeroki zestaw funkcji w modelu modułowym. To pozwala dopasować ofertę do biura rachunkowego, ale bywa mniej przejrzyste dla JDG, która chce po prostu KSeF, koszty ze zdjęcia i KPiR w jednym pakiecie. Przy porównaniu zawsze rozłóż cennik na: abonament bazowy, limity dokumentów, moduły kadrowe, integracje premium oraz ewentualne opłaty za szkolenie użytkowników.
          </p>
          <ul className="space-y-0 border-t border-zinc-100">
            {[
              { k: 'Warstwa wejścia', v: 'często atrakcyjna dla prostych faktur sprzedaży, ale bez pełnego stacku mobilnego i push.' },
              { k: 'Warstwa rozszerzeń', v: 'dodatkowe moduły, wyższe limity, integracje: koszt skokowy przy wzroście skali biura.' },
              { k: 'Koszty ukryte', v: 'czas pracy na szkoleniu nowych osób w złożonym UI oraz czas na ręczne sprawdzanie statusów, jeśli brak push.' },
              { k: 'FaktWay', v: `jedna stawka ${PRICE_PER_MONTH}, powiadomienia push, koszty ze zdjęcia i KSeF w jednym programie, ${TRIAL_DAYS} dni za darmo, czyli prostszy koszt dla mikrofirmy.` },
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
            Pamiętaj, że cenniki się zmieniają: zanim podejmiesz decyzję migracyjną, pobierz aktualny PDF z witryny iFirmy i porównaj go z naszym pricingiem oraz kalkulatorem oszczędności.
          </p>
        </section>
      </div>

      <VsChooseColumns
        competitorName="iFirma"
        whenChooseCompetitor={[
          'Znasz produkt latami i nie chcesz zmieniać nawyków menu',
          'Korzystasz głównie z desktopu i maila jako kanału informacji',
          'Potrzebujesz szerokiego zestawu funkcji biurowych w jednym koncie',
          'Push i mobile-first nie są Twoim krytycznym KPI',
        ]}
        whenChooseUs={[
          'Frustruje Cię czas znalezienia opcji w przeładowanym UI',
          'Chcesz push o statusie KSeF zamiast odświeżania skrzynki',
          'Pracujesz hybrydowo (telefon + laptop) i zależy Ci na spójnym dark mode',
          'Szukasz prostszego onboarding dla nowego pracownika',
        ]}
      />

      <div className="mx-auto max-w-[1280px] px-6 lg:px-8">
        <VsSectionHeader
          num="06"
          eyebrow="Migracja krok po kroku"
          title="Wyprowadzka z iFirma"
        />
        <ol className="space-y-0 border-t border-zinc-100">
          {[
            { k: 'Audyt danych', v: 'wypisz moduły iFirmy, z których korzystasz (sprzedaż, koszty, ZUS, księgowa) oraz integracje z bankiem.' },
            { k: 'Eksport', v: 'pobierz plik CSV zgodnie z instrukcją eksportu i zrób drugą kopię na nośnik zewnętrzny.' },
            { k: 'Import KSeF', v: 'po wgraniu certyfikatu FaktWay sam pobiera historię z KSeF.' },
            { k: 'Test', v: 'przejdź 10 najczęstszych scenariuszy (faktura, zaliczka, koszt ze zdjęcia) i zmierz czas przed i po.' },
            { k: 'Push i uprawnienia', v: 'skonfiguruj powiadomienia przeglądarki i dodaj FaktWay do ekranu głównego telefonu.' },
            { k: 'Hypercare', v: 'przez 14 dni sprawdzaj statusy faktur i pytania księgowej. Po stabilizacji przestań logować się do starego panelu.' },
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
          title="Topical authority wokół „iFirma vs …”"
        />
        <section className="space-y-5 leading-relaxed text-[var(--marketing-muted)]">
          <p>
            Strony porównawcze rankują lepiej, gdy łączą tabelę funkcji z narracją ekspercką: historia produktu, hosting, cennik, migracja, cytaty użytkowników i sekcję o ryzyku operacyjnym. Dzięki temu wyszukiwarka widzi nie tylko listę checkboxów, ale kontekst decyzyjny mikrofirmy, czyli dokładnie to, czego szuka użytkownik wpisując długie zapytanie z nazwą konkurenta.
          </p>
          <p>
            Powiąż lekturę z{' '}
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
            oraz{' '}
            <Link
              href="/kontakt"
              className="font-editorial italic underline decoration-emerald-400 decoration-2 underline-offset-[4px] transition-all hover:decoration-[3px]"
            >
              kontaktem
            </Link>
            , żeby zbudować graf wewnętrznych powiązań tematycznych.
          </p>
          <p>
            Jeśli jesteś biurem rachunkowym i chcesz zaproponować klientom hybrydę (część na iFirma, część na FaktWay), napisz na {SUPPORT_EMAIL} z informacją o liczbie podmiotów.
          </p>
        </section>
      </div>

      <VsMigrationCta
        competitorName="iFirma"
        copy="Załóż konto, dodaj FaktWay do ekranu głównego, włącz powiadomienia push i sprawdź je przy pierwszej wysyłce FA(3)."
      />
    </article>
  );
}
