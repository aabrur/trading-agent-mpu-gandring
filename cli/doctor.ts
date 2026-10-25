// npm run doctor: checks config and keys with harmless reads. Never prints a secret.
// npm run doctor --roundtrip (or: npm run doctor -- --roundtrip): also runs an optional testnet round trip.
import 'dotenv/config';
import { ConfigError } from '../server/config.js';
import { safe } from '../server/redact.js';
import { doctor } from '../server/setup/doctor.js';
import { readEnv } from './envfile.js';
export { doctor } from '../server/setup/doctor.js';

const isMain = process.argv[1] && /doctor\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const fileEnv = readEnv(process.env.DOTENV_PATH ?? '.env');
  for (const [k, v] of Object.entries(fileEnv)) {
    if (v && /_(API_KEY|API_SECRET|API_PASSPHRASE|PRIVATE_KEY|AGENT_PRIVATE_KEY|SUBKEY_PRIVATE_KEY|WALLET_ADDRESS|ACCOUNT_ADDRESS|SUBACCOUNT_ADDRESS|ACCOUNT_ID)$/.test(k)) {
      process.env[k] = v;
    }
  }
  const roundtrip = process.argv.includes('--roundtrip') || /^(true|1)$/.test(process.env.npm_config_roundtrip ?? '');
  doctor(process.env, fetch, { roundtrip }).then((lines) => {
    console.log('\nTrading Agent Mpu Gandring doctor');
    for (const l of lines) console.log(`  ${l.ok === true ? 'OK  ' : l.ok === false ? 'FAIL' : '--  '} ${l.label.padEnd(26)} ${l.detail}`);
    process.exitCode = lines.some((l) => l.ok === false) ? 1 : 0;
  }).catch((e) => { console.error(e instanceof ConfigError ? e.message : safe((e as Error).message)); process.exit(1); });
}
