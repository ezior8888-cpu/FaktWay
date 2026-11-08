export type PerTenantFlag =
  | 'co_pilot_enabled'
  | 'magic_import_enabled'
  | 'exports_enabled';

export type GlobalFlag =
  | 'killAllKsefSubmissions'
  | 'maintenanceMode'
  | 'disableSignups'
  /** Zatrzymuje CAŁEGO agenta FLO — pierwszy krok runbooku incydentowego. */
  | 'killFloAgent'
  /** AAL2 dla owner/admin przy KSeF, certyfikacie i płatnościach (AUD-65). */
  | 'requireMfaForSensitive'
  /** Zatrzymuje CAŁY moduł księgowości (plan księgowości JDG, D10; wiersz z 00165). */
  | 'killKsiegowosc';
