-- ═══════════════════════════════════════════════════════════════
-- 00193: noty obciążeniowe i uznaniowe (plan kompletnej aplikacji,
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 2.9, część 1).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem kodu. Addytywna: dwie nowe tabele, nowe
-- funkcje, nowy wyzwalacz i nowy UNIQUE (tenant_id, id) na `contractors`
-- (id to klucz główny, więc ograniczenie niczego nie narusza). Stara wersja
-- aplikacji nowych obiektów nie zna. Bez DROP tabel i kolumn, bez TRUNCATE,
-- bez zmian istniejących danych; INSERT/UPDATE tylko w ciałach funkcji, na
-- żądanie klienta.
--
-- Nota nie jest fakturą i nie trafia do KSeF: „Nie są natomiast wystawiane
-- w KSeF ani przesyłane do KSeF noty obciążeniowe ani noty uznaniowe”
-- (ksef.podatki.gov.pl, „Wystawianie i otrzymywanie faktur”, pytanie 27,
-- 27.04.2026). Nota nie trafia sama do KPiR, ewidencji ani raportów: ujęcie
-- w księgach ustala księgowa. W tej części tylko PLN.
--
-- 1. `accounting_notes`: szkic albo wystawiona nota. Pozycje (opis, kwota
--    z groszami) w `items`, suma w `total` równa sumie pozycji (CHECK).
--    Kontrahent z bazy firmy: klucz złożony (tenant_id, contractor_id), więc
--    nota nie wskaże kontrahenta innej firmy; dane kontrahenta jako migawka
--    w `counterparty`, która zostaje po usunięciu kontrahenta
--    (ON DELETE SET NULL tylko dla contractor_id, PostgreSQL 15+).
-- 2. Numer nadaje tylko RPC `issue_accounting_note`: osobna seria na firmę,
--    rodzaj i rok daty wystawienia (NO/<kolejny>/<rok> i NU/<kolejny>/<rok>),
--    blokada transakcyjna serii, UNIQUE `accounting_notes_number_unique` jako
--    druga ochrona i CHECK zgodności numeru z serią i datą. Ta sama funkcja
--    zapisuje migawkę danych wystawcy z `tenants` i audyt w tej samej
--    transakcji. Drugie wystawienie tej samej noty oddaje ten sam numer.
-- 3. Wystawionej noty nie zmienia nikt: RLS zapisu i usunięcia tylko dla
--    szkicu, a wyzwalacz `a_guard_accounting_note_update` odrzuca każdą
--    zmianę treści wystawionej noty, także kluczem serwisowym (poza zerowaniem
--    kluczy obcych przy usunięciu kontrahenta albo konta). Poprawka to nowa
--    nota. Operator: jak przy fakturze, bez edycji; błąd systemu tylko SQL-em
--    jako postgres za zgodą Bartosza.
-- 4. `accounting_note_emails`: historia wysyłek mailem. Zapis tylko przez RPC
--    `record_accounting_note_email`, raz na klucz idempotencji maila
--    (UNIQUE tenant_id, idempotency_key), z audytem w tej samej transakcji.
--
-- Kto: każdy aktywny członek firmy (właściciel, administrator, członek,
-- księgowy), tak jak przy wystawianiu faktur (00002, 00037) i w pomocy
-- („Role i uprawnienia”: księgowy ma takie same uprawnienia jak członek).
-- Firma i rola z sesji (get_current_tenant_id, has_org_role), nie z argumentów.
--
-- Uprawnienia: domyślne granty Supabase dają nowej tabeli ALL (także
-- TRUNCATE, które omija RLS), dlatego najpierw REVOKE ALL, potem jawne
-- granty; stan, numer, wystawca i autor poza grantami kolumnowymi klienta.
-- `service_role` czyta obie tabele (nocny backup).
-- Rejestr numerów: docs/koordynacja/CLAUDE-DO-CODEXA.md.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- ─── contractors: klucz pod klucz złożony noty ──────────────────
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
CREATE OR REPLACE FUNCTION public.accounting_note_items_valid(p_items jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(p_items) NOT BETWEEN 1 AND 50 THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_items) AS e(item)
       WHERE CASE
         WHEN jsonb_typeof(e.item) IS DISTINCT FROM 'object' THEN true
         WHEN jsonb_typeof(e.item -> 'description') IS DISTINCT FROM 'string' THEN true
         WHEN jsonb_typeof(e.item -> 'amount') IS DISTINCT FROM 'number' THEN true
         WHEN (SELECT count(*) FROM jsonb_object_keys(e.item)) <> 2 THEN true
         WHEN char_length(btrim(e.item ->> 'description')) NOT BETWEEN 1 AND 300 THEN true
         WHEN (e.item ->> 'amount')::numeric <= 0 THEN true
         WHEN (e.item ->> 'amount')::numeric > 1000000000 THEN true
         WHEN (e.item ->> 'amount')::numeric <> round((e.item ->> 'amount')::numeric, 2) THEN true
         ELSE false
       END
    )
  END;
$$;

COMMENT ON FUNCTION public.accounting_note_items_valid(jsonb) IS
  '00193: pozycje noty: tablica 1-50 obiektów {description, amount}; opis 1-300 znaków, kwota > 0, do 1 000 000 000, najwyżej 2 miejsca po przecinku.';

CREATE OR REPLACE FUNCTION public.accounting_note_items_total(p_items jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN NULL
    ELSE (
      SELECT COALESCE(sum(CASE WHEN jsonb_typeof(e.item -> 'amount') = 'number'
                               THEN (e.item ->> 'amount')::numeric END), 0)
        FROM jsonb_array_elements(p_items) AS e(item)
    )
  END;
$$;

COMMENT ON FUNCTION public.accounting_note_items_total(jsonb) IS
  '00193: suma kwot pozycji noty (CHECK accounting_notes_total_check). Aplikacja liczy ją przez roundToCents.';

CREATE OR REPLACE FUNCTION public.accounting_note_party_valid(p_party jsonb)
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

COMMENT ON FUNCTION public.accounting_note_party_valid(jsonb) IS
  '00193: migawka strony noty (wystawca, kontrahent): nazwa i NIP niepuste, adres do 512 znaków na wiersz.';

REVOKE ALL ON FUNCTION public.accounting_note_items_valid(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accounting_note_items_total(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accounting_note_party_valid(jsonb) FROM PUBLIC, anon;
-- CHECK wykonuje funkcję z uprawnieniami piszącego: klient (szkic) i serwis (testy, backup).
GRANT EXECUTE ON FUNCTION public.accounting_note_items_valid(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accounting_note_items_total(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accounting_note_party_valid(jsonb) TO authenticated, service_role;

-- ─── accounting_notes ───────────────────────────────────────────
CREATE TABLE public.accounting_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  -- Numer, rok i kolejny numer serii: tylko RPC issue_accounting_note.
  number text,
  number_year integer,
  number_seq integer,
  issue_date date NOT NULL,
  title text NOT NULL,
  items jsonb NOT NULL,
  total numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'PLN',
  contractor_id uuid,
  counterparty jsonb NOT NULL,
  -- Migawka danych firmy z chwili wystawienia (RPC); w szkicu pusta.
  issuer jsonb,
  related_document text,
  due_date date,
  bank_account text,
  issued_at timestamptz,
  -- SET NULL przy usunięciu konta (RODO, jak 00154).
  issued_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_by uuid DEFAULT auth.uid() REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_notes_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT accounting_notes_number_unique UNIQUE (tenant_id, kind, number_year, number_seq),
  CONSTRAINT accounting_notes_contractor_same_tenant_fk
    FOREIGN KEY (tenant_id, contractor_id)
    REFERENCES public.contractors (tenant_id, id)
    ON DELETE SET NULL (contractor_id),
  CONSTRAINT accounting_notes_kind_check CHECK (kind IN ('debit', 'credit')),
  CONSTRAINT accounting_notes_status_check CHECK (status IN ('draft', 'issued')),
  -- W tej części tylko złote (krok 2.9, część 1).
  CONSTRAINT accounting_notes_currency_check CHECK (currency = 'PLN'),
  CONSTRAINT accounting_notes_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT accounting_notes_items_check CHECK (public.accounting_note_items_valid(items)),
  CONSTRAINT accounting_notes_total_check CHECK (total = public.accounting_note_items_total(items)),
  CONSTRAINT accounting_notes_counterparty_check CHECK (public.accounting_note_party_valid(counterparty)),
  CONSTRAINT accounting_notes_issuer_check CHECK (issuer IS NULL OR public.accounting_note_party_valid(issuer)),
  CONSTRAINT accounting_notes_related_document_check CHECK (
    related_document IS NULL OR char_length(btrim(related_document)) BETWEEN 1 AND 120
  ),
  CONSTRAINT accounting_notes_issue_date_check CHECK (issue_date >= DATE '2000-01-01'),
  CONSTRAINT accounting_notes_due_date_check CHECK (due_date IS NULL OR due_date >= issue_date),
  CONSTRAINT accounting_notes_bank_account_check CHECK (
    bank_account IS NULL OR bank_account ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$'
  ),
  -- Termin zapłaty i rachunek ma tylko nota obciążeniowa.
  CONSTRAINT accounting_notes_payment_check CHECK (kind = 'debit' OR (due_date IS NULL AND bank_account IS NULL)),
  CONSTRAINT accounting_notes_issued_check CHECK (
    (status = 'draft'
      AND number IS NULL AND number_year IS NULL AND number_seq IS NULL
      AND issued_at IS NULL AND issuer IS NULL)
    OR
    (status = 'issued'
      AND number_seq >= 1
      AND issued_at IS NOT NULL
      AND issuer IS NOT NULL
      AND number_year = EXTRACT(YEAR FROM issue_date)::integer
      AND number = (CASE kind WHEN 'debit' THEN 'NO' ELSE 'NU' END)
                   || '/' || number_seq::text || '/' || number_year::text)
  )
);

COMMENT ON TABLE public.accounting_notes IS
  '00193 (krok 2.9): nota obciążeniowa albo uznaniowa. Nie jest fakturą, nie trafia do KSeF, KPiR ani raportów. Numer nadaje RPC issue_accounting_note; wystawionej nie zmienia nikt (wyzwalacz a_guard_accounting_note_update).';
COMMENT ON COLUMN public.accounting_notes.counterparty IS
  '00193: migawka danych kontrahenta z bazy firmy w chwili zapisu szkicu: name, nip, countryCode, addressLine1, addressLine2, email.';
COMMENT ON COLUMN public.accounting_notes.issuer IS
  '00193: migawka danych firmy (tenants) z chwili wystawienia: name, nip, countryCode, addressLine1, addressLine2.';

CREATE INDEX idx_accounting_notes_tenant_created
  ON public.accounting_notes (tenant_id, created_at DESC);

-- ─── wyzwalacz: wystawionej noty nie zmienia nikt ───────────────
-- Bez wyjątku dla roli (także service_role i akcja klucza obcego). Wolne są
-- tylko zerowania kluczy obcych (usunięcie kontrahenta albo konta, RODO)
-- i sam znacznik `updated_at`. Nowe kolumny są po wystawieniu zamrożone
-- z automatu: porównanie całego wiersza poza listą wolnych kolumn.
CREATE OR REPLACE FUNCTION public.guard_accounting_note_update()
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
    RAISE EXCEPTION 'Accounting note % is issued and cannot be changed; issue a new note instead', OLD.number
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_accounting_note_update() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER a_guard_accounting_note_update
  BEFORE UPDATE ON public.accounting_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_accounting_note_update();

-- ─── RLS: odczyt członków firmy, zapis klienta tylko w szkicu ───
ALTER TABLE public.accounting_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "accounting_notes_select_own_tenant" ON public.accounting_notes
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

CREATE POLICY "accounting_notes_insert_draft" ON public.accounting_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND status = 'draft'
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin')
         OR public.has_org_role(tenant_id, 'member') OR public.has_org_role(tenant_id, 'accountant'))
  );

CREATE POLICY "accounting_notes_update_draft" ON public.accounting_notes
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

CREATE POLICY "accounting_notes_delete_draft" ON public.accounting_notes
  FOR DELETE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND status = 'draft'
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin')
         OR public.has_org_role(tenant_id, 'member') OR public.has_org_role(tenant_id, 'accountant'))
  );

REVOKE ALL ON public.accounting_notes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, DELETE ON public.accounting_notes TO authenticated;
GRANT INSERT (tenant_id, kind, issue_date, title, items, total, currency, contractor_id, counterparty, related_document, due_date, bank_account)
  ON public.accounting_notes TO authenticated;
GRANT UPDATE (kind, issue_date, title, items, total, currency, contractor_id, counterparty, related_document, due_date, bank_account)
  ON public.accounting_notes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_notes TO service_role;

-- ─── accounting_note_emails: historia wysyłek mailem ────────────
CREATE TABLE public.accounting_note_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  note_id uuid NOT NULL,
  recipient text NOT NULL,
  -- Klucz idempotencji maila (Resend, 24 h): nota, skrót adresu i numer wysyłki.
  idempotency_key text NOT NULL,
  provider_message_id text,
  sent_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_note_emails_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT accounting_note_emails_note_fk
    FOREIGN KEY (tenant_id, note_id)
    REFERENCES public.accounting_notes (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT accounting_note_emails_recipient_check CHECK (
    char_length(recipient) BETWEEN 3 AND 254
    AND recipient = lower(recipient)
    AND recipient ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  CONSTRAINT accounting_note_emails_key_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT accounting_note_emails_message_check CHECK (
    provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 200
  )
);

COMMENT ON TABLE public.accounting_note_emails IS
  '00193 (krok 2.9): wysyłki noty mailem do kontrahenta. Zapis tylko RPC record_accounting_note_email, raz na klucz idempotencji maila.';

CREATE INDEX idx_accounting_note_emails_note
  ON public.accounting_note_emails (tenant_id, note_id, sent_at);

ALTER TABLE public.accounting_note_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "accounting_note_emails_select_own_tenant" ON public.accounting_note_emails
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

REVOKE ALL ON public.accounting_note_emails FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.accounting_note_emails TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_note_emails TO service_role;

-- ─── RPC: wystawienie noty (numer, wystawca, audyt) ─────────────
CREATE OR REPLACE FUNCTION public.issue_accounting_note(p_note_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  -- Dzień w Polsce, nie w strefie serwera.
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_note public.accounting_notes%ROWTYPE;
  v_tenant public.tenants%ROWTYPE;
  v_issuer jsonb;
  v_year integer;
  v_seq integer;
  v_number text;
BEGIN
  IF auth.uid() IS NULL OR p_note_id IS NULL THEN
    RAISE EXCEPTION 'Issuing an accounting note requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')
          OR public.has_org_role(v_tenant_id, 'accountant')) THEN
    RAISE EXCEPTION 'Insufficient role to issue an accounting note' USING ERRCODE = '42501';
  END IF;

  -- Blokada wiersza: dwa kliknięcia naraz idą po kolei, drugie widzi już
  -- wystawioną notę i oddaje jej numer.
  SELECT * INTO v_note
    FROM public.accounting_notes
   WHERE id = p_note_id AND tenant_id = v_tenant_id
   FOR UPDATE;
  -- Nota obcej firmy wygląda jak brak noty.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF v_note.status = 'issued' THEN
    RETURN jsonb_build_object('status', 'already_issued', 'number', v_note.number);
  END IF;
  IF v_note.issue_date > v_today THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'future_date');
  END IF;
  -- Kontrahent usunięty z bazy po zapisie szkicu (SET NULL): klient wybiera go
  -- ponownie i zapisuje szkic.
  IF v_note.contractor_id IS NULL THEN
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
  -- numery zatwierdzone przez poprzednika. UNIQUE accounting_notes_number_unique
  -- pilnuje dubli także bez blokady.
  v_year := EXTRACT(YEAR FROM v_note.issue_date)::integer;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('accounting_note:' || v_tenant_id::text || ':' || v_note.kind || ':' || v_year::text, 0)
  );
  SELECT COALESCE(max(n.number_seq), 0) + 1 INTO v_seq
    FROM public.accounting_notes AS n
   WHERE n.tenant_id = v_tenant_id
     AND n.kind = v_note.kind
     AND n.number_year = v_year;
  v_number := (CASE v_note.kind WHEN 'debit' THEN 'NO' ELSE 'NU' END)
              || '/' || v_seq::text || '/' || v_year::text;

  UPDATE public.accounting_notes
     SET status = 'issued',
         number = v_number,
         number_year = v_year,
         number_seq = v_seq,
         issuer = v_issuer,
         issued_at = now(),
         issued_by = auth.uid()
   WHERE id = p_note_id AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'accounting_note.issued', 'accounting_note', p_note_id,
    jsonb_build_object(
      'number', v_number,
      'kind', v_note.kind,
      'total', v_note.total,
      'issueDate', v_note.issue_date
    )
  );

  RETURN jsonb_build_object('status', 'issued', 'number', v_number);
END;
$$;

COMMENT ON FUNCTION public.issue_accounting_note(uuid) IS
  '00193: wystawia szkic noty: kolejny numer serii (firma, rodzaj, rok), migawka danych firmy, audyt accounting_note.issued w jednej transakcji. Idempotentne: wystawiona nota oddaje swój numer.';

REVOKE ALL ON FUNCTION public.issue_accounting_note(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_accounting_note(uuid) TO authenticated;

-- ─── RPC: zapis wysyłki mailem (raz na klucz, audyt) ────────────
CREATE OR REPLACE FUNCTION public.record_accounting_note_email(
  p_note_id uuid,
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
  v_note public.accounting_notes%ROWTYPE;
  v_recipient text := lower(btrim(COALESCE(p_recipient, '')));
  v_prefix text;
  v_email_id uuid;
BEGIN
  IF auth.uid() IS NULL OR p_note_id IS NULL THEN
    RAISE EXCEPTION 'Recording an accounting note email requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')
          OR public.has_org_role(v_tenant_id, 'accountant')) THEN
    RAISE EXCEPTION 'Insufficient role to record an accounting note email' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_note
    FROM public.accounting_notes
   WHERE id = p_note_id AND tenant_id = v_tenant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF v_note.status IS DISTINCT FROM 'issued' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_issued');
  END IF;
  -- Klucz tej noty (lib/noty/mail.ts, `noteEmailIdempotencyKey`).
  v_prefix := 'nota/' || p_note_id::text || '/';
  IF p_idempotency_key IS NULL OR left(p_idempotency_key, char_length(v_prefix)) IS DISTINCT FROM v_prefix THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_key');
  END IF;

  INSERT INTO public.accounting_note_emails (
    tenant_id, note_id, recipient, idempotency_key, provider_message_id, sent_by
  ) VALUES (
    v_tenant_id, p_note_id, v_recipient, p_idempotency_key,
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
    v_tenant_id, auth.uid(), 'accounting_note.emailed', 'accounting_note', p_note_id,
    jsonb_build_object(
      'number', v_note.number,
      'recipient', v_recipient,
      'emailId', v_email_id,
      'providerMessageId', NULLIF(btrim(COALESCE(p_provider_message_id, '')), '')
    )
  );

  RETURN jsonb_build_object('status', 'recorded', 'email_id', v_email_id);
END;
$$;

COMMENT ON FUNCTION public.record_accounting_note_email(uuid, text, text, text) IS
  '00193: zapisuje wysyłkę wystawionej noty mailem (raz na klucz idempotencji) i audyt accounting_note.emailed w jednej transakcji.';

REVOKE ALL ON FUNCTION public.record_accounting_note_email(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_accounting_note_email(uuid, text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
