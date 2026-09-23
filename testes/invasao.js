/**
 * invasao.js — a revisão de segurança do acesso ao painel, escrita como ataque.
 *
 * Este arquivo não confere se o código faz o que o autor disse que faz. Ele
 * TENTA ENTRAR. A diferença importa: uma conferência lê o caminho feliz e
 * concorda com ele; um ataque procura o caminho que ninguém escreveu de
 * propósito — o token emitido para outro site, o nome de função que não estava
 * na lista, a configuração que tranca o dono do lado de fora.
 *
 * AS SEIS PERGUNTAS QUE ESTE ARQUIVO RESPONDE, na ordem em que doem:
 *
 *   1. o `aud` é conferido? Um ID token é assinado pelo Google, e TODO
 *      aplicativo Google do mundo emite tokens com a mesma assinatura. Sem o
 *      `aud`, "verificar o token" é teatro e o painel está aberto para qualquer
 *      pessoa com conta Google. Se este grupo falhar, o resto não importa;
 *   2. falha de verificação é RECUSA? Rede caída, Google fora do ar, resposta
 *      ilegível, propriedade não configurada — "na dúvida, deixa entrar" em
 *      autenticação é porta aberta com aviso de boas-vindas;
 *   3. a lista branca é real? Se o nome da função vier do cliente e não houver
 *      lista, o endereço público do sistema é execução remota arbitrária;
 *   4. dá para trancar o dono do lado de fora? Este é o segundo achado mais
 *      grave possível, e é o mais fácil de produzir sem querer: um clique numa
 *      tela de configuração, e o conserto passa a exigir o editor do Apps
 *      Script;
 *   5. a recusa vaza? "Este e-mail não está autorizado" é uma frase; "este
 *      e-mail EXISTE na lista" é outra, e a segunda transforma o endereço num
 *      oráculo de quem manda no sistema. Desde que o PIN saiu, esta pergunta tem
 *      um alvo novo e mais exposto: `pedirLinkDeAcesso` é anônima, recebe um
 *      e-mail escolhido por quem chama e sabe responder se ele está na
 *      allowlist. Ela só não vira o oráculo porque devolve a MESMA coisa nos dois
 *      casos — e é isso que os testes desta seção seguram;
 *   6. o que a rota ANÔNIMA custa? A cota do Firestore, a de requisições de
 *      saída e a de envio de e-mail são as três formas de desligar este sistema
 *      sem senha nenhuma.
 *
 * O QUE ESTE ARQUIVO NÃO PROVA: nada aqui fala com o Google, com um navegador
 * ou com a internet. O `tokeninfo` e o `MailApp` são falsos e respondem o que o
 * teste mandar — o que se prova é o que ESTE código faz com cada resposta
 * possível. Se o `aud` real bate com o client id real, só o console do Google
 * diz.
 *
 * Uso:  node testes/invasao.js
 */

'use strict';

const crypto = require('crypto');

const { teste, grupo, igual, verdadeiro, resultado, criarAmbiente, criarRelogio } = require('./apoio');

// Todos os `.gs`, na ordem alfabética em que o editor os carrega: o despacho do
// painel referencia funções de 05, 06, 09, 10, 11 e 12, e com meia lista o mapa
// estouraria — o teste mediria o caminho de erro achando que mede o de sucesso.
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '02b_Drive.gs', '03_Config.gs',
  '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs', '05b_FormatoAcademico.gs', '05c_Revisao.gs',
  '06_Reconciliacao.gs', '07_Auth.gs', '07b_LinkPorEmail.gs', '08_Api.gs', '09_Projetos.gs',
  '10_Painel.gs', '11_Banners.gs', '12_Disciplinas.gs', '13_Auditorio.gs'];

const NOSSO_CLIENT_ID = 'nosso-projeto-123.apps.googleusercontent.com';
const OUTRO_APLICATIVO = 'qualquer-outro-site-999.apps.googleusercontent.com';

/** Três segmentos base64url. O conteúdo não importa: quem lê o token é o Google. */
const TOKEN_FORMATO_BOM = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiI3NyJ9.YXNzaW5hdHVyYQ';

const ADMIN = 'coordenacao@exemplo.com';
const ESTRANHO = 'estranho@exemplo.com';

const RECUSA = 'Sessão expirada ou inválida. Faça login novamente.';

// ------------------------------------------------------------ O laboratório

function contentServiceFalso() {
  return {
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
}

/**
 * Um sistema montado como o do Jonathan, com o Google sob controle do teste.
 *
 * `usuario: ''` é o padrão e não é detalhe: é o que `Session.getActiveUser()`
 * devolve nesta implantação (USER_DEPLOYING + conta Gmail comum). Testar com um
 * usuário visível provaria um caminho que a produção nunca percorre — e é
 * exatamente o caminho que, se confundido com o real, esconde uma porta trancada.
 *
 * `saidas` conta requisições de SAÍDA ao Google. Ele existe para provar o que
 * NÃO acontece: a cota de UrlFetchApp é a mesma pela qual o Firestore inteiro
 * passa, então uma rota anônima que gasta uma requisição por chamada é um botão
 * de desligar o sistema, exposto na internet.
 *
 * `correio` é o mesmo raciocínio para a terceira cota, a de e-mail: ele guarda
 * as mensagens em vez de enviá-las e deixa o teste zerar a cota diária. O
 * `apoio.js` não tem MailApp nem SHA-256 — ele nasceu antes de o projeto ter os
 * dois —, então os dois são montados aqui.
 */
function montar(opcoes) {
  const o = opcoes || {};
  const amb = criarAmbiente({
    arquivos: GS,
    usuario: o.usuario === undefined ? '' : o.usuario,
    relogio: o.relogio
  });

  const tokeninfo = { saidas: [], resposta: null, lancar: false };
  const aoFirestore = amb.falso.UrlFetchApp.fetch;

  amb.api.UrlFetchApp = {
    fetch(url, opcoesFetch) {
      if (String(url).indexOf('oauth2.googleapis.com/tokeninfo') !== -1) {
        tokeninfo.saidas.push(String(url));
        if (tokeninfo.lancar) throw new Error('DNS temporariamente indisponível');
        const r = tokeninfo.resposta || { codigo: 400, corpo: { error_description: 'Invalid Value' } };
        return {
          getResponseCode: () => r.codigo,
          getContentText: () => (typeof r.corpo === 'string' ? r.corpo : JSON.stringify(r.corpo))
        };
      }
      return aoFirestore(url, opcoesFetch);
    },
    // Só o Firestore usa `fetchAll`; o desvio do `tokeninfo` não se repete aqui.
    fetchAll: (lote) => amb.falso.UrlFetchApp.fetchAll(lote)
  };

  amb.api.ContentService = contentServiceFalso();
  amb.tokeninfo = tokeninfo;

  amb.api.Utilities.DigestAlgorithm.SHA_256 = 'SHA_256';
  const digestPadrao = amb.api.Utilities.computeDigest;
  amb.api.Utilities.computeDigest = (algoritmo, texto) => {
    if (algoritmo !== 'SHA_256') return digestPadrao(algoritmo, texto);
    return Array.from(crypto.createHash('sha256').update(String(texto), 'utf8').digest())
      .map((b) => (b > 127 ? b - 256 : b));
  };

  const correio = { enviados: [], cota: o.cota === undefined ? 100 : o.cota };
  amb.api.MailApp = {
    getRemainingDailyQuota: () => correio.cota,
    sendEmail(mensagem) { correio.enviados.push(mensagem); correio.cota--; }
  };
  amb.correio = correio;

  amb.api.semearConfigPadrao_();
  if (o.clientId !== null) amb.propriedades.set('GOOGLE_CLIENT_ID', o.clientId || NOSSO_CLIENT_ID);
  amb.api.gravarConfig('admin_emails', o.allowlist === undefined ? ADMIN : o.allowlist);
  // A chave dos níveis só é semeada quando o teste pede: AUSENTE é o estado do
  // dia 1, e nele o piso vale (todo mundo é coordenador geral). É esse estado
  // que faz a suíte inteira de antes desta peça continuar de pé.
  if (o.gerais !== undefined) amb.api.gravarConfig('coordenadores_gerais', o.gerais);

  return amb;
}

/** O token que viajou dentro do corpo da última mensagem. */
function tokenDoEmail(amb) {
  const mensagem = amb.correio.enviados[amb.correio.enviados.length - 1];
  verdadeiro(mensagem !== undefined, 'nenhuma mensagem foi enviada');

  const achado = /\?entrar=([0-9a-f]{64})/.exec(mensagem.body);
  verdadeiro(achado !== null, 'o corpo do e-mail não trouxe link nenhum:\n' + mensagem.body);
  return achado[1];
}

/** Para quem cada mensagem foi. */
function destinatarios(amb) {
  return amb.correio.enviados.map((m) => m.to);
}

/** Quantas vezes o documento de configuração — onde mora a allowlist — foi lido. */
function leiturasDeConfig(amb) {
  return amb.falso.requisicoes
    .filter((r) => r.metodo === 'GET' && String(r.url).indexOf('/config/geral') !== -1).length;
}

/** Um retrato das propriedades do script, para provar que nada foi escrito. */
function retratoDasPropriedades(amb) {
  return JSON.stringify(Array.from(amb.propriedades.entries()).sort());
}

/** As linhas da trilha, já desembrulhadas. */
function linhasDoLog(amb) {
  const linhas = [];
  amb.falso.documentos.forEach((campos, chave) => {
    if (chave.indexOf('log/') !== 0) return;
    const linha = {};
    Object.keys(campos).forEach((c) => { linha[c] = campos[c].stringValue; });
    linhas.push(linha);
  });
  return linhas;
}

/**
 * Uma requisição HTTP ao web app, como o painel no GitHub Pages a manda.
 *
 * Passa pelo `doPost` de verdade: envelope, lista branca, carimbo do token. Um
 * teste que chamasse a função direto provaria a função e não a PORTA, e é na
 * porta que se entra.
 */
function post(amb, corpo) {
  amb.api.limparCacheConfig();
  amb.falso.requisicoes.length = 0;
  const saida = amb.api.doPost({
    postData: { type: 'text/plain', contents: JSON.stringify(corpo) }
  });
  return JSON.parse(saida.getContent());
}

function login(amb, corpo) {
  return post(amb, Object.assign({ acao: 'login' }, corpo));
}

function painel(amb, fn, token, dados) {
  return post(amb, { acao: 'painel', fn: fn, token: token, dados: dados || {} });
}

/** A resposta que o `tokeninfo` daria a um token legítimo. `troca` estraga um campo. */
function tokenBom(troca) {
  return Object.assign({
    aud: NOSSO_CLIENT_ID,
    azp: NOSSO_CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: String(Math.floor(new Date().getTime() / 1000) + 3600),
    email: ADMIN,
    email_verified: 'true',
    sub: '1029384756'
  }, troca || {});
}

function googleResponde(amb, corpo, codigo) {
  amb.tokeninfo.resposta = { codigo: codigo === undefined ? 200 : codigo, corpo: corpo };
}

/** Toda tentativa de entrar por conta Google, pela porta HTTP. */
function entrarPeloGoogle(amb, resposta) {
  if (resposta !== undefined) googleResponde(amb, resposta);
  return login(amb, { fn: 'entrarComGoogle', idToken: TOKEN_FORMATO_BOM });
}

/** Pedir um link, pela porta HTTP anônima. */
function pedirLink(amb, email) {
  return login(amb, { fn: 'pedirLinkDeAcesso', email: email });
}

/** Entrar com o link, pela porta HTTP anônima. */
function entrarPeloLink(amb, token) {
  return login(amb, { fn: 'entrarComLink', token: token });
}

// ============================================ 1. O aud: a porta que separa
//                                                 autenticação de porta aberta

grupo('1. o aud é conferido? — se este grupo falhar, o resto não importa');

teste('ATAQUE: token de OUTRO aplicativo, com e-mail que ESTÁ na allowlist', () => {
  // O ataque inteiro em quatro linhas. O atacante entra em qualquer site que
  // use "Entrar com o Google", pega no console do navegador o ID token que o
  // Google emitiu para AQUELE site, e o manda para cá. O token é legítimo: a
  // assinatura é do Google, o `iss` é do Google, o `exp` está no futuro, o
  // e-mail é confirmado — e é o e-mail da coordenação, que está na allowlist.
  //
  // A ÚNICA coisa que o distingue de um token nosso é o `aud`.
  const amb = montar();
  const r = entrarPeloGoogle(amb, tokenBom({ aud: OUTRO_APLICATIVO, azp: OUTRO_APLICATIVO }));

  igual(r.ok, false, 'PORTA ABERTA: token de outro aplicativo entrou no painel');
  igual(r.token, undefined, 'saiu sessão de um token que não é nosso');
});

teste('e o token de outro aplicativo não abre o painel nem por acidente', () => {
  // Prova o efeito, e não só a resposta: se algum caminho tivesse criado sessão
  // antes de recusar, o `sessaoAtiva` acharia. Nenhuma sessão existe.
  const amb = montar();
  entrarPeloGoogle(amb, tokenBom({ aud: OUTRO_APLICATIVO }));

  const sessoes = Array.from(amb.propriedades.keys()).filter((k) => k.indexOf('sess_') === 0);
  igual(sessoes, [], 'sobrou sessão de uma tentativa recusada');
});

teste('aud ausente, vazio ou nulo é recusa — não "não veio, então tudo bem"', () => {
  const amb = montar();
  [undefined, '', null, 0, false].forEach((aud) => {
    const corpo = tokenBom();
    corpo.aud = aud;
    igual(entrarPeloGoogle(amb, corpo).ok, false, 'aud = ' + JSON.stringify(aud));
  });
});

teste('client id não configurado é RECUSA, e não conferência a menos', () => {
  // O modo de falha que parece "ainda não terminei de configurar" e na verdade é
  // "está aberto": sem client id não há `aud` para comparar, e comparar contra
  // vazio aceitaria QUALQUER token do mundo.
  const amb = montar({ clientId: null });
  const corpo = tokenBom();
  corpo.aud = '';
  igual(entrarPeloGoogle(amb, corpo).ok, false);
  igual(entrarPeloGoogle(amb, tokenBom()).ok, false);
});

teste('client id só com espaços vale como não configurado', () => {
  // Uma propriedade colada com espaço sobrando é o erro humano mais comum deste
  // passo. Se o `trim` não existisse dos dois lados, `aud` nunca casaria e o
  // sintoma seria "minha conta não tem acesso" — mensagem que manda o professor
  // procurar no lugar errado. Se o `trim` existisse só num lado, pior: aceitaria.
  const amb = montar({ clientId: '   ' });
  igual(entrarPeloGoogle(amb, tokenBom({ aud: '   ' })).ok, false);
  igual(entrarPeloGoogle(amb, tokenBom({ aud: '' })).ok, false);
});

teste('a comparação do aud é exata: caixa e espaço não passam', () => {
  const amb = montar();
  [NOSSO_CLIENT_ID.toUpperCase(), NOSSO_CLIENT_ID + ' ', ' ' + NOSSO_CLIENT_ID,
    NOSSO_CLIENT_ID + '.evil.example', NOSSO_CLIENT_ID.slice(0, -1)].forEach((aud) => {
    igual(entrarPeloGoogle(amb, tokenBom({ aud: aud })).ok, false, 'aud = "' + aud + '"');
  });
});

teste('com o aud certo e a conta na lista, a porta abre — senão isto não é porta', () => {
  // O contrapeso obrigatório: uma verificação que recusa TUDO também passaria
  // nos testes acima, e seria um sistema quebrado com cara de sistema seguro.
  const amb = montar();
  const r = entrarPeloGoogle(amb, tokenBom());

  igual(r.ok, true, r.erro);
  verdadeiro(r.token && r.token.length >= 16, 'sessão sem token utilizável');
  igual(r.usuario, ADMIN);
  igual(painel(amb, 'lerConfiguracoes', r.token).ok, true, 'a sessão não vale no painel');
});

// ================================================ 2. O resto da verificação

grupo('2. o resto da verificação — e o que acontece quando ela FALHA');

teste('token vencido não entra, mesmo com o tokeninfo respondendo 200', () => {
  // O `tokeninfo` recusa token vencido sozinho, mas a validade é regra NOSSA. Se
  // um dia ele mudar de comportamento — ou se alguém trocar o verificador —, a
  // regra tem de continuar escrita aqui. Este teste força o cenário em que o
  // Google diz "está tudo bem" sobre um token vencido.
  const amb = montar();
  const vencido = tokenBom({ exp: String(Math.floor(new Date().getTime() / 1000) - 1) });
  igual(entrarPeloGoogle(amb, vencido).ok, false, 'token vencido entrou');

  igual(entrarPeloGoogle(amb, tokenBom({ exp: undefined })).ok, false, 'sem exp');
  igual(entrarPeloGoogle(amb, tokenBom({ exp: 'amanhã' })).ok, false, 'exp ilegível');
  igual(entrarPeloGoogle(amb, tokenBom({ exp: '9999999999999999' })).ok, true, 'exp no futuro é o caso bom');
});

teste('emissor precisa ser o Google — e "quase o Google" não é', () => {
  const amb = montar();
  ['accounts.google.com.evil.example', 'https://accounts.google.com.br',
    'https://accounts.gooogle.com', '', undefined].forEach((iss) => {
    igual(entrarPeloGoogle(amb, tokenBom({ iss: iss })).ok, false, 'iss = ' + iss);
  });

  ['accounts.google.com', 'https://accounts.google.com'].forEach((iss) => {
    igual(entrarPeloGoogle(amb, tokenBom({ iss: iss })).ok, true, 'iss = ' + iss);
  });
});

teste('conta com e-mail não confirmado não entra — é o e-mail que a lista compara', () => {
  // Quem cria uma conta Google com um endereço que não é seu e não o confirma
  // tem `email_verified: false`. Aceitar isso é deixar qualquer pessoa escolher
  // o e-mail com que a allowlist vai ser comparada.
  const amb = montar();
  ['false', false, undefined, '', 'TRUE', 'True', 1].forEach((v) => {
    igual(entrarPeloGoogle(amb, tokenBom({ email_verified: v })).ok, false,
      'email_verified = ' + JSON.stringify(v));
  });

  igual(entrarPeloGoogle(amb, tokenBom({ email_verified: true })).ok, true, 'booleano verdadeiro');
  igual(entrarPeloGoogle(amb, tokenBom({ email_verified: 'true' })).ok, true, 'texto "true"');
});

teste('GOOGLE FORA DO AR NÃO É PERMISSÃO', () => {
  // O teste que separa autenticação de "na dúvida, deixa entrar". Se o
  // verificador cair e o código tratar a indisponibilidade como aprovação, uma
  // queda do Google vira a porta escancarada — e ninguém descobre, porque de
  // fora parece que o sistema continuou funcionando.
  const amb = montar();

  amb.tokeninfo.lancar = true;
  igual(entrarPeloGoogle(amb).ok, false, 'rede caída deixou entrar');
  amb.tokeninfo.lancar = false;

  [400, 401, 403, 429, 500, 502, 503].forEach((codigo) => {
    googleResponde(amb, tokenBom(), codigo);
    igual(entrarPeloGoogle(amb).ok, false, 'tokeninfo respondeu ' + codigo + ' e passou');
  });
});

teste('resposta ilegível do verificador é recusa', () => {
  const amb = montar();
  ['<html>erro</html>', '', 'null', '7', '"texto"', '[]'].forEach((corpo) => {
    googleResponde(amb, corpo, 200);
    igual(entrarPeloGoogle(amb).ok, false, 'corpo = ' + corpo);
  });
});

teste('e-mail malformado no token não chega à allowlist', () => {
  const amb = montar({ allowlist: ADMIN + ', naoehemail' });
  ['naoehemail', '', undefined, 'a@b', '@exemplo.com'].forEach((email) => {
    igual(entrarPeloGoogle(amb, tokenBom({ email: email })).ok, false, 'email = ' + email);
  });
});

teste('a caixa do e-mail não decide nada: a mesma conta é a mesma conta', () => {
  const amb = montar({ allowlist: 'Coordenacao@Exemplo.COM' });
  const r = entrarPeloGoogle(amb, tokenBom({ email: 'COORDENACAO@exemplo.com' }));
  igual(r.ok, true, r.erro);
  igual(r.usuario, ADMIN, 'a sessão precisa guardar a forma normalizada');
});

teste('lixo no lugar do token não vira requisição de saída', () => {
  // Filtro barato antes do caro, como `conferirMatricula_` faz com o formato da
  // matrícula antes de consultar o banco. Esta rota é anônima: sem o filtro,
  // qualquer laço de terminal transforma lixo em requisições de saída — e a cota
  // de saída é a MESMA pela qual o Firestore passa.
  const amb = montar();
  ['', 'nao-e-jwt', 'a.b', 'a.b.c.d', 'a b c', '../../etc/passwd',
    'x'.repeat(5000), TOKEN_FORMATO_BOM + '.extra'].forEach((t) => {
    igual(login(amb, { fn: 'entrarComGoogle', idToken: t }).ok, false, 'idToken = ' + t.slice(0, 20));
  });
  igual(amb.tokeninfo.saidas.length, 0, 'lixo saiu para a rede');
});


// ================================================== 3. A lista branca

grupo('3. a lista branca de funções é real? — ou é execução remota arbitrária');

/** O que o servidor tem e o painel NÃO pode acionar. */
const NAO_DESPACHAVEIS = [
  // De console: rodam uma vez, não pedem token, e uma delas semeia o banco.
  'setup', 'semearConfigPadrao_',
  // Escrevem configuração sem passar por guarda nenhuma.
  'gravarConfig', 'limparCacheConfig',
  // A fábrica de sessões. Se esta fosse chamável, o login inteiro seria enfeite.
  'criarSessao_',
  // Derruba todo mundo do painel.
  'invalidarSessoes',
  // O motor da inscrição: reserva vaga sem passar pelas guardas anti-abuso.
  'reservarVaga',
  // Existe em 11_Banners.gs e o painel não a chama — função nova nasce inalcançável.
  'removerBanner',
  // O verificador e as peças internas do acesso.
  'verificarIdTokenGoogle_', 'emailAutorizado_', 'adminEmails_', 'tokenValido_',
  'emailDaSessao_', 'invalidarSessoesDe_', 'excedeuVerificacoesGoogle_',
  // Quem assina a trilha. Despachável, ela deixaria o cliente escolher o nome
  // que vai na coluna "Quem" de todas as linhas da execução — auditoria que o
  // auditado escreve não é auditoria. Quem a chama é `exigirAdmin` (04_Log.gs).
  'anotarOperador_',
  // O ÚLTIMO RECURSO. Ela cria sessão sem provar nada, e o que a torna segura é
  // exigir acesso ao arquivo do projeto no editor do Apps Script. Despachá-la
  // seria transformá-la numa porta dos fundos anônima — o teste dedicado a ela
  // está logo abaixo deste grupo.
  'liberarAcesso', 'liberarMeuAcesso',
  // As peças do link por e-mail. `enviarLink_` manda a mensagem sem conferir a
  // allowlist (quem confere é `pedirLinkDeAcesso`, antes de chamá-la),
  // `impressaoDoLink_` é o que transforma token em chave guardada, e
  // `esquecerAllowlistDoLink_` é o que faz "tirei o acesso" valer no ato.
  'enviarLink_', 'impressaoDoLink_', 'freioDoLinkLibera_',
  'faxinaLinks_', 'corpoDoEmail_', 'urlDoPainel_', 'linkDeAcessoDisponivel_',
  'allowlistParaLink_', 'esquecerAllowlistDoLink_',
  // Regrava a allowlist INTEIRA. Ela existe para `salvarConfiguracao` chamar, e
  // uma função nova que escreve quem entra no sistema é exatamente o tipo de
  // coisa que não pode nascer despachável por descuido.
  'regravarAllowlist_',
  // As peças do NÍVEL. `aplicarAcessos_` e `gravarAcessos_` escrevem as duas
  // listas de acesso — despachável, a primeira entregaria a coroa a quem soubesse
  // o nome dela, e a segunda passaria por cima da invariante do último
  // coordenador. `regravarGerais_` é a irmã de `regravarAllowlist_`.
  // `exigirCoordenador` e `nivelDe_` são as que RESPONDEM a pergunta do acesso, e
  // uma guarda chamável pelo cliente é uma guarda que o cliente pode fazer
  // responder o que quiser. `materializar_` congela quem é coordenador hoje.
  'aplicarAcessos_', 'gravarAcessos_', 'regravarGerais_', 'exigirCoordenador',
  'nivelDe_', 'nivelEm_', 'nivelDaSessao_', 'coordenadoresGerais_', 'materializar_',
  'listaDeEmails_', 'pessoasDoAcesso_', 'respostaDoAcesso_', 'rotuloDoNivel_',
  'funcoesDoProfessor_',
  // A camada de dados, crua.
  'ler', 'inserir', 'atualizar', 'excluir', 'listar', 'contar',
  'escreverEmLote', 'excluirEmLote',
  // As rotas, chamadas de dentro delas mesmas.
  'doGet', 'doPost', 'rotaDoPainel_', 'rotaDeLogin_', 'funcoesDoPainel_'
];

teste('as funções perigosas EXISTEM no servidor — senão este grupo não prova nada', () => {
  // A ordem importa: um teste que só afirma "não dá para chamar X" passaria
  // sozinho se X nem existisse, e continuaria passando no dia em que alguém a
  // criasse. Primeiro se prova que o alvo está lá.
  const amb = montar();
  const ausentes = NAO_DESPACHAVEIS.filter((nome) => typeof amb.api[nome] !== 'function');
  igual(ausentes, [], 'estes nomes não existem mais; o teste abaixo virou enfeite');
});

teste('ATAQUE: despachar função que não está na lista branca, com token VÁLIDO', () => {
  // O atacante aqui já entrou (ou roubou uma sessão). A pergunta é se, de
  // dentro, o nome da função é uma chave para o projeto inteiro.
  const amb = montar();
  const token = amb.api.criarSessao_(ADMIN);

  NAO_DESPACHAVEIS.forEach((nome) => {
    const r = painel(amb, nome, token, { chave: 'admin_emails', valor: 'invasor@exemplo.com' });
    igual(r.ok, false, nome + ' foi despachada');
    verdadeiro(/Ação desconhecida/.test(r.erro || ''), nome + ': ' + r.erro);
  });

  amb.api.limparCacheConfig();
  igual(amb.api.config('admin_emails'), ADMIN, 'alguma delas mexeu na allowlist');
});

teste('ATAQUE: liberarAcesso pela rede — a porta dos fundos que não pode nascer', () => {
  // Ela cria sessão SEM PROVAR NADA: o que a torna segura é só o fato de que
  // para chamá-la é preciso abrir o projeto no editor do Apps Script, e quem
  // consegue isso já pode reescrever `entrarComLink` inteiro. Roteá-la — por
  // conveniência, por engano, por um `if` a mais em `rotaDeLogin_` — anula a
  // única coisa que a protege e entrega o painel a quem souber o nome dela.
  //
  // As duas listas são conferidas porque são dois caminhos: `funcoesDoPainel_`
  // exige token (e ela seria inútil ali), `rotaDeLogin_` NÃO exige (e ali ela
  // seria a chave da casa embaixo do tapete).
  const amb = montar({ allowlist: '' });

  igual(Object.keys(amb.api.funcoesDoPainel_()).indexOf('liberarAcesso'), -1,
    'liberarAcesso entrou na lista branca do painel');

  const r = login(amb, { fn: 'liberarAcesso', email: 'invasor@exemplo.com' });
  igual(r, { ok: false, erro: 'Ação desconhecida.' }, 'rotaDeLogin_ despachou liberarAcesso');

  const sessoes = Array.from(amb.propriedades.keys()).filter((k) => k.indexOf('sess_') === 0);
  igual(sessoes, [], 'saiu sessão de uma rota anônima');
  amb.api.limparCacheConfig();
  igual(amb.api.adminEmails_(), [], 'a allowlist foi escrita pela rede');
});

teste('ATAQUE: herança do JavaScript como lista branca que ninguém escreveu', () => {
  // `funcoes['constructor']` devolve uma função DE VERDADE, herdada de Object.
  // Sem `hasOwnProperty`, ela passa no teste de tipo e é chamada — com o payload
  // do cliente. `__proto__` é o mesmo buraco por outro nome.
  const amb = montar();
  const token = amb.api.criarSessao_(ADMIN);

  ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__',
    'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'].forEach((nome) => {
    const r = painel(amb, nome, token, {});
    igual(r.ok, false, nome + ' foi despachada');
    verdadeiro(/Ação desconhecida/.test(r.erro || ''), nome + ': ' + r.erro);
  });
});

teste('ATAQUE: envenenar o protótipo pelo payload', () => {
  // Se `dados` fosse fundido com um objeto de configuração em algum lugar, uma
  // chave `__proto__` viraria propriedade de TODO objeto do sandbox — inclusive
  // dos que decidem autorização. `JSON.parse` não polui sozinho; o que este
  // teste garante é que nada no caminho ressuscita a poluição.
  const amb = montar();
  const token = amb.api.criarSessao_(ADMIN);

  post(amb, {
    acao: 'painel', fn: 'lerConfiguracoes', token: token,
    dados: JSON.parse('{"__proto__": {"token": "forjado", "ok": true}}')
  });

  igual(({}).token, undefined, 'o protótipo de Object foi envenenado');
  igual(amb.api.tokenValido_('forjado'), false, 'um token forjado passou a valer');
});

teste('ATAQUE: dois tokens na mesma requisição, e o cliente escolhendo qual vale', () => {
  // O envelope leva um token e o payload leva outro. Se a função do painel
  // lesse o de DENTRO, a conferência que vale seria a que o cliente escolheu —
  // e a do envelope viraria enfeite. O servidor carimba o de fora por cima.
  const amb = montar();
  const bom = amb.api.criarSessao_(ADMIN);

  const r = post(amb, {
    acao: 'painel', fn: 'listarAdmins', token: 'nao-existe-este-token',
    dados: { token: bom }
  });

  igual(r.ok, false, 'o token de dentro do payload foi aceito');
  igual(r.erro, RECUSA);
});

teste('toda função da lista branca recusa sem token, mesmo chamada por dentro', () => {
  // A rota já barra antes de despachar — então este teste não passa pela rota:
  // ele chama a função DIRETO, que é como ela seria chamada se um dia alguém
  // acrescentasse outro caminho (um `google.script.run`, um gatilho, uma rota
  // nova). A segunda linha de defesa é a que sobra quando a primeira sai de cena.
  const amb = montar();
  const nomes = Object.keys(amb.api.funcoesDoPainel_());
  verdadeiro(nomes.length >= 25, 'a lista encolheu: ' + nomes.length);

  nomes.forEach((nome) => {
    ['', undefined, null, 'forjado', 0, {}, []].forEach((token) => {
      const r = amb.api[nome]({ token: token });
      igual(r && r.ok, false, nome + ' respondeu com token ' + JSON.stringify(token));
      verdadeiro(/Sess.o expirada/.test((r && r.erro) || ''),
        nome + ' recusou por outro motivo: ' + (r && r.erro));
    });
  });
});

teste('sessão VENCIDA não vale, e a propriedade morta é varrida', () => {
  const amb = montar();
  const token = amb.api.criarSessao_(ADMIN);

  // Envelhece a sessão à mão: oito horas e um segundo.
  amb.propriedades.set('sess_' + token, JSON.stringify({
    email: ADMIN, expira_em: new Date().getTime() - 1000
  }));

  igual(painel(amb, 'listarAdmins', token).erro, RECUSA);
  igual(amb.propriedades.has('sess_' + token), false, 'sessão vencida ficou guardada');
});

teste('sessão remexida na marra não vale', () => {
  // Se alguém conseguisse escrever nas Propriedades do script já teria o
  // sistema inteiro; o que este teste guarda é o outro lado: valor ilegível não
  // pode virar "válido por omissão".
  const amb = montar();
  ['', 'nao-e-json', '{}', '{"email":"x"}', 'null', '[]'].forEach((bruto) => {
    amb.propriedades.set('sess_remexida', bruto);
    igual(amb.api.tokenValido_('remexida'), false, 'valor = ' + bruto);
  });
});

teste('a recusa da rota é UMA frase só, seja qual for o motivo', () => {
  // Recusa que varia conta ao visitante o que ele ainda não sabia: token que
  // existiu, token que nunca existiu, token de quem saiu da lista.
  const amb = montar();
  const vencido = amb.api.criarSessao_(ADMIN);
  amb.propriedades.set('sess_' + vencido, JSON.stringify({ email: ADMIN, expira_em: 1 }));

  const frases = [
    painel(amb, 'listarAlunos', undefined).erro,
    painel(amb, 'listarAlunos', '').erro,
    painel(amb, 'listarAlunos', 'inventado').erro,
    painel(amb, 'listarAlunos', vencido).erro
  ];
  igual(frases, [RECUSA, RECUSA, RECUSA, RECUSA]);
});

teste('recusar não custa uma leitura sequer', () => {
  // Um endereço anônimo que gasta cota para dizer "não" é um botão de desligar
  // com etiqueta: 50 mil "não" por dia e o formulário do aluno para.
  const amb = montar();
  painel(amb, 'exportarCsv', 'inventado');
  igual(amb.falso.requisicoes.length, 0);
});

teste('a lista branca cobre o que o painel realmente chama', () => {
  // A direção que importa: se a tela chamar um nome que não está na lista, o
  // professor recebe "Ação desconhecida" no clique. O teste avisa antes.
  const fs = require('fs');
  const path = require('path');
  const pagina = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'painel', 'index.html'), 'utf8');

  const amb = montar();
  const listadas = Object.keys(amb.api.funcoesDoPainel_());
  // As duas últimas são a porta de recuperação (07b_LinkPorEmail.gs): anônimas
  // como as outras de login, e por isso fora da lista branca do painel.
  const deLogin = ['modoDeAcesso', 'sessaoAtiva', 'sair', 'autenticar', 'entrarComGoogle',
    'pedirLinkDeAcesso', 'entrarComLink'];

  const chamadas = [];
  const regex = /chamar\(\s*'([A-Za-z_]+)'/g;
  let achado;
  while ((achado = regex.exec(pagina)) !== null) {
    if (chamadas.indexOf(achado[1]) === -1) chamadas.push(achado[1]);
  }
  verdadeiro(chamadas.length >= 20, 'só achei ' + chamadas.length + ' chamadas na página');

  const orfas = chamadas.filter((f) => listadas.indexOf(f) === -1 && deLogin.indexOf(f) === -1);
  igual(orfas, [], 'a tela chama funções que a rota não despacha');
});

teste('ATAQUE: assinar a trilha com o nome de outra pessoa, pelo payload', () => {
  // A coluna "Quem" passou a dizer quem operou (04_Log.gs), e a pergunta é de
  // onde ela tira o nome. Se fosse de algum campo do payload, a trilha viraria
  // papel: quem faz a ação escolhe quem ela acusa.
  //
  // Mutação que derruba: `registrar` (ou a rota) aceitar um `usuario` vindo de
  // fora em vez do operador que `exigirAdmin` anotou a partir da SESSÃO.
  const amb = montar({ allowlist: ADMIN });
  const token = amb.api.criarSessao_(ADMIN);

  const r = painel(amb, 'incluirAdmin', token, {
    email: 'nova@exemplo.com',
    usuario: 'outra.pessoa@exemplo.com',
    operador: 'outra.pessoa@exemplo.com',
    token: 'nao-e-este-que-vale'
  });
  igual(r.ok, true, 'erro foi: ' + r.erro);

  const linhas = [];
  amb.falso.documentos.forEach((campos, chave) => {
    if (chave.indexOf('log/') === 0) linhas.push(campos);
  });
  const incluiu = linhas.filter((c) => c.acao.stringValue === 'ADMIN_INCLUIDO')[0];
  igual(incluiu.usuario.stringValue, ADMIN, 'o cliente assinou a trilha com outro nome');
  igual(incluiu.detalhe.stringValue.indexOf('outra.pessoa@exemplo.com'), -1,
    incluiu.detalhe.stringValue);
});

// ============================= 4. Dá para trancar o Jonathan do lado de fora?

grupo('4. dá para trancar o dono do lado de fora?');

/**
 * Tenta as DUAS PORTAS REMOTAS e devolve quais abriram.
 *
 * É a pergunta que interessa em cada configuração possível: existe caminho de
 * volta sem sair da internet? Quando a resposta é "não", o conserto passa a ser
 * `liberarAcesso()` no editor do Apps Script — que nem todo professor tem, e que
 * é o lugar onde se reescreve o sistema inteiro.
 */
function portasQueAbrem(opcoes) {
  const amb = montar(opcoes);
  const abertas = [];
  const alvo = (opcoes && opcoes.eu) || ADMIN;

  if (entrarPeloGoogle(amb, tokenBom({ email: alvo })).ok) abertas.push('GOOGLE');

  if (pedirLink(amb, alvo).ok && amb.correio.enviados.length) {
    if (entrarPeloLink(amb, tokenDoEmail(amb)).ok) abertas.push('LINK');
  }

  return { abertas: abertas, amb: amb };
}

teste('sem client id, a porta que sobra é o link por e-mail', () => {
  // ESTE É O ESTADO DE HOJE, e ele não é descuido de ninguém: criar o
  // GOOGLE_CLIENT_ID é passo de console, e no primeiro dia ele não existe. O
  // botão do Google não pode ser desenhado, e se fosse recusaria todo mundo.
  // Antes, quem sobrava era o PIN; hoje é a posse da caixa de e-mail.
  const r = portasQueAbrem({ clientId: null });

  verdadeiro(r.abertas.length > 0, 'SEM PORTA: nem Google nem link entram');
  igual(r.abertas, ['LINK']);
  igual(r.amb.api.modoDeAcesso().google.disponivel, false,
    'anunciar o botão aqui manda o professor procurar o problema na conta dele');
});

teste('com a allowlist VAZIA não há porta remota nenhuma — e é assumido', () => {
  // O único estado sem saída pela internet, e ele é alcançável sem descuido:
  // implantação nova antes do primeiro cadastro. Não há para quem mandar link e
  // não há quem o botão do Google aceite. A tela precisa DIZER isso, porque a
  // saída não está nela — está no editor do Apps Script.
  const r = portasQueAbrem({ allowlist: '' });
  igual(r.abertas, []);

  const tela = r.amb.api.modoDeAcesso();
  igual(tela.allowlistVazia, true, 'a tela não tem como explicar por que nada funciona');
  igual(tela.google.disponivel, false);

  // E a saída existe, fora da rede.
  r.amb.api.console = { log: () => {}, error: () => {} };
  r.amb.api.liberarAcesso(ADMIN);
  r.amb.api.limparCacheConfig();
  igual(portasQueAbrem({}).abertas.length > 0, true);
});

teste('client id ERRADO não parece defeito de fora, e ainda assim há porta', () => {
  // A propriedade existe, o botão é desenhado, a lista tem gente. Só que o `aud`
  // nunca casa — porque o valor é de outro projeto, ou porque a origem deste site
  // não foi registrada no console e o navegador nem chega a emitir token. É o
  // erro de configuração mais provável do primeiro dia, e o mais silencioso.
  const r = portasQueAbrem({ clientId: 'de-outro-projeto.apps.googleusercontent.com' });

  igual(r.abertas, ['LINK'], 'SEM PORTA: o client id errado custaria o painel');
});

teste('a identidade que chega ao servidor sozinha entra (implantação Workspace)', () => {
  // Sem client id, mas com `Session.getActiveUser()` respondendo: ali o caminho
  // 1 de `autenticar` funciona, e é o cenário que o projeto assume quando mudar
  // para a conta institucional.
  const amb = montar({ allowlist: ADMIN, clientId: null, usuario: ADMIN });
  const r = login(amb, { fn: 'autenticar' });

  igual(r.ok, true, 'a identidade visível devia entrar sozinha: ' + r.erro);
  igual(amb.api.modoDeAcesso().identidadeVisivel, true);
});

teste('ninguém sai da allowlist sendo o último', () => {
  const amb = montar({ allowlist: ADMIN });
  const token = amb.api.criarSessao_(ADMIN);

  const r = amb.api.removerAdmin({ token: token, email: ADMIN });
  igual(r.ok, false);
  amb.api.limparCacheConfig();
  igual(amb.api.config('admin_emails'), ADMIN, 'a lista ficou vazia mesmo assim');
});

teste('e o campo de texto de admin_emails não é a porta dos fundos disso', () => {
  // `removerAdmin` tem duas guardas. O campo de texto da aba Configurações
  // gravava a mesma chave sem passar por nenhuma delas — e o que uma guarda
  // impede pela porta da frente não pode ser feito pela janela.
  //
  // A guarda não depende mais de configuração: antes ela só valia com
  // `modo_acesso_painel` = GOOGLE, e a chave deixou de existir junto com o PIN.
  // Hoje a allowlist é a fonte única das duas portas remotas, então esvaziá-la é
  // sempre trancar o painel por fora.
  const amb = montar({ allowlist: ADMIN });
  const token = amb.api.criarSessao_(ADMIN);

  const r = amb.api.salvarConfiguracao({ token: token, chave: 'admin_emails', valor: '' });
  igual(r.ok, false, 'esvaziou a lista, e agora não sobra porta nenhuma');
  amb.api.limparCacheConfig();
  igual(amb.api.config('admin_emails'), ADMIN);
});

teste('e esvaziar a lista pela janela também não manda link para ninguém', () => {
  // O efeito que a guarda existe para impedir, medido no fim do caminho: se a
  // lista tivesse sido esvaziada, o pedido de link continuaria respondendo a
  // mesma frase gentil — e nenhuma mensagem sairia nunca mais.
  const amb = montar({ allowlist: ADMIN });
  const token = amb.api.criarSessao_(ADMIN);

  amb.api.salvarConfiguracao({ token: token, chave: 'admin_emails', valor: '   ,  ' });
  amb.api.limparCacheConfig();

  igual(pedirLink(amb, ADMIN).ok, true);
  igual(destinatarios(amb), [ADMIN], 'a lista foi esvaziada e o link parou de sair');
});

teste('tirar alguém pelo campo de texto DERRUBA a sessão da pessoa', () => {
  // Tirar da lista e deixar entrar por mais oito horas é não ter tirado. O
  // `removerAdmin` já fazia isso; o campo de texto, não — e é o mesmo gesto,
  // na mesma tela, com o mesmo significado para quem clica.
  const amb = montar({ allowlist: ADMIN + ', outra@exemplo.com' });
  const meu = amb.api.criarSessao_(ADMIN);
  const dela = amb.api.criarSessao_('outra@exemplo.com');

  igual(amb.api.salvarConfiguracao({ token: meu, chave: 'admin_emails', valor: ADMIN }).ok, true);

  igual(amb.api.sessaoAtiva(dela).ok, false, 'quem saiu continuou dentro por 8 horas');
  igual(amb.api.sessaoAtiva(meu).ok, true, 'quem ficou foi derrubado junto');
});

teste('e a saída pelo campo de texto deixa rastro de quem saiu', () => {
  const amb = montar({ allowlist: ADMIN + ', outra@exemplo.com' });
  const token = amb.api.criarSessao_(ADMIN);
  amb.api.salvarConfiguracao({ token: token, chave: 'admin_emails', valor: ADMIN });

  const acoes = [];
  amb.falso.documentos.forEach((campos, chave) => {
    if (chave.indexOf('log/') === 0) acoes.push(campos.acao.stringValue);
  });
  verdadeiro(acoes.indexOf('ADMIN_REMOVIDO') !== -1,
    'a lista encolheu sem uma linha de auditoria: ' + acoes.join(', '));
});

teste('a chave modo_acesso_painel MORREU, e ressuscitá-la é recusado', () => {
  // Ela ligava e desligava o PIN, e com ele foi embora. Fica o teste porque uma
  // chave que volta a existir no banco volta a ser editável pela tela (a lista
  // de chaves conhecidas inclui o que já está lá) — e uma configuração que
  // ninguém lê é uma configuração que promete o que não cumpre.
  const amb = montar({ allowlist: ADMIN });
  const token = amb.api.criarSessao_(ADMIN);

  const r = amb.api.salvarConfiguracao({
    token: token, chave: 'modo_acesso_painel', valor: 'GOOGLE'
  });

  igual(r.ok, false);
  verdadeiro(/desconhecida/.test(r.erro), r.erro);
  igual(amb.api.CONFIG_PADRAO.filter((c) => c.chave === 'modo_acesso_painel'), []);
});

teste('uma enxurrada de tokens recusados NÃO freia o link por e-mail', () => {
  // A rota do Google é anônima. Se a recusa dela alimentasse o freio do link,
  // meia dúzia de tokens de mentira poriam em espera o único caminho de conserto
  // do sistema — e um atacante que não consegue entrar ganharia, de brinde, o
  // poder de atrasar quem consegue. Os contadores são separados de propósito.
  const amb = montar();
  googleResponde(amb, tokenBom({ aud: OUTRO_APLICATIVO }));
  for (let i = 0; i < 80; i++) entrarPeloGoogle(amb);

  igual(pedirLink(amb, ADMIN).ok, true);
  igual(destinatarios(amb), [ADMIN], 'o link ficou na fila por tentativas que não eram dele');
});

teste('e o freio de UM endereço não encosta no de outro', () => {
  // A falha de desenho do freio do PIN, e a razão de ele ter sido um contador
  // único: qualquer pessoa da internet gastava as tentativas de todo mundo. Aqui
  // o estado é por endereço, e é a allowlist que limita quantos estados existem.
  const amb = montar({ allowlist: ADMIN + ', outra@exemplo.com' });

  igual(pedirLink(amb, ADMIN).ok, true);
  igual(pedirLink(amb, ADMIN).ok, true, 'o segundo pedido do mesmo endereço é freado, não recusado');
  igual(destinatarios(amb), [ADMIN], 'o freio do endereço não segurou');

  igual(pedirLink(amb, 'outra@exemplo.com').ok, true);
  igual(destinatarios(amb), [ADMIN, 'outra@exemplo.com'],
    'O FREIO VOLTOU A SER GLOBAL: um endereço freou o outro');
});

// ================================================== 5. A recusa vaza?

grupo('5. a recusa vaza quem está autorizado?');

teste('a recusa do Google nomeia só a conta de quem bateu na porta', () => {
  // Quem chega até aqui já PROVOU ser dono daquele e-mail: o token foi emitido
  // para ele. Dizer "a conta X não tem acesso" não revela nada que ele não
  // pudesse descobrir sobre si mesmo — e é a única frase que o deixa resolver
  // sozinho. O que não pode sair é a lista.
  const amb = montar({ allowlist: 'chefe@exemplo.com, diretoria@exemplo.com' });
  const r = entrarPeloGoogle(amb, tokenBom({ email: 'estranho@exemplo.com' }));

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('estranho@exemplo.com') !== -1, r.erro);
  ['chefe@exemplo.com', 'diretoria@exemplo.com'].forEach((oculto) => {
    igual(r.erro.indexOf(oculto), -1, 'a recusa entregou a lista: ' + r.erro);
  });
});

teste('não dá para perguntar pela conta ALHEIA — o token é a pergunta', () => {
  // A enumeração exigiria um token emitido PARA o e-mail perguntado, e esse
  // token só o Google emite, para quem prova ser dono da conta. Sem ele, a
  // resposta é sempre a mesma, aconteça o que acontecer com a lista.
  const dentro = montar({ allowlist: ADMIN });
  const fora = montar({ allowlist: 'ninguem@exemplo.com' });

  const rDentro = entrarPeloGoogle(dentro, tokenBom({ aud: OUTRO_APLICATIVO, email: ADMIN }));
  const rFora = entrarPeloGoogle(fora, tokenBom({ aud: OUTRO_APLICATIVO, email: ADMIN }));

  igual(rDentro.erro, rFora.erro,
    'a recusa mudou conforme o e-mail estar ou não na lista — isso é um oráculo');
});

teste('a tela de login anônima não entrega e-mail nenhum', () => {
  // `modoDeAcesso` é a única coisa que uma pessoa sem token consegue pedir sobre
  // o acesso. Ela conta COMO entrar, e não QUEM entra.
  const amb = montar({ allowlist: 'chefe@exemplo.com, diretoria@exemplo.com' });
  const m = login(amb, { fn: 'modoDeAcesso' });
  const texto = JSON.stringify(m);

  ['chefe@exemplo.com', 'diretoria@exemplo.com'].forEach((oculto) => {
    igual(texto.indexOf(oculto), -1, 'a tela de login devolveu a allowlist: ' + texto);
  });
  igual(m.allowlistVazia, false, 'e o único bit que sai é "há alguém autorizado"');
});

teste('o client id sai na tela de login, e isso é de propósito', () => {
  // Client id de aplicativo web é público por construção: ele viaja no HTML de
  // qualquer site que use o botão do Google. Quem protege é a lista de origens
  // autorizadas do console, não o sigilo. Está aqui como decisão registrada, para
  // que ninguém a "conserte" achando que é vazamento — e para que o dia em que
  // um SEGREDO for parar nesta resposta seja um dia em que este teste muda.
  const amb = montar();
  const m = login(amb, { fn: 'modoDeAcesso' });
  igual(m.google.clientId, NOSSO_CLIENT_ID);
});

teste('sem token, listarAdmins não conta nem quantos são', () => {
  const amb = montar({ allowlist: 'chefe@exemplo.com, diretoria@exemplo.com' });
  const r = painel(amb, 'listarAdmins', 'inventado');
  igual(r.ok, false);
  igual(r.emails, undefined);
  igual(JSON.stringify(r).indexOf('@'), -1, JSON.stringify(r));
});

// -------------------------------------------------- O oráculo que não pode nascer
//
// `pedirLinkDeAcesso` é a rota mais exposta do sistema: anônima, pública, e ela
// recebe um e-mail escolhido por quem chama. Ela SABE responder "este endereço
// administra o CESUTECH?" — e a única coisa que a impede de responder é devolver
// exatamente a mesma coisa nos dois casos.
//
// É a propriedade mais fácil de estragar por gentileza. "Este e-mail não tem
// acesso" seria simpático, ajudaria quem digitou errado, e transformaria o
// endereço público num diretório de quem manda no sistema — que é o primeiro
// passo de um phishing dirigido, com o nome certo e a função certa.

grupo('5b. pedirLinkDeAcesso é um oráculo? — a decisão mais fácil de estragar');

teste('A RESPOSTA É IDÊNTICA para quem está na lista e para quem não está', () => {
  // Comparação profunda, e não campo a campo, DE PROPÓSITO: um `debug`, um
  // `jaEstava`, um `via` acrescentado a um dos ramos é exatamente a forma que o
  // vazamento tem quando ele aparece — ninguém escreve "erro: fora da lista".
  const amb = montar({ allowlist: ADMIN });

  const naLista = pedirLink(amb, ADMIN);
  const foraDaLista = pedirLink(amb, ESTRANHO);

  igual(foraDaLista, naLista, 'a resposta distingue os dois casos: isto é um oráculo');
  verdadeiro(naLista.ok === true && typeof naLista.mensagem === 'string', JSON.stringify(naLista));
});

teste('e continua idêntica quando o endereço está freado, e quando dá erro interno', () => {
  // Os quatro desfechos possíveis do pedido, lado a lado: enviado, freado, fora
  // da lista, e o caminho de exceção. Um "erro interno" que aparecesse só para
  // endereços da allowlist seria o oráculo entrando pela janela.
  const amb = montar({ allowlist: ADMIN });

  const enviado = pedirLink(amb, ADMIN);
  const freado = pedirLink(amb, ADMIN);
  const foraDaLista = pedirLink(amb, ESTRANHO);

  amb.api.emailAutorizado_ = () => { throw new Error('Firestore fora do ar'); };
  const comErro = pedirLink(amb, ADMIN);

  igual([freado, foraDaLista, comErro], [enviado, enviado, enviado]);
});

teste('nem o envio quebrado muda a frase', () => {
  const amb = montar({ allowlist: ADMIN });
  const esperada = pedirLink(amb, ESTRANHO);

  amb.api.MailApp = {
    getRemainingDailyQuota: () => 100,
    sendEmail() { throw new Error('Service invoked too many times for one day: email'); }
  };

  igual(pedirLink(amb, ADMIN), esperada);
});

teste('endereço de fora não vira e-mail, nem propriedade, nem linha de log', () => {
  // O passo 3 devolve ANTES de qualquer efeito. Registrar seria construir, no
  // log, a lista de quem alguém andou tentando — que é dado que não queremos ter,
  // porque um log é lido por gente e sobrevive ao motivo pelo qual foi escrito.
  const amb = montar({ allowlist: ADMIN });
  const antes = retratoDasPropriedades(amb);

  ['estranho@exemplo.com', 'reitor@unicesusc.edu.br', 'chefe@outrolugar.com'].forEach((alvo) => {
    pedirLink(amb, alvo);
  });

  igual(destinatarios(amb), []);
  igual(retratoDasPropriedades(amb), antes, 'sobrou estado de um endereço de fora');

  const trilha = JSON.stringify(linhasDoLog(amb));
  ['estranho@exemplo.com', 'reitor@unicesusc.edu.br', 'chefe@outrolugar.com'].forEach((alvo) => {
    igual(trilha.indexOf(alvo), -1, 'o log virou a lista de quem tentaram: ' + trilha);
  });
});

teste('o TOKEN não fica guardado em lugar nenhum — o que fica é a impressão dele', () => {
  // A diferença aparece no dia ruim: quem conseguir ler as Propriedades do
  // script (um script colega no mesmo projeto, um despejo de depuração, alguém
  // com acesso ao editor) leva uma lista de hashes que não serve para entrar em
  // lugar nenhum. É a mesma razão pela qual um sistema não guarda a senha.
  const amb = montar({ allowlist: ADMIN });
  pedirLink(amb, ADMIN);
  const token = tokenDoEmail(amb);

  Array.from(amb.propriedades.entries()).forEach(([chave, valor]) => {
    igual(chave.indexOf(token), -1, 'O TOKEN ESTÁ NA CHAVE ' + chave);
    igual(String(valor).indexOf(token), -1, 'O TOKEN ESTÁ GUARDADO EM ' + chave);
  });

  const impressao = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  verdadeiro(amb.propriedades.has('link_' + impressao),
    'a impressão guardada não é o SHA-256 do token: ' +
    JSON.stringify(Array.from(amb.propriedades.keys())));
});

teste('e o token não sai por nenhuma resposta do painel', () => {
  // Quem já entrou não pode colher, na aba Configurações ou no log, um link vivo
  // emitido para outra pessoa.
  const amb = montar({ allowlist: ADMIN + ', outra@exemplo.com' });
  pedirLink(amb, 'outra@exemplo.com');
  const token = tokenDoEmail(amb);

  const sessao = amb.api.criarSessao_(ADMIN);
  const respostas = JSON.stringify([
    painel(amb, 'lerConfiguracoes', sessao),
    painel(amb, 'listarLog', sessao),
    painel(amb, 'listarAdmins', sessao)
  ]);

  igual(respostas.indexOf(token), -1, 'O LINK DE OUTRA PESSOA VAZOU PELO PAINEL');
});

teste('a recusa de entrarComLink é UMA frase só, seja qual for o motivo', () => {
  // Inexistente, vencido e desautorizado. Uma recusa que varia conta a quem está
  // chutando o que ele ainda não sabe — inclusive que um token que ele achou por
  // aí é de alguém que já foi removido.
  const relogio = criarRelogio(new Date('2026-08-11T09:00:00Z').getTime());
  const amb = montar({ relogio: relogio, allowlist: ADMIN + ', saindo@exemplo.com' });

  const inexistente = entrarPeloLink(amb, 'a'.repeat(64));

  pedirLink(amb, ADMIN);
  const doVencido = tokenDoEmail(amb);

  pedirLink(amb, 'saindo@exemplo.com');
  const doRemovido = tokenDoEmail(amb);

  const sessao = amb.api.criarSessao_(ADMIN);
  amb.api.removerAdmin({ token: sessao, email: 'saindo@exemplo.com' });
  const desautorizado = entrarPeloLink(amb, doRemovido);

  relogio.avancar(16 * 60 * 1000);
  const vencido = entrarPeloLink(amb, doVencido);

  igual([vencido, desautorizado], [inexistente, inexistente]);
  igual(inexistente.ok, false);
});

teste('token com formato errado não toca sequer nas propriedades do script', () => {
  // Filtro barato antes do caro, e aqui o caro é o armazenamento: 500 KB
  // compartilhados com as sessões, e `getProperties()` traz TUDO o que está lá.
  const amb = montar({ allowlist: ADMIN });
  pedirLink(amb, ADMIN);
  const token = tokenDoEmail(amb);

  let toques = 0;
  const propsDeVerdade = amb.api.PropertiesService;
  amb.api.PropertiesService = {
    getScriptProperties() {
      toques++;
      return propsDeVerdade.getScriptProperties();
    }
  };

  ['', '   ', 'nao-e-token', token.toUpperCase(), token.slice(0, 63), token + 'a',
    token.slice(0, 63) + 'g', null, undefined, 12345, '../../etc/passwd',
    'x'.repeat(5000)].forEach((valor) => {
    igual(amb.api.entrarComLink(valor).ok, false, JSON.stringify(String(valor)).slice(0, 30));
  });

  igual(toques, 0, 'lixo chegou ao armazenamento');

  // O contrapeso: o mesmo contador tem de subir quando o token é de verdade,
  // senão o teste acima estaria medindo um espião que ninguém chama.
  igual(amb.api.entrarComLink(token).ok, true, 'e o token de verdade continua entrando');
  verdadeiro(toques > 0, 'o espião não estava no caminho: o teste acima não prova nada');
  amb.api.PropertiesService = propsDeVerdade;
});

// ============================== 6. O que a rota ANÔNIMA custa em cota

grupo('6. a cota — as três formas de desligar este sistema sem senha');

teste('um dilúvio de tokens bem formados não esvazia a cota de saída', () => {
  // O filtro de formato barra lixo, e não um JWT plausível: três segmentos
  // base64url é coisa que se gera em uma linha de terminal. Sem teto, cada um
  // deles custa UMA requisição de saída — e são 20 mil por dia, as MESMAS pelas
  // quais o Firestore inteiro passa. Esgotá-las não derruba só o login: derruba
  // a inscrição do aluno, que é a razão de o sistema existir.
  const amb = montar();
  googleResponde(amb, tokenBom({ aud: OUTRO_APLICATIVO }));

  for (let i = 0; i < 400; i++) entrarPeloGoogle(amb);

  verdadeiro(amb.tokeninfo.saidas.length < 200,
    'saíram ' + amb.tokeninfo.saidas.length + ' requisições para 400 tentativas anônimas');
});

teste('mas o teto do Google não fecha o link por e-mail junto', () => {
  // O teto existe para conter um estranho. Se ele fechasse também o caminho de
  // conserto, o estranho ganharia de brinde o que não conseguiu invadir.
  const amb = montar();
  googleResponde(amb, tokenBom({ aud: OUTRO_APLICATIVO }));
  for (let i = 0; i < 400; i++) entrarPeloGoogle(amb);

  igual(pedirLink(amb, ADMIN).ok, true);
  igual(destinatarios(amb), [ADMIN], 'o teto do Google trancou a porta de recuperação');
  igual(entrarPeloLink(amb, tokenDoEmail(amb)).ok, true);
});

teste('e a recusa por teto diz o que fazer, em vez de culpar a conta de quem tentou', () => {
  const amb = montar();
  googleResponde(amb, tokenBom({ aud: OUTRO_APLICATIVO }));
  for (let i = 0; i < 400; i++) entrarPeloGoogle(amb);

  const r = entrarPeloGoogle(amb, tokenBom());
  igual(r.ok, false);
  verdadeiro(/link por e-mail/.test(r.erro),
    'a frase precisa apontar a porta que ainda abre: ' + r.erro);
});

teste('endereço de fora não custa leitura nenhuma — é o que tira o preço da rota', () => {
  // Descobrir se um endereço está na allowlist custava uma leitura do Firestore,
  // e são 50 mil por dia compartilhadas com a inscrição do aluno. Era esse custo
  // que obrigava um teto global antes da conferência — e o teto era um botão de
  // desligar a porta de recuperação (ver o teste seguinte).
  //
  // O conserto não foi afrouxar o teto: foi tirar o custo. A allowlist fica em
  // cache (`allowlistParaLink_`), então uma enxurrada anônima não converte
  // pedidos em leituras. Sem esta propriedade, o teto teria de voltar.
  const amb = montar({ allowlist: ADMIN });

  // A primeira recarrega o cache e paga a leitura; é o controle.
  amb.api.limparCacheConfig();
  amb.falso.requisicoes.length = 0;
  amb.api.pedirLinkDeAcesso(ESTRANHO);
  igual(leiturasDeConfig(amb), 1, 'a primeira conferência tinha de ler a lista uma vez');

  // As duzentas seguintes saem do cache.
  amb.api.limparCacheConfig();
  amb.falso.requisicoes.length = 0;
  for (let i = 0; i < 200; i++) amb.api.pedirLinkDeAcesso('lixo' + i + '@exemplo.com');

  igual(leiturasDeConfig(amb), 0,
    'duzentos pedidos anônimos custaram ' + leiturasDeConfig(amb) + ' leitura(s) do banco');
  igual(destinatarios(amb), [], 'endereço de fora não pode receber nada');
});

teste('insistência de fora não fecha a porta de dentro — o teto global saiu por isso', () => {
  // ESTE TESTE GUARDA UM CONSERTO, e o defeito que ele guarda era grave.
  //
  // Havia um teto global de 60 pedidos por hora, conferido ANTES da allowlist
  // para proteger a leitura do banco. O efeito: sessenta requisições anônimas
  // com endereços inventados — um laço de `curl` — fechavam a porta de
  // recuperação para TODO MUNDO até virar a hora, repetível para sempre e de
  // graça. E essa porta existe exatamente para o dia em que o botão do Google
  // não funciona; nesse dia, quem decidiria se a coordenação entra seria o
  // atacante. Era a forma exata do freio global do PIN que o sistema tinha
  // acabado de remover.
  //
  // Com a allowlist em cache, conferir ficou de graça e o teto foi removido
  // inteiro. Se alguém reintroduzir um freio global aqui, este teste cai.
  const amb = montar({ allowlist: ADMIN });

  for (let i = 0; i < 300; i++) amb.api.pedirLinkDeAcesso('lixo' + i + '@exemplo.com');

  igual(pedirLink(amb, ADMIN).ok, true, 'a frase única não pode mudar nem aqui');
  igual(destinatarios(amb), [ADMIN],
    'trezentos pedidos de fora impediram a coordenação de receber o link');

  // E as outras duas portas seguem abertas, como sempre.
  igual(entrarPeloGoogle(amb, tokenBom()).ok, true, 'a enxurrada fechou o botão do Google');
});

teste('a cota de e-mail esgotada não vira silêncio', () => {
  // A cota é do Google e não se recupera antes da meia-noite. O log é o que
  // permite alguém entender, no dia seguinte, por que o link "não chegou" — sem
  // ele, o sintoma é indistinguível de spam, endereço errado ou sistema fora do
  // ar, e o professor fica horas no problema errado.
  const amb = montar({ allowlist: ADMIN, cota: 0 });

  igual(pedirLink(amb, ADMIN).ok, true);
  igual(destinatarios(amb), []);

  const linha = linhasDoLog(amb).filter((l) => l.acao === 'LINK_SEM_COTA')[0];
  verdadeiro(linha !== undefined, 'a cota acabou sem uma linha na trilha');
});

teste('a enxurrada de recusas vira poucas linhas de log, não uma por tentativa', () => {
  // 20 mil escritas por dia no plano gratuito. Um log por recusa faria o FREIO
  // derrubar o sistema mais depressa do que o abuso que ele existe para conter.
  const amb = montar();
  googleResponde(amb, tokenBom({ aud: OUTRO_APLICATIVO }));
  for (let i = 0; i < 60; i++) entrarPeloGoogle(amb);

  let linhas = 0;
  amb.falso.documentos.forEach((_campos, chave) => { if (chave.indexOf('log/') === 0) linhas++; });
  verdadeiro(linhas <= 3, linhas + ' linhas de log para 60 recusas');
});

// ====================================== 7. O site público continua igual

grupo('7. o site do aluno não pode ter sido tocado');

/** Leituras COBRADAS pelo Firestore — documentos, e não requisições HTTP. */
function leiturasCobradas(amb) {
  return amb.falso.requisicoes.reduce((soma, r) => {
    if (String(r.url).indexOf(':runAggregationQuery') !== -1) return soma + 1;
    if (String(r.url).indexOf(':runQuery') !== -1) {
      const colecao = r.corpo.structuredQuery.from[0].collectionId;
      let devolvidos = 0;
      amb.falso.documentos.forEach((_v, chave) => {
        if (chave.indexOf(colecao + '/') === 0) devolvidos++;
      });
      return soma + Math.max(1, devolvidos);
    }
    if (r.metodo === 'GET') return soma + 1;
    return soma;
  }, 0);
}

function comProjetos(amb, quantos) {
  for (let i = 1; i <= quantos; i++) {
    amb.api.inserir('projetos', {
      codigo: 'p' + i, nome: 'Projeto ' + i, descricao: 'x', professor: 'y',
      vagas: '60', ativo: 'SIM', inscricoes_abertas: 'SIM',
      validar_matricula: 'SIM', ordem: String(i), criado_em: '2026-08-05 10:00:00'
    }, 'p' + i);
  }
}

teste('?api=config e ?api=projetos custam os mesmos 2 e 11 de sempre', () => {
  const amb = montar();
  comProjetos(amb, 5);

  const medir = (parametros) => {
    amb.api.limparCacheConfig();
    amb.falso.requisicoes.length = 0;
    amb.api.doGet({ parameter: parametros });
    return leiturasCobradas(amb);
  };

  igual(medir({ api: 'config' }), 2, 'configuração + disciplinas ativas');
  // O 11º é o documento de configuração, lido UMA vez por execução para saber se
  // a fila de espera está ligada (`esperaLigada_`, 09_Projetos.gs). Cinco
  // projetos e uma pergunta só: o custo não cresce com P.
  igual(medir({ api: 'projetos' }), 11, '5 projetos na consulta + 5 contagens + a configuração');
});

teste('a rota de leitura continua respondendo do cache dentro da janela', () => {
  // É o cache que impede `?api=projetos` de ser um botão de desligar: sem ele,
  // dez requisições por segundo torram 50 mil leituras em oito minutos.
  const amb = montar();
  comProjetos(amb, 5);
  amb.api.doGet({ parameter: { api: 'projetos' } });

  amb.falso.requisicoes.length = 0;
  for (let i = 0; i < 20; i++) amb.api.doGet({ parameter: { api: 'projetos' } });
  igual(amb.falso.requisicoes.length, 0, 'o cache das rotas públicas parou de valer');
});

teste('o POST sem `acao` continua sendo a inscrição do aluno', () => {
  // O envelope do painel entrou no mesmo `doPost`. Se o padrão tivesse mudado,
  // toda inscrição vinda do site cairia em "Ação desconhecida" — e o site é o
  // lado que não tem quem reclame por escrito.
  const amb = montar();
  const r = post(amb, { nome: 'Maria', matricula: '9110001' });
  verdadeiro(r.erro && !/Ação desconhecida/.test(r.erro),
    'a inscrição deixou de ser o padrão do POST: ' + JSON.stringify(r));
});

teste('o painel entrou no doPost sem abrir rota nova no doGet', () => {
  // O `doGet` continua com as três rotas de leitura e mais nada: nenhuma ação do
  // painel entrou ali. Importa porque GET é o que se dispara com um link — e
  // metade das ações do painel ESCREVE.
  const amb = montar();
  const token = amb.api.criarSessao_(ADMIN);

  ['painel', 'exportarCsv', 'listarAlunos', 'lerConfiguracoes', 'removerProjeto'].forEach((rota) => {
    const r = JSON.parse(amb.api.doGet({ parameter: { api: rota, token: token } }).getContent());
    igual(r.ok, false, 'o doGet respondeu a ' + rota);
    verdadeiro(/Rota desconhecida/.test(r.erro), rota + ': ' + r.erro);
  });
});

// ================================ 8. A primeira entrada, com o console vazio

grupo('8. a primeira entrada do Jonathan, antes de qualquer passo de console');

teste('sem client id nenhum, a tela diz que o Google não está de pé', () => {
  // É o estado real do sistema HOJE: o client id ainda não existe, porque criá-lo
  // é passo de console. A tela não pode parecer quebrada nem prometer um botão
  // que recusaria todo mundo.
  const amb = montar({ clientId: null });
  const m = login(amb, { fn: 'modoDeAcesso' });

  igual(m.ok, true);
  igual(m.google.disponivel, false, 'anunciou um botão que vai recusar todo mundo');
  igual(m.google.clientId, '');
  igual(m.allowlistVazia, false, 'e a outra porta continua tendo para quem mandar link');

  igual(pedirLink(amb, ADMIN).ok, true);
  igual(entrarPeloLink(amb, tokenDoEmail(amb)).ok, true,
    'o link precisa entrar quando mais nada entra');
});

teste('com o client id criado mas a allowlist ainda vazia, o botão também não aparece', () => {
  const amb = montar({ allowlist: '' });
  const m = login(amb, { fn: 'modoDeAcesso' });

  igual(m.google.disponivel, false, 'o botão apareceria para recusar todo mundo');
  igual(m.allowlistVazia, true, 'a tela precisa deste bit para explicar o porquê');
});

teste('a ordem certa funciona inteira: liberarAcesso no editor, incluir e-mail, entrar pelo Google', () => {
  // O ensaio do que está escrito na documentação, do começo ao fim, na
  // implantação nova: banco semeado, allowlist vazia, client id ainda por criar.
  // O primeiro passo é o único que não acontece pela internet — e é justamente
  // por isso que ele é seguro.
  const amb = montar({ allowlist: '' });
  amb.api.console = { log: () => {}, error: () => {} };

  const url = amb.api.liberarAcesso(ADMIN);
  const sessao = /\?sessao=([0-9a-f]+)/.exec(url)[1];
  amb.api.limparCacheConfig();

  igual(painel(amb, 'incluirAdmin', sessao, { email: 'outra@exemplo.com' }).ok, true);
  amb.api.limparCacheConfig();

  igual(entrarPeloGoogle(amb, tokenBom()).ok, true, 'o botão do Google não entrou no fim da fila');

  // E daí em diante o link por e-mail vale para os dois nomes da lista.
  igual(pedirLink(amb, 'outra@exemplo.com').ok, true);
  igual(entrarPeloLink(amb, tokenDoEmail(amb)).ok, true);
});

teste('e o painel recém-liberado não fica com a lista de acesso vazia', () => {
  // O detalhe que faz `liberarAcesso` ser conserto e não remendo: se ela criasse
  // só a sessão, o professor entraria hoje, e amanhã — sessão vencida — estaria
  // exatamente onde estava, porque nenhuma das duas portas remotas teria a quem
  // deixar entrar.
  const amb = montar({ allowlist: '' });
  amb.api.console = { log: () => {}, error: () => {} };

  amb.api.liberarAcesso(ADMIN);
  amb.api.limparCacheConfig();

  const m = login(amb, { fn: 'modoDeAcesso' });
  igual(m.allowlistVazia, false, 'o dia seguinte volta ao estado sem porta nenhuma');
  igual(m.google.disponivel, true);
});

// ============================ 9. Os dois níveis: o professor tem token VÁLIDO,
//                                 e as 30 da coordenação continuam fechadas

/**
 * A SÉTIMA PERGUNTA deste arquivo, e ela é diferente das seis de cima: aqui o
 * atacante ENTROU. Ele tem conta na allowlist, token legítimo, sessão de oito
 * horas — e é, por desenho, uma das oito pessoas em quem o sistema confia. O
 * que se pergunta é se a tela é a permissão.
 *
 * Se for, o item 10 inteiro é enfeite: quem sabe abrir o console do navegador
 * manda o mesmo POST que o botão mandaria, e o botão desabilitado vira
 * decoração. Por isso todo teste desta seção entra pela PORTA (`doPost`) ou
 * chama a função DIRETO — nenhum clica em nada.
 */
grupo('9. o nível é do servidor — o professor com token válido e o console aberto');

/** A frase exata da recusa por nível. Muda aqui, cai o teste que lê o painel. */
const RECUSA_NIVEL = 'Esta ação é da coordenação geral. Seu acesso é de professor.';

const PROFESSOR = 'professora@exemplo.com';

/**
 * Um sistema com os dois níveis JÁ separados — o estado a partir do primeiro
 * gesto de nível: ADMIN é coordenador geral, PROFESSOR é professor, e os dois
 * têm sessão aberta.
 */
function comNiveis(opcoes) {
  const o = opcoes || {};
  const amb = montar({
    allowlist: o.allowlist === undefined ? ADMIN + ', ' + PROFESSOR : o.allowlist,
    gerais: o.gerais === undefined ? ADMIN : o.gerais
  });
  amb.coordenacao = amb.api.criarSessao_(ADMIN);
  amb.professor = amb.api.criarSessao_(PROFESSOR);
  return amb;
}

/**
 * Os nomes fechados ao professor, DERIVADOS da própria divisão do servidor.
 *
 * Nunca copiados à mão: uma lista escrita aqui envelheceria no dia em que
 * alguém acrescentasse uma função à lista branca, e o teste passaria a provar o
 * passado. Derivada, a função nova cai automaticamente do lado fechado — que é
 * o default do `funcoesDoProfessor_` — e é exercitada como ataque sem ninguém
 * escrever uma linha.
 */
function daCoordenacao(amb) {
  const professor = amb.api.funcoesDoProfessor_();
  return Object.keys(amb.api.funcoesDoPainel_())
    .filter((nome) => !Object.prototype.hasOwnProperty.call(professor, nome));
}

/** O banco inteiro MENOS a trilha: é o que prova que a recusa não mudou nada. */
function retratoDoBanco(amb) {
  const linhas = [];
  amb.falso.documentos.forEach((campos, chave) => {
    if (chave.indexOf('log/') === 0) return;
    linhas.push(chave + '=' + JSON.stringify(campos));
  });
  return linhas.sort().join('\n');
}

/** Um payload que serve para qualquer uma delas — o atacante manda tudo junto. */
function payloadDeAtaque() {
  return {
    chave: 'admin_emails', valor: 'invasor@exemplo.com',
    email: 'invasor@exemplo.com', nivel: 'coordenador',
    id: 'p1', ids: ['i1'], projeto_id: 'p1', lote_id: 'l1',
    matricula: '9110001', nome: 'Aluna Exemplo', turma: 'ADS11'
  };
}

teste('ATAQUE: o professor chama as 30 da coordenação uma a uma, pelo POST direto', () => {
  // O ataque é não usar a tela. O painel esconde aba e desabilita botão, e nada
  // disso vale um POST montado no console do navegador — a tela nunca é a
  // permissão. Aqui ele tem token VÁLIDO: quem recusa é o nível, não a sessão.
  //
  // Mutação que derruba: qualquer função nova na lista branca sem decisão de
  // balde (ela cai do lado fechado, e se alguém a abrir sem pensar este teste
  // deixa de exercitá-la e o da cobertura acusa); ou tirar a cobrança do
  // despacho, e aí as 30 respondem ok.
  const amb = comNiveis();
  const fechadas = daCoordenacao(amb);
  igual(fechadas.length, 30, 'a divisão mudou de tamanho: ' + fechadas.join(', '));

  const antes = retratoDoBanco(amb);

  fechadas.forEach((fn) => {
    const r = painel(amb, fn, amb.professor, payloadDeAtaque());
    igual(r.ok, false, fn + ' foi despachada para o professor');
    igual(r.erro, RECUSA_NIVEL, fn + ' recusou por outro motivo: ' + r.erro);
    igual(r.motivo, 'NIVEL', fn + ' não disse à tela que a recusa é de nível');
  });

  igual(retratoDoBanco(amb), antes, 'alguma das 30 mexeu no banco');
});

teste('e as 12 do professor respondem — senão o teste de cima provaria um painel morto', () => {
  // A ordem importa tanto quanto no grupo 3: "não dá para chamar X" passaria
  // sozinho num sistema que não deixa chamar nada.
  const amb = comNiveis();
  const abertas = Object.keys(amb.api.funcoesDoProfessor_());
  igual(abertas.length, 12);

  abertas.forEach((fn) => {
    const r = painel(amb, fn, amb.professor, { id: 'p1', pagina: 1, tamanho: 10 });
    igual(r.motivo, undefined, fn + ' foi recusada por nível para o professor');
  });
});

teste('e a trilha da recusa diz QUAL professor tentou', () => {
  // A coluna "Quem" existe para responder isso. Nenhum `exigirAdmin` roda neste
  // caminho — a função nem chega a ser chamada —, então quem anota o operador é
  // a própria rota.
  //
  // Mutação que derruba: tirar `anotarOperador_` da cobrança de nível; a linha
  // sai assinada por 'anonimo' e o Histórico não distingue os professores.
  const amb = comNiveis();
  painel(amb, 'removerProjeto', amb.professor, { id: 'p1' });

  const linha = linhasDoLog(amb).filter((l) => l.acao === 'NIVEL_NEGADO')[0];
  verdadeiro(linha !== undefined, 'a recusa por nível não deixou rastro nenhum');
  igual(linha.usuario, PROFESSOR, 'a trilha não diz qual professor tentou');
  igual(linha.entidade_id, PROFESSOR);
  verdadeiro(/tentou removerProjeto/.test(linha.detalhe), linha.detalhe);
});

teste('ATAQUE: o cliente escolhendo o próprio nível, dentro do payload', () => {
  // Se o nível viesse de `dados`, o item 10 seria um campo de formulário.
  //
  // Mutação que derruba: ler o nível do payload em vez de da sessão.
  const amb = comNiveis();

  const pelaRota = painel(amb, 'removerProjeto', amb.professor,
    { id: 'p1', nivel: 'coordenador', seuNivel: 'coordenador', coordenador: true });
  igual(pelaRota.ok, false, 'o cliente se promoveu pelo payload');
  igual(pelaRota.erro, RECUSA_NIVEL);

  // E por dentro, na função que cobra o nível ela mesma.
  const direto = amb.api.salvarConfiguracao({
    token: amb.professor, chave: 'vagas_padrao', valor: '1', nivel: 'coordenador'
  });
  igual(direto.ok, false);
  igual(direto.erro, RECUSA_NIVEL);
});

teste('ATAQUE: o professor mexendo em QUEM PODE — as quatro que cobram por dentro', () => {
  // As quatro cobram o nível POR DENTRO, além do despacho, e é isto que o teste
  // mede: as chamadas aqui são DIRETAS, sem passar pela rota. Se a cobrança
  // morasse só no despacho, bastaria um segundo cliente (um `google.script.run`,
  // uma rota nova) para a escalada de privilégio voltar a existir.
  //
  // São as duas metades do mesmo poder: CONCEDER (promover-se, incluir um
  // comparsa, reescrever qualquer das duas listas) e REVOGAR (tirar da lista
  // quem coordena). A última não promove ninguém, e é por isso que ela precisa
  // estar aqui: um professor que derruba a coordenação inteira fica sozinho no
  // painel pelo piso.
  //
  // Mutação que derruba: trocar `exigirCoordenador` por `exigirAdmin` em
  // qualquer uma das quatro.
  const amb = comNiveis();

  [
    ['salvarConfiguracao', { chave: 'coordenadores_gerais', valor: ADMIN + ', ' + PROFESSOR }],
    ['salvarConfiguracao', { chave: 'admin_emails', valor: PROFESSOR }],
    ['incluirAdmin', { email: 'comparsa@exemplo.com' }],
    ['definirNivel', { email: PROFESSOR, nivel: 'coordenador' }],
    ['removerAdmin', { email: ADMIN }]
  ].forEach(([fn, dados]) => {
    const r = amb.api[fn](Object.assign({ token: amb.professor }, dados));
    igual(r.ok, false, fn + '(' + dados.chave + dados.email + ') deixou o professor passar');
    igual(r.erro, RECUSA_NIVEL, fn + ': ' + r.erro);
  });

  amb.api.limparCacheConfig();
  igual(amb.api.nivelDe_(PROFESSOR), 'professor', 'o professor se promoveu');
  igual(amb.api.adminEmails_(), [ADMIN, PROFESSOR], 'a lista de acesso mudou');
});

teste('ATAQUE: esvaziar os coordenadores pelos QUATRO caminhos — sempre sobra um', () => {
  // A invariante mora dentro do escritor único, e é por isso que ela cobre os
  // quatro caminhos com uma guarda só. Um painel com oito professores é tão
  // trancado por fora quanto a allowlist vazia, e o conserto sai da tela e vai
  // para o editor do Apps Script.
  //
  // Mutação que derruba: tirar a conferência de `aplicarAcessos_` — qualquer um
  // dos quatro passa a produzir o painel sem dono.
  const amb = comNiveis();
  const eu = { token: amb.coordenacao };

  const rebaixar = amb.api.definirNivel(Object.assign({ email: ADMIN, nivel: 'professor' }, eu));
  igual(rebaixar.ok, false, 'o único coordenador se rebaixou');
  verdadeiro(/único coordenador geral/.test(rebaixar.erro), rebaixar.erro);

  const remover = amb.api.removerAdmin(Object.assign({ email: ADMIN }, eu));
  igual(remover.ok, false, 'o último coordenador saiu pela lista de acesso');
  verdadeiro(/último coordenador geral/.test(remover.erro), remover.erro);

  const campoAllowlist = amb.api.salvarConfiguracao(
    Object.assign({ chave: 'admin_emails', valor: PROFESSOR }, eu));
  igual(campoAllowlist.ok, false, 'o campo admin_emails deixou o painel sem coordenador');
  verdadeiro(/nenhum coordenador geral/.test(campoAllowlist.erro), campoAllowlist.erro);

  const campoGerais = amb.api.salvarConfiguracao(
    Object.assign({ chave: 'coordenadores_gerais', valor: '   ,  ' }, eu));
  igual(campoGerais.ok, false, 'esvaziar o campo de níveis promoveu todo mundo');
  verdadeiro(/poder total/.test(campoGerais.erro), campoGerais.erro);

  amb.api.limparCacheConfig();
  igual(amb.api.coordenadoresGerais_(), [ADMIN], 'a lista de coordenadores mudou');
  igual(amb.api.adminEmails_(), [ADMIN, PROFESSOR]);
});

teste('ATAQUE: o nível não é porta — e-mail de coordenador fora da lista de acesso', () => {
  // O nível diz o que se pode DEPOIS de entrar; quem decide quem entra é
  // `admin_emails`, sozinha. Um e-mail escrito só na chave de níveis é inerte —
  // e precisa ser inerte, senão a segunda chave viraria uma segunda allowlist,
  // com metade das guardas.
  //
  // Mutação que derruba: trocar o cruzamento das duas listas por união.
  const amb = montar({ allowlist: ADMIN, gerais: ADMIN + ', fantasma@exemplo.com' });

  igual(amb.api.nivelDe_('fantasma@exemplo.com'), '', 'o fantasma virou coordenador');
  igual(amb.api.coordenadoresGerais_(), [ADMIN]);

  igual(entrarPeloGoogle(amb, tokenBom({ email: 'fantasma@exemplo.com' })).ok, false,
    'o fantasma entrou pelo botão do Google');

  igual(pedirLink(amb, 'fantasma@exemplo.com').ok, true, 'a recusa virou oráculo');
  igual(destinatarios(amb), [], 'saiu link para quem não está na lista de acesso');
});

teste('ATAQUE: a sessão aberta sobrevive ao rebaixamento?', () => {
  // As duas metades. Sem derrubar a sessão, "agora você é professor" só valeria
  // na PRÓXIMA vez que ela entrasse — e até lá a tela dela continuaria desenhada
  // com as nove abas, cada clique virando uma recusa que ela não sabe explicar.
  //
  // Mutação que derruba: gravar o nível sem `invalidarSessoesDe_`.
  const amb = comNiveis();
  igual(amb.api.definirNivel({
    token: amb.coordenacao, email: PROFESSOR, nivel: 'coordenador'
  }).ok, true);

  const dela = amb.api.criarSessao_(PROFESSOR);
  igual(painel(amb, 'listarAdmins', dela).ok, true, 'promovida, ela devia ler a lista');

  igual(amb.api.definirNivel({
    token: amb.coordenacao, email: PROFESSOR, nivel: 'professor'
  }).ok, true);

  igual(amb.api.sessaoAtiva(dela).ok, false, 'a sessão de quem mudou de nível não caiu');
  igual(painel(amb, 'listarAdmins', dela).erro, RECUSA);
  igual(amb.api.sessaoAtiva(amb.coordenacao).ok, true, 'a sessão de quem mexeu caiu junto');
});

teste('a recusa por nível NÃO faz o painel se deslogar — a expressão é lida de lá', () => {
  // O painel se desloga sozinho quando a resposta casa com uma expressão
  // regular. Uma recusa de nível que casasse mandaria o professor para o login a
  // cada clique fora do quintal dele, e ele entraria de novo para receber a
  // mesma coisa.
  //
  // Mutação que derruba: escrever "Ação inválida para o seu nível" — a palavra
  // "inválida" casa, e o professor entra num laço de login.
  const fs = require('fs');
  const path = require('path');
  const pagina = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'painel', 'index.html'), 'utf8');

  const achado = /\/([^\n/]+)\/i\.test\(r\.erro/.exec(pagina);
  verdadeiro(achado !== null, 'a expressão que desloga o painel sumiu de index.html');

  const desloga = new RegExp(achado[1], 'i');
  verdadeiro(desloga.test(RECUSA), 'a expressão lida não reconhece nem a recusa de sessão');

  const amb = montar();
  igual(amb.api.RECUSA_NIVEL, RECUSA_NIVEL, 'a frase do servidor mudou e este teste não soube');
  igual(desloga.test(RECUSA_NIVEL), false,
    'a recusa de nível casa com a expressão que desloga: ' + RECUSA_NIVEL);
});

teste('as 12 do professor são leitura — e a varredura é TRANSITIVA', () => {
  // A varredura precisa ser transitiva por causa de `atualizarAlunos`: o botão
  // se chama "Atualizar", parece recarregar, e uma varredura do corpo dela por
  // `inserir(`/`atualizar(` não acha NADA. Ela chama
  // `reconciliarSeValerAPena_`, que reescreve a coleção `alunos` inteira.
  //
  // `exportarCsv` é a ÚNICA exceção, e ela é declarada aqui com o motivo: ela
  // grava a linha EXPORTACAO na trilha (decisão do Jonathan, 23/09 — o professor
  // exporta, e é por essa linha que a trilha responde qual professor exportou).
  //
  // Mutação que derruba: pôr `atualizarAlunos` no balde do professor; ou trocar
  // a varredura por não-transitiva, e aí ela passa a mentir.
  const fs = require('fs');
  const path = require('path');
  const pagina = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'painel', 'index.html'), 'utf8');

  const bloco = /var SO_LEITURA = \{([\s\S]*?)\};/.exec(pagina);
  verdadeiro(bloco !== null, 'SO_LEITURA sumiu do painel');
  const soLeitura = bloco[1].match(/[A-Za-z_$][\w$]*(?=\s*:)/g) || [];

  // O corpo de cada função de topo dos `.gs`, com as chaves balanceadas.
  const corpos = {};
  GS.forEach((arquivo) => {
    const texto = fs.readFileSync(path.join(__dirname, '..', 'apps-script', arquivo), 'utf8');
    const inicio = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
    let m;
    while ((m = inicio.exec(texto)) !== null) {
      let profundidade = 0;
      const abre = texto.indexOf('{', m.index);
      for (let j = abre; j < texto.length; j++) {
        if (texto[j] === '{') profundidade++;
        if (texto[j] === '}' && --profundidade === 0) {
          corpos[m[1]] = texto.slice(abre, j + 1);
          break;
        }
      }
    }
  });

  // As escritas do REPO e da trilha. `setProperty`/`deleteProperty` ficam de
  // fora de propósito: toda função guardada passa por `exigirAdmin` ->
  // `tokenValido_`, que APAGA a sessão vencida — varrer sessão morta não é
  // escrever no cadastro, e incluí-los faria as doze acusarem o mesmo falso.
  const ESCRITAS = ['inserir', 'atualizar', 'excluir', 'escreverEmLote', 'excluirEmLote',
    'atualizarEmLote', 'escreverAtomico', 'gravarConfig', 'gravarAcessos_',
    'registrar', 'registrarRecusa'];

  function escreve(nome) {
    const vistos = {};
    const fila = [[nome, [nome]]];
    while (fila.length) {
      const [f, caminho] = fila.shift();
      if (vistos[f]) continue;
      vistos[f] = true;
      if (!corpos[f]) continue;

      const chamadas = corpos[f].match(/[A-Za-z_$][\w$]*(?=\s*\()/g) || [];
      for (const c of chamadas) {
        if (ESCRITAS.indexOf(c) !== -1) return caminho.concat(c).join(' -> ');
        if (corpos[c]) fila.push([c, caminho.concat(c)]);
      }
    }
    return '';
  }

  const amb = montar();
  const EXCECAO = 'exportarCsv';
  const foraDeSoLeitura = [];
  const escritoras = [];

  Object.keys(amb.api.funcoesDoProfessor_()).forEach((nome) => {
    if (nome !== EXCECAO && soLeitura.indexOf(nome) === -1) foraDeSoLeitura.push(nome);
    const caminho = escreve(nome);
    if (caminho && nome !== EXCECAO) escritoras.push(caminho);
  });

  igual(foraDeSoLeitura, [], 'o painel não as tem como leitura, e elas estão abertas');
  igual(escritoras, [], 'função de escrita no balde do professor');
  verdadeiro(escreve(EXCECAO).indexOf('registrar') !== -1,
    'exportarCsv deixou de escrever a linha EXPORTACAO — a exceção perdeu o motivo');
  verdadeiro(escreve('atualizarAlunos') !== '',
    'a varredura deixou de enxergar a escrita atrás de reconciliarSeValerAPena_');
});

teste('recusar por NÍVEL não custa uma leitura sequer, com token inválido', () => {
  // Irmão do teste da recusa de sessão, e a razão de `exigirCoordenador` chamar
  // `exigirAdmin` PRIMEIRO. Invertido, cada tentativa anônima passaria a ler a
  // configuração para descobrir o nível de uma sessão que não existe — e um
  // endereço anônimo que gasta leitura para dizer "não" é um botão de desligar.
  //
  // Mutação que derruba: perguntar o nível antes da sessão.
  const amb = comNiveis();
  painel(amb, 'removerProjeto', 'inventado', { id: 'p1' });
  igual(amb.falso.requisicoes.length, 0);

  amb.falso.requisicoes.length = 0;
  lancouNivel(() => amb.api.exigirCoordenador('inventado'));
  igual(amb.falso.requisicoes.length, 0, 'a guarda leu o banco antes de conferir a sessão');
});

/** `exigirCoordenador` lança; aqui só se quer o efeito colateral (nenhum). */
function lancouNivel(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('esperava recusa, e passou');
}

teste('a migração é NULA: sem a chave no banco, quem entra continua podendo tudo', () => {
  // A chave nasce vazia em CONFIG_PADRAO, e vazia significa "ninguém separou os
  // níveis ainda". É o que permite implantar esta peça sem tocar no banco, sem
  // rodar `setup()` e sem um dia em que o painel acorda sem dono.
  //
  // Mutação que derruba: trocar o piso por "vazia = todo mundo professor". A
  // suíte inteira cai de uma vez, porque ninguém mais coordena nada.
  const amb = montar({ allowlist: ADMIN + ', ' + PROFESSOR });

  igual(amb.api.config('coordenadores_gerais'), '', 'a chave nasceu preenchida');
  igual(amb.api.coordenadoresGerais_(), []);
  igual(amb.api.nivelDe_(ADMIN), 'coordenador');
  igual(amb.api.nivelDe_(PROFESSOR), 'coordenador', 'o dia 1 rebaixou alguém');

  const dela = amb.api.criarSessao_(PROFESSOR);
  igual(painel(amb, 'listarAdmins', dela).ok, true, 'o painel acordou sem dono');

  // E a chave aparece na aba Configurações explicada, porque ela vai aparecer
  // lá de qualquer jeito assim que existir no banco.
  const padrao = amb.api.CONFIG_PADRAO.filter((c) => c.chave === 'coordenadores_gerais')[0];
  verdadeiro(padrao !== undefined, 'a chave não está em CONFIG_PADRAO');
  igual(padrao.valor, '');
  verdadeiro(padrao.descricao.length > 200, 'a chave apareceria na tela sem explicação');
});

teste('MATERIALIZAÇÃO ao rebaixar: os outros ficam escritos, e o piso não os devolve', () => {
  // Com a chave vazia, rebaixar alguém gravando `[]` não faz nada: o piso
  // devolve a pessoa a coordenador no primeiro clique seguinte, e a tela diz
  // "salvo". O primeiro gesto de nível precisa ESCREVER quem já era coordenador.
  //
  // Mutação que derruba: gravar a lista sem materializar.
  const amb = montar({ allowlist: ADMIN + ', ' + PROFESSOR + ', outra@exemplo.com' });
  const token = amb.api.criarSessao_(ADMIN);

  igual(amb.api.definirNivel({ token: token, email: PROFESSOR, nivel: 'professor' }).ok, true);

  amb.api.limparCacheConfig();
  igual(amb.api.config('coordenadores_gerais'), ADMIN + ', outra@exemplo.com');
  igual(amb.api.nivelDe_(PROFESSOR), 'professor', 'o piso devolveu o rebaixado a coordenador');
  igual(amb.api.nivelDe_('outra@exemplo.com'), 'coordenador', 'rebaixou quem ninguém tocou');
});

teste('MATERIALIZAÇÃO ao incluir: quem chega nasce professor, e os de antes não caem', () => {
  // O furo mais fácil de não enxergar: com a chave vazia, incluir alguém e não
  // materializar cria um coordenador geral em silêncio — o
  // pedido da coordenação ao contrário, e logo no primeiro gesto.
  //
  // Mutação que derruba: não materializar em `incluirAdmin`.
  const amb = montar({ allowlist: ADMIN + ', outra@exemplo.com' });
  const token = amb.api.criarSessao_(ADMIN);

  const r = amb.api.incluirAdmin({ token: token, email: PROFESSOR });
  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.nivel, 'professor', 'quem chegou nasceu podendo tudo');

  amb.api.limparCacheConfig();
  igual(amb.api.nivelDe_(PROFESSOR), 'professor');
  igual(amb.api.nivelDe_(ADMIN), 'coordenador');
  igual(amb.api.nivelDe_('outra@exemplo.com'), 'coordenador', 'os de antes foram rebaixados');
});

teste('MATERIALIZAÇÃO no campo de texto: o mesmo gesto, pela aba Configurações', () => {
  // O campo `admin_emails` acrescenta gente sem passar pelo botão Incluir, e não
  // pode ter outras regras — é o mesmo gesto por outro caminho.
  //
  // Mutação que derruba: materializar só em `incluirAdmin`.
  const amb = montar({ allowlist: ADMIN + ', outra@exemplo.com' });
  const token = amb.api.criarSessao_(ADMIN);

  const r = amb.api.salvarConfiguracao({
    token: token, chave: 'admin_emails',
    valor: ADMIN + ', outra@exemplo.com, ' + PROFESSOR
  });
  igual(r.ok, true, 'erro foi: ' + r.erro);

  amb.api.limparCacheConfig();
  igual(amb.api.nivelDe_(PROFESSOR), 'professor', 'quem entrou pelo campo nasceu coordenador');
  igual(amb.api.nivelDe_('outra@exemplo.com'), 'coordenador');
});

teste('o campo coordenadores_gerais recusa o vazio e o e-mail de fora — e não grava metade', () => {
  // Campo vazio cairia no piso, e o piso devolve poder total aos oito com a tela
  // dizendo "salvo": é promoção em massa por uma tecla Delete. E-mail de fora
  // seria inerte, que é pior do que recusado — quem digitou acredita ter dado
  // acesso a alguém.
  //
  // Mutação que derruba: tratar vazio como "todo mundo coordenador".
  const amb = comNiveis();
  const eu = { token: amb.coordenacao };

  const vazio = amb.api.salvarConfiguracao(
    Object.assign({ chave: 'coordenadores_gerais', valor: '' }, eu));
  igual(vazio.ok, false);
  verdadeiro(/poder total/.test(vazio.erro), vazio.erro);

  const deFora = amb.api.salvarConfiguracao(Object.assign(
    { chave: 'coordenadores_gerais', valor: ADMIN + ', ninguem@exemplo.com' }, eu));
  igual(deFora.ok, false);
  verdadeiro(/ninguem@exemplo.com/.test(deFora.erro), deFora.erro);
  verdadeiro(/Nada foi alterado/.test(deFora.erro), deFora.erro);

  amb.api.limparCacheConfig();
  igual(amb.api.config('coordenadores_gerais'), ADMIN, 'gravou metade do campo');
});

teste('liberarAcesso volta COORDENADOR, e repõe o e-mail nas duas chaves', () => {
  // Uma porta de emergência que desemboca num painel de professor não conserta
  // nada: o professor não abre Configurações, que é justamente o que se foi
  // consertar. E ela não concede privilégio novo — quem a roda está com o editor
  // do Apps Script aberto e poderia reescrever `exigirCoordenador` inteiro.
  //
  // Mutação que derruba: repor só em `admin_emails`.
  const amb = comNiveis();
  amb.api.console = { log: () => {}, error: () => {} };

  amb.api.liberarAcesso(PROFESSOR);

  amb.api.limparCacheConfig();
  igual(amb.api.nivelDe_(PROFESSOR), 'coordenador', 'o socorro devolveu um professor');
  igual(amb.api.coordenadoresGerais_(), [ADMIN, PROFESSOR]);

  // Com a chave ainda vazia ela não escreve nível nenhum: o piso já resolve, e
  // congelar níveis que ninguém pediu para congelar seria decidir por quem não
  // está olhando.
  const novo = montar({ allowlist: '' });
  novo.api.console = { log: () => {}, error: () => {} };
  novo.api.liberarAcesso(ADMIN);
  novo.api.limparCacheConfig();
  igual(novo.api.coordenadoresGerais_(), []);
  igual(novo.api.nivelDe_(ADMIN), 'coordenador');
});

teste('as duas listas de acesso têm UM escritor só — teste de fonte', () => {
  // A lição que este repositório já escreveu em `gravarConfig`: uma guarda
  // espalhada por quatro caminhos é uma guarda que o quinto caminho esquece. A
  // invariante do último coordenador mora dentro de `aplicarAcessos_`, e ela só
  // vale enquanto ninguém escrever as chaves por fora.
  //
  // Mutação que derruba: um `gravarConfig('admin_emails', ...)` novo em qualquer
  // lugar — exatamente o bug que o comentário de 03_Config.gs prevê.
  const fs = require('fs');
  const path = require('path');
  const pasta = path.join(__dirname, '..', 'apps-script');

  const fontes = fs.readdirSync(pasta).filter((f) => /\.gs$/.test(f));
  verdadeiro(fontes.length >= 19, 'só achei ' + fontes.length + ' arquivos .gs');

  const porFora = [];
  let chamadas = 0;
  fontes.forEach((arquivo) => {
    const texto = fs.readFileSync(path.join(pasta, arquivo), 'utf8');
    ["gravarConfig('admin_emails'", "gravarConfig('coordenadores_gerais'"].forEach((trecho) => {
      if (texto.indexOf(trecho) !== -1) porFora.push(arquivo + ': ' + trecho);
    });
    chamadas += (texto.match(/gravarAcessos_\s*\(/g) || []).length;
  });

  igual(porFora, [], 'alguém escreve uma das listas de acesso por fora do escritor único');
  // A definição mais UMA chamada. Duas chamadas é o quinto caminho nascendo.
  igual(chamadas, 2, 'gravarAcessos_ deixou de ter um chamador só');
});

teste('todo nome da lista branca está em exatamente UM balde', () => {
  // A conta que impede a peça de envelhecer: função nova entra na lista branca e
  // cai do lado fechado sozinha (`funcoesDoProfessor_` é fail-closed), mas o
  // número aqui muda — e é o número que obriga quem acrescentou a decidir de
  // propósito, em vez de por omissão.
  //
  // Mutação que derruba: acrescentar entrada à lista branca sem decidir o balde.
  const amb = montar();
  const todas = Object.keys(amb.api.funcoesDoPainel_());
  const professor = Object.keys(amb.api.funcoesDoProfessor_());

  igual(professor.filter((n) => todas.indexOf(n) === -1), [],
    'nome fantasma no balde do professor: ele abriria uma porta que não existe');
  igual(todas.length, 42, 'a lista branca mudou de tamanho: ' + todas.length);
  igual(professor.length, 12);
  igual(todas.length - professor.length, 30);
});

process.exit(resultado());
