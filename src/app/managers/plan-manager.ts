import { randomUUID } from "node:crypto";

export interface Plan {
  id: string;
  sessionId: string;
  content: string;
  status: "pending_review" | "approved" | "rejected";
  approvalMessageId: number | null;
  monitoringTopicId: number | null;
  createdAt: string;
}

class PlanManager {
  private plans = new Map<string, Plan>();
  private sessionIndex = new Map<string, string>(); // sessionId -> planId
  private messageIndex = new Map<number, string>(); // approvalMessageId -> planId

  createPlan(sessionId: string, content: string): Plan {
    // Don't allow multiple pending plans for the same session
    const existing = this.getPlanBySessionId(sessionId);
    if (existing && existing.status === "pending_review") {
      throw new Error("A plan is already pending review for this session");
    }

    const id = randomUUID();
    const plan: Plan = {
      id,
      sessionId,
      content,
      status: "pending_review",
      approvalMessageId: null,
      monitoringTopicId: null,
      createdAt: new Date().toISOString(),
    };
    this.plans.set(id, plan);
    this.sessionIndex.set(sessionId, id);
    return plan;
  }

  getPlan(id: string): Plan | null {
    return this.plans.get(id) ?? null;
  }

  getPlanBySessionId(sessionId: string): Plan | null {
    const planId = this.sessionIndex.get(sessionId);
    if (!planId) return null;
    return this.plans.get(planId) ?? null;
  }

  getPlanByApprovalMessageId(messageId: number): Plan | null {
    const planId = this.messageIndex.get(messageId);
    if (!planId) return null;
    return this.plans.get(planId) ?? null;
  }

  setApprovalMessage(planId: string, messageId: number): void {
    const plan = this.plans.get(planId);
    if (plan) {
      plan.approvalMessageId = messageId;
      this.messageIndex.set(messageId, planId);
    }
  }

  updateStatus(planId: string, status: Plan["status"]): void {
    const plan = this.plans.get(planId);
    if (plan) {
      plan.status = status;
    }
  }

  setMonitoringTopic(planId: string, topicId: number): void {
    const plan = this.plans.get(planId);
    if (plan) {
      plan.monitoringTopicId = topicId;
    }
  }

}

export const planManager = new PlanManager();
