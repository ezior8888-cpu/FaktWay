'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  RiCloseLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFileLine,
  RiKeyLine,
  RiLoader4Line,
  RiUploadCloud2Line,
} from '@remixicon/react';
import { toast } from 'sonner';

import { uploadCertificateAction, type ConnectFailureReason } from '@/components/settings/actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { bytesToBase64, describeKsefFile, MAX_KSEF_FILE_BYTES } from '@/lib/ksef/certificate-files';
import { SUPPORT_EMAIL } from '@/lib/site';
import { cn } from '@/lib/utils';

import {
  failureIsPassword,
  failureIsTemporary,
  failureNeedsNewCertificate,
  RECONFIRM_CERTIFICATE_TEXT,
  WIZARD_CERTIFICATE_HREF,
  WIZARD_PATH,
} from './wizard-model';
import { WizardProgress } from './wizard-progress';

const AMBER_ALERT = 'border-none bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400';
const AMBER_TEXT = 'text-amber-800 dark:text-amber-400/80';
const TOUCH_BUTTON = 'h-11 w-full justify-center sm:w-auto';

interface PickedFile {
  name: string;
  size: number;
  /** Surowe bajty pliku jako base64 (PEM i DER przechodzą bez zmian). */
  base64: string;
  encrypted: boolean;
}

interface Failure {
  reason: ConnectFailureReason;
  error: string;
}

type Phase = 'idle' | 'checking' | 'done';

interface FilesStepProps {
  /**
   * Firma ma zapisane poświadczenia bez dowodu w środowisku aplikacji (inne środowisko albo stary
   * znacznik): nad plikami stoi zdanie, że certyfikat trzeba potwierdzić ponownie.
   */
  reconfirm?: boolean;
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
}

function FileRow({
  icon,
  label,
  file,
  emptyText,
  onRemove,
  disabled,
}: {
  icon: 'certificate' | 'key';
  label: string;
  file: PickedFile | null;
  emptyText: string;
  onRemove: () => void;
  disabled: boolean;
}) {
  const Icon = icon === 'key' ? RiKeyLine : RiFileLine;
  if (!file) {
    return (
      <li className="text-muted-foreground flex min-h-11 items-center gap-3 border border-dashed px-3 py-2 text-sm">
        <Icon className="size-4 shrink-0" aria-hidden />
        <span>{emptyText}</span>
      </li>
    );
  }
  return (
    <li className="flex min-h-11 items-center gap-3 border px-3 py-2" data-testid={`ksef-plik-${icon}`}>
      <Icon className="size-4 shrink-0 text-green-700 dark:text-green-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {label}
          {file.encrypted ? ' (zabezpieczony hasłem)' : ''}
        </p>
        <p className="text-muted-foreground truncate text-xs">
          {file.name} · {formatSize(file.size)}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 shrink-0"
        aria-label={`Usuń plik ${file.name}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <RiCloseLine aria-hidden />
      </Button>
    </li>
  );
}

/**
 * Krok 3 i 4: jedno pole na oba pliki naraz (albo po kolei), rozpoznawanie po
 * treści, hasło tylko dla zaszyfrowanego klucza, a potem „Sprawdzamy w KSeF”.
 * Przy błędzie pliki i hasło zostają w pamięci strony (nic nie ginie), a klient
 * dostaje konkretne zdanie i właściwe wyjście: poprawić hasło, wybrać inny plik
 * albo wrócić do pobrania certyfikatu.
 */
export function FilesStep({ reconfirm = false }: FilesStepProps) {
  const router = useRouter();
  const [certificate, setCertificate] = useState<PickedFile | null>(null);
  const [privateKey, setPrivateKey] = useState<PickedFile | null>(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [dragging, setDragging] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const busy = phase !== 'idle';
  const needsPassword = Boolean(privateKey?.encrypted);
  const ready = Boolean(certificate && privateKey && (!needsPassword || password.length > 0));

  useEffect(() => {
    if (!failure) return;
    if (failureIsPassword(failure.reason)) passwordRef.current?.focus();
    else alertRef.current?.focus();
  }, [failure]);

  async function addFiles(files: File[]) {
    const messages: string[] = [];
    let nextCertificate = certificate;
    let nextKey = privateKey;
    for (const file of files) {
      if (file.size > MAX_KSEF_FILE_BYTES) {
        messages.push(
          `Plik „${file.name}” jest za duży jak na certyfikat KSeF. Wybierz pliki pobrane z Aplikacji Podatnika (mają po kilka kilobajtów).`,
        );
        continue;
      }
      // Bajty, nie tekst: odczyt jako tekst psuje certyfikaty w DER.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = describeKsefFile(bytes);
      const picked: PickedFile = { name: file.name, size: file.size, base64: bytesToBase64(bytes), encrypted: info.encrypted };
      if (info.kind === 'certificate') nextCertificate = picked;
      else if (info.kind === 'private-key' || info.kind === 'encrypted-private-key') nextKey = picked;
      else if (info.kind === 'bundle') {
        nextCertificate = picked;
        nextKey = picked;
      } else {
        messages.push(
          `Plik „${file.name}” nie wygląda na certyfikat ani na klucz z KSeF. Wybierz plik .crt i plik .key pobrane z Aplikacji Podatnika.`,
        );
      }
    }
    setCertificate(nextCertificate);
    setPrivateKey(nextKey);
    if (!nextKey?.encrypted) setPassword('');
    setNotices(messages);
    setFailure(null);
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length > 0) void addFiles(files);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void addFiles(files);
  }

  async function submit() {
    if (!certificate || !privateKey || busy) return;
    setPhase('checking');
    setFailure(null);
    try {
      const result = await uploadCertificateAction({
        certificate: certificate.base64,
        privateKey: privateKey.base64,
        password: needsPassword ? password : undefined,
      });
      if (result.success) {
        setPhase('done');
        setPassword('');
        toast.success(result.message);
        // Adres bez ?krok= pokazuje podsumowanie „Połączono”.
        router.replace(WIZARD_PATH);
        router.refresh();
        return;
      }
      if (result.reason === 'mfa_required') {
        // Sesja straciła potwierdzenie 2FA: kreator sam wróci do kroku 1.
        router.refresh();
      } else {
        setFailure({ reason: result.reason, error: result.error });
      }
    } catch {
      setFailure({
        reason: 'unavailable',
        error: 'Nie udało się połączyć z FaktWay. Sprawdź internet i spróbuj ponownie. Twoje pliki są nadal wybrane.',
      });
    }
    setPhase('idle');
  }

  if (phase !== 'idle') {
    return (
      <div className="flex flex-col gap-4" data-testid="ksef-step-sprawdzamy">
        <WizardProgress current={4} />
        <div role="status" className="flex items-center gap-3 border p-4">
          <RiLoader4Line className="size-5 shrink-0 animate-spin" aria-hidden />
          <div>
            <p className="text-sm font-medium">Sprawdzamy certyfikat w KSeF</p>
            <p className="text-muted-foreground text-xs">
              To zwykle kilka sekund. Nie zamykaj tej strony. Pliki zostają w pamięci tej strony i nigdzie ich nie zapisujemy,
              dopóki KSeF ich nie potwierdzi.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="ksef-step-pliki">
      <WizardProgress current={3} />
      {reconfirm ? (
        <Alert role="note" className={AMBER_ALERT}>
          <AlertDescription className={AMBER_TEXT}>{RECONFIRM_CERTIFICATE_TEXT}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-muted-foreground text-sm">
        Wskaż plik certyfikatu (.crt) i plik klucza prywatnego (.key) z Aplikacji Podatnika. Możesz wybrać oba naraz albo
        po kolei, rozpoznamy je po zawartości.
      </p>

      <label
        htmlFor="ksef-pliki"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className="block cursor-pointer"
      >
        <input id="ksef-pliki" type="file" multiple className="peer sr-only" onChange={onInputChange} data-testid="ksef-pliki" />
        <div
          className={cn(
            'peer-focus-visible:ring-ring/50 flex min-h-32 flex-col items-center justify-center gap-2 border border-dashed p-4 text-center peer-focus-visible:ring-2',
            dragging && 'bg-muted',
          )}
        >
          <RiUploadCloud2Line className="text-muted-foreground size-6" aria-hidden />
          <span className="text-sm font-medium">Wybierz pliki albo przeciągnij je tutaj</span>
          <span className="text-muted-foreground text-xs">Certyfikat (.crt) i klucz (.key), w dowolnej kolejności</span>
        </div>
      </label>

      <ul className="flex flex-col gap-2" aria-live="polite">
        <FileRow
          icon="certificate"
          label="Certyfikat"
          file={certificate}
          emptyText="Brak certyfikatu (.crt)"
          disabled={busy}
          onRemove={() => {
            setCertificate(null);
            setFailure(null);
          }}
        />
        <FileRow
          icon="key"
          label="Klucz prywatny"
          file={privateKey}
          emptyText="Brak klucza prywatnego (.key)"
          disabled={busy}
          onRemove={() => {
            setPrivateKey(null);
            setPassword('');
            setFailure(null);
          }}
        />
      </ul>

      {notices.length > 0 ? (
        <Alert role="status" className="border-none bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400">
          <AlertDescription className="text-amber-800 dark:text-amber-400/80">
            {notices.map((notice) => (
              <span key={notice} className="block">
                {notice}
              </span>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      {needsPassword ? (
        <Field>
          <FieldLabel htmlFor="ksef-haslo">Hasło do klucza</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="ksef-haslo"
              ref={passwordRef}
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              // Klawiatura ekranowa nie może zasłaniać pola: po wejściu przewijamy je na środek.
              onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'center', behavior: 'smooth' })}
              className="h-11"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              aria-invalid={failure ? failureIsPassword(failure.reason) : undefined}
              aria-describedby="ksef-haslo-opis"
              disabled={busy}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11 shrink-0"
              aria-pressed={showPassword}
              aria-label={showPassword ? 'Ukryj hasło' : 'Pokaż hasło'}
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? <RiEyeOffLine aria-hidden /> : <RiEyeLine aria-hidden />}
            </Button>
          </div>
          <FieldDescription id="ksef-haslo-opis">
            To hasło ustawiono przy tworzeniu certyfikatu w Aplikacji Podatnika. FaktWay go nie zapisuje: służy tylko do
            odczytania klucza.
          </FieldDescription>
        </Field>
      ) : null}

      {failure ? (
        <Alert variant="destructive" ref={alertRef} tabIndex={-1} className="outline-none" data-testid="ksef-blad">
          <AlertTitle>Nie udało się podłączyć KSeF</AlertTitle>
          <AlertDescription>
            <span className="block">{failure.error}</span>
            {failureNeedsNewCertificate(failure.reason) ? (
              <Link href={WIZARD_CERTIFICATE_HREF} className="mt-2 inline-block underline underline-offset-4">
                Wróć do pobierania certyfikatu
              </Link>
            ) : null}
            <span className="mt-2 block text-xs">
              Potrzebujesz pomocy? Napisz do nas:{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-4">
                {SUPPORT_EMAIL}
              </a>
              .
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      <Button type="button" className={TOUCH_BUTTON} disabled={!ready} onClick={() => void submit()} data-testid="ksef-sprawdz">
        {failure && failureIsTemporary(failure.reason) ? 'Spróbuj ponownie' : 'Sprawdź w KSeF'}
      </Button>

      <Link href={WIZARD_CERTIFICATE_HREF} className={cn(buttonVariants({ variant: 'ghost' }), TOUCH_BUTTON)}>
        Wstecz do instrukcji
      </Link>
    </div>
  );
}
