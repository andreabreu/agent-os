# Contrato: extensão da definição de etapa

Estende `workflow-spec.ts` da spec 001 de forma aditiva; versões `specVersion: 1` já publicadas continuam válidas.

## Campos novos (opcionais)

| Campo | Aplica-se a | Regra |
| --- | --- | --- |
| `outputs` | todas | Lista de chaves de documento; exigidas antes de concluir |
| `externalEffect` | `agent_task` | `true` exige gate aprovado como antecessor imediato em todos os caminhos |
| `timeoutSec` | `approval_gate`, `input_form` | Inteiro de 60 a 2.592.000 (30 dias); escala ao responsável, nunca decide |
| `reminderAfterSec` | `approval_gate`, `input_form` | Menor que `timeoutSec` quando ambos existem |
| `commentRequiredOn` | `approval_gate` | Lista de outcomes que exigem comentário; padrão: os de devolução e rejeição |
| `questions` | `input_form` | Obrigatório; 1 a 20 perguntas; `kind` em `text`, `single_choice`, `multi_choice`, `number`, `date` |

## Tipos de etapa aceitos nesta fase

`agent_task`, `human_task`, `approval_gate`, `input_form`.

## Novas regras de validação de grafo

| Código | Quando |
| --- | --- |
| `external_effect_without_gate` | Etapa com `externalEffect` sem gate antecessor em todos os caminhos |
| `gate_without_agent_origin` | `approval_gate` alcançável por algum caminho que não passa por nenhuma etapa de agente |
| `timeout_out_of_range` | `timeoutSec` fora de 60 a 2.592.000 |
| `form_without_questions` | `input_form` sem perguntas |
| `output_key_conflict` | Duas etapas declaram a mesma chave de saída sem ser uma devolução da mesma etapa |

## Executável

Uma versão é executável quando todas as etapas usam os tipos desta fase e passam nas regras acima; caso contrário o alvo de rotina cria só a tarefa, como na spec 001.
