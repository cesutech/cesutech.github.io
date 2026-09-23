/**
 * 05c_Revisao.gs — a revisão de divergências: quem estava na lista oficial como
 * ADS41 e NÃO veio no relatório novo de ADS41.
 *
 * A importação nunca apaga (ver "Substituir a lista não apaga mais", no
 * cabeçalho de 05_Importacao.gs): reimportar atualiza quem veio e acrescenta
 * quem falta, e quem sumiu da lista PERMANECE. Até 21/09 a única saída era o
 * expurgo do lote inteiro — a vassoura entre semestres. Faltava o bisturi
 * dentro do semestre: o aluno que trancou, desistiu ou mudou de turma no meio
 * do período continua ocupando vaga no projeto e continua passando na
 * conferência de matrícula do formulário. Este arquivo é o bisturi.
 *
 * São DUAS funções de painel, e a divisão entre elas é o desenho inteiro:
 *
 *   revisarLote     LEITURA PURA. Compara a lista oficial da turma com o lote e
 *                   devolve quem não veio, separado por origem, com as
 *                   inscrições de cada um. Está em `SO_LEITURA` no painel
 *                   (repetível, abortável), então NÃO ESCREVE NADA — nem a turma
 *                   deduzida de um lote antigo, nem uma linha de log.
 *   aplicarRevisao  ESCRITA. Recebe a decisão por aluno (CANCELAR ou EXCLUIR),
 *                   relê, anula as inscrições, grava a marca ou move para a
 *                   coleção de excluídos, marca o lote, registra e invalida.
 *
 * -------------------------------------------------- A chave é a turma do LOTE
 *
 * A pergunta é feita pela `turma_cabecalho` do lote (05_Importacao.gs), e não
 * pela turma de cada linha. A secretaria emite um relatório POR TURMA, e o
 * mesmo arquivo lista aluno de outra fase cursando junto: ler a chave da linha
 * apontaria esse aluno como "não veio" no relatório da turma DELE, quando ele
 * veio no da outra. Lote anterior a 21/09 não tem a chave; para ele a turma é
 * deduzida da MAIORIA das linhas que ainda estão no banco com o `lote_id`
 * dele — confiável nos lotes mais novos de cada turma, e é por isso que a
 * régua do carimbo (abaixo) existe: num lote já substituído as sobras mentem,
 * e quem veio no lote mais novo simplesmente não é candidato.
 *
 * -------------------------------------------------- A régua do carimbo
 *
 * Candidato é quem tem `turma == turma_cabecalho` (UMA consulta de igualdade,
 * índice automático) E `carimbo(lote_id) < carimbo(loteId)` (em código) E não
 * está cancelado. NUNCA `lote_id != loteId`: o mesmo arquivo importado duas
 * vezes, uma importação PARCIAL retomada e o cruzado importado depois têm
 * `lote_id` diferente deste sem terem sumido de nada. O carimbo é o prefixo
 * UTC de largura fixa do id (`loteId_` = `logId_`, 04_Log.gs), então comparar
 * texto é comparar tempo. Quem veio neste arquivo tem `lote_id` igual ou mais
 * novo por construção — o upsert só avança o lote —, logo a lista de
 * matrículas do lote seria redundante à régua, e não é gravada.
 *
 * Os candidatos são sub-classificados pela ORIGEM, porque "não veio neste
 * arquivo" tem três leituras diferentes:
 *
 *   emLoteMaisNovo         veio em importação POSTERIOR a esta — este lote já
 *                          não é o retrato; só contado, e o aviso manda revisar
 *                          o lote mais recente;
 *   outraListaDoSemestre   o lote de origem tem o MESMO `semestre_cabecalho`
 *                          deste e é de OUTRA turma — a pessoa veio em outra
 *                          lista oficial desta rodada (mudou de turma, ou cursa
 *                          a disciplina de lá); informação, sem ação. A lista
 *                          ANTERIOR desta mesma turma não conta como "outra":
 *                          quem estava nela e não está nesta é o candidato;
 *   jaCancelados           já têm a marca; listados à parte, SEM AÇÃO NENHUMA —
 *                          nem a anulação (decisão de 21/09, rodada 2). A
 *                          inscrição que um cancelado tem hoje nasceu DEPOIS da
 *                          marca: ele se reinscreveu num projeto com
 *                          `validar_matricula=NAO`, ou a coordenação o incluiu
 *                          pelo Alunos com o aviso de CANCELADA na tela — é
 *                          deliberada, e a janela só diz "ocupa vaga". Uma
 *                          decisão que chegue sobre ele — CANCELAR ou EXCLUIR,
 *                          por janela estagnada de outro professor ou replay —
 *                          é contada em `jaCancelados` e não toca nada, nem o
 *                          documento nem a inscrição; excluir de verdade um
 *                          cancelado é reimportar (reativa) e excluir; tirar a
 *                          inscrição dele é pelo Geral;
 *   candidatos             os únicos com decisão — divididos em "sem projeto" e
 *                          "com projeto" pelo cruzamento com `inscricoes`.
 *
 * -------------------------------------------------- Cancelar e Excluir
 *
 * CANCELAR grava QUATRO campos no documento de `matriculados` — a marca lida por
 * `cadastroCancelado_` (04_Inscricoes.gs) — por `atualizarEmLote` (02_Repo.gs):
 * um `:commit` com máscara de exatamente esses campos e `exists:true`. Nada do
 * documento é reescrito, e um documento que sumiu entre a tela e o clique
 * derruba o bloco inteiro em vez de criar fantasma. Desfazer é a REIMPORTAÇÃO:
 * a lista nova substitui o documento inteiro, sem a marca (ver o cabeçalho de
 * 05_Importacao.gs). Não existe "reativar", e não há linha de log de
 * reativação — a prova é o `lote_id` novo.
 *
 * EXCLUIR copia o documento inteiro para `matriculados_excluidos` (mesmo id,
 * mais `excluido_em/por/lote_id`) e SÓ ENTÃO apaga de `matriculados` — a mesma
 * ordem da quarentena do Auditório: morrer no meio deixa uma cópia a mais, e
 * nunca uma pessoa a menos. A coleção não expira (decisão de 21/09; ver
 * `MATRICULADOS_EXCLUIDOS_COLECAO` em 04_Inscricoes.gs) e entra no backup
 * diário sozinha. É para quem nunca deveria ter entrado — arquivo errado,
 * teste — e não para quem trancou.
 *
 * As duas ações SEMPRE anulam as inscrições vivas do aluno (decisão de 21/09):
 * a vaga tem de ser liberada, e o cancelado fica fora da lista padrão. As
 * inscrições são descobertas AQUI, no instante do Aplicar — e não recebidas da
 * tela —, para uma inscrição feita entre abrir a janela e clicar não ficar viva
 * por baixo da marca. Anular passa inteira por `anularInscricoes`
 * (13_Auditorio.gs): relê, copia para a quarentena, apaga, libera a vaga por
 * construção e grava a linha dela no log.
 *
 * "As inscrições do aluno" — o que a revisão ANULA — são SÓ as que trazem a
 * MATRÍCULA dele: a varredura de `inscricoes` (a de Disciplinas,
 * `varrerInscricoes_`), indexada pela matrícula normalizada da PRÓPRIA
 * inscrição. É a mesma pergunta de igualdade `matricula == X` que
 * `inscricoesEmOutrosProjetos_` (04_Inscricoes.gs) faz por pessoa, lida de
 * uma vez para a turma inteira. Anular é destrutivo — a vaga vai para o
 * próximo da fila, e quem não está na lista não volta por "Incluir aluno" —,
 * e por isso a régua é a mais estreita que existe: o que a pessoa declarou
 * ser dela.
 *
 * As fichas de `alunos` NÃO decidem anulação (decisão de 21/09, rodada 2). A
 * reconciliação casa uma inscrição sem matrícula — ou com matrícula que a
 * lista não tem — por CPF, e-mail ou NOME, e nome casa homônimo e parente: a
 * ficha DIVERGENCIA ('Nome exato', 'Nome aproximado (93%)', 'E-mail (CPF
 * diverge)') é justamente a que a cascata NÃO tem certeza, a ficha CONFIRMADO
 * por e-mail pode ser a conta de família, e a ficha que a coordenação já
 * resolveu à mão como "não é a mesma pessoa" guarda os dois ids do mesmo
 * jeito. Seguir qualquer uma delas anularia a inscrição de OUTRA pessoa. Então
 * a ficha da turma com `matricula_id` do candidato e inscrição viva SEM a
 * matrícula dele entra na janela como INFORMAÇÃO na linha do candidato
 * (`possiveis`: "possível inscrição sem esta matrícula em Robótica (protocolo
 * …, casada por E-mail) — confira no Geral"), sem ação automática: a
 * coordenação confere e, se for mesmo a pessoa, anula pelo Geral (o
 * Auditório). A ficha que a coordenação já resolveu à mão como "não é a mesma
 * pessoa" (SO_INSCRITO ou SO_MATRICULADO com os dois ids — a cascata nunca
 * produz isso sozinha) nem é apontada: apontar contradiria a decisão gravada.
 * A lista "com projeto" continua sendo só quem tem inscrição COM a matrícula;
 * um candidato só com `possiveis` está em "sem projeto", com a linha de
 * informação — e a contagem "inscrições a anular" da janela não o soma.
 *
 * A limitação, dita inteira: a revisão anula só o que tem a matrícula; o
 * resto é apontado, e quem decide é gente. O que nem apontado é: a inscrição
 * sem matrícula que a reconciliação NÃO ligou ao candidato — a segunda
 * inscrição da mesma pessoa, sem matrícula, quando a primeira tinha (a
 * cascata consome o matriculado na primeira e a segunda vira SO_INSCRITO), ou
 * a feita depois da última rodada. Ela fica viva; na rodada seguinte da
 * reconciliação casa por e-mail/CPF com a pessoa já cancelada, e a aba Alunos
 * a mostra como cancelada COM projeto, com o selo — daí a coordenação anula
 * pelo Geral.
 *
 * -------------------------------------------------- A ordem do Aplicar
 *
 *   0. recusas de formato e de teto, ANTES de qualquer leitura;
 *   1. o lote (PARCIAL, EXPURGADO ou inexistente recusam);
 *   2. releitura da turma por UMA consulta — cada decisão é conferida contra o
 *      documento de agora: quem voltou numa importação igual ou mais nova, ou
 *      já não consta como a turma, é PULADO e não é tocado;
 *   3. a varredura de inscrições (só ela: as fichas não decidem) e o teto de
 *      anulação (200, o do Auditório). Quem já estava cancelado e quem foi
 *      pulado não entram: nenhuma inscrição deles é anulada;
 *   4. ANULAR PRIMEIRO — é o passo com teto próprio e com quarentena, logo o
 *      reversível; se ele recusar, nada foi cancelado antes;
 *   5. EXCLUIR: cópia → apaga → fichas órfãs em `alunos`;
 *   6. CANCELAR: o patch em lote;
 *   7. o lote (revisado_em/por/turma/resumo; e a turma, se o lote não tinha);
 *   8. a linha LOTE_REVISADO, com as MATRÍCULAS por ação (números, sem nome —
 *      decisão de 21/09; o precedente é `registrarEdicao_`, 10_Painel.gs);
 *   9. cache do Painel e marca da reconciliação.
 *
 * Entre a releitura (2) e o apaga (5) ou o patch (6) passam SEGUNDOS a MINUTOS:
 * `anularInscricoes` relê cada inscrição em fila, ~0,5 s cada, até 200. Uma
 * reimportação que entra nessa janela reescreve o documento do aluno com o
 * `lote_id` novo — e `exists:true` deixaria o patch marcar como cancelado quem
 * está na lista oficial mais nova (invisível a qualquer revisão depois: o
 * `lote_id` já é o novo). Por isso o patch e o delete levam a VERSÃO relida
 * (`_versao`, o `updateTime` do banco): o `:commit` recusa o bloco inteiro com
 * FAILED_PRECONDITION se qualquer documento mudou, `fraseSegura_` diz "a lista
 * da tela é de antes" e a resposta traz o que já foi feito (as anulações). A
 * pessoa reimportada fica sem a inscrição — o mesmo caso da inclusão no meio
 * tempo, desfeito por Alunos → Incluir aluno.
 *
 * Cada passo relata o que JÁ fez se o seguinte falhar (o `catch` devolve os
 * contadores). Reaplicar é seguro: inscrição anulada vira `nao_encontradas`,
 * excluído vira pulado, cancelado vira `jaCancelados`.
 *
 * -------------------------------------------------- A trilha parcial
 *
 * Um Aplicar que morre ou é recusado DEPOIS de ter anulado ou excluído alguém
 * já mexeu no banco, e um `ok:false` com contadores não diz QUEM. Por isso o
 * `catch` (decisão de 21/09, rodada 2), quando algum contador é maior que
 * zero, ainda grava o que ficou: a linha LOTE_REVISADO_PARCIAL com as
 * matrículas por ação (o formato da LOTE_REVISADO, mais as matrículas das
 * anuladas — na linha inteira elas são as dos cancelados/excluídos; na
 * interrompida são justamente as que ficaram sem a marca — e o motivo), a
 * marca do lote com o resumo em `situacao: 'PARCIAL'` (a aba Importações e a
 * janela dizem "interrompida"), o cache do Painel e a marca da reconciliação
 * — a contagem mudou. E a resposta lista nominalmente o que foi feito
 * (`parcial`: matrícula, inscrição e projeto de cada anulada DE FATO — a que
 * já não existia não entra; matrículas excluídas e canceladas) e diz em
 * frases (`avisos`): "A inscrição de 9110002 (Robótica) foi anulada antes da
 * recusa" — é por ela que a coordenação sabe quem reincluir por Alunos →
 * Incluir aluno. Nada disso roda se nada foi feito: a recusa antes da
 * primeira escrita não é revisão, e não deixa linha.
 *
 * SEM `LockService`, de propósito: a revisão só LIBERA vaga (o caso 1 do
 * cabeçalho de 13_Auditorio.gs). Quem ocupa vaga é `reservarVaga`, e ela conta
 * depois, lá dentro.
 *
 * -------------------------------------------------- Custo
 *
 * T = matriculados da turma, C = candidatos, I = inscrições, L = lotes (≤50),
 * F = fichas de `alunos` da turma (≤ T).
 *
 *   revisarLote contarApenas   1 + T + L (só com candidatos)      ~3 idas
 *   revisarLote completo       o mesmo + I (bloco de 300) + F     5-6 idas
 *   aplicarRevisao             1 + T + I + (1 a 2 por id anulado) +
 *                              (1 consulta por excluído); escritas 2 por
 *                              anulada + 2 por excluído + ≤1 ficha + 1 commit
 *                              dos cancelados + 1 lote + 2 log      ~10 idas
 *                              (as fichas não são lidas: não decidem nada)
 *
 * Turma de 40 com 3 sumidos, hoje: contar ≈ 91 leituras; completo ≈ 406; o
 * Aplicar ≈ 320 leituras e ~20 escritas. Teto absoluto do revisar: 1 + 500 +
 * 50 + 2000 + 500 ≈ 3.051. Abrir as treze turmas de uma sexta ≈ 5.300
 * leituras, ~11% do dia. O painel dá 15 s a `revisarLote`
 * (LIMITE_DE_LEITURA_POR_FUNCAO_MS): ela lê quatro coleções e é a leitura mais
 * lenta do painel depois da de disciplinas — e abortada, a tentativa seguinte
 * paga a conta inteira de novo. As fichas custam T leituras numa ida, e não
 * uma ida por candidato: 40 idas seriam ~20 s, fora do limite.
 *
 * -------------------------------------------------- O que sai daqui
 *
 * Erros do `:commit` viram frase fixa antes de chegar ao log de execução e à
 * tela (`fraseSegura_`, no fim deste arquivo): a mensagem do Firestore carrega
 * o caminho do documento, e o caminho É a matrícula — ou o id do projeto
 * Cloud, o começo da trilha para quem quiser sondar. A limpeza do caminho é
 * `semCaminhoDeDocumento_` (02_Repo.gs, ao lado de `fsErro_`, que é quem monta
 * a mensagem com ele), e é a mesma régua do Auditório. TODO caminho de erro
 * passa por ela: o `catch` daqui, a recusa de `anularInscricoes` (que já sai
 * limpa de lá, e passa de novo aqui — custa nada, e o dia em que alguém trocar
 * o Auditório este arquivo continua limpo), a frase da trilha parcial e a do
 * `console.error`. Nenhum `err.message` cru sai deste arquivo.
 */

/**
 * Teto de candidatos listados e de decisões por Aplicar.
 *
 * Uma turma tem até 60 alunos; 100 candidatos de "não veio" não são uma turma,
 * são sobra de semestres anteriores — e a recusa aponta para a vassoura
 * ("Apagar matriculados"), que é a ferramenta certa para isso. Viaja na
 * resposta (`loteMaximo`) para a tela recusar antes de mandar.
 */
var REVISAO_LOTE_MAXIMO = 100;

/**
 * Quantos matriculados da turma são lidos, e quantas inscrições são varridas.
 *
 * Os MESMOS tetos de `matriculadosDaDisciplina` (12_Disciplinas.gs), repetidos
 * aqui porque este arquivo carrega antes daquele; existe teste que lê os dois
 * e falha se divergirem. As duas telas cruzam a mesma turma com a mesma
 * varredura, e precisam concordar sobre onde o corte está.
 */
var REVISAO_MAX_TURMA = 500;
var REVISAO_MAX_CRUZAMENTO = 2000;

/** As duas ações que uma decisão pode carregar. Manter não viaja. */
var REVISAO_ACOES = ['CANCELAR', 'EXCLUIR'];

// ------------------------------------------------------------ Leitura

/**
 * Quem estava no banco como a turma deste lote e não veio nele.
 *
 * payload: { token, loteId, turma?, contarApenas? }
 *   `turma`         só quando a tela pede (`precisaTurma`) ou o professor corrige
 *                   no campo da janela — vale como INFORMADA e NÃO é gravada;
 *   `contarApenas`  o número do passo 3 da importação: para antes de varrer as
 *                   inscrições. Sai do MESMO predicado da lista, então passo 3 e
 *                   janela dizem sempre o mesmo número.
 *
 * Leitura pura. Está em `SO_LEITURA`, com 15 s de limite, e por isso não pode
 * gravar nem a turma deduzida de um lote antigo (quem grava é `aplicarRevisao`).
 */
function revisarLote(payload) {
  try {
    payload = payload || {};
    exigirAdmin(payload.token);

    var loteId = String(payload.loteId || '').trim();
    if (!loteId) return { ok: false, erro: 'Informe qual importação deve ser revisada.' };

    var lote = ler(LOTES_COLECAO, loteId);
    var recusa = recusaDoLote_(lote);
    if (recusa) return { ok: false, erro: recusa };

    var lidas = { matriculados: 0, lotes: 0, inscricoes: 0 };
    var turma = turmaDaRevisao_(lote, loteId, payload.turma, lidas);
    if (!turma.ok) return turma;

    // UM filtro de igualdade, sem ordenação declarada: `listar` cai em
    // `__name__` ascendente, coberto pelo índice automático de campo único — a
    // consulta de `matriculadosDaDisciplina`, pelo mesmo motivo.
    var oficiais = listar(MATRICULADOS_COLECAO, {
      campo: 'turma', valor: turma.turma, limite: REVISAO_MAX_TURMA
    }).itens;
    lidas.matriculados += oficiais.length;

    var classes = classificarPorCarimbo_(oficiais, loteId);

    // A recusa vem ANTES de ler lotes e inscrições: descobrir que são 300
    // candidatos não pode custar as duas varreduras que não vão servir.
    if (classes.brutos.length > REVISAO_LOTE_MAXIMO) {
      return {
        ok: false,
        candidatos: classes.brutos.length,
        erro: classes.brutos.length + ' alunos com turma ' + turma.turma + ' vieram de importações ' +
              'mais antigas que esta. Isso não é uma turma — é sobra de semestres anteriores. ' +
              'Apague as importações antigas (Importações → Apagar matriculados) e revise de novo.'
      };
    }

    // Os lotes só são lidos quando há candidato para atribuir a um: é neles que
    // se descobre se a pessoa veio em OUTRA lista deste mesmo semestre. É a
    // consulta de `listarLotes` (10_Painel.gs), com o teto dela: os 50 mais
    // recentes cobrem um semestre inteiro de importações; um lote de origem
    // mais velho que isso vira candidato sem arquivo, com o aviso de virada.
    var lotes = {};
    if (classes.brutos.length) {
      var listaDeLotes = listar(LOTES_COLECAO, {
        ordenarPor: 'criado_em', direcao: 'DESC', limite: PAINEL_LIMITE_LOTES
      }).itens;
      lidas.lotes += listaDeLotes.length;
      listaDeLotes.forEach(function (l) { lotes[l._id] = l; });
    }

    var semestre = String(lote.semestre_cabecalho || '');
    var candidatos = [];
    var outraLista = [];
    var deOutroSemestre = 0;

    classes.brutos.forEach(function (m) {
      var origem = lotes[m.lote_id] || null;
      var semestreDeOrigem = origem ? String(origem.semestre_cabecalho || '') : '';
      var turmaDeOrigem = origem ? String(origem.turma_cabecalho || '') : '';
      var mesmoSemestre = Boolean(semestre) && semestreDeOrigem === semestre;

      // "Veio em outra lista deste semestre" exige que a lista de origem seja
      // de OUTRA turma: quem veio na lista ANTERIOR desta mesma turma, neste
      // mesmo semestre, e não veio nesta é exatamente o candidato — a lista de
      // sexta e a de segunda têm o mesmo semestre, e a segunda é a que diz quem
      // trancou. Origem sem turma registrada não prova nada e cai em candidato.
      if (mesmoSemestre && turmaDeOrigem && turmaDeOrigem !== turma.turma) {
        outraLista.push({
          matricula: m.matricula || m._id || '',
          nome: m.nome || '',
          lote: resumoDoLote_(m.lote_id, origem)
        });
        return;
      }
      if (!mesmoSemestre) deOutroSemestre++;
      candidatos.push({ doc: m, lote: resumoDoLote_(m.lote_id, origem) });
    });

    var vieram = classes.vieram.length;
    var resposta = {
      ok: true,
      loteId: loteId,
      arquivo: lote.arquivo || '',
      importadoEm: lote.importado_em || '',
      turma: turma.turma,
      turmaBruta: turma.turmaBruta,
      semestre: semestre,
      origemTurma: turma.origem,
      origemDetalhe: turma.detalhe,
      vieram: vieram,
      candidatos: candidatos.length,
      emLoteMaisNovo: classes.maisNovos.length,
      outraListaDoSemestre: outraLista.length,
      jaCancelados: classes.cancelados.length,
      // "Sumiram mais do que vieram" é o sinal de arquivo errado ou de virada
      // de semestre; C > 0 porque zero candidatos nunca é alarme.
      sumiramMaisQueVieram: candidatos.length > 0 && candidatos.length >= vieram,
      avisos: [],
      lidas: lidas,
      loteMaximo: REVISAO_LOTE_MAXIMO
    };

    if (oficiais.length === REVISAO_MAX_TURMA) {
      resposta.avisos.push(
        'A turma bateu no teto de ' + REVISAO_MAX_TURMA + ' matriculados lidos e pode ter mais. ' +
        'Quem ficou de fora não aparece em nenhuma das listas.');
    }
    if (classes.maisNovos.length) {
      resposta.avisos.push(
        classes.maisNovos.length + ' aluno(s) desta turma vieram em importação mais nova que esta — ' +
        'para o retrato atual, revise a importação mais recente de ' + turma.turma + '.');
    }
    if (deOutroSemestre) {
      resposta.avisos.push(
        deOutroSemestre + ' candidato(s) vieram de importação de outro semestre (ou sem semestre ' +
        'registrado). Se as outras turmas' + (semestre ? ' de ' + semestre : '') + ' ainda não foram ' +
        'importadas, eles podem só ter mudado de turma — importe todas as listas antes de cancelar.');
    }
    if (resposta.sumiramMaisQueVieram) {
      resposta.avisos.push(
        'Sumiram mais alunos do que vieram (' + candidatos.length + ' contra ' + vieram + '). Confira ' +
        'se o arquivo é mesmo de ' + turma.turma + ', ou se é virada de semestre.');
    }
    if (turma.origem === 'LINHAS') {
      resposta.avisos.push(
        'A turma foi deduzida das linhas desta importação (' + turma.detalhe + '): este lote é anterior ' +
        'ao registro do cabeçalho. Reimportar o mesmo arquivo grava o cabeçalho.');
    }

    if (payload.contarApenas) return resposta;

    // O cruzamento com os projetos — a MESMA varredura da aba Disciplinas, para
    // as duas telas concordarem sobre quem tem inscrição —, mais as fichas de
    // `alunos`, que só INFORMAM (ver "Cancelar e Excluir" no cabeçalho).
    var varredura = varreduraDeInscricoes_(lidas);
    var fichas = fichasDaTurma_(turma.turma, lidas);

    var semProjeto = [];
    var comProjeto = [];
    candidatos.forEach(function (c) {
      var item = itemDaRevisao_(c.doc, c.lote, inscricoesDe_(varredura, c.doc), possiveisDe_(varredura, fichas, c.doc));
      (item.inscricoes.length ? comProjeto : semProjeto).push(item);
    });
    semProjeto.sort(porNome_);
    comProjeto.sort(porNome_);

    resposta.semProjeto = semProjeto;
    resposta.comProjeto = comProjeto;
    resposta.outraListaDoSemestre = outraLista.sort(porNome_);
    resposta.jaCancelados = classes.cancelados.map(function (m) {
      return {
        matricula: m.matricula || m._id || '',
        nome: m.nome || '',
        cancelado_em: m.cancelado_em || '',
        cancelado_por: m.cancelado_por || '',
        inscricoes: inscricoesDe_(varredura, m),
        possiveis: possiveisDe_(varredura, fichas, m)
      };
    }).sort(porNome_);
    resposta.revisado = lote.revisado_em
      ? { em: lote.revisado_em, por: lote.revisado_por || '', resumo: resumoDaRevisao_(lote.revisao_resumo) }
      : null;
    resposta.truncado = Boolean(varredura.truncado);

    if (varredura.truncado) {
      // A agregação só acontece aqui, e é o único lugar em que ela se paga: o
      // aviso precisa dizer o TAMANHO do buraco.
      var total = contar(INSCRICOES_COLECAO);
      resposta.avisos.push(
        'Li as ' + varredura.lidas + ' primeiras inscrições de ' + total + '. Quem estiver nas ' +
        Math.max(0, total - varredura.lidas) + ' restantes aparece aqui como SEM PROJETO sem estar — ' +
        'o Aplicar recusa enquanto isso durar.');
    }

    return resposta;
  } catch (err) {
    console.error('revisarLote: ' + fraseSegura_(err));
    return { ok: false, erro: fraseSegura_(err) };
  }
}

/**
 * A turma pela qual esta revisão compara — e de onde ela veio.
 *
 * Prioridade: informada na chamada > `turma_cabecalho` do lote > maioria das
 * linhas que ainda estão no banco com este `lote_id` (lote anterior a 21/09).
 * Devolve { ok:true, turma, turmaBruta, origem, detalhe } ou a recusa pronta.
 *
 * O cabeçalho que diz ADS41 sem NENHUMA linha gravada como ADS41 é a recusa
 * `precisaTurma`: ou o arquivo não é desta turma, ou o cabeçalho foi lido
 * errado — e nos dois casos comparar por ele apontaria a turma inteira como
 * "não veio".
 */
function turmaDaRevisao_(lote, loteId, informada, lidas) {
  var digitada = String(informada === null || informada === undefined ? '' : informada).trim();
  var chave = normalizarTurma(digitada).slice(0, TURMA_CABECALHO_MAX);
  var doLote = String(lote.turma_cabecalho || '');

  if (chave && chave !== doLote) {
    return { ok: true, turma: chave, turmaBruta: digitada, origem: 'INFORMADA', detalhe: 'informada na tela' };
  }

  if (doLote) {
    // `linhas_da_turma` só existe em lote registrado com cabeçalho; ausente
    // (lote antigo que ganhou a turma pelo Aplicar) não é zero.
    var linhas = lote.linhas_da_turma;
    var zeroLinhas = linhas !== undefined && linhas !== null && String(linhas).trim() !== '' &&
      Number(linhas) === 0;
    if (zeroLinhas && !chave) {
      return {
        ok: false,
        precisaTurma: true,
        sugestao: '',
        motivo: 'O cabeçalho do arquivo diz ' + doLote + ', mas nenhuma linha gravada é ' + doLote +
                '. Confira se o arquivo é mesmo desta turma, ou informe a turma.'
      };
    }
    return {
      ok: true,
      turma: doLote,
      turmaBruta: lote.turma_cabecalho_bruta || doLote,
      origem: lote.turma_origem || 'CABECALHO',
      detalhe: detalheDaOrigem_(lote)
    };
  }

  // Lote sem chave: a maioria das linhas que SOBRARAM com este lote_id. É a
  // consulta de `expurgarLote`, uma ida.
  var restos = listar(MATRICULADOS_COLECAO, {
    campo: 'lote_id', valor: loteId, limite: REVISAO_MAX_TURMA
  }).itens;
  lidas.matriculados += restos.length;

  if (!restos.length) {
    return {
      ok: false,
      precisaTurma: true,
      sugestao: '',
      motivo: 'Todos os alunos desta importação já foram reescritos por importações mais novas — ' +
              'revise a importação mais recente desta turma, ou informe a turma.'
    };
  }

  var maioria = turmaMajoritaria_(restos);
  var detalhe = Math.round(maioria.fracao * maioria.comTurma) + ' de ' + maioria.total +
    ' registros desta importação';
  if (!maioria.valida) {
    return {
      ok: false,
      precisaTurma: true,
      sugestao: maioria.turma || '',
      motivo: 'Esta importação é anterior ao registro do cabeçalho, e as linhas que sobraram dela ' +
              'não apontam uma turma com segurança (' + detalhe + '). Informe a turma.'
    };
  }
  return { ok: true, turma: maioria.turma, turmaBruta: maioria.turma, origem: 'LINHAS', detalhe: detalhe };
}

/** "cabeçalho do arquivo", "linha da disciplina", "informada no passo 2"... (o semestre vai à parte). */
function detalheDaOrigem_(lote) {
  var origem = String(lote.turma_origem || '');
  if (origem === 'DISCIPLINA') return 'linha da disciplina do arquivo';
  if (origem === 'INFORMADA') return 'informada no passo 2 da importação';
  if (origem === 'MAIORIA') return 'maioria das linhas do arquivo';
  if (origem === 'LINHAS') return 'deduzida das linhas numa revisão anterior';
  return 'cabeçalho do arquivo';
}

/**
 * Os matriculados da turma repartidos pela régua do carimbo (ver o cabeçalho).
 *
 *   vieram      `lote_id` é ESTE lote;
 *   maisNovos   carimbo igual ou posterior, de outro lote — não é candidato;
 *   cancelados  anteriores, já com a marca;
 *   brutos      anteriores, sem marca: os candidatos antes da origem.
 */
function classificarPorCarimbo_(oficiais, loteId) {
  var carimbo = carimboDoLote_(loteId);
  var classes = { vieram: [], maisNovos: [], cancelados: [], brutos: [] };

  oficiais.forEach(function (m) {
    var proprio = String(m.lote_id || '');
    if (proprio === loteId) { classes.vieram.push(m); return; }
    if (carimboDoLote_(proprio) >= carimbo) { classes.maisNovos.push(m); return; }
    if (cadastroCancelado_(m)) { classes.cancelados.push(m); return; }
    classes.brutos.push(m);
  });

  return classes;
}

/**
 * O carimbo UTC que abre o id do lote ('20260921T220000000Z_a1b2c3' →
 * '20260921T220000000Z'). Largura fixa: comparar texto é comparar tempo.
 * Documento sem `lote_id` (inserido à mão) tem carimbo '' — anterior a tudo.
 */
function carimboDoLote_(id) {
  return String(id || '').split('_')[0];
}

/** A tela precisa saber DE ONDE o candidato veio, com o nome do arquivo. */
function resumoDoLote_(id, lote) {
  return {
    id: String(id || ''),
    arquivo: lote ? String(lote.arquivo || '') : '',
    importadoEm: lote ? String(lote.importado_em || '') : '',
    semestre: lote ? String(lote.semestre_cabecalho || '') : ''
  };
}

/**
 * A varredura de `inscricoes` — a ÚNICA fonte do que a revisão anula (ver
 * "Cancelar e Excluir" no cabeçalho), lida uma vez por chamada:
 *
 *   porMatricula   `varrerInscricoes_` (12_Disciplinas.gs), pela matrícula
 *                  normalizada da PRÓPRIA inscrição — a mesma igualdade
 *                  `matricula == X` de `inscricoesEmOutrosProjetos_` (04);
 *   porId          a mesma varredura, por id — é o que diz se a inscrição que
 *                  uma ficha aponta ainda está VIVA (a ficha é da última rodada
 *                  da reconciliação; a inscrição pode ter sido anulada depois).
 */
function varreduraDeInscricoes_(lidas) {
  var varredura = varrerInscricoes_(REVISAO_MAX_CRUZAMENTO);
  lidas.inscricoes += varredura.lidas;

  var porId = {};
  varredura.todas.forEach(function (i) { porId[i.id] = i; });

  return {
    porMatricula: varredura.porMatricula, porId: porId,
    lidas: varredura.lidas, truncado: Boolean(varredura.truncado)
  };
}

/**
 * As fichas de `alunos` da turma que apontam uma inscrição, por `matricula_id`
 * — só para a janela INFORMAR (`possiveisDe_`); `aplicarRevisao` não as lê,
 * porque elas não decidem nada. UMA consulta de igualdade pela turma (a ficha
 * copia a turma do matriculado), e não uma por candidato: cada ida custa
 * ~0,5 s e o painel dá 15 s a `revisarLote`.
 */
function fichasDaTurma_(turma, lidas) {
  var fichas = {};
  var itens = listar(ALUNOS_COLECAO, { campo: 'turma', valor: turma, limite: REVISAO_MAX_TURMA }).itens;
  lidas.fichas = (lidas.fichas || 0) + itens.length;
  itens.forEach(function (ficha) {
    var m = normalizarMatricula(ficha.matricula_id);
    if (!m || !ficha.inscricao_id) return;
    if (!Object.prototype.hasOwnProperty.call(fichas, m)) fichas[m] = [];
    fichas[m].push(ficha);
  });
  return fichas;
}

/**
 * As inscrições vivas de um matriculado: as que trazem a matrícula dele — e
 * SÓ elas. É esta lista que o Aplicar anula.
 */
function inscricoesDe_(varredura, m) {
  var chave = normalizarMatricula(m.matricula || m._id);
  if (!chave || !Object.prototype.hasOwnProperty.call(varredura.porMatricula, chave)) return [];

  return varredura.porMatricula[chave].map(function (i) {
    return {
      id: i.id,
      projetoId: i.projeto_id,
      projetoNome: i.projeto,
      emEspera: Boolean(i.em_espera),
      criadoEm: i.criado_em
    };
  });
}

/**
 * As inscrições que a reconciliação LIGOU ao matriculado sem que elas tragam a
 * matrícula dele — informação para a janela, nunca ação (ver o cabeçalho).
 *
 * Uma por ficha da turma com `matricula_id` dele: a inscrição apontada, se
 * ainda está viva e não tem esta matrícula (com ela, já está em
 * `inscricoesDe_` e VAI ser anulada — apontá-la de novo como "possível" seria
 * mentir). `casadaPor` é o degrau da cascata que ligou as duas ('E-mail',
 * 'Nome exato'...) e `status` diz se a própria cascata teve certeza
 * (CONFIRMADO) ou não (DIVERGENCIA). A ficha resolvida à mão como "não é a
 * mesma pessoa" fica de fora: SO_INSCRITO/SO_MATRICULADO com os dois ids só
 * nasce de `resolverAluno` (10_Painel.gs) — a cascata não produz isso —, e a
 * decisão humana manda.
 */
function possiveisDe_(varredura, fichas, m) {
  var chave = normalizarMatricula(m.matricula || m._id);
  if (!chave || !Object.prototype.hasOwnProperty.call(fichas, chave)) return [];

  var saida = [];
  var vistas = {};
  fichas[chave].forEach(function (ficha) {
    var status = String(ficha.status || '');
    if (status !== STATUS.CONFIRMADO && status !== STATUS.DIVERGENCIA) return;
    var apontada = varredura.porId[String(ficha.inscricao_id)];
    if (!apontada) return;
    if (normalizarMatricula(apontada.matricula) === chave) return;
    if (Object.prototype.hasOwnProperty.call(vistas, apontada.id)) return;
    vistas[apontada.id] = true;
    saida.push({
      id: apontada.id,
      projetoId: apontada.projeto_id,
      projetoNome: apontada.projeto,
      emEspera: Boolean(apontada.em_espera),
      casadaPor: String(ficha.metodo_match || 'reconciliação'),
      status: status
    });
  });
  return saida;
}

/**
 * Uma linha da janela. Sem `raw_json` — o payload do relatório repetido dentro
 * do documento engordaria a resposta sem acrescentar nada à decisão.
 */
function itemDaRevisao_(m, lote, inscricoes, possiveis) {
  return {
    matricula: m.matricula || m._id || '',
    matriculaOficial: m.matricula_oficial || '',
    nome: m.nome || '',
    curso: m.curso || '',
    turma: m.turma || '',
    situacao: m.situacao || '',
    telefone: m.telefone || '',
    email: m.email || '',
    importadoEm: m.importado_em || '',
    lote: lote,
    inscricoes: inscricoes,
    possiveis: possiveis || []
  };
}

function porNome_(a, b) {
  return chaveNome(a.nome).localeCompare(chaveNome(b.nome));
}

/** O JSON gravado no lote pela revisão anterior, ou null quando ilegível. */
function resumoDaRevisao_(bruto) {
  if (!bruto) return null;
  try {
    return JSON.parse(String(bruto));
  } catch (e) {
    return null;
  }
}

/**
 * A recusa comum às duas funções, ou '' quando o lote serve.
 *
 * PARCIAL recusa porque revisar uma importação que parou no meio apontaria como
 * "não veio" quem está no arquivo e não chegou a entrar. EXPURGADO porque não
 * há mais o que comparar.
 */
function recusaDoLote_(lote) {
  if (!lote) return 'Importação não encontrada. Recarregue a aba Importações.';
  if (lote.status === 'PARCIAL') {
    return 'Esta importação parou no meio (' + (lote.linhas || 0) + ' de ' + (lote.previstas || '?') +
           ' gravados). Confirme-a de novo com o mesmo arquivo e revise a importação nova — ' +
           'revisar esta apontaria como "não veio" quem está no arquivo.';
  }
  if (lote.status === 'EXPURGADO') return 'Esta importação já foi apagada; não há o que comparar.';
  return '';
}

// ------------------------------------------------------------ Escrita

/**
 * Aplica as decisões da janela de revisão. A ordem está no cabeçalho.
 *
 * payload: { token, loteId, turma, origemTurma?, decisoes: [{ matricula, acao }] }
 *   `acao`         'CANCELAR' ou 'EXCLUIR'; Manter não viaja;
 *   `origemTurma`  'LINHAS' quando a tela mostrou a turma deduzida das linhas —
 *                  só serve para rotular a turma que fica gravada num lote que
 *                  não tinha; qualquer outro valor vira INFORMADA.
 *
 * Fora de `SO_LEITURA`: não é repetida pelo painel, e a chave `idem` cobre a
 * resposta perdida acima de 32 s.
 */
function aplicarRevisao(payload) {
  // O que o `catch` precisa para a trilha parcial (ver o cabeçalho) fica FORA
  // do try, preenchido conforme os passos avançam: os contadores, e QUEM foi
  // tocado por ação. `var` dentro do try seria visível no catch, mas
  // `undefined` se a falha viesse antes da declaração — e a trilha não pode
  // depender de onde o passo morreu.
  var feito = { anuladas: 0, excluidos: 0, cancelados: 0, fichasApagadas: 0 };
  var passo = { quem: '', loteId: '', turma: '', lote: null, origemTurma: '',
    cancelar: [], excluir: [], pulados: [], jaCancelados: [], anuladas: [] };
  try {
    payload = payload || {};
    exigirAdmin(payload.token);
    var quem = passo.quem = quemMexeu_(payload.token);

    var loteId = passo.loteId = String(payload.loteId || '').trim();
    var turma = passo.turma = normalizarTurma(payload.turma).slice(0, TURMA_CABECALHO_MAX);
    passo.origemTurma = payload.origemTurma;
    if (!loteId || !turma) return { ok: false, erro: 'Faltou a importação ou a turma da revisão.' };

    var decisoes = decisoesDoPayload_(payload.decisoes);
    if (!decisoes.ok) return decisoes;
    decisoes = decisoes.lista;

    // 1. O lote.
    var lote = passo.lote = ler(LOTES_COLECAO, loteId);
    var recusa = recusaDoLote_(lote);
    if (recusa) return { ok: false, erro: recusa };

    // 2. A releitura: UMA consulta, e cada decisão conferida contra o agora.
    var oficiais = {};
    listar(MATRICULADOS_COLECAO, { campo: 'turma', valor: turma, limite: REVISAO_MAX_TURMA })
      .itens.forEach(function (m) { oficiais[m._id] = m; });

    var carimbo = carimboDoLote_(loteId);
    var pulados = passo.pulados;
    var jaCancelados = passo.jaCancelados;
    var cancelar = passo.cancelar;
    var excluir = passo.excluir;

    decisoes.forEach(function (d) {
      var doc = Object.prototype.hasOwnProperty.call(oficiais, d.matricula) ? oficiais[d.matricula] : null;
      if (!doc) {
        pulados.push({ matricula: d.matricula, motivo: 'já não consta como ' + turma +
          ' (reimportado com outra turma, editado ou excluído)' });
        return;
      }
      if (carimboDoLote_(doc.lote_id) >= carimbo) {
        pulados.push({ matricula: d.matricula, motivo: 'voltou numa importação igual ou mais nova' });
        return;
      }
      // Já cancelado: nenhuma ação, seja qual for a pedida (ver `jaCancelados`
      // no cabeçalho) — a inscrição que ele tem hoje é deliberada.
      if (cadastroCancelado_(doc)) { jaCancelados.push(doc); return; }
      (d.acao === 'EXCLUIR' ? excluir : cancelar).push(doc);
    });

    if (!cancelar.length && !excluir.length) {
      return {
        ok: true,
        cancelados: 0, excluidos: 0, anuladas: 0, fichasApagadas: 0,
        jaCancelados: jaCancelados.length,
        pulados: pulados,
        mensagem: 'Nada a fazer: ' + (jaCancelados.length
          ? 'já estava feito.'
          : 'a lista da tela é de antes — recarregue a revisão.')
      };
    }

    // 3. As inscrições a anular — descobertas AGORA (ver o cabeçalho), pela
    // varredura e só por ela, de quem vai ser tocado. Quem foi PULADO ou já
    // estava cancelado não entra: um fica com a inscrição porque voltou na
    // lista, o outro porque a dele é deliberada. Cada uma leva a matrícula e o
    // projeto, que é o que a trilha parcial precisa para dizer de quem era.
    var varredura = varreduraDeInscricoes_({ inscricoes: 0 });
    if (varredura.truncado) {
      return {
        ok: false,
        erro: 'A varredura de inscrições foi cortada em ' + varredura.lidas + ' — não dá para ' +
              'garantir que toda inscrição dos alunos marcados seria anulada, e cancelar sem ' +
              'liberar a vaga não é uma opção. Nada foi feito.'
      };
    }
    var aAnular = [];
    var idsAnular = [];
    cancelar.concat(excluir).forEach(function (doc) {
      inscricoesDe_(varredura, doc).forEach(function (i) {
        if (idsAnular.indexOf(i.id) !== -1) return;
        idsAnular.push(i.id);
        aAnular.push({ matricula: doc._id, id: i.id, projetoId: i.projetoId, projetoNome: i.projetoNome });
      });
    });
    if (idsAnular.length > AUDITORIO_LOTE_MAXIMO) {
      return {
        ok: false,
        erro: idsAnular.length + ' inscrições a anular de uma vez; o teto é ' + AUDITORIO_LOTE_MAXIMO +
              ' e nada foi feito — divida a revisão.'
      };
    }

    // 4. Anular PRIMEIRO. Reuso inteiro: relê, copia, apaga, loga. A recusa
    // de lá já vem sem o caminho do documento, e passa por `fraseSegura_` de
    // novo antes de sair — nenhum texto de erro sai cru daqui.
    if (idsAnular.length) {
      var an = anularInscricoes({ token: payload.token, ids: idsAnular });
      if (!an.ok) {
        return {
          ok: false, anuladas: 0, cancelados: 0, excluidos: 0, fichasApagadas: 0,
          erro: 'A anulação das inscrições falhou e nada mais foi feito: ' + fraseSegura_(an.erro)
        };
      }
      feito.anuladas = an.anuladas;
      // As anuladas DE FATO: a que já não existia (anulada à mão entre a
      // varredura e agora) não pode aparecer como "anulada antes da recusa".
      var anuladas = an.ids || [];
      passo.anuladas = aAnular.filter(function (a) { return anuladas.indexOf(a.id) !== -1; });
    }

    var carimboAgora = agora();

    // 5. EXCLUIR: cópia → apaga → fichas órfãs.
    if (excluir.length) {
      escreverEmLote(MATRICULADOS_EXCLUIDOS_COLECAO, excluir.map(function (doc) {
        var copia = {};
        Object.keys(doc).forEach(function (k) { copia[k] = doc[k]; });
        copia.excluido_em = carimboAgora;
        copia.excluido_por = quem;
        copia.excluido_lote_id = loteId;
        return copia;
      }));
      // Apaga o documento RELIDO (a versão vai junto): reescrito no meio tempo
      // por uma reimportação, o delete é recusado e a cópia acima fica sobrando
      // — nunca uma pessoa a menos.
      feito.excluidos = excluirEmLote(MATRICULADOS_COLECAO, excluir.map(function (doc) {
        return { _id: doc._id, _versao: doc._versao };
      }));
      feito.fichasApagadas = apagarFichasOrfas_(excluir, idsAnular);
    }

    // 6. CANCELAR: o patch em lote — exatamente quatro campos, e a versão
    // relida como precondição (ver "A ordem do Aplicar").
    if (cancelar.length) {
      feito.cancelados = atualizarEmLote(MATRICULADOS_COLECAO, cancelar.map(function (doc) {
        return {
          _id: doc._id,
          _versao: doc._versao,
          situacao_cadastro: 'CANCELADO',
          cancelado_em: carimboAgora,
          cancelado_por: quem,
          cancelado_lote_id: loteId
        };
      }));
    }

    // 7. O lote.
    marcarLoteRevisado_(passo, feito, carimboAgora, '');

    // 8. A trilha: matrículas por ação, sem nome.
    registrar('LOTE_REVISADO', 'lote', loteId, detalheDaTrilha_(passo, feito, ''));

    // 9. Os números do Painel e o freio do Atualizar: cancelar não muda contagem
    // nenhuma, e sem isto a próxima rodada leria "nada mudou".
    invalidarCachePainel_();
    esquecerMarcaDaReconciliacao_();

    return {
      ok: true,
      cancelados: feito.cancelados,
      excluidos: feito.excluidos,
      anuladas: feito.anuladas,
      fichasApagadas: feito.fichasApagadas,
      jaCancelados: jaCancelados.length,
      pulados: pulados,
      precisaReconciliar: true,
      // Só o que os números não dizem: os pulados, agrupados pelo motivo.
      mensagem: mensagemDosPulados_(pulados)
    };
  } catch (err) {
    var frase = fraseSegura_(err);
    console.error('aplicarRevisao: ' + frase);

    var resposta = {
      ok: false,
      erro: frase,
      anuladas: feito.anuladas,
      excluidos: feito.excluidos,
      cancelados: feito.cancelados,
      fichasApagadas: feito.fichasApagadas,
      parcial: parcialDaRevisao_(passo, feito),
      avisos: []
    };

    // A trilha parcial (ver o cabeçalho): só quando algo JÁ foi escrito. A
    // recusa antes da primeira escrita não é revisão e não deixa linha.
    if (feito.anuladas || feito.excluidos || feito.cancelados) {
      resposta.avisos = avisosDoParcial_(resposta.parcial);
      try {
        marcarLoteRevisado_(passo, feito, agora(), 'PARCIAL');
        registrar('LOTE_REVISADO_PARCIAL', 'lote', passo.loteId, detalheDaTrilha_(passo, feito, frase));
        invalidarCachePainel_();
        esquecerMarcaDaReconciliacao_();
      } catch (e) {
        // A trilha que falhou não pode esconder a falha original: a resposta
        // já diz o que foi feito, nominalmente.
        console.error('aplicarRevisao (trilha parcial): ' + fraseSegura_(e));
      }
    }
    return resposta;
  }
}

/**
 * A marca do lote (revisado_em/por/turma/resumo; e a turma, se o lote não
 * tinha). Em try/catch como a marca de `expurgarLote`: os alunos já foram
 * tocados, e um patch que falhou não pode virar "falhou" na tela.
 *
 * `situacao` é '' na revisão inteira e 'PARCIAL' na interrompida — é o que a
 * aba Importações e a janela leem para dizer "interrompida".
 */
function marcarLoteRevisado_(passo, feito, carimbo, situacao) {
  var resumo = {
    cancelados: feito.cancelados, excluidos: feito.excluidos, anuladas: feito.anuladas,
    pulados: passo.pulados.length, ja_cancelados: passo.jaCancelados.length
  };
  if (situacao) resumo.situacao = situacao;
  try {
    var marca = {
      revisado_em: carimbo,
      revisado_por: passo.quem,
      revisao_turma: passo.turma,
      revisao_resumo: JSON.stringify(resumo)
    };
    if (!passo.lote.turma_cabecalho) {
      marca.turma_cabecalho = passo.turma;
      marca.turma_origem = passo.origemTurma === 'LINHAS' ? 'LINHAS' : 'INFORMADA';
    }
    atualizar(LOTES_COLECAO, passo.loteId, marca);
  } catch (e) {
    console.error('aplicarRevisao (marca do lote): ' + fraseSegura_(e));
  }
}

/**
 * A linha da trilha: turma, contagens e as MATRÍCULAS por ação (números, sem
 * nome — decisão de 21/09; o precedente é `registrarEdicao_`, 10_Painel.gs).
 *
 * QUEM revisou não vem mais no fim da frase: é a coluna `usuario` da linha,
 * preenchida pelo operador que `exigirAdmin` anota (04_Log.gs). `passo.quem`
 * continua sendo lido porque ele vira `cancelado_por`, `excluido_por` e a marca
 * do lote NOS DOCUMENTOS — que a tela de Importações mostra e que sobrevivem ao
 * ano de retenção do log.
 *
 * As matrículas de cancelados e excluídos só entram quando o passo deles
 * ENTROU (o patch e o delete são um `:commit` cada, tudo ou nada). As das
 * anuladas só entram na linha PARCIAL: na inteira elas são as mesmas dos
 * cancelados/excluídos; na interrompida são justamente as que ficaram sem a
 * marca, e a trilha é o único lugar que diz quais.
 */
function detalheDaTrilha_(passo, feito, interrompido) {
  var anuladas = feito.anuladas + ' inscrição(ões) anulada(s)';
  if (interrompido) {
    anuladas += ' [' + passo.anuladas.map(function (a) { return a.matricula; }).join(',') + ']';
  }
  return passo.turma + ': ' +
    feito.cancelados + ' cancelado(s) [' + (feito.cancelados ? matriculasDe_(passo.cancelar) : '') + '], ' +
    feito.excluidos + ' excluído(s) [' + (feito.excluidos ? matriculasDe_(passo.excluir) : '') + '], ' +
    anuladas + ', ' +
    passo.pulados.length + ' pulado(s), ' + passo.jaCancelados.length + ' já cancelado(s)' +
    (feito.fichasApagadas ? ', ' + feito.fichasApagadas + ' ficha(s) apagada(s)' : '') +
    (interrompido ? '; INTERROMPIDO: ' + interrompido : '');
}

/** O que JÁ foi feito, nominalmente: quem perdeu a inscrição (e em qual projeto), quem saiu, quem ganhou a marca. */
function parcialDaRevisao_(passo, feito) {
  return {
    anuladas: passo.anuladas.slice(),
    excluidos: feito.excluidos ? passo.excluir.map(function (d) { return d._id; }) : [],
    cancelados: feito.cancelados ? passo.cancelar.map(function (d) { return d._id; }) : []
  };
}

/** As frases da resposta interrompida — é por elas que a coordenação sabe quem reincluir. */
function avisosDoParcial_(parcial) {
  var avisos = parcial.anuladas.map(function (a) {
    return 'A inscrição de ' + a.matricula + ' (' + (a.projetoNome || a.projetoId) + ') foi anulada antes da ' +
      'recusa — se a pessoa continua na lista, Alunos → Incluir aluno a devolve.';
  });
  if (parcial.excluidos.length) {
    avisos.push(parcial.excluidos.join(', ') + ' foi/foram excluído(s) antes da recusa (cópia em matriculados_excluidos).');
  }
  if (parcial.cancelados.length) {
    avisos.push(parcial.cancelados.join(', ') + ' foi/foram cancelado(s) antes da recusa.');
  }
  return avisos;
}

/**
 * As decisões do payload, normalizadas e recusadas em bloco.
 *
 * Recusa INTEIRA a qualquer defeito — ação desconhecida, matrícula vazia ou
 * repetida, mais decisões que o teto —, e antes de qualquer leitura: uma lista
 * meio aplicada é a que ninguém sabe se pode reaplicar.
 */
function decisoesDoPayload_(brutas) {
  if (!Array.isArray(brutas) || !brutas.length) return { ok: false, erro: 'Nada marcado.' };
  if (brutas.length > REVISAO_LOTE_MAXIMO) {
    return {
      ok: false,
      erro: 'Vieram ' + brutas.length + ' decisões e o lote é de no máximo ' + REVISAO_LOTE_MAXIMO +
            ' — nada foi feito.'
    };
  }

  var vistas = {};
  var lista = [];
  for (var i = 0; i < brutas.length; i++) {
    var d = brutas[i] || {};
    var acao = String(d.acao || '').toUpperCase();
    var matricula = normalizarMatricula(d.matricula);
    if (REVISAO_ACOES.indexOf(acao) === -1) {
      return { ok: false, erro: 'Ação desconhecida na linha ' + (i + 1) + ': "' + String(d.acao || '').slice(0, 20) + '".' };
    }
    if (!matricula) return { ok: false, erro: 'A linha ' + (i + 1) + ' veio sem matrícula.' };
    if (Object.prototype.hasOwnProperty.call(vistas, matricula)) {
      return { ok: false, erro: 'A matrícula ' + matricula + ' aparece duas vezes.' };
    }
    vistas[matricula] = true;
    lista.push({ matricula: matricula, acao: acao });
  }
  return { ok: true, lista: lista };
}

/**
 * Apaga em `alunos` a ficha de quem foi EXCLUÍDO e ficou sem origem nenhuma.
 *
 * A ficha é achada por `matricula_id`, e NÃO por `chaveAluno_('mat:' + m)`: para
 * quem tem inscrição, o id da ficha vem da INSCRIÇÃO (06_Reconciliacao.gs), e
 * o endereço derivado da matrícula não acha ninguém. Ela sai quando não tem
 * `inscricao_id`, ou quando a inscrição dela acabou de ser anulada; com uma
 * inscrição que ficou viva (a ficha de turma velha, que o cruzamento por turma
 * não viu), a ficha fica — a rodada seguinte a recalcula como SO_INSCRITO.
 *
 * É uma consulta POR excluído (e não a de `cruzamentoDaTurma_`, pela turma):
 * excluídos são poucos, e a ficha com turma velha é justamente a que a consulta
 * pela turma não alcança.
 *
 * `planejarRemocoes_` (06) não serve aqui: o teto de 100 remoções por rodada é
 * o que deixa fichas órfãs para sempre depois de um expurgo grande.
 */
function apagarFichasOrfas_(excluidos, idsAnulados) {
  var ids = [];
  excluidos.forEach(function (doc) {
    var m = normalizarMatricula(doc.matricula || doc._id);
    if (!m) return;
    listar(ALUNOS_COLECAO, { campo: 'matricula_id', valor: m, limite: 5 }).itens.forEach(function (ficha) {
      var inscricao = String(ficha.inscricao_id || '');
      if (!inscricao || idsAnulados.indexOf(inscricao) !== -1) ids.push(ficha._id);
    });
  });
  return ids.length ? excluirEmLote(ALUNOS_COLECAO, ids) : 0;
}

function matriculasDe_(docs) {
  return docs.map(function (doc) { return doc._id; }).join(',');
}

/** "2 pulado(s): 9110007 — voltou numa importação igual ou mais nova; ..." ou ''. */
function mensagemDosPulados_(pulados) {
  if (!pulados.length) return '';
  var porMotivo = {};
  var ordem = [];
  pulados.forEach(function (p) {
    if (!Object.prototype.hasOwnProperty.call(porMotivo, p.motivo)) { porMotivo[p.motivo] = []; ordem.push(p.motivo); }
    porMotivo[p.motivo].push(p.matricula);
  });
  return pulados.length + ' pulado(s), não tocado(s): ' + ordem.map(function (motivo) {
    return porMotivo[motivo].join(', ') + ' — ' + motivo;
  }).join('; ') + '.';
}

/**
 * A frase que pode ir para o log de execução e para a tela.
 *
 * A mensagem do Firestore num `:commit` recusado traz o caminho do documento —
 * 'No document to update: projects/.../matriculados/9110001', 'the stored
 * version (...) does not match ... for projects/.../matriculados/9110001' —, e
 * o caminho É a matrícula. NOT_FOUND (sumiu) e FAILED_PRECONDITION (foi
 * reescrito: a precondição de versão do patch e do delete) no meio de um
 * Aplicar significam uma coisa só, e ela é dita com uma frase fixa; qualquer
 * outra mensagem perde o caminho antes de sair daqui (`semCaminhoDeDocumento_`,
 * 02_Repo.gs — a régua é uma só, e mora ao lado de quem monta a mensagem).
 * Aceita o Error ou só o texto (a recusa de `anularInscricoes` é texto).
 */
function fraseSegura_(err) {
  var status = String((err && err.status) || '');
  if (status === 'NOT_FOUND' || status === 'FAILED_PRECONDITION') {
    return 'A lista da tela é de antes: alguém foi reimportado ou excluído no meio tempo. ' +
           'Este passo não foi aplicado — recarregue a revisão.';
  }
  return semCaminhoDeDocumento_(err);
}
