export interface AutostartOptions {
  root: string;
  nodePath?: string;
}

export function generateAutostartScript(options: AutostartOptions): string {
  const node = options.nodePath ?? 'node';
  const root = options.root;
  return `"${node}" "${root}\\bin\\mpu.mjs"`;
}

export function validateLiveConfirmation(phrase: string): { ok: boolean; error?: string } {
  const REQUIRED = 'I understand LIVE trades real money';
  const trimmed = phrase?.trim();
  if (trimmed === REQUIRED) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `LIVE mode requires typing the exact confirmation phrase: "${REQUIRED}". Received: "${phrase}".`
  };
}

export function processUnkillRelease(options: { currentKilled: boolean; currentAuto: boolean }): {
  killed: boolean;
  autoEnabled: boolean;
} {
  return {
    killed: false,
    autoEnabled: false
  };
}
