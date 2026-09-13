// test_chat.js — testa o endpoint /api/chat sem depender de uma chave real do Groq (que nunca
// deve passar por este ambiente de testes). Cobre: comportamento sem chave configurada, validação
// de payload, e a lógica de confirmação de pendência isolada (que não chama a API do Groq).

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:quaratest@localhost:5432/quara_test';
// Garante que NÃO há chave configurada para a primeira leva de testes — simula exatamente o
// estado "chat ainda não configurado", que precisa se comportar de forma clara e não travar.
delete process.env.GROQ_API_KEY;

const { app, migrate } = require('./server');
const { pool } = require('./db');

async function limparTudo() {
  await pool.query(`
    TRUNCATE historico, aplicados, silenciados, limiar_valores, limiar_contagem, limiar_log, servico_overrides, gg_projetos
    RESTART IDENTITY
  `);
  await migrate();
}

const results = [];
function assert(cond, msg) {
  results.push({ ok: !!cond, msg });
  console.log((cond ? 'OK: ' : 'FAIL: ') + msg);
}

async function json(url, opts) {
  const r = await fetch(url, opts);
  let body = null;
  try {
    body = await r.json();
  } catch (e) {}
  return { status: r.status, body };
}

(async () => {
  await migrate();
  await limparTudo();
  const server = app.listen(0);
  const port = server.address().port;
  const BASE = `http://localhost:${port}`;
  console.log(`Servidor de teste em ${BASE}\n`);

  console.log('--- sem GROQ_API_KEY configurada ---');
  const semChave = await json(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mensagem: 'oi' }),
  });
  assert(semChave.status === 503, `Sem chave configurada, responde 503 (indisponível), não trava nem crasha — got ${semChave.status}`);
  assert(
    typeof semChave.body.error === 'string' && semChave.body.error.length > 0,
    'Mensagem de erro clara é retornada quando o chat não está configurado'
  );

  console.log('\n--- validação de payload ---');
  const semMensagem = await json(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert(semMensagem.status === 503 || semMensagem.status === 400, 'Payload sem mensagem nem confirmarPendencia é rejeitado de alguma forma clara (503 sem chave, ou 400 com chave)');

  console.log('\n--- confirmação de pendência inexistente ---');
  const pendenciaFalsa = await json(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmarPendencia: '99999' }),
  });
  assert(pendenciaFalsa.status === 404, `Confirmar uma pendência que não existe (id inventado) retorna 404, não trava — got ${pendenciaFalsa.status}`);

  console.log('\n--- executarFerramenta isolada (a peça real que o fluxo de confirmação chama) ---');
  const { executarFerramenta } = require('./chat');
  const TAXAS = { ger: 45, mem: 30, esp: 38 };

  const resCalc = await executarFerramenta('calcular_projeto_gg', {
    equipe: [{ tipo: 'mem', qtd: 2, semanas: 4, hSem: 6 }],
  }, { taxasHora: TAXAS });
  const custoEsperado = 2 * 4 * 6 * 30; // qtd*semanas*hSem*taxa
  assert(resCalc.custoTotal === custoEsperado, `calcular_projeto_gg retorna o custo correto (esperado ${custoEsperado}, got ${resCalc.custoTotal})`);
  assert(resCalc.comparacao === null, 'Sem histórico, comparacao é null (mesmo comportamento do endpoint REST equivalente)');

  const resAprovar = await executarFerramenta('aprovar_projeto_gg', {
    nomeProjeto: 'Projeto via chat (teste)',
    equipe: [{ tipo: 'mem', qtd: 2, semanas: 4, hSem: 6 }],
    precoAprovado: 5000,
  }, { taxasHora: TAXAS });
  assert(resAprovar.nomeProjeto === 'Projeto via chat (teste)', 'aprovar_projeto_gg realmente grava o projeto (mesma tabela que o fluxo REST usa)');

  const listaConfirmada = await executarFerramenta('listar_projetos_gg', {}, {});
  assert(
    listaConfirmada.some((p) => p.nomeProjeto === 'Projeto via chat (teste)'),
    'O projeto aprovado via ferramenta de chat aparece em listar_projetos_gg — confirma que é a MESMA tabela usada pelas rotas REST, não uma cópia separada'
  );

  const erroFerramentaDesconhecida = await executarFerramenta('ferramenta_que_nao_existe', {}, {}).catch((e) => e);
  assert(erroFerramentaDesconhecida instanceof Error, 'Chamar uma ferramenta desconhecida lança erro em vez de falhar silenciosamente');

  console.log('\n--- confirmação de pendência REAL via HTTP (injetando a pendência diretamente, sem precisar do Groq) ---');
  const { acoesPendentes } = require('./server');
  acoesPendentes.set('teste-1', {
    ferramenta: 'aprovar_projeto_gg',
    args: { nomeProjeto: 'Projeto via confirmação HTTP', equipe: [{ tipo: 'mem', qtd: 1, semanas: 2, hSem: 6 }], precoAprovado: 3000 },
    taxasHora: TAXAS,
  });
  const confirmacaoReal = await json(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmarPendencia: 'teste-1' }),
  });
  assert(confirmacaoReal.status === 200, `Confirmar uma pendência real via HTTP retorna 200 — got ${confirmacaoReal.status}`);
  assert(confirmacaoReal.body.tipo === 'executado', 'Resposta indica tipo:executado');
  assert(confirmacaoReal.body.resultado.nomeProjeto === 'Projeto via confirmação HTTP', 'O projeto foi realmente gravado com o nome correto');

  const listaAposConfirmacao = await json(`${BASE}/api/gg-projetos`);
  assert(
    listaAposConfirmacao.body.some((p) => p.nomeProjeto === 'Projeto via confirmação HTTP'),
    'O projeto confirmado via /api/chat aparece na listagem REST normal de gg-projetos — é a mesma tabela, não um caminho paralelo'
  );

  const confirmarDeNovo = await json(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmarPendencia: 'teste-1' }),
  });
  assert(confirmarDeNovo.status === 404, 'Confirmar a MESMA pendência uma segunda vez retorna 404 (ela foi consumida, não pode executar duas vezes por engano)');

  server.close();
  await pool.end();

  console.log('\n=== RESULT ===');
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    console.log(failures.map((f) => 'FAIL: ' + f.msg).join('\n'));
    console.log(`\n${failures.length} of ${results.length} checks FAILED`);
    process.exit(1);
  } else {
    console.log(`ALL ${results.length} CHECKS PASSED`);
    process.exit(0);
  }
})().catch((err) => {
  console.error('TEST CRASHED:', err);
  process.exit(1);
});
