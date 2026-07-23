import { AsyncLocalStorage } from "node:async_hooks";
import {
  createDiscordAdapter,
  type DiscordAdapter,
} from "@chat-adapter/discord";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import {
  type Adapter,
  Chat,
  ConsoleLogger,
  emoji,
  type Message,
  type Thread,
  ThreadImpl,
  type WebhookOptions,
} from "chat";
import type { BotThreadContext } from "@/lib/bots/context";
import { resolveKestrelAppUrl } from "@/lib/app-url";
import {
  createDiscordThreadFromMessage,
  getDiscordConfig,
} from "@/lib/bots/discord-api";
import {
  getDiscordGuildBindingForGuild,
  touchDiscordGuildBinding,
} from "@/lib/bots/discord-store";
import {
  generateExternalReply,
  getOrCreateExternalThreadChat,
  hasProcessedExternalMessage,
  saveExternalConversationTurn,
} from "@/lib/bots/shared";
import { knowledgeDb } from "@/lib/knowledge/db";

type BotOrigin = "discord";

type BotThreadState = {
  threadId: string;
  externalThreadId: string;
  organizationId: string;
  origin: BotOrigin;
};

type DiscordThreadResolution = {
  threadId: string;
  context?: BotThreadContext;
  externalThreadId: string;
  inboundExternalMessageId: string;
  organizationId: string;
  origin: "discord";
  targetThread: Thread<BotThreadState>;
};

type ResolvedConversation = DiscordThreadResolution;

type DiscordGatewayStatus = {
  active: boolean;
  activeUntil: string | null;
  botUserId: string | null;
  sessionId: string | null;
  startedAt: string | null;
};

const DISCORD_GATEWAY_LIFETIME_MS = 10 * 60 * 1000;
const LEGACY_DISCORD_THREAD_PREFIX = "discord:thread:";
const LEGACY_DISCORD_MESSAGE_PREFIX = "discord:message:";

function sanitizeDiscordThreadName(input: string) {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Knowledge discussion";
  }
  return normalized.slice(0, 90);
}

function formatDiscordExternalMessageId(messageId: string) {
  return `${LEGACY_DISCORD_MESSAGE_PREFIX}${messageId}`;
}

function getThreadState(thread: Thread<BotThreadState>) {
  return thread.state;
}

class UnifiedBotRuntime {
  private readonly requestOrigin = new AsyncLocalStorage<string>();
  private bot: Chat<Record<string, Adapter>, BotThreadState> | null = null;
  private discordAdapter: DiscordAdapter | null = null;
  private readonly stateBackend: "memory" | "redis" = process.env.REDIS_URL
    ? "redis"
    : "memory";
  private discordGatewayAbortController: AbortController | null = null;
  private discordGatewayStartedAtMs: number | null = null;
  private discordGatewayActiveUntilMs: number | null = null;

  getStateBackend() {
    return this.stateBackend;
  }

  hasDiscordAdapter() {
    return Boolean(this.discordAdapter);
  }

  getDiscordGatewayStatus(): DiscordGatewayStatus {
    const active =
      Boolean(this.discordGatewayAbortController) &&
      !this.discordGatewayAbortController?.signal.aborted &&
      Boolean(this.discordGatewayActiveUntilMs) &&
      Date.now() < (this.discordGatewayActiveUntilMs ?? 0);

    return {
      active,
      startedAt: this.discordGatewayStartedAtMs
        ? new Date(this.discordGatewayStartedAtMs).toISOString()
        : null,
      activeUntil: this.discordGatewayActiveUntilMs
        ? new Date(this.discordGatewayActiveUntilMs).toISOString()
        : null,
      sessionId: null,
      botUserId: this.discordAdapter?.botUserId ?? null,
    };
  }

  async handleWebhook(
    platform: "discord",
    request: Request,
    options?: WebhookOptions,
    origin?: string
  ) {
    const bot = await this.getBot();
    const handler = bot.webhooks[platform];
    if (!handler) {
      throw new Error(`${platform} adapter not configured`);
    }

    if (!origin) {
      return handler(request, options);
    }

    return this.requestOrigin.run(origin, () => handler(request, options));
  }

  async startDiscordGatewayListener(input: {
    organizationId: string;
    origin: string;
    waitUntil: NonNullable<WebhookOptions["waitUntil"]>;
  }) {
    const bot = await this.getBot();
    await bot.initialize();

    if (!this.discordAdapter) {
      throw new Error("Discord credentials are not configured");
    }

    const currentStatus = this.getDiscordGatewayStatus();
    if (currentStatus.active) {
      return {
        status: "already_active" as const,
        ...currentStatus,
        webhookUrl: `${input.origin}/api/webhooks/discord`,
      };
    }

    this.discordGatewayAbortController?.abort();
    this.discordGatewayAbortController = new AbortController();
    this.discordGatewayStartedAtMs = Date.now();
    this.discordGatewayActiveUntilMs =
      this.discordGatewayStartedAtMs + DISCORD_GATEWAY_LIFETIME_MS;

    let response: Response;
    try {
      response = await this.discordAdapter.startGatewayListener(
        { waitUntil: input.waitUntil },
        DISCORD_GATEWAY_LIFETIME_MS,
        this.discordGatewayAbortController.signal,
        `${input.origin}/api/webhooks/discord`
      );
    } catch (error) {
      this.discordGatewayAbortController = null;
      this.discordGatewayStartedAtMs = null;
      this.discordGatewayActiveUntilMs = null;
      throw error;
    }

    if (!response.ok) {
      this.discordGatewayAbortController = null;
      this.discordGatewayStartedAtMs = null;
      this.discordGatewayActiveUntilMs = null;
      throw new Error(await response.text());
    }

    await touchDiscordGuildBinding({
      organizationId: input.organizationId,
      lastGatewayStartedAt: new Date(),
    }).catch(() => null);

    return {
      status: "started" as const,
      ...this.getDiscordGatewayStatus(),
      webhookUrl: `${input.origin}/api/webhooks/discord`,
    };
  }

  private async getBot() {
    if (!this.bot) {
      this.bot = this.createBot();
    }

    return this.bot;
  }

  private createBot() {
    const adapters: Record<string, Adapter> = {};
    const userName = process.env.DISCORD_BOT_USERNAME?.trim() || "Kestrel";

    const discordConfig = getDiscordConfig();
    if (discordConfig.configured) {
      this.discordAdapter = createDiscordAdapter({
        applicationId: discordConfig.applicationId!,
        botToken: discordConfig.botToken!,
        publicKey: discordConfig.publicKey!,
        mentionRoleIds: discordConfig.mentionRoleIds,
        logger: new ConsoleLogger("info").child("discord"),
        userName,
      });
      adapters.discord = this.discordAdapter;
    }

    const state = process.env.REDIS_URL
      ? createRedisState({
          url: process.env.REDIS_URL,
          logger: new ConsoleLogger("info").child("redis-state"),
        })
      : createMemoryState();

    const bot = new Chat<Record<string, Adapter>, BotThreadState>({
      adapters,
      state,
      userName,
      logger: "info",
    });

    bot.onNewMention(async (thread, message) => {
      await this.handleBotMessage(thread, message, true);
    });

    bot.onSubscribedMessage(async (thread, message) => {
      if (message.author.isBot === true) {
        return;
      }

      await this.handleBotMessage(thread, message, false);
    });

    return bot;
  }

  private async handleBotMessage(
    thread: Thread<BotThreadState>,
    message: Message,
    subscribeToThread: boolean
  ) {
    const resolved = await this.resolveConversation(thread, message);
    if (!resolved) {
      return;
    }

    const { targetThread } = resolved;
    const inboundAlreadyProcessed = await hasProcessedExternalMessage(
      resolved.threadId,
      resolved.inboundExternalMessageId
    );
    if (inboundAlreadyProcessed) {
      return;
    }

    await targetThread.setState({
      threadId: resolved.threadId,
      externalThreadId: resolved.externalThreadId,
      organizationId: resolved.organizationId,
      origin: resolved.origin,
    });

    await targetThread.startTyping().catch(() => null);
    await targetThread.adapter
      .addReaction(targetThread.id, message.id, emoji.eyes)
      .catch(() => null);

    try {
      const generated = await generateExternalReply({
        organizationId: resolved.organizationId,
        apiUrl:
          this.requestOrigin.getStore() ??
          resolveKestrelAppUrl(process.env),
        threadId: resolved.threadId,
        prompt: message.text,
        context: resolved.context,
        actor: {
          actorId: `kestrel-one:${resolved.origin}:bot`,
          actorType: "service",
          displayName: "Kestrel One Bot",
          tenantId: resolved.organizationId,
        },
      });

      const reply = await targetThread.post(generated.text);

      await saveExternalConversationTurn({
        threadId: resolved.threadId,
        origin: resolved.origin,
        inboundText: message.text,
        inboundExternalMessageId: resolved.inboundExternalMessageId,
        replyText: generated.text,
        replyExternalMessageId: formatDiscordExternalMessageId(reply.id),
        inputTokens: generated.usage?.inputTokens,
        outputTokens: generated.usage?.outputTokens,
      });

      await targetThread.adapter
        .removeReaction(targetThread.id, message.id, emoji.eyes)
        .catch(() => null);
      await targetThread.adapter
        .addReaction(targetThread.id, message.id, emoji.thumbs_up)
        .catch(() => null);

      if (subscribeToThread) {
        await targetThread.subscribe().catch(() => null);
      }
    } catch (error) {
      await targetThread.adapter
        .removeReaction(targetThread.id, message.id, emoji.eyes)
        .catch(() => null);
      await targetThread.post(
        `Sorry, I encountered an error while processing your request.\n\n\`\`\`\n${error instanceof Error ? error.message : "Unknown error"}\n\`\`\``
      );
    }
  }

  private async resolveConversation(
    thread: Thread<BotThreadState>,
    message: Message
  ): Promise<ResolvedConversation | null> {
    if (thread.adapter.name === "discord") {
      return this.resolveDiscordConversation(thread, message);
    }

    return null;
  }

  private async resolveDiscordConversation(
    thread: Thread<BotThreadState>,
    message: Message
  ): Promise<DiscordThreadResolution | null> {
    if (!this.discordAdapter) {
      return null;
    }

    const decoded = this.discordAdapter.decodeThreadId(thread.id);
    if (!decoded.guildId || decoded.guildId === "@me") {
      return null;
    }

    const binding = await getDiscordGuildBindingForGuild(decoded.guildId);
    if (!(binding && binding.enabled)) {
      return null;
    }

    await touchDiscordGuildBinding({
      organizationId: binding.organizationId,
      lastEventAt: new Date(),
    }).catch(() => null);

    const currentThreadState = await getThreadState(thread);
    if (currentThreadState?.threadId && currentThreadState.organizationId) {
      return {
        threadId: currentThreadState.threadId,
        context: undefined,
        externalThreadId: currentThreadState.externalThreadId,
        inboundExternalMessageId: formatDiscordExternalMessageId(message.id),
        organizationId: currentThreadState.organizationId,
        origin: "discord",
        targetThread: thread,
      };
    }

    let targetThread = thread;
    let externalThreadId = thread.id;

    if (!decoded.threadId) {
      if (!message.isMention) {
        return null;
      }

      const rawMessage = message.raw as {
        channel_id?: string;
        content?: string;
        guild_id?: string;
        id?: string;
      };

      if (!(rawMessage.channel_id && rawMessage.id)) {
        return null;
      }

      const createdThread = await createDiscordThreadFromMessage({
        channelId: rawMessage.channel_id,
        messageId: rawMessage.id,
        name: sanitizeDiscordThreadName(rawMessage.content || message.text),
      });

      const targetThreadId = this.discordAdapter.encodeThreadId({
        guildId: decoded.guildId,
        channelId: decoded.channelId,
        threadId: createdThread.id,
      });

      targetThread = new ThreadImpl<BotThreadState>({
        adapter: thread.adapter,
        channelId: decoded.channelId,
        id: targetThreadId,
        isDM: false,
        logger: this.bot?.getLogger("discord-thread"),
        stateAdapter: this.bot!.getState(),
      });
      externalThreadId = targetThreadId;
    }

    const threadInfo = await targetThread.adapter
      .fetchThread(targetThread.id)
      .catch(() => null);
    const chat = await getOrCreateExternalThreadChat({
      organizationId: binding.organizationId,
      origin: "discord",
      externalThreadId,
      legacyExternalThreadIds: decoded.threadId
        ? [`${LEGACY_DISCORD_THREAD_PREFIX}${decoded.threadId}`]
        : [],
      title:
        threadInfo?.channelName ||
        `${binding.guildName || binding.guildId} · Discord thread`,
    });

    return {
      threadId: chat.id,
      context: undefined,
      externalThreadId,
      inboundExternalMessageId: formatDiscordExternalMessageId(message.id),
      organizationId: binding.organizationId,
      origin: "discord",
      targetThread,
    };
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __unifiedBotRuntime: UnifiedBotRuntime | undefined;
}

export function getUnifiedBotRuntime() {
  if (!globalThis.__unifiedBotRuntime) {
    globalThis.__unifiedBotRuntime = new UnifiedBotRuntime();
  }

  return globalThis.__unifiedBotRuntime;
}
