/**
 * KSeF odrzucił uwierzytelnienie (status >= 400 na `/auth/{referenceNumber}`).
 * Komunikat zostaje jak dawniej (`KSeF auth failed: ...`), bo po nim klasyfikuje
 * błędy historia (`history-sync/errors.ts`); kod i szczegóły niesiemy osobno,
 * żeby kreator podłączenia mógł powiedzieć klientowi, co się stało (415 brak
 * uprawnień, 460 błąd certyfikatu). Treść tego błędu nigdy nie wraca do klienta.
 * Osobny plik, żeby klasyfikacja błędów nie ciągnęła za sobą biblioteki podpisu.
 */
export class KsefAuthRejectedError extends Error {
  constructor(
    public readonly code: number,
    public readonly description: string,
    public readonly details: readonly string[],
  ) {
    super(`KSeF auth failed: ${description}`);
    this.name = 'KsefAuthRejectedError';
  }
}
