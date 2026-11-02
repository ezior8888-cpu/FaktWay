/**
 * Taksonomia eventów analitycznych (Faza 31 Krok 2).
 *
 * Jedno źródło prawdy dla nazw eventów — `track()` (client) i
 * `trackServer()` (server) przyjmują tylko `AnalyticsEventName`, więc
 * literówka nie przejdzie typechecka, a PostHog nie zaśmieca się
 * wariantami tej samej nazwy.
 *
 * Eventy pogrupowane w 6 kategoriach lejka (pirate metrics):
 *   acquisition → activation → engagement → revenue → retention → churn.
 *
 * Properties są luźne (`AnalyticsProperties`) — oczekiwane pola każdego
 * eventu opisuje `docs/analytics/event-dictionary.md` (Krok 8).
 */

export const ANALYTICS_EVENTS = {
  // ── Acquisition ──────────────────────────────────────────────
  pageView: 'page_view',
  signupStarted: 'signup_started',
  signupCompleted: 'signup_completed',
  loginCompleted: 'login_completed',
  marketingCtaClicked: 'marketing_cta_clicked',

  // ── Activation ───────────────────────────────────────────────
  onboardingStarted: 'onboarding_started',
  onboardingStepCompleted: 'onboarding_step_completed',
  onboardingCompleted: 'onboarding_completed',
  ksefConfigured: 'ksef_configured',
  firstInvoiceSent: 'first_invoice_sent',
  firstOcrScan: 'first_ocr_scan',
  magicImportStarted: 'magic_import_started',
  magicImportCompleted: 'magic_import_completed',

  // ── Engagement ───────────────────────────────────────────────
  dashboardViewed: 'dashboard_viewed',
  invoiceCreated: 'invoice_created',
  invoiceSent: 'invoice_sent',
  invoiceAccepted: 'invoice_accepted',
  invoiceRejected: 'invoice_rejected',
  invoiceCorrectionCreated: 'invoice_correction_created',
  invoiceOfflineQueued: 'invoice_offline_queued',
  invoiceMarkedPaid: 'invoice_marked_paid',
  expenseAdded: 'expense_added',
  ocrScanCompleted: 'ocr_scan_completed',
  contractorAdded: 'contractor_added',
  reportExported: 'report_exported',
  kpirViewed: 'kpir_viewed',
  reminderConfigured: 'reminder_configured',
  reminderSent: 'reminder_sent',
  accountantInvited: 'accountant_invited',
  accountantPortalUsed: 'accountant_portal_used',
  teamMemberInvited: 'team_member_invited',
  organizationCreated: 'organization_created',
  organizationSwitched: 'organization_switched',
  helpArticleViewed: 'help_article_viewed',
  supportChatStarted: 'support_chat_started',
  supportChatMessageSent: 'support_chat_message_sent',
  supportEscalated: 'support_escalated',
  twoFactorEnabled: 'two_factor_enabled',
  pwaInstalled: 'pwa_installed',

  // ── Revenue ──────────────────────────────────────────────────
  trialStarted: 'trial_started',
  trialEnded: 'trial_ended',
  checkoutStarted: 'checkout_started',
  checkoutCompleted: 'checkout_completed',
  paymentSucceeded: 'payment_succeeded',
  paymentFailed: 'payment_failed',
  subscriptionCreated: 'subscription_created',
  subscriptionRenewed: 'subscription_renewed',
  planChanged: 'plan_changed',

  // ── Retention ────────────────────────────────────────────────
  sessionStarted: 'session_started',
  featureUsed: 'feature_used',
  reengagementClicked: 'reengagement_clicked',

  // ── Churn ────────────────────────────────────────────────────
  subscriptionCanceled: 'subscription_canceled',
  paymentChurn: 'payment_churn',
  accountDeletionRequested: 'account_deletion_requested',
  accountDeleted: 'account_deleted',
} as const;

export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

/** Wartości properties — proste typy, serializowalne do PostHog. */
export type AnalyticsProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

export type AnalyticsCategory =
  | 'acquisition'
  | 'activation'
  | 'engagement'
  | 'revenue'
  | 'retention'
  | 'churn';

/**
 * Mapa event → kategoria. Używana w Slack digeście (Krok 7) do grupowania
 * metryk oraz w event dictionary. Każdy event MUSI tu być — brak wpisu
 * to sygnał, że taksonomia i mapa się rozjechały.
 */
export const EVENT_CATEGORY: Record<AnalyticsEventName, AnalyticsCategory> = {
  page_view: 'acquisition',
  signup_started: 'acquisition',
  signup_completed: 'acquisition',
  login_completed: 'acquisition',
  marketing_cta_clicked: 'acquisition',

  onboarding_started: 'activation',
  onboarding_step_completed: 'activation',
  onboarding_completed: 'activation',
  ksef_configured: 'activation',
  first_invoice_sent: 'activation',
  first_ocr_scan: 'activation',
  magic_import_started: 'activation',
  magic_import_completed: 'activation',

  dashboard_viewed: 'engagement',
  invoice_created: 'engagement',
  invoice_sent: 'engagement',
  invoice_accepted: 'engagement',
  invoice_rejected: 'engagement',
  invoice_correction_created: 'engagement',
  invoice_offline_queued: 'engagement',
  invoice_marked_paid: 'engagement',
  expense_added: 'engagement',
  ocr_scan_completed: 'engagement',
  contractor_added: 'engagement',
  report_exported: 'engagement',
  kpir_viewed: 'engagement',
  reminder_configured: 'engagement',
  reminder_sent: 'engagement',
  accountant_invited: 'engagement',
  accountant_portal_used: 'engagement',
  team_member_invited: 'engagement',
  organization_created: 'engagement',
  organization_switched: 'engagement',
  help_article_viewed: 'engagement',
  support_chat_started: 'engagement',
  support_chat_message_sent: 'engagement',
  support_escalated: 'engagement',
  two_factor_enabled: 'engagement',
  pwa_installed: 'engagement',

  trial_started: 'revenue',
  trial_ended: 'revenue',
  checkout_started: 'revenue',
  checkout_completed: 'revenue',
  payment_succeeded: 'revenue',
  payment_failed: 'revenue',
  subscription_created: 'revenue',
  subscription_renewed: 'revenue',
  plan_changed: 'revenue',

  session_started: 'retention',
  feature_used: 'retention',
  reengagement_clicked: 'retention',

  subscription_canceled: 'churn',
  payment_churn: 'churn',
  account_deletion_requested: 'churn',
  account_deleted: 'churn',
};
