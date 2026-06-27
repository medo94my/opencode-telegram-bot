---
phase: code-review
reviewed: 2026-06-27T14:00:00Z
depth: deep
files_reviewed: 15
files_reviewed_list:
  - src/app/managers/plan-manager.ts
  - src/bot/callbacks/plan-callback-handler.ts
  - src/bot/services/event-subscription-service.ts
  - src/bot/index.ts
  - src/app/services/scheduled-task-runtime-service.ts
  - src/app/managers/session-topic-manager.ts
  - src/app/stores/topic-store.ts
  - src/app/types/scheduled-task.ts
  - src/bot/callbacks/callback-router.ts
  - src/bot/streaming/finalize-assistant-response.ts
  - src/bot/commands/task-command.ts
  - src/bot/messages/scheduled-task-delivery.ts
  - src/app/bootstrap/start-bot-app.ts
  - src/bot/messages/telegram-text.ts
  - src/config.ts
  - src/app/bootstrap/start-bot-app.ts
  - src/bot/messages/telegram-text.ts
  - src/config.ts
findings:
  critical: 3
  warning: 3
  info: 3
  total: 9
status: issues_found
---

# Code Review Report

**Reviewed:** 2026-06-27T14:00:00Z
**Depth:** deep (cross-file call-chain analysis)
**Files Reviewed:** 15 source files across 3 feature areas
**Status:** issues_found

## Summary

Reviewed three new features added to the forked opencode-telegram-bot: (1) Scheduled Task Session Routing, (2) Plan Approval Flow, (3) Command Routing to Forum Topic. All three features have issues, with the most critical being that Feature 1 (scheduled task session routing) is completely non-functional in production, and Feature 2 (plan monitoring) creates a topic that is identical to the existing conversation topic due to a logic error. Additionally, a pre-existing bug in the API transformer causes `editMessageText`/`editMessageCaption` calls to inject the invalid `message_thread_id` field.

---

## Critical Issues

### CR-01: Scheduled task session routing dead code — deliverySender path bypasses all topic routing (Feature 1)

**File:** `src/app/services/scheduled-task-runtime-service.ts:460-501`
**File:** `src/app/bootstrap/start-bot-app.ts:67-70`

**Issue:** The session-specific forum topic routing for scheduled task deliveries (lines 470-492 of `scheduled-task-runtime-service.ts`) is **dead code** in normal operation because the `deliverySender` path always takes priority.

The code path:

1. `start-bot-app.ts:67-70` initializes `scheduledTaskRuntime` with `deliverySender = createScheduledTaskDeliverySender(bot.api, config.telegram.allowedUserId)` — this is always set in production.

2. `scheduled-task-runtime-service.ts:466-467` — `sendDelivery()` checks `if (this.deliverySender)` and immediately delegates to the deliverySender, returning early. Lines 470-492 (which contain the session-specific topic routing using `delivery.sessionId` and `getTopicStore()`) are **never reached**.

3. `scheduled-task-delivery.ts:53-93` — `createScheduledTaskDeliverySender` sends messages via `sendBotText({ api: bot.api, chatId: allowedUserId, ... })` without any topic routing. The `chatId` is fixed to the private chat.

4. `bot/index.ts:99-158` — The API transformer intercepts these messages and redirects them based on `getCurrentSession()` (the **current foreground** session, not the scheduled task's associated session).

**Result:** If a user is in Session B when a scheduled task for Session A fires, the delivery notification goes to Session B's topic. If no session is active, the delivery goes to the private chat. It **never** goes to the intended session's topic.

**Fix:** The session-specific routing must be applied in the `deliverySender` path as well. Options:

- **Option A:** Pass the topic ID into the deliverySender and have it set `message_thread_id` in the send options:
  ```typescript
  // In scheduled-task-delivery.ts
  async send(delivery) {
    const chatId = delivery.sessionId && config.telegram.forumChatId
      ? Number(config.telegram.forumChatId)
      : config.telegram.allowedUserId;
    const sendOptions: Record<string, unknown> = {};
    if (delivery.sessionId && config.telegram.forumChatId) {
      const topicId = getTopicStore().getTopicId(delivery.sessionId);
      if (topicId) sendOptions.message_thread_id = topicId;
    }
    // ... use chatId and sendOptions in all sendBotText calls
  }
  ```

- **Option B:** Remove the `deliverySender` dedicated path and always route through `sendDelivery`'s direct code path. This is simpler but loses the markdown formatting capabilities of `createScheduledTaskDeliverySender`.

- **Option C:** Modify the API transformer to respect a per-call routing hint (e.g., a custom property that gets stripped before sending). This is the most invasive.

---

### CR-02: Plan monitoring topic resolves to existing session topic, not a new dedicated topic (Feature 2)

**File:** `src/bot/callbacks/plan-callback-handler.ts:92-96`
**File:** `src/app/managers/session-topic-manager.ts:39-47`

**Issue:** When a plan is approved, the code attempts to create a monitoring topic by calling:

```typescript
const topicId = await sessionTopicManager.resolveTopicForSession(
  plan.sessionId,    // session ID
  plan.sessionId,    // ← directory (should be filesystem path)
  `📊 Monitor: ${plan.sessionId.slice(0, 8)}`,
);
```

The `resolveTopicForSession` method in `session-topic-manager.ts` first checks `store.getTopicId(sessionId)` (line 39). Since `plan.sessionId` is the session ID of the conversation where the plan was submitted, and that session **already has a topic** mapped in the store, this call immediately returns the **existing session topic** — it never creates a new monitoring topic.

**Secondary issue:** The second parameter `plan.sessionId` is passed as the `directory` argument. The directory field is meant to be a filesystem path (for deduplication when sessions share a directory). Passing a session ID pollutes the semantic meaning and could cause `getTopicIdByDirectory` to return unexpected results if called with an actual directory path.

**Impact:** The "📊 Monitoring Started" message (line 115-122) is posted to the **same conversation topic**, not a separate monitoring topic. The entire monitoring UI pattern is defeated.

**Fix:**

```typescript
// In plan-callback-handler.ts — create a dedicated topic that is NOT the session topic
const topicId = await sessionTopicManager.createDedicatedTopic(
  `📊 Monitor: ${plan.sessionId.slice(0, 8)}`,
);
```

Add a new method to `SessionTopicManager`:

```typescript
async createDedicatedTopic(title: string): Promise<number> {
  if (!this.bot || !this.forumChatId) {
    throw new Error("SessionTopicManager not initialized");
  }
  const sanitized = sanitizeTopicTitle(title);
  const result = await this.bot.api.createForumTopic(this.forumChatId, sanitized);
  return result.message_thread_id;
}
```

This method should create a raw forum topic **without** storing it in the session topic store (since it's a monitoring topic, not a session mapping).

---

### CR-03: API transformer injects invalid `message_thread_id` into `editMessageText`/`editMessageCaption` calls

**File:** `src/bot/index.ts:113-147`

**Issue:** The API transformer conditionally injects `message_thread_id` into payloads for `editMessageText` and `editMessageCaption` methods (lines 114-123 include these methods in the routing set). The Telegram Bot API does **not** accept `message_thread_id` as a parameter for `editMessageText` or `editMessageCaption` — these parameters are only valid for message send methods (`sendMessage`, `sendDocument`, etc.).

**Affected code paths:**

- **Compact progress streamer** (`event-subscription-service.ts:198`): `editText` calls `this.botInstance.api.editMessageText(chatId, messageId, text)`. The transformer injects `message_thread_id` into the payload, causing a Telegram API error.
- **Plan approval/rejection** (`plan-callback-handler.ts:106-112, 157-163`): `editMessageText` calls to update the plan approval message status get `message_thread_id` injected, potentially failing.
- **Any other `editMessageText`/`editMessageCaption` call** through the API transformer.

**Trace:** When `editMessageText` is called without a `message_thread_id`:
1. Transformer enters `else` branch (line 134) because `p.message_thread_id` is falsy
2. Gets current session, looks up topicId
3. Sets `p.chat_id = forumChatId` and `p.message_thread_id = topicId`
4. Sends to Telegram API — Telegram rejects with an error about unexpected field

**Fix:** Exclude edit methods from the `message_thread_id` injection. For `editMessageText`/`editMessageCaption`, only override `chat_id`:

```typescript
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

  if (p.message_thread_id || isEditMethod) {
    p.chat_id = Number(config.telegram.forumChatId);
    // Don't set message_thread_id for edit methods — it's not valid
  } else {
    const session = getCurrentSession();
    if (session) {
      const topicId = sessionTopicManager.lookupTopicId(session.id);
      if (topicId) {
        p.chat_id = Number(config.telegram.forumChatId);
        p.message_thread_id = topicId;
      }
    }
  }
}
```

---

## Warnings

### WR-01: Plan submit button appears on ALL assistant messages, with no content validation (Feature 2)

**File:** `src/bot/services/event-subscription-service.ts:443-459`
**File:** `src/bot/callbacks/plan-callback-handler.ts:27-30`

**Issue:** The "📋 Submit as Plan" button is unconditionally added to every completed assistant message inline keyboard. Users can submit trivial content (e.g., "Hello", tool execution output, error messages) as a "plan." The `handlePlanSubmit` handler only checks whether text exists — it does not validate content length, check for meaningful structure, or verify user intent.

**Risk:**
- A user accidentally clicks "Submit as Plan" on a tool result or greeting message
- The content gets posted to the plans review topic (4) as a legitimate plan
- No confirmation dialog before submission
- No way to cancel a submission once clicked

**Fix (choose one or more):**
1. Add a minimum content length check in `handlePlanSubmit`:
   ```typescript
   const MIN_PLAN_LENGTH = 50;
   if (!content || content.length < MIN_PLAN_LENGTH) {
     await ctx.answerCallbackQuery({ text: "Message too short to be a plan (min 50 chars)." });
     return true;
   }
   ```
2. Add a confirmation inline keyboard before actually creating the plan (e.g., "Confirm plan submission?")
3. Consider a dedicated `/submit_plan` command instead of an always-visible button

---

### WR-02: Unused variable `completionResult` from `finalizeAssistantResponse`

**File:** `src/bot/services/event-subscription-service.ts:431`

**Issue:** The return value of `finalizeAssistantResponse` is stored in `completionResult` but never read:

```typescript
const completionResult = await finalizeAssistantResponse({
  // ...
});
// completionResult is never referenced below this line
```

Meanwhile, the return type of `finalizeAssistantResponse` was changed from `Promise<boolean>` to `Promise<{ streamed: boolean; telegramMessageIds: number[] }>`, suggesting the extra data was intended to be consumed but the plumbing was never completed.

**Risk:** Unused variable confuses maintainers. The `telegramMessageIds` information could be useful for tracking which messages were sent, but it's currently discarded.

**Fix:** Either remove the return value assignment (`await finalizeAssistantResponse(...)` without capturing), or use `telegramMessageIds` for tracking/debugging (e.g., log the message IDs, store them for potential recall).

---

### WR-03: Race condition in startup topic resolution could create duplicate forum topics

**File:** `src/bot/services/event-subscription-service.ts:317-330`
**File:** `src/bot/index.ts:67-76`

**Issue:** During startup, the forum topic for the current session is resolved in two places, with a timing gap:

1. `ensureEventSubscription` (event-subscription-service.ts:320-328) — fires `resolveTopicForSession` asynchronously (uses `void` — **not awaited**).

2. `onReady` callback (bot/index.ts:67-76) — runs after `restoreAttachedCurrentSession` returns, checks `lookupTopicId`, and resolves the topic if not found.

Since step 1 is fire-and-forget, `ensureEventSubscription` may return before the topic is stored in SQLite. When step 2 runs immediately after, `lookupTopicId` returns `null` (topic not yet persisted), so it initiates a **second** `resolveTopicForSession` call. This can result in **two forum topics created for the same session** — the second `INSERT OR REPLACE` overwrites the first in the store, but the first topic remains as an orphan in the Telegram forum.

**Risk:** Orphaned forum topics accumulating in the Telegram forum over time, especially after bot restarts.

**Fix:** Either:
1. **Await** the `resolveTopicForSession` call in `ensureEventSubscription`:
   ```typescript
   await sessionTopicManager.resolveTopicForSession(...);
   ```
   (Remove the `void` keyword and `.catch()` — let the error propagate to the caller or handle it with try/catch.)

2. Or, use a deduplication guard to prevent the fallback from running if the first call is still in-flight (e.g., a `Set<string>` of session IDs with pending topic creation).

---

## Info / Code Quality

### IN-01: `getActivePlan()` is dead code

**File:** `src/app/managers/plan-manager.ts:72-79`

**Issue:** The `getActivePlan()` method is defined but never called anywhere in the codebase. All plan access in the callback handlers goes through `getPlan()`, `getPlanBySessionId()`, or `getPlanByApprovalMessageId()`.

Additionally, `getActivePlan()` returns the **first** non-rejected plan by insertion order, which behaves unpredictably if multiple plans from different sessions are pending simultaneously.

**Fix:** Remove the dead method, or document why it's kept for future use.

---

### IN-02: PlanManager can create orphan plans via sessionIndex overwrite

**File:** `src/app/managers/plan-manager.ts:18-31`

**Issue:** `createPlan` always overwrites the sessionIndex mapping (line 30: `this.sessionIndex.set(sessionId, id)`) without checking if a previous plan exists for that session. This means:

1. User submits Plan A for session X → `sessionIndex[X] = planA.id`
2. User submits Plan B for session X (any pending Plan A is still in review) → `sessionIndex[X] = planB.id`
3. Plan A is now an orphan — exists in `this.plans` but unreachable via `getPlanBySessionId`
4. If Plan A is approved/rejected via its approval message, it still works (via `getPlanByApprovalMessageId`)
5. But the approval message ID is set AFTER creation, so if the sessionIndex overwrite happens before the approval message is stored, Plan A's approvalMessageId is null and Plan A is fully orphaned

**Fix:** Add a guard:
```typescript
createPlan(sessionId: string, content: string): Plan {
  const existing = this.getPlanBySessionId(sessionId);
  if (existing && existing.status === "pending_review") {
    throw new Error("A plan is already pending review for this session");
  }
  // ... rest of creation
}
```

---

### IN-03: Missing `answerCallbackQuery` on early returns in plan callback handlers

**File:** `src/bot/callbacks/plan-callback-handler.ts:11,14,17`

**Issue:** The `handlePlanSubmit` function returns `false` on lines 11, 14, and 17 without calling `ctx.answerCallbackQuery()`. While this is technically correct (returning `false` lets the callback router handle it), the callback router will answer with `t("callback.unknown_command")` for these early exits, which could confuse the user with an "unknown command" message when the real issue is a missing/invalid parameter.

Specifically:
- Line 11: callback data doesn't match `plan_submit:` prefix — correct to return false (not our handler)
- Line 14: empty `sessionId` extracted — should answer with an error message instead of returning false
- Line 17: no `message` in callback — should answer with an error message

The same pattern exists in `handlePlanApprove` and `handlePlanReject` (lines 79-86, 137-145), but those DO answer with explicit messages.

**Fix:**
```typescript
// Line 13-15
const sessionId = data.slice("plan_submit:".length);
if (!sessionId) {
  await ctx.answerCallbackQuery({ text: "Invalid plan submission (missing session)." });
  return true;
}
```

---

## Feature-Specific Analysis

### Feature 1: Scheduled Task Session Routing

**Expected:** Task deliveries route to the session's forum topic.

**Reality:** Broken in production (CR-01). The deliverySender path (always active) bypasses the session-specific routing. Additionally, the API transformer (which handles the deliverySender output) routes based on the **current foreground session**, not the task's stored sessionId.

The sessionId is correctly captured in `buildScheduledTask` (`task-command.ts:256`) and propagated through `buildSuccessDelivery`/`buildErrorDelivery` into `QueuedScheduledTaskDelivery.sessionId`. But this data is never consumed in the deliverySender path.

### Feature 2: Plan Approval Flow

**Expected:** Plan submitted → posted to topic 4 → Approve/Reject → monitoring topic created.

**Reality:**
- ✅ Plan submission works correctly — content extracted from message, posted to topic 4 with Approve/Reject buttons
- ❌ Plan approval **fails to create a monitoring topic** — `resolveTopicForSession` returns the existing session topic (CR-02)
- ⚠️ Plan button appears on every assistant message without content validation (WR-01)
- ⚠️ `editMessageText` calls during approval/rejection may fail due to CR-03

### Feature 3: Command Routing to Forum Topic

**Expected:** No code changes needed — API transformer already routes all sendMessage calls.

**Reality:** ✅ Correct — the API transformer intercepts all `sendMessage` calls and injects the current session's topic ID, so commands like `/status` from DM are automatically routed to the forum topic.

However, this feature is affected by CR-03: if any command flow uses `editMessageText` or `editMessageCaption`, those calls could fail.

---

_Reviewed: 2026-06-27T14:00:00Z_
_Reviewer: gsd-code-reviewer agent (deep analysis)_
_Depth: deep (cross-file call-chain tracing)_
