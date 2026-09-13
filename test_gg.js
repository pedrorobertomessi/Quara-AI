process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:quaratest@localhost:5432/quara_test';

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

const TAXAS = { ger: 45, mem: 30, esp: 38 };

(async () => {
  await migrate();
  await limparTudo();
  const server = app.listen(0);
  const port = server.address().port;
  const BASE = `http://localhost:${port}`;
  console.log(`Servidor de teste em ${BASE}\n`);

  console.log('--- cálculo de custo ---');
  const equipe1 = [
    { tipo: 'ger', qtd: 1, semanas: 8, hSem: 6 },
    { tipo: 'mem', qtd: 2, semanas: 8, hSem: 6 },
  ];
  const r1 = await json(`${BASE}/api/gg-projetos/comparar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ equipe: equipe1, taxasHora: TAXAS }),
  });
  assert(r1.status === 200, 'POST /comparar responde 200 para um payload válido');
  assert(r1.body.custoTotal === 5040, `Custo total calculado corretamente (esperado 5040, got ${r1.body.custoTotal})`);
  assert(r1.body.precoSugerido === Math.round(5040 / 0.65 / 100) * 100, `Preço sugerido usa a mesma fórmula (custo/0.65, arredondado) — got ${r1.body.precoSugerido}`);
  assert(r1.body.comparacao === null, 'Sem histórico ainda, comparacao é null (não inventa uma média do nada)');

  const invalido = await json(`${BASE}/api/gg-projetos/comparar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ equipe: 'não é array' }),
  });
  assert(invalido.status === 400, 'Payload inválido (equipe não é array) retorna 400');

  console.log('\n--- registrar aprovações ---');
  const projA = await json(`${BASE}/api/gg-projetos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nomeProjeto: 'Projeto A',
      equipe: equipe1,
      custoTotal: 5040,
      precoSugerido: 7800,
      precoAprovado: 7800,
    }),
  });
  assert(projA.status === 201, 'Registrar uma aprovação retorna 201');
  assert(projA.body.diffPct === 0, 'diffPct é 0 quando aprovado == sugerido');

  const projB = await json(`${BASE}/api/gg-projetos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nomeProjeto: 'Projeto B',
      equipe: equipe1,
      custoTotal: 5040,
      precoSugerido: 7800,
      precoAprovado: 8580,
    }),
  });
  assert(projB.body.diffPct === 10, `diffPct calcula corretamente quando aprovado difere do sugerido (esperado 10, got ${projB.body.diffPct})`);

  const listaGet = await json(`${BASE}/api/gg-projetos`);
  assert(listaGet.body.length === 2, 'GET /api/gg-projetos lista os 2 projetos registrados');
  assert(Array.isArray(listaGet.body[0].equipe), 'Campo equipe volta como array (JSONB desserializado corretamente pelo driver)');

  console.log('\n--- comparação usa o histórico real ---');
  const r2 = await json(`${BASE}/api/gg-projetos/comparar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ equipe: equipe1, taxasHora: TAXAS }),
  });
  assert(r2.body.comparacao !== null, 'Com 2 projetos parecidos no histórico, comparacao deixa de ser null');
  if (r2.body.comparacao) {
    const mediaEsperada = Math.round((7800 + 8580) / 2);
    assert(
      r2.body.comparacao.mediaAprovada === mediaEsperada,
      `Média aprovada bate com a média real dos 2 projetos parecidos (esperado ${mediaEsperada}, got ${r2.body.comparacao.mediaAprovada})`
    );
    assert(r2.body.comparacao.amostra === 2, 'Comparação reporta o tamanho real da amostra usada (2)');
  }

  console.log('\n--- projetos diferentes não contaminam a comparação ---');
  const equipeGrande = [
    { tipo: 'ger', qtd: 3, semanas: 20, hSem: 6 },
    { tipo: 'mem', qtd: 8, semanas: 20, hSem: 6 },
  ];
  await json(`${BASE}/api/gg-projetos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nomeProjeto: 'Projeto Gigante',
      equipe: equipeGrande,
      custoTotal: 99999,
      precoSugerido: 150000,
      precoAprovado: 200000,
    }),
  });
  const r3 = await json(`${BASE}/api/gg-projetos/comparar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ equipe: equipe1, taxasHora: TAXAS }),
  });
  assert(
    r3.body.comparacao.amostra === 2,
    `Um projeto de composição muito diferente (3x mais gente, 2.5x mais semanas) NÃO entra na comparação de um projeto pequeno — amostra continua 2, got ${r3.body.comparacao.amostra}`
  );
  assert(
    r3.body.comparacao.mediaAprovada < 100000,
    `Média aprovada não é distorcida pelo projeto gigante (deveria continuar ~8190, got ${r3.body.comparacao.mediaAprovada})`
  );

  console.log('\n--- validação de payload ---');
  const semNome = await json(`${BASE}/api/gg-projetos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ equipe: equipe1, custoTotal: 5040, precoSugerido: 7800, precoAprovado: 7800 }),
  });
  assert(semNome.status === 400, 'Registrar sem nomeProjeto retorna 400');

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
