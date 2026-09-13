process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:quaratest@localhost:5432/quara_test';

const { app, migrate } = require('./server');
const { pool } = require('./db');

async function limparTudo() {
  await pool.query(`
    TRUNCATE historico, aplicados, silenciados, limiar_valores, limiar_contagem, limiar_log, servico_overrides
    RESTART IDENTITY
  `);
  await migrate(); // re-semeia os limiares-padrão depois do TRUNCATE
}

const results = [];
function assert(cond, msg) {
  results.push({ ok: !!cond, msg });
  console.log((cond ? 'OK: ' : 'FAIL: ') + msg);
}

(async () => {
  await migrate();
  await limparTudo();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const BASE = `http://localhost:${port}`;

  console.log(`Servidor de teste rodando em ${BASE}`);

  const N = 5;
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(
      fetch(`${BASE}/api/limiares/desvioHist/decisao`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisao: 'ignorou' }),
      }).then((r) => r.json())
    );
  }
  const responses = await Promise.all(promises);

  assert(responses.every((r) => r && r.valores), `Todas as ${N} requisições concorrentes completaram com sucesso (nenhuma rejeitada ou corrompida)`);

  const finalState = await fetch(`${BASE}/api/limiares`).then((r) => r.json());
  const contagemIgnoradas = finalState.contagem.desvioHist ? finalState.contagem.desvioHist.ignoradas : 0;
  assert(
    contagemIgnoradas === N,
    `Contagem final reflete exatamente ${N} decisões concorrentes (nenhuma perdida por corrida) — got ${contagemIgnoradas}`
  );

  const promises2 = [];
  for (let i = 0; i < 6; i++) {
    promises2.push(
      fetch(`${BASE}/api/limiares/margemBanda/decisao`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisao: 'ignorou' }),
      }).then((r) => r.json())
    );
  }
  await Promise.all(promises2);

  const stateAfterRound2 = await fetch(`${BASE}/api/limiares`).then((r) => r.json());
  assert(
    stateAfterRound2.valores.margemBanda === 10,
    `Após 6 decisões concorrentes de 'ignorou', margemBanda ajusta corretamente para 10 (não fica travado, não pula demais) — got ${stateAfterRound2.valores.margemBanda}`
  );
  assert(
    stateAfterRound2.log.length === 1,
    `Exatamente 1 entrada de ajuste no log, mesmo com 6 requisições concorrentes competindo para escrevê-lo — got ${stateAfterRound2.log.length}`
  );

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
