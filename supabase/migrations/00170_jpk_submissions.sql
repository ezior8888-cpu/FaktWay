-- ═══════════════════════════════════════════════════════════════
-- 00170: wysyłki JPK do MF (plan docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md,
-- krok K6, sekcja 10, decyzja D9)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa tabela, indeksy, funkcja wyzwalacza
-- i polityki RLS; bez DROP tabel i kolumn, bez zmiany istniejących danych.
--
-- jpk_submissions: jedna wysyłka pliku JPK do bramki MF. Wiersz powstaje
-- PRZED wysłaniem (stan „wysylanie”), więc przerwana wysyłka zostawia ślad.
-- Po FinishUpload dostaje numer referencyjny MF („w_toku”), a status MF
-- daje „przyjeta” z UPO w magazynie albo „odrzucona” z kodem i opisem.
--
-- Danych autoryzujących (D9) ani samego pliku tu nie ma: plik ma imię,
-- nazwisko i datę urodzenia, których FaktWay nie zapisuje (jak JPK_EWP
-- w K3). Zostaje skrót SHA-256 pliku (ten sam co w metadanych MF) i kwoty
-- deklaracji: P_62 przyjętej deklaracji to P_39 następnego miesiąca.
--
-- Jedna wysyłka w toku na firmę, okres i rodzaj (indeks częściowy): drugie
-- kliknięcie albo druga karta nie wyśle pliku drugi raz. Wiersz „wysylanie”
-- starszy niż 15 minut akcja zamyka jako „przerwana” przed nową wysyłką.
--
-- Przejścia stanów pilnuje wyzwalacz: wysylanie → w_toku | odrzucona |
-- przerwana; w_toku → w_toku | przyjeta | odrzucona; przyjeta, odrzucona
-- i przerwana są końcowe. Pola wysyłki (okres, plik, deklaracja, autor)
-- i nadany numer referencyjny są niezmienne.
--
-- RLS: odczyt dla członków firmy; INSERT i UPDATE owner/admin (has_org_role
-- z 00037) z grantami kolumnowymi; DELETE tylko service_role.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.jpk_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Pierwszy dzień miesiąca, za który jest plik.
  okres DATE NOT NULL,
  rodzaj TEXT NOT NULL,
  -- CelZlozenia z pliku: 1 złożenie, 2 korekta.
  cel SMALLINT NOT NULL,
  srodowisko TEXT NOT NULL,
  -- SHA-256 pliku XML w Base64; po nim MF rozpoznaje duplikaty.
  skrot_pliku TEXT NOT NULL,
  -- Część deklaracyjna w pełnych złotych: {"P_38", "P_39", "P_48", "P_51", "P_62"}.
  deklaracja JSONB NOT NULL,
  stan TEXT NOT NULL DEFAULT 'wysylanie',
  numer_referencyjny TEXT,
  -- Ostatni status MF (2.2.4 specyfikacji) albo kod odmowy InitUploadSigned.
  status_kod INTEGER,
  status_opis TEXT,
  -- Klucz UPO w magazynie (lib/storage/r2.ts), tylko przy „przyjeta”.
  upo_sciezka TEXT,
  blad TEXT,
  wyslal UUID DEFAULT auth.uid(),
  utworzono_o TIMESTAMPTZ NOT NULL DEFAULT now(),
  wyslano_o TIMESTAMPTZ,
  sprawdzono_o TIMESTAMPTZ,
  zakonczono_o TIMESTAMPTZ,
  -- JPK_V7M(3) obowiązuje od rozliczenia za luty 2026 r.
  CONSTRAINT jpk_submissions_okres_check CHECK (okres >= DATE '2026-02-01' AND EXTRACT(DAY FROM okres) = 1),
  CONSTRAINT jpk_submissions_rodzaj_check CHECK (rodzaj IN ('JPK_V7M')),
  CONSTRAINT jpk_submissions_cel_check CHECK (cel IN (1, 2)),
  CONSTRAINT jpk_submissions_srodowisko_check CHECK (srodowisko IN ('test', 'produkcja')),
  CONSTRAINT jpk_submissions_skrot_check CHECK (skrot_pliku ~ '^[A-Za-z0-9+/]{43}=$'),
  CONSTRAINT jpk_submissions_deklaracja_check CHECK (jsonb_typeof(deklaracja) = 'object'),
  CONSTRAINT jpk_submissions_stan_check CHECK (stan IN ('wysylanie', 'w_toku', 'przyjeta', 'odrzucona', 'przerwana')),
  CONSTRAINT jpk_submissions_numer_check CHECK (numer_referencyjny IS NULL OR numer_referencyjny ~ '^[0-9A-Za-z]{16,64}$'),
  -- Stan po FinishUpload zawsze z numerem, a UPO dokładnie przy „przyjeta”.
  CONSTRAINT jpk_submissions_numer_stan_check CHECK (stan NOT IN ('w_toku', 'przyjeta') OR numer_referencyjny IS NOT NULL),
  CONSTRAINT jpk_submissions_upo_check CHECK ((stan = 'przyjeta') = (upo_sciezka IS NOT NULL)),
  CONSTRAINT jpk_submissions_opis_check CHECK (status_opis IS NULL OR char_length(status_opis) <= 1000),
  CONSTRAINT jpk_submissions_blad_check CHECK (blad IS NULL OR char_length(blad) <= 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS jpk_submissions_jedna_w_toku
  ON public.jpk_submissions (tenant_id, okres, rodzaj)
  WHERE stan IN ('wysylanie', 'w_toku');

CREATE INDEX IF NOT EXISTS jpk_submissions_firma_okres
  ON public.jpk_submissions (tenant_id, okres);

COMMENT ON TABLE public.jpk_submissions IS
  'Wysyłki JPK do bramki MF (plan księgowości JDG, K6, D9): stan, numer referencyjny, status i UPO. '
  'Bez danych autoryzujących i bez pliku; przejścia stanów: wyzwalacz guard_jpk_submission.';

CREATE OR REPLACE FUNCTION public.guard_jpk_submission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.okres IS DISTINCT FROM OLD.okres
     OR NEW.rodzaj IS DISTINCT FROM OLD.rodzaj
     OR NEW.cel IS DISTINCT FROM OLD.cel
     OR NEW.srodowisko IS DISTINCT FROM OLD.srodowisko
     OR NEW.skrot_pliku IS DISTINCT FROM OLD.skrot_pliku
     OR NEW.deklaracja IS DISTINCT FROM OLD.deklaracja
     OR NEW.wyslal IS DISTINCT FROM OLD.wyslal
     OR NEW.utworzono_o IS DISTINCT FROM OLD.utworzono_o
     OR (OLD.numer_referencyjny IS NOT NULL AND NEW.numer_referencyjny IS DISTINCT FROM OLD.numer_referencyjny) THEN
    RAISE EXCEPTION 'Wysłanego pliku nie zmienia się; nowa wysyłka to nowy wiersz.'
      USING ERRCODE = '23514', HINT = 'jpk_submission_immutable';
  END IF;
  IF NOT (
    (OLD.stan = 'wysylanie' AND NEW.stan IN ('wysylanie', 'w_toku', 'odrzucona', 'przerwana'))
    OR (OLD.stan = 'w_toku' AND NEW.stan IN ('w_toku', 'przyjeta', 'odrzucona'))
  ) THEN
    RAISE EXCEPTION 'Wysyłka w stanie % nie przechodzi w stan %.', OLD.stan, NEW.stan
      USING ERRCODE = '23514', HINT = 'jpk_submission_transition';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_jpk_submission() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_jpk_submissions_guard ON public.jpk_submissions;
CREATE TRIGGER trigger_jpk_submissions_guard
  BEFORE UPDATE ON public.jpk_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_jpk_submission();

ALTER TABLE public.jpk_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "jpk_submissions_select_own_tenant" ON public.jpk_submissions;
CREATE POLICY "jpk_submissions_select_own_tenant"
  ON public.jpk_submissions
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "jpk_submissions_insert_owner_admin" ON public.jpk_submissions;
CREATE POLICY "jpk_submissions_insert_owner_admin"
  ON public.jpk_submissions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "jpk_submissions_update_owner_admin" ON public.jpk_submissions;
CREATE POLICY "jpk_submissions_update_owner_admin"
  ON public.jpk_submissions
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

REVOKE ALL ON public.jpk_submissions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.jpk_submissions TO authenticated;
GRANT INSERT (tenant_id, okres, rodzaj, cel, srodowisko, skrot_pliku, deklaracja)
  ON public.jpk_submissions TO authenticated;
GRANT UPDATE (stan, numer_referencyjny, status_kod, status_opis, upo_sciezka, blad, wyslano_o, sprawdzono_o, zakonczono_o)
  ON public.jpk_submissions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jpk_submissions TO service_role;

NOTIFY pgrst, 'reload schema';
