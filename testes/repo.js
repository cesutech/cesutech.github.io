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

grupo('PATCH em lote — atualizarEmLote');

/** Um matriculado como a importação grava: com nome, CPF e a linha original. */
function semearMatriculado(api, id) {
  api.escreverEmLote('teste_patch', [{
    _id: id, matricula: id, nome: 'ALUNO ' + id, cpf: '52998224725',
    turma: 'ADS41', raw_json: '["ALUNO ' + id + '","' + id + '"]', lote_id: 'L1'
  }]);
}

teste('cada escrita leva update + updateMask com EXATAMENTE as chaves + exists:true', () => {
  // Mutação que derruba: mandar `update` sem a máscara (vira `escreverEmLote`) —
  // o falso substituiria o documento e o nome sumiria abaixo; ou tirar a
  // precondição — o teste do documento ausente passaria a gravar fantasma.
  const { api, falso } = criarAmbiente();
  semearMatriculado(api, '9110001');

  igual(api.atualizarEmLote('teste_patch', [{
    _id: '9110001', _nome: 'lixo/que/nao/vai',
    situacao_cadastro: 'CANCELADO', cancelado_em: '2026-09-21 19:00:00',
    cancelado_por: 'prof@exemplo.com', cancelado_lote_id: 'L2'
  }]), 1);

  const escrita = ultima(falso).corpo.writes[0];
  igual(escrita.update.name, RECURSO + '/teste_patch/9110001');
  igual(Object.keys(escrita.update.fields).sort(),
    ['cancelado_em', 'cancelado_lote_id', 'cancelado_por', 'situacao_cadastro']);
  igual(escrita.updateMask.fieldPaths.slice().sort(),
    ['cancelado_em', 'cancelado_lote_id', 'cancelado_por', 'situacao_cadastro'],
    '_id e _nome não são campos, e não podem entrar na máscara');
  igual(escrita.currentDocument, { exists: true });

  // Só passa com o falso honrando a máscara: nome, CPF e a linha original
  // sobrevivem ao patch.
  const depois = api.ler('teste_patch', '9110001');
  igual(depois.nome, 'ALUNO 9110001');
  igual(depois.cpf, '52998224725');
  igual(depois.raw_json, '["ALUNO 9110001","9110001"]');
  igual(depois.lote_id, 'L1', 'o patch não pode tocar no lote de origem');
  igual(depois.situacao_cadastro, 'CANCELADO');
  igual(depois.cancelado_por, 'prof@exemplo.com');
});

teste('um documento ausente no lote: 404 e NENHUM dos outros muda', () => {
  // Mutação que derruba no falso: aplicar as escritas enquanto valida (o
  // primeiro documento ficaria cancelado antes de o segundo dar 404). No Repo:
  // tirar `currentDocument` — o falso criaria o fantasma e o total de
  // documentos subiria.
  const { api, falso } = criarAmbiente();
  semearMatriculado(api, '9110001');
  semearMatriculado(api, '9110003');
  const antes = falso.documentos.size;

  const e = lancou(() => api.atualizarEmLote('teste_patch', [
    { _id: '9110001', situacao_cadastro: 'CANCELADO' },
    { _id: '9110002', situacao_cadastro: 'CANCELADO' },   // não existe
    { _id: '9110003', situacao_cadastro: 'CANCELADO' }
  ]), 'NOT_FOUND');
  igual(e.status, 'NOT_FOUND');

  igual(falso.documentos.size, antes, 'um patch em id inexistente criou documento');
  igual(api.ler('teste_patch', '9110001').situacao_cadastro, undefined, 'o primeiro do lote foi aplicado antes da recusa');
  igual(api.ler('teste_patch', '9110003').situacao_cadastro, undefined);
  igual(api.ler('teste_patch', '9110002'), null);
});

teste('objeto sem campos é pulado, sem _id é recusado antes de qualquer requisição', () => {
  const { api, falso } = criarAmbiente();
  semearMatriculado(api, '9110001');
  falso.requisicoes.length = 0;

  igual(api.atualizarEmLote('teste_patch', [{ _id: '9110001', _nome: 'x' }]), 0,
    'objeto só com metadados não tem o que mandar');
  igual(falso.requisicoes.length, 0);

  lancou(() => api.atualizarEmLote('teste_patch', [
    { _id: '9110001', turma: 'ADS42' },
    { turma: 'ADS42' }
  ]), '_id');
  igual(falso.requisicoes.length, 0, 'a recusa veio DEPOIS de mandar o lote');
  igual(api.ler('teste_patch', '9110001').turma, 'ADS41', 'o objeto válido do mesmo lote foi gravado');
});

teste('501 patches viram 2 commits, cada um dentro do limite da API', () => {
  const { api, falso } = criarAmbiente();
  const objetos = [];
  for (let i = 0; i < 501; i++) {
    semearMatriculado(api, 'p' + i);
    objetos.push({ _id: 'p' + i, situacao_cadastro: 'CANCELADO' });
  }
  falso.requisicoes.length = 0;

  igual(api.atualizarEmLote('teste_patch', objetos), 501);
  const commits = falso.requisicoes.filter((r) => r.url.indexOf(':commit') !== -1);
  igual(commits.map((c) => c.corpo.writes.length), [500, 1]);
  igual(api.ler('teste_patch', 'p500').situacao_cadastro, 'CANCELADO');
  igual(api.ler('teste_patch', 'p500').nome, 'ALUNO p500');
});

teste('com _versao o patch leva updateTime como precondição, e um documento reescrito no meio derruba o lote inteiro', () => {
  // Mutação que derruba: `currentDocument: { exists: true }` ignorando a versão
  // — o patch entraria por cima do documento reescrito (é a corrida do Aplicar,
  // 05c: reimportado entre a releitura e o patch, marcado como cancelado). No
  // falso: não conferir o carimbo — o mesmo teste passaria a gravar.
  const { api, falso } = criarAmbiente();
  semearMatriculado(api, '9110001');
  semearMatriculado(api, '9110002');
  const relidos = api.listar('teste_patch', { campo: 'turma', valor: 'ADS41' }).itens;
  igual(relidos.length, 2);
  verdadeiro(relidos.every((d) => d._versao), 'listar não trouxe a versão');
  igual(api.ler('teste_patch', '9110001')._versao, relidos.filter((d) => d._id === '9110001')[0]._versao,
    'ler e listar têm de dizer a mesma versão do mesmo documento');

  // Alguém reescreve o segundo entre a leitura e o patch (uma reimportação).
  api.escreverEmLote('teste_patch', [{ _id: '9110002', matricula: '9110002', nome: 'ALUNO 9110002', turma: 'ADS41', lote_id: 'L9' }]);

  const e = lancou(() => api.atualizarEmLote('teste_patch', relidos.map((d) => ({
    _id: d._id, _versao: d._versao, situacao_cadastro: 'CANCELADO'
  }))), 'FAILED_PRECONDITION');
  igual(e.status, 'FAILED_PRECONDITION');
  const escritas = ultima(falso).corpo.writes;
  igual(escritas[0].currentDocument, { updateTime: relidos[0]._versao });
  igual(Object.keys(escritas[0].update.fields), ['situacao_cadastro'], '_versao não é campo e não vai no corpo');
  igual(escritas[0].updateMask.fieldPaths, ['situacao_cadastro'], '_versao não entra na máscara');
  igual(api.ler('teste_patch', '9110001').situacao_cadastro, undefined, 'o primeiro do lote entrou apesar da recusa do segundo');
  igual(api.ler('teste_patch', '9110002').situacao_cadastro, undefined);
  igual(api.ler('teste_patch', '9110002').lote_id, 'L9', 'a reescrita do meio tempo é a que vale');

  // Relido de novo, a versão bate e o patch entra — e troca a versão.
  const agora = api.ler('teste_patch', '9110002');
  igual(api.atualizarEmLote('teste_patch', [{ _id: '9110002', _versao: agora._versao, situacao_cadastro: 'CANCELADO' }]), 1);
  igual(api.ler('teste_patch', '9110002').situacao_cadastro, 'CANCELADO');
  verdadeiro(api.ler('teste_patch', '9110002')._versao !== agora._versao, 'toda escrita troca a versão');

  // Sem `_versao` a precondição continua sendo só a existência.
  api.atualizarEmLote('teste_patch', [{ _id: '9110001', situacao_cadastro: 'CANCELADO' }]);
  igual(ultima(falso).corpo.writes[0].currentDocument, { exists: true });

  // Versão num id que não existe mais: NOT_FOUND, como o Firestore.
  lancou(() => api.atualizarEmLote('teste_patch', [{ _id: 'sumiu', _versao: agora._versao, situacao_cadastro: 'X' }]), 'NOT_FOUND');
});

teste('excluirEmLote aceita { _id, _versao }: o delete leva a precondição, e o documento reescrito NÃO é apagado', () => {
  // Mutação que derruba: ignorar `_versao` no delete — o documento novo, gravado
  // por uma reimportação no meio do Aplicar, seria apagado no lugar do relido.
  const { api, falso } = criarAmbiente();
  semearMatriculado(api, '9110001');
  semearMatriculado(api, '9110002');
  const relido = api.ler('teste_patch', '9110002');

  api.escreverEmLote('teste_patch', [{ _id: '9110002', matricula: '9110002', nome: 'ALUNO 9110002', turma: 'ADS41', lote_id: 'L9' }]);
  const e = lancou(() => api.excluirEmLote('teste_patch', [
    { _id: '9110001', _versao: api.ler('teste_patch', '9110001')._versao },
    { _id: relido._id, _versao: relido._versao }
  ]), 'FAILED_PRECONDITION');
  igual(e.status, 'FAILED_PRECONDITION');
  igual(ultima(falso).corpo.writes[1].delete, RECURSO + '/teste_patch/9110002');
  igual(ultima(falso).corpo.writes[1].currentDocument, { updateTime: relido._versao });
  verdadeiro(falso.documentos.has('teste_patch/9110001'), 'o primeiro do lote saiu apesar da recusa do segundo');
  igual(api.ler('teste_patch', '9110002').lote_id, 'L9', 'o documento reescrito foi apagado');

  // Ids em texto continuam como sempre: sem precondição, e apagar o que não existe é 200.
  igual(api.excluirEmLote('teste_patch', ['9110001', 'nunca-existiu']), 2);
  igual(ultima(falso).corpo.writes[0].currentDocument, undefined);
  igual(falso.documentos.has('teste_patch/9110001'), false);
  lancou(() => api.excluirEmLote('teste_patch', [{ _versao: 'x' }]), 'id');
});

teste('o falso: caminho na máscara e ausente no corpo é apagado, como no Firestore', () => {
  // É a semântica que impede a máscara de virar "substitui tudo" por engano — e
  // o que `atualizarEmLote` nunca produz (a máscara é feita das chaves que vão
  // no corpo). Provado no falso para o dia em que alguém precisar apagar campo.
  const { api, falso } = criarAmbiente();
  semearMatriculado(api, '9110001');
  api.fsFetch_('post', ':commit', { writes: [{
    update: { name: RECURSO + '/teste_patch/9110001', fields: {} },
    updateMask: { fieldPaths: ['turma'] },
    currentDocument: { exists: true }
  }] });
  const depois = api.ler('teste_patch', '9110001');
  igual(depois.turma, undefined);
  igual(depois.nome, 'ALUNO 9110001');
  verdadeiro(falso.documentos.has('teste_patch/9110001'));
});

grupo('Commit misto — escreverAtomico');

/**
 * A inscrição como o site a grava — na FORMA do dado, com nome inventado. É o
 * documento INTEIRO que a troca de projeto copia para a quarentena, e é por
 * isso que ele é semeado com mais do que o id: um resumo não serviria.
 */
function semearInscricao(api, id, extras) {
  api.escreverEmLote('teste_inscricoes', [Object.assign({
    _id: id,
    matricula: '9110001', nome: 'Ana Prado', email: 'aluno@exemplo.com',
    projeto_id: 'p_x', projeto_nome: 'Robótica na Escola',
    origem: 'SITE', em_espera: 'NAO'
  }, extras || {})]);
  return api.ler('teste_inscricoes', id);
}

teste('os três verbos saem num :commit só, cada um com a SUA precondição e nome de recurso', () => {
  // Mutação que derruba: aplicar `fsPrecondicao_` ao objeto lido na cópia — ela
  // levaria o `updateTime` de OUTRA coleção (ou o `exists:true` do fallback) e a
  // primeira troca de todas morreria, porque a cópia ainda não existe lá.
  // Também derruba: mandar `updateMask` na cópia — a quarentena guardaria um
  // documento pela metade.
  const { api, falso } = criarAmbiente();
  const antiga = semearInscricao(api, 'i_antiga');
  falso.requisicoes.length = 0;

  const r = api.escreverAtomico([
    { gravar: { colecao: 'teste_anuladas', id: antiga._id, objeto: Object.assign({}, antiga, {
      anulado_em: '2026-09-22 19:00:00', anulado_por: 'aluno', anulado_motivo: 'TROCA', trocado_para: 'i_nova'
    }) } },
    { apagar: { colecao: 'teste_inscricoes', id: antiga._id } },
    { criar: { colecao: 'teste_inscricoes', id: 'i_nova', objeto: {
      matricula: '9110001', nome: 'Ana Prado', email: 'aluno@exemplo.com',
      projeto_id: 'p_y', projeto_nome: 'Horta Comunitária', trocada_de: 'i_antiga'
    } } }
  ]);

  igual(r, { aplicado: true, jaExistia: false, retentou: false, id: 'i_nova', escritas: 3 });

  const commits = falso.requisicoes.filter((req) => req.url.indexOf(':commit') !== -1);
  igual(commits.length, 1, 'a troca inteira tem de caber em UMA requisição');
  const writes = commits[0].corpo.writes;
  igual(writes.length, 3);

  igual(writes[0].update.name, RECURSO + '/teste_anuladas/i_antiga', 'nome de RECURSO, sem host');
  igual(writes[0].currentDocument, undefined, 'a cópia é upsert: sem precondição nenhuma');
  igual(writes[0].updateMask, undefined, 'a cópia grava o documento inteiro, não uma máscara');
  igual(writes[0].update.fields._versao, undefined, 'metadado de leitura não volta para o banco');
  igual(writes[0].update.fields._id, undefined);
  igual(writes[1], { delete: RECURSO + '/teste_inscricoes/i_antiga' },
    'o apagar da troca vai SEM precondição — ver o cabeçalho');
  igual(writes[2].update.name, RECURSO + '/teste_inscricoes/i_nova');
  igual(writes[2].currentDocument, { exists: false }, 'o 409 de sempre, na forma que o :commit aceita');

  igual(api.ler('teste_inscricoes', 'i_antiga'), null);
  igual(api.ler('teste_inscricoes', 'i_nova').projeto_nome, 'Horta Comunitária');
  const copia = api.ler('teste_anuladas', 'i_antiga');
  igual(copia.anulado_motivo, 'TROCA');
  igual(copia.trocado_para, 'i_nova');
  igual(copia.projeto_nome, 'Robótica na Escola', 'a cópia guarda o documento inteiro, e não um resumo');
  igual(copia.email, 'aluno@exemplo.com');
});

teste('com `versao`, gravar e apagar levam updateTime — e o carimbo velho derruba o commit inteiro', () => {
  // Mutação que derruba: tirar a `versao` do corpo da escrita — a promoção da
  // fila (13_Auditorio.gs) gravaria por cima do documento que outra execução
  // acabou de reescrever, que é o "X ressuscita" que a precondição impede.
  const { api, falso } = criarAmbiente();
  const antiga = semearInscricao(api, 'i_antiga');

  // Alguém reescreve a inscrição entre a leitura e o commit.
  semearInscricao(api, 'i_antiga', { em_espera: 'SIM' });

  const e = lancou(() => api.escreverAtomico([
    { gravar: { colecao: 'teste_inscricoes', id: 'i_antiga',
                objeto: Object.assign({}, antiga, { em_espera: 'NAO' }), versao: antiga._versao } },
    { criar: { colecao: 'teste_inscricoes', id: 'i_nova', objeto: { matricula: '9110001' } } }
  ]), 'FAILED_PRECONDITION');
  igual(e.status, 'FAILED_PRECONDITION');
  igual(ultima(falso).corpo.writes[0].currentDocument, { updateTime: antiga._versao });
  igual(api.ler('teste_inscricoes', 'i_antiga').em_espera, 'SIM', 'o commit recusado aplicou a primeira escrita');
  igual(api.ler('teste_inscricoes', 'i_nova'), null, 'e criou a segunda');

  // Com o carimbo de agora, entra — e o `apagar` versionado usa a mesma régua.
  const agora = api.ler('teste_inscricoes', 'i_antiga');
  igual(api.escreverAtomico([
    { apagar: { colecao: 'teste_inscricoes', id: 'i_antiga', versao: agora._versao } }
  ]), { aplicado: true, jaExistia: false, retentou: false, id: '', escritas: 1 });
  igual(ultima(falso).corpo.writes[0].currentDocument, { updateTime: agora._versao });
  igual(api.ler('teste_inscricoes', 'i_antiga'), null);
});

teste('id novo já ocupado: o 409 vira jaExistia sem lançar, e NADA do lote entrou', () => {
  // Mutação que derruba: montar o `criar` sem `currentDocument` — a inscrição
  // de outra pessoa no mesmo id seria sobrescrita, a antiga apagada e a cópia
  // gravada, e a resposta ainda diria "criado". Ou tratar ALREADY_EXISTS como
  // erro: o aluno veria "Erro ao registrar" depois de um reenvio inofensivo.
  const { api, falso } = criarAmbiente();
  const antiga = semearInscricao(api, 'i_antiga');
  semearInscricao(api, 'i_nova', { nome: 'Bruno Teixeira', projeto_id: 'p_y' });
  const documentosAntes = falso.documentos.size;
  falso.requisicoes.length = 0;

  const r = api.escreverAtomico([
    { gravar: { colecao: 'teste_anuladas', id: 'i_antiga', objeto: antiga } },
    { apagar: { colecao: 'teste_inscricoes', id: 'i_antiga' } },
    { criar: { colecao: 'teste_inscricoes', id: 'i_nova', objeto: { matricula: '9110001', projeto_id: 'p_y' } } }
  ]);

  igual(r, { aplicado: false, jaExistia: true, retentou: false, id: 'i_nova', escritas: 3 });
  igual(falso.requisicoes.length, 1, 'ALREADY_EXISTS não é retentado — é a unicidade funcionando');
  igual(api.ler('teste_anuladas', 'i_antiga'), null, 'a cópia entrou apesar da recusa');
  igual(api.ler('teste_inscricoes', 'i_antiga').projeto_nome, 'Robótica na Escola', 'a antiga foi apagada apesar da recusa');
  igual(api.ler('teste_inscricoes', 'i_nova').nome, 'Bruno Teixeira', 'o documento do id ocupado foi sobrescrito');
  igual(falso.documentos.size, documentosAntes);
});

teste('NOT_FOUND e FAILED_PRECONDITION lançam, e a mensagem sai sem o caminho do documento', () => {
  // Mutação que derruba: tratar NOT_FOUND como `jaExistia` — "alguém mexeu
  // nisto enquanto você decidia" viraria "você já estava inscrito", com a
  // inscrição nova nunca criada. E deixar a mensagem crua: ela carrega
  // `projects/<id do projeto Cloud>/.../teste_inscricoes/<id>`, que é o começo
  // da trilha para quem quiser sondar e, numa inscrição, o protocolo do aluno.
  const { api, falso } = criarAmbiente();

  const e = lancou(() => api.escreverAtomico([
    { apagar: { colecao: 'teste_inscricoes', id: 'sumiu', versao: '2026-08-05T00:00:00.000009Z' } },
    { criar: { colecao: 'teste_inscricoes', id: 'i_nova', objeto: { matricula: '9110001' } } }
  ]), 'NOT_FOUND');
  igual(e.status, 'NOT_FOUND', 'quem decide é o status, nunca o texto');
  igual(e.codigo, 404);
  igual(e.message.indexOf('projects/'), -1, 'a mensagem carrega o caminho: ' + e.message);
  verdadeiro(e.message.indexOf('(documento)') !== -1, 'e o caminho tinha de virar o marcador de sempre');
  igual(falso.requisicoes.length, 1, 'NOT_FOUND não é retentado');
  igual(api.ler('teste_inscricoes', 'i_nova'), null, 'a recusa de uma escrita derruba o lote inteiro');

  // O carimbo velho tem o mesmo desfecho, com o outro status — e a mesma régua
  // na mensagem.
  const antiga = semearInscricao(api, 'i_antiga');
  semearInscricao(api, 'i_antiga', { em_espera: 'SIM' });
  const velha = lancou(() => api.escreverAtomico([
    { apagar: { colecao: 'teste_inscricoes', id: 'i_antiga', versao: antiga._versao } }
  ]), 'FAILED_PRECONDITION');
  igual(velha.status, 'FAILED_PRECONDITION');
  igual(velha.message.indexOf('projects/'), -1, 'a mensagem carrega o caminho: ' + velha.message);
  verdadeiro(falso.documentos.has('teste_inscricoes/i_antiga'), 'o documento reescrito foi apagado');
});

teste('503 é retentado como em toda escrita, e a retentativa que encontra o documento devolve jaExistia', () => {
  // A segunda metade é o caso do cabeçalho: se o 503 vier na resposta de um
  // commit que o banco já aplicou, a retentativa encontra o documento novo no
  // lugar. `jaExistia` é a leitura certa do estado do banco, ainda que a
  // primeira resposta tenha sido perdida — e vem com `retentou`, que é o que
  // separa "outra pessoa" de "eu mesmo" (os dois testes logo abaixo).
  const { api, falso, esperas } = criarAmbiente();
  semearInscricao(api, 'i_antiga');
  falso.requisicoes.length = 0;
  falso.forcar(503, 'UNAVAILABLE');

  igual(api.escreverAtomico([
    { apagar: { colecao: 'teste_inscricoes', id: 'i_antiga' } },
    { criar: { colecao: 'teste_inscricoes', id: 'i_nova', objeto: { matricula: '9110001' } } }
  ]).aplicado, true);
  igual(falso.requisicoes.length, 2, 'uma recusada e uma que entrou');
  igual(esperas.length, 1);
  igual(api.ler('teste_inscricoes', 'i_antiga'), null);
  igual(api.ler('teste_inscricoes', 'i_nova').matricula, '9110001');

  falso.forcar(503, 'UNAVAILABLE');
  igual(api.escreverAtomico([
    { criar: { colecao: 'teste_inscricoes', id: 'i_nova', objeto: { matricula: '9110001' } } }
  ]).jaExistia, true);
});

/**
 * O 503 QUE CHEGA DEPOIS DE O BANCO APLICAR — os três testes abaixo.
 *
 * `forcar` responde o erro SEM deixar a escrita acontecer, e por isso ele não
 * sabe dizer este caso: aqui o `:commit` ENTRA e é a resposta que se perde no
 * caminho de volta. A retentativa manda a mesma precondição, que o efeito
 * anterior acabou de invalidar, e recebe um status que diz "alguém mexeu" sobre
 * uma mudança que foi minha. É a diferença entre "nada aconteceu" e "aconteceu
 * tudo", com o mesmo status na mão — e é por isso que `retentou` existe.
 */
teste('a resposta perdida depois do commit: `criar` volta jaExistia COM a marca da retentativa', () => {
  // Mutação que derruba: não repassar `retentou` no ramo ALREADY_EXISTS — quem
  // chama volta a ler "já estava lá" como se outra pessoa tivesse gravado.
  const { api, falso } = criarAmbiente();
  semearInscricao(api, 'i_antiga');
  falso.requisicoes.length = 0;
  falso.derrubarDepoisDeAplicar(':commit', 503, 'UNAVAILABLE');

  const r = api.escreverAtomico([
    { apagar: { colecao: 'teste_inscricoes', id: 'i_antiga' } },
    { criar: { colecao: 'teste_inscricoes', id: 'i_nova', objeto: { matricula: '9110001' } } }
  ]);

  igual(r.jaExistia, true);
  igual(r.retentou, true, 'sem isto, "já existia" é indistinguível de outra pessoa ter gravado');
  igual(falso.requisicoes.length, 2, 'uma aplicada com a resposta perdida, e a retentativa');

  // E o efeito ENTROU na primeira: é este o estado que a resposta negava.
  igual(api.ler('teste_inscricoes', 'i_antiga'), null, 'o commit perdido não foi aplicado');
  igual(api.ler('teste_inscricoes', 'i_nova').matricula, '9110001');
});

teste('a resposta perdida depois do commit: a precondição de VERSÃO lança com `retentou`', () => {
  // Mutação que derruba: apagar `erro.retentou = tentativa > 1` de `fsFetch_` —
  // os dois promotores voltam a anunciar "ninguém foi promovido" com a fila
  // inteira promovida.
  const { api, falso } = criarAmbiente();
  const antiga = semearInscricao(api, 'i_antiga', { em_espera: 'SIM' });
  falso.requisicoes.length = 0;
  falso.derrubarDepoisDeAplicar(':commit', 503, 'UNAVAILABLE');

  const promovida = Object.assign({}, antiga);
  delete promovida.em_espera;

  const e = lancou(() => api.escreverAtomico([
    { gravar: { colecao: 'teste_inscricoes', id: 'i_antiga', objeto: promovida, versao: antiga._versao } }
  ]), 'FAILED_PRECONDITION');

  igual(e.status, 'FAILED_PRECONDITION');
  igual(e.retentou, true, 'a marca tem de sobreviver à limpeza da mensagem (D-27)');
  igual(e.message.indexOf('projects/'), -1, 'e a mensagem continua sem o caminho do documento');
  igual(api.ler('teste_inscricoes', 'i_antiga').em_espera, undefined,
    'a escrita que o erro nega é exatamente a que entrou');
});

teste('`escritaIndeterminada_` separa "alguém mexeu" de "não sei se fui eu"', () => {
  // Mutação que derruba: devolver `corridaDeEscrita_(erro)` sozinho — a recusa
  // de primeira (em que NADA entrou, e isso se sabe) passaria a responder "não
  // consigo confirmar", e a coordenação deixaria de receber a única frase que
  // ela pode agir em cima.
  const { api } = criarAmbiente();

  igual(api.escritaIndeterminada_({ status: 'FAILED_PRECONDITION', retentou: true }), true);
  igual(api.escritaIndeterminada_({ status: 'NOT_FOUND', retentou: true }), true);
  igual(api.escritaIndeterminada_({ status: 'FAILED_PRECONDITION' }), false,
    'sem retentativa, a precondição recusada é corrida de verdade');
  igual(api.escritaIndeterminada_({ status: 'RESOURCE_EXHAUSTED', retentou: true }), false,
    'cota estourada não é corrida: nada foi aplicado e o erro é outro');
  igual(api.escritaIndeterminada_(null), false);
});

teste('as guardas recusam ANTES de mandar: dois `criar`, duas escritas no mesmo documento, escrita sem endereço', () => {
  // Mutação que derruba: deixar passar. Dois `criar` no mesmo lote fazem o 409
  // deixar de dizer QUAL documento já existia — e a mensagem que diria é
  // justamente a que sai daqui sem o caminho. Duas escritas no mesmo documento
  // o Firestore recusa inteiras (o teste do falso, logo abaixo), gastando a ida
  // dentro do lock para receber um INVALID_ARGUMENT genérico.
  const { api, falso } = criarAmbiente();

  const e = lancou(() => api.escreverAtomico([
    { criar: { colecao: 'teste_inscricoes', id: 'i_1', objeto: { matricula: '9110001' } } },
    { criar: { colecao: 'teste_inscricoes', id: 'i_2', objeto: { matricula: '9110002' } } }
  ]), 'um `criar`');

  const noMesmo = lancou(() => api.escreverAtomico([
    { gravar: { colecao: 'teste_inscricoes', id: 'i_1', objeto: { em_espera: 'SIM' } } },
    { apagar: { colecao: 'teste_inscricoes', id: 'i_1' } }
  ]), 'mesmo documento');
  igual(noMesmo.message.indexOf('i_1'), -1,
    'a guarda nomeia a coleção e nunca o id: o id de uma inscrição é o protocolo do aluno');

  lancou(() => api.escreverAtomico([{ apagar: { colecao: 'teste_inscricoes' } }]), 'colecao e id');
  lancou(() => api.escreverAtomico([{ gravar: { id: 'i_1', objeto: {} } }]), 'colecao e id');
  lancou(() => api.escreverAtomico([{ mudar: { colecao: 'teste_inscricoes', id: 'i_1' } }]), 'cada escrita é UM');
  lancou(() => api.escreverAtomico([{
    criar: { colecao: 'teste_inscricoes', id: 'i_1', objeto: {} },
    apagar: { colecao: 'teste_inscricoes', id: 'i_2' }
  }]), 'cada escrita é UM');

  igual(falso.requisicoes.length, 0, 'alguma guarda recusou só DEPOIS de mandar');
  igual(falso.documentos.size, 0);
  verdadeiro(e.message.indexOf('i_2') === -1, 'nem a guarda dos dois `criar` diz o id');

  // O MESMO id em coleções diferentes é o caso normal da troca, e passa: a
  // cópia da quarentena guarda o id da inscrição de propósito.
  igual(api.escreverAtomico([
    { gravar: { colecao: 'teste_anuladas', id: 'i_1', objeto: { matricula: '9110001' } } },
    { apagar: { colecao: 'teste_inscricoes', id: 'i_1' } }
  ]).escritas, 2);
});

teste('501 escritas lançam antes de qualquer requisição: esta é a primitiva que NÃO fatia', () => {
  // Mutação que derruba: fatiar em blocos de 500 como os irmãos fazem — seriam
  // dois `:commit`, duas idas dentro do lock e nenhuma atomicidade justamente
  // no lote grande, que é quando ela mais importa.
  const { api, falso } = criarAmbiente();
  const escritas = [];
  for (let i = 0; i < 501; i++) escritas.push({ apagar: { colecao: 'teste_inscricoes', id: 'i' + i } });

  lancou(() => api.escreverAtomico(escritas), '500');
  igual(falso.requisicoes.length, 0);

  // 500 é o teto e cabe num commit só. Sem `versao`, apagar o que não existe é
  // 200 — o delete continua idempotente, como em `excluirEmLote`.
  igual(api.escreverAtomico(escritas.slice(0, 500)), { aplicado: true, jaExistia: false, retentou: false, id: '', escritas: 500 });
  igual(falso.requisicoes.filter((r) => r.url.indexOf(':commit') !== -1).length, 1);
});

teste('lista vazia não chama a API', () => {
  const { api, falso } = criarAmbiente();
  igual(api.escreverAtomico([]), { aplicado: false, jaExistia: false, retentou: false, id: '', escritas: 0 });
  igual(api.escreverAtomico(null).escritas, 0);
  igual(falso.requisicoes.length, 0);
});

teste('o falso: duas escritas no mesmo documento no mesmo :commit são recusadas, como no Firestore', () => {
  // É a razão de existir da guarda acima — e sem isto o falso seria mais
  // permissivo que o banco, que é a classe de erro que já passou por 491 testes
  // verdes neste projeto (ver o comentário do `:commit` em apoio.js). Chamado
  // pelo transporte, porque a primitiva recusa antes e nunca manda.
  const { api, falso } = criarAmbiente();
  semearInscricao(api, 'i_antiga');

  const e = lancou(() => api.fsFetch_('post', ':commit', { writes: [
    { update: { name: RECURSO + '/teste_inscricoes/i_antiga', fields: { em_espera: { stringValue: 'SIM' } } } },
    { delete: RECURSO + '/teste_inscricoes/i_antiga' }
  ] }), 'INVALID_ARGUMENT');
  verdadeiro(e.message.indexOf('more than once') !== -1, e.message);
  igual(api.ler('teste_inscricoes', 'i_antiga').em_espera, 'NAO', 'e nada do lote foi aplicado');
});

// ---------------------------------------------------------------- Resultado

process.exit(resultado());
