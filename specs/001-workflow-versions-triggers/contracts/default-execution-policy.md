# Contrato: política de execução padrão

Revisado na implementação para seguir o desenho da PR upstream #15267: rotas dedicadas em `server/src/routes/default-execution-policy.ts`, em vez de campos nos `PATCH` de empresa e projeto. Isso também evita editar `routes/companies.ts` e `routes/projects.ts`.

Todas exigem `enableCases` e `enableWorkflowVersions` (senão `403` com `code`).

| Método e caminho | Quem | Corpo | Resposta |
| --- | --- | --- | --- |
| `GET /api/companies/{companyId}/default-execution-policy` | Acesso à empresa | n/a | `200 { defaultExecutionPolicy }` |
| `PUT /api/companies/{companyId}/default-execution-policy` | Só usuários do board | `{ defaultExecutionPolicy: política \| null }` | `200 { defaultExecutionPolicy }`; `403` para agentes |
| `GET /api/projects/{id}/default-execution-policy` | Acesso à empresa e `project:read` | n/a | `200`; `404` sem `project:read` |
| `PUT /api/projects/{id}/default-execution-policy` | Board com `project:read` | `{ defaultExecutionPolicy: política \| null }` | `200`; `403` para agentes; `404` sem `project:read` |

- Validação com `issueExecutionPolicySchema` ao salvar; inválida devolve `400` e nada é gravado.
- Uma política padrão **não pode ter `monitor`** (`400`). Monitores continuam sendo definidos por tarefa. Isso dispensa a redação de `externalRef` e a autorização de monitor herdado que o upstream implementa.
- A política é guardada como modelo, sem IDs de estágio e de participante; cada tarefa nova recebe IDs novos.
- Atividade: `company.default_execution_policy_updated` e `project.default_execution_policy_updated`, com `cleared` e os tipos de estágio.
- O cliente da UI fica em `ui/src/api/default-execution-policy.ts` (sem tela nesta fase).

## Resolução na criação de tarefa

Ponto de extensão único em `issueService.create` (`server/src/services/issues.ts`), depois da herança de projeto da tarefa pai, chamando `withDefaultIssueExecutionPolicy` (`server/src/services/issue-default-execution-policy.ts`).

Ordem: política declarada na criação (inclusive `null` explícito), depois a do projeto, depois a da empresa, senão nenhuma.

Não se aplica a tarefas de origem `routine_execution` ou de operação de plugin, a conversas (`conversationAgentId` e `conversationUserId`, ou origem `chat_channel`) nem a tarefas criadas como `done`. Vale para criação por pessoa e por agente. Com a flag desligada nenhum padrão é aplicado, mesmo que esteja salvo.
