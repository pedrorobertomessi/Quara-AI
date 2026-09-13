// tools/index.js — o registro central das ferramentas da Quara.
//
// Cada módulo em tools/ exporta uma lista `FERRAMENTAS` no mesmo formato; aqui elas são juntadas em
// um único catálogo e exposta uma função de execução. O ganho concreto: acrescentar uma capacidade
// nova passa a ser criar um arquivo e incluí-lo na lista MODULOS abaixo — nada em chat.js e nada em
// server.js precisa mudar. Antes disso, cada ferramenta nova exigia mexer em um switch gigante e na
// declaração, em dois lugares que era fácil deixar dessincronizados.
//
// O formato de cada ferramenta:
//   nome            string, precisa bater com declaracao.function.name
//   escrita         true se GRAVA alguma coisa — o que obriga confirmação da pessoa antes de rodar
//   precisaContexto true se depende do estado da tela (valores-hora, tabela de preços)
//   executar        async (args, contexto) => resultado
//   declaracao      JSON Schema no formato OpenAI/Groq

const precos = require('./precos');
const gg = require('./gg');
const financeiro = require('./financeiro');
const web = require('./web');
const datajud = require('./datajud');
const imagem = require('./imagem');
const apresentacao = require('./apresentacao');
const contrato = require('./contrato');
const artefatosLib = require('../lib/artefatos');

const listarArtefatos = {
  nome: 'listar_arquivos_gerados',
  escrita: false,
  executar: async ({ limite } = {}) => {
    const lista = await artefatosLib.listar(limite || 10);
    return {
      arquivos: lista.map((a) => ({ ...a, criadoEm: new Date(a.criadoEm).toLocaleString('pt-BR') })),
      observacao: `Arquivos gerados ficam disponíveis por ${artefatosLib.ARTEFATO_VALIDADE_DIAS} dias. Depois disso é só pedir para gerar de novo.`,
    };
  },
  declaracao: {
    type: 'function',
    function: {
      name: 'listar_arquivos_gerados',
      description: 'Lista os arquivos que a Quara gerou recentemente (contratos, apresentações, imagens) e ainda estão disponíveis para download.',
      parameters: { type: 'object', properties: { limite: { type: 'number' } } },
    },
  },
};

const MODULOS = [precos, gg, financeiro, web, datajud, imagem, apresentacao, contrato];

const FERRAMENTAS = [...MODULOS.flatMap((m) => m.FERRAMENTAS), listarArtefatos];

// Verificação na carga do módulo, não em tempo de execução: um nome duplicado faria o modelo pedir
// uma ferramenta e o servidor executar outra silenciosamente. Melhor o processo nem subir.
const vistos = new Set();
for (const f of FERRAMENTAS) {
  if (vistos.has(f.nome)) throw new Error(`Ferramenta duplicada no registro: ${f.nome}`);
  vistos.add(f.nome);
  if (f.declaracao.function.name !== f.nome) {
    throw new Error(`Ferramenta "${f.nome}" declara o nome "${f.declaracao.function.name}" — precisam ser iguais.`);
  }
}

const POR_NOME = new Map(FERRAMENTAS.map((f) => [f.nome, f]));

function declaracoes() {
  return FERRAMENTAS.map((f) => f.declaracao);
}

function buscar(nome) {
  return POR_NOME.get(nome) || null;
}

async function executarFerramenta(nome, args, contexto = {}) {
  const ferramenta = POR_NOME.get(nome);
  if (!ferramenta) throw new Error(`Ferramenta desconhecida: ${nome}`);
  return ferramenta.executar(args || {}, contexto);
}

// Agrupamento só para documentação e para a mensagem de sistema — não muda o comportamento.
const CATEGORIAS = {
  'Preços e histórico': precos.FERRAMENTAS.map((f) => f.nome),
  'Projetos de Gente e Gestão': gg.FERRAMENTAS.map((f) => f.nome),
  'Financeiro e projeções': financeiro.FERRAMENTAS.map((f) => f.nome),
  'Pesquisa na web': web.FERRAMENTAS.map((f) => f.nome),
  'Processos judiciais (CNJ/DataJud)': datajud.FERRAMENTAS.map((f) => f.nome),
  'Imagens e gráficos': imagem.FERRAMENTAS.map((f) => f.nome),
  Apresentações: apresentacao.FERRAMENTAS.map((f) => f.nome),
  Contratos: contrato.FERRAMENTAS.map((f) => f.nome),
};

module.exports = { FERRAMENTAS, declaracoes, buscar, executarFerramenta, CATEGORIAS };
