/**
 * Wiersze formularza w stylu systemowych ustawień: etykieta po lewej, wartość
 * po prawej (pole tekstowe, wybór z menu, przełącznik). Składa się je w
 * `Sekcja` z `lista.tsx`, dokładnie jak `Wiersz`.
 */
import { Host, Picker } from '@expo/ui';
import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { SegmentedControl } from '@expo/ui/community/segmented-control';
import { StyleSheet, Switch, TextInput, useWindowDimensions, View, type KeyboardTypeOptions } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP, SKALA_PIONOWA } from '@/wyglad/odstepy';
import { STYLE_TEKSTU } from '@/wyglad/typografia';

/** Przy dużym tekście z ustawień pole schodzi pod etykietę, jak `Wiersz` w `lista.tsx`. */
function usePionowo(): boolean {
  return useWindowDimensions().fontScale >= SKALA_PIONOWA;
}

type PoleTekstoweProps = {
  etykieta: string;
  wartosc: string;
  onZmiana: (tekst: string) => void;
  podpowiedz?: string;
  klawiatura?: KeyboardTypeOptions;
  /** Błąd pod polem, jednym zdaniem (ZASADY-DESIGNU.md, sekcja 6). */
  blad?: string;
  wielowierszowe?: boolean;
  /** Hasło: znaki ukryte, podpowiedź pęku kluczy iOS. */
  tajne?: boolean;
};

export function PoleTekstowe({ etykieta, wartosc, onZmiana, podpowiedz, klawiatura, blad, wielowierszowe, tajne }: PoleTekstoweProps) {
  const kolory = useKolory();
  const pionowo = usePionowo();
  const wPionie = wielowierszowe || pionowo;
  return (
    <View>
      <View style={wPionie ? styles.wierszPionowy : styles.wiersz}>
        <Tekst styl="body" style={wPionie ? null : styles.etykieta}>
          {etykieta}
        </Tekst>
        <TextInput
          value={wartosc}
          onChangeText={onZmiana}
          placeholder={podpowiedz}
          placeholderTextColor={kolory.etykietaTrzeciorzedna as string}
          keyboardType={klawiatura}
          multiline={wielowierszowe}
          secureTextEntry={tajne}
          textContentType={tajne ? 'password' : undefined}
          autoCapitalize={tajne || klawiatura === 'email-address' ? 'none' : undefined}
          accessibilityLabel={etykieta}
          style={[
            STYLE_TEKSTU.body,
            styles.wejscie,
            wielowierszowe ? styles.wejscieWielo : pionowo ? styles.wejscieWPionie : styles.wejscieWPrawo,
            { color: kolory.etykieta },
          ]}
        />
      </View>
      {blad ? (
        <Tekst styl="footnote" kolor="blad" style={styles.blad}>
          {blad}
        </Tekst>
      ) : null}
    </View>
  );
}

type Opcja<T extends string> = { wartosc: T; etykieta: string };

type PoleWyboruProps<T extends string> = {
  etykieta: string;
  wartosc: T;
  opcje: Opcja<T>[];
  onZmiana: (wartosc: T) => void;
};

/** Wybór z kilku opcji: systemowe menu (SwiftUI Picker), nie własna lista rozwijana. */
export function PoleWyboru<T extends string>({ etykieta, wartosc, opcje, onZmiana }: PoleWyboruProps<T>) {
  const pionowo = usePionowo();
  return (
    <View style={pionowo ? styles.wierszPionowyStart : styles.wiersz}>
      {/* Etykieta nie oddaje miejsca: długą wartość skraca systemowe menu, a nie słowo w etykiecie. */}
      <Tekst styl="body" style={pionowo ? null : styles.etykietaNieSciskana}>
        {etykieta}
      </Tekst>
      <Host matchContents style={pionowo ? null : styles.wartoscSciskana}>
        <Picker selectedValue={wartosc} onValueChange={(v) => onZmiana(v as T)} appearance="menu">
          {opcje.map((o) => (
            <Picker.Item key={o.wartosc} label={o.etykieta} value={o.wartosc} />
          ))}
        </Picker>
      </Host>
    </View>
  );
}

type PolePrzelacznikProps = {
  etykieta: string;
  opis?: string;
  wartosc: boolean;
  onZmiana: (wartosc: boolean) => void;
};

export function PolePrzelacznik({ etykieta, opis, wartosc, onZmiana }: PolePrzelacznikProps) {
  const kolory = useKolory();
  return (
    <View style={styles.wierszPrzelacznika}>
      <View style={styles.etykietaRozciagnieta}>
        <Tekst styl="body">{etykieta}</Tekst>
        {opis ? (
          <Tekst styl="subheadline" kolor="etykietaDrugorzedna">
            {opis}
          </Tekst>
        ) : null}
      </View>
      <Switch
        value={wartosc}
        onValueChange={onZmiana}
        trackColor={{ true: kolory.akcentWypelnienie as string }}
        accessibilityLabel={etykieta}
      />
    </View>
  );
}

type SegmentyProps = {
  wartosci: string[];
  wybrany: number;
  onZmiana: (indeks: number) => void;
  etykieta: string;
};

/** Przełącznik segmentowy (natywny) z marginesem jak treść listy. */
export function Segmenty({ wartosci, wybrany, onZmiana, etykieta }: SegmentyProps) {
  return (
    <View style={styles.segmenty}>
      <SegmentedControl
        values={wartosci}
        selectedIndex={wybrany}
        onChange={(e) => onZmiana(e.nativeEvent.selectedSegmentIndex)}
        accessibilityLabel={etykieta}
      />
    </View>
  );
}

type PoleDatyProps = {
  etykieta: string;
  /** Data RRRR-MM-DD. */
  wartosc: string;
  onZmiana: (iso: string) => void;
  najwczesniej?: string;
};

function zIso(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

function doIso(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dz = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dz}`;
}

/** Data: systemowy, zwarty wybór daty (kalendarz w dymku na iOS). */
export function PoleDaty({ etykieta, wartosc, onZmiana, najwczesniej }: PoleDatyProps) {
  const pionowo = usePionowo();
  return (
    <View style={pionowo ? styles.wierszPionowyStart : styles.wiersz}>
      <Tekst styl="body" style={pionowo ? null : styles.etykietaRozciagnieta}>
        {etykieta}
      </Tekst>
      <DateTimePicker
        value={zIso(wartosc)}
        mode="date"
        display="compact"
        locale="pl-PL"
        minimumDate={najwczesniej ? zIso(najwczesniej) : undefined}
        onValueChange={(_, d) => onZmiana(doIso(d))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  etykietaRozciagnieta: { flex: 1 },
  etykietaNieSciskana: { flexShrink: 0, maxWidth: '65%' },
  wartoscSciskana: { flexShrink: 1, marginLeft: 'auto' },
  wierszPrzelacznika: {
    minHeight: CEL_DOTYKU + ODSTEP.xs,
    paddingHorizontal: MARGINES,
    paddingVertical: ODSTEP.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ODSTEP.s,
  },
  wiersz: {
    minHeight: CEL_DOTYKU + ODSTEP.xs,
    paddingHorizontal: MARGINES,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ODSTEP.s,
  },
  wierszPionowy: { paddingHorizontal: MARGINES, paddingVertical: ODSTEP.s, gap: ODSTEP.xxs },
  wierszPionowyStart: { paddingHorizontal: MARGINES, paddingVertical: ODSTEP.s, gap: ODSTEP.xs, alignItems: 'flex-start' },
  etykieta: { flexShrink: 1 },
  wejscie: { paddingVertical: ODSTEP.s },
  wejscieWPrawo: { flex: 1, textAlign: 'right' },
  wejscieWPionie: { paddingVertical: ODSTEP.xxs },
  wejscieWielo: { minHeight: CEL_DOTYKU * 2, textAlignVertical: 'top', paddingVertical: 0 },
  blad: { paddingHorizontal: MARGINES, paddingBottom: ODSTEP.xs },
  segmenty: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
