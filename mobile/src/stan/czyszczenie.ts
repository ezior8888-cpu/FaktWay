/**
 * Magazyny danych z konta poza `stan/faktury.tsx` (należności, księgowość,
 * ustawienia: `useSyncExternalStore` na poziomie modułu) rejestrują tu swoje
 * czyszczenie. Wylogowanie, „Zaloguj się na inne konto” i koniec sesji z
 * serwera (`sesja.tsx`, `wyczyscDane`) czyszczą je razem z resztą stanu, więc
 * kwoty, rachunek i NIP poprzedniego konta nie zostają w pamięci telefonu.
 * Osobny plik bez importów, żeby `sesja.tsx` nie importował magazynów (cykl przez `stan/dane`).
 */
const sprzatacze = new Set<() => void>();

export function czyscPrzyKoncuSesji(sprzatacz: () => void): void {
  sprzatacze.add(sprzatacz);
}

export function wyczyscMagazyny(): void {
  for (const s of sprzatacze) s();
}
