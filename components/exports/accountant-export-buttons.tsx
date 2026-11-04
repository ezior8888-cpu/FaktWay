'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { safeFetch } from '@/lib/client-fetch';
import { saveBlob } from '@/lib/download';

interface AccountantExportButtonsProps {
  tenantId: string;
  accessToken: string;
}

export function AccountantExportButtons({
  tenantId,
  accessToken,
}: AccountantExportButtonsProps) {
  const [isLoadingJpk, startJpk] = useTransition();
  const [isLoadingKpir, startKpir] = useTransition();
  const [selectedPeriod, setSelectedPeriod] = useState(getPreviousMonth);

  /**
   * Anulowanie aktywnego pobrania przy unmount / nawigacji w trakcie — bez
   * tego user który kliknie i od razu opuści widok zostawia wiszące połączenie
   * na backendzie i pamięci przeglądarki.
   */
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const handleExport = (format: 'jpk_fa' | 'kpir_excel') => {
    const transition = format === 'jpk_fa' ? startJpk : startKpir;

    transition(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const periodStart = `${selectedPeriod}-01`;
      const periodEnd = getMonthEndIso(selectedPeriod);

      const result = await safeFetch('/api/portal/exports/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Accountant-Token': accessToken,
        },
        body: JSON.stringify({
          tenantId,
          format,
          periodStart,
          periodEnd,
        }),
        signal: controller.signal,
        timeoutMs: 45_000,
      });

      if (!result.ok) {
        if (result.kind === 'aborted') return;
        if (result.kind === 'circuit_open') {
          toast.warning('Tryb ograniczonej łączności — spróbuj za chwilę.');
          return;
        }
        if (result.kind === 'timeout') {
          toast.error('Pobieranie trwa zbyt długo — spróbuj ponownie.');
          return;
        }
        if (result.kind === 'network') {
          toast.error('Brak połączenia — sprawdź sieć i spróbuj ponownie.');
          return;
        }
        let message = `Błąd ${result.status}`;
        try {
          const body = (await result.response.json()) as { error?: string };
          if (typeof body?.error === 'string' && body.error.length > 0) {
            message = body.error;
          }
        } catch {
          /* ignore */
        }
        toast.error(message);
        return;
      }

      const response = result.response;
      const blob = await response.blob();
      const fallbackExt = format === 'jpk_fa' ? 'xml' : 'xlsx';
      const filename =
        response.headers.get('X-Filename') ??
        `${format}_${selectedPeriod}.${fallbackExt}`;
      saveBlob(blob, filename);

      toast.success('Plik pobrany');
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="accountant-export-month" className="text-muted-foreground">
          Wybierz miesiąc
        </Label>
        <Input
          id="accountant-export-month"
          type="month"
          value={selectedPeriod}
          onChange={(e) => setSelectedPeriod(e.target.value)}
          className="max-w-[240px]"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Button
          variant="outline"
          size="lg"
          type="button"
          onClick={() => handleExport('jpk_fa')}
          disabled={isLoadingJpk || isLoadingKpir}
          className="justify-start"
        >
          {isLoadingJpk ? (
            <Loader2 className="animate-spin shrink-0" aria-hidden />
          ) : (
            <FileText className="shrink-0" aria-hidden />
          )}
          Pobierz JPK_FA(4)
        </Button>

        <Button
          variant="outline"
          size="lg"
          type="button"
          onClick={() => handleExport('kpir_excel')}
          disabled={isLoadingJpk || isLoadingKpir}
          className="justify-start"
        >
          {isLoadingKpir ? (
            <Loader2 className="animate-spin shrink-0" aria-hidden />
          ) : (
            <Download className="shrink-0" aria-hidden />
          )}
          Pobierz KPiR Excel
        </Button>
      </div>
    </div>
  );
}

function getPreviousMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Ostatni dzień kalendarza dla `YYYY-MM` (czas lokalny). */
function getMonthEndIso(yearMonth: string): string {
  const parts = yearMonth.split('-').map(Number);
  const year = parts[0];
  const month = parts[1];
  if (
    year == null ||
    month == null ||
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    month < 1 ||
    month > 12
  ) {
    return `${yearMonth}-28`;
  }
  const end = new Date(year, month, 0);
  const y = end.getFullYear();
  const m = String(end.getMonth() + 1).padStart(2, '0');
  const day = String(end.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
