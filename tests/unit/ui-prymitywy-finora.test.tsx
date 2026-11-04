import { renderToStaticMarkup } from 'react-dom/server'
import { Inbox } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'

/**
 * Etap E1 (plan Finora): prymitywy Base UI zastąpiły Radix. Test pilnuje
 * kontraktu, na którym polegają stare ekrany i e2e.
 */
describe('prymitywy UI z szablonu Finora', () => {
  it('Button renderuje <button type="button"> z data-slot, data-variant i data-size', () => {
    const html = renderToStaticMarkup(<Button variant="secondary" size="sm">OK</Button>)
    expect(html).toMatch(/^<button\b/)
    expect(html).toContain('type="button"')
    expect(html).toContain('data-slot="button"')
    expect(html).toContain('data-variant="secondary"')
    expect(html).toContain('data-size="sm"')
  })

  it('warianty glass i glass-primary mają klasy outline i default z Finora', () => {
    const glass = renderToStaticMarkup(<Button variant="glass">A</Button>)
    const primary = renderToStaticMarkup(<Button variant="glass-primary">B</Button>)
    const outline = renderToStaticMarkup(<Button variant="outline">C</Button>)
    const def = renderToStaticMarkup(<Button>D</Button>)
    expect(glass).toContain('border-border bg-background hover:bg-muted')
    expect(glass).toContain('dark:bg-input/30')
    expect(outline).toContain('border-border bg-background hover:bg-muted')
    expect(primary).toContain('bg-primary text-primary-foreground hover:bg-primary/80')
    expect(def).toContain('bg-primary text-primary-foreground hover:bg-primary/80')
  })

  it('EmptyState z akcją-linkiem daje <a href> bez role="button"', () => {
    const html = renderToStaticMarkup(
      <EmptyState
        icon={Inbox}
        title="Brak faktur"
        primaryAction={{ type: 'link', label: 'Dodaj fakturę', href: '/invoices/new' }}
      />,
    )
    expect(html).toMatch(/<a [^>]*href="\/invoices\/new"/)
    expect(html).not.toContain('role="button"')
  })

  it('Input ma klasę 16px dla wskaźnika dotykowego (iOS nie powiększa pola)', () => {
    const html = renderToStaticMarkup(<Input />)
    expect(html).toContain('[@media(pointer:coarse)]:text-[16px]')
    expect(html).toContain('[@media(pointer:coarse)]:min-h-[44px]')
  })
})
