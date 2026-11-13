/**
 * Teksty numeracji faktur dla klienta (krok 2.5): odmowy RPC 00199 przy
 * zarządzaniu seriami, każda z tym, co zrobić dalej.
 */
import { isPatternProblem, MAX_FIRST_NUMBER, MAX_SERIES_NAME_LENGTH, patternProblemMessage } from '@/lib/numeracja/wzor';

export const SERIES_TEXTS = {
  session: 'Nie udało się zweryfikować sesji. Zaloguj się ponownie i spróbuj jeszcze raz.',
  role: 'Serie numeracji zmienia właściciel albo administrator firmy.',
  unavailable: 'Nie udało się zapisać zmiany numeracji. Spróbuj ponownie za chwilę.',
  name: `Wpisz nazwę serii (od 1 do ${MAX_SERIES_NAME_LENGTH} znaków), np. „Faktury w walucie”.`,
  nameTaken: 'Firma ma już serię o tej nazwie. Wpisz inną nazwę.',
  patternTaken:
    'Inna seria firmy ma ten sam układ numeru (te same litery i znaki poza cyframi), więc numery mogłyby się mylić. Zmień przedrostek, np. FW/ zamiast FV/.',
  firstNumber: `Pierwszy numer to liczba od 1 do ${MAX_FIRST_NUMBER.toLocaleString('pl-PL')}.`,
  kinds: 'Wybierz rodzaje dokumentów z listy.',
  notFound: 'Nie znaleziono tej serii. Odśwież stronę.',
  isDefault:
    'To seria domyślna dla co najmniej jednego rodzaju dokumentu. Najpierw ustaw inną serię jako domyślną, potem ukryj albo usuń tę.',
  used: 'Seria ma już faktury, więc zostaje w historii numeracji. Możesz ją ukryć: nie będzie proponowana w formularzach.',
  defaultRequired: 'Każdy rodzaj dokumentu musi mieć serię domyślną. Ustaw inną serię jako domyślną dla tego rodzaju.',
  archived: 'Ukryta seria nie może być domyślna. Najpierw ją przywróć.',
} as const;

/** Komunikat odmowy RPC 00199 (`code`, przy wzorze także `problem`). */
export function seriesRefusalText(code: string | undefined, problem?: string): string {
  switch (code) {
    case 'name':
      return SERIES_TEXTS.name;
    case 'name_taken':
      return SERIES_TEXTS.nameTaken;
    case 'pattern':
      return isPatternProblem(problem) ? patternProblemMessage(problem) : patternProblemMessage('empty');
    case 'pattern_taken':
      return SERIES_TEXTS.patternTaken;
    case 'first_number':
      return SERIES_TEXTS.firstNumber;
    case 'kinds':
      return SERIES_TEXTS.kinds;
    case 'not_found':
      return SERIES_TEXTS.notFound;
    case 'is_default':
      return SERIES_TEXTS.isDefault;
    case 'used':
      return SERIES_TEXTS.used;
    case 'default_required':
      return SERIES_TEXTS.defaultRequired;
    case 'archived':
      return SERIES_TEXTS.archived;
    default:
      return SERIES_TEXTS.unavailable;
  }
}
