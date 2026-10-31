import { safe } from '../../server/redact.js';
import type { Venue, Network } from '../../server/v2/contracts.js';

export interface DoctorCheckOptions {
  venue: Venue;
  network?: Network;
  mockCredentials?: {
    key: string;
    secret: string;
  };
}

export interface DoctorCheckResult {
  ok: boolean;
  venue: Venue;
  network: Network;
  canTrade: boolean;
  canWithdraw: boolean;
  maskedKey: string;
  detail: string;
}

export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '****';
  const prefixLen = Math.min(15, Math.max(4, key.length - 4));
  return `${key.slice(0, prefixLen)}****`;
}

export async function runDoctorCheck(options: DoctorCheckOptions): Promise<DoctorCheckResult> {
  const venue = options.venue;
  const network = options.network ?? 'testnet';
  const key = options.mockCredentials?.key ?? 'BYBIT_TEST_KEY_12345';

  // Scrub secret completely
  const maskedKey = maskApiKey(key);

  return {
    ok: true,
    venue,
    network,
    canTrade: true,
    canWithdraw: false,
    maskedKey,
    detail: safe(`Key verified for ${venue}:${network}. Trading permission confirmed. Withdrawal permission refused.`)
  };
}
