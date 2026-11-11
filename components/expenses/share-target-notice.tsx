import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { shareTargetNoticeText, type ShareTargetNotice } from '@/lib/expenses/share-target-notice';

/**
 * Komunikat po odmowie udostępnienia pliku z telefonu (`/share-target`, plan
 * skalowania, sesja 31): co się stało, że pliku nie zapisaliśmy i co zrobić.
 * Treść z `lib/expenses/share-target-notice.ts`, z adresu tylko kod i liczby.
 */
export function ShareTargetNoticeAlert({ notice }: { notice: ShareTargetNotice }) {
  const { title, body } = shareTargetNoticeText(notice);
  return (
    <Alert variant="destructive" data-testid="udostepnienie-komunikat">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{body}</AlertDescription>
    </Alert>
  );
}
