import { Router, type Request } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { workflows, type Db } from "@paperclipai/db";
import {
  listWorkflowVersionsSchema,
  publishWorkflowVersionSchema,
  readWorkflowVersionQuerySchema,
  workflowVersionParamsSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { notFound } from "../errors.js";
import { assertCompanyAccess, hasCompanyAccess } from "./authz.js";
import { requireWorkflowVersionsEnabled, workflowVersionService } from "../services/workflow-versions.js";

export function workflowVersionRoutes(db: Db) {
  const router = Router();
  const service = workflowVersionService(db);

  async function workflowCompany(req: Request) {
    await requireWorkflowVersionsEnabled(db);
    const workflowId = z.string().guid().parse(req.params.id);
    const [row] = await db.select({ companyId: workflows.companyId }).from(workflows).where(eq(workflows.id, workflowId));
    if (!row || !hasCompanyAccess(req, row.companyId)) throw notFound("Workflow not found");
    assertCompanyAccess(req, row.companyId);
    return { workflowId, companyId: row.companyId };
  }

  router.post("/workflows/:id/versions", validate(publishWorkflowVersionSchema), async (req, res) => {
    const { workflowId, companyId } = await workflowCompany(req);
    res.status(201).json(await service.publish(companyId, workflowId, req.actor, req.body));
  });

  router.get("/workflows/:id/versions", async (req, res) => {
    const { workflowId, companyId } = await workflowCompany(req);
    res.json(await service.list(companyId, workflowId, listWorkflowVersionsSchema.parse(req.query)));
  });

  router.get("/workflows/:id/versions/:version", async (req, res) => {
    const { workflowId, companyId } = await workflowCompany(req);
    const { version } = workflowVersionParamsSchema.parse(req.params);
    const query = readWorkflowVersionQuerySchema.parse(req.query);
    const result = await service.read(companyId, workflowId, version, query.snapshot);
    res.set("ETag", `"${result.snapshot}"`).json(result.version);
  });

  router.post("/workflows/:id/archive", async (req, res) => {
    const { workflowId, companyId } = await workflowCompany(req);
    res.json(await service.archive(companyId, workflowId, req.actor));
  });

  return router;
}
