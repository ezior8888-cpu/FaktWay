-- ═══════════════════════════════════════════════════════════════
-- 00195: uprawnienia biura rachunkowego w KSeF nadawane i odbierane z FaktWay
-- (plan kompletnej aplikacji, krok 6.2, część 4; ryzyko R1).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Addytywna: nowa tabela, indeks, funkcja
-- wyzwalacza, cztery funkcje RPC i polityka RLS; bez DROP tabel i kolumn,
-- bez zmiany istniejących danych (bez DML poza ciałami funkcji). Kod czyta
-- tabelę odpornie (brak tabeli = sekcja „po najbliższej aktualizacji”, brak
-- funkcji = komunikat o aktualizacji), a całość stoi za flagą
-- `ksefPermissionsEnabled` (brak wiersza w global_feature_flags = wyłączone).
-- Numer z rejestru docs/koordynacja/CLAUDE-DO-CODEXA.md (00174-00194 zajmują
-- inne otwarte PR).
--
-- Po co: właściciel nadaje biuru rachunkowemu (po NIP-ie) uprawnienie do faktur
-- firmy w KSeF (InvoiceRead, opcjonalnie InvoiceWrite) bez logowania do
-- Aplikacji Podatnika i tak samo je odbiera. KSeF 2.0 robi to asynchronicznie:
-- `POST /permissions/entities/grants` daje 202 i numer operacji, wynik podaje
-- `GET /permissions/operations/{numer}` (100 w toku, 200 sukces, reszta to
-- porażka), a tego samego uprawnienia nie da się nadać dwa razy. Dlatego próba
-- jest rezerwowana w bazie przed wywołaniem, a numery operacji zapisane.
--
-- ksef_permission_grants: jeden wiersz na biuro (NIP) w firmie i środowisku
-- KSeF (UNIQUE tenant_id, ksef_environment, subject_nip). Stany:
--   grant_pending       próba nadania (żeton `attempt`), przed numerem operacji;
--   grant_in_progress   KSeF przyjął nadanie (jeden numer operacji), czeka na wynik;
--   granted             status 200 albo uprawnienie było już aktywne w KSeF;
--   grant_failed        odmowa KSeF, błąd poświadczeń albo brak odpowiedzi (kod błędu);
--   revoke_pending      próba odebrania (żeton), przed numerami operacji;
--   revoke_in_progress  KSeF przyjął odebranie (numer na każde uprawnienie);
--   revoked             brak aktywnego uprawnienia biura po odebraniu;
--   revoke_failed       odebranie się nie udało, uprawnienie może być aktywne.
-- Próbę *_pending starszą niż 5 minut (przerwana akcja, restart serwera)
-- przejmuje kolejna rezerwacja z nowym żetonem; stara próba niczego już nie
-- zapisze. Akcja przed każdym nadaniem pyta KSeF o aktywne uprawnienia biura,
-- więc przejęta próba nie nada drugi raz tego, co KSeF już przyjął.
--
-- Zapis tylko przez cztery funkcje SECURITY DEFINER z kontrolą firmy
-- (get_current_tenant_id, nagłówek x-active-org) i roli właściciela
-- (has_org_role z 00037):
--   claim_ksef_permission_grant     rezerwacja nadania; krok kodu jak przy linku
--                                   dla księgowej (session_may_grant_access, 00163);
--   claim_ksef_permission_revoke    rezerwacja odebrania (bez kroku kodu, jak cofnięcie linku);
--   finish_ksef_permission_attempt  wynik bieżącej próby (żeton) z audytem;
--   record_ksef_permission_check    wynik sprawdzenia operacji w toku (te same numery) z audytem.
-- Sesja: odczyt tylko właściciel aktywnej firmy, bez kolumny `attempt`; bez
-- INSERT, UPDATE i DELETE. service_role: pełny dostęp. Przejścia stanów
-- i niezmienność biura pilnuje wyzwalacz, także przy kluczu serwisowym.
--
-- Ścieżka operatora: wiersz do wyczyszczenia (np. dane KSeF TEST po czyszczeniu
-- środowiska) usuwa się kluczem serwisowym po id; następne „Nadaj” klienta
-- zacznie od nowa i najpierw sprawdzi KSeF. Historia zostaje w audit_logs
-- (accountant.ksef_permission_*, ksef.permissions.*).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ksef_permission_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  ksef_environment TEXT NOT NULL,
  -- NIP biura (`subjectIdentifier` typu Nip): wzorzec KSeF; sumę kontrolną sprawdza rezerwacja.
  subject_nip TEXT NOT NULL,
  -- `subjectDetails.fullName`: od 5 do 90 znaków.
  subject_name TEXT NOT NULL,
  -- Uprawnienia KSeF po kolei: odczyt albo odczyt i wystawianie.
  scopes TEXT[] NOT NULL,
  -- `canDelegate`: biuro może przekazać uprawnienie pracownikom.
  can_delegate BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'grant_pending',
  -- Żeton bieżącej próby: wynik zapisuje tylko próba z tym samym żetonem.
  attempt UUID NOT NULL DEFAULT gen_random_uuid(),
  -- Numery operacji KSeF bieżącej próby (`referenceNumber`, 36 znaków).
  operation_references TEXT[] NOT NULL DEFAULT '{}',
  ksef_status_code INTEGER,
  ksef_status_description TEXT,
  error_code TEXT,
  requested_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at TIMESTAMPTZ,
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT ksef_permission_grants_environment_check CHECK (ksef_environment IN ('test', 'demo', 'production')),
  CONSTRAINT ksef_permission_grants_nip_check CHECK (subject_nip ~ '^[1-9](([0-9][1-9])|([1-9][0-9]))[0-9]{7}$'),
  CONSTRAINT ksef_permission_grants_name_check
    CHECK (char_length(subject_name) BETWEEN 5 AND 90 AND subject_name = btrim(subject_name)),
  CONSTRAINT ksef_permission_grants_scopes_check
    CHECK (scopes = ARRAY['InvoiceRead']::text[] OR scopes = ARRAY['InvoiceRead', 'InvoiceWrite']::text[]),
  CONSTRAINT ksef_permission_grants_status_check CHECK (status IN (
    'grant_pending', 'grant_in_progress', 'granted', 'grant_failed',
    'revoke_pending', 'revoke_in_progress', 'revoked', 'revoke_failed'
  )),
  CONSTRAINT ksef_permission_grants_references_check CHECK (
    cardinality(operation_references) <= 10
    AND array_position(operation_references, NULL) IS NULL
    AND array_to_string(operation_references, ',') ~ '^([0-9A-Za-z-]{36}(,[0-9A-Za-z-]{36})*)?$'
  ),
  CONSTRAINT ksef_permission_grants_references_state_check CHECK (
    CASE status
      WHEN 'grant_pending' THEN cardinality(operation_references) = 0
      WHEN 'revoke_pending' THEN cardinality(operation_references) = 0
      WHEN 'grant_in_progress' THEN cardinality(operation_references) = 1
      WHEN 'revoke_in_progress' THEN cardinality(operation_references) >= 1
      ELSE true
    END
  ),
  CONSTRAINT ksef_permission_grants_failed_check
    CHECK (status NOT IN ('grant_failed', 'revoke_failed') OR error_code IS NOT NULL),
  CONSTRAINT ksef_permission_grants_error_code_check CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT ksef_permission_grants_ksef_code_check CHECK (ksef_status_code IS NULL OR ksef_status_code BETWEEN 100 AND 999),
  CONSTRAINT ksef_permission_grants_ksef_description_check
    CHECK (ksef_status_description IS NULL OR char_length(ksef_status_description) <= 500),
  CONSTRAINT ksef_permission_grants_granted_check CHECK (status <> 'granted' OR granted_at IS NOT NULL),
  CONSTRAINT ksef_permission_grants_revoked_check CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ksef_permission_grants_biuro
  ON public.ksef_permission_grants (tenant_id, ksef_environment, subject_nip);

COMMENT ON TABLE public.ksef_permission_grants IS
  'Uprawnienia biur rachunkowych w KSeF nadawane z FaktWay (krok 6.2, część 4): jeden wiersz na biuro w firmie '
  'i środowisku, stany nadania i odebrania z numerami operacji KSeF. Zapis tylko przez RPC claim/finish/record z audytem.';

CREATE OR REPLACE FUNCTION public.guard_ksef_permission_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.ksef_environment IS DISTINCT FROM OLD.ksef_environment
     OR NEW.subject_nip IS DISTINCT FROM OLD.subject_nip
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Firma, środowisko i NIP biura są niezmienne; inne biuro to nowy wiersz.'
      USING ERRCODE = '23514', HINT = 'ksef_permission_grant_immutable';
  END IF;
  IF (NEW.subject_name IS DISTINCT FROM OLD.subject_name
      OR NEW.scopes IS DISTINCT FROM OLD.scopes
      OR NEW.can_delegate IS DISTINCT FROM OLD.can_delegate)
     AND NOT (NEW.status = 'grant_pending' AND OLD.status IN ('grant_pending', 'grant_failed', 'revoked')) THEN
    RAISE EXCEPTION 'Nazwę biura i zakres uprawnienia zmienia tylko nowa próba nadania.'
      USING ERRCODE = '23514', HINT = 'ksef_permission_grant_scope';
  END IF;
  IF NOT (
    (OLD.status = 'grant_pending' AND NEW.status IN ('grant_pending', 'grant_in_progress', 'granted', 'grant_failed'))
    OR (OLD.status = 'grant_in_progress' AND NEW.status IN ('grant_in_progress', 'granted', 'grant_failed'))
    OR (OLD.status = 'granted' AND NEW.status = 'revoke_pending')
    OR (OLD.status = 'grant_failed' AND NEW.status = 'grant_pending')
    OR (OLD.status = 'revoke_pending' AND NEW.status IN ('revoke_pending', 'revoke_in_progress', 'revoked', 'revoke_failed'))
    OR (OLD.status = 'revoke_in_progress' AND NEW.status IN ('revoke_in_progress', 'revoked', 'revoke_failed'))
    OR (OLD.status = 'revoke_failed' AND NEW.status = 'revoke_pending')
    OR (OLD.status = 'revoked' AND NEW.status = 'grant_pending')
  ) THEN
    RAISE EXCEPTION 'Uprawnienie KSeF w stanie % nie przechodzi w stan %.', OLD.status, NEW.status
      USING ERRCODE = '23514', HINT = 'ksef_permission_grant_transition';
  END IF;
  RETURN NEW;
END;
$$;

-- Jak `guard_ksef_collective_identifier` (00191): funkcji wyzwalacza nikt nie woła wprost.
REVOKE ALL ON FUNCTION public.guard_ksef_permission_grant() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_ksef_permission_grants_guard ON public.ksef_permission_grants;
CREATE TRIGGER trigger_ksef_permission_grants_guard
  BEFORE UPDATE ON public.ksef_permission_grants
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_ksef_permission_grant();

ALTER TABLE public.ksef_permission_grants ENABLE ROW LEVEL SECURITY;

-- Ekran jest tylko dla właściciela (Ustawienia, zakładka Księgowa), więc odczyt też.
DROP POLICY IF EXISTS "ksef_permission_grants_select_owner" ON public.ksef_permission_grants;
CREATE POLICY "ksef_permission_grants_select_owner"
  ON public.ksef_permission_grants
  FOR SELECT
  TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND public.has_org_role(tenant_id, 'owner')
  );

REVOKE ALL ON public.ksef_permission_grants FROM PUBLIC, anon, authenticated, service_role;
-- Bez `attempt`: żeton próby zna tylko akcja, która ją zarezerwowała.
GRANT SELECT (id, tenant_id, ksef_environment, subject_nip, subject_name, scopes, can_delegate, status,
              operation_references, ksef_status_code, ksef_status_description, error_code, requested_by,
              created_at, claimed_at, checked_at, granted_at, revoked_at)
  ON public.ksef_permission_grants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ksef_permission_grants TO service_role;

-- Rezerwacja nadania. Zwraca:
--   claimed             nowa próba (id, attempt, takeover): akcja pyta KSeF i zapisuje wynik;
--   in_progress         próba nadania młodsza niż 5 minut (druga karta, dwuklik);
--   awaiting_ksef       KSeF przetwarza nadanie: „Sprawdź stan”;
--   already_granted     biuro ma uprawnienie (zakres w `scopes`); zmiana zakresu = odebranie i nadanie;
--   revoke_in_progress  trwa odbieranie;
--   refused             złe wejście (kod).
-- Dwie rezerwacje naraz: INSERT drugiej czeka na pierwszą (indeks UNIQUE),
-- potem widzi świeżą próbę i dostaje in_progress.
CREATE OR REPLACE FUNCTION public.claim_ksef_permission_grant(
  p_environment text,
  p_subject_nip text,
  p_subject_name text,
  p_scopes text[],
  p_can_delegate boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_tenant_nip text;
  v_name text;
  v_scopes text[];
  v_sum integer;
  v_id uuid;
  v_attempt uuid := gen_random_uuid();
  v_row record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'KSeF permission grant requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_org_role(v_tenant_id, 'owner') THEN
    RAISE EXCEPTION 'Only the owner grants KSeF permissions' USING ERRCODE = '42501';
  END IF;
  -- Dostęp osoby trzeciej do faktur: sesja po biometrii na koncie z 2FA potrzebuje kodu (00163).
  IF NOT public.session_may_grant_access() THEN
    RAISE EXCEPTION 'code_step_required' USING ERRCODE = '42501';
  END IF;

  IF p_environment IS NULL OR p_environment NOT IN ('test', 'demo', 'production') THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_environment');
  END IF;
  -- Wzorzec Nip ze specyfikacji KSeF 2.0 i suma kontrolna (wagi 6, 5, 7, 2, 3, 4, 5, 6, 7; reszta 10 to zły NIP).
  IF p_subject_nip IS NULL OR p_subject_nip !~ '^[1-9](([0-9][1-9])|([1-9][0-9]))[0-9]{7}$' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_nip');
  END IF;
  SELECT sum(substr(p_subject_nip, t.i::integer, 1)::integer * t.w)
    INTO v_sum
    FROM unnest(ARRAY[6, 5, 7, 2, 3, 4, 5, 6, 7]) WITH ORDINALITY AS t(w, i);
  IF v_sum % 11 = 10 OR v_sum % 11 <> substr(p_subject_nip, 10, 1)::integer THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_nip');
  END IF;
  SELECT t.nip INTO v_tenant_nip FROM public.tenants AS t WHERE t.id = v_tenant_id;
  IF regexp_replace(coalesce(v_tenant_nip, ''), '[^0-9]', '', 'g') = p_subject_nip THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'own_nip');
  END IF;
  v_name := btrim(regexp_replace(coalesce(p_subject_name, ''), '\s+', ' ', 'g'));
  IF char_length(v_name) NOT BETWEEN 5 AND 90 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_name');
  END IF;
  IF p_scopes IS NULL OR array_position(p_scopes, NULL) IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_scopes');
  END IF;
  SELECT array_agg(DISTINCT u.s ORDER BY u.s) INTO v_scopes FROM unnest(p_scopes) AS u(s);
  IF v_scopes IS NULL
     OR cardinality(v_scopes) <> cardinality(p_scopes)
     OR NOT (v_scopes = ARRAY['InvoiceRead']::text[] OR v_scopes = ARRAY['InvoiceRead', 'InvoiceWrite']::text[]) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_scopes');
  END IF;
  IF p_can_delegate IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_delegate');
  END IF;

  INSERT INTO public.ksef_permission_grants
    (tenant_id, ksef_environment, subject_nip, subject_name, scopes, can_delegate, status, attempt, requested_by)
  VALUES (v_tenant_id, p_environment, p_subject_nip, v_name, v_scopes, p_can_delegate, 'grant_pending', v_attempt, auth.uid())
  ON CONFLICT (tenant_id, ksef_environment, subject_nip) DO NOTHING
  RETURNING id INTO v_id;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'claimed', 'id', v_id, 'attempt', v_attempt, 'takeover', false);
  END IF;

  SELECT * INTO v_row
    FROM public.ksef_permission_grants
   WHERE tenant_id = v_tenant_id AND ksef_environment = p_environment AND subject_nip = p_subject_nip
   FOR UPDATE;
  IF NOT FOUND THEN
    -- Wiersz usunięty między INSERT a odczytem (operator): następne kliknięcie zacznie od nowa.
    RETURN jsonb_build_object('status', 'in_progress');
  END IF;
  IF v_row.status IN ('granted', 'revoke_failed') THEN
    RETURN jsonb_build_object('status', 'already_granted', 'id', v_row.id, 'scopes', to_jsonb(v_row.scopes));
  END IF;
  IF v_row.status = 'grant_in_progress' THEN
    RETURN jsonb_build_object('status', 'awaiting_ksef', 'id', v_row.id);
  END IF;
  IF v_row.status IN ('revoke_pending', 'revoke_in_progress') THEN
    RETURN jsonb_build_object('status', 'revoke_in_progress', 'id', v_row.id);
  END IF;
  IF v_row.status = 'grant_pending' AND v_row.claimed_at > now() - interval '5 minutes' THEN
    RETURN jsonb_build_object('status', 'in_progress', 'id', v_row.id);
  END IF;

  -- grant_failed, revoked albo grant_pending przerwany ponad 5 minut temu: nowa próba z nowym zakresem.
  UPDATE public.ksef_permission_grants
     SET status = 'grant_pending',
         attempt = v_attempt,
         subject_name = v_name,
         scopes = v_scopes,
         can_delegate = p_can_delegate,
         operation_references = '{}',
         ksef_status_code = NULL,
         ksef_status_description = NULL,
         error_code = NULL,
         claimed_at = now(),
         checked_at = NULL,
         granted_at = NULL,
         revoked_at = NULL,
         requested_by = auth.uid()
   WHERE id = v_row.id;
  RETURN jsonb_build_object('status', 'claimed', 'id', v_row.id, 'attempt', v_attempt, 'takeover', true);
END;
$$;

COMMENT ON FUNCTION public.claim_ksef_permission_grant(text, text, text, text[], boolean) IS
  'Rezerwacja nadania uprawnienia KSeF biuru rachunkowemu (właściciel, krok kodu): claimed z żetonem próby, '
  'in_progress, awaiting_ksef, already_granted, revoke_in_progress albo refused z kodem.';

-- Rezerwacja odebrania. Zwraca claimed (id, attempt, NIP i zakres do zapytania KSeF),
-- in_progress, awaiting_ksef, already_revoked, not_granted (row_status) albo refused.
CREATE OR REPLACE FUNCTION public.claim_ksef_permission_revoke(
  p_id uuid,
  p_environment text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_attempt uuid := gen_random_uuid();
  v_row record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'KSeF permission revoke requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_org_role(v_tenant_id, 'owner') THEN
    RAISE EXCEPTION 'Only the owner revokes KSeF permissions' USING ERRCODE = '42501';
  END IF;
  IF p_environment IS NULL OR p_environment NOT IN ('test', 'demo', 'production') THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_environment');
  END IF;

  SELECT * INTO v_row
    FROM public.ksef_permission_grants
   WHERE id = p_id AND tenant_id = v_tenant_id
   FOR UPDATE;
  -- Wiersz obcej firmy wygląda jak brak wiersza.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF v_row.ksef_environment <> p_environment THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'env_mismatch');
  END IF;
  -- Każda odpowiedź z wierszem niesie NIP i nazwę biura: komunikat dla klienta je nazywa.
  IF v_row.status = 'revoke_pending' AND v_row.claimed_at > now() - interval '5 minutes' THEN
    RETURN jsonb_build_object('status', 'in_progress', 'id', v_row.id,
                              'subject_nip', v_row.subject_nip, 'subject_name', v_row.subject_name);
  END IF;
  IF v_row.status = 'revoke_in_progress' THEN
    RETURN jsonb_build_object('status', 'awaiting_ksef', 'id', v_row.id,
                              'subject_nip', v_row.subject_nip, 'subject_name', v_row.subject_name);
  END IF;
  IF v_row.status = 'revoked' THEN
    RETURN jsonb_build_object('status', 'already_revoked', 'id', v_row.id,
                              'subject_nip', v_row.subject_nip, 'subject_name', v_row.subject_name);
  END IF;
  IF v_row.status NOT IN ('granted', 'revoke_failed', 'revoke_pending') THEN
    RETURN jsonb_build_object('status', 'not_granted', 'id', v_row.id, 'row_status', v_row.status,
                              'subject_nip', v_row.subject_nip, 'subject_name', v_row.subject_name);
  END IF;

  UPDATE public.ksef_permission_grants
     SET status = 'revoke_pending',
         attempt = v_attempt,
         operation_references = '{}',
         ksef_status_code = NULL,
         ksef_status_description = NULL,
         error_code = NULL,
         claimed_at = now(),
         checked_at = NULL,
         requested_by = auth.uid()
   WHERE id = v_row.id;
  RETURN jsonb_build_object(
    'status', 'claimed',
    'id', v_row.id,
    'attempt', v_attempt,
    'subject_nip', v_row.subject_nip,
    'subject_name', v_row.subject_name,
    'scopes', to_jsonb(v_row.scopes)
  );
END;
$$;

COMMENT ON FUNCTION public.claim_ksef_permission_revoke(uuid, text) IS
  'Rezerwacja odebrania uprawnienia KSeF biuru rachunkowemu (właściciel): claimed z żetonem próby, NIP-em i zakresem, '
  'in_progress, awaiting_ksef, already_revoked, not_granted albo refused.';

-- Wynik bieżącej próby (żeton) z audytem w tej samej transakcji:
--   grant_pending  → grant_in_progress (jeden numer operacji) | granted | grant_failed;
--   revoke_pending → revoke_in_progress (co najmniej jeden numer) | revoked | revoke_failed.
CREATE OR REPLACE FUNCTION public.finish_ksef_permission_attempt(
  p_id uuid,
  p_attempt uuid,
  p_status text,
  p_references text[] DEFAULT '{}',
  p_ksef_code integer DEFAULT NULL,
  p_ksef_description text DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_detail text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_row record;
  v_refs text[];
  v_code text;
  v_ksef_code integer;
  v_action text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'KSeF permission result requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_org_role(v_tenant_id, 'owner') THEN
    RAISE EXCEPTION 'Only the owner saves KSeF permission results' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
    FROM public.ksef_permission_grants
   WHERE id = p_id AND tenant_id = v_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF v_row.status NOT IN ('grant_pending', 'revoke_pending') OR p_attempt IS NULL OR v_row.attempt <> p_attempt THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'stale_attempt');
  END IF;
  IF NOT (
    (v_row.status = 'grant_pending' AND p_status IN ('grant_in_progress', 'granted', 'grant_failed'))
    OR (v_row.status = 'revoke_pending' AND p_status IN ('revoke_in_progress', 'revoked', 'revoke_failed'))
  ) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_status');
  END IF;
  v_refs := coalesce(p_references, '{}'::text[]);
  IF cardinality(v_refs) > 10
     OR array_position(v_refs, NULL) IS NOT NULL
     OR array_to_string(v_refs, ',') !~ '^([0-9A-Za-z-]{36}(,[0-9A-Za-z-]{36})*)?$'
     OR (p_status = 'grant_in_progress' AND cardinality(v_refs) <> 1)
     OR (p_status = 'revoke_in_progress' AND cardinality(v_refs) < 1) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_reference');
  END IF;
  v_code := CASE WHEN p_error_code ~ '^[a-z0-9_]{1,64}$' THEN p_error_code END;
  IF p_status IN ('grant_failed', 'revoke_failed') THEN
    v_code := coalesce(v_code, 'unknown');
  END IF;
  v_ksef_code := CASE WHEN p_ksef_code BETWEEN 100 AND 999 THEN p_ksef_code END;

  UPDATE public.ksef_permission_grants
     SET status = p_status,
         operation_references = v_refs,
         ksef_status_code = v_ksef_code,
         ksef_status_description = left(p_ksef_description, 500),
         error_code = v_code,
         checked_at = CASE WHEN v_ksef_code IS NULL THEN NULL ELSE now() END,
         granted_at = CASE WHEN p_status = 'granted' THEN now() ELSE granted_at END,
         revoked_at = CASE WHEN p_status = 'revoked' THEN now() ELSE revoked_at END
   WHERE id = v_row.id;

  v_action := CASE p_status
    WHEN 'grant_in_progress' THEN 'accountant.ksef_permission_grant_sent'
    WHEN 'granted' THEN 'accountant.ksef_permission_granted'
    WHEN 'grant_failed' THEN 'accountant.ksef_permission_grant_failed'
    WHEN 'revoke_in_progress' THEN 'accountant.ksef_permission_revoke_sent'
    WHEN 'revoked' THEN 'accountant.ksef_permission_revoked'
    ELSE 'accountant.ksef_permission_revoke_failed'
  END;
  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), v_action, 'ksef_permission_grant', v_row.id,
    jsonb_build_object(
      'subjectNip', v_row.subject_nip,
      'subjectName', v_row.subject_name,
      'scopes', to_jsonb(v_row.scopes),
      'canDelegate', v_row.can_delegate,
      'environment', v_row.ksef_environment,
      'references', to_jsonb(v_refs),
      'ksefStatusCode', v_ksef_code,
      'ksefStatusDescription', left(p_ksef_description, 200),
      'errorCode', v_code,
      'detail', left(p_detail, 200)
    )
  );

  RETURN jsonb_build_object('status', 'saved', 'row_status', p_status);
END;
$$;

COMMENT ON FUNCTION public.finish_ksef_permission_attempt(uuid, uuid, text, text[], integer, text, text, text) IS
  'Zapisuje wynik bieżącej próby nadania albo odebrania uprawnienia KSeF (właściciel, żeton próby) z audytem '
  'accountant.ksef_permission_* w tej samej transakcji.';

-- Wynik sprawdzenia operacji w toku (GET /permissions/operations/{numer}, lista uprawnień),
-- tylko dla tych samych numerów operacji; audyt przy zmianie stanu:
--   grant_in_progress  → grant_in_progress | granted | grant_failed;
--   revoke_in_progress → revoke_in_progress | revoked | revoke_failed.
CREATE OR REPLACE FUNCTION public.record_ksef_permission_check(
  p_id uuid,
  p_references text[],
  p_status text,
  p_ksef_code integer DEFAULT NULL,
  p_ksef_description text DEFAULT NULL,
  p_error_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_row record;
  v_code text;
  v_ksef_code integer;
  v_action text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'KSeF permission check requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_org_role(v_tenant_id, 'owner') THEN
    RAISE EXCEPTION 'Only the owner checks KSeF permissions' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
    FROM public.ksef_permission_grants
   WHERE id = p_id AND tenant_id = v_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF v_row.status NOT IN ('grant_in_progress', 'revoke_in_progress') THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_in_progress', 'row_status', v_row.status);
  END IF;
  -- Wynik starej operacji (np. sprzed odebrania i ponownego nadania) nie trafia do nowej.
  IF p_references IS DISTINCT FROM v_row.operation_references THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'stale_check');
  END IF;
  IF NOT (
    (v_row.status = 'grant_in_progress' AND p_status IN ('grant_in_progress', 'granted', 'grant_failed'))
    OR (v_row.status = 'revoke_in_progress' AND p_status IN ('revoke_in_progress', 'revoked', 'revoke_failed'))
  ) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_status');
  END IF;
  v_code := CASE WHEN p_error_code ~ '^[a-z0-9_]{1,64}$' THEN p_error_code END;
  IF p_status IN ('grant_failed', 'revoke_failed') THEN
    v_code := coalesce(v_code, 'unknown');
  END IF;
  v_ksef_code := CASE WHEN p_ksef_code BETWEEN 100 AND 999 THEN p_ksef_code END;

  UPDATE public.ksef_permission_grants
     SET status = p_status,
         ksef_status_code = coalesce(v_ksef_code, ksef_status_code),
         ksef_status_description = coalesce(left(p_ksef_description, 500), ksef_status_description),
         error_code = v_code,
         checked_at = now(),
         granted_at = CASE WHEN p_status = 'granted' THEN now() ELSE granted_at END,
         revoked_at = CASE WHEN p_status = 'revoked' THEN now() ELSE revoked_at END
   WHERE id = v_row.id;

  IF p_status <> v_row.status THEN
    v_action := CASE p_status
      WHEN 'granted' THEN 'accountant.ksef_permission_granted'
      WHEN 'grant_failed' THEN 'accountant.ksef_permission_grant_failed'
      WHEN 'revoked' THEN 'accountant.ksef_permission_revoked'
      ELSE 'accountant.ksef_permission_revoke_failed'
    END;
    INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    VALUES (
      v_tenant_id, auth.uid(), v_action, 'ksef_permission_grant', v_row.id,
      jsonb_build_object(
        'subjectNip', v_row.subject_nip,
        'subjectName', v_row.subject_name,
        'scopes', to_jsonb(v_row.scopes),
        'canDelegate', v_row.can_delegate,
        'environment', v_row.ksef_environment,
        'references', to_jsonb(v_row.operation_references),
        'ksefStatusCode', v_ksef_code,
        'ksefStatusDescription', left(p_ksef_description, 200),
        'errorCode', v_code
      )
    );
  END IF;

  RETURN jsonb_build_object('status', 'saved', 'row_status', p_status);
END;
$$;

COMMENT ON FUNCTION public.record_ksef_permission_check(uuid, text[], text, integer, text, text) IS
  'Zapisuje wynik sprawdzenia operacji nadania albo odebrania uprawnienia KSeF w toku (właściciel, te same numery '
  'operacji) z audytem accountant.ksef_permission_* przy zmianie stanu.';

REVOKE ALL ON FUNCTION public.claim_ksef_permission_grant(text, text, text, text[], boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_ksef_permission_grant(text, text, text, text[], boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.claim_ksef_permission_revoke(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_ksef_permission_revoke(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.finish_ksef_permission_attempt(uuid, uuid, text, text[], integer, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finish_ksef_permission_attempt(uuid, uuid, text, text[], integer, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.record_ksef_permission_check(uuid, text[], text, integer, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_ksef_permission_check(uuid, text[], text, integer, text, text) TO authenticated;

-- PostgREST na serwerze trzyma schemat w pamięci: nowa tabela i funkcje
-- muszą być widoczne, zanim ruszy wersja aplikacji, która ich używa.
NOTIFY pgrst, 'reload schema';
