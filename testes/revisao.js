/**
 * revisao.js — a revisão de divergências (05c_Revisao.gs): quem estava na lista
 * oficial como a turma do lote e não veio nele, e o que se faz com ele.
 *
 * O que se prova aqui, em ordem de importância:
 *   1. A RÉGUA DO CARIMBO. Candidato é quem tem a turma do lote E `lote_id`
 *      ANTERIOR ao lote — nunca `lote_id !=`. O mesmo arquivo importado duas
 *      vezes e a reimportação que veio depois não inventam candidato.
 *   2. LEITURA PURA. `revisarLote` não escreve nada, nem a turma que deduz de
 *      um lote antigo — ela está em SO_LEITURA e é repetida pelo painel.
 *   3. A ORDEM DO APLICAR. Anular primeiro (o passo com quarentena); a
 *      releitura pula quem voltou; os tetos recusam antes de qualquer leitura;
 *      cada passo relata o que já fez quando o seguinte cai; e o patch e o
 *      delete levam a VERSÃO relida — a reimportação que entra DENTRO do
 *      Aplicar não vira cancelamento de quem acabou de voltar.
 *   4. SÓ PELA MATRÍCULA. O Aplicar anula só a inscrição que traz a matrícula
 *      do candidato (varredura). A que a reconciliação casou por e-mail/CPF/
 *      nome (ficha de `alunos`) é INFORMAÇÃO na janela — nem CONFIRMADO nem
 *      DIVERGENCIA são seguidos, porque nome casa homônimo e e-mail casa
 *      família — e quem já está cancelado não sofre ação nenhuma.
 *   5. O QUE SAI. O log leva matrículas e nunca nome; a mensagem de erro do
 *      Firestore perde o caminho do documento antes de chegar à tela, em TODO
 *      ramo; e o Aplicar que morre depois de já ter escrito deixa a trilha
 *      parcial: quem perdeu a inscrição, nominalmente.
 *
 * As listas entram pelo caminho REAL da importação (`analisarArquivo` +
 * `confirmarImportacao`, CSV no formato do sistema acadêmico), com o relógio
 * sob controle — dois lotes no mesmo milissegundo teriam o mesmo carimbo, e a
 * régua deixaria de distinguir "antes" de "depois". O Drive fica de fora: o
 * temporário entre os dois passos vive num Map aqui, porque o que se prova não
 * é o Drive (importacao.js prova).
 *
 * Nenhum dado real: matrículas 911xxxx, nomes inventados, prof@exemplo.com.
 *
 * Uso:  node testes/revisao.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  teste, grupo, igual, verdadeiro, resultado, criarAmbiente, criarRelogio
} = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');
const FONTE = fs.readFileSync(path.join(PASTA_GS, '05c_Revisao.gs'), 'utf8');

// Na ordem alfabética em que o editor do Apps Script carrega os arquivos.
// 08_Api.gs entra pela lista branca; 10_Painel.gs porque a revisão invalida o
// cache do Painel e esquece a marca da reconciliação; 12 e 13 porque ela
// REUSA a varredura de inscrições e a anulação — o desenho inteiro é não ter
// uma segunda cópia de nenhuma das duas.
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '02b_Drive.gs', '03_Config.gs',
  '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs', '05b_FormatoAcademico.gs',
  '05c_Revisao.gs', '06_Reconciliacao.gs', '07_Auth.gs', '08_Api.gs', '09_Projetos.gs',
  '10_Painel.gs', '11_Banners.gs', '12_Disciplinas.gs', '13_Auditorio.gs'];

const PROF = 'prof@exemplo.com';

// ------------------------------------------------------------ Ambiente

/** `Utilities.parseCsv` o suficiente para o CSV do sistema acadêmico (sem aspas). */
function parseCsv(texto, separador) {
  const sep = separador || ',';
  return String(texto).split(/\r?\n/).filter((l) => l !== '').map((l) => l.split(sep));
}

function criarBlob(conteudo, mime, nome) {
  const bytes = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo), 'utf8');
  let tipo = mime || '';
  const blob = {
    getName: () => nome || '',
    getBytes: () => bytes,
    getContentType: () => tipo,
    setContentType: (novo) => { tipo = novo; return blob; },
    getDataAsString: () => bytes.toString('utf8')
  };
  return blob;
}

function ambiente(opcoes) {
  const relogio = criarRelogio(Date.UTC(2026, 8, 21, 12, 0, 0));
  const amb = criarAmbiente(Object.assign(
    { arquivos: GS, usuario: 'coordenacao@exemplo.com', relogio: relogio }, opcoes || {}
  ));
  amb.relogio = relogio;
  amb.api.semearConfigPadrao_();
  amb.token = amb.api.criarSessao_(PROF);

  // O temporário entre o passo 1 e o passo 2 da importação, em memória: as três
  // funções são trocadas no sandbox (declaração de função vira propriedade do
  // global, e quem as chama resolve pelo global). O Drive não é o assunto aqui.
  const temporarios = new Map();
  let proximo = 0;
  amb.api.salvarTemporario_ = (nome, dados) => {
    const id = 'tmp' + (++proximo);
    temporarios.set(id, JSON.stringify({
      arquivo: nome, cabecalhos: dados.cabecalhos, linhas: dados.linhas,
      texto_bruto: dados.texto_bruto || '', cabecalho: dados.cabecalho || null
    }));
    return id;
  };
  amb.api.lerTemporario_ = (id) => (temporarios.has(id) ? JSON.parse(temporarios.get(id)) : null);
  amb.api.descartarTemporario_ = (id) => { temporarios.delete(id); };

  amb.api.Utilities.base64Decode = (b64) => Buffer.from(String(b64), 'base64');
  amb.api.Utilities.newBlob = (conteudo, mime, nome) => criarBlob(conteudo, mime, nome);
  amb.api.Utilities.parseCsv = parseCsv;

  amb.zerar = () => { amb.falso.requisicoes.length = 0; amb.falso.idas.length = 0; };
  return amb;
}

/** Chama uma função do painel com o token da sessão. */
function chamar(amb, funcao, payload) {
  return amb.api[funcao](Object.assign({ token: amb.token }, payload || {}));
}

// ------------------------------------------------------------ Listas

/** O CSV do sistema acadêmico: cabeçalho numa coluna constante, nome e matrícula no mesmo campo. */
function csvAcademico(cabecalho, linhas) {
  return [cabecalho + ',Aluno,Turma,Telefone'].concat(linhas.map((l, i) => {
    return cabecalho + ',' + l[0] + ',' + l[1] + ',4890001000' + (i % 10);
  })).join('\n') + '\n';
}

/**
 * Importa uma lista pelo caminho real, com o relógio um minuto à frente da
 * anterior — é o que faz o carimbo do lote novo ser MAIOR que o do anterior.
 * Devolve o id do lote (e a resposta inteira, para quem quiser).
 */
function importar(amb, cabecalho, linhas, opcoes) {
  opcoes = opcoes || {};
  amb.relogio.avancar(60 * 1000);
  const texto = csvAcademico(cabecalho, linhas);
  const analise = amb.api.analisarArquivo({
    token: amb.token, filename: opcoes.nome || 'lista.csv', mimeType: 'text/csv',
    dataBase64: Buffer.from(texto, 'utf8').toString('base64')
  });
  if (!analise.ok) throw new Error('análise recusou: ' + analise.erro);
  const payload = {
    token: amb.token, tempId: analise.tempId, arquivo: analise.arquivo, tipo: analise.tipo,
    mapeamento: analise.mapeamento
  };
  if (opcoes.turmaCabecalho !== undefined) payload.turmaCabecalho = opcoes.turmaCabecalho;
  const r = amb.api.confirmarImportacao(payload);
  if (!r.ok) throw new Error('importação recusou: ' + r.erro);
  return { loteId: r.loteId, resposta: r, analise: analise };
}

const ADS41_2026_2 = 'ADS41 - 2026/2 Relação de Alunos Matriculados';
const ADS31_2026_2 = 'ADS31 - 2026/2 Relação de Alunos Matriculados';
const ADS31_2026_1 = 'ADS31 - 2026/1 Relação de Alunos Matriculados';

const ANA = ['ANA EXEMPLO (09110001)', 'ADS41'];
const BEATRIZ = ['BEATRIZ EXEMPLO MARTINS (09110002)', 'ADS41'];
const CARLOS_DE_ADS31 = ['CARLOS EXEMPLO (09110003)', 'ADS31'];
const DUDA = ['DUDA EXEMPLO (09110004)', 'ADS41'];
const XAVIER_DE_ADS41 = ['XAVIER EXEMPLO (09110009)', 'ADS41'];

/** N alunos de uma turma, com matrículas em sequência a partir de `base`. */
function turma(n, chave, base) {
  const linhas = [];
  for (let i = 0; i < n; i++) {
    const m = String((base || 9120000) + i);
    linhas.push(['ALUNO ' + m + ' EXEMPLO (0' + m + ')', chave]);
  }
  return linhas;
}

/** Um projeto e uma inscrição pela porta pública de verdade. */
function projeto(amb, id, nome) {
  amb.api.inserir('projetos', {
    nome: nome || 'Robótica', vagas: '10', ativo: 'SIM', inscricoes_abertas: 'SIM',
    ordem: '1', validar_matricula: 'NAO'
  }, id);
}

function inscrever(amb, matricula, nome, projetoId, extras) {
  return amb.api.gravarInscricao(Object.assign({
    matricula: matricula, nome: nome, email: (nome.split(' ')[0].toLowerCase()) + '@exemplo.com',
    projeto_id: projetoId, projeto_nome: 'Robótica', origem: 'SITE', curso_fase: 'ADS - 4'
  }, extras || {})).id;
}

// ------------------------------------------------------------ Leitura do falso

function documento(falso, colecao, id) {
  const campos = falso.documentos.get(colecao + '/' + id);
  if (!campos) return null;
  const obj = {};
  Object.keys(campos).forEach((k) => { obj[k] = campos[k].stringValue; });
  return obj;
}

function idsDe(falso, colecao) {
  return Array.from(falso.documentos.keys())
    .filter((k) => k.indexOf(colecao + '/') === 0)
    .map((k) => k.slice(colecao.length + 1))
    .sort();
}

function registrosDoLog(falso, acao) {
  const saida = [];
  falso.documentos.forEach((campos, chave) => {
    if (chave.indexOf('log/') !== 0) return;
    if (!acao || campos.acao.stringValue === acao) {
      saida.push({ acao: campos.acao.stringValue, detalhe: campos.detalhe.stringValue });
    }
  });
  return saida;
}

const ESCRITA = (r) => r.metodo === 'POST' && r.url.indexOf(':commit') !== -1 ||
  r.metodo === 'PATCH' || r.metodo === 'DELETE' ||
  (r.metodo === 'POST' && r.url.indexOf(':runQuery') === -1 && r.url.indexOf(':runAggregationQuery') === -1 &&
    r.url.indexOf(':commit') === -1);
const COMMIT = (r) => r.metodo === 'POST' && r.url.indexOf(':commit') !== -1;
const CONSULTA = (r) => r.url.indexOf(':runQuery') !== -1;

/** A coleção que um `:commit` toca — todas as escritas dele são da mesma coleção nestes testes. */
function colecaoDoCommit(r) {
  const w = r.corpo.writes[0];
  const nome = w.update ? w.update.name : w.delete;
  return nome.split('/documents/')[1].split('/')[0];
}

function consultaPor(falso, campo) {
  return falso.requisicoes.filter(CONSULTA).map((r) => r.corpo.structuredQuery)
    .filter((q) => q.where && q.where.fieldFilter.field.fieldPath === campo);
}

/**
 * O cenário-base: a lista de ADS41 de sexta (L0) com Ana, Beatriz e o Carlos de
 * ADS31 cursando junto; a lista de ADS31 do mesmo semestre (L31), que traz o
 * Xavier — aluno de ADS41 pela linha; e a lista de ADS41 de segunda (L1) sem a
 * Beatriz e com a Duda nova.
 */
function cenario(amb) {
  const l0 = importar(amb, ADS41_2026_2, [ANA, BEATRIZ, CARLOS_DE_ADS31], { nome: 'ads41-sexta.csv' }).loteId;
  const l31 = importar(amb, ADS31_2026_2, [CARLOS_DE_ADS31, XAVIER_DE_ADS41], { nome: 'ads31.csv' }).loteId;
  const l1 = importar(amb, ADS41_2026_2, [ANA, CARLOS_DE_ADS31, DUDA], { nome: 'ads41-segunda.csv' }).loteId;
  return { l0, l31, l1 };
}

// ============================================================================

console.log('\n\x1b[1mUNICESUSC CESUTECH — a revisão de divergências (05c_Revisao.gs)\x1b[0m');

// ---------------------------------------------------------------- Contratos

grupo('Contratos — lista branca, token, tetos repetidos, uma declaração só');

teste('as duas estão na lista branca, e sem token nenhuma toca no banco', () => {
  const amb = ambiente();
  const lista = amb.api.funcoesDoPainel_();
  igual(typeof lista.revisarLote, 'function', 'revisarLote fora de funcoesDoPainel_');
  igual(typeof lista.aplicarRevisao, 'function', 'aplicarRevisao fora de funcoesDoPainel_');

  amb.zerar();
  [undefined, '', 'token-inventado', null].forEach((token) => {
    ['revisarLote', 'aplicarRevisao'].forEach((nome) => {
      const r = amb.api[nome]({ token: token, loteId: 'x', turma: 'ADS41', decisoes: [{ matricula: '9110001', acao: 'CANCELAR' }] });
      igual(r.ok, false, nome + ' respondeu ok com o token ' + JSON.stringify(token));
      verdadeiro(/Sess.o expirada/.test(r.erro), nome + ': ' + r.erro);
    });
  });
  igual(amb.falso.requisicoes.length, 0, 'alguma delas foi ao banco sem token');
});

teste('os tetos repetidos de 12_Disciplinas.gs são iguais, e a coleção de excluídos é declarada uma vez só', () => {
  const amb = ambiente();
  igual(amb.api.REVISAO_MAX_TURMA, amb.api.DISCIPLINAS_MAX_TURMA,
    'as duas telas cruzam a mesma turma e precisam cortar no mesmo lugar');
  igual(amb.api.REVISAO_MAX_CRUZAMENTO, amb.api.DISCIPLINAS_MAX_CRUZAMENTO);
  igual(amb.api.REVISAO_LOTE_MAXIMO, 100);

  // Uma segunda declaração venceria em silêncio (a última carregada manda), e
  // o Excluir passaria a escrever numa coleção que o backup não conhece.
  let declaracoes = 0;
  fs.readdirSync(PASTA_GS).filter((n) => n.slice(-3) === '.gs').forEach((n) => {
    const texto = fs.readFileSync(path.join(PASTA_GS, n), 'utf8');
    declaracoes += (texto.match(/^var MATRICULADOS_EXCLUIDOS_COLECAO\b/gm) || []).length;
  });
  igual(declaracoes, 1, 'MATRICULADOS_EXCLUIDOS_COLECAO declarada ' + declaracoes + ' vezes');
  verdadeiro(/MATRICULADOS_EXCLUIDOS_COLECAO/.test(FONTE), '05c não escreve na coleção de excluídos');
});

teste('só as duas públicas nascem sem sufixo — o resto do arquivo é interno', () => {
  const publicas = (FONTE.match(/^function ([a-zA-Z][\w$]*)\(/gm) || [])
    .map((l) => l.replace(/^function /, '').replace(/\($/, ''))
    .filter((n) => n.slice(-1) !== '_');
  igual(publicas.sort(), ['aplicarRevisao', 'revisarLote']);
});

// -------------------------------------------------------- Quem é candidato

grupo('revisarLote — a chave é a turma do lote, e a régua é o carimbo');

teste('quem estava como ADS41 e não veio no arquivo de ADS41 é candidato; quem veio com outra turma na linha, não', () => {
  // Mutação que derruba: comparar pela turma da LINHA em vez da do lote — o
  // Carlos (ADS31 cursando junto) some do "vieram" e a Beatriz deixa de ser a
  // única; ou trocar a régua por `lote_id !=` — a Duda e a Ana viram candidatas.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  amb.zerar();

  const r = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(r.ok, true, r.erro);
  igual(r.turma, 'ADS41');
  igual(r.semestre, '2026/2');
  igual(r.origemTurma, 'CABECALHO');
  igual(r.vieram, 2, 'Ana e Duda vieram como ADS41 (o Carlos veio como ADS31)');
  igual(r.candidatos, 1);
  igual(r.semProjeto.map((i) => i.matricula), ['9110002'], 'só a Beatriz não veio');
  igual(r.comProjeto, []);
  igual(r.semProjeto[0].nome, 'Beatriz Exemplo Martins');
  igual(r.semProjeto[0].matriculaOficial, '09110002', 'a forma oficial, com o zero, é a que a tela mostra');
  igual(r.semProjeto[0].lote.arquivo, 'ads41-sexta.csv', 'de onde ela veio pela última vez');
  igual(r.loteMaximo, 100);

  // A consulta é UMA igualdade em `turma`, com a chave do lote — em
  // `matriculados`; a outra igualdade em `turma` é a das fichas de `alunos`
  // (o cruzamento), também uma só.
  const consultas = consultaPor(amb.falso, 'turma');
  igual(consultas.map((q) => q.from[0].collectionId).sort(), ['alunos', 'matriculados']);
  consultas.forEach((q) => {
    igual(q.where.fieldFilter.value.stringValue, 'ADS41');
    igual(q.orderBy[0].field.fieldPath, '__name__', 'filtro num campo e ordem noutro pede índice composto');
  });
  igual(r.lidas.fichas, 0, 'sem reconciliação não há ficha nenhuma da turma');
});

teste('a lista ANTERIOR desta mesma turma, no mesmo semestre, é exatamente de onde o candidato vem', () => {
  // Mutação que derruba: classificar como "outra lista do semestre" todo
  // candidato cujo lote de origem tem o mesmo semestre, sem olhar a turma do
  // lote — a Beatriz (lista de sexta de ADS41, 2026/2) sumiria dos candidatos
  // em TODA reimportação dentro do semestre, e a revisão nunca acharia ninguém.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  const r = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(r.candidatos, 1, 'a Beatriz virou informação em vez de candidata');
  igual(r.outraListaDoSemestre.map((i) => i.matricula), ['9110009'],
    'o Xavier (ADS41 na linha, veio na lista de ADS31 do mesmo semestre) é informação');
  igual(r.outraListaDoSemestre[0].lote.arquivo, 'ads31.csv');
  igual(r.avisos.filter((a) => /outro semestre/.test(a)), [],
    'ninguém veio de outro semestre: o aviso não pode disparar');
});

teste('quem veio de lista de OUTRO semestre (ou sem semestre) é candidato, com o aviso de virada', () => {
  // Mutação que derruba: ignorar o semestre — o Xavier de 2026/1 viraria
  // "outra lista do semestre" e ninguém avisaria que as listas novas faltam.
  const amb = ambiente();
  importar(amb, ADS41_2026_2, [ANA, BEATRIZ], { nome: 'ads41-sexta.csv' });
  importar(amb, ADS31_2026_1, [CARLOS_DE_ADS31, XAVIER_DE_ADS41], { nome: 'ads31-semestre-passado.csv' });
  const l1 = importar(amb, ADS41_2026_2, [ANA, DUDA], { nome: 'ads41-segunda.csv' }).loteId;

  const r = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(r.candidatos, 2, 'Beatriz (mesma turma) e Xavier (semestre passado)');
  igual(r.outraListaDoSemestre, []);
  const aviso = r.avisos.filter((a) => /outro semestre/.test(a))[0];
  verdadeiro(aviso && aviso.indexOf('1 candidato(s)') === 0, 'o aviso conta só quem veio de outro semestre: ' + aviso);
  verdadeiro(aviso.indexOf('importe todas as listas antes de cancelar') !== -1, aviso);
});

teste('régua do carimbo: quem foi reimportado DEPOIS não é candidato deste lote, e o aviso manda revisar o mais novo', () => {
  // Mutação que derruba: `lote_id !== loteId` — a Beatriz reimportada na terça
  // continuaria "não veio" na revisão de segunda, e o cancelamento seria de
  // alguém que a secretaria acabou de reenviar.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  importar(amb, ADS41_2026_2, [ANA, BEATRIZ, DUDA], { nome: 'ads41-terca.csv' });

  const r = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(r.candidatos, 0);
  igual(r.emLoteMaisNovo, 3, 'Ana, Beatriz e Duda vieram na terça');
  verdadeiro(r.avisos.some((a) => /importação mais nova/.test(a) && /ADS41/.test(a)), r.avisos.join(' | '));
});

teste('o mesmo arquivo importado duas vezes dá os MESMOS candidatos nos dois lotes', () => {
  const amb = ambiente();
  const { l1 } = cenario(amb);
  const l1b = importar(amb, ADS41_2026_2, [ANA, CARLOS_DE_ADS31, DUDA], { nome: 'ads41-segunda.csv' }).loteId;

  const a = chamar(amb, 'revisarLote', { loteId: l1 });
  const b = chamar(amb, 'revisarLote', { loteId: l1b });
  igual(b.candidatos, 1);
  igual(b.semProjeto.map((i) => i.matricula), ['9110002']);
  // No lote de segunda, quem veio de novo na segunda importação é "mais novo";
  // a Beatriz continua sendo a única que está fora dos dois.
  igual(a.candidatos, 1);
  igual(a.emLoteMaisNovo, 2);
});

teste('já cancelados ficam fora dos candidatos, listados à parte e com as inscrições vivas', () => {
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1');
  const inscricao = inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p1');
  // A marca como o Aplicar a grava.
  amb.api.atualizarEmLote('matriculados', [{
    _id: '9110002', situacao_cadastro: 'CANCELADO', cancelado_em: '2026-09-20 10:00:00',
    cancelado_por: PROF, cancelado_lote_id: l1
  }]);

  const r = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(r.candidatos, 0);
  igual(r.jaCancelados.length, 1);
  igual(r.jaCancelados[0].matricula, '9110002');
  igual(r.jaCancelados[0].cancelado_por, PROF);
  igual(r.jaCancelados[0].inscricoes.map((i) => i.id), [inscricao], 'a inscrição viva é o que diz "ocupa vaga"');
});

teste('contarApenas não varre inscrições, e sem candidato nenhum não lê lotes', () => {
  // Mutação que derruba: ler os lotes sempre — o passo 3 de uma importação sem
  // divergência pagaria 50 leituras por nada; ou varrer as inscrições no
  // contarApenas — mais 275.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1');
  inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p1');

  amb.zerar();
  const com = chamar(amb, 'revisarLote', { loteId: l1, contarApenas: true });
  igual(com.candidatos, 1);
  igual(com.semProjeto, undefined, 'contarApenas não lista');
  igual(consultaPor(amb.falso, 'turma').length, 1);
  const semFiltro = amb.falso.requisicoes.filter(CONSULTA)
    .filter((r) => !r.corpo.structuredQuery.where);
  igual(semFiltro.length, 1, 'uma consulta sem filtro: a de lotes; a varredura de inscrições não pode ter saído');
  igual(semFiltro[0].corpo.structuredQuery.from[0].collectionId, 'lotes');
  igual(amb.falso.requisicoes.filter(ESCRITA).length, 0, 'leitura pura');

  // Sem ninguém anterior a este lote na turma, os lotes nem são lidos — eles
  // só servem para dizer de onde um candidato veio.
  const outro = ambiente();
  importar(outro, ADS41_2026_2, [ANA, BEATRIZ, DUDA], { nome: 'ads41-terca.csv' });
  const l2 = importar(outro, ADS41_2026_2, [ANA, BEATRIZ, DUDA], { nome: 'ads41-quarta.csv' }).loteId;
  outro.zerar();
  const zero = chamar(outro, 'revisarLote', { loteId: l2, contarApenas: true });
  igual(zero.candidatos, 0);
  igual(zero.vieram, 3);
  igual(outro.falso.requisicoes.filter(CONSULTA).length, 1, 'só a turma foi lida');
});

teste('"sumiram mais do que vieram" liga com 25 contra 5 e não com 3 contra 27', () => {
  const amb = ambiente();
  const trinta = turma(30, 'ADS41');
  importar(amb, ADS41_2026_2, trinta, { nome: 'ads41-sexta.csv' });
  const poucos = importar(amb, ADS41_2026_2, trinta.slice(0, 5), { nome: 'ads41-errada.csv' }).loteId;
  const r = chamar(amb, 'revisarLote', { loteId: poucos, contarApenas: true });
  igual(r.candidatos, 25);
  igual(r.vieram, 5);
  igual(r.sumiramMaisQueVieram, true);
  verdadeiro(r.avisos.some((a) => /Sumiram mais alunos do que vieram \(25 contra 5\)/.test(a)), r.avisos.join(' | '));

  const outro = ambiente();
  importar(outro, ADS41_2026_2, trinta, { nome: 'ads41-sexta.csv' });
  const quase = importar(outro, ADS41_2026_2, trinta.slice(3), { nome: 'ads41-segunda.csv' }).loteId;
  const s = chamar(outro, 'revisarLote', { loteId: quase, contarApenas: true });
  igual(s.candidatos, 3);
  igual(s.vieram, 27);
  igual(s.sumiramMaisQueVieram, false);
});

teste('com projeto: a lista B traz cada inscrição com id, projeto e fila — a mesma varredura de Disciplinas', () => {
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1', 'Robótica');
  projeto(amb, 'p2', 'Horta');
  const i1 = inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p1');
  const i2 = inscrever(amb, '09110002', 'Beatriz Exemplo Martins', 'p2', { projeto_nome: 'Horta', em_espera: 'SIM' });

  const r = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(r.semProjeto, []);
  igual(r.comProjeto.length, 1);
  igual(r.comProjeto[0].inscricoes.map((i) => i.id).sort(), [i1, i2].sort(),
    'a matrícula com zero à esquerda é a mesma pessoa');
  const emEspera = r.comProjeto[0].inscricoes.filter((i) => i.emEspera)[0];
  igual(emEspera.projetoNome, 'Horta');
  igual(emEspera.projetoId, 'p2');
  igual(r.lidas.inscricoes, 2);
  igual(r.truncado, false);
});

// ---------------------------------------------------------- Lote antigo

grupo('revisarLote — lote anterior ao cabeçalho: a turma vem das linhas, e NADA é gravado');

/** Um lote como os de antes de 21/09: sem campo de cabeçalho nenhum. */
function loteAntigo(amb, id, linhas) {
  amb.api.inserir('lotes', {
    criado_em: id.split('_')[0], arquivo: 'antigo.pdf', tipo: 'PDF', linhas: String(linhas.length),
    previstas: String(linhas.length), importado_em: '2026-08-01 09:00:00', importado_por: PROF,
    mapeamento_json: '{}', substituir_pedido: 'NAO', status: 'ATUALIZOU'
  }, id);
  amb.api.escreverEmLote('matriculados', linhas.map((l) => Object.assign({
    _id: l.matricula, lote_id: id, importado_em: '2026-08-01 09:00:00', importado_por: PROF,
    nome: 'Aluno ' + l.matricula, cpf: '', email: '', telefone: '', data_nascimento: '',
    curso: 'ADS', situacao: '', raw_json: '[]', matricula_oficial: ''
  }, l)));
}

teste('sem cabeçalho, a turma é a maioria das linhas que sobraram — origem LINHAS, e zero escritas', () => {
  // Mutação que derruba: gravar a turma deduzida no lote "para a próxima vez" —
  // `revisarLote` está em SO_LEITURA e é repetida/abortada pelo painel.
  // O lote de sexta, importado antes de 21/09 — o mais novo de ADS41, com um
  // aluno de ADS31 cursando junto; e o lote de junho, de onde o 9130009 não
  // voltou. A maioria só é confiável assim, no lote mais novo de cada turma:
  // num lote já substituído sobram restos, e a régua do carimbo é quem protege.
  const amb = ambiente();
  const junho = '20260601T120000000Z_000000';
  const velho = '20260801T120000000Z_aaaaaa';
  loteAntigo(amb, junho, [{ matricula: '9130009', turma: 'ADS41' }]);
  loteAntigo(amb, velho, [
    { matricula: '9130001', turma: 'ADS41' }, { matricula: '9130002', turma: 'ADS41' },
    { matricula: '9130003', turma: 'ADS41' }, { matricula: '9130004', turma: 'ADS41' },
    { matricula: '9130005', turma: 'ADS41' }, { matricula: '9130006', turma: 'ADS31' }
  ]);

  amb.zerar();
  const r = chamar(amb, 'revisarLote', { loteId: velho });
  igual(r.ok, true, r.erro);
  igual(r.turma, 'ADS41');
  igual(r.origemTurma, 'LINHAS');
  igual(r.origemDetalhe, '5 de 6 registros desta importação');
  verdadeiro(r.avisos.some((a) => /deduzida das linhas/.test(a) && /Reimportar o mesmo arquivo/.test(a)), r.avisos.join(' | '));
  igual(r.vieram, 5);
  igual(r.candidatos, 1);
  igual(r.semProjeto.map((i) => i.matricula), ['9130009']);
  igual(amb.falso.requisicoes.filter(ESCRITA).length, 0, 'revisarLote escreveu');
  igual(documento(amb.falso, 'lotes', velho).turma_cabecalho, undefined, 'a turma deduzida foi persistida');
});

teste('maioria fraca pede a turma (com sugestão); zero sobras diz que o lote foi reescrito; turma informada vale', () => {
  const amb = ambiente();
  const fraco = '20260801T120000000Z_bbbbbb';
  loteAntigo(amb, fraco, [
    { matricula: '9140001', turma: 'ADS41' }, { matricula: '9140002', turma: 'ADS41' },
    { matricula: '9140003', turma: 'ADS31' }
  ]);
  const r = chamar(amb, 'revisarLote', { loteId: fraco });
  igual(r.ok, false);
  igual(r.precisaTurma, true);
  igual(r.sugestao, 'ADS41', 'a sugestão é o palpite, nunca a chave');
  verdadeiro(/Informe a turma/.test(r.motivo), r.motivo);

  const vazio = '20260801T120000000Z_cccccc';
  loteAntigo(amb, vazio, []);
  const v = chamar(amb, 'revisarLote', { loteId: vazio });
  igual(v.precisaTurma, true);
  verdadeiro(/reescritos por importações mais novas/.test(v.motivo), v.motivo);

  const i = chamar(amb, 'revisarLote', { loteId: fraco, turma: ' ads 41 ' });
  igual(i.ok, true, i.erro);
  igual(i.turma, 'ADS41');
  igual(i.origemTurma, 'INFORMADA');
  igual(i.vieram, 2, 'os dois de ADS41 são deste lote — vieram, não candidatos');
  igual(i.candidatos, 0);
});

teste('turma informada igual à do lote não vira INFORMADA — o Consultar sem mexer continua sendo do arquivo', () => {
  const amb = ambiente();
  const { l1 } = cenario(amb);
  const r = chamar(amb, 'revisarLote', { loteId: l1, turma: 'ADS41' });
  igual(r.origemTurma, 'CABECALHO');
  const outra = chamar(amb, 'revisarLote', { loteId: l1, turma: 'ADS31' });
  igual(outra.origemTurma, 'INFORMADA');
  igual(outra.turma, 'ADS31');
});

// ---------------------------------------------------------------- Recusas

grupo('revisarLote — recusas, antes de custar');

teste('lote inexistente, PARCIAL, EXPURGADO e cabeçalho sem linha recusam com frase própria', () => {
  const amb = ambiente();
  const { l1 } = cenario(amb);

  const nada = chamar(amb, 'revisarLote', { loteId: 'nao-existe' });
  verdadeiro(/não encontrada/.test(nada.erro), nada.erro);
  igual(chamar(amb, 'revisarLote', { loteId: '' }).ok, false);

  amb.api.atualizar('lotes', l1, { status: 'PARCIAL', linhas: '1', previstas: '3' });
  const parcial = chamar(amb, 'revisarLote', { loteId: l1 });
  verdadeiro(/parou no meio \(1 de 3 gravados\)/.test(parcial.erro), parcial.erro);
  igual(chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] }).erro,
    parcial.erro, 'as duas recusam a mesma coisa com a mesma frase');

  amb.api.atualizar('lotes', l1, { status: 'EXPURGADO' });
  verdadeiro(/já foi apagada/.test(chamar(amb, 'revisarLote', { loteId: l1 }).erro));

  amb.api.atualizar('lotes', l1, { status: 'ATUALIZOU', linhas_da_turma: '0' });
  const semLinha = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(semLinha.ok, false);
  igual(semLinha.precisaTurma, true);
  verdadeiro(/cabeçalho do arquivo diz ADS41, mas nenhuma linha gravada é ADS41/.test(semLinha.motivo), semLinha.motivo);
  // Informar a turma passa por cima da recusa.
  igual(chamar(amb, 'revisarLote', { loteId: l1, turma: 'ADS41' }).ok, true);
});

teste('mais de 100 candidatos é sobra de semestre: recusa SEM ler lotes nem inscrições', () => {
  // Mutação que derruba: conferir o teto depois das varreduras — a recusa
  // custaria as 50 + 275 leituras que ela existe para poupar.
  const amb = ambiente();
  const velho = '20260701T120000000Z_dddddd';
  loteAntigo(amb, velho, turma(101, 'ADS41').map((l) => ({ matricula: l[0].replace(/.*\(0?(\d+)\).*/, '$1'), turma: 'ADS41' })));
  const novo = importar(amb, ADS41_2026_2, [ANA, BEATRIZ], { nome: 'ads41-nova.csv' }).loteId;

  amb.zerar();
  const r = chamar(amb, 'revisarLote', { loteId: novo });
  igual(r.ok, false);
  igual(r.candidatos, 101);
  verdadeiro(/Apagar matriculados/.test(r.erro), r.erro);
  igual(amb.falso.requisicoes.filter(CONSULTA).length, 1, 'só a turma foi lida');
});

// ------------------------------------------------------------ aplicarRevisao

grupo('aplicarRevisao — CANCELAR grava a marca, EXCLUIR move, e a inscrição é anulada primeiro');

teste('CANCELAR: exatamente quatro campos mudam, num commit com máscara; a matrícula some do formulário', () => {
  // Mutação que derruba: gravar por `escreverEmLote` (substituição inteira) —
  // nome, cpf e raw_json sumiriam; ou por `atualizar` um a um — N PATCHes.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  const antes = documento(amb.falso, 'matriculados', '9110002');
  const versaoAntes = amb.api.ler('matriculados', '9110002')._versao;
  igual(amb.api.matriculaConhecida('09110002'), true);

  amb.zerar();
  const r = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '09110002', acao: 'CANCELAR' }]
  });
  igual(r.ok, true, r.erro);
  igual(r.cancelados, 1);
  igual(r.excluidos, 0);
  igual(r.anuladas, 0);
  igual(r.precisaReconciliar, true);

  const depois = documento(amb.falso, 'matriculados', '9110002');
  const mudaram = Object.keys(depois).filter((k) => depois[k] !== antes[k]).sort();
  igual(mudaram, ['cancelado_em', 'cancelado_lote_id', 'cancelado_por', 'situacao_cadastro']);
  igual(depois.situacao_cadastro, 'CANCELADO');
  igual(depois.cancelado_por, PROF, 'quem mexeu vem da sessão, nunca de Session.getActiveUser');
  igual(depois.cancelado_lote_id, l1);
  igual(depois.nome, antes.nome);
  igual(depois.raw_json, antes.raw_json);
  igual(depois.lote_id, antes.lote_id, 'lote_id não é tocado: é o que o expurgo lê');

  const commits = amb.falso.requisicoes.filter(COMMIT).filter((c) => colecaoDoCommit(c) === 'matriculados');
  igual(commits.length, 1);
  igual(commits[0].corpo.writes[0].updateMask.fieldPaths.sort(),
    ['cancelado_em', 'cancelado_lote_id', 'cancelado_por', 'situacao_cadastro']);
  // A precondição é a VERSÃO que a releitura trouxe (o `updateTime` do banco),
  // e não `exists:true` — é o que faz o patch recusar um documento reescrito
  // no meio do Aplicar (teste da corrida, abaixo).
  igual(commits[0].corpo.writes[0].currentDocument, { updateTime: versaoAntes });
  verdadeiro(amb.api.ler('matriculados', '9110002')._versao !== versaoAntes, 'o patch não trocou a versão do documento');

  igual(amb.api.matriculaConhecida('09110002'), false, 'cancelado é "não encontrada" para o formulário');
});

teste('corrida DENTRO do Aplicar: reimportada entre a releitura e o patch, a pessoa NÃO é cancelada', () => {
  // Mutação que derruba: `currentDocument: { exists: true }` (patch sem
  // `_versao`) — o documento NOVO, com o lote_id da reimportação, receberia a
  // marca: a pessoa está na lista oficial mais nova e fica fora do formulário,
  // e nenhuma revisão a mostraria (para o lote novo ela "veio"; para o velho é
  // "mais nova"). A janela existe de verdade: entre a releitura e o patch
  // rodam a varredura e a anulação sequencial, segundos a minutos.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1');
  const inscricao = inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p1');

  // A reimportação cai no meio do Aplicar: logo depois da varredura (a função
  // é resolvida pelo global do sandbox, então trocá-la aqui troca para o 05c).
  const varredura = amb.api.varrerInscricoes_;
  let loteNovo = null;
  amb.api.varrerInscricoes_ = (teto) => {
    const v = varredura(teto);
    loteNovo = importar(amb, ADS41_2026_2, [ANA, BEATRIZ, CARLOS_DE_ADS31, DUDA], { nome: 'ads41-terca.csv' }).loteId;
    return v;
  };

  const r = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }]
  });
  amb.api.varrerInscricoes_ = varredura;

  igual(r.ok, false);
  verdadeiro(/lista da tela é de antes/.test(r.erro), r.erro);
  igual(r.cancelados, 0);
  igual(r.anuladas, 1, 'a anulação veio antes e é relatada: a pessoa reimportada fica sem a inscrição');
  verdadeiro(r.erro.indexOf('9110002') === -1 && r.erro.indexOf('projects/') === -1, 'a matrícula vazou na frase');

  const doc = documento(amb.falso, 'matriculados', '9110002');
  igual(doc.lote_id, loteNovo, 'o documento é o da reimportação');
  igual(doc.situacao_cadastro, undefined, 'a marca foi gravada por cima do documento novo');
  igual(amb.api.matriculaConhecida('9110002'), true, 'quem está na lista mais nova saiu do formulário');
  igual(documento(amb.falso, 'inscricoes', inscricao), null);
  igual(registrosDoLog(amb.falso, 'LOTE_REVISADO').length, 0, 'um Aplicar recusado não é revisão');
  igual(registrosDoLog(amb.falso, 'LOTE_REVISADO_PARCIAL').length, 1, 'mas a anulação que entrou deixa a trilha parcial');
  igual(r.parcial.anuladas.map((a) => a.matricula), ['9110002'], 'a resposta diz de QUEM era a inscrição anulada');

  // O mesmo para EXCLUIR: o delete leva a versão relida, e o documento novo fica.
  const outro = ambiente();
  const c2 = cenario(outro);
  const varredura2 = outro.api.varrerInscricoes_;
  outro.api.varrerInscricoes_ = (teto) => {
    const v = varredura2(teto);
    importar(outro, ADS41_2026_2, [ANA, BEATRIZ, CARLOS_DE_ADS31, DUDA], { nome: 'ads41-terca.csv' });
    return v;
  };
  const e = chamar(outro, 'aplicarRevisao', {
    loteId: c2.l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'EXCLUIR' }]
  });
  outro.api.varrerInscricoes_ = varredura2;
  igual(e.ok, false);
  igual(e.excluidos, 0);
  verdadeiro(documento(outro.falso, 'matriculados', '9110002') !== null, 'o EXCLUIR apagou o documento reimportado');
  verdadeiro(documento(outro.falso, 'matriculados_excluidos', '9110002') !== null,
    'a cópia foi feita antes do delete recusado — sobra uma cópia, nunca falta uma pessoa');
  const apaga = outro.falso.requisicoes.filter(COMMIT).filter((c) => colecaoDoCommit(c) === 'matriculados')
    .map((c) => c.corpo.writes[0]).filter((w) => w.delete)[0];
  verdadeiro(apaga && apaga.currentDocument && apaga.currentDocument.updateTime, 'o delete saiu sem a versão relida');
});

teste('CANCELAR repetido é idempotente: já cancelado, zero commits, e nada no log', () => {
  // Mutação que derruba: recarimbar quem já tem a marca — `cancelado_em` mudaria
  // e a trilha diria que a pessoa foi cancelada duas vezes.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  const decisoes = [{ matricula: '9110002', acao: 'CANCELAR' }];
  chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: decisoes });
  const carimbo = documento(amb.falso, 'matriculados', '9110002').cancelado_em;
  const linhas = registrosDoLog(amb.falso, 'LOTE_REVISADO').length;

  amb.relogio.avancar(60 * 1000);
  amb.zerar();
  const r = chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: decisoes });
  igual(r.ok, true);
  igual(r.cancelados, 0);
  igual(r.jaCancelados, 1);
  verdadeiro(/já estava feito/.test(r.mensagem), r.mensagem);
  igual(amb.falso.requisicoes.filter(ESCRITA).length, 0, 'reaplicar escreveu alguma coisa');
  igual(documento(amb.falso, 'matriculados', '9110002').cancelado_em, carimbo);
  igual(registrosDoLog(amb.falso, 'LOTE_REVISADO').length, linhas, '"nada a fazer" não é revisão');
});

teste('EXCLUIR: a cópia com o mesmo id existe ANTES do apagar, com excluido_*; o original some', () => {
  // Mutação que derruba: apagar e depois copiar — morrer no meio perde a pessoa.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  const original = documento(amb.falso, 'matriculados', '9110002');

  amb.zerar();
  const r = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'EXCLUIR' }]
  });
  igual(r.ok, true, r.erro);
  igual(r.excluidos, 1);
  igual(documento(amb.falso, 'matriculados', '9110002'), null, 'o original ficou');

  const copia = documento(amb.falso, 'matriculados_excluidos', '9110002');
  verdadeiro(copia !== null, 'a cópia não existe');
  igual(copia.nome, original.nome);
  igual(copia.raw_json, original.raw_json);
  igual(copia.lote_id, original.lote_id);
  igual(copia.excluido_por, PROF);
  igual(copia.excluido_lote_id, l1);
  verdadeiro(Boolean(copia.excluido_em));

  const commits = amb.falso.requisicoes.filter(COMMIT).map(colecaoDoCommit);
  verdadeiro(commits.indexOf('matriculados_excluidos') < commits.indexOf('matriculados'),
    'a ordem tem de ser copia-depois-apaga: ' + commits.join(' > '));
  igual(amb.api.matriculaConhecida('9110002'), false);
});

teste('EXCLUIR apaga a ficha órfã em alunos — achada por matricula_id, e só quando ficou sem origem', () => {
  // Quatro fichas de quatro excluídos: a só-matriculada some; a que tinha
  // inscrição pela matrícula (anulada agora) some; a cuja inscrição não tem
  // matrícula (casou por e-mail) FICA — a inscrição da Clara não é anulada
  // (as fichas não decidem anulação), então a ficha ainda tem origem e a
  // rodada seguinte a recalcula; a que aponta uma inscrição já anulada à mão
  // depois da última rodada (ficha velha, inscrição que não existe) FICA —
  // não foi este Aplicar que a deixou órfã.
  // Mutação que derruba: apagar sem conferir a inscrição — a terceira e a
  // quarta sumiriam; ou seguir a ficha da Clara na anulação — a inscrição dela
  // sumiria e a ficha iria junto.
  const amb = ambiente();
  const l0 = importar(amb, ADS41_2026_2, [
    ['ANA EXEMPLO (09110001)', 'ADS41'], ['BEATRIZ EXEMPLO (09110002)', 'ADS41'],
    ['CLARA EXEMPLO (09110003)', 'ADS41'], ['DUDA EXEMPLO (09110004)', 'ADS41'],
    ['FLAVIA EXEMPLO (09110006)', 'ADS41']
  ], { nome: 'ads41-sexta.csv' }).loteId;
  const l1 = importar(amb, ADS41_2026_2, [
    ['DUDA EXEMPLO (09110004)', 'ADS41'], ['EVA EXEMPLO (09110005)', 'ADS41']
  ], { nome: 'ads41-segunda.csv' }).loteId;
  projeto(amb, 'p1');
  const daBeatriz = inscrever(amb, '9110002', 'Beatriz Exemplo', 'p1');
  const daClara = amb.api.gravarInscricao({
    matricula: '', nome: 'Clara Exemplo', email: 'clara@exemplo.com', projeto_id: 'p1', projeto_nome: 'Robótica', origem: 'SITE'
  }).id;
  const daFlavia = inscrever(amb, '9110006', 'Flavia Exemplo', 'p1');
  // O e-mail da Clara na lista oficial é o que faz a cascata casá-la.
  amb.api.atualizar('matriculados', '9110003', { email: 'clara@exemplo.com' });
  amb.api.reconciliar();
  // A da Flávia foi anulada pelo Auditório DEPOIS da rodada: a ficha ainda a aponta.
  igual(amb.api.anularInscricoes({ token: amb.token, ids: [daFlavia] }).anuladas, 1);

  igual(idsDe(amb.falso, 'alunos').length, 6, 'uma ficha por matriculada; a Clara casou pelo e-mail');
  const fichaDe = (m) => amb.api.listar('alunos', { campo: 'matricula_id', valor: m }).itens[0];
  igual(fichaDe('9110002').inscricao_id, daBeatriz);
  igual(fichaDe('9110003').inscricao_id, daClara, 'a Clara casou pelo e-mail');
  igual(fichaDe('9110006').inscricao_id, daFlavia, 'a ficha da Flávia ainda aponta a inscrição anulada');
  verdadeiro(fichaDe('9110003')._id !== amb.api.chaveAluno_('mat:9110003'),
    'a ficha de quem casou por e-mail não mora no endereço derivado da matrícula');

  const r = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41',
    decisoes: [
      { matricula: '9110001', acao: 'EXCLUIR' }, { matricula: '9110002', acao: 'EXCLUIR' },
      { matricula: '9110003', acao: 'EXCLUIR' }, { matricula: '9110006', acao: 'EXCLUIR' }
    ]
  });
  igual(r.ok, true, r.erro);
  igual(r.excluidos, 4);
  igual(r.anuladas, 1, 'só a da Beatriz (matrícula); a da Clara não tem a matrícula e a da Flávia já não existia');
  igual(r.fichasApagadas, 2);
  igual(fichaDe('9110001'), undefined, 'a ficha só-matriculada ficou');
  igual(fichaDe('9110002'), undefined, 'a ficha da Beatriz (inscrição anulada) ficou');
  verdadeiro(fichaDe('9110003') !== undefined, 'a ficha da Clara sumiu com a inscrição dela viva');
  verdadeiro(fichaDe('9110006') !== undefined, 'a ficha da Flávia sumiu sem ter sido este Aplicar a deixá-la órfã');
  verdadeiro(documento(amb.falso, 'inscricoes', daClara) !== null, 'a inscrição da Clara, casada por e-mail, foi anulada');
  igual(idsDe(amb.falso, 'matriculados'), ['9110004', '9110005']);
  verdadeiro(l0.length > 0);
});

teste('inscrição casada por e-mail (sem matrícula) NÃO é anulada: é "possível" na linha do candidato, e a vaga fica', () => {
  // Mutação que derruba: seguir a ficha de `alunos` na anulação (a ponte que
  // existiu até a rodada 2 de 21/09) — a inscrição sem matrícula sumiria e a
  // pessoa iria para "com projeto"; ou esquecer `possiveis` — a coordenação
  // não saberia que existe uma inscrição a conferir no Geral.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  amb.api.atualizar('matriculados', '9110002', { email: 'beatriz@exemplo.com' });
  projeto(amb, 'p1', 'Robótica');
  projeto(amb, 'p2', 'Horta');
  const semMatricula = amb.api.gravarInscricao({
    matricula: '', nome: 'Beatriz Exemplo Martins', email: 'beatriz@exemplo.com',
    projeto_id: 'p1', projeto_nome: 'Robótica', origem: 'SITE'
  }).id;
  const segunda = amb.api.gravarInscricao({
    matricula: '', nome: 'Beatriz Exemplo Martins', email: 'beatriz@exemplo.com',
    projeto_id: 'p2', projeto_nome: 'Horta', origem: 'SITE'
  }).id;
  amb.api.reconciliar();
  igual(amb.api.listar('alunos', { campo: 'matricula_id', valor: '9110002' }).itens[0].metodo_match, 'E-mail');

  amb.zerar();
  const r = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(r.comProjeto, [], 'sem inscrição COM a matrícula, ninguém é "com projeto"');
  igual(r.semProjeto.map((i) => i.matricula), ['9110002']);
  igual(r.semProjeto[0].inscricoes, [], 'nada a anular');
  // A ficha aponta a primeira; a segunda (mesmo e-mail, outro projeto) não é
  // endereçada por ficha nenhuma e fica de fora até a rodada seguinte — é a
  // limitação escrita no cabeçalho.
  igual(r.semProjeto[0].possiveis.map((p) => [p.id, p.projetoNome, p.casadaPor, p.status]),
    [[semMatricula, 'Robótica', 'E-mail', 'CONFIRMADO']]);
  verdadeiro(r.lidas.fichas >= 1);
  // UMA consulta em `alunos`, pela turma — não uma por candidato.
  igual(consultaPor(amb.falso, 'turma').filter((q) => q.from[0].collectionId === 'alunos').length, 1);
  igual(consultaPor(amb.falso, 'matricula_id').length, 0, 'consulta por candidato custa uma ida cada');

  igual(amb.api.contarInscritos_('p1'), 1);
  amb.zerar();
  const a = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }]
  });
  igual(a.ok, true, a.erro);
  igual(a.cancelados, 1);
  igual(a.anuladas, 0, 'a inscrição sem a matrícula não é da revisão anular');
  verdadeiro(documento(amb.falso, 'inscricoes', semMatricula) !== null, 'a inscrição casada por e-mail foi anulada');
  verdadeiro(documento(amb.falso, 'inscricoes', segunda) !== null);
  igual(amb.api.contarInscritos_('p1'), 1);
  igual(amb.api.contarInscritos_('p2'), 1);
  igual(consultaPor(amb.falso, 'turma').filter((q) => q.from[0].collectionId === 'alunos').length, 0,
    'o Aplicar leu as fichas: elas não decidem nada, e cada ida custa');

  // Pela matrícula a inscrição entra em `inscricoes`, sem "casadaPor": veio
  // pelo caminho normal, e é anulada.
  const outro = ambiente();
  const c = cenario(outro);
  projeto(outro, 'p1');
  const pelaMatricula = inscrever(outro, '9110002', 'Beatriz Exemplo Martins', 'p1');
  outro.api.reconciliar();
  const pela = chamar(outro, 'revisarLote', { loteId: c.l1 });
  igual(pela.comProjeto[0].inscricoes.map((i) => i.id), [pelaMatricula]);
  igual(pela.comProjeto[0].inscricoes[0].casadaPor, undefined, 'o campo morreu com a ponte');
  igual(pela.comProjeto[0].possiveis, [], 'a inscrição que VAI ser anulada não é "possível"');
});

teste('a ficha DIVERGENCIA (nome exato, nome parecido, CPF diverge) e a resolvida à mão não anulam a inscrição de OUTRA pessoa', () => {
  // O cenário dos achados 1, 4 e 7 da rodada 2: a Beatriz da lista não veio;
  // uma HOMÔNIMA da comunidade (sem matrícula, e-mail próprio) se inscreveu, e
  // a cascata ligou as duas por 'Nome exato' — DIVERGENCIA, "precisa de
  // gente". Com a ponte das fichas, CANCELAR a Beatriz anulava a inscrição da
  // homônima e a vaga dela ia para a fila; a homônima, fora da lista, não
  // voltava por "Incluir aluno". Mutação que derruba: seguir a ficha
  // (qualquer status) na anulação; ou apontar como "possível" a ficha que a
  // coordenação já resolveu como "não é a mesma pessoa".
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1', 'Robótica');
  const daHomonima = amb.api.gravarInscricao({
    matricula: '', nome: 'Beatriz Exemplo Martins', email: 'outra.pessoa@exemplo.com',
    projeto_id: 'p1', projeto_nome: 'Robótica', origem: 'SITE'
  }).id;
  amb.api.reconciliar();
  const ficha = () => amb.api.listar('alunos', { campo: 'matricula_id', valor: '9110002' }).itens[0];
  igual(ficha().status, 'DIVERGENCIA');
  igual(ficha().metodo_match, 'Nome exato');
  igual(ficha().inscricao_id, daHomonima);

  // Antes de a coordenação decidir: informação, com o degrau e a divergência.
  const antes = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(antes.comProjeto, []);
  igual(antes.semProjeto[0].inscricoes, []);
  igual(antes.semProjeto[0].possiveis.map((p) => [p.id, p.casadaPor, p.status]), [[daHomonima, 'Nome exato', 'DIVERGENCIA']]);

  // A coordenação resolve à mão: não é a mesma pessoa. A ficha mantém os dois
  // ids (é assim que `resolverAluno` grava), e a decisão tem de mandar.
  igual(amb.api.resolverAluno({ token: amb.token, id: ficha()._id, status: 'SO_INSCRITO', observacoes: 'homônima' }).ok, true);
  igual(ficha().status, 'SO_INSCRITO');
  igual(ficha().inscricao_id, daHomonima, 'resolver à mão não tira o id da inscrição');
  const depois = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(depois.semProjeto[0].possiveis, [], 'a ficha resolvida como "não é a mesma pessoa" ainda é apontada');

  igual(amb.api.contarInscritos_('p1'), 1);
  const cancelar = chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] });
  igual(cancelar.ok, true, cancelar.erro);
  igual(cancelar.cancelados, 1);
  igual(cancelar.anuladas, 0);
  verdadeiro(documento(amb.falso, 'inscricoes', daHomonima) !== null, 'a inscrição da homônima foi anulada');
  igual(amb.api.contarInscritos_('p1'), 1, 'a vaga da homônima foi liberada');

  // EXCLUIR, na mesma família: a inscrição fica e a ficha da outra pessoa
  // também (tem origem viva).
  const outro = ambiente();
  const c = cenario(outro);
  projeto(outro, 'p1', 'Robótica');
  const daParecida = outro.api.gravarInscricao({
    matricula: '', nome: 'Beatriz Exemplo Martinez', email: 'martinez@exemplo.com',
    projeto_id: 'p1', projeto_nome: 'Robótica', origem: 'SITE'
  }).id;
  outro.api.reconciliar();
  const fichaDela = outro.api.listar('alunos', { campo: 'matricula_id', valor: '9110002' }).itens[0];
  verdadeiro(/^Nome aproximado/.test(fichaDela.metodo_match), fichaDela.metodo_match);
  const excluir = chamar(outro, 'aplicarRevisao', { loteId: c.l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'EXCLUIR' }] });
  igual(excluir.ok, true, excluir.erro);
  igual(excluir.excluidos, 1);
  igual(excluir.anuladas, 0);
  igual(excluir.fichasApagadas, 0, 'a ficha da outra pessoa foi apagada');
  verdadeiro(documento(outro.falso, 'inscricoes', daParecida) !== null);
  verdadeiro(documento(outro.falso, 'alunos', fichaDela._id) !== null);
});

teste('as inscrições são anuladas PRIMEIRO, pela quarentena de verdade, e a vaga volta', () => {
  // Mutação que derruba: cancelar antes de anular — o commit em `matriculados`
  // sairia antes do de `inscricoes_anuladas`.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1');
  const inscricao = inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p1');
  igual(amb.api.contarInscritos_('p1'), 1);

  amb.zerar();
  const r = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }]
  });
  igual(r.ok, true, r.erro);
  igual(r.anuladas, 1);
  igual(r.cancelados, 1);

  const commits = amb.falso.requisicoes.filter(COMMIT).map(colecaoDoCommit);
  igual(commits, ['inscricoes_anuladas', 'inscricoes', 'matriculados'],
    'quarentena, apaga, e só então a marca');
  verdadeiro(documento(amb.falso, 'inscricoes_anuladas', inscricao) !== null, 'a cópia não está na quarentena');
  igual(documento(amb.falso, 'inscricoes_anuladas', inscricao).anulado_por, PROF);
  igual(documento(amb.falso, 'inscricoes', inscricao), null);
  igual(amb.api.contarInscritos_('p1'), 0, 'a vaga não foi liberada');
  igual(registrosDoLog(amb.falso, 'INSCRICOES_ANULADAS').length, 1, 'a linha da anulação é a do Auditório');
});

teste('a inscrição a anular é descoberta no Aplicar: a feita entre abrir a janela e clicar vai junto', () => {
  // Mutação que derruba: anular só o que a tela mandou — a inscrição de dez
  // segundos atrás ficaria viva por baixo da marca, ocupando vaga.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1');
  const tela = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(tela.semProjeto[0].inscricoes, [], 'a janela abriu com a Beatriz sem projeto');

  const tardia = inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p1');
  const r = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR', inscricoes: [] }]
  });
  igual(r.anuladas, 1);
  igual(documento(amb.falso, 'inscricoes', tardia), null);
});

teste('anulação recusada = nada cancelado, nada excluído — e a resposta diz que nada mais foi feito', () => {
  // A rede cai exatamente no primeiro `:commit` (o da quarentena). Mutação que
  // derruba: cancelar antes de anular — a marca já estaria gravada.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1');
  inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p1');

  const real = amb.api.UrlFetchApp;
  let derrubadas = 0;
  amb.api.UrlFetchApp = {
    fetch(url, opcoes) {
      if (String(url).indexOf(':commit') !== -1 && derrubadas === 0) {
        derrubadas++;
        throw new Error('Address unavailable: firestore.googleapis.com');
      }
      return real.fetch(url, opcoes);
    },
    fetchAll: (lote) => real.fetchAll(lote)
  };

  const r = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41',
    decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }, { matricula: '9110001', acao: 'EXCLUIR' }]
  });
  igual(r.ok, false);
  verdadeiro(/anulação das inscrições falhou e nada mais foi feito/.test(r.erro), r.erro);
  igual(r.cancelados, 0);
  igual(r.excluidos, 0);
  igual(derrubadas, 1);
  igual(documento(amb.falso, 'matriculados', '9110002').situacao_cadastro, undefined, 'cancelou antes de anular');
  verdadeiro(documento(amb.falso, 'matriculados', '9110001') !== null, 'excluiu antes de anular');
  igual(registrosDoLog(amb.falso, 'LOTE_REVISADO'), []);
  igual(registrosDoLog(amb.falso, 'LOTE_REVISADO_PARCIAL'), [], 'nada foi escrito: a trilha parcial não tem o que dizer');
  igual(r.parcial, undefined, 'a recusa antes da primeira escrita não é "parcial"');
});

teste('já cancelado: nenhuma ação — nem CANCELAR nem EXCLUIR tocam a inscrição que ele ganhou DEPOIS da marca', () => {
  // O achado 2 da rodada 2: a coordenação cancelou a Beatriz e DEPOIS a
  // incluiu num projeto pelo Alunos, com o aviso de CANCELADA na tela — é
  // deliberado. Um Aplicar com as mesmas decisões (janela estagnada, replay)
  // anulava essa inscrição. Mutação que derruba: juntar `jaCancelados` aos que
  // têm inscrição anulada; ou mandar o já cancelado para `excluir` quando a
  // ação é EXCLUIR.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1', 'Robótica');
  chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] });
  const carimbo = documento(amb.falso, 'matriculados', '9110002').cancelado_em;

  const incluida = amb.api.incluirInscricao({
    token: amb.token, matricula: '9110002', nome: 'Beatriz Exemplo Martins', email: 'beatriz@exemplo.com',
    projeto_id: 'p1', motivo: 'voltou a cursar'
  });
  igual(incluida.ok, true, incluida.erro);
  verdadeiro(/CANCELADA na lista oficial/.test(incluida.aviso), 'a inclusão de um cancelado avisa: ' + incluida.aviso);
  igual(amb.api.contarInscritos_('p1'), 1);

  amb.zerar();
  const r = chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] });
  igual(r.ok, true);
  igual(r.jaCancelados, 1);
  igual(r.cancelados, 0);
  igual(r.anuladas, 0, 'a inscrição incluída depois da marca foi anulada');
  verdadeiro(/já estava feito/.test(r.mensagem), r.mensagem);
  verdadeiro(documento(amb.falso, 'inscricoes', incluida.id) !== null);
  igual(amb.api.contarInscritos_('p1'), 1);
  igual(documento(amb.falso, 'matriculados', '9110002').cancelado_em, carimbo);
  igual(amb.falso.requisicoes.filter(ESCRITA).length, 0, 'já cancelado escreveu alguma coisa');

  const e = chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'EXCLUIR' }] });
  igual(e.ok, true);
  igual(e.jaCancelados, 1);
  igual(e.excluidos, 0);
  igual(e.anuladas, 0);
  verdadeiro(documento(amb.falso, 'matriculados', '9110002') !== null, 'EXCLUIR apagou um já cancelado');
  igual(documento(amb.falso, 'matriculados_excluidos', '9110002'), null);
  verdadeiro(documento(amb.falso, 'inscricoes', incluida.id) !== null);

  // O LOTE MISTO é o que exercita a linha de verdade: sozinho, o já cancelado
  // sai no "Nada a fazer" antes do passo da anulação, e a mutação "juntar
  // `jaCancelados` aos anulados" sobrevive sem que nenhuma linha a rode. Com
  // um candidato VIVO na mesma chamada, o passo roda — e é aí que a inscrição
  // deliberada da Beatriz tem de ficar de pé enquanto a do Felipe cai.
  const FELIPE = ['FELIPE EXEMPLO (09110005)', 'ADS41'];
  importar(amb, ADS41_2026_2, [ANA, CARLOS_DE_ADS31, DUDA, FELIPE], { nome: 'ads41-terca.csv' });
  const l3 = importar(amb, ADS41_2026_2, [ANA, CARLOS_DE_ADS31, DUDA], { nome: 'ads41-quarta.csv' }).loteId;
  const doFelipe = inscrever(amb, '9110005', 'Felipe Exemplo', 'p1');
  igual(amb.api.contarInscritos_('p1'), 2);

  amb.zerar();
  const misto = chamar(amb, 'aplicarRevisao', { loteId: l3, turma: 'ADS41', decisoes: [
    { matricula: '9110005', acao: 'CANCELAR' }, { matricula: '9110002', acao: 'CANCELAR' }
  ] });
  igual(misto.ok, true, misto.erro);
  igual(misto.cancelados, 1, 'o Felipe tinha de ser cancelado');
  igual(misto.jaCancelados, 1, 'a Beatriz tinha de ser contada como já cancelada');
  igual(misto.anuladas, 1, 'só a inscrição do Felipe podia cair — caíram ' + misto.anuladas);
  igual(documento(amb.falso, 'inscricoes', doFelipe), null, 'a inscrição do Felipe ficou viva');
  verdadeiro(documento(amb.falso, 'inscricoes', incluida.id) !== null,
    'no lote misto, a inscrição deliberada da Beatriz foi anulada junto com a do Felipe');
  igual(amb.api.contarInscritos_('p1'), 1);
  igual(documento(amb.falso, 'matriculados', '9110002').cancelado_em, carimbo, 'recarimbou o já cancelado');
});

// ------------------------------------------------- O que sai, e a trilha parcial

grupo('aplicarRevisao — nenhum caminho de documento sai; o Aplicar interrompido deixa trilha');

teste('a recusa de anularInscricoes chega à tela e ao log SEM o caminho do documento (D-27 no ramo da anulação)', () => {
  // O achado 3 da rodada 2: o primeiro `:commit` (o da quarentena) responde
  // 400 com o nome do documento inteiro — 'projects/<id do projeto>/...' — e
  // `an.erro` ia cru para a resposta. O id de inscrição é hash, mas o id do
  // projeto Cloud é "o começo da trilha para quem quiser sondar" (02_Repo.gs).
  // São DUAS réguas em camadas — `semCaminhoDeDocumento_` no catch de
  // `anularInscricoes` (13) e `fraseSegura_(an.erro)` aqui — e cada uma cobre
  // a outra: tirar UMA sozinha não muda o que este teste vê. A mutação que
  // este teste derruba é tirar as duas (ou a primitiva em 02_Repo.gs). A
  // camada do 13 tem teste PRÓPRIO em auditorio.js, porque o Geral chama
  // `anularInscricoes` direto, sem passar por aqui.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1');
  inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p1');

  const real = amb.api.UrlFetchApp;
  amb.api.UrlFetchApp = {
    fetch(url, opcoes) {
      if (String(url).indexOf(':commit') !== -1) {
        return {
          getResponseCode: () => 400,
          getContentText: () => JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT',
            message: 'Document name "projects/meu-projeto-123/databases/(default)/documents/inscricoes_anuladas/abc" lacks a valid id' } }),
          getHeaders: () => ({})
        };
      }
      return real.fetch(url, opcoes);
    },
    fetchAll: (lote) => real.fetchAll(lote)
  };

  const r = chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] });
  igual(r.ok, false);
  verdadeiro(/anulação das inscrições falhou e nada mais foi feito/.test(r.erro), r.erro);
  igual(r.erro.indexOf('projects/'), -1, 'o caminho vazou na resposta: ' + r.erro);
  igual(r.erro.indexOf('meu-projeto-123'), -1, r.erro);
  verdadeiro(r.erro.indexOf('(documento)') !== -1, 'o caminho tem de virar "(documento)", não sumir: ' + r.erro);
  verdadeiro(amb.registros.erros.length >= 1, 'a falha não foi ao log de execução');
  verdadeiro(amb.registros.erros.every((e) => e.indexOf('projects/') === -1 && e.indexOf('meu-projeto-123') === -1),
    'o caminho vazou no log de execução: ' + amb.registros.erros.join(' | '));
  igual(documento(amb.falso, 'matriculados', '9110002').situacao_cadastro, undefined);
  igual(registrosDoLog(amb.falso, 'LOTE_REVISADO_PARCIAL'), [], 'nada foi feito: não é trilha parcial');
});

teste('Aplicar recusado DEPOIS de anular deixa a trilha parcial: quem perdeu a inscrição, na resposta e no log', () => {
  // O achado 6 da rodada 2: a Beatriz é reimportada entre a releitura e o
  // patch; a inscrição dela já foi anulada, o patch é recusado e a resposta
  // dizia só `anuladas:1` — sem QUEM. A pessoa está na lista mais nova, sem
  // vaga e sem aviso. Mutação que derruba: `catch` só com contadores; log só
  // no caminho de sucesso; marca do lote/cache/marca da reconciliação só no
  // sucesso.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1', 'Robótica');
  projeto(amb, 'p2', 'Horta');
  const i1 = inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p1');
  const i2 = inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p2', { projeto_nome: 'Horta' });
  amb.propriedades.set('painel_reconciliacao', JSON.stringify({
    inscricoes: 3, matriculados: 5, em: '2026-09-21 09:00:00', dia: '2026-09-21', gasto: 1200, custo: 300
  }));
  amb.api.CacheService.getScriptCache().put('painel_estatisticas', '{"ok":true,"velho":1}', 30);

  const varredura = amb.api.varrerInscricoes_;
  amb.api.varrerInscricoes_ = (teto) => {
    const v = varredura(teto);
    importar(amb, ADS41_2026_2, [ANA, BEATRIZ, CARLOS_DE_ADS31, DUDA], { nome: 'ads41-terca.csv' });
    // Armados DEPOIS da reimportação, de propósito: `importar` avança o relógio
    // 60 s (o cache de 30 s expiraria sozinho) e `confirmarImportacao` já
    // esquece a marca. Armados antes, as duas asserções lá embaixo passariam
    // com o `catch` sem fazer nada — e é o `catch` que este teste vigia.
    amb.propriedades.set('painel_reconciliacao', JSON.stringify({
      inscricoes: 3, matriculados: 5, em: '2026-09-21 09:00:00', dia: '2026-09-21', gasto: 1200, custo: 300
    }));
    amb.api.CacheService.getScriptCache().put('painel_estatisticas', '{"ok":true,"velho":1}', 30);
    return v;
  };
  const r = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }, { matricula: '9110004', acao: 'CANCELAR' }]
  });
  amb.api.varrerInscricoes_ = varredura;

  igual(r.ok, false);
  igual(r.anuladas, 2);
  igual(r.cancelados, 0);
  igual(r.parcial.anuladas.map((a) => [a.matricula, a.id, a.projetoNome]).sort(),
    [['9110002', i1, 'Robótica'], ['9110002', i2, 'Horta']].sort());
  igual(r.parcial.excluidos, []);
  igual(r.parcial.cancelados, []);
  igual(r.avisos.length, 2, JSON.stringify(r.avisos));
  verdadeiro(r.avisos.some((a) => a.indexOf('A inscrição de 9110002 (Robótica) foi anulada antes da recusa') === 0), r.avisos.join(' | '));
  verdadeiro(r.avisos.some((a) => a.indexOf('A inscrição de 9110002 (Horta) foi anulada antes da recusa') === 0), r.avisos.join(' | '));
  verdadeiro(r.avisos.every((a) => a.toUpperCase().indexOf('BEATRIZ') === -1), 'nome no aviso');
  verdadeiro(/Incluir aluno/.test(r.avisos[0]), 'o aviso tem de dizer como desfazer: ' + r.avisos[0]);

  igual(registrosDoLog(amb.falso, 'LOTE_REVISADO'), [], 'um Aplicar recusado não é revisão inteira');
  const parcial = registrosDoLog(amb.falso, 'LOTE_REVISADO_PARCIAL');
  igual(parcial.length, 1);
  verdadeiro(parcial[0].detalhe.indexOf('ADS41: 0 cancelado(s) [], 0 excluído(s) [], 2 inscrição(ões) anulada(s) [9110002,9110002], 1 pulado(s), 0 já cancelado(s); INTERROMPIDO: A lista da tela é de antes') === 0, parcial[0].detalhe);
  verdadeiro(/; por prof@exemplo\.com$/.test(parcial[0].detalhe), parcial[0].detalhe);
  igual(parcial[0].detalhe.toUpperCase().indexOf('BEATRIZ'), -1);
  igual(parcial[0].detalhe.indexOf('projects/'), -1);

  const lote = documento(amb.falso, 'lotes', l1);
  verdadeiro(Boolean(lote.revisado_em), 'o lote interrompido ficou sem revisado_em');
  igual(lote.revisado_por, PROF);
  igual(JSON.parse(lote.revisao_resumo), { cancelados: 0, excluidos: 0, anuladas: 2, pulados: 1, ja_cancelados: 0, situacao: 'PARCIAL' });
  igual(chamar(amb, 'revisarLote', { loteId: l1 }).revisado.resumo.situacao, 'PARCIAL', 'a janela tem de poder dizer "interrompida"');

  const marca = JSON.parse(amb.propriedades.get('painel_reconciliacao'));
  igual(marca.inscricoes, -1, 'a contagem mudou e a marca não foi esquecida');
  igual([marca.dia, marca.gasto, marca.custo], ['2026-09-21', 1200, 300], 'esquecer a marca não pode zerar o orçamento do dia');
  igual(amb.api.CacheService.getScriptCache().get('painel_estatisticas'), null, 'os números velhos do Painel ficaram no cache');

  // A trilha diz o que foi anulado DE FATO: a inscrição que o Geral anulou à
  // mão entre a varredura e a anulação já não existia (nao_encontradas), e
  // não pode aparecer como "anulada antes da recusa". Mutação que derruba:
  // listar todas as pedidas em vez de filtrar pelos `ids` do Auditório.
  const outro = ambiente();
  const c = cenario(outro);
  projeto(outro, 'p1', 'Robótica');
  projeto(outro, 'p2', 'Horta');
  const j1 = inscrever(outro, '9110002', 'Beatriz Exemplo Martins', 'p1');
  const j2 = inscrever(outro, '9110002', 'Beatriz Exemplo Martins', 'p2', { projeto_nome: 'Horta' });
  const varredura2 = outro.api.varrerInscricoes_;
  outro.api.varrerInscricoes_ = (teto) => {
    const v = varredura2(teto);
    igual(outro.api.anularInscricoes({ token: outro.token, ids: [j2] }).anuladas, 1);
    importar(outro, ADS41_2026_2, [ANA, BEATRIZ, CARLOS_DE_ADS31, DUDA], { nome: 'ads41-terca.csv' });
    return v;
  };
  const r2 = chamar(outro, 'aplicarRevisao', { loteId: c.l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] });
  outro.api.varrerInscricoes_ = varredura2;
  igual(r2.ok, false);
  igual(r2.anuladas, 1, 'só a que existia');
  igual(r2.parcial.anuladas.map((a) => a.id), [j1], 'a anulada à mão apareceu como anulada pela revisão');
  igual(r2.avisos.length, 1);
  verdadeiro(/\(Robótica\)/.test(r2.avisos[0]), r2.avisos[0]);
  verdadeiro(/1 inscrição\(ões\) anulada\(s\) \[9110002\]/.test(registrosDoLog(outro.falso, 'LOTE_REVISADO_PARCIAL')[0].detalhe));
});

teste('EXCLUIR que entrou seguido de CANCELAR recusado: a exclusão irreversível fica na trilha parcial, com a matrícula', () => {
  // O achado 8 da rodada 2: o passo 5 (EXCLUIR) entra, o 6 (CANCELAR) é
  // recusado pela versão, e a única trilha da exclusão era o documento em
  // matriculados_excluidos. Mutação que derruba: log só no fim.
  const amb = ambiente();
  const CARLOS_DE_ADS41 = ['CARLOS EXEMPLO (09110003)', 'ADS41'];
  importar(amb, ADS41_2026_2, [ANA, BEATRIZ, CARLOS_DE_ADS41], { nome: 'ads41-sexta.csv' });
  const l1 = importar(amb, ADS41_2026_2, [ANA, DUDA], { nome: 'ads41-segunda.csv' }).loteId;
  // Só a Beatriz volta na reimportação do meio: o delete do Carlos entra, o
  // patch da Beatriz é recusado pela versão.
  const varredura = amb.api.varrerInscricoes_;
  amb.api.varrerInscricoes_ = (teto) => {
    const v = varredura(teto);
    importar(amb, ADS41_2026_2, [ANA, BEATRIZ, DUDA], { nome: 'ads41-terca.csv' });
    return v;
  };
  const r = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41',
    decisoes: [{ matricula: '9110003', acao: 'EXCLUIR' }, { matricula: '9110002', acao: 'CANCELAR' }]
  });
  amb.api.varrerInscricoes_ = varredura;

  igual(r.ok, false);
  igual(r.excluidos, 1);
  igual(r.cancelados, 0);
  igual(r.parcial, { anuladas: [], excluidos: ['9110003'], cancelados: [] });
  igual(r.avisos, ['9110003 foi/foram excluído(s) antes da recusa (cópia em matriculados_excluidos).']);
  igual(documento(amb.falso, 'matriculados', '9110003'), null);
  verdadeiro(documento(amb.falso, 'matriculados_excluidos', '9110003') !== null);

  const parcial = registrosDoLog(amb.falso, 'LOTE_REVISADO_PARCIAL');
  igual(parcial.length, 1);
  verdadeiro(parcial[0].detalhe.indexOf('ADS41: 0 cancelado(s) [], 1 excluído(s) [9110003], 0 inscrição(ões) anulada(s) [], 0 pulado(s)') === 0, parcial[0].detalhe);
  igual(parcial[0].detalhe.indexOf('9110002'), -1, 'quem NÃO foi cancelado não pode estar listado como cancelado');
  igual(JSON.parse(documento(amb.falso, 'lotes', l1).revisao_resumo).situacao, 'PARCIAL');
});

// ---------------------------------------------------- Releitura e tetos

grupo('aplicarRevisao — a releitura pula quem voltou; os tetos recusam antes de ler');

teste('quem foi reimportado entre a tela e o clique é PULADO, não é tocado e fica com a inscrição', () => {
  // Mutação que derruba: confiar na lista da tela — a Beatriz que a secretaria
  // acabou de reenviar seria cancelada com a inscrição anulada.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1');
  const inscricao = inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p1');
  const tela = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(tela.comProjeto.map((i) => i.matricula), ['9110002']);

  importar(amb, ADS41_2026_2, [ANA, BEATRIZ, DUDA], { nome: 'ads41-terca.csv' });
  // E o Carlos, que a tela nunca listou, mudou de turma na lista dele.
  amb.api.atualizar('matriculados', '9110001', { turma: 'ADS42' });

  amb.zerar();
  const r = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41',
    decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }, { matricula: '9110001', acao: 'EXCLUIR' }]
  });
  igual(r.ok, true, r.erro);
  igual(r.cancelados, 0);
  igual(r.excluidos, 0);
  igual(r.anuladas, 0);
  igual(r.pulados.map((p) => p.matricula).sort(), ['9110001', '9110002']);
  verdadeiro(/voltou numa importação igual ou mais nova/.test(r.pulados.filter((p) => p.matricula === '9110002')[0].motivo));
  verdadeiro(/já não consta como ADS41/.test(r.pulados.filter((p) => p.matricula === '9110001')[0].motivo));
  verdadeiro(/recarregue a revisão/.test(r.mensagem), r.mensagem);
  verdadeiro(documento(amb.falso, 'inscricoes', inscricao) !== null, 'a inscrição de quem voltou foi anulada');
  igual(amb.falso.requisicoes.filter(ESCRITA).length, 0);
  igual(registrosDoLog(amb.falso, 'LOTE_REVISADO'), [], '"nada a fazer" não vai para o log');
});

teste('tetos e formato recusam ANTES de qualquer leitura: 101 decisões, repetida, ação estranha, nada', () => {
  const amb = ambiente();
  const { l1 } = cenario(amb);
  amb.zerar();

  const cento = [];
  for (let i = 0; i < 101; i++) cento.push({ matricula: String(9150000 + i), acao: 'CANCELAR' });
  const muitas = chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: cento });
  verdadeiro(/Vieram 101 decisões/.test(muitas.erro), muitas.erro);

  const repetida = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41',
    decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }, { matricula: '09110002', acao: 'EXCLUIR' }]
  });
  verdadeiro(/9110002 aparece duas vezes/.test(repetida.erro), repetida.erro);

  const estranha = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'MANTER' }]
  });
  verdadeiro(/Ação desconhecida/.test(estranha.erro), estranha.erro);

  igual(chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [] }).erro, 'Nada marcado.');
  igual(chamar(amb, 'aplicarRevisao', { loteId: l1, turma: '', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] }).ok, false);

  igual(amb.falso.requisicoes.length, 0, 'alguma recusa custou uma requisição');
});

teste('mais de 200 inscrições a anular recusa antes de escrever — o teto do Auditório', () => {
  const amb = ambiente();
  const { l1 } = cenario(amb);
  // 201 inscrições da mesma pessoa em 201 projetos, semeadas direto: a chave de
  // dedup inclui o projeto, então isto é possível de verdade.
  const docs = [];
  for (let i = 0; i < 201; i++) {
    docs.push({ _id: 'i' + i, matricula: '9110002', nome: 'Beatriz Exemplo Martins', projeto_id: 'p' + i,
      projeto_nome: 'P' + i, criado_em: '2026-09-01 10:00:00' });
  }
  amb.api.escreverEmLote('inscricoes', docs);

  amb.zerar();
  const r = chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] });
  igual(r.ok, false);
  verdadeiro(/201 inscrições a anular de uma vez; o teto é 200/.test(r.erro), r.erro);
  igual(amb.falso.requisicoes.filter(ESCRITA).length, 0);
  igual(documento(amb.falso, 'matriculados', '9110002').situacao_cadastro, undefined);
});

teste('varredura de inscrições cortada no teto: o Aplicar recusa, porque cancelar sem liberar a vaga não é opção', () => {
  // Mutação que derruba: seguir com a varredura truncada — a inscrição que ficou
  // fora dos 2000 sobreviveria por baixo da marca.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  const docs = [];
  // 2101, e não 2001: a varredura anda em blocos de 300 e só se declara cortada
  // quando o ÚLTIMO bloco veio cheio — 2001 seriam lidas inteiras (a sétima
  // página vem com 201). Sete blocos cheios são 2100 lidas com página seguinte.
  for (let i = 0; i < 2101; i++) {
    docs.push({ _id: 'z' + String(i).padStart(4, '0'), matricula: String(9200000 + i), projeto_id: 'p1',
      nome: 'Aluno ' + i, criado_em: '2026-09-01 10:00:00' });
  }
  amb.api.escreverEmLote('inscricoes', docs);

  amb.zerar();
  const r = chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] });
  igual(r.ok, false);
  verdadeiro(/varredura de inscrições foi cortada em 2100/.test(r.erro), r.erro);
  igual(amb.falso.requisicoes.filter(ESCRITA).length, 0);

  const tela = chamar(amb, 'revisarLote', { loteId: l1 });
  igual(tela.truncado, true);
  verdadeiro(tela.avisos.some((a) => /2100 primeiras inscrições de 2101/.test(a)), tela.avisos.join(' | '));
});

// ------------------------------------------------------- Lote, log, marca

grupo('aplicarRevisao — o lote, a trilha e o que ela NÃO leva');

teste('o lote é marcado com revisado_* e o resumo; o log leva matrículas por ação, quem, e nunca nome', () => {
  // Mutação que derruba: pôr o nome no detalhe — o repositório é público e o
  // log do Firestore não, mas a frase da trilha aparece na aba Histórico de
  // quem tem acesso, e é matrícula que se procura lá, não nome.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1');
  inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p1');

  const r = chamar(amb, 'aplicarRevisao', {
    loteId: l1, turma: 'ADS41',
    decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }, { matricula: '9110004', acao: 'CANCELAR' }]
  });
  igual(r.ok, true, r.erro);
  igual(r.cancelados, 1);
  igual(r.pulados.length, 1, 'a Duda veio neste lote: pulada');

  const lote = documento(amb.falso, 'lotes', l1);
  igual(lote.revisado_por, PROF);
  igual(lote.revisao_turma, 'ADS41');
  verdadeiro(Boolean(lote.revisado_em));
  igual(JSON.parse(lote.revisao_resumo), { cancelados: 1, excluidos: 0, anuladas: 1, pulados: 1, ja_cancelados: 0 });
  igual(lote.turma_cabecalho, 'ADS41', 'a turma do lote não muda');
  igual(lote.turma_origem, 'CABECALHO');

  const linhas = registrosDoLog(amb.falso, 'LOTE_REVISADO');
  igual(linhas.length, 1);
  const detalhe = linhas[0].detalhe;
  verdadeiro(detalhe.indexOf('ADS41: 1 cancelado(s) [9110002]') === 0, detalhe);
  verdadeiro(/1 inscrição\(ões\) anulada\(s\), 1 pulado\(s\), 0 já cancelado\(s\); por prof@exemplo\.com$/.test(detalhe), detalhe);
  igual(detalhe.toUpperCase().indexOf('BEATRIZ'), -1, 'o nome foi para o log: ' + detalhe);
  igual(detalhe.indexOf('9110004'), -1, 'quem foi pulado não é listado como cancelado');
});

teste('lote antigo ganha a turma que a revisão usou (origem LINHAS), e só ele', () => {
  // Mutação que derruba: gravar turma_cabecalho sempre — o lote com cabeçalho
  // teria a chave sobrescrita pela turma informada no campo.
  const amb = ambiente();
  const junho = '20260601T120000000Z_000000';
  const velho = '20260801T120000000Z_eeeeee';
  loteAntigo(amb, junho, [{ matricula: '9130009', turma: 'ADS41' }]);
  loteAntigo(amb, velho, [
    { matricula: '9130001', turma: 'ADS41' }, { matricula: '9130002', turma: 'ADS41' },
    { matricula: '9130003', turma: 'ADS41' }, { matricula: '9130004', turma: 'ADS41' },
    { matricula: '9130005', turma: 'ADS41' }
  ]);

  const tela = chamar(amb, 'revisarLote', { loteId: velho });
  igual(tela.origemTurma, 'LINHAS');
  igual(tela.candidatos, 1);
  const r = chamar(amb, 'aplicarRevisao', {
    loteId: velho, turma: tela.turma, origemTurma: tela.origemTurma,
    decisoes: [{ matricula: '9130009', acao: 'CANCELAR' }]
  });
  igual(r.ok, true, r.erro);
  const lote = documento(amb.falso, 'lotes', velho);
  igual(lote.turma_cabecalho, 'ADS41');
  igual(lote.turma_origem, 'LINHAS');
  igual(lote.status, 'ATUALIZOU', 'status do lote não ganha valor novo');

  // Da segunda vez a turma já está lá, e o rótulo vem do lote.
  igual(chamar(amb, 'revisarLote', { loteId: velho }).origemTurma, 'LINHAS');
});

teste('a resposta diz se o lote JÁ foi revisado — quando, por quem e o resumo — e null antes', () => {
  // Mutação que derruba: `resposta.revisado = null` sempre — a janela deixaria
  // de dizer "Já revisada em ...", e o Revisar repetido pareceria o primeiro.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  projeto(amb, 'p1');
  inscrever(amb, '9110002', 'Beatriz Exemplo Martins', 'p1');

  igual(chamar(amb, 'revisarLote', { loteId: l1 }).revisado, null, 'lote nunca revisado');

  const r = chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] });
  igual(r.ok, true, r.erro);

  const deNovo = chamar(amb, 'revisarLote', { loteId: l1 });
  verdadeiro(deNovo.revisado !== null && typeof deNovo.revisado === 'object', 'revisado veio ' + JSON.stringify(deNovo.revisado));
  igual(deNovo.revisado.por, PROF);
  igual(deNovo.revisado.em, documento(amb.falso, 'lotes', l1).revisado_em);
  igual(deNovo.revisado.resumo, { cancelados: 1, excluidos: 0, anuladas: 1, pulados: 0, ja_cancelados: 0 });
  igual(deNovo.candidatos, 0, 'a Beatriz agora é já cancelada');
  igual(deNovo.jaCancelados.length, 1);

  // `contarApenas` não relata a revisão anterior (o passo 3 não a mostra).
  igual(chamar(amb, 'revisarLote', { loteId: l1, contarApenas: true }).revisado, undefined);
});

teste('a marca da reconciliação é reescrita com -1 preservando dia, gasto e custo; o cache do Painel cai', () => {
  // Mutação que derruba: `deleteProperty` — o gasto do dia zeraria e o freio das
  // 15.000 leituras deixaria passar rodadas a mais justamente no dia da revisão.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  amb.propriedades.set('painel_reconciliacao', JSON.stringify({
    inscricoes: 3, matriculados: 5, em: '2026-09-21 09:00:00', dia: '2026-09-21', gasto: 1200, custo: 300
  }));
  amb.api.CacheService.getScriptCache().put('painel_estatisticas', '{"ok":true,"velho":1}', 30);

  const r = chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] });
  igual(r.ok, true, r.erro);

  const marca = JSON.parse(amb.propriedades.get('painel_reconciliacao'));
  igual(marca, { inscricoes: -1, matriculados: -1, em: '2026-09-21 09:00:00', dia: '2026-09-21', gasto: 1200, custo: 300 });
  igual(amb.api.CacheService.getScriptCache().get('painel_estatisticas'), null, 'os números velhos do Painel ficaram no cache');
});

teste('erro do commit com o caminho do documento vira frase fixa — sem projects/ e sem a matrícula', () => {
  // A Beatriz some entre a releitura e o commit: o `exists:true` devolve 404 com
  // o caminho inteiro do documento. Mutação que derruba: devolver `err.message`
  // cru — a matrícula iria para o log de execução e para a tela.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  const real = amb.api.UrlFetchApp;
  amb.api.UrlFetchApp = {
    fetch(url, opcoes) {
      const corpo = opcoes.payload ? JSON.parse(opcoes.payload) : null;
      if (corpo && corpo.writes && corpo.writes[0].updateMask) {
        amb.falso.documentos.delete('matriculados/9110002');
      }
      return real.fetch(url, opcoes);
    },
    fetchAll: (lote) => real.fetchAll(lote)
  };

  const r = chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] });
  igual(r.ok, false);
  verdadeiro(/A lista da tela é de antes/.test(r.erro), r.erro);
  igual(r.erro.indexOf('projects/'), -1, r.erro);
  igual(r.erro.indexOf('9110002'), -1, 'a matrícula vazou na mensagem: ' + r.erro);
  igual(r.cancelados, 0);
  // E o que o log de execução recebe é a mesma frase, não o caminho.
  verdadeiro(amb.registros.erros.every((e) => e.indexOf('projects/') === -1), amb.registros.erros.join(' | '));

  // Qualquer outra mensagem perde o caminho, e só ele.
  const generico = amb.api.fraseSegura_(new Error('Firestore 400 INVALID_ARGUMENT em POST :commit: campo projects/x/databases/(default)/documents/matriculados/9110002 inválido'));
  igual(generico, 'Firestore 400 INVALID_ARGUMENT em POST :commit: campo (documento) inválido');
});

teste('reativação é a reimportação: o documento volta sem a marca e a matrícula volta ao formulário', () => {
  // Mutação que derruba: `gravarMatriculados_` passar a mesclar (updateMask) — a
  // marca sobreviveria à lista nova, e não existe outro caminho de reativar.
  const amb = ambiente();
  const { l1 } = cenario(amb);
  chamar(amb, 'aplicarRevisao', { loteId: l1, turma: 'ADS41', decisoes: [{ matricula: '9110002', acao: 'CANCELAR' }] });
  igual(amb.api.matriculaConhecida('9110002'), false);

  const l2 = importar(amb, ADS41_2026_2, [ANA, BEATRIZ, DUDA], { nome: 'ads41-terca.csv' }).loteId;
  const doc = documento(amb.falso, 'matriculados', '9110002');
  igual(doc.situacao_cadastro, undefined);
  igual(doc.cancelado_em, undefined);
  igual(doc.lote_id, l2);
  igual(amb.api.matriculaConhecida('9110002'), true);
  igual(registrosDoLog(amb.falso).filter((l) => /REATIV/.test(l.acao)), [], 'não existe linha de reativação: a prova é o lote_id');
});

process.exit(resultado());
