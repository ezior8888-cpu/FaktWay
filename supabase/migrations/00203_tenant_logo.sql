-- 00203: logo firmy na wydruku (plan kompletnej aplikacji, krok 2.2, część 1:
-- logo w nagłówku PDF faktury, proformy i oferty).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem (addytywna: nowa kolumna NULL, CHECK na nowej
-- kolumnie, GRANT SELECT, wyzwalacz tylko dla zmiany nowej kolumny). Kod czyta
-- kolumnę odpornie (brak kolumny = brak logo, wydruk jak dotąd, sekcja
-- w ustawieniach z komunikatem), ale wgranie logo wymaga kolumny.
--
-- Po co: `tenants.logo_storage_key` wskazuje plik logo w magazynie. NULL = bez
-- logo (stan każdej istniejącej firmy). Plik zapisuje i usuwa aplikacja
-- (`lib/invoices/logo-firmy.ts`, `lib/storage/logo.ts`); wydruk czyta go
-- kluczem serwisowym magazynu, więc klucz w wierszu decyduje, czyj plik trafi
-- na PDF. Stąd dwie blokady:
--
--  1. CHECK `tenants_logo_storage_key_check`: klucz tylko w katalogu logo tej
--     firmy, `tenants/<id firmy>/logo/<uuid>.png|jpg` (małe litery, bez `..`),
--     także dla klucza serwisowego. Ten sam wzór sprawdza `isTenantLogoKey`.
--  2. Wyzwalacz `guard_tenant_logo_storage_key` (wzór z 00117 dla pól
--     certyfikatu): polityka `tenants_update_own_owner` daje właścicielowi
--     UPDATE całego wiersza, ale kolumny logo sesja klienta (anon,
--     authenticated) nie zmieni. Zapis idzie tylko kluczem serwisowym, po
--     sprawdzeniu roli właściciela albo administratora i samego pliku, razem
--     z audytem i sprzątaniem magazynu.
--
-- Uprawnienia: od 00112 rola `authenticated` czyta kolumny `tenants` tylko po
-- jawnym GRANT SELECT (pilnuje tests/unit/dane-ksef-uprawnienia-kolumn.test.ts):
-- członek firmy czyta klucz do podglądu w ustawieniach. Bez nowych uprawnień
-- UPDATE. Usuwanie firmy zamiata prefiks `tenants/<id>/` w magazynie
-- (docs/prawne/usuwanie-firmy-projekt.md, § 6.5).
--
-- Bez DROP tabel i kolumn, bez zmian istniejących wierszy. Test na bazie:
-- tests/rls-logo-firmy.test.ts.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS logo_storage_key TEXT;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_logo_storage_key_check;

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_logo_storage_key_check
  CHECK (
    logo_storage_key IS NULL
    OR logo_storage_key ~ (
      '^tenants/' || id::text
      || '/logo/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$'
    )
  );

GRANT SELECT (logo_storage_key) ON public.tenants TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_tenant_logo_storage_key()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' AND NEW.logo_storage_key IS NOT NULL THEN
      RAISE EXCEPTION 'tenant_logo_requires_trusted_server' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.logo_storage_key IS DISTINCT FROM OLD.logo_storage_key THEN
      RAISE EXCEPTION 'tenant_logo_requires_trusted_server' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_tenant_logo_storage_key()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_guard_tenant_logo_storage_key ON public.tenants;
CREATE TRIGGER trigger_guard_tenant_logo_storage_key
  BEFORE INSERT OR UPDATE OF logo_storage_key ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_logo_storage_key();

COMMENT ON COLUMN public.tenants.logo_storage_key IS
  'Logo firmy na wydruku PDF (krok 2.2): klucz pliku w magazynie, tenants/<id>/logo/<uuid>.png|jpg. NULL = bez logo. Zmienia tylko serwer (wyzwalacz guard_tenant_logo_storage_key).';

NOTIFY pgrst, 'reload schema';
