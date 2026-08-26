/**
 * apoio.js — o Apps Script falso e o relator de testes, sem tocar no Google.
 *
 * Por que isso existe: os arquivos `.gs` só rodam de verdade depois que alguém
 * cria o projeto no Firebase, autoriza os escopos e implanta o web app. São
 * passos de console, que só o Jonathan pode dar. A lógica que roda em cima
 * disso — conversores, montagem de consulta, retentativa, cache de
 * configuração, id de log — não precisa esperar por nada: é JavaScript puro e dá
 * para provar aqui.
 *
 * O `UrlFetchApp` falso responde a API do Firestore em memória. Ele não é um
 * Firestore: é o suficiente para exercitar os caminhos que importam, inclusive
 * os de erro, que num banco de verdade são difíceis de provocar de propósito.
 *
 * Este arquivo não roda testes. Ele é carregado por `repo.js` e por
 * `config-log.js`, que rodam.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');

const PROJETO = 'projeto-de-teste';
// Nome de RECURSO: o que vai no corpo do `:commit`, sem host.
const RECURSO = 'projects/' + PROJETO + '/databases/(default)/documents';

// URL: o que o UrlFetchApp recebe, com host. As duas se parecem e NÃO são
// intercambiáveis — trocá-las fez o Firestore recusar o lote inteiro com
// INVALID_ARGUMENT, e nenhum teste pegava.
const RAIZ = 'https://firestore.googleapis.com/v1/' + RECURSO;

// ------------------------------------------------------------ Relator

let passou = 0;
let falhou = 0;
const falhas = [];

function teste(nome, fn) {
  try {
    fn();
    passou++;
    console.log('  \x1b[32m✓\x1b[0m ' + nome);
  } catch (e) {
    falhou++;
    falhas.push({ nome, erro: e.message });
    console.log('  \x1b[31m✗\x1b[0m ' + nome + '\n      ' + e.message);
  }
}

function grupo(nome) {
  console.log('\n\x1b[1m' + nome + '\x1b[0m');
}

function igual(recebido, esperado, mensagem) {
  const a = JSON.stringify(recebido);
  const b = JSON.stringify(esperado);
  if (a !== b) {
    throw new Error((mensagem ? mensagem + ': ' : '') + 'esperava ' + b + ', recebi ' + a);
  }
}

function verdadeiro(v, mensagem) {
  if (!v) throw new Error(mensagem || 'esperava verdadeiro, recebi ' + JSON.stringify(v));
}

function lancou(fn, trecho) {
  try {
    fn();
  } catch (e) {
    if (trecho && e.message.indexOf(trecho) === -1) {
      throw new Error('erro não menciona "' + trecho + '": ' + e.message);
    }
    return e;
  }
  throw new Error('esperava um erro, e não veio nenhum');
}

/** Imprime o placar e devolve o código de saída do processo. */
function resultado() {
  console.log('\n' + '─'.repeat(60));
  if (falhou === 0) {
    console.log('\x1b[32m' + passou + ' teste(s) passaram.\x1b[0m');
  } else {
    console.log('\x1b[32m' + passou + ' passaram\x1b[0m, \x1b[31m' + falhou + ' falharam\x1b[0m');
    falhas.forEach((f) => console.log('  - ' + f.nome + ': ' + f.erro));
  }
  console.log('─'.repeat(60) + '\n');
  return falhou === 0 ? 0 : 1;
}

// ------------------------------------------------------------ Firestore falso

/**
 * Guarda documentos como o Firestore guarda: um mapa de `colecao/id` para o
 * objeto `fields`. Devolve as respostas no formato do REST, inclusive os corpos
 * de erro {error:{code,status,message}} que o cliente precisa saber ler.
 */
function criarFirestoreFalso() {
  const documentos = new Map();
  const requisicoes = [];
  const idas = [];
  const forcadas = [];

  function resposta(codigo, corpo) {
    const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
    return { getResponseCode: () => codigo, getContentText: () => texto };
  }

  function erro(codigo, status, mensagem) {
    return resposta(codigo, { error: { code: codigo, status, message: mensagem } });
  }

  function nomeDe(colecao, id) {
    return RAIZ + '/' + colecao + '/' + id;
  }

  function documentoDe(chave) {
    const [colecao, id] = chave.split('/');
    return { name: nomeDe(colecao, id), fields: documentos.get(chave) };
  }

  /** Valor pelo qual a consulta ordena. `__name__` ordena pelo caminho. */
  function chaveDeOrdem(chave, fieldPath) {
    if (fieldPath === '__name__') return documentoDe(chave).name;
    const campo = (documentos.get(chave) || {})[fieldPath];
    return campo && campo.stringValue !== undefined ? campo.stringValue : '';
  }

  function valorSimples(v) {
    if (!v) return '';
    if (v.referenceValue !== undefined) return v.referenceValue;
    if (v.stringValue !== undefined) return v.stringValue;
    return '';
  }

  function selecionar(consulta) {
    const colecao = consulta.from[0].collectionId;
    let chaves = Array.from(documentos.keys())
      .filter((k) => k.slice(0, colecao.length + 1) === colecao + '/');

    if (consulta.where && consulta.where.fieldFilter) {
      const f = consulta.where.fieldFilter;
      chaves = chaves.filter((k) => {
        const campo = (documentos.get(k) || {})[f.field.fieldPath];
        return campo && campo.stringValue === f.value.stringValue;
      });
    }

    const ordem = (consulta.orderBy && consulta.orderBy[0]) || null;
    if (ordem) {
      const campo = ordem.field.fieldPath;
      const sinal = ordem.direction === 'DESCENDING' ? -1 : 1;
      chaves.sort((a, b) => {
        const x = chaveDeOrdem(a, campo);
        const y = chaveDeOrdem(b, campo);
        return x < y ? -sinal : (x > y ? sinal : 0);
      });

      if (consulta.startAt) {
        const alvo = valorSimples(consulta.startAt.values[0]);
        chaves = chaves.filter((k) => {
          const v = chaveDeOrdem(k, campo);
          return sinal === 1 ? v > alvo : v < alvo;
        });
      }
    }

    if (consulta.limit) chaves = chaves.slice(0, consulta.limit);
    return chaves;
  }

  function tratar(metodo, resto, corpo) {
    const [caminho, query] = resto.split('?');
    const parametros = new URLSearchParams(query || '');
    const partes = caminho.split('/').filter(Boolean);

    // Métodos de coleção/banco: `:runQuery`, `:commit`, etc.
    if (caminho === ':runQuery') {
      const chaves = selecionar(corpo.structuredQuery);
      // A primeira entrada não traz documento — o Firestore de verdade manda
      // sinais de progresso no meio do stream, e o cliente tem de ignorá-los.
      const linhas = [{ readTime: '2026-08-05T00:00:00Z' }];
      chaves.forEach((k) => linhas.push({ document: documentoDe(k) }));
      return resposta(200, linhas);
    }

    if (caminho === ':runAggregationQuery') {
      const consulta = corpo.structuredAggregationQuery.structuredQuery;
      const total = selecionar(consulta).length;
      // integerValue vem como TEXTO — é o comportamento que o conversor trata.
      return resposta(200, [{
        result: { aggregateFields: { total: { integerValue: String(total) } } },
        readTime: '2026-08-05T00:00:00Z'
      }]);
    }

    if (caminho === ':commit') {
      if (corpo.writes.length > 500) {
        return erro(400, 'INVALID_ARGUMENT', 'maximum 500 writes allowed per request');
      }
      // `update` grava; `delete` apaga. As duas formas vivem no mesmo `:commit`,
      // e é assim que `escreverEmLote` e `excluirEmLote` (02_Repo.gs) usam.
      //
      // A EXIGÊNCIA DO PREFIXO NÃO É ZELO: o Firestore de verdade recusa o lote
      // inteiro com 400 INVALID_ARGUMENT — 'Document name "https://..." lacks
      // "projects" at index 0' — quando o `name` vem como URL em vez de nome de
      // recurso. Este falso aceitava as duas formas porque extraía o id com
      // `split('/documents/')`, que funciona com host ou sem; por isso os 491
      // testes passavam e a reconciliação morria no primeiro clique. Conferir o
      // prefixo é o que transforma este falso em rede de segurança para essa
      // classe de erro.
      for (const w of corpo.writes) {
        const nome = w.update ? w.update.name : w.delete;
        if (String(nome).indexOf('projects/') !== 0) {
          return erro(400, 'INVALID_ARGUMENT',
            'Document name "' + nome + '" lacks "projects" at index 0');
        }
        const partesNome = nome.split('/documents/')[1].split('/');
        const chave = partesNome[0] + '/' + partesNome[1];
        if (w.update) documentos.set(chave, w.update.fields);
        else documentos.delete(chave);
      }
      return resposta(200, { writeResults: corpo.writes.map(() => ({ updateTime: '2026-08-05T00:00:00Z' })) });
    }

    if (caminho === ':listCollectionIds') {
      const ids = [];
      documentos.forEach((_v, k) => {
        const colecao = k.split('/')[0];
        if (ids.indexOf(colecao) === -1) ids.push(colecao);
      });
      return resposta(200, { collectionIds: ids });
    }

    const colecao = partes[0];
    const id = decodeURIComponent(partes[1] || '');

    if (metodo === 'POST') {
      const desejado = parametros.get('documentId') || 'auto_' + (documentos.size + 1);
      const chave = colecao + '/' + desejado;
      if (documentos.has(chave)) {
        return erro(409, 'ALREADY_EXISTS', 'Document already exists: ' + nomeDe(colecao, desejado));
      }
      documentos.set(chave, corpo.fields || {});
      return resposta(200, documentoDe(chave));
    }

    if (metodo === 'GET') {
      const chave = colecao + '/' + id;
      if (!documentos.has(chave)) {
        return erro(404, 'NOT_FOUND', 'Document not found: ' + nomeDe(colecao, id));
      }
      return resposta(200, documentoDe(chave));
    }

    if (metodo === 'PATCH') {
      const chave = colecao + '/' + id;
      const atual = documentos.get(chave) || {};
      const mascara = parametros.getAll('updateMask.fieldPaths');
      // Sem máscara o PATCH substitui o documento — reproduzido de propósito,
      // porque é a armadilha que a updateMask evita.
      const novo = mascara.length ? Object.assign({}, atual) : {};
      const enviados = (corpo && corpo.fields) || {};
      (mascara.length ? mascara : Object.keys(enviados)).forEach((c) => {
        if (enviados[c] !== undefined) novo[c] = enviados[c];
      });
      documentos.set(chave, novo);
      return resposta(200, documentoDe(chave));
    }

    if (metodo === 'DELETE') {
      documentos.delete(colecao + '/' + id);
      return resposta(200, {});
    }

    return erro(405, 'INVALID_ARGUMENT', 'método não suportado no falso: ' + metodo);
  }

  /** Uma requisição, atendida. É o corpo do `fetch` e de cada item do `fetchAll`. */
  function atender(url, opcoes) {
    const metodo = String(opcoes.method).toUpperCase();
    const corpo = opcoes.payload ? JSON.parse(opcoes.payload) : null;
    requisicoes.push({ metodo, url, corpo, headers: opcoes.headers });

    if (!opcoes.muteHttpExceptions) {
      throw new Error('o cliente precisa mandar muteHttpExceptions para ler o corpo do erro');
    }
    if (forcadas.length) return forcadas.shift();

    const casou = /\/documents(.*)$/.exec(url);
    return tratar(metodo, casou ? casou[1] : '', corpo);
  }

  return {
    documentos,
    requisicoes,

    /**
     * As IDAS ao UrlFetchApp, uma entrada por chamada, com o tamanho do lote.
     *
     * `requisicoes` conta requisições HTTP e é o que mede o ORÇAMENTO DE
     * LEITURA — quantos documentos o Firestore cobra. Este conta as esperas em
     * fila indiana, que é outra coisa e é o que se mede em SEGUNDOS: seis
     * agregações num `fetchAll` são seis requisições cobradas e UMA ida.
     *
     * Sem os dois números separados não dá para provar a otimização sem
     * afrouxar os testes de cota, que continuam contando a mesma coisa de antes.
     */
    idas,

    /** Empilha uma resposta de erro para a próxima chamada. Testa retentativa. */
    forcar(codigo, status, mensagem) {
      forcadas.push(erro(codigo, status, mensagem || status));
    },

    UrlFetchApp: {
      fetch(url, opcoes) {
        idas.push(1);
        return atender(url, opcoes);
      },

      /**
       * `fetchAll` recebe as requisições com a URL DENTRO de cada uma, e devolve
       * as respostas na mesma ordem. A ordem é o contrato inteiro: quem chama
       * casa resposta com pedido pelo índice, e não por identificador nenhum.
       */
      fetchAll(lote) {
        const pedidos = lote || [];
        idas.push(pedidos.length);
        return pedidos.map((pedido) => {
          if (!pedido || !pedido.url) {
            throw new Error('cada requisição de fetchAll precisa trazer a própria url');
          }
          return atender(pedido.url, pedido);
        });
      }
    }
  };
}

// ------------------------------------------------------------ Relógio

/**
 * Um `Date` com a hora sob controle do teste.
 *
 * O id do log carrega o instante da gravação; provar que ele é ordenável exige
 * mandar o tempo andar, e não torcer para o processo demorar o suficiente entre
 * duas chamadas.
 */
function criarRelogio(inicioMs) {
  let agora = inicioMs;

  class DataControlada extends Date {
    constructor(...args) {
      if (args.length === 0) super(agora);
      else super(...args);
    }
    static now() {
      return agora;
    }
  }

  return {
    Date: DataControlada,
    avancar(ms) { agora += ms; },
    agora() { return agora; }
  };
}

/**
 * `Utilities.formatDate` do jeito que os `.gs` a usam.
 *
 * Fuso fixo em -03:00 para America/Sao_Paulo: o Brasil não tem horário de verão
 * desde 2019, e um teste não é lugar de carregar base de fusos.
 */
function formatarData(data, fuso, formato) {
  const deslocamentoMin = fuso === 'UTC' ? 0 : -180;
  const d = new Date(data.getTime() + deslocamentoMin * 60000);
  const pad = (n, largura) => String(n).padStart(largura, '0');

  const partes = {
    yyyy: String(d.getUTCFullYear()),
    MM: pad(d.getUTCMonth() + 1, 2),
    dd: pad(d.getUTCDate(), 2),
    HH: pad(d.getUTCHours(), 2),
    mm: pad(d.getUTCMinutes(), 2),
    ss: pad(d.getUTCSeconds(), 2),
    SSS: pad(d.getUTCMilliseconds(), 3)
  };
  return formato.replace(/yyyy|SSS|MM|dd|HH|mm|ss/g, (t) => partes[t]);
}

// ------------------------------------------------------------ Ambiente

/**
 * Carrega os `.gs` pedidos num sandbox com os serviços do Apps Script falsos.
 *
 * opcoes:
 *   arquivos    quais `.gs` carregar, na ordem (padrão: só a camada de dados)
 *   projeto     ID do projeto; `null` remove a propriedade FIRESTORE_PROJETO
 *   banco       valor de FIRESTORE_BANCO
 *   usuario     e-mail de `Session.getActiveUser()`; `null` faz Session lançar
 *   usuarioEfetivo  e-mail de `Session.getEffectiveUser()`; `null` faz lançar.
 *                   Ausente, segue `usuario` — que é o caso comum. Ele é uma
 *                   opção à parte porque os dois DIVERGEM justamente na
 *                   implantação de hoje: web app anônimo tem `getActiveUser`
 *                   vazio e `getEffectiveUser` respondendo a conta que implantou,
 *                   e é dessa diferença que `liberarMeuAcesso()` vive.
 *   relogio     relógio de `criarRelogio`, quando o teste precisa controlar a hora
 */
function criarAmbiente(opcoes) {
  opcoes = opcoes || {};
  const falso = criarFirestoreFalso();
  const propriedades = new Map();
  const cache = new Map();
  const esperas = [];
  const registros = { erros: [], logger: [] };

  // O CacheService falso precisa saber a hora para expirar. `criarRelogio`
  // devolve milissegundos; sem relógio injetado, usa o de verdade — o
  // suficiente para quem não testa expiração.
  const agoraMs = () => (opcoes.relogio ? opcoes.relogio.agora() : new Date().getTime());

  if (opcoes.projeto !== null) propriedades.set('FIRESTORE_PROJETO', opcoes.projeto || PROJETO);
  if (opcoes.banco) propriedades.set('FIRESTORE_BANCO', opcoes.banco);

  const contexto = {
    console: {
      log: console.log,
      error: (m) => { registros.erros.push(String(m)); }
    },
    JSON, Math, Date: (opcoes.relogio && opcoes.relogio.Date) || Date,
    String, Number, Object, Array, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    UrlFetchApp: falso.UrlFetchApp,
    ScriptApp: { getOAuthToken: () => 'token-de-mentira' },
    Logger: { log: (m) => { registros.logger.push(String(m)); } },
    Session: {
      getActiveUser: () => ({
        getEmail: () => {
          if (opcoes.usuario === null) throw new Error('sem permissão para ver o usuário');
          return opcoes.usuario === undefined ? 'gestao@exemplo.com' : opcoes.usuario;
        }
      }),
      getEffectiveUser: () => ({
        getEmail: () => {
          const efetivo = opcoes.usuarioEfetivo === undefined ? opcoes.usuario : opcoes.usuarioEfetivo;
          if (efetivo === null) throw new Error('sem permissão para ver o usuário');
          return efetivo === undefined ? 'gestao@exemplo.com' : efetivo;
        }
      })
    },
    Utilities: {
      // Recuo registrado em vez de dormido: o teste mede a espera sem gastá-la.
      sleep: (ms) => esperas.push(ms),
      getUuid: () => crypto.randomUUID(),
      formatDate: formatarData,
      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF-8' },
      computeDigest: (_algoritmo, texto) => Array.from(crypto.createHash('md5').update(String(texto), 'utf8').digest())
        .map((b) => (b > 127 ? b - 256 : b))
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (propriedades.has(k) ? propriedades.get(k) : null),
        setProperty: (k, v) => { propriedades.set(k, String(v)); },
        deleteProperty: (k) => { propriedades.delete(k); },
        getProperties: () => Object.fromEntries(propriedades)
      })
    },
    // CacheService com EXPIRAÇÃO de verdade, presa ao relógio falso.
    //
    // Um cache que nunca expira provaria metade do que interessa: mostraria que
    // a segunda chamada é engolida, e esconderia que a janela reabre. Como o
    // relógio já é injetável, `expirar` guarda o instante e a leitura confere —
    // então `relogio.avancar()` faz a janela virar, e o teste consegue exercitar
    // os dois lados.
    //
    // Nasceu porque o falso NÃO tinha CacheService: o `catch` de
    // `registrarRecusa` engolia a ausência e caía no registro direto. Os 213
    // testes passavam sem exercitar uma linha do agrupamento.
    CacheService: {
      getScriptCache: () => ({
        get: (k) => {
          const item = cache.get(k);
          if (!item) return null;
          if (agoraMs() >= item.expira) { cache.delete(k); return null; }
          return item.valor;
        },
        put: (k, v, segundos) => {
          cache.set(k, {
            valor: String(v),
            expira: agoraMs() + (Number(segundos) || 600) * 1000
          });
        },
        remove: (k) => { cache.delete(k); }
      })
    }
  };
  contexto.globalThis = contexto;

  const sandbox = vm.createContext(contexto);
  const arquivos = opcoes.arquivos || ['02_Repo.gs'];
  arquivos.forEach((arquivo) => {
    vm.runInContext(fs.readFileSync(path.join(PASTA_GS, arquivo), 'utf8'), sandbox, { filename: arquivo });
  });

  return { api: sandbox, falso, esperas, propriedades, registros };
}

/** Última requisição que o cliente mandou. */
function ultima(falso) {
  return falso.requisicoes[falso.requisicoes.length - 1];
}

module.exports = {
  RECURSO,
  PROJETO, RAIZ,
  teste, grupo, igual, verdadeiro, lancou, resultado,
  criarFirestoreFalso, criarRelogio, criarAmbiente, ultima
};
