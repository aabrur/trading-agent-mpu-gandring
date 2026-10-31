import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerSecrets } from '../../redact.js';
import { EXCHANGES, NETWORKS, type Network, type VenueId } from '../contracts.js';
import { venueCredentialEnvNames } from '../runtime.js';
import { API_PROVIDERS, type ApiProviderId } from './schema.js';

export const PROVIDER_KEY_ENV: Record<ApiProviderId, string> = {
  xai: 'XAI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY'
};

const EXTRA_SECRET_ENV_NAMES = [
  'AGENT_EVENT_SECRET',
  'GROKBOT_WEBHOOK_KEY',
  'GROK_BRIDGE_HMAC_SECRET',
  'TRADINGVIEW_PASSPHRASE',
  'CRYPTOPANIC_API_KEY',
  'WHALE_ALERT_API_KEY',
  'CMC_API_KEY',
  'COINGLASS_API_KEY',
  'TREE_OF_ALPHA_API_KEY',
  'ARKHAM_API_KEY',
  'FRED_API_KEY',
  'JEV_OPENROUTER_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'DISCORD_BOT_TOKEN',
  'DISCORD_PUBLIC_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN'
] as const;

const PUBLIC_ADDRESS_VENUES = new Set<VenueId>(['hyperliquid', 'aster', 'dydx', 'paradex', 'orderly']);

function parseEnvContent(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export interface SecretStatusSummary {
  providersConfigured: Record<ApiProviderId, boolean>;
  venuesConfigured: Record<VenueId, Record<Network, boolean>>;
  externalEnvDraftDetected: boolean;
}

export class SecretStore {
  private readonly envFile: string | null;
  private readonly allowWrite: boolean;
  private readonly memoryOverrides: Record<string, string>;
  private baselineHash: string | null = null;

  constructor(options: {
    envFile?: string | null;
    allowWrite?: boolean;
    initialOverrides?: Record<string, string>;
  } = {}) {
    this.envFile = options.envFile === undefined ? null : options.envFile;
    this.allowWrite = options.allowWrite ?? false;
    this.memoryOverrides = { ...(options.initialOverrides ?? {}) };
    this.captureBaselineHash();
    this.registerKnownSecrets();
  }

  private captureBaselineHash(): void {
    if (this.envFile && existsSync(this.envFile)) {
      this.baselineHash = createHash('sha256').update(readFileSync(this.envFile)).digest('hex');
    } else {
      this.baselineHash = null;
    }
  }

  readEnvMap(): Record<string, string> {
    const fromFile = this.envFile && existsSync(this.envFile)
      ? parseEnvContent(readFileSync(this.envFile, 'utf8'))
      : {};
    return {
      ...fromFile,
      ...this.memoryOverrides
    };
  }

  private registerKnownSecrets(): void {
    const env = this.readEnvMap();
    const sensitive: string[] = [];
    for (const envName of Object.values(PROVIDER_KEY_ENV)) {
      if (env[envName]) sensitive.push(env[envName]!);
    }
    for (const envName of EXTRA_SECRET_ENV_NAMES) {
      if (env[envName]) sensitive.push(env[envName]!);
    }
    for (const venue of EXCHANGES) {
      for (const net of NETWORKS) {
        const names = venueCredentialEnvNames(venue, net);
        if (!PUBLIC_ADDRESS_VENUES.has(venue) && env[names.key]) {
          sensitive.push(env[names.key]!);
        }
        if (env[names.secret]) {
          sensitive.push(env[names.secret]!);
        }
        if (names.passphrase && venue !== 'dydx' && env[names.passphrase]) {
          sensitive.push(env[names.passphrase]!);
        }
      }
    }
    registerSecrets(sensitive);
  }

  hasExternalDraftEdit(): boolean {
    if (!this.envFile || !existsSync(this.envFile)) {
      return this.baselineHash !== null;
    }
    const currentHash = createHash('sha256').update(readFileSync(this.envFile)).digest('hex');
    return this.baselineHash !== null && currentHash !== this.baselineHash;
  }

  hasProviderKey(provider: ApiProviderId): boolean {
    const env = this.readEnvMap();
    return Boolean((env[PROVIDER_KEY_ENV[provider]] ?? '').trim());
  }

  getSecret(envKey: string): string | null {
    const val = (this.readEnvMap()[envKey] ?? '').trim();
    return val.length > 0 ? val : null;
  }

  hasVenueCredentials(venue: VenueId, network: Network): boolean {
    const env = this.readEnvMap();
    const names = venueCredentialEnvNames(venue, network);
    const key = (env[names.key] ?? '').trim();
    const secret = (env[names.secret] ?? '').trim();
    const passphrase = names.passphrase ? (env[names.passphrase] ?? '').trim() : 'ok';
    return Boolean(key && secret && passphrase);
  }

  writeSecrets(updates: Record<string, string>): void {
    for (const [k, v] of Object.entries(updates)) {
      this.memoryOverrides[k] = v;
    }
    this.registerKnownSecrets();
    if (!this.allowWrite || !this.envFile) {
      return;
    }

    const existingLines = existsSync(this.envFile)
      ? readFileSync(this.envFile, 'utf8').split(/\r?\n/)
      : [];
    const remaining = new Map(Object.entries(updates));
    const nextLines = existingLines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eq = line.indexOf('=');
      if (eq <= 0) return line;
      const key = line.slice(0, eq).trim();
      if (!remaining.has(key)) return line;
      const val = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${val}`;
    });
    for (const [key, val] of remaining.entries()) {
      nextLines.push(`${key}=${val}`);
    }

    mkdirSync(path.dirname(this.envFile), { recursive: true, mode: 0o700 });
    const tmpFile = `${this.envFile}.${randomUUID()}.tmp`;
    writeFileSync(tmpFile, nextLines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
    renameSync(tmpFile, this.envFile);
    this.captureBaselineHash();
  }

  statusSummary(): SecretStatusSummary {
    const providersConfigured = {} as Record<ApiProviderId, boolean>;
    for (const p of API_PROVIDERS) {
      providersConfigured[p] = this.hasProviderKey(p);
    }
    const venuesConfigured = {} as Record<VenueId, Record<Network, boolean>>;
    for (const venue of EXCHANGES) {
      venuesConfigured[venue] = {
        testnet: this.hasVenueCredentials(venue, 'testnet'),
        mainnet: this.hasVenueCredentials(venue, 'mainnet')
      };
    }
    return {
      providersConfigured,
      venuesConfigured,
      externalEnvDraftDetected: this.hasExternalDraftEdit()
    };
  }
}
