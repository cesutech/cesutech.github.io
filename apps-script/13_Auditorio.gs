/**
 * 13_Auditorio.gs — as ferramentas do dia do evento.
 *
 * Este arquivo existe por causa de uma data: até setembro a matrícula NÃO pode
 * ser conferida contra a lista oficial. Aluno novo ainda aparece, e a emissão
 * atrasa; ligar a validação hoje recusaria gente de verdade. Enquanto isso
 * qualquer pessoa se inscreve com uma matrícula inventada e ocupa vaga.
 *
 * O dano que importa não é o dado sujo — é o aluno de verdade que chega no
 * auditório, lê "esgotado", dá meia-volta e não volta mais. Duas peças respondem
 * a isso, e as duas são a mesma ideia por lados opostos:
 *
 *   FILA DE ESPERA (09_Projetos.gs + 04_Inscricoes.gs) — ninguém é recusado por
 *   esgotado quando `vagas_excedentes_em_espera` está em SIM: a inscrição entra
 *   marcada, sem ocupar vaga.
 *
 *   ANULAR / RESTAURAR / PROMOVER (aqui) — a coordenação tira o lixo, e a fila
 *   entra no lugar que abriu. Sem a promoção, anular só devolveria vagas vazias e
 *   quem ficou na espera continuaria na espera: o conserto seria pela metade.
 *
 * São cinco funções, e as cinco pedem token (`exigirAdmin` na primeira linha) e
 * estão na lista branca de `funcoesDoPainel_` (08_Api.gs):
 *
 *   inscricoesRecentes   as últimas que chegaram — é onde se reconhece o lixo
 *   filaDeEspera         quem espera, em ordem de chegada, e o que cabe em cada
 *                        projeto
 *   anularInscricoes     tira do cadastro, guardando cópia
 *   restaurarInscricoes  devolve, conferindo vaga
 *   promoverDaEspera     tira da fila e ocupa a vaga de verdade
 *
 * As duas primeiras só LEEM; as três últimas gravam, e por isso recebem ids
 * EXPLÍCITOS: quem apaga e quem promove precisa ter visto quem está na lista. Um
 * filtro que o servidor resolvesse sozinho ("anule tudo que parece inventado")
 * agiria sobre o que a tela não mostrou.
 *
 * ------------------------------------------------------ O que NÃO se faz aqui
 *
 * 1. NÃO SE PEGA O LOCK PARA ANULAR. É o mesmo `getScriptLock()` por onde passa a
 *    inscrição de cada aluno; segurá-lo para fazer limpeza é parar a fila do
 *    auditório para varrer o chão. E não é preciso: apagar só LIBERA vaga, e quem
 *    decide vaga é `reservarVaga`, que conta DEPOIS, lá dentro. O pior que a
 *    concorrência produz aqui é uma vaga que aparece um instante depois.
 *
 *    PROMOVER é o contrário: ela OCUPA vaga, então conta e escreve dentro do
 *    lock, como `reservarVaga`. Uma vez para o lote inteiro — cem `waitLock`
 *    seguidos no meio do evento é o que trava a inscrição do aluno.
 *
 * 2. NÃO SE ORDENA POR UM CAMPO E FILTRA POR OUTRO. Isso exige índice composto,
 *    devolve `400 The query requires an index` e cobra um passo de console em
 *    cada ambiente novo — descoberto no pior dia possível. Aqui a consulta leva
 *    UM campo (ordenação OU filtro), e o resto é feito em JavaScript, sobre
 *    poucos documentos. Nem `__name__` DESC: o índice automático de `__name__` só
 *    cobre ascendente (a cicatriz está em `ultimosRegistros`, 04_Log.gs).
 *
 * 3. NÃO SE PAGINA POR CURSOR. A janela das inscrições é UMA consulta, e quando
 *    ela vem cheia a resposta confere o `total` do banco antes de dizer
 *    `truncada` — cheia na medida não é cortada. As duas paginações possíveis
 *    perdem alguma coisa, cada uma do seu jeito:
 *
 *    por `criado_em`, o cursor recomeça ESTRITAMENTE depois do último valor lido
 *    (`fsCursor_` monta `startAt` com `before: false`, 02_Repo.gs) e `agora()`
 *    grava com resolução de SEGUNDO (01_Utils.gs) — duas inscrições do mesmo
 *    segundo na virada da página, e a segunda fica de fora, calada. A cicatriz
 *    já está escrita: `reconciliar` (06_Reconciliacao.gs) pagina por `__name__`
 *    e ordena na memória exatamente por causa disso;
 *
 *    por `__name__`, a paginação é exata e a ORDEM deixa de ser a de chegada: o
 *    id é `hash(...)` (`chaveDedup_`, 04_Inscricoes.gs), então "as últimas que
 *    chegaram" viraria "as primeiras do alfabeto do hash".
 *
 *    Truncar DIZENDO que truncou é o menor dos três males: a coordenação vê que
 *    a lista não é a lista inteira e recorta a busca. Cortar calado é o que faz
 *    alguém procurar um aluno que está no banco, não achar, e concluir errado.
 *
 * ------------------------------------------------------------- A quarentena
 *
 * Anular COPIA para `inscricoes_anuladas` e só então apaga de `inscricoes`.
 * A ordem é o desenho inteiro: morrer entre a cópia e a exclusão deixa uma
 * duplicata — inofensiva, e `restaurarInscricoes` a limpa. A ordem inversa
 * perderia a inscrição de um aluno de verdade num clique errado, e não existe
 * desfazer para isso.
 *
 * O id do documento é preservado na quarentena. É o que torna restaurar uma
 * operação sem adivinhação: o id É a chave de dedup (`chaveDedup_`,
 * 04_Inscricoes.gs), então voltar com o mesmo id é voltar para o mesmo lugar, e
 * uma segunda restauração esbarra no 409 do banco em vez de duplicar a pessoa.
 *
 * ------------------------------------ A quarentena tem TRÊS produtores (22/09)
 *
 * Esta coleção deixou de ser só desta aba. Escrevem nela:
 *
 *   esta aba ............. `anulado_por` = o e-mail de quem clicou;
 *   a revisão de divergências (05c_Revisao.gs, que chama `anularInscricoes`)
 *                          ..... o e-mail de quem aplicou a revisão;
 *   O PRÓPRIO ALUNO, pela troca de projeto (04_Inscricoes.gs, com
 *   `aluno_projeto_unico` em SIM) ..... `anulado_por` = 'aluno', uma SENTINELA
 *                          que não é endereço de ninguém, mais `anulado_motivo`
 *                          = 'TROCA' e `trocado_para` = o id da inscrição nova.
 *
 * A cópia da troca é UPSERT SEM PRECONDIÇÃO, de propósito: `criar`
 * (`exists:false`) faria o `:commit` inteiro voltar ALREADY_EXISTS quando a
 * coordenação já tivesse anulado aquela inscrição, e o aluno receberia "você já
 * estava inscrito" sem que a inscrição nova existisse.
 *
 * DOIS SENTIDOS DE INTERCALAÇÃO, e os dois são de TRILHA, nunca do aluno:
 *
 *   (i) a troca comita primeiro — a coordenação (ou a revisão) grava a cópia
 *       dela por cima, e `escreverEmLote` é update SEM `updateMask`, isto é,
 *       substituição inteira: `anulado_motivo` e `trocado_para` somem, e o
 *       `excluirEmLote` seguinte apaga o que já não existe (no-op de 200) e
 *       relata "anulada" uma inscrição que ele não tirou;
 *  (ii) a coordenação anula primeiro — a cópia da troca sobrescreve a dela, e a
 *       marca de QUEM anulou se perde.
 *
 * Nos dois sentidos o ALUNO fica correto: ele está no projeto novo, e restaurar
 * recusa devolver a inscrição antiga enquanto ele estiver em outro projeto ativo
 * (ver `restaurarUma_`). A cópia órfã que sobra o próprio `restaurarInscricoes`
 * cura sozinho, tratando-a como `jaEstavam`. O que se perde é a TRILHA — e é por
 * isso que a linha `INSCRICAO_TROCADA` do log (04_Inscricoes.gs) deixou de ser
 * redundante e passou a ser a ÚNICA prova durável da troca.
 *
 * REGRA OPERACIONAL que sai daí: não rodar a Revisão de divergências com a
 * janela de inscrição aberta. É a janela de "segundos a minutos" entre a
 * releitura e o apaga (05c_Revisao.gs) que transforma a intercalação de caso
 * raro em caso provável.
 *
 * `anularInscricoes` NÃO foi convertida para `escreverAtomico`, e continua
 * passando ids CRUS ao `excluirEmLote`: com versão, um único documento mexido
 * derrubaria o lote de 200 DEPOIS de as cópias já terem sido escritas, deixando
 * cópias órfãs numa coleção que o painel não lista em lugar nenhum — e, dentro
 * de `aplicarRevisao`, recusaria a revisão inteira no passo 4. Trocar um caso
 * raro de trilha perdida por uma recusa total com lixo invisível é o negócio
 * errado.
 */

/**
 * Quarentena: o que foi anulado, com o id original preservado.
 *
 * TRÊS produtores escrevem aqui (esta aba, a revisão de divergências e o próprio
 * aluno pela troca de projeto) e a cópia de cada um traz marcas diferentes — ver
 * o cabeçalho do arquivo, que também descreve o que a intercalação entre eles
 * custa e o que ela não custa.
 */
var INSCRICOES_ANULADAS_COLECAO = 'inscricoes_anuladas';

/**
 * Teto de ESCRITA: quantos ids as três que gravam aceitam de uma vez.
 *
 * 200, e não "quantos vierem": cada id custa de uma a duas leituras e uma
 * escrita, a execução do Apps Script morre aos 6 minutos e o plano gratuito dá
 * 20 mil escritas por dia. Um lote sem teto falharia no meio — que é o único
 * jeito de a quarentena ficar com metade do serviço feito.
 *
 * Nunca teve a ver com quantas linhas a tela mostra. LER é barato e não corre
 * contra o relógio da execução; quem manda na leitura é
 * `AUDITORIO_RECENTES_MAXIMO`. Confundir os dois foi o defeito que fazia a tela
 * marcar 500 linhas para o servidor tratar 200 delas e relatar sucesso.
 *
 * E ELE VIAJA: as duas leituras da aba devolvem este número em `lote_maximo`.
 * Sem isso a tela não tem como saber onde a recusa começa — ela ofereceria
 * "Anular as 300 marcadas", a pessoa clicaria, e a resposta seria um erro que
 * ninguém tinha como prever antes do clique. Um número combinado de cabeça nos
 * dois lados é o mesmo defeito com um passo a mais: o dia em que este teto
 * mudar, só um dos lados muda junto.
 */
var AUDITORIO_LOTE_MAXIMO = 200;

/** Quantas inscrições recentes a tela pede quando não diz. */
var AUDITORIO_RECENTES_PADRAO = 50;

/**
 * Teto de LEITURA: o tamanho máximo da janela de inscrições recentes.
 *
 * A conta, para 1000 não ser um número redondo escolhido no olho:
 *
 *   TAMANHO. São 275 inscrições hoje. Uma janela de inscrição vale 5 projetos ×
 *   60 vagas = 300 confirmados, mais a fila de espera. 500 seria atravessado
 *   pela janela seguinte — a lista voltaria a esconder gente, que é justamente o
 *   defeito que este teto existe para não repetir. 1000 cobre duas janelas.
 *
 *   CUSTO. Uma abertura da aba são DUAS chamadas, e cada uma é uma execução
 *   separada — o cache de `config()` não atravessa de uma para a outra. A conta,
 *   linha por linha do que o código realmente pede:
 *
 *     inscricoesRecentes (o painel pede sempre no talo, 1000)
 *       `exigirAdmin` ................ 0   (a sessão vive em ScriptProperties)
 *       a janela ..................... uma leitura por inscrição que couber
 *       o `total` .................... 1 agregação, e SÓ com a janela cheia
 *
 *     filaDeEspera
 *       `exigirAdmin` ................ 0
 *       a fila ....................... uma leitura por quem espera (teto 500)
 *       a coleção de projetos ........ 5 hoje (vêm todos, ativos e inativos)
 *       a configuração ............... 1 (`contar_ocupacao_na_lista`)
 *       as contagens ................. 2 agregações por projeto ATIVO com a
 *                                      fila ligada — o total e a espera —, 10
 *                                      hoje; projeto que só aparece na fila
 *                                      custa 1 leitura e 2 agregações à parte
 *
 *   Hoje, com 275 inscrições: 275 + 16, mais uma leitura por pessoa na fila.
 *   Com a janela cheia: 1000 + 1 + 16, mais a fila — ~1.017 se ela estiver
 *   vazia, ~1.517 se ela estiver no teto de 500.
 *
 *   A cota gratuita é de 50.000 leituras por dia, das quais o backup já leva
 *   10.650 e a reconciliação 5.500 — sobram 33.850. E a aba se recarrega ao fim
 *   de CADA anular e de CADA promover: um mutirão de 20 remoções são 21
 *   aberturas — ~6.100 leituras hoje (291 cada, com a fila curta), e ~31.900 no
 *   pior caso previsto, de janela cheia e fila no teto (1.517 cada). O primeiro
 *   número é confortável; o segundo cabe raspando, e é ele que diz que o dia de
 *   recarregar a aba inteira a cada clique acaba quando o evento passar de mil
 *   inscrições.
 */
var AUDITORIO_RECENTES_MAXIMO = 1000;

/**
 * Teto da fila lida de uma vez.
 *
 * A fila inteira cabe numa tela de conferência; 500 é folga de três vezes o
 * auditório. Quando a consulta volta cheia, `filaDeEspera` diz `truncada: true` —
 * uma fila cortada em silêncio faria a coordenação promover "os primeiros" de uma
 * lista que não é a lista.
 */
var AUDITORIO_FILA_MAXIMA = 500;

// ------------------------------------------------------------ Consulta

/**
 * As últimas inscrições, da mais nova para a mais velha.
 *
 * Ordena por `criado_em` DESC — campo de verdade, largura fixa, índice automático
 * de campo único, exatamente como `ultimosRegistros` (04_Log.gs) faz com o log.
 *
 * UMA consulta, sem cursor, no teto de `AUDITORIO_RECENTES_MAXIMO` — o porquê de
 * não paginar está no cabeçalho.
 *
 * A janela CHEIA é SUSPEITA de corte, e não prova dele: mil no banco com mil
 * pedidas enche a janela sem deixar ninguém de fora. Quem confirma é o `total`
 * da coleção — que a janela cheia já paga de qualquer jeito, então a conferência
 * não custa uma leitura a mais —, e `truncada: true` só sai quando ele é MAIOR
 * que o que veio. Com a janela folgada a agregação nem roda: `lidas` já É o
 * total, e contá-lo seria leitura paga para repetir um número que a tela tem.
 *
 * Sem esse par, procurar alguém que ficou fora da janela devolve "não achei",
 * que é indistinguível de "não existe" — e foi assim que 275 inscrições couberam
 * numa tela de 200 sem ninguém perceber. O erro tem dois lados, e o outro é esta
 * função dizendo "faltam as mais antigas" quando não falta nenhuma: quem lê essa
 * frase vai procurar na aba Alunos alguém que estava na tela o tempo todo, e
 * desiste achando que o sistema perdeu a inscrição.
 *
 * O filtro por projeto acontece DEPOIS, em JavaScript, e a consequência precisa
 * ficar dita: ele corta o que o teto já trouxe. Pedir a janela e ver 12 de um
 * projeto não é defeito — é o que "as 12 mais recentes DENTRO da janela"
 * significa. O painel não manda mais `projeto_id`: recebe a janela inteira e
 * filtra no navegador, onde o filtro é de graça e não custa uma leitura por
 * clique. O parâmetro fica de pé para quem ainda o mandar — filtrar no servidor
 * é que custaria índice composto (ver o cabeçalho).
 */
function inscricoesRecentes(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var limite = tetoDaLeitura_(payload.limite, AUDITORIO_RECENTES_PADRAO);
    var lidas = listar(INSCRICOES_COLECAO, {
      ordenarPor: 'criado_em',
      direcao: 'DESC',
      limite: limite
    }).itens;

    var alvo = String(payload.projeto_id || '').trim();
    var itens = alvo
      ? lidas.filter(function (i) { return String(i.projeto_id || '') === alvo; })
      : lidas;

    // Contra o limite PEDIDO, e não contra o teto global: quem pede 50 e recebe
    // 50 está vendo uma janela cheia, ainda que o teto fosse 1000. Comparar com
    // o teto diria `truncada: false` para a tela que mais esconde gente.
    var cheia = lidas.length >= limite;

    // A janela cheia paga a agregação; a folgada não pergunta nada. `null` é a
    // terceira resposta — "não perguntei" ou "perguntei e não veio" —, e ela é
    // diferente de zero.
    var total = cheia ? totalDeInscricoes_() : null;

    // Cheia não é cortada. Com o total na mão, quem decide é ele: 1000 no banco
    // e 1000 na tela é uma janela que encheu na medida, e anunciar corte aí
    // manda a coordenação procurar em Alunos gente que já está aqui. Sem o total
    // (a agregação falhou), a suspeita fica de pé — dizer "está tudo aqui" sem
    // ter conferido é a promessa que ninguém pode fazer.
    var truncada = cheia && (total === null || total > lidas.length);

    var resposta = {
      ok: true,
      lidas: lidas.length,
      truncada: truncada,
      // O teto da ESCRITA, para a tela não oferecer um lote que estas três
      // recusam — ver `AUDITORIO_LOTE_MAXIMO`.
      lote_maximo: AUDITORIO_LOTE_MAXIMO,
      inscricoes: itens.map(resumoParaAuditorio_)
    };
    // Só acompanha o corte: com `truncada: false` o total é `lidas`, e mandá-lo
    // seria um segundo número dizendo a mesma coisa. Ausente, a tela trata (ela
    // já tem o caso do servidor calado — ver `rodapeDeRecentes`, no painel).
    if (truncada && total !== null) resposta.total = total;

    return resposta;
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Quantas inscrições existem no banco — ou `null` quando a conta não veio.
 *
 * É UMA SEGUNDA IDA À REDE, e o `try` daqui existe por causa disso. Quando esta
 * função é chamada, a janela JÁ FOI LIDA e está na memória — até mil linhas, que
 * são a tela com que a coordenação reconhece o lixo e anula. Deixar a agregação
 * dentro do `try` de `inscricoesRecentes` fazia o `catch` de lá responder
 * `ok: false` e jogar as mil fora: a tela inteira do evento morria por causa do
 * número do rodapé, que é a informação menos importante da resposta. E ela falha
 * por conta própria — cota de leitura estourada, 503 do Firestore, a execução
 * esbarrando nos 6 minutos —, sem nada de errado com a consulta que deu certo.
 *
 * Sem o total a resposta sai completa e mais modesta: as linhas vão, `total` não
 * vai, e `truncada` continua dizendo a suspeita em vez de uma certeza que ninguém
 * conferiu. O `console.error` fica porque uma falha silenciosa aqui é
 * indistinguível de uma janela folgada quando alguém for ler o log depois.
 */
function totalDeInscricoes_() {
  try {
    return contar(INSCRICOES_COLECAO);
  } catch (err) {
    console.error('inscricoesRecentes: o total não veio — ' + err.message);
    return null;
  }
}

/**
 * A fila de espera, em ORDEM DE CHEGADA, com o resumo de cada projeto.
 *
 * A ordem é `criado_em` ASC, e isso é decisão, não detalhe de implementação:
 * quem chegou primeiro entra primeiro. Qualquer outra ordem — alfabética, por
 * curso, por quem a coordenação reconhece — precisaria ser justificada na frente
 * do aluno que chegou antes e ficou atrás. Ordem de chegada não precisa.
 *
 * A consulta leva UM campo (`em_espera == SIM`) e nenhuma ordenação declarada:
 * `listar` desempata por `__name__` ASC, que todo índice automático de campo
 * único já cobre. A ordem de chegada é feita aqui, em JavaScript, sobre os poucos
 * documentos da fila — pedir ao banco `where em_espera` mais `orderBy criado_em`
 * seria o índice composto que este arquivo se proibiu.
 *
 * `projetos` traz TODOS os ativos, com fila ou sem — ver `projetosDoAuditorio_`.
 * `fila` traz só quem espera de fato.
 */
function filaDeEspera(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var alvo = String(payload.projeto_id || '').trim();
    var lidas = listar(INSCRICOES_COLECAO, {
      campo: 'em_espera',
      valor: 'SIM',
      limite: AUDITORIO_FILA_MAXIMA
    }).itens;

    var fila = alvo
      ? lidas.filter(function (i) { return String(i.projeto_id || '') === alvo; })
      : lidas;

    fila.sort(function (a, b) {
      var x = String(a.criado_em || '');
      var y = String(b.criado_em || '');
      if (x !== y) return x < y ? -1 : 1;
      // Empate no segundo: o id desempata só para a ordem ser ESTÁVEL entre duas
      // leituras. Duas pessoas no mesmo segundo não têm ordem de chegada real.
      return String(a._id) < String(b._id) ? -1 : 1;
    });

    var quantosPorProjeto = {};
    var saida = fila.map(function (i) {
      var pid = String(i.projeto_id || '');
      // `hasOwnProperty` e não `|| 0`: um `projeto_id` chamado 'constructor' ou
      // 'toString' responde por HERANÇA, e a soma vira
      // "function Object() { [native code] }1" — a posição na fila deixa de ser
      // número sem erro nenhum. É a mesma cicatriz de `idsDoPayload_`, e o
      // servidor é a fonte: o painel já se blindou, e blindar só o consumidor
      // deixa a origem produzindo lixo.
      //
      // Id de produção é `uid('proj')` ou hash hexadecimal, então isto não
      // acontece hoje — é o custo de uma linha para não depender disso.
      quantosPorProjeto[pid] = (Object.prototype.hasOwnProperty.call(quantosPorProjeto, pid)
        ? quantosPorProjeto[pid] : 0) + 1;

      return {
        id: i._id,
        nome: i.nome || '',
        matricula: i.matricula || '',
        projeto_id: pid,
        criado_em: i.criado_em || '',
        posicao: contagemDe_(quantosPorProjeto, pid)
      };
    });

    return {
      ok: true,
      truncada: lidas.length >= AUDITORIO_FILA_MAXIMA,
      // O mesmo teto de escrita que `inscricoesRecentes` devolve: as duas listas
      // da aba têm barra de ação, e a da fila promove. Mandá-lo de um lado só
      // deixaria metade da tela oferecendo lote que o servidor recusa.
      lote_maximo: AUDITORIO_LOTE_MAXIMO,
      projetos: projetosDoAuditorio_(quantosPorProjeto, alvo),
      fila: saida
    };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * O cabeçalho da aba: TODOS os projetos ativos, com fila ou sem.
 *
 * Sem fila também, e isso é decisão: um projeto em 58/60 sem ninguém esperando é
 * exatamente a informação que faz a coordenação prestar atenção ANTES de o
 * problema existir. Mostrar só quem já tem fila é mostrar o incêndio depois de
 * ele pegar.
 *
 * `listarProjetos(true)` traz a contagem de cada ativo pela MESMA função que
 * decide a vaga dentro do lock (`contarInscritos_`) — nenhuma segunda maneira de
 * contar vaga, que seria uma segunda verdade sobre vagas.
 *
 * Projeto que saiu do ar mas ainda tem gente na fila entra depois, um a um: sem
 * isso, a fila teria linha apontando para um projeto que a tela não conhece, e o
 * nome viraria travessão.
 *
 * ESTA ABA NÃO ABRE MÃO DA CONTAGEM. `contar_ocupacao_na_lista` em NAO faz
 * `listarProjetos` devolver `inscritos` null — é chave de diagnóstico do tempo
 * da lista PÚBLICA (09_Projetos.gs). Aqui o número não é enfeite: `cabem` sai
 * dele, e é por ele que a coordenação decide quem promover. Sem contagem, `cabem`
 * viraria "a fila inteira" e a tela ofereceria um botão que o servidor nega
 * pessoa por pessoa. Quando ele falta, esta função conta — pelo mesmo
 * `resumoDoProjeto_` que já existia para o projeto que a lista não trouxe. Custa
 * uma agregação por projeto, numa tela de coordenação, e não no caminho do aluno.
 */
function projetosDoAuditorio_(quantosPorProjeto, alvo) {
  // Pedindo UM projeto, é dele que se fala — e aí nem se paga a contagem dos
  // outros, que `listarProjetos` faria por dentro para jogar fora.
  if (alvo) return [resumoDoProjeto_(alvo, contagemDe_(quantosPorProjeto, alvo))];

  var saida = [];
  var vistos = {};

  listarProjetos(true).forEach(function (p) {
    vistos[p.id] = true;
    var emEspera = contagemDe_(quantosPorProjeto, p.id);
    saida.push(p.inscritos === null
      ? resumoDoProjeto_(p.id, emEspera)
      : linhaDoProjeto_(p, emEspera));
  });

  Object.keys(quantosPorProjeto).forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(vistos, id)) return;
    saida.push(resumoDoProjeto_(id, contagemDe_(quantosPorProjeto, id)));
  });

  return saida;
}

/**
 * Um projeto do ponto de vista de quem trata a fila.
 *
 * `cabem` é o número que a tela usa para dizer "promover os 12 que cabem", e ele
 * é calculado UMA vez, aqui, para as duas origens de projeto — as duas responderem
 * diferente seria a tela oferecendo um botão que o servidor nega.
 */
function linhaDoProjeto_(projeto, emEspera) {
  return {
    id: projeto.id,
    nome: projeto.nome || '',
    vagas: Number(projeto.vagas || 0),
    confirmados: projeto.inscritos,
    emEspera: emEspera,
    situacao: projeto.situacao,
    // Projeto que não está ABERTO não recebe promoção — `promoverDaEspera`
    // recusa —, então dizer que cabe alguém ali seria oferecer à coordenação um
    // botão que o servidor vai negar. Zero aqui é a mesma resposta, dada antes
    // do clique.
    //
    // `restantes` vem null quando o projeto é ilimitado (vagas 0), e aí cabe a
    // fila inteira: a subtração devolveria 0, que é o oposto do verdadeiro.
    cabem: projeto.situacao !== SITUACAO.ABERTO ? 0
      : (projeto.restantes === null ? emEspera : projeto.restantes)
  };
}

/** O mesmo resumo para um projeto que `listarProjetos` não trouxe. */
function resumoDoProjeto_(projetoId, emEspera) {
  var projeto = projetoPorId(projetoId);
  var vagas = Number((projeto && projeto.vagas) || 0);
  var confirmados = contarInscritos_(projetoId);

  return linhaDoProjeto_({
    id: projetoId,
    nome: (projeto && projeto.nome) || '',
    vagas: vagas,
    inscritos: confirmados,
    restantes: vagas > 0 ? Math.max(0, vagas - confirmados) : null,
    situacao: projeto ? situacaoDe_(projeto, confirmados) : SITUACAO.INATIVO
  }, emEspera);
}

// ------------------------------------------------------------ Anular

/**
 * Anula inscrições: copia para a quarentena e só então apaga.
 *
 * A ordem das três etapas é o que torna a falha no meio inofensiva:
 *   1. cópia para `inscricoes_anuladas`, com o id original, `anulado_em` e
 *      `anulado_por`;
 *   2. exclusão em lote de `inscricoes`;
 *   3. trilha.
 * Morrer entre 1 e 2 deixa uma duplicata, que `restaurarInscricoes` limpa.
 * Morrer entre 2 e 1 — a ordem inversa — perderia a inscrição.
 *
 * SEM LOCK, de propósito: ver o cabeçalho do arquivo.
 *
 * Uma linha de trilha para o lote inteiro, e não uma por id: 20 mil escritas por
 * dia no plano gratuito, e um mutirão de limpeza é justamente onde muitos ids
 * chegam de uma vez.
 *
 * A resposta traz `ids` — os que foram anulados DE FATO, sem os que já não
 * existiam. A revisão de divergências (05c_Revisao.gs) precisa deles para,
 * quando um passo seguinte dela falha, dizer QUEM ficou sem a inscrição; a
 * contagem sozinha não diz.
 *
 * O `catch` devolve e loga a mensagem SEM o caminho do documento
 * (`semCaminhoDeDocumento_`, 02_Repo.gs): o texto do Firestore num `:commit`
 * recusado carrega 'projects/<id do projeto>/.../inscricoes_anuladas/<id>', e
 * esta resposta vai para a tela do Auditório e, pela revisão, para a janela
 * dela.
 */
function anularInscricoes(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var ids = idsDoPayload_(payload.ids);
    if (!ids.length) return { ok: false, erro: 'Nenhuma inscrição selecionada.' };
    if (ids.length > AUDITORIO_LOTE_MAXIMO) {
      return { ok: false, erro: erroDeLoteGrandeDemais_(ids.length) };
    }

    var quem = quemMexeu_(payload.token);
    var carimbo = agora();

    var copias = [];
    var naoEncontradas = 0;

    ids.forEach(function (id) {
      var inscricao = ler(INSCRICOES_COLECAO, id);
      if (!inscricao) { naoEncontradas++; return; }

      // `_id` vem da leitura e é o que `escreverEmLote` usa como nome do
      // documento — a cópia nasce com o id original, que é a chave de dedup.
      inscricao.anulado_em = carimbo;
      inscricao.anulado_por = quem;
      copias.push(inscricao);
    });

    if (!copias.length) {
      return {
        ok: true,
        anuladas: 0,
        pedidas: ids.length,
        nao_encontradas: naoEncontradas,
        mensagem: 'Nenhuma delas existe mais — a lista da tela é de antes. Nada foi apagado.'
      };
    }

    var apagar = copias.map(function (c) { return c._id; });

    escreverEmLote(INSCRICOES_ANULADAS_COLECAO, copias);
    excluirEmLote(INSCRICOES_COLECAO, apagar);

    registrar('INSCRICOES_ANULADAS', 'inscricao', apagar[0],
      apagar.length + ' anulada(s) por ' + quem +
      (naoEncontradas ? ' (' + naoEncontradas + ' já não existia(m))' : '') +
      ' — ids: ' + apagar.join(','));

    return {
      ok: true,
      anuladas: apagar.length,
      ids: apagar,
      pedidas: ids.length,
      nao_encontradas: naoEncontradas,
      // Os NÚMEROS vão em campos, e a frase fica com o que a tela não tem como
      // saber. "Anulei 3 de 3" a tela monta sozinha com o que já recebeu;
      // repetir a conta aqui a faria aparecer duas vezes na mesma linha — é a
      // mesma divisão de trabalho de `promoverDaEspera` e `restaurarInscricoes`.
      mensagem: naoEncontradas
        ? naoEncontradas + ' já não estava(m) lá: a lista da tela é de antes.'
        : ''
    };
  } catch (err) {
    console.error('anularInscricoes: ' + semCaminhoDeDocumento_(err));
    return { ok: false, erro: semCaminhoDeDocumento_(err) };
  }
}

/**
 * Devolve inscrições da quarentena para `inscricoes` — CONFERINDO VAGA.
 *
 * A conferência não é zelo: sem ela o desfazer fura o limite de vagas, e o limite
 * de vagas é a única coisa que este sistema promete de verdade. Cada restauração
 * passa por `reservarVaga`, que é o único portão por onde uma vaga é consumida —
 * reusá-lo é o que impede o desfazer de inventar um segundo caminho para
 * ultrapassar o teto.
 *
 * O preço é o lock por inscrição restaurada, e ele é aceito por ser uma ação de
 * coordenação, feita fora do pico, sobre poucos ids. É o oposto do `anular`, que
 * só libera e por isso não paga nada.
 *
 * A ordem é insere-depois-limpa, pelo mesmo motivo do anular: morrer no meio
 * deixa a cópia na quarentena (que a próxima chamada resolve), e não um sumiço.
 *
 * As marcas da anulação não voltam — o documento restaurado é a inscrição, não o
 * registro da anulação. Quem quiser a história tem a trilha. O que conta como
 * marca, e o que é campo da inscrição e sobrevive, está em `restaurarUma_`.
 */
function restaurarInscricoes(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var ids = idsDoPayload_(payload.ids);
    if (!ids.length) return { ok: false, erro: 'Nenhuma inscrição selecionada.' };
    if (ids.length > AUDITORIO_LOTE_MAXIMO) {
      return { ok: false, erro: erroDeLoteGrandeDemais_(ids.length) };
    }

    var restauradas = 0;
    var emEspera = 0;
    var jaEstavam = 0;
    var recusadas = [];

    ids.forEach(function (id) {
      var guardada = ler(INSCRICOES_ANULADAS_COLECAO, id);
      if (!guardada) {
        recusadas.push({ id: id, motivo: 'não está entre as anuladas' });
        return;
      }

      // Já voltou? Então isto é o segundo passo de uma restauração que morreu no
      // meio: não disputa vaga nenhuma, só limpa a quarentena. Conferir aqui evita
      // relatar "não coube" para quem já está lá dentro.
      if (ler(INSCRICOES_COLECAO, id)) {
        excluir(INSCRICOES_ANULADAS_COLECAO, id);
        jaEstavam++;
        return;
      }

      var resultado = restaurarUma_(id, guardada);
      if (!resultado.ok) {
        recusadas.push({ id: id, motivo: resultado.erro });
        return;
      }

      excluir(INSCRICOES_ANULADAS_COLECAO, id);
      if (resultado.em_espera) emEspera++;
      else restauradas++;
    });

    var mexidas = restauradas + emEspera + jaEstavam;
    if (mexidas) {
      registrar('INSCRICOES_RESTAURADAS', 'inscricao', ids[0],
        mexidas + ' de ' + ids.length + ' restaurada(s) por ' + quemMexeu_(payload.token) +
        (emEspera ? ' (' + emEspera + ' em espera)' : '') +
        (recusadas.length ? ' — ' + recusadas.length + ' não coube(ram)' : ''));
    }

    return {
      ok: true,
      // `restauradas` é quem VOLTOU, some tudo: com vaga, em espera, ou já lá.
      // A tela imprime "Restaurei X de Y" com este número, e separar aqui faria
      // ela relatar menos gente do que voltou de verdade. A diferença entre os
      // três casos vai na `mensagem`, que é onde ela cabe sem enganar ninguém.
      restauradas: restauradas + emEspera + jaEstavam,
      com_vaga: restauradas,
      em_espera: emEspera,
      ja_estavam: jaEstavam,
      naoCouberam: recusadas.length,
      recusadas: recusadas,
      mensagem: mensagemDaRestauracao_(emEspera, jaEstavam, recusadas)
    };
  } catch (err) {
    // A mesma régua do `anular` (D-27): a mensagem de um `:commit` ou de uma
    // leitura recusada carrega o caminho do documento — o id do projeto Cloud e
    // o protocolo do aluno —, e daqui ela vai para a faixa da tela e para o log
    // de execução.
    console.error('restaurarInscricoes: ' + semCaminhoDeDocumento_(err));
    return { ok: false, erro: semCaminhoDeDocumento_(err) };
  }
}

/**
 * Uma restauração, pelo portão das vagas.
 *
 * Inscrição SEM projeto não disputa vaga com ninguém (é o formulário interno) e
 * grava direto, do mesmo jeito que `submeterInscricao` faz com ela.
 *
 * As marcas de fila são recalculadas, e não copiadas: quem foi anulado estando na
 * espera e encontra vaga aberta na volta entra CONFIRMADO; quem estava
 * confirmado e não cabe mais volta para a fila, se ela estiver ligada. Copiar as
 * marcas velhas gravaria uma verdade de ontem e desalinharia a contagem.
 *
 * ------------------------------------- O que fica para trás, e o que sobrevive
 *
 * A lista de descarte é de NEGAÇÃO, e o critério é UM: sai daqui TUDO O QUE A
 * QUARENTENA ACRESCENTA, e só isso. São as quatro marcas da anulação
 * (`anulado_em`, `anulado_por`, `anulado_motivo`, `trocado_para`) mais as duas
 * de fila, que são recalculadas logo abaixo.
 *
 * Os contraexemplos, nomeados porque a tentação é trocar isto por uma lista de
 * permissão: `incluido_por` (quem a coordenação usou para incluir a pessoa) e
 * `trocada_de` (a inscrição que o aluno trocou por esta) são campos DA
 * INSCRIÇÃO, não da quarentena, e TÊM de voltar. Uma lista de permissão apagaria
 * os dois em silêncio na primeira restauração, e a trilha de quem entrou por
 * onde morreria sem ninguém perceber.
 *
 * ------------------------------------------ A regra de um projeto por aluno
 *
 * Com `aluno_projeto_unico` em SIM, restaurar pode criar a SEGUNDA inscrição
 * ativa de uma matrícula — a pessoa foi anulada, se inscreveu em outro projeto,
 * e agora a coordenação desfaz a anulação. A guarda roda DENTRO do lock, pela
 * CONSULTA que a troca usa (`inscricoesAtivasDe_`, 04_Inscricoes.gs), e não pelo
 * ponteiro `trocado_para` da cópia: o ponteiro só conhece o primeiro salto, e um
 * aluno que trocou duas vezes (X -> Y -> Z) tem em `trocado_para` de X um Y que
 * já não existe. A consulta sempre acha onde a pessoa ESTÁ.
 */
function restaurarUma_(id, guardada) {
  var campos = {};
  Object.keys(guardada).forEach(function (chave) {
    if (chave.charAt(0) === '_') return;
    if (chave === 'anulado_em' || chave === 'anulado_por') return;
    if (chave === 'anulado_motivo' || chave === 'trocado_para') return;
    if (chave === 'em_espera' || chave === 'espera_de') return;
    campos[chave] = guardada[chave];
  });

  var projetoId = String(campos.projeto_id || '');
  if (!projetoId) {
    var solta = inserir(INSCRICOES_COLECAO, campos, id);
    return { ok: true, em_espera: false, duplicada: solta.jaExistia };
  }

  return reservarVaga(projetoId, function (projeto, emEspera) {
    var ocupado = outroProjetoAtivoDe_(campos, projetoId);
    if (ocupado) return { ok: false, erro: 'já está em outro projeto ativo (' + ocupado + ')' };

    if (emEspera) {
      campos.em_espera = 'SIM';
      campos.espera_de = projetoId;
    }
    var gravacao = inserir(INSCRICOES_COLECAO, campos, id);
    return { ok: true, duplicada: gravacao.jaExistia, id: id, em_espera: Boolean(emEspera) };
  });
}

/**
 * Com a regra ligada: em que OUTRO projeto ativo esta matrícula já está, se
 * estiver. Devolve o nome, ou '' quando a restauração pode seguir.
 *
 * Uma consulta, dentro do lock, e só com a chave em SIM: com ela em NAO —
 * o padrão — esta função não lê nada e restaurar custa o que sempre custou.
 *
 * Os projetos são LIDOS (o contexto vai com `dentroDoLock: false`) de propósito,
 * e aqui o nome do campo engana: ele diz "o conjunto já foi consentido na
 * rodada 1, não pague leitura", que é verdade no caminho do aluno e falso aqui —
 * a coordenação não passou por rodada nenhuma. Sem ler, uma inscrição num
 * projeto do semestre PASSADO contaria como ativa e recusaria a restauração.
 * São poucas leituras, uma ação de coordenação, fora do pico.
 */
function outroProjetoAtivoDe_(campos, projetoId) {
  if (String(config('aluno_projeto_unico', 'NAO')).toUpperCase() !== 'SIM') return '';

  var ctx = {
    matricula: normalizarMatricula(campos.matricula),
    email: normalizarEmail(campos.email),
    alvo: String(projetoId),
    trocarDe: [],
    cancelada: false,
    mapa: {},
    dentroDoLock: false,
    ativasNoLock: null,
    nomeDoAlvo: ''
  };
  if (!ctx.matricula) return '';

  var ativas = inscricoesAtivasDe_(ctx);
  if (!ativas.outras.length) return '';

  return resumoDasAtivas_(ctx, ativas.outras).map(function (a) { return a.projeto_nome; }).join(', ');
}

/**
 * O que a contagem sozinha não conta.
 *
 * "Restaurei 12 de 38" quem imprime é a tela, com os dois números que já
 * recebeu. Repetir a frase aqui a faria aparecer duas vezes na mesma linha —
 * então esta mensagem carrega só o que os números escondem: quem voltou para a
 * fila em vez da vaga, quem já estava lá, e por que os outros não voltaram.
 */
function mensagemDaRestauracao_(emEspera, jaEstavam, recusadas) {
  var partes = [];

  if (emEspera) partes.push(emEspera + ' entrou(entraram) na lista de espera: a vaga já não existia.');
  if (jaEstavam) partes.push(jaEstavam + ' já estava(m) de volta.');
  if (recusadas.length) partes.push(fraseDeQuemFicou_(recusadas));

  return partes.join(' ');
}

/**
 * O que aconteceu com quem não entrou, em uma frase.
 *
 * "N não coube(ram)" vem primeiro porque é o número que a coordenação precisa
 * ver; o motivo vem agrupado atrás dele. Uma linha por id encheria a tela com
 * 200 frases iguais no dia em que o lote for grande — e é justamente no lote
 * grande que ninguém tem tempo de ler.
 */
function fraseDeQuemFicou_(recusadas) {
  return recusadas.length + ' não coube(ram): ' + motivosResumidos_(recusadas) + '.';
}

/** Os motivos agrupados: 'as vagas...' com um só, '2 × ...; 1 × ...' com vários. */
function motivosResumidos_(recusadas) {
  var contagem = {};
  var ordem = [];

  recusadas.forEach(function (r) {
    var motivo = String(r.motivo || 'motivo não informado');
    if (!Object.prototype.hasOwnProperty.call(contagem, motivo)) {
      contagem[motivo] = 0;
      ordem.push(motivo);
    }
    contagem[motivo]++;
  });

  if (ordem.length === 1) return ordem[0];
  return ordem.map(function (motivo) { return contagem[motivo] + ' × ' + motivo; }).join('; ');
}

// ------------------------------------------------------------ Promover

/**
 * O que `promoverDentroDoLock_` devolve quando o `:commit` foi recusado porque
 * uma das inscrições mudou depois de lida.
 *
 * Um objeto próprio, comparado por IDENTIDADE: os outros dois retornos são
 * `null` (o lock não veio) e a lista de ids promovidos, e nenhuma lista pode ser
 * igual a este objeto por acidente. Um `[]` para dizer "ninguém foi promovido"
 * se confundiria com "o lote inteiro foi recusado por falta de vaga", que é
 * sucesso e tem outra resposta.
 */
var PROMOCAO_EM_CORRIDA = { corrida: true };

/**
 * O irmão do de cima, para quando NÃO SE SABE se o lote entrou.
 *
 * Mesma recusa de precondição, uma diferença que muda tudo: houve retentativa
 * antes dela (`escritaIndeterminada_`, 02_Repo.gs). O 503 pode ter chegado na
 * RESPOSTA de um `:commit` que o banco já aplicou, e a segunda tentativa, com a
 * mesma versão na mão, bate na precondição que o meu próprio efeito acabou de
 * mudar. Deste lado do fio, "outra pessoa mexeu" e "fui eu, e deu certo" têm o
 * mesmo status.
 *
 * Existe porque a resposta dos dois casos NÃO pode ser a mesma: "ninguém foi
 * promovido" é verdade num e é o contrário do que aconteceu no outro — e foi
 * exatamente o que esta aba chegou a dizer com a fila inteira promovida.
 */
var PROMOCAO_INDETERMINADA = { indeterminada: true };

/**
 * Promove quem está na fila para vaga de verdade.
 *
 * Promover OCUPA vaga, então isto é `reservarVaga` para um lote: conta e escreve
 * dentro do `LockService`, e o lock é pego UMA VEZ para o lote inteiro. Um
 * `waitLock` por pessoa faria cada aluno do auditório esperar a fila de promoções
 * inteira, uma promoção de cada vez.
 *
 * O que fica FORA da região protegida, e é o que a mantém curta:
 *   - ler os documentos da fila (uma leitura por id);
 *   - ler os projetos e recusar INATIVO/FECHADO, que não dependem da contagem.
 * Dentro ficam a contagem — uma por projeto, não uma por pessoa — e UMA escrita
 * em lote.
 *
 * A ordem é a que a coordenação mandou: os ids são promovidos na ordem em que
 * vieram, e quando o projeto enche, os seguintes são recusados com o motivo. A
 * tela é quem sabe qual é a ordem justa (`filaDeEspera` devolve por chegada); o
 * servidor não reordena o que a pessoa viu antes de clicar.
 *
 * Idempotente: promover quem já está confirmado não escreve nem conta — a marca
 * de fila é o que se olha, e ela some na primeira promoção.
 */
function promoverDaEspera(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var ids = idsDoPayload_(payload.ids);
    if (!ids.length) return { ok: false, erro: 'Nenhuma inscrição selecionada.' };
    if (ids.length > AUDITORIO_LOTE_MAXIMO) {
      return { ok: false, erro: erroDeLoteGrandeDemais_(ids.length) };
    }

    var recusadas = [];
    var jaConfirmadas = 0;
    var candidatos = [];

    ids.forEach(function (id) {
      var inscricao = ler(INSCRICOES_COLECAO, id);
      if (!inscricao) {
        recusadas.push({ id: id, motivo: 'inscrição não encontrada' });
        return;
      }
      if (String(inscricao.em_espera).toUpperCase() !== 'SIM') {
        jaConfirmadas++;
        return;
      }
      candidatos.push(inscricao);
    });

    // Os projetos, lidos uma vez cada, FORA do lock — como `reservarVaga` faz.
    // INATIVO e FECHADO não dependem da contagem e recusam aqui.
    var projetos = {};
    candidatos = candidatos.filter(function (inscricao) {
      var pid = String(inscricao.projeto_id || '');
      if (!Object.prototype.hasOwnProperty.call(projetos, pid)) {
        projetos[pid] = projetoPorId(pid);
      }
      var projeto = projetos[pid];

      if (!projeto) {
        recusadas.push({ id: inscricao._id, motivo: 'projeto não encontrado' });
        return false;
      }
      var situacao = situacaoDe_(projeto, 0);
      if (situacao !== SITUACAO.ABERTO) {
        recusadas.push({ id: inscricao._id, motivo: 'o projeto está ' + situacao.toLowerCase() });
        return false;
      }
      return true;
    });

    var promovidas = candidatos.length ? promoverDentroDoLock_(candidatos, projetos, recusadas) : [];
    if (promovidas === null) {
      return {
        ok: false,
        erro: 'Muita gente se inscrevendo ao mesmo tempo. Aguarde alguns segundos e tente de novo — ' +
              'ninguém foi promovido.'
      };
    }
    if (promovidas === PROMOCAO_EM_CORRIDA) {
      // A precondição por versão recusou o lote inteiro, e a recusa veio na
      // PRIMEIRA tentativa: uma das inscrições mudou entre a leitura e a escrita
      // — ela foi editada, anulada, ou o aluno trocou de projeto. Aqui sim
      // NINGUÉM foi promovido: nenhum `:commit` deste pedido chegou a ser
      // aplicado, e a tela precisa saber que o que ela mostra é de antes. Sem
      // retentativa automática, de propósito: reler as 200 dentro do lock
      // custaria o auditório parado.
      return {
        ok: false,
        erro: 'A lista da tela é de antes: alguém saiu da fila enquanto você promovia — ' +
              'ninguém foi promovido. Recarregue e tente de novo.'
      };
    }
    if (promovidas === PROMOCAO_INDETERMINADA) {
      // E aqui NÃO SE SABE. Houve retentativa antes da recusa, e o 503 pode ter
      // chegado na resposta de um commit já aplicado — caso em que a fila inteira
      // FOI promovida e dizer "ninguém foi" seria mandar a coordenação promover
      // de novo gente que já está com vaga. A frase não afirma nenhum dos dois
      // lados e manda fazer a única coisa que resolve: olhar a lista.
      //
      // E a linha do log sai MESMO ASSIM, porque num ramo indeterminado o efeito
      // pode ter entrado sem nenhuma trilha — o `registrar` de sucesso fica
      // depois daqui, e quem sai por este caminho passaria por fora dele. São
      // TRÊS os ramos com essa propriedade, e todos registram antes de
      // responder: este, a promoção do Incluir aluno (10_Painel.gs) e a troca de
      // projeto do aluno (`decorarComATroca_`, 04_Inscricoes.gs). `registrar` é
      // à prova de falha (04_Log.gs) e a linha diz o que se sabe: o que foi
      // tentado, por quem, e que o resultado não foi confirmado.
      registrar('PROMOCAO_ESPERA', 'inscricao', candidatos[0]._id,
        'resultado INDETERMINADO: a resposta do banco se perdeu numa retentativa e a promoção ' +
        'pode ter entrado — por ' + quemMexeu_(payload.token) +
        ' — candidatos: ' + candidatos.map(function (i) { return i._id; }).join(','));

      return {
        ok: false,
        erro: 'A resposta do banco se perdeu no meio da promoção: NÃO consigo confirmar se ela ' +
              'entrou. Recarregue a lista e confira antes de tentar de novo.'
      };
    }

    if (promovidas.length) {
      registrar('PROMOCAO_ESPERA', 'inscricao', promovidas[0],
        promovidas.length + ' de ' + ids.length + ' promovida(s) por ' + quemMexeu_(payload.token) +
        ' — ids: ' + promovidas.join(','));
    }

    return {
      ok: true,
      promovidos: promovidas.length,
      ja_confirmadas: jaConfirmadas,
      naoCouberam: recusadas.length,
      recusadas: recusadas,
      // A tela imprime "Promovi X de Y" com os números; aqui vai só o que eles
      // não contam — quem já estava confirmado e por que os outros ficaram.
      mensagem: (jaConfirmadas ? jaConfirmadas + ' já estava(m) confirmada(s). ' : '') +
        (recusadas.length ? fraseDeQuemFicou_(recusadas) : '')
    };
  } catch (err) {
    // Sem o caminho do documento na tela nem no log de execução (D-27,
    // `semCaminhoDeDocumento_` em 02_Repo.gs): a mensagem de um `:commit`
    // recusado carrega 'projects/<id do projeto Cloud>/.../inscricoes/<hash>',
    // que é o id do projeto Cloud e o protocolo de um aluno.
    console.error('promoverDaEspera: ' + semCaminhoDeDocumento_(err));
    return { ok: false, erro: semCaminhoDeDocumento_(err) };
  }
}

/**
 * A região protegida da promoção: contar, decidir, escrever. Devolve os ids
 * promovidos, ou null quando o lock não veio.
 *
 * Uma agregação por PROJETO, e não por pessoa: a contagem não muda entre duas
 * decisões do mesmo lote porque quem decrementa o saldo é este laço, e ninguém
 * mais escreve enquanto o lock é nosso.
 *
 * A escrita SUBSTITUI o documento inteiro — por isso o que vai é o documento
 * LIDO, campo por campo, com as duas marcas de fila mudadas. Mandar só os dois
 * campos apagaria todo o resto da inscrição. É a mesma faca que a `updateMask`
 * do `atualizar` embainha; aqui ela fica exposta, em troca de UMA requisição
 * para o lote inteiro em vez de uma por pessoa dentro do lock.
 *
 * ------------------------------------------- A precondição, e por que é VERSÃO
 *
 * Cada escrita leva `currentDocument: { updateTime }` — o carimbo que a leitura
 * trouxe (`_versao`, 02_Repo.gs). Se QUALQUER uma das inscrições mudou entre a
 * leitura (fora do lock, ~0,5 s por id) e este commit, o `:commit` volta
 * FAILED_PRECONDITION (ou NOT_FOUND, se ela sumiu), NINGUÉM é promovido, e a
 * resposta manda recarregar. Nada é aplicado pela metade — é o `:commit` inteiro
 * que o banco recusa.
 *
 * Com uma ressalva que não é detalhe: o recusado é ESTE `:commit`. Se `fsFetch_`
 * já tinha retentado (503, 429, ABORTED), a tentativa ANTERIOR pode ter sido
 * aplicada e só a resposta ter se perdido — e aí a precondição que não bate mais
 * é a marca do próprio efeito, a fila inteira está promovida, e "ninguém foi
 * promovido" seria o contrário do que aconteceu. Por isso são DOIS marcadores:
 * `PROMOCAO_EM_CORRIDA` para a recusa de primeira (nada entrou, e isso se sabe)
 * e `PROMOCAO_INDETERMINADA` para a que veio depois de uma retentativa
 * (`escritaIndeterminada_`, 02_Repo.gs), em que a única frase verdadeira é
 * "não consigo confirmar; recarregue e confira".
 *
 * A janela existia e não era inofensiva. `escreverEmLote` sem precondição
 * nenhuma REESCREVE o documento lido por cima do que houver: reverte a edição de
 * outra aba, ressuscita a inscrição que o `anular` acabou de mandar para a
 * quarentena e — desde a troca de projeto (item 4) — devolve à vida a inscrição
 * que o aluno trocou, agora SEM as marcas de fila, isto é, OCUPANDO VAGA. O
 * aluno fica com duas ativas, a cópia em `inscricoes_anuladas` fica órfã e o
 * teto do projeto vai a +1. Fechar isso relendo as 200 dentro do lock custaria
 * minutos de auditório parado; a precondição custa zero leitura, porque o
 * carimbo já vem de graça de toda leitura.
 *
 * É VERSÃO e não `exists:true` porque `exists:true` não distingue "o mesmo
 * documento" de "o documento REESCRITO" — a frase é de `atualizarEmLote`
 * (02_Repo.gs), e é a mesma escolha que a revisão de divergências já fez.
 *
 * O preço, dito: um lote de 200 é recusado inteiro quando UMA das 200 mudou.
 * Isso é o desenho, e não o acidente — a alternativa é promover por cima do que
 * mudou. Sem retentativa automática: recusa clara e clique de novo é mais barato
 * do que reler 200 dentro do lock.
 *
 * E é UM `:commit` só, sem fatiar: `AUDITORIO_LOTE_MAXIMO` é 200 e o teto do
 * `:commit` é 500, então o lote da tela sempre cabe inteiro numa requisição —
 * que é a condição para "ninguém é promovido" ser verdade. `escreverAtomico`
 * recusa antes de mandar se algum dia esses dois números se cruzarem.
 *
 * O invariante NÃO depende dessa janela: quem decide vaga é a contagem lida aqui
 * dentro. Duas promoções simultâneas da mesma pessoa gastam saldo duas vezes na
 * conta de quem promove — o que recusa alguém a mais, nunca aceita.
 *
 * `incluirInscricao` (10_Painel.gs) promove UMA inscrição do mesmo jeito — as
 * duas marcas apagadas, o documento lido reescrito inteiro —, sem o lock e por
 * fora do teto e da situação, porque é a coordenação decidindo por fora. Quem
 * mudar o que "promover" escreve no documento muda nos dois lugares — inclusive
 * a PRECONDIÇÃO: ele também grava com `versao` (o ramo da duplicada), e recusa
 * com a frase dele, "a ficha é de antes: esta inscrição mudou enquanto a janela
 * estava aberta". E inclusive a LINHA DO LOG do indeterminado: lá, como aqui,
 * ela sai antes da resposta, porque é o único rastro que sobra de uma promoção
 * que pode ter entrado. A janela de lá é maior que esta, e não menor: sem lock,
 * o documento é lido e reescrito com segundos de Apps Script no meio.
 */
function promoverDentroDoLock_(candidatos, projetos, recusadas) {
  // A pergunta da fila é feita AQUI, antes do `waitLock`, e não é para usar a
  // resposta: é para o cache de execução de `config()` já estar quente quando
  // `contarInscritos_` a repetir lá dentro. Configuração fria custa uma leitura,
  // e leitura fria dentro da região protegida é a fila do auditório esperando a
  // limpeza — o oposto do que esta aba existe para fazer.
  esperaLigada_();

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(TIMEOUT_LOCK_MS);
  } catch (e) {
    return null;
  }

  try {
    var saldo = {};
    var promover = [];

    candidatos.forEach(function (inscricao) {
      var pid = String(inscricao.projeto_id || '');

      if (!Object.prototype.hasOwnProperty.call(saldo, pid)) {
        var vagas = Number(projetos[pid].vagas || 0);
        // 0 = ilimitado: cabe o lote inteiro, e a agregação nem roda.
        saldo[pid] = vagas > 0 ? Math.max(0, vagas - contarInscritos_(pid)) : candidatos.length;
      }

      if (saldo[pid] <= 0) {
        recusadas.push({ id: inscricao._id, motivo: 'as vagas do projeto já estão preenchidas' });
        return;
      }

      saldo[pid]--;

      // As marcas são APAGADAS, e não zeradas: o documento de quem ocupa vaga
      // não tem esses campos (ver `gravarInscricao`, 04_Inscricoes.gs), e quem
      // foi promovido ocupa vaga. Deixar `em_espera: NAO` gravado criaria uma
      // terceira forma de documento — nem fila, nem inscrição comum — e a
      // primeira pessoa a filtrar por "tem o campo" leria a fila errada.
      delete inscricao.em_espera;
      delete inscricao.espera_de;
      promover.push(inscricao);
    });

    if (promover.length) {
      try {
        escreverAtomico(promover.map(function (inscricao) {
          return {
            gravar: {
              colecao: INSCRICOES_COLECAO,
              id: inscricao._id,
              objeto: inscricao,
              // O carimbo que a leitura de FORA do lock trouxe.
              versao: inscricao._versao
            }
          };
        }));
      } catch (err) {
        // Alguém mexeu numa delas enquanto a tela estava aberta. Nada foi
        // aplicado — nem as que vieram antes no lote —, e quem chama devolve a
        // recusa que manda recarregar. Qualquer outro erro (rede, cota) segue
        // subindo para o `catch` de `promoverDaEspera`, que é onde ele sempre
        // terminou.
        if (!corridaDeEscrita_(err)) throw err;
        // E se houve RETENTATIVA antes da recusa, nem isso se sabe: o 503 pode
        // ter chegado depois de o banco aplicar o commit, e a precondição que
        // não bate mais é a marca do próprio efeito. Os dois marcadores existem
        // para que a resposta não invente o que não sabe.
        return escritaIndeterminada_(err) ? PROMOCAO_INDETERMINADA : PROMOCAO_EM_CORRIDA;
      }
    }

    return promover.map(function (i) { return i._id; });
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------ Apoio

/**
 * Os ids que o painel mandou: texto, sem repetição — e TODOS eles.
 *
 * Ids explícitos, e nunca "faça em quantos couberem": quem apaga precisa ter
 * visto quem está apagando. Um filtro que o servidor resolve sozinho apagaria o
 * que a tela não mostrou.
 *
 * O TETO NÃO É APLICADO AQUI. Devolver menos do que o chamador pediu, sem dizer,
 * é a mesma classe de defeito de mostrar 200 de 275: os três que escrevem
 * conferem `AUDITORIO_LOTE_MAXIMO` e RECUSAM o lote inteiro
 * (`erroDeLoteGrandeDemais_`). Esta função responde uma pergunta só — quais ids
 * vieram —, e quem tem dois contratos é quem produz o próximo defeito calado.
 *
 * A barra é recusada porque id de documento não tem barra: `excluirEmLote` e
 * `escreverEmLote` colam o id no caminho do recurso, e uma barra ali mudaria a
 * coleção alvo em vez de errar.
 */
/** Quanto o mapa tem para esta chave, sem cair na herança de Object.prototype. */
function contagemDe_(mapa, chave) {
  return Object.prototype.hasOwnProperty.call(mapa, chave) ? mapa[chave] : 0;
}

function idsDoPayload_(bruto) {
  if (!bruto) return [];

  var lista = Array.isArray(bruto) ? bruto : [bruto];
  var vistos = {};
  var ids = [];

  lista.forEach(function (v) {
    var id = String(v === null || v === undefined ? '' : v).trim();
    if (!id || id.indexOf('/') !== -1) return;
    // `hasOwnProperty` e não `vistos[id]`: 'constructor' e 'toString' respondem
    // verdadeiro por herança, e o id legítimo com esse nome seria descartado.
    if (Object.prototype.hasOwnProperty.call(vistos, id)) return;

    vistos[id] = true;
    ids.push(id);
  });

  return ids;
}

/**
 * A recusa do lote grande demais — a mesma frase nas três que escrevem.
 *
 * Aqui era um `slice` silencioso: quem mandava 500 ids recebia 200 tratados e um
 * relatório verde, e os 300 restantes ficavam na tela sem ninguém saber. Recusar
 * devolve a decisão a quem clicou, com os dois números de que ela precisa — o
 * que veio e o que cabe —, e devolve ANTES de ler ou gravar qualquer coisa, para
 * o lote recusado não custar nem meia escrita.
 */
function erroDeLoteGrandeDemais_(quantos) {
  return 'Vieram ' + quantos + ' inscrições de uma vez, e o lote é de no máximo ' +
    AUDITORIO_LOTE_MAXIMO + ' — nada foi feito. Selecione até ' + AUDITORIO_LOTE_MAXIMO +
    ' e repita.';
}

/**
 * Um número de 1 a AUDITORIO_RECENTES_MAXIMO, com padrão para o que não é número.
 *
 * Chamava-se `tetoDoLote_` e fechava a leitura no teto da ESCRITA — um nome que
 * mentia sobre os dois lados e mantinha a tela presa ao limite dos 6 minutos de
 * execução, que a leitura não paga.
 */
function tetoDaLeitura_(bruto, padrao) {
  var n = Math.floor(Number(bruto));
  if (!n || n < 1) return padrao;
  return Math.min(n, AUDITORIO_RECENTES_MAXIMO);
}

/**
 * A inscrição como a tela do auditório precisa dela.
 *
 * `raw_json` fica de fora: é o payload inteiro do formulário repetido dentro do
 * documento, e mandá-lo em mil linhas engordaria a resposta sem acrescentar nada
 * que a conferência use.
 *
 * A PROCEDÊNCIA vai junto, e são dois campos que a tela usa como selo:
 * `incluido_por` (a coordenação incluiu esta pessoa) e `trocada_de` (o aluno
 * trocou de projeto, e este é o id da inscrição anulada). Sem eles a inscrição
 * que nasceu de uma troca é indistinguível de uma comum na aba Geral, e a
 * pergunta "de onde veio esta linha?" só teria resposta no log. Os dois são
 * texto e podem não existir — `origem` continua dizendo por ONDE, e estes dizem
 * POR QUEM e DE ONDE.
 */
function resumoParaAuditorio_(inscricao) {
  return {
    id: inscricao._id,
    criado_em: inscricao.criado_em || '',
    nome: inscricao.nome || '',
    matricula: inscricao.matricula || '',
    matricula_conferida: String(inscricao.matricula_conferida).toUpperCase() === 'SIM',
    email: inscricao.email || '',
    curso_fase: inscricao.curso_fase || '',
    projeto_id: inscricao.projeto_id || '',
    projeto_nome: inscricao.projeto_nome || '',
    origem: inscricao.origem || '',
    incluido_por: inscricao.incluido_por || '',
    trocada_de: inscricao.trocada_de || '',
    em_espera: String(inscricao.em_espera).toUpperCase() === 'SIM'
  };
}
