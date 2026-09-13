// financeiro-logic.js — toda a matemática de projeção de faturamento e de caixa, pura.
//
// "Pura" aqui é uma regra de arquitetura, não um adjetivo: este arquivo não importa Express, não
// importa o banco, não chama rede e não lê relógio por conta própria (quem chama passa a data de
// referência). É a mesma escolha que já foi feita em gg-logic.js, e pelo mesmo motivo: a rota
// REST, a ferramenta do chat e os testes precisam executar exatamente o mesmo código, senão a
// Quara acaba dando um número no chat e outro na tela.
//
// Uma decisão que atravessa o arquivo inteiro: a projeção NUNCA inventa confiança que os dados não
// sustentam. Cada resultado carrega um campo `metodo` e um campo `confianca` dizendo em que a
// projeção se apoiou — regressão sobre 14 meses é uma coisa, média de 3 meses é outra bem
// diferente, e quem lê precisa conseguir distinguir as duas sem ler o código.

// ---------- Helpers de mês ----------
// Todo o módulo trabalha com "chave de mês" no formato 'AAAA-MM' (string ordenável
// lexicograficamente, que é a propriedade que faz ordenação e agrupamento ficarem triviais).

function chaveMes(data) {
  const d = data instanceof Date ? data : new Date(Number(data));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function mesSomar(chave, n) {
  const [ano, mes] = chave.split('-').map(Number);
  const total = ano * 12 + (mes - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

function mesDiff(a, b) {
  const [aa, am] = a.split('-').map(Number);
  const [ba, bm] = b.split('-').map(Number);
  return aa * 12 + am - (ba * 12 + bm);
}

const NOMES_MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function rotuloMes(chave) {
  const [ano, mes] = chave.split('-').map(Number);
  return `${NOMES_MES[mes - 1]}/${String(ano).slice(2)}`;
}

// ---------- Estatística de apoio ----------

// Regressão linear simples por mínimos quadrados sobre pares (i, y). Devolve também o desvio
// padrão dos resíduos, que é o que dá lastro aos cenários otimista/conservador mais adiante:
// a largura do leque vem da dispersão que os dados REAIS mostraram, não de um ±20% arbitrário.
function regressaoLinear(ys) {
  const n = ys.length;
  if (n < 2) return null;
  const mediaX = (n - 1) / 2;
  const mediaY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mediaX) * (ys[i] - mediaY);
    den += (i - mediaX) ** 2;
  }
  const b = den === 0 ? 0 : num / den;
  const a = mediaY - b * mediaX;
  let somaResid2 = 0;
  for (let i = 0; i < n; i++) somaResid2 += (ys[i] - (a + b * i)) ** 2;
  // Divisor n-2 (graus de liberdade de uma reta ajustada), caindo para n quando n=2 — com dois
  // pontos a reta passa exata pelos dois e o desvio é zero de qualquer jeito.
  const sigma = Math.sqrt(somaResid2 / Math.max(1, n - 2));
  return { a, b, sigma, prever: (i) => a + b * i };
}

// Índices sazonais multiplicativos por mês do calendário. Só faz sentido com pelo menos dois
// ciclos anuais completos: com um ano só de dados, "dezembro é forte" é indistinguível de "esse
// dezembro foi forte", e aplicar o índice mesmo assim transformaria um acaso em previsão.
function indicesSazonais(serie) {
  if (serie.length < 24) return null;
  const media = serie.reduce((a, p) => a + p.valor, 0) / serie.length;
  if (media === 0) return null;
  const porMes = new Map();
  for (const p of serie) {
    const m = Number(p.mes.split('-')[1]);
    if (!porMes.has(m)) porMes.set(m, []);
    porMes.get(m).push(p.valor / media);
  }
  const indices = {};
  for (let m = 1; m <= 12; m++) {
    const vs = porMes.get(m);
    indices[m] = vs && vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 1;
  }
  return indices;
}

// ---------- Agregação do histórico ----------

// Recebe eventos soltos ({valor, data}) e devolve a série mensal CONTÍNUA — meses sem nenhuma
// venda entram como zero em vez de sumir. Isso importa mais do que parece: sem preencher o
// buraco, um mês parado viraria invisível e a tendência ficaria otimista demais.
function serieMensal(eventos, { mesInicial, mesFinal } = {}) {
  if (!eventos.length) return [];
  const porMes = new Map();
  for (const e of eventos) {
    const k = chaveMes(e.data);
    porMes.set(k, (porMes.get(k) || 0) + Number(e.valor || 0));
  }
  const chaves = [...porMes.keys()].sort();
  const inicio = mesInicial || chaves[0];
  const fim = mesFinal || chaves[chaves.length - 1];
  const out = [];
  for (let k = inicio; mesDiff(fim, k) >= 0; k = mesSomar(k, 1)) {
    out.push({ mes: k, valor: porMes.get(k) || 0 });
  }
  return out;
}

// ---------- Projeção de faturamento ----------

/**
 * Projeta o faturamento dos próximos meses a partir do histórico de vendas.
 *
 * @param {Array<{valor:number,data:number|Date}>} eventos  vendas realizadas
 * @param {object} opcoes
 *   - meses: horizonte (padrão 6)
 *   - mesReferencia: 'AAAA-MM' do mês atual (quem chama decide; o módulo não lê o relógio)
 *   - crescimentoMensalPct: se informado, IGNORA a tendência histórica e usa esta taxa — o jeito
 *     de a diretoria dizer "assuma 5% ao mês" sem precisar mexer no código
 * @returns {{serieHistorica, projecao, metodo, confianca, totalProjetado}}
 */
function projetarFaturamento(eventos, opcoes = {}) {
  const meses = Math.max(1, Math.min(36, opcoes.meses || 6));
  const serie = serieMensal(eventos);
  const mesRef = opcoes.mesReferencia || (serie.length ? serie[serie.length - 1].mes : chaveMes(Date.now()));

  if (!serie.length) {
    return {
      serieHistorica: [],
      projecao: [],
      metodo: 'sem-dados',
      confianca: 'nenhuma',
      totalProjetado: 0,
      aviso: 'Não há nenhuma venda registrada no histórico — não dá para projetar faturamento a partir do nada.',
    };
  }

  const valores = serie.map((p) => p.valor);
  const media = valores.reduce((a, b) => a + b, 0) / valores.length;
  const sazonal = indicesSazonais(serie);

  let metodo;
  let confianca;
  let aviso = null;
  let prever;
  let sigma;

  if (typeof opcoes.crescimentoMensalPct === 'number') {
    const taxa = opcoes.crescimentoMensalPct / 100;
    const base = valores[valores.length - 1] || media;
    metodo = `crescimento fixo de ${opcoes.crescimentoMensalPct}% ao mês (informado por você)`;
    confianca = 'premissa';
    prever = (h) => base * Math.pow(1 + taxa, h);
    sigma = media * 0.15;
  } else if (serie.length >= 6) {
    const reg = regressaoLinear(valores);
    metodo = `regressão linear sobre ${serie.length} meses de histórico`;
    confianca = serie.length >= 12 ? 'boa' : 'média';
    prever = (h) => reg.prever(valores.length - 1 + h);
    sigma = reg.sigma;
  } else {
    metodo = `média dos ${serie.length} meses disponíveis (histórico curto demais para tendência)`;
    confianca = 'baixa';
    aviso = `Com só ${serie.length} ${serie.length === 1 ? 'mês' : 'meses'} de histórico, isto é uma média, não uma tendência. Trate como ordem de grandeza.`;
    prever = () => media;
    const desvios = valores.map((v) => (v - media) ** 2);
    sigma = Math.sqrt(desvios.reduce((a, b) => a + b, 0) / valores.length);
  }

  const projecao = [];
  for (let h = 1; h <= meses; h++) {
    const mes = mesSomar(mesRef, h);
    let base = Math.max(0, prever(h));
    if (sazonal) base *= sazonal[Number(mes.split('-')[1])];
    projecao.push({
      mes,
      rotulo: rotuloMes(mes),
      conservador: Math.max(0, Math.round(base - sigma)),
      base: Math.round(base),
      otimista: Math.round(base + sigma),
    });
  }

  return {
    serieHistorica: serie.map((p) => ({ ...p, rotulo: rotuloMes(p.mes) })),
    projecao,
    metodo: sazonal ? `${metodo}, com ajuste sazonal por mês do calendário` : metodo,
    confianca,
    aviso,
    mediaMensalHistorica: Math.round(media),
    totalProjetado: projecao.reduce((a, p) => a + p.base, 0),
    totalProjetadoConservador: projecao.reduce((a, p) => a + p.conservador, 0),
  };
}

// ---------- Parcelamento ----------

/**
 * Transforma um valor de contrato em um cronograma de recebíveis — a ponte entre "fechei um
 * projeto de R$ 6.500 em 5x" e "quanto entra no caixa em cada mês".
 *
 * O resto da divisão vai TODO para a última parcela em vez de ser diluído em centavos por todas:
 * é como boleto e contrato de verdade funcionam, e evita a soma das parcelas não bater com o total.
 */
function cronogramaParcelas({ valorTotal, numParcelas = 1, diaVencimento = 15, mesPrimeiraParcela }) {
  const n = Math.max(1, Math.floor(numParcelas));
  const total = Math.round(Number(valorTotal) * 100); // trabalha em centavos, evita erro de ponto flutuante
  const base = Math.floor(total / n);
  const parcelas = [];
  const mesInicial = mesPrimeiraParcela || chaveMes(Date.now());
  for (let i = 0; i < n; i++) {
    const centavos = i === n - 1 ? total - base * (n - 1) : base;
    const mes = mesSomar(mesInicial, i);
    parcelas.push({
      numero: i + 1,
      mes,
      rotulo: rotuloMes(mes),
      vencimento: `${String(diaVencimento).padStart(2, '0')}/${mes.split('-')[1]}/${mes.split('-')[0]}`,
      valor: centavos / 100,
    });
  }
  return parcelas;
}

// ---------- Projeção de caixa ----------

/**
 * Monta o fluxo de caixa projetado mês a mês.
 *
 * @param {object} p
 *   - saldoInicial: quanto há em caixa hoje
 *   - mesReferencia: 'AAAA-MM' do mês atual
 *   - meses: horizonte
 *   - lancamentos: [{tipo:'entrada'|'saida', descricao, valor, mes, recorrencia:'unica'|'mensal', ateMes?}]
 *     — o que já está contratado/comprometido, portanto certo
 *   - entradasProjetadas: [{mes, valor}] — o que a projeção de faturamento estima, portanto incerto
 *
 * Certo e incerto aparecem em colunas SEPARADAS no resultado, nunca somados em um número único.
 * Um caixa que só fecha porque a projeção se confirma é uma informação diferente de um caixa que
 * fecha com o que já está assinado, e essa diferença é exatamente a que faz a diretoria decidir.
 */
function projetarCaixa({ saldoInicial = 0, mesReferencia, meses = 6, lancamentos = [], entradasProjetadas = [] }) {
  const horizonte = Math.max(1, Math.min(36, meses));
  const mesRef = mesReferencia || chaveMes(Date.now());
  const projetadasPorMes = new Map(entradasProjetadas.map((e) => [e.mes, Number(e.valor) || 0]));

  let saldo = Number(saldoInicial) || 0;
  const fluxo = [];
  let primeiroMesNegativo = null;

  for (let h = 1; h <= horizonte; h++) {
    const mes = mesSomar(mesRef, h);
    let entradasFirmes = 0;
    let saidas = 0;
    const detalhes = [];

    for (const l of lancamentos) {
      const valor = Number(l.valor) || 0;
      let incide = false;
      if (l.recorrencia === 'mensal') {
        // Recorrente vale do mês de início até `ateMes` (ou até o fim do horizonte, se aberto).
        const comecou = mesDiff(mes, l.mes) >= 0;
        const naoAcabou = !l.ateMes || mesDiff(l.ateMes, mes) >= 0;
        incide = comecou && naoAcabou;
      } else {
        incide = l.mes === mes;
      }
      if (!incide) continue;
      if (l.tipo === 'entrada') entradasFirmes += valor;
      else saidas += valor;
      detalhes.push({ tipo: l.tipo, descricao: l.descricao, valor });
    }

    const entradasProjetadasMes = projetadasPorMes.get(mes) || 0;
    const resultadoFirme = entradasFirmes - saidas;
    const resultadoComProjecao = resultadoFirme + entradasProjetadasMes;
    const saldoAnterior = saldo;
    saldo += resultadoComProjecao;

    if (saldo < 0 && primeiroMesNegativo === null) primeiroMesNegativo = mes;

    fluxo.push({
      mes,
      rotulo: rotuloMes(mes),
      saldoInicial: Math.round(saldoAnterior),
      entradasFirmes: Math.round(entradasFirmes),
      entradasProjetadas: Math.round(entradasProjetadasMes),
      saidas: Math.round(saidas),
      resultadoFirme: Math.round(resultadoFirme),
      resultado: Math.round(resultadoComProjecao),
      saldoFinal: Math.round(saldo),
      detalhes,
    });
  }

  // "Runway só com o que é certo": ignora as entradas projetadas e vê quanto tempo o caixa aguenta
  // apoiado apenas no que já está assinado. É o número que responde "e se nenhuma venda nova
  // entrar?" — a pergunta que de fato importa numa EJ, onde a receita é intermitente.
  let saldoFirme = Number(saldoInicial) || 0;
  let mesesDeFolga = 0;
  for (const f of fluxo) {
    saldoFirme += f.resultadoFirme;
    if (saldoFirme < 0) break;
    mesesDeFolga++;
  }

  return {
    saldoInicial: Math.round(Number(saldoInicial) || 0),
    fluxo,
    saldoFinal: Math.round(saldo),
    primeiroMesNegativo,
    mesesDeFolgaSemVendasNovas: mesesDeFolga,
    totalEntradasFirmes: fluxo.reduce((a, f) => a + f.entradasFirmes, 0),
    totalEntradasProjetadas: fluxo.reduce((a, f) => a + f.entradasProjetadas, 0),
    totalSaidas: fluxo.reduce((a, f) => a + f.saidas, 0),
  };
}

/**
 * Ponto de equilíbrio: quanto precisa faturar por mês para o resultado não ser negativo, dada uma
 * estrutura de custo fixo e a margem de contribuição média dos projetos.
 */
function pontoDeEquilibrio({ custoFixoMensal, margemContribuicaoPct }) {
  const margem = Number(margemContribuicaoPct) / 100;
  if (!(margem > 0)) {
    return { erro: 'A margem de contribuição precisa ser maior que zero para existir ponto de equilíbrio.' };
  }
  const faturamentoNecessario = Number(custoFixoMensal) / margem;
  return {
    custoFixoMensal: Math.round(Number(custoFixoMensal)),
    margemContribuicaoPct: Number(margemContribuicaoPct),
    faturamentoNecessarioMensal: Math.round(faturamentoNecessario),
    faturamentoNecessarioAnual: Math.round(faturamentoNecessario * 12),
  };
}

module.exports = {
  chaveMes,
  mesSomar,
  mesDiff,
  rotuloMes,
  serieMensal,
  regressaoLinear,
  indicesSazonais,
  projetarFaturamento,
  cronogramaParcelas,
  projetarCaixa,
  pontoDeEquilibrio,
};
