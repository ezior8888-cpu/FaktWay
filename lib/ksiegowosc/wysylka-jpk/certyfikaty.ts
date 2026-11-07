/**
 * Certyfikaty klucza publicznego MF do szyfrowania klucza AES wysyłki JPK
 * (specyfikacja interfejsów usług JPK 5.6.0, rozdział 1.2.3). Pliki są
 * publiczne: podatki.gov.pl, JPK_VAT z deklaracją, „Pliki do pobrania”.
 *
 * Test: „Certyfikat klucza publicznego dla środowiska testowego” z 9.07.2025
 * (`test_e_dokumenty_mf_gov_pl_certum_2025.zip`, pobrany 7.11.2026 za zgodą
 * Bartosza), CN=jpk@mf.gov.pl, ważny do 7.07.2027.
 *
 * Produkcja: certyfikatu jeszcze tu nie ma (pobranie wymaga zgody, plik
 * `jpk_e_dokumenty_mf_gov_pl_certum_2025.zip` z 18.07.2025). Do tego czasu
 * wysyłka na produkcję odmawia z `BrakCertyfikatuMf`.
 */

import { X509Certificate } from 'node:crypto';

export type SrodowiskoMf = 'test' | 'produkcja';

const CERTYFIKAT_TESTOWY = `-----BEGIN CERTIFICATE-----
MIIGNTCCBB2gAwIBAgIQIwkLMy04HC5dhOoz6Pzn5zANBgkqhkiG9w0BAQsFADBO
MQswCQYDVQQGEwJQTDEhMB8GA1UECgwYQXNzZWNvIERhdGEgU3lzdGVtcyBTLkEu
MRwwGgYDVQQDDBNDZXJ0dW0gU01JTUUgUlNBIENBMB4XDTI1MDcwNzA4NTE1NFoX
DTI3MDcwNzA4NTE1M1owgagxGTAXBgNVBGETEFZBVFBMLTUyNjAyNTAyNzQxCzAJ
BgNVBAYTAlBMMRQwEgYDVQQIDAttYXpvd2llY2tpZTERMA8GA1UEBwwIV2Fyc3ph
d2ExHzAdBgNVBAoMFk1pbmlzdGVyc3R3byBGaW5hbnPDs3cxFjAUBgNVBAMMDWpw
a0BtZi5nb3YucGwxHDAaBgkqhkiG9w0BCQEWDWpwa0BtZi5nb3YucGwwggEiMA0G
CSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCwrcLv+PrmlhhkZn/jJSYpOdkO2j8N
FZh6LEHGDsxibGhAulOeZsFVsQwP09Eetkfm+k4w5wVTuvtzCyOr3RoFon9dsr+y
tWbQfUA89qkVufjapm128dAQJ75w3e0FY/3ZAmjUv5nMVGgxMJeWzs+iiImNpFBO
M7VDJTkjexukfw6SCQpbmEJ2FNX8xp/kcxQhhiBKn45qFG2RA4bVmbJyTYgSk0Gk
ElYn2ayrM7gX/V8d0fycgwafiDGQbassfN5ZvNpm/dPOtPla4m0k6ggBGbg5lzcc
B6Y7Oj4znKLYS8ugcHcCwNAqopGu19+3XqkfepOBdoZ09467V8WeYlwpAgMBAAGj
ggGyMIIBrjAMBgNVHRMBAf8EAjAAMEEGA1UdHwQ6MDgwNqA0oDKGMGh0dHA6Ly9j
c21pbWVyc2FjYS5jcmwuY2VydHVtLnBsL2NzbWltZXJzYWNhLmNybDCBgwYIKwYB
BQUHAQEEdzB1MC4GCCsGAQUFBzABhiJodHRwOi8vY3NtaW1lcnNhY2Eub2NzcC1j
ZXJ0dW0uY29tMEMGCCsGAQUFBzAChjdodHRwOi8vY3NtaW1lcnNhY2EucmVwb3Np
dG9yeS5jZXJ0dW0ucGwvY3NtaW1lcnNhY2EuY2VyMB8GA1UdIwQYMBaAFGb7ww++
9L/gnMmrTd5HGb3AyqZoMB0GA1UdDgQWBBSn1MESD4RBOFRBLhDRLIfg4TiRljBM
BgNVHSAERTBDMAkGB2eBDAEFAgIwNgYLKoRoAYb2dwJkAwEwJzAlBggrBgEFBQcC
ARYZaHR0cHM6Ly93d3cuY2VydHVtLnBsL0NQUzAdBgNVHSUEFjAUBggrBgEFBQcD
BAYIKwYBBQUHAwIwDgYDVR0PAQH/BAQDAgTwMBgGA1UdEQQRMA+BDWpwa0BtZi5n
b3YucGwwDQYJKoZIhvcNAQELBQADggIBACccD1R3W/Xb77K6t6uomOXLXuB154aR
R2eKnJr8DI+qTbkdL+5vT1eTYoN0gwXx6LvCXqF++6jEyzGdcC8ccV3bPdAQlk9b
o6d1ZiPOe4E4MijFR5aJlibx1qPcY5u7xPydbj4vJoqWa2Mivm4sPgOAxgGqdbF1
V7oUHzZxgJaHSiu9bx8k2DMBhkjJuyf4vvWbpEQ5v29HzZqObn3MdI1rrQh2Y02n
8P4t15tnRmLm0Fmx2u9aH41OV4OR04s/ZoVA85QVLv7Mka3zlV7vrXauYVkral9v
H9FcGCybanfT6uQB8EyZLbhACKlt86tP1tTJdnjKL4W++XvGTZ9XDgLqIOdocIeC
rCfGe9PDD71Zi70XtmygDy5+IFC2htaOsGRq3Rt9FZzzlY/KUfkKBaa7LCv5ctAy
PRbHCiei8sxWcjZa89HR5s8K6/vR7Zok0f7r3Y6y/nlcqr2pEo6l8Ia5v2aiqaYn
ML8YQzZSaEPGaYYBjW8f+4LwIervppt0bb53mhPTRhesIEn4yJfahF+O/xyObaFX
RkGR0JmH1peGs9IAW3RXRJ1IoQ79X1uZ0c1ZvSqpNnt5oKx77ttgdLDfT7PKkp+Y
U2F+4q1/Dfzd4ke5RXFB8tG44Pby1Gpe7baGTZgs0goP8h2ciHk3d8vk4pgR0JtD
gGV3VpK9l1+i
-----END CERTIFICATE-----
`;

const CERTYFIKATY: Readonly<Record<SrodowiskoMf, string | null>> = {
  test: CERTYFIKAT_TESTOWY,
  produkcja: null,
};

/**
 * Środowisko wysyłki z `JPK_MF_ENV` („test” albo „produkcja”). Brak zmiennej
 * to brak wysyłki, a nie domyślny test: plik przyjęty na teście nie jest
 * złożoną deklaracją, a klient widziałby „przyjęty”.
 */
export function srodowiskoMf(wartosc: string | undefined = process.env.JPK_MF_ENV): SrodowiskoMf | null {
  return wartosc === 'test' || wartosc === 'produkcja' ? wartosc : null;
}

export class BrakCertyfikatuMf extends Error {
  constructor(readonly srodowisko: SrodowiskoMf, powod: string) {
    super(`Wysyłka JPK (${srodowisko}): ${powod}`);
    this.name = 'BrakCertyfikatuMf';
  }
}

/**
 * Certyfikat do szyfrowania klucza AES. Brak certyfikatu albo certyfikat
 * po terminie to odmowa: MF nie odszyfruje pliku (status 412), a klient
 * dowie się o tym dopiero po kilku minutach.
 */
export function certyfikatMf(srodowisko: SrodowiskoMf, teraz: Date = new Date()): X509Certificate {
  const pem = CERTYFIKATY[srodowisko];
  if (!pem) throw new BrakCertyfikatuMf(srodowisko, 'brak certyfikatu klucza publicznego MF w kodzie');
  const certyfikat = new X509Certificate(pem);
  if (teraz < new Date(certyfikat.validFrom) || teraz > new Date(certyfikat.validTo)) {
    throw new BrakCertyfikatuMf(srodowisko, `certyfikat MF ważny od ${certyfikat.validFrom} do ${certyfikat.validTo}`);
  }
  return certyfikat;
}
