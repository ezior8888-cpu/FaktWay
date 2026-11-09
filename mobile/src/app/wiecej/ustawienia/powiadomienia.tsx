import { POWIADOMIENIA_PUSH, URZADZENIA_PUSH } from '@/dane-przykladowe/ustawienia';
import { PolePrzelacznik } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { dataPelna } from '@/lib/format';
import { useStanFaktur } from '@/stan/faktury';

/** Powiadomienia: push na tym urządzeniu (rodzaje), urządzenia, e-mail. */
export default function EkranPowiadomien() {
  const { flagi, ustawFlage } = useStanFaktur();
  const wl = (k: string, d = true) => flagi[`push-${k}`] ?? d;
  const wlaczone = wl('wlaczone');

  return (
    <EkranListy>
      <Sekcja naglowek="Na tym urządzeniu" stopka={wlaczone ? 'Powiadomienia włączone na tym urządzeniu. Nie pokazujemy w nich kwot ani nazw kontrahentów.' : 'Powiadomienia wyłączone na tym urządzeniu.'}>
        <PolePrzelacznik etykieta="Powiadomienia" wartosc={wlaczone} onZmiana={(v) => ustawFlage('push-wlaczone', v)} />
        {wlaczone
          ? POWIADOMIENIA_PUSH.map((p) => (
              <PolePrzelacznik key={p.klucz} etykieta={p.etykieta} opis={p.opis} wartosc={wl(p.klucz)} onZmiana={(v) => ustawFlage(`push-${p.klucz}`, v)} />
            ))
          : null}
      </Sekcja>

      <Sekcja naglowek={`Twoje urządzenia (${URZADZENIA_PUSH.length})`}>
        {URZADZENIA_PUSH.map((u) => (
          <Wiersz key={u.id} tytul={u.nazwa} podtytul={`Dodane ${dataPelna(u.dodane)}`} ikona={u.nazwa.includes('iPhone') ? 'iphone' : 'laptopcomputer'} />
        ))}
      </Sekcja>

      <Sekcja naglowek="Powiadomienia e-mail" stopka="Powiadomień transakcyjnych (np. o fakturze odrzuconej przez KSeF) nie da się wyłączyć.">
        <Wiersz tytul="Powiadomienia transakcyjne" wartosc="Wymagane" />
        <PolePrzelacznik etykieta="Porady i nowości" wartosc={wl('email-porady', false)} onZmiana={(v) => ustawFlage('push-email-porady', v)} />
        <PolePrzelacznik etykieta="Oferty i kampanie" wartosc={wl('email-oferty', false)} onZmiana={(v) => ustawFlage('push-email-oferty', v)} />
      </Sekcja>
    </EkranListy>
  );
}
