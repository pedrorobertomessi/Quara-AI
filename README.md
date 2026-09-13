# Quara AI — servidor compartilhado

Backend da Quara AI para a Paulista Jr. Começou como o lugar onde o histórico de preços, as
sugestões aplicadas e os limiares aprendidos passaram a viver juntos, em vez de isolados no
`localStorage` do navegador de cada diretor. Hoje é também o lugar onde a Quara projeta caixa,
pesquisa na web, consulta processos no CNJ e gera contrato, apresentação e imagem.

Usa Postgres (via Render Postgres em produção) como banco de dados — não SQLite local — porque o
plano gratuito do Render não permite anexar disco persistente a um serviço web gratuito. Veja
`DEPLOY.md` para o porquê disso importar e como isso é resolvido na prática (backup/restauração).

## O que a Quara sabe fazer

O chat tem 27 ferramentas, agrupadas assim:

| Área | O que dá para pedir |
|---|---|
| **Preços e histórico** | consultar a tabela de serviços, ver o histórico de vendas, estatísticas por serviço (média, mediana, faixa), os limiares aprendidos, registrar um preço praticado |
| **Projetos de GG** | listar projetos aprovados, calcular custo e preço sugerido de uma equipe hipotética, comparar com projetos parecidos, registrar uma aprovação |
| **Financeiro** | projetar faturamento (3 cenários), projetar fluxo de caixa mês a mês, cadastrar custos fixos e recebimentos, ponto de equilíbrio, simular parcelamento |
| **Pesquisa** | buscar na web e ler o conteúdo de uma página |
| **Processos judiciais** | consultar um processo público pelo número CNJ, buscar processos por classe/vara/assunto |
| **Imagens** | gráficos e capas na identidade visual da empresa, e ilustração a partir de uma descrição |
| **Apresentações** | montar um `.pptx` com a marca da EJ, com gráficos nativos editáveis |
| **Contratos** | gerar o contrato de prestação de serviços em `.docx`, com papel timbrado e as cláusulas do modelo oficial |

Ferramentas podem ser **encadeadas numa mesma mensagem**: "projete o faturamento e monte um deck
com isso" vira, sozinho, uma projeção, um gráfico e uma apresentação. O teto é de 6 passos por
mensagem.

### A regra que não muda

Leitura executa direto. **Escrita nunca executa na mesma resposta em que foi pedida.** Aprovar um
projeto, registrar um preço, mexer no planejamento financeiro ou gerar um contrato sempre voltam
como um cartão de confirmação com os parâmetros exatos, e só executam depois que alguém clica em
"Confirmar". O encadeamento de ferramentas foi construído em volta dessa regra: assim que o modelo
pede uma escrita, o loop para ali — as leituras já feitas são aproveitadas, mas nada é gravado.

`test_ferramentas.js` verifica isso com um cliente do Groq falso, sem depender de rede.

## Rodar localmente

Você precisa de um Postgres rodando (local ou remoto) e a variável `DATABASE_URL` apontando para
ele:

```bash
export DATABASE_URL="postgresql://postgres:senha@localhost:5432/quara"
export GROQ_API_KEY="..."      # opcional; sem ela, tudo funciona menos o chat
npm install
npm start
```

Abre em `http://localhost:3000`. As tabelas são criadas automaticamente na primeira execução.
Contra um Postgres em `localhost` o SSL é desligado sozinho (instalação local não tem SSL); para
forçar um dos lados, use `PGSSL=on` ou `PGSSL=off`.

## Rodar os testes

```bash
npm run test:logica   # matemática das projeções, contrato, DataJud — sem banco, sem rede
npm test              # tudo, incluindo os que precisam de Postgres
```

A bateria completa espera `postgresql://postgres:quaratest@localhost:5432/quara_test` — defina
`TEST_DATABASE_URL` para usar outro banco. Nenhum teste consome a API do Groq.

Para os testes de ponta a ponta via navegador real (mais lentos, exigem Playwright instalado):

```bash
python3 test_e2e_playwright/test_e2e.py
python3 test_e2e_playwright/test_full_app.py
python3 test_e2e_playwright/test_backup_restore.py
```

## Publicar de verdade (link acessível de qualquer lugar)

Veja `DEPLOY.md` — passo a passo completo para publicar gratuitamente no Render, incluindo como
criar o banco Postgres gerenciado, configurar a `DATABASE_URL`, e o que fazer quando o banco
gratuito expirar (o Render avisa por e-mail; o app tem botões de Backup e Restaurar prontos para
esse momento).

## Estrutura

```
server.js            rotas HTTP (API REST, chat, artefatos, financeiro)
chat.js              o loop de conversa: encadeamento de ferramentas e a regra de confirmação
db.js                schema do Postgres, pool de conexão, helper de transação
gg-logic.js          cálculo e comparação de projetos de GG (puro, sem Express nem banco)

lib/
  marca.js             identidade visual: cores do logo, fontes, dados institucionais
  financeiro-logic.js  matemática de projeção de faturamento e caixa (puro)
  contrato-modelo.js   o contrato oficial da EJ, cláusula a cláusula, parametrizado
  artefatos.js         arquivos gerados, guardados no Postgres com validade de 7 dias

tools/
  index.js           registro central — para adicionar uma capacidade, crie o módulo e some aqui
  precos.js          tabela de preços, histórico, limiares
  gg.js              projetos de Gente e Gestão
  financeiro.js      projeções e lançamentos
  web.js             busca e leitura de páginas
  datajud.js         API pública do CNJ
  imagem.js          gráficos, capas e imagem generativa
  apresentacao.js    geração de .pptx
  contrato.js        geração de .docx

assets/              logo da Paulista Jr (versão normal e clara, para fundo escuro)
public/index.html    o app inteiro (front-end): abas, aba Financeiro, e o chat flutuante
```

Para **adicionar uma capacidade nova**: crie um arquivo em `tools/` exportando uma lista
`FERRAMENTAS` e inclua o módulo na lista `MODULOS` de `tools/index.js`. Nada em `chat.js` nem em
`server.js` precisa mudar.

## Variáveis de ambiente

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DATABASE_URL` | sim | string de conexão do Postgres |
| `GROQ_API_KEY` | não | o chat. Sem ela, o app funciona normalmente e só o chat fica indisponível, com mensagem clara |
| `PORT` | não | porta do servidor (padrão 3000) |
| `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` | não | usa o Google de verdade na busca. Sem elas, cai num buscador alternativo que não pede chave |
| `DATAJUD_API_KEY` | não | chave pública do CNJ. Já vem uma embutida; configure se o CNJ trocar a dele |
| `IMAGEM_PROVEDOR` | não | provedor de imagem generativa (padrão: serviço sem chave) |
| `PGSSL` | não | `on`/`off` para forçar SSL no Postgres |

`GET /api/health` diz quais dessas capacidades estão de fato ativas no ambiente — útil para
descobrir que uma variável ficou de fora do deploy antes de ela falhar na frente de alguém.

## Limites que vale conhecer

- **DataJud** devolve só metadados públicos: capa do processo e movimentações. Não traz o teor das
  peças, nem os nomes das partes, nem processos em segredo de justiça.
- **Busca do Google** tem 100 consultas por dia no plano gratuito. Estourou, cai no alternativo.
- **Arquivos gerados** ficam disponíveis por 7 dias e depois são apagados. Eles não entram no
  backup: backup é para o que a Quara aprendeu, não para entregável que se regera em segundos.
- **Projeção** é projeção. Cada resultado diz o método usado e o grau de confiança — média de três
  meses e regressão sobre doze não valem a mesma coisa, e a Quara é obrigada a dizer qual das duas
  usou.
- **Contrato** sai com as cláusulas do modelo revisado da EJ, com os campos preenchidos. A Quara
  não redige cláusula nova. Confira as partes, o objeto e o valor antes de enviar.
