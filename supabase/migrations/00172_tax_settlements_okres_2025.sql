-- ═══════════════════════════════════════════════════════════════
-- 00172: zapłata spoza wyliczenia także za 2025 r. (plan
-- docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md, krok K7.2, decyzja D15)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Sama zmiana warunku CHECK na luźniejszy
-- (DROP CONSTRAINT + ADD CONSTRAINT); bez DROP tabel i kolumn, bez zmiany
-- danych (każdy dotychczasowy wiersz ma okres od 2026 r., więc spełnia
-- nowy warunek).
--
-- Moduł liczy rozliczenia od 2026 r., ale składki za grudzień 2025 r.
-- płaci się w styczniu 2026 r. i wtedy pomniejszają podatek. Klient zapisuje
-- je jako zapłatę spoza wyliczenia (wersja rozliczenia z `migawka.reczna`,
-- kwota z PUE ZUS), więc okres takiej wersji może być w 2025 r. Wersje
-- wyliczane przez moduł dalej zaczynają się od 2026 r. (akcja zatwierdzenia
-- liczy tylko miesiące, które moduł liczy).
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.tax_settlements DROP CONSTRAINT IF EXISTS tax_settlements_okres_check;
ALTER TABLE public.tax_settlements
  ADD CONSTRAINT tax_settlements_okres_check CHECK (okres >= DATE '2025-01-01' AND EXTRACT(DAY FROM okres) = 1);

NOTIFY pgrst, 'reload schema';
