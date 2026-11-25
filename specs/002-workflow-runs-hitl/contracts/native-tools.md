# Contrato: ferramentas nativas de agente

Todas exigem `enableCases` e `enableWorkflowVersions` e usam o mesmo cabeçalho de idempotência do `native-workflow-tools`.

| Ferramenta | Tipo | Entrada | Efeito |
| --- | --- | --- | --- |
| `read_workflow_run` | leitura | `{ runId, responseText? }` | Run, etapa atual, outcomes permitidos, saídas exigidas, entradas disponíveis e eventos recentes |
| `start_workflow_run` | escrita | `{ workflowId, caseId, idempotencyKey }` | Inicia o run; mesmas regras de `POST /workflow-runs` |
| `complete_workflow_step` | escrita | `{ runId, stepKey, outcome, summary?, idempotencyKey }` | Conclui a etapa; o servidor confere saídas e outcome, passa o case ao dono da próxima etapa (handoff em nome do agente), abre gate, formulário ou etapa humana |

`handoff_case` livre num case com run ativo é recusado com mensagem que aponta para `complete_workflow_step`.
