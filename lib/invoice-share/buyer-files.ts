import 'server-only';

import { NextResponse } from 'next/server';

import type { BuyerInvoiceResult } from '@/lib/invoice-share/buyer-invoice';
import { BUYER_PAGE_HEADERS } from '@/lib/invoice-share/policy';

/**
 * Odpowiedzi tras plików strony nabywcy (`/faktura/<token>/pdf` i `/xml`,
 * krok 2.10). Plik idzie z magazynu przez krótki podpisany adres: trasa
 * sprawdza link przy każdym kliknięciu i przekierowuje (303), więc adres
 * magazynu nie trafia do HTML strony, a po minucie przestaje działać.
 */

/** Ważność podpisanego adresu pliku: tyle, ile trzeba, by przeglądarka poszła za przekierowaniem. */
export const BUYER_FILE_URL_TTL_SECONDS = 60;

const TEXTS = {
  NOT_FOUND: 'Ten link nie działa. Mógł wygasnąć albo sprzedawca go cofnął. Poproś sprzedawcę o nowy link.',
  LIMITED: 'Za dużo otwarć z tego adresu. Spróbuj ponownie za kilka minut.',
  UNAVAILABLE: 'Plik jest chwilowo niedostępny. Spróbuj ponownie za kilka minut, a jeśli to się powtórzy, poproś sprzedawcę o fakturę e-mailem.',
} as const;

export function buyerFileText(status: number, message: string, extra: Record<string, string> = {}): NextResponse {
  return new NextResponse(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...BUYER_PAGE_HEADERS, ...extra },
  });
}

export const buyerFileNotFound = () => buyerFileText(404, TEXTS.NOT_FOUND);
export const buyerFileUnavailable = () => buyerFileText(503, TEXTS.UNAVAILABLE);

/** Odmowa dla wyniku odczytu innego niż `ok`: 404, 429 z `Retry-After` albo 503. */
export function buyerFileRefusal(result: Exclude<BuyerInvoiceResult, { status: 'ok' }>): NextResponse {
  if (result.status === 'limited') {
    return buyerFileText(429, TEXTS.LIMITED, { 'Retry-After': String(Math.max(1, Math.ceil(result.retryAfter))) });
  }
  if (result.status === 'unavailable') return buyerFileUnavailable();
  return buyerFileNotFound();
}

/** 303 na podpisany adres magazynu, z nagłówkami prywatnej strony (bez Referer z tokenem). */
export function buyerFileRedirect(signedUrl: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: signedUrl, ...BUYER_PAGE_HEADERS } });
}

/** Nazwa pliku do pobrania: numer faktury bez znaków spoza ASCII (`FV/1/2026` → `FV-1-2026`). */
export function buyerDownloadName(number: string | null, extension: 'xml' | 'pdf'): string {
  const base = (number ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'faktura';
  return `${base}.${extension}`;
}

/** Parametr trasy jako token; zły zapis procentowy to pusty token (odczyt odpowie „link nie działa”). */
export function buyerTokenParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}
