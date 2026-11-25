# Contrato: versões de workflow

Todas as rotas exigem `enableCases` e `enableWorkflowVersions` (senão `403` com `code: "cases_disabled"` ou `code: "workflow_versions_disabled"`) e acesso à empresa dona do workflow. Mutações vão para o activity log.

| Método e caminho | Quem | Corpo | Resposta |
| --- | --- | --- | --- |
| `POST /api/workflows/{id}/versions` | Mesma autoridade de `authorizeCaseCreation` | `{ spec }` | `201` `{ id, workflowId, version, specHash, createdAt }` |
| `GET /api/workflows/{id}/versions` | Acesso à empresa | query `limit`, `offset` | `200` lista de metadados, sem `spec` |
| `GET /api/workflows/{id}/versions/{version}` | Acesso à empresa | query `snapshot?` | `200` versão com `spec` e `ETag` |
| `POST /api/workflows/{id}/archive` | Mesma autoridade de publicar | vazio | `200` workflow com `status: "archived"` |

## Erros

| Código | Quando |
| --- | --- |
| `404` | Workflow ou versão inexistente, ou de outra empresa |
| `409` | Snapshot de leitura paginada obsoleto, ou publicação num workflow arquivado |
| `400` | Spec malformado (schema); nada é gravado |
| `422` | Spec inválido; `details.issues[]` traz `{ code, stepKey, outcomeKey?, message }` |

Códigos de validação de grafo (`422`, `details.code = "invalid_workflow_graph"`): `duplicate_step_key`, `start_not_found`, `unknown_destination`, `unknown_input`, `unreachable_step`, `no_path_to_end` (por etapa alcançável que não chega ao fim), `unbounded_cycle`. Um ciclo é aceito quando alguma etapa dele declara `maxAttempts` ou `maxReviewRounds`. `unsupported_step_type` vem do schema (`400`).

## Ferramentas nativas (somente leitura)

- `list_workflow_versions` `{ workflowId, limit?, offset? }`
- `read_workflow_version` `{ workflowId, version, snapshot?, responseText? }`

Ambas recusam com o erro padrão quando a flag está desligada.

## Atividade

`workflow.version_published` (detalhes: `version`, `specHash`) e `workflow.archived`.
