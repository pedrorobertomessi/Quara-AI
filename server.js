// server.js — servidor da Quara compartilhada.
// Serve o HTML (public/index.html) e expõe uma API que espelha, endpoint a endpoint, as funções
// de leitura/escrita que antes viviam em localStorage no front-end. A lógica de negócio de
// aprendizado de limiar (amostra mínima, direção do ajuste, clamp) mora aqui agora, porque com
// vários diretores mandando decisões ao mesmo tempo só o servidor pode arbitrar isso de forma
// consistente — não dá mais para cada aba do navegador calcular isso sozinha.
const express = require('express');
const cors = require('cors');
const path = require('path');
const { pool, migrate, migrateComRetentativa, transaction } = require('./db');
const { getClient: getGroqClient, conduzirTurno, executarFerramenta, extrairArtefato, buscarFerramenta, FERRAMENTAS, GROQ_MODEL, CATEGORIAS } = require('./chat');
const artefatosLib = require('./lib/artefatos');
const ferramentasFinanceiro = require('./tools/financeiro');

// ---------- Rede de segurança do processo ----------
// Estes dois handlers não existiam, e a ausência deles é parte de por que o serviço "caía muito".
// A partir do Node 15, uma promessa rejeitada sem .catch() DERRUBA O PROCESSO — mesmo que a falha
// tenha sido num detalhe lateral (uma limpeza em segundo plano, um socket que fechou). Um app web
// não deveria morrer inteiro, com todas as requisições em andamento, por causa disso.
//
// A escolha aqui é registrar e continuar de pé. É deliberadamente diferente do conselho padrão
// ("logue e saia"), que existe para processos que podem ter ficado em estado inconsistente. Não é o
// caso aqui: o servidor não guarda estado crítico em memória (a única coisa são as ações pendentes,
// e perdê-las já é tratado, com mensagem explicando), enquanto morrer significa derrubar todo mundo
// que estiver usando. Se a causa for estrutural, ela aparece no log em vez de sumir num reinício.
process.on('unhandledRejection', (motivo) => {
  console.error('[processo] promessa rejeitada sem tratamento (servidor segue de pé):', motivo && (motivo.stack || motivo.message || motivo));
});
process.on('uncaughtException', (err) => {
  console.error('[processo] exceção não capturada (servidor segue de pé):', err && (err.stack || err.message));
});

const app = express();
app.use(cors());
// 5 MB em vez do padrão de 100 KB: o chat agora manda junto um retrato da tela (tabela de preços,
// configuração) e a restauração de backup manda o banco inteiro em um JSON só.
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const QR_LIMIAR_MIN = 4;
const QR_LIMIAR_MAX = 30;
const QR_LIMIAR_AMOSTRA_MIN = 6;

// ---------- Histórico ----------

app.get('/api/historico', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM historico ORDER BY data DESC');
  res.json(rows.map(rowToHistorico));
});

app.post('/api/historico', async (req, res) => {
  const { servicoId, servicoNome, preco, margem, bandaNome, data } = req.body;
  if (
    typeof servicoId !== 'number' ||
    typeof servicoNome !== 'string' ||
    typeof preco !== 'number' ||
    typeof margem !== 'number' ||
    typeof bandaNome !== 'string'
  ) {
    return res.status(400).json({ error: 'payload inválido' });
  }
  const { rows } = await pool.query(
    'INSERT INTO historico (servico_id, servico_nome, preco, margem, banda_nome, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [servicoId, servicoNome, preco, margem, bandaNome, data || Date.now()]
  );
  res.status(201).json(rowToHistorico(rows[0]));
});

app.delete('/api/historico/:id', async (req, res) => {
  const result = await pool.query('DELETE FROM historico WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'não encontrado' });
  res.status(204).end();
});

app.delete('/api/historico', async (req, res) => {
  await pool.query('DELETE FROM historico');
  res.status(204).end();
});

function rowToHistorico(r) {
  return {
    id: r.id,
    servicoId: r.servico_id,
    servicoNome: r.servico_nome,
    preco: Number(r.preco),
    margem: Number(r.margem),
    bandaNome: r.banda_nome,
    data: Number(r.data),
  };
}

// ---------- Aplicados ----------

app.get('/api/aplicados', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM aplicados ORDER BY data DESC');
  res.json(rows.map(rowToAplicado));
});

app.post('/api/aplicados', async (req, res) => {
  const { id, servicoId, servicoNome, preco, de, motivo, data } = req.body;
  if (typeof id !== 'string' || typeof servicoId !== 'number' || typeof preco !== 'number') {
    return res.status(400).json({ error: 'payload inválido' });
  }
  const { rows } = await pool.query(
    `INSERT INTO aplicados (id, servico_id, servico_nome, preco, de, motivo, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET servico_id=excluded.servico_id, servico_nome=excluded.servico_nome,
       preco=excluded.preco, de=excluded.de, motivo=excluded.motivo, data=excluded.data
     RETURNING *`,
    [id, servicoId, servicoNome || '', preco, de ?? null, motivo || '', data || Date.now()]
  );
  res.status(201).json(rowToAplicado(rows[0]));
});

function rowToAplicado(r) {
  return {
    id: r.id,
    servicoId: r.servico_id,
    servicoNome: r.servico_nome,
    preco: Number(r.preco),
    de: r.de === null ? null : Number(r.de),
    motivo: r.motivo,
    data: Number(r.data),
  };
}

// ---------- Silenciados ----------

app.get('/api/silenciados', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM silenciados');
  const map = {};
  for (const r of rows) {
    map[r.sugestao_id] = { count: r.count, severidade: r.severidade, ultimaData: Number(r.ultima_data) };
  }
  res.json(map);
});

app.post('/api/silenciados/:sugestaoId/ignorar', async (req, res) => {
  const { severidade } = req.body;
  if (!['baixo', 'medio', 'alto'].includes(severidade)) {
    return res.status(400).json({ error: 'severidade inválida' });
  }
  const pesoSev = { baixo: 0, medio: 1, alto: 2 };
  const row = await transaction(async (client) => {
    const { rows: existentes } = await client.query('SELECT * FROM silenciados WHERE sugestao_id = $1 FOR UPDATE', [req.params.sugestaoId]);
    const atual = existentes[0];
    const piorou = atual ? pesoSev[severidade] > pesoSev[atual.severidade] : false;
    const novoCount = !atual || piorou ? 1 : atual.count + 1;
    const { rows: upserted } = await client.query(
      `INSERT INTO silenciados (sugestao_id, count, severidade, ultima_data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sugestao_id) DO UPDATE SET count=excluded.count, severidade=excluded.severidade, ultima_data=excluded.ultima_data
       RETURNING *`,
      [req.params.sugestaoId, novoCount, severidade, Date.now()]
    );
    return upserted[0];
  });
  res.json({ count: row.count, severidade: row.severidade, ultimaData: Number(row.ultima_data) });
});

// ---------- Limiares ----------

app.get('/api/limiares', async (req, res) => {
  res.json(await buildLimiaresResponse());
});

app.post('/api/limiares/:regra/decisao', async (req, res) => {
  const { regra } = req.params;
  const { decisao } = req.body;
  if (!['desvioHist', 'margemBanda'].includes(regra)) {
    return res.status(400).json({ error: 'regra desconhecida' });
  }
  if (!['aplicou', 'ignorou'].includes(decisao)) {
    return res.status(400).json({ error: 'decisão inválida' });
  }

  await transaction(async (client) => {
    // FOR UPDATE trava a linha até o commit desta transação — sem isso, duas decisões concorrentes
    // (dois diretores decidindo ao mesmo tempo) poderiam AMBAS ler a contagem antes de qualquer
    // uma ter salvo o próprio incremento, e cada uma escreveria por cima da mesma base antiga,
    // perdendo uma das duas decisões. O nível de isolamento padrão do Postgres (READ COMMITTED)
    // não evita isso sozinho — é preciso o lock explícito.
    const { rows: contagemRows } = await client.query('SELECT * FROM limiar_contagem WHERE regra = $1 FOR UPDATE', [regra]);
    const contagemAtual = contagemRows[0] || { aplicadas: 0, ignoradas: 0 };
    const aplicadas = contagemAtual.aplicadas + (decisao === 'aplicou' ? 1 : 0);
    const ignoradas = contagemAtual.ignoradas + (decisao === 'ignorou' ? 1 : 0);
    const total = aplicadas + ignoradas;

    if (total < QR_LIMIAR_AMOSTRA_MIN) {
      await client.query(
        `INSERT INTO limiar_contagem (regra, aplicadas, ignoradas) VALUES ($1, $2, $3)
         ON CONFLICT (regra) DO UPDATE SET aplicadas=excluded.aplicadas, ignoradas=excluded.ignoradas`,
        [regra, aplicadas, ignoradas]
      );
      return;
    }

    const taxaAplicacao = aplicadas / total;
    const { rows: valorRows } = await client.query('SELECT valor FROM limiar_valores WHERE regra = $1', [regra]);
    const valorAtual = valorRows[0] ? Number(valorRows[0].valor) : 8;
    let novoValor = valorAtual;
    if (taxaAplicacao >= 0.7) novoValor = valorAtual - 2;
    else if (taxaAplicacao <= 0.3) novoValor = valorAtual + 2;
    novoValor = Math.max(QR_LIMIAR_MIN, Math.min(QR_LIMIAR_MAX, novoValor));

    if (novoValor !== valorAtual) {
      await client.query(
        'INSERT INTO limiar_log (regra, de, para, taxa_aplicacao, amostra, data) VALUES ($1, $2, $3, $4, $5, $6)',
        [regra, valorAtual, novoValor, Math.round(taxaAplicacao * 100), total, Date.now()]
      );
      await client.query(
        `INSERT INTO limiar_valores (regra, valor) VALUES ($1, $2)
         ON CONFLICT (regra) DO UPDATE SET valor=excluded.valor`,
        [regra, novoValor]
      );
    }

    await client.query(
      `INSERT INTO limiar_contagem (regra, aplicadas, ignoradas) VALUES ($1, 0, 0)
       ON CONFLICT (regra) DO UPDATE SET aplicadas=0, ignoradas=0`,
      [regra]
    );
  });

  res.json(await buildLimiaresResponse());
});

async function buildLimiaresResponse() {
  const { rows: valoresRows } = await pool.query('SELECT * FROM limiar_valores');
  const valores = {};
  for (const r of valoresRows) valores[r.regra] = Number(r.valor);

  const { rows: contagemRows } = await pool.query('SELECT * FROM limiar_contagem');
  const contagem = {};
  for (const r of contagemRows) contagem[r.regra] = { aplicadas: r.aplicadas, ignoradas: r.ignoradas };

  const { rows: logRows } = await pool.query('SELECT * FROM limiar_log ORDER BY data DESC LIMIT 20');
  const log = logRows.map((r) => ({
    regra: r.regra,
    de: Number(r.de),
    para: Number(r.para),
    taxaAplicacao: Number(r.taxa_aplicacao),
    amostra: r.amostra,
    data: Number(r.data),
  }));

  return { valores, contagem, log };
}

// ---------- Overrides de min/max por serviço ----------

app.get('/api/overrides', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM servico_overrides');
  const map = {};
  for (const r of rows) map[r.servico_id] = { min: Number(r.min), max: Number(r.max) };
  res.json(map);
});

app.post('/api/overrides/:servicoId', async (req, res) => {
  const { min, max } = req.body;
  const servicoId = Number(req.params.servicoId);
  if (!Number.isFinite(servicoId) || typeof min !== 'number' || typeof max !== 'number') {
    return res.status(400).json({ error: 'payload inválido' });
  }
  await pool.query(
    `INSERT INTO servico_overrides (servico_id, min, max, atualizado_em) VALUES ($1, $2, $3, $4)
     ON CONFLICT (servico_id) DO UPDATE SET min=excluded.min, max=excluded.max, atualizado_em=excluded.atualizado_em`,
    [servicoId, min, max, Date.now()]
  );
  res.status(201).json({ servicoId, min, max });
});

// ---------- Aprovação de projetos (GG) ----------
// Diferente do fluxo de vendas (serviço fixo de uma tabela de 13), aqui a diretora de Gente e
// Gestão recebe projetos com equipe livre (pessoas por tipo + semanas), definidos por Projetos, e
// decide o valor final. A "justificativa" que a Quara oferece é sempre matemática verificável —
// de onde vem o custo, e como esse projeto se compara a outros de composição parecida que a
// diretora já aprovou — nunca uma decisão automática ou um texto gerado por IA generativa
// inventando uma explicação. A diretora aprova cada linha; a Quara só organiza o contexto.
//
// A lógica de cálculo em si (ggCalcularCusto, ggResumoEquipe, ggSaoParecidos, rowToGgProjeto) mora
// em gg-logic.js — compartilhada com chat.js, para que as rotas REST e as ferramentas do chat
// nunca divirjam sobre como calcular a mesma coisa.
const { GG_TAXA_ALVO, ggCalcularCusto, ggResumoEquipe, ggSaoParecidos, rowToGgProjeto } = require('./gg-logic');

app.get('/api/gg-projetos', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM gg_projetos ORDER BY data DESC');
  res.json(rows.map(rowToGgProjeto));
});

app.post('/api/gg-projetos', async (req, res) => {
  const { nomeProjeto, equipe, custoTotal, precoSugerido, precoAprovado } = req.body;
  if (
    typeof nomeProjeto !== 'string' ||
    !Array.isArray(equipe) ||
    typeof custoTotal !== 'number' ||
    typeof precoSugerido !== 'number' ||
    typeof precoAprovado !== 'number'
  ) {
    return res.status(400).json({ error: 'payload inválido' });
  }
  const diffPct = precoSugerido > 0 ? Math.round(((precoAprovado - precoSugerido) / precoSugerido) * 100) : 0;
  const { rows } = await pool.query(
    `INSERT INTO gg_projetos (nome_projeto, equipe, custo_total, preco_sugerido, preco_aprovado, diff_pct, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [nomeProjeto, JSON.stringify(equipe), custoTotal, precoSugerido, precoAprovado, diffPct, Date.now()]
  );
  res.status(201).json(rowToGgProjeto(rows[0]));
});

// Recebe uma composição de equipe (ainda não aprovada) e devolve o cálculo + a comparação com
// projetos parecidos já aprovados no histórico — a "justificativa" que a diretora vê antes de
// decidir. Não grava nada; é só uma consulta.
app.post('/api/gg-projetos/comparar', async (req, res) => {
  const { equipe, taxasHora } = req.body;
  if (!Array.isArray(equipe) || !taxasHora || typeof taxasHora !== 'object') {
    return res.status(400).json({ error: 'payload inválido' });
  }
  const custoTotal = ggCalcularCusto(equipe, taxasHora);
  const precoSugerido = Math.round(custoTotal / GG_TAXA_ALVO / 100) * 100;
  const resumoAtual = ggResumoEquipe(equipe);

  const { rows } = await pool.query('SELECT * FROM gg_projetos ORDER BY data DESC');
  const parecidos = rows
    .map(rowToGgProjeto)
    .filter((p) => ggSaoParecidos(resumoAtual, ggResumoEquipe(p.equipe)));

  let comparacao = null;
  if (parecidos.length >= 2) {
    const mediaAprovada = Math.round(parecidos.reduce((a, p) => a + p.precoAprovado, 0) / parecidos.length);
    const diffPct = mediaAprovada > 0 ? Math.round(((precoSugerido - mediaAprovada) / mediaAprovada) * 100) : 0;
    comparacao = { amostra: parecidos.length, mediaAprovada, diffPct };
  }

  res.json({ custoTotal, precoSugerido, resumoAtual, comparacao });
});

// ---------- Backup e restauração ----------
// O plano gratuito do Render Postgres expira 30 dias após ser criado — sem um jeito de tirar uma
// cópia completa e trazer de volta depois, esse prazo destruiria os dados sem aviso. /api/backup
// devolve TUDO em um único JSON (para o botão "Baixar backup" no front-end); /api/restore aceita
// esse mesmo formato de volta, para repovoar um banco novo depois de recriado.

app.get('/api/backup', async (req, res) => {
  const [historico, aplicados, silenciados, limiaresValores, limiaresContagem, limiaresLog, overrides, ggProjetos, finLancamentos, finConfig] = await Promise.all([
    pool.query('SELECT * FROM historico'),
    pool.query('SELECT * FROM aplicados'),
    pool.query('SELECT * FROM silenciados'),
    pool.query('SELECT * FROM limiar_valores'),
    pool.query('SELECT * FROM limiar_contagem'),
    pool.query('SELECT * FROM limiar_log'),
    pool.query('SELECT * FROM servico_overrides'),
    pool.query('SELECT * FROM gg_projetos'),
    pool.query('SELECT * FROM fin_lancamentos'),
    pool.query('SELECT * FROM fin_config'),
  ]);
  // Versão 2 acrescenta os projetos de GG e o planejamento financeiro. Os projetos de GG estavam
  // de fora por esquecimento — são decisões de valor que a diretoria tomou, exatamente o tipo de
  // coisa que o backup existe para não perder quando o banco gratuito expira. Os artefatos
  // (contratos, decks, imagens) continuam de fora de propósito: são entregáveis regeráveis, e
  // carregá-los inflaria o arquivo de backup sem preservar nenhuma decisão.
  const backup = {
    versao: 2,
    geradoEm: Date.now(),
    historico: historico.rows,
    aplicados: aplicados.rows,
    silenciados: silenciados.rows,
    limiar_valores: limiaresValores.rows,
    limiar_contagem: limiaresContagem.rows,
    limiar_log: limiaresLog.rows,
    servico_overrides: overrides.rows,
    gg_projetos: ggProjetos.rows,
    fin_lancamentos: finLancamentos.rows,
    fin_config: finConfig.rows,
  };
  res.setHeader('Content-Disposition', `attachment; filename="quara-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(backup);
});

app.post('/api/restore', async (req, res) => {
  const b = req.body;
  // Aceita a versão 1 (backups baixados antes de GG e financeiro entrarem no arquivo) além da 2.
  // Um backup antigo tem que continuar restaurável: ele foi baixado justamente para ser usado num
  // momento ruim, e descobrir naquela hora que o formato mudou seria o pior momento possível.
  if (!b || typeof b !== 'object' || ![1, 2].includes(b.versao)) {
    return res.status(400).json({ error: 'formato de backup inválido ou versão não suportada' });
  }
  await transaction(async (client) => {
    // Limpa tudo antes de restaurar — um restore é "voltar exatamente a este estado", não mesclar
    // com o que já existe (o que geraria duplicatas e inconsistências difíceis de prever).
    await client.query('DELETE FROM historico');
    await client.query('DELETE FROM aplicados');
    await client.query('DELETE FROM silenciados');
    await client.query('DELETE FROM limiar_valores');
    await client.query('DELETE FROM limiar_contagem');
    await client.query('DELETE FROM limiar_log');
    await client.query('DELETE FROM servico_overrides');
    await client.query('DELETE FROM gg_projetos');
    await client.query('DELETE FROM fin_lancamentos');
    await client.query('DELETE FROM fin_config');

    for (const h of b.historico || []) {
      await client.query(
        'INSERT INTO historico (id, servico_id, servico_nome, preco, margem, banda_nome, data) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [h.id, h.servico_id, h.servico_nome, h.preco, h.margem, h.banda_nome, h.data]
      );
    }
    for (const a of b.aplicados || []) {
      await client.query(
        'INSERT INTO aplicados (id, servico_id, servico_nome, preco, de, motivo, data) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [a.id, a.servico_id, a.servico_nome, a.preco, a.de, a.motivo, a.data]
      );
    }
    for (const s of b.silenciados || []) {
      await client.query(
        'INSERT INTO silenciados (sugestao_id, count, severidade, ultima_data) VALUES ($1, $2, $3, $4)',
        [s.sugestao_id, s.count, s.severidade, s.ultima_data]
      );
    }
    for (const l of b.limiar_valores || []) {
      await client.query('INSERT INTO limiar_valores (regra, valor) VALUES ($1, $2)', [l.regra, l.valor]);
    }
    for (const c of b.limiar_contagem || []) {
      await client.query('INSERT INTO limiar_contagem (regra, aplicadas, ignoradas) VALUES ($1, $2, $3)', [
        c.regra,
        c.aplicadas,
        c.ignoradas,
      ]);
    }
    for (const lg of b.limiar_log || []) {
      await client.query(
        'INSERT INTO limiar_log (id, regra, de, para, taxa_aplicacao, amostra, data) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [lg.id, lg.regra, lg.de, lg.para, lg.taxa_aplicacao, lg.amostra, lg.data]
      );
    }
    for (const o of b.servico_overrides || []) {
      await client.query('INSERT INTO servico_overrides (servico_id, min, max, atualizado_em) VALUES ($1, $2, $3, $4)', [
        o.servico_id,
        o.min,
        o.max,
        o.atualizado_em,
      ]);
    }

    for (const g of b.gg_projetos || []) {
      await client.query(
        'INSERT INTO gg_projetos (id, nome_projeto, equipe, custo_total, preco_sugerido, preco_aprovado, diff_pct, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [g.id, g.nome_projeto, JSON.stringify(g.equipe), g.custo_total, g.preco_sugerido, g.preco_aprovado, g.diff_pct, g.data]
      );
    }
    for (const l of b.fin_lancamentos || []) {
      await client.query(
        'INSERT INTO fin_lancamentos (id, tipo, descricao, valor, mes, recorrencia, ate_mes, origem, criado_em) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [l.id, l.tipo, l.descricao, l.valor, l.mes, l.recorrencia, l.ate_mes, l.origem, l.criado_em]
      );
    }
    for (const c of b.fin_config || []) {
      await client.query('INSERT INTO fin_config (chave, valor, atualizado_em) VALUES ($1, $2, $3)', [c.chave, c.valor, c.atualizado_em]);
    }

    // Realinha as sequências dos ids auto-incrementados (SERIAL) para depois do maior id
    // restaurado — sem isso, a próxima inserção poderia tentar usar um id que já existe.
    await client.query(`SELECT setval('historico_id_seq', COALESCE((SELECT MAX(id) FROM historico), 1))`);
    await client.query(`SELECT setval('limiar_log_id_seq', COALESCE((SELECT MAX(id) FROM limiar_log), 1))`);
    await client.query(`SELECT setval('gg_projetos_id_seq', COALESCE((SELECT MAX(id) FROM gg_projetos), 1))`);
    await client.query(`SELECT setval('fin_lancamentos_id_seq', COALESCE((SELECT MAX(id) FROM fin_lancamentos), 1))`);
  });
  res.json({ ok: true, restauradoEm: Date.now() });
});

// ---------- Artefatos gerados (contratos, apresentações, imagens) ----------
// Guardados no Postgres (ver lib/artefatos.js) e servidos por id. Content-Disposition inline
// deixa o navegador exibir imagem e PDF direto; .docx e .pptx o navegador baixa de qualquer jeito.

app.get('/api/artefatos', async (req, res) => {
  res.json(await artefatosLib.listar(Number(req.query.limite) || 20));
});

app.get('/api/artefatos/:id', async (req, res) => {
  const a = await artefatosLib.obter(req.params.id);
  if (!a) {
    return res.status(404).json({ error: 'Esse arquivo não existe mais (eles ficam disponíveis por alguns dias). Peça para a Quara gerar de novo.' });
  }
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Content-Length', a.conteudo.length);
  const disposicao = /^image\//.test(a.mime) || a.mime === 'application/pdf' ? 'inline' : 'attachment';
  // encodeURIComponent no filename* cobre os acentos que sempre aparecem em nome de cliente
  // brasileiro — sem isso o navegador salva o arquivo com o nome corrompido.
  res.setHeader('Content-Disposition', `${disposicao}; filename="${a.nome.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(a.nome)}`);
  res.send(a.conteudo);
});

// ---------- Financeiro ----------
// Espelham as ferramentas do chat, para que o planejamento financeiro também seja utilizável por
// botão — pela mesma razão que todo o resto do app é: nem toda decisão precisa passar por conversa.

app.get('/api/financeiro/lancamentos', async (req, res) => {
  res.json(await ferramentasFinanceiro.listarLancamentos());
});

app.post('/api/financeiro/lancamentos', async (req, res) => {
  try {
    res.status(201).json(await ferramentasFinanceiro.registrarLancamento(req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/financeiro/lancamentos/:id', async (req, res) => {
  try {
    res.json(await ferramentasFinanceiro.removerLancamento({ id: Number(req.params.id) }));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get('/api/financeiro/saldo', async (req, res) => {
  res.json({ saldoCaixa: await ferramentasFinanceiro.lerConfig('saldo_caixa', 0) });
});

app.post('/api/financeiro/saldo', async (req, res) => {
  const { saldo } = req.body;
  if (!Number.isFinite(Number(saldo))) return res.status(400).json({ error: 'saldo inválido' });
  await pool.query(
    `INSERT INTO fin_config (chave, valor, atualizado_em) VALUES ('saldo_caixa', $1, $2)
     ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`,
    [Number(saldo), Date.now()]
  );
  res.json({ saldoCaixa: Number(saldo) });
});

app.get('/api/financeiro/projecao', async (req, res) => {
  const meses = Math.max(1, Math.min(36, Number(req.query.meses) || 6));
  try {
    const [faturamento, caixa] = await Promise.all([
      ferramentasFinanceiro.projetarFaturamento({ meses }),
      ferramentasFinanceiro.projetarCaixa({ meses }),
    ]);
    res.json({ faturamento, caixa });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Chat conversacional (Quara AI) ----------
// A pessoa manda uma mensagem + o histórico da conversa até agora + um retrato da tela (valores-
// hora, tabela de preços). O servidor não guarda sessão: cada requisição é auto-suficiente, e
// recarregar a página simplesmente começa uma conversa nova.
//
// A Quara pode encadear várias ferramentas de LEITURA numa mesma resposta (ver o loop em chat.js).
// ESCRITA nunca executa na mesma resposta em que foi pedida: volta como "ação pendente" com os
// parâmetros exatos, e só executa se uma mensagem seguinte confirmar aquela pendência específica
// pelo id. Essa é a mesma regra dos botões do app — nada grava sem um clique consciente.
const acoesPendentes = new Map(); // id -> {ferramenta, args, contexto, criadaEm} — em memória; perdido se o servidor reiniciar, o que é aceitável: a pessoa só precisa pedir de novo.
let proximoIdPendente = 1;

// Uma pendência que ninguém confirma ficava guardada para sempre, junto com o contexto inteiro da
// tela que veio com ela (tabela de preços, configuração). Numa instância pequena, isso é um
// vazamento lento e silencioso: a memória sobe até o serviço ser morto por falta dela, o que parece
// uma queda aleatória. Cartão de confirmação que passou da validade não seria confirmado mesmo.
const PENDENCIA_VALIDADE_MS = 30 * 60 * 1000;
const MAX_PENDENCIAS = 200;

// Quantos turnos de chat podem estar em andamento ao mesmo tempo neste processo.
const MAX_CHAT_CONCORRENTE = Number(process.env.MAX_CHAT_CONCORRENTE) || 4;
let chatsEmVoo = 0;

function limparPendenciasVencidas() {
  const corte = Date.now() - PENDENCIA_VALIDADE_MS;
  for (const [id, p] of acoesPendentes) {
    if ((p.criadaEm || 0) < corte) acoesPendentes.delete(id);
  }
  // Teto absoluto, caso cheguem muitas dentro da janela de validade: descarta as mais antigas
  // (o Map do JS preserva a ordem de inserção).
  while (acoesPendentes.size > MAX_PENDENCIAS) {
    acoesPendentes.delete(acoesPendentes.keys().next().value);
  }
}

// A pendência guarda o contexto que veio com o pedido ORIGINAL, não o da confirmação. Se alguém
// mexer nos valores-hora entre pedir e confirmar, o que será gravado continua sendo exatamente o
// que a pessoa viu descrito no cartão de confirmação — e não um recálculo silencioso.
app.post('/api/chat', async (req, res) => {
  const { mensagem, historico, confirmarPendencia, taxasHora, contexto } = req.body;

  // Confirmação de ação pendente NUNCA depende da chave do Groq — não volta ao modelo de
  // linguagem de jeito nenhum, é só executar a ferramenta com os parâmetros já decididos. Por isso
  // este bloco vem antes de qualquer checagem de chave.
  if (confirmarPendencia) {
    const pendencia = acoesPendentes.get(confirmarPendencia);
    if (!pendencia) {
      return res.status(404).json({ error: 'Essa ação pendente não existe mais (talvez o servidor tenha reiniciado, ou já foi confirmada/cancelada). Peça de novo.' });
    }
    acoesPendentes.delete(confirmarPendencia);
    try {
      // Pendências criadas por uma versão anterior do servidor guardavam só `taxasHora` solto, em
      // vez do contexto inteiro. Aceitar as duas formas evita que uma pendência criada segundos
      // antes de um deploy quebre na confirmação — que é exatamente o momento em que a pessoa já
      // clicou em "confirmar" e espera que funcione.
      const contextoPendencia = pendencia.contexto || (pendencia.taxasHora ? { taxasHora: pendencia.taxasHora } : {});
      const resultado = await executarFerramenta(pendencia.ferramenta, pendencia.args, contextoPendencia);
      const artefato = extrairArtefato(pendencia.ferramenta, resultado);
      return res.json({ tipo: 'executado', ferramenta: pendencia.ferramenta, resultado, artefatos: artefato ? [artefato] : [] });
    } catch (e) {
      return res.status(500).json({ error: 'Falha ao executar a ação: ' + e.message });
    }
  }

  const client = getGroqClient();
  if (!client) {
    return res.status(503).json({ error: 'Chat indisponível: nenhuma chave de API do Groq configurada no servidor (GROQ_API_KEY).' });
  }

  if (typeof mensagem !== 'string') {
    return res.status(400).json({ error: 'payload inválido' });
  }

  // taxasHora continua aceito solto por compatibilidade com versões antigas do front-end, mas o
  // caminho novo é mandar tudo dentro de `contexto`.
  const ctx = { ...(contexto || {}), taxasHora: (contexto && contexto.taxasHora) || taxasHora };

  // Um turno de chat pode gerar imagem (sharp), montar um .pptx e um .docx — cada um desses aloca
  // dezenas de MB de uma vez. Várias pessoas mandando mensagem ao mesmo tempo multiplicavam isso até
  // o processo ser morto por falta de memória, que do lado de fora parece exatamente uma queda. É
  // melhor pedir para a quarta pessoa esperar dez segundos do que derrubar as três primeiras.
  if (chatsEmVoo >= MAX_CHAT_CONCORRENTE) {
    return res.status(503).json({ error: 'Estou respondendo a várias pessoas neste instante. Manda de novo em alguns segundos.' });
  }
  chatsEmVoo++;

  try {
    const turno = await conduzirTurno({ client, mensagem, historico, contexto: ctx });

    if (turno.tipo === 'pendente') {
      limparPendenciasVencidas();
      const id = String(proximoIdPendente++);
      acoesPendentes.set(id, { ferramenta: turno.ferramenta, args: turno.args, contexto: ctx, criadaEm: Date.now() });
      return res.json({
        tipo: 'pendente',
        idPendencia: id,
        ferramenta: turno.ferramenta,
        args: turno.args,
        historico: turno.historico,
        ferramentasUsadas: turno.ferramentasUsadas,
        artefatos: turno.artefatos,
      });
    }

    return res.json({
      tipo: 'resposta',
      texto: turno.texto,
      historico: turno.historico,
      ferramentasUsadas: turno.ferramentasUsadas,
      artefatos: turno.artefatos,
      passos: turno.passos,
    });
  } catch (e) {
    // Qualquer falha da API do Groq vira uma mensagem clara para a pessoa — a Quara de botões
    // continua funcionando normalmente mesmo com o chat fora do ar.
    //
    // Antes, tudo virava a MESMA frase ("o chat está indisponível"), e é por isso que o problema
    // ficou tanto tempo sem diagnóstico: "cota da conta estourou por hoje", "essa conversa ficou
    // longa demais" e "a chave está errada" pedem três providências completamente diferentes, e as
    // três apareciam idênticas na tela. Agora cada uma se identifica.
    const status = e && e.status;
    const msg = String((e && e.message) || '');
    console.error('[chat] falha:', status || '', msg);

    let texto;
    let httpStatus = 502;
    if (status === 429 || /rate.?limit|too many requests/i.test(msg)) {
      texto = 'A cota da API de linguagem foi atingida agora há pouco. Espere um minuto e mande de novo — se persistir o dia inteiro, o limite diário da conta acabou e renova amanhã.';
      httpStatus = 429;
    } else if (status === 413 || /context.?length|too large|maximum context|reduce the length/i.test(msg)) {
      texto = 'Esta conversa ficou comprida demais para uma mensagem só. Comece uma conversa nova (recarregue a página) que eu volto com a janela limpa.';
      httpStatus = 413;
    } else if (status === 401 || status === 403) {
      texto = 'A chave da API de linguagem foi recusada. Alguém com acesso ao painel precisa conferir a GROQ_API_KEY nas variáveis de ambiente.';
    } else if (/timeout|aborted|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg) || (e && e.name === 'APIConnectionTimeoutError')) {
      texto = 'O modelo demorou demais para responder e eu desisti de esperar. Tente de novo — normalmente passa.';
      httpStatus = 504;
    } else {
      texto = 'O chat está indisponível no momento. O resto do app continua funcionando normalmente.';
    }
    return res.status(httpStatus).json({ error: texto });
  } finally {
    chatsEmVoo--;
  }
});

// ---------- Saúde do serviço ----------

app.get('/api/health', async (req, res) => {
  // O banco entrou no health check porque "o processo está vivo" nunca foi a pergunta interessante:
  // o modo de falha real é o app de pé e o Postgres fora, e nesse estado o health antigo respondia
  // ok:true alegremente. uptime e memória ajudam a distinguir "caiu" de "foi reiniciado" quando
  // alguém reclama de instabilidade — se o uptime é sempre pequeno, o processo está reiniciando.
  let banco = 'ok';
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    banco = 'erro: ' + (e.message || 'desconhecido');
  }
  const mem = process.memoryUsage();
  // Além do "está de pé?", diz o que está de fato utilizável. Como várias capacidades dependem de
  // variável de ambiente (busca do Google, chave do DataJud, chave do Groq), sem isso a única
  // forma de descobrir que uma delas ficou de fora do deploy seria ela falhar na frente do usuário.
  res.json({
    ok: banco === 'ok',
    timestamp: Date.now(),
    banco,
    uptimeSegundos: Math.round(process.uptime()),
    memoriaMB: Math.round(mem.rss / 1024 / 1024),
    chatsEmVoo,
    pendencias: acoesPendentes.size,
    modelo: GROQ_MODEL,
    ferramentas: FERRAMENTAS.length,
    categorias: CATEGORIAS,
    capacidades: {
      chat: !!process.env.GROQ_API_KEY,
      buscaGoogle: !!(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID),
      buscaAlternativaSemChave: true,
      datajud: true,
      datajudChavePropria: !!process.env.DATAJUD_API_KEY,
      geracaoDeImagem: (() => {
        try {
          require.resolve('sharp');
          return true;
        } catch {
          return false;
        }
      })(),
    },
  });
});

// Rota de API que não existe responde JSON, não o HTML do app. Sem isto, um endpoint errado (ou um
// front-end desatualizado depois de um deploy) recebia a página inteira, o `await r.json()` do
// navegador estourava, e a tela dizia "não foi possível falar com o servidor" — a mensagem de
// servidor fora do ar para um servidor que estava perfeitamente de pé.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Endpoint não encontrado: ${req.method} /api${req.path}` });
});

// Qualquer rota não-API cai no HTML (SPA-style), exceto se o arquivo estático já respondeu antes.
// Express 5 (path-to-regexp v6+) exige um nome de parâmetro no wildcard — '*' sozinho não é mais
// uma sintaxe válida de rota coringa.
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Tratamento central de erros ----------
// Precisa ser o ÚLTIMO app.use, e precisa ter os quatro parâmetros — é assim que o Express reconhece
// um middleware de erro.
//
// O Express 5 encaminha para cá as promessas rejeitadas das rotas async, então o servidor não morria
// por causa delas. Mas o tratador padrão responde HTML, e quase toda rota deste arquivo é consumida
// por um `fetch(...).then(r => r.json())` no navegador: a resposta de erro em HTML quebrava o parse
// no cliente e virava "erro de conexão" na tela. Um JSON com a causa certa faz o app degradar em vez
// de aparentar ter caído.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  console.error(`[erro] ${req.method} ${req.originalUrl}:`, err && (err.stack || err.message));
  if (res.headersSent) return; // resposta já começou a ser enviada: só derrubar a conexão
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'O conteúdo enviado é grande demais. Se for uma restauração de backup, use um arquivo menor; se for o chat, comece uma conversa nova.' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'O corpo da requisição não é um JSON válido.' });
  }
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: status >= 500 ? 'Erro interno no servidor. A equipe consegue ver o detalhe no log.' : err.message || 'Requisição inválida.',
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  migrateComRetentativa()
    .then(() => {
      const servidor = app.listen(PORT, () => {
        console.log(`Quara server rodando na porta ${PORT}`);
      });

      // O proxy que fica na frente do app (Render, Cloudflare, qualquer um) reaproveita a mesma
      // conexão TCP para várias requisições. O padrão do Node é fechar a conexão ociosa em 5s —
      // menos do que o proxy espera. Quando os dois lados discordam, existe uma janela em que o
      // proxy manda uma requisição por uma conexão que o Node acabou de fechar, e ela volta como
      // 502 para o usuário. É o tipo de erro que aparece "do nada", em requisição nenhuma
      // específica, e que faz um serviço saudável parecer instável. Manter o lado do Node maior que
      // o do proxy fecha essa janela.
      servidor.keepAliveTimeout = 120_000;
      servidor.headersTimeout = 125_000; // precisa ser MAIOR que keepAliveTimeout
      servidor.requestTimeout = 0; // o timeout de verdade é o da chamada ao modelo, em chat.js

      // Todo deploy manda SIGTERM. Sem tratar, as requisições em andamento morrem no meio —
      // inclusive a de alguém que acabou de clicar em "Confirmar". Com isto, o servidor para de
      // aceitar conexões novas, termina o que está em curso e só então fecha o banco.
      let encerrando = false;
      for (const sinal of ['SIGTERM', 'SIGINT']) {
        process.on(sinal, () => {
          if (encerrando) return;
          encerrando = true;
          console.log(`[processo] ${sinal} recebido — encerrando com calma.`);
          servidor.close(async () => {
            try {
              await pool.end();
            } catch (e) {
              console.error('[pg] erro ao fechar o pool:', e && e.message);
            }
            process.exit(0);
          });
          // Se algo travar, não ficar pendurado para sempre.
          setTimeout(() => process.exit(0), 15_000).unref();
        });
      }
    })
    .catch((err) => {
      console.error('Falha ao migrar o banco na inicialização (depois de várias tentativas):', err);
      process.exit(1);
    });
}

module.exports = { app, migrate, acoesPendentes };
