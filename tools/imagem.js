// tools/imagem.js — geração de imagem.
//
// Duas coisas bem diferentes moram aqui, e vale separar bem porque elas falham de jeitos
// diferentes:
//
// 1. IMAGEM DE MARCA (gráfico, capa) — desenhada aqui, em SVG, com as cores do logo, e
//    rasterizada com o sharp. É determinística: o mesmo pedido dá o mesmo resultado, nada sai
//    errado por sorte, e funciona offline. É o que serve para material institucional, porque o
//    gráfico precisa mostrar o número certo, não uma interpretação bonita do número.
//
// 2. IMAGEM GENERATIVA (ilustração a partir de uma descrição) — depende de um serviço externo,
//    porque o Groq não gera imagem (ele é um provedor de modelos de linguagem; a orientação de
//    manter a API do chat no Groq continua valendo intocada). O padrão é o Pollinations, que não
//    exige chave nenhuma — o servidor continua subindo e funcionando sem ninguém configurar nada.
//
// O sharp é carregado sob demanda, e não no topo do arquivo, de propósito: ele traz binário
// nativo, e se a instalação dele falhar em algum ambiente, o certo é o resto do servidor continuar
// de pé e só a geração de imagem avisar que está indisponível.

const { CORES, FONTES, logoDataUrl } = require('../lib/marca');
const artefatos = require('../lib/artefatos');

const TIMEOUT_MS = 60000;

let sharpCache;
function getSharp() {
  if (sharpCache === undefined) {
    try {
      sharpCache = require('sharp');
    } catch (e) {
      sharpCache = null;
    }
  }
  if (!sharpCache) {
    throw new Error('A biblioteca de imagem (sharp) não está disponível neste servidor. Rode `npm install` e reinicie.');
  }
  return sharpCache;
}

const PILHA_FONTE = `'${FONTES.titulo}','${FONTES.tituloFallback}','DejaVu Sans',sans-serif`;

function escaparXml(s) {
  return String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// Quebra de linha por contagem de caracteres. Um layout de texto de verdade exigiria medir a
// fonte, o que só é possível depois de rasterizar — e para título curto em caixa larga a
// aproximação erra pouco e nunca corta palavra no meio.
function quebrarTexto(texto, maxChars) {
  const palavras = String(texto).split(/\s+/);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    if (!atual) atual = p;
    else if ((atual + ' ' + p).length <= maxChars) atual += ' ' + p;
    else {
      linhas.push(atual);
      atual = p;
    }
  }
  if (atual) linhas.push(atual);
  return linhas;
}

function formatarNumero(v) {
  const n = Number(v);
  if (Math.abs(n) >= 1000000) return (n / 1000000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi';
  if (Math.abs(n) >= 1000) return (n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil';
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

// ---------- Gráfico ----------

function svgGrafico({ titulo, subtitulo, tipo = 'barra', categorias = [], series = [], largura = 1280, altura = 720 }) {
  const margem = { topo: 150, direita: 60, baixo: 90, esquerda: 100 };
  const larguraPlot = largura - margem.esquerda - margem.direita;
  const alturaPlot = altura - margem.topo - margem.baixo;

  const todosValores = series.flatMap((s) => s.valores.map(Number));
  const maxBruto = Math.max(0, ...todosValores);
  const minBruto = Math.min(0, ...todosValores);
  // Arredonda o topo da escala para um número "redondo" — eixo terminando em 47.318 é ruído
  // visual; terminando em 50.000 a pessoa lê o gráfico sem precisar decifrar a régua.
  const passo = Math.pow(10, Math.floor(Math.log10(Math.max(1, maxBruto - minBruto)))) / 2;
  const max = Math.ceil(maxBruto / passo) * passo || 1;
  const min = Math.floor(minBruto / passo) * passo;
  const y = (v) => margem.topo + alturaPlot - ((Number(v) - min) / (max - min || 1)) * alturaPlot;

  let corpo = '';

  // Grade e rótulos do eixo Y
  const linhasGrade = 5;
  for (let i = 0; i <= linhasGrade; i++) {
    const valor = min + ((max - min) / linhasGrade) * i;
    const yy = y(valor);
    corpo += `<line x1="${margem.esquerda}" y1="${yy}" x2="${largura - margem.direita}" y2="${yy}" stroke="${CORES.cinzaClaro}" stroke-width="1"/>`;
    corpo += `<text x="${margem.esquerda - 14}" y="${yy + 6}" text-anchor="end" font-family="${PILHA_FONTE}" font-size="19" fill="${CORES.cinza}">${escaparXml(formatarNumero(valor))}</text>`;
  }

  const n = categorias.length || 1;
  const larguraCategoria = larguraPlot / n;

  if (tipo === 'barra') {
    const larguraGrupo = larguraCategoria * 0.62;
    const larguraBarra = larguraGrupo / Math.max(1, series.length);
    series.forEach((s, si) => {
      const cor = s.cor || CORES.serie[si % CORES.serie.length];
      s.valores.forEach((v, i) => {
        const x = margem.esquerda + larguraCategoria * i + (larguraCategoria - larguraGrupo) / 2 + larguraBarra * si;
        const yv = y(v);
        const y0 = y(Math.max(min, 0));
        const alt = Math.abs(y0 - yv);
        corpo += `<rect x="${x.toFixed(1)}" y="${Math.min(yv, y0).toFixed(1)}" width="${(larguraBarra - 6).toFixed(1)}" height="${Math.max(1, alt).toFixed(1)}" fill="${cor}" rx="4"/>`;
        if (series.length <= 2) {
          corpo += `<text x="${(x + (larguraBarra - 6) / 2).toFixed(1)}" y="${(Math.min(yv, y0) - 10).toFixed(1)}" text-anchor="middle" font-family="${PILHA_FONTE}" font-size="18" font-weight="700" fill="${CORES.grafite}">${escaparXml(formatarNumero(v))}</text>`;
        }
      });
    });
  } else {
    series.forEach((s, si) => {
      const cor = s.cor || CORES.serie[si % CORES.serie.length];
      const pontos = s.valores.map((v, i) => `${(margem.esquerda + larguraCategoria * i + larguraCategoria / 2).toFixed(1)},${y(v).toFixed(1)}`);
      corpo += `<polyline points="${pontos.join(' ')}" fill="none" stroke="${cor}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`;
      s.valores.forEach((v, i) => {
        corpo += `<circle cx="${(margem.esquerda + larguraCategoria * i + larguraCategoria / 2).toFixed(1)}" cy="${y(v).toFixed(1)}" r="6" fill="${cor}"/>`;
      });
    });
  }

  // Rótulos do eixo X
  categorias.forEach((c, i) => {
    const x = margem.esquerda + larguraCategoria * i + larguraCategoria / 2;
    corpo += `<text x="${x.toFixed(1)}" y="${altura - margem.baixo + 34}" text-anchor="middle" font-family="${PILHA_FONTE}" font-size="20" fill="${CORES.cinza}">${escaparXml(c)}</text>`;
  });

  // Legenda (só quando há mais de uma série — com uma só, o título já diz o que é)
  let legenda = '';
  if (series.length > 1) {
    let x = margem.esquerda;
    series.forEach((s, si) => {
      const cor = s.cor || CORES.serie[si % CORES.serie.length];
      legenda += `<rect x="${x}" y="${margem.topo - 46}" width="16" height="16" rx="3" fill="${cor}"/>`;
      legenda += `<text x="${x + 24}" y="${margem.topo - 32}" font-family="${PILHA_FONTE}" font-size="19" fill="${CORES.grafite}">${escaparXml(s.nome || 'Série ' + (si + 1))}</text>`;
      x += 40 + String(s.nome || '').length * 10;
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${largura}" height="${altura}" viewBox="0 0 ${largura} ${altura}">
  <rect width="${largura}" height="${altura}" fill="${CORES.branco}"/>
  <rect x="0" y="0" width="${largura}" height="8" fill="${CORES.vermelho}"/>
  <image xlink:href="${logoDataUrl()}" x="${largura - 260}" y="34" width="200" height="67" preserveAspectRatio="xMidYMid meet"/>
  <text x="${margem.esquerda}" y="70" font-family="${PILHA_FONTE}" font-size="34" font-weight="700" fill="${CORES.grafite}">${escaparXml(titulo || '')}</text>
  ${subtitulo ? `<text x="${margem.esquerda}" y="102" font-family="${PILHA_FONTE}" font-size="21" fill="${CORES.cinza}">${escaparXml(subtitulo)}</text>` : ''}
  ${legenda}
  ${corpo}
  <line x1="${margem.esquerda}" y1="${y(Math.max(min, 0))}" x2="${largura - margem.direita}" y2="${y(Math.max(min, 0))}" stroke="${CORES.grafite}" stroke-width="2"/>
</svg>`;
}

// ---------- Capa ----------

function svgCapa({ titulo, subtitulo, rodape, largura = 1600, altura = 900 }) {
  const linhas = quebrarTexto(titulo || '', 28);
  const tamanhoTitulo = linhas.length > 2 ? 74 : 92;
  let textoTitulo = '';
  linhas.forEach((l, i) => {
    textoTitulo += `<text x="110" y="${390 + i * (tamanhoTitulo + 14)}" font-family="${PILHA_FONTE}" font-size="${tamanhoTitulo}" font-weight="700" fill="${CORES.branco}">${escaparXml(l)}</text>`;
  });
  const yDepois = 390 + linhas.length * (tamanhoTitulo + 14);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${largura}" height="${altura}" viewBox="0 0 ${largura} ${altura}">
  <defs>
    <linearGradient id="fundo" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${CORES.preto}"/>
      <stop offset="100%" stop-color="${CORES.grafite}"/>
    </linearGradient>
  </defs>
  <rect width="${largura}" height="${altura}" fill="url(#fundo)"/>
  <!-- losango do logo, ampliado e recortado pela borda: usa a forma da marca como elemento
       gráfico em vez de um enfeite genérico -->
  <g opacity="0.22" transform="translate(${largura - 180},${altura - 200}) rotate(45)">
    <rect x="-260" y="-260" width="520" height="520" fill="none" stroke="${CORES.vermelho}" stroke-width="26"/>
  </g>
  <rect x="0" y="0" width="14" height="${altura}" fill="${CORES.vermelho}"/>
  <image xlink:href="${logoDataUrl('claro')}" x="106" y="90" width="300" height="100" preserveAspectRatio="xMidYMid meet"/>
  <rect x="110" y="300" width="90" height="7" fill="${CORES.vermelho}"/>
  ${textoTitulo}
  ${subtitulo ? `<text x="110" y="${yDepois + 22}" font-family="${PILHA_FONTE}" font-size="34" fill="${CORES.cinzaClaro}">${escaparXml(subtitulo)}</text>` : ''}
  ${rodape ? `<text x="110" y="${altura - 70}" font-family="${PILHA_FONTE}" font-size="24" fill="${CORES.cinza}">${escaparXml(rodape)}</text>` : ''}
</svg>`;
}

async function svgParaPng(svg, largura) {
  const sharp = getSharp();
  return sharp(Buffer.from(svg), { density: 150 }).resize({ width: largura }).png({ compressionLevel: 9 }).toBuffer();
}

// ---------- Ferramentas ----------

async function gerarGrafico(args) {
  const { titulo, subtitulo, tipo, categorias, series, nomeArquivo } = args;
  if (!Array.isArray(categorias) || !categorias.length) throw new Error('Preciso das categorias do eixo X.');
  if (!Array.isArray(series) || !series.length) throw new Error('Preciso de pelo menos uma série de valores.');
  for (const s of series) {
    if (!Array.isArray(s.valores) || s.valores.length !== categorias.length) {
      throw new Error(`A série "${s.nome || '(sem nome)'}" tem ${(s.valores || []).length} valores, mas há ${categorias.length} categorias. Precisam bater.`);
    }
  }
  const svg = svgGrafico({ titulo, subtitulo, tipo, categorias, series });
  const png = await svgParaPng(svg, 1280);
  return artefatos.salvar({
    nome: (nomeArquivo || `grafico-${(titulo || 'quara').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`) + '.png',
    mime: 'image/png',
    buffer: png,
    tipo: 'imagem',
    descricao: titulo || 'Gráfico',
  });
}

async function gerarCapa(args) {
  const { titulo, subtitulo, rodape, nomeArquivo } = args;
  if (!titulo) throw new Error('Preciso do título da capa.');
  const svg = svgCapa({ titulo, subtitulo, rodape });
  const png = await svgParaPng(svg, 1600);
  return artefatos.salvar({
    nome: (nomeArquivo || `capa-${titulo.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`) + '.png',
    mime: 'image/png',
    buffer: png,
    tipo: 'imagem',
    descricao: titulo,
  });
}

async function gerarImagemGenerativa({ descricao, largura = 1024, altura = 1024, estilo }) {
  if (!descricao) throw new Error('Preciso da descrição do que desenhar.');
  const provedor = (process.env.IMAGEM_PROVEDOR || 'pollinations').toLowerCase();
  const prompt = estilo ? `${descricao}. Estilo: ${estilo}` : descricao;

  if (provedor !== 'pollinations') {
    throw new Error(`Provedor de imagem "${provedor}" não é suportado por este servidor. Deixe IMAGEM_PROVEDOR vazio para usar o padrão.`);
  }

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${Math.min(1536, largura)}&height=${Math.min(1536, altura)}&nologo=true`;
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Error('O serviço de geração de imagem não respondeu a tempo. Tente de novo em instantes — se for um gráfico ou uma capa institucional, prefira gerar_grafico ou gerar_capa, que são feitos aqui mesmo e não dependem de serviço externo.');
  }
  if (!r.ok) throw new Error(`O serviço de geração de imagem respondeu ${r.status}.`);
  const buffer = Buffer.from(await r.arrayBuffer());
  if (buffer.length < 1000) throw new Error('O serviço de imagem devolveu um arquivo vazio.');
  return artefatos.salvar({
    nome: `imagem-${Date.now()}.jpg`,
    mime: r.headers.get('content-type') || 'image/jpeg',
    buffer,
    tipo: 'imagem',
    descricao: descricao.slice(0, 200),
  });
}

const FERRAMENTAS = [
  {
    nome: 'gerar_grafico',
    escrita: false,
    executar: gerarGrafico,
    declaracao: {
      type: 'function',
      function: {
        name: 'gerar_grafico',
        description:
          'Desenha um gráfico de barras ou de linhas com a identidade visual da Paulista Jr e devolve um PNG pronto para baixar ou colocar numa apresentação. Use para mostrar projeções, comparações de preço, evolução de faturamento. Os valores são plotados exatamente como recebidos.',
        parameters: {
          type: 'object',
          properties: {
            titulo: { type: 'string' },
            subtitulo: { type: 'string' },
            tipo: { type: 'string', enum: ['barra', 'linha'] },
            categorias: { type: 'array', items: { type: 'string' }, description: 'Rótulos do eixo X (meses, serviços, etc.).' },
            series: {
              type: 'array',
              description: 'Uma ou mais séries. Cada série precisa ter exatamente um valor por categoria.',
              items: {
                type: 'object',
                properties: {
                  nome: { type: 'string' },
                  valores: { type: 'array', items: { type: 'number' } },
                },
                required: ['valores'],
              },
            },
            nomeArquivo: { type: 'string' },
          },
          required: ['categorias', 'series'],
        },
      },
    },
  },
  {
    nome: 'gerar_capa',
    escrita: false,
    executar: gerarCapa,
    declaracao: {
      type: 'function',
      function: {
        name: 'gerar_capa',
        description: 'Gera uma imagem de capa institucional da Paulista Jr (logo, cores da marca, título grande) — para abrir uma proposta, um relatório ou um post.',
        parameters: {
          type: 'object',
          properties: {
            titulo: { type: 'string' },
            subtitulo: { type: 'string' },
            rodape: { type: 'string', description: 'Linha pequena no pé, ex.: cliente e data.' },
            nomeArquivo: { type: 'string' },
          },
          required: ['titulo'],
        },
      },
    },
  },
  {
    nome: 'gerar_imagem',
    escrita: false,
    executar: gerarImagemGenerativa,
    declaracao: {
      type: 'function',
      function: {
        name: 'gerar_imagem',
        description:
          'Gera uma ilustração a partir de uma descrição em texto, por um serviço externo de geração de imagem. Use para imagem ilustrativa, fundo, conceito visual. Para gráfico com dados ou capa institucional, use gerar_grafico ou gerar_capa — o resultado sai na identidade da empresa e os números saem corretos.',
        parameters: {
          type: 'object',
          properties: {
            descricao: { type: 'string', description: 'O que desenhar, com detalhes. Em inglês o resultado costuma ser melhor.' },
            estilo: { type: 'string', description: 'Ex.: fotografia, ilustração minimalista, 3D render.' },
            largura: { type: 'number' },
            altura: { type: 'number' },
          },
          required: ['descricao'],
        },
      },
    },
  },
];

module.exports = { FERRAMENTAS, gerarGrafico, gerarCapa, gerarImagemGenerativa, svgGrafico, svgCapa, svgParaPng };
