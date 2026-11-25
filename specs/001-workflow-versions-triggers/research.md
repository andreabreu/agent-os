# Research: Workflows versionados, política padrão e triggers

Levantamento feito no `master` (`1a57a2abec`) e nas PRs upstream #15267 e #15265. Nenhuma pergunta ficou aberta para o plano; os itens "A confirmar na implementação" viram a primeira tarefa de cada módulo.

## R1. Onde guardar versões

- **Decisão**: tabela nova `workflow_versions` (`workflow_id`, `version`, `spec` jsonb, `spec_hash`, autor), com índice único `(workflow_id, version)`. Numeração por contador atômico em `workflows.latest_version_number`, incrementado no `UPDATE ... RETURNING` da mesma transação da publicação.
- **Racional**: é o padrão já usado em `routines.latest_revision_number` e `routine_revisions`; evita `MAX(version)+1` e a corrida entre publicações simultâneas.
- **Alternativas**: `MAX()+1` com retry (mais código, mesma corrida); versionar dentro de `workflows.spec` (perde imutabilidade e histórico).
- **Imutabilidade**: nenhuma rota nem função de serviço faz `UPDATE` ou `DELETE` em `workflow_versions`; um teste de banco prova isso. Trigger de banco foi descartado porque bloquearia o `ON DELETE CASCADE` ao remover a empresa.

## R2. Forma do spec e validação de grafo

- **Decisão**: `specVersion: 1`, `start`, e `steps[]` com `key`, `type` (`agent_task`, `human_task`, `approval_gate`), `name`, `owner`, `inputs[]`, `outcomes[]` (`key` e `to`, onde `to` é uma etapa ou `end`) e `limits` (`maxAttempts`, `maxReviewRounds`, `timeoutSec`). Tipos `router`, `parallel`, `join` e `wait` são recusados nesta fase.
- **Validação** (função pura `validateWorkflowGraph` em `packages/shared`): chaves únicas; `start` existe; todo destino existe ou é `end`; toda etapa é alcançável do início; toda etapa alcançável tem caminho até `end`; entradas apontam para etapas existentes (`unknown_input`); um ciclo é aceito quando alguma etapa dele declara `maxAttempts` ou `maxReviewRounds` (o grafo só das etapas sem limite não pode ter ciclo, verificado por componentes fortemente conexos). Revisado na implementação: exigir limite em toda etapa do ciclo recusaria o caso comum redação → revisão → redação com limite só na revisão.
- **Racional**: é o mínimo da fase 1 do documento de proposta; mensagem de erro nomeia etapa e saída (FR-004). Pura e compartilhada, então servidor e futuros clientes validam igual.
- **Alternativas**: validar só no servidor (duplica no editor futuro); biblioteca de grafos (dependência nova para 40 linhas).

## R3. Flag experimental

- **Decisão**: nova chave `enableWorkflowVersions` (padrão `false`) em `instanceExperimentalSettingsSchema` e entrada em `INSTANCE_FEATURE_CATALOG`. O guarda é `requireCasesEnabled` mais a própria flag.
- **Racional**: o catálogo é derivado do schema e quebra a compilação se faltar entrada; reusar `enableCases` impediria ligar só os Cases. `workflow_runs` por case na fase 2 também depende de Cases.
- **Confirmado na implementação (T002)**: a página `ui/src/pages/InstanceExperimentalSettings.tsx` não lê o catálogo; cada flag tem um cartão manual. O cartão novo segue o par Summaries e Status Cards: ligar Workflow versions liga Cases, e desligar Cases desliga Workflow versions. `server/src/services/instance-settings.ts` também lista cada flag explicitamente. A lista `CLOUD_STAGING_EXPERIMENTAL_KEYS` de `cloud-instance.ts` não foi alterada, por ser política de deployment.

## R4. Alvo de workflow na rotina

- **Decisão**: tabela lateral `routine_workflow_targets` (`routine_id` único, `company_id`, `workflow_id`). Nada muda em `routines`.
- **Racional**: `routineRevisionSnapshotSchema` é `.strict()` (v1); acrescentar campo à rotina exige nova versão de snapshot e compatibilidade de restauração. A tabela lateral é aditiva e isolada. Limitação declarada: revisões de rotina não capturam o alvo.
- **Alternativas**: coluna `workflow_id` em `routines` (mexe no snapshot estrito e no arquivo mais conflitante); `origin_kind = "workflow"` (já usado para outra semântica, a origem da rotina).

## R5. Ponto de extensão no disparo

- **Decisão**: dentro de `dispatchRoutineRun` (`services/routines.ts`, antes de criar a tarefa, em torno da linha 2015), uma chamada a `resolveWorkflowForDispatch(db, routine)`. Sem alvo, retorna `null` e nada muda. Com alvo, devolve `{workflowId, versionId, version, name}`.
- O disparo acrescenta uma referência ao workflow e à versão na descrição da tarefa, grava `workflowVersionId` e `workflowVersion` em `routine_runs.trigger_payload` e registra o activity log. Falha (sem versão publicada, workflow arquivado) usa o mecanismo existente de falha do run (`failure_reason`), sem criar tarefa.
- **Racional**: reaproveita idempotência por entrega, `coalesce_if_active`, receipts de webhook e assinatura já existentes; nenhum gatilho novo (FR-015 e FR-016).
- **Confirmado na implementação (T043)**: `dispatchRoutineRun` já marca o run como `failed` com `failureReason` para qualquer erro lançado dentro do `try` interno, depois de criar o run, e apaga uma tarefa parcial. O ponto de extensão resolve o alvo antes de montar a descrição (sem lançar), acrescenta a referência à descrição e ao `triggerPayload` e, dentro do `try`, lança o erro de "sem versão publicada" ou "arquivado" para cair nesse caminho. Rotinas sem alvo, e todas com a flag desligada, mantêm descrição e `triggerPayload` idênticos.

## R5b. Quais tipos de disparo valem

- **Decisão**: `schedule`, `webhook` e `api`. O gatilho `heartbeat` não inicia trabalho (comentário em `validators/routine.ts`: "never fires a run"; depende de `enableResponsibilities`) e fica fora.

## R6. Política de execução padrão

- **Decisão**: coluna jsonb `default_execution_policy` em `companies` e `projects`, validada na gravação com `issueExecutionPolicySchema`. Resolução em `issue-default-execution-policy.ts`: política declarada na criação vence; senão a do projeto; senão a da empresa. Não se aplica a tarefas de origem `routine_execution` nem a conversa.
- **Ponto de extensão**: uma chamada em `issueService.create` antes de `normalizeIssueExecutionPolicy`. Rotas `PATCH` de empresa e projeto aceitam o campo.
- **Upstream #15267**: o diff toca `routes/issues.ts` (+165/-26) e `services/issues.ts` (+152/-6). Não portamos o diff em bloco: trazemos o comportamento e os testes (`issue-default-execution-policy.test.ts` com 768 linhas e `project-default-execution-policy-read-authz.test.ts`), adaptando ao módulo novo.
- **A confirmar**: regra de leitura do campo (o teste de authz do upstream indica restrição para quem não é da gestão) e os pontos de criação além de `POST /companies/:companyId/issues`, que o upstream cobre (por exemplo filhos e criação por agente).

## R7. Reassign de estágio pendente

- **Decisão**: lógica pura em `issue-execution-stage-reassign.ts` (valida participante configurado, estágio pendente, ator autorizado, mesmo participante vira no-op) e rota em roteador novo `issue-stage-reassign.ts`.
- **Upstream #15265**: toca `routes/issues.ts` (+252/-66) e `issue-execution-policy.ts` (+83/-2), com testes de 454 e 203 linhas. Reaproveitamos a semântica e os testes; o upstream expõe `POST /api/issues/{id}/execution-policy/reassign` com corpo `{ toParticipant, comment? }`, grava `lastReassignment` (`fromParticipant`, `toParticipant`, `comment`) no estado de execução e registra a ação `issue.execution_policy_reassigned`. Adotamos esse contrato (ver `contracts/stage-reassign.md`); a primeira tarefa confirma os detalhes de autorização lendo o diff.
- **Racional**: manter `routes/issues.ts` quase intocado.
- **Bugs de estágio a revisar antes** (upstream, abertos): #21546, #21575, #21639, #19237, #4912; os que se reproduzirem no fork viram tarefas separadas, fora desta spec.

## R7b. Bugs de estágio do upstream no fork (T034)

Verificação por leitura do código do fork (`server/src/services/issue-execution-policy.ts`), sem teste de reprodução. Os cinco estão presentes. Ficam como itens separados, fora desta spec, e afetam a spec 002, que constrói gates sobre a execution policy.

| Upstream | Problema | Evidência no fork | Prioridade sugerida |
| --- | --- | --- | --- |
| #21546, #19237, #4912 | Ao aprovar um estágio, o próximo estágio cujo único participante é o autor trava com `422 No eligible … participant` | `selectStageParticipant(nextStage, { exclude: returnAssignee })` seguido de `throw` (linhas ~904 a 909), sem o laço `canAutoSkipPendingStage` que o início do fluxo usa (linha ~1087) | **Corrigido** em `fix/execution-policy-approval-skip` (commit `86ffd479b6`, trazido para esta branch): o avanço por aprovação agora pula estágios de revisão que só o autor poderia fazer, como o início do fluxo. Um estágio de **aprovação** com só o autor continua recusado; liberar a autoaprovação (#19237) é decisão de produto pendente |
| #21575 | Entrar em `in_review` só para esperar uma pergunta humana inicia o estágio de revisão e tira a tarefa de quem espera a resposta | Não existe `hasPendingHumanInputWait` no fork | Média: afeta etapas de formulário da spec 002 |
| #21639 | O revisor pendente é barrado pelo gate de dependências (`issue_dependencies_blocked`) e a revisão não roda | Não existe `isPendingExecutionStageParticipant` no fork | Média |

## R8. Ferramentas nativas

- **Decisão**: acrescentar `list_workflow_versions` e `read_workflow_version` em `native-workflow-tools.ts`, somente leitura, com a mesma paginação por `snapshot` de `read_workflow`. Escrita (publicar) só por REST, via `authorizeCaseCreation`.
- **Racional**: FR-007 pede leitura para agentes; publicar uma versão imutável por agente é decisão de governança que deixamos para depois.
- **Revisado na implementação (T016)**: os agentes já têm as ferramentas nativas genéricas `search_api` e `call_api`, cujo catálogo é derivado do OpenAPI (`buildRunnerApiCatalog`). Documentar as rotas de versão no `openapi.ts` as torna encontráveis e chamáveis pelos agentes, sem tocar o pacote do Runner. Ferramentas dedicadas (`list_workflow_versions`, `read_workflow_version`) exigiriam mexer em cerca de 25 arquivos do Runner (ações de protocolo, tipos semânticos, discovery, dispatcher, cobertura e catálogos gerados), com alto custo de merge para um fork; ficam como melhoria futura. Um teste de integração confirma que `search_api` encontra as rotas.

## R9. Estratégia de testes

- Unitário puro para o validador de grafo.
- Uma suíte de banco por módulo (regra `test-budget`): versões (numeração concorrente, imutabilidade, isolamento entre empresas, flag desligada), política padrão (precedência, exceções, agente e pessoa), reassign (regras e permissões) e alvo de rotina (disparo agendado, webhook duplicado, sem versão, arquivado).
- TDD: cada tarefa começa com o teste falhando.
