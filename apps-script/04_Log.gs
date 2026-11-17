/**
 * 04_Log.gs — a trilha de auditoria.
 *
 * `registrar_()` tem a mesma assinatura do projeto sobre Sheets, onde ela grava
 * uma linha na aba Log. Aqui grava um documento na coleção `log`. Quem chama —
 * 07_Auth.gs, e depois inscrições, importação e reconciliação — não muda.
 *
 * O que muda é o id do documento, e essa é a decisão do arquivo. Ver `logId_`.
 *
 * ------------------------------------------------------ QUEM fez: o operador
 *
 * A coluna `usuario` gravava `usuarioAtual_()`, e no web app publicado ela vale
 * 'anonimo': `Session.getActiveUser()` volta vazio em `executeAs:
 * USER_DEPLOYING` acessado por conta comum (o topo de 07_Auth.gs conta por
 * quê). Com uma pessoa só isso era incômodo; com uma lista de acesso e dois
 * níveis, a coluna "Quem" deixa de responder a única pergunta que existe para
 * responder — "qual professor exportou a base?".
 *
 * Quem sabe o e-mail é a SESSÃO, e o único lugar por onde toda função do painel
 * passa com o token na mão é `exigirAdmin_` (07_Auth.gs). Por isso o e-mail
 * entra por uma VARIÁVEL DE EXECUÇÃO — `anotarOperador_`, escrita lá — e não
 * por um parâmetro novo de `registrar_()`:
 *
 *   - o parâmetro obrigaria as ~70 chamadas de `registrar_` a ter o token à mão,
 *     e boa parte delas está em funções fundas (`gravarInscricao_`,
 *     `decorarComATroca_`, `restaurarUma_`) que hoje não sabem nem que existe
 *     sessão. Seriam setenta lugares onde esquecê-lo é SILENCIOSO: a linha sai
 *     com a coluna errada, que é exatamente o que ela já fazia;
 *   - a variável tem um escritor e um leitor, e o escritor é a guarda que já
 *     recebe o token por construção. Função de painel nova ganha o operador de
 *     graça, porque ela começa por `exigirAdmin_`.
 *
 * O que torna a variável segura é o modelo de execução do Apps Script: cada
 * requisição roda o script do zero, então ela nasce vazia a cada execução e não
 * atravessa de uma pessoa para a outra. Dentro de uma execução há UMA ação de
 * painel, com um token só (`rotaDoPainel_`, 08_Api.gs). E `exigirAdmin_` a LIMPA
 * quando o token não vale — recusa não tem operador, e não herda o nome de quem
 * passou antes dela.
 *
 * O que NÃO muda: os caminhos SEM sessão — o formulário do aluno, os gatilhos
 * diários, o `liberarAcesso()` do editor — continuam caindo em `usuarioAtual_()`,
 * que é quem responde por eles. E a regra de dado pessoal continua inteira:
 * quem entra na trilha é o OPERADOR, nunca o aluno.
 */

var LOG_COLECAO = 'log';

/**
 * Por quanto tempo um registro interessa.
 *
 * Um ano letivo: é o horizonte em que alguém ainda pode perguntar quem importou
 * a lista errada ou quem apagou o projeto. Depois disso, a linha é peso.
 */
var LOG_RETENCAO_DIAS = 365;

/** Teto de segurança de `ultimosRegistros_`, para ninguém pedir a coleção inteira. */
var LOG_MAX_LEITURA = 500;

/**
 * Janela em que repetições da MESMA recusa viram um registro só.
 *
 * Dez minutos. Quem investiga um abuso quer saber que ele aconteceu, quando
 * começou e o tamanho — não quer vinte mil linhas iguais, e o banco não quer
 * pagar por elas.
 */
var LOG_JANELA_AGRUPAMENTO_S = 600;

/**
 * Registra uma ação. Nunca lança.
 *
 * A auditoria não pode derrubar quem a chamou: uma inscrição que foi gravada com
 * sucesso não pode virar erro na tela do aluno porque o log falhou. O erro é
 * engolido de propósito — mas vai para o console, que é o Stackdriver do projeto
 * (`exceptionLogging: STACKDRIVER` no manifesto), então "sumiu do log" continua
 * sendo uma pergunta respondível.
 */
function registrar_(acao, entidade, entidadeId, detalhe) {
  try {
    var utc = logCarimboUtc_();
    inserir_(LOG_COLECAO, {
      // Três carimbos, três leitores. `criado_em` é UTC de largura fixa e é por
      // ele que se ordena — ver `ultimosRegistros_`. `timestamp` é hora local
      // legível ('2026-08-05 16:50:00'), para o painel mostrar. E o id começa
      // pelo mesmo UTC de `criado_em`, o que mantém id e ordem coerentes.
      criado_em: utc,
      timestamp: agora_(),
      // O operador da execução, quando há um; `usuarioAtual_()` quando não há.
      // Ver `quemOperou_`, no fim do arquivo, e o cabeçalho para por que isto
      // não é um parâmetro desta função.
      usuario: quemOperou_(),
      acao: acao,
      entidade: entidade || '',
      entidade_id: entidadeId || '',
      detalhe: typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe || {}),
      expira_em: logExpiraEm_()
    }, logId_(utc));
  } catch (e) {
    console.error('Falha ao registrar log: ' + e.message);
  }
}

/**
 * Id cronologicamente ordenável: '20260805T195012123Z_a1b2c3'.
 *
 * Sem ordenação embutida no id, "os últimos 50 eventos" viraria varredura da
 * coleção inteira — e leitura no Firestore é cobrada por documento. Com ela,
 * a mesma pergunta é `orderBy(__name__ DESC) + limit(50)`: 50 documentos lidos,
 * seja o log de mil linhas ou de um milhão. E `__name__` já é indexado por
 * construção, então não há índice a criar nem a manter.
 *
 * Detalhes que não são estéticos:
 *   - UTC, e não America/Sao_Paulo. Ordenação de texto só coincide com ordenação
 *     de tempo se o fuso for fixo, e horário de verão (que o Brasil pode
 *     retomar) embaralharia uma hora do log por ano.
 *   - Formato básico do ISO 8601, sem '-' nem ':'. Largura fixa é o que faz a
 *     comparação de texto valer como comparação de tempo; e os dois pontos
 *     precisariam ser escapados na URL do documento.
 *   - Sufixo aleatório: milissegundo não é chave. Duas execuções simultâneas
 *     gravando no mesmo milissegundo colidiriam, e colisão aqui não é registro
 *     duplicado — é registro PERDIDO, porque `inserir_` recusa id ocupado.
 */
function logId_(carimbo) {
  return (carimbo || logCarimboUtc_()) + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 6);
}

/**
 * Registra uma recusa, agrupando repetições numa janela.
 *
 * Existe por causa de um buraco medido na revisão: toda recusa de
 * `verificarAntiAbuso_` chamava `registrar_()`, e `registrar_()` é uma ESCRITA no
 * Firestore. As guardas funcionavam — recusavam —, mas gastavam a escrita antes
 * de recusar, e sem teto. Vinte mil requisições vazias, que um laço de terminal
 * faz em minutos, queimavam a cota de escrita do dia; a partir dali toda
 * inscrição de verdade virava "Erro ao registrar", até a meia-noite do
 * Pacífico. Sem botão para religar — exatamente a falha que este projeto existe
 * para não ter.
 *
 * Deixar de registrar seria trocar um problema por outro: saber que houve
 * ataque tem valor. O que não tem valor é a vigésima milésima linha idêntica.
 *
 * Então: a primeira ocorrência de cada `chave` na janela é gravada; as
 * seguintes só incrementam um contador no CacheService, e a próxima gravação
 * (na janela seguinte) diz quantas foram engolidas. O custo em escrita passa a
 * ser, no máximo, uma por chave por janela — independente do volume do ataque.
 *
 * Nunca lança, pelo mesmo motivo de `registrar_()`.
 */
function registrarRecusa_(acao, entidade, entidadeId, detalhe, chave) {
  try {
    var cache = CacheService.getScriptCache();
    var nome = String(chave || acao);

    // Duas chaves, e as duas precisam existir. A da JANELA diz "já gravei há
    // pouco" e expira sozinha, abrindo a próxima. A do CONTADOR sobrevive à
    // janela — se expirasse junto, a gravação seguinte não teria como dizer
    // quantas foram engolidas, que é justamente o número que interessa a quem
    // investiga.
    var chaveJanela = 'recusa_janela_' + nome;
    var chaveContador = 'recusa_total_' + nome;

    if (cache.get(chaveJanela)) {
      var n = Number(cache.get(chaveContador) || 0) + 1;
      cache.put(chaveContador, String(n), LOG_JANELA_AGRUPAMENTO_S * 6);
      return;
    }

    var engolidas = Number(cache.get(chaveContador) || 0);
    cache.put(chaveJanela, '1', LOG_JANELA_AGRUPAMENTO_S);
    cache.put(chaveContador, '0', LOG_JANELA_AGRUPAMENTO_S * 6);

    registrar_(acao, entidade, entidadeId,
      engolidas > 0 ? detalhe + ' (+' + engolidas + ' iguais desde a última anotação)' : detalhe);
  } catch (e) {
    // Cache indisponível não pode virar recusa não registrada. Grava direto e
    // aceita o custo: é o caminho raro, e perder a trilha é pior que a escrita.
    registrar_(acao, entidade, entidadeId, detalhe);
  }
}

/**
 * O erro que só o console via, anotado também na trilha.
 *
 * As chamadas do site e do painel chegam ao Apps Script sem conta — o `fetch`
 * vai sem credencial. A tela Execuções do editor as lista (App da Web, com a
 * função, a versão e o status), mas ela é do editor, que a coordenação não abre,
 * e o erro que uma rota trata termina lá como execução concluída: a função
 * respondeu, não lançou. Um erro nas rotas públicas virava uma frase genérica
 * na tela de quem chamou ("Erro ao registrar...", "Não foi possível
 * carregar...") e nada em lugar nenhum que a coordenação olhe. O Histórico do
 * painel é esse lugar.
 *
 * O NOME VAI NO DETALHE, e não só em `entidade_id`: a aba Histórico desenha
 * Quando, Quem, Ação, Entidade e Detalhe, e duas linhas de rotas diferentes com
 * o mesmo erro do banco sairiam iguais na tela. 'leitura: Firestore 503 ...' e
 * 'inscricao: Firestore 503 ...' é o que as separa. `entidade_id` continua com o
 * nome, para quem lê o banco.
 *
 * Pelo freio de `registrarRecusa_`: a primeira de cada `onde` a cada dez minutos
 * vira linha, e a seguinte diz quantas foram engolidas. Uma rota que falhe em
 * série — o banco fora do ar, uma enxurrada de requisições — não vira uma
 * escrita por requisição. Por isso `onde` é sempre um nome FIXO, escrito por
 * quem chama, e nunca algo que veio do cliente: a chave do freio não pode ser
 * escolhida de fora, senão cada nome inventado ganharia a sua escrita.
 *
 * A mensagem vai sem id de documento nenhum (`semIdDeDocumento_`, logo abaixo) e
 * cortada, com o nome na frente. Nunca lança: o erro que se está anotando já é o
 * problema.
 */
function registrarErroInterno_(onde, err) {
  try {
    registrarRecusa_('ERRO_INTERNO', 'servidor', onde,
      (onde + ': ' + semIdDeDocumento_(err)).slice(0, 200), 'erro_interno_' + onde);
  } catch (e) {
    console.error('registrarErroInterno_ ' + onde + ': ' + e.message);
  }
}

/**
 * Um caminho de documento RELATIVO à raiz do banco: '/<coleção>/<id>', com mais
 * pedaços ou com query. É o que `fsErro_` (02_Repo.gs) põe na mensagem logo
 * depois do método — 'Firestore 503 UNAVAILABLE em GET /matriculados/<matrícula>'
 * —, e o id ali é a matrícula, o protocolo de uma inscrição, o de qualquer
 * documento lido ou escrito.
 *
 * O primeiro grupo é o caractere de antes, que fica: o caminho começa no início
 * do texto ou depois de algo que não é letra, dígito, `:`, `/` nem `.` — o que
 * deixa de fora o endereço do Google ('https://...') e uma data ('16/11/2026').
 * Cada pedaço é o que `encodeURIComponent` deixa num id, mais o `%` do que ele
 * codifica, e depois do primeiro vem `/` ou `?`: só o nome da coleção, sem id e
 * sem query ('em POST /inscricoes'), não é documento de ninguém e continua. A
 * query vai até o espaço, e para antes do `:` que fecha o trecho ('?a=b: texto').
 */
var CAMINHO_DE_DOCUMENTO =
  /(^|[^\w:\/.])\/[\w.!~*'()%-]+(?=[\/?])(?:\/[\w.!~*'()%-]*)*(?:\?\S*?(?=:?(?:\s|$)))?/g;

/**
 * A mensagem de erro sem id de documento nenhum — a régua da trilha.
 *
 * `semCaminhoDeDocumento_` (02_Repo.gs) tira o nome inteiro, 'projects/...', que
 * é a forma em que o texto do Firestore cita o documento; o caminho relativo que
 * o próprio `fsErro_` escreve passa por ela. Para a trilha ele também sai,
 * trocado por '/(documento)': a linha fica no banco por um ano
 * (LOG_RETENCAO_DIAS), vai para o backup e aparece no Histórico, e o que ela
 * precisa dizer é o código, o status e o método — 'Firestore 503 UNAVAILABLE em
 * GET /(documento)' —, e não de quem era o documento.
 */
function semIdDeDocumento_(err) {
  return semCaminhoDeDocumento_(err).replace(CAMINHO_DE_DOCUMENTO, '$1/(documento)');
}

/**
 * O carimbo UTC que abre o id e que também vira o campo `criado_em`.
 *
 * Existe como função própria para que os dois nunca divirjam: id e campo de
 * ordenação têm de contar a mesma hora, senão a ordem da tela deixa de bater
 * com a ordem do id e ninguém percebe.
 */
function logCarimboUtc_() {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

/**
 * Quando este registro deixa de interessar, em ISO-8601 UTC.
 *
 * O campo existe para uma política de TTL futura, que apaga sozinha e de graça o
 * que passou da data. A política NÃO está configurada — é um clique no console,
 * e ligar expurgo automático antes de o sistema ter dado de verdade seria ligar
 * uma arma apontada para nada.
 *
 * Ressalva honesta: o TTL do Firestore só olha campos do tipo `timestamp`, e
 * hoje o Repo grava tudo como `stringValue` (ver `fsValor_` em 02_Repo.gs). Do
 * jeito que está, a política não agiria sobre este campo. O formato aqui é
 * exatamente o que o Firestore usa em `timestampValue`, então quando a tipagem
 * forte chegar, o que muda é o tipo do campo — não o valor gravado.
 */
function logExpiraEm_() {
  var ms = new Date().getTime() + LOG_RETENCAO_DIAS * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

/**
 * Os `limite` registros mais recentes, do mais novo para o mais velho.
 *
 * Ordena por `criado_em` — o carimbo UTC de largura fixa, o mesmo que abre o id.
 * Não por `__name__`, e a diferença custou uma execução para ser descoberta: o
 * Firestore cria sozinho índice ascendente E descendente para todo campo comum,
 * mas o índice automático de `__name__` só cobre ascendente. Pedir `__name__`
 * DESC devolve 400 "The query requires an index" e obriga a declarar um índice
 * composto — passo de console que precisaria ser repetido a cada ambiente novo.
 * Ordenar por um campo de verdade não exige nada, e o desempate por `__name__`
 * vem de brinde, na mesma direção.
 */
function ultimosRegistros_(limite) {
  var n = Number(limite) > 0 ? Math.min(Math.floor(Number(limite)), LOG_MAX_LEITURA) : 50;
  return listar_(LOG_COLECAO, { ordenarPor: 'criado_em', direcao: 'DESC', limite: n }).itens;
}

/**
 * E-mail de quem está executando, ou 'anonimo'.
 *
 * Mora aqui, e não em 01_Utils.gs, por dois motivos: ela é o "quem" da trilha de
 * auditoria, que é o assunto deste arquivo, e 01_Utils.gs hoje é código puro —
 * normaliza texto, valida CPF, formata data — que roda sem nenhum serviço do
 * Google além de Utilities. Trazer `Session` para lá custaria essa pureza, que é
 * o que deixa aquele arquivo testável fora do Apps Script.
 *
 * No projeto atual ela vivia no repositório por acidente histórico, sem tocar em
 * planilha nenhuma.
 *
 * Vem vazio em web app publicado como "executar como: eu" acessado por conta
 * comum — o servidor não sabe quem está do outro lado. É exatamente por isso que
 * 07_Auth.gs tem o caminho do PIN.
 */
function usuarioAtual_() {
  try {
    return Session.getActiveUser().getEmail() || 'anonimo';
  } catch (e) {
    return 'anonimo';
  }
}

/**
 * Quem opera ESTA execução, quando o servidor tem como saber.
 *
 * Vazio é o estado normal do formulário público, dos gatilhos diários e do
 * editor — ninguém provou sessão nenhuma ali. Ver o cabeçalho do arquivo para
 * por que o operador mora numa variável e não num parâmetro de `registrar_`.
 */
var OPERADOR_DA_EXECUCAO = '';

/**
 * Anota quem opera — ou apaga a anotação, com vazio. Quem a chama é
 * `exigirAdmin_` (07_Auth.gs), nos dois desfechos dela.
 *
 * Não valida nem normaliza de propósito: quem chama já tirou o e-mail da sessão
 * por `emailDaSessao_`, que é o único lugar que sabe ler uma. Normalizar de
 * novo aqui seria uma SEGUNDA definição de "e-mail da sessão", e o dia em que
 * as duas discordassem seria o dia em que a trilha assina um nome e a allowlist
 * compara outro — é o mesmo argumento do cabeçalho de `adminEmails_`.
 */
function anotarOperador_(email) {
  OPERADOR_DA_EXECUCAO = String(email || '');
}

/**
 * O "quem" de cada linha da trilha.
 *
 * A ORDEM É A DECISÃO. `usuarioAtual_()` responde de verdade no editor e nos
 * gatilhos, e responde 'anonimo' exatamente onde a sessão sabe o nome — então o
 * operador vem primeiro, e a identidade da implantação fica como resposta de
 * quem nunca teve sessão. Invertida, a trilha do painel publicado continuaria
 * dizendo 'anonimo' e nada nesta mudança teria efeito.
 */
function quemOperou_() {
  return OPERADOR_DA_EXECUCAO || usuarioAtual_();
}
