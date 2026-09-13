// db.js — schema e conexão do banco compartilhado da Quara.
// Usa Render Postgres em vez de SQLite local: o plano gratuito do Render não permite anexar disco
// persistente a um serviço web gratuito (só a planos pagos), então um arquivo SQLite local seria
// apagado a cada reinício do servidor. O Postgres do Render persiste os dados independente disso
// — a limitação que troca de lugar é que o banco Postgres GRATUITO expira 30 dias após ser criado
// (é preciso recriar e restaurar de um backup periodicamente; ver /api/backup no server.js).
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL não definida. Configure-a com a Internal Database URL do seu Render Postgres (ver DEPLOY.md).'
  );
}

// Render Postgres exige SSL para conexões vindas de fora do próprio ambiente Render (e não faz
// mal mantê-lo ligado quando rodando dentro do Render também). rejectUnauthorized:false porque o
// certificado do Render não é validado pela cadeia padrão do Node — é a configuração recomendada
// pela própria documentação do Render para este caso.
//
// A exceção é o Postgres local: uma instalação padrão do Postgres na própria máquina vem sem SSL,
// e insistir em SSL contra ela falha com "The server does not support SSL connections". Como o
// README manda rodar o app e os testes contra um Postgres local, exigir SSL sempre tornaria essa
// instrução impossível de seguir. A decisão é pelo host, não por uma variável que alguém precise
// lembrar de configurar. Para forçar um dos dois lados: PGSSL=on ou PGSSL=off.
function querSsl(url) {
  if (process.env.PGSSL === 'off') return false;
  if (process.env.PGSSL === 'on') return true;
  try {
    const host = new URL(url).hostname;
    return !['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(host);
  } catch {
    return true; // string de conexão fora do padrão de URL: mantém o comportamento seguro
  }
}

const pool = new Pool({
  connectionString,
  ssl: querSsl(connectionString) ? { rejectUnauthorized: false } : false,
  // O Postgres do Render (e o proxy de rede na frente dele) encerra conexões ociosas sem avisar o
  // cliente. Sem estes limites o pool guarda para sempre um socket que já morreu do outro lado, e a
  // próxima query nele falha com ECONNRESET. Reciclar por tempo é mais barato que descobrir o
  // problema na hora de usar.
  max: Number(process.env.PGPOOL_MAX) || 8,
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 10_000,
  maxLifetimeSeconds: 900,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// ESTA É A LINHA QUE MAIS IMPORTA NESTE ARQUIVO.
// O Pool do pg é um EventEmitter. Quando uma conexão OCIOSA morre (o Render reinicia o banco, a
// rede oscila, o plano gratuito derruba o socket), o pool emite 'error'. Um EventEmitter que emite
// 'error' SEM NENHUM listener registrado faz o Node lançar uma exceção não capturada — e o processo
// inteiro morre, levando junto todas as requisições em andamento. Não é um erro da requisição: é
// uma conexão parada no pool que caiu sozinha, e não tinha por que derrubar o servidor.
pool.on('error', (err) => {
  console.error('[pg] conexão ociosa caiu e foi descartada (o servidor continua de pé):', err && err.message);
});

// Erros de CONEXÃO (não de SQL) merecem uma segunda tentativa: são quase sempre o socket morto
// descrito acima, e a query em si está correta. Uma retentativa transforma um 500 na cara do
// usuário em um hiccup de 300ms que ninguém percebe. Erros de SQL (sintaxe, constraint) NÃO são
// retentados — repetir não muda o resultado e só mascara bug.
const CODIGOS_TRANSITORIOS = new Set([
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH',
  '08000', '08003', '08006', '08001', '08004', // classe 08: falha de conexão
  '57P01', '57P02', '57P03', // admin desligou / crash / não aceitando conexões
]);

function ehTransitorio(e) {
  if (!e) return false;
  if (CODIGOS_TRANSITORIOS.has(e.code)) return true;
  const m = String(e.message || '');
  return /Connection terminated|terminating connection|server closed the connection|socket hang up|read ECONNRESET|timeout exceeded when trying to connect/i.test(m);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const queryDireta = pool.query.bind(pool);
pool.query = async function queryComRetentativa(...args) {
  // Forma com callback (não usada neste projeto) passa direto, sem retentativa.
  if (typeof args[args.length - 1] === 'function') return queryDireta(...args);
  try {
    return await queryDireta(...args);
  } catch (e) {
    if (!ehTransitorio(e)) throw e;
    console.warn('[pg] query falhou por conexão (%s) — tentando de novo uma vez', e.code || e.message);
    await esperar(300);
    return queryDireta(...args);
  }
};

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS historico (
      id SERIAL PRIMARY KEY,
      servico_id INTEGER NOT NULL,
      servico_nome TEXT NOT NULL,
      preco DOUBLE PRECISION NOT NULL,
      margem DOUBLE PRECISION NOT NULL,
      banda_nome TEXT NOT NULL,
      data BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS aplicados (
      id TEXT PRIMARY KEY,
      servico_id INTEGER NOT NULL,
      servico_nome TEXT NOT NULL,
      preco DOUBLE PRECISION NOT NULL,
      de DOUBLE PRECISION,
      motivo TEXT,
      data BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS silenciados (
      sugestao_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      severidade TEXT NOT NULL,
      ultima_data BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS limiar_valores (
      regra TEXT PRIMARY KEY,
      valor DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS limiar_contagem (
      regra TEXT PRIMARY KEY,
      aplicadas INTEGER NOT NULL DEFAULT 0,
      ignoradas INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS limiar_log (
      id SERIAL PRIMARY KEY,
      regra TEXT NOT NULL,
      de DOUBLE PRECISION NOT NULL,
      para DOUBLE PRECISION NOT NULL,
      taxa_aplicacao DOUBLE PRECISION NOT NULL,
      amostra INTEGER NOT NULL,
      data BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS servico_overrides (
      servico_id INTEGER PRIMARY KEY,
      min DOUBLE PRECISION NOT NULL,
      max DOUBLE PRECISION NOT NULL,
      atualizado_em BIGINT NOT NULL
    );

    -- Projetos aprovados por GG: cada linha é uma decisão de valor final que a diretora tomou.
    -- Diferente de "historico" (vendas, por serviço da tabela fixa), aqui o projeto é composto
    -- livremente por Projetos (equipe + semanas), sem um serviço-molde para comparar. equipe é
    -- guardado como JSON — uma lista de {tipo, qtd, semanas}, no mesmo formato de maoDeObra que
    -- já existe na tabela de serviços de vendas, para reusar a mesma fórmula de custo.
    CREATE TABLE IF NOT EXISTS gg_projetos (
      id SERIAL PRIMARY KEY,
      nome_projeto TEXT NOT NULL,
      equipe JSONB NOT NULL,
      custo_total DOUBLE PRECISION NOT NULL,
      preco_sugerido DOUBLE PRECISION NOT NULL,
      preco_aprovado DOUBLE PRECISION NOT NULL,
      diff_pct DOUBLE PRECISION NOT NULL,
      data BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_historico_servico ON historico(servico_id);
    CREATE INDEX IF NOT EXISTS idx_aplicados_servico ON aplicados(servico_id);

    -- Arquivos gerados pela Quara (contratos, apresentações, imagens). Os bytes ficam no próprio
    -- banco em vez de em disco porque o serviço web gratuito do Render não tem disco persistente e
    -- pode rodar mais de uma instância: um arquivo escrito em /tmp pela instância A simplesmente
    -- não existe quando o download cai na instância B. São efêmeros por definição (ver
    -- lib/artefatos.js), então NÃO entram no backup — backup é para o que a Quara aprendeu, não
    -- para entregável que se regera em segundos.
    CREATE TABLE IF NOT EXISTS artefatos (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      mime TEXT NOT NULL,
      tipo TEXT NOT NULL,
      descricao TEXT,
      tamanho INTEGER NOT NULL,
      conteudo BYTEA NOT NULL,
      criado_em BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artefatos_criado ON artefatos(criado_em);

    -- Entradas e saídas previstas que alimentam a projeção de caixa. A coluna mes é 'AAAA-MM' (texto, e
    -- não data): o planejamento financeiro da EJ é mensal, e guardar um dia exato daria uma falsa
    -- precisão que ninguém tem sobre quando a parcela realmente cai. Um lançamento 'mensal' vale
    -- de mes até ate_mes (nulo = em aberto).
    CREATE TABLE IF NOT EXISTS fin_lancamentos (
      id SERIAL PRIMARY KEY,
      tipo TEXT NOT NULL,
      descricao TEXT NOT NULL DEFAULT '',
      valor DOUBLE PRECISION NOT NULL,
      mes TEXT NOT NULL,
      recorrencia TEXT NOT NULL DEFAULT 'unica',
      ate_mes TEXT,
      origem TEXT NOT NULL DEFAULT 'manual',
      criado_em BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fin_lancamentos_mes ON fin_lancamentos(mes);

    CREATE TABLE IF NOT EXISTS fin_config (
      chave TEXT PRIMARY KEY,
      valor DOUBLE PRECISION NOT NULL,
      atualizado_em BIGINT NOT NULL
    );
  `);

  await pool.query(
    `INSERT INTO limiar_valores (regra, valor) VALUES ($1, $2), ($3, $4)
     ON CONFLICT (regra) DO NOTHING`,
    ['desvioHist', 8, 'margemBanda', 8]
  );
  await pool.query(
    `INSERT INTO limiar_contagem (regra, aplicadas, ignoradas) VALUES ($1, 0, 0), ($2, 0, 0)
     ON CONFLICT (regra) DO NOTHING`,
    ['desvioHist', 'margemBanda']
  );
}

async function transaction(callback) {
  const client = await pool.connect();
  let conexaoQuebrada = false;
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    // Se a conexão caiu no meio da transação, o próprio ROLLBACK também falha. Deixar esse segundo
    // erro subir trocaria a causa real ("violação de constraint X") por um genérico "Connection
    // terminated", escondendo o problema de verdade de quem for depurar depois.
    try {
      await client.query('ROLLBACK');
    } catch (erroRollback) {
      conexaoQuebrada = true;
      console.error('[pg] ROLLBACK falhou — a conexão será destruída:', erroRollback && erroRollback.message);
    }
    throw e;
  } finally {
    // release(err) manda o pg DESTRUIR a conexão em vez de devolvê-la ao pool. Devolver uma conexão
    // possivelmente dentro de uma transação aberta contaminaria a próxima requisição que a pegasse.
    client.release(conexaoQuebrada ? new Error('conexão descartada após falha de ROLLBACK') : undefined);
  }
}

// A migração roda uma única vez, na subida do processo. No Render o app costuma subir ANTES de o
// Postgres estar aceitando conexões (e, no plano gratuito, o banco pode estar acordando). Falhar de
// primeira e chamar process.exit(1) ali vira crash loop: o Render reinicia, o banco ainda não está
// pronto, morre de novo. Tentar algumas vezes com espera crescente resolve sozinho o caso comum.
async function migrateComRetentativa(tentativas = 5) {
  let ultimoErro;
  for (let i = 1; i <= tentativas; i++) {
    try {
      await migrate();
      return;
    } catch (e) {
      ultimoErro = e;
      if (i === tentativas) break;
      const espera = Math.min(15_000, 1000 * 2 ** (i - 1));
      console.warn(`[pg] migração falhou (tentativa ${i}/${tentativas}): ${e.message} — nova tentativa em ${espera}ms`);
      await esperar(espera);
    }
  }
  throw ultimoErro;
}

module.exports = { pool, migrate, migrateComRetentativa, transaction };
