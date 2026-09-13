# Como publicar a Quara compartilhada no Render

Este guia assume que você nunca usou o Render antes. São uns 15 minutos, sem cartão de crédito.

**Se você já tinha publicado antes seguindo uma versão anterior deste guia** (a que falava de
"disco persistente"): essa versão estava errada — o Render não permite disco persistente no plano
gratuito. Esta versão usa Postgres em vez disso. Veja a seção "Migrando de uma versão anterior" no
final deste documento.

## O que você precisa saber antes de começar

O banco de dados gratuito do Render (Postgres) **expira 30 dias após ser criado**. Depois disso
você tem 14 dias de carência para fazer upgrade antes de ele ser apagado de vez. O Render avisa por
e-mail nos dois momentos. Isso não é um bug do que construímos — é assim que o plano gratuito do
Render funciona, e por isso o app agora tem botões de **Backup** e **Restaurar** na tela: baixe um
backup periodicamente (mensalmente é uma boa cadência, dado o prazo de 30 dias), e quando o e-mail
de expiração chegar, é só criar um banco novo (passos abaixo) e restaurar o backup mais recente
nele.

## 1. Colocar o código num repositório Git

O Render publica a partir de um repositório GitHub (ou GitLab). Se a Paulista Jr ainda não tem um
repositório para isso:

1. Crie uma conta gratuita em github.com (ou use a conta que a EJ já tenha).
2. Crie um repositório novo — pode ser privado, o Render funciona com repositórios privados.
3. Suba esta pasta inteira (`quara-server/`) para esse repositório, preservando a estrutura de
   pastas (a subpasta `public/` com o `index.html` dentro precisa ir junto). Se você tem o Git
   instalado localmente:
   ```bash
   cd quara-server
   git init
   git add .
   git commit -m "Quara AI compartilhada"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/quara-server.git
   git push -u origin main
   ```
   Se for subir pelo site do GitHub arrastando arquivos, arraste a pasta `public` inteira de uma
   vez (não os arquivos de dentro dela um por um) — senão a estrutura de pastas se perde e o
   servidor não encontra o `index.html` depois de publicado.

## 2. Criar a conta no Render

Acesse render.com e crie uma conta gratuita (dá para entrar direto com a conta do GitHub, o que já
facilita o próximo passo).

## 3. Criar o banco de dados Postgres

Antes de criar o servidor, crie o banco:

1. No painel do Render, clique em **New +** → **Postgres**.
2. Preencha:
   - **Name**: algo como `quara-db`
   - **Region**: escolha uma região — anote qual, porque o servidor web vai precisar estar na
     **mesma região** para se conectar pela rede interna (mais rápido e sem custo de tráfego)
   - **PostgreSQL Version**: pode deixar a versão mais recente sugerida
   - **Instance Type**: **Free**
   - Pode deixar Storage no padrão (1 GB — mais que suficiente; o banco inteiro hoje pesa poucos KB)
3. Clique em **Create Database** e espere alguns minutos até o status virar **Available**.
4. Na página do banco, vá até **Connect** (canto superior direito) e copie a **Internal Database
   URL**. Guarde isso — você vai usar no próximo passo.

## 4. Criar o Web Service

1. No painel do Render, clique em **New +** → **Web Service**.
2. Conecte sua conta do GitHub e selecione o repositório do passo 1.
3. Preencha:
   - **Name**: algo como `paulistajr-quara` (isso vira parte do link final, tipo
     `paulistajr-quara.onrender.com`)
   - **Region**: **a mesma região que você escolheu para o banco no passo 3**
   - **Branch**: `main`
   - **Root Directory**: deixe em branco (a menos que o servidor esteja numa subpasta do
     repositório)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**

## 5. Configurar as variáveis de ambiente

Ainda na tela de criação (ou depois, em **Settings** → **Environment**), adicione:

- **Key**: `DATABASE_URL`
- **Value**: cole a **Internal Database URL** que você copiou no passo 3

### O chat conversacional (opcional, mas recomendado)

A Quara tem um chat que entende linguagem natural, além dos botões de sempre. Ele usa a API
gratuita do Groq — escolhida especificamente por não exigir cartão de crédito nem saldo pré-pago
em nenhuma hipótese (diferente de outros provedores, que passaram a pedir isso mesmo na camada
gratuita). Sem essa chave configurada, o app funciona normalmente — só o chat fica indisponível,
com uma mensagem clara em vez de travar.

**Gerar a chave:**
1. Acesse [console.groq.com/keys](https://console.groq.com/keys) e crie uma conta (login com
   Google funciona, sem pedir cartão).
2. Clique em **Create API Key**.
3. Copie a chave gerada (começa com `gsk_...`).

**Importante sobre segurança:** essa chave nunca deve ser colada em nenhum chat, e-mail, ou
mensagem — trate-a como uma senha. O único lugar onde ela deve ser digitada é diretamente no campo
abaixo, no painel do Render.

**Configurar no Render:**
- **Key**: `GROQ_API_KEY`
- **Value**: cole a chave gerada acima

O modelo usado (`openai/gpt-oss-120b`) tem camada gratuita, e os limites dela são de dois tipos:

- **por requisição**: cerca de 30 por minuto e 1.000 por dia (o número de 14.400/dia que já constou
  aqui é de outro modelo, o `llama-3.1-8b-instant` — não vale para este);
- **por tokens**: um teto de tokens por minuto e por dia, contando pergunta + histórico + resposta.

O segundo é o que aperta primeiro, e é bom entender por quê: **cada mensagem reenvia a conversa
inteira ao modelo**. Uma conversa que já usou ferramentas carrega os resultados delas junto, então a
décima mensagem custa muito mais tokens que a primeira, mesmo sendo do mesmo tamanho na tela. O
servidor agora poda esse histórico automaticamente (ver `podarHistorico` em `chat.js`), que foi
justamente a correção da instabilidade em que o chat funcionava no começo da conversa e passava a
falhar dali em diante.

Consulte os limites reais da conta em console.groq.com/settings/limits — eles mudam, e são por
organização, não por pessoa. Se o limite do dia for atingido, o chat mostra uma mensagem avisando, e
volta a funcionar no dia seguinte; o resto do app (botões, abas) nunca é afetado por isso.

Uma conversa longa demais também pode ser simplesmente encerrada: recarregar a página começa uma
conversa nova, com a janela limpa.

### As outras capacidades (todas opcionais)

Nenhuma das variáveis abaixo é obrigatória. O servidor sobe e funciona sem qualquer uma delas —
cada uma só melhora ou destrava um pedaço específico. Configure as que fizerem sentido e ignore o
resto.

**Busca no Google (`GOOGLE_API_KEY` + `GOOGLE_CSE_ID`)**

Sem essas duas, a busca da Quara funciona mesmo assim, por um buscador alternativo que não pede
chave nenhuma. Com elas, ela usa o Google de verdade, e os resultados ficam bem melhores. O plano
gratuito dá 100 consultas por dia; quando acaba, a Quara volta sozinha para o alternativo em vez de
ficar sem responder.

1. Em [console.cloud.google.com](https://console.cloud.google.com), crie um projeto e ative a
   **Custom Search API**.
2. Em **Credenciais**, gere uma **chave de API** → é o `GOOGLE_API_KEY`.
3. Em [programmablesearchengine.google.com](https://programmablesearchengine.google.com), crie um
   mecanismo de busca marcando **"Pesquisar em toda a web"**. O **ID do mecanismo** é o
   `GOOGLE_CSE_ID`.

**Consulta de processos no CNJ (`DATAJUD_API_KEY`)**

Não precisa configurar nada: a chave pública que o próprio CNJ publica já vem embutida no código. O
CNJ avisa que pode trocá-la a qualquer momento — se um dia a Quara responder que o DataJud recusou
a chave, pegue a atual em
[datajud-wiki.cnj.jus.br/api-publica/acesso](https://datajud-wiki.cnj.jus.br/api-publica/acesso/) e
ponha nesta variável. Não precisa fazer deploy nenhum: é só salvar a variável no Render.

**Geração de imagem (`IMAGEM_PROVEDOR`)**

Deixe em branco. Gráficos e capas institucionais são desenhados pelo próprio servidor, sem
depender de serviço externo; a ilustração a partir de descrição usa um serviço que não pede chave.

### Conferindo se deu tudo certo

Depois de publicar, acesse `https://seu-app.onrender.com/api/health`. A resposta lista quais
capacidades estão ativas de fato naquele ambiente:

```json
{
  "ok": true,
  "ferramentas": 27,
  "capacidades": {
    "chat": true,
    "buscaGoogle": false,
    "buscaAlternativaSemChave": true,
    "datajud": true,
    "geracaoDeImagem": true
  }
}
```

Se `chat` aparecer como `false`, a `GROQ_API_KEY` não chegou ao serviço. É melhor descobrir isso
aqui do que numa reunião.

## 6. Publicar

Clique em **Create Web Service**. O Render vai instalar as dependências e subir o servidor — leva
alguns minutos na primeira vez. O servidor cria as tabelas do banco sozinho na primeira
inicialização (não precisa rodar nenhum script manual). Quando terminar, você verá um link
parecido com:

```
https://paulistajr-quara.onrender.com
```

Esse é o link único que qualquer diretor da EJ pode acessar, de qualquer lugar.

## O que esperar do plano gratuito

- **O servidor "dorme" depois de 15 minutos sem uso.** A primeira pessoa a acessar depois de um
  período parado espera cerca de um minuto enquanto ele "acorda" — depois disso, fica rápido
  normalmente até dormir de novo.
- **O banco de dados expira 30 dias após ser criado**, com 14 dias de carência antes de ser
  apagado de vez. O Render avisa por e-mail nos dois momentos — preste atenção nesses e-mails.
- **A primeira instalação demora mais do que antes.** O servidor passou a depender de bibliotecas
  para gerar `.pptx`, `.docx` e imagem (uma delas com binário nativo), então o build inicial leva
  alguns minutos a mais. Isso acontece uma vez por deploy, não a cada acesso.
- **Os arquivos gerados ocupam espaço no banco.** Contrato, apresentação e imagem ficam guardados
  no Postgres por 7 dias e depois são apagados sozinhos — é o que permite baixá-los mesmo com o
  servidor reiniciando (o plano gratuito não tem disco). Na prática isso é dezenas de MB, longe do
  limite de 1 GB do plano gratuito.
- Se no futuro isso incomodar no dia a dia, o Render tem planos pagos que eliminam as duas
  limitações — mas para o uso de uma Empresa Júnior, o plano gratuito deve servir bem, contanto que
  o backup seja baixado com alguma regularidade.

## Quando o banco expirar (a cada ~30-44 dias)

1. Antes de mais nada, se ainda não tiver feito recentemente: abra o app e clique em **Backup**
   para baixar uma cópia atualizada.
2. Repita o passo 3 deste guia ("Criar o banco de dados Postgres") para criar um banco novo.
3. Atualize a variável `DATABASE_URL` do Web Service (passo 5) com a Internal Database URL do
   banco novo.
4. O Render vai reiniciar o servidor automaticamente com a nova variável — o banco novo começa
   vazio (as tabelas são recriadas sozinhas).
5. Abra o app publicado, clique em **Restaurar**, e selecione o arquivo de backup baixado no passo 1.

Isso é a única manutenção periódica que este sistema realmente exige.

## Atualizando o código depois

Qualquer mudança futura no código: dá `git push` para o repositório, e o Render republica
automaticamente (**Auto-Deploy**, já vem ligado por padrão). Isso nunca afeta o banco de dados —
só o código do servidor é atualizado.

## Se você já tinha configurado o chat com o Gemini

O chat foi migrado do Google Gemini para o Groq: o Gemini passou a exigir saldo pré-pago (cartão
de crédito) mesmo na camada gratuita, o que não é aceitável para o uso desta EJ. Se você já tinha
uma variável `GEMINI_API_KEY` configurada, ela não faz mais nada — pode removê-la (opcional, não
atrapalha) e siga os passos acima para configurar `GROQ_API_KEY` no lugar.

## Migrando de uma versão anterior deste guia

Se você já tinha um serviço publicado seguindo instruções antigas (que mencionavam "disco
persistente" e `QUARA_DB_PATH`), o SQLite daquela versão está guardado num disco que, na prática,
provavelmente já foi apagado a cada vez que o serviço reiniciou — então é bem provável que não haja
nada valioso para migrar de lá. Confirme se há dados importantes olhando o app publicado antes de
prosseguir; se houver algo, não há um jeito automático de migrar um banco SQLite antigo para este
formato Postgres — trate como um começo do zero e siga os passos 3 a 6 acima normalmente.
