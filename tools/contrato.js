// tools/contrato.js — transforma a estrutura de lib/contrato-modelo.js em um .docx assinável.
//
// A divisão é proposital: o QUE o contrato diz está em lib/contrato-modelo.js, revisável por quem
// entende de contrato sem precisar ler código de formatação; COMO ele aparece na página está aqui.
// Quem for revisar as cláusulas não deveria ter que atravessar declaração de margem para chegar
// nelas.
//
// O cabeçalho reproduz o do contrato real da EJ: logo à esquerda, dados institucionais à direita,
// repetidos em toda página. Papel timbrado não é enfeite em documento jurídico — é o que identifica
// de quem é o instrumento em cada folha solta que pode acabar separada das outras.

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  Header,
  Footer,
  AlignmentType,
  HeadingLevel,
  PageNumber,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  convertInchesToTwip,
} = require('docx');

const { montarContrato, camposFaltando, CAMPOS_OBRIGATORIOS } = require('../lib/contrato-modelo');
const { CORES, EMPRESA, logoBuffer } = require('../lib/marca');
const artefatos = require('../lib/artefatos');

const hex = (c) => String(c).replace('#', '').toUpperCase();
const FONTE = 'Calibri';
const SEM_BORDA = { top: { style: BorderStyle.NONE, size: 0 }, bottom: { style: BorderStyle.NONE, size: 0 }, left: { style: BorderStyle.NONE, size: 0 }, right: { style: BorderStyle.NONE, size: 0 } };

// Converte `**negrito**` do texto do modelo em runs formatados. É o único markup suportado, porque
// é o único que o contrato usa: destacar as partes (CONTRATANTE, CONTRATADA), os rótulos de
// cláusula e os campos preenchíveis.
function runs(texto, base = {}) {
  const partes = String(texto).split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== '');
  return partes.map((p) => {
    const negrito = p.startsWith('**') && p.endsWith('**');
    return new TextRun({ text: negrito ? p.slice(2, -2) : p, bold: negrito, font: FONTE, ...base });
  });
}

function paragrafo(texto, opcoes = {}) {
  const { tamanho = 22, alinhamento = AlignmentType.JUSTIFIED, antes = 0, depois = 120, recuo = 0, cor } = opcoes;
  return new Paragraph({
    alignment: alinhamento,
    spacing: { before: antes, after: depois, line: 276 },
    indent: recuo ? { left: recuo } : undefined,
    children: runs(texto, { size: tamanho, color: cor }),
  });
}

function cabecalho() {
  return new Header({
    children: [
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: [3200, 5800],
        borders: SEM_BORDA,
        rows: [
          new TableRow({
            children: [
              new TableCell({
                width: { size: 3200, type: WidthType.DXA },
                borders: SEM_BORDA,
                children: [
                  new Paragraph({
                    children: [
                      new ImageRun({
                        type: 'png',
                        data: logoBuffer('escuro'),
                        transformation: { width: 150, height: 50 },
                      }),
                    ],
                  }),
                ],
              }),
              new TableCell({
                width: { size: 5800, type: WidthType.DXA },
                borders: SEM_BORDA,
                children: [
                  new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    spacing: { after: 0 },
                    children: [new TextRun({ text: EMPRESA.nome, bold: true, size: 17, font: FONTE, color: hex(CORES.grafite) })],
                  }),
                  new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    spacing: { after: 0 },
                    children: [new TextRun({ text: `CNPJ: ${EMPRESA.cnpj}`, size: 16, font: FONTE, color: hex(CORES.cinza) })],
                  }),
                  new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    spacing: { after: 0 },
                    children: [new TextRun({ text: `${EMPRESA.email} / ${EMPRESA.telefone}`, size: 16, font: FONTE, color: hex(CORES.cinza) })],
                  }),
                  new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    spacing: { after: 0 },
                    children: [new TextRun({ text: EMPRESA.site, size: 16, font: FONTE, color: hex(CORES.cinza) })],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      // Régua sob o timbre: borda inferior de parágrafo, e não uma tabela de uma linha — tabela
      // como linha horizontal quebra a numeração e a acessibilidade do documento.
      new Paragraph({
        spacing: { before: 60, after: 200 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: hex(CORES.vermelho), space: 1 } },
        children: [],
      }),
    ],
  });
}

function rodape() {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: 'Página ', size: 16, font: FONTE, color: hex(CORES.cinza) }),
          new TextRun({ children: [PageNumber.CURRENT], size: 16, font: FONTE, color: hex(CORES.cinza) }),
          new TextRun({ text: ' de ', size: 16, font: FONTE, color: hex(CORES.cinza) }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, font: FONTE, color: hex(CORES.cinza) }),
        ],
      }),
    ],
  });
}

function blocoAssinatura({ titulo, empresa, nome, cargo, cpf }) {
  const linhas = [
    new Paragraph({ spacing: { before: 400, after: 0 }, children: [new TextRun({ text: '_________________________________________', size: 22, font: FONTE })] }),
    new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: titulo, bold: true, size: 20, font: FONTE, color: hex(CORES.vermelho) })] }),
  ];
  if (empresa) linhas.push(new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: empresa, bold: true, size: 21, font: FONTE })] }));
  linhas.push(new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: nome, size: 21, font: FONTE })] }));
  if (cargo) linhas.push(new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: cargo, size: 20, font: FONTE, color: hex(CORES.cinza) })] }));
  if (cpf) linhas.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: `CPF: ${cpf}`, size: 20, font: FONTE, color: hex(CORES.cinza) })] }));
  return linhas;
}

function blocosParaParagrafos(blocos) {
  const out = [];
  for (const b of blocos) {
    switch (b.tipo) {
      case 'titulo':
        out.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 320 },
            children: [new TextRun({ text: b.texto, bold: true, size: 28, font: FONTE, color: hex(CORES.grafite) })],
          })
        );
        break;
      case 'capitulo':
        out.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 360, after: 180 },
            children: [new TextRun({ text: b.texto, bold: true, size: 23, font: FONTE, color: hex(CORES.vermelho) })],
          })
        );
        break;
      case 'clausula':
        out.push(paragrafo(b.texto, { depois: 140 }));
        break;
      case 'paragrafo':
        out.push(paragrafo(b.texto, { depois: 140 }));
        break;
      case 'inciso':
        out.push(paragrafo(b.texto, { recuo: convertInchesToTwip(0.35), depois: 100 }));
        break;
      case 'campo':
        out.push(paragrafo(b.texto, { alinhamento: AlignmentType.LEFT, depois: 80 }));
        break;
      case 'espaco':
        out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;
      case 'assinaturas': {
        out.push(...blocoAssinatura(b.contratada));
        out.push(...blocoAssinatura(b.contratante));
        if (b.testemunhas && b.testemunhas.length) {
          out.push(new Paragraph({ spacing: { before: 320, after: 60 }, children: [new TextRun({ text: 'TESTEMUNHAS', bold: true, size: 20, font: FONTE, color: hex(CORES.cinza) })] }));
          b.testemunhas.slice(0, 2).forEach((t, i) => {
            out.push(new Paragraph({ spacing: { before: 320, after: 0 }, children: [new TextRun({ text: '_________________________________', size: 22, font: FONTE })] }));
            out.push(new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: `Testemunha ${i + 1}: ${t.nome}`, size: 21, font: FONTE })] }));
            if (t.cpf) out.push(new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: `CPF: ${t.cpf}`, size: 20, font: FONTE, color: hex(CORES.cinza) })] }));
          });
        }
        break;
      }
      default:
        out.push(paragrafo(b.texto || ''));
    }
  }
  return out;
}

async function gerarContrato(dados) {
  const montado = montarContrato(dados);
  if (montado.erro === 'campos_faltando') {
    // Devolve a lista de perguntas em vez de gerar um documento com lacunas. Quem chama (o chat)
    // usa isso para perguntar à pessoa, e ninguém recebe um contrato com "[preencher]" no corpo.
    return {
      gerado: false,
      motivo: 'Faltam informações obrigatórias para montar o contrato.',
      perguntas: montado.faltando.map((f) => f.pergunta),
      camposFaltando: montado.faltando.map((f) => f.campo),
    };
  }

  const doc = new Document({
    creator: EMPRESA.nome,
    title: `Contrato de Prestação de Serviços — ${dados.contratante.nome}`,
    styles: {
      default: {
        document: { run: { font: FONTE, size: 22 } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: convertInchesToTwip(1.4), bottom: convertInchesToTwip(0.9), left: convertInchesToTwip(1.1), right: convertInchesToTwip(1.1) },
          },
        },
        headers: { default: cabecalho() },
        footers: { default: rodape() },
        children: blocosParaParagrafos(montado.blocos),
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const nomeLimpo = String(dados.contratante.nome).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const artefato = await artefatos.salvar({
    nome: `contrato-${nomeLimpo}.docx`,
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer,
    tipo: 'contrato',
    descricao: `Contrato de prestação de serviços — ${dados.contratante.nome}`,
  });

  return {
    gerado: true,
    ...artefato,
    resumo: montado.resumo,
    aviso: 'Este contrato usa o modelo revisado da Paulista Jr com os campos preenchidos. Confira os dados das partes e o objeto antes de enviar, e passe pela diretoria jurídica/presidência se o escopo fugir do padrão.',
  };
}

async function verificarCamposContrato(dados) {
  const faltando = camposFaltando(dados || {});
  return {
    completo: faltando.length === 0,
    faltando: faltando.map((f) => ({ campo: f.campo, pergunta: f.pergunta })),
    totalObrigatorios: CAMPOS_OBRIGATORIOS.length,
  };
}

const ESQUEMA_DADOS = {
  type: 'object',
  properties: {
    contratante: {
      type: 'object',
      description: 'Quem contrata a Paulista Jr.',
      properties: {
        nome: { type: 'string', description: 'Razão social ou nome completo.' },
        documento: { type: 'string', description: 'CNPJ ou CPF, com pontuação.' },
        naturezaJuridica: { type: 'string', description: 'Ex.: sociedade empresária limitada, associação privada, pessoa física.' },
        endereco: { type: 'string', description: 'Endereço completo da sede, com CEP e cidade/UF.' },
        representante: {
          type: 'object',
          properties: {
            nome: { type: 'string' },
            nacionalidade: { type: 'string' },
            estadoCivil: { type: 'string' },
            profissao: { type: 'string' },
            rg: { type: 'string' },
            cpf: { type: 'string' },
            email: { type: 'string' },
            cargo: { type: 'string' },
          },
          required: ['nome', 'cpf', 'email'],
        },
      },
      required: ['nome', 'documento', 'endereco', 'representante'],
    },
    representanteContratada: {
      type: 'object',
      description: 'Quem assina pela Paulista Jr — o presidente em exercício. NUNCA invente: pergunte.',
      properties: { nome: { type: 'string' }, cpf: { type: 'string' }, rg: { type: 'string' }, estadoCivil: { type: 'string' }, cargo: { type: 'string' } },
      required: ['nome', 'cpf'],
    },
    objeto: { type: 'string', description: 'O que será entregue, em uma frase que complete "É objeto do presente contrato ...".' },
    competencias: { type: 'array', items: { type: 'string' }, description: 'O que compete à contratada fazer (vira os incisos do objeto).' },
    etapas: { type: 'array', items: { type: 'string' }, description: 'Cronograma de etapas de execução.' },
    prazoSemanas: { type: 'number' },
    valorTotal: { type: 'number' },
    formaPagamento: { type: 'string', description: 'Ex.: Pix ou boleto.' },
    parcelado: { type: 'boolean' },
    numParcelas: { type: 'number' },
    diaVencimento: { type: 'number', description: 'Dia do mês de vencimento das parcelas (padrão 15).' },
    mesPrimeiraParcela: { type: 'string', description: "Mês da primeira parcela, 'AAAA-MM'." },
    emailsBoleto: { type: 'array', items: { type: 'string' } },
    emailsNotaFiscal: { type: 'array', items: { type: 'string' } },
    testemunhas: { type: 'array', items: { type: 'object', properties: { nome: { type: 'string' }, cpf: { type: 'string' } } } },
    foro: { type: 'string', description: 'Padrão: Comarca de Araraquara/SP.' },
    cidadeAssinatura: { type: 'string' },
    dataAssinatura: { type: 'string', description: 'Data da assinatura (AAAA-MM-DD). Padrão: hoje.' },
    autorizaDivulgacao: { type: 'boolean', description: 'Se o cliente autoriza ser citado como case. Padrão true.' },
    multaAtrasoPct: { type: 'number' },
    jurosMesPct: { type: 'number' },
    multaRescisaoPct: { type: 'number' },
    prazoAvisoRescisaoDias: { type: 'number' },
    prazoAprovacaoDiasUteis: { type: 'number' },
  },
  required: ['contratante', 'representanteContratada', 'objeto', 'prazoSemanas', 'valorTotal'],
};

const FERRAMENTAS = [
  {
    nome: 'verificar_dados_contrato',
    escrita: false,
    executar: verificarCamposContrato,
    declaracao: {
      type: 'function',
      function: {
        name: 'verificar_dados_contrato',
        description:
          'Confere quais informações ainda faltam para montar um contrato e devolve as perguntas exatas a fazer. Use ANTES de gerar_contrato sempre que não tiver certeza de ter tudo — é melhor perguntar do que gerar um contrato incompleto.',
        parameters: ESQUEMA_DADOS,
      },
    },
  },
  {
    nome: 'gerar_contrato',
    escrita: true,
    executar: gerarContrato,
    declaracao: {
      type: 'function',
      function: {
        name: 'gerar_contrato',
        description:
          'Gera o contrato de prestação de serviços da Paulista Jr em .docx, com papel timbrado, as cláusulas do modelo oficial da EJ e os campos preenchidos. As cláusulas NÃO são escritas por você: vêm do modelo revisado da empresa. Seu papel é coletar os dados corretos e completos. Nunca invente CPF, CNPJ, endereço ou o nome de quem assina — pergunte.',
        parameters: ESQUEMA_DADOS,
      },
    },
  },
];

module.exports = { FERRAMENTAS, gerarContrato, verificarCamposContrato };
