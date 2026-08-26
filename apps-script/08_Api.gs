/**
 * 08_Api.gs — os pontos de entrada do web app.
 *
 * Uma implantação só atende três públicos, e é o `doGet` que os separa:
 *
 *   GET  ?api=config      JSON   o site no GitHub Pages, montando o formulário
 *   GET  ?api=projetos    JSON   o site, montando os cartões com as vagas
 *   GET  ?api=matricula   JSON   o site, conferindo a matrícula digitada
 *   GET  ?api=ping        JSON   o próprio projeto, batendo na porta para não
 *                                deixar a instância dormir (ver "Aquecimento da
 *                                instância", no fim deste arquivo)
 *   POST acao=inscricao   JSON   a inscrição vinda do site
 *   POST acao=login       JSON   as cinco funções de entrada no painel
 *   POST acao=painel      JSON   as ações do painel, todas com token
 *   GET  (sem `api`)      HTML   Cadastro.html — o formulário interno
 *   GET  ?p=admin         HTML   Admin.html — o painel de gestão
 *
 * As quatro primeiras e o POST são ANÔNIMAS: a implantação é
 * `access: ANYONE_ANONYMOUS` (appsscript.json), porque o aluno se inscreve sem
 * ter conta Google. Isso é a condição do sistema, não um descuido — e é o que
 * obriga tudo neste arquivo a ter freio: teto de consultas, orçamento de leitura
 * e as guardas de `verificarAntiAbuso_` (04_Inscricoes.gs).
 *
 * ------------------------------------------------- O contrato do `text/plain`
 *
 * O site é servido pelo GitHub Pages e o `/exec` vive no google.com: toda
 * chamada é de origem cruzada. O navegador só a deixa sair sem preflight se ela
 * for uma requisição "simples", e `Content-Type: text/plain` é o que a torna
 * simples. Com `application/json` o navegador dispara um OPTIONS antes do POST —
 * e o Apps Script não responde OPTIONS. A inscrição morre dentro do navegador do
 * aluno, sem chegar aqui e sem deixar erro no servidor para explicar o sumiço.
 *
 * O corpo continua sendo JSON; só o cabeçalho mente. Quem o desserializa é este
 * arquivo, na mão, a partir de `e.postData.contents`. `e.parameter` não serve:
 * o Apps Script só o preenche para `application/x-www-form-urlencoded`.
 *
 * O outro lado do contrato está em `docs/assets/app.js:513`. Mudar um dos dois
 * sem o outro quebra a inscrição inteira, e quebra calada.
 *
 * ------------------------------------------------------ Orçamento de leitura
 *
 * O plano Spark dá 50 mil leituras de DOCUMENTO por dia. A conta para UM aluno
 * que abre o site, confere a matrícula e se inscreve, com P = projetos ativos
 * (hoje meia dúzia por semestre; a conta abaixo usa P=5):
 *
 *   GET ?api=config      1 + D  o documento único de configuração, mais uma
 *                               consulta às disciplinas ATIVAS, que cobra um
 *                               documento por documento devolvido (D). A conta
 *                               abaixo usa a coleção ainda vazia, onde a consulta
 *                               volta sem nada e cobra o mínimo de 1 — ver
 *                               `cursosFasesAtivos_` (12_Disciplinas.gs)
 *   GET ?api=projetos  1 + T + P  T documentos — a consulta traz a coleção inteira,
 *                               inclusive os inativos, que só depois são
 *                               filtrados — mais P agregações de contagem, uma
 *                               por projeto ativo. Com poucos inativos, T ≈ P.
 *                               O 1 da frente é o documento de configuração:
 *                               `contarInscritos_` (09_Projetos.gs) pergunta se a
 *                               fila de espera está ligada, e essa é a única rota
 *                               que chega à contagem sem já ter lido a
 *                               configuração por outro motivo. É UM por execução,
 *                               não um por projeto — o cache de execução de
 *                               `config()` responde as outras P-1 vezes.
 *                               As P agregações são COBRADAS uma a uma e vão
 *                               todas numa ida só (`contarInscritosDe_`,
 *                               09_Projetos.gs): o que o paralelismo corta é
 *                               tempo de espera, não cota. Este orçamento não
 *                               mudou por causa dele.
 *                               Com `contar_ocupacao_na_lista` em NAO — a chave
 *                               de DIAGNÓSTICO de 09_Projetos.gs, que não é como
 *                               o sistema roda — as P agregações não acontecem e
 *                               a rota custa 1 + T, fixo: duas idas ao banco em
 *                               vez de três. É a medição que ela existe para
 *                               produzir, e o preço está lá
 *   GET ?api=matricula   3      configuração + o projeto + o documento da matrícula
 *   POST inscrição       6      04_Inscricoes.gs: configuração, matrícula, projeto,
 *                               outros projetos do aluno, o projeto de novo
 *                               (dentro de `reservarVaga`) e a contagem de vagas
 *   GET ?api=projetos  2 x (1+P) app.js recarrega a lista depois do sucesso
 *
 * Somando com P=5 e a coleção de disciplinas vazia: 2 + 11 + 3 + 6 + 11 = TRINTA
 * E TRÊS leituras por aluno (eram 31 antes de a fila de espera existir; as duas
 * a mais são a mesma pergunta de configuração, uma por carga do site). Esse
 * número reprova por dois motivos — o segundo é o grave:
 *
 *   1. 500 alunos no auditório × 33 = 16,5 mil leituras, sem contar quem recarrega
 *      a página, volta para a lista ou desiste. Cabe no dia, mas sem folga para
 *      um segundo evento ou uma importação no mesmo dia.
 *   2. `?api=projetos` custa 11 leituras por chamada ANÔNIMA. Dez requisições por
 *      segundo — que qualquer laço de terminal faz — torram os 50 mil em oito
 *      minutos, e aí o formulário para de funcionar para todo mundo até virar o
 *      dia no fuso do Pacífico. O teto de leitura vira, na prática, um botão de
 *      desligar o sistema, exposto na internet e sem autenticação.
 *
 * Por isso as DUAS rotas de leitura respondem de `CacheService` por
 * CACHE_ROTAS_S segundos. O que a cota passa a pagar não é mais "por
 * requisição", e sim "por janela de 30 segundos" — o custo deixa de crescer com
 * o número de visitantes, e a enxurrada de (2) passa a custar o mesmo que um
 * aluno só.
 *
 * Com o cache quente, o mesmo aluno custa:
 *
 *   ?api=config + ?api=projetos   ~2   (500 alunos em 30 min = 60 renovações de
 *                                       11 leituras, mais 6 renovações da lista
 *                                       de disciplinas — que tem janela própria,
 *                                       de 5 min — a D=13 cada. São ~740
 *                                       leituras diluídas entre os 500)
 *   ?api=matricula                 3
 *   POST                           6
 *                                 ---
 *                                 ~11  leituras por aluno
 *
 * Onze, contra as trinta e uma do desenho ingênuo. São ~4.500 alunos por dia
 * dentro da cota, para um evento de 400 a 500 — nove vezes a folga necessária.
 * Seis das onze são do POST, que é de 04_Inscricoes.gs; este arquivo responde
 * pelas outras cinco.
 *
 * A parte que cresce com D é a única que não é coberta só por este cache de 30 s.
 * Sob enxurrada anônima sustentada o teto do dia é o número de janelas (2.880)
 * vezes o custo da montagem, e 2.880 × (1+D) passaria dos 50 mil com D=20 — a
 * rota voltaria a ser o botão de desligar descrito em (2). Por isso a lista de
 * disciplinas tem cache PRÓPRIO, mais longo, por dentro deste; o porquê e a conta
 * estão no cabeçalho de 12_Disciplinas.gs.
 *
 * O que o cache NÃO faz, de propósito: ele não é invalidado quando uma inscrição
 * entra. Invalidar seria o reflexo óbvio e é justamente o que destruiria o
 * ganho — no pico do auditório entra inscrição a cada poucos segundos, então a
 * lista seria refeita a cada poucos segundos, que é o instante em que o cache
 * precisa existir. O preço é uma contagem de vagas com até
 * CACHE_ROTAS_S segundos de atraso no CARTÃO do site. Isso não vende vaga
 * nenhuma: quem decide a vaga é `reservarVaga` (09_Projetos.gs), que conta
 * dentro do lock e no instante do envio. Um aluno pode ver "3 restantes" e
 * receber a recusa por ESGOTADO — caminho que o site já trata, porque a lista
 * sempre foi um retrato do passado (`anunciarPerdaDeVaga`, app.js:554).
 *
 * ---------------------------------------- Por que o painel virou rota de POST
 *
 * `google.script.run` só existe dentro de uma página SERVIDA pelo Apps Script —
 * ele é uma ponte entre o iframe do `?p=admin` e este projeto, e não um endereço
 * de rede. Um painel hospedado no GitHub Pages não tem essa ponte: para ele,
 * este projeto é um site de outro domínio, e a única forma de conversar é HTTP.
 *
 * Daí `acao: 'painel'`, que despacha para as funções que já existem em
 * 05_Importacao.gs, 06_Reconciliacao.gs, 07_Auth.gs, 09_Projetos.gs,
 * 10_Painel.gs, 11_Banners.gs e 12_Disciplinas.gs. NENHUMA delas mudou: todas
 * recebem um payload com `token` e começam por `exigirAdmin`, exatamente como
 * quando eram chamadas pela ponte. O que muda é quem as chama.
 *
 * Isso é POST, e não GET, por duas razões: metade delas ESCREVE (salvar projeto,
 * confirmar importação, remover disciplina), e as outras carregam payload que
 * não cabe numa URL. Nenhuma ação do painel entra no `doGet`.
 *
 * ------------------------------------------------------------ CORS do painel
 *
 * O painel passa a chamar de `https://<conta>.github.io` para
 * `script.google.com`: origem cruzada, igual à inscrição. Vale o MESMO contrato
 * do `text/plain` descrito acima, e por isso o token de sessão viaja no CORPO —
 * um cabeçalho `Authorization` tornaria a requisição "não simples" e dispararia
 * o preflight OPTIONS que o Apps Script não responde. O painel morreria no
 * navegador, calado, exatamente como a inscrição morria.
 *
 * Não há nada a fazer do lado do servidor: o Apps Script não deixa definir
 * cabeçalho de resposta, e a resposta do `/exec` já sai com
 * `access-control-allow-origin: *` (medido). O risco todo mora no cliente, e é
 * ele que precisa não pedir preflight.
 */

/**
 * Por quanto tempo a resposta das rotas de leitura fica guardada.
 *
 * Trinta segundos é onde as duas curvas se cruzam. Menos que isso e a enxurrada
 * anônima volta a custar caro (10s = três vezes mais leituras pela mesma
 * proteção); muito mais e o cartão de vagas fica visivelmente atrasado num
 * evento em que o número muda o tempo todo.
 */
var CACHE_ROTAS_S = 30;

/** Chaves do cache. Nomes fixos: o cache é do script inteiro, não da execução. */
var CACHE_CONFIG = 'api_config';
var CACHE_PROJETOS = 'api_projetos';

/**
 * Por quanto tempo a resposta de uma escrita do painel fica guardada pela chave
 * de idempotência.
 *
 * Dez minutos cobrem com folga o caso real, que é a pessoa reclicando em
 * segundos depois de a resposta se perder. Não é um histórico de operações: é a
 * janela em que "de novo" ainda quer dizer "a mesma vez".
 */
var IDEMPOTENCIA_S = 600;

/** Prefixo das chaves, para que elas não esbarrem nas do cache de rotas. */
var IDEMPOTENCIA_PREFIXO = 'idem_';

/**
 * Resposta maior que isto não é guardada — a repetição volta a executar.
 *
 * O item do `CacheService` tem teto de 100 KB, e `exportarCsv` devolve o CSV
 * INTEIRO no corpo: um cadastro grande passa do teto e o `put` estoura. Guardar
 * menos é a degradação certa (a repetição fica sem proteção, como era antes),
 * e exportar duas vezes gera dois arquivos iguais e duas linhas na trilha — nada
 * que se pareça com o dado duplicado que esta chave existe para impedir.
 *
 * Em caracteres, e não em bytes, porque é o que o JavaScript conta de graça; a
 * folga de 50% cobre um texto todo acentuado, onde cada caractere vira dois
 * bytes em UTF-8.
 */
var IDEMPOTENCIA_MAX_CARACTERES = 50000;

// ------------------------------------------------------------ Roteamento

function doGet(e) {
  var parametros = (e && e.parameter) || {};

  if (parametros.api) {
    try {
      return rotaDeLeitura_(parametros);
    } catch (err) {
      // Sem isto, uma indisponibilidade do Firestore devolve a página de erro do
      // Apps Script, em HTML: o `r.json()` do site estoura, `buscar` engole o
      // estouro e a tela mostra "Nenhum projeto disponível no momento" — ou
      // seja, um sistema fora do ar vira uma mensagem de sistema vazio. Melhor
      // um JSON bem formado dizendo que falhou.
      //
      // A mensagem é genérica de propósito: o erro do Repo carrega método,
      // caminho e o texto do Google, que não é informação para o aluno. O
      // original vai para o console, que é o Stackdriver do projeto.
      console.error('doGet ' + parametros.api + ': ' + err.message);
      return respostaJson_({ ok: false, erro: 'Não foi possível carregar os dados agora. Tente em instantes.' });
    }
  }

  return paginaHtml_(parametros.p);
}

/**
 * As quatro rotas JSON. Rota desconhecida responde JSON, e não a página HTML.
 *
 * O original caía no `else` e servia `Cadastro.html` para quem pediu `?api=`
 * qualquer coisa. Quem chama uma API e recebe HTML vê o `r.json()` estourar e
 * fica sem saber se errou o nome da rota ou se o servidor caiu.
 */
function rotaDeLeitura_(parametros) {
  // PRIMEIRA, e a posição é o requisito: esta rota existe para o Apps Script
  // CARREGAR o projeto, não para responder alguma coisa. Ela não lê o banco, não
  // pergunta a configuração e não olha o cache — o trabalho todo já aconteceu
  // antes desta linha, quando a instância foi montada. Qualquer leitura aqui
  // seria cota gasta 288 vezes por dia para não informar nada.
  //
  // O `doGet` desta implantação despacha sem ler nada antes (ele só chama esta
  // função), então "primeira aqui" é a mesma coisa que "primeira de tudo". Se um
  // dia o `doGet` passar a ler configuração antes de despachar, esta rota tem de
  // subir para antes disso — senão o ping volta a custar leitura.
  //
  // Ver "Aquecimento da instância", no fim deste arquivo, para o porquê.
  if (parametros.api === ROTA_PING) return respostaJson_({ ok: true });

  if (parametros.api === 'config') {
    return rotaCacheada_(CACHE_CONFIG, function () {
      return { ok: true, dados: dadosFormularioPublico_() };
    });
  }

  if (parametros.api === 'projetos') {
    return rotaCacheada_(CACHE_PROJETOS, function () {
      // `ocupacao_contada` no envelope é o mesmo sinal que viaja em cada projeto,
      // repetido onde um `curl` o encontra sem procurar — é chave de diagnóstico,
      // e quem a liga precisa confirmar o estado em um olhar. Sai da MESMA
      // função que a lista consulta, então as duas não têm como discordar.
      return { ok: true, ocupacao_contada: contarOcupacaoNaLista_(), projetos: listarProjetos(true) };
    });
  }

  // Nunca cacheada: a resposta depende da matrícula digitada, então a taxa de
  // acerto seria quase zero e o cache só guardaria lixo de tamanho crescente.
  if (parametros.api === 'matricula') {
    return respostaJson_(conferirMatricula_(parametros.m, parametros.p));
  }

  return respostaJson_({ ok: false, erro: 'Rota desconhecida: ' + String(parametros.api).slice(0, 40) });
}

/**
 * Serve uma das duas páginas do Apps Script.
 *
 * `?p=admin` é o painel; qualquer outra coisa (inclusive nada) é o formulário
 * interno. Não é autenticação: `Admin.html` mostra a tela de login e todas as
 * funções sensíveis começam com `exigirAdmin(token)` (07_Auth.gs). Servir o HTML
 * do painel para quem não entrou não entrega dado nenhum.
 *
 * Repare no que o painel NÃO faz: só o `Cadastro` monta `dadosIniciais` a partir
 * da configuração. Abrir `?p=admin` custa ZERO leitura do Firestore — de
 * propósito, porque é justamente com o banco fora do ar que a coordenação
 * precisa conseguir abrir o painel para descobrir o que houve.
 *
 * Aqui não há try/catch, e é decisão: se `dadosFormularioPublico_()` falhar, o
 * `Cadastro.html` receberia `{}`, leria `DADOS.aberto` como falso e mostraria
 * "as inscrições estão encerradas". Uma falha de infraestrutura contada como
 * decisão da coordenação é pior do que a página de erro do Apps Script, que ao
 * menos não mente.
 */
function paginaHtml_(pagina) {
  var arquivo = (String(pagina || 'cadastro') === 'admin') ? 'Admin' : 'Cadastro';

  var tpl = HtmlService.createTemplateFromFile(arquivo);
  tpl.dadosIniciais = JSON.stringify(
    arquivo === 'Cadastro' ? dadosFormularioPublico_() : { app: APP.nome, versao: APP.versao }
  );

  return tpl.evaluate()
    .setTitle(APP.nome)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    // Sem isso o iframe do Google Sites fica em branco.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Recebe o formulário hospedado fora do Google.
 *
 * `origem` é carimbada AQUI e sobrescreve o que veio no corpo. É ela que liga a
 * guarda mais forte de `verificarAntiAbuso_`: envio marcado como `SITE_EXTERNO`
 * sem `tempoPreenchimento` é recusado, o que obriga quem chega por este endereço
 * a ter passado pelo formulário. Deixar o cliente escolher a própria origem
 * seria entregar-lhe a chave da guarda.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return respostaJson_({ ok: false, erro: 'Requisição vazia.' });
    }

    var corpo;
    try {
      corpo = JSON.parse(e.postData.contents);
    } catch (err) {
      return respostaJson_({ ok: false, erro: 'Corpo da requisição inválido.' });
    }

    // `JSON.parse('"texto"')` e `JSON.parse('7')` não estouram, e um corpo assim
    // chegaria a `submeterInscricao` como algo que não tem campo nenhum. O erro
    // pertence a esta camada, que é quem sabe o formato do envelope.
    if (!corpo || typeof corpo !== 'object') {
      return respostaJson_({ ok: false, erro: 'Corpo da requisição inválido.' });
    }

    switch (corpo.acao || 'inscricao') {
      case 'inscricao':
        corpo.origem = 'SITE_EXTERNO';
        return respostaJson_(submeterInscricao(corpo));
      case 'login':
        return respostaJson_(rotaDeLogin_(corpo));
      case 'painel':
        return respostaJson_(rotaDoPainel_(corpo));
      default:
        return respostaJson_({ ok: false, erro: 'Ação desconhecida.' });
    }
  } catch (err) {
    console.error('doPost: ' + err.message);
    return respostaJson_({ ok: false, erro: 'Erro interno ao processar a inscrição.' });
  }
}

// ------------------------------------------------------------ Rotas do painel

/**
 * As seis funções de entrada, as únicas do painel que rodam SEM token.
 *
 * Elas são anônimas porque têm de ser: quem ainda não entrou não tem token para
 * apresentar. O que as protege não é o token, é o que cada uma devolve —
 * `modoDeAcesso` só conta como a tela deve ser desenhada, `sessaoAtiva` responde
 * sim ou não sobre um token que o chamador já tem, `sair` só apaga um token que
 * o chamador já tem, e as três de login têm freio próprio (07_Auth.gs e
 * 07b_LinkPorEmail.gs).
 *
 * `pedirLinkDeAcesso` é a mais exposta das seis, e a que mais depende de não ser
 * "melhorada": ela devolve a MESMA frase para endereço autorizado e não
 * autorizado, e é isso que a impede de responder "quem administra o CESUTECH?"
 * a quem perguntar. Ver o topo de 07b_LinkPorEmail.gs.
 *
 * `liberarAcesso` NÃO está aqui e não pode entrar: ela cria sessão sem provar
 * nada, e é segura exatamente porque só se chega a ela pelo editor do Apps
 * Script. Roteá-la seria transformá-la numa porta dos fundos anônima.
 *
 * Isto NÃO é exposição nova. Hoje o `Admin.html` é servido por `?p=admin` numa
 * implantação `ANYONE_ANONYMOUS` e chama estas mesmas funções por
 * `google.script.run`, sem token e sem login. O que muda é o transporte.
 *
 * O despacho é escrito à mão, um `if` por nome. Não é falta de elegância: um
 * mapa indexado pelo que o cliente mandou é o começo do caminho que termina em
 * `this[nome](...)`, e aqui a diferença entre os dois é a diferença entre cinco
 * funções e o projeto inteiro.
 */
function rotaDeLogin_(corpo) {
  try {
    var fn = String(corpo.fn || '');

    if (fn === 'modoDeAcesso') return modoDeAcesso();
    if (fn === 'sessaoAtiva') return sessaoAtiva(corpo.token);
    if (fn === 'sair') return sair(corpo.token);
    if (fn === 'autenticar') return autenticar();
    if (fn === 'entrarComGoogle') return entrarComGoogle(corpo.idToken);
    if (fn === 'pedirLinkDeAcesso') return pedirLinkDeAcesso(corpo.email);
    if (fn === 'entrarComLink') return entrarComLink(corpo.token);

    return { ok: false, erro: 'Ação desconhecida.' };
  } catch (err) {
    console.error('rotaDeLogin_ ' + corpo.fn + ': ' + err.message);
    return { ok: false, erro: 'Erro ao processar o acesso.' };
  }
}

/**
 * Despacha uma ação do painel para a função que a executa.
 *
 * ORDEM DAS TRÊS PERGUNTAS, e ela não é estética:
 *
 *   1. o token vale?      antes de qualquer coisa, e sem tocar no banco. Quem
 *                         não passa daqui não descobre nem que nomes existem;
 *   2. o nome está na     lista branca literal de `funcoesDoPainel_`;
 *   3. só então chama, com o payload — e com o token carimbado AQUI.
 *
 * O carimbo do token é o mesmo cuidado que o `doPost` tem com `origem` na
 * inscrição: as funções do painel leem `payload.token` e chamam `exigirAdmin`
 * com ele. Se o token viesse de dentro de `dados`, o cliente poderia mandar um
 * no envelope (que esta função confere) e OUTRO no payload (que a função do
 * painel confere), e a conferência que vale seria a que o cliente escolheu.
 * Sobrescrever fecha isso e mantém a dupla conferência, que é de graça: o
 * `exigirAdmin` lá dentro continua sendo a última palavra, e continua valendo
 * quando a mesma função é chamada por `google.script.run`.
 *
 * A recusa é UMA frase só, `RECUSA_SESSAO` (07_Auth.gs) — a mesma para token
 * ausente, vencido, forjado, ou de quem saiu da allowlist. Uma recusa que varia
 * conta ao visitante o que ele não sabia.
 *
 * ------------------------------------------- A QUARTA PERGUNTA: JÁ FIZ ISTO?
 *
 * 12/08/2026, produção: a coordenação salvou um projeto, o `/exec` demorou 32,71
 * segundos e o segundo salto voltou 404. A gravação tinha dado certo AQUI; o que
 * se perdeu foi a resposta. O painel não tinha como saber disso — clicar de novo
 * era a única saída que ele oferecia —, e nasceram dois projetos "CONECTANDO
 * GERAÇÕES". Respostas lentas e perdidas vão acontecer de novo: os 32 segundos
 * são contenção dos 30 slots de execução simultânea do Apps Script, e o dia do
 * evento põe 400 pessoas neste script.
 *
 * O cliente manda `idem` — uma chave por TENTATIVA DE OPERAÇÃO (a conta está em
 * `CHAVES_EM_ABERTO`, no painel). Aqui a chave é só uma pergunta ao cache: se a
 * resposta daquela chave já está guardada, ela é devolvida e a função NÃO roda de
 * novo.
 *
 * O ponto é este despacho, e não as sete funções que gravam: remendar uma a uma
 * seria escrever a mesma proteção sete vezes e esquecê-la na oitava, que é
 * sempre a que ninguém revisa.
 *
 * DUAS REGRAS QUE SUSTENTAM O RESTO:
 *
 *   1. GUARDA SÓ O QUE DEU CERTO. Uma recusa guardada transformaria um erro
 *      transitório ("muita gente se inscrevendo ao mesmo tempo", o lock ocupado)
 *      em erro permanente por dez minutos: a pessoa clicaria de novo e receberia
 *      a MESMA recusa sem que nada fosse tentado. Falha guardada é falha
 *      congelada;
 *   2. A CHAVE ENTRA NA CHAVE DO CACHE JUNTO COM `fn`. Uma chave reaproveitada
 *      por engano em outra ação devolveria a resposta da anterior — "removido com
 *      sucesso" para uma remoção que nunca aconteceu. Com o nome na frente, o
 *      reaproveitamento simplesmente não acha nada e a ação roda.
 *
 * NÃO É UMA PORTA PARA ENCHER O CACHE DE FORA: só se chega aqui com token válido
 * (a primeira linha desta função), a chave é limitada a 64 caracteres de um
 * alfabeto fechado, o valor só é guardado quando a operação deu certo — ou seja,
 * quem quisesse ocupar espaço teria de EXECUTAR escritas de verdade, autenticado
 * — e tudo expira em dez minutos. Uma chave malformada não é recusa: ela é
 * ignorada, e a ação roda como rodava antes desta linha existir.
 *
 * O QUE ESTA CAMADA NÃO SABE: quais funções são leitura. Ela não precisa saber e
 * não deve inventar uma segunda lista — quem decide quem pede chave é o painel,
 * numa linha só (`SO_LEITURA`, em `chamar()`). Uma leitura que chegasse aqui com
 * chave teria a resposta congelada por dez minutos, e é por isso que a decisão
 * mora onde já existe a lista, e não em duas listas que um dia divergem.
 */
function rotaDoPainel_(corpo) {
  try {
    if (!tokenValido_(corpo.token)) return { ok: false, erro: RECUSA_SESSAO };

    var fn = String(corpo.fn || '');
    var funcoes = funcoesDoPainel_();

    // `hasOwnProperty`, e não `funcoes[fn]`: sem ele, `fn: 'constructor'` e
    // `fn: 'toString'` devolvem funções herdadas de Object — que são funções de
    // verdade, passariam no teste de tipo e seriam CHAMADAS. O nome vem do
    // cliente; a herança do JavaScript é uma lista branca que ninguém escreveu.
    if (!Object.prototype.hasOwnProperty.call(funcoes, fn)) {
      return { ok: false, erro: 'Ação desconhecida: ' + fn.slice(0, 40) };
    }

    var dados = (corpo.dados && typeof corpo.dados === 'object' && !Array.isArray(corpo.dados))
      ? corpo.dados
      : {};
    dados.token = corpo.token;

    // Depois da lista branca, e não antes: `fn` entra na chave do cache, e só
    // aqui ele já é um dos nomes literais de `funcoesDoPainel_`.
    var chave = chaveIdempotente_(fn, corpo.idem);
    if (chave) {
      var guardada = respostaGuardada_(chave);
      if (guardada) return guardada;
    }

    var resposta = funcoes[fn](dados);

    if (chave && resposta && resposta.ok === true) guardarResposta_(chave, resposta);

    return resposta;
  } catch (err) {
    console.error('rotaDoPainel_ ' + corpo.fn + ': ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * A LISTA BRANCA. Toda função do painel que o navegador pode acionar, e só elas.
 *
 * Por que uma lista literal e não uma convenção ("tudo que começa com painel",
 * "tudo que chama exigirAdmin"): convenção é regra que mora na cabeça de quem
 * escreveu. Uma função nova nasce despachável por descuido, e o descuido só
 * aparece quando alguém o encontra. Aqui, função nova nasce INALCANÇÁVEL, e
 * quem a quiser no painel escreve a linha — que é o momento em que se pensa se
 * ela deveria estar aqui.
 *
 * O que NÃO está nesta lista, e por quê:
 *   - `setup`, `semearConfigPadrao_`, `migrarDisciplinas`, `instalarGatilhoDiario`
 *     e afins: são de console, rodam uma vez, e nenhuma delas tem `exigirAdmin`;
 *   - `reconciliar`, `sincronizarRespostasForms`: são o motor, não o botão. O
 *     botão é `rodarReconciliacao` e `sincronizarForms`, que pedem token;
 *   - `submeterInscricao`, `listarProjetos`: já têm rota própria, pública;
 *   - `autenticar`, `entrarComGoogle`, `pedirLinkDeAcesso`, `entrarComLink`,
 *     `modoDeAcesso`, `sair`, `sessaoAtiva`: são de `rotaDeLogin_`, porque rodam
 *     antes de existir token;
 *   - `liberarAcesso`: é de console, e roteá-la anularia a única coisa que a
 *     torna segura (exigir acesso ao arquivo do projeto).
 *
 * O mapa é montado em tempo de REQUISIÇÃO, e não no escopo do arquivo: o Apps
 * Script carrega os `.gs` em ordem alfabética, e 08_Api.gs vem antes de
 * 09, 10, 11 e 12 — no instante em que este arquivo é lido, as funções abaixo
 * ainda não existem.
 */
function funcoesDoPainel_() {
  return {
    // 05_Importacao.gs
    analisarArquivo: analisarArquivo,
    confirmarImportacao: confirmarImportacao,
    expurgarLote: expurgarLote,

    // 06_Reconciliacao.gs
    rodarReconciliacao: rodarReconciliacao,
    sincronizarForms: sincronizarForms,

    // 07_Auth.gs — quem tem acesso ao painel
    listarAdmins: listarAdmins,
    incluirAdmin: incluirAdmin,
    removerAdmin: removerAdmin,

    // 09_Projetos.gs
    salvarProjeto: salvarProjeto,
    removerProjeto: removerProjeto,

    // 10_Painel.gs
    painelEstatisticas: painelEstatisticas,
    painelProjetos: painelProjetos,
    inscritosDoProjeto: inscritosDoProjeto,
    listarAlunos: listarAlunos,
    atualizarAlunos: atualizarAlunos,
    detalheAluno: detalheAluno,
    resolverAluno: resolverAluno,
    editarAluno: editarAluno,
    exportarCsv: exportarCsv,
    listarLotes: listarLotes,
    listarLog: listarLog,
    lerConfiguracoes: lerConfiguracoes,
    salvarConfiguracao: salvarConfiguracao,

    // 11_Banners.gs
    listarBanners: listarBanners,
    enviarBanner: enviarBanner,

    // 12_Disciplinas.gs
    listarDisciplinas: listarDisciplinas,
    inscritosDaDisciplina: inscritosDaDisciplina,
    matriculadosDaDisciplina: matriculadosDaDisciplina,
    incluirDisciplinas: incluirDisciplinas,
    editarDisciplina: editarDisciplina,
    alternarDisciplina: alternarDisciplina,
    removerDisciplina: removerDisciplina,

    // 13_Auditorio.gs — as três que MEXEM aqui apagam e ocupam vaga, e é por
    // isso que elas recebem ids explícitos: quem clica precisa ter visto quem
    // está na lista.
    inscricoesRecentes: inscricoesRecentes,
    filaDeEspera: filaDeEspera,
    anularInscricoes: anularInscricoes,
    restaurarInscricoes: restaurarInscricoes,
    promoverDaEspera: promoverDaEspera
  };
}

// ------------------------------------------------------------ Matrícula

/**
 * Resposta da conferência de matrícula.
 *
 * `existe` é o ÚNICO dado que sai daqui — nunca nome, curso, e-mail ou contato.
 * Devolver dado a partir da matrícula transformaria este endereço num oráculo: as
 * matrículas da instituição são quase sequenciais, então varrer a faixa
 * entregaria a lista de alunos inteira. A controladora desses dados é a
 * faculdade, e a exposição seria dela. Ver `matriculaConhecida` (04_Inscricoes.gs).
 *
 * Sobra um bit por consulta ("a matrícula X existe"), e é por isso que existe
 * `excedeuConsultas_`: não impede um determinado, mas encarece a varredura e
 * deixa rastro no log.
 *
 * A ORDEM das quatro perguntas é o orçamento de leitura desta rota, e não
 * estética:
 *
 *   formato        0 leituras — recusa o que nem vale consultar
 *   teto por hora  1 (a configuração; fica em cache pelo resto da execução)
 *   projeto valida 1 — e, quando não valida, dispensa a leitura da lista
 *   a lista        1
 *
 * Três leituras no caminho comum. A quarta pergunta — "existe lista oficial
 * importada?" — só é feita quando a matrícula NÃO foi encontrada: se ela foi,
 * a lista existe, porque a matrícula está nela. Isso tira a agregação do
 * caminho do aluno certo e a deixa só no de quem digitou errado. É o mesmo
 * reordenamento que `checarMatriculaNaLista_` faz em 04_Inscricoes.gs.
 */
function conferirMatricula_(bruta, projetoId) {
  var matricula = normalizarMatricula(bruta);

  // O TAMANHO É CONFERIDO NO QUE O ALUNO DIGITOU, não na chave.
  //
  // `normalizarMatricula` tira o zero à esquerda, então `0000000` — sete
  // dígitos, formato plausível — vira `0`, com um caractere, e seria reprovado
  // por tamanho. O mesmo aconteceria com `0001`, que é matrícula de quatro
  // dígitos legítima. A pergunta "tem cara de matrícula?" é sobre o que foi
  // digitado; a pergunta "está na lista?" é sobre a chave.
  var digitada = String(bruta || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Também é o caminho do parâmetro ausente: sem `m`, `digitada` é vazia e o
  // formato reprova antes de qualquer ida ao banco.
  if (digitada.length < 4 || digitada.length > 20) {
    // `bloqueia: true` não é detalhe. Sem ele o formulário lê `undefined`,
    // entende "não bloqueia" e mostra a mensagem permissiva — foi assim que
    // `0000000` passou. Matrícula malformada nunca é caso de "siga e a
    // coordenação confere depois".
    return { ok: true, valida: false, existe: false, motivo: 'FORMATO', bloqueia: true };
  }

  if (excedeuConsultas_()) {
    // Sem veredito: o formulário trata como "não deu para conferir" e libera, em
    // vez de barrar um aluno legítimo por causa do freio.
    return { ok: true, valida: true, indisponivel: true };
  }

  // Projeto que não valida matrícula não precisa nem consultar a lista.
  if (!projetoValidaMatricula_(projetoId)) {
    return { ok: true, valida: true, validaProjeto: false };
  }

  var modo = String(config('modo_validacao_matricula', 'BLOQUEAR')).toUpperCase();
  var conhecida = matriculaConhecida(matricula);

  return {
    ok: true,
    valida: true,
    validaProjeto: true,
    existe: conhecida,
    // Sem lista importada não há o que conferir — e o site não pode barrar
    // ninguém por causa de um arquivo que a secretaria ainda não mandou.
    listaDisponivel: conhecida ? true : temListaOficial_(),
    bloqueia: modo === 'BLOQUEAR'
  };
}

/**
 * Teto de consultas por hora. Freio de enumeração, não de carga.
 *
 * O padrão tem de ser o mesmo de CONFIG_PADRAO, e no sistema sobre Sheets não
 * era: a configuração diz 5000 e o literal continuou em 300, de quando 300 era
 * a paranoia da primeira versão. Enquanto a chave existe no banco ninguém
 * percebe. O dia em que ela não existir — implantação nova, setup pela metade —
 * é o dia do auditório, e a conferência de matrícula pararia de responder nos
 * primeiros minutos, liberando todo mundo sem conferência. A própria descrição
 * da chave em 00_Config.gs já dizia isso; o literal é que ficou para trás.
 * Existe teste que varre este arquivo e compara TODOS os padrões com
 * CONFIG_PADRAO.
 *
 * Duas coisas ditas para não serem descobertas depois:
 *
 *   1. O teto conta REQUISIÇÕES, não leituras. No limite ele deixa passar 5000
 *      consultas por hora, que são 15 mil leituras — três horas de abuso
 *      sustentado consomem a cota do dia. O remédio, se acontecer, é baixar
 *      `limite_consultas_matricula_hora` pelo painel, sem nova implantação.
 *   2. `getProperty` → decide → `setProperty` é ler-modificar-escrever sem
 *      serialização. Com execuções simultâneas a contagem sai MENOR que a real e
 *      o teto vaza. É o comportamento herdado do sistema em produção, e fechá-lo
 *      exigiria pôr o `PropertiesService` dentro do lock global — serializar o
 *      auditório inteiro por causa de um contador de segurança.
 */
function excedeuConsultas_() {
  var limite = Number(config('limite_consultas_matricula_hora', '5000'));
  var props = PropertiesService.getScriptProperties();
  var janela = String(Math.floor(new Date().getTime() / 3600000));

  var contagem = (props.getProperty('consultas_janela') === janela)
    ? Number(props.getProperty('consultas_contagem') || 0)
    : 0;

  if (contagem >= limite) {
    // UM registro por janela, e não um por requisição recusada. A contagem
    // congela no teto, então `contagem >= limite` continua verdadeiro para todas
    // as requisições seguintes da hora: o original gravava uma linha de log em
    // cada uma delas. Um robô insistindo viraria dezenas de milhares de ESCRITAS
    // — contra 20 mil por dia no Spark —, ou seja, o freio derrubaria o sistema
    // mais depressa do que o abuso que ele existe para conter.
    if (props.getProperty('consultas_avisadas') !== janela) {
      props.setProperty('consultas_avisadas', janela);
      registrarRecusa('LIMITE_CONSULTA', 'matricula', '', 'teto de ' + limite + '/hora atingido', 'teto_matricula');
    }
    return true;
  }

  props.setProperty('consultas_janela', janela);
  props.setProperty('consultas_contagem', String(contagem + 1));
  return false;
}

// ------------------------------------------------------------ Dados do formulário

/**
 * O que o formulário público precisa para se desenhar.
 *
 * As sete consultas de `config()` abaixo saem todas do mesmo documento, que
 * `lerConfig()` guarda pelo resto da execução (03_Config.gs) — uma leitura.
 * `cursosFases` é a exceção e a novidade: ela deixou de sair da chave
 * `cursos_fases` e passa a sair da coleção `disciplinas`, onde a coordenação
 * consegue incluir, editar, ativar e inativar uma linha por vez. O custo disso
 * está medido no Orçamento de leitura, no alto do arquivo.
 *
 * A chave `cursos_fases` continua existindo e continua sendo o fallback:
 * `cursosFasesAtivos_` cai nela quando a coleção está vazia (antes da migração)
 * ou quando a consulta falha. Sem esse desvio, o `select` viria vazio e TODA
 * inscrição morreria em "Selecione seu curso e fase" — que é o defeito que já
 * aconteceu neste sistema, e não uma precaução teórica.
 *
 * Os quatro textos têm padrão VAZIO, e isso não é divergência de CONFIG_PADRAO —
 * é o que permite à coordenação apagar um texto pelo painel. Se o padrão fosse a
 * frase de CONFIG_PADRAO, limpar o campo faria a frase voltar sozinha, e não
 * haveria como desligar a autorização de imagem. O valor de CONFIG_PADRAO é a
 * SEMENTE (`semearConfigPadrao_`), não o fallback.
 */
function dadosFormularioPublico_() {
  return {
    app: APP.nome,
    versao: APP.versao,
    aberto: config('cadastro_aberto', 'SIM').toUpperCase() === 'SIM',
    exigirMatricula: config('exigir_matricula', 'SIM').toUpperCase() === 'SIM',
    exigirCpf: config('exigir_cpf', 'NAO').toUpperCase() === 'SIM',
    cursosFases: cursosFasesAtivos_(),
    textoLgpd: config('texto_lgpd', ''),
    textoDeclaracao: config('texto_declaracao', ''),
    textoImagem: config('texto_imagem', ''),
    textoEsgotado: config('texto_esgotado', '')
  };
}

// ------------------------------------------------------------ Resposta e cache

function respostaJson_(obj) {
  return respostaJsonTexto_(JSON.stringify(obj));
}

function respostaJsonTexto_(json) {
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Responde do cache, ou monta, guarda e responde.
 *
 * `montar` é o retorno de chamada que faz o trabalho caro: ele só roda quando o
 * cache não tem a resposta. Guardar o JSON já serializado, e não o objeto, evita
 * desserializar para serializar de novo a cada acerto.
 *
 * Todo contato com o cache está dentro de try/catch, e isso é regra: cache é
 * otimização, nunca dependência. Serviço indisponível, entrada acima do teto de
 * 100 KB ou qualquer outra falha devolve a rota ao comportamento sem cache — mais
 * cara e igualmente correta. Fora do Apps Script (os testes em Node), o objeto
 * `CacheService` simplesmente não existe, e é o mesmo caminho.
 */
function rotaCacheada_(chave, montar) {
  var cache = cacheDeRotas_();

  if (cache) {
    var guardado = null;
    try {
      guardado = cache.get(chave);
    } catch (e) {
      console.error('cache get ' + chave + ': ' + e.message);
    }
    if (guardado) return respostaJsonTexto_(guardado);
  }

  var json = JSON.stringify(montar());

  if (cache) {
    try {
      cache.put(chave, json, CACHE_ROTAS_S);
    } catch (e) {
      console.error('cache put ' + chave + ': ' + e.message);
    }
  }
  return respostaJsonTexto_(json);
}

function cacheDeRotas_() {
  try {
    // Do SCRIPT, e não do usuário: o ganho todo está em uma execução aproveitar
    // o que outra montou. Cache por usuário guardaria uma cópia por visitante e
    // não pouparia leitura nenhuma no auditório.
    return CacheService.getScriptCache();
  } catch (e) {
    return null;
  }
}

// ------------------------------------------- Idempotência das escritas do painel

/**
 * A chave do cache para esta tentativa de escrita — ou nada, e aí não há
 * proteção nenhuma.
 *
 * O FORMATO É CONFERIDO NO BRUTO, e não sanitizado: limpar caractere estranho e
 * seguir em frente faria uma chave de 10 KB virar uma chave curta e válida, e
 * duas chaves diferentes poderiam virar a MESMA depois da limpeza — que é como
 * uma gravação legítima seria engolida pela resposta de outra. Aqui, ou a chave
 * é o que o painel promete mandar (`novaChave`, em docs/painel/index.html), ou
 * ela não existe.
 *
 * Chave ausente ou malformada NÃO é recusa: a ação roda como rodava antes desta
 * proteção existir. Este arquivo atende um painel que é publicado à parte, no
 * GitHub Pages — uma implantação nova respondendo a um painel antigo, ou o
 * contrário, tem de continuar funcionando; o que se perde é a proteção, e não a
 * tela.
 *
 * O teto de 64 caracteres mais o nome da função cabem folgadamente nos 250 que o
 * `CacheService` aceita por chave.
 */
function chaveIdempotente_(fn, bruta) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(bruta || ''))) return '';
  return IDEMPOTENCIA_PREFIXO + fn + '_' + bruta;
}

/**
 * A resposta que esta mesma operação já devolveu, se ela ainda estiver guardada.
 *
 * Todo contato com o cache está em try/catch pela mesma regra de `rotaCacheada_`:
 * cache é otimização, nunca dependência. Sem o serviço — ou com ele fora do ar —,
 * a rota volta ao comportamento de antes, que é executar. Fora do Apps Script (os
 * testes em Node) é o mesmo caminho.
 */
function respostaGuardada_(chave) {
  var cache = cacheDeRotas_();
  if (!cache) return null;

  try {
    var json = cache.get(chave);
    return json ? JSON.parse(json) : null;
  } catch (e) {
    console.error('idempotencia get: ' + e.message);
    return null;
  }
}

/**
 * Guarda a resposta de uma escrita que DEU CERTO.
 *
 * Quem decide que deu certo é o chamador (`resposta.ok === true`), e a decisão
 * está explicada lá: guardar uma falha a tornaria permanente pelos dez minutos
 * em que a pessoa mais precisa poder tentar de novo.
 */
function guardarResposta_(chave, resposta) {
  var cache = cacheDeRotas_();
  if (!cache) return;

  try {
    var json = JSON.stringify(resposta);
    if (json.length > IDEMPOTENCIA_MAX_CARACTERES) return;
    cache.put(chave, json, IDEMPOTENCIA_S);
  } catch (e) {
    console.error('idempotencia put: ' + e.message);
  }
}

/** Permite quebrar o HTML em arquivos (`<?!= include('Estilos') ?>`). */
function include(nome) {
  return HtmlService.createHtmlOutputFromFile(nome).getContent();
}

// ------------------------------------------------- Aquecimento da instância

/**
 * O arranque a frio — que é o que fazia o site demorar meio minuto para abrir.
 *
 * A coordenação relatou 30 a 40 segundos de carregamento. Três chamadas em
 * sequência contra a implantação real, medindo o tempo total:
 *
 *   ?api=naoexiste    43,5s   rota que NÃO toca o banco: devolve "rota desconhecida"
 *   ?api=config        3,0s   logo em seguida
 *   ?api=projetos      2,2s   logo em seguida
 *
 * A rota que não faz NADA levou quarenta e três segundos, e as duas seguintes,
 * que leem o Firestore, ficaram em dois e três. O tempo não estava na contagem
 * de vagas, nem no banco, nem na rede — está ANTES da primeira linha executada:
 * o Google desliga a instância do projeto quando ninguém a usa, e a primeira
 * chamada depois do silêncio paga carregar e interpretar os 23 arquivos deste
 * projeto para só então despachar. Quem chega em seguida pega a instância de pé.
 *
 * Remedido depois, com a instância já dormindo de novo: 21,4s a primeira, 1,8s e
 * 2,3s as duas seguintes. O número da primeira varia — 21s, 43s —, o padrão não.
 *
 * Num evento de auditório isso cai no pior momento possível: o primeiro aluno a
 * abrir o site espera quarenta segundos e conta para os outros que "o sistema
 * está lento" — sobre uma lentidão que, para o segundo aluno, já não existe.
 *
 * O conserto é não deixar a instância dormir: um gatilho por tempo que, a cada
 * AQUECIMENTO_MINUTOS, bate na própria porta pela rota `?api=ping`.
 *
 * O que este mecanismo NÃO é: ele não deixa nada mais rápido. O sistema quente
 * responde em 2 a 3 segundos com ou sem ele. O que ele compra é que o PRIMEIRO
 * a chegar encontre o sistema quente — e é só isso.
 */

/**
 * De quanto em quanto tempo o gatilho bate na porta.
 *
 * Quem manda no número é a cota de gatilho do plano gratuito: 90 MINUTOS DE
 * EXECUÇÃO POR DIA, somados TODOS os acionadores do projeto — a linha "Trigger
 * total runtime" de developers.google.com/apps-script/guides/services/quotas.
 * Cada ping custa o tempo da chamada de saída, que é o próprio tempo de resposta
 * do web app: ~3s quente, mais na primeira depois de uma parada.
 *
 *   a cada 1 min   1440 execuções/dia × ~3s = ~72 min/dia   80% da cota do dia
 *   a cada 5 min    288 execuções/dia × ~3s = ~14 min/dia   16% da cota do dia
 *
 * Por isso cinco, e não um. Um minuto não é "mais seguro": é gastar quatro
 * quintos do orçamento diário de gatilho do projeto inteiro para aquecer uma
 * instância, e a reconciliação de madrugada (06_Reconciliacao.gs) sai do MESMO
 * bolso. Estourada a cota, o que para de rodar é ela também — trocar trabalho
 * de verdade por batimento é o pior negócio disponível aqui. Quem for tentado a
 * baixar para 1 tem a conta escrita acima.
 *
 * E cinco não é chute: é medida. A implantação real, batida na cadência que este
 * gatilho vai bater, contra a rota que não toca o banco:
 *
 *   aquecendo (instância dormindo)   36,8s
 *   + 5 min de silêncio               2,4s
 *   + 5 min de silêncio               2,5s
 *   + 5 min de silêncio               2,6s
 *   + 5 min de silêncio               2,6s
 *
 * Quatro intervalos seguidos, nenhum arranque a frio. E o controle, no mesmo
 * dia: DEZ minutos de silêncio devolveram 26,1s — a instância tinha morrido no
 * meio do caminho. Como `everyMinutes` só aceita 1, 5, 10, 15 ou 30, a escolha
 * real nunca foi entre 1 e 5: 10 já está medido do lado frio, e 1 custa quatro
 * quintos da cota. Sobra o cinco.
 *
 * A cota de SAÍDA é a outra, e essa é compartilhada com o banco: 20 mil
 * `UrlFetchApp` por dia, e TODA leitura do Firestore neste projeto é um
 * `UrlFetchApp` (02_Repo.gs). 288 pings são 1,4% dela e cabem sem discussão —
 * ficam anotados porque a cada 1 minuto seriam 7%, tirados de onde a inscrição
 * do aluno bebe.
 */
var AQUECIMENTO_MINUTOS = 5;

/**
 * Nome do gatilho. Fixo, para `instalarGatilhoAquecimento` reconhecer o que já
 * instalou e não empilhar cópias — mesmo motivo de GATILHO_RECONCILIACAO
 * (06_Reconciliacao.gs).
 */
var GATILHO_AQUECIMENTO = 'aquecerWebApp';

/**
 * O nome da rota, nas duas pontas.
 *
 * É constante porque as duas pontas moram neste arquivo: `rotaDeLeitura_`
 * atende e `urlDeAquecimento_` chama. Divergirem em silêncio seria um gatilho
 * rodando 288 vezes por dia para receber "Rota desconhecida" — que aquece
 * igual, por acaso, e é justamente por aquecer igual que ninguém descobriria.
 */
var ROTA_PING = 'ping';

/**
 * O ping. É esta que o gatilho chama, e ela não faz mais nada.
 *
 * Sem retentativa, de propósito: o próximo ping vem em cinco minutos. Tentar de
 * novo dentro da mesma execução dobraria o gasto das duas cotas para cobrir, no
 * pior caso, cinco minutos de atraso de um mecanismo cujo único efeito é o tempo
 * de carregamento.
 *
 * E sem `registrar()`, que é uma ESCRITA no Firestore: 288 linhas por dia de
 * "acordei" enterrariam a trilha da coordenação embaixo do batimento de um
 * mecanismo interno, e pagariam cota por isso. A falha vai para o console, que é
 * o Stackdriver do projeto — e é lá que se procura no dia em que o site voltar a
 * demorar quarenta segundos.
 */
function aquecerWebApp() {
  var url = urlDeAquecimento_();

  if (!url) {
    console.error('aquecerWebApp: não sei o endereço /exec desta implantação. ' +
      'Rode instalarGatilhoAquecimento() no editor para ver o diagnóstico.');
    return;
  }

  var r = pingar_(url);
  if (!r.deUmSinalDeVida) {
    console.error('aquecerWebApp: ' + url + ' respondeu ' + r.codigo +
      ' em ' + r.ms + ' ms — ' + r.corpo);
  }
}

/**
 * O endereço em que este projeto se responde — ou vazio, e aí não há ping.
 *
 * A URL não está escrita no código de propósito: ela muda a cada implantação
 * nova, e uma URL velha aqui manteria acordada uma instância que ninguém acessa,
 * calada, enquanto a que atende os alunos continuaria dormindo.
 *
 * Primeiro a DERIVAÇÃO, porque ela não exige que ninguém configure nada:
 * `ScriptApp.getService().getUrl()`, via `urlDoWebApp_` (10_Painel.gs) — a mesma
 * função que mostra o endereço no painel, reaproveitada para não haver duas
 * respostas para a mesma pergunta.
 *
 * Ela é CONFERIDA, e é aí que mora o cuidado. Fora de uma requisição do web app
 * — que é exatamente o caso de um gatilho — o que volta pode não ser o `/exec`
 * versionado que o site chama:
 *
 *   - a implantação de CABEÇA termina em `/dev`, e o `/dev` só responde a quem
 *     tem acesso de EDIÇÃO ao script. O ping é anônimo: receberia a tela de
 *     login do Google, com código 200, e não acordaria instância nenhuma;
 *   - em conta do Google Workspace o endereço pode vir na forma
 *     `/a/macros/<domínio>/s/<id>/exec`, que também pede sessão do domínio, e
 *     dá no mesmo.
 *
 * Nos dois casos o ping "funcionaria" sem aquecer nada, que é a pior falha
 * possível: silenciosa e com aparência de sucesso. Por isso só passa o formato
 * público — `https://script.google.com/macros/s/<id>/exec` —, e o que não passar
 * cai na chave `url_exec`, que nasce VAZIA justamente para o dia em que a
 * derivação não servir. `instalarGatilhoAquecimento` diz na hora qual dos dois
 * caminhos valeu.
 *
 * A ordem é essa porque a derivação é de graça e a chave custa uma leitura do
 * banco por ping. O preço de ler a configuração só é pago por quem precisa dela.
 */
function urlDeAquecimento_() {
  var derivada = urlDoWebApp_();
  if (ehExecPublico_(derivada)) return derivada + '?api=' + ROTA_PING;

  var configurada = String(config('url_exec', '')).trim();
  return ehExecPublico_(configurada) ? configurada + '?api=' + ROTA_PING : '';
}

/** O formato que responde a qualquer um, sem sessão do Google. */
function ehExecPublico_(url) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(String(url || ''));
}

/**
 * Bate na porta e conta o que aconteceu. NUNCA lança.
 *
 * `muteHttpExceptions` porque um 500 do próprio web app já cumpriu o objetivo: a
 * instância subiu para poder errar. Por isso a pergunta desta função não é "deu
 * certo?", e sim "QUEM respondeu?", e ela devolve duas respostas diferentes:
 *
 *   deUmSinalDeVida  o corpo tem `"ok":` — quem respondeu foi ESTE projeto, e
 *                    para aquecer é só isso que importa. É o que separa "o Apps
 *                    Script executou" de "o Google devolveu uma página de login
 *                    com código 200", que é a falha silenciosa contra a qual
 *                    `urlDeAquecimento_` se protege e que esta função flagra
 *                    quando escapar;
 *   rotaNoAr         o corpo é o `{"ok":true}` da rota de ping. Falso com
 *                    `deUmSinalDeVida` verdadeiro tem UM significado, e ele é
 *                    útil: o código foi enviado ao projeto mas a IMPLANTAÇÃO não
 *                    foi republicada, então o `/exec` ainda serve a versão
 *                    anterior, que responde "Rota desconhecida: ping".
 *
 * Essa separação existe para o gatilho não gritar à toa. A implantação velha
 * aquece exatamente igual — o Apps Script carrega o projeto inteiro ANTES de
 * descobrir que não conhece a rota —, e alarme que toca sem haver problema é
 * alarme que se aprende a ignorar. Quem precisa saber da versão velha é quem
 * está instalando, e é a ele que `instalarGatilhoAquecimento` conta.
 */
function pingar_(url) {
  var inicio = new Date().getTime();

  try {
    var resposta = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    var corpo = String(resposta.getContentText() || '').slice(0, 120);

    return {
      deUmSinalDeVida: resposta.getResponseCode() === 200 && corpo.indexOf('"ok":') !== -1,
      rotaNoAr: corpo.indexOf('"ok":true') !== -1,
      codigo: resposta.getResponseCode(),
      ms: new Date().getTime() - inicio,
      corpo: corpo
    };
  } catch (e) {
    return {
      deUmSinalDeVida: false,
      rotaNoAr: false,
      codigo: 0,
      ms: new Date().getTime() - inicio,
      corpo: e.message
    };
  }
}

/**
 * Instala (ou reinstala) o gatilho de aquecimento. Rode UMA vez, do editor.
 *
 * Idempotente pelo mesmo motivo de `instalarGatilhoDiario` (06_Reconciliacao.gs):
 * sem remover o que já existe, rodar duas vezes deixaria dois gatilhos batendo
 * na mesma porta — o dobro da cota gasta para o mesmo efeito, e invisível até
 * alguém abrir a tela de acionadores para procurar.
 *
 * Depois de instalar, ela BATE UMA VEZ e mostra o resultado. É a única hora em
 * que alguém está olhando: se o endereço estiver errado, o gatilho falharia em
 * silêncio a cada cinco minutos e a descoberta seria o site lento de novo, no
 * dia do evento.
 *
 * Para desligar, não há função: é a tela de acionadores do editor (o relógio, no
 * menu da esquerda), e lá o gatilho aparece pelo nome `aquecerWebApp`.
 */
function instalarGatilhoAquecimento() {
  var removidos = 0;

  ScriptApp.getProjectTriggers().forEach(function (g) {
    if (g.getHandlerFunction() === GATILHO_AQUECIMENTO) {
      ScriptApp.deleteTrigger(g);
      removidos++;
    }
  });

  ScriptApp.newTrigger(GATILHO_AQUECIMENTO)
    .timeBased()
    .everyMinutes(AQUECIMENTO_MINUTOS)
    .create();

  Logger.log('=== instalarGatilhoAquecimento ===');
  if (removidos) Logger.log('gatilhos antigos removidos: %s', removidos);
  Logger.log('a instância passa a ser acordada a cada %s minutos.', AQUECIMENTO_MINUTOS);

  var url = urlDeAquecimento_();
  if (!url) {
    Logger.log('MAS O GATILHO NÃO TEM ONDE BATER.');
    Logger.log('O endereço derivado (%s) não é um /exec público, e a chave url_exec está vazia.',
      urlDoWebApp_() || 'vazio');
    Logger.log('Preencha url_exec no painel, em Configurações, com o MESMO endereço que o site usa');
    Logger.log('(docs/assets/config.js, chave `endpoint`). O gatilho já está instalado e passa a');
    Logger.log('funcionar sozinho — não precisa rodar isto de novo.');
    return;
  }

  Logger.log('endereço: %s', url);

  var r = pingar_(url);
  if (r.deUmSinalDeVida) {
    Logger.log('respondeu em %s ms. Está de pé, e o gatilho vai mantê-la assim.', r.ms);
    if (!r.rotaNoAr) {
      Logger.log('AVISO: esta implantação ainda não conhece a rota de ping — o código foi enviado,');
      Logger.log('mas a implantação não foi republicada. Aquecer, aquece do mesmo jeito; publique');
      Logger.log('uma versão nova quando der, para o ping virar uma linha e não uma recusa.');
    }
    Logger.log('Confira que este endereço é o mesmo de docs/assets/config.js — aquecer a');
    Logger.log('implantação errada não dá erro nenhum, só não adianta nada.');
    return;
  }

  Logger.log('FALHOU: código %s em %s ms — %s', r.codigo, r.ms, r.corpo);
  Logger.log('Se o corpo acima parece uma página do Google, este endereço pede sessão e o ping é');
  Logger.log('anônimo: preencha url_exec no painel com o endereço público que o site usa.');
}
