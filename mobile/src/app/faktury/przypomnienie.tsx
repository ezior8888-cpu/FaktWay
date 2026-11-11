import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DZIS } from '@/dane-przykladowe';
import { KONTRAHENCI } from '@/dane-przykladowe/kontrahenci';
import { PolePrzelacznik, PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { dataPelna, dniMiedzy, kwota } from '@/lib/format';
import { dni } from '@/lib/status-faktury';
import { useFlaga, useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/**
 * Przypomnienie o zapłacie (strona „Po terminie”): podgląd wiadomości,
 * zgoda i zlecenie wysyłki; wstrzymanie przypomnień; oznaczenie zapłaty.
 * Nic nie wychodzi samo, jak na stronie.
 */
export default function EkranPrzypomnienia() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { faktury, przelaczZaplate } = useStanFaktur();
  const f = faktury.find((x) => x.id === id);
  const k = KONTRAHENCI.find((x) => x.nazwa === f?.kontrahent);
  const [wstrzymane, setWstrzymane] = useFlaga(`przypomnienia-wstrzymane-${id}`, false);
  const [email, setEmail] = useState(k?.email ?? '');
  const [tresc, setTresc] = useState(
    f ? `Dzień dobry,\n\nprzypominamy o płatności za fakturę ${f.numer} na kwotę ${kwota(f.brutto)}, z terminem ${dataPelna(f.terminPlatnosci)}. Jeśli przelew już wyszedł, prosimy zignorować tę wiadomość.\n\nPozdrawiamy` : '',
  );
  const [pdf, setPdf] = useState(true);
  const [zgoda, setZgoda] = useState(false);
  const [zlecone, setZlecone] = useState(false);
  const [blad, setBlad] = useState<string>();

  if (!f) return <StanPusty ikona="file-unknow-line" tytul="Nie ma takiej faktury" opis="Mogła zostać zapłacona albo usunięta." />;
  const poTerminie = dniMiedzy(f.terminPlatnosci, DZIS);

  const zlec = () => {
    if (!/^\S+@\S+\.\S+$/.test(email)) return setBlad('Wpisz poprawny adres e-mail odbiorcy.');
    if (!zgoda) return setBlad('Zaznacz zgodę na wysyłkę.');
    setBlad(undefined);
    setZlecone(true);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Zamknij</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <NaglowekKwoty
          podpis={`${f.kontrahent} · ${f.numer}`}
          wartosc={kwota(f.brutto)}
          status={poTerminie > 0 ? `${dni(poTerminie)} po terminie` : 'W terminie'}
          statusKolor={poTerminie > 7 ? 'blad' : 'ostrzezenie'}
        />
        <View style={styles.akcja}>
          <PrzyciskGlowny
            tytul={f.zaplacona ? 'Cofnij zapłatę' : 'Zapłacone'}
            ikona="check-line"
            wariant={f.zaplacona ? 'drugorzedny' : 'glowny'}
            onPress={() => przelaczZaplate(f)}
          />
        </View>

        <Sekcja naglowek="Przypomnienia" stopka={f.przypomnienie?.data ? `Ostatnio: ${dataPelna(f.przypomnienie.data)}, etap ${f.przypomnienie.etap}.` : undefined}>
          <Wiersz tytul="Status" wartosc={wstrzymane ? 'Wstrzymane' : f.przypomnienie?.status ?? 'Bez przypomnień'} />
          <Wiersz tytul="Wysłane" wartosc={`${f.przypomnienie?.wyslane ?? 0} z 3`} />
          <PolePrzelacznik etykieta="Wstrzymaj przypomnienia" wartosc={wstrzymane} onZmiana={setWstrzymane} />
        </Sekcja>

        {wstrzymane || f.zaplacona ? null : zlecone ? (
          <Sekcja naglowek="Przypomnienie zlecone" stopka="Wyślemy je w najbliższym oknie wysyłki z ustawień przypomnień.">
            <Wiersz tytul={`Do: ${email}`} ikona="checkbox-circle-fill" ikonaKolor="sukces" />
          </Sekcja>
        ) : (
          <>
            <Sekcja naglowek="Przygotuj przypomnienie" stopka={blad}>
              <PoleTekstowe etykieta="Do" wartosc={email} onZmiana={setEmail} podpowiedz="adres e-mail" klawiatura="email-address" />
              <Wiersz tytul="Temat" podtytul={`Przypomnienie o płatności: ${f.numer}`} />
              <PoleTekstowe etykieta="Treść wiadomości" wartosc={tresc} onZmiana={setTresc} wielowierszowe />
              <PolePrzelacznik etykieta="Załącznik PDF" wartosc={pdf} onZmiana={setPdf} />
              <PolePrzelacznik etykieta="Zgadzam się na wysyłkę tej wiadomości" wartosc={zgoda} onZmiana={setZgoda} />
            </Sekcja>
            <View style={styles.akcja}>
              <PrzyciskGlowny tytul="Zatwierdź i zleć wysyłkę" ikona="send-plane-line" onPress={zlec} />
            </View>
          </>
        )}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
