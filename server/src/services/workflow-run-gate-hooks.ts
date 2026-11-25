import { and, eq } from "drizzle-orm";
import { companyMemberships, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { AuthorizationActor } from "./authorization.js";

const MANAGEMENT_ROLES: readonly string[] = ["owner", "admin"];

export interface WorkflowGateMetadata {
  runId: string;
  stepKey: string;
  attempt: number;
  deciderUserIds: string[];
  deciderRoles: string[];
  timeoutDeclared: boolean;
}

type DecisionLike = { id: string; companyId: string; metadata: unknown };

export function readWorkflowGate(metadata: unknown): WorkflowGateMetadata | null {
  const gate = (metadata as { workflowGate?: WorkflowGateMetadata } | null)?.workflowGate;
  return gate && typeof gate.runId === "string" ? gate : null;
}

async function membershipRole(db: Db, companyId: string, userId: string) {
  const [membership] = await db.select({ role: companyMemberships.membershipRole }).from(companyMemberships).where(and(
    eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")));
  return membership?.role ?? null;
}

/**
 * Refuses a decision on a workflow gate by anyone but its declared deciders or the company's management.
 * Decisions that are not workflow gates are unaffected.
 */
export async function assertWorkflowGateDecider(db: Db, decision: DecisionLike, actor: AuthorizationActor, userId: string) {
  const gate = readWorkflowGate(decision.metadata);
  if (!gate) return;
  if (actor.type === "board" && (actor.source === "local_implicit" || actor.isInstanceAdmin)) return;
  if (gate.deciderUserIds.includes(userId)) return;
  const role = await membershipRole(db, decision.companyId, userId);
  if (role && (MANAGEMENT_ROLES.includes(role) || gate.deciderRoles.includes(role))) return;
  throw forbidden("Only this step's deciders or the company's owners and admins can decide this workflow gate", {
    code: "workflow_gate_decider_required",
  });
}

/**
 * Tells the workflow run that owns a gate decision that the decision was decided, cancelled or expired.
 * The run module is loaded lazily because it depends on the decision service.
 * A failure is logged and left to the run's recovery pass; it never undoes the decision.
 */
export async function notifyWorkflowGate(db: Db, decision: DecisionLike, actor: AuthorizationActor | null) {
  if (!readWorkflowGate(decision.metadata)) return;
  try {
    const { onWorkflowGateResolved } = await import("./workflow-run-gates.js");
    await onWorkflowGateResolved(db, decision.id, actor);
  } catch (error) {
    logger.warn({ err: error, decisionId: decision.id }, "workflow gate resolution could not advance its run");
  }
}
