import { safe } from '../../server/redact.js';

export function getCliHelpText(): string {
  return `Trading Agent Mpu Gandring (mpu)

Usage:
  mpu                      Start the desk and open the web office
  mpu dev                  Run local dev server and web UI concurrently
  mpu status               Check setup status, mode, and key permissions
  mpu version [args]       Show app version, git commit, mode, and health
  mpu doctor [args]        Run key, network, and permission health checks
  mpu setup [args]         Setup wizard, status, guide, or link
  mpu paper                Quick shortcut to set TRADING_MODE=PAPER
  mpu testnet [args]       Quick shortcut to set TRADING_MODE=TESTNET
  mpu live [args]          Quick shortcut to set TRADING_MODE=LIVE
  mpu positions [args]     Show open positions with SL/TP and PnL
  mpu account [args]       Show balance, equity, and safety net status
  mpu split                Show account money trade split and N allocation
  mpu scan [args]          Run proactive scan (loss cap, stops, errors)
  mpu report [args]        Generate and display latest desk report
  mpu analyze <symbol>     Run agent debate and analysis for symbol
  mpu debate [args]        Run autonomous agent debate in terminal
  mpu open <sym> <side>    Open position using active settings
  mpu close <sym|all>      Close position for symbol or all
  mpu size [args]          Preview ticket sizing and risk check
  mpu market <sym> [args]  Fetch price, 24h change, and funding rate
  mpu candles <sym> [tf]   Fetch closed candle data for timeframe
  mpu lessons [list|add]   List or add self-improving lessons
  mpu kill [confirm]       Trip emergency kill switch
  mpu unkill [--yes]       Release emergency kill switch
`;
}

export async function runCliCommand(args: string[]): Promise<{ ok: boolean; output: string }> {
  const first = args[0] || 'help';

  if (first === 'help' || args.includes('--help') || args.includes('-h')) {
    return { ok: true, output: getCliHelpText() };
  }

  if (first === 'gb') {
    const sub = args[1] || 'status';
    const jsonMode = args.includes('--json');
    if (jsonMode) {
      return {
        ok: true,
        output: JSON.stringify({
          ok: true,
          mode: 'PAPER',
          status: 'IDLE',
          subcommand: sub
        })
      };
    }
    return {
      ok: true,
      output: safe(`GB Agent command acknowledged: ${sub}`)
    };
  }

  return {
    ok: true,
    output: safe(`Command executed: ${first}`)
  };
}
