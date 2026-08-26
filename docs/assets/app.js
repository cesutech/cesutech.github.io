/**
 * app.js — site público do CESUTECH (GitHub Pages).
 *
 * Duas telas na mesma página: a lista de projetos e o detalhe com o formulário.
 * A navegação usa ?projeto=<codigo> na URL, então cada projeto tem link próprio
 * e o botão voltar do navegador funciona.
 *
 * O POST vai direto para o Apps Script. O detalhe que faz isso passar sem CORS:
 * Content-Type text/plain. Com application/json o navegador dispara um preflight
 * OPTIONS, e o Apps Script não responde OPTIONS — a requisição morre antes de
 * sair. O corpo continua sendo JSON; só o cabeçalho é que mente.
 */

(function () {
  'use strict';

  var CFG = window.CESUTECH_CONFIG || {};
  var ESTADO = {
    projetos: [],
    projetoAtual: null,
    // Renovação da lista em voo, quando há uma. Não é trava de tempo — ver
    // `renovarProjetos`; é só não pedir duas vezes a MESMA coisa ao mesmo tempo.
    buscaEmVoo: null,
    cursosFases: [],
    // Nova busca da configuração em voo, quando há uma — ver `renovarConfig`.
    // Variável PRÓPRIA, e não a `buscaEmVoo` acima: as duas rotas são
    // independentes, e dividir o lugar faria o formulário desistir de pedir a
    // configuração só porque a LISTA estava em voo — e a lista não traz curso
    // nenhum, então o que faltava continuaria faltando.
    configEmVoo: null,
    textoLgpd: CFG.textoLgpdPadrao || '',
    textoDeclaracao: '',
    textoImagem: '',
    textoEsgotado: 'Inscrições esgotadas. Escolha outro projeto de extensão disponível.',
    exigirMatricula: true,
    timerEspera: null,
    avisarAoSair: null,
    matricula: { estado: 'vazio', valor: '', bloqueia: false },
    // Vereditos de matrícula já recebidos NESTA página, por matrícula e projeto.
    // Ver `conferirMatricula`: é o que evita esperar de novo pelo mesmo "sim".
    matriculasConferidas: {},
    conferenciaEmVoo: null,
    momentoInicio: Date.now()
  };

  document.addEventListener('DOMContentLoaded', function () {
    preencherRodape();

    if (!CFG.endpoint) {
      mostrar('aviso-config');
      esconder('carregando-projetos');
      return;
    }

    carregarTudo();

    document.getElementById('formulario').addEventListener('submit', enviar);
    document.getElementById('whatsapp').addEventListener('input', function (e) {
      e.target.value = mascaraTelefone(e.target.value);
    });

    var campoMatricula = document.getElementById('matricula');
    // Conferir ao SAIR do campo, não a cada tecla: durante a digitação toda
    // matrícula parcial é inválida, e pintar de vermelho aí seria só ruído.
    campoMatricula.addEventListener('blur', function () { conferirMatricula(); });
    campoMatricula.addEventListener('input', function () {
      if (ESTADO.matricula.estado !== 'vazio') marcarMatricula('digitando');
    });

    ligarMenuTopo();

    // Botão voltar do navegador alterna entre lista e detalhe.
    window.addEventListener('popstate', aplicarRota);
  });

  // ---------------------------------------------------------------- Carga

  function carregarTudo() {
    // A carga inicial da lista OCUPA o lugar da renovação (ver `renovarProjetos`)
    // e só o libera no fim. Sem isto, a rota aplicada aqui embaixo — que é uma
    // navegação como outra qualquer, e por isso renova — pediria `?api=projetos`
    // pela segunda vez a poucos milissegundos da primeira, para todo visitante.
    var pedidoDaLista = buscar('?api=projetos');
    ESTADO.buscaEmVoo = pedidoDaLista;

    Promise.all([
      buscar('?api=config'),
      pedidoDaLista
    ]).then(function (res) {
      var cfg = res[0], projs = res[1];

      absorverConfig(cfg);

      // FALHA NÃO É LISTA VAZIA, e confundir as duas foi um defeito real:
      // `buscar` devolvia null quando a requisição morria, isto virava [], e a
      // tela mostrava "Nenhum projeto disponível no momento" — a mensagem de
      // sistema VAZIO para um sistema FORA DO AR. O aluno recarregava até dar
      // certo, sem nunca saber que devia. O servidor já tinha sido corrigido
      // para não cometer esse erro (ver o comentário de `doGet` em 08_Api.gs);
      // o cliente veio do sistema sobre Sheets e não tinha.
      if (!projs) {
        var aviso = document.getElementById('carregando-projetos');
        aviso.className = 'aviso aviso--erro';
        aviso.textContent = 'Não conseguimos falar com o servidor agora. ' +
          'Tentando de novo...';
      } else {
        ESTADO.projetos = (projs.ok && projs.projetos) ? projs.projetos : [];

        esconder('carregando-projetos');
        renderizarLista();
        aplicarRota();
      }

      // Lugar liberado: do próximo movimento em diante, cada navegação pede a
      // lista de novo. Inclusive depois da falha acima — voltar para a lista ou
      // clicar no menu é a chance de o site se recuperar sozinho.
      ESTADO.buscaEmVoo = null;
    }).catch(function () {
      ESTADO.buscaEmVoo = null;
      var el = document.getElementById('carregando-projetos');
      el.className = 'aviso aviso--erro';
      el.textContent = 'Não conseguimos carregar os projetos. Recarregue a página em instantes.';
    });
  }

  /**
   * Guarda no estado a configuração que chegou do servidor.
   *
   * Existe como função própria porque há DOIS caminhos que recebem `?api=config`:
   * a carga da página e a nova tentativa disparada ao abrir o formulário
   * (`renovarConfig`). Duas cópias desta atribuição seria uma delas envelhecer
   * sozinha — o campo novo entraria só na primeira, e quem passasse pela segunda
   * ficaria sem ele, sem nada na tela indicando por quê.
   *
   * Devolve se a resposta serviu. Resposta que não chegou (`null`) não apaga o
   * que já está no estado: pela mesma razão de sempre, falha não é dado vazio.
   */
  function absorverConfig(cfg) {
    if (!cfg || !cfg.ok || !cfg.dados) return false;

    var d = cfg.dados;
    ESTADO.cursosFases = d.cursosFases || [];
    ESTADO.textoLgpd = d.textoLgpd || ESTADO.textoLgpd;
    ESTADO.textoDeclaracao = d.textoDeclaracao || '';
    ESTADO.textoImagem = d.textoImagem || '';
    ESTADO.textoEsgotado = d.textoEsgotado || ESTADO.textoEsgotado;
    ESTADO.exigirMatricula = d.exigirMatricula !== false;
    return true;
  }

  /**
   * Quanto uma LEITURA pode ficar pendurada antes de ser abandonada.
   *
   * Uma chamada ao `/exec` são DOIS saltos: o `/exec` responde um
   * redirecionamento para `script.googleusercontent.com/macros/echo?user_content_key=...`,
   * e é o segundo que traz o corpo. Esse segundo às vezes TRAVA, e não é
   * hipótese: medido na produção em 13/08, véspera do evento — o `echo`
   * devolvendo 404 depois de 32,73s pendurado no navegador de um aluno, e no
   * terminal 404 em 11,9s e em 66,8s, com a repetição logo em seguida
   * respondendo em 401ms. É transitório, e é do encanamento do Google: o nosso
   * servidor não tem como responder 404 (a conta inteira está em `chamar()`, no
   * painel).
   *
   * A repetição abaixo já existia e não bastava: sem tempo-limite ela só começa
   * depois que o Google desiste sozinho, e o aluno pagou os 32,73s ANTES da
   * primeira repetição — 48s até a página existir.
   *
   * POR QUE DEZ SEGUNDOS. Resposta saudável de instância quente: 2 a 4s. A mais
   * lenta que DEU CERTO nas medições: 9,25s. As travadas: de 12 a 67s. Dez
   * segundos ficam acima de tudo que chega e abaixo de tudo que trava. Cinco
   * cortariam leituras que ainda iam responder; vinte devolvem ao aluno metade
   * da espera que se está tirando dele.
   *
   * ABORTAR NÃO CANCELA O TRABALHO DO SERVIDOR — o `fetch` morre aqui e a
   * execução do Apps Script segue do lado de lá até o fim. Isso é o que torna o
   * abandono barato: se o que estava acontecendo era um arranque a frio
   * legítimo, a instância continua subindo e a repetição chega com ela mais
   * pronta. O que se joga fora é uma resposta, não o trabalho dela.
   *
   * O PIOR CASO passa a ser 3 × (10s + espera) ≈ 36s até desistir — que é o
   * mesmo que o aluno já esperava com UMA travada e nenhuma repetição. O
   * tempo-limite não piora nenhum cenário; ele só corta o pior.
   */
  var LIMITE_DE_LEITURA_MS = 10000;

  /**
   * Busca com repetição, porque a primeira chamada do dia é lenta.
   *
   * O Apps Script hiberna script sem tráfego, e a requisição que acorda a
   * instância pode levar dezenas de segundos — medido: 36s numa rota que não
   * faz trabalho nenhum, contra 1,9s no sistema que recebe acesso o dia todo.
   * Não é o banco: uma rota vazia não toca em banco.
   *
   * Três tentativas com espera crescente, e a espera existe para não empilhar
   * requisição em cima de uma instância que já está subindo.
   *
   * O tempo-limite (`LIMITE_DE_LEITURA_MS`) entra como qualquer outra falha de
   * transporte: aborta, cai no `catch` de baixo e repete. Não há caminho novo —
   * de propósito, porque o desfecho de uma leitura que não chegou é o mesmo,
   * tenha ela morrido na rede ou demorado demais.
   *
   * SÓ LEITURA tem tempo-limite. O envio da inscrição (`enviarDeVerdade`) não
   * tem, e isso é decisão e não esquecimento: abortar uma escrita que pode ter
   * gravado no servidor troca uma espera longa por uma dúvida que a tela não
   * tem como desfazer — o aluno não saberia se está inscrito.
   */
  function buscar(query, tentativa) {
    tentativa = tentativa || 1;

    // `AbortController` é da mesma safra de `fetch`, `Promise` e
    // `URLSearchParams`, que esta página já exige há muito: navegador que não
    // tiver o controle não chega a rodar nada disto.
    var controle = new AbortController();
    var relogio = setTimeout(function () { controle.abort(); }, LIMITE_DE_LEITURA_MS);
    function desarmar() { clearTimeout(relogio); }

    return fetch(CFG.endpoint + query, {
      method: 'GET',
      redirect: 'follow',
      signal: controle.signal
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      // O desarme é aqui, e não junto do `r.ok` acima: quando os cabeçalhos
      // chegam o corpo ainda está sendo lido, e travar na leitura do corpo é
      // uma das formas de travar. O relógio tem de cobrir a resposta INTEIRA.
      .then(function (dados) { desarmar(); return dados; })
      .catch(function () {
        desarmar();
        if (tentativa >= 3) return null;
        return new Promise(function (resolver) {
          setTimeout(function () { resolver(buscar(query, tentativa + 1)); }, tentativa * 2000);
        });
      });
  }

  /**
   * "Sobre" e "Ver projetos" apontam para âncoras que vivem DENTRO da tela de
   * lista. Estando no detalhe de um projeto, essa tela está escondida: o
   * navegador só acrescenta o # na URL e nada acontece.
   *
   * Aqui o clique primeiro volta para a lista e só então rola até a seção.
   */
  function ligarMenuTopo() {
    var links = document.querySelectorAll('.topo nav a[href^="#"]');
    Array.prototype.forEach.call(links, function (link) {
      link.addEventListener('click', function (ev) {
        var alvo = document.getElementById(link.getAttribute('href').slice(1));
        if (!alvo) return;

        // Já na lista: deixa a âncora nativa funcionar. Renova assim mesmo —
        // clicar no menu é movimento, e todo movimento atualiza a lista.
        if (!ESTADO.projetoAtual) {
          renovarProjetos();
          return;
        }

        ev.preventDefault();
        mostrarLista(false);
        alvo.scrollIntoView({ block: 'start' });
      });
    });
  }

  // ---------------------------------------------------------------- Rotas

  function aplicarRota() {
    var codigo = new URLSearchParams(window.location.search).get('projeto');
    var projeto = codigo ? acharPorCodigo(codigo) : null;

    if (projeto) mostrarProjeto(projeto, true);
    else mostrarLista(true);
  }

  function acharPorCodigo(codigo) {
    for (var i = 0; i < ESTADO.projetos.length; i++) {
      if (ESTADO.projetos[i].codigo === codigo) return ESTADO.projetos[i];
    }
    return null;
  }

  function mostrarLista(semHistorico) {
    ESTADO.projetoAtual = null;
    mostrar('tela-lista');
    mostrar('faixa-banner');
    esconder('tela-projeto');
    if (!semHistorico) history.pushState({}, '', window.location.pathname);
    window.scrollTo(0, 0);
    renovarProjetos();
  }

  /**
   * Pede a lista de novo. TODA navegação passa por aqui: voltar para a lista,
   * ENTRAR num projeto e clicar nos links do menu do topo.
   *
   * NÃO existe trava de tempo, e a ausência dela é a decisão. Havia uma janela
   * de 20 segundos, por cautela, e ela protegia contra um custo que não existe:
   * `?api=projetos` responde do cache do SERVIDOR por 30 segundos (CACHE_ROTAS_S
   * em 08_Api.gs), então pedir de novo dentro da janela custa ZERO leitura no
   * Firestore — a resposta já está montada. O que a trava produzia era o defeito
   * relatado: voltar para a lista e continuar vendo o contador de quando se
   * entrou no site. Quem quiser reintroduzir uma janela aqui vai reintroduzir
   * junto o defeito, e existe teste que reprova isso.
   *
   * Duas regras que não podem cair:
   *
   *   1. A tela NUNCA espera por esta resposta. Ela mostra o que já tem e se
   *      corrige quando a resposta chega. Bloquear aqui seria trocar um número
   *      velho por uma tela em branco, e o número velho é o mal menor.
   *   2. Falha NÃO apaga a lista que está na tela. Confundir "deu erro" com "não
   *      tem projeto" já foi defeito real — ver o comentário em `carregarTudo`.
   */
  function renovarProjetos() {
    // Pedido igual já em voo: aproveita o mesmo. Isto não atrasa ninguém — quem
    // chega depois recebe a resposta no mesmo instante que o primeiro — e evita
    // que ir e voltar depressa vire uma fila de execuções do Apps Script, que é
    // o recurso escasso do dia do evento. É dedução de pedido REPETIDO, não
    // validade de dado: assim que a resposta chega, o próximo movimento pede de
    // novo.
    if (ESTADO.buscaEmVoo) return ESTADO.buscaEmVoo;

    ESTADO.buscaEmVoo = buscar('?api=projetos').then(function (res) {
      ESTADO.buscaEmVoo = null;
      if (!res || !res.ok || !res.projetos) return;
      ESTADO.projetos = res.projetos;
      aplicarProjetosNaTela();
    });
    return ESTADO.buscaEmVoo;
  }

  /**
   * Põe a lista recém-chegada na tela que estiver aberta AGORA.
   *
   * A resposta pode chegar depois de o aluno ter mudado de tela — ele entrou num
   * projeto, voltou, entrou noutro. Quem decide o que redesenhar é o estado do
   * momento em que a resposta chega, nunca o de quando o pedido saiu.
   */
  function aplicarProjetosNaTela() {
    renderizarLista();
    if (!ESTADO.projetoAtual) return;

    var fresco = acharPorCodigo(ESTADO.projetoAtual.codigo);
    // Projeto que saiu da lista (desativado no painel enquanto o aluno lia):
    // mantém na tela o que ele já está vendo. Apagar o detalhe embaixo dele
    // seria a tela em branco que a regra 1 proíbe.
    if (!fresco) return;

    ESTADO.projetoAtual = fresco;
    // Só o cartão. O formulário aberto NÃO é tocado: o aluno pode estar
    // digitando, e nenhum número de vaga vale o que ele já preencheu. Se o
    // projeto lotou nesse meio tempo, quem avisa é a resposta do envio
    // (`anunciarPerdaDeVaga`) — a única que sabe se a vaga era dele.
    renderizarCartaoVagas(fresco);
  }

  window.voltarParaLista = function (ev) {
    if (ev) ev.preventDefault();
    mostrarLista(false);
  };

  // ---------------------------------------------------------------- Lista

  function renderizarLista() {
    var grade = document.getElementById('grade-projetos');
    grade.innerHTML = '';

    if (!ESTADO.projetos.length) {
      grade.innerHTML = '<p class="texto-fraco">Nenhum projeto disponível no momento.</p>';
      return;
    }

    ESTADO.projetos.forEach(function (p) {
      var cartao = document.createElement('article');
      cartao.className = 'cartao-projeto' + (p.situacao !== 'ABERTO' ? ' cartao-projeto--indisponivel' : '');

      var botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'cartao-projeto__botao';
      botao.addEventListener('click', function () { mostrarProjeto(p, false); });

      if (p.banner) {
        var img = document.createElement('img');
        img.className = 'cartao-projeto__banner';
        img.src = urlBanner(p.banner);
        img.alt = '';
        img.loading = 'lazy';
        botao.appendChild(img);
      }

      var corpo = document.createElement('div');
      corpo.className = 'cartao-projeto__corpo';

      var titulo = document.createElement('h3');
      titulo.textContent = p.nome;
      corpo.appendChild(titulo);

      if (p.professor) {
        var prof = document.createElement('p');
        prof.className = 'cartao-projeto__prof';
        prof.textContent = p.professor;
        corpo.appendChild(prof);
      }

      corpo.appendChild(seloVagas(p));
      botao.appendChild(corpo);
      cartao.appendChild(botao);
      grade.appendChild(cartao);
    });
  }

  /**
   * A ocupação veio NESTA resposta?
   *
   * `inscritos` chega null quando o servidor não contou — a chave
   * `contar_ocupacao_na_lista` em NAO (09_Projetos.gs). A conferência é pelo
   * DADO, e não pelo sinalizador `ocupacao_contada` que vem junto: assim uma
   * resposta antiga, guardada no cache da rota antes de o campo existir, não
   * some com a ocupação que ela de fato traz. Null nunca pode virar zero na
   * tela — "0 de 60" num projeto cheio é o cartão mais convidativo da lista.
   */
  function temOcupacao(p) {
    return typeof p.inscritos === 'number';
  }

  /**
   * O que a tela diz quando o servidor não contou. Diz as duas coisas que o
   * aluno precisa saber: que o número não está sendo mostrado, e que a vaga
   * continua sendo conferida de verdade na hora do envio.
   */
  var SEM_OCUPACAO = 'Quantas vagas já foram preenchidas não está sendo exibido agora. ' +
    'Se o projeto já estiver cheio, o sistema avisa no envio da inscrição.';

  /** Selo de vagas — a informação que hoje só existe como frase no formulário. */
  function seloVagas(p) {
    var selo = document.createElement('span');
    selo.className = 'selo-vagas';

    if (p.situacao === 'ESGOTADO') {
      selo.classList.add('selo-vagas--esgotado');
      selo.textContent = 'Esgotado';
    } else if (p.situacao === 'FECHADO') {
      selo.classList.add('selo-vagas--fechado');
      selo.textContent = 'Inscrições encerradas';
    } else if (!temOcupacao(p) && p.vagas > 0) {
      // O TOTAL, e nunca o restante: sem contagem, quantas sobram é justamente o
      // que não se sabe. "no total" está no texto porque "60 vagas" sozinho se lê
      // como "60 disponíveis" — a mesma mentira do "0 de 60", por outra porta.
      selo.classList.add('selo-vagas--aberto');
      selo.textContent = p.vagas + (p.vagas === 1 ? ' vaga no total' : ' vagas no total');
      selo.title = SEM_OCUPACAO;
    } else if (p.restantes === null) {
      selo.classList.add('selo-vagas--aberto');
      selo.textContent = 'Inscrições abertas';
    } else {
      selo.classList.add(p.restantes <= 10 ? 'selo-vagas--poucas' : 'selo-vagas--aberto');
      selo.textContent = p.restantes + (p.restantes === 1 ? ' vaga restante' : ' vagas restantes');
    }
    return selo;
  }

  // ---------------------------------------------------------------- Detalhe

  function mostrarProjeto(p, semHistorico) {
    ESTADO.projetoAtual = p;
    ESTADO.momentoInicio = Date.now();

    esconder('tela-lista');
    mostrar('tela-projeto');
    esconder('painel-sucesso');
    esconder('aviso-perda-vaga');
    esconder('area-formulario');
    // O CARTÃO DE VAGAS VOLTA A APARECER, e esta linha é um conserto.
    //
    // `concluir` esconde o cartão para o painel de sucesso ocupar o lugar dele, e
    // ninguém o mostrava de novo: depois de UMA inscrição, todo projeto aberto
    // dali em diante exibia a coluna da direita vazia — uma caixa branca no lugar
    // do contador e do botão. Cartão vazio é pior que cartão desatualizado,
    // porque parece defeito e o aluno não sabe se as inscrições existem.
    mostrar('cartao-vagas');
    // O banner institucional do topo sai: quem já entrou no projeto deve ver
    // o banner DELE primeiro, não a chamada geral de novo.
    esconder('faixa-banner');

    var banner = document.getElementById('projeto-banner');
    banner.innerHTML = '';
    if (p.banner) {
      var img = document.createElement('img');
      img.src = urlBanner(p.banner);
      img.alt = p.nome;
      banner.appendChild(img);
    }

    texto('projeto-nome', p.nome);
    texto('projeto-coordenacao', p.professor || '');
    texto('projeto-descricao', p.descricao || '');
    texto('form-projeto-nome', p.nome);
    // A orientação do projeto, dentro do formulário. Mora aqui, junto do nome do
    // projeto, porque as duas coisas vêm do PROJETO — e não em `abrirFormulario`,
    // que preenche o que vem da configuração (declaração, imagem, LGPD).
    textoComQuebras('form-orientacao', p.descricao_formulario);

    preencherFicha('projeto-info', p);
    renderizarCartaoVagas(p);

    if (!semHistorico) history.pushState({}, '', '?projeto=' + encodeURIComponent(p.codigo));
    window.scrollTo(0, 0);

    // Entrar num projeto também renova: o contador do detalhe é o número que o
    // aluno usa para decidir se ainda vale a pena, e ele não pode ser o retrato
    // de quando a página abriu.
    renovarProjetos();
  }

  /**
   * A ficha do projeto — local, horário e primeiro encontro.
   *
   * Mora aqui, e não dentro do detalhe, porque o painel de sucesso mostra os
   * MESMOS campos: é o comprovante que o aluno fotografa para saber onde e
   * quando aparecer. Duas cópias da lista seria uma delas envelhecer sozinha.
   *
   * Rótulo só existe se o valor existir: projeto sem horário não pode mostrar
   * "Horário" seguido de nada.
   */
  function preencherFicha(idDestino, p) {
    var info = document.getElementById(idDestino);
    info.innerHTML = '';

    var pares = [['Local', p.local], ['Horário', p.horario], ['Primeiro encontro', p.primeiro_encontro]];
    var mostrou = false;

    pares.forEach(function (par) {
      if (!par[1]) return;
      var dt = document.createElement('dt'); dt.textContent = par[0];
      var dd = document.createElement('dd'); dd.textContent = paraDataBr(par[1]);
      info.append(dt, dd);
      mostrou = true;
    });

    return mostrou;
  }

  /**
   * O cartão lateral: ou o botão de inscrição, ou a mensagem de esgotado no
   * lugar dele. Era exatamente o pedido — quando lota, o botão some.
   *
   * Sem projeto não se esvazia o cartão. A ordem "limpa e depois preenche" só é
   * segura enquanto há com o que preencher; sem dado, ela deixaria na tela a
   * caixa branca vazia que o aluno lê como defeito. Melhor manter o conteúdo
   * anterior, mesmo velho, do que mostrar nada.
   */
  function renderizarCartaoVagas(p) {
    if (!p) return;

    var cartao = document.getElementById('cartao-vagas');
    cartao.innerHTML = '';

    if (p.vagas > 0 && temOcupacao(p)) {
      var ocupadas = Math.min(p.inscritos, p.vagas);
      var perc = Math.round(ocupadas / p.vagas * 100);

      var numeros = document.createElement('div');
      numeros.className = 'vagas-numeros';
      numeros.innerHTML = '<strong>' + ocupadas + '</strong> de <strong>' + p.vagas + '</strong> vagas preenchidas';
      cartao.appendChild(numeros);

      var barra = document.createElement('div');
      barra.className = 'vagas-barra';
      var preenchida = document.createElement('div');
      preenchida.className = 'vagas-barra__preenchida';
      preenchida.style.width = perc + '%';
      if (perc >= 100) preenchida.classList.add('vagas-barra__preenchida--cheia');
      else if (perc >= 80) preenchida.classList.add('vagas-barra__preenchida--quase');
      barra.appendChild(preenchida);
      cartao.appendChild(barra);
    } else if (p.vagas > 0) {
      // Sem contagem: o total aparece, a ocupação não, e A BARRA SOME. Uma barra
      // vazia não é "sem informação" — ela desenha zero por cento, e quem olha lê
      // "ninguém se inscreveu ainda" num projeto que pode estar cheio. Some por
      // isso, e não por economia de pixel.
      var totais = document.createElement('div');
      totais.className = 'vagas-numeros';
      totais.innerHTML = '<strong>' + p.vagas + '</strong>' +
        (p.vagas === 1 ? ' vaga no total' : ' vagas no total');
      cartao.appendChild(totais);

      var nota = document.createElement('p');
      nota.className = 'vagas-nota';
      nota.textContent = SEM_OCUPACAO;
      cartao.appendChild(nota);
    }

    // Já inscrito neste projeto, pela memória DESTE navegador: no lugar do botão,
    // a confirmação. Vem antes de ABERTO e antes de ESGOTADO — para quem já está
    // dentro, "você já está inscrito" é a informação que importa, não o estado
    // das vagas.
    if (estaInscritoLocalmente(p.codigo)) {
      cartao.appendChild(blocoJaInscrito(p));
      return;
    }

    if (p.situacao === 'ABERTO') {
      cartao.appendChild(botaoInscrever());
      return;
    }

    // Sem botão: no lugar dele, a mensagem em destaque.
    var aviso = document.createElement('div');
    aviso.className = 'aviso-esgotado';

    var titulo = document.createElement('strong');
    titulo.textContent = p.situacao === 'ESGOTADO'
      ? 'Inscrições esgotadas'
      : 'Inscrições encerradas';
    aviso.appendChild(titulo);

    var detalhe = document.createElement('span');
    detalhe.textContent = p.situacao === 'ESGOTADO'
      ? ESTADO.textoEsgotado
      : 'Este projeto não está recebendo novas inscrições no momento.';
    aviso.appendChild(detalhe);

    var voltar = document.createElement('button');
    voltar.type = 'button';
    voltar.className = 'btn btn--bloco';
    voltar.textContent = 'Ver outros projetos';
    voltar.addEventListener('click', function () { mostrarLista(false); });
    aviso.appendChild(voltar);

    cartao.appendChild(aviso);
  }

  function botaoInscrever() {
    var botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'btn btn--primario btn--bloco btn--grande';
    botao.textContent = 'Quero me inscrever';
    botao.addEventListener('click', abrirFormulario);
    return botao;
  }

  /**
   * O que ocupa o lugar do botão para quem já entrou neste projeto.
   *
   * A saída "Não foi você?" existe por um caso concreto: computador de
   * laboratório, onde o próximo aluno usa o mesmo navegador do anterior. Sem ela,
   * a lembrança de OUTRA pessoa tiraria dele o botão de se inscrever, e o site
   * não teria como saber que errou. Quem decide de verdade continua sendo o
   * servidor, que recusa duplicata de matrícula com `duplicada: true`.
   */
  function blocoJaInscrito(p) {
    var bloco = document.createElement('div');
    bloco.className = 'ja-inscrito';

    var titulo = document.createElement('strong');
    titulo.textContent = 'Você já está inscrito neste projeto';
    bloco.appendChild(titulo);

    var protocolo = protocoloLocal(p.codigo);
    if (protocolo) {
      var linha = document.createElement('span');
      linha.className = 'ja-inscrito__protocolo';
      linha.textContent = 'Protocolo: ' + protocolo;
      bloco.appendChild(linha);
    }

    var detalhe = document.createElement('span');
    detalhe.textContent = 'Sua inscrição foi registrada neste navegador. ' +
      'Não é preciso preencher o formulário de novo.';
    bloco.appendChild(detalhe);

    var voltar = document.createElement('button');
    voltar.type = 'button';
    voltar.className = 'btn btn--bloco';
    voltar.textContent = 'Ver outros projetos';
    voltar.addEventListener('click', function () { mostrarLista(false); });
    bloco.appendChild(voltar);

    if (p.situacao === 'ABERTO') {
      var outra = document.createElement('button');
      outra.type = 'button';
      outra.className = 'ligacao-discreta';
      outra.textContent = 'Não foi você? Fazer outra inscrição neste projeto';
      outra.addEventListener('click', abrirFormulario);
      bloco.appendChild(outra);
    }

    return bloco;
  }

  // --------------------------------------------- Memória local das inscrições

  /**
   * Onde fica a lembrança de "eu já me inscrevi neste projeto": `localStorage`.
   *
   * A escolha, e o que ela custa:
   *
   *   - memória da página perderia a lembrança em qualquer F5, e F5 é o que o
   *     aluno faz quando acha que travou. Ficaria uma conveniência que some
   *     justamente na hora em que ele mais confere;
   *   - `sessionStorage` sobreviveria ao F5, mas morre ao fechar a aba, e o aluno
   *     que volta depois do intervalo para conferir onde se inscreveu não veria
   *     nada;
   *   - `localStorage` sobrevive aos dois.
   *
   * O que ela NÃO é, e isto é o ponto: fonte de verdade. Limpar o navegador, usar
   * o celular em vez do computador ou trocar de máquina apaga a lembrança — e o
   * site volta a mostrar o botão normalmente. Não há prejuízo nenhum nisso: quem
   * sabe quem está inscrito é o servidor, que recusa a segunda inscrição da mesma
   * matrícula no mesmo projeto e responde `duplicada: true` (04_Inscricoes.gs).
   * Pelo mesmo motivo o contrário também vale: a lembrança presente nunca é
   * prova, só atalho de tela.
   */
  var CHAVE_INSCRICOES = 'cesutech.inscricoes';

  function inscricoesLocais() {
    // Navegador com armazenamento bloqueado (modo restrito, política do
    // dispositivo) faz `localStorage` estourar no acesso. Isso não pode derrubar
    // a tela inteira por causa de uma conveniência.
    try {
      var bruto = window.localStorage.getItem(CHAVE_INSCRICOES);
      var dados = bruto ? JSON.parse(bruto) : null;
      return (dados && typeof dados === 'object') ? dados : {};
    } catch (e) {
      return {};
    }
  }

  function lembrarInscricao(codigo, protocolo) {
    if (!codigo) return;
    try {
      var dados = inscricoesLocais();
      dados[codigo] = protocolo || '';
      window.localStorage.setItem(CHAVE_INSCRICOES, JSON.stringify(dados));
    } catch (e) {
      // Sem armazenamento o aluno perde só o aviso na volta. A inscrição dele
      // está gravada no servidor, que é onde importa.
    }
  }

  function estaInscritoLocalmente(codigo) {
    // `hasOwnProperty` e não a verdade do valor: inscrição duplicada volta sem
    // protocolo, e o valor gravado é a string vazia.
    return !!codigo && Object.prototype.hasOwnProperty.call(inscricoesLocais(), codigo);
  }

  function protocoloLocal(codigo) {
    return inscricoesLocais()[codigo] || '';
  }

  function abrirFormulario() {
    // Lista de cursos vazia é formulário que NÃO TEM COMO SER CONCLUÍDO — ver
    // `renovarConfig`. Abrir é a hora em que ela passa a fazer falta, e por isso
    // é aqui que se pede de novo.
    var temCursos = ESTADO.cursosFases.length > 0;
    aplicarConfigNoFormulario(temCursos ? 'pronto' : 'carregando');
    if (!temCursos) renovarConfig();

    mostrar('area-formulario');
    ESTADO.momentoInicio = Date.now();
    document.getElementById('area-formulario').scrollIntoView({ block: 'start' });
    document.getElementById('matricula').focus();
  }

  /**
   * Põe no formulário o que vem da CONFIGURAÇÃO: a lista de cursos e os três
   * textos de aceite. Está tudo junto porque tudo chega pela mesma requisição —
   * e porque a resposta pode chegar com o formulário JÁ ABERTO, e aí é esta
   * função que corrige a tela inteira de uma vez, e não só o campo que faltava.
   * Sem isso, a caixa de autorização de imagem continuaria sem rótulo nenhum: um
   * consentimento sem texto ao lado, que ninguém pode dar de verdade.
   *
   * A orientação do projeto NÃO mora aqui: ela vem do PROJETO, e quem a escreve é
   * `mostrarProjeto`.
   */
  function aplicarConfigNoFormulario(estadoCursos) {
    var p = ESTADO.projetoAtual;
    // Aluno que voltou para a lista antes de a resposta chegar: não há
    // formulário para preencher, e `p.nome` aqui embaixo nem existiria.
    if (!p) return;

    pintarCursos(estadoCursos);
    document.getElementById('rotulo-declaracao').textContent =
      ESTADO.textoDeclaracao || ('Declaro que desejo participar do projeto ' + p.nome + '.');
    document.getElementById('rotulo-imagem').textContent = ESTADO.textoImagem;
    document.getElementById('rotulo-lgpd').textContent = ESTADO.textoLgpd;

    document.getElementById('matricula').required = ESTADO.exigirMatricula;
  }

  var TEXTO_ESCOLHA_CURSO = 'Selecione seu curso e fase...';
  var TEXTO_CARREGANDO_CURSOS = 'Carregando os cursos...';
  // O mesmo texto que o `erro-curso_fase` já traz escrito no index.html. Ele é
  // reposto aqui porque a mensagem de falha ocupa o mesmo elemento.
  var ERRO_CURSO_VAZIO = 'Selecione seu curso e fase.';
  var ERRO_SEM_CURSOS = 'Não conseguimos carregar a lista de cursos. ' +
    'Recarregue a página e tente de novo.';

  /**
   * O select de curso e fase no estado em que a lista está AGORA: 'pronto',
   * 'carregando' ou 'falhou'.
   *
   * A mensagem sai no `erro-curso_fase`, que é o lugar de erro que este campo já
   * tem — mesma classe, mesma cor, mesmo ponto da tela. Um aviso com estética
   * própria seria um segundo padrão de erro dentro do mesmo formulário.
   *
   * Ela aparece DESDE JÁ, sem esperar o aluno tentar enviar: a essa altura já se
   * sabe que a lista não vem, e guardar o aviso para o envio seria manter por
   * mais tempo o silêncio que é o defeito.
   */
  function pintarCursos(estado) {
    preencherSelect('curso_fase', ESTADO.cursosFases,
      estado === 'carregando' ? TEXTO_CARREGANDO_CURSOS : TEXTO_ESCOLHA_CURSO);

    var erro = document.getElementById('erro-curso_fase');
    // O texto VOLTA ao original quando a lista chega. Sem esta linha, a mensagem
    // de falha ficaria guardada no elemento e reapareceria no primeiro envio com
    // o campo em branco — dizendo que não há lista logo abaixo da lista.
    erro.textContent = estado === 'falhou' ? ERRO_SEM_CURSOS : ERRO_CURSO_VAZIO;
    erro.classList.toggle('visivel', estado === 'falhou');
  }

  /**
   * PEDE `?api=config` DE NOVO, porque a primeira vez pode não ter chegado.
   *
   * A configuração é pedida UMA vez, na carga da página. Quando ela não chega —
   * e em 13/08, véspera do evento, cinco leituras seguidas travaram e esta foi
   * uma delas —, `ESTADO.cursosFases` fica vazio pelo resto da sessão: o select
   * de curso e fase abre sem opção nenhuma, o campo é obrigatório, e o aluno NÃO
   * CONSEGUE se inscrever. Nada na tela dizia por quê; só recarregar a página
   * resolvia, e ele não tinha como saber disso.
   *
   * Por que só aqui, e não a cada navegação como a lista de projetos: das três
   * leituras, esta é a única que interessa exclusivamente a quem vai preencher o
   * formulário. Pedir a cada movimento gastaria execução do Apps Script — o
   * recurso escasso do dia do evento — por conta de quem só está olhando.
   *
   * NENHUMA TRAVA DE ENVIO NOVA. Quem segura o formulário enquanto a lista não
   * chega é quem já segurava: `curso_fase` vazio reprova em `validar()`. Uma
   * segunda regra dizendo a mesma coisa é uma chance de as duas discordarem.
   */
  function renovarConfig() {
    // Abrir e fechar o formulário depressa não pode virar duas execuções do Apps
    // Script. Mesma dedução de pedido repetido de `renovarProjetos`.
    if (ESTADO.configEmVoo) return ESTADO.configEmVoo;

    ESTADO.configEmVoo = buscar('?api=config').then(function (res) {
      // Liberado ANTES de desenhar: se esta rodada não trouxe a lista, abrir o
      // formulário de novo tem de poder tentar outra vez. Prender o lugar aqui
      // deixaria o aluno sem nenhum caminho além do F5.
      ESTADO.configEmVoo = null;
      absorverConfig(res);
      // A decisão é pela LISTA, e não pelo desfecho da requisição: resposta que
      // chegou sem curso nenhum trava o aluno tanto quanto resposta que não
      // chegou, e a tela precisa dizer a mesma coisa nos dois casos.
      aplicarConfigNoFormulario(ESTADO.cursosFases.length ? 'pronto' : 'falhou');
    });
    return ESTADO.configEmVoo;
  }

  // ------------------------------------------------- Conferência da matrícula

  /**
   * Pergunta ao servidor se a matrícula consta da lista oficial.
   * O servidor responde só sim/não — nome e curso jamais trafegam, para o
   * endereço não virar um oráculo sobre os alunos da instituição.
   *
   * ------------------------------------------------ Por que o "conferindo..."
   *
   * Esta rota é a ÚNICA das três que não tem cache no servidor, e de propósito:
   * a resposta depende da matrícula digitada, então guardá-la acertaria quase
   * nunca (08_Api.gs). Cada conferência é uma execução do Apps Script — piso
   * medido de ~1,7s, pior sob carga — e não há nada no navegador que encurte
   * isso. O que dá para fazer é PERGUNTAR MENOS VEZES, e é o que está aqui:
   *
   *   - veredito já recebido nesta página não é perguntado de novo
   *     (`matriculasConferidas`). Antes só o último "sim" era lembrado, então
   *     trocar de projeto, voltar ao campo ou clicar em Confirmar mandava tudo
   *     de novo para o servidor e o aluno esperava outra vez pela mesma resposta;
   *   - pergunta idêntica já em voo é aproveitada (`conferenciaEmVoo`). Sair do
   *     campo e clicar em "Confirmar inscrição" logo em seguida são dois
   *     pedidos da mesma coisa, com a segunda espera inteiramente à toa.
   *
   * A memória vive só nesta página: recarregar descarta tudo. É o que dá para o
   * caso da secretaria importar a lista no meio do evento — um F5 volta a
   * perguntar. E ela não decide nada: o POST reconfere a matrícula contra a
   * lista antes de gravar (`checarMatriculaNaLista_`, 04_Inscricoes.gs).
   *
   * O que NÃO se guarda é o "não deu para conferir": indisponibilidade é
   * momentânea, e lembrá-la manteria o aluno sem conferência o resto da visita.
   */
  function conferirMatricula() {
    var valor = document.getElementById('matricula').value.replace(/[^A-Za-z0-9]/g, '');

    // Projeto que não exige matrícula da lista não passa por conferência.
    if (ESTADO.projetoAtual && ESTADO.projetoAtual.validar_matricula === false) {
      marcarMatricula(valor ? 'vazio' : (ESTADO.exigirMatricula ? 'faltando' : 'vazio'));
      return Promise.resolve(!!valor || !ESTADO.exigirMatricula);
    }

    if (!valor) {
      marcarMatricula(ESTADO.exigirMatricula ? 'faltando' : 'vazio');
      return Promise.resolve(false);
    }
    if (valor.length < 4 || valor.length > 20) {
      marcarMatricula('formato');
      return Promise.resolve(false);
    }

    // A chave leva o projeto junto porque a resposta depende dele: projeto que
    // não valida matrícula recebe `validaProjeto: false` para a MESMA matrícula.
    var chave = valor + '|' + (ESTADO.projetoAtual ? ESTADO.projetoAtual.id : '');

    var lembrado = ESTADO.matriculasConferidas[chave];
    if (lembrado) {
      ESTADO.matricula.valor = valor;
      ESTADO.matricula.bloqueia = lembrado.bloqueia;
      marcarMatricula(lembrado.estado);
      return Promise.resolve(lembrado.libera);
    }

    if (ESTADO.conferenciaEmVoo && ESTADO.conferenciaEmVoo.chave === chave) {
      return ESTADO.conferenciaEmVoo.promessa;
    }

    marcarMatricula('conferindo');

    var proj = ESTADO.projetoAtual ? '&p=' + encodeURIComponent(ESTADO.projetoAtual.id) : '';
    var promessa = buscar('?api=matricula&m=' + encodeURIComponent(valor) + proj)
      .then(function (r) {
        ESTADO.conferenciaEmVoo = null;
        ESTADO.matricula.valor = valor;

        var veredito = vereditoDaMatricula(r);
        ESTADO.matricula.bloqueia = veredito.bloqueia;
        if (veredito.lembrar) ESTADO.matriculasConferidas[chave] = veredito;

        marcarMatricula(veredito.estado);
        return veredito.libera;
      })
      .catch(function () {
        ESTADO.conferenciaEmVoo = null;
        marcarMatricula('sem-conferencia');
        return true;
      });

    ESTADO.conferenciaEmVoo = { chave: chave, promessa: promessa };
    return promessa;
  }

  /** O que a resposta do servidor significa para a tela e para o envio. */
  function vereditoDaMatricula(r) {
    // Sem resposta, sem lista importada ou consulta indisponível: libera.
    // Barrar aluno legítimo por causa de indisponibilidade seria pior.
    if (!r || !r.ok || r.indisponivel || r.validaProjeto === false || r.listaDisponivel === false) {
      return { estado: 'sem-conferencia', libera: true, bloqueia: false, lembrar: false };
    }

    // O servidor reprovou o FORMATO. Isto precisa de ramo próprio: sem ele a
    // resposta caía na linha de "não encontrada" lá embaixo e, como a resposta
    // de formato não trazia `bloqueia`, o aluno via a mensagem permissiva e
    // seguia. Foi assim que `0000000` passou.
    //
    // O servidor também passou a mandar `bloqueia: true` nesse caso — os dois
    // lados corrigidos de propósito, porque cada um sozinho já bastaria e a
    // próxima mudança pode desfazer um deles.
    if (r.valida === false) {
      return { estado: 'formato', libera: false, bloqueia: true, lembrar: true };
    }

    if (r.existe) {
      return { estado: 'ok', libera: true, bloqueia: !!r.bloqueia, lembrar: true };
    }

    return {
      estado: r.bloqueia ? 'nao-encontrada' : 'nao-encontrada-aviso',
      libera: !r.bloqueia,
      bloqueia: !!r.bloqueia,
      lembrar: true
    };
  }

  var MENSAGEM_MATRICULA = {
    faltando: 'Informe sua matrícula.',
    formato: 'Matrícula inválida. Confira o número no seu portal do aluno.',
    'nao-encontrada': 'Matrícula não encontrada na lista de alunos matriculados. ' +
      'Confira o número digitado — se estiver certo, procure a coordenação do CESUTECH.',
    'nao-encontrada-aviso': 'Não localizamos esta matrícula na lista oficial. ' +
      'Você pode seguir, mas a coordenação vai conferir depois.'
  };

  function marcarMatricula(estado) {
    ESTADO.matricula.estado = estado;

    var campo = document.getElementById('matricula');
    var erro = document.getElementById('erro-matricula');
    var selo = document.getElementById('selo-matricula');

    var ruim = ['faltando', 'formato', 'nao-encontrada'].indexOf(estado) !== -1;
    campo.setAttribute('aria-invalid', ruim ? 'true' : 'false');
    campo.classList.toggle('campo--ok', estado === 'ok');

    erro.textContent = MENSAGEM_MATRICULA[estado] || '';
    erro.classList.toggle('visivel', !!MENSAGEM_MATRICULA[estado]);
    erro.classList.toggle('erro-campo--aviso', estado === 'nao-encontrada-aviso');

    // Dizer O QUE está acontecendo, e não só que algo está: a espera é do
    // servidor, chega a alguns segundos, e um "conferindo..." parado numa tela
    // parada é o que faz o aluno achar que travou. O resto do formulário
    // continua preenchível enquanto isto roda — a conferência nunca bloqueia.
    campo.setAttribute('aria-busy', estado === 'conferindo' ? 'true' : 'false');

    selo.textContent = {
      conferindo: 'conferindo na lista oficial...',
      ok: '\u2713 matrícula conferida',
      'sem-conferencia': 'não foi possível conferir agora'
    }[estado] || '';
    selo.className = 'selo-matricula' +
      (estado === 'ok' ? ' selo-matricula--ok' : '') +
      (estado === 'conferindo' ? ' selo-matricula--carregando' : '');
  }

  // ---------------------------------------------------------------- Validação
  // Espelha 04_Inscricoes.gs. O servidor revalida tudo — isto é conveniência
  // para o aluno, não segurança.

  function validar() {
    var ok = true;


    ok = marcarErro('nome', valor('nome').split(/\s+/).filter(Boolean).length < 2) && ok;
    ok = marcarErro('curso_fase', !valor('curso_fase')) && ok;
    ok = marcarErro('email', !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(valor('email'))) && ok;

    var tel = digitos('whatsapp');
    ok = marcarErro('whatsapp', tel.length < 10 || tel.length > 11) && ok;

    var ciencia = document.getElementById('declara_ciencia').checked;
    document.getElementById('erro-declaracao').classList.toggle('visivel', !ciencia);
    if (!ciencia) ok = false;

    var lgpd = document.getElementById('consentimento_lgpd').checked;
    document.getElementById('erro-lgpd').classList.toggle('visivel', !lgpd);
    if (!lgpd) ok = false;

    if (!ok) {
      var primeiro = document.querySelector('#formulario [aria-invalid="true"]');
      if (primeiro) primeiro.focus();
    }
    return ok;
  }

  function marcarErro(campo, temErro) {
    var input = document.getElementById(campo);
    var erro = document.getElementById('erro-' + campo);
    if (input) input.setAttribute('aria-invalid', temErro ? 'true' : 'false');
    if (erro) erro.classList.toggle('visivel', temErro);
    return !temErro;
  }

  // ---------------------------------------------------------------- Envio

  function enviar(ev) {
    ev.preventDefault();
    esconder('erro-geral');

    // A conferência é assíncrona: garante que ela terminou antes de decidir.
    conferirMatricula().then(function (matriculaOk) {
      if (!matriculaOk) {
        document.getElementById('matricula').focus();
        falhar('Informe uma matrícula válida para concluir a inscrição.');
        return;
      }
      if (!validar()) return;
      enviarDeVerdade();
    });
  }

  function enviarDeVerdade() {

    iniciarEspera();

    var p = ESTADO.projetoAtual;
    // OS TRÊS CONSENTIMENTOS VÃO COMO O ALUNO OS DEIXOU, cada um por conta
    // própria — inclusive `autoriza_imagem: false`, que é uma resposta legítima
    // e não um campo faltando. Ver o comentário das caixas em index.html: manter
    // cada aceite como escolha separada foi decisão deliberada de 06/08/2026.
    // Quem exige o quê está em `validarInscricao` (04_Inscricoes.gs): ciência e
    // LGPD são obrigatórios, imagem não.
    var dados = {
      acao: 'inscricao',
      projeto_id: p.id,
      matricula: valor('matricula'),
      nome: valor('nome'),
      curso_fase: valor('curso_fase'),
      email: valor('email'),
      whatsapp: digitos('whatsapp'),
      declara_ciencia: document.getElementById('declara_ciencia').checked,
      autoriza_imagem: document.getElementById('autoriza_imagem').checked,
      consentimento_lgpd: document.getElementById('consentimento_lgpd').checked,
      website: valor('website'),                      // honeypot
      tempoPreenchimento: Date.now() - ESTADO.momentoInicio
    };

    // SEM `signal` E SEM TEMPO-LIMITE, ao contrário de `buscar` — e quem vier
    // "uniformizar" isto precisa ler antes: a gravação é serializada no
    // servidor e o p95 medido passou de 45s (ver `FASES_ESPERA`), então um
    // limite de dez segundos abortaria inscrição que ia dar certo. Pior: abortar
    // não cancela nada do lado de lá, e a tela ficaria sem saber se a vaga foi
    // reservada. A espera longa é ruim; a dúvida é pior, e é irreversível.
    fetch(CFG.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(dados),
      redirect: 'follow'
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        restaurarBotao();
        if (!r || !r.ok) {
          // Se lotou enquanto o aluno preenchia, atualiza a tela em vez de só
          // mostrar erro — assim ele vê a situação real e escolhe outro.
          if (r && r.situacao && r.situacao !== 'ABERTO') {
            p.situacao = r.situacao;
            if (r.situacao === 'ESGOTADO') p.restantes = 0;
            // O formulário sai da tela AQUI, e não mais de dentro de
            // `renderizarCartaoVagas`: aquele esconder implícito fechava o
            // formulário toda vez que o cartão fosse redesenhado — inclusive
            // quando a renovação da lista chega no meio do preenchimento, que
            // agora acontece a cada navegação. Neste caminho ele deve mesmo
            // sumir: a vaga acabou, não há o que enviar.
            esconder('area-formulario');
            renderizarCartaoVagas(p);
            renderizarLista();
            encerrarEspera();
            // Sem esta mensagem o aluno vê o formulário sumir logo depois de
            // clicar em "Confirmar" e pode ler isso como sucesso. Ele precisa
            // saber que a inscrição DELE não entrou.
            anunciarPerdaDeVaga(r);
            window.scrollTo(0, 0);
            return;
          }
          falhar((r && r.erro) || 'Não foi possível registrar a inscrição.');
          return;
        }
        concluir(r);
      })
      .catch(function () {
        restaurarBotao();
        falhar('Não conseguimos falar com o servidor. Verifique sua conexão e tente novamente.');
      });
  }

  /**
   * Avisa que a inscrição não entrou porque a situação do projeto mudou
   * enquanto o aluno preenchia — tipicamente a última vaga sendo levada por
   * outra pessoa que enviou primeiro.
   */
  function anunciarPerdaDeVaga(r) {
    var el = document.getElementById('aviso-perda-vaga');

    el.innerHTML = '';
    var titulo = document.createElement('strong');
    titulo.textContent = r.situacao === 'ESGOTADO'
      ? 'Sua inscrição não foi concluída — as vagas acabaram agora.'
      : 'Sua inscrição não foi concluída — as inscrições foram encerradas.';
    el.appendChild(titulo);

    var detalhe = document.createElement('span');
    detalhe.style.display = 'block';
    detalhe.style.marginTop = '4px';
    detalhe.textContent = r.situacao === 'ESGOTADO'
      ? 'A última vaga foi preenchida por outra pessoa enquanto você preenchia o ' +
        'formulário. Seus dados NÃO foram registrados neste projeto. Escolha outro ' +
        'projeto na lista.'
      : (r.erro || 'Procure a coordenação do CESUTECH.');
    el.appendChild(detalhe);

    el.classList.remove('oculto');
    el.focus();
  }

  function concluir(r) {
    var p = ESTADO.projetoAtual;

    encerrarEspera();
    esconder('area-formulario');
    esconder('cartao-vagas');
    mostrar('painel-sucesso');

    texto('sucesso-titulo', r.duplicada ? 'Você já estava inscrito' : 'Inscrição registrada');
    texto('sucesso-texto', r.mensagem + (r.duplicada ? '' :
      ' A coordenação entrará em contato pelo e-mail informado. Fique atento à sua caixa de entrada.'));

    var aviso = document.getElementById('sucesso-aviso');
    if (r.aviso) { aviso.textContent = r.aviso; aviso.classList.remove('oculto'); }
    else aviso.classList.add('oculto');

    var protocolo = document.getElementById('sucesso-protocolo');
    if (r.protocolo) {
      protocolo.textContent = 'Protocolo: ' + r.protocolo;
      protocolo.classList.remove('oculto');
    } else protocolo.classList.add('oculto');

    preencherResumoDoProjeto(p);

    // A partir daqui este navegador sabe que o aluno entrou neste projeto —
    // é o que troca o botão pela confirmação quando ele voltar aqui.
    lembrarInscricao(p.codigo, r.protocolo);

    document.getElementById('formulario').reset();
    window.scrollTo(0, 0);
    renovarProjetos();
  }

  /**
   * O comprovante: os dados do projeto dentro do cartão de inscrição registrada.
   *
   * Pensado como a tela que o aluno fotografa com o celular. Tudo o que ele
   * precisa para aparecer no primeiro encontro — qual projeto, com quem, onde,
   * quando — tem de caber nessa foto, junto do protocolo. Antes o cartão trazia
   * só a mensagem e o número, e para saber o horário era preciso voltar à lista
   * e achar o projeto de novo.
   *
   * São os MESMOS campos do detalhe, pela mesma função (`preencherFicha`), e só
   * os que existirem: projeto sem horário não mostra rótulo órfão.
   */
  function preencherResumoDoProjeto(p) {
    var bloco = document.getElementById('sucesso-projeto');
    if (!p) { bloco.classList.add('oculto'); return; }

    texto('sucesso-projeto-nome', p.nome);
    textoComQuebras('sucesso-projeto-orientacao', p.descricao_formulario);

    bloco.classList.remove('oculto');
  }

  /**
   * Fases da espera.
   *
   * A gravação é serializada no servidor, e sob carga o p95 medido passou de
   * 45s. Um botão parado em "Enviando..." por quase um minuto parece travado —
   * e aluno que acha que travou fecha a página ou clica de novo.
   *
   * As mensagens são baseadas no tempo REAL decorrido. Não há posição de fila
   * a mostrar: o servidor não sabe quantos estão à frente, e inventar um número
   * seria pior que não mostrar nada.
   */
  var FASES_ESPERA = [
    { apos: 0,     texto: 'Enviando sua inscrição...' },
    { apos: 6000,  texto: 'Muita gente se inscrevendo agora. Aguarde — sua inscrição está na fila.' },
    { apos: 18000, texto: 'Ainda processando. Não feche esta página nem envie de novo: ' +
                          'sua vaga está sendo reservada.' },
    { apos: 40000, texto: 'A fila está longa, mas sua inscrição continua sendo processada. ' +
                          'Aguarde mais um pouco.' }
  ];

  function iniciarEspera() {
    var botao = document.getElementById('botao-enviar');
    botao.disabled = true;
    botao.textContent = 'Enviando...';

    var aviso = document.getElementById('status-envio');
    aviso.className = 'aviso aviso--info';
    aviso.textContent = FASES_ESPERA[0].texto;
    aviso.classList.remove('oculto');

    var comeco = Date.now();
    ESTADO.timerEspera = setInterval(function () {
      var passou = Date.now() - comeco;
      var fase = FASES_ESPERA[0];
      FASES_ESPERA.forEach(function (f) { if (passou >= f.apos) fase = f; });

      aviso.textContent = fase.texto +
        (passou > 6000 ? ' (' + Math.round(passou / 1000) + 's)' : '');
    }, 1000);

    // Enquanto a inscrição está em voo, fechar a página é perda de vaga.
    ESTADO.avisarAoSair = function (ev) {
      ev.preventDefault();
      ev.returnValue = '';
    };
    window.addEventListener('beforeunload', ESTADO.avisarAoSair);
  }

  function encerrarEspera() {
    if (ESTADO.timerEspera) {
      clearInterval(ESTADO.timerEspera);
      ESTADO.timerEspera = null;
    }
    if (ESTADO.avisarAoSair) {
      window.removeEventListener('beforeunload', ESTADO.avisarAoSair);
      ESTADO.avisarAoSair = null;
    }
    esconder('status-envio');
  }

  function restaurarBotao() {
    encerrarEspera();
    var botao = document.getElementById('botao-enviar');
    botao.disabled = false;
    botao.textContent = 'Confirmar inscrição';
  }

  function falhar(mensagem) {
    var el = document.getElementById('erro-geral');
    el.textContent = mensagem;
    el.classList.remove('oculto');
    el.scrollIntoView({ block: 'center' });
  }

  // ---------------------------------------------------------------- Helpers

  function mascaraTelefone(v) {
    var d = v.replace(/\D/g, '').slice(0, 11);
    if (d.length > 10) return d.replace(/(\d{2})(\d{5})(\d{1,4})/, '($1) $2-$3');
    if (d.length > 6) return d.replace(/(\d{2})(\d{4})(\d{1,4})/, '($1) $2-$3');
    if (d.length > 2) return d.replace(/(\d{2})(\d{1,5})/, '($1) $2');
    if (d.length > 0) return '(' + d;
    return d;
  }

  /**
   * O banner pode vir de duas fontes: nome de arquivo do repositório ou
   * URL completa (imagem enviada ao Drive pelo painel).
   */
  function urlBanner(valor) {
    if (!valor) return '';
    return /^https?:\/\//.test(valor) ? valor : 'assets/banners/' + valor;
  }

  /**
   * Mostra 'aaaa-mm-dd' como 'dd/mm/aaaa'.
   * Valores gravados antes de as abas virarem formato texto foram convertidos
   * pelo Sheets e voltam em ISO; quem lê o site espera o formato daqui.
   * Qualquer outro texto passa intacto — o campo é livre.
   */
  function paraDataBr(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
    return m ? m[3] + '/' + m[2] + '/' + m[1] : v;
  }

  function valor(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }
  function digitos(id) { return valor(id).replace(/\D/g, ''); }
  function texto(id, v) {
    var el = document.getElementById(id);
    if (el) el.textContent = v || '';
  }

  /**
   * Texto puro em que as QUEBRAS DE LINHA aparecem — e só elas.
   *
   * O problema é o de sempre, nas duas pontas: `innerHTML` desenharia a quebra e
   * junto desenharia tudo o mais que viesse escrito (um `<script>` colado no
   * campo do painel por descuido ou por graça roda no navegador de cada um dos
   * 500 alunos); `textContent` é seguro e engole as quebras, porque o HTML
   * colapsa espaço em branco — o professor escreve três parágrafos e a tela
   * mostra um bloco só.
   *
   * A saída aqui é montar o parágrafo no DOM: uma linha por vez, cada uma num
   * `<span>` com `textContent`, separadas por `<br>` CRIADOS AQUI. O `<br>` é
   * nosso, não do banco — nenhum caractere vindo do campo é interpretado, em
   * nenhum caminho.
   *
   * Por que não `white-space: pre-line`, que faria o mesmo com uma linha só:
   * porque a garantia passaria a morar no CSS, longe de quem a escreve, e uma
   * mexida na folha de estilo (ou um estilo inline que alguém "limpa") a
   * apagaria sem nada ficar vermelho. Aqui a quebra e a proteção contra HTML são
   * a mesma linha de código, e é essa a razão da escolha.
   *
   * Devolve se sobrou texto — e esconde o elemento quando não sobrou, para
   * projeto sem orientação não abrir um espaço vazio no meio do formulário.
   */
  function textoComQuebras(id, v) {
    var el = document.getElementById(id);
    if (!el) return false;

    el.innerHTML = '';
    var conteudo = (v === null || v === undefined) ? '' : String(v).trim();
    el.classList.toggle('oculto', !conteudo);
    if (!conteudo) return false;

    conteudo.split(/\r\n|\r|\n/).forEach(function (linha, i) {
      if (i) el.appendChild(document.createElement('br'));
      var pedaco = document.createElement('span');
      pedaco.textContent = linha;
      el.appendChild(pedaco);
    });
    return true;
  }
  function mostrar(id) { document.getElementById(id).classList.remove('oculto'); }
  function esconder(id) { document.getElementById(id).classList.add('oculto'); }

  function preencherSelect(id, opcoes, textoVazio) {
    var el = document.getElementById(id);
    el.innerHTML = '';
    var vazio = document.createElement('option');
    vazio.value = '';
    vazio.textContent = textoVazio;
    el.appendChild(vazio);
    (opcoes || []).forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      el.appendChild(opt);
    });
  }

  function preencherRodape() {
    var contato = CFG.contato || {};
    if (contato.email) {
      var link = document.getElementById('link-email');
      link.textContent = contato.email;
      link.href = 'mailto:' + contato.email;
    }
    if (contato.instituicao) {
      texto('rodape-instituicao', contato.instituicao);
    }
  }
})();
