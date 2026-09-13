process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:quaratest@localhost:5432/quara_test';

const { app, migrate } = require('./server');
const { pool } = require('./db');

// Limpa todas as tabelas antes de rodar — equivalente a apagar o arquivo .db do SQLite, mas para
// um banco Postgres compartilhado que já existe e só precisa ser esvaziado entre execuções.
async function limparTudo() {
  await pool.query(`
    TRUNCATE historico, aplicados, silenciados, limiar_valores, limiar_contagem, limiar_log, servico_overrides
    RESTART IDENTITY
  `);
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
  } catch (e) {
    /* corpo vazio, ex. em 204 */
  }
  return { status: r.status, body };
}

(async () => {
  await migrate();
  await limparTudo();
  await migrate(); // re-semeia os limiares-padrão depois do TRUNCATE, que os apagou junto com o resto
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const BASE = `http://localhost:${port}`;
  console.log(`Servidor de teste em ${BASE}\n`);

  // ---------- health ----------
  console.log('--- health ---');
  const health = await json(`${BASE}/api/health`);
  assert(health.status === 200 && health.body.ok === true, 'GET /api/health retorna 200 e ok:true');

  // ---------- historico ----------
  console.log('\n--- historico ---');
  const r1 = await json(`${BASE}/api/historico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ servicoId: 0, servicoNome: 'Pesquisa de mercado', preco: 5000, margem: -11, bandaNome: 'Entry' }),
  });
  assert(r1.status === 201 && typeof r1.body.id === 'number', 'POST /api/historico cria e retorna um id numérico');

  await json(`${BASE}/api/historico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ servicoId: 0, servicoNome: 'Pesquisa de mercado', preco: 4700, margem: -18, bandaNome: 'Entry' }),
  });

  const list1 = await json(`${BASE}/api/historico`);
  assert(list1.status === 200 && list1.body.length === 2, 'GET /api/historico retorna as 2 entradas criadas');
  assert(list1.body[0].servicoNome === 'Pesquisa de mercado', 'Campos do histórico mapeiam corretamente (servicoNome em camelCase, não servico_nome)');

  const invalidHist = await json(`${BASE}/api/historico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ servicoId: 'nao-eh-numero' }),
  });
  assert(invalidHist.status === 400, 'POST /api/historico com payload inválido retorna 400');

  const delOne = await json(`${BASE}/api/historico/${r1.body.id}`, { method: 'DELETE' });
  assert(delOne.status === 204, 'DELETE /api/historico/:id retorna 204');

  const listAfterDel = await json(`${BASE}/api/historico`);
  assert(listAfterDel.body.length === 1, 'Histórico tem 1 entrada após deletar uma das 2');

  const delAll = await json(`${BASE}/api/historico`, { method: 'DELETE' });
  assert(delAll.status === 204, 'DELETE /api/historico (sem id) retorna 204');
  const listAfterClear = await json(`${BASE}/api/historico`);
  assert(listAfterClear.body.length === 0, 'Histórico fica vazio após limpar tudo');

  // ---------- aplicados ----------
  console.log('\n--- aplicados ---');
  const ap1 = await json(`${BASE}/api/aplicados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'hist-0', servicoId: 0, servicoNome: 'Pesquisa de mercado', preco: 4900, de: 8500, motivo: 'teste' }),
  });
  assert(ap1.status === 201 && ap1.body.preco === 4900, 'POST /api/aplicados cria com o preço correto');

  const ap2 = await json(`${BASE}/api/aplicados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'hist-0', servicoId: 0, servicoNome: 'Pesquisa de mercado', preco: 5100, de: 8500, motivo: 'teste2' }),
  });
  const apList = await json(`${BASE}/api/aplicados`);
  assert(apList.body.length === 1, 'Reenviar o mesmo id de aplicado faz upsert, não duplica linha');
  assert(apList.body[0].preco === 5100, 'Upsert atualiza o valor (5100), não fica com o antigo (4900)');

  // ---------- silenciados ----------
  console.log('\n--- silenciados ---');
  let sResp;
  for (let i = 0; i < 3; i++) {
    sResp = await json(`${BASE}/api/silenciados/piso-1/ignorar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ severidade: 'medio' }),
    });
  }
  assert(sResp.body.count === 3, '3 ignoradas na mesma severidade acumulam count=3');

  const sWorsen = await json(`${BASE}/api/silenciados/piso-1/ignorar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ severidade: 'alto' }),
  });
  assert(sWorsen.body.count === 1, 'Severidade piorando (medio->alto) reseta count para 1, não acumula para 4');

  const sInvalid = await json(`${BASE}/api/silenciados/piso-1/ignorar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ severidade: 'bogus' }),
  });
  assert(sInvalid.status === 400, 'Severidade inválida retorna 400');

  const silenciadosGet = await json(`${BASE}/api/silenciados`);
  assert(silenciadosGet.body['piso-1'] && silenciadosGet.body['piso-1'].count === 1, 'GET /api/silenciados retorna o objeto indexado por sugestao_id corretamente');

  // ---------- limiares ----------
  console.log('\n--- limiares ---');
  const limDefault = await json(`${BASE}/api/limiares`);
  assert(limDefault.body.valores.desvioHist === 8, 'desvioHist tem valor padrão 8');
  assert(limDefault.body.valores.margemBanda === 8, 'margemBanda tem valor padrão 8');
  assert(Array.isArray(limDefault.body.log) && limDefault.body.log.length === 0, 'Log de ajustes começa vazio');

  for (let i = 0; i < 3; i++) {
    await json(`${BASE}/api/limiares/desvioHist/decisao`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisao: 'aplicou' }),
    });
  }
  const limBelowMin = await json(`${BASE}/api/limiares`);
  assert(limBelowMin.body.valores.desvioHist === 8, 'Com só 3 decisões (abaixo da amostra mínima de 6), o limiar não muda ainda');

  for (let i = 0; i < 2; i++) {
    await json(`${BASE}/api/limiares/desvioHist/decisao`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisao: 'aplicou' }),
    });
  }
  const limAfterHigh = await json(`${BASE}/api/limiares/desvioHist/decisao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisao: 'ignorou' }),
  });
  assert(limAfterHigh.body.valores.desvioHist === 6, 'Taxa de aplicação de 83% em 6 decisões derruba o limiar de 8 para 6');
  assert(limAfterHigh.body.log.length === 1, 'Um ajuste fica registrado no log');
  assert(limAfterHigh.body.log[0].de === 8 && limAfterHigh.body.log[0].para === 6, 'Log registra de:8 para:6 corretamente');
  assert(limAfterHigh.body.log[0].taxaAplicacao === 83, 'Log registra a taxa de aplicação correta (83%)');

  await json(`${BASE}/api/limiares/margemBanda/decisao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisao: 'aplicou' }),
  });
  let limMargem;
  for (let i = 0; i < 5; i++) {
    limMargem = await json(`${BASE}/api/limiares/margemBanda/decisao`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisao: 'ignorou' }),
    });
  }
  assert(limMargem.body.valores.margemBanda === 10, 'Taxa de aplicação de 17% em 6 decisões sobe margemBanda de 8 para 10');

  const badRule = await json(`${BASE}/api/limiares/naoExiste/decisao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisao: 'aplicou' }),
  });
  assert(badRule.status === 400, 'Regra desconhecida retorna 400');

  const badDecision = await json(`${BASE}/api/limiares/desvioHist/decisao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisao: 'talvez' }),
  });
  assert(badDecision.status === 400, 'Decisão inválida retorna 400');

  // Piso: desvioHist está em 6; empurra pra baixo repetidamente e confirma que trava em 4
  let limFloor;
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 5; i++) {
      await json(`${BASE}/api/limiares/desvioHist/decisao`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisao: 'aplicou' }),
      });
    }
    limFloor = await json(`${BASE}/api/limiares/desvioHist/decisao`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisao: 'ignorou' }),
    });
  }
  assert(limFloor.body.valores.desvioHist === 4, 'Limiar trava no piso (4), não vai abaixo');

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
