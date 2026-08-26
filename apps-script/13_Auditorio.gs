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
 */

/** Quarentena: o que foi anulado, com o id original preservado. */
var INSCRICOES_ANULADAS_COLECAO = 'inscricoes_anuladas';

/**
 * Teto de ids por chamada.
 *
 * 200, e não "quantos vierem": cada id custa de uma a duas leituras e uma
 * escrita, e a execução do Apps Script morre aos 6 minutos. Um lote sem teto
 * falharia no meio — que é o único jeito de a quarentena ficar com metade do
 * serviço feito.
 */
var AUDITORIO_LOTE_MAXIMO = 200;

/** Quantas inscrições recentes a tela pede quando não diz. */
var AUDITORIO_RECENTES_PADRAO = 50;

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
 * O filtro por projeto acontece DEPOIS, em JavaScript, e a consequência precisa
 * ficar dita: ele corta o que o teto já trouxe. Pedir as últimas 200 e ver 12 de
 * um projeto não é defeito — é o que "as 12 mais recentes DENTRO das últimas 200"
 * significa. `lidas` volta na resposta justamente para a tela poder dizer isso.
 * Filtrar no servidor custaria índice composto (ver o cabeçalho).
 */
function inscricoesRecentes(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var limite = tetoDoLote_(payload.limite, AUDITORIO_RECENTES_PADRAO);
    var lidas = listar(INSCRICOES_COLECAO, {
      ordenarPor: 'criado_em',
      direcao: 'DESC',
      limite: limite
    }).itens;

    var alvo = String(payload.projeto_id || '').trim();
    var itens = alvo
      ? lidas.filter(function (i) { return String(i.projeto_id || '') === alvo; })
      : lidas;

    return { ok: true, lidas: lidas.length, inscricoes: itens.map(resumoParaAuditorio_) };
  } catch (err) {
    return { ok: false, erro: err.message };
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
      quantosPorProjeto[pid] = (quantosPorProjeto[pid] || 0) + 1;

      return {
        id: i._id,
        nome: i.nome || '',
        matricula: i.matricula || '',
        projeto_id: pid,
        criado_em: i.criado_em || '',
        posicao: quantosPorProjeto[pid]
      };
    });

    return {
      ok: true,
      truncada: lidas.length >= AUDITORIO_FILA_MAXIMA,
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
  if (alvo) return [resumoDoProjeto_(alvo, quantosPorProjeto[alvo] || 0)];

  var saida = [];
  var vistos = {};

  listarProjetos(true).forEach(function (p) {
    vistos[p.id] = true;
    var emEspera = quantosPorProjeto[p.id] || 0;
    saida.push(p.inscritos === null
      ? resumoDoProjeto_(p.id, emEspera)
      : linhaDoProjeto_(p, emEspera));
  });

  Object.keys(quantosPorProjeto).forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(vistos, id)) return;
    saida.push(resumoDoProjeto_(id, quantosPorProjeto[id]));
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
 */
function anularInscricoes(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var ids = idsDoPayload_(payload.ids);
    if (!ids.length) return { ok: false, erro: 'Nenhuma inscrição selecionada.' };

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
    console.error('anularInscricoes: ' + err.message);
    return { ok: false, erro: err.message };
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
 * `anulado_em` e `anulado_por` não voltam — o documento restaurado é a inscrição,
 * não o registro da anulação. Quem quiser a história tem a trilha.
 */
function restaurarInscricoes(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var ids = idsDoPayload_(payload.ids);
    if (!ids.length) return { ok: false, erro: 'Nenhuma inscrição selecionada.' };

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
    console.error('restaurarInscricoes: ' + err.message);
    return { ok: false, erro: err.message };
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
 */
function restaurarUma_(id, guardada) {
  var campos = {};
  Object.keys(guardada).forEach(function (chave) {
    if (chave.charAt(0) === '_') return;
    if (chave === 'anulado_em' || chave === 'anulado_por') return;
    if (chave === 'em_espera' || chave === 'espera_de') return;
    campos[chave] = guardada[chave];
  });

  var projetoId = String(campos.projeto_id || '');
  if (!projetoId) {
    var solta = inserir(INSCRICOES_COLECAO, campos, id);
    return { ok: true, em_espera: false, duplicada: solta.jaExistia };
  }

  return reservarVaga(projetoId, function (projeto, emEspera) {
    if (emEspera) {
      campos.em_espera = 'SIM';
      campos.espera_de = projetoId;
    }
    var gravacao = inserir(INSCRICOES_COLECAO, campos, id);
    return { ok: true, duplicada: gravacao.jaExistia, id: id, em_espera: Boolean(emEspera) };
  });
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
    console.error('promoverDaEspera: ' + err.message);
    return { ok: false, erro: err.message };
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
 * A escrita é `escreverEmLote`, e ela SUBSTITUI o documento inteiro — por isso o
 * que vai é o documento LIDO, campo por campo, com as duas marcas de fila
 * mudadas. Mandar só os dois campos apagaria todo o resto da inscrição. É a
 * mesma faca que a `updateMask` do `atualizar` embainha; aqui ela fica exposta,
 * em troca de UMA requisição para o lote inteiro em vez de uma por pessoa dentro
 * do lock.
 *
 * A janela que isso abre, conhecida e aceita: entre a leitura (fora) e a escrita
 * (aqui), a mesma inscrição pode ter sido editada ou anulada por outra aba do
 * painel. A escrita então reverte a edição, ou ressuscita a anulada com a cópia
 * ainda na quarentena — a mesma duplicata inofensiva do `anular`, e visível na
 * trilha. Fechar a janela exigiria ler as 200 dentro do lock, que é trocar um
 * caso raro entre duas telas da coordenação por minutos de auditório parado.
 *
 * O invariante NÃO depende dessa janela: quem decide vaga é a contagem lida aqui
 * dentro. Duas promoções simultâneas da mesma pessoa gastam saldo duas vezes na
 * conta de quem promove — o que recusa alguém a mais, nunca aceita.
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

    if (promover.length) escreverEmLote(INSCRICOES_COLECAO, promover);

    return promover.map(function (i) { return i._id; });
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------ Apoio

/**
 * Os ids que o painel mandou: texto, sem repetição, no teto.
 *
 * Ids explícitos, e nunca "faça em quantos couberem": quem apaga precisa ter
 * visto quem está apagando. Um filtro que o servidor resolve sozinho apagaria o
 * que a tela não mostrou.
 *
 * A barra é recusada porque id de documento não tem barra: `excluirEmLote` e
 * `escreverEmLote` colam o id no caminho do recurso, e uma barra ali mudaria a
 * coleção alvo em vez de errar.
 */
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

  return ids.slice(0, AUDITORIO_LOTE_MAXIMO);
}

/** Um número de 1 a AUDITORIO_LOTE_MAXIMO, com padrão para o que não é número. */
function tetoDoLote_(bruto, padrao) {
  var n = Math.floor(Number(bruto));
  if (!n || n < 1) return padrao;
  return Math.min(n, AUDITORIO_LOTE_MAXIMO);
}

/**
 * A inscrição como a tela do auditório precisa dela.
 *
 * `raw_json` fica de fora: é o payload inteiro do formulário repetido dentro do
 * documento, e mandá-lo em 200 linhas engordaria a resposta sem acrescentar nada
 * que a conferência use.
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
    em_espera: String(inscricao.em_espera).toUpperCase() === 'SIM'
  };
}
