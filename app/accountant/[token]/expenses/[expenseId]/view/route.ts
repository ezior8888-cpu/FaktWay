import { serveExpenseFile } from '@/lib/accountant/expense-file';

export const dynamic = 'force-dynamic';

/**
 * GET /accountant/<token>/expenses/<id>/view: zdjęcie albo XML dokumentu
 * kosztu w przeglądarce (krok 6.2). Każdy poziom dostępu portalu; sprawdzenia
 * i krótki podpisany adres w `serveExpenseFile`.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string; expenseId: string }> },
) {
  return serveExpenseFile(context.params, 'view');
}
