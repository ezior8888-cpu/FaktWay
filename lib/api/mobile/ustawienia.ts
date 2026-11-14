import 'server-only';

import type { NextResponse } from 'next/server';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { UstawieniaOdpowiedz } from '@/lib/api/mobile/kontrakt';
import { MobileUpstreamError, mobileJson } from '@/lib/api/mobile/responses';
import { isSubjectiveVatExemption } from '@/lib/invoices/vat-exemption';
import { hasConfiguredKsefProof } from '@/lib/ksef/claim-environment';
import { reminderSettingsFromRow, type ReminderSettingsRow } from '@/lib/reminders/settings-model';

/**
 * `GET /api/mobile/v1/ustawienia` (plan aplikacji mobilnej, M10b): karty Firma,
 * KSeF i Przypomnienia strony do odczytu, tymi samymi regułami co strona:
 *  - KSeF „połączono” tylko z dowodem w środowisku aplikacji
 *    (`hasConfiguredKsefProof`, jak `settings/ksef/page.tsx` i `wizard-model.ts`);
 *    telefon tego środowiska nie zna, dlatego stan liczy serwer;
 *  - przypomnienia tylko dla właściciela (`getPageContextWithRole('owner')`
 *    na stronie), wartości przez `reminderSettingsFromRow` jak formularz;
 *  - bez zaszyfrowanego certyfikatu (`ksef_credentials_encrypted`), sama flaga.
 * Klient z tokenem telefonu w jego firmie (RLS). Tylko odczyt, więc ponowienie
 * niczego nie zmienia. Zmiany ustawień zostają na stronie.
 */

const KOLUMNY_FIRMY =
  'name, nip, address_json, bank_account, business_started_on, vat_exemption_basis, vat_cash_method, has_ksef_credentials, ksef_certificate_expiry, ksef_verified_at, ksef_verified_environment';

type WierszFirmy = {
  name: string | null;
  nip: string | null;
  address_json: unknown;
  bank_account: string | null;
  business_started_on: string | null;
  vat_exemption_basis: string | null;
  vat_cash_method: boolean | null;
  has_ksef_credentials: boolean | null;
  ksef_certificate_expiry: string | null;
  ksef_verified_at: string | null;
  ksef_verified_environment: string | null;
};

function tekst(w: unknown): string {
  return typeof w === 'string' ? w.trim() : '';
}

function dzien(w: string | null): string | null {
  return w ? w.slice(0, 10) : null;
}

function firmaTelefonu(w: WierszFirmy): UstawieniaOdpowiedz['firma'] {
  const a = typeof w.address_json === 'object' && w.address_json !== null ? (w.address_json as Record<string, unknown>) : {};
  const zwolnienie = tekst(w.vat_exemption_basis) || null;
  return {
    nazwa: tekst(w.name),
    nip: tekst(w.nip),
    adres: { linia1: tekst(a.addressLine1), linia2: tekst(a.addressLine2) },
    rachunek: tekst(w.bank_account) || null,
    rozpoczecie: dzien(w.business_started_on),
    zwolnienie,
    zwolnieniePodmiotowe: isSubjectiveVatExemption(zwolnienie),
    metodaKasowa: Boolean(w.vat_cash_method),
  };
}

function ksefTelefonu(w: WierszFirmy): UstawieniaOdpowiedz['ksef'] {
  const certyfikat = Boolean(w.has_ksef_credentials);
  const potwierdzony = hasConfiguredKsefProof(w.ksef_verified_at, w.ksef_verified_environment);
  return {
    stan: certyfikat && potwierdzony ? 'polaczono' : certyfikat ? 'do_potwierdzenia' : 'brak',
    certyfikatDo: certyfikat && potwierdzony ? dzien(w.ksef_certificate_expiry) : null,
  };
}

function przypomnieniaTelefonu(wiersz: ReminderSettingsRow, nazwaFirmy: string): NonNullable<UstawieniaOdpowiedz['przypomnienia']> {
  const s = reminderSettingsFromRow(wiersz, nazwaFirmy);
  return {
    zapisane: wiersz !== null,
    // Bez wiersza scheduler nie przygotowuje przypomnień (`reminder-scheduler.ts`, `enabled = true`).
    wlaczone: wiersz !== null && s.enabled,
    etapy: [
      { etap: 1, wlaczony: s.stage_1_enabled, dniPoTerminie: s.stage_1_days_after_due },
      { etap: 2, wlaczony: s.stage_2_enabled, dniPoTerminie: s.stage_2_days_after_due },
      { etap: 3, wlaczony: s.stage_3_enabled, dniPoTerminie: s.stage_3_days_after_due },
    ],
    godzina: s.send_hour,
    tylkoDniRobocze: s.send_on_weekdays_only,
    najwiecej: s.max_reminders_per_invoice,
    nadawca: s.sender_name,
    // Jak przy wysyłce: pusty Reply-To zastępuje dawne pole nadawcy.
    odpowiedzNa: s.reply_to_email ?? s.sender_email,
    wstrzymajPoOdpowiedzi: s.pause_on_reply,
    wstrzymajPoCzesciowej: s.pause_on_partial_payment,
  };
}

export async function settingsForMobile(caller: MobileCaller): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa ustawień bez firmy (org: required)');
  const { tenantId, role } = caller.org;
  const wlasciciel = role === 'owner';

  const [firma, przypomnienia] = await Promise.all([
    caller.db.from('tenants').select(KOLUMNY_FIRMY).eq('id', tenantId).maybeSingle(),
    wlasciciel ? caller.db.from('reminder_settings').select('*').eq('tenant_id', tenantId).maybeSingle() : Promise.resolve(null),
  ]);
  if (firma.error || !firma.data) throw new MobileUpstreamError('tenants.read');
  if (przypomnienia?.error) throw new MobileUpstreamError('reminder_settings.read');

  const wiersz = firma.data as unknown as WierszFirmy;
  const odpowiedz: UstawieniaOdpowiedz = {
    firma: firmaTelefonu(wiersz),
    ksef: ksefTelefonu(wiersz),
    przypomnienia: przypomnienia ? przypomnieniaTelefonu((przypomnienia.data ?? null) as ReminderSettingsRow, tekst(wiersz.name)) : null,
  };
  return mobileJson(odpowiedz, 200, caller.headers);
}
