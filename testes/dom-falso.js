/**
 * dom-falso.js — o navegador falso onde `docs/assets/app.js` roda de verdade.
 *
 * Por que isso existe: os testes do site que já havia leem o app.js como TEXTO
 * (`testes/api.js`, o contrato do `text/plain`). Isso prova contrato — que o
 * cabeçalho continua sendo o que o `doPost` espera —, mas não prova
 * COMPORTAMENTO: nenhuma busca de texto sabe dizer se voltar para a lista pede
 * os projetos de novo, que foi exatamente o defeito relatado três vezes.
 *
 * Aqui o app.js é carregado num contexto do Node com `document`, `window`,
 * `fetch` e `localStorage` falsos, e os testes NAVEGAM: clicam num cartão,
 * voltam, preenchem o formulário, enviam. O que se afirma é o que a tela ficou
 * mostrando e o que saiu pela rede.
 *
 * O que ele NÃO é: um navegador. Não há layout, CSS, foco de verdade nem
 * serialização nativa de formulário. Os elementos vêm do `docs/index.html` de
 * verdade — cada `id` do arquivo vira um elemento —, então `mostrar('x')` de um
 * id que não existe no HTML estoura aqui, como estouraria na tela.
 *
 * Este arquivo não roda testes. Ele é carregado por `site.js`, que roda.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PASTA_SITE = path.join(__dirname, '..', 'docs');

// ------------------------------------------------------------ Elementos

function criarClassList(el) {
  function lista() {
    return el.className ? String(el.className).split(/\s+/).filter(Boolean) : [];
  }
  function escrever(nomes) {
    el.className = nomes.join(' ');
  }
  const api = {
    contains: (nome) => lista().indexOf(nome) !== -1,
    add: (nome) => {
      const atual = lista();
      if (atual.indexOf(nome) === -1) escrever(atual.concat([nome]));
    },
    remove: (nome) => escrever(lista().filter((n) => n !== nome)),
    toggle: (nome, forca) => {
      const querTer = forca === undefined ? !api.contains(nome) : !!forca;
      if (querTer) api.add(nome);
      else api.remove(nome);
    }
  };
  return api;
}

function criarElemento(tag, atributos) {
  const attrs = Object.assign({}, atributos || {});

  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    atributos: attrs,
    filhos: [],
    pai: null,
    ouvintes: {},
    textContent: '',
    value: '',
    type: attrs.type || '',
    href: attrs.href || '',
    checked: Object.prototype.hasOwnProperty.call(attrs, 'checked'),
    disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'),
    required: false,
    style: {},
    focos: 0,
    rolagens: 0
  };

  el.id = attrs.id || '';
  el.className = attrs.class || '';
  el.classList = criarClassList(el);

  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v) => { html = String(v); el.filhos = []; }
  });

  el.appendChild = (filho) => {
    filho.pai = el;
    el.filhos.push(filho);
    return filho;
  };
  el.append = function () {
    Array.prototype.forEach.call(arguments, el.appendChild);
  };
  el.setAttribute = (nome, valor) => { attrs[nome] = String(valor); };
  el.getAttribute = (nome) => (Object.prototype.hasOwnProperty.call(attrs, nome) ? attrs[nome] : null);
  el.addEventListener = (tipo, fn) => {
    el.ouvintes[tipo] = (el.ouvintes[tipo] || []).concat([fn]);
  };
  el.focus = () => { el.focos++; };
  el.scrollIntoView = () => { el.rolagens++; };
  el.reset = () => {
    // `reset` devolve os campos ao estado declarado no HTML — inclusive as caixas
    // que nascem `checked`, que é o que mantém os consentimentos marcados depois
    // de uma inscrição.
    percorrer(el, (filho) => {
      if (filho.tagName === 'INPUT' || filho.tagName === 'SELECT' || filho.tagName === 'TEXTAREA') {
        filho.value = '';
        filho.checked = Object.prototype.hasOwnProperty.call(filho.atributos, 'checked');
      }
    });
  };

  /** Dispara um evento como o navegador dispararia, para quem estiver ouvindo. */
  el.disparar = (tipo, evento) => {
    const ev = evento || {};
    if (!ev.preventDefault) ev.preventDefault = () => { ev.padraoImpedido = true; };
    if (!ev.target) ev.target = el;
    (el.ouvintes[tipo] || []).forEach((fn) => fn(ev));
    return ev;
  };

  return el;
}

function percorrer(el, fn) {
  el.filhos.forEach((filho) => { fn(filho); percorrer(filho, fn); });
}

function semTags(html) {
  return String(html).replace(/<[^>]*>/g, ' ');
}

/** Todo o texto que o elemento e os descendentes dele mostram. */
function textoDe(el) {
  if (!el) return '';
  const meu = el.textContent || semTags(el.innerHTML);
  const dosFilhos = el.filhos.map(textoDe).join(' ');
  return (meu + ' ' + dosFilhos).replace(/\s+/g, ' ').trim();
}

/** O primeiro descendente clicável cujo texto contém o trecho. */
function acharClicavel(el, trecho) {
  let achado = null;
  const candidatos = [];
  percorrer(el, (filho) => candidatos.push(filho));

  candidatos.forEach((c) => {
    if (achado) return;
    if (!(c.ouvintes.click || []).length) return;
    if (trecho && textoDe(c).toLowerCase().indexOf(trecho.toLowerCase()) === -1) return;
    achado = c;
  });
  return achado;
}

// ------------------------------------------------------------ O documento

/**
 * Monta um elemento para cada `id` do index.html de verdade.
 *
 * A leitura é grosseira de propósito — regex, não parser: o que importa é que
 * exista um elemento para cada id que o app.js procura, com os atributos que o
 * HTML declara (`checked`, `disabled`, `class`, `type`).
 */
function lerElementosDoHtml(html) {
  const porId = {};
  const regex = /<([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g;
  let m;

  while ((m = regex.exec(html)) !== null) {
    const tag = m[1];
    const bruto = m[2] || '';
    const atributos = {};
    const attr = /([\w-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = attr.exec(bruto)) !== null) atributos[a[1]] = a[2] === undefined ? '' : a[2];

    if (!atributos.id) continue;
    porId[atributos.id] = criarElemento(tag, atributos);
  }
  return porId;
}

/**
 * As âncoras do menu do topo — as mesmas que `ligarMenuTopo` procura com
 * `.topo nav a[href^="#"]`.
 *
 * Só as de DENTRO do `<nav>`: o link da marca também mora no cabeçalho e aponta
 * para `#`, mas ele chama `voltarParaLista` pelo `onclick` e não passa por aqui.
 */
function lerMenuDoTopo(html) {
  const cabecalho = /<header class="topo"[\s\S]*?<\/header>/.exec(html);
  if (!cabecalho) return [];

  const nav = /<nav\b[\s\S]*?<\/nav>/.exec(cabecalho[0]);
  if (!nav) return [];

  const links = [];
  const regex = /<a\s+href="(#[^"]*)"([^>]*)>/g;
  let m;
  while ((m = regex.exec(nav[0])) !== null) {
    links.push(criarElemento('a', { href: m[1] }));
  }
  return links;
}

// ------------------------------------------------------------ Armazenamento

function criarArmazenamento(inicial, estourar) {
  const dados = Object.assign({}, inicial || {});
  return {
    dados,
    getItem: (chave) => {
      if (estourar) throw new Error('armazenamento bloqueado neste navegador');
      return Object.prototype.hasOwnProperty.call(dados, chave) ? dados[chave] : null;
    },
    setItem: (chave, valor) => {
      if (estourar) throw new Error('armazenamento bloqueado neste navegador');
      dados[chave] = String(valor);
    },
    removeItem: (chave) => { delete dados[chave]; }
  };
}

// ------------------------------------------------------------ A cena

const PROJETOS_PADRAO = [
  {
    id: 'p1', codigo: 'ARTE', nome: 'Arte Digital Floripa', descricao: 'Oficinas de arte digital.',
    // `descricao_formulario` só existe no p1, e o p2 fica sem de propósito: é o
    // par que prova as duas metades do cartão de confirmação — o que mostra as
    // orientações e o que fica só com o nome, sem parecer quebrado.
    descricao_formulario: 'Preencha os dados para participar. O Prof. Gilberto Martini '
      + '(coordenador) entrará em contato na próxima semana.\n'
      + 'O primeiro encontro acontecerá em 21/08/2026 às 19:00h, na sala 225.',
    professor: 'Prof. Exemplo', banner: '', local: 'Bloco B, sala 12', horario: 'Quartas, 19h',
    primeiro_encontro: '2026-08-19', vagas: 60, inscritos: 10, restantes: 50,
    situacao: 'ABERTO', validar_matricula: true, ativo: true, inscricoes_abertas: true, ordem: 1
  },
  {
    id: 'p2', codigo: 'CIDADES', nome: 'R+ Cidades', descricao: 'Requalificação urbana.',
    professor: 'Profa. Ana', banner: '', local: '', horario: '', primeiro_encontro: '',
    vagas: 60, inscritos: 59, restantes: 1,
    situacao: 'ABERTO', validar_matricula: true, ativo: true, inscricoes_abertas: true, ordem: 2
  }
];

function clonar(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Abre o site num navegador falso e devolve a cena — a tela, a rede e os
 * atalhos de navegação que os testes usam.
 */
function abrirSite(opcoes) {
  const cfg = opcoes || {};
  const html = fs.readFileSync(path.join(PASTA_SITE, 'index.html'), 'utf8');
  const codigo = fs.readFileSync(path.join(PASTA_SITE, 'assets', 'app.js'), 'utf8');

  const porId = lerElementosDoHtml(html);
  const menu = lerMenuDoTopo(html);

  const cena = {
    projetos: cfg.projetos ? clonar(cfg.projetos) : clonar(PROJETOS_PADRAO),
    // Respostas que o teste pode trocar no meio do caminho.
    respostaConfig: cfg.respostaConfig || {
      ok: true,
      dados: {
        cursosFases: ['ADS - 1a fase', 'Direito - 3a fase'],
        textoLgpd: 'Concordo com o tratamento dos meus dados.',
        textoDeclaracao: 'Declaro que desejo participar.',
        textoImagem: 'Autorizo o uso da minha imagem e voz.',
        textoEsgotado: 'Inscrições esgotadas.',
        exigirMatricula: true
      }
    },
    respostaMatricula: cfg.respostaMatricula || {
      ok: true, valida: true, validaProjeto: true, existe: true, listaDisponivel: true, bloqueia: true
    },
    respostaEnvio: cfg.respostaEnvio || {
      ok: true, duplicada: false, mensagem: 'Inscrição registrada com sucesso.', protocolo: 'PROTO-123'
    },
    // Liga/desliga a falha da rota de projetos, para provar que falha não apaga
    // a lista que está na tela.
    projetosFalham: false,

    /**
     * Quanto o servidor falso DEMORA para responder, em milissegundos do
     * relógio virtual (ver `agendar`).
     *
     * O formato é `{ trecho: [ms, ms, ...] }`, e a fila é consumida uma
     * requisição por vez — `{ 'api=projetos': [Infinity, 0] }` é "a primeira
     * trava e a repetição responde na hora", que é exatamente a forma do que se
     * mediu na produção. Sem entrada na fila, a resposta é imediata, que é como
     * este falso sempre respondeu.
     *
     * O trecho é procurado em `MÉTODO url` — então `'POST'` casa com o envio da
     * inscrição e `'api=projetos'` com a leitura da lista, sem os dois se
     * confundirem no mesmo `/exec`.
     *
     * `Infinity` é a requisição PENDURADA: a que só termina se alguém a abortar.
     * É o segundo salto do Google travado, e é o único jeito de provar que o
     * tempo-limite existe — sem ela, uma leitura sem limite nenhum passa no
     * teste, porque o falso responde antes de o relógio andar.
     *
     * `{ corpo: ms }` trava a OUTRA metade: os cabeçalhos chegam e a leitura do
     * corpo é que fica pendurada.
     */
    demoras: cfg.demoras || {},
    // O site não usa `confirm`, e é decisão (ver as caixas de aceite em
    // index.html). O falso registra as chamadas para o teste poder afirmar que
    // continuam sendo nenhuma.
    confirmacoes: [],
    pedidos: [],
    historico: []
  };

  function corpoDaResposta(url, opcoesFetch) {
    const metodo = (opcoesFetch && opcoesFetch.method) || 'GET';
    if (metodo === 'POST') return cena.respostaEnvio;
    if (url.indexOf('api=config') !== -1) return cena.respostaConfig;
    if (url.indexOf('api=matricula') !== -1) return cena.respostaMatricula;
    if (url.indexOf('api=projetos') !== -1) {
      if (cena.projetosFalham) return null;
      return { ok: true, projetos: clonar(cena.projetos) };
    }
    return { ok: false, erro: 'rota desconhecida no falso: ' + url };
  }

  /** Quanto esta requisição demora — ver `cena.demoras`. */
  function demoraDe(pedido) {
    const assinatura = pedido.metodo + ' ' + pedido.url;
    const chave = Object.keys(cena.demoras).filter((c) => assinatura.indexOf(c) !== -1)[0];
    const fila = chave === undefined ? null : cena.demoras[chave];
    return (fila && fila.length) ? fila.shift() : 0;
  }

  function fetchFalso(url, opcoesFetch) {
    const opcoes = opcoesFetch || {};
    const pedido = {
      url: String(url),
      metodo: opcoes.method || 'GET',
      opcoes,
      // O `signal` que o cliente mandou — `undefined` quando ele não mandou
      // nenhum, que é o que o teste da ESCRITA afirma.
      sinal: opcoes.signal,
      abortada: false,
      // Em que instante do relógio virtual ela foi abortada. É o número que
      // prova o TAMANHO do limite, e não só a existência dele.
      abortadaEm: null
    };
    cena.pedidos.push(pedido);

    const corpo = corpoDaResposta(pedido.url, opcoesFetch);
    // `null` é a requisição que morre — o caminho que `buscar` trata com
    // retentativa e que nunca pode virar "nenhum projeto disponível".
    if (corpo === null) return Promise.reject(new Error('rede fora do ar'));

    /**
     * Uma etapa da requisição que leva TEMPO — e que o aborto interrompe.
     *
     * É o que o navegador faz: enquanto a etapa não termina, a promessa fica
     * pendurada; se o `AbortController` dispara, ela REJEITA com um erro chamado
     * AbortError e o que estava a caminho é jogado fora. O trabalho do servidor
     * continua do lado de lá — o falso não tem como encenar isso, e o comentário
     * de `buscar` conta por que importa.
     */
    function etapa(ms, valor) {
      if (!ms) return Promise.resolve(valor);
      return new Promise((resolver, rejeitar) => {
        const chegada = ms === Infinity ? null : agendar(() => resolver(valor), ms);
        if (!pedido.sinal) return;
        pedido.sinal.addEventListener('abort', () => {
          pedido.abortada = true;
          pedido.abortadaEm = relogio.agora;
          if (chegada !== null) desagendar(chegada);
          const erro = new Error('The user aborted a request.');
          erro.name = 'AbortError';
          rejeitar(erro);
        });
      });
    }

    // São DUAS esperas, e não uma: os cabeçalhos chegam e o corpo ainda está
    // sendo lido. `{ corpo: ms }` na fila de demoras trava a segunda — é a
    // travada que passaria despercebida se o tempo-limite fosse desarmado assim
    // que a resposta chega, antes do `json()`.
    const demora = demoraDe(pedido);
    const noCorpo = demora !== null && typeof demora === 'object';

    const resposta = {
      ok: true,
      status: 200,
      json: () => etapa(noCorpo ? demora.corpo : 0, corpo)
    };
    return etapa(noCorpo ? 0 : demora, resposta);
  }

  const armazenamento = criarArmazenamento(cfg.armazenamento, cfg.armazenamentoQuebrado);

  const janela = {
    CESUTECH_CONFIG: Object.assign({
      endpoint: 'https://script.google.com/macros/s/FALSO/exec',
      contato: { email: 'cesutech@exemplo.edu.br', instituicao: 'UNICESUSC' }
    }, cfg.config || {}),
    location: { search: cfg.urlInicial || '', pathname: '/' },
    localStorage: armazenamento,
    ouvintes: {},
    addEventListener: (tipo, fn) => {
      janela.ouvintes[tipo] = (janela.ouvintes[tipo] || []).concat([fn]);
    },
    removeEventListener: (tipo, fn) => {
      janela.ouvintes[tipo] = (janela.ouvintes[tipo] || []).filter((f) => f !== fn);
    },
    scrollTo: () => {},
    confirm: (texto) => {
      cena.confirmacoes.push(texto);
      return true;
    }
  };

  const historico = {
    pushState: (_estado, _titulo, url) => {
      const alvo = String(url);
      const corte = alvo.indexOf('?');
      janela.location.pathname = corte === -1 ? alvo : alvo.slice(0, corte);
      janela.location.search = corte === -1 ? '' : alvo.slice(corte);
      cena.historico.push(alvo);
    }
  };

  const documento = {
    ouvintes: {},
    getElementById: (id) => porId[id] || null,
    createElement: (tag) => criarElemento(tag, {}),
    addEventListener: (tipo, fn) => {
      documento.ouvintes[tipo] = (documento.ouvintes[tipo] || []).concat([fn]);
    },
    querySelectorAll: (seletor) => {
      if (seletor.indexOf('.topo nav a') === 0) return menu;
      return [];
    },
    querySelector: (seletor) => {
      // Só o seletor que o app.js usa: o primeiro campo inválido do formulário.
      if (seletor.indexOf('aria-invalid') === -1) return null;
      const ids = Object.keys(porId);
      for (let i = 0; i < ids.length; i++) {
        if (porId[ids[i]].getAttribute('aria-invalid') === 'true') return porId[ids[i]];
      }
      return null;
    }
  };

  /**
   * O RELÓGIO VIRTUAL, e por que ele substituiu o "dispara no próximo tique".
   *
   * Os prazos deste código são de segundos — 10s de tempo-limite de leitura, 2s
   * e 4s entre as tentativas — e um teste não pode gastá-los. Antes todo
   * `setTimeout` virava `setTimeout(fn, 0)`: rápido, e cego para a única coisa
   * que importa aqui, que é a ORDEM entre o prazo e a resposta. Com todos os
   * prazos valendo zero, um limite de 10s e um de 10ms são indistinguíveis, e um
   * teste de tempo-limite passaria sem provar nada.
   *
   * Aqui o tempo é um número que só anda quando alguém o faz andar, e é o
   * `assentar` que o faz: ele dispara um temporizador por vez, sempre o mais
   * próximo, drenando as promessas entre um e outro. "A resposta chega em 9,25s"
   * e "o limite é de 10s" viram dois números comparáveis — e é a comparação
   * deles que os testes afirmam.
   */
  const relogio = { agora: 0 };
  const temporizadores = [];
  let proximoId = 1;

  function agendar(fn, ms) {
    const id = proximoId++;
    temporizadores.push({ id, fn, quando: relogio.agora + (Number(ms) || 0) });
    return id;
  }

  function desagendar(id) {
    const i = temporizadores.map((t) => t.id).indexOf(id);
    if (i !== -1) temporizadores.splice(i, 1);
  }

  /** O primeiro a vencer. Empate fica com o que foi agendado antes. */
  function maisProximo() {
    return temporizadores.reduce(
      (menor, t) => (menor === null || t.quando < menor.quando ? t : menor), null);
  }

  function dispararProximo() {
    const t = maisProximo();
    if (!t) return false;
    relogio.agora = Math.max(relogio.agora, t.quando);
    desagendar(t.id);
    t.fn();
    return true;
  }

  // O intervalo das fases da espera do envio continua no tempo REAL: ele não
  // decide nada, só reescreve um texto, e prendê-lo ao relógio virtual faria o
  // teste ter de fazer o tempo andar para ver uma mensagem que o navegador
  // mostra sozinho. `unref` evita que um intervalo esquecido segure o processo.
  function repetir(fn, _ms) {
    const t = setInterval(fn, 5);
    if (t.unref) t.unref();
    return t;
  }

  const contexto = {
    window: janela,
    document: documento,
    history: historico,
    localStorage: armazenamento,
    fetch: fetchFalso,
    setTimeout: agendar,
    setInterval: repetir,
    clearInterval: (t) => clearInterval(t),
    clearTimeout: desagendar,
    // O contexto do `vm` nasce só com o JavaScript da linguagem: `fetch`,
    // `URLSearchParams` e `AbortController` são do navegador, e é por isso que
    // os três precisam ser entregues aqui. O `AbortController` é o do Node, de
    // verdade e não um remendo — o que o app.js faz com ele (abortar, e o
    // `fetch` falso ouvir o `abort`) é exatamente o que o navegador faz.
    AbortController,
    URLSearchParams,
    console
  };

  vm.createContext(contexto);
  vm.runInContext(codigo, contexto, { filename: 'docs/assets/app.js' });

  // ---------------------------------------------------------- Atalhos

  cena.window = janela;
  cena.armazenamento = armazenamento;
  cena.el = (id) => porId[id];
  cena.texto = (id) => textoDe(porId[id]);
  cena.visivel = (id) => !!porId[id] && !porId[id].classList.contains('oculto');
  cena.menu = menu;

  cena.pedidosDe = (trecho) => cena.pedidos.filter((p) => p.url.indexOf(trecho) !== -1);
  cena.pedidosPost = () => cena.pedidos.filter((p) => p.metodo === 'POST');
  cena.zerarPedidos = () => { cena.pedidos.length = 0; };

  /**
   * Deixa as promessas em voo terminarem — e o relógio andar até onde precisar.
   *
   * A ordem é a do navegador: as promessas prontas correm primeiro, e só quando
   * não sobra nenhuma é que o tempo avança até o próximo temporizador. Um por
   * vez, porque disparar dois de uma vez inverteria coisas que na tela acontecem
   * em ordem (o tempo-limite de 10s e a resposta de 12s, por exemplo).
   *
   * Sai depois de três rodadas sem nada a fazer. Requisição PENDURADA sem
   * tempo-limite nenhum simplesmente nunca termina — o teste não trava, ele
   * falha na afirmação seguinte, que é o desfecho certo para essa mutação.
   */
  cena.assentar = async () => {
    let paradas = 0;
    for (let volta = 0; volta < 400; volta++) {
      await new Promise((r) => setImmediate(r));
      if (dispararProximo()) { paradas = 0; continue; }
      if (++paradas >= 3) return;
    }
  };

  /** Onde o relógio virtual está, em milissegundos desde a abertura da página. */
  cena.relogio = () => relogio.agora;

  /**
   * Faz o tempo andar, disparando o que vencer no caminho.
   *
   * Serve para a pergunta que o `assentar` não responde: o que NÃO acontece.
   * Uma escrita pendurada não agenda nada, então o relógio não anda sozinho —
   * e é preciso empurrá-lo um minuto adiante para afirmar que, mesmo assim,
   * ninguém a abortou.
   */
  cena.avancarRelogio = async (ms) => {
    const alvo = relogio.agora + (Number(ms) || 0);
    while (maisProximo() && maisProximo().quando <= alvo) {
      dispararProximo();
      await new Promise((r) => setImmediate(r));
    }
    relogio.agora = Math.max(relogio.agora, alvo);
    await cena.assentar();
  };

  cena.carregar = () => {
    (documento.ouvintes.DOMContentLoaded || []).forEach((fn) => fn({}));
  };

  cena.cartoes = () => porId['grade-projetos'].filhos;
  cena.entrarNoProjeto = (indice) => {
    const cartao = cena.cartoes()[indice];
    if (!cartao) throw new Error('não há cartão no índice ' + indice);
    acharClicavel(cartao).disparar('click');
  };
  cena.voltarParaLista = () => janela.voltarParaLista();
  cena.clicarNoMenu = (indice) => menu[indice || 0].disparar('click');
  cena.voltarDoNavegador = (busca) => {
    janela.location.search = busca === undefined ? '' : busca;
    (janela.ouvintes.popstate || []).forEach((fn) => fn({}));
  };

  cena.clicarNoCartaoDeVagas = (trecho) => {
    const alvo = acharClicavel(porId['cartao-vagas'], trecho);
    if (!alvo) throw new Error('não achei "' + trecho + '" no cartão de vagas');
    alvo.disparar('click');
  };

  cena.preencherFormulario = (dados) => {
    const valores = Object.assign({
      matricula: '9110001',
      nome: 'Maria de Souza',
      curso_fase: 'ADS - 1a fase',
      email: 'maria@exemplo.com',
      whatsapp: '48999998888'
    }, dados || {});
    Object.keys(valores).forEach((id) => { porId[id].value = valores[id]; });
  };

  /** Marca (ou desmarca) uma das caixas de aceite, como o aluno faria. */
  cena.marcar = (id, valor) => {
    porId[id].checked = valor === undefined ? true : !!valor;
  };

  // O `reset` do navegador devolve cada campo ao estado DECLARADO no HTML. Aqui
  // os elementos são planos — não há árvore de formulário —, então o reset varre
  // todos os campos conhecidos. É o que mantém honesto o teste de que os aceites
  // voltam ao padrão do HTML depois de uma inscrição.
  porId.formulario.reset = () => {
    Object.keys(porId).forEach((id) => {
      const el = porId[id];
      if (['INPUT', 'SELECT', 'TEXTAREA'].indexOf(el.tagName) === -1) return;
      el.value = '';
      el.checked = Object.prototype.hasOwnProperty.call(el.atributos, 'checked');
    });
  };

  cena.sairDoCampoMatricula = () => porId.matricula.disparar('blur');
  cena.enviarFormulario = () => porId.formulario.disparar('submit');
  cena.corpoDoEnvio = () => {
    const post = cena.pedidosPost();
    if (!post.length) throw new Error('nenhum POST foi enviado');
    return JSON.parse(post[post.length - 1].opcoes.body);
  };

  return cena;
}

/** Abre o site e espera a carga inicial terminar. */
async function siteCarregado(opcoes) {
  const cena = abrirSite(opcoes);
  cena.carregar();
  await cena.assentar();
  return cena;
}

module.exports = {
  abrirSite, siteCarregado, textoDe, acharClicavel, PROJETOS_PADRAO
};
