-- 00157_log_purge_batches.sql
--
-- Sprzątanie dzienników paczkami (plan skalowania 3000, sesja 20; ustalenia
-- DB-01 pkt 2, JOB-05, DBC-07, DB-09 z raportu „Pojemność FaktWay”).
--
-- Problem: `cleanup_old_audit_logs` (00044, ostatnia definicja w 00052) robi
-- jeden DELETE wszystkich starych wierszy `audit_logs` i `inngest_run_log`
-- w jednej transakcji. Runner woła ją przez PostgREST, który ucina zapytanie
-- po 8 s. Przy milionach wierszy (wyzwalacz append-only BEFORE DELETE FOR
-- EACH ROW z 00052) cała transakcja się cofa i nie znika nic, a dzienniki
-- rosną na dysku db-1 (40 GB). `ksef_health_log` nie ma żadnej retencji,
-- choć 00046 obiecuje 3 miesiące.
--
-- Co robi: trzy funkcje paczkowe. Każda usuwa NAJWYŻEJ `p_limit` wierszy
-- starszych niż retencja i zwraca, ile usunęła. Runner
-- (`lib/jobs/runners/cleanup-audit-logs.ts`) woła je w pętli, aż zwrócą 0.
--   - `purge_audit_logs_batch(p_retention_months, p_limit)` — retencja jak
--     dotąd: domyślnie 12 mies., minimum 6; flaga append-only
--     `app.allow_audit_purge` w każdej paczce, lokalnie dla transakcji,
--     i przywrócona do poprzedniej wartości zaraz po paczce. DELETE bez flagi
--     dalej pada (także w tej samej transakcji po wywołaniu).
--   - `purge_inngest_run_log_batch(p_limit)` — 3 mies. po `created_at`.
--   - `purge_ksef_health_log_batch(p_limit)` — 3 mies. po `recorded_at`.
-- Limit paczki: 1–50 000 (domyślnie 20 000); poza zakresem błąd 22023.
-- Retencji telemetrii nie da się skrócić z zewnątrz (stała w funkcji).
--
-- Paczka wybiera `ctid` (adres wiersza) i usuwa przez TID Scan: bez złączenia
-- z całą tabelą po `id`, którym planista mógłby zastąpić `id IN (…)`.
--
-- Indeksy btree po `created_at` (`audit_logs`, `inngest_run_log`): po dacie
-- były tylko BRIN (00044). Przy codziennym usuwaniu zwolnione strony dostają
-- nowe wiersze, a zakres BRIN strony tylko się poszerza (VACUUM go nie
-- zawęża), więc po roku każdy zakres „pasuje” do starych dat. Wywołanie,
-- które ma zwrócić 0, czytałoby wtedy całą tabelę — przy kilku GB ponad 8 s
-- PostgREST, czyli znowu nic by nie znikało.
-- `ORDER BY created_at` przy btree nie sortuje: paczka schodzi indeksem od
-- najstarszych i czyta tylko swoje wiersze, a wywołanie bez wierszy to jedno
-- zejście indeksu. Bez ORDER BY wybór planu zależałby od statystyk (ANALYZE
-- co kilka tygodni, korelacja daty z położeniem wierszy spada przy ponownym
-- użyciu stron) i planista mógłby wybrać skan całej tabeli albo BRIN.
-- `ksef_health_log` jest mała (kilkaset wpisów na dobę): sam BRIN z 00046,
-- bez ORDER BY (tu sortowałby, a kolejność nie ma znaczenia).
-- `plan_cache_mode = force_custom_plan`: plan z prawdziwą datą przy każdym
-- wywołaniu. Plan ogólny (PostgREST trzyma połączenia, więc po 5 wywołaniach
-- na połączeniu) zgaduje, że pasuje 1/3 tabeli.
--
-- Budowa indeksów blokuje zapis do tych dwóch tabel na czas budowy (odczyt
-- nie). 25.10 cała baza miała 198 MB, więc to sekundy — wgrać poza
-- godzinami pracy. Gdyby tabele urosły ponad ok. 1 GB, najpierw zbudować
-- indeksy ręcznie, poza transakcją: `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
-- z tymi samymi nazwami i kolumnami (sprawdzić `pg_index.indisvalid`), a
-- migracja je pominie (IF NOT EXISTS).
--
-- Ponowienie: każda paczka to osobna transakcja z warunkiem daty, więc
-- powtórka od zera usuwa tylko to, co zostało. Dwie równoległe paczki nie
-- dublują skutków (druga pomija wiersze usunięte przez pierwszą).
--
-- `cleanup_old_audit_logs` zostaje bez zmian: woła ją stary kod do chwili
-- wdrożenia nowego runnera. Wycofanie jej to osobna migracja po wdrożeniu.
--
-- PRZED wdrożeniem kodu (addytywna): dwa nowe indeksy i trzy nowe funkcje,
-- bez zmian danych, kolumn i istniejących funkcji. Stary kod ich nie zna.

BEGIN;

-- ─── Indeksy po dacie ────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON public.audit_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_inngest_run_log_created_at
  ON public.inngest_run_log (created_at);

-- ─── audit_logs ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_audit_logs_batch(
  p_retention_months integer DEFAULT 12,
  p_limit integer DEFAULT 20000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_cutoff timestamptz;
  v_prev text;
  v_deleted integer;
BEGIN
  IF p_retention_months IS NULL OR p_retention_months < 6 THEN
    RAISE EXCEPTION 'purge_audit_logs_batch: retencja % mies. — minimum 6', p_retention_months
      USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50000 THEN
    RAISE EXCEPTION 'purge_audit_logs_batch: limit paczki % poza zakresem 1–50000', p_limit
      USING ERRCODE = '22023';
  END IF;

  v_cutoff := now() - make_interval(months => p_retention_months);

  -- Opt-in dla wyzwalacza append-only (00052) tylko na czas tej paczki.
  v_prev := current_setting('app.allow_audit_purge', true);
  PERFORM set_config('app.allow_audit_purge', 'true', true);

  DELETE FROM public.audit_logs
   WHERE ctid = ANY (ARRAY(
     SELECT ctid
       FROM public.audit_logs
      WHERE created_at < v_cutoff
      ORDER BY created_at
      LIMIT p_limit
   ));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  PERFORM set_config('app.allow_audit_purge', COALESCE(v_prev, ''), true);

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_audit_logs_batch(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_audit_logs_batch(integer, integer) TO service_role;

COMMENT ON FUNCTION public.purge_audit_logs_batch(integer, integer) IS
  'Retencja audit_logs paczkami (00157): usuwa najwyżej p_limit wierszy starszych niż p_retention_months '
  '(min. 6), zwraca liczbę usuniętych; flaga app.allow_audit_purge tylko na czas paczki. '
  'Runner cron.cleanup-audit-logs woła w pętli do 0.';

-- ─── inngest_run_log ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_inngest_run_log_batch(
  p_limit integer DEFAULT 20000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50000 THEN
    RAISE EXCEPTION 'purge_inngest_run_log_batch: limit paczki % poza zakresem 1–50000', p_limit
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.inngest_run_log
   WHERE ctid = ANY (ARRAY(
     SELECT ctid
       FROM public.inngest_run_log
      WHERE created_at < now() - interval '3 months'
      ORDER BY created_at
      LIMIT p_limit
   ));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_inngest_run_log_batch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_inngest_run_log_batch(integer) TO service_role;

COMMENT ON FUNCTION public.purge_inngest_run_log_batch(integer) IS
  'Retencja inngest_run_log paczkami (00157): najwyżej p_limit wierszy starszych niż 3 mies. (created_at), '
  'zwraca liczbę usuniętych. Runner cron.cleanup-audit-logs woła w pętli do 0.';

-- ─── ksef_health_log ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_ksef_health_log_batch(
  p_limit integer DEFAULT 20000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50000 THEN
    RAISE EXCEPTION 'purge_ksef_health_log_batch: limit paczki % poza zakresem 1–50000', p_limit
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.ksef_health_log
   WHERE ctid = ANY (ARRAY(
     SELECT ctid
       FROM public.ksef_health_log
      WHERE recorded_at < now() - interval '3 months'
      LIMIT p_limit
   ));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_ksef_health_log_batch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_ksef_health_log_batch(integer) TO service_role;

COMMENT ON FUNCTION public.purge_ksef_health_log_batch(integer) IS
  'Retencja ksef_health_log paczkami (00157; obiecana w 00046): najwyżej p_limit wierszy starszych niż '
  '3 mies. (recorded_at), zwraca liczbę usuniętych. Runner cron.cleanup-audit-logs woła w pętli do 0.';

COMMIT;
