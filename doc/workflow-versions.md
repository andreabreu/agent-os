# Workflow versions, default execution policies and routine workflow targets

Experimental, behind `enableWorkflowVersions`, which requires `enableCases`.
Turning Workflow versions on in Experimental settings also turns Cases on, and
turning Cases off also turns Workflow versions off. With the flag off, none of
the routes below are served (`403` with `code: "workflow_versions_disabled"` or
`"cases_disabled"`), no default policy is applied and routines dispatch as
before. Stored data is kept.

This is a fork-only feature; it is not offered upstream. The plan and spec live
in `doc/plans/2026-11-24-agent-workflows-hitl.md` and
`specs/001-workflow-versions-triggers/`.

## Workflow versions

A workflow keeps its name and Markdown prompt, and gains a `status`
(`draft`, `active`, `archived`; existing workflows are `active`) and a pointer to
its latest published version.

- `POST /api/workflows/{id}/versions` publishes the next version from a
  structured `spec`. Versions are numbered by an atomic counter on the workflow
  row, so concurrent publications never collide or leave gaps.
- A published version is immutable. There is no update or delete route; a
  change means publishing the next version.
- Reads return an `ETag` with the SHA-256 of the canonical spec. Pass it as
  `snapshot` to reject a changed read with `409`.
- `POST /api/workflows/{id}/archive` archives a workflow. Archived workflows
  refuse new versions and cannot become routine targets.
- Prompt-only workflows keep working: Cases adopt their prompt as before.

Agents read versions through the generic `search_api` and `call_api` tools,
whose catalog is built from the OpenAPI document. There are no dedicated Runner
tools for versions.

### The spec and graph validation

`specVersion: 1`, a `start` step and `steps[]`. Each step has a `key`, `name`,
`type` (`agent_task`, `human_task`, `approval_gate`), `owner` (`agent`, `user` or
`role` plus `ref`), `inputs`, `outcomes` (`key` and `to`, a step key or `end`)
and `limits` (`maxAttempts`, `maxReviewRounds`, `timeoutSec`). Other step types
are refused by the schema (`400`).

Publishing also validates the graph and returns `422` with
`details.code = "invalid_workflow_graph"` and one issue per problem, naming the
step: duplicate keys, a missing start, unknown destinations or inputs,
unreachable steps, steps with no path to the end, and unbounded loops.

A loop is accepted when one of its steps declares `maxAttempts` or
`maxReviewRounds`: the graph made of only the unbounded steps must have no
cycle. Requiring a limit on every step of a loop would reject the common
draft → review → draft loop bounded only on the review.

This phase stores and validates definitions only. Nothing executes the steps
yet; runs, gates between steps and the advancer are the next phase.

## Default execution policies

A company and a project can each hold a default execution policy (review and
approval stages). A new task that declares no `executionPolicy` gets its
project's default, otherwise its company's.

- A policy declared at creation, including an explicit `null`, always wins.
- Routine tasks (`routine_execution` and plugin operation origins),
  conversations and tasks created as `done` never get a default.
- Defaults are stored as templates without stage and participant ids; every new
  task gets fresh ids.
- A default cannot schedule a monitor. Monitors are set per task.
- Routes: `GET`/`PUT /api/companies/{companyId}/default-execution-policy` and
  `GET`/`PUT /api/projects/{id}/default-execution-policy`. Reads need company
  access (and `project:read` for a project); writes are board-only. `null`
  clears. Writes are logged as `company.default_execution_policy_updated` and
  `project.default_execution_policy_updated`.

The resolution is one call in `issueService.create`, after a child task inherits
its parent's project (`server/src/services/issue-default-execution-policy.ts`).

## Reassigning a pending stage

`POST /api/issues/{id}/execution-policy/reassign` with `{ toParticipant, comment }`
hands a pending review or approval stage to another participant already
configured on that stage. Only the active participant or a board user may do it,
the target cannot be the executor under review, and a comment is required.
Reassigning to the active participant is a no-op. The round counter and decision
history are kept, a `reassigned` decision is recorded, and an agent target is
woken.

While a run is executing the task, reassignment is refused with `409`
(`execution_stage_participant_running`). The logic that safely stops the
outgoing participant's run lives inside the issue `PATCH` route; extracting it
would lift this limit.

## Routines that start a workflow

`PUT`/`GET`/`DELETE /api/routines/{id}/workflow-target` sets which workflow a
routine starts. Board users, or the agent that runs the routine, may change it.

On every `schedule`, `webhook`, `api` or manual run of a routine with a target,
the created task's description names the workflow and its latest published
version, and the routine run's `triggerPayload` records `workflowId`,
`workflowVersionId` and `workflowVersion`. Idempotency, concurrency policy and
webhook signing are the routine's own; no trigger mechanism is added. When the
workflow is archived or has no published version, the run fails with that
reason and creates no task. `heartbeat` triggers never start work and are
unaffected.

The target lives in its own table (`routine_workflow_targets`) so the routine
table and its strict revision snapshot are untouched. As a result, routine
revisions do not capture the target.
