-- ═══════════════════════════════════════════════════════════════
-- 00191: identyfikatory zbiorcze KSeF (plan kompletnej aplikacji, krok 1.4,
-- część 2; rejestr przepisów RP-PLAT-01, RP-PLAT-02).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Addytywna: nowa tabela, indeksy, funkcja
-- wyzwalacza, trzy funkcje RPC i polityka RLS; bez DROP tabel i kolumn, bez
-- zmiany istniejących danych (bez DML poza ciałami funkcji). Kod czyta tabelę
-- odpornie (brak tabeli = brak zapisanych identyfikatorów, brak funkcji =
-- komunikat „po aktualizacji”), więc kolejność nie wywraca listy „Do zapłaty”.
-- Numer z rejestru docs/koordynacja/CLAUDE-DO-CODEXA.md (00184-00190 zajmują
-- inne otwarte PR).
--
-- Po co: od płatności z 1.01.2027 przelew za kilka faktur jednego dostawcy
-- ma w tytule identyfikator zbiorczy nadany przez KSeF (art. 108g ustawy
-- o VAT w brzmieniu z Dz.U. 2025 poz. 1203). `POST /collective-identifiers`
-- nie jest idempotentne, a faktura mieści najwyżej 132 identyfikatory, więc
-- wynik zapisujemy: ponowne kliknięcie dla tego samego zestawu faktur oddaje
-- zapisany identyfikator bez pytania KSeF.
--
-- ksef_collective_identifiers: jeden wiersz na zestaw faktur w firmie
-- i środowisku KSeF (UNIQUE tenant_id, ksef_environment, invoices_key;
-- invoices_key to SHA-256 numerów KSeF bez powtórzeń, posortowanych
-- COLLATE "C" i złączonych przecinkiem). Stany: pending (próba w toku, żeton
-- `attempt`), ready (identyfikator, stan końcowy), failed (kod błędu). Próbę
-- pending starszą niż 5 minut (przerwana akcja, restart serwera) przejmuje
-- kolejna rezerwacja z nowym żetonem; stara próba niczego już nie zapisze.
--
-- Zapis tylko przez trzy funkcje SECURITY DEFINER z kontrolą firmy
-- (get_current_tenant_id, nagłówek x-active-org) i roli owner/admin
-- (has_org_role z 00037):
--   claim_ksef_collective_identifier     rezerwacja zestawu albo zapisany identyfikator;
--   complete_ksef_collective_identifier  identyfikator dla bieżącej próby, audyt
--                                        expense.collective_identifier_created;
--   fail_ksef_collective_identifier      kod błędu dla bieżącej próby, audyt
--                                        expense.collective_identifier_failed.
-- Sesja: odczyt własnej firmy (każda rola, także księgowa) bez kolumny
-- `attempt`; bez INSERT, UPDATE i DELETE. service_role: pełny dostęp.
-- Przejścia stanów i niezmienność zestawu pilnuje wyzwalacz, także przy
-- kluczu serwisowym.
--
-- Ścieżka operatora: gotowy identyfikator, który trzeba wymienić, usuwa się
-- kluczem serwisowym (usunięcie wiersza po id); następne kliknięcie klienta
-- utworzy nowy. Historia zostaje w audit_logs.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ksef_collective_identifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  ksef_environment TEXT NOT NULL,
  -- NIP sprzedawcy faktur: pierwsze 10 cyfr identyfikatora.
  seller_nip TEXT NOT NULL,
  -- Numery KSeF bez powtórzeń, rosnąco (COLLATE "C"), od 2 do 500.
  ksef_numbers TEXT[] NOT NULL,
  -- SHA-256 (hex) numerów złączonych przecinkiem: klucz zestawu.
  invoices_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  -- Żeton bieżącej próby: wynik zapisuje tylko próba z tym samym żetonem.
  attempt UUID NOT NULL DEFAULT gen_random_uuid(),
  identifier TEXT,
  error_code TEXT,
  requested_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT ksef_collective_identifiers_environment_check CHECK (ksef_environment IN ('test', 'demo', 'production')),
  CONSTRAINT ksef_collective_identifiers_seller_nip_check CHECK (seller_nip ~ '^[0-9]{10}$'),
  CONSTRAINT ksef_collective_identifiers_numbers_check
    CHECK (cardinality(ksef_numbers) BETWEEN 2 AND 500 AND array_position(ksef_numbers, NULL) IS NULL),
  CONSTRAINT ksef_collective_identifiers_key_check CHECK (invoices_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ksef_collective_identifiers_status_check CHECK (status IN ('pending', 'ready', 'failed')),
  -- Format ze specyfikacji KSeF 2.0; sumę kontrolną CRC-8 sprawdza aplikacja (lib/invoices/identyfikator-zbiorczy.ts).
  CONSTRAINT ksef_collective_identifiers_identifier_check
    CHECK (identifier IS NULL OR identifier ~ '^[1-9][0-9]{9}-IZ20[0-9]{2}(0[1-9]|1[0-2])-[0-9A-F]{12}-[0-9A-F]{2}$'),
  CONSTRAINT ksef_collective_identifiers_ready_check CHECK ((status = 'ready') = (identifier IS NOT NULL)),
  CONSTRAINT ksef_collective_identifiers_failed_check CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT ksef_collective_identifiers_error_code_check CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS ksef_collective_identifiers_zestaw
  ON public.ksef_collective_identifiers (tenant_id, ksef_environment, invoices_key);

-- Lista „Do zapłaty”: gotowe identyfikatory dostawców z listy.
CREATE INDEX IF NOT EXISTS ksef_collective_identifiers_dostawca
  ON public.ksef_collective_identifiers (tenant_id, ksef_environment, seller_nip, status);

COMMENT ON TABLE public.ksef_collective_identifiers IS
  'Identyfikatory zbiorcze KSeF (krok 1.4, część 2): jeden wiersz na zestaw faktur w firmie i środowisku, '
  'stan pending/ready/failed. Zapis tylko przez RPC claim/complete/fail_ksef_collective_identifier z audytem.';

CREATE OR REPLACE FUNCTION public.guard_ksef_collective_identifier()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.ksef_environment IS DISTINCT FROM OLD.ksef_environment
     OR NEW.seller_nip IS DISTINCT FROM OLD.seller_nip
     OR NEW.ksef_numbers IS DISTINCT FROM OLD.ksef_numbers
     OR NEW.invoices_key IS DISTINCT FROM OLD.invoices_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Zestaw faktur identyfikatora zbiorczego jest niezmienny; inny zestaw to nowy wiersz.'
      USING ERRCODE = '23514', HINT = 'ksef_collective_identifier_immutable';
  END IF;
  IF OLD.status = 'ready' THEN
    RAISE EXCEPTION 'Gotowy identyfikator zbiorczy jest niezmienny; do wymiany wiersz usuwa operator.'
      USING ERRCODE = '23514', HINT = 'ksef_collective_identifier_ready';
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('pending', 'ready', 'failed'))
    OR (OLD.status = 'failed' AND NEW.status = 'pending')
  ) THEN
    RAISE EXCEPTION 'Identyfikator zbiorczy w stanie % nie przechodzi w stan %.', OLD.status, NEW.status
      USING ERRCODE = '23514', HINT = 'ksef_collective_identifier_transition';
  END IF;
  RETURN NEW;
END;
$$;

-- Jak `guard_expense_payment_columns` (00177): funkcji wyzwalacza nikt nie woła wprost.
REVOKE ALL ON FUNCTION public.guard_ksef_collective_identifier() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_ksef_collective_identifiers_guard ON public.ksef_collective_identifiers;
CREATE TRIGGER trigger_ksef_collective_identifiers_guard
  BEFORE UPDATE ON public.ksef_collective_identifiers
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_ksef_collective_identifier();

ALTER TABLE public.ksef_collective_identifiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ksef_collective_identifiers_select_own_tenant" ON public.ksef_collective_identifiers;
CREATE POLICY "ksef_collective_identifiers_select_own_tenant"
  ON public.ksef_collective_identifiers
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

REVOKE ALL ON public.ksef_collective_identifiers FROM PUBLIC, anon, authenticated, service_role;
-- Bez `attempt`: żeton próby zna tylko akcja, która ją zarezerwowała.
GRANT SELECT (id, tenant_id, ksef_environment, seller_nip, ksef_numbers, invoices_key, status, identifier, error_code,
              requested_by, created_at, claimed_at, completed_at)
  ON public.ksef_collective_identifiers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ksef_collective_identifiers TO service_role;

-- Rezerwacja zestawu faktur. Zwraca:
--   claimed      nowa próba (id, attempt): akcja woła KSeF i zapisuje wynik;
--   ready        zapisany identyfikator (bez nowej próby i bez KSeF);
--   in_progress  próba w toku młodsza niż 5 minut (druga karta, dwuklik);
--   refused      złe wejście (kod).
-- Dwie rezerwacje naraz: INSERT drugiej czeka na pierwszą (indeks UNIQUE),
-- potem widzi świeżą próbę i dostaje in_progress.
CREATE OR REPLACE FUNCTION public.claim_ksef_collective_identifier(
  p_environment text,
  p_seller_nip text,
  p_ksef_numbers text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_numbers text[];
  v_key text;
  v_attempt uuid := gen_random_uuid();
  v_row public.ksef_collective_identifiers%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Collective identifier requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner') OR public.has_org_role(v_tenant_id, 'admin')) THEN
    RAISE EXCEPTION 'Insufficient role to request a collective identifier' USING ERRCODE = '42501';
  END IF;

  IF p_environment IS NULL OR p_environment NOT IN ('test', 'demo', 'production') THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_environment');
  END IF;
  IF p_seller_nip IS NULL OR p_seller_nip !~ '^[0-9]{10}$' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_seller');
  END IF;
  IF p_ksef_numbers IS NULL OR cardinality(p_ksef_numbers) < 2 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'too_few');
  END IF;
  IF cardinality(p_ksef_numbers) > 500 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'too_many');
  END IF;
  -- Wzorzec TNumerKSeF ze schematu FA(3), jak WZORZEC_NUMERU_KSEF w lib/invoices/tytul-przelewu.ts.
  IF EXISTS (
    SELECT 1
      FROM unnest(p_ksef_numbers) AS n(numer)
     WHERE n.numer IS NULL
        OR n.numer !~ ('^([1-9](([0-9][1-9])|([1-9][0-9]))[0-9]{7}|M[0-9]{9}|[A-Z]{3}[0-9]{7})'
                       '-(20[2-9][0-9]|2[1-9][0-9]{2}|[3-9][0-9]{3})(0[1-9]|1[0-2])(0[1-9]|[1-2][0-9]|3[0-1])'
                       '-([0-9A-F]{6})-?([0-9A-F]{6})-([0-9A-F]{2})$')
  ) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_number');
  END IF;

  SELECT array_agg(u.numer ORDER BY u.numer)
    INTO v_numbers
    FROM (SELECT DISTINCT n.numer COLLATE "C" AS numer FROM unnest(p_ksef_numbers) AS n(numer)) AS u;
  IF cardinality(v_numbers) <> cardinality(p_ksef_numbers) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'duplicate_number');
  END IF;
  v_key := encode(sha256(convert_to(array_to_string(v_numbers, ','), 'UTF8')), 'hex');

  INSERT INTO public.ksef_collective_identifiers
    (tenant_id, ksef_environment, seller_nip, ksef_numbers, invoices_key, status, attempt, requested_by)
  VALUES (v_tenant_id, p_environment, p_seller_nip, v_numbers, v_key, 'pending', v_attempt, auth.uid())
  ON CONFLICT (tenant_id, ksef_environment, invoices_key) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'claimed', 'id', v_row.id, 'attempt', v_attempt);
  END IF;

  -- Blokada wiersza: dwie rezerwacje przerwanej próby idą po kolei, druga widzi świeżą.
  SELECT * INTO v_row
    FROM public.ksef_collective_identifiers
   WHERE tenant_id = v_tenant_id AND ksef_environment = p_environment AND invoices_key = v_key
   FOR UPDATE;
  IF NOT FOUND THEN
    -- Wiersz usunięty między INSERT a odczytem (operator): następne kliknięcie zacznie od nowa.
    RETURN jsonb_build_object('status', 'in_progress');
  END IF;
  IF v_row.seller_nip <> p_seller_nip THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'seller_mismatch');
  END IF;
  IF v_row.status = 'ready' THEN
    RETURN jsonb_build_object('status', 'ready', 'id', v_row.id, 'identifier', v_row.identifier);
  END IF;
  IF v_row.status = 'pending' AND v_row.claimed_at > now() - interval '5 minutes' THEN
    RETURN jsonb_build_object('status', 'in_progress', 'id', v_row.id);
  END IF;

  UPDATE public.ksef_collective_identifiers
     SET status = 'pending',
         attempt = v_attempt,
         claimed_at = now(),
         completed_at = NULL,
         error_code = NULL,
         requested_by = auth.uid()
   WHERE id = v_row.id;
  RETURN jsonb_build_object('status', 'claimed', 'id', v_row.id, 'attempt', v_attempt);
END;
$$;

COMMENT ON FUNCTION public.claim_ksef_collective_identifier(text, text, text[]) IS
  'Rezerwacja zestawu faktur do identyfikatora zbiorczego KSeF (owner/admin): claimed z żetonem próby, '
  'ready z zapisanym identyfikatorem, in_progress dla próby młodszej niż 5 minut, refused z kodem.';

-- Zapis identyfikatora z KSeF dla bieżącej próby, z audytem w tej samej transakcji.
-- Inna próba (przejęta) dostaje refused/stale_attempt, a gotowy wiersz already_ready.
CREATE OR REPLACE FUNCTION public.complete_ksef_collective_identifier(
  p_id uuid,
  p_attempt uuid,
  p_identifier text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_row public.ksef_collective_identifiers%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Collective identifier requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner') OR public.has_org_role(v_tenant_id, 'admin')) THEN
    RAISE EXCEPTION 'Insufficient role to save a collective identifier' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
    FROM public.ksef_collective_identifiers
   WHERE id = p_id AND tenant_id = v_tenant_id
   FOR UPDATE;
  -- Wiersz obcej firmy wygląda jak brak wiersza.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF v_row.status = 'ready' THEN
    RETURN jsonb_build_object('status', 'already_ready', 'identifier', v_row.identifier);
  END IF;
  IF v_row.status <> 'pending' OR p_attempt IS NULL OR v_row.attempt <> p_attempt THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'stale_attempt');
  END IF;
  IF p_identifier IS NULL
     OR p_identifier !~ '^[1-9][0-9]{9}-IZ20[0-9]{2}(0[1-9]|1[0-2])-[0-9A-F]{12}-[0-9A-F]{2}$' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_identifier');
  END IF;

  UPDATE public.ksef_collective_identifiers
     SET status = 'ready', identifier = p_identifier, error_code = NULL, completed_at = now()
   WHERE id = v_row.id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'expense.collective_identifier_created', 'collective_identifier', v_row.id,
    jsonb_build_object(
      'identifier', p_identifier,
      'sellerNip', v_row.seller_nip,
      'ksefNumbers', to_jsonb(v_row.ksef_numbers),
      'invoiceCount', cardinality(v_row.ksef_numbers),
      'environment', v_row.ksef_environment
    )
  );

  RETURN jsonb_build_object('status', 'ready', 'identifier', p_identifier);
END;
$$;

COMMENT ON FUNCTION public.complete_ksef_collective_identifier(uuid, uuid, text) IS
  'Zapisuje identyfikator zbiorczy z KSeF dla bieżącej próby (owner/admin) z audytem '
  'expense.collective_identifier_created w tej samej transakcji.';

-- Porażka bieżącej próby (błąd KSeF, poświadczenia, zła odpowiedź) z audytem.
-- Kolejna rezerwacja tego zestawu to nowa próba.
CREATE OR REPLACE FUNCTION public.fail_ksef_collective_identifier(
  p_id uuid,
  p_attempt uuid,
  p_error_code text,
  p_detail text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_row public.ksef_collective_identifiers%ROWTYPE;
  v_code text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Collective identifier requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner') OR public.has_org_role(v_tenant_id, 'admin')) THEN
    RAISE EXCEPTION 'Insufficient role to close a collective identifier attempt' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
    FROM public.ksef_collective_identifiers
   WHERE id = p_id AND tenant_id = v_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF v_row.status <> 'pending' OR p_attempt IS NULL OR v_row.attempt <> p_attempt THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'stale_attempt');
  END IF;
  v_code := CASE WHEN p_error_code ~ '^[a-z0-9_]{1,64}$' THEN p_error_code ELSE 'unknown' END;

  UPDATE public.ksef_collective_identifiers
     SET status = 'failed', error_code = v_code, completed_at = now()
   WHERE id = v_row.id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'expense.collective_identifier_failed', 'collective_identifier', v_row.id,
    jsonb_build_object(
      'errorCode', v_code,
      'detail', left(p_detail, 200),
      'sellerNip', v_row.seller_nip,
      'ksefNumbers', to_jsonb(v_row.ksef_numbers),
      'invoiceCount', cardinality(v_row.ksef_numbers),
      'environment', v_row.ksef_environment
    )
  );

  RETURN jsonb_build_object('status', 'failed', 'code', v_code);
END;
$$;

COMMENT ON FUNCTION public.fail_ksef_collective_identifier(uuid, uuid, text, text) IS
  'Zamyka bieżącą próbę identyfikatora zbiorczego kodem błędu (owner/admin) z audytem '
  'expense.collective_identifier_failed w tej samej transakcji.';

REVOKE ALL ON FUNCTION public.claim_ksef_collective_identifier(text, text, text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_ksef_collective_identifier(text, text, text[]) TO authenticated;
REVOKE ALL ON FUNCTION public.complete_ksef_collective_identifier(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_ksef_collective_identifier(uuid, uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.fail_ksef_collective_identifier(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fail_ksef_collective_identifier(uuid, uuid, text, text) TO authenticated;

-- PostgREST na serwerze trzyma schemat w pamięci: nowa tabela i funkcje
-- muszą być widoczne, zanim ruszy wersja aplikacji, która ich używa.
NOTIFY pgrst, 'reload schema';
