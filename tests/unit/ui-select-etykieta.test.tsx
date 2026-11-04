import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Select, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BUYER_ID_TYPE_LABELS } from '@/types/invoice-types';

// E1: Base UI pokazuje w SelectValue surową wartość, jeśli Root nie dostał `items`.
describe('Select (Base UI) — etykieta zamiast surowej wartości', () => {
  it('metoda płatności: "Przelew", nie "transfer"', () => {
    const html = renderToStaticMarkup(
      <Select
        value="transfer"
        items={[
          { value: 'transfer', label: 'Przelew' },
          { value: 'cash', label: 'Gotówka' },
        ]}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
      </Select>,
    );
    expect(html).toContain('Przelew');
    expect(html).not.toContain('>transfer<');
  });

  it('typ identyfikatora konsumenta: "PESEL", nie "pesel"', () => {
    const html = renderToStaticMarkup(
      <Select
        value="pesel"
        items={(['pesel', 'id_card'] as const).map((k) => ({ value: k, label: BUYER_ID_TYPE_LABELS[k] }))}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
      </Select>,
    );
    expect(html).toContain('PESEL');
    expect(html).not.toContain('>pesel<');
  });
});
