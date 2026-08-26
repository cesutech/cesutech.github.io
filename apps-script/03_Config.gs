/**
 * 03_Config.gs — a configuração do sistema, sobre o Firestore.
 *
 * A API pública é a mesma que o projeto sobre Sheets
 * (o sistema anterior, sobre Google Sheets) expõe: `lerConfig`, `config`,
 * `gravarConfig` e `configLista`. 07_Auth.gs foi trazido de lá sem alteração e
 * chama `config()` em quatro pontos — assinatura idêntica é o que permite
 * continuar trazendo as regras de negócio com desvio de chamada, e não com
 * reescrita.
 *
 * DESENHO: a configuração é UM documento, com um campo por chave. Não é uma
 * coleção com um documento por chave.
 *
 * O motivo é custo de leitura. `config()` está no caminho quente: `autenticar()`
 * a chama duas vezes por login, `modoDeAcesso()` outras duas, e o formulário
 * público (`dadosFormularioPublico_`, quando for trazido) vai consultar a cada
 * carregamento da página. No Firestore cobra-se por DOCUMENTO lido, contra um
 * teto de 50 mil leituras por dia no plano Spark. As 16 chaves de CONFIG_PADRAO
 * espalhadas em 17 documentos custariam 17 leituras por requisição, e o dia
 * acabaria em menos de 3 mil visitas ao formulário. Num documento só, custam 1 —
 * e o cache de execução abaixo derruba até isso para uma leitura por execução.
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
 * Repo sobre Sheets, e pela mesma razão: dentro de um login, `config()` é
 * chamada várias vezes e o valor não pode mudar no meio.
 */
var CONFIG_CACHE = null;

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
 * linhas e preserva a guarda em `lerConfiguracoes` e `salvarConfiguracao`: sem
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
 * por `config('<chave>')`, que sabe onde procurar. Ver CONFIG_SEGREDOS.
 */
function lerConfig() {
  if (CONFIG_CACHE) return CONFIG_CACHE;

  var documento = ler(CONFIG_COLECAO, CONFIG_DOCUMENTO) || {};
  var cfg = {};

  Object.keys(documento).forEach(function (chave) {
    // `_id` e `_nome` são metadados que o Repo acrescenta na leitura, não campos.
    if (chave.charAt(0) === '_') return;
    cfg[chave] = String(documento[chave]);
  });

  CONFIG_CACHE = cfg;
  return cfg;
}

/**
 * Valor de uma chave, com padrão.
 *
 * Contrato preservado do projeto atual: chave ausente E chave vazia devolvem o
 * padrão. É o que permite tratar chave escrita em branco pela tela do mesmo
 * jeito que chave nunca criada — as duas significam "não configurado".
 */
function config(chave, padrao) {
  var propriedade = configSegredo_(chave);
  var valor = propriedade
    ? PropertiesService.getScriptProperties().getProperty(propriedade)
    : lerConfig()[chave];

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
function gravarConfig(chave, valor) {
  var propriedade = configSegredo_(chave);
  if (propriedade) {
    PropertiesService.getScriptProperties().setProperty(propriedade, String(valor));
    return;
  }

  var campo = {};
  campo[chave] = String(valor);
  atualizar(CONFIG_COLECAO, CONFIG_DOCUMENTO, campo);

  // A allowlist tem uma cópia em cache no caminho do link por e-mail
  // (07b_LinkPorEmail.gs). Ela é esquecida AQUI, e não em cada um dos quatro
  // lugares que mexem na lista, porque este é o funil por onde todos passam —
  // `incluirAdmin`, `removerAdmin`, `regravarAllowlist_` e `liberarAcesso`.
  // Espalhar a chamada seria garantir que o quinto caminho, o que ainda não
  // existe, esqueceria de fazê-la: e o sintoma seria alguém removido do acesso
  // continuar recebendo link por cinco minutos.
  if (chave === 'admin_emails') esquecerAllowlistDoLink_();

  // Cache corrigido no lugar em vez de descartado: descartar cobraria uma
  // leitura nova para reconstruir o que já se sabe.
  if (CONFIG_CACHE) CONFIG_CACHE[chave] = String(valor);
}

/**
 * Descarta o cache da execução.
 *
 * Existe para `provaConfigELog()` (20_Prova.gs) poder provar que o valor foi ao
 * banco e voltou: sem descartar, `config()` responderia da memória e a prova não
 * provaria nada.
 */
function limparCacheConfig() {
  CONFIG_CACHE = null;
}

/** Config em lista, separada por '|' (cursos e fases, turnos). */
function configLista(chave) {
  return config(chave, '').split('|')
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
  var atual = lerConfig();
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
    atualizar(CONFIG_COLECAO, CONFIG_DOCUMENTO, novas);
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
 */
function setup() {
  var criadas = semearConfigPadrao_();
  var clienteId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  var lista = String(config('admin_emails', '')).trim();

  Logger.log('=== setup ===');
  Logger.log('projeto Firestore: %s / banco: %s', fsProjeto_(), fsBanco_());
  Logger.log(criadas.length
    ? 'configuração: ' + criadas.length + ' chave(s) criada(s) — ' + criadas.join(', ')
    : 'configuração: nada a criar, o banco já estava semeado');
  Logger.log(clienteId
    ? 'GOOGLE_CLIENT_ID: definido'
    : 'GOOGLE_CLIENT_ID: FALTANDO. Configurações do projeto > Propriedades do script > ' +
      'Adicionar propriedade. Sem ele o botão "Entrar com o Google" não é desenhado.');
  Logger.log(lista
    ? 'quem tem acesso: ' + lista
    : 'quem tem acesso: VAZIO. Ninguém entra no painel enquanto estiver assim — nem ' +
      'pelo Google, nem por link. Rode liberarAcesso("seu-email@dominio") para se incluir.');

  return {
    configuracoesCriadas: criadas,
    clienteIdDefinido: Boolean(clienteId),
    allowlistVazia: !lista
  };
}
