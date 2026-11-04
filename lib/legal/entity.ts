/**
 * Dane usługodawcy FaktWay — JEDYNE miejsce, z którego czytają je regulamin,
 * polityka prywatności, umowa powierzenia i stopki dokumentów.
 *
 * Dlaczego osobny plik: do 15.10.2026 regulamin i polityka miały wpisane na
 * sztywno „[nazwa firmy], NIP [TWÓJ_NIP]”, a obowiązek z art. 5 ustawy
 * o świadczeniu usług drogą elektroniczną (kto świadczy usługę, adres, NIP,
 * rejestr) nie był spełniony nigdzie. Usługodawca jeszcze nie istnieje
 * formalnie (Stripe i samofakturowanie czekają na firmę — scripts/check-env.ts),
 * więc pola są puste, a dokumenty pokazują je jako „do uzupełnienia”.
 *
 * Co się dzieje, dopóki dane są niepełne (`isLegalEntityComplete() === false`):
 *  - strony /legal/* mają baner „wersja robocza”,
 *  - akceptacja regulaminu zapisuje się z flagą `draft: true` i NIE spełnia
 *    bramki akceptacji (lib/legal/acceptance.ts),
 *  - bramka akceptacji w panelu jest wyłączona — nikt nie akceptuje projektu.
 * Po uzupełnieniu danych bramka włącza się sama i każdy użytkownik raz
 * zaakceptuje finalną wersję. Pilnuje tego test `tests/unit/legal-dokumenty.test.ts`.
 */

import { SUPPORT_EMAIL } from '@/lib/site';

export type LegalForm =
  /** Jednoosobowa działalność gospodarcza (wpis do CEIDG). */
  | 'jdg'
  /** Spółka cywilna — wspólnicy prowadzą działalność, umowę zawierają wspólnicy. */
  | 'spolka_cywilna'
  /** Spółka z ograniczoną odpowiedzialnością (KRS). */
  | 'sp_z_oo'
  /** Prosta spółka akcyjna (KRS). */
  | 'psa';

export interface LegalEntity {
  /** Marka usługi — to widzi klient w aplikacji. */
  brand: string;
  /** Pełna firma (nazwa) przedsiębiorcy, dokładnie jak w CEIDG/KRS. */
  name: string | null;
  legalForm: LegalForm | null;
  /** Ulica i numer. */
  street: string | null;
  postalCode: string | null;
  city: string | null;
  nip: string | null;
  regon: string | null;
  /** Tylko spółki z KRS. */
  krs: string | null;
  /** Np. „Sąd Rejonowy Poznań – Nowe Miasto i Wilda w Poznaniu, VIII Wydział Gospodarczy KRS”. */
  registryCourt: string | null;
  /** Kapitał zakładowy (sp. z o.o.) albo akcyjny (PSA) — art. 206 § 1 KSH wymaga go na stronie. */
  shareCapital: string | null;
  /** Wspólnicy spółki cywilnej — każdy jest stroną umowy. */
  partners: string[];
  /** Adres do korespondencji w sprawach umowy, reklamacji i RODO. */
  email: string;
  /** Telefon nie jest obowiązkowy (art. 5 u.ś.u.d.e. — wystarczy e-mail). */
  phone: string | null;
  /** Domena serwisu. */
  website: string;
}

/**
 * UZUPEŁNIJ przed udostępnieniem dokumentów klientom (lista kontrolna
 * w opisie PR i w memo dla prawnika). Pola `null` = jeszcze nie wiadomo.
 */
export const LEGAL_ENTITY: LegalEntity = {
  brand: 'FaktWay',
  name: null,
  legalForm: null,
  street: null,
  postalCode: null,
  city: null,
  nip: null,
  regon: null,
  krs: null,
  registryCourt: null,
  shareCapital: null,
  partners: [],
  email: SUPPORT_EMAIL,
  phone: null,
  website: 'faktway.pl',
};

/** Pola wymagane zależnie od formy prawnej. */
export function missingLegalEntityFields(entity: LegalEntity = LEGAL_ENTITY): string[] {
  const missing: string[] = [];
  const need = (value: string | null, label: string) => {
    if (!value || !value.trim()) missing.push(label);
  };
  need(entity.name, 'pełna nazwa (firma)');
  if (!entity.legalForm) missing.push('forma prawna');
  need(entity.street, 'ulica i numer');
  need(entity.postalCode, 'kod pocztowy');
  need(entity.city, 'miejscowość');
  need(entity.nip, 'NIP');
  need(entity.regon, 'REGON');
  if (entity.legalForm === 'sp_z_oo' || entity.legalForm === 'psa') {
    need(entity.krs, 'numer KRS');
    need(entity.registryCourt, 'sąd rejestrowy');
    need(entity.shareCapital, 'kapitał zakładowy');
  }
  if (entity.legalForm === 'spolka_cywilna' && entity.partners.length === 0) {
    missing.push('wspólnicy spółki cywilnej');
  }
  return missing;
}

export function isLegalEntityComplete(entity: LegalEntity = LEGAL_ENTITY): boolean {
  return missingLegalEntityFields(entity).length === 0;
}

const PLACEHOLDER = (label: string) => `[DO UZUPEŁNIENIA: ${label}]`;

function orPlaceholder(value: string | null, label: string): string {
  return value && value.trim() ? value : PLACEHOLDER(label);
}

/** Nazwa usługodawcy do zdań w dokumentach. */
export function entityName(entity: LegalEntity = LEGAL_ENTITY): string {
  if (entity.legalForm === 'spolka_cywilna' && entity.partners.length > 0) {
    return `${orPlaceholder(entity.name, 'nazwa spółki cywilnej')} (wspólnicy: ${entity.partners.join(', ')})`;
  }
  return orPlaceholder(entity.name, 'pełna nazwa usługodawcy');
}

export function entityAddress(entity: LegalEntity = LEGAL_ENTITY): string {
  return [
    orPlaceholder(entity.street, 'ulica i numer'),
    `${orPlaceholder(entity.postalCode, 'kod')} ${orPlaceholder(entity.city, 'miejscowość')}`,
  ].join(', ');
}

/**
 * Jedno zdanie identyfikujące usługodawcę — art. 5 ust. 1–2 u.ś.u.d.e.
 * i art. 206 § 1 KSH (dla spółek z KRS).
 */
export function entityIdentification(entity: LegalEntity = LEGAL_ENTITY): string {
  const parts = [
    `${entityName(entity)} z siedzibą (adresem wykonywania działalności): ${entityAddress(entity)}`,
    `NIP ${orPlaceholder(entity.nip, 'NIP')}`,
    `REGON ${orPlaceholder(entity.regon, 'REGON')}`,
  ];
  if (entity.legalForm === 'sp_z_oo' || entity.legalForm === 'psa') {
    parts.push(
      `wpisana do rejestru przedsiębiorców Krajowego Rejestru Sądowego pod numerem KRS ${orPlaceholder(entity.krs, 'KRS')}`,
      `sąd rejestrowy: ${orPlaceholder(entity.registryCourt, 'sąd rejestrowy')}`,
      `${entity.legalForm === 'psa' ? 'kapitał akcyjny' : 'kapitał zakładowy'}: ${orPlaceholder(entity.shareCapital, 'kapitał')}`,
    );
  } else if (entity.legalForm === 'jdg' || entity.legalForm === 'spolka_cywilna') {
    parts.push('wpisany(-a) do Centralnej Ewidencji i Informacji o Działalności Gospodarczej (CEIDG)');
  } else {
    parts.push(PLACEHOLDER('forma prawna i rejestr (CEIDG albo KRS)'));
  }
  parts.push(`adres e-mail: ${entity.email}`);
  if (entity.phone) parts.push(`telefon: ${entity.phone}`);
  return parts.join(', ');
}
