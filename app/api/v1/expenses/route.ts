import { authenticateApiRequest } from '@/lib/api/v1/auth';
import { listExpenses, parseExpenseListQuery } from '@/lib/api/v1/expenses';
import { apiError, apiOk } from '@/lib/api/v1/responses';
import { apiFailure } from '@/lib/api/v1/route-helpers';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/expenses`: koszty firmy klucza (zakres `expenses:read`)
 * z kwotami, walutą kwot i statusem przeglądu, strony kursorem.
 */
export async function GET(request: Request) {
  const auth = await authenticateApiRequest(request, { scope: 'expenses:read' });
  if (!auth.ok) return auth.response;

  const query = parseExpenseListQuery(new URL(request.url).searchParams);
  if (!query.ok) return apiError(400, 'invalid_parameter', query.message, auth.headers);

  try {
    return apiOk(await listExpenses(auth.db, auth.key.tenantId, query.value), auth.headers);
  } catch (error) {
    return apiFailure(error, auth.requestId, auth.headers);
  }
}
