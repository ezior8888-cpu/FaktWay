/**
 * Resend webhook handler (Faza 26).
 *
 * Setup w Resend Dashboard → Webhooks → Add endpoint:
 *   URL: https://faktway.pl/api/email/resend-webhook
 *   Events subskrybuj: email.bounced, email.complained, email.delivery_delayed
 *
 * Resend używa **Svix** do signature verification (RFC 8037 / JWS-style).
 * Headers: `svix-id`, `svix-timestamp`, `svix-signature`. Body = raw JSON.
 *
 * Decyzje:
 *   - `email.bounced` z `type='hard'` → INSERT + auto-unsubscribe wszystkich
 *     kategorii poza transactional (te i tak Resend zablokuje przez bounce-list).
 *   - `email.bounced` z `type='soft'` → tylko log, nie deactivate (mailbox full
 *     to często chwilowe).
 *   - `email.complained` → INSERT + INSTANT unsubscribe wszystkich kategorii
 *     (włącznie z transactional — reputacja domeny ważniejsza).
 *
 * Idempotency: `email_bounces.resend_event_id` UNIQUE.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import { ALL_CATEGORIES, unsubscribe } from '@/lib/email/preferences';
import { REMINDER_TAG } from '@/lib/email/tags';
import { scanAuthUsers } from '@/lib/auth/auth-users';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

type ResendBounceType = 'hard' | 'soft' | 'undetermined';
type ResendEvent =
  | 'email.bounced'
  | 'email.complained'
  | 'email.delivery_delayed';

interface ResendWebhookPayload {
  type: ResendEvent;
  // Event ID dla idempotency (Resend's `svix-id` header, ale też dostępne w body).
  created_at: string;
  data: {
    email_id?: string;
    from?: string;
    to?: string[];
    subject?: string;
    bounce?: {
      type?: ResendBounceType;
      // Free-text reason ("mailbox_full", "blocked", "no_email", etc.)
      message?: string;
    };
    /** Znaczniki nadane przy wysyłce (`tags`), np. ponaglenie do kontrahenta. */
    tags?: Record<string, string>;
  };
}

/**
 * Mail z ponagleniem trafia do kontrahenta klienta. Jego odbicie albo skarga
 * blokuje adres (lista odbić), ale nie wypisuje użytkownika FaktWay, który
 * przypadkiem ma ten sam adres (AUD-80).
 */
function isReminderToContractor(payload: ResendWebhookPayload): boolean {
  return payload.data.tags?.[REMINDER_TAG.name] === REMINDER_TAG.value;
}

/**
 * Svix signature verification — Resend używa Svix pod spodem.
 * Format: `v1,<base64-signed>` (multiple sigs space-separated).
 * Sygnujemy: `${id}.${timestamp}.${rawBody}` HMAC-SHA256 + base64.
 *
 * Jeśli `RESEND_WEBHOOK_SECRET` nieustawione → odrzucamy (nie chcemy
 * przetwarzać nieautoryzowanych webhook'ów w prod).
 */
function verifySvixSignature(
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  secret: string,
): boolean {
  // A valid old signature remains a replay even after its idempotency row
  // is removed. Svix signs UNIX seconds and permits five minutes of skew.
  if (!/^\d+$/.test(svixTimestamp)) return false;
  const timestamp = Number(svixTimestamp);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(Math.floor(Date.now() / 1000) - timestamp) > WEBHOOK_TOLERANCE_SECONDS
  ) return false;

  // Secret format z Resend: `whsec_<base64>`. Trzeba pominąć prefix.
  const decodedSecret = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice(6), 'base64')
    : Buffer.from(secret, 'base64');

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expectedSig = createHmac('sha256', decodedSecret)
    .update(signedContent)
    .digest('base64');

  // Svix może wysłać kilka signatures (space-separated, format `v1,<b64>`)
  // dla rotation. Wystarczy że jedna pasuje.
  const sigs = svixSignature.split(' ');
  for (const sig of sigs) {
    const parts = sig.split(',');
    if (parts.length !== 2 || parts[0] !== 'v1') continue;
    const sigB64 = parts[1];
    if (!sigB64) continue;

    const expected = Buffer.from(expectedSig, 'base64');
    let received: Buffer;
    try {
      received = Buffer.from(sigB64, 'base64');
    } catch {
      continue;
    }
    if (expected.length !== received.length) continue;
    if (timingSafeEqual(expected, received)) return true;
  }
  return false;
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  const supabase = createAdminClient();
  // Adres jest unikalny w GoTrue — pierwsze trafienie wystarcza. Wszystkie
  // strony, nie pierwsze 200 kont (AUD-125).
  const normalized = email.toLowerCase().trim();
  let match: string | null = null;
  try {
    await scanAuthUsers(supabase, (u) => {
      if (u.email?.toLowerCase() !== normalized) return false;
      match = u.id;
      return true;
    });
  } catch {
    throw new Error('email_opt_out_identity_unavailable');
  }
  return match;
}

async function handleBounce(payload: ResendWebhookPayload, eventId: string) {
  const email = payload.data.to?.[0]?.toLowerCase().trim();
  if (!email) return;

  const bounceType: 'hard' | 'soft' =
    payload.data.bounce?.type === 'hard' ? 'hard' : 'soft';

  const supabase = createAdminClient();

  // Idempotency claim — UNIQUE(resend_event_id) zwraca 23505 przy duplikacie.
  const { error } = await supabase.from('email_bounces').insert({
    email,
    bounce_type: bounceType,
    reason: payload.data.bounce?.message ?? null,
    resend_event_id: eventId,
    // B9 (AUD-81): adres i typ wystarczą — surowe zdarzenie niosło temat
    // i nadawcę maila, których nie potrzebujemy przechowywać.
    raw_payload: null,
  });

  if (error && error.code !== '23505') {
    throw new Error(`bounce insert failed: ${error.message}`);
  }
  // Retry opt-out writes even if the receipt was stored by an earlier attempt.

  if (bounceType === 'hard' && !isReminderToContractor(payload)) {
    // Hard bounce → unsubscribe od product_updates + marketing.
    // Transactional zostają (Resend i tak ich nie wyśle do bounced email'a,
    // ale chcemy żeby user mógł odzyskać konto po naprawie skrzynki).
    const userId = await findUserIdByEmail(email);
    if (userId) {
      await Promise.all([
        unsubscribe({
          userId,
          category: 'product_updates',
          source: 'hard_bounce_auto',
          reason: payload.data.bounce?.message,
        }),
        unsubscribe({
          userId,
          category: 'marketing',
          source: 'hard_bounce_auto',
          reason: payload.data.bounce?.message,
        }),
      ]);
    }
  }
}

async function handleComplaint(payload: ResendWebhookPayload, eventId: string) {
  const email = payload.data.to?.[0]?.toLowerCase().trim();
  if (!email) return;

  const supabase = createAdminClient();
  const { error } = await supabase.from('email_bounces').insert({
    email,
    bounce_type: 'complaint',
    reason: 'Marked as spam by recipient',
    resend_event_id: eventId,
    // B9 (AUD-81): adres i typ wystarczą — surowe zdarzenie niosło temat
    // i nadawcę maila, których nie potrzebujemy przechowywać.
    raw_payload: null,
  });

  if (error && error.code !== '23505') {
    throw new Error(`complaint insert failed: ${error.message}`);
  }
  // Duplicate receipts still retry the idempotent preference writes.

  // Skarga na ponaglenie pochodzi od kontrahenta — adres jest już na
  // liście odbić, użytkownika FaktWay nie wypisujemy.
  if (isReminderToContractor(payload)) return;

  // Complaint = user kliknął "Spam" → INSTANT total unsubscribe.
  // Transactional też wyłączamy — reputacja domeny > convenience.
  const userId = await findUserIdByEmail(email);
  if (userId) {
    await Promise.all(
      ALL_CATEGORIES.map((cat) =>
        unsubscribe({
          userId,
          category: cat,
          source: 'complaint_auto',
        }),
      ),
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  const svixId = req.headers.get('svix-id');
  const svixTimestamp = req.headers.get('svix-timestamp');
  const svixSignature = req.headers.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json(
      { error: 'Missing Svix headers' },
      { status: 400 },
    );
  }

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    Sentry.captureMessage('Resend webhook received but RESEND_WEBHOOK_SECRET missing', {
      level: 'error',
    });
    return NextResponse.json(
      { error: 'Webhook secret not configured' },
      { status: 500 },
    );
  }

  const rawBody = await req.text();
  const valid = verifySvixSignature(
    rawBody,
    svixId,
    svixTimestamp,
    svixSignature,
    secret,
  );
  if (!valid) {
    // Zła signature = anty-DOS, bez Sentry capture.
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let payload: ResendWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as ResendWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    if (payload.type === 'email.bounced') {
      await handleBounce(payload, svixId);
    } else if (payload.type === 'email.complained') {
      await handleComplaint(payload, svixId);
    } else if (payload.type === 'email.delivery_delayed') {
      // Tylko log do email_bounces dla telemetrii — nie deactivate.
      const email = payload.data.to?.[0]?.toLowerCase().trim();
      if (email) {
        const supabase = createAdminClient();
        await supabase.from('email_bounces').insert({
          email,
          bounce_type: 'delivery_delay',
          reason: 'Delivery delayed by recipient mailbox',
          resend_event_id: svixId,
          raw_payload: null,
        });
      }
    }
    return NextResponse.json({ ok: true, type: payload.type });
  } catch (e) {
    const errorId = Sentry.captureException(e, {
      tags: { area: 'resend.webhook' },
      extra: { eventType: payload.type, svixId },
    });
    return NextResponse.json(
      { error: 'Webhook processing failed', errorId },
      { status: 500 },
    );
  }
}
