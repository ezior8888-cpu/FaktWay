-- ═══════════════════════════════════════════════════════════════
-- 00184: wystawianie faktur przez publiczne API (plan
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 7.1, część 2)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem, PO 00181 (zmienia CHECK zakresów
-- `api_keys` i daje uprawnienia roli `api_key_client` z 00181).
-- Addytywna: szerszy CHECK zakresów kluczy, nowa tabela kluczy idempotencji,
-- nowe funkcje, odczyt kilku kolumn `tenants` dla roli `api_key_client`.
-- Bez DROP tabel i kolumn, bez zmiany danych i bez zmian polityk ani grantów
-- `anon`, `authenticated`, `service_role` na istniejących tabelach. Stary kod
-- nowych obiektów nie używa; nowy bez nich odpowiada na POST 503.
--
-- PROJEKT (uzasadnienie w PR):
--   * Zakres `invoices:write`: klucz wystawia zwykłą fakturę VAT krajową
--     w PLN i może zlecić jej wysyłkę do KSeF. Istniejące klucze go nie mają.
--   * Rola `api_key_client` dalej NICZEGO nie zapisuje w tabelach. Jedyna
--     droga zapisu to `api_create_invoice()` (SECURITY DEFINER,
--     `search_path = ''`): sama ustala klucz ze skrótu w tokenie, sprawdza
--     zakres i odwołanie, firmę bierze z klucza i w jednej transakcji zapisuje
--     klucz idempotencji, szkic faktury, pozycje i wpis audytu z autorem
--     (identyfikator klucza API).
--   * Stan, kierunek i pochodzenie ustala funkcja (`draft`, `outgoing`,
--     `app`), sprzedawcę porównuje z firmą klucza, rodzaj i walutę z VAT/PLN,
--     a z wiersza aplikacji bierze tylko kolumny treści z listy.
--   * Idempotencja: UNIQUE (tenant_id, api_key_id, idempotency_key). Ta sama
--     treść (skrót SHA-256) zwraca tę samą fakturę, inna daje `conflict`.
--     Równoległe żądanie z tym samym kluczem czeka na indeksie i dostaje
--     fakturę pierwszego. Odmowa zapisu (zajęty numer) cofa też klucz.
--   * Do wystawienia rola czyta dane własnej firmy (NIP, nazwa, adres,
--     zwolnienie z VAT, metoda kasowa, weryfikacja KSeF) i numerację przez
--     dwie funkcje (ostatni numer i zajęte numery), bez odczytu faktur.
--   * Wysyłkę do KSeF zleca aplikacja tą samą drogą co interfejs
--     (`enqueue_ksef_send` z 00131 w transakcji ze zleceniem pg-boss), tylko
--     dla szkicu niezmienionego od utworzenia (`send_allowed`).
--
-- Po wgraniu: NOTIFY pgrst + schema_migrations (scripts/ops/wgraj-migracje.sh).
-- Wycofanie: DROP funkcji `api_create_invoice`, `api_invoice_*`,
-- `api_key_request_writer`, polityki `tenants_select_api_key_client`
-- i tabeli `api_idempotency_keys`; REVOKE grantu `tenants` z
-- `api_key_client`; CHECK zakresów jak w 00181 (po odwołaniu kluczy
-- z `invoices:write`).
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Zakres invoices:write ────────────────────────────────────
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_check;
ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 3
  AND scopes <@ ARRAY['invoices:read', 'expenses:read', 'invoices:write']::TEXT[]
);

COMMENT ON TABLE public.api_keys IS
  'Klucze publicznego API firmy (00181, 00184, krok 7.1). Tylko skrót SHA-256 klucza i prefiks; '
  'zakresy invoices:read, expenses:read i invoices:write; odwołanie nieodwracalne; zmiany w audit_logs wyzwalaczem.';

-- ─── 2. Klucze idempotencji zapisu ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.api_idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  api_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  -- SHA-256 (hex) treści żądania w postaci kanonicznej (lib/api/v1/invoice-create.ts).
  request_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  -- Faktura usunięta później (np. szkic) zostawia klucz zajęty: powtórzenie dostaje 409.
  invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  send_requested BOOLEAN NOT NULL DEFAULT false,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT api_idempotency_keys_key_check CHECK (idempotency_key ~ '^[!-~]{1,255}$'),
  CONSTRAINT api_idempotency_keys_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT api_idempotency_keys_endpoint_check CHECK (endpoint = 'POST /api/v1/invoices'),
  CONSTRAINT api_idempotency_keys_request_id_check CHECK (request_id IS NULL OR char_length(request_id) <= 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_api_idempotency_keys_key
  ON public.api_idempotency_keys (tenant_id, api_key_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_api_idempotency_keys_invoice
  ON public.api_idempotency_keys (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_api_idempotency_keys_api_key
  ON public.api_idempotency_keys (api_key_id);

COMMENT ON TABLE public.api_idempotency_keys IS
  'Klucze idempotencji POST /api/v1/invoices (00184, krok 7.1): UNIQUE (tenant_id, api_key_id, idempotency_key), '
  'skrót treści żądania i utworzona faktura. Pisze tylko api_create_invoice() w transakcji z fakturą.';

ALTER TABLE public.api_idempotency_keys ENABLE ROW LEVEL SECURITY;
-- Bez polityk i grantów dla klienta: tabelę czytają i piszą tylko funkcje
-- 00184 (właściciel) i serwis (backup, sprzątanie).
REVOKE ALL ON public.api_idempotency_keys FROM PUBLIC, anon, authenticated, service_role, api_key_client;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_idempotency_keys TO service_role;

-- ─── 3. Dane własnej firmy do wystawienia ────────────────────────
-- Te same kolumny, które czyta formularz (`getTenantContext`,
-- `readTenantVatExemption`, `readTenantCashMethodForIssuance`) i wysyłka
-- (`requireKsefVerification`). Bez danych dostępowych KSeF i reszty wiersza.
GRANT SELECT (
  id, nip, name, address_json, vat_exemption_basis, vat_cash_method, ksef_verified_at, ksef_verified_environment
) ON public.tenants TO api_key_client;

DROP POLICY IF EXISTS "tenants_select_api_key_client" ON public.tenants;
CREATE POLICY "tenants_select_api_key_client" ON public.tenants
  FOR SELECT TO api_key_client
  USING (id = (SELECT public.api_key_request_tenant('invoices:write')));

-- ─── 4. Klucz bieżącego żądania z zakresem invoices:write ────────
-- Wewnętrzna (bez EXECUTE dla ról API): wołają ją tylko funkcje niżej.
CREATE OR REPLACE FUNCTION public.api_key_request_writer()
RETURNS public.api_keys
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT k.*
    FROM public.api_keys k
   WHERE k.key_hash = public.api_key_request_hash()
     AND k.revoked_at IS NULL
     AND 'invoices:write' = ANY (k.scopes);
$$;

-- ─── 5. Wynik żądania: faktura w kształcie odczytu API ───────────
-- Te same pola i aliasy co `INVOICE_SELECT` i `ITEM_SELECT` w
-- lib/api/v1/invoices.ts (kwoty `::text`), żeby klucz tylko do zapisu
-- dostał fakturę, której nie czyta przez GET. `send_allowed`: wysyłka
-- zamówiona i szkic niezmieniony od utworzenia (nikt go nie edytował
-- ani nie wysłał), `fa3_data` tylko wtedy, gdy wysyłka jest jeszcze możliwa.
CREATE OR REPLACE FUNCTION public.api_invoice_request_result(p_idempotency_id uuid, p_status text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'status', p_status,
    'send_requested', r.send_requested,
    'send_allowed', coalesce(
      r.send_requested AND i.ksef_status = 'draft' AND i.updated_at IS NOT DISTINCT FROM i.created_at,
      false
    ),
    'invoice', CASE WHEN i.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', i.id,
      'direction', i.direction,
      'internal_number', i.internal_number,
      'invoice_kind', i.invoice_kind,
      'issue_date', i.issue_date,
      'sale_date', i.sale_date,
      'payment_due_date', i.payment_due_date,
      'currency', i.currency,
      'net_total', i.net_total::text,
      'vat_total', i.vat_total::text,
      'gross_total', i.gross_total::text,
      'paid_amount', i.paid_amount::text,
      'payment_status', i.payment_status,
      'seller_nip', i.seller_nip,
      'seller_name', i.seller_data ->> 'name',
      'seller_data_nip', i.seller_data ->> 'nip',
      'fa3_seller_name', i.fa3_data -> 'seller' ->> 'name',
      'fa3_seller_nip', i.fa3_data -> 'seller' ->> 'nip',
      'buyer_nip', i.buyer_nip,
      'buyer_name', i.buyer_data ->> 'name',
      'buyer_data_nip', i.buyer_data ->> 'nip',
      'fa3_buyer_name', i.fa3_data -> 'buyer' ->> 'name',
      'fa3_buyer_nip', i.fa3_data -> 'buyer' ->> 'nip',
      'ksef_status', i.ksef_status,
      'ksef_number', i.ksef_number,
      'ksef_accepted_at', i.ksef_accepted_at,
      'ksef_environment', i.ksef_environment,
      'parent_invoice_id', i.parent_invoice_id,
      'created_at', i.created_at,
      'updated_at', i.updated_at
    ) END,
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'ordinal', l.ordinal,
        'name', l.name,
        'quantity', l.quantity::text,
        'unit', l.unit,
        'unit_price_net', l.unit_price_net::text,
        'net_amount', l.net_amount::text,
        'vat_rate', l.vat_rate,
        'vat_amount', l.vat_amount::text,
        'gross_amount', l.gross_amount::text
      ) ORDER BY l.ordinal)
        FROM public.invoice_line_items l
       WHERE l.invoice_id = i.id
    ), '[]'::jsonb),
    'fa3_data', CASE WHEN r.send_requested AND i.ksef_status = 'draft' THEN i.fa3_data END
  )
    FROM public.api_idempotency_keys r
    LEFT JOIN public.invoices i ON i.id = r.invoice_id AND i.tenant_id = r.tenant_id
   WHERE r.id = p_idempotency_id;
$$;

-- ─── 6. Wcześniejsze żądanie z tym kluczem idempotencji ──────────
-- Aplikacja pyta przed walidacją zależną od czasu i ustawień: ponowienie
-- jutro zwraca tę samą fakturę, a nie błąd daty. Wynik: `new`, `conflict`
-- albo `replayed` z fakturą.
CREATE OR REPLACE FUNCTION public.api_invoice_idempotent_result(
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key public.api_keys%ROWTYPE;
  v_request public.api_idempotency_keys%ROWTYPE;
BEGIN
  v_key := public.api_key_request_writer();
  IF v_key.id IS NULL THEN
    RAISE EXCEPTION 'api_key_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT r.* INTO v_request
    FROM public.api_idempotency_keys r
   WHERE r.tenant_id = v_key.tenant_id
     AND r.api_key_id = v_key.id
     AND r.idempotency_key = p_idempotency_key;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'new');
  END IF;
  IF v_request.request_hash IS DISTINCT FROM p_request_hash THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;
  RETURN public.api_invoice_request_result(v_request.id, 'replayed');
END;
$$;

-- ─── 7. Utworzenie szkicu faktury ────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_create_invoice(
  p_idempotency_key text,
  p_request_hash text,
  p_request_id text,
  p_send boolean,
  p_invoice jsonb,
  p_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key public.api_keys%ROWTYPE;
  v_claim public.api_idempotency_keys%ROWTYPE;
  v_existing public.api_idempotency_keys%ROWTYPE;
  v_src public.invoices%ROWTYPE;
  v_tenant_nip text;
  v_invoice_id uuid;
  v_constraint text;
BEGIN
  v_key := public.api_key_request_writer();
  IF v_key.id IS NULL THEN
    RAISE EXCEPTION 'api_key_forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[!-~]{1,255}$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'api_invoice_invalid_request' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_invoice) IS DISTINCT FROM 'object' OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'api_invoice_invalid_request' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_lines) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'api_invoice_invalid_request' USING ERRCODE = '22023';
  END IF;

  -- Sprzedawca to firma klucza: wiersz z aplikacji nie wybiera firmy.
  SELECT t.nip INTO v_tenant_nip FROM public.tenants t WHERE t.id = v_key.tenant_id;
  IF v_tenant_nip IS NULL
     OR (p_invoice ->> 'seller_nip') IS DISTINCT FROM v_tenant_nip
     OR (p_invoice #>> '{seller_data,nip}') IS DISTINCT FROM v_tenant_nip
     OR (p_invoice #>> '{fa3_data,seller,nip}') IS DISTINCT FROM v_tenant_nip THEN
    RAISE EXCEPTION 'api_invoice_seller_mismatch' USING ERRCODE = 'P0001';
  END IF;
  -- Ta wersja API: tylko zwykła faktura VAT w złotych.
  IF (p_invoice ->> 'invoice_type') IS DISTINCT FROM 'VAT'
     OR (p_invoice ->> 'currency') IS DISTINCT FROM 'PLN'
     OR (p_invoice #>> '{fa3_data,type}') IS DISTINCT FROM 'VAT'
     OR (p_invoice #>> '{fa3_data,payment,currency}') IS DISTINCT FROM 'PLN' THEN
    RAISE EXCEPTION 'api_invoice_unsupported' USING ERRCODE = 'P0001';
  END IF;

  -- Klucz idempotencji przed fakturą: równoległe żądanie z tym samym kluczem
  -- czeka tu na zakończenie naszej transakcji i dostaje nasz wynik.
  INSERT INTO public.api_idempotency_keys (
    tenant_id, api_key_id, idempotency_key, request_hash, endpoint, send_requested, request_id
  ) VALUES (
    v_key.tenant_id, v_key.id, p_idempotency_key, p_request_hash, 'POST /api/v1/invoices',
    coalesce(p_send, false), left(p_request_id, 64)
  )
  ON CONFLICT (tenant_id, api_key_id, idempotency_key) DO NOTHING
  RETURNING * INTO v_claim;

  IF NOT FOUND THEN
    SELECT r.* INTO v_existing
      FROM public.api_idempotency_keys r
     WHERE r.tenant_id = v_key.tenant_id
       AND r.api_key_id = v_key.id
       AND r.idempotency_key = p_idempotency_key;
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    RETURN public.api_invoice_request_result(v_existing.id, 'replayed');
  END IF;

  -- Tylko kolumny treści z listy; stan, kierunek, pochodzenie i firma stałe.
  v_src := jsonb_populate_record(NULL::public.invoices, p_invoice);
  BEGIN
    INSERT INTO public.invoices (
      tenant_id, direction, ksef_status, origin, internal_number, invoice_type, issue_date, sale_date,
      seller_nip, buyer_nip, seller_data, buyer_data, payment_data, payment_due_date, currency, notes,
      net_total, vat_total, gross_total, is_b2c, buyer_id_type, buyer_pesel, buyer_id_number, fa3_data
    ) VALUES (
      v_key.tenant_id, 'outgoing', 'draft', 'app', v_src.internal_number, 'VAT', v_src.issue_date, v_src.sale_date,
      v_tenant_nip, v_src.buyer_nip, v_src.seller_data, v_src.buyer_data, v_src.payment_data, v_src.payment_due_date,
      'PLN', v_src.notes, v_src.net_total, v_src.vat_total, v_src.gross_total, coalesce(v_src.is_b2c, false),
      coalesce(v_src.buyer_id_type, 'nip'), v_src.buyer_pesel, v_src.buyer_id_number, v_src.fa3_data
    )
    RETURNING id INTO v_invoice_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'uq_invoices_tenant_outgoing_internal_number' THEN
      -- Błąd przerywa całą transakcję: klucz idempotencji też znika.
      RAISE EXCEPTION 'api_invoice_number_taken' USING ERRCODE = 'P0001';
    END IF;
    RAISE;
  END;

  INSERT INTO public.invoice_line_items (
    invoice_id, ordinal, name, unit, quantity, unit_price_net, net_amount, vat_rate, vat_amount, gross_amount
  )
  SELECT v_invoice_id, l.ordinal, l.name, l.unit, l.quantity, l.unit_price_net, l.net_amount,
         l.vat_rate, l.vat_amount, l.gross_amount
    FROM jsonb_populate_recordset(NULL::public.invoice_line_items, p_lines) AS l;

  UPDATE public.api_idempotency_keys SET invoice_id = v_invoice_id WHERE id = v_claim.id;

  -- Autor faktury: klucz API (bez konta), w tej samej transakcji co zapis.
  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_key.tenant_id, NULL, 'invoice.draft_created', 'invoice', v_invoice_id,
    jsonb_build_object(
      'source', 'api_v1',
      'api_key_id', v_key.id,
      'key_prefix', v_key.key_prefix,
      'request_id', left(coalesce(p_request_id, ''), 64),
      'internalNumber', v_src.internal_number,
      'grossTotal', v_src.gross_total,
      'sendRequested', coalesce(p_send, false)
    )
  );

  RETURN public.api_invoice_request_result(v_claim.id, 'created');
END;
$$;

-- ─── 8. Numeracja bez odczytu faktur ─────────────────────────────
-- Te same zapytania co podpowiedź formularza (`lastRegularOutgoing`
-- w lib/invoices/next-number.ts): ostatnia zwykła faktura sprzedaży,
-- najpierw wystawiona w FaktWay, potem dowolna.
CREATE OR REPLACE FUNCTION public.api_invoice_number_context()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key public.api_keys%ROWTYPE;
BEGIN
  v_key := public.api_key_request_writer();
  IF v_key.id IS NULL THEN
    RAISE EXCEPTION 'api_key_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'last_app', (
      SELECT jsonb_build_object('internal_number', i.internal_number, 'issue_date', i.issue_date)
        FROM public.invoices i
       WHERE i.tenant_id = v_key.tenant_id
         AND i.direction = 'outgoing'
         AND i.invoice_kind = 'regular'
         AND i.origin = 'app'
         AND i.internal_number IS NOT NULL
       ORDER BY i.issue_date DESC, i.created_at DESC
       LIMIT 1
    ),
    'last_any', (
      SELECT jsonb_build_object('internal_number', i.internal_number, 'issue_date', i.issue_date)
        FROM public.invoices i
       WHERE i.tenant_id = v_key.tenant_id
         AND i.direction = 'outgoing'
         AND i.invoice_kind = 'regular'
         AND i.internal_number IS NOT NULL
       ORDER BY i.issue_date DESC, i.created_at DESC
       LIMIT 1
    )
  );
END;
$$;

-- Które z kandydatów (najwyżej 10) są zajęte w firmie klucza; jak
-- sprawdzenie w podpowiedzi formularza: dowolna faktura z tym numerem.
CREATE OR REPLACE FUNCTION public.api_invoice_numbers_taken(p_numbers text[])
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key public.api_keys%ROWTYPE;
BEGIN
  v_key := public.api_key_request_writer();
  IF v_key.id IS NULL THEN
    RAISE EXCEPTION 'api_key_forbidden' USING ERRCODE = '42501';
  END IF;
  -- `internal_number` to VARCHAR(100): rzutowanie, żeby wynik był `text[]`.
  RETURN coalesce((
    SELECT array_agg(DISTINCT i.internal_number::text)
      FROM public.invoices i
     WHERE i.tenant_id = v_key.tenant_id
       AND i.internal_number::text = ANY (p_numbers[1:10])
  ), ARRAY[]::text[]);
END;
$$;

-- ─── 9. Uprawnienia funkcji ──────────────────────────────────────
REVOKE ALL ON FUNCTION public.api_key_request_writer() FROM PUBLIC, anon, authenticated, service_role, api_key_client;
REVOKE ALL ON FUNCTION public.api_invoice_request_result(uuid, text) FROM PUBLIC, anon, authenticated, service_role, api_key_client;
REVOKE ALL ON FUNCTION public.api_invoice_idempotent_result(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.api_create_invoice(text, text, text, boolean, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.api_invoice_number_context() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.api_invoice_numbers_taken(text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_invoice_idempotent_result(text, text) TO api_key_client;
GRANT EXECUTE ON FUNCTION public.api_create_invoice(text, text, text, boolean, jsonb, jsonb) TO api_key_client;
GRANT EXECUTE ON FUNCTION public.api_invoice_number_context() TO api_key_client;
GRANT EXECUTE ON FUNCTION public.api_invoice_numbers_taken(text[]) TO api_key_client;

NOTIFY pgrst, 'reload schema';
