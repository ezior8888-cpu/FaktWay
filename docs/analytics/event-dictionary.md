# Event Dictionary (Faza 31)

Słownik 51 eventów analitycznych. Źródło prawdy: [lib/analytics/events.ts](../../lib/analytics/events.ts).
Nazwy są typed (`AnalyticsEventName`) — TS pilnuje literówek.

Każdy event ma stronę: **client** (z `track()` w komponentach) albo **server**
(z `trackServer()` w Server Actions / Inngest jobs). Server eventy są
wiarygodniejsze — odporne na ad-blockery i nie wymagają zgody.

---

## Acquisition

| Event | Strona | Properties | Wzbudza |
|---|---|---|---|
| `page_view` | client | `$current_url` (auto) | każda zmiana trasy (App Router) |
| `signup_started` | client | `method` | wejście na `/register` |
| `signup_completed` | **server** | `method`: 'password' \| 'google' | po `auth.signUp` sukces (Krok 4) |
| `login_completed` | **server** | `method`: 'password' | po `signInWithPassword` sukces |
| `marketing_cta_clicked` | client | `location`, `target` | kliknięcie CTA na landing/blog/vs |

## Activation

| Event | Strona | Properties | Wzbudza |
|---|---|---|---|
| `onboarding_started` | client | — | pierwszy step kreatora |
| `onboarding_step_completed` | client | `step`, `step_index` | każdy step |
| `onboarding_completed` | client | `tenant_id` | finalizacja kreatora |
| `ksef_configured` | server | `env`: 'test'\|'production' | po wgraniu certyfikatu |
| `first_invoice_sent` | server | `invoice_type`, `ksef_env` | pierwsza faktura per-tenant |
| `first_ocr_scan` | server | — | pierwsze użycie OCR per-tenant |
| `magic_import_started` | server | `source`: 'ksef'\|'csv'\|'xls' | start importu |
| `magic_import_completed` | server | `imported_count`, `duration_ms` | po zakończeniu Inngest joba |

## Engagement

| Event | Strona | Properties | Wzbudza |
|---|---|---|---|
| `dashboard_viewed` | client | — | wejście na `/dashboard` |
| `invoice_created` | server | `invoice_type`, `is_draft` | INSERT do `invoices` |
| `invoice_sent` | server | `invoice_type`, `ksef_env` | submit do KSeF |
| `invoice_accepted` | **server** | `ksef_env`, `internal_number` | KSeF przyjął (Krok 4) |
| `invoice_rejected` | server | `error_code` | KSeF odrzucił |
| `invoice_correction_created` | server | `parent_invoice_id` | korekta |
| `invoice_offline_queued` | server | `reason` | wpadła do Offline24 |
| `invoice_marked_paid` | server | `tenant_id`, `source`: 'manual', `role` | klient dotknął „Zapłacone” (RPC `mark_invoice_paid`, tylko gdy powstała wpłata; drugie dotknięcie bez zdarzenia) |
| `expense_added` | server | `source`: 'manual'\|'ocr'\|'ksef_inbox' | INSERT do `expenses` |
| `ocr_scan_completed` | server | `vendor_recognized`, `confidence` | po Inngest `processOcrJob` |
| `contractor_added` | server | `source`: 'manual'\|'import' | INSERT do `contractors` |
| `report_exported` | server | `format`: 'jpk_fa'\|'kpir'\|'csv'\|... | po exports-generate |
| `kpir_viewed` | client | `month` | wejście na `/reports/kpir` |
| `reminder_configured` | client | — | włączenie Wkurzacza |
| `reminder_sent` | server | `stage`: 1\|2\|3 | Inngest `sendReminderJob` |
| `accountant_invited` | server | — | wygenerowanie tokenu portalu |
| `accountant_portal_used` | server | `accessed_format` | klik w portalu |
| `team_member_invited` | server | `role` | INSERT do `invitations` |
| `organization_created` | server | — | INSERT do `tenants` |
| `organization_switched` | client | `from_tenant_id`, `to_tenant_id` | switcher w nagłówku |
| `help_article_viewed` | client | `slug`, `category` | `/pomoc/[slug]` |
| `support_chat_started` | **client** | — | pierwsza wiadomość w widgecie (Krok 3) |
| `support_chat_message_sent` | client | `length` | każda kolejna wiadomość usera |
| `support_escalated` | server | `reason`: 'ai_uncertain'\|'user_requested' | eskalacja konwersacji |
| `two_factor_enabled` | server | — | po `verifyTotpEnrollmentAction` |
| `pwa_installed` | client | — | `appinstalled` event |

## Revenue

| Event | Strona | Properties | Wzbudza |
|---|---|---|---|
| `trial_started` | server | `trial_days`: 30 | po `subscription.created` ze statusem `trialing` |
| `trial_ended` | server | `converted`: bool | po `trial_will_end` |
| `checkout_started` | client | `plan`: 'monthly'\|'annual' | klik „Wybierz plan" |
| `checkout_completed` | server | `plan` | po `checkout.session.completed` |
| `payment_succeeded` | **server** | `amount_cents`, `currency`, `stripe_invoice_id` | webhook `invoice.payment_succeeded` (Krok 4) |
| `payment_failed` | **server** | `amount_cents`, `failure_reason` | webhook `invoice.payment_failed` (Krok 4) |
| `subscription_created` | **server** | `status`, `price_id`, `setPerson: plan='active'` | webhook `customer.subscription.created` (Krok 4) |
| `subscription_renewed` | server | `period_start` | webhook update z renewal |
| `plan_changed` | server | `from_plan`, `to_plan` | Customer Portal proration |

## Retention

| Event | Strona | Properties | Wzbudza |
|---|---|---|---|
| `session_started` | client | — | autocapture PostHog (per session) |
| `feature_used` | client | `feature` | helper `trackFeatureUsed()` |
| `reengagement_clicked` | server | `campaign` | klik w email reengagement |

## Churn

| Event | Strona | Properties | Wzbudza |
|---|---|---|---|
| `subscription_canceled` | **server** | `subscription_id`, `setPerson: plan='canceled'` | webhook (Krok 4) |
| `payment_churn` | server | `failed_attempts` | po 3. fail dunning |
| `account_deletion_requested` | server | `scheduled_for` | GDPR `createGdprRequest` |
| `account_deleted` | server | — | po Inngest `gdprProcessDeletions` execute |

---

## Konwencje properties

- **snake_case** dla nazw properties (PostHog konwencja).
- **`amount_cents`** zamiast `amount_pln` — uniknij ułamków.
- **`*_at`** dla timestampów (ISO 8601).
- **`*_id`** dla referencji do tabel.
- Wartości serializowalne: `string | number | boolean | null`.

## Person properties

Ustawiane przez `setPersonProperties` w `trackServer()`:

| Property | Ustawia | Wartość |
|---|---|---|
| `email` | signup_completed, identify | `user.email` |
| `first_name` | signup_completed | parsed z `name` |
| `plan` | signup_completed → `'trial'`; subscription_created → `'active'`; subscription_canceled → `'canceled'` | aktualny plan |

UTM-y są łapane automatycznie przez PostHog autocapture jako
`$initial_utm_source/medium/campaign/term/content`.
