-- 00160_ksef_inbox_schedule.sql
--
-- Harmonogram odpytywania Skrzynki KSeF (FaktWay 1.0, sekcja 3 pkt 6; sesje 13,
-- 14 i 17 planu skalowania). Do dziś cron co 15 min czytał wszystkie firmy
-- z certyfikatem i wysyłał zadanie na każdą, bez filtra i bez deduplikacji.
-- Przy tysiącach firm kolejka rośnie szybciej, niż worker ją przerabia.
--
-- Co robi:
--   1. `ksef_inbox_schedule`: stan harmonogramu na firmę (`next_poll_at`, poziom
--      aktywności, licznik błędów, ostatnia faktura i aktywność do liczenia
--      poziomu, dzierżawa „zadanie czeka albo trwa”). Liczby (odstępy, progi,
--      dzierżawa) są w `lib/ksef/inbox-schedule.ts`; RPC dostaje je parametrami.
--   2. Widok `ksef_inbox_live_tenants`: tylko żywe firmy (nieusunięte, aktywne,
--      z certyfikatem, certyfikat ważny, NIP zweryfikowany). Jedna definicja dla
--      rozsyłki, kafla i alarmu.
--   3. RPC tylko dla `service_role` (i właściciela, czyli połączenia pg-boss):
--      `claim_ksef_inbox_polls` (wybór należnych firm, od najdawniej należnych,
--      z pominięciem firm z dzierżawą, razem z zapisem zleceń w jednej
--      transakcji), `ksef_inbox_poll_backlog` (liczby do logu i limitu taktu),
--      `ksef_inbox_poll_state` i `finish_ksef_inbox_poll` (przebieg firmy),
--      `note_ksef_inbox_activity` (aktywność i „Sprawdź teraz”; aplikacja
--      sprawdza członkostwo przed wywołaniem), `ksef_inbox_alarm_counts` (alarm
--      liczy w bazie, nie na liście uciętej do 1000 wierszy).
--   4. Wyzwalacz na `tenants`: nowy certyfikat albo weryfikacja = wiersz i termin
--      „teraz”, zerowanie błędów. Działa dla każdej ścieżki zapisu certyfikatu.
--   5. Wypełnienie dla firm, które już mają KSeF: termin „teraz”, poziom gorący
--      do pierwszego przebiegu, ostatnia faktura i ostatnie logowanie z danych.
--   6. RLS: członek firmy czyta tylko swój ostatni sukces (kafel „Ostatnie pobranie”).
--      Pisze wyłącznie serwer. Bez DELETE: wiersze znikają kaskadą z firmą.
--
-- PRZED uruchomieniem:
--   SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 3;
--   SELECT count(*) FROM public.tenants WHERE has_ksef_credentials AND ksef_verified_at IS NOT NULL;  -- tyle wierszy powstanie
--
-- Kolejność: PRZED wdrożeniem kodu. Addytywna: nowa tabela, widok, funkcje,
-- wyzwalacz. Stary kod nowych obiektów nie zna i dalej odpytuje jak dawniej.
-- Bez DROP istniejących obiektów, bez DELETE, bez TRUNCATE; jedyny DML to INSERT
-- do nowej tabeli. Wycofanie (usuwa tylko stan harmonogramu, HWM zostaje
-- w `ksef_inbox_cursor`): DROP TRIGGER, funkcje, widok i tabela.
--
-- Po wgraniu: NOTIFY pgrst, wpis w schema_migrations (AGENTS.md), potem wdrożenie.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ksef_inbox_schedule (
  tenant_id             uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  next_poll_at          timestamptz NOT NULL DEFAULT now(),
  activity_tier         text NOT NULL DEFAULT 'hot'
                        CHECK (activity_tier IN ('hot', 'warm', 'cold', 'dormant')),
  consecutive_errors    integer NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  last_error_class      text CHECK (last_error_class IN ('credentials', 'ksef', 'rate_limit', 'other')),
  last_error_at         timestamptz,
  -- Do liczenia poziomu: nowa faktura zapisana przez skrzynkę, aktywność kogokolwiek z firmy.
  last_invoice_at       timestamptz,
  last_activity_at      timestamptz,
  last_poll_finished_at timestamptz,
  last_success_at       timestamptz,
  -- Zadanie czeka w kolejce albo trwa. Po wygaśnięciu firma może dostać nowe (worker padł).
  poll_lease_until      timestamptz,
  -- Ostatnie przyspieszenie terminu (wejście do Skrzynki, przycisk, nowy certyfikat).
  nudged_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Pod wybór należnych firm: ORDER BY next_poll_at … LIMIT.
CREATE INDEX IF NOT EXISTS idx_ksef_inbox_schedule_next_poll
  ON public.ksef_inbox_schedule (next_poll_at);

COMMENT ON TABLE public.ksef_inbox_schedule IS
  'Harmonogram odpytywania Skrzynki KSeF: kiedy następny przebieg i dlaczego. HWM jest w ksef_inbox_cursor. Runbook: docs/runbooks/skrzynka-ksef-pojemnosc.md';

ALTER TABLE public.ksef_inbox_schedule ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ksef_inbox_schedule_select_member" ON public.ksef_inbox_schedule;
CREATE POLICY "ksef_inbox_schedule_select_member"
  ON public.ksef_inbox_schedule FOR SELECT TO authenticated
  USING (public.is_member_of(tenant_id));

REVOKE ALL ON public.ksef_inbox_schedule FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (tenant_id, last_success_at)
  ON public.ksef_inbox_schedule TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ksef_inbox_schedule TO service_role;

-- Żywa firma. `now()` w widoku, więc wygasły certyfikat wypada bez przeliczania.
CREATE OR REPLACE VIEW public.ksef_inbox_live_tenants
WITH (security_invoker = true) AS
SELECT t.id,
       t.nip::text AS nip,
       t.ksef_verified_environment AS environment
  FROM public.tenants t
 WHERE t.deleted_at IS NULL
   AND t.is_active
   AND t.has_ksef_credentials
   AND t.ksef_verified_at IS NOT NULL
   AND t.ksef_verified_environment IS NOT NULL
   AND (t.ksef_certificate_expiry IS NULL OR t.ksef_certificate_expiry > now());

REVOKE ALL ON public.ksef_inbox_live_tenants FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ksef_inbox_live_tenants TO service_role;

-- ═══════════════════════════════════════════════════════════════
-- Rozsyłka
-- ═══════════════════════════════════════════════════════════════

-- Należne firmy do limitu, od najdawniej należnych, bez firm z czekającym
-- zadaniem. Dzierżawa w tym samym zapytaniu: drugi takt tych firm nie zobaczy.
-- Woła ją pg-boss w transakcji razem z zapisem zleceń: gdy zapis padnie,
-- dzierżawa się wycofuje i firma jest należna w następnym takcie.
CREATE OR REPLACE FUNCTION public.claim_ksef_inbox_polls(
  p_environment text,
  p_limit integer,
  p_lease_seconds integer
) RETURNS TABLE (tenant_id uuid, nip text, due_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH due AS (
    SELECT s.tenant_id, t.nip, s.next_poll_at
      FROM public.ksef_inbox_schedule s
      JOIN public.ksef_inbox_live_tenants t ON t.id = s.tenant_id
     WHERE t.environment = p_environment
       AND s.next_poll_at <= now()
       AND (s.poll_lease_until IS NULL OR s.poll_lease_until <= now())
     ORDER BY s.next_poll_at, s.tenant_id
     LIMIT GREATEST(p_limit, 0)
       FOR UPDATE OF s SKIP LOCKED
  ), leased AS (
    UPDATE public.ksef_inbox_schedule s
       SET poll_lease_until = now() + make_interval(secs => p_lease_seconds),
           updated_at = now()
      FROM due
     WHERE s.tenant_id = due.tenant_id
    RETURNING s.tenant_id
  )
  SELECT due.tenant_id, due.nip, due.next_poll_at
    FROM due
    JOIN leased ON leased.tenant_id = due.tenant_id
   ORDER BY due.next_poll_at, due.tenant_id;
$$;

-- Liczby jednego taktu: należne, w toku, najstarszy termin, hamulec 429.
CREATE OR REPLACE FUNCTION public.ksef_inbox_poll_backlog(
  p_environment text,
  p_recent_seconds integer
) RETURNS TABLE (
  due bigint,
  in_flight bigint,
  oldest_due_at timestamptz,
  polled_recent bigint,
  rate_limited_recent bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    count(*) FILTER (WHERE s.next_poll_at <= now() AND (s.poll_lease_until IS NULL OR s.poll_lease_until <= now())),
    count(*) FILTER (WHERE s.poll_lease_until > now()),
    min(s.next_poll_at) FILTER (WHERE s.next_poll_at <= now() AND (s.poll_lease_until IS NULL OR s.poll_lease_until <= now())),
    count(*) FILTER (WHERE s.last_poll_finished_at > now() - make_interval(secs => p_recent_seconds)),
    count(*) FILTER (WHERE s.last_error_class = 'rate_limit' AND s.last_error_at > now() - make_interval(secs => p_recent_seconds))
    FROM public.ksef_inbox_schedule s
    JOIN public.ksef_inbox_live_tenants t ON t.id = s.tenant_id
   WHERE t.environment = p_environment;
$$;

-- ═══════════════════════════════════════════════════════════════
-- Przebieg firmy
-- ═══════════════════════════════════════════════════════════════

-- Jeden odczyt na starcie przebiegu: czy zadanie jest potrzebne i z czego liczyć poziom.
CREATE OR REPLACE FUNCTION public.ksef_inbox_poll_state(
  p_tenant_id uuid,
  p_active_statuses text[]
) RETURNS TABLE (
  next_poll_at timestamptz,
  poll_lease_until timestamptz,
  consecutive_errors integer,
  last_invoice_at timestamptz,
  last_activity_at timestamptz,
  subscription_active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.next_poll_at,
         CASE WHEN s.poll_lease_until > now() THEN s.poll_lease_until END,
         s.consecutive_errors,
         s.last_invoice_at,
         s.last_activity_at,
         EXISTS (
           SELECT 1
             FROM public.subscriptions sub
            WHERE sub.tenant_id = s.tenant_id
              AND sub.status::text = ANY (p_active_statuses)
         )
    FROM public.ksef_inbox_schedule s
   WHERE s.tenant_id = p_tenant_id;
$$;

-- Koniec przebiegu: dzierżawa w dół, nowy termin, licznik błędów. Przyspieszenie
-- zrobione w trakcie przebiegu (klient kliknął, nowy certyfikat) wygrywa z
-- policzonym terminem, inaczej zniknęłoby po cichu.
CREATE OR REPLACE FUNCTION public.finish_ksef_inbox_poll(
  p_tenant_id uuid,
  p_started_at timestamptz,
  p_next_poll_at timestamptz,
  p_activity_tier text,
  p_new_invoices integer,
  p_error_class text
) RETURNS timestamptz
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.ksef_inbox_schedule AS s (
    tenant_id, next_poll_at, activity_tier, consecutive_errors, last_error_class, last_error_at,
    last_invoice_at, last_poll_finished_at, last_success_at, poll_lease_until
  ) VALUES (
    p_tenant_id, p_next_poll_at, p_activity_tier,
    CASE WHEN p_error_class IS NULL THEN 0 ELSE 1 END,
    p_error_class,
    CASE WHEN p_error_class IS NULL THEN NULL ELSE now() END,
    CASE WHEN p_new_invoices > 0 THEN now() END,
    now(),
    CASE WHEN p_error_class IS NULL THEN now() END,
    NULL
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    next_poll_at = CASE
      WHEN s.nudged_at >= p_started_at THEN LEAST(s.next_poll_at, EXCLUDED.next_poll_at)
      ELSE EXCLUDED.next_poll_at
    END,
    activity_tier = EXCLUDED.activity_tier,
    consecutive_errors = CASE WHEN p_error_class IS NULL THEN 0 ELSE s.consecutive_errors + 1 END,
    last_error_class = p_error_class,
    last_error_at = CASE WHEN p_error_class IS NULL THEN NULL ELSE now() END,
    last_invoice_at = CASE WHEN p_new_invoices > 0 THEN now() ELSE s.last_invoice_at END,
    last_poll_finished_at = now(),
    last_success_at = CASE WHEN p_error_class IS NULL THEN now() ELSE s.last_success_at END,
    poll_lease_until = NULL,
    updated_at = now()
  RETURNING s.next_poll_at;
$$;

-- ═══════════════════════════════════════════════════════════════
-- Aktywność i „Sprawdź teraz”
-- ═══════════════════════════════════════════════════════════════

-- p_request_poll = false: sam znacznik aktywności; firma zimna wchodzi w rytm
-- gorącej najpóźniej po p_pull_seconds. Bez przyspieszania firmy ze złym
-- certyfikatem: odstęp rośnie tam celowo, a ruch klienta certyfikatu nie naprawi.
-- p_request_poll = true: wejście do Skrzynki albo przycisk. Termin „teraz”, chyba
-- że sprawdzaliśmy przed chwilą albo zadanie już czeka. Limit w aplikacji idzie
-- przez lib/rate-limit (pamięć procesu albo Redis), a ten warunek trzyma też po
-- restarcie procesu i przy kilku replikach.
-- status: accepted | in_flight | too_soon. Brak wiersza = firma bez KSeF.
CREATE OR REPLACE FUNCTION public.note_ksef_inbox_activity(
  p_tenant_id uuid,
  p_request_poll boolean,
  p_min_gap_seconds integer,
  p_pull_seconds integer
) RETURNS TABLE (status text, retry_after_seconds integer, next_poll_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.ksef_inbox_schedule%ROWTYPE;
  v_gap interval := make_interval(secs => p_min_gap_seconds);
  v_last timestamptz;
BEGIN
  SELECT * INTO v_row
    FROM public.ksef_inbox_schedule s
   WHERE s.tenant_id = p_tenant_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT p_request_poll THEN
    UPDATE public.ksef_inbox_schedule s
       SET last_activity_at = now(),
           next_poll_at = CASE
             WHEN s.consecutive_errors > 0 AND s.last_error_class = 'credentials'
               THEN s.next_poll_at
             ELSE LEAST(s.next_poll_at, now() + make_interval(secs => p_pull_seconds))
           END,
           updated_at = now()
     WHERE s.tenant_id = p_tenant_id
     RETURNING s.next_poll_at INTO v_row.next_poll_at;
    RETURN QUERY SELECT 'accepted'::text, 0, v_row.next_poll_at;
    RETURN;
  END IF;

  IF v_row.poll_lease_until > now() THEN
    UPDATE public.ksef_inbox_schedule s
       SET last_activity_at = now(), updated_at = now()
     WHERE s.tenant_id = p_tenant_id;
    RETURN QUERY SELECT 'in_flight'::text, 0, v_row.next_poll_at;
    RETURN;
  END IF;

  v_last := GREATEST(v_row.nudged_at, v_row.last_poll_finished_at);
  IF v_last IS NOT NULL AND v_last > now() - v_gap THEN
    UPDATE public.ksef_inbox_schedule s
       SET last_activity_at = now(), updated_at = now()
     WHERE s.tenant_id = p_tenant_id;
    RETURN QUERY SELECT 'too_soon'::text,
      GREATEST(1, ceil(extract(epoch FROM (v_last + v_gap - now())))::integer),
      v_row.next_poll_at;
    RETURN;
  END IF;

  UPDATE public.ksef_inbox_schedule s
     SET last_activity_at = now(),
         nudged_at = now(),
         next_poll_at = LEAST(s.next_poll_at, now()),
         updated_at = now()
   WHERE s.tenant_id = p_tenant_id
   RETURNING s.next_poll_at INTO v_row.next_poll_at;
  RETURN QUERY SELECT 'accepted'::text, 0, v_row.next_poll_at;
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- Alarm
-- ═══════════════════════════════════════════════════════════════

-- Opóźnienie względem harmonogramu, nie stała liczba godzin: firma zimna po 5 h
-- jest w normie, gorąca po 2 h nie. Liczy baza, bez list i bez NIP-ów.
--   overdue      termin minął dawniej niż p_overdue_seconds (rozsyłka albo worker stoi)
--   failing      błędy po stronie KSeF albo naszej, bez sukcesu dłużej niż odstęp poziomu + margines
--   hwm_behind   przebiegi przechodzą, a HWM stoi (zaległość po stronie MF)
--   credentials  błąd certyfikatu; naprawia klient, alarm tylko przy podejrzanej liczbie
--   unscheduled  żywa firma bez wiersza harmonogramu (nikt jej nie odpytuje)
CREATE OR REPLACE FUNCTION public.ksef_inbox_alarm_counts(
  p_environment text,
  p_overdue_seconds integer,
  p_failing_margin_seconds integer,
  p_hwm_margin_seconds integer,
  p_expected_gap_seconds jsonb
) RETURNS TABLE (
  live bigint,
  overdue bigint,
  failing bigint,
  hwm_behind bigint,
  credentials bigint,
  rate_limited bigint,
  unscheduled bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH firms AS (
    SELECT s.tenant_id,
           s.next_poll_at,
           s.consecutive_errors,
           s.last_error_class,
           s.last_error_at,
           COALESCE(s.last_success_at, s.created_at) AS success_base,
           make_interval(secs => COALESCE((p_expected_gap_seconds ->> s.activity_tier)::integer, 0)) AS expected_gap,
           c.window_to
      FROM public.ksef_inbox_live_tenants t
      LEFT JOIN public.ksef_inbox_schedule s ON s.tenant_id = t.id
      LEFT JOIN public.ksef_inbox_cursor c ON c.tenant_id = t.id
     WHERE t.environment = p_environment
  )
  SELECT
    count(*),
    count(*) FILTER (WHERE next_poll_at < now() - make_interval(secs => p_overdue_seconds)),
    count(*) FILTER (
      WHERE consecutive_errors > 0
        AND last_error_class <> 'credentials'
        AND success_base + expected_gap + make_interval(secs => p_failing_margin_seconds) < now()
    ),
    count(*) FILTER (
      WHERE window_to IS NOT NULL
        AND last_error_class IS DISTINCT FROM 'credentials'
        AND window_to + expected_gap + make_interval(secs => p_hwm_margin_seconds) < now()
    ),
    count(*) FILTER (WHERE consecutive_errors > 0 AND last_error_class = 'credentials'),
    count(*) FILTER (WHERE last_error_class = 'rate_limit' AND last_error_at > now() - interval '1 hour'),
    count(*) FILTER (WHERE tenant_id IS NULL)
    FROM firms;
$$;

REVOKE ALL ON FUNCTION public.claim_ksef_inbox_polls(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ksef_inbox_poll_backlog(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ksef_inbox_poll_state(uuid, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_ksef_inbox_poll(uuid, timestamptz, timestamptz, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.note_ksef_inbox_activity(uuid, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ksef_inbox_alarm_counts(text, integer, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_ksef_inbox_polls(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ksef_inbox_poll_backlog(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ksef_inbox_poll_state(uuid, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_ksef_inbox_poll(uuid, timestamptz, timestamptz, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.note_ksef_inbox_activity(uuid, boolean, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ksef_inbox_alarm_counts(text, integer, integer, integer, jsonb) TO service_role;

-- ═══════════════════════════════════════════════════════════════
-- Nowy certyfikat i wypełnienie
-- ═══════════════════════════════════════════════════════════════

-- SECURITY DEFINER: `tenants` zmienia też klient właściciela (nazwa firmy itd.),
-- a on nie ma prawa pisać do harmonogramu.
CREATE OR REPLACE FUNCTION public.ksef_inbox_schedule_on_tenant_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.ksef_credentials_encrypted IS NULL
     OR NEW.ksef_verified_at IS NULL
     OR NEW.ksef_verified_environment IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.ksef_credentials_encrypted IS NOT DISTINCT FROM NEW.ksef_credentials_encrypted
     AND OLD.ksef_verified_at IS NOT DISTINCT FROM NEW.ksef_verified_at
     AND OLD.ksef_verified_environment IS NOT DISTINCT FROM NEW.ksef_verified_environment THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.ksef_inbox_schedule AS s (tenant_id, next_poll_at, nudged_at)
  VALUES (NEW.id, now(), now())
  ON CONFLICT (tenant_id) DO UPDATE SET
    next_poll_at = now(),
    nudged_at = now(),
    consecutive_errors = 0,
    last_error_class = NULL,
    last_error_at = NULL,
    poll_lease_until = NULL,
    updated_at = now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ksef_inbox_schedule_on_tenant_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_ksef_inbox_schedule_on_tenant ON public.tenants;
CREATE TRIGGER trigger_ksef_inbox_schedule_on_tenant
  AFTER INSERT OR UPDATE OF ksef_credentials_encrypted, ksef_verified_at, ksef_verified_environment
  ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.ksef_inbox_schedule_on_tenant_change();

-- Firmy, które już mają KSeF: należne od razu. Poziom policzy pierwszy przebieg.
INSERT INTO public.ksef_inbox_schedule (tenant_id, next_poll_at, last_invoice_at, last_activity_at)
SELECT t.id,
       now(),
       (SELECT max(i.created_at)
          FROM public.invoices i
         WHERE i.tenant_id = t.id
           AND i.direction = 'incoming'
           AND i.origin = 'ksef_inbox'),
       (SELECT max(u.last_sign_in_at)
          FROM public.memberships m
          JOIN auth.users u ON u.id = m.user_id
         WHERE m.organization_id = t.id
           AND m.status = 'active')
  FROM public.tenants t
 WHERE t.has_ksef_credentials
   AND t.ksef_verified_at IS NOT NULL
   AND t.ksef_verified_environment IS NOT NULL
ON CONFLICT (tenant_id) DO NOTHING;

COMMIT;
