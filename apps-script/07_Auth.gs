/**
 * 07_Auth.gs — controle de acesso ao painel de gestão.
 *
 * ------------------------------------------------- O fato que decide o desenho
 *
 * A implantação é `executeAs: USER_DEPLOYING` + `access: ANYONE_ANONYMOUS`
 * (appsscript.json) — a única forma de o aluno se inscrever sem ter conta
 * Google. Nessa combinação, e com conta Gmail comum, o Apps Script NÃO entrega a
 * identidade de quem acessa: `Session.getActiveUser().getEmail()` volta vazio
 * (`usuarioAtual()`, 04_Log.gs). O servidor não sabe quem está do outro lado, e
 * nenhuma quantidade de configuração muda isso sem trocar o `executeAs` — o que
 * quebraria a inscrição anônima, que é a razão de o sistema existir.
 *
 * Daí a entrada ser provada NO NAVEGADOR: o Google Identity Services devolve um
 * ID token (JWT assinado pelo Google), o navegador manda o comprovante para cá e
 * o servidor o VERIFICA (`entrarComGoogle`). Isso identifica de verdade — o log
 * diz o e-mail, e não 'anonimo'.
 *
 * ------------------------------------------------- A porta que não mora aqui
 *
 * Entrar com o Google depende de coisas que estão FORA deste código: o client id
 * registrado no console, a origem autorizada nele, a allowlist preenchida.
 * Qualquer uma errada e o botão recusa todo mundo, inclusive quem consertaria a
 * configuração. Um sistema com uma porta só é um sistema que se tranca por fora.
 *
 * A segunda porta é o LINK POR E-MAIL, e ela mora em 07b_LinkPorEmail.gs — com a
 * conta inteira de por que ela substituiu o PIN que existia aqui. Em uma linha:
 * um segredo compartilhado é adivinhável, se perde, e não diz quem entrou; a
 * posse da caixa institucional não tem nenhum dos três defeitos.
 *
 * A terceira é `liberarMeuAcesso()`, rodada à mão no editor, para o dia em que a
 * allowlist estiver vazia e não houver para onde mandar link nenhum.
 *
 * As três terminam no mesmo lugar — `criarSessao_` — e nada depois disso muda:
 * `exigirAdmin(token)` continua sendo a primeira linha de toda função sensível.
 *
 * -------------------------------------------------- O que a verificação exige
 *
 * "Veio do Google" NÃO é autenticação. Todo aplicativo Google do mundo emite ID
 * tokens legítimos, assinados pela mesma chave. Conferir só a assinatura e o
 * e-mail deixaria QUALQUER pessoa com conta Google entrar aqui, usando um token
 * emitido para outro site. O item que separa autenticação de porta aberta é o
 * `aud`: ele tem de ser o NOSSO client id, e é justamente o que costuma faltar.
 * Ver `verificarIdTokenGoogle_`, onde os cinco itens estão em ordem.
 */

var VALIDADE_SESSAO_MS = 8 * 60 * 60 * 1000; // 8 horas

/**
 * Onde mora o client id do OAuth. Propriedade do script, nunca no código.
 *
 * Ele NÃO é segredo — o navegador precisa dele para inicializar o Google
 * Identity Services, então ele sai daqui em `modoDeAcesso()` e fica visível no
 * código-fonte da página. O que ele é: um identificador que muda por ambiente
 * (o de teste não é o de produção). Deixá-lo no código obrigaria a editar e
 * reimplantar o projeto para trocar de ambiente, que é exatamente o tipo de
 * passo que se esquece.
 */
var GOOGLE_CLIENT_ID_PROP = 'GOOGLE_CLIENT_ID';

/** Verificador oficial do Google. Não montamos a conferência de assinatura. */
var GOOGLE_TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';

/** As duas grafias que o Google usa no `iss`. Não existe uma terceira. */
var GOOGLE_EMISSORES = ['accounts.google.com', 'https://accounts.google.com'];

/**
 * Teto de tamanho do ID token, conferido ANTES de sair para a rede.
 *
 * Um ID token do Google fica na casa de 1 KB. O teto (e a conferência de
 * formato, logo acima dele) existe pelo mesmo motivo que `conferirMatricula_`
 * confere o formato antes de consultar o banco: esta rota é anônima, e sem o
 * filtro barato qualquer laço de terminal transforma lixo enviado daqui em
 * requisições de saída — que têm cota diária própria no Apps Script (20 mil no
 * plano gratuito) e, esgotadas, derrubam TAMBÉM o acesso ao Firestore, que sai
 * pelo mesmo `UrlFetchApp`.
 */
var GOOGLE_ID_TOKEN_MAX = 4096;

/**
 * Quantas conferências de ID token cabem numa hora.
 *
 * O teto de tamanho e a conferência de formato, acima, barram LIXO — e lixo não
 * é o que preocupa. Três segmentos base64url é coisa que se gera numa linha de
 * terminal, e um token assim passa nos dois filtros e custa UMA requisição de
 * saída. São 20 mil por dia no plano gratuito, e elas são as MESMAS pelas quais
 * o Firestore inteiro passa (`UrlFetchApp`, 02_Repo.gs): esgotá-las não derruba
 * só o login do painel — derruba a inscrição do aluno, que é a razão de o
 * sistema existir. Medido nesta revisão: 400 tentativas anônimas custavam 400
 * requisições de saída, sem nenhum freio no caminho.
 *
 * Sessenta por hora é folga larga para o uso real: são meia dúzia de pessoas
 * entrando algumas vezes por dia. No pior caso o teto limita o dreno a 1.440
 * requisições diárias — 7% da cota, em vez de 100%.
 *
 * O QUE O TETO NÃO PODE FAZER é fechar o link por e-mail junto. Ele conta só as
 * conferências de conta Google; o pedido de link tem freios próprios e
 * independente (o freio por endereço de 07b_LinkPorEmail.gs).
 * Um estranho que não consegue entrar não pode, de brinde, trancar quem
 * consegue — e a recusa por teto diz isso, com todas as letras, para quem chegar
 * nela sendo a pessoa certa.
 *
 * A contagem mora no CacheService, e não em PropertiesService: o cache não tem
 * cota diária, e um contador de segurança que gasta a cota que ele existe para
 * proteger não protege nada. Ler-decidir-escrever sem serialização faz a
 * contagem sair MENOR que a real sob concorrência — o mesmo caveat de
 * `excedeuConsultas_` (08_Api.gs), e pela mesma razão: fechá-lo exigiria um lock
 * global no caminho de quem está tentando entrar.
 */
var GOOGLE_TETO_VERIFICACOES_HORA = 60;

/**
 * Recusa única das rotas do painel.
 *
 * Texto único de propósito: sessão ausente, vencida, forjada ou de alguém que
 * saiu da allowlist recebem a MESMA frase. Uma recusa que varia conta ao
 * visitante o que ele ainda não sabe.
 *
 * A frase é a mesma de `exigirAdmin` porque o painel a reconhece por expressão
 * regular para se deslogar sozinho (o envelope `chamar()` do Admin.html).
 * Mudá-la aqui sem mudar lá deixa o professor preso numa tela que não recarrega.
 */
var RECUSA_SESSAO = 'Sessão expirada ou inválida. Faça login novamente.';

/**
 * Entrada pela identidade que o PRÓPRIO Apps Script entrega.
 *
 * Hoje esta função nunca dá certo, e continua no arquivo de propósito. Em
 * `executeAs: USER_DEPLOYING` com conta Gmail comum — a implantação de agora —
 * `usuarioAtual()` volta 'anonimo' e ela recusa todo mundo, apontando para o
 * botão do Google. Quem faz o trabalho de verdade é `entrarComGoogle`.
 *
 * Ela vale numa implantação Workspace com "Executar como: Usuário que acessa",
 * cenário que o projeto pode assumir quando o sistema mudar para a conta
 * institucional: ali o Google já autenticou a pessoa antes de a requisição
 * chegar, e pedir um segundo login seria pedir a mesma prova duas vezes.
 *
 * Não há freio aqui, e não falta nenhum: não existe nada a adivinhar. Ou a
 * infraestrutura do Google entrega uma identidade, ou não entrega — e uma
 * identidade entregue ainda precisa estar na allowlist para virar sessão.
 */
function autenticar() {
  try {
    var email = usuarioAtual();

    if (!email || email === 'anonimo') {
      return {
        ok: false,
        erro: 'Esta implantação não identifica sua conta sozinha. Entre pelo botão ' +
              '"Entrar com o Google" — é ele que prova quem você é.'
      };
    }

    if (!emailAutorizado_(email)) {
      registrar('LOGIN_NEGADO', 'painel', email, 'fora da allowlist');
      return {
        ok: false,
        erro: 'A conta ' + email + ' não tem acesso ao painel. Peça à coordenação ' +
              'para incluí-la em Configurações > quem tem acesso.'
      };
    }

    registrar('LOGIN', 'painel', email, 'via identidade da implantação');
    return { ok: true, token: criarSessao_(email), usuario: email, via: 'email' };
  } catch (err) {
    console.error('autenticar: ' + err.message);
    return { ok: false, erro: 'Erro ao autenticar.' };
  }
}
/**
 * Entra com conta Google. Recebe o ID token que o navegador obteve do Google.
 *
 * O navegador é quem faz o login — este servidor não consegue. O que chega aqui
 * é o COMPROVANTE, e a única coisa que este código faz de valioso é desconfiar
 * dele até o fim (`verificarIdTokenGoogle_`).
 *
 * Três decisões que não são óbvias:
 *
 *   1. falha de verificação é RECUSA, nunca "deixa passar". Inclusive falha de
 *      REDE: se o `tokeninfo` do Google estiver fora do ar, ninguém entra por
 *      aqui — e é para esse dia que existe o link por e-mail. Tratar
 *      indisponibilidade como permissão transformaria uma queda do Google numa
 *      porta aberta.
 *
 *   2. a recusa NÃO alimenta nenhum freio do OUTRO caminho, e esta é a decisão
 *      que mantém os dois independentes. Esta rota é anônima: se as recusas
 *      daqui atrasassem o link por e-mail, meia dúzia de tokens de mentira
 *      poriam em espera o único caminho de recuperação do sistema. Um atacante
 *      que não consegue entrar não pode, de brinde, atrasar quem consegue. O
 *      contrário também vale, e por isso o teto desta função é um contador
 *      separado dos de 07b_LinkPorEmail.gs: quem inunda uma porta não mexe no
 *      relógio da outra.
 *
 *   3. quem chega até a allowlist já PROVOU ser dono daquele e-mail, então dizer
 *      "esta conta não está autorizada" não revela nada que ele não pudesse
 *      descobrir sobre si mesmo. Não há enumeração possível: para perguntar pela
 *      conta alheia seria preciso um token emitido para ela.
 */
function entrarComGoogle(idToken) {
  try {
    var conferido = verificarIdTokenGoogle_(idToken);
    if (!conferido.ok) {
      registrarRecusa('LOGIN_NEGADO', 'painel', '',
        'ID token recusado: ' + conferido.motivo, 'login_google');

      // O teto tem frase própria porque a causa é OUTRA, e a saída também. As
      // demais recusas são sobre o token de quem tentou; esta é sobre o sistema
      // estar apanhando de fora, e a pessoa certa precisa saber que a OUTRA
      // porta continua aberta em vez de ficar tentando a mesma conta.
      if (conferido.motivo === 'teto') {
        return {
          ok: false,
          erro: 'Já houve tentativas demais de entrada por conta Google nesta hora, e o ' +
                'sistema parou de conferir para não esgotar a cota do dia. Peça um link ' +
                'por e-mail agora; a conta Google volta a valer na próxima hora.'
        };
      }

      return {
        ok: false,
        erro: 'Não consegui confirmar sua conta Google. Saia e entre de novo; se ' +
              'continuar, avise a coordenação — pode ser configuração do acesso.'
      };
    }

    if (!emailAutorizado_(conferido.email)) {
      registrarRecusa('LOGIN_NEGADO', 'painel', conferido.email,
        'conta Google fora da allowlist', 'login_google_negado');
      return {
        ok: false,
        erro: 'A conta ' + conferido.email + ' não tem acesso ao painel. Peça a quem ' +
              'já entra para incluí-la na lista de acesso.'
      };
    }


    registrar('LOGIN', 'painel', conferido.email, 'via conta Google (ID token)');
    return {
      ok: true,
      token: criarSessao_(conferido.email),
      usuario: conferido.email,
      via: 'google'
    };
  } catch (err) {
    console.error('entrarComGoogle: ' + err.message);
    return { ok: false, erro: 'Erro ao entrar com a conta Google.' };
  }
}

/**
 * Confere o ID token com o Google e devolve { ok, email } ou { ok:false, motivo }.
 *
 * A conferência da ASSINATURA é delegada ao endpoint `tokeninfo` do Google.
 * Verificá-la aqui — baixar as chaves públicas do JWKS, escolher a certa pelo
 * `kid`, validar RS256 na mão — é possível no Apps Script e não vale o risco:
 * um erro nessa rotina não falha, ACEITA. O preço da delegação é uma requisição
 * de saída por login, que é o momento menos quente que existe.
 *
 * OS CINCO ITENS, e cada um é obrigatório:
 *
 *   aud             tem de ser o NOSSO client id. É o item que a maioria dos
 *                   tutoriais esquece, e o único que impede um token emitido
 *                   para OUTRO aplicativo Google — qualquer um, do mundo
 *                   inteiro, todos assinados pela mesma chave — de entrar aqui.
 *                   Sem ele, "verificar o token" vira teatro.
 *   iss             emitido pelas contas do Google, nas duas grafias que
 *                   existem.
 *   exp             no futuro. O `tokeninfo` já recusa token vencido com 400,
 *                   mas a validade é regra NOSSA e fica escrita aqui: quem lê
 *                   este arquivo não precisa saber o que o Google faz de graça.
 *   email_verified  conta com e-mail não confirmado não prova o e-mail, e é
 *                   justamente o e-mail que a allowlist compara. O `tokeninfo`
 *                   devolve o campo como TEXTO ('true'), não como booleano.
 *   email           só depois de tudo isso ele é comparado com a allowlist, e
 *                   essa comparação é do chamador, não daqui.
 *
 * O `motivo` que sai daqui vai para a trilha de auditoria, e não para a tela: é
 * ele que permite descobrir depois se o que faltou foi o client id trocado ou a
 * conta sem e-mail confirmado. Ver `entrarComGoogle`.
 */
function verificarIdTokenGoogle_(idToken) {
  var clienteId = String(
    PropertiesService.getScriptProperties().getProperty(GOOGLE_CLIENT_ID_PROP) || ''
  ).trim();

  // Sem client id não existe `aud` para comparar, e comparar contra vazio
  // aceitaria qualquer token. A ausência é recusa, e não conferência a menos.
  if (!clienteId) return { ok: false, motivo: 'GOOGLE_CLIENT_ID não configurado' };

  var bruto = String(idToken || '').trim();
  if (bruto.length > GOOGLE_ID_TOKEN_MAX) return { ok: false, motivo: 'tamanho' };
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bruto)) {
    return { ok: false, motivo: 'formato' };
  }

  // O teto vem DEPOIS dos filtros baratos e ANTES da rede: lixo não consome a
  // cota nem gasta o teto, e o teto só existe para o que iria mesmo sair.
  if (excedeuVerificacoesGoogle_()) return { ok: false, motivo: 'teto' };

  var resposta;
  try {
    resposta = UrlFetchApp.fetch(GOOGLE_TOKENINFO + encodeURIComponent(bruto), {
      method: 'get',
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, motivo: 'não consegui falar com o Google: ' + e.message };
  }

  if (resposta.getResponseCode() !== 200) {
    return { ok: false, motivo: 'tokeninfo respondeu ' + resposta.getResponseCode() };
  }

  var dados;
  try {
    dados = JSON.parse(resposta.getContentText());
  } catch (e) {
    dados = null;
  }
  if (!dados || typeof dados !== 'object') return { ok: false, motivo: 'resposta ilegível' };

  if (String(dados.aud || '') !== clienteId) return { ok: false, motivo: 'aud' };
  if (GOOGLE_EMISSORES.indexOf(String(dados.iss || '')) === -1) return { ok: false, motivo: 'iss' };

  var exp = Number(dados.exp);
  if (!exp || exp * 1000 <= new Date().getTime()) return { ok: false, motivo: 'exp' };

  if (String(dados.email_verified) !== 'true') return { ok: false, motivo: 'email_verified' };

  var email = normalizarEmail(dados.email);
  if (!emailValido(email)) return { ok: false, motivo: 'email' };

  return { ok: true, email: email, clienteId: clienteId };
}

/**
 * Já passamos do teto de conferências desta hora? Ver GOOGLE_TETO_VERIFICACOES_HORA.
 *
 * A janela é a hora do relógio, e não uma contagem deslizante: a chave carrega o
 * número da hora, então virar a hora é ganhar um contador novo, sem nenhuma
 * faxina a fazer. Cache indisponível DEIXA PASSAR — o cache é otimização, nunca
 * dependência, e um cache fora do ar não pode virar painel trancado.
 */
function excedeuVerificacoesGoogle_() {
  try {
    var chave = 'gid_verif_' + Math.floor(new Date().getTime() / 3600000);
    var cache = CacheService.getScriptCache();
    var quantas = Number(cache.get(chave) || 0);

    if (quantas >= GOOGLE_TETO_VERIFICACOES_HORA) return true;

    cache.put(chave, String(quantas + 1), 3600);
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Diz ao front-end como desenhar a tela de login, antes de qualquer tentativa.
 *
 * `google.clientId` sai daqui porque o Google Identity Services roda NO
 * NAVEGADOR e precisa dele para desenhar o botão. Não é vazamento: client id de
 * aplicativo web é público por construção — quem o protege é a lista de origens
 * autorizadas do console, não o sigilo.
 *
 * `google.disponivel` é falso quando falta client id ou quando a allowlist está
 * vazia. Anunciar um botão que vai recusar todo mundo é pior do que não
 * mostrá-lo: o professor tentaria, levaria "conta sem acesso" e concluiria que a
 * conta dele é o problema.
 *
 * `allowlistVazia` é o único estado em que NENHUMA das duas portas remotas
 * funciona — o botão do Google recusaria todo mundo, e não há endereço para onde
 * mandar link. A tela precisa saber disso para dizer a saída (`liberarAcesso()`
 * no editor) em vez de mostrar uma porta pintada na parede.
 *
 * NÃO EXISTE MAIS "MODO DE ACESSO". `modo_acesso_painel` valia quando havia um
 * PIN para ligar e desligar; hoje as duas portas coexistem sempre, porque a
 * segunda existe precisamente para os dias em que a primeira não funciona.
 * Desligá-la por configuração seria reintroduzir o jeito de trancar o painel por
 * fora que este arquivo inteiro existe para evitar.
 */
function modoDeAcesso() {
  try {
    var email = usuarioAtual();
    var lista = adminEmails_();
    var clienteId = String(
      PropertiesService.getScriptProperties().getProperty(GOOGLE_CLIENT_ID_PROP) || ''
    ).trim();

    return {
      ok: true,
      identidadeVisivel: !!(email && email !== 'anonimo'),
      usuario: (email && email !== 'anonimo') ? email : '',
      allowlistVazia: lista.length === 0,
      // A porta de recuperação tem como funcionar AGORA? Ver
      // `linkDeAcessoDisponivel_` (07b_LinkPorEmail.gs) para por que isto não
      // vaza nada sobre endereço nenhum. Sem este campo, a tela oferece o link
      // com a cota de envio esgotada e a pessoa espera um e-mail que não vem.
      linkDisponivel: linkDeAcessoDisponivel_(),
      google: {
        disponivel: !!clienteId && lista.length > 0,
        clientId: clienteId
      }
    };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/** Encerra a sessão atual. */
function sair(token) {
  if (token) PropertiesService.getScriptProperties().deleteProperty('sess_' + token);
  return { ok: true };
}

/** Guarda usada por toda função sensível. Lança erro se o token não valer. */
function exigirAdmin(token) {
  if (!tokenValido_(token)) {
    throw new Error(RECUSA_SESSAO);
  }
  return true;
}

/** Versão que não lança — usada pelo cliente para saber se ainda está logado. */
function sessaoAtiva(token) {
  return { ok: tokenValido_(token) };
}

// ----------------------------------------------- Quem tem acesso ao painel

/**
 * A allowlist, normalizada e sem vazios.
 *
 * Fonte única: `emailAutorizado_`, `modoDeAcesso` e as três funções de gestão
 * abaixo passam todas por aqui. Antes, cada uma repartia a mesma string com uma
 * regra ligeiramente diferente — `modoDeAcesso` só aparava espaço, as outras
 * normalizavam —, e o dia em que as duas discordassem seria o dia em que a tela
 * diz "há gente autorizada" e o login recusa.
 */
function adminEmails_() {
  return config('admin_emails', '').split(',')
    .map(function (e) { return normalizarEmail(e); })
    .filter(Boolean);
}

/**
 * Lista quem tem acesso.
 *
 * Devolve também `voce`, que é o e-mail da sessão em curso — é o que permite à
 * tela esconder o botão de remover na própria linha, e é a informação que torna
 * a recusa de `removerAdmin` compreensível antes de acontecer. Hoje ele nunca
 * vem vazio: as três portas nascem de um e-mail conhecido.
 */
function listarAdmins(payload) {
  try {
    exigirAdmin(payload && payload.token);
    return {
      ok: true,
      emails: adminEmails_(),
      voce: emailDaSessao_(payload.token)
    };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/** Acrescenta um e-mail à allowlist. Repetido não é erro, é nada a fazer. */
function incluirAdmin(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var email = normalizarEmail(payload.email);
    if (!emailValido(email)) {
      return { ok: false, erro: 'Informe um e-mail válido.' };
    }

    var lista = adminEmails_();
    // Comparação sem diferenciar maiúsculas porque `adminEmails_` já normalizou
    // os dois lados. 'Coordenacao@Exemplo.com' e 'coordenacao@exemplo.com' são a
    // MESMA conta no Google, e deixá-las virar duas linhas faria a remoção de
    // uma delas parecer que não funcionou.
    if (lista.indexOf(email) !== -1) {
      return { ok: true, emails: lista, jaEstava: true };
    }

    lista.push(email);
    gravarConfig('admin_emails', lista.join(', '));
    registrar('ADMIN_INCLUIDO', 'config', email, 'incluído por ' + quemMexeu_(payload.token));
    return { ok: true, emails: lista };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Tira um e-mail da allowlist, com as duas guardas contra trancar a porta por dentro.
 *
 *   1. ninguém sai da lista sendo o ÚLTIMO da lista. É a chave girada por dentro
 *      com a pessoa do lado de fora, e não há tela para desfazer;
 *   2. a lista NUNCA fica vazia, seja quem for que peça. Sem PIN, a allowlist é
 *      a fonte única de quem entra pelas DUAS portas remotas: o botão do Google
 *      confere contra ela, e o link por e-mail só é enviado para quem está nela.
 *      Lista vazia é painel sem porta nenhuma, e o conserto sai do painel e vai
 *      para o editor do Apps Script (`liberarAcesso()`), que nem todo professor
 *      tem. Esta guarda não depende mais de configuração: antes ela só valia com
 *      `modo_acesso_painel` = GOOGLE, e essa chave deixou de existir.
 *
 * Quem sai perde a sessão junto (`invalidarSessoesDe_`). Sem isso, "remover o
 * acesso" continuaria valendo por até oito horas — que é o tempo em que a pessoa
 * removida ainda poderia exportar o cadastro inteiro. Tirar da lista e deixar
 * entrar é não ter tirado.
 */
function removerAdmin(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var email = normalizarEmail(payload.email);
    var lista = adminEmails_();
    var posicao = lista.indexOf(email);
    if (posicao === -1) {
      return { ok: false, erro: 'Esse e-mail não está na lista de acesso.' };
    }

    var quemPede = emailDaSessao_(payload.token);

    if (lista.length === 1 && email === quemPede) {
      return {
        ok: false,
        erro: 'Você é o único e-mail autorizado. Inclua outra pessoa antes de sair da ' +
              'lista — do contrário ninguém mais entra por conta Google, nem você.'
      };
    }

    if (lista.length === 1) {
      return {
        ok: false,
        erro: 'Este é o último e-mail autorizado, e esvaziar a lista tranca todo mundo do ' +
              'lado de fora — inclusive o link por e-mail, que só é enviado para quem está ' +
              'nela. Inclua outro e-mail antes de tirar este.'
      };
    }

    lista.splice(posicao, 1);
    gravarConfig('admin_emails', lista.join(', '));
    invalidarSessoesDe_(email);
    registrar('ADMIN_REMOVIDO', 'config', email, 'removido por ' + quemMexeu_(payload.token));
    return { ok: true, emails: lista };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Regrava a allowlist INTEIRA, a partir do texto do campo da aba Configurações.
 *
 * Este é o mesmo gesto de `incluirAdmin`/`removerAdmin` por outro caminho, e é
 * por isso que ele não pode ter outras regras. `admin_emails` continua sendo uma
 * chave de configuração como as outras, e o campo de texto continua na tela — só
 * que passar por `gravarConfig` direto contornava TUDO o que a tela de "Quem tem
 * acesso" faz de importante:
 *
 *   1. as duas guardas contra trancar a porta por dentro. `removerAdmin` recusa
 *      esvaziar a lista com o acesso em GOOGLE; o campo de texto aceitava, e o
 *      resultado era o painel sem porta nenhuma;
 *   2. DERRUBAR A SESSÃO de quem saiu. Sem isso, "tirar o acesso" continuava
 *      valendo por até oito horas — o tempo em que a pessoa removida ainda
 *      exporta o cadastro inteiro. Tirar da lista e deixar entrar é não ter
 *      tirado;
 *   3. a linha de auditoria com o nome de quem saiu. O log dizia só "CONFIG
 *      alterado", e a pergunta que se faz depois — "quem foi tirado, e por quem?"
 *      — não tinha resposta em lugar nenhum.
 *
 * E-mail inválido recusa o campo inteiro, em vez de ser descartado em silêncio:
 * quem digitou `fulano@exemplo` e viu "salvo" acha que deu acesso a alguém.
 */
function regravarAllowlist_(valor, token) {
  var antes = adminEmails_();
  var depois = [];
  var invalidos = [];

  String(valor || '').split(',').forEach(function (bruto) {
    var email = normalizarEmail(bruto);
    if (!email) return;
    if (!emailValido(email)) { invalidos.push(email); return; }
    if (depois.indexOf(email) === -1) depois.push(email);
  });

  if (invalidos.length) {
    return {
      ok: false,
      erro: 'Não parece e-mail: ' + invalidos.join(', ') + '. Nada foi alterado — ' +
            'corrija e salve de novo, ou use Configurações > Quem tem acesso.'
    };
  }

  var quemPede = emailDaSessao_(token);
  var saindo = antes.filter(function (e) { return depois.indexOf(e) === -1; });

  // O `antes.length === 1` não estava aqui, e a frase abaixo mentia: esvaziando
  // um campo com três e-mails, estando você entre eles, a recusa dizia "você é o
  // único autorizado" e mandava incluir alguém que já estava na lista. Quem
  // esvazia uma lista de três cai agora na guarda seguinte, que fala de esvaziar.
  if (!depois.length && antes.length === 1 && quemPede && saindo.indexOf(quemPede) !== -1) {
    return {
      ok: false,
      erro: 'Você é o único e-mail autorizado. Inclua outra pessoa antes de sair da ' +
            'lista — do contrário ninguém mais entra por conta Google, nem você.'
    };
  }

  if (!depois.length) {
    return {
      ok: false,
      erro: 'Esvaziar a lista tranca todo mundo do lado de fora: é ela que autoriza tanto o ' +
            'botão do Google quanto o envio do link por e-mail. Deixe pelo menos um e-mail.'
    };
  }

  gravarConfig('admin_emails', depois.join(', '));

  saindo.forEach(function (email) {
    invalidarSessoesDe_(email);
    registrar('ADMIN_REMOVIDO', 'config', email,
      'removido por ' + quemMexeu_(token) + ' pelo campo admin_emails');
  });

  depois.forEach(function (email) {
    if (antes.indexOf(email) !== -1) return;
    registrar('ADMIN_INCLUIDO', 'config', email,
      'incluído por ' + quemMexeu_(token) + ' pelo campo admin_emails');
  });

  return { ok: true, emails: depois };
}

/**
 * Como a trilha nomeia quem agiu.
 *
 * O fallback ficou INALCANÇÁVEL de propósito e continua aqui: desde que o PIN
 * saiu, as três portas gravam um e-mail na sessão, então `emailDaSessao_` sempre
 * responde. Ele é a rede embaixo do trapézio — o dia em que uma sessão sem nome
 * aparecer, o log diz isso em vez de gravar uma linha em branco e deixar a
 * pergunta "quem foi?" sem resposta em lugar nenhum.
 */
function quemMexeu_(token) {
  return emailDaSessao_(token) || 'sessão sem identidade';
}

// ------------------------------------------------------------ Internos

function criarSessao_(email) {
  var token = Utilities.getUuid().replace(/-/g, '');
  var props = PropertiesService.getScriptProperties();
  props.setProperty('sess_' + token, JSON.stringify({
    email: email || 'anonimo',
    expira_em: new Date().getTime() + VALIDADE_SESSAO_MS
  }));
  faxinaSessoes_();
  return token;
}

/**
 * O token vale?
 *
 * A VALIDADE PRECISA SER UM NÚMERO, e a exigência não é preciosismo. O teste
 * ingênuo é `new Date().getTime() > sess.expira_em`, e ele FALHA ABERTO: com
 * `expira_em` ausente, a comparação vira `numero > undefined`, que em JavaScript
 * é `false` — e falso ali significa "ainda não venceu". Uma sessão sem prazo
 * legível passaria a valer para sempre, que é o oposto do que "sessão de 8
 * horas" promete.
 *
 * O valor guardado é escrito só por `criarSessao_`, então hoje ele sempre tem
 * prazo. Mas guarda de autenticação não pode depender de quem a chama estar
 * certo: o dia em que um valor chegar truncado, meio gravado ou escrito por
 * outra versão do código é justamente o dia em que ninguém vai estar olhando.
 * Conferir explicitamente troca "vale para sempre" por "não vale" — que é o
 * lado certo para uma falha de autenticação cair.
 */
function tokenValido_(token) {
  if (!token) return false;
  var bruto = PropertiesService.getScriptProperties().getProperty('sess_' + token);
  if (!bruto) return false;

  try {
    var sess = JSON.parse(bruto);
    var expiraEm = Number(sess && sess.expira_em);

    if (!expiraEm || new Date().getTime() > expiraEm) {
      PropertiesService.getScriptProperties().deleteProperty('sess_' + token);
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * E-mail de quem abriu a sessão, ou '' quando ela não identifica ninguém.
 *
 * Uma sessão sem e-mail guarda 'anonimo' — que não é e-mail e nunca vai casar
 * com a allowlist. Ela vira '' aqui para que "quem está logado" e "que e-mail
 * está logado" sejam perguntas com respostas diferentes: a primeira é sim, a
 * segunda é ninguém. Nenhuma porta cria sessão assim hoje; a conversão continua
 * porque `criarSessao_` ACEITA o valor, e guarda não se apoia em quem a chama.
 */
function emailDaSessao_(token) {
  if (!token) return '';
  var bruto = PropertiesService.getScriptProperties().getProperty('sess_' + token);
  if (!bruto) return '';

  try {
    var email = normalizarEmail(JSON.parse(bruto).email);
    return email === 'anonimo' ? '' : email;
  } catch (e) {
    return '';
  }
}

function emailAutorizado_(email) {
  if (!email || email === 'anonimo') return false;
  return adminEmails_().indexOf(normalizarEmail(email)) !== -1;
}

/** Remove sessões vencidas — o armazenamento de propriedades é limitado (500 KB). */
function faxinaSessoes_() {
  var props = PropertiesService.getScriptProperties();
  var todas = props.getProperties();
  var agoraMs = new Date().getTime();

  Object.keys(todas).forEach(function (k) {
    if (k.indexOf('sess_') !== 0) return;
    try {
      if (agoraMs > JSON.parse(todas[k]).expira_em) props.deleteProperty(k);
    } catch (e) {
      props.deleteProperty(k); // ilegível = inútil
    }
  });
}

/** Derruba as sessões de UMA pessoa. Usado por `removerAdmin`. */
function invalidarSessoesDe_(email) {
  var alvo = normalizarEmail(email);
  if (!alvo) return;

  var props = PropertiesService.getScriptProperties();
  var todas = props.getProperties();

  Object.keys(todas).forEach(function (k) {
    if (k.indexOf('sess_') !== 0) return;
    try {
      if (normalizarEmail(JSON.parse(todas[k]).email) === alvo) props.deleteProperty(k);
    } catch (e) {
      props.deleteProperty(k);
    }
  });
}

/** Derruba TODAS as sessões. O botão de pânico de quem suspeita de invasão. */
function invalidarSessoes() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf('sess_') === 0) props.deleteProperty(k);
  });
}
