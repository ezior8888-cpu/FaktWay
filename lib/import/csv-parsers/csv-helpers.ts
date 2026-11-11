/**
 * Wspólne parsowanie kwot, dat i NIP dla importów CSV.
 */

import { todayInWarsaw } from '@/lib/format/warsaw-date';

/**
 * Kwota z pola CSV. Zapis polski (1.234,56, 1 234,56, 1.234) i angielski
 * (1,234.56), także z minusem (S-10). Import zapisuje kwoty w PLN: kwota
 * oznaczona inną walutą jest odczytana, ale z ostrzeżeniem w `warnings`,
 * żeby klient sprawdził szkic przed zapisem. `kropkaTysiecy: false` dla
 * ilości i cen z pozycji (tam „1.500” to półtora, nie tysiąc pięćset).
 */
export function parseAmount(
  value: string | undefined,
  options?: { warnings?: string[]; fieldLabel?: string; kropkaTysiecy?: boolean },
): number {
  if (!value) return 0;
  const waluta = /\b(EUR|USD|GBP|CHF|CZK)\b/i.exec(value)?.[1]?.toUpperCase();
  if (waluta) {
    options?.warnings?.push(
      `${options.fieldLabel ?? 'Kwota'}: kwota w ${waluta} („${value.trim()}”); import zapisuje kwoty w PLN, więc szkic trzeba sprawdzić przed zapisem`,
    );
  }
  let s = value
    .replace(/PLN|zł|EUR|USD|GBP|CHF|CZK/gi, '')
    .replace(/\s/g, '')
    .trim();
  const znak = s.startsWith('-') ? -1 : 1;
  s = s.replace(/^[-+]/, '');

  if (/^\d{1,3}(\.\d{3})*,\d+$/.test(s)) {
    // Polski: 1.234,56 albo 1234,56
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(,\d{3})*\.\d+$/.test(s) && s.includes(',')) {
    // Angielski: 1,234.56
    s = s.replace(/,/g, '');
  } else if (options?.kropkaTysiecy !== false && /^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) {
    // Polski bez groszy: 1.234 to tysiąc dwieście trzydzieści cztery, nie 1,234
    // (kwoty pieniężne nie mają trzech miejsc po przecinku).
    s = s.replace(/\./g, '');
  } else {
    s = s.replace(',', '.');
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? znak * n : 0;
}

/**
 * Zamiana typowych formatów PL/ISO na YYYY-MM-DD.
 * Przy niepowodzeniu wraca przez `fallback` lub dzisiejszą datę i dopisuje ostrzeżenie.
 */
export function parseDate(
  value: string | undefined,
  options?: {
    warnings?: string[];
    fieldLabel?: string;
    fallbackISO?: string;
  },
): string {
  const warn = options?.warnings;
  const label = options?.fieldLabel ?? 'Data';

  if (!value?.trim()) {
    const fb = options?.fallbackISO ?? todayInWarsaw();
    warn?.push(`${label}: pusta wartość — przyjęto ${fb}`);
    return fb;
  }

  const v = value.trim();

  const ddmmyyyy = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return v;
  }

  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    // Dzień w Polsce, nie w UTC (S-10): 23:30 UTC 15.03 to już 16.03 w Warszawie.
    return todayInWarsaw(d);
  }

  const fb = options?.fallbackISO ?? todayInWarsaw();
  warn?.push(`${label}: nie rozpoznano „${v}” — przyjęto ${fb}`);
  return fb;
}

/** NIP PL — dokładnie 10 cyfr (bez prefiksu PL). */
export function cleanNip(value: string): string | undefined {
  const digits = value.replace(/\D/g, '');
  return digits.length === 10 && /^\d{10}$/.test(digits) ? digits : undefined;
}
