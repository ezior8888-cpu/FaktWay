-- ═══════════════════════════════════════════════════════════════
-- 00173: spis z natury (plan docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md,
-- krok K7.4, decyzja D19)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa tabela; bez DROP tabel i kolumn,
-- bez zmiany istniejących danych. Bez tabeli odczyt widzi brak spisów.
--
-- Klient zapisuje spis z natury (data, wartość). Plik JPK_PKPIR(3) bierze
-- z niego P_1 (spis z 31 grudnia poprzedniego roku albo z 1 stycznia), P_2
-- (spis z 31 grudnia) i spisy z ciągu roku (PKPIRSpis). Bez UPDATE: poprawka
-- to usunięcie i nowy spis, oba z audytem. Data wpisu i autor z bazy
-- (granty kolumnowe), jak w `ledger_manual_entries` (00167).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ledger_inventory_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Dzień spisu; od 31.12.2025 (spis na początek pierwszego roku modułu).
  data DATE NOT NULL,
  kwota_gr BIGINT NOT NULL,
  opis TEXT,
  created_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_inventory_counts_dzien_unikalny UNIQUE (tenant_id, data),
  CONSTRAINT ledger_inventory_counts_data_check CHECK (data >= DATE '2025-12-31'),
  CONSTRAINT ledger_inventory_counts_kwota_check CHECK (kwota_gr >= 0),
  CONSTRAINT ledger_inventory_counts_opis_check CHECK (opis IS NULL OR char_length(opis) BETWEEN 1 AND 256)
);

ALTER TABLE public.ledger_inventory_counts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ledger_inventory_counts_select_own_tenant" ON public.ledger_inventory_counts;
CREATE POLICY "ledger_inventory_counts_select_own_tenant" ON public.ledger_inventory_counts
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "ledger_inventory_counts_insert_owner_admin" ON public.ledger_inventory_counts;
CREATE POLICY "ledger_inventory_counts_insert_owner_admin" ON public.ledger_inventory_counts
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "ledger_inventory_counts_delete_owner_admin" ON public.ledger_inventory_counts;
CREATE POLICY "ledger_inventory_counts_delete_owner_admin" ON public.ledger_inventory_counts
  FOR DELETE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

REVOKE ALL ON public.ledger_inventory_counts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, DELETE ON public.ledger_inventory_counts TO authenticated;
GRANT INSERT (tenant_id, data, kwota_gr, opis) ON public.ledger_inventory_counts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ledger_inventory_counts TO service_role;

NOTIFY pgrst, 'reload schema';
