/**
 * 06_Reconciliacao.gs — o coração do projeto, sobre o Firestore.
 *
 * Cruza `inscricoes` (quem se cadastrou) com `matriculados` (a lista oficial) e
 * produz `alunos`, o registro mestre: um aluno, uma linha.
 *
 * Cascata de casamento, do mais forte para o mais fraco — a mesma do sistema
 * sobre Sheets (o sistema anterior, 06_Reconciliacao.gs), que
 * está validada por uso real e foi portada sem mexer nos limiares:
 *
 *   0. Matrícula idêntica        → confirma sozinho
 *   1. CPF idêntico              → confirma sozinho
 *   2. E-mail idêntico           → confirma sozinho
 *   3. Nome + data de nascimento → confirma sozinho
 *   4. Nome idêntico e único     → marca DIVERGENCIA (precisa de gente)
 *   5. Nome parecido (>= 0.88)   → marca DIVERGENCIA (precisa de gente)
 *
 * Regra que não se quebra: nada que casou por semelhança entra como confirmado.
 * O sistema separa o que é certo do que é palpite, e só o humano promove palpite.
 *
 * A cascata é JavaScript puro sobre dois arrays e não sabe de onde eles vieram —
 * é por isso que ela atravessou a troca de banco intacta. O que mudou é tudo o
 * que está em volta dela.
 *
 * ------------------------------------------------ O que NÃO deu para portar
 *
 * `reconciliar()` terminava em `substituirTudo(TAB.ALUNOS, alunos)`: apaga a aba
 * e regrava. Uma chamada, inofensiva sobre uma planilha, e é por isso que
 * `montarAluno_` podia sortear `uid('alu')` novo a cada rodada — a linha antiga
 * já não existia mais.
 *
 * No Firestore não existe apagar coleção. Portar isso ao pé da letra seria, a
 * cada rodada, criar N documentos novos e deixar N órfãos: com ~2.500 alunos,
 * ~5.000 operações por clique. A reconciliação roda no botão do painel, em toda
 * importação e em toda sincronização do Forms — OITO rodadas num dia consumiriam
 * as 20.000 escritas diárias do plano Spark, e as INSCRIÇÕES parariam até a
 * meia-noite do Pacífico, sem botão para religar.
 *
 * O conserto tem duas partes, e as duas são contrato com as outras fases:
 *
 *   1. ID DETERMINÍSTICO. Mesma pessoa, mesmo documento, sempre — ver
 *      `chaveAluno_`. Não há sorteio em lugar nenhum deste arquivo.
 *   2. UPSERT POR DIFERENÇA. A rodada lê o que já está gravado, compara campo a
 *      campo e só escreve o documento que MUDOU. Numa reconciliação em que nada
 *      mudou, o custo em escrita é ZERO — inclusive o log, que também é uma
 *      escrita e por isso só sai quando houve mudança (ver o fim de
 *      `reconciliar`). Existe teste que roda duas vezes e conta as requisições.
 *
 * ---------------------------------------------------- Uma linha por PESSOA
 *
 * Divergência deliberada, e a única de comportamento neste arquivo: o sistema
 * sobre Sheets produz uma linha por INSCRIÇÃO. Quem se inscreve em dois projetos
 * vira duas linhas — e a segunda entra como SO_INSCRITO, porque o `usados` já
 * consumiu o matriculado na primeira. Isso contradiz a própria frase que abre o
 * arquivo lá ("um aluno, uma linha") e não custava nada lá, onde a linha era
 * descartável.
 *
 * Aqui o id é a identidade da pessoa, então a segunda inscrição ATUALIZA a mesma
 * linha em vez de criar uma segunda: os nomes dos projetos se somam no campo
 * `projeto` e o resto vem da inscrição mais antiga, que é a que casou. O que se
 * ganha não é elegância, é cota: no dia do auditório, 500 alunos que já estavam
 * na lista oficial migram de SO_MATRICULADO para CONFIRMADO. Com id por pessoa
 * isso é uma atualização no lugar (blocos de 500, uma requisição); com id por
 * inscrição seriam 500 exclusões, uma requisição cada, mais 500 criações.
 *
 * ------------------------------------------------------------ Orçamento
 *
 * `reconciliar()` é a função mais cara do sistema, e a única que lê três
 * coleções de uma vez. Ela precisa dos dois lados em memória — a cascata indexa
 * por matrícula, CPF, e-mail e nome+nascimento antes de comparar qualquer coisa
 * — e precisa do terceiro para saber o que já está gravado.
 *
 *   leituras por rodada = |inscricoes| + |matriculados| + |alunos| + 1
 *
 * Com os números reais do CESUTECH — 2.500 matriculados, ~500 inscrições, e
 * portanto ~2.500 alunos — são ~5.500 leituras, contra 50.000 por dia: cabem
 * NOVE rodadas diárias. Com 5.000 de cada lado são ~12.500, e cabem QUATRO. É
 * nessa faixa que o botão "Reconciliar agora" deixa de ser livre e vira operação
 * de uma ou duas vezes por dia; daí para cima o cruzamento tem de sair do Apps
 * Script, ou passar a rodar por recorte (um lote, um curso), o que a cascata não
 * suporta hoje sem mudar de forma.
 *
 * O teto de `RECONCILIACAO_TETO` documentos por coleção é o freio que impede uma
 * coleção inchada de queimar a cota do dia numa chamada. Estourá-lo NÃO devolve
 * resultado parcial: reconciliar com metade dos dados marcaria a outra metade
 * como SO_INSCRITO e mandaria apagar linhas que existem. Recusa e explica.
 *
 * Escritas por rodada: só o que mudou, em blocos de 500 (uma requisição por
 * bloco), mais no máximo 1 do agregado de cursos e 1 do log.
 *
 * Tempo: a etapa 5 da cascata (nome parecido) é a única quadrática — ela compara
 * cada inscrição que falhou os quatro índices contra TODOS os matriculados. Com
 * 500 inscrições sem match e 2.500 matriculados são 1,25 milhão de chamadas a
 * `similaridade`, na casa de dezenas de segundos. Na prática quase toda
 * inscrição casa na etapa 0 (matrícula) e nunca chega lá; o pior caso é uma
 * lista oficial importada com a coluna de matrícula errada — que a importação já
 * recusa (05_Importacao.gs).
 *
 * ------------------------------------------------------- Contrato com o painel
 *
 * 10_Painel.gs lê esta coleção e depende de três coisas, todas cumpridas aqui e
 * todas com teste:
 *
 *   1. o id do documento é determinístico e é ele que volta em `resolverAluno` e
 *      `detalheAluno`. NÃO existe campo `id` — ele vem do nome do documento;
 *   2. `matricula_id` guarda a matrícula normalizada (o id do documento em
 *      `matriculados`) e `inscricao_id` guarda a chave de dedup (o id do
 *      documento em `inscricoes`). É o que faz o detalhe do aluno custar três
 *      leituras de ponto em vez de três varreduras;
 *   3. os campos `cpf` e `email` EXISTEM em todo documento, ainda que vazios —
 *      `painelEstatisticas` conta quem tem CPF como "total menos os que têm o
 *      campo vazio", e no Firestore campo AUSENTE não casa com filtro de
 *      igualdade. `montarAluno_` grava a chave sempre, mesmo em branco.
 *
 * E este arquivo cumpre a outra ponta: é ele que grava `agregados/cursos`, o
 * documento único que o painel lê por 1 leitura para desenhar "Alunos por curso"
 * e o filtro de curso. Quem já percorre todos os alunos é quem pode fazer o
 * agrupamento de graça — ver `atualizarAgregadoDeCursos_`.
 */

/**
 * Coleção dos alunos reconciliados. O nome canônico é daqui.
 *
 * As três declarações repetidas abaixo seguem a convenção do repositório (ver o
 * comentário em 09_Projetos.gs): o nome não pode depender da ordem em que o
 * editor carrega os arquivos. Repetido é aceitável; DIVERGENTE não — o Apps
 * Script não reclama, a última declaração carregada vence em silêncio, e a
 * reconciliação passaria a escrever numa coleção que o painel não lê. Existe
 * teste que compara os arquivos.
 */
var ALUNOS_COLECAO = 'alunos';
var INSCRICOES_COLECAO = 'inscricoes';
var MATRICULADOS_COLECAO = 'matriculados';

/** Onde mora o histograma de alunos por curso que o painel lê por 1 leitura. */
var AGREGADOS_COLECAO = 'agregados';
var AGREGADOS_CURSOS = 'cursos';

/** Limiares da cascata, herdados sem ajuste do sistema em produção. */
var LIMIAR_NOME_APROXIMADO = 0.88;
var LIMIAR_NOME_DIVERGENTE = 0.60;

/**
 * Teto de documentos lidos por coleção numa rodada.
 *
 * 8.000 é acima do teto de uma importação (5.000, 05_Importacao.gs) e bem acima
 * da lista real (~2.500), então nenhuma operação legítima esbarra nele. Ele
 * existe para o caso em que alguma coleção cresce sem que ninguém repare: três
 * coleções no teto são 24.000 leituras, metade da cota do dia numa chamada só, e
 * é aí que a recusa vale mais que o resultado.
 */
var RECONCILIACAO_TETO = 8000;

/** Documentos por página de leitura. Cada página é uma requisição. */
var RECONCILIACAO_BLOCO = 500;

/**
 * Quantas linhas de `alunos` uma rodada pode APAGAR.
 *
 * Sobrou linha é o caso raro: com id por pessoa, aluno que sai da lista oficial e
 * se inscreve continua no MESMO documento. Só some quem perdeu as duas origens —
 * inscrição e matrícula excluídas do banco à mão.
 *
 * Por isso o teto é baixo de propósito. Uma rodada que quer apagar mais de cem
 * linhas não está limpando: ou leu menos do que existe, ou alguém esvaziou uma
 * coleção sem querer. Apagar seria destruir, junto, todas as decisões que a
 * coordenação já tomou nas divergências — trabalho humano que não se recupera.
 * Recusa, conta quantas seriam, e deixa para um humano decidir.
 */
var RECONCILIACAO_MAX_REMOCOES = 100;

/**
 * Quantos cursos distintos cabem no documento de agregados.
 *
 * Um por CAMPO do documento, e é isso que impõe o teto: mapeamento errado na
 * importação (a coluna do nome mapeada para "curso") produziria um campo por
 * aluno, um documento perto do limite de 1 MiB e um `select` de 2.500 opções no
 * painel. Cem cobre qualquer semestre real do CESUTECH — hoje são treze.
 */
var RECONCILIACAO_MAX_CURSOS = 100;

/**
 * Os campos que definem o conteúdo de um aluno, e que a comparação olha.
 *
 * `atualizado_em` está FORA de propósito, e essa ausência é o arquivo inteiro: se
 * ele entrasse na comparação, todo documento seria diferente em toda rodada
 * (`agora()` muda sempre), a diferença nunca seria zero e o upsert por diferença
 * viraria o mesmo "regrava tudo" que este arquivo existe para não fazer. Ele é
 * carimbado só quando algum dos campos abaixo mudou — que é, aliás, o que
 * "atualizado em" deveria significar.
 */
var ALUNO_CAMPOS = ['cpf', 'nome', 'email', 'telefone', 'data_nascimento',
  'matricula', 'matricula_conferida', 'projeto', 'curso', 'turma', 'situacao',
  'status', 'metodo_match', 'score_match', 'inscricao_id', 'matricula_id',
  'revisado_por', 'revisado_em', 'observacoes'];

// ------------------------------------------------------------ A rodada

/**
 * Cruza as duas listas e deixa `alunos` igual ao resultado, escrevendo o mínimo.
 *
 * Devolve o resumo que o `Admin.html` mostra (Admin.html:554) e que
 * `resumoReconciliacao_` (05_Importacao.gs) repassa ao fim de cada importação.
 * Lança quando não dá para confiar no resultado; quem chama pelo painel embrulha
 * em `rodarReconciliacao`.
 */
function reconciliar() {
  var inscricoes = colecaoCompleta_(INSCRICOES_COLECAO);
  var matriculados = colecaoCompleta_(MATRICULADOS_COLECAO);
  var existentes = porId_(colecaoCompleta_(ALUNOS_COLECAO));

  // Ordem cronológica, decidida AQUI e não na consulta. Pedir `ordenarPor:
  // 'criado_em'` ao banco pareceria mais direto e perderia registros: a
  // paginação por cursor recomeça ESTRITAMENTE depois do último valor lido, e
  // duas inscrições do mesmo segundo — 500 alunos no auditório garantem isso —
  // ficariam do lado de fora, caladas. `__name__` é único por construção, então
  // a leitura pagina por ele e a ordem que interessa se faz na memória, de graça.
  inscricoes.sort(porChegada_);

  var idx = indexar_(matriculados);
  var usados = {};
  var calculados = {};
  var ordem = [];
  var juntadas = 0;

  inscricoes.forEach(function (insc) {
    var chave = chaveAluno_(chaveDePessoa_(insc) || ('ins:' + insc._id));

    // Mesma pessoa, segundo projeto: soma o projeto e mantém o resto da
    // inscrição mais antiga, que é a que disputou o casamento com a lista.
    //
    // A conferência vem ANTES da cascata, e a ordem não é economia. A cascata
    // marca em `usados` o matriculado que consumiu, e a segunda inscrição da
    // mesma pessoa não encontraria o dela (já consumido) — desceria os degraus e
    // poderia consumir o de OUTRA pessoa por e-mail de família ou nome parecido.
    // Essa outra pessoa perderia a linha de SO_MATRICULADO sem nada explicar. De
    // quebra, pular a cascata evita o degrau 5, que percorre a lista inteira.
    if (calculados[chave]) {
      calculados[chave].projeto = juntarProjetos_(calculados[chave].projeto, insc.projeto_nome);
      juntadas++;
      return;
    }

    var m = casar_(insc, idx, usados);
    if (m.matriculado) usados[m.matriculado._id] = true;

    calculados[chave] = montarAluno_(insc, m.matriculado, m.metodo, m.score, m.status);
    ordem.push(chave);
  });

  // Quem está na lista oficial mas nunca se inscreveu.
  matriculados.forEach(function (mat) {
    if (usados[mat._id]) return;

    var chave = chaveAluno_(chaveDePessoa_(mat) || ('mat:' + mat._id));
    // A pessoa já tem linha vinda de uma inscrição: o registro de inscrito manda,
    // porque ele carrega contato e projeto. Só acontece quando a cascata deixou
    // o matriculado de fora (homônimo ambíguo) mas a chave da pessoa é a mesma.
    if (calculados[chave]) return;

    calculados[chave] = montarAluno_(null, mat, '', 0, STATUS.SO_MATRICULADO);
    ordem.push(chave);
  });

  var mudados = [];
  var quando = agora();

  ordem.forEach(function (chave) {
    var novo = calculados[chave];
    var atual = existentes[chave];

    preservarRevisao_(novo, atual);
    if (!mudou_(novo, atual)) return;

    novo._id = chave;
    novo.atualizado_em = quando;
    mudados.push(novo);
  });

  var remocao = planejarRemocoes_(existentes, calculados, ordem.length);

  // Escrita em bloco, e não uma chamada por aluno: 2.500 documentos são 5
  // requisições em vez de 2.500, e é a diferença entre caber e não caber nos 6
  // minutos de execução (ver o custo por chamada em `fsToken_`, 02_Repo.gs).
  //
  // Uma falha no meio dos blocos não precisa de compensação, ao contrário do que
  // a importação teve de resolver (05_Importacao.gs): o que ficou de fora
  // continua diferente do calculado, e a próxima rodada o grava. O upsert por
  // diferença é retomável por construção.
  escreverEmLote(ALUNOS_COLECAO, mudados);
  remocao.ids.forEach(function (id) { excluir(ALUNOS_COLECAO, id); });

  var lista = ordem.map(function (chave) { return calculados[chave]; });
  var agregado = atualizarAgregadoDeCursos_(lista);

  var resumo = resumoDe_(lista);
  resumo.escritos = mudados.length;
  resumo.inalterados = ordem.length - mudados.length;
  resumo.removidos = remocao.ids.length;
  resumo.juntadas = juntadas;
  resumo.aviso = remocao.recusa;

  // O log é uma ESCRITA, e por isso não é gratuito. Uma rodada que não mudou
  // nada não tem o que registrar — anotar "reconciliei e estava tudo igual" oito
  // vezes por dia é o mesmo desperdício que `registrarRecusa` (04_Log.gs) existe
  // para evitar, com o agravante de sair da cota de quem se inscreve. Quando
  // houve mudança, ou quando uma remoção foi recusada, o registro sai inteiro.
  if (mudados.length || remocao.ids.length || remocao.recusa || agregado) {
    registrar('RECONCILIACAO', 'alunos', '', JSON.stringify(resumo));
  }

  return resumo;
}

/**
 * Lê uma coleção inteira, paginando, e recusa quando ela não cabe.
 *
 * Sem `ordenarPor`: `listar` cai em `__name__` ascendente, que é o desempate
 * embutido em todo índice automático e não exige índice composto nenhum. Ordenar
 * por campo aqui pediria um índice por coleção e ainda perderia documentos
 * empatados na virada da página.
 *
 * O teto NÃO devolve o que coube. Meia lista de matriculados marcaria a outra
 * metade dos alunos como SO_INSCRITO e ainda apontaria linhas boas como
 * sobrando, prontas para serem apagadas. Resultado parcial aqui é pior que
 * resultado nenhum.
 */
function colecaoCompleta_(colecao) {
  var itens = [];
  var cursor = null;

  do {
    var pagina = listar(colecao, { limite: RECONCILIACAO_BLOCO, cursor: cursor });
    itens = itens.concat(pagina.itens);
    cursor = pagina.cursor;
  } while (cursor && itens.length < RECONCILIACAO_TETO);

  if (cursor) {
    throw new Error(
      'A coleção "' + colecao + '" passou de ' + RECONCILIACAO_TETO + ' documentos e a ' +
      'reconciliação não roda pela metade — ela apagaria linhas boas. O caso comum são ' +
      'listas oficiais de semestres antigos que nunca saíram: vá à aba Importações e use ' +
      '"Apagar matriculados" nos lotes velhos (quem voltou numa lista mais nova não é ' +
      'tocado). A alternativa é ajustar RECONCILIACAO_TETO, sabendo que cada rodada passa ' +
      'a custar mais leituras.'
    );
  }
  return itens;
}

/** Array de documentos -> mapa por id, que é como a diferença é procurada. */
function porId_(itens) {
  var mapa = {};
  itens.forEach(function (item) { mapa[item._id] = item; });
  return mapa;
}

/** Mais antiga primeiro; empate no segundo desempata pelo id, que é único. */
function porChegada_(a, b) {
  var x = String(a.criado_em || '');
  var y = String(b.criado_em || '');
  if (x !== y) return x < y ? -1 : 1;
  return String(a._id) < String(b._id) ? -1 : 1;
}

// ------------------------------------------------------------ Identidade

/**
 * A chave da PESSOA, na mesma ordem de preferência da dedup de inscrições.
 *
 * Matrícula > CPF > e-mail + nome. É de propósito que ela seja a mesma escada da
 * cascata de casamento: duas linhas só recebem a mesma chave quando compartilham
 * matrícula, CPF ou e-mail+nome — exatamente os campos pelos quais a cascata
 * casa. Ou seja, duas linhas que colidem aqui são duas linhas que a cascata já
 * teria unido, e a colisão é o resultado certo, não um acidente.
 *
 * O prefixo separa os espaços: matrícula '123' e CPF '123' não são a mesma
 * pessoa por acaso de dígito.
 *
 * Devolve '' quando não há nada que identifique — quem chama cai para o id do
 * documento de origem, que garante linha própria em vez de fundir estranhos.
 */
function chaveDePessoa_(dados) {
  var matricula = normalizarMatricula(dados.matricula);
  if (matricula) return 'mat:' + matricula;

  var cpf = normalizarCpf(dados.cpf);
  if (cpf.length === 11) return 'cpf:' + cpf;

  var email = normalizarEmail(dados.email);
  var nome = chaveNome(dados.nome);
  if (email || nome) return 'pes:' + email + '|' + nome;

  return '';
}

/**
 * O id do documento em `alunos`: determinístico, derivado da matrícula.
 *
 * `hash` (01_Utils.gs) faz aqui o mesmo trabalho que faz em `chaveDedup_`
 * (04_Inscricoes.gs): largura fixa, alfabeto seguro para URL, e — o que
 * importa — impede que matrícula, CPF ou e-mail virem endereço de documento. Id
 * aparece em URL de API, em log de erro e na tela de quem inspeciona o banco;
 * dado pessoal ali é exposição por descuido de desenho, e ainda deixaria a
 * coleção enumerável por faixa de matrícula.
 *
 * O preço, com o número escrito: são 64 bits (MD5 cortado em 16 hexadecimais).
 * Colisão entre duas pessoas junta duas fichas numa só — visível na tela, com
 * nome trocado, e corrigível. Não é inscrição perdida. Com dez mil alunos a
 * chance é da ordem de 3 em 10^12.
 */
function chaveAluno_(chavePessoa) {
  return hash('aluno::' + chavePessoa);
}

/** Nomes de projeto somados, sem repetir. Uma pessoa cabe em mais de um. */
function juntarProjetos_(atual, novo) {
  var nome = String(novo || '').trim();
  if (!nome) return atual;

  var lista = String(atual || '').split(' | ').filter(function (p) { return p !== ''; });
  if (lista.indexOf(nome) !== -1) return atual;

  lista.push(nome);
  return lista.join(' | ');
}

// ------------------------------------------------------------ A cascata

/**
 * Índices de busca sobre a lista oficial.
 *
 * Os quatro são O(1) na consulta, e é por isso que a fama de O(n²) da cascata é
 * parcialmente injusta: matrícula, CPF, e-mail e nome+nascimento resolvem quase
 * tudo antes de qualquer comparação de texto. Só o que falha os quatro chega à
 * varredura por semelhança.
 */
function indexar_(matriculados) {
  var porMatricula = {};
  var porCpf = {};
  var porEmail = {};
  var porNomeNasc = {};
  var porNome = {};

  matriculados.forEach(function (m) {
    var mat = normalizarMatricula(m.matricula);
    if (mat) (porMatricula[mat] = porMatricula[mat] || []).push(m);

    var cpf = normalizarCpf(m.cpf);
    if (cpf.length === 11) (porCpf[cpf] = porCpf[cpf] || []).push(m);

    var email = normalizarEmail(m.email);
    if (email) (porEmail[email] = porEmail[email] || []).push(m);

    var nome = chaveNome(m.nome);
    if (nome) {
      (porNome[nome] = porNome[nome] || []).push(m);
      var nasc = normalizarData(m.data_nascimento);
      if (nasc) (porNomeNasc[nome + '|' + nasc] = porNomeNasc[nome + '|' + nasc] || []).push(m);
    }
  });

  return {
    porMatricula: porMatricula, porCpf: porCpf, porEmail: porEmail,
    porNomeNasc: porNomeNasc, porNome: porNome, todos: matriculados
  };
}

/**
 * Aplica a cascata para uma inscrição.
 *
 * Porte literal do sistema em produção, com uma única troca mecânica: o
 * matriculado é identificado por `_id` (o nome do documento, que a importação
 * fez ser a matrícula normalizada) onde lá era `id`, a coluna de uid da planilha.
 */
function casar_(insc, idx, usados) {
  var livre = function (lista) {
    return (lista || []).filter(function (m) { return !usados[m._id]; });
  };

  // 0. Matrícula — a chave institucional do CESUTECH, a mais forte de todas.
  var matricula = normalizarMatricula(insc.matricula);
  if (matricula) {
    var porMat = livre(idx.porMatricula[matricula]);
    if (porMat.length) {
      var mm = porMat[0];
      var simMat = similaridade(insc.nome, mm.nome);
      if (simMat < LIMIAR_NOME_DIVERGENTE && chaveNome(mm.nome)) {
        return { matriculado: mm, metodo: 'Matrícula (nome diverge)', score: simMat, status: STATUS.DIVERGENCIA };
      }
      return { matriculado: mm, metodo: 'Matrícula', score: 1, status: STATUS.CONFIRMADO };
    }
  }

  // 1. CPF
  var cpf = normalizarCpf(insc.cpf);
  if (cpf.length === 11) {
    var porCpf = livre(idx.porCpf[cpf]);
    if (porCpf.length) {
      var m = porCpf[0];
      // CPF bate mas o nome é outro: alguém digitou errado. Não confirma.
      var sim = similaridade(insc.nome, m.nome);
      if (sim < LIMIAR_NOME_DIVERGENTE && chaveNome(m.nome)) {
        return { matriculado: m, metodo: 'CPF (nome diverge)', score: sim, status: STATUS.DIVERGENCIA };
      }
      return { matriculado: m, metodo: 'CPF', score: 1, status: STATUS.CONFIRMADO };
    }
  }

  // 2. E-mail
  var email = normalizarEmail(insc.email);
  if (email) {
    var porEmail = livre(idx.porEmail[email]);
    if (porEmail.length) {
      var me = porEmail[0];
      var cpfMat = normalizarCpf(me.cpf);
      // Mesmo e-mail com CPFs diferentes: conta de família, ou erro. Não confirma.
      if (cpf.length === 11 && cpfMat.length === 11 && cpf !== cpfMat) {
        return { matriculado: me, metodo: 'E-mail (CPF diverge)', score: 0.5, status: STATUS.DIVERGENCIA };
      }
      return { matriculado: me, metodo: 'E-mail', score: 0.9, status: STATUS.CONFIRMADO };
    }
  }

  // 3. Nome + data de nascimento
  var nome = chaveNome(insc.nome);
  var nasc = normalizarData(insc.data_nascimento);
  if (nome && nasc) {
    var porNN = livre(idx.porNomeNasc[nome + '|' + nasc]);
    if (porNN.length) {
      return { matriculado: porNN[0], metodo: 'Nome + nascimento', score: 0.85, status: STATUS.CONFIRMADO };
    }
  }

  // 4. Nome idêntico e único
  if (nome) {
    var porNome = livre(idx.porNome[nome]);
    if (porNome.length === 1) {
      return { matriculado: porNome[0], metodo: 'Nome exato', score: 0.7, status: STATUS.DIVERGENCIA };
    }
    if (porNome.length > 1) {
      // Homônimos: o sistema não tem como escolher. Deixa explícito.
      return { matriculado: null, metodo: 'Nome ambíguo (' + porNome.length + ' iguais)', score: 0, status: STATUS.DIVERGENCIA };
    }
  }

  // 5. Nome parecido — a única etapa que percorre a lista inteira.
  if (nome) {
    var melhor = null;
    idx.todos.forEach(function (m) {
      if (usados[m._id]) return;
      var s = similaridade(insc.nome, m.nome);
      if (s >= LIMIAR_NOME_APROXIMADO && (!melhor || s > melhor.score)) melhor = { m: m, score: s };
    });
    if (melhor) {
      return {
        matriculado: melhor.m,
        metodo: 'Nome aproximado (' + Math.round(melhor.score * 100) + '%)',
        score: melhor.score,
        status: STATUS.DIVERGENCIA
      };
    }
  }

  return { matriculado: null, metodo: '', score: 0, status: STATUS.SO_INSCRITO };
}

/**
 * Consolida inscrição + matrícula num documento de `alunos`.
 *
 * A lista oficial manda em curso/turma/situação/matrícula; a inscrição manda no
 * contato. Não existe campo `id`: o id é o nome do documento (`chaveAluno_`), e
 * uma cópia dele aqui dentro seria mais um valor livre para divergir.
 *
 * TODOS os campos são gravados, inclusive em branco. Não é zelo: no Firestore um
 * campo AUSENTE não casa com filtro de igualdade, e `painelEstatisticas`
 * (10_Painel.gs) conta "quantos têm CPF" como total menos os que têm `cpf` igual
 * a vazio. Omitir a chave faria o painel anunciar 100% de CPF em silêncio.
 *
 * Tudo sai como texto porque é assim que volta do banco (`fsValor_`, 02_Repo.gs
 * grava tudo como `stringValue`). Comparar número com o texto que o banco
 * devolve daria "mudou" em toda rodada — e a diferença nunca fecharia em zero.
 */
function montarAluno_(insc, mat, metodo, score, status) {
  insc = insc || {};
  mat = mat || {};

  return {
    cpf: normalizarCpf(insc.cpf) || normalizarCpf(mat.cpf),
    nome: formatarNome(mat.nome || insc.nome),
    email: normalizarEmail(insc.email) || normalizarEmail(mat.email),
    // O telefone da lista oficial entra como reserva, o que o sistema sobre
    // Sheets não fazia (montarAluno_ olhava só a inscrição). Sem isso, o aluno
    // SO_MATRICULADO — justamente aquele que a coordenação precisa procurar,
    // porque não se inscreveu — fica sem nenhuma forma de contato na tela.
    telefone: normalizarTelefone(insc.whatsapp || insc.telefone) || normalizarTelefone(mat.telefone),
    data_nascimento: normalizarData(insc.data_nascimento) || normalizarData(mat.data_nascimento),
    matricula: normalizarMatricula(mat.matricula) || normalizarMatricula(insc.matricula),
    matricula_conferida: insc.matricula_conferida || (mat._id ? 'SIM' : 'NAO'),
    projeto: String(insc.projeto_nome || '').trim(),
    curso: String(mat.curso || insc.curso_fase || insc.curso || '').trim(),
    turma: String(mat.turma || '').trim(),
    situacao: String(mat.situacao || '').trim(),
    status: status,
    metodo_match: metodo || '',
    score_match: score ? String(Math.round(score * 100) / 100) : '',
    // Os dois endereços que transformam o detalhe do aluno em leitura de ponto.
    inscricao_id: insc._id || '',
    matricula_id: mat._id || '',
    revisado_por: '',
    revisado_em: '',
    observacoes: ''
  };
}

// ------------------------------------------------------------ A diferença

/**
 * Devolve ao aluno recalculado a decisão que um humano já tomou sobre ele.
 *
 * Sem isso, a coordenação revisaria as mesmas divergências a cada importação — e
 * como a importação chama a reconciliação, seria a cada arquivo enviado.
 *
 * O sistema sobre Sheets fazia isto com uma tabela de decisões indexada por
 * "CPF, ou e-mail, ou nome" (`decisoesManuais_`), montada varrendo a aba inteira.
 * Aqui a decisão está no MESMO documento que o cálculo vai substituir, porque o
 * id é o mesmo — o casamento é por endereço, não por palpite. De quebra some um
 * defeito que lá era invisível: dois alunos sem CPF e sem e-mail com o mesmo nome
 * herdavam a decisão um do outro.
 *
 * `revisado_por` é o sinal de que houve gente: `resolverAluno` (10_Painel.gs)
 * sempre o preenche, e a reconciliação nunca.
 */
function preservarRevisao_(novo, atual) {
  if (!atual || !String(atual.revisado_por || '')) return;

  novo.status = atual.status;
  novo.observacoes = String(atual.observacoes || '');
  novo.revisado_por = String(atual.revisado_por);
  novo.revisado_em = String(atual.revisado_em || '');
}

/** Se este aluno precisa mesmo ser gravado. Documento novo sempre precisa. */
function mudou_(novo, atual) {
  if (!atual) return true;

  for (var i = 0; i < ALUNO_CAMPOS.length; i++) {
    var campo = ALUNO_CAMPOS[i];
    if (String(novo[campo] || '') !== String(atual[campo] || '')) return true;
  }
  return false;
}

/**
 * Quais documentos sobraram da rodada anterior — e se é seguro apagá-los.
 *
 * As duas recusas cobrem o mesmo medo por dois caminhos. Cadastro calculado
 * vazio com cadastro gravado cheio significa que as duas coleções de origem
 * vieram vazias, o que na prática é falha de leitura ou coleção esvaziada sem
 * querer, e nunca "todos os alunos sumiram". Muitas remoções de uma vez é o mesmo
 * sintoma em escala menor.
 *
 * Nos dois casos a rodada continua e ATUALIZA o que tem de atualizar: recusar a
 * remoção não pode virar recusar a reconciliação. O que sobra vira aviso na tela
 * e linha no log.
 */
function planejarRemocoes_(existentes, calculados, totalCalculado) {
  var ids = [];
  Object.keys(existentes).forEach(function (id) {
    if (!calculados[id]) ids.push(id);
  });

  if (!ids.length) return { ids: [], recusa: '' };

  if (!totalCalculado) {
    return {
      ids: [],
      recusa: 'Não apaguei nada: o cruzamento não produziu nenhum aluno, e há ' + ids.length +
              ' no cadastro. Isso costuma ser lista oficial e inscrições vazias, não alunos que sumiram.'
    };
  }

  if (ids.length > RECONCILIACAO_MAX_REMOCOES) {
    return {
      ids: [],
      recusa: ids.length + ' linhas de alunos ficaram sem origem e NÃO foram apagadas (o teto por ' +
              'rodada é ' + RECONCILIACAO_MAX_REMOCOES + '). Apagar em massa levaria junto as ' +
              'divergências já resolvidas pela coordenação. Confira se alguma coleção foi esvaziada.'
    };
  }

  return { ids: ids, recusa: '' };
}

/** Os quatro números que o painel e a importação mostram. */
function resumoDe_(lista) {
  var resumo = {
    total: lista.length,
    confirmado: 0, so_inscrito: 0, so_matriculado: 0, divergencia: 0
  };

  lista.forEach(function (a) {
    if (a.status === STATUS.CONFIRMADO) resumo.confirmado++;
    else if (a.status === STATUS.SO_INSCRITO) resumo.so_inscrito++;
    else if (a.status === STATUS.SO_MATRICULADO) resumo.so_matriculado++;
    else if (a.status === STATUS.DIVERGENCIA) resumo.divergencia++;
  });

  return resumo;
}

/**
 * Grava o histograma de alunos por curso, se ele mudou.
 *
 * Existe porque o Firestore não tem GROUP BY. O painel precisa de "alunos por
 * curso" e da lista de cursos do filtro em duas telas, e no sistema sobre Sheets
 * as duas saíam de varrer a tabela inteira em JavaScript — aqui seriam 2.500
 * leituras por abertura de tela. Quem já percorreu todos os alunos foi esta
 * rodada; ela grava o resultado num documento, e o painel o lê por 1 leitura.
 *
 * Um campo por curso, com o nome do curso como nome do campo — é o formato que
 * `painelCursos_` (10_Painel.gs) lê. `escreverEmLote`, e não `atualizar`: o
 * `update` sem máscara substitui o documento inteiro, que é o certo para um
 * histograma (curso que sumiu tem de sumir) e evita passar nome de curso por
 * `updateMask.fieldPaths`, onde ponto e espaço têm significado.
 *
 * Devolve true quando escreveu — a rodada usa isso para decidir se vale registrar.
 */
function atualizarAgregadoDeCursos_(lista) {
  var contagem = {};
  lista.forEach(function (a) {
    // O rótulo de quem não tem curso é o mesmo do sistema atual, e precisa ser
    // um nome de verdade: nome de campo vazio não é endereçável no Firestore.
    var curso = String(a.curso || '').trim() || '(sem curso)';
    contagem[curso] = (contagem[curso] || 0) + 1;
  });

  // Empate desempatado pelo nome, e não pela ordem em que os alunos apareceram:
  // no corte do teto, dois cursos com a mesma contagem trocando de lugar entre
  // rodadas fariam o documento ser reescrito toda vez, sem nada ter mudado.
  var cursos = Object.keys(contagem).sort(function (x, y) {
    if (contagem[y] !== contagem[x]) return contagem[y] - contagem[x];
    return x < y ? -1 : (x > y ? 1 : 0);
  }).slice(0, RECONCILIACAO_MAX_CURSOS);

  var documento = { _id: AGREGADOS_CURSOS };
  cursos.forEach(function (curso) { documento[curso] = String(contagem[curso]); });

  var atual = ler(AGREGADOS_COLECAO, AGREGADOS_CURSOS);
  if (atual && !histogramaMudou_(documento, atual)) return false;

  documento.atualizado_em = agora();
  escreverEmLote(AGREGADOS_COLECAO, [documento]);
  return true;
}

/** Compara dois histogramas ignorando metadados e o carimbo. */
function histogramaMudou_(novo, atual) {
  var interessa = function (chave) {
    return chave.charAt(0) !== '_' && chave !== 'atualizado_em';
  };

  var chavesNovas = Object.keys(novo).filter(interessa);
  var chavesAtuais = Object.keys(atual).filter(interessa);
  if (chavesNovas.length !== chavesAtuais.length) return true;

  for (var i = 0; i < chavesNovas.length; i++) {
    if (String(novo[chavesNovas[i]]) !== String(atual[chavesNovas[i]] || '')) return true;
  }
  return false;
}

// ------------------------------------------------------------ Ações do painel

/** Botão "Reconciliar agora" (Admin.html:554). */
function rodarReconciliacao(payload) {
  try {
    exigirAdmin(payload && payload.token);
    return { ok: true, resumo: reconciliar() };
  } catch (err) {
    console.error('rodarReconciliacao: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * Botão "Sincronizar respostas do Forms" (Admin.html:566).
 *
 * A reconciliação só roda se entrou resposta nova. Ela custa milhares de
 * leituras (ver o orçamento no topo) e não tem o que recalcular quando nada
 * chegou — e o `Admin.html` nem mostra o resultado dela nesta tela.
 */
function sincronizarForms(payload) {
  try {
    payload = payload || {};
    exigirAdmin(payload.token);

    var r = sincronizarRespostasForms(payload.completo);
    if (!r.aviso && r.novas > 0) reconciliar();

    return { ok: true, resultado: r };
  } catch (err) {
    console.error('sincronizarForms: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

// ------------------------------------------------------------ Google Forms

/**
 * Onde fica a marca d'água da última sincronização.
 *
 * Propriedade de script, e não documento no Firestore: é um carimbo de tempo
 * escrito a cada sincronização, e pagar uma escrita de banco por ele desfaria
 * parte da economia que ele existe para fazer.
 */
var SYNC_FORMS_MARCA = 'sync_forms_ate';

/**
 * Teto de respostas trazidas por sincronização.
 *
 * Cada resposta é uma tentativa de escrita. Mil é 5% da cota diária num clique;
 * acima disso a sincronização traz as mais antigas, avança a marca e pede outro
 * clique — que continua de onde parou, porque a marca avançou.
 */
var SYNC_FORMS_MAX = 1000;

/**
 * Traz para dentro do sistema as respostas do Google Forms, inclusive as
 * anteriores à instalação.
 *
 * -------------------------------------------- O plano B não existe mais, e some
 *
 * O sistema sobre Sheets tem dois caminhos: ler o Forms pela API com `form_id`,
 * ou — quando ele não está configurado — varrer a aba "Respostas ao formulário"
 * da planilha-container. O projeto novo NÃO TEM planilha nenhuma por baixo (ver
 * 02_Repo.gs), então esse segundo caminho não é difícil: é impossível. Sem
 * `form_id`, esta função não sincroniza, e diz isso com todas as letras em vez de
 * devolver "0 novas" como se tivesse procurado.
 *
 * Perda real, e é preciso ser explícito: quem hoje usa o Forms vinculado à
 * planilha e nunca preencheu `form_id` deixa de ter importação de histórico por
 * este botão. O caminho é preencher `form_id` em Configurações — o formulário é
 * o mesmo, muda só de onde se lê.
 *
 * ------------------------------------------------- O que a marca d'água resolve
 *
 * O sistema sobre Sheets relê TODAS as respostas a cada sincronização e chama
 * `gravarInscricao` para cada uma; a dedup descarta as repetidas. Sobre a
 * planilha isso é tempo perdido e nada mais. Aqui cada resposta repetida é uma
 * tentativa de CRIAR documento no Firestore, e o botão fica ao lado do de
 * reconciliar, no topo do painel. Com 500 respostas, dez cliques distraídos são
 * 5.000 tentativas de escrita.
 *
 * `getResponses(desde)` do Forms devolve só o que chegou depois de um instante, e
 * é isso que a marca guarda. Ela avança para o carimbo da última resposta
 * PROCESSADA — não para "agora" —, para que uma falha no meio não pule o resto.
 * `completo = true` ignora a marca e varre tudo, que é o modo de reconstruir o
 * histórico.
 */
function sincronizarRespostasForms(completo) {
  var formId = String(config('form_id', '')).trim();
  if (!formId) {
    return {
      novas: 0, duplicadas: 0, ignoradas: 0,
      aviso: 'Não há de onde ler: preencha "form_id" em Configurações com o ID do Google ' +
             'Forms. Este sistema não tem planilha de respostas para varrer como alternativa.'
    };
  }

  var leitura = lerRespostasDoForms_(formId, completo);
  if (leitura.aviso) return { novas: 0, duplicadas: 0, ignoradas: 0, aviso: leitura.aviso };

  var novas = 0;
  var duplicadas = 0;
  var ignoradas = 0;
  var marca = '';

  leitura.itens.forEach(function (resposta) {
    var dados = mapearParaInscricao(resposta.bruto, 'GOOGLE_FORMS');

    // Resposta sem nada que identifique a pessoa: sem matrícula, sem CPF, sem
    // e-mail e sem nome, TODAS colapsam na mesma chave de dedup e só a primeira
    // entraria — as outras voltariam como "duplicada", que é mentira. Contar
    // separado é o mínimo para o número da tela não enganar.
    if (!chaveDePessoa_(dados)) {
      ignoradas++;
      return;
    }

    var r = gravarInscricao(dados);
    if (r.duplicada) duplicadas++; else novas++;
    if (resposta.quando) marca = resposta.quando;
  });

  if (marca) PropertiesService.getScriptProperties().setProperty(SYNC_FORMS_MARCA, marca);

  if (novas || duplicadas || ignoradas) {
    registrar('SYNC_FORMS', 'inscricao', '',
      'novas=' + novas + ' duplicadas=' + duplicadas + ' ignoradas=' + ignoradas);
  }

  return {
    novas: novas,
    duplicadas: duplicadas,
    ignoradas: ignoradas,
    aviso: leitura.truncado
      ? 'Trouxe as ' + SYNC_FORMS_MAX + ' respostas mais antigas que faltavam. Clique de novo ' +
        'para continuar de onde parou.'
      : ''
  };
}

/**
 * As respostas do formulário, da mais antiga para a mais nova.
 *
 * A ordem importa: a marca d'água avança para o carimbo da última processada, e
 * processar fora de ordem faria a marca pular respostas que ficaram para trás.
 *
 * O `catch` largo é deliberado. `FormApp` exige o escopo
 * `https://www.googleapis.com/auth/forms.responses.readonly`, que HOJE NÃO está
 * em `appsscript.json` — o manifesto lista escopos explicitamente, e quando ele
 * faz isso o Apps Script não acrescenta os que o código usaria. Enquanto a linha
 * não for adicionada lá, esta função falha por autorização, e o professor precisa
 * ler o motivo na tela em vez de "Falha na sincronização".
 */
function lerRespostasDoForms_(formId, completo) {
  try {
    if (typeof FormApp === 'undefined') {
      return { itens: [], truncado: false, aviso: avisoDeEscopoDoForms_('FormApp não está disponível') };
    }

    var form = FormApp.openById(formId);
    var desde = completo ? null : marcaDaSincronizacao_();
    var respostas = desde ? form.getResponses(desde) : form.getResponses();

    var itens = respostas.map(function (resposta) {
      var bruto = {};
      resposta.getItemResponses().forEach(function (ir) {
        var v = ir.getResponse();
        bruto[ir.getItem().getTitle()] = (Object.prototype.toString.call(v) === '[object Array]')
          ? v.join(', ') : v;
      });

      var quando = resposta.getTimestamp();
      return { bruto: bruto, quando: quando ? quando.toISOString() : '' };
    });

    // Ordenar aqui é seguro e a documentação do Forms não é: ela diz que
    // `getResponses` devolve as respostas na ordem de envio, mas não é promessa
    // que valha apostar a marca d'água. Se viessem da mais nova para a mais
    // velha, o corte pelo teto ficaria com as recentes, a marca pularia para o
    // fim e as antigas nunca mais seriam vistas.
    itens.sort(function (a, b) { return a.quando < b.quando ? -1 : (a.quando > b.quando ? 1 : 0); });

    var truncado = itens.length > SYNC_FORMS_MAX;
    if (truncado) itens = itens.slice(0, SYNC_FORMS_MAX);

    return { itens: itens, truncado: truncado, aviso: '' };
  } catch (e) {
    return { itens: [], truncado: false, aviso: avisoDeEscopoDoForms_(e.message) };
  }
}

/**
 * Esta mensagem já mandou procurar o escopo errado.
 *
 * Ela citava `/auth/forms.responses.readonly`, que é escopo da API REST do
 * Google Forms — e este código não usa a API REST, usa o serviço `FormApp` do
 * Apps Script, que a plataforma amarra a `/auth/forms`. Quem seguisse a
 * instrução acrescentaria um escopo que não destrava nada e concluiria que o
 * problema era outro.
 *
 * O escopo NÃO está no manifesto de propósito: ele dá acesso a todos os
 * formulários da conta, e o Forms aqui é plano B do sistema antigo, que este
 * projeto está substituindo. Quem precisar dele acrescenta a linha e reautoriza.
 */
function avisoDeEscopoDoForms_(detalhe) {
  return 'Não consegui abrir o formulário. A sincronização com o Google Forms vem ' +
         'DESLIGADA: o manifesto (appsscript.json) não declara o escopo ' +
         'https://www.googleapis.com/auth/forms, que o serviço FormApp exige. Para ligá-la, ' +
         'acrescente esse escopo, reautorize o script e confira o "form_id" em ' +
         'Configurações. Detalhe: ' + detalhe;
}

/** O instante da última resposta processada, ou null na primeira vez. */
function marcaDaSincronizacao_() {
  var valor = PropertiesService.getScriptProperties().getProperty(SYNC_FORMS_MARCA);
  if (!valor) return null;

  var data = new Date(valor);
  return isNaN(data.getTime()) ? null : data;
}

/**
 * Traduz {pergunta: resposta} do Forms para o schema de `inscricoes`.
 *
 * Porte do sistema sobre Sheets (04_Inscricoes.gs de lá), que é onde ela vivia
 * junto do gatilho `aoReceberRespostaForms`. Aqui ela mora com a sincronização
 * porque é o único caminho do Forms que existe no projeto novo — não há gatilho
 * `onFormSubmit`, porque não há planilha-container onde instalá-lo.
 *
 * O casamento das perguntas usa `adivinharCampo` (01_Utils.gs), o mesmo
 * dicionário de sinônimos que a importação de planilha usa. A pergunta do
 * formulário do CESUTECH muda de redação todo semestre; o dicionário é o que
 * evita reconfigurar o sistema a cada mudança.
 */
function mapearParaInscricao(bruto, origem) {
  var out = { origem: origem || 'DESCONHECIDA', raw_json: JSON.stringify(bruto) };
  var scores = {};

  Object.keys(bruto).forEach(function (pergunta) {
    var palpite = adivinharCampo(pergunta);
    if (!palpite) return;

    // Vence o MAIOR score, e o empate fica com a primeira pergunta. O sistema
    // sobre Sheets ficava com a primeira que casasse, para "E-mail do
    // responsável" não sobrescrever "E-mail" — e o maior score já resolve isso,
    // porque o casamento exato vale 1 e o parcial vale 0,85.
    //
    // O que a regra de lá NÃO resolve é o casamento parcial que chega ANTES do
    // exato. `adivinharCampo` aceita substring, e 'ra' é sinônimo de matrícula
    // (de "registro acadêmico"): qualquer pergunta com "ra" no meio — "Carimbo
    // de data/hora", "Sua turma", "Horário" — casava com matrícula por 0,85 e,
    // vindo primeiro, tomava o lugar da pergunta "Matrícula", que vale 1. A
    // matrícula do aluno virava a data de envio, a cascata deixava de casar por
    // matrícula e todo mundo caía em divergência por nome.
    if (scores[palpite.campo] === undefined || palpite.score > scores[palpite.campo]) {
      out[palpite.campo] = bruto[pergunta];
      scores[palpite.campo] = palpite.score;
    }
  });

  // Consentimento LGPD: qualquer pergunta cuja resposta seja um "sim" explícito.
  Object.keys(bruto).forEach(function (pergunta) {
    var p = normalizarTexto(pergunta);
    if (p.indexOf('lgpd') !== -1 || p.indexOf('autoriz') !== -1 || p.indexOf('consent') !== -1) {
      var resp = normalizarTexto(bruto[pergunta]);
      out.consentimento_lgpd = (resp.indexOf('sim') !== -1 || resp.indexOf('aceito') !== -1 ||
        resp.indexOf('autorizo') !== -1 || resp.indexOf('concordo') !== -1) ? 'SIM' : 'NAO';
    }
  });

  return out;
}

// ---------------------------------------------------------------- Automação

/**
 * Nome do gatilho diário. Fixo, para `instalarGatilhoDiario` conseguir
 * reconhecer o que já instalou e não empilhar cópias.
 */
var GATILHO_RECONCILIACAO = 'reconciliarAutomatico';

/**
 * A reconciliação de todo dia, de madrugada.
 *
 * Sem isto, a ficha do aluno só existe depois que ALGUÉM clica em "Reconciliar
 * agora" — e o professor não tem por que saber que precisa. Inscrição que
 * chegou de noite ficaria invisível no painel até alguém lembrar.
 *
 * Roda de madrugada por dois motivos: ninguém está usando o painel, e a cota
 * diária do plano Spark vira à meia-noite do Pacífico (4h ou 5h em Brasília),
 * então a rodada cai logo depois da virada, com o dia inteiro de folga pela
 * frente caso algo saia caro.
 *
 * O custo é baixo justamente porque a reconciliação virou upsert por diferença:
 * num dia sem inscrição nova ela lê os dois lados e NÃO ESCREVE NADA. Antes
 * desse conserto, um gatilho diário seria uma arma apontada para a cota.
 */
function reconciliarAutomatico() {
  try {
    var r = reconciliar();
    registrar('RECONCILIACAO_AUTOMATICA', 'sistema', '',
      'alunos: ' + (r && r.total) + ', gravados: ' + (r && r.gravados));
  } catch (e) {
    // Gatilho que lança manda e-mail de falha para o dono do script todo dia.
    // O erro fica no Stackdriver e no log do sistema, que é onde se procura.
    console.error('reconciliarAutomatico: ' + e.message);
    registrar('ERRO', 'sistema', '', 'reconciliação automática: ' + e.message);
  }
}

/**
 * Instala (ou reinstala) o gatilho diário. Rode UMA vez, do editor.
 *
 * Idempotente: remove o que já existe com o mesmo nome antes de criar. Sem
 * isso, rodar duas vezes deixaria dois gatilhos e a reconciliação rodaria em
 * dobro — e gatilho duplicado é invisível até alguém abrir a tela de
 * acionadores para procurar.
 */
function instalarGatilhoDiario() {
  var existentes = ScriptApp.getProjectTriggers();
  var removidos = 0;

  existentes.forEach(function (g) {
    if (g.getHandlerFunction() === GATILHO_RECONCILIACAO) {
      ScriptApp.deleteTrigger(g);
      removidos++;
    }
  });

  ScriptApp.newTrigger(GATILHO_RECONCILIACAO)
    .timeBased()
    .atHour(5)
    .everyDays(1)
    .create();

  Logger.log('=== instalarGatilhoDiario ===');
  if (removidos) Logger.log('gatilhos antigos removidos: %s', removidos);
  Logger.log('reconciliação automática instalada para rodar entre 5h e 6h, todo dia.');
  Logger.log('O botão "Reconciliar agora" continua valendo para quando não dá para esperar.');
}
