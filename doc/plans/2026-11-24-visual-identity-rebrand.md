# Agent OS: plano de nova identidade visual

Nov 24, 2026 · @Andre Abreu

Revisado em 2026-11-24 contra o `master` (`1a57a2abec`).

## Resumo

Trocar a identidade visual do Agent OS é viável sem reescrever componentes: o projeto já tem uma fonte única de tokens (`ui/src/index.css`, Tailwind v4 + nomes do shadcn), uma régua de raio controlada por um único `--radius`, uma régua tipográfica nomeada e 512 screenshots de referência no Storybook para provar cada mudança. O que falta é a cor de marca. A linguagem de design (superfícies, raio, tipografia, status) foi aprovada na Tune session de 6 de julho de 2026, e o `DESIGN.md` traz uma paleta neutra "Paper Dark" ainda em proposta. Mesmo assim `--primary` segue cinza neutro, a fonte é Inter, e o logo e o nome "Paperclip" estão espalhados.

A dívida que realmente atrapalha um rebrand é de entre ~3.100 e ~3.800 classes de paleta do Tailwind (`bg-amber-500`, `text-red-600`…) em ~170 arquivos, que não respondem aos tokens. Recomendação: definir a direção visual primeiro, trocar os tokens semânticos e a tipografia numa primeira leva (fundo, texto, botões, cards, bordas e sidebar mudam de uma vez), e depois migrar as classes de paleta por grupo de cor, começando por âmbar e vermelho.

## Onde o estilo vive hoje

Tudo que é visual passa por poucos lugares; os dois últimos da tabela são onde a marca vaza para fora dos tokens.

| O quê | Onde | Estado |
| --- | --- | --- |
| Tokens semânticos (fundo, texto, primary, muted, border, ring, sidebar, chart-1..5) | `ui/src/index.css`: `:root` (linha ~211) e `.dark` (linha ~675), mapeados em `@theme inline` (linha ~156) | OKLCH, cinza neutro padrão do shadcn; pronto para receber a nova paleta |
| Proposta de cor Paper Dark | `DESIGN.md` ("Proposed color foundation"), tokens `--background-alt`, `--muted-highlight`, `--muted-alt` | Neutra, sem cor de marca. Escopada em `.design-proposal-theme` no dark; o claro segue o shadcn padrão. "Proposed until visual approval" |
| Raio | `--radius: 0.5rem` em `index.css`; sm a 4xl derivados por multiplicação | Um único botão controla todos os cantos |
| Tipografia | `@font-face` em `index.css` (Inter Variable e Paper Mono), arquivos em `ui/public/fonts/`; `--font-sans`, `--font-heading`, `--font-mono`; régua `--text-nano/micro/compact` e `--tracking-*` | Nomeada e limpa (só 1 `text-[Npx]` restante) |
| Movimento | `ui/src/motion-tokens.css` | Separado e importado por `index.css` |
| Status (running, todo, blocked, done…) | `--status-task-*` e `--status-agent-*` em `index.css`; helpers em `ui/src/lib/status-colors.ts` | Sistema único, ajustado para WCAG |
| Cores de agente (avatares em gradiente) | `--agent-1a..10b` em `index.css`, sincronizado por `scripts/sync-agent-palette-tokens.mjs` | 20 hex fixos de marca |
| Tema claro/escuro | `ui/src/context/ThemeContext.tsx` (classe `.dark`, `theme-color` `#18181b`/`#ffffff`) | Só claro/escuro, sem temas extras |
| Componentes base | `ui/src/components/ui/` (29 primitivos shadcn: button, card, badge, dialog…) | Consomem tokens |
| Ícones | `lucide-react` em 641 arquivos; nenhuma outra biblioteca | Consistente; troca de set seria grande |
| Logo e app icons | `ui/src/components/AnimatedPaperclipIcon.tsx` (9 usos), `ui/public/favicon*.svg/png/ico`, `apple-touch-icon.png`, `android-chrome-*.png`, `paperclip-thinking.svg`, `worktree-favicon*`, `docs/favicon.svg` | Espalhado, sem componente de marca único |
| Nome da marca | `ui/index.html`, `ui/public/site.webmanifest`, ~1.480 ocorrências de "Paperclip" no código da UI (texto, chaves de storage, classes CSS) | Hardcoded; i18n quase não carrega o nome |
| Classes de paleta Tailwind | ~3.100 a 3.800 ocorrências em ~145 a 180 arquivos, conforme o regex (DECISION-SHEET B2: 3.115 em 145; top do levantamento original: amber 1.224, red 496, emerald 355, blue 313, green 229). Fixar o critério no codemod | Fora dos tokens: não mudam com o rebrand |
| Hex soltos | ~80 em código `.ts/.tsx` (fora de testes), muitos em `status-colors.ts` e gráficos | Parte já allowlisted como decoração |

Guarda-corpos que já existem: `pnpm check:token-gates` (bloqueia valores fixos novos), `pnpm test:storybook-visual` (diff de 512 screenshots claro/escuro) e as stories de Storybook "Design proposals → Foundations → Colors". O `ui/src/artifact-directions/` (d1 a d5) é um laboratório de tratamento de cards de artefatos, não de direções de marca do app. O playground de temas com export `*.theme.json` (`doc/design/PRIOR-ART.md`, branch `PAP-282-playground`) não está no `master`.

## Avaliação

A estrutura está madura; a cor de marca está vazia de propósito. O `DESIGN.md` (v0.3) diz que cor, tipo e iconografia "entrarão só como valores de token". O `doc/design/DECISION-SHEET.md` registra a Tune session fechada em 6 de julho ("complete new design language" aprovada, 296 snapshots re-baselined) e o B4 (raio) **fechado** em 8 de julho, com a escada multiplicativa ancorada em `--radius: 0.5rem`. A paleta "Paper Dark" do `DESIGN.md` é neutra e continua como proposta; light e dark estão assimétricos (o claro é o shadcn padrão).

**O que já ajuda o rebrand**

- Uma única fonte de tokens, com regra escrita proibindo uma segunda (`ui/src/tokens/` não deve existir).
- Nomes shadcn: um tema gerado em ui.shadcn.com/create entra como valores de variável (receita 2 de `doc/design/CHANGING-THE-UI.md`).
- Raio, tipografia e status já são "um botão, o app inteiro muda".
- Prova visual automática: cada token alterado gera before/after/diff por story.

**O que atrapalha**

1. **Classes de paleta Tailwind (~3.100 a 3.800).** Avisos, chips, barras e alertas usam `amber-*`, `red-*`, `emerald-*` direto. Uma nova paleta não chega neles. Já está aprovado como "Run 4" (DECISION-SHEET B2), mas nunca foi feito.
2. **Neutro sem identidade.** `--primary` é `oklch(0.205 0 0)` (quase preto) e os gráficos `--chart-*` são cinzas. Mudar só isso já dá cara nova, mas exige checar contraste com os status.
3. **Logo sem componente único.** O ícone animado, favicons, PWA icons, docs e o SVG "thinking" são arquivos separados; o nome "Paperclip" aparece ~1.480 vezes e também está em chaves de storage (`paperclip.theme`) e classes CSS (`.paperclip-offline`), que não devem ser renomeadas junto com o texto.
4. **`@theme inline` congela valores.** Tokens que precisarem mudar em runtime (temas além de claro/escuro, tema por empresa) têm que ficar fora do bloco inline.
5. **Detalhes fixos fora do CSS:** `theme-color` em `ThemeContext.tsx`, pares de contraste em `ui/src/lib/color-contrast.ts` e `worktree-branding.ts`, ~80 hex em `.ts/.tsx`.
6. **Escopo do repo.** Além de `ui/`, há `docs/` (site com `docs.json` e favicon próprio) e o CLI; precisam de um passe separado se a marca mudar de nome.

## Plano em etapas

Sete etapas, cada uma um PR próprio, verificado com `pnpm check:token-gates` e `pnpm test:storybook-visual`. As etapas 0 e 1 são decisão; as 2 e 3 já entregam a nova cara; 4 a 6 eliminam o que sobrou fora dos tokens.

1. **Etapa 0: direção visual.** Decidir se a proposta neutra Paper Dark vira produção em claro e escuro, e escolher a cor de marca (primária e acento), fonte de texto e de título, estilo de ícone e se o nome muda. O raio já está fechado. Ferramenta: stories novas em Storybook sobre os tokens atuais, ou recuperar o playground de temas da branch `PAP-282-playground`, para comparar 2 ou 3 propostas com a tela atual.
2. **Etapa 1: tokens de marca.** Criar `ui/src/brand.css`, importado no topo de `index.css`, com a paleta crua da marca (ex.: `--brand-50..950`, `--brand-accent-*`, neutros). Nenhuma tela muda ainda. Arquivos: `ui/src/brand.css` (novo), `ui/src/index.css` (só o `@import`), `DESIGN.md` (preencher a seção de marca).
3. **Etapa 2: tokens semânticos e tipografia.** Apontar `--background`, `--foreground`, `--primary`, `--secondary`, `--muted`, `--accent`, `--border`, `--ring`, `--sidebar-*` e `--chart-1..5` para a paleta da marca, em `:root` e `.dark`. Trocar `@font-face`, `--font-sans` e `--font-heading` (se o título tiver fonte própria) (o `--radius` já está fechado em 0.5rem). Arquivos: `ui/src/index.css`, `ui/public/fonts/` (+ `NOTICE.md` de licença), `ui/src/context/ThemeContext.tsx` (`theme-color`), `ui/index.html` (fundo do splash). Re-baseline dos 512 screenshots após revisão.
4. **Etapa 3: logo, nome e ícones do app.** Criar um componente único `BrandMark` em `ui/src/components/` que substitui `AnimatedPaperclipIcon` nos 9 usos; regenerar `favicon.svg/ico`, `favicon-16/32`, `apple-touch-icon`, `android-chrome-192/512`, `worktree-favicon*`, `paperclip-thinking.svg`, `docs/favicon.svg`; atualizar `site.webmanifest` e `<title>`. Se o nome mudar, criar uma constante `APP_NAME` e trocar só o texto visível, mantendo chaves de storage, rotas e classes CSS.
5. **Etapa 4: status e cores de agente.** Revisar `--status-task-*`, `--status-agent-*` e `--agent-1a..10b` contra a nova primária (contraste WCAG e choque de matiz, ex.: azul "running" vs primária azul). Arquivos: `ui/src/index.css`, `ui/src/lib/status-colors.ts`, `scripts/sync-agent-palette-tokens.mjs`.
6. **Etapa 5: migrar classes de paleta (Run 4).** Criar tokens semânticos de feedback (`--warning`, `--success`, `--info`, `--danger` com `-foreground`, `-muted`, `-border`) e trocar as ~3.100 a 3.800 classes por grupo: amber (1.224), red (496), emerald+green (584), blue+sky (451), resto. Um codemod por grupo, no padrão de `scripts/codemod-type-ladder.mjs`. Depois, ligar a regra de bloqueio de classes de paleta em `scripts/check-token-gates.mjs`.
7. **Etapa 6: limpeza final.** Hex restantes em `.ts/.tsx` (gráficos, `color-contrast.ts`, `worktree-branding.ts`), toasts (DECISION-SHEET C9), site `docs/` e cores do CLI, se fizerem parte da marca.

Ordem alternativa a avaliar: fazer a etapa 5 (migrar classes de paleta) antes da etapa 2. Trocar `--primary` enquanto milhares de classes seguem na paleta antiga deixa a UI incoerente durante vários PRs. A etapa 1 (`brand.css`) também cria uma terceira camada de tokens; o `DESIGN.md` proíbe um segundo arquivo de tokens, então o princípio precisa ser atualizado na mesma PR.

O estilo de ícone fica em lucide-react: trocar de biblioteca mexe em 641 arquivos para pouco ganho. Se a direção pedir outro traço, ajuste `strokeWidth` e tamanho num wrapper `Icon` em vez de trocar o set.

## Referência no upstream

Levantamento em `paperclipai/paperclip`. Decisão: **a marca fica só no fork**. Isso muda o cálculo de custo: cada arquivo de UI que o rebrand edita conflita com qualquer PR do upstream que toque o mesmo arquivo.

- **#9000 (fechada por inatividade).** Hooks de white-label em runtime: `PAPERCLIP_BRAND_DIR` serve um `brand.css` montado pelo deployer sob `/branding` e `PAPERCLIP_DEFAULT_THEME` define o tema inicial, sem rebuild. É a opção de menor conflito para trocar valores de token: um arquivo CSS fora de `ui/src`. Vale como alternativa ao `ui/src/brand.css` da etapa 1, se a marca for só valores de token. Não resolve logo, nome nem as classes de paleta.
- **#12291 (mergeada).** O upstream removeu a cor de marca por empresa ("changes one icon hue"). Cor por empresa está descartada.
- **#9134 (mergeada).** Origem do sistema de tokens único e do teste visual. Alinhado com este plano.
- **Estratégia de merge para a etapa 5.** O codemod de ~3.100 a 3.800 classes toca ~145 a 180 arquivos. Rodá-lo logo depois de um merge do upstream e fazer o PR curto reduz o conflito. Rodar `pnpm check:token-gates` e o teste visual depois do merge, não só antes.

## Como centralizar tokens

Mantenha uma raiz só (`index.css`) e separe a marca em três camadas, cada uma referenciando apenas a de cima. Assim, um rebrand futuro vira editar um arquivo.

| Camada | Arquivo | Conteúdo | Quem usa |
| --- | --- | --- | --- |
| 1. Primitivos de marca | `ui/src/brand.css` (novo, importado por `index.css`) | Paleta crua (`--brand-500`, `--neutral-100`…), famílias de fonte, `--radius` | Só a camada 2 |
| 2. Semânticos | `ui/src/index.css` (`:root` e `.dark`) | `--primary`, `--background`, `--warning`, `--status-*`, `--chart-*`, `--sidebar-*` | Componentes, via Tailwind (`bg-primary`, `text-warning`) |
| 3. Componente | `ui/src/index.css` (blocos existentes, ex.: `--side-panel-*`, `--radius-task-composer`) | Ajustes de um componente, sempre derivados da camada 2 | O componente dono |

Regras práticas:

- Componentes nunca usam `--brand-*` diretamente; só semânticos. Isso permite trocar a marca sem tocar em `.tsx`.
- Primitivos que mudam em runtime (tema extra, cor por empresa) ficam em `:root`, nunca em `@theme inline`, que congela valores no build.
- Tema dark é só reatribuição da camada 2 dentro de `.dark`; a camada 1 não muda por tema.
- Valores de marca usados em TypeScript (canvas, `theme-color`, gráficos) são lidos com `getComputedStyle` ou espelhados por script de sync com `--check` no CI, como já é feito em `sync-agent-palette-tokens.mjs`.
- `scripts/check-token-gates.mjs` ganha duas regras: proibir `--brand-*` fora de `index.css` e proibir classes de paleta Tailwind depois da etapa 5.

## Decisões que dependem do Andre

- [ ] A paleta Paper Dark do `DESIGN.md` é a identidade ou só a base neutra? Ela vira produção nos dois temas?
- [ ] Direção visual: tem referências, cores ou um logo já definidos, ou quer que eu proponha 2 ou 3 direções em Storybook?
- [ ] O nome "Paperclip" continua, ou a marca passa a ser "Agent OS"?
- [ ] Só a UI web (`ui/`), ou também o site de docs e o CLI?
- [ ] Manter Inter e Paper Mono, ou trocar fontes (e com qual licença)?
- [ ] Haverá temas extras além de claro e escuro? Isso muda onde os tokens ficam (etapa 1). Cor por empresa está descartada (upstream removeu em #12291).
- [x] Fork do Paperclip: decidido manter só no fork. Custo de merge tratado na seção "Referência no upstream".
