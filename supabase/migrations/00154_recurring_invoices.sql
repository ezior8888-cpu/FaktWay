-- 00154 — faktury cykliczne (plan Finora E9, N1 wersja 1).
--
-- Co robi:
--   1. Tabela `recurring_invoices`: pozycja cykliczna = wskazanie faktury-wzoru
--      (tej samej firmy — klucz złożony jak w 00121), częstotliwość (co miesiąc,
--      co kwartał, co rok), dzień miesiąca 1–28 i data następnego wystawienia.
--      Pozycja tylko PRZYPOMINA i WYPEŁNIA formularz. Nic w bazie (cron, job,
--      wyzwalacz) nie tworzy z niej faktury ani szkicu — robi to człowiek
--      przyciskiem „Wystaw i wyślij do KSeF” (zasada N1).
--      Jedna pozycja na fakturę-wzór w firmie: UNIQUE
--      `recurring_invoices_template_unique` (tenant_id, template_invoice_id).
--      Dwie pozycje z tego samego wzoru to dwie faktury za ten sam miesiąc
--      dla tego samego nabywcy, a indeks okresu jest per pozycja i tego nie
--      złapie. Aplikacja sprawdza to przed zapisem (komunikat z nazwą
--      istniejącej pozycji) i rozpoznaje tę nazwę przy 23505 (wyścig dwóch
--      arkuszy) — app/actions/recurring-invoices.ts. Ten sam indeks obsługuje
--      klucz obcy wzoru (kaskada przy usunięciu faktury), więc osobnego
--      indeksu na (tenant_id, template_invoice_id) nie ma. Tabela jest nowa
--      i pusta, więc UNIQUE nie ma czego naruszyć.
--   2. W `invoices` dwie kolumny NULL: `recurring_invoice_id` (klucz złożony
--      (tenant_id, recurring_invoice_id) → recurring_invoices (tenant_id, id))
--      i `recurring_period` (okres, za który wystawiamy: '2026-11', '2026-Q4',
--      '2026'). Unikalny indeks częściowy `uq_invoices_recurring_period` daje
--      najwyżej jedną fakturę na okres pozycji — to jest idempotencja zapisu
--      (dwa równoległe kliknięcia, ponowienie po zapisie faktury). Aplikacja
--      odróżnia go po nazwie od indeksu numeru
--      `uq_invoices_tenant_outgoing_internal_number` (00120; plan N1 podaje
--      dawną nazwę z 00028).
--   3. Wyzwalacz `d_guard_invoice_recurring_link`: klient (rola
--      `authenticated`) wpisuje powiązanie tylko w INSERT, nie zmienia go
--      UPDATE-em (inaczej przepięcie okresu zwolniłoby go dla drugiej faktury).
--
-- Usunięcie pozycji cyklicznej NIE kasuje i NIE blokuje faktur:
-- `ON DELETE SET NULL (recurring_invoice_id)` (PostgreSQL 15+: produkcja
-- `supabase/postgres:15.8.1.085`, CI `major_version = 17`) zeruje samo
-- powiązanie, `tenant_id` zostaje (zerowanie całego klucza złożonego
-- naruszyłoby NOT NULL). `recurring_period` zostaje jako ślad „za jaki okres
-- była ta faktura”. Akcja klucza obcego działa jako właściciel tabeli, więc
-- wyzwalacze ochronne faktur (00073, 00079, 00119/00132, 00122/00132) jej nie
-- zatrzymują: patrzą na `current_user IN ('authenticated','anon')` albo na
-- jawne listy kolumn treści, w których nowych kolumn nie ma. Wyzwalacze
-- `UPDATE OF …` z 00012, 00118, 00124, 00125, 00133, 00137, 00148 nie
-- obejmują nowych kolumn. Sprawdza to tests/rls-faktury-cykliczne.test.ts.
--
-- Usunięcie faktury-wzoru (klient usuwa tylko szkice, a wzorem może być
-- wyłącznie faktura przyjęta w KSeF; przyjętą usuwa jedynie retencja po
-- 10 latach) kasuje pozycję: ON DELETE CASCADE na kluczu wzoru.
--
-- Uprawnienia: `invoices` ma uprawnienia na poziomie TABELI (00002, bez
-- grantów kolumnowych jak `tenants` od 00112), więc nowe kolumny nie
-- potrzebują osobnego GRANT. `recurring_invoices`: RLS z czterema politykami
-- `tenant_id = public.get_current_tenant_id()`; domyślne uprawnienia Supabase
-- dają nowej tabeli ALL (także TRUNCATE, które omija RLS), dlatego najpierw
-- REVOKE ALL od wszystkich ról, potem jawne SELECT/INSERT/UPDATE/DELETE dla
-- `authenticated` i `service_role` (backup czyta każdą tabelę jako
-- `service_role`, tests/unit/backup-readable-tables.test.ts).
--
-- Kolejność: PRZED wdrożeniem kodu (addytywna: nowa tabela, nowe kolumny
-- NULL bez wartości domyślnej, CHECK i FK na pustych kolumnach, nowy indeks
-- i wyzwalacz). Stary kod nowych kolumn nie zna i ich nie wpisuje.
-- Bez DROP, bez TRUNCATE, bez DELETE i bez UPDATE istniejących wierszy.
-- Wycofanie (tylko za zgodą Bartosza — usuwa pozycje cykliczne):
-- usunięcie wyzwalacza, indeksu, constraintów i kolumn z `invoices`, potem tabeli.

BEGIN;

CREATE TABLE public.recurring_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  template_invoice_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  -- Bez `weekly`: nie pasuje do `day_of_month` (N1).
  frequency text NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  -- Do 28, żeby każdy miesiąc miał ten dzień (luty).
  day_of_month integer NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  -- Data następnego wystawienia; okres faktury liczy się z niej
  -- (lib/invoices/recurring/schedule.ts, `recurringPeriodKey`).
  next_run_date date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  -- SET NULL przy usunięciu konta (RODO, jak 00113 i 00150).
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_invoices_tenant_id_id_key UNIQUE (tenant_id, id),
  -- Jedna pozycja na fakturę-wzór w firmie (nagłówek, pkt 1). Obsługuje też
  -- klucz obcy wzoru poniżej.
  CONSTRAINT recurring_invoices_template_unique UNIQUE (tenant_id, template_invoice_id),
  -- Wzór tylko z tej samej firmy: jednokolumnowy klucz dowodzi istnienia
  -- faktury, nie jej właściciela (00121). (tenant_id, id) w invoices daje
  -- unikalny indeks z 00073.
  CONSTRAINT recurring_invoices_template_same_tenant_fk
    FOREIGN KEY (tenant_id, template_invoice_id)
    REFERENCES public.invoices (tenant_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE public.recurring_invoices IS
  'N1: faktura cykliczna — przypomnienie i podkład formularza z faktury-wzoru. Nic nie wystawia faktury bez człowieka. Stan „Do wystawienia” = active AND next_run_date <= dziś (Europe/Warsaw), liczony przy odczycie.';

CREATE INDEX idx_recurring_invoices_due
  ON public.recurring_invoices (tenant_id, active, next_run_date);
-- Indeks pod klucz obcy wzoru (kaskada przy usunięciu faktury) daje
-- `recurring_invoices_template_unique` — osobnego nie zakładamy.

CREATE TRIGGER trg_recurring_invoices_updated_at
  BEFORE UPDATE ON public.recurring_invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.recurring_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "recurring_invoices_select_own_tenant"
  ON public.recurring_invoices FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

CREATE POLICY "recurring_invoices_insert_own_tenant"
  ON public.recurring_invoices FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_current_tenant_id());

CREATE POLICY "recurring_invoices_update_own_tenant"
  ON public.recurring_invoices FOR UPDATE
  TO authenticated
  USING (tenant_id = public.get_current_tenant_id())
  WITH CHECK (tenant_id = public.get_current_tenant_id());

CREATE POLICY "recurring_invoices_delete_own_tenant"
  ON public.recurring_invoices FOR DELETE
  TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

REVOKE ALL ON public.recurring_invoices FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recurring_invoices TO authenticated, service_role;

-- ─── invoices: powiązanie z pozycją cykliczną ───────────────────────────────

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS recurring_invoice_id uuid,
  ADD COLUMN IF NOT EXISTS recurring_period text;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_recurring_period_format_check
  CHECK (recurring_period IS NULL OR recurring_period ~ '^[0-9]{4}(-(0[1-9]|1[0-2])|-Q[1-4])?$');

-- Powiązanie zawsze z okresem. Okres bez powiązania jest dozwolony: zostaje
-- po usunięciu pozycji (SET NULL zeruje tylko `recurring_invoice_id`).
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_recurring_link_has_period_check
  CHECK (recurring_invoice_id IS NULL OR recurring_period IS NOT NULL);

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_recurring_invoice_same_tenant_fk
  FOREIGN KEY (tenant_id, recurring_invoice_id)
  REFERENCES public.recurring_invoices (tenant_id, id)
  ON DELETE SET NULL (recurring_invoice_id);

CREATE UNIQUE INDEX uq_invoices_recurring_period
  ON public.invoices (tenant_id, recurring_invoice_id, recurring_period)
  WHERE recurring_invoice_id IS NOT NULL;

COMMENT ON INDEX public.uq_invoices_recurring_period IS
  'N1: najwyżej jedna faktura na okres pozycji cyklicznej (idempotencja „Wystaw teraz”). Nazwę rozpoznaje lib/invoices/recurring/issue.ts.';
COMMENT ON COLUMN public.invoices.recurring_invoice_id IS
  'N1: pozycja cykliczna, z której wystawiono fakturę; wpisywana tylko przy INSERT. NULL po usunięciu pozycji.';
COMMENT ON COLUMN public.invoices.recurring_period IS
  'N1: okres pozycji cyklicznej, za który wystawiono fakturę (RRRR-MM, RRRR-Qn albo RRRR).';

-- Klient ustawia powiązanie wyłącznie w INSERT. Akcja klucza obcego
-- (ON DELETE SET NULL) działa jako właściciel tabeli, więc przechodzi.
CREATE OR REPLACE FUNCTION public.guard_invoice_recurring_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND (
    NEW.recurring_invoice_id IS DISTINCT FROM OLD.recurring_invoice_id
    OR NEW.recurring_period IS DISTINCT FROM OLD.recurring_period
  ) THEN
    RAISE EXCEPTION 'Recurring invoice link is set only when the invoice is created'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_invoice_recurring_link()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER d_guard_invoice_recurring_link
  BEFORE UPDATE OF recurring_invoice_id, recurring_period ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_recurring_link();

COMMIT;
