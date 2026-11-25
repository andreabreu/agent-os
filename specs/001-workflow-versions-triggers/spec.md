# Feature Specification: Workflows versionados com política de execução padrão e triggers por rotina

**Feature Branch**: `feat/workflows-hitl`

**Created**: 2026-11-24

**Status**: Draft

**Input**: Fase 1 de `doc/plans/2026-11-24-agent-workflows-hitl.md`. Só fork; não contribuir ao upstream.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Publicar e ler uma versão imutável de um workflow (Priority: P1)

Uma pessoa ou agente que administra uma empresa define um workflow como uma estrutura de etapas (dono, saídas nomeadas com destino, limites de tentativas e de rodadas de revisão) e publica uma versão. Depois de publicada, a versão não muda. Agentes leem a versão publicada para saber quais etapas e transições existem.

**Why this priority**: É a base de tudo. Sem definição estruturada e versionada, não há como validar transições nem prender um trabalho em andamento à versão com que começou.

**Independent Test**: Publicar uma versão válida e lê-la de volta por pessoa e por agente; tentar editá-la e ver a recusa. Entrega valor sozinha: workflows deixam de ser só texto livre.

**Acceptance Scenarios**:

1. **Given** um workflow só-prompt existente, **When** a pessoa publica uma versão com etapas válidas, **Then** a versão recebe um número sequencial, fica imutável e o workflow passa a apontar para ela como a mais recente.
2. **Given** uma versão publicada, **When** alguém tenta alterar o conteúdo dela, **Then** a alteração é recusada e a única via é publicar uma nova versão.
3. **Given** uma versão publicada, **When** um agente da mesma empresa a consulta, **Then** recebe etapas, donos, saídas e limites.
4. **Given** um workflow de outra empresa, **When** alguém sem acesso tenta ler suas versões, **Then** o acesso é negado.

---

### User Story 2 - Rejeitar definições inválidas antes de publicar (Priority: P1)

Ao publicar, o sistema valida o grafo: toda etapa é alcançável a partir do início, toda saída nomeada aponta para uma etapa existente ou para um fim, e qualquer ciclo tem limite de tentativas ou rodadas.

**Why this priority**: Evita publicar workflows que travam ou nunca terminam. Sem isso a versão imutável cristaliza erros.

**Independent Test**: Submeter definições com etapa órfã, saída sem destino e ciclo sem limite, e ver cada uma recusada com mensagem que nomeia a etapa e o problema.

**Acceptance Scenarios**:

1. **Given** uma definição com uma etapa inalcançável, **When** a pessoa publica, **Then** a publicação é recusada e a mensagem nomeia a etapa.
2. **Given** uma saída que aponta para uma etapa inexistente, **When** a pessoa publica, **Then** é recusada e a mensagem nomeia a etapa e a saída.
3. **Given** um ciclo de devolução sem limite de tentativas, **When** a pessoa publica, **Then** é recusada.
4. **Given** uma definição válida com um ciclo limitado por rodadas de revisão, **When** a pessoa publica, **Then** é aceita.

---

### User Story 3 - Garantir um gate por padrão em tarefas novas (Priority: P2)

A empresa ou o projeto define uma política de execução padrão (estágios de revisão e aprovação). Toda tarefa nova que não declare política própria recebe a do projeto, ou a da empresa se o projeto não tiver. Hoje um agente que esquece de definir a política entrega trabalho sem gate.

**Why this priority**: Traz a "transição garantida" sem depender do prompt, e vale mesmo sem workflows.

**Independent Test**: Configurar uma política padrão na empresa, criar uma tarefa sem política (por pessoa e por agente) e verificar que ela nasce com os estágios; criar outra com política explícita e verificar que a explícita vence.

**Acceptance Scenarios**:

1. **Given** uma política padrão no projeto e outra na empresa, **When** uma tarefa nova no projeto é criada sem política, **Then** recebe a do projeto.
2. **Given** apenas a política da empresa, **When** uma tarefa nova é criada sem política, **Then** recebe a da empresa.
3. **Given** uma política declarada na criação, **When** a tarefa é criada, **Then** a padrão não se aplica.
4. **Given** uma tarefa gerada por rotina, **When** ela é criada, **Then** a política padrão não se aplica.
5. **Given** nenhuma política padrão, **When** uma tarefa é criada, **Then** o comportamento atual é mantido.

---

### User Story 4 - Passar um estágio pendente a outro participante configurado (Priority: P2)

Quando um estágio de revisão ou aprovação está pendente, o participante ativo ou um responsável da empresa pode entregá-lo a outro participante já configurado no mesmo estágio, por exemplo de um agente revisor para um humano obrigatório.

**Why this priority**: Cobre o HITL mais comum, "agente revisa e um humano confirma", sem criar cartão de confirmação fora da política.

**Independent Test**: Numa tarefa com um estágio com dois participantes, reatribuir o estágio e conferir que o novo participante é o ativo, que o histórico registra a troca e que um participante fora da lista é recusado.

**Acceptance Scenarios**:

1. **Given** um estágio pendente com dois participantes, **When** o participante ativo o reatribui ao outro, **Then** o outro passa a ser o ativo e a troca aparece no registro de atividade.
2. **Given** um estágio pendente, **When** alguém tenta reatribuí-lo a quem não está configurado no estágio, **Then** é recusado.
3. **Given** um estágio pendente, **When** um ator sem permissão tenta reatribuí-lo, **Then** é recusado.
4. **Given** um estágio já concluído, **When** alguém tenta reatribuí-lo, **Then** é recusado.

---

### User Story 5 - Iniciar um workflow por tempo ou por chamada (Priority: P3)

Uma rotina existente passa a poder ter como alvo um workflow publicado, além do que já aceita hoje. Ela dispara pelos mesmos gatilhos de início que já existem: agendamento (expressão cron com fuso), chamada externa por URL pública com assinatura configurável e chamada autenticada à API (inclui o disparo manual). Nesta fase o disparo cria o trabalho inicial a partir da versão mais recente; não há run nem avanço automático entre etapas.

**Why this priority**: Responde ao requisito de triggers sem criar um segundo motor de gatilhos. Depende das histórias 1 e 2.

**Independent Test**: Criar uma rotina agendada com alvo em um workflow, disparar manualmente e por chamada externa, e verificar que cada disparo cria o trabalho inicial uma única vez, referenciando a versão usada.

**Acceptance Scenarios**:

1. **Given** uma rotina com alvo em um workflow e gatilho de agendamento, **When** o horário chega, **Then** o trabalho inicial é criado referenciando a versão publicada mais recente.
2. **Given** uma rotina com gatilho de chamada externa, **When** a mesma entrega chega duas vezes, **Then** apenas um trabalho é criado.
3. **Given** um workflow sem versão publicada, **When** a rotina dispara, **Then** o disparo é registrado como falho com motivo claro e nada é criado.
4. **Given** um workflow arquivado, **When** a rotina dispara, **Then** o disparo é recusado e a rotina sinaliza o problema.
5. **Given** uma rotina que não tem alvo em workflow, **When** ela dispara, **Then** o comportamento atual não muda.

---

### Edge Cases

- Workflow só-prompt sem nenhuma versão: continua funcionando como hoje, adotado por prompt.
- Publicação simultânea de duas versões do mesmo workflow: números sequenciais sem duplicata, sem perder nenhuma.
- Versão publicada que referencia um agente que depois foi removido: leitura continua possível e o problema é sinalizado, sem alterar a versão.
- Arquivar um workflow com rotinas apontando para ele: as rotinas continuam existindo e passam a falhar com motivo claro.
- Política padrão inválida na empresa ou no projeto: recusada ao salvar, nunca ao criar a tarefa.
- Reatribuição de estágio quando o participante alvo é o mesmo que já está ativo: sem efeito e sem erro.
- Recurso desligado por flag: nenhuma rota, ferramenta ou alvo de rotina fica disponível, e dados existentes são preservados.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema DEVE permitir publicar uma versão de um workflow existente contendo etapas, donos, saídas nomeadas com destino, e limites de tentativas e rodadas de revisão.
- **FR-002**: O sistema DEVE numerar as versões de um workflow em sequência sem lacunas e sem duplicatas, mesmo sob publicações simultâneas.
- **FR-003**: Uma versão publicada DEVE ser imutável; qualquer mudança exige nova versão.
- **FR-004**: O sistema DEVE validar o grafo na publicação e recusar etapas inalcançáveis, saídas sem destino e ciclos sem limite, nomeando a etapa e o problema.
- **FR-005**: O sistema DEVE manter workflows só-prompt existentes funcionando sem alteração de comportamento.
- **FR-006**: O workflow DEVE apontar para sua versão publicada mais recente e ter um estado (rascunho, ativo, arquivado).
- **FR-007**: Pessoas e agentes autorizados da empresa DEVEM poder listar workflows, listar versões e ler uma versão; agentes DEVEM ter ferramentas nativas somente de leitura para isso.
- **FR-008**: Toda leitura e escrita DEVE respeitar a fronteira da empresa e as permissões do ator; acesso entre empresas DEVE ser negado.
- **FR-009**: Toda mutação (publicar, arquivar, alterar política padrão, reatribuir estágio) DEVE ser registrada no registro de atividade.
- **FR-010**: Empresa e projeto DEVEM poder ter uma política de execução padrão, validada ao salvar.
- **FR-011**: Uma tarefa nova sem política própria DEVE receber a do projeto, senão a da empresa; uma política declarada na criação DEVE prevalecer.
- **FR-012**: A política padrão NÃO DEVE ser aplicada a tarefas geradas por rotina nem a tarefas de conversa.
- **FR-013**: O participante ativo de um estágio pendente ou um ator com permissão de gestão DEVE poder reatribuir o estágio a outro participante já configurado nele.
- **FR-014**: A reatribuição DEVE ser recusada para participante fora do estágio, estágio concluído ou ator sem permissão.
- **FR-015**: Uma rotina DEVE poder ter como alvo um workflow publicado, reutilizando os gatilhos de início existentes (agendamento, chamada externa e API), sem novo mecanismo de gatilho. O gatilho de heartbeat não inicia trabalho e fica fora de escopo.
- **FR-016**: O disparo de uma rotina com alvo em workflow DEVE criar o trabalho inicial uma única vez por entrega e registrar qual versão foi usada.
- **FR-017**: O disparo DEVE falhar com motivo claro quando o workflow não tem versão publicada ou está arquivado, sem criar trabalho parcial.
- **FR-018**: O recurso DEVE ficar atrás de uma flag experimental que depende de Cases; com a flag desligada nada novo é exposto e dados existentes permanecem.
- **FR-019**: Falhas DEVEM aparecer ao usuário com mensagem clara e código de erro consistente, sem ser silenciadas.
- **FR-020**: Os contratos DEVEM permanecer sincronizados entre banco, tipos compartilhados, servidor e clientes da UI.

### Key Entities *(include if feature involves data)*

- **Workflow**: definição reutilizável da empresa com nome, manual em texto, estado e referência à versão mais recente. Já existe; ganha chave, estado e versão mais recente.
- **Versão de workflow**: instantâneo imutável de um workflow, com número, definição estruturada, impressão do conteúdo e quem publicou.
- **Definição (spec)**: conjunto de etapas, cada uma com chave, tipo, dono, entradas, saídas nomeadas com destino e limites.
- **Política de execução padrão**: estágios de revisão e aprovação aplicados a tarefas novas, guardada na empresa e no projeto.
- **Estágio pendente**: etapa de revisão ou aprovação de uma tarefa, com participantes configurados e um participante ativo.
- **Rotina com alvo em workflow**: rotina existente cujo alvo é um workflow publicado em vez de um texto de tarefa.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% das definições inválidas dos três tipos (etapa inalcançável, saída sem destino, ciclo sem limite) são recusadas na publicação, e 100% das válidas de um conjunto de exemplos são aceitas.
- **SC-002**: Uma pessoa publica uma versão de um workflow de cinco etapas em menos de 2 minutos.
- **SC-003**: Nenhuma versão publicada pode ser alterada: 0 modificações aceitas em testes de tentativa de edição.
- **SC-004**: 100% das tarefas novas criadas sem política em uma empresa com política padrão nascem com o gate esperado, por pessoa e por agente.
- **SC-005**: Uma reatribuição de estágio leva menos de 30 segundos e aparece no histórico da tarefa em 100% dos casos.
- **SC-006**: Disparos repetidos da mesma entrega externa criam exatamente um trabalho em 100% dos testes.
- **SC-007**: Com a flag desligada, 0 rotas, ferramentas ou opções novas ficam visíveis, e 100% dos workflows só-prompt existentes continuam funcionando.
- **SC-008**: Nenhum acesso entre empresas é concedido em testes de isolamento.

## Assumptions

- A tela de edição de workflow e a visualização do grafo ficam fora desta fase; a autoria é por API e agentes, e a definição pode ser enviada em texto estruturado.
- "Disparo cria o trabalho inicial" significa uma tarefa comum com referência à versão, não um run com avanço automático; runs, avançador, gates entre etapas, paralelismo e UI de run são das fases seguintes.
- O gatilho `heartbeat` das rotinas é uma verificação permanente do agente, depende de outra flag experimental e não inicia trabalho; por isso não é um tipo de disparo de workflow.
- A versão usada por um disparo é sempre a mais recente publicada no momento do disparo.
- A reatribuição de estágio e a política padrão são portadas das propostas abertas do upstream (#15265 e #15267) e adaptadas ao fork; o resultado não será contribuído ao upstream.
- As tabelas do experimento Pipelines removido não são reaproveitadas.
- O papel de "gestão" que pode reatribuir um estágio segue o modelo de permissões já existente da empresa.
- Os bugs abertos de estágio no upstream (#21546, #21575, #21639, #19237, #4912) são revisados antes de construir sobre a política de execução, e os que afetam o fork viram itens do plano.
