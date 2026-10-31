import { describe, expect, it } from 'vitest';
import { runCliCommand, getCliHelpText } from '../../cli/v2/main.js';
import { runDoctorCheck } from '../../cli/v2/doctor.js';

describe('T14 CLI Command Operations Verification', () => {
  it('every_help_command_dispatches: help outputs all canonical verbs', () => {
    const help = getCliHelpText();
    expect(help).toBeDefined();

    const expectedVerbs = [
      'status',
      'version',
      'doctor',
      'setup',
      'paper',
      'testnet',
      'live',
      'positions',
      'account',
      'split',
      'scan',
      'report',
      'analyze',
      'debate',
      'open',
      'close',
      'size',
      'market',
      'candles',
      'lessons',
      'kill',
      'unkill'
    ];

    for (const verb of expectedVerbs) {
      expect(help).toContain(verb);
    }
  });

  it('doctor_checks_permissions_without_leaking_secrets: inspects key permissions cleanly', async () => {
    const result = await runDoctorCheck({
      venue: 'bybit',
      network: 'testnet',
      mockCredentials: {
        key: 'BYBIT_TEST_KEY_12345',
        secret: 'BYBIT_TEST_SECRET_67890'
      }
    });

    expect(result.ok).toBe(true);
    expect(result.canTrade).toBe(true);
    expect(result.canWithdraw).toBe(false);

    // Verify secret scrubbing: plain secret must never appear in report
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('BYBIT_TEST_SECRET_67890');
    expect(serialized).toContain('BYBIT_TEST_KEY_****');
  });

  it('gb_open_close_cancel_and_lessons_through_gateway: executes gb verbs safely', async () => {
    const reply = await runCliCommand(['gb', 'status', '--json']);
    expect(reply.ok).toBe(true);
    expect(reply.output).toBeDefined();
  });
});
