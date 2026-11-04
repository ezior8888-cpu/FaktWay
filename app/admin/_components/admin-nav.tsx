'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ActivitySquare,
  ArrowLeft,
  Bot,
  CircleAlert,
  ClipboardList,
  Flag,
  Gauge,
  LifeBuoy,
  Send,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

interface AdminNavLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

const LINKS: AdminNavLink[] = [
  { href: '/admin', label: 'Dashboard', icon: Gauge },
  { href: '/admin/users', label: 'Użytkownicy', icon: Users },
  { href: '/admin/system', label: 'System', icon: ActivitySquare },
  { href: '/admin/ksef', label: 'KSeF — cykl życia', icon: Send },
  { href: '/admin/centrum/bledy', label: 'Błędy wysyłki', icon: CircleAlert },
  { href: '/admin/support', label: 'Support', icon: LifeBuoy },
  { href: '/admin/audit', label: 'Audit log', icon: ClipboardList },
  { href: '/admin/flags', label: 'Feature flags', icon: Flag },
  { href: '/admin/flo', label: 'Flo — tryb cichy', icon: Bot },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Admin navigation"
      className="flex flex-wrap items-center gap-1 rounded-2xl border border-glass-border bg-foreground/3 p-1 backdrop-blur-glass"
    >
      {LINKS.map((link) => {
        const active =
          link.href === '/admin'
            ? pathname === '/admin'
            : pathname.startsWith(link.href);
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              'flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-glass-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">{link.label}</span>
          </Link>
        );
      })}
      <Link
        href="/dashboard"
        className="ml-auto flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Powrót do aplikacji
      </Link>
    </nav>
  );
}
