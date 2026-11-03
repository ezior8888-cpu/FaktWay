/**
 * Sonda workera (RUN-01): uruchamiana przez test z TYMI SAMYMI flagami Node
 * co CMD etapu `worker` w Dockerfile. Robi to, co worker robi na produkcji,
 * ale bez bazy:
 *   1. ładuje rejestracje jobów — te same importy `./handlers/*` co worker.ts,
 *   2. renderuje szablony e-mail wysyłane przez worker (React Email).
 *
 * Kończy się kodem 0 i linią `SONDA_OK …`, albo kodem 1 i `SONDA_BŁĄD …`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render } from '@react-email/render';

import CertExpiry from '@/lib/email/templates/CertExpiry';
import InvoiceAccepted from '@/lib/email/templates/InvoiceAccepted';
import InvoiceDuplicateDecision from '@/lib/email/templates/InvoiceDuplicateDecision';
import InvoiceFailed from '@/lib/email/templates/InvoiceFailed';
import PaymentFailed from '@/lib/email/templates/PaymentFailed';
import TrialEnding from '@/lib/email/templates/TrialEnding';

const appUrl = 'https://example.test';

async function main(): Promise<void> {
  // Lista z worker.ts, a nie przepisana ręcznie: nowa paczka handlerów
  // trafia do sondy sama.
  const workerSource = readFileSync(join(process.cwd(), 'lib/jobs/worker.ts'), 'utf8');
  const handlers = [...workerSource.matchAll(/^import '\.\/handlers\/([\w-]+)';$/gm)].map((m) => m[1]);
  if (handlers.length === 0) throw new Error('Nie znaleziono importów ./handlers/* w lib/jobs/worker.ts');
  for (const handler of handlers) {
    await import(`@/lib/jobs/handlers/${handler}`);
  }

  const emails = [
    InvoiceAccepted({ ksefNumber: '1234567890-20261027-ABCDEF-01', invoiceId: 'inv-1', appUrl }),
    InvoiceFailed({ invoiceId: 'inv-1', errorMessage: 'KSeF odrzucił fakturę', appUrl }),
    InvoiceDuplicateDecision({ invoiceId: 'inv-1', invoiceNumber: 'FV/1/10/2026', ksefNumber: '1234567890-20261027-ABCDEF-01', reminder: false, appUrl }),
    CertExpiry({ tenantName: 'Firma Testowa', daysRemaining: 7, expiryDate: '3 listopada 2026' }),
    TrialEnding({ appUrl, tenantName: 'Firma Testowa', daysRemaining: 3, trialEndDate: '30 października 2026', planLabel: 'Start', monthlyPriceLabel: '49 zł' }),
    PaymentFailed({ appUrl, tenantName: 'Firma Testowa', amountLabel: '60,27 zł', failureReason: null }),
  ];
  for (const email of emails) {
    const html = await render(email);
    if (!html.includes('<html')) throw new Error('Render szablonu nie zwrócił HTML');
  }

  console.log(`SONDA_OK handlery=${handlers.length} maile=${emails.length}`);
  // Jawne wyjście: gdyby któryś import zostawił otwarty uchwyt (timer, socket),
  // sonda nie może wisieć do limitu czasu testu.
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('SONDA_BŁĄD', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
