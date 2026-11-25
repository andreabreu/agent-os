# Workflows de agentes com HITL no Agent OS — avaliação e proposta

Nov 24, 2026 · @Andre Abreu

Revisado em 2026-11-24 contra o `master` (`1a57a2abec`).

## Resumo

É viável, e a maior parte das peças já existe. O agent-os (Paperclip) já tem handoffs entre agentes, revisões e aprovações por tarefa, perguntas ao humano no thread, decisões com fila e wake do agente, dependências entre tarefas e rotinas. O que falta é um workflow **declarativo e executado pelo servidor**: hoje o "workflow" do experimento Cases é só um nome mais um prompt em Markdown, e as transições são advisory (o agente lê e decide).

Recomendação: não criar um motor novo que roda agentes. Fazer o workflow virar uma **definição versionada que o servidor interpreta e traduz nos primitivos existentes** (tarefas, handoffs de case, execution policy, decisions). Começar evoluindo os workflows do Cases com transições validadas e gates humanos, e só depois adicionar paralelismo e editor visual.

Esta avaliação não alterou código. As decisões que são suas estão na última seção.

## O que já existe

Sete primitivos cobrem quase tudo que um workflow com HITL precisa. Lidos no `master` atual (commit `1a57a2ab`).

| Primitivo | Onde | O que faz hoje | Papel num workflow |
| --- | --- | --- | --- |
| Workflows do Cases | `packages/db/src/schema/workflows.ts`, `server/src/services/workflows.ts`, `case-workflows.ts` | Nome + prompt Markdown por empresa; o case adota e vira o documento `workflow` da tarefa. Atrás de `experimental.enableCases` | Ponto de partida: já tem definição reutilizável, adoção e histórico |
| Case handoffs | `case-handoffs.ts`, `doc/case-handoffs.md` | Agente passa o case para a próxima fase/agente, com idempotência, lease, retry e prova de liberação do run | O "motor" de encadeamento já durável |
| Execution policy | `issue-execution-policy.ts`, tipo `IssueExecutionPolicy` | Estágios review/approval por tarefa, participantes agente ou usuário, `changes_requested`, escalonamento ao humano após `maxReviewRounds` (padrão 3) | Gate de revisão e aprovação em cada etapa |
| Thread interactions | `ISSUE_THREAD_INTERACTION_KINDS` | `ask_user_questions`, `request_confirmation`, `request_item_verdicts`, `suggest_tasks` | HITL no meio de uma etapa |
| Decisions + filas | `decisions.ts`, `decision_queues.ts` | Decisão com opções, fila, expiração e `continuationPolicy = wake_origin_agent` | Gate humano assíncrono que acorda o agente |
| Relações e dependências | `issue_relations` (`blocks`), `doc/dependency-wake-recovery.md` | Tarefa bloqueada acorda quando o bloqueador termina | Fan-out / join entre etapas |
| Rotinas | `routines.ts` | Cron, webhook e API criam tarefas | Gatilho para iniciar um workflow |

As tabelas `pipelines`, `pipeline_stages`, `pipeline_transitions`, `pipeline_cases` e `pipeline_case_events` não são dormentes por acaso: o experimento Pipelines foi **removido de propósito** no commit `9077748894` (#16834, "unused experiment"), com UI, API, CLI, automação e a permissão `pipelines:write`. Só o schema e as migrações ficaram, para preservar dados já salvos. Elas já tinham estágios tipados (`working/review/done/cancelled`), `enforceTransitions`, filas de revisão e automação idempotente via rotinas.

O plano `doc/plans/2026-10-21-reusable-case-workflows.md` registrou uma decisão explícita: "No interpreter or new execution service", deixando para depois editor de UI, role binding e validação de grafo. Esta proposta revisita exatamente esse ponto.

### Por que não é o Pipelines de novo

O Pipelines era um quadro paralelo, com modelo próprio de casos, e foi considerado sem uso. Esta proposta difere em três pontos, que o plano da fase 1 deve sustentar:

- Apoia-se em primitivos que continuam vivos (Cases, handoffs, execution policy, decisions), sem criar outro modelo de caso.
- O servidor só valida transições e calcula o que fica pronto; não é uma superfície de produto nova com board próprio.
- Reaproveitar as tabelas `pipelines*` fica fora de escopo. Elas seguem preservadas, sem serviço.

Antes de escrever o plano: ler os PRs relacionados ao Pipelines (#7907, #9110, #10905, #11375, #13004, #14671) para aproveitar o que levou à remoção, e medir o uso real do Cases. A flag `enableCases` está desligada por padrão (`cloudDefault: false`, `selfHostedDefault: false`).

## Lacunas

O que falta é estrutura e garantia, não capacidade de execução.

1. **Definição estruturada.** O workflow é texto livre; não há etapas, donos, saídas nomeadas nem gates que o servidor consiga ler.
2. **Transições garantidas.** O `handoff_case` aceita qualquer fase; um agente pode pular a revisão humana se o prompt for mal seguido.
3. **Versionamento.** Editar um workflow não cria versão; um run em andamento não fica preso à versão com que começou (hoje há só cópia do prompt no documento da tarefa).
4. **Gate entre etapas.** A execution policy protege a conclusão de uma tarefa, mas não existe "aprovar antes de passar para o próximo agente" como passo próprio.
5. **Paralelismo e join.** O case tem uma tarefa primária com um responsável; ramos paralelos exigem tarefas-filhas e um join explícito.
6. **Passagem de contexto.** Saídas de uma etapa (documentos, work products) chegam à próxima só se o agente souber procurá-las.
7. **Visão do run.** A UI de Cases é somente leitura e não mostra o grafo, a etapa atual nem o que espera um humano.
8. **Autoria.** Só por agente ou API; não há editor nem templates no catálogo.
9. **Ciclo de vida.** Sem regra para arquivar uma versão com runs ativos, remover um agente dono de etapa ou migrar os workflows só-prompt existentes.

## Proposta de design

Um workflow é um grafo versionado de etapas; um run percorre esse grafo e cada etapa vira trabalho comum do Paperclip. O servidor só decide **o que fica pronto a seguir** e **quais transições são permitidas**; quem executa continuam sendo os agentes, pelo heartbeat atual.

### Exemplo

Pesquisa (agente) → Redação (agente) → Revisão (humano, pode devolver) → Aprovação (gate) → Publicação (agente).

```text
Pesquisa (agente) -> Redação (agente) -> Revisão (humano) -> Aprovação (gate) -> Publicação (agente)
                          ^                     |  changes_requested       |  rejected
                          +---------------------+--------------------------+
```

Revisão e aprovação podem devolver o trabalho à redação; ao estourar o limite de rodadas, o run escala ao responsável.

### Modelo de dados

| Tabela | Campos principais | Observação |
| --- | --- | --- |
| `workflows` (existente) | + `key`, `status` (draft/active/archived), `latestVersionId` | Mantém nome e prompt; prompt vira o "manual" para os agentes |
| `workflow_versions` (nova) | `workflowId`, `version`, `spec` jsonb, `specHash`, `publishedBy` | Imutável; run fica preso à versão |
| `workflow_runs` (nova) | `companyId`, `versionId`, `caseId`, `status`, `inputs`, `responsibleUserId`, `startedBy`, `triggerRef` (rotina, manual, agente) | Um run ativo por case (índice único parcial, permite reexecutar após concluir); company-scoped |
| `workflow_run_steps` (nova) | `runId`, `stepKey`, `attempt`, `status`, `issueId`, `decisionId`, `outcome`, `outputRefs` | Uma linha por tentativa; liga ao trabalho real |
| `workflow_run_events` (nova) | `runId`, `kind`, `actor`, `payload` | Auditoria; também vai ao activity log |

O `spec` descreve etapas com `key`, `type`, dono (agente, papel ou usuário), `inputs` (de quais etapas lê documentos), `outcomes` nomeados com destino, e limites (`maxAttempts`, `maxReviewRounds`, `timeout`). Validado no `packages/shared` com zod, como os outros contratos.

### Tipos de etapa

| Tipo | Vira o quê | HITL |
| --- | --- | --- |
| `agent_task` | Tarefa (ou fase no handoff do case) atribuída a um agente | Opcional: estágios review/approval da execution policy |
| `human_task` | Tarefa atribuída a um usuário | O próprio passo é humano |
| `approval_gate` | Uma `decision` na fila, com opções = outcomes | Sim; o run espera e o agente seguinte é acordado na resolução |
| `router` | O agente escolhe um outcome entre os permitidos | Opcional: `request_confirmation` antes de aplicar |
| `parallel` / `join` | Tarefas-filhas ligadas por relações `blocks` | Não |
| `wait` | Monitor/timer da execution policy | Não |

### Execução

- **Avançador orientado a eventos**, num módulo novo `workflow-runs` que é dono da sequência (regra `module-boundaries`). Reage a: tarefa da etapa concluída, decisão de estágio, `decision` resolvida, handoff aplicado.
- Cada avanço é **uma transação idempotente**: grava o outcome da etapa, calcula as próximas etapas prontas, cria as tarefas com chave de idempotência e atribui. O wake do agente sai pelo caminho existente, fora da transação.
- **Sem processo de longa duração.** Um worker idle de recuperação (como os `doc/idle-*.md`) refaz avanços perdidos e trata timeouts.
- **Transições validadas.** `handoff_case` e a conclusão de tarefa só aceitam outcomes declarados no spec para a etapa atual; o resto volta 409/422.
- **Invariantes mantidas:** um responsável por tarefa, checkout atômico, gates de aprovação, pausa por orçamento (pausa o run inteiro) e activity log em toda mutação.
- **Contexto:** a tarefa de cada etapa recebe referências aos documentos das etapas em `inputs`, via o case context já existente, sem copiar o conteúdo.

### Estados

| Entidade | Estados | Notas |
| --- | --- | --- |
| Run | `running`, `waiting_human`, `paused`, `completed`, `failed`, `cancelled` | `waiting_human` quando todas as etapas abertas esperam pessoas; `paused` por orçamento ou ação manual |
| Etapa | `pending`, `ready`, `running`, `awaiting_review`, `awaiting_approval`, `completed`, `changes_requested`, `skipped`, `failed`, `cancelled` | `changes_requested` volta à mesma etapa com `attempt + 1`, até o limite; ao estourar escala ao responsável |

### Pontos de HITL

1. **Revisão numa etapa de agente**: estágio review da execution policy com participante usuário; "pedir mudanças" devolve ao mesmo agente.
2. **Gate entre etapas**: `approval_gate` vira uma `decision` na fila; aprovar libera a próxima etapa, rejeitar segue o outcome `rejected` (voltar ou encerrar).
3. **Etapa humana**: tarefa atribuída a uma pessoa, com as mesmas regras de conclusão.
4. **Pergunta no meio**: o agente usa `ask_user_questions`; a etapa fica `running` e o run aparece como esperando humano.
5. **Confirmação de rota**: num `router`, o agente propõe o outcome e uma pessoa confirma.
6. **Escalonamento**: limite de rodadas, timeout, falha repetida ou orçamento levam o run a `waiting_human` com o motivo.

### UI

- **Workflows**: lista e detalhe com versões. MVP com spec em YAML e o grafo renderizado só para leitura; editor visual depois.
- **Run**: grafo com o estado de cada etapa, linha do tempo de eventos, links para as tarefas e um painel "esperando você".
- **Inbox / Decision queue**: gates e revisões aparecem onde as pessoas já decidem hoje, sem nova caixa de entrada.
- **Disparo**: botão "Iniciar workflow" no case/projeto, rotina com alvo workflow, e ferramentas nativas `start_workflow_run` / `read_workflow_run` para agentes.
- Segue `DESIGN.md` (tokens apenas).

## Referência no upstream

Levantamento em `paperclipai/paperclip`. Decisão: **este trabalho fica só no fork**. O upstream não precisa aceitar o desenho, mas cada arquivo existente que editarmos vira conflito de merge ao puxar atualizações, então o motor entra em módulos e tabelas novas.

O que o upstream já decidiu:
- **#17114 (mergeada, Cases workflows).** Escopo declarado: nome e prompt, sem grafos, versões, entidades de run, schema de papéis nem telas de autoria. "No new execution engine". Citou #3951 como alternativa não adotada. Esta proposta vai além disso de propósito.
- **#3951 (fechada por inatividade, sem rejeição de mérito).** Templates com DAG (`blockedByTempIds`), validação de grafo, invocação por rotina e viewer. Boa referência para a fase 4.
- **#16834 (mergeada).** Remoção do Pipelines por falta de uso. #11387 (fechado) mostrou o tipo de falha de um motor por estágios: casos parados e loops de recuperação.
- **Roadmap.** Revisão e aprovação já constam como passos de workflow de primeira classe (feito). Fluxos de trabalho em fila continuam como direção futura.

Para portar ou adaptar ao fork (abertos no upstream, não mergeados):
- **#15267**, `defaultExecutionPolicy` por empresa e projeto, aplicado na criação da tarefa. Garante o gate sem depender do prompt.
- **#15265**, reassign de um estágio pendente a outro participante configurado (agente revisor, depois humano obrigatório).
- **#15321** (fechado), `reviewEscalation`: escolhe o alvo após `maxReviewRounds`.
- Bugs de estágio a revisar antes de construir sobre a execution policy: #21546, #21575, #21639, #19237, #4912.

## Etapas de implementação

Quatro fases, com a fase 2 dividida em dois PRs (2a e 2b), cada um revisável e atrás de flag experimental. A fase 2 já entrega o caso sequencial com HITL, que é o mais comum.

1. **Spec e versões (base).** `workflow_versions`, schema zod do spec em `packages/shared`, validação de grafo (etapas alcançáveis, outcomes com destino, sem ciclo sem limite), REST e ferramentas nativas de leitura. Workflows só-prompt continuam funcionando.
   - Pronto quando: publicar uma versão, ler pelo agente e rejeitar spec inválido nos testes de banco real.
   - Inclui portar #15267 e #15265 antes do motor, e revisar os bugs de estágio listados acima.
2. **Runs sequenciais com HITL.**
   - **2a, runs e avançador.** `workflow_runs`, `workflow_run_steps`, eventos, avançador transacional, `agent_task` e transições validadas no `handoff_case`.
     - Pronto quando: um run só com etapas de agente roda ponta a ponta, com handoff inválido rejeitado.
   - **2b, gates humanos e recuperação.** `human_task`, `approval_gate`, revisão via execution policy, pausa por orçamento e worker de recuperação.
     - Pronto quando: o exemplo Pesquisa → Redação → Revisão → Aprovação → Publicação roda ponta a ponta com um provedor real, incluindo um "pedir mudanças" e um restart do servidor no meio.
3. **UI do run e disparo.** Página do run com grafo e linha do tempo, gates no Inbox/Decision queue, "Iniciar workflow", rotina com alvo workflow.
   - Pronto quando: uma pessoa aprova, devolve e acompanha o run sem sair da UI.
4. **Ramos e autoria.** `router`, `parallel` / `join` com tarefas-filhas, `wait`, editor visual, templates no `teams-catalog`, export/import.

Riscos principais: conflito com o modelo "uma tarefa primária por case" quando houver paralelismo (por isso fica na fase 4), custo de merge ao puxar o upstream (mitigado com módulos e tabelas novas e o mínimo de edição em arquivos existentes), e dependência de uma feature (Cases) ainda desligada por padrão e de um experimento anterior (Pipelines) removido por falta de uso.

## Decisões para o Andre

| # | Pergunta | Recomendação | Alternativa |
| --- | --- | --- | --- |
| 1 | Base: evoluir os workflows do Cases ou criar um módulo de workflows separado? | Evoluir o Cases: reaproveita handoffs, case context e UI | Módulo separado, sem depender da flag Cases |
| 2 | Transições: o servidor impõe o grafo ou continua advisory? | Híbrido: grafo imposto, agente escolhe entre os outcomes permitidos | Advisory com validação só de aviso |
| 3 | Autoria no MVP: YAML/agentes ou editor visual? | YAML + grafo só leitura; editor na fase 4 | Editor visual já na fase 2 |
| 4 | Flag: dentro de `enableCases` ou nova `enableWorkflows`? Observação: `workflow_runs` por case torna workflows inutilizáveis sem Cases. | Nova flag, dependente de Cases | Reusar `enableCases` |
| 5 | Upstream: isso deve poder voltar ao Paperclip ou é só do fork? | **Decidido: só fork.** Seguir as regras do `AGENTS.md`, isolando em módulos e tabelas novas para reduzir conflito de merge | Desenhar para upstream (descartada) |
| 6 | As tabelas `pipelines*` (experimento removido em #16834, dados preservados): reaproveitar ou ignorar? | Ignorar e justificar no plano por que este desenho difere | Reaproveitar como base dos estágios (ressuscita um modelo removido) |
| 7 | Medir o uso real do Cases antes de investir? | Sim, antes de escrever o plano da fase 1 | Seguir sem medir |

Se as recomendações servirem, o próximo passo é escrever o plano da fase 1 em `doc/plans/` e abrir o primeiro PR.
