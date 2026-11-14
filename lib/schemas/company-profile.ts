import { z } from 'zod';

import { FA3_TEXT_LIMITS, isXmlSafe, liczbaZnakow, NO_CONTROL_CHARS_MESSAGE } from '@/lib/xml/fa3-limits';

/**
 * Dane firmy edytowane w ustawieniach (F-008): nazwa i adres siedziby trafiają
 * do Podmiot1 każdej kolejnej faktury i do JPK. NIP nie podlega edycji — to
 * tożsamość firmy w KSeF.
 *
 * Granice jak w XSD FA(3) (`Nazwa`, `AdresL1`, `AdresL2` — do 512 znaków, bez
 * znaków sterujących), z modułu granic (C1). Druga linia adresu ma postać
 * „00-000 Miasto”: JPK_FA wyciąga z niej kod pocztowy i miejscowość.
 */

// Znaki sterujące sprawdzamy PRZED zwinięciem spacji — `\s` obejmuje np.
// pionowy tabulator i po cichu by go „naprawił”.
const text = (required: string, max: number) =>
  z
    .string()
    .refine(isXmlSafe, NO_CONTROL_CHARS_MESSAGE)
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1, required).max(max, `Maksymalnie ${liczbaZnakow(max)}`));

export const companyProfileSchema = z.object({
  name: text('Podaj nazwę firmy', FA3_TEXT_LIMITS.nazwa.max),
  addressLine1: text('Podaj ulicę i numer', FA3_TEXT_LIMITS.adresL1.max),
  addressLine2: text('Podaj kod pocztowy i miejscowość', FA3_TEXT_LIMITS.adresL2.max).refine(
    (v) => /^\d{2}-\d{3}\s+\S/.test(v),
    'Kod pocztowy i miejscowość, np. „00-001 Warszawa”',
  ),
});

export type CompanyProfileInput = z.input<typeof companyProfileSchema>;
