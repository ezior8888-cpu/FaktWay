-- ═══════════════════════════════════════════════════════════════
-- 00194: kasa: dowody wpłaty (KP) i wypłaty (KW) gotówki oraz raport kasowy
-- (plan kompletnej aplikacji, docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md,
-- krok 3.7).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem kodu, po 00176 (wpłaty częściowe): ta
-- migracja woła `record_invoice_payment` i `void_invoice_payment` z 00176
-- i dokłada wyzwalacz do `payments`. Addytywna: dwie nowe tabele, nowe
-- funkcje i wyzwalacze; bez DROP tabel i kolumn, bez TRUNCATE, bez zmian
-- istniejących danych, INSERT/UPDATE tylko w ciałach funkcji na żądanie
-- klienta. Stara wersja aplikacji nowych obiektów nie zna, a wyzwalacz na
-- `payments` działa tylko dla wpłat z dowodem KP, których przed wdrożeniem
-- nie ma.
--
-- Po co: firma, która przyjmuje i wydaje gotówkę, dokumentuje każdą operację
-- dowodem kasowym (KP, KW) i prowadzi raport kasowy. Urzędowego wzoru KP i KW
-- nie ma, więc dowód ma elementy z § 6 ust. 3 pkt 3 rozporządzenia
-- w sprawie prowadzenia PKPiR (Dz.U. 2025 poz. 1299): wystawca i strona
-- (nazwy, adresy), data wystawienia i data operacji, przedmiot (tytuł)
-- i wartość, kto wystawił, numer, który wiąże dowód z zapisami. Wystawiony
-- dowód poprawia się dowodem korygującym (§ 6 ust. 7: dowód własny wydany
-- kontrahentowi poprawia się tylko dowodem korygującym), tu: storno
-- z odesłaniem do dowodu korygowanego i przyczyną. Jak ująć dowody w księgach,
-- ustala księgowa: FaktWay nie zapisuje ich sam w KPiR ani w ewidencji.
--
-- 1. `cash_registers`: jedna kasa na firmę (PLN) ze stanem początkowym na dzień
--    rozpoczęcia. Stan początkowy zmienia się tylko do pierwszego dowodu (RPC
--    `open_cash_register` i wyzwalacz `a_guard_cash_register_update`).
-- 2. `cash_documents`: wystawione dowody. Numer nadaje tylko RPC: osobna seria
--    na firmę, rodzaj i rok daty operacji (KP/<kolejny>/<rok>, KW/<kolejny>/<rok>),
--    pod blokadą wiersza kasy (FOR UPDATE), z UNIQUE jako drugą ochroną i CHECK
--    zgodności numeru z serią. Wystawionego dowodu nie zmienia nikt (wyzwalacz
--    `a_guard_cash_document_update`, bez wyjątku dla ról, także dla postgres);
--    wolne są tylko zerowania kluczy obcych (usunięcie faktury, wpłaty, konta).
--    Korekta (storno) to dowód tego samego rodzaju i serii z kwotą ujemną, datą
--    operacji dowodu korygowanego i przyczyną; dowód ma najwyżej jedną korektę,
--    a korekty nie koryguje się.
-- 3. Stan kasy nie schodzi poniżej zera: wypłata (KW) i korekta wpłaty (KP)
--    sprawdzają najniższy stan na koniec dnia od daty operacji w przód
--    (`cash_lowest_balance`); za mało gotówki to odmowa z kwotą i dniem.
-- 4. KP do faktury sprzedaży zapisuje wpłatę przez `record_invoice_payment`
--    (00176) w tej samej transakcji (forma płatności: gotówka), a KP do wpłaty
--    zapisanej wcześniej („Zapisz wpłatę”) tylko ją wiąże. Korekta takiego KP
--    cofa wpłatę przez `void_invoice_payment` (00176) w podtransakcji: odmowa
--    cofnięcia to odmowa korekty bez śladu. Wpłaty z aktywnym KP nie cofa się
--    na fakturze (wyzwalacz `a_guard_payment_cash_document` na `payments`).
-- 5. Ponowienie: klucz idempotencji od klienta (UNIQUE tenant_id, key); ten sam
--    klucz z tymi samymi danymi oddaje ten sam dowód, z innymi to odmowa.
-- 6. Audyt (`cash_register.opened`, `cash_register.opening_changed`,
--    `cash_document.issued`, `cash_document.corrected`) w tej samej transakcji.
--
-- Kto: właściciel, administrator i członek firmy (jak wpłaty w 00158 i 00176);
-- księgowa ma wgląd (odczyt, PDF, raport). Firma i rola z sesji
-- (get_current_tenant_id, has_org_role), nie z argumentów.
--
-- Uprawnienia: domyślne granty Supabase dają nowej tabeli ALL (także TRUNCATE,
-- które omija RLS), dlatego najpierw REVOKE ALL, potem jawne granty: sesja tylko
-- czyta (RLS: własna firma), zapis wyłącznie przez RPC SECURITY DEFINER.
-- `service_role` czyta (nocny backup) i usuwa (sprzątanie firm testowych,
-- operator za zgodą Bartosza); nie wstawia i nie zmienia.
-- Rejestr numerów: docs/koordynacja/CLAUDE-DO-CODEXA.md.
-- ═══════════════════════════════════════════════════════════════

-- ─── funkcja sprawdzająca stronę dowodu (CHECK) ─────────────────
-- Strona operacji: nazwa wymagana, NIP i adres opcjonalne (osoba prywatna
-- płacąca gotówką często nie ma NIP-u). Wystawca: także NIP.
CREATE OR REPLACE FUNCTION public.cash_party_valid(p_party jsonb, p_require_nip boolean)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_party) IS DISTINCT FROM 'object' THEN false
    ELSE char_length(btrim(COALESCE(p_party ->> 'name', ''))) BETWEEN 1 AND 512
     AND char_length(COALESCE(p_party ->> 'nip', '')) <= 32
     AND (NOT p_require_nip OR char_length(btrim(COALESCE(p_party ->> 'nip', ''))) >= 1)
     AND char_length(COALESCE(p_party ->> 'addressLine1', '')) <= 512
     AND char_length(COALESCE(p_party ->> 'addressLine2', '')) <= 512
  END;
$$;

COMMENT ON FUNCTION public.cash_party_valid(jsonb, boolean) IS
  '00194: strona dowodu kasowego: nazwa 1-512 znaków, NIP do 32 (wymagany u wystawcy), adres do 512 znaków na wiersz.';

-- ─── cash_registers: kasa firmy ze stanem początkowym ──────────
CREATE TABLE public.cash_registers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  opening_date date NOT NULL,
  opening_balance numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'PLN',
  -- SET NULL przy usunięciu konta (RODO, jak 00154).
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_registers_tenant_unique UNIQUE (tenant_id),
  CONSTRAINT cash_registers_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT cash_registers_currency_check CHECK (currency = 'PLN'),
  CONSTRAINT cash_registers_opening_date_check CHECK (opening_date >= DATE '2000-01-01'),
  CONSTRAINT cash_registers_opening_balance_check CHECK (opening_balance >= 0 AND opening_balance <= 999999999.99)
);

COMMENT ON TABLE public.cash_registers IS
  '00194 (krok 3.7): kasa firmy w PLN ze stanem początkowym na dzień rozpoczęcia. Zapis tylko RPC open_cash_register; stan początkowy zablokowany po pierwszym dowodzie (wyzwalacz a_guard_cash_register_update).';

-- ─── cash_documents: dowody KP i KW ─────────────────────────────
CREATE TABLE public.cash_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  register_id uuid NOT NULL,
  kind text NOT NULL,
  -- Numer, rok i kolejny numer serii: tylko RPC.
  number text NOT NULL,
  number_year integer NOT NULL,
  number_seq integer NOT NULL,
  -- Dzień wystawienia w Polsce (chwila zapisu) i dzień operacji (wybrany).
  issue_date date NOT NULL,
  operation_date date NOT NULL,
  -- Kwota ujemna tylko w korekcie (storno).
  amount numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'PLN',
  title text NOT NULL,
  -- Migawki: strona operacji z formularza, wystawca z `tenants` w chwili wystawienia.
  counterparty jsonb NOT NULL,
  issuer jsonb NOT NULL,
  -- SET NULL przy usunięciu konta (RODO); kto wystawił zostaje w `issued_by_name`.
  issued_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  issued_by_name text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  invoice_id uuid,
  invoice_number text,
  payment_id uuid,
  related_document text,
  corrects_id uuid,
  corrects_number text,
  correction_reason text,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_documents_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT cash_documents_number_unique UNIQUE (tenant_id, kind, number_year, number_seq),
  CONSTRAINT cash_documents_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT cash_documents_register_fk
    FOREIGN KEY (tenant_id, register_id) REFERENCES public.cash_registers (tenant_id, id),
  -- Faktura i wpłata tej samej firmy; ich usunięcie zeruje tylko odnośnik (PostgreSQL 15+).
  CONSTRAINT cash_documents_invoice_fk
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES public.invoices (tenant_id, id)
    ON DELETE SET NULL (invoice_id),
  CONSTRAINT cash_documents_payment_fk
    FOREIGN KEY (tenant_id, payment_id) REFERENCES public.payments (tenant_id, id)
    ON DELETE SET NULL (payment_id),
  CONSTRAINT cash_documents_kind_check CHECK (kind IN ('KP', 'KW')),
  CONSTRAINT cash_documents_currency_check CHECK (currency = 'PLN'),
  CONSTRAINT cash_documents_number_check CHECK (
    number_seq >= 1
    AND number_year = EXTRACT(YEAR FROM operation_date)::integer
    AND number = kind || '/' || number_seq::text || '/' || number_year::text
  ),
  CONSTRAINT cash_documents_dates_check CHECK (operation_date >= DATE '2000-01-01' AND operation_date <= issue_date),
  CONSTRAINT cash_documents_amount_check CHECK (amount <> 0 AND abs(amount) <= 999999999.99),
  CONSTRAINT cash_documents_correction_check CHECK (
    (corrects_id IS NULL AND corrects_number IS NULL AND correction_reason IS NULL AND amount > 0)
    OR (corrects_id IS NOT NULL AND corrects_number IS NOT NULL AND amount < 0 AND payment_id IS NULL
        AND correction_reason IS NOT NULL AND char_length(btrim(correction_reason)) BETWEEN 1 AND 300)
  ),
  -- Wpłata do faktury sprzedaży tylko przy KP.
  CONSTRAINT cash_documents_link_check CHECK (kind = 'KP' OR (invoice_id IS NULL AND payment_id IS NULL)),
  CONSTRAINT cash_documents_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT cash_documents_issued_by_name_check CHECK (char_length(btrim(issued_by_name)) BETWEEN 1 AND 320),
  CONSTRAINT cash_documents_counterparty_check CHECK (public.cash_party_valid(counterparty, false)),
  CONSTRAINT cash_documents_issuer_check CHECK (public.cash_party_valid(issuer, true)),
  CONSTRAINT cash_documents_invoice_number_check CHECK (invoice_number IS NULL OR char_length(invoice_number) BETWEEN 1 AND 120),
  CONSTRAINT cash_documents_related_check CHECK (
    related_document IS NULL OR char_length(btrim(related_document)) BETWEEN 1 AND 120
  )
);

-- Korekta wskazuje dowód tej samej firmy. Osobnym poleceniem, bo odwołuje się
-- do tej samej tabeli; bez akcji przy usunięciu, więc dowodu z korektą nie da się
-- usunąć samego (sprzątanie firmy usuwa oba jednym poleceniem).
ALTER TABLE public.cash_documents
  ADD CONSTRAINT cash_documents_corrects_fk
  FOREIGN KEY (tenant_id, corrects_id) REFERENCES public.cash_documents (tenant_id, id);

COMMENT ON TABLE public.cash_documents IS
  '00194 (krok 3.7): dowody kasowe KP i KW. Numer nadaje RPC (seria na firmę, rodzaj i rok daty operacji); wystawionego nie zmienia nikt (wyzwalacz a_guard_cash_document_update), poprawka to korekta (storno). Nie trafiają same do KPiR ani ewidencji.';
COMMENT ON COLUMN public.cash_documents.counterparty IS
  '00194: migawka strony operacji (wpłacający przy KP, odbiorca przy KW): name, nip, countryCode, addressLine1, addressLine2.';
COMMENT ON COLUMN public.cash_documents.issuer IS
  '00194: migawka danych firmy (tenants) z chwili wystawienia: name, nip, countryCode, addressLine1, addressLine2.';

CREATE INDEX idx_cash_documents_tenant_day
  ON public.cash_documents (tenant_id, operation_date, kind, issued_at);
-- Jedna korekta na dowód i jeden dowód KP na wpłatę.
CREATE UNIQUE INDEX uq_cash_documents_corrects
  ON public.cash_documents (tenant_id, corrects_id) WHERE corrects_id IS NOT NULL;
CREATE UNIQUE INDEX uq_cash_documents_payment
  ON public.cash_documents (tenant_id, payment_id) WHERE payment_id IS NOT NULL;

-- ─── wyzwalacz: wystawionego dowodu nie zmienia nikt ────────────
-- Bez wyjątku dla roli (także service_role, postgres i akcja klucza obcego).
-- Wolne są tylko zerowania kluczy obcych (usunięcie faktury, wpłaty albo
-- konta); każda inna kolumna, także dodana później, jest zamrożona z automatu.
CREATE OR REPLACE FUNCTION public.guard_cash_document_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_free constant text[] := ARRAY['invoice_id', 'payment_id', 'issued_by'];
BEGIN
  IF (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free)
     OR (NEW.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id)
     OR (NEW.payment_id IS NOT NULL AND NEW.payment_id IS DISTINCT FROM OLD.payment_id)
     OR (NEW.issued_by IS NOT NULL AND NEW.issued_by IS DISTINCT FROM OLD.issued_by) THEN
    RAISE EXCEPTION 'Cash document % is issued and cannot be changed; issue a correction instead', OLD.number
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER a_guard_cash_document_update
  BEFORE UPDATE ON public.cash_documents
  FOR EACH ROW EXECUTE FUNCTION public.guard_cash_document_update();

-- ─── wyzwalacz: stan początkowy tylko do pierwszego dowodu ──────
CREATE OR REPLACE FUNCTION public.guard_cash_register_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'Cash register identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF (NEW.opening_date IS DISTINCT FROM OLD.opening_date OR NEW.opening_balance IS DISTINCT FROM OLD.opening_balance)
     AND EXISTS (
       SELECT 1 FROM public.cash_documents AS c
        WHERE c.tenant_id = OLD.tenant_id AND c.register_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'Cash register opening balance is locked after the first document' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER a_guard_cash_register_update
  BEFORE UPDATE ON public.cash_registers
  FOR EACH ROW EXECUTE FUNCTION public.guard_cash_register_update();

-- ─── wyzwalacz na payments: wpłaty z aktywnym KP nie cofa się na fakturze ───
-- Aktywny KP to dowód z tą wpłatą bez korekty. Korekta KP najpierw zapisuje
-- storno, a dopiero potem cofa wpłatę, więc jej własne cofnięcie przechodzi.
-- Komunikat `cash_document_active` z numerem dowodu w HINT czyta akcja
-- „Cofnij wpłatę” (app/actions/invoice-payments.ts).
CREATE OR REPLACE FUNCTION public.guard_payment_cash_document()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_number text;
BEGIN
  IF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN
    SELECT c.number INTO v_number
      FROM public.cash_documents AS c
     WHERE c.tenant_id = OLD.tenant_id
       AND c.payment_id = OLD.id
       AND NOT EXISTS (
         SELECT 1 FROM public.cash_documents AS k
          WHERE k.tenant_id = c.tenant_id AND k.corrects_id = c.id
       );
    IF FOUND THEN
      RAISE EXCEPTION 'cash_document_active'
        USING ERRCODE = 'P0001',
              HINT = v_number,
              DETAIL = 'The payment has an active cash receipt; correct the receipt in the cash register first.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER a_guard_payment_cash_document
  BEFORE UPDATE OF voided_at ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_cash_document();

-- ─── RLS: odczyt członków firmy; zapis tylko przez RPC ──────────
ALTER TABLE public.cash_registers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cash_registers_select_own_tenant" ON public.cash_registers
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

ALTER TABLE public.cash_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cash_documents_select_own_tenant" ON public.cash_documents
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

REVOKE ALL ON public.cash_registers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.cash_registers TO authenticated;
GRANT SELECT, DELETE ON public.cash_registers TO service_role;

REVOKE ALL ON public.cash_documents FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.cash_documents TO authenticated;
GRANT SELECT, DELETE ON public.cash_documents TO service_role;

-- ─── najniższy stan kasy na koniec dnia od dnia p_from w przód ──
-- Stan dnia = stan początkowy + wpłaty - wypłaty do końca tego dnia (korekta
-- ma kwotę ujemną, więc znosi swój dowód). Wiersz z zerem dla p_from liczy
-- stan tego dnia także bez dowodów. Firma przychodzi z argumentu, więc
-- funkcja jest tylko dla RPC tej migracji (bez EXECUTE dla klientów).
CREATE OR REPLACE FUNCTION public.cash_lowest_balance(p_tenant_id uuid, p_from date)
RETURNS TABLE (balance numeric, on_day date)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT t.balance, t.on_day
    FROM (
      SELECT d.on_day,
             r.opening_balance + sum(d.delta) OVER (ORDER BY d.on_day) AS balance
        FROM public.cash_registers AS r
        CROSS JOIN LATERAL (
          SELECT c.operation_date AS on_day,
                 sum(CASE WHEN c.kind = 'KP' THEN c.amount ELSE -c.amount END) AS delta
            FROM public.cash_documents AS c
           WHERE c.tenant_id = p_tenant_id
           GROUP BY c.operation_date
          UNION ALL
          SELECT p_from, 0::numeric
        ) AS d
       WHERE r.tenant_id = p_tenant_id
    ) AS t
   WHERE t.on_day >= p_from
   ORDER BY t.balance, t.on_day
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.cash_lowest_balance(uuid, date) IS
  '00194: najniższy stan kasy firmy na koniec dnia od p_from w przód i dzień, w którym wypada. Tylko dla RPC kasy.';

-- ─── RPC: stan początkowy kasy ──────────────────────────────────
-- Wynik: `opened`, `updated`, `unchanged` albo `refused` z `code`.
CREATE OR REPLACE FUNCTION public.open_cash_register(p_opening_date date, p_opening_balance numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  -- Dzień w Polsce, nie w strefie serwera.
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_register public.cash_registers%ROWTYPE;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Cash register change requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')) THEN
    RAISE EXCEPTION 'Insufficient role to change the cash register' USING ERRCODE = '42501';
  END IF;

  IF p_opening_date IS NULL OR p_opening_date < DATE '2000-01-01' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_date');
  END IF;
  IF p_opening_date > v_today THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'future_date');
  END IF;
  -- Kolumna NUMERIC(14,2) zaokrągliłaby 10,005 po cichu: kwota z groszami albo odmowa.
  IF p_opening_balance IS NULL OR p_opening_balance < 0 OR p_opening_balance > 999999999.99
     OR p_opening_balance <> round(p_opening_balance, 2) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_amount');
  END IF;

  SELECT * INTO v_register FROM public.cash_registers WHERE tenant_id = v_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.cash_registers (tenant_id, opening_date, opening_balance, created_by)
    VALUES (v_tenant_id, p_opening_date, p_opening_balance, auth.uid())
    ON CONFLICT (tenant_id) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
      VALUES (
        v_tenant_id, auth.uid(), 'cash_register.opened', 'cash_register', v_id,
        jsonb_build_object('openingDate', p_opening_date, 'openingBalance', p_opening_balance)
      );
      RETURN jsonb_build_object('status', 'opened', 'register_id', v_id,
        'opening_date', p_opening_date, 'opening_balance', p_opening_balance);
    END IF;
    -- Inna karta otworzyła kasę w tej samej chwili: dalej jak przy istniejącej.
    SELECT * INTO v_register FROM public.cash_registers WHERE tenant_id = v_tenant_id FOR UPDATE;
  END IF;

  IF v_register.opening_date = p_opening_date AND v_register.opening_balance = p_opening_balance THEN
    RETURN jsonb_build_object('status', 'unchanged', 'register_id', v_register.id,
      'opening_date', v_register.opening_date, 'opening_balance', v_register.opening_balance);
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_documents WHERE tenant_id = v_tenant_id AND register_id = v_register.id) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'documents_exist',
      'opening_date', v_register.opening_date, 'opening_balance', v_register.opening_balance);
  END IF;

  UPDATE public.cash_registers
     SET opening_date = p_opening_date,
         opening_balance = p_opening_balance
   WHERE id = v_register.id AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'cash_register.opening_changed', 'cash_register', v_register.id,
    jsonb_build_object(
      'fromOpeningDate', v_register.opening_date, 'fromOpeningBalance', v_register.opening_balance,
      'openingDate', p_opening_date, 'openingBalance', p_opening_balance
    )
  );

  RETURN jsonb_build_object('status', 'updated', 'register_id', v_register.id,
    'opening_date', p_opening_date, 'opening_balance', p_opening_balance);
END;
$$;

COMMENT ON FUNCTION public.open_cash_register(date, numeric) IS
  '00194: otwiera kasę firmy ze stanem początkowym albo zmienia go, dopóki nie ma dowodu; audyt w tej samej transakcji.';

-- ─── RPC: wystawienie dowodu KP albo KW ─────────────────────────
-- Wynik: `issued`, `already_issued` (ten sam klucz z tymi samymi danymi) albo
-- `refused` z `code`. KP do faktury (`p_invoice_id`) zapisuje wpłatę przez
-- record_invoice_payment; KP do wpłaty (`p_payment_id`) wiąże wpłatę wpisaną
-- wcześniej ręcznie.
CREATE OR REPLACE FUNCTION public.issue_cash_document(
  p_kind text,
  p_idempotency_key uuid,
  p_operation_date date,
  p_amount numeric,
  p_title text,
  p_counterparty jsonb,
  p_related_document text DEFAULT NULL,
  p_invoice_id uuid DEFAULT NULL,
  p_payment_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  -- Dzień w Polsce, nie w strefie serwera: po północy UTC w Warszawie jest już jutro.
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_kind text := upper(btrim(COALESCE(p_kind, '')));
  v_title text := btrim(COALESCE(p_title, ''));
  v_related text := NULLIF(btrim(COALESCE(p_related_document, '')), '');
  v_register public.cash_registers%ROWTYPE;
  v_existing public.cash_documents%ROWTYPE;
  v_tenant public.tenants%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_party jsonb;
  v_issuer jsonb;
  v_issued_by_name text;
  v_lowest numeric;
  v_lowest_on date;
  v_linked text;
  v_year integer;
  v_seq integer;
  v_number text;
  v_record jsonb;
  v_invoice_id uuid;
  v_invoice_number text;
  v_payment_id uuid;
  v_payment_recorded boolean := false;
  v_document_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Issuing a cash document requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')) THEN
    RAISE EXCEPTION 'Insufficient role to issue a cash document' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;

  -- Blokada kasy: wszystkie dowody firmy idą po kolei (klucz, stan kasy, numer).
  -- Dwa wystawienia naraz czekają tu na siebie; drugie widzi już pierwszy dowód.
  SELECT * INTO v_register FROM public.cash_registers WHERE tenant_id = v_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'register_missing');
  END IF;

  -- Ten sam klucz: ten sam dowód. Sprawdzany przed resztą, bo po pierwszym
  -- zapisie stan kasy albo faktury mógł się zmienić (to sukces, nie odmowa).
  SELECT * INTO v_existing FROM public.cash_documents WHERE tenant_id = v_tenant_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.corrects_id IS NULL
       AND v_existing.kind = v_kind
       AND v_existing.amount = p_amount
       AND v_existing.operation_date = p_operation_date
       AND (p_invoice_id IS NULL OR v_existing.invoice_id IS NULL OR v_existing.invoice_id = p_invoice_id)
       AND (p_payment_id IS NULL OR v_existing.payment_id IS NULL OR v_existing.payment_id = p_payment_id) THEN
      RETURN jsonb_build_object('status', 'already_issued', 'document_id', v_existing.id,
        'number', v_existing.number, 'kind', v_existing.kind, 'amount', v_existing.amount,
        'invoice_id', v_existing.invoice_id, 'invoice_number', v_existing.invoice_number,
        'payment_id', v_existing.payment_id, 'payment_recorded', false);
    END IF;
    RETURN jsonb_build_object('status', 'refused', 'code', 'key_reused');
  END IF;

  IF v_kind NOT IN ('KP', 'KW') THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;
  -- Wypłata nie wiąże się z fakturą sprzedaży; faktura albo wpłata, nie obie.
  IF (v_kind = 'KW' AND (p_invoice_id IS NOT NULL OR p_payment_id IS NOT NULL))
     OR (p_invoice_id IS NOT NULL AND p_payment_id IS NOT NULL) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;
  -- Kolumna NUMERIC(14,2) zaokrągliłaby 10,005 po cichu: kwota z groszami albo odmowa.
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 999999999.99 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_amount');
  END IF;
  -- Literówka w roku (0202 zamiast 2026) nie jest datą operacji.
  IF p_operation_date IS NULL OR p_operation_date < DATE '2000-01-01' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_date');
  END IF;
  IF p_operation_date > v_today THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'future_date');
  END IF;
  IF p_operation_date < v_register.opening_date THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'before_opening', 'opening_date', v_register.opening_date);
  END IF;
  IF char_length(v_title) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'title_invalid');
  END IF;
  IF v_related IS NOT NULL AND char_length(v_related) > 120 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'related_invalid');
  END IF;
  IF jsonb_typeof(p_counterparty) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'counterparty_invalid');
  END IF;
  v_party := jsonb_build_object(
    'name', btrim(COALESCE(p_counterparty ->> 'name', '')),
    'nip', NULLIF(btrim(COALESCE(p_counterparty ->> 'nip', '')), ''),
    'countryCode', COALESCE(NULLIF(btrim(COALESCE(p_counterparty ->> 'countryCode', '')), ''), 'PL'),
    'addressLine1', btrim(COALESCE(p_counterparty ->> 'addressLine1', '')),
    'addressLine2', btrim(COALESCE(p_counterparty ->> 'addressLine2', ''))
  );
  IF NOT public.cash_party_valid(v_party, false) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'counterparty_invalid');
  END IF;

  -- Wystawca: dane firmy z chwili wystawienia (§ 6 ust. 3 pkt 3 lit. a).
  SELECT * INTO v_tenant FROM public.tenants WHERE id = v_tenant_id;
  v_issuer := jsonb_build_object(
    'name', btrim(COALESCE(v_tenant.name, '')),
    'nip', btrim(COALESCE(v_tenant.nip, '')),
    'countryCode', COALESCE(NULLIF(btrim(COALESCE(v_tenant.address_json ->> 'countryCode', '')), ''), 'PL'),
    'addressLine1', btrim(COALESCE(v_tenant.address_json ->> 'addressLine1', '')),
    'addressLine2', btrim(COALESCE(v_tenant.address_json ->> 'addressLine2', ''))
  );
  IF v_issuer ->> 'name' = '' OR v_issuer ->> 'nip' = ''
     OR v_issuer ->> 'addressLine1' = '' OR v_issuer ->> 'addressLine2' = '' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'issuer_incomplete');
  END IF;

  -- Kto wystawił: imię i nazwisko z profilu, a bez niego adres e-mail konta.
  SELECT NULLIF(btrim(COALESCE(u.name, '')), '') INTO v_issued_by_name
    FROM public.users AS u WHERE u.id = auth.uid();
  IF v_issued_by_name IS NULL THEN
    SELECT NULLIF(btrim(COALESCE(a.email, '')), '') INTO v_issued_by_name
      FROM auth.users AS a WHERE a.id = auth.uid();
  END IF;
  v_issued_by_name := left(COALESCE(v_issued_by_name, 'Użytkownik FaktWay'), 320);

  -- KP do wpłaty zapisanej wcześniej: kolejność blokad jak przy cofnięciu
  -- wpłaty (00176): faktura, potem wpłata.
  IF p_payment_id IS NOT NULL THEN
    SELECT p.invoice_id INTO v_invoice_id
      FROM public.payments AS p
     WHERE p.id = p_payment_id AND p.tenant_id = v_tenant_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'payment_not_found');
    END IF;
    SELECT * INTO v_invoice FROM public.invoices WHERE id = v_invoice_id AND tenant_id = v_tenant_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'payment_not_found');
    END IF;
    SELECT * INTO v_payment
      FROM public.payments
     WHERE id = p_payment_id AND tenant_id = v_tenant_id AND invoice_id = v_invoice_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'payment_not_found');
    END IF;
    v_invoice_number := left(COALESCE(v_invoice.internal_number, v_invoice.ksef_number), 120);
    IF v_payment.voided_at IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'payment_voided', 'invoice_number', v_invoice_number);
    END IF;
    -- „Zapłacone” (00158) cofa się usunięciem, a wpłaty z wyciągu mają własną
    -- drogę: KP wiąże tylko wpłatę wpisaną ręcznie do faktury sprzedaży.
    IF v_invoice.direction IS DISTINCT FROM 'outgoing'
       OR v_payment.match_method IS DISTINCT FROM 'manual_entry'
       OR NOT v_payment.is_confirmed THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'payment_not_linkable',
        'source', v_payment.match_method, 'invoice_number', v_invoice_number);
    END IF;
    SELECT c.number INTO v_linked
      FROM public.cash_documents AS c
     WHERE c.tenant_id = v_tenant_id AND c.payment_id = p_payment_id;
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'payment_linked', 'document_number', v_linked);
    END IF;
    IF v_payment.amount <> p_amount OR v_payment.payment_date <> p_operation_date THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'payment_mismatch',
        'amount', v_payment.amount, 'paid_on', v_payment.payment_date);
    END IF;
    v_payment_id := p_payment_id;
  END IF;

  -- Stan kasy nie schodzi poniżej zera: najniższy stan na koniec dnia od daty
  -- operacji w przód musi pokryć wypłatę.
  IF v_kind = 'KW' THEN
    SELECT l.balance, l.on_day INTO v_lowest, v_lowest_on
      FROM public.cash_lowest_balance(v_tenant_id, p_operation_date) AS l;
    IF v_lowest < p_amount THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'insufficient_cash',
        'available', v_lowest, 'available_on', v_lowest_on, 'amount', p_amount);
    END IF;
  END IF;

  -- Numer: jedna seria na firmę, rodzaj i rok daty operacji. Pod blokadą kasy
  -- każde polecenie widzi numery zatwierdzone przez poprzednika; UNIQUE
  -- cash_documents_number_unique pilnuje dubli także bez blokady.
  v_year := EXTRACT(YEAR FROM p_operation_date)::integer;
  SELECT COALESCE(max(c.number_seq), 0) + 1 INTO v_seq
    FROM public.cash_documents AS c
   WHERE c.tenant_id = v_tenant_id AND c.kind = v_kind AND c.number_year = v_year;
  v_number := v_kind || '/' || v_seq::text || '/' || v_year::text;

  -- KP do faktury: wpłata przez rdzeń 00176 (faktura sprzedaży przyjęta w KSeF,
  -- PLN, nie ponad resztę, blokada wiersza faktury, audyt wpłaty) w tej samej
  -- transakcji. Odmowa faktury to odmowa dowodu: nic się nie zapisało.
  IF p_invoice_id IS NOT NULL THEN
    v_record := public.record_invoice_payment(p_invoice_id, p_amount, p_idempotency_key, p_operation_date, 'Gotówka, ' || v_number, 'PLN');
    IF v_record ->> 'status' = 'refused' THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'invoice_refused',
        'invoice_code', v_record ->> 'code', 'remaining', v_record -> 'remaining',
        'currency', v_record ->> 'currency', 'internal_number', v_record ->> 'internal_number');
    END IF;
    -- `already_recorded` znaczy, że ten klucz zapisał już wpłatę bez dowodu: to nie
    -- jest ponowienie tego wystawienia (tamto oddałoby dowód wyżej).
    IF v_record ->> 'status' IS DISTINCT FROM 'recorded' THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'key_reused');
    END IF;
    v_invoice_id := p_invoice_id;
    v_payment_id := (v_record ->> 'payment_id')::uuid;
    v_payment_recorded := true;
    SELECT left(COALESCE(i.internal_number, i.ksef_number), 120) INTO v_invoice_number
      FROM public.invoices AS i WHERE i.id = p_invoice_id AND i.tenant_id = v_tenant_id;
  END IF;

  -- Wpłata z dowodem KP jest wpłatą gotówką.
  IF v_payment_id IS NOT NULL THEN
    UPDATE public.payments
       SET payment_method = 'cash'
     WHERE id = v_payment_id AND tenant_id = v_tenant_id AND voided_at IS NULL;
  END IF;

  INSERT INTO public.cash_documents (
    tenant_id, register_id, kind, number, number_year, number_seq, issue_date, operation_date,
    amount, title, counterparty, issuer, issued_by, issued_by_name, invoice_id, invoice_number,
    payment_id, related_document, idempotency_key
  ) VALUES (
    v_tenant_id, v_register.id, v_kind, v_number, v_year, v_seq, v_today, p_operation_date,
    p_amount, v_title, v_party, v_issuer, auth.uid(), v_issued_by_name, v_invoice_id, v_invoice_number,
    v_payment_id, v_related, p_idempotency_key
  )
  RETURNING id INTO v_document_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'cash_document.issued', 'cash_document', v_document_id,
    jsonb_build_object(
      'number', v_number,
      'kind', v_kind,
      'amount', p_amount,
      'operationDate', p_operation_date,
      'invoiceId', v_invoice_id,
      'paymentId', v_payment_id,
      'paymentRecorded', v_payment_recorded
    )
  );

  RETURN jsonb_build_object(
    'status', 'issued',
    'document_id', v_document_id,
    'number', v_number,
    'kind', v_kind,
    'amount', p_amount,
    'operation_date', p_operation_date,
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number,
    'payment_id', v_payment_id,
    'payment_recorded', v_payment_recorded,
    'payment_status', v_record ->> 'payment_status'
  );
END;
$$;

COMMENT ON FUNCTION public.issue_cash_document(text, uuid, date, numeric, text, jsonb, text, uuid, uuid) IS
  '00194: wystawia dowód KP albo KW: kolejny numer serii (firma, rodzaj, rok daty operacji) pod blokadą kasy, stan kasy nie poniżej zera, migawki wystawcy i strony, KP do faktury z wpłatą przez record_invoice_payment, audyt cash_document.issued w jednej transakcji. Idempotentne po kluczu.';

-- ─── RPC: korekta (storno) wystawionego dowodu ──────────────────
-- Wynik: `issued` (korekta), `already_issued` (ten sam klucz) albo `refused`.
CREATE OR REPLACE FUNCTION public.correct_cash_document(p_document_id uuid, p_reason text, p_idempotency_key uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_register public.cash_registers%ROWTYPE;
  v_existing public.cash_documents%ROWTYPE;
  v_original public.cash_documents%ROWTYPE;
  v_correction public.cash_documents%ROWTYPE;
  v_tenant public.tenants%ROWTYPE;
  v_issuer jsonb;
  v_issued_by_name text;
  v_lowest numeric;
  v_lowest_on date;
  v_seq integer;
  v_number text;
  v_storno_id uuid;
  v_payment_voided_at timestamptz;
  v_void jsonb;
  v_refusal jsonb;
  v_payment_voided boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Correcting a cash document requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')) THEN
    RAISE EXCEPTION 'Insufficient role to correct a cash document' USING ERRCODE = '42501';
  END IF;
  IF p_document_id IS NULL OR p_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;

  -- Ta sama blokada kasy co przy wystawieniu: korekta też dostaje numer serii.
  SELECT * INTO v_register FROM public.cash_registers WHERE tenant_id = v_tenant_id FOR UPDATE;
  -- Bez kasy nie ma dowodów: dowód obcej firmy wygląda jak brak dowodu.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;

  SELECT * INTO v_existing FROM public.cash_documents WHERE tenant_id = v_tenant_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.corrects_id = p_document_id THEN
      RETURN jsonb_build_object('status', 'already_issued', 'document_id', v_existing.id,
        'number', v_existing.number, 'corrects_number', v_existing.corrects_number,
        'invoice_id', v_existing.invoice_id, 'invoice_number', v_existing.invoice_number,
        'payment_voided', false);
    END IF;
    RETURN jsonb_build_object('status', 'refused', 'code', 'key_reused');
  END IF;

  SELECT * INTO v_original FROM public.cash_documents WHERE id = p_document_id AND tenant_id = v_tenant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF v_original.corrects_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'is_correction', 'number', v_original.number);
  END IF;
  SELECT * INTO v_correction FROM public.cash_documents WHERE tenant_id = v_tenant_id AND corrects_id = v_original.id;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'already_corrected',
      'number', v_original.number, 'correction_number', v_correction.number, 'correction_id', v_correction.id);
  END IF;
  IF char_length(v_reason) NOT BETWEEN 1 AND 300 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'reason_required');
  END IF;

  SELECT * INTO v_tenant FROM public.tenants WHERE id = v_tenant_id;
  v_issuer := jsonb_build_object(
    'name', btrim(COALESCE(v_tenant.name, '')),
    'nip', btrim(COALESCE(v_tenant.nip, '')),
    'countryCode', COALESCE(NULLIF(btrim(COALESCE(v_tenant.address_json ->> 'countryCode', '')), ''), 'PL'),
    'addressLine1', btrim(COALESCE(v_tenant.address_json ->> 'addressLine1', '')),
    'addressLine2', btrim(COALESCE(v_tenant.address_json ->> 'addressLine2', ''))
  );
  IF v_issuer ->> 'name' = '' OR v_issuer ->> 'nip' = ''
     OR v_issuer ->> 'addressLine1' = '' OR v_issuer ->> 'addressLine2' = '' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'issuer_incomplete');
  END IF;
  SELECT NULLIF(btrim(COALESCE(u.name, '')), '') INTO v_issued_by_name
    FROM public.users AS u WHERE u.id = auth.uid();
  IF v_issued_by_name IS NULL THEN
    SELECT NULLIF(btrim(COALESCE(a.email, '')), '') INTO v_issued_by_name
      FROM auth.users AS a WHERE a.id = auth.uid();
  END IF;
  v_issued_by_name := left(COALESCE(v_issued_by_name, 'Użytkownik FaktWay'), 320);

  -- Korekta wpłaty zabiera gotówkę z dnia operacji dowodu korygowanego: stan na
  -- koniec każdego dnia od niego w przód musi ją pokryć. Korekta wypłaty dodaje.
  IF v_original.kind = 'KP' THEN
    SELECT l.balance, l.on_day INTO v_lowest, v_lowest_on
      FROM public.cash_lowest_balance(v_tenant_id, v_original.operation_date) AS l;
    IF v_lowest < v_original.amount THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'insufficient_cash', 'number', v_original.number,
        'available', v_lowest, 'available_on', v_lowest_on, 'amount', v_original.amount);
    END IF;
  END IF;

  -- Numer w serii dowodu korygowanego: ten sam rodzaj i rok daty operacji.
  SELECT COALESCE(max(c.number_seq), 0) + 1 INTO v_seq
    FROM public.cash_documents AS c
   WHERE c.tenant_id = v_tenant_id AND c.kind = v_original.kind AND c.number_year = v_original.number_year;
  v_number := v_original.kind || '/' || v_seq::text || '/' || v_original.number_year::text;

  -- Podtransakcja: najpierw storno (dowód przestaje być aktywny, więc wyzwalacz
  -- na payments przepuści cofnięcie), potem cofnięcie wpłaty. Odmowa cofnięcia
  -- wycofuje też storno: korekta bez cofniętej wpłaty zostawiłaby fakturę
  -- zapłaconą bez dowodu.
  BEGIN
    INSERT INTO public.cash_documents (
      tenant_id, register_id, kind, number, number_year, number_seq, issue_date, operation_date,
      amount, title, counterparty, issuer, issued_by, issued_by_name, invoice_id, invoice_number,
      payment_id, related_document, corrects_id, corrects_number, correction_reason, idempotency_key
    ) VALUES (
      v_tenant_id, v_register.id, v_original.kind, v_number, v_original.number_year, v_seq, v_today,
      v_original.operation_date, -v_original.amount, 'Korekta dowodu ' || v_original.number,
      v_original.counterparty, v_issuer, auth.uid(), v_issued_by_name, v_original.invoice_id,
      v_original.invoice_number, NULL, v_original.related_document, v_original.id, v_original.number,
      v_reason, p_idempotency_key
    )
    RETURNING id INTO v_storno_id;

    IF v_original.payment_id IS NOT NULL THEN
      SELECT p.voided_at INTO v_payment_voided_at
        FROM public.payments AS p
       WHERE p.id = v_original.payment_id AND p.tenant_id = v_tenant_id;
      IF FOUND AND v_payment_voided_at IS NULL THEN
        v_void := public.void_invoice_payment(v_original.payment_id);
        IF v_void ->> 'status' IS DISTINCT FROM 'voided' AND v_void ->> 'status' IS DISTINCT FROM 'already_voided' THEN
          v_refusal := v_void;
          RAISE EXCEPTION 'cash_correction_payment_refused' USING ERRCODE = 'P0001';
        END IF;
        v_payment_voided := v_void ->> 'status' = 'voided';
      END IF;
    END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'cash_correction_payment_refused' THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'payment_refused', 'number', v_original.number,
        'payment_code', v_refusal ->> 'code', 'manual_paid_on', v_refusal -> 'manual_paid_on',
        'manual_amount', v_refusal -> 'manual_amount', 'internal_number', v_refusal ->> 'internal_number');
    END IF;
    RAISE;
  END;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'cash_document.corrected', 'cash_document', v_storno_id,
    jsonb_build_object(
      'number', v_number,
      'kind', v_original.kind,
      'amount', -v_original.amount,
      'operationDate', v_original.operation_date,
      'correctsId', v_original.id,
      'correctsNumber', v_original.number,
      'paymentId', v_original.payment_id,
      'paymentVoided', v_payment_voided
    )
  );

  RETURN jsonb_build_object(
    'status', 'issued',
    'document_id', v_storno_id,
    'number', v_number,
    'corrects_number', v_original.number,
    'invoice_id', v_original.invoice_id,
    'invoice_number', v_original.invoice_number,
    'payment_voided', v_payment_voided
  );
END;
$$;

COMMENT ON FUNCTION public.correct_cash_document(uuid, text, uuid) IS
  '00194: korekta (storno) dowodu kasowego: dowód tego samego rodzaju i serii z kwotą ujemną, datą operacji dowodu korygowanego i przyczyną; cofa wpłatę KP przez void_invoice_payment; stan kasy nie poniżej zera; audyt cash_document.corrected w jednej transakcji.';

-- ─── raport kasowy za okres (odczyt sesji przez RLS) ────────────
-- Stan przed okresem i dowody okresu w kolejności raportu: dzień operacji,
-- w obrębie dnia najpierw wpłaty (KP), potem wypłaty (KW), dalej chwila
-- wystawienia. Sumy liczy aplikacja (`buildCashReport`, przez roundToCents).
CREATE OR REPLACE FUNCTION public.cash_report(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid := public.get_current_tenant_id();
  v_register public.cash_registers%ROWTYPE;
  v_before numeric;
  v_documents jsonb;
BEGIN
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_period');
  END IF;

  SELECT * INTO v_register FROM public.cash_registers WHERE tenant_id = v_tenant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'ok', 'register', NULL, 'from', p_from, 'to', p_to);
  END IF;

  SELECT v_register.opening_balance
         + COALESCE(sum(CASE WHEN c.kind = 'KP' THEN c.amount ELSE -c.amount END), 0)
    INTO v_before
    FROM public.cash_documents AS c
   WHERE c.tenant_id = v_tenant_id AND c.operation_date < p_from;

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', c.id,
               'kind', c.kind,
               'number', c.number,
               'operation_date', c.operation_date,
               'issue_date', c.issue_date,
               'amount', c.amount,
               'title', c.title,
               'counterparty_name', c.counterparty ->> 'name',
               'invoice_number', c.invoice_number,
               'corrects_number', c.corrects_number,
               'corrected_by_number', k.number,
               'issued_at', c.issued_at
             )
             ORDER BY c.operation_date, c.kind, c.issued_at, c.id
           ),
           '[]'::jsonb
         )
    INTO v_documents
    FROM public.cash_documents AS c
    LEFT JOIN public.cash_documents AS k ON k.tenant_id = c.tenant_id AND k.corrects_id = c.id
   WHERE c.tenant_id = v_tenant_id
     AND c.operation_date BETWEEN p_from AND p_to;

  RETURN jsonb_build_object(
    'status', 'ok',
    'register', jsonb_build_object(
      'id', v_register.id,
      'opening_date', v_register.opening_date,
      'opening_balance', v_register.opening_balance
    ),
    'from', p_from,
    'to', p_to,
    'balance_before', v_before,
    'documents', v_documents
  );
END;
$$;

COMMENT ON FUNCTION public.cash_report(date, date) IS
  '00194: raport kasowy aktywnej firmy za okres: kasa, stan przed okresem i dowody okresu (z korektą i dowodem korygowanym). SECURITY INVOKER: czyta przez RLS.';

-- ─── wpłaty do faktur sprzedaży, które mogą dostać KP ───────────
-- `payments` nie ma odczytu dla sesji (00074), więc lista idzie przez RPC:
-- wpłaty wpisane ręcznie, niecofnięte, bez dowodu KP, ostatnie 100.
CREATE OR REPLACE FUNCTION public.cash_receipt_payments()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(jsonb_agg(x.item ORDER BY x.paid_on DESC, x.recorded_at DESC), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
               'payment_id', p.id,
               'invoice_id', i.id,
               'invoice_number', COALESCE(i.internal_number, i.ksef_number),
               'buyer', i.buyer_data,
               'amount', p.amount,
               'paid_on', p.payment_date
             ) AS item,
             p.payment_date AS paid_on,
             p.created_at AS recorded_at
        FROM public.payments AS p
        JOIN public.invoices AS i ON i.tenant_id = p.tenant_id AND i.id = p.invoice_id
       WHERE p.tenant_id = public.get_current_tenant_id()
         AND p.match_method = 'manual_entry'
         AND p.is_confirmed
         AND p.voided_at IS NULL
         AND i.direction = 'outgoing'
         AND NOT EXISTS (
           SELECT 1 FROM public.cash_documents AS c
            WHERE c.tenant_id = p.tenant_id AND c.payment_id = p.id
         )
       ORDER BY p.payment_date DESC, p.created_at DESC
       LIMIT 100
    ) AS x;
$$;

COMMENT ON FUNCTION public.cash_receipt_payments() IS
  '00194: wpłaty do faktur sprzedaży aktywnej firmy wpisane ręcznie, niecofnięte i bez dowodu KP (formularz KP); lista pusta dla obcej firmy.';

-- ─── uprawnienia funkcji ────────────────────────────────────────
-- Supabase nadaje EXECUTE rolom anon i authenticated jawnie, samo FROM PUBLIC
-- nic nie odbiera (AUD-30). RPC tylko dla sesji zalogowanego: klucz serwisowy
-- nie ma auth.uid().
REVOKE ALL ON FUNCTION public.open_cash_register(date, numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.open_cash_register(date, numeric) TO authenticated;
REVOKE ALL ON FUNCTION public.issue_cash_document(text, uuid, date, numeric, text, jsonb, text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.issue_cash_document(text, uuid, date, numeric, text, jsonb, text, uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.correct_cash_document(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.correct_cash_document(uuid, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.cash_report(date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cash_report(date, date) TO authenticated;
REVOKE ALL ON FUNCTION public.cash_receipt_payments() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cash_receipt_payments() TO authenticated;
-- Stan kasy dowolnej firmy z argumentu: tylko dla RPC tej migracji.
REVOKE ALL ON FUNCTION public.cash_lowest_balance(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
-- CHECK wykonuje funkcję z uprawnieniami piszącego (RPC, akcja klucza obcego).
REVOKE ALL ON FUNCTION public.cash_party_valid(jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_party_valid(jsonb, boolean) TO authenticated, service_role;
-- Funkcje wyzwalaczy nie są do wołania przez API.
REVOKE ALL ON FUNCTION public.guard_cash_document_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_cash_register_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_payment_cash_document() FROM PUBLIC, anon, authenticated;
