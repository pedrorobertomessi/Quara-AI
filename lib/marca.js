// marca.js — a identidade visual da Paulista Jr em um lugar só.
//
// Existe para que tudo que a Quara gera (apresentação, contrato, imagem de capa, gráfico) saia com
// a MESMA cara, sem cada módulo escolher um vermelho ligeiramente diferente. As cores não foram
// inventadas: foram amostradas pixel a pixel do logo oficial que vem no cabeçalho do contrato
// modelo da empresa (#ED323E no vermelho, #4B4B4D no cinza do losango).
//
// Os dados institucionais (CNPJ, endereço, contato) também vêm do contrato modelo — são o que
// aparece impresso em todo documento oficial da EJ, então ficam aqui e não espalhados em strings.

const fs = require('fs');
const path = require('path');

const CORES = {
  vermelho: '#ED323E', // vermelho do logo — usado como cor de destaque em tudo
  vermelhoEscuro: '#B71C1C', // estados de hover / variação mais séria em documento impresso
  grafite: '#4B4B4D', // cinza do losango do logo — cor de texto forte
  preto: '#1A1A1A',
  cinza: '#6E6E70',
  cinzaClaro: '#D8D8DA',
  fundoClaro: '#F7F7F8',
  branco: '#FFFFFF',
  // Cores de apoio para gráficos (série além da principal). Escolhidas para conviver com o
  // vermelho sem competir com ele — nenhuma outra cor "quente" forte.
  serie: ['#ED323E', '#4B4B4D', '#8A8A8D', '#C0392B', '#2E5A6B', '#B0B0B3'],
};

// Maven Pro é a fonte embutida no contrato modelo (word/fonts/MavenPro-*.ttf). Nem todo ambiente
// que abrir o .pptx/.docx terá Maven Pro instalada, então cada lugar que usa este objeto declara
// também o fallback apropriado — não adianta forçar uma fonte que o Word substitui em silêncio.
const FONTES = {
  titulo: 'Maven Pro',
  tituloFallback: 'Calibri',
  corpo: 'Roboto',
  corpoFallback: 'Calibri',
};

const EMPRESA = {
  nome: 'PAULISTA JÚNIOR PROJETOS E CONSULTORIA',
  nomeCurto: 'Paulista Jr.',
  descricaoLegal:
    'Empresa Júnior de Ciências e Letras da Universidade Estadual Paulista de Araraquara, associação civil sem fins lucrativos',
  cnpj: '66.996.380/0001-74',
  endereco: 'Rodovia Araraquara/Jaú, KM 1, Machados, 14.800-901, Araraquara - SP',
  cidade: 'Araraquara',
  uf: 'SP',
  email: 'presidencia@paulistajr.com.br',
  telefone: '(16) 99244-9319',
  site: 'www.paulistajr.com.br',
  foro: 'Comarca de Araraquara/SP',
};

const CAMINHO_LOGO = path.join(__dirname, '..', 'assets', 'logo-paulista-jr.png');
// O logo oficial tem o losango em cinza escuro, que praticamente some sobre fundo preto — e capa
// e slide de abertura são justamente escuros. A variante clara troca só o cinza por branco e
// mantém o vermelho intacto: é a mesma marca, legível sobre o fundo certo, não uma segunda marca.
const CAMINHO_LOGO_CLARO = path.join(__dirname, '..', 'assets', 'logo-paulista-jr-claro.png');

const cache = new Map();
function logoBuffer(variante = 'escuro') {
  const caminho = variante === 'claro' ? CAMINHO_LOGO_CLARO : CAMINHO_LOGO;
  if (!cache.has(caminho)) cache.set(caminho, fs.readFileSync(caminho));
  return cache.get(caminho);
}
function logoDataUrl(variante = 'escuro') {
  return 'data:image/png;base64,' + logoBuffer(variante).toString('base64');
}

module.exports = { CORES, FONTES, EMPRESA, CAMINHO_LOGO, CAMINHO_LOGO_CLARO, logoBuffer, logoDataUrl };
