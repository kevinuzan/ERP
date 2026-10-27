# Contexto do projeto ERP-1 — instruções pra IA

Cole este texto nas instruções/contexto do projeto. Ele resume tudo que já foi construído e as convenções que precisam ser seguidas pra não reintroduzir bugs já corrigidos.

## O que é

"ERP-1" é um app de finanças pessoais (PWA) usado por um casal: **Ana / Any** (a usuária) e **Kevin** (o marido). Hospedado no **Railway**. Código em `C:\Users\Kevin\Documents\GitHub\ERP-1` (máquina Windows do Kevin).

## Stack

- Backend: Node/Express, arquivo único `server.mjs`. Conexão com **MongoDB**.
- Frontend: HTML+JS puro (sem framework/build step). `public/index.html` + `public/src/app.js`. Tailwind via CDN. Chart.js pra gráficos de pizza.
- PWA: `public/service-worker.js` com cache do app shell.
- Chat com IA: usa a **API da Anthropic** (`@anthropic-ai/sdk`), modelo `claude-haiku-4-5-20251001` (constante `CLAUDE_MODEL`).

## Estrutura de dados (MongoDB)

- `transactions` (`transactionsCollection`) — aba **Geral**: salário/receitas e despesas fixas/recorrentes do casal (ex: aluguel, "Fatura Unique" do cartão). Tem sistema de recorrência (`isRecurrent`, `replicatedFromId`) que replica a transação automaticamente mês a mês via `replicateRecurringTransactions(year, month)`.
- `individual_expenses` (`individualCollection`) — aba **Individual**: gastos do dia a dia, divididos entre `Kevin`, `Any` ou `Conjunto` (constante `OWNERS_VALIDOS`). Tem o conceito de "mês de referência" (`anoReferencia`/`mesReferencia`), separado da data real da compra (`dataCompra`), por causa do sistema de fechamento de fatura (ver abaixo).
- `chat_messages` (`chatCollection`) — histórico de mensagens do chat (log, não é usado como memória da IA — ver seção "Chat" abaixo).
- `subscriptions` — inscrições de push notification (Web Push/VAPID).
- `consorcios` — feature antiga de simulador de consórcio; a UI foi removida, mas a rota/coleção ainda existe no backend (código morto, cuidado ao tocar).

## As duas abas e como se conectam

- **Geral**: visão do casal como um todo — salário, contas fixas, saldo do mês (receitas − despesas).
- **Individual**: gastos variáveis do dia a dia, no cartão, divididos entre as pessoas.
- **Ponte entre as duas**: existe uma despesa recorrente na Geral chamada exatamente **"Fatura Unique"** (o cartão de crédito deles). Todo gasto lançado pelo chat (na coleção Individual) **soma automaticamente** no valor dessa despesa no mês correspondente (função `somarFaturaUnique`). Se não existir uma "Fatura Unique" naquele mês, o chat avisa com ⚠️ na resposta, mas o gasto é registrado normalmente mesmo assim.
- Sistema de **"mês de referência" / fechamento de fatura**: tem um toggle "vale pro mês seguinte" — quando ativado, gastos lançados contam pro mês seguinte em vez do mês real atual. Isso é controlado por `calcularReferencia()`/`getEstadoFatura()` e é a razão de existir `anoReferencia`/`mesReferencia` separados da data real.

## Chat com IA — cuidados importantes

O chat (`POST /api/chat/message`) usa tool calling com estas ferramentas (`CHAT_TOOLS`):
- `registrar_gasto` / `registrar_gasto_parcelado` — registra gasto(s) na aba Individual (e soma na Fatura Unique).
- `consultar_gastos` — responde perguntas sobre a aba Individual (gastos do dia a dia).
- `consultar_geral` — responde perguntas sobre a aba Geral (salário, saldo, contas fixas).

**⚠️ NÃO adicione "memória"/histórico de conversa multi-turno a esse endpoint sem muito cuidado.** Isso já foi tentado e causou um bug sério: a IA passou a só *copiar o texto de confirmação* de um gasto anterior (ex: "✅ Presente — R$ 150,00...") em vez de chamar a ferramenta de novo — ou seja, dizia que tinha registrado mas não registrava nada no banco. A funcionalidade foi revertida por completo. Cada mensagem do chat hoje é tratada isoladamente (sem histórico), e é assim que funciona corretamente.

## Convenções de deploy (OBRIGATÓRIAS)

1. **Cache do Service Worker**: `public/service-worker.js` tem `const CACHE_NAME = 'financas-pwa-vX.Y'`. Bump esse número em **toda** alteração de arquivo que o service worker cacheia (`index.html`, `app.js`, etc.) — exceto quando a mudança é só no backend (`server.mjs`), onde não precisa bumpar. **Sempre informar o novo valor do cache pro usuário na resposta final.**
2. **Fluxo de edição de arquivos** (projeto acessado via bridge pro PC do Kevin):
   - Editar os arquivos localmente (`/mnt/user-data/outputs/...`).
   - Validar sintaxe (`node --check`) antes de comitar.
   - `device_commit_files` pra escrever no device.
   - **SEMPRE verificar depois**: `device_stage_files` do mesmo caminho + `diff` contra a cópia local. Esse `device_commit_files` tem um bug recorrente de "stale write" (reporta sucesso mas não escreve o conteúdo novo) — principalmente em `service-worker.js`. Se o diff não bater, repetir o commit com `force: true` e verificar de novo.
3. Depois de tudo verificado, avisar o usuário que falta só o `git push` da pasta do projeto pra ir pro ar no Railway (o deploy em si não é automatizado por aqui).

## Armadilhas já conhecidas (não reintroduzir)

- **Modal + `position: fixed` dentro de ancestral com `transform` (CSS)**: um elemento com `transform` ativo (mesmo só no `:hover`, como a classe `.card-elevate` deste projeto) vira o "containing block" de qualquer descendente `position: fixed`, quebrando modais que deveriam cobrir a tela inteira. Modais (`#modal-edit-ind`, `#disney-modal`, `#editModal`) precisam ficar como filhos diretos de um container sem `transform`, nunca dentro de um card com hover/elevação.
- **Conexões MongoDB**: usar sempre o `sharedDb` compartilhado (definido uma vez em `connectDB()`), nunca criar `new MongoClient()` por requisição — isso já causou uma fatura alta de Network Egress no Railway por conexões vazadas.
- **Rede do Mongo**: preferir `process.env.MONGO_URL` (privada, dentro do projeto Railway, sem custo de egress) sobre `MONGO_PUBLIC_URL`.
- **Queries sem filtro de data em jobs recorrentes** (ex: cron diário de notificação push): carregar a coleção inteira todo dia é o tipo de coisa que gerou aumento de uso de memória no Railway. Sempre filtrar por uma janela de datas razoável.
- **Dark mode**: o projeto usa Tailwind via CDN com classes fixas (`bg-white`, `text-gray-800` etc.), sem variantes `dark:`. O modo escuro é feito via overrides manuais em CSS (`html.dark .bg-white { ... }`). Toda cor nova usada em algum card/badge (ex: `bg-green-100`, `bg-amber-50`) precisa ganhar seu override em `html.dark` também, senão fica um retângulo pastel claro berrando num fundo escuro.
- Chart.js também não se adapta ao tema sozinho — as cores de legenda/texto do gráfico são setadas manualmente via `Chart.defaults.color` conforme o tema ativo (função `aplicarTemaNosGraficos()`), e o gráfico precisa ser recriado ao trocar de tema (não só a classe CSS).

## Pendências conhecidas (não resolvidas ainda)

- Havia um arquivo estranho e não relacionado (`Core-Temp-setup-v1.19.5.69.exe`, um instalador de monitor de temperatura de CPU) dentro de `public/icons/` — pasta servida publicamente. Foi pedido para o usuário apagar manualmente; não há confirmação se isso já foi feito.
- `public/icons/icon-192.png` e `icon-512.png` são dois arquivos idênticos de 224KB cada (provavelmente cópias não otimizadas/redimensionadas corretamente) — baixa prioridade, só mencionar se for relevante.

## Estilo de comunicação

A usuária escreve em português informal, geralmente direto ao ponto, as vezes com vários pedidos numa mensagem só. Prefere que o assistente aja com autonomia em decisões de design/UX quando ela pede algo vago ("dá uma repaginada", "faz bonito"), mas é específica e técnica quando descreve um bug. Gosta de confirmação do valor do cache do service worker e de um resumo claro do que mudou ao final de cada ajuste.
