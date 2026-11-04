/** Urządzenie na liście: to oddają końcówki i to dostaje karta w ustawieniach. */
export interface PasskeyDevice {
  id: string;
  deviceLabel: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}
