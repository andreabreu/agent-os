# Contrato: alvo de workflow numa rotina

Rotas em roteador próprio; exigem `enableCases` e `enableWorkflowVersions`.

| Método e caminho | Corpo | Resposta |
| --- | --- | --- |
| `PUT /api/routines/{id}/workflow-target` | `{ workflowId }` | `200` `{ routineId, workflowId }` |
| `GET /api/routines/{id}/workflow-target` | n/a | `200` alvo ou `404` se não houver |
| `DELETE /api/routines/{id}/workflow-target` | n/a | `204` |

Regras: o workflow e a rotina pertencem à mesma empresa (`404` caso contrário); o workflow não pode estar arquivado ao definir o alvo (`409`). Só usuários do board, ou o agente que executa a rotina, mudam o alvo (`403`); a leitura exige acesso à empresa. Atividade: `routine.workflow_target_set` e `routine.workflow_target_removed`.

## Comportamento no disparo

Vale para `schedule`, `webhook` e `api` (inclui disparo manual). `heartbeat` não inicia trabalho e não é afetado.

| Situação | Resultado |
| --- | --- |
| Sem alvo | Comportamento atual, inalterado |
| Alvo com versão publicada | Tarefa criada uma vez por entrega, com referência ao workflow e à versão na descrição; `routine_runs.trigger_payload` recebe `workflowVersionId` e `workflowVersion`; activity log registra a versão usada |
| Workflow sem versão publicada | Run marcado como falho com `failure_reason` claro; nenhuma tarefa |
| Workflow arquivado | Mesmo tratamento de falha |

A idempotência por entrega e a política de concorrência da rotina continuam as existentes.

## Limitação conhecida

As revisões de rotina não capturam o alvo (o snapshot de revisão é estrito e não foi alterado).
