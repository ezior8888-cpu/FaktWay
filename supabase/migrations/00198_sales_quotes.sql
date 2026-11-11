-- ═══════════════════════════════════════════════════════════════
-- 00198: proforma i oferta (wycena) (plan kompletnej aplikacji,
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 2.4).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem kodu. Addytywna: dwie nowe tabele, nowe
-- funkcje i wyzwalacze, dwie nowe kolumny NULL w `invoices` (bez wartości
-- domyślnej) z CHECK-ami, kluczem obcym i indeksem unikalnym na pustych
-- kolumnach oraz UNIQUE (tenant_id, id) na `contractors`, jeśli go jeszcze
-- nie ma (zakłada go też 00193; id to klucz główny, więc niczego nie narusza).
-- Stara wersja aplikacji nowych obiektów nie zna i nowych kolumn nie wpisuje.
-- Bez DROP tabel i kolumn, bez TRUNCATE, bez zmian istniejących danych;
-- INSERT/UPDATE tylko w ciałach funkcji, na żądanie klienta. Indeks na
-- `invoices` powstaje w transakcji migracji: zapis faktur czeka na niego
-- chwilę (kolumny są puste, tabela niewielka).
--
-- Proforma i oferta nie są fakturami i nie trafiają do KSeF: „Do KSeF nie
-- przesyła się faktur proforma” (ksef.podatki.gov.pl, „Zakres obowiązkowego
-- KSeF”, zmiana 06.02.2026). Nie są też przychodem: leżą we własnych
-- tabelach, których nie czytają KSeF, KPiR, ewidencja, JPK, raporty ani
-- przypomnienia o płatności (strażnik tests/unit/proformy-granice.test.ts).
-- W tej części tylko PLN.
--
-- 1. `sales_quotes`: szkic albo wystawiony dokument, rodzaj `proforma` albo
--    `offer`. Pozycje jak na fakturze w `items` (nazwa, jednostka, ilość,
--    cena netto, stawka, netto, VAT, brutto); kwoty liczy aplikacja tymi
--    samymi funkcjami co fakturę (`calculateLineItem`, `calculateInvoiceTotals`,
--    zaokrąglenie `roundToCents`), a baza sprawdza kształt pozycji, grosze,
--    brutto = netto + VAT i sumy dokumentu równe sumom pozycji. Oferta ma
--    datę ważności i nie ma płatności; proforma ma sposób zapłaty, opcjonalny
--    termin i rachunek (przy przelewie wymagany). Kontrahent z bazy firmy:
--    klucz złożony (tenant_id, contractor_id), więc dokument nie wskaże
--    kontrahenta innej firmy; dane jako migawka w `counterparty`, która
--    zostaje po usunięciu kontrahenta (ON DELETE SET NULL (contractor_id)).
-- 2. Numer nadaje tylko RPC `issue_sales_quote`: osobna seria na firmę, rodzaj
--    i rok daty wystawienia (PRO/<kolejny>/<rok>, OF/<kolejny>/<rok>), blokada
--    transakcyjna serii, UNIQUE `sales_quotes_number_unique` jako druga
--    ochrona i CHECK zgodności numeru z serią i datą. Ta sama funkcja zapisuje
--    migawkę danych wystawcy z `tenants` i audyt w tej samej transakcji.
--    Drugie wystawienie tego samego dokumentu oddaje ten sam numer.
-- 3. Wystawionego dokumentu nie zmienia nikt: RLS zapisu i usunięcia tylko dla
--    szkicu, a wyzwalacz `a_guard_sales_quote_update` odrzuca każdą zmianę
--    treści wystawionego dokumentu, także kluczem serwisowym (poza zerowaniem
--    kluczy obcych przy usunięciu kontrahenta albo konta). Poprawka to nowy
--    dokument. Operator: bez edycji; błąd systemu tylko SQL-em jako postgres
--    za zgodą Bartosza.
-- 4. `sales_quote_emails`: historia wysyłek mailem. Zapis tylko przez RPC
--    `record_sales_quote_email`, raz na klucz idempotencji maila (UNIQUE
--    tenant_id, idempotency_key), z audytem w tej samej transakcji.
-- 5. Zamiana w fakturę albo fakturę zaliczkową: `invoices.sales_quote_id`
--    i `invoices.sales_quote_seq` (numer kolejnej faktury z tego dokumentu)
--    wpisuje aplikacja w TYM SAMYM INSERT co szkic faktury. Formularz faktury
--    otwarty z dokumentu tylko się wypełnia; fakturę zapisuje człowiek
--    przyciskiem, bez automatycznego wystawienia i bez wysyłki do KSeF.
--    Unikalny indeks `uq_invoices_sales_quote_seq` przepuszcza jedną fakturę
--    na numer zamiany: druga faktura z tego samego dokumentu wymaga kolejnego
--    numeru, który formularz dostaje dopiero po potwierdzeniu na ekranie
--    dokumentu (lib/proformy/powiazanie.ts rozpoznaje nazwę indeksu).
--    Wyzwalacze: powiązanie tylko z wystawionym dokumentem tej samej firmy,
--    tylko dla zwykłej albo zaliczkowej faktury sprzedaży
--    (`d_guard_invoice_sales_quote_insert`), a klient nie zmienia go UPDATE-em
--    (`d_guard_invoice_sales_quote_update`, wzór 00154). Klucz złożony
--    (tenant_id, sales_quote_id) z `ON DELETE SET NULL (sales_quote_id)`:
--    akcja klucza obcego działa jako właściciel tabeli, więc wyzwalacze
--    ochronne faktur jej nie zatrzymują (patrzą na rolę klienta albo na jawne
--    listy kolumn treści, w których nowych kolumn nie ma; jak 00154).
--    Usunięcie szkicu faktury zwalnia numer zamiany. `invoices` ma uprawnienia
--    na poziomie tabeli (00002), więc nowe kolumny nie potrzebują GRANT.
--
-- Kto: każdy aktywny członek firmy (właściciel, administrator, członek,
-- księgowy), tak jak przy wystawianiu faktur (00002, 00037) i not (00193).
-- Firma i rola z sesji (get_current_tenant_id, has_org_role), nie z argumentów.
--
-- Uprawnienia: domyślne granty Supabase dają nowej tabeli ALL (także
-- TRUNCATE, które omija RLS), dlatego najpierw REVOKE ALL, potem jawne granty;
-- stan, numer, wystawca i autor poza grantami kolumnowymi klienta.
-- `service_role` czyta obie tabele (nocny backup).
-- Rejestr numerów: docs/koordynacja/CLAUDE-DO-CODEXA.md.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- ─── contractors: klucz pod klucz złożony dokumentu ─────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'contractors_tenant_id_id_key'
       AND conrelid = 'public.contractors'::regclass
  ) THEN
    ALTER TABLE public.contractors
      ADD CONSTRAINT contractors_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
END;
$$;

-- ─── funkcje sprawdzające treść (CHECK) ─────────────────────────
-- CASE pilnuje kolejności: najpierw typ, dopiero potem rzutowanie na liczbę,
-- żeby zła treść kończyła się naruszeniem CHECK, a nie błędem rzutowania.
-- Stawki jak w formularzu faktury bez „np. II” (kontrahent z bazy to firma
-- z NIP, nie firma z UE). Ilość i cena: najwyżej 4 miejsca po przecinku, jak
-- `invoice_line_items` (NUMERIC(14,4)); kwoty: grosze.
CREATE OR REPLACE FUNCTION public.sales_quote_items_valid(p_items jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(p_items) NOT BETWEEN 1 AND 200 THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_items) AS e(item)
       WHERE CASE
         WHEN jsonb_typeof(e.item) IS DISTINCT FROM 'object' THEN true
         WHEN (SELECT count(*) FROM jsonb_object_keys(e.item)) <> 8 THEN true
         WHEN jsonb_typeof(e.item -> 'name') IS DISTINCT FROM 'string' THEN true
         WHEN jsonb_typeof(e.item -> 'unit') IS DISTINCT FROM 'string' THEN true
         WHEN jsonb_typeof(e.item -> 'vatRate') IS DISTINCT FROM 'string' THEN true
         WHEN jsonb_typeof(e.item -> 'quantity') IS DISTINCT FROM 'number' THEN true
         WHEN jsonb_typeof(e.item -> 'unitPriceNet') IS DISTINCT FROM 'number' THEN true
         WHEN jsonb_typeof(e.item -> 'netAmount') IS DISTINCT FROM 'number' THEN true
         WHEN jsonb_typeof(e.item -> 'vatAmount') IS DISTINCT FROM 'number' THEN true
         WHEN jsonb_typeof(e.item -> 'grossAmount') IS DISTINCT FROM 'number' THEN true
         WHEN char_length(btrim(e.item ->> 'name')) NOT BETWEEN 1 AND 512 THEN true
         WHEN char_length(btrim(e.item ->> 'unit')) NOT BETWEEN 1 AND 50 THEN true
         WHEN (e.item ->> 'vatRate') NOT IN ('23', '8', '5', '0', 'zw', 'oo', 'np') THEN true
         WHEN (e.item ->> 'quantity')::numeric <= 0 THEN true
         WHEN (e.item ->> 'quantity')::numeric > 9999999999.99 THEN true
         WHEN (e.item ->> 'quantity')::numeric <> round((e.item ->> 'quantity')::numeric, 4) THEN true
         WHEN (e.item ->> 'unitPriceNet')::numeric < 0 THEN true
         WHEN (e.item ->> 'unitPriceNet')::numeric > 9999999999.99 THEN true
         WHEN (e.item ->> 'unitPriceNet')::numeric <> round((e.item ->> 'unitPriceNet')::numeric, 4) THEN true
         WHEN (e.item ->> 'netAmount')::numeric < 0 THEN true
         WHEN (e.item ->> 'vatAmount')::numeric < 0 THEN true
         WHEN (e.item ->> 'netAmount')::numeric <> round((e.item ->> 'netAmount')::numeric, 2) THEN true
         WHEN (e.item ->> 'vatAmount')::numeric <> round((e.item ->> 'vatAmount')::numeric, 2) THEN true
         WHEN (e.item ->> 'grossAmount')::numeric
              <> (e.item ->> 'netAmount')::numeric + (e.item ->> 'vatAmount')::numeric THEN true
         -- Stawki bez procentu (0%, zw, oo, np) nie mają kwoty VAT.
         WHEN (e.item ->> 'vatRate') IN ('0', 'zw', 'oo', 'np')
              AND (e.item ->> 'vatAmount')::numeric <> 0 THEN true
         ELSE false
       END
    )
  END;
$$;

COMMENT ON FUNCTION public.sales_quote_items_valid(jsonb) IS
  '00198: pozycje proformy albo oferty: tablica 1-200 obiektów {name, unit, quantity, unitPriceNet, vatRate, netAmount, vatAmount, grossAmount}; stawki 23/8/5/0/zw/oo/np, ilość > 0 i cena >= 0 do 4 miejsc, kwoty w groszach, brutto = netto + VAT.';

CREATE OR REPLACE FUNCTION public.sales_quote_items_sum(p_items jsonb, p_key text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN NULL
    ELSE (
      SELECT COALESCE(sum(CASE WHEN jsonb_typeof(e.item -> p_key) = 'number'
                               THEN (e.item ->> p_key)::numeric END), 0)
        FROM jsonb_array_elements(p_items) AS e(item)
    )
  END;
$$;

COMMENT ON FUNCTION public.sales_quote_items_sum(jsonb, text) IS
  '00198: suma kwot pozycji pod kluczem (netAmount, vatAmount, grossAmount) do CHECK-ów sum dokumentu. Aplikacja liczy sumy przez calculateInvoiceTotals.';

CREATE OR REPLACE FUNCTION public.sales_quote_party_valid(p_party jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_party) IS DISTINCT FROM 'object' THEN false
    ELSE char_length(btrim(COALESCE(p_party ->> 'name', ''))) BETWEEN 1 AND 512
     AND char_length(btrim(COALESCE(p_party ->> 'nip', ''))) BETWEEN 1 AND 32
     AND char_length(COALESCE(p_party ->> 'addressLine1', '')) <= 512
     AND char_length(COALESCE(p_party ->> 'addressLine2', '')) <= 512
  END;
$$;

COMMENT ON FUNCTION public.sales_quote_party_valid(jsonb) IS
  '00198: migawka strony dokumentu (wystawca, kontrahent): nazwa i NIP niepuste, adres do 512 znaków na wiersz.';

REVOKE ALL ON FUNCTION public.sales_quote_items_valid(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sales_quote_items_sum(jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sales_quote_party_valid(jsonb) FROM PUBLIC, anon;
-- CHECK wykonuje funkcję z uprawnieniami piszącego: klient (szkic) i serwis (testy, backup).
GRANT EXECUTE ON FUNCTION public.sales_quote_items_valid(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sales_quote_items_sum(jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sales_quote_party_valid(jsonb) TO authenticated, service_role;

-- ─── sales_quotes ───────────────────────────────────────────────
CREATE TABLE public.sales_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  -- Numer, rok i kolejny numer serii: tylko RPC issue_sales_quote.
  number text,
  number_year integer,
  number_seq integer,
  issue_date date NOT NULL,
  -- Tylko oferta: do kiedy jest ważna.
  valid_until date,
  items jsonb NOT NULL,
  -- Jak kwoty faktury: NUMERIC(12,2), poniżej 10 mld zł.
  net_total numeric(12,2) NOT NULL,
  vat_total numeric(12,2) NOT NULL,
  gross_total numeric(12,2) NOT NULL,
  currency text NOT NULL DEFAULT 'PLN',
  contractor_id uuid,
  counterparty jsonb NOT NULL,
  -- Migawka danych firmy z chwili wystawienia (RPC); w szkicu pusta.
  issuer jsonb,
  -- Tylko proforma: sposób, termin i rachunek do zapłaty.
  payment_method text,
  payment_due_date date,
  bank_account text,
  notes text,
  issued_at timestamptz,
  -- SET NULL przy usunięciu konta (RODO, jak 00154 i 00193).
  issued_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_by uuid DEFAULT auth.uid() REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_quotes_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT sales_quotes_number_unique UNIQUE (tenant_id, kind, number_year, number_seq),
  CONSTRAINT sales_quotes_contractor_same_tenant_fk
    FOREIGN KEY (tenant_id, contractor_id)
    REFERENCES public.contractors (tenant_id, id)
    ON DELETE SET NULL (contractor_id),
  CONSTRAINT sales_quotes_kind_check CHECK (kind IN ('proforma', 'offer')),
  CONSTRAINT sales_quotes_status_check CHECK (status IN ('draft', 'issued')),
  -- W tej części tylko złote (krok 2.4; waluty przyjdą z krokiem 2.1).
  CONSTRAINT sales_quotes_currency_check CHECK (currency = 'PLN'),
  CONSTRAINT sales_quotes_items_check CHECK (public.sales_quote_items_valid(items)),
  CONSTRAINT sales_quotes_net_total_check CHECK (net_total = public.sales_quote_items_sum(items, 'netAmount')),
  CONSTRAINT sales_quotes_vat_total_check CHECK (vat_total = public.sales_quote_items_sum(items, 'vatAmount')),
  CONSTRAINT sales_quotes_gross_total_check CHECK (
    gross_total = net_total + vat_total
    AND gross_total = public.sales_quote_items_sum(items, 'grossAmount')
  ),
  CONSTRAINT sales_quotes_counterparty_check CHECK (public.sales_quote_party_valid(counterparty)),
  CONSTRAINT sales_quotes_issuer_check CHECK (issuer IS NULL OR public.sales_quote_party_valid(issuer)),
  CONSTRAINT sales_quotes_issue_date_check CHECK (issue_date >= DATE '2000-01-01'),
  CONSTRAINT sales_quotes_valid_until_check CHECK (valid_until IS NULL OR valid_until >= issue_date),
  CONSTRAINT sales_quotes_payment_method_check CHECK (
    payment_method IS NULL OR payment_method IN ('transfer', 'cash', 'card', 'other')
  ),
  CONSTRAINT sales_quotes_payment_due_date_check CHECK (payment_due_date IS NULL OR payment_due_date >= issue_date),
  CONSTRAINT sales_quotes_bank_account_check CHECK (
    bank_account IS NULL OR bank_account ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$'
  ),
  -- Oferta: data ważności, bez płatności. Proforma: sposób zapłaty, bez daty ważności.
  CONSTRAINT sales_quotes_kind_fields_check CHECK (
    (kind = 'offer' AND valid_until IS NOT NULL
      AND payment_method IS NULL AND payment_due_date IS NULL AND bank_account IS NULL)
    OR (kind = 'proforma' AND valid_until IS NULL AND payment_method IS NOT NULL)
  ),
  -- Przelew bez rachunku to proforma, której nie da się zapłacić.
  CONSTRAINT sales_quotes_transfer_account_check CHECK (
    payment_method IS DISTINCT FROM 'transfer' OR bank_account IS NOT NULL
  ),
  CONSTRAINT sales_quotes_notes_check CHECK (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 2000),
  CONSTRAINT sales_quotes_issued_check CHECK (
    (status = 'draft'
      AND number IS NULL AND number_year IS NULL AND number_seq IS NULL
      AND issued_at IS NULL AND issuer IS NULL)
    OR
    (status = 'issued'
      AND number_seq >= 1
      AND issued_at IS NOT NULL
      AND issuer IS NOT NULL
      AND number_year = EXTRACT(YEAR FROM issue_date)::integer
      AND number = (CASE kind WHEN 'proforma' THEN 'PRO' ELSE 'OF' END)
                   || '/' || number_seq::text || '/' || number_year::text)
  )
);

COMMENT ON TABLE public.sales_quotes IS
  '00198 (krok 2.4): proforma albo oferta (wycena) z pozycjami i kwotami jak na fakturze. Nie jest fakturą, nie trafia do KSeF, KPiR, JPK, raportów ani przypomnień. Numer nadaje RPC issue_sales_quote; wystawionego nie zmienia nikt (wyzwalacz a_guard_sales_quote_update).';
COMMENT ON COLUMN public.sales_quotes.items IS
  '00198: pozycje: name, unit, quantity, unitPriceNet, vatRate, netAmount, vatAmount, grossAmount (kwoty z calculateLineItem).';
COMMENT ON COLUMN public.sales_quotes.counterparty IS
  '00198: migawka danych kontrahenta z bazy firmy w chwili zapisu szkicu: name, nip, countryCode, addressLine1, addressLine2, email.';
COMMENT ON COLUMN public.sales_quotes.issuer IS
  '00198: migawka danych firmy (tenants) z chwili wystawienia: name, nip, countryCode, addressLine1, addressLine2.';

CREATE INDEX idx_sales_quotes_tenant_created
  ON public.sales_quotes (tenant_id, created_at DESC);

-- ─── wyzwalacz: wystawionego dokumentu nie zmienia nikt ─────────
-- Bez wyjątku dla roli (także service_role i akcja klucza obcego). Wolne są
-- tylko zerowania kluczy obcych (usunięcie kontrahenta albo konta, RODO)
-- i sam znacznik `updated_at`. Nowe kolumny są po wystawieniu zamrożone
-- z automatu: porównanie całego wiersza poza listą wolnych kolumn.
CREATE OR REPLACE FUNCTION public.guard_sales_quote_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_free constant text[] := ARRAY['contractor_id', 'issued_by', 'created_by', 'updated_at'];
BEGIN
  IF OLD.status = 'issued' AND (
       (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free)
       OR (NEW.contractor_id IS NOT NULL AND NEW.contractor_id IS DISTINCT FROM OLD.contractor_id)
       OR (NEW.issued_by IS NOT NULL AND NEW.issued_by IS DISTINCT FROM OLD.issued_by)
       OR (NEW.created_by IS NOT NULL AND NEW.created_by IS DISTINCT FROM OLD.created_by)
     ) THEN
    RAISE EXCEPTION 'Sales quote % is issued and cannot be changed; issue a new document instead', OLD.number
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_sales_quote_update() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER a_guard_sales_quote_update
  BEFORE UPDATE ON public.sales_quotes
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_quote_update();

-- ─── RLS: odczyt członków firmy, zapis klienta tylko w szkicu ───
ALTER TABLE public.sales_quotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sales_quotes_select_own_tenant" ON public.sales_quotes
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

CREATE POLICY "sales_quotes_insert_draft" ON public.sales_quotes
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND status = 'draft'
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin')
         OR public.has_org_role(tenant_id, 'member') OR public.has_org_role(tenant_id, 'accountant'))
  );

CREATE POLICY "sales_quotes_update_draft" ON public.sales_quotes
  FOR UPDATE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND status = 'draft'
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin')
         OR public.has_org_role(tenant_id, 'member') OR public.has_org_role(tenant_id, 'accountant'))
  )
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND status = 'draft'
  );

CREATE POLICY "sales_quotes_delete_draft" ON public.sales_quotes
  FOR DELETE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND status = 'draft'
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin')
         OR public.has_org_role(tenant_id, 'member') OR public.has_org_role(tenant_id, 'accountant'))
  );

REVOKE ALL ON public.sales_quotes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, DELETE ON public.sales_quotes TO authenticated;
GRANT INSERT (tenant_id, kind, issue_date, valid_until, items, net_total, vat_total, gross_total, currency, contractor_id, counterparty, payment_method, payment_due_date, bank_account, notes)
  ON public.sales_quotes TO authenticated;
GRANT UPDATE (kind, issue_date, valid_until, items, net_total, vat_total, gross_total, currency, contractor_id, counterparty, payment_method, payment_due_date, bank_account, notes)
  ON public.sales_quotes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_quotes TO service_role;

-- ─── sales_quote_emails: historia wysyłek mailem ────────────────
CREATE TABLE public.sales_quote_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  quote_id uuid NOT NULL,
  recipient text NOT NULL,
  -- Klucz idempotencji maila (Resend, 24 h): dokument, skrót adresu i numer wysyłki.
  idempotency_key text NOT NULL,
  provider_message_id text,
  sent_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_quote_emails_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT sales_quote_emails_quote_fk
    FOREIGN KEY (tenant_id, quote_id)
    REFERENCES public.sales_quotes (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT sales_quote_emails_recipient_check CHECK (
    char_length(recipient) BETWEEN 3 AND 254
    AND recipient = lower(recipient)
    AND recipient ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  CONSTRAINT sales_quote_emails_key_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT sales_quote_emails_message_check CHECK (
    provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 200
  )
);

COMMENT ON TABLE public.sales_quote_emails IS
  '00198 (krok 2.4): wysyłki proformy albo oferty mailem do kontrahenta. Zapis tylko RPC record_sales_quote_email, raz na klucz idempotencji maila.';

CREATE INDEX idx_sales_quote_emails_quote
  ON public.sales_quote_emails (tenant_id, quote_id, sent_at);

ALTER TABLE public.sales_quote_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sales_quote_emails_select_own_tenant" ON public.sales_quote_emails
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

REVOKE ALL ON public.sales_quote_emails FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.sales_quote_emails TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_quote_emails TO service_role;

-- ─── RPC: wystawienie dokumentu (numer, wystawca, audyt) ────────
CREATE OR REPLACE FUNCTION public.issue_sales_quote(p_quote_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  -- Dzień w Polsce, nie w strefie serwera.
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_quote public.sales_quotes%ROWTYPE;
  v_tenant public.tenants%ROWTYPE;
  v_issuer jsonb;
  v_prefix text;
  v_year integer;
  v_seq integer;
  v_number text;
BEGIN
  IF auth.uid() IS NULL OR p_quote_id IS NULL THEN
    RAISE EXCEPTION 'Issuing a sales quote requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')
          OR public.has_org_role(v_tenant_id, 'accountant')) THEN
    RAISE EXCEPTION 'Insufficient role to issue a sales quote' USING ERRCODE = '42501';
  END IF;

  -- Blokada wiersza: dwa kliknięcia naraz idą po kolei, drugie widzi już
  -- wystawiony dokument i oddaje jego numer.
  SELECT * INTO v_quote
    FROM public.sales_quotes
   WHERE id = p_quote_id AND tenant_id = v_tenant_id
   FOR UPDATE;
  -- Dokument obcej firmy wygląda jak brak dokumentu.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF v_quote.status = 'issued' THEN
    RETURN jsonb_build_object('status', 'already_issued', 'number', v_quote.number);
  END IF;
  IF v_quote.issue_date > v_today THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'future_date');
  END IF;
  -- Oferta, której ważność minęła przed wystawieniem: klient poprawia datę w szkicu.
  IF v_quote.kind = 'offer' AND v_quote.valid_until < v_today THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'valid_until_past');
  END IF;
  -- Kontrahent usunięty z bazy po zapisie szkicu (SET NULL): klient wybiera go
  -- ponownie i zapisuje szkic.
  IF v_quote.contractor_id IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'contractor_missing');
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

  -- Jedna seria na firmę, rodzaj i rok daty wystawienia. Blokada transakcyjna
  -- serii, potem kolejny numer: w READ COMMITTED każde polecenie funkcji widzi
  -- numery zatwierdzone przez poprzednika. UNIQUE sales_quotes_number_unique
  -- pilnuje dubli także bez blokady.
  v_prefix := CASE v_quote.kind WHEN 'proforma' THEN 'PRO' ELSE 'OF' END;
  v_year := EXTRACT(YEAR FROM v_quote.issue_date)::integer;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('sales_quote:' || v_tenant_id::text || ':' || v_quote.kind || ':' || v_year::text, 0)
  );
  SELECT COALESCE(max(q.number_seq), 0) + 1 INTO v_seq
    FROM public.sales_quotes AS q
   WHERE q.tenant_id = v_tenant_id
     AND q.kind = v_quote.kind
     AND q.number_year = v_year;
  v_number := v_prefix || '/' || v_seq::text || '/' || v_year::text;

  UPDATE public.sales_quotes
     SET status = 'issued',
         number = v_number,
         number_year = v_year,
         number_seq = v_seq,
         issuer = v_issuer,
         issued_at = now(),
         issued_by = auth.uid()
   WHERE id = p_quote_id AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'sales_quote.issued', 'sales_quote', p_quote_id,
    jsonb_build_object(
      'number', v_number,
      'kind', v_quote.kind,
      'grossTotal', v_quote.gross_total,
      'issueDate', v_quote.issue_date
    )
  );

  RETURN jsonb_build_object('status', 'issued', 'number', v_number);
END;
$$;

COMMENT ON FUNCTION public.issue_sales_quote(uuid) IS
  '00198: wystawia szkic proformy albo oferty: kolejny numer serii (firma, rodzaj, rok), migawka danych firmy, audyt sales_quote.issued w jednej transakcji. Idempotentne: wystawiony dokument oddaje swój numer.';

REVOKE ALL ON FUNCTION public.issue_sales_quote(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_sales_quote(uuid) TO authenticated;

-- ─── RPC: zapis wysyłki mailem (raz na klucz, audyt) ────────────
CREATE OR REPLACE FUNCTION public.record_sales_quote_email(
  p_quote_id uuid,
  p_recipient text,
  p_idempotency_key text,
  p_provider_message_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_quote public.sales_quotes%ROWTYPE;
  v_recipient text := lower(btrim(COALESCE(p_recipient, '')));
  v_prefix text;
  v_email_id uuid;
BEGIN
  IF auth.uid() IS NULL OR p_quote_id IS NULL THEN
    RAISE EXCEPTION 'Recording a sales quote email requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')
          OR public.has_org_role(v_tenant_id, 'accountant')) THEN
    RAISE EXCEPTION 'Insufficient role to record a sales quote email' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_quote
    FROM public.sales_quotes
   WHERE id = p_quote_id AND tenant_id = v_tenant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF v_quote.status IS DISTINCT FROM 'issued' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_issued');
  END IF;
  -- Klucz tego dokumentu (lib/proformy/mail.ts, `quoteEmailIdempotencyKey`).
  v_prefix := 'sales-quote/' || p_quote_id::text || '/';
  IF p_idempotency_key IS NULL OR left(p_idempotency_key, char_length(v_prefix)) IS DISTINCT FROM v_prefix THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_key');
  END IF;

  INSERT INTO public.sales_quote_emails (
    tenant_id, quote_id, recipient, idempotency_key, provider_message_id, sent_by
  ) VALUES (
    v_tenant_id, p_quote_id, v_recipient, p_idempotency_key,
    NULLIF(btrim(COALESCE(p_provider_message_id, '')), ''), auth.uid()
  )
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_email_id;

  -- Ponowienie z tym samym kluczem: wysyłka jest już w historii, bez drugiego wpisu i audytu.
  IF v_email_id IS NULL THEN
    RETURN jsonb_build_object('status', 'already_recorded');
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'sales_quote.emailed', 'sales_quote', p_quote_id,
    jsonb_build_object(
      'number', v_quote.number,
      'kind', v_quote.kind,
      'recipient', v_recipient,
      'emailId', v_email_id,
      'providerMessageId', NULLIF(btrim(COALESCE(p_provider_message_id, '')), '')
    )
  );

  RETURN jsonb_build_object('status', 'recorded', 'email_id', v_email_id);
END;
$$;

COMMENT ON FUNCTION public.record_sales_quote_email(uuid, text, text, text) IS
  '00198: zapisuje wysyłkę wystawionej proformy albo oferty mailem (raz na klucz idempotencji) i audyt sales_quote.emailed w jednej transakcji.';

REVOKE ALL ON FUNCTION public.record_sales_quote_email(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_sales_quote_email(uuid, text, text, text) TO authenticated;

-- ─── invoices: faktura z proformy albo oferty ───────────────────
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS sales_quote_id uuid,
  ADD COLUMN IF NOT EXISTS sales_quote_seq integer;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_sales_quote_seq_check
  CHECK (sales_quote_seq IS NULL OR sales_quote_seq BETWEEN 1 AND 9999);

-- Powiązanie zawsze z numerem zamiany. Numer bez powiązania jest dozwolony:
-- zostaje po usunięciu dokumentu (SET NULL zeruje tylko `sales_quote_id`).
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_sales_quote_link_has_seq_check
  CHECK (sales_quote_id IS NULL OR sales_quote_seq IS NOT NULL);

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_sales_quote_same_tenant_fk
  FOREIGN KEY (tenant_id, sales_quote_id)
  REFERENCES public.sales_quotes (tenant_id, id)
  ON DELETE SET NULL (sales_quote_id);

CREATE UNIQUE INDEX uq_invoices_sales_quote_seq
  ON public.invoices (tenant_id, sales_quote_id, sales_quote_seq)
  WHERE sales_quote_id IS NOT NULL;

COMMENT ON INDEX public.uq_invoices_sales_quote_seq IS
  '00198: najwyżej jedna faktura na numer zamiany dokumentu; druga faktura z tej samej proformy albo oferty tylko z kolejnym numerem (po potwierdzeniu). Nazwę rozpoznaje lib/proformy/powiazanie.ts.';
COMMENT ON COLUMN public.invoices.sales_quote_id IS
  '00198: proforma albo oferta, z której otwarto formularz faktury; wpisywana tylko przy INSERT. NULL po usunięciu dokumentu.';
COMMENT ON COLUMN public.invoices.sales_quote_seq IS
  '00198: numer kolejnej faktury z tego dokumentu (1 = pierwsza).';

-- Powiązanie tylko z wystawionym dokumentem tej samej firmy, tylko dla zwykłej
-- albo zaliczkowej faktury sprzedaży. SECURITY DEFINER, żeby stan dokumentu
-- był widoczny bez względu na RLS piszącego; dokumentu innej firmy funkcja nie
-- znajduje i zostawia go kluczowi obcemu (invoices_sales_quote_same_tenant_fk).
CREATE OR REPLACE FUNCTION public.guard_invoice_sales_quote_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT q.status INTO v_status
    FROM public.sales_quotes AS q
   WHERE q.id = NEW.sales_quote_id AND q.tenant_id = NEW.tenant_id;
  IF FOUND AND v_status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'Sales quote % is not issued; only an issued document can become an invoice', NEW.sales_quote_id
      USING ERRCODE = '42501';
  END IF;
  IF NEW.direction::text IS DISTINCT FROM 'outgoing'
     OR NEW.invoice_kind::text NOT IN ('regular', 'advance') THEN
    RAISE EXCEPTION 'Only a regular or advance sales invoice can be created from a sales quote'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_invoice_sales_quote_insert() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER d_guard_invoice_sales_quote_insert
  BEFORE INSERT ON public.invoices
  FOR EACH ROW
  WHEN (NEW.sales_quote_id IS NOT NULL)
  EXECUTE FUNCTION public.guard_invoice_sales_quote_insert();

-- Klient ustawia powiązanie wyłącznie w INSERT. Akcja klucza obcego
-- (ON DELETE SET NULL) działa jako właściciel tabeli, więc przechodzi.
CREATE OR REPLACE FUNCTION public.guard_invoice_sales_quote_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND (
    NEW.sales_quote_id IS DISTINCT FROM OLD.sales_quote_id
    OR NEW.sales_quote_seq IS DISTINCT FROM OLD.sales_quote_seq
  ) THEN
    RAISE EXCEPTION 'Sales quote link is set only when the invoice is created'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_invoice_sales_quote_update() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER d_guard_invoice_sales_quote_update
  BEFORE UPDATE OF sales_quote_id, sales_quote_seq ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_sales_quote_update();

NOTIFY pgrst, 'reload schema';

COMMIT;
