/**
 * dom-painel.js — o navegador falso onde o `<script>` do painel roda de verdade.
 *
 * Por que isso existe: até aqui TODO teste do painel era de TEXTO. Eles provam
 * contrato — que o nome da função bate dos dois lados, que as chaves do payload
 * são as que o servidor lê — e não provam CLIQUE. As duas fases anteriores
 * disseram isso em voz alta no que entregaram ("nada da aba nova foi executado
 * num navegador"), e o próprio repositório registra que o falso já escondeu seis
 * defeitos que só o clique real encontrou.
 *
 * Aqui o painel é carregado num contexto do Node com `document`, `window`,
 * `sessionStorage` e `fetch` falsos — e o `fetch` entrega a requisição ao
 * `doPost` DE VERDADE (08_Api.gs), no sandbox de `apoio.js`, contra o Firestore
 * falso. Ou seja: o teste clica em "Editar", digita na janela, clica em
 * "Salvar", e o caminho percorrido é o mesmo do navegador — envelope, rota,
 * lista branca, `exigirAdmin`, e `editarAluno` de 10_Painel.gs escrevendo no
 * banco falso.
 *
 * O QUE MUDOU EM 07/08, e é a razão de este arquivo ter sido reescrito: o painel
 * saiu do Apps Script (`?p=admin`) para o GitHub Pages (`docs/painel/`), e com
 * ele o transporte — onde havia `google.script.run` agora há um POST. O falso
 * antigo chamava `api[nome](args)` direto, o que pulava o `doPost` inteiro: a
 * lista branca, o carimbo do token e o formato do envelope não eram exercitados
 * por teste de clique nenhum. Agora são. Um nome fora da lista branca de
 * `funcoesDoPainel_` falha AQUI, e não no navegador do professor.
 *
 * A diferença para `dom-falso.js` (o do site) não é só o arquivo: o site tem
 * elementos estáticos e o painel MONTA a tela inteira com `innerHTML`. Por isso
 * este documento materializa elemento sob demanda: `getElementById('ed-matricula')`
 * procura o id dentro do HTML que já foi escrito e, achando, devolve um elemento
 * com `value`, `disabled` e `type` lidos da própria marcação. É o que permite
 * afirmar que um campo que a janela desabilitou NÃO viaja no payload.
 *
 * O QUE MUDOU EM 11/08, e é o que permitiu CLICAR: os `onclick=` da marcação
 * passaram a ser EXECUTADOS, e o evento passou a SUBIR (do campo até o dono do
 * conteúdo, e daí até o documento). Antes, um teste que quisesse clicar em
 * "Salvar" chamava a função por dentro — e aí a única coisa que a marcação
 * garante (que o botão chama a função certa, com o argumento certo, passando o
 * `this` que o painel precisa para travá-lo) não era exercitada por teste nenhum.
 * Agora o clique no fundo da janela e o clique no Salvar percorrem o mesmo
 * caminho do dedo da coordenação. Elemento desabilitado não recebe clique, como
 * no navegador — é o freio de verdade contra o clique duplo.
 *
 * O que ele NÃO é: um navegador. Não há layout, CSS, foco, seleção nem parser de
 * HTML de verdade — a leitura é por regex, e é grosseira de propósito. A subida
 * do evento é pelo `dono` (de quem o elemento foi materializado), que é uma
 * árvore parecida com a de verdade e não é ela: dois elementos ESTÁTICOS não se
 * conhecem, então um clique dentro do `#modal-corpo` não chega sozinho ao
 * `#modal-fundo` — o teste que quer esse caminho dispara no fundo com o alvo de
 * dentro, que é o que o navegador entrega ao ouvinte.
 *
 * E há uma mentira DELIBERADA, que precisa estar escrita: o `fetch` falso
 * resolve SINCRONAMENTE (ver `jaResolvido`). No navegador de verdade o callback
 * só roda no próximo passo do laço de eventos. Isso é o que permite ao teste
 * clicar e afirmar na linha seguinte, e é o mesmo comportamento que o falso do
 * `google.script.run` tinha antes — mas significa que NENHUM teste daqui prova
 * ordem entre duas requisições em voo. Duas respostas que chegam fora de ordem
 * (o que acontece de verdade na abertura do painel) só o navegador prova.
 *
 * Este arquivo não roda testes. Ele é carregado por `painel-navegador.js`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { criarAmbiente } = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');
const PASTA_SITE = path.join(__dirname, '..', 'docs');

/**
 * Na ordem alfabética em que o editor do Apps Script carrega os arquivos.
 *
 * `08_Api.gs` entrou junto com o POST: é dele o `doPost` que agora atende o
 * painel. Sem ele o `fetch` falso não teria a quem entregar a requisição, e o
 * teste mediria um caminho que o navegador não percorre.
 */
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '03_Config.gs',
  '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs', '06_Reconciliacao.gs',
  '07_Auth.gs', '07b_LinkPorEmail.gs', '08_Api.gs', '09_Projetos.gs', '10_Painel.gs',
  '11_Banners.gs', '12_Disciplinas.gs', '13_Auditorio.gs'];

// ------------------------------------------------------------ Elementos

function criarClassList(el) {
  const lista = () => (el.className ? String(el.className).split(/\s+/).filter(Boolean) : []);
  const escrever = (nomes) => { el.className = nomes.join(' '); };
  const api = {
    contains: (n) => lista().indexOf(n) !== -1,
    add: (n) => { const a = lista(); if (a.indexOf(n) === -1) escrever(a.concat([n])); },
    remove: (n) => escrever(lista().filter((x) => x !== n)),
    toggle: (n, forca) => {
      const quer = forca === undefined ? !api.contains(n) : !!forca;
      if (quer) api.add(n); else api.remove(n);
    }
  };
  return api;
}

function criarElemento(tag, atributos, dono) {
  const attrs = Object.assign({}, atributos || {});
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    atributos: attrs,
    filhos: [],
    ouvintes: {},
    value: attrs.value === undefined ? '' : attrs.value,
    type: attrs.type || '',
    checked: Object.prototype.hasOwnProperty.call(attrs, 'checked'),
    disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'),
    style: {},
    focos: 0,
    // De qual elemento este veio, quando foi materializado de um innerHTML.
    dono: dono || null
  };
  el.id = attrs.id || '';
  el.className = attrs.class || '';
  el.classList = criarClassList(el);

  /**
   * Os filhos SEM ID já materializados do `innerHTML` deste elemento, pela tag
   * crua que os declara — e é o que dá IDENTIDADE ao `<img>` do banner.
   *
   * O painel pega a imagem por `querySelectorAll('img')` e pendura os ouvintes
   * NELA; depois o teste precisa alcançar o MESMO objeto para fazer a imagem
   * chegar (ou falhar). Sem este cache, cada consulta devolveria um elemento
   * recém-nascido, o `load` do teste cairia num objeto que ninguém está ouvindo,
   * e a espera do painel ficaria pendurada para sempre.
   *
   * Ele morre junto com o conteúdo, pelo mesmo motivo que os materializados por
   * id: a folha da impressão anterior não pode responder pela desta.
   */
  el.semId = {};

  // `innerHTML` e `textContent` são as DUAS faces do mesmo conteúdo, e escrever
  // numa apaga a outra — é o que o navegador faz. Guardar as duas separadas
  // deixaria o "Carregando..." de `textContent` na frente da tabela que o
  // `innerHTML` desenhou depois, e o teste leria a tela errada.
  let html = '';
  let texto = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v) => {
      html = String(v);
      texto = '';
      el.filhos = [];
      el.semId = {};
      // Trocar o conteúdo joga fora os campos que estavam ali. Sem isto, um
      // `ed-matricula` de uma janela fechada continuaria respondendo — e o teste
      // provaria o contrário do que acontece na tela.
      if (el.aoTrocarConteudo) el.aoTrocarConteudo(el);
    }
  });
  Object.defineProperty(el, 'textContent', {
    get: () => texto,
    set: (v) => {
      texto = String(v);
      html = '';
      el.filhos = [];
      el.semId = {};
      if (el.aoTrocarConteudo) el.aoTrocarConteudo(el);
    }
  });

  // O que a MARCAÇÃO trouxe, que é o que o navegador guarda para sempre em
  // `defaultValue`/`defaultChecked`. Quem compara "está diferente do que a tela
  // desenhou?" pergunta a estes (ver `modalTemTrabalho` no painel), e sem eles o
  // falso responderia `undefined` — todo campo pareceria alterado.
  el.defaultValue = el.value;
  el.defaultChecked = el.checked;

  el.appendChild = (f) => { el.filhos.push(f); return f; };
  el.append = function () { Array.prototype.forEach.call(arguments, el.appendChild); };
  el.removeChild = (f) => { el.filhos = el.filhos.filter((x) => x !== f); return f; };

  /**
   * `elemento.remove()` — que aqui é uma EDIÇÃO NO `innerHTML` do dono.
   *
   * No navegador as duas coisas são a mesma: tirar o nó da árvore muda o HTML
   * que o dono devolve. Aqui não seriam, porque o falso guarda o conteúdo como
   * texto e o elemento como objeto à parte — e o teste da folha impressa lê
   * justamente o texto (`cena.impressoes[0].html`). Sem esta ponte, o painel
   * removeria o `<img>` que falhou e o papel continuaria levando o ícone de
   * imagem quebrada, com o teste dizendo que não.
   *
   * Elemento que não veio de um `innerHTML` ESTOURA em vez de não fazer nada:
   * remoção silenciosa que não remove é exatamente o defeito que este falso
   * precisa saber mostrar.
   */
  el.remove = () => {
    if (!el.dono || !el.tagCrua) {
      throw new Error('o falso só remove elemento materializado de um innerHTML: ' + el.tagName);
    }
    el.dono.innerHTML = String(el.dono.innerHTML).replace(el.tagCrua, '');
  };
  el.setAttribute = (n, v) => { attrs[n] = String(v); };
  el.getAttribute = (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null);
  el.removeAttribute = (n) => { delete attrs[n]; };
  el.addEventListener = (t, fn) => { el.ouvintes[t] = (el.ouvintes[t] || []).concat([fn]); };
  el.focus = () => { el.focos++; };
  el.click = () => el.disparar('click', {});

  /**
   * Os campos que este elemento contém — por TAG, e só os que têm id.
   *
   * Existe porque o painel precisa perguntar à janela quais campos ela está
   * mostrando, e a resposta não pode ser uma lista escrita à mão (ver
   * `camposDoModal`). Entende SÓ seletor de tag ('input, select, textarea'):
   * qualquer outra coisa estoura, em vez de devolver lista vazia e deixar um
   * teste passar sobre uma tela que ninguém leu.
   *
   * A descida é pelos ids, e não pelo texto: `#modal-corpo` guarda no `innerHTML`
   * dele um `<div id="lote-disciplinas"></div>` VAZIO — as linhas foram escritas
   * depois, dentro do filho. Procurar só no `innerHTML` deste elemento acharia os
   * campos do formulário de projeto e nenhum do lote de disciplinas, que é
   * justamente o formulário mais longo da tela.
   *
   * O FILHO SEM ID é achado do mesmo jeito, e entrou com a espera pelas imagens:
   * o `<img>` do banner da folha impressa não tem id nenhum (ele não é lido por
   * id em lugar nenhum do painel — quem o procura é `esperarImagens_`, por tag).
   * Ele nasce aqui e fica guardado em `dono.semId`, para que a segunda consulta
   * devolva o MESMO objeto que o painel está ouvindo.
   *
   * A LIMITAÇÃO, dita em voz alta: campo sem id continua não sendo achado por
   * `getElementById`, que é como o painel lê todo campo desta página. O dia em
   * que um campo não tiver id, o teste vai achar que a janela está vazia.
   */
  el.querySelectorAll = (seletor) => {
    const tags = String(seletor).split(',').map((s) => s.trim().toLowerCase());
    tags.forEach((t) => {
      if (!/^[a-z][a-z0-9-]*$/.test(t)) {
        throw new Error('o falso só entende seletor de tag: ' + seletor);
      }
    });

    const achados = [];
    const visitar = (dono) => {
      const regex = /<([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g;
      let m;
      while ((m = regex.exec(String(dono.innerHTML || ''))) !== null) {
        const attrsDoFilho = atributosDaTag(m[0]);
        const filho = attrsDoFilho.id
          ? (dono.buscarPorId ? dono.buscarPorId(attrsDoFilho.id) : null)
          : filhoSemId(dono, m, attrsDoFilho);
        if (!filho) continue;
        if (tags.indexOf(String(filho.tagName).toLowerCase()) !== -1) achados.push(filho);
        visitar(filho);
      }
    };
    visitar(el);
    return achados;
  };

  /**
   * Dispara o evento — e ele SOBE, como sobe no navegador.
   *
   * A subida é pelo `dono` (de quem este elemento foi materializado) até o
   * documento. Sem ela, um `input` digitado num campo do formulário morreria no
   * próprio campo, e o ouvinte que o painel pendura no `#modal-corpo` — o que
   * sabe que alguém digitou na janela — nunca seria chamado. O teste provaria
   * uma tela que não existe.
   *
   * Clique em elemento desabilitado NÃO acontece, que é o que o navegador faz e
   * é o freio de verdade contra o clique duplo no Salvar. Sem esta linha, o teste
   * do clique duplo passaria por um motivo que a produção não tem.
   */
  el.disparar = (tipo, evento) => {
    const ev = evento || {};
    if (!ev.preventDefault) ev.preventDefault = () => { ev.padraoImpedido = true; };
    if (!ev.target) ev.target = el;
    if (tipo === 'click' && el.disabled) return ev;

    let atual = el;
    while (atual) {
      (atual.ouvintes[tipo] || []).forEach((fn) => fn(ev));
      atual = atual.dono;
    }
    const doDocumento = el.documento ? (el.documento.ouvintes[tipo] || []) : [];
    doDocumento.forEach((fn) => fn(ev));
    return ev;
  };
  return el;
}

/**
 * O filho sem id, materializado uma vez só e guardado no dono.
 *
 * A chave é a POSIÇÃO mais a tag inteira: duas imagens iguais na mesma folha
 * seriam dois elementos diferentes, como são no navegador.
 */
function filhoSemId(dono, m, attrs) {
  const chave = m.index + ':' + m[0];
  if (!dono.semId[chave]) {
    dono.semId[chave] = elementoDaTag(String(dono.innerHTML || ''), m, attrs, dono);
  }
  return dono.semId[chave];
}

/** Lê os atributos de uma tag crua: `<input type="text" id="x" value="y" disabled>`. */
function atributosDaTag(tag) {
  const attrs = {};
  const re = /([\w-]+)(?:="([^"]*)")?/g;
  let m;
  // O primeiro casamento é o nome da tag.
  re.exec(tag);
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1]] = m[2] === undefined ? '' : desescapar(m[2]);
  }
  return attrs;
}

/** O inverso de `escapar` do Admin.html — o navegador decodifica ao ler o valor. */
function desescapar(v) {
  return String(v)
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Acha a tag que declara este id dentro de um HTML e devolve o elemento pronto.
 *
 * Para `<select>`, o valor é o da `<option ... selected>` — que é como o
 * navegador responde `.value` de um select recém-desenhado. Sem isto, o teste do
 * select de projetos leria '' e a migração pareceria não mandar nada.
 */
function materializar(htmlPai, id, dono) {
  const alvo = new RegExp('<([a-zA-Z][\\w-]*)((?:\\s+[\\w-]+(?:="[^"]*")?)*\\s+id="' +
    id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"(?:\\s+[\\w-]+(?:="[^"]*")?)*)\\s*/?>');
  const m = alvo.exec(htmlPai);
  if (!m) return null;
  return elementoDaTag(htmlPai, m, Object.assign(atributosDaTag(m[0]), { id: id }), dono);
}

/**
 * O elemento pronto a partir da tag encontrada — o miolo de `materializar`.
 *
 * Está separado porque nem todo elemento que o painel procura tem id: o
 * mapeamento das colunas da importação é uma lista de `<select data-campo="...">`
 * SEM id nenhum, e `confirmarImportacaoUI` os lê com
 * `document.querySelectorAll('[data-campo]')`. Sem isto, o passo que subiu a
 * lista oficial de verdade continuaria sem um teste que o clicasse.
 */
function elementoDaTag(htmlPai, m, attrs, dono) {
  const el = criarElemento(m[1], attrs, dono);
  // A tag EXATA que o declarou, que é o único endereço que este elemento tem
  // dentro do `innerHTML` do dono. É por ela que `el.remove()` o apaga de lá.
  el.tagCrua = m[0];

  /**
   * A IMAGEM, que no navegador NÃO nasce pronta.
   *
   * É o defeito inteiro do PDF em uma linha: quando o painel escreve a folha, o
   * `<img>` do banner existe e o arquivo ainda não chegou (35 a 90 KB pela rede
   * da faculdade). `complete` falso é esse instante, e é o estado em que toda
   * imagem deste falso nasce — o primeiro `print()` da sessão é sempre assim.
   *
   * `cena.imagensNascem` muda isso para as duas outras verdades do navegador:
   * `'carregada'` é o banner que já está no cache (da segunda impressão em
   * diante) e `'quebrada'` é o `src` que o navegador já sabe que não resolve —
   * as duas com `complete` verdadeiro, e distinguidas por `naturalWidth`, que é
   * como o navegador as distingue.
   *
   * `carregar()` e `falhar()` são o que o navegador faz DEPOIS: disparam o
   * evento que o painel está ouvindo, com `complete` já no estado que o evento
   * significa.
   */
  if (el.tagName === 'IMG') {
    const nascimento = (dono && dono.documento && dono.documento.imagensNascem) || 'pendente';
    el.complete = nascimento !== 'pendente';
    el.naturalWidth = nascimento === 'carregada' ? 1200 : 0;
    el.carregar = () => {
      el.complete = true;
      el.naturalWidth = 1200;
      el.disparar('load', {});
    };
    el.falhar = () => {
      el.complete = true;
      el.naturalWidth = 0;
      el.disparar('error', {});
    };
  }

  if (el.tagName === 'SELECT') {
    const corpo = htmlPai.slice(m.index);
    const fim = corpo.indexOf('</select>');
    const opcoes = corpo.slice(0, fim === -1 ? corpo.length : fim);
    const marcada = /<option\s+value="([^"]*)"[^>]*\sselected/.exec(opcoes);
    const primeira = /<option\s+value="([^"]*)"/.exec(opcoes);
    el.value = desescapar(marcada ? marcada[1] : (primeira ? primeira[1] : ''));
    el.opcoes = [];
    const re = /<option\s+value="([^"]*)"([^>]*)>([^<]*)</g;
    let o;
    while ((o = re.exec(opcoes)) !== null) {
      el.opcoes.push({ valor: desescapar(o[1]), rotulo: desescapar(o[3]), selecionada: /\sselected/.test(o[2]) });
    }

    // `options` é o mesmo conteúdo com o NOME do navegador, e existe porque o
    // painel lê `defaultSelected` para saber o que o select valeria se ninguém
    // tivesse mexido nele. `selected` fica de fora de propósito: o falso não
    // acompanha a seleção opção por opção (quem digita mexe em `select.value`),
    // e um `selected` desatualizado seria uma mentira difícil de ver.
    el.options = el.opcoes.map((op) => ({
      value: op.valor, text: op.rotulo, defaultSelected: op.selecionada
    }));
    // O navegador não tem `defaultValue` em `<select>`. Se ele existisse aqui,
    // um dia alguém o usaria e o teste ficaria verde com a tela quebrada.
    el.defaultValue = undefined;
  }
  if (el.tagName === 'TEXTAREA') {
    const corpo = htmlPai.slice(m.index + m[0].length);
    el.value = desescapar(corpo.slice(0, Math.max(0, corpo.indexOf('</textarea>'))));
    el.defaultValue = el.value;
  }

  /**
   * O RÓTULO, quando o conteúdo é texto puro — `<button ...>Salvar</button>`.
   *
   * Entrou com o botão que grava: ele guarda o próprio rótulo antes de escrever
   * "Salvando…" e o devolve quando a resposta chega. Sem isto o falso entregaria
   * um botão nascido vazio, o rótulo devolvido seria '' — e o teste não teria
   * como distinguir "voltou ao normal" de "ficou sem texto nenhum".
   *
   * Só texto puro: conteúdo com tag dentro continua fora do alcance do falso,
   * como sempre esteve.
   */
  const fechamento = '</' + el.tagName.toLowerCase() + '>';
  const depois = htmlPai.slice(m.index + m[0].length);
  const ateFechar = depois.indexOf(fechamento);
  const dentro = ateFechar === -1 ? '' : depois.slice(0, ateFechar);
  if (el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT' && dentro && dentro.indexOf('<') === -1) {
    el.textContent = desescapar(dentro);
  }

  return el;
}

// ------------------------------------------------------------ O documento

/**
 * Os elementos que já existem na marcação da página, por id.
 *
 * Passa pelo mesmo `elementoDaTag` dos materializados — e não por um
 * `criarElemento` cru — para que eles nasçam com o RÓTULO que a marcação lhes
 * deu. Sem isso, `#botao-confirmar` (Confirmar importação) nasceria sem texto
 * nenhum, e o teste que afirma "o botão voltou ao normal depois da falha" não
 * conseguiria distinguir o rótulo devolvido de um botão vazio — justamente no
 * botão que travou de verdade na produção.
 */
function lerElementosEstaticos(html) {
  const porId = {};
  const regex = /<([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const attrs = atributosDaTag(m[0]);
    if (!attrs.id) continue;
    porId[attrs.id] = elementoDaTag(html, m, attrs, null);
  }
  return porId;
}

/**
 * O texto que a área da tela mostra — com as entidades já decodificadas.
 *
 * Decodificar não é enfeite: o painel passa TODO texto por `escapar`, então um
 * aviso sobre o projeto "Lotado" chega ao DOM como `&quot;Lotado&quot;`. Ler o
 * cru faria o teste afirmar sobre uma string que ninguém vê.
 */
function textoDe(el) {
  if (!el) return '';
  const meu = el.textContent || String(el.innerHTML).replace(/<[^>]*>/g, ' ');
  const tudo = (meu + ' ' + el.filhos.map(textoDe).join(' ')).replace(/\s+/g, ' ').trim();
  return desescapar(tudo).replace(/&middot;/g, '·').replace(/&nbsp;/g, ' ').replace(/&times;/g, '×');
}

// ------------------------------------------------- Promessas que já chegaram

/**
 * Uma "promessa" que resolve na hora, para o `fetch` falso.
 *
 * O painel encadeia `fetch(...).then(...).then(...).catch(...)`. Com Promise de
 * verdade, o callback só roda depois que a pilha esvazia — e o teste teria de
 * ser assíncrono do começo ao fim para clicar num botão e ler a tela. Isto
 * atende ao mesmo formato e chama na hora.
 *
 * O que se perde está escrito no cabeçalho do arquivo, e não é pouco: ordem
 * entre requisições simultâneas deixa de ser observável aqui.
 */
function jaResolvido(valor) {
  return {
    then(aoValor) {
      let proximo;
      try {
        proximo = aoValor(valor);
      } catch (e) {
        return jaRejeitado(e);
      }
      return (proximo && typeof proximo.then === 'function') ? proximo : jaResolvido(proximo);
    },
    catch() { return this; }
  };
}

function jaRejeitado(erro) {
  return {
    then() { return this; },
    catch(aoErro) {
      let proximo;
      try {
        proximo = aoErro(erro);
      } catch (e) {
        return jaRejeitado(e);
      }
      return (proximo && typeof proximo.then === 'function') ? proximo : jaResolvido(proximo);
    }
  };
}

/**
 * Uma resposta HTTP encenada — para os testes que precisam do CÓDIGO, e não do
 * corpo.
 *
 * O `fetch` falso sempre respondeu 200: ele existe para entregar a requisição ao
 * `doPost`, que responde 200 mesmo quando a função de dentro recusa (a recusa
 * viaja no corpo, em `{ ok: false }`). Só que `chamar()` decide se repete a
 * requisição pelo código — 5xx é o servidor tropeçando nele mesmo e vale
 * repetir; 4xx é uma resposta como outra qualquer e não vale — e essa decisão
 * não tinha como ser exercitada por teste nenhum.
 *
 * O objeto é MARCADO (`__respostaHttp`) em vez de adivinhado por formato: uma
 * resposta encenada é um payload livre do teste, e um dia alguém encenaria um
 * corpo com a chave `status` dentro sem querer dizer nada disso.
 */
function respostaHttp(codigo, corpo) {
  return { __respostaHttp: { codigo: codigo, corpo: corpo } };
}

/**
 * A requisição que SAIU e ainda não voltou — a espera, encenada.
 *
 * O `fetch` falso resolve na hora (ver `jaResolvido`), e por isso nenhum teste
 * conseguia olhar a tela DURANTE a chamada: quando o clique retornava, a resposta
 * já tinha chegado e a tela já era a de depois. Só que é exatamente aí que mora o
 * que a coordenação relatou — os 2 a 4 segundos em que o botão Salvar não dava
 * sinal de vida.
 *
 * `semResposta()` é a promessa que nunca se resolve. O teste clica, e o que ele
 * lê a seguir é a tela do meio da espera. Nada a destrava: o desfecho não é
 * assunto de quem encena a espera.
 */
function semResposta() {
  return { __semResposta: true };
}

function nuncaResponde() {
  const parada = { then: () => parada, catch: () => parada };
  return parada;
}

/**
 * A requisição que fica PENDURADA — e que só termina se alguém a abortar.
 *
 * É a diferença entre `semResposta()` e o que se mediu na produção em 12 e
 * 13/08: ali a resposta não chegava NUNCA, e aqui ela não chega até o
 * `AbortController` do `chamar()` desistir dela. Sem esta encenação não há como
 * provar o tempo-limite: `semResposta()` também nunca responde, e por isso ela
 * passaria igual com limite ou sem nenhum.
 */
function travada() {
  return { __travada: true };
}

/**
 * Uma promessa falsa SEM desfecho ainda — a peça que faltava neste arquivo.
 *
 * As outras (`jaResolvido`, `jaRejeitado`) resolvem na hora, e é isso que
 * permite ao teste clicar e afirmar na linha seguinte. A requisição pendurada
 * não pode fazer isso: o `then`/`catch` que o `chamar()` encadeia precisa ficar
 * guardado e ser chamado depois, quando o aborto chegar — que continua sendo
 * um instante SÍNCRONO, dentro de `cena.rodarTarefas()`.
 *
 * É uma promessa de mentira com a mesma forma das outras: nada aqui espera pelo
 * laço de eventos, e por isso o teste continua síncrono do começo ao fim.
 */
function criarEspera() {
  let desfecho = null;             // { erro: bool, valor }
  const aFazer = [];

  function assentar(erro, valor) {
    if (desfecho) return;          // uma promessa se assenta uma vez só
    desfecho = { erro, valor };
    aFazer.splice(0).forEach((passo) => passo());
  }

  function encadear(aoValor, aoErro) {
    const seguinte = criarEspera();
    const passo = () => {
      const trata = desfecho.erro ? aoErro : aoValor;
      // Sem quem tratar, o desfecho ATRAVESSA — é o que faz um `catch` lá na
      // frente receber o erro que nasceu aqui.
      if (!trata) { seguinte.assentar(desfecho.erro, desfecho.valor); return; }

      let saida;
      try {
        saida = trata(desfecho.valor);
      } catch (e) {
        seguinte.assentar(true, e);
        return;
      }
      if (saida && typeof saida.then === 'function') {
        saida.then((v) => seguinte.assentar(false, v)).catch((e) => seguinte.assentar(true, e));
      } else {
        seguinte.assentar(false, saida);
      }
    };

    if (desfecho) passo(); else aFazer.push(passo);
    return seguinte.promessa;
  }

  const promessa = {
    then: (aoValor, aoErro) => encadear(aoValor, aoErro),
    catch: (aoErro) => encadear(null, aoErro)
  };
  return { promessa, assentar };
}

// ------------------------------------------------------------ A cena

/**
 * Abre o painel num navegador falso, já autenticado, com o banco falso semeado
 * pelo `semear` que o teste passar.
 *
 * opcoes:
 *   semear(api)   roda com o sandbox dos `.gs` pronto, antes de o painel abrir
 *   usuario       quem está no painel
 *   deslogado     abre na TELA DE LOGIN, sem token guardado
 *   semGis        não instala a biblioteca do Google — é o caso "a biblioteca
 *                 não carregou", que a tela precisa tratar sem travar
 *   busca         a query string com que a página abre ('?entrar=abc'), para os
 *                 caminhos do link por e-mail e do `liberarMeuAcesso()`
 *   respostas     { nomeDaFuncao: resposta | (corpo) => resposta } — respostas
 *                 encenadas, entregues ANTES do `doPost`. Ver `fetchFalso`.
 */
function abrirPainel(opcoes) {
  const cfg = opcoes || {};
  const pagina = fs.readFileSync(path.join(PASTA_SITE, 'painel', 'index.html'), 'utf8');
  const marcacao = pagina.slice(0, pagina.indexOf('<script>'));
  const codigo = pagina.slice(pagina.indexOf('<script>') + '<script>'.length, pagina.lastIndexOf('</script>'));

  // `usuario: ''` é um pedido legítimo, e não "use o padrão": é o que o servidor
  // enxerga numa requisição vinda do GitHub Pages, onde `Session.getActiveUser()`
  // volta vazio. Quem testa a TELA DE LOGIN precisa desse estado — com um
  // usuário visível e autorizado, `autenticar` entra sozinho pelo caminho 1 e o
  // teste provaria um caminho que o navegador nunca percorre.
  const usuario = cfg.usuario === undefined ? 'coord@exemplo.com' : cfg.usuario;

  const ambiente = criarAmbiente({ arquivos: GS, usuario: usuario });
  const api = ambiente.api;
  const token = api.criarSessao_(usuario || 'coord@exemplo.com');

  // Os serviços que 08_Api.gs usa e o `apoio.js` não tem. Mesma montagem de
  // `testes/api.js` — o `doPost` responde por `ContentService`, e o caminho de
  // projetos pede o `LockService`.
  api.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput(texto) {
      const saida = {
        _texto: String(texto),
        setMimeType() { return saida; },
        getContent() { return saida._texto; }
      };
      return saida;
    }
  };
  // `waitLock` entrou com a fila de espera: `reservarVaga` (09_Projetos.gs) e
  // `promoverDaEspera` (13_Auditorio.gs) pegam o lock por ele, e um lock falso
  // sem esse método ESTOURA — o que o servidor traduz para "muita gente se
  // inscrevendo ao mesmo tempo". Sem esta linha, toda promoção e toda restauração
  // feita por clique falhariam no teste por um motivo que a produção não tem, e o
  // ciclo inteiro (anular → promover) ficaria sem como ser exercitado.
  api.LockService = {
    getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} })
  };

  // O `tokeninfo` do Google, sob controle do teste. Sem isto, `entrarComGoogle`
  // sairia para a rede de verdade a partir de um teste.
  const tokeninfo = { chamadas: [], resposta: null, lancar: false };
  const aoFirestore = ambiente.falso.UrlFetchApp.fetch;
  api.UrlFetchApp = {
    fetch(url, opcoesFetch) {
      if (String(url).indexOf('oauth2.googleapis.com/tokeninfo') !== -1) {
        tokeninfo.chamadas.push(String(url));
        if (tokeninfo.lancar) throw new Error('DNS temporariamente indisponível');
        const r = tokeninfo.resposta || { codigo: 400, corpo: { error: 'invalid_token' } };
        return {
          getResponseCode: () => r.codigo,
          getContentText: () => (typeof r.corpo === 'string' ? r.corpo : JSON.stringify(r.corpo))
        };
      }
      return aoFirestore(url, opcoesFetch);
    },
    // Só o Firestore usa `fetchAll`; o desvio do `tokeninfo` não se repete aqui.
    fetchAll: (lote) => ambiente.falso.UrlFetchApp.fetchAll(lote)
  };

  if (cfg.semear) cfg.semear(api, ambiente);

  const porId = lerElementosEstaticos(marcacao);
  const materializados = {};

  const cena = {
    api,
    ambiente,
    falso: ambiente.falso,
    token,
    tokeninfo,
    chamadas: [],        // { funcao, args } — o que chegou ao `.gs`
    requisicoesHttp: [], // { url, tipo, corpo } — o que saiu pela rede
    confirmacoes: [],    // as perguntas do window.confirm
    respostaConfirm: true,
    baixados: [],        // os arquivos que o painel mandou baixar
    impressoes: [],      // { html, classe } — o que foi para o papel a cada window.print()
    rolagens: [],        // os `window.scrollTo` que a tela pediu
    tarefas: [],         // o que o setTimeout empilhou
    historico: [],       // as URLs que o painel reescreveu com replaceState
    respostas: Object.assign({}, cfg.respostas),
    porId,
    elemento: (id) => documento.getElementById(id)
  };

  /**
   * Some com os campos que viviam dentro deste elemento — e com os que viviam
   * dentro DELES.
   *
   * A recursão não é zelo: a janela de disciplinas escreve `modal-corpo`, que
   * contém `lote-disciplinas`, que contém `lote-c-0`. Apagar só o filho direto
   * deixaria `lote-c-0` respondendo com o que foi digitado na janela ANTERIOR, e
   * o teste "linha incompleta recusa o lote" passaria sobre uma tela fantasma.
   */
  function limparFilhosMaterializados(dono) {
    Object.keys(materializados).forEach((id) => {
      if (materializados[id] !== dono) return;
      const filho = porId[id];
      delete materializados[id];
      delete porId[id];
      if (filho) limparFilhosMaterializados(filho);
    });
  }

  /**
   * O `onclick=` da MARCAÇÃO, executado — e é isto que permite CLICAR de verdade.
   *
   * Sem ele, o teste que quer clicar em "Salvar" tem de chamar a função por
   * dentro (`cena.js.salvarProjetoUI(...)`), e aí a única coisa que a marcação
   * garante — que o botão chama a função certa, com o argumento certo, passando o
   * `this` que o painel precisa para travá-lo — deixa de ser exercitada. Um
   * `onclick` com o nome errado passaria por todos os testes e falharia no dedo da
   * coordenação.
   *
   * A compilação é PREGUIÇOSA porque os elementos estáticos nascem antes do
   * sandbox: quem clica, clica com a página já carregada.
   */
  function ligarOnclick(el) {
    const fonte = el.getAttribute('onclick');
    if (!fonte) return;
    let compilado = null;
    el.addEventListener('click', (ev) => {
      if (!compilado) {
        compilado = vm.runInContext('(function (event) {\n' + fonte + '\n})', sandbox,
          { filename: 'onclick de #' + (el.id || el.tagName) });
      }
      compilado.call(el, ev);
    });
  }

  /**
   * O que todo elemento desta página precisa saber: quem é o dono do conteúdo
   * dele, como achar um id e onde fica o documento (para o evento subir até lá).
   */
  function instrumentar(el) {
    el.aoTrocarConteudo = limparFilhosMaterializados;
    el.buscarPorId = (id) => documento.getElementById(id);
    el.documento = documento;
    ligarOnclick(el);
  }

  const documento = {
    ouvintes: {},
    getElementById(id) {
      if (porId[id]) return porId[id];
      // Procura o id dentro do HTML que já foi escrito em qualquer elemento.
      const donos = Object.keys(porId).map((k) => porId[k]);
      for (let i = 0; i < donos.length; i++) {
        const dono = donos[i];
        if (!dono.innerHTML || dono.innerHTML.indexOf('id="' + id + '"') === -1) continue;
        const el = materializar(dono.innerHTML, id, dono);
        if (!el) continue;
        instrumentar(el);
        porId[id] = el;
        materializados[id] = dono;
        return el;
      }
      return null;
    },
    createElement: (tag) => criarElemento(tag, {}, null),

    /**
     * Dois seletores, e só eles: `.aba` e `[atributo]` / `[atributo="valor"]`.
     *
     * O de atributo entrou pela importação: o mapeamento das colunas é uma lista
     * de `<select data-campo="nome">` sem id, e `confirmarImportacaoUI` — o botão
     * que travou de verdade na produção — lê os selects por
     * `document.querySelectorAll('[data-campo]')`. Sem isto, o teste do clique
     * ali dentro pararia na primeira linha da função, achando que ninguém mapeou
     * coluna nenhuma.
     *
     * Os elementos são guardados pelo par ATRIBUTO=VALOR, que é a identidade que
     * o falso consegue dar a quem não tem id — e é por isso que o teste continua
     * lendo o mesmo objeto que a tela leu. Dois elementos com o mesmo par seriam
     * um só aqui; na página não há nenhum caso assim, e este comentário existe
     * para o dia em que houver.
     *
     * Qualquer outro seletor ESTOURA. Devolver lista vazia deixaria um teste
     * passar sobre uma tela que ninguém leu.
     */
    querySelectorAll(seletor) {
      if (seletor === '.aba') {
        const abas = [];
        const re = /<button class="aba[^"]*" data-aba="([^"]+)"/g;
        let m;
        while ((m = re.exec(marcacao)) !== null) {
          const chave = '__aba_' + m[1];
          if (!porId[chave]) {
            porId[chave] = criarElemento('button', { class: 'aba', 'data-aba': m[1] }, null);
          }
          abas.push(porId[chave]);
        }
        return abas;
      }

      const porAtributo = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(seletor);
      if (!porAtributo) throw new Error('o falso não entende este seletor: ' + seletor);

      const atributo = porAtributo[1];
      const valorPedido = porAtributo[2];
      const achados = [];

      Object.keys(porId).map((k) => porId[k]).forEach((dono) => {
        const html = String(dono.innerHTML || '');
        if (html.indexOf(atributo + '="') === -1) return;

        const regex = /<([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g;
        let m;
        while ((m = regex.exec(html)) !== null) {
          const attrs = atributosDaTag(m[0]);
          const valor = attrs[atributo];
          if (valor === undefined) continue;
          if (valorPedido !== undefined && valor !== valorPedido) continue;

          const chave = '__' + atributo + '=' + valor;
          if (!porId[chave]) {
            const el = elementoDaTag(html, m, attrs, dono);
            instrumentar(el);
            porId[chave] = el;
            materializados[chave] = dono;
          }
          if (achados.indexOf(porId[chave]) === -1) achados.push(porId[chave]);
        }
      });
      return achados;
    },

    querySelector(seletor) {
      return documento.querySelectorAll(seletor)[0] || null;
    },

    addEventListener(tipo, fn) { documento.ouvintes[tipo] = (documento.ouvintes[tipo] || []).concat([fn]); },
    body: criarElemento('body', {}, null)
  };

  // Os estáticos ganham a instrumentação DEPOIS do documento existir — é dele
  // que eles precisam para materializar filho e deixar evento subir.
  Object.keys(porId).forEach((id) => instrumentar(porId[id]));

  /**
   * A barra de endereço, e o histórico que a reescreve.
   *
   * Entrou junto com o link por e-mail: o painel passou a abrir com `?entrar=` e
   * `?sessao=`, e a PRIMEIRA coisa que ele faz com esses tokens é apagá-los da
   * URL (`colherTokenDaUrl`) — para não deixá-los no histórico do navegador nem
   * vazá-los pelo `Referer` do primeiro recurso que a página buscar.
   *
   * `cena.historico` guarda o que foi reescrito, e é assim que o teste afirma que
   * a limpeza aconteceu de verdade — e não que ela só "deveria" acontecer.
   */
  const janela = {
    // REGISTRADA, e não engolida: `avisar` rola a página para o topo quando o
    // aviso é do painel, e não pode rolá-la quando o aviso está DENTRO de uma
    // janela — ali quem rola é o `.modal-fundo`, e puxar a página de trás move o
    // que está debaixo do dedo de quem está lendo o erro.
    scrollTo(x, y) { cena.rolagens.push([x, y]); },
    confirm(pergunta) { cena.confirmacoes.push(String(pergunta)); return cena.respostaConfirm; },
    alert(msg) { cena.confirmacoes.push('alert: ' + String(msg)); },
    /**
     * O "Salvar como PDF" do navegador, encenado.
     *
     * Ele guarda o que a folha DIZIA no instante do clique, e não depois: o
     * painel limpa o `#area-impressao` assim que `print()` devolve o controle
     * (ver `imprimirRelatorio_`), e um teste que lesse a área depois leria vazio
     * — provando o contrário do que aconteceu. `classe` viaja junto porque é a
     * classe do `<body>` que faz o `@media print` trocar a tela pela folha; sem
     * ela, imprime-se o painel inteiro e o `.modal-fundo` sai como página preta.
     */
    print() {
      const area = documento.getElementById('area-impressao');
      cena.impressoes.push({
        html: area ? String(area.innerHTML) : '',
        classe: String(documento.body.className || '')
      });
    },
    // `busca` também aceita função, e não é capricho: o `?sessao=` de
    // `liberarMeuAcesso()` carrega um token de sessão que só existe depois de o
    // ambiente falso subir, e o teste precisa de um jeito de alcançá-lo.
    location: {
      pathname: '/unicesusc-cesutech/painel/',
      search: (typeof cfg.busca === 'function' ? cfg.busca(token) : cfg.busca) || ''
    }
  };

  const historico = {
    replaceState(_estado, _titulo, url) {
      const alvo = String(url);
      const corte = alvo.indexOf('?');
      janela.location.pathname = corte === -1 ? alvo : alvo.slice(0, corte);
      janela.location.search = corte === -1 ? '' : alvo.slice(corte);
      cena.historico.push(alvo);
    }
  };

  /**
   * O que chegou ao `.gs`, e não só o que saiu pela rede.
   *
   * `funcoesDoPainel_` monta o mapa lendo as variáveis GLOBAIS do sandbox no
   * instante da requisição — então trocar a global por um embrulho faz o
   * despacho passar por aqui. É o que mantém `cena.chamadas` com o mesmo
   * significado de antes: os argumentos EXATOS que a função do servidor
   * recebeu, inclusive o `token` que o `rotaDoPainel_` carimba.
   *
   * Só as alcançáveis pelo navegador são embrulhadas — a lista branca do
   * servidor mais as de login. Embrulhar tudo encheria a lista com as chamadas
   * internas de cada função (`reconciliar` dentro de `rodarReconciliacao`, por
   * exemplo), e aí `cena.chamadas` deixaria de responder "o que o painel pediu".
   *
   * `autenticar` saiu da lista com o PIN. As duas do link por e-mail entraram, e
   * hoje não casam com função nenhuma do sandbox (07b_LinkPorEmail.gs não está em
   * `GS`, porque `rotaDeLogin_` ainda não as despacha) — o `typeof` abaixo as
   * ignora sozinho, e elas passam a ser observadas no dia em que o servidor as
   * alcançar, sem ninguém precisar lembrar deste arquivo.
   */
  const observaveis = Object.keys(api.funcoesDoPainel_())
    .concat(['entrarComGoogle', 'modoDeAcesso', 'sair', 'sessaoAtiva',
      'pedirLinkDeAcesso', 'entrarComLink']);

  observaveis.forEach((nome) => {
    const original = api[nome];
    if (typeof original !== 'function') return;
    api[nome] = function () {
      cena.chamadas.push({ funcao: nome, args: Array.prototype.slice.call(arguments) });
      return original.apply(null, arguments);
    };
  });

  /**
   * O `fetch` do navegador falso: entrega a requisição ao `doPost` de verdade.
   *
   * Duas URLs chegam aqui, e o tratamento é diferente porque a realidade é
   * diferente: o `/exec` do Apps Script responde, e o `manifest.json` do site
   * (galeria de banners) não existe no falso — como não existiria numa máquina
   * sem internet. A galeria tem tratamento próprio para isso, e é bom que ele
   * seja exercitado.
   */
  function fetchFalso(url, opcoesFetch) {
    const o = opcoesFetch || {};
    const endereco = String(url);

    if (endereco.indexOf('/exec') === -1) {
      return jaRejeitado(new Error('sem rede no falso: ' + endereco));
    }

    cena.requisicoesHttp.push({
      url: endereco,
      metodo: o.method,
      tipo: (o.headers || {})['Content-Type'],
      corpo: o.body,
      // O `signal` que a chamada mandou — `undefined` quando ela não mandou
      // nenhum, que é o que o teste da ESCRITA afirma. Guardado aqui porque é a
      // única prova de que o tempo-limite acompanha `SO_LEITURA` e não a
      // requisição inteira.
      sinal: o.signal
    });

    /**
     * A resposta ENCENADA, quando o teste registrou uma para esta função.
     *
     * Existe por uma razão específica e temporária: `pedirLinkDeAcesso` e
     * `entrarComLink` (07b_LinkPorEmail.gs) ainda não estão no despacho de
     * `rotaDeLogin_` (08_Api.gs) — o servidor está sendo escrito em paralelo à
     * tela. Sem isto, todo teste da porta nova provaria "Ação desconhecida" em
     * vez de provar a tela.
     *
     * O que ela NÃO faz, e importa: nada aqui desliga o `doPost` das outras
     * funções. Quem não estiver em `cena.respostas` continua percorrendo o
     * caminho de verdade — envelope, lista branca, `exigirAdmin` e a função do
     * `.gs`. Quando o despacho das duas existir, tirar a resposta encenada do
     * teste é a única mudança necessária para ele passar a exercitar o servidor.
     */
    const corpoEnviado = JSON.parse(o.body);
    if (Object.prototype.hasOwnProperty.call(cena.respostas, corpoEnviado.fn)) {
      const encenada = cena.respostas[corpoEnviado.fn];
      // A função recebe a `cena` porque a resposta boa costuma precisar de um
      // token de sessão VÁLIDO — e ele só existe depois de o ambiente subir.
      const r = typeof encenada === 'function' ? encenada(corpoEnviado, cena) : encenada;
      // `null` encena a requisição que morre na rede — o `catch` do `chamar()`.
      // A conferência é por `hasOwnProperty`, e não pela verdade do valor:
      // `null` é justamente o caso que interessa encenar.
      //
      // A função encenada pode se apagar de `cena.respostas` antes de devolver, e
      // é assim que se encena "falhou uma vez e deu certo na seguinte": a segunda
      // tentativa não acha mais encenação nenhuma e percorre o `doPost` de
      // verdade. É o formato mais próximo do que aconteceu na produção.
      if (r === null) return jaRejeitado(new Error('falha de conexão encenada'));

      // `semResposta()` — a requisição saiu e a resposta não chega nunca. É a
      // única forma de o teste olhar a tela DURANTE a espera.
      if (r && r.__semResposta) return nuncaResponde();

      // `travada()` — pendurada até alguém abortar. Sem sinal ela é igual à de
      // cima, e é assim que se prova que uma ESCRITA não tem como ser abortada:
      // o teste encena a mesma travada nas duas e só a leitura termina.
      if (r && r.__travada) {
        const espera = criarEspera();
        if (o.signal) {
          o.signal.addEventListener('abort', () => {
            const erro = new Error('The user aborted a request.');
            erro.name = 'AbortError';
            espera.assentar(true, erro);
          });
        }
        return espera.promessa;
      }

      // `respostaHttp(500)` e companhia — ver o comentário da função.
      if (r && r.__respostaHttp) {
        const http = r.__respostaHttp;
        return jaResolvido({
          ok: http.codigo >= 200 && http.codigo < 300,
          status: http.codigo,
          json: () => jaResolvido(http.corpo === undefined ? {} : http.corpo)
        });
      }

      return jaResolvido({ ok: true, status: 200, json: () => jaResolvido(r) });
    }

    let saida;
    try {
      saida = api.doPost({ postData: { type: (o.headers || {})['Content-Type'], contents: o.body } });
    } catch (e) {
      // O `doPost` de verdade não lança (ele tem try/catch), mas se um dia
      // lançar, o teste tem de ver falha de rede e não um teste verde.
      return jaRejeitado(e);
    }

    const texto = saida.getContent();
    return jaResolvido({
      ok: true,
      status: 200,
      json: () => jaResolvido(JSON.parse(texto))
    });
  }

  /**
   * A biblioteca do Google Identity Services, falsa.
   *
   * Ela não valida nada — quem valida é o servidor. O que ela faz é guardar o
   * `callback` para que o teste possa fazer o que o Google faria: devolver uma
   * credencial. `cfg.semGis` a deixa de fora, que é o caso "accounts.google.com
   * não carregou" — a tela precisa dizer isso e abrir o pedido de link por
   * e-mail, que é a porta que não depende de recurso de terceiro.
   */
  const gis = { inicializacoes: [], botoes: [], callback: null };
  const googleFalso = cfg.semGis ? undefined : {
    accounts: {
      id: {
        initialize(conf) {
          gis.inicializacoes.push(conf);
          gis.callback = conf && conf.callback;
        },
        renderButton(caixa, estilo) {
          gis.botoes.push({ caixa, estilo });
          caixa.innerHTML = '<div id="gis-botao">Fazer login com o Google</div>';
        }
      }
    }
  };

  const contexto = {
    console: { log() {}, error() {} },
    JSON, Math, Date, String, Number, Object, Array, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    document: documento,
    window: janela,
    history: historico,
    // O painel lê `?entrar=` e `?sessao=` com ele — o mesmo que o site do aluno
    // usa para ler `?projeto=` (docs/assets/app.js).
    URLSearchParams,
    // O que o `setTimeout` empilhou, e o `clearTimeout` que desfaz o empilhado.
    //
    // O relógio não anda sozinho aqui: quem o faz andar é `cena.rodarTarefas()`.
    // O `clearTimeout` entrou com o tempo-limite das leituras, e ele é o que
    // mantém `cena.tarefas` significando o que sempre significou — "o que ainda
    // está marcado para acontecer". Sem ele, toda leitura que respondesse
    // deixaria para trás um aborto marcado, e os testes que contam as tarefas
    // pendentes passariam a contar lixo.
    setTimeout: (fn, ms) => {
      const tarefa = { fn, ms: Number(ms) || 0 };
      cena.tarefas.push(tarefa);
      return tarefa;
    },
    clearTimeout: (tarefa) => {
      const i = cena.tarefas.indexOf(tarefa);
      if (i !== -1) cena.tarefas.splice(i, 1);
    },
    // O contexto do `vm` nasce só com o JavaScript da linguagem: `AbortController`
    // é do navegador, como o `fetch`, e por isso precisa ser entregue aqui. É o
    // do Node, de verdade — o `fetch` falso ouve o `abort` dele como o navegador
    // ouviria.
    AbortController,
    sessionStorage: (() => {
      const dados = {};
      return {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(dados, k) ? dados[k] : null),
        setItem: (k, v) => { dados[k] = String(v); },
        removeItem: (k) => { delete dados[k]; }
      };
    })(),
    Blob: function (partes) { this.partes = partes; },
    URL: { createObjectURL: () => 'blob:falso', revokeObjectURL() {} },
    fetch: fetchFalso,
    FileReader: function () {},
    google: googleFalso,
    // `confirm` e `alert` também soltos, e não só em `window`: no navegador as
    // duas formas funcionam, e o painel usa as duas (`expurgarLoteUI` chama
    // solto, o resto chama por `window`). Sem isto, metade das perguntas
    // "tem certeza?" estoura no falso com "confirm is not defined" — um
    // caminho que o teste não conseguiria exercitar e o professor sim.
    confirm: (pergunta) => janela.confirm(pergunta),
    alert: (msg) => janela.alert(msg)
  };
  contexto.globalThis = contexto;
  contexto.window.history = historico;
  contexto.window.document = documento;
  contexto.window.google = googleFalso;
  contexto.window.fetch = fetchFalso;

  const sandbox = vm.createContext(contexto);

  // O `config.js` do site de verdade, e não um objeto inventado aqui: é dele que
  // sai o `endpoint`, e um teste que o inventasse não notaria o dia em que ele
  // sumisse do arquivo publicado.
  vm.runInContext(fs.readFileSync(path.join(PASTA_SITE, 'assets', 'config.js'), 'utf8'),
    sandbox, { filename: 'config.js' });
  if (cfg.configuracao) cfg.configuracao(contexto.window.CESUTECH_CONFIG);

  vm.runInContext(codigo, sandbox, { filename: 'docs/painel/index.html' });

  cena.js = sandbox;
  cena.documento = documento;
  cena.janela = janela;
  cena.gis = gis;

  /** Faz o que o Google faria depois de a pessoa escolher a conta. */
  cena.entrarComGoogle = (idToken) => {
    if (!gis.callback) throw new Error('o painel não registrou callback no Google');
    gis.callback({ credential: idToken });
  };

  /**
   * Roda o que o `setTimeout` empilhou — a espera pela biblioteca do Google, a
   * pausa entre duas tentativas, o tempo-limite de uma leitura.
   *
   * Uma passada roda o que estava marcado QUANDO ela começou, e o que nascer no
   * meio fica para a passada seguinte. É o que dá um passo de cada vez ao teste:
   * a primeira passada dispara o tempo-limite (que agenda a nova tentativa), e a
   * segunda é que manda a requisição.
   */
  cena.rodarTarefas = (vezes) => {
    for (let i = 0; i < (vezes || 1); i++) {
      const pendentes = cena.tarefas.slice();
      cena.tarefas.length = 0;
      pendentes.forEach((tarefa) => tarefa.fn());
    }
  };

  // -------------------------------------- As imagens da folha de impressão

  /**
   * Em que estado as imagens desta cena NASCEM — 'pendente' (o padrão, e o que
   * o navegador faz na primeira impressão), 'carregada' (o banner já no cache) ou
   * 'quebrada' (o `src` que o navegador já sabe que não resolve).
   *
   * Precisa ser dito ANTES do clique que monta a folha: quem cria o `<img>` é a
   * primeira consulta do painel a ele, e o estado é lido no nascimento — como no
   * navegador, onde o cache já decidiu antes de o elemento existir.
   */
  cena.imagensNascem = (estado) => { documento.imagensNascem = estado; };

  /**
   * As imagens que a folha montou — os MESMOS objetos que o painel está
   * ouvindo, e não cópias (ver `el.semId`).
   *
   * Devolve lista vazia depois de a impressão terminar, e isso é verdade e não
   * limitação: quem limpa o `#area-impressao` é `imprimirRelatorio_`, e depois
   * dele não há folha nenhuma. Por isso o teste chama isto ENTRE o clique e a
   * chegada da imagem, que é onde mora a espera.
   */
  cena.imagensDaFolha = () => {
    const area = documento.getElementById('area-impressao');
    return area ? area.querySelectorAll('img') : [];
  };

  /** O que o navegador faz quando o arquivo chega: `onload` em cada imagem. */
  cena.carregarImagens = () => {
    const imagens = cena.imagensDaFolha();
    imagens.forEach((img) => img.carregar());
    return imagens.length;
  };

  /** E quando ele não chega — 404, Drive fora do ar, rede que caiu no meio. */
  cena.falharImagens = () => {
    const imagens = cena.imagensDaFolha();
    imagens.forEach((img) => img.falhar());
    return imagens.length;
  };

  // O painel abre como abre de verdade: DOMContentLoaded, com (ou sem) o token
  // guardado desta aba.
  if (!cfg.deslogado) contexto.sessionStorage.setItem('cesutech_token', token);
  (documento.ouvintes.DOMContentLoaded || []).forEach((fn) => fn({}));

  /** O texto que uma área da tela está mostrando agora. */
  cena.texto = (id) => textoDe(documento.getElementById(id));
  /** O HTML cru, para afirmar sobre atributos (disabled, selected). */
  cena.html = (id) => {
    const el = documento.getElementById(id);
    return el ? String(el.innerHTML) : '';
  };
  cena.digitar = (id, valor) => {
    const el = documento.getElementById(id);
    if (!el) throw new Error('campo inexistente na tela: ' + id);
    if (el.disabled) throw new Error('campo desabilitado na tela: ' + id);
    el.value = String(valor);
    // Digitar faz BARULHO no navegador: nasce um `input`, e ele sobe. Há tela
    // que só descobre que alguém digitou por esse evento — é assim que a janela
    // sabe que tem trabalho dentro dela (`MODAL_COM_TRABALHO`, no painel). Sem
    // esta linha o falso digitaria em silêncio, e o teste do clique no fundo
    // provaria uma tela que não existe.
    el.disparar('input', {});
    return el;
  };

  /**
   * O botão que dispara esta função — para os que vivem DENTRO de uma linha de
   * tabela e não têm id: Inativar, Remover, Excluir, Apagar matriculados.
   *
   * Dar id a cada um deles só para o teste alcançá-los seria pôr ruído na tela
   * por causa do teste. Aqui eles são achados pelo que a marcação diz que eles
   * fazem, que é a mesma coisa que o teste quer afirmar.
   */
  cena.botaoQueChama = (padrao) => {
    const achado = documento.querySelectorAll('[onclick]')
      .filter((el) => padrao.test(String(el.getAttribute('onclick'))))[0];
    if (!achado) throw new Error('nenhum botão na tela chama ' + padrao);
    return achado;
  };

  /**
   * Uma tecla, entregue a quem ouve o DOCUMENTO — que é onde mora o Esc.
   *
   * Sem alvo: no navegador o Esc é ouvido no documento venha ele de onde vier, e
   * inventar um elemento de origem aqui seria escolher um caminho que a tela não
   * percorre.
   */
  cena.teclar = (tecla) => {
    const ev = { key: tecla, preventDefault: () => {} };
    (documento.ouvintes.keydown || []).forEach((fn) => fn(ev));
    return ev;
  };
  // O que estava marcado ANTES do passo que o teste quer medir não é o que ele
  // quer contar: zerar aqui é o que deixa `cena.tarefas` responder "o que ESTE
  // clique agendou" — o teto da espera pelo banner, por exemplo.
  cena.zerarTarefas = () => { cena.tarefas.length = 0; };
  cena.zerarRequisicoes = () => { ambiente.falso.requisicoes.length = 0; };
  cena.requisicoes = () => ambiente.falso.requisicoes;
  cena.documentos = (colecao) => {
    const saida = {};
    ambiente.falso.documentos.forEach((v, k) => {
      if (k.indexOf(colecao + '/') === 0) {
        const obj = {};
        Object.keys(v).forEach((c) => { obj[c] = v[c].stringValue; });
        saida[k.slice(colecao.length + 1)] = obj;
      }
    });
    return saida;
  };

  return cena;
}

module.exports = {
  abrirPainel, textoDe, GS, jaResolvido, jaRejeitado, respostaHttp, semResposta, travada
};
