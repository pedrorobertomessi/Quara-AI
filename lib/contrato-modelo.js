// contrato-modelo.js — o contrato de prestação de serviços da Paulista Jr, parametrizado.
//
// O texto abaixo NÃO foi escrito do zero nem gerado por IA: é o contrato que a EJ já usa (o
// modelo assinado com a ABIS), transcrito cláusula a cláusula e com os pontos variáveis trocados
// por parâmetros. Isso é deliberado e é a parte mais importante deste arquivo: um contrato é um
// documento jurídico, e deixar um modelo de linguagem redigir cláusula livremente é como ele
// inventa obrigação que ninguém revisou. Aqui a IA preenche lacunas de um texto revisado; ela não
// escreve direito contratual.
//
// Duas correções conscientes em relação ao documento original:
//
// 1. A numeração é gerada sequencialmente. O modelo original pula da cláusula 13 para a 15, e as
//    referências cruzadas apontam para números errados (a cláusula 28 remete à "Cláusula 9ª" onde
//    deveria remeter ao valor, e o parágrafo único da 25 fala em "cláusula 23"). Aqui cada
//    cláusula recebe seu número na hora e as referências cruzadas são resolvidas por marcador
//    (`{{ref:valor}}`), então elas continuam certas mesmo se alguma cláusula for adicionada.
// 2. Blocos que só fazem sentido em certas condições (parcelamento, CONTRATADA II) só aparecem
//    quando se aplicam, em vez de ficarem no documento com campos em branco.
//
// Formatação: `**negrito**` dentro do texto é interpretado por quem renderiza (docx). Manter o
// texto em markdown simples deixa este arquivo legível e revisável por quem não programa.

const { EMPRESA } = require('./marca');
const { cronogramaParcelas } = require('./financeiro-logic');

const ROMANOS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];

// Campos sem os quais não existe contrato válido. A ferramenta do chat consulta esta lista para
// perguntar o que falta ANTES de gerar qualquer coisa — melhor uma pergunta a mais do que um
// contrato com "[preencher]" no meio indo para a mesa de um cliente.
const CAMPOS_OBRIGATORIOS = [
  { campo: 'contratante.nome', pergunta: 'Qual a razão social (ou nome completo) do contratante?' },
  { campo: 'contratante.documento', pergunta: 'Qual o CNPJ (ou CPF) do contratante?' },
  { campo: 'contratante.endereco', pergunta: 'Qual o endereço completo da sede do contratante?' },
  { campo: 'contratante.representante.nome', pergunta: 'Quem assina pelo contratante (nome completo)?' },
  { campo: 'contratante.representante.cpf', pergunta: 'Qual o CPF de quem assina pelo contratante?' },
  { campo: 'contratante.representante.email', pergunta: 'Qual o e-mail de quem assina pelo contratante?' },
  { campo: 'objeto', pergunta: 'Qual é o objeto do contrato — em uma frase, o que a Paulista Jr vai entregar?' },
  { campo: 'prazoSemanas', pergunta: 'Qual o prazo de vigência, em semanas?' },
  { campo: 'valorTotal', pergunta: 'Qual o valor total do contrato, em reais?' },
  { campo: 'representanteContratada.nome', pergunta: 'Quem assina pela Paulista Jr (nome do presidente em exercício)?' },
  { campo: 'representanteContratada.cpf', pergunta: 'Qual o CPF de quem assina pela Paulista Jr?' },
];

function pegar(obj, caminho) {
  return caminho.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function camposFaltando(dados) {
  return CAMPOS_OBRIGATORIOS.filter(({ campo }) => {
    const v = pegar(dados, campo);
    return v === undefined || v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v));
  });
}

// ---------- Formatação de valores ----------

const UNIDADES = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZENAS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CENTENAS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

// Contrato escreve valor por extenso; sem isso o documento sai com um "[por extenso]" que alguém
// preenche à mão e erra. Cobre até 999.999, que é folgadamente acima de qualquer contrato de EJ.
function porExtenso(n) {
  n = Math.floor(Math.abs(Number(n)));
  if (n < 20) return UNIDADES[n];
  if (n < 100) {
    const d = Math.floor(n / 10);
    const u = n % 10;
    return DEZENAS[d] + (u ? ' e ' + UNIDADES[u] : '');
  }
  if (n === 100) return 'cem';
  if (n < 1000) {
    const c = Math.floor(n / 100);
    const r = n % 100;
    return CENTENAS[c] + (r ? ' e ' + porExtenso(r) : '');
  }
  if (n < 1000000) {
    const m = Math.floor(n / 1000);
    const r = n % 1000;
    const parteMil = m === 1 ? 'mil' : porExtenso(m) + ' mil';
    if (!r) return parteMil;
    // Regra do português: entra "e" depois de "mil" quando o resto é menor que cem (mil e
    // trezentos... não; mil e cinquenta, sim) OU quando é uma centena exata ("seis mil e
    // quinhentos"). Fora esses dois casos, não entra: "seis mil quinhentos e cinquenta".
    const usaE = r < 100 || r % 100 === 0;
    return parteMil + (usaE ? ' e ' : ' ') + porExtenso(r);
  }
  return String(n);
}

function brl(valor) {
  return 'R$ ' + Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function valorPorExtenso(valor) {
  const inteiro = Math.floor(Number(valor));
  const centavos = Math.round((Number(valor) - inteiro) * 100);
  let txt = `${porExtenso(inteiro)} ${inteiro === 1 ? 'real' : 'reais'}`;
  if (centavos > 0) txt += ` e ${porExtenso(centavos)} ${centavos === 1 ? 'centavo' : 'centavos'}`;
  return txt;
}

const MESES_EXTENSO = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function dataPorExtenso(data) {
  const d = data ? new Date(data) : new Date();
  return `${d.getDate()} de ${MESES_EXTENSO[d.getMonth()]} de ${d.getFullYear()}`;
}

// ---------- Montagem do contrato ----------

/**
 * Monta a estrutura do contrato. Devolve blocos (não um .docx) — quem renderiza decide o formato,
 * e o mesmo resultado serve para gerar o Word e para mostrar uma prévia em texto no chat.
 *
 * Blocos: {tipo:'titulo'|'capitulo'|'clausula'|'paragrafo'|'inciso'|'campo'|'espaco'|'assinatura', texto}
 */
function montarContrato(dados) {
  const faltando = camposFaltando(dados);
  if (faltando.length) {
    return { erro: 'campos_faltando', faltando };
  }

  const blocos = [];
  let numeroClausula = 0;
  const refs = {}; // marcador -> número, para resolver referências cruzadas depois

  const add = (tipo, texto) => blocos.push({ tipo, texto });
  const clausula = (texto, marcador) => {
    numeroClausula++;
    if (marcador) refs[marcador] = numeroClausula;
    // As quatro primeiras usam ordinal ("1ª"), como no modelo original; da 10 em diante, cardinal.
    const rotulo = numeroClausula <= 9 ? `CLÁUSULA ${numeroClausula}ª.` : `CLÁUSULA ${numeroClausula}.`;
    add('clausula', `**${rotulo}** ${texto}`);
    return numeroClausula;
  };

  const c = dados.contratante;
  const rep = c.representante;
  const repCt = dados.representanteContratada;
  const parcelado = !!dados.parcelado && Number(dados.numParcelas) > 1;
  const parcelas = parcelado
    ? cronogramaParcelas({
        valorTotal: dados.valorTotal,
        numParcelas: dados.numParcelas,
        diaVencimento: dados.diaVencimento || 15,
        mesPrimeiraParcela: dados.mesPrimeiraParcela,
      })
    : [];

  // ----- Cabeçalho e qualificação -----
  add('titulo', 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS');
  add('espaco', '');

  const naturezaCt = c.naturezaJuridica || (c.documento && c.documento.replace(/\D/g, '').length > 11 ? 'pessoa jurídica de direito privado' : 'pessoa física');
  const docCtRotulo = (c.documento || '').replace(/\D/g, '').length > 11 ? 'CNPJ' : 'CPF';
  add(
    'paragrafo',
    `**CONTRATANTE**: **${c.nome.toUpperCase()}**, ${naturezaCt}, sediada na ${c.endereco}, inscrita no ${docCtRotulo} sob o nº ${c.documento}, neste ato representada por **${rep.nome}**${rep.nacionalidade ? ', ' + rep.nacionalidade : ''}${rep.estadoCivil ? ', ' + rep.estadoCivil : ''}${rep.profissao ? ', ' + rep.profissao : ''}${rep.rg ? ', portador da carteira de identidade nº ' + rep.rg : ''}, e inscrito no CPF sob o nº ${rep.cpf}, portador do endereço eletrônico **${rep.email}**.`
  );
  add(
    'paragrafo',
    `**CONTRATADA**: **${EMPRESA.nome} – ${EMPRESA.descricaoLegal}**, sediada na ${EMPRESA.endereco}, devidamente registrada no cartório de registro civil de pessoas jurídicas de Araraquara – SP, inscrita no CNPJ/MF sob o nº ${EMPRESA.cnpj}, neste ato representada por seu presidente, **${repCt.nome}**, brasileiro(a), ${repCt.estadoCivil || 'solteiro(a)'}, estudante, ${repCt.rg ? 'portador(a) da carteira de identidade nº ' + repCt.rg + ', ' : ''}e inscrito(a) no CPF/MF sob o nº ${repCt.cpf}, portador(a) do endereço eletrônico **${EMPRESA.email}**.`
  );
  add('paragrafo', 'As partes acima identificadas têm, entre si, justo e acertado o presente Contrato, que se regerá pelas cláusulas seguintes e pelas condições descritas abaixo.');

  // ----- Capítulo I — objeto -----
  add('capitulo', 'CAPÍTULO I – DO OBJETO');
  clausula(`É objeto do presente contrato ${dados.objeto}, que será executado pela **CONTRATADA** à **CONTRATANTE**.`, 'objeto');
  const competencias = Array.isArray(dados.competencias) ? dados.competencias.filter(Boolean) : [];
  if (competencias.length) {
    add('paragrafo', '**Parágrafo primeiro.** Compete à **CONTRATADA**:');
    competencias.forEach((t, i) => add('inciso', `**${ROMANOS[i] || i + 1}.** ${t}`));
  }

  // ----- Capítulo II — alterações e comunicações -----
  add('capitulo', 'CAPÍTULO II – DAS ALTERAÇÕES CONTRATUAIS E COMUNICAÇÕES');
  const clAditivo = clausula(
    'Qualquer modificação necessária na execução dos serviços ora contratados somente terá validade se formalizada por escrito, mediante assinatura de representantes legalmente autorizados de ambas as partes, passando a integrar este contrato como Termo Aditivo.',
    'aditivo'
  );
  clausula('Todas as comunicações entre as partes deverão ser realizadas por meio de documento escrito, entregue mediante recibo, ou consignadas em ata devidamente assinada por ambas as partes.');
  clausula(
    `As comunicações e aprovações rotineiras relacionadas à execução do projeto, incluindo o envio de materiais para validação e solicitações de informação, serão consideradas válidas quando realizadas por correio eletrônico (e-mail) indicado pelas partes. Demais modificações, a exemplo de alteração no escopo, no valor ou no prazo de vigência deste contrato, somente terão validade se formalizadas por meio de Termo Aditivo, conforme a Cláusula ${clAditivo}ª.`
  );

  // ----- Capítulo III — obrigações -----
  add('capitulo', 'CAPÍTULO III – DAS OBRIGAÇÕES');
  clausula('A **CONTRATANTE** se obriga a:');
  const obrigacoesContratante = [
    'Fornecer, sempre que solicitado pela **CONTRATADA**, todas as informações e documentos necessários para a plena execução do serviço;',
    'Realizar o pagamento conforme disposto no presente contrato;',
    'Participar, quando solicitado em até 48 (quarenta e oito) horas antes pela **CONTRATADA**, das reuniões referentes ao objeto do presente instrumento;',
    'Manter em sigilo todas as informações e documentos produzidos para a concretização do presente objeto, nos termos deste contrato, em respeito à propriedade intelectual e à Lei nº 13.709/2018 (LGPD);',
    `Aprovar, rejeitar ou sugerir mudanças no projeto em até ${dados.prazoAprovacaoDiasUteis || 10} (${porExtenso(dados.prazoAprovacaoDiasUteis || 10)}) dias úteis após a data de entrega;`,
    'Avisar com, no mínimo, 24 (vinte e quatro) horas de antecedência caso precise cancelar uma reunião ou visita da **CONTRATADA**;',
    'Pagar taxas e despesas, quando necessárias, referentes à execução do serviço em órgãos públicos e privados, incluindo o ISS, cujo valor será descontado do pagamento acordado neste contrato, devendo a **CONTRATANTE** enviar a Nota Fiscal para comprovar a quitação do imposto e o respectivo valor;',
    'Responder, no prazo de até 3 (três) dias úteis contados do recebimento dos serviços, ao questionário de satisfação do cliente (NPS – Net Promoter Score) enviado pela **CONTRATADA**, resposta que integra as práticas de melhoria contínua da qualidade dos serviços prestados, não constituindo condição para o aceite formal ou encerramento do projeto.',
  ];
  obrigacoesContratante.forEach((t, i) => add('inciso', `**${ROMANOS[i]}** – ${t}`));

  clausula('A **CONTRATADA** se obriga a:');
  const emailsNF = (dados.emailsNotaFiscal && dados.emailsNotaFiscal.length ? dados.emailsNotaFiscal : [rep.email]).join(' e ');
  const obrigacoesContratada = [
    'Prestar o serviço estipulado na Cláusula 1ª à **CONTRATANTE**, empregando seus melhores esforços na execução do mesmo;',
    'Efetuar o levantamento e analisar os dados relevantes ao desenvolvimento do serviço;',
    'Admitir que a **CONTRATANTE** realize perguntas e solicite informações quanto ao desenvolvimento do objeto deste contrato;',
    'Zelar pelo sigilo e confidencialidade das informações necessárias para a realização do serviço, em conformidade com a Lei nº 13.709/2018 (LGPD);',
    `Fornecer a correspondente Nota Fiscal de Serviço à **CONTRATANTE**, a ser emitida após a conclusão do projeto ou conforme o recebimento de cada parcela, de acordo com a legislação fiscal vigente, enviando-a para o(s) e-mail(s): **${emailsNF}**;`,
    'Fornecer à **CONTRATANTE** Termo de Quitação, Parcial ou Total, quando houver o cumprimento da obrigação, sendo o Parcial entregue pelo cumprimento de um dos serviços contratados, quando mais de um, e o Total quando houver o cumprimento total dos serviços contratados;',
    'Observar, nas obrigações aqui delimitadas, o que determina o art. 421-A do Código Civil Brasileiro, a fim de preservar o princípio da paridade das partes.',
  ];
  obrigacoesContratada.forEach((t, i) => add('inciso', `**${ROMANOS[i]}** – ${t}`));

  // ----- Capítulo IV — prazos -----
  add('capitulo', 'CAPÍTULO IV – DOS PRAZOS');
  clausula(
    `O presente contrato terá vigência de ${dados.prazoSemanas} (${porExtenso(dados.prazoSemanas)}) semanas, contadas a partir da data de sua assinatura pelas Partes, podendo ser prorrogado mediante assinatura de Termo Aditivo, por mútuo acordo.`
  );
  add('paragrafo', '**Parágrafo único.** Na ocasião em que houver descumprimento, por parte da **CONTRATANTE**, das obrigações pactuadas no presente contrato, excluir-se-á a responsabilidade da **CONTRATADA** por eventual atraso no prazo de execução do objeto do contrato.');
  clausula('Na assinatura deste contrato, a **CONTRATANTE** deverá fornecer à **CONTRATADA** toda a documentação necessária para o desenvolvimento das Etapas e Fases de Execução, quando aplicável, sendo previamente informada dessa necessidade. A não entrega da documentação será motivo suficiente para a suspensão do início da contagem do prazo de prestação dos serviços.');
  clausula('A aceitação, pela **CONTRATANTE**, dos resultados produzidos em cada etapa do projeto, dentro do prazo estipulado, é condição indispensável para o início da etapa subsequente. Será presumida a aceitação caso o prazo de resposta seja ultrapassado ou se houver comportamento, ainda que tácito, que revele concordância com a etapa anterior.');
  clausula('Caso o prazo para manifestação da **CONTRATANTE** se esgote por atraso ou omissão desta, a **CONTRATADA** poderá prosseguir com os serviços conforme o que tiver sido previamente ajustado, considerando quitada e aceita a etapa anterior.');
  add('paragrafo', '**Parágrafo único.** Na impossibilidade de dar andamento às etapas seguintes, a **CONTRATADA** poderá considerar suspenso o prazo para a entrega final dos serviços, retomando-o assim que possível o prosseguimento das atividades necessárias.');
  clausula('A aceitação deverá ser formalizada pela **CONTRATANTE** por meio de notificação enviada por e-mail ou mediante assinatura de documentos fornecidos pela **CONTRATADA**, observados os termos desta cláusula. A aprovação de uma etapa não implicará, por si só, a aprovação automática de etapas ou projetos complementares.');

  // ----- Capítulo V — etapas -----
  const etapas = Array.isArray(dados.etapas) ? dados.etapas.filter(Boolean) : [];
  if (etapas.length) {
    add('capitulo', 'CAPÍTULO V – DAS ETAPAS E FASES DE EXECUÇÃO');
    clausula('A execução do objeto deste contrato será desenvolvida em etapas sucessivas, conforme cronograma abaixo:');
    etapas.forEach((t, i) => add('inciso', `**${ROMANOS[i] || i + 1}.** ${t}`));
  }

  // ----- Capítulo VI — custo e pagamento -----
  add('capitulo', `CAPÍTULO ${etapas.length ? 'VI' : 'V'} – DO CUSTO E PAGAMENTO`);
  const clValor = clausula('A **CONTRATANTE** pagará à **CONTRATADA** o valor total bruto estabelecido nesta cláusula, conforme as especificações e condições de pagamento aqui descritas.', 'valor');
  add('campo', `**Valor total:** ${brl(dados.valorTotal)} (${valorPorExtenso(dados.valorTotal)})`);
  add('campo', `**Forma de pagamento:** ${dados.formaPagamento || 'Pix ou boleto'}`);
  add('campo', `**O pagamento será:** ${parcelado ? '(  ) à vista   ( X ) parcelado' : '( X ) à vista   (  ) parcelado'}`);
  if (parcelado) {
    add('campo', `**Número de parcelas:** ${parcelas.length} (${porExtenso(parcelas.length)}) parcelas`);
    add('campo', `**Data de vencimento de cada parcela:** as parcelas deverão ser pagas todo dia ${dados.diaVencimento || 15}.`);
    // O modelo original trazia um único "valor de cada parcela" — o que só funciona quando a
    // divisão é exata. Aqui as parcelas vêm do mesmo cronograma usado na projeção de caixa, com o
    // resto concentrado na última, então a soma sempre fecha com o valor total.
    const iguais = parcelas.every((p) => p.valor === parcelas[0].valor);
    if (iguais) {
      add('campo', `**Valor de cada parcela:** ${brl(parcelas[0].valor)} (${valorPorExtenso(parcelas[0].valor)})`);
    } else {
      add('campo', `**Valor das parcelas:** ${parcelas.length - 1} parcelas de ${brl(parcelas[0].valor)} e 1 parcela final de ${brl(parcelas[parcelas.length - 1].valor)}, totalizando ${brl(dados.valorTotal)}.`);
    }
  } else {
    add('campo', `**Vencimento:** ${dados.vencimentoAVista || 'em até 10 (dez) dias corridos contados da assinatura deste contrato.'}`);
  }
  const emailsBoleto = (dados.emailsBoleto && dados.emailsBoleto.length ? dados.emailsBoleto : [rep.email]).join(' e ');
  add('campo', `**E-mail para envio de boletos:** ${emailsBoleto}`);

  if (parcelado) {
    clausula('No caso de pagamento parcelado, as parcelas obedecerão aos vencimentos fixados nesta cláusula.');
    add('paragrafo', '**Parágrafo único.** Caso a **CONTRATANTE** não receba a transferência via Pix, ou, por qualquer motivo, enfrente dificuldades que impeçam o pagamento por tal meio, deverá contatar imediatamente a **CONTRATADA** para que seja autorizado outro meio de pagamento. Nessa hipótese, o boleto original deverá ser resgatado ou cancelado.');
  }
  clausula('A **CONTRATANTE** reembolsará à **CONTRATADA** todas as despesas extraordinárias devidamente comprovadas, incluindo, mas não se limitando a, custos de deslocamentos adicionais, desde que apresentadas em até 5 (cinco) dias úteis após a ciência do pedido de reembolso, formalizado por telefone celular ou e-mail.');
  add('paragrafo', '**Parágrafo único.** Para efeito do reembolso mencionado no caput, a **CONTRATADA** deverá demonstrar a necessidade do gasto e apresentar recibo ou documento fiscal comprobatório dos valores a serem ressarcidos.');
  const multaAtraso = dados.multaAtrasoPct ?? 5;
  const jurosMes = dados.jurosMesPct ?? 0.5;
  clausula(
    `Ocorrendo atraso no pagamento por parte da **CONTRATANTE** superior a 5 (cinco) dias úteis, incidirá multa de ${multaAtraso}% (${porExtenso(multaAtraso)} por cento) sobre o valor total da parcela em atraso, acrescida de juros proporcionais de ${String(jurosMes).replace('.', ',')}% (${jurosMes === 0.5 ? 'meio' : porExtenso(jurosMes)} por cento) ao mês.`
  );

  // ----- Capítulo VII — propriedade, sigilo, LGPD -----
  add('capitulo', `CAPÍTULO ${etapas.length ? 'VII' : 'VI'} – DOS DIREITOS À PROPRIEDADE, SIGILO E PROTEÇÃO DE DADOS`);
  clausula('Caso ocorra resultado de invenção, descobertas, aperfeiçoamentos, inovações ou qualquer tipo de criação intelectual derivado do projeto tratado no presente instrumento, pertencerão os direitos de propriedade à **CONTRATADA** e aos autores da prestação de serviço que gerou o desenvolvimento tecnológico, invenção, descoberta, aperfeiçoamento ou inovação, nos termos da legislação aplicável.');
  clausula('A equipe envolvida neste projeto se compromete a manter sigilo e confidencialidade sobre os dados e informações decorrentes da consecução do presente contrato, salvo se a **CONTRATANTE** autorizar, por escrito, em contrário.');
  clausula('As partes se comprometem a adotar medidas de segurança, técnicas e administrativas, com o fito de proteger os dados coletados, conforme o artigo 46 da Lei Geral de Proteção de Dados Pessoais – Lei nº 13.709/2018 (LGPD).');

  if (dados.autorizaDivulgacao !== false) {
    clausula('A **CONTRATANTE** autoriza expressamente a divulgação, pela **CONTRATADA**, do nome da **CONTRATANTE** como sua cliente, sem nenhum ônus à **CONTRATADA**, em material promocional ou institucional, tal como reportagens jornalísticas, apresentação de cases, palestras em eventos e no site da **CONTRATADA**.');
  }
  add('paragrafo', '**Parágrafo primeiro.** A **CONTRATADA** somente receberá a quantidade de informações necessárias e suficientes para a concretização de seus serviços, de modo que é vedada a requisição de dados que não possuam relação direta com a execução do objeto do contrato.');
  add('paragrafo', '**Parágrafo segundo.** A **CONTRATADA** deverá utilizar os dados recebidos exclusivamente para a concretização do serviço, de forma que é expressamente vedado o tratamento para finalidades distintas, mesmo que ausente vantagem econômica, assim como o compartilhamento com terceiros, em razão de configurar desvio de finalidade, vedado pelo art. 6º, inciso I, da Lei Geral de Proteção de Dados.');
  clausula('As partes, por si e por seus colaboradores e/ou voluntários, obrigam-se a atuar no presente Contrato em conformidade com a Lei Geral de Proteção de Dados Pessoais (LGPD), Lei nº 13.709/2018, e com as determinações da Autoridade Nacional de Proteção de Dados (ANPD).');
  clausula('A parte que, por imprudência, negligência, imperícia, dolo ou má-fé, utilizar indevidamente as informações a que tem acesso, provocando qualquer vazamento de dados ou outra infração à legislação pertinente, será única e integralmente responsável pelos danos causados, para os fins deste Contrato.');
  clausula('As partes devem registrar e arquivar as aquiescências dos titulares de qualquer dado pessoal que estiver no escopo da base legal do “consentimento do titular” (art. 5º, VII, da LGPD) e for compartilhado na execução do presente contrato, sob pena de ser unicamente responsável pelas consequências administrativas e/ou judiciais de não deter tal anuência.');
  const multaIncidente = dados.multaIncidenteDiaria ?? 200;
  const clIncidente = clausula(
    `A **CONTRATADA** deverá comunicar à **CONTRATANTE**, em até 2 (dois) dias úteis após a identificação, a ocorrência de qualquer incidente de segurança relacionado ao tratamento de dados pessoais objeto do presente contrato, sob pena de multa diária de ${brl(multaIncidente)} (${valorPorExtenso(multaIncidente)}).`
  );
  add('paragrafo', `**Parágrafo único.** Qualquer comunicação de que trata o caput da Cláusula ${clIncidente} deverá ser feita por e-mail.`);
  clausula('A **CONTRATANTE** declara-se ciente e concorda que a **CONTRATADA**, em decorrência do presente contrato, poderá compartilhar, de forma eletrônica e manual, informações e dados prestados pela **CONTRATANTE**, consistentes em dados financeiros, de estoque, de produção, compras, vendas, indicadores gerais da empresa, metas gerais, entre diversos outros possíveis dados, com discentes e docentes do Departamento de Ciências e Letras da Universidade Estadual Paulista de Araraquara, exclusivamente para fins específicos de execução do objeto do presente instrumento e do desenvolvimento de atividades acadêmicas do referido Departamento.');
  add('paragrafo', '**Parágrafo primeiro.** A **CONTRATANTE** poderá, a qualquer tempo, solicitar que as informações e dados a que se refere o caput desta cláusula deixem de ser compartilhados.');
  add('paragrafo', '**Parágrafo segundo.** Mesmo com a extinção do presente contrato, o compartilhamento dos dados poderá continuar a ocorrer somente para fins acadêmicos, salvo na situação que dispõe o parágrafo anterior.');
  add('paragrafo', '**Parágrafo terceiro.** A **CONTRATADA** se obriga a seguir todas as disposições da Lei Geral de Proteção de Dados e as regulamentações da Autoridade Nacional de Proteção de Dados no que se refere à prática dos atos estipulados no caput desta cláusula.');

  // ----- Capítulo VIII — rescisão -----
  add('capitulo', `CAPÍTULO ${etapas.length ? 'VIII' : 'VII'} – DA RESCISÃO`);
  const avisoDias = dados.prazoAvisoRescisaoDias ?? 30;
  const multaRescisao = dados.multaRescisaoPct ?? 15;
  clausula(
    `Havendo interesse em sua rescisão, de forma unilateral e respaldada em justificativa plausível, a parte interessada deverá informar à parte contrária, por escrito, em endereço eletrônico disponibilizado, com antecedência mínima de ${avisoDias} (${porExtenso(avisoDias)}) dias corridos.`
  );
  add(
    'paragrafo',
    `**Parágrafo único.** A rescisão injustificada do presente contrato por qualquer das partes implicará o pagamento de cláusula penal de ${multaRescisao}% (${porExtenso(multaRescisao)} por cento) do valor total do presente contrato, devidamente atualizado pelo IGP-M, somado ao pagamento proporcional dos serviços até então executados pela **CONTRATADA**.`
  );
  clausula(
    `Finalizada a prestação do serviço, não será admitida a rescisão do contrato por iniciativa exclusiva da **CONTRATANTE**, sendo devida a remuneração referente ao valor estabelecido na Cláusula ${refs.valor}, na integralidade.`
  );
  clausula('Em caso de interesse mútuo, o presente contrato poderá ser extinto mediante termo de distrato anexo a este contrato, sem ônus para qualquer das partes, conforme disposto no art. 472 do Código Civil.');
  clausula('Sendo rescindido o Contrato no curso da prestação de serviço, a **CONTRATANTE** deverá fornecer à **CONTRATADA** o pagamento dos valores correspondentes ao proporcional das etapas do serviço já realizadas até a data da rescisão.');
  clausula('Em caso de descumprimento, pela **CONTRATADA**, das obrigações listadas neste Contrato, cabe à **CONTRATANTE** rescindi-lo, não sendo esta obrigada a pagar nada pelo que foi realizado pela **CONTRATADA** a partir do momento da inadimplência.');
  add('paragrafo', '**Parágrafo único.** Não haverá ressarcimento à **CONTRATANTE** do proporcional do serviço prestado e etapas concluídas e entregues pela **CONTRATADA** anteriormente ao descumprimento que motivou a rescisão.');

  // ----- Capítulo IX — disposições gerais -----
  add('capitulo', `CAPÍTULO ${etapas.length ? 'IX' : 'VIII'} – DAS DISPOSIÇÕES GERAIS`);
  clausula('Fica pactuada entre as partes a total inexistência de vínculo trabalhista entre as partes contratantes, excluindo as obrigações previdenciárias e os encargos sociais, não havendo entre **CONTRATADA** e **CONTRATANTE** qualquer tipo de relação de subordinação.');
  clausula('Não implicará renúncia ou novação eventual tolerância por qualquer das partes no sentido de deixar de exigir o cumprimento de algum dispositivo contratual.');
  clausula('As obrigações contratuais valem para os herdeiros e sucessores.');
  clausula('A invalidade de qualquer dispositivo deste instrumento não implicará nulidade dos termos e dispositivos remanescentes.');
  clausula('O Contrato poderá sofrer alterações em seu objeto, prazos, valores e demais dispositivos, de comum acordo, mediante assinatura de termo aditivo a ser elaborado pela **CONTRATADA**, o qual será revestido das mesmas formalidades do presente instrumento.');
  clausula('A contratação de novos serviços ou a renovação deste Contrato exigirá a elaboração e assinatura de um novo contrato ou termo aditivo.');
  clausula('A **CONTRATADA** poderá ceder ou transferir, no todo ou em parte, direitos e obrigações decorrentes deste instrumento, bem como subcontratar outras empresas para prestar os serviços ora pactuados, desde que obtenha autorização prévia e por escrito da **CONTRATANTE**.');

  // ----- Capítulo X — foro -----
  add('capitulo', `CAPÍTULO ${etapas.length ? 'X' : 'IX'} – DO FORO`);
  clausula(
    `As partes elegem o Foro da ${dados.foro || EMPRESA.foro} para dirimir toda e qualquer controvérsia decorrente deste Contrato, em detrimento de qualquer outro, por mais privilegiado que seja.`
  );

  add('paragrafo', 'Por estarem as partes de pleno acordo com o disposto neste instrumento particular, assinam-no de forma física, reconhecendo a sua validade jurídica, juntamente com duas testemunhas, para que surta os seus efeitos legais e jurídicos.');
  add('espaco', '');
  add('paragrafo', `${dados.cidadeAssinatura || EMPRESA.cidade}/${EMPRESA.uf}, ${dataPorExtenso(dados.dataAssinatura)}.`);

  // ----- Assinaturas -----
  const testemunhas = Array.isArray(dados.testemunhas) ? dados.testemunhas.filter((t) => t && t.nome) : [];
  blocos.push({
    tipo: 'assinaturas',
    contratada: { titulo: 'CONTRATADA', empresa: EMPRESA.nome, nome: repCt.nome, cargo: repCt.cargo || 'Diretor(a) Presidente da Paulista Jr.', cpf: repCt.cpf },
    contratante: { titulo: 'CONTRATANTE', empresa: c.nome, nome: rep.nome, cargo: rep.cargo || '', cpf: rep.cpf },
    testemunhas,
  });

  return {
    blocos,
    resumo: {
      contratante: c.nome,
      objeto: dados.objeto,
      valorTotal: Number(dados.valorTotal),
      parcelas: parcelado ? parcelas : null,
      prazoSemanas: Number(dados.prazoSemanas),
      totalClausulas: numeroClausula,
      totalEtapas: etapas.length,
    },
  };
}

module.exports = { montarContrato, camposFaltando, CAMPOS_OBRIGATORIOS, porExtenso, valorPorExtenso, brl, dataPorExtenso };
