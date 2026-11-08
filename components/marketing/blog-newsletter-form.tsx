'use client';

import { useState, useTransition } from 'react';

import { subscribeNewsletterAction } from '@/app/actions/newsletter';

/**
 * NIEPODPIĘTY (przegląd prawny 22.10.2026): żaden ekran nie używa tego
 * formularza i tak ma zostać, dopóki newsletter nie ma potwierdzenia zapisu
 * (double opt-in), zapisu wersji zgody i linku wypisu w każdej wiadomości —
 * klauzula niżej obiecuje „link w wiadomości”, a wysyłki nie ma.
 * Pilnuje tego tests/unit/newsletter-wstrzymany.test.ts.
 */
export function BlogNewsletterForm() {
  const [email, setEmail] = useState('');
  // Honeypot — pole niewidoczne dla człowieka; wypełnia je tylko bot.
  const [website, setWebsite] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await subscribeNewsletterAction({ email, website });
      if (result.success) {
        setDone(true);
      } else {
        setError(result.error);
      }
    });
  }

  if (done) {
    return (
      <p className="text-sm leading-relaxed text-muted-foreground">
        Dziękujemy! Jesteś na liście — odezwiemy się, gdy pojawi się coś
        wartego Twojej uwagi.
      </p>
    );
  }

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <label htmlFor="blog-newsletter-email" className="sr-only">
        Twój e-mail
      </label>
      <input
        id="blog-newsletter-email"
        name="email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(ev) => setEmail(ev.target.value)}
        placeholder="Twój e-mail"
        className="w-full rounded-full bg-card px-4 py-3 text-sm text-foreground ring-1 ring-border outline-none transition placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
      />
      {/* Honeypot: poza viewportem + poza tab-order; nie `display:none`,
          bo część botów pomija pola niewidoczne w CSSOM. */}
      <input
        type="text"
        name="website"
        value={website}
        onChange={(ev) => setWebsite(ev.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute -left-[9999px] h-0 w-0 opacity-0"
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
      >
        {pending ? 'Zapisuję…' : 'Zapisz się'}
      </button>
      {/* Obowiązek informacyjny przy zbieraniu adresu (art. 13 RODO) — skrót
          z odesłaniem; kliknięcie „Zapisz się” jest wyraźnym działaniem
          potwierdzającym zgodę na newsletter. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Klikając „Zapisz się”, zgadzasz się na otrzymywanie newslettera FaktWay
        e-mailem. Zgodę wycofasz w każdej chwili linkiem w wiadomości.
        Administrator i Twoje prawa:{' '}
        <a href="/legal/polityka-prywatnosci" className="underline underline-offset-2">
          polityka prywatności
        </a>
        .
      </p>
    </form>
  );
}
