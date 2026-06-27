import { Context } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { sessionTopicManager } from "../../app/managers/session-topic-manager.js";
import { planManager } from "../../app/managers/plan-manager.js";

const MAX_PLAN_LENGTH = 4000;

export async function handlePlanSubmit(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("plan_submit:")) return false;

  const sessionId = data.slice("plan_submit:".length);
  if (!sessionId) return false;

  const message = ctx.callbackQuery?.message;
  if (!message) return false;

  // Get plan content from the message
  let content = "";
  if ("text" in message && message.text) {
    content = message.text;
  } else if ("caption" in message && message.caption) {
    content = message.caption;
  }

  if (!content) {
    await ctx.answerCallbackQuery({ text: "No plan content found in message." });
    return true;
  }

  // Create a plan entry
  const plan = planManager.createPlan(sessionId, content);

  // Determine the plans topic (default: topic 4, but we'll use config or fallback)
  const plansTopicId = Number(config.telegram.forumTopicId ?? 4);
  const forumChatId = Number(config.telegram.forumChatId);

  if (!forumChatId) {
    await ctx.answerCallbackQuery({ text: "Forum chat not configured." });
    return true;
  }

  try {
    // Truncate if needed
    const planText =
      content.length > MAX_PLAN_LENGTH
        ? content.slice(0, MAX_PLAN_LENGTH - 3) + "..."
        : content;

    const sent = await ctx.api.sendMessage(forumChatId, planText, {
      message_thread_id: plansTopicId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `plan_approve:${plan.id}` },
            { text: "❌ Reject", callback_data: `plan_reject:${plan.id}` },
          ],
        ],
      },
    });

    planManager.setApprovalMessage(plan.id, sent.message_id);

    await ctx.answerCallbackQuery({ text: "Plan submitted for review." });
    logger.info(
      `[PlanCallback] Plan submitted: id=${plan.id}, session=${sessionId}, approvalMsgId=${sent.message_id}`,
    );
  } catch (error) {
    logger.error("[PlanCallback] Failed to submit plan:", error);
    await ctx.answerCallbackQuery({ text: "Failed to submit plan." });
  }

  return true;
}

export async function handlePlanApprove(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("plan_approve:")) return false;

  const planId = data.slice("plan_approve:".length);
  const plan = planManager.getPlan(planId);
  if (!plan) {
    await ctx.answerCallbackQuery({ text: "Plan not found." });
    return true;
  }

  try {
    planManager.updateStatus(planId, "approved");

    // Create a monitoring topic for this session
    const topicId = await sessionTopicManager.resolveTopicForSession(
      plan.sessionId,
      plan.sessionId,
      `📊 Monitor: ${plan.sessionId.slice(0, 8)}`,
    );
    planManager.setMonitoringTopic(planId, topicId);

    // Edit the approval message to show approved
    if (plan.approvalMessageId) {
      await ctx.api.editMessageReplyMarkup(
        Number(config.telegram.forumChatId),
        plan.approvalMessageId,
        { reply_markup: { inline_keyboard: [] } },
      );
      await ctx.api.editMessageText(
        Number(config.telegram.forumChatId),
        plan.approvalMessageId,
        "✅ **Plan Approved**",
        { parse_mode: "Markdown" },
      );
    }

    // Post confirmation to the monitoring topic
    await ctx.api.sendMessage(
      Number(config.telegram.forumChatId),
      `📊 **Monitoring Started**\n\nPlan approved. Progress updates will appear here.`,
      {
        message_thread_id: topicId,
        parse_mode: "Markdown",
      },
    );

    await ctx.answerCallbackQuery({ text: "Plan approved! Monitoring topic created." });
    logger.info(
      `[PlanCallback] Plan approved: id=${planId}, monitoringTopicId=${topicId}`,
    );
  } catch (error) {
    logger.error("[PlanCallback] Failed to approve plan:", error);
    await ctx.answerCallbackQuery({ text: "Failed to approve plan." });
  }

  return true;
}

export async function handlePlanReject(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("plan_reject:")) return false;

  const planId = data.slice("plan_reject:".length);
  const plan = planManager.getPlan(planId);
  if (!plan) {
    await ctx.answerCallbackQuery({ text: "Plan not found." });
    return true;
  }

  try {
    planManager.updateStatus(planId, "rejected");

    // Edit the approval message
    if (plan.approvalMessageId) {
      await ctx.api.editMessageReplyMarkup(
        Number(config.telegram.forumChatId),
        plan.approvalMessageId,
        { reply_markup: { inline_keyboard: [] } },
      );
      await ctx.api.editMessageText(
        Number(config.telegram.forumChatId),
        plan.approvalMessageId,
        "❌ **Plan Rejected**",
        { parse_mode: "Markdown" },
      );
    }

    await ctx.answerCallbackQuery({ text: "Plan rejected." });
    logger.info(`[PlanCallback] Plan rejected: id=${planId}`);
  } catch (error) {
    logger.error("[PlanCallback] Failed to reject plan:", error);
    await ctx.answerCallbackQuery({ text: "Failed to reject plan." });
  }

  return true;
}
