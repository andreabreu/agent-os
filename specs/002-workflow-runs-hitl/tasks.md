---

description: "Task list para execução de workflows com gates humanos (HITL)"
---

# Tasks: Execução de workflows com gates humanos (HITL)

**Input**: `specs/002-workflow-runs-hitl/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Prerequisites**: spec 001 implementada (versões, validação de grafo, política padrão, reassign, alvo de rotina) e plan.md

**Tests**: incluídos (TDD com banco real, `AGENTS.md`). Pela regra `test-budget`: uma suíte de banco por módulo, relógio injetado, sem sleeps acima de 1 s.

**Organization**: por história de usuário. Cada história indica o PR de entrega (2a, 2b ou 2c, ver `plan.md`). Os spikes S1 a S5 são a primeira tarefa da história que os usa e registram a resposta em `research.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: paralelizável (arquivos diferentes, sem dependência incompleta)
- **[Story]**: US1 a US10, conforme `spec.md`
- Caminhos relativos à raiz do repositório

## Path Conventions

Monorepo pnpm: `packages/db`, `packages/shared`, `server`. Sem UI nesta fase. Arquivos novos sempre que possível; `case-handoffs.ts`, `decisions.ts`, `routines.ts`, `budgets.ts` e `server/src/index.ts` recebem só pontos de extensão curtos, justificados na tabela do `plan.md`.

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Confirmar que a spec 001 está implementada nesta branch: existência de `workflow_versions`, `validateWorkflowGraph`, flag `enableWorkflowVersions` e `routine_workflow_targets`; se faltar algo, parar e implementar a spec 001 antes. Garantir `node_modules` (`node scripts/agent-preflight.mjs`, `pnpm install`) e o comando `pnpm exec vitest run <arquivo>`
- [X] T002 [P] Em `packages/shared/src/workflow-spec.test.ts`, escrever testes (falhando) para os campos novos de etapa: `outputs`, `externalEffect`, `timeoutSec` (60 a 2.592.000), `reminderAfterSec`, `commentRequiredOn`, `questions` (1 a 20, `kind` em `text`, `single_choice`, `multi_choice`, `number`, `date`) e os tipos `human_task`, `approval_gate`, `input_form`; versão `specVersion: 1` já publicada continua válida
- [X] T003 Estender `packages/shared/src/workflow-spec.ts` com os campos e tipos de etapa de `contracts/workflow-step-spec.md`, de forma aditiva e opcional

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: regras de grafo, esquema de banco e núcleo puro do run

**⚠️ CRITICAL**: nenhuma história começa antes de T013

- [X] T004 [P] Em `packages/shared/src/workflow-spec-graph.test.ts`, escrever testes (falhando) para os códigos novos de `contracts/workflow-step-spec.md`: `external_effect_without_gate`, `gate_without_agent_origin`, `timeout_out_of_range`, `form_without_questions`, `output_key_conflict`, mais aceitação de casos válidos
- [X] T005 Implementar as cinco regras novas em `validateWorkflowGraph` (`packages/shared/src/workflow-spec.ts`) e a função `isExecutableWorkflowSpec(spec)` (só tipos suportados e regras cumpridas)
- [X] T006 [P] Criar `packages/db/src/schema/workflow_runs.ts` conforme `data-model.md`: colunas, `status` nos seis valores, `state_version` inteiro padrão 1, índice único parcial `(case_id)` onde `status IN ('running','waiting_human','paused')`, índices `(company_id, status)` e `(company_id, workflow_id, created_at)`
- [X] T007 [P] Criar `packages/db/src/schema/workflow_run_steps.ts` conforme `data-model.md`: `status` nos dez valores, `attempt` inteiro, `output_revision_ids` jsonb, índice único `(run_id, step_key, attempt)`, índices parciais em `decision_id` e `interaction_id`
- [X] T008 [P] Criar `packages/db/src/schema/workflow_run_events.ts` conforme `data-model.md` com índice único `(run_id, event_key)` e `kind` nos quinze valores listados
- [X] T009 Exportar as três tabelas em `packages/db/src/schema/index.ts` e rodar `pnpm db:generate` gerando uma migração (próximo número disponível), mantendo os cinco snapshots mais novos conforme `rules/database-migration-snapshots.mdc`; rodar o typecheck de `packages/db`
- [X] T010 [P] Criar `packages/shared/src/workflow-runs.ts` com constantes e tipos de estados do run e da etapa, tipos dos eventos, schemas zod de API de `contracts/workflow-runs.md` (`startWorkflowRunSchema`, `completeWorkflowStepSchema`, `submitWorkflowFormSchema`, `cancelWorkflowRunSchema`, `listWorkflowRunsSchema`) e o código de erro permanente `workflow_run_state_unsupported`; exportar em `packages/shared/src/index.ts`
- [X] T011 [P] Criar `packages/shared/src/workflow-run-transitions.test.ts` com testes (falhando) das transições puras: etapa `pending` até `completed`, devolução fecha a tentativa e abre a seguinte do destino com `attempt + 1`, estouro de `maxReviewRounds` e de `maxAttempts` leva a `waiting_human`, run `running` ⇄ `paused`, qualquer ativo para `cancelled`, estado inválido recusado
- [X] T012 (Implementado como `planStepOutcome`, `canTransitionRun` e `isRunActive`) Criar `packages/shared/src/workflow-run-transitions.ts` com as funções puras `nextStepsFor(spec, stepKey, outcome)`, `applyOutcome(run, step, outcome)` e `isRunActive(status)`; T011 deve passar
- [X] T013 Rodar `pnpm exec vitest run packages/shared/src/workflow-spec.test.ts packages/shared/src/workflow-spec-graph.test.ts packages/shared/src/workflow-run-transitions.test.ts` e o typecheck de `packages/shared`; tudo verde

**Checkpoint**: base pronta

---

## Phase 3: User Story 1 - Rodar um workflow só com etapas de agente (Priority: P1) 🎯 MVP — PR 2a

**Goal**: iniciar, andar e concluir um run só com etapas de agente, com saídas exigidas, versão fixa e um run ativo por case.

**Independent Test**: seção "PR 2a" do `quickstart.md`.

### Tests for User Story 1

- [X] T014 [P] [US1] Criar `server/src/__tests__/workflow-runs-advance.integration.test.ts` (banco real) cobrindo: iniciar run em case sem run ativo; segundo run no mesmo case recusado com `409`; novo run depois de concluir aceito; versão fixa quando uma versão nova é publicada; `422` com `missing_outputs` ao concluir sem as saídas; conclusão passa o case ao dono da próxima etapa por handoff em nome do agente que concluiu e a próxima recebe referências às entradas declaradas; `handoff_case` livre num case com run ativo recusado; run conclui na última etapa; avanço repetido com o mesmo `event_key` não muda o estado; `state_version` desconhecido devolve `workflow_run_state_unsupported`; flag desligada recusa rotas e ferramentas; tentativa de outra empresa `404`

### Implementation for User Story 1

- [X] T015 [US1] Criar `server/src/services/workflow-runs.ts` com `startRun`, `readRun`, `listRuns` (company-scoped, `requireWorkflowVersionsEnabled`, `isExecutableWorkflowSpec`, responsável = quem iniciou, versão fixa, verificação de `state_version`, activity `workflow_run.started`)
- [X] T016 [US1] Criar `server/src/services/workflow-run-advance.ts` com `advance(runId, eventKey)`: transação que grava o evento com a chave única, aplica `applyOutcome`, grava `output_revision_ids` da tentativa, e para a próxima etapa de agente chama `caseHandoffService` em nome do agente que concluiu (`phase` = chave da etapa, `toAgentId` = dono, instruções geradas a partir da definição com referências às entradas, chave de idempotência derivada do evento, e um marcador interno de origem `initiatedBy: "workflow_run"` com o `runId`, que só o serviço do motor consegue definir e que o ponto de extensão do T017 usa para deixá-lo passar); conclui o run na última etapa; registra activity `workflow_run.step_completed` e `workflow_run.completed`
- [X] T017 [US1] (Só a recusa; ver R1b) Em `server/src/services/case-handoffs.ts`, acrescentar um ponto de extensão curto antes de gravar o handoff: se o case tem run ativo e o handoff não traz o marcador interno `initiatedBy: "workflow_run"` do T016 com o `runId` do run ativo, recusar com mensagem que aponta para `complete_workflow_step`; e uma notificação depois de aplicado para o motor marcar a etapa como `running`; justificar a mudança fora do módulo dono na descrição da PR
- [X] T018 [US1] Criar `server/src/routes/workflow-runs.ts` com `POST /api/companies/:companyId/workflow-runs`, `GET /api/workflow-runs/:id`, `GET /api/companies/:companyId/workflow-runs` e `POST /api/workflow-runs/:id/steps/:stepKey/complete`, conforme `contracts/workflow-runs.md` (`assertCompanyAccess`, `validate()`, erros `404`/`403`/`409`/`422`); montar em `server/src/app.ts`
- [X] T019 [P] [US1] (Feito pelas ferramentas genéricas `search_api`/`call_api` via OpenAPI; ver R1b) Criar `server/src/services/native-runtime/native-workflow-run-tools.ts` com `read_workflow_run`, `start_workflow_run` e `complete_workflow_step` conforme `contracts/native-tools.md`; registrar em `runner-api-catalog.ts` e `paperclip-runner-tool-authority.ts` e regenerar com `node scripts/generate-semantic-contracts.mjs` e `node scripts/generate-semantic-action-catalog.mjs` (dentro de `packages/paperclip-runner`, sem `--check`)
- [X] T020 [P] [US1] Documentar as rotas em `server/src/routes/openapi.ts`
- [X] T021 [US1] Rodar `pnpm exec vitest run server/src/__tests__/workflow-runs-advance.integration.test.ts` e os testes existentes de handoffs (`server/src/services/case-handoffs.test.ts`); tudo verde

**Checkpoint**: US1 funcional e testável sozinha (PR 2a)

---

## Phase 4: User Story 2 - Aprovar ou rejeitar num gate humano (Priority: P1) — PR 2b

**Goal**: gate como decisão na fila com uma opção por outcome, decidido por pessoa autorizada.

**Independent Test**: seção "PR 2b" do `quickstart.md`, passos 1 e 2.

### Tests for User Story 2

- [X] T022 [P] [US2] Criar `server/src/__tests__/workflow-runs-gates.integration.test.ts` (banco real) cobrindo: o gate cria uma decisão com uma opção por outcome e o run vai a `waiting_human`; decisor sem autoridade recusado; usuário ou papel declarado e ator de gestão aceitos; comentário exigido nas opções de devolução e rejeição e dispensado ao aprovar; aprovar avança e acorda o agente seguinte; cancelar o run cancela a decisão; decisão resolvida duas vezes em paralelo vale uma vez; expiração sem `timeoutSec` reabre uma decisão nova sem aprovar nem rejeitar; expiração com `timeoutSec` leva o run a `waiting_human` e avisa o responsável; a decisão do gate aparece na listagem da fila de decisões em até 5 s após a etapa chegar a ele (SC-009)

### Implementation for User Story 2

- [X] T023 [US2] Spike S2: confirmar em `server/src/services/decisions.ts` os requisitos de criação (`agentId`, `runId`, TTL máximo de 30 dias) e que o último agente que segurou o case pode ser a origem, inclusive com uma run já encerrada (caso do gate depois de etapa humana); registrar a resposta em `specs/002-workflow-runs-hitl/research.md` (R2) e, se negativa, aplicar o fallback do `plan.md`
- [X] T024 [US2] Spike S3: acrescentar `requiredInputIds` opcional a `decisionOptionSchema` em `packages/shared/src/validators/decision.ts` e validar em `server/src/services/decisions.ts` quando a decisão é resolvida (input exigido por opção); teste em `server/src/__tests__/decisions-service.test.ts`; justificar a mudança fora do módulo dono
- [X] T025 [US2] Criar `server/src/services/workflow-run-boundaries.ts` com `openGate(tx, run, step, originAgent, originRun)`: cria a decisão (`continuationPolicy = none`, origem = último agente que segurou o case, TTL = `timeoutSec` ou 30 dias, opções = outcomes, input `comment`, `requiredInputIds` conforme `commentRequiredOn`), grava `decision_id` na etapa, registra `gate_opened` e deixa o run em `waiting_human`
- [X] T026 [US2] Em `server/src/services/decisions.ts`, acrescentar a notificação ao resolver, expirar ou cancelar uma decisão vinculada a um run, chamando `advance(runId, "decision:<id>")`; ponto de extensão curto
- [X] T027 [US2] Em `server/src/services/decisions.ts`, restringir quem pode resolver a decisão de um gate: o `openGate` grava nos metadados da decisão a lista de decisores da etapa (usuários e papéis declarados); ao resolver, aceitar só quem está na lista ou tem permissão de gestão da empresa e recusar os demais com `403`; ponto de extensão curto, justificado na PR como mudança fora do módulo dono (FR-011)
- [X] T028 [US2] Em `server/src/services/workflow-run-advance.ts`, tratar o resultado do gate: opção escolhida segue o destino declarado; expiração sem `timeoutSec` reabre o gate; expiração com `timeoutSec` escala a `waiting_human` com motivo; cancelamento fecha a etapa; activity `workflow_run.gate_decided` e `workflow_run.escalated`
- [X] T029 [US2] Rodar T022 e os testes existentes de decisões (`server/src/__tests__/decisions-service.test.ts`); tudo verde

**Checkpoint**: US2 funcional sobre US1

---

## Phase 5: User Story 3 - Devolver o trabalho e escalar ao estourar rodadas (Priority: P1) — PR 2b

**Goal**: devolução com limite de rodadas, escalonamento e etapa humana.

**Independent Test**: seção "PR 2b" do `quickstart.md`, passos 2 e 3.

### Tests for User Story 3

- [ ] T030 [P] [US3] Acrescentar em `server/src/__tests__/workflow-runs-gates.integration.test.ts` os casos: "pedir mudanças" com comentário reabre a etapa de destino com `attempt + 1` atribuída ao seu dono, que recebe o comentário; ao atingir `maxReviewRounds` o run vai a `waiting_human` com motivo e o responsável é avisado, sem voltar sozinho; outcome com destino `end` encerra o run; etapa humana atribui a tarefa à pessoa declarada e, ao concluir com as saídas, o run segue; usuário removido na etapa humana leva a `waiting_human`

### Implementation for User Story 3

- [ ] T031 [US3] Spike S1: confirmar como o servidor reatribui a tarefa do case a um usuário sem passar pelo handoff (precedente: `applyIssueExecutionPolicyTransition` em `server/src/services/issue-execution-policy.ts`) e qual autoridade exige; registrar em `research.md` (R4) e, se não houver caminho limpo, propor a extensão do destino do handoff antes de seguir
- [ ] T032 [US3] Em `server/src/services/workflow-run-boundaries.ts`, implementar `assignHumanStep` (reatribui a tarefa do case à pessoa ou papel, `status = awaiting_review`, run `waiting_human`) e a conclusão da etapa humana pela mesma rota `complete`; se o usuário declarado não existe ou não pertence mais à empresa, o run vai a `waiting_human` com o motivo
- [ ] T033 [US3] Em `server/src/services/workflow-run-advance.ts`, implementar a devolução: fechar a tentativa como `changes_requested`, abrir a do destino com `attempt + 1`, repassar o comentário nas instruções do agente de destino, escalar ao exceder `maxReviewRounds` e encerrar quando o destino é `end`
- [ ] T034 [US3] Rodar T022 e T030; tudo verde

**Checkpoint**: US1 a US3 entregam o fluxo HITL sequencial

---

## Phase 6: User Story 4 - Falhas, orçamento, cancelamento e reinício (Priority: P2) — PR 2b

**Goal**: controle e resiliência do run.

**Independent Test**: seção "PR 2b" do `quickstart.md`, passos 5 e 6.

### Tests for User Story 4

- [ ] T035 [P] [US4] Criar `server/src/__tests__/workflow-runs-control.integration.test.ts` (banco real, relógio injetado) cobrindo: falha de agente repete até `maxAttempts` e depois `waiting_human` com o motivo; orçamento estourado pausa o run e a retomada continua sem repetir a etapa; cancelar por responsável ou gestão cancela decisões e perguntas abertas e mantém a tarefa do case; cancelar por outro ator recusado; reinício simulado com decisão resolvida e avanço pendente produz um único avanço; evento repetido é idempotente; agente dono removido leva a `waiting_human`; flag desligada preserva runs ativos sem avançar

### Implementation for User Story 4

- [ ] T036 [US4] Spike S4: ler `server/src/services/decision-expiry-work.ts` e `decision-effect-recovery-work.ts` e registrar em `research.md` (R6) como prazos e recuperação são registrados sem polling; usar o mesmo padrão nas tarefas seguintes
- [ ] T037 [US4] Spike S5: localizar em `server/src/services/budgets.ts` o ponto em que a pausa e a retomada por orçamento são publicadas e registrar em `research.md` (R8); localizar em `server/src/services/heartbeat-run-events.ts` o evento de falha de run que o motor deve consumir
- [ ] T038 [US4] Em `server/src/services/workflow-run-advance.ts`, implementar a falha de agente: consumir o evento de falha, repetir a etapa até `maxAttempts` e depois escalar a `waiting_human`; se o agente dono da etapa foi removido ou arquivado, escalar direto a `waiting_human` com o motivo, sem tentar de novo
- [ ] T039 [US4] Em `server/src/services/budgets.ts`, acrescentar a notificação curta ao pausar e retomar um escopo por orçamento; em `workflow-run-advance.ts`, pausar o run inteiro ao receber a pausa e retomar do ponto onde parou sem repetir a etapa
- [ ] T040 [US4] Em `server/src/services/workflow-runs.ts` e `server/src/routes/workflow-runs.ts`, implementar `cancelRun` e `resumeRun` (`POST /api/workflow-runs/:id/cancel` e `/resume`, só responsável ou gestão), cancelando decisões e perguntas abertas e mantendo a tarefa do case; activity `workflow_run.cancelled`, `workflow_run.paused` e `workflow_run.resumed`
- [ ] T041 [US4] Criar `server/src/services/workflow-run-work.ts` com o passe de recuperação (reexecuta `advance` de runs cujo último evento não foi consumido, limitado em lote) e o registro dos prazos de gate pelo mecanismo do T036; registrar em `server/src/index.ts` no padrão `register*Work`; sem timer nem polling novo
- [ ] T042 [US4] Rodar T035 e `pnpm exec vitest run server/src/__tests__/budgets*.test.ts`; tudo verde

**Checkpoint**: US4 completa; fecha o PR 2b junto com US7

---

## Phase 7: User Story 7 - Coletar dados de uma pessoa antes de seguir (Priority: P2) — PR 2b

**Goal**: etapa de formulário que espera respostas e as grava como documento do case.

**Independent Test**: seção "PR 2b" do `quickstart.md`, passo 4.

### Tests for User Story 7

- [ ] T043 [P] [US7] Criar `packages/shared/src/workflow-form.test.ts` com testes (falhando) da função pura `validateFormAnswers(questions, answers)`: obrigatórias faltando listadas, escolha única com uma opção, múltipla com várias, número e data inválidos recusados, perguntas opcionais vazias aceitas
- [ ] T044 [P] [US7] Acrescentar em `server/src/__tests__/workflow-runs-gates.integration.test.ts` os casos: a etapa abre a pergunta e o run vai a `waiting_human`; envio com obrigatória faltando recusado com `missing_required`; envio completo grava o documento do case na chave de saída e o run segue com a etapa seguinte recebendo o documento; pessoa sem autoridade recusada; `timeoutSec` escala sem preencher; cancelar cancela a pergunta; envio duplicado em paralelo vale uma vez

### Implementation for User Story 7

- [ ] T045 [US7] Confirmar em `server/src/services/issue-thread-interactions*.ts` se `ask_user_questions` aceita criação pelo servidor sem agente; se exigir agente, usar o agente que concluiu a etapa anterior; registrar em `research.md` (R5)
- [ ] T046 [US7] Criar `packages/shared/src/workflow-form.ts` com `validateFormAnswers` e o mapeamento das perguntas para `selectionMode` e `required` do `ask_user_questions`; T043 deve passar
- [ ] T047 [US7] Em `server/src/services/workflow-run-boundaries.ts`, implementar `openForm` (cria a interação, grava `interaction_id`, estado `awaiting_input`) e `submitForm` (valida, grava o documento do case na chave de saída, registra `input_submitted` e chama `advance`); expor `POST /api/workflow-runs/:id/steps/:stepKey/submit-form` em `server/src/routes/workflow-runs.ts`
- [ ] T048 [US7] Rodar T043 e T044; tudo verde

**Checkpoint**: PR 2b completo (US2, US3, US4 e US7)

---

## Phase 8: User Story 5 - Rotina que cria case e run (Priority: P2) — PR 2c

**Goal**: o alvo de workflow na rotina cria case e run.

**Independent Test**: seção "PR 2c" do `quickstart.md`, passo 1.

### Tests for User Story 5

- [ ] T049 [P] [US5] Criar `server/src/__tests__/workflow-runs-routine.integration.test.ts` (banco real) cobrindo: disparo por `schedule`, `webhook` e `api` cria case e run presos à versão mais recente com o dono da rotina como responsável; mesma entrega externa duas vezes cria um run; run ativo da rotina segue a política `coalesce_if_active`; versão sem etapas executáveis cria só a tarefa como na spec 001; sem versão publicada ou arquivado falha o run da rotina sem criar nada; `heartbeat` não é afetado

### Implementation for User Story 5

- [ ] T050 [US5] Em `server/src/services/workflow-routine-targets.ts`, estender `resolveWorkflowForDispatch` com a decisão "executável"; criar `startRunFromRoutine` em `server/src/services/workflow-runs.ts` (cria o case e o run numa transação, `origin = routine`, `routine_run_id`); em `server/src/services/routines.ts`, no ponto de extensão da spec 001, chamar `startRunFromRoutine` quando a versão for executável e manter o comportamento atual caso contrário
- [ ] T051 [US5] Rodar T049 e `pnpm exec vitest run server/src/__tests__/routine-workflow-target.integration.test.ts server/src/__tests__/routines*.test.ts`; tudo verde

---

## Phase 9: User Story 6 - Etapas com efeito externo exigem aprovação (Priority: P2) — PR 2c

**Goal**: nenhuma etapa externa roda sem gate aprovado.

**Independent Test**: seção "PR 2c" do `quickstart.md`, passo 2.

- [ ] T052 [P] [US6] Acrescentar em `server/src/__tests__/workflow-runs-advance.integration.test.ts` os casos de runtime: o motor não inicia uma etapa com `externalEffect` sem gate aprovado antes; gate rejeitado não executa a etapa externa
- [ ] T053 [US6] Em `server/src/services/workflow-run-advance.ts`, bloquear o início de etapa com `externalEffect` sem gate aprovado como antecessor imediato, escalando a `waiting_human` com o motivo (defesa em profundidade; a regra de publicação já é de T005)
- [ ] T054 [US6] Rodar T052 e `packages/shared/src/workflow-spec-graph.test.ts`; tudo verde

---

## Phase 10: User Story 8 - Lembretes e tempo de espera dos gates (Priority: P3) — PR 2c

**Goal**: lembretes de gates abertos e tempo de espera registrado.

**Independent Test**: seção "PR 2c" do `quickstart.md`, passo 3.

- [ ] T055 [P] [US8] Acrescentar em `server/src/__tests__/workflow-runs-control.integration.test.ts` os casos (relógio injetado): lembrete único por intervalo depois de `reminderAfterSec` sem decidir nada; sem lembrete depois de decidido; tempo de espera gravado no evento do run ao decidir; lembrete limitado a `timeoutSec`
- [ ] T056 [US8] Em `server/src/services/workflow-run-work.ts`, registrar o prazo de lembrete pelo mecanismo do T036, emitir `gate_reminder` e notificar os decisores; gravar o tempo de espera (`closed_at - opened_at`) no evento `gate_decided`
- [ ] T057 [US8] Rodar T055; tudo verde

---

## Phase 11: User Story 9 - Resumo do que mudou entre tentativas (Priority: P3) — PR 2c

**Goal**: o revisor vê o que mudou nos documentos entre tentativas.

**Independent Test**: seção "PR 2c" do `quickstart.md`, passo 4.

- [ ] T058 [P] [US9] Criar `server/src/services/workflow-run-diff.test.ts` (puro) com testes (falhando) de `summarizeDocumentChange(oldBody, newBody, { maxChars })`: linhas adicionadas, removidas, primeiras linhas alteradas, corte no limite de tamanho, corpos iguais devolvem "sem mudanças"
- [ ] T059 [US9] Criar `server/src/services/workflow-run-diff.ts` com `summarizeDocumentChange` e `summarizeAttemptChanges(tx, step)` que compara as revisões de `output_revision_ids` da tentativa atual com a anterior usando `getIssueDocumentRevision` de `server/src/services/documents.ts`
- [ ] T060 [US9] Em `server/src/services/workflow-run-boundaries.ts`, incluir o resumo no corpo da decisão quando `attempt > 1` e omitir na primeira tentativa; acrescentar o caso em `server/src/__tests__/workflow-runs-gates.integration.test.ts`
- [ ] T061 [US9] Rodar T058 e o caso de T060; tudo verde

---

## Phase 12: User Story 10 - Testar um workflow antes de publicar (Priority: P3) — PR 2c

**Goal**: simulação sem efeitos reais.

**Independent Test**: seção "PR 2c" do `quickstart.md`, passo 5.

- [ ] T062 [P] [US10] Criar `packages/shared/src/workflow-simulate.test.ts` com testes (falhando) de `simulateWorkflow(spec, script)`: percurso etapa a etapa, estado final, ciclo termina no `maxReviewRounds` com escalonamento, `maxAttempts`, gate com cada outcome, formulário e etapa humana simulados, `script` incompleto recusado; um workflow de 20 etapas é simulado em até 5 s (SC-010)
- [ ] T063 [US10] Criar `packages/shared/src/workflow-simulate.ts` (puro, sem banco) e exportar em `packages/shared/src/index.ts`
- [ ] T064 [US10] Criar `server/src/routes/workflow-simulate.ts` com `POST /api/workflows/:id/simulate` conforme `contracts/workflow-runs.md` (lê só a definição, nunca grava, `assertCompanyAccess`), montar em `server/src/app.ts` e documentar em `server/src/routes/openapi.ts`; acrescentar um teste em `server/src/__tests__/workflow-runs-control.integration.test.ts` que confirma 0 linhas novas em `cases`, `workflow_runs`, `decisions` e `issues` depois da simulação
- [ ] T065 [US10] Rodar T062 e o teste do T064; tudo verde

---

## Phase 13: Polish & Cross-Cutting Concerns

- [ ] T066 [P] Escrever `doc/workflow-runs.md` com o comportamento do subsistema (arquitetura híbrida, `complete_workflow_step`, gates como decisões, limites de TTL, formulário, etapa humana, recuperação, orçamento, simulação) e linkar em "More documentation" de `doc/DEVELOPING.md`
- [ ] T067 [P] Conferir que nenhum arquivo novo passa de 1.000 linhas e que os acréscimos em `case-handoffs.ts`, `decisions.ts`, `routines.ts`, `budgets.ts` e `server/src/index.ts` são pontos de extensão curtos (regra `pull-request-review`)
- [ ] T068 Rodar `pnpm -r typecheck` (ou `node scripts/typecheck-low-memory.mjs`) e `pnpm verify`; se `pnpm verify` sair com código 2, rodar os checks focados e registrar o que fica para o CI
- [ ] T069 Executar o `quickstart.md` de ponta a ponta numa instância de dev com as flags ligadas e registrar o resultado
- [ ] T070 Atualizar `doc/plans/2026-11-24-agent-workflows-hitl.md` marcando a fase 2 como especificada e linkando `specs/002-workflow-runs-hitl/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências; T001 exige a spec 001 pronta
- **Foundational (Phase 2)**: depende do Setup; bloqueia tudo
- **US1 (Phase 3)**: depende do Foundational; PR 2a
- **US2, US3, US4, US7**: dependem de US1; entre si, US3 usa o gate de US2, US4 usa o avançador de US1 e o gate de US2 para cancelar decisões, e US7 usa o avançador; PR 2b
- **US5, US6, US8, US9, US10**: PR 2c; US5 depende de US1; US6 depende de US2; US8 depende de US2 e US4; US9 depende de US3; US10 depende só do Foundational
- **Polish (Phase 13)**: depende das histórias desejadas

### User Story Dependencies

- **US1** é o MVP; as demais empilham sobre ele
- **US10** (simulação) é independente e pode ser feita em paralelo a qualquer fase depois do Foundational

### Parallel Opportunities

- Foundational: T006, T007 e T008 em paralelo; T010 e T011 em paralelo
- Testes `[P]` de cada história antes da implementação
- US10 em paralelo com US1 por outra pessoa ou agente

---

## Parallel Example: Foundational

```text
Task: "Criar packages/db/src/schema/workflow_runs.ts (T006)"
Task: "Criar packages/db/src/schema/workflow_run_steps.ts (T007)"
Task: "Criar packages/db/src/schema/workflow_run_events.ts (T008)"
Task: "Criar packages/shared/src/workflow-runs.ts (T010)"
```

---

## Implementation Strategy

### MVP First (US1, PR 2a)

1. Setup e Foundational
2. US1: run só com agentes, saídas, versão fixa, um run ativo por case
3. **Parar e validar** pela seção "PR 2a" do quickstart

### Incremental Delivery

1. **PR 2a**: US1
2. **PR 2b**: US2, US3, US4, US7 (gates, devolução, controle e formulário); começa pelos spikes S1 a S5
3. **PR 2c**: US5, US6, US8, US9, US10
4. Cada PR atrás da flag, com `pnpm verify` e CI

### Notas

- Se um spike der resposta negativa, aplicar o fallback do `plan.md` antes de seguir e registrar em `research.md`
- Commits pequenos, Conventional Commits; cada teste deve falhar antes da implementação
- Evidências de verificação expiram após edições; reexecutar os checks afetados antes de cada PR
