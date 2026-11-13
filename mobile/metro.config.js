// Metro aplikacji (plan aplikacji mobilnej 4.1, etap M7).
// Kontrakt API strony (`lib/api/mobile/kontrakt.ts`, plik bez importów) czytamy
// wprost z repozytorium, bez kopii: `src/lib/api/kontrakt.ts` go reeksportuje.
// Metro widzi tylko pliki z `watchFolders`, więc dopisujemy jeden katalog,
// nie całe repozytorium (inaczej obserwowałoby też node_modules strony).
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../lib/api/mobile')];

module.exports = config;
