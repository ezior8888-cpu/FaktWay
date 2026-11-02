'use client';

import { useState } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { Field, FieldContent, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { uploadCertificateAction } from './actions';

/**
 * Wgranie certyfikatu KSeF. Wygląd: pola jak w `change-password-card.tsx`
 * Finory (etykieta nad polem na całą szerokość, przycisk pod spodem).
 *
 * `stepUpRequired`: sesja po biometrii. Mówimy o kodzie, zanim klient wybierze
 * pliki, bo po powrocie z ekranu kodu musiałby wybierać je jeszcze raz.
 */
export function CertificateUpload({ stepUpRequired = false }: { stepUpRequired?: boolean }) {
  const [certFile, setCertFile] = useState<File | null>(null);
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [needsCode, setNeedsCode] = useState(stepUpRequired);

  const handleUpload = async () => {
    if (!certFile || !keyFile) return;

    setIsUploading(true);
    try {
      const certPem = await certFile.text();
      const keyPem = await keyFile.text();

      const result = await uploadCertificateAction({ certPem, keyPem });
      if (result.success) {
        toast.success(result.message);
        window.location.reload();
        return;
      }
      if (result.mfaStepUp) {
        setNeedsCode(true);
        return;
      }
      toast.error(result.error);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Nieznany błąd');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <FieldGroup>
      {needsCode && (
        <MfaStepUpNotice returnTo="/settings/ksef">
          Zmiana certyfikatu KSeF wymaga potwierdzenia kodem z aplikacji.
        </MfaStepUpNotice>
      )}
      <Field orientation="responsive" className="flex-col!">
        <FieldContent>
          <FieldLabel htmlFor="ksef-cert-file">Plik certyfikatu (cert.pem lub .crt)</FieldLabel>
        </FieldContent>
        <div className="w-full!">
          <Input
            id="ksef-cert-file"
            type="file"
            accept=".pem,.crt,.cer"
            onChange={(e) => setCertFile(e.target.files?.[0] ?? null)}
          />
        </div>
      </Field>

      <Field orientation="responsive" className="flex-col!">
        <FieldContent>
          <FieldLabel htmlFor="ksef-key-file">Plik klucza prywatnego (key.pem)</FieldLabel>
        </FieldContent>
        <div className="w-full!">
          <Input
            id="ksef-key-file"
            type="file"
            accept=".pem,.key"
            onChange={(e) => setKeyFile(e.target.files?.[0] ?? null)}
          />
        </div>
      </Field>

      <div>
        <Button onClick={handleUpload} disabled={!certFile || !keyFile || isUploading}>
          {isUploading && <RiLoader4Line className="animate-spin" aria-hidden />}
          Wgraj i zweryfikuj certyfikat
        </Button>
      </div>
    </FieldGroup>
  );
}
