// tools/financeiro.js — projeção de faturamento e de caixa, ligadas aos dados reais do banco.
//
// A matemática toda mora em lib/financeiro-logic.js; aqui é só a camada que busca os dados e
// decide o que alimenta o quê. A separação vale a pena porque a parte difícil de acertar (a
// projeção) fica testável sem banco, e a parte fácil de errar (qual tabela é receita) fica
// explícita em um lugar só.
//
// Uma decisão que define o resto: a receita realizada da EJ é a soma de DUAS tabelas que já
// existem — `historico` (preços praticados nos serviços de tabela) e `gg_projetos` (valores
// aprovados por Gente e Gestão). Elas nasceram para fins diferentes, mas as duas registram
// dinheiro efetivamente fechado, e projetar faturamento ignorando metade disso daria um número
// sistematicamente baixo.

const { pool } = require('../db');
const fin = require('../lib/financeiro-logic');

async function eventosDeReceita() {
  const [vendas, projetos] = await Promise.all([
    pool.query('SELECT preco, data, servico_nome FROM historico'),
    pool.query('SELECT preco_aprovado, data, nome_projeto FROM gg_projetos'),
  ]);
  return [
    ...vendas.rows.map((r) => ({ valor: Number(r.preco), data: Number(r.data), origem: 'venda', descricao: r.servico_nome })),
    ...projetos.rows.map((r) => ({ valor: Number(r.preco_aprovado), data: Number(r.data), origem: 'projeto GG', descricao: r.nome_projeto })),
  ];
}

async function lerConfig(chave, padrao) {
  const { rows } = await pool.query('SELECT valor FROM fin_config WHERE chave = $1', [chave]);
  return rows[0] ? Number(rows[0].valor) : padrao;
}

async function gravarConfig(chave, valor) {
  await pool.query(
    `INSERT INTO fin_config (chave, valor, atualizado_em) VALUES ($1, $2, $3)
     ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`,
    [chave, valor, Date.now()]
  );
}

function rowToLancamento(r) {
  return {
    id: r.id,
    tipo: r.tipo,
    descricao: r.descricao,
    valor: Number(r.valor),
    mes: r.mes,
    rotulo: fin.rotuloMes(r.mes),
    recorrencia: r.recorrencia,
    ateMes: r.ate_mes,
    origem: r.origem,
  };
}

async function listarLancamentos() {
  const { rows } = await pool.query('SELECT * FROM fin_lancamentos ORDER BY mes, tipo, id');
  return rows.map(rowToLancamento);
}

async function registrarLancamento({ tipo, descricao, valor, mes, recorrencia = 'unica', ateMes, origem = 'manual' }) {
  if (!['entrada', 'saida'].includes(tipo)) throw new Error("tipo precisa ser 'entrada' ou 'saida'");
  if (!(Number(valor) > 0)) throw new Error('valor precisa ser maior que zero');
  if (!/^\d{4}-\d{2}$/.test(String(mes || ''))) throw new Error("mes precisa estar no formato 'AAAA-MM'");
  if (!['unica', 'mensal'].includes(recorrencia)) throw new Error("recorrencia precisa ser 'unica' ou 'mensal'");
  const { rows } = await pool.query(
    `INSERT INTO fin_lancamentos (tipo, descricao, valor, mes, recorrencia, ate_mes, origem, criado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [tipo, descricao || '', Number(valor), mes, recorrencia, ateMes || null, origem, Date.now()]
  );
  return rowToLancamento(rows[0]);
}

async function removerLancamento({ id }) {
  const r = await pool.query('DELETE FROM fin_lancamentos WHERE id = $1 RETURNING *', [id]);
  if (!r.rowCount) throw new Error(`Não existe lançamento com id ${id}.`);
  return { removido: rowToLancamento(r.rows[0]) };
}

// ---------- Projeções ----------

async function projetarFaturamento({ meses = 6, crescimentoMensalPct }) {
  const eventos = await eventosDeReceita();
  const resultado = fin.projetarFaturamento(eventos, {
    meses,
    crescimentoMensalPct,
    mesReferencia: fin.chaveMes(Date.now()),
  });
  return {
    ...resultado,
    baseDeDados: `${eventos.length} registro(s) de receita (histórico de vendas + projetos aprovados por GG)`,
  };
}

async function projetarCaixa({ meses = 6, saldoAtual, incluirProjecaoDeVendas = true, crescimentoMensalPct }) {
  const mesRef = fin.chaveMes(Date.now());
  const saldoInicial = saldoAtual !== undefined && saldoAtual !== null ? Number(saldoAtual) : await lerConfig('saldo_caixa', 0);
  const lancamentos = await listarLancamentos();

  let projecaoFaturamento = null;
  let entradasProjetadas = [];
  if (incluirProjecaoDeVendas) {
    const eventos = await eventosDeReceita();
    projecaoFaturamento = fin.projetarFaturamento(eventos, { meses, crescimentoMensalPct, mesReferencia: mesRef });
    // O cenário CONSERVADOR é o que entra no caixa, não o cenário base. Planejar caixa pelo valor
    // esperado é o jeito clássico de descobrir tarde demais que o mês não fechou; a projeção
    // otimista continua disponível no resultado, só não é a que move o saldo.
    entradasProjetadas = projecaoFaturamento.projecao.map((p) => ({ mes: p.mes, valor: p.conservador }));
  }

  const caixa = fin.projetarCaixa({
    saldoInicial,
    mesReferencia: mesRef,
    meses,
    lancamentos: lancamentos.map((l) => ({ tipo: l.tipo, descricao: l.descricao, valor: l.valor, mes: l.mes, recorrencia: l.recorrencia, ateMes: l.ateMes })),
    entradasProjetadas,
  });

  const alertas = [];
  if (caixa.primeiroMesNegativo) {
    alertas.push(`O caixa fica negativo em ${fin.rotuloMes(caixa.primeiroMesNegativo)}, mesmo contando com as vendas projetadas.`);
  }
  if (caixa.mesesDeFolgaSemVendasNovas < 3) {
    alertas.push(`Só com o que já está contratado, o caixa cobre ${caixa.mesesDeFolgaSemVendasNovas} ${caixa.mesesDeFolgaSemVendasNovas === 1 ? 'mês' : 'meses'}.`);
  }
  if (!lancamentos.length) {
    alertas.push('Nenhum custo fixo está cadastrado, então as saídas estão zeradas — a projeção está otimista por omissão, não por análise. Cadastre os custos recorrentes da EJ para ela valer alguma coisa.');
  }

  return {
    ...caixa,
    entradasProjetadasUsaramCenario: incluirProjecaoDeVendas ? 'conservador' : null,
    projecaoFaturamento: projecaoFaturamento ? { metodo: projecaoFaturamento.metodo, confianca: projecaoFaturamento.confianca, projecao: projecaoFaturamento.projecao } : null,
    lancamentosConsiderados: lancamentos.length,
    alertas,
  };
}

async function definirSaldoDeCaixa({ saldo }) {
  if (!Number.isFinite(Number(saldo))) throw new Error('saldo precisa ser um número');
  await gravarConfig('saldo_caixa', Number(saldo));
  return { saldoCaixa: Number(saldo) };
}

// ---------- Declarações ----------

const FERRAMENTAS = [
  {
    nome: 'projetar_faturamento',
    escrita: false,
    executar: projetarFaturamento,
    declaracao: {
      type: 'function',
      function: {
        name: 'projetar_faturamento',
        description:
          'Projeta o faturamento dos próximos meses a partir de tudo que já foi vendido (histórico de preços praticados + projetos aprovados por GG). Devolve três cenários por mês (conservador/base/otimista), o método usado e o grau de confiança. Sempre diga à pessoa qual método foi usado — média de poucos meses não é a mesma coisa que tendência.',
        parameters: {
          type: 'object',
          properties: {
            meses: { type: 'number', description: 'Horizonte em meses (1 a 36, padrão 6).' },
            crescimentoMensalPct: { type: 'number', description: 'Opcional: força uma premissa de crescimento mensal em %, ignorando a tendência histórica.' },
          },
        },
      },
    },
  },
  {
    nome: 'projetar_caixa',
    escrita: false,
    executar: projetarCaixa,
    declaracao: {
      type: 'function',
      function: {
        name: 'projetar_caixa',
        description:
          'Monta o fluxo de caixa projetado mês a mês: saldo inicial, entradas já contratadas, entradas ainda projetadas, saídas, e saldo ao fim de cada mês. Separa o que é certo do que é estimado, e diz por quantos meses o caixa aguenta se nenhuma venda nova entrar.',
        parameters: {
          type: 'object',
          properties: {
            meses: { type: 'number', description: 'Horizonte em meses (padrão 6).' },
            saldoAtual: { type: 'number', description: 'Saldo em caixa hoje. Se omitido, usa o último saldo informado.' },
            incluirProjecaoDeVendas: { type: 'boolean', description: 'Se deve somar vendas ainda não fechadas (padrão true, no cenário conservador).' },
            crescimentoMensalPct: { type: 'number', description: 'Premissa de crescimento mensal em %, se quiser forçar uma.' },
          },
        },
      },
    },
  },
  {
    nome: 'listar_lancamentos_financeiros',
    escrita: false,
    executar: listarLancamentos,
    declaracao: {
      type: 'function',
      function: {
        name: 'listar_lancamentos_financeiros',
        description: 'Lista as entradas e saídas cadastradas que alimentam a projeção de caixa (custos fixos, recebimentos já contratados, despesas pontuais).',
        parameters: { type: 'object', properties: {} },
      },
    },
  },
  {
    nome: 'registrar_lancamento_financeiro',
    escrita: true,
    executar: registrarLancamento,
    declaracao: {
      type: 'function',
      function: {
        name: 'registrar_lancamento_financeiro',
        description: 'GRAVA uma entrada ou saída no planejamento financeiro (custo fixo mensal, recebimento contratado, despesa pontual). Só chame depois que a pessoa confirmar os valores.',
        parameters: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: ['entrada', 'saida'] },
            descricao: { type: 'string', description: 'O que é esse lançamento, em poucas palavras.' },
            valor: { type: 'number', description: 'Valor em reais (sempre positivo; o tipo define o sinal).' },
            mes: { type: 'string', description: "Mês no formato 'AAAA-MM'. Para recorrentes, o mês em que começa." },
            recorrencia: { type: 'string', enum: ['unica', 'mensal'], description: "'mensal' repete todo mês a partir de `mes`." },
            ateMes: { type: 'string', description: "Para recorrentes: último mês ('AAAA-MM'). Omitir deixa em aberto." },
          },
          required: ['tipo', 'valor', 'mes'],
        },
      },
    },
  },
  {
    nome: 'remover_lancamento_financeiro',
    escrita: true,
    executar: removerLancamento,
    declaracao: {
      type: 'function',
      function: {
        name: 'remover_lancamento_financeiro',
        description: 'APAGA um lançamento financeiro pelo id. Só chame depois de confirmar com a pessoa qual lançamento é.',
        parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
      },
    },
  },
  {
    nome: 'definir_saldo_de_caixa',
    escrita: true,
    executar: definirSaldoDeCaixa,
    declaracao: {
      type: 'function',
      function: {
        name: 'definir_saldo_de_caixa',
        description: 'GRAVA quanto a EJ tem em caixa hoje — o ponto de partida de toda projeção de caixa.',
        parameters: { type: 'object', properties: { saldo: { type: 'number' } }, required: ['saldo'] },
      },
    },
  },
  {
    nome: 'calcular_ponto_de_equilibrio',
    escrita: false,
    executar: async (args) => fin.pontoDeEquilibrio(args),
    declaracao: {
      type: 'function',
      function: {
        name: 'calcular_ponto_de_equilibrio',
        description: 'Calcula quanto a EJ precisa faturar por mês para cobrir o custo fixo, dada a margem de contribuição média.',
        parameters: {
          type: 'object',
          properties: {
            custoFixoMensal: { type: 'number' },
            margemContribuicaoPct: { type: 'number', description: 'Margem de contribuição média em % (ex.: 65).' },
          },
          required: ['custoFixoMensal', 'margemContribuicaoPct'],
        },
      },
    },
  },
  {
    nome: 'simular_parcelamento',
    escrita: false,
    executar: async (args) => ({
      parcelas: fin.cronogramaParcelas(args),
      total: Number(args.valorTotal),
    }),
    declaracao: {
      type: 'function',
      function: {
        name: 'simular_parcelamento',
        description: 'Divide um valor de contrato em parcelas com datas de vencimento — o mesmo cálculo usado nas cláusulas de pagamento do contrato e na projeção de caixa.',
        parameters: {
          type: 'object',
          properties: {
            valorTotal: { type: 'number' },
            numParcelas: { type: 'number' },
            diaVencimento: { type: 'number', description: 'Dia do mês do vencimento (padrão 15).' },
            mesPrimeiraParcela: { type: 'string', description: "Mês da primeira parcela, 'AAAA-MM'." },
          },
          required: ['valorTotal', 'numParcelas'],
        },
      },
    },
  },
];

module.exports = { FERRAMENTAS, projetarFaturamento, projetarCaixa, listarLancamentos, registrarLancamento, removerLancamento, lerConfig, eventosDeReceita };
