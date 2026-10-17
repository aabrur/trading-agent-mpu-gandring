import { describe, it, expect } from 'vitest';
import { tradeEnv, officeUrl } from '../cli/trade.js';
import { servicePlan } from '../cli/autostart.js';

describe('npm run trade', () => {
  it('forces full auto in local mode, leaves Grok Bot mode alone', () => {
    expect(tradeEnv({ AUTO_TRADING: 'off' }, { APP_MODE: 'local' }).AUTO_TRADING).toBe('on');
    expect(tradeEnv({}, {}).AUTO_TRADING).toBe('on');
    expect(tradeEnv({ AUTO_TRADING: 'off' }, { APP_MODE: 'grokbot' }).AUTO_TRADING).toBe('off');
  });
  it('prints a reachable office URL', () => {
    expect(officeUrl('0.0.0.0', '8787')).toBe('http://127.0.0.1:8787');
    expect(officeUrl('127.0.0.1', '9000')).toBe('http://127.0.0.1:9000');
  });
});

describe('autostart service files', () => {
  const o = { node: '/usr/local/bin/node', repo: '/Users/me/trading-agent-mpu-gandring', home: '/Users/me', uid: 501 };
  const secretish = /API_KEY|SECRET|PRIVATE_KEY|PASSPHRASE|TOKEN|EnvironmentVariables|Environment=/;
  it('macOS launchd: run at login, restart on crash, no keys', () => {
    const p = servicePlan('darwin', o);
    expect(p.file).toBe('/Users/me/Library/LaunchAgents/com.mpugandring.trading-agent.plist');
    expect(p.content).toContain('<key>RunAtLoad</key><true/>');
    expect(p.content).toContain('<key>SuccessfulExit</key><false/>');
    expect(p.content).toContain('--service');
    expect(p.content).not.toMatch(secretish);
  });
  it('Windows: schtasks at logon, no keys', () => {
    const p = servicePlan('win32', { ...o, node: 'C:\\Program Files\\nodejs\\node.exe', repo: 'C:\\Users\\me\\tamg', home: 'C:\\Users\\me' });
    expect(p.install[0]).toEqual(expect.arrayContaining(['schtasks', '/Create', '/SC', 'ONLOGON']));
    expect(p.content).toContain('cli\\trade.ts');
    expect(p.content).not.toMatch(secretish);
  });
  it('Linux systemd --user: restart on failure, but not after a guard refusal (exit 2), no keys', () => {
    const p = servicePlan('linux', { ...o, repo: '/home/me/tamg', home: '/home/me' });
    expect(p.file).toBe('/home/me/.config/systemd/user/trading-agent-mpu-gandring.service');
    expect(p.content).toContain('Restart=on-failure');
    expect(p.content).toContain('RestartPreventExitStatus=2');
    expect(p.content).not.toMatch(secretish);
  });
});
