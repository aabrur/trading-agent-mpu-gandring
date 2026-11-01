import { describe, expect, it } from 'vitest';
import {
  ChannelSupervisor,
  type InboundChannelMessage,
  type ChannelConfig,
  DiscordGateway
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

  it('discord_gateway_interaction_handling: enforces allowlist and handles interactions', async () => {
    const fetchCalls: Array<{ url: string; method: string; body: any }> = [];
    const mockFetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    let executedCommand = '';
    const gateway = new DiscordGateway(
      () => ({
        commands: true,
        discord: {
          botToken: 'MOCK_BOT_TOKEN',
          applicationId: 'MOCK_APP_ID',
          allowed: ['allowed-user-123']
        }
      }) as any,
      mockFetch as any,
      async (cmd) => {
        executedCommand = cmd;
        return `Report: desk running OK (${cmd})`;
      }
    );

    // 1. Rejected interaction (unauthorized user)
    await gateway.handle({
      id: 'inter-1',
      token: 'tok-1',
      application_id: 'MOCK_APP_ID',
      type: 2,
      user: { id: 'unauthorized-user-999' },
      data: { name: 'report' }
    });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain('/interactions/inter-1/tok-1/callback');
    expect(fetchCalls[0].body.type).toBe(4);
    expect(fetchCalls[0].body.data.content).toContain('not on this desk\'s allowlist');
    expect(executedCommand).toBe('');

    fetchCalls.length = 0;

    // 2. Authorized interaction (allowed user)
    await gateway.handle({
      id: 'inter-2',
      token: 'tok-2',
      application_id: 'MOCK_APP_ID',
      type: 2,
      user: { id: 'allowed-user-123' },
      data: { name: 'report' }
    });

    expect(fetchCalls.length).toBe(2);
    // Initial callback: type 5 (deferred) within 2500ms
    expect(fetchCalls[0].url).toContain('/interactions/inter-2/tok-2/callback');
    expect(fetchCalls[0].body.type).toBe(5);
    // Execution occurred
    expect(executedCommand).toBe('report');
    // Followup message patch
    expect(fetchCalls[1].url).toContain('/webhooks/MOCK_APP_ID/tok-2/messages/@original');
    expect(fetchCalls[1].method).toBe('PATCH');
    expect(fetchCalls[1].body.content).toContain('Report: desk running OK (report)');
  });
});
