/**
 * painel-site.js — o painel MUDOU DE CASA, e é isto que prova a mudança.
 *
 * Em 07/08/2026 o painel de gestão saiu de `apps-script/Admin.html` — servido
 * pelo próprio Apps Script em `/exec?p=admin` — para `docs/painel/index.html`,
 * servido pelo GitHub Pages. As telas são as mesmas; o que mudou foi o
 * transporte (`google.script.run` virou um POST) e a forma de entrar (ganhou o
 * botão de conta Google, que só é possível fora do Apps Script).
 *
 * Os testes de CLIQUE dessa tela continuam em `painel-navegador.js`, e eles não
 * mudaram uma linha: a mudança foi de encanamento, e é exatamente isso que os 23
 * testes de lá, verdes contra o arquivo novo e o caminho novo, afirmam. Aqui
 * ficam as coisas que só existem por causa da mudança:
 *
 *   1. a página é uma página de verdade, e não um template do Apps Script;
 *   2. o transporte — envelope, cabeçalho, onde viaja o token;
 *   3. entrar com conta Google, do botão à sessão;
 *   4. a tela de quem tem acesso;
 *   5. o endereço antigo, que agora leva ao novo;
 *   6. o site do ALUNO, que não pode ter sido tocado.
 *
 * O QUE NENHUM TESTE DAQUI PROVA, e está escrito para não ser confundido:
 * nenhuma linha deste arquivo fala com o Google, com o GitHub Pages ou com um
 * navegador. O `google.accounts.id` daqui é falso e não valida coisa alguma —
 * quem valida é `verificarIdTokenGoogle_` (07_Auth.gs), contra o `tokeninfo` do
 * Google, e disso quem tem testes é `acesso.js`. O que se prova aqui é o
 * caminho: que a credencial recebida vira a chamada certa, e que a resposta do
 * servidor vira a tela certa.
 *
 * Uso:  node testes/painel-site.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { teste, grupo, igual, verdadeiro, resultado } = require('./apoio');
const { abrirPainel, jaResolvido, respostaHttp, travada } = require('./dom-painel');

const RAIZ = path.join(__dirname, '..');
const PAGINA = fs.readFileSync(path.join(RAIZ, 'docs', 'painel', 'index.html'), 'utf8');
const CSS_PAINEL = fs.readFileSync(path.join(RAIZ, 'docs', 'painel', 'estilos.css'), 'utf8');
const ESTILOS_GS = fs.readFileSync(path.join(RAIZ, 'apps-script', 'Estilos.html'), 'utf8');
const STUB = fs.readFileSync(path.join(RAIZ, 'apps-script', 'Admin.html'), 'utf8');
const CONFIG_JS = fs.readFileSync(path.join(RAIZ, 'docs', 'assets', 'config.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(RAIZ, 'docs', 'assets', 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(RAIZ, 'docs', 'index.html'), 'utf8');

const CLIENT_ID = '111222333-abcxyz.apps.googleusercontent.com';

/** Um ID token tem três segmentos base64url. O conteúdo não importa aqui. */
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.YXNzaW5hdHVyYQ';

// ------------------------------------------------------------ Apoio local

/**
 * A tela de LOGIN, como ela chega ao professor: sem sessão guardada e com o
 * servidor sem enxergar quem acessa.
 *
 * `usuario: ''` não é detalhe: é o que o Apps Script devolve numa requisição
 * anônima vinda do GitHub Pages. Com um usuário visível e autorizado, o servidor
 * entra sozinho pelo caminho 1 de `autenticar` (07_Auth.gs) e o teste provaria
 * um caminho que este painel nunca percorre.
 */
function telaDeLogin(opcoes) {
  const cfg = opcoes || {};
  return abrirPainel({
    deslogado: true,
    // `usuario` só é passado nos testes que precisam da implantação Workspace,
    // onde o Apps Script entrega a identidade de quem acessa. O padrão continua
    // sendo o vazio, que é o que a produção devolve.
    usuario: cfg.usuario === undefined ? '' : cfg.usuario,
    semGis: cfg.semGis,
    configuracao: cfg.configuracao,
    busca: cfg.busca,
    respostas: cfg.respostas,
    semear: (api, amb) => {
      api.semearConfigPadrao_();
      api.gravarConfig('admin_emails', cfg.allowlist === undefined ? 'coord@exemplo.com' : cfg.allowlist);
      if (cfg.clientId !== null) amb.propriedades.set('GOOGLE_CLIENT_ID', cfg.clientId || CLIENT_ID);

      // O `apoio.js` nasceu antes de o sistema enviar e-mail e não tem `MailApp`.
      // Sem este falso, `enviarLink_` estoura, `pedirLinkDeAcesso` cai no próprio
      // `catch` e devolve... a mesma frase de sempre — que é o desfecho que
      // nenhum teste conseguiria distinguir do bom. Guardar as mensagens é o que
      // permite ler o token do CORPO do e-mail, como quem abre a caixa de entrada.
      //
      // As duas opções abaixo produzem o `linkDisponivel: false` do servidor
      // pelos caminhos de VERDADE (`linkDeAcessoDisponivel_`, 07b_LinkPorEmail.gs),
      // em vez de encenar a resposta: `cota: 0` é a cota diária esgotada, e
      // `semEscopoEmail` é a implantação recém-atualizada em que ninguém
      // autorizou `script.send_mail` ainda — ali o próprio `MailApp` estoura.
      api.MailApp = {
        getRemainingDailyQuota: () => {
          if (cfg.semEscopoEmail) throw new Error('Authorization required: script.send_mail');
          return cfg.cota === undefined ? 100 : cfg.cota;
        },
        sendEmail: (mensagem) => { (cfg.emails || []).push(mensagem); }
      };
    }
  });
}

/**
 * A resposta única de `pedirLinkDeAcesso` — a mesma para todos os desfechos.
 *
 * Copiada de LINK_RESPOSTA_UNICA (07b_LinkPorEmail.gs) de propósito: o que os
 * testes daqui provam é que a TELA repete o que o servidor mandou, seja lá o que
 * for. Se um dia a frase do servidor mudar e esta não, nenhum teste daqui quebra
 * — e é isso mesmo, porque nenhum deles afirma qual é a frase certa.
 */
const FRASE_DO_LINK =
  'Se este endereço estiver autorizado, enviamos um link de acesso para ele. ' +
  'Confira a caixa de entrada e, se não achar, o spam. O link vale por 15 minutos.';

/** Um token de link como o servidor emite: 64 hexadecimais. */
const TOKEN_LINK = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** O painel já aberto, com a allowlist que o teste pedir. */
function painelAberto(allowlist, usuario) {
  return abrirPainel({
    usuario: usuario || 'coord@exemplo.com',
    semear: (api) => {
      api.semearConfigPadrao_();
      api.gravarConfig('admin_emails', allowlist);
    }
  });
}

/** A resposta que o `tokeninfo` do Google daria para um token bom. */
function tokenBom(cena, email, troca) {
  cena.tokeninfo.resposta = {
    codigo: 200,
    corpo: Object.assign({
      aud: CLIENT_ID,
      iss: 'https://accounts.google.com',
      exp: String(Math.floor(new Date().getTime() / 1000) + 3600),
      email: email,
      email_verified: 'true'
    }, troca || {})
  };
}

/** O corpo JSON da enésima requisição que saiu pela rede. */
function corpoDa(cena, n) {
  return JSON.parse(cena.requisicoesHttp[n].corpo);
}

/**
 * O corpo da última requisição de uma função específica.
 *
 * Pegar "a última que saiu" não serve para o login: uma entrada bem-sucedida
 * abre o painel, que já dispara `painelEstatisticas` — e o teste leria o
 * envelope errado achando que leu o do login.
 */
function corpoDe(cena, fn) {
  for (let i = cena.requisicoesHttp.length - 1; i >= 0; i--) {
    const corpo = corpoDa(cena, i);
    if (corpo.fn === fn) return corpo;
  }
  throw new Error('nenhuma requisição chamou ' + fn);
}

function escondido(cena, id) {
  return String(cena.elemento(id).className).indexOf('oculto') !== -1;
}

// ================================================ 1. A página mudou de casa

grupo('a página é uma página, e não mais um template do Apps Script');

teste('docs/painel/index.html é HTML completo e não tem scriptlet nenhum', () => {
  verdadeiro(/^<!DOCTYPE html>/i.test(PAGINA), 'sem doctype o navegador entra em modo peculiar');
  verdadeiro(/<html lang="pt-BR">/.test(PAGINA));
  verdadeiro(/<\/body>\s*<\/html>\s*$/.test(PAGINA));

  // `<?!= include('Estilos') ?>` só é resolvido por `HtmlService`. No Pages ele
  // chegaria ao navegador como texto literal, e a página nasceria sem estilo
  // nenhum com aquilo escrito na primeira linha.
  igual(PAGINA.indexOf('<?'), -1, 'sobrou scriptlet do Apps Script na página servida pelo Pages');
});

teste('a página carrega o estilo, o config.js e a biblioteca do Google', () => {
  verdadeiro(/<link rel="stylesheet" href="estilos.css">/.test(PAGINA),
    'sem o CSS servido como arquivo, a página fica sem estilo nenhum');
  verdadeiro(/<script src="\.\.\/assets\/config\.js"><\/script>/.test(PAGINA),
    'o endpoint sai do config.js do site — o mesmo do formulário do aluno');
  verdadeiro(/<script src="https:\/\/accounts\.google\.com\/gsi\/client" async defer><\/script>/.test(PAGINA),
    'sem a biblioteca do Google não há botão de entrar com conta');
});

teste('o config.js do site é carregado ANTES do código do painel', () => {
  // Ordem invertida = `CFG` vazio = `ENDPOINT` vazio na carga, e o painel
  // desenharia a tela de "endereço não configurado" num sistema configurado.
  verdadeiro(PAGINA.indexOf('assets/config.js') < PAGINA.indexOf('var TOKEN = null;'),
    'o painel leria a configuração antes de ela existir');
});

teste('as oito abas vieram inteiras para a casa nova', () => {
  ['painel', 'projetos', 'disciplinas', 'alunos', 'importar', 'lotes', 'log', 'config']
    .forEach((aba) => {
      verdadeiro(PAGINA.indexOf('data-aba="' + aba + '"') !== -1, 'sumiu a aba ' + aba);
      verdadeiro(PAGINA.indexOf('id="secao-' + aba + '"') !== -1, 'sumiu a seção da aba ' + aba);
    });
});

teste('o CSS do painel é o gêmeo EXATO do Estilos.html', () => {
  // Duas cópias do mesmo CSS é o começo de duas telas que divergem em silêncio —
  // e como não dá para servir o `Estilos.html` no Pages (é um include do Apps
  // Script) nem servir o CSS do Pages dentro do iframe do Google Sites (que
  // bloqueia recurso externo), a cópia é o preço. Este teste é o que impede que
  // ela vire duas coisas diferentes: quem editar um lado tem de editar o outro,
  // e o comando está escrito no cabeçalho do Estilos.html.
  const miolo = ESTILOS_GS.slice(
    ESTILOS_GS.indexOf('<style>') + '<style>\n'.length,
    ESTILOS_GS.lastIndexOf('</style>')
  );
  igual(CSS_PAINEL, miolo,
    'docs/painel/estilos.css saiu de sincronia com apps-script/Estilos.html');
});

teste('a página do painel pede para não ser indexada', () => {
  // Ela é pública (o endereço antigo também era, e sem login), mas não há razão
  // para ela aparecer em busca: quem a procura já recebeu o endereço.
  verdadeiro(/<meta name="robots" content="noindex, nofollow">/.test(PAGINA));
});

// ==================================================== 2. O transporte

grupo('o POST que substituiu o google.script.run');

teste('a primeira coisa que o painel faz é perguntar como se entra, por POST', () => {
  const cena = telaDeLogin();
  const req = cena.requisicoesHttp[0];

  igual(req.metodo, 'POST');
  igual(corpoDa(cena, 0), { acao: 'login', fn: 'modoDeAcesso' });
});

teste('o cabeçalho é text/plain — com JSON a requisição morreria no navegador', () => {
  // Não é preferência: `application/json` torna a requisição "não simples", o
  // navegador manda um OPTIONS antes, e o Apps Script não responde OPTIONS. A
  // chamada morre dentro do navegador, sem chegar ao servidor e sem deixar erro.
  // É o mesmo contrato do formulário do aluno (docs/assets/app.js) e do
  // servidor (08_Api.gs) — os três têm de dizer a mesma coisa.
  const cena = telaDeLogin();
  igual(cena.requisicoesHttp[0].tipo, 'text/plain;charset=utf-8');

  verdadeiro(/'Content-Type': 'text\/plain;charset=utf-8'/.test(PAGINA));
  verdadeiro(/'Content-Type': 'text\/plain;charset=utf-8'/.test(APP_JS),
    'o site do aluno mudou de contrato — os dois lados precisam concordar');
});

teste('o token viaja no CORPO, e não num cabeçalho Authorization', () => {
  // Um `Authorization` produziria o mesmo OPTIONS que o `application/json`. O
  // servidor documenta isso em 08_Api.gs e nunca lê cabeçalho nenhum.
  const cena = painelAberto('coord@exemplo.com');
  const req = cena.requisicoesHttp[cena.requisicoesHttp.length - 1];

  // A busca é pela forma de CABEÇALHO (o nome entre aspas, como chave), e não
  // pela palavra: ela aparece de propósito no comentário que explica por que o
  // cabeçalho não pode existir.
  igual(/['"]Authorization['"]/.test(PAGINA), false,
    'apareceu cabeçalho Authorization no painel — ele dispararia o OPTIONS que mata a chamada');
  verdadeiro(String(req.corpo).indexOf(cena.token) !== -1, 'o token não viajou no corpo');
});

teste('as chamadas do painel usam o envelope de painel, com o token fora de `dados`', () => {
  const cena = painelAberto('coord@exemplo.com');
  cena.js.trocarAba('log');

  const corpo = corpoDa(cena, cena.requisicoesHttp.length - 1);
  igual(corpo.acao, 'painel');
  igual(corpo.fn, 'listarLog');
  igual(corpo.token, cena.token);
  // O servidor carimba o token por cima do payload (`rotaDoPainel_`). Mandá-lo
  // dentro de `dados` também criaria dois tokens na mesma requisição, com o
  // cliente escolhendo qual vale.
  igual(corpo.dados.token, undefined, 'o token foi duplicado dentro de `dados`');
});

teste('as de login usam o envelope de login, sem token de sessão', () => {
  const cena = telaDeLogin({ respostas: { pedirLinkDeAcesso: { ok: true, mensagem: FRASE_DO_LINK } } });

  cena.js.abrirPedidoDeLink();
  cena.digitar('email-link', 'coord@exemplo.com');
  cena.js.enviarPedidoDeLink();

  igual(corpoDe(cena, 'pedirLinkDeAcesso'),
    { acao: 'login', fn: 'pedirLinkDeAcesso', email: 'coord@exemplo.com' });
});

teste('sem endpoint no config.js, a tela diz o que preencher', () => {
  // A falha genérica de rede aqui seria cruel: o sistema está no ar, e o que
  // falta é uma linha num arquivo. Foi o primeiro erro de quem publicou o site
  // do aluno, e ele já tem tratamento próprio (`aviso-config` no index.html).
  const cena = telaDeLogin({ configuracao: (cfg) => { cfg.endpoint = ''; } });

  igual(cena.requisicoesHttp.length, 0, 'saiu requisição para endereço nenhum');

  // E a mensagem tem de pousar na tela do LOGIN. `avisar` escreve dentro do
  // painel, que aqui está escondido: ela existiria no HTML e ninguém a veria —
  // logo no erro mais provável de quem publica o site pela primeira vez.
  const erro = cena.texto('erro-login');
  verdadeiro(erro.indexOf('config.js') !== -1, 'a mensagem precisa dizer ONDE se conserta: ' + erro);
  verdadeiro(!escondido(cena, 'erro-login'), 'a mensagem foi escrita num lugar invisível');
});

teste('erro ao desenhar a tela não é relatado como erro de conexão', () => {
  // Armadilha que não existia no `google.script.run`: no `fetch`, um erro dentro
  // do callback que desenha cai no mesmo `.catch` da rede. Sem separar os dois,
  // todo defeito do painel viraria "erro de conexão" e o professor recarregaria
  // a página a tarde inteira atrás de um problema que não é de rede.
  const cena = painelAberto('coord@exemplo.com');

  cena.js.chamar('listarLog', {}, () => { throw new Error('quebrei ao desenhar'); });

  const msg = cena.texto('mensagem-global');
  verdadeiro(msg.indexOf('quebrou ao desenhá-la') !== -1, msg);
  verdadeiro(msg.indexOf('não da sua conexão') !== -1, msg);
});

teste('resposta que não é JSON vira mensagem, e não tela em branco', () => {
  // É o que chega quando a implantação está errada ou o script perdeu
  // autorização: o Apps Script devolve a PÁGINA DE ERRO dele, em HTML.
  const cena = painelAberto('coord@exemplo.com');
  cena.js.fetch = () => jaResolvido({
    ok: true,
    status: 200,
    json: () => { throw new Error('Unexpected token < in JSON at position 0'); }
  });

  cena.js.carregarLog();
  verdadeiro(cena.texto('mensagem-global').indexOf('implantação do Apps Script') !== -1,
    cena.texto('mensagem-global'));
});

// ========================================== 2b. A nova tentativa do `chamar()`

/**
 * O QUE ESTE BLOCO PROTEGE, e por que ele nasceu com data.
 *
 * Em 11/08, com o sistema no ar, a coordenação abriu a aba Configurações e leu
 * `Erro em "lerConfiguracoes": Failed to fetch.` — no mesmo minuto, medido do
 * terminal, o `/exec` respondia em 2,4 s e 24 requisições seguidas voltavam
 * todas em JSON. A falha foi transitória; ela virou erro definitivo na tela
 * porque `chamar()` fazia um `fetch` e não tentava de novo. A tela é a que a
 * coordenação usa DURANTE o evento.
 *
 * A repetição consertou isso, e trouxe junto um risco maior do que o problema:
 * `Failed to fetch` NÃO quer dizer que a requisição não chegou ao servidor —
 * quer dizer que ela não completou. Uma inscrição, uma reconciliação ou uma
 * importação repetida nesse estado grava duas vezes. Por isso só se repete o que
 * está em `SO_LEITURA`, e é isso que a maior parte dos testes daqui afirma. O do
 * meio — "escrita não é repetida" — é o freio: ele existe para falhar no dia em
 * que alguém "melhorar" a retentativa estendendo-a a tudo.
 */
grupo('a nova tentativa — e o que ela NUNCA repete');

/** Quantas requisições desta função saíram pela rede. */
function requisicoesDe(cena, fn) {
  return cena.requisicoesHttp.filter((r) => JSON.parse(r.corpo).fn === fn);
}

teste('leitura que falha na rede uma vez chega na segunda, e a tela mostra o resultado', () => {
  const cena = painelAberto('coord@exemplo.com');

  // A encenação se apaga sozinha ao ser usada: a primeira tentativa morre na
  // rede e a SEGUNDA percorre o `doPost` de verdade, contra o banco falso. É a
  // forma do que aconteceu na produção.
  cena.respostas.lerConfiguracoes = () => {
    delete cena.respostas.lerConfiguracoes;
    return null;
  };

  cena.js.trocarAba('config');
  igual(requisicoesDe(cena, 'lerConfiguracoes').length, 1, 'a primeira tentativa não saiu');

  cena.rodarTarefas();

  igual(requisicoesDe(cena, 'lerConfiguracoes').length, 2, 'a chamada não foi tentada de novo');
  verdadeiro(cena.texto('conteudo-config').indexOf('Parâmetros') !== -1,
    'a aba não desenhou o que veio na segunda tentativa: ' + cena.texto('conteudo-config'));
  igual(cena.texto('mensagem-global'), '',
    'sobrou aviso na tela depois de a segunda tentativa ter dado certo');
});

teste('ESCRITA que falha na rede sai UMA VEZ SÓ — repetir gravaria duas', () => {
  // O teste mais importante do lote. `Failed to fetch` não distingue "não
  // chegou" de "chegou, rodou e falhou na volta": uma segunda reconciliação
  // nesse estado é uma segunda execução no banco.
  const cena = painelAberto('coord@exemplo.com');
  cena.respostas.rodarReconciliacao = null;

  cena.js.reconciliarAgora();

  igual(requisicoesDe(cena, 'rodarReconciliacao').length, 1,
    'UMA ESCRITA FOI REPETIDA — isto grava duas vezes no banco');
  igual(cena.tarefas.length, 0, 'foi agendada uma nova tentativa de uma escrita');

  const msg = cena.texto('mensagem-global');
  verdadeiro(msg.indexOf('Erro em "rodarReconciliacao"') !== -1,
    'a falha da escrita não chegou à tela: ' + msg);
  verdadeiro(msg.indexOf('Tentei') === -1,
    'a mensagem diz ter tentado várias vezes uma chamada que saiu uma vez: ' + msg);

  // E o relógio andando não traz a segunda de volta.
  cena.rodarTarefas(2);
  igual(requisicoesDe(cena, 'rodarReconciliacao').length, 1, 'a escrita foi repetida depois');
});

teste('nenhuma função fora de SO_LEITURA é repetida — a lista inteira, lida do arquivo', () => {
  // A lista não é digitada aqui: ela sai do próprio painel. Uma função nova que
  // grave e que ninguém tenha declarado em `SO_LEITURA` entra neste teste
  // sozinha, no dia em que for escrita.
  const bloco = /var SO_LEITURA = \{([\s\S]*?)\};/.exec(PAGINA);
  verdadeiro(bloco !== null, 'SO_LEITURA sumiu do painel');
  const soLeitura = bloco[1].match(/[A-Za-z_$][\w$]*(?=\s*:)/g) || [];

  const todas = {};
  const chamadas = /chamar\(\s*([^,]+),/g;
  let achado;
  while ((achado = chamadas.exec(PAGINA)) !== null) {
    (achado[1].match(/'([a-zA-Z_]+)'/g) || []).forEach((n) => { todas[n.slice(1, -1)] = true; });
  }

  const naoRepetiveis = Object.keys(todas).filter((f) => soLeitura.indexOf(f) === -1);
  verdadeiro(naoRepetiveis.length >= 20,
    'a leitura do arquivo achou funções de menos: ' + naoRepetiveis.length);

  const cena = painelAberto('coord@exemplo.com');
  naoRepetiveis.forEach((fn) => {
    cena.respostas[fn] = null;      // a rede cai nesta função, sempre
    cena.requisicoesHttp.length = 0;
    cena.js.chamar(fn, {}, () => {});
    cena.rodarTarefas(3);
    igual(cena.requisicoesHttp.length, 1,
      fn + ' foi repetida sem estar em SO_LEITURA — se ela grava, gravou duas vezes');
  });
});

teste('quando todas as tentativas falham, a mensagem final diz que foram várias', () => {
  const cena = painelAberto('coord@exemplo.com');
  cena.respostas.lerConfiguracoes = null;   // a rede cai em todas

  cena.js.trocarAba('config');
  cena.rodarTarefas(3);

  igual(requisicoesDe(cena, 'lerConfiguracoes').length, 3,
    'são duas tentativas extras — nem menos (não conserta nada) nem mais (parece travamento)');

  const msg = cena.texto('mensagem-global');
  verdadeiro(msg.indexOf('Tentei 3 vezes') !== -1,
    'a mensagem final deixa a pessoa achar que houve uma tentativa só: ' + msg);
  // O conteúdo que já existia é bom e não pode ter sido substituído pelo novo.
  verdadeiro(msg.indexOf('implantação do Apps Script') !== -1, msg);
  verdadeiro(msg.indexOf('config.js') !== -1, msg);
});

teste('enquanto repete, a tela não pisca erro nem finge que carregou', () => {
  const cena = painelAberto('coord@exemplo.com');
  cena.respostas.lerConfiguracoes = () => {
    delete cena.respostas.lerConfiguracoes;
    return null;
  };

  cena.js.trocarAba('config');

  // Entre uma tentativa e outra: nem erro (que sumiria de novo em seguida), nem
  // silêncio de três segundos com a tela parada.
  const entre = cena.texto('mensagem-global');
  igual(entre.indexOf('Erro'), -1, 'a tela piscou erro para uma chamada que ainda ia ser repetida');
  verdadeiro(entre.indexOf('Tentando de novo') !== -1, 'a espera ficou muda: "' + entre + '"');
  igual(cena.elemento('conteudo-config').className, 'carregando',
    'a aba deixou de dizer que está carregando enquanto ainda está');

  cena.rodarTarefas();
  igual(cena.texto('mensagem-global'), '',
    'a nota de "tentando de novo" ficou na tela depois de a resposta ter chegado');
});

teste('ao sair, a nota não leva junto o recado que a tela pôs no lugar dela', () => {
  const cena = painelAberto('coord@exemplo.com');
  cena.respostas.lerConfiguracoes = () => {
    delete cena.respostas.lerConfiguracoes;
    return null;
  };

  cena.js.trocarAba('config');

  // Enquanto a leitura espera a segunda tentativa, a coordenação manda
  // reconciliar — e o "isso pode levar alguns segundos" vale até a resposta.
  cena.js.avisar('info', 'Reconciliando... isso pode levar alguns segundos.');
  cena.rodarTarefas();

  verdadeiro(cena.texto('mensagem-global').indexOf('Reconciliando') !== -1,
    'a retentativa apagou um recado que ainda era verdade: "' + cena.texto('mensagem-global') + '"');
});

teste('`{ ok: false }` não é repetido — o servidor respondeu, e a resposta é a resposta', () => {
  const cena = painelAberto('coord@exemplo.com');
  cena.respostas.lerConfiguracoes = { ok: false, erro: 'Não consegui ler os parâmetros.' };

  cena.js.trocarAba('config');
  cena.rodarTarefas(3);

  igual(requisicoesDe(cena, 'lerConfiguracoes').length, 1,
    'a recusa do servidor foi tratada como falha de rede e a chamada foi repetida');
  verdadeiro(cena.texto('conteudo-config').indexOf('Não consegui ler os parâmetros') !== -1,
    'a recusa do servidor não chegou à tela: ' + cena.texto('conteudo-config'));
});

/**
 * O 404 DO SEGUNDO SALTO — a exceção, com data e evidência.
 *
 * Uma chamada ao `/exec` são dois saltos: o `/exec` redireciona para
 * `script.googleusercontent.com/macros/echo?user_content_key=...`, e é o segundo
 * que traz o corpo. A chave é de uso único e vida curta; vencida, o segundo salto
 * responde 404. Foi o que apareceu no navegador da coordenação em 12/08, na aba
 * Disciplinas:
 *
 *   exec                        CORS error
 *   echo?user_content_key=...   404          5,42 s
 *
 * e na tela: `Erro em "listarDisciplinas": HTTP 404` — numa leitura pura, que
 * estava em `SO_LEITURA` e teria sido repetida se a condição deixasse.
 *
 * O que torna isto seguro é uma premissa sobre o SERVIDOR, conferida em
 * 08_Api.gs antes da mudança: `doGet` e `doPost` são os únicos pontos de entrada
 * e respondem sempre por `ContentService`/`HtmlService`, que saem como HTTP 200
 * — o Apps Script não oferece como um web app devolver outro código, e não há
 * `setStatusCode` em lugar nenhum do repositório. Recusa nossa é `{ ok: false }`
 * com 200. Logo, um 404 no navegador é sempre do encanamento do Google.
 */
teste('HTTP 404 é repetido — é a chave do segundo salto vencendo, não o nosso servidor', () => {
  const cena = painelAberto('coord@exemplo.com');

  // Vence uma vez, como venceu na produção: a segunda tentativa pega uma chave
  // nova e percorre o `doPost` de verdade.
  cena.respostas.listarDisciplinas = () => {
    delete cena.respostas.listarDisciplinas;
    return respostaHttp(404);
  };

  cena.js.trocarAba('disciplinas');
  igual(requisicoesDe(cena, 'listarDisciplinas').length, 1, 'a primeira tentativa não saiu');

  cena.rodarTarefas();

  igual(requisicoesDe(cena, 'listarDisciplinas').length, 2, 'o 404 do segundo salto não foi repetido');
  igual(cena.texto('mensagem-global').indexOf('HTTP 404'), -1,
    'o erro que a retentativa resolveu ficou na tela: ' + cena.texto('mensagem-global'));
  verdadeiro(cena.texto('conteudo-disciplinas').indexOf('Carregando') === -1,
    'a aba não desenhou o que veio na segunda tentativa: ' + cena.texto('conteudo-disciplinas'));
});

teste('404 numa ESCRITA continua saindo uma vez só', () => {
  // A exceção do 404 não pode ter aberto a porta que `SO_LEITURA` fecha: repetir
  // uma gravação que talvez tenha sido executada é gravar duas vezes.
  const cena = painelAberto('coord@exemplo.com');
  cena.respostas.rodarReconciliacao = respostaHttp(404);

  cena.js.reconciliarAgora();
  cena.rodarTarefas(3);

  igual(requisicoesDe(cena, 'rodarReconciliacao').length, 1,
    'UMA ESCRITA FOI REPETIDA por causa do 404 — isto grava duas vezes no banco');
  verdadeiro(cena.texto('mensagem-global').indexOf('HTTP 404') !== -1,
    'a falha da escrita não chegou à tela: ' + cena.texto('mensagem-global'));
});

teste('400, 401 e 403 continuam terminais — só o 404 tem a explicação dos dois saltos', () => {
  [400, 401, 403].forEach((codigo) => {
    const cena = painelAberto('coord@exemplo.com');
    cena.respostas.lerConfiguracoes = respostaHttp(codigo);

    cena.js.trocarAba('config');
    cena.rodarTarefas(3);

    igual(requisicoesDe(cena, 'lerConfiguracoes').length, 1, 'o ' + codigo + ' foi repetido');

    const msg = cena.texto('mensagem-global');
    verdadeiro(msg.indexOf('HTTP ' + codigo) !== -1, msg);
    verdadeiro(msg.indexOf('Tentei') === -1,
      'a mensagem promete várias tentativas onde houve uma: ' + msg);
  });
});

teste('a exceção do 404 está escrita como exceção, e não como "repete 4xx"', () => {
  // Se um dia alguém trocar isto por `e.status >= 400`, a retentativa passa a
  // insistir em cima de recusa legítima — e o comentário que explica o segundo
  // salto some junto. A forma da condição é a regra.
  verdadeiro(/e\.status >= 500 \|\| e\.status === 404/.test(PAGINA),
    'a condição de transporte mudou de forma: confira se 400/401/403 continuam terminais');
  verdadeiro(PAGINA.indexOf('user_content_key') !== -1,
    'a evidência do segundo salto sumiu do arquivo — sem ela, repetir 404 parece erro');
});

teste('HTTP 5xx é repetido — é o servidor tropeçando nele mesmo', () => {
  const cena = painelAberto('coord@exemplo.com');
  cena.respostas.lerConfiguracoes = respostaHttp(500);

  cena.js.trocarAba('config');
  cena.rodarTarefas(3);

  igual(requisicoesDe(cena, 'lerConfiguracoes').length, 3, 'o 500 não foi repetido');
  verdadeiro(cena.texto('mensagem-global').indexOf('Tentei 3 vezes') !== -1,
    cena.texto('mensagem-global'));
});

teste('a regra está escrita em código, e a espera é curta de propósito', () => {
  // Ler `SO_LEITURA` é o que impede a retentativa de virar "repete tudo". Se
  // esta linha mudar de forma, é porque a regra mudou — e ela é de segurança.
  verdadeiro(/var podeRepetir = Boolean\(SO_LEITURA\[funcao\]\);/.test(PAGINA),
    'a retentativa deixou de perguntar a SO_LEITURA se a chamada pode ser repetida');

  const esperas = /var ESPERAS_ATE_TENTAR_DE_NOVO = \[([^\]]*)\];/.exec(PAGINA);
  verdadeiro(esperas !== null, 'a lista de esperas sumiu do painel');
  igual(esperas[1].split(',').length, 2,
    'mudou o número de tentativas extras — cinco tentativas caladas parecem travamento ' +
    'para quem está olhando a tela durante o evento');
});

// ============================ 2b-bis. A leitura que fica PENDURADA (13/08)

/**
 * O QUE ESTE BLOCO PROTEGE, e por que ele não cabia no de cima.
 *
 * A retentativa consertou a falha que aparece DEPRESSA: `Failed to fetch`, e a
 * segunda tentativa sai em 700ms. A falha que apareceu depois é a mesma porta
 * pelo lado lento — o segundo salto (`echo?user_content_key=...`) fica pendurado
 * e só então responde 404. Medido: 32,71s no botão Salvar da coordenação em
 * 12/08, e em 13/08 32,73s no navegador de um aluno, com 11,9s e 66,8s no
 * terminal e a repetição respondendo entre 401ms e 2s logo em seguida.
 *
 * Sem tempo-limite, a repetição não ajudava em nada: ela só começava quando o
 * Google desistia sozinho. Dez segundos foram escolhidos pelas medidas — 2 a 4s
 * no caminho saudável, 9,25s na leitura mais lenta que DEU CERTO, 12 a 67s nas
 * travadas —, e a mesma variável que decide se a chamada pode ser repetida
 * decide se ela pode ser abortada. É a linha do meio deste bloco: abortar uma
 * ESCRITA é desistir de uma gravação que talvez tenha acontecido, e o `fetch`
 * morrendo aqui não cancela nada do lado de lá.
 */
grupo('a leitura pendurada tem hora para morrer — e a escrita não tem');

teste('leitura pendurada é abortada, e a repetição salva a tela', () => {
  const cena = painelAberto('coord@exemplo.com');

  // Pendura UMA vez: a segunda tentativa não acha mais encenação nenhuma e
  // percorre o `doPost` de verdade. É a forma do que aconteceu na produção.
  cena.respostas.lerConfiguracoes = () => {
    delete cena.respostas.lerConfiguracoes;
    return travada();
  };

  cena.js.trocarAba('config');
  igual(requisicoesDe(cena, 'lerConfiguracoes').length, 1, 'a primeira tentativa não saiu');
  igual(cena.texto('mensagem-global'), '',
    'a tela já desistiu antes de o tempo-limite vencer: ' + cena.texto('mensagem-global'));

  cena.rodarTarefas();          // o tempo-limite vence e aborta
  verdadeiro(cena.texto('mensagem-global').indexOf('Tentando de novo') !== -1,
    'o tempo-limite não virou nova tentativa: ' + cena.texto('mensagem-global'));

  cena.rodarTarefas();          // a espera entre as duas tentativas
  igual(requisicoesDe(cena, 'lerConfiguracoes').length, 2,
    'A LEITURA FICOU PENDURADA PARA SEMPRE — é o defeito de 12/08 na tela do evento');
  verdadeiro(cena.texto('conteudo-config').indexOf('Parâmetros') !== -1,
    'a aba não desenhou o que veio na segunda tentativa: ' + cena.texto('conteudo-config'));
  igual(cena.texto('mensagem-global'), '',
    'sobrou aviso na tela depois de a segunda tentativa ter dado certo');
});

teste('leitura que responde NÃO é abortada, e não deixa relógio marcado', () => {
  const cena = painelAberto('coord@exemplo.com');
  const marcadas = cena.tarefas.length;

  cena.js.trocarAba('config');   // a resposta chega, como chega em 2 a 4s

  const pedido = requisicoesDe(cena, 'lerConfiguracoes')[0];
  verdadeiro(pedido.sinal !== undefined,
    'a leitura saiu sem sinal nenhum — ela não tem como ser abandonada quando travar');
  igual(pedido.sinal.aborted, false, 'a resposta chegou e a leitura foi abortada assim mesmo');
  igual(cena.tarefas.length, marcadas,
    'o tempo-limite continuou marcado depois de a resposta ter chegado — um relógio ' +
    'por leitura, numa aba que se recarrega a noite inteira');

  cena.rodarTarefas(3);
  igual(requisicoesDe(cena, 'lerConfiguracoes').length, 1,
    'a leitura que já tinha respondido foi repetida');
});

teste('a ESCRITA pendurada não ganha tempo-limite — nem sinal para abortá-la', () => {
  // O freio deste bloco. Abortar não cancela a execução do Apps Script: uma
  // gravação abortada pode ter acontecido, e o painel estaria escrevendo "falhou"
  // em cima dela — o defeito de 12/08 outra vez, agora provocado por nós.
  const cena = painelAberto('coord@exemplo.com');
  const marcadas = cena.tarefas.length;
  cena.respostas.rodarReconciliacao = travada();

  cena.js.reconciliarAgora();

  const pedido = requisicoesDe(cena, 'rodarReconciliacao')[0];
  igual(pedido.sinal, undefined,
    'A ESCRITA GANHOU UM SINAL DE ABORTO — abortar uma gravação é desistir de saber ' +
    'se ela aconteceu');
  igual(cena.tarefas.length, marcadas, 'foi marcado um tempo-limite para uma ESCRITA');

  cena.rodarTarefas(3);
  igual(requisicoesDe(cena, 'rodarReconciliacao').length, 1, 'a escrita saiu duas vezes');
  igual(cena.texto('mensagem-global').indexOf('Erro em'), -1,
    'o painel desistiu de uma gravação que continua rodando no servidor: ' +
    cena.texto('mensagem-global'));
});

teste('todas as tentativas travando dão a mensagem que já existia', () => {
  const cena = painelAberto('coord@exemplo.com');
  cena.respostas.lerConfiguracoes = travada();   // pendura em todas

  cena.js.trocarAba('config');
  cena.rodarTarefas(5);                          // limite, espera, limite, espera, limite

  igual(requisicoesDe(cena, 'lerConfiguracoes').length, 3,
    'não foram as três tentativas de sempre');

  // Tempo-limite não é um desfecho novo para quem olha a tela: é a mesma leitura
  // que não chegou, com a mesma mensagem de antes.
  const msg = cena.texto('mensagem-global');
  verdadeiro(msg.indexOf('Erro em "lerConfiguracoes"') !== -1, msg);
  verdadeiro(msg.indexOf('Tentei 3 vezes') !== -1,
    'a mensagem deixa a pessoa achar que houve uma tentativa só: ' + msg);
  verdadeiro(msg.indexOf('implantação do Apps Script') !== -1,
    'a mensagem que já existia foi substituída por uma nova: ' + msg);
});

teste('o tempo-limite é de 10s e anda colado em quem pode ser repetido', () => {
  const limite = /var LIMITE_DE_LEITURA_MS = (\d+);/.exec(PAGINA);
  verdadeiro(limite !== null, 'a constante do tempo-limite sumiu do painel');
  igual(limite[1], '10000',
    'o limite mudou de tamanho: 2 a 4s é o caminho saudável, 9,25s a leitura mais ' +
    'lenta que deu certo e 12 a 67s as travadas — 10s é o que separa os dois grupos');

  // A FORMA da linha é a regra: uma variável só responde "pode repetir?" e "pode
  // abortar?", e as duas respostas têm de continuar sendo a mesma.
  verdadeiro(/var controle = podeRepetir \? new AbortController\(\) : null;/.test(PAGINA),
    'o tempo-limite deixou de perguntar a `podeRepetir` — se ele passar a valer para ' +
    'tudo, a próxima gravação abortada é uma gravação com desfecho desconhecido');
});

teste('a leitura do Auditório tem tempo próprio — e é a ÚNICA que tem', () => {
  // POR QUE UMA EXCEÇÃO EXISTE. O 10s foi calibrado em 12 e 13/08 sobre respostas
  // de 200 linhas. Em 27/08 `inscricoesRecentes` passou a pedir mil
  // (`AUDITORIO_TETO`), e o JSON de `resumoParaAuditorio_` foi somado campo a
  // campo: 334 B por linha, ou seja 65 KiB crus (~10 KiB comprimidos) em 200
  // linhas contra 326 KiB crus (~46 KiB comprimidos) em mil. Do lado do servidor
  // o `runQuery` que `listar` baixa vai de 0,26 MiB para 1,28 MiB.
  //
  // Os 36 KiB comprimidos a mais custam menos de 1s até no wifi ruim — 10s ainda
  // CHEGA. O que encolheu foi a folga, e a folga era a conta toda: a leitura mais
  // lenta que deu certo levou 9,25s com 200 linhas, e com mil ela encosta em 10s.
  // Abortada, a tentativa seguinte relê as mesmas mil, e uma leitura que teria
  // chegado em 9,5s passa a custar ~21s. As travadas medidas iam de 11,9s a
  // 66,8s: 15s fica acima de tudo que chega e continua cortando o que trava.
  const tabela = /var LIMITE_DE_LEITURA_POR_FUNCAO_MS = \{([^}]*)\};/.exec(PAGINA);
  verdadeiro(tabela !== null, 'a tabela de tempo por função sumiu do painel');
  verdadeiro(/inscricoesRecentes:\s*15000/.test(tabela[1]),
    'a leitura de mil linhas voltou a ter o tempo de uma de 200: ' + tabela[1]);

  // SÓ ELA. O limite global vale para dezenove chamadas, e nenhuma outra mudou de
  // tamanho — `filaDeEspera` inclusive, cujo teto é 500 desde antes e cujas
  // linhas são mais estreitas. Uma tabela que crescesse sem medida seria o limite
  // global afrouxado por dentro, sem ninguém ter medido nada.
  const nomes = (tabela[1].match(/[A-Za-z_$][\w$]*(?=\s*:)/g) || []);
  igual(nomes, ['inscricoesRecentes'],
    'entrou função na tabela do tempo-limite sem medida que justifique: ' + nomes.join(', '));

  // E o relógio LÊ a tabela — sem isto ela seria decoração, e a página passaria
  // neste teste com o limite de 10s valendo para tudo.
  verdadeiro(/setTimeout\(function \(\) \{ controle\.abort\(\); \}, limiteDeLeitura_\(funcao\)\)/
    .test(PAGINA), 'o tempo-limite parou de perguntar qual é o desta função');
});

teste('a leitura de mil linhas espera 15s antes de desistir, e as outras 10s', () => {
  // O mesmo par, medido no relógio em vez de lido no arquivo: é o que pega a
  // tabela certa ligada ao `setTimeout` errado.
  const cena = painelAberto('coord@exemplo.com');

  cena.respostas.inscricoesRecentes = travada();
  cena.js.chamar('inscricoesRecentes', { limite: 1000 }, () => {});
  igual(cena.tarefas.map((t) => t.ms), [15000],
    'a leitura do Auditório não ganhou o tempo dela: ' + JSON.stringify(cena.tarefas.map((t) => t.ms)));

  cena.zerarTarefas();
  cena.respostas.filaDeEspera = travada();
  cena.js.chamar('filaDeEspera', {}, () => {});
  igual(cena.tarefas.map((t) => t.ms), [10000],
    'a exceção do Auditório vazou para a outra leitura da mesma aba');
});

// ================================== 2c. Gravar em voz alta, fechar sem perder

/**
 * O QUE ESTE BLOCO PROTEGE.
 *
 * Os dois relatos de 11/08, cadastrando projetos para o evento: o clique no fundo
 * apagava o formulário inteiro, e o botão Salvar não dava sinal nenhum de vida
 * durante os 2 a 4 segundos da chamada. Os dois consertos são CENTRAIS — uma
 * guarda para as sete janelas, um envelope para os sete botões —, e é isso que os
 * testes daqui fixam: não que a tela funcione (disso trata `painel-navegador.js`,
 * clicando), mas que ninguém consiga escrever a oitava janela ou o oitavo botão
 * por fora.
 */
grupo('o conserto é central — ninguém grava nem fecha por fora dele');

/** As funções que o painel declara como SÓ LEITURA, lidas do próprio arquivo. */
function funcoesDeLeitura() {
  const bloco = /var SO_LEITURA = \{([\s\S]*?)\};/.exec(PAGINA);
  verdadeiro(bloco !== null, 'SO_LEITURA sumiu do painel');
  return bloco[1].match(/[A-Za-z_$][\w$]*(?=\s*:)/g) || [];
}

/**
 * O corpo de cada função de topo do `<script>`.
 *
 * O corte é na próxima `\n  function ` — a indentação de dois espaços é a das
 * funções de topo deste arquivo, e as de dentro são mais fundas. É grosseiro e
 * suficiente: o que se quer saber é quais chamadas ao servidor cada função faz.
 */
function corposDasFuncoes() {
  const inicios = [];
  const regex = /\n  function ([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = regex.exec(PAGINA)) !== null) inicios.push({ nome: m[1], em: m.index });

  const corpos = {};
  inicios.forEach((f, i) => {
    corpos[f.nome] = PAGINA.slice(f.em, i + 1 < inicios.length ? inicios[i + 1].em : PAGINA.length);
  });
  return corpos;
}

/** Quem é chamado por um `onclick=`, e se veio dentro do envelope. */
function handlersDeClique() {
  const handlers = {};
  const regex = /onclick="\s*([A-Za-z_$][\w$]*)\s*\(\s*(?:this\s*,\s*([A-Za-z_$][\w$]*))?/g;
  let m;
  while ((m = regex.exec(PAGINA)) !== null) {
    const noEnvelope = m[1] === 'aoGravar';
    const nome = noEnvelope ? m[2] : m[1];
    if (nome && handlers[nome] === undefined) handlers[nome] = noEnvelope;
  }
  return handlers;
}

teste('TODA função que grava passa pelo envelope — a varredura sai do próprio arquivo', () => {
  // Este é o teste que impede o próximo botão de nascer sem freio, e ele não tem
  // lista escrita à mão: a pergunta "esta função grava?" é respondida pelo
  // arquivo (`chamar('X')` com X fora de `SO_LEITURA`), e a pergunta "ela passa
  // pelo envelope?" é respondida pela marcação (`onclick="aoGravar(this, ...)"`).
  //
  // Uma função nova que grave e que alguém ligue direto no `onclick` entra aqui
  // sozinha, no dia em que for escrita.
  const leitura = funcoesDeLeitura();
  const corpos = corposDasFuncoes();
  const handlers = handlersDeClique();

  const semFreio = Object.keys(handlers).filter((nome) => {
    if (handlers[nome]) return false;
    const chamadas = (corpos[nome] || '').match(/chamar\(\s*'([A-Za-z_$][\w$]*)'/g) || [];
    return chamadas
      .map((c) => /'([^']+)'/.exec(c)[1])
      .some((fn) => leitura.indexOf(fn) === -1);
  }).sort();

  // As duas que sobram são as da TELA DE LOGIN, e elas estão aqui com nome e
  // data: as duas travam o botão à mão, e — ao contrário das da importação, que
  // é o defeito que originou tudo isto — as duas também o destravam no caminho
  // do erro. Não estão quebradas; estão duplicando o que o envelope faz. Dobrá-las
  // aqui dentro mexe na porta de entrada do sistema, e isso ficou para DEPOIS do
  // evento de 14/08. Quem fizer, apaga os dois nomes desta linha.
  igual(semFreio, ['confirmarEntradaPorLink', 'enviarPedidoDeLink'],
    'estes botões gravam sem travar, sem avisar e aceitando clique duplo: ' + semFreio.join(', '));

  verdadeiro(Object.keys(handlers).filter((n) => handlers[n]).length >= 18,
    'sumiram botões do envelope — eram dezenove quando esta varredura foi escrita');
});

teste('a chave de idempotência nasce em UM lugar só, e leitura não pega chave', () => {
  // A regra que o SERVIDOR não tem como conferir: `rotaDoPainel_` (08_Api.gs)
  // trata a chave como opaca e não conhece a diferença entre ler e gravar — de
  // propósito, para não existir uma segunda lista de leituras que um dia diverge
  // desta. Logo, esta linha do painel é a guarda inteira: uma leitura que
  // passasse a mandar chave teria a resposta CONGELADA por dez minutos, e a aba
  // mostraria o número de antes depois de alguém ter gravado.
  verdadeiro(
    /var operacao = \(DE_LOGIN\[funcao\] \|\| SO_LEITURA\[funcao\]\) \? null : chaveDaOperacao\(funcao, dados\);/.test(PAGINA),
    'a chave deixou de perguntar a SO_LEITURA quem pode pedi-la');

  igual((PAGINA.match(/corpo\.idem = /g) || []).length, 1,
    'a chave passou a ser posta no corpo em mais de um lugar — e só um deles ' +
    'pergunta se a função é de leitura');

  // O mapa é consultado por assinatura e ESQUECIDO no desfecho. Sem o
  // esquecimento, dois pedidos iguais separados no tempo viram um só — e o
  // segundo é engolido com a tela dizendo que deu certo.
  verdadeiro(/if \(operacao\) esquecerChave\(operacao\.assinatura\);/.test(PAGINA),
    'a chave deixou de ser esquecida quando o desfecho chega');
});

teste('a espera de cada botão diz o que ELE está fazendo', () => {
  // O rótulo genérico serve para salvar; não serve para importar (que é a espera
  // mais longa da tela) nem para reconciliar (a chamada mais cara do sistema).
  // Quem precisa de outro rótulo o declara na própria marcação.
  verdadeiro(/data-gravando="Importando\.\.\."/.test(PAGINA),
    'o Confirmar importação voltou a dizer "Salvando…" — e importar não é salvar');
  verdadeiro((PAGINA.match(/data-gravando="Reconciliando[^"]*"/g) || []).length >= 2,
    'os dois botões de reconciliar precisam avisar que a espera é longa');

  verdadeiro(/botao\.getAttribute\('data-gravando'\) \|\| TEXTO_GRAVANDO/.test(PAGINA),
    'o rótulo próprio deixou de ser lido — todos os botões voltariam a dizer a mesma coisa');
});

teste('os dois botões da importação não travam mais por conta própria', () => {
  // O defeito de 11/08 em produção, escrito como teste: os dois desabilitavam o
  // botão à mão e só o devolviam dentro do callback de SUCESSO. Um `Failed to
  // fetch` — e escrita não é repetida — deixava "Importando..." travado até
  // alguém recarregar a página, o que joga fora o mapeamento das colunas.
  const importar = /function confirmarImportacaoUI[\s\S]*?\n  \}/.exec(PAGINA)[0];
  const reconciliar = /function reconciliarAposImportar[\s\S]*?\n  \}/.exec(PAGINA)[0];

  [['confirmarImportacaoUI', importar], ['reconciliarAposImportar', reconciliar]].forEach((par) => {
    igual(par[1].indexOf('disabled = true'), -1,
      par[0] + ' voltou a travar o botão à mão — e quem trava à mão esquece de destravar');
    igual(par[1].indexOf('textContent = \''), -1,
      par[0] + ' voltou a trocar o rótulo à mão, fora do `data-gravando`');
  });
});

teste('o botão é devolvido em `chamar()`, que é por onde toda resposta passa', () => {
  // O destravamento mora nos três desfechos de `chamar`: sem endereço, resposta
  // chegou (boa ou ruim) e desistiu de tentar. Espalhá-lo pelas sete funções de
  // salvar seria seis lugares para esquecê-lo no dia da recusa do servidor.
  const corpo = PAGINA.slice(PAGINA.indexOf('function chamar(funcao, payload'),
    PAGINA.indexOf('function problema(texto)'));
  igual((corpo.match(/destravarBotao\(botao\)/g) || []).length, 3,
    'mudou o número de saídas de `chamar()` que devolvem o botão: ' +
    'uma saída sem devolução é um botão travado para sempre na tela da coordenação');

  verdadeiro(/var botao = BOTAO_A_ADOTAR;\s*BOTAO_A_ADOTAR = null;/.test(corpo),
    'a adoção do botão deixou de ser exclusiva: duas chamadas seguidas passariam ' +
    'a disputar o mesmo botão, e a segunda o destravaria no meio da primeira');
});

teste('a guarda da janela não conhece formulário nenhum pelo nome', () => {
  // É o coração da regra: a janela é lida como está na tela, e não conferida
  // contra uma lista de quais formulários perguntam e quais não. Uma lista assim
  // precisaria ser lembrada por quem escrever a oitava janela — e não seria.
  const guarda = PAGINA.slice(PAGINA.indexOf('function modalTemTrabalho()'),
    PAGINA.indexOf('// ------------------------------------------------------------ Aba Importar'));
  verdadeiro(guarda.length > 0 && guarda.length < 3000, 'a guarda sumiu do painel');

  ['pj-', 'ed-', 'disc-', 'lote-', 'coringa-', 'obs-aluno', 'novo-status', 'abrirForm']
    .forEach((marca) => {
      igual(guarda.indexOf(marca), -1,
        'a guarda passou a manter uma lista de formulários à mão: ' + marca);
    });
});

teste('fundo e Esc saem pela mesma porta — e o Cancelar continua fechando direto', () => {
  verdadeiro(/function fecharModalPorFundo\(ev\) \{[^}]*fecharModalSemPerderTrabalho\(\);/.test(PAGINA),
    'o clique no fundo deixou de passar pela guarda');

  const ouvinteDoEsc = PAGINA.slice(PAGINA.indexOf("if (e.key !== 'Escape'"),
    PAGINA.indexOf('A BARRA DE ENDEREÇO É LIDA'));
  verdadeiro(ouvinteDoEsc.indexOf('fecharModalSemPerderTrabalho()') !== -1,
    'o Esc fecha por um caminho próprio — e o caminho próprio é o que esquece a guarda');

  // O "×" e o "Cancelar" são mira, e não acidente: eles continuam em `fecharModal`.
  verdadeiro(/<button class="fechar" onclick="fecharModal\(\)"/.test(PAGINA),
    'o × da janela mudou de comportamento sem que ninguém pedisse');
});

teste('o botão travado é visível como travado — e o estilo já existe nos dois gêmeos', () => {
  // Nada de CSS novo foi preciso: `.btn:disabled` já apagava o botão, e o rótulo
  // vira "Salvando…". Este teste é o que impede o estilo de sumir de um dos dois
  // arquivos e deixar o sinal de vida invisível em uma das duas telas.
  verdadeiro(/\.btn:disabled\s*\{[^}]*opacity/.test(CSS_PAINEL),
    'o botão travado deixou de parecer travado no painel');
  verdadeiro(/\.btn:disabled\s*\{[^}]*opacity/.test(ESTILOS_GS),
    'o botão travado deixou de parecer travado no formulário servido pelo Apps Script');

  verdadeiro(PAGINA.indexOf("var TEXTO_GRAVANDO = 'Salvando…';") !== -1,
    'o rótulo da espera sumiu — o `disabled` sozinho é mudo para quem não olha a cor');
});

// ================================== 2d. A aba Auditório, do lado do contrato
//
// O QUE ESTE BLOCO PROTEGE.
//
// A aba Auditório é a tela do dia 14/08: auditório cheio, à noite, uma pessoa no
// celular tratando fila de espera. Os testes de CLIQUE dela estão em
// `painel-navegador.js`, percorrendo o `doPost` de verdade — o ciclo inteiro de
// anular, liberar vaga e promover. Aqui ficam as coisas que o clique não
// consegue provar, e que são justamente as que matam no dia:
//
//   - QUAIS chamadas se repetem quando a rede falha. O wifi do auditório é o pior
//     da faculdade, e as duas leituras precisam sobreviver a um soluço. As três
//     escritas não podem se repetir NUNCA: `Failed to fetch` não distingue "não
//     chegou" de "chegou, rodou e falhou na volta", e uma anulação repetida
//     apaga duas vezes;
//   - que o relato do servidor chega inteiro à tela;
//   - que a tela não se atualiza sozinha debaixo do dedo de quem está marcando.

grupo('a aba Auditório — o que o clique não prova');

teste('a aba e as duas listas existem, e a seção nasce escondida como as outras', () => {
  verdadeiro(PAGINA.indexOf('data-aba="auditorio"') !== -1, 'sumiu a aba do auditório');
  verdadeiro(PAGINA.indexOf('id="secao-auditorio"') !== -1, 'sumiu a seção da aba');

  ['auditorio-projetos', 'auditorio-alerta', 'auditorio-recentes', 'auditorio-fila',
    'auditorio-acoes-recentes', 'auditorio-acoes-fila'].forEach((id) => {
    verdadeiro(PAGINA.indexOf('id="' + id + '"') !== -1, 'sumiu a área ' + id);
  });

  // A troca de aba tem de conhecê-la nos DOIS lugares: a lista que esconde as
  // seções e o despacho que carrega a nova. Faltando o primeiro, a seção fica
  // visível por cima de todas as outras abas.
  verdadeiro(/'painel', 'auditorio',/.test(PAGINA), 'trocarAba não esconde a seção do auditório');
  verdadeiro(/if \(nome === 'auditorio'\) carregarAuditorio\(\);/.test(PAGINA),
    'trocarAba não carrega a aba do auditório');
});

teste('os filtros existem, moram FORA da lista, e estão ligados', () => {
  // Os três controles do pedido de 27/08 — achar uma pessoa, olhar um projeto,
  // ver quem repetiu — mais o Limpar. O clique prova o EFEITO deles
  // (`painel-navegador.js`); o que ele não prova é que a marcação está ligada às
  // funções certas, e é isso que morre em silêncio: um `oninput` com nome errado
  // deixa o campo aceitar texto e a lista nunca peneirar.
  [['filtro-aud-busca', 'oninput'],
    ['filtro-aud-projeto', 'onchange'],
    ['filtro-aud-repetidas', 'onchange']].forEach(([id, evento]) => {
    verdadeiro(PAGINA.indexOf('id="' + id + '"') !== -1, 'sumiu o filtro ' + id);
    verdadeiro(new RegExp('id="' + id + '"[^>]*' + evento + '="filtrarRecentes\\(\\)"')
      .test(PAGINA.replace(/\n\s*/g, ' ')),
      id + ' não chama filtrarRecentes() no ' + evento);
  });
  verdadeiro(/onclick="limparFiltroAuditorio\(\)"/.test(PAGINA),
    'sumiu o botão que limpa os filtros');

  // FORA de `#auditorio-recentes`, que é o elemento que se redesenha a cada
  // tecla: um campo dentro dele seria destruído junto com o texto e o cursor de
  // quem está digitando. Estar na MARCAÇÃO estática já garante isso — o que este
  // teste guarda é o dia em que alguém mover os campos para dentro do desenho.
  const desenho = PAGINA.slice(PAGINA.indexOf('function desenharRecentes()'),
    PAGINA.indexOf('function rodapeDeRecentes('));
  verdadeiro(desenho.length > 0, 'desenharRecentes sumiu do painel');
  igual(desenho.indexOf('filtro-aud-'), -1,
    'os campos de filtro foram para dentro do que se redesenha — eles somem a cada tecla');
});

teste('a faixa e as ações leem a lista VISÍVEL, e nunca AUDITORIO[lista]', () => {
  // As três funções servem às DUAS listas. Voltar a ler `AUDITORIO[lista]` faz a
  // faixa marcar linhas escondidas pelo filtro e o botão contá-las — e é o
  // defeito que o trabalho de 27/08 veio consertar. Ler o oposto (a filtrada
  // para as duas) daria à FILA a lista de recentes: "Promover 3" promoveria
  // gente de outra lista, com lock pego e escrita em lote.
  const faixa = PAGINA.slice(PAGINA.indexOf('function tocarLinha(lista, id)'),
    PAGINA.indexOf('function limparMarcas(lista)'));
  const acoes = PAGINA.slice(PAGINA.indexOf('function marcadasDe(lista)'),
    PAGINA.indexOf('function horaDe(carimbo)'));

  verdadeiro(faixa.length > 0 && acoes.length > 0, 'as funções da seleção sumiram do painel');
  [['tocarLinha', faixa], ['marcadasDe', acoes]].forEach(([nome, corpo]) => {
    verdadeiro(/itensVisiveis\(lista\)/.test(corpo),
      nome + ' deixou de ler a lista visível');
    igual(corpo.indexOf('AUDITORIO[lista]'), -1,
      nome + ' voltou a percorrer a lista INTEIRA — com filtro, ela alcança quem ninguém viu');
  });

  // E o despacho é por lista, com a fila fora do filtro.
  verdadeiro(/return lista === 'recentes' \? recentesFiltradas\(\) : AUDITORIO\.fila;/.test(PAGINA),
    'sumiu o despacho por lista de itensVisiveis');
});

teste('o TETO DE ESCRITA é do servidor, e a tela só o supõe quando ele se cala', () => {
  // O número 200 mora em 13_Auditorio.gs (`AUDITORIO_LOTE_MAXIMO`), e é ele que
  // RECUSA o lote. Uma segunda cópia dele aqui, tratada como verdade, é o defeito
  // com um passo a mais: no dia em que o teto mudar, só um dos lados muda junto —
  // e o lado que não mudou é o que desenha o botão.
  //
  // O clique prova o efeito (`painel-navegador.js`); o que ele não prova é que a
  // tela CONTINUA lendo o número da resposta. Alguém que troque `loteMaximo_()`
  // por `200` deixa todos aqueles testes verdes, porque o servidor de hoje manda
  // exatamente 200.
  ['filaDeEspera', 'inscricoesRecentes'].forEach((leitura) => {
    const corpo = PAGINA.slice(PAGINA.indexOf("chamar('" + leitura + "'"),
      PAGINA.indexOf("chamar('" + leitura + "'") + 1400);
    verdadeiro(/guardarLoteMaximo_\(r\.lote_maximo\)/.test(corpo),
      'a resposta de ' + leitura + ' deixou de ser lida em busca do teto de escrita');
  });

  const suposto = /var AUDITORIO_LOTE_SUPOSTO = (\d+);/.exec(PAGINA);
  verdadeiro(suposto !== null, 'sumiu o suposto para o servidor calado');
  igual(suposto[1], '200', 'o suposto deixou de ser o único teto que este sistema já teve');

  // E ele é lido POR UM CAMINHO SÓ. Quatro leitores (a oferta, as duas barras e a
  // frase da regra) que resolvessem o teto cada um do seu jeito acabariam
  // discordando — e uma barra que avisa em 200 ao lado de um botão que manda 380
  // é pior do que não avisar nada.
  const usos = (PAGINA.match(/AUDITORIO_LOTE_SUPOSTO/g) || []).length;
  igual(usos, 2, 'o suposto é lido fora de `loteMaximo_` — são ' + usos + ' aparições');
});

teste('a oferta é cortada no teto, e `idsQueCabem` continua respondendo UMA pergunta', () => {
  // O DEFEITO QUE ESTE TESTE GUARDA: a tela desenhar "Promover 380 da fila" e o
  // servidor recusar o lote inteiro — um clique perdido que a própria tela
  // ofereceu. E a forma do conserto importa tanto quanto ele: `idsQueCabem`
  // responde "quem cabe por VAGA", que é o número que a tela MOSTRA ("Cabem 380
  // agora"), e `loteDaOferta_` responde "o que este clique manda". Fundir as duas
  // apagaria o 380 da tela, e é ele que diz que ainda há rodada pela frente.
  const cabem = PAGINA.slice(PAGINA.indexOf('function idsQueCabem()'),
    PAGINA.indexOf('function loteDaOferta_()'));
  verdadeiro(cabem.length > 0, 'idsQueCabem sumiu do painel');
  igual(cabem.indexOf('loteMaximo_'), -1,
    'o teto entrou em `idsQueCabem` — ela passou a ter dois contratos, e a tela ' +
    'perdeu o número de quantos ainda cabem');

  verdadeiro(/function loteDaOferta_\(\) \{\s*return idsQueCabem\(\)\.slice\(0, loteMaximo_\(\)\);/
    .test(PAGINA), 'o corte da oferta deixou de ser `idsQueCabem` cortado no teto');

  // E o botão manda o que o rótulo contou.
  const promover = PAGINA.slice(PAGINA.indexOf('function promoverQueCabem()'),
    PAGINA.indexOf('function promover(ids)'));
  verdadeiro(/promover\(loteDaOferta_\(\)\)/.test(promover),
    'promoverQueCabem voltou a mandar tudo que cabe: ' + promover);
});

teste('a barra de ações NÃO fatia a seleção da pessoa — ela recusa e diz', () => {
  // As duas metades do mesmo trabalho, e elas são deliberadamente diferentes. Na
  // oferta da fila o corte é legítimo: quem escolheu o conjunto foi a ordem de
  // chegada, e "os 200 primeiros" é o que ela significa. Na barra, quem escolheu
  // as 380 foi a PESSOA, uma a uma e por faixa — mandar 200 delas seria a tela
  // decidindo em silêncio quais 180 ficam de fora, de uma lista cuja ação apaga
  // aluno. É o `slice` silencioso que o servidor acabou de deixar de fazer,
  // renascendo do lado de cá.
  const barra = PAGINA.slice(PAGINA.indexOf('function desenharAcoes(lista)'),
    PAGINA.indexOf('function marcadasDe(lista)'));
  verdadeiro(barra.length > 0, 'desenharAcoes sumiu do painel');

  igual(barra.indexOf('.slice('), -1,
    'a barra passou a fatiar a seleção da pessoa em silêncio: ' + barra);
  verdadeiro(/var demais = visiveis > teto;/.test(barra),
    'a barra deixou de comparar a seleção com o teto');
  verdadeiro(/if \(visiveis && !demais\)/.test(barra),
    'o botão de ação voltou a nascer com a seleção acima do teto — a recusa só ' +
    'apareceria depois do clique');
});

teste('nenhum mapa desta aba é lido pela herança do protótipo', () => {
  // A cicatriz de `idsDoPayload_` (13_Auditorio.gs), do lado da tela. `MARCADAS`,
  // o mapa de vagas e o de nomes de projeto são `{}`, e `constructor`,
  // `toString` e `valueOf` respondem verdadeiro neles sem ninguém ter escrito
  // nada. Numa lista cujo botão apaga aluno, isso é uma linha que nasce marcada e
  // entra na ação sem ter sido tocada.
  verdadeiro(/function temProprio_\(objeto, chave\) \{\s*return Object\.prototype\.hasOwnProperty\.call\(objeto, String\(chave\)\);/
    .test(PAGINA), 'a guarda contra a herança sumiu ou deixou de usar hasOwnProperty');

  // A FORMA é a regra: ler o mapa direto é o defeito, e ele volta calado. Os
  // comentários ficam de fora da varredura porque o painel CITA a forma errada
  // para explicar por que ela é errada — proibir a citação apagaria a explicação.
  const emCodigo = PAGINA.split('\n').filter((l) => {
    const t = l.trim();
    return t !== '' && t[0] !== '*' && t.slice(0, 2) !== '//' && t.slice(0, 2) !== '/*';
  }).join('\n');
  igual(emCodigo.indexOf('MARCADAS[lista]['), -1,
    'a marcação voltou a ser lida direto do mapa — um id chamado `constructor` ' +
    'responde verdadeiro por herança');

  ['linhaTocavel', 'tocarLinha', 'marcadasDe', 'idsQueCabem', 'rotuloDeProjeto_']
    .forEach((fn) => {
      const inicio = PAGINA.indexOf('function ' + fn + '(');
      verdadeiro(inicio !== -1, 'sumiu a função ' + fn);
      verdadeiro(PAGINA.slice(inicio, inicio + 1200).indexOf('temProprio_') !== -1,
        fn + ' voltou a ler o mapa pela herança do protótipo');
    });
});

teste('o recorte de repetidas não afirma sobre o BANCO com a janela cortada', () => {
  // O recorte é a pergunta do professor — "quem se inscreveu em mais de um
  // projeto" —, e ela é sobre o banco. A conta é feita sobre a JANELA. Com a
  // leitura cortada, o par cuja metade velha ficou de fora não é um par aqui, e a
  // resposta "ninguém repetiu" sai com cara de completa. O clique prova as
  // frases; o que ele não prova é que o aviso continua LIGADO nas duas saídas da
  // lista — a que tem linhas e a que está vazia, que é a mais enganosa das duas.
  const desenho = PAGINA.slice(PAGINA.indexOf('function desenharRecentes()'),
    PAGINA.indexOf('function rodapeDeRecentes('));
  igual((desenho.match(/avisoDoRecorte_\(\)/g) || []).length, 2,
    'o aviso do recorte não está nas DUAS saídas da lista (com linhas e vazia)');

  // E ele só fala quando tem o que dizer: com `truncada: false` a ressalva vira
  // ruído, e ruído que aparece sempre é ruído que ninguém lê no dia que importa.
  const aviso = PAGINA.slice(PAGINA.indexOf('function avisoDoRecorte_()'),
    PAGINA.indexOf('function recentesFiltradas()'));
  verdadeiro(/if \(AUDITORIO\.recentesTruncada === false\) return '';/.test(aviso),
    'o aviso do recorte passou a aparecer também com a janela folgada');
  verdadeiro(/campoTexto_\('filtro-aud-repetidas'\) !== 'SIM'/.test(aviso),
    'o aviso do recorte deixou de depender do recorte estar ligado');
});

teste('o rodapé não promete o banco a partir de `truncada: false`', () => {
  // `truncada: false` afirma UMA coisa: a janela não encostou no teto. Não fala
  // do que foi gravado depois da leitura — numa noite de rajada, uma inscrição a
  // cada poucos segundos — nem da que não tem `criado_em`, que a ordenação do
  // Firestore não devolve. "São todas as que existem" é o engano das 275 em 200
  // com o teto certo e a frase errada.
  const rodape = PAGINA.slice(PAGINA.indexOf('function rodapeDeRecentes(naTela)'),
    PAGINA.indexOf('function desenharFila()'));
  verdadeiro(rodape.length > 0, 'rodapeDeRecentes sumiu do painel');
  igual(rodape.indexOf("' São todas as que existem"), -1,
    'a promessa absoluta voltou ao rodapé');
  verdadeiro(/janela = ' O teto não cortou esta leitura\./.test(rodape),
    'a frase da janela folgada deixou de falar do TETO: ' + rodape);
});

teste('as DUAS leituras do Auditório repetem na falha de rede', () => {
  // É a razão de elas estarem em SO_LEITURA: durante o evento, esta tela é o que
  // a coordenação usa, e um soluço de rede não pode derrubá-la.
  ['inscricoesRecentes', 'filaDeEspera'].forEach((fn) => {
    const cena = painelAberto('coord@exemplo.com');
    cena.respostas[fn] = null;              // a rede cai, sempre

    cena.js.chamar(fn, {}, () => {});
    cena.rodarTarefas(3);

    igual(requisicoesDe(cena, fn).length, 3,
      fn + ' não é repetida — um soluço de rede derruba a tela do evento');
  });
});

teste('as TRÊS escritas do Auditório saem UMA VEZ SÓ — repetir anula duas vezes', () => {
  // O teste mais importante deste bloco. `Failed to fetch` quer dizer que a
  // requisição não completou, e NÃO que ela não chegou: ela pode ter sido
  // executada e ter falhado só na volta. Uma segunda `anularInscricoes` nesse
  // estado apaga um segundo lote; uma segunda `promoverDaEspera` ocupa vaga duas
  // vezes. Nenhuma das três pode estar em SO_LEITURA, nunca.
  const soLeitura = funcoesDeLeitura();

  ['anularInscricoes', 'restaurarInscricoes', 'promoverDaEspera'].forEach((fn) => {
    igual(soLeitura.indexOf(fn), -1, fn + ' GRAVA e foi declarada como leitura em SO_LEITURA');

    const cena = painelAberto('coord@exemplo.com');
    cena.respostas[fn] = null;

    cena.js.chamar(fn, {}, () => {});
    cena.rodarTarefas(3);

    igual(requisicoesDe(cena, fn).length, 1,
      'UMA ESCRITA DO AUDITÓRIO FOI REPETIDA (' + fn + ') — isto mexe duas vezes no banco');
    igual(cena.tarefas.length, 0, 'foi agendada uma nova tentativa de ' + fn);
  });
});

teste('os três botões que mexem passam pelo envelope, com espera própria', () => {
  // O envelope trava o botão, escreve o que ele está fazendo e o devolve quando a
  // resposta chega — e o clique duplo, que num auditório é o mais fácil de dar,
  // deixa de mandar a requisição duas vezes. A varredura geral já cobre isto; os
  // três estão nomeados aqui para que a falha diga QUAL botão perdeu o freio.
  ['anularMarcadas', 'promoverMarcadas', 'promoverQueCabem'].forEach((fn) => {
    verdadeiro(new RegExp('aoGravar\\(this, ' + fn + '\\)').test(PAGINA),
      fn + ' deixou de passar pelo envelope: dois toques mandariam a requisição duas vezes');
  });

  ['Anulando...', 'Promovendo...'].forEach((rotulo) => {
    verdadeiro(PAGINA.indexOf('data-gravando="' + rotulo + '"') !== -1,
      'sumiu a espera "' + rotulo + '" — "Salvando…" não descreve nenhuma delas');
  });
});

teste('"promovi 12 de 38" chega à tela inteiro, e em amarelo', () => {
  // O relato não pode ser engolido: "promovi 12" e "promovi 12 de 38" são a mesma
  // tela para quem lê só o número da frente, e a diferença são 26 pessoas que
  // continuam esperando sem ninguém saber. Amarelo porque o verde do `avisar` se
  // apaga sozinho em 6 segundos.
  const cena = painelAberto('coord@exemplo.com');
  const ids = [];
  for (let i = 0; i < 38; i++) ids.push('i' + i);

  cena.respostas.promoverDaEspera = {
    ok: true, promovidos: 12, naoCouberam: 26,
    mensagem: 'Motivos de quem ficou: 26 × as vagas do projeto já estão preenchidas.'
  };

  cena.js.promover(ids);

  const relato = cena.texto('mensagem-global');
  verdadeiro(relato.indexOf('Promovi 12 de 38.') !== -1,
    'os dois números não chegaram à tela: ' + relato);
  verdadeiro(relato.indexOf('Motivos de quem ficou: 26 ×') !== -1,
    'a frase do servidor foi engolida: ' + relato);
  verdadeiro(cena.html('mensagem-global').indexOf('aviso--atencao') !== -1,
    'o relato com sobra saiu em verde, e o verde some antes de ser lido');
});

teste('sem sobra nenhuma o relato é verde — e continua trazendo os dois números', () => {
  const cena = painelAberto('coord@exemplo.com');

  cena.respostas.promoverDaEspera = { ok: true, promovidos: 3, naoCouberam: 0, mensagem: '' };
  cena.js.promover(['a', 'b', 'c']);

  verdadeiro(cena.texto('mensagem-global').indexOf('Promovi 3 de 3.') !== -1,
    'os dois números somem quando eles são iguais: ' + cena.texto('mensagem-global'));
  verdadeiro(cena.html('mensagem-global').indexOf('aviso--sucesso') !== -1,
    cena.html('mensagem-global'));
});

teste('a tela NÃO oferece desfazer — e não some com a notícia do que foi anulado', () => {
  // O botão saiu em 12/08 ("se foi anulado, confirmou, já era"). Duas coisas
  // precisam continuar valendo, e é o que este teste guarda:
  //
  //   1. nenhum caminho da tela chama `restaurarInscricoes`. O servidor continua
  //      sabendo restaurar — é a recuperação de quem anulou por engano —, mas ela
  //      passa por quem tem acesso ao sistema, e não por um botão ao lado do que
  //      apaga;
  //   2. a notícia do que foi anulado NÃO depende da fila. Ela é o que a tela
  //      acabou de fazer, e some junto com uma leitura que falhou seria apagar da
  //      vista o único rastro do engano.
  igual(/aoGravar\(this, desfazerAnulacao\)/.test(PAGINA), false,
    'o botão de desfazer voltou para a tela');
  igual(/desfazerAnulacao/.test(PAGINA), false,
    'sobrou código do desfazer na página');
  igual(/chamar\('restaurarInscricoes'/.test(PAGINA), false,
    'a tela voltou a chamar restaurarInscricoes');

  const cena = painelAberto('coord@exemplo.com');
  cena.respostas.filaDeEspera = { ok: false, erro: 'Não consegui ler a fila.' };

  cena.js.ANULADAS = { ids: ['a', 'b'], quantas: 2 };
  cena.js.carregarAuditorio();

  const alerta = cena.texto('auditorio-alerta');
  igual(alerta.indexOf('Promover'), -1, 'a oferta sobreviveu à leitura que falhou: ' + alerta);
  verdadeiro(alerta.indexOf('Anulei 2') !== -1,
    'a notícia do que foi anulado sumiu junto com a falha: ' + alerta);
  verdadeiro(/guardad/i.test(alerta),
    'sumiu a frase que diz que a inscrição não foi destruída: ' + alerta);
  verdadeiro(cena.texto('auditorio-fila').indexOf('Não consegui ler a fila') !== -1,
    cena.texto('auditorio-fila'));
});

teste('a tela do auditório NÃO se atualiza sozinha', () => {
  // Uma lista que se redesenha a cada poucos segundos troca as linhas debaixo do
  // dedo de quem está marcando: o registro tocado deixa de ser o registro visto,
  // e o que se anula é outra pessoa. Quem quer dado novo aperta Atualizar.
  igual(PAGINA.indexOf('setInterval'), -1,
    'apareceu um temporizador no painel — a lista do auditório não pode se mexer sozinha');
  verdadeiro(/id="auditorio-atualizar"/.test(PAGINA), 'sumiu o botão Atualizar do auditório');
});

teste('a marcação é por ID, e nunca por posição na lista', () => {
  // Marcação por posição é o defeito silencioso desta tela: a lista recarrega,
  // as linhas trocam de lugar, e o que se anula é outra pessoa — sem nada na tela
  // dizendo isso. O `id` vem do servidor e não muda.
  const corpo = PAGINA.slice(PAGINA.indexOf('function tocarLinha(lista, id)'),
    PAGINA.indexOf('function limparMarcas(lista)'));
  verdadeiro(corpo.length > 0 && corpo.length < 2000, 'a regra da faixa sumiu do painel');
  verdadeiro(/marcadas\[id\] = true;/.test(corpo), 'a marcação deixou de ser por id');
  verdadeiro(/MARCADAS = \{ recentes: \{\}, fila: \{\} \};/.test(PAGINA),
    'a recarga deixou de limpar a marcação — ela sobreviveria a uma lista que mudou');
});

// ============================================= 3. Entrar com conta Google

grupo('entrar com a conta Google');

teste('o botão é desenhado com o client id que o SERVIDOR devolve', () => {
  // O `config.js` também tem um, e ele NÃO manda: quem verifica o `aud` do token
  // é o servidor, contra a propriedade dele. Desenhar o botão com outro valor
  // produz login que falha sempre, com uma mensagem sobre a conta do professor —
  // que não tem nada a ver com o problema.
  const cena = telaDeLogin({ configuracao: (cfg) => { cfg.googleClientId = ''; } });

  igual(cena.gis.inicializacoes.length, 1);
  igual(cena.gis.inicializacoes[0].client_id, CLIENT_ID);
  igual(cena.gis.botoes.length, 1, 'o botão não chegou a ser desenhado');
  verdadeiro(!escondido(cena, 'bloco-google'));
});

teste('client id diferente nos dois lugares é dito na tela, não escondido', () => {
  const cena = telaDeLogin({
    configuracao: (cfg) => { cfg.googleClientId = '999-outro.apps.googleusercontent.com'; }
  });

  const aviso = cena.texto('aviso-login');
  verdadeiro(aviso.indexOf('diferente em dois lugares') !== -1, aviso);
  // E o botão continua sendo desenhado com o do servidor — que é o que funciona.
  igual(cena.gis.inicializacoes[0].client_id, CLIENT_ID);
});

teste('a credencial do Google vira sessão, e o painel abre', () => {
  const cena = telaDeLogin();
  tokenBom(cena, 'coord@exemplo.com');

  cena.entrarComGoogle(ID_TOKEN);

  const corpo = corpoDe(cena, 'entrarComGoogle');
  igual(corpo.acao, 'login');
  igual(corpo.idToken, ID_TOKEN);

  verdadeiro(escondido(cena, 'tela-login'), 'a tela de login continuou na frente');
  verdadeiro(!escondido(cena, 'tela-painel'), 'o painel não abriu');
  verdadeiro(cena.texto('conteudo-painel').indexOf('Carregando') === -1,
    'o painel abriu mas não carregou');
});

teste('conta fora da lista recebe a frase que resolve o problema dela', () => {
  // "Falha ao entrar" manda o professor ligar para alguém. A recusa do servidor
  // já diz o que fazer, e o painel a mostra INTEIRA em vez de reescrevê-la.
  const cena = telaDeLogin();
  tokenBom(cena, 'outra@exemplo.com');

  cena.entrarComGoogle(ID_TOKEN);

  const erro = cena.texto('erro-login');
  verdadeiro(erro.indexOf('outra@exemplo.com') !== -1, erro);
  verdadeiro(erro.indexOf('não tem acesso ao painel') !== -1, erro);
  verdadeiro(erro.indexOf('incluí-la na lista') !== -1, erro);
  verdadeiro(!escondido(cena, 'tela-login'), 'entrou mesmo sem estar na lista');
});

teste('token que o Google recusa não derruba o link por e-mail junto', () => {
  // A rota é anônima: se a recusa do Google alimentasse um freio compartilhado,
  // seis tokens de mentira trancariam o caminho de conserto de quem tem acesso.
  // O servidor separa os freios (07_Auth.gs e 07b_LinkPorEmail.gs); aqui se
  // prova que o caminho da tela não desfaz a separação.
  const cena = telaDeLogin({ respostas: { pedirLinkDeAcesso: { ok: true, mensagem: FRASE_DO_LINK } } });
  cena.tokeninfo.resposta = { codigo: 400, corpo: { error: 'invalid_token' } };

  for (let i = 0; i < 6; i++) cena.entrarComGoogle(ID_TOKEN);
  verdadeiro(cena.texto('erro-login').indexOf('confirmar sua conta Google') !== -1);

  cena.js.abrirPedidoDeLink();
  cena.digitar('email-link', 'coord@exemplo.com');
  cena.js.enviarPedidoDeLink();

  igual(cena.texto('status-link'), FRASE_DO_LINK, 'o pedido de link foi bloqueado junto');
});

teste('a recuperação fica na mesma tela do botão, e fica FECHADA', () => {
  // As duas metades da decisão, e ela vale como um par: o atalho precisa estar
  // à vista (é ele que salva o dia da configuração errada do Google) e o campo
  // precisa nascer fechado (esperar e-mail é pior do que clicar num botão, e
  // cada pedido gasta cota de envio que existe para o dia ruim).
  const cena = telaDeLogin();

  verdadeiro(!escondido(cena, 'bloco-google'));
  verdadeiro(!escondido(cena, 'bloco-recuperacao'), 'sumiu o atalho de recuperação');
  verdadeiro(!escondido(cena, 'botao-abrir-link'), 'o atalho precisa estar clicável');
  verdadeiro(escondido(cena, 'bloco-link'), 'o campo de e-mail competiu com o botão do Google');
  verdadeiro(escondido(cena, 'bloco-confirmar-link'), 'apareceu confirmação sem link nenhum');

  igual(cena.texto('aviso-login'), '');
  verdadeiro(cena.texto('login-explicacao').indexOf('conta Google autorizada') !== -1,
    cena.texto('login-explicacao'));
});

teste('o clique no atalho abre o campo, e o atalho sai da frente', () => {
  const cena = telaDeLogin();
  cena.js.abrirPedidoDeLink();

  verdadeiro(!escondido(cena, 'bloco-link'), 'o campo de e-mail não abriu');
  verdadeiro(escondido(cena, 'botao-abrir-link'),
    'o atalho continuou ali sem fazer nada — é o que faz clicar três vezes');
  verdadeiro(cena.elemento('email-link').focos > 0, 'o foco não foi para o campo');
});

teste('sem client id no servidor, o link vira o caminho principal e a tela diz o conserto', () => {
  // ERA A "TELA SEM PORTA": acesso por Google impossível de desenhar, e o PIN
  // como único socorro. Agora a porta é outra, e ela abre sozinha — quem lê esta
  // tela é quem pode consertar o botão, desde que saiba o que consertar.
  const cena = telaDeLogin({ clientId: null });

  verdadeiro(escondido(cena, 'bloco-google'), 'desenhou um botão que recusaria todo mundo');
  verdadeiro(!escondido(cena, 'bloco-link'), 'sobrou tela sem porta nenhuma');
  verdadeiro(cena.texto('login-explicacao').indexOf('link de acesso por e-mail') !== -1,
    cena.texto('login-explicacao'));
  verdadeiro(cena.texto('aviso-login').indexOf('GOOGLE_CLIENT_ID') !== -1, cena.texto('aviso-login'));
});

teste('allowlist vazia: a tela ENSINA o liberarMeuAcesso, em vez de parecer quebrada', () => {
  // O único estado sem porta que sobrou, e ele é alcançável de verdade
  // (implantação nova, antes do primeiro e-mail). O botão do Google recusaria
  // todo mundo e não existe endereço para onde mandar link — oferecer o campo de
  // e-mail aqui seria uma porta pintada na parede, porque o pedido responderia a
  // mesma frase gentil de sempre e não enviaria nada.
  const cena = telaDeLogin({ allowlist: '' });

  verdadeiro(escondido(cena, 'bloco-google'));
  verdadeiro(escondido(cena, 'bloco-recuperacao'), 'ofereceu link sem ter para onde mandá-lo');

  const aviso = cena.texto('aviso-login');
  // O comando tem de ser o que o botão Executar do editor CONSEGUE rodar:
  // `liberarAcesso("...")` pede argumento, e o Executar não passa nenhum — quem
  // seguisse a instrução cairia num "informe um e-mail".
  verdadeiro(aviso.indexOf('liberarMeuAcesso') !== -1,
    'a tela precisa dar o comando pronto: ' + aviso);
  igual(/liberarAcesso\(["']/.test(aviso), false,
    'a tela mandou rodar a versão com argumento, que o Executar não roda: ' + aviso);
  verdadeiro(aviso.indexOf('editor do Apps Script') !== -1, aviso);
  verdadeiro(cena.texto('login-explicacao').indexOf('Nenhum e-mail tem acesso') !== -1,
    cena.texto('login-explicacao'));
});

teste('servidor mudo oferece o link — "não sei" não é "sei que não"', () => {
  // Antes esta tela caía no PIN, que era mentira duas vezes: não se sabe se o
  // PIN existe (a resposta não chegou) e o PIN não existe mais.
  //
  // E o detalhe que este teste guarda: sem resposta não há `linkDisponivel`, e
  // `undefined` é falsy. Uma negação simples (`!m.linkDisponivel`) esconderia o
  // pedido de link exatamente aqui — no estado em que ele é a única porta que a
  // tela tem para oferecer, e em que ele provavelmente funciona.
  const cena = telaDeLogin({ respostas: { modoDeAcesso: null } });

  // `modoDeAcesso` entrou em SO_LEITURA em 11/08, então ela é REPETIDA. Uma falha
  // só não derruba mais a tela — que é o conserto — e para chegar ao estado de
  // servidor mudo é preciso deixar as três tentativas acontecerem. Cada uma
  // agenda a seguinte, daí drenar a fila mais de uma vez.
  cena.rodarTarefas(3);

  verdadeiro(!escondido(cena, 'bloco-link'), 'a tela ficou sem oferecer nada');
  igual(cena.elemento('botao-pedir-link').disabled, false,
    'a ignorância sobre o envio travou o pedido');
  igual(cena.elemento('email-link').disabled, false);

  const explicacao = cena.texto('login-explicacao');
  verdadeiro(explicacao.indexOf('Não consegui falar com o servidor') !== -1, explicacao);

  const aviso = cena.texto('aviso-login');
  verdadeiro(aviso.indexOf('config.js') !== -1, 'sem dizer onde se conserta: ' + aviso);
  verdadeiro(aviso.indexOf('liberarMeuAcesso()') !== -1, 'sem a saída de último recurso: ' + aviso);
});

teste('envio fora do ar: o campo abre travado, com o motivo, em vez de prometer e-mail', () => {
  // A cota diária de e-mail da conta Google esgotada — `linkDisponivel: false`
  // vindo de `linkDeAcessoDisponivel_` (07b_LinkPorEmail.gs), pelo caminho de
  // verdade. Sem este campo, a pessoa digitava, lia "se este endereço estiver
  // autorizado, enviamos..." e esperava a tarde inteira por um e-mail que a cota
  // não deixaria sair.
  const cena = telaDeLogin({ cota: 0 });

  // O atalho continua à vista: quem não consegue entrar pelo Google precisa
  // achar a explicação em ALGUM lugar.
  verdadeiro(!escondido(cena, 'bloco-recuperacao'), 'sumiu com a única explicação disponível');
  cena.js.abrirPedidoDeLink();

  igual(cena.elemento('botao-pedir-link').disabled, true, 'o botão prometia um e-mail');
  igual(cena.elemento('email-link').disabled, true);

  const status = cena.texto('status-link');
  verdadeiro(status.indexOf('não está funcionando agora') !== -1, status);
  verdadeiro(status.indexOf('liberarMeuAcesso()') !== -1, 'sem a saída que funciona: ' + status);
  // As três causas possíveis são nomeadas, e a tela admite não saber qual é —
  // `linkDisponivel` é um booleano só, de propósito.
  verdadeiro(status.indexOf('cota diária') !== -1, status);
  verdadeiro(status.indexOf('não dá para saber qual das três') !== -1, status);
});

teste('com o envio fora do ar, nem o Enter manda pedido', () => {
  // O botão desabilitado cobre o clique; a guarda dentro de `enviarPedidoDeLink`
  // cobre o resto. Gastar uma execução do Apps Script para receber a frase gentil
  // de sempre é o que `linkDisponivel` existe para evitar.
  const cena = telaDeLogin({ cota: 0 });
  cena.js.abrirPedidoDeLink();

  const antes = cena.requisicoesHttp.length;
  cena.elemento('email-link').value = 'coord@exemplo.com';
  cena.elemento('email-link').disparar('keydown', { key: 'Enter' });
  cena.js.enviarPedidoDeLink();

  igual(cena.requisicoesHttp.length, antes, 'saiu pedido com o envio comprovadamente fora do ar');
});

teste('sem escopo de e-mail e sem client id: a tela admite que não há porta', () => {
  // A implantação recém-atualizada, antes de alguém autorizar `script.send_mail`:
  // o próprio `MailApp` estoura, `linkDeAcessoDisponivel_` devolve false pelo
  // `catch`, e se o client id também faltar não sobra porta remota nenhuma.
  // Mostrar um formulário aqui seria a porta pintada na parede de novo.
  const cena = telaDeLogin({ semEscopoEmail: true, clientId: null });

  verdadeiro(escondido(cena, 'bloco-google'));
  verdadeiro(escondido(cena, 'bloco-recuperacao'), 'ofereceu um pedido que não sairia');
  verdadeiro(cena.texto('login-explicacao').indexOf('Nenhuma das duas formas') !== -1,
    cena.texto('login-explicacao'));

  const aviso = cena.texto('aviso-login');
  verdadeiro(aviso.indexOf('autorização de envio') !== -1, aviso);
  verdadeiro(aviso.indexOf('GOOGLE_CLIENT_ID') !== -1, aviso);
  verdadeiro(aviso.indexOf('liberarMeuAcesso') !== -1, aviso);
});

teste('biblioteca do Google que não carrega abre o pedido de link', () => {
  // Rede da faculdade bloqueando accounts.google.com é o caso concreto. A tela
  // espera, desiste, conta — e abre a outra porta, porque naquele momento o
  // botão do Google deixou de existir nesta tela.
  const cena = telaDeLogin({ semGis: true });

  verdadeiro(cena.tarefas.length > 0, 'a tela nem tentou esperar a biblioteca');
  for (let i = 0; i < 45; i++) cena.rodarTarefas();

  const status = cena.texto('google-status');
  verdadeiro(status.indexOf('accounts.google.com') !== -1, status);
  verdadeiro(status.indexOf('link de acesso por e-mail') !== -1, status);
  verdadeiro(!escondido(cena, 'bloco-link'), 'a outra porta precisava abrir sozinha aqui');
});

teste('sair volta para a tela de login com a recuperação fechada e vazia', () => {
  const cena = telaDeLogin();
  tokenBom(cena, 'coord@exemplo.com');
  cena.entrarComGoogle(ID_TOKEN);
  verdadeiro(!escondido(cena, 'tela-painel'));

  cena.js.abrirPedidoDeLink();
  cena.digitar('email-link', 'coord@exemplo.com');
  cena.js.sairDoPainel();

  verdadeiro(!escondido(cena, 'tela-login'));
  verdadeiro(!escondido(cena, 'bloco-google'), 'a tela de login voltou sem o botão do Google');
  verdadeiro(!escondido(cena, 'bloco-recuperacao'));
  // Numa máquina compartilhada, o e-mail de quem acabou de sair não fica escrito
  // na tela para a pessoa seguinte.
  verdadeiro(escondido(cena, 'bloco-link'), 'a recuperação ficou aberta depois do logout');
  igual(cena.elemento('email-link').value, '', 'sobrou o e-mail de quem saiu no campo');
  igual(corpoDe(cena, 'sair').acao, 'login');
});

// ============================================ 3b. O link por e-mail

grupo('pedir o link por e-mail');

teste('a frase do servidor vai para a tela COMO VEIO', () => {
  // O painel não conclui nada a partir da resposta, e é isso que o teste fixa:
  // `mensagem` inteira, sem prefixo, sem "pronto!", sem reescrever.
  const cena = telaDeLogin({ respostas: { pedirLinkDeAcesso: { ok: true, mensagem: FRASE_DO_LINK } } });

  cena.js.abrirPedidoDeLink();
  cena.digitar('email-link', 'coord@exemplo.com');
  cena.js.enviarPedidoDeLink();

  igual(cena.texto('status-link'), FRASE_DO_LINK);
});

teste('a tela é IDÊNTICA para quem está na lista e para quem não está', () => {
  // A propriedade principal do desenho, e a mais fácil de estragar por gentileza:
  // `pedirLinkDeAcesso` (07b_LinkPorEmail.gs) devolve a MESMA frase nos dois
  // casos para a rota anônima não virar um oráculo que responde "quem administra
  // o CESUTECH?". Uma tela que distinguisse os dois — por texto, por cor, por um
  // ícone — destruiria isso sozinha, do lado de cá.
  const encenar = { pedirLinkDeAcesso: { ok: true, mensagem: FRASE_DO_LINK } };

  const daLista = telaDeLogin({ respostas: encenar });
  daLista.js.abrirPedidoDeLink();
  daLista.digitar('email-link', 'coord@exemplo.com');
  daLista.js.enviarPedidoDeLink();

  const deFora = telaDeLogin({ respostas: encenar });
  deFora.js.abrirPedidoDeLink();
  deFora.digitar('email-link', 'estranho@exemplo.com');
  deFora.js.enviarPedidoDeLink();

  igual(deFora.texto('status-link'), daLista.texto('status-link'));
  igual(deFora.texto('erro-login'), daLista.texto('erro-login'));
  // E nada na tela afirma que alguma coisa foi enviada — só o servidor fala.
  igual(/enviamos um link para|e-mail enviado|não encontrado|não autorizado/i
    .test(daLista.texto('status-link')), false, daLista.texto('status-link'));
});

teste('pedido feito desabilita o botão por 120 segundos, contando na tela', () => {
  // É gentileza de interface, e não segurança: o servidor recusa o segundo
  // pedido em SILÊNCIO (mesma frase), então sem a contagem a pessoa clicaria de
  // novo e concluiria que saíram dois e-mails.
  const cena = telaDeLogin({ respostas: { pedirLinkDeAcesso: { ok: true, mensagem: FRASE_DO_LINK } } });

  cena.js.abrirPedidoDeLink();
  cena.digitar('email-link', 'coord@exemplo.com');
  cena.js.enviarPedidoDeLink();

  const botao = cena.elemento('botao-pedir-link');
  verdadeiro(botao.disabled, 'o botão continuou clicável depois do pedido');
  verdadeiro(botao.textContent.indexOf('120') !== -1,
    'a espera precisa aparecer em segundos: ' + botao.textContent);

  cena.rodarTarefas();
  verdadeiro(botao.textContent.indexOf('119') !== -1, botao.textContent);

  // E ela ACABA: 120 passadas do relógio devolvem o botão com o rótulo original.
  for (let i = 0; i < 121; i++) cena.rodarTarefas();
  igual(botao.disabled, false, 'o botão não voltou depois da espera');
  igual(botao.textContent, 'Enviar link de acesso');
});

teste('Enter no campo de e-mail vale por um clique', () => {
  // O campo não está dentro de um <form>: sem o ouvinte, a tecla não faz nada e
  // a pessoa fica olhando para uma tela que não respondeu.
  const cena = telaDeLogin({ respostas: { pedirLinkDeAcesso: { ok: true, mensagem: FRASE_DO_LINK } } });

  cena.js.abrirPedidoDeLink();
  cena.digitar('email-link', 'coord@exemplo.com');
  cena.elemento('email-link').disparar('keydown', { key: 'Enter' });

  igual(corpoDe(cena, 'pedirLinkDeAcesso').email, 'coord@exemplo.com');
});

teste('pedir com o campo vazio não gasta uma requisição', () => {
  const cena = telaDeLogin();
  cena.js.abrirPedidoDeLink();

  const antes = cena.requisicoesHttp.length;
  cena.js.enviarPedidoDeLink();

  igual(cena.requisicoesHttp.length, antes, 'saiu pedido de link sem e-mail nenhum');
  verdadeiro(cena.texto('status-link').indexOf('Digite o e-mail') !== -1, cena.texto('status-link'));
});

teste('falha de rede no pedido devolve o botão na hora', () => {
  // O pedido não chegou ao servidor: não há freio a respeitar, e prender o botão
  // por dois minutos seria punir a pessoa pelo wi-fi.
  const cena = telaDeLogin({ respostas: { pedirLinkDeAcesso: null } });

  cena.js.abrirPedidoDeLink();
  cena.digitar('email-link', 'coord@exemplo.com');
  cena.js.enviarPedidoDeLink();

  igual(cena.elemento('botao-pedir-link').disabled, false);
  verdadeiro(cena.texto('status-link').indexOf('Confira sua conexão') !== -1,
    cena.texto('status-link'));
});

grupo('entrar pelo link — o `?entrar=` do e-mail');

teste('abrir o link NÃO consome o token: nenhuma requisição sai antes do clique', () => {
  // O teste mais importante desta tela.
  //
  // Scanners de segurança de e-mail (Defender, Proofpoint, o antivírus da
  // faculdade) ABREM cada link das mensagens que filtram, e alguns clientes
  // pré-carregam links da mensagem aberta. Se o carregamento consumisse o token,
  // o link morreria nas mãos do robô e a pessoa leria "este link não vale mais"
  // num link que acabou de chegar — um defeito que só acontece na caixa de
  // ALGUMAS pessoas, e que ninguém consegue reproduzir.
  //
  // A afirmação é sobre requisição, e não sobre estado de tela: zero requisições
  // é o que prova que nada foi gasto.
  const cena = telaDeLogin({ busca: '?entrar=' + TOKEN_LINK });

  igual(cena.requisicoesHttp.length, 0,
    'saiu requisição no carregamento: ' + JSON.stringify(cena.requisicoesHttp.map((r) => r.corpo)));
  verdadeiro(!escondido(cena, 'bloco-confirmar-link'), 'a confirmação não apareceu');
  verdadeiro(escondido(cena, 'tela-painel'), 'entrou sozinho, sem ninguém confirmar');
});

teste('o token some da barra de endereço no carregamento', () => {
  // Histórico do navegador e cabeçalho `Referer`: os dois carregam a URL atual
  // para lugares onde o token não deveria chegar. A limpeza é `replaceState`
  // porque `pushState` deixaria a URL com token a um Voltar de distância.
  const cena = telaDeLogin({ busca: '?entrar=' + TOKEN_LINK });

  igual(cena.janela.location.search, '', 'o token continua na barra de endereço');
  igual(cena.historico.length, 1, 'a barra não foi reescrita');
  igual(cena.historico[0], '/unicesusc-cesutech/painel/',
    'a limpeza tem de sobrar o caminho da página, e nada mais');
});

teste('o clique confirma com o token que veio no link', () => {
  const cena = telaDeLogin({
    busca: '?entrar=' + TOKEN_LINK,
    respostas: {
      // A sessão devolvida é a do ambiente falso, e tem de ser VÁLIDA: o painel
      // abre carregando os números, e um token de mentira faria o servidor
      // responder "sessão expirada" — devolvendo a tela de login e escondendo o
      // que este teste quer ver.
      entrarComLink: (corpo, cena) =>
        ({ ok: true, token: cena.token, usuario: 'coord@exemplo.com', via: 'link' })
    }
  });

  cena.js.confirmarEntradaPorLink();

  igual(corpoDe(cena, 'entrarComLink'),
    { acao: 'login', fn: 'entrarComLink', token: TOKEN_LINK });
  verdadeiro(!escondido(cena, 'tela-painel'), 'o painel não abriu depois da confirmação');
  verdadeiro(escondido(cena, 'tela-login'));
});

teste('link recusado mostra a frase do servidor e oferece pedir outro', () => {
  const recusa = 'Este link não vale mais. Peça um novo na tela de acesso — cada link ' +
    'funciona uma vez só e expira em 15 minutos.';
  const cena = telaDeLogin({
    busca: '?entrar=' + TOKEN_LINK,
    respostas: { entrarComLink: { ok: false, erro: recusa } }
  });

  cena.js.confirmarEntradaPorLink();

  igual(cena.texto('erro-login'), recusa, 'a recusa foi reescrita pela tela');
  verdadeiro(escondido(cena, 'bloco-confirmar-link'), 'sobrou um botão que não funciona mais');
  // "Peça um novo na tela de acesso" tem de ser um campo à mão, e não uma
  // instrução: a tela de opções aparece com o pedido já aberto.
  verdadeiro(!escondido(cena, 'bloco-link'), 'a pessoa teria de achar o atalho sozinha');
});

teste('falha de rede na confirmação não queima o link', () => {
  // O pedido não chegou ao servidor, então o token continua vivo. Mandar a
  // pessoa pedir outro link aqui desperdiçaria um link válido por causa de um
  // segundo de conexão ruim.
  const cena = telaDeLogin({
    busca: '?entrar=' + TOKEN_LINK,
    respostas: { entrarComLink: null }
  });

  cena.js.confirmarEntradaPorLink();

  verdadeiro(!escondido(cena, 'bloco-confirmar-link'), 'o botão de confirmar sumiu');
  igual(cena.elemento('botao-confirmar-link').disabled, false, 'não dá para tentar de novo');
  igual(cena.elemento('botao-confirmar-link').textContent, 'Confirmar e entrar');
  verdadeiro(cena.texto('erro-login').indexOf('o link continua valendo') !== -1,
    cena.texto('erro-login'));
});

teste('os rótulos dos botões estão escritos igual no HTML e no JS', () => {
  // As duas constantes existem para o botão voltar ao que era depois de dizer
  // "Enviando..."; se elas divergirem do HTML, o rótulo muda sozinho no primeiro
  // clique e ninguém percebe olhando o código.
  verdadeiro(PAGINA.indexOf('>Enviar link de acesso<') !== -1);
  verdadeiro(PAGINA.indexOf(">Confirmar e entrar<") !== -1);
  verdadeiro(/var ROTULO_PEDIR_LINK = 'Enviar link de acesso';/.test(PAGINA));
  verdadeiro(/var ROTULO_CONFIRMAR_LINK = 'Confirmar e entrar';/.test(PAGINA));
});

teste('o circuito inteiro, das duas pontas: pedir, receber o e-mail e entrar', () => {
  // O ÚNICO teste daqui que não encena resposta nenhuma. Ele vale pelo que os
  // outros não podem provar: que o envelope que esta tela monta é o que
  // `rotaDeLogin_` (08_Api.gs) sabe abrir, nas duas rotas novas — o `email` do
  // pedido e o `token` da confirmação. Um nome ou uma chave trocada aparece aqui,
  // e não no clique do professor.
  //
  // O QUE ELE NÃO PERCORRE, e está escrito para não ser confundido: a leitura do
  // `?entrar=`. O token só existe depois do pedido, e o ambiente falso não
  // sobrevive a uma segunda abertura de página — então a "chegada pelo link" é
  // `pedirConfirmacaoDoLink`, chamada com o token que veio do e-mail. O caminho
  // da URL até ela é o que os testes do `?entrar=` provam, logo acima.
  const caixa = [];
  const cena = telaDeLogin({ emails: caixa });

  cena.js.abrirPedidoDeLink();
  cena.digitar('email-link', 'coord@exemplo.com');
  cena.js.enviarPedidoDeLink();

  igual(caixa.length, 1, 'o pedido não chegou a virar e-mail');
  igual(caixa[0].to, 'coord@exemplo.com');
  // A frase que a tela mostrou é a do servidor, e não uma cópia deste arquivo.
  verdadeiro(cena.texto('status-link').indexOf('Se este endereço estiver autorizado') !== -1,
    cena.texto('status-link'));

  const doEmail = /\?entrar=([0-9a-f]+)/.exec(caixa[0].body);
  verdadeiro(doEmail !== null, 'o e-mail saiu sem link: ' + caixa[0].body);

  cena.js.pedirConfirmacaoDoLink(doEmail[1]);
  verdadeiro(!escondido(cena, 'bloco-confirmar-link'));

  cena.js.confirmarEntradaPorLink();

  verdadeiro(!escondido(cena, 'tela-painel'), 'o link não abriu o painel: ' + cena.texto('erro-login'));
  verdadeiro(cena.js.lerToken(), 'entrou sem guardar a sessão');
});

teste('o link só funciona uma vez — a segunda confirmação é recusada na tela', () => {
  // Prova de ponta a ponta do consumo: quem clica duas vezes (ou quem intercepta
  // o link depois) recebe a recusa do servidor, e a tela a mostra inteira.
  const caixa = [];
  const cena = telaDeLogin({ emails: caixa });

  cena.js.abrirPedidoDeLink();
  cena.digitar('email-link', 'coord@exemplo.com');
  cena.js.enviarPedidoDeLink();

  const token = /\?entrar=([0-9a-f]+)/.exec(caixa[0].body)[1];

  cena.js.pedirConfirmacaoDoLink(token);
  cena.js.confirmarEntradaPorLink();
  cena.js.sairDoPainel();

  cena.js.pedirConfirmacaoDoLink(token);
  cena.js.confirmarEntradaPorLink();

  verdadeiro(escondido(cena, 'tela-painel'), 'o mesmo link entrou duas vezes');
  verdadeiro(cena.texto('erro-login').indexOf('Este link não vale mais') !== -1,
    cena.texto('erro-login'));
});

grupo('entrar pela sessão do liberarMeuAcesso — o `?sessao=`');

teste('`?sessao=` entra direto, sem confirmação nenhuma', () => {
  // Aqui o token JÁ É uma sessão: quem rodou `liberarMeuAcesso()` no editor do Apps
  // Script tem acesso ao projeto inteiro, e pedir confirmação a ele seria
  // cerimônia. A confirmação do `?entrar=` existe contra robô de caixa de
  // e-mail, e esta URL não passou por caixa de e-mail nenhuma.
  // `busca` como função: o token é uma sessão de verdade do ambiente falso, e ela
  // só existe depois de ele subir — é o mesmo que `liberarMeuAcesso()` faz no
  // editor, onde a sessão nasce antes de a URL ser impressa.
  const cena = abrirPainel({
    deslogado: true,
    usuario: '',
    busca: (token) => '?sessao=' + token,
    semear: (api) => {
      api.semearConfigPadrao_();
      api.gravarConfig('admin_emails', 'coord@exemplo.com');
    }
  });

  verdadeiro(!escondido(cena, 'tela-painel'), 'não entrou');
  verdadeiro(escondido(cena, 'tela-login'));
  verdadeiro(escondido(cena, 'bloco-confirmar-link'), 'pediu confirmação para uma sessão pronta');
  igual(cena.janela.location.search, '', 'a sessão continua na barra de endereço');
  igual(cena.historico.length, 1, 'a barra não foi limpa no caminho do `?sessao=`');
});

teste('a sessão do link é GUARDADA, senão a primeira recarga joga a pessoa fora', () => {
  // A barra de endereço foi limpa: se o token não for para o `sessionStorage`, a
  // recarga cai no login e a pessoa não tem mais o endereço para tentar de novo.
  const cena = abrirPainel({
    deslogado: true,
    usuario: '',
    busca: (token) => '?sessao=' + token,
    semear: (api) => {
      api.semearConfigPadrao_();
      api.gravarConfig('admin_emails', 'coord@exemplo.com');
    }
  });

  igual(cena.js.lerToken(), cena.token);
});

teste('`?sessao=` com token morto cai no login, e não num painel de mentira', () => {
  const cena = abrirPainel({
    deslogado: true,
    usuario: '',
    busca: '?sessao=JA_VENCIDA',
    semear: (api) => {
      api.semearConfigPadrao_();
      api.gravarConfig('admin_emails', 'coord@exemplo.com');
    }
  });

  verdadeiro(!escondido(cena, 'tela-login'), 'ficou num painel em que nenhum botão funciona');
  igual(cena.js.lerToken(), null, 'guardou um token que o servidor já recusou');
});

// ================================================== 4. Quem tem acesso

grupo('a tela de quem tem acesso ao painel');

teste('a aba Configurações lista os e-mails e marca qual é o meu', () => {
  const cena = painelAberto('coord@exemplo.com, outra@exemplo.com');
  cena.js.trocarAba('config');

  const texto = cena.texto('conteudo-acesso');
  verdadeiro(texto.indexOf('coord@exemplo.com') !== -1, texto);
  verdadeiro(texto.indexOf('outra@exemplo.com') !== -1, texto);
  verdadeiro(texto.indexOf('(você)') !== -1, 'sem saber quem sou eu, "remover a si mesmo" vira surpresa');
});

teste('a tela diz que remover tira o acesso NA HORA', () => {
  // É a informação que muda a decisão: quem remove precisa saber que a pessoa
  // não fica dentro do painel até o fim do dia.
  const cena = painelAberto('coord@exemplo.com, outra@exemplo.com');
  cena.js.trocarAba('config');

  const texto = cena.texto('conteudo-acesso');
  verdadeiro(texto.indexOf('Remover tira o acesso na hora') !== -1, texto);
  verdadeiro(texto.indexOf('sendo o último') !== -1, texto);
});

teste('incluir grava de verdade e a lista redesenha sem outra ida ao servidor', () => {
  const cena = painelAberto('coord@exemplo.com');
  cena.js.trocarAba('config');
  cena.digitar('acesso-novo', 'Nova.Pessoa@Exemplo.com');

  const antes = cena.requisicoesHttp.length;
  cena.js.incluirAcesso();

  igual(cena.requisicoesHttp.length, antes + 1,
    'redesenhar a lista com o que a resposta já trouxe custa zero leitura a mais');
  verdadeiro(cena.texto('conteudo-acesso').indexOf('nova.pessoa@exemplo.com') !== -1,
    'o e-mail entrou normalizado em minúsculas — é a mesma conta no Google');
  igual(cena.api.config('admin_emails'), 'coord@exemplo.com, nova.pessoa@exemplo.com');
});

teste('remover pergunta antes, e a pergunta diz o que vai acontecer', () => {
  const cena = painelAberto('coord@exemplo.com, outra@exemplo.com');
  cena.js.trocarAba('config');
  cena.respostaConfirm = false;

  cena.js.removerAcesso('outra@exemplo.com');

  verdadeiro(cena.confirmacoes[0].indexOf('encerrada na hora') !== -1, cena.confirmacoes[0]);
  igual(cena.api.config('admin_emails'), 'coord@exemplo.com, outra@exemplo.com',
    'recusar a pergunta removeu assim mesmo');
});

teste('remover derruba a sessão da pessoa na mesma chamada', () => {
  const cena = painelAberto('coord@exemplo.com, outra@exemplo.com');
  const tokenDela = cena.api.criarSessao_('outra@exemplo.com');
  igual(cena.api.sessaoAtiva(tokenDela).ok, true);

  cena.js.trocarAba('config');
  cena.js.removerAcesso('outra@exemplo.com');

  igual(cena.api.sessaoAtiva(tokenDela).ok, false,
    'tirar da lista e deixar entrar por mais 8 horas é não ter tirado');
  verdadeiro(cena.texto('mensagem-global').indexOf('sessão dele foi encerrada') !== -1);
});

teste('remover a si mesmo encerra a própria sessão e cai no login explicando', () => {
  const cena = painelAberto('coord@exemplo.com, outra@exemplo.com');
  cena.js.trocarAba('config');

  cena.js.removerAcesso('coord@exemplo.com');

  verdadeiro(cena.confirmacoes[0].indexOf('VOCÊ MESMO') !== -1, cena.confirmacoes[0]);
  verdadeiro(!escondido(cena, 'tela-login'), 'continuaria numa tela onde nenhum botão funciona');
  const aviso = cena.texto('aviso-login');
  verdadeiro(aviso.indexOf('saiu da lista de acesso') !== -1, aviso);
});

teste('o último da lista não sai, e a recusa do servidor chega à tela', () => {
  const cena = painelAberto('coord@exemplo.com');
  cena.js.trocarAba('config');

  cena.js.removerAcesso('coord@exemplo.com');

  const msg = cena.texto('mensagem-global');
  verdadeiro(msg.indexOf('único e-mail autorizado') !== -1, msg);
  igual(cena.api.config('admin_emails'), 'coord@exemplo.com', 'a lista foi esvaziada');
  verdadeiro(escondido(cena, 'tela-login'), 'a recusa derrubou a sessão sem precisar');
});

teste('listar quem tem acesso não faz o painel esquecer as outras abas', () => {
  // A aba Configurações agora chama DUAS funções. Se `listarAdmins` não fosse
  // declarada como leitura, cada visita a ela mandaria as outras sete recarregar
  // do zero — uma execução inteira do Apps Script por aba, de graça.
  const cena = painelAberto('coord@exemplo.com');
  cena.js.trocarAba('log');
  cena.js.trocarAba('config');

  const antes = cena.requisicoesHttp.length;
  cena.js.trocarAba('log');
  igual(cena.requisicoesHttp.length, antes, 'a memória de aba foi perdida ao abrir Configurações');
});

teste('o endereço do painel mostrado em Configurações é o NOVO', () => {
  // É onde a coordenação vem procurar o link para salvar. Mostrar o `?p=admin`
  // faria o favorito nascer velho, apontando para a página que só redireciona.
  const cena = painelAberto('coord@exemplo.com');
  // `urlDoWebApp_` pergunta ao Apps Script qual é o endereço desta implantação;
  // fora de uma implantação publicada ele devolve '' e o cartão nem aparece.
  cena.api.ScriptApp = {
    getOAuthToken: () => 'token-de-mentira',
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/AAA/exec' })
  };
  cena.js.trocarAba('config');

  const texto = cena.texto('conteudo-config');
  verdadeiro(texto.indexOf('/painel/') !== -1, texto.slice(0, 300));
  igual(texto.indexOf('?p=admin'), -1, 'o painel ainda anuncia o endereço antigo');
});

// ============================================== 5. O endereço antigo

grupo('o /exec?p=admin, que agora só leva ao painel novo');

teste('o Admin.html não é mais o painel', () => {
  // Se ele continuasse sendo, seriam duas telas com os mesmos 22 botões falando
  // com o mesmo servidor — e a que ninguém abre é a que deixa de ser corrigida.
  igual(STUB.indexOf('data-aba="alunos"'), -1, 'sobrou painel no arquivo que deveria só redirecionar');
  igual(/google\.script\.run\s*[.[]/.test(STUB), false);
  verdadeiro(STUB.length < 8000, 'o redirecionamento não deveria ter ' + STUB.length + ' bytes');
});

teste('ele mostra o endereço novo escrito, e não só redireciona', () => {
  // Redirecionar calado leva a pessoa ao lugar certo e a deixa com o link velho
  // para sempre. E, dentro do iframe do Apps Script, a navegação automática do
  // topo costuma ser bloqueada — o link clicável é o mecanismo, não o enfeite.
  verdadeiro(/target="_top"/.test(STUB), 'sem _top o painel abriria dentro do iframe do Apps Script');
  verdadeiro(/<strong>https:\/\/[^<]*\/painel\/<\/strong>/.test(STUB),
    'o endereço precisa estar visível para ser copiado');
  // O stub precisa contar QUAL é a saída quando o botão do Google recusa a
  // conta — é a pergunta que traz alguém a este endereço antigo. Antes ele
  // apontava para o PIN; o PIN foi removido, e apontar para uma porta que não
  // existe mais é pior do que não apontar para nenhuma.
  verdadeiro(/Não consigo entrar com o Google/.test(STUB),
    'a página tem de nomear a porta de recuperação que existe hoje');
  verdadeiro(!/entre pelo PIN/.test(STUB),
    'o stub não pode mandar ninguém para o PIN, que não existe mais');
});

teste('o endereço do stub é o mesmo BASE_SITE do painel', () => {
  const doPainel = /var BASE_SITE = '([^']+)'/.exec(PAGINA)[1];
  const doStub = /href="([^"]+\/painel\/)"/.exec(STUB)[1];
  igual(doStub, doPainel + '/painel/',
    'os dois endereços divergiram — um deles leva a lugar nenhum');
});

teste('o formulário interno continua servido pelo mesmo caminho', () => {
  // `paginaHtml_` (08_Api.gs) serve `Cadastro` para tudo que não é `?p=admin`, e
  // esta fase não tocou nele. O Cadastro.html continua usando o include que
  // acabou de ganhar um gêmeo no Pages.
  verdadeiro(/<\?!= include\('Estilos'\) \?>/.test(
    fs.readFileSync(path.join(RAIZ, 'apps-script', 'Cadastro.html'), 'utf8')),
  'o formulário interno perdeu o estilo');
});

// ======================================= 6. O site do aluno, intocado

grupo('o site público não pode ter sido afetado');

teste('o formulário do aluno não sabe que o painel existe', () => {
  // A busca é por LINK, e não pela palavra: `painel-sucesso` é uma classe de
  // CSS do próprio formulário, e proibir a palavra proibiria o nome dela.
  igual(/href="[^"]*painel/.test(INDEX), false, 'o site do aluno ganhou link para o painel');
  igual(APP_JS.indexOf("acao: 'painel'"), -1, 'o app do aluno ganhou envelope de painel');
  igual(APP_JS.indexOf("acao: 'login'"), -1);
});

teste('o config.js continua entregando o que o site do aluno lê', () => {
  // A lista é a do que o app.js LÊ mesmo. `cursosPadrao` e `turnosPadrao`
  // estavam aqui e saíram em 13/08: nenhuma linha do site as usava — a chamada
  // de "reserva" no comentário era falsa — e os nomes eram os do sistema
  // anterior. Voltar com elas é voltar com dado errado à espera de alguém
  // "ligar o fallback", e o que a inscrição gravaria seria um curso inexistente.
  ['endpoint', 'textoLgpdPadrao', 'contato']
    .forEach((chave) => {
      verdadeiro(new RegExp('\\b' + chave + ':').test(CONFIG_JS), 'sumiu ' + chave + ' do config.js');
    });
  ['cursosPadrao', 'turnosPadrao'].forEach((morta) => {
    verdadeiro(!new RegExp('\\b' + morta + ':').test(CONFIG_JS),
      morta + ' voltou ao config.js — o site não lê essa chave, e o conteúdo dela é do sistema velho');
  });
  // O campo novo é do painel, e ele nasce vazio: preenchê-lo é passo de console.
  verdadeiro(/googleClientId: ''/.test(CONFIG_JS),
    'o client id não pode nascer com valor — ele muda por implantação');
});

teste('as rotas públicas continuam sendo GET, e o POST do aluno continua sendo inscrição', () => {
  verdadeiro(/buscar\('\?api=projetos'\)/.test(APP_JS));
  verdadeiro(/buscar\('\?api=config'\)/.test(APP_JS));
  verdadeiro(/acao: 'inscricao'/.test(APP_JS));
});

// ====================== A largura das listas e as duas exportações (18/08)

/**
 * O que estes testes cuidam, e o que eles NÃO cuidam.
 *
 * O comportamento — abrir larga, filtrar, exportar o recorte — é clicado em
 * `painel-navegador.js`. Aqui ficam as três coisas que só a PÁGINA e a FOLHA DE
 * ESTILO garantem, e que nenhum clique alcança: o arquivo do gerador de planilha
 * estar realmente pedido pela página, o contêiner de impressão estar onde a regra
 * de CSS o procura, e a regra de impressão esconder o resto da tela.
 *
 * A última é a que dói se faltar: o `.modal-fundo` é `position: fixed` com fundo
 * escuro por cima da página inteira, e sobrando na impressão o professor recebe
 * uma página PRETA no lugar da lista.
 */
grupo('as listas largas, o Excel e a folha impressa');

teste('a página pede o gerador de planilha, e ANTES do código do painel', () => {
  verdadeiro(/<script src="\.\.\/assets\/planilha\.js"><\/script>/.test(PAGINA),
    'sem o arquivo pedido aqui, `window.Planilha` não existe e o Exportar Excel recusa');
  verdadeiro(PAGINA.indexOf('assets/planilha.js') < PAGINA.indexOf('var TOKEN = null;'),
    'o gerador é carregado depois do painel');

  // Arquivo NOSSO, servido junto com a página. O dia em que alguém trocar isto
  // por um CDN, a regra da casa (nenhum recurso de terceiro além do login do
  // Google) morre em silêncio.
  verdadeiro(!/<script src="https?:\/\/[^"]*(sheet|xlsx|excel)/i.test(PAGINA),
    'entrou biblioteca de planilha de terceiro na página');
});

teste('o contêiner de impressão é FILHO DIRETO do body — é ali que a regra o procura', () => {
  verdadeiro(/<div id="area-impressao"/.test(PAGINA), 'sumiu o contêiner de impressão');

  // A regra é `body.imprimindo > *:not(#area-impressao)`, e o `>` é o filho
  // direto: um nível a mais de aninhamento o deixaria escondido junto com o resto
  // da tela, e o "Exportar PDF" imprimiria uma folha em branco.
  const corpo = PAGINA.slice(PAGINA.indexOf('<body'), PAGINA.indexOf('<div id="area-impressao"'));
  const abertas = (corpo.match(/<div\b/g) || []).length;
  const fechadas = (corpo.match(/<\/div>/g) || []).length;
  igual(abertas, fechadas,
    'o #area-impressao nasceu dentro de outra <div> — a regra de impressão não o alcança');
});

teste('imprimir esconde a tela inteira, e só com a classe no body', () => {
  verdadeiro(/@media print/.test(CSS_PAINEL), 'sumiu o bloco de impressão do CSS');

  verdadeiro(/body\.imprimindo > \*:not\(#area-impressao\)\s*\{[^}]*display:\s*none/.test(CSS_PAINEL),
    'a impressão deixou de esconder o resto da tela — o .modal-fundo sai como página preta');
  verdadeiro(/body\.imprimindo #area-impressao\s*\{[^}]*display:\s*block/.test(CSS_PAINEL),
    'a folha não é mostrada na impressão');

  // A classe no body é o que impede este bloco de valer para todo Ctrl+P. Sem
  // ela, o `Cadastro.html` — que é o GÊMEO deste CSS e não tem contêiner de
  // impressão nenhum — imprimiria folha em branco no balcão.
  verdadeiro(!/^\s*> \*:not\(#area-impressao\)/m.test(CSS_PAINEL),
    'a regra de impressão passou a valer sem a classe do body');
  verdadeiro(/#area-impressao\s*\{\s*display:\s*none;\s*\}/.test(CSS_PAINEL),
    'o contêiner deixou de nascer escondido — ele apareceria no meio do painel');
});

teste('a folha impressa repete o cabeçalho e não parte aluno no meio', () => {
  // As duas coisas que o navegador faz de graça e que são o motivo de o "PDF"
  // ser uma impressão, e não uma biblioteca.
  verdadeiro(/#area-impressao thead\s*\{[^}]*display:\s*table-header-group/.test(CSS_PAINEL),
    'o cabeçalho da tabela deixou de repetir a cada página');
  verdadeiro(/#area-impressao tr\s*\{[^}]*break-inside:\s*avoid/.test(CSS_PAINEL),
    'linha de aluno voltou a poder ser partida entre duas páginas');

  // O `th` da folha desfaz o `position: sticky` da regra geral: cabeçalho grudado
  // não é repetido pelo navegador na impressão.
  verdadeiro(/#area-impressao th\s*\{[^}]*position:\s*static/.test(CSS_PAINEL),
    'o cabeçalho da folha continua sticky, e sticky não se repete no papel');

  // Impressora preto-e-branco: o selo tem borda, e não só cor de fundo.
  verdadeiro(/\.impressao__selo\s*\{[^}]*border:/.test(CSS_PAINEL),
    'o selo da folha ficou dependendo só de cor');
});

teste('a largura das listas é um MODIFICADOR — o formulário continua nos 780px', () => {
  verdadeiro(/\.modal\s*\{[^}]*max-width:\s*780px/.test(CSS_PAINEL),
    'alargaram o .modal no atacado — os sete formulários da tela foram junto');
  verdadeiro(/\.modal--largo\s*\{[^}]*max-width:\s*1180px/.test(CSS_PAINEL),
    'sumiu o modificador de largura das janelas de lista');
  verdadeiro(/\.modal--largo\s*\{[^}]*width:\s*100%/.test(CSS_PAINEL),
    'sem width:100% a janela larga estoura a tela do celular');

  // E a última coluna continua alcançável onde nem 1180px cabem.
  verdadeiro(/\.tabela-wrap\s*\{[^}]*overflow-x:\s*auto/.test(CSS_PAINEL),
    'a tabela perdeu a rolagem horizontal — em tela estreita a última coluna fica inalcançável');
});

teste('só as DUAS janelas de lista alargam, e o fechamento é quem estreita', () => {
  // A varredura sai do próprio arquivo: quem chama `janelaLarga(true)` são as
  // duas janelas de "Inscritos", e `janelaLarga(false)` mora num lugar só — o
  // `fecharModal`, por onde TODA saída da janela passa.
  igual((PAGINA.match(/janelaLarga\(true\)/g) || []).length, 2,
    'uma terceira janela passou a alargar, ou uma das duas deixou de alargar');
  igual((PAGINA.match(/janelaLarga\(false\)/g) || []).length, 1,
    'a limpeza da largura deixou de ser feita num lugar só');

  const fechar = /function fecharModal\(\)[\s\S]*?\n  \}/.exec(PAGINA);
  verdadeiro(fechar !== null, 'fecharModal sumiu do painel');
  verdadeiro(/janelaLarga\(false\)/.test(fechar[0]),
    'a janela larga deixou de ser estreitada ao fechar — o próximo formulário herda 1180px');
});

teste('exportar NÃO fala com o servidor — o dado já está no navegador', () => {
  // As três consultas são as mais caras da tela (ver o cabeçalho de 10_Painel.gs
  // e o de 12_Disciplinas.gs). Exportar não é dado novo; é o mesmo dado noutro
  // formato, e uma chamada aqui pagaria a conta de novo por nada.
  const corpos = corposDasFuncoes();
  ['exportar', 'exportarExcel_', 'imprimirRelatorio_', 'htmlDeImpressao_',
    'relatorioInscritosProjeto', 'relatorioTurmaDisciplina', 'relatorioEscolheramDisciplina']
    .forEach((nome) => {
      verdadeiro(corpos[nome] !== undefined, 'sumiu ' + nome + ' do painel');
      igual(/chamar\(/.test(corpos[nome]), false, nome + ' passou a consultar o servidor para exportar');
    });
});

teste('nenhum campo entra na folha impressa sem passar por escapar()', () => {
  // O HTML da folha nasce longe da tabela da tela, e é o único lugar do painel
  // onde dado de aluno é montado fora do desenho da tabela. Um `+ i.nome +` cru
  // aqui é o defeito clássico, e ele não aparece na tela — aparece no documento
  // que a coordenação imprime e distribui.
  const fn = /function htmlDeImpressao_\(relatorio\)[\s\S]*?\n  \}/.exec(PAGINA);
  verdadeiro(fn !== null, 'htmlDeImpressao_ sumiu do painel');

  // A varredura é por NOME, e não por padrão de concatenação: a folha tem seis
  // pontos por onde dado de fora entra, e cada um é apontado aqui. Renomear uma
  // variável derruba este teste — de propósito: quem renomeia tem de reler a
  // linha e confirmar que o `escapar` continua no lugar.
  igual((fn[0].match(/escapar\(texto\)/g) || []).length, 2,
    'uma das duas saídas da célula (com selo e sem selo) deixou de escapar o valor');
  verdadeiro(/escapar\(relatorio\.titulo\)/.test(fn[0]),
    'o nome do projeto — campo de texto livre da coordenação — entra na folha sem escapar');
  verdadeiro(/escapar\(f\)/.test(fn[0]), 'as fichas do topo entram na folha sem escapar');
  verdadeiro(/escapar\(relatorio\.recorte\)/.test(fn[0]),
    'o recorte (que carrega o que foi DIGITADO na busca) entra na folha sem escapar');
  verdadeiro(/escapar\(c\.rotulo\)/.test(fn[0]), 'o rótulo da coluna entra na folha sem escapar');
  verdadeiro(/escapar\(banner\)/.test(fn[0]),
    'o endereço do banner entra no atributo src sem escapar — aspa no nome do arquivo sai da aspa');
});

// O código de saída é o que o `npm test` lê: sem ele, este arquivo imprimia as
// falhas em vermelho e mesmo assim saía com 0 — as 97 afirmações daqui não
// reprovavam nada, e a corrente do `&&` seguia para o arquivo seguinte como se
// tudo estivesse verde. Todos os outros 16 arquivos de teste já faziam assim;
// este ficou para trás e ninguém percebeu, porque um teste que só falha por
// escrito não falha. Encontrado em 13/08 ao conferir por mutação um teste que
// mora aqui (o do `config.js`) — a mutação SOBREVIVEU sem que nada acusasse.
process.exit(resultado());
