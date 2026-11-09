import { describe, expect, it } from 'vitest';
import express from 'express';
import { createReplacementRuntime } from '../../server/v2/runtime.js';
import { DISCORD_COMMANDS, syncDiscordCommandsV2, syncTelegramCommandsV2, syncSlackCommandsV2, syncWhatsAppCommandsV2, TELEGRAM_BOT_COMMANDS } from '../../server/v2/channels.js';
import { mountSetupApiRoutes } from '../../server/v2/api/setup.js';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { CycleRunner } from '../../server/v2/decision/cycle.js';

describe('Channel Commands and Synchronization Suite', () => {
  it('parses and routes all desk commands with and without leading slash', async () => {
    const runtime = createReplacementRuntime();
    try {
      const commands = [
        'status', '/status',
        'balance', '/balance',
        'mode', '/mode',
        'health', '/health',
        'positions', '/positions',
        'report', '/report',
        'scan', '/scan',
        'watchlist', '/watchlist',
        'scorecard', '/scorecard',
        'lessons', '/lessons',
        'help', '/help',
        'sync', '/sync',
        'pause', '/pause',
        'resume', '/resume',
        'set profile aggressive', '/set profile aggressive',
        'set size 25%', '/set size 25%',
        'set leverage 10', '/set leverage 10',
        'set safety 200', '/set safety 200',
        'safety 150', '/safety 150',
        'set n 3', '/set n 3',
        'n 2', '/n 2',
        'set cycle 15', '/set cycle 15',
        'cycle', '/cycle',
        'run cycle', '/run cycle',
        'cycle now', '/cycle now',
        'set report 60', '/set report 60',
        'kill', '/kill',
        'unkill', '/unkill'
      ];

      for (const cmd of commands) {
        const res = await runtime.handleCommand({ text: cmd });
        const isCycleRunning = /cycle/i.test(cmd) && res.error?.includes('already running');
        expect(res.ok || isCycleRunning, `Expected command "${cmd}" to succeed, got error: ${res.error}`).toBe(true);
      }
    } finally {
      await runtime.stop();
    }
  });

  it('handles ask commands with agent resolution, aliases and Indonesian tanya', async () => {
    const roleRunner = new RoleRunner({
      providerCaller: async ({ role, user }) => {
        const question = user ? user.split('\n\n').pop() : '';
        return JSON.stringify({
          reply: `Acknowledged from ${role}: ${question}`,
          confidence: 0.9,
          claimRefs: [],
          contraryRefs: []
        });
      },
      resolveAssignment: () => ({
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'test-key'
      })
    });
    const cycleRunner = new CycleRunner({ roleRunner });
    const runtime = createReplacementRuntime({ roleRunner, cycleRunner });

    try {
      // 1. Without agent -> defaults to Desk Lead
      const askNoAgent = await runtime.handleCommand({
        text: 'ask apakah semua aman terkendali?'
      });
      expect(askNoAgent.ok).toBe(true);
      expect(askNoAgent.command).toBe('ask');
      expect(askNoAgent.reply).toContain('[LEAD]: Acknowledged from lead: apakah semua aman terkendali?');

      // 2. With slash /ask
      const askSlash = await runtime.handleCommand({
        text: '/ask apakah semua aman terkendali?'
      });
      expect(askSlash.ok).toBe(true);
      expect(askSlash.reply).toContain('[LEAD]: Acknowledged from lead: apakah semua aman terkendali?');

      // 3. Multi-word agent alias "desk lead"
      const askDeskLead = await runtime.handleCommand({
        text: 'ask desk lead bagaimana situasi?'
      });
      expect(askDeskLead.ok).toBe(true);
      expect(askDeskLead.reply).toContain('[LEAD]: Acknowledged from lead: bagaimana situasi?');

      // 4. Specific role "risk"
      const askRisk = await runtime.handleCommand({
        text: '/ask risk apa batas stop loss?'
      });
      expect(askRisk.ok).toBe(true);
      expect(askRisk.reply).toContain('[RISK]: Acknowledged from risk: apa batas stop loss?');

      // 5. Indonesian alias "tanya"
      const tanyaLead = await runtime.handleCommand({
        text: '/tanya pasar lagi tren apa?'
      });
      expect(tanyaLead.ok).toBe(true);
      expect(tanyaLead.reply).toContain('[LEAD]: Acknowledged from lead: pasar lagi tren apa?');

      // 6. Broadcast to @all
      const askAll = await runtime.handleCommand({
        text: '/ask @all berikan analisis cepat'
      });
      expect(askAll.ok).toBe(true);
      expect(askAll.reply).toContain('lead: Acknowledged from lead');
      expect(askAll.reply).toContain('risk: Acknowledged from risk');

      // 7. Empty prompt returns usage
      const askEmpty = await runtime.handleCommand({
        text: '/ask'
      });
      expect(askEmpty.ok).toBe(false);
      expect(askEmpty.error).toContain('Usage: /ask');
    } finally {
      await runtime.stop();
    }
  });

  it('synchronizes commands across Discord, Telegram, Slack, and WhatsApp', async () => {
    // 1. Discord commands structure includes agent choices
    const askOption = DISCORD_COMMANDS.find((c) => c.name === 'ask');
    expect(askOption).toBeDefined();
    const agentOpt = askOption?.options?.find((o: any) => o.name === 'agent') as any;
    expect(agentOpt).toBeDefined();
    expect(agentOpt.choices).toBeDefined();
    expect(agentOpt.choices.some((ch: any) => ch.value === 'lead')).toBe(true);

    // 2. Telegram bot commands contains all core commands
    expect(TELEGRAM_BOT_COMMANDS.some((c) => c.command === 'status')).toBe(true);
    expect(TELEGRAM_BOT_COMMANDS.some((c) => c.command === 'ask')).toBe(true);
    expect(TELEGRAM_BOT_COMMANDS.some((c) => c.command === 'positions')).toBe(true);
    expect(TELEGRAM_BOT_COMMANDS.some((c) => c.command === 'kill')).toBe(true);

    // 3. Mock fetch for sync verification
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('discord.com')) {
        return new Response(JSON.stringify([{ id: '12345', name: 'status' }]), { status: 200 });
      }
      if (urlStr.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      if (urlStr.includes('hooks.slack.com')) {
        return new Response('ok', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    // Test Discord sync
    const discordRes = await syncDiscordCommandsV2('bot-token', 'app-id', undefined, mockFetch as any);
    expect(Array.isArray(discordRes)).toBe(true);

    // Test Telegram sync
    const tgRes = await syncTelegramCommandsV2('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', mockFetch as any);
    expect(tgRes.ok).toBe(true);
    expect(tgRes.count).toBe(TELEGRAM_BOT_COMMANDS.length);

    // Test Slack sync
    const slackRes = await syncSlackCommandsV2('https://hooks.slack.com/services/T00/B00/X00', mockFetch as any);
    expect(slackRes.ok).toBe(true);

    // Test WhatsApp sync
    const waRes = await syncWhatsAppCommandsV2('valid-token', '1234567890');
    expect(waRes.ok).toBe(true);
  });

  it('mounts all sync endpoints in Setup API and triggers auto-sync on channel save', async () => {
    const app = express();
    app.use(express.json());

    const syncedChannels: string[] = [];
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('discord.com')) {
        syncedChannels.push('discord');
        return new Response(JSON.stringify([{ id: '12345', name: 'status' }]), { status: 200 });
      }
      if (urlStr.includes('api.telegram.org')) {
        syncedChannels.push('telegram');
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      if (urlStr.includes('hooks.slack.com')) {
        syncedChannels.push('slack');
        return new Response('ok', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const mockSettings = {
      apply: async () => {},
      current: () => ({ activeVersion: 1 })
    } as any;
    const mockSecrets = { writeSecrets: () => {} } as any;
    const mockAccounts = {} as any;

    mountSetupApiRoutes(app, {
      settings: mockSettings,
      secrets: mockSecrets,
      accounts: mockAccounts,
      fetchImpl: mockFetch as any
    });

    // Verify all sync routes are callable
    const endpoints = [
      '/api/setup/channels/discord-sync',
      '/api/setup/channels/telegram-sync',
      '/api/setup/channels/slack-sync',
      '/api/setup/channels/whatsapp-sync'
    ];

    process.env.DISCORD_BOT_TOKEN = 'mock-discord-token';
    process.env.DISCORD_APPLICATION_ID = '1234567890';
    process.env.TELEGRAM_BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T00/B00/X00';
    process.env.WHATSAPP_ACCESS_TOKEN = 'mock-wa-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';

    for (const ep of endpoints) {
      const server = app.listen(0);
      const port = (server.address() as any).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}${ep}`, { method: 'POST' });
        expect(res.status).toBe(200);
      } finally {
        server.close();
      }
    }

    // Verify saveChannel triggers auto-sync
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const saveRes = await fetch(`http://127.0.0.1:${port}/api/setup/channels/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'telegram',
          values: {
            TELEGRAM_BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
            TELEGRAM_CHAT_ID: '123456789',
            TELEGRAM_ALLOWED_USER_IDS: '123456789'
          },
          commands: true
        })
      });
      expect(saveRes.status).toBe(200);
      // Wait a tick for deferred auto-sync
      await new Promise((r) => setTimeout(r, 50));
      expect(syncedChannels).toContain('telegram');
    } finally {
      server.close();
    }
  });
});
