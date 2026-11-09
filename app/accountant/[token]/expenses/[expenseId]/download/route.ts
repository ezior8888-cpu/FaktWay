import { serveExpenseFile } from '@/lib/accountant/expense-file';

export const dynamic = 'force-dynamic';

/**
 * GET /accountant/<token>/expenses/<id>/download: zdjęcie albo XML dokumentu
 * kosztu jako plik (krok 6.2). Tylko dostęp z pobieraniem; sprawdzenia
 * i krótki podpisany adres w `serveExpenseFile`.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string; expenseId: string }> },
) {
  return serveExpenseFile(context.params, 'download');
}
