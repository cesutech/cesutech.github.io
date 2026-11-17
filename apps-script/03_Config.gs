/**
 * 03_Config.gs — a configuração do sistema, sobre o Firestore.
 *
 * A API é a mesma que o projeto sobre Sheets (o sistema anterior, sobre Google
 * Sheets) expõe: `lerConfig`, `config`, `gravarConfig` e `configLista`, aqui com
 * o `_` no fim desde 16/11/2026 — é como o Apps Script marca função PRIVADA, e a
 * configuração não pode ser alcançável de fora do projeto (ver testes/portas.js).
 * 07_Auth.gs foi trazido de lá e chama `config_()` em quatro pontos — assinatura
 * idêntica é o que permite continuar trazendo as regras de negócio com desvio de
 * chamada, e não com reescrita.
 *
 * DESENHO: a configuração é UM documento, com um campo por chave. Não é uma
 * coleção com um documento por chave.
 *
 * O motivo é custo de leitura. `config_()` está no caminho quente: `autenticar_()`
 * a chama duas vezes por login, `modoDeAcesso_()` outras duas, e o formulário
 * público (`dadosFormularioPublico_`, quando for trazido) vai consultar a cada
 * carregamento da página. No Firestore cobra-se por DOCUMENTO lido, contra um
 * teto de 50 mil leituras por dia no plano Spark. As 26 chaves de CONFIG_PADRAO
 * espalhadas em 26 documentos custariam 26 leituras por requisição, e o dia
 * acabaria em menos de 2 mil visitas ao formulário. Num documento só, custam 1 —
 * e os dois caches abaixo, o da execução e o do script, derrubam isso para uma
 * leitura por execução, e, nas rotas anônimas, para uma por minuto.
 *
 * O preço desse desenho: gravação de chave é sempre um PATCH no mesmo documento,
 * então duas gravações simultâneas disputam. Configuração é escrita pela
 * coordenação, uma chave por vez, umas poucas vezes por semestre; a disputa é
 * teórica, e quando acontece o Repo já retenta ABORTED sozinho.
 */

var CONFIG_COLECAO = 'config';

/** Nome fixo do documento único. Sem id gerado: ele precisa ser adivinhável. */
var CONFIG_DOCUMENTO = 'geral';

/**
 * Cache da execução em curso.
 *
 * O escopo global do Apps Script nasce zerado a cada execução, então este cache
 * vive exatamente uma requisição — é o mesmo tempo de vida do cache por aba do
 * Repo sobre Sheets, e pela mesma razão: dentro de um login, `config_()` é
 * chamada várias vezes e o valor não pode mudar no meio.
 */
var CONFIG_CACHE = null;

/**
 * O documento de configuração também fica no cache do SCRIPT, entre execuções,
 * por CONFIG_CACHE_SEGUNDOS — e só as rotas ANÔNIMAS o leem de lá.
 *
 * O cache da execução, acima, só vale para uma requisição. Sem este, TODA
 * requisição pagava uma leitura no banco antes de qualquer coisa, inclusive a
 * anônima que vai ser recusada: o formulário confere `cadastro_aberto` antes do
 * freio, a matrícula confere `matricula_digitos` antes do teto, e a tela de
 * entrada (`modoDeAcesso_`) lê a lista de acesso a cada carga, sem freio
 * nenhum. Um laço de requisições vazias gastava assim as 50 mil leituras por
 * dia do plano Spark, e cada leitura ainda é uma chamada de UrlFetch, que tem a
 * sua cota (07_Auth.gs). Com o cache, recusar não lê o banco: o laço custa uma
 * leitura por minuto.
 *
 * SÓ AS ROTAS ANÔNIMAS LEEM O CACHE, porque são elas que um laço alcança sem
 * conta: as leituras do site (`rotaCacheada_` e `conferirMatricula_`, 08_Api.gs),
 * a inscrição (`submeterInscricao_`) e as duas rotas de entrada que não decidem
 * acesso, `modoDeAcesso_` e `pedirLinkDeAcesso_`. Cada uma liga o cache na
 * primeira linha, com `usarConfigDoScript_(true)`. Quem DECIDE acesso continua
 * lendo o banco a cada execução: a entrada com conta Google ou com o link, todo
 * o painel, o editor e os acionadores. O motivo é a corrida que nenhum cache
 * fecha: uma leitura começada antes de uma gravação pode guardar o valor velho
 * depois de a gravação esquecê-lo. Para a tela de entrada, isso é um minuto de
 * texto velho. Para a entrada no painel, seria um minuto em que alguém recém-
 * removido da lista entra de novo.
 *
 * Toda leitura do banco, de qualquer rota, renova o cache, e toda gravação feita
 * pelo sistema o esquece na hora (`esquecerConfigDoScript_`, nos três caminhos
 * que gravam: `gravarConfig_`, `gravarAcessos_` e `semearConfigPadrao_`). A
 * mudança feita pelo painel vale, então, na requisição anônima seguinte. O prazo
 * curto cobre o que o sistema não vê: a chave mudada direto no console do
 * Firestore e a corrida acima. Nos dois casos, esta camada segura o valor velho
 * por no máximo um minuto. Quem guarda por cima dela soma o próprio prazo: as
 * listas do site (`rotaCacheada_`, 30 s) e a lista de acesso do link por e-mail
 * (cinco minutos, 07b_LinkPorEmail.gs). Nenhuma das duas decide acesso: o link
 * enviado a quem saiu da lista não entra, porque `entrarComLink_` relê o banco.
 *
 * Cache fora do ar não derruba nada: a leitura cai no banco, como antes.
 */
var CONFIG_CACHE_CHAVE = 'config_geral';
var CONFIG_CACHE_SEGUNDOS = 60;

/** A execução em curso lê a configuração do cache do script? Ver acima. */
var CONFIG_CACHE_DO_SCRIPT_VALE = false;

/**
 * Liga ou desliga o cache do script para a execução em curso. A execução nasce
 * com ele desligado (o escopo global do Apps Script é novo a cada requisição), e
 * só as funções das rotas anônimas o ligam, na primeira linha. Ver acima.
 */
function usarConfigDoScript_(sim) {
  CONFIG_CACHE_DO_SCRIPT_VALE = sim === true;
}

/**
 * Chaves que NÃO moram no banco: chave de configuração -> propriedade do script.
 *
 * O MAPA ESTÁ VAZIO, e o mecanismo continua de pé de propósito.
 *
 * Ele existiu para `admin_pin`. A razão era boa e continua valendo para qualquer
 * segredo futuro: o documento de configuração é lido pelo formulário público a
 * cada visita, então quem tivesse leitura do banco teria o segredo junto.
 * Segredo não é configuração — ele vive em PropertiesService, o mesmo lugar onde
 * 07_Auth.gs guarda os tokens de sessão.
 *
 * O PIN saiu do sistema (ver 07b_LinkPorEmail.gs) e levou junto o único segredo
 * que havia. Manter o mapa vazio, em vez de arrancar o mecanismo, custa três
 * linhas e preserva a guarda em `lerConfiguracoes_` e `salvarConfiguracao_`: sem
 * ela, o primeiro segredo que alguém acrescentasse viajaria para o navegador no
 * mesmo deploy que o criasse.
 */
var CONFIG_SEGREDOS = {};

/** Nome da propriedade do script que guarda a chave, ou null se ela é do banco. */
function configSegredo_(chave) {
  return CONFIG_SEGREDOS[chave] || null;
}

/**
 * Todas as chaves de configuração do banco, como mapa chave -> texto.
 *
 * Não inclui os segredos: eles não estão no documento, e quem quer um deles pede
 * por `config_('<chave>')`, que sabe onde procurar. Ver CONFIG_SEGREDOS.
 */
function lerConfig_() {
  if (CONFIG_CACHE) return CONFIG_CACHE;

  if (CONFIG_CACHE_DO_SCRIPT_VALE) {
    var guardada = configDoScript_();
    if (guardada) {
      CONFIG_CACHE = guardada;
      return CONFIG_CACHE;
    }
  }

  var documento = ler_(CONFIG_COLECAO, CONFIG_DOCUMENTO) || {};
  var cfg = {};

  Object.keys(documento).forEach(function (chave) {
    // `_id` e `_nome` são metadados que o Repo acrescenta na leitura, não campos.
    if (chave.charAt(0) === '_') return;
    cfg[chave] = String(documento[chave]);
  });

  CONFIG_CACHE = cfg;
  guardarConfigNoScript_(cfg);
  return cfg;
}

/** A configuração guardada no cache do script, ou null. Ver CONFIG_CACHE_SEGUNDOS. */
function configDoScript_() {
  try {
    var bruta = CacheService.getScriptCache().get(CONFIG_CACHE_CHAVE);
    if (bruta === null || bruta === undefined) return null;
    var cfg = JSON.parse(bruta);
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null;
  } catch (e) {
    // Cache fora do ar ou valor ilegível: lê do banco, como antes do cache.
    return null;
  }
}

/** Guarda a configuração lida do banco no cache do script. Falhar não é erro. */
function guardarConfigNoScript_(cfg) {
  try {
    CacheService.getScriptCache().put(CONFIG_CACHE_CHAVE, JSON.stringify(cfg), CONFIG_CACHE_SEGUNDOS);
  } catch (e) {
    // Não guardou: a próxima execução lê do banco.
  }
}

/**
 * Esquece a configuração guardada no cache do script. Chamado por QUEM GRAVA,
 * para a mudança valer na requisição seguinte, e não um minuto depois.
 */
function esquecerConfigDoScript_() {
  try {
    CacheService.getScriptCache().remove(CONFIG_CACHE_CHAVE);
  } catch (e) {
    // Cache fora do ar: nada guardado, nada a esquecer.
  }
}

/**
 * Valor de uma chave, com padrão.
 *
 * Contrato preservado do projeto atual: chave ausente E chave vazia devolvem o
 * padrão. É o que permite tratar chave escrita em branco pela tela do mesmo
 * jeito que chave nunca criada — as duas significam "não configurado".
 */
function config_(chave, padrao) {
  var propriedade = configSegredo_(chave);
  var valor = propriedade
    ? PropertiesService.getScriptProperties().getProperty(propriedade)
    : lerConfig_()[chave];

  if (valor === undefined || valor === null || valor === '') {
    return padrao === undefined ? '' : padrao;
  }
  return String(valor);
}

/**
 * Grava uma chave.
 *
 * O PATCH com updateMask cria o documento se ele ainda não existir e mexe só no
 * campo enviado — não existe "criar a configuração" separado, e gravar uma chave
 * nunca apaga as outras.
 */
function gravarConfig_(chave, valor) {
  var propriedade = configSegredo_(chave);
  if (propriedade) {
    PropertiesService.getScriptProperties().setProperty(propriedade, String(valor));
    return;
  }

  var campo = {};
  campo[chave] = String(valor);
  atualizar_(CONFIG_COLECAO, CONFIG_DOCUMENTO, campo);
  esquecerConfigDoScript_();

  // A allowlist tem uma cópia em cache no caminho do link por e-mail
  // (07b_LinkPorEmail.gs). Ela é esquecida AQUI, e não em cada um dos quatro
  // lugares que mexem na lista, porque este é o funil por onde todos passam —
  // `incluirAdmin_`, `removerAdmin_`, `regravarAllowlist_` e `liberarAcesso`.
  // Espalhar a chamada seria garantir que o quinto caminho, o que ainda não
  // existe, esqueceria de fazê-la: e o sintoma seria alguém removido do acesso
  // continuar recebendo link por cinco minutos.
  if (chave === 'admin_emails') esquecerAllowlistDoLink_();

  // Cache corrigido no lugar em vez de descartado: descartar cobraria uma
  // leitura nova para reconstruir o que já se sabe.
  if (CONFIG_CACHE) CONFIG_CACHE[chave] = String(valor);
}

/**
 * Grava AS DUAS chaves do acesso — quem entra e quem é coordenador geral — numa
 * escrita só.
 *
 * Irmã burra de `gravarConfig_`: ela não decide nada, e não pode. Quem decide é
 * `aplicarAcessos_` (07_Auth.gs), a ÚNICA chamadora, e é lá dentro que mora a
 * invariante de o painel nunca ficar sem nenhum coordenador geral.
 *
 * POR QUE UMA ESCRITA, E NÃO DUAS. As duas chaves são campos do MESMO documento
 * (ver o cabeçalho deste arquivo), e mudar o nível de alguém é uma mudança só.
 * Com dois `gravarConfig_` em sequência existiria um instante que ninguém
 * desenhou — a lista de acesso nova com os coordenadores velhos —, e uma
 * execução que morresse no meio o deixaria gravado. `semearConfigPadrao_` já
 * escreve o lote inteiro assim, pela mesma razão.
 *
 * O `esquecerAllowlistDoLink_` e a correção do cache são os mesmos de
 * `gravarConfig_`, e não são zelo: ESTE é o quinto caminho que o comentário de lá
 * previu, e o sintoma de esquecê-lo seria alguém removido do acesso continuar
 * recebendo link por cinco minutos.
 *
 * As listas chegam como vetor e viram texto aqui, com `', '` — o mesmo formato
 * que as quatro funções de gestão sempre gravaram, e o que `adminEmails_` e
 * `coordenadoresGerais_` sabem reler.
 */
function gravarAcessos_(emails, gerais) {
  var campos = {
    admin_emails: (emails || []).join(', '),
    coordenadores_gerais: (gerais || []).join(', ')
  };

  atualizar_(CONFIG_COLECAO, CONFIG_DOCUMENTO, campos);
  esquecerConfigDoScript_();
  esquecerAllowlistDoLink_();

  if (CONFIG_CACHE) {
    CONFIG_CACHE.admin_emails = campos.admin_emails;
    CONFIG_CACHE.coordenadores_gerais = campos.coordenadores_gerais;
  }
}

/**
 * Descarta o cache da execução E o do script.
 *
 * Existe para `provaConfigELog()` (20_Prova.gs) poder provar que o valor foi ao
 * banco e voltou: sem descartar, `config_()` responderia da memória, ou do cache
 * do script, e a prova não provaria nada.
 */
function limparCacheConfig_() {
  CONFIG_CACHE = null;
  esquecerConfigDoScript_();
}

/** Config em lista, separada por '|' (cursos e fases, turnos). */
function configLista_(chave) {
  return config_(chave, '').split('|')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

/**
 * Cria no banco as chaves de CONFIG_PADRAO que ainda não existem.
 *
 * Nunca sobrescreve: rodar de novo depois de a coordenação ter mudado um texto
 * de tela não pode desfazer a mudança. É o mesmo contrato do setup do projeto
 * atual, e é o que torna esta função segura de chamar em toda implantação.
 *
 * Duas coisas de CONFIG_PADRAO ficam de fora de propósito:
 *   - `descricao`, que é documentação da chave e já vive no código, em
 *     00_Config.gs. Copiá-la para o banco só engordaria o documento que o
 *     formulário público lê a cada visita.
 *   - as chaves de CONFIG_SEGREDOS, que por definição não moram no banco. Hoje
 *     não há nenhuma.
 *
 * Devolve a lista de chaves criadas — vazia quando não havia nada a fazer.
 */
function semearConfigPadrao_() {
  var atual = lerConfig_();
  var novas = {};
  var criadas = [];

  CONFIG_PADRAO.forEach(function (item) {
    if (configSegredo_(item.chave)) return;
    if (atual[item.chave] !== undefined) return;
    novas[item.chave] = String(item.valor);
    criadas.push(item.chave);
  });

  // Uma única escrita para o lote inteiro: o documento é um só.
  if (criadas.length) {
    atualizar_(CONFIG_COLECAO, CONFIG_DOCUMENTO, novas);
    esquecerConfigDoScript_();
    criadas.forEach(function (chave) { CONFIG_CACHE[chave] = novas[chave]; });
  }

  return criadas;
}

/**
 * Prepara um ambiente novo. Rode UMA vez, do editor, depois de criar o banco.
 *
 * Existe por um motivo bobo e caro: o Apps Script não lista no seletor de função
 * do editor os nomes terminados em sublinhado — é como ele marca "privada". A
 * `semearConfigPadrao_` só era chamável de dentro do código, então num banco
 * recém-criado ninguém conseguia semear a configuração, e sem ela `cursos_fases`
 * volta vazia e TODA inscrição é recusada com "Selecione seu curso e fase".
 * O sistema parecia quebrado e não estava.
 *
 * Idempotente: rodar de novo não sobrescreve o que a coordenação já mudou.
 *
 * O relatório confere as DUAS coisas sem as quais ninguém entra no painel: o
 * GOOGLE_CLIENT_ID (o botão) e a allowlist (quem o botão aceita, e para quem o
 * link por e-mail pode ser enviado). Faltando as duas, a saída é rodar
 * `liberarAcesso("seu-email")` aqui mesmo no editor.
 *
 * A allowlist do relatório é a que VALE — a mesma que o botão e o link conferem
 * (`adminEmails_`, 07_Auth.gs) —, e não o texto cru da chave: com só itens sem
 * forma de e-mail, o texto não está vazio e ninguém entra, e o relatório diria
 * que há gente com acesso justamente no dia em que a saída é `liberarAcesso`. Os
 * itens sem forma saem citados à parte, porque o campo `admin_emails` da aba
 * Configurações ainda os mostra.
 */
function setup() {
  exigirDono_();
  return setup_();
}

/** O trabalho de `setup`, depois da guarda. É esta que o código chama por dentro. */
function setup_() {
  var criadas = semearConfigPadrao_();
  var clienteId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  var lista = adminEmails_();
  var semForma = descartadosDaAllowlist_();

  Logger.log('=== setup ===');
  Logger.log('projeto Firestore: %s / banco: %s', fsProjeto_(), fsBanco_());
  Logger.log(criadas.length
    ? 'configuração: ' + criadas.length + ' chave(s) criada(s) — ' + criadas.join(', ')
    : 'configuração: nada a criar, o banco já estava semeado');
  Logger.log(clienteId
    ? 'GOOGLE_CLIENT_ID: definido'
    : 'GOOGLE_CLIENT_ID: FALTANDO. Configurações do projeto > Propriedades do script > ' +
      'Adicionar propriedade. Sem ele o botão "Entrar com o Google" não é desenhado.');
  Logger.log(lista.length
    ? 'quem tem acesso: ' + lista.join(', ')
    : 'quem tem acesso: VAZIO. Ninguém entra no painel enquanto estiver assim — nem ' +
      'pelo Google, nem por link. Rode liberarAcesso("seu-email@dominio") para se incluir.');
  if (semForma.length) {
    Logger.log('na lista de acesso, sem forma de e-mail (não entram): ' + semForma.join(', '));
  }

  return {
    configuracoesCriadas: criadas,
    clienteIdDefinido: Boolean(clienteId),
    allowlistVazia: !lista.length
  };
}
