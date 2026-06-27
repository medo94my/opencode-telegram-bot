import { Bot, Context } from "grammy";
import { config } from "../config.js";
import { getCurrentProject } from "../app/stores/settings-store.js";
import { attachManager } from "../app/managers/attach-manager.js";
import { clearAllInteractionState } from "../app/managers/interaction-manager.js";
import {
  configureAttachPresentation,
  restoreAttachedCurrentSession,
} from "../app/services/attach-service.js";
import { opencodeReadyLifecycle } from "../opencode/ready-lifecycle.js";
import { getCurrentSession } from "../app/services/session-service.js";
import { sessionTopicManager } from "../app/managers/session-topic-manager.js";
import { logger } from "../utils/logger.js";
import { safeBackgroundTask } from "../utils/safe-background-task.js";
import { withTelegramRateLimitRetry } from "../utils/telegram-rate-limit-retry.js";
import { registerCallbackRouter } from "./callbacks/callback-router.js";
import { authMiddleware } from "./middleware/auth.js";
import { interactionGuardMiddleware } from "./middleware/interaction-guard.js";
import {
  ensureCommandsInitialized,
  registerCommandRouter,
} from "./routers/command-router.js";
import { registerMessageRouter } from "./routers/message-router.js";
import {
  createEventSubscriptionService,
  type BotEventSubscriptionService,
} from "./services/event-subscription-service.js";
import { createAttachPresentation } from "./services/attach-presentation.js";
import { createTelegramBotOptions } from "./telegram-client-options.js";

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeReadyRestore: (() => void) | null = null;

const eventSubscriptionService: BotEventSubscriptionService = createEventSubscriptionService();

export function createBot(): Bot<Context> {
  clearAllInteractionState("bot_startup");
  attachManager.clear("bot_startup");
  eventSubscriptionService.clearRuntimeState("bot_startup");

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  const botOptions = createTelegramBotOptions(config.telegram);
  const bot = new Bot(config.telegram.token, botOptions);

  configureAttachPresentation(createAttachPresentation());

  eventSubscriptionService.setTelegramContext(bot, config.telegram.allowedUserId);

  unsubscribeReadyRestore?.();
  unsubscribeReadyRestore = opencodeReadyLifecycle.onReady(async (reason) => {
    const restored = await restoreAttachedCurrentSession({
      bot,
      chatId: config.telegram.allowedUserId,
      ensureEventSubscription: eventSubscriptionService.ensureEventSubscription,
      forceFullRestore: true,
    });

    if (restored) {
      logger.info(`[Bot] Restored followed session after OpenCode ready: reason=${reason}`);

      // Ensure forum topic is resolved (may have been missed during ensureEventSubscription
      // if the session wasn't set as "current" yet)
      if (config.telegram.forumChatId) {
        const session = getCurrentSession();
        if (session && !sessionTopicManager.lookupTopicId(session.id)) {
          sessionTopicManager
            .resolveTopicForSession(session.id, session.directory, session.title || "")
            .catch((err) => {
              logger.error("[Bot] Failed to resolve topic for restored session:", err);
            });
        }
      }

      return;
    }

    const currentProject = getCurrentProject();
    if (config.bot.trackBackgroundSessions && currentProject?.worktree) {
      await eventSubscriptionService.ensureEventSubscription(currentProject.worktree);
      logger.info(
        `[Bot] Started background session tracking after OpenCode ready: reason=${reason}, directory=${currentProject.worktree}`,
      );
    }
  });

  let heartbeatCounter = 0;
  heartbeatTimer = setInterval(() => {
    heartbeatCounter++;
    if (heartbeatCounter % 6 === 0) {
      logger.debug(`[Bot] Heartbeat #${heartbeatCounter} - event loop alive`);
    }
  }, 5000);

  let lastGetUpdatesTime = Date.now();
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === "getUpdates") {
      const now = Date.now();
      const timeSinceLast = now - lastGetUpdatesTime;
      logger.debug(`[Bot API] getUpdates called (${timeSinceLast}ms since last)`);
      lastGetUpdatesTime = now;
      return prev(method, payload, signal);
    }

    if (method === "sendMessage") {
      logger.debug(`[Bot API] sendMessage to chat ${(payload as { chat_id?: number }).chat_id}`);
    }

    // Forum topic routing: redirect messages to the session's forum topic
    if (
      config.telegram.forumChatId &&
      (method === "sendMessage" ||
        method === "sendDocument" ||
        method === "sendPhoto" ||
        method === "sendVoice" ||
        method === "sendAudio" ||
        method === "sendAnimation" ||
        method === "sendVideo" ||
        method === "editMessageText" ||
        method === "editMessageCaption")
    ) {
      const p = payload as Record<string, unknown>;
      const isEditMethod = method === "editMessageText" || method === "editMessageCaption";

      // For edit methods: only override chat_id (message_thread_id is not valid for edit APIs)
      // For explicit message_thread_id: keep it, just redirect chat_id to forum
      // Otherwise: inject current session's topic
      if (isEditMethod || p.message_thread_id) {
        p.chat_id = Number(config.telegram.forumChatId);
        if (isEditMethod) {
          logger.debug(
            `[Bot API] Routed ${method} to forum chat ${p.chat_id} (edit method, skipped message_thread_id)`,
          );
        } else {
          logger.debug(
            `[Bot API] Routed ${method} to forum chat ${p.chat_id} topic ${p.message_thread_id} (explicit)`,
          );
        }
      } else {
        const session = getCurrentSession();
        if (session) {
          const topicId = sessionTopicManager.lookupTopicId(session.id);
          if (topicId) {
            p.chat_id = Number(config.telegram.forumChatId);
            p.message_thread_id = topicId;
            logger.debug(
              `[Bot API] Routed ${method} to forum chat ${p.chat_id} topic ${topicId}`,
            );
          }
        }
      }
    }

    return withTelegramRateLimitRetry(() => prev(method, payload, signal), {
      maxRetries: 5,
      onRetry: ({ attempt, retryAfterMs, error }) => {
        logger.warn(
          `[Bot API] Telegram rate limit on ${method}, retrying in ${retryAfterMs}ms (attempt=${attempt})`,
          error,
        );
      },
    });
  });

  bot.use((ctx, next) => {
    const hasCallbackQuery = !!ctx.callbackQuery;
    const hasMessage = !!ctx.message;
    const callbackData = ctx.callbackQuery?.data || "N/A";
    logger.debug(
      `[DEBUG] Incoming update: hasCallbackQuery=${hasCallbackQuery}, hasMessage=${hasMessage}, callbackData=${callbackData}`,
    );
    return next();
  });

  bot.use(authMiddleware);
  bot.use(ensureCommandsInitialized);
  bot.use(interactionGuardMiddleware);

  registerCommandRouter(bot, {
    ensureEventSubscription: eventSubscriptionService.ensureEventSubscription,
  });
  registerCallbackRouter(bot, {
    ensureEventSubscription: eventSubscriptionService.ensureEventSubscription,
    setTelegramContext: eventSubscriptionService.setTelegramContext,
  });
  registerMessageRouter(bot, {
    ensureEventSubscription: eventSubscriptionService.ensureEventSubscription,
    setTelegramContext: eventSubscriptionService.setTelegramContext,
  });

  safeBackgroundTask({
    taskName: "bot.clearGlobalCommands",
    task: async () => {
      try {
        await Promise.all([
          bot.api.setMyCommands([], { scope: { type: "default" } }),
          bot.api.setMyCommands([], { scope: { type: "all_private_chats" } }),
        ]);
        return { success: true as const };
      } catch (error) {
        return { success: false as const, error };
      }
    },
    onSuccess: (result) => {
      if (result.success) {
        logger.debug("[Bot] Cleared global commands (default and all_private_chats scopes)");
        return;
      }

      logger.warn("[Bot] Could not clear global commands:", result.error);
    },
  });

  bot.catch((err) => {
    logger.error("[Bot] Unhandled error in bot:", err);
    clearAllInteractionState("bot_unhandled_error");
    if (err.ctx) {
      logger.error(
        "[Bot] Error context - update type:",
        err.ctx.update ? Object.keys(err.ctx.update) : "unknown",
      );
    }
  });

  return bot;
}

export function cleanupBotRuntime(reason: string): void {
  unsubscribeReadyRestore?.();
  unsubscribeReadyRestore = null;
  eventSubscriptionService.cleanup(reason);

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
