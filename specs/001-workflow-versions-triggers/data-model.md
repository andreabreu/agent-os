# Data Model

Toda tabela nova é company-scoped. Migração única, gerada com `pnpm db:generate`.

## workflows (existente, alterada)

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `key` | text, nulo | Único por empresa quando preenchido |
| `status` | text, `draft` / `active` / `archived` | Padrão `active`, preservando workflows só-prompt |
| `latest_version_id` | uuid, nulo | FK para `workflow_versions` |
| `latest_version_number` | integer, padrão 0 | Contador atômico de versões |

`name` e `prompt` continuam, e o prompt segue como manual para os agentes.

## workflow_versions (nova)

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | uuid PK | |
| `company_id` | uuid FK `companies` | cascade |
| `workflow_id` | uuid FK `workflows` | cascade |
| `version` | integer | Único com `workflow_id` |
| `spec` | jsonb | Spec validado (`specVersion: 1`) |
| `spec_hash` | text | SHA-256 do spec canônico |
| `published_by_agent_id` | uuid, nulo | FK `agents`, set null |
| `published_by_user_id` | text, nulo | |
| `created_at` | timestamptz | |

Índices: `(workflow_id, version)` único; `(company_id, workflow_id, created_at)`. Sem `UPDATE` nem `DELETE` por código de aplicação.

## routine_workflow_targets (nova)

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `routine_id` | uuid PK, FK `routines` | cascade |
| `company_id` | uuid FK `companies` | cascade |
| `workflow_id` | uuid FK `workflows` | restrict |
| `created_by_agent_id` / `created_by_user_id` | uuid / text | |
| `created_at`, `updated_at` | timestamptz | |

## companies e projects (existentes, alteradas)

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `default_execution_policy` | jsonb, nulo | Validado por `issueExecutionPolicySchema` |

## Spec do workflow (jsonb em `workflow_versions.spec`)

```text
spec
├── specVersion: 1
├── start: <stepKey>
└── steps[]
    ├── key, name
    ├── type: agent_task | human_task | approval_gate
    ├── owner: { kind: agent | user | role, ref }
    ├── inputs: [<stepKey>]
    ├── outcomes: [{ key, to: <stepKey> | "end" }]
    └── limits: { maxAttempts?, maxReviewRounds?, timeoutSec? }
```

## Transições e regras

- **Versão**: nasce publicada e imutável; a única mudança possível é publicar a seguinte.
- **Workflow**: `draft` → `active` → `archived`. Arquivar não apaga versões nem rotinas; rotinas apontando para um arquivado falham no disparo com motivo claro.
- **Estágio pendente**: reassign muda o participante ativo dentro da lista configurada; o contador de rodadas e o histórico de decisões não são reiniciados.
