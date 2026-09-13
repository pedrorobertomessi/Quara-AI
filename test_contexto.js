// test_contexto.js — verifica a poda do histórico do chat.
//
// É o teste da correção que resolveu o chat "caindo" depois de algumas mensagens: o histórico
// crescia sem limite e cada mensagem reenviava tudo, até estourar a cota de tokens da API. As duas
// coisas que precisam ser verdade ao mesmo tempo aqui: (1) o histórico encolhe, e (2) ele encolhe
// sem nunca separar uma mensagem `tool` da mensagem do assistente que pediu aquela ferramenta —
// um `tool_call_id` órfão faz a API recusar a requisição inteira com 400.
//
// Não precisa de banco nem de rede: DATABASE_URL é só para o módulo carregar (o pool do pg não
// abre conexão nenhuma até a primeira query).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://ninguem@localhost:5432/inexistente';

const assert = require('assert');
const { podarHistorico, MAX_CHARS_HISTORICO } = require('./chat');

let passou = 0;
function ok(condicao, descricao) {
  assert(condicao, descricao);
  console.log('  ✓ ' + descricao);
  passou++;
}

function turnoComFerramenta(i, tamanho) {
  return [
    { role: 'user', content: `pergunta ${i}` },
    { role: 'assistant', content: '', tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: 'listar_historico_vendas', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: `call_${i}`, content: JSON.stringify({ vendas: 'x'.repeat(tamanho) }) },
    { role: 'assistant', content: `resposta ${i}` },
  ];
}

console.log('\n--- poda do histórico do chat ---');

// 1. Conversa curta passa intacta (a não ser pela limpeza dos campos extras).
const curta = [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá' }];
ok(podarHistorico(curta).length === 2, 'Conversa curta não é podada');
ok(podarHistorico([]).length === 0 && podarHistorico(undefined).length === 0, 'Histórico vazio ou ausente não quebra');

// 2. Conversa longa encolhe até caber no orçamento.
const longa = [];
for (let i = 1; i <= 30; i++) longa.push(...turnoComFerramenta(i, 24000));
const podada = podarHistorico(longa);
const chars = podada.reduce((a, m) => a + JSON.stringify(m).length, 0);
const charsAntes = longa.reduce((a, m) => a + JSON.stringify(m).length, 0);
console.log(`    (${Math.round(charsAntes / 1000)}k chars antes → ${Math.round(chars / 1000)}k depois)`);
ok(chars <= MAX_CHARS_HISTORICO * 1.2, `30 turnos pesados cabem no orçamento — ${chars} chars`);
ok(charsAntes > 700000, 'O histórico original de fato era enorme (é o bug que estava em produção)');

// 3. A regra que não pode quebrar: todo `tool` tem o `tool_calls` correspondente antes dele.
function paresIntactos(msgs) {
  const pedidos = new Set();
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) pedidos.add(c.id);
    if (m.role === 'tool' && !pedidos.has(m.tool_call_id)) return false;
  }
  return true;
}
ok(paresIntactos(podada), 'Nenhuma mensagem `tool` ficou órfã do assistente que a pediu');
ok(podada[0].role === 'user', 'O corte cai sempre no começo de um turno (mensagem do usuário)');

// 4. As mensagens mais recentes são as que sobrevivem.
const ultima = podada[podada.length - 1];
ok(ultima.content === 'resposta 30', 'O fim da conversa é preservado — é o que o modelo mais precisa');

// 5. Resultados de ferramenta antigos entram compactados.
const maiorTool = Math.max(...podada.filter((m) => m.role === 'tool').map((m) => m.content.length));
ok(maiorTool < 3000, `Resultado de ferramenta antigo é compactado — maior tem ${maiorTool} chars`);

// 6. Prefixo órfão vindo de um front-end antigo é descartado em vez de derrubar a requisição.
const orfao = [{ role: 'tool', tool_call_id: 'perdido', content: '{}' }, { role: 'user', content: 'e aí' }];
ok(podarHistorico(orfao)[0].role === 'user', 'Histórico que começa com `tool` órfão tem o prefixo removido');

// 7. Campos extras do modelo (rascunho de raciocínio) não são guardados.
const comRaciocinio = [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá', reasoning: 'z'.repeat(50000) }];
const limpo = podarHistorico(comRaciocinio);
ok(limpo[1].reasoning === undefined, 'O rascunho de raciocínio do modelo não vai para o histórico');

// 8. A mensagem de sistema nunca é carregada (ela é remontada a cada turno).
ok(!podarHistorico([{ role: 'system', content: 'antigo' }, { role: 'user', content: 'oi' }]).some((m) => m.role === 'system'), 'Mensagem de sistema não sobrevive no histórico');

console.log(`\n${passou} verificações passaram.\n`);
