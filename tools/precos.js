// tools/precos.js — as ferramentas que já existiam (histórico e limiares), mais as que faltavam
// para a Quara conseguir falar sobre a tabela de preços em vez de só listar o que foi vendido.
//
// A tabela de serviços (nome, faixa, custos, mão de obra) mora no front-end, não no banco — é
// configuração que cada diretor ajusta na tela. Por isso ela chega como CONTEXTO em cada mensagem
// do chat, e não por consulta ao Postgres. Vale registrar o porquê: duplicar essa tabela no
// servidor criaria duas fontes de verdade que divergem no primeiro ajuste feito na aba Custos.

const { pool } = require('../db');

async function listarHistoricoVendas({ servicoNome, limite = 30 }) {
  let query = 'SELECT * FROM historico';
  const params = [];
  if (servicoNome) {
    query += ' WHERE servico_nome ILIKE $1';
    params.push(`%${servicoNome}%`);
  }
  params.push(Math.max(1, Math.min(200, Number(limite) || 30)));
  query += ` ORDER BY data DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(query, params);
  return rows.map((r) => ({
    id: r.id,
    servico: r.servico_nome,
    preco: Number(r.preco),
    margem: Number(r.margem),
    banda: r.banda_nome,
    data: new Date(Number(r.data)).toLocaleDateString('pt-BR'),
  }));
}

async function listarLimiares() {
  const { rows: valores } = await pool.query('SELECT * FROM limiar_valores');
  const { rows: log } = await pool.query('SELECT * FROM limiar_log ORDER BY data DESC LIMIT 10');
  return {
    valoresAtuais: Object.fromEntries(valores.map((v) => [v.regra, Number(v.valor)])),
    ultimosAjustes: log.map((l) => ({
      regra: l.regra,
      de: Number(l.de),
      para: Number(l.para),
      taxaAplicacao: Number(l.taxa_aplicacao),
      amostra: l.amostra,
      data: new Date(Number(l.data)).toLocaleDateString('pt-BR'),
    })),
    explicacao:
      'Os limiares são o desvio mínimo (em %) que a Quara exige antes de sugerir um ajuste. Eles sobem quando as sugestões são ignoradas e descem quando são aplicadas — ninguém os define à mão.',
  };
}

// Estatística do histórico: o que responde "esse preço está fora da curva?" sem precisar mandar a
// lista inteira de vendas para o modelo raciocinar em cima. Mediana junto da média de propósito —
// com poucas vendas, uma venda atípica desloca a média e a mediana aguenta.
async function estatisticasDeVendas({ servicoNome }) {
  const vendas = await listarHistoricoVendas({ servicoNome, limite: 200 });
  if (!vendas.length) return { amostra: 0, mensagem: 'Nenhuma venda registrada ainda para esse filtro.' };
  const porServico = new Map();
  for (const v of vendas) {
    if (!porServico.has(v.servico)) porServico.set(v.servico, []);
    porServico.get(v.servico).push(v.preco);
  }
  const resumo = [...porServico.entries()].map(([servico, precos]) => {
    const ordenados = [...precos].sort((a, b) => a - b);
    const meio = Math.floor(ordenados.length / 2);
    return {
      servico,
      vendas: precos.length,
      menor: ordenados[0],
      maior: ordenados[ordenados.length - 1],
      media: Math.round(precos.reduce((a, b) => a + b, 0) / precos.length),
      mediana: ordenados.length % 2 ? ordenados[meio] : Math.round((ordenados[meio - 1] + ordenados[meio]) / 2),
    };
  });
  return { amostra: vendas.length, porServico: resumo.sort((a, b) => b.vendas - a.vendas) };
}

async function registrarPrecoPraticado({ servicoId, servicoNome, preco, margem, bandaNome }) {
  if (!Number.isFinite(Number(preco)) || Number(preco) <= 0) throw new Error('preco precisa ser um número maior que zero');
  const { rows } = await pool.query(
    'INSERT INTO historico (servico_id, servico_nome, preco, margem, banda_nome, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [Number(servicoId) || 0, servicoNome || '', Number(preco), Number(margem) || 0, bandaNome || '', Date.now()]
  );
  const r = rows[0];
  return { id: r.id, servico: r.servico_nome, preco: Number(r.preco), data: new Date(Number(r.data)).toLocaleDateString('pt-BR') };
}

// Lê a tabela de preços que veio junto da mensagem. Sem contexto, devolve uma explicação em vez de
// um erro seco: o modelo precisa conseguir dizer à pessoa POR QUE não sabe, não só que não sabe.
async function consultarTabelaDePrecos(args, contexto) {
  const servicos = (contexto && contexto.servicos) || [];
  if (!servicos.length) {
    return {
      disponivel: false,
      mensagem: 'A tabela de preços não veio junto desta conversa. Ela é montada na tela do app (abas Custos e Preços) — abra o app e pergunte de novo, ou me diga os números que você quer analisar.',
    };
  }
  const filtro = args && args.servicoNome ? String(args.servicoNome).toLowerCase() : null;
  const lista = filtro ? servicos.filter((s) => String(s.nome).toLowerCase().includes(filtro)) : servicos;
  return {
    disponivel: true,
    totalServicos: servicos.length,
    servicos: lista,
    configuracao: contexto.cfg || null,
  };
}

const FERRAMENTAS = [
  {
    nome: 'listar_historico_vendas',
    escrita: false,
    executar: listarHistoricoVendas,
    declaracao: {
      type: 'function',
      function: {
        name: 'listar_historico_vendas',
        description: 'Lista os preços praticados registrados no histórico de vendas, opcionalmente filtrados por nome de serviço.',
        parameters: {
          type: 'object',
          properties: {
            servicoNome: { type: 'string', description: 'Filtra pelo nome (ou parte do nome) do serviço.' },
            limite: { type: 'number', description: 'Quantos registros trazer (padrão 30).' },
          },
        },
      },
    },
  },
  {
    nome: 'estatisticas_de_vendas',
    escrita: false,
    executar: estatisticasDeVendas,
    declaracao: {
      type: 'function',
      function: {
        name: 'estatisticas_de_vendas',
        description: 'Resume o histórico de vendas por serviço: quantidade, menor, maior, média e mediana de preço. Use antes de julgar se um preço está fora da curva.',
        parameters: { type: 'object', properties: { servicoNome: { type: 'string' } } },
      },
    },
  },
  {
    nome: 'consultar_tabela_de_precos',
    escrita: false,
    executar: consultarTabelaDePrecos,
    precisaContexto: true,
    declaracao: {
      type: 'function',
      function: {
        name: 'consultar_tabela_de_precos',
        description:
          'Mostra a tabela de serviços atual: nome, faixa de preço mínima e máxima, custo total calculado, preço sugerido e margem de cada serviço. É a base para qualquer conversa sobre precificação.',
        parameters: { type: 'object', properties: { servicoNome: { type: 'string', description: 'Filtra por nome do serviço.' } } },
      },
    },
  },
  {
    nome: 'listar_limiares',
    escrita: false,
    executar: listarLimiares,
    declaracao: {
      type: 'function',
      function: {
        name: 'listar_limiares',
        description: 'Mostra os limiares que a Quara aprendeu sozinha (quanto de desvio ela exige antes de sugerir um ajuste) e o histórico de quando cada um mudou.',
        parameters: { type: 'object', properties: {} },
      },
    },
  },
  {
    nome: 'registrar_preco_praticado',
    escrita: true,
    executar: registrarPrecoPraticado,
    declaracao: {
      type: 'function',
      function: {
        name: 'registrar_preco_praticado',
        description: 'GRAVA um preço efetivamente praticado no histórico de vendas. Só chame depois que a pessoa confirmar serviço e valor.',
        parameters: {
          type: 'object',
          properties: {
            servicoId: { type: 'number' },
            servicoNome: { type: 'string' },
            preco: { type: 'number' },
            margem: { type: 'number', description: 'Margem resultante em %.' },
            bandaNome: { type: 'string', description: 'Banda de preço (Low, Entry, Standard, Premium).' },
          },
          required: ['servicoNome', 'preco'],
        },
      },
    },
  },
];

module.exports = { FERRAMENTAS, listarHistoricoVendas, listarLimiares, estatisticasDeVendas, registrarPrecoPraticado };
