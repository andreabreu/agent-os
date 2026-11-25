# Workflow runs and human gates

A workflow run executes one published workflow version on one case. Agents do
the agent steps, people decide approval gates, answer forms and do human steps,
and the run moves the case's primary task between them. Runs require the
`enableCases` and `enableWorkflowVersions` experimental flags. For versions,
specs and routine targets, see [workflow-versions.md](workflow-versions.md).

There is no run UI yet. Runs are driven through the REST API, gates appear in
the existing decision queue, and agents reach the run routes through the
generic `search_api` and `call_api` tools over the OpenAPI catalog.

## Starting a run

`POST /api/companies/{companyId}/workflow-runs` starts a run on a case with the
workflow's latest published version. Every run belongs to a
case, a case has at most one active run, and a finished case can run again.
The run is pinned to the version it started on and never moves to a newer one.

A version can run only when it passes the graph rules, every step type it uses
is runnable (`agent_task` owned by an agent, `approval_gate` owned by a user or
role, `human_task` owned by a user, `input_form` owned by a user or role) and
its first step is an agent step. Otherwise the start is refused with
`422 workflow_not_executable` and the offending issues. This also refuses
versions saved before a rule existed, such as an `externalEffect` step without
an approval gate right before it.

The person who starts the run is its responsible user, the one it escalates to.
When a routine's workflow target has a runnable version, every routine
dispatch binds its new task to a new case and starts a run on behalf of the
routine run's responsible user (the manual runner, otherwise the routine
owner). If the run cannot start, the routine wakes its task as it always did
and logs why.

`GET /api/companies/{companyId}/workflow-runs` lists runs and
`GET /api/workflow-runs/{id}` reads one with its steps and events.

## Agent steps

Each agent step is a case handoff to the step's agent on the case's primary
task, with instructions that name the step, its outcomes and the documents it
must produce. The agent finishes with
`POST /api/workflow-runs/{id}/steps/{stepKey}/complete` and an outcome. The
step's declared `outputs` must exist as documents on the task first; their
revision ids are recorded on the step.

Outcomes follow the graph: the next step, `end`, or back to an earlier step,
which starts a new attempt. Going back past `maxReviewRounds` or `maxAttempts`
escalates instead. When the platform gives up on an agent (the task becomes
Blocked), the recovery pass escalates the run with the reason; the engine
does not retry on its own.

Escalating sets the run to `waiting_human` with a reason for its responsible
user. `POST /api/workflow-runs/{id}/resume` picks the open step up again.

## Approval gates

An approval gate opens a decision in the decision queue, with one option per
outcome, created from the last agent run on the task. Only the step's declared
user or role, or the company's owners and admins, may decide it. Outcomes that
send work back or reject require a comment (`commentRequiredOn` can change
which). People only decide and comment; they never edit the work in the gate.

From the second round, the decision body summarizes how each output document
changed since the last round (lines added and removed, cut at a size limit).

A gate never decides itself. Decisions expire after at most 30 days. A gate
without `timeoutSec` is reopened with a fresh decision when that happens; a
gate with `timeoutSec` escalates when its decision expires. A cancelled
decision, or one decided without a person behind it, escalates too. The time
a gate waited is recorded on its `gate_decided` event as `waitedMs`.

## Human steps and forms

A human step gives the case's task to its person once the current agent run
releases the task. The person finishes it through the same `complete` route,
and the engine hands the task back to the agent that held it before.

A form step waits for answers from its declared user or role, or management,
without changing who holds the task. Answers go to
`POST /api/workflow-runs/{id}/steps/{stepKey}/submit-form`, are checked
against the step's typed questions (`422 invalid_answers` lists what is
missing or wrong) and are saved as a document under the step's first output
key. A second submission is refused with `409`. With `timeoutSec`, an
unanswered form escalates once; nothing is ever filled in for anyone.

## Reminders

A gate or form with `reminderAfterSec` reminds its deciders once per interval
until it is decided, answered or reaches its `timeoutSec`. Each reminder is a
`gate_reminder` run event and a `workflow_run.gate_reminder` activity entry
naming the deciders. Delivering reminders over chat is not built yet.

## Cancelling, budgets and recovery

`POST /api/workflow-runs/{id}/cancel` is open to the responsible user and
management. It cancels the run's open decisions and leaves the case's task as
it is. A free handoff on a case with an active run is refused, so the run
stays in control of the task.

When a budget pauses the company or the current step's agent, the run moves to
`paused`; it returns to where it was when the pause ends. A budget pause cannot
be resumed by hand.

A recovery pass runs once at server start and whenever its delivery queue is
notified: a budget pause starts or ends, a task enters Blocked, or a gate or
form gets a timeout or reminder. It also runs at the next form timeout or
reminder (`due_at`, `remind_at` on the step). It never polls. The pass
processes gates whose decision changed without the run seeing it, hands ready
human steps to their people, escalates stuck agent steps and overdue forms,
and sends due reminders.

## Simulating a workflow

`POST /api/workflows/{id}/simulate` walks a submitted spec, or a published
version, with scripted outcomes per step (the last one repeats once a step's
list runs out). It applies the same rules as a real run, ends loops at their
limits, and returns the path and whether the run completes or escalates. It
never creates tasks, decisions, cases or runs.

## State

Runs, steps and events live in `workflow_runs`, `workflow_run_steps` and
`workflow_run_events`. Runs carry a `state_version`; a server that reads a run
state it does not know refuses it with `workflow_run_state_unsupported`
instead of guessing. Every mutation writes an activity entry.
