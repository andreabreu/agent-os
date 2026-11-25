import { Router, type Request } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { projects, type Db } from "@paperclipai/db";
import { putDefaultExecutionPolicySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { accessService } from "../services/access.js";
import { requireWorkflowVersionsEnabled } from "../services/workflow-versions.js";
import { defaultExecutionPolicyService } from "../services/issue-default-execution-policy.js";

const BOARD_ONLY_MESSAGE = "Only board users can set a default execution policy";

export function defaultExecutionPolicyRoutes(db: Db) {
  const router = Router();
  const service = defaultExecutionPolicyService(db);
  const access = accessService(db);

  function assertBoardWriter(req: Request) {
    if (req.actor.type !== "board") throw forbidden(BOARD_ONLY_MESSAGE);
  }

  async function readableProject(req: Request) {
    const projectId = z.string().guid().parse(req.params.id);
    const [project] = await db.select({ id: projects.id, companyId: projects.companyId }).from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw notFound("Project not found");
    const decision = await access.decide({
      actor: req.actor,
      action: "project:read",
      resource: { type: "project", companyId: project.companyId, projectId: project.id },
    });
    if (!decision.allowed) throw notFound("Project not found");
    assertCompanyAccess(req, project.companyId);
    return project;
  }

  router.get("/companies/:companyId/default-execution-policy", async (req, res) => {
    await requireWorkflowVersionsEnabled(db);
    const companyId = z.string().guid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.json({ defaultExecutionPolicy: await service.readCompany(companyId) });
  });

  router.put("/companies/:companyId/default-execution-policy", validate(putDefaultExecutionPolicySchema), async (req, res) => {
    await requireWorkflowVersionsEnabled(db);
    const companyId = z.string().guid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    assertBoardWriter(req);
    res.json({ defaultExecutionPolicy: await service.setCompany(companyId, req.actor, req.body.defaultExecutionPolicy) });
  });

  router.get("/projects/:id/default-execution-policy", async (req, res) => {
    await requireWorkflowVersionsEnabled(db);
    const project = await readableProject(req);
    res.json({ defaultExecutionPolicy: await service.readProject(project.id) });
  });

  router.put("/projects/:id/default-execution-policy", validate(putDefaultExecutionPolicySchema), async (req, res) => {
    await requireWorkflowVersionsEnabled(db);
    const project = await readableProject(req);
    assertBoardWriter(req);
    res.json({ defaultExecutionPolicy: await service.setProject(project.companyId, project.id, req.actor, req.body.defaultExecutionPolicy) });
  });

  return router;
}
