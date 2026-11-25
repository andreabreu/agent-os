# Implementation Plan: Workflows versionados com política de execução padrão e triggers por rotina

**Branch**: `feat/workflows-hitl` | **Date**: 2026-11-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-workflow-versions-triggers/spec.md`

## Summary

Cinco entregas independentes sobre módulos existentes, todas atrás de uma flag experimental que depende de `enableCases`:

1. **Versões de workflow**: tabela `workflow_versions` imutável, spec validado por zod em `packages/shared`, validador de grafo puro, REST de publicar, listar e ler, e duas ferramentas nativas somente de leitura.
2. **Política de execução padrão** por empresa e projeto, resolvida na criação da tarefa por um módulo novo.
3. **Reassign de estágio pendente**, com a lógica num módulo novo e a rota num roteador novo.
4. **Alvo de workflow numa rotina**, por tabela lateral `routine_workflow_targets`, sem tocar a tabela `routines` nem o snapshot estrito de revisões.
5. **Disparo**: `dispatchRoutineRun` ganha um único ponto de extensão que resolve a versão mais recente e registra a referência. Nenhum motor de gatilho novo.

Abordagem de merge (só fork): tudo entra em arquivos novos. Os arquivos gigantes (`routes/issues.ts` com 20.832 linhas, `services/issues.ts` com 15.044, `services/routines.ts` com 3.714) recebem só chamadas de uma linha.

## Technical Context

**Language/Version**: TypeScript (Node, ESM, imports com extensão `.js`), monorepo pnpm

**Primary Dependencies**: Express, Drizzle ORM, zod, Vitest, embedded Postgres para testes de banco

**Storage**: PostgreSQL via `packages/db`; uma migração gerada por `pnpm db:generate`

**Testing**: Vitest com banco real; `pnpm verify` para a seleção afetada

**Target Platform**: servidor Paperclip (self-hosted e fork)

**Project Type**: web-service em monorepo (`db`, `shared`, `server`; `ui` fora de escopo)

**Performance Goals**: publicar e ler versão em uma transação curta; sem polling novo

**Constraints**: company-scoped em toda rota e serviço; mutações no activity log; sem worker novo (regra `sleep-aware-background-work`); sem política de Cloud no Core; arquivo novo abaixo de 1.000 linhas

**Scale/Scope**: dezenas de workflows por empresa, dezenas de versões cada; specs de até algumas dezenas de etapas

## Constitution Check

`.specify/memory/constitution.md` ainda é o modelo vazio, então os gates vêm de `AGENTS.md` e `rules/*.mdc` aplicáveis:

| Regra | Como o plano cumpre | Status |
| --- | --- | --- |
| Company scope (`AGENTS.md` 5.1) | Toda tabela nova tem `company_id` e FK; toda rota usa `assertCompanyAccess`; tabela lateral também carrega `company_id` | Passa |
| Contratos sincronizados (5.2) | db, shared, server e cliente de API; UI não muda nesta fase, e isso é declarado | Passa, com lacuna declarada na UI |
| `module-boundaries` | Lógica de versões, alvo de rotina, política padrão e reassign em módulos próprios; rotinas só expõem um ponto de extensão | Passa |
| `api-route-expectations` | Acesso, permissão, activity log e erros HTTP consistentes (`conflict`, `notFound`, `badRequest`) | Passa |
| `database-migration-snapshots` | Uma migração gerada; manter os cinco snapshots mais novos | Passa |
| `test-budget` | Uma suíte de banco por módulo, sem sleeps; sem suítes mínimas de Postgres embutido | Passa |
| `sleep-aware-background-work` | Nenhum timer, polling ou worker novo; disparo reaproveita o scheduler de rotinas | Passa |
| `pull-request-review` | Arquivos novos pequenos; justificar qualquer crescimento acima de 1.000 linhas nos arquivos existentes | Passa |
| Deployment policy fora do Core (5.5) | Sem allowlist ou padrão de provedor; só flag genérica | Passa |
| Invariantes de controle (5.3) | Nenhuma mudança em assignee único, checkout atômico, orçamento; gates de aprovação são ampliados, não enfraquecidos | Passa |

Reavaliação após o desenho (Fase 1): sem violações; nenhuma entrada em Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/001-workflow-versions-triggers/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── workflow-versions.md
│   ├── default-execution-policy.md
│   ├── stage-reassign.md
│   └── routine-workflow-target.md
└── tasks.md             # gerado por /speckit-tasks
```

### Source Code (repository root)

```text
packages/db/src/schema/
├── workflows.ts                      # + key, status, latest_version_id, latest_version_number
├── workflow_versions.ts              # novo
├── routine_workflow_targets.ts       # novo
├── companies.ts                      # + default_execution_policy
├── projects.ts                       # + default_execution_policy
└── index.ts                          # exports

packages/shared/src/
├── workflow-spec.ts                  # novo: schema do spec e validateWorkflowGraph (puro)
├── workflow-spec-graph.test.ts       # novo: unitário do validador
├── workflows.ts                      # + schemas de publicar/listar/ler versão
├── validators/{company,project}.ts   # + defaultExecutionPolicy
├── validators/issue.ts               # + schema de reassign
├── validators/instance.ts            # + enableWorkflowVersions
└── feature-catalog.ts                # + entrada da flag

server/src/services/
├── workflow-versions.ts              # novo: publicar, listar, ler, arquivar
├── workflow-routine-targets.ts       # novo: definir, ler, remover, resolver no disparo
├── issue-default-execution-policy.ts # novo: resolução e exceções (rotina, conversa)
├── issue-execution-stage-reassign.ts # novo: regras puras e aplicação
├── native-runtime/native-workflow-tools.ts  # + list_workflow_versions, read_workflow_version
├── routines.ts                       # + chamada em dispatchRoutineRun (ponto de extensão)
└── issues.ts                         # + chamada na criação de tarefa (ponto de extensão)

server/src/routes/
├── workflow-versions.ts              # novo
├── routine-workflow-target.ts        # novo
├── issue-stage-reassign.ts           # novo
├── companies.ts, projects.ts         # + defaultExecutionPolicy no PATCH

ui/src/api/
└── companies.ts, projects.ts         # + tipo defaultExecutionPolicy (sem tela)
└── openapi.ts                        # + novas rotas

server/src/__tests__/
├── workflow-versions.integration.test.ts     # banco real
├── issue-default-execution-policy.test.ts    # banco real
├── issue-stage-reassign.test.ts              # banco real
└── routine-workflow-target.integration.test.ts

doc/workflow-versions.md              # novo: comportamento do subsistema
```

**Structure Decision**: monorepo existente, sem projeto novo. Cada capacidade tem serviço e rota próprios; os pontos de extensão em `issues.ts` e `routines.ts` são de uma linha cada, para limitar conflito ao puxar o upstream.

## Complexity Tracking

Sem violações a justificar.
