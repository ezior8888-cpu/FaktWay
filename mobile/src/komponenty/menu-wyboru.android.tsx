/**
 * Pole wyboru na Androidzie (etap M12, ZASADY-DESIGNU.md, sekcja 10): to samo
 * pole co na iOS (nasza ramka, Outfit, strzałka), a lista opcji to menu
 * Material pod polem (Compose `DropdownMenu` z `@expo/ui`). Wcześniej było tu
 * systemowe pole Material w naszej ramce: podwójna obwódka i czcionka systemu.
 * Wybrana opcja ma napis w kolorze marki.
 */
import { DropdownMenu, DropdownMenuItem, Host, RNHostView, Text as TekstMenu } from '@expo/ui/jetpack-compose';
import { useState } from 'react';

import { DotykFala } from '@/komponenty/dotyk';
import { Ikona } from '@/komponenty/ikona';
import type { MenuWyboruProps } from '@/komponenty/menu-wyboru';
import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';

export type { MenuWyboruProps, OpcjaMenu } from '@/komponenty/menu-wyboru';

export function MenuWyboru<T extends string>({ etykieta, wartosc, opcje, onZmiana, stylPola, stylTekstu }: MenuWyboruProps<T>) {
  const kolory = useKolory();
  const [otwarte, setOtwarte] = useState(false);
  const wybrana = opcje.find((o) => o.wartosc === wartosc);
  return (
    <Host matchContents={{ vertical: true }}>
      <DropdownMenu expanded={otwarte} onDismissRequest={() => setOtwarte(false)} color={kolory.tloKomorki}>
        <DropdownMenu.Trigger>
          <RNHostView matchContents={{ vertical: true }}>
            <DotykFala
              onPress={() => setOtwarte(true)}
              accessibilityRole="button"
              accessibilityLabel={`${etykieta}: ${wybrana?.etykieta ?? 'nie wybrano'}`}
              accessibilityHint="Otwiera listę do wyboru"
              accessibilityState={{ expanded: otwarte }}
              style={stylPola}>
              {/* Do trzech linii: przy największym tekście wartość się zawija zamiast ucinać. */}
              <Tekst styl="body" numberOfLines={3} style={stylTekstu} kolor={wybrana ? 'etykieta' : 'etykietaTrzeciorzedna'}>
                {wybrana?.etykieta ?? 'Wybierz'}
              </Tekst>
              <Ikona nazwa={otwarte ? 'arrow-up-s-line' : 'arrow-down-s-line'} rozmiar={20} kolor={kolory.etykietaDrugorzedna} />
            </DotykFala>
          </RNHostView>
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>
          {opcje.map((o) => (
            <DropdownMenuItem
              key={o.wartosc}
              onClick={() => {
                setOtwarte(false);
                onZmiana(o.wartosc);
              }}>
              <DropdownMenuItem.Text>
                <TekstMenu color={o.wartosc === wartosc ? kolory.akcent : kolory.etykieta}>{o.etykieta}</TekstMenu>
              </DropdownMenuItem.Text>
            </DropdownMenuItem>
          ))}
        </DropdownMenu.Items>
      </DropdownMenu>
    </Host>
  );
}
