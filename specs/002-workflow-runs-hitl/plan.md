# Implementation Plan: Execução de workflows com gates humanos (HITL)

**Branch**: `feat/workflow-runs-hitl` | **Date**: 2026-11-24 | **Spec**: [spec.md](./spec.md)

**Input**: `specs/002-workflow-runs-hitl/spec.md`. Depende de `specs/001-workflow-versions-triggers/` (versões, validação de grafo, política padrão, reassign, alvo de rotina).

## Summary

Um módulo novo, `workflow-runs`, dono da sequência do run. Ele não executa agentes: **valida e registra** o que os primitivos existentes fazem e cria os pontos de espera humana. Arquitetura híbrida, igual à recomendação do plano geral (grafo imposto pelo servidor, agente escolhe entre os outcomes permitidos):

- **Etapa de agente**: o agente conclui com uma ferramenta nova, `complete_workflow_step(outcome)`. O servidor confere as saídas, valida o outcome e passa o case ao dono da próxima etapa chamando o `caseHandoffService` existente em nome do agente que concluiu (mesma autoridade, idempotência, lease e retry do handoff atual).
- **Gate de aprovação**: uma `decision` na fila existente, com uma opção por outcome, criada em nome de o último agente que segurou o case (origem técnica exigida pela decisão), com `continuationPolicy = none`. A resolução dispara o avanço, e o handoff para a etapa seguinte acorda o agente dela.
- **Formulário**: uma interação `ask_user_questions` na tarefa do case; as respostas viram um documento do case.
- **Etapa humana**: a tarefa do case é reatribuída a uma pessoa pelo servidor, como a execution policy já faz nos estágios.
- **Avanço**: uma transação idempotente por evento (conclusão, decisão, resposta, orçamento), mais um passe de recuperação registrado na inicialização, no padrão `register*Work` dos módulos de decisão. Nenhum polling novo.

Três pontos dependem de comportamento ainda não confirmado do código existente e viram spikes no início de cada PR (seção "Riscos e spikes").

## Technical Context

**Language/Version**: TypeScript (Node, ESM), monorepo pnpm

**Primary Dependencies**: Express, Drizzle ORM, zod, Vitest, embedded Postgres

**Storage**: PostgreSQL via `packages/db`; uma migração gerada por `pnpm db:generate` por PR

**Testing**: Vitest com banco real; uma suíte por módulo; funções puras testadas à parte

**Target Platform**: servidor Paperclip

**Project Type**: web-service em monorepo; sem UI nesta fase

**Performance Goals**: gate visível na fila em até 5 s; simulação de 20 etapas em até 5 s e sem escrita

**Constraints**: company-scoped; activity log em toda mutação; sem timer, polling ou worker novo; avanço idempotente; estado de run com versão para sobreviver a atualizações; sem política de Cloud no Core

**Scale/Scope**: dezenas de runs ativos por empresa, workflows de até algumas dezenas de etapas

## Constitution Check

A constituição do spec-kit segue vazia; os gates vêm de `AGENTS.md` e `rules/*.mdc`:

| Regra | Como o plano cumpre | Status |
| --- | --- | --- |
| Company scope | Toda tabela nova tem `company_id`; toda rota usa `assertCompanyAccess` | Passa |
| `module-boundaries` | A sequência vive em `workflow-runs`; handoffs, decisões e interações continuam donos dos seus protocolos. Mudanças fora do módulo são pontos de extensão curtos e justificados (tabela abaixo) | Passa, com justificativa |
| `api-route-expectations` | Acesso, permissão, activity log e erros consistentes | Passa |
| `sleep-aware-background-work` | Sem timer nem polling novo; recuperação na inicialização e por evento; prazos de gate e lembretes usam o mecanismo existente de trabalho com prazo | Passa, a confirmar no spike S4 |
| `upgrade-safe-run-state` | `workflow_runs.state_version` e código de erro permanente `workflow_run_state_unsupported` | Passa |
| `database-migration-snapshots` | Uma migração por PR; manter os cinco snapshots mais novos | Passa |
| `test-budget` | Uma suíte de banco por módulo; sem sleeps acima de 1 s; relógio injetado | Passa |
| `heartbeat-execution-boundaries` | Não editamos `heartbeat.ts`; o disparo de agentes usa o wake existente | Passa |
| `pull-request-review` | Arquivos novos pequenos; justificativa para qualquer arquivo existente que passe de 1.000 linhas | Passa |
| Invariantes (5.3) | Assignee único, checkout atômico, aprovação, pausa por orçamento e activity log preservados | Passa |

**Alterações fora do módulo dono** (regra 4, a justificar na PR):

| Arquivo | Mudança | Por que fora do módulo |
| --- | --- | --- |
| `server/src/services/case-handoffs.ts` | Uma chamada de validação antes de gravar o handoff e uma notificação depois de aplicado, só quando o case tem run ativo | O handoff é dono da transição; o run só precisa vetá-la e ser avisado |
| `server/src/services/decisions.ts` e `packages/shared/src/validators/decision.ts` | Opção de decisão ganha `requiredInputIds` (aditivo), e uma notificação ao resolver | A decisão é dona da validação do que o decisor envia |
| `server/src/services/routines.ts` | O ponto de extensão da spec 001 passa a poder criar case e run | Disparo é da rotina |
| `server/src/index.ts` | Registro do passe de recuperação na inicialização | Ciclo de vida do servidor |
| `server/src/services/budgets.ts` | Uma notificação quando um escopo é pausado ou retomado por orçamento | Orçamento é dono do estado de pausa |

Reavaliação após o desenho: sem violações; nada em Complexity Tracking.

## Entrega em PRs

| PR | Conteúdo | Histórias |
| --- | --- | --- |
| **2a** | Tabelas de run, avançador, `agent_task`, `complete_workflow_step`, saídas e entradas, run por case, versão fixa, start e read por API e ferramenta, transição validada no handoff, cancelamento | US1 |
| **2b** | `approval_gate`, `human_task`, `input_form`, devolução com limite de rodadas, falhas e retry, pausa por orçamento, recuperação na inicialização, timeouts de gate | US2, US3, US4, US7 |
| **2c** | Alvo de rotina cria case e run, efeito externo exigindo gate, lembretes e tempo de espera, resumo de mudanças, simulação | US5, US6, US8, US9, US10 |

Cada PR fica atrás da flag da spec 001 e é verificável sozinho.

## Project Structure

### Documentation (this feature)

```text
specs/002-workflow-runs-hitl/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── workflow-runs.md
│   ├── workflow-step-spec.md
│   └── native-tools.md
└── tasks.md             # gerado por /speckit-tasks
```

### Source Code (repository root)

```text
packages/db/src/schema/
├── workflow_runs.ts                  # novo
├── workflow_run_steps.ts             # novo
├── workflow_run_events.ts            # novo
└── index.ts

packages/shared/src/
├── workflow-spec.ts                  # + campos de etapa (saídas, efeito externo, tempos, formulário)
├── workflow-runs.ts                  # novo: tipos, estados, schemas de API
├── workflow-run-transitions.ts       # novo: transições puras do run e da etapa
├── workflow-simulate.ts              # novo: simulação pura
└── validators/decision.ts            # + requiredInputIds na opção

server/src/services/
├── workflow-runs.ts                  # novo: start, read, cancel, list
├── workflow-run-advance.ts           # novo: avançador transacional e idempotente
├── workflow-run-boundaries.ts        # novo: gate (decisão), formulário e etapa humana
├── workflow-run-diff.ts              # novo: resumo de mudanças entre tentativas
├── workflow-run-work.ts              # novo: recuperação, prazos e lembretes
├── native-runtime/native-workflow-run-tools.ts  # novo: start/read/complete
├── case-handoffs.ts                  # + validação e notificação (curtas)
├── decisions.ts                      # + requiredInputIds e notificação (curtas)
├── routines.ts                       # estende o ponto de extensão da spec 001
└── budgets.ts                        # + notificação de pausa e retomada (curta)

server/src/routes/
├── workflow-runs.ts                  # novo
└── workflow-simulate.ts              # novo

server/src/__tests__/
├── workflow-runs-advance.integration.test.ts
├── workflow-runs-gates.integration.test.ts
├── workflow-runs-control.integration.test.ts
└── workflow-runs-routine.integration.test.ts

packages/shared/src/
├── workflow-run-transitions.test.ts
└── workflow-simulate.test.ts

doc/workflow-runs.md                  # novo
```

**Structure Decision**: monorepo existente; o motor é um módulo de serviço novo com transições puras em `packages/shared` (compartilháveis com a simulação e com um futuro cliente). Arquivos existentes só recebem pontos de extensão curtos.

## Riscos e spikes

Cada spike é a primeira tarefa do PR indicado e registra o resultado em `research.md`.

| Spike | Pergunta | Se a resposta for ruim |
| --- | --- | --- |
| **S1** (2b) | O servidor pode reatribuir a tarefa do case a um usuário (etapa humana) sem passar pelo handoff, que só aceita destino de agente? | Estender o destino do handoff para usuário (mudança no módulo dono) ou limitar a fase a `human_task` entregue por decisão |
| **S2** (2b) | Uma decisão exige agente e run de origem. Um gate logo depois de um agente tem os dois; um gate depois de etapa humana ou no início não | Regra padrão: todo caminho até o gate passa por ao menos uma etapa de agente, e a origem é o último agente que segurou o case; se a decisão não aceitar uma run já encerrada como origem, restringir a etapa de agente imediatamente antes e tratar o resto na 2c |
| **S3** (2b) | O `inputs` de uma decisão não diferencia obrigatoriedade por opção, e a spec exige comentário só ao devolver | `requiredInputIds` por opção (aditivo) |
| **S4** (2b) | Como `decision-expiry-work` e os módulos `*-work` registram prazos e retomadas sem polling | Seguir o mesmo padrão para timeouts, lembretes e recuperação |
| **S5** (2b) | Onde o orçamento publica a pausa de um escopo para o run reagir | Chamada curta em `budgets.ts` |
