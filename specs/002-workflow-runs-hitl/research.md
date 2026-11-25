# Research: Execução de workflows com gates humanos

Levantamento no `master` (`1a57a2abec`) para a spec 002. Os itens marcados "Spike" têm pergunta aberta e são resolvidos no início do PR indicado no plano.

## R1. Quem inicia a passagem entre etapas de agente

- **Decisão**: o agente conclui a etapa com a ferramenta nova `complete_workflow_step`. O servidor valida e executa a passagem chamando `caseHandoffService` em nome do agente que concluiu.
- **Racional**: o handoff existente é uma máquina de estados durável (`awaiting_release`, `pending_dispatch`, idempotência, lease, prova de liberação do run, revalidação do ator no momento da transferência). Reaproveitá-lo evita reimplementar a regra mais delicada. A autoridade e o `fromAgentId` ficam corretos porque o ator é o mesmo.
- **Alternativas**: o servidor inicia o handoff como "sistema" (`apply` exige `fromAgentId` igual ao responsável atual e restaura o ator original, então não há ator de sistema); só validar o `handoff_case` livre do agente (deixa a conclusão de etapa implícita e não cobre gates).
- Handoff livre fora do fluxo, num case com run ativo, é recusado (resposta à questão de borda da spec).

## R1b. Confirmado na implementação do PR 2a

- **Handoff em case existente** exige `expectedHandoffVersion` e `expectedIssueStatusVersion`; o motor lê os dois na hora (`caseHandoffExpectations`).
- **Um handoff por vez.** O serviço recusa um handoff novo enquanto o anterior não foi entregue pelo worker de entrega (`A handoff is already pending for this case`). Concluir uma etapa antes disso devolve `409` e pode ser repetido; em produção o worker entrega por evento, logo depois.
- **Ordem na conclusão:** validar, pedir o handoff idempotente (chave `workflow-run:{runId}:{step}:{attempt}`) e só então gravar o estado do run. Se a gravação falhar, repetir reaproveita o mesmo handoff.
- **Sem gancho depois do handoff aplicado.** A etapa seguinte é marcada `running` quando o handoff é aceito; a entrega e o wake continuam sendo do módulo de handoff. O gancho previsto no T017 ficou só com a recusa de handoff livre, num módulo próprio (`workflow-run-case-guard.ts`) para evitar import circular.
- **Fim do run não fecha a tarefa do case.** O run fica `completed`; fechar a tarefa continua sendo decisão do agente ou da pessoa.
- **Ferramentas de agente:** como na spec 001, os agentes usam `search_api` e `call_api` sobre as rotas documentadas no OpenAPI; não há ferramentas dedicadas no Runner.
- **Etapas executáveis no PR 2a:** só `agent_task` com dono agente; o resto devolve `422 workflow_not_executable` até o PR 2b.

## R2. Gate de aprovação como decisão

- **Decisão**: `decisionService.create` com uma opção por outcome, `continuationPolicy = none`, origem = o último agente que segurou o case e a run mais recente dele nesse case. O avanço, e não a continuação da decisão, acorda o agente da etapa seguinte pelo handoff, como pede FR-010.
- **Fatos do código**: a decisão exige `agentId` e `runId`; `expiresAt` é obrigatório, padrão 7 dias e máximo 30 dias (`expiresAt must be within 30 days`); expiradas acordam o agente de origem; as opções aceitam até 10 `effects` e a decisão até 4 `inputs`.
- **Consequências**:
  - "Não expira por padrão" vira: TTL de 30 dias e, ao expirar sem `timeoutSec`, o avanço **reabre** o gate com uma decisão nova (nunca aprova nem rejeita sozinho). Com `timeoutSec` declarado (máximo 30 dias, validado na publicação), a expiração escala o run a `waiting_human`.
  - Todo caminho até um `approval_gate` passa por ao menos uma etapa de agente (o último agente que segurou o case é a origem da decisão), o que mantém válido o exemplo pesquisa, redação, revisão humana, aprovação, publicação. Isso entra como regra de validação do grafo e é o spike S2.
- **Alternativas**: `request_confirmation` na tarefa (só aceitar ou rejeitar, não casa com N outcomes); estágio de aprovação da execution policy (só protege a conclusão da tarefa).

- **Spike S2 (resolvido):** `decisionService.create` exige uma run do agente de origem com `contextSnapshot.issueId`, mas não exige que ela esteja em execução. O gate usa a run mais recente, na tarefa do case, do último agente que segurou o case; serve inclusive depois de uma etapa humana. Sem nenhuma run desse agente na tarefa (por exemplo, quando o board concluiu tudo), o run vai a `waiting_human` com o motivo.
- **Aviso ao motor:** com `continuationPolicy = none` nada avisava o motor. Pontos de extensão curtos em `decisions.ts` (depois de decidir e de cancelar) e em `decision-expiry.ts` (depois de expirar) chamam `notifyWorkflowGate`, que carrega o motor por `import()` dinâmico para evitar import circular e só age em decisões com `metadata.workflowGate`. Falha no motor é registrada em log e nunca desfaz a decisão.
- **Autoridade de quem decide (F2):** `assertWorkflowGateDecider` em `decisions.ts` aceita o usuário declarado (`owner.kind = user`), quem tem o papel declarado (`owner.kind = role`, papel de membership) e a gestão (board local, admin da instância, `owner` ou `admin` da empresa).
- **Sem ator, sem elevação:** a resolução de um gate faz o handoff seguinte em nome de quem decidiu. Sem ator, o run espera uma pessoa em vez de usar uma autoridade de sistema.

## R3. Comentário obrigatório só ao devolver

- **Decisão**: acrescentar `requiredInputIds` opcional à opção de decisão (`decisionOptionSchema`), validado quando a decisão é resolvida. O gate declara um input `comment`; as opções de devolver e rejeitar o exigem, a de aprovar não.
- **Racional**: `inputs` é da decisão inteira; sem isso não há como exigir só em algumas opções. Mudança aditiva no módulo dono, justificada na PR (spike S3).
- **Spike S3 (resolvido):** a validação de `inputs` fica em `decide` (`decisions.ts`); `requiredInputIds` foi acrescentado ao schema e ao tipo da opção e é checado logo depois. Sem `commentRequiredOn`, o padrão é exigir comentário em todos os outcomes menos o primeiro.

## R4. Etapa humana

- **Decisão**: o servidor reatribui a tarefa do case à pessoa declarada, como a execution policy faz nos estágios (`applyIssueExecutionPolicyTransition`). Ao concluir, o usuário usa a mesma operação de conclusão de etapa.
- **Spike S1**: confirmar o mecanismo exato e a autoridade necessária, já que o handoff só transfere para agentes (`Only agent handoffs can transfer a task`).

- **Spike S1 (resolvido em parte):** o handoff só transfere entre agentes: `apply` recusa ("superseded") uma tarefa com `assigneeUserId`. Decisão do dono do produto (2026-11-25): a pessoa fica com a tarefa durante a etapa humana e o motor a devolve direto ao agente da etapa seguinte, sem handoff nesse salto.
- **Obstáculo restante:** quando a etapa anterior é de um agente, ele conclui de dentro da própria run, que segue em execução. O handoff espera a liberação da run (`awaiting_release`); uma reatribuição direta à pessoa pularia essa espera e o tratamento de "self-handoff" para runs nativas do `PATCH` de tarefas (`recordNativeHumanSelfHandoff`), e a run do agente pode ser recusada na finalização. A reatribuição precisa acontecer na liberação da run, como o handoff faz em `heartbeat/case-handoff-lifecycle.ts`.
- **Implementado (decisão do dono do produto: na liberação da run):** ao entrar numa etapa humana, se nenhuma run segura a tarefa ela vai para a pessoa na hora; se a run de um agente a segura, a etapa fica `ready` e um gancho de uma linha em `heartbeat.ts`, no mesmo ponto em que o handoff é liberado, chama `assignWorkflowHumanStepAfterRelease`. Ao sair da etapa humana, o motor devolve a tarefa ao agente que a segurava antes (guardado em `assigneeAgentId` da linha da etapa) e segue com um handoff normal, então o salto pessoa → agente mantém a entrega durável. Só a pessoa declarada ou a gestão conclui uma etapa humana. Nesta fase o dono de uma etapa humana é um usuário (`owner.kind = user`) e a primeira etapa de um run é de agente.

## R5. Formulário

- **Decisão**: interação `ask_user_questions` na tarefa do case, com os tipos de pergunta da spec mapeados para `selectionMode` e `required` existentes; ao responder, as respostas viram um documento do case na chave de saída da etapa.
- **Racional**: reaproveita a pergunta estruturada ao humano e seu fluxo de resposta e wake. O tipo "número" e "data" ficam como validação no servidor sobre texto.
- **A confirmar**: se `ask_user_questions` aceita criação pelo servidor sem agente; caso exija agente, usar o agente que concluiu a etapa anterior (mesmo padrão do gate).

- **Revisado na implementação (T045):** `ask_user_questions` só aceita perguntas de escolha (`options` com mínimo de 1), sem texto, número ou data, e responder a interação exigiria mais um ponto de extensão na resolução de interações. Como esta fase não tem tela, as respostas chegam pela rota do contrato, `POST /api/workflow-runs/{id}/steps/{stepKey}/submit-form`, validadas por `validateFormAnswers` e salvas como documento do case na primeira chave de saída da etapa (ou na chave da etapa). Mostrar o formulário no thread da tarefa fica para quando houver UI. A tarefa não muda de dono durante o formulário. O prazo usa a coluna `due_at` da etapa; o passe de recuperação tem o próximo `due_at` como agenda e escala o run uma única vez quando o prazo passa.

## R6. Avanço idempotente e recuperação

- **Decisão**: cada evento (conclusão, decisão resolvida, resposta, pausa e retomada por orçamento) chama `advance(runId, eventKey)`, uma transação que grava o evento com `UNIQUE (run_id, event_key)`, calcula as próximas etapas e cria o trabalho; repetir o mesmo evento não muda o estado. Na inicialização, um passe único reexecuta o avanço de runs cujo último evento não foi consumido.
- **Padrão**: os módulos `decision-effect-recovery-work`, `tool-review-recovery-work` e `workspace-recovery-work` registram trabalho de recuperação em `server/src/index.ts`; `decision-continuations` entrega por `sweep` limitado. O módulo novo segue esse padrão (`workflow-run-work.ts`), sem timers.
- **Spike S4**: ler `decision-expiry-work.ts` para registrar prazos e lembretes pelo mesmo mecanismo.

- **Spike S4 (resolvido):** `registerDeadlineWork` roda o trabalho uma vez no registro e de novo a cada `notifyDeliveryWork` na sua fila, sem polling. O prazo de um gate já é tratado pela expiração de decisões existente (`registerDecisionExpiryWork`); o motor reage pelo aviso. O passe de recuperação do run usa a fila nova `workflow-run-recovery` (`workflow-run-work.ts`, registrado em `server/src/index.ts`): espelha pausas de orçamento, processa decisões de gate que o run não recebeu (sem decidir por ninguém: sem ator, o run espera uma pessoa) e entrega etapas humanas à pessoa quando nenhuma run segura a tarefa.

## R7. Run por case, versão fixa e estado

- **Decisão**: `workflow_runs` com índice único parcial `(case_id) WHERE status IN ('running','waiting_human','paused')`; `version_id` fixo; `state_version` inteiro; código de erro permanente `workflow_run_state_unsupported` quando o servidor encontra um `state_version` que não entende (regra `upgrade-safe-run-state`).
- O case existente já guarda `workflowId` e `phase` (via handoff); o run mantém a etapa atual em `workflow_run_steps` e o `phase` do case recebe a chave da etapa.

## R8. Orçamento

- **Decisão**: ao avançar, o servidor consulta o estado de pausa do agente e da empresa (`pauseReason = "budget"` em `agents` e `companies`); se pausado, marca o run `paused` e não cria trabalho. Uma chamada curta em `budgets.ts` avisa o módulo ao pausar e ao retomar, para o run reagir por evento.
- **Spike S5**: localizar o ponto de publicação da pausa.

- **Spike S5 (resolvido):** a pausa e a retomada por orçamento ficam em `pauseScopeForBudget` e `resumeScopeFromBudget` (`budgets.ts`). A plataforma já impede que agentes rodem num escopo pausado, então a invariante vale para os runs sem mudança. Cada função ganhou um aviso de uma linha à fila `workflow-run-recovery`; o passe marca o run `paused` (empresa ou agente da etapa atual pausados por orçamento) e restaura o status anterior quando a pausa termina. Durante a pausa, concluir uma etapa é recusado com `409` e a resolução de um gate espera.
- **Falha de agente (T038), implementada sem repetir tentativas:** a plataforma já repete runs que falham, com limite, e quando desiste deixa a tarefa `blocked` com uma ação de recuperação aberta para uma pessoa ou para o board. O passe de recuperação trata isso como o fim das tentativas: um run com etapa de agente em andamento passa a `waiting_human`, com a causa e a próxima ação da recuperação como motivo. Também escala quando o agente da etapa foi encerrado (`terminated`). Uma tarefa bloqueada só por dependência não escala. O `issueService.update` avisa a fila do passe quando uma tarefa entra em `blocked` (uma linha). Depois que alguém resolve, `resume` continua a etapa.

## R9. Efeito externo

- **Decisão**: regra de validação do grafo na publicação: toda etapa com `externalEffect: true` tem um `approval_gate` aprovado como antecessor imediato em todos os caminhos. Em execução, o avançador não inicia a etapa externa sem o gate aprovado.
- Acrescenta um código `external_effect_without_gate` aos erros de `validateWorkflowGraph`.
- **Revisado na implementação:** a defesa em profundidade fica no início do run, que roda `isExecutableWorkflowSpec` sobre a versão em que o run vai ficar preso; uma versão gravada antes da regra é recusada com `422 workflow_not_executable`. Como o run nunca troca de versão, uma checagem extra no avanço seria inalcançável.

## R10. Lembretes e tempo de espera

- **Decisão**: o tempo de espera é `decidedAt - createdAt` da decisão, copiado para o evento do run. O lembrete é um prazo registrado pelo mecanismo de trabalho com prazo (S4); cada lembrete é um evento `gate_reminder` com limite por gate.
- Sem tabela de SLA; sem polling.
- **Revisado na implementação:** o próximo lembrete fica na coluna `remind_at` da etapa (gate ou formulário), separada de `due_at`, porque um formulário pode ter lembrete e prazo. O passe de recuperação agenda-se pelo menor `due_at` ou `remind_at`. Cada lembrete é um evento `gate_reminder` com chave por intervalo e uma entrada `workflow_run.gate_reminder` no activity log com os decisores; entregar o aviso por chat fica para a fase 2c.

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
