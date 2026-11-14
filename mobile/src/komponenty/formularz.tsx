/**
 * Pola formularza w stylu strony (`components/ui/input.tsx`, `label.tsx`):
 * etykieta nad polem, pole z cienką obwódką, która przy pisaniu płynnie
 * przechodzi w kolor marki. Składa się je w `Sekcja` z `lista.tsx`; pola
 * mają własne odstępy, więc karta nie rysuje między nimi linii (`pole = true`).
 * Listy opcji i kalendarz są systemowe (arkusz akcji, wybór daty).
 */
import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState, type Ref } from 'react';
import { ActionSheetIOS, Platform, Pressable, StyleSheet, Switch, TextInput, View, type KeyboardTypeOptions, type ReturnKeyTypeOptions, type TextInputInstance } from 'react-native';
import Animated, { FadeIn, FadeOut, interpolateColor, LinearTransition, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { DotykFala } from '@/komponenty/dotyk';
import { Ikona } from '@/komponenty/ikona';
import { MenuWyboru } from '@/komponenty/menu-wyboru';
import { useStylKarty } from '@/komponenty/karta';
import { Tekst } from '@/komponenty/tekst';
import { dataPelna } from '@/lib/format';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, OBWODKA, ODSTEP, PROMIEN_PIGULKI, PROMIEN_POLA } from '@/wyglad/odstepy';
import { stylTekstu } from '@/wyglad/typografia';

const KLAWIATURY_LICZB: KeyboardTypeOptions[] = ['number-pad', 'decimal-pad', 'numeric', 'phone-pad', 'numbers-and-punctuation'];

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
  /** Numer (faktury, konta) cyframi tabelarycznymi także przy zwykłej klawiaturze. */
  cyfry?: boolean;
  /** Podpowiedzi pęku kluczy: e-mail konta, obecne hasło albo nowe hasło (iOS proponuje silne). */
  autouzupelnianie?: 'login' | 'haslo' | 'nowe-haslo';
  /**
   * Klawisz „Dalej” albo „Zaloguj” na klawiaturze i co robi. Dostaje tekst
   * wprost z pola: stan bywa o jeden znak w tyle, gdy klawisz pada tuż po
   * ostatniej literze (sprawdzone w symulatorze).
   */
  klawiszZatwierdz?: ReturnKeyTypeOptions;
  onZatwierdz?: (tekst: string) => void;
  poleRef?: Ref<TextInputInstance>;
};

const AUTOUZUPELNIANIE = {
  login: { textContentType: 'username', autoComplete: 'username' },
  haslo: { textContentType: 'password', autoComplete: 'current-password' },
  'nowe-haslo': { textContentType: 'newPassword', autoComplete: 'new-password' },
} as const;

/** Obwódka pola: przy aktywnym polu płynnie w kolor marki, przy błędzie czerwona (także z fokusem). */
function useObwodka(aktywne: boolean, blad: boolean) {
  const kolory = useKolory();
  const postep = useSharedValue(0);
  useEffect(() => {
    postep.set(withTiming(aktywne ? 1 : 0, { duration: 160 }));
  }, [aktywne, postep]);
  const spoczynek = blad ? kolory.blad : kolory.obwodka;
  const akcent = blad ? kolory.blad : kolory.akcent;
  return useAnimatedStyle(() => ({ borderColor: interpolateColor(postep.value, [0, 1], [spoczynek, akcent]) }));
}

export function PoleTekstowe({
  etykieta,
  wartosc,
  onZmiana,
  podpowiedz,
  klawiatura,
  blad,
  wielowierszowe,
  tajne,
  cyfry,
  autouzupelnianie,
  klawiszZatwierdz,
  onZatwierdz,
  poleRef,
}: PoleTekstoweProps) {
  const kolory = useKolory();
  const [aktywne, setAktywne] = useState(false);
  const [widoczne, setWidoczne] = useState(false);
  const podpowiedzi = autouzupelnianie ? AUTOUZUPELNIANIE[autouzupelnianie] : tajne ? AUTOUZUPELNIANIE.haslo : undefined;
  const obwodka = useObwodka(aktywne, Boolean(blad));
  const liczby = cyfry ?? (klawiatura !== undefined && KLAWIATURY_LICZB.includes(klawiatura));
  return (
    <View style={styles.pole}>
      <Etykieta tekst={etykieta} />
      <Animated.View style={[styles.ramka, tajne ? styles.ramkaHasla : null, { backgroundColor: kolory.tlo }, obwodka]}>
        <TextInput
          ref={poleRef}
          value={wartosc}
          onChangeText={onZmiana}
          onFocus={() => setAktywne(true)}
          onBlur={() => setAktywne(false)}
          placeholder={podpowiedz}
          placeholderTextColor={kolory.etykietaTrzeciorzedna}
          keyboardType={klawiatura}
          multiline={wielowierszowe}
          secureTextEntry={tajne && !widoczne}
          textContentType={podpowiedzi?.textContentType}
          autoComplete={podpowiedzi?.autoComplete}
          autoCapitalize={tajne || klawiatura === 'email-address' ? 'none' : undefined}
          autoCorrect={tajne || klawiatura === 'email-address' ? false : undefined}
          returnKeyType={klawiszZatwierdz}
          onSubmitEditing={onZatwierdz ? (e) => onZatwierdz(e.nativeEvent.text) : undefined}
          submitBehavior={onZatwierdz ? 'submit' : undefined}
          selectionColor={kolory.akcent}
          // Android (M12): bez kreski Material pod tekstem (motyw `rn_edit_text_material`); obwódkę ma ramka. iOS tego nie czyta.
          underlineColorAndroid="transparent"
          accessibilityLabel={etykieta}
          style={[
            stylTekstu('body', { cyfry: liczby }),
            styles.wejscie,
            tajne ? styles.rozciagniety : null,
            wielowierszowe ? styles.wejscieWielo : null,
            { color: kolory.etykieta },
          ]}
        />
        {tajne ? (
          <Pressable
            onPress={() => setWidoczne((w) => !w)}
            accessibilityRole="button"
            accessibilityLabel={widoczne ? 'Ukryj hasło' : 'Pokaż hasło'}
            android_ripple={{ color: kolory.fala, borderless: true, radius: CEL_DOTYKU / 2 }}
            style={styles.oko}>
            <Ikona nazwa={widoczne ? 'eye-off-line' : 'eye-line'} rozmiar={20} kolor={kolory.etykietaDrugorzedna} />
          </Pressable>
        ) : null}
      </Animated.View>
      {blad ? (
        <Tekst styl="footnote" kolor="blad">
          {blad}
        </Tekst>
      ) : null}
    </View>
  );
}
PoleTekstowe.pole = true;

type PoleKoduProps = {
  etykieta: string;
  wartosc: string;
  onZmiana: (kod: string) => void;
  /** Zdanie pod polem, gdy nie ma błędu. */
  opis?: string;
  blad?: string;
  poleRef?: Ref<TextInputInstance>;
  /** Klawiatura od razu (ekran kodu przy logowaniu), nie w zwykłym formularzu. */
  autoFocus?: boolean;
  /**
   * „Wklej” w polu po prawej: dostaje tekst ze schowka. Na iOS to systemowy
   * przycisk wklejania (`UIPasteControl`), który nie pyta o zgodę na odczyt
   * schowka; gdzie go nie ma, zwykły przycisk z `getStringAsync`.
   */
  onWklej?: (tekst: string) => void;
};

const WKLEJ = { width: CEL_DOTYKU + ODSTEP.m, height: CEL_DOTYKU - ODSTEP.xs };

/**
 * Kod z aplikacji TOTP: jedno pole z dużymi cyframi tabelarycznymi zamiast
 * sześciu kratek (WZORCE-MOBBIN.md 7, ekran 3): działa z autouzupełnianiem
 * kodów iOS i z dużym tekstem. Przyjmuje tylko cyfry, najwyżej 6.
 */
export function PoleKodu({ etykieta, wartosc, onZmiana, opis, blad, poleRef, autoFocus, onWklej }: PoleKoduProps) {
  const kolory = useKolory();
  const [aktywne, setAktywne] = useState(false);
  const obwodka = useObwodka(aktywne, Boolean(blad));
  return (
    <View style={styles.pole}>
      <Etykieta tekst={etykieta} />
      <Animated.View style={[styles.ramka, onWklej ? styles.ramkaHasla : null, { backgroundColor: kolory.tlo }, obwodka]}>
        {/* Odstęp po lewej tej samej szerokości co przycisk po prawej, żeby cyfry stały na środku. */}
        {onWklej ? <View style={styles.akcjaPola} /> : null}
        <TextInput
          ref={poleRef}
          value={wartosc}
          onChangeText={(t) => onZmiana(t.replace(/\D/g, '').slice(0, 6))}
          onFocus={() => setAktywne(true)}
          onBlur={() => setAktywne(false)}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus={autoFocus}
          placeholder="000000"
          placeholderTextColor={kolory.etykietaTrzeciorzedna}
          selectionColor={kolory.akcent}
          underlineColorAndroid="transparent"
          accessibilityLabel={etykieta}
          accessibilityHint="Sześć cyfr"
          style={[stylTekstu('title1', { cyfry: true }), styles.wejscieKodu, onWklej ? styles.rozciagniety : null, { color: kolory.etykieta }]}
        />
        {onWklej && Clipboard.isPasteButtonAvailable ? (
          <View style={styles.akcjaPola}>
            <Clipboard.ClipboardPasteButton
              acceptedContentTypes={['plain-text']}
              displayMode="labelOnly"
              cornerStyle="capsule"
              backgroundColor={kolory.akcentTlo}
              foregroundColor={kolory.akcentNaTle}
              style={WKLEJ}
              onPress={(dane) => {
                if (dane.type === 'text') onWklej(dane.text);
              }}
            />
          </View>
        ) : onWklej ? (
          <Pressable
            onPress={() => void Clipboard.getStringAsync().then(onWklej)}
            accessibilityRole="button"
            accessibilityLabel="Wklej"
            android_ripple={{ color: kolory.fala, borderless: true, radius: CEL_DOTYKU / 2 }}
            style={styles.akcjaPola}>
            <Tekst styl="subheadline" waga="semibold" kolor="akcent" maxFontSizeMultiplier={1.4}>
              Wklej
            </Tekst>
          </Pressable>
        ) : null}
      </Animated.View>
      {blad ? (
        <Tekst styl="footnote" kolor="blad">
          {blad}
        </Tekst>
      ) : opis ? (
        <Tekst styl="footnote" kolor="etykietaDrugorzedna">
          {opis}
        </Tekst>
      ) : null}
    </View>
  );
}
PoleKodu.pole = true;

function Etykieta({ tekst }: { tekst: string }) {
  return (
    <Tekst styl="footnote" waga="medium" kolor="etykietaDrugorzedna">
      {tekst}
    </Tekst>
  );
}

type Opcja<T extends string> = { wartosc: T; etykieta: string };

type PoleWyboruProps<T extends string> = {
  etykieta: string;
  wartosc: T;
  opcje: Opcja<T>[];
  onZmiana: (wartosc: T) => void;
};

/**
 * Wybór z kilku opcji: pole jak na stronie (`Select`), lista systemowa.
 * iOS: arkusz akcji; Android: menu Material (`@expo/ui`).
 */
export function PoleWyboru<T extends string>({ etykieta, wartosc, opcje, onZmiana }: PoleWyboruProps<T>) {
  const kolory = useKolory();
  const wybrana = opcje.find((o) => o.wartosc === wartosc);

  if (Platform.OS !== 'ios') {
    // Android (M12): to samo pole, lista w menu Material pod polem (`menu-wyboru.android.tsx`).
    return (
      <View style={styles.pole}>
        <Etykieta tekst={etykieta} />
        <MenuWyboru
          etykieta={etykieta}
          wartosc={wartosc}
          opcje={opcje}
          onZmiana={onZmiana}
          stylPola={[styles.ramka, styles.ramkaWiersz, { borderColor: kolory.obwodka, backgroundColor: kolory.tlo }]}
          stylTekstu={styles.rozciagniety}
        />
      </View>
    );
  }

  const otworz = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      { title: etykieta, options: [...opcje.map((o) => (o.wartosc === wartosc ? `${o.etykieta} ✓` : o.etykieta)), 'Anuluj'], cancelButtonIndex: opcje.length },
      (i) => {
        const o = opcje[i];
        if (o) onZmiana(o.wartosc);
      },
    );

  return (
    <View style={styles.pole}>
      <Etykieta tekst={etykieta} />
      <Pressable
        onPress={otworz}
        accessibilityRole="button"
        accessibilityLabel={`${etykieta}: ${wybrana?.etykieta ?? 'nie wybrano'}`}
        accessibilityHint="Otwiera listę do wyboru"
        style={({ pressed }) => [
          styles.ramka,
          styles.ramkaWiersz,
          { borderColor: kolory.obwodka, backgroundColor: pressed ? kolory.wypelnienie : kolory.tlo },
        ]}>
        {/* Do trzech linii: przy największym tekście wartość się zawija zamiast ucinać (ZASADY-DESIGNU.md, sekcja 3). */}
        <Tekst styl="body" numberOfLines={3} style={styles.rozciagniety} kolor={wybrana ? 'etykieta' : 'etykietaTrzeciorzedna'}>
          {wybrana?.etykieta ?? 'Wybierz'}
        </Tekst>
        <Ikona nazwa="arrow-down-s-line" rozmiar={20} kolor={kolory.etykietaDrugorzedna} />
      </Pressable>
    </View>
  );
}
PoleWyboru.pole = true;

type PolePrzelacznikProps = {
  etykieta: string;
  opis?: string;
  wartosc: boolean;
  onZmiana: (wartosc: boolean) => void;
};

/** Przełącznik jako wiersz karty (między przełącznikami jest linia, jak w ustawieniach strony). */
export function PolePrzelacznik({ etykieta, opis, wartosc, onZmiana }: PolePrzelacznikProps) {
  const kolory = useKolory();
  return (
    <View style={styles.wierszPrzelacznika}>
      <View style={styles.rozciagniety}>
        <Tekst styl="body">{etykieta}</Tekst>
        {opis ? (
          <Tekst styl="footnote" kolor="etykietaDrugorzedna">
            {opis}
          </Tekst>
        ) : null}
      </View>
      <Switch
        value={wartosc}
        onValueChange={onZmiana}
        trackColor={{ true: kolory.akcentWypelnienie, false: kolory.obwodka }}
        // Android (M12): kciuk w kolorach marki zamiast koloru motywu systemu; iOS bez zmian.
        thumbColor={Platform.OS === 'android' ? (wartosc ? kolory.naAkcencie : kolory.tloKomorki) : undefined}
        ios_backgroundColor={kolory.obwodka}
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
  /** Liczba przy pigułce (np. „Po terminie 2”); pusta pozycja = bez liczby. */
  liczniki?: (number | undefined)[];
};

/**
 * Podzakładki sekcji jako pigułki (plan aplikacji, D14 i D15; wzór Revolut
 * Business): wybrana w kolorze marki, pozostałe białe na tle ekranu. Przy
 * dużym tekście zawijają się do kolejnej linii zamiast ucinać napisy.
 */
export function Segmenty({ wartosci, wybrany, onZmiana, etykieta, liczniki }: SegmentyProps) {
  const kolory = useKolory();
  const stylKarty = useStylKarty();
  // Android (M12): fala przycięta do pigułki; iOS bez zmian.
  const Pigulka = Platform.OS === 'android' ? DotykFala : Pressable;
  return (
    <View style={styles.pigulki} accessibilityRole="tablist" accessibilityLabel={etykieta}>
      {wartosci.map((nazwa, i) => {
        const wybrana = i === wybrany;
        const licznik = liczniki?.[i];
        return (
          <Pigulka
            key={nazwa}
            onPress={() => onZmiana(i)}
            accessibilityRole="tab"
            accessibilityState={{ selected: wybrana }}
            accessibilityLabel={licznik === undefined ? nazwa : `${nazwa}, ${licznik}`}
            style={[styles.pigulka, wybrana ? { backgroundColor: kolory.akcentWypelnienie } : [stylKarty, styles.pigulkaKsztalt]]}>
            <Tekst styl="subheadline" waga="medium" style={{ color: wybrana ? kolory.naAkcencie : kolory.etykieta }} numberOfLines={1}>
              {nazwa}
            </Tekst>
            {licznik !== undefined ? (
              <Tekst styl="footnote" cyfry style={{ color: wybrana ? kolory.naAkcencie : kolory.etykietaDrugorzedna }}>
                {licznik}
              </Tekst>
            ) : null}
          </Pigulka>
        );
      })}
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
  // filtr-wyjatek: data-warszawa dzień wybrany w kalendarzu telefonu (data z zIso w południe strefy urządzenia), nie „dziś”; „dziś” po polsku liczy dzienWarszawa
  const [rok, miesiac, dzien] = [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  return `${rok}-${String(miesiac).padStart(2, '0')}-${String(dzien).padStart(2, '0')}`;
}

/**
 * Data: pole z datą cyframi tabelarycznymi; dotknięcie rozwija pod nim systemowy
 * kalendarz (na Androidzie systemowe okno), wybór dnia go zwija.
 */
export function PoleDaty({ etykieta, wartosc, onZmiana, najwczesniej }: PoleDatyProps) {
  const kolory = useKolory();
  const [otwarte, setOtwarte] = useState(false);
  const obwodka = useObwodka(otwarte, false);
  return (
    <Animated.View style={styles.pole} layout={LinearTransition.duration(220)}>
      <Etykieta tekst={etykieta} />
      <Pressable
        onPress={() => setOtwarte((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={`${etykieta}: ${dataPelna(wartosc)}`}
        accessibilityHint={otwarte ? 'Zwija kalendarz' : 'Rozwija kalendarz'}>
        <Animated.View style={[styles.ramka, styles.ramkaWiersz, { backgroundColor: kolory.tlo }, obwodka]}>
          <Tekst styl="body" cyfry style={styles.rozciagniety}>
            {dataPelna(wartosc)}
          </Tekst>
          <Ikona nazwa="calendar-line" rozmiar={18} kolor={otwarte ? kolory.akcent : kolory.etykietaDrugorzedna} />
        </Animated.View>
      </Pressable>
      {otwarte ? (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
          <DateTimePicker
            value={zIso(wartosc)}
            mode="date"
            display="inline"
            locale="pl-PL"
            accentColor={kolory.akcent}
            minimumDate={najwczesniej ? zIso(najwczesniej) : undefined}
            onValueChange={(_, d) => {
              onZmiana(doIso(d));
              setOtwarte(false);
            }}
            onDismiss={() => setOtwarte(false)}
          />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}
PoleDaty.pole = true;

const styles = StyleSheet.create({
  pole: { paddingHorizontal: MARGINES, paddingVertical: ODSTEP.xs, gap: ODSTEP.xs - 2 },
  ramka: { minHeight: CEL_DOTYKU, borderWidth: OBWODKA, borderRadius: PROMIEN_POLA, justifyContent: 'center' },
  ramkaWiersz: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.xs, paddingHorizontal: ODSTEP.s },
  wejscie: { paddingHorizontal: ODSTEP.s, paddingVertical: ODSTEP.s - 2 },
  wejscieWielo: { minHeight: CEL_DOTYKU * 2, textAlignVertical: 'top' },
  rozciagniety: { flex: 1 },
  ramkaHasla: { flexDirection: 'row', alignItems: 'center' },
  oko: { minWidth: CEL_DOTYKU, minHeight: CEL_DOTYKU, alignItems: 'center', justifyContent: 'center' },
  akcjaPola: { width: CEL_DOTYKU + ODSTEP.m, minHeight: CEL_DOTYKU, alignItems: 'center', justifyContent: 'center' },
  wejscieKodu: { paddingHorizontal: ODSTEP.s, paddingVertical: ODSTEP.xs, letterSpacing: ODSTEP.xs, textAlign: 'center' },
  wierszPrzelacznika: {
    minHeight: CEL_DOTYKU + ODSTEP.xs,
    paddingHorizontal: MARGINES,
    paddingVertical: ODSTEP.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ODSTEP.s,
  },
  pigulki: { flexDirection: 'row', flexWrap: 'wrap', gap: ODSTEP.xs, marginHorizontal: MARGINES, marginTop: ODSTEP.l },
  pigulka: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ODSTEP.xxs + 2,
    minHeight: CEL_DOTYKU - ODSTEP.xxs,
    paddingHorizontal: ODSTEP.m - 2,
    borderRadius: PROMIEN_PIGULKI,
  },
  pigulkaKsztalt: { borderRadius: PROMIEN_PIGULKI },
});
