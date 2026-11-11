-- ═══════════════════════════════════════════════════════════════
-- 00181: klucze API firmy i odczyt przez /api/v1 (plan
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 7.1, część 1)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Addytywna: nowa rola, nowa tabela, nowe
-- funkcje, polityki tylko dla nowej roli i wiersz flagi `publicApiEnabled`
-- (false). Bez DROP tabel i kolumn, bez zmiany istniejących danych, polityk
-- i grantów `anon`, `authenticated` i `service_role`. Stary kod tabeli nie
-- czyta; nowy bez niej odpowiada 503 (API) i pokazuje błąd listy (Ustawienia).
--
-- PROJEKT (uzasadnienie w PR):
--   * Klucz `fwk_…` (32 losowe bajty) klient widzi raz. Baza trzyma skrót
--     SHA-256 (hex) i prefiks do rozpoznania na liście, nigdy sam klucz.
--   * Na każde żądanie /api/v1 aplikacja wystawia token na 60 s (HS256,
--     sekret JWT Supabase) z rolą `api_key_client` i skrótem klucza. Token
--     nie opuszcza serwera aplikacji, a aplikacja nie używa w API klucza
--     serwisowego.
--   * FIRMĘ I ZAKRES USTALA BAZA ze skrótu (`api_key_request_tenant`), nie
--     aplikacja: polityki RLS nowej roli wpuszczają tylko wiersze firmy klucza,
--     tylko w jego zakresie i tylko dopóki klucz nie jest odwołany.
--   * Rola ma wyłącznie SELECT na wybranych kolumnach faktur, pozycji
--     i kosztów oraz trzy funkcje. Nie widzi `api_keys`, `audit_logs` ani
--     innych tabel i niczego nie zapisuje (wyzwalacze, które pilnują zapisów
--     `authenticated`, jej więc nie dotyczą).
--   * `api_key_session()` w jednej transakcji sprawdza klucz, zapisuje jego
--     użycie w `audit_logs` (punkt, identyfikator żądania, adres, przeglądarka;
--     bez treści odpowiedzi) i odświeża `last_used_at` (najwyżej raz na minutę).
--   * Klucze tworzą i odwołują właściciel albo administrator. Utworzenie
--     wymaga kodu 2FA, gdy konto go ma (`session_may_grant_access`, 00163),
--     jak link dla księgowej. Odwołanie jest nieodwracalne. Każda zmiana
--     trafia do `audit_logs` wyzwalaczem, także zapis z pominięciem akcji.
--
-- Po wgraniu: NOTIFY pgrst + schema_migrations (scripts/ops/wgraj-migracje.sh).
-- Wycofanie: DROP polityk `*_api_key_client`, funkcji `api_*`, tabeli
-- `api_keys` i roli `api_key_client` (najpierw REVOKE z `authenticator`).
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Rola zapytań API ─────────────────────────────────────────
-- Jak `ops_actor` (00100): NOLOGIN, bez hasła. PostgREST przełącza się na nią
-- z tokenu, więc `authenticator` musi być jej członkiem.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_key_client') THEN
    CREATE ROLE api_key_client NOLOGIN NOINHERIT;
  END IF;
END
$$;

GRANT api_key_client TO authenticator;
GRANT USAGE ON SCHEMA public TO api_key_client;

-- ─── 2. Tabela kluczy ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- `fwk_` i pierwsze 8 znaków sekretu: do rozpoznania klucza na liście.
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  created_by UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash),
  CONSTRAINT api_keys_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT api_keys_key_prefix_check CHECK (key_prefix ~ '^fwk_[A-Za-z0-9_-]{8}$'),
  CONSTRAINT api_keys_key_hash_check CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT api_keys_scopes_check CHECK (
    cardinality(scopes) BETWEEN 1 AND 2
    AND scopes <@ ARRAY['invoices:read', 'expenses:read']::TEXT[]
  ),
  CONSTRAINT api_keys_revoked_check CHECK ((revoked_at IS NULL) OR (revoked_at >= created_at))
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON public.api_keys (tenant_id, created_at DESC);

COMMENT ON TABLE public.api_keys IS
  'Klucze publicznego API firmy (00181, krok 7.1). Tylko skrót SHA-256 klucza i prefiks; '
  'zakresy invoices:read i expenses:read; odwołanie nieodwracalne; zmiany w audit_logs wyzwalaczem.';

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- Odczyt listy i zmiany: tylko właściciel i administrator aktywnej firmy.
DROP POLICY IF EXISTS "api_keys_select_owner_admin" ON public.api_keys;
CREATE POLICY "api_keys_select_owner_admin" ON public.api_keys
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "api_keys_insert_owner_admin_code" ON public.api_keys;
CREATE POLICY "api_keys_insert_owner_admin_code" ON public.api_keys
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
    AND public.session_may_grant_access()
  );

-- Jedyna zmiana klienta to odwołanie (grant kolumnowy na `revoked_at`).
-- Odwołanie tylko zabiera dostęp, więc nie wymaga kodu.
DROP POLICY IF EXISTS "api_keys_revoke_owner_admin" ON public.api_keys;
CREATE POLICY "api_keys_revoke_owner_admin" ON public.api_keys
  FOR UPDATE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
    AND revoked_at IS NULL
  )
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND revoked_at IS NOT NULL
  );

REVOKE ALL ON public.api_keys FROM PUBLIC, anon, authenticated, service_role;
-- Bez `key_hash`: skrót nie wraca do przeglądarki.
GRANT SELECT (id, tenant_id, name, key_prefix, scopes, created_by, created_at, last_used_at, revoked_at, revoked_by)
  ON public.api_keys TO authenticated;
GRANT INSERT (tenant_id, name, key_prefix, key_hash, scopes) ON public.api_keys TO authenticated;
GRANT UPDATE (revoked_at) ON public.api_keys TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_keys TO service_role;

-- ─── 3. Strażnik i audyt zmian kluczy ────────────────────────────
-- BEFORE: autor i daty z bazy, najwyżej 10 aktywnych kluczy na firmę, treść
-- klucza niezmienna, odwołanie nieodwracalne z czasem i autorem z bazy.
-- `created_by` i `revoked_by` mogą tylko spaść do NULL (usunięcie konta, FK).
CREATE OR REPLACE FUNCTION public.guard_api_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (
      SELECT count(*) FROM public.api_keys k
       WHERE k.tenant_id = NEW.tenant_id AND k.revoked_at IS NULL
    ) >= 10 THEN
      RAISE EXCEPTION 'api_key_limit' USING ERRCODE = 'P0001',
        DETAIL = 'Firma ma już 10 aktywnych kluczy API.';
    END IF;
    NEW.created_at := now();
    NEW.last_used_at := NULL;
    NEW.revoked_at := NULL;
    NEW.revoked_by := NULL;
    NEW.created_by := coalesce(auth.uid(), NEW.created_by);
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.name, NEW.key_prefix, NEW.key_hash, NEW.scopes, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.name, OLD.key_prefix, OLD.key_hash, OLD.scopes, OLD.created_at)
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'api_key_immutable' USING ERRCODE = '42501';
  END IF;

  IF OLD.revoked_at IS NOT NULL THEN
    IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR (NEW.revoked_by IS DISTINCT FROM OLD.revoked_by AND NEW.revoked_by IS NOT NULL) THEN
      RAISE EXCEPTION 'api_key_already_revoked' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := now();
    NEW.revoked_by := auth.uid();
  ELSIF NEW.revoked_by IS NOT NULL THEN
    RAISE EXCEPTION 'api_key_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_api_key() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a_guard_api_key ON public.api_keys;
CREATE TRIGGER a_guard_api_key
  BEFORE INSERT OR UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.guard_api_key();

-- AFTER: wpis audytu w tej samej transakcji co zmiana (także zapis wprost
-- przez PostgREST albo kluczem serwisowym). Bez skrótu klucza.
CREATE OR REPLACE FUNCTION public.audit_api_key_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    VALUES (
      NEW.tenant_id, auth.uid(), 'api_key.created', 'api_key', NEW.id,
      jsonb_build_object('name', NEW.name, 'key_prefix', NEW.key_prefix, 'scopes', to_jsonb(NEW.scopes))
    );
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    VALUES (
      NEW.tenant_id, auth.uid(), 'api_key.revoked', 'api_key', NEW.id,
      jsonb_build_object('name', NEW.name, 'key_prefix', NEW.key_prefix, 'last_used_at', NEW.last_used_at)
    );
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_api_key_change() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS z_audit_api_key_change ON public.api_keys;
CREATE TRIGGER z_audit_api_key_change
  AFTER INSERT OR UPDATE OF revoked_at ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.audit_api_key_change();

-- ─── 4. Klucz bieżącego żądania API ──────────────────────────────
-- Skrót klucza z tokenu, który wystawiła aplikacja (`lib/api/v1/token.ts`).
CREATE OR REPLACE FUNCTION public.api_key_request_hash()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN claims.hash ~ '^[0-9a-f]{64}$' THEN claims.hash END
    FROM (
      SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'api_key_hash' AS hash
    ) AS claims;
$$;

-- Firma klucza bieżącego żądania, gdy klucz istnieje, nie jest odwołany i ma
-- zakres `p_scope`; w przeciwnym razie NULL, więc polityki nie wpuszczą nic.
CREATE OR REPLACE FUNCTION public.api_key_request_tenant(p_scope text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT k.tenant_id
    FROM public.api_keys k
   WHERE k.key_hash = public.api_key_request_hash()
     AND k.revoked_at IS NULL
     AND p_scope = ANY (k.scopes);
$$;

-- Wejście żądania: sprawdzenie klucza, wpis audytu i `last_used_at` w jednej
-- transakcji. Bez wpisu audytu nie ma danych (błąd = 503 w aplikacji).
CREATE OR REPLACE FUNCTION public.api_key_session(
  p_endpoint text,
  p_request_id text,
  p_ip text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hash text := public.api_key_request_hash();
  v_key public.api_keys%ROWTYPE;
  v_ip inet;
BEGIN
  IF v_hash IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_key FROM public.api_keys k WHERE k.key_hash = v_hash AND k.revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Najwyżej raz na minutę: bez zapisu wiersza przy każdym żądaniu.
  UPDATE public.api_keys k
     SET last_used_at = now()
   WHERE k.id = v_key.id
     AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute');

  BEGIN
    v_ip := nullif(btrim(p_ip), '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
  VALUES (
    v_key.tenant_id, NULL, 'api_key.used', 'api_key', v_key.id,
    jsonb_build_object(
      'endpoint', left(coalesce(p_endpoint, ''), 300),
      'request_id', left(coalesce(p_request_id, ''), 64),
      'key_prefix', v_key.key_prefix,
      'source', 'api_v1'
    ),
    v_ip,
    left(p_user_agent, 300)
  );

  RETURN jsonb_build_object(
    'key_id', v_key.id,
    'tenant_id', v_key.tenant_id,
    'scopes', to_jsonb(v_key.scopes),
    'key_prefix', v_key.key_prefix
  );
END;
$$;

-- Waluta faktury KSeF przy kosztach ze skrzynki (ta sama reguła co karta
-- kosztu): tylko koszty firmy klucza z zakresem `expenses:read`, najwyżej 200.
-- Osobno od polityk faktur, bo klucz z samym `expenses:read` faktur nie czyta.
CREATE OR REPLACE FUNCTION public.api_expense_invoice_currencies(p_expense_ids uuid[])
RETURNS TABLE (expense_id uuid, currency text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, i.currency::text
    FROM public.expenses e
    JOIN public.invoices i ON i.id = e.ksef_invoice_id AND i.tenant_id = e.tenant_id
   WHERE e.id = ANY (p_expense_ids[1:200])
     AND e.tenant_id = public.api_key_request_tenant('expenses:read');
$$;

REVOKE ALL ON FUNCTION public.api_key_request_hash() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.api_key_request_tenant(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.api_key_session(text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.api_expense_invoice_currencies(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_key_request_hash() TO api_key_client;
GRANT EXECUTE ON FUNCTION public.api_key_request_tenant(text) TO api_key_client;
GRANT EXECUTE ON FUNCTION public.api_key_session(text, text, text, text) TO api_key_client;
GRANT EXECUTE ON FUNCTION public.api_expense_invoice_currencies(uuid[]) TO api_key_client;

-- ─── 5. Odczyt dla roli api_key_client ───────────────────────────
-- Tylko kolumny potrzebne trasom /api/v1. Bez PESEL, danych specjalnych,
-- uwag, danych płatności i błędów wysyłki. `seller_data`, `buyer_data`
-- i `fa3_data` tylko dla nazwy i NIP stron (trasa wybiera ścieżki JSON).
GRANT SELECT (
  id, tenant_id, direction, internal_number, invoice_kind, issue_date, sale_date, payment_due_date,
  currency, net_total, vat_total, gross_total, paid_amount, payment_status,
  seller_nip, seller_data, buyer_nip, buyer_data, fa3_data,
  ksef_status, ksef_number, ksef_accepted_at, ksef_environment, parent_invoice_id, created_at, updated_at
) ON public.invoices TO api_key_client;

GRANT SELECT (
  id, invoice_id, ordinal, name, quantity, unit, unit_price_net, net_amount, vat_rate, vat_amount, gross_amount
) ON public.invoice_line_items TO api_key_client;

GRANT SELECT (
  id, tenant_id, document_number, document_type, issue_date, seller_name, seller_nip,
  net_amount, vat_amount, gross_amount, vat_rate, vat_deductible_amount, is_deductible, is_reviewed,
  category_label, kpir_column, source, ksef_invoice_id, ocr_extracted_data, created_at, updated_at
) ON public.expenses TO api_key_client;

-- `(SELECT …)`: funkcja liczy się raz na zapytanie, nie dla każdego wiersza.
DROP POLICY IF EXISTS "invoices_select_api_key_client" ON public.invoices;
CREATE POLICY "invoices_select_api_key_client" ON public.invoices
  FOR SELECT TO api_key_client
  USING (tenant_id = (SELECT public.api_key_request_tenant('invoices:read')));

DROP POLICY IF EXISTS "invoice_line_items_select_api_key_client" ON public.invoice_line_items;
CREATE POLICY "invoice_line_items_select_api_key_client" ON public.invoice_line_items
  FOR SELECT TO api_key_client
  USING (
    EXISTS (
      SELECT 1 FROM public.invoices i
       WHERE i.id = invoice_line_items.invoice_id
         AND i.tenant_id = (SELECT public.api_key_request_tenant('invoices:read'))
    )
  );

DROP POLICY IF EXISTS "expenses_select_api_key_client" ON public.expenses;
CREATE POLICY "expenses_select_api_key_client" ON public.expenses
  FOR SELECT TO api_key_client
  USING (tenant_id = (SELECT public.api_key_request_tenant('expenses:read')));

-- ─── 6. Udostępnienie ────────────────────────────────────────────
-- WŁĄCZNIK, nie wyłącznik: false = /api/v1 odpowiada 503 `api_disabled`,
-- a zakładka „API” w Ustawieniach jest ukryta. Włącza Bartosz po regulaminie
-- API (pytanie 15 do prawnika) i zewnętrznym teście zabezpieczeń.
INSERT INTO public.global_feature_flags (flag, enabled, note)
VALUES (
  'publicApiEnabled',
  false,
  'Publiczne API /api/v1 i klucze API w Ustawieniach (krok 7.1 planu kompletnej aplikacji). '
  'Włączyć po regulaminie API (pytanie 15 do prawnika) i zewnętrznym teście zabezpieczeń.'
)
ON CONFLICT (flag) DO NOTHING;

NOTIFY pgrst, 'reload schema';
