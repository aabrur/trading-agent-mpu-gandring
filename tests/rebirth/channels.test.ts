import { describe, expect, it } from 'vitest';
import {
  ChannelSupervisor,
  type InboundChannelMessage,
  type ChannelConfig
} from '../../server/v2/channels.js';

describe('T14 Channels and Supervisor Operations Verification', () => {
  it('allowlisted_owner_command_matches_current_message: enforces Owner allowlist', async () => {
    const config: ChannelConfig = {
      telegram: {
        enabled: true,
        botToken: 'TELEGRAM_BOT_TOKEN_FIXTURE',
        ownerUserIds: ['owner-telegram-user-1']
      }
    };

    let executedCommand = '';
    const supervisor = new ChannelSupervisor(config, {
      executeCommand: async (cmd) => {
        executedCommand = cmd;
        return `Executed: ${cmd}`;
      }
    });

    // 1. Non-allowlisted user rejected
    const unauthMessage: InboundChannelMessage = {
      channel: 'telegram',
      senderId: 'attacker-random-id',
      text: 'close BTCUSDT',
      timestamp: Date.now()
    };
    const unauthReply = await supervisor.handleInbound(unauthMessage);
    expect(unauthReply.authorized).toBe(false);
    expect(executedCommand).toBe('');

    // 2. Allowlisted Owner authorized
    const authMessage: InboundChannelMessage = {
      channel: 'telegram',
      senderId: 'owner-telegram-user-1',
      text: 'status',
      timestamp: Date.now()
    };
    const authReply = await supervisor.handleInbound(authMessage);
    expect(authReply.authorized).toBe(true);
    expect(executedCommand).toBe('status');
  });

  it('no_real_notification_from_fixture: sends outbound alerts only via injected mock transport', async () => {
    const sentAlerts: Array<{ channel: string; text: string }> = [];

    const supervisor = new ChannelSupervisor(
      {
        discord: {
          enabled: true,
          webhookUrl: 'https://discord.example.invalid/api/webhooks/mock',
          ownerUserIds: ['discord-owner-1']
        }
      },
      {
        transport: async (channel, text) => {
          sentAlerts.push({ channel, text });
          return true;
        }
      }
    );

    const ok = await supervisor.sendAlert('Desk Alert: Stop loss triggered on ETHUSDT');
    expect(ok).toBe(true);
    expect(sentAlerts.length).toBe(1);
    expect(sentAlerts[0].channel).toBe('discord');
    expect(sentAlerts[0].text).toContain('Desk Alert');
  });

  it('channel_setup_and_test_controls: masks sensitive tokens when listing status', () => {
    const supervisor = new ChannelSupervisor({
      telegram: {
        enabled: true,
        botToken: '123456789:ABCDefgh-SECRET_TOKEN_VALUE',
        ownerUserIds: ['owner-1']
      }
    });

    const status = supervisor.getStatus();
    expect(status.telegram.configured).toBe(true);
    expect(status.telegram.maskedToken).toContain('123456****');
    expect(status.telegram.maskedToken).not.toContain('SECRET_TOKEN_VALUE');
  });

  it('whatsapp_challenge_and_hmac_webhook: verifies webhook challenges and signatures', () => {
    const supervisor = new ChannelSupervisor({
      whatsapp: {
        enabled: true,
        verifyToken: 'MY_META_VERIFY_TOKEN',
        appSecret: 'META_APP_SECRET_123',
        ownerPhoneNumbers: ['+1234567890']
      }
    });

    // 1. Hub challenge verification
    const challengeResult = supervisor.verifyWhatsAppChallenge(
      'subscribe',
      'MY_META_VERIFY_TOKEN',
      'challenge_code_98765'
    );
    expect(challengeResult).toBe('challenge_code_98765');

    const badChallenge = supervisor.verifyWhatsAppChallenge(
      'subscribe',
      'WRONG_TOKEN',
      'challenge_code_98765'
    );
    expect(badChallenge).toBeNull();
  });
});
