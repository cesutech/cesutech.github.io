/**
 * 07b_LinkPorEmail.gs — a porta de recuperação do painel.
 *
 * ================================ POR QUE ELA EXISTE =========================
 *
 * O caminho normal de entrada é "Entrar com o Google" (07_Auth.gs). Ele é bom, e
 * tem um defeito que não dá para consertar de dentro dele: ele depende de coisas
 * que estão FORA deste sistema. Um client id trocado no console, uma tela de
 * consentimento que expirou, um domínio que mudou, a conta institucional que
 * ainda não existe — em qualquer um desses dias o botão para de funcionar, e
 * quem administra o sistema fica do lado de fora dele.
 *
 * O PIN existia para esse dia. Ele foi removido, e a conta de por que está no
 * bloco seguinte.
 *
 * O que ficou no lugar prova uma coisa diferente das outras duas portas:
 *
 *   Entrar com o Google   prova IDENTIDADE      (o `aud` do token é nosso)
 *   Link por e-mail       prova POSSE DA CAIXA  (só quem abre o e-mail entra)
 *   `liberarMeuAcesso()`  prova ACESSO AO ARQUIVO do projeto no Apps Script
 *
 * As três são independentes de propósito. Derrubar uma não fecha as outras — e é
 * essa independência, e não a força individual de cada uma, que faz o painel não
 * ter como ficar trancado por fora.
 *
 * ============================ POR QUE O PIN SAIU =============================
 *
 * Um PIN é um segredo compartilhado, e segredo compartilhado tem três problemas
 * que nenhum freio conserta:
 *
 *   1. ele é ADIVINHÁVEL. Com o repositório público, o desenho do freio é
 *      conhecido por quem quiser ler, e a rota que o recebia é anônima. Seis
 *      dígitos são um milhão de combinações contra um atacante que não tem
 *      pressa;
 *   2. ele se PERDE. Ninguém troca o PIN de um sistema que usa três vezes por
 *      semestre, e a pessoa que o sabia é a que saiu da coordenação;
 *   3. ele não diz QUEM entrou. Sessão aberta por PIN gravava 'anonimo' no log,
 *      e um registro de auditoria que não identifica ninguém não é registro.
 *
 * O link por e-mail não tem nenhum dos três: não há o que adivinhar (o token
 * nasce e morre em quinze minutos), não há o que perder (a caixa institucional
 * sobrevive à pessoa), e ele identifica exatamente um endereço da allowlist.
 *
 * ======================= AS DUAS DECISÕES QUE SUSTENTAM ISTO =================
 *
 * PRIMEIRA: a resposta é a MESMA, esteja o endereço na allowlist ou não.
 *
 * É a decisão mais importante do arquivo, e a mais fácil de estragar por
 * gentileza. Responder "este e-mail não tem acesso" seria simpático e
 * transformaria esta rota — anônima, pública — num oráculo que responde "quem
 * administra o CESUTECH?" a quem perguntar. Quem já está na lista não aprende
 * nada com a frase genérica: o link chega na caixa dele. Quem não está não
 * aprende nada também. É exatamente esse o ponto.
 *
 * SEGUNDA: o freio é POR ENDEREÇO, nunca global.
 *
 * O freio do PIN era um contador único para o sistema inteiro, e por isso um
 * estranho conseguia, de graça, atrasar quem sabia o PIN. Aqui, esgotar o freio
 * de um endereço não encosta no de outro — e não encosta, em hipótese nenhuma,
 * no botão do Google.
 *
 * A primeira versão deste arquivo ERRAVA nisto, e o erro tinha a forma exata do
 * que a frase acima condena. O teto global de pedidos por hora vinha antes de
 * tudo, para proteger a leitura do Firestore que a conferência da allowlist
 * custava — e sessenta requisições anônimas com endereços inventados fechavam a
 * porta para todo mundo até virar a hora. Num sistema cuja porta de recuperação
 * existe para o dia em que a principal falha, isso entregava a um estranho a
 * decisão de se a coordenação entra.
 *
 * O conserto não foi afrouxar o teto: foi tirar o CUSTO que obrigava a ordem. A
 * allowlist passou a ficar em cache (`allowlistParaLink_`), e conferir um
 * endereço deixou de custar leitura.
 *
 * E aí O TETO GLOBAL FOI REMOVIDO INTEIRO, que é a parte contraintuitiva. Ele
 * existia para proteger a cota de leitura; com o cache, um endereço de fora
 * custa ZERO leitura, e não sobrou recurso compartilhado a proteger — as únicas
 * leituras deste caminho são as ~12 por hora que recarregam o cache. Mantê-lo
 * "por segurança" seria deixar de pé exatamente o botão de desligar descrito
 * acima, guardando um recurso que já não corre risco. Não há mais, aqui, nenhum
 * freio que uma pessoa possa acionar contra outra.
 *
 * O que sobrou de global é o modo degradado: sem CacheService esta porta FECHA
 * (ver `pedirLinkDeAcesso`). Fecha para todos, inclusive para quem a atacaria, e
 * o `liberarMeuAcesso()` do editor não passa por aqui.
 */

/**
 * Quanto tempo o link vale.
 *
 * Quinze minutos é o intervalo entre "pedi" e "abri o e-mail no celular". Mais
 * do que isso alonga a janela em que o token está parado numa caixa de entrada
 * — que é o lugar por onde ele pode vazar (encaminhamento, um scanner
 * corporativo, um telefone destrancado em cima da mesa).
 */
var LINK_VALIDADE_MS = 15 * 60 * 1000;

/**
 * Intervalo mínimo entre dois envios PARA O MESMO ENDEREÇO.
 *
 * Existe contra o uso do sistema como ferramenta de incômodo: sem ele, um laço
 * de terminal enche a caixa do professor com links legítimos, assinados por nós,
 * até a cota diária de envio acabar. Dois minutos não atrapalham ninguém de
 * verdade — quem não recebeu confere o spam antes disso — e derrubam o volume de
 * "quantas vezes eu conseguir" para trinta por hora, no endereço de uma pessoa
 * que já tem acesso.
 */
var LINK_INTERVALO_MS = 2 * 60 * 1000;

/**
 * Teto de envios por endereço, por dia.
 *
 * O intervalo acima limita a RAJADA; este limita o DIA. Os dois juntos são o que
 * mantém o consumo previsível: com a allowlist real (meia dúzia de pessoas), o
 * pior caso concebível são algumas dezenas de mensagens — bem abaixo das 100
 * diárias que uma conta Gmail comum permite, que é a cota que este número existe
 * para não estourar. Ver `MailApp.getRemainingDailyQuota()` em `enviarLink_`.
 */
var LINK_TETO_DIA = 8;

/**
 * A resposta única.
 *
 * Uma frase só, para todos os desfechos possíveis do pedido: endereço fora da
 * allowlist, endereço dentro mas freado, cota de envio esgotada, e o caso bom em
 * que a mensagem saiu. Se algum dia alguém acrescentar um `erro` diferente em
 * qualquer um desses ramos, o oráculo volta a existir — é por isso que a frase é
 * uma constante e não um literal repetido.
 */
var LINK_RESPOSTA_UNICA =
  'Se este endereço estiver autorizado, enviamos um link de acesso para ele. ' +
  'Confira a caixa de entrada e, se não achar, o spam. O link vale por 15 minutos.';

/** Tamanho máximo aceito antes de qualquer trabalho. Endereço real não passa disso. */
var LINK_EMAIL_MAX = 254;

/**
 * Pede um link de acesso. ROTA ANÔNIMA — qualquer pessoa na internet chama isto.
 *
 * A ordem dos passos é a defesa, e ela vai do mais barato para o mais caro:
 * formato (nada), allowlist (nada, vem do cache), freio do endereço
 * (propriedade), envio (cota de e-mail). Um pedido de lixo morre no primeiro
 * passo; um pedido de endereço alheio morre no segundo, sem gravar nada, sem
 * enviar nada e — o que importa — SEM CUSTAR LEITURA NENHUMA. É isso que tira
 * de um atacante qualquer motivo para insistir nesta rota.
 *
 * Devolve SEMPRE `{ ok: true, mensagem: LINK_RESPOSTA_UNICA }`. Nenhum ramo
 * abaixo pode mudar isso — ver a PRIMEIRA decisão, no topo do arquivo.
 */
function pedirLinkDeAcesso(email) {
  var resposta = { ok: true, mensagem: LINK_RESPOSTA_UNICA };

  try {
    var alvo = normalizarEmail(email);

    // Passo 1 — formato. Barato de propósito: barra o laço de terminal antes de
    // ele encostar em qualquer outra coisa.
    if (!alvo || alvo.length > LINK_EMAIL_MAX || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alvo)) {
      return resposta;
    }

    // Passo 2 — a allowlist, e ela vem ANTES do teto global. A ordem é a
    // correção de um defeito de desenho, e vale explicar porque a ordem oposta é
    // a intuitiva.
    //
    // Antes, o teto global vinha primeiro, para proteger a leitura do Firestore.
    // O efeito colateral era grave: sessenta requisições anônimas com endereços
    // inventados — um laço de `curl` — fechavam esta porta para TODO MUNDO até
    // virar a hora, repetível para sempre e de graça. E esta porta existe
    // exatamente para o dia em que o botão do Google não funciona; nesse dia,
    // quem decidiria se a coordenação entra seria o atacante. É a mesma forma do
    // freio global do PIN que o topo deste arquivo critica, só que vestida de
    // freio de orçamento.
    //
    // A raiz do problema era o CUSTO da conferência, não a ordem. Com a lista em
    // cache (`allowlistParaLink_`), conferir passou a ser de graça, e o teto
    // deixou de precisar vir primeiro. Quem está na lista nunca encosta nele.
    var conferencia = allowlistParaLink_();

    if (conferencia === null) {
      // O CACHE ESTÁ FORA DO AR, e esta porta FECHA — explicitamente, que é o
      // ponto. Numa versão anterior ela fechava também, mas por acidente: a
      // conferência do teto global não tinha `try/catch`, a exceção subia até o
      // `catch` lá embaixo, e a pessoa lia "enviamos um link" sem que nada
      // tivesse sido enviado, sem log e sem ninguém saber por quê.
      //
      // Fecha porque as duas alternativas são piores, e vale dizer quais são:
      // sem cache, conferir a allowlist volta a custar uma leitura do Firestore
      // por requisição — e uma enxurrada anônima gastaria a cota que o
      // FORMULÁRIO DO ALUNO usa, derrubando a razão de o sistema existir para
      // salvar a porta dos fundos. Registrar cada recusa também não serve: o
      // agrupamento de `registrarRecusa` depende do mesmo cache, e sob
      // enxurrada viraria uma escrita por requisição.
      //
      // O `console.error` é de graça e não tem cota. E `liberarMeuAcesso()`, no
      // editor, não passa por aqui: a última porta continua aberta, que é
      // exatamente para isto que ela existe.
      console.error('pedirLinkDeAcesso: CacheService indisponível — o link por e-mail ' +
        'não sai nesta execução. Entre pelo Google, ou rode liberarMeuAcesso() no editor.');
      return resposta;
    }

    // Endereço de fora para AQUI: não envia, não grava, não registra nada com o
    // endereço dentro. Registrar seria construir, no log, a lista de quem alguém
    // andou tentando — que é dado que não queremos ter. E não custa leitura
    // nenhuma, que é o que tira deste caminho o valor de atacá-lo.
    if (conferencia.lista.indexOf(alvo) === -1) return resposta;

    // Passo 3 — o freio do endereço. Silencioso: quem pediu duas vezes seguidas
    // lê a mesma frase da primeira, e não "calma lá". A diferença importaria só
    // para quem está automatizando.
    if (!freioDoLinkLibera_(alvo)) {
      registrarRecusa('LINK_FREIO', 'painel', alvo,
        'pedidos de link acima do permitido para o endereço', 'link_freio_' + alvo);
      return resposta;
    }

    enviarLink_(alvo);
    return resposta;
  } catch (err) {
    // Erro também devolve a frase única. Um "erro interno" que aparecesse só
    // para endereços da allowlist seria o oráculo entrando pela janela.
    console.error('pedirLinkDeAcesso: ' + err.message);
    return resposta;
  }
}

/**
 * Emite o token, guarda a impressão digital dele e manda a mensagem.
 *
 * O QUE FICA GUARDADO É O HASH, e não o token. A diferença aparece no dia ruim:
 * quem conseguir ler as Propriedades do script (um script colega no mesmo
 * projeto, um despejo de depuração, alguém com acesso ao editor) leva uma lista
 * de hashes que não serve para entrar em lugar nenhum. É a mesma razão pela qual
 * um sistema não guarda a senha de ninguém.
 *
 * UM TOKEN VIVO POR ENDEREÇO. O ponteiro `linkde_<email>` existe só para achar e
 * apagar o anterior sem varrer as propriedades: pedir um link novo invalida o
 * antigo na hora. Sem isso, cada pedido deixaria mais uma chave válida por
 * quinze minutos, e a janela de exposição cresceria com a impaciência de quem
 * clicou duas vezes.
 */
function enviarLink_(email) {
  var props = PropertiesService.getScriptProperties();

  // A cota de envio é do Google e não se recupera antes da meia-noite. Chegar ao
  // fim dela em silêncio é pior do que não enviar: o log é o que permite alguém
  // entender, no dia seguinte, por que o link "não chegou".
  // A FAXINA VEM ANTES DA COTA, e a ordem não é estética. Ela rodava só no
  // envio bem-sucedido, então o dia em que a cota acabasse era exatamente o dia
  // em que os links vencidos parariam de ser apagados — e é o dia de mais
  // pedidos, porque é o dia em que ninguém está conseguindo entrar.
  faxinaLinks_();

  if (MailApp.getRemainingDailyQuota() <= 0) {
    registrar('LINK_SEM_COTA', 'painel', email,
      'cota diária de envio de e-mail esgotada — link não enviado');
    return;
  }

  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var impressao = impressaoDoLink_(token);
  var agoraMs = new Date().getTime();

  var anterior = props.getProperty('linkde_' + email);
  if (anterior) props.deleteProperty('link_' + anterior);

  props.setProperty('link_' + impressao, JSON.stringify({
    email: email,
    expira_em: agoraMs + LINK_VALIDADE_MS
  }));
  props.setProperty('linkde_' + email, impressao);

  MailApp.sendEmail({
    to: email,
    subject: 'CESUTECH — seu link de acesso ao painel',
    body: corpoDoEmail_(token),
    name: 'Painel CESUTECH'
  });

  registrar('LINK_ENVIADO', 'painel', email, 'link de acesso enviado');
}

/**
 * O texto da mensagem.
 *
 * Escrito para NÃO parecer golpe, que é um risco real e não um detalhe de
 * cortesia: o e-mail sai da conta pessoal de quem implantou o projeto (hoje o
 * Jonathan, depois a conta institucional), e um link com um código enorme,
 * chegando de um remetente que a pessoa não reconhece, é exatamente a forma de
 * um ataque de phishing. Por isso a mensagem diz de onde veio, o que a pessoa
 * tinha acabado de fazer, e o que fazer se ela não fez nada.
 *
 * A última linha é a que mais importa, e é a única que o sistema tem para
 * avisar que alguém está tentando entrar: quem recebe sem ter pedido não precisa
 * fazer nada — o link morre sozinho — mas precisa contar.
 */
function corpoDoEmail_(token) {
  var url = urlDoPainel_() + '?entrar=' + token;

  return [
    'Alguém pediu um link para entrar no painel de gestão do CESUTECH usando este',
    'endereço de e-mail.',
    '',
    'Se foi você, abra o endereço abaixo. Ele vale por 15 minutos e só funciona uma vez:',
    '',
    url,
    '',
    'A página vai pedir que você confirme antes de entrar. Isso é de propósito.',
    '',
    '--',
    'Se você NÃO pediu este link, não faça nada: ele expira sozinho e ninguém entra',
    'no seu lugar. Mas avise a coordenação, porque significa que alguém digitou o seu',
    'endereço na tela de acesso.',
    '',
    'Esta mensagem foi enviada automaticamente pelo sistema do CESUTECH.'
  ].join('\n');
}

/**
 * Entra usando o token do link. ROTA ANÔNIMA.
 *
 * As conferências, e por que cada uma:
 *
 *   formato    barra lixo antes de tocar as propriedades;
 *   existe     o token não carrega estado nenhum — sem a linha guardada aqui,
 *              ele simplesmente não existe, e não há o que forjar;
 *   prazo      exige NÚMERO antes de comparar, pelo mesmo motivo de
 *              `tokenValido_`: `numero > undefined` é `false` em JavaScript, e
 *              um link sem prazo legível valeria para sempre;
 *   allowlist  CONFERIDA DE NOVO, agora. O link pode ter sido emitido para
 *              alguém que, nesses quinze minutos, saiu da coordenação. Quem
 *              tirou o acesso espera que ele tenha saído no ato;
 *   consumo    o token é apagado ANTES da sessão nascer. Um link que chegou ao
 *              fim não pode ser reusado nem que a criação da sessão falhe.
 *
 * A recusa é única, como no pedido: token inexistente, vencido e de alguém que
 * perdeu o acesso recebem a mesma frase. Ela não tem nada a esconder de quem
 * está com o link na mão, mas tem de quem está chutando.
 */
function entrarComLink(token) {
  var recusa = {
    ok: false,
    erro: 'Este link não vale mais. Peça um novo na tela de acesso — cada link ' +
          'funciona uma vez só e expira em 15 minutos.'
  };

  try {
    var chave = String(token || '').trim();
    if (!chave || !/^[0-9a-f]{64}$/.test(chave)) return recusa;

    var props = PropertiesService.getScriptProperties();
    var impressao = impressaoDoLink_(chave);
    var bruto = props.getProperty('link_' + impressao);
    if (!bruto) return recusa;

    var dados = JSON.parse(bruto);
    var email = normalizarEmail(dados && dados.email);
    var expiraEm = Number(dados && dados.expira_em);

    // Consumido aqui, aconteça o que acontecer daqui para baixo.
    props.deleteProperty('link_' + impressao);
    if (email) props.deleteProperty('linkde_' + email);

    if (!expiraEm || new Date().getTime() > expiraEm) return recusa;

    if (!email || !emailAutorizado_(email)) {
      registrar('LOGIN_NEGADO', 'painel', email || 'anonimo',
        'link válido, mas o endereço não está mais autorizado');
      return recusa;
    }

    registrar('LOGIN', 'painel', email, 'via link por e-mail');
    return { ok: true, token: criarSessao_(email), usuario: email, via: 'link' };
  } catch (err) {
    console.error('entrarComLink: ' + err.message);
    return recusa;
  }
}

/**
 * A impressão digital de um token: SHA-256 em hexadecimal.
 *
 * Sem sal, e de propósito. Sal defende contra tabela pré-computada, que é um
 * ataque contra segredo ADIVINHÁVEL — senha de gente. Aqui o segredo tem 244
 * bits vindos de `Utilities.getUuid()`, e não existe tabela que cubra isso.
 */
function impressaoDoLink_(token) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token))
    .map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); })
    .join('');
}

/**
 * O endereço do painel, para montar o link.
 *
 * Config, e não código, porque o endereço do painel pode mudar — outra conta,
 * um domínio próprio — e ninguém vai lembrar de reimplantar o Apps Script por
 * causa disso. O padrão existe para o sistema nunca enviar um link quebrado por
 * falta de configuração.
 */
function urlDoPainel_() {
  var url = String(config('url_painel', '')).trim();
  if (!url) url = 'https://cesutech.github.io/painel/';
  return url.charAt(url.length - 1) === '/' ? url : url + '/';
}

/**
 * O endereço pode receber um link agora?
 *
 * Só chega aqui quem está na allowlist, e isso é o que mantém o armazenamento
 * limitado: são tantas chaves quanto pessoas autorizadas, e não quantos
 * endereços um atacante conseguir digitar. Se esta conferência algum dia subir
 * para antes do passo 3, vira um jeito de encher as Propriedades do script de
 * fora.
 *
 * Ler-decidir-escrever sem serialização deixa passar rajada simultânea, o mesmo
 * caveat de `excedeuConsultas_` (08_Api.gs). Aqui ele quase não importa: o
 * prejuízo máximo é o professor receber duas cópias do mesmo aviso.
 */
function freioDoLinkLibera_(email) {
  var props = PropertiesService.getScriptProperties();
  var chave = 'linkfreio_' + email;
  var agoraMs = new Date().getTime();
  var hoje = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd');

  var estado = {};
  try {
    estado = JSON.parse(props.getProperty(chave) || '{}') || {};
  } catch (e) {
    estado = {};
  }

  if (estado.dia !== hoje) estado = { dia: hoje, contagem: 0, ultimo_ms: 0 };
  if (agoraMs - Number(estado.ultimo_ms || 0) < LINK_INTERVALO_MS) return false;
  if (Number(estado.contagem || 0) >= LINK_TETO_DIA) return false;

  props.setProperty(chave, JSON.stringify({
    dia: hoje,
    contagem: Number(estado.contagem || 0) + 1,
    ultimo_ms: agoraMs
  }));
  return true;
}

/** Onde a allowlist fica em cache para o caminho do link. */
var LINK_CACHE_ALLOWLIST = 'link_allowlist';

/**
 * Por quanto tempo. Cinco minutos, e o número tem uma conta atrás.
 *
 * Ele limita a QUANTAS leituras do Firestore uma enxurrada anônima consegue
 * chegar: no máximo 12 por hora, 288 por dia, contra as 50 mil do plano
 * gratuito. É o que transforma "atacar esta rota drena a cota do sistema" em
 * "atacar esta rota não faz nada".
 *
 * O preço é uma janela de até cinco minutos em que um endereço recém-removido
 * ainda RECEBE o e-mail. Ele não ENTRA: `entrarComLink` reconfere a allowlist no
 * clique, e essa conferência é sempre fresca. E a janela nem chega a abrir no
 * caso normal, porque quem mexe na lista derruba o cache junto
 * (`esquecerAllowlistDoLink_`).
 */
var LINK_CACHE_SEGUNDOS = 300;

/**
 * A allowlist para decidir se vale enviar. `null` quando o cache não respondeu.
 *
 * Devolver `null` em vez de cair na leitura direta é deliberado: quem chama
 * precisa SABER que está no modo degradado, porque é isso que decide se o teto
 * global entra em cena. Esconder a diferença aqui devolveria o sistema ao
 * desenho antigo sem ninguém perceber.
 */
function allowlistParaLink_() {
  var cache;
  try {
    cache = CacheService.getScriptCache();
    var guardada = cache.get(LINK_CACHE_ALLOWLIST);
    if (guardada !== null && guardada !== undefined) {
      return { lista: JSON.parse(guardada) };
    }
  } catch (e) {
    return null;
  }

  var lista = adminEmails_();
  try {
    cache.put(LINK_CACHE_ALLOWLIST, JSON.stringify(lista), LINK_CACHE_SEGUNDOS);
  } catch (e) {
    // Guardar falhou, mas a lista está na mão e ela é o que interessa agora.
    // A próxima requisição tenta de novo; se o cache estiver mesmo fora, ela
    // cai no `null` acima e o modo degradado assume.
  }
  return { lista: lista };
}

/**
 * Esquece a lista guardada. Chamado por quem MUDA a allowlist.
 *
 * Sem isto, tirar alguém do acesso continuaria mandando link para essa pessoa
 * por até cinco minutos — e "tirei o acesso" tem de valer no instante em que se
 * clica, que é a mesma razão pela qual `removerAdmin` já derruba a sessão.
 */
function esquecerAllowlistDoLink_() {
  try {
    CacheService.getScriptCache().remove(LINK_CACHE_ALLOWLIST);
  } catch (e) {
    // Cache fora do ar: nada guardado, nada a esquecer.
  }
}

/**
 * Pedir um link agora tem chance de virar e-mail?
 *
 * Serve para a tela não oferecer uma porta que não vai abrir. Sem isto, com a
 * cota de envio esgotada, a pessoa digita o endereço, lê a frase gentil de
 * sempre ("se estiver autorizado, enviamos") e espera um e-mail que não vem — e
 * não há nada na tela que explique. Foi o buraco que a revisão do painel achou.
 *
 * NÃO É VAZAMENTO, e a distinção importa: isto responde sobre o ESTADO DO
 * SISTEMA (há cota? o teto da hora estourou? há alguém na lista?), nunca sobre
 * um endereço. A frase única de `pedirLinkDeAcesso` continua intacta, e nada
 * aqui permite descobrir quem está na allowlist — só se ela está vazia, que
 * `modoDeAcesso` já contava antes disto existir.
 *
 * O que um atacante aprende: que ele conseguiu esgotar a cota. Ele saberia de
 * qualquer jeito, parando de receber; e quem PRECISA saber é a coordenação, que
 * sem isto ficaria olhando para uma tela que promete um e-mail.
 */
function linkDeAcessoDisponivel_() {
  if (adminEmails_().length === 0) return false;

  try {
    return MailApp.getRemainingDailyQuota() > 0;
  } catch (e) {
    // Escopo não concedido ainda (script.send_mail). Dizer que a porta está
    // aberta seria mentir; dizer que está fechada manda a pessoa para o
    // `liberarAcesso`, que é o que de fato resolve nesse estado.
    return false;
  }
}

/**
 * Apaga links vencidos.
 *
 * O armazenamento de propriedades tem 500 KB no total, compartilhados com as
 * sessões e com a configuração secreta. Um link ocupa pouco, mas "pouco" vezes
 * um semestre de pedidos é como se enche um espaço que ninguém está olhando.
 * Roda no envio, que é o único momento em que sabemos que uma chave nova nasceu.
 */
function faxinaLinks_() {
  var props = PropertiesService.getScriptProperties();
  var todas = props.getProperties();
  var agoraMs = new Date().getTime();

  Object.keys(todas).forEach(function (k) {
    if (k.indexOf('link_') !== 0) return;
    try {
      var expiraEm = Number(JSON.parse(todas[k]).expira_em);
      if (!expiraEm || agoraMs > expiraEm) props.deleteProperty(k);
    } catch (e) {
      props.deleteProperty(k);
    }
  });
}

/**
 * ÚLTIMO RECURSO, e a forma que se consegue MESMO rodar. Comece por esta.
 *
 * `liberarAcesso(email)`, logo abaixo, pede um argumento — e o botão Executar do
 * editor do Apps Script não passa argumentos. Rodá-la pelo seletor de função cai
 * direto no `throw` de "Informe um e-mail", que é o oposto do que uma porta de
 * emergência deve fazer com quem chega até ela. O defeito foi encontrado na
 * revisão da documentação, e não em teste nenhum: nenhum teste roda pelo botão.
 *
 * Esta aqui não pede nada. Ela libera a CONTA QUE ESTÁ RODANDO O SCRIPT, e é a
 * conta certa por construção: `Session.getEffectiveUser()` devolve quem abriu o
 * editor, e quem abriu o editor já poderia reescrever este arquivo inteiro. Não
 * há privilégio novo aqui — há um caminho curto e registrado para um privilégio
 * que a pessoa já tinha.
 *
 * (Este é o mesmo `Session` que volta vazio no web app anônimo, e por isso o
 * sistema todo precisa do botão do Google. No editor ele responde: a diferença é
 * o `executeAs` da implantação, não a API. Ver o topo de 07_Auth.gs.)
 */
function liberarMeuAcesso() {
  var email = '';
  try {
    email = normalizarEmail(Session.getEffectiveUser().getEmail());
  } catch (e) {
    email = '';
  }

  if (!email) {
    throw new Error(
      'O Apps Script não entregou o e-mail desta conta. Confira se userinfo.email está no ' +
      'manifesto. Se estiver, escreva no editor uma função de uma linha e rode ELA (o botão ' +
      'Executar não passa argumentos):  function socorro() { liberarAcesso("seu-email@dominio"); }'
    );
  }
  return liberarAcesso(email);
}

/**
 * O mesmo, para liberar OUTRA pessoa. Ver `liberarMeuAcesso` para a de sempre.
 *
 * Não é chamável pelo botão Executar (ele não passa argumentos). Para usá-la,
 * escreva uma função de uma linha no editor e rode essa:
 *
 *     function socorro() { liberarAcesso('professor@unicesusc.edu.br'); }
 *
 * Existe para o pior dia possível: o botão do Google não funciona, a allowlist
 * está vazia (ou tem só endereços que ninguém acessa mais), e portanto não há
 * para onde mandar link nenhum. Sem esta função, o painel ficaria trancado por
 * fora e a única saída seria editar propriedades à mão — que é o tipo de
 * operação que se faz errado às onze da noite.
 *
 * POR QUE ISTO NÃO É UMA PORTA DOS FUNDOS: para chamá-la é preciso abrir o
 * projeto no editor do Apps Script, e quem consegue isso já pode reescrever
 * `entrarComLink` inteiro. Ela não concede nada que esse acesso já não
 * concedesse; o que ela faz é tornar o caminho explícito, curto e REGISTRADO —
 * em vez de deixar cada um improvisar o seu.
 *
 * Ela NÃO está na lista de funções que a API despacha (08_Api.gs), e não pode
 * entrar: seria, aí sim, uma porta dos fundos anônima.
 *
 * O e-mail é acrescentado à allowlist quando ainda não estiver nela, e a razão
 * NÃO é a que estava escrita aqui. Dizia-se que "uma sessão para alguém fora da
 * lista morreria na primeira função do painel que confere" — e nenhuma função do
 * painel confere: `exigirAdmin` valida o token e mais nada. A sessão duraria as
 * oito horas inteiras. Quem confiasse na frase suporia uma guarda que não
 * existe, que é o pior tipo de comentário errado.
 *
 * A razão de verdade é o DIA SEGUINTE. Sem repor o e-mail, a sessão de agora
 * funciona, expira em oito horas, e o sistema volta ao estado de lista vazia —
 * ou seja, ao mesmo beco de onde se estava saindo. Repor é o que faz o socorro
 * durar mais que uma tarde.
 */
function liberarAcesso(email) {
  var alvo = normalizarEmail(email);
  if (!alvo || alvo.indexOf('@') === -1) {
    throw new Error('Informe um e-mail: liberarAcesso("professor@unicesusc.edu.br")');
  }

  var lista = adminEmails_();
  if (lista.indexOf(alvo) === -1) {
    lista.push(alvo);
    // `', '` e não `','`: é o formato que `incluirAdmin`, `removerAdmin` e
    // `regravarAllowlist_` gravam. `adminEmails_` apara os espaços e as duas
    // formas funcionam — mas o cabeçalho de `adminEmails_` conta o que uma
    // divergência de formato já custou aqui uma vez.
    gravarConfig('admin_emails', lista.join(', '));
  }

  var token = criarSessao_(alvo);
  registrar('ACESSO_LIBERADO', 'painel', alvo,
    'sessão criada à mão pelo editor do Apps Script');

  var url = urlDoPainel_() + '?sessao=' + token;
  console.log(
    '\n\nAcesso liberado para ' + alvo + '.\n\n' +
    'Abra este endereço. Ele carrega uma sessão comum, de 8 horas — abrir de novo\n' +
    'dentro desse prazo continua funcionando, e depois dele não funciona mais:\n\n' + url + '\n\n' +
    'Depois de entrar, confira em Configurações quem está na lista de acesso.\n'
  );
  return url;
}
