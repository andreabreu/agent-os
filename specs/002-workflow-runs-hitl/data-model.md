# Data Model

Tudo company-scoped. Uma migração gerada por PR (`pnpm db:generate`). Tabelas novas: `workflow_runs`, `workflow_run_steps`, `workflow_run_events`. O formulário não tem tabela própria: as perguntas vivem na definição da etapa e as respostas num documento do case.

## workflow_runs

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | uuid PK | |
| `company_id` | uuid FK `companies` | cascade |
| `workflow_id` | uuid FK `workflows` | restrict |
| `version_id` | uuid FK `workflow_versions` | restrict; fixo, nunca muda |
| `case_id` | uuid FK `cases` | cascade |
| `status` | text | `running` / `waiting_human` / `paused` / `completed` / `failed` / `cancelled` |
| `status_reason` | text, nulo | Motivo de `waiting_human`, `paused`, `failed` |
| `responsible_user_id` | text | Quem iniciou, ou o dono da rotina |
| `started_by_agent_id` / `started_by_user_id` | uuid / text, nulos | |
| `origin` | text | `manual` / `agent` / `routine` |
| `routine_run_id` | uuid, nulo | FK `routine_runs`, set null |
| `current_step_key` | text, nulo | |
| `state_version` | integer, padrão 1 | Regra `upgrade-safe-run-state`; valor desconhecido gera `workflow_run_state_unsupported` |
| `started_at`, `completed_at`, `created_at`, `updated_at` | timestamptz | |

Índices: único parcial `(case_id)` onde `status IN ('running','waiting_human','paused')`; `(company_id, status)`; `(company_id, workflow_id, created_at)`.

## workflow_run_steps

Uma linha por tentativa de cada etapa.

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | uuid PK | |
| `run_id` | uuid FK `workflow_runs` | cascade |
| `company_id` | uuid FK `companies` | cascade |
| `step_key` | text | Chave da etapa no spec da versão |
| `attempt` | integer | Começa em 1; devolução soma 1 |
| `status` | text | `pending` / `ready` / `running` / `awaiting_review` / `awaiting_approval` / `awaiting_input` / `completed` / `changes_requested` / `skipped` / `failed` / `cancelled` |
| `outcome` | text, nulo | Chave do outcome escolhido |
| `assignee_agent_id` / `assignee_user_id` | uuid / text, nulos | |
| `handoff_id` | uuid, nulo | FK `case_handoffs` |
| `decision_id` | uuid, nulo | FK `decisions` (gate) |
| `interaction_id` | uuid, nulo | FK `issue_thread_interactions` (formulário) |
| `output_revision_ids` | jsonb | `{ chaveDocumento: revisionId }` |
| `comment` | text, nulo | Comentário do decisor ao devolver ou rejeitar |
| `opened_at`, `closed_at` | timestamptz | Tempo de espera = diferença, para gates |

Índices: único `(run_id, step_key, attempt)`; `(company_id, run_id)`; `(decision_id)` e `(interaction_id)` parciais.

## workflow_run_events

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | uuid PK | |
| `run_id` | uuid FK `workflow_runs` | cascade |
| `company_id` | uuid FK `companies` | cascade |
| `event_key` | text | Chave de idempotência do evento |
| `kind` | text | `started`, `step_ready`, `step_completed`, `gate_opened`, `gate_decided`, `gate_reminder`, `input_requested`, `input_submitted`, `changes_requested`, `escalated`, `paused`, `resumed`, `cancelled`, `completed`, `failed` |
| `actor_type` | text | `user` / `agent` / `system` |
| `actor_id` | text, nulo | |
| `payload` | jsonb | |
| `created_at` | timestamptz | |

Índice único `(run_id, event_key)`. Toda linha também vai ao activity log.

## Definição de etapa (estende `workflow-spec.ts`, aditivo)

Campos novos, todos opcionais: `outputs: [chaveDocumento]` (exigidos na conclusão), `externalEffect: boolean`, `timeoutSec` (gate e formulário, máximo 2.592.000 = 30 dias), `reminderAfterSec`, `commentRequiredOn: [outcomeKey]`, e para `input_form`: `questions: [{ id, label, kind: text | single_choice | multi_choice | number | date, required, options? }]`. Tipos de etapa aceitos: `agent_task`, `human_task`, `approval_gate`, `input_form`.

## Estados e transições

- **Run**: `running` → `waiting_human` (gate, formulário, etapa humana, escalonamento) → `running`; `running` ⇄ `paused` (orçamento); qualquer ativo → `cancelled`; `running` → `completed` ou `failed`.
- **Etapa**: `pending` → `ready` → `running` → (`awaiting_review` | `awaiting_approval` | `awaiting_input`) → `completed`; devolução fecha a tentativa como `changes_requested` e abre a tentativa seguinte do destino.
- Devolução acima de `maxReviewRounds`, falha acima de `maxAttempts` ou expiração de gate com `timeoutSec` levam o run a `waiting_human`; nada decide por uma pessoa.
