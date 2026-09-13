// tools/datajud.js — consulta de processos judiciais públicos na API Pública do DataJud (CNJ).
//
// O DataJud é a base nacional de metadados processuais do Judiciário. A API pública dá acesso à
// "capa" do processo (classe, assunto, órgão julgador, data de ajuizamento) e à lista de
// movimentações — NÃO ao inteiro teor, e não a processos sigilosos. Isso é um limite da base, não
// uma restrição deste código, e a Quara precisa deixar isso claro em vez de dar a entender que
// leu a petição.
//
// A API é um Elasticsearch exposto: aceita POST em /api_publica_<tribunal>/_search com uma query
// no formato do ES. A autenticação é uma chave PÚBLICA que o próprio CNJ publica na wiki. Ela vem
// aqui como padrão (para o servidor funcionar sem configuração), mas é sobrescrevível por
// DATAJUD_API_KEY — o CNJ avisa que pode trocar a chave a qualquer momento, e quando isso
// acontecer ninguém vai querer depender de um deploy para voltar a funcionar.

const BASE = 'https://api-publica.datajud.cnj.jus.br';
const CHAVE_PUBLICA_PADRAO = 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';
const TIMEOUT_MS = 20000;

// ---------- Resolução do tribunal a partir do número CNJ ----------
// O número único tem a forma NNNNNNN-DD.AAAA.J.TR.OOOO (Resolução CNJ 65/2008): J é o segmento do
// Judiciário e TR identifica o tribunal dentro daquele segmento. Com esses dois campos dá para
// descobrir sozinho em qual endpoint procurar, em vez de obrigar a pessoa a saber que "8.26" é o
// TJSP.

// Códigos TR da Justiça Estadual. A ordem é alfabética pelo NOME do estado até Santa Catarina, e
// aí inverte: 25 é Sergipe e 26 é São Paulo (o TJSP é o caso mais conhecido — todo processo
// paulista termina em 8.26). Por isso a tabela é escrita à mão e não gerada de uma lista ordenada:
// gerar daria o resultado errado exatamente nos dois tribunais mais movimentados do país.
const ESTADUAL = {
  '01': 'tjac', '02': 'tjal', '03': 'tjap', '04': 'tjam', '05': 'tjba', '06': 'tjce',
  '07': 'tjdft', '08': 'tjes', '09': 'tjgo', 10: 'tjma', 11: 'tjmt', 12: 'tjms',
  13: 'tjmg', 14: 'tjpa', 15: 'tjpb', 16: 'tjpr', 17: 'tjpe', 18: 'tjpi',
  19: 'tjrj', 20: 'tjrn', 21: 'tjrs', 22: 'tjro', 23: 'tjrr', 24: 'tjsc',
  25: 'tjse', 26: 'tjsp', 27: 'tjto',
};

const ELEITORAL = {
  '01': 'tre-ac', '02': 'tre-al', '03': 'tre-ap', '04': 'tre-am', '05': 'tre-ba', '06': 'tre-ce',
  '07': 'tre-df', '08': 'tre-es', '09': 'tre-go', 10: 'tre-ma', 11: 'tre-mt', 12: 'tre-ms',
  13: 'tre-mg', 14: 'tre-pa', 15: 'tre-pb', 16: 'tre-pr', 17: 'tre-pe', 18: 'tre-pi',
  19: 'tre-rj', 20: 'tre-rn', 21: 'tre-rs', 22: 'tre-ro', 23: 'tre-rr', 24: 'tre-sc',
  25: 'tre-se', 26: 'tre-sp', 27: 'tre-to',
};

const MILITAR_ESTADUAL = { 13: 'tjmmg', 21: 'tjmrs', 26: 'tjmsp' };

function soDigitos(s) {
  return String(s || '').replace(/\D/g, '');
}

function resolverTribunal(numeroProcesso) {
  const n = soDigitos(numeroProcesso);
  if (n.length !== 20) {
    throw new Error(`Número de processo inválido: esperava 20 dígitos no padrão CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO), recebi ${n.length}.`);
  }
  const segmento = n.slice(13, 14);
  const tr = n.slice(14, 16);
  const trNum = Number(tr);

  switch (segmento) {
    case '3':
      return { alias: 'stj', nome: 'Superior Tribunal de Justiça' };
    case '4':
      if (trNum >= 1 && trNum <= 6) return { alias: `trf${trNum}`, nome: `Tribunal Regional Federal da ${trNum}ª Região` };
      break;
    case '5':
      if (trNum === 0) return { alias: 'tst', nome: 'Tribunal Superior do Trabalho' };
      if (trNum >= 1 && trNum <= 24) return { alias: `trt${trNum}`, nome: `Tribunal Regional do Trabalho da ${trNum}ª Região` };
      break;
    case '6':
      if (trNum === 0) return { alias: 'tse', nome: 'Tribunal Superior Eleitoral' };
      if (ELEITORAL[tr]) return { alias: ELEITORAL[tr], nome: `TRE — ${ELEITORAL[tr].slice(4).toUpperCase()}` };
      break;
    case '7':
      return { alias: 'stm', nome: 'Superior Tribunal Militar' };
    case '8':
      if (ESTADUAL[tr]) return { alias: ESTADUAL[tr], nome: ESTADUAL[tr].toUpperCase() };
      break;
    case '9':
      if (MILITAR_ESTADUAL[tr]) return { alias: MILITAR_ESTADUAL[tr], nome: MILITAR_ESTADUAL[tr].toUpperCase() };
      break;
    default:
      break;
  }
  throw new Error(
    `Não consegui identificar o tribunal a partir do número (segmento ${segmento}, tribunal ${tr}). O STF e o CNJ não fazem parte da base pública do DataJud. Se souber o tribunal, informe-o explicitamente.`
  );
}

// ---------- Chamada à API ----------

async function consultarEndpoint(alias, corpo) {
  const chave = process.env.DATAJUD_API_KEY || CHAVE_PUBLICA_PADRAO;
  const r = await fetch(`${BASE}/api_publica_${alias}/_search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `APIKey ${chave}` },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error(
      'O DataJud recusou a chave de acesso. O CNJ troca a chave pública periodicamente — pegue a atual em datajud-wiki.cnj.jus.br/api-publica/acesso e configure em DATAJUD_API_KEY.'
    );
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`O DataJud respondeu ${r.status}. ${t.slice(0, 300)}`);
  }
  return r.json();
}

// A resposta crua do Elasticsearch traz dezenas de campos por processo e centenas de movimentos —
// mandar isso inteiro de volta para o modelo queimaria o contexto sem melhorar a resposta. Aqui só
// sobrevive o que alguém de fato leria numa consulta processual.
function resumirProcesso(hit, { maxMovimentos = 15 } = {}) {
  const s = hit._source || {};
  const movimentos = Array.isArray(s.movimentos) ? s.movimentos : [];
  const ordenados = [...movimentos].sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora));
  return {
    numeroProcesso: s.numeroProcesso,
    tribunal: s.tribunal,
    grau: s.grau,
    classe: s.classe ? `${s.classe.nome} (${s.classe.codigo})` : null,
    assuntos: (s.assuntos || []).map((a) => a.nome).filter(Boolean),
    orgaoJulgador: s.orgaoJulgador ? s.orgaoJulgador.nome : null,
    dataAjuizamento: s.dataAjuizamento ? new Date(s.dataAjuizamento).toLocaleDateString('pt-BR') : null,
    formato: s.formato ? s.formato.nome : null,
    sistema: s.sistema ? s.sistema.nome : null,
    nivelSigilo: s.nivelSigilo,
    totalMovimentos: movimentos.length,
    ultimaMovimentacao: ordenados[0]
      ? { data: new Date(ordenados[0].dataHora).toLocaleDateString('pt-BR'), descricao: ordenados[0].nome }
      : null,
    movimentos: ordenados.slice(0, maxMovimentos).map((m) => ({
      data: new Date(m.dataHora).toLocaleDateString('pt-BR'),
      descricao: m.nome,
    })),
  };
}

const NOTA_PUBLICA =
  'Dados públicos do DataJud/CNJ: só metadados processuais (capa e movimentações). Não inclui o teor das peças, nem nomes das partes, nem processos em segredo de justiça.';

async function consultarProcesso({ numeroProcesso, tribunal, maxMovimentos }) {
  const numero = soDigitos(numeroProcesso);
  const trib = tribunal ? { alias: String(tribunal).toLowerCase().replace(/^api_publica_/, ''), nome: String(tribunal).toUpperCase() } : resolverTribunal(numero);
  const dados = await consultarEndpoint(trib.alias, {
    size: 5,
    query: { match: { numeroProcesso: numero } },
  });
  const hits = (dados.hits && dados.hits.hits) || [];
  if (!hits.length) {
    return {
      encontrado: false,
      tribunalConsultado: trib.alias,
      mensagem: `Nenhum processo com esse número foi encontrado na base pública do ${trib.nome}. Pode estar em segredo de justiça, ser de um tribunal diferente do que o número indica, ou ainda não ter sido enviado pelo tribunal ao DataJud.`,
      nota: NOTA_PUBLICA,
    };
  }
  // O mesmo processo aparece uma vez por grau (G1, G2, JE...). Devolver todos é o certo: a
  // pergunta "em que pé está" quase sempre quer saber se já subiu para o segundo grau.
  return {
    encontrado: true,
    tribunalConsultado: trib.alias,
    instancias: hits.map((h) => resumirProcesso(h, { maxMovimentos })),
    nota: NOTA_PUBLICA,
  };
}

async function buscarProcessos({ tribunal, classeCodigo, orgaoJulgadorCodigo, assuntoCodigo, anoAjuizamento, tamanho = 10 }) {
  if (!tribunal) throw new Error('Preciso saber em qual tribunal buscar (ex.: tjsp, trt15, trf3).');
  const alias = String(tribunal).toLowerCase().replace(/^api_publica_/, '');
  const must = [];
  if (classeCodigo) must.push({ match: { 'classe.codigo': Number(classeCodigo) } });
  if (orgaoJulgadorCodigo) must.push({ match: { 'orgaoJulgador.codigo': Number(orgaoJulgadorCodigo) } });
  if (assuntoCodigo) must.push({ match: { 'assuntos.codigo': Number(assuntoCodigo) } });
  if (anoAjuizamento) {
    must.push({ range: { dataAjuizamento: { gte: `${anoAjuizamento}-01-01`, lte: `${anoAjuizamento}-12-31` } } });
  }
  if (!must.length) throw new Error('Preciso de pelo menos um filtro (classe, órgão julgador, assunto ou ano).');

  const dados = await consultarEndpoint(alias, {
    size: Math.max(1, Math.min(50, Number(tamanho) || 10)),
    query: { bool: { must } },
  });
  const total = dados.hits && dados.hits.total ? dados.hits.total.value : 0;
  const hits = (dados.hits && dados.hits.hits) || [];
  return {
    tribunalConsultado: alias,
    totalEncontrado: total,
    mostrando: hits.length,
    processos: hits.map((h) => resumirProcesso(h, { maxMovimentos: 3 })),
    nota: NOTA_PUBLICA,
  };
}

const FERRAMENTAS = [
  {
    nome: 'consultar_processo_judicial',
    escrita: false,
    executar: consultarProcesso,
    declaracao: {
      type: 'function',
      function: {
        name: 'consultar_processo_judicial',
        description:
          'Consulta um processo judicial público na base do CNJ (DataJud) pelo número único CNJ. O tribunal é descoberto sozinho a partir do número. Devolve a capa (classe, assunto, vara, data de ajuizamento) e as últimas movimentações. Só metadados públicos — não traz teor de peças nem nomes das partes, e não acessa processos em segredo de justiça.',
        parameters: {
          type: 'object',
          properties: {
            numeroProcesso: { type: 'string', description: 'Número único CNJ, com ou sem pontuação (ex.: 0000832-35.2018.4.01.3202).' },
            tribunal: { type: 'string', description: 'Opcional: força o tribunal (ex.: tjsp, trt15, trf3) quando o número não bastar.' },
            maxMovimentos: { type: 'number', description: 'Quantas movimentações trazer (padrão 15).' },
          },
          required: ['numeroProcesso'],
        },
      },
    },
  },
  {
    nome: 'buscar_processos_judiciais',
    escrita: false,
    executar: buscarProcessos,
    declaracao: {
      type: 'function',
      function: {
        name: 'buscar_processos_judiciais',
        description:
          'Busca processos públicos em um tribunal por filtros (classe processual, órgão julgador, assunto, ano). Serve para levantamento quantitativo — por exemplo, quantas execuções fiscais de um assunto tramitam numa vara. Exige o tribunal e pelo menos um filtro.',
        parameters: {
          type: 'object',
          properties: {
            tribunal: { type: 'string', description: 'Sigla do tribunal no DataJud: tjsp, tjmg, trf3, trt15, tre-sp etc.' },
            classeCodigo: { type: 'number', description: 'Código da classe processual na Tabela Processual Unificada do CNJ.' },
            orgaoJulgadorCodigo: { type: 'number', description: 'Código da vara/serventia.' },
            assuntoCodigo: { type: 'number', description: 'Código do assunto na TPU.' },
            anoAjuizamento: { type: 'number', description: 'Ano de ajuizamento a filtrar.' },
            tamanho: { type: 'number', description: 'Quantos processos trazer (1 a 50, padrão 10).' },
          },
          required: ['tribunal'],
        },
      },
    },
  },
];

module.exports = { FERRAMENTAS, consultarProcesso, buscarProcessos, resolverTribunal, ESTADUAL };
