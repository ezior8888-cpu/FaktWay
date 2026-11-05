-- ═══════════════════════════════════════════════════════════════
-- 00165: wyłącznik modułu księgowości JDG (plan docs/koordynacja/
-- PLAN-KSIEGOWOSC-JDG.md, krok K1, decyzje D10 i D11)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Migracja jest addytywna (nowa kolumna
-- z wartością domyślną i nowy wiersz flagi), bez DROP i bez zmiany danych.
-- Kod z K1 czyta kolumnę odpornie: przed migracją brak kolumny znaczy
-- „firma poza pilotażem”, a nie błąd (lib/ksiegowosc/wylacznik.ts).
--
-- 1. tenant_feature_flags.ksiegowosc_enabled: WŁĄCZENIE modułu dla
--    konkretnej firmy (pilotaż, warunek B6). Domyślnie FALSE, jak pozostałe
--    flagi tej tabeli (opt-in z 00031). Tabela ma GRANT SELECT na całość dla
--    authenticated i politykę „tylko swój wiersz”, więc nowa kolumna nie
--    potrzebuje osobnego grantu; zapis wyłącznie service_role.
-- 2. global_feature_flags.killKsiegowosc: globalny stop całego modułu.
--    Wiersz zakładamy wyłączony, gotowy do przestawienia jednym UPDATE-em
--    w czasie incydentu (wzór: killFloAgent z 00066).
--
-- Warstwa w kodzie (BLOKADY w lib/ksiegowosc/wylacznik.ts) stoi NAD obiema:
-- ksiegowosc_enabled = true nie włączy obszaru zablokowanego w kodzie.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.tenant_feature_flags
  ADD COLUMN IF NOT EXISTS ksiegowosc_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.tenant_feature_flags.ksiegowosc_enabled IS
  'Moduł księgowości JDG włączony dla firmy (pilotaż, plan księgowości JDG D10/D11). '
  'Domyślnie false; obszary zablokowane w kodzie (lib/ksiegowosc/wylacznik.ts) i tak '
  'pozostają wyłączone.';

INSERT INTO public.global_feature_flags (flag, enabled, note)
VALUES (
  'killKsiegowosc',
  false,
  'Zatrzymuje CAŁY moduł księgowości JDG (ewidencja, rozliczenia, przypomnienia, '
  'wysyłka JPK). Plan docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md, D10.'
)
ON CONFLICT (flag) DO NOTHING;

NOTIFY pgrst, 'reload schema';
