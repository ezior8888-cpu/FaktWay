interface ContentSecurityPolicyOptions {
  production: boolean;
  supabaseUrl?: string;
}

/** Uses the configured self-hosted Supabase origin, including its Realtime socket. */
export function buildContentSecurityPolicy({ production, supabaseUrl }: ContentSecurityPolicyOptions): string {
  const connections = ["'self'", 'https://challenges.cloudflare.com'];
  // Browsers also apply form-action to native POST redirects before hydration.
  // Permit only the configured OAuth backend and the hosted Google/Stripe flows.
  const formActions = [
    "'self'", 'https://accounts.google.com',
    'https://checkout.stripe.com', 'https://billing.stripe.com',
  ];
  if (supabaseUrl) {
    const endpoint = new URL(supabaseUrl);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error('Supabase URL must be an HTTP(S) origin without credentials');
    }
    connections.push(endpoint.origin);
    formActions.push(endpoint.origin);
    connections.push(endpoint.origin.replace(/^http/, 'ws'));
  }
  if (!production) connections.push('ws:', 'http://localhost:*', 'http://127.0.0.1:*');

  return [
    "default-src 'self'",
    // Next's bootstrap still needs inline scripts. Nonces require a separate rollout.
    "script-src 'self' 'unsafe-inline'" + (production ? '' : " 'unsafe-eval'") + ' https://challenges.cloudflare.com',
    // Bez fonts.googleapis.com / fonts.gstatic.com: czcionki i ikony są
    // serwowane z naszej domeny (app/layout.tsx), Google nie dostaje IP.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    'connect-src ' + [...new Set(connections)].join(' '),
    "frame-src 'self' https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    'form-action ' + [...new Set(formActions)].join(' '),
    "object-src 'none'",
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
