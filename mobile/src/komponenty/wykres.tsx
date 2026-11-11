/**
 * Wykresy jak na stronie (recharts w `components/dashboard/finora/chart-finance.tsx`):
 * słupki (także składane), linia z polem i pierścień w odcieniach niebieskiego
 * marki, przerywana siatka, osie w IBM Plex Mono. Rysowane w SVG, więc
 * wyglądają tak samo na iOS i Androidzie. Wchodzą płynną animacją na wątku
 * interfejsu (Reanimated), a dotknięcie pokazuje wartość jak dymek na stronie.
 * Rysunek leży w karcie `Sekcja swobodna`, więc nie ma własnego tła.
 */
import { useEffect, useId, useState } from 'react';
import { Pressable, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Animated, { Easing, useAnimatedProps, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { Tekst } from '@/komponenty/tekst';
import { liczbaKrotka } from '@/lib/format';
import { useKolory, type Kolory } from '@/wyglad/kolory';
import { OBWODKA, ODSTEP, PROMIEN } from '@/wyglad/odstepy';

import type { PunktWykresu, SeriaWykresu, WykresProps } from './wykres-typy';

const AnimowanyRect = Animated.createAnimatedComponent(Rect);
const AnimowanaSciezka = Animated.createAnimatedComponent(Path);

/** Szerokość podpisów osi Y („30 tys.” w Plex Mono 11 pt, z zapasem na duży tekst). */
const OS_Y = 58;
const WYSOKOSC_OSI_X = 20;
const PALETA: (keyof Kolory)[] = ['wykres2', 'wykres1', 'wykres3', 'wykres4', 'wykres5'];
const LICZBA = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 });

/** Okrągła skala osi Y: 4 do 5 podziałek co 1, 2, 2,5 albo 5 razy potęga dziesięciu. */
function skala(min: number, max: number) {
  const surowy = (max - min) / 4 || 1;
  const wykladnik = 10 ** Math.floor(Math.log10(surowy));
  const f = surowy / wykladnik;
  const krok = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * wykladnik;
  const gora = Math.ceil(max / krok) * krok || krok;
  const dol = Math.floor(min / krok) * krok;
  const podzialki: number[] = [];
  for (let v = dol; v <= gora + krok / 2; v += krok) podzialki.push(v);
  return { gora, dol, podzialki };
}

/** Wejście wykresu: od zera do pełnej wartości przy pierwszym rysunku i przy zmianie danych. */
function usePostep(klucz: string): SharedValue<number> {
  const postep = useSharedValue(0);
  useEffect(() => {
    postep.set(0);
    postep.set(withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) }));
  }, [klucz, postep]);
  return postep;
}

export function Wykres(props: WykresProps) {
  const [szerokosc, setSzerokosc] = useState(0);
  const { punkty, rodzaj = 'slupki', etykieta, stos } = props;
  const wysokosc = props.wysokosc ?? (rodzaj === 'kolo' ? 200 : 180);
  const opis = etykieta ?? punkty.map((p) => `${p.x}: ${p.opis ?? p.y}`).join(', ');
  return (
    <View onLayout={(e: LayoutChangeEvent) => setSzerokosc(e.nativeEvent.layout.width)} accessible accessibilityRole="image" accessibilityLabel={opis}>
      {szerokosc === 0 ? (
        <View style={{ height: wysokosc + WYSOKOSC_OSI_X }} />
      ) : rodzaj === 'kolo' ? (
        // Nowe dane (np. Sprzedaż i Koszty w Analizach) to nowy pierścień: wybór wraca do największego wycinka.
        <Pierscien key={punkty.map((p) => p.x).join('|')} punkty={punkty} szerokosc={szerokosc} wysokosc={wysokosc} />
      ) : (
        <Osie punkty={punkty} stos={stos} rodzaj={rodzaj} szerokosc={szerokosc} wysokosc={wysokosc} />
      )}
    </View>
  );
}

type OsieProps = { punkty: PunktWykresu[]; stos?: SeriaWykresu[]; rodzaj: 'slupki' | 'linia' | 'pole'; szerokosc: number; wysokosc: number };

/** Słupki albo linia na osiach: siatka, podpisy, dymek po dotknięciu. */
function Osie({ punkty, stos, rodzaj, szerokosc, wysokosc }: OsieProps) {
  const kolory = useKolory();
  const [wybrany, setWybrany] = useState<number | null>(null);
  const n = punkty.length;
  const sumy = stos ? punkty.map((_, i) => stos.reduce((s, seria) => s + (seria.wartosci[i] ?? 0), 0)) : punkty.map((p) => p.y);
  const { gora, dol, podzialki } = skala(Math.min(0, ...sumy), Math.max(0, ...sumy));
  const szerPola = szerokosc - OS_Y;
  const slot = szerPola / Math.max(1, n);
  const y = (v: number) => ((gora - v) / (gora - dol)) * wysokosc;
  const x = (i: number) => OS_Y + slot * i + slot / 2;
  const postep = usePostep(`${rodzaj}:${sumy.join(',')}`);

  const dotknij = (e: GestureResponderEvent) => {
    const i = Math.floor((e.nativeEvent.locationX - OS_Y) / slot);
    if (i < 0 || i >= n) return setWybrany(null);
    setWybrany((w) => (w === i ? null : i));
  };

  const punktWybrany = wybrany === null ? undefined : punkty[wybrany];
  const sumaWybrana = wybrany === null ? 0 : (sumy[wybrany] ?? 0);

  return (
    <View>
      <Pressable onPress={dotknij}>
        <Svg width={szerokosc} height={wysokosc}>
          {podzialki.map((v) => (
            <Line key={v} x1={OS_Y} x2={szerokosc} y1={y(v)} y2={y(v)} stroke={kolory.obwodka} strokeWidth={1} strokeDasharray={v === 0 ? undefined : '4 4'} />
          ))}
          {rodzaj === 'slupki' ? (
            <Slupki punkty={punkty} stos={stos} x={x} y={y} slot={slot} postep={postep} wybrany={wybrany} />
          ) : (
            <Linia punkty={punkty} x={x} y={y} postep={postep} wybrany={wybrany} pole={rodzaj === 'pole'} wysokosc={wysokosc} />
          )}
        </Svg>
      </Pressable>
      {podzialki.map((v) => (
        <Tekst
          key={v}
          styl="caption2"
          kolor="etykietaDrugorzedna"
          cyfry
          style={[styles.podpisY, { top: y(v) - 7 }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.75}>
          {liczbaKrotka(v)}
        </Tekst>
      ))}
      <View style={[styles.osX, { marginLeft: OS_Y }]}>
        {punkty.map((p, i) => (
          <Tekst key={`${p.x}-${i}`} styl="caption2" kolor={i === wybrany ? 'etykieta' : 'etykietaDrugorzedna'} style={styles.podpisX} numberOfLines={1}>
            {p.x}
          </Tekst>
        ))}
      </View>
      {stos ? <Legenda pozycje={stos.map((s) => ({ nazwa: s.nazwa, kolor: s.kolor }))} /> : null}
      {punktWybrany && wybrany !== null ? (
        <Dymek
          tytul={punktWybrany.x}
          wiersze={
            stos
              ? stos.map((s) => ({ nazwa: s.nazwa, kolor: s.kolor, wartosc: `${LICZBA.format(s.wartosci[wybrany] ?? 0)} zł` }))
              : [{ wartosc: punktWybrany.opis ?? `${LICZBA.format(sumaWybrana)} zł` }]
          }
          srodekX={x(wybrany)}
          gora={Math.max(0, Math.min(y(sumaWybrana), y(0)) - 8)}
          szerokosc={szerokosc}
        />
      ) : null}
    </View>
  );
}

type SlupkiProps = {
  punkty: PunktWykresu[];
  stos?: SeriaWykresu[];
  x: (i: number) => number;
  y: (v: number) => number;
  slot: number;
  postep: SharedValue<number>;
  wybrany: number | null;
};

function Slupki({ punkty, stos, x, y, slot, postep, wybrany }: SlupkiProps) {
  const kolory = useKolory();
  // Na stronie `barSize={12}`; przy wąskim ekranie słupek nie zajmuje więcej niż połowy miejsca.
  const szer = Math.min(14, slot * 0.5);
  const y0 = y(0);
  return (
    <>
      {punkty.map((p, i) => {
        const przygaszony = wybrany !== null && wybrany !== i;
        if (!stos) {
          return (
            <Odcinek key={i} x={x(i) - szer / 2} szer={szer} baza={y0} dol={y0} gora={y(p.y)} kolor={kolory[p.kolor ?? 'wykres2']} postep={postep} przygaszony={przygaszony} />
          );
        }
        return stos.map((seria, s) => {
          // Słupek składany: odcinek serii leży na sumie serii przed nią.
          const od = stos.slice(0, s).reduce((suma, poprz) => suma + (poprz.wartosci[i] ?? 0), 0);
          const narastajaco = od + (seria.wartosci[i] ?? 0);
          return (
            <Odcinek
              key={`${i}-${seria.nazwa}`}
              x={x(i) - szer / 2}
              szer={szer}
              baza={y0}
              dol={y(od)}
              gora={y(narastajaco)}
              kolor={kolory[seria.kolor]}
              postep={postep}
              przygaszony={przygaszony}
            />
          );
        });
      })}
    </>
  );
}

type OdcinekProps = { x: number; szer: number; baza: number; dol: number; gora: number; kolor: string; postep: SharedValue<number>; przygaszony: boolean };

/** Słupek albo jego część: rośnie od osi zera razem z całym wykresem. */
function Odcinek({ x, szer, baza, dol, gora, kolor, postep, przygaszony }: OdcinekProps) {
  const animowane = useAnimatedProps(() => {
    const g = baza + (gora - baza) * postep.value;
    const d = baza + (dol - baza) * postep.value;
    return { y: Math.min(g, d), height: Math.abs(d - g) };
  });
  return <AnimowanyRect x={x} width={szer} animatedProps={animowane} fill={kolor} opacity={przygaszony ? 0.35 : 1} />;
}

type LiniaProps = {
  punkty: PunktWykresu[];
  x: (i: number) => number;
  y: (v: number) => number;
  postep: SharedValue<number>;
  wybrany: number | null;
  pole: boolean;
  wysokosc: number;
};

/** Gładka linia bez przestrzeliwania (krzywa monotoniczna, jak `type="monotone"` w recharts). */
function sciezkaMonotoniczna(p: { x: number; y: number }[]): string {
  const n = p.length;
  const pierwszy = p[0];
  if (!pierwszy) return '';
  if (n === 1) return `M${pierwszy.x} ${pierwszy.y}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = p[i] ?? pierwszy;
    const b = p[i + 1] ?? a;
    dx.push(b.x - a.x);
    m.push((b.y - a.y) / (b.x - a.x || 1));
  }
  const t: number[] = [m[0] ?? 0];
  for (let i = 1; i < n - 1; i++) {
    const m0 = m[i - 1] ?? 0;
    const m1 = m[i] ?? 0;
    t.push(m0 * m1 <= 0 ? 0 : (m0 + m1) / 2);
  }
  t.push(m[n - 2] ?? 0);
  for (let i = 0; i < n - 1; i++) {
    const mi = m[i] ?? 0;
    if (mi === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = (t[i] ?? 0) / mi;
    const b = (t[i + 1] ?? 0) / mi;
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[i] = tau * a * mi;
      t[i + 1] = tau * b * mi;
    }
  }
  let d = `M${pierwszy.x} ${pierwszy.y}`;
  for (let i = 0; i < n - 1; i++) {
    const a = p[i] ?? pierwszy;
    const b = p[i + 1] ?? a;
    const k = (dx[i] ?? 0) / 3;
    d += ` C${a.x + k} ${a.y + (t[i] ?? 0) * k} ${b.x - k} ${b.y - (t[i + 1] ?? 0) * k} ${b.x} ${b.y}`;
  }
  return d;
}

function Linia({ punkty, x, y, postep, wybrany, pole, wysokosc }: LiniaProps) {
  const kolory = useKolory();
  const kolor = kolory.wykres2;
  // Własne id gradientu na wykres: dwa wykresy z polem na jednym ekranie nie dzielą definicji.
  const idPola = `pole${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const wsp = punkty.map((p, i) => ({ x: x(i), y: y(p.y) }));
  const d = sciezkaMonotoniczna(wsp);
  const pierwszy = wsp[0];
  const ostatni = wsp.at(-1);
  // Długość łamanej z zapasem: kreskowanie o tej długości rysuje linię od lewej.
  const dlugosc = wsp.reduce((s, p, i) => {
    const poprz = wsp[i - 1];
    return poprz ? s + Math.hypot(p.x - poprz.x, p.y - poprz.y) : s;
  }, 0) * 1.1 + 1;
  const kreska = useAnimatedProps(() => ({ strokeDashoffset: dlugosc * (1 - postep.value) }));
  const wypelnienie = useAnimatedProps(() => ({ fillOpacity: postep.value }));
  const sel = wybrany === null ? undefined : wsp[wybrany];
  return (
    <>
      <Defs>
        <LinearGradient id={idPola} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={kolor} stopOpacity={0.28} />
          <Stop offset="1" stopColor={kolor} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      {pole && pierwszy && ostatni ? (
        <AnimowanaSciezka d={`${d} L${ostatni.x} ${wysokosc} L${pierwszy.x} ${wysokosc} Z`} fill={`url(#${idPola})`} animatedProps={wypelnienie} />
      ) : null}
      <AnimowanaSciezka d={d} stroke={kolor} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeDasharray={[dlugosc, dlugosc]} animatedProps={kreska} />
      {sel ? <Line x1={sel.x} x2={sel.x} y1={0} y2={wysokosc} stroke={kolory.etykietaTrzeciorzedna} strokeWidth={1} strokeDasharray="3 3" /> : null}
      {(sel ?? ostatni) ? (
        <Circle cx={(sel ?? ostatni)?.x} cy={(sel ?? ostatni)?.y} r={4.5} fill={kolor} stroke={kolory.tloKomorki} strokeWidth={2} />
      ) : null}
    </>
  );
}

type PierscienProps = { punkty: PunktWykresu[]; szerokosc: number; wysokosc: number };

/** Wycinek pierścienia od kąta `a0` do `a1` (radiany, 0 = godzina 3). */
function wycinek(cx: number, cy: number, R: number, r: number, a0: number, a1: number): string {
  'worklet';
  if (a1 - a0 <= 0.0005) return '';
  const duzy = a1 - a0 > Math.PI ? 1 : 0;
  const x0 = cx + R * Math.cos(a0);
  const y0 = cy + R * Math.sin(a0);
  const x1 = cx + R * Math.cos(a1);
  const y1 = cy + R * Math.sin(a1);
  const x2 = cx + r * Math.cos(a1);
  const y2 = cy + r * Math.sin(a1);
  const x3 = cx + r * Math.cos(a0);
  const y3 = cy + r * Math.sin(a0);
  return `M${x0} ${y0} A${R} ${R} 0 ${duzy} 1 ${x1} ${y1} L${x2} ${y2} A${r} ${r} 0 ${duzy} 0 ${x3} ${y3} Z`;
}

const PRZERWA = 0.025;

/** Pierścień udziałów (na stronie wykres kołowy analiz): wycinki rozwijają się zgodnie z ruchem wskazówek. */
function Pierscien({ punkty, szerokosc, wysokosc }: PierscienProps) {
  const kolory = useKolory();
  const suma = punkty.reduce((s, p) => s + Math.max(0, p.y), 0) || 1;
  const najwiekszy = punkty.reduce((m, p, i) => (p.y > (punkty[m]?.y ?? 0) ? i : m), 0);
  const [wybrany, setWybrany] = useState(najwiekszy);
  const postep = usePostep(punkty.map((p) => p.y).join(','));
  const bok = Math.min(szerokosc, wysokosc);
  const R = bok / 2 - 2;
  const r = R * 0.64;
  const cx = szerokosc / 2;
  const cy = bok / 2;
  // Granice wycinków jako ułamki koła: suma udziałów przed wycinkiem i z nim.
  const granice = punkty.map((_, i) => punkty.slice(0, i + 1).reduce((s, p) => s + Math.max(0, p.y), 0) / suma);
  const wycinki = punkty.map((p, i) => ({
    od: granice[i - 1] ?? 0,
    do: granice[i] ?? 1,
    kolor: kolory[p.kolor ?? PALETA[i % PALETA.length] ?? 'wykres2'],
    i,
  }));

  const dotknij = (e: GestureResponderEvent) => {
    const dx = e.nativeEvent.locationX - cx;
    const dy = e.nativeEvent.locationY - cy;
    const odl = Math.hypot(dx, dy);
    if (odl < r * 0.6 || odl > R + 8) return;
    // Kąt od godziny 12, zgodnie z ruchem wskazówek, jako ułamek koła.
    const ulamek = ((Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI);
    const trafiony = wycinki.find((w) => ulamek >= w.od && ulamek < w.do);
    if (trafiony) setWybrany(trafiony.i);
  };

  const sel = punkty[wybrany];
  return (
    <View>
      <Pressable onPress={dotknij}>
        <Svg width={szerokosc} height={bok}>
          {wycinki.map((w) => (
            <Wycinek key={w.i} cx={cx} cy={cy} R={R} r={r} od={w.od} doUlamka={w.do} kolor={w.kolor} postep={postep} przygaszony={w.i !== wybrany} />
          ))}
        </Svg>
      </Pressable>
      {sel ? (
        <View pointerEvents="none" style={[styles.srodekPierscienia, { left: cx - r * 0.8, top: cy - r * 0.55, width: r * 1.6, height: r * 1.1 }]}>
          <Tekst styl="title3" cyfry style={styles.wysrodkowany}>
            {`${Math.round((Math.max(0, sel.y) / suma) * 100)}%`}
          </Tekst>
          <Tekst styl="caption1" kolor="etykietaDrugorzedna" style={styles.wysrodkowany} numberOfLines={2}>
            {sel.x}
          </Tekst>
        </View>
      ) : null}
      <Legenda
        pozycje={punkty.map((p, i) => ({ nazwa: p.x, kolor: p.kolor ?? PALETA[i % PALETA.length] ?? 'wykres2', procent: Math.round((Math.max(0, p.y) / suma) * 100) }))}
        wybrany={wybrany}
        onWybierz={setWybrany}
      />
    </View>
  );
}

type WycinekProps = { cx: number; cy: number; R: number; r: number; od: number; doUlamka: number; kolor: string; postep: SharedValue<number>; przygaszony: boolean };

function Wycinek({ cx, cy, R, r, od, doUlamka, kolor, postep, przygaszony }: WycinekProps) {
  const animowane = useAnimatedProps(() => {
    const start = -Math.PI / 2 + od * 2 * Math.PI * postep.value + PRZERWA / 2;
    const koniec = -Math.PI / 2 + Math.min(doUlamka * 2 * Math.PI, 2 * Math.PI - 0.001) * postep.value - PRZERWA / 2;
    return { d: wycinek(cx, cy, R, r, start, koniec) };
  });
  return <AnimowanaSciezka animatedProps={animowane} fill={kolor} opacity={przygaszony ? 0.45 : 1} />;
}

type PozycjaLegendy = { nazwa: string; kolor: keyof Kolory; procent?: number };

function Legenda({ pozycje, wybrany, onWybierz }: { pozycje: PozycjaLegendy[]; wybrany?: number; onWybierz?: (i: number) => void }) {
  const kolory = useKolory();
  return (
    <View style={styles.legenda}>
      {pozycje.map((p, i) => (
        <Pressable key={p.nazwa} onPress={onWybierz ? () => onWybierz(i) : undefined} disabled={!onWybierz} style={styles.pozycjaLegendy}>
          <View style={[styles.kwadrat, { backgroundColor: kolory[p.kolor] }]} />
          <Tekst styl="caption1" kolor={wybrany === undefined || wybrany === i ? 'etykieta' : 'etykietaDrugorzedna'} numberOfLines={1}>
            {p.nazwa}
          </Tekst>
          {p.procent !== undefined ? (
            <Tekst styl="caption1" kolor="etykietaDrugorzedna" cyfry>
              {`${p.procent}%`}
            </Tekst>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

type DymekProps = { tytul: string; wiersze: { nazwa?: string; kolor?: keyof Kolory; wartosc: string }[]; srodekX: number; gora: number; szerokosc: number };

/** Dymek z wartością nad wybranym słupkiem (`ChartTooltip` na stronie). */
function Dymek({ tytul, wiersze, srodekX, gora, szerokosc }: DymekProps) {
  const kolory = useKolory();
  const [szer, setSzer] = useState(0);
  const [wys, setWys] = useState(0);
  const lewo = Math.max(0, Math.min(szerokosc - szer, srodekX - szer / 2));
  return (
    <View
      pointerEvents="none"
      onLayout={(e) => {
        setSzer(e.nativeEvent.layout.width);
        setWys(e.nativeEvent.layout.height);
      }}
      style={[
        styles.dymek,
        { left: lewo, top: Math.max(0, gora - wys), backgroundColor: kolory.tloKomorki, borderColor: kolory.obwodka, opacity: szer === 0 ? 0 : 1 },
      ]}>
      <Tekst styl="caption1" kolor="etykietaDrugorzedna">
        {tytul}
      </Tekst>
      {wiersze.map((w) => (
        <View key={w.nazwa ?? w.wartosc} style={styles.wierszDymka}>
          {w.kolor ? <View style={[styles.kwadrat, { backgroundColor: kolory[w.kolor] }]} /> : null}
          {w.nazwa ? (
            <Tekst styl="caption1" kolor="etykietaDrugorzedna">
              {w.nazwa}
            </Tekst>
          ) : null}
          <Tekst styl="footnote" cyfry waga="medium">
            {w.wartosc}
          </Tekst>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  podpisY: { position: 'absolute', left: 0, width: OS_Y - ODSTEP.xxs - 2, textAlign: 'right' },
  osX: { flexDirection: 'row', height: WYSOKOSC_OSI_X, alignItems: 'flex-end' },
  podpisX: { flex: 1, textAlign: 'center' },
  legenda: { flexDirection: 'row', flexWrap: 'wrap', columnGap: ODSTEP.m, rowGap: ODSTEP.xs, marginTop: ODSTEP.s },
  pozycjaLegendy: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.xxs + 2 },
  kwadrat: { width: 8, height: 8, borderRadius: 1 },
  srodekPierscienia: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  wysrodkowany: { textAlign: 'center' },
  dymek: {
    position: 'absolute',
    paddingHorizontal: ODSTEP.s - 2,
    paddingVertical: ODSTEP.xs - 2,
    borderWidth: OBWODKA,
    borderRadius: PROMIEN,
    gap: ODSTEP.linia,
  },
  wierszDymka: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.xxs + 2 },
});
