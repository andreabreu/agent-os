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

Códigos de validação de grafo: `duplicate_step_key`, `start_not_found`, `unknown_destination`, `unreachable_step`, `no_path_to_end`, `unbounded_cycle`, `unsupported_step_type`.

## Ferramentas nativas (somente leitura)

- `list_workflow_versions` `{ workflowId, limit?, offset? }`
- `read_workflow_version` `{ workflowId, version, snapshot?, responseText? }`

Ambas recusam com o erro padrão quando a flag está desligada.

## Atividade

`workflow.version_published` (detalhes: `version`, `specHash`) e `workflow.archived`.
