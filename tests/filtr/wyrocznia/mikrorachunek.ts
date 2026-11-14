// Wyrocznia z czystego pokoju (żelazny filtr F6), napisana 14.11.2026 przez
// osobną sesję wyłącznie na podstawie tests/filtr/wyrocznia/SPEC-mikrorachunek.md,
// bez dostępu do kodu aplikacji. Niczego nie importuje z aplikacji.
// Zmiana tego pliku jest zmianą wiedzy filtra (zgoda:wiedza-prawna).

const CYFRY = /^[0-9]+$/;

// Dokładnie n cyfr 0-9 (bez spacji i innych znaków).
function tylkoCyfry(s: string, n: number): boolean {
  return typeof s === "string" && s.length === n && CYFRY.test(s);
}

// Reszta z dzielenia przez 97 na BigInt (bez literałów 97n).
function mod97(cyfry: string): number {
  return Number(BigInt(cyfry) % BigInt(97));
}

export function nipPoprawny(nip: string): boolean {
  if (!tylkoCyfry(nip, 10)) return false;
  const wagi = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  let suma = 0;
  for (let i = 0; i < 9; i++) suma += wagi[i] * Number(nip[i]);
  const r = suma % 11;
  return r !== 10 && r === Number(nip[9]);
}

export function mikrorachunekZNip(nip: string): string | null {
  if (!nipPoprawny(nip)) return null;
  const bez = "10100071" + "222" + "2" + nip + "00"; // 24 cyfry
  const r = mod97(bez + "2521" + "00");
  const lk = 98 - r;
  return (lk < 10 ? "0" : "") + String(lk) + bez;
}

export function nrbPoprawny(numer: string): boolean {
  if (!tylkoCyfry(numer, 26)) return false;
  return mod97(numer.slice(2) + "2521" + numer.slice(0, 2)) === 1;
}

export function czyMikrorachunekZNip(numer: string): boolean {
  if (!tylkoCyfry(numer, 26)) return false;
  return (
    numer.slice(2, 13) === "10100071222" &&
    numer[13] === "2" &&
    nipPoprawny(numer.slice(14, 24)) &&
    numer.slice(24, 26) === "00" &&
    nrbPoprawny(numer)
  );
}

export function zapisRachunku(numer: string): string {
  // Wątpliwość: SPEC mówi, że wejście to 26 cyfr, ale nie opisuje innych
  // napisów. Najostrożniej: zwracamy wejście bez zmian, nie zgadujemy grup.
  if (!tylkoCyfry(numer, 26)) return numer;
  const grupy: string[] = [];
  for (let i = 2; i < 26; i += 4) grupy.push(numer.slice(i, i + 4));
  return numer.slice(0, 2) + " " + grupy.join(" ");
}
