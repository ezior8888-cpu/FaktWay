import { Body, Container, Head, Heading, Hr, Html, Link, Section, Text } from '@react-email/components';

import { EmailLogo } from './EmailLogo';

export interface NewLoginProps {
  /** Data i godzina w Europe/Warsaw, gotowy napis. */
  occurredAt: string;
  /** „iPhone (Safari)” albo „Nieznane urządzenie”. */
  device: string;
  /** Skrócony adres („83.21.104.x”); `null`, gdy nieznany. */
  ip: string | null;
  /** Pełny adres Ustawień, sekcja Bezpieczeństwo. */
  securityUrl: string;
}

/**
 * Mail bezpieczeństwa o logowaniu z nowego urządzenia (krok 8.5, część 2).
 * Kategoria: transactional, bez wyłącznika w ustawieniach.
 */
export default function NewLogin({ occurredAt, device, ip, securityUrl }: NewLoginProps) {
  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <EmailLogo />
          <Heading style={headingStyle}>Nowe logowanie do FaktWay</Heading>
          <Text style={textStyle}>Zalogowano się na Twoje konto z urządzenia, z którego jeszcze się nie logowałeś.</Text>

          <Section style={boxStyle}>
            <Text style={labelStyle}>Data i godzina</Text>
            <Text style={valueStyle}>{occurredAt}</Text>
            <Text style={{ ...labelStyle, marginTop: '12px' }}>Urządzenie</Text>
            <Text style={valueStyle}>{device}</Text>
            {ip ? (
              <>
                <Text style={{ ...labelStyle, marginTop: '12px' }}>Adres IP (skrócony)</Text>
                <Text style={valueStyle}>{ip}</Text>
              </>
            ) : null}
          </Section>

          <Text style={textStyle}>Jeśli to Ty, nic nie musisz robić.</Text>
          <Text style={textStyle}>
            Jeśli to nie Ty, zmień hasło i wyloguj inne urządzenia. Zrobisz to w Ustawieniach, w sekcji Bezpieczeństwo:
          </Text>
          <Text style={textStyle}>
            <Link href={securityUrl} style={buttonStyle}>
              Otwórz Bezpieczeństwo
            </Link>
          </Text>

          <Hr style={hrStyle} />
          <Text style={footerStyle}>FaktWay, faktury KSeF dla mikrofirm. Wiadomość bezpieczeństwa, wysyłana zawsze.</Text>
        </Container>
      </Body>
    </Html>
  );
}

const bodyStyle = { backgroundColor: '#f6f6f6', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' };
const containerStyle = {
  backgroundColor: '#ffffff', maxWidth: '600px', margin: '40px auto', padding: '40px', borderRadius: '8px',
};
const headingStyle = { color: '#111827', fontSize: '24px', margin: '0 0 24px 0' };
const textStyle = { color: '#374151', fontSize: '16px', lineHeight: '24px', margin: '0 0 16px 0' };
const boxStyle = {
  backgroundColor: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '20px', margin: '24px 0',
};
const labelStyle = { color: '#6b7280', fontSize: '12px', textTransform: 'uppercase' as const, margin: 0 };
const valueStyle = { color: '#111827', fontSize: '16px', margin: '4px 0 0 0', fontWeight: 600 as const };
const buttonStyle = {
  display: 'inline-block', padding: '12px 20px', backgroundColor: '#111827', color: '#ffffff',
  borderRadius: '6px', textDecoration: 'none', fontWeight: 600 as const,
};
const hrStyle = { borderColor: '#e5e7eb', margin: '32px 0 16px 0' };
const footerStyle = { color: '#9ca3af', fontSize: '12px' };
