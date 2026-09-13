// tools/gg.js — as ferramentas de Gente e Gestão, tiradas de dentro do chat.js e postas num módulo
// próprio junto das demais.
//
// A lógica de cálculo continua exatamente onde estava (gg-logic.js): este arquivo só busca dados e
// chama as mesmas funções que as rotas REST chamam. Mover as declarações para cá não muda uma
// fórmula sequer — muda só onde elas moram, para que chat.js volte a ser sobre a conversa e não um
// depósito de toda ferramenta que a Quara sabe fazer.

const { pool } = require('../db');
const { GG_TAXA_ALVO, ggCalcularCusto, ggResumoEquipe, ggSaoParecidos, rowToGgProjeto } = require('../gg-logic');

// Sem as taxas-hora vindas da tela não existe cálculo possível — e um erro claro aqui é melhor do
// que um custo calculado com valor-hora zero, que sairia como um número plausível e errado.
function exigirTaxas(contexto) {
  const taxas = contexto && contexto.taxasHora;
  if (!taxas || typeof taxas !== 'object') {
    throw new Error('Não recebi os valores-hora configurados no app (gerente/membro/especialista). Abra o app e tente de novo.');
  }
  return taxas;
}

async function listarProjetosGg({ limite = 30 } = {}) {
  const { rows } = await pool.query('SELECT * FROM gg_projetos ORDER BY data DESC LIMIT $1', [Math.max(1, Math.min(200, Number(limite) || 30))]);
  return rows.map((r) => {
    const p = rowToGgProjeto(r);
    return { ...p, data: new Date(p.data).toLocaleDateString('pt-BR') };
  });
}

async function calcularProjetoGg(args, contexto) {
  const taxasHora = exigirTaxas(contexto);
  const custoTotal = ggCalcularCusto(args.equipe, taxasHora);
  const precoSugerido = Math.round(custoTotal / GG_TAXA_ALVO / 100) * 100;
  const resumoAtual = ggResumoEquipe(args.equipe);
  const { rows } = await pool.query('SELECT * FROM gg_projetos ORDER BY data DESC');
  const parecidos = rows.map(rowToGgProjeto).filter((p) => ggSaoParecidos(resumoAtual, ggResumoEquipe(p.equipe)));
  let comparacao = null;
  if (parecidos.length >= 2) {
    const mediaAprovada = Math.round(parecidos.reduce((a, p) => a + p.precoAprovado, 0) / parecidos.length);
    const diffPct = mediaAprovada > 0 ? Math.round(((precoSugerido - mediaAprovada) / mediaAprovada) * 100) : 0;
    comparacao = { amostra: parecidos.length, mediaAprovada, diffPct };
  }
  return {
    custoTotal: Math.round(custoTotal),
    precoSugerido,
    resumoEquipe: resumoAtual,
    comparacao,
    observacao: comparacao
      ? null
      : 'Ainda não há projetos parecidos o bastante no histórico para comparar — o preço sugerido vem só do custo e da margem-alvo.',
  };
}

async function aprovarProjetoGg(args, contexto) {
  const taxasHora = exigirTaxas(contexto);
  const custoTotal = ggCalcularCusto(args.equipe, taxasHora);
  const precoSugerido = Math.round(custoTotal / GG_TAXA_ALVO / 100) * 100;
  const diffPct = precoSugerido > 0 ? Math.round(((args.precoAprovado - precoSugerido) / precoSugerido) * 100) : 0;
  const { rows } = await pool.query(
    `INSERT INTO gg_projetos (nome_projeto, equipe, custo_total, preco_sugerido, preco_aprovado, diff_pct, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [args.nomeProjeto, JSON.stringify(args.equipe), custoTotal, precoSugerido, args.precoAprovado, diffPct, Date.now()]
  );
  return rowToGgProjeto(rows[0]);
}

const ESQUEMA_EQUIPE = {
  type: 'array',
  description: 'Linhas de equipe do projeto.',
  items: {
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: ['ger', 'mem', 'esp'], description: 'ger=gerente, mem=membro, esp=especialista' },
      qtd: { type: 'number', description: 'Quantidade de pessoas nesse tipo' },
      semanas: { type: 'number' },
      hSem: { type: 'number', description: 'Horas trabalhadas por semana' },
    },
    required: ['tipo', 'qtd', 'semanas', 'hSem'],
  },
};

const FERRAMENTAS = [
  {
    nome: 'listar_projetos_gg',
    escrita: false,
    executar: listarProjetosGg,
    declaracao: {
      type: 'function',
      function: {
        name: 'listar_projetos_gg',
        description: 'Lista os projetos já aprovados por Gente e Gestão, com equipe, preço sugerido e preço efetivamente aprovado de cada um.',
        parameters: { type: 'object', properties: { limite: { type: 'number' } } },
      },
    },
  },
  {
    nome: 'calcular_projeto_gg',
    escrita: false,
    executar: calcularProjetoGg,
    precisaContexto: true,
    declaracao: {
      type: 'function',
      function: {
        name: 'calcular_projeto_gg',
        description:
          'Calcula o custo e o preço sugerido de uma composição de equipe hipotética (pessoas por tipo, horas por semana, semanas) e compara com projetos parecidos já aprovados. Não grava nada — é só um cálculo.',
        parameters: { type: 'object', properties: { equipe: ESQUEMA_EQUIPE }, required: ['equipe'] },
      },
    },
  },
  {
    nome: 'aprovar_projeto_gg',
    escrita: true,
    executar: aprovarProjetoGg,
    precisaContexto: true,
    declaracao: {
      type: 'function',
      function: {
        name: 'aprovar_projeto_gg',
        description:
          'Registra a aprovação final de um projeto por Gente e Gestão — GRAVA o valor decidido no histórico. Só deve ser chamada depois que a pessoa confirmar explicitamente o valor e o nome do projeto.',
        parameters: {
          type: 'object',
          properties: {
            nomeProjeto: { type: 'string' },
            equipe: ESQUEMA_EQUIPE,
            precoAprovado: { type: 'number' },
          },
          required: ['nomeProjeto', 'equipe', 'precoAprovado'],
        },
      },
    },
  },
];

module.exports = { FERRAMENTAS, listarProjetosGg, calcularProjetoGg, aprovarProjetoGg };
