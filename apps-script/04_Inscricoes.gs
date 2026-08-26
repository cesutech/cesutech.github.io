/**
 * 04_Inscricoes.gs — a entrada de inscrições, sobre o Firestore.
 *
 * Duas portas chegam aqui, e as duas desembocam em `gravarInscricao`:
 *   1. `submeterInscricao` COM `projeto_id` — o site hospedado no GitHub Pages,
 *      que entra por doPost e passa por `reservarVaga` (09_Projetos.gs) para
 *      disputar vaga;
 *   2. `submeterInscricao` SEM `projeto_id` — o formulário interno
 *      (Cadastro.html, por google.script.run), que não conhece projeto e não
 *      disputa vaga nenhuma.
 *
 * ------------------------------------------------- A dedup mudou de dono
 *
 * No sistema sobre Sheets (o sistema anterior, 04_Inscricoes.gs)
 * `gravarInscricao` lia a coluna `hash_dedup` inteira e a percorria em JavaScript
 * antes de gravar. O custo O(n) é o menor dos problemas. O problema é ONDE ela
 * roda: são QUATRO chamadores lá, e TRÊS ficam fora do LockService.
 *
 *   04_Inscricoes.gs:23   aoReceberRespostaForms      gatilho do Forms    FORA
 *   04_Inscricoes.gs:248  submeterInscricao, sem projeto                  FORA
 *   04_Inscricoes.gs:262  submeterInscricao, dentro de reservarVaga      DENTRO
 *   04_Inscricoes.gs:410  sincronizarRespostasForms   sincronização       FORA
 *
 * Ler-e-depois-escrever sem serialização é corrida por construção: duas execuções
 * leem a mesma coluna, nenhuma acha o hash, as duas gravam. A varredura só valia
 * como garantia no terceiro caso; nos outros três era conferência otimista, e
 * bastava um aluno reenviar o Forms enquanto a sincronização rodava para a mesma
 * pessoa entrar duas vezes.
 *
 * Aqui a chave de dedup É o id do documento, e quem recusa a segunda gravação é o
 * banco: `createDocument` com `documentId` responde 409 ALREADY_EXISTS numa
 * operação atômica, sem leitura prévia e sem lock (ver `inserir` em 02_Repo.gs —
 * medido contra o Firestore de verdade em 05/08/2026). Os quatro caminhos ficam
 * fechados de uma vez, inclusive os que ninguém serializa. E o terceiro, o único
 * que roda dentro do lock, encolhe de "varrer a coleção" para UMA escrita — que é
 * exatamente o que o cabeçalho de 09_Projetos.gs exige de quem passa `gravar`.
 *
 * Só as duas portas do topo foram portadas. As duas do Google Forms dependem de
 * `FormApp` e da aba de respostas vinculada a uma planilha, e no sistema novo não
 * existe planilha nenhuma por baixo — não é escopo desta fase, e trazê-las seria
 * inventar um caminho de dados que ninguém pediu.
 *
 * ---------------------------------------------------------- Desenho de dados
 *
 * Coleção `inscricoes`, id do documento = `chaveDedup_(dados)`. Não existe campo
 * `id` nem campo `hash_dedup` gravado: os dois seriam cópias do nome do
 * documento, livres para divergir dele. É a mesma decisão que 09_Projetos.gs
 * tomou para `projetos`, e aqui ela vem de brinde — o id JÁ é a chave de dedup.
 *
 * Dois campos só existem no documento de quem está na FILA DE ESPERA, e não
 * existem em mais ninguém: `em_espera` ('SIM') e `espera_de` (o id do projeto).
 * A ausência é o desenho — com `vagas_excedentes_em_espera` em NAO, que é o
 * padrão, o documento gravado é exatamente o de antes de a fila existir, campo
 * por campo. Quem conta os dois é `contarEmEspera_` (09_Projetos.gs); por que
 * são dois, está em `gravarInscricao`.
 *
 * O que isso custa: a chave é `hash()` (01_Utils.gs), MD5 cortado em 16 dígitos
 * hexadecimais, ou seja 64 bits. Colisão entre duas pessoas diferentes deixaria
 * de ser "linha repetida no cadastro" e passaria a ser INSCRIÇÃO PERDIDA, com o
 * aluno lendo "você já está inscrito". Com dez mil inscrições a chance é da ordem
 * de 3 em 10^12 (aniversário sobre 2^64), contra um cadastro que terá centenas.
 * O preço está aceito com o número escrito, não no escuro.
 *
 * -------------------------------------------------- Contrato com a importação
 *
 * `matriculaConhecida` deixou de ler a lista oficial inteira e virou UMA leitura
 * por id. Isso só funciona se a fase de importação gravar a coleção
 * `matriculados` com o id do documento = MATRÍCULA NORMALIZADA
 * (`normalizarMatricula`, que devolve só [A-Z0-9]).
 *
 * Consequência que a importação precisa saber: nenhum id que contenha caractere
 * fora de [A-Z0-9] é alcançável por esta função, porque a matrícula consultada
 * sempre passa por `normalizarMatricula`. Linha de lista oficial SEM matrícula —
 * que o sistema sobre Sheets aceita, desde que tenha nome — pode portanto ser
 * gravada com id sorteado sem risco de colidir com matrícula de ninguém. Ela
 * simplesmente nunca será encontrada por matrícula, que é o comportamento certo.
 *
 * `temListaOficial_` conta a coleção inteira, e é aí que a suposição aparece:
 * "existe documento em `matriculados`" passa a valer como "existe lista oficial
 * importada". No sistema sobre Sheets a pergunta era mais estreita — "existe
 * pelo menos uma matrícula não vazia" —, e a diferença aparece num caso só: uma
 * importação que não mapeou coluna de matrícula nenhuma. Lá isso deixava a
 * validação desligada; aqui ligaria a validação sobre uma lista sem matrícula, e
 * todo aluno levaria "matrícula não encontrada". Cabe à importação recusar esse
 * arquivo — é o mesmo arquivo que ela não conseguiria endereçar por id.
 */

/**
 * Coleção das inscrições.
 *
 * O nome canônico é daqui, e 09_Projetos.gs repete a declaração de propósito
 * (ver o comentário lá) para o controle de vaga não depender da ordem de
 * carregamento dos arquivos. Repetido é aceitável; DIVERGENTE é que não pode ser
 * — o Apps Script não reclama, a última declaração carregada vence em silêncio, e
 * a contagem de vagas passaria a olhar uma coleção vazia. Existe teste que lê os
 * dois arquivos e falha se os valores deixarem de ser iguais.
 */
var INSCRICOES_COLECAO = 'inscricoes';

/** Lista oficial de matriculados. Id do documento = matrícula normalizada. */
var MATRICULADOS_COLECAO = 'matriculados';

// ------------------------------------------------------------ Matrícula

/** Matrícula normalizada: só alfanumérico, caixa alta. */
function normalizarMatricula(v) {
  if (!v) return '';
  var limpa = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

  // ZERO À ESQUERDA É FORMATAÇÃO, NÃO IDENTIDADE.
  //
  // A lista oficial traz `09110700`; o aluno digita `9110700`, porque é assim
  // que o número aparece para ele — e recebia "Matrícula não encontrada". No
  // auditório isso seria uma fila de alunos convencidos de que o sistema está
  // errado, e eles estariam certos.
  //
  // Só vale para matrícula inteiramente numérica: `A0123` é outra coisa, e o
  // zero ali pode ser significativo. E sobra pelo menos um dígito, senão '000'
  // viraria string vazia, que é o valor de "não informou".
  //
  // Como `chaveDedup_` também passa por aqui, as duas formas geram a MESMA
  // chave — quem se inscreveu com zero não consegue se inscrever de novo sem
  // ele, que é o comportamento certo.
  if (/^\d+$/.test(limpa)) return limpa.replace(/^0+(?=\d)/, '');

  return limpa;
}

/**
 * Confere se a matrícula consta da lista oficial importada.
 *
 * DELIBERADAMENTE não devolve dado nenhum do aluno — só sim ou não.
 *
 * Um endereço que devolvesse o nome a partir da matrícula viraria um oráculo:
 * as matrículas da instituição são quase sequenciais, então varrer a faixa
 * entregaria a lista inteira de alunos. A controladora desses dados é a
 * faculdade, e a exposição seria dela. Sim/não já resolve o que se quer aqui,
 * que é impedir erro de digitação.
 *
 * Resta um bit de informação ("a matrícula X existe"), e por isso o endpoint que
 * expõe esta função tem teto de consultas por hora. O que mudou do sistema sobre
 * Sheets não é a exposição, é o NOSSO custo: era a coluna inteira da lista
 * oficial a cada conferência, e a conferência roda a cada tecla que o aluno
 * corrige. Agora é uma leitura por id — 1 documento, contra as 50 mil por dia do
 * plano Spark.
 */
function matriculaConhecida(matricula) {
  var alvo = normalizarMatricula(matricula);
  if (!alvo) return false;

  return ler(MATRICULADOS_COLECAO, alvo) !== null;
}

/**
 * SIM quando existe pelo menos uma lista oficial importada.
 *
 * Agregação, e não `listar`: a resposta é um número e não precisa trazer
 * documento nenhum. A suposição que isto carrega está no cabeçalho.
 */
function temListaOficial_() {
  return contar(MATRICULADOS_COLECAO) > 0;
}

/**
 * Decide o que fazer com uma matrícula não encontrada.
 * Devolve '' quando está tudo bem, ou a mensagem de recusa.
 *
 * Guarda importante: sem lista oficial importada, NUNCA bloqueia. Do contrário
 * o primeiro aluno a se inscrever num semestre novo levaria "matrícula
 * incorreta" só porque a secretaria ainda não mandou o arquivo.
 *
 * `conhecida` vem de fora porque quem chama já precisa do mesmo veredito para
 * gravar `matricula_conferida`. No sistema sobre Sheets `matriculaConhecida` era
 * chamada DUAS vezes por inscrição — uma aqui dentro e outra logo depois, no
 * chamador — e a lista oficial era lida inteira nas duas. Aqui a resposta é
 * calculada uma vez e passa por parâmetro. Quem não tiver o veredito na mão pode
 * omitir o argumento; a conta é feita, mas só depois de o projeto dizer que
 * valida matrícula.
 *
 * A ordem das três perguntas também mudou, e não é estética: matrícula
 * ENCONTRADA libera sem precisar saber se existe lista (ela existe — a matrícula
 * está nela). Isso tira a agregação do caminho do aluno certo, que é o caso
 * comum, e a deixa só no caminho de quem digitou errado.
 */
function checarMatriculaNaLista_(matricula, projetoId, conhecida) {
  if (!projetoValidaMatricula_(projetoId)) return '';

  if (conhecida === undefined) conhecida = matriculaConhecida(matricula);
  if (conhecida) return '';

  if (!temListaOficial_()) return '';

  var modo = String(config('modo_validacao_matricula', 'BLOQUEAR')).toUpperCase();
  if (modo === 'BLOQUEAR') {
    return 'Matrícula não encontrada na lista de alunos matriculados. ' +
           'Confira o número digitado. Se estiver certo, procure a coordenação do CESUTECH.';
  }
  return '';   // modo AVISAR: passa, e a inscrição fica marcada como não conferida
}

/**
 * Se ESTE projeto exige matrícula da lista oficial.
 *
 * É decisão de projeto, não do sistema: extensão curricularizada só aceita
 * aluno matriculado, mas um projeto aberto à comunidade não teria como validar.
 *
 * Sem projeto (formulário interno), assume que valida — é o caso comum.
 *
 * Custo conhecido e aceito: esta é a primeira das DUAS leituras do documento do
 * projeto que uma inscrição faz, porque `reservarVaga` lê de novo, por dentro. As
 * duas somam 2 das ~4 leituras por inscrição, contra 50 mil por dia — e fechar a
 * repetição exigiria ou passar o projeto para dentro de 09_Projetos.gs, que não é
 * arquivo desta fase, ou um cache de execução que só existiria para isto.
 */
function projetoValidaMatricula_(projetoId) {
  if (!projetoId) return true;
  var p = projetoPorId(projetoId);
  if (!p) return true;
  // Projeto criado antes deste campo existir tem o campo vazio: vale como SIM.
  return String(p.validar_matricula).toUpperCase() !== 'NAO';
}

// ------------------------------------------------------------ Gravação

/**
 * Chave de deduplicação, que aqui é também o id do documento.
 *
 * Um aluno pode aparecer em projetos diferentes, então a chave inclui o projeto —
 * o que se quer impedir é a mesma pessoa entrar duas vezes no MESMO projeto.
 *
 * Ordem de preferência: matrícula > CPF > e-mail + nome.
 *
 * O `hash` continua no meio do caminho, e agora carrega um segundo papel: ele é
 * o que impede a matrícula do aluno de virar endereço de documento. Id de
 * documento aparece em URL de API, em log de erro e na tela de quem inspeciona o
 * banco; matrícula ali seria dado pessoal exposto por descuido de desenho, e
 * ainda deixaria a coleção enumerável por faixa de matrícula. O hash resolve os
 * dois de graça, e de quebra tem largura fixa e alfabeto seguro para a URL.
 */
function chaveDedup_(dados) {
  var matricula = normalizarMatricula(dados.matricula);
  var cpf = normalizarCpf(dados.cpf);
  var pessoa = matricula || cpf ||
    (normalizarEmail(dados.email) + '|' + chaveNome(dados.nome));

  return hash(String(dados.projeto_id || 'sem-projeto') + '::' + pessoa);
}

/**
 * Normaliza e grava uma inscrição, ignorando duplicatas.
 *
 * UMA requisição, sempre — inclusive quando a inscrição é duplicada, porque quem
 * descobre a duplicata é o 409 do banco e não uma leitura nossa. É essa promessa
 * que 09_Projetos.gs compra ao chamar isto de dentro do lock, e ela tem teste que
 * conta as requisições.
 */
function gravarInscricao(dados) {
  var chave = chaveDedup_(dados);

  var registro = {
    criado_em: agora(),
    origem: dados.origem || 'DESCONHECIDA',
    projeto_id: dados.projeto_id || '',
    projeto_nome: dados.projeto_nome || '',
    matricula: normalizarMatricula(dados.matricula),
    // Marca a procedência do dado: conferido contra a lista oficial, ou
    // digitado sem conferência. É o que separa cadastro confiável de palpite.
    matricula_conferida: dados.matricula_conferida || 'NAO',
    nome: formatarNome(dados.nome),
    email: normalizarEmail(dados.email),
    whatsapp: normalizarTelefone(dados.whatsapp || dados.telefone),
    curso_fase: String(dados.curso_fase || dados.curso || '').trim(),
    cpf: normalizarCpf(dados.cpf),
    data_nascimento: normalizarData(dados.data_nascimento),
    observacoes: String(dados.observacoes || '').trim(),
    declara_ciencia: dados.declara_ciencia ? 'SIM' : 'NAO',
    autoriza_imagem: dados.autoriza_imagem ? 'SIM' : 'NAO',
    consentimento_lgpd: dados.consentimento_lgpd || '',
    raw_json: dados.raw_json || JSON.stringify(dados)
  };

  // ------------------------------------------------------------ Fila de espera
  //
  // As duas marcas existem SÓ no documento de quem está na fila. Quem entrou pela
  // vaga tem o documento de sempre, campo por campo — é isso que faz a fila
  // desligada ser indistinguível do sistema de antes dela, no banco e não só no
  // comportamento.
  //
  // São dois campos para a mesma verdade, e a duplicação é deliberada:
  //   `em_espera` é o que uma pessoa lê ao abrir o documento, e o que o painel
  //               mostra;
  //   `espera_de` é o que a AGREGAÇÃO conta (`contarEmEspera_`, 09_Projetos.gs).
  //               Guarda o id do projeto porque contar "quantos esperam NESTE
  //               projeto" precisa caber num filtro de igualdade só: `projeto_id`
  //               mais `em_espera` seriam DOIS filtros, e dois filtros pedem
  //               índice composto — o passo de console que este sistema se
  //               proibiu de depender.
  //
  // Os dois são escritos aqui, juntos, na mesma escrita, a partir do mesmo
  // booleano. Divergir exigiria alguém gravar um sem o outro, e o único lugar que
  // os grava é este.
  if (String(dados.em_espera).toUpperCase() === 'SIM') {
    registro.em_espera = 'SIM';
    registro.espera_de = String(dados.projeto_id || '');
  }

  var gravacao = inserir(INSCRICOES_COLECAO, registro, chave);
  return { id: chave, duplicada: gravacao.jaExistia };
}

/**
 * Em quais outros projetos esta pessoa já está inscrita.
 *
 * UMA consulta, e não duas: a regra herdada casa por matrícula QUANDO ela existe,
 * e só cai para o e-mail quando não existe — nunca as duas ao mesmo tempo. Sobre
 * Sheets isso ficava escondido dentro de um `||` que percorria quatro colunas
 * lidas inteiras; aqui vira a escolha do campo do filtro.
 *
 * Que fique dito, porque é a tentação óbvia: `listar` aceita UM `fieldFilter` só.
 * Procurar por matrícula OU e-mail no mesmo passo não é um predicado mais
 * complicado, são duas consultas — e duas consultas mudariam a regra de negócio,
 * não só o custo. Não é o que a produção validou.
 *
 * Filtro de igualdade em um campo, sem ordenação declarada: `listar` ordena por
 * `__name__` ASCENDENTE, que é o desempate embutido em todo índice automático de
 * campo único. Não exige índice composto — e não é a armadilha do `__name__`
 * DESCENDENTE, que exigiria (ver `ultimosRegistros` em 04_Log.gs).
 */
var INSCRICOES_OUTROS_PROJETOS_MAX = 20;

function outrosProjetosDe_(dados) {
  var matricula = normalizarMatricula(dados.matricula);
  var email = normalizarEmail(dados.email);
  if (!matricula && !email) return [];

  var busca = matricula
    ? { campo: 'matricula', valor: matricula }
    : { campo: 'email', valor: email };

  // O `limite` fecha a última consulta sem teto do caminho público.
  //
  // Na prática ela traz de uma a seis linhas — são as inscrições de UMA pessoa —,
  // mas "na prática" não é teto: um e-mail digitado errado e repetido por muita
  // gente, ou um dado de teste que sobrou, faziam esta consulta crescer sem
  // limite dentro do caminho que 500 alunos percorrem ao mesmo tempo.
  //
  // Cortar é seguro aqui, e não seria em qualquer lugar: quem chama usa só
  // `length` e o PRIMEIRO nome (submeterInscricao, logo abaixo). Vinte inscrições
  // da mesma pessoa já respondem "sim, ela está em outro projeto" com folga de
  // três vezes o número de projetos que um semestre tem.
  busca.limite = INSCRICOES_OUTROS_PROJETOS_MAX;

  var achados = [];
  listar(INSCRICOES_COLECAO, busca).itens.forEach(function (inscricao) {
    if (String(inscricao.projeto_id) === String(dados.projeto_id || '')) return;

    // Inscrição sem projeto não é "outro projeto". O sistema sobre Sheets não
    // fazia esta conferência e empurrava a linha assim mesmo: `projeto_nome ||
    // projeto_id` devolvia string vazia, e o aluno lia "Você já está inscrito em
    // ." — ou era barrado por uma inscrição que não ocupa vaga em lugar nenhum.
    if (!String(inscricao.projeto_id || '').trim()) return;

    achados.push(inscricao.projeto_nome || inscricao.projeto_id);
  });
  return achados;
}

// ------------------------------------------------------------ Endpoint público

/**
 * Recepção do formulário público.
 * Chamada pelo site (doPost) e pelo Cadastro.html (google.script.run) — tudo é
 * revalidado aqui, porque validação de front-end é conveniência, não segurança.
 */
function submeterInscricao(dados) {
  try {
    if (config('cadastro_aberto', 'SIM').toUpperCase() !== 'SIM') {
      return { ok: false, erro: 'As inscrições estão encerradas no momento.' };
    }

    dados = dados || {};

    var abuso = verificarAntiAbuso_(dados);
    if (abuso) return { ok: false, erro: abuso };

    var erros = validarInscricao(dados);
    if (erros.length) return { ok: false, erro: erros.join(' ') };

    // Uma consulta à lista oficial por inscrição, e uma só. As duas perguntas que
    // dependem dela — "posso recusar?" e "o dado é conferido?" — são a MESMA
    // pergunta ao banco, e o sistema sobre Sheets a fazia duas vezes.
    //
    // Revalidação no servidor: a checagem do navegador é conveniência para o
    // aluno, não garantia. Quem manda POST direto passaria por cima dela.
    var conhecida = matriculaConhecida(dados.matricula);

    var recusa = checarMatriculaNaLista_(dados.matricula, dados.projeto_id, conhecida);
    if (recusa) return { ok: false, erro: recusa, campo: 'matricula' };

    dados.matricula_conferida = conhecida ? 'SIM' : 'NAO';
    dados.origem = dados.origem || 'SITE';
    dados.consentimento_lgpd = dados.consentimento_lgpd ? 'SIM' : 'NAO';

    // Quem decide fila de espera é `reservarVaga`, contando dentro do lock — e é
    // ele que devolve a decisão logo abaixo. Zerar aqui é o mesmo cuidado que
    // `doPost` tem com `origem`: o campo tem nome conhecido, viaja no mesmo
    // payload que o aluno preenche, e sem esta linha bastaria mandar
    // `em_espera: SIM` para gravar uma inscrição marcada que nenhuma vaga
    // consumiu. Não é ataque grave; é dado sujo entrando por descuido de desenho.
    dados.em_espera = 'NAO';

    // Sem projeto: formulário interno, sem controle de vaga. Grava direto, FORA
    // de qualquer lock — e é seguro justamente porque a unicidade agora é do
    // banco, não de uma varredura serializada.
    if (!dados.projeto_id) {
      return finalizarInscricao_(gravarInscricao(dados), 'INSCRICAO_SITE');
    }

    var jaEstaEm = outrosProjetosDe_(dados);
    if (jaEstaEm.length && config('aluno_projeto_unico', 'NAO').toUpperCase() === 'SIM') {
      return {
        ok: false,
        erro: 'Você já está inscrito em ' + jaEstaEm[0] + '. Cada aluno pode participar de um projeto por semestre.'
      };
    }

    // Conferir a vaga e gravar precisam ser indivisíveis — ver 09_Projetos.gs.
    // O que entra na região protegida é só a chamada de `gravarInscricao`: uma
    // escrita. Tudo que dava para decidir antes já foi decidido acima.
    // `emEspera` chega decidido de dentro do lock, e é honrado aqui — é o
    // contrato que 09_Projetos.gs escreveu em maiúsculas: ignorá-lo gravaria o
    // excedente como se ele ocupasse vaga, e o projeto fecharia com mais gente do
    // que tem lugar.
    var resultado = reservarVaga(dados.projeto_id, function (projeto, emEspera) {
      dados.projeto_nome = projeto.nome;
      dados.em_espera = emEspera ? 'SIM' : 'NAO';
      var r = gravarInscricao(dados);
      return { ok: true, duplicada: r.duplicada, id: r.id, em_espera: Boolean(emEspera) };
    });

    if (!resultado.ok) return resultado;

    // Fora do lock de propósito: o log é mais uma escrita, e ela não participa do
    // invariante da vaga. Dentro, custaria 50% a mais de fila para cada aluno.
    var saida = finalizarInscricao_(resultado, 'INSCRICAO_PROJETO');
    if (jaEstaEm.length && !resultado.duplicada) {
      saida.aviso = 'Atenção: você também consta inscrito em ' + jaEstaEm.join(', ') + '.';
    }
    return saida;
  } catch (err) {
    console.error('submeterInscricao: ' + err.message);
    return { ok: false, erro: 'Erro ao registrar. Tente novamente em instantes.' };
  }
}

function finalizarInscricao_(r, acao) {
  registrar(acao, 'inscricao', r.id, r.duplicada ? 'duplicada' : (r.em_espera ? 'nova, em espera' : 'nova'));

  // REENVIO DEVOLVE O MESMO PROTOCOLO, e não só o mesmo "ok".
  //
  // A dedup já era do banco: a chave do documento é `chaveDedup_(dados)`, o
  // `createDocument` recusa a segunda com 409 ALREADY_EXISTS, e `inserir` trata
  // esse 409 como resposta — nunca como erro. Quem reenvia depois de uma queda de
  // rede portanto NÃO duplica, e recebe sucesso. Isso já estava certo.
  //
  // O que faltava era o número: o protocolo saía só na primeira resposta, e quem
  // perdeu a primeira (aba fechada, 3G do auditório caindo no meio do envio)
  // ficava com "você já está inscrito" e nada para mostrar na recepção. O
  // protocolo É a chave de dedup, então repeti-lo é devolver o mesmo dado, não
  // gravar de novo: nenhuma escrita, nenhuma vaga, a mesma resposta.
  if (r.duplicada) {
    return {
      ok: true,
      duplicada: true,
      mensagem: 'Você já está inscrito neste projeto. Não é preciso preencher de novo.',
      protocolo: r.id
    };
  }

  // A pessoa está INSCRITA, e a frase precisa começar por aí. Quem lê "esgotado"
  // numa tela de auditório levanta e vai embora — e esse aluno não volta.
  if (r.em_espera) {
    return {
      ok: true,
      duplicada: false,
      em_espera: true,
      mensagem: config('texto_espera', 'Inscrição registrada! Você entrou na lista de espera deste projeto: as vagas previstas já foram preenchidas, e a coordenação do CESUTECH vai confirmar a sua participação. Guarde o protocolo abaixo.'),
      protocolo: r.id
    };
  }

  return { ok: true, duplicada: false, mensagem: 'Inscrição registrada com sucesso.', protocolo: r.id };
}

/**
 * Freios contra envio automatizado.
 *
 * Com o formulário hospedado no GitHub Pages, a URL do /exec fica visível no
 * JavaScript da página. Isso é da natureza de um endpoint público de inscrição,
 * mas exige três defesas baratas — o Apps Script não expõe o IP do visitante,
 * então não dá para limitar por origem.
 *
 * Devolve string com o motivo da recusa, ou '' quando está tudo certo.
 */
function verificarAntiAbuso_(d) {
  // 1. Honeypot: campo escondido por CSS. Humano nunca preenche; robô que
  //    preenche tudo, sim.
  if (String(d.website || '').trim()) {
    registrarRecusa('BLOQUEIO', 'inscricao', '', 'honeypot preenchido', 'honeypot');
    return 'Não foi possível registrar a inscrição.';
  }

  // 2. Tempo de preenchimento: ninguém preenche matrícula, nome e e-mail em 3s.
  //
  //    A sondagem de segurança mostrou o buraco da versão anterior: tratar a
  //    AUSÊNCIA do campo como benigna deixava o robô contornar as duas defesas
  //    simplesmente não mandando nada. Quem chega pelo endpoint público tem de
  //    provar que veio do formulário.
  //
  //    A exigência vale só para SITE_EXTERNO, que é a superfície de ataque. O
  //    Cadastro.html entra por google.script.run, já dentro do Google, e não
  //    informa o tempo.
  var ms = Number(d.tempoPreenchimento || 0);

  if (String(d.origem) === 'SITE_EXTERNO' && !ms) {
    registrarRecusa('BLOQUEIO', 'inscricao', '', 'envio externo sem sinal de origem', 'sem_origem');
    return 'Não foi possível registrar a inscrição. Preencha pelo formulário do site.';
  }

  if (ms > 0 && ms < 3000) {
    registrarRecusa('BLOQUEIO', 'inscricao', '', 'preenchido em ' + ms + 'ms', 'rapido_demais');
    return 'Não foi possível registrar a inscrição.';
  }

  // 3. Teto global por hora, para uma enxurrada não encher o banco.
  //
  //    O padrão aqui tem de ser o mesmo de CONFIG_PADRAO, e no sistema sobre
  //    Sheets não era: a configuração dizia 2000 e este literal continuou em 60,
  //    de quando 60 era a paranoia da primeira versão. Enquanto a chave existe no
  //    banco ninguém percebe. O dia em que ela não existir — implantação nova,
  //    setup pela metade — é o dia do auditório, e o sistema recusaria a partir do
  //    aluno 61 com uma mensagem simpática dizendo que está tudo bem. Existe teste
  //    que compara todos os padrões deste arquivo com CONFIG_PADRAO.
  var limite = Number(config('limite_inscricoes_hora', '2000'));
  var props = PropertiesService.getScriptProperties();
  var janela = String(Math.floor(new Date().getTime() / 3600000));
  var contagem = (props.getProperty('throttle_janela') === janela)
    ? Number(props.getProperty('throttle_contagem') || 0)
    : 0;

  if (contagem >= limite) {
    registrarRecusa('BLOQUEIO', 'inscricao', '', 'teto de ' + limite + '/hora atingido', 'teto_hora');
    return 'Estamos recebendo muitas inscrições agora. Tente novamente em alguns minutos.';
  }
  props.setProperty('throttle_janela', janela);
  props.setProperty('throttle_contagem', String(contagem + 1));

  return '';
}

function validarInscricao(d) {
  var erros = [];

  if (!String(d.nome || '').trim() || String(d.nome).trim().split(/\s+/).length < 2) {
    erros.push('Informe o nome completo.');
  }
  if (!emailValido(d.email)) {
    erros.push('E-mail inválido.');
  }

  // Matrícula é a chave do aluno no CESUTECH. Não tem dígito verificador,
  // então dá para checar só o formato.
  if (config('exigir_matricula', 'SIM').toUpperCase() === 'SIM') {
    var matricula = normalizarMatricula(d.matricula);
    if (!matricula) erros.push('Informe a matrícula.');
    else if (matricula.length < 4 || matricula.length > 20) erros.push('Matrícula inválida.');
  }

  // CPF é conferido só quando vem preenchido. Nenhum formulário do CESUTECH o
  // coleta — a chave é a matrícula —, então exigi-lo seria uma trava
  // impossível de satisfazer, e foi exatamente o que aconteceu: a configuração
  // guardava exigir_cpf=SIM de quando o CPF era a chave, e toda inscrição
  // morria com "CPF inválido" sem campo onde digitá-lo.
  if (d.cpf && !cpfValido(d.cpf)) {
    erros.push('CPF inválido.');
  }

  var tel = normalizarTelefone(d.whatsapp || d.telefone);
  if (tel && (tel.length < 10 || tel.length > 11)) {
    erros.push('WhatsApp inválido.');
  }

  // Campos que só existem no formulário de projeto. O formulário interno e as
  // inscrições sem projeto não os têm, e exigi-los ali recusaria envios
  // legítimos — o mesmo erro do exigir_cpf, por outro campo.
  if (d.projeto_id) {
    if (!String(d.curso_fase || '').trim()) {
      erros.push('Selecione seu curso e fase.');
    }
    if (!d.declara_ciencia) {
      erros.push('É necessário declarar ciência para participar do projeto.');
    }
  }
  if (!d.consentimento_lgpd) {
    erros.push('É necessário aceitar o aviso de privacidade.');
  }
  return erros;
}
