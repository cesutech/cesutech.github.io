/**
 * acesso.js — as três portas do painel (07_Auth.gs e 07b_LinkPorEmail.gs).
 *
 * O QUE ESTE ARQUIVO PROVA, e em ordem de importância:
 *
 *   1. a VERIFICAÇÃO DO ID TOKEN é completa. O teste que mais importa do
 *      arquivo inteiro é "token emitido para OUTRO aplicativo é recusado": um
 *      ID token é assinado pelo Google, e todo aplicativo Google do mundo emite
 *      tokens com essa mesma assinatura. Conferir só a assinatura e o e-mail —
 *      que é o que a maioria dos tutoriais faz — deixaria qualquer pessoa com
 *      conta Google entrar aqui usando um token pego em outro site. O `aud` é o
 *      que separa autenticação de porta aberta, e ele tem teste próprio;
 *   2. falha de verificação é RECUSA, nunca "deixa passar" — inclusive quando
 *      quem falha é a rede, o próprio Google ou a configuração deste projeto;
 *   3. o LINK POR E-MAIL entra, e entra IDENTIFICANDO quem entrou. Ele é o
 *      caminho de conserto do dia em que a configuração do Google estiver
 *      errada, e por isso o freio dele é por ENDEREÇO: um atacante que não
 *      consegue entrar não pode, de brinde, atrasar quem consegue. (A prova de
 *      que a resposta dele não vira oráculo está em `invasao.js`, que é onde
 *      moram os testes escritos como ataque.);
 *   4. `liberarAcesso()` é o último recurso, e ele repõe o e-mail na allowlist —
 *      sem isso a sessão nasceria para alguém que as duas portas remotas
 *      continuariam recusando, e o painel seguiria trancado por fora;
 *   5. as guardas de quem tem acesso: ninguém sai da lista sendo o último, e a
 *      lista NUNCA fica vazia — hoje sem depender de configuração nenhuma,
 *      porque ela é a fonte única das duas portas remotas.
 *
 * O QUE ESTE ARQUIVO NÃO PROVA, e nenhum teste em Node prova:
 *   - que o Google Identity Services desenha o botão e devolve um ID token —
 *     isso é navegador, e é da fase seguinte;
 *   - que o `aud` do token real bate com o client id real. O que se prova aqui é
 *     que ESTE código compara os dois e recusa quando diferem. Só o console do
 *     Google diz qual é o valor certo;
 *   - que a origem `https://<conta>.github.io` está registrada no client id. Se
 *     não estiver, o navegador nem chega a produzir o token, e o servidor nunca
 *     fica sabendo — a tela some sem erro deste lado;
 *   - que o e-mail SAI. `MailApp` aqui é de mentira; o que se prova é o que este
 *     código manda enviar, para quem, e em que condições ele desiste.
 *
 * Uso:  node testes/acesso.js
 */

'use strict';

const crypto = require('crypto');

const { teste, grupo, igual, verdadeiro, lancou, resultado, criarAmbiente, criarRelogio } = require('./apoio');

// Todos os `.gs`, na ordem alfabética em que o editor os carrega: os testes de
// integração deste arquivo entram pelo `doPost`, e o despacho do painel
// referencia funções de 05, 06, 09, 10, 11 e 12.
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '02b_Drive.gs', '03_Config.gs',
  '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs', '05b_FormatoAcademico.gs', '05c_Revisao.gs',
  '06_Reconciliacao.gs', '07_Auth.gs', '07b_LinkPorEmail.gs', '08_Api.gs', '09_Projetos.gs',
  '10_Painel.gs', '11_Banners.gs', '12_Disciplinas.gs', '13_Auditorio.gs'];

const CLIENT_ID = '111222333-abcxyz.apps.googleusercontent.com';

/** Um ID token tem três segmentos base64url. O conteúdo não importa: quem o lê é o Google. */
const TOKEN_BEM_FORMADO = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.YXNzaW5hdHVyYQ';

// ------------------------------------------------------------ Ambiente

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
 * Sandbox com o `tokeninfo` do Google e o correio sob controle do teste.
 *
 * O envelope do `UrlFetchApp` intercepta SÓ o endereço do Google e devolve o
 * resto ao Firestore falso do `apoio.js`. Assim o mesmo ambiente exercita o
 * login e a gravação da allowlist, que é uma escrita de verdade no banco falso.
 *
 * `chamadas` existe para provar o que NÃO acontece: token malformado, token
 * grande demais e ausência de client id têm de recusar SEM sair para a rede —
 * requisição de saída tem cota diária própria, e ela é a mesma pela qual o
 * Firestore inteiro passa.
 *
 * `MailApp` e o SHA-256 não existem no `apoio.js` (ele nasceu antes de o
 * projeto ter os dois) e são montados aqui:
 *
 *   MailApp    guarda as mensagens em vez de enviá-las, e a cota de envio é
 *              regulável — `enviarLink_` desiste quando ela zera, e esse ramo só
 *              se exercita se o teste puder zerá-la;
 *   SHA-256    o falso de `apoio.js` responde MD5 para qualquer algoritmo. Isso
 *              não muda o comportamento de `impressaoDoLink_`, mas um teste que
 *              confere hash tem de conferir o hash de verdade.
 */
function ambiente(opcoes) {
  opcoes = opcoes || {};
  const amb = criarAmbiente({ arquivos: GS, usuario: '', relogio: opcoes.relogio });

  const tokeninfo = { chamadas: [], resposta: null };
  const aoFirestore = amb.falso.UrlFetchApp.fetch;

  amb.api.UrlFetchApp = {
    fetch(url, opcoesFetch) {
      if (String(url).indexOf('oauth2.googleapis.com/tokeninfo') !== -1) {
        tokeninfo.chamadas.push({ url: String(url), opcoes: opcoesFetch });
        if (tokeninfo.lancar) throw new Error('DNS temporariamente indisponível');
        const r = tokeninfo.resposta || { codigo: 400, corpo: { error: 'invalid_token' } };
        return {
          getResponseCode: () => r.codigo,
          getContentText: () => (typeof r.corpo === 'string' ? r.corpo : JSON.stringify(r.corpo))
        };
      }
      return aoFirestore(url, opcoesFetch);
    },
    // O `tokeninfo` nunca vai em lote — só o Firestore usa `fetchAll`, e por
    // isso o desvio de cima não precisa se repetir aqui.
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

  const correio = { enviados: [], cota: opcoes.cota === undefined ? 100 : opcoes.cota, falhar: false };
  amb.api.MailApp = {
    getRemainingDailyQuota: () => correio.cota,
    sendEmail(mensagem) {
      if (correio.falhar) throw new Error('Service invoked too many times');
      correio.enviados.push(mensagem);
      correio.cota--;
    }
  };
  amb.correio = correio;

  amb.api.semearConfigPadrao_();
  if (opcoes.clientId !== null) {
    amb.propriedades.set('GOOGLE_CLIENT_ID', opcoes.clientId || CLIENT_ID);
  }
  if (opcoes.allowlist !== undefined) amb.api.gravarConfig_('admin_emails', opcoes.allowlist);

  return amb;
}

/** O token que viajou dentro do corpo da mensagem de índice `qual` (padrão: a última). */
function tokenDoEmail(amb, qual) {
  const mensagem = amb.correio.enviados[qual === undefined ? amb.correio.enviados.length - 1 : qual];
  verdadeiro(mensagem !== undefined, 'nenhuma mensagem foi enviada');

  const achado = /\?entrar=([0-9a-f]{64})/.exec(mensagem.body);
  verdadeiro(achado !== null, 'o corpo do e-mail não trouxe link nenhum:\n' + mensagem.body);
  return achado[1];
}

/** Para quem cada mensagem foi. */
function destinatarios(amb) {
  return amb.correio.enviados.map((m) => m.to);
}

/** Resposta de `tokeninfo` para um token bom. `troca` sobrescreve um campo. */
function tokenBom(troca) {
  return Object.assign({
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: String(Math.floor(new Date().getTime() / 1000) + 3600),
    email: 'Coordenacao@Exemplo.com',
    email_verified: 'true',
    sub: '10987654321'
  }, troca || {});
}

function responder(amb, corpo, codigo) {
  amb.tokeninfo.resposta = { codigo: codigo === undefined ? 200 : codigo, corpo: corpo };
}

/** As ações gravadas na trilha, na ordem de inserção. */
function acoesDoLog(amb) {
  const acoes = [];
  amb.falso.documentos.forEach((campos, chave) => {
    if (chave.indexOf('log/') === 0) acoes.push(campos.acao.stringValue);
  });
  return acoes;
}

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

/** Uma requisição POST ao web app, como o painel no GitHub Pages a manda. */
function post(amb, corpo) {
  const saida = amb.api.doPost({
    postData: { type: 'text/plain', contents: JSON.stringify(corpo) }
  });
  return JSON.parse(saida.getContent());
}

// ================================================== A verificação do ID token

grupo('entrarComGoogle — o que TEM de ser conferido');

teste('token emitido para OUTRO aplicativo Google é recusado', () => {
  // ESTE É O TESTE. Um ID token assinado pelo Google é válido em toda parte: o
  // que o prende a ESTE sistema é o `aud`. Sem esta conferência, qualquer pessoa
  // com conta Google pega o token que o próprio navegador dela recebeu em
  // qualquer outro site e entra aqui como administradora.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, tokenBom({ aud: '999888-outroapp.apps.googleusercontent.com' }));

  const r = amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO);

  igual(r.ok, false);
  igual(r.token, undefined, 'não pode sair sessão de um token que não é nosso');
  verdadeiro(linhasDoLog(amb).some((l) => l.detalhe.indexOf('aud') !== -1),
    'a trilha precisa dizer QUAL item falhou, senão o conserto vira adivinhação');
});

teste('sem GOOGLE_CLIENT_ID configurado, recusa — e nem sai para a rede', () => {
  // Sem client id não existe `aud` para comparar. Comparar contra vazio seria
  // aceitar qualquer token; é o modo de falha que parece "ainda não configurei"
  // e na verdade é "está aberto".
  const amb = ambiente({ clientId: null, allowlist: 'coordenacao@exemplo.com' });
  responder(amb, tokenBom());

  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false);
  igual(amb.tokeninfo.chamadas.length, 0);
  verdadeiro(linhasDoLog(amb).some((l) => l.detalhe.indexOf('GOOGLE_CLIENT_ID') !== -1),
    'a trilha precisa nomear a propriedade que resolve');
});

teste('as duas grafias de iss valem, e uma terceira não', () => {
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });

  ['accounts.google.com', 'https://accounts.google.com'].forEach((iss) => {
    responder(amb, tokenBom({ iss: iss }));
    igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, true, iss + ' devia valer');
  });

  responder(amb, tokenBom({ iss: 'https://accounts.google.com.evil.example' }));
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false);

  responder(amb, tokenBom({ iss: '' }));
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false);
});

teste('token vencido é recusado, e o vencimento é conferido aqui', () => {
  // O `tokeninfo` já recusa token vencido com 400. A conferência local existe
  // porque a validade é regra NOSSA: quem lê este arquivo não deveria precisar
  // saber o que o Google faz de graça — e um dia o Google pode mudar.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });

  responder(amb, tokenBom({ exp: String(Math.floor(new Date().getTime() / 1000) - 1) }));
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false);

  responder(amb, tokenBom({ exp: '' }));
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false, 'exp ausente não é exp no futuro');

  responder(amb, tokenBom({ exp: 'depois' }));
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false, 'exp ilegível não é exp no futuro');
});

teste('conta sem e-mail confirmado não entra', () => {
  // A allowlist compara E-MAIL. Uma conta Google com e-mail não confirmado não
  // prova o e-mail que ela declara, e é exatamente ele que abriria a porta.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });

  responder(amb, tokenBom({ email_verified: 'false' }));
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false);

  responder(amb, tokenBom({ email_verified: undefined }));
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false, 'campo ausente não é verdadeiro');
});

teste('o campo email_verified chega como TEXTO, e o booleano também vale', () => {
  // O `tokeninfo` devolve 'true', com aspas. Comparar com `=== true` recusaria
  // todo mundo — e a falha diria "conta sem e-mail confirmado", que manda o
  // professor procurar o problema na conta dele.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });

  responder(amb, tokenBom({ email_verified: 'true' }));
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, true);

  responder(amb, tokenBom({ email_verified: true }));
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, true);
});

teste('a conferência acontece na ordem certa: aud antes do e-mail', () => {
  // Um token de outro aplicativo, com um e-mail que ESTÁ na allowlist. Se o
  // e-mail fosse conferido primeiro (ou sozinho), este login passaria — e é
  // assim que a porta aberta se disfarça de sistema funcionando.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, tokenBom({ aud: 'outro.apps.googleusercontent.com', email: 'coordenacao@exemplo.com' }));

  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false);
});

grupo('entrarComGoogle — falhar é recusar, nunca deixar passar');

teste('tokeninfo respondendo erro é recusa', () => {
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, { error: 'invalid_token' }, 400);
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false);
});

teste('Google fora do ar é recusa, e não permissão', () => {
  // Tratar indisponibilidade como "não deu para conferir, então segue" é o
  // caminho que transforma uma queda do Google numa porta aberta. É para este
  // dia que o PIN existe.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  amb.tokeninfo.lancar = true;

  const r = amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO);
  igual(r.ok, false);
  igual(r.token, undefined);
});

teste('resposta ilegível do tokeninfo é recusa', () => {
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, '<html>manutenção</html>', 200);
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false);
});

teste('o que nem parece JWT é recusado sem sair para a rede', () => {
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, tokenBom());

  ['', 'nada', 'a.b', 'a.b.c.d', 'a b.c.d', null, undefined, 12345].forEach((v) => {
    igual(amb.api.entrarComGoogle_(v).ok, false, JSON.stringify(v) + ' passou');
  });
  igual(amb.tokeninfo.chamadas.length, 0,
    'formato ruim não pode gastar requisição de saída — é a mesma cota do Firestore');
});

teste('token absurdamente grande é recusado sem sair para a rede', () => {
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  const enorme = 'a'.repeat(3000) + '.' + 'b'.repeat(3000) + '.' + 'c'.repeat(3000);

  igual(amb.api.entrarComGoogle_(enorme).ok, false);
  igual(amb.tokeninfo.chamadas.length, 0);
});

teste('a chamada ao Google pede para ler o corpo do erro', () => {
  // Sem `muteHttpExceptions`, o `UrlFetchApp` LANÇA em 400 e o motivo do Google
  // se perde — a recusa continuaria certa, mas a trilha diria "não consegui
  // falar com o Google" para um token simplesmente vencido.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, tokenBom());
  amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO);

  const chamada = amb.tokeninfo.chamadas[0];
  igual(chamada.opcoes.muteHttpExceptions, true);
  igual(String(chamada.opcoes.method).toLowerCase(), 'get');
  verdadeiro(chamada.url.indexOf('id_token=') !== -1, chamada.url);
});

teste('enxurrada de token recusado não vira enxurrada de escrita', () => {
  // O log de recusa passa por `registrarRecusa_`, que agrupa por janela: uma
  // escrita por motivo por dez minutos. Sem isso, esta rota anônima seria um
  // gerador de escritas contra as 20 mil por dia do plano Spark — o freio
  // derrubaria o sistema mais depressa que o abuso.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, { error: 'invalid_token' }, 400);

  for (let i = 0; i < 40; i++) amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO);

  igual(acoesDoLog(amb).length, 1, 'quarenta recusas, uma linha');
});

// ================================================== O login que dá certo

grupo('entrarComGoogle — quando dá certo');

teste('conta da allowlist entra, e a caixa do e-mail não importa', () => {
  // A allowlist tem o e-mail em caixa alta; o Google devolve em caixa mista.
  // Duas grafias da MESMA conta não podem virar duas contas.
  const amb = ambiente({ allowlist: 'COORDENACAO@Exemplo.com , outra@exemplo.com' });
  responder(amb, tokenBom({ email: 'coordenacao@EXEMPLO.com' }));

  const r = amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO);

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.via, 'google');
  igual(r.usuario, 'coordenacao@exemplo.com');
  verdadeiro(!!r.token, 'faltou o token de sessão');
});

teste('o token emitido é uma sessão de verdade, e exigirAdmin o aceita', () => {
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, tokenBom());

  const r = amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO);
  igual(amb.api.exigirAdmin_(r.token), true);
  igual(amb.api.sessaoAtiva_(r.token).ok, true);
});

teste('as duas portas remotas sabem QUEM entrou — a do PIN não sabia', () => {
  // É o que a troca comprou. Sessão aberta por PIN gravava 'anonimo' no log, e
  // um registro de auditoria que não identifica ninguém não é registro. Hoje as
  // duas portas nascem de um e-mail da allowlist, e a trilha tem nome.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, tokenBom());

  const porGoogle = amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO);
  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
  const porLink = amb.api.entrarComLink_(tokenDoEmail(amb));

  igual(amb.api.emailDaSessao_(porGoogle.token), 'coordenacao@exemplo.com');
  igual(amb.api.emailDaSessao_(porLink.token), 'coordenacao@exemplo.com');

  const trilha = linhasDoLog(amb).filter((l) => l.acao === 'LOGIN');
  igual(trilha.map((l) => l.entidade_id), ['coordenacao@exemplo.com', 'coordenacao@exemplo.com']);
  igual(trilha.map((l) => l.detalhe),
    ['via conta Google (ID token)', 'via link por e-mail']);

  // E a COLUNA "Quem" também: a entrada é a única ação em que a pessoa se
  // identifica antes de existir sessão, então `exigirAdmin_` não passa por ela e
  // as duas portas anotam o operador por conta própria.
  //
  // Mutação que derruba: tirar `anotarOperador_` de `entrarComGoogle_` — este
  // ambiente é o publicado (`usuario: ''`), e a coluna volta a 'anonimo' na
  // linha que diz que alguém entrou. SÓ A DO GOOGLE: as duas portas rodam na
  // MESMA execução simulada aqui, e `OPERADOR_DA_EXECUCAO` é global ao script
  // (04_Log.gs), então a linha do link herda o nome que a do Google anotou. Quem
  // segura a porta do link é o teste seguinte, com ambiente próprio.
  igual(amb.api.usuarioAtual_(), 'anonimo', 'o cenário devia ser o do GitHub Pages');
  igual(trilha.map((l) => l.usuario), ['coordenacao@exemplo.com', 'coordenacao@exemplo.com']);
});

teste('e a porta do LINK sabe sozinha — sem nenhum login antes na mesma execução', () => {
  // Em produção não se herda nada: entrar por link é uma execução do Apps
  // Script inteiramente separada, sem `entrarComGoogle_` nenhum antes. Sem a
  // anotação, a ÚNICA linha que diz que alguém entrou pela porta dos fundos
  // sairia assinada por 'anonimo' — e é justamente a porta que se usa quando
  // alguma coisa já deu errado.
  //
  // A regra geral que esta cena escreve: qualquer teste que confira `usuario`
  // depois de DUAS chamadas na mesma execução está medindo a variável herdada,
  // e não a anotação daquela chamada.
  //
  // Mutação que derruba: tirar `anotarOperador_` de `entrarComLink_`.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
  igual(amb.api.entrarComLink_(tokenDoEmail(amb)).ok, true, 'o link não abriu a porta');

  const trilha = linhasDoLog(amb).filter((l) => l.acao === 'LOGIN');
  igual(trilha.length, 1, 'a cena devia ter UMA entrada só, a do link');
  igual(amb.api.usuarioAtual_(), 'anonimo', 'o cenário devia ser o do GitHub Pages');
  igual(trilha[0].usuario, 'coordenacao@exemplo.com',
    'a linha do link saiu assinada por ' + trilha[0].usuario);
});

teste('conta fora da allowlist não entra, e a recusa nomeia a própria conta', () => {
  // Não é vazamento: quem chega aqui já PROVOU ser dono daquele e-mail. Para
  // perguntar pela conta alheia seria preciso um token emitido para ela.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, tokenBom({ email: 'estranho@exemplo.com' }));

  const r = amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO);

  igual(r.ok, false);
  igual(r.token, undefined);
  verdadeiro(r.erro.indexOf('estranho@exemplo.com') !== -1, r.erro);
});

// ================================================== A segunda porta

grupo('as portas são independentes — derrubar uma não fecha a outra');

teste('modoDeAcesso não anuncia o botão que vai recusar todo mundo', () => {
  // Botão anunciado que recusa é pior do que botão ausente: o professor tenta,
  // lê "conta sem acesso" e conclui que o problema é a conta dele.
  const semClientId = ambiente({ clientId: null, allowlist: 'coordenacao@exemplo.com' });
  igual(semClientId.api.modoDeAcesso_().google, { disponivel: false, clientId: '' });

  const semLista = ambiente({ allowlist: '' });
  igual(semLista.api.modoDeAcesso_().google.disponivel, false);
  igual(semLista.api.modoDeAcesso_().allowlistVazia, true);

  const pronto = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  igual(pronto.api.modoDeAcesso_().google, { disponivel: true, clientId: CLIENT_ID });
});

teste('nem oferece o link quando ele não tem como virar e-mail', () => {
  // O mesmo cuidado, do outro lado: com a cota de envio esgotada a pessoa
  // digitaria o endereço, leria a frase gentil de sempre e esperaria uma
  // mensagem que não vem — e não haveria nada na tela explicando.
  //
  // Isto responde sobre o ESTADO DO SISTEMA, nunca sobre um endereço: a frase
  // única de `pedirLinkDeAcesso_` continua intacta, e nada aqui diz quem está na
  // lista. Ver `linkDeAcessoDisponivel_` (07b_LinkPorEmail.gs).
  const pronto = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  igual(pronto.api.modoDeAcesso_().linkDisponivel, true);

  const semCota = ambiente({ allowlist: 'coordenacao@exemplo.com', cota: 0 });
  igual(semCota.api.modoDeAcesso_().linkDisponivel, false, 'a tela prometeu um e-mail que não sai');

  const semLista = ambiente({ allowlist: '' });
  igual(semLista.api.modoDeAcesso_().linkDisponivel, false, 'não há para quem mandar');
});

teste('e a tela de login não gasta as vagas da hora só de ser aberta', () => {
  // `excedeuPedidosDeLink_` INCREMENTA o contador; `modoDeAcesso_` precisa
  // perguntar sem consumir. Se as duas fossem a mesma função, sessenta visitas
  // anônimas à tela — que é pública — fechariam a porta de recuperação sozinhas.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });

  for (let i = 0; i < 100; i++) amb.api.modoDeAcesso_();

  igual(amb.api.modoDeAcesso_().linkDisponivel, true, 'a tela se fechou sozinha');
  igual(amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com').ok, true);
  igual(destinatarios(amb), ['coordenacao@exemplo.com'],
    'olhar para a tela consumiu o teto da hora');
});

teste('o campo de texto de admin_emails não esvazia a lista pelas costas', () => {
  // Era a porta dos fundos das duas guardas de `removerAdmin_`: `salvarConfiguracao_`
  // gravava `admin_emails` em branco sem passar por elas. Achado da revisão de
  // segurança de 07/08 — hoje a chave vai para `regravarAllowlist_`.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  const token = amb.api.criarSessao_('coordenacao@exemplo.com');

  const r = amb.api.salvarConfiguracao_({ token: token, chave: 'admin_emails', valor: '' });
  igual(r.ok, false);
  amb.api.limparCacheConfig_();
  igual(amb.api.listarAdmins_({ token: token }).emails, ['coordenacao@exemplo.com']);
});

teste('sem client id, mas com a identidade chegando sozinha, a porta 1 entra', () => {
  // Faltar GOOGLE_CLIENT_ID derruba o `entrarComGoogle_`, mas NÃO derruba o
  // caminho 1: numa implantação Workspace com "Executar como: Usuário que
  // acessa" o login por conta funciona sem client id nenhum. É o cenário que o
  // projeto pode assumir quando mudar para a conta institucional.
  const amb = ambiente({ clientId: null, allowlist: 'outra@exemplo.com' });
  amb.api.Session = {
    getActiveUser: () => ({ getEmail: () => 'outra@exemplo.com' })
  };

  const r = amb.api.autenticar_();
  igual(r.ok, true, 'a identidade visível devia entrar sozinha: ' + r.erro);
  igual(r.via, 'email');
  igual(amb.api.modoDeAcesso_().identidadeVisivel, true, 'a tela precisa saber disso');
});

teste('sem client id e sem identidade visível, sobra o link por e-mail', () => {
  // Esta é a implantação real: USER_DEPLOYING com conta comum, onde
  // `usuarioAtual_()` volta 'anonimo' sempre. Sem client id o `entrarComGoogle_`
  // recusa antes de sair para a rede, e o caminho 1 nunca dispara — as duas
  // portas do 07_Auth.gs estão fechadas ao mesmo tempo, e é exatamente o dia
  // para o qual a segunda porta existe.
  const amb = ambiente({ clientId: null, allowlist: 'outra@exemplo.com' });

  igual(amb.api.modoDeAcesso_().google.disponivel, false);
  igual(amb.api.autenticar_().ok, false);

  igual(amb.api.pedirLinkDeAcesso_('outra@exemplo.com').ok, true);
  igual(destinatarios(amb), ['outra@exemplo.com'], 'a única porta que sobrava não abriu');
  igual(amb.api.entrarComLink_(tokenDoEmail(amb)).ok, true);
});

teste('uma enxurrada de tokens de mentira NÃO freia o link por e-mail', () => {
  // A rota do Google é anônima, e o teto dela é de 60 conferências por hora. Se
  // as recusas dela alimentassem o freio do link, meia dúzia de tokens de
  // mentira poriam em espera o único caminho de recuperação do sistema. Os dois
  // contadores são separados de propósito (07_Auth.gs, decisão 2).
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, { error: 'invalid_token' }, 400);

  for (let i = 0; i < 80; i++) amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO);

  igual(amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com').ok, true);
  igual(destinatarios(amb), ['coordenacao@exemplo.com'],
    'o link ficou na fila por tentativas que não eram dele');
});

// ================================================== O link por e-mail: pedir

grupo('pedirLinkDeAcesso — o pedido');

/** Ambiente com o relógio na mão do teste: os dois freios são feitos de tempo. */
function comRelogio(opcoes) {
  const relogio = criarRelogio(new Date('2026-08-11T09:00:00Z').getTime());
  const amb = ambiente(Object.assign(
    { relogio: relogio, allowlist: 'coordenacao@exemplo.com' }, opcoes || {}
  ));
  amb.relogio = relogio;
  return amb;
}

teste('endereço da allowlist recebe uma mensagem que não parece golpe', () => {
  // O e-mail sai da conta pessoal de quem implantou o projeto, com um código
  // enorme dentro: é a forma exata de um phishing. Ele precisa dizer de onde
  // veio, o que a pessoa acabou de fazer e o que fazer se ela não fez nada — e a
  // última linha é a única forma que o sistema tem de avisar que alguém está
  // tentando entrar.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });

  igual(amb.api.pedirLinkDeAcesso_('Coordenacao@Exemplo.com ').ok, true);
  igual(destinatarios(amb), ['coordenacao@exemplo.com'], 'a caixa do endereço decidiu algo');

  const mensagem = amb.correio.enviados[0];
  verdadeiro(/CESUTECH/.test(mensagem.subject), mensagem.subject);
  verdadeiro(mensagem.body.indexOf('15 minutos') !== -1, mensagem.body);
  verdadeiro(/N.O pediu/.test(mensagem.body),
    'quem recebe sem ter pedido precisa saber que não é para fazer nada — e para avisar');
});

teste('o link do e-mail aponta para o painel configurado, com o token na query', () => {
  // `url_painel` escolhe entre os endereços de PAINEIS_ACEITOS (07b_LinkPorEmail.gs);
  // o que se confere aqui é a forma: a chave sem a barra do fim vale o mesmo
  // endereço, e o token vai na query.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  amb.api.gravarConfig_('url_painel', 'https://cesutech.github.io/painel');

  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');

  const url = /(https?:\S+)/.exec(amb.correio.enviados[0].body)[1];
  igual(url, 'https://cesutech.github.io/painel/?entrar=' + tokenDoEmail(amb),
    'a barra que falta no fim da configuração não pode virar link quebrado');
});

/**
 * Endereços que `url_painel` pode ter no banco sem ter passado pela tela — o
 * console do Firestore, um backup restaurado, uma versão antiga do servidor — e
 * que não são o painel. Cada um é uma forma diferente de "quase": outro host, o
 * host certo como prefixo de outro, sem TLS, o caminho certo com sufixo.
 */
const PAINEIS_FALSOS = [
  'https://outro-host.exemplo/',
  'https://cesutech.github.io.outro-host.exemplo/painel/',
  'http://cesutech.github.io/painel/',
  'https://cesutech.github.io/painel/outra-coisa/',
  'https://cesutech.github.io/',
  '  https://outro-host.exemplo/painel  '
];

teste('url_painel fora da lista do código não vale: o link do e-mail sai com o padrão, e o console diz por quê', () => {
  // O link leva um código que vale uma sessão, num e-mail que o próprio sistema
  // assina. Com a chave apontando para outro lugar, o e-mail continuaria
  // verdadeiro e o código iria para quem estivesse do outro lado.
  //
  // Mutação que derruba: `urlDoPainel_` voltar a devolver o que estiver na chave
  // (com ou sem a barra), ou aceitar qualquer endereço que COMECE pelo do painel.
  PAINEIS_FALSOS.forEach((falso) => {
    const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
    const impresso = comConsoleCapturado(amb);
    amb.api.gravarConfig_('url_painel', falso);

    igual(amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com').ok, true, falso);

    const url = /(https?:\S+)/.exec(amb.correio.enviados[0].body)[1];
    igual(url, 'https://cesutech.github.io/painel/?entrar=' + tokenDoEmail(amb),
      'o link foi para o endereço da chave: ' + JSON.stringify(falso));
    verdadeiro(impresso.some((l) => /^ERRO /.test(l) && l.indexOf('url_painel') !== -1),
      'a chave foi ignorada em silêncio: ' + JSON.stringify(impresso));
  });
});

teste('o socorro do editor também: liberarAcesso imprime o endereço do código, e não o da chave', () => {
  // `liberarAcesso` cria uma sessão e imprime o endereço que a carrega. Ela roda
  // no editor, e o endereço é copiado de lá para o navegador — o mesmo risco do
  // e-mail, com uma sessão de oito horas em vez de um código de quinze minutos.
  //
  // Mutação que derruba: `liberarAcesso_` montar o endereço com a chave crua, ou
  // `urlDoPainel_` aceitar a chave fora da lista.
  const amb = ambiente({ allowlist: '' });
  const impresso = comConsoleCapturado(amb);
  amb.api.gravarConfig_('url_painel', 'https://outro-host.exemplo/painel/');

  const url = amb.api.liberarAcesso_('professor@unicesusc.edu.br');

  verdadeiro(url.indexOf('https://cesutech.github.io/painel/?sessao=') === 0, url);
  igual(impresso.join('\n').indexOf('outro-host.exemplo/painel/?'), -1,
    'o editor imprimiu um endereço com a sessão para outro host');
});

teste('o padrão de url_painel, a lista do código e o que o /exec anuncia são o mesmo endereço', () => {
  // São três lugares que dizem onde o painel mora: o padrão da chave
  // (CONFIG_PADRAO), a lista que a chave pode escolher (PAINEIS_ACEITOS) e o
  // endereço da resposta sem rota (ENDERECO_DO_PAINEL). Divergirem é o padrão da
  // chave ser recusado pela própria lista, ou o `/exec` mandar as pessoas para
  // um lugar de onde o link não sai.
  //
  // Mutação que derruba: trocar um dos três sem os outros dois.
  const amb = ambiente({ allowlist: '' });
  const padrao = amb.api.CONFIG_PADRAO.filter((c) => c.chave === 'url_painel')[0];
  verdadeiro(padrao, 'url_painel sumiu de CONFIG_PADRAO');

  igual(amb.api.PAINEIS_ACEITOS[0], amb.api.ENDERECO_DO_PAINEL);
  igual(padrao.valor, amb.api.PAINEIS_ACEITOS[0]);
  igual(amb.api.painelAceito_(padrao.valor), true, 'a lista recusa o padrão da própria chave');
  igual(amb.api.urlDoPainel_(), amb.api.PAINEIS_ACEITOS[0], 'chave vazia não deu o padrão');
});

teste('endereço de fora da allowlist não recebe nada — e não descobre nada', () => {
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });

  const r = amb.api.pedirLinkDeAcesso_('estranho@exemplo.com');

  igual(r.ok, true, 'a recusa apareceu na resposta — ver invasao.js, seção do oráculo');
  igual(destinatarios(amb), []);
});

teste('o que não tem forma de e-mail morre no primeiro passo, de graça', () => {
  // Filtro barato antes do caro, e ele é o que impede um laço de terminal de
  // encostar no teto global — que é o recurso a preservar para quem digitou um
  // endereço de verdade.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  amb.api.limparCacheConfig_();
  amb.falso.requisicoes.length = 0;

  ['', '   ', 'sem-arroba', 'a@b', 'a b@exemplo.com', null, undefined, 12345,
    'x'.repeat(250) + '@exemplo.com'].forEach((valor) => {
    igual(amb.api.pedirLinkDeAcesso_(valor).ok, true, JSON.stringify(valor));
  });

  igual(destinatarios(amb), []);
  igual(amb.falso.requisicoes.length, 0, 'lixo custou leitura do banco');
});

teste('cota de envio esgotada: nada sai, e o log diz por quê', () => {
  // A cota é do Google e não se recupera antes da meia-noite. Chegar ao fim dela
  // em silêncio é pior do que não enviar: o log é o que permite alguém entender,
  // no dia seguinte, por que o link "não chegou".
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com', cota: 0 });

  const r = amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');

  igual(r.ok, true, 'a frase única não pode mudar por causa da cota');
  igual(destinatarios(amb), []);

  const linha = linhasDoLog(amb).filter((l) => l.acao === 'LINK_SEM_COTA')[0];
  verdadeiro(linha !== undefined, 'a cota acabou em silêncio: ' + JSON.stringify(acoesDoLog(amb)));
  verdadeiro(/cota/.test(linha.detalhe), linha.detalhe);
});

// ================================================== O freio do link

/**
 * O freio do PIN era um contador ÚNICO para o sistema inteiro: cinco palpites
 * errados de qualquer pessoa da internet trancavam a coordenação por cinco
 * minutos. O freio daqui é por ENDEREÇO, e é essa a diferença que estes testes
 * guardam — junto com a que fica em `invasao.js`: esgotar o freio de um endereço
 * não encosta no de outro.
 */
grupo('o freio do link — por endereço, e silencioso');

teste('dois pedidos seguidos: o segundo não envia, e diz a mesma coisa', () => {
  // Existe contra o uso do sistema como ferramenta de incômodo: sem ele, um laço
  // de terminal enche a caixa do professor com links legítimos, assinados por
  // nós, até a cota diária acabar.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });

  const primeiro = amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
  const segundo = amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');

  igual(segundo, primeiro, 'o freio virou "calma lá" — quem lê é quem tem o acesso');
  igual(destinatarios(amb), ['coordenacao@exemplo.com'], 'o segundo pedido enviou');
});

teste('passados os dois minutos, o mesmo endereço recebe de novo', () => {
  // O freio adia; ele não fecha. Quem não recebeu confere o spam antes disso.
  const amb = comRelogio();

  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
  amb.relogio.avancar(2 * 60 * 1000 + 1);
  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');

  igual(destinatarios(amb).length, 2);
});

teste('o teto do dia para de enviar depois de oito', () => {
  // O intervalo limita a RAJADA; este limita o DIA. Os dois juntos mantêm o
  // consumo previsível abaixo das 100 mensagens diárias de uma conta Gmail
  // comum, que é a cota que o número existe para não estourar.
  const amb = comRelogio();

  for (let i = 0; i < 12; i++) {
    amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
    amb.relogio.avancar(3 * 60 * 1000);
  }

  igual(destinatarios(amb).length, 8, 'LINK_TETO_DIA deixou de valer');
});

teste('a contagem do dia vira à meia-noite, e não a cada 24 horas corridas', () => {
  // A chave carrega a data em São Paulo: virar o dia é ganhar um contador novo,
  // sem faxina nenhuma. Quem esgotou o teto às 23h50 não fica preso até as 23h50
  // do dia seguinte.
  const amb = comRelogio();

  for (let i = 0; i < 9; i++) {
    amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
    amb.relogio.avancar(3 * 60 * 1000);
  }
  igual(destinatarios(amb).length, 8);

  amb.relogio.avancar(24 * 60 * 60 * 1000);
  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
  igual(destinatarios(amb).length, 9, 'o dia virou e o contador não zerou');
});

teste('insistir no mesmo endereço não vira enxurrada de escrita', () => {
  // A recusa é a resposta do caminho que está sendo inundado: se cada uma
  // gravasse uma linha, o freio queimaria as 20 mil escritas do dia mais depressa
  // que o abuso. `registrarRecusa_` (04_Log.gs) agrupa por janela — uma escrita
  // por MOTIVO por dez minutos, independente do volume.
  //
  // É UM motivo só, e isso é resultado de desenho. Houve uma versão com dois:
  // o freio do endereço e um teto global por hora. O teto foi removido porque
  // ele fechava a porta para todo mundo — ver o teste "insistência de fora não
  // fecha a porta de dentro", em invasao.js. Sobrou o freio do endereço, que só
  // atrasa quem insiste.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');

  const antes = acoesDoLog(amb).length;
  for (let i = 0; i < 200; i++) amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');

  const novas = acoesDoLog(amb).slice(antes);
  igual(novas, ['LINK_FREIO'],
    'duzentos pedidos viraram ' + novas.length + ' escritas: ' + JSON.stringify(novas));
});

// ================================================== O link por e-mail: entrar

grupo('entrarComLink — o consumo');

teste('o token do e-mail entra, uma vez só', () => {
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
  const token = tokenDoEmail(amb);

  const primeira = amb.api.entrarComLink_(token);
  igual(primeira.ok, true, 'erro foi: ' + primeira.erro);
  igual(primeira.via, 'link');
  igual(primeira.usuario, 'coordenacao@exemplo.com');
  igual(amb.api.exigirAdmin_(primeira.token), true, 'a sessão do link não vale no painel');

  const segunda = amb.api.entrarComLink_(token);
  igual(segunda.ok, false, 'O MESMO LINK ENTROU DUAS VEZES');
  igual(segunda.token, undefined);
});

teste('o token é consumido mesmo quando a criação da sessão falha', () => {
  // Ele é apagado ANTES de a sessão nascer, e é essa ordem que garante que um
  // link que chegou ao fim não seja reusado nem no caminho de erro.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
  const token = tokenDoEmail(amb);

  amb.api.criarSessao_ = () => { throw new Error('PropertiesService fora do ar'); };
  igual(amb.api.entrarComLink_(token).ok, false);

  delete amb.api.criarSessao_;
  igual(amb.api.entrarComLink_(token).ok, false, 'o link sobreviveu à falha e continuou valendo');
});

teste('quinze minutos valem; dezesseis, não', () => {
  // A janela existe porque o token fica parado numa caixa de entrada, que é o
  // lugar por onde ele pode vazar — encaminhamento, um scanner corporativo, um
  // telefone destrancado em cima da mesa.
  const amb = comRelogio();

  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
  const dentroDoPrazo = tokenDoEmail(amb);
  amb.relogio.avancar(15 * 60 * 1000 - 1000);
  igual(amb.api.entrarComLink_(dentroDoPrazo).ok, true, 'venceu antes da hora');

  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
  const vencido = tokenDoEmail(amb);
  amb.relogio.avancar(15 * 60 * 1000 + 1000);
  igual(amb.api.entrarComLink_(vencido).ok, false, 'o link valeu depois dos 15 minutos');
});

teste('quem saiu da allowlist entre o pedido e o clique não entra', () => {
  // A allowlist é conferida DE NOVO na hora de entrar: o link pode ter sido
  // emitido para alguém que, nesses quinze minutos, saiu da coordenação — e quem
  // tirou o acesso espera que ele tenha saído no ato.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com, saindo@exemplo.com' });
  amb.api.pedirLinkDeAcesso_('saindo@exemplo.com');
  const token = tokenDoEmail(amb);

  const meuToken = amb.api.criarSessao_('coordenacao@exemplo.com');
  igual(amb.api.removerAdmin_({ token: meuToken, email: 'saindo@exemplo.com' }).ok, true);
  amb.api.limparCacheConfig_();

  igual(amb.api.entrarComLink_(token).ok, false, 'o acesso removido entrou pelo link antigo');

  const negado = linhasDoLog(amb).filter((l) => l.acao === 'LOGIN_NEGADO')[0];
  verdadeiro(negado !== undefined, 'a trilha precisa registrar o link que chegou tarde demais');
  igual(negado.entidade_id, 'saindo@exemplo.com');
});

teste('pedir um link novo invalida o anterior — um token vivo por endereço', () => {
  // Sem isto, cada pedido deixaria mais uma chave válida por quinze minutos, e a
  // janela de exposição cresceria com a impaciência de quem clicou duas vezes.
  const amb = comRelogio();

  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
  const primeiro = tokenDoEmail(amb);

  amb.relogio.avancar(3 * 60 * 1000);
  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');
  const segundo = tokenDoEmail(amb);

  verdadeiro(primeiro !== segundo, 'o segundo pedido reaproveitou o token do primeiro');
  igual(amb.api.entrarComLink_(primeiro).ok, false, 'o link antigo continuou valendo');
  igual(amb.api.entrarComLink_(segundo).ok, true);
});

teste('link vencido não fica ocupando lugar nas propriedades', () => {
  // São 500 KB no total, compartilhados com as sessões. Um link ocupa pouco, mas
  // "pouco" vezes um semestre de pedidos é como se enche um espaço que ninguém
  // está olhando.
  const amb = comRelogio({ allowlist: 'coordenacao@exemplo.com, outra@exemplo.com' });
  amb.api.pedirLinkDeAcesso_('coordenacao@exemplo.com');

  amb.relogio.avancar(16 * 60 * 1000);
  amb.api.pedirLinkDeAcesso_('outra@exemplo.com');

  const vivos = Array.from(amb.propriedades.keys()).filter((k) => k.indexOf('link_') === 0);
  igual(vivos.length, 1, 'a faxina não passou: ' + JSON.stringify(vivos));
});

// ================================================== O último recurso

grupo('liberarAcesso — o pior dia possível, com o editor do Apps Script na mão');

/** Captura o que a função imprime no console do editor, que é a saída dela. */
function comConsoleCapturado(amb) {
  const linhas = [];
  amb.api.console = {
    log: (m) => linhas.push(String(m)),
    error: (m) => linhas.push('ERRO ' + m)
  };
  return linhas;
}

teste('com a allowlist VAZIA, cria a sessão E repõe o e-mail na lista', () => {
  // Repor é o ponto: sem isso a sessão nasceria para alguém que as DUAS portas
  // remotas continuariam recusando — o botão do Google confere a lista, e o link
  // por e-mail só é enviado para quem está nela. O painel seguiria trancado por
  // fora no dia seguinte.
  const amb = ambiente({ allowlist: '' });
  comConsoleCapturado(amb);

  const url = amb.api.liberarAcesso_('  Professor@Unicesusc.edu.BR ');

  const token = /\?sessao=([0-9a-f]+)/.exec(url)[1];
  igual(amb.api.sessaoAtiva_(token).ok, true);
  igual(amb.api.emailDaSessao_(token), 'professor@unicesusc.edu.br');

  amb.api.limparCacheConfig_();
  igual(amb.api.adminEmails_(), ['professor@unicesusc.edu.br'],
    'a sessão nasceu e a lista continuou vazia — as duas portas seguem fechadas');
});

teste('e a partir daí as duas portas remotas voltam a funcionar', () => {
  // O critério de que o conserto consertou: não é a sessão, é o dia seguinte.
  const amb = ambiente({ allowlist: '' });
  comConsoleCapturado(amb);
  amb.api.liberarAcesso_('professor@unicesusc.edu.br');
  amb.api.limparCacheConfig_();

  igual(amb.api.pedirLinkDeAcesso_('professor@unicesusc.edu.br').ok, true);
  igual(destinatarios(amb), ['professor@unicesusc.edu.br']);

  responder(amb, tokenBom({ email: 'professor@unicesusc.edu.br' }));
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, true);
});

teste('quem já está na lista não vira uma segunda linha', () => {
  const amb = ambiente({ allowlist: 'professor@unicesusc.edu.br, outra@exemplo.com' });
  comConsoleCapturado(amb);

  amb.api.liberarAcesso_('Professor@Unicesusc.edu.br');

  amb.api.limparCacheConfig_();
  igual(amb.api.adminEmails_(), ['professor@unicesusc.edu.br', 'outra@exemplo.com']);
});

teste('a sessão criada à mão fica na trilha, com nome', () => {
  // Ela não concede nada que o acesso ao editor já não concedesse; o que ela faz
  // é tornar o caminho explícito, curto e REGISTRADO — em vez de deixar cada um
  // improvisar o seu com as propriedades do script na mão.
  const amb = ambiente({ allowlist: '' });
  comConsoleCapturado(amb);

  amb.api.liberarAcesso_('professor@unicesusc.edu.br');

  const linha = linhasDoLog(amb).filter((l) => l.acao === 'ACESSO_LIBERADO')[0];
  verdadeiro(linha !== undefined, 'nenhum rastro: ' + JSON.stringify(acoesDoLog(amb)));
  igual(linha.entidade_id, 'professor@unicesusc.edu.br');
  verdadeiro(/à mão pelo editor/.test(linha.detalhe), linha.detalhe);
});

teste('sem e-mail, ela lança dizendo como se usa', () => {
  // Ela roda no editor, onde não há tela para explicar nada: o erro é a
  // documentação.
  const amb = ambiente({ allowlist: '' });
  comConsoleCapturado(amb);

  ['', '   ', 'sem-arroba', null, undefined].forEach((valor) => {
    let erro = null;
    try {
      amb.api.liberarAcesso_(valor);
    } catch (e) {
      erro = e;
    }
    verdadeiro(erro !== null, 'passou com ' + JSON.stringify(valor));
    verdadeiro(/liberarAcesso\("/.test(erro.message), erro.message);
  });

  igual(amb.api.adminEmails_(), [], 'um erro de digitação entrou na lista de acesso');
});

teste('o endereço impresso é o do painel, e leva a sessão pronta', () => {
  const amb = ambiente({ allowlist: '' });
  const impresso = comConsoleCapturado(amb);
  amb.api.gravarConfig_('url_painel', 'https://cesutech.github.io/painel/');

  const url = amb.api.liberarAcesso_('professor@unicesusc.edu.br');

  verdadeiro(url.indexOf('https://cesutech.github.io/painel/?sessao=') === 0, url);
  verdadeiro(impresso.join('\n').indexOf(url) !== -1,
    'o editor não imprimiu o endereço: quem rodou não tem para onde ir');
});

// ================================================== Quem operou

grupo('a trilha diz QUEM fez — o operador sai da sessão, não da implantação');

teste('exigirAdmin anota quem passou, e a linha seguinte é assinada por ele', () => {
  // A pergunta que a coluna "Quem" existe para responder é "qual pessoa
  // exportou a base?", e no painel publicado ela respondia 'anonimo': o web app
  // roda como a conta que implantou e `Session.getActiveUser()` volta vazio. A
  // sessão sabe o e-mail, e `exigirAdmin_` é a única linha por onde toda função
  // do painel passa com o token na mão.
  //
  // Mutação que derruba: tirar `anotarOperador_(emailDaSessao_(token))` da
  // guarda — a linha volta a 'anonimo', e o Histórico deixa de distinguir as
  // oito pessoas que entram no painel.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  const token = amb.api.criarSessao_('coordenacao@exemplo.com');
  igual(amb.api.usuarioAtual_(), 'anonimo', 'o cenário devia ser o do GitHub Pages');

  igual(amb.api.exigirAdmin_(token), true);
  amb.api.registrar_('EXPORTACAO', 'alunos', '', '300 linhas');

  igual(linhasDoLog(amb).filter((l) => l.acao === 'EXPORTACAO')[0].usuario,
    'coordenacao@exemplo.com');
});

teste('token recusado APAGA o operador — a recusa não herda o nome de quem passou antes', () => {
  // A variável é global ao script. Numa execução que chame a guarda duas vezes
  // — e uma requisição do painel pode chamá-la de novo por dentro, como
  // `aplicarRevisao_` faz com `anularInscricoes_` —, a segunda, recusada,
  // sairia assinada pela primeira: a trilha atribuiria a uma pessoa uma ação
  // que o servidor não deixou acontecer.
  //
  // Mutação que derruba: `exigirAdmin_` anotar só no caminho feliz, deixando o
  // nome anterior de pé.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });

  amb.api.exigirAdmin_(amb.api.criarSessao_('coordenacao@exemplo.com'));
  lancou(() => amb.api.exigirAdmin_('inventado'), 'Sess');

  amb.api.registrar_('BLOQUEIO', 'inscricao', '', 'honeypot preenchido');
  igual(linhasDoLog(amb).filter((l) => l.acao === 'BLOQUEIO')[0].usuario, 'anonimo');
});

// ================================================== Quem tem acesso

grupo('gestão de quem tem acesso ao painel');

function comSessao(opcoes) {
  const amb = ambiente(opcoes);
  amb.token = amb.api.criarSessao_((opcoes && opcoes.eu) || 'coordenacao@exemplo.com');
  return amb;
}

teste('as três exigem token, e recusam antes de mexer em qualquer coisa', () => {
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });

  [
    ['listarAdmins_', {}],
    ['incluirAdmin_', { email: 'novo@exemplo.com' }],
    ['removerAdmin_', { email: 'coordenacao@exemplo.com' }]
  ].forEach(([fn, payload]) => {
    const r = amb.api[fn](payload);
    igual(r.ok, false, fn + ' respondeu sem token');
    verdadeiro(/Sess.o expirada/.test(r.erro), fn + ': ' + r.erro);
  });

  igual(amb.api.config_('admin_emails'), 'coordenacao@exemplo.com', 'a lista foi mexida sem token');
});

teste('listar devolve a lista normalizada e diz quem é você', () => {
  const amb = comSessao({ allowlist: ' Coordenacao@Exemplo.com , OUTRA@exemplo.com ,, ' });
  const r = amb.api.listarAdmins_({ token: amb.token });

  igual(r.ok, true);
  igual(r.emails, ['coordenacao@exemplo.com', 'outra@exemplo.com']);
  igual(r.voce, 'coordenacao@exemplo.com');
});

teste('sessão sem identidade: "você" é ninguém, e não "anonimo"', () => {
  // Nenhuma porta cria sessão assim desde que o PIN saiu — as três nascem de um
  // e-mail conhecido. A conversão continua porque `criarSessao_` ACEITA o valor,
  // e guarda não se apoia em quem a chama: 'anonimo' não é e-mail e nunca vai
  // casar com a allowlist, então "quem está logado" e "que e-mail está logado"
  // precisam ser perguntas com respostas diferentes.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  const token = amb.api.criarSessao_('');

  igual(amb.api.sessaoAtiva_(token).ok, true);
  igual(amb.api.listarAdmins_({ token: token }).voce, '');
});

teste('incluir normaliza, grava e registra quem mexeu', () => {
  // Mutação que derruba: `exigirAdmin_` deixar de anotar o operador (a coluna
  // volta a 'anonimo', que é o que `usuarioAtual_()` responde no painel
  // publicado — e este ambiente é o publicado: `usuario: ''`); ou o detalhe
  // voltar a repetir o e-mail que a coluna já diz.
  const amb = comSessao({ allowlist: 'coordenacao@exemplo.com' });
  igual(amb.api.usuarioAtual_(), 'anonimo', 'o cenário devia ser o do GitHub Pages');

  const r = amb.api.incluirAdmin_({ token: amb.token, email: '  Nova.Pessoa@Exemplo.COM ' });

  igual(r.ok, true);
  igual(r.emails, ['coordenacao@exemplo.com', 'nova.pessoa@exemplo.com']);

  amb.api.limparCacheConfig_();
  igual(amb.api.config_('admin_emails'), 'coordenacao@exemplo.com, nova.pessoa@exemplo.com');

  const linha = linhasDoLog(amb).filter((l) => l.acao === 'ADMIN_INCLUIDO')[0];
  igual(linha.entidade_id, 'nova.pessoa@exemplo.com');
  igual(linha.usuario, 'coordenacao@exemplo.com', 'a trilha não diz quem incluiu');
  // O detalhe diz POR ONDE, e não repete o nome: a mesma inclusão feita pelo
  // campo de texto da aba Configurações grava 'pelo campo admin_emails'.
  igual(linha.detalhe, 'pela tela Quem tem acesso');
  igual(linha.detalhe.indexOf('coordenacao@exemplo.com'), -1,
    'o e-mail do operador está escrito duas vezes na mesma linha: ' + linha.detalhe);
});

teste('incluir a mesma conta com outra caixa não cria uma segunda linha', () => {
  const amb = comSessao({ allowlist: 'coordenacao@exemplo.com' });
  const r = amb.api.incluirAdmin_({ token: amb.token, email: 'COORDENACAO@exemplo.com' });

  igual(r.ok, true);
  igual(r.jaEstava, true);
  igual(r.emails.length, 1);
});

teste('e-mail que não é e-mail é recusado', () => {
  const amb = comSessao({ allowlist: 'coordenacao@exemplo.com' });

  ['', 'sem-arroba', 'a@b', 'a@ b.com', undefined].forEach((v) => {
    igual(amb.api.incluirAdmin_({ token: amb.token, email: v }).ok, false, JSON.stringify(v));
  });
  igual(amb.api.listarAdmins_({ token: amb.token }).emails.length, 1);
});

teste('remover quem não está na lista é recusado, e não é silêncio', () => {
  const amb = comSessao({ allowlist: 'coordenacao@exemplo.com' });
  const r = amb.api.removerAdmin_({ token: amb.token, email: 'ninguem@exemplo.com' });

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('não está na lista') !== -1, r.erro);
});

teste('ninguém sai da lista sendo o último — a chave por dentro', () => {
  const amb = comSessao({ allowlist: 'coordenacao@exemplo.com' });
  const r = amb.api.removerAdmin_({ token: amb.token, email: 'coordenacao@exemplo.com' });

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('único') !== -1, r.erro);
  igual(amb.api.listarAdmins_({ token: amb.token }).emails, ['coordenacao@exemplo.com']);
});

teste('com outra pessoa na lista, sair de si mesmo é permitido', () => {
  // A guarda é contra ESVAZIAR, não contra sair. Quem passou o painel adiante
  // tem o direito de deixar de ser administrador.
  const amb = comSessao({ allowlist: 'coordenacao@exemplo.com, outra@exemplo.com' });
  const r = amb.api.removerAdmin_({ token: amb.token, email: 'coordenacao@exemplo.com' });

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.emails, ['outra@exemplo.com']);
});

teste('a lista NUNCA fica vazia, e a guarda não depende de configuração nenhuma', () => {
  // Antes ela só valia com `modo_acesso_painel` = GOOGLE, e essa chave deixou de
  // existir. Hoje a allowlist é a fonte única das DUAS portas remotas: o botão do
  // Google confere contra ela, e o link por e-mail só é enviado para quem está
  // nela. Lista vazia é painel sem porta nenhuma, com o conserto no editor.
  const amb = ambiente({ allowlist: 'outra@exemplo.com' });
  const token = amb.api.criarSessao_('coordenacao@exemplo.com');

  const r = amb.api.removerAdmin_({ token: token, email: 'outra@exemplo.com' });

  igual(r.ok, false);
  verdadeiro(/link por e-mail/.test(r.erro),
    'a recusa precisa explicar que as duas portas dependem da lista: ' + r.erro);
  igual(amb.api.listarAdmins_({ token: token }).emails, ['outra@exemplo.com']);
});

teste('e regravarAllowlist_ recusa o mesmo, pelo campo de texto', () => {
  // O mesmo gesto por outro caminho. Testado direto porque é a função que
  // `salvarConfiguracao_` chama, e é nela que a guarda mora.
  const amb = ambiente({ allowlist: 'outra@exemplo.com' });
  const token = amb.api.criarSessao_('coordenacao@exemplo.com');

  const r = amb.api.regravarAllowlist_('  ,  , ', token);

  igual(r.ok, false);
  verdadeiro(/Esvaziar a lista/.test(r.erro), r.erro);
  amb.api.limparCacheConfig_();
  igual(amb.api.adminEmails_(), ['outra@exemplo.com']);
});

teste('e-mail inválido recusa o campo inteiro, em vez de sumir em silêncio', () => {
  // Quem digitou `fulano@exemplo` e viu "salvo" acha que deu acesso a alguém.
  const amb = ambiente({ allowlist: 'outra@exemplo.com' });
  const token = amb.api.criarSessao_('outra@exemplo.com');

  const r = amb.api.regravarAllowlist_('outra@exemplo.com, fulano@exemplo', token);

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('fulano@exemplo') !== -1, r.erro);
  amb.api.limparCacheConfig_();
  igual(amb.api.adminEmails_(), ['outra@exemplo.com'], 'gravou metade do campo');
});

teste('quem sai da lista perde a sessão na hora', () => {
  // Tirar da lista e deixar entrar é não ter tirado: a sessão vale oito horas, e
  // nelas a pessoa removida ainda exportaria o cadastro inteiro.
  const amb = comSessao({ allowlist: 'coordenacao@exemplo.com, saindo@exemplo.com' });
  const dela = amb.api.criarSessao_('Saindo@Exemplo.com');
  igual(amb.api.sessaoAtiva_(dela).ok, true);

  igual(amb.api.removerAdmin_({ token: amb.token, email: 'saindo@exemplo.com' }).ok, true);

  igual(amb.api.sessaoAtiva_(dela).ok, false);
  igual(amb.api.sessaoAtiva_(amb.token).ok, true, 'a sessão de quem removeu continua valendo');
});

teste('a conta removida não entra mais pelo Google', () => {
  const amb = comSessao({ allowlist: 'coordenacao@exemplo.com, saindo@exemplo.com' });
  responder(amb, tokenBom({ email: 'saindo@exemplo.com' }));

  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, true);
  amb.api.removerAdmin_({ token: amb.token, email: 'saindo@exemplo.com' });
  amb.api.limparCacheConfig_();
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false);
});

// ============================ A lista de acesso só guarda e só devolve e-mail

/**
 * Itens que a lista de acesso pode ter no banco sem ter passado pelas telas — o
 * console do Firestore, uma versão antiga do servidor, um backup restaurado. Têm
 * todos um `@` e um domínio, e passariam na forma do formulário do aluno
 * (`emailValido_`); nenhum tem a forma de um e-mail de acesso.
 */
const ITENS_SEM_FORMA = ["x');sinal();('@exemplo.com", "aspa'simples@exemplo.com", 'aspas"duplas@exemplo.com',
  'nome(teste)@exemplo.com', 'a;b@exemplo.com', 'barra\\invertida@exemplo.com', 'barra/normal@exemplo.com',
  'menor<maior@exemplo.com'];

teste('a forma de e-mail de acesso: o que passa e o que não passa', () => {
  // Mutação que derruba: `emailDeAcessoValido_` voltar a ser `emailValido_`, ou
  // aceitar aspa, parêntese, ponto e vírgula, barra ou `<` antes do `@`.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });

  ['coordenacao@exemplo.com', 'nome.sobrenome@unicesusc.edu.br', 'a+b@exemplo.com',
    ' Nome_Sobre-Nome@Sub.Exemplo.COM '].forEach((v) => {
    igual(amb.api.emailDeAcessoValido_(v), true, JSON.stringify(v));
  });
  ITENS_SEM_FORMA.concat(['', 'sem-arroba', 'a@b', 'a b@exemplo.com', 'a@exemplo..com',
    'a@exemplo.com/', '@exemplo.com', null, undefined]).forEach((v) => {
    igual(amb.api.emailDeAcessoValido_(v), false, JSON.stringify(v));
  });
});

teste('item sem forma de e-mail no banco fica de fora: não entra, não recebe link, não vai para a tabela', () => {
  // A tabela de quem tem acesso põe cada e-mail dentro de botões do painel. O
  // servidor não manda para lá o que não é e-mail — e a mesma lista é a que
  // decide quem entra e para quem sai link, então o item não vale em lugar
  // nenhum.
  //
  // O item continua na lista de gerais, porque ela é cruzada com o que está
  // escrito e não com a lista filtrada: é o que impede o filtro de esvaziá-la e
  // abrir o piso (o grupo logo abaixo). Lá ele não vale para ninguém — não tem
  // nível nenhum.
  //
  // Mutação que derruba: tirar o filtro da forma de `adminEmails_`; ou
  // `nivelEm_` perguntar a lista de gerais antes da allowlist.
  const amb = comSessao({ allowlist: ['coordenacao@exemplo.com'].concat(ITENS_SEM_FORMA).join(', ') });
  amb.api.gravarConfig_('coordenadores_gerais', 'coordenacao@exemplo.com, ' + ITENS_SEM_FORMA[0]);

  igual(amb.api.adminEmails_(), ['coordenacao@exemplo.com']);
  igual(amb.api.coordenadoresGerais_(), ['coordenacao@exemplo.com', ITENS_SEM_FORMA[0]]);
  igual(amb.api.nivelDe_(ITENS_SEM_FORMA[0]), '', 'o item sem forma ganhou nível');
  igual(amb.api.nivelDe_('coordenacao@exemplo.com'), 'coordenador');

  const r = amb.api.listarAdmins_({ token: amb.token });
  igual(r.emails, ['coordenacao@exemplo.com']);
  igual(r.pessoas.map((p) => p.email), ['coordenacao@exemplo.com']);

  ITENS_SEM_FORMA.forEach((item) => {
    igual(amb.api.emailAutorizado_(item), false, item);
    igual(amb.api.pedirLinkDeAcesso_(item).ok, true, 'a frase única mudou para ' + item);
  });
  igual(destinatarios(amb), [], 'saiu link para um item que não é e-mail');
});

teste('a gravação seguinte tira o item do banco, e a trilha diz', () => {
  // A linha ADMIN_DESCARTADO é o que impede o sumiço de ser mudo: fora dela, só
  // os backups guardam o que estava ali. A sessão do item cai junto (o teste de
  // baixo).
  //
  // Mutação que derruba: tirar o `registrar_('ADMIN_DESCARTADO', ...)` de
  // `aplicarAcessos_`, ou tirar o filtro de `listaDeEmails_` e deixar a gravação
  // reescrever o item.
  const amb = comSessao({ allowlist: 'coordenacao@exemplo.com, ' + ITENS_SEM_FORMA[0] });

  igual(amb.api.incluirAdmin_({ token: amb.token, email: 'nova@exemplo.com' }).ok, true);

  amb.api.limparCacheConfig_();
  igual(amb.api.config_('admin_emails'), 'coordenacao@exemplo.com, nova@exemplo.com');
  const linha = linhasDoLog(amb).filter((l) => l.acao === 'ADMIN_DESCARTADO')[0];
  verdadeiro(linha !== undefined, 'o item saiu do banco sem rastro: ' + JSON.stringify(acoesDoLog(amb)));
  igual(linha.entidade_id, ITENS_SEM_FORMA[0]);
  igual(linhasDoLog(amb).filter((l) => l.acao === 'ADMIN_REMOVIDO').length, 0,
    'o item não estava na lista que vale — não há o que "remover"');
});

teste('a sessão do item sem forma cai na gravação que o tira do banco — pelos quatro caminhos', () => {
  // As portas de hoje não abrem sessão para o item, mas a sessão mora nas
  // propriedades do projeto e atravessa a troca de versão: a que uma versão
  // anterior do servidor abriu continua lá. Aqui ela nasce por `criarSessao_`,
  // como nasceria lá. Sem cair junto com o item, ela seguia valendo — no piso,
  // como coordenadora —, e nenhum gesto de tela a alcança: `removerAdmin_` não
  // acha o item na lista que vale.
  //
  // Mutação que derruba: tirar o `invalidarSessoesDe_(item)` do laço dos
  // descartados de `aplicarAcessos_`.
  const ITEM = "nome.d'exemplo@exemplo.edu.br";
  const DONO = 'nome.sobrenome@exemplo.edu.br';
  const GESTOS = [
    ['o campo admin_emails, sem ninguém entrando',
      (amb) => amb.api.salvarConfiguracao_({ token: amb.token, chave: 'admin_emails', valor: 'coordenacao@exemplo.com' })],
    ['o campo admin_emails, com gente entrando',
      (amb) => amb.api.salvarConfiguracao_({ token: amb.token, chave: 'admin_emails',
        valor: 'coordenacao@exemplo.com, nova@exemplo.com' })],
    ['incluir pela tela', (amb) => amb.api.incluirAdmin_({ token: amb.token, email: 'nova@exemplo.com' })],
    ['o socorro do editor', (amb) => ({ ok: /\?sessao=/.test(amb.api.liberarAcesso_(DONO)) })]
  ];

  GESTOS.forEach(([gesto, fazer]) => {
    const amb = comSessao({ allowlist: 'coordenacao@exemplo.com, ' + ITEM });
    comConsoleCapturado(amb);
    const sessaoDoItem = amb.api.criarSessao_(ITEM);
    igual(amb.api.removerAdmin_({ token: amb.token, email: ITEM }).erro, 'Esse e-mail não está na lista de acesso.',
      gesto + ': o cenário precisa de um item que a tabela não alcança');
    igual(amb.api.sessaoAtiva_(sessaoDoItem), { ok: true, nivel: 'coordenador' },
      gesto + ': antes da gravação, a sessão vale — no piso, como coordenadora');

    igual(fazer(amb).ok, true, gesto + ': a gravação não aconteceu');

    igual(linhasDoLog(amb).filter((l) => l.acao === 'ADMIN_DESCARTADO').map((l) => l.entidade_id), [ITEM],
      gesto + ': o item não saiu do banco');
    igual(post(amb, { acao: 'painel', fn: 'listarAdmins', token: sessaoDoItem, dados: {} }),
      { ok: false, erro: amb.api.RECUSA_SESSAO }, gesto + ': a sessão do item descartado continuou valendo');
    igual(amb.api.sessaoAtiva_(sessaoDoItem), { ok: false }, gesto);
    igual(amb.api.sessaoAtiva_(amb.token).ok, true, gesto + ': caiu também a sessão de quem gravou');
  });
});

teste('as portas de escrita recusam o que a leitura jogaria fora', () => {
  // Uma porta que aceitasse e uma leitura que descartasse dariam a pior das
  // respostas: "incluído" na tela, e a pessoa de fora de tudo.
  //
  // Mutação que derruba: `incluirAdmin_`, `regravarAllowlist_` ou
  // `liberarAcesso_` voltarem à forma do formulário do aluno.
  const amb = comSessao({ allowlist: 'coordenacao@exemplo.com' });
  comConsoleCapturado(amb);

  ITENS_SEM_FORMA.forEach((item) => {
    igual(amb.api.incluirAdmin_({ token: amb.token, email: item }).ok, false, 'incluirAdmin_ ' + item);

    const r = amb.api.regravarAllowlist_('coordenacao@exemplo.com, ' + item, amb.token);
    igual(r.ok, false, 'regravarAllowlist_ ' + item);
    verdadeiro(/Não parece e-mail/.test(r.erro), r.erro);

    let erro = null;
    try { amb.api.liberarAcesso_(item); } catch (e) { erro = e; }
    verdadeiro(erro !== null, 'liberarAcesso_ aceitou ' + item);
  });

  amb.api.limparCacheConfig_();
  igual(amb.api.config_('admin_emails'), 'coordenacao@exemplo.com', 'alguma porta gravou');

  // E a rede do escritor único: um quinto caminho que mandasse o item direto a
  // `aplicarAcessos_`, sem a recusa com frase, também não o grava.
  igual(amb.api.aplicarAcessos_(['coordenacao@exemplo.com', 'nova@exemplo.com'].concat(ITENS_SEM_FORMA), [],
    'por um caminho de teste', true).ok, true);
  amb.api.limparCacheConfig_();
  igual(amb.api.config_('admin_emails'), 'coordenacao@exemplo.com, nova@exemplo.com',
    'aplicarAcessos_ gravou o que a leitura jogaria fora');
});

teste('o setup relata a lista que vale — a da tela de login —, e cita à parte o que não tem forma', () => {
  // Com só itens sem forma, ninguém entra, e é justamente o dia em que o
  // relatório do editor tem de mandar rodar liberarAcesso. Lendo o texto cru, ele
  // dizia que havia gente com acesso, e a tela de login dizia que não.
  //
  // Mutação que derruba: o setup voltar a ler o texto cru de `admin_emails`, ou
  // deixar de citar os itens sem forma.
  const ITEM = ITENS_SEM_FORMA[1];
  [
    { cru: ITEM, vazia: true, quem: 'quem tem acesso: VAZIO' },
    { cru: 'coordenacao@exemplo.com, ' + ITEM, vazia: false, quem: 'quem tem acesso: coordenacao@exemplo.com' }
  ].forEach((caso) => {
    const amb = ambiente({ allowlist: caso.cru });
    amb.api.limparCacheConfig_();

    const r = amb.api.setup_();

    const relatorio = amb.registros.logger;
    const linhaDeQuem = relatorio.filter((l) => l.indexOf('quem tem acesso:') === 0);
    igual(r.allowlistVazia, caso.vazia, caso.cru);
    igual(r.allowlistVazia, amb.api.modoDeAcesso_().allowlistVazia, caso.cru + ': o setup e a tela de login discordam');
    igual(linhaDeQuem.length, 1, caso.cru + ': ' + JSON.stringify(relatorio));
    igual(linhaDeQuem[0].indexOf(caso.quem), 0, caso.cru + ': ' + linhaDeQuem[0]);
    igual(linhaDeQuem[0].indexOf(ITEM), -1, caso.cru + ': o item sem forma apareceu entre quem tem acesso');
    if (caso.vazia) verdadeiro(/liberarAcesso\(/.test(linhaDeQuem[0]), 'sem a saída: ' + linhaDeQuem[0]);
    igual(relatorio.filter((l) => l === 'na lista de acesso, sem forma de e-mail (não entram): ' + ITEM).length, 1,
      caso.cru + ': o item sem forma não foi citado à parte: ' + JSON.stringify(relatorio));
  });
});

// ================== O geral sem forma não abre o piso dos coordenadores

/**
 * O banco que o filtro da forma não pode transformar em "todo mundo é
 * coordenador": o ÚNICO coordenador geral tem apóstrofo no e-mail — o Google
 * Workspace aceita, a forma de e-mail de acesso não —, e os outros dois da lista
 * são professores. O geral deixa de entrar, e é só isso que muda: se a lista de
 * gerais voltasse vazia por causa do filtro, o piso (`nivelEm_`) faria dos dois
 * professores coordenadores, e o primeiro gesto de acesso gravaria a promoção.
 */
const GERAL_COM_APOSTROFO = "coord.d'exemplo@exemplo.edu.br";
const PROF_UM = 'professor.um@exemplo.edu.br';
const PROF_DOIS = 'professor.dois@exemplo.edu.br';
const DONO_DO_PROJETO = 'nome.sobrenome@exemplo.edu.br';

function comGeralSemForma() {
  const amb = ambiente({ allowlist: [GERAL_COM_APOSTROFO, PROF_UM, PROF_DOIS].join(', ') });
  amb.api.gravarConfig_('coordenadores_gerais', GERAL_COM_APOSTROFO);
  amb.api.limparCacheConfig_();
  return amb;
}

/** As duas chaves de acesso como estão no banco, sem o cache da execução no meio. */
function chavesDeAcesso(amb) {
  amb.api.limparCacheConfig_();
  return {
    admin_emails: amb.api.config_('admin_emails'),
    coordenadores_gerais: amb.api.config_('coordenadores_gerais')
  };
}

teste('o único geral com e-mail sem forma não faz dos professores coordenadores — e o POST os recusa por nível', () => {
  // Mutação que derruba: `coordenadoresGerais_` cruzar com `adminEmails_` (a
  // lista já filtrada) em vez de `itensDaAllowlist_`.
  const amb = comGeralSemForma();
  igual(amb.api.emailDeAcessoValido_(GERAL_COM_APOSTROFO), false, 'o cenário precisa de um geral que o filtro descarta');
  igual(amb.api.emailValido_(GERAL_COM_APOSTROFO), true, 'e que a forma de antes aceitava');

  igual(amb.api.nivelDe_(PROF_UM), 'professor');
  igual(amb.api.nivelDe_(PROF_DOIS), 'professor');

  const token = amb.api.criarSessao_(PROF_UM);
  igual(amb.api.sessaoAtiva_(token), { ok: true, nivel: 'professor' });

  const r = post(amb, { acao: 'painel', fn: 'listarAdmins', token: token, dados: {} });
  igual(r.ok, false, 'o professor listou quem tem acesso: ' + JSON.stringify(r));
  igual(r.motivo, 'NIVEL');
  igual(r.nivel, 'professor');
});

teste('nesse banco, o socorro do dono pelo editor deixa um coordenador — ele —, e os professores seguem professores', () => {
  // `liberarAcesso_` repõe o dono como geral quando a lista de gerais existe
  // (`faltaNoNivel`). Com a lista cruzada pela forma, ela voltava vazia: o dono
  // entrava pelo piso, os dois professores junto, e a gravação deixava a chave
  // de gerais vazia no banco.
  //
  // Mutação que derruba: `coordenadoresGerais_` cruzar com a lista filtrada.
  const amb = comGeralSemForma();
  comConsoleCapturado(amb);

  const url = amb.api.liberarAcesso_(DONO_DO_PROJETO);
  const token = /\?sessao=([0-9a-f]+)/.exec(url)[1];

  igual(chavesDeAcesso(amb), {
    admin_emails: [PROF_UM, PROF_DOIS, DONO_DO_PROJETO].join(', '),
    coordenadores_gerais: DONO_DO_PROJETO
  });
  igual(amb.api.nivelDe_(DONO_DO_PROJETO), 'coordenador');
  igual(amb.api.listarAdmins_({ token: token }).pessoas, [
    { email: PROF_UM, nivel: 'professor' },
    { email: PROF_DOIS, nivel: 'professor' },
    { email: DONO_DO_PROJETO, nivel: 'coordenador' }
  ]);
});

teste('nesse banco, nenhum gesto de acesso grava professor como geral — nem com a cobrança do nível fora do caminho', () => {
  // A primeira barreira é o nível: incluir, rebaixar, remover e o campo de
  // texto são da coordenação, e o professor é recusado neles (o ataque pelo POST
  // está em invasao.js). Aqui a cobrança sai do caminho de propósito, para
  // provar a segunda: a materialização congela o geral que está escrito, e não
  // a lista inteira, e a guarda do último coordenador recusa a gravação que
  // deixaria o banco sem nenhum geral que valha.
  //
  // Mutação que derruba: `coordenadoresGerais_` cruzar com a lista filtrada
  // (`materializar_` volta a congelar os professores); ou `aplicarAcessos_`
  // tomar o "antes" dos gerais pela lista filtrada (o piso passa pela guarda).
  const amb = comGeralSemForma();
  const token = amb.api.criarSessao_(PROF_UM);
  amb.api.exigirCoordenador_ = (t) => amb.api.exigirAdmin_(t);
  const antes = chavesDeAcesso(amb);
  const NOVO = 'novo.professor@exemplo.edu.br';

  [
    ['incluirAdmin_', () => amb.api.incluirAdmin_({ token: token, email: NOVO })],
    ['definirNivel_', () => amb.api.definirNivel_({ token: token, email: PROF_DOIS, nivel: 'professor' })],
    ['regravarAllowlist_', () => amb.api.regravarAllowlist_([PROF_UM, PROF_DOIS, NOVO].join(', '), token)],
    ['removerAdmin_', () => amb.api.removerAdmin_({ token: token, email: PROF_DOIS })]
  ].forEach(([nome, gesto]) => {
    const r = gesto();
    igual(r.ok, false, nome + ' gravou: ' + JSON.stringify(r));
    verdadeiro(/coordenador geral/.test(r.erro), nome + ' recusou por outro motivo: ' + r.erro);
    igual(chavesDeAcesso(amb), antes, nome + ' mexeu nas listas de acesso');
  });

  igual(amb.api.nivelDe_(PROF_UM), 'professor');
  igual(amb.api.nivelDe_(PROF_DOIS), 'professor');
});

teste('nesse banco, o geral sem forma não entra, e a próxima gravação o tira das duas chaves com ADMIN_DESCARTADO', () => {
  // O mesmo de todo item sem forma (o bloco de cima): não entra por porta
  // nenhuma, e sai do banco na primeira gravação que der certo — aqui a do
  // socorro do dono, a única possível num banco sem geral que entre.
  //
  // Mutação que derruba: tirar o filtro de `adminEmails_` (ele entraria), ou a
  // linha ADMIN_DESCARTADO de `aplicarAcessos_`.
  const amb = comGeralSemForma();
  comConsoleCapturado(amb);

  igual(amb.api.emailAutorizado_(GERAL_COM_APOSTROFO), false);
  responder(amb, tokenBom({ email: GERAL_COM_APOSTROFO }));
  igual(amb.api.entrarComGoogle_(TOKEN_BEM_FORMADO).ok, false, 'o geral sem forma entrou pelo Google');
  igual(amb.api.pedirLinkDeAcesso_(GERAL_COM_APOSTROFO).ok, true, 'a frase única mudou');
  igual(destinatarios(amb), [], 'saiu link para o geral sem forma');

  amb.api.liberarAcesso_(DONO_DO_PROJETO);

  const chaves = chavesDeAcesso(amb);
  igual(chaves.admin_emails.indexOf(GERAL_COM_APOSTROFO), -1, 'ficou em admin_emails: ' + chaves.admin_emails);
  igual(chaves.coordenadores_gerais.indexOf(GERAL_COM_APOSTROFO), -1,
    'ficou em coordenadores_gerais: ' + chaves.coordenadores_gerais);
  igual(linhasDoLog(amb).filter((l) => l.acao === 'ADMIN_DESCARTADO').map((l) => l.entidade_id),
    [GERAL_COM_APOSTROFO]);
});

teste('com as listas bem formadas, o nível de cada um é o de sempre — o piso só nasce do banco', () => {
  // A regra de sempre, escrita aqui como oráculo: os gerais cruzados com a
  // lista de acesso, a lista de gerais vazia é o piso, e quem não está na lista
  // não é nada. Com tudo bem formado, cruzar com o que está escrito ou com a
  // lista filtrada dá no mesmo — e a ordem das perguntas de `nivelEm_` também.
  //
  // Mutação que derruba: `coordenadoresGerais_` sem o cruzamento (um geral fora
  // da lista fecharia o piso); `nivelEm_` sem o piso.
  const A = 'nome.um@exemplo.edu.br';
  const B = 'nome.dois@exemplo.edu.br';
  const C = 'nome.tres@exemplo.edu.br';
  const FORA = 'nome.fora@exemplo.edu.br';
  const BANCOS = [
    { admin: [A, B, C].join(', '), gerais: '' },
    { admin: [A, B, C].join(', '), gerais: A },
    { admin: [A, B, C].join(', '), gerais: [A, C].join(', ') },
    { admin: [A, B].join(', '), gerais: FORA },
    { admin: [A, B].join(', '), gerais: [FORA, B].join(', ') },
    { admin: ' ' + A.toUpperCase() + ' ,, ' + B, gerais: ' ' + A + ' , ' + A },
    { admin: '', gerais: A }
  ];

  function nivelDeSempre(api, email, banco) {
    const lista = banco.admin.split(',').map((e) => api.normalizarEmail_(e)).filter(Boolean);
    const chefes = banco.gerais.split(',').map((e) => api.normalizarEmail_(e))
      .filter((e) => e && lista.indexOf(e) !== -1);
    const alvo = api.normalizarEmail_(email);
    if (!alvo) return '';
    if (!chefes.length) return 'coordenador';
    if (chefes.indexOf(alvo) !== -1) return 'coordenador';
    return lista.indexOf(alvo) === -1 ? '' : 'professor';
  }

  BANCOS.forEach((banco) => {
    const amb = ambiente({ allowlist: banco.admin });
    amb.api.gravarConfig_('coordenadores_gerais', banco.gerais);
    amb.api.limparCacheConfig_();
    const onde = JSON.stringify(banco);

    [A, B, C, FORA, ''].forEach((email) => {
      igual(amb.api.nivelDe_(email), nivelDeSempre(amb.api, email, banco), onde + ' ' + email);
    });
    const token = amb.api.criarSessao_(A);
    igual(amb.api.listarAdmins_({ token: token }).pessoas,
      amb.api.adminEmails_().map((e) => ({ email: e, nivel: nivelDeSempre(amb.api, e, banco) })), onde);
  });
});

// ============================ A lista ilegível não é lista vazia

/**
 * O banco em que NENHUM item de admin_emails tem a forma: os três endereços
 * separados por ';', como fica quem os digita assim no console do Firestore, e a
 * lista de gerais com um deles. O texto cru é um item só, a lista de gerais
 * cruzada com ele volta vazia, e o piso vale: toda sessão aberta antes da edição
 * é coordenadora. É o estado em que um gesto de tela faria de quem chega
 * coordenador geral.
 */
const LEGIVEIS = ['pessoa.um@exemplo.edu.br', 'pessoa.dois@exemplo.edu.br', 'pessoa.tres@exemplo.edu.br'];
const NOVATO = 'pessoa.nova@exemplo.edu.br';

function comListaIlegivel() {
  const amb = ambiente({ allowlist: LEGIVEIS.join('; ') });
  amb.api.gravarConfig_('coordenadores_gerais', LEGIVEIS[0]);
  amb.api.limparCacheConfig_();
  return amb;
}

teste('com a lista ilegível, os gestos da tela recusam e mandam rodar liberarAcesso no editor — sem gravar nada', () => {
  // Mutação que derruba: tirar a recusa de `incluirAdmin_`, a de
  // `regravarAllowlist_` (com gente entrando) ou a de `definirNivel_`.
  const amb = comListaIlegivel();
  igual(amb.api.adminEmails_(), [], 'o cenário precisa de uma lista sem nenhum item com forma');
  igual(amb.api.itensDaAllowlist_().length, 1, 'e com o texto escrito no banco');
  const sessaoDeAntes = amb.api.criarSessao_(LEGIVEIS[1]);
  igual(amb.api.sessaoAtiva_(sessaoDeAntes), { ok: true, nivel: 'coordenador' },
    'no piso, a sessão aberta antes da edição coordena');
  const antes = chavesDeAcesso(amb);

  [
    ['incluir pela tela', { fn: 'incluirAdmin', dados: { email: NOVATO } }],
    ['o campo admin_emails consertado', { fn: 'salvarConfiguracao', dados: { chave: 'admin_emails', valor: LEGIVEIS.join(', ') } }],
    ['o campo admin_emails com um nome só', { fn: 'salvarConfiguracao', dados: { chave: 'admin_emails', valor: NOVATO } }],
    ['mudar o nível', { fn: 'definirNivel', dados: { email: LEGIVEIS[1], nivel: 'coordenador' } }]
  ].forEach(([gesto, pedido]) => {
    const r = post(amb, Object.assign({ acao: 'painel', token: sessaoDeAntes }, pedido));
    igual(r, { ok: false, erro: amb.api.RECUSA_LISTA_ILEGIVEL }, gesto);
    verdadeiro(/liberarAcesso/.test(r.erro) && /editor do Apps Script/.test(r.erro),
      gesto + ': a recusa não diz a saída: ' + r.erro);
    igual(chavesDeAcesso(amb), antes, gesto + ' mexeu nas listas de acesso');
  });

  igual(linhasDoLog(amb).filter((l) => /^ADMIN_|^NIVEL_ALTERADO$/.test(l.acao)).map((l) => l.acao), [],
    'a trilha registrou uma mudança de acesso que não devia ter acontecido');
  igual(amb.api.emailAutorizado_(NOVATO), false, 'quem chegaria entrou na lista');
});

teste('e o conserto pelo editor deixa um coordenador — o dono —, e quem chega depois nasce professor', () => {
  // A saída que a recusa manda tomar: `liberarAcesso_` repõe o dono, tira o
  // texto sem forma do banco, e a partir daí a lista é legível.
  //
  // E a sessão aberta antes, que no piso coordena, cai JÁ no conserto, e não só
  // no primeiro incluir: entre os dois a lista de gerais está vazia de novo.
  //
  // Mutação que derruba: tirar o `invalidarSessoes_()` de `liberarAcesso_`.
  const amb = comListaIlegivel();
  comConsoleCapturado(amb);
  const sessaoDeAntes = amb.api.criarSessao_(LEGIVEIS[1]);
  igual(amb.api.sessaoAtiva_(sessaoDeAntes), { ok: true, nivel: 'coordenador' },
    'o cenário precisa da sessão de antes coordenando pelo piso');

  const url = amb.api.liberarAcesso_(DONO_DO_PROJETO);
  const token = /\?sessao=([0-9a-f]+)/.exec(url)[1];
  igual(chavesDeAcesso(amb).admin_emails, DONO_DO_PROJETO);
  igual(amb.api.sessaoAtiva_(sessaoDeAntes), { ok: false },
    'a sessão de antes seguiu valendo depois do conserto, e no piso ela coordena');
  igual(amb.api.sessaoAtiva_(token), { ok: true, nivel: 'coordenador' }, 'a sessão do socorro');
  const liberado = linhasDoLog(amb).filter((l) => l.acao === 'ACESSO_LIBERADO');
  igual(liberado.length, 1);
  verdadeiro(/estava ilegível, e as sessões abertas antes caíram/.test(liberado[0].detalhe),
    'a trilha não conta que as sessões caíram: ' + liberado[0].detalhe);

  const r = amb.api.incluirAdmin_({ token: token, email: NOVATO });
  igual(r.ok, true, 'incluir depois do conserto: ' + r.erro);
  igual(r.nivel, 'professor');
  igual(amb.api.nivelDe_(DONO_DO_PROJETO), 'coordenador');
});

teste('com a lista legível, o socorro do editor não derruba a sessão de ninguém', () => {
  // A queda de todas as sessões é do estado ilegível, em que ninguém escrito tem
  // um e-mail que se possa procurar. Com a lista legível o socorro só acrescenta.
  //
  // Mutação que derruba: `liberarAcesso_` derrubar as sessões sempre.
  const amb = ambiente({ allowlist: LEGIVEIS.join(', ') });
  amb.api.gravarConfig_('coordenadores_gerais', LEGIVEIS[0]);
  amb.api.limparCacheConfig_();
  comConsoleCapturado(amb);
  const coordenadora = amb.api.criarSessao_(LEGIVEIS[0]);
  const professora = amb.api.criarSessao_(LEGIVEIS[1]);

  amb.api.liberarAcesso_(DONO_DO_PROJETO);

  igual(amb.api.sessaoAtiva_(coordenadora), { ok: true, nivel: 'coordenador' });
  igual(amb.api.sessaoAtiva_(professora), { ok: true, nivel: 'professor' });
  const liberado = linhasDoLog(amb).filter((l) => l.acao === 'ACESSO_LIBERADO');
  igual(liberado.length, 1);
  igual(liberado[0].detalhe, 'sessão criada à mão pelo editor do Apps Script');
});

teste('a lista VAZIA de verdade continua deixando o primeiro nome poder tudo', () => {
  // A recusa é da lista ilegível, e não da lista filtrada vazia: no painel sem
  // ninguém, consertado pelo editor, o primeiro nome entra pelo piso.
  //
  // Mutação que derruba: `allowlistIlegivel_` perguntar só se a lista filtrada
  // está vazia.
  [
    ['incluir pela tela', (amb, token) => amb.api.incluirAdmin_({ token: token, email: NOVATO })],
    ['o campo admin_emails', (amb, token) => amb.api.salvarConfiguracao_({ token: token, chave: 'admin_emails', valor: NOVATO })]
  ].forEach(([gesto, fazer]) => {
    const amb = ambiente({ allowlist: '' });
    const token = amb.api.criarSessao_(DONO_DO_PROJETO);
    const r = fazer(amb, token);
    igual(r.ok, true, gesto + ': ' + r.erro);
    amb.api.limparCacheConfig_();
    igual(amb.api.nivelDe_(NOVATO), 'coordenador', gesto + ': na lista vazia, o primeiro nome entra pelo piso');
  });
});

// ================================================== Os dois níveis

/**
 * O QUE ESTE GRUPO PROVA: a gestão dos níveis pela tela de sempre — o cartão
 * "Quem tem acesso ao painel". Os ATAQUES (o professor chamando as 30 da
 * coordenação pelo POST, a autopromoção pelas quatro portas, a invariante do
 * último coordenador pelos quatro caminhos) moram em `invasao.js`, que é onde
 * ficam os testes escritos como ataque. Aqui é o lado de quem usa: o que a
 * função devolve para a tela desenhar, e o que a trilha registra.
 */
grupo('os dois níveis — promover, rebaixar, e o que a trilha diz');

const PROFESSORA = 'professora@exemplo.com';

/** Dois e-mails na lista, com os níveis JÁ separados, e a sessão de quem coordena. */
function comNiveis(opcoes) {
  const o = opcoes || {};
  const amb = ambiente({ allowlist: o.allowlist === undefined ? 'coordenacao@exemplo.com, ' + PROFESSORA : o.allowlist });
  if (o.gerais !== undefined) amb.api.gravarConfig_('coordenadores_gerais', o.gerais);
  else amb.api.gravarConfig_('coordenadores_gerais', 'coordenacao@exemplo.com');
  amb.token = amb.api.criarSessao_(o.eu || 'coordenacao@exemplo.com');
  return amb;
}

teste('promover e rebaixar mudam o nível, e só dele', () => {
  const amb = comNiveis();

  const promovida = amb.api.definirNivel_({
    token: amb.token, email: PROFESSORA, nivel: 'coordenador'
  });
  igual(promovida.ok, true, 'erro foi: ' + promovida.erro);
  igual(promovida.pessoas, [
    { email: 'coordenacao@exemplo.com', nivel: 'coordenador' },
    { email: PROFESSORA, nivel: 'coordenador' }
  ]);

  const rebaixada = amb.api.definirNivel_({
    token: amb.token, email: PROFESSORA, nivel: 'professor'
  });
  igual(rebaixada.ok, true, 'erro foi: ' + rebaixada.erro);
  igual(rebaixada.pessoas, [
    { email: 'coordenacao@exemplo.com', nivel: 'coordenador' },
    { email: PROFESSORA, nivel: 'professor' }
  ]);
  igual(rebaixada.emails, ['coordenacao@exemplo.com', PROFESSORA],
    'a lista de acesso mudou junto — o nível não é porta');
});

teste('as QUATRO devolvem a mesma forma, e as duas listas concordam', () => {
  // `desenharAcesso()` é chamada pelas quatro, e redesenha a tabela inteira com
  // o que veio. Uma que devolvesse a forma antiga apagaria a coluna Nível
  // depois de incluir alguém — defeito que passa em teste de unidade e aparece
  // no dedo de quem usa.
  //
  // Mutação que derruba: qualquer uma das quatro voltar a devolver só `emails`.
  const amb = comNiveis();

  const respostas = [
    amb.api.listarAdmins_({ token: amb.token }),
    amb.api.definirNivel_({ token: amb.token, email: PROFESSORA, nivel: 'coordenador' }),
    amb.api.incluirAdmin_({ token: amb.token, email: 'nova@exemplo.com' }),
    amb.api.removerAdmin_({ token: amb.token, email: 'nova@exemplo.com' })
  ];

  respostas.forEach((r, i) => {
    igual(r.ok, true, 'a ' + i + 'ª falhou: ' + r.erro);
    verdadeiro(r.pessoas !== undefined, 'a ' + i + 'ª não devolveu `pessoas`');
    igual(r.pessoas.map((p) => p.email), r.emails,
      'a ' + i + 'ª tem duas listas que discordam');
    r.pessoas.forEach((p) => {
      verdadeiro(p.nivel === 'coordenador' || p.nivel === 'professor',
        'nível estranho na ' + i + 'ª: ' + JSON.stringify(p));
    });
    igual(r.voce, 'coordenacao@exemplo.com');
    igual(r.seuNivel, 'coordenador', 'a ' + i + 'ª não diz com que nível a tela está desenhada');
  });
});

teste('a trilha do NIVEL_ALTERADO: a COLUNA diz quem mexeu, o detalhe diz o quê e por onde', () => {
  // A coluna "Quem" passou a dizer o operador (04_Log.gs), então repetir o
  // e-mail no detalhe seria escrevê-lo duas vezes na mesma linha. O que a coluna
  // NÃO sabe é a mudança e a porta — e é isso que sobra para o detalhe.
  //
  // Mutação que derruba: gravar a mudança sem a linha (a trilha não responde
  // "quem promoveu quem"); ou pôr o e-mail do operador de volta no detalhe.
  const amb = comNiveis();
  igual(amb.api.usuarioAtual_(), 'anonimo', 'o cenário devia ser o do GitHub Pages');

  amb.api.definirNivel_({ token: amb.token, email: PROFESSORA, nivel: 'coordenador' });

  const linha = linhasDoLog(amb).filter((l) => l.acao === 'NIVEL_ALTERADO')[0];
  verdadeiro(linha !== undefined, 'nenhum rastro: ' + JSON.stringify(acoesDoLog(amb)));
  igual(linha.usuario, 'coordenacao@exemplo.com', 'a trilha não diz quem promoveu');
  igual(linha.entidade_id, PROFESSORA, 'a trilha não diz quem foi promovido');
  igual(linha.detalhe, 'professor -> coordenador geral, pela tela Quem tem acesso');
  igual(linha.detalhe.indexOf('coordenacao@exemplo.com'), -1,
    'o e-mail do operador está escrito duas vezes na mesma linha: ' + linha.detalhe);
});

teste('mudar de nível é UMA escrita no documento de configuração, e derruba o cache do link', () => {
  // As duas chaves são campos do MESMO documento. Com dois `gravarConfig_` em
  // sequência existiria um instante — e, numa execução que morresse no meio, um
  // estado gravado — com a lista de acesso nova e os coordenadores velhos.
  //
  // Mutação que derruba: gravar as duas chaves em duas chamadas; ou
  // `gravarAcessos_` esquecer o `esquecerAllowlistDoLink_`, e aí quem mudou de
  // nível continuaria valendo o nível velho no caminho do link por até cinco
  // minutos.
  const amb = comNiveis();
  amb.api.allowlistParaLink_();
  verdadeiro(amb.api.CacheService.getScriptCache().get(amb.api.LINK_CACHE_ALLOWLIST) !== null,
    'o cache do link não esquentou: o teste não provaria nada');

  amb.falso.requisicoes.length = 0;
  igual(amb.api.definirNivel_({ token: amb.token, email: PROFESSORA, nivel: 'coordenador' }).ok, true);

  const escritas = amb.falso.requisicoes.filter(
    (r) => r.metodo === 'PATCH' && String(r.url).indexOf('/config/geral') !== -1);
  igual(escritas.length, 1, 'a mudança de nível custou ' + escritas.length + ' escritas');

  const campos = Object.keys(escritas[0].corpo.fields).sort();
  igual(campos, ['admin_emails', 'coordenadores_gerais'], 'a escrita não levou as duas chaves');

  igual(amb.api.CacheService.getScriptCache().get(amb.api.LINK_CACHE_ALLOWLIST), null,
    'a lista guardada do link sobreviveu à mudança de acesso');
});

teste('definirNivel recusa nível inventado e e-mail fora da lista, sem gravar nada', () => {
  // Uma palavra desconhecida não pode virar "professor por omissão" nem
  // "coordenador por omissão": as duas seriam uma decisão de acesso tomada por
  // um erro de digitação.
  const amb = comNiveis();

  [
    { email: PROFESSORA, nivel: 'COORDENADOR GERAL' },
    { email: PROFESSORA, nivel: 'admin' },
    { email: PROFESSORA, nivel: '' },
    { email: PROFESSORA },
    { email: 'ninguem@exemplo.com', nivel: 'coordenador' },
    { nivel: 'professor' }
  ].forEach((dados) => {
    const r = amb.api.definirNivel_(Object.assign({ token: amb.token }, dados));
    igual(r.ok, false, JSON.stringify(dados) + ' passou');
  });

  amb.api.limparCacheConfig_();
  igual(amb.api.config_('coordenadores_gerais'), 'coordenacao@exemplo.com');
  igual(acoesDoLog(amb).indexOf('NIVEL_ALTERADO'), -1, 'gravou uma linha para uma recusa');
});

teste('as duas portas continuam distinguíveis na trilha depois da refatoração', () => {
  // O e-mail de quem mexeu saiu do detalhe e virou coluna; o que sobrou no
  // detalhe é a PORTA, e é só ela que separa o mesmo gesto feito na tela de
  // acesso do mesmo gesto feito no campo de texto da aba Configurações. As duas
  // frases passaram a ser escritas por `aplicarAcessos_`, e é por isso que este
  // teste existe: elas não podem ter se perdido no caminho.
  const amb = comNiveis();

  amb.api.salvarConfiguracao_({
    token: amb.token, chave: 'admin_emails',
    valor: 'coordenacao@exemplo.com, nova@exemplo.com'
  });

  const linhas = linhasDoLog(amb);
  const incluida = linhas.filter((l) => l.acao === 'ADMIN_INCLUIDO')[0];
  const removida = linhas.filter((l) => l.acao === 'ADMIN_REMOVIDO')[0];

  igual(incluida.detalhe, 'pelo campo admin_emails');
  igual(incluida.entidade_id, 'nova@exemplo.com');
  igual(removida.detalhe, 'pelo campo admin_emails');
  igual(removida.entidade_id, PROFESSORA);
  igual(removida.usuario, 'coordenacao@exemplo.com', 'a coluna deixou de dizer quem mexeu');
});

// ================================================== Pela rota, ponta a ponta

grupo('ponta a ponta: o painel fora do Google fala por POST');

teste('entrar pelo Google e usar o painel, tudo por doPost com text/plain', () => {
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, tokenBom());

  const entrada = post(amb, { acao: 'login', fn: 'entrarComGoogle', idToken: TOKEN_BEM_FORMADO });
  igual(entrada.ok, true, 'erro foi: ' + entrada.erro);
  igual(entrada.via, 'google');

  const lista = post(amb, { acao: 'painel', fn: 'listarAdmins', token: entrada.token, dados: {} });
  igual(lista.ok, true, 'erro foi: ' + lista.erro);
  igual(lista.emails, ['coordenacao@exemplo.com']);
  igual(lista.voce, 'coordenacao@exemplo.com');

  const incluida = post(amb, {
    acao: 'painel', fn: 'incluirAdmin', token: entrada.token,
    dados: { email: 'nova@exemplo.com' }
  });
  igual(incluida.ok, true, 'erro foi: ' + incluida.erro);
  igual(incluida.emails, ['coordenacao@exemplo.com', 'nova@exemplo.com']);
});

teste('o ID token só é aceito no corpo — nada viaja em cabeçalho', () => {
  // O contrato do `text/plain` é o que evita o preflight OPTIONS, que o Apps
  // Script não responde. Um `Authorization: Bearer ...` tornaria a requisição
  // não-simples e o painel morreria dentro do navegador, calado. Por isso o
  // token de sessão e o ID token viajam no CORPO, e o `doPost` só lê
  // `e.postData.contents` — `e.parameter` nem é consultado.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, tokenBom());

  const saida = amb.api.doPost({
    parameter: { token: 'ignorado', idToken: TOKEN_BEM_FORMADO },
    postData: {
      type: 'text/plain',
      contents: JSON.stringify({ acao: 'login', fn: 'entrarComGoogle', idToken: TOKEN_BEM_FORMADO })
    }
  });
  igual(JSON.parse(saida.getContent()).ok, true);

  // O mesmo pedido com o corpo vazio e tudo na query string não entra.
  const semCorpo = amb.api.doPost({
    parameter: { acao: 'login', fn: 'entrarComGoogle', idToken: TOKEN_BEM_FORMADO }
  });
  igual(JSON.parse(semCorpo.getContent()), { ok: false, erro: 'Requisição vazia.' });
});

teste('sessão do Google abre uma função de painel de outro arquivo', () => {
  // Prova que o despacho alcança o que já existia: `listarDisciplinas_` nasce em
  // 12_Disciplinas.gs e nunca soube que existe login por conta Google.
  const amb = ambiente({ allowlist: 'coordenacao@exemplo.com' });
  responder(amb, tokenBom());

  const entrada = post(amb, { acao: 'login', fn: 'entrarComGoogle', idToken: TOKEN_BEM_FORMADO });
  const r = post(amb, { acao: 'painel', fn: 'listarDisciplinas', token: entrada.token, dados: {} });

  igual(r.ok, true, 'erro foi: ' + r.erro);
});

process.exit(resultado());
