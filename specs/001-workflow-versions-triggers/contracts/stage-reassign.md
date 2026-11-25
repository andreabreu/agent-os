# Contrato: reassign de estágio pendente

Adaptado da PR upstream #15265. A lógica pura fica no módulo dono (`applyIssueExecutionStageReassignment` em `server/src/services/issue-execution-policy.ts`) e a rota num roteador novo (`server/src/routes/issue-stage-reassign.ts`).

`POST /api/issues/{id}/execution-policy/reassign`

Corpo: `{ toParticipant, comment }`, onde `toParticipant` é um principal de estágio (agente ou usuário) já configurado no estágio pendente. O comentário é obrigatório, como no upstream.

Exige `enableCases` e `enableWorkflowVersions`. Autorização: o participante ativo do estágio ou um usuário do board.

| Código | Quando |
| --- | --- |
| `200` | Novo participante ativo; `lastReassignment` (`fromParticipant`, `toParticipant`, `comment`) e `lastDecisionOutcome: "reassigned"` gravados no estado; decisão `reassigned` em `issue_execution_decisions`; agente de destino acordado |
| `200` sem mudança | `toParticipant` já é o participante ativo (no-op, nenhuma decisão gravada) |
| `403` | Ator que não é o participante ativo nem do board, ou flag desligada (com `code`) |
| `404` | Tarefa inexistente ou de outra empresa |
| `409` | `code: "execution_stage_participant_running"`: uma run está executando a tarefa |
| `422` | Sem estágio pendente, alvo fora do estágio, alvo é o autor sob revisão, comentário ausente, ou usuário alvo que não é membro ativo da empresa |

O contador de rodadas (`changesRequestedCount`) e o histórico de decisões não são reiniciados. Atividade: `issue.execution_policy_reassigned`.

## Limitação conhecida

O upstream para a run do participante que sai antes de reatribuir. No fork essa parada está embutida no handler de `PATCH /issues/:id` (com casos de runtime nativo), e copiá-la duplicaria lógica sensível. Por isso o reassign é recusado com `409` enquanto uma run executa a tarefa. Para remover a limitação, extrair a parada de run para uma função compartilhada.
