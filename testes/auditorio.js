/**
 * auditorio.js — testa as ferramentas do dia do evento (13_Auditorio.gs) sem
 * tocar no Google.
 *
 * O que se prova aqui, em ordem de importância:
 *   1. ANULAR COPIA ANTES DE APAGAR, e a prova é a ORDEM das requisições, não o
 *      estado final: os dois resultados são iguais quando tudo dá certo, e
 *      diferentes exatamente no dia em que a execução morre no meio. Por isso a
 *      quarentena também é derrubada de propósito, para ver o que sobra;
 *   2. o invariante das vagas não tem porta dos fundos: restaurar e promover
 *      conferem vaga, e promover conta DENTRO do lock — o mesmo por onde passa a
 *      inscrição do aluno;
 *   3. o lock é pego UMA vez por lote na promoção. Cem `waitLock` seguidos no
 *      meio do evento travariam a fila do auditório, que é justamente o que esta
 *      aba existe para destravar;
 *   4. nenhuma das cinco é alcançável sem token;
 *   5. nenhuma consulta pede índice composto — ordenação OU filtro, nunca os
 *      dois, porque o `400 The query requires an index` aparece no primeiro
 *      clique do dia do evento e não tem conserto de tela.
 *
 * O `LockService` daqui é o mesmo desenho de `testes/projetos.js`: carimba
 * quantas requisições já tinham ido ao Firestore a cada entrada e saída, e conta
 * quantas vezes foi pedido. É o que transforma "o lote pega um lock só" em prova.
 *
 * Uso:  node testes/auditorio.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  teste, grupo, igual, verdadeiro, resultado, criarAmbiente
} = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');

const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '03_Config.gs',
  '04_Inscricoes.gs', '04_Log.gs', '07_Auth.gs', '09_Projetos.gs', '13_Auditorio.gs'];

function ambiente(opcoes) {
  return criarAmbiente(Object.assign({ arquivos: GS, usuario: '' }, opcoes || {}));
}

// ------------------------------------------------------------ Apoio

/**
 * Lock falso com memória: quantas vezes foi pedido, e onde a fila de requisições
 * estava em cada evento.
 */
function comLock(api, falso, opcoes) {
  opcoes = opcoes || {};
  const eventos = [];

  api.LockService = {
    getScriptLock: () => ({
      waitLock(ms) {
        eventos.push({ tipo: 'pediu', ms: ms, requisicao: falso.requisicoes.length });
        if (opcoes.aoEsperar) opcoes.aoEsperar();
        if (opcoes.falhar) throw new Error('Could not obtain lock in 90000 ms.');
        eventos.push({ tipo: 'pegou', requisicao: falso.requisicoes.length });
      },
      releaseLock() {
        eventos.push({ tipo: 'soltou', requisicao: falso.requisicoes.length });
      }
    })
  };

  return eventos;
}

function quantosDoTipo(eventos, tipo) {
  return eventos.filter((e) => e.tipo === tipo).length;
}

function marco(eventos, tipo) {
  const achado = eventos.filter((e) => e.tipo === tipo)[0];
  if (!achado) throw new Error('o lock nunca recebeu "' + tipo + '"');
  return achado.requisicao;
}

function tokenAdmin(api) {
  return api.criarSessao_('coordenacao@exemplo.com');
}

function criarProjeto(api, id, campos) {
  api.inserir('projetos', Object.assign({
    codigo: id,
    nome: 'Projeto ' + id,
    professor: 'Marina Exemplo',
    vagas: '2',
    ativo: 'SIM',
    inscricoes_abertas: 'SIM',
    validar_matricula: 'SIM',
    ordem: '1',
    criado_em: '2026-08-14 10:00:00'
  }, campos || {}), id);
}

/**
 * Uma inscrição gravada como o servidor a grava.
 *
 * `em_espera` e `espera_de` andam JUNTOS — é assim que `gravarInscricao` os
 * escreve (04_Inscricoes.gs) e é o par que `contarEmEspera_` conta
 * (09_Projetos.gs). Escrever um sem o outro montaria um banco que o sistema
 * nunca produz, e o teste mediria um mundo que não existe.
 */
function inscrever(api, id, campos) {
  const doc = Object.assign({
    criado_em: '2026-08-14 21:00:00',
    origem: 'SITE',
    projeto_id: 'p1',
    projeto_nome: 'Projeto p1',
    matricula: '110000',
    nome: 'Fulano de Tal',
    email: 'fulano@exemplo.com',
    matricula_conferida: 'NAO',
    raw_json: '{}'
  }, campos || {});

  if (doc.em_espera === 'SIM') doc.espera_de = doc.projeto_id;
  api.inserir('inscricoes', doc, id);
  return id;
}

function idsDe(falso, colecao) {
  const ids = [];
  falso.documentos.forEach((_campos, chave) => {
    if (chave.indexOf(colecao + '/') === 0) ids.push(chave.slice(colecao.length + 1));
  });
  return ids.sort();
}

function campos(falso, colecao, id) {
  return falso.documentos.get(colecao + '/' + id) || null;
}

function acoesDoLog(falso) {
  const acoes = [];
  falso.documentos.forEach((c, chave) => {
    if (chave.indexOf('log/') === 0) acoes.push(c.acao.stringValue);
  });
  return acoes;
}

/** As chamadas de `:commit`, na ordem em que saíram, já classificadas. */
function commits(falso) {
  return falso.requisicoes
    .filter((r) => r.url.indexOf(':commit') !== -1)
    .map((r) => {
      const escrita = r.corpo.writes[0];
      const nome = escrita.update ? escrita.update.name : escrita.delete;
      return {
        tipo: escrita.update ? 'grava' : 'apaga',
        colecao: String(nome).split('/documents/')[1].split('/')[0],
        quantas: r.corpo.writes.length
      };
    });
}

/** O corpo da consulta que a requisição N mandou, para conferir índice. */
function consultas(falso) {
  return falso.requisicoes
    .filter((r) => r.url.indexOf(':runQuery') !== -1)
    .map((r) => r.corpo.structuredQuery);
}

/** O cenário do auditório: 2 vagas ocupadas e 3 na fila, com horas distintas. */
function auditorioLotado(api) {
  criarProjeto(api, 'p1', { vagas: '2', nome: 'Robótica' });
  inscrever(api, 'i1', { nome: 'Ana Silva', matricula: '110001', criado_em: '2026-08-14 21:00:01' });
  inscrever(api, 'i2', { nome: 'kkkk jjjj', matricula: '999999', criado_em: '2026-08-14 21:00:02' });
  inscrever(api, 'i3', { nome: 'Bruno Souza', matricula: '110002', criado_em: '2026-08-14 21:00:03', em_espera: 'SIM' });
  inscrever(api, 'i4', { nome: 'Carla Dias', matricula: '110003', criado_em: '2026-08-14 21:00:04', em_espera: 'SIM' });
  inscrever(api, 'i5', { nome: 'Diego Melo', matricula: '110004', criado_em: '2026-08-14 21:00:05', em_espera: 'SIM' });
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
}

// ============================================================================

console.log('\n\x1b[1mUNICESUSC CESUTECH — o auditório: anular, restaurar, promover (13_Auditorio.gs)\x1b[0m');

grupo('Sem token, nenhuma das cinco existe');

teste('as cinco recusam token ausente, vazio, forjado — e não tocam no banco', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  comLock(api, falso);
  const antes = idsDe(falso, 'inscricoes');

  ['inscricoesRecentes', 'filaDeEspera', 'anularInscricoes', 'restaurarInscricoes', 'promoverDaEspera']
    .forEach((nome) => {
      [undefined, '', 'token-inventado', null].forEach((token) => {
        const r = api[nome]({ token: token, ids: ['i1', 'i2'] });
        igual(r.ok, false, nome + ' respondeu ok com o token ' + JSON.stringify(token));
        verdadeiro(r.erro.indexOf('Sessão') === 0, nome + ': ' + r.erro);
      });
    });

  igual(idsDe(falso, 'inscricoes'), antes, 'alguma delas mexeu no cadastro sem token');
  igual(idsDe(falso, 'inscricoes_anuladas'), [], 'e ninguém foi para a quarentena');
});

// A lista branca diz "o navegador pode chamar"; o `exigirAdmin` diz "só com
// token". As duas conferências existem, e é a primeira linha de cada função que
// garante a segunda quando ela é chamada por google.script.run.
teste('as cinco estão na lista branca do painel, e nenhuma outra do arquivo está', () => {
  const codigo = fs.readFileSync(path.join(PASTA_GS, '08_Api.gs'), 'utf8');
  const doArquivo = fs.readFileSync(path.join(PASTA_GS, '13_Auditorio.gs'), 'utf8');

  ['inscricoesRecentes', 'filaDeEspera', 'anularInscricoes', 'restaurarInscricoes', 'promoverDaEspera']
    .forEach((nome) => {
      verdadeiro(new RegExp('\\n\\s*' + nome + ': ' + nome + ',?\\n').test(codigo),
        nome + ' não está na lista branca literal de funcoesDoPainel_');
    });

  // As internas terminam em `_`, e é isso que as mantém fora da lista: o dia em
  // que uma delas entrar, entra sem `exigirAdmin` nenhum na frente.
  const publicas = (doArquivo.match(/^function ([a-zA-Z][\w$]*)\(/gm) || [])
    .map((l) => l.replace(/^function /, '').replace(/\($/, ''))
    .filter((n) => n.slice(-1) !== '_');
  igual(publicas.sort(), ['anularInscricoes', 'filaDeEspera', 'inscricoesRecentes',
    'promoverDaEspera', 'restaurarInscricoes']);
});

// A colisão de nomes entre arquivos é silenciosa no Apps Script: os `.gs`
// dividem um escopo global só, a última declaração carregada vence, e nada
// reclama. Este teste nasceu porque aconteceu — `resumoDaInscricao_` existia em
// 10_Painel.gs, e a cópia daqui derrubou o aviso de vizinhança da edição de
// aluno sem uma linha de erro em lugar nenhum.
teste('nenhuma função é declarada em dois arquivos .gs', () => {
  const declaracoes = {};

  fs.readdirSync(PASTA_GS).filter((n) => n.slice(-3) === '.gs').forEach((arquivo) => {
    const texto = fs.readFileSync(path.join(PASTA_GS, arquivo), 'utf8');
    (texto.match(/^function [\w$]+\(/gm) || []).forEach((linha) => {
      const nome = linha.replace(/^function /, '').replace(/\($/, '');
      declaracoes[nome] = declaracoes[nome] || [];
      if (declaracoes[nome].indexOf(arquivo) === -1) declaracoes[nome].push(arquivo);
    });
  });

  const repetidas = Object.keys(declaracoes)
    .filter((n) => declaracoes[n].length > 1)
    .map((n) => n + ' (' + declaracoes[n].join(', ') + ')');

  igual(repetidas, [], 'a última carregada vence em silêncio, e a outra vira função fantasma');
});

grupo('inscricoesRecentes');

teste('devolve da mais nova para a mais velha, com o teto pedido', () => {
  const { api } = ambiente();
  auditorioLotado(api);

  const r = api.inscricoesRecentes({ token: tokenAdmin(api), limite: 3 });

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.inscricoes.map((i) => i.id), ['i5', 'i4', 'i3']);
  igual(r.lidas, 3, 'a tela precisa saber o tamanho da janela que está mostrando');
  igual(r.inscricoes[0].nome, 'Diego Melo');
  igual(r.inscricoes[0].em_espera, true, 'quem está na fila tem de ser distinguível na lista');
});

// A armadilha que já custou uma execução neste projeto: `orderBy` num campo mais
// `where` noutro exige índice composto, e a resposta é 400 no primeiro clique.
teste('ordena por criado_em e NÃO manda filtro na consulta — o filtro é em JavaScript', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  criarProjeto(api, 'p2', { nome: 'Outro' });
  inscrever(api, 'i9', { projeto_id: 'p2', criado_em: '2026-08-14 21:00:09' });
  falso.requisicoes.length = 0;

  const r = api.inscricoesRecentes({ token: tokenAdmin(api), projeto_id: 'p1', limite: 200 });

  const consulta = consultas(falso)[0];
  igual(consulta.orderBy[0].field.fieldPath, 'criado_em');
  igual(consulta.orderBy[0].direction, 'DESCENDING');
  igual(consulta.where, undefined, 'filtro na consulta somado à ordenação pede índice composto');

  igual(r.inscricoes.map((i) => i.id), ['i5', 'i4', 'i3', 'i2', 'i1'], 'o filtro cortou em JavaScript');
  igual(r.lidas, 6, 'e `lidas` conta a janela inteira, não o que sobrou do filtro');
});

// `__name__` DESC também não: o índice automático dele só cobre ascendente.
teste('não ordena por __name__, que é a outra forma da mesma armadilha', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  falso.requisicoes.length = 0;

  api.inscricoesRecentes({ token: tokenAdmin(api) });

  consultas(falso).forEach((c) => {
    verdadeiro(c.orderBy[0].field.fieldPath !== '__name__',
      '__name__ DESC devolve 400 The query requires an index');
  });
});

teste('o teto é 200, e um limite absurdo não passa por cima dele', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  falso.requisicoes.length = 0;

  api.inscricoesRecentes({ token: tokenAdmin(api), limite: 5000 });
  igual(consultas(falso)[0].limit, 200);

  falso.requisicoes.length = 0;
  api.inscricoesRecentes({ token: tokenAdmin(api), limite: 'trinta' });
  igual(consultas(falso)[0].limit, 50, 'sem número, o padrão da tela');
});

teste('o payload do aluno não vaza inteiro para a tela', () => {
  const { api } = ambiente();
  auditorioLotado(api);

  const primeira = api.inscricoesRecentes({ token: tokenAdmin(api) }).inscricoes[0];
  igual(primeira.raw_json, undefined, 'raw_json é o formulário inteiro repetido — 200 deles não passeiam');
});

grupo('filaDeEspera');

teste('a fila volta em ORDEM DE CHEGADA, com a posição de cada um', () => {
  const { api } = ambiente();
  auditorioLotado(api);

  const r = api.filaDeEspera({ token: tokenAdmin(api) });

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.fila.map((f) => f.id), ['i3', 'i4', 'i5'], 'quem chegou primeiro tem de vir primeiro');
  igual(r.fila.map((f) => f.posicao), [1, 2, 3]);
  igual(r.fila[0].nome, 'Bruno Souza');
  igual(r.truncada, false);
});

teste('a posição é POR PROJETO — duas filas não se somam', () => {
  const { api } = ambiente();
  auditorioLotado(api);
  criarProjeto(api, 'p2', { vagas: '1', nome: 'Outro' });
  inscrever(api, 'x1', { projeto_id: 'p2', criado_em: '2026-08-14 21:00:00', em_espera: 'SIM' });
  inscrever(api, 'x2', { projeto_id: 'p2', criado_em: '2026-08-14 21:00:06', em_espera: 'SIM' });

  const r = api.filaDeEspera({ token: tokenAdmin(api) });
  const porId = {};
  r.fila.forEach((f) => { porId[f.id] = f; });

  igual([porId.x1.posicao, porId.x2.posicao], [1, 2]);
  igual([porId.i3.posicao, porId.i4.posicao, porId.i5.posicao], [1, 2, 3]);
  igual(r.fila.map((f) => f.id), ['x1', 'i3', 'i4', 'i5', 'x2'],
    'a ordem geral continua sendo a de chegada, atravessando os projetos');
});

teste('o resumo por projeto traz vagas, confirmados, quantos esperam e quantos cabem', () => {
  const { api } = ambiente();
  auditorioLotado(api);

  const p = api.filaDeEspera({ token: tokenAdmin(api) }).projetos[0];

  igual(p, {
    id: 'p1', nome: 'Robótica', vagas: 2, confirmados: 2, emEspera: 3,
    situacao: 'ESGOTADO', cabem: 0
  });
});

// Esta aba NÃO abre mão da contagem. `contar_ocupacao_na_lista` em NAO é a chave
// de diagnóstico do tempo da lista PÚBLICA (09_Projetos.gs), e aqui o número
// decide quem a coordenação promove: sem ele, `cabem` viraria a fila inteira e a
// tela ofereceria um botão que o servidor nega pessoa por pessoa.
teste('a chave que desliga a contagem da lista NÃO desliga a conta do auditório', () => {
  const { api } = ambiente();
  auditorioLotado(api);
  api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
  api.limparCacheConfig();

  const p = api.filaDeEspera({ token: tokenAdmin(api) }).projetos[0];

  igual(p, {
    id: 'p1', nome: 'Robótica', vagas: 2, confirmados: 2, emEspera: 3,
    situacao: 'ESGOTADO', cabem: 0
  });
});

teste('e com vaga sobrando ela continua dizendo quantos cabem, e não a fila toda', () => {
  const { api } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '3' });
  api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
  api.limparCacheConfig();

  const p = api.filaDeEspera({ token: tokenAdmin(api) }).projetos[0];
  igual(p.confirmados, 2);
  igual(p.cabem, 1, 'sem contagem, "cabem 3" ofereceria promover quem não cabe');
});

// Reduzir as vagas abaixo do que já entrou é decisão de coordenação, e acontece.
// `cabem` negativo viraria "promover -3", e a conta de quem cabe na tela sairia
// do avesso.
teste('cabem nunca fica negativo, mesmo com o projeto estourado', () => {
  const { api } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '1' });

  const p = api.filaDeEspera({ token: tokenAdmin(api) }).projetos[0];
  igual(p.confirmados, 2);
  igual(p.cabem, 0);
});

teste('projeto ilimitado cabe a fila inteira, e não zero', () => {
  const { api } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '0' });

  const p = api.filaDeEspera({ token: tokenAdmin(api) }).projetos[0];
  igual(p.vagas, 0);
  igual(p.cabem, 3, 'vagas 0 é ilimitado: a subtração diria 0, que é o oposto da verdade');
});

// Projeto fechado não recebe promoção — `promoverDaEspera` recusa. Oferecer o
// botão seria prometer um clique que o servidor nega.
teste('projeto fechado ou inativo mostra cabem 0, mesmo com vaga sobrando', () => {
  const { api } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '10', inscricoes_abertas: 'NAO' });

  const p = api.filaDeEspera({ token: tokenAdmin(api) }).projetos[0];
  igual(p.situacao, 'FECHADO');
  igual(p.cabem, 0, 'a tela ofereceria promover para um projeto que o servidor recusa');
});

teste('a consulta da fila leva UM filtro e nenhuma ordenação declarada', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  falso.requisicoes.length = 0;

  api.filaDeEspera({ token: tokenAdmin(api) });

  const consulta = consultas(falso)[0];
  igual(consulta.where.fieldFilter.field.fieldPath, 'em_espera');
  igual(consulta.where.fieldFilter.value.stringValue, 'SIM');
  igual(consulta.orderBy[0].field.fieldPath, '__name__', 'o desempate de todo índice de campo único');
  igual(consulta.orderBy[0].direction, 'ASCENDING', 'ASC é o que o índice automático cobre');
});

teste('o filtro por projeto também é feito em JavaScript', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  criarProjeto(api, 'p2', { nome: 'Outro' });
  inscrever(api, 'x1', { projeto_id: 'p2', criado_em: '2026-08-14 21:00:00', em_espera: 'SIM' });
  falso.requisicoes.length = 0;

  const r = api.filaDeEspera({ token: tokenAdmin(api), projeto_id: 'p2' });

  igual(r.fila.map((f) => f.id), ['x1']);
  igual(r.projetos.map((p) => p.id), ['p2'], 'pedindo um projeto, é dele que a tela fala');
  igual(consultas(falso)[0].where.fieldFilter.field.fieldPath, 'em_espera',
    'o projeto entrou na consulta e virou dois filtros');
});

// O cabeçalho existe para a coordenação ver a lotação ANTES de virar problema:
// um projeto em 1/2 sem ninguém esperando é a informação que faz alguém agir.
// Mostrar só quem já tem fila é mostrar o incêndio depois de ele pegar.
teste('projeto ativo SEM fila aparece no cabeçalho, com emEspera 0', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p1', { vagas: '2', nome: 'Robótica' });
  criarProjeto(api, 'p2', { vagas: '2', nome: 'Sossegado', ordem: '2' });
  inscrever(api, 'i1', {});

  const r = api.filaDeEspera({ token: tokenAdmin(api) });

  igual(r.fila, [], 'ninguém está esperando');
  igual(r.projetos.map((p) => p.id), ['p1', 'p2'], 'os dois ativos, com fila ou sem');
  igual(r.projetos[0], {
    id: 'p1', nome: 'Robótica', vagas: 2, confirmados: 1, emEspera: 0,
    situacao: 'ABERTO', cabem: 1
  });
  igual(r.projetos[1].emEspera, 0);
});

teste('projeto inativo só aparece se tiver gente esperando nele', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p1', { vagas: '2', nome: 'Robótica' });
  criarProjeto(api, 'p_off', { vagas: '2', nome: 'Desativado', ativo: 'NAO' });
  criarProjeto(api, 'p_off2', { vagas: '2', nome: 'Desativado sem fila', ativo: 'NAO' });
  inscrever(api, 'e1', { projeto_id: 'p_off', em_espera: 'SIM' });
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');

  const ids = api.filaDeEspera({ token: tokenAdmin(api) }).projetos.map((p) => p.id);

  igual(ids, ['p1', 'p_off'], 'a fila teria linha apontando para projeto que a tela não conhece');
  igual(ids.indexOf('p_off2'), -1, 'projeto fora do ar e sem fila não é assunto da noite');
});

teste('sem projeto nenhum, a resposta é vazia e não custa agregação', () => {
  const { api, falso } = ambiente();
  falso.requisicoes.length = 0;

  const r = api.filaDeEspera({ token: tokenAdmin(api) });

  igual(r.fila, []);
  igual(r.projetos, []);
  igual(falso.requisicoes.filter((q) => q.url.indexOf(':runAggregationQuery') !== -1).length, 0);
});

grupo('anularInscricoes — a ordem é o desenho inteiro');

// Este é o teste que justifica a peça. O ESTADO FINAL é o mesmo nas duas ordens;
// só a ORDEM diz o que acontece quando a execução morre no meio.
teste('a cópia para a quarentena vai ANTES da exclusão', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  falso.requisicoes.length = 0;

  const r = api.anularInscricoes({ token: tokenAdmin(api), ids: ['i2'] });
  igual(r.ok, true, 'erro foi: ' + r.erro);

  const passos = commits(falso);
  igual(passos.map((p) => p.tipo + ' ' + p.colecao),
    ['grava inscricoes_anuladas', 'apaga inscricoes'],
    'na ordem inversa, morrer no meio apaga a inscrição de um aluno de verdade');
});

teste('com a quarentena caída, NADA é apagado', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);

  // A cópia falha. É o momento exato em que a ordem inversa teria destruído a
  // inscrição e ficado sem cópia nenhuma.
  api.escreverEmLote = () => { throw new Error('Firestore 503 UNAVAILABLE'); };

  const r = api.anularInscricoes({ token: tokenAdmin(api), ids: ['i1', 'i2'] });

  igual(r.ok, false);
  igual(idsDe(falso, 'inscricoes'), ['i1', 'i2', 'i3', 'i4', 'i5'], 'apagou sem ter guardado');
  igual(idsDe(falso, 'inscricoes_anuladas'), []);
});

teste('morrer entre a cópia e a exclusão deixa duplicata — e o desfazer a limpa', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  comLock(api, falso);

  api.excluirEmLote = () => { throw new Error('Firestore 503 UNAVAILABLE'); };
  igual(api.anularInscricoes({ token: tokenAdmin(api), ids: ['i2'] }).ok, false);

  igual(idsDe(falso, 'inscricoes').indexOf('i2') !== -1, true, 'a inscrição continua onde estava');
  igual(idsDe(falso, 'inscricoes_anuladas'), ['i2'], 'e a cópia ficou para trás');

  // O estrago inteiro: uma cópia órfã. Restaurar percebe que ela já está de
  // volta, limpa a quarentena e não disputa vaga nenhuma.
  delete api.excluirEmLote;
  const r = api.restaurarInscricoes({ token: tokenAdmin(api), ids: ['i2'] });

  igual(r.ja_estavam, 1);
  igual(r.restauradas, 1);
  igual(idsDe(falso, 'inscricoes_anuladas'), []);
});

teste('a cópia preserva o id original e carimba quem anulou e quando', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);

  api.anularInscricoes({ token: tokenAdmin(api), ids: ['i2'] });

  const copia = campos(falso, 'inscricoes_anuladas', 'i2');
  verdadeiro(copia !== null, 'a cópia tem de morar no id original: ele é a chave de dedup');
  igual(copia.nome.stringValue, 'kkkk jjjj');
  igual(copia.matricula.stringValue, '999999');
  igual(copia.anulado_por.stringValue, 'coordenacao@exemplo.com');
  verdadeiro(copia.anulado_em.stringValue.length === 19, 'anulado_em foi ' + copia.anulado_em.stringValue);
  igual(campos(falso, 'inscricoes', 'i2'), null);
});

// Apagar só LIBERA vaga; quem decide vaga é `reservarVaga`, contando dentro do
// lock. Segurar o lock do auditório para fazer limpeza é o oposto do objetivo.
teste('anular NÃO pega o lock', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  const eventos = comLock(api, falso);

  api.anularInscricoes({ token: tokenAdmin(api), ids: ['i1', 'i2'] });

  igual(eventos.length, 0, 'a limpeza parou a fila da inscrição do aluno');
});

teste('a vaga liberada aparece na contagem, e a fila continua fora dela', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);

  igual(api.contarInscritos_('p1'), 2);
  api.anularInscricoes({ token: tokenAdmin(api), ids: ['i2'] });

  igual(api.contarInscritos_('p1'), 1, 'anular não devolveu a vaga');
  igual(api.contarEmEspera_('p1'), 3, 'e não mexeu em quem espera');
  igual(idsDe(falso, 'inscricoes'), ['i1', 'i3', 'i4', 'i5']);
});

teste('id que não existe mais não derruba o lote, e é contado à parte', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);

  const r = api.anularInscricoes({ token: tokenAdmin(api), ids: ['i1', 'sumiu', 'i2'] });

  igual(r.anuladas, 2);
  igual(r.nao_encontradas, 1);
  igual(idsDe(falso, 'inscricoes_anuladas'), ['i1', 'i2']);
});

teste('lote inteiro inexistente responde ok, sem apagar nem gravar', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  falso.requisicoes.length = 0;

  const r = api.anularInscricoes({ token: tokenAdmin(api), ids: ['nada', 'nadinha'] });

  igual(r.ok, true);
  igual(r.anuladas, 0);
  igual(r.pedidas, 2);
  igual(commits(falso), [], 'um `:commit` vazio é requisição paga para não fazer nada');
});

// Os NÚMEROS em campos, a frase só para o que os números escondem. A tela monta
// "Anulei 3 de 3" com o que já recebeu; a contagem repetida na mensagem sairia
// duas vezes na mesma linha.
teste('o relato do anular não repete a contagem que a tela já tem', () => {
  const { api } = ambiente();
  auditorioLotado(api);
  const token = tokenAdmin(api);

  const limpo = api.anularInscricoes({ token: token, ids: ['i1', 'i2'] });
  igual([limpo.anuladas, limpo.pedidas], [2, 2]);
  igual(limpo.mensagem, '', 'sem nada a acrescentar, a frase é vazia');

  const comSobra = api.anularInscricoes({ token: token, ids: ['i3', 'sumiu'] });
  igual([comSobra.anuladas, comSobra.pedidas, comSobra.nao_encontradas], [1, 2, 1]);
  verdadeiro(comSobra.mensagem.indexOf('já não estava') !== -1, 'a frase foi: ' + comSobra.mensagem);
});

teste('sem id nenhum é recusado antes de qualquer leitura', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  falso.requisicoes.length = 0;

  [{}, { ids: [] }, { ids: ['', '   '] }, { ids: 'i1/../projetos' }].forEach((payload) => {
    const r = api.anularInscricoes(Object.assign({ token: tokenAdmin(api) }, payload));
    igual(r.ok, false, JSON.stringify(payload) + ' passou');
    igual(r.erro, 'Nenhuma inscrição selecionada.');
  });

  igual(commits(falso), []);
});

teste('id repetido no payload não vira duas cópias, e o teto é 200', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);

  igual(api.anularInscricoes({ token: tokenAdmin(api), ids: ['i1', 'i1', 'i1'] }).anuladas, 1);
  igual(commits(falso).filter((c) => c.tipo === 'apaga')[0].quantas, 1);

  const muitos = [];
  for (let i = 0; i < 500; i++) muitos.push('inexistente_' + i);
  igual(api.anularInscricoes({ token: tokenAdmin(api), ids: muitos }).nao_encontradas, 200,
    'o lote sem teto morre no meio dos 6 minutos, e é aí que a quarentena fica pela metade');
});

teste('a trilha registra uma linha por lote, com quem mandou', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);

  api.anularInscricoes({ token: tokenAdmin(api), ids: ['i1', 'i2'] });

  igual(acoesDoLog(falso), ['INSCRICOES_ANULADAS'], 'uma linha por id queimaria a cota de escrita');
  let detalhe = '';
  falso.documentos.forEach((c, chave) => {
    if (chave.indexOf('log/') === 0) detalhe = c.detalhe.stringValue;
  });
  verdadeiro(detalhe.indexOf('coordenacao@exemplo.com') !== -1, 'a trilha não diz quem anulou: ' + detalhe);
  verdadeiro(detalhe.indexOf('i1') !== -1 && detalhe.indexOf('i2') !== -1,
    'sem os ids, a trilha não permite desfazer nada: ' + detalhe);
});

grupo('restaurarInscricoes — conferindo vaga, uma a uma');

teste('com vaga livre, a inscrição volta inteira e sai da quarentena', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  comLock(api, falso);
  api.anularInscricoes({ token: tokenAdmin(api), ids: ['i2'] });

  const r = api.restaurarInscricoes({ token: tokenAdmin(api), ids: ['i2'] });

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.restauradas, 1);
  igual(r.com_vaga, 1);
  igual(r.naoCouberam, 0);

  const volta = campos(falso, 'inscricoes', 'i2');
  igual(volta.nome.stringValue, 'kkkk jjjj');
  igual(volta.anulado_em, undefined, 'a marca da anulação não é da inscrição');
  igual(volta.anulado_por, undefined);
  igual(idsDe(falso, 'inscricoes_anuladas'), []);
  igual(api.contarInscritos_('p1'), 2);
});

// Sem esta conferência, o desfazer é um caminho paralelo para furar o limite de
// vagas — que é a única coisa que este sistema promete de verdade.
teste('o que estouraria a vaga não volta, e o relato diz quantos couberam', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p1', { vagas: '2' });
  inscrever(api, 'a1', { criado_em: '2026-08-14 21:00:01' });
  inscrever(api, 'a2', { criado_em: '2026-08-14 21:00:02' });
  inscrever(api, 'a3', { criado_em: '2026-08-14 21:00:03' });
  comLock(api, falso);

  // Três anuladas de um projeto de duas vagas; enquanto isso, alguém novo entra.
  api.anularInscricoes({ token: tokenAdmin(api), ids: ['a1', 'a2', 'a3'] });
  inscrever(api, 'novo', { criado_em: '2026-08-14 21:05:00' });

  const r = api.restaurarInscricoes({ token: tokenAdmin(api), ids: ['a1', 'a2', 'a3'] });

  igual(r.restauradas, 1, 'só uma vaga sobrava');
  igual(r.naoCouberam, 2);
  igual(api.contarInscritos_('p1'), 2, 'o desfazer furou o limite de vagas');
  igual(idsDe(falso, 'inscricoes_anuladas'), ['a2', 'a3'], 'quem não coube continua guardado');
  verdadeiro(r.mensagem.indexOf('não coube') !== -1, 'a mensagem foi: ' + r.mensagem);
});

teste('com a fila ligada, quem não cabe volta PARA A FILA, e não some', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  comLock(api, falso);
  api.anularInscricoes({ token: tokenAdmin(api), ids: ['i1', 'i2'] });
  inscrever(api, 'novo1', { criado_em: '2026-08-14 21:05:00' });
  inscrever(api, 'novo2', { criado_em: '2026-08-14 21:05:01' });

  const r = api.restaurarInscricoes({ token: tokenAdmin(api), ids: ['i1', 'i2'] });

  igual(r.restauradas, 2, 'as duas voltaram ao sistema');
  igual(r.com_vaga, 0);
  igual(r.em_espera, 2);
  igual(campos(falso, 'inscricoes', 'i1').em_espera.stringValue, 'SIM');
  igual(campos(falso, 'inscricoes', 'i1').espera_de.stringValue, 'p1');
  igual(api.contarInscritos_('p1'), 2, 'quem voltou para a fila ocupou vaga');
  verdadeiro(r.mensagem.indexOf('lista de espera') !== -1, 'a mensagem foi: ' + r.mensagem);
});

teste('quem estava na fila e encontra vaga aberta volta CONFIRMADO', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  comLock(api, falso);

  api.anularInscricoes({ token: tokenAdmin(api), ids: ['i5', 'i1', 'i2'] });
  const r = api.restaurarInscricoes({ token: tokenAdmin(api), ids: ['i5'] });

  igual(r.com_vaga, 1);
  igual(campos(falso, 'inscricoes', 'i5').em_espera, undefined,
    'copiar a marca velha gravaria uma verdade de ontem');
  igual(api.contarEmEspera_('p1'), 2);
});

teste('restaurar não inventa inscrição que nunca foi anulada', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  comLock(api, falso);

  const r = api.restaurarInscricoes({ token: tokenAdmin(api), ids: ['nunca_existiu'] });

  igual(r.restauradas, 0);
  igual(r.recusadas, [{ id: 'nunca_existiu', motivo: 'não está entre as anuladas' }]);
  igual(idsDe(falso, 'inscricoes'), ['i1', 'i2', 'i3', 'i4', 'i5']);
});

teste('inscrição sem projeto volta sem disputar vaga com ninguém', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  inscrever(api, 'interna', { projeto_id: '', projeto_nome: '', origem: 'SITE' });
  const eventos = comLock(api, falso);
  api.anularInscricoes({ token: tokenAdmin(api), ids: ['interna'] });

  const r = api.restaurarInscricoes({ token: tokenAdmin(api), ids: ['interna'] });

  igual(r.restauradas, 1);
  igual(eventos.length, 0, 'quem não ocupa vaga não entra na fila do lock');
  verdadeiro(campos(falso, 'inscricoes', 'interna') !== null);
});

teste('restaurar duas vezes não duplica nem ocupa uma segunda vaga', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  comLock(api, falso);
  api.anularInscricoes({ token: tokenAdmin(api), ids: ['i2'] });

  api.restaurarInscricoes({ token: tokenAdmin(api), ids: ['i2'] });
  const segunda = api.restaurarInscricoes({ token: tokenAdmin(api), ids: ['i2'] });

  igual(segunda.restauradas, 0, 'a segunda não tinha nada a restaurar');
  igual(segunda.recusadas.length, 1);
  igual(api.contarInscritos_('p1'), 2);
  igual(idsDe(falso, 'inscricoes'), ['i1', 'i2', 'i3', 'i4', 'i5']);
});

teste('a trilha registra a restauração', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  comLock(api, falso);
  api.anularInscricoes({ token: tokenAdmin(api), ids: ['i2'] });

  api.restaurarInscricoes({ token: tokenAdmin(api), ids: ['i2'] });

  // PROJETO_ESGOTADO no meio não é ruído: a inscrição que voltou preencheu a
  // última vaga, e é `reservarVaga` avisando o professor — o mesmo aviso que
  // sairia se um aluno tivesse ocupado aquela vaga pelo site.
  igual(acoesDoLog(falso),
    ['INSCRICOES_ANULADAS', 'PROJETO_ESGOTADO', 'INSCRICOES_RESTAURADAS']);
});

grupo('promoverDaEspera — ocupa vaga, e por isso conta dentro do lock');

teste('promove na ordem em que os ids vieram e para quando enche', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  comLock(api, falso);
  api.anularInscricoes({ token: tokenAdmin(api), ids: ['i2'] });   // libera UMA vaga

  const r = api.promoverDaEspera({ token: tokenAdmin(api), ids: ['i3', 'i4', 'i5'] });

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.promovidos, 1);
  igual(r.naoCouberam, 2);
  igual(campos(falso, 'inscricoes', 'i3').em_espera, undefined, 'o primeiro da lista é quem entra');
  igual(campos(falso, 'inscricoes', 'i4').em_espera.stringValue, 'SIM');
  igual(api.contarInscritos_('p1'), 2, 'promover estourou as vagas');
  igual(api.contarEmEspera_('p1'), 2);
  verdadeiro(r.mensagem.indexOf('não coube') !== -1, 'a mensagem foi: ' + r.mensagem);
});

// Cem `waitLock` seguidos no meio do evento é o que trava a inscrição do aluno.
teste('o lote inteiro pega o lock UMA vez', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '10' });
  criarProjeto(api, 'p2', { vagas: '10', nome: 'Outro' });
  inscrever(api, 'x1', { projeto_id: 'p2', em_espera: 'SIM', criado_em: '2026-08-14 21:00:07' });
  inscrever(api, 'x2', { projeto_id: 'p2', em_espera: 'SIM', criado_em: '2026-08-14 21:00:08' });
  const eventos = comLock(api, falso);

  const r = api.promoverDaEspera({ token: tokenAdmin(api), ids: ['i3', 'i4', 'i5', 'x1', 'x2'] });

  igual(r.promovidos, 5);
  igual(quantosDoTipo(eventos, 'pediu'), 1, 'um waitLock por pessoa põe o auditório na fila da limpeza');
  igual(quantosDoTipo(eventos, 'soltou'), 1);
});

teste('a contagem e a escrita caem DENTRO da região protegida; as leituras, fora', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '10' });
  const eventos = comLock(api, falso);
  falso.requisicoes.length = 0;

  api.promoverDaEspera({ token: tokenAdmin(api), ids: ['i3', 'i4', 'i5'] });

  const pegou = marco(eventos, 'pegou');
  const soltou = marco(eventos, 'soltou');
  const indice = (casa) => falso.requisicoes.findIndex(casa);

  const agregacao = indice((q) => q.url.indexOf(':runAggregationQuery') !== -1);
  const escrita = indice((q) => q.url.indexOf(':commit') !== -1);
  const leitura = indice((q) => q.metodo === 'GET' && q.url.indexOf('/inscricoes/') !== -1);

  verdadeiro(leitura !== -1 && leitura < pegou, 'ler os documentos não participa do invariante: ' + leitura);
  verdadeiro(agregacao >= pegou && agregacao < soltou, 'a contagem ficou fora do lock: ' + agregacao);
  verdadeiro(escrita >= pegou && escrita < soltou, 'a escrita ficou fora do lock: ' + escrita);
  igual(soltou - pegou, 3, 'duas agregações (total e fila) e UMA escrita em lote para as três pessoas');
});

teste('a promoção é UMA escrita em lote, e não uma por pessoa', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '10' });
  comLock(api, falso);
  falso.requisicoes.length = 0;

  api.promoverDaEspera({ token: tokenAdmin(api), ids: ['i3', 'i4', 'i5'] });

  const escritas = commits(falso);
  igual(escritas.length, 1, 'três PATCH dentro do lock são três vezes a fila do auditório');
  igual(escritas[0].quantas, 3);
});

// A escrita em lote SUBSTITUI o documento. Mandar só os dois campos apagaria a
// inscrição inteira, e o aluno viraria um documento com dois campos.
teste('promover preserva o resto do documento, campo por campo', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '10' });
  comLock(api, falso);

  api.promoverDaEspera({ token: tokenAdmin(api), ids: ['i3'] });

  const doc = campos(falso, 'inscricoes', 'i3');
  igual(doc.nome.stringValue, 'Bruno Souza');
  igual(doc.matricula.stringValue, '110002');
  igual(doc.criado_em.stringValue, '2026-08-14 21:00:03');
  igual(doc.projeto_id.stringValue, 'p1');
  igual(doc.em_espera, undefined, 'quem ocupa vaga não carrega marca de fila');
  igual(doc.espera_de, undefined);
});

teste('projeto fechado ou inativo não recebe promoção, e nem paga o lock por isso', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '10', inscricoes_abertas: 'NAO' });
  const eventos = comLock(api, falso);

  const r = api.promoverDaEspera({ token: tokenAdmin(api), ids: ['i3', 'i4'] });

  igual(r.promovidos, 0);
  igual(r.naoCouberam, 2);
  igual(r.recusadas[0].motivo, 'o projeto está fechado');
  igual(campos(falso, 'inscricoes', 'i3').em_espera.stringValue, 'SIM', 'promoveu num projeto fechado');
  igual(eventos.length, 0, 'a situação do projeto não depende da contagem, e não serializa ninguém');
});

teste('promover quem já está confirmado não duplica nem consome vaga', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '10' });
  comLock(api, falso);

  const r = api.promoverDaEspera({ token: tokenAdmin(api), ids: ['i1', 'i3', 'i1'] });

  igual(r.promovidos, 1, 'só o i3 estava na fila');
  igual(r.ja_confirmadas, 1, 'e o i1 já ocupava vaga — repetido no payload ou não');
  igual(api.contarInscritos_('p1'), 3, 'a mesma pessoa entrou duas vezes na conta');
  igual(idsDe(falso, 'inscricoes'), ['i1', 'i2', 'i3', 'i4', 'i5']);
});

teste('promover a mesma pessoa duas vezes seguidas é inofensivo', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '10' });
  comLock(api, falso);

  api.promoverDaEspera({ token: tokenAdmin(api), ids: ['i3'] });
  const segunda = api.promoverDaEspera({ token: tokenAdmin(api), ids: ['i3'] });

  igual(segunda.promovidos, 0);
  igual(segunda.ja_confirmadas, 1);
  igual(api.contarInscritos_('p1'), 3);
});

teste('inscrição que sumiu entre a tela e o clique não derruba o lote', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '10' });
  comLock(api, falso);

  const r = api.promoverDaEspera({ token: tokenAdmin(api), ids: ['sumiu', 'i3'] });

  igual(r.promovidos, 1);
  igual(r.recusadas, [{ id: 'sumiu', motivo: 'inscrição não encontrada' }]);
});

teste('sem lock, ninguém é promovido — e a mensagem diz isso', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '10' });
  comLock(api, falso, { falhar: true });

  const r = api.promoverDaEspera({ token: tokenAdmin(api), ids: ['i3'] });

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('ninguém foi promovido') !== -1, 'a mensagem foi: ' + r.erro);
  igual(campos(falso, 'inscricoes', 'i3').em_espera.stringValue, 'SIM');
});

teste('projeto ilimitado promove a fila inteira sem agregação nenhuma', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '0' });
  comLock(api, falso);
  falso.requisicoes.length = 0;

  const r = api.promoverDaEspera({ token: tokenAdmin(api), ids: ['i3', 'i4', 'i5'] });

  igual(r.promovidos, 3);
  igual(falso.requisicoes.filter((q) => q.url.indexOf(':runAggregationQuery') !== -1).length, 0,
    'contar vaga em projeto ilimitado é leitura paga para não decidir nada');
});

teste('a trilha registra quem promoveu e quantos', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  api.atualizar('projetos', 'p1', { vagas: '10' });
  comLock(api, falso);

  api.promoverDaEspera({ token: tokenAdmin(api), ids: ['i3', 'i4'] });

  igual(acoesDoLog(falso), ['PROMOCAO_ESPERA']);
});

grupo('O ciclo inteiro: anular, promover, e a conta fecha');

// É a razão de a peça existir: anular sozinho devolve vagas VAZIAS, com gente
// esperando ao lado.
teste('anular o lixo e promover a fila mantém o projeto em exatamente 2 de 2', () => {
  const { api, falso } = ambiente();
  auditorioLotado(api);
  comLock(api, falso);
  const token = tokenAdmin(api);

  igual(api.filaDeEspera({ token: token }).projetos[0].cabem, 0, 'lotado, com três esperando');

  api.anularInscricoes({ token: token, ids: ['i2'] });
  const depoisDeAnular = api.filaDeEspera({ token: token });
  igual(depoisDeAnular.projetos[0].cabem, 1);
  igual(depoisDeAnular.fila[0].id, 'i3', 'quem chegou primeiro é o primeiro a ser oferecido');

  api.promoverDaEspera({ token: token, ids: [depoisDeAnular.fila[0].id] });

  const fim = api.filaDeEspera({ token: token });
  igual(fim.projetos[0].confirmados, 2);
  igual(fim.projetos[0].cabem, 0);
  igual(fim.projetos[0].emEspera, 2);
  igual(fim.fila.map((f) => f.id), ['i4', 'i5'], 'a fila andou, na ordem');
  igual(api.contarInscritos_('p1'), 2, 'o ciclo inteiro tem de fechar em 2 de 2 vagas');
});

// A contrapartida honesta da chave: desligar a fila devolve quem espera à
// contagem de vagas. É conservador de propósito — nunca vende vaga a mais —, e
// está escrito aqui para ninguém descobrir isso no dia.
teste('desligar a chave com gente na fila engorda a contagem, e nunca a esvazia', () => {
  const { api } = ambiente();
  auditorioLotado(api);
  igual(api.contarInscritos_('p1'), 2);

  api.gravarConfig('vagas_excedentes_em_espera', 'NAO');

  igual(api.contarInscritos_('p1'), 5,
    'com a fila desligada, quem espera volta a contar como vaga ocupada');
  igual(api.listarProjetos(false)[0].situacao, 'ESGOTADO', 'e o erro cai para o lado seguro');
});

// ---------------------------------------------------------------- Resultado

process.exit(resultado());
