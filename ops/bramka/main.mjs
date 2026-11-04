// Bramka FaktWay — bot Telegrama dla operatorów (B-2, krok 9 planu automatyzacji).
// Działa na ops-1 jako osobna aplikacja Coolify. Long polling: bez publicznego
// endpointu i bez otwartych portów. Instrukcja: docs/runbooks/bramka-telegram.md.
import { createCoolify, createGithub, createTelegram } from './src/clients.mjs';
import { createBramka } from './src/commands.mjs';
import { loadConfig } from './src/config.mjs';
import { createDb } from './src/db.mjs';
import { createDeployer } from './src/deploy.mjs';
import { createTotpVerifier } from './src/totp.mjs';

const log = (...args) => console.log(new Date().toISOString(), ...args);

let config;
try {
  config = loadConfig();
} catch (err) {
  log(`konfiguracja: ${err instanceof Error ? err.message : 'błąd'} — bramka nie startuje`);
  process.exit(1);
}
const telegram = createTelegram({ token: config.telegramToken });
const coolify = createCoolify(config.coolify);
const github = createGithub(config.github);
const db = createDb(config.databaseUrl);
const deployer = createDeployer({ github, coolify, db, config });
const bramka = createBramka({
  users: config.users,
  telegram,
  db,
  coolify,
  deployer,
  verifyTotp: createTotpVerifier(config.totpSecret),
  config,
  log,
});

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`${signal} — kończę po bieżącym odpytaniu`);
    stopping = true;
    if (deployer.isRunning()) log('UWAGA: przerwano w trakcie wdrożenia — sprawdź stan w Coolify');
    setTimeout(() => process.exit(0), 30_000).unref();
  });
}

async function poll() {
  await telegram.deleteWebhook();
  // Potwierdzenie startu do operatorów — po restarcie widać, że bramka żyje.
  for (const id of config.users.keys()) {
    await telegram.sendMessage(id, '🟢 Bramka uruchomiona. /pomoc — lista poleceń.').catch(() => {});
  }
  log(`start: ${config.users.size} operator(ów), repo ${config.github.repo}@${config.github.branch}`);

  let offset = 0;
  let backoffMs = 1_000;
  while (!stopping) {
    try {
      const updates = await telegram.getUpdates(offset);
      backoffMs = 1_000;
      for (const update of updates) {
        offset = update.update_id + 1;
        // Polecenia po kolei; /wdroz i tak biegnie w tle po starcie.
        await bramka.handleUpdate(update);
      }
    } catch (err) {
      // 409: drugi proces odpytuje ten sam bot (np. na chwilę przy wdrożeniu bramki).
      log(`odpytywanie Telegrama: ${err instanceof Error ? err.message : 'błąd'} — ponowię za ${backoffMs / 1000} s`);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
  await db.end();
}

poll().catch((err) => {
  log(`bramka padła: ${err instanceof Error ? err.message : 'nieznany błąd'}`);
  process.exit(1);
});
