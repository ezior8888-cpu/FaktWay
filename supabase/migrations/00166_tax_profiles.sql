-- ═══════════════════════════════════════════════════════════════
-- 00166: profil podatkowy firmy z historią (plan docs/koordynacja/
-- PLAN-KSIEGOWOSC-JDG.md, krok K2, decyzje D3 i D4)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa tabela, funkcja wyzwalacza
-- i polityki RLS; bez DROP tabel i kolumn, bez zmiany istniejących danych.
--
-- tax_profiles trzyma WERSJE profilu: jedna na dzień `valid_from` w firmie.
-- Profil obowiązujący w danym dniu to wersja z największym valid_from nie
-- późniejszym niż ten dzień (lib/ksiegowosc/profil.ts, wersjaNa). Wersji się
-- nie usuwa, bo rozliczenia za miniony okres muszą widzieć ustawienia z tamtego
-- czasu. Poprawka wersji z tym samym valid_from to UPDATE, a wpis w audit_logs
-- robi akcja serwerowa (app/actions/ksiegowosc-profil.ts).
--
-- Forma opodatkowania zmienia się tylko od 1 stycznia (plan, sekcja 6).
-- Pilnuje tego wyzwalacz: wersja z inną formą niż poprzednia, albo następna
-- wersja z inną formą niż ta, musi zaczynać się 1 stycznia. Pierwsza wersja
-- może zacząć się dowolnego dnia (start działalności w trakcie roku).
--
-- Status VAT zostaje w tenants.vat_exemption_basis (D3), bo używa go KSeF.
-- Stawka domyślna ryczałtu jest w punktach bazowych (1200 = 12 %), jak
-- parametry w lib/ksiegowosc/parametry; wybiera ją klient (D4).
--
-- RLS: odczyt dla członków firmy z sesji; INSERT i UPDATE tylko właściciel
-- i administrator (has_org_role z 00037); DELETE nie ma nikt poza
-- service_role.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.tax_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  valid_from DATE NOT NULL,
  forma TEXT NOT NULL,
  okres TEXT NOT NULL DEFAULT 'M',
  stawka_domyslna INTEGER,
  zus_etap TEXT NOT NULL,
  zus_od DATE,
  chorobowe BOOLEAN NOT NULL DEFAULT FALSE,
  nrs_zus TEXT,
  created_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tax_profiles_tenant_valid_from_key UNIQUE (tenant_id, valid_from),
  -- Parametry modułu zaczynają się od 2026 r.
  CONSTRAINT tax_profiles_valid_from_check CHECK (valid_from >= DATE '2026-01-01'),
  CONSTRAINT tax_profiles_forma_check CHECK (forma IN ('ryczalt', 'skala', 'liniowy')),
  -- Rozliczenie kwartalne dopiero w kroku K9.
  CONSTRAINT tax_profiles_okres_check CHECK (okres = 'M'),
  -- CHECK odrzuca tylko FALSE, a `NULL IN (...)` daje NULL, więc przy
  -- ryczałcie stawka musi być jawnie NOT NULL (inaczej pusta przechodzi).
  CONSTRAINT tax_profiles_stawka_check CHECK (
    (forma = 'ryczalt' AND stawka_domyslna IS NOT NULL
      AND stawka_domyslna IN (300, 550, 850, 1000, 1200, 1400, 1500, 1700))
    OR (forma <> 'ryczalt' AND stawka_domyslna IS NULL)
  ),
  -- Mały ZUS Plus dopiero w kroku K9.
  CONSTRAINT tax_profiles_zus_etap_check CHECK (zus_etap IN ('ulga_na_start', 'preferencyjny', 'pelny', 'etat_obok')),
  -- Ulga na start i preferencyjne biegną od daty, więc ta data jest potrzebna.
  CONSTRAINT tax_profiles_zus_od_check CHECK (zus_etap NOT IN ('ulga_na_start', 'preferencyjny') OR zus_od IS NOT NULL),
  CONSTRAINT tax_profiles_nrs_zus_check CHECK (nrs_zus IS NULL OR nrs_zus ~ '^[0-9]{26}$')
);

COMMENT ON TABLE public.tax_profiles IS
  'Profil podatkowy firmy w wersjach po valid_from (plan księgowości JDG, K2, D3). '
  'Forma zmienia się tylko od 1 stycznia (wyzwalacz guard_tax_profile_form_change). '
  'Zapis: owner/admin z sesji; bez DELETE.';

-- Nowa wersja, która zmienia formę opodatkowania względem sąsiedniej, musi
-- zaczynać się 1 stycznia. HINT pozwala akcji odróżnić ten błąd od CHECK.
CREATE OR REPLACE FUNCTION public.guard_tax_profile_form_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  poprzednia_forma TEXT;
  nastepna RECORD;
BEGIN
  SELECT forma INTO poprzednia_forma
  FROM public.tax_profiles
  WHERE tenant_id = NEW.tenant_id
    AND valid_from < NEW.valid_from
    AND id <> NEW.id
  ORDER BY valid_from DESC
  LIMIT 1;

  IF poprzednia_forma IS NOT NULL
     AND poprzednia_forma <> NEW.forma
     AND to_char(NEW.valid_from, 'MM-DD') <> '01-01' THEN
    RAISE EXCEPTION 'Forma opodatkowania zmienia się tylko od 1 stycznia (wersja od %).', NEW.valid_from
      USING ERRCODE = '23514', HINT = 'tax_profile_form_change';
  END IF;

  SELECT valid_from, forma INTO nastepna
  FROM public.tax_profiles
  WHERE tenant_id = NEW.tenant_id
    AND valid_from > NEW.valid_from
    AND id <> NEW.id
  ORDER BY valid_from ASC
  LIMIT 1;

  IF FOUND
     AND nastepna.forma <> NEW.forma
     AND to_char(nastepna.valid_from, 'MM-DD') <> '01-01' THEN
    RAISE EXCEPTION 'Forma opodatkowania zmienia się tylko od 1 stycznia (wersja od %).', nastepna.valid_from
      USING ERRCODE = '23514', HINT = 'tax_profile_form_change';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_tax_profile_form_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_tax_profiles_form_change ON public.tax_profiles;
CREATE TRIGGER trigger_tax_profiles_form_change
  BEFORE INSERT OR UPDATE ON public.tax_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_tax_profile_form_change();

-- Auto-touch updated_at — `set_updated_at` istnieje z 00024.
DROP TRIGGER IF EXISTS trigger_tax_profiles_updated_at ON public.tax_profiles;
CREATE TRIGGER trigger_tax_profiles_updated_at
  BEFORE UPDATE ON public.tax_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.tax_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tax_profiles_select_own_tenant" ON public.tax_profiles;
CREATE POLICY "tax_profiles_select_own_tenant"
  ON public.tax_profiles
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "tax_profiles_insert_owner_admin" ON public.tax_profiles;
CREATE POLICY "tax_profiles_insert_owner_admin"
  ON public.tax_profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "tax_profiles_update_owner_admin" ON public.tax_profiles;
CREATE POLICY "tax_profiles_update_owner_admin"
  ON public.tax_profiles
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

REVOKE ALL ON public.tax_profiles FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.tax_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tax_profiles TO service_role;

NOTIFY pgrst, 'reload schema';
