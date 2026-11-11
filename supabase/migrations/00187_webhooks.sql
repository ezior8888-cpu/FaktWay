-- ═══════════════════════════════════════════════════════════════
-- 00187: webhooki publicznego API (plan
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 7.1, część 3)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem, PO 00181 i 00184 (stos #573, #583: rola
-- `api_key_client` i flaga `publicApiEnabled`). Addytywna: dwie nowe tabele,
-- wyzwalacze tylko na nich i nowe funkcje dla workera. Bez DROP tabel
-- i kolumn, bez zmiany istniejących danych, polityk i grantów. Stary kod
-- nowych obiektów nie używa; nowy bez nich: zakładka „API” pokazuje błąd listy
-- webhooków (i tak ukryta flagą), a joby webhooków przy włączonej fladze
-- kończą się błędem RPC (przy wyłączonej nic nie robią).
--
-- PROJEKT (uzasadnienie w PR):
--   * `webhook_endpoints`: adres (tylko https na porcie 443, nazwa domeny;
--     aplikacja sprawdza go przed zapisem i przy każdej wysyłce po DNS),
--     zdarzenia i sekret podpisu ZASZYFROWANY (AES-256-GCM kluczem spoza bazy,
--     `lib/webhooks/secret-box.ts`). Szyfrogram nie wraca do przeglądarki
--     (grant kolumnowy). Dodają i usuwają właściciel albo administrator;
--     dodanie z kodem 2FA (`session_may_grant_access`, 00163), jak klucz API.
--     Autor, daty i liczniki z bazy; najwyżej 5 webhooków na firmę.
--   * `webhook_deliveries` (dziennik dostaw): jedna dostawa na (webhook,
--     zdarzenie), UNIQUE, więc ponowione zdarzenie nie wyśle się drugi raz.
--     Stan, kod odpowiedzi, rodzaj błędu, czas, liczba prób. Klient czyta
--     (bez treści zdarzenia), pisze tylko worker przez funkcje niżej.
--   * Wysyłka (`service_role`): utworzenie dostaw, przejęcie należnych
--     (SKIP LOCKED, dzierżawa 120 s, numer próby zapisany przy przejęciu),
--     zapis wyniku z harmonogramem 1 min, 5 min, 30 min, 2 h, 12 h (6 prób),
--     potem `failed`.
--   * Po 20 nieudanych dostawach z rzędu webhook wyłącza się sam: data
--     i powód, oczekujące dostawy anulowane, wpis `webhook.auto_disabled`
--     w `audit_logs`. Wyjście: „Włącz ponownie” w Ustawieniach (właściciel,
--     administrator) albo operator: UPDATE `disabled_at = NULL` kluczem serwisowym.
--
-- Po wgraniu: NOTIFY pgrst + schema_migrations (scripts/ops/wgraj-migracje.sh).
-- Wycofanie: usunąć funkcje `webhook_*`, wyzwalacze i obie tabele
-- (najpierw `webhook_deliveries`).
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Webhooki firmy ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Postać znormalizowana z aplikacji (`new URL().href`): małe litery w nazwie, bez portu.
  url TEXT NOT NULL,
  events TEXT[] NOT NULL,
  -- base64: [„FWW1”][odcisk klucza][sól][IV][tag][szyfrogram]; jawny sekret nigdy nie trafia do bazy.
  secret_ciphertext TEXT NOT NULL,
  created_by UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  disabled_reason TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  CONSTRAINT webhook_endpoints_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT webhook_endpoints_url_check CHECK (
    char_length(url) <= 2048
    AND url ~ '^https://[a-z0-9.-]+/[^#[:space:]]*$'
    AND url !~ '^https://[0-9.]+/'
  ),
  CONSTRAINT webhook_endpoints_events_check CHECK (
    cardinality(events) BETWEEN 1 AND 3
    AND events <@ ARRAY['invoice.ksef_accepted', 'expense.ksef_received', 'payment.recorded']::TEXT[]
  ),
  CONSTRAINT webhook_endpoints_secret_check CHECK (
    secret_ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$' AND char_length(secret_ciphertext) BETWEEN 100 AND 400
  ),
  CONSTRAINT webhook_endpoints_disabled_check CHECK (
    (disabled_at IS NULL AND disabled_reason IS NULL)
    OR (disabled_at IS NOT NULL AND disabled_reason IN ('consecutive_failures'))
  ),
  CONSTRAINT webhook_endpoints_failures_check CHECK (consecutive_failures >= 0)
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant ON public.webhook_endpoints (tenant_id, created_at DESC);

COMMENT ON TABLE public.webhook_endpoints IS
  'Webhooki publicznego API firmy (00187, krok 7.1): adres https, zdarzenia, sekret podpisu zaszyfrowany kluczem spoza bazy; '
  'wyłączenie po 20 nieudanych dostawach z rzędu; zmiany w audit_logs wyzwalaczem.';

ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_endpoints_select_owner_admin" ON public.webhook_endpoints;
CREATE POLICY "webhook_endpoints_select_owner_admin" ON public.webhook_endpoints
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "webhook_endpoints_insert_owner_admin_code" ON public.webhook_endpoints;
CREATE POLICY "webhook_endpoints_insert_owner_admin_code" ON public.webhook_endpoints
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
    AND public.session_may_grant_access()
  );

-- Jedyna zmiana klienta to ponowne włączenie wyłączonego webhooka (grant
-- kolumnowy na `disabled_at`); licznik i powód zeruje wyzwalacz. Bez kodu:
-- adres zatwierdzono kodem przy dodaniu, a włączenie go nie zmienia.
DROP POLICY IF EXISTS "webhook_endpoints_enable_owner_admin" ON public.webhook_endpoints;
CREATE POLICY "webhook_endpoints_enable_owner_admin" ON public.webhook_endpoints
  FOR UPDATE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
    AND disabled_at IS NOT NULL
  )
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND disabled_at IS NULL
  );

DROP POLICY IF EXISTS "webhook_endpoints_delete_owner_admin" ON public.webhook_endpoints;
CREATE POLICY "webhook_endpoints_delete_owner_admin" ON public.webhook_endpoints
  FOR DELETE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

REVOKE ALL ON public.webhook_endpoints FROM PUBLIC, anon, authenticated, service_role, api_key_client;
-- Bez `secret_ciphertext`: szyfrogram nie wraca do przeglądarki.
GRANT SELECT (
  id, tenant_id, url, events, created_by, created_at, disabled_at, disabled_reason,
  consecutive_failures, last_success_at, last_failure_at
) ON public.webhook_endpoints TO authenticated;
GRANT INSERT (id, tenant_id, url, events, secret_ciphertext) ON public.webhook_endpoints TO authenticated;
GRANT UPDATE (disabled_at) ON public.webhook_endpoints TO authenticated;
GRANT DELETE ON public.webhook_endpoints TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_endpoints TO service_role;

-- ─── 2. Dziennik dostaw ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  webhook_id UUID NOT NULL,
  -- Stały identyfikator zdarzenia (UUID v5 z typu i obiektu, `lib/webhooks/event-id.ts`).
  event_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  -- Treść zdarzenia bez danych osobowych (`lib/webhooks/payloads.ts`); każda próba wysyła tę samą.
  data JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Dzierżawa próby w toku: równoległy przebieg jej nie przejmie, a po awarii workera wygasa.
  locked_until TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_status_code INTEGER,
  last_error TEXT,
  last_duration_ms INTEGER,
  delivered_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_webhook_fkey FOREIGN KEY (tenant_id, webhook_id)
    REFERENCES public.webhook_endpoints (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT webhook_deliveries_event_key UNIQUE (webhook_id, event_id),
  CONSTRAINT webhook_deliveries_event_type_check CHECK (
    event_type IN ('invoice.ksef_accepted', 'expense.ksef_received', 'payment.recorded')
  ),
  CONSTRAINT webhook_deliveries_status_check CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT webhook_deliveries_attempts_check CHECK (attempts BETWEEN 0 AND 6),
  CONSTRAINT webhook_deliveries_status_code_check CHECK (last_status_code IS NULL OR last_status_code BETWEEN 100 AND 599),
  CONSTRAINT webhook_deliveries_error_check CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,40}$'),
  CONSTRAINT webhook_deliveries_duration_check CHECK (last_duration_ms IS NULL OR last_duration_ms >= 0),
  CONSTRAINT webhook_deliveries_data_check CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) <= 16384),
  CONSTRAINT webhook_deliveries_delivered_check CHECK ((status = 'succeeded') = (delivered_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON public.webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant
  ON public.webhook_deliveries (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook
  ON public.webhook_deliveries (webhook_id, created_at DESC);

COMMENT ON TABLE public.webhook_deliveries IS
  'Dziennik dostaw webhooków (00187, krok 7.1): jedna dostawa na webhook i zdarzenie (UNIQUE), stan, kod odpowiedzi, '
  'liczba prób; ponowienia 1 min, 5 min, 30 min, 2 h, 12 h. Pisze tylko worker przez funkcje webhook_*.';

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_deliveries_select_owner_admin" ON public.webhook_deliveries;
CREATE POLICY "webhook_deliveries_select_owner_admin" ON public.webhook_deliveries
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

REVOKE ALL ON public.webhook_deliveries FROM PUBLIC, anon, authenticated, service_role, api_key_client;
-- Bez `data`: treść zdarzenia zna tylko worker (i program klienta, który ją dostał).
GRANT SELECT (
  id, tenant_id, webhook_id, event_id, event_type, occurred_at, status, attempts, next_attempt_at,
  last_attempt_at, last_status_code, last_error, last_duration_ms, delivered_at, finished_at, created_at
) ON public.webhook_deliveries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_deliveries TO service_role;

-- ─── 3. Strażnik i audyt zmian webhooków ─────────────────────────
-- BEFORE: autor, daty i liczniki z bazy, najwyżej 5 webhooków na firmę, treść
-- niezmienna. Sesja klienta może tylko włączyć wyłączony webhook (licznik od
-- zera); worker (bez auth.uid()) zmienia liczniki i stan wyłączenia.
CREATE OR REPLACE FUNCTION public.guard_webhook_endpoint()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (SELECT count(*) FROM public.webhook_endpoints w WHERE w.tenant_id = NEW.tenant_id) >= 5 THEN
      RAISE EXCEPTION 'webhook_limit' USING ERRCODE = 'P0001',
        DETAIL = 'Firma ma już 5 webhooków.';
    END IF;
    NEW.created_at := now();
    NEW.created_by := coalesce(auth.uid(), NEW.created_by);
    NEW.disabled_at := NULL;
    NEW.disabled_reason := NULL;
    NEW.consecutive_failures := 0;
    NEW.last_success_at := NULL;
    NEW.last_failure_at := NULL;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.url, NEW.events, NEW.secret_ciphertext, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.url, OLD.events, OLD.secret_ciphertext, OLD.created_at)
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'webhook_immutable' USING ERRCODE = '42501';
  END IF;

  -- Usunięcie konta autora (klucz obcy SET NULL): sama zmiana autora przechodzi.
  IF ROW(NEW.disabled_at, NEW.disabled_reason, NEW.consecutive_failures, NEW.last_success_at, NEW.last_failure_at)
     IS NOT DISTINCT FROM
     ROW(OLD.disabled_at, OLD.disabled_reason, OLD.consecutive_failures, OLD.last_success_at, OLD.last_failure_at) THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    IF OLD.disabled_at IS NULL OR NEW.disabled_at IS NOT NULL THEN
      RAISE EXCEPTION 'webhook_enable_only' USING ERRCODE = '42501';
    END IF;
    NEW.disabled_reason := NULL;
    NEW.consecutive_failures := 0;
    NEW.last_success_at := OLD.last_success_at;
    NEW.last_failure_at := OLD.last_failure_at;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_webhook_endpoint() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a_guard_webhook_endpoint ON public.webhook_endpoints;
CREATE TRIGGER a_guard_webhook_endpoint
  BEFORE INSERT OR UPDATE ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.guard_webhook_endpoint();

-- AFTER: wpis audytu w tej samej transakcji co zmiana. Z adresu tylko nazwa
-- serwera (ścieżka i zapytanie bywają tajne, np. token integracji), bez sekretu.
CREATE OR REPLACE FUNCTION public.audit_webhook_endpoint_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.webhook_endpoints%ROWTYPE;
  v_action text;
  v_metadata jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Kaskada z usuwanej firmy: wiersza firmy już nie ma, wpis złamałby klucz obcy `audit_logs`.
    IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = OLD.tenant_id) THEN
      RETURN NULL;
    END IF;
    v_row := OLD;
    v_action := 'webhook.deleted';
  ELSIF TG_OP = 'INSERT' THEN
    v_row := NEW;
    v_action := 'webhook.created';
  ELSIF OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL THEN
    v_row := NEW;
    v_action := 'webhook.auto_disabled';
  ELSIF OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NULL THEN
    v_row := NEW;
    v_action := 'webhook.enabled';
  ELSE
    RETURN NULL;
  END IF;

  v_metadata := jsonb_build_object(
    'host', substring(v_row.url FROM '^https://([^/]+)'),
    'events', to_jsonb(v_row.events)
  );
  IF v_action = 'webhook.auto_disabled' THEN
    v_metadata := v_metadata || jsonb_build_object(
      'reason', v_row.disabled_reason,
      'consecutive_failures', v_row.consecutive_failures
    );
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (v_row.tenant_id, auth.uid(), v_action, 'webhook', v_row.id, v_metadata);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_webhook_endpoint_change() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS z_audit_webhook_endpoint_change ON public.webhook_endpoints;
CREATE TRIGGER z_audit_webhook_endpoint_change
  AFTER INSERT OR DELETE OR UPDATE OF disabled_at ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.audit_webhook_endpoint_change();

-- ─── 4. Wysyłka (worker, service_role) ───────────────────────────
-- Dostawy zdarzenia dla włączonych webhooków firmy, które słuchają tego
-- zdarzenia i powstały przed nim (ponowna emisja starego zdarzenia nie trafi
-- do nowego adresu). Ten sam `p_event_id` drugi raz nic nie tworzy.
CREATE OR REPLACE FUNCTION public.webhook_create_deliveries(
  p_tenant_id uuid,
  p_event_type text,
  p_event_id uuid,
  p_occurred_at timestamptz,
  p_data jsonb
)
RETURNS uuid[]
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH created AS (
    INSERT INTO public.webhook_deliveries (tenant_id, webhook_id, event_id, event_type, occurred_at, data)
    SELECT w.tenant_id, w.id, p_event_id, p_event_type, p_occurred_at, p_data
      FROM public.webhook_endpoints w
     WHERE w.tenant_id = p_tenant_id
       AND w.disabled_at IS NULL
       AND p_event_type = ANY (w.events)
       AND w.created_at <= p_occurred_at
    ON CONFLICT (webhook_id, event_id) DO NOTHING
    RETURNING id
  )
  SELECT coalesce(array_agg(created.id), ARRAY[]::uuid[]) FROM created;
$$;

-- Nieudana dostawa liczona do wyłączenia. Wewnętrzna (bez EXECUTE dla ról API).
CREATE OR REPLACE FUNCTION public.webhook_note_final_failure(p_webhook_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_disabled_id uuid;
BEGIN
  UPDATE public.webhook_endpoints w
     SET consecutive_failures = w.consecutive_failures + 1
   WHERE w.id = p_webhook_id
     AND w.disabled_at IS NULL;

  -- 20 nieudanych dostaw z rzędu: webhook wyłącza się sam (audyt dopisuje wyzwalacz).
  UPDATE public.webhook_endpoints w
     SET disabled_at = now(),
         disabled_reason = 'consecutive_failures'
   WHERE w.id = p_webhook_id
     AND w.disabled_at IS NULL
     AND w.consecutive_failures >= 20
  RETURNING w.id INTO v_disabled_id;
  IF v_disabled_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.webhook_deliveries d
     SET status = 'cancelled',
         finished_at = now(),
         locked_until = NULL,
         last_error = coalesce(d.last_error, 'webhook_disabled')
   WHERE d.webhook_id = p_webhook_id
     AND d.status = 'pending';
  RETURN true;
END;
$$;

-- Przejęcie należnych dostaw: wszystkich (cron) albo podanych (pierwsza próba).
-- SKIP LOCKED i dzierżawa 120 s: równoległy przebieg nie weźmie tej samej
-- dostawy, dostawa po sukcesie nie wraca. Numer próby rośnie przy przejęciu,
-- więc padnięty worker też zużywa próbę (najwyżej 6).
CREATE OR REPLACE FUNCTION public.webhook_claim_deliveries(
  p_delivery_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 30
)
RETURNS TABLE (
  delivery_id uuid,
  tenant_id uuid,
  webhook_id uuid,
  url text,
  secret_ciphertext text,
  event_id uuid,
  event_type text,
  occurred_at timestamptz,
  data jsonb,
  attempt integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_interrupted record;
BEGIN
  -- Ostatnia próba przerwana (worker padł, dzierżawa wygasła): dostawa nieudana.
  FOR v_interrupted IN
    UPDATE public.webhook_deliveries d
       SET status = 'failed',
           finished_at = now(),
           locked_until = NULL,
           last_error = coalesce(d.last_error, 'interrupted')
     WHERE d.status = 'pending'
       AND d.attempts >= 6
       AND d.locked_until < now()
    RETURNING d.webhook_id AS hook
  LOOP
    PERFORM public.webhook_note_final_failure(v_interrupted.hook);
  END LOOP;

  RETURN QUERY
  WITH due AS (
    SELECT d.id AS due_id,
           row_number() OVER (PARTITION BY d.webhook_id ORDER BY d.next_attempt_at, d.id) AS hook_rank
      FROM public.webhook_deliveries d
      JOIN public.webhook_endpoints w ON w.id = d.webhook_id
     WHERE d.status = 'pending'
       AND d.attempts < 6
       AND d.next_attempt_at <= now()
       AND (d.locked_until IS NULL OR d.locked_until < now())
       AND w.disabled_at IS NULL
       AND (p_delivery_ids IS NULL OR d.id = ANY (p_delivery_ids))
  ),
  picked AS (
    -- Warunki jeszcze raz na wierszu: blokada sprawdza je na najnowszej wersji.
    SELECT d.id AS picked_id
      FROM public.webhook_deliveries d
      JOIN due ON due.due_id = d.id
     WHERE due.hook_rank <= 5
       AND d.status = 'pending'
       AND d.attempts < 6
       AND d.next_attempt_at <= now()
       AND (d.locked_until IS NULL OR d.locked_until < now())
     ORDER BY d.next_attempt_at, d.id
     LIMIT greatest(1, least(coalesce(p_limit, 30), 100))
     FOR UPDATE OF d SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.webhook_deliveries d
       SET attempts = d.attempts + 1,
           locked_until = now() + interval '120 seconds',
           last_attempt_at = now()
      FROM picked
     WHERE d.id = picked.picked_id
    RETURNING d.id AS c_id, d.tenant_id AS c_tenant, d.webhook_id AS c_hook, d.event_id AS c_event,
              d.event_type AS c_type, d.occurred_at AS c_occurred, d.data AS c_data, d.attempts AS c_attempt
  )
  SELECT c.c_id, c.c_tenant, c.c_hook, w.url, w.secret_ciphertext, c.c_event, c.c_type, c.c_occurred, c.c_data, c.c_attempt
    FROM claimed c
    JOIN public.webhook_endpoints w ON w.id = c.c_hook;
END;
$$;

-- Wynik próby i dziennik. Spóźniony wynik (dostawa zakończona albo przejęta
-- przez nowszą próbę) nic nie zmienia. Harmonogram ponowień tutaj, w bazie;
-- `lib/webhooks/types.ts` ma ten sam (test pilnuje zgodności).
CREATE OR REPLACE FUNCTION public.webhook_record_attempt(
  p_delivery_id uuid,
  p_attempt integer,
  p_succeeded boolean,
  p_status_code integer,
  p_error text,
  p_duration_ms integer,
  p_counts_toward_disable boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Odstęp po nieudanej próbie nr 1-5; po 6. dostawa jest nieudana.
  v_delays constant interval[] := ARRAY['1 minute', '5 minutes', '30 minutes', '2 hours', '12 hours']::interval[];
  v_delivery public.webhook_deliveries%ROWTYPE;
  v_disabled boolean := false;
  v_next timestamptz;
BEGIN
  SELECT * INTO v_delivery FROM public.webhook_deliveries d WHERE d.id = p_delivery_id FOR UPDATE;
  IF NOT FOUND
     OR v_delivery.status <> 'pending'
     OR v_delivery.attempts IS DISTINCT FROM p_attempt
     OR v_delivery.locked_until IS NULL THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  IF p_succeeded THEN
    UPDATE public.webhook_deliveries d
       SET status = 'succeeded',
           delivered_at = now(),
           finished_at = now(),
           locked_until = NULL,
           last_status_code = p_status_code,
           last_error = NULL,
           last_duration_ms = p_duration_ms
     WHERE d.id = p_delivery_id;
    UPDATE public.webhook_endpoints w
       SET consecutive_failures = 0,
           last_success_at = now()
     WHERE w.id = v_delivery.webhook_id;
    RETURN jsonb_build_object('applied', true, 'status', 'succeeded');
  END IF;

  UPDATE public.webhook_endpoints w SET last_failure_at = now() WHERE w.id = v_delivery.webhook_id;

  IF v_delivery.attempts >= 6 THEN
    UPDATE public.webhook_deliveries d
       SET status = 'failed',
           finished_at = now(),
           locked_until = NULL,
           last_status_code = p_status_code,
           last_error = p_error,
           last_duration_ms = p_duration_ms
     WHERE d.id = p_delivery_id;
    -- Błąd po stronie FaktWay (brak klucza do podpisu) nie zbliża webhooka do wyłączenia.
    IF coalesce(p_counts_toward_disable, true) THEN
      v_disabled := public.webhook_note_final_failure(v_delivery.webhook_id);
    END IF;
    RETURN jsonb_build_object('applied', true, 'status', 'failed', 'webhook_disabled', v_disabled);
  END IF;

  v_next := now() + v_delays[v_delivery.attempts];
  UPDATE public.webhook_deliveries d
     SET next_attempt_at = v_next,
         locked_until = NULL,
         last_status_code = p_status_code,
         last_error = p_error,
         last_duration_ms = p_duration_ms
   WHERE d.id = p_delivery_id;
  RETURN jsonb_build_object('applied', true, 'status', 'pending', 'next_attempt_at', v_next);
END;
$$;

REVOKE ALL ON FUNCTION public.webhook_note_final_failure(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.webhook_create_deliveries(uuid, text, uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.webhook_claim_deliveries(uuid[], integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.webhook_record_attempt(uuid, integer, boolean, integer, text, integer, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.webhook_create_deliveries(uuid, text, uuid, timestamptz, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.webhook_claim_deliveries(uuid[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.webhook_record_attempt(uuid, integer, boolean, integer, text, integer, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
