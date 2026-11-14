-- ═══════════════════════════════════════════════════════════════
-- 00204: licznik użyć produktu z katalogu przy zapisie faktury (plan
-- kompletnej aplikacji, docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md,
-- krok 2.6 „Produkty i usługi w formularzu”).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem kodu. Addytywna: jedna nowa funkcja, bez
-- zmian tabel, polityk i indeksów. Stara wersja aplikacji funkcji nie woła.
-- Nowa wersja bez funkcji (PostgREST: PGRST202) zapisuje fakturę jak dotąd
-- i zostawia tylko ostrzeżenie w logu (`[produkty] licznik użyć`).
-- DROP/DML: brak. Bez DROP, TRUNCATE, DELETE i UPDATE przy wgraniu:
-- dotychczasowe liczniki zostają (do dziś zwiększał je tylko import).
--
-- Po co: `products.use_count` i `last_used_at` (00013) ustalają kolejność
-- podpowiedzi produktów i blokują usunięcie produktu użytego na fakturach
-- (`deleteProductAction` w app/actions/produkty.ts: warunek `use_count = 0`
-- także w samym DELETE). Faktura zapisana z formularza ich nie zwiększała,
-- więc produkt użyty na fakturze dało się usunąć, a podpowiedź nie wiedziała,
-- co jest w użyciu.
--
-- product_usage_record(p_lines jsonb) RETURNS integer
--   Wejście: tablica JSON obiektów {"name": tekst, "unit": tekst}, czyli
--   nazwa i jednostka pozycji zapisanej faktury. Najwyżej 1000 elementów,
--   nazwa do 512 znaków, jednostka do 256 (granice pól nazwy i miary pozycji
--   w schemacie FA(3): TZnakowy512 i TZnakowy). Inne wejście: odmowa 22023
--   bez zmian.
--   Działanie: w aktywnej firmie (public.get_current_tenant_id(): nagłówek
--   x-active-org i aktywne członkostwo zalogowanego, 00037) każdy produkt,
--   którego klucz katalogu pasuje do pary nazwa + jednostka którejś pozycji,
--   dostaje use_count + 1 i last_used_at = now(). Klucz to te same wyrażenia
--   co indeks uq_products_tenant_catalog_key (00186): nazwa bez skrajnych
--   odstępów, odstępy zwinięte do jednej spacji, małe litery; jednostka bez
--   skrajnych odstępów, małe litery; każda część przez md5. Produkt, którego
--   indeks nie wpuści do katalogu drugi raz (23505), jest więc tym samym
--   produktem dla licznika, a zapytanie trafia w ten sam indeks. Aplikacja
--   przekazuje pary dokładnie tak, jak są w pozycjach, a klucz liczy tylko
--   baza (jedno miejsce normalizacji).
--   Produkt najwyżej raz na wywołanie: klucze z wejścia bez powtórzeń, a
--   wiersz katalogu jest unikalny po kluczu. Produkty archiwalne też (historia
--   użycia; archiwum chowa tylko podpowiedź). Produkty innej firmy nigdy
--   (warunek firmy w zapytaniu i polityka RLS z 00013).
--   Atomowo: `use_count = use_count + 1` w jednym UPDATE, a wiersze są
--   blokowane po kolei według id. Dwa zapisy naraz z tymi samymi produktami
--   w innej kolejności nie zakleszczają się: drugi czeka i dolicza swoje +1.
--   Wynik: liczba zwiększonych produktów. Sesja bez aktywnej firmy: 42501.
--
-- Kto: każdy aktywny członek firmy (jak zapis faktury). SECURITY INVOKER:
-- funkcja nie daje nic ponad to, co sesja już ma. GRANT UPDATE na products
-- dla authenticated i polityka products_tenant_isolation (00013, FOR ALL,
-- tenant_id = get_current_tenant_id()) pozwalają zmienić licznik zwykłym
-- UPDATE przez PostgREST, więc SECURITY DEFINER omijałby RLS bez zysku
-- i wymagałby powtórzenia w ciele sprawdzenia firmy i członkostwa. Przy
-- INVOKER polityka RLS zostaje drugą warstwą obok warunku firmy w zapytaniu.
-- SET search_path = '' i nazwy z prefiksem schematu. EXECUTE tylko dla
-- authenticated: Supabase nadaje EXECUTE rolom anon i authenticated jawnie,
-- więc najpierw REVOKE (także PUBLIC i service_role), potem GRANT.
--
-- Ponowienie: funkcja nie ma klucza idempotencji, bo nikt jej nie ponawia.
-- Aplikacja woła ją raz, po udanym zapisie faktury z pozycjami. Drugi zapis
-- z tego samego otwarcia formularza (podwójne kliknięcie, ponowienie po
-- zerwanym połączeniu) baza odrzuca przed pozycjami (`invoice_number_request_done`,
-- 00199), więc licznika nie woła. Błąd funkcji nie cofa zapisu faktury.
--
-- PO WGRANIU (tylko odczyt):
--   SELECT p.prosecdef, p.proconfig,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'product_usage_record';
--   -- prosecdef false, proconfig {search_path=""}, anon false,
--   -- authenticated true, service_role false.
-- types/database.ts: dochodzi jedna funkcja (Functions); typy z produkcji
-- generuje koordynator po wgraniu.
--
-- Wycofanie (za zgodą Bartosza, bez utraty danych): najpierw kod, potem
-- usunięcie funkcji public.product_usage_record(jsonb).
-- Rejestr numerów: docs/koordynacja/CLAUDE-DO-CODEXA.md.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.product_usage_record(p_lines jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_updated integer;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'product_usage_record: brak aktywnej firmy w sesji'
      USING ERRCODE = '42501';
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'product_usage_record: p_lines musi być tablicą pozycji {name, unit}'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_lines) > 1000 THEN
    RAISE EXCEPTION 'product_usage_record: najwyżej 1000 pozycji w jednym wywołaniu, jest %', jsonb_array_length(p_lines)
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_lines) AS l(elem)
     WHERE jsonb_typeof(l.elem) IS DISTINCT FROM 'object'
        OR jsonb_typeof(l.elem -> 'name') IS DISTINCT FROM 'string'
        OR jsonb_typeof(l.elem -> 'unit') IS DISTINCT FROM 'string'
        OR char_length(l.elem ->> 'name') > 512
        OR char_length(l.elem ->> 'unit') > 256
  ) THEN
    RAISE EXCEPTION 'product_usage_record: każda pozycja to obiekt z tekstem name (do 512 znaków) i unit (do 256 znaków)'
      USING ERRCODE = '22023';
  END IF;

  -- Klucz katalogu: wyrażenia znak w znak jak w indeksie
  -- uq_products_tenant_catalog_key (00186), także po stronie wejścia.
  -- Blokady wierszy po kolei według id (`targets`), potem jeden UPDATE.
  WITH line_keys AS (
    SELECT DISTINCT
           md5(lower(btrim(regexp_replace(l.elem ->> 'name', '\s+', ' ', 'g')))) AS name_key,
           md5(lower(regexp_replace(l.elem ->> 'unit', '^\s+|\s+$', '', 'g'))) AS unit_key
      FROM jsonb_array_elements(p_lines) AS l(elem)
  ),
  targets AS (
    SELECT p.id
      FROM public.products AS p
      JOIN line_keys AS k
        ON md5(lower(btrim(regexp_replace(p.name, '\s+', ' ', 'g')))) = k.name_key
       AND md5(lower(regexp_replace(p.unit, '^\s+|\s+$', '', 'g'))) = k.unit_key
     WHERE p.tenant_id = v_tenant_id
     ORDER BY p.id
       FOR UPDATE OF p
  )
  UPDATE public.products AS p
     SET use_count = p.use_count + 1,
         last_used_at = now()
    FROM targets
   WHERE p.id = targets.id
     AND p.tenant_id = v_tenant_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

COMMENT ON FUNCTION public.product_usage_record(jsonb) IS
  '00204 (plan kompletnej aplikacji, krok 2.6): po zapisie faktury z pozycjami zwiększa use_count o 1 i ustawia last_used_at w produktach aktywnej firmy, których klucz katalogu (te same wyrażenia co uq_products_tenant_catalog_key z 00186) pasuje do pary nazwa + jednostka którejś pozycji; produkt najwyżej raz na wywołanie, archiwalne też, innej firmy nigdy. Wejście: tablica {name, unit}, najwyżej 1000, nazwa do 512, jednostka do 256 znaków (inaczej 22023). Bez aktywnej firmy 42501. SECURITY INVOKER (RLS z 00013), EXECUTE tylko authenticated. Wynik: liczba zwiększonych produktów.';

REVOKE ALL ON FUNCTION public.product_usage_record(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.product_usage_record(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
