/**
 * Wersja API dla pojedynczych żądań związanych z BLIK-iem cyklicznym: tworzenia
 * Checkout z BLIK-iem i odczytu kodu odmowy. Globalna wersja klienta
 * (`lib/stripe/client.ts`) zostaje: od niej zależą kształty obiektów, które czytają
 * dowód płatności i webhooki (np. `invoice.payment_intent` zniknął w basil).
 * Dokumentacja BLIK-a cyklicznego i referencja Checkout opisują właśnie tę wersję,
 * a kody odmów BLIK-a są szczegółowe dopiero od niej (wcześniej `generic_decline`).
 */
export const BLIK_API_VERSION = '2026-09-30.endive';
