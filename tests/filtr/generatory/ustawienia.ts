import fc from 'fast-check';

/**
 * Ustawienia testów na losowych danych (żelazny filtr F5, plan B4.5).
 * W PR i lokalnie 300 przypadków na własność; w nocy `FILTR_PRZYPADKI=50000`
 * i losowe ziarno `FILTR_ZIARNO` (podawane w issue, żeby odtworzyć błąd).
 */
export const PRZYPADKI = Number(process.env.FILTR_PRZYPADKI ?? 300);
const ziarno = process.env.FILTR_ZIARNO;
export const ZIARNO = ziarno !== undefined && ziarno !== '' ? Number(ziarno) : undefined;

export function opcje(numRuns = PRZYPADKI): fc.Parameters<unknown> {
  return ZIARNO === undefined ? { numRuns } : { numRuns, seed: ZIARNO };
}
