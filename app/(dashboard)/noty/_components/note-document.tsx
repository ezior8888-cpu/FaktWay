import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import {
  formatIbanForPrint,
  NOTE_KIND_LABELS,
  noteAmountSentence,
  type AccountingNote,
  type NoteParty,
} from '@/lib/noty/model';
import { NOTE_BOOKS_NOTICE, NOTE_NOT_INVOICE_NOTICE } from '@/lib/noty/teksty';

/**
 * Podgląd noty na ekranie (krok 2.9, część 1): te same elementy co PDF
 * (`lib/noty/pdf.ts`). Szkic nie ma numeru: nadaje go baza przy wystawieniu.
 * Dla szkicu `issuer` to bieżące dane firmy z profilu; po wystawieniu nota
 * pokazuje dane z chwili wystawienia.
 */

function Party({ heading, party }: { heading: string; party: NoteParty | null }) {
  return (
    <div className='flex flex-col gap-0.5 text-sm'>
      <span className='text-muted-foreground text-xs font-medium'>{heading}</span>
      {party ? (
        <>
          <span className='font-semibold'>{party.name}</span>
          <span>NIP: {party.nip}</span>
          {party.addressLine1 ? <span>{party.addressLine1}</span> : null}
          {party.addressLine2 ? <span>{party.addressLine2}</span> : null}
        </>
      ) : (
        <span className='text-muted-foreground'>Uzupełnij dane firmy w Ustawieniach: nazwę, NIP i adres.</span>
      )}
    </div>
  );
}

export function NoteDocument({ note, issuer }: { note: AccountingNote; issuer: NoteParty | null }) {
  const issued = note.status === 'issued';
  return (
    <Card className='shadow-none'>
      <CardContent className='flex flex-col gap-6'>
        <div className='flex flex-col gap-1'>
          <h2 className='text-xl font-semibold'>{NOTE_KIND_LABELS[note.kind]}</h2>
          {issued && note.number ? (
            <p className='text-sm'>Nr {note.number}</p>
          ) : (
            <p className='text-muted-foreground text-sm'>Szkic: numer nada się przy wystawieniu noty.</p>
          )}
          <p className='text-muted-foreground text-sm'>Data wystawienia: {formatIsoDatePl(note.issueDate)}</p>
        </div>

        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
          <Party heading='Wystawca' party={issued ? note.issuer : issuer} />
          <Party heading='Odbiorca' party={note.counterparty} />
        </div>

        <div className='flex flex-col gap-1 text-sm'>
          <p className='font-medium'>Tytuł: {note.title}</p>
          {note.relatedDocument ? <p className='text-muted-foreground'>Dotyczy: {note.relatedDocument}</p> : null}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className='w-12'>Lp</TableHead>
              <TableHead>Opis</TableHead>
              <TableHead className='text-right'>Kwota (PLN)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {note.items.map((item, index) => (
              <TableRow key={index}>
                <TableCell>{index + 1}</TableCell>
                <TableCell className='whitespace-normal'>{item.description}</TableCell>
                <TableCell className='text-right tabular-nums'>{formatPlMoney(item.amount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className='flex flex-col gap-1 text-sm'>
          <p className='text-right text-base font-semibold'>Razem: {formatPlMoney(note.total)} PLN</p>
          <p>{noteAmountSentence(note.kind, note.total)}</p>
          {note.kind === 'debit' && note.dueDate ? <p>Termin zapłaty: {formatIsoDatePl(note.dueDate)}</p> : null}
          {note.kind === 'debit' && note.bankAccount ? (
            <p>Numer rachunku: {formatIbanForPrint(note.bankAccount)}</p>
          ) : null}
        </div>

        <Alert>
          <AlertDescription className='flex flex-col gap-1'>
            <span className='font-medium'>{NOTE_NOT_INVOICE_NOTICE}</span>
            <span>{NOTE_BOOKS_NOTICE}</span>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
