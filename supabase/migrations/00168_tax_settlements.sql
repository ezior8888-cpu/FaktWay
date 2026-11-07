-- ═══════════════════════════════════════════════════════════════
-- 00168: zatwierdzone rozliczenia miesiąca i próg najmu w profilu (plan
-- docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md, krok K4, decyzja D6)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa kolumna z wartością domyślną, nowa
-- tabela, funkcja wyzwalacza i polityki RLS; bez DROP tabel i kolumn, bez
-- zmiany istniejących danych.
--
-- 1. tax_profiles.najem: przychody 8,5 % to najem, dzierżawa albo
--    zakwaterowanie, więc ponad 100 tys. zł w roku idą z 12,5 % (ewidencja,
--    lib/ksiegowosc/ewidencja.ts). Tylko przy ryczałcie. Grant na tabelę
--    z 00166 obejmuje kolumnę.
--
-- 2. tax_settlements: ZATWIERDZONE rozliczenie miesiąca, jedna wersja na
--    rodzaj (ryczałt, składki społeczne, zdrowotna; PIT i VAT dojdą w K6 i K7).
--    Szkic liczy się na żywo i nie trafia do bazy. Zatwierdzenie zapisuje
--    kwotę, termin i migawkę wejść (D6); zmiana danych po zatwierdzeniu to
--    nowa wersja, a aktualna to ta z najwyższym numerem. Zatwierdzonego
--    wiersza nie da się zmienić ani usunąć: wyzwalacz puszcza tylko
--    oznaczenie zapłaty i jego cofnięcie (status, zaplacone_o).
--    Kto i kiedy zatwierdził, ustawia baza (granty kolumnowe).
--
-- RLS: odczyt dla członków firmy; INSERT i UPDATE tylko owner/admin
-- (has_org_role z 00037); DELETE nie ma nikt poza service_role. Każde
-- zatwierdzenie i oznaczenie zapłaty zapisuje akcja w audit_logs.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.tax_profiles ADD COLUMN IF NOT EXISTS najem BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.tax_profiles DROP CONSTRAINT IF EXISTS tax_profiles_najem_check;
ALTER TABLE public.tax_profiles
  ADD CONSTRAINT tax_profiles_najem_check CHECK (NOT najem OR forma = 'ryczalt');

COMMENT ON COLUMN public.tax_profiles.najem IS
  'Przychody 8,5 % to najem/dzierżawa/zakwaterowanie: ponad 100 tys. zł w roku 12,5 % (K4). Tylko ryczałt.';

CREATE TABLE IF NOT EXISTS public.tax_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Pierwszy dzień rozliczanego miesiąca.
  okres DATE NOT NULL,
  rodzaj TEXT NOT NULL,
  wersja INTEGER NOT NULL,
  kwota_gr BIGINT NOT NULL,
  termin DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'zatwierdzone',
  -- Wejścia (przychód według stawek, zapłacone składki, profil, parametry) i wynik.
  migawka JSONB NOT NULL,
  -- Skrót parametrów użytych do liczenia (lib/ksiegowosc/ten-miesiac.ts).
  parametry_wersja TEXT NOT NULL,
  -- SHA-256 wejść: zmiana danych po zatwierdzeniu daje inny skrót i nową wersję.
  wejscia_hash TEXT NOT NULL,
  zatwierdzone_przez UUID DEFAULT auth.uid(),
  zatwierdzone_o TIMESTAMPTZ NOT NULL DEFAULT now(),
  zaplacone_o DATE,
  CONSTRAINT tax_settlements_unikalna_wersja UNIQUE (tenant_id, okres, rodzaj, wersja),
  -- Moduł liczy od 2026 r.; okres to zawsze pierwszy dzień miesiąca.
  CONSTRAINT tax_settlements_okres_check CHECK (okres >= DATE '2026-01-01' AND EXTRACT(DAY FROM okres) = 1),
  CONSTRAINT tax_settlements_rodzaj_check CHECK (rodzaj IN ('ryczalt', 'pit', 'vat', 'zus_spoleczne', 'zdrowotna')),
  CONSTRAINT tax_settlements_wersja_check CHECK (wersja >= 1),
  CONSTRAINT tax_settlements_kwota_check CHECK (kwota_gr >= 0),
  CONSTRAINT tax_settlements_status_check CHECK (status IN ('zatwierdzone', 'zaplacone')),
  -- Data zapłaty jest dokładnie wtedy, gdy status mówi „zapłacone”.
  CONSTRAINT tax_settlements_zaplata_check CHECK ((status = 'zaplacone') = (zaplacone_o IS NOT NULL)),
  CONSTRAINT tax_settlements_hash_check CHECK (wejscia_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tax_settlements_parametry_check CHECK (char_length(parametry_wersja) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS idx_tax_settlements_tenant_okres
  ON public.tax_settlements (tenant_id, okres);
-- Odliczenia ryczałtu czytają składki po dniu zapłaty.
CREATE INDEX IF NOT EXISTS idx_tax_settlements_tenant_zaplacone
  ON public.tax_settlements (tenant_id, zaplacone_o) WHERE zaplacone_o IS NOT NULL;

COMMENT ON TABLE public.tax_settlements IS
  'Zatwierdzone rozliczenia miesiąca w wersjach (plan księgowości JDG, K4, D6). '
  'Niezmienne poza oznaczeniem zapłaty (wyzwalacz guard_tax_settlement_immutable); bez DELETE.';

-- Niezmienność zatwierdzonego rozliczenia (D6). UPDATE może zmienić tylko
-- status i datę zapłaty; HINT pozwala akcji odróżnić ten błąd od CHECK.
CREATE OR REPLACE FUNCTION public.guard_tax_settlement_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.okres IS DISTINCT FROM OLD.okres
     OR NEW.rodzaj IS DISTINCT FROM OLD.rodzaj
     OR NEW.wersja IS DISTINCT FROM OLD.wersja
     OR NEW.kwota_gr IS DISTINCT FROM OLD.kwota_gr
     OR NEW.termin IS DISTINCT FROM OLD.termin
     OR NEW.migawka IS DISTINCT FROM OLD.migawka
     OR NEW.parametry_wersja IS DISTINCT FROM OLD.parametry_wersja
     OR NEW.wejscia_hash IS DISTINCT FROM OLD.wejscia_hash
     OR NEW.zatwierdzone_przez IS DISTINCT FROM OLD.zatwierdzone_przez
     OR NEW.zatwierdzone_o IS DISTINCT FROM OLD.zatwierdzone_o THEN
    RAISE EXCEPTION 'Zatwierdzonego rozliczenia nie zmienia się (wersja %); zmiana danych tworzy nową wersję.', OLD.wersja
      USING ERRCODE = '23514', HINT = 'tax_settlement_immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_tax_settlement_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_tax_settlements_immutable ON public.tax_settlements;
CREATE TRIGGER trigger_tax_settlements_immutable
  BEFORE UPDATE ON public.tax_settlements
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_tax_settlement_immutable();

ALTER TABLE public.tax_settlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tax_settlements_select_own_tenant" ON public.tax_settlements;
CREATE POLICY "tax_settlements_select_own_tenant"
  ON public.tax_settlements
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "tax_settlements_insert_owner_admin" ON public.tax_settlements;
CREATE POLICY "tax_settlements_insert_owner_admin"
  ON public.tax_settlements
  FOR INSERT
  TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "tax_settlements_update_owner_admin" ON public.tax_settlements;
CREATE POLICY "tax_settlements_update_owner_admin"
  ON public.tax_settlements
  FOR UPDATE
  TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  )
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

REVOKE ALL ON public.tax_settlements FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.tax_settlements TO authenticated;
GRANT INSERT (tenant_id, okres, rodzaj, wersja, kwota_gr, termin, migawka, parametry_wersja, wejscia_hash)
  ON public.tax_settlements TO authenticated;
GRANT UPDATE (status, zaplacone_o) ON public.tax_settlements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tax_settlements TO service_role;

NOTIFY pgrst, 'reload schema';
