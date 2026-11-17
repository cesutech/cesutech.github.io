/**
 * api.js — testa os pontos de entrada do web app (08_Api.gs) sem tocar no Google.
 *
 * O que se prova aqui, em ordem de importância:
 *   1. o ORÇAMENTO DE LEITURA escrito no cabeçalho de 08_Api.gs é medido, e não
 *      afirmado: cada rota tem teste contando as requisições que ela faz ao
 *      Firestore, e há um teste que soma o caminho inteiro de um aluno;
 *   2. o contrato do `text/plain` — o corpo chega em `e.postData.contents`, é
 *      desserializado aqui, e `origem` é carimbada pelo servidor;
 *   3. a rota de matrícula responde sim/não e NADA mais (requisito de LGPD, não
 *      detalhe de resposta);
 *   4. parâmetro faltando, inválido ou desconhecido responde JSON bem formado, e
 *      nunca página — nem a de erro do Apps Script. O servidor não serve página
 *      nenhuma desde 16/11/2026, e o endereço sem rota responde só JSON;
 *   5. o AQUECIMENTO não custa nada e não conta nada: a rota `?api=ping` é medida
 *      em ZERO leitura do Firestore, a resposta dela é conferida caractere a
 *      caractere, e o gatilho que a chama tem a conta da cota testada — é o teste
 *      que impede alguém de baixar o intervalo para um minuto sem ver o preço.
 *
 * Cada chamada de rota passa por `requisicao()`, que descarta o cache de
 * configuração antes de rodar. Sem isso os testes mediriam MENOS leituras do que
 * a produção faz: no Apps Script o escopo global nasce zerado a cada execução, e
 * aqui o sandbox é o mesmo para o arquivo inteiro. Medir a rota como se ela
 * herdasse o cache da rota anterior seria mentir a favor do próprio número.
 *
 * Os serviços que 08_Api.gs usa e o `apoio.js` não tem — ContentService,
 * CacheService, LockService — são falsos deste arquivo, injetados no sandbox
 * depois do `criarAmbiente` (o objeto devolvido É o global do vm). HtmlService
 * NÃO existe aqui, e é de propósito: o servidor não pode mais usá-lo, e um
 * `doGet` que voltasse a montar página estouraria neste sandbox.
 * Nenhuma linha do `apoio.js` mudou: ele é compartilhado com as outras fases.
 *
 * Uso:  node testes/api.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  teste, grupo, igual, verdadeiro, lancou, resultado, criarAmbiente, criarRelogio
} = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');

// Na ordem alfabética em que o editor do Apps Script carrega os arquivos.
//
// 12_Disciplinas.gs entrou porque `dadosFormularioPublico_` passou a montar
// `cursosFases` a partir da coleção `disciplinas` (`cursosFasesAtivos_`), e não
// mais da chave de configuração. Sem o arquivo aqui, a rota `?api=config`
// estouraria e o `doGet` responderia a falha genérica — os testes mediriam o
// caminho de erro achando que mediam o de sucesso.
//
// A lista deixou de ser um subconjunto em 06/08, e a razão é o despacho do
// painel: `funcoesDoPainel_` (08_Api.gs) referencia por NOME cada função
// despachável, e elas nascem em 05, 06, 09, 10, 11 e 12. Carregar só metade dos
// arquivos faria o mapa estourar com ReferenceError, e o teste veria a falha
// genérica do `doPost` onde deveria ver a resposta da rota — mediria o caminho
// de erro achando que media o de sucesso, que é o mesmo tropeço que trouxe
// 12_Disciplinas.gs para cá.
//
// O efeito colateral é bom: esta suíte passou a rodar contra o mesmo conjunto de
// arquivos que a implantação tem, e não contra um recorte conveniente.
//
// 07b_LinkPorEmail.gs entrou em 11/08, com a saída do PIN, e por dois motivos que
// não são de conveniência:
//   - `gravarConfig_('admin_emails', ...)` chama `esquecerAllowlistDoLink_`, que
//     nasce lá. Sem o arquivo, QUALQUER teste que mexa na allowlist estoura com
//     ReferenceError — e estourava;
//   - `modoDeAcesso_` pergunta a `linkDeAcessoDisponivel_`, também de lá. Sem o
//     arquivo, a rota de login respondia a falha genérica, e o teste dela media o
//     caminho de erro achando que media o de sucesso.
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '02b_Drive.gs', '03_Config.gs',
  '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs', '05b_FormatoAcademico.gs', '05c_Revisao.gs',
  '06_Reconciliacao.gs', '07_Auth.gs', '07b_LinkPorEmail.gs', '08_Api.gs', '09_Projetos.gs',
  '10_Painel.gs', '11_Banners.gs', '12_Disciplinas.gs', '13_Auditorio.gs'];

// ------------------------------------------------------------ Serviços falsos

/** ContentService: guarda o texto e o mime, para o teste ler os dois. */
function contentServiceFalso() {
  return {
    MimeType: { JSON: 'application/json' },
    createTextOutput(texto) {
      const saida = {
        _texto: String(texto),
        _mime: '',
        setMimeType(m) { saida._mime = m; return saida; },
        getContent() { return saida._texto; },
        getMimeType() { return saida._mime; }
      };
      return saida;
    }
  };
}

/**
 * CacheService com os eventos à mostra.
 * `quebrar` faz `get` e `put` estourarem — é como se prova que o cache é
 * otimização e nunca dependência.
 *
 * `remove` existe porque `esquecerAllowlistDoLink_` (07b_LinkPorEmail.gs) o
 * chama, e a chamada dela mora dentro de um `try/catch`: sem o método aqui, a
 * invalidação da allowlist estouraria em silêncio e o teste que a mede passaria
 * medindo o cache que nunca foi limpo.
 *
 * `quebrarServico` derruba o `getScriptCache()` inteiro, que é o modo degradado
 * de 07b — diferente de `quebrarGet`, que é o cache respondendo e falhando.
 */
function cacheServiceFalso(opcoes) {
  opcoes = opcoes || {};
  const dados = new Map();
  const eventos = [];

  const servico = {
    getScriptCache() {
      if (opcoes.quebrarServico) throw new Error('CacheService indisponível');
      return {
        get(chave) {
          eventos.push({ tipo: 'get', chave });
          if (opcoes.quebrarGet) throw new Error('cache indisponível');
          return dados.has(chave) ? dados.get(chave).valor : null;
        },
        put(chave, valor, segundos) {
          eventos.push({ tipo: 'put', chave, segundos, tamanho: String(valor).length });
          if (opcoes.quebrarPut) throw new Error('valor grande demais');
          dados.set(chave, { valor: valor, segundos: segundos });
        },
        remove(chave) {
          eventos.push({ tipo: 'remove', chave });
          dados.delete(chave);
        }
      };
    }
  };

  return { servico, dados, eventos, expirar() { dados.clear(); } };
}

/**
 * Os eventos do cache, menos os da configuração e os da conferência de sessão.
 *
 * Desde 17/11/2026 a configuração também passa pelo cache do script
 * (`CONFIG_CACHE_CHAVE`, 03_Config.gs): toda rota que lê uma chave faz um `get`
 * com ela, e a primeira faz também o `put`. E a conferência do token do painel
 * conta as faltas da hora e lembra as sessões conhecidas no mesmo cache
 * (`SESSAO_TETO_FALTAS_HORA`, 07_Auth.gs). Os testes que contam eventos falam do
 * cache DAS ROTAS e da chave de repetição; a configuração e a sessão têm os
 * testes delas, nos grupos "a configuração no cache do script" e "as
 * propriedades do script têm cota". O ping não usa este filtro: a rota do
 * aquecimento não fala com cache nenhum.
 */
function eventosDasRotas(a) {
  return a.cache.eventos.filter((e) => e.chave !== a.api.CONFIG_CACHE_CHAVE &&
    e.chave.indexOf(a.api.SESSAO_CONHECIDA_PREFIXO) !== 0 &&
    e.chave.indexOf('sessao_faltas_') !== 0);
}

/**
 * MailApp que guarda em vez de enviar, com a cota sob o controle do teste.
 *
 * Entrou junto com 07b_LinkPorEmail.gs: sem ele, `linkDeAcessoDisponivel_` cai
 * no `catch` de "escopo não concedido" e `modoDeAcesso_` responde que a porta de
 * recuperação está fechada — o que faria a rota de login ser testada sempre no
 * estado degradado.
 */
function mailAppFalso(cotaInicial) {
  const correio = { enviados: [], cota: cotaInicial === undefined ? 100 : cotaInicial };

  correio.servico = {
    getRemainingDailyQuota: () => correio.cota,
    sendEmail(mensagem) {
      correio.enviados.push(mensagem);
      correio.cota--;
    }
  };
  return correio;
}

/** LockService mínimo: `reservarVaga_` precisa dele, e o doPost passa por lá. */
function lockServiceFalso() {
  return {
    getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
  };
}

// ------------------------------------------------------------ Ambiente

/**
 * Sandbox com os `.gs` carregados, a configuração padrão semeada e os serviços
 * falsos no lugar. `semCache` deixa o `CacheService` fora do sandbox, que é o
 * caminho de quem roda sem o serviço disponível.
 */
function montar(opcoes) {
  opcoes = opcoes || {};
  const ambiente = criarAmbiente({
    arquivos: GS,
    usuario: opcoes.usuario === undefined ? '' : opcoes.usuario,
    // Sem `usuarioEfetivo`, a conta que RODA o script é a mesma que a que acessa
    // — aqui, vazia. É o estado de produção: web app anônimo. Só os testes de
    // `liberarMeuAcesso_` a preenchem, para provar que ela libera a conta
    // EFETIVA; no editor de verdade as duas contas são a mesma.
    usuarioEfetivo: opcoes.usuarioEfetivo,
    relogio: opcoes.relogio
  });
  // O valor com que a execução NASCE (03_Config.gs: o cache do script desligado).
  // `requisicao` o repõe antes de cada rota: repor um `false` escrito aqui
  // esconderia a mutação em que a execução nasce com ele ligado.
  ambiente.flagDeclarada = ambiente.api.CONFIG_CACHE_DO_SCRIPT_VALE;
  // O mesmo para o projeto e o banco guardados por execução (02_Repo.gs).
  ambiente.alvoDeclarado = ambiente.api.FIRESTORE_DA_EXECUCAO;

  const cache = cacheServiceFalso(opcoes.cache);
  const correio = mailAppFalso(opcoes.cota);

  ambiente.api.ContentService = contentServiceFalso();
  ambiente.api.LockService = lockServiceFalso();
  ambiente.api.MailApp = correio.servico;
  // O `Utilities.computeDigest` do `apoio.js` responde MD5 para qualquer
  // algoritmo, e nem conhece a constante SHA_256. `impressaoDoLink_` só precisa
  // que ida e volta batam — mas um hash de mentira que o próprio falso escolhe
  // não é o hash que a produção guarda, e a diferença apareceria no dia em que o
  // formato mudasse.
  ambiente.api.Utilities.DigestAlgorithm.SHA_256 = 'SHA_256';
  const digestPadrao = ambiente.api.Utilities.computeDigest;
  ambiente.api.Utilities.computeDigest = (algoritmo, texto) => {
    if (algoritmo !== 'SHA_256') return digestPadrao(algoritmo, texto);
    return Array.from(crypto.createHash('sha256').update(String(texto), 'utf8').digest())
      .map((b) => (b > 127 ? b - 256 : b));
  };
  // `criarAmbiente` já entrega um CacheService próprio (o que expira junto com o
  // relógio falso, usado pelos testes de agrupamento de recusa). Aqui trocamos
  // pelo desta suíte, que expõe os eventos — e `semCache` precisa APAGAR, não só
  // deixar de sobrescrever: sem isso o cache do apoio.js continuaria valendo e o
  // teste de "sem cache" testaria o contrário do que promete.
  if (opcoes.semCache) delete ambiente.api.CacheService;
  else ambiente.api.CacheService = cache.servico;

  ambiente.cache = cache;
  ambiente.correio = correio;

  // O `apoio.js` guarda o que foi PEDIDO ao Firestore; para contar leitura
  // cobrada é preciso saber o que VOLTOU — uma consulta cobra por documento
  // devolvido, e não por chamada. Este envelope registra as duas pontas sem
  // tocar no falso compartilhado.
  const respostas = [];
  const fetchOriginal = ambiente.falso.UrlFetchApp.fetch;
  const fetchAllOriginal = ambiente.falso.UrlFetchApp.fetchAll;
  const anotar = (url, opcoesFetch, r) => {
    respostas.push({
      url: url,
      metodo: String(opcoesFetch.method).toUpperCase(),
      codigo: r.getResponseCode(),
      texto: r.getContentText()
    });
    return r;
  };
  ambiente.api.UrlFetchApp = {
    fetch(url, opcoesFetch) {
      return anotar(url, opcoesFetch, fetchOriginal(url, opcoesFetch));
    },
    // Cada requisição do lote é anotada uma a uma: para o orçamento de leitura,
    // seis agregações em paralelo custam o mesmo que seis em fila. O que muda é
    // o tempo, e esse não se mede aqui.
    fetchAll(lote) {
      const rs = fetchAllOriginal(lote);
      rs.forEach((r, i) => anotar(lote[i].url, lote[i], r));
      return rs;
    }
  };
  ambiente.respostas = respostas;

  if (!opcoes.semSemear) ambiente.api.semearConfigPadrao_();
  zerar(ambiente);
  return ambiente;
}

/**
 * Leituras COBRADAS pelo Firestore, e não requisições HTTP.
 *
 * A diferença é o assunto do orçamento: uma consulta é uma requisição só e cobra
 * um documento por documento devolvido (mínimo de um, mesmo voltando vazia); uma
 * agregação cobra por bloco de mil entradas de índice varridas, o que nas
 * contagens deste sistema é sempre um; e a leitura por id cobra um, inclusive
 * quando o documento não existe.
 */
function leiturasCobradas(ambiente) {
  return ambiente.respostas.reduce((soma, r) => {
    if (r.url.indexOf(':runAggregationQuery') !== -1) return r.codigo === 200 ? soma + 1 : soma;

    if (r.url.indexOf(':runQuery') !== -1) {
      if (r.codigo !== 200) return soma;
      const documentos = JSON.parse(r.texto).filter((linha) => linha && linha.document);
      return soma + Math.max(1, documentos.length);
    }

    if (r.metodo === 'GET' && (r.codigo === 200 || r.codigo === 404)) return soma + 1;
    return soma;
  }, 0);
}

/**
 * Uma execução do web app.
 *
 * Zera o cache de configuração DA EXECUÇÃO e o contador de requisições ANTES de
 * chamar a rota — é o que torna a medição comparável com a produção, onde cada
 * requisição HTTP é uma execução nova, com o escopo global zerado. O cache do
 * SCRIPT (CacheService) sobrevive, como sobrevive em produção: é ele que faz a
 * requisição seguinte não ler a configuração no banco (03_Config.gs). Quem
 * precisa da execução sem nada guardado chama `limparCacheConfig_()`.
 */
function requisicao(ambiente, fn) {
  ambiente.api.CONFIG_CACHE = null;
  ambiente.api.CONFIG_CACHE_DO_SCRIPT_VALE = ambiente.flagDeclarada;
  // O projeto e o banco que 02_Repo.gs guarda por execução também nascem vazios
  // a cada requisição, como em produção.
  ambiente.api.FIRESTORE_DA_EXECUCAO = ambiente.alvoDeclarado;
  zerar(ambiente);
  return fn();
}

function get(ambiente, parametros) {
  return requisicao(ambiente, () => ambiente.api.doGet({ parameter: parametros }));
}

function post(ambiente, corpo, tipo) {
  return requisicao(ambiente, () => ambiente.api.doPost({
    postData: {
      // O site manda text/plain de propósito, para a requisição ser "simples" e
      // não disparar o preflight OPTIONS. É o contrato de docs/assets/app.js:515.
      type: tipo === undefined ? 'text/plain' : tipo,
      contents: typeof corpo === 'string' ? corpo : JSON.stringify(corpo)
    }
  }));
}

function corpoDe(saida) {
  return JSON.parse(saida.getContent());
}

function zerar(ambiente) {
  ambiente.falso.requisicoes.length = 0;
  ambiente.respostas.length = 0;
  ambiente.usosDePropriedade.length = 0;
}

function quantas(falso, casa) {
  return falso.requisicoes.filter(casa).length;
}

const CONSULTA = (r) => r.url.indexOf(':runQuery') !== -1;
const AGREGACAO = (r) => r.url.indexOf(':runAggregationQuery') !== -1;
const LEITURA_CONFIG = (r) => r.metodo === 'GET' && r.url.indexOf('/config/') !== -1;
const LEITURA_PROJETO = (r) => r.metodo === 'GET' && r.url.indexOf('/projetos/') !== -1;
const LEITURA_MATRICULA = (r) => r.metodo === 'GET' && r.url.indexOf('/matriculados/') !== -1;

/** As ações da trilha, na ordem de inserção do Map (e não na ordem do id). */
function acoesDoLog(falso) {
  const acoes = [];
  falso.documentos.forEach((campos, chave) => {
    if (chave.indexOf('log/') === 0) acoes.push(campos.acao.stringValue);
  });
  return acoes;
}

function criarProjeto(api, id, campos) {
  api.inserir_('projetos', Object.assign({
    codigo: id,
    nome: 'Projeto ' + id,
    descricao: 'Descrição do ' + id,
    professor: 'Marina Exemplo',
    vagas: '60',
    ativo: 'SIM',
    inscricoes_abertas: 'SIM',
    validar_matricula: 'SIM',
    ordem: '1',
    criado_em: '2026-08-05 10:00:00'
  }, campos || {}), id);
}

/** Semeia a lista oficial como a importação vai semear: id = matrícula. */
function matricular(api, matriculas, extras) {
  matriculas.forEach((m) => {
    // O id É a matrícula NORMALIZADA, como 05_Importacao.gs grava. Semear com o
    // valor cru faria o teste passar com uma chave que a produção nunca usa —
    // e a busca, que normaliza, não acharia nada.
    const chave = api.normalizarMatricula_(m);
    api.inserir_('matriculados', Object.assign({
      matricula: chave, matricula_oficial: chave === m ? '' : m,
      nome: 'Aluno ' + m, curso: 'ADS', email: m + '@aluno.br'
    }, extras || {}), chave);
  });
}

const INSCRICAO_VALIDA = {
  matricula: '9110001',
  nome: 'Maria da Silva',
  email: 'maria@aluno.br',
  whatsapp: '48999998888',
  curso_fase: 'PROJETO INTERDISCIPLINAR II - AU71',
  declara_ciencia: true,
  autoriza_imagem: true,
  consentimento_lgpd: true,
  website: '',
  tempoPreenchimento: 45000
};

// ------------------------------------------------------------ ?api=config

grupo('doGet ?api=config — o que o formulário precisa para se desenhar');

teste('devolve a configuração pública, com os cursos em lista', () => {
  const a = montar();
  const r = corpoDe(get(a, { api: 'config' }));

  igual(r.ok, true);
  igual(r.dados.aberto, true);
  igual(r.dados.exigirMatricula, true);
  igual(r.dados.exigirCpf, false);
  igual(r.dados.cursosFases.length, 13);
  verdadeiro(r.dados.textoLgpd.indexOf('13.709') !== -1, 'o texto da LGPD veio do banco');
});

teste('responde com mime JSON', () => {
  const a = montar();
  igual(get(a, { api: 'config' }).getMimeType(), 'application/json');
});

teste('custa a configuração mais UMA consulta às disciplinas ativas', () => {
  // Era uma leitura só. `cursosFases` deixou de sair da chave `cursos_fases` e
  // passa a sair da coleção `disciplinas` (12_Disciplinas.gs), então entra uma
  // consulta — que cobra um documento por documento devolvido, e o mínimo de um
  // quando volta vazia, como aqui. Com D disciplinas ativas a rota custa 1 + D.
  // O porquê de o número valer a pena, e o cache que impede D de virar um
  // problema de cota, estão no Orçamento de leitura no alto de 08_Api.gs.
  const a = montar();
  get(a, { api: 'config' });

  igual(a.falso.requisicoes.length, 2, 'a rota inteira');
  igual(quantas(a.falso, LEITURA_CONFIG), 1, 'a leitura da configuração');
  igual(quantas(a.falso, CONSULTA), 1, 'e a consulta das disciplinas');
});

teste('coleção de disciplinas vazia devolve a lista de cursos_fases, e não um select vazio', () => {
  // Select vazio faz TODA inscrição morrer em "Selecione seu curso e fase" — é
  // o defeito que já recusou inscrição neste sistema. O caminho de volta para a
  // chave de configuração está provado em detalhe em testes/disciplinas.js;
  // aqui o que se prova é que a ROTA o entrega.
  const a = montar();
  igual(corpoDe(get(a, { api: 'config' })).dados.cursosFases.length, 13);
});

teste('a segunda chamada não vai ao Firestore: responde do cache', () => {
  const a = montar();
  const primeira = corpoDe(get(a, { api: 'config' }));

  const segunda = get(a, { api: 'config' });
  igual(a.falso.requisicoes.length, 0, 'requisições da segunda chamada');
  igual(corpoDe(segunda), primeira, 'e a resposta é a mesma');
});

teste('o cache é gravado com o prazo declarado em CACHE_ROTAS_S', () => {
  const a = montar();
  get(a, { api: 'config' });

  const gravou = eventosDasRotas(a).filter((e) => e.tipo === 'put');
  igual(gravou.length, 1);
  igual(gravou[0].chave, a.api.CACHE_CONFIG);
  igual(gravou[0].segundos, a.api.CACHE_ROTAS_S);
});

teste('expirado o cache, a rota volta a ler o banco', () => {
  const a = montar();
  get(a, { api: 'config' });
  a.cache.expirar();

  get(a, { api: 'config' });
  igual(quantas(a.falso, LEITURA_CONFIG), 1);
});

teste('texto apagado pela coordenação continua apagado', () => {
  const a = montar();
  // O padrão de `texto_imagem` é vazio de propósito: se fosse a frase de
  // CONFIG_PADRAO, limpar o campo pelo painel faria a frase voltar sozinha e
  // não haveria como desligar a autorização de imagem.
  a.api.gravarConfig_('texto_imagem', '');
  a.cache.expirar();

  igual(corpoDe(get(a, { api: 'config' })).dados.textoImagem, '');
});

// ---- a janela geral de inscrição (pedido do Prof. Mário, 19/09, item 5) ----

/** 05/10/2026 às 10:00 em Brasília — `agora_()` formata em -03:00. */
const DENTRO_DA_JANELA = Date.UTC(2026, 9, 5, 13, 0, 0);

function montarNaJanela(chaves) {
  const relogio = criarRelogio(DENTRO_DA_JANELA);
  const a = montar({ relogio });
  Object.keys(chaves || {}).forEach((chave) => a.api.gravarConfig_(chave, chaves[chave]));
  a.relogio = relogio;
  return a;
}

teste('?api=config traz a janela com o `agora` DO SERVIDOR, para o site contar a partir dele', () => {
  const a = montarNaJanela({ inscricoes_inicio: '2026-10-01 08:00', inscricoes_fim: '2026-10-30 18:00' });
  const d = corpoDe(get(a, { api: 'config' })).dados;

  igual(d.janela, {
    estado: 'ABERTA', inicio: '2026-10-01 08:00', fim: '2026-10-30 18:00', agora: '2026-10-05 10:00:00'
  });
  igual(d.aberto, true);
});

teste('sem as chaves, a janela é SEM_JANELA e `aberto` continua como era', () => {
  const a = montarNaJanela({});
  const d = corpoDe(get(a, { api: 'config' })).dados;

  igual(d.janela, { estado: 'SEM_JANELA', inicio: '', fim: '', agora: '2026-10-05 10:00:00' });
  igual(d.aberto, true);
});

teste('`aberto` combina o interruptor manual com a janela — os quatro cantos', () => {
  const aberto = (chaves) => corpoDe(get(montarNaJanela(chaves), { api: 'config' })).dados;

  const antes = aberto({ inscricoes_inicio: '2026-10-07 08:00' });
  igual([antes.janela.estado, antes.aberto], ['ANTES', false]);

  const depois = aberto({ inscricoes_fim: '2026-10-03 18:00' });
  igual([depois.janela.estado, depois.aberto], ['DEPOIS', false]);

  const fechadoNaMao = aberto({ cadastro_aberto: 'NAO', inscricoes_inicio: '2026-10-01 08:00', inscricoes_fim: '2026-10-30 18:00' });
  igual([fechadoNaMao.janela.estado, fechadoNaMao.aberto], ['ABERTA', false],
    'a janela aberta não liga o que a coordenação desligou na mão');

  const dentro = aberto({ inscricoes_inicio: '2026-10-01 08:00', inscricoes_fim: '2026-10-30 18:00' });
  igual([dentro.janela.estado, dentro.aberto], ['ABERTA', true]);
});

teste('chave torta chega ao site já limpa: vazia, como o servidor a tratou', () => {
  const a = montarNaJanela({ inscricoes_inicio: '01/10/2026', inscricoes_fim: '2026-10-30 18:00' });
  const d = corpoDe(get(a, { api: 'config' })).dados;

  igual(d.janela.inicio, '', 'o site receberia um limite que o servidor ignorou');
  igual(d.janela.estado, 'ABERTA');
  verdadeiro(a.registros.erros.some((e) => e.indexOf('inscricoes_inicio') === 0), 'sem aviso no console');
});

teste('o `agora` chega até CACHE_ROTAS_S segundos velho — é o preço do cache, e é aceito', () => {
  const a = montarNaJanela({ inscricoes_fim: '2026-10-30 18:00' });
  get(a, { api: 'config' });

  a.relogio.avancar(20000);
  igual(corpoDe(get(a, { api: 'config' })).dados.janela.agora, '2026-10-05 10:00:00',
    'a resposta veio do cache com o agora de quando foi montada');

  a.cache.expirar();
  igual(corpoDe(get(a, { api: 'config' })).dados.janela.agora, '2026-10-05 10:00:20',
    'renovado o cache, o agora é o de agora');
});

teste('a janela não custa leitura: continua a configuração mais a consulta das disciplinas', () => {
  const a = montarNaJanela({ inscricoes_inicio: '2026-10-01 08:00', inscricoes_fim: '2026-10-30 18:00' });
  get(a, { api: 'config' });

  igual(a.falso.requisicoes.length, 2);
  igual(quantas(a.falso, LEITURA_CONFIG), 1);
});

teste('o POST fora da janela responde JSON com a data, sem `situacao` de projeto', () => {
  // Sem `situacao`: o site trata resposta com `situacao` como "o projeto
  // lotou/fechou enquanto você preenchia" e redesenha o cartão. A janela é
  // outra coisa — a mensagem vai para o `erro-geral`, e o formulário fica.
  const a = montarNaJanela({ inscricoes_fim: '2026-10-03 18:00' });
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);

  const r = corpoDe(post(a, Object.assign({ acao: 'inscricao', projeto_id: 'p1' }, INSCRICAO_VALIDA)));
  igual(r, { ok: false, erro: 'As inscrições encerraram em 03/10/2026 às 18:00.' });
});

// ------------------------------------------------------------ ?api=projetos

grupo('doGet ?api=projetos — os cartões com a situação e a ocupação');

teste('devolve só os projetos ativos, com vagas, inscritos e situação', () => {
  const a = montar();
  criarProjeto(a.api, 'p1', { nome: 'R+ Cidades', vagas: '2', ordem: '1' });
  criarProjeto(a.api, 'p2', { nome: 'Robótica', vagas: '0', ordem: '2' });
  criarProjeto(a.api, 'p3', { nome: 'Escondido', ativo: 'NAO', ordem: '3' });
  a.api.inserir_('inscricoes', { projeto_id: 'p1', matricula: 'A1' }, 'i1');

  const r = corpoDe(get(a, { api: 'projetos' }));

  igual(r.ok, true);
  igual(r.projetos.map((p) => p.nome), ['R+ Cidades', 'Robótica']);
  igual(r.projetos[0].inscritos, 1);
  igual(r.projetos[0].restantes, 1);
  igual(r.projetos[0].situacao, 'ABERTO');
  igual(r.projetos[1].restantes, null, 'vagas 0 = ilimitado');
});

teste('a orientação do formulário viaja junto, como a descrição já viaja', () => {
  // O texto que o aluno lê DENTRO do formulário mora no projeto e chega pela
  // mesma rota dos cartões — não há uma segunda ida ao servidor para buscá-lo.
  // Projeto sem orientação devolve string vazia, e não campo ausente: é o que
  // deixa o site esconder o parágrafo sem precisar adivinhar.
  const a = montar();
  criarProjeto(a.api, 'p1', {
    nome: 'Arte Digital Floripa',
    descricao_formulario: 'Preencha os dados para participar do projeto ARTE DIGITAL FLORIPA.\n' +
      'O primeiro encontro acontece em 21/08/2026, às 19:00h, na sala 225.',
    ordem: '1'
  });
  criarProjeto(a.api, 'p2', { nome: 'Robótica', ordem: '2' });

  const r = corpoDe(get(a, { api: 'projetos' }));

  verdadeiro(r.projetos[0].descricao_formulario.indexOf('sala 225') !== -1,
    'o texto de orientação não chegou ao site: ' + r.projetos[0].descricao_formulario);
  verdadeiro(r.projetos[0].descricao_formulario.indexOf('\n') !== -1,
    'a quebra de linha do professor foi comida no caminho');
  igual(r.projetos[1].descricao_formulario, '', 'projeto sem orientação tem de vir com string vazia');
});

teste('projeto cheio sai como ESGOTADO', () => {
  const a = montar();
  criarProjeto(a.api, 'p1', { vagas: '1' });
  a.api.inserir_('inscricoes', { projeto_id: 'p1', matricula: 'A1' }, 'i1');

  const r = corpoDe(get(a, { api: 'projetos' }));
  igual(r.projetos[0].situacao, 'ESGOTADO');
  igual(r.projetos[0].restantes, 0);
});

teste('custa uma consulta mais uma agregação por projeto ATIVO', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  criarProjeto(a.api, 'p2');
  criarProjeto(a.api, 'p3', { ativo: 'NAO' });

  get(a, { api: 'projetos' });

  igual(quantas(a.falso, CONSULTA), 1, 'a coleção é lida de uma vez');
  igual(quantas(a.falso, AGREGACAO), 2, 'e o inativo não é contado');

  // Quatro, e a quarta é o documento de configuração: `contarInscritos_` pergunta
  // se a fila de espera está ligada (`esperaLigada_`, 09_Projetos.gs). É UMA por
  // execução e não uma por projeto — os dois projetos ativos aqui provam isso, e
  // é o cache de execução de `config_()` que responde a segunda pergunta.
  igual(a.falso.requisicoes.length, 4, 'nada além disso');
});

// Com a fila LIGADA a contagem passa a subtrair quem espera, e isso é uma
// agregação a mais POR PROJETO. É o preço da chave, e ele tem de ser visível
// aqui: o número de leituras da rota pública dobra na prática.
teste('com a fila de espera ligada, cada projeto custa uma agregação a mais', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  criarProjeto(a.api, 'p2');
  a.api.gravarConfig_('vagas_excedentes_em_espera', 'SIM');
  zerar(a);
  a.cache.expirar();

  get(a, { api: 'projetos' });

  igual(quantas(a.falso, AGREGACAO), 4, 'duas contagens e duas subtrações da fila');
});

// A chave de DIAGNÓSTICO de 09_Projetos.gs, medida onde ela existe para ser
// medida: na rota que o aluno chama. Ela não é como o sistema roda — o padrão é
// contar —, e por isso o que se afirma aqui é o preço e o que sobra da resposta.
teste('com contar_ocupacao_na_lista em NAO, a rota não faz agregação nenhuma', () => {
  const a = montar();
  criarProjeto(a.api, 'p1', { vagas: '2', ordem: '1' });
  criarProjeto(a.api, 'p2', { vagas: '60', ordem: '2' });
  a.api.inserir_('inscricoes', { projeto_id: 'p1', matricula: 'A1' }, 'i1');
  a.api.inserir_('inscricoes', { projeto_id: 'p1', matricula: 'A2' }, 'i2');
  a.api.gravarConfig_('contar_ocupacao_na_lista', 'NAO');
  zerar(a);
  a.cache.expirar();

  const r = corpoDe(get(a, { api: 'projetos' }));

  igual(quantas(a.falso, AGREGACAO), 0, 'a chave não desligou a contagem da rota');
  igual(a.falso.requisicoes.length, 2, 'a coleção e a configuração — e o número não cresce com P');
  igual(r.ocupacao_contada, false, 'o envelope precisa dizer o estado da chave em um olhar');
  igual(r.projetos.map((p) => p.inscritos), [null, null], '0 aqui seria "0 / 60" em projeto cheio');
  igual(r.projetos.map((p) => p.ocupacao_contada), [false, false]);
  igual(r.projetos.map((p) => p.vagas), [2, 60], 'o total de vagas continua indo para a tela');
  igual(r.projetos[0].situacao, 'ABERTO',
    'sem contar não há como saber que lotou — quem recusa é o POST, no envio');
});

teste('com a chave em SIM — o padrão — a rota responde como sempre respondeu', () => {
  const a = montar();
  criarProjeto(a.api, 'p1', { vagas: '2' });
  a.api.inserir_('inscricoes', { projeto_id: 'p1', matricula: 'A1' }, 'i1');
  zerar(a);
  a.cache.expirar();

  const r = corpoDe(get(a, { api: 'projetos' }));

  igual(r.ocupacao_contada, true);
  igual(r.projetos[0].inscritos, 1);
  igual(r.projetos[0].ocupacao_contada, true);
  igual(quantas(a.falso, AGREGACAO), 1);
});

// O envelope e o item saem da MESMA pergunta. Dois sinais que pudessem discordar
// seriam pior do que sinal nenhum: a tela obedeceria a um, e quem diagnostica
// leria o outro.
teste('o sinal do envelope e o do projeto nunca discordam', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');

  [['NAO', false], ['SIM', true]].forEach((caso) => {
    a.api.gravarConfig_('contar_ocupacao_na_lista', caso[0]);
    a.cache.expirar();
    const r = corpoDe(get(a, { api: 'projetos' }));
    igual(r.ocupacao_contada, caso[1]);
    igual(r.projetos[0].ocupacao_contada, caso[1]);
  });
});

teste('a segunda chamada não vai ao Firestore', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  const primeira = corpoDe(get(a, { api: 'projetos' }));

  const segunda = get(a, { api: 'projetos' });
  igual(a.falso.requisicoes.length, 0);
  igual(corpoDe(segunda), primeira);
});

teste('inscrição nova NÃO derruba o cache — é a decisão do arquivo', () => {
  const a = montar();
  criarProjeto(a.api, 'p1', { vagas: '10' });
  igual(corpoDe(get(a, { api: 'projetos' })).projetos[0].inscritos, 0);

  post(a, Object.assign({ projeto_id: 'p1' }, INSCRICAO_VALIDA));

  // Invalidar aqui seria o reflexo óbvio, e destruiria o cache exatamente no
  // pico: no auditório entra inscrição a cada poucos segundos. O cartão fica
  // atrasado; quem decide a vaga é `reservarVaga_`, que conta dentro do lock.
  const r = corpoDe(get(a, { api: 'projetos' }));
  igual(r.projetos[0].inscritos, 0, 'o cartão ainda mostra o retrato de antes');
  igual(a.falso.requisicoes.length, 0, 'e não custou leitura');

  a.cache.expirar();
  igual(corpoDe(get(a, { api: 'projetos' })).projetos[0].inscritos, 1, 'passada a janela, aparece');
});

teste('as duas rotas de leitura usam chaves de cache diferentes', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  get(a, { api: 'config' });

  const r = corpoDe(get(a, { api: 'projetos' }));
  verdadeiro(r.projetos !== undefined, 'a rota de projetos não serviu a resposta da config');
  igual(a.api.CACHE_CONFIG === a.api.CACHE_PROJETOS, false);
});

// ------------------------------------------------------------ ?api=matricula

grupo('doGet ?api=matricula — sim ou não, e mais nada');

teste('matrícula na lista responde existe:true', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);

  const r = corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' }));
  igual(r, { ok: true, valida: true, validaProjeto: true, existe: true, listaDisponivel: true, bloqueia: true });
});

teste('a resposta não carrega dado nenhum do aluno', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001'], { nome: 'Maria da Silva', curso: 'ADS', email: 'maria@aluno.br' });

  const bruto = get(a, { api: 'matricula', m: '9110001', p: 'p1' }).getContent();

  // Devolver dado a partir da matrícula transformaria o endereço num oráculo: as
  // matrículas são quase sequenciais, e varrer a faixa entregaria a lista de
  // alunos inteira. O que sai daqui é um bit.
  ['Maria', 'Silva', 'ADS', 'maria@aluno.br', '9110001'].forEach((vazado) => {
    igual(bruto.indexOf(vazado), -1, 'vazou "' + vazado + '" na resposta');
  });
  igual(Object.keys(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' }))).sort(),
    ['bloqueia', 'existe', 'listaDisponivel', 'ok', 'valida', 'validaProjeto']);
});

teste('matrícula fora da lista responde existe:false com a lista disponível', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);

  const r = corpoDe(get(a, { api: 'matricula', m: '9999999', p: 'p1' }));
  igual(r.existe, false);
  igual(r.listaDisponivel, true);
  igual(r.bloqueia, true);
});

teste('sem lista importada, listaDisponivel é false — o site não pode barrar', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');

  const r = corpoDe(get(a, { api: 'matricula', m: '9999999', p: 'p1' }));
  igual(r.existe, false);
  igual(r.listaDisponivel, false);
});

teste('modo AVISAR responde bloqueia:false', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);
  a.api.gravarConfig_('modo_validacao_matricula', 'AVISAR');

  igual(corpoDe(get(a, { api: 'matricula', m: '9999999', p: 'p1' })).bloqueia, false);
});

teste('matrícula CANCELADA na lista oficial responde o corpo IDÊNTICO ao de inexistente', () => {
  // A marca da revisão de uma importação (21/09). Mutação que derruba:
  // acrescentar `cancelada: true` à resposta, ou trocar `listaDisponivel` —
  // "existe e está cancelada" é um segundo bit sobre uma pessoa, entregue a
  // quem consulta anonimamente, e o oráculo passaria a distinguir quem saiu.
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);
  a.api.atualizarEmLote_('matriculados', [{
    _id: '9110001', situacao_cadastro: 'CANCELADO', cancelado_em: '2026-09-21 19:00:00',
    cancelado_por: 'prof@exemplo.com', cancelado_lote_id: 'L2'
  }]);

  const cancelada = get(a, { api: 'matricula', m: '9110001', p: 'p1' }).getContent();
  const inexistente = get(a, { api: 'matricula', m: '9999999', p: 'p1' }).getContent();
  igual(cancelada, inexistente, 'os dois corpos têm de ser byte a byte iguais');
  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).existe, false);
});

teste('projeto que não valida matrícula nem consulta a lista', () => {
  const a = montar();
  criarProjeto(a.api, 'p1', { validar_matricula: 'NAO' });
  matricular(a.api, ['9110001']);

  const r = corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' }));
  igual(r, { ok: true, valida: true, validaProjeto: false });
  igual(quantas(a.falso, LEITURA_MATRICULA), 0, 'a lista oficial não foi tocada');
});

teste('sem o parâmetro m, recusa por FORMATO sem consultar a lista', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');

  const r = corpoDe(get(a, { api: 'matricula', p: 'p1' }));
  igual(r, { ok: true, valida: false, existe: false, motivo: 'FORMATO', bloqueia: true });

  // ERA "nem uma requisição". Desde 19/09 a régua do formato é
  // `erroFormatoMatricula_`, que lê `matricula_digitos` da configuração — UMA
  // leitura, a mesma que qualquer rota paga, e que o cache da execução
  // reaproveita. O que continua proibido é ir à LISTA por uma matrícula que
  // nem tem cara de matrícula: essa é a leitura que este teste guarda.
  igual(quantas(a.falso, LEITURA_MATRICULA), 0, 'foi à lista por uma matrícula malformada');
  verdadeiro(a.falso.requisicoes.length <= 1, 'mais que a leitura da configuração');
});

teste('matrícula curta ou longa demais recusa por FORMATO', () => {
  const a = montar();
  igual(corpoDe(get(a, { api: 'matricula', m: '12' })).motivo, 'FORMATO');
  igual(corpoDe(get(a, { api: 'matricula', m: '123456789012345678901' })).motivo, 'FORMATO');
  igual(quantas(a.falso, LEITURA_MATRICULA), 0, 'foi à lista por uma matrícula malformada');
});

teste('a rota usa a MESMA régua do envio — e não uma conta própria', () => {
  // Até 19/09 esta rota media 4..20 por conta própria enquanto o envio media
  // `matricula_digitos`. É a régua daqui que o site consulta no `blur`: duas
  // réguas faziam o site dizer "válida" e o envio responder "inválida".
  const a = montar();
  criarProjeto(a.api, 'p1', { validar_matricula: 'SIM' });
  matricular(a.api, ['9110001']);

  // 6 dígitos: cabia em 4..20, e hoje reprova no formato.
  igual(corpoDe(get(a, { api: 'matricula', m: '911000', p: 'p1' })).motivo, 'FORMATO');
  // 7 passa; 8 com zero à esquerda (como a secretaria escreve) passa e acha.
  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).existe, true);
  igual(corpoDe(get(a, { api: 'matricula', m: '09110001', p: 'p1' })).existe, true);
  // 8 SEM zero: tamanho errado.
  igual(corpoDe(get(a, { api: 'matricula', m: '91100011', p: 'p1' })).motivo, 'FORMATO');

  // E a régua acompanha a configuração — a mesma que o envio lê.
  a.api.gravarConfig_('matricula_digitos', '6');
  igual(corpoDe(get(a, { api: 'matricula', m: '911000', p: 'p1' })).motivo !== 'FORMATO', true,
    'com 6 configurado, 6 dígitos tem formato');
});

teste('pontuação na matrícula é normalizada antes de tudo', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);

  igual(corpoDe(get(a, { api: 'matricula', m: ' 91.100-01 ', p: 'p1' })).existe, true);
});

teste('sem projeto na consulta, assume que valida — e não lê projeto nenhum', () => {
  const a = montar();
  matricular(a.api, ['9110001']);

  const r = corpoDe(get(a, { api: 'matricula', m: '9110001' }));
  igual(r.existe, true);
  igual(quantas(a.falso, LEITURA_PROJETO), 0);
});

teste('caminho comum custa três leituras: configuração, projeto e a matrícula', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);

  get(a, { api: 'matricula', m: '9110001', p: 'p1' });

  igual(quantas(a.falso, LEITURA_CONFIG), 1);
  igual(quantas(a.falso, LEITURA_PROJETO), 1);
  igual(quantas(a.falso, LEITURA_MATRICULA), 1);
  igual(quantas(a.falso, AGREGACAO), 0, 'matrícula encontrada dispensa perguntar se há lista');
  igual(a.falso.requisicoes.length, 3);
});

teste('a agregação só aparece quando a matrícula NÃO é encontrada', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);

  get(a, { api: 'matricula', m: '9999999', p: 'p1' });
  igual(quantas(a.falso, AGREGACAO), 1);
  igual(a.falso.requisicoes.length, 4);
});

teste('a conferência NÃO é cacheada', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);

  get(a, { api: 'matricula', m: '9110001', p: 'p1' });
  const primeira = a.falso.requisicoes.length;
  get(a, { api: 'matricula', m: '9110001', p: 'p1' });
  // A primeira paga também a configuração, que daí em diante vem do cache do
  // script (03_Config.gs). A matrícula e o projeto, não: a segunda consulta vai
  // ao banco de novo pelos dois.
  igual([primeira, a.falso.requisicoes.length], [3, 2], 'a segunda consulta tem de ir ao banco pela matrícula');
});

// ------------------------------------------------------ teto de consultas

grupo('doGet ?api=matricula — o teto por hora');

teste('passado o teto, responde indisponivel e o site libera', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);
  a.api.gravarConfig_('limite_consultas_matricula_hora', '2');

  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).existe, true);
  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).existe, true);

  const terceira = corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' }));
  igual(terceira, { ok: true, valida: true, indisponivel: true });
});

teste('o teto registra UMA vez por janela, e não uma por requisição recusada', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  a.api.gravarConfig_('limite_consultas_matricula_hora', '0');

  for (let i = 0; i < 5; i++) get(a, { api: 'matricula', m: '9110001', p: 'p1' });

  // O original gravava uma linha de log por requisição recusada: um robô
  // insistindo viraria dezenas de milhares de ESCRITAS, contra 20 mil por dia no
  // Spark. O freio derrubaria o sistema antes do abuso que ele contém.
  igual(acoesDoLog(a.falso).filter((x) => x === 'LIMITE_CONSULTA').length, 1);
});

teste('a janela seguinte volta a contar do zero', () => {
  const relogio = criarRelogio(new Date('2026-08-05T13:10:00Z').getTime());
  const a = montar({ relogio: relogio });
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);
  a.api.gravarConfig_('limite_consultas_matricula_hora', '1');

  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).existe, true);
  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).indisponivel, true);

  relogio.avancar(60 * 60 * 1000);
  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).existe, true);
});

// ------------------------------------------------------------ rotas e páginas

grupo('doGet — rota desconhecida e o endereço sem rota');

teste('?api=lixo responde JSON de erro', () => {
  const a = montar();
  const saida = get(a, { api: 'lixo' });

  igual(saida.getMimeType(), 'application/json');
  igual(corpoDe(saida).ok, false);
  verdadeiro(corpoDe(saida).erro.indexOf('lixo') !== -1);
});

teste('rota desconhecida não devolve o parâmetro inteiro de volta', () => {
  const a = montar();
  const erro = corpoDe(get(a, { api: 'x'.repeat(500) })).erro;
  verdadeiro(erro.length < 100, 'o eco do parâmetro é cortado: ' + erro.length);
});

teste('sem parâmetro nenhum, responde JSON: o endereço é a API, e a resposta aponta o site e o painel', () => {
  // Era aqui que o Cadastro.html era servido. O servidor não serve mais página
  // (ver "Nenhuma resposta é página", em 08_Api.gs), e quem abre o endereço sem
  // rota recebe uma frase e os dois endereços do Pages. Este sandbox nem tem
  // HtmlService: um `doGet` que voltasse a montar página estouraria aqui.
  const a = montar();
  const saida = get(a, {});

  igual(saida.getMimeType(), 'application/json');
  const corpo = corpoDe(saida);
  igual(corpo.site, 'https://cesutech.github.io/');
  igual(corpo.painel, 'https://cesutech.github.io/painel/');
  verdadeiro(/é a API/.test(corpo.mensagem), corpo.mensagem);
});

teste('?p=admin, o endereço antigo do painel, cai na mesma resposta — e qualquer outro p= também', () => {
  const a = montar();
  const semRota = get(a, {}).getContent();

  ['admin', 'cadastro', 'inventada'].forEach((p) => {
    igual(get(a, { p: p }).getContent(), semRota, '?p=' + p);
  });
});

teste('o endereço sem rota custa ZERO leitura do Firestore', () => {
  // Rota anônima: uma resposta que lesse a configuração seria cota gasta por
  // quem não pediu nada — a mesma razão do ping.
  const a = montar();

  get(a, {});
  igual(a.falso.requisicoes.length, 0, 'sem parâmetro');
  get(a, { p: 'admin' });
  igual(a.falso.requisicoes.length, 0, '?p=admin');
});

teste('doGet sem evento nenhum não estoura, e responde o mesmo JSON', () => {
  const a = montar();
  const saida = requisicao(a, () => a.api.doGet());
  igual(saida.getContent(), get(a, {}).getContent());
});

// ------------------------------------------------------------ doPost

grupo('doPost — o contrato do text/plain');

teste('corpo JSON em text/plain vira inscrição gravada', () => {
  const a = montar();
  criarProjeto(a.api, 'p1', { nome: 'R+ Cidades' });

  const r = corpoDe(post(a, Object.assign({ acao: 'inscricao', projeto_id: 'p1' }, INSCRICAO_VALIDA)));

  igual(r.ok, true);
  igual(r.duplicada, false);
  verdadeiro(r.protocolo, 'o protocolo volta para o aluno');

  const gravadas = [];
  a.falso.documentos.forEach((campos, chave) => {
    if (chave.indexOf('inscricoes/') === 0) gravadas.push(campos);
  });
  igual(gravadas.length, 1);
  igual(gravadas[0].nome.stringValue, 'Maria da Silva');
  igual(gravadas[0].projeto_nome.stringValue, 'R+ Cidades');
});

teste('o corpo é lido de postData.contents, e não de e.parameter', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');

  // Com text/plain o Apps Script NÃO preenche e.parameter: se este arquivo
  // lesse dali, a inscrição chegaria vazia e o aluno levaria erro de validação.
  const r = corpoDe(requisicao(a, () => a.api.doPost({
    parameter: {},
    postData: { type: 'text/plain', contents: JSON.stringify(Object.assign({ projeto_id: 'p1' }, INSCRICAO_VALIDA)) }
  })));
  igual(r.ok, true);
});

teste('a origem é carimbada pelo servidor e sobrescreve a que veio no corpo', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');

  corpoDe(post(a, Object.assign({ projeto_id: 'p1', origem: 'INTERNO' }, INSCRICAO_VALIDA)));

  let origem = '';
  a.falso.documentos.forEach((campos, chave) => {
    if (chave.indexOf('inscricoes/') === 0) origem = campos.origem.stringValue;
  });
  igual(origem, 'SITE_EXTERNO');
});

teste('sem o sinal de origem do formulário, o envio externo é recusado', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');

  const dados = Object.assign({ projeto_id: 'p1' }, INSCRICAO_VALIDA);
  delete dados.tempoPreenchimento;

  // É a guarda que o carimbo de origem liga: quem chega por este endereço tem de
  // provar que passou pelo formulário.
  const r = corpoDe(post(a, dados));
  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('formulário do site') !== -1, r.erro);
});

teste('reenvio do mesmo aluno responde duplicada, sem gravar de novo', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');

  const dados = Object.assign({ projeto_id: 'p1' }, INSCRICAO_VALIDA);
  igual(corpoDe(post(a, dados)).duplicada, false);

  const segunda = corpoDe(post(a, dados));
  igual(segunda.ok, true);
  igual(segunda.duplicada, true);
});

teste('requisição sem corpo responde "Requisição vazia."', () => {
  const a = montar();
  igual(corpoDe(requisicao(a, () => a.api.doPost({}))), { ok: false, erro: 'Requisição vazia.' });
  igual(corpoDe(requisicao(a, () => a.api.doPost())), { ok: false, erro: 'Requisição vazia.' });
  igual(corpoDe(requisicao(a, () => a.api.doPost({ postData: { contents: '' } }))),
    { ok: false, erro: 'Requisição vazia.' });
});

teste('corpo que não é JSON responde erro de corpo, e não erro interno', () => {
  const a = montar();
  igual(corpoDe(post(a, 'isto não é json')), { ok: false, erro: 'Corpo da requisição inválido.' });
});

teste('JSON que não é objeto também é corpo inválido', () => {
  const a = montar();
  // `JSON.parse('"oi"')` e `JSON.parse('7')` não estouram: sem esta guarda o
  // valor desceria até `submeterInscricao_` como algo sem campo nenhum.
  igual(corpoDe(post(a, '"oi"')).erro, 'Corpo da requisição inválido.');
  igual(corpoDe(post(a, '7')).erro, 'Corpo da requisição inválido.');
  igual(corpoDe(post(a, 'null')).erro, 'Corpo da requisição inválido.');
});

teste('ação desconhecida é recusada por nome', () => {
  const a = montar();
  igual(corpoDe(post(a, { acao: 'apagarTudo' })), { ok: false, erro: 'Ação desconhecida.' });
});

teste('ação ausente é tratada como inscrição', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  igual(corpoDe(post(a, Object.assign({ projeto_id: 'p1' }, INSCRICAO_VALIDA))).ok, true);
});

teste('a resposta do doPost é JSON', () => {
  const a = montar();
  igual(post(a, { acao: 'apagarTudo' }).getMimeType(), 'application/json');
});

teste('inscrição sem projeto entra pelo mesmo endereço', () => {
  const a = montar();
  const dados = Object.assign({}, INSCRICAO_VALIDA);
  delete dados.curso_fase;
  delete dados.declara_ciencia;

  igual(corpoDe(post(a, dados)).ok, true);
});

// ------------------------------------------------------ rotas do painel

/**
 * O painel no GitHub Pages não tem `google.script.run`. Estes testes exercitam a
 * ponte que o substitui: `acao: 'painel'` no mesmo POST de `text/plain` da
 * inscrição.
 *
 * O que se prova, na ordem em que a rota decide:
 *   1. sem token válido não passa nada, e a recusa é uma frase só;
 *   2. o nome da função vem do cliente, e só os da lista branca literal valem —
 *      inclusive os nomes que o JavaScript entrega de graça (`constructor`);
 *   3. o token que vale é o do envelope, e não o que veio dentro do payload;
 *   4. as rotas públicas seguem intactas — é o teste de orçamento, no fim do
 *      arquivo, que continua medindo os mesmos números.
 */
grupo('doPost acao=painel — a ponte que substitui o google.script.run');

/** Uma sessão de verdade, criada como `autenticar_` a cria. */
function sessao(a, email) {
  return a.api.criarSessao_(email || 'coordenacao@exemplo.com');
}

function painel(a, fn, token, dados) {
  return corpoDe(post(a, { acao: 'painel', fn: fn, token: token, dados: dados }));
}

teste('sem token, a rota recusa ANTES de tocar no banco', () => {
  const a = montar();
  const r = painel(a, 'painelEstatisticas', '', {});

  igual(r.ok, false);
  igual(r.erro, 'Sessão expirada ou inválida. Faça login novamente.');
  // Zero requisições: a guarda não pode custar leitura. Um endereço anônimo que
  // gasta cota para dizer "não" é um botão de desligar com etiqueta.
  igual(a.falso.requisicoes.length, 0);
});

teste('token forjado e token ausente recebem a MESMA frase', () => {
  const a = montar();
  const semToken = painel(a, 'listarAlunos', undefined, {});
  const forjado = painel(a, 'listarAlunos', 'nao-existe-este-token', {});

  igual(forjado.erro, semToken.erro,
    'recusa que varia conta ao visitante o que ele ainda não sabia');
});

teste('o e-mail fora da allowlist não muda a recusa da rota', () => {
  // A sessão criada aqui NÃO está em admin_emails. A rota não olha a allowlist —
  // ela olha o token — e é isso que impede a resposta de virar oráculo de "este
  // e-mail é admin?". Quem quiser saber precisa do token, e o token é o segredo.
  const a = montar();
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');

  const deFora = painel(a, 'painelEstatisticas', sessao(a, 'estranho@exemplo.com'), {});
  igual(deFora.ok, true, 'a sessão vale enquanto o token vale — a allowlist é do login');
});

teste('função fora da lista branca é recusada, mesmo existindo no servidor', () => {
  const a = montar();
  const token = sessao(a);

  // As quatro existem, são chamáveis, e nenhuma delas tem `exigirAdmin_`.
  // `gravarConfig_` reescreveria a configuração inteira; `invalidarSessoes`
  // derrubaria todo mundo; `criarSessao_` FABRICARIA uma sessão para qualquer
  // e-mail. Um despacho por `this[nome]` entregaria as três. Cada uma vai pelo
  // fio com o nome da função e com o nome sem o `_` do fim.
  ['setup', 'gravarConfig_', 'invalidarSessoes', 'criarSessao_', 'reservarVaga_']
    .forEach((funcao) => {
      igual(typeof a.api[funcao], 'function', funcao + ' devia existir para o teste valer');
      [funcao, funcao.replace(/_$/, '')].forEach((nome) => {
        const r = painel(a, nome, token, {});
        igual(r.ok, false, nome + ' foi despachada e não devia');
        verdadeiro(r.erro.indexOf('Ação desconhecida') === 0, nome + ': ' + r.erro);
      });
    });
});

teste('nome herdado de Object não é lista branca', () => {
  // `funcoes['constructor']` devolve uma FUNÇÃO de verdade — sem
  // `hasOwnProperty`, ela passaria no teste de tipo e seria chamada. O mesmo
  // vale para `toString`, `valueOf` e `__proto__`.
  const a = montar();
  const token = sessao(a);

  ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'].forEach((nome) => {
    const r = painel(a, nome, token, {});
    igual(r.ok, false, nome + ' passou pela lista branca');
    verdadeiro(r.erro.indexOf('Ação desconhecida') === 0, nome + ': ' + r.erro);
  });
});

teste('nome desconhecido não devolve a resposta de sessão inválida', () => {
  // Recusa de sessão e recusa de nome são coisas diferentes, e confundir as duas
  // faria o painel se deslogar sozinho por causa de um erro de digitação no
  // cliente — o envelope do Admin.html reconhece a frase da sessão por regex.
  const a = montar();
  const r = painel(a, 'naoExisteEssaFuncao', sessao(a), {});
  igual(r.ok, false);
  verdadeiro(!/Sess.o expirada/.test(r.erro), r.erro);
});

teste('o token do envelope sobrescreve o que veio dentro do payload', () => {
  // Sem o carimbo, o cliente mandaria um token bom no envelope (que a rota
  // confere) e um token qualquer em `dados` (que o `exigirAdmin_` lá dentro
  // confere), e a conferência que valeria seria a que o cliente escolheu.
  const a = montar();
  const r = painel(a, 'painelEstatisticas', sessao(a), { token: 'lixo' });
  igual(r.ok, true, 'erro foi: ' + r.erro);
});

teste('payload ausente, texto ou lista não derruba a rota', () => {
  const a = montar();
  const token = sessao(a);

  igual(painel(a, 'painelEstatisticas', token).ok, true);
  igual(painel(a, 'painelEstatisticas', token, 'texto').ok, true);
  igual(painel(a, 'painelEstatisticas', token, [1, 2, 3]).ok, true);
  igual(painel(a, 'painelEstatisticas', token, null).ok, true);
});

teste('a rota despacha de verdade, e a resposta é a da função', () => {
  const a = montar();
  criarProjeto(a.api, 'p1', { vagas: '60' });
  const token = sessao(a);

  const estatisticas = painel(a, 'painelEstatisticas', token, {});
  igual(estatisticas.ok, true, 'erro foi: ' + estatisticas.erro);

  // Uma que ESCREVE, para provar que o caminho não é só de leitura.
  const salvo = painel(a, 'salvarConfiguracao', token, { chave: 'vagas_padrao', valor: '25' });
  igual(salvo.ok, true, 'erro foi: ' + salvo.erro);
  a.api.limparCacheConfig_();
  igual(a.api.config_('vagas_padrao'), '25');
});

teste('a resposta da rota do painel é JSON, como a da inscrição', () => {
  const a = montar();
  igual(post(a, { acao: 'painel', fn: 'painelEstatisticas' }).getMimeType(), 'application/json');
});

teste('o painel NÃO entra pelo doGet', () => {
  // Metade das ações escreve. Uma ação de escrita atrás de GET é um endereço que
  // qualquer <img src> dispara, e o navegador o dispara sem preflight nenhum.
  const a = montar();
  igual(corpoDe(get(a, { api: 'painel' })).ok, false);
  verdadeiro(/Rota desconhecida/.test(corpoDe(get(a, { api: 'painel' })).erro));
  igual(corpoDe(get(a, { api: 'login' })).ok, false);
});

// ------------------------------------------- a chave de idempotência

/**
 * A ESCRITA QUE DEU CERTO E VOLTOU COMO FALHA — 12/08/2026, produção.
 *
 * A coordenação salvou um projeto. O `/exec` levou 32,71 segundos e o segundo
 * salto respondeu 404 (`echo?user_content_key=... 404 3.5kB 32.71s`). A gravação
 * tinha acontecido AQUI: o que se perdeu foi a resposta. O painel não tinha como
 * distinguir isso de "não chegou", ela clicou de novo, e hoje existem dois
 * projetos "CONECTANDO GERAÇÕES" no banco.
 *
 * `rotaDoPainel_` passou a aceitar `idem`: uma chave por tentativa de operação,
 * gerada pelo painel. Vista de novo dentro de dez minutos, a resposta guardada
 * volta e a função NÃO roda outra vez.
 *
 * Os testes daqui são sobre o SERVIDOR: o painel clicado está em
 * `testes/painel-navegador.js`, no grupo "a chave que impede a escrita repetida".
 * As duas regras que sustentam o desenho estão nos dois primeiros testes —
 * guardar só o sucesso, e a chave valer só para a mesma ação.
 */
grupo('a chave de idempotência — a mesma escrita não acontece duas vezes');

/**
 * Conta quantas vezes a função do servidor RODOU.
 *
 * Trocar a global funciona porque `funcoesDoPainel_` monta o mapa no instante da
 * requisição, lendo as globais — é o mesmo caminho pelo qual `dom-painel.js`
 * observa as chamadas. É a única forma de separar "a requisição chegou" de "a
 * escrita aconteceu", que é a diferença que este grupo inteiro mede.
 */
function contarExecucoes(a, nome) {
  const conta = { vezes: 0 };
  const original = a.api[nome];
  a.api[nome] = function () {
    conta.vezes++;
    return original.apply(null, arguments);
  };
  return conta;
}

/** A requisição do painel, com a chave de idempotência no envelope. */
function painelComChave(a, fn, token, dados, idem) {
  return corpoDe(post(a, { acao: 'painel', fn: fn, token: token, dados: dados, idem: idem }));
}

/** Quantos projetos existem no banco falso — os documentos são um Map. */
function quantosProjetos(a) {
  let total = 0;
  a.falso.documentos.forEach((_campos, chave) => {
    if (chave.indexOf('projetos/') === 0) total++;
  });
  return total;
}

const PROJETO_NOVO = { projeto: { nome: 'CONECTANDO GERAÇÕES', vagas: 60, ativo: true } };

teste('a mesma chave não grava duas vezes, e devolve a MESMA resposta', () => {
  const a = montar();
  const token = sessao(a);
  const execucoes = contarExecucoes(a, 'salvarProjeto_');

  const primeira = painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'kabc12345678');
  const segunda = painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'kabc12345678');

  igual(execucoes.vezes, 1, 'A ESCRITA RODOU DUAS VEZES — é o dado duplicado de 12/08');
  igual(segunda.ok, true, 'a repetição foi recusada em vez de responder o que já tinha acontecido');
  igual(segunda.id, primeira.id, 'a segunda resposta fala de outro projeto: ' + segunda.id);
  igual(quantosProjetos(a), 1, 'nasceu o segundo projeto no banco');
});

teste('guarda SÓ o que deu certo: a recusa pode ser tentada de novo', () => {
  // Uma falha guardada vira falha permanente pelos dez minutos em que a pessoa
  // mais precisa poder tentar de novo — e o erro transitório desta rota é
  // conhecido: "muita gente se inscrevendo ao mesmo tempo", o lock ocupado.
  const a = montar();
  const token = sessao(a);
  const execucoes = contarExecucoes(a, 'salvarProjeto_');
  const semNome = { projeto: { vagas: 60 } };

  const primeira = painelComChave(a, 'salvarProjeto', token, semNome, 'kfalha12345678');
  const segunda = painelComChave(a, 'salvarProjeto', token, semNome, 'kfalha12345678');

  igual(primeira.ok, false, 'o servidor aceitou projeto sem nome');
  igual(execucoes.vezes, 2, 'A RECUSA FICOU GUARDADA: a segunda tentativa nem rodou');
  igual(segunda.ok, false);
  igual(eventosDasRotas(a).filter((e) => e.tipo === 'put').length, 0,
    'a recusa foi parar no cache');
});

teste('a chave vale para UMA ação só — a de outra não devolve esta resposta', () => {
  // Uma chave reaproveitada por engano em outra ação devolveria "removido com
  // sucesso" para uma remoção que nunca aconteceu. O nome da função entra na
  // chave do cache justamente para que o reaproveitamento não ache nada.
  const a = montar();
  criarProjeto(a.api, 'p1', {});
  const token = sessao(a);
  const execucoes = contarExecucoes(a, 'removerProjeto_');

  painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'kmesma12345678');
  const removida = painelComChave(a, 'removerProjeto', token, { id: 'p1' }, 'kmesma12345678');

  igual(execucoes.vezes, 1, 'a remoção recebeu a resposta guardada de OUTRA ação');
  verdadeiro(removida.mensagem !== undefined || removida.ok === true,
    'a remoção não chegou a acontecer: ' + JSON.stringify(removida));
});

teste('chave nova é operação nova — e ela grava', () => {
  const a = montar();
  const token = sessao(a);
  const execucoes = contarExecucoes(a, 'salvarProjeto_');

  painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'kprimeira12345');
  painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'ksegunda123456');

  igual(execucoes.vezes, 2, 'a segunda operação foi engolida pela primeira');
  igual(quantosProjetos(a), 2, 'a segunda gravação não chegou ao banco');
});

teste('chave malformada é IGNORADA, e a ação roda como rodava antes', () => {
  // Ignorar, e não recusar: este servidor atende um painel publicado à parte, no
  // GitHub Pages. Uma implantação nova respondendo a um painel antigo (ou o
  // contrário) tem de continuar funcionando — o que se perde é a proteção, e não
  // a tela. O formato é conferido no BRUTO: sanitizar faria duas chaves
  // diferentes virarem a mesma depois da limpeza.
  const a = montar();
  const token = sessao(a);

  ['', 'curta', 'x'.repeat(65), 'com espaço', 'ponto.virgula', '../../etc/passwd',
   'aspas"aqui', null, 42, { chave: 'objeto' }].forEach((idem) => {
    const antes = eventosDasRotas(a).length;
    const r = painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, idem);
    igual(r.ok, true, 'a chave ' + JSON.stringify(idem) + ' derrubou a ação: ' + r.erro);
    igual(eventosDasRotas(a).length, antes,
      'a chave ' + JSON.stringify(idem) + ' chegou ao cache mesmo malformada');
  });
});

teste('a janela é de dez minutos, e depois dela a chave não vale mais', () => {
  // Não é um histórico de operações: é a janela em que "de novo" ainda quer dizer
  // "a mesma vez". Dez minutos cobrem com folga o caso real, que é a pessoa
  // reclicando em segundos.
  const a = montar();
  const token = sessao(a);
  const execucoes = contarExecucoes(a, 'salvarProjeto_');

  painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'kjanela1234567');
  const put = eventosDasRotas(a).filter((e) => e.tipo === 'put')[0];
  igual(put.segundos, 600, 'a validade da chave mudou de tamanho');

  a.cache.expirar();
  painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'kjanela1234567');
  igual(execucoes.vezes, 2, 'a chave continuou valendo depois de a janela fechar');
});

teste('resposta grande demais não é guardada — a repetição volta a executar', () => {
  // `exportarCsv_` devolve o CSV INTEIRO no corpo, e o item do CacheService tem
  // teto de 100 KB. Guardar menos é a degradação certa: exportar duas vezes gera
  // dois arquivos iguais e duas linhas na trilha, e nada que se pareça com dado
  // duplicado.
  const a = montar();
  a.api.guardarResposta_('idem_exportarCsv_kgrande123456',
    { ok: true, csv: 'a'.repeat(60000), linhas: 900 });

  igual(eventosDasRotas(a).filter((e) => e.tipo === 'put').length, 0,
    'a resposta gigante foi mandada ao cache assim mesmo');
  igual(a.api.respostaGuardada_('idem_exportarCsv_kgrande123456'), null);
});

teste('cache é otimização, nunca dependência: sem ele a rota executa igual', () => {
  const a = montar({ semCache: true });
  const token = sessao(a);
  const execucoes = contarExecucoes(a, 'salvarProjeto_');

  const primeira = painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'ksemcache12345');
  const segunda = painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'ksemcache12345');

  igual(primeira.ok, true, 'erro foi: ' + primeira.erro);
  igual(segunda.ok, true, 'erro foi: ' + segunda.erro);
  igual(execucoes.vezes, 2, 'sem cache não há como reconhecer a repetição — e a rota tem de rodar');
});

teste('o cache respondendo e falhando também não derruba a rota', () => {
  const a = montar({ cache: { quebrarGet: true, quebrarPut: true } });
  const token = sessao(a);

  const r = painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'kquebrado12345');
  igual(r.ok, true, 'o cache quebrado derrubou a gravação: ' + r.erro);
  verdadeiro(a.registros.erros.some((m) => /idempotencia/.test(m)),
    'a falha do cache passou sem registro nenhum: ' + JSON.stringify(a.registros.erros));
});

teste('a chave não é porta: sem token, ela nem chega ao cache', () => {
  // O único jeito de pôr coisa neste cache é EXECUTAR uma escrita de verdade,
  // autenticado — e mesmo aí só o que deu certo é guardado, por dez minutos. A
  // guarda é a primeira linha de `rotaDoPainel_`, e é a mesma de sempre.
  const a = montar();

  const r = painelComChave(a, 'salvarProjeto', 'token-forjado', PROJETO_NOVO, 'kinvasor123456');

  igual(r.ok, false);
  igual(r.erro, 'Sessão expirada ou inválida. Faça login novamente.');
  igual(eventosDasRotas(a).length, 0, 'uma requisição sem token mexeu no cache');
  igual(a.falso.requisicoes.length, 0, 'e ainda gastou leitura do banco');
});

teste('nome fora da lista branca não guarda nada, mesmo com chave boa', () => {
  const a = montar();
  const r = painelComChave(a, 'criarSessao_', sessao(a), {}, 'klistabranca12');

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('Ação desconhecida') === 0, r.erro);
  igual(eventosDasRotas(a).length, 0, 'a rota tocou o cache antes de conferir a lista branca');
});

// ------------------------------------------------------ rotas de login

grupo('doPost acao=login — as sete que rodam antes de existir token');

function login(a, fn, extra) {
  return corpoDe(post(a, Object.assign({ acao: 'login', fn: fn }, extra || {})));
}

/** O token que viajou dentro do corpo da última mensagem enviada. */
function tokenDoEmail(a) {
  const mensagem = a.correio.enviados[a.correio.enviados.length - 1];
  verdadeiro(mensagem !== undefined, 'nenhuma mensagem foi enviada');
  const achado = /\?entrar=([0-9a-f]{64})/.exec(mensagem.body);
  verdadeiro(achado !== null, 'o corpo do e-mail não trouxe link nenhum:\n' + mensagem.body);
  return achado[1];
}

teste('modoDeAcesso responde pela rota, e diz como desenhar a tela', () => {
  const a = montar();
  const r = login(a, 'modoDeAcesso');

  igual(r.ok, true);
  // Os quatro bits com que a tela de login decide o que desenhar. Nenhum deles é
  // sobre um endereço — ver `invasao.js` para a prova de que a allowlist não sai
  // por aqui.
  igual(r.identidadeVisivel, false, 'o web app anônimo não sabe quem está do outro lado');
  igual(r.allowlistVazia, true, 'banco recém-semeado não tem ninguém na lista');
  igual(r.google.disponivel, false, 'sem client id e sem allowlist não se anuncia o botão');
  igual(r.linkDisponivel, false, 'sem ninguém na lista não há para quem mandar link');
});

// REMOVIDO em 11/08: 'autenticar por PIN funciona pela rota e devolve token
// utilizável' e 'PIN errado pela rota devolve a mesma recusa, sem token'. O PIN
// saiu do sistema, e não há o que reescrever: `autenticar_` não recebe mais
// argumento e não há segredo a errar. O que aqueles dois provavam e continua
// valendo está nos dois testes abaixo — o token de UMA rota abrindo a OUTRA, e a
// recusa de login sem token junto.

teste('o token que sai do login abre o painel — as duas rotas falam a mesma língua', () => {
  // O circuito de verdade, e só aqui: pedir o link, ler o token do e-mail e
  // entrar com ele. É o único login que roda inteiro dentro do servidor (o do
  // Google depende do navegador), e o que interessa a 08_Api.gs é que o token que
  // sai de `acao: 'login'` seja aceito por `acao: 'painel'`.
  const a = montar();
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');

  igual(login(a, 'pedirLinkDeAcesso', { email: 'coordenacao@exemplo.com' }).ok, true);

  const r = login(a, 'entrarComLink', { token: tokenDoEmail(a) });
  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.via, 'link');
  igual(r.usuario, 'coordenacao@exemplo.com');

  igual(painel(a, 'painelEstatisticas', r.token, {}).ok, true);
});

teste('login recusado pela rota não devolve token nenhum', () => {
  // As três portas recusam por motivos diferentes e nenhuma pode vazar um token
  // junto com o "não": um cliente que lesse `r.token` sem olhar `r.ok` entraria.
  const a = montar();
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');

  // `autenticar_` nesta implantação (`USER_DEPLOYING`, conta comum) nunca vê a
  // identidade, e é o estado real de produção hoje.
  const semIdentidade = login(a, 'autenticar');
  igual(semIdentidade.ok, false);
  igual(semIdentidade.token, undefined);

  const linkInventado = login(a, 'entrarComLink', { token: 'f'.repeat(64) });
  igual(linkInventado.ok, false);
  igual(linkInventado.token, undefined);

  igual(painel(a, 'painelEstatisticas', semIdentidade.token, {}).ok, false);
});

teste('sessaoAtiva e sair funcionam pela rota', () => {
  const a = montar();
  const token = sessao(a);

  igual(login(a, 'sessaoAtiva', { token: token }).ok, true);
  igual(login(a, 'sair', { token: token }), { ok: true });
  igual(login(a, 'sessaoAtiva', { token: token }), { ok: false },
    'a recusa continua sendo só `ok:false` — quem não tem sessão não aprende que há níveis');
});

teste('fn desconhecida no login é recusada por nome', () => {
  const a = montar();
  igual(login(a, 'criarSessao_'), { ok: false, erro: 'Ação desconhecida.' });
  igual(login(a, 'listarAlunos'), { ok: false, erro: 'Ação desconhecida.' });
  igual(login(a, ''), { ok: false, erro: 'Ação desconhecida.' });
});

// ------------------------------------------- o cache da allowlist do link

/**
 * `allowlistParaLink_` guarda a lista no CacheService por LINK_CACHE_SEGUNDOS, e
 * é o que torna `pedirLinkDeAcesso_` uma rota anônima sem preço.
 *
 * O que se prova aqui, e por que cada coisa importa:
 *   1. o cache PEGA: um segundo pedido não volta ao banco. Sem isso, esta rota —
 *      anônima e pública — seria um botão para drenar a cota de leitura que o
 *      FORMULÁRIO DO ALUNO usa;
 *   2. mexer na lista derruba o cache NA HORA, pelos quatro caminhos que mexem
 *      nela. É o teste mais importante do grupo: sem ele, alguém removido do
 *      acesso continuaria recebendo link por até cinco minutos, e "tirei o
 *      acesso" tem de valer no instante do clique;
 *   3. sem CacheService, a porta FECHA — mesma frase de sempre, e-mail nenhum.
 *      É decisão registrada no código, e não acidente; um teste é o que separa
 *      uma da outra no dia em que alguém "consertar" o ramo.
 *
 * Cada `pedirLinkDeAcesso_` entra pela rota, e `post` limpa o CONFIG_CACHE antes —
 * então cada pedido aqui é uma execução nova do Apps Script, como em produção. É
 * o que faz a medição de leitura valer alguma coisa: dentro de UMA execução, o
 * cache de 03_Config.gs já engoliria a segunda leitura sozinho, e o teste passaria
 * verde com o cache do link arrancado.
 */
grupo('o cache da allowlist — o que faz a rota do link não ter preço');

function pedirLink(a, email) {
  return login(a, 'pedirLinkDeAcesso', { email: email });
}

/** Para quem cada mensagem foi, na ordem de envio. */
function destinatarios(a) {
  return a.correio.enviados.map((m) => m.to);
}

teste('dois pedidos de link custam UMA leitura do banco, e não uma por pedido', () => {
  const a = montar();
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');

  igual(pedirLink(a, 'coordenacao@exemplo.com').ok, true);
  igual(leiturasCobradas(a), 1, 'o primeiro pedido é o que paga: ele monta o cache');

  // A configuração também fica no cache do script (03_Config.gs), e ela sozinha
  // pouparia esta leitura. Esvaziá-la deixa só o cache da lista do link para
  // provar o que este teste prova.
  a.api.limparCacheConfig_();
  igual(pedirLink(a, 'coordenacao@exemplo.com').ok, true);
  igual(leiturasCobradas(a), 0,
    'o segundo pedido voltou ao Firestore — o cache da allowlist não está pegando');
});

teste('uma enxurrada de endereços inventados não custa uma leitura por pedido', () => {
  // O cenário que motivou o cache: um laço de `curl` com endereços que não estão
  // na lista. Cada um morre na conferência, e a conferência tem de ser de graça.
  const a = montar();
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');

  let leituras = 0;
  for (let i = 0; i < 20; i++) {
    // Sem o cache da configuração, como no teste acima: quem poupa a leitura
    // tem de ser o cache da lista do link.
    a.api.limparCacheConfig_();
    igual(pedirLink(a, 'inventado' + i + '@exemplo.com').ok, true);
    leituras += leiturasCobradas(a);
  }

  igual(leituras, 1, 'a enxurrada foi ao banco ' + leituras + ' vezes');
  igual(destinatarios(a), [], 'e nenhum endereço de fora recebeu mensagem');
});

teste('incluirAdmin derruba o cache: quem entrou na lista recebe link no ato', () => {
  const a = montar();
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');

  // Esquenta o cache com a lista de UMA pessoa.
  igual(pedirLink(a, 'coordenacao@exemplo.com').ok, true);
  igual(destinatarios(a), ['coordenacao@exemplo.com']);

  igual(painel(a, 'incluirAdmin', sessao(a), { email: 'nova@exemplo.com' }).ok, true);

  igual(pedirLink(a, 'nova@exemplo.com').ok, true);
  igual(destinatarios(a), ['coordenacao@exemplo.com', 'nova@exemplo.com'],
    'a lista guardada é a antiga: quem acabou de entrar teve de esperar o cache vencer');
});

teste('removerAdmin derruba o cache: quem SAIU para de receber link no ato', () => {
  // O teste que justifica a invalidação existir. Sem ela, o endereço removido
  // continuaria recebendo link por até cinco minutos — e é o pedido de link, e
  // não o clique, que põe um token válido na caixa de quem acabou de sair.
  const a = montar();
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com, saindo@exemplo.com');

  // Esquenta o cache com a lista de DUAS pessoas, pedindo para a que fica.
  igual(pedirLink(a, 'coordenacao@exemplo.com').ok, true);

  igual(painel(a, 'removerAdmin', sessao(a), { email: 'saindo@exemplo.com' }).ok, true);

  igual(pedirLink(a, 'saindo@exemplo.com').ok, true, 'a frase única não muda nem aqui');
  igual(destinatarios(a), ['coordenacao@exemplo.com'],
    'o link foi para quem acabou de perder o acesso');
});

teste('o campo de texto da allowlist (regravarAllowlist_) também derruba o cache', () => {
  // Caminho diferente dos dois de cima: `salvarConfiguracao_` com a chave
  // `admin_emails` reescreve a lista inteira. Ele não chama
  // `esquecerAllowlistDoLink_` — quem chama é `gravarConfig_`, e é isso que
  // impede o quinto caminho de nascer esquecido.
  const a = montar();
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');

  igual(pedirLink(a, 'coordenacao@exemplo.com').ok, true);

  const salvo = painel(a, 'salvarConfiguracao', sessao(a),
    { chave: 'admin_emails', valor: 'coordenacao@exemplo.com, campo@exemplo.com' });
  igual(salvo.ok, true, 'erro foi: ' + salvo.erro);

  igual(pedirLink(a, 'campo@exemplo.com').ok, true);
  igual(destinatarios(a), ['coordenacao@exemplo.com', 'campo@exemplo.com']);
});

teste('liberarAcesso derruba o cache: o socorro do editor vale no mesmo minuto', () => {
  const a = montar();
  a.api.console = { log() {}, error() {} }; // ela imprime a URL no console
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');

  igual(pedirLink(a, 'coordenacao@exemplo.com').ok, true);

  a.api.liberarAcesso_('socorro@exemplo.com');

  igual(pedirLink(a, 'socorro@exemplo.com').ok, true);
  igual(destinatarios(a), ['coordenacao@exemplo.com', 'socorro@exemplo.com']);
});

teste('sem CacheService a porta FECHA: mesma frase de sempre, e e-mail nenhum', () => {
  // Decisão deliberada de 07b_LinkPorEmail.gs, e o oposto do reflexo de cair na
  // leitura direta: sem cache, conferir a allowlist volta a custar uma leitura
  // por requisição anônima, e uma enxurrada gastaria a cota do formulário do
  // aluno para salvar a porta dos fundos.
  const bom = montar();
  bom.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');
  const frase = pedirLink(bom, 'coordenacao@exemplo.com');
  igual(destinatarios(bom), ['coordenacao@exemplo.com'], 'o caminho normal precisa enviar');

  const semCache = montar({ cache: { quebrarServico: true } });
  semCache.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');
  const degradada = pedirLink(semCache, 'coordenacao@exemplo.com');

  igual(degradada, frase, 'a resposta mudou com o cache fora do ar — e ela é a porta');
  igual(destinatarios(semCache), [], 'saiu e-mail sem a allowlist ter sido conferida');
  verdadeiro(semCache.registros.erros.some((m) => /pedirLinkDeAcesso: CacheService/.test(m)),
    'o console é o único aviso que sobra, e ele não pode faltar: ' +
    JSON.stringify(semCache.registros.erros));
});

// ------------------------------------------- liberarMeuAcesso, a última porta

/**
 * `liberarMeuAcesso()` (07b_LinkPorEmail.gs) é a porta que se abre por DENTRO:
 * ela não recebe argumento — o botão Executar do editor do Apps Script não passa
 * nenhum — e libera a conta que roda o script, via `Session.getEffectiveUser()`.
 *
 * Ela é segura por uma razão só, e a razão é o que estes testes guardam: só se
 * chega a ela pelo editor do projeto, e quem chega ao editor já poderia
 * reescrever `entrarComLink_` inteiro. No dia em que ela virar despachável pela
 * API, ela deixa de ser saída de emergência e passa a ser porta dos fundos
 * anônima — daí o quarto teste ser sobre 08_Api.gs, e não sobre 07b.
 *
 * Os três primeiros chamam a IMPLEMENTAÇÃO (`liberarMeuAcesso_`), num web app
 * anônimo com a conta efetiva preenchida, para provar que é a EFETIVA que ela
 * libera. A casca pública, que só roda no editor, tem a guarda conferida em
 * testes/portas.js — e é ela que recusa exatamente o ambiente destes testes.
 */
grupo('liberarMeuAcesso — a saída que não passa pela internet');

teste('libera a conta que RODA o script, e a sessão abre o painel', () => {
  const a = montar({ usuarioEfetivo: 'dono@exemplo.com' });
  a.api.console = { log() {}, error() {} };

  const url = a.api.liberarMeuAcesso_();
  const token = /\?sessao=([0-9a-f]+)/.exec(url)[1];

  igual(painel(a, 'painelEstatisticas', token, {}).ok, true, 'a sessão não abriu o painel');
  igual(painel(a, 'listarAdmins', token, {}).voce, 'dono@exemplo.com',
    'a sessão precisa saber de quem ela é — é ela que assina a trilha');
});

teste('repõe o e-mail na allowlist quando a lista está vazia', () => {
  // É o que separa conserto de remendo: sem repor, a sessão de hoje vence em oito
  // horas e o sistema volta à lista vazia — o mesmo beco de onde se saía.
  const a = montar({ usuarioEfetivo: 'dono@exemplo.com' });
  a.api.console = { log() {}, error() {} };
  igual(login(a, 'modoDeAcesso').allowlistVazia, true, 'o teste começa do beco');

  a.api.liberarMeuAcesso_();

  const tela = login(a, 'modoDeAcesso');
  igual(tela.allowlistVazia, false, 'o dia seguinte volta ao estado sem porta nenhuma');
  igual(a.api.config_('admin_emails'), 'dono@exemplo.com');

  // E a lista reposta serve à porta remota no ato — o cache não guardou a vazia.
  igual(pedirLink(a, 'dono@exemplo.com').ok, true);
  igual(destinatarios(a), ['dono@exemplo.com']);
});

teste('sem e-mail efetivo ela ensina a saída, em vez de criar sessão anônima', () => {
  // `Session` sem permissão é o que acontece quando `userinfo.email` não foi
  // concedido. Cair em `liberarAcesso_('')` daria um `throw` genérico; pior, um
  // dia daria uma sessão sem dono. A recusa aqui é explícita e diz o que fazer.
  //
  // E o que ela diz não pode ser "rode `liberarAcesso(...)`": a casca dela tem a
  // mesma guarda (`exigirDono_`), que pararia no mesmo e-mail que faltou aqui. A
  // saída para esse dia está escrita no comentário de `liberarAcesso`.
  const a = montar({ usuarioEfetivo: null });
  const erro = lancou(() => a.api.liberarMeuAcesso_());

  verdadeiro(/userinfo\.email/.test(erro.message), erro.message);
  verdadeiro(/comentário de liberarAcesso/.test(erro.message), 'sem o caminho alternativo: ' + erro.message);
  verdadeiro(!/liberarAcesso\(\s*["']/.test(erro.message),
    'a saída manda chamar a casca, que para na mesma guarda: ' + erro.message);
  igual(a.api.config_('admin_emails'), '', 'nada foi gravado na lista');
});

teste('conta do editor sem a forma da lista: a frase diz qual é a conta e manda usar outro endereço', () => {
  // A regex da lista de acesso fica como está: o apóstrofo, que o Workspace
  // aceita, não entra. O que muda é a frase — a de `liberarAcesso_` ("Informe um
  // e-mail") é de quem esqueceu o argumento, e aqui ninguém passou argumento
  // nenhum. Desta vez a saída É a casca `liberarAcesso`: a guarda passa, porque
  // a conta que pediu é a que roda, e quem não passa é só o endereço.
  //
  // Mutação que derruba: tirar a conferência da forma de `liberarMeuAcesso_`.
  const conta = "nome.d'exemplo@exemplo.edu.br";
  const a = montar({ usuarioEfetivo: conta });
  a.api.console = { log() {}, error() {} };
  igual(a.api.emailDeAcessoValido_(conta), false, 'o cenário precisa de uma conta fora da forma');

  const erro = lancou(() => a.api.liberarMeuAcesso_());

  verdadeiro(erro.message.indexOf('A conta ' + conta + ' não tem a forma que a lista de acesso aceita') === 0,
    'a frase não diz qual conta nem por quê: ' + erro.message);
  verdadeiro(/liberarAcesso\("/.test(erro.message), 'sem a saída: ' + erro.message);
  igual(/Informe um e-mail/.test(erro.message), false, 'a frase ainda é a de quem esqueceu o argumento: ' + erro.message);
  igual(a.api.config_('admin_emails'), '', 'nada foi gravado na lista');

  // E a saída que ela manda tomar funciona, pela mesma conta, com outro endereço.
  const url = a.api.liberarAcesso_('nome.sobrenome@exemplo.edu.br');
  verdadeiro(/\?sessao=[0-9a-f]+/.test(url), url);
  igual(a.api.config_('admin_emails'), 'nome.sobrenome@exemplo.edu.br');
});

teste('NÃO é despachada pela API — nem no login, nem no painel', () => {
  // As duas listas de 08_Api.gs, as duas direções. `liberarMeuAcesso` e
  // `liberarAcesso` existem, são funções, e continuam inalcançáveis de fora: é
  // exatamente essa inalcançabilidade que as torna seguras.
  const a = montar();
  const token = sessao(a);

  ['liberarMeuAcesso', 'liberarAcesso'].forEach((nome) => {
    igual(typeof a.api[nome], 'function', nome + ' devia existir para o teste valer');
    igual(login(a, nome), { ok: false, erro: 'Ação desconhecida.' },
      nome + ' foi despachada por rotaDeLogin_ — isso é porta dos fundos anônima');

    const doPainel = painel(a, nome, token, { email: 'invasor@exemplo.com' });
    igual(doPainel.ok, false, nome + ' foi despachada por funcoesDoPainel_');
    verdadeiro(doPainel.erro.indexOf('Ação desconhecida') === 0, nome + ': ' + doPainel.erro);
  });

  igual(a.api.config_('admin_emails'), '', 'a allowlist foi mexida pela rota');
});

// --------------------------------------------- a lista branca como contrato

grupo('a lista branca do painel é um contrato, e ele é conferido');

/** O texto de todos os `.gs`, para conferir o que o sandbox não mostra. */
function textoDosGs() {
  const mapa = {};
  fs.readdirSync(PASTA_GS).filter((n) => n.slice(-3) === '.gs').forEach((n) => {
    mapa[n] = fs.readFileSync(path.join(PASTA_GS, n), 'utf8');
  });
  return mapa;
}

teste('toda função da lista branca existe e é função', () => {
  // A chave é o nome do FIO; o valor é a função. É o valor que tem de existir —
  // e ser a MESMA função global do servidor, e não uma cópia montada no mapa.
  const a = montar();
  const funcoes = a.api.funcoesDoPainel_();
  const nomes = Object.keys(funcoes);

  verdadeiro(nomes.length >= 28, 'só ' + nomes.length + ' na lista: alguma sumiu?');
  nomes.forEach((n) => {
    igual(typeof funcoes[n], 'function', n + ' está na lista branca e não existe no servidor');
    verdadeiro(a.api[funcoes[n].name] === funcoes[n], n + ' aponta para uma função que não é a global ' +
      funcoes[n].name);
  });
});

teste('toda função da lista branca começa por exigirAdmin', () => {
  // A lista branca diz "o navegador pode chamar"; o `exigirAdmin_` diz "só com
  // token". Uma função despachável sem a guarda seria um endereço anônimo com
  // acesso ao cadastro — e o teste anterior, que só confere que a rota exige
  // token, continuaria verde, porque a rota exige.
  //
  // `exigirCoordenador_` conta como guarda, e não é afrouxamento: a primeira
  // linha dela é `exigirAdmin_` (conferida logo abaixo, neste mesmo teste, e por
  // um teste de ataque em invasao.js que mede que a recusa de sessão não custa
  // leitura). Ela é a guarda das quatro que concedem ou revogam poder —
  // `incluirAdmin_`, `removerAdmin_`, `definirNivel_` e `salvarConfiguracao_`.
  const a = montar();
  const textos = textoDosGs();
  const semGuarda = [];

  // O corpo procurado é o da FUNÇÃO (`listarAlunos_`), e não o do nome do fio
  // (`listarAlunos`): é o nome declarado do valor que a lista guarda.
  const funcoes = a.api.funcoesDoPainel_();
  const guarda = /exigir(Admin|Coordenador)_\s*\(/;
  Object.keys(funcoes).forEach((nome) => {
    let achou = false;
    Object.keys(textos).forEach((arquivo) => {
      const corpo = corpoDaFuncao(textos[arquivo], funcoes[nome].name);
      if (corpo === null) return;
      if (guarda.test(corpo)) achou = true;
    });
    if (!achou) semGuarda.push(nome);
  });

  igual(semGuarda, [], 'sem exigirAdmin: ' + semGuarda.join(', '));

  // E a guarda de nível não pode virar a porta que dispensa a de sessão.
  const daCoroa = corpoDaFuncao(textos['07_Auth.gs'], 'exigirCoordenador_');
  verdadeiro(daCoroa !== null, 'exigirCoordenador_ sumiu de 07_Auth.gs');
  verdadeiro(/exigirAdmin_\s*\(/.test(daCoroa),
    'exigirCoordenador_ deixou de exigir a sessão antes do nível');
});

/** O corpo textual de `function nome(...)`, ou null se ela não está no arquivo. */
function corpoDaFuncao(texto, nome) {
  const re = new RegExp('^function\\s+' + nome + '\\s*\\(', 'm');
  const casou = re.exec(texto);
  if (!casou) return null;

  let i = texto.indexOf('{', casou.index);
  let profundidade = 0;
  for (let j = i; j < texto.length; j++) {
    if (texto[j] === '{') profundidade++;
    if (texto[j] === '}') {
      profundidade--;
      if (profundidade === 0) return texto.slice(i, j + 1);
    }
  }
  throw new Error('não consegui fechar o corpo de ' + nome);
}

teste('nenhuma função de login está na lista branca do painel, e vice-versa', () => {
  // As duas listas se sobrepondo seria o pior dos dois mundos: uma função de
  // painel alcançável sem token, ou uma de login alcançável só com token — que é
  // o galo de ouro do ovo, já que o login existe para produzir o token.
  const a = montar();
  const doPainel = Object.keys(a.api.funcoesDoPainel_());

  ['autenticar', 'entrarComGoogle', 'modoDeAcesso', 'sair', 'sessaoAtiva'].forEach((n) => {
    igual(doPainel.indexOf(n), -1, n + ' é de login e está na lista do painel');
  });
});

teste('a lista branca cobre tudo que o painel chama hoje', () => {
  // Não é o painel que manda na lista — é a lista que manda no que o painel
  // consegue chamar. Mas uma função que o painel chama e a lista não tem vira um
  // botão que responde "Ação desconhecida" no navegador, e ninguém descobre
  // antes do clique. Este teste é o alarme dessa divergência.
  //
  // A direção é só esta: a lista PODE ter mais. Não pode ter menos.
  //
  // O arquivo mudou em 07/08: o painel saiu de `apps-script/Admin.html` (servido
  // pelo Apps Script) para `docs/painel/index.html` (GitHub Pages). Ler o antigo
  // daria um teste verde sobre uma tela que ninguém abre mais — e foi o que
  // aconteceu no primeiro minuto depois da mudança, com "só 2 chamadas".
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'painel', 'index.html'), 'utf8');
  const a = montar();
  const conhecidas = a.api.funcoesDoPainel_();

  // As de login não estão na lista branca do painel — elas rodam antes de existir
  // token. `pedirLinkDeAcesso` e `entrarComLink` (07b_LinkPorEmail.gs) entraram
  // aqui com a tela nova; `autenticar` continua sendo de login, e a tela deixou
  // de chamá-la quando o PIN saiu.
  const DE_LOGIN = ['autenticar', 'entrarComGoogle', 'modoDeAcesso', 'sair', 'sessaoAtiva',
    'pedirLinkDeAcesso', 'entrarComLink'];
  const chamadas = [];
  const re = /\bchamar\(\s*'([A-Za-z_$][\w$]*)'/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (chamadas.indexOf(m[1]) === -1) chamadas.push(m[1]);
  }
  // O único despacho dinâmico do painel: `chamar(cruzar ? 'a' : 'b', ...)`.
  ['atualizarAlunos', 'listarAlunos'].forEach((n) => {
    if (chamadas.indexOf(n) === -1) chamadas.push(n);
  });

  verdadeiro(chamadas.length >= 24, 'só ' + chamadas.length + ' chamadas: o detector regrediu');

  const faltando = chamadas.filter((n) => DE_LOGIN.indexOf(n) === -1 && !conhecidas[n]);
  igual(faltando, [],
    'o painel chama ' + faltando.length + ' função(ões) que a lista branca não despacha: ' +
    faltando.join(', ') + '. No GitHub Pages, o botão responde "Ação desconhecida".');
});

// ------------------------------------------------------------ falhas

grupo('quando alguma coisa quebra');

teste('Firestore fora do ar responde JSON de erro, e não a página do Apps Script', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  a.api.limparCacheConfig_();
  zerar(a);

  a.falso.forcar(503, 'UNAVAILABLE', 'The service is currently unavailable.');
  a.falso.forcar(503, 'UNAVAILABLE', 'The service is currently unavailable.');
  a.falso.forcar(503, 'UNAVAILABLE', 'The service is currently unavailable.');

  const saida = a.api.doGet({ parameter: { api: 'projetos' } });
  igual(saida.getMimeType(), 'application/json');
  igual(corpoDe(saida), { ok: false, erro: 'Não foi possível carregar os dados agora. Tente em instantes.' });
});

teste('a mensagem de erro não vaza o caminho nem o texto do Google', () => {
  const a = montar();
  a.api.limparCacheConfig_();
  zerar(a);
  a.falso.forcar(403, 'PERMISSION_DENIED', 'Missing or insufficient permissions on projects/unicesusc-cesutech');

  const erro = corpoDe(a.api.doGet({ parameter: { api: 'config' } })).erro;
  igual(erro.indexOf('unicesusc'), -1, 'vazou o id do projeto');
  igual(erro.indexOf('PERMISSION_DENIED'), -1, 'vazou o status do Google');
  verdadeiro(a.registros.erros.length > 0, 'mas o original foi para o console');
});

teste('resposta com erro não é guardada no cache', () => {
  const a = montar();
  a.api.limparCacheConfig_();
  zerar(a);
  a.falso.forcar(403, 'PERMISSION_DENIED', 'sem permissão');
  a.api.doGet({ parameter: { api: 'config' } });

  // As duas chaves do freio da trilha (`registrarErroInterno_` → `registrarRecusa_`,
  // 04_Log.gs) ficam, e são delas: o que não pode ficar é a RESPOSTA da rota.
  igual(Array.from(a.cache.dados.keys()).filter((k) => k.indexOf('recusa_') !== 0), [],
    'uma falha ficaria grudada por 30 segundos');
  igual(corpoDe(get(a, { api: 'config' })).ok, true, 'e a chamada seguinte já funciona');
});

teste('sem CacheService a rota responde igual, só mais cara', () => {
  const a = montar({ semCache: true });
  criarProjeto(a.api, 'p1');

  const primeira = corpoDe(get(a, { api: 'projetos' }));
  const segunda = get(a, { api: 'projetos' });

  igual(corpoDe(segunda), primeira);
  verdadeiro(a.falso.requisicoes.length > 0, 'sem cache, a segunda chamada vai ao banco');
});

teste('cache que estoura na gravação não derruba a rota', () => {
  const a = montar({ cache: { quebrarPut: true } });
  criarProjeto(a.api, 'p1');

  igual(corpoDe(get(a, { api: 'projetos' })).ok, true);
  igual(corpoDe(get(a, { api: 'projetos' })).ok, true);
  verdadeiro(a.registros.erros.length > 0, 'a falha do cache foi para o console');
});

teste('cache que estoura na leitura não derruba a rota', () => {
  const a = montar({ cache: { quebrarGet: true } });
  criarProjeto(a.api, 'p1');
  igual(corpoDe(get(a, { api: 'projetos' })).ok, true);
});

/** As linhas ERRO_INTERNO da trilha, da mais nova para a mais velha. */
function errosInternos(a) {
  return a.api.ultimosRegistros_(100).filter((l) => l.acao === 'ERRO_INTERNO');
}

/**
 * O erro como o Repo o lança de verdade: `fsErro_` (02_Repo.gs) montando a
 * resposta do Firestore para a leitura de uma matrícula. Ele leva o caminho
 * RELATIVO do documento depois do método ('em GET /matriculados/9110001'), e o
 * texto do Google aqui cita o nome inteiro dele ('projects/...'). Matrícula só na
 * forma.
 */
function erroDoRepo(api) {
  const corpo = {
    error: {
      code: 503,
      status: 'UNAVAILABLE',
      message: 'The service is currently unavailable for projects/projeto-de-teste/databases/(default)/' +
        'documents/matriculados/9110001'
    }
  };
  return api.fsErro_(503, JSON.stringify(corpo), 'get', '/matriculados/9110001');
}

/**
 * A linha da trilha não diz de quem era o documento: nem a matrícula em campo
 * nenhum, nem um caminho de documento — o relativo, que `fsErro_` escreve, ou o
 * nome inteiro, que o texto do Google cita.
 */
function semDocumentoNaLinha(linha, contexto) {
  const texto = JSON.stringify(linha);
  igual(texto.indexOf('9110001'), -1, contexto + ': a matrícula foi para a trilha: ' + texto);
  igual(linha.detalhe.indexOf('/matriculados/'), -1, contexto + ': o caminho relativo foi para a trilha: ' + linha.detalhe);
  igual(linha.detalhe.indexOf('projects/'), -1, contexto + ': o nome do documento foi para a trilha: ' + linha.detalhe);
}

teste('o erro das rotas de leitura vai para a trilha — uma linha por janela, sem o caminho do documento', () => {
  // As chamadas do site são anônimas. A tela Execuções do editor as lista, mas
  // como concluídas (a rota tratou o erro), e a coordenação não abre o editor:
  // sem a trilha, o aluno via "Não foi possível carregar..." e ninguém mais
  // ficava sabendo.
  //
  // Mutação que derruba: tirar `registrarErroInterno_` do `catch` do doGet;
  // gravar a mensagem sem `semIdDeDocumento_`; trocar `registrarRecusa_` por
  // `registrar_` (uma escrita por falha, que uma enxurrada transformaria na cota
  // de escrita do dia).
  const a = montar();
  a.api.dadosFormularioPublico_ = () => { throw erroDoRepo(a.api); };

  for (let i = 0; i < 5; i++) {
    igual(corpoDe(get(a, { api: 'config' })).ok, false);
  }

  const linhas = errosInternos(a);
  igual(linhas.length, 1, 'cinco falhas na mesma janela: ' + JSON.stringify(linhas));
  igual(linhas[0].entidade_id, 'leitura');
  semDocumentoNaLinha(linhas[0], 'leitura');
  verdadeiro(linhas[0].detalhe.indexOf('leitura: Firestore 503 UNAVAILABLE em GET /(documento): ') === 0, linhas[0].detalhe);

  // A janela seguinte grava de novo, e diz quantas foram engolidas.
  a.cache.expirar();
  get(a, { api: 'config' });
  const depois = errosInternos(a);
  igual(depois.length, 2);
});

teste('o erro da inscrição, do login e do painel também — cada um com o seu nome fixo', () => {
  // O nome é a chave do freio, e é escrito por quem chama: nada que venha do
  // corpo da requisição entra nele (testes/portas.js confere a forma).
  //
  // Mutação que derruba: tirar `registrarErroInterno_` de um dos três `catch`,
  // ou montar o nome com o que veio do cliente.
  const a = montar();
  a.api.verificarAntiAbuso_ = () => { throw erroDoRepo(a.api); };
  a.api.modoDeAcesso_ = () => { throw erroDoRepo(a.api); };
  a.api.listarLotes_ = () => { throw erroDoRepo(a.api); };
  const token = a.api.criarSessao_('coord@exemplo.com');
  a.api.gravarConfig_('admin_emails', 'coord@exemplo.com');

  igual(corpoDe(post(a, { acao: 'inscricao', nome: 'Aluno de teste' })).erro,
    'Erro ao registrar. Tente novamente em instantes.');
  igual(corpoDe(post(a, { acao: 'login', fn: 'modoDeAcesso' })).ok, false);
  igual(corpoDe(post(a, { acao: 'painel', fn: 'listarLotes', token: token })).ok, false);

  igual(errosInternos(a).map((l) => l.entidade_id).sort(), ['inscricao', 'login', 'painel']);
  errosInternos(a).forEach((l) => semDocumentoNaLinha(l, l.entidade_id));
});

teste('o erro que escapa até o catch do doPost também', () => {
  // Mutação que derruba: tirar `registrarErroInterno_` do `catch` do doPost.
  const a = montar();
  a.api.submeterInscricao_ = () => { throw erroDoRepo(a.api); };

  igual(corpoDe(post(a, { acao: 'inscricao' })).erro, 'Erro interno ao processar a inscrição.');
  igual(errosInternos(a).map((l) => l.entidade_id), ['post']);
  semDocumentoNaLinha(errosInternos(a)[0], 'post');
});

/**
 * As três formas em que a leitura da lista oficial cai sem ninguém ter errado
 * nada: o serviço fora do ar, a cota do dia e a permissão do projeto. As duas
 * primeiras o Repo tenta de novo (FS_MAX_TENTATIVAS); a terceira, não.
 */
const QUEDAS_DA_LEITURA = [
  [503, 'UNAVAILABLE', 'The service is currently unavailable.'],
  [429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.'],
  [403, 'PERMISSION_DENIED', 'Missing or insufficient permissions.']
];

/**
 * Derruba TODAS as tentativas das leituras de `matriculados` que vierem: o banco
 * responde, e a resposta vira o erro do Firestore. Quem monta o Error é o
 * `fsErro_` de verdade, com o caminho relativo do documento na mensagem.
 */
function derrubarLeituraDaLista(a, codigo, status, mensagem) {
  for (let i = 0; i < a.api.FS_MAX_TENTATIVAS; i++) {
    a.falso.derrubarDepoisDeAplicar('/matriculados/', codigo, status, mensagem);
  }
}

teste('a conferência da matrícula que cai no banco vai para a trilha sem a matrícula — 503, 429 e 403', () => {
  // O erro é o de verdade: `fsErro_` escreve 'em GET /matriculados/9110001', e
  // `semCaminhoDeDocumento_` só tira o nome inteiro ('projects/...'). A linha
  // fica um ano no banco, vai para o backup e aparece no Histórico; o que ela
  // precisa dizer é o código, o status e o método.
  //
  // Mutação que derruba: `registrarErroInterno_` voltar a gravar só com
  // `semCaminhoDeDocumento_`; ou a régua da trilha não trocar o caminho
  // relativo.
  QUEDAS_DA_LEITURA.forEach(([codigo, status, mensagem]) => {
    const a = montar();
    matricular(a.api, ['9110001']);
    derrubarLeituraDaLista(a, codigo, status, mensagem);

    const r = corpoDe(get(a, { api: 'matricula', m: '9110001' }));
    igual(r, { ok: false, erro: 'Não foi possível carregar os dados agora. Tente em instantes.' }, status);
    verdadeiro(a.falso.requisicoes.some(LEITURA_MATRICULA), status + ': a rota nem leu a lista oficial');

    const linhas = errosInternos(a);
    igual(linhas.map((l) => l.entidade_id), ['leitura'], status + ': ' + JSON.stringify(linhas));
    semDocumentoNaLinha(linhas[0], status);
    igual(linhas[0].detalhe.indexOf('leitura: Firestore ' + codigo + ' ' + status + ' em GET /(documento): '), 0,
      status + ': a linha não diz o que falhou: ' + linhas[0].detalhe);
  });
});

teste('a inscrição que cai na leitura da lista oficial vai para a trilha sem a matrícula — 503, 429 e 403', () => {
  // O mesmo erro, pelo caminho do envio: `submeterInscricao_` lê a ficha oficial
  // pela matrícula, e o `catch` dela anota a falha com o nome 'inscricao'.
  //
  // Mutação que derruba: a mesma do teste de cima.
  QUEDAS_DA_LEITURA.forEach(([codigo, status, mensagem]) => {
    const a = montar();
    criarProjeto(a.api, 'p1');
    matricular(a.api, ['9110001']);
    derrubarLeituraDaLista(a, codigo, status, mensagem);

    const r = corpoDe(post(a, Object.assign({ acao: 'inscricao', projeto_id: 'p1' }, INSCRICAO_VALIDA)));
    igual(r, { ok: false, erro: 'Erro ao registrar. Tente novamente em instantes.' }, status);
    verdadeiro(a.falso.requisicoes.some(LEITURA_MATRICULA), status + ': o envio nem leu a lista oficial');
    igual(acoesDoLog(a.falso).filter((acao) => acao.indexOf('INSCRICAO') === 0), [], status + ': a inscrição entrou');

    const linhas = errosInternos(a);
    igual(linhas.map((l) => l.entidade_id), ['inscricao'], status + ': ' + JSON.stringify(linhas));
    semDocumentoNaLinha(linhas[0], status);
    igual(linhas[0].detalhe.indexOf('inscricao: Firestore ' + codigo + ' ' + status + ' em GET /(documento): '), 0,
      status + ': a linha não diz o que falhou: ' + linhas[0].detalhe);
  });
});

teste('no Histórico, o mesmo erro do banco em duas rotas sai em duas linhas que se distinguem', () => {
  // A aba Histórico desenha Quando, Quem, Ação, Entidade e Detalhe — e não
  // `entidade_id`. Com o nome da rota só lá, a leitura da matrícula e o envio da
  // inscrição que caíssem no mesmo 503 sairiam iguais em toda coluna desenhada,
  // menos a hora. O nome vai na frente do detalhe; a chave do freio continua a
  // de cada nome.
  //
  // Mutação que derruba: `registrarErroInterno_` gravar o detalhe sem o nome.
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);
  derrubarLeituraDaLista(a, 503, 'UNAVAILABLE', 'The service is currently unavailable.');
  get(a, { api: 'matricula', m: '9110001' });
  derrubarLeituraDaLista(a, 503, 'UNAVAILABLE', 'The service is currently unavailable.');
  post(a, Object.assign({ acao: 'inscricao', projeto_id: 'p1' }, INSCRICAO_VALIDA));

  const linhas = errosInternos(a);
  igual(linhas.map((l) => l.entidade_id).sort(), ['inscricao', 'leitura'], JSON.stringify(linhas));
  const naTela = linhas.map((l) => [l.usuario, l.acao, l.entidade, l.detalhe].join(' | '));
  igual(naTela[0] === naTela[1], false, 'as duas linhas saem iguais no Histórico: ' + naTela[0]);
  linhas.forEach((l) => {
    igual(l.detalhe.indexOf(l.entidade_id + ': Firestore 503 UNAVAILABLE em GET /(documento): '), 0, l.detalhe);
    semDocumentoNaLinha(l, l.entidade_id);
  });
});

teste('a régua da trilha tira todo id de documento, e deixa o código, o status, o método e a coleção sozinha', () => {
  // Os pedaços além do segundo e a query também são do documento; o nome da
  // coleção sem id ('em POST /inscricoes') não é documento de ninguém. O
  // endereço do Google e uma data não são caminho.
  //
  // Mutação que derruba: a troca só do primeiro par de pedaços; sem a query; ou
  // sem o caractere de antes (o endereço do Google viraria '/(documento)').
  const a = montar();
  [
    ['Firestore 503 UNAVAILABLE em GET /matriculados/9110001: The service is currently unavailable.',
      'Firestore 503 UNAVAILABLE em GET /(documento): The service is currently unavailable.'],
    ['Firestore 503 UNAVAILABLE em PATCH /alunos/9110001/anexos/a1b2?updateMask.fieldPaths=nome: x',
      'Firestore 503 UNAVAILABLE em PATCH /(documento): x'],
    ['Firestore 409 ALREADY_EXISTS em POST /inscricoes?documentId=9110001_p1 Document already exists',
      'Firestore 409 ALREADY_EXISTS em POST /(documento) Document already exists'],
    ['Firestore 503 UNAVAILABLE em GET /inscricoes/9110001%40aluno: x',
      'Firestore 503 UNAVAILABLE em GET /(documento): x'],
    ['Não consegui ler: Firestore 503 UNAVAILABLE em GET /lotes/9110001: x',
      'Não consegui ler: Firestore 503 UNAVAILABLE em GET /(documento): x'],
    ['Document "/matriculados/9110001" not found', 'Document "/(documento)" not found'],
    ['/matriculados/9110001 no começo', '/(documento) no começo'],
    ['em GET /matriculados/9110001, depois em PATCH /alunos/9110001: x',
      'em GET /(documento), depois em PATCH /(documento): x'],
    ['Firestore 409 ALREADY_EXISTS em POST /inscricoes: Document already exists: ' +
      'projects/projeto-de-teste/databases/(default)/documents/inscricoes/9110001_p1',
    'Firestore 409 ALREADY_EXISTS em POST /inscricoes: Document already exists: (documento)'],
    ['Firestore 404 NOT_FOUND em GET /projetos/9110001: Document not found: ' +
      'https://firestore.googleapis.com/v1/projects/projeto-de-teste/databases/(default)/documents/projetos/9110001',
    'Firestore 404 NOT_FOUND em GET /(documento): Document not found: https://firestore.googleapis.com/v1/(documento)'],
    ['Firestore 503 UNAVAILABLE em POST :commit: x', 'Firestore 503 UNAVAILABLE em POST :commit: x'],
    ['falhou em 16/11/2026 às 10:00', 'falhou em 16/11/2026 às 10:00']
  ].forEach(([entrada, esperada]) => {
    igual(a.api.semIdDeDocumento_(new Error(entrada)), esperada, entrada);
    igual(a.api.semIdDeDocumento_(entrada), esperada, 'como texto: ' + entrada);
  });
});

teste('anotar o erro nunca derruba a resposta — nem com o banco e o cache fora do ar', () => {
  // A anotação é uma escrita no banco, e o erro que se anota costuma ser o banco
  // fora do ar. A resposta tem de sair igual, só sem a linha.
  //
  // Mutação que derruba: `registrarErroInterno_` sem o `try` dela, com
  // `registrarRecusa_` lançando.
  const a = montar({ cache: { quebrarServico: true } });
  a.api.dadosFormularioPublico_ = () => { throw erroDoRepo(a.api); };
  a.api.registrarRecusa_ = () => { throw new Error('o banco também caiu'); };

  igual(corpoDe(get(a, { api: 'config' })), { ok: false, erro: 'Não foi possível carregar os dados agora. Tente em instantes.' });
});

// ------------------------------------------------------------ contratos

grupo('contratos que não podem divergir em silêncio');

teste('os padrões de config deste arquivo são os mesmos de CONFIG_PADRAO', () => {
  const a = montar();
  const codigo = fs.readFileSync(path.join(PASTA_GS, '08_Api.gs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Textos que a coordenação pode APAGAR pelo painel. Se o padrão fosse a frase
  // de CONFIG_PADRAO, limpar o campo faria a frase voltar sozinha.
  const APAGAVEIS = ['texto_lgpd', 'texto_declaracao', 'texto_imagem', 'texto_esgotado'];

  const padroes = {};
  a.api.CONFIG_PADRAO.forEach((item) => { padroes[item.chave] = String(item.valor); });

  const achados = [];
  const regex = /\bconfig_\(\s*'([a-z_]+)'\s*,\s*'([^']*)'\s*\)/g;
  let m;
  while ((m = regex.exec(codigo)) !== null) achados.push({ chave: m[1], padrao: m[2] });

  verdadeiro(achados.length >= 6, 'achou ' + achados.length + ' chamadas de config com padrão');

  achados.forEach((achado) => {
    verdadeiro(padroes[achado.chave] !== undefined, achado.chave + ' não existe em CONFIG_PADRAO');
    if (APAGAVEIS.indexOf(achado.chave) !== -1) {
      igual(achado.padrao, '', achado.chave + ' precisa de padrão vazio para ser apagável');
    } else {
      igual(achado.padrao, padroes[achado.chave], 'padrão de ' + achado.chave);
    }
  });
});

teste('o teto de consultas usa o padrão de CONFIG_PADRAO, e não os 300 antigos', () => {
  // Sem a chave no banco — implantação nova, setup pela metade —, 300 acabaria
  // nos primeiros minutos do auditório e a conferência pararia de responder,
  // liberando todo mundo sem conferência.
  const a = montar({ semSemear: true });
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);

  for (let i = 0; i < 301; i++) a.api.excedeuConsultas_();
  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).existe, true);
});

teste('a chave do cache não colide com nada do sistema', () => {
  const a = montar();
  igual([a.api.CACHE_CONFIG, a.api.CACHE_PROJETOS], ['api_config', 'api_projetos']);
});

teste('o site continua mandando text/plain — as duas pontas do contrato', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'docs', 'assets', 'app.js'), 'utf8');

  // Com application/json o navegador dispara um preflight OPTIONS, e o Apps
  // Script não responde OPTIONS: a inscrição morre dentro do navegador do aluno,
  // sem chegar ao servidor e sem deixar erro para explicar o sumiço. Se este
  // teste quebrar, `doPost` parou de receber o que o site manda.
  verdadeiro(/'Content-Type':\s*'text\/plain/.test(app), 'o POST do site deixou de ser text/plain');
  verdadeiro(app.indexOf('body: JSON.stringify(dados)') !== -1, 'o corpo deixou de ser JSON');
  verdadeiro(app.indexOf("redirect: 'follow'") !== -1, 'o /exec responde por redirecionamento');
});

// O identificador da implantação do sistema EM PRODUÇÃO
// (o sistema anterior, sobre Google Sheets) é o que monta a URL /exec que grava na
// planilha real do CESUTECH. Ele NÃO pode ser escrito aqui: este repositório é
// público, e a versão anterior deste teste guardava o segredo hardcodando
// exatamente o segredo — quem lesse o teste ganhava o valor de graça.
//
// Por isso o que fica gravado é o SHA-256 dele, em hexadecimal. O teste compara
// hashes: continua reconhecendo (e recusando) o valor proibido, sem nunca
// carregá-lo. O hash não se inverte, então publicar esta linha não entrega nada.
//
// Se a implantação de produção mudar, recalcule com:
//   node -e "console.log(require('crypto').createHash('sha256').update('<id>').digest('hex'))"
const SHA256_IMPLANTACAO_DA_PRODUCAO =
  '6e2c556ed1ab771e27fc0440998346a4f479f6ba9df233d944690ac0b67f0b37';

const sha256 = (v) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

teste('o endpoint do site NÃO aponta para o sistema em produção', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'docs', 'assets', 'config.js'), 'utf8');
  const m = /endpoint:\s*'([^']*)'/.exec(cfg);

  verdadeiro(m, 'a chave `endpoint` sumiu do config.js');

  // A versão anterior deste teste exigia endpoint VAZIO. Guardava a coisa certa
  // pelo motivo errado: o perigo nunca foi preencher, foi preencher com a URL
  // ERRADA. Vazio deixou de ser verdade quando o web app deste projeto foi
  // implantado, e um teste que quebra no uso normal vira teste que se comenta.
  //
  // O invariante que importa: apontar para a implantação de produção faria o
  // site novo gravar na planilha real do CESUTECH, que tem um evento de 400 a
  // 500 alunos marcado, por um front-end ainda não validado.
  // Cada pedaço longo da URL é hasheado e conferido contra o hash proibido —
  // pega o identificador esteja ele no lugar de sempre ou colado em outro
  // ponto do endereço, que é o que a comparação por substring fazia antes.
  const pedacos = m[1].match(/[\w-]{20,}/g) || [];
  verdadeiro(!pedacos.some((p) => sha256(p) === SHA256_IMPLANTACAO_DA_PRODUCAO),
    'o endpoint aponta para a implantação DE PRODUÇÃO do cesutech');

  verdadeiro(m[1] === '' || /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(m[1]),
    'endpoint não é vazio nem uma URL /exec bem formada: ' + m[1]);
});

teste('formato reprovado sempre BLOQUEIA — nunca "siga e conferimos depois"', () => {
  // 0000000 tem sete dígitos e cara de matrícula, mas normaliza para '0'.
  // A resposta de FORMATO saía sem `bloqueia`; o formulário lia undefined,
  // entendia "não bloqueia" e deixava passar com a mensagem permissiva.
  const a = montar();
  criarProjeto(a.api, 'p1', { validar_matricula: 'SIM' });

  // Curtas demais: reprovam no FORMATO, e o formato tem de bloquear.
  ['0', 'ab', ''].forEach((entrada) => {
    const r = corpoDe(get(a, { api: 'matricula', m: entrada, p: 'p1' }));
    igual(r.valida, false, 'entrada: ' + JSON.stringify(entrada));
    igual(r.bloqueia, true, 'formato malformado tem de bloquear: ' + JSON.stringify(entrada));
  });

  // '0000000' tem sete dígitos mas a CHAVE vira '0' — um dígito. Até 19/09 ele
  // passava no formato (a régua media só o digitado) e caía na recusa por
  // ausência; desde a régua de `matricula_digitos`, que mede o digitado E a
  // chave, ele reprova no formato. Os dois desfechos bloqueiam; o de agora é
  // mais honesto, porque a mensagem diz o que está errado ("tem 7 dígitos") em
  // vez de "não está na lista" — que faria o aluno procurar a coordenação por um
  // número que nunca foi matrícula. O que este teste GUARDA é o `bloqueia`.
  const zeros = corpoDe(get(a, { api: 'matricula', m: '0000000', p: 'p1' }));
  igual(zeros.valida, false, 'sete zeros não são matrícula');
  igual(zeros.motivo, 'FORMATO');
  igual(zeros.bloqueia, true, 'e por isso bloqueia');
});

teste('o zero à esquerda da secretaria é aceito, e a chave sem ele acha o matriculado', () => {
  // ERA: "'0001' é matrícula de quatro dígitos legítima". Desde 19/09 o tamanho
  // vem de `matricula_digitos`, e 4 dígitos só valem se a configuração disser 4.
  // A intenção do teste continua a mesma — o zero que a secretaria escreve na
  // frente não pode reprovar o aluno — só que agora com a régua configurada.
  const a = montar();
  criarProjeto(a.api, 'p1', { validar_matricula: 'SIM' });
  matricular(a.api, ['9110001']);

  const r = corpoDe(get(a, { api: 'matricula', m: '09110001', p: 'p1' }));
  igual(r.valida, true, 'oito dígitos com zero à esquerda passam no formato');
  igual(r.existe, true, 'e a chave sem o zero acha o matriculado');

  // E com a régua em 4, uma matrícula de quatro dígitos ('1001', que a
  // secretaria escreve '01001') passa do mesmo jeito. Repare que '0001' NÃO
  // passa: a régua mede a CHAVE, e '0001' normalizado é '1' — um dígito. Uma
  // matrícula "de quatro dígitos" começando com três zeros nunca existiu; era
  // o teste antigo, e não a secretaria, que a inventava.
  a.api.gravarConfig_('matricula_digitos', '4');
  matricular(a.api, ['1001']);
  const q = corpoDe(get(a, { api: 'matricula', m: '01001', p: 'p1' }));
  igual(q.valida, true, 'cinco com zero à esquerda, com a régua em 4, passam');
  igual(q.existe, true);
  igual(corpoDe(get(a, { api: 'matricula', m: '0001', p: 'p1' })).motivo, 'FORMATO',
    'chave de um dígito não tem formato de matrícula');
});

// -------------------------------------------------- orçamento de leitura

grupo('orçamento de leitura — o número do cabeçalho, medido');

teste('o caminho inteiro de um aluno, com o cache frio, custa 33 leituras', () => {
  const a = montar();
  ['p1', 'p2', 'p3', 'p4', 'p5'].forEach((id) => criarProjeto(a.api, id, { vagas: '60' }));
  matricular(a.api, ['9110001']);

  const conta = [];
  function medir(rotulo, fn) {
    a.cache.expirar();
    a.api.limparCacheConfig_();
    zerar(a);
    fn();
    const leituras = leiturasCobradas(a);
    conta.push({ rotulo: rotulo, leituras: leituras });
    return leituras;
  }

  // DUAS, e não uma: a configuração mais a consulta das disciplinas ativas. Com
  // a coleção vazia — como aqui — a consulta volta sem nada e cobra o mínimo de
  // um; com D disciplinas cadastradas ela cobra D. Ver 12_Disciplinas.gs.
  igual(medir('?api=config', () => a.api.doGet({ parameter: { api: 'config' } })), 2);

  // ONZE, e não os dez de antes da fila de espera: a décima primeira é o
  // documento de configuração, que `contarInscritos_` lê para saber se a fila
  // está ligada. Esta é a única rota que chega à contagem sem já ter lido a
  // configuração por outro motivo — o POST abaixo continua em 6 justamente por
  // já ter lido `cadastro_aberto` antes de contar vaga nenhuma.
  igual(medir('?api=projetos', () => a.api.doGet({ parameter: { api: 'projetos' } })), 11);
  igual(medir('?api=matricula', () => a.api.doGet({ parameter: { api: 'matricula', m: '9110001', p: 'p1' } })), 3);
  igual(medir('POST', () => a.api.doPost({
    postData: { type: 'text/plain', contents: JSON.stringify(Object.assign({ projeto_id: 'p1' }, INSCRICAO_VALIDA)) }
  })), 6);
  igual(medir('?api=projetos de novo', () => a.api.doGet({ parameter: { api: 'projetos' } })), 11);

  igual(conta.reduce((s, c) => s + c.leituras, 0), 33, 'a soma escrita no cabeçalho de 08_Api.gs');
});

teste('com `aluno_projeto_unico=SIM`, o POST comum custa 7 e a troca inteira custa 15 — os números do cabeçalho', () => {
  // A conta que autoriza ligar a chave, medida e não afirmada. Mutação que
  // derruba: rodar a consulta do conjunto ativo SÓ fora do lock (o POST comum
  // voltaria a 6, e duas abas com a primeira inscrição gravariam as duas — é o
  // corte de §10 do plano); ou perguntar a troca DENTRO do lock (a rodada 1
  // deixaria de ser leitura pura e o número de idas na região protegida subiria).
  const a = montar();
  ['p1', 'p2', 'p3', 'p4', 'p5'].forEach((id) => criarProjeto(a.api, id, { vagas: '60' }));
  matricular(a.api, ['9110001']);
  a.api.gravarConfig_('aluno_projeto_unico', 'SIM');

  // Os números do cabeçalho são os do cache FRIO da configuração (03_Config.gs):
  // cada POST abaixo começa sem ela guardada, como a primeira requisição de cada
  // minuto. O teste seguinte mede o mesmo caminho com o cache quente.
  function postar(corpo) {
    a.api.limparCacheConfig_();
    return corpoDe(requisicao(a, () => a.api.doPost({
      postData: { type: 'text/plain', contents: JSON.stringify(corpo) }
    })));
  }

  // O POST comum com SIM: as 6 de sempre mais a consulta do conjunto ativo, que
  // roda DENTRO do lock — é ela que impede duas abas de gravarem a primeira
  // inscrição em dois projetos. Sem outra inscrição, a consulta volta vazia e
  // cobra o mínimo de 1.
  const primeira = postar(Object.assign({ projeto_id: 'p1' }, INSCRICAO_VALIDA));
  igual(primeira.ok, true, primeira.erro);
  const comum = leiturasCobradas(a);
  igual(comum, 7);

  // Rodada 1 da troca: pergunta, e não escreve nada. Custa as leituras da
  // decisão mais a situação de p1 lida FORA do lock (cortesia: quem decide é a
  // contagem de dentro) — e nenhuma ida à região protegida.
  const pergunta = postar(Object.assign({ projeto_id: 'p2' }, INSCRICAO_VALIDA));
  igual(pergunta.troca_pendente, true, pergunta.erro);
  const rodada1 = leiturasCobradas(a);

  // Rodada 2: decide dentro do lock e escreve num `:commit` só.
  const troca = postar(Object.assign({ projeto_id: 'p2', trocar_de: ['p1'] }, INSCRICAO_VALIDA));
  igual(troca.ok, true, troca.erro);
  verdadeiro(troca.trocada && troca.trocada.de.length === 1, JSON.stringify(troca.trocada));
  const rodada2 = leiturasCobradas(a);

  igual([rodada1, rodada2], [7, 8], 'as duas rodadas, medidas');
  igual(rodada1 + rodada2, 15, 'a troca inteira, como está no cabeçalho de 08_Api.gs');

  // E UMA requisição de escrita na rodada 2 — a primitiva `escreverAtomico_`, e
  // não três idas (copiar, apagar, gravar). Mutação que derruba: voltar a
  // escrever a cópia, o delete e a inserção em requisições separadas.
  igual(a.falso.requisicoes.filter((r) => r.url.indexOf(':commit') !== -1).length, 1);
});

teste('com o cache quente, as duas rotas de leitura custam zero', () => {
  const a = montar();
  ['p1', 'p2', 'p3', 'p4', 'p5'].forEach((id) => criarProjeto(a.api, id));
  matricular(a.api, ['9110001']);

  get(a, { api: 'config' });
  get(a, { api: 'projetos' });

  // O segundo aluno da mesma janela de 30 segundos.
  igual(get(a, { api: 'config' }) && a.falso.requisicoes.length, 0);
  igual(get(a, { api: 'projetos' }) && a.falso.requisicoes.length, 0);

  // Sobram a matrícula e o POST, e a configuração já não entra em nenhum dos
  // dois: ela vem do cache do script (03_Config.gs). Duas leituras da matrícula
  // e cinco do POST: sete por aluno, contra trinta e três com tudo frio.
  get(a, { api: 'matricula', m: '9110001', p: 'p1' });
  igual(a.falso.requisicoes.length, 2);
  const post = requisicao(a, () => a.api.doPost({
    postData: { type: 'text/plain', contents: JSON.stringify(Object.assign({ projeto_id: 'p1' }, INSCRICAO_VALIDA)) }
  }));
  igual(corpoDe(post).ok, true, corpoDe(post).erro);
  igual(leiturasCobradas(a), 5);
});

teste('com a configuração no cache do script, a troca custa duas leituras a menos', () => {
  // O mesmo caminho do teste "os números do cabeçalho", sem esvaziar o cache
  // entre os POSTs. Só o primeiro paga a configuração, porque gravar
  // `aluno_projeto_unico` acabou de esquecê-la. Mutação que derruba: as rotas
  // anônimas deixarem de ler o cache (`usarConfigDoScript_`, 08_Api.gs).
  const a = montar();
  ['p1', 'p2', 'p3', 'p4', 'p5'].forEach((id) => criarProjeto(a.api, id, { vagas: '60' }));
  matricular(a.api, ['9110001']);
  a.api.gravarConfig_('aluno_projeto_unico', 'SIM');
  const postar = (corpo) => corpoDe(requisicao(a, () => a.api.doPost({
    postData: { type: 'text/plain', contents: JSON.stringify(corpo) }
  })));

  igual(postar(Object.assign({ projeto_id: 'p1' }, INSCRICAO_VALIDA)).ok, true);
  const comum = leiturasCobradas(a);
  igual(postar(Object.assign({ projeto_id: 'p2' }, INSCRICAO_VALIDA)).troca_pendente, true);
  const rodada1 = leiturasCobradas(a);
  igual(postar(Object.assign({ projeto_id: 'p2', trocar_de: ['p1'] }, INSCRICAO_VALIDA)).ok, true);
  const rodada2 = leiturasCobradas(a);

  igual([comum, rodada1, rodada2], [7, 6, 7], 'o POST comum frio, e as duas rodadas com o cache quente');
});

teste('a enxurrada anônima custa uma renovação, e não uma por requisição', () => {
  const a = montar();
  ['p1', 'p2', 'p3', 'p4', 'p5'].forEach((id) => criarProjeto(a.api, id));

  let total = 0;
  for (let i = 0; i < 50; i++) {
    get(a, { api: 'projetos' });
    total += a.falso.requisicoes.length;
  }

  // Sem cache seriam 50 x 7 requisições, e os 50 mil do dia iriam embora em
  // minutos — um botão de desligar o sistema, exposto e sem autenticação.
  igual(total, 7, '50 requisições anônimas custaram o mesmo que uma');
});

// -------------------------------------------------------------- aquecimento

/**
 * ScriptApp com acionadores de mentira, para provar o que o editor faria.
 *
 * `getOAuthToken` é preservado porque o Repo o usa em toda ida ao Firestore:
 * trocar o objeto inteiro deixaria o resto do sandbox sem banco.
 *
 * `url` é o que `ScriptApp.getService().getUrl()` devolve — o valor cujo formato
 * decide se o ping vai bater no /exec público ou em um endereço que pede sessão.
 */
function scriptAppComGatilhos(a, url) {
  const instalados = [];
  const oauth = a.api.ScriptApp.getOAuthToken;

  a.api.ScriptApp = {
    getOAuthToken: oauth,
    getService: () => ({ getUrl: () => url }),
    // Cópia: `instalarGatilhoAquecimento` percorre a lista APAGANDO, e apagar da
    // lista que se está percorrendo é como um gatilho sobra sem ninguém ver.
    getProjectTriggers: () => instalados.slice(),
    deleteTrigger(g) {
      const i = instalados.indexOf(g);
      if (i !== -1) instalados.splice(i, 1);
    },
    newTrigger(handler) {
      const gatilho = { minutos: 0, getHandlerFunction: () => handler };
      return {
        timeBased: () => ({
          everyMinutes(n) { gatilho.minutos = n; return this; },
          create() { instalados.push(gatilho); return gatilho; }
        })
      };
    }
  };

  return instalados;
}

/** Uma resposta HTTP de mentira, no formato que o UrlFetchApp devolve. */
const respostaDeMentira = (codigo, texto) => ({
  getResponseCode: () => codigo,
  getContentText: () => texto
});

/**
 * Intercepta só a chamada de SAÍDA do ping, deixando o Firestore em paz.
 *
 * O ping bate em `script.google.com` e o banco falso mora em
 * `firestore.googleapis.com`: sem essa separação, trocar o UrlFetchApp para
 * espiar o ping cortaria a leitura da configuração — e o teste de "a chave
 * url_exec resolve" mediria um caminho que não existe.
 */
function interceptarPing(a, responder) {
  const chamadas = [];
  const anterior = a.api.UrlFetchApp;

  a.api.UrlFetchApp = {
    fetchAll: anterior.fetchAll,
    fetch(url, opcoes) {
      if (String(url).indexOf('script.google.com') === -1) return anterior.fetch(url, opcoes);
      chamadas.push({ url: String(url), opcoes: opcoes });
      return responder(String(url));
    }
  };

  return chamadas;
}

grupo('?api=ping — a porta que existe para o Apps Script acordar, e mais nada');

teste('responde que está de pé, sem token e sem parâmetro nenhum', () => {
  // Anônima como as outras três rotas de leitura: o gatilho é uma chamada HTTP
  // de fora, sem sessão do Google e sem token do painel. Se ela exigisse
  // qualquer coisa, o aquecimento nunca aconteceria — e ninguém descobriria,
  // porque uma tela de erro do Google esquenta instância nenhuma.
  const a = montar();
  const saida = get(a, { api: 'ping' });

  igual(saida.getMimeType(), 'application/json');
  igual(corpoDe(saida).ok, true);
});

teste('não faz NENHUMA leitura do Firestore, e o zero é medido', () => {
  const a = montar();
  ['p1', 'p2', 'p3'].forEach((id) => criarProjeto(a.api, id));

  get(a, { api: 'ping' });
  igual(a.falso.requisicoes.length, 0, 'idas ao banco');
  igual(leiturasCobradas(a), 0, 'leituras cobradas');

  // Um zero só prova alguma coisa se o contador souber contar: a MESMA medição,
  // na rota vizinha, dá dois (configuração + disciplinas ativas). São 288 pings
  // por dia — a rota que os atende é a única do arquivo que não pode custar cota.
  get(a, { api: 'config' });
  igual(leiturasCobradas(a), 2, 'o contador está vivo');
});

teste('não conta nada sobre o sistema — nem versão, nem nome, nem números', () => {
  const a = montar();
  criarProjeto(a.api, 'p1', { vagas: '60' });

  // A resposta INTEIRA, conferida caractere a caractere. É rota anônima na
  // internet: qualquer coisa a mais aqui — versão, nome do app, quantos
  // projetos existem — seria informação entregue de graça a quem só perguntou
  // se o servidor está vivo. O teste é exato de propósito, para que acrescentar
  // um campo "por conveniência" quebre alguma coisa na hora.
  igual(get(a, { api: 'ping' }).getContent(), '{"ok":true}');
});

teste('não mexe no cache e não passa pelas rotas caras', () => {
  const a = montar();
  const eventosAntes = a.cache.eventos.length;

  get(a, { api: 'ping' });

  igual(a.cache.eventos.length, eventosAntes, 'a rota de ping não fala com o cache');
});

grupo('a configuração no cache do script — recusar não lê o banco');

/** As leituras do documento de configuração na última requisição. */
function leiturasDaConfig(a) {
  return a.falso.requisicoes.filter((r) => r.metodo === 'GET' && r.url.indexOf('/config/geral') !== -1).length;
}

teste('a recusa anônima com o cache quente não lê o banco', () => {
  // A matrícula fora do formato é recusada antes de qualquer consulta, mas a
  // régua do formato (`matricula_digitos`) é configuração. Sem o cache do
  // script, até a recusa pagava uma leitura. Mutação que derruba: tirar
  // `configDoScript_` de `lerConfig_`.
  const a = montar();
  igual(corpoDe(get(a, { api: 'matricula', m: '12' })).motivo, 'FORMATO');
  igual(leiturasDaConfig(a), 1, 'a primeira paga a configuração');
  igual(corpoDe(get(a, { api: 'matricula', m: '12' })).motivo, 'FORMATO');
  igual(a.falso.requisicoes.length, 0, 'a segunda, recusada do mesmo jeito, foi ao banco');
});

teste('a tela de entrada, que não tem freio, custa uma leitura em cem cargas', () => {
  // `modoDeAcesso` roda a cada carga da tela de entrada, sem conta e sem teto.
  // Antes do cache, cem cargas eram cem leituras: o laço que gastava a cota do
  // dia. Mutação que derruba: a rota não ligar o cache (`usarConfigDoScript_`).
  const a = montar();
  let total = 0;
  for (let i = 0; i < 100; i++) {
    igual(login(a, 'modoDeAcesso').ok, true);
    total += a.falso.requisicoes.length;
  }
  igual(total, 1, 'cem cargas da tela de entrada');
});

teste('a inscrição barrada pelo campo-isca não lê o banco com o cache quente', () => {
  const a = montar();
  const isca = Object.assign({ projeto_id: 'p1' }, INSCRICAO_VALIDA, { website: 'http://exemplo.com' });
  igual(corpoDe(post(a, isca)).ok, false);
  igual(corpoDe(post(a, isca)).ok, false);
  igual(leiturasCobradas(a), 0, 'a segunda inscrição barrada leu o banco');
});

teste('gravar pela tela vale na requisição anônima seguinte, sem esperar o minuto', () => {
  // Mutação que derruba: tirar `esquecerConfigDoScript_` de `gravarConfig_`.
  const a = montar();
  igual(corpoDe(get(a, { api: 'matricula', m: '12' })).motivo, 'FORMATO');
  a.api.gravarConfig_('matricula_digitos', '2');
  const depois = corpoDe(get(a, { api: 'matricula', m: '12' }));
  verdadeiro(depois.motivo !== 'FORMATO', 'a requisição seguinte ainda usou a régua velha: ' + JSON.stringify(depois));
});

teste('os três caminhos que gravam a configuração esquecem o cache do script', () => {
  // Mutação que derruba: tirar `esquecerConfigDoScript_` de qualquer um dos três.
  const caminhos = {
    gravarConfig_: { gravar: (api) => api.gravarConfig_('cadastro_aberto', 'NAO') },
    gravarAcessos_: { gravar: (api) => api.gravarAcessos_(['nova@exemplo.com'], ['nova@exemplo.com']) },
    semearConfigPadrao_: {
      // Uma chave padrão que sumiu do documento, como se apagada no console: o
      // semear a recria, e isso é uma gravação. A limpeza do cache aqui é da
      // PREPARAÇÃO, e fica fora da conta abaixo.
      preparar: (a) => {
        delete a.falso.documentos.get('config/geral').cadastro_aberto;
        a.api.limparCacheConfig_();
      },
      gravar: (api) => igual(api.semearConfigPadrao_(), ['cadastro_aberto'])
    }
  };
  Object.keys(caminhos).forEach((nome) => {
    const a = montar();
    get(a, { api: 'matricula', m: '12' });
    if (caminhos[nome].preparar) caminhos[nome].preparar(a);
    a.api.CONFIG_CACHE = null;
    const antes = a.cache.eventos.length;
    caminhos[nome].gravar(a.api);
    const esqueceu = a.cache.eventos.slice(antes)
      .filter((e) => e.tipo === 'remove' && e.chave === a.api.CONFIG_CACHE_CHAVE).length;
    verdadeiro(esqueceu > 0, nome + ' gravou a configuração e não esqueceu o cache do script');
  });
});

teste('quem decide acesso lê o banco: removido direto no banco, o link não entra mais', () => {
  // A corrida que nenhum cache fecha (03_Config.gs): a lista guardada pode ser
  // de um minuto atrás. Aqui a remoção é feita direto no banco, sem passar pelo
  // sistema, como no console do Firestore, e o cache da tela de entrada
  // continua com a pessoa. A entrada pelo link confere a lista no banco, e
  // recusa. Mutação que derruba: `entrarComLink` ligar o cache do script.
  const a = montar();
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');
  igual(login(a, 'modoDeAcesso').allowlistVazia, false);
  igual(login(a, 'pedirLinkDeAcesso', { email: 'coordenacao@exemplo.com' }).ok, true);
  const token = tokenDoEmail(a);

  a.api.atualizar_('config', 'geral', { admin_emails: 'outra@exemplo.com' });
  igual(login(a, 'modoDeAcesso').allowlistVazia, false, 'a tela de entrada lê o cache, e ele ainda tem gente');

  const r = login(a, 'entrarComLink', { token: token });
  igual(r.ok, false, 'quem saiu da lista entrou pelo link com a lista do cache');
  verdadeiro(leiturasDaConfig(a) >= 1, 'a entrada pelo link não leu a lista no banco');
});

teste('o pedido de link e as listas do site, com o cache deles frio, não leem a configuração no banco', () => {
  // As duas têm cache próprio, e a configuração só é lida quando ele esfria: a
  // lista de acesso do link (cinco minutos, 07b_LinkPorEmail.gs) e as respostas
  // de ?api=config e ?api=projetos (`rotaCacheada_`). Nessa hora, a
  // configuração vem do cache do script. Mutações que derrubam: tirar
  // `usarConfigDoScript_(true)` de `pedirLinkDeAcesso_` ou de `rotaCacheada_`.
  const a = montar();
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');
  get(a, { api: 'matricula', m: '12' });           // a configuração vai para o cache do script

  igual(login(a, 'pedirLinkDeAcesso', { email: 'coordenacao@exemplo.com' }).ok, true);
  igual(leiturasDaConfig(a), 0, 'o pedido de link leu a configuração no banco');

  igual(corpoDe(get(a, { api: 'config' })).ok, true);
  igual(leiturasDaConfig(a), 0, '?api=config, com a resposta fora do cache, leu a configuração no banco');
});

teste('a execução nasce com o cache do script desligado', () => {
  // É o que faz quem decide acesso ler o banco sem precisar pedir. Mutação que
  // derruba: declarar CONFIG_CACHE_DO_SCRIPT_VALE como true.
  igual(montar().api.CONFIG_CACHE_DO_SCRIPT_VALE, false);
});

teste('o despacho do painel lê o nível no banco: rebaixado direto no banco, não salva configuração', () => {
  // Como o teste do link, para o nível: o cache da tela de entrada continua
  // com a pessoa entre os coordenadores, e o despacho confere no banco.
  // Mutação que derruba: `rotaDoPainel_` ligar o cache do script.
  const a = montar();
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com, professora@exemplo.com');
  a.api.gravarConfig_('coordenadores_gerais', 'coordenacao@exemplo.com, professora@exemplo.com');
  const token = a.api.criarSessao_('professora@exemplo.com');
  igual(login(a, 'modoDeAcesso').ok, true);

  a.api.atualizar_('config', 'geral', { coordenadores_gerais: 'coordenacao@exemplo.com' });

  const r = painel(a, 'salvarConfiguracao', token, { chave: 'cadastro_aberto', valor: 'NAO' });
  igual(r.ok, false, 'a rebaixada salvou configuração com o nível guardado no cache');
  igual(r.motivo, 'NIVEL');
});

teste('o prazo é absoluto: acertar o cache não o renova', () => {
  // Com o prazo renovado a cada acerto, um valor velho viveria enquanto houvesse
  // tráfego. Mutação que derruba: regravar o cache a cada leitura dele.
  const a = montar();
  get(a, { api: 'matricula', m: '12' });
  const guardadas = () => a.cache.eventos
    .filter((e) => e.tipo === 'put' && e.chave === a.api.CONFIG_CACHE_CHAVE).length;
  const antes = guardadas();
  for (let i = 0; i < 10; i++) get(a, { api: 'matricula', m: '12' });
  igual(guardadas(), antes, 'as leituras do cache regravaram a configuração');
});

teste('gravar e só depois esquecer: uma leitura anônima no meio da gravação não deixa valor velho', () => {
  // Outra execução, anônima, chega no instante anterior à gravação chegar ao
  // banco. Com a ordem gravar → esquecer, ela acerta o cache (valor velho, sem
  // regravar), e o esquecer vem depois. Com a ordem invertida, ela acharia o
  // cache vazio, leria o banco ainda velho e o guardaria por um minuto.
  // Mutação que derruba: `esquecerConfigDoScript_()` antes do `atualizar_` em
  // `gravarConfig_`.
  const a = montar();
  get(a, { api: 'matricula', m: '12' });
  const fetchDaRota = a.api.UrlFetchApp.fetch;
  let leuNoMeio = false;
  a.api.UrlFetchApp.fetch = (url, opcoes) => {
    const metodo = String((opcoes && opcoes.method) || '').toLowerCase();
    if (!leuNoMeio && metodo === 'patch' && String(url).indexOf('/config/geral') !== -1) {
      leuNoMeio = true;
      const execucao = [a.api.CONFIG_CACHE, a.api.CONFIG_CACHE_DO_SCRIPT_VALE];
      a.api.CONFIG_CACHE = null;
      a.api.CONFIG_CACHE_DO_SCRIPT_VALE = a.flagDeclarada;
      a.api.conferirMatricula_('12');
      a.api.CONFIG_CACHE = execucao[0];
      a.api.CONFIG_CACHE_DO_SCRIPT_VALE = execucao[1];
    }
    return fetchDaRota(url, opcoes);
  };
  a.api.gravarConfig_('matricula_digitos', '2');
  a.api.UrlFetchApp.fetch = fetchDaRota;

  verdadeiro(leuNoMeio, 'a gravação não passou pelo PATCH esperado');
  const depois = corpoDe(get(a, { api: 'matricula', m: '12' }));
  verdadeiro(depois.motivo !== 'FORMATO', 'a leitura do meio deixou a régua velha no cache: ' + JSON.stringify(depois));
});

teste('o cache vale um minuto, e cache fora do ar não derruba a rota', () => {
  const a = montar();
  get(a, { api: 'matricula', m: '12' });
  const guardou = a.cache.eventos.filter((e) => e.tipo === 'put' && e.chave === a.api.CONFIG_CACHE_CHAVE);
  verdadeiro(guardou.length > 0, 'a configuração não foi guardada no cache do script');
  igual(Array.from(new Set(guardou.map((e) => e.segundos))), [60], 'o prazo do cache da configuração mudou');

  const semCache = montar({ semCache: true });
  igual(corpoDe(get(semCache, { api: 'matricula', m: '12' })).motivo, 'FORMATO');
  igual(corpoDe(get(semCache, { api: 'matricula', m: '12' })).motivo, 'FORMATO');
  igual(leiturasDaConfig(semCache), 1, 'sem cache, cada requisição lê a configuração no banco, como antes');
});

// ------------------------------------------------ propriedades do script

grupo('as propriedades do script têm cota — recusar não lê nenhuma');

// As propriedades do script têm cota diária: 50 mil leituras e gravações por dia
// numa conta Google comum. Esgotada, nenhuma ida ao banco funciona, porque o
// endereço do banco mora nelas (02_Repo.gs). Até 17/11/2026 os tetos por hora
// moravam nelas, toda ida ao banco lia duas, e um robô esgotava a cota sem passar
// de recusa nenhuma. Estes testes contam cada operação (`usosDePropriedade`, no
// falso do apoio.js) e provam o zero onde ele tem de ser zero: na recusa que um
// robô REPETE. A primeira recusa de cada janela pode anotar a trilha, e anotar
// vai ao banco — ela é medida à parte.

function usos(a, tipo) {
  return a.usosDePropriedade.filter((u) => !tipo || u.tipo === tipo);
}

function lidasComo(a, prefixo) {
  return usos(a, 'get').filter((u) => u.chave.indexOf(prefixo) === 0).length;
}

/** Põe a contagem da hora corrente direto no cache, onde o servidor a procura. */
function marcarNaHora(a, prefixo, quantas) {
  a.cache.servico.getScriptCache().put(a.api.chaveDaHora_(prefixo), String(quantas), 3600);
}

/** A chave da hora, calculada aqui, sem a ajuda do servidor. */
function chaveEsperada(prefixo) {
  return prefixo + Math.floor(Date.now() / 3600000);
}

const CONSULTA_P1 = { api: 'matricula', m: '9110001', p: 'p1' };

function envioDe(matricula) {
  return Object.assign({ projeto_id: 'p1' }, INSCRICAO_VALIDA,
    { matricula: matricula, email: matricula + '@aluno.br' });
}

teste('uma requisição lê o projeto e o banco UMA vez, por mais idas ao banco que faça', () => {
  // Mutação que derruba: `fsProjeto_`/`fsBanco_` lendo a propriedade a cada
  // chamada, como até 17/11 — a inscrição abaixo faz sete idas ao banco.
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);

  const r = corpoDe(post(a, envioDe('9110001')));
  igual(r.ok, true, r.erro);
  verdadeiro(a.falso.requisicoes.length >= 5, 'a inscrição deveria ir ao banco várias vezes');
  igual(lidasComo(a, 'FIRESTORE_PROJETO'), 1, 'FIRESTORE_PROJETO');
  igual(lidasComo(a, 'FIRESTORE_BANCO'), 1, 'FIRESTORE_BANCO');
});

teste('o que se guarda vale para UMA execução: trocar o banco no editor vale na seguinte', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);

  get(a, CONSULTA_P1);
  verdadeiro(a.falso.requisicoes.every((r) => r.url.indexOf('/databases/(default)/') !== -1),
    'a consulta deveria ir ao banco padrão');

  a.propriedades.set('FIRESTORE_BANCO', 'outro-banco');
  get(a, CONSULTA_P1);
  verdadeiro(a.falso.requisicoes.length > 0 &&
    a.falso.requisicoes.every((r) => r.url.indexOf('/databases/outro-banco/') !== -1),
    'a execução seguinte ainda usou o banco da anterior');
});

teste('a matrícula barrada pelo teto não lê propriedade nem banco', () => {
  // Mutação que derruba: o contador de volta às propriedades (eram três leituras
  // por recusa), ou o teto lendo a configuração fora do cache.
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);
  a.api.gravarConfig_('limite_consultas_matricula_hora', '1');

  igual(corpoDe(get(a, CONSULTA_P1)).existe, true);
  igual(corpoDe(get(a, CONSULTA_P1)).indisponivel, true, 'a primeira recusa');
  igual(corpoDe(get(a, CONSULTA_P1)).indisponivel, true, 'a segunda recusa');
  igual(a.usosDePropriedade, [], 'a recusa pelo teto mexeu em propriedade');
  igual(a.falso.requisicoes.length, 0, 'a recusa pelo teto foi ao banco');
});

teste('a inscrição barrada pelo teto não lê propriedade nem banco', () => {
  // Mutação que derruba: o contador de volta às propriedades (eram duas leituras
  // por recusa).
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001', '9110002', '9110003']);
  a.api.gravarConfig_('limite_inscricoes_hora', '1');

  igual(corpoDe(post(a, envioDe('9110001'))).ok, true);
  igual(corpoDe(post(a, envioDe('9110002'))).ok, false, 'a primeira recusa');
  const r = corpoDe(post(a, envioDe('9110003')));
  igual(r.ok, false);
  verdadeiro(/muitas inscrições/.test(r.erro), 'recusou por outro motivo: ' + r.erro);
  igual(a.usosDePropriedade, [], 'a recusa pelo teto mexeu em propriedade');
  igual(a.falso.requisicoes.length, 0, 'a recusa pelo teto foi ao banco');
});

teste('os dois tetos moram no cache, numa chave por hora que vive uma hora', () => {
  // A chave esperada é calculada aqui, e não pela `chaveDaHora_` do servidor:
  // comparar a chave com ela mesma não prova nada. Mutação que derruba: a chave
  // sem a hora, ou o prazo de outro tamanho.
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);

  get(a, CONSULTA_P1);
  post(a, envioDe('9110001'));

  ['consultas_', 'inscricoes_'].forEach((prefixo) => {
    const gravou = a.cache.eventos.filter((e) => e.tipo === 'put' && e.chave.indexOf(prefixo) === 0);
    igual(gravou.map((e) => [e.chave, e.segundos]), [[chaveEsperada(prefixo), 3600]], prefixo);
    igual(a.cache.dados.get(chaveEsperada(prefixo)).valor, '1', prefixo);
  });
});

teste('o teto da matrícula anota UMA vez por hora, e não a cada dez minutos', () => {
  // `registrarRecusa_` agrupa por dez minutos; a marca da hora
  // (`consultas_avisadas_`) é o que faz a linha ser uma por hora. O falso desta
  // suíte não expira o cache sozinho: a janela de dez minutos vence à mão.
  // Mutação que derruba: tirar a marca da hora de `excedeuConsultas_`.
  const a = montar();
  criarProjeto(a.api, 'p1');
  a.api.gravarConfig_('limite_consultas_matricula_hora', '0');

  get(a, CONSULTA_P1);
  for (let i = 0; i < 3; i++) {
    a.cache.dados.delete('recusa_janela_teto_matricula');
    get(a, CONSULTA_P1);
  }
  igual(acoesDoLog(a.falso).filter((x) => x === 'LIMITE_CONSULTA').length, 1);
});

teste('cache fora do ar: os tetos deixam passar, e o formulário não tranca', () => {
  // A regra de sempre do teto do Google: o cache é otimização, nunca dependência.
  const a = montar({ semCache: true });
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001', '9110002']);
  a.api.gravarConfig_('limite_consultas_matricula_hora', '1');
  a.api.gravarConfig_('limite_inscricoes_hora', '1');

  igual(corpoDe(get(a, CONSULTA_P1)).existe, true);
  igual(corpoDe(get(a, CONSULTA_P1)).existe, true, 'sem cache, o teto da matrícula não conta');
  igual(corpoDe(post(a, envioDe('9110001'))).ok, true);
  igual(corpoDe(post(a, envioDe('9110002'))).ok, true, 'sem cache, o teto da inscrição não conta');
});

teste('a tela de entrada lê o client id no máximo uma vez por minuto — inclusive o vazio', () => {
  // Mutação que derruba: `modoDeAcesso_` lendo a propriedade a cada carga; ou o
  // cache guardando a string vazia crua, que volta como "nada guardado".
  [['com client id', 'cliente-de-teste.apps.googleusercontent.com'], ['sem client id', null]]
    .forEach(([caso, valor]) => {
      const a = montar();
      if (valor) a.propriedades.set('GOOGLE_CLIENT_ID', valor);

      let lidas = 0;
      for (let i = 0; i < 20; i++) {
        igual(login(a, 'modoDeAcesso').google.clientId, valor || '', caso);
        lidas += lidasComo(a, 'GOOGLE_CLIENT_ID');
      }
      igual(lidas, 1, caso + ': vinte cargas da tela de entrada');

      const guardou = a.cache.eventos.filter((e) => e.tipo === 'put' && e.chave === a.api.CLIENTE_ID_TELA_CHAVE);
      igual(guardou.map((e) => e.segundos), [60], caso + ': o prazo do client id da tela mudou');
    });
});

teste('a entrada pelo Google não lê o client id para recusar lixo, nem acima do teto', () => {
  // Mutação que derruba: ler o client id antes dos filtros, como até 17/11.
  const a = montar();
  a.propriedades.set('GOOGLE_CLIENT_ID', 'cliente-de-teste.apps.googleusercontent.com');
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');

  igual(login(a, 'entrarComGoogle', { idToken: 'isto-nao-e-um-token' }).ok, false);
  igual(lidasComo(a, 'GOOGLE_CLIENT_ID'), 0, 'o lixo leu o client id');

  marcarNaHora(a, 'gid_verif_', a.api.GOOGLE_TETO_VERIFICACOES_HORA);
  igual(login(a, 'entrarComGoogle', { idToken: 'aaa.bbb.ccc' }).ok, false);
  igual(lidasComo(a, 'GOOGLE_CLIENT_ID'), 0, 'o token acima do teto leu o client id');
  igual(a.falso.requisicoes.filter((r) => r.url.indexOf('tokeninfo') !== -1).length, 0,
    'e foi conferir no Google');
});

teste('sessão inventada: abaixo do teto a falta conta; passado o teto, a recusa repetida não lê nada', () => {
  // Mutação que derruba: tirar `sessaoBarradaPeloTeto_` de `tokenValido_`; ou
  // não contar a falta; ou o despacho não anotar o teto.
  const a = montar();
  const forjado = 'f'.repeat(32);

  igual(painel(a, 'listarAlunos', forjado, {}).erro, a.api.RECUSA_SESSAO);
  igual(lidasComo(a, 'sess_'), 1, 'abaixo do teto, a falta lê a propriedade');
  igual(a.api.lerContagemDaHora_('sessao_faltas_'), 1, 'e conta');

  marcarNaHora(a, 'sessao_faltas_', a.api.SESSAO_TETO_FALTAS_HORA);
  igual(painel(a, 'listarAlunos', forjado, {}).erro, a.api.RECUSA_SESSAO, 'a primeira recusa');
  verdadeiro(acoesDoLog(a.falso).indexOf('LIMITE_SESSAO') !== -1, 'o ataque não deixou marca na trilha');

  igual(painel(a, 'listarAlunos', forjado, {}).erro, a.api.RECUSA_SESSAO, 'a recusa repetida');
  igual(a.usosDePropriedade, [], 'a recusa repetida, passado o teto, mexeu em propriedade');
  igual(a.falso.requisicoes.length, 0, 'e foi ao banco');

  igual(login(a, 'sessaoAtiva', { token: forjado }).ok, false);
  igual(a.usosDePropriedade, [], 'a rota sessaoAtiva mexeu em propriedade passado o teto');
});

teste('a sessão conhecida continua valendo durante o ataque', () => {
  // Mutação que derruba: `criarSessao_` sem `lembrarSessao_`.
  const a = montar();
  const token = sessao(a);
  marcarNaHora(a, 'sessao_faltas_', a.api.SESSAO_TETO_FALTAS_HORA + 100);

  igual(painel(a, 'painelEstatisticas', token, {}).ok, true);
  igual(login(a, 'sessaoAtiva', { token: token }).ok, true);
});

teste('a sessão conferida com sucesso volta a ser conhecida', () => {
  // O cache guarda a marca por no máximo seis horas, e pode descartá-la antes.
  // A conferência que dá certo a renova. Mutação que derruba: tirar
  // `lembrarSessao_` de `tokenValido_`.
  const a = montar();
  const token = sessao(a);
  a.cache.dados.delete(a.api.SESSAO_CONHECIDA_PREFIXO + token);

  igual(painel(a, 'painelEstatisticas', token, {}).ok, true, 'abaixo do teto, a propriedade decide');
  marcarNaHora(a, 'sessao_faltas_', a.api.SESSAO_TETO_FALTAS_HORA);
  igual(painel(a, 'painelEstatisticas', token, {}).ok, true, 'a sessão conferida não voltou a ser conhecida');
});

teste('o cache NUNCA valida sessão: a que saiu cai na hora, mesmo conhecida e sob ataque', () => {
  // Mutação que derruba: `tokenValido_` aceitando a sessão só porque o cache a
  // conhece, sem ler a propriedade.
  const a = montar();
  const token = sessao(a);
  igual(login(a, 'sair', { token: token }).ok, true);
  igual(a.propriedades.has('sess_' + token), false, 'sair não apagou a sessão');

  marcarNaHora(a, 'sessao_faltas_', 1000);
  // O pior caso: o cache ainda lembra a sessão que acabou de sair.
  a.cache.servico.getScriptCache().put(a.api.SESSAO_CONHECIDA_PREFIXO + token, '1', 600);
  igual(painel(a, 'painelEstatisticas', token, {}).erro, a.api.RECUSA_SESSAO);
});

teste('sair com token inventado não grava propriedade, e o comprido demais nem é lido', () => {
  // Mutação que derruba: `sair_` apagando sem conferir; ou tirar o teto de
  // tamanho de `tokenValido_`.
  const a = montar();
  igual(login(a, 'sair', { token: 'inventado' }).ok, true);
  igual(usos(a, 'delete').length + usos(a, 'set').length, 0, 'sair com token inventado gravou');

  igual(painel(a, 'listarAlunos', 'a'.repeat(5000), {}).erro, a.api.RECUSA_SESSAO);
  igual(a.usosDePropriedade, [], 'o token comprido demais chegou às propriedades');
});

teste('acima do teto, sair apaga às cegas a sessão que o cache esqueceu', () => {
  // Sem isto, a sessão de quem saiu durante um ataque voltaria a valer na
  // virada da hora. Mutação que derruba: tirar o ramo às cegas de `sair_`.
  const a = montar();
  const token = sessao(a);
  a.cache.dados.delete(a.api.SESSAO_CONHECIDA_PREFIXO + token);
  marcarNaHora(a, 'sessao_faltas_', a.api.SESSAO_TETO_FALTAS_HORA);

  igual(login(a, 'sair', { token: token }).ok, true);
  igual(a.propriedades.has('sess_' + token), false, 'sair acima do teto não derrubou a sessão');
});

teste('um robô mandando sair em laço acima do teto grava no máximo o teto de saídas às cegas', () => {
  // O preço escrito em `sair_`: passado também esse teto, sair não apaga.
  // Mutação que derruba: apagar às cegas sem o teto próprio.
  const a = montar();
  marcarNaHora(a, 'sessao_faltas_', a.api.SESSAO_TETO_FALTAS_HORA);

  let apagou = 0;
  for (let i = 0; i < a.api.SESSAO_TETO_FALTAS_HORA + 20; i++) {
    igual(login(a, 'sair', { token: ('0000000' + i).slice(-8) + 'f'.repeat(24) }).ok, true);
    apagou += usos(a, 'delete').length;
  }
  igual(apagou, a.api.SESSAO_TETO_FALTAS_HORA, 'gravações de sair às cegas numa hora');
});

teste('link inventado: abaixo do teto a falta conta; passado o teto, a recusa repetida não lê — e o link pedido entra', () => {
  // Mutação que derruba: tirar `linkBarradoPeloTeto_` de `entrarComLink_`; não
  // contar a falta; ou `enviarLink_` sem `lembrarLink_`.
  const a = montar();
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');
  const inventado = 'a'.repeat(64);

  igual(login(a, 'entrarComLink', { token: inventado }).ok, false);
  igual(lidasComo(a, 'link_'), 1, 'abaixo do teto, a falta lê a propriedade');
  igual(a.api.lerContagemDaHora_('link_faltas_'), 1, 'e conta');

  marcarNaHora(a, 'link_faltas_', a.api.LINK_TETO_FALTAS_HORA);
  igual(login(a, 'entrarComLink', { token: inventado }).ok, false, 'a primeira recusa');
  verdadeiro(acoesDoLog(a.falso).indexOf('LIMITE_LINK') !== -1, 'o ataque não deixou marca na trilha');

  igual(login(a, 'entrarComLink', { token: inventado }).ok, false, 'a recusa repetida');
  igual(a.usosDePropriedade, [], 'a recusa repetida, passado o teto, mexeu em propriedade');
  igual(a.falso.requisicoes.length, 0, 'e foi ao banco');

  igual(login(a, 'pedirLinkDeAcesso', { email: 'coordenacao@exemplo.com' }).ok, true);
  const r = login(a, 'entrarComLink', { token: tokenDoEmail(a) });
  igual(r.ok, true, 'o link pedido durante o ataque foi recusado: ' + r.erro);
});

teste('cache fora do ar: sessão e link conferem lendo a propriedade, como antes', () => {
  const a = montar({ semCache: true });
  a.api.gravarConfig_('admin_emails', 'coordenacao@exemplo.com');

  const token = sessao(a);
  igual(painel(a, 'painelEstatisticas', token, {}).ok, true);
  igual(painel(a, 'painelEstatisticas', 'f'.repeat(32), {}).erro, a.api.RECUSA_SESSAO);

  // O PEDIDO de link fecha sem cache, de propósito (o teste "sem CacheService a
  // porta FECHA", acima). O que se prova aqui é o outro lado: o link que já
  // saiu continua entrando, porque o clique lê a propriedade como antes.
  a.api.enviarLink_('coordenacao@exemplo.com');
  igual(login(a, 'entrarComLink', { token: tokenDoEmail(a) }).ok, true);
});

grupo('o gatilho de aquecimento — bater na porta sem comer a cota do dia');

teste('o endereço que o gatilho chama é a rota que o doGet atende', () => {
  // As duas pontas moram no mesmo arquivo, e é justamente por isso que podiam
  // divergir em silêncio: um gatilho pedindo `?api=pong` receberia "Rota
  // desconhecida", aqueceria a instância do mesmo jeito e pareceria certo para
  // sempre. Aqui a URL montada pelo gatilho é entregue ao doGet.
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');

  const url = a.api.urlDeAquecimento_();
  igual(url, 'https://script.google.com/macros/s/AAA/exec?api=ping');

  const parametros = {};
  url.split('?')[1].split('&').forEach((par) => {
    const [chave, valor] = par.split('=');
    parametros[chave] = valor;
  });

  igual(corpoDe(get(a, parametros)).ok, true, 'a URL do gatilho cai na rota de ping');
  igual(a.falso.requisicoes.length, 0);
});

teste('descobrir o endereço sozinho não custa leitura nenhuma', () => {
  // É o motivo de a derivação vir ANTES da chave de configuração: 288 pings por
  // dia perguntando `url_exec` ao banco seriam 288 leituras para não descobrir
  // nada novo.
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');

  a.api.limparCacheConfig_();
  zerar(a);
  a.api.urlDeAquecimento_();

  igual(a.falso.requisicoes.length, 0);
});

teste('endereço /dev não serve, e a chave url_exec assume', () => {
  // O /dev é a implantação de cabeça e só responde a quem tem acesso de EDIÇÃO
  // ao script. O ping é anônimo: receberia a tela de login do Google, com código
  // 200, e não acordaria nada. Aceitá-lo seria o pior dos mundos — um gatilho
  // rodando 288 vezes por dia, sem erro nenhum, sem efeito nenhum.
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/dev');

  igual(a.api.urlDeAquecimento_(), '', 'sem a chave, o gatilho prefere não bater a bater errado');

  a.api.gravarConfig_('url_exec', 'https://script.google.com/macros/s/BBB/exec');
  a.api.limparCacheConfig_();

  igual(a.api.urlDeAquecimento_(), 'https://script.google.com/macros/s/BBB/exec?api=ping');
});

teste('o endereço de domínio (/a/macros/…) também não serve', () => {
  // Em conta do Google Workspace a derivação pode vir nesta forma, que pede
  // sessão do domínio. Mesma armadilha do /dev, e mesma recusa.
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/a/macros/unicesusc.edu.br/s/AAA/exec');

  igual(a.api.urlDeAquecimento_(), '');
});

teste('sem endereço nenhum, o gatilho não bate em ninguém e não estoura', () => {
  const a = montar();
  scriptAppComGatilhos(a, null);
  const chamadas = interceptarPing(a, () => respostaDeMentira(200, '{"ok":true}'));

  a.api.aquecerWebApp_();

  igual(chamadas.length, 0);
  verdadeiro(a.registros.erros.length > 0, 'o console diz o que houve');
});

teste('o ping que falha não estoura, não é retentado e não escreve na trilha', () => {
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  const chamadas = interceptarPing(a, () => { throw new Error('tempo esgotado'); });

  a.api.aquecerWebApp_();

  // Uma tentativa. Retentar dentro da mesma execução dobraria as duas cotas para
  // cobrir, no pior caso, os cinco minutos até o próximo ping.
  igual(chamadas.length, 1);

  // A trilha é da coordenação. 288 linhas por dia de "acordei" — ou de "não
  // consegui acordar" — a enterrariam embaixo do batimento de um mecanismo
  // interno, e ainda pagariam escrita no Firestore por isso.
  igual(acoesDoLog(a.falso), []);
  igual(a.falso.requisicoes.length, 0, 'nem escrita, nem leitura');
  verdadeiro(a.registros.erros.length > 0, 'a falha vai para o console, que é o Stackdriver');
});

teste('implantação ainda não republicada aquece igual, e não vira alarme', () => {
  // O caso real de quem envia o código e esquece de publicar uma versão nova: o
  // /exec continua servindo a implantação anterior, que responde "Rota
  // desconhecida: ping". A instância acorda do mesmo jeito — o Apps Script
  // carrega o projeto inteiro ANTES de descobrir que não conhece a rota —, e um
  // alarme a cada cinco minutos por um problema que não existe é um alarme que
  // se aprende a ignorar até o dia em que ele estiver certo.
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  interceptarPing(a, () => respostaDeMentira(200, '{"ok":false,"erro":"Rota desconhecida: ping"}'));

  a.api.aquecerWebApp_();

  igual(a.registros.erros, [], 'quem respondeu foi o sistema, e é isso que o gatilho quer');
});

teste('o instalador avisa da versão velha, porque ali tem alguém olhando', () => {
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  interceptarPing(a, () => respostaDeMentira(200, '{"ok":false,"erro":"Rota desconhecida: ping"}'));

  a.api.instalarGatilhoAquecimento_();

  verdadeiro(a.registros.logger.some((l) => l.indexOf('não conhece a rota de ping') !== -1),
    'o instalador é o único lugar em que essa diferença interessa a alguém');
});

teste('tela de login com código 200 conta como falha, e não como sucesso', () => {
  // É a falha que não parece falha: o endereço responde, responde 200, e o que
  // volta é HTML do Google em vez do sistema. Sem esta conferência o gatilho
  // ficaria eternamente "funcionando" sem aquecer coisa nenhuma.
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  interceptarPing(a, () => respostaDeMentira(200, '<html><body>Faça login</body></html>'));

  a.api.aquecerWebApp_();

  verdadeiro(a.registros.erros.length > 0, 'a página de login foi reconhecida como fracasso');
});

teste('o ping que dá certo não escreve em lugar nenhum', () => {
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  const chamadas = interceptarPing(a, () => respostaDeMentira(200, '{"ok":true}'));

  a.api.aquecerWebApp_();

  igual(chamadas.length, 1);
  igual(chamadas[0].url, 'https://script.google.com/macros/s/AAA/exec?api=ping');
  igual(acoesDoLog(a.falso), []);
  igual(a.falso.requisicoes.length, 0);
  igual(a.registros.erros, []);
});

teste('instalar duas vezes não deixa dois gatilhos', () => {
  // Gatilho duplicado é invisível até alguém abrir a tela de acionadores: o
  // sintoma seria o dobro da cota consumida pelo mesmo efeito.
  const a = montar();
  const instalados = scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  interceptarPing(a, () => respostaDeMentira(200, '{"ok":true}'));

  a.api.instalarGatilhoAquecimento_();
  a.api.instalarGatilhoAquecimento_();

  igual(instalados.length, 1);
  igual(instalados[0].getHandlerFunction(), 'aquecerWebApp');
});

teste('reinstalar não leva junto o gatilho da reconciliação', () => {
  // Ele roda de madrugada e é trabalho de verdade. Uma limpeza que apagasse
  // "todos os acionadores" mataria a reconciliação diária sem dizer nada.
  const a = montar();
  const instalados = scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  interceptarPing(a, () => respostaDeMentira(200, '{"ok":true}'));

  instalados.push({ minutos: 0, getHandlerFunction: () => 'reconciliarAutomatico' });
  a.api.instalarGatilhoAquecimento_();

  igual(instalados.map((g) => g.getHandlerFunction()).sort(),
    ['aquecerWebApp', 'reconciliarAutomatico']);
});

teste('o intervalo é de cinco minutos, e a conta da cota fecha', () => {
  const a = montar();
  const instalados = scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  interceptarPing(a, () => respostaDeMentira(200, '{"ok":true}'));

  a.api.instalarGatilhoAquecimento_();
  igual(instalados[0].minutos, a.api.AQUECIMENTO_MINUTOS);
  igual(a.api.AQUECIMENTO_MINUTOS, 5);

  const execucoesPorDia = (24 * 60) / a.api.AQUECIMENTO_MINUTOS;
  igual(execucoesPorDia, 288);

  // As duas cotas do plano gratuito, e é este teste que impede alguém de baixar
  // o intervalo para 1 minuto sem enxergar o preço:
  //   90 min/dia de execução de gatilho, somando TODOS os acionadores do projeto
  //   (a reconciliação de madrugada sai do mesmo bolso);
  //   20 mil UrlFetchApp/dia, e toda leitura do Firestore neste projeto é uma.
  const minutosPorDia = (execucoesPorDia * 3) / 60;
  verdadeiro(minutosPorDia < 90 / 4,
    'o aquecimento comeria ' + Math.round(minutosPorDia) + ' dos 90 min/dia de gatilho');
  verdadeiro(execucoesPorDia < 20000 * 0.02,
    'o aquecimento comeria ' + execucoesPorDia + ' das 20 mil chamadas de saída do dia');
});

teste('o instalador bate na porta uma vez, para alguém ver que funcionou', () => {
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  const chamadas = interceptarPing(a, () => respostaDeMentira(200, '{"ok":true}'));

  a.api.instalarGatilhoAquecimento_();

  igual(chamadas.length, 1, 'é a única hora em que alguém está olhando o resultado');
  igual(chamadas[0].url, 'https://script.google.com/macros/s/AAA/exec?api=ping');
});

teste('sem endereço, o instalador instala assim mesmo e diz onde consertar', () => {
  // O gatilho tem de existir: com `url_exec` preenchida pelo painel, ele passa a
  // funcionar sozinho, sem ninguém voltar ao editor.
  const a = montar();
  const instalados = scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/dev');
  const chamadas = interceptarPing(a, () => respostaDeMentira(200, '{"ok":true}'));

  a.api.instalarGatilhoAquecimento_();

  igual(instalados.length, 1);
  igual(chamadas.length, 0, 'não bate no /dev nem para testar');
  verdadeiro(a.registros.logger.some((l) => l.indexOf('url_exec') !== -1),
    'o log precisa dizer qual chave preencher');
});

process.exit(resultado());
