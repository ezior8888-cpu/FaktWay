/**
 * Dni na wycofanie żądania usunięcia konta. Osobny moduł bez importów
 * serwerowych: czytają go też dokumenty prawne (polityka prywatności),
 * które nie powinny ciągnąć za sobą klienta bazy danych.
 */
export const GDPR_COOLING_OFF_DAYS = 14;
