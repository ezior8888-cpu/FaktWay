import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Text,
} from '@react-email/components';

import { EmailLogo } from './EmailLogo';

import { DUPLICATE_DECISION_TEXTS, type DuplicateNoticeVariant } from '@/lib/ksef/duplicate-decision';

/**
 * „Faktura … czeka na Twoją decyzję” (D-A4-1b-3 PR B, spec §2.8, teksty 2.11.C):
 * KSeF ma już fakturę firmy o numerze tego dokumentu, a FaktWay nie
 * rozstrzygnął, czy to ta sama sprzedaż. Teksty: `DUPLICATE_DECISION_TEXTS.NOTICE`
 * (przegląd prawnika przed KSeF PROD — decyzje Bartosza 07.10.2026 (A), (8)).
 *
 * PR C (spec v3 5.7): cztery warianty z tej samej oferty co panel (`duplicateNoticeVariant`):
 * `pair` (teksty PR B), `record` (zapis faktury z KSeF), `released` (po oddaniu decyzji przez
 * operatora) i `review` („sprawdzamy fakturę z KSeF” — klient nie decyduje); teksty
 * `DUPLICATE_DECISION_TEXTS.FAKTFLOW.NOTICE_*`.
 */
export interface InvoiceDuplicateDecisionProps {
  invoiceId: string;
  invoiceNumber: string;
  ksefNumber: string;
  /** Przypomnienie operatora („Przypomnij klientowi”) — inny temat i nagłówek. */
  reminder: boolean;
  /** Wariant powiadomienia; brak = `pair` (powody PR B). */
  variant?: DuplicateNoticeVariant;
  appUrl: string;
}

/** Temat e-maila (i nagłówek): `review` ma własny, reszta — „czeka na Twoją decyzję” / „Przypomnienie: …”. */
export function duplicateDecisionSubject(variant: DuplicateNoticeVariant, reminder: boolean, invoiceNumber: string): string {
  if (variant === 'review') return DUPLICATE_DECISION_TEXTS.FAKTFLOW.NOTICE_REVIEW_SUBJECT(invoiceNumber);
  const T = DUPLICATE_DECISION_TEXTS.NOTICE;
  return reminder ? T.REMINDER_SUBJECT(invoiceNumber) : T.SUBJECT(invoiceNumber);
}

/** Treść e-maila według wariantu. */
export function duplicateDecisionBody(variant: DuplicateNoticeVariant, invoiceNumber: string, ksefNumber: string): string {
  const FF = DUPLICATE_DECISION_TEXTS.FAKTFLOW;
  switch (variant) {
    case 'record':
      return FF.NOTICE_BODY_RECORD(invoiceNumber, ksefNumber);
    case 'released':
      return FF.NOTICE_BODY_RELEASED(invoiceNumber, ksefNumber);
    case 'review':
      return FF.NOTICE_BODY_REVIEW(invoiceNumber, ksefNumber);
    default:
      return DUPLICATE_DECISION_TEXTS.NOTICE.BODY(invoiceNumber, ksefNumber);
  }
}

export default function InvoiceDuplicateDecision({
  invoiceId,
  invoiceNumber,
  ksefNumber,
  reminder,
  variant = 'pair',
  appUrl,
}: InvoiceDuplicateDecisionProps) {
  const T = DUPLICATE_DECISION_TEXTS.NOTICE;
  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <EmailLogo />
          <Heading style={headingStyle}>{duplicateDecisionSubject(variant, reminder, invoiceNumber)}</Heading>

          <Text style={textStyle}>{duplicateDecisionBody(variant, invoiceNumber, ksefNumber)}</Text>

          <Button href={`${appUrl}/invoices/${invoiceId}`} style={buttonStyle}>
            {T.BUTTON}
          </Button>

          <Hr style={hrStyle} />

          <Text style={footerStyle}>Wiadomość automatyczna z systemu FaktWay.</Text>
        </Container>
      </Body>
    </Html>
  );
}

const bodyStyle = {
  backgroundColor: '#f6f6f6',
  fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
};
const containerStyle = {
  backgroundColor: '#ffffff',
  maxWidth: '600px',
  margin: '40px auto',
  padding: '40px',
  borderRadius: '8px',
};
const headingStyle = {
  color: '#b45309',
  fontSize: '22px',
  margin: '0 0 24px 0',
};
const textStyle = {
  color: '#374151',
  fontSize: '16px',
  lineHeight: '24px',
};
const buttonStyle = {
  backgroundColor: '#b45309',
  color: '#ffffff',
  padding: '12px 24px',
  borderRadius: '6px',
  textDecoration: 'none',
  display: 'inline-block',
};
const hrStyle = {
  borderColor: '#e5e7eb',
  margin: '32px 0 16px 0',
};
const footerStyle = {
  color: '#9ca3af',
  fontSize: '12px',
};
