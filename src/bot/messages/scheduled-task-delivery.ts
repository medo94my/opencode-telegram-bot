import type { Api, RawApi } from "grammy";
import { config } from "../../config.js";
import type {
  QueuedScheduledTaskDelivery,
} from "../../app/types/scheduled-task.js";
import type { ScheduledTaskDeliverySender } from "../../app/services/scheduled-task-runtime-service.js";
import { getTopicStore } from "../../app/stores/topic-store.js";
import {
  escapePlainTextForTelegramMarkdownV2,
  formatSummaryWithMode,
} from "./summary-message-formatter.js";
import { sendBotText } from "./telegram-text.js";

type SendMessageApi = Pick<Api<RawApi>, "sendMessage">;

const TELEGRAM_MESSAGE_LIMIT = 4096;

function getScheduledTaskDeliveryFormat(): "raw" | "markdown_v2" {
  return config.bot.messageFormatMode === "markdown" ? "markdown_v2" : "raw";
}

function getSilentDeliveryOptions(): { options: { disable_notification: true } } | Record<string, never> {
  return config.bot.scheduledTaskNotificationsSilent
    ? { options: { disable_notification: true } }
    : {};
}

function buildScheduledTaskSuccessMessageParts(delivery: QueuedScheduledTaskDelivery): string[] {
  if (!delivery.resultText) {
    return [delivery.notificationText];
  }

  if (config.bot.messageFormatMode !== "markdown") {
    return formatSummaryWithMode(
      `${delivery.notificationText}\n\n${delivery.resultText}`,
      config.bot.messageFormatMode,
    );
  }

  const header = escapePlainTextForTelegramMarkdownV2(delivery.notificationText);
  const resultParts = formatSummaryWithMode(delivery.resultText, config.bot.messageFormatMode);
  if (resultParts.length === 0) {
    return [header];
  }

  const firstPart = `${header}\n\n${resultParts[0]}`;
  if (firstPart.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [firstPart, ...resultParts.slice(1)];
  }

  return [header, ...resultParts];
}

export function createScheduledTaskDeliverySender(
  api: SendMessageApi,
  chatId: number,
): ScheduledTaskDeliverySender {
  return {
    async send(delivery) {
      // Route to session's forum topic if the task has a session association
      const forumChatId = config.telegram.forumChatId ? Number(config.telegram.forumChatId) : null;
      const deliveryChatId = delivery.sessionId && forumChatId ? forumChatId : chatId;
      const threadId =
        delivery.sessionId && forumChatId
          ? getTopicStore().getTopicId(delivery.sessionId)
          : null;

      const messageParts =
        delivery.status === "success"
          ? buildScheduledTaskSuccessMessageParts(delivery)
          : [delivery.notificationText];
      const format = delivery.status === "success" ? getScheduledTaskDeliveryFormat() : "raw";
      const suppressResultNotification = delivery.status === "success" && Boolean(delivery.footerText);
      const resultDeliveryOptions =
        suppressResultNotification && !config.bot.scheduledTaskNotificationsSilent
          ? { options: { disable_notification: true } }
          : getSilentDeliveryOptions();

      for (const part of messageParts) {
        const mergedOptions =
          threadId && "options" in resultDeliveryOptions
            ? {
                options: {
                  ...(
                    resultDeliveryOptions as {
                      options: Record<string, unknown>;
                    }
                  ).options,
                  message_thread_id: threadId,
                },
              }
            : threadId
              ? { options: { message_thread_id: threadId } }
              : resultDeliveryOptions;

        await sendBotText({
          api,
          chatId: deliveryChatId,
          text: part,
          format,
          ...mergedOptions,
        });
      }

      if (delivery.status === "success" && delivery.footerText) {
        const silentOptions = getSilentDeliveryOptions();
        const footerOptions =
          threadId && "options" in silentOptions
            ? {
                options: {
                  ...(silentOptions as { options: Record<string, unknown> }).options,
                  message_thread_id: threadId,
                },
              }
            : threadId
              ? { options: { message_thread_id: threadId } }
              : silentOptions;

        await sendBotText({
          api,
          chatId: deliveryChatId,
          text: delivery.footerText,
          format: "raw",
          ...footerOptions,
        });
      }

      return true;
    },
  };
}
