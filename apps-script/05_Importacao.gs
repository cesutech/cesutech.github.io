/**
 * 05_Importacao.gs — a lista oficial de matriculados entra por aqui.
 *
 * Fluxo em dois passos, herdado do sistema sobre Sheets e mantido de propósito:
 *   1. `analisarArquivo()`     lê o arquivo, adivinha as colunas e devolve
 *                              pré-visualização — não grava nada;
 *   2. `confirmarImportacao()` grava, só depois de o professor conferir o
 *                              mapeamento na tela.
 *
 * Importar direto, sem conferência, é como o dado errado entra e nunca mais sai.
 *
 * ------------------------------------------- Os dois escopos amplos saíram
 *
 * Até 07/08 o manifesto declarava `/auth/spreadsheets` e `/auth/documents` — ou
 * seja, TODAS as planilhas e TODOS os documentos de quem instala — porque este
 * arquivo abria o XLSX com `SpreadsheetApp.openById` e o OCR do PDF com
 * `DocumentApp.openById`. Eram os dois escopos mais largos do projeto, pedidos
 * para ler UM arquivo que o próprio sistema tinha acabado de criar.
 *
 * Os dois sumiram, e nenhum formato deixou de funcionar:
 *   XLSX  lido dos próprios bytes — `Utilities.unzip` + `XmlService`, que não
 *         exigem escopo nenhum. Ver `extrairDeExcel_` e o bloco de leitura do
 *         .xlsx no fim deste arquivo. De quebra, o passo 1 parou de subir e
 *         converter arquivo no Drive.
 *   PDF   o OCR continua sendo do Drive, e o texto do Documento que ele cria sai
 *         pelo endpoint de export (`driveExportarTexto_`, 02b_Drive.gs), que
 *         aceita `drive.file` — o escopo que só enxerga o que este app criou.
 *   CSV   nunca passou pelo Drive e não mudou.
 *
 * Existe teste que varre todos os `.gs` e falha se `SpreadsheetApp` ou
 * `DocumentApp` reaparecer (testes/consertos.js): uma linha com qualquer um dos
 * dois faz o escopo voltar a ser exigido, e a autorização quebraria longe daqui.
 *
 * ------------------------------------------------------- Custo desta rodada
 *
 *   analisarArquivo ......  0 leituras e 0 escritas no Firestore.
 *                           O arquivo analisado fica no DRIVE entre os dois
 *                           passos (ver `salvarTemporario_`), então o banco nem
 *                           sabe que este passo existe.
 *   confirmarImportacao ..  0 leituras. Escritas: N matriculados + 1 lote + 1
 *                           log, em ceil(N/500) + 2 requisições.
 *   expurgarLote .........  A MAIS CARA: 1 agregação + N leituras + N escritas,
 *                           com N = quantos matriculados sobraram daquele lote e
 *                           teto de EXPURGO_MAX. Com `contarApenas`, 1 leitura.
 *
 * Fora o expurgo — que é ação rara, manual e confirmada —, nenhuma função deste
 * arquivo lê uma coleção. Isso não é economia esperta, é consequência do
 * desenho: com o id do documento sendo a matrícula, gravar a lista oficial é
 * escrever em endereço conhecido, e não procurar o que já existe. É o mesmo
 * motivo pelo qual `matriculaConhecida` custa 1 leitura em vez da lista inteira.
 *
 * Escrita é a cota apertada aqui: 20.000 por dia no plano Spark, contra 50.000
 * leituras. Uma lista de 2.500 alunos consome 12,5% do dia por importação. Daí
 * o teto de `IMPORTACAO_MAX_LINHAS` e a dedup dentro do arquivo — as duas
 * defesas existem para que uma tarde de tentativas não deixe as INSCRIÇÕES sem
 * cota até a meia-noite do Pacífico.
 *
 * Tempo: 3.000 linhas = 6 commits + 2 escritas = 8 idas ao Firestore. Se o custo
 * por chamada do web app anônimo (ver `fsToken_`, 02_Repo.gs) valer também para
 * o `google.script.run` do painel, são ~2 minutos; se o cache de token tiver
 * resolvido, são segundos. Nos dois casos cabe nos 6 minutos por execução, que é
 * o que precisa ser verdade.
 *
 * ------------------------------------ Por que a reconciliação saiu daqui
 *
 * Até 06/08 `confirmarImportacao` chamava `reconciliar()` antes de responder, para
 * o passo 3 já mostrar os quatro números. Parecia atenção com o professor e era
 * uma bomba-relógio: as duas coisas passavam a dividir UMA execução de 6 minutos.
 * A importação de 2.500 linhas emite ~7 idas ao Firestore e a reconciliação
 * emite de 16 a 21 — perto de 23 numa execução só. Estourar aí é o pior modo de
 * falha que este sistema tem, porque não é limpo: os matriculados JÁ foram
 * gravados e o temporário JÁ foi descartado, e mesmo assim a tela recebe "Falha
 * na importação". O professor então reenvia o arquivo — mais 2.500 escritas, num
 * dia que tem 20.000 — e o que quebra em seguida são as INSCRIÇÕES.
 *
 * Ninguém conseguiu cronometrar isso sem o Firestore de verdade, e é justamente
 * por isso que a separação é a escolha certa: ela não depende da medição. Agora
 * cada uma tem os seus 6 minutos, uma falha na reconciliação não pode mais ser
 * lida como falha na importação, e o passo 3 pede o clique que falta.
 *
 * O preço é honesto e está na tela: entre importar e reconciliar, `alunos` está
 * desatualizada. É o mesmo estado em que o banco já ficava quando a reconciliação
 * falhava — só que agora ele é dito em vez de escondido atrás de quatro zeros.
 *
 * ------------------------------------- "Substituir a lista" não apaga mais
 *
 * `substituirTudo(MATRICULADOS, ...)` não existe aqui: o Firestore não apaga
 * coleção. A caixa "substituir" do painel continua chegando no payload, e o que
 * ela passa a significar é UPSERT — reimportar atualiza quem já está lá e
 * acrescenta quem falta; quem sumiu da lista nova PERMANECE.
 *
 * Por que não a alternativa fiel (marcar por `lote_id` e apagar o que ficou de
 * fora): descobrir "o que ficou de fora" é ler a coleção inteira — 2.500
 * leituras — e depois apagar em bloco. É exatamente o padrão de custo que a
 * reconciliação foi proibida de repetir, e pagaríamos esse preço em toda
 * importação para tratar um evento raro (aluno que saiu da lista), que a
 * coordenação resolve à mão em minutos. A resposta e o registro do lote dizem,
 * com todas as letras, que nada foi apagado — o que não pode acontecer é o
 * sistema deixar acreditar que apagou.
 *
 * O que FALTAVA era a saída: aceitar que a importação nunca apaga só é honesto
 * se existir um jeito de apagar de propósito. Ele agora existe e se chama
 * `expurgarLote` — botão na aba Importações, um lote por vez, com o número na
 * confirmação. Sem ele, `matriculados` só crescia até `colecaoCompleta_`
 * (06_Reconciliacao.gs) recusar a reconciliação inteira por passar de 8.000.
 *
 * ---------------------------------------------------------- O contrato duro
 *
 * `matriculados/{matricula normalizada}` — o ID DO DOCUMENTO É A MATRÍCULA,
 * passada por `normalizarMatricula` (04_Inscricoes.gs). Não é detalhe de
 * armazenamento: `matriculaConhecida` faz `ler('matriculados', matricula)`, uma
 * leitura de ponto. Gravar com id sorteado deixaria os testes verdes e faria a
 * validação recusar TODO ALUNO quando `modo_validacao_matricula = BLOQUEAR`.
 *
 * Consequência direta: linha SEM matrícula utilizável não é gravada. O sistema
 * sobre Sheets aceitava linha só com nome, porque lá a chave era o número da
 * linha; aqui ela não teria endereço, entraria com id sorteado, jamais seria
 * encontrada por matrícula e ainda assim contaria em `temListaOficial_()` — ou
 * seja, ligaria a validação sobre uma lista que não valida ninguém. O cabeçalho
 * de 04_Inscricoes.gs pede explicitamente que a importação recuse esse arquivo,
 * e é o que `confirmarImportacao` faz: sem coluna de matrícula mapeada, ou sem
 * nenhuma matrícula utilizável, a importação inteira é recusada.
 */

/** Histórico de importações. A trilha de "quem importou a lista errada". */
var LOTES_COLECAO = 'lotes';

/**
 * Lista oficial de matriculados.
 *
 * Declaração repetida de 04_Inscricoes.gs, pelo mesmo motivo que
 * 09_Projetos.gs repete `INSCRICOES_COLECAO`: o nome não pode depender da ordem
 * de carregamento dos arquivos. Repetido é aceitável; DIVERGENTE não pode ser —
 * o Apps Script não reclama, a última declaração vence em silêncio, e a
 * importação passaria a encher uma coleção que ninguém consulta. Existe teste
 * que lê os dois arquivos e falha se os valores deixarem de ser iguais.
 */
var MATRICULADOS_COLECAO = 'matriculados';

/** Onde o arquivo analisado espera entre o passo 1 e o passo 2. */
var PASTA_TEMP = 'CESUTECH — temporários';

/**
 * Tamanho do bloco de escrita.
 *
 * É o mesmo 500 de `escreverEmLote` (02_Repo.gs) — limite da API, não escolha
 * nossa. O bloco é repartido AQUI, e não delegado, porque a pergunta que
 * importa quando o terceiro commit falha é "quantos entraram?", e essa resposta
 * só existe para quem contou os blocos. Ver `gravarMatriculados_`.
 */
var IMPORTACAO_BLOCO = 500;

/**
 * Teto de linhas por importação.
 *
 * 5.000 é o dobro da lista real do CESUTECH (~2.500) e um quarto da cota diária
 * de escrita. Um arquivo maior que isso é engano — export errado, planilha com
 * o histórico inteiro — e o jeito de descobrir não pode ser gastar a cota do dia
 * para depois ler o erro.
 */
var IMPORTACAO_MAX_LINHAS = 5000;

/**
 * Faixa de matrícula aceita, igual à de `validarInscricao` (04_Inscricoes.gs).
 *
 * Tem de ser a MESMA régua nas duas pontas: matrícula que o aluno não consegue
 * digitar sem levar "Matrícula inválida" não tem por que ocupar documento na
 * lista oficial — ela nunca seria consultada.
 */
var MATRICULA_MIN = 4;
var MATRICULA_MAX = 20;

/** Quantas linhas a pré-visualização mostra. Oito cabem na tela sem rolagem. */
var IMPORTACAO_AMOSTRA = 8;

/** Quanto do texto cru da extração vai para o temporário — ver `salvarTemporario_`. */
var TEXTO_BRUTO_GUARDADO = 12000;

/**
 * Campos que o mapeamento pode preencher.
 *
 * Lista fechada, e não "toda chave que chegar": o payload vem do cliente, e
 * `lote_id`, `importado_em`, `importado_por` e `raw_json` são a trilha da
 * importação. Uma coluna da planilha mapeada para um deles sobrescreveria o
 * registro de quem importou com o que estivesse na célula — trilha adulterada
 * pelo próprio arquivo que ela deveria testemunhar.
 *
 * São os mesmos oito de CAMPOS_IMPORTACAO (Admin.html:263), mais `telefone`,
 * que o leitor do relatório acadêmico extrai (05b_FormatoAcademico.gs) e que a
 * tela ainda não oferece.
 */
var IMPORTACAO_CAMPOS = ['nome', 'cpf', 'email', 'matricula', 'telefone',
  'data_nascimento', 'curso', 'turma', 'situacao'];

// ------------------------------------------------------------ Passo 1

/**
 * Recebe o arquivo em base64, extrai a matriz de células e devolve cabeçalhos,
 * amostra e mapeamento sugerido.
 *
 * O arquivo chega inteiro no payload (Admin.html:1150 corta em 5 MB antes de
 * enviar) e NÃO fica no banco: o que sobrevive até o passo 2 é um JSON no Drive.
 */
function analisarArquivo(payload) {
  try {
    payload = payload || {};
    exigirAdmin(payload.token);

    if (!payload.dataBase64) return { ok: false, erro: 'Nenhum arquivo recebido.' };

    var nome = String(payload.filename || 'arquivo');
    var bytes = Utilities.base64Decode(payload.dataBase64);
    var blob = Utilities.newBlob(bytes, payload.mimeType || 'application/octet-stream', nome);

    var extensao = (nome.split('.').pop() || '').toLowerCase();
    var extraido;

    if (extensao === 'csv' || extensao === 'txt') extraido = extrairDeCsv_(blob);
    else if (extensao === 'xlsx' || extensao === 'xls') extraido = extrairDeExcel_(blob, nome);
    else if (extensao === 'pdf') extraido = extrairDePdf_(blob, nome);
    else return { ok: false, erro: 'Formato não suportado: .' + extensao + '. Use CSV, XLSX ou PDF.' };

    // O relatório do sistema acadêmico traz nome e matrícula no mesmo campo e
    // (no CSV) repete o cabeçalho em toda linha. Se for ele, o leitor dedicado
    // devolve matriz limpa; se não for, segue o caminho genérico.
    var academico = tentarFormatoAcademico_({ texto: extraido.texto, matriz: extraido.matriz });
    if (academico) {
      extraido.matriz = academico.matriz;
      extraido.aviso = academico.aviso + (extraido.aviso ? ' ' + extraido.aviso : '');
      extraido.tipo = extraido.tipo + ' (formato acadêmico)';
    }

    var matriz = extraido.matriz;
    if (!matriz || matriz.length < 2) {
      return { ok: false, erro: 'O arquivo não tem linhas de dados (só cabeçalho, ou vazio).' };
    }

    var cabecalhos = matriz[0].map(function (c) { return String(c).trim(); });
    var linhas = matriz.slice(1).filter(function (l) {
      return l.some(function (c) { return String(c).trim() !== ''; });
    });

    // O teto é conferido AQUI, antes de qualquer gravação e antes até do
    // arquivo temporário: o passo 1 é onde a recusa é barata.
    if (linhas.length > IMPORTACAO_MAX_LINHAS) {
      return {
        ok: false,
        erro: 'O arquivo tem ' + linhas.length + ' linhas e o teto por importação é ' +
              IMPORTACAO_MAX_LINHAS + '. Cada linha é uma escrita no banco, e o plano ' +
              'gratuito aceita 20.000 por dia — estourar isso pararia as inscrições até ' +
              'o dia seguinte. Divida o arquivo e importe em partes.'
      };
    }

    var tempId = salvarTemporario_(nome, {
      cabecalhos: cabecalhos,
      linhas: linhas,
      // O TEXTO CRU DA EXTRAÇÃO, guardado só para o diagnóstico poder olhá-lo.
      //
      // Em 25/08 o OCR do Drive devolveu, de um PDF com 39 alunos, um texto em
      // que o leitor achou UM. O sistema montou a ficha com o nome do aluno
      // encontrado e o telefone da ÚLTIMA linha do arquivo — sinal de que o
      // texto veio achatado num bloco só. E não havia como olhar: o Documento
      // do OCR é descartado no `finally` de `extrairDePdf_`, e o temporário só
      // guardava o resultado JÁ extraído. A evidência morria no meio do caminho.
      //
      // O corte existe porque isto viaja para o Drive a cada análise e o
      // diagnóstico só precisa do começo para reconhecer a forma do texto.
      texto_bruto: String(extraido.texto || '').slice(0, TEXTO_BRUTO_GUARDADO)
    });

    return {
      ok: true,
      tempId: tempId,
      tipo: extraido.tipo,
      arquivo: nome,
      cabecalhos: cabecalhos,
      amostra: amostraDe_(linhas, cabecalhos.length),
      totalLinhas: linhas.length,
      mapeamento: sugerirMapeamento_(cabecalhos),
      aviso: extraido.aviso || ''
    };
  } catch (err) {
    console.error('analisarArquivo: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * As primeiras linhas, completadas até a largura do cabeçalho.
 *
 * A tela percorre os cabeçalhos e imprime `linha[i]` (Admin.html:1215); linha
 * curta — comum em PDF, onde a coluna de telefone falta — imprimiria a palavra
 * "undefined" na pré-visualização, que é justamente a tela onde o professor
 * decide se confia no arquivo.
 */
function amostraDe_(linhas, largura) {
  return linhas.slice(0, IMPORTACAO_AMOSTRA).map(function (linha) {
    var completa = linha.slice(0, largura);
    while (completa.length < largura) completa.push('');
    return completa;
  });
}

// ------------------------------------------------------------ Passo 2

/**
 * Grava a lista com o mapeamento confirmado, registra o lote e devolve o
 * resumo da reconciliação.
 *
 * Custo: 0 leituras; ceil(N/500) commits + 1 lote + 1 log.
 */
function confirmarImportacao(payload) {
  try {
    payload = payload || {};
    exigirAdmin(payload.token);

    var temp = lerTemporario_(payload.tempId);
    if (!temp) return { ok: false, erro: 'A pré-visualização expirou. Envie o arquivo novamente.' };

    var mapeamento = payload.mapeamento || {};
    var recusa = recusarMapeamento_(mapeamento);
    if (recusa) return { ok: false, erro: recusa };

    var loteId = loteId_();
    var quando = agora();
    var quem = usuarioAtual();

    var preparo = prepararRegistros_(temp.linhas, mapeamento, {
      loteId: loteId, quando: quando, quem: quem
    });

    if (!preparo.registros.length) {
      return {
        ok: false,
        erro: 'Nenhuma linha utilizável. ' + descreverDescartes_(preparo) +
              ' Confira se as colunas de nome e matrícula foram mapeadas corretamente.'
      };
    }

    var escrita = gravarMatriculados_(preparo.registros);

    // O lote é registrado nos DOIS caminhos, e antes de devolver qualquer coisa:
    // uma importação que morreu no meio é justamente a que alguém vai querer
    // reconstituir depois. Sem isso, o rastro do commit parcial seria o silêncio.
    registrarLote_({
      loteId: loteId,
      arquivo: temp.arquivo || payload.arquivo || '',
      tipo: payload.tipo || '',
      quando: quando,
      quem: quem,
      mapeamento: mapeamento,
      gravados: escrita.gravados,
      previstos: preparo.registros.length,
      substituirPedido: !!payload.substituir,
      falhou: !!escrita.falha
    });

    if (escrita.falha) {
      // O temporário SOBREVIVE de propósito: reenviar o mesmo arquivo é o
      // caminho de retomada, e ele é seguro porque a gravação é upsert por
      // matrícula — as linhas que já entraram apenas se reescrevem iguais.
      registrar('IMPORTACAO_PARCIAL', 'lote', loteId,
        escrita.gravados + ' de ' + preparo.registros.length + ' gravados; ' + escrita.falha.message);

      return {
        ok: false,
        loteId: loteId,
        importadas: escrita.gravados,
        previstas: preparo.registros.length,
        erro: 'A gravação parou no meio: ' + escrita.gravados + ' de ' +
              preparo.registros.length + ' matriculados entraram. Confirme a importação de ' +
              'novo com o mesmo arquivo — quem já entrou não é duplicado, porque a chave é a ' +
              'matrícula. Detalhe técnico: ' + escrita.falha.message
      };
    }

    registrar('IMPORTACAO', 'lote', loteId,
      escrita.gravados + ' matriculados de "' + (temp.arquivo || '') + '"; ' +
      descreverDescartes_(preparo));

    descartarTemporario_(payload.tempId);

    return {
      ok: true,
      loteId: loteId,
      importadas: escrita.gravados,
      // O painel escreve "ignorada(s) por não terem nome" (Admin.html:1267), e
      // esse número precisa ser exatamente esse — as outras razões de descarte
      // vão no `aviso`, no lote e no log, para a frase da tela não mentir.
      ignoradas: preparo.semNome,
      semMatricula: preparo.semMatricula,
      repetidas: preparo.repetidas,
      substituiu: false,
      aviso: avisoDaImportacao_(preparo, !!payload.substituir),
      // A importação NÃO reconcilia mais. Ver o bloco "Por que a reconciliação
      // saiu daqui", no cabeçalho. Quem faz a tela pedir o passo seguinte é esta
      // chave: o painel desenha o botão "Reconciliar agora" quando ela vem true.
      precisaReconciliar: true
    };
  } catch (err) {
    console.error('confirmarImportacao: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * Mapeamento inaceitável devolve a frase da recusa; '' quando está bom.
 *
 * Nome é obrigatório desde o sistema sobre Sheets. Matrícula passou a ser, e é a
 * regra nova mais importante deste arquivo: ela é o ENDEREÇO do documento. Sem
 * ela não há o que gravar — e pior, uma lista sem matrícula ainda assim faria
 * `temListaOficial_()` responder SIM e ligaria o bloqueio para todo mundo.
 */
function recusarMapeamento_(mapeamento) {
  if (!colunaMapeada_(mapeamento, 'nome')) {
    return 'É obrigatório mapear a coluna "Nome completo".';
  }
  if (!colunaMapeada_(mapeamento, 'matricula')) {
    return 'É obrigatório mapear a coluna "Matrícula": ela é a chave de cada aluno na ' +
           'lista oficial. Sem ela, a conferência de matrícula do formulário passaria a ' +
           'recusar todos os alunos.';
  }
  return '';
}

function colunaMapeada_(mapeamento, campo) {
  var idx = mapeamento[campo];
  return idx !== undefined && idx !== null && Number(idx) >= 0;
}

/**
 * Linhas do arquivo -> documentos de `matriculados`, já deduplicados.
 *
 * A dedup por matrícula dentro do MESMO arquivo não é economia: um `:commit`
 * com duas escritas no mesmo documento é recusado inteiro pelo Firestore. O
 * relatório acadêmico repete aluno que cursa duas disciplinas, então isto
 * acontece no arquivo real, não no hipotético. Vence a ÚLTIMA ocorrência —
 * escolha arbitrária entre duas linhas igualmente válidas, e assumida aqui para
 * o resultado não depender da ordem em que o laço roda.
 */
function prepararRegistros_(linhas, mapeamento, contexto) {
  var porMatricula = {};
  var ordem = [];
  var semNome = 0;
  var semMatricula = 0;
  var repetidas = 0;

  (linhas || []).forEach(function (linha) {
    var reg = montarRegistro_(linha, mapeamento, contexto);

    // Sem nome não há como reconciliar — a linha não serve para nada.
    if (!reg.nome) { semNome++; return; }
    if (!reg.matricula) { semMatricula++; return; }

    if (porMatricula[reg.matricula] === undefined) ordem.push(reg.matricula);
    else repetidas++;
    porMatricula[reg.matricula] = reg;
  });

  return {
    registros: ordem.map(function (m) { return porMatricula[m]; }),
    semNome: semNome,
    semMatricula: semMatricula,
    repetidas: repetidas
  };
}

/**
 * Uma linha do arquivo vira um documento.
 *
 * `_id` é a matrícula normalizada — é o campo que `escreverEmLote` usa como nome
 * do documento (02_Repo.gs), e é o contrato inteiro deste arquivo.
 *
 * A matrícula é gravada também como CAMPO, apesar de ser cópia do id. Em
 * `projetos` e `inscricoes` a cópia foi recusada justamente por poder divergir;
 * aqui ela entra porque a reconciliação precisa do valor sem depender de
 * conhecer o formato do id, e porque as duas gravações saem da MESMA expressão
 * normalizada, na mesma linha — não há caminho por onde divergir.
 */
function montarRegistro_(linha, mapeamento, contexto) {
  var reg = {
    lote_id: contexto.loteId,
    importado_em: contexto.quando,
    importado_por: contexto.quem,
    nome: '', cpf: '', email: '', matricula: '', telefone: '',
    data_nascimento: '', curso: '', turma: '', situacao: '',
    raw_json: JSON.stringify(linha)
  };

  IMPORTACAO_CAMPOS.forEach(function (campo) {
    var idx = mapeamento[campo];
    if (idx === null || idx === undefined || idx < 0) return;
    reg[campo] = linha[idx];
  });

  reg.nome = formatarNome(reg.nome);
  reg.cpf = normalizarCpf(reg.cpf);
  reg.email = normalizarEmail(reg.email);
  // A forma OFICIAL, como veio do relatório, fica guardada para exibição: é o
  // número que o aluno vê no documento dele, com o zero à esquerda. A chave é a
  // normalizada, que ignora o zero — ver `normalizarMatricula` em
  // 04_Inscricoes.gs. Guardar só a chave faria o painel mostrar um número
  // diferente do que a secretaria emitiu.
  reg.matricula_oficial = String(reg.matricula || '').trim();
  reg.matricula = matriculaUtilizavel_(reg.matricula);
  if (reg.matricula_oficial === reg.matricula) reg.matricula_oficial = '';
  reg.telefone = normalizarTelefone(reg.telefone);
  reg.data_nascimento = normalizarData(reg.data_nascimento);
  // TURMA É CHAVE DE COMPARAÇÃO, e por isso não basta aparar espaço.
  //
  // O cruzamento "quem da turma ainda não se inscreveu" (`matriculadosDaDisciplina`,
  // 12_Disciplinas.gs) casa `matriculados.turma` com a turma da disciplina por
  // filtro de igualdade do Firestore — que não sabe comparar ignorando a caixa, e
  // ler a coleção inteira para filtrar em JavaScript comeria a cota de leitura de
  // que o formulário do aluno depende. O cadastro de disciplinas já subia para
  // caixa alta; aqui não subia. Uma planilha da secretaria com 'Ads11' fazia a
  // tela responder ZERO sobre uma turma cheia, e zero ali se lê como "ninguém
  // falta se inscrever".
  //
  // A normalização é da ESCRITA porque é o único lugar em que ela cabe: é uma
  // linha, acontece uma vez por aluno importado, e mantém a consulta sendo uma
  // igualdade simples no índice automático de campo único.
  //
  // `curso` NÃO sobe para caixa alta — ver `normalizarNomeDeCurso` (01_Utils.gs):
  // é nome próprio lido por gente, e nenhuma consulta o casa contra outro
  // cadastro. Dele só se colapsa espaço repetido, que é o que faria o mesmo curso
  // virar duas linhas no histograma de "Alunos por curso".
  reg.curso = normalizarNomeDeCurso(reg.curso);
  reg.turma = normalizarTurma(reg.turma);
  reg.situacao = String(reg.situacao || '').trim();

  reg._id = reg.matricula;
  return reg;
}

/**
 * A matrícula normalizada, ou '' quando ela não serve de chave.
 *
 * A faixa é a mesma que `validarInscricao` exige do aluno: matrícula de três
 * dígitos na lista oficial nunca seria consultada, porque o formulário recusa o
 * aluno antes de perguntar ao banco.
 */
function matriculaUtilizavel_(bruta) {
  var m = normalizarMatricula(bruta);
  if (m.length < MATRICULA_MIN || m.length > MATRICULA_MAX) return '';
  return m;
}

/**
 * Grava em blocos e devolve QUANTOS entraram.
 *
 * É aqui que a diferença com o sistema sobre Sheets fica exposta. Lá,
 * `setValues` cai inteiro ou não cai, e por isso não existe caminho de
 * compensação. Aqui são ceil(N/500) requisições independentes, e a quarta pode
 * falhar depois de três terem gravado — 1.500 alunos dentro, 1.500 fora, e
 * nenhum jeito de desfazer os que entraram sem gastar mais cota do que a
 * importação inteira custou.
 *
 * A escolha é relatar, não fingir e não desfazer: o número real de gravados sobe
 * para a tela e para o lote, e a retomada é reenviar o mesmo arquivo — seguro
 * porque cada documento é endereçado pela matrícula, então reescrever é escrever
 * o mesmo.
 */
function gravarMatriculados_(registros) {
  var gravados = 0;

  for (var inicio = 0; inicio < registros.length; inicio += IMPORTACAO_BLOCO) {
    var bloco = registros.slice(inicio, inicio + IMPORTACAO_BLOCO);
    try {
      gravados += escreverEmLote(MATRICULADOS_COLECAO, bloco);
    } catch (e) {
      return { gravados: gravados, falha: e };
    }
  }

  return { gravados: gravados, falha: null };
}

// ------------------------------------------------------------ Lote

/**
 * O registro da importação.
 *
 * `status` é o que a aba "Importações" mostra (Admin.html:1329), então ele
 * precisa contar a verdade em uma palavra. 'SUBSTITUIU' não é uma delas: nada
 * foi apagado. O que foi PEDIDO fica em `substituir_pedido`, separado do que foi
 * FEITO — é a diferença que alguém vai querer conferir no dia em que uma
 * matrícula antiga aparecer numa lista que deveria ter sido substituída.
 */
function registrarLote_(dados) {
  try {
    inserir(LOTES_COLECAO, {
      // `criado_em` é UTC de largura fixa, como no log: quem for listar lotes
      // ordena por ele, e nunca por `__name__` DESCENDING — que exigiria índice
      // (ver `ultimosRegistros`, 04_Log.gs). Sai do próprio id, e não de um
      // segundo relógio, para os dois contarem a mesma hora por construção.
      criado_em: String(dados.loteId).split('_')[0],
      arquivo: dados.arquivo,
      tipo: dados.tipo,
      linhas: String(dados.gravados),
      previstas: String(dados.previstos),
      importado_em: dados.quando,
      importado_por: dados.quem,
      mapeamento_json: JSON.stringify(dados.mapeamento),
      substituir_pedido: dados.substituirPedido ? 'SIM' : 'NAO',
      status: dados.falhou ? 'PARCIAL' : 'ATUALIZOU'
    }, dados.loteId);
  } catch (e) {
    // Mesma regra do log: a trilha não pode derrubar quem a chamou. A
    // importação já gravou os alunos; perder o registro do lote é ruim, virar
    // erro na tela depois de os dados entrarem é pior.
    console.error('registrarLote_: ' + e.message);
  }
}

// ------------------------------------------------------------ Expurgo

/**
 * Quantos matriculados um expurgo pode apagar de uma vez.
 *
 * O mesmo 5.000 de `IMPORTACAO_MAX_LINHAS`, e pelo mesmo motivo: um pedido maior
 * que isso não é limpeza de semestre, é engano — e descobrir o engano não pode
 * ser gastar 8.000 leituras e 8.000 escritas antes de ler a mensagem.
 */
var EXPURGO_MAX = 5000;

/**
 * Apaga os matriculados de UMA importação. É a saída de emergência que faltava.
 *
 * O problema que ela resolve: `matriculados` só crescia. A caixa "substituir" do
 * passo 2 sempre foi upsert (ver o cabeçalho), `excluir` nunca era chamada nesta
 * coleção, e não havia botão, função nem caminho para reduzi-la. Como
 * `colecaoCompleta_` (06_Reconciliacao.gs) recusa acima de 8.000 documentos por
 * coleção, no quarto semestre a reconciliação pararia de rodar — e a mensagem de
 * recusa mandava "reduza a coleção" sem existir com o quê.
 *
 * Por que POR LOTE, e por que isso é seguro: a gravação é upsert com a matrícula
 * de id, então quem foi reimportado no semestre seguinte teve o `lote_id`
 * SOBRESCRITO pelo novo. Apagar o lote velho atinge, por construção, exatamente
 * quem não voltou na lista nova. É a semântica que o professor espera de
 * "substituir", com o expurgo separado da importação — e separado de propósito,
 * porque apagar 2.500 documentos no meio de uma importação é o tipo de coisa que
 * ninguém quer descobrir que aconteceu.
 *
 * Custo, e é a função mais cara deste arquivo:
 *   `contarApenas`  1 leitura (agregação). É o que a tela pergunta ANTES de
 *                   pedir confirmação, para o professor ver o número real.
 *   expurgo         1 agregação + N leituras (blocos de 500) + N escritas
 *                   (blocos de 500), mais 1 patch no lote e 1 log.
 *
 * A consulta filtra por `lote_id` e não declara ordenação: `listar` cai em
 * `__name__` ASCENDENTE, que todo índice automático de campo único já cobre.
 * Filtrar por um campo e ordenar por outro pediria índice composto.
 */
function expurgarLote(payload) {
  try {
    payload = payload || {};
    exigirAdmin(payload.token);

    var loteId = String(payload.loteId || '').trim();
    if (!loteId) return { ok: false, erro: 'Informe qual importação deve ser apagada.' };

    // Contar primeiro é o que separa esta função de uma armadilha: a agregação
    // custa 1 leitura e responde "quanto isto vai custar e quanto vai sumir"
    // sem trazer um documento. A tela pergunta com `contarApenas` e só então
    // pede confirmação, com o número na frase.
    var total = contar(MATRICULADOS_COLECAO, { campo: 'lote_id', valor: loteId });

    if (payload.contarApenas) return { ok: true, total: total, apagados: 0 };

    if (!total) {
      return {
        ok: true,
        apagados: 0,
        mensagem: 'Nenhum matriculado desta importação continua no banco. Ou ela já foi ' +
                  'expurgada, ou todo mundo dela voltou numa importação mais nova — nesse ' +
                  'caso os registros pertencem ao lote mais recente e não devem sair.'
      };
    }

    // Guarda de cinto e suspensório: como a importação já recusa arquivo acima de
    // IMPORTACAO_MAX_LINHAS, nenhum lote deveria chegar aqui com mais que isso.
    // Se chegar, alguma suposição deste arquivo deixou de valer, e a hora de
    // descobrir isso não é depois de 8.000 exclusões.
    if (total > EXPURGO_MAX) {
      return {
        ok: false,
        erro: 'Esta importação tem ' + total + ' matriculados, acima do teto de ' + EXPURGO_MAX +
              ' por expurgo — mais do que uma importação consegue gravar de uma vez. Não apaguei ' +
              'nada. Confira o lote na aba Importações antes de insistir.'
      };
    }

    var ids = [];
    var cursor = null;
    do {
      var pagina = listar(MATRICULADOS_COLECAO, {
        campo: 'lote_id', valor: loteId, limite: IMPORTACAO_BLOCO, cursor: cursor
      });
      pagina.itens.forEach(function (m) { if (m._id) ids.push(m._id); });
      cursor = pagina.cursor;
    } while (cursor && ids.length < EXPURGO_MAX);

    var apagados = excluirEmLote(MATRICULADOS_COLECAO, ids);

    // O lote não some junto: ele é a trilha de "quem importou o quê", e apagar a
    // trilha do expurgo seria apagar a resposta da única pergunta que alguém vai
    // fazer depois. Ele muda de estado.
    try {
      atualizar(LOTES_COLECAO, loteId, {
        status: 'EXPURGADO',
        expurgado_em: agora(),
        expurgado_por: usuarioAtual()
      });
    } catch (e) {
      console.error('expurgarLote (marca do lote): ' + e.message);
    }

    registrar('LOTE_EXPURGADO', 'lote', loteId, apagados + ' matriculado(s) apagado(s)');

    return {
      ok: true,
      apagados: apagados,
      mensagem: apagados + ' matriculado(s) desta importação foram apagados. Quem voltou numa ' +
                'lista mais nova NÃO foi tocado. Rode a reconciliação para os números da aba ' +
                'Alunos acompanharem.'
    };
  } catch (err) {
    console.error('expurgarLote: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * Id do lote, cronologicamente ordenável: '20260806T131002123Z_a1b2c3'.
 *
 * Mesma forma do id do log (04_Log.gs), e pelo mesmo motivo: id e ordem contam a
 * mesma hora. O sufixo aleatório existe porque milissegundo não é chave, e
 * colisão aqui não é lote duplicado — é lote PERDIDO, já que `inserir` recusa id
 * ocupado.
 */
function loteId_() {
  return logId_();
}

// ------------------------------------------------------------ Relato

/** Frase única com o que foi descartado, para o log e para as mensagens. */
function descreverDescartes_(preparo) {
  return preparo.semNome + ' sem nome, ' +
         preparo.semMatricula + ' sem matrícula utilizável, ' +
         preparo.repetidas + ' repetida(s) no arquivo.';
}

/**
 * O aviso que o professor precisa ler, ou ''.
 *
 * Existe porque a caixa "substituir" do painel promete apagar a lista anterior e
 * este arquivo não apaga. Enquanto o texto da caixa não mudar, dizer isso na
 * resposta é o mínimo — e o mesmo campo carrega os descartes que a frase fixa da
 * tela não menciona.
 */
function avisoDaImportacao_(preparo, substituirPedido) {
  var partes = [];

  if (substituirPedido) {
    partes.push('A opção "substituir" atualizou a lista, mas NÃO apagou nada: ' +
      'matrícula que existia antes e não veio neste arquivo continua na lista oficial. ' +
      'Para tirar alguém, peça a remoção manual à coordenação.');
  }
  if (preparo.semMatricula) {
    partes.push(preparo.semMatricula + ' linha(s) foram ignoradas por não terem matrícula ' +
      'utilizável (a matrícula é a chave de cada aluno).');
  }
  if (preparo.repetidas) {
    partes.push(preparo.repetidas + ' linha(s) repetiam uma matrícula já lida e valeu a última.');
  }

  return partes.join(' ');
}

// ------------------------------------------------------------ Extratores

/** CSV — detecta se o separador é vírgula ou ponto e vírgula (Excel pt-BR usa ";"). */
function extrairDeCsv_(blob) {
  var texto = blob.getDataAsString('UTF-8');

  // Heurística: conta os separadores na primeira linha não vazia.
  var primeira = texto.split(/\r?\n/).filter(function (l) { return l.trim(); })[0] || '';
  var virgulas = (primeira.match(/,/g) || []).length;
  var pontosVirgula = (primeira.match(/;/g) || []).length;
  var sep = pontosVirgula > virgulas ? ';' : ',';

  return { matriz: Utilities.parseCsv(texto, sep), tipo: 'CSV', aviso: '' };
}

/**
 * XLSX — lido dos BYTES do arquivo, sem passar pelo Drive e sem SpreadsheetApp.
 *
 * ESCOPO, e é a razão de este comentário existir. Até 07/08 este caminho
 * convertia o arquivo para Google Sheets e o abria com `SpreadsheetApp.openById`.
 * `SpreadsheetApp` é serviço "fácil" do Apps Script e, como o `DriveApp` (ver
 * 02b_Drive.gs), a plataforma o amarra a um escopo próprio —
 * `/auth/spreadsheets`, que dá acesso a TODAS as planilhas de quem instala. Era o
 * escopo mais largo do projeto, pedido para ler UM arquivo que o próprio sistema
 * acabou de criar.
 *
 * Um .xlsx é um ZIP de XML, e ler ZIP e XML não exige escopo nenhum: são bytes
 * que já estão na mão. `Utilities.unzip` abre, `XmlService.parse` lê. Some o
 * escopo, some a ida ao Drive (upload + conversão + descarte, que eram três
 * chamadas de rede) e some a espera da conversão.
 *
 * O que este leitor NÃO faz, e o antigo fazia: fórmula não é recalculada — vale o
 * último valor que o Excel gravou no arquivo, que é o que a tela mostrava mesmo.
 */
function extrairDeExcel_(blob, nome) {
  var partes = partesDoXlsx_(blob, nome);
  var textos = lerSharedStrings_(partes['xl/sharedStrings.xml']);
  var estilos = lerEstilosDeData_(partes['xl/styles.xml']);
  var aba = primeiraAba_(partes);

  var matriz = lerPlanilha_(partes[aba.caminho], textos, estilos);

  return {
    matriz: matriz,
    tipo: 'XLSX',
    aviso: aba.total > 1
      ? 'O arquivo tem ' + aba.total + ' abas; li apenas a primeira ("' + aba.nome + '").'
      : ''
  };
}

/**
 * PDF — OCR pelo Drive e tentativa de reconstruir a tabela.
 * É assistente, não automação: o resultado sempre passa pela tela de revisão.
 *
 * ESCOPO: o texto do Documento que o OCR cria era lido com
 * `DocumentApp.openById`, que exige `/auth/documents` — TODOS os documentos de
 * quem instala. Como o arquivo é criado por NÓS, `drive.file` já o alcança, e o
 * endpoint de export do Drive entrega o mesmo texto (`driveExportarTexto_`,
 * 02b_Drive.gs). O escopo amplo saiu do manifesto.
 *
 * Continua o caminho mais frágil dos três: o OCR decide sozinho onde estão as
 * colunas. O que existe de teste aqui é o encadeamento (cria com OCR, exporta,
 * descarta) — a qualidade do OCR em si não dá para provar sem PDF de verdade.
 */
function extrairDePdf_(blob, nome) {
  var doc;
  try {
    doc = Drive.Files.create(
      { name: '[temp] ' + nome, mimeType: MimeType.GOOGLE_DOCS },
      blob,
      { ocrLanguage: 'pt', supportsAllDrives: true }
    );
  } catch (e) {
    throw new Error(
      'Não consegui aplicar OCR no PDF. Ative o serviço avançado do Drive ' +
      '(Serviços > + > Drive API v3). Detalhe: ' + e.message
    );
  }

  try {
    var texto = driveExportarTexto_(doc.id);
    var linhas = texto.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!linhas.length) throw new Error('O OCR não extraiu texto deste PDF.');

    // Separador provável: tabulação, ou 2+ espaços (colunas alinhadas).
    var usaTab = linhas[0].indexOf('\t') !== -1;
    var matriz = linhas.map(function (l) {
      return (usaTab ? l.split('\t') : l.split(/\s{2,}/))
        .map(function (c) { return c.trim(); });
    });

    // Normaliza a largura pela linha mais larga.
    var largura = matriz.reduce(function (m, l) { return Math.max(m, l.length); }, 0);
    matriz = matriz.map(function (l) {
      while (l.length < largura) l.push('');
      return l;
    });

    return {
      matriz: matriz,
      texto: texto,
      tipo: 'PDF',
      aviso: 'PDF lido como texto. Confira a pré-visualização antes de confirmar.'
    };
  } finally {
    try { driveDescartar_(doc.id); } catch (e) { /* limpeza best-effort */ }
  }
}

// ------------------------------------------------- Leitura do .xlsx por dentro
//
// Um .xlsx é um ZIP com um punhado de XML dentro. O que interessa a este arquivo:
//
//   xl/workbook.xml              a lista de abas, em ordem de aba
//   xl/_rels/workbook.xml.rels   diz qual XML é cada aba
//   xl/sharedStrings.xml         a tabela de textos, referenciada por índice
//   xl/worksheets/sheetN.xml     as células
//   xl/styles.xml                os formatos — é aqui que se descobre data
//
// A leitura é toda por NOME LOCAL de elemento (`getName()`), nunca por namespace.
// É deliberado: todo XML do OOXML declara namespace padrão, e `getChild('row')`
// sem passar o Namespace devolve null nesse caso — a armadilha clássica do
// XmlService. Comparar o nome local funciona também quando o gerador usa prefixo
// (`x:row`), que acontece com arquivos que passaram por outras ferramentas.

/** Serial 0 do Excel é 30/12/1899, a mesma âncora que `normalizarData` usa. */
var XLSX_EPOCA_MS = Date.UTC(1899, 11, 30);

/**
 * Abre o ZIP e devolve { 'caminho/dentro/do/zip': Blob }.
 *
 * O `setContentType` NÃO é enfeite: `Utilities.unzip` recusa um blob que não se
 * declara `application/zip`, e o blob chega aqui com o tipo que o navegador
 * mandou no upload (`...sheet.spreadsheetml`, ou `application/octet-stream`).
 */
function partesDoXlsx_(blob, nome) {
  var arquivos;
  try {
    arquivos = Utilities.unzip(blob.setContentType('application/zip'));
  } catch (e) {
    throw new Error(
      'Não consegui abrir "' + (nome || 'o arquivo') + '" como .xlsx. Se ele for um ' +
      '.xls antigo (Excel 97-2003), abra no Excel e salve como .xlsx ou como CSV — ' +
      'o formato antigo não é um pacote de XML e não dá para ler aqui. ' +
      'Detalhe: ' + e.message
    );
  }

  var partes = {};
  arquivos.forEach(function (f) {
    // Alguns geradores gravam o caminho com './' ou '/' na frente.
    partes[String(f.getName()).replace(/^\.?\//, '')] = f;
  });
  return partes;
}

/** Filhos com aquele nome local. */
function xmlFilhos_(elemento, nome) {
  var achados = [];
  elemento.getChildren().forEach(function (f) {
    if (f.getName() === nome) achados.push(f);
  });
  return achados;
}

function xmlFilho_(elemento, nome) {
  var lista = xmlFilhos_(elemento, nome);
  return lista.length ? lista[0] : null;
}

/**
 * Atributo pelo nome local.
 *
 * `getAttribute('id')` do XmlService procura atributo SEM namespace e devolveria
 * null para o `r:id` que liga a aba ao arquivo dela — daí varrer a lista.
 */
function xmlAtributo_(elemento, nome) {
  var atributos = elemento.getAttributes();
  for (var i = 0; i < atributos.length; i++) {
    if (atributos[i].getName() === nome) return atributos[i].getValue();
  }
  return null;
}

function xmlRaiz_(parte) {
  return XmlService.parse(parte.getDataAsString()).getRootElement();
}

/**
 * A tabela de textos. Célula com `t="s"` guarda o ÍNDICE aqui, não o texto.
 *
 * Cada `<si>` pode vir inteiro num `<t>` ou partido em vários `<r>` (um "run"
 * por trecho com formatação própria) — um nome com uma palavra em negrito chega
 * partido, e ler só o primeiro `<t>` truncaria o nome do aluno.
 */
function lerSharedStrings_(parte) {
  if (!parte) return [];
  return xmlFilhos_(xmlRaiz_(parte), 'si').map(textoDoSi_);
}

function textoDoSi_(si) {
  var texto = '';
  si.getChildren().forEach(function (filho) {
    var nome = filho.getName();
    if (nome === 't') {
      texto += filho.getText();
    } else if (nome === 'r') {
      filho.getChildren().forEach(function (neto) {
        if (neto.getName() === 't') texto += neto.getText();
      });
    }
  });
  return texto;
}

/**
 * Códigos de formato embutidos que significam data ou hora.
 *
 * O .xlsx não guarda "isto é uma data": guarda um número e um formato. Sem olhar
 * o formato, a data de nascimento chegaria à tela como 45678 — e
 * `normalizarData` devolveria vazio, porque ela só reconhece serial quando ele
 * vem como número, e aqui tudo já virou texto. O antigo caminho pelo Sheets
 * resolvia isso sozinho (devolvia Date); este precisa resolver na mão.
 */
var XLSX_FORMATOS_DE_DATA = {
  '14': 1, '15': 1, '16': 1, '17': 1, '18': 1, '19': 1, '20': 1, '21': 1,
  '22': 1, '45': 1, '46': 1, '47': 1
};

/**
 * Devolve, por índice de estilo (`s` da célula), se aquele estilo é de data.
 * O índice aponta para a n-ésima entrada de `<cellXfs>`.
 */
function lerEstilosDeData_(parte) {
  if (!parte) return [];

  var raiz = xmlRaiz_(parte);
  var codigos = {};
  var numFmts = xmlFilho_(raiz, 'numFmts');
  if (numFmts) {
    xmlFilhos_(numFmts, 'numFmt').forEach(function (f) {
      codigos[String(xmlAtributo_(f, 'numFmtId'))] = String(xmlAtributo_(f, 'formatCode') || '');
    });
  }

  var estilos = [];
  var cellXfs = xmlFilho_(raiz, 'cellXfs');
  if (cellXfs) {
    xmlFilhos_(cellXfs, 'xf').forEach(function (xf) {
      var id = String(xmlAtributo_(xf, 'numFmtId') || '0');
      estilos.push(codigos[id] !== undefined
        ? codigoEhData_(codigos[id])
        : XLSX_FORMATOS_DE_DATA[id] === 1);
    });
  }
  return estilos;
}

/**
 * Formato personalizado é data quando sobra alguma letra de data/hora depois de
 * tirar o que é literal. Sem essa limpeza, `#,##0 "meses"` viraria data por causa
 * do "m" e do "s" da palavra, e a matrícula sairia como 12/03/2025.
 */
function codigoEhData_(codigo) {
  var limpo = String(codigo)
    .replace(/"[^"]*"/g, '')   // literais entre aspas
    .replace(/\[[^\]]*\]/g, '') // cor, condição, [$-416]
    .replace(/\\./g, '');       // caractere escapado
  return /[ymdhs]/i.test(limpo);
}

/**
 * Qual XML é a primeira aba, e quantas abas existem.
 *
 * A ordem que vale é a de `<sheets>` no workbook, e não a ordem dos arquivos no
 * ZIP: "sheet1.xml" costuma ser a primeira aba e não é obrigado a ser. Ler a aba
 * errada é o pior defeito possível aqui, porque não parece defeito — parece
 * planilha errada.
 */
function primeiraAba_(partes) {
  var abas = [];
  var workbook = partes['xl/workbook.xml'];
  if (workbook) {
    var lista = xmlFilho_(xmlRaiz_(workbook), 'sheets');
    if (lista) {
      xmlFilhos_(lista, 'sheet').forEach(function (s) {
        abas.push({ nome: xmlAtributo_(s, 'name') || '', rel: xmlAtributo_(s, 'id') || '' });
      });
    }
  }

  var alvos = relacoesDoWorkbook_(partes);
  var caminho = abas.length ? alvos[abas[0].rel] : '';

  // Reserva para arquivo sem workbook.xml legível: a primeira planilha do ZIP,
  // em ordem de nome. Vale a pena porque a alternativa é recusar um arquivo que
  // dá para ler.
  if (!caminho || !partes[caminho]) caminho = primeiraPlanilhaDoZip_(partes);

  return {
    caminho: caminho,
    nome: (abas[0] && abas[0].nome) || 'Planilha1',
    total: abas.length || 1
  };
}

/** Id da relação -> caminho do XML, já resolvido contra a pasta `xl/`. */
function relacoesDoWorkbook_(partes) {
  var mapa = {};
  var rels = partes['xl/_rels/workbook.xml.rels'];
  if (!rels) return mapa;

  xmlFilhos_(xmlRaiz_(rels), 'Relationship').forEach(function (r) {
    var id = xmlAtributo_(r, 'Id');
    var alvo = String(xmlAtributo_(r, 'Target') || '');
    if (!id || !alvo) return;
    // O Target é relativo a `xl/` ('worksheets/sheet1.xml') ou absoluto no
    // pacote ('/xl/worksheets/sheet1.xml').
    mapa[id] = alvo.charAt(0) === '/' ? alvo.slice(1) : 'xl/' + alvo.replace(/^\.\//, '');
  });
  return mapa;
}

function primeiraPlanilhaDoZip_(partes) {
  var nomes = [];
  Object.keys(partes).forEach(function (n) {
    if (/^xl\/worksheets\/[^\/]+\.xml$/.test(n)) nomes.push(n);
  });
  nomes.sort();
  return nomes.length ? nomes[0] : '';
}

/**
 * As células viram matriz de texto.
 *
 * A COLUNA sai da referência da célula (`r="B3"`), e não da ordem em que os `<c>`
 * aparecem: o .xlsx OMITE a célula vazia. Uma linha com A, C e D preenchidas
 * traz três `<c>`, e empilhá-los em sequência jogaria o valor de C para a coluna
 * do meio — a planilha inteira sairia desalinhada a partir da primeira célula
 * vazia, sem erro nenhum, e o professor confirmaria a importação de dados
 * trocados de coluna.
 */
function lerPlanilha_(parte, textos, estilos) {
  if (!parte) {
    throw new Error('Este .xlsx não tem aba de dados legível. Salve como CSV e importe de novo.');
  }

  var dados = xmlFilho_(xmlRaiz_(parte), 'sheetData');
  var matriz = [];
  var largura = 0;

  if (dados) {
    xmlFilhos_(dados, 'row').forEach(function (row) {
      var linha = [];
      xmlFilhos_(row, 'c').forEach(function (c) {
        var coluna = colunaDaCelula_(xmlAtributo_(c, 'r'), linha.length);
        while (linha.length < coluna) linha.push('');
        linha[coluna] = valorDaCelula_(c, textos, estilos);
      });
      if (linha.length > largura) largura = linha.length;
      matriz.push(linha);
    });
  }

  // Matriz retangular, como `getValues()` devolvia: a tela percorre a largura do
  // cabeçalho e linha curta imprimiria "undefined".
  matriz.forEach(function (linha) {
    while (linha.length < largura) linha.push('');
  });
  return matriz;
}

/** 'B3' -> 1. Sem referência, vale a próxima coluna livre. */
function colunaDaCelula_(referencia, padrao) {
  var letras = /^([A-Za-z]+)/.exec(String(referencia || ''));
  if (!letras) return padrao;

  var texto = letras[1].toUpperCase();
  var coluna = 0;
  for (var i = 0; i < texto.length; i++) {
    coluna = coluna * 26 + (texto.charCodeAt(i) - 64);
  }
  return coluna - 1;
}

/**
 * O valor de uma célula, sempre como texto.
 *
 * Texto porque a pré-visualização volta ao cliente por `google.script.run`, que
 * não serializa Date, e porque é como o dado vai ser gravado de qualquer forma.
 */
function valorDaCelula_(c, textos, estilos) {
  var tipo = xmlAtributo_(c, 't') || 'n';

  // Texto guardado dentro da própria célula, em vez de na tabela compartilhada.
  if (tipo === 'inlineStr') {
    var is = xmlFilho_(c, 'is');
    return is ? textoDoSi_(is) : '';
  }

  var v = xmlFilho_(c, 'v');
  var bruto = v ? v.getText() : '';
  if (bruto === '') return '';

  if (tipo === 's') {
    var indice = Number(bruto);
    return textos[indice] === undefined ? '' : textos[indice];
  }
  // 'str' = resultado de fórmula em texto; 'e' = erro do Excel (#N/D, #VALOR!),
  // que vale mais na tela do que uma célula em branco.
  if (tipo === 'str' || tipo === 'e') return bruto;
  if (tipo === 'b') return bruto === '1' ? 'VERDADEIRO' : 'FALSO';

  // Célula sem `s` usa o estilo 0, que é a regra do formato — e o estilo 0 é o
  // "Geral" em qualquer arquivo que o Excel escreva.
  var estilo = Number(xmlAtributo_(c, 's') || '0');
  if (estilos[estilo]) return serialParaTexto_(Number(bruto));

  var numero = Number(bruto);
  return isNaN(numero) ? bruto : String(numero);
}

/**
 * Serial do Excel -> texto, do mesmo jeito que o caminho pelo Sheets devolvia.
 *
 * Data vira 'aaaa-mm-dd' (o formato que `normalizarData` produz e que o sistema
 * inteiro usa); hora pura, que é ancorada em 30/12/1899, viraria uma data
 * absurda e por isso sai só como hora.
 *
 * O fuso é UTC de propósito: o serial é hora de parede, sem fuso nenhum.
 * Formatá-lo em America/Sao_Paulo empurraria toda data três horas para trás e
 * faria 01/01 virar 31/12.
 */
function serialParaTexto_(serial) {
  if (isNaN(serial)) return '';

  var data = new Date(XLSX_EPOCA_MS + Math.round(serial * 86400000));
  var completo = Utilities.formatDate(data, 'UTC', 'yyyy-MM-dd HH:mm:ss');

  if (completo.slice(0, 10) === '1899-12-30') return completo.slice(11);
  return completo.slice(11) === '00:00:00' ? completo.slice(0, 10) : completo;
}

// ------------------------------------------------------------ Mapeamento

/** Adivinha campo canônico para cada cabeçalho. Devolve { campo: indiceColuna }. */
function sugerirMapeamento_(cabecalhos) {
  var mapa = {};
  var scores = {};

  cabecalhos.forEach(function (c, i) {
    var palpite = adivinharCampo(c);
    if (!palpite) return;
    // Se duas colunas disputam o mesmo campo, fica a de maior score.
    if (scores[palpite.campo] === undefined || palpite.score > scores[palpite.campo]) {
      mapa[palpite.campo] = i;
      scores[palpite.campo] = palpite.score;
    }
  });

  return mapa;
}

// ------------------------------------------------------------ Temporários

/**
 * A matriz analisada fica num JSON no Drive entre os dois passos.
 *
 * Não no Firestore: seriam duas escritas e uma leitura por arquivo analisado —
 * cota gasta com dado que morre em minutos, e num passo que hoje não toca o
 * banco. Não no CacheService: o limite é 100 KB por item, e uma lista de
 * algumas centenas de alunos já passa disso.
 */
function salvarTemporario_(nomeArquivo, dados) {
  var conteudo = JSON.stringify({
    arquivo: nomeArquivo,
    criado_em: agora(),
    cabecalhos: dados.cabecalhos,
    linhas: dados.linhas,
    texto_bruto: dados.texto_bruto || ''
  });
  var blob = Utilities.newBlob(conteudo, MimeType.PLAIN_TEXT, uid('tmp') + '.json');
  return driveCriarArquivo_(pastaTemp_(), blob).id;
}

function lerTemporario_(id) {
  if (!id) return null;
  try {
    return JSON.parse(driveLerTexto_(id));
  } catch (e) {
    // A tela recebe "A pré-visualização expirou", que é a resposta certa para o
    // caso comum (o temporário foi para a lixeira). O que ela NÃO distingue é um
    // 403 do Drive, e aí o professor reenviaria o arquivo para sempre. O motivo
    // de verdade fica no registro de execução, que é onde se procura.
    console.error('lerTemporario_: ' + e.message);
    return null;
  }
}

function descartarTemporario_(id) {
  try { driveDescartar_(id); } catch (e) { /* já removido */ }
}

/** Devolve o ID da pasta de temporários. */
function pastaTemp_() {
  return drivePasta_('PASTA_TEMP_ID', PASTA_TEMP);
}

/**
 * Faxina de temporários com mais de 1 dia. Instale como gatilho diário se quiser
 * (Acionadores > Adicionar acionador > limparTemporariosAntigos > Diariamente).
 *
 * Os arquivos guardam a lista de alunos inteira; deixá-los acumulando no Drive é
 * dado pessoal parado sem prazo.
 */
function limparTemporariosAntigos() {
  var limite = new Date().getTime() - 24 * 60 * 60 * 1000;
  var n = 0;
  driveListar_(pastaTemp_()).forEach(function (f) {
    if (new Date(f.createdTime).getTime() < limite) { driveDescartar_(f.id); n++; }
  });
  if (n) registrar('LIMPEZA', 'temporarios', '', n + ' arquivos removidos');
  return n;
}

// ------------------------------------------------------------ Diagnóstico

/**
 * Onde a importação está morrendo — rode do editor, depois de ANALISAR.
 *
 * Existe porque a investigação de 25/08 esbarrou num muro: os dois PDFs do
 * professor passam limpos pelo leitor aqui no repositório (26 e 39 alunos,
 * matrículas todas distintas), e mesmo assim a importação real não conclui. A
 * diferença mora no OCR do Drive, que só roda dentro do Apps Script — não há
 * como reproduzi-la fora, e adivinhar já custou três hipóteses erradas.
 *
 * Esta função refaz, PASSO A PASSO, o que `confirmarImportacao` faria com o
 * último arquivo analisado, e imprime o que encontra em cada etapa. Quando o
 * número cai — 39 linhas viram 1 registro —, o log diz exatamente entre quais
 * duas etapas isso aconteceu.
 *
 * NÃO GRAVA NADA. Nenhuma escrita no Firestore, nenhum lote, nenhuma linha na
 * trilha. É seguro rodar com o sistema no ar, quantas vezes for preciso.
 *
 * COMO USAR
 *   1. no painel, faça a análise do arquivo (o passo que mostra a conferência)
 *   2. NÃO confirme a importação
 *   3. aqui no editor, escolha `diagnosticarImportacao` e Executar
 *   4. mande o registro de execução inteiro
 *
 * Sem argumento de propósito: o botão Executar do editor não passa argumentos —
 * é a mesma cicatriz de `liberarMeuAcesso` (07b_LinkPorEmail.gs).
 */
function diagnosticarImportacao() {
  Logger.log('=== diagnosticarImportacao ===');

  var temporarios;
  try {
    temporarios = driveListar_(pastaTemp_());
  } catch (e) {
    Logger.log('NÃO CONSEGUI LER A PASTA DE TEMPORÁRIOS: %s', e.message);
    return;
  }

  var jsons = temporarios.filter(function (a) {
    return String(a.name || '').slice(-5) === '.json';
  });

  if (!jsons.length) {
    Logger.log('Nenhuma análise guardada. Faça a análise no painel (sem confirmar)');
    Logger.log('e rode isto de novo — o temporário só existe entre os dois passos.');
    return;
  }

  // `driveListar_` já vem por createdTime desc: o primeiro é o mais recente.
  var alvo = jsons[0];
  Logger.log('temporário: %s (criado em %s)', alvo.name, alvo.createdTime);

  var temp = lerTemporario_(alvo.id);
  if (!temp) {
    Logger.log('O temporário existe mas não pude lê-lo — veja o erro acima no console.');
    return;
  }

  Logger.log('arquivo analisado: %s', temp.arquivo);
  Logger.log('');

  // ------------------------------------------------- 0. o texto cru da extração
  //
  // A etapa ZERO, e é a que faltava: tudo o mais neste log descreve o que o
  // leitor FEZ com o texto. Só aqui se vê o texto que ele recebeu — e quando o
  // OCR devolve um bloco achatado, é a única etapa em que isso aparece.
  var cru = String(temp.texto_bruto || '');
  Logger.log('--- 0. o texto CRU que a extração produziu ---');

  if (!cru) {
    Logger.log('(não guardado — análise feita por uma versão anterior, ou origem CSV/XLSX)');
  } else {
    var linhasCru = cru.split(/\r?\n/);
    Logger.log('tamanho: %s caracteres em %s linha(s)', cru.length, linhasCru.length);
    if (linhasCru.length <= 3) {
      Logger.log('>>> O TEXTO VEIO ACHATADO: %s linha(s) para o arquivo inteiro.', linhasCru.length);
      Logger.log('>>> É por isso que o leitor não separa os alunos.');
    }
    Logger.log('as primeiras 40 linhas, entre colchetes para os espaços aparecerem:');
    linhasCru.slice(0, 40).forEach(function (l, n) {
      Logger.log('  %s [%s]', n, l.length > 200 ? l.slice(0, 200) + '…(cortada)' : l);
    });
  }
  Logger.log('');

  // ---------------------------------------------------------------- 1. matriz
  var linhas = temp.linhas || [];
  Logger.log('--- 1. o que a análise guardou ---');
  Logger.log('linhas na matriz : %s', linhas.length);
  Logger.log('cabeçalhos       : %s', JSON.stringify(temp.cabecalhos));

  var academico = String(temp.cabecalhos || '') === String(CABECALHO_ACADEMICO);
  Logger.log('formato acadêmico: %s', academico ? 'SIM' : 'NÃO — a matriz é a bruta do arquivo');

  for (var i = 0; i < Math.min(3, linhas.length); i++) {
    Logger.log('  linha %s: %s', i, JSON.stringify(linhas[i]));
  }
  Logger.log('');

  // -------------------------------------------------------------- 2. mapeamento
  var mapeamento = sugerirMapeamento_(temp.cabecalhos || []);
  Logger.log('--- 2. mapeamento automático ---');
  Logger.log('%s', JSON.stringify(mapeamento));
  if (mapeamento.matricula === undefined) {
    Logger.log('>>> NENHUMA COLUNA VIROU MATRÍCULA. Sem chave, toda linha é descartada.');
  }
  if (mapeamento.nome === undefined) {
    Logger.log('>>> NENHUMA COLUNA VIROU NOME. Sem nome, toda linha é descartada.');
  }
  Logger.log('');

  // ----------------------------------------------------------- 3. os registros
  var contexto = { loteId: 'diagnostico', quando: agora(), quem: 'diagnostico' };
  var preparo = prepararRegistros_(linhas, mapeamento, contexto);

  Logger.log('--- 3. o que sobreviveria ao preparo ---');
  Logger.log('entrariam no banco        : %s', preparo.registros.length);
  Logger.log('descartados por SEM NOME  : %s', preparo.semNome);
  Logger.log('descartados SEM MATRÍCULA : %s', preparo.semMatricula);
  Logger.log('REPETIDAS no arquivo      : %s', preparo.repetidas);

  if (preparo.repetidas && preparo.registros.length <= 3) {
    Logger.log('>>> COLAPSO POR MATRÍCULA REPETIDA. %s linhas viraram %s registro(s):',
      linhas.length, preparo.registros.length);
    Logger.log('>>> a coluna lida como matrícula tem o mesmo valor em quase toda linha.');
  }
  Logger.log('');

  // ------------------------------------------------- 4. o que seria gravado
  Logger.log('--- 4. as 5 primeiras fichas, como iriam para o banco ---');
  preparo.registros.slice(0, 5).forEach(function (r) {
    Logger.log('  _id=%s | matricula=%s | nome=%s | turma=%s | telefone=%s',
      r._id, r.matricula, r.nome, r.turma, r.telefone);
  });
  Logger.log('');

  // ------------------------------------------------------- 5. o tamanho da escrita
  var blocos = Math.ceil(preparo.registros.length / IMPORTACAO_BLOCO) || 0;
  var bytes = 0;
  try { bytes = JSON.stringify(preparo.registros).length; } catch (e) { bytes = -1; }

  Logger.log('--- 5. a gravação ---');
  Logger.log('blocos de até %s     : %s', IMPORTACAO_BLOCO, blocos);
  Logger.log('tamanho aproximado   : %s KB', Math.round(bytes / 1024));
  Logger.log('');

  Logger.log('=== fim. NADA foi gravado. ===');
}
