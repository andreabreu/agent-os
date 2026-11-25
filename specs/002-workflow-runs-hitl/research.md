# Research: Execução de workflows com gates humanos

Levantamento no `master` (`1a57a2abec`) para a spec 002. Os itens marcados "Spike" têm pergunta aberta e são resolvidos no início do PR indicado no plano.

## R1. Quem inicia a passagem entre etapas de agente

- **Decisão**: o agente conclui a etapa com a ferramenta nova `complete_workflow_step`. O servidor valida e executa a passagem chamando `caseHandoffService` em nome do agente que concluiu.
- **Racional**: o handoff existente é uma máquina de estados durável (`awaiting_release`, `pending_dispatch`, idempotência, lease, prova de liberação do run, revalidação do ator no momento da transferência). Reaproveitá-lo evita reimplementar a regra mais delicada. A autoridade e o `fromAgentId` ficam corretos porque o ator é o mesmo.
- **Alternativas**: o servidor inicia o handoff como "sistema" (`apply` exige `fromAgentId` igual ao responsável atual e restaura o ator original, então não há ator de sistema); só validar o `handoff_case` livre do agente (deixa a conclusão de etapa implícita e não cobre gates).
- Handoff livre fora do fluxo, num case com run ativo, é recusado (resposta à questão de borda da spec).

## R2. Gate de aprovação como decisão

- **Decisão**: `decisionService.create` com uma opção por outcome, `continuationPolicy = none`, origem = o último agente que segurou o case e a run mais recente dele nesse case. O avanço, e não a continuação da decisão, acorda o agente da etapa seguinte pelo handoff, como pede FR-010.
- **Fatos do código**: a decisão exige `agentId` e `runId`; `expiresAt` é obrigatório, padrão 7 dias e máximo 30 dias (`expiresAt must be within 30 days`); expiradas acordam o agente de origem; as opções aceitam até 10 `effects` e a decisão até 4 `inputs`.
- **Consequências**:
  - "Não expira por padrão" vira: TTL de 30 dias e, ao expirar sem `timeoutSec`, o avanço **reabre** o gate com uma decisão nova (nunca aprova nem rejeita sozinho). Com `timeoutSec` declarado (máximo 30 dias, validado na publicação), a expiração escala o run a `waiting_human`.
  - Todo caminho até um `approval_gate` passa por ao menos uma etapa de agente (o último agente que segurou o case é a origem da decisão), o que mantém válido o exemplo pesquisa, redação, revisão humana, aprovação, publicação. Isso entra como regra de validação do grafo e é o spike S2.
- **Alternativas**: `request_confirmation` na tarefa (só aceitar ou rejeitar, não casa com N outcomes); estágio de aprovação da execution policy (só protege a conclusão da tarefa).

## R3. Comentário obrigatório só ao devolver

- **Decisão**: acrescentar `requiredInputIds` opcional à opção de decisão (`decisionOptionSchema`), validado quando a decisão é resolvida. O gate declara um input `comment`; as opções de devolver e rejeitar o exigem, a de aprovar não.
- **Racional**: `inputs` é da decisão inteira; sem isso não há como exigir só em algumas opções. Mudança aditiva no módulo dono, justificada na PR (spike S3).

## R4. Etapa humana

- **Decisão**: o servidor reatribui a tarefa do case à pessoa declarada, como a execution policy faz nos estágios (`applyIssueExecutionPolicyTransition`). Ao concluir, o usuário usa a mesma operação de conclusão de etapa.
- **Spike S1**: confirmar o mecanismo exato e a autoridade necessária, já que o handoff só transfere para agentes (`Only agent handoffs can transfer a task`).

## R5. Formulário

- **Decisão**: interação `ask_user_questions` na tarefa do case, com os tipos de pergunta da spec mapeados para `selectionMode` e `required` existentes; ao responder, as respostas viram um documento do case na chave de saída da etapa.
- **Racional**: reaproveita a pergunta estruturada ao humano e seu fluxo de resposta e wake. O tipo "número" e "data" ficam como validação no servidor sobre texto.
- **A confirmar**: se `ask_user_questions` aceita criação pelo servidor sem agente; caso exija agente, usar o agente que concluiu a etapa anterior (mesmo padrão do gate).

## R6. Avanço idempotente e recuperação

- **Decisão**: cada evento (conclusão, decisão resolvida, resposta, pausa e retomada por orçamento) chama `advance(runId, eventKey)`, uma transação que grava o evento com `UNIQUE (run_id, event_key)`, calcula as próximas etapas e cria o trabalho; repetir o mesmo evento não muda o estado. Na inicialização, um passe único reexecuta o avanço de runs cujo último evento não foi consumido.
- **Padrão**: os módulos `decision-effect-recovery-work`, `tool-review-recovery-work` e `workspace-recovery-work` registram trabalho de recuperação em `server/src/index.ts`; `decision-continuations` entrega por `sweep` limitado. O módulo novo segue esse padrão (`workflow-run-work.ts`), sem timers.
- **Spike S4**: ler `decision-expiry-work.ts` para registrar prazos e lembretes pelo mesmo mecanismo.

## R7. Run por case, versão fixa e estado

- **Decisão**: `workflow_runs` com índice único parcial `(case_id) WHERE status IN ('running','waiting_human','paused')`; `version_id` fixo; `state_version` inteiro; código de erro permanente `workflow_run_state_unsupported` quando o servidor encontra um `state_version` que não entende (regra `upgrade-safe-run-state`).
- O case existente já guarda `workflowId` e `phase` (via handoff); o run mantém a etapa atual em `workflow_run_steps` e o `phase` do case recebe a chave da etapa.

## R8. Orçamento

- **Decisão**: ao avançar, o servidor consulta o estado de pausa do agente e da empresa (`pauseReason = "budget"` em `agents` e `companies`); se pausado, marca o run `paused` e não cria trabalho. Uma chamada curta em `budgets.ts` avisa o módulo ao pausar e ao retomar, para o run reagir por evento.
- **Spike S5**: localizar o ponto de publicação da pausa.

## R9. Efeito externo

- **Decisão**: regra de validação do grafo na publicação: toda etapa com `externalEffect: true` tem um `approval_gate` aprovado como antecessor imediato em todos os caminhos. Em execução, o avançador não inicia a etapa externa sem o gate aprovado.
- Acrescenta um código `external_effect_without_gate` aos erros de `validateWorkflowGraph`.

## R10. Lembretes e tempo de espera

- **Decisão**: o tempo de espera é `decidedAt - createdAt` da decisão, copiado para o evento do run. O lembrete é um prazo registrado pelo mecanismo de trabalho com prazo (S4); cada lembrete é um evento `gate_reminder` com limite por gate.
- Sem tabela de SLA; sem polling.

## R11. Resumo de mudanças entre tentativas

- **Decisão**: cada tentativa guarda `output_revision_ids` (chave de documento para id de revisão). Ao reabrir um gate na tentativa N, `workflow-run-diff.ts` compara a revisão da tentativa N com a da N-1 (pela API de revisões de documentos) e inclui no corpo da decisão um resumo em linhas (adicionadas, removidas e as primeiras linhas alteradas), limitado em tamanho.
- Função de diff pura, testada sem banco.

## R12. Simulação

- **Decisão**: `simulateWorkflow(spec, script)` pura em `packages/shared`, sem banco; `script` fixa a resposta de cada etapa e gate. Rota `POST /api/workflows/{id}/simulate` (ou com spec no corpo) lê só a definição e devolve o percurso, o estado final e os pontos de escalonamento. Corta em `maxReviewRounds` e `maxAttempts`, então um ciclo termina sempre.

## R13. Disparo por rotina

- **Decisão**: o ponto de extensão de `dispatchRoutineRun` (spec 001) passa a chamar `startWorkflowRunFromRoutine`, que cria o case e o run quando a versão é "executável" (só tipos suportados e saídas válidas), com o dono da rotina como responsável. Versões não executáveis mantêm o comportamento da spec 001. A concorrência é a da rotina (`coalesce_if_active`), e o índice único de run ativo por case impede duplicidade.

## R14. Estratégia de testes

- Puros: transições e simulação em `packages/shared`.
- Banco real: quatro suítes (avanço, gates e formulário, controle e recuperação, rotina), com relógio injetado e sem sleeps. Reinício do servidor simulado reexecutando o passe de recuperação sobre estado intermediário.
- TDD: cada tarefa começa com teste falhando.
