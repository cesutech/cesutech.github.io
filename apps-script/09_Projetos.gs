/**
 * 09_Projetos.gs — projetos de extensão e controle de vagas.
 *
 * O limite de vagas é regra de servidor. No formulário antigo ele era uma frase
 * pedindo ao aluno que procurasse outro projeto se este estivesse cheio; aqui a
 * vaga é conferida antes de gravar, e a conferência acontece serializada.
 *
 * DESENHO DE DADOS: coleção `projetos`, id do documento = id do projeto. Não
 * existe campo `id` gravado — ele seria uma cópia do nome do documento, livre
 * para divergir dele. O id volta na leitura por `projetoDe_`.
 *
 * ---------------------------------------------------------------- A cicatriz
 *
 * O que segue veio do projeto sobre Sheets (o sistema anterior sobre Google Sheets,
 * 09_Projetos.gs) e está reproduzido porque é a origem de tudo que este arquivo
 * protege:
 *
 *   "NÃO EXISTE ATALHO PARA O LOCK. Já tentei um: pular a serialização quando
 *    sobravam muitas vagas, com o argumento de que 30 execuções simultâneas
 *    nunca estourariam uma folga de 40. O raciocínio sobre VAGAS estava certo.
 *    O erro foi não perceber que o lock também serializa a ESCRITA.
 *    Um teste de carga com 250 inscrições mostrou o estrago: 249 responderam
 *    sucesso e só 67 chegaram à planilha. As execuções liam a mesma última linha
 *    e gravavam umas por cima das outras. Perda silenciosa de dado — o pior
 *    tipo, porque o aluno recebe confirmação e some do cadastro."
 *
 * O lock de lá protegia DUAS coisas ao mesmo tempo:
 *   1. o invariante da vaga — contar e gravar sem janela entre as duas;
 *   2. a escrita física — "leia a última linha, escreva na seguinte", que é uma
 *      corrida por construção quando o endereço do dado depende do que já existe.
 *
 * Sobre Firestore, (2) deixa de existir. Cada inscrição é um documento com
 * endereço próprio, e a chave de deduplicação vira o id do documento: o banco
 * recusa o segundo com ALREADY_EXISTS (ver `inserir` em 02_Repo.gs). Não há
 * última linha para duas execuções lerem igual. As 182 inscrições perdidas
 * daquele teste não têm como se repetir aqui.
 *
 * (1) sobrevive inteiro. É corrida de LÓGICA, não de armazenamento: duas
 * execuções contam 59, as duas passam pela conferência, as duas gravam, e o
 * projeto fecha com 61. Nenhuma delas errou — cada uma leu um número verdadeiro
 * no instante em que leu. `contar()` sozinho não fecha essa janela, por mais
 * barato que seja.
 *
 * ------------------------------------------------ A escolha desta versão: (a)
 *
 * LockService.getScriptLock() + contagem agregada do Firestore, com `inscritos`
 * DERIVADO da contagem — nunca armazenado.
 *
 * Por que derivado: um número que se conta não tem como mentir. Um contador
 * gravado mente sempre que uma escrita falha no meio, que alguém apaga uma
 * inscrição pelo painel ou que uma importação entra por fora — e mente calado,
 * que é o modo de falha que este sistema já pagou uma vez.
 *
 * Por que o lock continua global: `getScriptLock()` serializa o script inteiro,
 * então duas inscrições em projetos DIFERENTES ainda esperam uma pela outra. O
 * que muda é o tamanho do trecho serializado. Sobre Sheets era ler a coluna
 * inteira de projeto_id, ler a coluna de hash, ler a última linha e escrever —
 * quatro idas à planilha, crescendo com o total de inscritos. Aqui são duas
 * chamadas de tamanho fixo: uma agregação (`contar`) e uma escrita (`inserir`).
 * A leitura do projeto ficou FORA do lock de propósito — ela não participa do
 * invariante.
 *
 * O que isso custa em fila, separando o que foi medido do que é conta de
 * guardanapo: o sistema sobre Sheets mediu 0,8 inscrição/s de ponta a ponta
 * (~1250ms por aluno, dos quais ~800ms eram as quatro idas à planilha, dentro do
 * lock). Contra o Firestore mediu-se a ESCRITA, 341ms. A agregação não foi
 * medida ainda, então o trecho serializado aqui é ESTIMATIVA: 600 a 700ms, algo
 * perto do dobro da vazão — não mais do que isso, e ninguém deve prometer mais.
 * O número de verdade sai medindo o tempo entre `waitLock` e `releaseLock` num
 * evento real, e é ele, e só ele, que decide se o caminho (b) algum dia se paga.
 *
 * ATENÇÃO ao contrato com quem passa `gravar`: a região protegida é do tamanho
 * do que a função de gravação fizer. Ela precisa ser UMA escrita — o `inserir`
 * com a chave de dedup como id do documento. Se ela voltar a varrer a coleção
 * de inscrições para procurar duplicata, como o sistema sobre Sheets fazia, o
 * ganho todo desaparece dentro do lock.
 *
 * ------------------------------------- Caminho (b), conhecido e não percorrido
 *
 * Transação do Firestore com documento contador por projeto: a contenção deixa
 * de ser global e passa a ser por projeto, o que só interessa se dois projetos
 * lotarem ao mesmo tempo. O preço é alto e é permanente: `inscritos` vira número
 * ARMAZENADO, que passa a poder divergir do real, e toda escrita precisa tratar
 * ABORTED com retentativa (o Repo já retenta, mas retentar uma transação é
 * refazer a leitura, não repetir o POST). Fica registrado como o caminho a
 * seguir SE o teto aparecer — e o teto aqui é a fila do lock global, que se mede
 * pelo tempo de espera no `waitLock`, não pelo palpite.
 *
 * Assentos pré-criados e reivindicados por id resolveriam a contenção por
 * construção. Não foi implementado: ninguém pediu, e criar 60 documentos por
 * projeto para depois reconciliá-los é mais peça móvel do que este sistema tem
 * problema.
 *
 * ---------------------------------------------- A fila de espera (11/08/2026)
 *
 * `vagas_excedentes_em_espera` em SIM faz o ESGOTADO deixar de ser recusa: a
 * inscrição é aceita e MARCADA, e quem está marcado não conta como vaga ocupada.
 * O motivo é o do auditório, não o do banco — o aluno que lê "esgotado" na tela
 * levanta e vai embora, e esse não volta.
 *
 * O que a fila NÃO muda, e é onde este arquivo tem de ser lido com cuidado:
 *
 *   - o invariante. Vaga continua sendo contada e consumida dentro do lock; a
 *     marca é decidida no mesmo lugar, com o mesmo número. 60 vagas fecham em 60
 *     nos dois modos, e há teste de concorrência para cada um;
 *   - as outras recusas. INATIVO e FECHADO continuam recusando, antes do lock;
 *   - o modo padrão. Com a chave em NAO — como o evento vai rodar — o caminho é
 *     o mesmo de antes, requisição por requisição: UMA agregação para contar,
 *     UMA escrita para gravar.
 *
 * O que ela custa quando LIGADA: uma segunda agregação por contagem
 * (`contarEmEspera_`), porque contar "quem ocupa vaga" passa a ser uma
 * subtração. Duas consultas de um filtro cada, e não uma de dois filtros — dois
 * filtros de igualdade pedem índice composto, que é o passo de console que este
 * arquivo se recusa a depender.
 *
 * -------------------------------- A chave de diagnóstico (`contar_ocupacao_na_lista`)
 *
 * `contar_ocupacao_na_lista` em NAO faz `listarProjetos` NÃO agregar: a rota
 * responde com a lista sem a ocupação, e a diferença de tempo entre os dois
 * estados é a resposta à pergunta "quanto do carregamento é a contagem?". Ela
 * existe para ser medida no ambiente de quem reclama da lentidão — não é
 * funcionalidade, e o padrão é SIM.
 *
 * O QUE ELA NÃO DESLIGA, e é o que a torna segura de virar com o site no ar:
 * `reservarVaga` não passa por aqui. Ela conta com `contarInscritos_` DENTRO do
 * lock, no instante do envio, e continua recusando quem chega em projeto cheio,
 * com a mesma mensagem. As 60 vagas fecham em 60 nos dois estados da chave, e há
 * teste de concorrência para cada um. O que se desliga é o número MOSTRADO na
 * lista, nunca a decisão sobre a vaga.
 *
 * O preço, dito por inteiro porque ele é o motivo de a chave não ser um jeito
 * "mais rápido" de servir a lista:
 *
 *   - sem contagem não há ESGOTADO. `situacaoDe_` não tem como saber que lotou,
 *     então o projeto cheio aparece ABERTO e o aluno só descobre no envio —
 *     onde o servidor recusa corretamente. É uma frustração a mais por aluno de
 *     projeto lotado, trocada por segundos de tela;
 *   - a ausência viaja como `inscritos: null`, NUNCA como zero. Zero é um número,
 *     e "0 / 60" num projeto cheio é o cartão mais convidativo da tela — mentira
 *     pior que a lentidão que se quer diagnosticar. Quem desenha distingue as
 *     duas coisas por `ocupacao_contada`, que viaja em cada projeto.
 */

var PROJETOS_COLECAO = 'projetos';

/**
 * Coleção das inscrições. Este arquivo só a CONTA — quem grava nela é o arquivo
 * de inscrições, e é dele o nome canônico. Está repetido aqui de propósito, para
 * o controle de vaga não depender da ordem de carregamento dos arquivos; se os
 * dois valores um dia divergirem, a contagem passa a olhar uma coleção vazia e
 * todo projeto vira ABERTO em silêncio. Divergiu, quebrou aqui.
 */
var INSCRICOES_COLECAO = 'inscricoes';

/**
 * Espera pelo lock. Herdado com a razão intacta: 20s recusava quem chegasse
 * depois de ~13 pessoas na fila. O teto real é o tempo de execução do script
 * (6 min), então 90s continua com margem — e agora cabe mais gente dentro dela,
 * porque cada um segura o lock por menos tempo.
 */
var TIMEOUT_LOCK_MS = 90000;

/** Situação de um projeto do ponto de vista de quem quer se inscrever. */
var SITUACAO = {
  ABERTO: 'ABERTO',
  ESGOTADO: 'ESGOTADO',
  FECHADO: 'FECHADO',   // inscrições encerradas manualmente
  INATIVO: 'INATIVO'    // não aparece no site
};

// ------------------------------------------------------------ Consulta

/**
 * Projetos com a contagem de inscritos já embutida.
 * `apenasPublicos` filtra o que o aluno pode ver no site.
 *
 * Com `contar_ocupacao_na_lista` em NAO a contagem NÃO acontece, e a ocupação
 * volta como `inscritos: null` mais `ocupacao_contada: false` — ver o cabeçalho
 * do arquivo. Ninguém que leia esta função pode devolver zero no lugar do null.
 */
function listarProjetos(apenasPublicos) {
  var brutos = listar(PROJETOS_COLECAO).itens.map(projetoDe_);

  // O filtro do site vem ANTES da contagem, e essa ordem não é estética: cada
  // projeto custa uma agregação, e contar inscritos de projeto inativo para
  // jogar o número fora seria pagar por leitura que ninguém vê. No sistema sobre
  // Sheets a contagem inteira saía de uma varredura só e a ordem não importava.
  if (apenasPublicos) {
    brutos = brutos.filter(function (p) { return String(p.ativo).toUpperCase() === 'SIM'; });
  }

  // Perguntada UMA vez para a lista inteira, e antes do lote: é ela que decide
  // se existe lote. Mesmo lugar e mesmo motivo de `esperaLigada_` em
  // `contarInscritosDe_`.
  var contando = contarOcupacaoNaLista_();

  // TODAS as contagens em uma ida só. Uma por projeto, em sequência, era o que
  // fazia esta rota custar ~6 s com o cache frio contra ~2 s de piso da
  // plataforma — ver `fsFetchAll_` (02_Repo.gs), que carrega a medição.
  var contagens = contando ? contarInscritosDe_(brutos.map(function (p) { return p.id; })) : [];

  var lista = brutos.map(function (p, indice) {
    var vagas = Number(p.vagas || 0);
    // NULL, e nunca 0. Zero é um número, e um número errado sobre vaga é pior
    // que a lentidão que a chave existe para medir: o site mostraria "0 / 60" em
    // projeto que pode estar cheio. Quem desenha tem de conseguir distinguir
    // "não contei" de "não há ninguém", e é por isso que a ausência é null.
    var inscritos = contando ? contagens[indice] : null;

    return {
      id: p.id,
      codigo: p.codigo,
      nome: p.nome,
      descricao: p.descricao,
      // O parágrafo que o aluno lê DENTRO do formulário, antes de preencher —
      // quem coordena, quando é o primeiro encontro, o que acontece se o projeto
      // lotar. É outro campo que `descricao` porque é outro lugar da tela e outro
      // momento da leitura: a descrição convence a entrar, esta orienta quem já
      // entrou.
      //
      // Viaja SEMPRE, inclusive vazia, e é isso que a torna opcional sem virar
      // uma pergunta a mais: o site esconde o parágrafo quando não há texto. E
      // ela precisa viajar por um segundo motivo, menos óbvio — o painel manda o
      // projeto INTEIRO de volta ao gravar (ver `alternarProjetoUI`, na aba
      // Projetos), então um campo que não voltasse na leitura seria apagado no
      // primeiro clique em Inativar.
      descricao_formulario: p.descricao_formulario || '',
      professor: p.professor,
      email_professor: p.email_professor,
      banner: p.banner || '',
      local: p.local,
      horario: p.horario,
      primeiro_encontro: p.primeiro_encontro,
      vagas: vagas,
      inscritos: inscritos,
      // O sinalizador que separa as duas ausências. `inscritos` e `restantes`
      // vêm null quando não se contou, e `restantes` já vinha null para projeto
      // ilimitado — sem este campo, a tela não teria como saber se desenha
      // "Inscrições abertas" (ilimitado) ou "60 vagas no total" (não contado).
      ocupacao_contada: contando,
      // 0 = ilimitado. Nunca devolve negativo, mesmo se alguém baixar o limite
      // depois de já ter mais inscritos do que o novo teto.
      restantes: (inscritos === null || vagas <= 0) ? null : Math.max(0, vagas - inscritos),
      situacao: situacaoDe_(p, inscritos),
      // Vazio conta como SIM: projetos criados antes do campo existir.
      validar_matricula: String(p.validar_matricula).toUpperCase() !== 'NAO',
      ativo: String(p.ativo).toUpperCase() === 'SIM',
      // `situacao` NÃO responde por este campo, e o painel tentava deduzi-lo
      // dela: `situacao !== 'FECHADO'` marcava a caixa "Inscrições abertas".
      // Como `situacaoDe_` devolve INATIVO antes de olhar `inscricoes_abertas`,
      // todo projeto desativado aparecia com a caixa marcada — e salvar gravava
      // `inscricoes_abertas: SIM` num projeto que estava com NAO. Atingia em
      // cheio o projeto que `removerProjeto` desativa por ter inscritos, que é
      // justamente o que se desativa com as inscrições fechadas de propósito.
      // Os dois estados são independentes, e agora viajam separados.
      //
      // A régua é `=== 'SIM'`, a MESMA de `situacaoDe_` logo abaixo, e não a de
      // `validar_matricula` acima (`!== 'NAO'`, onde vazio conta como sim). Tem de
      // ser a mesma: um projeto com o campo vazio já é FECHADO para quem quer se
      // inscrever, então mostrar a caixa marcada faria o próximo Salvar gravar
      // SIM e ABRIR as inscrições sem ninguém pedir — que é exatamente o bug que
      // este campo veio consertar, só que pela outra ponta.
      inscricoes_abertas: String(p.inscricoes_abertas).toUpperCase() === 'SIM',
      ordem: Number(p.ordem || 0),
      atualizado_em: p.atualizado_em
    };
  });

  // Ordenação em JavaScript, não no `orderBy` da consulta: `ordem` está gravada
  // como texto (ver `fsValor_` em 02_Repo.gs), e ordenação de texto poria o
  // projeto 10 antes do 2. A coleção tem meia dúzia de documentos por semestre —
  // ordenar aqui não tem custo que se meça.
  lista.sort(function (a, b) {
    if (a.ordem !== b.ordem) return a.ordem - b.ordem;
    return chaveNome(a.nome).localeCompare(chaveNome(b.nome));
  });

  return lista;
}

/**
 * Documento do Firestore -> projeto, com o `id` vindo do nome do documento.
 *
 * `_id` é o metadado que o Repo acrescenta na leitura, e é a única fonte de
 * verdade do id — por isso ele não é gravado como campo. Preencher `id` aqui é o
 * que mantém o contrato que o resto do sistema já espera (o painel monta os
 * botões com `p.id`, e as inscrições guardam `projeto_id`).
 */
function projetoDe_(documento) {
  if (!documento) return null;
  documento.id = documento._id;
  return documento;
}

function situacaoDe_(p, inscritos) {
  if (String(p.ativo).toUpperCase() !== 'SIM') return SITUACAO.INATIVO;
  if (String(p.inscricoes_abertas).toUpperCase() !== 'SIM') return SITUACAO.FECHADO;

  var vagas = Number(p.vagas || 0);
  // `inscritos` null é "não contado" (`contar_ocupacao_na_lista` em NAO), e sem
  // contagem NÃO SE SABE se lotou: o projeto cheio sai daqui como ABERTO, e quem
  // recusa é `reservarVaga`, que conta dentro do lock no instante do envio. A
  // conferência do null é explícita porque `null >= vagas` já seria falso por
  // coerção — acertar por acidente é o tipo de coisa que a próxima edição perde.
  if (vagas > 0 && inscritos !== null && inscritos >= vagas) return SITUACAO.ESGOTADO;

  return SITUACAO.ABERTO;
}

/**
 * Quantos inscritos OCUPAM VAGA neste projeto, agora.
 *
 * Agregação no servidor, não `listar` com filtro: o Firestore cobra por
 * DOCUMENTO lido contra um teto de 50 mil leituras por dia no plano Spark, e
 * trazer as inscrições para contá-las em JavaScript custaria 500 leituras por
 * projeto lotado — a cada carregamento do site. A agregação devolve um número e
 * é cobrada por bloco de mil entradas de índice varridas.
 *
 * Filtro de igualdade em um campo só, sem ordenação: é o caso que o índice
 * automático de campo único já cobre. Filtrar por um campo e ordenar por OUTRO
 * exigiria índice composto declarado no console — passo manual, repetido a cada
 * ambiente novo, e descoberto no pior dia possível.
 *
 * ------------------------------------------------------ A fila de espera aqui
 *
 * Quem está na fila NÃO ocupa vaga, e por isso não pode entrar nesta conta: o
 * número que sai daqui é o que o site mostra e o que decide o ESGOTADO dentro do
 * lock. Contar a fila junto faria a tela mentir e, pior, faria a própria fila se
 * realimentar — cada pessoa em espera empurraria a próxima para a espera.
 *
 * Duas agregações e não uma consulta com dois filtros de igualdade, e isto é a
 * decisão do trecho: `projeto_id == X AND em_espera == NAO` é a consulta óbvia e
 * é exatamente a que este arquivo se proibiu lá em cima. Subtrair mantém CADA
 * consulta com um filtro só, no índice automático que já existe — nenhum passo
 * de console, em nenhum ambiente.
 *
 * E a segunda agregação só acontece com a espera LIGADA. Desligada — o padrão —
 * esta função é, requisição por requisição, a mesma de antes de a fila existir.
 *
 * ESTA função ignora `contar_ocupacao_na_lista`, e isso é o desenho: a chave
 * desliga a contagem da TELA, e quem chama aqui é quem decide vaga.
 */
function contarInscritos_(projetoId) {
  if (!projetoId) return 0;

  var total = contar(INSCRICOES_COLECAO, { campo: 'projeto_id', valor: String(projetoId) });
  if (!esperaLigada_()) return total;

  return vagasOcupadas_(total, contarEmEspera_(projetoId));
}

/**
 * `Math.max` porque os dois números vêm de duas leituras, e uma inscrição pode
 * entrar entre elas. Negativo aqui viraria vaga inventada.
 *
 * Uma função de uma linha para os dois caminhos de contagem — o de dentro do
 * lock e o da listagem — não poderem discordar sobre o que é vaga ocupada.
 */
function vagasOcupadas_(total, emEspera) {
  return Math.max(0, total - emEspera);
}

/**
 * A mesma contagem de `contarInscritos_`, para VÁRIOS projetos, em uma ida só.
 *
 * Devolve um número por id, na ordem em que os ids chegaram.
 *
 * Serve à LISTAGEM — a tela —, e é aí que ela pode existir: quem lê para mostrar
 * pode ler tudo de uma vez, porque não há nada para proteger entre uma contagem
 * e outra. Quem decide vaga continua sendo `reservarVaga`, que conta UM projeto
 * dentro do lock, pelo caminho de sempre, e não passa por aqui. Se um dia passar,
 * o invariante das vagas terá sido trocado por tempo de tela — que é exatamente
 * o negócio que este arquivo se recusa a fazer.
 *
 * Com a fila de espera ligada são dois pedidos por projeto (o total e quem está
 * na fila), e os 2P vão no MESMO lote: ligar a fila passa a custar leitura a
 * mais, como sempre custou, mas não passa a custar espera a mais.
 */
function contarInscritosDe_(projetoIds) {
  if (!projetoIds || !projetoIds.length) return [];

  // Perguntada UMA vez para o lote inteiro. Dentro de `contarInscritos_` a
  // pergunta é a mesma e o cache de execução de `config()` a responde de graça,
  // mas ali ela é feita por projeto — aqui ela decide o TAMANHO do lote, e tem
  // de vir antes dele.
  var espera = esperaLigada_();

  var pedidos = projetoIds.map(function (id) {
    return { colecao: INSCRICOES_COLECAO, campo: 'projeto_id', valor: String(id) };
  });
  if (espera) {
    projetoIds.forEach(function (id) {
      pedidos.push({ colecao: INSCRICOES_COLECAO, campo: 'espera_de', valor: String(id) });
    });
  }

  var contagens = contarVarios(pedidos);

  return projetoIds.map(function (id, indice) {
    // O mesmo "sem id, sem contagem" de `contarInscritos_`: um filtro por id
    // vazio contaria as inscrições órfãs e as devolveria como se fossem deste
    // projeto.
    if (!id) return 0;
    if (!espera) return contagens[indice];
    return vagasOcupadas_(contagens[indice], contagens[indice + projetoIds.length]);
  });
}

/**
 * Quantos estão na FILA DE ESPERA deste projeto.
 *
 * `espera_de` existe só no documento de quem está na fila (ver `gravarInscricao`
 * em 04_Inscricoes.gs), e guarda o id do projeto. É um campo só justamente para
 * caber num filtro de igualdade simples: inscrição gravada antes de a fila
 * existir não tem o campo, não casa com filtro nenhum, e continua contando como
 * vaga ocupada — que é o que ela é.
 */
function contarEmEspera_(projetoId) {
  if (!projetoId) return 0;
  return contar(INSCRICOES_COLECAO, { campo: 'espera_de', valor: String(projetoId) });
}

/**
 * A fila de espera está ligada?
 *
 * Padrão NAO: o sistema recusa quem passa das vagas, exatamente como sempre fez.
 * Com SIM, `reservarVaga` aceita o excedente e o marca — ver lá.
 *
 * `config()` já está em cache da execução quando isto é chamado no caminho do
 * aluno (quem chega em `reservarVaga` já consultou `cadastro_aberto`), então a
 * pergunta não custa ida ao banco dentro do lock. É o mesmo argumento de
 * `texto_esgotado`.
 */
function esperaLigada_() {
  return String(config('vagas_excedentes_em_espera', 'NAO')).toUpperCase() === 'SIM';
}

/**
 * A LISTA conta a ocupação de cada projeto?
 *
 * Padrão SIM: a lista traz a ocupação, como sempre trouxe. NAO é a chave de
 * diagnóstico descrita no cabeçalho — a lista sai sem agregação nenhuma, para
 * medir quanto do tempo de carregamento é a contagem.
 *
 * Ela decide o que a TELA mostra e mais nada. `reservarVaga` não a consulta:
 * quem decide vaga conta dentro do lock, nos dois estados da chave, e o aluno
 * continua sendo recusado quando o projeto está cheio. Se um dia esta pergunta
 * aparecer no caminho de `reservarVaga`, o invariante das vagas terá sido
 * trocado por tempo de tela.
 *
 * `!== 'NAO'` e não `=== 'SIM'`: qualquer coisa que não seja um NAO explícito
 * conta. Uma chave escrita torta pelo painel não pode desligar a ocupação do
 * site sem ninguém ter pedido.
 */
function contarOcupacaoNaLista_() {
  return String(config('contar_ocupacao_na_lista', 'SIM')).toUpperCase() !== 'NAO';
}

function projetoPorId(id) {
  if (!id) return null;
  return projetoDe_(ler(PROJETOS_COLECAO, String(id)));
}

// ------------------------------------------------------------ Vagas

/**
 * Reserva uma vaga e grava a inscrição. Devolve o que `gravar` devolver, ou a
 * recusa: { ok, erro, situacao }.
 *
 * A função de gravação vem por parâmetro para que a contagem e a escrita
 * aconteçam sem nenhuma janela entre elas — é o mesmo desenho do sistema sobre
 * Sheets, e é o motivo de a inscrição não poder gravar sozinha.
 *
 * ------------------------------------------------------------ Fila de espera
 *
 * Com `vagas_excedentes_em_espera` em SIM, o ESGOTADO deixa de ser recusa e vira
 * MARCA: a inscrição é gravada, e `gravar` recebe um segundo argumento dizendo
 * que aquela pessoa entrou na fila. Só o esgotado — INATIVO e FECHADO recusam
 * antes, lá em cima, e continuam recusando.
 *
 * ATENÇÃO, e este é o contrato que o invariante das vagas compra: quem passa
 * `gravar` TEM de honrar o segundo argumento, gravando a marca que
 * `contarEmEspera_` conta (`espera_de`). Uma gravação que o ignore põe a pessoa
 * na coleção como se ocupasse vaga, e aí o projeto fecha com mais gente do que
 * tem lugar — que é exatamente o que este arquivo existe para impedir. São dois
 * chamadores hoje, `submeterInscricao` (04_Inscricoes.gs) e `restaurarInscricoes`
 * (13_Auditorio.gs), e existe teste para cada um.
 */
function reservarVaga(projetoId, gravar) {
  // Fora do lock: ler o projeto não participa do invariante. `vagas`, `ativo` e
  // `inscricoes_abertas` são campos que a coordenação muda umas poucas vezes por
  // semestre, e ler um deles obsoleto por milissegundos não vende vaga nenhuma —
  // o que não pode envelhecer é a CONTAGEM.
  var projeto = projetoPorId(projetoId);
  if (!projeto) return { ok: false, erro: 'Projeto não encontrado.' };

  // INATIVO e FECHADO não dependem da contagem: recusar aqui evita pôr na fila
  // do lock quem já está recusado de qualquer jeito. O 0 é literal — a única
  // situação que a contagem decide é ESGOTADO, e essa fica para dentro.
  var situacao = situacaoDe_(projeto, 0);
  if (situacao !== SITUACAO.ABERTO) return recusaPorSituacao_(situacao);

  // Lida AQUI, fora do lock, e por um motivo que não é estético: `config()` custa
  // uma leitura quando o cache da execução está frio, e leitura fria dentro da
  // região protegida é fila para todo mundo atrás. Como toda chave de
  // configuração, esta não participa do invariante — ela muda umas poucas vezes
  // por semestre, e lê-la um milissegundo velha não vende vaga nenhuma.
  //
  // A chamada também deixa o cache quente para o `contarInscritos_` de dentro do
  // lock, que faz a mesma pergunta.
  var espera = esperaLigada_();

  var lock = LockService.getScriptLock();

  try {
    lock.waitLock(TIMEOUT_LOCK_MS);
  } catch (e) {
    // Sem lock não se grava. A mensagem diz o que fazer e, principalmente, que
    // nada se perdeu: quem lê "erro" num formulário assume que digitou à toa.
    return {
      ok: false,
      erro: 'Muita gente se inscrevendo ao mesmo tempo. Aguarde alguns segundos e envie de novo — ' +
            'seus dados não foram perdidos.'
    };
  }

  try {
    // ---------------- região protegida: contar e gravar, nesta ordem ---------
    //
    // A contagem é lida AQUI DENTRO, e não antes do `waitLock`. Quem esperou na
    // fila esperou justamente porque outra execução estava gravando; um número
    // lido antes da espera é um número de antes daquela gravação, e é assim que
    // se vende a vaga 61.
    var inscritos = contarInscritos_(projetoId);
    var situacaoAgora = situacaoDe_(projeto, inscritos);

    // ESGOTADO é a única situação que a CONTAGEM descobre, e é a única que a fila
    // de espera cobre. `projeto` é o mesmo objeto lido lá em cima, então INATIVO e
    // FECHADO nem chegam aqui — a conferência explícita fica assim mesmo, porque
    // "hoje não chega" não é o mesmo que "não pode chegar", e o preço de errar
    // isto seria inscrever gente em projeto fechado.
    var emEspera = false;
    if (situacaoAgora !== SITUACAO.ABERTO) {
      if (situacaoAgora !== SITUACAO.ESGOTADO || !espera) {
        return recusaPorSituacao_(situacaoAgora);
      }
      emEspera = true;
    }

    var resultado = gravar(projeto, emEspera);

    // Avisa o professor quando a última vaga é preenchida. Duplicata não conta:
    // ela não ocupou vaga nenhuma, e o aviso sairia duas vezes.
    //
    // É a terceira chamada da região protegida, e acontece uma vez na vida de
    // cada projeto. Tirá-la do lock exigiria carregar estado por cima do
    // `finally` para economizar um evento por semestre — não paga.
    //
    // Quem entrou pela FILA também não conta: ela não ocupou vaga, o projeto já
    // estava esgotado quando ela chegou, e o aviso sairia de novo a cada pessoa
    // que entrasse na espera — uma vez por aluno, até o fim do evento.
    var vagas = Number(projeto.vagas || 0);
    if (resultado.ok && !resultado.duplicada && !emEspera && vagas > 0 && inscritos + 1 >= vagas) {
      registrar('PROJETO_ESGOTADO', 'projeto', projetoId, projeto.nome + ' atingiu ' + vagas + ' inscritos');
    }

    return resultado;
  } finally {
    // `finally` e não no fim do try: se `gravar` lançar, o lock preso derruba as
    // inscrições seguintes por 90 segundos cada uma.
    lock.releaseLock();
  }
}

/**
 * As três recusas por situação, com o texto que o aluno lê.
 *
 * `texto_esgotado` é editável pela coordenação. Nesta altura `config()` já está
 * em cache da execução (ver CONFIG_CACHE em 03_Config.gs), porque quem chama
 * `reservarVaga` já consultou `cadastro_aberto` antes — a mensagem não custa uma
 * ida ao banco dentro do lock.
 */
function recusaPorSituacao_(situacao) {
  if (situacao === SITUACAO.INATIVO) {
    return { ok: false, erro: 'Este projeto não está disponível.', situacao: situacao };
  }
  if (situacao === SITUACAO.FECHADO) {
    return { ok: false, erro: 'As inscrições para este projeto estão encerradas.', situacao: situacao };
  }
  return {
    ok: false,
    erro: config('texto_esgotado', 'Inscrições esgotadas. Escolha outro projeto de extensão disponível.'),
    situacao: situacao
  };
}

// ------------------------------------------------------------ CRUD (painel)

function salvarProjeto(payload) {
  try {
    exigirAdmin(payload && payload.token);

    var dados = payload.projeto || {};
    var erros = validarProjeto_(dados);
    if (erros.length) return { ok: false, erro: erros.join(' ') };

    var codigo = gerarCodigo_(dados.codigo || dados.nome, dados.id);
    var agoraStr = agora();

    var comum = {
      codigo: codigo,
      nome: String(dados.nome).trim(),
      descricao: String(dados.descricao || '').trim(),
      descricao_formulario: String(dados.descricao_formulario || '').trim(),
      professor: String(dados.professor || '').trim(),
      email_professor: normalizarEmail(dados.email_professor),
      banner: String(dados.banner || '').trim(),
      vagas: Math.max(0, Number(dados.vagas || 0)),
      local: String(dados.local || '').trim(),
      horario: String(dados.horario || '').trim(),
      primeiro_encontro: String(dados.primeiro_encontro || '').trim(),
      ativo: dados.ativo ? 'SIM' : 'NAO',
      inscricoes_abertas: dados.inscricoes_abertas ? 'SIM' : 'NAO',
      validar_matricula: dados.validar_matricula === false ? 'NAO' : 'SIM',
      ordem: Number(dados.ordem || 0),
      atualizado_em: agoraStr
    };

    if (dados.id) {
      // A conferência de existência não é folclore herdado do Sheets: aqui ela
      // vale MAIS. `atualizar` é um PATCH, e PATCH no Firestore CRIA o documento
      // que não existe. Sem esta linha, um painel aberto desde antes de o projeto
      // ser excluído o ressuscitaria pela metade — com `atualizado_em`, sem
      // `criado_em`, sem `criado_por`, e sem ninguém saber de onde veio.
      var existente = projetoPorId(dados.id);
      if (!existente) return { ok: false, erro: 'Projeto não encontrado. Recarregue a lista.' };

      atualizar(PROJETOS_COLECAO, dados.id, comum);
      registrar('PROJETO_EDITADO', 'projeto', dados.id, comum.nome);
      return { ok: true, id: dados.id };
    }

    var novoId = uid('proj');
    var novo = Object.assign({
      criado_em: agoraStr,
      criado_por: usuarioAtual()
    }, comum);

    // Id sorteado de um UUID: colisão é teórica. Mas `inserir` não sobrescreve,
    // então um `jaExistia` aqui significaria projeto engolido em silêncio — e
    // silêncio é o modo de falha que este sistema não aceita mais.
    var gravacao = inserir(PROJETOS_COLECAO, novo, novoId);
    if (gravacao.jaExistia) {
      return { ok: false, erro: 'Não consegui criar o projeto (id em uso). Tente de novo.' };
    }

    registrar('PROJETO_CRIADO', 'projeto', novoId, novo.nome + ' · ' + novo.vagas + ' vagas');
    return { ok: true, id: novoId };
  } catch (err) {
    console.error('salvarProjeto: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * Projeto com inscritos não é apagado — vira inativo.
 * Apagar deixaria inscrições órfãs apontando para um id que não existe mais.
 *
 * Janela conhecida e aceita: entre contar e excluir, uma inscrição pode entrar,
 * e o resultado é uma inscrição órfã. Fechá-la exigiria pôr o painel dentro do
 * mesmo lock global do formulário, o que faria um clique da coordenação esperar
 * a fila inteira do auditório. O estrago possível é um registro rastreável pelo
 * log; o remédio, se acontecer, é recriar o projeto com o mesmo id.
 */
function removerProjeto(payload) {
  try {
    exigirAdmin(payload && payload.token);

    var projeto = projetoPorId(payload.id);
    if (!projeto) return { ok: false, erro: 'Projeto não encontrado.' };

    var inscritos = contarInscritos_(payload.id);

    if (inscritos > 0) {
      atualizar(PROJETOS_COLECAO, payload.id, {
        ativo: 'NAO', inscricoes_abertas: 'NAO', atualizado_em: agora()
      });
      registrar('PROJETO_DESATIVADO', 'projeto', payload.id,
        projeto.nome + ' (tinha ' + inscritos + ' inscritos — preservado)');
      return {
        ok: true,
        desativado: true,
        mensagem: 'O projeto tem ' + inscritos + ' inscrito(s), então foi desativado em vez de excluído. ' +
                  'Assim as inscrições continuam rastreáveis.'
      };
    }

    excluir(PROJETOS_COLECAO, payload.id);
    registrar('PROJETO_EXCLUIDO', 'projeto', payload.id, projeto.nome);
    return { ok: true, desativado: false, mensagem: 'Projeto excluído.' };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

function validarProjeto_(d) {
  var erros = [];

  if (!String(d.nome || '').trim()) erros.push('Informe o nome do projeto.');
  if (String(d.nome || '').trim().length > 120) erros.push('Nome muito longo (máximo 120 caracteres).');

  var vagas = Number(d.vagas);
  if (isNaN(vagas) || vagas < 0) erros.push('Vagas deve ser 0 (ilimitado) ou um número positivo.');

  if (d.email_professor && !emailValido(d.email_professor)) {
    erros.push('E-mail do professor inválido.');
  }

  // O texto de orientação viaja em TODA resposta de `?api=projetos`, que é a
  // rota que 500 alunos pedem no mesmo dia. Um teto alto o bastante para o
  // parágrafo real (o do ARTE DIGITAL FLORIPA tem ~620 caracteres) e baixo o
  // bastante para uma colagem inteira de edital não entrar na carga pública sem
  // ninguém perceber. Recusar com a frase na tela é melhor que gravar calado.
  if (String(d.descricao_formulario || '').length > 2000) {
    erros.push('Texto de orientação muito longo (máximo 2000 caracteres).');
  }

  // Reduzir o limite abaixo do que já foi preenchido não é bloqueado, mas o
  // painel avisa — pode ser intencional (encerrar as inscrições, na prática).
  return erros;
}

/**
 * Código curto, usado na URL do site (?projeto=r-cidades).
 *
 * A unicidade aqui é a única do sistema que o banco NÃO impõe: quem é chave de
 * documento é o id do projeto, não o código. Duas criações simultâneas poderiam
 * sair com o mesmo código. É ação de painel, feita por uma pessoa, umas poucas
 * vezes por semestre — e o estrago seria o site abrir o projeto errado por um
 * link, não perder dado. Fica assim, sabido.
 */
function gerarCodigo_(base, idAtual) {
  var raiz = codigoDe_(base) || 'projeto';
  var usados = {};

  listar(PROJETOS_COLECAO).itens.forEach(function (documento) {
    // O projeto que está sendo editado não disputa consigo mesmo.
    if (idAtual && String(documento._id) === String(idAtual)) return;
    usados[codigoDe_(documento.codigo)] = true;
  });

  if (!usados[raiz]) return raiz;
  for (var n = 2; n < 200; n++) {
    if (!usados[raiz + '-' + n]) return raiz + '-' + n;
  }
  return raiz + '-' + uid('').slice(-4);
}

/**
 * Texto -> código.
 *
 * Os dois lados da comparação passam por aqui, e é isso que a função existe para
 * garantir. O sistema sobre Sheets normalizava o código candidato com hífen
 * ('r-cidades') e os códigos já gravados sem ele — `normalizarTexto` troca
 * pontuação por espaço, então 'r-cidades' virava 'r cidades' e nunca casava com
 * nada. Resultado: a checagem de duplicidade não reprovava ninguém, e dois
 * projetos de mesmo nome saíam com o mesmo código. Uma função só, usada nas duas
 * pontas, é o que impede a divergência de voltar.
 */
function codigoDe_(texto) {
  return normalizarTexto(texto).replace(/\s+/g, '-').slice(0, 40);
}
