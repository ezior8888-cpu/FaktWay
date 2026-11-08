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

import { EmailLogo } from './EmailLogo';

export interface InvoiceFailedProps {
  invoiceId: string;
  errorMessage: string;
  appUrl: string;
}

export default function InvoiceFailed({
  invoiceId,
  errorMessage,
  appUrl,
}: InvoiceFailedProps) {
  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <EmailLogo />
          <Heading style={headingStyle}>Faktura odrzucona przez KSeF</Heading>

          <Text style={textStyle}>
            Niestety Twoja faktura nie została zaakceptowana. Poniżej szczegóły:
          </Text>

          <Section style={errorBoxStyle}>
            <Text style={errorTextStyle}>{errorMessage}</Text>
          </Section>

          <Text style={textSmallStyle}>
            Popraw fakturę i spróbuj ponownie.
          </Text>

          <Button href={`${appUrl}/invoices/${invoiceId}`} style={buttonStyle}>
            Otwórz fakturę
          </Button>

          <Hr style={hrStyle} />

          <Text style={footerStyle}>
            Wiadomość automatyczna z systemu FaktWay.
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
};
const textSmallStyle = {
  color: '#374151',
  fontSize: '14px',
};
const errorBoxStyle = {
  backgroundColor: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '8px',
  padding: '16px',
  margin: '20px 0',
};
const errorTextStyle = {
  color: '#991b1b',
  fontSize: '14px',
  fontFamily: 'Monaco, monospace',
  margin: 0,
};
const buttonStyle = {
  backgroundColor: '#dc2626',
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
