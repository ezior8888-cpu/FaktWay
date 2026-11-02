-- 00161_analytics_consent_funnel.sql
--
-- Pomiar FaktWay 1.0 (FAKTWAY-1-0, sekcja 3 pkt 7): rejestracja, podłączenie
-- KSeF, pierwsza faktura, próba, płatność, odejście, źródło. Opis zdarzeń
-- i lejka: docs/analytics/lejek-faktway.md.
--
-- Co robi:
--   1. `users.analytics_consent` + `analytics_consent_at` — zgoda znana na
--      serwerze (webhook Stripe i joby nie mają przeglądarki, a zgoda żyła tylko
--      w localStorage). `users.signup_source` — pierwszy dotyk z rejestracji,
--      wyłącznie przy zgodzie (CHECK), kasowany przy odwołaniu.
--   2. Uprawnienia kolumnowe jak w 00112: członkowie firmy widzą nawzajem swoje
--      wiersze `users` (RLS), a źródło wejścia i decyzja o zgodzie to nie ich
--      sprawa, więc nowe kolumny są poza SELECT i UPDATE ról klienckich. Klient
--      rusza je tylko przez `sync_analytics_consent`, źródło pisze tylko serwer.
--      Każda NOWA kolumna `users` potrzebuje odtąd jawnego GRANT (strażnik:
--      tests/unit/lejek-migracja.test.ts).
--   3. `tenants.first_invoice_accepted_at` — warunkowy UPDATE tej kolumny
--      rozstrzyga, kto wysyła `first_invoice_sent`; wyzwalacz nie pozwala
--      klientowi jej ustawić. GRANT SELECT jak każda kolumna `tenants` od 00112.
--   4. `sync_analytics_consent` — zapis i odczyt zgody zalogowanego użytkownika;
--      ostatni wybór wygrywa, data z przyszłości jest przycinana do teraz.
--   5. `analytics_tenant_owner` — najstarszy aktywny właściciel firmy: jedna
--      definicja dla bramki zgody w kodzie i dla lejka w SQL.
--   6. `admin_funnel_weekly` — lejek tygodniami, liczony w SQL, bez danych
--      osobowych, tylko dla service_role.
--
-- UPDATE na istniejących wierszach: uzupełnienie `first_invoice_accepted_at`
-- najwcześniejszą przyjętą fakturą wystawioną w FaktWay (`origin = 'app'`:
-- bez sprzedaży pobranej z historii KSeF i bez importu z pliku). Ustawia tylko
-- nową kolumnę, tylko gdy jest pusta. Dotknie firm policzonych tym zapytaniem:
--   SELECT count(DISTINCT tenant_id) FROM public.invoices
--    WHERE direction = 'outgoing' AND ksef_status = 'accepted' AND origin = 'app';
-- Wyzwalacz `trg_tenants_updated_at` przesunie tym firmom `updated_at` na chwilę
-- wgrania; aplikacja tej kolumny firm nie używa do żadnej decyzji. Uzupełnionym
-- firmom `first_invoice_sent` już nie wyjdzie: dotyczy to nowych firm.
--
-- PRZED uruchomieniem (preflight):
--   SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 3;
--   zapytanie liczące wyżej (kilka firm albo kilka tysięcy: tak samo bezpieczne,
--   ale przy tysiącach wgrywać poza szczytem wysyłek, bo UPDATE blokuje te wiersze).
--
-- Kolejność: PRZED wdrożeniem kodu. Addytywna: nowe kolumny, funkcje, wyzwalacz.
-- Stary kod czyta i pisze w `users` tylko dotychczasowe kolumny (sprawdzone:
-- nigdzie `select('*')`), a uprawnienia do nich zostają bez zmian. Bez DROP,
-- bez DELETE, bez TRUNCATE. Wycofanie (tylko za zgodą Bartosza, usuwa zgody):
-- GRANT SELECT, UPDATE ON public.users TO authenticated, potem usunięcie funkcji,
-- wyzwalacza i kolumn.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. Zgoda i źródło wejścia w `users`
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.users ADD COLUMN analytics_consent text;
ALTER TABLE public.users ADD COLUMN analytics_consent_at timestamptz;
ALTER TABLE public.users ADD COLUMN signup_source jsonb;

ALTER TABLE public.users ADD CONSTRAINT users_analytics_consent_valid
  CHECK (analytics_consent IS NULL OR analytics_consent IN ('granted', 'denied'));
ALTER TABLE public.users ADD CONSTRAINT users_analytics_consent_has_date
  CHECK ((analytics_consent IS NULL) = (analytics_consent_at IS NULL));
-- CHECK przepuszcza NULL, więc porównania muszą dawać prawdę albo fałsz, nigdy NULL.
-- Rozmiar z zapasem: pięć pól utm po 100 znaków, host, ścieżka, kanał i data.
ALTER TABLE public.users ADD CONSTRAINT users_signup_source_valid
  CHECK (
    signup_source IS NULL OR (
      analytics_consent IS NOT DISTINCT FROM 'granted'
      AND jsonb_typeof(signup_source) = 'object'
      AND COALESCE(signup_source ->> 'channel', '') IN (
        'google_ads', 'organic_search', 'youtube', 'tiktok', 'social', 'referral', 'direct', 'other'
      )
      AND octet_length(signup_source::text) <= 2048
    )
  );

COMMENT ON COLUMN public.users.analytics_consent IS
  'Zgoda na analitykę: granted, denied albo NULL (bez decyzji). Brak granted = brak zdarzenia do PostHoga (lib/analytics/server.ts).';
COMMENT ON COLUMN public.users.analytics_consent_at IS
  'Chwila ostatniego wyboru. Przy synchronizacji po zalogowaniu ostatni wybór wygrywa.';
COMMENT ON COLUMN public.users.signup_source IS
  'Pierwszy dotyk z rejestracji (lib/analytics/privacy.ts, FirstTouch), tylko przy zgodzie, kasowany przy odwołaniu.';

-- ─────────────────────────────────────────────────────────────────
-- 2. Uprawnienia kolumnowe `users` (działają tylko bez uprawnienia do tabeli)
-- ─────────────────────────────────────────────────────────────────
REVOKE SELECT, UPDATE ON public.users FROM anon, authenticated;

DO $$
DECLARE
  v_columns text;
BEGIN
  SELECT string_agg(pg_catalog.quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_columns
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'users'
     AND column_name NOT IN ('analytics_consent', 'analytics_consent_at', 'signup_source');
  EXECUTE pg_catalog.format(
    'GRANT SELECT (%1$s), UPDATE (%1$s) ON public.users TO authenticated',
    v_columns
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- 3. Data pierwszej przyjętej faktury firmy
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.tenants ADD COLUMN first_invoice_accepted_at timestamptz;
GRANT SELECT (first_invoice_accepted_at) ON public.tenants TO authenticated;

COMMENT ON COLUMN public.tenants.first_invoice_accepted_at IS
  'Chwila przyjęcia w KSeF pierwszej faktury wystawionej w FaktWay. Pisze tylko serwer, warunkiem WHERE IS NULL (lib/analytics/funnel.ts).';

-- RLS daje właścicielowi UPDATE całego wiersza `tenants`, także tej kolumny.
CREATE OR REPLACE FUNCTION public.guard_tenant_first_invoice_accepted_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.first_invoice_accepted_at IS NOT NULL THEN
        RAISE EXCEPTION 'first_invoice_accepted_at requires a trusted server'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.first_invoice_accepted_at IS DISTINCT FROM OLD.first_invoice_accepted_at THEN
      RAISE EXCEPTION 'first_invoice_accepted_at requires a trusted server'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_tenant_first_invoice_accepted_at()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trigger_guard_tenant_first_invoice_accepted_at
  BEFORE INSERT OR UPDATE OF first_invoice_accepted_at
  ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_first_invoice_accepted_at();

-- Uzupełnienie dla istniejących faktur, opis w nagłówku. Bez filtra środowiska:
-- na jednej instancji KSEF_ENV jest stałe. Puste `ksef_accepted_at` to stare
-- wiersze sprzed tej kolumny, wtedy data utworzenia. tests/rls-lejek-analityka.test.ts
-- uruchamia tę instrukcję jeszcze raz na zasianych danych.
UPDATE public.tenants t
   SET first_invoice_accepted_at = f.first_accepted_at
  FROM (
    SELECT i.tenant_id, min(COALESCE(i.ksef_accepted_at, i.created_at)) AS first_accepted_at
      FROM public.invoices i
     WHERE i.direction = 'outgoing'
       AND i.ksef_status = 'accepted'
       AND i.origin = 'app'
     GROUP BY i.tenant_id
  ) f
 WHERE t.id = f.tenant_id
   AND t.first_invoice_accepted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────
-- 4. Zgoda: zapis i odczyt zalogowanego użytkownika
-- ─────────────────────────────────────────────────────────────────
-- p_consent NULL = tylko odczyt. p_chosen_at NULL = wybór sprzed tej migracji,
-- bez daty: liczy się wyłącznie na koncie bez decyzji. `changed` mówi, czy decyzja
-- naprawdę się zmieniła (wtedy akcja dopisuje wpis w audit_logs).
CREATE OR REPLACE FUNCTION public.sync_analytics_consent(
  p_consent text DEFAULT NULL,
  p_chosen_at timestamptz DEFAULT NULL
)
RETURNS TABLE (consent text, consent_at timestamptz, changed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_previous text;
  v_at timestamptz;
  v_changed boolean := false;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_consent IS NOT NULL AND p_consent NOT IN ('granted', 'denied') THEN
    RAISE EXCEPTION 'invalid_analytics_consent' USING ERRCODE = '22023';
  END IF;

  IF p_consent IS NOT NULL THEN
    SELECT u.analytics_consent INTO v_previous
      FROM public.users u
     WHERE u.id = v_user
       FOR UPDATE;

    -- Zły zegar urządzenia nie może zablokować późniejszych wyborów.
    v_at := LEAST(COALESCE(p_chosen_at, now()), now());
    UPDATE public.users u
       SET analytics_consent = p_consent,
           analytics_consent_at = v_at,
           -- Odwołanie zgody kasuje dane zebrane na jej podstawie.
           signup_source = CASE WHEN p_consent = 'granted' THEN u.signup_source END
     WHERE u.id = v_user
       AND (
         u.analytics_consent_at IS NULL
         OR (p_chosen_at IS NOT NULL AND u.analytics_consent_at < v_at)
       );
    v_changed := FOUND AND v_previous IS DISTINCT FROM p_consent;
  END IF;

  RETURN QUERY
    SELECT u.analytics_consent, u.analytics_consent_at, v_changed
      FROM public.users u
     WHERE u.id = v_user;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_analytics_consent(text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_analytics_consent(text, timestamptz) TO authenticated;

COMMENT ON FUNCTION public.sync_analytics_consent(text, timestamptz) IS
  'Zgoda na analitykę zalogowanego użytkownika: ostatni wybór wygrywa, odwołanie kasuje signup_source. Bez argumentów tylko odczyt.';

-- ─────────────────────────────────────────────────────────────────
-- 5. Właściciel firmy: zgoda dla zdarzeń firmy i źródło w lejku
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.analytics_tenant_owner(p_tenant_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.user_id
    FROM public.memberships m
   WHERE m.organization_id = p_tenant_id
     AND m.role = 'owner'
     AND m.status = 'active'
   ORDER BY m.joined_at, m.user_id
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.analytics_tenant_owner(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_tenant_owner(uuid) TO service_role;

COMMENT ON FUNCTION public.analytics_tenant_owner(uuid) IS
  'Najstarszy aktywny właściciel firmy. Jego zgoda decyduje o zdarzeniach firmy (webhook Stripe, wysyłka do KSeF nie mają przeglądarki).';

-- ─────────────────────────────────────────────────────────────────
-- 6. Lejek tygodniami
-- ─────────────────────────────────────────────────────────────────
-- Każda firma liczy się w tygodniu założenia (poniedziałek, czas Warszawy):
-- nowe firmy → podłączony KSeF → pierwsza faktura → próba → płacący → odeszli.
-- Wiersz `source = 'all'` jest dla każdego tygodnia, także bez nowych firm, i nie
-- zależy od zgód. Pozostałe wiersze to kanały, tylko firmy, których właściciel ma
-- zgodę. Najwyżej 52 tygodnie × 9 wierszy: poniżej limitu 1000 wierszy PostgREST.
CREATE OR REPLACE FUNCTION public.admin_funnel_weekly(p_weeks integer DEFAULT 12)
RETURNS TABLE (
  week_start date,
  source text,
  new_tenants integer,
  ksef_connected integer,
  first_invoice integer,
  trial_started integer,
  paying integer,
  churned integer
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH span AS (
    SELECT LEAST(GREATEST(COALESCE(p_weeks, 12), 1), 52) AS weeks,
           date_trunc('week', now() AT TIME ZONE 'Europe/Warsaw')::date AS this_week
  ),
  calendar AS (
    SELECT (r.this_week - (g * 7))::date AS cohort
      FROM span r
     CROSS JOIN generate_series(0, r.weeks - 1) AS g
  ),
  firms AS (
    SELECT date_trunc('week', t.created_at AT TIME ZONE 'Europe/Warsaw')::date AS cohort,
           t.ksef_verified_at IS NOT NULL AS is_connected,
           t.first_invoice_accepted_at IS NOT NULL AS has_invoice,
           EXISTS (
             SELECT 1 FROM public.subscriptions s
              WHERE s.tenant_id = t.id AND s.trial_start IS NOT NULL
           ) AS had_trial,
           -- Faktura 0 zł z próby to nie płatność; późniejszy zwrot nie cofa tego, że zapłacił.
           EXISTS (
             SELECT 1 FROM public.stripe_payments p
              WHERE p.tenant_id = t.id
                AND p.amount_cents > 0
                AND p.status IN ('succeeded', 'partially_refunded', 'refunded')
           ) AS has_paid,
           -- Odeszła: ma zamkniętą subskrypcję i żadnej trwającej. `incomplete_expired`
           -- to nieudany start, a nie trwająca subskrypcja.
           EXISTS (
             SELECT 1 FROM public.subscriptions s
              WHERE s.tenant_id = t.id AND s.status = 'canceled'
           ) AND NOT EXISTS (
             SELECT 1 FROM public.subscriptions s
              WHERE s.tenant_id = t.id AND s.status NOT IN ('canceled', 'incomplete_expired')
           ) AS has_left,
           (
             SELECT u.signup_source ->> 'channel'
               FROM public.users u
              WHERE u.id = public.analytics_tenant_owner(t.id)
                AND u.analytics_consent = 'granted'
           ) AS channel
      FROM public.tenants t
     WHERE t.created_at >= ((SELECT min(c.cohort) FROM calendar c)::timestamp AT TIME ZONE 'Europe/Warsaw')
  ),
  funnel_rows AS (
    SELECT c.cohort,
           'all'::text AS channel,
           count(f.cohort)::integer AS new_count,
           (count(*) FILTER (WHERE f.is_connected))::integer AS connected_count,
           (count(*) FILTER (WHERE f.has_invoice))::integer AS invoice_count,
           (count(*) FILTER (WHERE f.had_trial))::integer AS trial_count,
           (count(*) FILTER (WHERE f.has_paid))::integer AS paid_count,
           (count(*) FILTER (WHERE f.has_left))::integer AS left_count
      FROM calendar c
      LEFT JOIN firms f ON f.cohort = c.cohort
     GROUP BY c.cohort
    UNION ALL
    SELECT f.cohort,
           f.channel,
           count(*)::integer,
           (count(*) FILTER (WHERE f.is_connected))::integer,
           (count(*) FILTER (WHERE f.has_invoice))::integer,
           (count(*) FILTER (WHERE f.had_trial))::integer,
           (count(*) FILTER (WHERE f.has_paid))::integer,
           (count(*) FILTER (WHERE f.has_left))::integer
      FROM firms f
     WHERE f.channel IS NOT NULL
     GROUP BY f.cohort, f.channel
  )
  SELECT r.cohort, r.channel, r.new_count, r.connected_count, r.invoice_count,
         r.trial_count, r.paid_count, r.left_count
    FROM funnel_rows r
   ORDER BY r.cohort DESC, (r.channel = 'all') DESC, r.channel
$$;
REVOKE ALL ON FUNCTION public.admin_funnel_weekly(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_funnel_weekly(integer) TO service_role;

COMMENT ON FUNCTION public.admin_funnel_weekly(integer) IS
  'Lejek firm tygodniami dla panelu /admin: same liczby, bez danych osobowych, niezależnie od PostHoga. Podział na kanały tylko z firm ze zgodą właściciela. Zakres przycinany do 1–52 tygodni.';

COMMIT;
