// Cron: co godzinę szuka faktur po terminie i PROPONUJE ponaglenie.
//
// ZMIANA Z 24.08.2026 (krok 6 planu agenta FLO — spłata długu):
// do tej pory ten cron sam planował wysyłkę, a `send-reminder` sam wysyłał
// maila do kontrahenta — bez jednego kliknięcia człowieka. To łamie zasadę,
// na której stoi cały agent: nic nie wychodzi na zewnątrz w imieniu klienta
// bez jego decyzji. Nie chodzi o teorię — ponaglenie wysłane komuś, kto
// zapłacił trzy dni temu, kompromituje klienta przed jego własnym
// kontrahentem, a winą obciąży narzędzie.
//
// Od teraz cron tworzy PROPOZYCJĘ w `flo_proposals`. Mail wychodzi dopiero
// z kliknięcia człowieka, przez wykonawcę propozycji (krok 11 planu).
// Nie ma i nie będzie przełącznika „wysyłaj automatycznie", także
// w ustawieniach — to jest dokładnie ten przełącznik, o którym ktoś
// zapomni, że go włączył.

import type { JobContext } from '@/lib/jobs/registry';
import { computeFingerprint } from '@/lib/flo/fingerprint';
import { buildChaseProposal } from '@/lib/flo/functions/payment-chase';
import { createProposal } from '@/lib/flo/proposals';
import { forEachPageById } from '@/lib/pagination/keyset';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  decideNextReminder,
  findInvoicesRequiringReminders,
  type InvoiceForScheduling,
} from '@/lib/reminders/scheduler';

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 *
 * Kolejność (sesja 18 planu skalowania, DB-03, JOB-08): najpierw firmy
 * z włączonym Wkurzaczem, stronami ustawień po `id`, potem zaległe faktury
 * tylko tych firm, paczkami i stronami. Każda strona faktur jest
 * przetworzona, zanim przyjdzie następna. Do 13.11.2026 cron czytał
 * kandydatów wszystkich firm naraz (także firm z wyłączonymi ponagleniami
 * i bez ustawień) i trzymał całą listę w pamięci przed pierwszą decyzją.
 */
export async function runReminderScheduler({ step, logger }: JobContext) {
  const admin = createAdminClient();
  let tenants = 0;
  let processed = 0;
  let proposedCount = 0;
  let errors = 0;

  // Firmy z włączonym Wkurzaczem: odsiew w zapytaniu, zanim padnie pytanie
  // o jakąkolwiek fakturę. Brak wiersza ustawień = ponaglenia wyłączone (jak
  // w `decideNextReminder`). Decyzja per faktura i tak sprawdza ustawienia
  // jeszcze raz; tu tylko odsiew. Błąd strony rzuca: „nie wiem, kto ma
  // włączone” to nie „nikt”, inaczej awaria bazy wyglądałaby jak spokojna
  // godzina bez ponagleń.
  await forEachPageById<{ id: string; tenant_id: string }>(
    'przypomnienia: firmy z włączonymi ponagleniami',
    (afterId, limit) =>
      step.run('load-enabled-tenants', async () => {
        let query = admin.from('reminder_settings').select('id, tenant_id').eq('enabled', true);
        if (afterId) query = query.gt('id', afterId);
        return query.order('id', { ascending: true }).limit(limit);
      }),
    async (settings) => {
      tenants += settings.length;
      await findInvoicesRequiringReminders(
        settings.map((s) => s.tenant_id),
        async (invoices) => {
          for (const invoice of invoices) await processInvoice(invoice);
        },
      );
    },
  );

  if (errors > 0) {
    logger.error('Scheduler ponagleń: faktury z błędem', { errors, processed });
  }

  if (processed === 0) {
    return { tenants, processed: 0, proposed: 0, errors: 0, message: 'Brak kandydatów' };
  }

  return { tenants, processed, proposed: proposedCount, errors };

  async function processInvoice(invoice: InvoiceForScheduling): Promise<void> {
    processed++;
    try {
      const decision = await step.run(`decide-${invoice.id}`, async () => {
        return decideNextReminder(invoice);
      });

      if (!decision.shouldSend || !decision.stage || !decision.scheduledFor) {
        return;
      }

      const created = await step.run(`propose-${invoice.id}`, async () => {
        const stage = decision.stage!;
        const payload = { invoiceId: invoice.id, stage };

        // Odcisk liczymy TĄ SAMĄ drogą, którą policzy go re-walidacja przy
        // kliknięciu. Gdyby cron budował fakty po swojemu, a wykonawca po
        // swojemu, każda propozycja wyglądałaby na nieaktualną w chwili
        // otwarcia — i agent milczałby zawsze.
        // Odcisk trafia do propozycji przez `buildChaseProposal`; tutaj
        // potrzebujemy samych faktów do treści.
        const { state } = await computeFingerprint(
          'payment.chase',
          payload,
          invoice.tenant_id,
        );

        // ROZ: do zapłaty jest reszta po zaliczkach (`amountDue` w faktach
        // z `readState`), nie całe `grossTotal` — zapasowy grossTotal tylko
        // dla faktów bez tego pola (C-16, 00145).
        const outstanding =
          Number(state.facts.amountDue ?? state.facts.grossTotal ?? 0) -
          Number(state.facts.paidAmount ?? 0);
        const who = state.context.contractorName ?? 'Kontrahent';
        const number = state.context.invoiceNumber ?? 'bez numeru';
        const overdueDays = daysOverdue(invoice.payment_due_date);

        const result = await createProposal(
          buildChaseProposal({
            tenantId: invoice.tenant_id,
            invoiceId: invoice.id,
            invoiceNumber: number,
            contractorName: who,
            outstanding,
            daysOverdue: overdueDays,
            stage,
            recipientEmail: null,
            facts: state.facts,
          }),
        );

        return result.status === 'created';
      });

      if (created) proposedCount++;
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Unknown';
      errors++;
      // Do 02.10 błąd był tylko liczony — propozycja ponaglenia nie
      // powstawała, a w logach nie było śladu dlaczego.
      logger.warn('Nie udało się przygotować propozycji ponaglenia', {
        invoiceId: invoice.id,
        tenantId: invoice.tenant_id,
        error,
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Pomocnicze
//
// Treść karty buduje `buildChaseProposal` (krok 23) — jedno źródło prawdy
// dla tekstu, progów i bezpieczników. Tutaj zostaje wyłącznie to, czego
// scheduler potrzebuje do wyliczeń.
// ═══════════════════════════════════════════════════════════════

function daysOverdue(dueDate: string | null): number {
  if (!dueDate) return 0;
  const due = Date.parse(dueDate);
  if (Number.isNaN(due)) return 0;
  return Math.max(0, Math.floor((Date.now() - due) / 86_400_000));
}
