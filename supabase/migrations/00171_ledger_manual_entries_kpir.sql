-- ═══════════════════════════════════════════════════════════════
-- 00171: wpisy ręczne KPiR (plan docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md,
-- krok K7, decyzja D5)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa kolumna, zdjęte NOT NULL ze stawki
-- i nowe CHECK-i; bez DROP tabel i kolumn, bez zmiany istniejących danych
-- (każdy dotychczasowy wpis ma stawkę i nie ma kolumny, więc spełnia nowy
-- warunek).
--
-- ledger_manual_entries (00167) trzyma teraz dwa rodzaje wpisów:
-- - ewidencja przychodów ryczałtu (K3): `stawka_pb`, bez `kolumna`;
-- - KPiR przy skali i liniowym (K7): `kolumna` (K_7, K_8 przychód;
--   K_10-K_13 koszt), bez stawki. `data_przychodu` to wtedy dzień
--   zdarzenia gospodarczego (K_2), także kosztu.
-- Dokładnie jedno z dwóch pól jest wypełnione (CHECK). Ewidencja ryczałtu
-- czyta tylko wpisy ze stawką, KPiR tylko wpisy z kolumną.
--
-- RLS i polityki bez zmian (odczyt członkowie firmy, INSERT i DELETE
-- owner/admin); grant INSERT dostaje kolumnę `kolumna`.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.ledger_manual_entries ADD COLUMN IF NOT EXISTS kolumna TEXT;

ALTER TABLE public.ledger_manual_entries ALTER COLUMN stawka_pb DROP NOT NULL;

ALTER TABLE public.ledger_manual_entries DROP CONSTRAINT IF EXISTS ledger_manual_entries_kolumna_check;
ALTER TABLE public.ledger_manual_entries
  ADD CONSTRAINT ledger_manual_entries_kolumna_check CHECK (kolumna IS NULL OR kolumna IN ('k7', 'k8', 'k10', 'k11', 'k12', 'k13'));

-- Wpis ewidencji ma stawkę, wpis KPiR kolumnę; nigdy oba i nigdy żadne.
ALTER TABLE public.ledger_manual_entries DROP CONSTRAINT IF EXISTS ledger_manual_entries_rodzaj_ksiegi_check;
ALTER TABLE public.ledger_manual_entries
  ADD CONSTRAINT ledger_manual_entries_rodzaj_ksiegi_check CHECK ((kolumna IS NULL) = (stawka_pb IS NOT NULL));

COMMENT ON COLUMN public.ledger_manual_entries.kolumna IS
  'KPiR (K7): k7/k8 przychód, k10-k13 koszt; NULL przy wpisie ewidencji ryczałtu (ze stawką).';

GRANT INSERT (kolumna) ON public.ledger_manual_entries TO authenticated;

NOTIFY pgrst, 'reload schema';
