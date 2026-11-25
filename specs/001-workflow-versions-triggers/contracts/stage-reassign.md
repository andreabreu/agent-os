# Contrato: reassign de estágio pendente

`POST /api/issues/{id}/execution-policy/reassign`

Corpo: `{ toParticipant, comment? }`, onde `toParticipant` é um principal de estágio (agente ou usuário) já configurado no estágio pendente.

Autorização: o participante ativo do estágio ou um ator com permissão de gestão da empresa.

| Código | Quando |
| --- | --- |
| `200` | Novo participante ativo; `lastReassignment` (`fromParticipant`, `toParticipant`, `comment`) gravado no estado de execução |
| `403` | Ator sem permissão |
| `404` | Tarefa inexistente ou de outra empresa |
| `409` | Não há estágio pendente (concluído ou sem política) |
| `422` | `toParticipant` fora da lista do estágio |

Reassign para o participante já ativo é no-op sem erro. Contador de rodadas e histórico de decisões não são reiniciados. Atividade: `issue.execution_policy_reassigned`.
