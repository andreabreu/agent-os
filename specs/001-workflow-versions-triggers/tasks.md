---

description: "Task list for workflows versionados, política padrão e triggers por rotina"
---

# Tasks: Workflows versionados com política de execução padrão e triggers por rotina

**Input**: `specs/001-workflow-versions-triggers/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Prerequisites**: plan.md e spec.md

**Tests**: incluídos. O `AGENTS.md` e as regras globais pedem TDD com banco real; cada história começa com testes que falham. Pela regra `test-budget`, usar uma suíte de banco por módulo, sem sleeps acima de 1 s.

**Organization**: por história de usuário, para implementar e testar cada uma de forma independente.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência incompleta)
- **[Story]**: história de `spec.md` (US1 a US5)
- Todos os caminhos são relativos à raiz do repositório

## Path Conventions

Monorepo pnpm: `packages/db`, `packages/shared`, `server`. A UI não muda nesta fase. Arquivos novos sempre que possível; arquivos grandes (`server/src/services/issues.ts`, `server/src/services/routines.ts`, `server/src/routes/issues.ts`) recebem só chamadas de uma linha para limitar conflito ao puxar o upstream.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: flag experimental, base para todas as histórias que expõem rotas novas

- [X] T000 Preparar o ambiente: `node_modules` não existe no checkout; rodar `node scripts/agent-preflight.mjs` e `pnpm install`, e confirmar que `pnpm exec vitest run packages/shared/src/account-handle.test.ts` passa (comando de teste de arquivo único usado nas tarefas abaixo; alternativa `pnpm verify`)
- [X] T001 Adicionar a chave booleana `enableWorkflowVersions` (padrão `false`) a `instanceExperimentalSettingsSchema` em `packages/shared/src/validators/instance.ts` e a entrada correspondente em `INSTANCE_FEATURE_CATALOG` em `packages/shared/src/feature-catalog.ts` (`tier: "managed"`, `cloudDefault: false`, `selfHostedDefault: false`)
- [X] T002 Verificar se a página de settings experimentais lista o catálogo automaticamente e, se não, adicionar a entrada manual (procurar o consumo de `INSTANCE_FEATURE_CATALOG` em `ui/src/pages/`); registrar o resultado em `specs/001-workflow-versions-triggers/research.md` (item R3)
- [X] T003 Rodar os testes existentes do catálogo (`packages/shared/src/feature-catalog*.test.ts`, `packages/shared/src/connector-availability.test.ts`) e confirmar que a nova flag não quebra a regra "selfHostedDefault igual ao padrão do schema"

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: schema de banco e migração única, compartilhados por todas as histórias

**⚠️ CRITICAL**: nenhuma história começa antes de T009

- [X] T004 Em `packages/db/src/schema/workflows.ts`, acrescentar as colunas `status` (text, `draft` | `active` | `archived`, padrão `active`, validado por zod e sem `CHECK` no banco), `latest_version_id` (uuid, nulo) e `latest_version_number` (integer, padrão 0)
- [X] T005 [P] Criar `packages/db/src/schema/workflow_versions.ts` com `id` uuid PK, `company_id` FK `companies` (cascade), `workflow_id` FK `workflows` (cascade), `version` integer, `spec` jsonb, `spec_hash` text, `published_by_agent_id` uuid nulo (FK `agents`, set null), `published_by_user_id` text nulo, `created_at` timestamptz; índice único `(workflow_id, version)` e índice `(company_id, workflow_id, created_at)`
- [X] T006 [P] Criar `packages/db/src/schema/routine_workflow_targets.ts` com `routine_id` uuid PK FK `routines` (cascade), `company_id` FK `companies` (cascade), `workflow_id` FK `workflows` (restrict), `created_by_agent_id` uuid nulo, `created_by_user_id` text nulo, `created_at` e `updated_at` timestamptz
- [X] T007 [P] Acrescentar `default_execution_policy` (jsonb, nulo) em `packages/db/src/schema/companies.ts` e em `packages/db/src/schema/projects.ts`
- [X] T008 Exportar `workflowVersions` e `routineWorkflowTargets` em `packages/db/src/schema/index.ts`
- [X] T009 Rodar `pnpm db:generate` para gerar uma única migração (próximo número depois de `0505`), conferir que o SQL só adiciona colunas e tabelas, manter os cinco snapshots mais novos conforme `rules/database-migration-snapshots.mdc` e rodar o typecheck de `packages/db`

**Checkpoint**: banco pronto; histórias podem começar

---

## Phase 3: User Story 1 - Publicar e ler uma versão imutável de um workflow (Priority: P1) 🎯 MVP

**Goal**: publicar, listar e ler versões imutáveis de um workflow, por pessoa e por agente, com a flag respeitada.

**Independent Test**: publicar duas versões, ler de volta, tentar alterar e ver a recusa, e confirmar isolamento entre empresas (seção 1 do quickstart).

### Tests for User Story 1 (escrever primeiro e ver falhar)

- [X] T010 [P] [US1] Criar `server/src/__tests__/workflow-versions.integration.test.ts` com banco real cobrindo: primeira versão recebe `version: 1`; segunda recebe `2`; duas publicações simultâneas geram números distintos sem lacuna; nenhuma função de serviço faz `UPDATE` ou `DELETE` em `workflow_versions`; leitura por ator de outra empresa devolve `404`; flag `enableWorkflowVersions` desligada recusa rotas e leitura; workflow só-prompt sem versão continua sendo lido e adotado por Cases como hoje
- [X] T011 [P] [US1] Criar `packages/shared/src/workflow-spec.test.ts` com casos de parse do spec: `specVersion: 1`; tipos aceitos `agent_task`, `human_task`, `approval_gate`; recusa de `router`, `parallel`, `join`, `wait` com código `unsupported_step_type`

### Implementation for User Story 1

- [X] T012 [US1] Criar `packages/shared/src/workflow-spec.ts` com o schema zod do spec: `specVersion` literal 1, `start`, `steps[]` com `key`, `name`, `type`, `owner` (`kind`: agent | user | role, `ref`), `inputs[]`, `outcomes[]` (`key`, `to` etapa ou `"end"`) e `limits` (`maxAttempts`, `maxReviewRounds`, `timeoutSec`, todos opcionais e inteiros positivos); exportar em `packages/shared/src/index.ts`
- [X] T013 [US1] Em `packages/shared/src/workflows.ts`, acrescentar `publishWorkflowVersionSchema` (`{ spec }`, `.strict()`), `listWorkflowVersionsSchema` (`limit` 1 a 100 padrão 50, `offset` 0 a 100000) e `readWorkflowVersionQuerySchema` (`snapshot` opcional, 64 hex); exportar em `packages/shared/src/index.ts`
- [X] T014 [US1] Criar `server/src/services/workflow-versions.ts` com `requireWorkflowVersionsEnabled(db)` (exige `requireCasesEnabled` mais `enableWorkflowVersions`), `publish`, `list`, `read` e `archive`; `publish` roda em transação, incrementa `workflows.latest_version_number` com `UPDATE ... RETURNING`, grava `spec_hash` (SHA-256 do JSON canônico do spec), atualiza `latest_version_id` e usa `persistActivity` com a ação `workflow.version_published` (detalhes `version`, `specHash`); `archive` define `status = "archived"` e registra `workflow.archived`; usar `authorizeCaseCreation` para publicar e arquivar
- [X] T015 [US1] Criar `server/src/routes/workflow-versions.ts` com as quatro rotas de `contracts/workflow-versions.md` (`POST` e `GET /api/workflows/:id/versions`, `GET /api/workflows/:id/versions/:version` com `ETag`, `POST /api/workflows/:id/archive`), usando `assertCompanyAccess`, `validate()` e `notFound` como em `server/src/routes/workflows.ts`; montar em `server/src/app.ts` ao lado de `workflowRoutes(db)` (linha ~868)
- [X] T016 [P] [US1] (Feito pelas ferramentas genéricas `search_api` e `call_api` via OpenAPI; ver R8 em `research.md`) Em `server/src/services/native-runtime/native-workflow-tools.ts`, acrescentar `list_workflow_versions` e `read_workflow_version` (somente leitura, mesma paginação por `snapshot` de `read_workflow`, erro padrão quando a flag está desligada); registrar em `server/src/services/native-runtime/runner-api-catalog.ts` e `paperclip-runner-tool-authority.ts`, e regenerar com `node scripts/generate-semantic-contracts.mjs` e `node scripts/generate-semantic-action-catalog.mjs` (sem `--check`, dentro de `packages/paperclip-runner`) os arquivos `generated/semantic-action-catalog.json` e `generated/capability/semantic-tool-contracts.json`
- [X] T017 [P] [US1] Documentar as rotas novas em `server/src/routes/openapi.ts`
- [X] T018 [US1] Rodar `pnpm exec vitest run server/src/__tests__/workflow-versions.integration.test.ts packages/shared/src/workflow-spec.test.ts` na raiz; T010 e T011 devem passar

**Checkpoint**: US1 funcional e testável sozinha

---

## Phase 4: User Story 2 - Rejeitar definições inválidas antes de publicar (Priority: P1)

**Goal**: validação de grafo na publicação, com mensagens que nomeiam a etapa e o problema.

**Independent Test**: publicar specs inválidos e ver `422` por tipo de erro; publicar um ciclo limitado e ver aceito (seção 1, passos 3 do quickstart).

### Tests for User Story 2

- [ ] T019 [P] [US2] Criar `packages/shared/src/workflow-spec-graph.test.ts` (unitário puro, ao lado do validador) com um caso por código de erro de `contracts/workflow-versions.md`: `duplicate_step_key`, `start_not_found`, `unknown_destination`, `unreachable_step`, `no_path_to_end`, `unbounded_cycle`; mais aceitação de ciclo com `maxAttempts` em toda etapa do ciclo, de laço de uma etapa com limite e de etapa final que aponta para `end`
- [ ] T020 [US2] Acrescentar em `server/src/__tests__/workflow-versions.integration.test.ts` os casos de `422`: corpo `details.issues[]` traz `{ code, stepKey, outcomeKey?, message }`, nada é gravado em `workflow_versions` e o contador `latest_version_number` não avança

### Implementation for User Story 2

- [ ] T021 [US2] Em `packages/shared/src/workflow-spec.ts`, implementar `validateWorkflowGraph(spec)` puro: chaves únicas; `start` existe; todo destino existe ou é `end`; toda etapa é alcançável do início; existe caminho até `end`; toda etapa em ciclo (componente fortemente conexo com mais de um nó ou laço) exige `limits.maxAttempts`; retornar lista de problemas `{ code, stepKey, outcomeKey?, message }`
- [ ] T022 [US2] Em `server/src/services/workflow-versions.ts`, chamar `validateWorkflowGraph` dentro de `publish` antes de incrementar o contador e lançar `unprocessable` com `details.issues` (usar o helper de erro existente em `server/src/errors.ts`; criar apenas se não houver equivalente)
- [ ] T023 [US2] Rodar T019 e T020; ambos devem passar

**Checkpoint**: US1 e US2 completas; MVP entregável (versões válidas e imutáveis)

---

## Phase 5: User Story 3 - Garantir um gate por padrão em tarefas novas (Priority: P2)

**Goal**: política de execução padrão por empresa e projeto, aplicada em tarefas novas.

**Independent Test**: configurar a política, criar tarefas por pessoa e por agente e verificar precedência e exceções (seção 2 do quickstart).

### Tests for User Story 3

- [ ] T024 [P] [US3] Criar `server/src/__tests__/issue-default-execution-policy.test.ts` com banco real cobrindo: política do projeto vence a da empresa; só empresa; política declarada vence; tarefa de origem `routine_execution` e tarefa de conversa não recebem a padrão; sem nenhuma, comportamento atual; criação por pessoa e por agente; política inválida recusada ao salvar com `422`; limpar com `null`
- [ ] T025 [P] [US3] Ler o teste upstream `server/src/__tests__/project-default-execution-policy-read-authz.test.ts` da PR #15267 (`gh pr diff 15267 -R paperclipai/paperclip`) e registrar em `contracts/default-execution-policy.md` a regra de leitura do campo; escrever o teste equivalente em `server/src/__tests__/issue-default-execution-policy.test.ts`

### Implementation for User Story 3

- [ ] T026 [P] [US3] Acrescentar `defaultExecutionPolicy` (`issueExecutionPolicySchema.nullable().optional()`) em `packages/shared/src/validators/company.ts` e `packages/shared/src/validators/project.ts`, e o campo nos tipos de `packages/shared/src/types/company.ts` e `packages/shared/src/types/project.ts`; exportar em `packages/shared/src/index.ts` e `packages/shared/src/validators/index.ts`
- [ ] T027 [US3] Criar `server/src/services/issue-default-execution-policy.ts` com `resolveDefaultIssueExecutionPolicy(db, { companyId, projectId, originKind, isConversation })` aplicando a ordem declarada, projeto, empresa, nenhuma, e as exceções de `routine_execution` e conversa
- [ ] T028 [US3] Persistir `defaultExecutionPolicy` em `server/src/services/companies.ts` e `server/src/services/projects.ts` e aceitar o campo nos `PATCH` de `server/src/routes/companies.ts` e `server/src/routes/projects.ts`, registrando `company.default_execution_policy_updated` e `project.default_execution_policy_updated` no activity log e aplicando a regra de leitura de T025
- [ ] T029 [US3] Em `server/src/services/issues.ts`, na criação de tarefa (antes de `normalizeIssueExecutionPolicy`), acrescentar uma única chamada a `resolveDefaultIssueExecutionPolicy` quando `executionPolicy` não vier declarada; conferir os demais pontos de criação (tarefa filha e criação por agente) listados no diff upstream de #15267
- [ ] T030 [P] [US3] Acrescentar `defaultExecutionPolicy` aos tipos e funções de atualização de `ui/src/api/companies.ts` e `ui/src/api/projects.ts` (cliente de API, sem tela), conforme a regra de contratos sincronizados do `AGENTS.md` (seção 5.2); o diff de #15267 em `ui/src/api/companies.ts` é a referência
- [ ] T031 [P] [US3] Documentar `defaultExecutionPolicy` em `server/src/routes/openapi.ts`
- [ ] T032 [US3] Rodar T024 e T025; rodar também os testes existentes de política (`server/src/__tests__/issue-execution-policy*.test.ts`) para confirmar que não há regressão

**Checkpoint**: US3 funcional, independente de US1 e US2

---

## Phase 6: User Story 4 - Passar um estágio pendente a outro participante configurado (Priority: P2)

**Goal**: reassign de estágio de revisão ou aprovação pendente.

**Independent Test**: tarefa com estágio de dois participantes, reassign, histórico e recusas (seção 3 do quickstart).

### Tests for User Story 4

- [ ] T033 [P] [US4] Criar `server/src/__tests__/issue-stage-reassign.test.ts` com banco real cobrindo: participante ativo reatribui ao segundo; ator com permissão de gestão reatribui; participante fora do estágio `422`; estágio concluído ou sem política `409`; ator sem permissão `403`; tarefa de outra empresa `404`; mesmo participante é no-op sem erro; `lastReassignment` gravado; contador de rodadas e histórico de decisões intactos; ação `issue.execution_policy_reassigned` no activity log
- [ ] T034 [P] [US4] Reproduzir no fork os bugs de estágio do upstream #21546, #21575, #21639, #19237 e #4912; registrar em `specs/001-workflow-versions-triggers/research.md` (nova seção R7b) quais se reproduzem e abrir um item separado para cada um que se reproduza, sem corrigi-los nesta spec

### Implementation for User Story 4

- [ ] T035 [P] [US4] Em `packages/shared/src/validators/issue.ts`, acrescentar `reassignIssueExecutionStageSchema` (`{ toParticipant: issueExecutionStagePrincipalSchema, comment?: multilineTextSchema.pipe(z.string().trim().min(1)) }`, `.strict()`) e `issueExecutionReassignmentSchema`, mais o campo `lastReassignment` (anulável, padrão `null`) no estado de execução; tipos em `packages/shared/src/types/issue.ts`; exportar em `packages/shared/src/index.ts`
- [ ] T036 [US4] Criar `server/src/services/issue-execution-stage-reassign.ts` com `reassignPendingStage` (valida estágio pendente, participante configurado no estágio, autoridade do ator (participante ativo, ou ator autorizado por `access.decide` como no `tasks:assign` de `server/src/routes/issues.ts`; confirmar a ação exata no diff de #15265 e registrá-la em `contracts/stage-reassign.md`); mesmo participante devolve sem mudança; grava `lastReassignment`; não reinicia contador de rodadas); reusar `parseIssueExecutionState` e os tipos de `server/src/services/issue-execution-policy.ts` sem alterá-los além do necessário
- [ ] T037 [US4] Criar `server/src/routes/issue-stage-reassign.ts` com `POST /api/issues/:id/execution-policy/reassign` conforme `contracts/stage-reassign.md` e montar em `server/src/app.ts`; registrar `issue.execution_policy_reassigned` e acordar o novo participante pelo caminho de wake existente
- [ ] T038 [P] [US4] Documentar a rota em `server/src/routes/openapi.ts`
- [ ] T039 [US4] Rodar T033 e os testes existentes `server/src/__tests__/issue-execution-policy*.test.ts`

**Checkpoint**: US4 funcional, independente das demais

---

## Phase 7: User Story 5 - Iniciar um workflow por tempo ou por chamada (Priority: P3)

**Goal**: rotina com alvo em workflow, disparando por `schedule`, `webhook` e `api`, sem motor de gatilho novo.

**Independent Test**: seção 4 do quickstart. Depende de US1 (versões publicadas).

### Tests for User Story 5

- [ ] T040 [P] [US5] Criar `server/src/__tests__/routine-workflow-target.integration.test.ts` com banco real cobrindo: definir, ler e remover o alvo; alvo de outra empresa `404`; definir alvo arquivado recusado; disparo manual e de webhook cria uma tarefa com referência ao workflow e à versão e grava `workflowVersionId` e `workflowVersion` em `routine_runs.trigger_payload`; entrega de webhook repetida cria uma única tarefa; workflow sem versão publicada deixa o run falho com `failure_reason` e sem tarefa; workflow arquivado idem; rotina sem alvo mantém o comportamento atual; gatilho `heartbeat` não é afetado; flag desligada recusa as rotas

### Implementation for User Story 5

- [ ] T041 [US5] Criar `server/src/services/workflow-routine-targets.ts` com `setTarget`, `getTarget`, `removeTarget` (company-scoped, `requireWorkflowVersionsEnabled`, activity `routine.workflow_target_set` e `routine.workflow_target_removed`) e `resolveWorkflowForDispatch(db, routine)` que devolve `null` sem alvo ou `{ workflowId, versionId, version, name }` e lança erro tipado quando não há versão publicada ou o workflow está arquivado
- [ ] T042 [US5] Criar `server/src/routes/routine-workflow-target.ts` com `PUT`, `GET` e `DELETE /api/routines/:id/workflow-target` conforme `contracts/routine-workflow-target.md` e montar em `server/src/app.ts`
- [ ] T043 [US5] Em `server/src/services/routines.ts`, dentro de `dispatchRoutineRun` e antes da criação da tarefa (perto da linha 2015), chamar `resolveWorkflowForDispatch`; com resultado, acrescentar a referência ao workflow e à versão na `description`, mesclar `workflowVersionId` e `workflowVersion` em `trigger_payload` e registrar a versão no activity log; em erro, marcar o run como falho pelo mecanismo existente de `failure_reason` sem criar tarefa; confirmar primeiro o ponto exato de falha no código (item R5 de `research.md`)
- [ ] T044 [P] [US5] Documentar as rotas em `server/src/routes/openapi.ts`
- [ ] T045 [US5] Rodar T040 e os testes existentes de rotinas (`server/src/__tests__/routines*.test.ts`) para confirmar que o comportamento sem alvo não muda

**Checkpoint**: todas as histórias funcionais

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T046 [P] Escrever `doc/workflow-versions.md` com o comportamento do subsistema (versões imutáveis, validação de grafo, política padrão, reassign, alvo de rotina, limitação de revisões de rotina, flag) e linkar em "More documentation" de `doc/DEVELOPING.md`
- [ ] T047 [P] Conferir que nenhum arquivo novo passa de 1.000 linhas e que os acréscimos em `server/src/services/issues.ts`, `server/src/services/routines.ts` e `server/src/app.ts` são pontos de extensão curtos (regra `pull-request-review`)
- [ ] T048 Rodar `pnpm -r typecheck` (ou `node scripts/typecheck-low-memory.mjs`) e `pnpm verify`; se `pnpm verify` sair com código 2, rodar os checks focados e registrar o que ficou para o CI, sem `--full` automático
- [ ] T049 Executar o quickstart (`specs/001-workflow-versions-triggers/quickstart.md`) de ponta a ponta numa instância de dev com as duas flags ligadas e registrar o resultado
- [ ] T050 Atualizar `doc/plans/2026-11-24-agent-workflows-hitl.md` marcando a fase 1 como especificada e linkando `specs/001-workflow-versions-triggers/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências
- **Foundational (Phase 2)**: depende de Setup; bloqueia todas as histórias
- **US1 (Phase 3)** e **US2 (Phase 4)**: dependem do Foundational; US2 estende `workflow-spec.ts` e `workflow-versions.ts` de US1, então vem depois
- **US3 (Phase 5)** e **US4 (Phase 6)**: dependem só do Foundational (US3) ou de nada além do código existente (US4); independentes de US1 e US2
- **US5 (Phase 7)**: depende de US1 (versões) e do Foundational
- **Polish (Phase 8)**: depende das histórias desejadas

### User Story Dependencies

- **US1 → US2 → US5**: cadeia de versões, validação e disparo
- **US3** e **US4**: independentes entre si e das demais

### Within Each User Story

- Testes primeiro e vendo falhar, depois schema compartilhado, serviço, rota, ponto de extensão e OpenAPI
- `[P]` só entre arquivos diferentes

### Parallel Opportunities

- Foundational: T005, T006 e T007 em paralelo
- Depois do Foundational: US1, US3 e US4 podem andar em paralelo por pessoas ou agentes diferentes
- Dentro das histórias: os testes `[P]` e os arquivos OpenAPI `[P]`

---

## Parallel Example: User Story 1

```text
Task: "Criar server/src/__tests__/workflow-versions.integration.test.ts (T010)"
Task: "Criar packages/shared/src/workflow-spec.test.ts (T011)"
Task: "Registrar ferramentas nativas em native-workflow-tools.ts (T016)"
Task: "Documentar rotas em openapi.ts (T017)"
```

---

## Implementation Strategy

### MVP First (US1 e US2)

1. Setup e Foundational
2. US1 e US2: versões imutáveis e validadas
3. **Parar e validar** pelo quickstart seção 1; é o menor incremento útil

### Incremental Delivery

1. MVP (US1 + US2)
2. US3: gate por padrão (valor imediato, independente)
3. US4: reassign de estágio
4. US5: triggers por rotina
5. Cada incremento é um PR revisável atrás da flag, com `pnpm verify` e CI

### Notas

- Commits pequenos, Conventional Commits, um por tarefa ou grupo coeso
- Verificar que cada teste falha antes da implementação
- Evidências de verificação expiram após edições; reexecutar os checks afetados antes de cada PR
