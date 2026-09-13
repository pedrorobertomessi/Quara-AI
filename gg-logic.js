// gg-logic.js — lógica pura de cálculo e comparação de projetos de GG, sem nenhuma dependência de
// Express (req/res) ou de rota HTTP. Extraída para um módulo próprio para que tanto as rotas REST
// (server.js) quanto as ferramentas do chat (chat.js) chamem exatamente a mesma implementação —
// uma única fonte de verdade testada, em vez de duas cópias que podem divergir com o tempo.

const GG_TAXA_ALVO = 0.65; // mesma margem-alvo usada no cálculo de preço sugerido de vendas

function ggCalcularCusto(equipe, taxasHora) {
  // taxasHora: {ger, mem, esp} — os valores-hora configurados (mesmos de cfg.hger/hmem/hesp no
  // front-end). Vem de quem chama porque só o front-end tem a configuração atual de "cfg"; este
  // módulo não duplica essa configuração para não haver duas fontes de verdade sobre valor-hora.
  return equipe.reduce((total, linha) => {
    const taxa = taxasHora[linha.tipo] ?? taxasHora.mem ?? 0;
    return total + linha.hSem * taxa * linha.qtd * linha.semanas;
  }, 0);
}

// Duas composições são "parecidas" quando o total de pessoas e o total de semanas-pessoa (soma de
// qtd*semanas de cada linha, uma medida simples de "tamanho" do projeto) estão dentro de uma folga
// de 40% um do outro. Esse número é um ponto de partida razoável, não uma verdade absoluta — vale
// recalibrar com uso real.
function ggResumoEquipe(equipe) {
  const pessoas = equipe.reduce((a, l) => a + l.qtd, 0);
  const semanasPessoa = equipe.reduce((a, l) => a + l.qtd * l.semanas, 0);
  return { pessoas, semanasPessoa };
}
function ggSaoParecidos(a, b) {
  const dentro = (x, y) => (y === 0 ? x === 0 : Math.abs(x - y) / y <= 0.4);
  return dentro(a.pessoas, b.pessoas) && dentro(a.semanasPessoa, b.semanasPessoa);
}

function rowToGgProjeto(r) {
  return {
    id: r.id,
    nomeProjeto: r.nome_projeto,
    equipe: r.equipe,
    custoTotal: Number(r.custo_total),
    precoSugerido: Number(r.preco_sugerido),
    precoAprovado: Number(r.preco_aprovado),
    diffPct: Number(r.diff_pct),
    data: Number(r.data),
  };
}

module.exports = { GG_TAXA_ALVO, ggCalcularCusto, ggResumoEquipe, ggSaoParecidos, rowToGgProjeto };
