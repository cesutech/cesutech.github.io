/**
 * 12_Disciplinas.gs — o cadastro das disciplinas que o formulário oferece em
 * "Curso e fase".
 *
 * Até aqui essa lista era a chave de configuração `cursos_fases` (00_Config.gs):
 * um texto único, com as opções separadas por '|', editável só na aba
 * Configurações. O defeito que isso produziu é estrutural: a lista escrita à
 * mão envelhece sozinha. Basta a secretaria abrir a fase seguinte de uma turma
 * — ADM51 vira ADM61, PMM31 vira PMM21, entram turmas novas de EAD — e o
 * formulário continua oferecendo as fases do semestre passado. O aluno não
 * consegue escolher a disciplina em que está, e a coordenação não tem tela para
 * corrigir: tem um campo de texto onde um '|' fora do lugar apaga uma opção sem
 * avisar. Daí este cadastro, com uma linha por disciplina.
 *
 * ------------------------------------------------------- O id do documento
 *
 * O id é o HASH dos quatro campos normalizados (curso, turma, semestre, ano),
 * pelo mesmo caminho que `chaveDedup_` usa nas inscrições. A escolha compra a
 * unicidade do requisito 2 de graça e de forma ATÔMICA: duas disciplinas iguais
 * não são impedidas por uma consulta nossa que outra execução pode furar, e sim
 * pelo 409 ALREADY_EXISTS do `createDocument` (ver `inserir` em 02_Repo.gs). É a
 * mesma decisão de `inscricoes/{hash_dedup}`, `matriculados/{matricula}` e
 * `alunos/{id determinístico}` — nesta casa, chave de negócio é endereço.
 *
 * O QUE ISSO CUSTA, dito antes de alguém descobrir:
 *
 *   1. Editar qualquer um dos quatro campos MUDA O ENDEREÇO do documento. A
 *      edição deixa de ser um PATCH e vira criar-no-endereço-novo + apagar-o-
 *      velho, duas escritas que não são atômicas entre si. Se a segunda falhar,
 *      sobram duas linhas na tela — visível, e resolvido apagando uma. O modo de
 *      falha é feio, não silencioso, e é o que se aceita aqui.
 *   2. `criado_em` e `criado_por` são CARREGADOS do documento velho para o novo,
 *      senão toda edição zeraria a autoria.
 *   3. O id não é legível no console do Firebase. Aceito: quem precisa ler o
 *      cadastro lê os quatro campos DENTRO do documento, que estão lá em texto.
 *      Um id legível exigiria fatiar nomes de curso longos ('PRÁTICA
 *      INTERDISCIPLINAR EXTENSIONISTA I') num teto de caracteres, e duas
 *      disciplinas que só diferem depois do corte virariam a mesma — a unicidade
 *      passaria a RECUSAR cadastro legítimo. Hash tem largura fixa e não corta.
 *
 * O que a escolha do id NÃO custa: inscrição órfã. Inscrição guarda o TEXTO da
 * disciplina em `curso_fase` (04_Inscricoes.gs:265), nunca uma referência ao
 * documento. Mudar o endereço não desliga nada — e é justamente por isso que a
 * recusa de exclusão (`removerDisciplina`) precisa contar por TEXTO, não por id.
 *
 * -------------------------------------------------- O custo da rota pública
 *
 * `?api=config` é o caminho dos 500 alunos do auditório. Ela custava UMA leitura
 * (o documento único de configuração) e passa a custar 1 + D, com D = número de
 * disciplinas ATIVAS — uma consulta cobra um documento por documento devolvido.
 * Com as 13 de hoje são 14 leituras por montagem, contra 1.
 *
 * Para o evento isso é irrelevante: a rota é cacheada por 30 s (`rotaCacheada_`
 * em 08_Api.gs), então 500 alunos em meia hora pagam 60 montagens, não 500.
 * O que NÃO é irrelevante é o cenário 2 do cabeçalho de 08_Api.gs — a enxurrada
 * anônima. Lá o teto do dia é o número de janelas de 30 s (2.880) vezes o custo
 * da montagem. Com D=20, `?api=config` sozinha passaria a poder torrar
 * 2.880 × 21 = 60.480 leituras, acima das 50 mil do plano Spark: a rota voltaria
 * a ser o botão de desligar o sistema que aquele cache existe para remover.
 *
 * Por isso a lista pública tem cache PRÓPRIO, de DISCIPLINAS_CACHE_S segundos,
 * por dentro do cache de 30 s da rota. O teto sustentado volta para
 * 2.880 × 1 + 288 × D. Disciplina muda umas poucas vezes por semestre, e toda
 * escrita deste arquivo descarta a entrada — a janela longa só atrasa quem mexer
 * no banco POR FORA do painel.
 */

var DISCIPLINAS_COLECAO = 'disciplinas';

/**
 * Coleção das inscrições. Quem grava nela é 04_Inscricoes.gs, e é dele o nome
 * canônico; aqui só se CONTA e se LISTA por `curso_fase`. Repetido de propósito,
 * pelo mesmo motivo que 09_Projetos.gs e 10_Painel.gs repetem os nomes deles:
 * para a guarda de exclusão não depender da ordem de carregamento dos arquivos.
 * Repetido é aceitável; DIVERGENTE não — o Apps Script não reclama, a última
 * declaração vence em silêncio, e a guarda passaria a contar uma coleção vazia,
 * liberando a exclusão de toda disciplina com inscritos. Há teste comparando os
 * dois valores.
 */
var INSCRICOES_COLECAO = 'inscricoes';

/**
 * A lista oficial da secretaria — `_id` = matrícula normalizada.
 *
 * Repetida aqui pelo mesmo motivo e com o mesmo risco de `INSCRICOES_COLECAO`
 * logo acima: divergir faria `matriculadosDaDisciplina` cruzar contra uma coleção
 * vazia e responder que a turma INTEIRA está sem projeto — uma lista de chamada
 * de gente para cobrar que não devia nada. Há teste comparando os quatro
 * arquivos que a declaram.
 */
var MATRICULADOS_COLECAO = 'matriculados';

/**
 * Teto de documentos que o painel traz de uma vez.
 *
 * A tela filtra no NAVEGADOR, e não no servidor: `listar` aceita UM `fieldFilter`
 * só (02_Repo.gs), e os quatro filtros que o Jonathan pediu não cabem numa
 * consulta — seriam quatro consultas, ou uma varredura com peneira. Com dezenas
 * de disciplinas, mandar a lista inteira e filtrar no navegador é mais barato
 * (zero leitura por tecla digitada) e instantâneo. O teto existe para o dia em
 * que "dezenas" virar outra coisa: acima dele a tela DIZ que cortou.
 */
var DISCIPLINAS_MAX = 500;

/** Teto da lista pública. Mesmo motivo, outro caminho — este é o do aluno. */
var DISCIPLINAS_MAX_FORMULARIO = 300;

/** Linhas por janela de inclusão em lote. Trinta é mais do que a secretaria manda. */
var DISCIPLINAS_MAX_LOTE = 30;

/**
 * Teto da lista "quem escolheu esta disciplina".
 *
 * Duzentas leituras por clique, ~0,4% da cota do dia. É caro para o caminho do
 * aluno e barato para um botão que 2 ou 3 professores apertam — a mesma régua de
 * PAINEL_TETO_VARREDURA (10_Painel.gs).
 */
var DISCIPLINAS_MAX_INSCRITOS = 200;

/**
 * Tetos do cruzamento "quem desta turma ainda não se inscreveu".
 *
 * Os dois lados são lidos, e por isso são dois tetos. Ver o cabeçalho de
 * `matriculadosDaDisciplina` para a conta inteira.
 *
 * TURMA = 500: a maior turma do CESUTECH tem algumas dezenas de alunos, e 500 é
 * uma ordem de grandeza acima. Turma acima disso é sinal de que o filtro casou
 * com outra coisa (uma turma vazia na lista oficial casando com tudo), e ler
 * 2.500 documentos por engano é o que este número impede.
 *
 * CRUZAMENTO = 2.000: quatro vezes o evento inteiro (400 a 500 inscrições). É o
 * teto que existe para o dia em que a coleção crescer sem ninguém reparar — não é
 * o custo esperado, que é o número REAL de inscrições. Quando ele é atingido, a
 * resposta diz, porque uma varredura cortada aqui produz falso "SEM PROJETO".
 */
var DISCIPLINAS_MAX_TURMA = 500;
var DISCIPLINAS_MAX_CRUZAMENTO = 2000;

/** Bloco da varredura de inscrições. Menos idas ao banco pelo mesmo custo. */
var DISCIPLINAS_BLOCO = 300;

/** Chave e validade do cache da lista pública. Ver o cabeçalho. */
var DISCIPLINAS_CACHE = 'disciplinas_publicas';
var DISCIPLINAS_CACHE_S = 300;

/** Rótulo da coringa criada pela migração. A coordenação pode editá-lo depois. */
var DISCIPLINA_CORINGA_PADRAO = 'Outra: disciplina não listada';

// ------------------------------------------------------------ Chave e rótulo

/**
 * O id do documento: hash dos quatro campos normalizados.
 *
 * `normalizarTexto` é o que faz 'Work Experience' e 'WORK EXPERIENCE' caírem no
 * mesmo endereço — duas grafias da mesma disciplina são a MESMA disciplina, e o
 * aluno não pode receber duas opções idênticas para escolher.
 */
function chaveDisciplina_(d) {
  return hash([
    normalizarTexto(d.curso),
    normalizarTexto(d.turma),
    normalizarTexto(d.semestre),
    normalizarTexto(d.ano)
  ].join('::'));
}

/**
 * O texto que o aluno lê no `select` — e que fica GRAVADO na inscrição.
 *
 *     ADS11 - PRÁTICA INTERDISCIPLINAR EXTENSIONISTA I (2026/2)
 *
 * A TURMA VEM NA FRENTE, e a razão está na lista real: há quatro "PRÁTICA
 * INTERDISCIPLINAR EXTENSIONISTA" que só se distinguem pelo algarismo no FIM
 * (I, II, III, IV) e pela turma. Com o nome longo na frente, o aluno tem de ler
 * cada linha inteira até o fim para achar a dele; com a turma na frente, ele
 * varre uma coluna curta de códigos e para na primeira que reconhece. É o
 * discriminador curto ocupando a posição que o olho lê primeiro.
 *
 * De brinde, a ordenação de `ordenarDisciplinas_` — que compara o RÓTULO — passa
 * a agrupar a lista por turma em vez de por nome de disciplina, que é a mesma
 * coluna que o aluno está varrendo.
 *
 * ------------------------------------- POR QUE ISTO NÃO PODE SER REPETIDO
 *
 * Este formato JÁ FOI OUTRO. Até 12/08/2026 ele era 'CURSO - TURMA (ano/sem)', e
 * não por gosto: o rótulo é COPIADO para dentro da inscrição, no campo
 * `curso_fase` (04_Inscricoes.gs), e é por esse texto que `inscritosDaDisciplina`
 * e a guarda de `removerDisciplina` procuram. O formato antigo reproduzia
 * exatamente o texto de `cursos_fases`, e era isso que mantinha as inscrições já
 * gravadas casando com a linha do cadastro.
 *
 * A troca só foi possível porque foi feita numa janela específica e conferida
 * contra a produção: ZERO inscrições gravadas. Nenhuma órfã, porque não havia
 * nenhuma. Com as centenas do evento de 14/08 no banco, a MESMA mudança quebraria
 * a busca de todas elas de uma vez — cada inscrição guardaria um texto que não
 * existe mais em disciplina nenhuma, e o professor abriria a lista de inscritos
 * de uma turma cheia e leria "ninguém".
 *
 * Então, para quem estiver lendo isto depois: mudar o formato do rótulo NÃO é uma
 * mudança de apresentação. É uma migração de dado disfarçada. O caminho, se um
 * dia for preciso de novo, é reescrever o `curso_fase` das inscrições existentes
 * no mesmo movimento — ou parar de copiar o texto para dentro delas.
 */
function rotuloDisciplina_(d) {
  var curso = String(d.curso || '').trim();
  var turma = String(d.turma || '').trim();
  var semestre = String(d.semestre || '').trim();
  var ano = String(d.ano || '').trim();

  // Sem turma (a coringa, e as migradas de um texto que não se deixou partir) o
  // rótulo é o curso sozinho — não um ' - ' pendurado na frente.
  var rotulo = turma ? turma + ' - ' + curso : curso;
  if (ano && semestre) rotulo += ' (' + ano + '/' + semestre + ')';
  else if (ano) rotulo += ' (' + ano + ')';

  return rotulo;
}

/**
 * O rótulo no formato ANTIGO ('CURSO - TURMA'), que existe para uma coisa só.
 *
 * `partirCursoFase_` parte o texto de `cursos_fases` em curso e turma e precisa
 * conferir o próprio corte — remontar as duas partes tem de devolver o texto de
 * onde elas saíram. Essa conferência não pode usar `rotuloDisciplina_`: ele agora
 * monta na ordem INVERSA, então a remontagem nunca bateria, e a migração
 * concluiria que todo corte está errado — gravando as treze opções com o texto
 * inteiro como `curso` e nenhuma turma. Silenciosamente, e com a tela toda certa.
 *
 * A chave é que `cursos_fases` está escrita no formato antigo e vai continuar
 * assim: ela é texto legado, congelado, e o único leitor dela é a migração.
 * Conferir um texto antigo com a régua antiga é o que preserva a garantia que
 * interessa (o corte é fiel) sem exigir a que deixou de valer (o rótulo novo é
 * igual ao texto velho — e não é, de propósito).
 */
function rotuloLegado_(d) {
  var curso = String(d.curso || '').trim();
  var turma = String(d.turma || '').trim();
  return turma ? curso + ' - ' + turma : curso;
}

/**
 * Texto do painel -> campos gravados.
 *
 * `turma` sobe para caixa alta porque é código ('ADM61'), e código digitado em
 * caixa baixa é o mesmo código. `curso` mantém a caixa que a coordenação
 * escolheu: é nome próprio de disciplina, e é ele que o aluno lê.
 *
 * As duas réguas moram em 01_Utils.gs desde 12/08/2026 e são as MESMAS que a
 * importação da lista oficial aplica (05_Importacao.gs). Estavam escritas duas
 * vezes, e as duas divergiam: aqui a turma subia para caixa alta, lá não. O
 * cruzamento casa os dois lados por igualdade — a divergência não dava erro
 * nenhum, dava lista vazia.
 */
function normalizarDisciplina_(bruta) {
  bruta = bruta || {};
  return {
    curso: normalizarNomeDeCurso(bruta.curso),
    turma: normalizarTurma(bruta.turma),
    semestre: String(bruta.semestre || '').trim(),
    ano: String(bruta.ano || '').trim()
  };
}

/** A linha veio inteiramente em branco? O botão "nova linha" cria uma dessas. */
function disciplinaVazia_(d) {
  return !d.curso && !d.turma && !d.semestre && !d.ano;
}

/**
 * Erros de uma disciplina, em português de tela.
 *
 * `coringa` valida só o rótulo: ela não é uma turma de verdade, é a saída para o
 * aluno que não achou a dele. Exigir turma/semestre/ano dela seria pedir dado
 * que não existe.
 *
 * `semestre` aceita 1 ou 2 — é o período do ano, e é assim que o rótulo o
 * escreve ('2026/1'). A fase do curso já vem embutida no código da turma
 * (ADM61 = ADM, 6ª fase, turma 1), então não há informação perdida aqui.
 */
function validarDisciplina_(d, coringa) {
  var erros = [];

  if (!d.curso) erros.push('Informe o curso ou a disciplina.');
  else if (d.curso.length > 120) erros.push('Curso muito longo (máximo 120 caracteres).');

  if (coringa) return erros;

  if (!d.turma) erros.push('Informe a turma.');
  else if (d.turma.length > 20) erros.push('Turma muito longa (máximo 20 caracteres).');

  if (!/^[12]$/.test(d.semestre)) erros.push('Semestre deve ser 1 ou 2.');
  if (!/^\d{4}$/.test(d.ano)) erros.push('Ano deve ter quatro dígitos (ex.: 2026).');

  return erros;
}

/**
 * Documento do Firestore -> disciplina para a tela.
 *
 * `id` vem do nome do documento e não de um campo gravado — mesmo contrato de
 * `projetoDe_` (09_Projetos.gs). Um campo `id` seria uma cópia do endereço,
 * livre para divergir dele, e aqui o endereço é derivado dos dados: divergiria
 * na primeira edição.
 */
function disciplinaDe_(documento) {
  if (!documento) return null;

  var d = normalizarDisciplina_(documento);
  return {
    id: documento._id,
    curso: d.curso,
    turma: d.turma,
    semestre: d.semestre,
    ano: d.ano,
    rotulo: rotuloDisciplina_(d),
    ativo: String(documento.ativo).toUpperCase() === 'SIM',
    coringa: String(documento.coringa).toUpperCase() === 'SIM',
    criado_em: documento.criado_em || '',
    criado_por: documento.criado_por || '',
    atualizado_em: documento.atualizado_em || ''
  };
}

/**
 * Ordem de exibição, com a coringa SEMPRE por último.
 *
 * "aparece SEMPRE POR ÚLTIMO na lista do formulário, nunca no meio" é requisito,
 * e não estética: a coringa é a saída de emergência, e uma saída de emergência no
 * meio da lista é escolhida por engano. A ordenação é feita aqui, em JavaScript,
 * e não no `orderBy` da consulta — filtrar por `ativo` e ordenar por OUTRO campo
 * exigiria índice composto declarado no console, que é passo manual repetido a
 * cada ambiente novo (ver a armadilha 1 no cabeçalho de `listar`).
 */
function ordenarDisciplinas_(lista) {
  return lista.sort(function (a, b) {
    if (a.coringa !== b.coringa) return a.coringa ? 1 : -1;
    return normalizarTexto(a.rotulo).localeCompare(normalizarTexto(b.rotulo));
  });
}

// ------------------------------------------------------------ Lista pública

/**
 * Os rótulos que o formulário mostra. Chamada por `dadosFormularioPublico_`
 * (08_Api.gs) e por mais ninguém.
 *
 * TRÊS caminhos, e os dois de exceção existem por causa do mesmo defeito, que já
 * recusou inscrição de verdade: `select` vazio faz toda inscrição morrer com
 * "Selecione seu curso e fase", e o sistema PARECE quebrado sem estar. Então:
 *
 *   coleção com disciplinas ativas .... é a resposta, e vai para o cache
 *   coleção vazia .................... cai em `cursos_fases`, SEM cachear
 *   consulta falhou .................. cai em `cursos_fases`, SEM cachear
 *
 * Não cachear os dois fallbacks é deliberado. Coleção vazia é estado transitório
 * — dura até alguém rodar `migrarDisciplinas` —, e guardá-lo por cinco minutos
 * faria a migração parecer não ter funcionado. Falha de rede guardada por cinco
 * minutos é uma indisponibilidade de um segundo virando cinco minutos de lista
 * velha. O preço de não cachear é uma consulta por janela de 30 s enquanto o
 * cadastro estiver vazio: exatamente o que a rota já custava antes desta fase.
 */
function cursosFasesAtivos_() {
  var cache = cacheDeDisciplinas_();

  if (cache) {
    var guardado = null;
    try {
      guardado = cache.get(DISCIPLINAS_CACHE);
    } catch (e) {
      console.error('cache get ' + DISCIPLINAS_CACHE + ': ' + e.message);
    }
    if (guardado) {
      try {
        return JSON.parse(guardado);
      } catch (e) {
        // Entrada ilegível é entrada que não existe — cache é memória de fora.
        console.error('cache ilegível em ' + DISCIPLINAS_CACHE + ': ' + e.message);
      }
    }
  }

  var rotulos;
  try {
    rotulos = rotulosAtivos_();
  } catch (e) {
    console.error('cursosFasesAtivos_: ' + e.message);
    return configLista('cursos_fases');
  }

  if (!rotulos.length) return configLista('cursos_fases');

  if (cache) {
    try {
      cache.put(DISCIPLINAS_CACHE, JSON.stringify(rotulos), DISCIPLINAS_CACHE_S);
    } catch (e) {
      console.error('cache put ' + DISCIPLINAS_CACHE + ': ' + e.message);
    }
  }
  return rotulos;
}

/**
 * Só as ATIVAS, ordenadas, com a coringa no fim.
 *
 * Filtro de igualdade em um campo, sem ordenação declarada: `listar` ordena por
 * `__name__` ASCENDENTE, que é o desempate embutido em todo índice automático de
 * campo único. Não exige índice composto — e não é a armadilha do `__name__`
 * DESCENDENTE, que exigiria.
 */
function rotulosAtivos_() {
  var itens = listar(DISCIPLINAS_COLECAO, {
    campo: 'ativo',
    valor: 'SIM',
    limite: DISCIPLINAS_MAX_FORMULARIO
  }).itens.map(disciplinaDe_);

  return ordenarDisciplinas_(itens).map(function (d) { return d.rotulo; });
}

/** Descarta a lista pública guardada. Chamada por TODA escrita deste arquivo. */
function invalidarCacheDisciplinas_() {
  var cache = cacheDeDisciplinas_();
  if (!cache) return;
  try {
    cache.remove(DISCIPLINAS_CACHE);
  } catch (e) {
    console.error('cache remove ' + DISCIPLINAS_CACHE + ': ' + e.message);
  }
}

/**
 * O cache do SCRIPT, e não o do usuário: o ganho está em uma execução aproveitar
 * o que outra montou — e aqui as execuções são de alunos anônimos diferentes.
 * Fora do Apps Script (os testes em Node) `CacheService` pode não existir, e o
 * caminho sem cache é mais caro e igualmente correto.
 */
function cacheDeDisciplinas_() {
  try {
    return CacheService.getScriptCache();
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------ Painel: leitura

/**
 * Todas as disciplinas, ativas e inativas, para a aba do painel.
 *
 * Sem filtro no servidor de propósito — ver DISCIPLINAS_MAX. Uma consulta, D
 * documentos, e a tela peneira o resto.
 */
function listarDisciplinas(payload) {
  try {
    exigirAdmin(payload && payload.token);

    var itens = listar(DISCIPLINAS_COLECAO, { limite: DISCIPLINAS_MAX }).itens.map(disciplinaDe_);
    var resposta = { ok: true, itens: ordenarDisciplinas_(itens) };

    // Lista cortada pelo teto tem de DIZER que foi cortada. O modo de falha
    // silencioso — a disciplina 501 sumindo da tela sem erro — faria a
    // coordenação concluir que ela foi apagada.
    if (itens.length === DISCIPLINAS_MAX) {
      resposta.aviso = 'Mostrando as primeiras ' + DISCIPLINAS_MAX + ' disciplinas. ' +
        'Há mais no cadastro — apague ou inative as de semestres encerrados.';
    }
    return resposta;
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Quem escolheu esta disciplina na inscrição.
 *
 * É o ponto inteiro da coringa: sem esta lista, "Outra: disciplina não listada"
 * seria só uma opção a mais no `select`, e o professor não teria como descobrir
 * quem a marcou nem por quê. Serve para qualquer linha, e não só para a coringa,
 * porque é a mesma consulta.
 *
 * O casamento é por TEXTO — `curso_fase` guarda o rótulo, nunca o id (ver o
 * cabeçalho). Consequência que precisa estar dita: editar uma disciplina muda o
 * rótulo, e as inscrições gravadas com o rótulo ANTIGO deixam de aparecer aqui.
 * Elas não se perdem (continuam na inscrição e na exportação); param de casar com
 * esta linha do cadastro.
 */
function inscritosDaDisciplina(payload) {
  try {
    exigirAdmin(payload && payload.token);

    var disciplina = disciplinaDe_(ler(DISCIPLINAS_COLECAO, String((payload && payload.id) || '')));
    if (!disciplina) return { ok: false, erro: 'Disciplina não encontrada. Recarregue a lista.' };

    var itens = listar(INSCRICOES_COLECAO, {
      campo: 'curso_fase',
      valor: disciplina.rotulo,
      limite: DISCIPLINAS_MAX_INSCRITOS
    }).itens.map(function (i) {
      return {
        matricula: i.matricula || '',
        nome: i.nome || '',
        email: i.email || '',
        projeto: i.projeto_nome || '',
        criado_em: i.criado_em || ''
      };
    });

    var resposta = { ok: true, rotulo: disciplina.rotulo, itens: itens };
    if (itens.length === DISCIPLINAS_MAX_INSCRITOS) {
      resposta.aviso = 'Mostrando as primeiras ' + DISCIPLINAS_MAX_INSCRITOS +
        ' inscrições. Use Exportar CSV na aba Alunos para a lista completa.';
    }
    return resposta;
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * O OUTRO LADO: quem da turma desta disciplina está — e quem NÃO está — em algum
 * projeto de extensão.
 *
 * `inscritosDaDisciplina`, logo acima, responde "quem escolheu este texto no
 * formulário". A pergunta da coordenação no dia do evento é a inversa, e nenhuma
 * consulta sobre `inscricoes` a responde: "quem de ADS11 ainda não se inscreveu
 * em projeto nenhum?" — porque quem não se inscreveu NÃO TEM documento em
 * `inscricoes`. A ausência não é consultável; ela só aparece cruzando com a lista
 * de quem deveria estar lá.
 *
 * ------------------------------------------------- Por que a TURMA, e não o texto
 *
 * O casamento é `matriculados.turma` == `disciplina.turma`, e não `curso_fase`.
 * `curso_fase` é o que o ALUNO escolheu num `select`, gravado como texto: ele erra,
 * ele escolhe a coringa, e o texto MUDA quando a coordenação edita a disciplina —
 * as inscrições antigas guardam o rótulo velho e param de casar (está dito no
 * cabeçalho de `inscritosDaDisciplina`). Uma lista de chamada montada sobre esse
 * campo acusaria de "não se inscreveu" quem se inscreveu escolhendo errado. A
 * lista da secretaria não depende do dedo de ninguém.
 *
 * ------------------------------------------------------------------- O custo
 *
 * As DUAS coleções são lidas, e esta é a função mais cara desta aba:
 *
 *   1                      a disciplina (leitura de ponto)
 *   + min(T, 500)          os matriculados da turma — UM filtro de igualdade
 *   + min(I, 2.000)        as inscrições, varridas em blocos de 300
 *   + 1 agregação          SÓ quando a varredura foi cortada, para o aviso poder
 *                          dizer o tamanho do buraco
 *
 * Com os números reais do CESUTECH — turma de ~40, ~500 inscrições no fim do
 * evento — dá 1 + 40 + 500 = ~541 leituras por clique, ou 1,1% das 50 mil do dia.
 * No teto absoluto são 2.501 (5%). Abrir as treze turmas seguidas custa ~7.000
 * (14%), e é por isso que a tela é de UMA TURMA POR VEZ: não existe botão que
 * varra o cadastro inteiro, e a turma é justamente como a coordenação pergunta.
 *
 * A parte cara é a varredura de `inscricoes`, e ela não tem como encolher aqui:
 * saber se o aluno X está em algum projeto exige olhar TODAS as inscrições, porque
 * o único campo que ligaria uma inscrição a esta turma é o `curso_fase` de que
 * esta função desconfia por construção. A alternativa — uma consulta por matrícula
 * — trocaria 500 leituras por T IDAS AO BANCO (~300 ms cada): uma turma de 40
 * viraria 12 segundos de espera, e uma de 100 encostaria nos 32 segundos que já
 * fizeram o segundo salto voltar 404 em produção (ver o cabeçalho de
 * `rotaDoPainel_`, 08_Api.gs). Menos leituras e mais chance de a tela morrer.
 *
 * O CAMINHO BARATO QUE EXISTE E NÃO FOI USADO, dito para ninguém "descobrir" e
 * trocar: a coleção `alunos` já tem `turma` e `projeto` no mesmo documento
 * (`montarAluno_`, 06_Reconciliacao.gs), e responderia isto com ~40 leituras. Ela
 * é DERIVADA, reconstruída pela reconciliação — durante o evento ela é o retrato
 * da última rodada, não do minuto. Quem se inscreveu há dez minutos apareceria
 * como SEM PROJETO. Numa tela que existe para cobrar quem falta, esse erro tem
 * nome: mandar procurar um aluno que já está matriculado. Fica registrado como o
 * caminho de DEPOIS do evento, quando a pergunta for de relatório e não de
 * balcão — aí `alunos` está fresca e custa quarenta leituras.
 *
 * ------------------------------------------------------------- Os três grupos
 *
 *   COM_PROJETO    está na lista oficial da turma E tem inscrição. Mostra QUAL
 *                  projeto, e o que a pessoa declarou no formulário — é aí que
 *                  aparece quem é de ADS11 e escolheu "ADS12" no `select`;
 *   SEM_PROJETO    está na lista oficial da turma e não tem inscrição nenhuma.
 *                  É a resposta da pergunta;
 *   FORA_DA_LISTA  tem inscrição declarando ESTA disciplina e a lista oficial
 *                  desta turma não o tem.
 *
 * O terceiro grupo é o que impede a conta de perder gente, e a decisão que ele
 * carrega precisa estar escrita: quem manda em "pertence à turma" é a LISTA
 * OFICIAL. Então o aluno que se inscreveu declarando ADS11 mas consta como ADS12
 * na secretaria NÃO entra como se fosse de ADS11 — ele aparece em FORA_DA_LISTA,
 * com o que declarou à vista, para a coordenação decidir qual dos dois cadastros
 * está errado. Cair no silêncio seria pior nas duas pontas: some de ADS11 sem
 * explicação e some de ADS12, onde ele nem declarou nada.
 *
 * O grupo também recolhe quem digitou a matrícula errada (não casa com
 * matriculado nenhum) e quem se inscreveu sem matrícula, em projeto aberto à
 * comunidade. Nos três casos a pessoa EXISTE e está na tela.
 *
 * Ele é limitado a quem DECLAROU esta disciplina, e não a "toda inscrição que não
 * é da turma": sem esse corte, o grupo seria a coleção inteira de inscrições em
 * toda abertura de tela.
 */
function matriculadosDaDisciplina(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var disciplina = disciplinaDe_(ler(DISCIPLINAS_COLECAO, String(payload.id || '')));
    if (!disciplina) return { ok: false, erro: 'Disciplina não encontrada. Recarregue a lista.' };

    // A turma pode vir do painel: é a saída manual para quando o cadastro da
    // disciplina e a lista oficial não se encontram (turma escrita de outro jeito,
    // disciplina cadastrada sem turma).
    //
    // ELA PASSA PELA MESMA `normalizarTurma` DOS DOIS LADOS, e isso é a decisão do
    // trecho. Até 12/08/2026 este campo era o remendo do defeito: a importação
    // gravava 'Ads11' e o cadastro comparava 'ADS11', então a saída de emergência
    // era digitar aqui a forma exata que estava gravada. O conserto foi para a
    // ESCRITA (05_Importacao.gs), e um campo que NÃO normalizasse continuaria
    // carregando o defeito — a coordenação digitaria 'ads11', o Firestore
    // compararia por igualdade e a tela responderia "ninguém" sobre uma turma
    // cheia, que é exatamente o que se estava consertando.
    //
    // O que se perde com isso, dito por inteiro: turma gravada em caixa mista por
    // uma importação ANTIGA deixa de ser alcançável digitando-a aqui. O remédio
    // dela é reimportar o mesmo arquivo — o id do documento é a matrícula, então
    // reescrever é escrever o mesmo —, e é o que o aviso de lista vazia manda
    // fazer.
    var turma = normalizarTurma(
      (payload.turma === undefined || payload.turma === null) ? disciplina.turma : payload.turma
    ).slice(0, 40);   // 40 = PAINEL_MAX_TURMA (10_Painel.gs)

    if (!turma) {
      return {
        ok: false,
        erro: disciplina.coringa
          ? 'A disciplina coringa não é uma turma de verdade — ela é a saída para quem não achou ' +
            'a dele, e não existe lista oficial para cruzar. Use "Escolheram esta disciplina" ' +
            'para ver quem a marcou.'
          : 'Esta disciplina está sem turma no cadastro, e é a turma que casa com a lista oficial ' +
            'da secretaria. Informe a turma na edição da disciplina, ou digite-a aqui.'
      };
    }

    // UM filtro de igualdade, sem ordenação declarada: `listar` ordena por
    // `__name__` ASCENDENTE, coberto pelo índice automático de campo único. Ver
    // a armadilha 1 no cabeçalho de `listar` (02_Repo.gs).
    var oficiais = listar(MATRICULADOS_COLECAO, {
      campo: 'turma',
      valor: turma,
      limite: DISCIPLINAS_MAX_TURMA
    }).itens;

    var varredura = varrerInscricoes_(DISCIPLINAS_MAX_CRUZAMENTO);

    var itens = [];
    var daTurma = {};

    oficiais.forEach(function (m) {
      // O `_id` do documento É a matrícula normalizada (05_Importacao.gs). O
      // campo `matricula` guarda a mesma coisa; a chave sai dos dois, na ordem,
      // para o cruzamento não depender de um deles ter sido gravado.
      var chave = normalizarMatricula(m.matricula || m._id);
      if (chave) daTurma[chave] = true;

      var inscricoes = (chave && Object.prototype.hasOwnProperty.call(varredura.porMatricula, chave))
        ? varredura.porMatricula[chave]
        : [];

      itens.push({
        grupo: inscricoes.length ? 'COM_PROJETO' : 'SEM_PROJETO',
        matricula: m.matricula || m._id || '',
        nome: m.nome || '',
        email: m.email || '',
        telefone: m.telefone || '',
        curso: m.curso || '',
        turma: m.turma || '',
        situacao: m.situacao || '',
        // Todos os projetos, e não o primeiro: uma pessoa pode estar em dois, e
        // mostrar só um faria a tela mentir por omissão.
        projetos: inscricoes.map(function (i) {
          return i.projeto + (i.em_espera ? ' (em espera)' : '');
        }).join(' · '),
        // O que ela escolheu no formulário. Divergir da turma oficial não é erro
        // desta função — é o que ela põe à vista.
        declarou: inscricoes.length ? inscricoes[0].curso_fase : '',
        inscrita_em: inscricoes.length ? inscricoes[0].criado_em : ''
      });
    });

    varredura.todas.forEach(function (i) {
      if (i.curso_fase !== disciplina.rotulo) return;
      var chave = normalizarMatricula(i.matricula);
      if (chave && Object.prototype.hasOwnProperty.call(daTurma, chave)) return;

      itens.push({
        grupo: 'FORA_DA_LISTA',
        matricula: i.matricula || '',
        nome: i.nome || '',
        email: i.email || '',
        telefone: '',
        curso: '',
        turma: '',
        situacao: '',
        projetos: i.projeto + (i.em_espera ? ' (em espera)' : ''),
        declarou: i.curso_fase,
        inscrita_em: i.criado_em
      });
    });

    itens.sort(function (a, b) { return chaveNome(a.nome).localeCompare(chaveNome(b.nome)); });

    var resumo = { comProjeto: 0, semProjeto: 0, foraDaLista: 0 };
    itens.forEach(function (i) {
      if (i.grupo === 'COM_PROJETO') resumo.comProjeto++;
      else if (i.grupo === 'SEM_PROJETO') resumo.semProjeto++;
      else resumo.foraDaLista++;
    });

    var resposta = {
      ok: true,
      rotulo: disciplina.rotulo,
      turma: turma,
      itens: itens,
      resumo: resumo,
      // O que foi LIDO do banco, para a tela poder dizê-lo. Número de leitura na
      // tela não é curiosidade: é o que permite a alguém desconfiar da conta
      // antes de agir sobre ela.
      lidas: { matriculados: oficiais.length, inscricoes: varredura.lidas },
      avisos: []
    };

    if (!oficiais.length) {
      resposta.avisos.push(
        'Nenhum matriculado com a turma exatamente "' + turma + '" na lista oficial. ' +
        'A comparação é exata: maiúsculas não separam mais (os dois lados sobem para caixa alta), ' +
        'mas acentos e espaços sim. Se a lista foi importada antes de 12/08/2026, a turma pode ter ' +
        'sido gravada como veio da secretaria ("Ads11") — reimporte o mesmo arquivo, que reescreve ' +
        'cada aluno no lugar dele e normaliza a turma. Enquanto isso, ' +
        'ninguém desta turma pode ser contado como "sem projeto".');
    }

    if (oficiais.length === DISCIPLINAS_MAX_TURMA) {
      resposta.avisos.push(
        'A turma bateu no teto de ' + DISCIPLINAS_MAX_TURMA + ' matriculados lidos e pode ter mais. ' +
        'Quem ficou de fora não aparece em nenhum dos grupos.');
    }

    if (varredura.truncado) {
      // A agregação só acontece aqui, e é o único lugar em que ela se paga: o
      // aviso precisa dizer o TAMANHO do buraco, senão ele vira "pode faltar
      // alguém", que ninguém sabe o que fazer com.
      var total = contar(INSCRICOES_COLECAO);
      resposta.truncado = true;
      resposta.avisos.push(
        'Li as ' + varredura.lidas + ' primeiras inscrições de ' + total + '. Quem estiver nas ' +
        Math.max(0, total - varredura.lidas) + ' restantes aparece aqui como SEM PROJETO sem estar — ' +
        'confira na aba Alunos antes de cobrar alguém desta lista.');
    }

    return resposta;
  } catch (err) {
    console.error('matriculadosDaDisciplina: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * Todas as inscrições, em blocos, até o teto — indexadas por matrícula.
 *
 * Sem filtro, ordenadas por `__name__` ASCENDENTE (o padrão de `listar`), com
 * paginação por cursor: o mesmo desenho de `varrerAlunos_` (10_Painel.gs), e pelo
 * mesmo motivo — o cursor salta no índice, e a página 5 custa o mesmo que a 1.
 *
 * O teto é PARÂMETRO obrigatório, e não um padrão escondido: não existe chamada
 * desta função sem limite, e é isso que impede a coleção inteira de virar o custo
 * de um clique quando ela crescer.
 *
 * `truncado` volta separado de `lidas` porque significa outra coisa: `lidas` é o
 * que se pagou, `truncado` é o que ficou fora — e é o segundo que transforma a
 * resposta em "não confie nesta lista".
 *
 * `porMatricula` guarda uma LISTA por matrícula, e não um documento: a mesma
 * pessoa pode estar inscrita em mais de um projeto (a chave de dedup inclui o
 * `projeto_id`, ver `chaveDedup_` em 04_Inscricoes.gs), e o último a chegar
 * apagaria o anterior.
 */
function varrerInscricoes_(teto) {
  var porMatricula = {};
  var todas = [];
  var lidas = 0;
  var cursor = null;

  do {
    var resposta = listar(INSCRICOES_COLECAO, { limite: DISCIPLINAS_BLOCO, cursor: cursor });
    lidas += resposta.itens.length;

    resposta.itens.forEach(function (i) {
      var linha = {
        matricula: i.matricula || '',
        nome: i.nome || '',
        email: i.email || '',
        projeto: i.projeto_nome || '',
        curso_fase: i.curso_fase || '',
        em_espera: String(i.em_espera).toUpperCase() === 'SIM',
        criado_em: i.criado_em || ''
      };
      todas.push(linha);

      // Inscrição sem matrícula (projeto aberto à comunidade, onde ela não é
      // exigida) não entra no índice: ela não tem como casar com a lista
      // oficial. Continua em `todas`, que é o que o grupo FORA_DA_LISTA lê.
      var chave = normalizarMatricula(i.matricula);
      if (!chave) return;
      if (!Object.prototype.hasOwnProperty.call(porMatricula, chave)) porMatricula[chave] = [];
      porMatricula[chave].push(linha);
    });

    cursor = resposta.cursor;
  } while (cursor && lidas < teto);

  return { porMatricula: porMatricula, todas: todas, lidas: lidas, truncado: Boolean(cursor) };
}

// ------------------------------------------------------------ Painel: escrita

/**
 * Inclusão em LOTE — a janela com uma linha por disciplina.
 *
 * O QUE ACONTECE COM LINHA INCOMPLETA: nada é gravado, e a resposta diz o número
 * da linha e o que falta nela. A alternativa (gravar as completas e listar as que
 * ficaram de fora) foi recusada por um motivo prático: a janela continua aberta
 * com tudo o que foi digitado, então recusar não perde nada — mas gravar metade
 * deixaria a coordenação com um lote pela metade e uma janela que ela não sabe se
 * pode fechar. Corrigir a linha e clicar de novo é um gesto; reconstruir o que
 * entrou e o que não entrou são cinco.
 *
 * Linha inteiramente em branco não é erro, é ignorada: o botão "nova linha"
 * costuma deixar uma sobrando no fim.
 *
 * Duplicata NÃO é erro de validação e não recusa o lote — quem descobre
 * duplicata é o 409 do banco, e a resposta lista as que já existiam. Duas linhas
 * IGUAIS dentro do mesmo lote, sim, são erro de validação: a segunda sempre
 * "já existiria" por causa da primeira, e relatar isso como duplicata do banco
 * esconderia um erro de digitação.
 *
 * Grava com `inserir` um a um, e não com `escreverEmLote`: o lote é upsert
 * (02_Repo.gs) e SOBRESCREVERIA uma disciplina existente, apagando `criado_em`,
 * `criado_por` e o `ativo` que alguém tinha acabado de desligar. São dezenas de
 * escritas, no máximo, disparadas por um clique de painel.
 */
function incluirDisciplinas(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var coringa = Boolean(payload.coringa);
    var brutas = payload.linhas || [];

    if (brutas.length > DISCIPLINAS_MAX_LOTE) {
      return { ok: false, erro: 'No máximo ' + DISCIPLINAS_MAX_LOTE + ' linhas por vez.' };
    }

    var linhas = [];
    var problemas = [];
    var vistas = {};

    brutas.forEach(function (bruta, indice) {
      var d = normalizarDisciplina_(bruta);
      if (disciplinaVazia_(d)) return;

      var erros = validarDisciplina_(d, coringa);

      var chave = chaveDisciplina_(d);
      if (vistas[chave]) {
        erros.push('Repetida: igual à linha ' + vistas[chave] + ' desta mesma janela.');
      } else if (!erros.length) {
        vistas[chave] = indice + 1;
      }

      if (erros.length) problemas.push({ linha: indice + 1, erros: erros });
      else linhas.push({ dados: d, chave: chave });
    });

    if (problemas.length) return { ok: false, problemas: problemas };
    if (!linhas.length) return { ok: false, erro: 'Preencha ao menos uma linha.' };

    if (coringa) {
      var conflito = coringaAtivaOutra_('');
      if (conflito) return { ok: false, erro: recusaDeCoringa_(conflito) };
      if (linhas.length > 1) return { ok: false, erro: 'Só existe uma disciplina coringa por vez.' };
    }

    var agoraStr = agora();
    var usuario = usuarioAtual();
    var criadas = [];
    var jaExistiam = [];
    var falharam = [];

    linhas.forEach(function (linha) {
      var registro = {
        curso: linha.dados.curso,
        turma: linha.dados.turma,
        semestre: linha.dados.semestre,
        ano: linha.dados.ano,
        ativo: 'SIM',
        coringa: coringa ? 'SIM' : 'NAO',
        criado_em: agoraStr,
        criado_por: usuario,
        atualizado_em: agoraStr
      };
      var rotulo = rotuloDisciplina_(linha.dados);

      // try/catch POR LINHA, e não em volta do laço: uma falha de rede na quinta
      // de dez não pode apagar da resposta as quatro que entraram. Quem vê a tela
      // precisa saber exatamente o que ficou no banco.
      try {
        if (inserir(DISCIPLINAS_COLECAO, registro, linha.chave).jaExistia) jaExistiam.push(rotulo);
        else criadas.push(rotulo);
      } catch (e) {
        console.error('incluirDisciplinas ' + rotulo + ': ' + e.message);
        falharam.push(rotulo);
      }
    });

    if (criadas.length) {
      invalidarCacheDisciplinas_();
      // UMA linha de log para o lote, e não uma por disciplina: dez inclusões
      // não são dez decisões da coordenação, são uma.
      registrar('DISCIPLINAS_INCLUIDAS', 'disciplina', '',
        criadas.length + ' incluída(s): ' + criadas.join(' · '));
    }

    return { ok: true, criadas: criadas, jaExistiam: jaExistiam, falharam: falharam };
  } catch (err) {
    console.error('incluirDisciplinas: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * Edita uma disciplina. Como o id é derivado dos campos, editar pode MUDAR O
 * ENDEREÇO — ver o cabeçalho.
 *
 * `ativo` e `coringa` NÃO são editáveis aqui: quem liga e desliga é
 * `alternarDisciplina`, e coringa se decide na criação. Misturar as três coisas
 * na mesma tela é o que fez a caixa "Inscrições abertas" reabrir projeto inativo
 * em silêncio (ver `listarProjetos` em 09_Projetos.gs).
 */
function editarDisciplina(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var idAtual = String(payload.id || '');
    var documento = ler(DISCIPLINAS_COLECAO, idAtual);
    if (!documento) return { ok: false, erro: 'Disciplina não encontrada. Recarregue a lista.' };

    var antiga = disciplinaDe_(documento);
    var nova = normalizarDisciplina_(payload.disciplina);
    var erros = validarDisciplina_(nova, antiga.coringa);
    if (erros.length) return { ok: false, erro: erros.join(' ') };

    var agoraStr = agora();
    var campos = {
      curso: nova.curso,
      turma: nova.turma,
      semestre: nova.semestre,
      ano: nova.ano,
      atualizado_em: agoraStr
    };

    var chaveNova = chaveDisciplina_(nova);

    // Mesmo endereço: nenhum dos quatro campos mudou de verdade (mudou a caixa,
    // um acento ou um espaço). PATCH e pronto.
    if (chaveNova === idAtual) {
      atualizar(DISCIPLINAS_COLECAO, idAtual, campos);
      invalidarCacheDisciplinas_();
      registrar('DISCIPLINA_EDITADA', 'disciplina', idAtual, rotuloDisciplina_(nova));
      return { ok: true, id: idAtual, rotulo: rotuloDisciplina_(nova) };
    }

    // Endereço novo: criar antes de apagar. Nesta ordem, e não na inversa —
    // apagar primeiro e falhar ao criar perderia o registro; criar primeiro e
    // falhar ao apagar deixa duas linhas na tela, que a coordenação resolve
    // apagando uma. Perder dado nunca; sujar a tela, quando não houver escolha.
    var gravacao = inserir(DISCIPLINAS_COLECAO, {
      curso: nova.curso,
      turma: nova.turma,
      semestre: nova.semestre,
      ano: nova.ano,
      ativo: antiga.ativo ? 'SIM' : 'NAO',
      coringa: antiga.coringa ? 'SIM' : 'NAO',
      // Carregados do documento velho: sem isto, toda edição zeraria a autoria.
      criado_em: antiga.criado_em || agoraStr,
      criado_por: antiga.criado_por || usuarioAtual(),
      atualizado_em: agoraStr
    }, chaveNova);

    if (gravacao.jaExistia) {
      return {
        ok: false,
        erro: 'Já existe uma disciplina com esse curso, turma, semestre e ano. ' +
              'Duas iguais viram duas opções idênticas no formulário.'
      };
    }

    excluir(DISCIPLINAS_COLECAO, idAtual);
    invalidarCacheDisciplinas_();
    registrar('DISCIPLINA_EDITADA', 'disciplina', chaveNova,
      antiga.rotulo + ' -> ' + rotuloDisciplina_(nova));

    return { ok: true, id: chaveNova, rotulo: rotuloDisciplina_(nova) };
  } catch (err) {
    console.error('editarDisciplina: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * Ativa ou inativa. INATIVAR é o botão que a tela empurra em vez de excluir:
 * tira do formulário e mantém o histórico inteiro.
 */
function alternarDisciplina(payload) {
  try {
    exigirAdmin(payload && payload.token);
    payload = payload || {};

    var id = String(payload.id || '');
    var documento = ler(DISCIPLINAS_COLECAO, id);
    if (!documento) return { ok: false, erro: 'Disciplina não encontrada. Recarregue a lista.' };

    var disciplina = disciplinaDe_(documento);
    var ativar = Boolean(payload.ativo);

    // Só UMA coringa ativa por vez. A regra é conferida na ATIVAÇÃO, e não na
    // criação apenas: sem isto, criar uma coringa, inativá-la, criar outra e
    // reativar a primeira deixaria duas no formulário.
    if (ativar && disciplina.coringa) {
      var conflito = coringaAtivaOutra_(id);
      if (conflito) return { ok: false, erro: recusaDeCoringa_(conflito) };
    }

    atualizar(DISCIPLINAS_COLECAO, id, { ativo: ativar ? 'SIM' : 'NAO', atualizado_em: agora() });
    invalidarCacheDisciplinas_();
    registrar(ativar ? 'DISCIPLINA_ATIVADA' : 'DISCIPLINA_INATIVADA', 'disciplina', id, disciplina.rotulo);

    return {
      ok: true,
      ativo: ativar,
      mensagem: ativar
        ? 'Disciplina ativada — já aparece no formulário.'
        : 'Disciplina inativada — sai do formulário e o histórico continua.'
    };
  } catch (err) {
    console.error('alternarDisciplina: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * Exclui — e RECUSA quando há inscrição apontando para o rótulo.
 *
 * Excluir e inativar não são a mesma coisa, e a diferença é quem paga: inativar
 * tira do formulário e o histórico fica; excluir some com o registro, e o aluno
 * que escolheu essa disciplina vira dado órfão — a inscrição dele continua
 * dizendo 'WORK EXPERIENCE - ADM61' e não existe mais nada com esse nome para o
 * professor filtrar. Por isso a recusa não é um aviso que dá para ignorar: é um
 * `ok: false` com a saída certa oferecida no texto.
 *
 * UMA agregação por clique, e não uma por linha da lista: mostrar a contagem em
 * toda a tabela custaria D agregações em fila a cada abertura da aba — a mesma
 * conta que fez `listarProjetos` filtrar antes de contar (09_Projetos.gs).
 *
 * Janela conhecida e aceita, igual à de `removerProjeto`: entre contar e excluir,
 * uma inscrição pode entrar. Fechá-la exigiria pôr o clique da coordenação
 * dentro do lock global do formulário, fazendo-a esperar a fila do auditório
 * inteiro. O estrago possível é uma inscrição órfã, rastreável pelo log.
 */
function removerDisciplina(payload) {
  try {
    exigirAdmin(payload && payload.token);

    var id = String((payload && payload.id) || '');
    var documento = ler(DISCIPLINAS_COLECAO, id);
    if (!documento) return { ok: false, erro: 'Disciplina não encontrada. Recarregue a lista.' };

    var disciplina = disciplinaDe_(documento);
    var inscritos = contar(INSCRICOES_COLECAO, { campo: 'curso_fase', valor: disciplina.rotulo });

    if (inscritos > 0) {
      return {
        ok: false,
        inscritos: inscritos,
        erro: 'Não dá para excluir: ' + inscritos + ' inscrição(ões) escolheram "' +
              disciplina.rotulo + '". Apagar deixaria esses alunos apontando para uma ' +
              'disciplina que não existe mais. Use Inativar — ela sai do formulário e o ' +
              'histórico continua inteiro.'
      };
    }

    excluir(DISCIPLINAS_COLECAO, id);
    invalidarCacheDisciplinas_();
    registrar('DISCIPLINA_EXCLUIDA', 'disciplina', id, disciplina.rotulo);

    return { ok: true, mensagem: 'Disciplina excluída.' };
  } catch (err) {
    console.error('removerDisciplina: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * A coringa ATIVA que não é esta, ou null.
 *
 * Uma consulta com filtro de igualdade em `coringa`, peneirando `ativo` em
 * JavaScript: dois campos são DUAS consultas no Firestore, não um AND (a
 * armadilha 2 do briefing), e coringas são meia dúzia no total.
 */
function coringaAtivaOutra_(idIgnorado) {
  var achada = null;

  listar(DISCIPLINAS_COLECAO, { campo: 'coringa', valor: 'SIM', limite: 20 }).itens
    .forEach(function (documento) {
      if (achada) return;
      if (String(documento._id) === String(idIgnorado)) return;
      if (String(documento.ativo).toUpperCase() !== 'SIM') return;
      achada = disciplinaDe_(documento);
    });

  return achada;
}

function recusaDeCoringa_(coringa) {
  return 'Já existe uma disciplina coringa ativa ("' + coringa.rotulo + '"). ' +
    'Duas confundiriam o aluno na hora de escolher — inative a atual antes de ativar outra.';
}

// ------------------------------------------------------------ Migração

/**
 * Cria as disciplinas a partir da chave `cursos_fases`. Rode UMA vez, do editor.
 *
 * Sem sublinhado no fim de propósito: o editor do Apps Script não lista no
 * seletor de função os nomes terminados em '_' — é como ele marca "privada" —, e
 * uma migração que ninguém consegue disparar não migra nada. É a mesma razão de
 * `setup()` existir em 03_Config.gs.
 *
 * O QUE SE PERDE, e é o ponto que precisa estar dito: `cursos_fases` não tem
 * semestre nem ano. Ela guarda 'WORK EXPERIENCE - ADM21' e nada mais. Os
 * registros migrados entram, portanto, SEM esses dois campos — e não com o ano
 * corrente chutado, que seria inventar dado de secretaria dentro de uma função
 * de migração. Quem editar um deles pelo painel vai ter de preenchê-los ali, que
 * é onde a informação existe.
 *
 * O QUE MUDOU EM 12/08/2026, e desfaz uma promessa que este cabeçalho fazia:
 * o rótulo migrado NÃO é mais idêntico ao texto de `cursos_fases`. A turma passou
 * para a frente ('ADM21 - WORK EXPERIENCE' em vez de 'WORK EXPERIENCE - ADM21',
 * ver `rotuloDisciplina_`), então a opção do formulário deixa de se chamar
 * exatamente o que se chamava. A promessa antiga existia para proteger inscrição
 * já gravada, e ela foi desfeita na janela em que não havia nenhuma — conferido
 * contra a produção antes da troca. Não repita fora dessa janela.
 *
 * O ida-e-volta registro a registro CONTINUA, e continua sendo o que impede uma
 * opção com o texto trocado: o que ele confere agora é se o CORTE foi fiel —
 * remontar curso e turma no formato de `cursos_fases` (`rotuloLegado_`) tem de
 * devolver o texto de onde eles saíram. Se não devolver, a migração desiste do
 * corte e grava o texto inteiro como `curso`, que sempre reproduz.
 *
 * Idempotente: `inserir` não sobrescreve, e rodar de novo depois de a
 * coordenação ter corrigido uma turma não desfaz a correção.
 *
 * NÃO apaga `cursos_fases`. A chave continua sendo o fallback de
 * `cursosFasesAtivos_` para o dia em que a coleção estiver vazia.
 */
function migrarDisciplinas() {
  var textos = configLista('cursos_fases');
  var agoraStr = agora();
  var usuario = usuarioAtual();

  var criadas = [];
  var jaExistiam = [];

  textos.forEach(function (texto) {
    var d = partirCursoFase_(texto);
    var chave = chaveDisciplina_(d);

    var gravacao = inserir(DISCIPLINAS_COLECAO, {
      curso: d.curso,
      turma: d.turma,
      semestre: '',
      ano: '',
      // ATIVAS. Assim o formulário passa a servir a mesma lista que servia
      // ontem, com o mesmo texto, no instante da migração — a coordenação
      // corrige depois, com a tela na mão. Migrar inativo faria a lista cair no
      // fallback e a migração parecer não ter acontecido.
      ativo: 'SIM',
      coringa: 'NAO',
      criado_em: agoraStr,
      criado_por: usuario,
      atualizado_em: agoraStr
    }, chave);

    if (gravacao.jaExistia) jaExistiam.push(texto);
    else criadas.push(texto);
  });

  // A coringa não está em `cursos_fases` — ela não existia. Sem criá-la aqui, o
  // recurso só passa a existir depois de alguém montá-la à mão, e o aluno que
  // não achar a disciplina dele continua sem saída.
  var coringa = null;
  if (!coringaAtivaOutra_('')) {
    var dc = normalizarDisciplina_({ curso: DISCIPLINA_CORINGA_PADRAO });
    var gc = inserir(DISCIPLINAS_COLECAO, {
      curso: dc.curso,
      turma: '',
      semestre: '',
      ano: '',
      ativo: 'SIM',
      coringa: 'SIM',
      criado_em: agoraStr,
      criado_por: usuario,
      atualizado_em: agoraStr
    }, chaveDisciplina_(dc));
    if (!gc.jaExistia) coringa = DISCIPLINA_CORINGA_PADRAO;
  }

  invalidarCacheDisciplinas_();
  if (criadas.length || coringa) {
    registrar('DISCIPLINAS_MIGRADAS', 'disciplina', '',
      criadas.length + ' criada(s) a partir de cursos_fases' + (coringa ? ' + a coringa' : ''));
  }

  Logger.log('=== migrarDisciplinas ===');
  Logger.log('opções em cursos_fases: %s', textos.length);
  Logger.log(criadas.length ? 'criadas: ' + criadas.join(' | ') : 'criadas: nenhuma');
  Logger.log(jaExistiam.length ? 'já existiam: ' + jaExistiam.join(' | ') : 'já existiam: nenhuma');
  Logger.log(coringa ? 'coringa criada: ' + coringa : 'coringa: já havia uma ativa, nada a fazer');
  Logger.log('semestre e ano ficaram VAZIOS — cursos_fases não os tinha. Corrija pelo painel.');
  Logger.log('a chave cursos_fases NÃO foi apagada: ela é o fallback da rota pública.');

  return { criadas: criadas, jaExistiam: jaExistiam, coringa: coringa };
}

/**
 * 'WORK EXPERIENCE - ADM21' -> { curso: 'WORK EXPERIENCE', turma: 'ADM21' }.
 *
 * A ENTRADA é `cursos_fases`, que está escrita no formato ANTIGO — curso na
 * frente, turma no fim. Ela é texto legado e congelado; quem mudou de formato foi
 * o rótulo que a tela MOSTRA, não a chave de onde a migração lê.
 *
 * Corta no ÚLTIMO ' - ' e não no primeiro: nomes de disciplina podem trazer o
 * separador no meio, e o código da turma é sempre o último pedaço.
 *
 * A garantia é o ida-e-volta, não o palpite: se remontar as duas partes não
 * devolver o texto original, o corte foi errado e a função desiste dele — o texto
 * inteiro vira `curso`, que reproduz sempre.
 *
 * A remontagem é `rotuloLegado_`, e essa linha é a que precisa de atenção: usar
 * `rotuloDisciplina_` aqui faria a conferência comparar 'ADM21 - WORK EXPERIENCE'
 * com 'WORK EXPERIENCE - ADM21' e concluir que TODO corte está errado. As treze
 * opções entrariam com o texto inteiro no campo `curso` e turma vazia — sem erro,
 * sem aviso, e com a aba Disciplinas parecendo certa até alguém tentar cruzar uma
 * turma que não existe em documento nenhum.
 */
function partirCursoFase_(texto) {
  var inteiro = String(texto || '').trim().replace(/\s+/g, ' ');
  var corte = inteiro.lastIndexOf(' - ');

  if (corte > 0) {
    var candidato = normalizarDisciplina_({
      curso: inteiro.slice(0, corte),
      turma: inteiro.slice(corte + 3)
    });
    if (rotuloLegado_(candidato) === inteiro) return candidato;
  }

  return normalizarDisciplina_({ curso: inteiro });
}
