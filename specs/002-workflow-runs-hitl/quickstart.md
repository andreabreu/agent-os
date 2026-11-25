# Quickstart: validar a fase 2 de ponta a ponta

Pré-requisitos: spec 001 implementada, `pnpm dev`, flags `enableCases` e `enableWorkflowVersions` ligadas. Contratos em [contracts/](./contracts/); tabelas em [data-model.md](./data-model.md).

## PR 2a: run só com agentes

1. Publicar um workflow de três etapas de agente, com `outputs`, e iniciar um run num case. Esperado: run `running`, primeira etapa atribuída ao seu dono, versão registrada.
2. Concluir a etapa 1 sem a saída declarada. Esperado: `422` com `missing_outputs`.
3. Concluir com a saída. Esperado: o case passa ao dono da etapa 2, que recebe referências às entradas declaradas.
4. Tentar iniciar outro run no mesmo case e usar `handoff_case` livre. Esperado: recusas.
5. Cancelar o run. Esperado: `cancelled`, tarefa do case intacta.

## PR 2b: gates, devolução e formulário

1. Workflow pesquisa, redação, revisão humana, aprovação, publicação. Esperado: ao chegar ao gate, decisão na fila com as opções, run `waiting_human`.
2. Decidir como pessoa sem autoridade (recusa) e como autorizada com "pedir mudanças" sem comentário (recusa) e com comentário (a redação reabre na tentativa 2).
3. Repetir até `maxReviewRounds`. Esperado: `waiting_human` com o motivo, sem voltar sozinho.
4. Formulário: enviar com pergunta obrigatória faltando (recusa) e completo (documento do case criado e etapa seguinte o recebe).
5. Estourar o orçamento do agente. Esperado: run `paused`; liberar e retomar sem repetir a etapa.
6. Reiniciar o servidor com uma decisão resolvida e o avanço pendente. Esperado: um único avanço.

## PR 2c: rotina, efeito externo, extras

1. Rotina com alvo em workflow executável disparada por `schedule`, webhook (duas entregas iguais) e `api`. Esperado: um case e um run por entrega, dono da rotina como responsável.
2. Publicar etapa com `externalEffect` sem gate antes. Esperado: `422` `external_effect_without_gate`.
3. Deixar um gate além do lembrete. Esperado: lembrete e, depois da decisão, tempo de espera gravado.
4. Reabrir uma etapa por devolução. Esperado: a decisão traz o resumo de mudanças.
5. `POST /workflows/{id}/simulate` com um ciclo. Esperado: percurso e escalonamento no limite, 0 registros reais.

## Comandos

```sh
pnpm db:generate && pnpm -r typecheck
pnpm verify
```
