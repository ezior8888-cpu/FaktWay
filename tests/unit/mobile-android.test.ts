/**
 * Android w aplikacji na telefon (etap M12a planu aplikacji mobilnej,
 * docs/mobile/ZASADY-DESIGNU.md, sekcja 10). Bez emulatora: sprawdza kod i
 * konfigurację, które na Androidzie dawały błędy, oraz to, że na iOS opcje
 * pasków zostają takie jak przed M12.
 *
 * Czerwone przed zmianą (origin/main po #752):
 * - `Stack.Toolbar.Button` z samym napisem (Anuluj, Szkic, Wyślij, Zapisz) w
 *   ośmiu ekranach: expo-router 58 nie rysuje go na Androidzie, a przycisk po
 *   lewej zastępuje strzałkę wstecz, więc z Androida nie dało się zapisać
 *   szkicu ani wysłać e-maila;
 * - grupy w menu filtrów `inline`: menu Compose gubi ich tytuły (trzy
 *   „Wszystkie” obok siebie);
 * - brak `mobile/src/wyglad/pasek-android.ts` (pasek Material, pasek stanu);
 * - `app.json` bez zablokowanych uprawnień, których aplikacja nie używa.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { Kolory } from '../../mobile/src/wyglad/paleta';

const MOBILE = join(__dirname, '../../mobile');
const SRC = join(MOBILE, 'src');

/** Pliki aplikacji są w osobnym workspace (`mobile/`): czyste moduły transpilujemy i uruchamiamy w osobnym kontekście, jak test kontrastu. */
function wczytaj<T>(sciezka: string, zaleznosci: Record<string, unknown> = {}): T {
  const zrodlo = readFileSync(join(SRC, sciezka), 'utf8');
  const js = ts.transpileModule(zrodlo, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const modul: { exports: Record<string, unknown> } = { exports: {} };
  runInNewContext(js, { module: modul, exports: modul.exports, require: (n: string) => zaleznosci[n] });
  return modul.exports as T;
}

type Pasek = {
  opcjeStosuAndroid: (p: string, ciemny: boolean) => Record<string, unknown>;
  opcjeGradientuAndroid: (p: string, k: Kolory, czcionka: string) => Record<string, unknown>;
  koloryPaska: (p: string, k: Kolory, naGradiencie: boolean) => { ikona: string; ikonaAktywna: string; narzedzia: Record<string, unknown> };
  opcjeWyszukiwarkiAndroid: (p: string, k: Kolory) => Record<string, unknown>;
  stopyPodPaskiemAndroid: (nad: number, pod: number) => { y: number; kolor: keyof Kolory }[];
};

function plikiTsx(katalog: string): string[] {
  return readdirSync(katalog).flatMap((nazwa) => {
    const pelna = join(katalog, nazwa);
    if (statSync(pelna).isDirectory()) return plikiTsx(pelna);
    return pelna.endsWith('.tsx') ? [pelna] : [];
  });
}

/** Otwierające znaczniki komponentu (do pierwszego `>` poza nawiasami klamrowymi). */
function znaczniki(zrodlo: string, nazwa: string): string[] {
  const wynik: string[] = [];
  let od = zrodlo.indexOf(`<${nazwa}`);
  while (od !== -1) {
    let glebokosc = 0;
    let i = od + nazwa.length + 1;
    for (; i < zrodlo.length; i++) {
      const z = zrodlo[i];
      if (z === '{') glebokosc++;
      else if (z === '}') glebokosc--;
      else if (z === '>' && glebokosc === 0) break;
    }
    const znacznik = zrodlo.slice(od, i + 1);
    // `<Stack.Toolbar.Button` nie łapie `<Stack.Toolbar.ButtonX`.
    if (/^<[\w.]+[\s/>]/.test(znacznik) && znacznik.startsWith(`<${nazwa}`) && /[\s/>]/.test(zrodlo[od + nazwa.length + 1] ?? '')) wynik.push(znacznik);
    od = zrodlo.indexOf(`<${nazwa}`, od + 1);
  }
  return wynik;
}

const ekrany = plikiTsx(SRC).map((p) => ({ plik: relative(MOBILE, p), zrodlo: readFileSync(p, 'utf8') }));

describe('pasek u góry na Androidzie: przyciski i menu', () => {
  it('przycisk paska z samym napisem idzie przez PrzyciskPaska (Android nie rysuje Stack.Toolbar.Button bez ikony)', () => {
    const bezIkony = ekrany
      .filter((e) => e.plik !== 'src/komponenty/przycisk-paska.tsx')
      .flatMap((e) => znaczniki(e.zrodlo, 'Stack.Toolbar.Button').filter((z) => !/\bicon=/.test(z)).map((z) => `${e.plik}: ${z.slice(0, 60)}`));
    expect(bezIkony).toEqual([]);
  });

  it('menu w pasku ma ikonę z obrazu (Android nie zna symboli SF), a grupy menu nie stoją w linii na sztywno', () => {
    const bledy = ekrany.flatMap((e) =>
      znaczniki(e.zrodlo, 'Stack.Toolbar.Menu').flatMap((z) => {
        // Głębokość: ile menu jest otwartych przed tym znacznikiem. Menu w menu to podmenu z napisem, bez ikony.
        const przed = e.zrodlo.slice(0, e.zrodlo.indexOf(z));
        const glebokosc = (przed.match(/<Stack\.Toolbar\.Menu[\s>]/g) ?? []).length - (przed.match(/<\/Stack\.Toolbar\.Menu>/g) ?? []).length;
        if (/\binline\b/.test(z) && !/inline=\{GRUPY_MENU_W_LINII\}/.test(z)) return [`${e.plik}: grupa „inline” bez GRUPY_MENU_W_LINII: ${z.slice(0, 70)}`];
        if (glebokosc === 0 && !/icon=\{IKONY_PASKA\./.test(z)) return [`${e.plik}: menu w pasku bez ikony IKONY_PASKA: ${z.slice(0, 70)}`];
        return [];
      }),
    );
    expect(bledy).toEqual([]);
  });

  it('PrzyciskPaska na iOS zostaje systemowym przyciskiem paska z tym samym napisem', () => {
    const zrodlo = readFileSync(join(SRC, 'komponenty/przycisk-paska.tsx'), 'utf8');
    expect(zrodlo).toMatch(/if \(Platform\.OS !== 'android'\) \{\s*return \(\s*<Stack\.Toolbar placement=\{placement\}>/);
    expect(zrodlo).toContain('<Stack.Toolbar.Button variant="done" onPress={onPress}>');
    expect(zrodlo).toContain('<Stack.Toolbar.Button onPress={onPress}>{tytul}</Stack.Toolbar.Button>');
  });
});

describe('opcje pasków: iOS bez zmian, Android z paskiem Material', () => {
  const { JASNE, CIEMNE } = wczytaj<{ JASNE: Kolory; CIEMNE: Kolory }>('wyglad/paleta.ts');
  // Wczytywane w każdym teście: bez pliku (przed M12) każdy test jest czerwony osobno.
  const pasek = () => wczytaj<Pasek>('wyglad/pasek-android.ts');

  it('na iOS każda funkcja oddaje to, co ekrany miały przed M12', () => {
    const p = pasek();
    for (const k of [JASNE, CIEMNE]) {
      expect(p.opcjeStosuAndroid('ios', k === CIEMNE)).toEqual({});
      expect(p.opcjeGradientuAndroid('ios', k, 'Outfit-SemiBold')).toEqual({});
      expect(p.opcjeWyszukiwarkiAndroid('ios', k)).toEqual({});
      expect(p.koloryPaska('ios', k, true)).toEqual({ ikona: k.etykieta, ikonaAktywna: k.akcent, narzedzia: {} });
      expect(p.koloryPaska('ios', k, false)).toEqual({ ikona: k.etykieta, ikonaAktywna: k.akcent, narzedzia: {} });
    }
  });

  it('Android: pasek stanu na każdym ekranie według motywu (po Pulpicie nie zostaje biały na jasnym)', () => {
    const p = pasek();
    expect(p.opcjeStosuAndroid('android', false)).toEqual({ statusBarStyle: 'dark' });
    expect(p.opcjeStosuAndroid('android', true)).toEqual({ statusBarStyle: 'light' });
  });

  it('Android: ekran z gradientem ma pasek w kolorze góry gradientu, biały tytuł, białe ikony i jasny pasek stanu', () => {
    const p = pasek();
    for (const k of [JASNE, CIEMNE]) {
      expect(p.opcjeGradientuAndroid('android', k, 'Outfit-SemiBold')).toEqual({
        headerStyle: { backgroundColor: k.gradientGora },
        headerTintColor: k.naGradiencie,
        headerTitleStyle: { fontFamily: 'Outfit-SemiBold', color: k.naGradiencie },
        statusBarStyle: 'light',
      });
      const naGradiencie = p.koloryPaska('android', k, true);
      expect(naGradiencie.ikona).toBe(k.naGradiencie);
      expect(naGradiencie.ikonaAktywna).toBe(k.naGradiencie);
      // Menu Compose: biała karta z ciemnym tekstem; okrąg za ikoną, bo inaczej za ikoną byłby biały kwadrat.
      expect(naGradiencie.narzedzia).toEqual({ tintColor: k.etykieta, backgroundColor: k.tloKomorki, buttonContainerColor: k.naGradiencieTlo });
      expect(p.koloryPaska('android', k, false)).toEqual({
        ikona: k.etykieta,
        ikonaAktywna: k.akcent,
        narzedzia: { tintColor: k.etykieta, backgroundColor: k.tloKomorki, buttonContainerColor: 'transparent' },
      });
      expect(p.opcjeWyszukiwarkiAndroid('android', k)).toMatchObject({ headerIconColor: k.naGradiencie, textColor: k.naGradiencie });
    }
  });

  it('Android: gradient pod paskiem zaczyna się kolorem paska i do połowy trzyma kontrast białego tekstu', () => {
    const p = pasek();
    const NAD = 900;
    const POD = 120;
    const NAD_TRESCIA = 150;
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const luminancja = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    const kolorW = (stopy: { y: number; kolor: string }[], y: number) => {
      for (let i = 0; i < stopy.length - 1; i++) {
        const [a, b] = [stopy[i], stopy[i + 1]];
        if (y >= a.y && y <= b.y) {
          const t = b.y === a.y ? 0 : (y - a.y) / (b.y - a.y);
          return hex(a.kolor).map((x, j) => x + (hex(b.kolor)[j] - x) * t);
        }
      }
      return hex(stopy[stopy.length - 1].kolor);
    };
    const kontrastBieli = (rgb: number[]) => 1.05 / (luminancja(rgb) + 0.05);

    for (const k of [JASNE, CIEMNE]) {
      const android = p.stopyPodPaskiemAndroid(NAD, POD).map((s) => ({ y: s.y, kolor: k[s.kolor] }));
      // Stopy jak w `komponenty/gradient-naglowka.tsx` (iOS, pasek przezroczysty nad treścią).
      const ios = [
        { y: -NAD, kolor: k.gradientGora },
        { y: -NAD_TRESCIA, kolor: k.gradientGora },
        { y: -NAD_TRESCIA * 0.4, kolor: k.gradientSrodek },
        { y: POD * 0.35, kolor: k.gradientDol },
        { y: POD, kolor: k.tloGrupowane },
      ];
      expect(android[1]).toEqual({ y: 0, kolor: k.gradientGora });
      expect(android[android.length - 1]).toEqual({ y: POD, kolor: k.tloGrupowane });
      expect(android.every((s, i) => i === 0 || s.y >= android[i - 1].y)).toBe(true);
      for (let y = 0; y <= POD / 2; y += 2) {
        const naAndroidzie = kontrastBieli(kolorW(android, y));
        expect(naAndroidzie, `y = ${y}`).toBeGreaterThanOrEqual(Math.min(kontrastBieli(kolorW(ios, y)), 7) - 0.01);
      }
    }
  });
});

describe('konfiguracja Androida (app.json)', () => {
  const config = JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8')).expo as {
    primaryColor?: string;
    android: { package: string; adaptiveIcon: Record<string, string>; blockedPermissions?: string[]; predictiveBackGestureEnabled?: boolean };
    plugins: (string | [string, Record<string, unknown>])[];
  };

  it('pakiet, ikona adaptacyjna z wersją jednobarwną, kolor marki i gest wstecz', () => {
    expect(config.android.package).toBe('pl.faktway.app');
    expect(config.android.adaptiveIcon).toMatchObject({
      backgroundColor: '#2463EF',
      foregroundImage: expect.stringContaining('android-ikona-pierwszy-plan.png'),
      monochromeImage: expect.stringContaining('android-ikona-mono.png'),
    });
    expect(config.primaryColor).toBe('#2463EF');
    expect(config.android.predictiveBackGestureEnabled).toBe(true);
  });

  it('bez uprawnień, których aplikacja nie używa (okno nad innymi, zapis plików, mikrofon)', () => {
    expect(config.android.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.SYSTEM_ALERT_WINDOW',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.RECORD_AUDIO',
      ]),
    );
    // Aparat (zdjęcie wydatku) i biometria zostają: dokładają je pluginy.
    const nazwy = config.plugins.map((w) => (Array.isArray(w) ? w[0] : w));
    expect(nazwy).toEqual(expect.arrayContaining(['expo-image-picker', 'expo-local-authentication']));
    expect(config.android.blockedPermissions).not.toContain('android.permission.CAMERA');
  });
});
