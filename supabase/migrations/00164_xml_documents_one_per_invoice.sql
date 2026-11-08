-- 00164_xml_documents_one_per_invoice.sql
--
-- C-12 (treść szkicu #190, dawna rezerwacja 00129): najwyżej jeden wiersz
-- xml_documents na fakturę w firmie. Wiersz to dowód pliku faktury (KOD I na
-- PDF, „Pobierz XML”, portal księgowej) z 10-letnią retencją. Sprawdzenie
-- w recordXmlDocument obsługuje ponowienia po kolei, ale nie dwa RÓWNOCZESNE
-- joby, które nie widzą jeszcze wiersza — te rozstrzyga dopiero indeks. Wzór:
-- 00146 (ten sam preflight, ta sama blokada).
--
-- WGRANIE: PRZED wdrożeniem (addytywna: sam indeks, bez zmian danych i uprawnień).
-- Stary kod działa z indeksem: przy przegranym wyścigu dostaje 23505, a oba
-- miejsca zapisu obsługują ten błąd bez cofania faktury (job wysyłki: Sentry,
-- akceptacja zostaje; import: ostrzeżenie). Wstrzymywanie procesów niepotrzebne.
--
-- PRZED: liczenie dubli (tylko odczyt) musi dać 0, inaczej preflight przerwie
-- migrację:
--   SELECT tenant_id, invoice_id, count(*) AS wierszy
--     FROM public.xml_documents
--    GROUP BY tenant_id, invoice_id
--   HAVING count(*) > 1;
-- Duble rozstrzyga Bartosz: właściwy wiersz to ten, którego sha256_hash równa
-- się request_payload_hash przyjętego wpisu w ksef_submissions tej faktury.
-- Ta migracja niczego nie usuwa ani nie wybiera „najnowszego”.
--
-- BLOKADA: SHARE na public.xml_documents do końca transakcji — odczyty działają,
-- zapisy czekają na zbudowanie indeksu. lock_timeout 5 s: przy zajętej tabeli
-- migracja pada (55P03) zamiast ustawiać za sobą kolejkę — powtórzyć później.
-- Bez CONCURRENTLY (nie działa w transakcji). Ostrzeżenia psql o transakcji
-- przy --single-transaction są oczekiwane, jak przy 00146.
--
-- PO: schema_migrations ('00164','xml_documents_one_per_invoice'), NOTIFY pgrst,
-- weryfikacja:
--   SELECT indisunique, indisvalid, pg_get_indexdef(indexrelid)
--     FROM pg_index
--    WHERE indexrelid = 'public.uq_xml_documents_tenant_invoice'::regclass;
-- types/database.ts bez zmian (indeks nie zmienia typów).
--
-- Wycofanie (bez utraty danych, za zgodą Bartosza):
--   DROP INDEX public.uq_xml_documents_tenant_invoice;
BEGIN;

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.xml_documents IN SHARE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT tenant_id, invoice_id
      FROM public.xml_documents
      GROUP BY tenant_id, invoice_id
      HAVING count(*) > 1
    ) AS duplicates
  ) THEN
    RAISE EXCEPTION 'xml_documents ma wiele wierszy dla jednej faktury: dowody wymagają uzgodnienia przed 00164 (zapytanie w nagłówku migracji)';
  END IF;
END;
$$;

CREATE UNIQUE INDEX uq_xml_documents_tenant_invoice
  ON public.xml_documents (tenant_id, invoice_id);

COMMENT ON INDEX public.uq_xml_documents_tenant_invoice IS
  'One XML evidence row per tenant and invoice (C-12); retries compare evidence instead of overwriting it.';

COMMIT;
