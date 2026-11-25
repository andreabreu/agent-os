# Contrato: política de execução padrão

## Configuração

- `PATCH /api/companies/{id}` aceita `defaultExecutionPolicy` (objeto ou `null`).
- `PATCH /api/projects/{id}` aceita `defaultExecutionPolicy` (objeto ou `null`).
- Validação com `issueExecutionPolicySchema` ao salvar; inválida devolve `422` e nada é gravado.
- Atividade: `company.default_execution_policy_updated`, `project.default_execution_policy_updated`.
- Leitura do campo segue a regra de autorização a confirmar na primeira tarefa a partir do teste de authz do upstream (#15267); o padrão é não expor a quem não é da gestão.

## Resolução na criação de tarefa

Ordem: política declarada na criação, depois a do projeto, depois a da empresa, senão nenhuma.

Não se aplica quando a origem da tarefa é `routine_execution` nem a tarefas de conversa. Vale para criação por pessoa e por agente.
