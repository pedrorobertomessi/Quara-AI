// test_ferramentas.js — testa o registro de ferramentas, a geração de arquivos de verdade
// (contrato, apresentação, gráfico), as rotas financeiras e o loop multi-etapa do chat.
//
// O loop é testado com um cliente do Groq FALSO, escrito aqui. Isso é de propósito e é o ponto mais
// importante deste arquivo: dá para verificar que o encadeamento funciona e — principalmente — que
// a regra "escrita nunca executa sem confirmação" continua valendo mesmo agora que o modelo pode
// pedir várias ferramentas seguidas, tudo isso sem gastar cota da API e sem depender de o modelo
// estar num bom dia. A confirmação de escrita é a única garantia real que o sistema dá à diretoria;
// um teste dela não pode depender de rede.

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:quaratest@localhost:5432/quara_test';
delete process.env.GROQ_API_KEY;

const { app, migrate } = require('./server');
const { pool } = require('./db');
const registro = require('./tools');
const { conduzirTurno, MAX_PASSOS } = require('./chat');
const artefatosLib = require('./lib/artefatos');

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

// ---------- Cliente do Groq de mentira ----------
// Devolve, em ordem, as respostas do roteiro. Registra os parâmetros de cada chamada para dar para
// verificar coisas como "no último passo as ferramentas foram retiradas da mesa".
function clienteFalso(roteiro) {
  const chamadas = [];
  return {
    chamadas,
    chat: {
      completions: {
        create: async (params) => {
          chamadas.push(params);
          const proximo = roteiro[chamadas.length - 1];
          if (!proximo) throw new Error('roteiro do cliente falso acabou');
          return typeof proximo === 'function' ? proximo(params) : proximo;
        },
      },
    },
  };
}
const respostaTexto = (texto) => ({ choices: [{ message: { role: 'assistant', content: texto } }] });
const respostaFerramentas = (lista) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: lista.map((f, i) => ({ id: `call_${i}`, type: 'function', function: { name: f.nome, arguments: JSON.stringify(f.args || {}) } })),
      },
    },
  ],
});

const TAXAS = { ger: 15, mem: 10, esp: 30 };

(async () => {
  await migrate();
  await pool.query('TRUNCATE historico, gg_projetos, fin_lancamentos, fin_config, artefatos RESTART IDENTITY');
  const server = app.listen(0);
  const BASE = `http://localhost:${server.address().port}`;

  console.log('--- registro de ferramentas ---');
  assert(registro.FERRAMENTAS.length >= 25, `Registro reúne as ferramentas de todos os módulos — got ${registro.FERRAMENTAS.length}`);
  assert(
    registro.FERRAMENTAS.every((f) => typeof f.executar === 'function'),
    'Toda ferramenta registrada tem uma implementação'
  );
  assert(
    registro.FERRAMENTAS.every((f) => f.declaracao.function.name === f.nome),
    'O nome declarado ao modelo bate com o nome no registro (senão o modelo pede uma e roda outra)'
  );
  assert(new Set(registro.FERRAMENTAS.map((f) => f.nome)).size === registro.FERRAMENTAS.length, 'Não há nomes duplicados');
  const escritas = registro.FERRAMENTAS.filter((f) => f.escrita).map((f) => f.nome);
  for (const esperada of ['aprovar_projeto_gg', 'registrar_preco_praticado', 'registrar_lancamento_financeiro', 'gerar_contrato']) {
    assert(escritas.includes(esperada), `"${esperada}" está marcada como escrita (exige confirmação)`);
  }
  assert(!registro.FERRAMENTAS.find((f) => f.nome === 'projetar_caixa').escrita, 'Projeção é leitura — não exige confirmação');

  console.log('\n--- artefatos ---');
  const art = await artefatosLib.salvar({ nome: 'teste.txt', mime: 'text/plain', buffer: Buffer.from('conteúdo de teste'), tipo: 'imagem', descricao: 'teste' });
  assert(art.url === `/api/artefatos/${art.id}`, 'Artefato salvo devolve a URL de download');
  const baixado = await fetch(`${BASE}${art.url}`);
  assert(baixado.status === 200, 'A URL do artefato serve o arquivo — got ' + baixado.status);
  assert((await baixado.text()) === 'conteúdo de teste', 'O conteúdo baixado é idêntico ao salvo (bytes preservados no banco)');
  const inexistente = await json(`${BASE}/api/artefatos/nao-existe`);
  assert(inexistente.status === 404 && /não existe mais/.test(inexistente.body.error), 'Artefato inexistente devolve 404 com explicação, não erro cru');

  console.log('\n--- financeiro via REST ---');
  const criado = await json(`${BASE}/api/financeiro/lancamentos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo: 'saida', descricao: 'Custo fixo mensal', valor: 800, mes: '2026-10', recorrencia: 'mensal' }),
  });
  assert(criado.status === 201 && criado.body.valor === 800, 'Lançamento é criado via REST');
  const invalido = await json(`${BASE}/api/financeiro/lancamentos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo: 'outra-coisa', valor: 100, mes: '2026-10' }),
  });
  assert(invalido.status === 400, 'Tipo inválido de lançamento é recusado com 400');
  const mesInvalido = await json(`${BASE}/api/financeiro/lancamentos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo: 'saida', valor: 100, mes: 'outubro' }),
  });
  assert(mesInvalido.status === 400, "Mês fora do formato 'AAAA-MM' é recusado");

  await json(`${BASE}/api/financeiro/saldo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ saldo: 5000 }) });
  const saldo = await json(`${BASE}/api/financeiro/saldo`);
  assert(saldo.body.saldoCaixa === 5000, 'Saldo de caixa é gravado e relido');

  const projecaoSemVendas = await json(`${BASE}/api/financeiro/projecao?meses=3`);
  assert(projecaoSemVendas.status === 200, 'Projeção responde mesmo sem nenhuma venda registrada');
  assert(projecaoSemVendas.body.faturamento.metodo === 'sem-dados', 'Sem vendas, a projeção de faturamento se declara sem dados');
  assert(projecaoSemVendas.body.caixa.fluxo.length === 3, 'Fluxo de caixa cobre os meses pedidos mesmo sem receita');

  // Com vendas no histórico, a projeção passa a ter base. Usa as duas tabelas de receita de
  // propósito — é o comportamento que faria falta se alguém esquecesse os projetos de GG.
  const agora = Date.now();
  const mesEmMs = 30 * 24 * 60 * 60 * 1000;
  for (let i = 6; i >= 1; i--) {
    await pool.query('INSERT INTO historico (servico_id, servico_nome, preco, margem, banda_nome, data) VALUES ($1,$2,$3,$4,$5,$6)', [
      0,
      'Pesquisa de mercado',
      8000,
      40,
      'Standard',
      agora - i * mesEmMs,
    ]);
  }
  await pool.query(
    'INSERT INTO gg_projetos (nome_projeto, equipe, custo_total, preco_sugerido, preco_aprovado, diff_pct, data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    ['Projeto GG', JSON.stringify([{ tipo: 'mem', qtd: 1, semanas: 4, hSem: 6 }]), 240, 400, 5000, 0, agora - 2 * mesEmMs]
  );
  const eventos = await require('./tools/financeiro').eventosDeReceita();
  assert(eventos.length === 7, 'Receita considera histórico de vendas E projetos aprovados por GG — got ' + eventos.length);
  const projecaoComDados = await json(`${BASE}/api/financeiro/projecao?meses=4`);
  assert(projecaoComDados.body.faturamento.projecao.length === 4, 'Projeção de faturamento cobre o horizonte pedido');
  assert(
    projecaoComDados.body.caixa.fluxo.every((m) => m.saidas === 800),
    'O custo fixo mensal cadastrado incide em todos os meses da projeção de caixa'
  );
  assert(
    projecaoComDados.body.caixa.entradasProjetadasUsaramCenario === 'conservador',
    'O caixa é planejado pelo cenário conservador, não pelo esperado'
  );

  console.log('\n--- geração de arquivos ---');
  const grafico = await registro.executarFerramenta('gerar_grafico', {
    titulo: 'Faturamento projetado',
    tipo: 'barra',
    categorias: ['out/26', 'nov/26', 'dez/26'],
    series: [{ nome: 'Base', valores: [12000, 14000, 13000] }],
  });
  const bytesGrafico = await artefatosLib.obter(grafico.id);
  assert(bytesGrafico.conteudo.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'O gráfico gerado é um PNG válido (assinatura correta)');
  assert(bytesGrafico.conteudo.length > 5000, 'O PNG tem conteúdo de verdade, não é um arquivo vazio');

  const erroGrafico = await registro.executarFerramenta('gerar_grafico', {
    titulo: 'Errado',
    categorias: ['a', 'b', 'c'],
    series: [{ nome: 'X', valores: [1, 2] }],
  }).catch((e) => e);
  assert(erroGrafico instanceof Error && /recisam bater/.test(erroGrafico.message), 'Série com menos valores que categorias é recusada com mensagem clara');

  const deck = await registro.executarFerramenta('gerar_apresentacao', {
    titulo: 'Proposta comercial',
    subtitulo: 'Cliente exemplo',
    slides: [
      { tipo: 'secao', numero: 1, titulo: 'Diagnóstico' },
      { tipo: 'topicos', titulo: 'O que encontramos', itens: [{ titulo: 'Ponto um', detalhe: 'Detalhe do ponto um' }] },
      { tipo: 'numeros', titulo: 'Números', metricas: [{ valor: 'R$ 6.500', rotulo: 'Investimento' }] },
      { tipo: 'grafico', titulo: 'Projeção', categorias: ['out', 'nov'], series: [{ nome: 'Base', valores: [1, 2] }] },
      { tipo: 'duas_colunas', titulo: 'Antes e depois', esquerda: { titulo: 'Hoje', itens: ['a'] }, direita: { titulo: 'Depois', itens: ['b'] } },
      { tipo: 'tabela', titulo: 'Etapas', colunas: ['Etapa', 'Prazo'], linhas: [['Mapeamento', '2 semanas']] },
      { tipo: 'imagem', titulo: 'Visão geral', artefatoId: grafico.id, legenda: 'Projeção de faturamento' },
    ],
  });
  const bytesDeck = await artefatosLib.obter(deck.id);
  assert(bytesDeck.conteudo.slice(0, 2).toString() === 'PK', 'A apresentação é um arquivo OOXML (zip) válido');
  assert(deck.nome.endsWith('.pptx'), 'A apresentação sai com extensão .pptx');
  assert(deck.totalSlides === 9, 'Capa e encerramento entram automaticamente (7 pedidos + 2) — got ' + deck.totalSlides);

  const tipoErrado = await registro.executarFerramenta('gerar_apresentacao', { titulo: 'x', slides: [{ tipo: 'inexistente' }] }).catch((e) => e);
  assert(tipoErrado instanceof Error && /desconhecido/.test(tipoErrado.message), 'Tipo de slide inválido é recusado listando os válidos');

  const dadosContrato = {
    contratante: {
      nome: 'Empresa Exemplo Ltda',
      documento: '12.345.678/0001-90',
      endereco: 'Rua Teste, 100, Araraquara-SP',
      representante: { nome: 'Fulano de Tal', cpf: '111.222.333-44', email: 'fulano@exemplo.com.br' },
    },
    representanteContratada: { nome: 'Presidente da Vez', cpf: '456.611.958-00' },
    objeto: 'estruturar uma análise de mercado',
    prazoSemanas: 10,
    valorTotal: 6500,
    parcelado: true,
    numParcelas: 5,
  };
  const contrato = await registro.executarFerramenta('gerar_contrato', dadosContrato);
  assert(contrato.gerado === true && contrato.nome.endsWith('.docx'), 'Contrato completo gera um .docx');
  const bytesContrato = await artefatosLib.obter(contrato.id);
  assert(bytesContrato.conteudo.slice(0, 2).toString() === 'PK', 'O contrato é um arquivo OOXML (zip) válido');
  assert(contrato.resumo.parcelas.length === 5, 'O resumo do contrato traz o cronograma de parcelas');
  assert(typeof contrato.aviso === 'string', 'O contrato vem com aviso para conferência antes do envio');

  const contratoIncompleto = await registro.executarFerramenta('gerar_contrato', { objeto: 'alguma coisa' });
  assert(contratoIncompleto.gerado === false, 'Contrato sem dados obrigatórios NÃO é gerado');
  assert(Array.isArray(contratoIncompleto.perguntas) && contratoIncompleto.perguntas.length > 0, 'Contrato incompleto devolve as perguntas a fazer em vez de um documento com lacunas');

  const verificacao = await registro.executarFerramenta('verificar_dados_contrato', { objeto: 'x' });
  assert(verificacao.completo === false && verificacao.faltando.some((f) => f.campo === 'valorTotal'), 'A verificação prévia aponta exatamente quais campos faltam');

  console.log('\n--- loop multi-etapa do chat ---');
  const cliente = clienteFalso([
    // Passo 1: duas leituras independentes, pedidas de uma vez só
    respostaFerramentas([{ nome: 'listar_historico_vendas', args: {} }, { nome: 'projetar_faturamento', args: { meses: 3 } }]),
    // Passo 2: usando o resultado dos anteriores, gera um gráfico
    respostaFerramentas([{ nome: 'gerar_grafico', args: { titulo: 'Projeção', categorias: ['a', 'b'], series: [{ nome: 'Base', valores: [1, 2] }] } }]),
    // Passo 3: responde
    respostaTexto('Aqui está a projeção com o gráfico.'),
  ]);
  const turno = await conduzirTurno({ client: cliente, mensagem: 'projete o faturamento e faça um gráfico', historico: [], contexto: { taxasHora: TAXAS } });
  assert(turno.tipo === 'resposta' && turno.passos === 3, 'O loop encadeia três passos numa única mensagem — got ' + turno.passos);
  assert(turno.ferramentasUsadas.length === 3, 'As três ferramentas foram executadas — got ' + turno.ferramentasUsadas.map((f) => f.nome).join(','));
  assert(cliente.chamadas.length === 3, 'Foram três idas ao modelo, uma por passo');
  assert(turno.artefatos.length === 1 && turno.artefatos[0].url.startsWith('/api/artefatos/'), 'O arquivo gerado no meio do turno volta como artefato para download');
  assert(
    turno.historico.filter((m) => m.role === 'tool').length === 3,
    'Os resultados das ferramentas ficam no histórico, para o modelo não reconsultar tudo na próxima mensagem'
  );
  assert(turno.historico[0].role === 'user' && !turno.historico.some((m) => m.role === 'system'), 'O histórico devolvido não carrega a mensagem de sistema (ela é remontada a cada turno)');

  console.log('\n--- escrita no meio do loop PARA tudo e vira pendência ---');
  const antesDaTentativa = (await pool.query('SELECT COUNT(*)::int AS n FROM gg_projetos')).rows[0].n;
  const clienteEscrita = clienteFalso([
    respostaFerramentas([{ nome: 'listar_projetos_gg', args: {} }]),
    respostaFerramentas([{ nome: 'aprovar_projeto_gg', args: { nomeProjeto: 'NÃO DEVE SER GRAVADO', equipe: [{ tipo: 'mem', qtd: 1, semanas: 2, hSem: 6 }], precoAprovado: 9999 } }]),
    respostaTexto('não deveria chegar aqui'),
  ]);
  const turnoEscrita = await conduzirTurno({ client: clienteEscrita, mensagem: 'aprova aí', historico: [], contexto: { taxasHora: TAXAS } });
  assert(turnoEscrita.tipo === 'pendente', 'Ferramenta de escrita no meio do encadeamento devolve pendência');
  assert(turnoEscrita.ferramenta === 'aprovar_projeto_gg' && turnoEscrita.args.precoAprovado === 9999, 'A pendência carrega os parâmetros exatos que o modelo pediu');
  assert(clienteEscrita.chamadas.length === 2, 'O loop parou no passo da escrita, sem seguir adiante — got ' + clienteEscrita.chamadas.length);
  const depoisDaTentativa = (await pool.query('SELECT COUNT(*)::int AS n FROM gg_projetos')).rows[0].n;
  assert(depoisDaTentativa === antesDaTentativa, 'NADA foi gravado no banco sem confirmação — a regra central do sistema');
  assert(turnoEscrita.ferramentasUsadas.length === 1, 'As leituras feitas antes da escrita não são desperdiçadas');

  console.log('\n--- escrita logo na primeira resposta ---');
  const clienteEscritaDireta = clienteFalso([
    respostaFerramentas([{ nome: 'registrar_preco_praticado', args: { servicoNome: 'Pesquisa', preco: 9000 } }]),
  ]);
  const turnoDireto = await conduzirTurno({ client: clienteEscritaDireta, mensagem: 'registra 9000', historico: [], contexto: {} });
  assert(turnoDireto.tipo === 'pendente' && turnoDireto.ferramenta === 'registrar_preco_praticado', 'Escrita pedida de cara também vira pendência');
  const registros = (await pool.query("SELECT COUNT(*)::int AS n FROM historico WHERE preco = 9000")).rows[0].n;
  assert(registros === 0, 'O preço não foi gravado antes da confirmação');

  console.log('\n--- falha de ferramenta não derruba a resposta ---');
  const clienteFalha = clienteFalso([
    respostaFerramentas([{ nome: 'consultar_processo_judicial', args: { numeroProcesso: '123' } }]),
    (params) => {
      const ultima = params.messages[params.messages.length - 1];
      assert(ultima.role === 'tool' && /erro/.test(ultima.content), 'O erro da ferramenta volta ao modelo como resultado, não como exceção');
      return respostaTexto('Esse número de processo não está no padrão CNJ.');
    },
  ]);
  const turnoFalha = await conduzirTurno({ client: clienteFalha, mensagem: 'consulta o processo 123', historico: [], contexto: {} });
  assert(turnoFalha.tipo === 'resposta', 'Ferramenta que falha ainda produz uma resposta para a pessoa');
  assert(turnoFalha.ferramentasUsadas[0].ok === false, 'A ferramenta que falhou é marcada como falha');

  console.log('\n--- teto de passos ---');
  const roteiroInfinito = Array.from({ length: MAX_PASSOS + 2 }, () => respostaFerramentas([{ nome: 'listar_limiares', args: {} }]));
  const clienteInfinito = clienteFalso([...roteiroInfinito.slice(0, MAX_PASSOS - 1), respostaTexto('parei por aqui')]);
  const turnoLongo = await conduzirTurno({ client: clienteInfinito, mensagem: 'faz tudo', historico: [], contexto: {} });
  assert(turnoLongo.passos === MAX_PASSOS, `O loop vai até o teto de ${MAX_PASSOS} passos — got ${turnoLongo.passos}`);
  assert(clienteInfinito.chamadas[MAX_PASSOS - 1].tools === undefined, 'No último passo as ferramentas são retiradas, forçando o modelo a responder com o que tem');

  console.log('\n--- contexto da tela chega às ferramentas ---');
  const semContexto = await registro.executarFerramenta('consultar_tabela_de_precos', {}, {});
  assert(semContexto.disponivel === false && /app/.test(semContexto.mensagem), 'Sem a tabela da tela, explica por que não sabe em vez de inventar');
  const comContexto = await registro.executarFerramenta('consultar_tabela_de_precos', {}, { servicos: [{ id: 0, nome: 'Pesquisa de mercado', min: 7000, max: 10000 }] });
  assert(comContexto.disponivel === true && comContexto.servicos.length === 1, 'Com a tabela no contexto, a ferramenta a devolve');
  const erroSemTaxas = await registro.executarFerramenta('calcular_projeto_gg', { equipe: [{ tipo: 'mem', qtd: 1, semanas: 1, hSem: 6 }] }, {}).catch((e) => e);
  assert(erroSemTaxas instanceof Error && /valores-hora/.test(erroSemTaxas.message), 'Sem valores-hora, o cálculo de GG recusa em vez de usar zero');

  console.log('\n--- backup cobre as decisões novas ---');
  const backup = await json(`${BASE}/api/backup`);
  assert(backup.body.versao === 2, 'O backup agora sai na versão 2');
  assert(Array.isArray(backup.body.gg_projetos), 'Projetos de GG entram no backup (são decisões de valor da diretoria)');
  assert(backup.body.fin_lancamentos.length >= 1, 'Lançamentos financeiros entram no backup');
  assert(backup.body.fin_config.some((c) => c.chave === 'saldo_caixa'), 'O saldo de caixa entra no backup');
  assert(backup.body.artefatos === undefined, 'Arquivos gerados NÃO entram no backup — são regeráveis e inflariam o arquivo');

  // Restaurar o backup recém-baixado tem que deixar o banco exatamente como estava. É o caminho
  // que vai ser exercido quando o Postgres gratuito expirar, com dados reais em jogo.
  const restaurado = await json(`${BASE}/api/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup.body) });
  assert(restaurado.status === 200, 'A restauração do próprio backup funciona — got ' + restaurado.status);
  const saldoDepois = await json(`${BASE}/api/financeiro/saldo`);
  assert(saldoDepois.body.saldoCaixa === 5000, 'O saldo de caixa sobrevive ao ciclo backup → restauração');
  const lancDepois = await json(`${BASE}/api/financeiro/lancamentos`);
  assert(lancDepois.body.length === backup.body.fin_lancamentos.length, 'Os lançamentos sobrevivem ao ciclo backup → restauração');

  const backupAntigo = { ...backup.body, versao: 1, gg_projetos: undefined, fin_lancamentos: undefined, fin_config: undefined };
  const restauroAntigo = await json(`${BASE}/api/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backupAntigo) });
  assert(restauroAntigo.status === 200, 'Um backup no formato antigo (versão 1) continua restaurável — got ' + restauroAntigo.status);

  console.log('\n--- saúde do serviço ---');
  const saude = await json(`${BASE}/api/health`);
  assert(saude.body.ferramentas === registro.FERRAMENTAS.length, 'O /api/health informa quantas ferramentas estão ativas');
  assert(saude.body.capacidades.chat === false, 'Sem GROQ_API_KEY, o health declara o chat indisponível (em vez de dizer que está tudo bem)');
  assert(saude.body.capacidades.geracaoDeImagem === true, 'O health confirma que a geração de imagem está instalada');

  server.close();
  await pool.end();

  const falhas = results.filter((r) => !r.ok);
  console.log('\n=== RESULT ===');
  if (falhas.length) {
    console.log(`${falhas.length} CHECK(S) FAILED de ${results.length}`);
    falhas.forEach((f) => console.log('  - ' + f.msg));
    process.exit(1);
  }
  console.log(`ALL ${results.length} CHECKS PASSED`);
  process.exit(0);
})().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});
