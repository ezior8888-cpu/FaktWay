import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Alert, Share } from 'react-native';

import { DOSTEPY_KSIEGOWEJ, FORMATY_KSIEGOWEJ, PACZKI_KSIEGOWEJ } from '@/dane-przykladowe/ustawienia';
import { PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { dataPelna } from '@/lib/format';
import { useStanFaktur } from '@/stan/faktury';

/**
 * Księgowa: odpowiednik `settings/accountant` (urząd skarbowy, Co-Pilot
 * z paczkami dla księgowej, udostępnione dostępy z linkiem).
 */
export default function EkranKsiegowej() {
  const { flagi, ustawFlage } = useStanFaktur();
  const wl = (k: string, d: boolean) => flagi[`ksieg-${k}`] ?? d;
  const copilot = wl('copilot', true);
  const [urzad, setUrzad] = useState('Urząd Skarbowy Warszawa-Śródmieście');
  const [imie, setImie] = useState('Anna Sowa');
  const [biuro, setBiuro] = useState('Biuro Rachunkowe Sowa');
  const [email, setEmail] = useState('sowa@przyklad.pl');
  const [dzien, setDzien] = useState('5');
  const [dostepy, setDostepy] = useState(DOSTEPY_KSIEGOWEJ);
  const [paczki, setPaczki] = useState(PACZKI_KSIEGOWEJ);

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja naglowek="Urząd skarbowy firmy" stopka="Potrzebny do pliku JPK_FA.">
        <PoleTekstowe etykieta="Urząd" wartosc={urzad} onZmiana={setUrzad} />
      </Sekcja>

      <Sekcja naglowek="Co-Pilot" stopka={copilot ? `Wysyłamy paczkę ${dzien}. dnia każdego miesiąca o 8:00 za poprzedni miesiąc.` : 'Co-Pilot wyłączony: paczki dla księgowej nie wychodzą.'}>
        <PolePrzelacznik etykieta={copilot ? 'Co-Pilot aktywny' : 'Co-Pilot wyłączony'} wartosc={copilot} onZmiana={(v) => ustawFlage('ksieg-copilot', v)} />
        {copilot ? (
          <>
            <PoleTekstowe etykieta="Imię i nazwisko" wartosc={imie} onZmiana={setImie} />
            <PoleTekstowe etykieta="Nazwa biura" wartosc={biuro} onZmiana={setBiuro} podpowiedz="opcjonalnie" />
            <PoleTekstowe etykieta="E-mail księgowego" wartosc={email} onZmiana={setEmail} klawiatura="email-address" />
            <PoleWyboru etykieta="Dzień wysyłki" wartosc={dzien} opcje={Array.from({ length: 28 }, (_, i) => ({ wartosc: String(i + 1), etykieta: `${i + 1}. dnia` }))} onZmiana={setDzien} />
          </>
        ) : null}
      </Sekcja>

      {copilot ? (
        <>
          <Sekcja naglowek="Formaty plików">
            {FORMATY_KSIEGOWEJ.map((f) => (
              <PolePrzelacznik key={f} etykieta={f} wartosc={wl(`format-${f}`, f === 'JPK_FA(4)' || f === 'KPiR Excel')} onZmiana={(v) => ustawFlage(`ksieg-format-${f}`, v)} />
            ))}
          </Sekcja>
          <Sekcja naglowek="Co dołączać do paczki">
            <PolePrzelacznik etykieta="Faktury wystawione" wartosc={wl('sprzedaz', true)} onZmiana={(v) => ustawFlage('ksieg-sprzedaz', v)} />
            <PolePrzelacznik etykieta="Faktury otrzymane" wartosc={wl('zakupy', true)} onZmiana={(v) => ustawFlage('ksieg-zakupy', v)} />
            <PolePrzelacznik etykieta="Faktury korygujące" wartosc={wl('korekty', true)} onZmiana={(v) => ustawFlage('ksieg-korekty', v)} />
          </Sekcja>
          <Sekcja naglowek="Ostatnie paczki">
            {paczki.map((p) => (
              <Wiersz key={p.id} tytul={p.okres} podtytul={`Wysłano ${dataPelna(p.data)}`} wartoscPodpis={p.status} wartoscPodpisKolor={p.status === 'Wysłane' ? 'sukces' : 'akcent'} />
            ))}
            <Wiersz
              tytul="Wyślij teraz (za poprzedni miesiąc)"
              ikona="paperplane"
              akcja
              onPress={() => {
                setPaczki((l) => [{ id: `k${Date.now()}`, okres: 'Październik 2026', status: 'Wysłane', data: '2026-11-09' }, ...l]);
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }}
            />
          </Sekcja>
        </>
      ) : null}

      <Sekcja naglowek={`Udostępnione dostępy (${dostepy.length})`} stopka="Link pokazujemy tylko raz. Księgowa nie potrzebuje konta w FaktWay.">
        {dostepy.map((d) => (
          <Wiersz
            key={d.id}
            tytul={d.nazwa}
            podtytul={`${d.poziom} · wygasa ${dataPelna(d.wygasa)} · ${d.uzycia} użyć`}
            wartoscPodpis="Odbierz"
            wartoscPodpisKolor="blad"
            onPress={() =>
              Alert.alert(`Odebrać dostęp: ${d.nazwa}?`, 'Link przestanie działać od razu.', [
                { text: 'Anuluj', style: 'cancel' },
                { text: 'Odbierz', style: 'destructive', onPress: () => setDostepy((l) => l.filter((x) => x.id !== d.id)) },
              ])
            }
          />
        ))}
        <Wiersz
          tytul="Nowy dostęp"
          ikona="link.badge.plus"
          akcja
          onPress={() => {
            setDostepy((l) => [...l, { id: `d${Date.now()}`, nazwa: biuro || imie, email, poziom: 'Tylko podgląd', status: 'Aktywny', wygasa: '2026-12-09', uzycia: 0 }]);
            void Share.share({ message: 'Link dostępu dla księgowej (przykładowy): https://faktway.pl/ksiegowa/...' });
          }}
        />
      </Sekcja>
    </EkranListy>
  );
}
