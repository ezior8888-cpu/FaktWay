-- ═══════════════════════════════════════════════════════════════
-- 00197: wpis w dzwonku przy wpłacie do faktury sprzedaży (plan
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 8.1, część 3)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem, po 00192 (rozszerza listę rodzajów
-- app_notifications z 00188 i 00192). Tylko zmiana jednego CHECK-a; bez DROP
-- tabel i kolumn, bez nowych funkcji, bez zmiany istniejących danych. Bez tej
-- migracji kolejka invoice.payment.received.bell dostaje odmowę CHECK-a
-- i wyczerpuje ponowienia: zapis wpłaty, push „Otrzymana płatność” i reszta
-- aplikacji działają bez zmian, tylko dzwonek nie pokazuje wpłaty.
--
-- ZMIANA CHECK: app_notifications_kind_check dostaje rodzaj payment_received
-- (wpłata zapisana przy fakturze: „Otrzymana płatność” albo „Wpłata częściowa”).
-- Zapisuje go zadanie przez app_notification_publish z 00188 (wpis dla każdego
-- aktywnego członka firmy), klucz obiektu to identyfikator wpłaty, więc
-- ponowienie zadania trafia w UNIQUE z 00188 i nie dubluje wpisu.
-- DROP CONSTRAINT IF EXISTS i ADD CONSTRAINT z tą samą nazwą i pełną listą:
-- cztery rodzaje z 00188 i dwa z 00192 bez zmian plus jeden nowy. Istniejące
-- wiersze mają rodzaje z 00188 i 00192, więc spełniają nowy warunek
-- (sprawdzenie przy ADD CONSTRAINT niczego nie odrzuci; krótka blokada
-- app_notifications na czas przejścia po wierszach). Kto dopisze kolejny rodzaj,
-- bierze pełną listę z tej migracji (pilnuje tego test koszt-watek-migracja).
--
-- Po wgraniu:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'app_notifications_kind_check';
--   -- oczekiwane: siedem rodzajów, w tym payment_received
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.app_notifications
  DROP CONSTRAINT IF EXISTS app_notifications_kind_check,
  ADD CONSTRAINT app_notifications_kind_check CHECK (kind IN ('inbox_new', 'invoice_accepted', 'invoice_rejected', 'tax_deadline', 'expense_comment', 'expense_document_request', 'payment_received'));
