-- ═══════════════════════════════════════════════════════════════
-- 00205: koszt dopasowany regułą globalną daje się zapisać (ustalenie 738u1,
-- obchód M9 aplikacji mobilnej, 14.11.2026)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem, w dowolnej chwili (addytywna). Kod na
-- produkcji już wysyła obie wartości, więc sama migracja usuwa błąd, bez
-- wdrożenia. Bez DROP tabel i kolumn, bez zmiany istniejących danych.
--
-- Klasyfikator kosztu (lib/categorization/rule-engine.ts, od 06.05.2026)
-- zwraca `rule_global_nip` (NIP sprzedawcy z kpir_global_rules) albo
-- `rule_global_keyword` (słowo z nazwy sprzedawcy: Stacja, Orlen, Orange,
-- Hotel, Uber, Allegro...). Enum z 00034 tych wartości nie zna, więc INSERT
-- do `expenses` w jobach process-ocr (zdjęcie paragonu albo faktury)
-- i auto-categorize-inbox (faktura kosztowa z KSeF) padał błędem 22P02
-- „invalid input value for enum categorization_method”. Job ponawiał się
-- (3 przebiegi), a w OCR każdy przebieg płacił za odczyt modelu od nowa.
--
-- ALTER TYPE ... ADD VALUE w transakcji (wgraj-migracje.sh: jedna transakcja
-- na plik) działa od Postgresa 12; nowej wartości nie wolno UŻYĆ w tej samej
-- transakcji, a ten plik jej nie używa. IF NOT EXISTS: ponowne wgranie nic
-- nie zmienia.
--
-- Po wgraniu:
--   SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
--    WHERE t.typname = 'categorization_method' ORDER BY e.enumsortorder;
--   -- oczekiwane: osiem wartości, na końcu rule_global_nip, rule_global_keyword
-- ═══════════════════════════════════════════════════════════════

ALTER TYPE public.categorization_method ADD VALUE IF NOT EXISTS 'rule_global_nip';
ALTER TYPE public.categorization_method ADD VALUE IF NOT EXISTS 'rule_global_keyword';
