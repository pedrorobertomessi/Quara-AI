# Correções de estabilidade — setembro/2026

O sintoma relatado foi "o chatbot está instável, está caindo muito". A investigação separou isso em
quatro causas independentes, que produziam o mesmo sintoma por caminhos diferentes. Duas derrubavam
o processo inteiro; uma derrubava só o chat, de forma progressiva; uma não derrubava nada, mas fazia
um servidor saudável parecer fora do ar.

Arquivos alterados: `db.js`, `chat.js`, `server.js`, `package.json`, `DEPLOY.md`.
Arquivo novo: `test_contexto.js`.

---

## 1. O processo morria quando uma conexão ociosa do Postgres caía

**Arquivo:** `db.js`

O `Pool` do `pg` é um `EventEmitter`. Quando uma conexão que está **parada** no pool morre — o banco
reinicia, a rede oscila, o plano gratuito do Render encerra o socket — o pool emite `'error'`. Um
`EventEmitter` que emite `'error'` sem nenhum listener registrado faz o Node lançar uma exceção não
capturada, e o processo inteiro morre, levando junto todas as requisições em andamento.

Não era erro de nenhuma requisição. Era uma conexão parada caindo sozinha, e não havia motivo para
isso derrubar o servidor.

**O que foi feito:**

- `pool.on('error', ...)` registrado — a conexão é descartada e o servidor segue de pé.
- Reciclagem preventiva de conexões: `idleTimeoutMillis`, `maxLifetimeSeconds`, `keepAlive`. Melhor
  fechar uma conexão ociosa antes de o outro lado fechá-la por conta própria do que descobrir que
  ela morreu na hora de usar.
- `connectionTimeoutMillis` e `max` explícitos.
- Retentativa automática (uma vez, após 300ms) em erro de **conexão** — `ECONNRESET`, classe `08`,
  `57P01` e afins. Erro de **SQL** (sintaxe, constraint) não é retentado: repetir não muda o
  resultado e só mascararia bug.

## 2. `transaction()` trocava a causa do erro e devolvia conexão suja ao pool

**Arquivo:** `db.js`

Se a conexão caía no meio de uma transação, o `ROLLBACK` no `catch` também falhava. Esse segundo
erro subia no lugar do primeiro, trocando a causa real ("violação de constraint X") por um genérico
"Connection terminated" — escondendo o problema de verdade de quem fosse depurar depois. Pior: o
`client.release()` sem argumento devolvia ao pool uma conexão possivelmente ainda dentro de uma
transação aberta, que contaminaria a próxima requisição a pegá-la.

**O que foi feito:** o `ROLLBACK` ganhou seu próprio `try/catch`, o erro original é preservado, e a
conexão é destruída com `release(err)` quando o rollback falha.

## 3. O chat "caía" de forma progressiva dentro de cada conversa

**Arquivo:** `chat.js` — esta é a correção mais importante para o sintoma relatado.

O histórico crescia sem limite. Cada resultado de ferramenta (até 24.000 caracteres) entrava nele e
nunca mais saía, e o histórico inteiro era reenviado ao modelo **a cada mensagem**. Duas ou três
perguntas que usassem ferramentas já somavam dezenas de milhares de tokens por requisição.

O que acontece a partir daí não é aleatório, é determinístico: o limite de tokens por minuto da
conta estoura, a API devolve 429/413, o servidor traduzia isso como "O chat está indisponível no
momento", e como o histórico só cresce, **toda** mensagem seguinte daquela conversa falhava igual.
Parecia instabilidade; era a conversa tendo engordado além do que a cota aguenta.

**O que foi feito:**

| Teto | Valor | Para quê |
|---|---|---|
| `MAX_CHARS_RESULTADO` | 12.000 | resultado de ferramenta no passo em que foi pedido |
| `MAX_CHARS_RESULTADO_HISTORICO` | 2.500 | o que sobra dele nas mensagens seguintes |
| `MAX_CHARS_LOTE_FERRAMENTAS` | 40.000 | soma dos resultados de um mesmo passo |
| `MAX_CHARS_HISTORICO` | 45.000 | conversa acumulada (~11k tokens) |
| `MAX_MENSAGENS_HISTORICO` | 40 | teto absoluto de mensagens |

A função `podarHistorico()` faz o corte. **A regra que ela não pode violar:** uma mensagem `tool`
precisa vir logo depois da mensagem do assistente que pediu aquela ferramenta. Cortar no meio de um
par desses deixa um `tool_call_id` órfão, e a API rejeita a requisição inteira com 400 — o corte
"para economizar" derrubaria o chat de um jeito pior que o problema que veio resolver. Por isso o
corte só acontece em mensagem de `user`, que é sempre começo de turno seguro.

Também passaram a ser descartados os campos que o modelo devolve e que só serviam para aquele
instante (o rascunho de raciocínio do `gpt-oss` pode ser maior que a própria resposta).

**Medido no teste:** 729.000 caracteres de histórico → 28.000 depois da poda, com os pares
`assistant`/`tool` intactos e o fim da conversa preservado.

## 4. Faltava `max_tokens` — a reserva sozinha estourava a cota

**Arquivo:** `chat.js`

O Groq reserva o teto **pedido** de saída contra o limite de tokens por minuto **antes** de gerar
qualquer coisa. Sem `max_tokens` explícito, a reserva é o máximo do modelo (dezenas de milhares de
tokens), o que sozinho pode estourar a cota de uma conta gratuita e voltar como erro sem ter gerado
uma única palavra.

Agora: `max_tokens: 1500` nos passos intermediários (que só emitem chamadas de ferramenta) e `3000`
no passo final (que escreve a resposta para a pessoa).

## 5. Resposta vazia do modelo virava `TypeError`

**Arquivo:** `chat.js`

`resposta.choices[0]` sem verificação. Resposta sem `choices` acontece de verdade (corte de conexão,
resposta de erro que ainda vem com 200), e virava "Cannot read properties of undefined", que o
`server.js` traduzia como "o chat está indisponível" — mensagem errada para um problema pontual.

Agora, se já houve passos úteis, o turno aproveita o que foi levantado em vez de ser jogado fora. E
conteúdo em branco vira uma frase honesta em vez de bolha vazia na tela.

## 6. Um cliente Groq novo a cada requisição

**Arquivo:** `chat.js`

Cada requisição criava um `new Groq()`, e com ele um pool de conexões HTTP novo, que ficava aberto
esperando o coletor de lixo. Agora é um cliente por chave, reaproveitado, com `timeout` de 45s e
`maxRetries: 2` (o SDK respeita o `retry-after` de um 429).

## 7. Vazamento de memória nas ações pendentes

**Arquivo:** `server.js`

Uma pendência que ninguém confirmava ficava guardada para sempre, junto com o contexto inteiro da
tela que veio com ela (tabela de preços, configuração). Numa instância pequena isso é um vazamento
lento e silencioso: a memória sobe até o serviço ser morto por falta dela, o que de fora parece uma
queda aleatória.

Agora: validade de 30 minutos (um cartão de confirmação que passou disso não seria confirmado mesmo)
e teto de 200 pendências.

## 8. Erros chegavam ao navegador como HTML

**Arquivo:** `server.js`

O Express 5 encaminha para o tratador de erros as promessas rejeitadas das rotas `async`, então o
servidor não morria por causa delas. Mas o tratador **padrão** responde HTML, e quase toda rota
deste projeto é consumida por um `fetch(...).then(r => r.json())` no navegador: a resposta de erro
em HTML quebrava o parse no cliente e virava "não foi possível falar com o servidor" na tela — a
mensagem de servidor fora do ar para um servidor perfeitamente de pé.

O mesmo valia para rota de API inexistente, que caía no coringa da SPA e devolvia a página inteira.

**O que foi feito:** middleware central de erro respondendo JSON (com tratamento específico para
`entity.too.large` e `entity.parse.failed`), e 404 em JSON para qualquer `/api/*` desconhecido.

## 9. Mensagens de erro do chat eram todas iguais

**Arquivo:** `server.js`

Tudo virava a mesma frase, e é por isso que o problema ficou tanto tempo sem diagnóstico: "cota da
conta estourou", "essa conversa ficou longa demais" e "a chave está errada" pedem três providências
completamente diferentes, e as três apareciam idênticas na tela. Agora cada uma se identifica, com o
código HTTP correspondente (429, 413, 504).

## 10. Janela de 502 entre o Node e o proxy do Render

**Arquivo:** `server.js`

O proxy na frente do app reaproveita a mesma conexão TCP para várias requisições. O padrão do Node é
fechar a conexão ociosa em 5 segundos — menos do que o proxy espera. Quando os dois lados discordam,
existe uma janela em que o proxy manda uma requisição por uma conexão que o Node acabou de fechar, e
ela volta como 502. É o tipo de erro que aparece "do nada", em requisição nenhuma específica, e que
faz um serviço saudável parecer instável.

Agora: `keepAliveTimeout = 120s` e `headersTimeout = 125s` (precisa ser maior que o primeiro).

## 11. Crash loop na subida e mortes no deploy

**Arquivo:** `server.js`

No Render o app costuma subir **antes** de o Postgres estar aceitando conexões. Falhar de primeira e
chamar `process.exit(1)` ali vira crash loop: o Render reinicia, o banco ainda não está pronto,
morre de novo. Agora a migração tenta 5 vezes com espera crescente.

Todo deploy manda `SIGTERM`. Sem tratar, as requisições em andamento morriam no meio — inclusive a
de alguém que acabou de clicar em "Confirmar". Agora o servidor para de aceitar conexões novas,
termina o que está em curso e só então fecha o pool.

## 12. Rede de segurança do processo

**Arquivo:** `server.js`

A partir do Node 15, uma promessa rejeitada sem `.catch()` **derruba o processo** — mesmo que a
falha tenha sido num detalhe lateral. Foram registrados `unhandledRejection` e `uncaughtException`.

A escolha de **registrar e continuar de pé** é deliberadamente diferente do conselho padrão ("logue
e saia"), que existe para processos que podem ter ficado em estado inconsistente. Não é o caso aqui:
o servidor não guarda estado crítico em memória (a única coisa são as ações pendentes, e perdê-las
já é tratado com mensagem explicando), enquanto morrer significa derrubar todo mundo que estiver
usando. Se a causa for estrutural, ela aparece no log em vez de sumir num reinício.

## 13. Limite de conversas simultâneas

**Arquivo:** `server.js`

Um turno de chat pode gerar imagem (`sharp`), montar um `.pptx` e um `.docx` — cada um aloca dezenas
de MB de uma vez. Várias pessoas mandando mensagem ao mesmo tempo multiplicavam isso até o processo
ser morto por falta de memória, que de fora parece exatamente uma queda. Teto de 4 turnos
simultâneos (configurável em `MAX_CHAT_CONCORRENTE`); o quinto recebe um pedido educado para tentar
de novo em alguns segundos.

## 14. `/api/health` agora responde a pergunta certa

**Arquivo:** `server.js`

"O processo está vivo" nunca foi a pergunta interessante: o modo de falha real é o app de pé e o
Postgres fora, e nesse estado o health antigo respondia `ok: true` alegremente.

Agora inclui `banco` (com um `SELECT 1` de verdade), `uptimeSegundos`, `memoriaMB`, `chatsEmVoo` e
`pendencias`. **Se o uptime for sempre pequeno, o processo está reiniciando** — é o primeiro lugar a
olhar se a instabilidade voltar.

## 15. Número errado no `DEPLOY.md`

O guia afirmava um limite de 14.400 requisições/dia. Esse número é de outro modelo
(`llama-3.1-8b-instant`); o `gpt-oss-120b` tem cerca de 1.000/dia. Mais importante: o guia só falava
de limite por requisição, e o que aperta primeiro é o de **tokens** — que é exatamente o que a causa
nº 3 estourava. A seção foi reescrita explicando que cada mensagem reenvia a conversa inteira.

---

## Testes

`test_contexto.js` é novo e não precisa de banco nem de rede. Cobre a poda: que ela encolhe, que
nunca deixa `tool_call_id` órfão, que preserva o fim da conversa, que compacta resultados antigos,
que descarta prefixo órfão vindo de front-end desatualizado.

```bash
npm run test:logica   # lógica pura + poda de contexto — sem banco, sem rede
npm test              # tudo (precisa de DATABASE_URL apontando para um Postgres)
```

O que foi verificado durante a correção: os 76 testes de lógica existentes continuam passando; as 11
verificações novas da poda passam; o loop do chat foi exercitado com cliente falso (turno normal,
resposta sem `choices`, conteúdo em branco, histórico gigante); e com o banco propositalmente fora do
ar o processo continua de pé, o health reporta `banco: erro` e as rotas respondem JSON.

**Não foi possível rodar aqui** `test_api.js`, `test_concurrency.js`, `test_gg.js`, `test_chat.js` e
`test_ferramentas.js` — todos precisam de um Postgres. Rode `npm test` contra o banco local antes de
publicar.

## Variáveis de ambiente novas (todas opcionais)

| Variável | Padrão | Para quê |
|---|---|---|
| `PGPOOL_MAX` | 8 | conexões simultâneas no pool |
| `GROQ_TIMEOUT_MS` | 45000 | quanto esperar o modelo antes de desistir |
| `MAX_CHAT_CONCORRENTE` | 4 | turnos de chat simultâneos por instância |
