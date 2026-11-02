import { Body, Container, Head, Heading, Html, Text } from '@react-email/components';

export interface SupportEscalationProps {
  conversationId: string;
  userEmail: string | null;
  subject: string | null;
  category: string | null;
}

/**
 * Zgłoszenie dla zespołu: klient kliknął „Połącz z człowiekiem” w czacie
 * pomocy. Wiadomość wewnętrzna, adres do odpowiedzi to adres klienta.
 */
export default function SupportEscalation({
  conversationId,
  userEmail,
  subject,
  category,
}: SupportEscalationProps) {
  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Heading style={headingStyle}>Klient prosi o kontakt z człowiekiem</Heading>
          <Text style={textStyle}>Adres klienta: {userEmail ?? 'brak adresu w koncie'}</Text>
          <Text style={textStyle}>Pierwsze pytanie: {subject ?? 'bez tematu'}</Text>
          <Text style={textStyle}>Kategoria: {category ?? 'bez kategorii'}</Text>
          <Text style={footerStyle}>Rozmowa {conversationId}, całość w /admin/support.</Text>
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
const headingStyle = { color: '#111827', fontSize: '22px', margin: '0 0 24px 0' };
const textStyle = { color: '#374151', fontSize: '16px', lineHeight: '24px' };
const footerStyle = { color: '#6b7280', fontSize: '13px', marginTop: '24px' };
