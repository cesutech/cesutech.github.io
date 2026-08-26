/**
 * 14_Backup.gs — a cópia de segurança diária do banco inteiro, no Drive.
 *
 * ===================== POR QUE NÃO O EXPORT NATIVO DO FIRESTORE ==============
 *
 * O Firestore tem exportação própria (`projects.databases.exportDocuments`, o
 * botão "Exportar" do console). Ela é melhor que este arquivo em tudo — é
 * consistente num instante, não passa pela cota de leitura e não roda dentro de
 * um script com prazo de seis minutos. E ela é INÚTIL aqui, por um detalhe só:
 * ela grava num bucket do Cloud Storage, e Cloud Storage não existe no plano
 * Spark. Ligar o Blaze pede cartão de crédito.
 *
 * A restrição número um deste projeto, desde o primeiro dia, é ZERO CUSTO E SEM
 * CARTÃO. É ela que escolheu o Apps Script como servidor, o Firestore no Spark
 * como banco e o GitHub Pages como site; seria incoerente que justamente o
 * backup — a peça que existe para o dia ruim — dependesse de uma fatura que
 * ninguém aprovou. Então o backup se faz pela MESMA tubulação REST que o sistema
 * usa o dia inteiro (02_Repo.gs): lendo as coleções, página por página, como
 * qualquer outra leitura.
 *
 * O preço dessa escolha está escrito no orçamento, mais abaixo, e é honesto:
 * este backup custa cota de leitura, não é consistente num instante (as coleções
 * são lidas uma depois da outra) e tem teto de tamanho. Para o CESUTECH, com
 * ~2.500 matriculados, isso é barato. Para dez vezes isso, a resposta certa
 * passa a ser o Blaze.
 *
 * ========================== ISTO É DADO PESSOAL DE ALUNO =====================
 *
 * O arquivo gerado aqui traz NOME, MATRÍCULA, CPF, E-MAIL, TELEFONE e DATA DE
 * NASCIMENTO de todo mundo que já se inscreveu ou foi importado. É o documento
 * mais sensível que este sistema produz — a inscrição isolada tem uma pessoa; o
 * backup tem todas.
 *
 * Três consequências práticas, e nenhuma é decorativa:
 *
 *   1. A pasta e os arquivos NUNCA são tornados públicos. `driveTornarPublico_`
 *      (02b_Drive.gs) existe para os banners, que precisam abrir no navegador de
 *      quem não tem conta; aqui ela não é chamada, e não pode passar a ser. Um
 *      backup com link público é o vazamento inteiro num endereço só.
 *   2. A pasta é criada pelo próprio script, com escopo `drive.file`. Ela nasce
 *      na conta que implantou e ninguém mais a enxerga. Não mova estes arquivos
 *      para uma pasta compartilhada "para o professor poder ver": quem precisa
 *      conferir roda `conferirBackup()`, que relata sem entregar o conteúdo.
 *   3. `backup_dias` não é só faxina de disco — é PRAZO DE GUARDA. Ele é o que
 *      impede que uma cópia dos dados de 2026 continue no Drive em 2031.
 *
 * ============================== O QUE ELE GARANTE ============================
 *
 * Quatro regras, cada uma nascida de um modo de falha conhecido. Elas estão
 * repetidas junto do código que as cumpre; aqui está o resumo:
 *
 *   1. A RECICLAGEM NÃO RODA SE O BACKUP DE HOJE NÃO FICOU PRONTO. Backup
 *      quebrado somado a limpeza funcionando é um sistema que apaga o próprio
 *      caminho até o zero, sozinho, em `backup_dias` dias — e o dono só descobre
 *      no dia em que precisa restaurar. Ver `backupReciclar_`.
 *   2. NUNCA FICAM ZERO ARQUIVOS. O mais recente é intocável, mesmo que seja mais
 *      velho que a janela inteira. Sistema parado um mês não pode apagar a última
 *      cópia que tem.
 *   3. A LIMPEZA SÓ TOCA O QUE NÓS CRIAMOS. Duas trancas independentes: o escopo
 *      `drive.file`, que não deixa este script sequer ENXERGAR arquivo de
 *      terceiro, e o padrão do nome, conferido antes de cada exclusão.
 *   4. ARQUIVO PARCIAL NÃO EXISTE. Uma coleção que falha no meio, ou o tempo que
 *      acaba, não produzem arquivo nenhum — e portanto não produzem "o backup de
 *      hoje". Ver `fazerBackup`.
 *
 * ================================= O ORÇAMENTO ===============================
 *
 * LEITURAS. O backup lê |todos os documentos|, uma vez por dia. Com os números
 * reais esperados:
 *
 *     matriculados          2.500
 *     alunos               ~2.500
 *     inscricoes             ~500
 *     inscricoes_anuladas     ~50
 *     disciplinas             ~50
 *     projetos, lotes         ~40
 *     config, agregados          2
 *     ----------------------------
 *     subtotal             ~5.650
 *     log (teto)            5.000
 *     ----------------------------
 *     total              ~10.650 leituras/dia
 *
 * Contra 50.000 por dia do plano Spark, são 21%. A reconciliação de madrugada
 * (06_Reconciliacao.gs) come outros ~5.500, e as duas juntas ficam em ~32% —
 * sobram ~34.000 para o site e o painel, que é onde a cota tem de sobrar. Se as
 * coleções dobrarem, o backup passa a ser o maior consumidor do dia e a conta
 * precisa ser refeita ANTES, não depois.
 *
 * REQUISIÇÕES. Páginas de BACKUP_BLOCO documentos, uma requisição cada: ~30 para
 * ler tudo, mais uma para descobrir as coleções, mais três ou quatro no Drive.
 * Contra 20.000 `UrlFetchApp` por dia, é ruído.
 *
 * TEMPO. O teto de execução do Apps Script é ~6 minutos, e ele vale para o
 * gatilho igual. A conta: ~30 idas ao Firestore a ~0,3-0,5s cada (~15s), mais a
 * serialização de ~10.000 documentos (~1-2s), mais o envio e a releitura de um
 * arquivo de poucos MB (~10-20s). Dá cerca de um minuto — e é por isso que o
 * freio (BACKUP_PRAZO_MS) está em quatro minutos: ele não existe para o caso
 * normal, existe para o dia em que esta conta estiver errada. Estourou o prazo,
 * cai na regra 4: nada é escrito.
 *
 * MEMÓRIA. Todos os documentos ficam em memória de uma vez, e depois viram um
 * texto de poucos MB. É o gargalo menos visível daqui; `fazerBackup` solta o
 * grafo de objetos assim que o JSON está pronto, justamente para não segurar as
 * duas formas ao mesmo tempo.
 *
 * O LOG É O QUE CRESCE SEM TETO. As outras nove coleções são limitadas pela
 * realidade (existem tantos alunos quantos existem); o `log` ganha uma linha por
 * ação, todo dia, para sempre. É ele que um dia estoura o tempo e a cota — e
 * seria ele a fazer o backup INTEIRO falhar, todo dia, deixando o sistema sem
 * cópia nenhuma. Por isso ele tem uma política declarada em vez de um limite
 * acidental: entram os BACKUP_LOG_MAX registros mais recentes, e quando isso
 * corta alguma coisa o arquivo sai marcado (`log_limitado`), o registro de
 * execução diz, e a trilha de auditoria diz. Nunca em silêncio. Ver
 * `backupLerLog_`, que também explica por que isso NÃO faz o backup incompleto.
 *
 * ============================= A FORMA DO ARQUIVO ============================
 *
 * Um JSON por dia, `cesutech-backup-AAAA-MM-DD.json`. O nome é ordenável como
 * texto de propósito: é por ele que a reciclagem decide idade, e é por ele que
 * um humano acha o arquivo certo numa pasta com quinze.
 *
 * JSON puro, sem compactar. Espaço aqui não é problema (quinze arquivos de
 * poucos MB contra os 15 GB da conta), e recuperabilidade é: quem for restaurar
 * num dia ruim tem de conseguir abrir o arquivo com o que tiver à mão — um
 * editor de texto, o navegador, `jq`. Um .gz exige um passo a mais exatamente na
 * hora em que ninguém quer passos a mais. O tamanho vai para o log a cada
 * execução; no dia em que ele incomodar, `Utilities.gzip(blob)` é uma linha, e a
 * troca a ser aceita está escrita aqui.
 *
 * Cada documento vai como `{ id, campos }`, e não como um objeto plano com uma
 * chave `id` no meio dos campos. O motivo é concreto: `projetos` TEM um campo
 * chamado `id` (00_Config.gs), então achatar os dois faria o id do documento e o
 * campo de mesmo nome disputarem a mesma chave — e quem restaurasse gravaria no
 * documento errado sem receber erro nenhum.
 *
 * =========================== COMO SE RESTAURA ISTO ===========================
 *
 * Não existe função de restauração neste arquivo, e a ausência é a decisão: uma
 * função que grava por cima do banco inteiro, chamável por engano do editor, é um
 * jeito conhecido de perder o banco tentando salvá-lo. Restaurar é raro, é
 * decisão de gente, e fica a quinze linhas de distância. O procedimento:
 *
 *   1. Abra a pasta BACKUP_PASTA no Drive da conta que implantou o script e
 *      baixe o arquivo do dia que interessa.
 *   2. Confira o cabeçalho ANTES de qualquer coisa: `completo` tem de ser
 *      `true`; `contagem` e `total` dizem o que ele traz; `log_limitado` avisa se
 *      a trilha de auditoria veio cortada.
 *   3. No editor do Apps Script, escreva a função de restauração da vez — uma
 *      coleção por vez, começando pela que dói mais (em geral `matriculados` e
 *      `alunos`). Cada item traz `id` e `campos`; `escreverEmLote` (02_Repo.gs)
 *      grava em blocos de 500 e usa `_id` como nome do documento:
 *
 *          function restaurarUma(colecao, itens) {
 *            escreverEmLote(colecao, itens.map(function (d) {
 *              var o = {}; Object.keys(d.campos).forEach(function (k) { o[k] = d.campos[k]; });
 *              o._id = d.id; return o;
 *            }));
 *          }
 *
 *   4. O custo é 1 ESCRITA por documento, contra 20.000 por dia do Spark:
 *      restaurar as ~10.000 do arquivo inteiro cabe num dia, e coleção por
 *      coleção cabe com folga. Estourar a cota de escrita para AS inscrições
 *      até a meia-noite do Pacífico — outro motivo para ir por partes.
 *   5. O QUE ISSO NÃO FAZ: não apaga o que foi criado depois do backup (é
 *      sobrescrita, não substituição); não traz de volta os arquivos do Drive
 *      (os banners são arquivos, não documentos); não traz as propriedades do
 *      script (sessões, ids de pasta), que se refazem sozinhas; e não traz o log
 *      posterior ao backup, que se perdeu de verdade.
 *
 * ================================= AS FUNÇÕES ================================
 *
 *   fazerBackup()            é esta que o gatilho chama. Não lança nunca.
 *   instalarGatilhoBackup()  rode UMA vez no editor. Idempotente.
 *   conferirBackup()         lê o backup mais recente e relata. NÃO restaura.
 */

/** Onde os arquivos moram. Criada pelo próprio script; ver `pastaBackup_`. */
var BACKUP_PASTA = 'CESUTECH — backups';

/** A propriedade que guarda o id da pasta, no padrão de 11_Banners.gs. */
var BACKUP_PASTA_PROP = 'PASTA_BACKUP_ID';

/**
 * O nome do arquivo, nas duas direções.
 *
 * Estas duas constantes são a fonte única do padrão: `backupNomeDoDia_` monta a
 * partir delas e `backupDataDoNome_` reconhece a partir delas. Ter o padrão
 * escrito duas vezes é como uma reciclagem passa a não reconhecer o que a
 * gravação criou — e uma limpeza que não reconhece os próprios arquivos ou não
 * apaga nada (barulhento, inofensivo) ou apaga o que não devia (silencioso).
 */
var BACKUP_PREFIXO = 'cesutech-backup-';
var BACKUP_SUFIXO = '.json';

/** JSON, e declarado: é o que faz o Drive mostrar o arquivo como texto. */
var BACKUP_MIME = 'application/json';

/**
 * Versão do FORMATO do arquivo, gravada no cabeçalho.
 *
 * Ela não muda quando o schema de uma coleção muda — o arquivo é genérico, ele
 * copia o que existe. Ela muda se um dia a FORMA mudar (compactação, documentos
 * achatados, backup incremental). Quem restaurar em 2029 precisa saber, olhando
 * o arquivo, com qual leitor está lidando.
 */
var BACKUP_FORMATO = 1;

/** Documentos por página lida. Cada página é uma requisição. */
var BACKUP_BLOCO = 500;

/**
 * Quantos registros do `log` entram no backup, dos mais recentes para os mais
 * antigos.
 *
 * 5.000 é o número que equilibra as duas coisas que brigam aqui. Acima dele, o
 * backup vira o maior consumidor de cota do dia (cada 1.000 registros são 1.000
 * leituras a mais, todo dia, para sempre) e encosta no tempo de execução. Abaixo
 * dele, a trilha de auditoria guardada encolhe demais para responder à pergunta
 * que ela existe para responder ("quem importou a lista errada?").
 *
 * Com o volume real do CESUTECH, 5.000 registros são semanas de histórico. Com o
 * volume de um dia de evento, são poucos dias. Quem precisar de mais aumenta o
 * número sabendo o que ele custa; quem precisar de MUITO mais precisa de outra
 * coisa (backup incremental do log, ou expurgo por `expira_em`, que já está
 * gravado em cada registro por 04_Log.gs).
 */
var BACKUP_LOG_MAX = 5000;

/**
 * Teto de documentos do backup inteiro.
 *
 * 20.000 leituras são 40% da cota diária numa execução só. Passar disso não é
 * "um backup grande", é sinal de que alguma coleção cresceu sem que ninguém
 * reparasse — e nesse caso ler tudo custaria o dia inteiro de cota e ainda
 * morreria no prazo de execução. Estourar o teto cai na regra 4: nada é escrito,
 * a reciclagem não roda, e o registro diz em qual coleção o contador virou.
 */
var BACKUP_TETO_DOCUMENTOS = 20000;

/**
 * Prazo da LEITURA, dentro dos ~6 minutos que o Apps Script concede.
 *
 * Quatro minutos deixam dois de folga para serializar, enviar, reler, conferir e
 * reciclar — passos que não podem ser interrompidos no meio sem deixar sujeira.
 * O prazo é conferido ENTRE coleções, e não dentro de uma: cortar uma coleção ao
 * meio produziria exatamente o arquivo mentiroso que a regra 4 proíbe.
 */
var BACKUP_PRAZO_MS = 4 * 60 * 1000;

/**
 * A hora do gatilho: entre 6h e 7h da manhã, e o horário é uma conta.
 *
 * A cota diária do Spark vira à meia-noite do Pacífico — 4h ou 5h em Brasília,
 * conforme o horário de verão de LÁ (o Brasil não tem mais o seu). A
 * reconciliação roda entre 5h e 6h (06_Reconciliacao.gs) por causa dessa virada.
 * O backup vem depois das duas coisas:
 *
 *   - depois da virada da cota, para gastar as ~10.000 leituras do dia NOVO;
 *   - depois da reconciliação, para copiar `alunos` já reconciliado, e não o
 *     estado de ontem;
 *   - fora da janela dela, para as duas não disputarem os mesmos minutos.
 *
 * O aquecimento (08_Api.gs) bate a cada 5 minutos e portanto bate durante o
 * backup, sem conflito: ele não toca o banco e custa ~3s de execução. O que os
 * três dividem é a cota de 90 MINUTOS DE GATILHO POR DIA do projeto: o
 * aquecimento come ~14, a reconciliação segundos, o backup ~1. Sobra.
 */
var BACKUP_HORA = 6;

/**
 * O nome da função que o gatilho chama. É `fazerBackup` mesmo, e não um
 * embrulho como `reconciliarAutomatico` (06_Reconciliacao.gs): aquele existe
 * porque `reconciliar()` LANÇA (o painel precisa do erro), e gatilho que lança
 * manda e-mail de falha para o dono todo dia. `fazerBackup` já engole a falha e
 * a registra, então o embrulho seria uma camada sem trabalho.
 */
var GATILHO_BACKUP = 'fazerBackup';

// ------------------------------------------------------------ A execução

/**
 * O backup do dia. NUNCA lança — é o gatilho que chama.
 *
 * A sequência inteira, e a ordem é o desenho:
 *
 *   1. está ligado? (`backup_ligado`)
 *   2. quais são as coleções? (as constantes do código MAIS o que o banco tem)
 *   3. lê todas, até o fim, dentro do prazo e do teto
 *   4. serializa e grava no Drive
 *   5. RELÊ do Drive e confere — se não bater, o arquivo vai para a lixeira
 *   6. só então recicla os antigos
 *
 * O passo 5 é o que separa "gravei" de "tenho backup". Um arquivo que nunca foi
 * lido de volta não é backup, é esperança: a gravação pode ter sido truncada, o
 * Drive pode ter aceitado e guardado outra coisa, e o sintoma disso aparece um
 * ano depois, no pior dia. Custa uma leitura do Drive e alguns segundos.
 *
 * QUALQUER falha entre 2 e 5 sai por `catch` e RETORNA: a reciclagem está
 * depois do bloco, e não dentro dele. Isso já bastaria — mas confiar na ordem
 * das linhas é confiar em que ninguém vá mexer nelas, e alguém sempre mexe. Por
 * isso a tranca de verdade não é o lugar do `return`, é o RECIBO: `backupReciclar_`
 * recebe um comprovante e se recusa a fazer qualquer coisa sem ele.
 */
function fazerBackup() {
  var estado = {
    inicio: new Date().getTime(),
    documentos: 0,
    logLimitado: false,
    avisos: []
  };

  // O recibo nasce inválido. Ele só vira válido na última linha do `try`, depois
  // de o arquivo existir no Drive E ter sido conferido. Ver `backupReciclar_`.
  var recibo = { ok: false, data: '', id: '' };
  var resumo = null;

  try {
    if (!backupLigado_()) {
      // Sem `registrar()`: seria uma escrita por dia para dizer que nada
      // aconteceu, e "desliguei o backup" já foi registrado quando alguém salvou
      // a configuração. O registro de execução guarda o resto.
      Logger.log('fazerBackup: backup_ligado está em NAO — não gravo e não apago nada.');
      console.log('fazerBackup: desligado por configuração (backup_ligado=NAO).');
      return { ok: false, ligado: false, motivo: 'backup_ligado está em NAO' };
    }

    var data = backupDataDeHoje_();
    var nome = backupNomeDoDia_(data);
    var colecoes = backupColecoes_();
    var lido = backupLerTudo_(colecoes, estado);

    var arquivo = backupMontarArquivo_(colecoes, lido, estado, nome, data);
    var texto = JSON.stringify(arquivo);

    // Solta o grafo de objetos assim que o texto existe. Segurar as duas formas
    // do mesmo conteúdo é o pico de memória desta execução, e ele não precisa
    // existir: daqui em diante só interessam o texto e as CONTAGENS.
    var contagem = arquivo.contagem;
    arquivo.documentos = null;
    lido = null;

    var criado = driveCriarArquivo_(
      pastaBackup_(),
      Utilities.newBlob(texto, BACKUP_MIME, nome),
      nome
    );

    var conferencia = backupConferir_(criado.id, texto, contagem, colecoes);
    if (!conferencia.ok) {
      // Para a lixeira, e não para o disco: um arquivo que não passou na
      // conferência é lixo com cara de backup, e deixá-lo na pasta o tornaria "o
      // mais recente" — que é justamente o que a regra 2 protege de ser apagado.
      // A lixeira do Drive guarda por 30 dias, então a evidência continua lá
      // para quem for investigar.
      try { driveDescartar_(criado.id); } catch (e) { /* já era, e o erro real é outro */ }
      throw new Error('o arquivo foi gravado e NÃO passou na conferência: ' + conferencia.motivo);
    }

    var substituidos = backupSubstituirDoDia_(data, criado.id);

    resumo = {
      ok: true,
      ligado: true,
      arquivo: nome,
      id: criado.id,
      data: data,
      completo: true,
      total: estado.documentos,
      contagem: contagem,
      log_limitado: estado.logLimitado,
      tamanho_kb: Math.round(texto.length / 1024),
      substituidos: substituidos,
      avisos: estado.avisos,
      ms: new Date().getTime() - estado.inicio
    };

    recibo = { ok: true, data: data, id: criado.id };
  } catch (e) {
    // Daqui não sai arquivo nenhum, e portanto não existe "o backup de hoje" —
    // que é o que a regra 1 confere. O erro vai para o console (Stackdriver) e
    // para a trilha, porque backup que falha calado é backup que não existe.
    console.error('fazerBackup: ' + e.message);
    registrar('ERRO', 'backup', '', 'backup do dia falhou: ' + e.message +
      ' | documentos lidos até parar: ' + estado.documentos);
    Logger.log('fazerBackup FALHOU: %s', e.message);
    return {
      ok: false,
      ligado: true,
      erro: e.message,
      total: estado.documentos,
      avisos: estado.avisos
    };
  }

  // A reciclagem é a ÚNICA coisa neste arquivo que apaga. Ela vem depois, fora
  // do `try`, e ainda assim recebe o recibo e o confere de novo.
  var reciclagem;
  try {
    reciclagem = backupReciclar_(recibo);
  } catch (e) {
    // Falha na limpeza não estraga o backup, que já está gravado e conferido.
    console.error('fazerBackup: a reciclagem falhou — ' + e.message);
    reciclagem = { rodou: false, apagados: 0, motivo: 'erro na reciclagem: ' + e.message };
  }
  resumo.reciclagem = reciclagem;

  registrar('BACKUP', 'drive', resumo.id, JSON.stringify({
    arquivo: resumo.arquivo,
    total: resumo.total,
    contagem: resumo.contagem,
    kb: resumo.tamanho_kb,
    log_limitado: resumo.log_limitado,
    substituidos: resumo.substituidos,
    reciclagem: reciclagem,
    avisos: resumo.avisos,
    ms: resumo.ms
  }));

  Logger.log('=== fazerBackup ===');
  Logger.log('%s — %s documentos, %s KB, %s ms', resumo.arquivo, resumo.total,
    resumo.tamanho_kb, resumo.ms);
  resumo.avisos.forEach(function (a) { Logger.log('AVISO: %s', a); });
  Logger.log(reciclagem.rodou
    ? 'reciclagem: ' + reciclagem.apagados + ' arquivo(s) para a lixeira.'
    : 'reciclagem NÃO rodou: ' + reciclagem.motivo);

  return resumo;
}

// ------------------------------------------------------------ As coleções

/**
 * Quais coleções entram no backup. Duas fontes, e a união das duas.
 *
 * FONTE 1, o código: toda constante global cujo nome termina em `_COLECAO`
 * (`INSCRICOES_COLECAO`, `LOG_COLECAO`, ...). No V8 do Apps Script, todo `var` de
 * primeiro nível vira propriedade do objeto global, então a lista se descobre
 * sozinha. Escrever os dez nomes à mão aqui seria criar uma SEGUNDA lista, e a
 * segunda lista é onde a coleção que nascer amanhã vai deixar de entrar. Esse é o
 * pior modo de falha possível para um backup: silencioso, e descoberto no dia da
 * restauração, quando não há mais o que fazer.
 *
 * FONTE 2, o banco: `fsColecoes_()` (02_Repo.gs) devolve as coleções que
 * realmente têm documentos. Ela custa UMA requisição e pega o caso que a fonte 1
 * não pega — coleção que alguém criou à mão no console, ou que ficou de uma
 * versão antiga do código e ainda guarda dados de gente.
 *
 * As duas juntas cobrem os dois lados: a fonte 1 traz as coleções que existem no
 * código mas ainda estão vazias (entram no arquivo como lista vazia, e isso é
 * informação: significa "estava vazia", não "esqueci dela"); a fonte 2 traz as
 * que existem no banco mas não no código.
 *
 * Se a fonte 2 falhar, o backup FALHA. É deliberado e é a mesma lógica da regra
 * 4: não dá para chamar de backup uma cópia feita sem saber o que havia para
 * copiar. Falhar aqui é seguro — a reciclagem não roda, nada é apagado, e amanhã
 * tenta de novo.
 */
function backupColecoes_() {
  var nomes = {};

  var escopo = (typeof globalThis !== 'undefined') ? globalThis : this;
  Object.keys(escopo).forEach(function (chave) {
    if (chave.length < 9 || chave.slice(-8) !== '_COLECAO') return;
    var valor = escopo[chave];
    if (typeof valor === 'string' && valor) nomes[valor] = true;
  });

  var doBanco;
  try {
    doBanco = fsColecoes_();
  } catch (e) {
    throw new Error('não consegui listar as coleções do banco (' + e.message +
      '), e um backup que não sabe o que copiar não é backup');
  }
  (doBanco || []).forEach(function (nome) {
    if (nome) nomes[String(nome)] = true;
  });

  var lista = Object.keys(nomes).sort();
  if (!lista.length) {
    throw new Error('não encontrei coleção nenhuma — nem pelas constantes ' +
      '*_COLECAO nem pelo banco. Backup de nada não é backup.');
  }
  return lista;
}

/**
 * Lê todas as coleções, na ordem, e para na primeira que não couber.
 *
 * O prazo e o teto são conferidos ENTRE coleções. Dentro de uma, quem lê é
 * `colecaoCompleta_` (06_Reconciliacao.gs), que já pagina e já recusa devolver
 * meia coleção — a mesma decisão, pelo mesmo motivo, tomada lá para a
 * reconciliação e válida aqui: metade dos dados com cara de tudo é pior que
 * nada. Reaproveitá-la mantém UMA implementação de paginação no repositório.
 *
 * A mensagem de recusa dela fala em reconciliação, e isso é um remendo visível:
 * quem ler o erro cru pode procurar no lugar errado. Por isso o `catch` aqui
 * refaz a frase dizendo QUAL coleção parou o backup — que é a informação que
 * falta.
 */
function backupLerTudo_(colecoes, estado) {
  var documentos = {};
  var contagem = {};

  for (var i = 0; i < colecoes.length; i++) {
    var colecao = colecoes[i];

    if (new Date().getTime() - estado.inicio > BACKUP_PRAZO_MS) {
      throw new Error('o tempo acabou antes de ler "' + colecao + '" (' +
        Math.round(BACKUP_PRAZO_MS / 1000) + 's de prazo, ' + estado.documentos +
        ' documentos lidos). Nada foi gravado — um arquivo com as coleções que ' +
        'couberam pareceria completo e não seria.');
    }

    var itens;
    try {
      itens = (colecao === LOG_COLECAO)
        ? backupLerLog_(estado)
        : colecaoCompleta_(colecao);
    } catch (e) {
      throw new Error('a coleção "' + colecao + '" não pôde ser lida inteira: ' + e.message);
    }

    estado.documentos += itens.length;
    if (estado.documentos > BACKUP_TETO_DOCUMENTOS) {
      throw new Error('o banco passou de ' + BACKUP_TETO_DOCUMENTOS + ' documentos ' +
        '(estourou em "' + colecao + '", com ' + estado.documentos + '). Ler tudo ' +
        'passaria a custar quase metade da cota de leitura do dia numa execução só. ' +
        'Nada foi gravado e nada foi apagado; a saída é diminuir o que cresceu (o log ' +
        'costuma ser o culpado) ou subir BACKUP_TETO_DOCUMENTOS sabendo o preço.');
    }

    documentos[colecao] = itens.map(backupDocumento_);
    contagem[colecao] = documentos[colecao].length;
  }

  return { documentos: documentos, contagem: contagem };
}

/**
 * O `log`, dos mais recentes para os mais antigos, até BACKUP_LOG_MAX.
 *
 * Por que ele não passa por `colecaoCompleta_`: é a única coleção que cresce sem
 * relação com o tamanho do CESUTECH, e ler o log inteiro é o jeito garantido de,
 * um dia, o backup passar a falhar TODO DIA — deixando o sistema sem cópia
 * nenhuma justamente porque insistiu em copiar tudo. A troca está feita e é
 * consciente: perde-se a cauda antiga da auditoria, ganha-se um backup que
 * continua existindo.
 *
 * O CORTE NÃO TORNA O BACKUP INCOMPLETO, e a diferença é importante o bastante
 * para estar escrita: `completo: false` significa "faltou coisa que eu queria
 * ter" — falha, prazo, teto — e desqualifica o arquivo. Isto aqui é POLÍTICA
 * declarada: o backup copia os N registros mais recentes do log porque foi
 * decidido assim. O que não se admite é o corte em SILÊNCIO — daí `log_limitado`
 * no cabeçalho, o aviso no resumo, no registro de execução e na trilha.
 *
 * `criado_em` DESC, e não `__name__` DESC, pelo mesmo motivo de `ultimosRegistros`
 * (04_Log.gs): o índice automático de `__name__` só cobre o sentido ascendente, e
 * a consulta descendente por nome é recusada pelo Firestore. `criado_em` é campo
 * de verdade, largura fixa em UTC, e tem índice de campo único de graça.
 */
function backupLerLog_(estado) {
  var itens = [];
  var cursor = null;

  do {
    // A página nunca pede mais do que falta para o teto. Ler 500 para jogar 200
    // fora seria pagar leitura por documento que não entra no arquivo — e é a
    // leitura, não o arquivo, que é a cota escassa aqui.
    var falta = BACKUP_LOG_MAX - itens.length;
    var pagina = listar(LOG_COLECAO, {
      ordenarPor: 'criado_em',
      direcao: 'DESC',
      limite: Math.max(1, Math.min(BACKUP_BLOCO, falta)),
      cursor: cursor
    });
    itens = itens.concat(pagina.itens);
    cursor = pagina.cursor;
  } while (cursor && itens.length < BACKUP_LOG_MAX);

  // `cursor` volta preenchido quando a última página veio CHEIA, ou seja, quando
  // o teto foi alcançado. Não é o mesmo que "sobrou coisa": um log com
  // exatamente BACKUP_LOG_MAX registros também chega aqui. Por isso a frase diz
  // o que se sabe — o teto foi alcançado, e pode haver mais atrás — em vez de
  // afirmar um corte que talvez não tenha acontecido.
  if (cursor) {
    estado.logLimitado = true;
    estado.avisos.push('o log alcançou o teto de ' + BACKUP_LOG_MAX + ' registros: ' +
      'este backup guarda os ' + BACKUP_LOG_MAX + ' mais RECENTES e pode haver mais ' +
      'atrás deles. As demais coleções vieram inteiras.');
  }

  return itens;
}

/**
 * Um documento do Repo vira `{ id, campos }`.
 *
 * `_id` e `_nome` são metadados que `paraObjeto_` (02_Repo.gs) acrescenta na
 * leitura; eles não são campos do documento e não voltam para o banco. O `_id`
 * vira `id` de primeira classe — sem ele, restaurar é adivinhar em qual documento
 * cada objeto morava, e num banco com id determinístico (`alunos`,
 * `inscricoes`) adivinhar errado é criar gente duplicada.
 *
 * Documento sem id derruba o backup INTEIRO em vez de entrar mudo. Se isso
 * acontecer, o defeito está no Repo ou na resposta do Firestore, e é melhor
 * descobrir com um erro hoje do que com um arquivo irrestaurável um ano depois.
 */
function backupDocumento_(item) {
  var id = item && item._id;
  if (!id) {
    throw new Error('veio um documento sem id do banco — sem ele o arquivo não ' +
      'serve para restaurar, e um backup irrestaurável é pior que nenhum');
  }

  var campos = {};
  Object.keys(item).forEach(function (chave) {
    if (chave.charAt(0) === '_') return;
    campos[chave] = item[chave];
  });

  return { id: String(id), campos: campos };
}

/**
 * O cabeçalho mais os documentos.
 *
 * `completo: true` é escrito aqui e só aqui, e o lugar é o argumento: esta função
 * só é chamada depois que `backupLerTudo_` percorreu TODAS as coleções até o fim.
 * Todo caminho que não chega até aqui sai por `catch` e não escreve arquivo
 * nenhum. Ou seja: a marca não é uma promessa, é uma consequência.
 */
function backupMontarArquivo_(colecoes, lido, estado, nome, data) {
  return {
    sistema: 'CESUTECH',
    formato: BACKUP_FORMATO,
    arquivo: nome,
    data: data,
    gerado_em: agora(),
    gerado_por: usuarioAtual(),
    completo: true,
    log_limitado: Boolean(estado.logLimitado),
    log_teto: BACKUP_LOG_MAX,
    contem_dado_pessoal: true,
    colecoes: colecoes,
    contagem: lido.contagem,
    total: estado.documentos,
    avisos: estado.avisos,
    documentos: lido.documentos
  };
}

// ------------------------------------------------------------ A conferência

/**
 * Relê o arquivo do Drive e confere que ele é o que deveria ser.
 *
 * Três perguntas, e as três medem coisas diferentes:
 *
 *   1. O QUE VOLTOU É O QUE FOI? Comparação do texto inteiro. É a pergunta sobre
 *      transporte e armazenamento — envio truncado, gravação parcial, o Drive
 *      guardando outra coisa. Custa uma comparação de string e responde de
 *      forma total: ou é idêntico, ou não é backup.
 *   2. ELE PARSEIA? `JSON.parse` do que VOLTOU, e não do que foi enviado. Quem só
 *      confere o próprio texto em memória prova que sabe serializar, não que
 *      tem arquivo.
 *   3. AS CONTAGENS BATEM? Cabeçalho contra os arrays de verdade, e os dois
 *      contra o que foi lido do banco. Esta é a única das três que pega um erro
 *      NOSSO — um cabeçalho que diz 2.500 sobre um array de 2.499 seria um
 *      arquivo íntegro e mentiroso, e a mentira só apareceria na restauração.
 *
 * Devolve `{ ok, motivo }` em vez de lançar: quem chama precisa mandar o arquivo
 * reprovado para a lixeira ANTES de propagar a falha.
 */
function backupConferir_(id, escrito, contagem, colecoes) {
  var relido;
  try {
    relido = driveLerTexto_(id);
  } catch (e) {
    return { ok: false, motivo: 'não consegui reler o arquivo do Drive: ' + e.message };
  }

  if (relido !== escrito) {
    return {
      ok: false,
      motivo: 'o que voltou do Drive não é o que foi enviado (enviei ' + escrito.length +
        ' caracteres, voltaram ' + String(relido).length + ')'
    };
  }

  var dados;
  try {
    dados = JSON.parse(relido);
  } catch (e) {
    return { ok: false, motivo: 'o arquivo no Drive não é JSON válido: ' + e.message };
  }

  if (dados.completo !== true) {
    return { ok: false, motivo: 'o arquivo não está marcado como completo' };
  }

  var totalConferido = 0;
  for (var i = 0; i < colecoes.length; i++) {
    var colecao = colecoes[i];
    var lista = dados.documentos && dados.documentos[colecao];

    if (!lista || typeof lista.length !== 'number') {
      return { ok: false, motivo: 'a coleção "' + colecao + '" não está no arquivo' };
    }
    if (lista.length !== contagem[colecao]) {
      return {
        ok: false,
        motivo: 'a coleção "' + colecao + '" tem ' + lista.length + ' documentos no ' +
          'arquivo e ' + contagem[colecao] + ' foram lidos do banco'
      };
    }
    if (dados.contagem[colecao] !== contagem[colecao]) {
      return {
        ok: false,
        motivo: 'o cabeçalho diz ' + dados.contagem[colecao] + ' para "' + colecao +
          '" e foram lidos ' + contagem[colecao]
      };
    }

    for (var j = 0; j < lista.length; j++) {
      if (!lista[j] || !lista[j].id) {
        return {
          ok: false,
          motivo: 'há documento sem id em "' + colecao + '" (posição ' + j + ') — ' +
            'sem id não há como restaurar'
        };
      }
    }

    totalConferido += lista.length;
  }

  if (dados.total !== totalConferido) {
    return {
      ok: false,
      motivo: 'o total do cabeçalho (' + dados.total + ') não é a soma das coleções (' +
        totalConferido + ')'
    };
  }

  return { ok: true, motivo: '', total: totalConferido };
}

/**
 * Manda para a lixeira os arquivos DE HOJE que não sejam o que acabou de nascer.
 *
 * Rodar o backup duas vezes no mesmo dia é normal — o gatilho de manhã, e alguém
 * rodando à mão depois de uma importação grande. O Drive aceita dois arquivos com
 * o mesmo nome na mesma pasta sem reclamar, então sem isto a pasta acumularia
 * cópias homônimas e a reciclagem teria de escolher entre elas por critério
 * nenhum.
 *
 * A ORDEM É O CUIDADO: o novo já foi gravado E conferido quando esta função roda.
 * Apagar o velho antes de ter o novo conferido é a troca que deixa o dia sem
 * backup — é a mesma disciplina da quarentena do auditório (13_Auditorio.gs:
 * copia, confere, só então apaga).
 *
 * Duas execuções SIMULTÂNEAS (o gatilho e um humano no mesmo minuto) podem cada
 * uma mandar a da outra para a lixeira e deixar o dia sem arquivo. Não há trava
 * contra isso de propósito: a trava disponível é o `getScriptLock()`, o mesmo por
 * onde passa a inscrição de cada aluno, e segurá-lo por um minuto para copiar o
 * banco pararia a fila do auditório. O prejuízo do caso raro é pequeno e
 * reversível — `driveDescartar_` é LIXEIRA, com 30 dias de arrependimento, e o
 * backup de amanhã acontece de qualquer jeito.
 */
function backupSubstituirDoDia_(data, idNovo) {
  var apagados = 0;

  backupArquivosDaPasta_().forEach(function (a) {
    if (a.data !== data) return;
    if (a.id === idNovo) return;
    driveDescartar_(a.id);
    apagados++;
  });

  return apagados;
}

// ------------------------------------------------------------ A reciclagem

/**
 * Apaga os backups velhos. É a única função deste arquivo que destrói alguma
 * coisa, e por isso é a mais desconfiada.
 *
 * ======================= A TRANCA: SEM BACKUP DE HOJE, NÃO APAGA =============
 *
 * O jeito clássico de um backup se autodestruir: a gravação começa a falhar e a
 * limpeza continua funcionando. Ninguém percebe, porque ambas são silenciosas, e
 * `backup_dias` dias depois o sistema apagou todas as cópias que tinha — a limpeza
 * fez exatamente o que mandaram, sobre um caminho que ninguém estava mais
 * alimentando. Em 15 dias não sobra nada.
 *
 * A defesa não é a ordem das linhas em `fazerBackup` (o `catch` que retorna antes
 * daqui) — ordem de linhas é o tipo de coisa que a próxima refatoração desfaz
 * sem querer. A defesa é o RECIBO: esta função exige um comprovante de que um
 * arquivo com a data de HOJE foi gravado e conferido nesta mesma execução, e o
 * recibo só vira válido depois de `backupConferir_` aprovar. Sem ele, ou com ele
 * de outro dia, não se apaga nada e o motivo é dito.
 *
 * ================================ AS OUTRAS TRÊS =============================
 *
 * REGRA 2 — o mais recente NUNCA é apagado, mesmo que seja mais velho que a
 * janela inteira. Um sistema parado um mês não pode apagar a última cópia que
 * tem só porque o calendário andou.
 *
 * REGRA 3 — só se toca no que nós criamos, e há duas trancas independentes. A
 * primeira é o escopo: com `drive.file` (ver o topo de 02b_Drive.gs) este script
 * não CONSEGUE enxergar arquivo que não tenha criado, então `driveListar_` já
 * devolve só o nosso. A segunda é o nome: `backupDataDoNome_` reconhece o padrão
 * exato, e quem não casa é ignorado — inclusive um arquivo nosso de outro tipo
 * que um dia venha a morar nesta pasta.
 *
 * REGRA 4 — `backup_dias` torto não vira exclusão. Ver `backupDias_`.
 *
 * O que se guarda é a janela dos últimos `backup_dias` dias CONTANDO HOJE: com
 * 15, ficam o de hoje e os 14 anteriores. É o que "guardo 15 dias" significa para
 * quem digitou o número.
 */
function backupReciclar_(recibo) {
  if (!recibo || recibo.ok !== true || !recibo.data) {
    return {
      rodou: false,
      apagados: 0,
      motivo: 'o backup de hoje não ficou pronto (ou não passou na conferência) — ' +
        'apagar os antigos agora seria esvaziar a pasta aos poucos'
    };
  }

  var hoje = backupDataDeHoje_();
  if (recibo.data !== hoje) {
    return {
      rodou: false,
      apagados: 0,
      motivo: 'o recibo é de ' + recibo.data + ' e hoje é ' + hoje
    };
  }

  var regra = backupDias_();
  if (!regra.ok) {
    return { rodou: false, apagados: 0, motivo: regra.motivo };
  }

  var arquivos = backupArquivosDaPasta_();
  if (arquivos.length < 2) {
    return {
      rodou: true,
      apagados: 0,
      motivo: 'só há ' + arquivos.length + ' arquivo(s) na pasta'
    };
  }

  // `backupArquivosDaPasta_` já devolve do mais novo para o mais velho, e a
  // ordem vem do NOME, não do `createdTime` do Drive: o nome é o que nós
  // controlamos. Um arquivo recriado (uma cópia manual, uma restauração de
  // lixeira) teria data de criação de hoje e data antiga no nome — e quem manda
  // é o conteúdo, não o carimbo do Drive.
  var maisRecente = arquivos[0];
  var limite = backupDiaDe_(hoje) - (regra.dias - 1);
  var apagados = 0;
  var apagadosNomes = [];

  arquivos.forEach(function (a) {
    if (a.id === maisRecente.id) return;   // REGRA 2
    if (a.dia >= limite) return;           // dentro da janela
    driveDescartar_(a.id);                 // lixeira, não exclusão definitiva
    apagados++;
    apagadosNomes.push(a.nome);
  });

  return {
    rodou: true,
    apagados: apagados,
    dias: regra.dias,
    preservado: maisRecente.nome,
    nomes: apagadosNomes,
    motivo: ''
  };
}

/**
 * Quantos dias de backup guardar — ou por que não dá para saber.
 *
 * O padrão de `CONFIG_PADRAO` NÃO é aplicado aqui de propósito, e esta é a linha
 * mais importante da função. `config(chave, padrao)` trata chave vazia e chave
 * ausente do mesmo jeito e devolveria 15 — o que é o contrato certo para tudo
 * neste sistema, MENOS para a única operação que apaga. "Não configurado" não
 * pode significar "pode apagar". Quem esvaziou o campo no painel talvez estivesse
 * justamente tentando desligar a limpeza.
 *
 * O resultado de recusar é sempre o lado seguro: os arquivos se acumulam, alguém
 * repara, conserta o valor. O resultado de aceitar palpite seria exclusão, e
 * exclusão não tem lado seguro.
 */
function backupDias_() {
  var bruto = String(config('backup_dias', '')).trim();

  if (bruto === '') {
    return {
      ok: false,
      motivo: 'backup_dias está vazio: não apaguei nada. Preencha o número de dias ' +
        'em Configurações (o padrão de fábrica é 15). Vazio não é interpretado como ' +
        'o padrão aqui, porque apagar por suposição é o que este parâmetro existe ' +
        'para evitar.'
    };
  }

  if (!/^[0-9]+$/.test(bruto)) {
    return {
      ok: false,
      motivo: 'backup_dias tem "' + bruto.slice(0, 40) + '", que não é um número ' +
        'inteiro de dias: não apaguei nada.'
    };
  }

  var dias = Number(bruto);
  if (dias < 1) {
    return {
      ok: false,
      motivo: 'backup_dias é ' + dias + ', e guardar zero dia significaria apagar o ' +
        'backup que acabou de ser feito: não apaguei nada. O mínimo é 1.'
    };
  }

  return { ok: true, dias: dias, motivo: '' };
}

// ------------------------------------------------------------ A pasta

/** O id da pasta dos backups, no padrão de `pastaBanners_` (11_Banners.gs). */
function pastaBackup_() {
  return drivePasta_(BACKUP_PASTA_PROP, BACKUP_PASTA);
}

/**
 * Os backups da pasta, do mais novo para o mais velho, pela data DO NOME.
 *
 * Só entram os que casam com o padrão — é a segunda tranca da regra 3, e ela
 * vale tanto para a reciclagem quanto para a conferência: um arquivo que alguém
 * arrastou para cá não é lido nem apagado.
 *
 * `driveListar_` pagina até 1.000 arquivos e avisa quando trunca. Truncar aqui é
 * inofensivo por acidente feliz: ela ordena por data de criação DESCENDENTE, então
 * o que sobra de fora é sempre o mais velho — a ponta que a reciclagem apagaria.
 * O pior efeito é apagar menos numa execução e o resto na seguinte.
 */
function backupArquivosDaPasta_() {
  var lista = driveListar_(pastaBackup_());
  var nossos = [];

  lista.forEach(function (f) {
    var data = backupDataDoNome_(f && f.name);
    if (!data) return;
    nossos.push({
      id: f.id,
      nome: f.name,
      data: data,
      dia: backupDiaDe_(data),
      kb: Math.round(Number(f.size || 0) / 1024)
    });
  });

  nossos.sort(function (a, b) {
    if (a.dia !== b.dia) return b.dia - a.dia;
    return String(a.id) < String(b.id) ? 1 : -1;
  });

  return nossos;
}

// ------------------------------------------------------------ Nome e data

/** A data de hoje no fuso do sistema — é ela que nomeia o arquivo do dia. */
function backupDataDeHoje_() {
  return Utilities.formatDate(new Date(), APP.timezone, 'yyyy-MM-dd');
}

/** 'cesutech-backup-2026-08-18.json'. Ordenável como texto, de propósito. */
function backupNomeDoDia_(data) {
  return BACKUP_PREFIXO + data + BACKUP_SUFIXO;
}

/**
 * A data dentro do nome, ou '' se o nome não é nosso.
 *
 * Montada a partir das mesmas constantes de `backupNomeDoDia_` para não existir
 * um segundo padrão. O `\.` do sufixo é escapado à mão porque BACKUP_SUFIXO
 * começa com um ponto, que em expressão regular casaria com qualquer caractere —
 * e 'cesutech-backup-2026-08-18Xjson' passaria.
 */
function backupDataDoNome_(nome) {
  var padrao = new RegExp('^' + BACKUP_PREFIXO + '(\\d{4}-\\d{2}-\\d{2})\\' +
    BACKUP_SUFIXO + '$');
  var casou = padrao.exec(String(nome || ''));
  return casou ? casou[1] : '';
}

/**
 * 'AAAA-MM-DD' vira um número de dia, para a idade ser uma subtração.
 *
 * Comparar dias inteiros em UTC, e não instantes, é o que faz a janela não
 * escorregar por causa de hora: dois arquivos do mesmo dia são o mesmo número,
 * seja qual for a hora em que nasceram.
 */
function backupDiaDe_(data) {
  var p = String(data).split('-');
  return Math.floor(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000);
}

/** SIM/NAO. Qualquer coisa que não seja um NAO explícito mantém o backup ligado. */
function backupLigado_() {
  // `!== 'NAO'` e não `=== 'SIM'`, na mesma lógica de `validar_matricula`
  // (09_Projetos.gs): aqui o lado seguro do erro de digitação é CONTINUAR
  // copiando. Um 'S' no lugar de 'SIM' não pode parar o backup em silêncio.
  return String(config('backup_ligado', 'SIM')).toUpperCase() !== 'NAO';
}

// ------------------------------------------------------------ O gatilho

/**
 * Instala (ou reinstala) o gatilho diário do backup. Rode UMA vez, do editor.
 *
 * Idempotente pelo mesmo motivo de `instalarGatilhoDiario` (06_Reconciliacao.gs)
 * e de `instalarGatilhoAquecimento` (08_Api.gs): sem remover o que já existe,
 * rodar duas vezes deixa dois gatilhos, o banco é lido duas vezes por dia (o
 * dobro da cota) e nada disso aparece em lugar nenhum até alguém abrir a tela de
 * acionadores para procurar.
 *
 * Para desligar temporariamente, não mexa no gatilho: ponha `backup_ligado` em
 * NAO no painel. É reversível, fica registrado e não depende de alguém lembrar de
 * reinstalar depois.
 */
function instalarGatilhoBackup() {
  var removidos = 0;

  ScriptApp.getProjectTriggers().forEach(function (g) {
    if (g.getHandlerFunction() === GATILHO_BACKUP) {
      ScriptApp.deleteTrigger(g);
      removidos++;
    }
  });

  ScriptApp.newTrigger(GATILHO_BACKUP)
    .timeBased()
    .atHour(BACKUP_HORA)
    .everyDays(1)
    .create();

  Logger.log('=== instalarGatilhoBackup ===');
  if (removidos) Logger.log('gatilhos antigos removidos: %s', removidos);
  Logger.log('backup diário instalado para rodar entre %sh e %sh.',
    BACKUP_HORA, BACKUP_HORA + 1);
  Logger.log('Depois da reconciliação (5h) e depois da virada da cota do Spark, ' +
    'que é meia-noite do Pacífico.');
  Logger.log('Os arquivos vão para a pasta "%s" no Drive desta conta, e NÃO são ' +
    'compartilhados: contêm dado pessoal de aluno.', BACKUP_PASTA);
  Logger.log('Guarda: %s dias (chave backup_dias, em Configurações).',
    config('backup_dias', '(vazia — nada será reciclado)'));
  Logger.log('Para conferir depois, rode conferirBackup() aqui mesmo no editor.');
}

// ------------------------------------------------------------ A conferência humana

/**
 * Lê o backup mais recente e conta o que ele tem, contra o que o banco tem hoje.
 * NÃO RESTAURA NADA — nem tem como: este arquivo não grava no Firestore.
 *
 * Sem argumento nenhum, e isso é requisito e não estilo: o botão Executar do
 * editor do Apps Script não passa argumentos, e uma função de diagnóstico que só
 * funcione se alguém escrever um embrulho antes é uma função que ninguém roda no
 * dia em que precisa. Mesmo motivo de `liberarMeuAcesso` (07b_LinkPorEmail.gs).
 *
 * COMO LER O RELATÓRIO: as duas colunas quase nunca são iguais, e isso é normal —
 * o arquivo é uma foto de ontem de manhã e o banco é agora. Inscrições e log
 * SEMPRE crescem; `matriculados` e `alunos` só mudam em importação e
 * reconciliação. O que merece susto é o contrário: coleção com muita coisa no
 * banco e pouca (ou zero) no arquivo, ou uma coleção que existe hoje e não está
 * no arquivo — as duas significam backup que não está copiando tudo.
 *
 * Custo: uma listagem do Drive, uma leitura do arquivo, e as contagens do banco
 * em UMA ida (`contarVarios`, 02_Repo.gs — agregação no servidor, sem trazer
 * documento). Não é o backup: é barato e pode ser rodado à vontade.
 */
function conferirBackup() {
  Logger.log('=== conferirBackup ===');

  var arquivos;
  try {
    arquivos = backupArquivosDaPasta_();
  } catch (e) {
    Logger.log('não consegui abrir a pasta de backups: %s', e.message);
    return { ok: false, motivo: e.message };
  }

  if (!arquivos.length) {
    Logger.log('A pasta "%s" não tem nenhum backup.', BACKUP_PASTA);
    Logger.log('Rode fazerBackup() para criar o primeiro, e instalarGatilhoBackup() ' +
      'para não depender de ninguém lembrar.');
    return { ok: false, motivo: 'nenhum backup na pasta' };
  }

  var maisRecente = arquivos[0];
  var dados;
  try {
    dados = JSON.parse(driveLerTexto_(maisRecente.id));
  } catch (e) {
    Logger.log('O arquivo mais recente (%s) não pôde ser lido ou não é JSON: %s',
      maisRecente.nome, e.message);
    Logger.log('Este é o pior resultado possível desta função: existe arquivo e ele ' +
      'não serve. Rode fazerBackup() hoje mesmo.');
    return { ok: false, motivo: 'o arquivo mais recente não é legível: ' + e.message };
  }

  Logger.log('arquivo:   %s (%s KB, %s arquivo(s) na pasta)',
    maisRecente.nome, maisRecente.kb, arquivos.length);
  Logger.log('gerado em: %s por %s', dados.gerado_em, dados.gerado_por);
  Logger.log('completo:  %s | total no arquivo: %s', dados.completo, dados.total);
  if (dados.log_limitado) {
    Logger.log('AVISO: o log veio limitado aos %s registros mais recentes.', dados.log_teto);
  }
  (dados.avisos || []).forEach(function (a) { Logger.log('AVISO: %s', a); });

  // A união do que o arquivo tem com o que existe HOJE: coleção criada depois do
  // backup precisa aparecer na conferência, e ela aparece com "não está no
  // arquivo" — que é exatamente a informação que interessa.
  var noArquivo = dados.colecoes || Object.keys(dados.documentos || {});
  var vistas = {};
  var colecoes = [];
  noArquivo.concat(backupColecoes_()).forEach(function (c) {
    if (vistas[c]) return;
    vistas[c] = true;
    colecoes.push(c);
  });
  colecoes.sort();

  var totais = contarVarios(colecoes.map(function (c) { return { colecao: c }; }));

  var linhas = [];
  var somaArquivo = 0;
  var somaBanco = 0;

  colecoes.forEach(function (colecao, i) {
    var lista = (dados.documentos || {})[colecao];
    var temNoArquivo = lista && typeof lista.length === 'number';
    var noBanco = totais[i];

    linhas.push({
      colecao: colecao,
      arquivo: temNoArquivo ? lista.length : null,
      banco: noBanco,
      ausente: !temNoArquivo
    });

    if (temNoArquivo) somaArquivo += lista.length;
    somaBanco += noBanco;

    Logger.log('  %s: arquivo %s | banco %s%s',
      colecao,
      temNoArquivo ? lista.length : 'AUSENTE',
      noBanco,
      (!temNoArquivo && noBanco > 0) ? '   <-- existe no banco e não está no backup' : '');
  });

  Logger.log('  ----');
  Logger.log('  total: arquivo %s | banco %s', somaArquivo, somaBanco);
  Logger.log('Diferença para mais no banco é o normal (o arquivo é de %s). ' +
    'O que preocupa é o contrário.', dados.data);
  Logger.log('Esta função NÃO restaura nada — o procedimento está no cabeçalho de ' +
    '14_Backup.gs.');

  return {
    ok: true,
    arquivo: maisRecente.nome,
    data: dados.data,
    completo: dados.completo === true,
    log_limitado: Boolean(dados.log_limitado),
    kb: maisRecente.kb,
    arquivos_na_pasta: arquivos.length,
    linhas: linhas,
    total_arquivo: somaArquivo,
    total_banco: somaBanco
  };
}
