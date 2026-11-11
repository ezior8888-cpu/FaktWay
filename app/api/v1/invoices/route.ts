import { authenticateApiRequest, checkApiWriteLimit } from '@/lib/api/v1/auth';
import { createInvoiceFromApi, parseIdempotencyHeader, readInvoiceCreateRequest } from '@/lib/api/v1/invoice-create';
import { listInvoices, parseInvoiceListQuery } from '@/lib/api/v1/invoices';
import { apiCreated, apiError, apiOk } from '@/lib/api/v1/responses';
import { apiFailure } from '@/lib/api/v1/route-helpers';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/invoices`: faktury firmy klucza (zakres `invoices:read`),
 * filtr kierunku, statusu KSeF i dat wystawienia, strony kursorem.
 * Opis: `lib/api/v1/openapi.json`, strona `/api/docs`.
 */
export async function GET(request: Request) {
  const auth = await authenticateApiRequest(request, { scope: 'invoices:read' });
  if (!auth.ok) return auth.response;

  const query = parseInvoiceListQuery(new URL(request.url).searchParams);
  if (!query.ok) return apiError(400, 'invalid_parameter', query.message, auth.headers);

  try {
    return apiOk(await listInvoices(auth.db, auth.key.tenantId, query.value), auth.headers);
  } catch (error) {
    return apiFailure(error, auth.requestId, auth.headers);
  }
}

/**
 * `POST /api/v1/invoices` (krok 7.1, część 2): zwykła faktura VAT krajowa
 * w PLN firmy klucza (zakres `invoices:write`), tą samą drogą co formularz;
 * z `send: true` także kolejka wysyłki do KSeF. Nagłówek `Idempotency-Key`
 * jest wymagany: powtórzenie z tą samą treścią zwraca tę samą fakturę
 * (201 i `Idempotency-Replayed: true`), z inną treścią 409.
 * Logika: `lib/api/v1/invoice-create.ts`, zapis: `api_create_invoice()` (00184).
 */
export async function POST(request: Request) {
  const auth = await authenticateApiRequest(request, { scope: 'invoices:write' });
  if (!auth.ok) return auth.response;

  const limited = await checkApiWriteLimit(auth);
  if (limited) return limited;

  const idempotency = parseIdempotencyHeader(request.headers.get('idempotency-key'));
  if (!idempotency.ok) return apiError(400, idempotency.code, idempotency.message, auth.headers);

  try {
    const body = await readInvoiceCreateRequest(request);
    if (!body.ok) return apiError(body.status, body.code, body.message, auth.headers, body.fields);

    const outcome = await createInvoiceFromApi(
      { db: auth.db, key: auth.key, requestId: auth.requestId },
      { idempotencyKey: idempotency.value, input: body.value, requestHash: body.requestHash },
    );
    if (!outcome.ok) return apiError(outcome.status, outcome.code, outcome.message, auth.headers, outcome.fields);

    return apiCreated(
      { data: outcome.invoice, ksef_submission: outcome.submission },
      {
        ...auth.headers,
        Location: `/api/v1/invoices/${outcome.invoice.id}`,
        ...(outcome.replayed ? { 'Idempotency-Replayed': 'true' } : {}),
      },
    );
  } catch (error) {
    return apiFailure(error, auth.requestId, auth.headers);
  }
}
