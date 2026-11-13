import * as Haptics from 'expo-haptics';
import { useState } from 'react';

import { KLUCZE_DOSTEPU } from '@/dane-przykladowe/ustawienia';
import { PolePrzelacznik, PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { potwierdz } from '@/komponenty/potwierdz';
import { dataPelna } from '@/lib/format';
import { useFlaga } from '@/stan/faktury';
import { BLOKADA_PO_MS, useSesja } from '@/stan/sesja';

const WYMAGANIA = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{12,128}$/;

/** Bezpieczeństwo: hasło, weryfikacja dwuetapowa, logowanie biometrią, blokada Face ID. */
export default function EkranBezpieczenstwa() {
  const [stare, setStare] = useState('');
  const [nowe, setNowe] = useState('');
  const [komunikat, setKomunikat] = useState<string>();
  const [dwaEtapy, setDwaEtapy] = useFlaga('2fa', true);
  const { biometria, blokada, ustawBlokade } = useSesja();
  const [klucze, setKlucze] = useState(KLUCZE_DOSTEPU);

  const zmienHaslo = () => {
    if (!stare) return setKomunikat('Wpisz aktualne hasło.');
    if (!WYMAGANIA.test(nowe)) return setKomunikat('Nowe hasło: 12 do 128 znaków, mała i duża litera, cyfra oraz znak specjalny.');
    setStare('');
    setNowe('');
    setKomunikat('Hasło zmienione.');
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja naglowek="Hasło" stopka={komunikat ?? '12 do 128 znaków, mała i duża litera, cyfra oraz znak specjalny.'}>
        <PoleTekstowe etykieta="Aktualne hasło" wartosc={stare} onZmiana={setStare} tajne />
        <PoleTekstowe etykieta="Nowe hasło" wartosc={nowe} onZmiana={setNowe} tajne autouzupelnianie="nowe-haslo" />
        <Wiersz tytul="Zmień hasło" akcja onPress={zmienHaslo} />
      </Sekcja>

      <Sekcja naglowek="Weryfikacja dwuetapowa" stopka={dwaEtapy ? 'Włączone: przy logowaniu poprosimy o kod z aplikacji TOTP.' : 'Włącz, żeby podłączyć KSeF i wejść w ustawienia wrażliwe.'}>
        <PolePrzelacznik
          etykieta="Kod z aplikacji (TOTP)"
          wartosc={dwaEtapy}
          onZmiana={(v) =>
            v
              ? setDwaEtapy(true)
              : potwierdz({ tytul: 'Wyłączyć aplikację TOTP?', opis: 'Bez drugiego kroku nie podłączysz KSeF.', potwierdz: 'Wyłącz' }, () => setDwaEtapy(false))
          }
        />
      </Sekcja>

      <Sekcja naglowek="Logowanie biometrią" stopka="Klucze dostępu z Face ID albo Touch ID zamiast hasła.">
        {klucze.map((k) => (
          <Wiersz
            key={k.id}
            tytul={k.nazwa}
            podtytul={`Ostatnio użyte: ${dataPelna(k.ostatnio)}`}
            wartoscPodpis="Usuń"
            wartoscPodpisKolor="blad"
            onPress={() =>
              potwierdz({ tytul: `Usunąć ${k.nazwa}?`, opis: 'Na tym urządzeniu zalogujesz się znowu hasłem.', potwierdz: 'Usuń klucz' }, () =>
                setKlucze((l) => l.filter((x) => x.id !== k.id)),
              )
            }
          />
        ))}
        <Wiersz
          tytul="Dodaj urządzenie"
          ikona="fingerprint-line"
          akcja
          onPress={() => setKlucze((l) => [...l, { id: `p${Date.now()}`, nazwa: 'Ten iPhone, Face ID', ostatnio: '2026-11-09' }])}
        />
      </Sekcja>

      {biometria ? (
        <Sekcja
          naglowek="Ta aplikacja"
          stopka={`Po włączeniu aplikacja poprosi o ${biometria.nazwa} przy otwarciu i po ${BLOKADA_PO_MS / 60000} minutach w tle. W przełączniku aplikacji kwoty są zawsze zasłonięte.`}>
          <PolePrzelacznik etykieta={`Blokada ${biometria.nazwa}`} wartosc={blokada} onZmiana={(v) => void ustawBlokade(v)} />
        </Sekcja>
      ) : (
        <Sekcja naglowek="Ta aplikacja" stopka="Ten telefon nie ma Face ID ani czytnika odcisków palców, więc blokada aplikacji jest niedostępna. W przełączniku aplikacji kwoty są zawsze zasłonięte." />
      )}
    </EkranListy>
  );
}
