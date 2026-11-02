import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Section,
  Text,
} from '@react-email/components';

import { paymentFailureAdvice } from '@/lib/billing/payment-failure';

import { EmailLogo } from './EmailLogo';

export interface PaymentFailedProps {
  appUrl: string;
  tenantName: string;
  /** Kwota brutto w PLN (np. "60,27 zł"). */
  amountLabel: string;
  /** Kod odmowy albo błąd z Stripe (`failure_reason`); klient widzi tylko znane kody. */
  failureReason: string | null;
}

/**
 * Faza 25 Krok 5 — dunning email po `invoice.payment_failed`.
 *
 * Strategia: 1 email natychmiast + link do Customer Portal, żeby user mógł
 * zmienić metodę płatności. Stripe sam robi smart retries, więc nie wysyłamy
 * follow-upów. Treść zależy od kodu odmowy: bank bez BLIK-a cyklicznego nie
 * zapłaci przy kolejnej próbie, więc taki mail od razu każe zmienić metodę.
 */
export default function PaymentFailed({
  appUrl,
  tenantName,
  amountLabel,
  failureReason,
}: PaymentFailedProps) {
  const advice = paymentFailureAdvice(failureReason);

  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <EmailLogo />
          <Heading style={headingStyle}>
            Nie udało się pobrać płatności
          </Heading>

          <Text style={textStyle}>
            Cześć {tenantName}, nie udało się pobrać płatności{' '}
            <strong>{amountLabel}</strong> za subskrypcję.
          </Text>

          {advice.reason ? (
            <Section style={boxStyle}>
              <Text style={labelStyle}>Powód</Text>
              <Text style={reasonStyle}>{advice.reason}</Text>
            </Section>
          ) : null}

          <Text style={textStyle}>
            <strong>Co zrobić?</strong> {advice.action}
          </Text>

          <Button href={`${appUrl}/settings/billing`} style={buttonStyle}>
            Zmień metodę płatności
          </Button>

          <Text style={textStyle}>
            Jeśli problem trwa, odpisz na ten email. Pomożemy.
          </Text>

          <Hr style={hrStyle} />

          <Text style={footerStyle}>
            FaktWay — faktury KSeF dla mikrofirm. Wiadomość automatyczna.
          </Text>
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
  color: '#dc2626',
  fontSize: '24px',
  margin: '0 0 24px 0',
};
const textStyle = {
  color: '#374151',
  fontSize: '16px',
  lineHeight: '24px',
  margin: '0 0 16px 0',
};
const boxStyle = {
  backgroundColor: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '8px',
  padding: '20px',
  margin: '24px 0',
};
const labelStyle = {
  color: '#991b1b',
  fontSize: '12px',
  textTransform: 'uppercase' as const,
  margin: 0,
};
const reasonStyle = {
  color: '#7f1d1d',
  fontSize: '14px',
  margin: '4px 0 0 0',
};
const buttonStyle = {
  backgroundColor: '#dc2626',
  color: '#ffffff',
  padding: '12px 24px',
  borderRadius: '6px',
  textDecoration: 'none',
  display: 'inline-block',
  fontWeight: 600 as const,
};
const hrStyle = {
  borderColor: '#e5e7eb',
  margin: '32px 0 16px 0',
};
const footerStyle = {
  color: '#9ca3af',
  fontSize: '12px',
};
