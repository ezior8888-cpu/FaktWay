import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';

import { KONTRAHENCI } from '@/dane-przykladowe/kontrahenci';
import { PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { useStanFaktur } from '@/stan/faktury';
import { EkranTylkoNaStronie } from '@/komponenty/na-stronie';

/** Na prawdziwym koncie (M7) ten zapis jeszcze nie działa z telefonu: ekran mówi, gdzie go zrobić. */
export default function EkranEmaila() {
  const { dane } = useStanFaktur();
  const { id } = useLocalSearchParams<{ id?: string }>();
  if (dane.zrodlo === 'baza') return <EkranTylkoNaStronie co="email" idFaktury={id} />;
  return <EkranEmailaPrzyklad />;
}

/** Arkusz „Wyślij e-mailem” ze szczegółu faktury: pole Do, Wyślij, Anuluj. */
function EkranEmailaPrzyklad() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { faktury } = useStanFaktur();
  const f = faktury.find((x) => x.id === id);
  const [do_, setDo] = useState(KONTRAHENCI.find((k) => k.nazwa === f?.kontrahent)?.email ?? '');
  const [blad, setBlad] = useState<string>();
  const [wyslano, setWyslano] = useState(false);
  // Arkusz zamknięty gestem przed upływem czasu: bez opóźnionego „wstecz”, które zamknęłoby szczegół faktury.
  const zegar = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(zegar.current), []);

  const wyslij = () => {
    if (!/^\S+@\S+\.\S+$/.test(do_)) return setBlad('Wpisz poprawny adres e-mail.');
    setWyslano(true);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    zegar.current = setTimeout(() => router.back(), 900);
  };

  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Anuluj</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" onPress={wyslij}>
          Wyślij
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <EkranListy keyboardShouldPersistTaps="handled">
        <Sekcja stopka={blad ?? (f ? `Faktura ${f.numer} jako PDF w załączniku.` : undefined)}>
          {wyslano ? (
            <Wiersz tytul={`Wysłano do ${do_}`} ikona="checkbox-circle-fill" ikonaKolor="sukces" />
          ) : (
            <PoleTekstowe etykieta="Do" wartosc={do_} onZmiana={setDo} podpowiedz="adres e-mail" klawiatura="email-address" />
          )}
        </Sekcja>
      </EkranListy>
    </>
  );
}
