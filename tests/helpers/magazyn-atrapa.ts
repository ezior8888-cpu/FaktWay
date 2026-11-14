import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';

/**
 * Magazyn plików w pamięci na poziomie poleceń S3 (`client.send(command)`):
 * PUT z `IfNoneMatch`, GET, HEAD, DELETE i lista po prefiksie, jak MinIO na
 * produkcji. Do atrapy `@/lib/storage/r2-client` (`getR2Client`), więc kod
 * magazynu aplikacji (`lib/storage/*.ts`) działa naprawdę.
 */

export interface ObiektMagazynu {
  body: Buffer;
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  lastModified: Date;
}

export interface Magazyn {
  obiekty: Map<string, ObiektMagazynu>;
  /** Polecenia po kolei: `PUT klucz`, `GET klucz`, `HEAD klucz`, `DELETE klucz`, `LIST prefiks`. */
  wywolania: string[];
  /** Wymuszony błąd polecenia (`PUT`, `GET`, `HEAD`, `DELETE`, `LIST`) dla wszystkich albo jednego klucza. */
  awarie: Map<string, Error>;
  /** Wołane przed wykonaniem polecenia (np. zmiana w bazie „w międzyczasie”). */
  przed?: (polecenie: string, klucz: string) => void | Promise<void>;
}

export function nowyMagazyn(): Magazyn {
  return { obiekty: new Map(), wywolania: [], awarie: new Map() };
}

function brak(klucz: string): Error {
  return new NoSuchKey({ message: `NoSuchKey: ${klucz}`, $metadata: { httpStatusCode: 404 } });
}

export function bladMagazynu(kod = 'InternalError', status = 500): Error {
  return new S3ServiceException({ name: kod, $fault: 'server', $metadata: { httpStatusCode: status }, message: kod });
}

export function klientMagazynu(m: Magazyn) {
  return {
    async send(command: unknown): Promise<unknown> {
      const nazwa =
        command instanceof PutObjectCommand ? 'PUT'
          : command instanceof GetObjectCommand ? 'GET'
            : command instanceof HeadObjectCommand ? 'HEAD'
              : command instanceof DeleteObjectCommand ? 'DELETE'
                : command instanceof ListObjectsV2Command ? 'LIST'
                  : 'INNE';
      const input = (command as { input: Record<string, unknown> }).input;
      const klucz = String(nazwa === 'LIST' ? input.Prefix : input.Key);
      m.wywolania.push(`${nazwa} ${klucz}`);
      await m.przed?.(nazwa, klucz);
      const awaria = m.awarie.get(`${nazwa} ${klucz}`) ?? m.awarie.get(nazwa);
      if (awaria) throw awaria;
      switch (nazwa) {
        case 'PUT': {
          if (input.IfNoneMatch === '*' && m.obiekty.has(klucz)) {
            throw new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: { httpStatusCode: 412 }, message: 'PreconditionFailed' });
          }
          m.obiekty.set(klucz, {
            body: Buffer.from(input.Body as Uint8Array),
            contentType: input.ContentType as string | undefined,
            cacheControl: input.CacheControl as string | undefined,
            metadata: input.Metadata as Record<string, string> | undefined,
            lastModified: new Date(),
          });
          return { ETag: '"etag"' };
        }
        case 'GET':
        case 'HEAD': {
          const obiekt = m.obiekty.get(klucz);
          if (!obiekt) throw brak(klucz);
          const wynik = { ContentLength: obiekt.body.length, ContentType: obiekt.contentType, Metadata: obiekt.metadata ?? {} };
          if (nazwa === 'HEAD') return wynik;
          const kopia = Buffer.from(obiekt.body);
          return { ...wynik, Body: { transformToByteArray: async () => new Uint8Array(kopia) } };
        }
        case 'DELETE':
          // S3 i MinIO odpowiadają 204 także bez obiektu.
          m.obiekty.delete(klucz);
          return {};
        case 'LIST': {
          const Contents = [...m.obiekty.entries()]
            .filter(([k]) => k.startsWith(klucz))
            .map(([Key, o]) => ({ Key, LastModified: o.lastModified, Size: o.body.length }));
          return { Contents, IsTruncated: false };
        }
        default:
          throw new Error('atrapa magazynu: nieznane polecenie');
      }
    },
  };
}

export const KONFIGURACJA_MAGAZYNU = {
  accountId: 'test',
  accessKeyId: 'test',
  secretAccessKey: 'test',
  bucketName: 'faktway-test',
  endpoint: 'https://magazyn.test',
};
