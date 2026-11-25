# Quickstart: validar a feature de ponta a ponta

Pré-requisitos: `node scripts/agent-preflight.mjs`, `pnpm dev`, e as flags `enableCases` e `enableWorkflowVersions` ligadas em Instance Settings (experimental). Contratos em [contracts/](./contracts/); tabelas em [data-model.md](./data-model.md).

## 1. Versões e validação (US1, US2)

1. Criar um workflow só-prompt pela rota existente e confirmar que ele continua funcionando como antes.
2. Publicar uma versão válida de cinco etapas. Esperado: `201` com `version: 1`; segunda publicação devolve `version: 2`.
3. Publicar spec com etapa inalcançável, saída para etapa inexistente e ciclo sem `maxAttempts`. Esperado: `422`, cada erro nomeando a etapa.
4. Ler a versão como agente da mesma empresa (ferramenta `read_workflow_version`) e como ator de outra empresa. Esperado: leitura ok e `404` respectivamente.

## 2. Política padrão (US3)

1. Definir `defaultExecutionPolicy` na empresa e outra no projeto.
2. Criar tarefa no projeto sem política (como pessoa e como agente). Esperado: a do projeto.
3. Criar tarefa sem projeto. Esperado: a da empresa. Com política explícita. Esperado: a explícita.
4. Disparar uma rotina que cria tarefa. Esperado: sem política padrão aplicada.

## 3. Reassign de estágio (US4)

1. Em tarefa com estágio de revisão pendente e dois participantes, reatribuir ao segundo. Esperado: novo participante ativo e entrada no activity log.
2. Reatribuir a quem não está no estágio, a um estágio concluído e com ator sem permissão. Esperado: recusa em cada caso.

## 4. Triggers (US5)

1. Associar um workflow publicado a uma rotina e criar gatilhos `schedule`, `webhook` e `api`.
2. Disparar manualmente (`POST /routines/:id/run`) e pela URL pública do webhook, duas vezes com a mesma entrega. Esperado: uma tarefa, com versão registrada em `trigger_payload`.
3. Arquivar o workflow e disparar de novo. Esperado: run falho com `failure_reason` claro e nenhuma tarefa nova.
4. Desligar `enableWorkflowVersions`. Esperado: rotas e ferramentas novas ausentes e dados preservados.

## Comandos de verificação

```sh
pnpm db:generate && pnpm -r typecheck
pnpm verify
node scripts/check-maps.mjs   # só se mapas forem editados
```
