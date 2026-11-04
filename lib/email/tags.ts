/**
 * Znacznik Resend maili z ponagleniem wysyłanych do KONTRAHENTA klienta.
 * Webhook odbić i skarg po nim wie, że zdarzenie nie dotyczy użytkownika
 * FaktWay, nawet gdy kontrahent ma konto pod tym samym adresem (AUD-80).
 */
export const REMINDER_TAG = { name: 'kind', value: 'payment_reminder' } as const;
