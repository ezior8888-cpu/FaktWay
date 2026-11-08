-- 00174_account_sessions.sql
--
-- Krok 8.5 planu kompletnej aplikacji: zalogowane urządzenia z wylogowaniem
-- na odległość i historia logowań (Ustawienia → Bezpieczeństwo).
--
-- Skąd dane (GoTrue v2.197.0 w CI, supabase/auth na GitHubie):
--   * Sesje to `auth.sessions`: id, user_id, created_at, updated_at, refreshed_at
--     (timestamp BEZ strefy, GoTrue zapisuje UTC), not_after, aal, user_agent, ip
--     (migracje 20220811173540, 20221114143122, 20231027141322).
--   * GoTrue nadpisuje user_agent i ip przy każdym odświeżeniu tokenu
--     (internal/tokens/service.go, UpdateOnlyRefreshInfo), a FaktWay loguje
--     i odświeża sesje z serwera (Next.js, fetch z Node). W tych kolumnach jest
--     więc zwykle „node” i adres serwera aplikacji, nie przeglądarka klienta.
--     Urządzenie z chwili logowania bierzemy z wpisu `auth.login` (albo
--     `auth.signup`) w `audit_logs`: aplikacja zapisuje go z nagłówków przeglądarki,
--     a od tego kroku z `metadata.session_id`. Kolumny GoTrue tylko wtedy, gdy
--     takiego wpisu nie ma (sesja sprzed tej zmiany albo spoza aplikacji).
--   * `auth.audit_log_entries` nie wystarcza na historię: logowanie trafia tam
--     z pustym `ip_address` (internal/api/token.go woła NewAuditLogEntry z "")
--     i bez przeglądarki. Historia czyta więc wpisy `auth.login` z `audit_logs`.
--
-- Wylogowanie to DELETE z `auth.sessions`, dokładnie to, co robi samo GoTrue
-- (models.LogoutSession i models.LogoutAllExceptMe w internal/models/sessions.go).
-- `refresh_tokens` i `mfa_amr_claims` znikają kaskadą (FK ON DELETE CASCADE),
-- więc tokenu nie da się odświeżyć. `GET /auth/v1/user` szuka sesji z claimu
-- `session_id` (maybeLoadUserOrSession w internal/api/auth.go) i bez niej oddaje
-- 403 `session_not_found`; proxy aplikacji pyta o to przy każdym chronionym
-- żądaniu. Sam token dostępu przechodzi przez PostgREST do wygaśnięcia
-- (JWT_EXPIRY, domyślnie 1 h), dlatego te funkcje same sprawdzają, że sesja
-- z tokenu wciąż istnieje.
--
-- Funkcje (SECURITY DEFINER, search_path = ''): tylko `auth.uid()` i sesja
-- z `auth.jwt() ->> 'session_id'`. Wymagają AAL2 albo konta bez zweryfikowanego
-- czynnika (ten sam warunek co `session_may_grant_access` z 00163); inaczej
-- `code_step_required` (42501), a aplikacja pokazuje przejście do kodu
-- (MfaStepUpNotice). Adres IP wychodzi z bazy tylko skrócony: IPv4 do /24,
-- IPv6 do /48.
--
-- PRZED wdrożeniem (addytywna): same nowe funkcje, stary kod ich nie woła, nowy
-- kod bez nich pokazuje „Nie udało się wczytać”. Bez zmian tabel i bez DML poza
-- ciałami funkcji. Po wgraniu: NOTIFY pgrst + schema_migrations (runbook
-- wgrywanie-migracji.md). Wycofanie: DROP FUNCTION sześciu funkcji, za zgodą
-- Bartosza.

BEGIN;

-- Ciała plpgsql sprawdzają kolumny dopiero przy wywołaniu, więc pytamy o nie tu:
-- brak kolumny albo uprawnienia przerywa migrację, zanim cokolwiek powstanie.
-- Właściciel funkcji (rola wgrywająca migrację, `postgres`) dostaje ALL na tabele
-- GoTrue z domyślnych uprawnień obrazu supabase/postgres
-- (20211115181400_update-auth-permissions.sql).
DO $$
BEGIN
  PERFORM s.id, s.user_id, s.created_at, s.updated_at, s.refreshed_at, s.not_after, s.user_agent, s.ip
  FROM auth.sessions s LIMIT 0;
  PERFORM f.user_id, f.status FROM auth.mfa_factors f LIMIT 0;
  PERFORM a.user_id, a.action, a.created_at, a.metadata, a.user_agent, a.ip_address
  FROM public.audit_logs a LIMIT 0;
  IF NOT has_table_privilege('auth.sessions', 'SELECT') OR NOT has_table_privilege('auth.sessions', 'DELETE') THEN
    RAISE EXCEPTION '00174: rola migracji potrzebuje SELECT i DELETE na auth.sessions';
  END IF;
END
$$;

-- Skrócony adres: IPv4 do /24, IPv6 do /48 (jak anonimizacja IP w Google
-- Analytics), IPv4 zapisany jako IPv6 (::ffff:a.b.c.d) do /120, czyli też /24.
CREATE FUNCTION public.account_ip_prefix(p_ip inet)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_ip IS NULL THEN NULL
    WHEN family(p_ip) = 4 THEN network(set_masklen(p_ip, 24))::text
    WHEN p_ip <<= inet '::ffff:0.0.0.0/96' THEN network(set_masklen(p_ip, 120))::text
    ELSE network(set_masklen(p_ip, 48))::text
  END;
$$;

-- Bieżąca sesja konta, gotowa do zarządzania sesjami. Odmowy:
--   not_authenticated  (42501): brak użytkownika w tokenie;
--   session_not_found  (42501): token bez `session_id` albo sesja już usunięta
--                               (wylogowana) lub wygasła (`not_after`);
--   code_step_required (42501): konto ma zweryfikowany czynnik 2FA, a token jest AAL1
--                               (np. sesja po biometrii).
CREATE FUNCTION public.account_security_session()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_claim text := auth.jwt() ->> 'session_id';
  v_session uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_claim IS NULL OR v_claim !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'session_not_found' USING ERRCODE = '42501';
  END IF;
  v_session := v_claim::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM auth.sessions s
    WHERE s.id = v_session AND s.user_id = v_user AND (s.not_after IS NULL OR s.not_after > now())
  ) THEN
    RAISE EXCEPTION 'session_not_found' USING ERRCODE = '42501';
  END IF;
  IF coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' AND EXISTS (
    SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = v_user AND f.status = 'verified'
  ) THEN
    RAISE EXCEPTION 'code_step_required' USING ERRCODE = '42501';
  END IF;
  RETURN v_session;
END;
$$;

-- Zalogowane urządzenia: najwyżej 50, bieżąca sesja pierwsza, potem według
-- ostatniej aktywności. `device_source`: `login` (przeglądarka i adres z wpisu
-- logowania w audycie) albo `session` (to, co ostatnio zapisał GoTrue).
-- Ostatnia aktywność to ostatnie odświeżenie tokenu, czyli mniej więcej co godzinę.
CREATE FUNCTION public.list_account_sessions()
RETURNS TABLE (
  session_id uuid,
  is_current boolean,
  signed_in_at timestamptz,
  last_active_at timestamptz,
  login_method text,
  user_agent text,
  ip_prefix text,
  device_source text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := auth.uid();
  v_current uuid := public.account_security_session();
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.id = v_current,
    s.created_at,
    greatest(s.created_at, s.updated_at, s.refreshed_at AT TIME ZONE 'UTC'),
    entry.method,
    CASE WHEN entry.has_login THEN entry.agent ELSE s.user_agent END,
    public.account_ip_prefix(CASE WHEN entry.has_login THEN entry.ip ELSE s.ip END),
    CASE WHEN entry.has_login THEN 'login' ELSE 'session' END
  FROM auth.sessions s
  LEFT JOIN LATERAL (
    -- Wpis zapisany zaraz po utworzeniu sesji; okno czasu tylko zawęża odczyt
    -- indeksem (user_id, created_at), o dopasowaniu decyduje `session_id`.
    SELECT true AS has_login, a.metadata ->> 'method' AS method, a.user_agent AS agent, a.ip_address AS ip
    FROM public.audit_logs a
    WHERE a.user_id = v_user
      AND a.action IN ('auth.login', 'auth.signup')
      AND a.created_at BETWEEN s.created_at - interval '5 minutes' AND s.created_at + interval '1 hour'
      AND a.metadata ->> 'session_id' = s.id::text
    ORDER BY a.created_at
    LIMIT 1
  ) entry ON true
  WHERE s.user_id = v_user
    AND (s.not_after IS NULL OR s.not_after > now())
  ORDER BY s.id = v_current DESC,
    greatest(s.created_at, s.updated_at, s.refreshed_at AT TIME ZONE 'UTC') DESC NULLS LAST
  LIMIT 50;
END;
$$;

-- Wylogowanie jednego innego urządzenia. `false`: sesji nie ma albo należy do
-- innego konta (bez rozróżnienia). Bieżącej sesji nie wylogowuje (`current_session`,
-- 22023): do tego jest zwykłe wylogowanie, które czyści też ciasteczka.
CREATE FUNCTION public.revoke_account_session(p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current uuid := public.account_security_session();
  v_deleted integer;
BEGIN
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'session_id_required' USING ERRCODE = '22023';
  END IF;
  IF p_session_id = v_current THEN
    RAISE EXCEPTION 'current_session' USING ERRCODE = '22023';
  END IF;
  DELETE FROM auth.sessions s WHERE s.id = p_session_id AND s.user_id = auth.uid();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

-- Wylogowanie wszystkich urządzeń konta poza bieżącym (jak `/logout?scope=others`
-- w GoTrue), także sesji spoza listy (wygasłych i ponad 50 pokazanych): token
-- dostępu takiej sesji działa jeszcze do wygaśnięcia, więc też ma zniknąć.
-- Zwraca liczbę usuniętych sesji (do audytu; ekran jej nie pokazuje).
CREATE FUNCTION public.revoke_other_account_sessions()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current uuid := public.account_security_session();
  v_deleted integer;
BEGIN
  DELETE FROM auth.sessions s WHERE s.user_id = auth.uid() AND s.id <> v_current;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- Historia logowań: wpisy `auth.login` i `auth.signup` z `audit_logs` (przechowywane
-- 12 miesięcy), najnowsze pierwsze, od 1 do 50. `is_active`: sesja tego logowania
-- wciąż istnieje (tylko wpisy z `metadata.session_id`).
CREATE FUNCTION public.list_account_logins(p_limit integer DEFAULT 20)
RETURNS TABLE (
  signed_in_at timestamptz,
  action text,
  login_method text,
  user_agent text,
  ip_prefix text,
  session_id uuid,
  is_current boolean,
  is_active boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := auth.uid();
  v_current uuid := public.account_security_session();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
BEGIN
  RETURN QUERY
  SELECT
    e.created_at,
    e.action,
    coalesce(e.metadata ->> 'method', CASE WHEN e.action = 'auth.signup' THEN 'signup' END),
    e.user_agent,
    public.account_ip_prefix(e.ip_address),
    e.sid,
    coalesce(e.sid = v_current, false),
    e.sid IS NOT NULL AND EXISTS (
      SELECT 1 FROM auth.sessions s
      WHERE s.id = e.sid AND s.user_id = v_user AND (s.not_after IS NULL OR s.not_after > now())
    )
  FROM (
    SELECT a.created_at, a.action, a.metadata, a.user_agent, a.ip_address,
      CASE
        WHEN a.metadata ->> 'session_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (a.metadata ->> 'session_id')::uuid
      END AS sid
    FROM public.audit_logs a
    WHERE a.user_id = v_user AND a.action IN ('auth.login', 'auth.signup')
    ORDER BY a.created_at DESC
    LIMIT v_limit
  ) e
  ORDER BY e.created_at DESC;
END;
$$;

-- Supabase daje nowym funkcjom EXECUTE dla anon i authenticated domyślnymi
-- uprawnieniami (00069: samo REVOKE FROM PUBLIC nie wystarcza). Pomocnicze tylko
-- dla funkcji 00174 (wołane z uprawnieniami właściciela), cztery dla zalogowanych.
REVOKE ALL ON FUNCTION public.account_ip_prefix(inet) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_security_session() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_account_sessions() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_account_session(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_other_account_sessions() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_account_logins(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_account_sessions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_account_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_other_account_sessions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_account_logins(integer) TO authenticated;

COMMENT ON FUNCTION public.list_account_sessions() IS
  'Zalogowane urządzenia własnego konta (krok 8.5). Adres IP skrócony; AAL2 przy 2FA.';
COMMENT ON FUNCTION public.revoke_account_session(uuid) IS
  'Wylogowanie jednej własnej sesji poza bieżącą: DELETE z auth.sessions jak GoTrue LogoutSession.';
COMMENT ON FUNCTION public.revoke_other_account_sessions() IS
  'Wylogowanie wszystkich własnych sesji poza bieżącą: jak GoTrue LogoutAllExceptMe.';
COMMENT ON FUNCTION public.list_account_logins(integer) IS
  'Historia logowań własnego konta z audit_logs (auth.login, auth.signup), 1-50 wpisów.';

COMMIT;
