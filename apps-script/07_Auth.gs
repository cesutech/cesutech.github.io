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
 * Recusa por NÍVEL: a pessoa entrou, e a ação não é dela.
 *
 * A frase NÃO PODE casar com `/Sess.o expirada|inv.lida/i`, que é a expressão
 * pela qual o painel se desloga sozinho (`chamar()`, docs/painel/index.html).
 * Uma recusa de nível que casasse jogaria o professor na tela de login a cada
 * clique fora do quintal dele — e ele entraria de novo para receber a mesma
 * coisa, num laço sem saída e sem nada na tela que o explique. Há teste próprio,
 * e ele lê a expressão do PRÓPRIO painel, para o dia em que ela mudar.
 *
 * Ela também não nomeia ninguém: dizer "peça a fulano@" transformaria a recusa
 * num diretório de quem manda no sistema, que é a mesma razão de
 * `pedirLinkDeAcesso` responder igual para endereço autorizado e não autorizado.
 */
var RECUSA_NIVEL = 'Esta ação é da coordenação geral. Seu acesso é de professor.';

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


    // A entrada é a primeira ação da pessoa, e a única em que ela se identifica
    // sem ter sessão ainda — `exigirAdmin`, que anota o operador nas outras,
    // não passa por aqui. O e-mail já foi PROVADO (`verificarIdTokenGoogle_`) e
    // já passou pela allowlist, então a linha de LOGIN pode dizer quem entrou
    // na coluna "Quem", e não só no campo da entidade. As recusas acima ficam
    // sem operador de propósito: ninguém entrou.
    anotarOperador_(conferido.email);
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

/**
 * Guarda usada por toda função sensível. Lança erro se o token não valer.
 *
 * E É AQUI QUE A TRILHA APRENDE QUEM ESTÁ OPERANDO. A sessão sabe o e-mail; o
 * web app publicado não (`usuarioAtual()` volta 'anonimo' — ver o topo deste
 * arquivo); e esta é a única linha por onde toda função do painel passa com o
 * token na mão. `anotarOperador_` (04_Log.gs) guarda o e-mail pela execução e
 * `registrar` o grava na coluna `usuario`, sem que nenhuma das ~70 chamadas de
 * log precise carregar o token até lá. O cabeçalho de 04_Log.gs tem a conta
 * inteira de por que é assim e não por parâmetro.
 *
 * A LIMPEZA NO CAMINHO DA RECUSA não é zelo. A variável é global ao script:
 * numa execução que chamasse a guarda duas vezes — e todo teste chama —, a
 * segunda, recusada, herdaria o nome da primeira e a trilha assinaria a uma
 * pessoa uma ação que o servidor não deixou acontecer.
 *
 * O PREÇO: `emailDaSessao_` abre a sessão de novo, que é uma leitura de
 * ScriptProperties — local, sem nenhuma cota do Firestore. Ela é a mesma
 * leitura que `quemMexeu_(payload.token)` fazia nas funções que assinavam a
 * linha do log à mão, e que agora não precisam mais: onde havia duas, passa a
 * haver uma. Ler a sessão aqui numa única vez exigiria abrir `tokenValido_`
 * para devolver o documento — e abrir a guarda de autenticação para poupar uma
 * leitura local é troca ruim.
 */
function exigirAdmin(token) {
  if (!tokenValido_(token)) {
    anotarOperador_('');
    throw new Error(RECUSA_SESSAO);
  }
  anotarOperador_(emailDaSessao_(token));
  return true;
}

/**
 * A guarda do NÍVEL, para as ações que são da coordenação geral.
 *
 * A ORDEM É A DECISÃO, e ela é dupla:
 *
 *   1. `exigirAdmin` PRIMEIRO. Quem não tem sessão leva `RECUSA_SESSAO` e não
 *      aprende que existe um segundo nível — e, principalmente, a recusa
 *      continua custando ZERO leitura do banco, que é o que o teste do token
 *      inventado mede. Invertida, toda tentativa anônima passaria a ler a
 *      configuração para descobrir um nível de alguém que não existe;
 *   2. só então o nível, lido fresco (`nivelDaSessao_`). Quem passou pela sessão
 *      e é recusado aqui existe: a pessoa é conhecida, a ação é que não é dela —
 *      e por isso ela sai da execução ANOTADA por `exigirAdmin`, e a linha da
 *      trilha diz qual professor tentou.
 *
 * Ela é BOOLEANA de propósito. Uma assinatura `exigirNivel(token, nivel)` pediria
 * uma ordem entre os níveis ("geral ≥ professor?"), e é essa comparação que erra
 * no dia do terceiro nível — que o Jonathan recusou justamente para não existir.
 *
 * Onde ela é cobrada: no DESPACHO (`rotaDoPainel_`, 08_Api.gs), que é a porta de
 * todas as funções do painel, e por dentro só nas quatro que CONCEDEM OU REVOGAM
 * PODER (`incluirAdmin`, `removerAdmin`, `definirNivel`, `salvarConfiguracao`).
 * As quatro já leem configuração, então ali o custo é literalmente zero, e são
 * elas a superfície de escalada de privilégio.
 */
function exigirCoordenador(token) {
  exigirAdmin(token);
  if (nivelDaSessao_(token) !== 'coordenador') throw new Error(RECUSA_NIVEL);
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

// ------------------------------------------- Quem é COORDENADOR GERAL, e quem
//                                              é PROFESSOR

/**
 * Os e-mails de `coordenadores_gerais`, normalizados e JÁ cruzados com a
 * allowlist.
 *
 * O cruzamento acontece aqui, na LEITURA, e de novo na ESCRITA
 * (`aplicarAcessos_`), e a repetição é de propósito: o NÍVEL NUNCA É PORTA. Um
 * e-mail que esteja nesta chave e não esteja em `admin_emails` é inerte — quem
 * decide quem entra é `emailAutorizado_`, e continua sendo só ele. É o que
 * dispensa transação entre as duas chaves: a ordem em que são lidas não muda
 * resposta nenhuma, e uma delas escrita sozinha não abre porta para ninguém.
 *
 * Custo: ZERO leituras além da que já ia acontecer. As duas chaves moram no
 * mesmo documento de configuração, e `lerConfig` o cacheia pela execução inteira
 * (03_Config.gs). Foi o que permitiu ler o nível fresco a cada requisição, em
 * vez de guardá-lo na sessão.
 */
function coordenadoresGerais_() {
  var allowlist = adminEmails_();
  return config('coordenadores_gerais', '').split(',')
    .map(function (e) { return normalizarEmail(e); })
    .filter(function (e) { return e && allowlist.indexOf(e) !== -1; });
}

/**
 * O nível de um e-mail DENTRO de duas listas dadas: 'coordenador', 'professor'
 * ou '' (ninguém).
 *
 * Recebe as listas em vez de lê-las para poder responder sobre o PASSADO: é
 * assim que `aplicarAcessos_` descobre quem mudou de nível numa gravação,
 * comparando a mesma regra aplicada ao antes e ao depois. Uma segunda definição
 * de "quem é coordenador", escrita à mão para o diff, seria a que um dia
 * discordaria desta — e o sintoma é a sessão que não cai quando devia.
 *
 * `gerais` já vem cruzada com a allowlist (ver `coordenadoresGerais_`).
 *
 * O PISO, e ele é a migração inteira: lista de gerais VAZIA quer dizer que
 * ninguém separou os níveis ainda, e nesse estado todo mundo é coordenador
 * geral — que é o sistema de hoje, byte a byte. Implantar esta peça sem tocar no
 * banco não muda nada para ninguém, e essa promessa é o que o teste da migração
 * nula cobra.
 *
 * A ORDEM — piso ANTES da allowlist — é decisão, e o plano a tinha ao contrário.
 * Com a chave vazia, uma sessão válida vale como coordenadora mesmo que a
 * allowlist não reconheça o e-mail dela. Esse estado não existe em produção: as
 * três portas só criam sessão para quem está na allowlist (`liberarAcesso`
 * repõe o e-mail nela antes), e quem sai da lista perde a sessão na hora. Ele
 * existe nos TESTES, que fabricam sessão com `criarSessao_` sem semear lista
 * nenhuma — e perguntar a allowlist primeiro faria a chave nova, com o valor
 * vazio de fábrica, RECUSAR o que o sistema de hoje aceita. Medido: com a ordem
 * invertida, 79 testes da suíte de hoje caem — 63 deles em painel-navegador.js,
 * que é a tela inteira. Preferir o piso é manter a promessa da migração nula
 * onde ela é conferida. Com a chave preenchida — o estado a partir do primeiro
 * gesto de nível — a allowlist volta a ser conferida, e o e-mail fantasma não é
 * nada, que é o que o teste do nível-não-é-porta cobra.
 */
function nivelEm_(email, allowlist, gerais) {
  var alvo = normalizarEmail(email);
  if (!alvo) return '';
  if (!gerais.length) return 'coordenador';
  if (gerais.indexOf(alvo) !== -1) return 'coordenador';
  return allowlist.indexOf(alvo) === -1 ? '' : 'professor';
}

/**
 * O nível de um e-mail AGORA, lido do banco.
 *
 * LIDO A CADA REQUISIÇÃO, e nunca guardado na sessão. Guardá-lo criaria um
 * estado sem resposta — a sessão aberta ANTES de a chave existir não teria
 * nível, e escolher um padrão para ela é escolher entre o privilégio sobreviver
 * oito horas à despromoção ou todo mundo virar professor no dia do deploy — e
 * faria cada mudança de nível levar até oito horas para valer.
 *
 * MODO DE FALHA: se a configuração não puder ser lida (Firestore fora do ar), a
 * resposta é '' e NINGUÉM é coordenador. É o lado certo para uma decisão de
 * autorização cair, e o mesmo lado que `entrarComGoogle` escolhe para falha de
 * rede. Não custa disponibilidade nenhuma: com o banco fora, as funções de
 * coordenação já não tinham o que fazer.
 */
function nivelDe_(email) {
  try {
    return nivelEm_(email, adminEmails_(), coordenadoresGerais_());
  } catch (e) {
    console.error('nivelDe_: ' + e.message);
    return '';
  }
}

/** O nível de quem abriu a sessão. É por aqui que a cobrança pergunta. */
function nivelDaSessao_(token) {
  return nivelDe_(emailDaSessao_(token));
}

/** O rótulo do nível, para a trilha e para a tela. */
function rotuloDoNivel_(nivel) {
  return nivel === 'coordenador' ? 'coordenador geral' : (nivel || 'sem acesso');
}

/** A lista de acesso como a tela precisa dela: um e-mail e o nível de cada um. */
function pessoasDoAcesso_(allowlist, gerais) {
  return allowlist.map(function (email) {
    return { email: email, nivel: nivelEm_(email, allowlist, gerais) };
  });
}

/**
 * CONGELA O ESTADO DE HOJE antes do primeiro gesto que mexe no acesso.
 *
 * O furo que ela fecha: "gerais vazia = todos coordenadores" (o piso) e "quem
 * entra na lista nasce professor" são incompatíveis enquanto a chave estiver
 * vazia. Com ela vazia — o estado do dia 1 —, incluir alguém e gravar a lista de
 * gerais ainda vazia criaria um coordenador em silêncio, que é o pedido da
 * coordenação ao contrário. E rebaixar alguém gravando `[]` faria o piso
 * devolvê-lo a coordenador: o clique não teria efeito nenhum, e a tela diria
 * "salvo".
 *
 * Então o primeiro gesto que mexe no acesso escreve, por extenso, quem já era
 * coordenador — que é todo mundo que estava na lista até então.
 *
 * São TRÊS os gestos que a disparam, e não um: rebaixar (`definirNivel`),
 * incluir (`incluirAdmin`) e o campo de texto que acrescenta gente
 * (`regravarAllowlist_`). Cada um tem teste próprio.
 */
function materializar_(allowlistAntes, gerais) {
  if (gerais && gerais.length) return gerais.slice();
  return allowlistAntes.slice();
}

/** Reparte, normaliza e tira vazios e repetidos de uma lista de e-mails. */
function listaDeEmails_(bruto) {
  var lista = [];
  var partes = Object.prototype.toString.call(bruto) === '[object Array]'
    ? bruto
    : String(bruto || '').split(',');

  partes.forEach(function (item) {
    var email = normalizarEmail(item);
    if (email && lista.indexOf(email) === -1) lista.push(email);
  });
  return lista;
}

/**
 * O ÚNICO ESCRITOR das duas listas de acesso, e onde mora a invariante do último
 * coordenador geral.
 *
 * A invariante é uma frase: **a lista nunca fica sem nenhum coordenador geral**.
 * Um painel com oito professores é tão trancado por fora quanto um painel com a
 * allowlist vazia — ninguém configura, ninguém importa, ninguém devolve acesso a
 * ninguém —, e a saída é a mesma: o editor do Apps Script, que nem todo
 * professor tem.
 *
 * ELA MORA AQUI DENTRO, e não nas quatro portas que mexem em nível, pela lição
 * que este repositório já escreveu em `gravarConfig`: uma guarda espalhada por
 * quatro caminhos é uma guarda que o QUINTO caminho — o que ainda não existe —
 * vai esquecer. Os quatro de hoje (`definirNivel`, `removerAdmin`, o campo
 * `admin_emails` e o campo `coordenadores_gerais`) não escrevem por conta
 * própria; todos passam por aqui.
 *
 * O CRUZAMENTO das duas listas fecha o fantasma da volta: remover um professor e
 * recadastrá-lo meses depois não pode trazê-lo de volta como coordenador por
 * causa de uma linha que ficou na outra chave e que ninguém lembra.
 *
 * `porta` é o detalhe que vai para a trilha, e ele diz POR ONDE — 'pela tela
 * Quem tem acesso', 'pelo campo admin_emails'. Por QUEM é a coluna `usuario`,
 * que `exigirAdmin` preenche (04_Log.gs); repetir o e-mail no detalhe seria
 * escrevê-lo duas vezes na mesma linha. A porta, essa sim, a coluna não tem como
 * saber — e é ela que separa o mesmo gesto feito em duas telas diferentes.
 *
 * A recusa sai com `motivo`, e a frase aqui é genérica: quem sabe dizer a frase
 * certa é o gesto (rebaixar a si mesmo não é a mesma coisa que esvaziar um campo
 * de texto), e cada chamador a reescreve. O que NÃO se delega é a decisão.
 */
function aplicarAcessos_(emails, gerais, porta) {
  var antesLista = adminEmails_();
  var antesGerais = coordenadoresGerais_();

  var lista = listaDeEmails_(emails);
  // O cruzamento: o nível não é porta nem na escrita, e um nome que ficou na
  // outra chave não pode voltar a valer no dia em que a pessoa for recadastrada.
  var chefes = listaDeEmails_(gerais).filter(function (e) { return lista.indexOf(e) !== -1; });

  if (!lista.length) {
    return {
      ok: false,
      motivo: 'SEM_NINGUEM',
      erro: 'Esvaziar a lista tranca todo mundo do lado de fora: é ela que autoriza tanto o ' +
            'botão do Google quanto o envio do link por e-mail. Deixe pelo menos um e-mail.'
    };
  }

  // A INVARIANTE. `antesGerais` vazia é o piso — ali todo mundo é coordenador, e
  // continuar sem nenhum nome escrito não deixa o painel sem dono.
  if (antesGerais.length && !chefes.length) {
    return {
      ok: false,
      motivo: 'SEM_COORDENADOR',
      erro: 'Esta mudança deixaria o painel sem nenhum coordenador geral: ninguém para ' +
            'configurar, importar ou devolver o acesso a alguém. Promova outra pessoa antes.'
    };
  }

  gravarAcessos_(lista, chefes);

  antesLista.forEach(function (email) {
    if (lista.indexOf(email) !== -1) return;
    // Tirar da lista e deixar entrar por mais oito horas é não ter tirado.
    invalidarSessoesDe_(email);
    registrar('ADMIN_REMOVIDO', 'config', email, porta);
  });

  lista.forEach(function (email) {
    if (antesLista.indexOf(email) === -1) {
      registrar('ADMIN_INCLUIDO', 'config', email, porta);
      return;
    }

    var antes = nivelEm_(email, antesLista, antesGerais);
    var depois = nivelEm_(email, lista, chefes);
    if (antes === depois) return;

    // Mudou de nível: a sessão cai, pela mesma razão de quem sai da lista — sem
    // isso a tela dela fica errada por até oito horas, e cada clique vira uma
    // recusa que ela não tem como explicar.
    invalidarSessoesDe_(email);
    registrar('NIVEL_ALTERADO', 'config', email,
      rotuloDoNivel_(antes) + ' -> ' + rotuloDoNivel_(depois) + ', ' + porta);
  });

  return { ok: true, emails: lista, gerais: chefes, pessoas: pessoasDoAcesso_(lista, chefes) };
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
    return respostaDoAcesso_(adminEmails_(), coordenadoresGerais_(), payload.token);
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * A resposta que as QUATRO funções do cartão "Quem tem acesso" devolvem.
 *
 * Tem de ser a mesma nas quatro (`listarAdmins`, `incluirAdmin`, `removerAdmin`
 * e `definirNivel`) porque é a mesma `desenharAcesso()` que redesenha a tabela
 * depois de cada uma. Uma que devolvesse a forma antiga apagaria a coluna Nível
 * depois de incluir alguém — defeito que passa em teste de unidade e aparece no
 * dedo de quem usa.
 *
 * `emails` continua vindo junto, e não é gordura: ele é o contrato de hoje, e
 * um teste afirma que as duas formas concordam. `seuNivel` é o que permite à
 * tela saber com que nível ela está desenhada sem uma segunda chamada.
 */
function respostaDoAcesso_(lista, gerais, token, extras) {
  var voce = emailDaSessao_(token);
  var resposta = {
    ok: true,
    emails: lista,
    pessoas: pessoasDoAcesso_(lista, gerais),
    voce: voce,
    seuNivel: nivelEm_(voce, lista, gerais)
  };

  Object.keys(extras || {}).forEach(function (chave) { resposta[chave] = extras[chave]; });
  return resposta;
}

/**
 * Acrescenta um e-mail à allowlist. Repetido não é erro, é nada a fazer.
 *
 * QUEM ENTRA NASCE PROFESSOR, e é por isso que ela materializa (ver
 * `materializar_`): com a lista de gerais ainda vazia, gravar só a allowlist
 * nova deixaria o piso valendo e o recém-chegado nasceria podendo tudo — que é
 * o pedido da coordenação ao contrário. Promover é um segundo gesto, com
 * confirmação própria (`definirNivel`): padrão que se escolhe não é padrão.
 *
 * Cobra por dentro (`exigirCoordenador`) porque CONCEDE PODER. As quatro da
 * coroa pagam essa conferência aqui além da do despacho; ver `exigirCoordenador`.
 */
function incluirAdmin(payload) {
  try {
    exigirCoordenador(payload && payload.token);
    payload = payload || {};

    var email = normalizarEmail(payload.email);
    if (!emailValido(email)) {
      return { ok: false, erro: 'Informe um e-mail válido.' };
    }

    var lista = adminEmails_();
    var gerais = coordenadoresGerais_();
    // Comparação sem diferenciar maiúsculas porque `adminEmails_` já normalizou
    // os dois lados. 'Coordenacao@Exemplo.com' e 'coordenacao@exemplo.com' são a
    // MESMA conta no Google, e deixá-las virar duas linhas faria a remoção de
    // uma delas parecer que não funcionou.
    if (lista.indexOf(email) !== -1) {
      return respostaDoAcesso_(lista, gerais, payload.token, { jaEstava: true });
    }

    // Os que JÁ estavam congelam como coordenadores; o que chega fica de fora da
    // lista congelada, e é isso que o faz nascer professor.
    var congelados = materializar_(lista, gerais);
    lista.push(email);

    var r = aplicarAcessos_(lista, congelados, 'pela tela Quem tem acesso');
    if (!r.ok) return { ok: false, erro: r.erro };

    return respostaDoAcesso_(r.emails, r.gerais, payload.token, {
      nivel: nivelEm_(email, r.emails, r.gerais)
    });
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
 * A TERCEIRA GUARDA não está escrita aqui de propósito: tirar da lista o último
 * COORDENADOR GERAL (com sete professores sobrando) passa pelas duas de cima — a
 * lista não fica vazia, e quem pede não é o último — e produz um painel sem
 * dono. Quem recusa isso é `aplicarAcessos_`, onde a invariante mora para que
 * nenhum dos quatro caminhos possa esquecê-la. Aqui só se traduz a frase.
 *
 * Cobra por dentro (`exigirCoordenador`) porque REVOGA PODER.
 *
 * Quem sai perde a sessão junto (`invalidarSessoesDe_`). Sem isso, "remover o
 * acesso" continuaria valendo por até oito horas — que é o tempo em que a pessoa
 * removida ainda poderia exportar o cadastro inteiro. Tirar da lista e deixar
 * entrar é não ter tirado.
 */
function removerAdmin(payload) {
  try {
    exigirCoordenador(payload && payload.token);
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

    var gerais = coordenadoresGerais_();
    lista.splice(posicao, 1);

    // A sessão de quem sai, a linha da trilha e a invariante do último
    // coordenador moram todas em `aplicarAcessos_`, porque o campo de texto da
    // aba Configurações faz este mesmo gesto por outro caminho.
    var r = aplicarAcessos_(lista, gerais, 'pela tela Quem tem acesso');
    if (!r.ok) {
      if (r.motivo !== 'SEM_COORDENADOR') return { ok: false, erro: r.erro };
      return {
        ok: false,
        erro: 'Este é o último coordenador geral. Removê-lo deixa o painel com ' +
              lista.length + (lista.length === 1 ? ' professor' : ' professores') +
              ' e ninguém que possa configurar, importar ou devolver o acesso a alguém. ' +
              'Promova outra pessoa antes.'
      };
    }

    return respostaDoAcesso_(r.emails, r.gerais, payload.token);
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Promove ou rebaixa alguém que JÁ está na lista de acesso.
 *
 * O segundo gesto que `incluirAdmin` deixou para trás, e o único que cria
 * coordenador geral pela tela. Cobra por dentro (`exigirCoordenador`) porque é
 * literalmente a função de conceder e revogar poder — qualquer coordenador
 * geral promove e rebaixa qualquer um, inclusive outro coordenador, com a única
 * trava de a lista nunca ficar sem nenhum.
 *
 * Ela materializa (ver `materializar_`) porque rebaixar com a chave vazia e
 * gravar `[]` faria o piso devolver a pessoa a coordenador: o clique não teria
 * efeito nenhum, e a tela diria "salvo".
 *
 * A sessão de quem mudou de nível cai — quem faz isso é `aplicarAcessos_`,
 * comparando o nível de antes com o de depois.
 */
function definirNivel(payload) {
  try {
    exigirCoordenador(payload && payload.token);
    payload = payload || {};

    var email = normalizarEmail(payload.email);
    var nivel = String(payload.nivel || '').trim().toLowerCase();

    // O nível vem do cliente e é conferido contra os DOIS valores que existem.
    // Não há terceiro, e uma palavra desconhecida não pode virar "professor por
    // omissão" nem "coordenador por omissão": as duas seriam uma decisão de
    // acesso tomada por um erro de digitação.
    if (nivel !== 'coordenador' && nivel !== 'professor') {
      return { ok: false, erro: 'Nível desconhecido. Os níveis são coordenador e professor.' };
    }

    var lista = adminEmails_();
    if (lista.indexOf(email) === -1) {
      return { ok: false, erro: 'Esse e-mail não está na lista de acesso.' };
    }

    var gerais = materializar_(lista, coordenadoresGerais_());
    var posicao = gerais.indexOf(email);
    if (nivel === 'coordenador') {
      if (posicao === -1) gerais.push(email);
    } else if (posicao !== -1) {
      gerais.splice(posicao, 1);
    }

    var quemPede = emailDaSessao_(payload.token);
    var r = aplicarAcessos_(lista, gerais, 'pela tela Quem tem acesso');
    if (!r.ok) {
      if (r.motivo !== 'SEM_COORDENADOR') return { ok: false, erro: r.erro };
      if (email === quemPede) {
        return {
          ok: false,
          erro: 'Você é o único coordenador geral. Promova outra pessoa antes de virar ' +
                'Professor — senão ninguém mais mexe em configuração, na lista de acesso ' +
                'nem nas importações, e o conserto sai da tela e vai para o editor do ' +
                'Apps Script.'
        };
      }
      return {
        ok: false,
        erro: 'Este é o último coordenador geral. Promova outra pessoa antes de rebaixar ' +
              'esta — senão ninguém mais mexe em configuração, na lista de acesso nem nas ' +
              'importações.'
      };
    }

    return respostaDoAcesso_(r.emails, r.gerais, payload.token, {
      nivel: nivelEm_(email, r.emails, r.gerais)
    });
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

  // Quem CHEGA pelo campo de texto nasce professor, como quem chega pelo botão
  // Incluir — e é a materialização que faz isso valer com a chave ainda vazia.
  // Sem gente nova, nada a congelar: mexer na lista de gerais para só tirar
  // alguém seria escrever uma decisão que ninguém tomou.
  var entrando = depois.filter(function (e) { return antes.indexOf(e) === -1; });
  var gerais = coordenadoresGerais_();
  var congelados = entrando.length ? materializar_(antes, gerais) : gerais;

  // A sessão de quem saiu, as linhas da trilha e a invariante do último
  // coordenador são as mesmas de `removerAdmin`, e moram no mesmo lugar. O
  // detalhe é que muda: é o campo de texto, e não a tela de acesso, que
  // distingue esta saída daquela.
  var r = aplicarAcessos_(depois, congelados, 'pelo campo admin_emails');
  if (!r.ok) {
    if (r.motivo !== 'SEM_COORDENADOR') return { ok: false, erro: r.erro };
    return {
      ok: false,
      erro: 'A lista ficaria com ' + depois.length +
            (depois.length === 1 ? ' professor' : ' professores') +
            ' e nenhum coordenador geral: ninguém para configurar, importar ou devolver o ' +
            'acesso a alguém. Nada foi alterado — corrija e salve de novo, ou use ' +
            'Configurações > Quem tem acesso.'
    };
  }

  return { ok: true, emails: r.emails, pessoas: r.pessoas };
}

/**
 * Regrava a lista de COORDENADORES GERAIS, pelo campo de texto da aba
 * Configurações.
 *
 * Irmã de `regravarAllowlist_`, e existe pela mesma razão: a chave aparece na
 * tela de Configurações de qualquer jeito — `lerConfiguracoes` lista toda chave
 * que exista no banco, e `chaveConhecida_` aceita para gravação toda chave que
 * exista no banco —, então ou ela tem uma porta com guardas, ou ela é a porta
 * dos fundos de todas as guardas desta peça.
 *
 * DUAS RECUSAS, e nenhuma é zelo:
 *
 *   1. CAMPO VAZIO. Na leitura, lista vazia é o piso, e o piso devolve poder
 *      total a todo mundo (ver `nivelEm_`). Apagar o conteúdo deste campo seria,
 *      então, promover os oito de uma vez — com a tela dizendo "salvo". O piso
 *      continua existindo, mas como rede para banco editado à mão pelo console
 *      do Firestore; NENHUM caminho de tela consegue produzi-lo;
 *   2. E-MAIL FORA DA LISTA DE ACESSO. Ele seria inerte (o nível não é porta),
 *      e é justamente por ser inerte que precisa recusar: quem digita o e-mail
 *      de alguém aqui e vê "salvo" acredita ter dado acesso a essa pessoa.
 *
 * Como em `regravarAllowlist_`, o campo é recusado INTEIRO — nada de gravar
 * metade e descartar o resto em silêncio.
 */
function regravarGerais_(valor, token) {
  var lista = adminEmails_();
  var pedidos = [];
  var forasteiros = [];

  String(valor || '').split(',').forEach(function (bruto) {
    var email = normalizarEmail(bruto);
    if (!email) return;
    if (lista.indexOf(email) === -1) {
      if (forasteiros.indexOf(email) === -1) forasteiros.push(email);
      return;
    }
    if (pedidos.indexOf(email) === -1) pedidos.push(email);
  });

  if (forasteiros.length) {
    return {
      ok: false,
      erro: 'Fora da lista de acesso: ' + forasteiros.join(', ') + '. Quem não entra no ' +
            'painel não pode ser coordenador geral — inclua primeiro em Configurações > ' +
            'Quem tem acesso. Nada foi alterado.'
    };
  }

  if (!pedidos.length) {
    return {
      ok: false,
      erro: 'Esvaziar este campo devolve poder total a todos os ' + lista.length +
            ' e-mails da lista de acesso. Se é isso que você quer, promova um por um em ' +
            'Configurações > Quem tem acesso. Nada foi alterado.'
    };
  }

  var r = aplicarAcessos_(lista, pedidos, 'pelo campo coordenadores_gerais');
  if (!r.ok) return { ok: false, erro: r.erro };

  return { ok: true, emails: r.emails, pessoas: r.pessoas };
}

/**
 * Como um DOCUMENTO nomeia quem agiu: `anulado_por`, `excluido_por`,
 * `cancelado_por`, `revisado_por`.
 *
 * Não é mais quem assina a trilha — isso virou a coluna `usuario`, preenchida
 * pelo operador que `exigirAdmin` anota (04_Log.gs). Ela fica porque o campo
 * gravado no documento é outra coisa: ele sobrevive à retenção de um ano do
 * log e viaja junto com a cópia (a inscrição anulada, o matriculado excluído),
 * onde não há coluna nenhuma para consultar.
 *
 * O fallback ficou INALCANÇÁVEL de propósito e continua aqui: desde que o PIN
 * saiu, as três portas gravam um e-mail na sessão, então `emailDaSessao_` sempre
 * responde. Ele é a rede embaixo do trapézio — o dia em que uma sessão sem nome
 * aparecer, o documento diz isso em vez de gravar um campo em branco e deixar a
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
