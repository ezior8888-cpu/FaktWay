/**
 * Źródła importu z pliku — decyzja Bartosza 22.10.2026: tylko cztery duże
 * programy, bez ogólnego JPK_FA. Moduł bez zależności serwerowych: czytają go
 * okno importu w przeglądarce i trasa `/api/uploads/import`.
 */
export type FileImportSource = 'fakturownia_csv' | 'infakt_csv' | 'wfirma_csv' | 'ifirma_csv';

export const FILE_IMPORT_SOURCES: readonly FileImportSource[] = ['fakturownia_csv', 'infakt_csv', 'wfirma_csv', 'ifirma_csv'];
