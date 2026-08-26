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
 *      não a página HTML nem a página de erro do Apps Script;
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
 * HtmlService, CacheService, LockService — são falsos deste arquivo, injetados
 * no sandbox depois do `criarAmbiente` (o objeto devolvido É o global do vm).
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
//   - `gravarConfig('admin_emails', ...)` chama `esquecerAllowlistDoLink_`, que
//     nasce lá. Sem o arquivo, QUALQUER teste que mexa na allowlist estoura com
//     ReferenceError — e estourava;
//   - `modoDeAcesso` pergunta a `linkDeAcessoDisponivel_`, também de lá. Sem o
//     arquivo, a rota de login respondia a falha genérica, e o teste dela media o
//     caminho de erro achando que media o de sucesso.
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '02b_Drive.gs', '03_Config.gs',
  '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs', '05b_FormatoAcademico.gs',
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
 * HtmlService: registra qual arquivo foi pedido e o que o template recebeu.
 * O `dadosIniciais` é lido no `evaluate`, que é quando o Apps Script o leria.
 */
function htmlServiceFalso(paginas, includes) {
  return {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
    createTemplateFromFile(nome) {
      const registro = { arquivo: nome, dadosIniciais: null, titulo: '', metas: [], xframe: '' };
      paginas.push(registro);

      return {
        evaluate() {
          registro.dadosIniciais = this.dadosIniciais;
          const saida = {
            setTitle(t) { registro.titulo = t; return saida; },
            addMetaTag(n, v) { registro.metas.push([n, v]); return saida; },
            setXFrameOptionsMode(m) { registro.xframe = m; return saida; },
            getContent() { return '<html>' + nome + '</html>'; }
          };
          return saida;
        }
      };
    },
    createHtmlOutputFromFile(nome) {
      includes.push(nome);
      return { getContent: () => '<!-- ' + nome + ' -->' };
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
 * MailApp que guarda em vez de enviar, com a cota sob o controle do teste.
 *
 * Entrou junto com 07b_LinkPorEmail.gs: sem ele, `linkDeAcessoDisponivel_` cai
 * no `catch` de "escopo não concedido" e `modoDeAcesso` responde que a porta de
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

/** LockService mínimo: `reservarVaga` precisa dele, e o doPost passa por lá. */
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
    // `liberarMeuAcesso()` a preenchem, porque só ela roda no editor.
    usuarioEfetivo: opcoes.usuarioEfetivo,
    relogio: opcoes.relogio
  });

  const paginas = [];
  const includes = [];
  const cache = cacheServiceFalso(opcoes.cache);
  const correio = mailAppFalso(opcoes.cota);

  ambiente.api.ContentService = contentServiceFalso();
  ambiente.api.HtmlService = htmlServiceFalso(paginas, includes);
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

  ambiente.paginas = paginas;
  ambiente.includes = includes;
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
 * Descarta o cache de configuração e zera o contador de requisições ANTES de
 * chamar a rota — é o que torna a medição comparável com a produção, onde cada
 * requisição HTTP é uma execução nova, com o escopo global zerado.
 */
function requisicao(ambiente, fn) {
  ambiente.api.limparCacheConfig();
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
  api.inserir('projetos', Object.assign({
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
    const chave = api.normalizarMatricula(m);
    api.inserir('matriculados', Object.assign({
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

  const gravou = a.cache.eventos.filter((e) => e.tipo === 'put');
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
  a.api.gravarConfig('texto_imagem', '');
  a.cache.expirar();

  igual(corpoDe(get(a, { api: 'config' })).dados.textoImagem, '');
});

// ------------------------------------------------------------ ?api=projetos

grupo('doGet ?api=projetos — os cartões com a situação e a ocupação');

teste('devolve só os projetos ativos, com vagas, inscritos e situação', () => {
  const a = montar();
  criarProjeto(a.api, 'p1', { nome: 'R+ Cidades', vagas: '2', ordem: '1' });
  criarProjeto(a.api, 'p2', { nome: 'Robótica', vagas: '0', ordem: '2' });
  criarProjeto(a.api, 'p3', { nome: 'Escondido', ativo: 'NAO', ordem: '3' });
  a.api.inserir('inscricoes', { projeto_id: 'p1', matricula: 'A1' }, 'i1');

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
  a.api.inserir('inscricoes', { projeto_id: 'p1', matricula: 'A1' }, 'i1');

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
  // é o cache de execução de `config()` que responde a segunda pergunta.
  igual(a.falso.requisicoes.length, 4, 'nada além disso');
});

// Com a fila LIGADA a contagem passa a subtrair quem espera, e isso é uma
// agregação a mais POR PROJETO. É o preço da chave, e ele tem de ser visível
// aqui: o número de leituras da rota pública dobra na prática.
teste('com a fila de espera ligada, cada projeto custa uma agregação a mais', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  criarProjeto(a.api, 'p2');
  a.api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
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
  a.api.inserir('inscricoes', { projeto_id: 'p1', matricula: 'A1' }, 'i1');
  a.api.inserir('inscricoes', { projeto_id: 'p1', matricula: 'A2' }, 'i2');
  a.api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
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
  a.api.inserir('inscricoes', { projeto_id: 'p1', matricula: 'A1' }, 'i1');
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
    a.api.gravarConfig('contar_ocupacao_na_lista', caso[0]);
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
  // atrasado; quem decide a vaga é `reservarVaga`, que conta dentro do lock.
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
  a.api.gravarConfig('modo_validacao_matricula', 'AVISAR');

  igual(corpoDe(get(a, { api: 'matricula', m: '9999999', p: 'p1' })).bloqueia, false);
});

teste('projeto que não valida matrícula nem consulta a lista', () => {
  const a = montar();
  criarProjeto(a.api, 'p1', { validar_matricula: 'NAO' });
  matricular(a.api, ['9110001']);

  const r = corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' }));
  igual(r, { ok: true, valida: true, validaProjeto: false });
  igual(quantas(a.falso, LEITURA_MATRICULA), 0, 'a lista oficial não foi tocada');
});

teste('sem o parâmetro m, recusa por FORMATO sem ir ao banco', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');

  const r = corpoDe(get(a, { api: 'matricula', p: 'p1' }));
  igual(r, { ok: true, valida: false, existe: false, motivo: 'FORMATO', bloqueia: true });
  igual(a.falso.requisicoes.length, 0, 'nem uma requisição');
});

teste('matrícula curta ou longa demais recusa por FORMATO', () => {
  const a = montar();
  igual(corpoDe(get(a, { api: 'matricula', m: '12' })).motivo, 'FORMATO');
  igual(corpoDe(get(a, { api: 'matricula', m: '123456789012345678901' })).motivo, 'FORMATO');
  igual(a.falso.requisicoes.length, 0);
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
  get(a, { api: 'matricula', m: '9110001', p: 'p1' });
  igual(a.falso.requisicoes.length, 3, 'a segunda consulta custa o mesmo que a primeira');
});

// ------------------------------------------------------ teto de consultas

grupo('doGet ?api=matricula — o teto por hora');

teste('passado o teto, responde indisponivel e o site libera', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  matricular(a.api, ['9110001']);
  a.api.gravarConfig('limite_consultas_matricula_hora', '2');

  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).existe, true);
  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).existe, true);

  const terceira = corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' }));
  igual(terceira, { ok: true, valida: true, indisponivel: true });
});

teste('o teto registra UMA vez por janela, e não uma por requisição recusada', () => {
  const a = montar();
  criarProjeto(a.api, 'p1');
  a.api.gravarConfig('limite_consultas_matricula_hora', '0');

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
  a.api.gravarConfig('limite_consultas_matricula_hora', '1');

  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).existe, true);
  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).indisponivel, true);

  relogio.avancar(60 * 60 * 1000);
  igual(corpoDe(get(a, { api: 'matricula', m: '9110001', p: 'p1' })).existe, true);
});

// ------------------------------------------------------------ rotas e páginas

grupo('doGet — rota desconhecida e as duas páginas');

teste('?api=lixo responde JSON de erro, e não a página de cadastro', () => {
  const a = montar();
  const saida = get(a, { api: 'lixo' });

  igual(saida.getMimeType(), 'application/json');
  igual(corpoDe(saida).ok, false);
  verdadeiro(corpoDe(saida).erro.indexOf('lixo') !== -1);
  igual(a.paginas.length, 0, 'nenhuma página foi montada');
});

teste('rota desconhecida não devolve o parâmetro inteiro de volta', () => {
  const a = montar();
  const erro = corpoDe(get(a, { api: 'x'.repeat(500) })).erro;
  verdadeiro(erro.length < 100, 'o eco do parâmetro é cortado: ' + erro.length);
});

teste('sem parâmetro nenhum, serve o Cadastro com os dados iniciais', () => {
  const a = montar();
  get(a, {});

  igual(a.paginas.length, 1);
  igual(a.paginas[0].arquivo, 'Cadastro');
  igual(JSON.parse(a.paginas[0].dadosIniciais).aberto, true);
  igual(a.paginas[0].xframe, 'ALLOWALL', 'sem isso o iframe do Google Sites fica em branco');
  igual(a.paginas[0].metas, [['viewport', 'width=device-width, initial-scale=1']]);
});

teste('?p=admin serve o painel', () => {
  const a = montar();
  get(a, { p: 'admin' });

  igual(a.paginas[0].arquivo, 'Admin');
  igual(JSON.parse(a.paginas[0].dadosIniciais).app, a.api.APP.nome);
});

teste('abrir o painel custa ZERO leitura do Firestore', () => {
  const a = montar();
  get(a, { p: 'admin' });

  // É de propósito: com o banco fora do ar, a coordenação ainda precisa
  // conseguir abrir o painel para descobrir o que houve.
  igual(a.falso.requisicoes.length, 0);
});

teste('página desconhecida cai no Cadastro', () => {
  const a = montar();
  get(a, { p: 'inventada' });
  igual(a.paginas[0].arquivo, 'Cadastro');
});

teste('doGet sem evento nenhum não estoura', () => {
  const a = montar();
  requisicao(a, () => a.api.doGet());
  igual(a.paginas[0].arquivo, 'Cadastro');
});

teste('include devolve o conteúdo do arquivo pedido', () => {
  const a = montar();
  igual(a.api.include('Estilos'), '<!-- Estilos -->');
  igual(a.includes, ['Estilos']);
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
  // valor desceria até `submeterInscricao` como algo sem campo nenhum.
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

/** Uma sessão de verdade, criada como `autenticar` a cria. */
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
  a.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com');

  const deFora = painel(a, 'painelEstatisticas', sessao(a, 'estranho@exemplo.com'), {});
  igual(deFora.ok, true, 'a sessão vale enquanto o token vale — a allowlist é do login');
});

teste('função fora da lista branca é recusada, mesmo existindo no servidor', () => {
  const a = montar();
  const token = sessao(a);

  // As quatro existem, são chamáveis, e nenhuma delas tem `exigirAdmin`.
  // `gravarConfig` reescreveria a configuração inteira; `invalidarSessoes`
  // derrubaria todo mundo; `criarSessao_` FABRICARIA uma sessão para qualquer
  // e-mail. Um despacho por `this[nome]` entregaria as três.
  ['setup', 'gravarConfig', 'invalidarSessoes', 'criarSessao_', 'reservarVaga']
    .forEach((nome) => {
      igual(typeof a.api[nome], 'function', nome + ' devia existir para o teste valer');
      const r = painel(a, nome, token, {});
      igual(r.ok, false, nome + ' foi despachada e não devia');
      verdadeiro(r.erro.indexOf('Ação desconhecida') === 0, nome + ': ' + r.erro);
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
  // confere) e um token qualquer em `dados` (que o `exigirAdmin` lá dentro
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
  a.api.limparCacheConfig();
  igual(a.api.config('vagas_padrao'), '25');
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
  const execucoes = contarExecucoes(a, 'salvarProjeto');

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
  const execucoes = contarExecucoes(a, 'salvarProjeto');
  const semNome = { projeto: { vagas: 60 } };

  const primeira = painelComChave(a, 'salvarProjeto', token, semNome, 'kfalha12345678');
  const segunda = painelComChave(a, 'salvarProjeto', token, semNome, 'kfalha12345678');

  igual(primeira.ok, false, 'o servidor aceitou projeto sem nome');
  igual(execucoes.vezes, 2, 'A RECUSA FICOU GUARDADA: a segunda tentativa nem rodou');
  igual(segunda.ok, false);
  igual(a.cache.eventos.filter((e) => e.tipo === 'put').length, 0,
    'a recusa foi parar no cache');
});

teste('a chave vale para UMA ação só — a de outra não devolve esta resposta', () => {
  // Uma chave reaproveitada por engano em outra ação devolveria "removido com
  // sucesso" para uma remoção que nunca aconteceu. O nome da função entra na
  // chave do cache justamente para que o reaproveitamento não ache nada.
  const a = montar();
  criarProjeto(a.api, 'p1', {});
  const token = sessao(a);
  const execucoes = contarExecucoes(a, 'removerProjeto');

  painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'kmesma12345678');
  const removida = painelComChave(a, 'removerProjeto', token, { id: 'p1' }, 'kmesma12345678');

  igual(execucoes.vezes, 1, 'a remoção recebeu a resposta guardada de OUTRA ação');
  verdadeiro(removida.mensagem !== undefined || removida.ok === true,
    'a remoção não chegou a acontecer: ' + JSON.stringify(removida));
});

teste('chave nova é operação nova — e ela grava', () => {
  const a = montar();
  const token = sessao(a);
  const execucoes = contarExecucoes(a, 'salvarProjeto');

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
    const antes = a.cache.eventos.length;
    const r = painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, idem);
    igual(r.ok, true, 'a chave ' + JSON.stringify(idem) + ' derrubou a ação: ' + r.erro);
    igual(a.cache.eventos.length, antes,
      'a chave ' + JSON.stringify(idem) + ' chegou ao cache mesmo malformada');
  });
});

teste('a janela é de dez minutos, e depois dela a chave não vale mais', () => {
  // Não é um histórico de operações: é a janela em que "de novo" ainda quer dizer
  // "a mesma vez". Dez minutos cobrem com folga o caso real, que é a pessoa
  // reclicando em segundos.
  const a = montar();
  const token = sessao(a);
  const execucoes = contarExecucoes(a, 'salvarProjeto');

  painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'kjanela1234567');
  const put = a.cache.eventos.filter((e) => e.tipo === 'put')[0];
  igual(put.segundos, 600, 'a validade da chave mudou de tamanho');

  a.cache.expirar();
  painelComChave(a, 'salvarProjeto', token, PROJETO_NOVO, 'kjanela1234567');
  igual(execucoes.vezes, 2, 'a chave continuou valendo depois de a janela fechar');
});

teste('resposta grande demais não é guardada — a repetição volta a executar', () => {
  // `exportarCsv` devolve o CSV INTEIRO no corpo, e o item do CacheService tem
  // teto de 100 KB. Guardar menos é a degradação certa: exportar duas vezes gera
  // dois arquivos iguais e duas linhas na trilha, e nada que se pareça com dado
  // duplicado.
  const a = montar();
  a.api.guardarResposta_('idem_exportarCsv_kgrande123456',
    { ok: true, csv: 'a'.repeat(60000), linhas: 900 });

  igual(a.cache.eventos.filter((e) => e.tipo === 'put').length, 0,
    'a resposta gigante foi mandada ao cache assim mesmo');
  igual(a.api.respostaGuardada_('idem_exportarCsv_kgrande123456'), null);
});

teste('cache é otimização, nunca dependência: sem ele a rota executa igual', () => {
  const a = montar({ semCache: true });
  const token = sessao(a);
  const execucoes = contarExecucoes(a, 'salvarProjeto');

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
  igual(a.cache.eventos.length, 0, 'uma requisição sem token mexeu no cache');
  igual(a.falso.requisicoes.length, 0, 'e ainda gastou leitura do banco');
});

teste('nome fora da lista branca não guarda nada, mesmo com chave boa', () => {
  const a = montar();
  const r = painelComChave(a, 'criarSessao_', sessao(a), {}, 'klistabranca12');

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('Ação desconhecida') === 0, r.erro);
  igual(a.cache.eventos.length, 0, 'a rota tocou o cache antes de conferir a lista branca');
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
// saiu do sistema, e não há o que reescrever: `autenticar` não recebe mais
// argumento e não há segredo a errar. O que aqueles dois provavam e continua
// valendo está nos dois testes abaixo — o token de UMA rota abrindo a OUTRA, e a
// recusa de login sem token junto.

teste('o token que sai do login abre o painel — as duas rotas falam a mesma língua', () => {
  // O circuito de verdade, e só aqui: pedir o link, ler o token do e-mail e
  // entrar com ele. É o único login que roda inteiro dentro do servidor (o do
  // Google depende do navegador), e o que interessa a 08_Api.gs é que o token que
  // sai de `acao: 'login'` seja aceito por `acao: 'painel'`.
  const a = montar();
  a.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com');

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
  a.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com');

  // `autenticar` nesta implantação (`USER_DEPLOYING`, conta comum) nunca vê a
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

  igual(login(a, 'sessaoAtiva', { token: token }), { ok: true });
  igual(login(a, 'sair', { token: token }), { ok: true });
  igual(login(a, 'sessaoAtiva', { token: token }), { ok: false });
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
 * é o que torna `pedirLinkDeAcesso` uma rota anônima sem preço.
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
 * Cada `pedirLinkDeAcesso` entra pela rota, e `post` limpa o CONFIG_CACHE antes —
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
  a.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com');

  igual(pedirLink(a, 'coordenacao@exemplo.com').ok, true);
  igual(leiturasCobradas(a), 1, 'o primeiro pedido é o que paga: ele monta o cache');

  igual(pedirLink(a, 'coordenacao@exemplo.com').ok, true);
  igual(leiturasCobradas(a), 0,
    'o segundo pedido voltou ao Firestore — o cache da allowlist não está pegando');
});

teste('uma enxurrada de endereços inventados não custa uma leitura por pedido', () => {
  // O cenário que motivou o cache: um laço de `curl` com endereços que não estão
  // na lista. Cada um morre na conferência, e a conferência tem de ser de graça.
  const a = montar();
  a.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com');

  let leituras = 0;
  for (let i = 0; i < 20; i++) {
    igual(pedirLink(a, 'inventado' + i + '@exemplo.com').ok, true);
    leituras += leiturasCobradas(a);
  }

  igual(leituras, 1, 'a enxurrada foi ao banco ' + leituras + ' vezes');
  igual(destinatarios(a), [], 'e nenhum endereço de fora recebeu mensagem');
});

teste('incluirAdmin derruba o cache: quem entrou na lista recebe link no ato', () => {
  const a = montar();
  a.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com');

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
  a.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com, saindo@exemplo.com');

  // Esquenta o cache com a lista de DUAS pessoas, pedindo para a que fica.
  igual(pedirLink(a, 'coordenacao@exemplo.com').ok, true);

  igual(painel(a, 'removerAdmin', sessao(a), { email: 'saindo@exemplo.com' }).ok, true);

  igual(pedirLink(a, 'saindo@exemplo.com').ok, true, 'a frase única não muda nem aqui');
  igual(destinatarios(a), ['coordenacao@exemplo.com'],
    'o link foi para quem acabou de perder o acesso');
});

teste('o campo de texto da allowlist (regravarAllowlist_) também derruba o cache', () => {
  // Caminho diferente dos dois de cima: `salvarConfiguracao` com a chave
  // `admin_emails` reescreve a lista inteira. Ele não chama
  // `esquecerAllowlistDoLink_` — quem chama é `gravarConfig`, e é isso que
  // impede o quinto caminho de nascer esquecido.
  const a = montar();
  a.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com');

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
  a.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com');

  igual(pedirLink(a, 'coordenacao@exemplo.com').ok, true);

  a.api.liberarAcesso('socorro@exemplo.com');

  igual(pedirLink(a, 'socorro@exemplo.com').ok, true);
  igual(destinatarios(a), ['coordenacao@exemplo.com', 'socorro@exemplo.com']);
});

teste('sem CacheService a porta FECHA: mesma frase de sempre, e e-mail nenhum', () => {
  // Decisão deliberada de 07b_LinkPorEmail.gs, e o oposto do reflexo de cair na
  // leitura direta: sem cache, conferir a allowlist volta a custar uma leitura
  // por requisição anônima, e uma enxurrada gastaria a cota do formulário do
  // aluno para salvar a porta dos fundos.
  const bom = montar();
  bom.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com');
  const frase = pedirLink(bom, 'coordenacao@exemplo.com');
  igual(destinatarios(bom), ['coordenacao@exemplo.com'], 'o caminho normal precisa enviar');

  const semCache = montar({ cache: { quebrarServico: true } });
  semCache.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com');
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
 * reescrever `entrarComLink` inteiro. No dia em que ela virar despachável pela
 * API, ela deixa de ser saída de emergência e passa a ser porta dos fundos
 * anônima — daí o terceiro teste ser sobre 08_Api.gs, e não sobre 07b.
 */
grupo('liberarMeuAcesso — a saída que não passa pela internet');

teste('libera a conta que RODA o script, e a sessão abre o painel', () => {
  const a = montar({ usuarioEfetivo: 'dono@exemplo.com' });
  a.api.console = { log() {}, error() {} };

  const url = a.api.liberarMeuAcesso();
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

  a.api.liberarMeuAcesso();

  const tela = login(a, 'modoDeAcesso');
  igual(tela.allowlistVazia, false, 'o dia seguinte volta ao estado sem porta nenhuma');
  igual(a.api.config('admin_emails'), 'dono@exemplo.com');

  // E a lista reposta serve à porta remota no ato — o cache não guardou a vazia.
  igual(pedirLink(a, 'dono@exemplo.com').ok, true);
  igual(destinatarios(a), ['dono@exemplo.com']);
});

teste('sem e-mail efetivo ela ensina a saída, em vez de criar sessão anônima', () => {
  // `Session` sem permissão é o que acontece quando `userinfo.email` não foi
  // concedido. Cair em `liberarAcesso('')` daria um `throw` genérico; pior, um
  // dia daria uma sessão sem dono. A recusa aqui é explícita e diz o que fazer.
  const a = montar({ usuarioEfetivo: null });
  const erro = lancou(() => a.api.liberarMeuAcesso());

  verdadeiro(/userinfo\.email/.test(erro.message), erro.message);
  verdadeiro(/liberarAcesso\("/.test(erro.message), 'sem o caminho alternativo: ' + erro.message);
  igual(a.api.config('admin_emails'), '', 'nada foi gravado na lista');
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

  igual(a.api.config('admin_emails'), '', 'a allowlist foi mexida pela rota');
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
  const a = montar();
  const nomes = Object.keys(a.api.funcoesDoPainel_());

  verdadeiro(nomes.length >= 28, 'só ' + nomes.length + ' na lista: alguma sumiu?');
  nomes.forEach((n) => {
    igual(typeof a.api[n], 'function', n + ' está na lista branca e não existe no servidor');
  });
});

teste('toda função da lista branca começa por exigirAdmin', () => {
  // A lista branca diz "o navegador pode chamar"; o `exigirAdmin` diz "só com
  // token". Uma função despachável sem a guarda seria um endereço anônimo com
  // acesso ao cadastro — e o teste anterior, que só confere que a rota exige
  // token, continuaria verde, porque a rota exige.
  const a = montar();
  const textos = textoDosGs();
  const semGuarda = [];

  Object.keys(a.api.funcoesDoPainel_()).forEach((nome) => {
    let achou = false;
    Object.keys(textos).forEach((arquivo) => {
      const corpo = corpoDaFuncao(textos[arquivo], nome);
      if (corpo === null) return;
      if (/exigirAdmin\s*\(/.test(corpo)) achou = true;
    });
    if (!achou) semGuarda.push(nome);
  });

  igual(semGuarda, [], 'sem exigirAdmin: ' + semGuarda.join(', '));
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
  a.api.limparCacheConfig();
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
  a.api.limparCacheConfig();
  zerar(a);
  a.falso.forcar(403, 'PERMISSION_DENIED', 'Missing or insufficient permissions on projects/unicesusc-cesutech');

  const erro = corpoDe(a.api.doGet({ parameter: { api: 'config' } })).erro;
  igual(erro.indexOf('unicesusc'), -1, 'vazou o id do projeto');
  igual(erro.indexOf('PERMISSION_DENIED'), -1, 'vazou o status do Google');
  verdadeiro(a.registros.erros.length > 0, 'mas o original foi para o console');
});

teste('resposta com erro não é guardada no cache', () => {
  const a = montar();
  a.api.limparCacheConfig();
  zerar(a);
  a.falso.forcar(403, 'PERMISSION_DENIED', 'sem permissão');
  a.api.doGet({ parameter: { api: 'config' } });

  igual(a.cache.dados.size, 0, 'uma falha ficaria grudada por 30 segundos');
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
  const regex = /\bconfig\(\s*'([a-z_]+)'\s*,\s*'([^']*)'\s*\)/g;
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

  // '0000000' tem sete dígitos e passa no formato — o que ele NÃO faz é existir.
  // Antes do conserto ele caía no ramo de formato (porque a chave vira '0') e
  // saía sem `bloqueia`, com a mensagem permissiva. Agora é recusa por ausência.
  const zeros = corpoDe(get(a, { api: 'matricula', m: '0000000', p: 'p1' }));
  igual(zeros.valida, true, 'sete dígitos são formato plausível');
  igual(zeros.existe, false, 'mas não está na lista');
  igual(zeros.bloqueia, true, 'e por isso bloqueia');
});

teste('o tamanho é conferido no que foi DIGITADO, não na chave sem zeros', () => {
  // '0001' é matrícula de quatro dígitos legítima. Conferir o tamanho depois de
  // tirar o zero a transformaria em '1' e a reprovaria por formato.
  const a = montar();
  criarProjeto(a.api, 'p1', { validar_matricula: 'SIM' });
  matricular(a.api, ['0001']);

  const r = corpoDe(get(a, { api: 'matricula', m: '0001', p: 'p1' }));
  igual(r.valida, true, 'quatro dígitos digitados passam no formato');
  igual(r.existe, true, 'e a chave sem zeros acha o matriculado');
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
    a.api.limparCacheConfig();
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

teste('com o cache quente, as duas rotas de leitura custam zero', () => {
  const a = montar();
  ['p1', 'p2', 'p3', 'p4', 'p5'].forEach((id) => criarProjeto(a.api, id));
  matricular(a.api, ['9110001']);

  get(a, { api: 'config' });
  get(a, { api: 'projetos' });

  // O segundo aluno da mesma janela de 30 segundos.
  igual(get(a, { api: 'config' }) && a.falso.requisicoes.length, 0);
  igual(get(a, { api: 'projetos' }) && a.falso.requisicoes.length, 0);

  // Sobram as três da matrícula e as seis do POST: dez por aluno, contra trinta.
  get(a, { api: 'matricula', m: '9110001', p: 'p1' });
  igual(a.falso.requisicoes.length, 3);
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
  igual(a.paginas.length, 0, 'nenhuma página foi montada');
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

teste('não monta página, não mexe no cache e não passa pelas rotas caras', () => {
  const a = montar();
  const eventosAntes = a.cache.eventos.length;

  get(a, { api: 'ping' });

  igual(a.cache.eventos.length, eventosAntes, 'a rota de ping não fala com o cache');
  igual(a.paginas.length, 0);
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

  a.api.limparCacheConfig();
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

  a.api.gravarConfig('url_exec', 'https://script.google.com/macros/s/BBB/exec');
  a.api.limparCacheConfig();

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

  a.api.aquecerWebApp();

  igual(chamadas.length, 0);
  verdadeiro(a.registros.erros.length > 0, 'o console diz o que houve');
});

teste('o ping que falha não estoura, não é retentado e não escreve na trilha', () => {
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  const chamadas = interceptarPing(a, () => { throw new Error('tempo esgotado'); });

  a.api.aquecerWebApp();

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

  a.api.aquecerWebApp();

  igual(a.registros.erros, [], 'quem respondeu foi o sistema, e é isso que o gatilho quer');
});

teste('o instalador avisa da versão velha, porque ali tem alguém olhando', () => {
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  interceptarPing(a, () => respostaDeMentira(200, '{"ok":false,"erro":"Rota desconhecida: ping"}'));

  a.api.instalarGatilhoAquecimento();

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

  a.api.aquecerWebApp();

  verdadeiro(a.registros.erros.length > 0, 'a página de login foi reconhecida como fracasso');
});

teste('o ping que dá certo não escreve em lugar nenhum', () => {
  const a = montar();
  scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  const chamadas = interceptarPing(a, () => respostaDeMentira(200, '{"ok":true}'));

  a.api.aquecerWebApp();

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

  a.api.instalarGatilhoAquecimento();
  a.api.instalarGatilhoAquecimento();

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
  a.api.instalarGatilhoAquecimento();

  igual(instalados.map((g) => g.getHandlerFunction()).sort(),
    ['aquecerWebApp', 'reconciliarAutomatico']);
});

teste('o intervalo é de cinco minutos, e a conta da cota fecha', () => {
  const a = montar();
  const instalados = scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/exec');
  interceptarPing(a, () => respostaDeMentira(200, '{"ok":true}'));

  a.api.instalarGatilhoAquecimento();
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

  a.api.instalarGatilhoAquecimento();

  igual(chamadas.length, 1, 'é a única hora em que alguém está olhando o resultado');
  igual(chamadas[0].url, 'https://script.google.com/macros/s/AAA/exec?api=ping');
});

teste('sem endereço, o instalador instala assim mesmo e diz onde consertar', () => {
  // O gatilho tem de existir: com `url_exec` preenchida pelo painel, ele passa a
  // funcionar sozinho, sem ninguém voltar ao editor.
  const a = montar();
  const instalados = scriptAppComGatilhos(a, 'https://script.google.com/macros/s/AAA/dev');
  const chamadas = interceptarPing(a, () => respostaDeMentira(200, '{"ok":true}'));

  a.api.instalarGatilhoAquecimento();

  igual(instalados.length, 1);
  igual(chamadas.length, 0, 'não bate no /dev nem para testar');
  verdadeiro(a.registros.logger.some((l) => l.indexOf('url_exec') !== -1),
    'o log precisa dizer qual chave preencher');
});

process.exit(resultado());
