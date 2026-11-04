/**
 * Wiersz podsumowania odpytywania KSeF w `audit_logs` (EXT-03, sesja 26 planu
 * skalowania).
 *
 * Odpytywanie (strony skrzynki, status faktury po wysyłce) idzie przez
 * `ksefFetch` z `audit.when: 'error'`: osobny wiersz dostaje tylko odpowiedź
 * spoza 2xx, timeout i błąd sieci. Zwykła odpowiedź niczego nie zmienia,
 * a wiersz na każde żądanie dawał przy 2000 firm ok. 6,5 mln wierszy
 * miesięcznie. Zamiast tego wywołujący zapisuje jeden wiersz na zmianę:
 *   - `inbox.poll` — przebieg skrzynki, który dodał faktury (liczba, strony, okno),
 *   - `invoice.poll` — rozstrzygnięte odpytanie statusu jednej faktury
 *     (liczba prób, czas, wynik, kod statusu KSeF).
 * Ta sama akcja co wiersze błędów, z `metadata.summary = true`.
 *
 * Nie rzuca: błąd zapisu audytu nie przerywa operacji (jak `recordKsefAudit`
 * w `./client`). Import dynamiczny z tego samego powodu co tam.
 */
export async function recordKsefPollSummary(entry: {
  tenantId: string;
  action: 'inbox.poll' | 'invoice.poll';
  invoiceId?: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    const { logAuditSystem } = await import('@/lib/audit/log-system');
    await logAuditSystem({
      action: entry.action === 'inbox.poll' ? 'ksef.inbox.poll' : 'ksef.invoice.poll',
      tenantId: entry.tenantId,
      userId: null,
      entityType: entry.invoiceId ? 'invoice' : 'ksef',
      entityId: entry.invoiceId,
      metadata: { ...entry.metadata, summary: true },
    });
  } catch (e) {
    console.error('[ksef.audit] poll summary failed', e);
  }
}
