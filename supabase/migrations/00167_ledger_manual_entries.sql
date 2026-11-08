-- ═══════════════════════════════════════════════════════════════
-- 00167: wpisy ręczne w ewidencji przychodów (plan docs/koordynacja/
-- PLAN-KSIEGOWOSC-JDG.md, krok K3, decyzja D5)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa tabela, indeks i polityki RLS;
-- bez DROP tabel i kolumn, bez zmiany istniejących danych.
--
-- Przychody bez faktury z KSeF: raport z kasy rejestrującej (za dzień albo
-- miesiąc) i inne dowody. Ewidencja (lib/ksiegowosc/ewidencja.ts) liczy je
-- na żywo razem z fakturami i wpisuje do JPK_EWP(4). Kwota w groszach (PLN,
-- ujemna przy zwrocie, nigdy zero), stawka ryczałtu w punktach bazowych ze
-- słownika K_9 JPK_EWP(4). Koszty i kolumny KPiR dojdą w K7.
--
-- Wpisu się nie poprawia: zmiana to usunięcie i nowy wpis, a każde z nich
-- zapisuje akcja w audit_logs. Data wpisu (K_2) to dzień dodania w strefie
-- Europe/Warsaw: authenticated ma INSERT tylko na kolumny z treścią wpisu,
-- więc nie podstawi ani daty wpisu, ani autora.
--
-- RLS: odczyt dla członków firmy; INSERT i DELETE tylko owner/admin
-- (has_org_role z 00037); UPDATE nie ma nikt poza service_role.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ledger_manual_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  rodzaj TEXT NOT NULL DEFAULT 'raport_kasy',
  data_przychodu DATE NOT NULL,
  data_wpisu DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Europe/Warsaw')::date),
  dokument TEXT NOT NULL,
  kwota_gr BIGINT NOT NULL,
  stawka_pb INTEGER NOT NULL,
  opis TEXT,
  created_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_manual_entries_rodzaj_check CHECK (rodzaj IN ('raport_kasy', 'inny')),
  -- Moduł liczy od 2026 r., jak tax_profiles (00166).
  CONSTRAINT ledger_manual_entries_data_check CHECK (data_przychodu >= DATE '2026-01-01'),
  -- K_4 JPK_EWP: 1-256 znaków.
  CONSTRAINT ledger_manual_entries_dokument_check CHECK (char_length(btrim(dokument)) BETWEEN 1 AND 256),
  -- Zwrot albo korekta raportu bywa ujemna; zero nie jest wpisem. Górna
  -- granica mieści się w K_8 (TKwotowy, 18 cyfr, w tym 2 po przecinku).
  CONSTRAINT ledger_manual_entries_kwota_check CHECK (kwota_gr <> 0 AND kwota_gr BETWEEN -99999999999999 AND 99999999999999),
  -- Słownik K_9 JPK_EWP(4): 17, 15, 14, 12,5, 12, 10, 8,5, 5,5 i 3 %.
  CONSTRAINT ledger_manual_entries_stawka_check CHECK (stawka_pb IN (1700, 1500, 1400, 1250, 1200, 1000, 850, 550, 300)),
  -- K_10 JPK_EWP: do 256 znaków. Kolumna dopuszcza NULL, więc warunek mówi to wprost.
  CONSTRAINT ledger_manual_entries_opis_check CHECK (opis IS NULL OR char_length(opis) <= 256)
);

CREATE INDEX IF NOT EXISTS idx_ledger_manual_entries_tenant_data
  ON public.ledger_manual_entries (tenant_id, data_przychodu);

COMMENT ON TABLE public.ledger_manual_entries IS
  'Wpisy ręczne ewidencji przychodów (raport kasy, inne dowody; plan księgowości JDG, K3, D5). '
  'Zapis i usunięcie: owner/admin z sesji, z audytem; bez UPDATE.';

ALTER TABLE public.ledger_manual_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ledger_manual_entries_select_own_tenant" ON public.ledger_manual_entries;
CREATE POLICY "ledger_manual_entries_select_own_tenant"
  ON public.ledger_manual_entries
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "ledger_manual_entries_insert_owner_admin" ON public.ledger_manual_entries;
CREATE POLICY "ledger_manual_entries_insert_owner_admin"
  ON public.ledger_manual_entries
  FOR INSERT
  TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "ledger_manual_entries_delete_owner_admin" ON public.ledger_manual_entries;
CREATE POLICY "ledger_manual_entries_delete_owner_admin"
  ON public.ledger_manual_entries
  FOR DELETE
  TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

REVOKE ALL ON public.ledger_manual_entries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, DELETE ON public.ledger_manual_entries TO authenticated;
GRANT INSERT (tenant_id, rodzaj, data_przychodu, dokument, kwota_gr, stawka_pb, opis)
  ON public.ledger_manual_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ledger_manual_entries TO service_role;

NOTIFY pgrst, 'reload schema';
