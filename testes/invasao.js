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
  '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs', '05b_FormatoAcademico.gs',
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

process.exit(resultado());
