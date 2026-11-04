import { describe, expect, it, vi } from 'vitest';
import {
  createTable,
  getCoreRowModel,
  getFilteredRowModel,
  type ColumnDef,
  type TableState,
} from '@tanstack/react-table';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/reminders/reminder-consent-dialog', () => ({ ReminderConsentDialog: () => null }));
vi.mock('@/app/actions/reminders', () => ({ toggleInvoiceRemindersAction: vi.fn(), toggleContractorRemindersAction: vi.fn() }));
vi.mock('@/app/actions/validation', () => ({ bulkValidateContractorsAction: vi.fn() }));
vi.mock('@/app/actions/contractors', () => ({ deleteContractorAction: vi.fn(), updateContractorAction: vi.fn() }));

import { CONTRACTOR_COLUMNS } from '@/app/(dashboard)/contractors/_components/contractors-table';
import { KPIR_COLUMNS } from '@/components/expenses/kpir-view';
import { overdueColumns } from '@/components/reminders/overdue-dashboard';

/**
 * Filtry „select” Finory (`ColumnSelectFilter`) porównują CAŁĄ wartość
 * (`filterFn: 'equalsString'`, jak datatable-user/-transaction w Finorze).
 * Domyślny `includesString` tanstacka dopasowuje podciąg: „Czynny VAT”
 * ('active') pokazywał też wykreślonych ('inactive').
 */

function filtered<T>(columns: ColumnDef<T>[], data: T[], id: string, value: string): T[] {
  let state = { columnFilters: [{ id, value }] } as unknown as TableState;
  const table = createTable<T>({
    data,
    columns,
    state,
    onStateChange: (updater) => {
      state = typeof updater === 'function' ? updater(state) : updater;
    },
    renderFallbackValue: null,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  table.setOptions((prev) => ({ ...prev, state: { ...table.initialState, ...state } }));
  return table.getFilteredRowModel().rows.map((row) => row.original);
}

describe('filtry select — dokładne dopasowanie', () => {
  it('Kontrahenci: „Czynny VAT” nie pokazuje wykreślonych', () => {
    const data = (['active', 'inactive', 'unknown', 'exempt'] as const).map((vat_status, i) => ({
      id: `c${i}`, nip: null, name: `K${i}`, address: null, email: null, vat_status,
      validation_warning: null, reminder_excluded: false, receivables: null,
    }));
    expect(filtered(CONTRACTOR_COLUMNS, data, 'vat', 'active').map((r) => r.vat_status)).toEqual(['active']);
    expect(filtered(CONTRACTOR_COLUMNS, data, 'vat', 'inactive').map((r) => r.vat_status)).toEqual(['inactive']);
  });

  it('Przypomnienia i KPiR: kolumny z filtrem select mają equalsString', () => {
    const select = (columns: Array<{ id?: string; filterFn?: unknown }>, id: string) =>
      columns.find((c) => c.id === id)?.filterFn;
    expect(select(CONTRACTOR_COLUMNS as Array<{ id?: string; filterFn?: unknown }>, 'vat')).toBe('equalsString');
    expect(select(overdueColumns(() => {}) as Array<{ id?: string; filterFn?: unknown }>, 'status')).toBe('equalsString');
    expect(select(KPIR_COLUMNS as Array<{ id?: string; filterFn?: unknown }>, 'kind')).toBe('equalsString');
    expect(select(KPIR_COLUMNS as Array<{ id?: string; filterFn?: unknown }>, 'column')).toBe('equalsString');
  });

  it('KPiR: „Kol. 1x” filtruje tylko swoją kolumnę', () => {
    const data = ['7', '10', '13', '13'].map((column, i) => ({ id: `e${i}`, kind: i === 0 ? 'revenue' : 'cost', column }));
    const cols = KPIR_COLUMNS as unknown as ColumnDef<(typeof data)[number]>[];
    expect(filtered(cols, data, 'column', '13').map((r) => r.id)).toEqual(['e2', 'e3']);
    expect(filtered(cols, data, 'kind', 'cost').map((r) => r.id)).toEqual(['e1', 'e2', 'e3']);
  });
});
