// Jednorazowo, LOKALNIE (nie na serwerze): generuje sekret TOTP dla /wdroz.
//   node ops/bramka/totp-setup.mjs
// 1. Dodaj URI w aplikacji uwierzytelniającej (1Password, Google Authenticator…).
// 2. Wklej SEKRET jako BRAMKA_TOTP_SECRET w Coolify (aplikacja bramki).
// 3. Wyczyść terminal. Sekret nie trafia do repo ani do logów bramki.
import { newTotpSecret } from './src/totp.mjs';

const { secret, uri } = newTotpSecret('FaktWay bramka');
console.log(`SEKRET (BRAMKA_TOTP_SECRET): ${secret}`);
console.log(`URI do aplikacji: ${uri}`);
