/**
 * Numery rachunków z wyciągów (krok 3.2). Jeden zapis dla wszystkich formatów:
 * polski rachunek to `PL` + 26 cyfr (MT940 podaje „/PL…”, CSV PKO BP sam NRB,
 * ING dodaje spację), rachunek z innego kraju to IBAN wielkimi literami bez spacji.
 * Sum kontrolnych nie sprawdzamy: numer pochodzi z banku, a zły numer
 * kontrahenta najwyżej nie trafi w klucz duplikatu.
 */

/** `null`, gdy napis nie wygląda na numer rachunku (za krótki, znaki spoza liter i cyfr). */
export function rachunekZnormalizowany(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/[\s\u00A0/-]/g, '').toUpperCase();
  if (/^\d{26}$/.test(compact)) return `PL${compact}`;
  if (/^PL\d{26}$/.test(compact)) return compact;
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(compact)) return compact;
  return null;
}

/**
 * NRB z 8-cyfrowego numeru rozliczeniowego banku i 16-cyfrowego numeru rachunku
 * (podpola ~30 i ~31 MT940). Cyfry kontrolne jak w IBAN: 98 minus reszta z dzielenia
 * przez 97 liczby „bank + rachunek + PL00” (P = 25, L = 21).
 */
export function nrbZNumeruBankuIRachunku(bank: string, account: string): string | null {
  if (!/^\d{8}$/.test(bank) || !/^\d{16}$/.test(account)) return null;
  const digits = `${bank}${account}252100`;
  let rest = 0;
  for (const ch of digits) rest = (rest * 10 + Number(ch)) % 97;
  return `PL${String(98 - rest).padStart(2, '0')}${bank}${account}`;
}
