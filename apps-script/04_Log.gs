/**
 * 04_Log.gs — a trilha de auditoria.
 *
 * `registrar()` tem a mesma assinatura do projeto sobre Sheets, onde ela grava
 * uma linha na aba Log. Aqui grava um documento na coleção `log`. Quem chama —
 * 07_Auth.gs, e depois inscrições, importação e reconciliação — não muda.
 *
 * O que muda é o id do documento, e essa é a decisão do arquivo. Ver `logId_`.
 */

var LOG_COLECAO = 'log';

/**
 * Por quanto tempo um registro interessa.
 *
 * Um ano letivo: é o horizonte em que alguém ainda pode perguntar quem importou
 * a lista errada ou quem apagou o projeto. Depois disso, a linha é peso.
 */
var LOG_RETENCAO_DIAS = 365;

/** Teto de segurança de `ultimosRegistros`, para ninguém pedir a coleção inteira. */
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
function registrar(acao, entidade, entidadeId, detalhe) {
  try {
    var utc = logCarimboUtc_();
    inserir(LOG_COLECAO, {
      // Três carimbos, três leitores. `criado_em` é UTC de largura fixa e é por
      // ele que se ordena — ver `ultimosRegistros`. `timestamp` é hora local
      // legível ('2026-08-05 16:50:00'), para o painel mostrar. E o id começa
      // pelo mesmo UTC de `criado_em`, o que mantém id e ordem coerentes.
      criado_em: utc,
      timestamp: agora(),
      usuario: usuarioAtual(),
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
 *     duplicado — é registro PERDIDO, porque `inserir` recusa id ocupado.
 */
function logId_(carimbo) {
  return (carimbo || logCarimboUtc_()) + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 6);
}

/**
 * Registra uma recusa, agrupando repetições numa janela.
 *
 * Existe por causa de um buraco medido na revisão: toda recusa de
 * `verificarAntiAbuso_` chamava `registrar()`, e `registrar()` é uma ESCRITA no
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
 * Nunca lança, pelo mesmo motivo de `registrar()`.
 */
function registrarRecusa(acao, entidade, entidadeId, detalhe, chave) {
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

    registrar(acao, entidade, entidadeId,
      engolidas > 0 ? detalhe + ' (+' + engolidas + ' iguais desde a última anotação)' : detalhe);
  } catch (e) {
    // Cache indisponível não pode virar recusa não registrada. Grava direto e
    // aceita o custo: é o caminho raro, e perder a trilha é pior que a escrita.
    registrar(acao, entidade, entidadeId, detalhe);
  }
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
function ultimosRegistros(limite) {
  var n = Number(limite) > 0 ? Math.min(Math.floor(Number(limite)), LOG_MAX_LEITURA) : 50;
  return listar(LOG_COLECAO, { ordenarPor: 'criado_em', direcao: 'DESC', limite: n }).itens;
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
function usuarioAtual() {
  try {
    return Session.getActiveUser().getEmail() || 'anonimo';
  } catch (e) {
    return 'anonimo';
  }
}
