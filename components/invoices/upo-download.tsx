'use client';

import { useTransition } from 'react';
import { Download, FileCheck2, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { getUpoPdfAction, getUpoXmlAction } from '@/app/(dashboard)/invoices/[id]/upo-actions';
import { Button } from '@/components/ui/button';
import { saveBlob } from '@/lib/download';

interface UpoDownloadProps {
  invoiceId: string;
  upoStatus?: 'pending' | 'downloaded' | 'failed' | 'archived' | null;
  ksefNumber?: string | null;
}

function safeXmlBasename(ksefNumber: string): string {
  return ksefNumber.replace(/[/\\]/g, '-');
}

export function UpoDownload({
  invoiceId,
  upoStatus,
  ksefNumber,
}: UpoDownloadProps) {
  const [isPdfLoading, startPdfDownload] = useTransition();
  const [isXmlLoading, startXmlDownload] = useTransition();

  if (!ksefNumber) return null;

  const handleDownloadPdf = () => {
    startPdfDownload(async () => {
      const result = await getUpoPdfAction(invoiceId);
      if (!result.success) {
        toast.error(result.error);
        return;
      }

      const binary = atob(result.pdfBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'application/pdf' });
      saveBlob(blob, result.filename);

      toast.success('UPO pobrane');
    });
  };

  const handleDownloadXml = () => {
    startXmlDownload(async () => {
      const result = await getUpoXmlAction(invoiceId);
      if (!result.success) {
        toast.error(result.error);
        return;
      }

      const blob = new Blob([result.xml], { type: 'application/xml' });
      saveBlob(blob, `UPO-${safeXmlBasename(ksefNumber)}.xml`);

      toast.success('UPO XML pobrane');
    });
  };

  if (!upoStatus || upoStatus === 'pending' || upoStatus === 'failed') {
    return (
      <div className="flex items-center gap-3 border bg-muted/40 p-4">
        <Loader2 className="text-muted-foreground h-5 w-5 shrink-0 animate-spin" />
        <div className="flex-1">
          <p className="text-sm font-medium">UPO w trakcie generowania</p>
          <p className="text-muted-foreground text-xs">
            KSeF generuje UPO asynchronicznie — to może potrwać 1–5 minut.
            Odśwież stronę.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 border border-green-600/30 bg-green-600/5 p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center bg-green-600/10">
          <FileCheck2 className="size-4 text-green-700 dark:text-green-400" />
        </div>
        <div className="flex-1">
          <p className="font-medium text-xs tracking-wider text-green-700 uppercase dark:text-green-400">
            UPO dostępne
          </p>
          <p className="font-medium">Urzędowe Poświadczenie Odbioru</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Dowód prawny akceptacji faktury w KSeF. Zachowaj na wypadek kontroli.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={handleDownloadPdf}
          variant="default"
          disabled={isPdfLoading}
        >
          {isPdfLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          Pobierz UPO (PDF)
        </Button>
        <Button
          onClick={handleDownloadXml}
          variant="outline"
          disabled={isXmlLoading}
        >
          {isXmlLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <FileText className="mr-2 h-4 w-4" />
          )}
          Pobierz XML
        </Button>
      </div>
    </div>
  );
}
