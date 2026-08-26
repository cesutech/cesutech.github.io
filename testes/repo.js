/**
 * repo.js — testa a camada de dados (02_Repo.gs) sem tocar no Google.
 *
 * Conversores, montagem da consulta, retentativa, ALREADY_EXISTS e quebra em
 * blocos são JavaScript puro: dá para provar tudo aqui, sem credencial, sem rede
 * e sem conta Google. O Firestore falso que responde por baixo mora em
 * `apoio.js`, junto com o relator de testes.
 *
 * Uso:  node testes/repo.js
 */

'use strict';

const {
  RAIZ, RECURSO, teste, grupo, igual, verdadeiro, lancou, resultado, criarAmbiente, ultima
} = require('./apoio');

// ============================================================================

console.log('\n\x1b[1mUNICESUSC CESUTECH — camada de dados (02_Repo.gs, sem Google)\x1b[0m');

grupo('Configuração');

teste('sem FIRESTORE_PROJETO, o erro diz exatamente o que configurar', () => {
  const { api } = criarAmbiente({ projeto: null });
  const e = lancou(() => api.ler('teste_conexao', 'x'), 'FIRESTORE_PROJETO');
  verdadeiro(e.message.indexOf('Propriedades do script') !== -1, 'deveria dizer onde configurar');
  verdadeiro(e.message.indexOf('README.md') !== -1, 'deveria apontar a documentação');
});

teste('banco padrão é (default) e o token vai no header Authorization', () => {
  const { api, falso } = criarAmbiente();
  api.inserir('teste_conexao', { nota: 'oi' }, 'doc1');

  const req = ultima(falso);
  igual(req.url, RAIZ + '/teste_conexao?documentId=doc1');
  igual(req.headers.Authorization, 'Bearer token-de-mentira');
});

teste('FIRESTORE_BANCO troca o banco na URL', () => {
  const { api, falso } = criarAmbiente({ banco: 'homologacao' });
  api.inserir('teste_conexao', { nota: 'oi' }, 'doc1');

  verdadeiro(ultima(falso).url.indexOf('/databases/homologacao/documents') !== -1,
    'URL foi ' + ultima(falso).url);
});

grupo('Conversores');

teste('grava TUDO como stringValue — número, booleano e nulo inclusive', () => {
  const { api } = criarAmbiente();
  igual(api.paraDocumento_({ vagas: 60, ativo: true, obs: null, nome: 'Ana' }), {
    fields: {
      vagas: { stringValue: '60' },
      ativo: { stringValue: 'true' },
      obs: { stringValue: '' },
      nome: { stringValue: 'Ana' }
    }
  });
});

teste('ida e volta devolve o texto idêntico ao gravado', () => {
  const { api } = criarAmbiente();
  const original = {
    matricula: '09110001',
    data_nascimento: '2002-05-09',
    horario: '21:00',
    criado_em: '2026-08-05 16:50:00',
    codigo: '007'
  };

  const documento = api.paraDocumento_(original);
  documento.name = RAIZ + '/teste_tipos/abc';
  const voltou = api.paraObjeto_(documento);

  Object.keys(original).forEach((campo) => igual(voltou[campo], original[campo], campo));
  igual(voltou._id, 'abc');
});

teste('metadados (_id, _nome) não viram campo no documento', () => {
  const { api } = criarAmbiente();
  igual(Object.keys(api.paraDocumento_({ _id: 'abc', _nome: 'x/y', nome: 'Ana' }).fields), ['nome']);
});

teste('leitura devolve texto mesmo quando o campo veio tipado do Firestore', () => {
  const { api } = criarAmbiente();
  const voltou = api.paraObjeto_({
    name: RAIZ + '/teste_tipos/abc',
    fields: {
      vagas: { integerValue: '60' },
      quando: { timestampValue: '2026-08-05T19:50:00Z' },
      ativo: { booleanValue: true },
      vazio: { nullValue: null }
    }
  });

  igual(voltou.vagas, '60');
  igual(voltou.quando, '2026-08-05T19:50:00Z');
  igual(voltou.ativo, 'true');
  igual(voltou.vazio, '');
});

grupo('Montagem do StructuredQuery');

teste('filtro de igualdade, orderBy e limit saem no formato da API', () => {
  const { api, falso } = criarAmbiente();
  api.listar('teste_dedup', { campo: 'projeto_id', valor: 'proj_1', ordenarPor: 'nome', limite: 50 });

  const req = ultima(falso);
  igual(req.url, RAIZ + ':runQuery');
  igual(req.corpo, {
    structuredQuery: {
      from: [{ collectionId: 'teste_dedup' }],
      orderBy: [{ field: { fieldPath: 'nome' }, direction: 'ASCENDING' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'projeto_id' },
          op: 'EQUAL',
          value: { stringValue: 'proj_1' }
        }
      },
      limit: 50
    }
  });
});

teste('direcao DESC vira DESCENDING; sem ordenarPor, ordena por __name__', () => {
  const { api, falso } = criarAmbiente();
  api.listar('teste_dedup', { direcao: 'desc' });

  igual(ultima(falso).corpo.structuredQuery.orderBy,
    [{ field: { fieldPath: '__name__' }, direction: 'DESCENDING' }]);
});

teste('entrada sem `document` na resposta do runQuery é ignorada', () => {
  const { api } = criarAmbiente();
  api.inserir('teste_ordenacao', { nome: 'Ana' }, 'a');
  api.inserir('teste_ordenacao', { nome: 'Bruno' }, 'b');

  // O falso sempre manda uma linha de progresso na frente; ela não pode virar item.
  const r = api.listar('teste_ordenacao', { ordenarPor: 'nome' });
  igual(r.itens.map((i) => i.nome), ['Ana', 'Bruno']);
});

teste('cursor da segunda página começa DEPOIS do último documento da primeira', () => {
  const { api, falso } = criarAmbiente();
  ['Ana', 'Bruno', 'Carla', 'Diego'].forEach((nome, i) => {
    api.inserir('teste_ordenacao', { nome }, 'doc' + i);
  });

  const pagina1 = api.listar('teste_ordenacao', { ordenarPor: 'nome', limite: 2 });
  igual(pagina1.itens.map((i) => i.nome), ['Ana', 'Bruno']);
  igual(pagina1.cursor, [{ stringValue: 'Bruno' }]);

  const pagina2 = api.listar('teste_ordenacao', { ordenarPor: 'nome', limite: 2, cursor: pagina1.cursor });
  igual(ultima(falso).corpo.structuredQuery.startAt, { values: [{ stringValue: 'Bruno' }], before: false });
  igual(pagina2.itens.map((i) => i.nome), ['Carla', 'Diego']);

  // Página incompleta não oferece cursor: não há próxima.
  const pagina3 = api.listar('teste_ordenacao', { ordenarPor: 'nome', limite: 2, cursor: pagina2.cursor });
  igual(pagina3.itens, []);
  igual(pagina3.cursor, null);
});

teste('sem orderBy explícito, o cursor é o caminho do documento', () => {
  const { api } = criarAmbiente();
  api.inserir('teste_ordenacao', { nome: 'Ana' }, 'a');

  igual(api.listar('teste_ordenacao', { limite: 1 }).cursor,
    [{ referenceValue: RAIZ + '/teste_ordenacao/a' }]);
});

grupo('Retentativa com recuo');

teste('503 duas vezes e depois sucesso: 3 tentativas, e o dado é gravado', () => {
  const { api, falso, esperas } = criarAmbiente();
  falso.forcar(503, 'UNAVAILABLE');
  falso.forcar(503, 'UNAVAILABLE');

  const r = api.inserir('teste_conexao', { nota: 'aguentou' }, 'doc1');

  igual(r.criado, true);
  igual(falso.requisicoes.length, 3);
  igual(esperas.length, 2);
});

teste('o recuo cresce exponencialmente, com sorteio', () => {
  const { api, falso, esperas } = criarAmbiente();
  falso.forcar(503, 'UNAVAILABLE');
  falso.forcar(503, 'UNAVAILABLE');
  api.inserir('teste_conexao', { nota: 'x' }, 'doc1');

  verdadeiro(esperas[0] >= 400 && esperas[0] < 600, '1a espera foi ' + esperas[0]);
  verdadeiro(esperas[1] >= 800 && esperas[1] < 1000, '2a espera foi ' + esperas[1]);
});

teste('teto rígido de 3 tentativas: 429 sempre não vira laço aberto', () => {
  const { api, falso, esperas } = criarAmbiente();
  for (let i = 0; i < 10; i++) falso.forcar(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded');

  lancou(() => api.ler('teste_conexao', 'doc1'), 'RESOURCE_EXHAUSTED');
  igual(falso.requisicoes.length, 3, 'tentativas');
  igual(esperas.length, 2, 'esperas');
});

teste('ABORTED é retentado, ALREADY_EXISTS não — os dois são HTTP 409', () => {
  const ambienteA = criarAmbiente();
  ambienteA.falso.forcar(409, 'ABORTED', 'Too much contention');
  ambienteA.api.inserir('teste_dedup', { nome: 'Ana' }, 'chave1');
  igual(ambienteA.falso.requisicoes.length, 2, 'ABORTED deveria retentar');

  const ambienteB = criarAmbiente();
  ambienteB.api.inserir('teste_dedup', { nome: 'Ana' }, 'chave1');
  ambienteB.api.inserir('teste_dedup', { nome: 'Ana' }, 'chave1');
  igual(ambienteB.falso.requisicoes.length, 2, 'ALREADY_EXISTS não deveria retentar');
});

teste('erro fora de JSON (502 em HTML) não quebra a leitura do erro', () => {
  const { api, falso } = criarAmbiente();

  // Proxy e página de erro do Google respondem HTML, não {error:{...}}. O
  // cliente tem de sobreviver a isso e ainda dizer o que aconteceu.
  falso.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 502,
    getContentText: () => '<html>Bad Gateway</html>'
  });

  const e = lancou(() => api.ler('teste_conexao', 'doc1'), 'Firestore 502');
  verdadeiro(e.message.indexOf('Bad Gateway') !== -1, 'deveria repassar o corpo: ' + e.message);
});

grupo('Unicidade pelo doc-id');

teste('segunda gravação com o mesmo id devolve jaExistia, sem lançar', () => {
  const { api } = criarAmbiente();
  const chave = 'a1b2c3d4e5f60718';

  const primeira = api.inserir('teste_dedup', { nome: 'Ana Prado' }, chave);
  const segunda = api.inserir('teste_dedup', { nome: 'Ana Prado' }, chave);

  igual(primeira, { criado: true, jaExistia: false, id: chave });
  igual(segunda, { criado: false, jaExistia: true, id: chave });
});

teste('a gravação recusada não sobrescreve o documento original', () => {
  const { api } = criarAmbiente();
  api.inserir('teste_dedup', { nome: 'Ana Prado', origem: 'SITE' }, 'chave1');
  api.inserir('teste_dedup', { nome: 'OUTRA PESSOA', origem: 'ROBO' }, 'chave1');

  const lido = api.ler('teste_dedup', 'chave1');
  igual(lido.nome, 'Ana Prado');
  igual(lido.origem, 'SITE');
});

teste('sem id, o Firestore gera o id e ele volta em `id`', () => {
  const { api, falso } = criarAmbiente();
  const r = api.inserir('teste_conexao', { nota: 'sem id' });

  verdadeiro(r.criado && r.id, 'deveria ter criado com id gerado');
  igual(ultima(falso).url, RAIZ + '/teste_conexao');
});

grupo('Leitura, atualização e exclusão');

teste('ler devolve null em NOT_FOUND, sem lançar', () => {
  const { api } = criarAmbiente();
  igual(api.ler('teste_conexao', 'nao-existe'), null);
});

teste('atualizar manda updateMask e preserva os campos fora dela', () => {
  const { api, falso } = criarAmbiente();
  api.inserir('teste_dedup', { nome: 'Ana', email: 'ana@exemplo.com', origem: 'SITE' }, 'chave1');

  const campos = api.atualizar('teste_dedup', 'chave1', { email: 'novo@exemplo.com', origem: 'FORMS' });

  igual(campos, 2);
  igual(ultima(falso).url,
    RAIZ + '/teste_dedup/chave1?updateMask.fieldPaths=email&updateMask.fieldPaths=origem');

  const lido = api.ler('teste_dedup', 'chave1');
  igual(lido.email, 'novo@exemplo.com');
  igual(lido.origem, 'FORMS');
  igual(lido.nome, 'Ana', 'campo fora da máscara não pode sumir');
});

teste('atualizar sem campo nenhum não chama a API', () => {
  const { api, falso } = criarAmbiente();
  igual(api.atualizar('teste_dedup', 'chave1', { _id: 'ignorado' }), 0);
  igual(falso.requisicoes.length, 0);
});

teste('excluir remove o documento', () => {
  const { api, falso } = criarAmbiente();
  api.inserir('teste_dedup', { nome: 'Ana' }, 'chave1');
  api.excluir('teste_dedup', 'chave1');

  igual(ultima(falso).metodo, 'DELETE');
  igual(api.ler('teste_dedup', 'chave1'), null);
});

grupo('Contagem por agregação');

teste('contar transforma o integerValue em texto num Number de verdade', () => {
  const { api } = criarAmbiente();
  ['a', 'b', 'c'].forEach((id) => api.inserir('teste_vazao', { projeto_id: 'proj_1' }, id));
  api.inserir('teste_vazao', { projeto_id: 'proj_2' }, 'd');

  const total = api.contar('teste_vazao', { campo: 'projeto_id', valor: 'proj_1' });
  igual(total, 3);
  verdadeiro(typeof total === 'number', 'deveria ser number, veio ' + typeof total);
  igual(api.contar('teste_vazao'), 4, 'sem filtro conta a coleção inteira');
});

grupo('Contagem em paralelo');

/** Três contagens diferentes sobre a mesma coleção semeada. */
function semearVazao(api) {
  ['a', 'b', 'c'].forEach((id) => api.inserir('teste_vazao', { projeto_id: 'proj_1' }, id));
  api.inserir('teste_vazao', { projeto_id: 'proj_2' }, 'd');
  return [
    { colecao: 'teste_vazao', campo: 'projeto_id', valor: 'proj_2' },
    { colecao: 'teste_vazao', campo: 'projeto_id', valor: 'proj_1' },
    { colecao: 'teste_vazao', campo: 'projeto_id', valor: 'proj_sem_ninguem' }
  ];
}

// `idas` conta chamadas ao UrlFetchApp; `requisicoes` conta requisições HTTP. A
// diferença é o assunto inteiro desta peça: o Firestore cobra pelas segundas, o
// aluno espera pelas primeiras.
teste('contarVarios devolve as contagens NA ORDEM dos pedidos, numa ida só', () => {
  const { api, falso } = criarAmbiente();
  const pedidos = semearVazao(api);
  falso.requisicoes.length = 0;
  falso.idas.length = 0;

  igual(api.contarVarios(pedidos), [1, 3, 0]);
  igual(falso.idas, [3], 'as três contagens tinham de sair juntas');
  igual(falso.requisicoes.length, 3, 'e o Firestore continua cobrando as três');
});

teste('o mesmo resultado de contar, pedido a pedido — não há segunda maneira de contar', () => {
  const { api } = criarAmbiente();
  const pedidos = semearVazao(api);

  igual(api.contarVarios(pedidos),
    pedidos.map((p) => api.contar(p.colecao, { campo: p.campo, valor: p.valor })));
});

teste('todas as requisições do lote levam o token, pedido UMA vez', () => {
  const { api, falso } = criarAmbiente();
  let pedidosDeToken = 0;
  api.ScriptApp = {
    getOAuthToken: () => { pedidosDeToken++; return 'token-de-mentira'; }
  };

  api.contarVarios(semearVazao(api));

  const doLote = falso.requisicoes.filter((r) => r.url.indexOf(':runAggregationQuery') !== -1);
  igual(doLote.length, 3);
  doLote.forEach((r) => igual(r.headers.Authorization, 'Bearer token-de-mentira'));
  // Um token por EXECUÇÃO, e não por requisição: pedi-lo dentro do laço é o que
  // já custou 15 s por chamada neste projeto (ver FS_TOKEN em 02_Repo.gs).
  igual(pedidosDeToken, 1, 'o token foi pedido ' + pedidosDeToken + ' vezes');
});

// O contrário disto é o defeito que a peça inteira existe para não introduzir:
// uma contagem que falha e volta como 0 faria a tela anunciar "0 de 60" no
// projeto mais cheio, e mandaria o aluno justamente para ele.
teste('uma resposta com erro derruba o lote — nunca vira zero', () => {
  const { api, falso } = criarAmbiente();
  const pedidos = semearVazao(api);
  falso.forcar(400, 'INVALID_ARGUMENT', 'the query requires an index');

  lancou(() => api.contarVarios(pedidos), 'INVALID_ARGUMENT');
});

teste('só a requisição que falhou é retentada, e o lote volta completo', () => {
  const { api, falso, esperas } = criarAmbiente();
  const pedidos = semearVazao(api);
  falso.requisicoes.length = 0;
  falso.idas.length = 0;
  falso.forcar(503, 'UNAVAILABLE');

  igual(api.contarVarios(pedidos), [1, 3, 0]);
  igual(falso.idas, [3, 1], 'a segunda ida tinha de levar só a que faltou');
  igual(esperas.length, 1);
});

teste('o teto de 3 tentativas vale para o lote também', () => {
  const { api, falso, esperas } = criarAmbiente();
  const pedidos = semearVazao(api).slice(0, 2);
  falso.idas.length = 0;
  for (let i = 0; i < 10; i++) falso.forcar(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded');

  lancou(() => api.contarVarios(pedidos), 'RESOURCE_EXHAUSTED');
  igual(falso.idas, [2, 2, 2], 'idas');
  igual(esperas.length, 2, 'esperas');
});

teste('lote vazio não chama a API', () => {
  const { api, falso } = criarAmbiente();
  igual(api.contarVarios([]), []);
  igual(api.contarVarios(null), []);
  igual(falso.requisicoes.length, 0);
});

teste('contar continua sendo uma requisição sozinha, com o contrato de sempre', () => {
  const { api, falso } = criarAmbiente();
  semearVazao(api);
  falso.requisicoes.length = 0;
  falso.idas.length = 0;

  igual(api.contar('teste_vazao', { campo: 'projeto_id', valor: 'proj_1' }), 3);
  igual(falso.idas, [1], 'quem conta uma coisa só não passou a mandar lote');
});

grupo('Escrita em lote');

teste('1200 objetos viram 3 commits de 500, 500 e 200', () => {
  const { api, falso } = criarAmbiente();
  const objetos = [];
  for (let i = 0; i < 1200; i++) objetos.push({ _id: 'm' + i, matricula: String(i) });

  igual(api.escreverEmLote('teste_vazao', objetos), 1200);

  const commits = falso.requisicoes.filter((r) => r.url.indexOf(':commit') !== -1);
  igual(commits.map((c) => c.corpo.writes.length), [500, 500, 200]);
  igual(falso.documentos.size, 1200);
});

// Este teste ja existiu exigindo o contrario — `name: RAIZ + ...`, com host —
// e por isso o defeito passou. O Firestore de verdade recusa o lote inteiro
// com 400 INVALID_ARGUMENT: 'Document name "https://..." lacks "projects" at
// index 0'. Descoberto no primeiro clique em Reconciliar, com 491 testes verdes.
teste('cada escrita do lote leva o NOME DE RECURSO, sem host', () => {
  const { api, falso } = criarAmbiente();
  api.escreverEmLote('teste_vazao', [{ _id: 'm1', matricula: '09110001' }]);

  igual(ultima(falso).corpo.writes[0].update, {
    fields: { matricula: { stringValue: '09110001' } },
    name: RECURSO + '/teste_vazao/m1'
  });
});

teste('a exclusao em lote tambem usa nome de recurso', () => {
  const { api, falso } = criarAmbiente();
  api.escreverEmLote('teste_vazao', [{ _id: 'm1', matricula: '09110001' }]);
  api.excluirEmLote('teste_vazao', ['m1']);

  igual(ultima(falso).corpo.writes[0].delete, RECURSO + '/teste_vazao/m1');
  igual(falso.documentos.size, 0, 'o documento saiu de verdade');
});

teste('lote vazio não chama a API', () => {
  const { api, falso } = criarAmbiente();
  igual(api.escreverEmLote('teste_vazao', []), 0);
  igual(falso.requisicoes.length, 0);
});

// ---------------------------------------------------------------- Resultado

process.exit(resultado());
