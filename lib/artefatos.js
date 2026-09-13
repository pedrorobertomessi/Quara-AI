// artefatos.js — onde ficam os arquivos que a Quara gera (contratos, apresentações, imagens).
//
// A escolha aqui é guardar os bytes no PRÓPRIO Postgres, em vez de escrever em disco. O motivo é o
// mesmo que já ditou a escolha do Postgres no db.js: o serviço web gratuito do Render não tem
// disco persistente, e além disso pode rodar mais de uma instância — um arquivo salvo em /tmp pela
// instância A simplesmente não existe quando o navegador pede o download e cai na instância B.
// Guardar em bytea resolve os dois problemas de uma vez, ao custo de ocupar espaço no banco.
//
// Esse custo é controlado com um prazo de validade: artefato é entregável de uso imediato (a
// pessoa pede, baixa, e pronto), não acervo. Depois de ARTEFATO_VALIDADE_DIAS o registro é
// apagado. Quem quiser guardar o contrato para sempre guarda o arquivo baixado, que é justamente o
// documento oficial — o banco não é o arquivo morto da empresa.

const crypto = require('crypto');
const { pool } = require('../db');

const ARTEFATO_VALIDADE_DIAS = 7;
const TAMANHO_MAXIMO = 25 * 1024 * 1024; // 25 MB — um .pptx pesado passa longe disso

async function salvar({ nome, mime, buffer, tipo, descricao }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('conteúdo do artefato precisa ser um Buffer');
  if (buffer.length > TAMANHO_MAXIMO) {
    throw new Error(`arquivo grande demais (${Math.round(buffer.length / 1024 / 1024)} MB; máximo ${TAMANHO_MAXIMO / 1024 / 1024} MB)`);
  }
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO artefatos (id, nome, mime, tipo, descricao, tamanho, conteudo, criado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, nome, mime, tipo, descricao || '', buffer.length, buffer, Date.now()]
  );
  // Limpeza oportunista: roda junto de cada gravação em vez de depender de um cron, que o plano
  // gratuito do Render não oferece. Falha aqui não pode derrubar a geração do arquivo — o pior
  // caso é o banco carregar alguns artefatos vencidos por mais tempo.
  limparVencidos().catch(() => {});
  return { id, nome, mime, tipo, tamanho: buffer.length, url: `/api/artefatos/${id}` };
}

async function obter(id) {
  const { rows } = await pool.query('SELECT * FROM artefatos WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listar(limite = 20) {
  const { rows } = await pool.query(
    'SELECT id, nome, mime, tipo, descricao, tamanho, criado_em FROM artefatos ORDER BY criado_em DESC LIMIT $1',
    [limite]
  );
  return rows.map((r) => ({
    id: r.id,
    nome: r.nome,
    mime: r.mime,
    tipo: r.tipo,
    descricao: r.descricao,
    tamanho: Number(r.tamanho),
    criadoEm: Number(r.criado_em),
    url: `/api/artefatos/${r.id}`,
  }));
}

async function limparVencidos() {
  const corte = Date.now() - ARTEFATO_VALIDADE_DIAS * 24 * 60 * 60 * 1000;
  const r = await pool.query('DELETE FROM artefatos WHERE criado_em < $1', [corte]);
  return r.rowCount;
}

module.exports = { salvar, obter, listar, limparVencidos, ARTEFATO_VALIDADE_DIAS, TAMANHO_MAXIMO };
