import { AlertTriangle, CheckCircle2, CloudOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { HealthLogEntry } from '@/lib/admin/system';

/**
 * Wykres KSeF health 24h jako kompozycja kolorowych segmentów. Każdy segment
 * odpowiada przedziałowi czasu w którym poziom zdrowia był taki sam — `down`
 * jest czerwony, `degraded` żółty, `operational` zielony.
 *
 * Bez bibliotek wykresowych — czysty SVG/divy, server-component-safe.
 */

const LEVEL_COLORS = {
  operational: 'bg-emerald-500/70',
  degraded: 'bg-amber-500/70',
  down: 'bg-red-500/80',
} as const;

const LEVEL_BORDER = {
  operational: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400',
  degraded: 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400',
  down: 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400',
} as const;

interface Props {
  entries: HealthLogEntry[];
  windowHours: number;
}

export function HealthTimeline({ entries, windowHours }: Props) {
  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-glass-border bg-foreground/3 p-8 backdrop-blur-glass text-center">
        <CheckCircle2 className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-sm text-muted-foreground">
          Brak wpisów w ostatnich {windowHours}h.
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Pierwsze pojawią się gdy cron health monitor wykryje zmianę levelu
          lub po 5min heartbeat.
        </p>
      </div>
    );
  }

  // Zbuduj segmenty: każde przejście level → level robi segment.
  // eslint-disable-next-line react-hooks/purity -- komponent serwerowy: renderuje się raz na żądanie, „teraz” to wejście, nie stan
  const end = Date.now();
  const start = end - windowHours * 60 * 60 * 1000;
  const totalMs = end - start;

  const segments: Array<{
    startMs: number;
    endMs: number;
    level: HealthLogEntry['level'];
    sample: HealthLogEntry;
  }> = [];

  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i]!;
    const next = entries[i + 1];
    const startEntry = new Date(cur.recordedAt).getTime();
    const endEntry = next ? new Date(next.recordedAt).getTime() : end;
    segments.push({
      startMs: startEntry,
      endMs: endEntry,
      level: cur.level,
      sample: cur,
    });
  }

  // Stats: incident count + total downtime
  const incidents = entries.filter((e, i) => {
    if (e.level !== 'down') return false;
    return i === 0 || entries[i - 1]!.level !== 'down';
  }).length;

  const downtimeMs = segments
    .filter((s) => s.level === 'down')
    .reduce((sum, s) => sum + (s.endMs - s.startMs), 0);

  const downtimeMin = Math.round(downtimeMs / 60_000);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard
          label={`Wpisów (${windowHours}h)`}
          value={String(entries.length)}
        />
        <SummaryCard
          label="Incydenty (DOWN)"
          value={String(incidents)}
          tone={incidents > 0 ? 'warning' : 'default'}
        />
        <SummaryCard
          label="Downtime"
          value={downtimeMin > 0 ? `${downtimeMin} min` : '0 min'}
          tone={downtimeMin > 0 ? 'warning' : 'default'}
        />
      </div>

      {/* Timeline bar — proporcjonalne segmenty z absolute positioning */}
      <div
        role="img"
        aria-label={`KSeF health timeline ostatnich ${windowHours}h`}
        className="relative h-10 overflow-hidden rounded-xl border border-glass-border bg-foreground/5"
      >
        {segments.map((seg) => {
          const segStart = Math.max(seg.startMs, start);
          const segEnd = Math.min(seg.endMs, end);
          if (segEnd <= segStart) return null;
          const leftPct = ((segStart - start) / totalMs) * 100;
          const widthPct = ((segEnd - segStart) / totalMs) * 100;
          const title = `${seg.level.toUpperCase()} · ${new Date(segStart).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })} → ${new Date(segEnd).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}${seg.sample.responseTimeMs ? ` · ${seg.sample.responseTimeMs}ms` : ''}`;
          return (
            <div
              key={seg.sample.recordedAt + seg.level}
              title={title}
              className={cn(
                'absolute top-0 h-full transition-opacity hover:opacity-80',
                LEVEL_COLORS[seg.level],
              )}
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            />
          );
        })}

        {/* Hour grid (co 6h) */}
        {[6, 12, 18].map((h) => {
          const tickMs = start + (h / windowHours) * totalMs;
          const leftPct = ((tickMs - start) / totalMs) * 100;
          return (
            <div
              key={h}
              className="absolute top-0 h-full w-px bg-foreground/10"
              style={{ left: `${leftPct}%` }}
            />
          );
        })}
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
        <span>{new Date(start).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
        <span>Teraz</span>
      </div>

      {/* Recent incidents list */}
      {incidents > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Ostatnie zmiany levelu
          </h3>
          <ul className="space-y-1">
            {entries.slice(-10).reverse().map((e) => {
              const Icon = e.level === 'down' ? CloudOff : e.level === 'degraded' ? AlertTriangle : CheckCircle2;
              return (
                <li
                  key={e.recordedAt + e.level}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border px-3 py-2',
                    LEVEL_BORDER[e.level],
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span className="font-mono text-xs tabular-nums">
                    {new Date(e.recordedAt).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-wider">
                    {e.level}
                  </span>
                  {e.responseTimeMs !== null ? (
                    <span className="text-xs text-muted-foreground">
                      {e.responseTimeMs}ms
                    </span>
                  ) : null}
                  {e.consecutiveFailures > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      ×{e.consecutiveFailures} pod rząd
                    </span>
                  ) : null}
                  {e.error ? (
                    <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                      {e.error}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-glass-border bg-foreground/3 p-3 backdrop-blur-glass',
        tone === 'warning' ? 'border-amber-500/30 bg-amber-500/5' : '',
      )}
    >
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold tracking-tighter-display tabular-nums">
        {value}
      </p>
    </div>
  );
}
