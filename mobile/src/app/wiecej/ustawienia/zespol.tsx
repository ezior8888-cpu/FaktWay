import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ActionSheetIOS, Alert, Platform } from 'react-native';

import { CZLONKOWIE, ZAPROSZENIA } from '@/dane-przykladowe/ustawienia';
import { PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { dataPelna } from '@/lib/format';

/** Zespół: zaproszenia, prośby o dostęp, członkowie z rolami (`team-management.tsx`). */
export default function EkranZespolu() {
  const [email, setEmail] = useState('');
  const [rola, setRola] = useState('członek');
  const [blad, setBlad] = useState<string>();
  const [zaproszenia, setZaproszenia] = useState(ZAPROSZENIA);
  const [czlonkowie, setCzlonkowie] = useState(CZLONKOWIE);

  const zapros = () => {
    if (!/^\S+@\S+\.\S+$/.test(email)) return setBlad('Wpisz poprawny adres e-mail.');
    setZaproszenia((l) => [...l, { id: `z${Date.now()}`, email, rola, wygasa: '2026-11-16' }]);
    setEmail('');
    setBlad(undefined);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  /** Systemowy arkusz akcji (iOS); na Androidzie okno z tymi samymi opcjami. */
  const menuCzlonka = (id: string, imie: string) => {
    const opcje = ['Zmień rolę na admin', 'Zmień rolę na członek', 'Usuń z zespołu', 'Anuluj'];
    const wybierz = (i: number) => {
      if (i === 0) setCzlonkowie((l) => l.map((x) => (x.id === id ? { ...x, rola: 'admin' } : x)));
      if (i === 1) setCzlonkowie((l) => l.map((x) => (x.id === id ? { ...x, rola: 'członek' } : x)));
      if (i === 2) setCzlonkowie((l) => l.filter((x) => x.id !== id));
    };
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ title: imie, options: opcje, destructiveButtonIndex: 2, cancelButtonIndex: 3 }, wybierz);
    } else {
      Alert.alert(imie, undefined, opcje.slice(0, 3).map((t, i) => ({ text: t, style: i === 2 ? 'destructive' : 'default', onPress: () => wybierz(i) })));
    }
  };

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja naglowek="Zaproś nowego członka" stopka={blad ?? 'Link w zaproszeniu jest ważny 7 dni.'}>
        <PoleTekstowe etykieta="E-mail" wartosc={email} onZmiana={setEmail} klawiatura="email-address" podpowiedz="adres e-mail" />
        <PoleWyboru
          etykieta="Rola"
          wartosc={rola}
          opcje={[
            { wartosc: 'członek', etykieta: 'Członek' },
            { wartosc: 'admin', etykieta: 'Admin' },
            { wartosc: 'księgowy', etykieta: 'Księgowy' },
          ]}
          onZmiana={setRola}
        />
        <Wiersz tytul="Wyślij zaproszenie" ikona="send-plane-line" akcja onPress={zapros} />
      </Sekcja>

      {zaproszenia.length > 0 ? (
        <Sekcja naglowek={`Zaproszenia oczekujące (${zaproszenia.length})`}>
          {zaproszenia.map((z) => (
            <Wiersz
              key={z.id}
              tytul={z.email}
              podtytul={`Rola ${z.rola} · wygasa ${dataPelna(z.wygasa)}`}
              wartoscPodpis="Cofnij"
              wartoscPodpisKolor="blad"
              onPress={() => setZaproszenia((l) => l.filter((x) => x.id !== z.id))}
            />
          ))}
        </Sekcja>
      ) : null}

      <Sekcja naglowek={`Członkowie (${czlonkowie.length})`}>
        {czlonkowie.map((c) => (
          <Wiersz
            key={c.id}
            tytul={c.ty ? `${c.imie} (Ty)` : c.imie}
            podtytul={`${c.email} · ${c.rola} · dołączył(a) ${dataPelna(c.od)}`}
            onPress={c.ty ? undefined : () => menuCzlonka(c.id, c.imie)}
          />
        ))}
      </Sekcja>
    </EkranListy>
  );
}
