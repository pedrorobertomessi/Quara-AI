// tools/apresentacao.js — geração de apresentações .pptx com a cara da Paulista Jr.
//
// O modelo de linguagem descreve a ESTRUTURA (que slides, com que conteúdo); o desenho de cada
// slide é feito aqui, em código. Essa divisão é o que separa "apresentação bonita" de "apresentação
// que o modelo achou que estava bonita": posição, tamanho, cor, espaçamento e hierarquia tipográfica
// são decisões de design tomadas uma vez e aplicadas igual em todo deck, e o que varia é só o texto.
//
// O motivo visual que atravessa o deck é o losango do logo — a mesma forma que já é a marca da
// empresa, usada como marcador de tópico e como elemento de fundo. Isso em vez de barras e faixas
// coloridas, que são o clichê que denuncia slide feito às pressas.
//
// Sai um arquivo .pptx de verdade: cada texto é editável, e os gráficos são gráficos nativos do
// PowerPoint (não imagens), então quem receber pode corrigir um número sem precisar refazer o slide.

const PptxGenJS = require('pptxgenjs');
const { CORES, EMPRESA, logoBuffer } = require('../lib/marca');
const artefatos = require('../lib/artefatos');

// pptxgenjs não aceita '#' nem canal alfa no hex — com qualquer um dos dois o arquivo sai
// corrompido, sem erro na geração.
const hex = (c) => String(c).replace('#', '').toUpperCase();
const VERMELHO = hex(CORES.vermelho);
const GRAFITE = hex(CORES.grafite);
const PRETO = hex(CORES.preto);
const CINZA = hex(CORES.cinza);
const CINZA_CLARO = hex(CORES.cinzaClaro);
const BRANCO = 'FFFFFF';
const FUNDO_CLARO = hex(CORES.fundoClaro);

// Calibri e Arial acompanham qualquer instalação do Office e têm métricas previsíveis. A Maven Pro
// da marca ficaria melhor, mas seria substituída em silêncio na máquina de quem abrir o arquivo —
// e um texto que estoura a caixa no computador do cliente é pior que uma fonte aproximada.
const FONTE = 'Calibri';

const L = 13.333; // largura do slide (LAYOUT_WIDE), em polegadas
const A = 7.5; // altura
const MARGEM = 0.75;

function imagemLogo(variante) {
  return { data: 'image/png;base64,' + logoBuffer(variante).toString('base64') };
}

// Losango vazado, o motivo do deck. Recebe sempre um objeto novo: o pptxgenjs converte as opções
// para EMU na primeira utilização e MUTA o objeto, então reaproveitar um só quebraria o segundo uso.
function losango(slide, pptx, { x, y, tamanho, cor, espessura = 1.5, transparencia = 0 }) {
  slide.addShape(pptx.ShapeType.diamond, {
    x,
    y,
    w: tamanho,
    h: tamanho,
    fill: { type: 'none' },
    line: { color: cor, width: espessura, transparency: transparencia },
  });
}

function rodape(slide, { escuro = false, numero, total } = {}) {
  slide.addText(EMPRESA.nomeCurto, {
    x: MARGEM,
    y: A - 0.55,
    w: 4,
    h: 0.3,
    fontSize: 10,
    fontFace: FONTE,
    color: escuro ? CINZA : CINZA,
    isTextBox: true,
    margin: 0,
  });
  if (numero) {
    slide.addText(String(numero) + (total ? ` / ${total}` : ''), {
      x: L - MARGEM - 1.5,
      y: A - 0.55,
      w: 1.5,
      h: 0.3,
      fontSize: 10,
      fontFace: FONTE,
      color: CINZA,
      align: 'right',
      isTextBox: true,
      margin: 0,
    });
  }
}

function tituloSlide(slide, texto, { subtitulo } = {}) {
  slide.addText(texto || '', {
    x: MARGEM,
    y: 0.55,
    w: L - MARGEM * 2 - 1.6,
    h: 0.85,
    fontSize: 34,
    bold: true,
    fontFace: FONTE,
    color: GRAFITE,
    isTextBox: true,
    margin: 0,
    valign: 'middle',
  });
  if (subtitulo) {
    slide.addText(subtitulo, {
      x: MARGEM,
      y: 1.42,
      w: L - MARGEM * 2 - 1.6,
      h: 0.4,
      fontSize: 15,
      fontFace: FONTE,
      color: CINZA,
      isTextBox: true,
      margin: 0,
    });
  }
}

function marcaDagua(slide) {
  slide.addImage({ ...imagemLogo('escuro'), x: L - MARGEM - 1.5, y: 0.55, w: 1.5, h: 0.5 });
}

// ---------- Slides ----------

function slideCapa(pptx, s) {
  const slide = pptx.addSlide();
  slide.background = { color: PRETO };
  // Losangos grandes e translúcidos no canto: profundidade sem faixa colorida.
  losango(slide, pptx, { x: L - 3.6, y: A - 3.8, tamanho: 5.2, cor: VERMELHO, espessura: 2.5, transparencia: 70 });
  losango(slide, pptx, { x: L - 2.4, y: A - 2.6, tamanho: 3.2, cor: VERMELHO, espessura: 2, transparencia: 82 });
  slide.addImage({ ...imagemLogo('claro'), x: MARGEM, y: 0.7, w: 2.6, h: 0.87 });
  slide.addText(s.titulo || '', {
    x: MARGEM,
    y: 2.7,
    w: L - MARGEM * 2 - 2.6,
    h: 2.1,
    fontSize: s.titulo && s.titulo.length > 60 ? 36 : 44,
    bold: true,
    fontFace: FONTE,
    color: BRANCO,
    isTextBox: true,
    margin: 0,
    valign: 'top',
  });
  if (s.subtitulo) {
    slide.addText(s.subtitulo, {
      x: MARGEM,
      y: 4.9,
      w: L - MARGEM * 2 - 2.6,
      h: 0.6,
      fontSize: 19,
      fontFace: FONTE,
      color: CINZA_CLARO,
      isTextBox: true,
      margin: 0,
    });
  }
  slide.addText(s.rodape || `${EMPRESA.nomeCurto} · ${EMPRESA.site}`, {
    x: MARGEM,
    y: A - 1.1,
    w: 7,
    h: 0.4,
    fontSize: 12,
    fontFace: FONTE,
    color: CINZA,
    isTextBox: true,
    margin: 0,
  });
  if (s.notas) slide.addNotes(s.notas);
  return slide;
}

function slideSecao(pptx, s, ctx) {
  const slide = pptx.addSlide();
  slide.background = { color: GRAFITE };
  losango(slide, pptx, { x: -1.2, y: A / 2 - 1.6, tamanho: 3.2, cor: VERMELHO, espessura: 2.5, transparencia: 55 });
  if (s.numero) {
    slide.addText(String(s.numero).padStart(2, '0'), {
      x: MARGEM + 1.9,
      y: 2.5,
      w: 2,
      h: 1.1,
      fontSize: 56,
      bold: true,
      fontFace: FONTE,
      color: VERMELHO,
      isTextBox: true,
      margin: 0,
    });
  }
  slide.addText(s.titulo || '', {
    x: MARGEM + 1.9,
    y: s.numero ? 3.5 : 3.0,
    w: L - MARGEM * 2 - 2.4,
    h: 1.2,
    fontSize: 36,
    bold: true,
    fontFace: FONTE,
    color: BRANCO,
    isTextBox: true,
    margin: 0,
  });
  if (s.subtitulo) {
    slide.addText(s.subtitulo, {
      x: MARGEM + 1.9,
      y: s.numero ? 4.7 : 4.2,
      w: L - MARGEM * 2 - 2.4,
      h: 0.6,
      fontSize: 16,
      fontFace: FONTE,
      color: CINZA_CLARO,
      isTextBox: true,
      margin: 0,
    });
  }
  if (s.notas) slide.addNotes(s.notas);
  rodape(slide, { numero: ctx.numero, total: ctx.total });
  return slide;
}

function slideTopicos(pptx, s, ctx) {
  const slide = pptx.addSlide();
  slide.background = { color: BRANCO };
  tituloSlide(slide, s.titulo, { subtitulo: s.subtitulo });
  marcaDagua(slide);
  const itens = (s.itens || []).slice(0, 6);
  const topo = s.subtitulo ? 2.2 : 1.9;
  const alturaLinha = Math.min(0.95, (A - topo - 0.9) / Math.max(1, itens.length));
  itens.forEach((item, i) => {
    const y = topo + i * alturaLinha;
    const titulo = typeof item === 'string' ? item : item.titulo;
    const detalhe = typeof item === 'string' ? null : item.detalhe;
    losango(slide, pptx, { x: MARGEM, y: y + 0.1, tamanho: 0.22, cor: VERMELHO, espessura: 2 });
    slide.addText(titulo || '', {
      x: MARGEM + 0.45,
      y,
      w: L - MARGEM * 2 - 0.45,
      h: detalhe ? 0.34 : alturaLinha - 0.1,
      fontSize: 17,
      bold: true,
      fontFace: FONTE,
      color: GRAFITE,
      isTextBox: true,
      margin: 0,
      valign: 'top',
    });
    if (detalhe) {
      slide.addText(detalhe, {
        x: MARGEM + 0.45,
        y: y + 0.33,
        w: L - MARGEM * 2 - 0.45,
        h: alturaLinha - 0.42,
        fontSize: 13.5,
        fontFace: FONTE,
        color: CINZA,
        isTextBox: true,
        margin: 0,
        valign: 'top',
      });
    }
  });
  if (s.notas) slide.addNotes(s.notas);
  rodape(slide, { numero: ctx.numero, total: ctx.total });
  return slide;
}

function slideNumeros(pptx, s, ctx) {
  const slide = pptx.addSlide();
  slide.background = { color: FUNDO_CLARO };
  tituloSlide(slide, s.titulo, { subtitulo: s.subtitulo });
  marcaDagua(slide);
  const metricas = (s.metricas || []).slice(0, 4);
  const n = Math.max(1, metricas.length);
  const larguraTotal = L - MARGEM * 2;
  const gap = 0.3;
  const larguraCartao = (larguraTotal - gap * (n - 1)) / n;
  const topo = s.subtitulo ? 2.4 : 2.1;
  metricas.forEach((m, i) => {
    const x = MARGEM + i * (larguraCartao + gap);
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y: topo,
      w: larguraCartao,
      h: 2.7,
      fill: { color: BRANCO },
      line: { color: CINZA_CLARO, width: 1 },
      rectRadius: 0.08,
      shadow: { type: 'outer', angle: 90, blur: 8, offset: 2, color: CINZA_CLARO, opacity: 0.5 },
    });
    slide.addText(String(m.valor ?? ''), {
      x: x + 0.25,
      y: topo + 0.45,
      w: larguraCartao - 0.5,
      h: 1.1,
      fontSize: String(m.valor ?? '').length > 8 ? 34 : 44,
      bold: true,
      fontFace: FONTE,
      color: VERMELHO,
      isTextBox: true,
      margin: 0,
      valign: 'middle',
    });
    slide.addText(m.rotulo || '', {
      x: x + 0.25,
      y: topo + 1.6,
      w: larguraCartao - 0.5,
      h: 0.4,
      fontSize: 14,
      bold: true,
      fontFace: FONTE,
      color: GRAFITE,
      isTextBox: true,
      margin: 0,
    });
    if (m.nota) {
      slide.addText(m.nota, {
        x: x + 0.25,
        y: topo + 2.0,
        w: larguraCartao - 0.5,
        h: 0.55,
        fontSize: 11.5,
        fontFace: FONTE,
        color: CINZA,
        isTextBox: true,
        margin: 0,
        valign: 'top',
      });
    }
  });
  if (s.textoApoio) {
    slide.addText(s.textoApoio, {
      x: MARGEM,
      y: topo + 2.95,
      w: L - MARGEM * 2,
      h: 0.7,
      fontSize: 13.5,
      fontFace: FONTE,
      color: CINZA,
      isTextBox: true,
      margin: 0,
    });
  }
  if (s.notas) slide.addNotes(s.notas);
  rodape(slide, { numero: ctx.numero, total: ctx.total });
  return slide;
}

function colunaDeItens(slide, pptx, { x, largura, topo, titulo, itens, corTitulo }) {
  slide.addText(titulo || '', {
    x,
    y: topo,
    w: largura,
    h: 0.45,
    fontSize: 18,
    bold: true,
    fontFace: FONTE,
    color: corTitulo,
    isTextBox: true,
    margin: 0,
  });
  const texto = (itens || []).map((t, i, arr) => ({
    text: typeof t === 'string' ? t : t.titulo,
    options: { bullet: true, breakLine: i < arr.length - 1, paraSpaceAfter: 8 },
  }));
  if (texto.length) {
    slide.addText(texto, {
      x,
      y: topo + 0.55,
      w: largura,
      h: A - topo - 1.4,
      fontSize: 14.5,
      fontFace: FONTE,
      color: GRAFITE,
      isTextBox: true,
      margin: 0,
      valign: 'top',
    });
  }
}

function slideDuasColunas(pptx, s, ctx) {
  const slide = pptx.addSlide();
  slide.background = { color: BRANCO };
  tituloSlide(slide, s.titulo, { subtitulo: s.subtitulo });
  marcaDagua(slide);
  const topo = s.subtitulo ? 2.3 : 2.0;
  const largura = (L - MARGEM * 2 - 0.6) / 2;
  const alturaCartao = A - topo - 0.7;
  // As duas colunas ganham cartão, com tratamentos diferentes: a esquerda (o estado atual) num
  // cinza chapado, a direita (a proposta) em branco com sombra, para ela saltar. Tintar só uma das
  // duas, como estava antes, parecia defeito de renderização em vez de escolha.
  slide.addShape(pptx.ShapeType.roundRect, {
    x: MARGEM - 0.2,
    y: topo - 0.25,
    w: largura + 0.4,
    h: alturaCartao,
    fill: { color: FUNDO_CLARO },
    line: { color: CINZA_CLARO, width: 0.5 },
    rectRadius: 0.08,
  });
  slide.addShape(pptx.ShapeType.roundRect, {
    x: MARGEM + largura + 0.4,
    y: topo - 0.25,
    w: largura + 0.4,
    h: alturaCartao,
    fill: { color: BRANCO },
    line: { color: CINZA_CLARO, width: 1 },
    rectRadius: 0.08,
    shadow: { type: 'outer', angle: 90, blur: 10, offset: 2, color: CINZA_CLARO, opacity: 0.6 },
  });
  colunaDeItens(slide, pptx, { x: MARGEM, largura, topo, titulo: (s.esquerda || {}).titulo, itens: (s.esquerda || {}).itens, corTitulo: GRAFITE });
  colunaDeItens(slide, pptx, { x: MARGEM + largura + 0.6, largura, topo, titulo: (s.direita || {}).titulo, itens: (s.direita || {}).itens, corTitulo: VERMELHO });
  if (s.notas) slide.addNotes(s.notas);
  rodape(slide, { numero: ctx.numero, total: ctx.total });
  return slide;
}

function slideGrafico(pptx, s, ctx) {
  const slide = pptx.addSlide();
  slide.background = { color: BRANCO };
  tituloSlide(slide, s.titulo, { subtitulo: s.subtitulo });
  marcaDagua(slide);
  const series = (s.series || []).map((serie, i) => ({
    name: serie.nome || `Série ${i + 1}`,
    labels: s.categorias || [],
    values: (serie.valores || []).map(Number),
  }));
  const tipo = s.tipo === 'linha' ? pptx.ChartType.line : s.tipo === 'pizza' ? pptx.ChartType.pie : pptx.ChartType.bar;
  const paleta = [VERMELHO, GRAFITE, '8A8A8D', 'C0392B', '2E5A6B', 'B0B0B3'];
  const temTexto = !!s.comentario;
  slide.addChart(tipo, series, {
    x: MARGEM,
    y: s.subtitulo ? 2.2 : 1.95,
    w: temTexto ? L - MARGEM * 2 - 3.6 : L - MARGEM * 2,
    h: A - (s.subtitulo ? 2.2 : 1.95) - 0.8,
    chartColors: paleta,
    barDir: s.orientacao === 'horizontal' ? 'bar' : 'col',
    showLegend: series.length > 1,
    legendPos: 'b',
    legendColor: CINZA,
    legendFontSize: 11,
    showValue: tipo !== pptx.ChartType.pie,
    dataLabelPosition: tipo === pptx.ChartType.line ? 't' : 'outEnd',
    dataLabelColor: GRAFITE,
    dataLabelFontSize: 11,
    dataLabelFormatCode: s.formatoValor || '#,##0',
    catAxisLabelColor: CINZA,
    catAxisLabelFontSize: 12,
    valAxisLabelColor: CINZA,
    valAxisLabelFontSize: 11,
    valGridLine: { color: CINZA_CLARO, size: 1 },
    catGridLine: { style: 'none' },
    lineSmooth: false,
    lineDataSymbolSize: 7,
    chartArea: { fill: { color: BRANCO } },
  });
  if (temTexto) {
    slide.addText(s.comentario, {
      x: L - MARGEM - 3.2,
      y: s.subtitulo ? 2.3 : 2.05,
      w: 3.2,
      h: 3.4,
      fontSize: 14,
      fontFace: FONTE,
      color: GRAFITE,
      isTextBox: true,
      margin: 0,
      valign: 'top',
    });
  }
  if (s.notas) slide.addNotes(s.notas);
  rodape(slide, { numero: ctx.numero, total: ctx.total });
  return slide;
}

function slideTabela(pptx, s, ctx) {
  const slide = pptx.addSlide();
  slide.background = { color: BRANCO };
  tituloSlide(slide, s.titulo, { subtitulo: s.subtitulo });
  marcaDagua(slide);
  const colunas = s.colunas || [];
  const linhas = s.linhas || [];
  const cabecalho = colunas.map((c) => ({
    text: String(c),
    options: { bold: true, color: BRANCO, fill: { color: GRAFITE }, fontSize: 13, fontFace: FONTE },
  }));
  const corpo = linhas.map((linha, i) =>
    linha.map((celula) => ({
      text: String(celula ?? ''),
      options: { fontSize: 12.5, fontFace: FONTE, color: GRAFITE, fill: { color: i % 2 ? FUNDO_CLARO : BRANCO } },
    }))
  );
  slide.addTable([cabecalho, ...corpo], {
    x: MARGEM,
    y: s.subtitulo ? 2.2 : 1.95,
    w: L - MARGEM * 2,
    border: { type: 'solid', color: CINZA_CLARO, pt: 0.5 },
    autoPage: false,
    rowH: 0.36,
  });
  if (s.notas) slide.addNotes(s.notas);
  rodape(slide, { numero: ctx.numero, total: ctx.total });
  return slide;
}

function slideTexto(pptx, s, ctx) {
  const slide = pptx.addSlide();
  slide.background = { color: BRANCO };
  tituloSlide(slide, s.titulo, { subtitulo: s.subtitulo });
  marcaDagua(slide);
  slide.addText(s.texto || '', {
    x: MARGEM,
    y: s.subtitulo ? 2.3 : 2.0,
    w: L - MARGEM * 2,
    h: A - (s.subtitulo ? 2.3 : 2.0) - 0.8,
    fontSize: 16,
    fontFace: FONTE,
    color: GRAFITE,
    isTextBox: true,
    margin: 0,
    valign: 'top',
    lineSpacingMultiple: 1.25,
  });
  if (s.notas) slide.addNotes(s.notas);
  rodape(slide, { numero: ctx.numero, total: ctx.total });
  return slide;
}

async function slideImagem(pptx, s, ctx) {
  const slide = pptx.addSlide();
  slide.background = { color: BRANCO };
  let dados = null;
  if (s.artefatoId) {
    const a = await artefatos.obter(s.artefatoId);
    if (a) dados = { data: `${a.mime};base64,` + Buffer.from(a.conteudo).toString('base64') };
  }
  if (!dados && s.urlImagem) dados = { path: s.urlImagem };
  if (!dados) {
    // Sem imagem disponível, vira slide de texto em vez de um retângulo vazio — degradar é melhor
    // que entregar um buraco no meio da apresentação.
    return slideTexto(pptx, { titulo: s.titulo, texto: s.legenda || '' }, ctx);
  }
  // Metade-sangria: painel ocupando o lado direito inteiro, texto à esquerda. Layout diferente dos
  // outros slides de propósito — repetir o mesmo arranjo o deck inteiro é o que deixa monótono.
  //
  // A imagem é encaixada com `contain`, não `cover`: o que costuma cair aqui é um gráfico 16:9
  // gerado por gerar_grafico, e recortá-lo para caber num painel em pé cortaria justamente os
  // eixos e os rótulos. O painel de fundo cobre a folga que sobra, então não fica buraco branco.
  const painel = { x: L / 2, y: 0, w: L / 2, h: A };
  slide.addShape(pptx.ShapeType.rect, { ...painel, fill: { color: FUNDO_CLARO }, line: { color: FUNDO_CLARO, width: 0 } });
  const caixa = { x: L / 2 + 0.4, y: 0.5, w: L / 2 - 0.8, h: A - 1.0 };
  slide.addImage({ ...dados, ...caixa, sizing: { type: 'contain', w: caixa.w, h: caixa.h } });
  slide.addText(s.titulo || '', {
    x: MARGEM,
    y: 2.2,
    w: L / 2 - MARGEM - 0.5,
    h: 1.6,
    fontSize: 30,
    bold: true,
    fontFace: FONTE,
    color: GRAFITE,
    isTextBox: true,
    margin: 0,
    valign: 'top',
  });
  if (s.legenda) {
    slide.addText(s.legenda, {
      x: MARGEM,
      y: 3.9,
      w: L / 2 - MARGEM - 0.5,
      h: 2,
      fontSize: 14.5,
      fontFace: FONTE,
      color: CINZA,
      isTextBox: true,
      margin: 0,
      valign: 'top',
    });
  }
  if (s.notas) slide.addNotes(s.notas);
  rodape(slide, { numero: ctx.numero, total: ctx.total });
  return slide;
}

function slideEncerramento(pptx, s) {
  const slide = pptx.addSlide();
  slide.background = { color: PRETO };
  losango(slide, pptx, { x: -1.5, y: -1.5, tamanho: 4.5, cor: VERMELHO, espessura: 2.5, transparencia: 72 });
  slide.addImage({ ...imagemLogo('claro'), x: MARGEM, y: 2.4, w: 3, h: 1 });
  slide.addText(s.titulo || 'Obrigado.', {
    x: MARGEM,
    y: 3.7,
    w: L - MARGEM * 2,
    h: 1,
    fontSize: 38,
    bold: true,
    fontFace: FONTE,
    color: BRANCO,
    isTextBox: true,
    margin: 0,
  });
  const contato = s.contato || `${EMPRESA.email} · ${EMPRESA.telefone} · ${EMPRESA.site}`;
  slide.addText(contato, {
    x: MARGEM,
    y: 4.8,
    w: L - MARGEM * 2,
    h: 0.5,
    fontSize: 15,
    fontFace: FONTE,
    color: CINZA_CLARO,
    isTextBox: true,
    margin: 0,
  });
  if (s.notas) slide.addNotes(s.notas);
  return slide;
}

const RENDERIZADORES = {
  capa: slideCapa,
  secao: slideSecao,
  topicos: slideTopicos,
  numeros: slideNumeros,
  duas_colunas: slideDuasColunas,
  grafico: slideGrafico,
  tabela: slideTabela,
  texto: slideTexto,
  imagem: slideImagem,
  encerramento: slideEncerramento,
};

async function gerarApresentacao({ titulo, subtitulo, slides, nomeArquivo, autor }) {
  if (!Array.isArray(slides) || !slides.length) throw new Error('Preciso da lista de slides.');
  const pptx = new PptxGenJS();
  // Definir o layout ANTES de adicionar qualquer slide: o padrão é 10 polegadas de largura, e
  // coordenadas além disso são gravadas sem aviso — o elemento simplesmente não aparece.
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = autor || EMPRESA.nome;
  pptx.company = EMPRESA.nome;
  pptx.title = titulo || 'Apresentação';

  const lista = [...slides];
  // Capa e encerramento entram sozinhos se quem pediu não listou — um deck institucional sem capa
  // não é uma escolha de design, é um esquecimento.
  if (lista[0].tipo !== 'capa') lista.unshift({ tipo: 'capa', titulo: titulo || 'Apresentação', subtitulo });
  if (lista[lista.length - 1].tipo !== 'encerramento') lista.push({ tipo: 'encerramento' });

  const total = lista.length;
  for (let i = 0; i < lista.length; i++) {
    const s = lista[i];
    const render = RENDERIZADORES[s.tipo];
    if (!render) throw new Error(`Tipo de slide desconhecido: "${s.tipo}". Use: ${Object.keys(RENDERIZADORES).join(', ')}.`);
    await render(pptx, s, { numero: i + 1, total });
  }

  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  const base = (nomeArquivo || titulo || 'apresentacao').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
  return artefatos.salvar({
    nome: `${base}.pptx`,
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer,
    tipo: 'apresentacao',
    descricao: titulo || 'Apresentação',
    // devolvido junto para o chat conseguir dizer quantos slides saíram
  }).then((art) => ({ ...art, totalSlides: total }));
}

const FERRAMENTAS = [
  {
    nome: 'gerar_apresentacao',
    escrita: false,
    executar: gerarApresentacao,
    declaracao: {
      type: 'function',
      function: {
        name: 'gerar_apresentacao',
        description:
          'Gera uma apresentação .pptx com a identidade visual da Paulista Jr (cores, logo, tipografia) a partir de uma estrutura de slides. Capa e encerramento são adicionados automaticamente se não forem listados. Gráficos saem como gráficos nativos do PowerPoint, editáveis. Monte uma estrutura VARIADA — alternar tipos de slide (tópicos, números, gráfico, duas colunas) é o que separa um deck bom de uma lista de bullets.',
        parameters: {
          type: 'object',
          properties: {
            titulo: { type: 'string', description: 'Título da apresentação (vira a capa).' },
            subtitulo: { type: 'string' },
            nomeArquivo: { type: 'string' },
            slides: {
              type: 'array',
              description: 'Os slides, na ordem.',
              items: {
                type: 'object',
                properties: {
                  tipo: {
                    type: 'string',
                    enum: ['capa', 'secao', 'topicos', 'numeros', 'duas_colunas', 'grafico', 'tabela', 'texto', 'imagem', 'encerramento'],
                    description:
                      'capa=abertura; secao=divisória numerada; topicos=até 6 pontos com título e detalhe; numeros=até 4 métricas em destaque; duas_colunas=comparação lado a lado; grafico=gráfico nativo; tabela=tabela; texto=parágrafo; imagem=imagem sangrada com texto ao lado; encerramento=fechamento com contato.',
                  },
                  titulo: { type: 'string' },
                  subtitulo: { type: 'string' },
                  numero: { type: 'number', description: 'Para secao: o número da seção.' },
                  texto: { type: 'string', description: 'Para tipo texto.' },
                  itens: {
                    type: 'array',
                    description: 'Para topicos: cada item com titulo e detalhe.',
                    items: { type: 'object', properties: { titulo: { type: 'string' }, detalhe: { type: 'string' } } },
                  },
                  metricas: {
                    type: 'array',
                    description: 'Para numeros: até 4 métricas.',
                    items: { type: 'object', properties: { valor: { type: 'string' }, rotulo: { type: 'string' }, nota: { type: 'string' } } },
                  },
                  textoApoio: { type: 'string', description: 'Para numeros: uma linha de contexto abaixo dos cartões.' },
                  esquerda: { type: 'object', properties: { titulo: { type: 'string' }, itens: { type: 'array', items: { type: 'string' } } } },
                  direita: { type: 'object', properties: { titulo: { type: 'string' }, itens: { type: 'array', items: { type: 'string' } } } },
                  categorias: { type: 'array', items: { type: 'string' }, description: 'Para grafico: rótulos do eixo X.' },
                  series: {
                    type: 'array',
                    description: 'Para grafico: séries com nome e valores (um valor por categoria).',
                    items: { type: 'object', properties: { nome: { type: 'string' }, valores: { type: 'array', items: { type: 'number' } } } },
                  },
                  comentario: { type: 'string', description: 'Para grafico: texto ao lado explicando o que o gráfico mostra.' },
                  colunas: { type: 'array', items: { type: 'string' }, description: 'Para tabela: cabeçalho.' },
                  linhas: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Para tabela: as linhas.' },
                  artefatoId: { type: 'string', description: 'Para imagem: id de uma imagem gerada antes por gerar_imagem/gerar_capa/gerar_grafico.' },
                  legenda: { type: 'string' },
                  contato: { type: 'string', description: 'Para encerramento.' },
                  rodape: { type: 'string', description: 'Para capa.' },
                  notas: { type: 'string', description: 'Notas do apresentador (não aparecem no slide).' },
                },
                required: ['tipo'],
              },
            },
          },
          required: ['slides'],
        },
      },
    },
  },
];

module.exports = { FERRAMENTAS, gerarApresentacao };
