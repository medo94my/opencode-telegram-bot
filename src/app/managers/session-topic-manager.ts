import { Bot, Context } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { getTopicStore } from "../stores/topic-store.js";

const TOPIC_TITLE_MAX_LENGTH = 128;

function sanitizeTopicTitle(title: string): string {
  // Telegram topic titles have a 128-character limit
  const cleaned = title.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (cleaned.length <= TOPIC_TITLE_MAX_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, TOPIC_TITLE_MAX_LENGTH - 3)}...`;
}

export class SessionTopicManager {
  private bot: Bot<Context> | null = null;
  private forumChatId: number | null = null;
  private currentTopicId: number | null = null;

  initialize(bot: Bot<Context>, forumChatId: number | string): void {
    this.bot = bot;
    this.forumChatId = Number(forumChatId);
    logger.info(
      `[SessionTopicManager] Initialized with forumChatId=${this.forumChatId}`,
    );
  }

  /** Get or create a topic for the given session. Returns the topic ID. */
  async resolveTopicForSession(
    sessionId: string,
    directory: string,
    sessionTitle: string,
  ): Promise<number> {
    const store = getTopicStore();

    // 1. Check store by session ID
    let topicId = store.getTopicId(sessionId);
    if (topicId) {
      logger.debug(
        `[SessionTopicManager] Found existing topic ${topicId} for session=${sessionId}`,
      );
      this.currentTopicId = topicId;
      return topicId;
    }

    // 2. Check store by directory (reuse topic if same directory)
    topicId = store.getTopicIdByDirectory(directory);
    if (topicId) {
      // Update the mapping for this new session ID
      store.setTopicId(sessionId, directory, topicId);
      logger.debug(
        `[SessionTopicManager] Reusing topic ${topicId} for session=${sessionId} (same directory)`,
      );
      this.currentTopicId = topicId;
      return topicId;
    }

    // 3. Create a new topic via Telegram API
    if (!this.bot || !this.forumChatId) {
      logger.error(
        "[SessionTopicManager] Cannot create topic: bot or forumChatId not initialized",
      );
      throw new Error("SessionTopicManager not initialized");
    }

    const title = sanitizeTopicTitle(sessionTitle || `Session ${sessionId.slice(0, 8)}`);
    logger.info(
      `[SessionTopicManager] Creating forum topic "${title}" for session=${sessionId}`,
    );

    try {
      const result = await this.bot.api.createForumTopic(
        this.forumChatId,
        title,
      );
      topicId = result.message_thread_id;

      store.setTopicId(sessionId, directory, topicId);
      this.currentTopicId = topicId;
      logger.info(
        `[SessionTopicManager] Created topic ${topicId} ("${title}") for session=${sessionId}`,
      );
      return topicId;
    } catch (error) {
      logger.error(
        `[SessionTopicManager] Failed to create forum topic for session=${sessionId}:`,
        error,
      );
      // If topic creation fails, fall back to no topic (messages go to private chat)
      this.currentTopicId = null;
      throw error;
    }
  }

  /** Create a dedicated forum topic not tied to any session. */
  async createDedicatedTopic(title: string): Promise<number> {
    if (!this.bot || !this.forumChatId) {
      throw new Error("SessionTopicManager not initialized");
    }
    const sanitized = sanitizeTopicTitle(title);
    const result = await this.bot.api.createForumTopic(this.forumChatId, sanitized);
    const topicId = result.message_thread_id;
    logger.info(
      `[SessionTopicManager] Created dedicated topic ${topicId} ("${sanitized}")`,
    );
    return topicId;
  }

  /** Get the currently active topic ID (cached). */
  getCurrentTopicId(): number | null {
    return this.currentTopicId;
  }

  /** Look up a topic ID for a session without creating. */
  lookupTopicId(sessionId: string): number | null {
    return getTopicStore().getTopicId(sessionId);
  }

  /** Clear the cached topic (e.g., when session changes). */
  clearTopic(): void {
    this.currentTopicId = null;
  }

  cleanup(): void {
    this.bot = null;
    this.forumChatId = null;
    this.currentTopicId = null;
  }
}

export const sessionTopicManager = new SessionTopicManager();
