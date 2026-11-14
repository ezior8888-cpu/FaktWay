import { describe, expect, it } from 'vitest';

import { collectValidationIssues } from '@/components/invoices/invoice-form-parts/validation-issues';

// Audyt dostępności A-05 po kroku 2.5 (#643): błąd pola serii numeracji ma
// w bloku błędów nazwę pola i odnośnik do listy wyboru serii (`number-series`,
// domyślne id `SeriesSelect`).
describe('blok błędów formularza: seria numeracji', () => {
  it('błąd serii ma nazwę „Seria numeracji” i cel `number-series`', () => {
    const issues = collectValidationIssues({
      numberSeriesId: { type: 'invalid_string', message: 'Nieprawidłowa seria numeracji. Odśwież stronę i wybierz serię ponownie.' },
    } as never);
    expect(issues).toEqual([
      {
        path: 'numberSeriesId',
        label: 'Seria numeracji',
        message: 'Nieprawidłowa seria numeracji. Odśwież stronę i wybierz serię ponownie.',
        targetId: 'number-series',
      },
    ]);
  });
});
