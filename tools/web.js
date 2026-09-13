// tools/web.js — busca na web e leitura de páginas.
//
// Duas rotas para a busca, na ordem: se houver chave do Google Programmable Search configurada,
// usa o Google de verdade (resultados melhores, 100 consultas/dia grátis); se não houver, cai no
// DuckDuckGo HTML, que não pede chave nenhuma. A ordem importa porque o servidor precisa
// funcionar assim que subir, sem depender de ninguém ter ido criar credencial no Google Cloud —
// mas quem configurar a chave ganha resultado melhor sem trocar uma linha de código.
//
// `abrir_pagina` existe porque snippet de busca quase nunca responde a pergunta: ele diz que a
// resposta está ali, não qual é. Sem a leitura da página, a Quara ficaria repetindo trechos de
// 150 caracteres e chutando o resto.

const dns = require('dns').promises;
const net = require('net');

const TIMEOUT_MS = 15000;
const MAX_TEXTO_PAGINA = 12000; // caracteres — o suficiente para o modelo raciocinar sem estourar contexto

// ---------- Proteção contra SSRF ----------
// Este servidor roda dentro da rede do Render, com credencial de Postgres no ambiente. Uma
// ferramenta que busca qualquer URL que o modelo pedir é, sem esta checagem, um jeito de alguém
// mandar a Quara ler o metadata service da infra ou bater no banco interno. Resolver o host e
// recusar faixas privadas fecha isso. É paranoia barata e justificada.
function ehIpPrivado(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local: onde vivem os metadata services de nuvem
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const baixo = ip.toLowerCase();
  if (baixo === '::1' || baixo === '::') return true;
  if (baixo.startsWith('fc') || baixo.startsWith('fd')) return true; // unique local
  if (baixo.startsWith('fe80')) return true; // link-local
  if (baixo.startsWith('::ffff:')) return ehIpPrivado(baixo.slice(7));
  return false;
}

async function validarUrlPublica(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error('URL inválida.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Só consigo abrir endereços http:// ou https://.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('Endereço interno — não posso abrir.');
  }
  if (net.isIP(host)) {
    if (ehIpPrivado(host)) throw new Error('Endereço interno — não posso abrir.');
    return url;
  }
  const enderecos = await dns.lookup(host, { all: true });
  if (enderecos.some((e) => ehIpPrivado(e.address))) {
    throw new Error('Endereço interno — não posso abrir.');
  }
  return url;
}

// ---------- HTML para texto ----------
// Sem dependência de parser: remove o que nunca é conteúdo (script, style, nav, rodapé), troca
// tags de bloco por quebra de linha e desescapa as entidades mais comuns. Não é perfeito, e não
// precisa ser — o destino é um modelo de linguagem lendo prosa, não um DOM.
function htmlParaTexto(html) {
  let t = html;
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<(script|style|noscript|svg|iframe|form)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  const entidades = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&hellip;': '…', '&mdash;': '—', '&ndash;': '–' };
  t = t.replace(/&[a-z]+;|&#\d+;/gi, (m) => {
    if (entidades[m.toLowerCase()]) return entidades[m.toLowerCase()];
    const num = /^&#(\d+);$/.exec(m);
    return num ? String.fromCharCode(Number(num[1])) : ' ';
  });
  return t
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function tituloDoHtml(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? htmlParaTexto(m[1]).slice(0, 200) : null;
}

// ---------- Busca ----------

async function buscarGoogleOficial(consulta, quantidade) {
  const chave = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  if (!chave || !cx) return null;
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', chave);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', consulta);
  url.searchParams.set('num', String(Math.min(10, quantidade)));
  url.searchParams.set('hl', 'pt-BR');
  url.searchParams.set('gl', 'br');
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) {
    const corpo = await r.text().catch(() => '');
    if (r.status === 429) throw new Error('A cota diária gratuita da API de busca do Google (100 consultas/dia) acabou. Ela renova amanhã.');
    throw new Error(`Busca do Google respondeu ${r.status}. ${corpo.slice(0, 200)}`);
  }
  const dados = await r.json();
  return {
    fonte: 'Google Programmable Search',
    resultados: (dados.items || []).map((i) => ({ titulo: i.title, url: i.link, resumo: i.snippet, site: i.displayLink })),
  };
}

async function buscarDuckDuckGo(consulta, quantidade) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(consulta) + '&kl=br-pt';
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuaraBot/1.0; +https://paulistajr.com.br)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Busca respondeu ${r.status}.`);
  const html = await r.text();
  const resultados = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && resultados.length < quantidade) {
    let link = m[1];
    // O DuckDuckGo HTML embrulha o link real em um redirecionador (/l/?uddg=...); desembrulha.
    const embrulhado = /[?&]uddg=([^&]+)/.exec(link);
    if (embrulhado) link = decodeURIComponent(embrulhado[1]);
    if (link.startsWith('//')) link = 'https:' + link;
    const titulo = htmlParaTexto(m[2]);
    if (!titulo || !/^https?:/.test(link)) continue;
    resultados.push({ titulo, url: link, resumo: '', site: (() => { try { return new URL(link).hostname; } catch { return ''; } })() });
  }
  // Os resumos vêm em blocos separados; casa por posição, que é como o HTML do DDG se organiza.
  const reResumo = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let i = 0;
  let ms;
  while ((ms = reResumo.exec(html)) && i < resultados.length) {
    resultados[i].resumo = htmlParaTexto(ms[1]).slice(0, 400);
    i++;
  }
  return { fonte: 'DuckDuckGo (sem chave configurada — configure GOOGLE_API_KEY e GOOGLE_CSE_ID para usar o Google)', resultados };
}

async function buscarNaWeb({ consulta, quantidade = 6 }) {
  if (!consulta || typeof consulta !== 'string') throw new Error('Preciso de um termo de busca.');
  const n = Math.max(1, Math.min(10, Number(quantidade) || 6));
  try {
    const oficial = await buscarGoogleOficial(consulta, n);
    if (oficial) {
      if (!oficial.resultados.length) return { ...oficial, aviso: 'A busca não retornou nenhum resultado.' };
      return oficial;
    }
  } catch (e) {
    // Falhou o Google (cota, chave inválida, instabilidade): tenta o caminho sem chave em vez de
    // devolver erro. Quem pediu a informação não deveria ficar sem resposta por causa de cota.
    const alternativa = await buscarDuckDuckGo(consulta, n).catch(() => null);
    if (alternativa && alternativa.resultados.length) {
      return { ...alternativa, aviso: `O Google falhou (${e.message}) — estes resultados vieram do buscador alternativo.` };
    }
    throw e;
  }
  return buscarDuckDuckGo(consulta, n);
}

async function abrirPagina({ url, maxCaracteres }) {
  const alvo = await validarUrlPublica(url);
  const r = await fetch(alvo, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuaraBot/1.0; +https://paulistajr.com.br)', Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`A página respondeu ${r.status}.`);
  const tipo = r.headers.get('content-type') || '';
  if (!/text\/html|text\/plain|application\/xhtml/.test(tipo)) {
    throw new Error(`Essa URL não é uma página de texto (content-type: ${tipo.split(';')[0]}). Só consigo ler HTML e texto.`);
  }
  const html = await r.text();
  const limite = Math.max(500, Math.min(MAX_TEXTO_PAGINA, Number(maxCaracteres) || MAX_TEXTO_PAGINA));
  const texto = htmlParaTexto(html);
  return {
    url: alvo.toString(),
    titulo: tituloDoHtml(html),
    texto: texto.slice(0, limite),
    truncado: texto.length > limite,
    tamanhoTotal: texto.length,
  };
}

const FERRAMENTAS = [
  {
    nome: 'buscar_na_web',
    escrita: false,
    executar: buscarNaWeb,
    declaracao: {
      type: 'function',
      function: {
        name: 'buscar_na_web',
        description:
          'Pesquisa no Google (ou em buscador alternativo, se o Google não estiver configurado) e devolve títulos, links e resumos. Use para qualquer coisa que dependa de informação atual ou externa: dados de mercado, concorrentes, índices econômicos, notícias, informação sobre um cliente. Os resumos são curtos — se precisar do conteúdo de verdade, chame abrir_pagina no link mais promissor depois.',
        parameters: {
          type: 'object',
          properties: {
            consulta: { type: 'string', description: 'O que buscar, como você digitaria no Google.' },
            quantidade: { type: 'number', description: 'Quantos resultados trazer (1 a 10, padrão 6).' },
          },
          required: ['consulta'],
        },
      },
    },
  },
  {
    nome: 'abrir_pagina',
    escrita: false,
    executar: abrirPagina,
    declaracao: {
      type: 'function',
      function: {
        name: 'abrir_pagina',
        description: 'Abre uma página da web e devolve o texto dela, para ler de fato o conteúdo de um resultado de busca. Use logo depois de buscar_na_web quando o resumo não bastar.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Endereço completo da página (https://...).' },
            maxCaracteres: { type: 'number', description: 'Limite de texto a devolver (padrão 12000).' },
          },
          required: ['url'],
        },
      },
    },
  },
];

module.exports = { FERRAMENTAS, buscarNaWeb, abrirPagina, htmlParaTexto, validarUrlPublica, ehIpPrivado };
