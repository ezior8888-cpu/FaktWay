-- ═══════════════════════════════════════════════════════════════
-- 00199: serie numeracji faktur sprzedaży z licznikami (plan kompletnej
-- aplikacji, docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 2.5).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem kodu. Addytywna: dwie nowe tabele, cztery
-- kolumny NULL w `invoices` (bez wartości domyślnej, więc bez przepisywania
-- tabeli), klucz obcy i CHECK, które istniejące wiersze spełniają (same NULL),
-- dwa indeksy częściowe na `invoices`, nowe funkcje i trzy wyzwalacze na
-- `invoices`, które działają tylko na wierszach z nowymi kolumnami (WHEN).
-- Stara wersja aplikacji nowych kolumn nie zna i zapisuje faktury jak dotąd.
-- DROP/DML: brak. Bez DROP tabel i kolumn, bez TRUNCATE i DELETE przy
-- wgraniu i bez wypełniania danych: istniejące faktury i ich numery zostają
-- bez zmian, a żadna firma nie dostaje serii przy wgraniu. Firma bez serii
-- numeruje jak dotąd (podpowiedź: kolejny numer po ostatniej fakturze).
-- Seria podstawowa (bez wzoru, numeracja jak dotąd, domyślna dla wszystkich
-- rodzajów) powstaje dopiero przy pierwszej zmianie numeracji w ustawieniach,
-- w tej samej transakcji co ta zmiana (RPC niżej).
--
-- Po co: art. 106e ust. 1 pkt 2 ustawy o VAT: faktura ma kolejny numer
-- nadany w ramach jednej lub więcej serii, który jednoznacznie ją
-- identyfikuje. Klient dostaje serie (np. osobną dla faktur walutowych albo
-- innego miejsca sprzedaży), własny wzór numeru (rok, miesiąc, licznik,
-- przedrostek) i podpowiedź numeru dla każdego rodzaju dokumentu.
--
-- 1. Wzór numeru: elementy {RRRR} (rok), {MM} (miesiąc z zerem), {M}
--    (miesiąc), {N}..{NNNNNN} (licznik, liczba N to najmniejsza liczba cyfr),
--    poza nimi litery bez polskich znaków, cyfry, spacja i / . _ -.
--    `invoice_number_pattern_problem` odrzuca wzór bez licznika, z elementem
--    dwa razy, z miesiącem bez roku i z licznikiem obok {M} bez znaku, który
--    nie jest cyfrą (dwa różne numery wyglądałyby tak samo). Licznik liczy
--    się od 1 co miesiąc (wzór z miesiącem), co rok (z rokiem) albo bez
--    zerowania. Te same reguły ma aplikacja (lib/numeracja/wzor.ts); zgodność
--    sprawdza tests/rls-numeracja.test.ts.
-- 2. `invoice_number_series`: serie firmy (nazwa, wzór albo NULL dla serii
--    podstawowej „jak dotąd”, rodzaje, dla których seria jest domyślna,
--    ukrycie). Każdy rodzaj ma dokładnie jedną serię domyślną (pilnują RPC
--    pod blokadą ustawień firmy). Dwie serie firmy nie mają tego samego
--    układu numeru (znaki poza cyframi, `invoice_number_pattern_skeleton`),
--    więc ich numery się nie mylą.
-- 3. `invoice_number_counters`: ostatni nadany licznik serii w okresie.
-- 4. `invoices`: `number_series_id`, `number_period`, `number_counter`,
--    `number_request_key`. Numer z licznika nadaje wyzwalacz
--    `zzz_invoice_number_assign` w transakcji zapisu faktury: blokada serii
--    (pg_advisory_xact_lock), sprawdzenie, że licznik to kolejny wolny
--    (numer zajęty przez inną fakturę sprzedaży firmy, także wycofany szkic
--    po 440 albo fakturę z KSeF, jest pomijany), zapis licznika. Inny licznik
--    to `invoice_number_moved` (aplikacja bierze kolejny numer i ponawia).
--    UNIQUE (seria, okres, licznik) i UNIQUE numeru sprzedaży w firmie
--    (00120) to druga ochrona. Klucz zapisu (UNIQUE firma, klucz) z jednego
--    otwarcia formularza: drugi zapis to `invoice_number_request_done`.
--    Numer wpisany ręcznie zapisuje się z serią, bez licznika.
-- 5. Zwrot numeru: usunięcie OSTATNIEGO szkicu z licznika, który nigdy nie
--    miał kontaktu z KSeF (bez wpisu w ksef_submissions i w kolejce
--    Offline24), cofa licznik o jeden (`zzz_invoice_number_release`), żeby
--    w serii nie zostawała luka. Numer, który dotarł do KSeF, nie wraca nigdy
--    (blokada numeru zajętego w KSeF z planu zero zgubionych faktur zostaje).
-- 6. Seria, okres, licznik i klucz zapisu ustawia tylko zapis faktury:
--    sesja klienta ich nie zmienia (`e_guard_invoice_number_series_update`).
--
-- Kto: seriami zarządza właściciel i administrator (jak danymi firmy);
-- wystawia z serii każdy aktywny członek firmy (jak faktury). Firma i rola
-- z sesji (get_current_tenant_id, has_org_role), nie z argumentów. Audyt
-- (`invoice_number_series.*`) w tej samej transakcji co zmiana.
--
-- Uprawnienia: domyślne granty Supabase dają nowej tabeli ALL (także TRUNCATE,
-- które omija RLS), dlatego najpierw REVOKE ALL, potem jawne granty: sesja
-- tylko czyta (RLS: własna firma), zapis wyłącznie przez funkcje SECURITY
-- DEFINER i wyzwalacz. `service_role` czyta (nocny backup) i usuwa
-- (sprzątanie firm testowych, operator za zgodą Bartosza).
-- Rejestr numerów: docs/koordynacja/CLAUDE-DO-CODEXA.md.
-- ═══════════════════════════════════════════════════════════════

-- ─── wzór numeru: problem, układ, okres, numer (funkcje czyste) ──
CREATE OR REPLACE FUNCTION public.invoice_number_pattern_problem(p_pattern text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_literal text;
  v_years integer;
  v_months integer;
  v_counters integer;
  v_counter text;
  v_month_at integer;
  v_counter_at integer;
  v_between text;
BEGIN
  IF p_pattern IS NULL OR btrim(p_pattern) = '' THEN
    RETURN 'empty';
  END IF;
  IF char_length(p_pattern) > 30 THEN
    RETURN 'too_long';
  END IF;
  v_literal := regexp_replace(p_pattern, '\{(RRRR|MM|M|N{1,6})\}', '', 'g');
  IF v_literal ~ '[{}]' THEN
    RETURN 'unknown_token';
  END IF;
  IF v_literal !~ '^[A-Za-z0-9 /._-]*$' OR p_pattern <> btrim(p_pattern) THEN
    RETURN 'bad_char';
  END IF;
  SELECT count(*) INTO v_years FROM regexp_matches(p_pattern, '\{RRRR\}', 'g');
  SELECT count(*) INTO v_months FROM regexp_matches(p_pattern, '\{MM?\}', 'g');
  SELECT count(*) INTO v_counters FROM regexp_matches(p_pattern, '\{N{1,6}\}', 'g');
  IF v_counters = 0 THEN
    RETURN 'no_counter';
  END IF;
  IF v_years > 1 OR v_months > 1 OR v_counters > 1 THEN
    RETURN 'duplicate_token';
  END IF;
  IF v_months = 1 AND v_years = 0 THEN
    RETURN 'month_without_year';
  END IF;
  -- {M} i licznik mają zmienną liczbę cyfr: między nimi musi stać znak, który
  -- nie jest cyfrą ({RRRR} to same cyfry, więc nie rozdziela).
  v_month_at := strpos(p_pattern, '{M}');
  IF v_month_at > 0 THEN
    v_counter := substring(p_pattern FROM '\{N{1,6}\}');
    v_counter_at := strpos(p_pattern, v_counter);
    IF v_month_at < v_counter_at THEN
      v_between := substr(p_pattern, v_month_at + 3, v_counter_at - v_month_at - 3);
    ELSE
      v_between := substr(p_pattern, v_counter_at + char_length(v_counter),
                          v_month_at - v_counter_at - char_length(v_counter));
    END IF;
    IF regexp_replace(v_between, '\{RRRR\}', '', 'g') !~ '[^0-9]' THEN
      RETURN 'ambiguous';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.invoice_number_pattern_problem(text) IS
  '00199: kod problemu wzoru numeru faktury (empty, too_long, bad_char, unknown_token, no_counter, duplicate_token, month_without_year, ambiguous) albo NULL, gdy wzór jest poprawny. Te same reguły: lib/numeracja/wzor.ts.';

-- Znaki poza cyframi w kolejności, wielkimi literami: elementy wzoru dają
-- same cyfry, więc dwa wzory o różnym układzie nie dadzą tego samego numeru.
CREATE OR REPLACE FUNCTION public.invoice_number_pattern_skeleton(p_pattern text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT upper(regexp_replace(regexp_replace(p_pattern, '\{(RRRR|MM|M|N{1,6})\}', '', 'g'), '[0-9]', '', 'g'));
$$;

COMMENT ON FUNCTION public.invoice_number_pattern_skeleton(text) IS
  '00199: układ numeru (znaki wzoru poza elementami i cyframi, wielkimi literami). Unikalny w firmie: numery dwóch serii się nie mylą.';

-- Okres licznika z daty wystawienia: RRRR-MM (wzór z miesiącem), RRRR (z rokiem), '' (bez zerowania).
CREATE OR REPLACE FUNCTION public.invoice_number_period(p_pattern text, p_issue_date date)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_pattern IS NULL OR p_issue_date IS NULL THEN NULL
    WHEN p_pattern ~ '\{MM?\}' THEN
      EXTRACT(YEAR FROM p_issue_date)::integer::text || '-'
        || lpad(EXTRACT(MONTH FROM p_issue_date)::integer::text, 2, '0')
    WHEN strpos(p_pattern, '{RRRR}') > 0 THEN EXTRACT(YEAR FROM p_issue_date)::integer::text
    ELSE ''
  END;
$$;

COMMENT ON FUNCTION public.invoice_number_period(text, date) IS
  '00199: okres licznika serii z daty wystawienia: RRRR-MM, RRRR albo pusty (licznik bez zerowania).';

-- Numer z wzoru, okresu i licznika. Licznik dłuższy niż liczba N nie jest obcinany.
CREATE OR REPLACE FUNCTION public.invoice_number_render(p_pattern text, p_period text, p_counter integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_out text := p_pattern;
  v_token text;
  v_digits text;
  v_width integer;
BEGIN
  IF p_pattern IS NULL OR p_period IS NULL OR p_counter IS NULL OR p_counter < 1
     OR p_period !~ '^([0-9]{4}(-(0[1-9]|1[0-2]))?)?$' THEN
    RETURN NULL;
  END IF;
  IF strpos(v_out, '{RRRR}') > 0 THEN
    IF char_length(p_period) < 4 THEN
      RETURN NULL;
    END IF;
    v_out := replace(v_out, '{RRRR}', left(p_period, 4));
  END IF;
  IF strpos(v_out, '{MM}') > 0 OR strpos(v_out, '{M}') > 0 THEN
    IF char_length(p_period) <> 7 THEN
      RETURN NULL;
    END IF;
    v_out := replace(v_out, '{MM}', substr(p_period, 6, 2));
    v_out := replace(v_out, '{M}', substr(p_period, 6, 2)::integer::text);
  END IF;
  v_token := substring(v_out FROM '\{N{1,6}\}');
  IF v_token IS NULL THEN
    RETURN NULL;
  END IF;
  v_width := char_length(v_token) - 2;
  v_digits := p_counter::text;
  IF char_length(v_digits) < v_width THEN
    v_digits := lpad(v_digits, v_width, '0');
  END IF;
  RETURN replace(v_out, v_token, v_digits);
END;
$$;

COMMENT ON FUNCTION public.invoice_number_render(text, text, integer) IS
  '00199: numer faktury z wzoru, okresu (RRRR-MM, RRRR albo pusty) i licznika; NULL, gdy okres nie pasuje do wzoru. To samo: lib/numeracja/wzor.ts.';

-- Rodzaje dokumentów w stałej kolejności, bez powtórzeń; NULL przy nieznanym rodzaju.
CREATE OR REPLACE FUNCTION public.invoice_number_kinds(p_kinds text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_kinds IS NULL THEN ARRAY[]::text[]
    WHEN NOT (p_kinds <@ ARRAY['regular', 'advance', 'final', 'correction']::text[]) THEN NULL
    ELSE ARRAY(
      SELECT t.kind
        FROM unnest(ARRAY['regular', 'advance', 'final', 'correction']::text[]) WITH ORDINALITY AS t(kind, ord)
       WHERE t.kind = ANY (p_kinds)
       ORDER BY t.ord
    )
  END;
$$;

-- ─── invoice_number_series: serie firmy ─────────────────────────
CREATE TABLE public.invoice_number_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- NULL: seria podstawowa „jak dotąd” (numer z pola, podpowiedź po ostatniej fakturze).
  pattern text,
  -- Rodzaje (regular, advance, final, correction), dla których seria jest domyślna.
  default_kinds text[] NOT NULL DEFAULT ARRAY[]::text[],
  active boolean NOT NULL DEFAULT true,
  -- SET NULL przy usunięciu konta (RODO, jak 00154).
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_number_series_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT invoice_number_series_name_check CHECK (char_length(name) BETWEEN 1 AND 60 AND name = btrim(name)),
  CONSTRAINT invoice_number_series_pattern_check CHECK (pattern IS NULL OR public.invoice_number_pattern_problem(pattern) IS NULL),
  CONSTRAINT invoice_number_series_kinds_check CHECK (default_kinds <@ ARRAY['regular', 'advance', 'final', 'correction']::text[]),
  CONSTRAINT invoice_number_series_active_check CHECK (active OR cardinality(default_kinds) = 0)
);

COMMENT ON TABLE public.invoice_number_series IS
  '00199 (krok 2.5): serie numeracji faktur sprzedaży firmy. Wzór NULL = seria podstawowa „jak dotąd”. Zapis tylko przez RPC invoice_number_series_* (właściciel, administrator); każdy rodzaj ma jedną serię domyślną.';

CREATE UNIQUE INDEX uq_invoice_number_series_name
  ON public.invoice_number_series (tenant_id, lower(name));
-- Jedna seria podstawowa „jak dotąd” na firmę.
CREATE UNIQUE INDEX uq_invoice_number_series_legacy
  ON public.invoice_number_series (tenant_id) WHERE pattern IS NULL;
-- Numery dwóch serii firmy się nie mylą (ten sam układ = te same numery możliwe).
CREATE UNIQUE INDEX uq_invoice_number_series_skeleton
  ON public.invoice_number_series (tenant_id, public.invoice_number_pattern_skeleton(pattern))
  WHERE pattern IS NOT NULL;

-- ─── invoice_number_counters: licznik serii w okresie ───────────
CREATE TABLE public.invoice_number_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  series_id uuid NOT NULL,
  -- RRRR-MM, RRRR albo '' (licznik bez zerowania), jak invoice_number_period.
  period text NOT NULL,
  -- Ostatni nadany licznik (0, gdy seria zaczyna od 1 po zwrocie numeru).
  last_value integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_number_counters_series_period_key UNIQUE (series_id, period),
  CONSTRAINT invoice_number_counters_series_fk
    FOREIGN KEY (tenant_id, series_id) REFERENCES public.invoice_number_series (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT invoice_number_counters_period_check CHECK (period ~ '^([0-9]{4}(-(0[1-9]|1[0-2]))?)?$'),
  CONSTRAINT invoice_number_counters_value_check CHECK (last_value BETWEEN 0 AND 9999999)
);

COMMENT ON TABLE public.invoice_number_counters IS
  '00199 (krok 2.5): ostatni nadany licznik serii w okresie. Pisze wyzwalacz zapisu faktury (zzz_invoice_number_assign) pod blokadą serii i RPC invoice_number_series_create (pierwszy numer); cofa o jeden zwrot numeru po usunięciu ostatniego szkicu bez kontaktu z KSeF.';

CREATE INDEX idx_invoice_number_counters_tenant
  ON public.invoice_number_counters (tenant_id);

-- ─── invoices: seria, okres, licznik i klucz zapisu ─────────────
ALTER TABLE public.invoices
  ADD COLUMN number_series_id uuid,
  ADD COLUMN number_period text,
  ADD COLUMN number_counter integer,
  ADD COLUMN number_request_key uuid;

-- Bez akcji przy usunięciu: serii z fakturami nie usuwa się (RPC odmawia),
-- a sprzątanie firmy usuwa faktury i serie jednym poleceniem.
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_number_series_fk
    FOREIGN KEY (tenant_id, number_series_id) REFERENCES public.invoice_number_series (tenant_id, id),
  ADD CONSTRAINT invoices_number_counter_check CHECK (
    (number_counter IS NULL AND number_period IS NULL)
    OR (number_counter > 0 AND number_period IS NOT NULL AND number_series_id IS NOT NULL)
  );

COMMENT ON COLUMN public.invoices.number_series_id IS
  '00199: seria numeracji faktury (z licznika albo numer wpisany ręcznie w serii); NULL: numeracja sprzed serii.';
COMMENT ON COLUMN public.invoices.number_counter IS
  '00199: licznik serii nadany pod blokadą serii w transakcji zapisu (wyzwalacz zzz_invoice_number_assign); NULL: numer wpisany ręcznie.';
COMMENT ON COLUMN public.invoices.number_request_key IS
  '00199: klucz zapisu z jednego otwarcia formularza; drugi zapis z tym kluczem nie tworzy drugiej faktury.';

-- Jeden licznik w serii i okresie; klucz obcy serii ma z tego indeks.
CREATE UNIQUE INDEX uq_invoices_number_series_counter
  ON public.invoices (number_series_id, number_period, number_counter)
  WHERE number_series_id IS NOT NULL;
CREATE UNIQUE INDEX uq_invoices_number_request_key
  ON public.invoices (tenant_id, number_request_key)
  WHERE number_request_key IS NOT NULL;

-- ─── kolejny wolny licznik serii (pomocnicza, firma z argumentu) ─
-- Numer zajęty przez inną fakturę sprzedaży firmy (wpisany ręcznie, z KSeF,
-- wycofany szkic po 440, w każdym stanie) pomijamy: licznik idzie dalej,
-- a zajęty numer nie wraca. NULL: 1000 zajętych numerów z rzędu.
CREATE OR REPLACE FUNCTION public.invoice_number_next_counter(
  p_tenant_id uuid, p_series_id uuid, p_pattern text, p_period text
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_try integer;
  v_number text;
BEGIN
  SELECT c.last_value + 1 INTO v_try
    FROM public.invoice_number_counters AS c
   WHERE c.series_id = p_series_id AND c.period = p_period;
  IF v_try IS NULL THEN
    v_try := 1;
  END IF;
  FOR v_step IN 1..1000 LOOP
    v_number := public.invoice_number_render(p_pattern, p_period, v_try);
    IF v_number IS NULL THEN
      RETURN NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.invoices AS inv
       WHERE inv.tenant_id = p_tenant_id
         AND inv.direction = 'outgoing'
         AND inv.internal_number = v_number
    ) THEN
      RETURN v_try;
    END IF;
    v_try := v_try + 1;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoice_number_preview_of(
  p_tenant_id uuid, p_series_id uuid, p_pattern text, p_issue_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_period text := public.invoice_number_period(p_pattern, p_issue_date);
  v_counter integer;
BEGIN
  v_counter := public.invoice_number_next_counter(p_tenant_id, p_series_id, p_pattern, v_period);
  IF v_counter IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'number', public.invoice_number_render(p_pattern, v_period, v_counter),
    'counter', v_counter,
    'period', v_period
  );
END;
$$;

-- Seria podstawowa „jak dotąd”, gdy firma nie ma jeszcze żadnej serii:
-- domyślna dla wszystkich rodzajów, więc nowa seria przejmuje tylko te
-- rodzaje, które wskaże klient, a numeracja pozostałych się nie zmienia.
CREATE OR REPLACE FUNCTION public.invoice_number_series_ensure_default(p_tenant_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.invoice_number_series AS s WHERE s.tenant_id = p_tenant_id) THEN
    RETURN;
  END IF;
  INSERT INTO public.invoice_number_series (tenant_id, name, pattern, default_kinds, created_by)
  VALUES (p_tenant_id, 'Podstawowa', NULL, ARRAY['regular', 'advance', 'final', 'correction'], p_user_id)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    p_tenant_id, p_user_id, 'invoice_number_series.created', 'invoice_number_series', v_id,
    jsonb_build_object(
      'name', 'Podstawowa',
      'pattern', NULL::text,
      'defaultKinds', to_jsonb(ARRAY['regular', 'advance', 'final', 'correction']),
      'automatic', true
    )
  );
END;
$$;

-- ─── wyzwalacz: numer z licznika serii w transakcji zapisu ──────
CREATE OR REPLACE FUNCTION public.invoice_number_assign()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_series public.invoice_number_series%ROWTYPE;
  v_period text;
  v_next integer;
BEGIN
  -- Sesja klienta zapisuje fakturę tylko swojej firmy (RLS sprawdza to dopiero
  -- po wyzwalaczach): obca firma nie podejrzy licznika cudzej serii w błędzie.
  IF auth.uid() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM public.get_current_tenant_id() THEN
    RAISE EXCEPTION 'invoice_number_foreign_tenant' USING ERRCODE = '42501';
  END IF;
  -- Drugi zapis z tego samego otwarcia formularza (podwójne kliknięcie,
  -- ponowienie po zerwanym połączeniu): bez drugiej faktury.
  IF NEW.number_request_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.invoices AS inv
     WHERE inv.tenant_id = NEW.tenant_id AND inv.number_request_key = NEW.number_request_key
  ) THEN
    RAISE EXCEPTION 'invoice_number_request_done' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.number_series_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.direction IS DISTINCT FROM 'outgoing' THEN
    RAISE EXCEPTION 'invoice_number_series_outgoing_only' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_series
    FROM public.invoice_number_series AS s
   WHERE s.id = NEW.number_series_id AND s.tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_number_series_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_series.active THEN
    RAISE EXCEPTION 'invoice_number_series_archived' USING ERRCODE = 'P0001';
  END IF;
  -- Numer wpisany ręcznie w serii: bez licznika (UNIQUE numeru pilnuje dubli).
  IF NEW.number_counter IS NULL THEN
    RETURN NEW;
  END IF;
  IF v_series.pattern IS NULL THEN
    RAISE EXCEPTION 'invoice_number_series_no_pattern' USING ERRCODE = 'P0001';
  END IF;

  -- Blokada serii do końca transakcji: dwa zapisy naraz idą po kolei, a każde
  -- polecenie po blokadzie widzi liczniki i faktury zatwierdzone przez
  -- poprzednika (READ COMMITTED, nowa migawka na polecenie).
  PERFORM pg_advisory_xact_lock(hashtextextended('invoice_number_series:' || v_series.id::text, 0));

  v_period := public.invoice_number_period(v_series.pattern, NEW.issue_date);
  IF NEW.number_period IS DISTINCT FROM v_period
     OR NEW.internal_number IS DISTINCT FROM public.invoice_number_render(v_series.pattern, v_period, NEW.number_counter) THEN
    RAISE EXCEPTION 'invoice_number_mismatch' USING ERRCODE = 'P0001';
  END IF;
  v_next := public.invoice_number_next_counter(NEW.tenant_id, v_series.id, v_series.pattern, v_period);
  IF v_next IS NULL THEN
    RAISE EXCEPTION 'invoice_number_exhausted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.number_counter <> v_next THEN
    RAISE EXCEPTION 'invoice_number_moved' USING ERRCODE = 'P0001',
      DETAIL = public.invoice_number_render(v_series.pattern, v_period, v_next);
  END IF;
  INSERT INTO public.invoice_number_counters (tenant_id, series_id, period, last_value)
  VALUES (NEW.tenant_id, v_series.id, v_period, v_next)
  ON CONFLICT (series_id, period) DO UPDATE
    SET last_value = EXCLUDED.last_value, updated_at = now();
  RETURN NEW;
END;
$$;

-- Ostatni w kolejności wyzwalaczy BEFORE INSERT (po strażnikach a_..zz_), więc
-- licznik i blokada tylko dla wiersza, który przeszedł pozostałe sprawdzenia.
CREATE TRIGGER zzz_invoice_number_assign
  BEFORE INSERT ON public.invoices
  FOR EACH ROW
  WHEN (NEW.number_series_id IS NOT NULL OR NEW.number_request_key IS NOT NULL)
  EXECUTE FUNCTION public.invoice_number_assign();

-- ─── wyzwalacz: zwrot numeru po usunięciu ostatniego szkicu ─────
-- Tylko szkic, który nigdy nie miał kontaktu z KSeF (bez wpisu w historii
-- wysyłek i w kolejce Offline24), i tylko gdy jego licznik jest ostatni:
-- wtedy następna faktura dostaje ten sam numer i w serii nie ma luki.
-- Numer, który dotarł do KSeF (także wycofany szkic po 440, usunięty przez
-- serwis), nie wraca nigdy.
CREATE OR REPLACE FUNCTION public.invoice_number_release()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.ksef_status IS DISTINCT FROM 'draft'
     OR OLD.direction IS DISTINCT FROM 'outgoing'
     OR EXISTS (SELECT 1 FROM public.ksef_submissions AS s WHERE s.invoice_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.ksef_offline_queue AS q WHERE q.invoice_id = OLD.id) THEN
    RETURN OLD;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('invoice_number_series:' || OLD.number_series_id::text, 0));
  UPDATE public.invoice_number_counters AS c
     SET last_value = c.last_value - 1, updated_at = now()
   WHERE c.series_id = OLD.number_series_id
     AND c.period = OLD.number_period
     AND c.last_value = OLD.number_counter;
  RETURN OLD;
END;
$$;

CREATE TRIGGER zzz_invoice_number_release
  BEFORE DELETE ON public.invoices
  FOR EACH ROW
  WHEN (OLD.number_counter IS NOT NULL)
  EXECUTE FUNCTION public.invoice_number_release();

-- ─── wyzwalacz: seria, okres, licznik i klucz tylko przy zapisie ─
-- Sesja klienta nie przepina faktury do innej serii ani nie zmienia licznika
-- (licznik opisuje numer nadany pod blokadą). Serwis może (operator).
CREATE OR REPLACE FUNCTION public.guard_invoice_number_series_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'invoice_number_series_locked' USING ERRCODE = '42501',
      DETAIL = 'Seria, okres, licznik i klucz zapisu ustawia tylko zapis faktury.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER e_guard_invoice_number_series_update
  BEFORE UPDATE OF number_series_id, number_period, number_counter, number_request_key ON public.invoices
  FOR EACH ROW
  WHEN (NEW.number_series_id IS DISTINCT FROM OLD.number_series_id
        OR NEW.number_period IS DISTINCT FROM OLD.number_period
        OR NEW.number_counter IS DISTINCT FROM OLD.number_counter
        OR NEW.number_request_key IS DISTINCT FROM OLD.number_request_key)
  EXECUTE FUNCTION public.guard_invoice_number_series_update();

-- ─── RLS: odczyt członków firmy; zapis tylko przez funkcje ──────
ALTER TABLE public.invoice_number_series ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoice_number_series_select_own_tenant" ON public.invoice_number_series
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

ALTER TABLE public.invoice_number_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoice_number_counters_select_own_tenant" ON public.invoice_number_counters
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

REVOKE ALL ON public.invoice_number_series FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.invoice_number_series TO authenticated;
GRANT SELECT, DELETE ON public.invoice_number_series TO service_role;

REVOKE ALL ON public.invoice_number_counters FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.invoice_number_counters TO authenticated;
GRANT SELECT, DELETE ON public.invoice_number_counters TO service_role;

-- ─── RPC: serie firmy z kolejnym numerem (formularze, ustawienia) ─
CREATE OR REPLACE FUNCTION public.invoice_number_series_overview(p_issue_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_day date := COALESCE(p_issue_date, (now() AT TIME ZONE 'Europe/Warsaw')::date);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Invoice numbering requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('series', COALESCE((
    SELECT jsonb_agg(
             jsonb_build_object(
               'id', s.id,
               'name', s.name,
               'pattern', s.pattern,
               'default_kinds', to_jsonb(s.default_kinds),
               'active', s.active,
               'used', EXISTS (
                 SELECT 1 FROM public.invoices AS inv
                  WHERE inv.tenant_id = v_tenant_id AND inv.number_series_id = s.id
               ),
               'next', CASE WHEN s.pattern IS NOT NULL AND s.active
                            THEN public.invoice_number_preview_of(v_tenant_id, s.id, s.pattern, v_day) END
             )
             ORDER BY s.created_at, s.id
           )
      FROM public.invoice_number_series AS s
     WHERE s.tenant_id = v_tenant_id
  ), '[]'::jsonb));
END;
$$;

COMMENT ON FUNCTION public.invoice_number_series_overview(date) IS
  '00199: serie aktywnej firmy z kolejnym numerem z licznika na dany dzień (podpowiedź, bez rezerwacji). Każdy aktywny członek firmy.';

-- Kolejny numer jednej serii na dzień wystawienia (podpowiedź i zapis faktury).
CREATE OR REPLACE FUNCTION public.invoice_number_next(p_series_id uuid, p_issue_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_series public.invoice_number_series%ROWTYPE;
  v_next jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Invoice numbering requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF p_series_id IS NULL OR p_issue_date IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  -- Seria obcej firmy wygląda jak brak serii.
  SELECT * INTO v_series
    FROM public.invoice_number_series AS s
   WHERE s.id = p_series_id AND s.tenant_id = v_tenant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF NOT v_series.active THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'archived');
  END IF;
  IF v_series.pattern IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'no_pattern');
  END IF;
  v_next := public.invoice_number_preview_of(v_tenant_id, v_series.id, v_series.pattern, p_issue_date);
  IF v_next IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'exhausted');
  END IF;
  RETURN jsonb_build_object('status', 'ok') || v_next;
END;
$$;

COMMENT ON FUNCTION public.invoice_number_next(uuid, date) IS
  '00199: kolejny wolny numer serii aktywnej firmy na dzień wystawienia ({status ok, number, counter, period} albo {status refused, code not_found | archived | no_pattern | exhausted}). Numer nadaje dopiero zapis faktury pod blokadą serii.';

-- ─── RPC: nowa seria (właściciel, administrator) ────────────────
CREATE OR REPLACE FUNCTION public.invoice_number_series_create(
  p_name text, p_pattern text, p_first_number integer, p_default_kinds text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_name text := btrim(COALESCE(p_name, ''));
  v_pattern text := COALESCE(p_pattern, '');
  v_problem text;
  v_kinds text[];
  v_id uuid;
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Invoice numbering requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner') OR public.has_org_role(v_tenant_id, 'admin')) THEN
    RAISE EXCEPTION 'Insufficient role to manage invoice numbering' USING ERRCODE = '42501';
  END IF;

  -- Najpierw sprawdzenie danych: odmowa nie zostawia serii podstawowej.
  IF char_length(v_name) NOT BETWEEN 1 AND 60 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'name');
  END IF;
  v_problem := public.invoice_number_pattern_problem(v_pattern);
  IF v_problem IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'pattern', 'problem', v_problem);
  END IF;
  IF p_first_number IS NULL OR p_first_number NOT BETWEEN 1 AND 9999999 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'first_number');
  END IF;
  v_kinds := public.invoice_number_kinds(p_default_kinds);
  IF v_kinds IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'kinds');
  END IF;

  -- Jedna zmiana numeracji firmy naraz (serie domyślne rodzajów).
  PERFORM pg_advisory_xact_lock(hashtextextended('invoice_number_settings:' || v_tenant_id::text, 0));

  IF EXISTS (
    SELECT 1 FROM public.invoice_number_series AS s
     WHERE s.tenant_id = v_tenant_id AND lower(s.name) = lower(v_name)
  ) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'name_taken');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.invoice_number_series AS s
     WHERE s.tenant_id = v_tenant_id
       AND s.pattern IS NOT NULL
       AND public.invoice_number_pattern_skeleton(s.pattern) = public.invoice_number_pattern_skeleton(v_pattern)
  ) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'pattern_taken');
  END IF;

  PERFORM public.invoice_number_series_ensure_default(v_tenant_id, auth.uid());

  -- Rodzaje, dla których nowa seria jest domyślna, przechodzą z innych serii.
  UPDATE public.invoice_number_series AS s
     SET default_kinds = ARRAY(SELECT k FROM unnest(s.default_kinds) AS k WHERE NOT (k = ANY (v_kinds))),
         updated_at = now()
   WHERE s.tenant_id = v_tenant_id
     AND s.default_kinds && v_kinds;

  INSERT INTO public.invoice_number_series (tenant_id, name, pattern, default_kinds, created_by)
  VALUES (v_tenant_id, v_name, v_pattern, v_kinds, auth.uid())
  RETURNING id INTO v_id;

  -- Pierwszy numer (kontynuacja numeracji z innego programu) w bieżącym okresie.
  IF p_first_number > 1 THEN
    INSERT INTO public.invoice_number_counters (tenant_id, series_id, period, last_value)
    VALUES (v_tenant_id, v_id, public.invoice_number_period(v_pattern, v_today), p_first_number - 1);
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'invoice_number_series.created', 'invoice_number_series', v_id,
    jsonb_build_object(
      'name', v_name,
      'pattern', v_pattern,
      'firstNumber', p_first_number,
      'defaultKinds', to_jsonb(v_kinds)
    )
  );

  RETURN jsonb_build_object('status', 'created', 'id', v_id);
END;
$$;

COMMENT ON FUNCTION public.invoice_number_series_create(text, text, integer, text[]) IS
  '00199: nowa seria aktywnej firmy (właściciel, administrator): nazwa, wzór, pierwszy numer w bieżącym okresie, rodzaje, dla których jest domyślna (przechodzą z innych serii). Przy pierwszej serii firmy najpierw seria podstawowa „jak dotąd”. Audyt invoice_number_series.created.';

-- ─── RPC: nazwa i rodzaje domyślne serii ────────────────────────
-- Rodzaj nie zostaje bez serii domyślnej: można go tylko przejąć inną serią.
CREATE OR REPLACE FUNCTION public.invoice_number_series_update(
  p_series_id uuid, p_name text, p_default_kinds text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_series public.invoice_number_series%ROWTYPE;
  v_name text := btrim(COALESCE(p_name, ''));
  v_kinds text[];
  v_added text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Invoice numbering requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner') OR public.has_org_role(v_tenant_id, 'admin')) THEN
    RAISE EXCEPTION 'Insufficient role to manage invoice numbering' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 60 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'name');
  END IF;
  v_kinds := public.invoice_number_kinds(p_default_kinds);
  IF v_kinds IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'kinds');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('invoice_number_settings:' || v_tenant_id::text, 0));

  SELECT * INTO v_series
    FROM public.invoice_number_series AS s
   WHERE s.id = p_series_id AND s.tenant_id = v_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF NOT (v_series.default_kinds <@ v_kinds) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'default_required');
  END IF;
  v_added := ARRAY(SELECT k FROM unnest(v_kinds) AS k WHERE NOT (k = ANY (v_series.default_kinds)));
  IF cardinality(v_added) > 0 AND NOT v_series.active THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'archived');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.invoice_number_series AS s
     WHERE s.tenant_id = v_tenant_id AND s.id <> v_series.id AND lower(s.name) = lower(v_name)
  ) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'name_taken');
  END IF;
  IF v_name = v_series.name AND cardinality(v_added) = 0 THEN
    RETURN jsonb_build_object('status', 'updated');
  END IF;

  UPDATE public.invoice_number_series AS s
     SET default_kinds = ARRAY(SELECT k FROM unnest(s.default_kinds) AS k WHERE NOT (k = ANY (v_added))),
         updated_at = now()
   WHERE s.tenant_id = v_tenant_id
     AND s.id <> v_series.id
     AND s.default_kinds && v_added;

  UPDATE public.invoice_number_series AS s
     SET name = v_name, default_kinds = v_kinds, updated_at = now()
   WHERE s.id = v_series.id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'invoice_number_series.updated', 'invoice_number_series', v_series.id,
    jsonb_build_object(
      'from', jsonb_build_object('name', v_series.name, 'defaultKinds', to_jsonb(v_series.default_kinds)),
      'to', jsonb_build_object('name', v_name, 'defaultKinds', to_jsonb(v_kinds))
    )
  );

  RETURN jsonb_build_object('status', 'updated');
END;
$$;

COMMENT ON FUNCTION public.invoice_number_series_update(uuid, text, text[]) IS
  '00199: nazwa serii i rodzaje, dla których jest domyślna (tylko przejęcie od innych serii; rodzaj nie zostaje bez serii domyślnej). Wzór i licznik bez zmian. Audyt invoice_number_series.updated.';

-- ─── RPC: ukrycie i przywrócenie serii ──────────────────────────
CREATE OR REPLACE FUNCTION public.invoice_number_series_set_active(p_series_id uuid, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_series public.invoice_number_series%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Invoice numbering requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner') OR public.has_org_role(v_tenant_id, 'admin')) THEN
    RAISE EXCEPTION 'Insufficient role to manage invoice numbering' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('invoice_number_settings:' || v_tenant_id::text, 0));

  SELECT * INTO v_series
    FROM public.invoice_number_series AS s
   WHERE s.id = p_series_id AND s.tenant_id = v_tenant_id
   FOR UPDATE;
  IF NOT FOUND OR p_active IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF NOT p_active AND cardinality(v_series.default_kinds) > 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'is_default');
  END IF;
  IF v_series.active = p_active THEN
    RETURN jsonb_build_object('status', 'updated');
  END IF;

  UPDATE public.invoice_number_series AS s
     SET active = p_active, updated_at = now()
   WHERE s.id = v_series.id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(),
    CASE WHEN p_active THEN 'invoice_number_series.restored' ELSE 'invoice_number_series.archived' END,
    'invoice_number_series', v_series.id,
    jsonb_build_object('name', v_series.name, 'pattern', v_series.pattern)
  );

  RETURN jsonb_build_object('status', 'updated');
END;
$$;

COMMENT ON FUNCTION public.invoice_number_series_set_active(uuid, boolean) IS
  '00199: ukrycie serii (nie jest proponowana i nie nadaje numerów) albo przywrócenie; serii domyślnej nie ukrywa się. Audyt invoice_number_series.archived / restored.';

-- ─── RPC: usunięcie serii bez faktur (pomyłka przy zakładaniu) ──
CREATE OR REPLACE FUNCTION public.invoice_number_series_delete(p_series_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_series public.invoice_number_series%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Invoice numbering requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner') OR public.has_org_role(v_tenant_id, 'admin')) THEN
    RAISE EXCEPTION 'Insufficient role to manage invoice numbering' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('invoice_number_settings:' || v_tenant_id::text, 0));

  -- Blokada wiersza: zapis faktury z tą serią (klucz obcy) czeka albo widzi usunięcie.
  SELECT * INTO v_series
    FROM public.invoice_number_series AS s
   WHERE s.id = p_series_id AND s.tenant_id = v_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF cardinality(v_series.default_kinds) > 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'is_default');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.invoices AS inv
     WHERE inv.tenant_id = v_tenant_id AND inv.number_series_id = v_series.id
  ) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'used');
  END IF;

  DELETE FROM public.invoice_number_series AS s WHERE s.id = v_series.id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'invoice_number_series.deleted', 'invoice_number_series', v_series.id,
    jsonb_build_object('name', v_series.name, 'pattern', v_series.pattern)
  );

  RETURN jsonb_build_object('status', 'deleted');
END;
$$;

COMMENT ON FUNCTION public.invoice_number_series_delete(uuid) IS
  '00199: usunięcie serii bez żadnej faktury (pomyłka przy zakładaniu); serię domyślną i serię z fakturami tylko się ukrywa. Audyt invoice_number_series.deleted.';

-- ─── uprawnienia funkcji ─────────────────────────────────────────
REVOKE ALL ON FUNCTION public.invoice_number_series_overview(date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_number_series_overview(date) TO authenticated;
REVOKE ALL ON FUNCTION public.invoice_number_next(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_number_next(uuid, date) TO authenticated;
REVOKE ALL ON FUNCTION public.invoice_number_series_create(text, text, integer, text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_number_series_create(text, text, integer, text[]) TO authenticated;
REVOKE ALL ON FUNCTION public.invoice_number_series_update(uuid, text, text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_number_series_update(uuid, text, text[]) TO authenticated;
REVOKE ALL ON FUNCTION public.invoice_number_series_set_active(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_number_series_set_active(uuid, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.invoice_number_series_delete(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_number_series_delete(uuid) TO authenticated;

-- Pomocnicze z firmą w argumencie: tylko dla funkcji tej migracji.
REVOKE ALL ON FUNCTION public.invoice_number_next_counter(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_number_preview_of(uuid, uuid, text, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_number_series_ensure_default(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_number_kinds(text[]) FROM PUBLIC, anon, authenticated, service_role;

-- Funkcje czyste wzoru (bez danych): CHECK tabeli i test zgodności z aplikacją.
REVOKE ALL ON FUNCTION public.invoice_number_pattern_problem(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_number_pattern_problem(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_number_pattern_skeleton(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_number_pattern_skeleton(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_number_period(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_number_period(text, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_number_render(text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_number_render(text, text, integer) TO authenticated, service_role;

-- Funkcje wyzwalaczy nie są do wołania przez API.
REVOKE ALL ON FUNCTION public.invoice_number_assign() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_number_release() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_invoice_number_series_update() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
