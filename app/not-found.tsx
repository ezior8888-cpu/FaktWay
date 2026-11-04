import { StatusScreen } from '@/components/site/status-screen';
import { ButtonLink } from '@/components/site/ui';

/**
 * Strona 404 w stylu strony głównej. Bez nagłówka i stopki: z błędu
 * użytkownik ma wrócić na stronę główną albo poszukać w pomocy, a nie
 * zwiedzać serwis.
 */
export default function NotFound() {
  return (
    <StatusScreen
      title="Tej strony u nas nie ma"
      lead="Adres jest nieaktualny albo zawiera literówkę. Wróć na stronę główną, a jeśli czegoś konkretnego szukasz, zajrzyj do pomocy."
      actions={
        <>
          <ButtonLink href="/">Strona główna</ButtonLink>
          <ButtonLink href="/pomoc" variant="outline">
            Centrum pomocy
          </ButtonLink>
        </>
      }
    />
  );
}
