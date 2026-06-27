import Database from "better-sqlite3";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

export class TopicStore {
  private db: Database.Database;

  constructor() {
    const dbPath = getRuntimePaths().topicDbPath;
    logger.debug(`[TopicStore] Opening database at ${dbPath}`);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic_mappings (
        session_id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        topic_id INTEGER NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_topic_mappings_directory
      ON topic_mappings(directory)
    `);
    logger.info(`[TopicStore] Initialized at ${dbPath}`);
  }

  getTopicId(sessionId: string): number | null {
    const row = this.db
      .prepare("SELECT topic_id FROM topic_mappings WHERE session_id = ?")
      .get(sessionId) as { topic_id: number } | undefined;
    return row?.topic_id ?? null;
  }

  getTopicIdByDirectory(directory: string): number | null {
    const row = this.db
      .prepare("SELECT topic_id FROM topic_mappings WHERE directory = ?")
      .get(directory) as { topic_id: number } | undefined;
    return row?.topic_id ?? null;
  }

  getSessionIdForTopic(topicId: number): string | null {
    const row = this.db
      .prepare("SELECT session_id FROM topic_mappings WHERE topic_id = ?")
      .get(topicId) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  setTopicId(sessionId: string, directory: string, topicId: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO topic_mappings (session_id, directory, topic_id, created_at) VALUES (?, ?, ?, datetime('now'))",
      )
      .run(sessionId, directory, topicId);
    logger.debug(
      `[TopicStore] Mapped session=${sessionId} directory=${directory} -> topicId=${topicId}`,
    );
  }

  removeTopicId(sessionId: string): void {
    this.db.prepare("DELETE FROM topic_mappings WHERE session_id = ?").run(sessionId);
    logger.debug(`[TopicStore] Removed mapping for session=${sessionId}`);
  }

  close(): void {
    this.db.close();
    logger.info("[TopicStore] Database closed");
  }
}

let store: TopicStore | null = null;

export function getTopicStore(): TopicStore {
  if (!store) {
    store = new TopicStore();
  }
  return store;
}
