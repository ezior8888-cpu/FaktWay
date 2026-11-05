import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn(async () => ({ ids: ['event-1'] })) }));
vi.mock('@/lib/storage/r2', () => ({ downloadFromR2: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireUserAndTenant: async () => ({
    user: { id: 'u-1' },
    tenantId: 'ten-1',
    supabase: {
      from: () => {
        const q: Record<string, unknown> = {};
        Object.assign(q, {
          insert: (row: Record<string, unknown>) => {
            mocks.inserts.push(row);
            return q;
          },
          select: () => q,
          single: async () => ({ data: { id: 'job-1' }, error: null }),
        });
        return q;
      },
    },
  }),
}));

import { startExportAction } from '@/app/actions/exports';
import { ENABLED_EXPORT_FORMATS, includesFor, includesForJob } from '@/components/exports/export-formats';
import {
  exportIncludesFor,
  exportScopeFor,
  type ExportFormatValue,
  type ExportIncludes,
  type ExportScope,
  UnknownExportFormatError,
} from '@/lib/exports/export-scope';
import { Constants } from '@/types/database';

/**
 * FIR-01 (przegląd architektury 26.10.2026): reguła „co wchodzi do danego
 * formatu eksportu” ma jedno źródło — `lib/exports/export-scope.ts`. Do 27.10
 * znał ją tylko formularz w przeglądarce, a runner, Co-Pilot i ponowienie
 * z historii brały flagi joba wprost.
 */

const FORMATY = Constants.public.Enums.export_format_enum;

/** Wszystkie 8 kombinacji trzech pól. */
const PROSBY: ExportIncludes[] = [false, true].flatMap((includeIssued) =>
  [false, true].flatMap((includeReceived) =>
    [false, true].map((includeCorrections) => ({ includeIssued, includeReceived, includeCorrections }))));

const CALA_KSIEGA: ExportScope = {
  includeIssued: true, includeReceived: true, includeCorrections: true,
  includeExpenses: true, invoiceDirection: 'issued',
};

const nic = { includeIssued: false, includeReceived: false, includeCorrections: false };

describe('exportScopeFor — tabela format × prośba → zakres', () => {
  it.each<[string, ExportFormatValue, Partial<ExportIncludes>, ExportScope]>([
    ['KPiR bez korekt (Co-Pilot) → cała sprzedaż z zaliczkami, ROZ i korektami', 'kpir_excel', { includeCorrections: false }, CALA_KSIEGA],
    ['KPiR bez wystawionych → przychód i tak jest', 'kpir_excel', { includeIssued: false, includeReceived: true }, CALA_KSIEGA],
    ['KPiR bez niczego → cała księga', 'kpir_excel', nic, CALA_KSIEGA],
    ['KPiR bez prośby (portal, domyślne) → cała księga', 'kpir_excel', {}, CALA_KSIEGA],
    ['JPK_V7M → cała ewidencja sprzedaży i zakupy z kosztów', 'jpk_v7m', nic, CALA_KSIEGA],
    ['JPK_FA z korektami → tylko wystawione', 'jpk_fa', { includeIssued: false, includeReceived: true, includeCorrections: true },
      { includeIssued: true, includeReceived: false, includeCorrections: true, includeExpenses: false, invoiceDirection: 'issued' }],
    ['JPK_FA bez korekt → bez korekt (C-01; ta sama flaga w jpkFaBlocker)', 'jpk_fa', { includeCorrections: false },
      { includeIssued: true, includeReceived: false, includeCorrections: false, includeExpenses: false, invoiceDirection: 'issued' }],
    ['CSV: obie strony', 'csv_universal', { includeIssued: true, includeReceived: true, includeCorrections: false },
      { includeIssued: true, includeReceived: true, includeCorrections: false, includeExpenses: false, invoiceDirection: 'both' }],
    ['CSV: same otrzymane', 'csv_universal', { includeIssued: false, includeReceived: true },
      { includeIssued: false, includeReceived: true, includeCorrections: true, includeExpenses: false, invoiceDirection: 'received' }],
    ['CSV bez kierunku → wystawione (jak runner dotąd)', 'csv_universal', nic,
      { includeIssued: true, includeReceived: false, includeCorrections: false, includeExpenses: false, invoiceDirection: 'issued' }],
    ['CSV bez prośby → domyślne kolumn export_jobs', 'csv_universal', {},
      { includeIssued: true, includeReceived: false, includeCorrections: true, includeExpenses: false, invoiceDirection: 'issued' }],
    ['Symfonia (wstrzymana) → jak CSV', 'symfonia', { includeIssued: true, includeReceived: true },
      { includeIssued: true, includeReceived: true, includeCorrections: true, includeExpenses: false, invoiceDirection: 'both' }],
  ])('%s', (_opis, format, prosba, zakres) => {
    expect(exportScopeFor(format, prosba)).toEqual(zakres);
  });

  it('pole `undefined` nie nadpisuje wartości domyślnej', () => {
    expect(exportScopeFor('csv_universal', { includeIssued: undefined, includeCorrections: undefined }))
      .toEqual(exportScopeFor('csv_universal', {}));
  });

  describe.each(FORMATY)('%s', (format) => {
    it.each(PROSBY)('prośba %o: zakres pełny, spójny i stały przy ponowieniu', (prosba) => {
      const zakres = exportScopeFor(format, prosba);
      for (const value of [zakres.includeIssued, zakres.includeReceived, zakres.includeCorrections, zakres.includeExpenses]) {
        expect(typeof value).toBe('boolean');
      }
      // Runner zapisuje zakres w wierszu joba; ponowienie czyta go z powrotem.
      expect(exportScopeFor(format, zakres)).toEqual(zakres);
      // Plik zawsze ma jakąś stronę — runner nie zgaduje kierunku.
      expect(zakres.includeIssued || zakres.includeReceived).toBe(true);
      if (!zakres.includeExpenses) {
        // Bez kosztów z wydatków kierunek faktur = zaznaczone strony.
        const kierunek = zakres.includeIssued && zakres.includeReceived ? 'both' : zakres.includeIssued ? 'issued' : 'received';
        expect(zakres.invoiceDirection).toBe(kierunek);
      }
    });
  });

  it.each(['kpir_excel', 'jpk_v7m'] as const)('%s: każda prośba daje ten sam pełny zakres', (format) => {
    for (const prosba of PROSBY) expect(exportScopeFor(format, prosba)).toEqual(CALA_KSIEGA);
  });
});

describe('formularz i ponowienie z historii używają tej samej reguły', () => {
  it.each(ENABLED_EXPORT_FORMATS)('formularz %s: pola wyboru → zakres z lib/exports', (format) => {
    for (const p of PROSBY) {
      for (const jpkCorrections of [false, true]) {
        const state = { csv: { issued: p.includeIssued, received: p.includeReceived, corrections: p.includeCorrections }, jpkCorrections };
        expect(includesFor(format, state)).toEqual(exportIncludesFor(format, {
          includeIssued: p.includeIssued,
          includeReceived: p.includeReceived,
          includeCorrections: format === 'jpk_fa' ? jpkCorrections : p.includeCorrections,
        }));
      }
    }
  });

  it.each(FORMATY)('ponowienie %s: zakres joba po regule formatu', (format) => {
    for (const p of PROSBY) {
      const job = { format, include_issued: p.includeIssued, include_received: p.includeReceived, include_corrections: p.includeCorrections };
      expect(includesForJob(job)).toEqual(exportIncludesFor(format, p));
    }
  });

  it('ponowienie KPiR z Co-Pilota bez korekt i bez wystawionych → cała księga', () => {
    expect(includesForJob({ format: 'kpir_excel', include_issued: false, include_received: false, include_corrections: false }))
      .toEqual({ includeIssued: true, includeReceived: true, includeCorrections: true });
  });
});

describe('format spoza reguły (enum w bazie wyprzedza kod)', () => {
  const NOWY = 'nowy_format' as ExportFormatValue;

  it('reguła rzuca nazwany błąd — runner rozpoznaje go i nie ponawia', () => {
    expect(() => exportScopeFor(NOWY)).toThrow(UnknownExportFormatError);
    expect(() => exportIncludesFor(NOWY)).toThrow(UnknownExportFormatError);
  });

  it('ponowienie z historii nie wywraca strony: flagi joba bez zmian, odmówi startExportAction', () => {
    expect(includesForJob({ format: NOWY, include_issued: false, include_received: true, include_corrections: true }))
      .toEqual({ includeIssued: false, includeReceived: true, includeCorrections: true });
  });
});

describe('startExportAction zapisuje zakres po regule, nie flagi od klienta', () => {
  const okres = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };

  beforeEach(() => {
    mocks.inserts = [];
  });

  it.each<[string, Parameters<typeof startExportAction>[0], Record<string, boolean>]>([
    ['KPiR z odznaczonym wszystkim → cała księga', { format: 'kpir_excel', ...okres, ...nic },
      { include_issued: true, include_received: true, include_corrections: true }],
    ['JPK_FA z zakupami → bez zakupów', { format: 'jpk_fa', ...okres, includeReceived: true },
      { include_issued: true, include_received: false, include_corrections: true }],
    ['CSV bez pól → domyślne', { format: 'csv_universal', ...okres },
      { include_issued: true, include_received: false, include_corrections: true }],
    ['CSV według pól', { format: 'csv_universal', ...okres, includeIssued: false, includeReceived: true, includeCorrections: false },
      { include_issued: false, include_received: true, include_corrections: false }],
  ])('%s', async (_opis, params, flagi) => {
    await expect(startExportAction(params)).resolves.toEqual({ success: true, jobId: 'job-1' });
    expect(mocks.inserts).toHaveLength(1);
    expect(mocks.inserts[0]).toMatchObject(flagi);
  });
});

// ── Strażnik: reguła zakresu tylko w lib/exports ────────────────────────────

const ROOT = join(__dirname, '..', '..');
const SCOPE_MODULE = 'lib/exports/export-scope.ts';
const SCOPE_IMPORT = /from '@\/lib\/exports\/export-scope'/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const SOURCES = new Map(
  ['app', 'components', 'lib'].flatMap((dir) => walk(join(ROOT, dir))).map((file) => [
    relative(ROOT, file).replaceAll('\\', '/'),
    readFileSync(file, 'utf8').replace(/\r\n/g, '\n'),
  ]),
);

const filesWhere = (test: (source: string) => boolean) =>
  [...SOURCES].filter(([, source]) => test(source)).map(([file]) => file).sort();

/**
 * Co-Pilot zapisuje w jobach ustawienia paczki tak, jak je wybrał właściciel;
 * runner stosuje regułę przed pobraniem danych i zapisuje zakres w wierszu
 * (`mark-generating`). Plik zmienia równolegle plan skalowania (sesja 27).
 */
const WRITES_REQUEST_AS_IS = new Map([
  ['lib/jobs/runners/co-pilot-monthly.ts', 'include_issued: includeIssued'],
]);

describe('strażnik FIR-01: zakres eksportu ma jedno źródło', () => {
  it('moduł reguły nie ciągnie kodu serwera ani Reacta (same importy typów)', () => {
    const imports = SOURCES.get(SCOPE_MODULE)!.split('\n').filter((line) => line.startsWith('import '));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((line) => !line.startsWith('import type '))).toEqual([]);
  });

  it('każde pobranie danych eksportu idzie przez regułę', () => {
    const callers = filesWhere((source) => source.includes('fetchInvoicesForExport('))
      .filter((file) => file !== 'lib/exports/data-fetcher.ts');
    // Kontrola pozytywna: skaner widzi runner i portal księgowej.
    expect(callers).toEqual(['app/api/portal/exports/generate/route.ts', 'lib/jobs/runners/exports-generate.ts']);
    for (const file of callers) {
      expect(SOURCES.get(file), file).toMatch(SCOPE_IMPORT);
      expect(SOURCES.get(file), file).toContain('direction: scope.invoiceDirection');
    }
  });

  it('każdy zapis flag joba idzie przez regułę (wyjątek: Co-Pilot, opisany wyżej)', () => {
    const writers = filesWhere((source) => /\binclude_(issued|received):/.test(source));
    expect(writers).toEqual(['app/actions/exports.ts', 'lib/jobs/runners/co-pilot-monthly.ts', 'lib/jobs/runners/exports-generate.ts']);
    for (const file of writers.filter((f) => !WRITES_REQUEST_AS_IS.has(f))) {
      expect(SOURCES.get(file), file).toMatch(SCOPE_IMPORT);
    }
    for (const [file, text] of WRITES_REQUEST_AS_IS) expect(SOURCES.get(file), file).toContain(text);
  });

  it('formularz importuje regułę i nie ma własnej kopii', () => {
    const form = SOURCES.get('components/exports/export-formats.ts')!;
    expect(form).toMatch(SCOPE_IMPORT);
    expect(form).not.toMatch(/case 'kpir_excel'/);
    expect(form).not.toMatch(/includeReceivedAfterFormatChange/);
  });

  it('runner czyta flagi joba tylko przed regułą, a pobiera według reguły', () => {
    const runner = SOURCES.get('lib/jobs/runners/exports-generate.ts')!;
    const rule = runner.indexOf('exportScopeFor(job.format');
    const markGenerating = runner.indexOf("step.run('mark-generating'");
    const fetch = runner.indexOf('fetchInvoicesForExport({');
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(markGenerating);
    expect(markGenerating).toBeLessThan(fetch);
    const flagReads = [...runner.matchAll(/job\.include_(issued|received|corrections)/g)].map((m) => m.index!);
    expect(flagReads).toHaveLength(3);
    for (const index of flagReads) {
      expect(index).toBeGreaterThan(rule);
      expect(index).toBeLessThan(markGenerating);
    }
  });
});
