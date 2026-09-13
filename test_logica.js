// test_logica.js — testa a lógica que não precisa de banco nem de rede: a matemática das
// projeções, a montagem do contrato, a resolução de tribunal a partir do número CNJ e os
// utilitários de web.
//
// Roda sem DATABASE_URL e sem chave nenhuma de propósito. É o conjunto de testes que continua
// passando num notebook sem Postgres instalado e sem internet — e é justamente onde moram as
// contas que, se errarem, erram em silêncio: uma projeção com o sinal trocado não quebra nada,
// só entrega um número errado com cara de certo.

const fin = require('./lib/financeiro-logic');
const { montarContrato, camposFaltando, porExtenso, valorPorExtenso } = require('./lib/contrato-modelo');
const { resolverTribunal } = require('./tools/datajud');
const { htmlParaTexto, ehIpPrivado } = require('./tools/web');

const results = [];
function assert(cond, msg) {
  results.push({ ok: !!cond, msg });
  console.log((cond ? 'OK: ' : 'FAIL: ') + msg);
}
const perto = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// Datas em UTC porque chaveMes lê os componentes UTC — construir com Date.UTC evita que o teste
// passe ou falhe conforme o fuso da máquina que o roda.
const mes = (ano, m, dia = 15) => Date.UTC(ano, m - 1, dia);

console.log('--- helpers de mês ---');
assert(fin.chaveMes(mes(2026, 3)) === '2026-03', 'chaveMes formata AAAA-MM');
assert(fin.mesSomar('2026-11', 3) === '2027-02', 'mesSomar atravessa a virada do ano');
assert(fin.mesSomar('2026-01', -2) === '2025-11', 'mesSomar aceita deslocamento negativo');
assert(fin.mesDiff('2027-02', '2026-11') === 3, 'mesDiff conta meses entre chaves');
assert(fin.rotuloMes('2026-09') === 'set/26', 'rotuloMes abrevia o mês em português');

console.log('\n--- série mensal ---');
const serie = fin.serieMensal([
  { valor: 1000, data: mes(2026, 1) },
  { valor: 500, data: mes(2026, 1, 20) },
  { valor: 2000, data: mes(2026, 3) },
]);
assert(serie.length === 3, 'Série cobre todos os meses do intervalo, inclusive os vazios — got ' + serie.length);
assert(serie[0].valor === 1500, 'Vendas do mesmo mês são somadas');
assert(serie[1].mes === '2026-02' && serie[1].valor === 0, 'Mês sem venda entra como zero em vez de sumir');

console.log('\n--- regressão linear ---');
const reg = fin.regressaoLinear([10, 20, 30, 40]);
assert(perto(reg.b, 10, 0.001), 'Inclinação de uma série perfeitamente linear é exata — got ' + reg.b);
assert(perto(reg.sigma, 0, 0.001), 'Sem ruído, o desvio dos resíduos é zero');
assert(perto(reg.prever(4), 50, 0.001), 'Previsão do próximo ponto segue a reta');

console.log('\n--- projeção de faturamento ---');
const semDados = fin.projetarFaturamento([]);
assert(semDados.metodo === 'sem-dados' && semDados.projecao.length === 0, 'Sem histórico, não inventa projeção');
assert(typeof semDados.aviso === 'string', 'Sem histórico, explica por que não dá para projetar');

const historicoCurto = [
  { valor: 5000, data: mes(2026, 1) },
  { valor: 6000, data: mes(2026, 2) },
  { valor: 7000, data: mes(2026, 3) },
];
const curta = fin.projetarFaturamento(historicoCurto, { meses: 3, mesReferencia: '2026-03' });
assert(/média/i.test(curta.metodo), 'Com 3 meses usa média, não tendência — got: ' + curta.metodo);
assert(curta.confianca === 'baixa', 'Histórico curto é declarado como confiança baixa');
assert(typeof curta.aviso === 'string' && curta.aviso.length > 0, 'Histórico curto vem com aviso explícito');
assert(curta.projecao.length === 3 && curta.projecao[0].mes === '2026-04', 'Projeção começa no mês seguinte ao de referência');

const historicoLongo = Array.from({ length: 12 }, (_, i) => ({ valor: 5000 + i * 500, data: mes(2026, i + 1) }));
const longa = fin.projetarFaturamento(historicoLongo, { meses: 6, mesReferencia: '2026-12' });
assert(/regressão/i.test(longa.metodo), 'Com 12 meses usa regressão — got: ' + longa.metodo);
assert(longa.confianca === 'boa', 'Doze meses de histórico dão confiança "boa"');
assert(longa.projecao[0].base > longa.mediaMensalHistorica, 'Tendência de alta projeta acima da média histórica');
assert(
  longa.projecao.every((p) => p.conservador <= p.base && p.base <= p.otimista),
  'Cenários vêm sempre ordenados: conservador ≤ base ≤ otimista'
);
assert(longa.projecao.every((p) => p.conservador >= 0), 'Cenário conservador nunca fica negativo');

const comPremissa = fin.projetarFaturamento(historicoCurto, { meses: 2, mesReferencia: '2026-03', crescimentoMensalPct: 10 });
assert(/10%/.test(comPremissa.metodo) && comPremissa.confianca === 'premissa', 'Premissa de crescimento informada substitui a tendência e é declarada como premissa');
assert(perto(comPremissa.projecao[0].base, 7700, 1), 'Crescimento de 10% sobre o último mês (7000) dá 7700 — got ' + comPremissa.projecao[0].base);

console.log('\n--- parcelamento ---');
const parcelas = fin.cronogramaParcelas({ valorTotal: 6500, numParcelas: 3, diaVencimento: 15, mesPrimeiraParcela: '2026-10' });
assert(parcelas.length === 3, 'Gera o número pedido de parcelas');
assert(perto(parcelas.reduce((a, p) => a + p.valor, 0), 6500, 0.001), 'A soma das parcelas bate exatamente com o total (o resto vai na última)');
assert(parcelas[2].valor >= parcelas[0].valor, 'O resto da divisão fica concentrado na última parcela');
assert(parcelas[1].mes === '2026-11', 'Cada parcela cai no mês seguinte à anterior');
const parcelaUnica = fin.cronogramaParcelas({ valorTotal: 1000, numParcelas: 1, mesPrimeiraParcela: '2026-10' });
assert(parcelaUnica.length === 1 && parcelaUnica[0].valor === 1000, 'À vista gera uma parcela com o valor cheio');

console.log('\n--- projeção de caixa ---');
const caixa = fin.projetarCaixa({
  saldoInicial: 10000,
  mesReferencia: '2026-09',
  meses: 4,
  lancamentos: [
    { tipo: 'saida', descricao: 'custo fixo', valor: 3000, mes: '2026-10', recorrencia: 'mensal' },
    { tipo: 'entrada', descricao: 'parcela contratada', valor: 1300, mes: '2026-10', recorrencia: 'mensal', ateMes: '2026-11' },
  ],
  entradasProjetadas: [{ mes: '2026-12', valor: 8000 }],
});
assert(caixa.fluxo.length === 4, 'Fluxo cobre o horizonte pedido');
assert(caixa.fluxo[0].saidas === 3000 && caixa.fluxo[3].saidas === 3000, 'Lançamento mensal em aberto incide em todos os meses');
assert(caixa.fluxo[0].entradasFirmes === 1300 && caixa.fluxo[2].entradasFirmes === 0, 'Lançamento mensal com ateMes para de incidir depois do limite');
assert(caixa.fluxo[2].entradasProjetadas === 8000, 'Entrada projetada entra no mês certo');
assert(
  caixa.fluxo[0].entradasProjetadas === 0 && caixa.fluxo[0].resultadoFirme === -1700,
  'Resultado firme ignora as entradas projetadas — got ' + caixa.fluxo[0].resultadoFirme
);
assert(caixa.fluxo[0].saldoFinal === 8300, 'Saldo final do mês 1: 10000 - 3000 + 1300 — got ' + caixa.fluxo[0].saldoFinal);
assert(caixa.fluxo[1].saldoInicial === 8300, 'O saldo final de um mês é o inicial do seguinte');
assert(caixa.mesesDeFolgaSemVendasNovas === 4, 'Com saldo suficiente, a folga cobre todo o horizonte — got ' + caixa.mesesDeFolgaSemVendasNovas);

const caixaApertado = fin.projetarCaixa({
  saldoInicial: 1000,
  mesReferencia: '2026-09',
  meses: 3,
  lancamentos: [{ tipo: 'saida', descricao: 'custo fixo', valor: 3000, mes: '2026-10', recorrencia: 'mensal' }],
});
assert(caixaApertado.primeiroMesNegativo === '2026-10', 'Identifica o primeiro mês em que o caixa vira negativo');
assert(caixaApertado.mesesDeFolgaSemVendasNovas === 0, 'Sem vendas novas e sem saldo, a folga é zero');

console.log('\n--- ponto de equilíbrio ---');
const pe = fin.pontoDeEquilibrio({ custoFixoMensal: 6500, margemContribuicaoPct: 65 });
assert(pe.faturamentoNecessarioMensal === 10000, '6500 de custo fixo com 65% de margem exige 10000 de faturamento — got ' + pe.faturamentoNecessarioMensal);
assert(fin.pontoDeEquilibrio({ custoFixoMensal: 1000, margemContribuicaoPct: 0 }).erro, 'Margem zero devolve erro em vez de dividir por zero');

console.log('\n--- valores por extenso ---');
assert(porExtenso(6500) === 'seis mil e quinhentos', 'Escreve 6500 por extenso — got ' + porExtenso(6500));
assert(porExtenso(15) === 'quinze', 'Escreve números abaixo de vinte');
assert(porExtenso(100) === 'cem' && porExtenso(101) === 'cento e um', 'Distingue cem de cento e um');
assert(valorPorExtenso(1300).startsWith('mil e trezentos reais'), 'Valor monetário por extenso — got ' + valorPorExtenso(1300));
assert(/centavos/.test(valorPorExtenso(1300.5)), 'Centavos aparecem quando existem');

console.log('\n--- contrato: campos obrigatórios ---');
assert(camposFaltando({}).length > 0, 'Contrato vazio acusa campos faltando');
const dadosContrato = {
  contratante: {
    nome: 'Empresa Exemplo Ltda',
    documento: '12.345.678/0001-90',
    endereco: 'Rua Teste, 100, Araraquara-SP',
    representante: { nome: 'Fulano de Tal', cpf: '111.222.333-44', email: 'fulano@exemplo.com.br' },
  },
  representanteContratada: { nome: 'Presidente da Vez', cpf: '456.611.958-00' },
  objeto: 'estruturar uma análise de mercado do setor X',
  competencias: ['Mapear a indústria', 'Validar CNAEs'],
  etapas: ['Mapeamento', 'Análise', 'Relatório final'],
  prazoSemanas: 10,
  valorTotal: 6500,
  parcelado: true,
  numParcelas: 5,
  diaVencimento: 15,
  mesPrimeiraParcela: '2026-10',
  testemunhas: [{ nome: 'Testemunha Um', cpf: '000.000.000-00' }],
};
assert(camposFaltando(dadosContrato).length === 0, 'Conjunto completo de dados não acusa falta');
const semValor = { ...dadosContrato, valorTotal: undefined };
assert(
  camposFaltando(semValor).some((f) => f.campo === 'valorTotal' && f.pergunta.includes('valor total')),
  'Campo faltando vem com a pergunta pronta para fazer à pessoa'
);

console.log('\n--- contrato: montagem ---');
const montado = montarContrato(dadosContrato);
assert(!montado.erro, 'Contrato completo é montado sem erro');
const texto = montado.blocos.map((b) => b.texto || '').join('\n');
assert(/CONTRATO DE PRESTAÇÃO DE SERVIÇOS/.test(texto), 'Tem o título do instrumento');
assert(texto.includes('Empresa Exemplo Ltda'.toUpperCase()), 'Qualifica o contratante com o nome informado');
assert(texto.includes('66.996.380/0001-74'), 'Traz o CNPJ da Paulista Jr como contratada');
assert(/R\$ 6\.500,00 \(seis mil e quinhentos reais\)/.test(texto), 'Valor total aparece em número e por extenso');
assert(/5 \(cinco\) parcelas/.test(texto), 'Número de parcelas por extenso');
assert(/\( X \) parcelado/.test(texto), 'Marca a opção parcelado quando é o caso');
assert(/Comarca de Araraquara\/SP/.test(texto), 'Foro padrão é o da EJ');
assert(montado.resumo.parcelas.length === 5, 'Resumo devolve o cronograma de parcelas');

// A numeração sequencial é o principal desvio consciente em relação ao documento original (que
// pula da cláusula 13 para a 15). Se ela voltar a ter buracos, a referência cruzada da cláusula de
// rescisão passa a apontar para a cláusula errada — e isso é um defeito jurídico, não cosmético.
const numeros = texto.match(/CLÁUSULA (\d+)/g).map((s) => Number(s.replace(/\D/g, '')));
assert(
  numeros.every((n, i) => n === i + 1),
  'Cláusulas são numeradas sem buracos, de 1 até o fim — got: ' + numeros.join(',')
);
const refRescisao = /valor estabelecido na Cláusula (\d+)/.exec(texto);
assert(refRescisao && numeros.includes(Number(refRescisao[1])), 'A referência cruzada da rescisão aponta para uma cláusula que existe');

const aVista = montarContrato({ ...dadosContrato, parcelado: false, numParcelas: 1 });
const textoAVista = aVista.blocos.map((b) => b.texto || '').join('\n');
assert(/\( X \) à vista/.test(textoAVista), 'Pagamento à vista marca a opção correta');
assert(!/parcelas deverão ser pagas/.test(textoAVista), 'À vista não deixa cláusula de parcelamento sobrando no documento');

console.log('\n--- DataJud: resolução de tribunal ---');
assert(resolverTribunal('1089242-85.2016.8.26.0100').alias === 'tjsp', 'Número 8.26 resolve para o TJSP');
assert(resolverTribunal('0000832-35.2018.4.01.3202').alias === 'trf1', 'Número 4.01 resolve para o TRF1');
assert(resolverTribunal('00008323520188130024').alias === 'tjmg', 'Aceita número sem pontuação e resolve TJMG');
assert(resolverTribunal('0001234-56.2020.5.15.0001').alias === 'trt15', 'Número 5.15 resolve para o TRT da 15ª');
assert(resolverTribunal('0001234-56.2020.8.19.0001').alias === 'tjrj', 'Número 8.19 resolve para o TJRJ');
assert(resolverTribunal('0001234-56.2020.6.26.0001').alias === 'tre-sp', 'Número 6.26 resolve para o TRE-SP');
let erroNumero = null;
try {
  resolverTribunal('123');
} catch (e) {
  erroNumero = e.message;
}
assert(erroNumero && /20 dígitos/.test(erroNumero), 'Número curto demais é recusado com explicação');
let erroSegmento = null;
try {
  resolverTribunal('0001234-56.2020.1.00.0000');
} catch (e) {
  erroSegmento = e.message;
}
assert(erroSegmento && /STF/.test(erroSegmento), 'Segmento fora da base pública explica que STF/CNJ não estão no DataJud');

console.log('\n--- web: utilitários ---');
assert(htmlParaTexto('<p>Olá <b>mundo</b></p><script>alert(1)</script>') === 'Olá mundo', 'Extrai texto e descarta script — got: ' + JSON.stringify(htmlParaTexto('<p>Olá <b>mundo</b></p><script>alert(1)</script>')));
assert(htmlParaTexto('a &amp; b &nbsp;c') === 'a & b c', 'Desescapa entidades HTML');
assert(ehIpPrivado('127.0.0.1') && ehIpPrivado('10.1.2.3') && ehIpPrivado('192.168.0.1'), 'Reconhece faixas privadas IPv4');
assert(ehIpPrivado('169.254.169.254'), 'Reconhece o link-local usado por metadata service de nuvem');
assert(!ehIpPrivado('8.8.8.8') && !ehIpPrivado('200.160.2.3'), 'Não bloqueia IP público');
assert(ehIpPrivado('::1') && !ehIpPrivado('2001:4860:4860::8888'), 'Trata IPv6 local e público corretamente');

const falhas = results.filter((r) => !r.ok);
console.log('\n=== RESULT ===');
if (falhas.length) {
  console.log(`${falhas.length} CHECK(S) FAILED de ${results.length}`);
  process.exit(1);
}
console.log(`ALL ${results.length} CHECKS PASSED`);
