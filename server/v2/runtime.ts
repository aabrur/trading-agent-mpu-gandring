import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { log, safe } from '../redact.js';
import { configurationFingerprint } from '../session-entry.js';
import {
  getSessionLogger,
  recordDiagnostic,
  registerDiagnosticSecrets
} from '../session-log.js';
import {
  EXCHANGES,
  type AppMode,
  type Network,
  type OfficeCommand,
  type OfficeReply,
  type OfficeRuntime,
  type OfficeState,
  type TradingMode,
  type VenueId
} from './contracts.js';
import {
  attachOfficeWebSocket,
  createInitialOfficeState,
  OfficeEventHub
} from './office.js';
import { createReplacementApp } from './app.js';

export class StartupValidationError extends Error {
  constructor(message: string, public readonly exitCode = 2) {
    super(message);
    this.name = 'StartupValidationError';
  }
}

const VENUE_PREFIX: Record<VenueId, string> = {
  bybit: 'BYBIT',
  binance: 'BINANCE',
  okx: 'OKX',
  hyperliquid: 'HYPERLIQUID',
  aster: 'ASTER',
  dydx: 'DYDX',
  paradex: 'PARADEX',
  orderly: 'ORDERLY'
};

export function venueCredentialEnvNames(
  venue: VenueId,
  network: Network
): { key: string; secret: string; passphrase?: string } {
  const prefix = VENUE_PREFIX[venue] + (network === 'testnet' ? '_TESTNET' : '');
  switch (venue) {
    case 'hyperliquid':
      return { key: `${prefix}_ACCOUNT_ADDRESS`, secret: `${prefix}_AGENT_PRIVATE_KEY` };
    case 'aster':
      return { key: `${prefix}_USER_ADDRESS`, secret: `${prefix}_SIGNER_PRIVATE_KEY` };
    case 'dydx':
      return { key: `${prefix}_ADDRESS`, secret: `${prefix}_API_PRIVATE_KEY`, passphrase: `${prefix}_AUTHENTICATOR_ID` };
    case 'paradex':
      return { key: `${prefix}_ACCOUNT_ADDRESS`, secret: `${prefix}_SUBKEY_PRIVATE_KEY` };
    case 'orderly':
      return { key: `${prefix}_ACCOUNT_ID`, secret: `${prefix}_KEY_SECRET` };
    case 'okx':
      return { key: `${prefix}_API_KEY`, secret: `${prefix}_API_SECRET`, passphrase: `${prefix}_API_PASSPHRASE` };
    default:
      return { key: `${prefix}_API_KEY`, secret: `${prefix}_API_SECRET` };
  }
}

export interface StartupEnvCheck {
  tradingMode: TradingMode;
  appMode: AppMode;
  host: string;
  port: number;
  venue: VenueId | null;
  network: Network | null;
}

export function validateStartupEnvironment(env: NodeJS.ProcessEnv = process.env): StartupEnvCheck {
  const rawMode = (env.TRADING_MODE ?? 'PAPER').trim().toUpperCase();
  if (rawMode !== 'PAPER' && rawMode !== 'TESTNET' && rawMode !== 'LIVE') {
    throw new StartupValidationError(
      `TRADING_MODE is "${rawMode}". Use PAPER (default), TESTNET or LIVE. Refusing to start.`,
      2
    );
  }
  const tradingMode = rawMode as TradingMode;

  const rawAppMode = (env.APP_MODE || 'local').trim().toLowerCase();
  if (rawAppMode !== 'local' && rawAppMode !== 'grokbot') {
    throw new StartupValidationError('APP_MODE must be local or grokbot', 2);
  }
  const appMode = rawAppMode as AppMode;

  const rawVenue = (env.EXCHANGE ?? '').trim().toLowerCase();
  if (rawVenue && rawVenue !== 'none' && !(EXCHANGES as readonly string[]).includes(rawVenue)) {
    throw new StartupValidationError(
      `EXCHANGE="${rawVenue}" is not one of none, ${EXCHANGES.join(', ')}`,
      2
    );
  }
  const venue = rawVenue && rawVenue !== 'none' ? (rawVenue as VenueId) : null;
  const network: Network | null =
    tradingMode === 'LIVE' ? 'mainnet' : tradingMode === 'TESTNET' ? 'testnet' : null;

  if (network) {
    const reasons: string[] = [];
    if (!venue) {
      reasons.push('EXCHANGE is not set');
    } else {
      const names = venueCredentialEnvNames(venue, network);
      const key = (env[names.key] ?? '').trim();
      const secret = (env[names.secret] ?? '').trim();
      const passphrase = names.passphrase ? (env[names.passphrase] ?? '').trim() : 'ok';
      if (!key || !secret || !passphrase) {
        reasons.push(`${network} ${venue} keys are missing in .env`);
      }
      if (tradingMode === 'LIVE' && venue !== 'bybit' && (env.ALLOW_EXPERIMENTAL_LIVE ?? '').trim() !== 'yes') {
        reasons.push(`the ${venue} adapter is experimental and unverified; LIVE on it needs ALLOW_EXPERIMENTAL_LIVE=yes`);
      }
    }
    const safetyNet = Number(env.SAFETY_NET ?? 200);
    if (!(safetyNet > 0)) {
      reasons.push('SAFETY_NET must be above zero outside PAPER');
    }
    if (reasons.length > 0) {
      throw new StartupValidationError(
        `TRADING_MODE=${tradingMode} cannot start, refusing. Fix this or go back to PAPER (npm run setup):\n  - ${reasons.join('\n  - ')}`,
        2
      );
    }
  }

  const rawN = env.OPEN_ORDERS_N;
  if (rawN !== undefined && rawN !== '') {
    const n = Number(rawN);
    if (!Number.isInteger(n) || n < 1 || n > 4) {
      throw new StartupValidationError('OPEN_ORDERS_N must be an integer from 1 to 4', 2);
    }
  }

  const rawPort = env.PORT === undefined || env.PORT === '' ? 8787 : Number(env.PORT);
  if (!Number.isInteger(rawPort) || rawPort < 0 || rawPort > 65535) {
    throw new StartupValidationError('PORT must be a valid TCP port (0..65535)', 2);
  }

  const requestedHost = (env.HOST || '127.0.0.1').trim();
  const host = tradingMode === 'LIVE' ? '127.0.0.1' : requestedHost;

  return {
    tradingMode,
    appMode,
    host,
    port: rawPort,
    venue,
    network
  };
}

export interface ReplacementRuntimeHandle extends OfficeRuntime {
  readonly hub: OfficeEventHub;
  updateState(mutator: (draft: OfficeState) => OfficeState | void): OfficeState;
}

export interface ReplacementRuntimeOptions {
  version?: string;
  sessionId?: string | null;
  startedAt?: number;
  initialMode?: TradingMode;
  initialAppMode?: AppMode;
  dispatcher?: (input: OfficeCommand, state: OfficeState) => Promise<OfficeReply>;
}

export function createReplacementRuntime(
  options: ReplacementRuntimeOptions = {}
): ReplacementRuntimeHandle {
  const hub = new OfficeEventHub();
  let state = createInitialOfficeState({
    version: options.version,
    sessionId: options.sessionId,
    startedAt: options.startedAt
  });
  if (options.initialMode) {
    state = { ...state, mode: options.initialMode };
  }
  if (options.initialAppMode) {
    state = { ...state, appMode: options.initialAppMode };
  }

  const snapshot = (): OfficeState => structuredClone(state);

  const updateState = (mutator: (draft: OfficeState) => OfficeState | void): OfficeState => {
    const next = structuredClone(state);
    const returned = mutator(next);
    state = returned ?? next;
    hub.emit('state', snapshot());
    return snapshot();
  };

  const dispatch = async (input: OfficeCommand): Promise<OfficeReply> => {
    if (options.dispatcher) {
      return options.dispatcher(input, snapshot());
    }
    if (input.kind === 'kill') {
      updateState((draft) => {
        draft.killed = true;
        draft.auto.on = false;
      });
      return {
        ok: true,
        code: 'OK',
        message: 'Local halt latch engaged.'
      };
    }
    if (input.kind === 'unkill') {
      if (input.actor !== 'local_owner') {
        return {
          ok: false,
          code: 'UNAUTHORIZED',
          message: 'Only local Owner may release the kill switch.'
        };
      }
      updateState((draft) => {
        draft.killed = false;
      });
      return {
        ok: true,
        code: 'OK',
        message: 'Local halt latch released; Auto remains OFF.'
      };
    }
    return {
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      message: `Runtime service for "${input.kind}" is not configured yet; refusing to fabricate results.`
    };
  };

  return {
    hub,
    snapshot,
    updateState,
    dispatch
  };
}

export async function startReplacementServer(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ server: HttpServer; runtime: ReplacementRuntimeHandle } | null> {
  registerDiagnosticSecrets(env);
  let startup: StartupEnvCheck;
  try {
    startup = validateStartupEnvironment(env);
  } catch (error) {
    console.error(`[trading-agent-mpu-gandring] ${safe((error as Error).message)}`);
    recordDiagnostic({
      source: 'startup',
      category: 'SESSION',
      eventName: 'startup.configuration_failed',
      level: 'ERROR',
      status: 'failed',
      message: 'Configuration validation failed',
      details: { error }
    });
    process.exitCode = error instanceof StartupValidationError ? error.exitCode : 1;
    return null;
  }

  if (startup.network) {
    recordDiagnostic({
      source: 'startup',
      category: 'SESSION',
      eventName: 'startup.permission_refused',
      status: 'refused',
      level: 'ERROR',
      message: 'Venue permission verification adapter is not initialized yet.'
    });
    console.error(
      `[trading-agent-mpu-gandring] ${startup.tradingMode} refused at startup: venue permission verification service is not initialized yet.`
    );
    process.exitCode = 2;
    return null;
  }

  const sessionLogger = getSessionLogger();
  sessionLogger?.updateContext({
    mode: startup.tradingMode,
    appMode: startup.appMode.toUpperCase(),
    exchange: startup.venue,
    providers: {},
    configFingerprint: configurationFingerprint(startup)
  });

  const runtime = createReplacementRuntime({
    sessionId: sessionLogger?.session.sessionId ?? null,
    initialMode: startup.tradingMode,
    initialAppMode: startup.appMode
  });
  const app = createReplacementApp(runtime, { sessionLogger });
  const server = createServer(app);
  const wss = attachOfficeWebSocket(server, runtime, runtime.hub);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(startup.port, startup.host, () => resolve());
  });

  const boundPort = (server.address() as AddressInfo | null)?.port ?? startup.port;
  recordDiagnostic({
    source: 'server',
    category: 'SESSION',
    eventName: 'service.ready',
    status: 'ready',
    message: 'Replacement office services ready',
    details: { host: startup.host, port: boundPort, runtimeGeneration: 'v2' }
  });
  log(
    `Trading Agent Mpu Gandring backend on http://${startup.host}:${boundPort} (mode ${startup.tradingMode}, app ${startup.appMode}, generation v2)`
  );

  const shutdown = () => {
    wss.close();
    server.closeAllConnections();
    server.close(() => {
      void (getSessionLogger()?.finish('INTERRUPTED', 'Server shutdown completed') ?? Promise.resolve()).finally(() => {
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { server, runtime };
}
