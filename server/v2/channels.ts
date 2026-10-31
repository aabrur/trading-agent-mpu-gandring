import { safe } from '../redact.js';

export interface TelegramChannelConfig {
  enabled: boolean;
  botToken?: string;
  ownerUserIds?: string[];
}

export interface DiscordChannelConfig {
  enabled: boolean;
  webhookUrl?: string;
  ownerUserIds?: string[];
}

export interface SlackChannelConfig {
  enabled: boolean;
  webhookUrl?: string;
  signingSecret?: string;
  ownerUserIds?: string[];
}

export interface WhatsAppChannelConfig {
  enabled: boolean;
  verifyToken?: string;
  appSecret?: string;
  ownerPhoneNumbers?: string[];
}

export interface ChannelConfig {
  telegram?: TelegramChannelConfig;
  discord?: DiscordChannelConfig;
  slack?: SlackChannelConfig;
  whatsapp?: WhatsAppChannelConfig;
}

export interface InboundChannelMessage {
  channel: 'telegram' | 'discord' | 'slack' | 'whatsapp';
  senderId: string;
  text: string;
  timestamp: number;
}

export interface InboundReply {
  authorized: boolean;
  replyText?: string;
  reason?: string;
}

export interface ChannelSupervisorOptions {
  executeCommand?: (commandText: string) => Promise<string>;
  transport?: (channel: string, text: string) => Promise<boolean>;
}

export class ChannelSupervisor {
  constructor(
    private config: ChannelConfig,
    private options: ChannelSupervisorOptions = {}
  ) {}

  public async handleInbound(message: InboundChannelMessage): Promise<InboundReply> {
    const isOwner = this.isAllowlisted(message.channel, message.senderId);

    if (!isOwner) {
      return {
        authorized: false,
        reason: `Sender ${message.senderId} is not in the Owner allowlist for ${message.channel}.`
      };
    }

    let replyText = `Command received: "${safe(message.text)}"`;
    if (this.options.executeCommand) {
      replyText = await this.options.executeCommand(message.text);
    }

    return {
      authorized: true,
      replyText
    };
  }

  private isAllowlisted(channel: string, senderId: string): boolean {
    if (channel === 'telegram') {
      const allowed = this.config.telegram?.ownerUserIds ?? [];
      return allowed.includes(senderId);
    }
    if (channel === 'discord') {
      const allowed = this.config.discord?.ownerUserIds ?? [];
      return allowed.includes(senderId);
    }
    if (channel === 'slack') {
      const allowed = this.config.slack?.ownerUserIds ?? [];
      return allowed.includes(senderId);
    }
    if (channel === 'whatsapp') {
      const allowed = this.config.whatsapp?.ownerPhoneNumbers ?? [];
      return allowed.includes(senderId);
    }
    return false;
  }

  public async sendAlert(text: string): Promise<boolean> {
    if (this.options.transport) {
      const enabledChannels = Object.keys(this.config) as Array<keyof ChannelConfig>;
      for (const ch of enabledChannels) {
        if (this.config[ch]?.enabled) {
          await this.options.transport(ch, text);
        }
      }
      return true;
    }
    return true;
  }

  public getStatus(): Record<string, { configured: boolean; maskedToken?: string }> {
    const mask = (token?: string) => {
      if (!token || token.length < 6) return '****';
      return `${token.slice(0, 6)}****`;
    };

    return {
      telegram: {
        configured: Boolean(this.config.telegram?.enabled && this.config.telegram.botToken),
        maskedToken: mask(this.config.telegram?.botToken)
      },
      discord: {
        configured: Boolean(this.config.discord?.enabled && this.config.discord.webhookUrl)
      },
      slack: {
        configured: Boolean(this.config.slack?.enabled && this.config.slack.webhookUrl)
      },
      whatsapp: {
        configured: Boolean(this.config.whatsapp?.enabled && this.config.whatsapp.verifyToken)
      }
    };
  }

  public verifyWhatsAppChallenge(mode?: string, token?: string, challenge?: string): string | null {
    if (mode === 'subscribe' && token === this.config.whatsapp?.verifyToken && challenge) {
      return challenge;
    }
    return null;
  }
}
