# Contrato: runs de workflow

Rotas exigem `enableCases` e `enableWorkflowVersions`, acesso à empresa e activity log nas mutações.

| Método e caminho | Quem | Corpo | Resposta |
| --- | --- | --- | --- |
| `POST /api/companies/{companyId}/workflow-runs` | Pessoa ou agente com autoridade sobre o case | `{ workflowId, caseId }` | `201` run; `409` se o case já tem run ativo; `422` se a versão não é executável |
| `GET /api/workflow-runs/{id}` | Acesso à empresa | n/a | `200` run com etapas e eventos recentes |
| `GET /api/companies/{companyId}/workflow-runs` | Acesso à empresa | query `status`, `caseId`, `limit`, `offset` | `200` lista |
| `POST /api/workflow-runs/{id}/steps/{stepKey}/complete` | Dono da etapa (agente ou pessoa), ou gestão | `{ outcome, summary? }` | `200`; `422` se faltam saídas (`missing_outputs[]`) ou o outcome não existe; `409` se a etapa não está em andamento |
| `POST /api/workflow-runs/{id}/steps/{stepKey}/submit-form` | Pessoa ou papel declarado, ou gestão | `{ answers }` | `200`; `422` com `missing_required[]` |
| `POST /api/workflow-runs/{id}/cancel` | Responsável ou gestão | `{ reason? }` | `200`; decisões e perguntas abertas canceladas; a tarefa do case permanece |
| `POST /api/workflow-runs/{id}/resume` | Responsável ou gestão | vazio | `200` retoma um run em `waiting_human` ou `paused` quando a causa foi resolvida |
| `POST /api/workflows/{id}/simulate` | Acesso à empresa | `{ spec?, versionNumber?, script }` | `200` percurso, estado final e escalonamentos; nunca grava |

O gate é decidido pela rota de decisões existente (`/api/decisions/...`), exigindo os inputs que a opção declara em `requiredInputIds`.

## Erros

`404` run ou etapa inexistente ou de outra empresa; `403` sem autoridade; `409` estado incompatível; `422` validação; `workflow_run_state_unsupported` (permanente) para estado de run de versão incompatível.

## Atividade

`workflow_run.started`, `workflow_run.step_completed`, `workflow_run.gate_opened`, `workflow_run.gate_decided`, `workflow_run.input_submitted`, `workflow_run.escalated`, `workflow_run.paused`, `workflow_run.resumed`, `workflow_run.cancelled`, `workflow_run.completed`, `workflow_run.failed`.
