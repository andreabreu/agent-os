# Feature Specification: Execução de workflows com gates humanos (HITL)

**Feature Branch**: `feat/workflow-runs-hitl`

**Created**: 2026-11-24

**Status**: Draft

**Input**: Fase 2 de `doc/plans/2026-11-24-agent-workflows-hitl.md`. Só fork. Depende da spec `001-workflow-versions-triggers` (versões imutáveis, validação de grafo, política padrão, reassign, alvo de workflow em rotinas).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Rodar um workflow só com etapas de agente (Priority: P1)

Uma pessoa, um agente ou uma rotina inicia um run a partir de uma versão publicada de um workflow, num case. O sistema coloca a primeira etapa para andar e, a cada etapa concluída, passa o case ao dono da próxima, na mesma tarefa principal do case, até o fim. Cada etapa só conclui quando entrega os documentos que declarou como saída, e a etapa seguinte recebe referências a eles.

**Why this priority**: É o núcleo. Sem ele não há workflow executado, só definição.

**Independent Test**: Iniciar um run de três etapas de agente, ver cada etapa assumir o case em ordem, tentar concluir uma etapa sem a saída declarada e ver a recusa, e ver o run terminar como concluído.

**Acceptance Scenarios**:

1. **Given** uma versão publicada com três etapas de agente e um case sem run ativo, **When** alguém inicia um run, **Then** o run fica em andamento, preso a essa versão, com a primeira etapa pronta e atribuída ao seu dono.
2. **Given** uma etapa em andamento, **When** o agente tenta concluí-la sem os documentos que ela declarou como saída, **Then** a conclusão é recusada com mensagem que lista os documentos faltantes.
3. **Given** uma etapa que entregou todas as saídas, **When** ela conclui, **Then** a próxima etapa passa a ser dona do case e recebe referências aos documentos de entrada que declarou.
4. **Given** um case que já tem um run ativo, **When** alguém tenta iniciar outro run nele, **Then** a tentativa é recusada com motivo claro.
5. **Given** um run concluído, **When** alguém inicia outro run no mesmo case, **Then** o novo run é aceito.
6. **Given** um run em andamento e uma versão nova publicada do workflow, **When** o run avança, **Then** ele continua na versão em que começou.
7. **Given** um agente tentando passar o case para uma etapa que o workflow não permite a partir da atual, **When** ele envia o handoff, **Then** o handoff é recusado.

---

### User Story 2 - Aprovar ou rejeitar num gate humano (Priority: P1)

Quando a próxima etapa é um gate de aprovação, o sistema cria uma decisão na fila de decisões já existente, com uma opção para cada saída da etapa. O run espera. Uma pessoa autorizada decide; o agente seguinte é acordado e o run segue o caminho da opção escolhida.

**Why this priority**: É o ponto de HITL. É o que diferencia o produto de uma sequência de agentes.

**Independent Test**: Rodar um workflow com um gate, ver a decisão na fila, decidir como pessoa autorizada e como pessoa não autorizada, e conferir que o run segue ou fica parado conforme o caso.

**Acceptance Scenarios**:

1. **Given** um run que chega a um gate, **When** a etapa começa, **Then** surge uma decisão na fila com as opções da etapa e o run passa a "esperando humano".
2. **Given** uma decisão de gate aberta, **When** uma pessoa autorizada escolhe "aprovar", **Then** a decisão se resolve, o run segue o destino da opção e o agente da etapa seguinte é acordado.
3. **Given** uma decisão de gate aberta, **When** uma pessoa sem autoridade tenta decidir, **Then** a tentativa é recusada e nada muda.
4. **Given** um gate cujo decisor é um usuário ou papel declarado na etapa, **When** um ator com permissão de gestão decide, **Then** a decisão também é aceita.
5. **Given** um gate, **When** a pessoa tenta decidir "pedir mudanças" ou "rejeitar" sem comentário, **Then** a decisão é recusada pedindo o comentário; **When** aprova sem comentário, **Then** é aceita.
6. **Given** um gate aberto, **When** o run é cancelado, **Then** a decisão é cancelada junto.

---

### User Story 3 - Devolver o trabalho e escalar ao estourar rodadas (Priority: P1)

Quando a pessoa pede mudanças ou rejeita, o run segue o destino declarado na opção: voltar a uma etapa anterior ou encerrar. Cada volta soma uma tentativa. Ao atingir o limite de rodadas de revisão, o run para e escala ao responsável. O sistema também suporta etapas humanas, em que a mesma tarefa do case é atribuída a uma pessoa que a conclui.

**Why this priority**: Sem devolução e limite, o gate vira um beco sem saída ou um loop infinito.

**Independent Test**: Devolver um gate repetidas vezes até o limite e ver o escalonamento; rodar uma etapa humana e concluí-la.

**Acceptance Scenarios**:

1. **Given** um gate com opção "pedir mudanças" que volta à etapa de redação, **When** a pessoa a escolhe com comentário, **Then** a etapa de redação reabre com tentativa 2, atribuída ao seu dono, que recebe o comentário.
2. **Given** a tentativa chegar ao limite de rodadas de revisão da etapa, **When** a pessoa pede mudanças de novo, **Then** o run vai a "esperando humano" com o motivo e o responsável é avisado, sem voltar sozinho.
3. **Given** uma opção cujo destino é encerrar, **When** a pessoa a escolhe, **Then** o run termina conforme declarado.
4. **Given** uma etapa humana, **When** o run chega a ela, **Then** o case é atribuído à pessoa ou papel declarado, e ao concluir (com as saídas) o run segue.

---

### User Story 4 - Falhas, orçamento, cancelamento e reinício (Priority: P2)

O responsável e a gestão mantêm o controle: agente que falha tenta de novo até o limite e depois escala; orçamento estourado pausa o run; o run pode ser cancelado; e um reinício do servidor no meio de um run não perde nem duplica o avanço.

**Why this priority**: Torna o fluxo seguro em produção, mas depende das histórias 1 a 3.

**Independent Test**: Forçar falhas de agente, estourar orçamento, cancelar com gate aberto e reiniciar o servidor no meio de um run.

**Acceptance Scenarios**:

1. **Given** uma etapa de agente que falha, **When** ainda há tentativas, **Then** ela é repetida; **When** o limite de tentativas acaba, **Then** o run vai a "esperando humano" com o motivo da falha.
2. **Given** um run em andamento, **When** o orçamento do agente ou da empresa estoura, **Then** o run inteiro fica "pausado" e nada avança até a liberação ou retomada.
3. **Given** um run em andamento ou esperando, **When** o responsável ou um ator de gestão o cancela, **Then** o run termina como cancelado, as decisões abertas são canceladas e a tarefa do case permanece.
4. **Given** um ator que não é o responsável nem da gestão, **When** tenta cancelar, **Then** é recusado.
5. **Given** um reinício do servidor entre a conclusão de uma etapa e o passo seguinte, **When** o servidor sobe, **Then** o run retoma de onde parou, sem repetir etapas já concluídas nem criar decisões duplicadas.
6. **Given** um gate com limite de tempo declarado, **When** o tempo passa sem decisão, **Then** o run vai a "esperando humano" e o responsável é avisado; o gate nunca é aprovado nem rejeitado automaticamente.

---

### User Story 5 - Rotina que cria case e run (Priority: P2)

Uma rotina com alvo em um workflow passa a criar um case e um run em vez de só uma tarefa. Versões sem etapas executáveis continuam criando só a tarefa com a referência, como na spec 001. O responsável do run é o dono da rotina.

**Why this priority**: Entrega o "de tempo em tempo" e o "por endpoint" para workflows completos.

**Independent Test**: Disparar uma rotina agendada e uma chamada externa com alvo em workflow e conferir case, run, responsável e a coalescência de disparos repetidos.

**Acceptance Scenarios**:

1. **Given** uma rotina com alvo em um workflow executável, **When** ela dispara, **Then** é criado um case e um run preso à versão publicada mais recente, com o dono da rotina como responsável.
2. **Given** um disparo repetido da mesma entrega externa, **When** chega duas vezes, **Then** um único run é criado.
3. **Given** um run ativo já iniciado por essa rotina, **When** ela dispara de novo, **Then** o resultado segue a política de concorrência da rotina (coalescer ou pular).
4. **Given** uma versão sem etapas executáveis, **When** a rotina dispara, **Then** só a tarefa com a referência é criada, como antes.

---

### User Story 6 - Etapas com efeito externo exigem aprovação (Priority: P2)

Uma etapa marcada como tendo efeito externo (publicar, enviar, fazer deploy) só pode começar depois de uma aprovação humana na etapa imediatamente anterior ou num gate dedicado. Um workflow que declara efeito externo sem esse gate é recusado na publicação.

**Why this priority**: Governança por construção, em vez de depender do texto do prompt.

**Independent Test**: Publicar um workflow com etapa externa sem gate antes dela (recusado) e com gate (aceito), e rodá-lo.

**Acceptance Scenarios**:

1. **Given** uma etapa com efeito externo sem gate de aprovação antes dela em todos os caminhos, **When** a versão é publicada, **Then** é recusada nomeando a etapa.
2. **Given** um run que chega a uma etapa com efeito externo depois de um gate aprovado, **When** a etapa começa, **Then** ela executa normalmente.
3. **Given** um gate que foi rejeitado, **When** o run segue, **Then** a etapa externa não executa.

---

### User Story 7 - Lembretes e tempo de espera dos gates (Priority: P3)

Um gate humano aberto lembra os decisores depois do tempo configurado e o sistema mede quanto tempo cada decisão ficou esperando.

**Why this priority**: Evita gates esquecidos e dá visibilidade do gargalo humano.

**Independent Test**: Deixar um gate aberto além do tempo de lembrete e ver o aviso; decidir e ver o tempo de espera registrado.

**Acceptance Scenarios**:

1. **Given** um gate aberto por mais que o tempo de lembrete declarado, **When** esse tempo passa, **Then** os decisores recebem um lembrete uma vez por intervalo, sem decidir nada.
2. **Given** um gate decidido, **When** a decisão é registrada, **Then** o tempo entre abertura e decisão fica gravado no run e consultável.

---

### User Story 8 - Resumo do que mudou entre tentativas (Priority: P3)

Quando uma etapa reentra por devolução, quem a revisa vê o que mudou nos documentos desde a tentativa anterior.

**Why this priority**: Reduz o custo de revisar o mesmo material várias vezes.

**Independent Test**: Devolver uma etapa, alterar o documento e ver o resumo de mudanças na nova decisão.

**Acceptance Scenarios**:

1. **Given** uma segunda tentativa de uma etapa, **When** o gate de revisão se abre, **Then** a decisão inclui o resumo das diferenças entre as revisões dos documentos de saída da tentativa anterior e da atual.
2. **Given** a primeira tentativa, **When** o gate abre, **Then** não há resumo de mudanças.

---

### User Story 9 - Testar um workflow antes de publicar (Priority: P3)

Quem escreve um workflow pode simular um run com agentes e pessoas simulados, para ver quais caminhos, gates e ciclos o definem, sem criar tarefas, decisões nem gastar orçamento.

**Why this priority**: Pega erros de desenho antes de publicar uma versão imutável.

**Independent Test**: Simular um workflow com ciclo e ver o percurso e o ponto onde o limite de rodadas escala.

**Acceptance Scenarios**:

1. **Given** uma definição de workflow, **When** a pessoa pede uma simulação com respostas escolhidas para cada gate, **Then** recebe o percurso etapa a etapa, o estado final e os pontos de escalonamento.
2. **Given** uma simulação, **When** ela roda, **Then** nenhuma tarefa, decisão, case ou run real é criado e nenhum agente é acordado.

---

### Edge Cases

- Dois inícios de run simultâneos no mesmo case: exatamente um vence, o outro é recusado.
- Duas decisões simultâneas no mesmo gate: a primeira vale, a segunda é recusada sem alterar o run.
- Agente remove ou arquiva o dono de uma etapa no meio de um run: o run vai a "esperando humano" com o motivo, sem perder estado.
- Etapa humana sem usuário válido (usuário removido): "esperando humano" com o motivo.
- Handoff manual (fora do workflow) no case de um run ativo: recusado enquanto o run estiver ativo, ou registrado como desvio e o run escala, conforme a regra de transição validada.
- Cancelamento enquanto o handoff de uma etapa está em trânsito: o handoff é concluído ou descartado de forma consistente, e o run termina cancelado.
- Gate com tempo de espera declarado e lembrete maior que o tempo: o lembrete vale só até o fim do tempo.
- Orçamento liberado enquanto o run está pausado: o run retoma do ponto em que parou, sem repetir a etapa.
- Servidor reiniciado com decisão resolvida e avanço pendente: o avanço acontece uma única vez.
- Recurso desligado por flag no meio de runs ativos: runs ativos ficam preservados e não avançam até a flag voltar.
- Simulação com ciclo que nunca sai: termina no limite de rodadas e reporta o escalonamento.

## Requirements *(mandatory)*

### Functional Requirements

**Run e etapas**

- **FR-001**: O sistema DEVE iniciar um run a partir de uma versão publicada de um workflow num case, por pessoa, agente ou rotina, com um responsável definido.
- **FR-002**: Um run DEVE ficar preso à versão em que começou e nunca migrar para outra.
- **FR-003**: Um case DEVE ter no máximo um run ativo; um novo run só pode começar depois de o anterior terminar.
- **FR-004**: As etapas DEVEM executar na tarefa principal do case: etapas de agente por passagem do case ao dono da etapa, e etapas humanas por atribuição da mesma tarefa à pessoa declarada.
- **FR-005**: Cada etapa DEVE declarar os documentos de saída e o sistema DEVE exigir que existam no case antes de aceitar a conclusão da etapa.
- **FR-006**: A etapa seguinte DEVE receber referências aos documentos de entrada que declarou, sem cópia do conteúdo.
- **FR-007**: O sistema DEVE aceitar apenas as passagens e conclusões previstas pelo workflow para a etapa atual e recusar as demais.
- **FR-008**: O sistema DEVE manter o estado de cada etapa (pendente, pronta, em andamento, aguardando revisão, aguardando aprovação, concluída, mudanças pedidas, pulada, falha, cancelada) e do run (em andamento, esperando humano, pausado, concluído, falho, cancelado).
- **FR-009**: Cada tentativa de etapa DEVE ser registrada separadamente com seu resultado.

**Gates humanos**

- **FR-010**: Um gate de aprovação DEVE criar uma decisão na fila de decisões existente, com uma opção para cada saída da etapa, e acordar o agente seguinte ao resolver.
- **FR-011**: Só podem decidir o usuário ou papel declarado na etapa e atores com permissão de gestão; sem quórum.
- **FR-012**: O sistema DEVE exigir comentário ao pedir mudanças ou rejeitar e DEVE aceitar aprovação sem comentário.
- **FR-013**: O humano no gate DEVE poder apenas aprovar, rejeitar ou pedir mudanças com comentário, sem editar o artefato.
- **FR-014**: Cada opção de um gate DEVE seguir o destino declarado (próxima etapa, etapa anterior ou fim), e voltar DEVE somar uma tentativa à etapa de destino.
- **FR-015**: Ao atingir o limite de rodadas de revisão da etapa, o run DEVE ir a "esperando humano" com o motivo e o responsável DEVE ser avisado, sem voltar sozinho.
- **FR-016**: Um gate NÃO DEVE expirar por padrão; com limite de tempo declarado o run DEVE ir a "esperando humano" e avisar o responsável, sem nunca aprovar ou rejeitar sozinho.

**Falhas e controle**

- **FR-017**: Uma etapa de agente que falha DEVE ser repetida até o limite de tentativas declarado e depois o run DEVE ir a "esperando humano" com o motivo.
- **FR-018**: Orçamento estourado DEVE pausar o run inteiro, e a retomada DEVE continuar do ponto onde parou.
- **FR-019**: Só o responsável e atores de gestão PODEM cancelar um run; o cancelamento DEVE cancelar as decisões abertas e DEVE manter a tarefa do case.
- **FR-020**: Um reinício do servidor NÃO DEVE perder nem duplicar avanços: o sistema DEVE retomar runs pendentes na inicialização e por evento, sem varredura periódica nova.
- **FR-021**: O avanço do run DEVE ser idempotente: o mesmo evento aplicado duas vezes produz o mesmo estado.

**Disparo**

- **FR-022**: O alvo de workflow numa rotina DEVE criar um case e um run para versões com etapas executáveis, tendo o dono da rotina como responsável, e DEVE manter o comportamento da spec 001 (só a tarefa) para versões sem etapas executáveis.
- **FR-023**: A concorrência de disparo DEVE seguir a política da rotina, e a mesma entrega externa repetida DEVE criar um único run.

**Extras**

- **FR-024**: Uma etapa com efeito externo DEVE ter um gate de aprovação aprovado antes dela em todos os caminhos, e a publicação DEVE recusar versões que não cumprem isso, nomeando a etapa.
- **FR-025**: Um gate aberto DEVE lembrar os decisores depois do tempo configurado, e o tempo de espera de cada decisão DEVE ser registrado e consultável.
- **FR-026**: Ao reabrir uma etapa por devolução, a decisão do gate DEVE incluir o resumo das mudanças dos documentos de saída entre a tentativa anterior e a atual.
- **FR-027**: O sistema DEVE oferecer uma simulação de workflow com respostas simuladas para agentes e gates, sem criar nada real nem acordar agentes, devolvendo o percurso e os pontos de escalonamento.

**Acesso, auditoria e superfície**

- **FR-028**: Toda leitura e escrita DEVE respeitar a fronteira da empresa; acesso entre empresas DEVE ser negado.
- **FR-029**: Toda mutação de run, etapa e gate (iniciar, avançar, decidir, cancelar, pausar, retomar, escalar) DEVE ser registrada no registro de atividade.
- **FR-030**: Agentes DEVEM ter ferramentas nativas para ler um run e iniciar um run; pessoas DEVEM ter as mesmas operações por API. Esta fase não inclui tela de run.
- **FR-031**: O recurso DEVE ficar atrás da mesma flag experimental da spec 001; com a flag desligada nada novo é exposto e dados existentes ficam preservados.
- **FR-032**: Falhas DEVEM aparecer com mensagem clara e código de erro consistente.

### Key Entities *(include if feature involves data)*

- **Run**: execução de uma versão de workflow num case. Tem versão fixa, responsável, estado, quem iniciou, origem (manual, agente, rotina) e datas.
- **Etapa do run (tentativa)**: uma linha por tentativa de cada etapa, com número da tentativa, estado, resultado, vínculo com a decisão (quando é gate) e documentos de saída.
- **Evento do run**: registro de auditoria de tudo que mudou o run, com ator e detalhes.
- **Decisão de gate**: decisão na fila de decisões, com opções iguais às saídas da etapa, comentário, decisor e tempos de abertura e resolução.
- **Definição de etapa (estendida)**: o que a spec 001 já define, mais documentos de saída, marca de efeito externo, limite de tempo do gate, tempo de lembrete e regra de comentário.
- **Simulação**: resultado efêmero de uma execução simulada, sem persistir trabalho real.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Um workflow de cinco etapas (pesquisa, redação, revisão humana, aprovação, publicação) roda do início ao fim com um provedor real, com pelo menos uma devolução, e termina como concluído.
- **SC-002**: Em 100% dos testes de reinício do servidor no meio de um run, o run retoma sem repetir etapas concluídas nem duplicar decisões.
- **SC-003**: 100% das tentativas de decidir um gate por ator sem autoridade são recusadas, e 100% das tentativas válidas são aceitas.
- **SC-004**: 100% das devoluções sem comentário são recusadas e 100% das aprovações sem comentário são aceitas.
- **SC-005**: Nenhum run avança além do limite de rodadas ou de tentativas declarado: em 100% dos casos o run vai a "esperando humano" com o motivo.
- **SC-006**: Nenhuma decisão de gate é aprovada ou rejeitada sem ação de uma pessoa autorizada, incluindo gates com limite de tempo.
- **SC-007**: Entregas externas repetidas ou disparos concorrentes criam exatamente um run ativo por case em 100% dos testes.
- **SC-008**: 100% das versões com etapa de efeito externo sem gate anterior são recusadas na publicação.
- **SC-009**: Uma pessoa vê a decisão de um gate na fila de decisões em até 5 segundos após a etapa chegar a ele.
- **SC-010**: Uma simulação de um workflow de vinte etapas devolve o percurso em até 5 segundos e cria 0 tarefas, decisões e runs reais.
- **SC-011**: Com a flag desligada, 0 rotas, ferramentas ou opções novas ficam visíveis e 100% dos workflows e rotinas da spec 001 continuam funcionando.
- **SC-012**: Nenhum acesso entre empresas é concedido em testes de isolamento.

## Assumptions

- A spec 001 está implementada primeiro: versões imutáveis, validação de grafo, política padrão, reassign de estágio e alvo de workflow em rotinas.
- A definição de etapa da spec 001 (`specVersion: 1`) é estendida de forma aditiva (saídas, efeito externo, limite de tempo, lembrete, regra de comentário), sem quebrar versões já publicadas, que continuam válidas e só deixam de ser "executáveis" se faltar o que a execução exige.
- "Etapas executáveis" significa versões cujas etapas usam apenas os tipos suportados nesta fase (agente, humana e gate de aprovação) e cumprem as regras de saídas e efeito externo.
- O papel declarado numa etapa usa o modelo de papéis e permissões já existente da empresa; "gestão" segue o mesmo modelo.
- Documentos de saída e entrada são documentos do case já existentes, identificados por chave.
- A fila de decisões, a expiração de decisões e o acordar do agente de origem existentes são reaproveitados.
- Tempos de lembrete e de espera usam o mecanismo existente de expiração e de trabalho por evento; nenhum polling periódico novo é criado.
- Fora de escopo: paralelismo e join, router, wait, editor visual, UI de run, aprovação pelo chat (fase 2c) e eventos internos como gatilho.
- O resultado fica só no fork e não será contribuído ao upstream.
