/**
 * 20_Prova.gs — as provas executáveis, rodadas pelo editor.
 *
 * Cada função aqui prova UMA afirmação sobre o banco. Nenhuma é chamada pelo
 * sistema: rode pelo menu de execução do editor do Apps Script, escolha a função
 * e leia o registro de execução (Ctrl+Enter mostra o log).
 *
 * As provas vieram do spike feito no projeto sobre Sheets
 * (branch feature/spike-firestore, 21_SpikeFirestore.gs), onde serviram para
 * decidir a troca de banco. Aqui elas mudam de papel: viram a verificação de que
 * ESTA instalação está de pé — projeto associado, escopos autorizados,
 * propriedade configurada, camada de dados respondendo.
 *
 * Ordem sugerida na primeira vez:
 *   provaConfigELog > provaUnicidade > provaOrdenacaoNaoCorrompe >
 *   provaTipoForte > provaVazao > provaLimpar
 *
 * Se a primeira falhar com erro de Firestore, rode `provaConectar()`: ela é a
 * mais barata de todas e diz qual dos pré-requisitos está faltando.
 *
 * Tudo o que estas funções criam vai para coleções com o prefixo `teste_`, e
 * `provaLimpar()` recusa apagar qualquer coisa sem esse prefixo. A exceção é
 * `provaConfigELog()`, que precisa tocar em `config` e `log` de verdade — está
 * explicado lá.
 */

/** Marcador de tudo que as provas criam. A limpeza é feita por ele. */
var PREFIXO_PROVA = 'teste_';

/** Uma coleção por prova: cada uma fica reproduzível sem depender das outras. */
var COL_CONEXAO = PREFIXO_PROVA + 'conexao';
var COL_DEDUP = PREFIXO_PROVA + 'dedup';
var COL_ORDENACAO = PREFIXO_PROVA + 'ordenacao';
var COL_TIPOS = PREFIXO_PROVA + 'tipos';
var COL_VAZAO = PREFIXO_PROVA + 'vazao';

/** Chave de configuração reservada às provas. Nenhuma regra de negócio a lê. */
var CHAVE_PROVA = 'prova_carimbo';

/** Teto de páginas na limpeza. Ver provaApagarColecao_. */
var PROVA_MAX_PAGINAS = 25;
var PROVA_TAMANHO_PAGINA = 200;

/**
 * Prova 1: configuração e log funcionam.
 *
 * É a prova do que 03_Config.gs e 04_Log.gs prometem: semear sem sobrescrever,
 * gravar e reler uma chave passando pelo banco, manter os segredos FORA do
 * banco, e listar os últimos eventos por ordem de id.
 *
 * Diferente das outras, esta toca nas coleções `config` e `log` de verdade — não
 * em coleções `teste_`. É deliberado: a coleção dessas duas funções é fixa no
 * código, e desviá-la só para a prova provaria outra coisa. O estrago possível
 * está contido:
 *   - em `config`, escreve só `prova_carimbo`, uma chave que nada lê, e a
 *     esvazia no fim;
 *   - em `log`, acrescenta uma linha 'PROVA'. Log é append-only, e uma linha
 *     dizendo que a verificação rodou é justamente o que se quer que fique;
 *   - `semearConfigPadrao_()` nunca sobrescreve chave existente, então rodar
 *     esta prova num banco já em uso não muda configuração nenhuma.
 *
 * `provaLimpar()` não mexe nessas duas coleções: elas não têm o prefixo.
 */
function provaConfigELog() {
  Logger.log('=== provaConfigELog ===');

  var criadas = semearConfigPadrao_();
  Logger.log('semearConfigPadrao_: ' + criadas.length + ' chave(s) criada(s)' +
    (criadas.length ? ' — ' + criadas.join(', ') : ' (o banco já estava semeado)'));

  // Ida e volta de verdade: sem descartar o cache, `config()` responderia da
  // memória desta execução e a prova não teria provado nada.
  var carimbo = new Date().toISOString();
  gravarConfig(CHAVE_PROVA, carimbo);
  limparCacheConfig();
  var lido = config(CHAVE_PROVA, '');
  Logger.log('gravei ' + CHAVE_PROVA + ' = ' + carimbo);
  Logger.log('li     ' + CHAVE_PROVA + ' = ' + lido);

  // O mapa de segredos está vazio hoje (o PIN saiu do sistema), então esta
  // conferência passa trivialmente — e é justamente por isso que ela fica: o dia
  // em que alguém acrescentar um segredo a CONFIG_SEGREDOS, esta linha é o que
  // prova que ele não foi parar no documento que o formulário público lê.
  var segredoNoBanco = Object.keys(CONFIG_SEGREDOS).some(function (chave) {
    return lerConfig()[chave] !== undefined;
  });
  Logger.log('algum segredo dentro do documento de config: ' + (segredoNoBanco ? 'SIM' : 'NAO'));

  var cursos = configLista('cursos_fases');
  Logger.log('configLista(cursos_fases): ' + cursos.length + ' opção(ões)');

  registrar('PROVA', 'config', CHAVE_PROVA, 'provaConfigELog ' + carimbo);
  var ultimos = ultimosRegistros(5);

  Logger.log('últimos registros do log (mais novo primeiro):');
  ultimos.forEach(function (r) {
    Logger.log('  ' + r._id + '  ' + r.timestamp + '  ' + r.acao + '  ' +
      r.entidade + '/' + r.entidade_id + '  ' + r.usuario);
  });

  // Devolve a chave ao estado neutro. Não existe "apagar campo" na camada de
  // dados; vazio é o mesmo que ausente para `config()`, que devolve o padrão.
  gravarConfig(CHAVE_PROVA, '');

  var ordenado = provaOrdemDecrescente_(ultimos.map(function (r) { return r._id; }));
  var ok = lido === carimbo && !segredoNoBanco && ultimos.length > 0 &&
    ultimos[0].acao === 'PROVA' && ordenado && cursos.length > 0;

  Logger.log(ok
    ? 'OK. A configuração foi ao banco e voltou idêntica, nenhum segredo está no ' +
      'documento que o formulário público lê, e o log mais recente veio primeiro ' +
      'com orderBy + limit — não com varredura da coleção.'
    : 'FALHOU. Confira acima qual das quatro afirmações não se sustentou: ' +
      'ida e volta da config, segredo fora do banco, log gravado, ordem decrescente.');

  return { criadas: criadas, lido: lido, registros: ultimos.length, ok: ok };
}

/** Confere se os ids vieram em ordem decrescente, sem repetição. */
function provaOrdemDecrescente_(ids) {
  for (var i = 1; i < ids.length; i++) {
    if (ids[i - 1] <= ids[i]) return false;
  }
  return true;
}

/**
 * Prova 2: o Apps Script fala com o Firestore. O portão do projeto.
 *
 * Custa UMA leitura e nenhuma escrita: lê um documento que provavelmente não
 * existe. Documento inexistente é sucesso — o que está sendo provado é que a
 * chamada saiu, foi autorizada e voltou respondida. Se o token não servisse, não
 * haveria resposta nenhuma para interpretar.
 *
 * O que ela NÃO prova: permissão de escrita. Quem prova isso é `provaConfigELog`.
 *
 * Quando falha, o diagnóstico abaixo diz o que olhar, na ordem. Ninguém deveria
 * precisar ler este código para entender o resultado.
 */
function provaConectar() {
  Logger.log('=== provaConectar ===');

  try {
    var projeto = fsProjeto_();
    var banco = fsBanco_();
    Logger.log('projeto Firestore: ' + projeto + ' / banco: ' + banco);

    var lido = ler(COL_CONEXAO, 'ping');
    Logger.log('leitura de ' + COL_CONEXAO + '/ping: ' +
      (lido ? 'documento existe' : 'documento não existe — e isso é sucesso'));

    Logger.log('OK. O Apps Script está autenticado no Firestore deste projeto: a ' +
      'chamada saiu, foi autorizada e voltou respondida. Custo: 1 leitura, 0 escritas.');
    Logger.log('Escrita ainda não foi provada — quem prova é provaConfigELog().');
    return { ok: true, projeto: projeto, banco: banco, existia: !!lido };
  } catch (e) {
    Logger.log('FALHOU: ' + e.message);
    provaDiagnostico_(e);
    return { ok: false, erro: e.message };
  }
}

/**
 * O que olhar quando `provaConectar` falha.
 *
 * São sempre os mesmos três suspeitos — propriedade do script, projeto Cloud
 * associado, escopos do manifesto — e o erro do Firestore diz qual deles é.
 */
function provaDiagnostico_(erro) {
  var mensagem = String(erro.message || '');
  var status = String(erro.status || '');
  var codigo = Number(erro.codigo || 0);

  Logger.log('--- o que olhar ---');

  if (mensagem.indexOf('FIRESTORE_PROJETO') !== -1) {
    Logger.log('A propriedade do script não existe. No editor: Configurações do projeto');
    Logger.log('> Propriedades do script > Adicionar > FIRESTORE_PROJETO = unicesusc-cesutech');
    Logger.log('Passo a passo em documentacao/01-configurar-o-ambiente.md.');
    return;
  }

  if (codigo === 401 || status === 'UNAUTHENTICATED') {
    Logger.log('1. O token não foi aceito. Rode qualquer função pelo editor e ACEITE a tela');
    Logger.log('   de autorização — depois de mexer nos escopos, o Google pede de novo.');
    Logger.log('2. Confira o escopo https://www.googleapis.com/auth/datastore em');
    Logger.log('   apps-script/appsscript.json (Configurações > mostrar appsscript.json).');
    return;
  }

  if (codigo === 403 || status === 'PERMISSION_DENIED') {
    Logger.log('1. Projeto Cloud: o script precisa estar associado ao projeto do Firebase.');
    Logger.log('   Configurações do projeto > Projeto do Google Cloud > Alterar projeto >');
    Logger.log('   número do projeto 573609930291 (unicesusc-cesutech).');
    Logger.log('2. Escopo datastore no appsscript.json, e reautorização depois de mudá-lo.');
    Logger.log('3. A conta que executa precisa de acesso ao projeto no Cloud. A conta que');
    Logger.log('   criou o Firebase é dona dele; outra conta precisa ser convidada.');
    Logger.log('OBS: as regras de segurança do Firestore ("allow read, write: if false") NÃO');
    Logger.log('     são a causa. Elas valem para SDK de navegador e celular; a chamada REST');
    Logger.log('     com token OAuth do Google é governada por IAM, não por elas.');
    return;
  }

  if (codigo === 404 || status === 'NOT_FOUND') {
    Logger.log('Documento inexistente não chega aqui — `ler` devolve null nesse caso.');
    Logger.log('404 aqui é o BANCO que não foi encontrado:');
    Logger.log('1. FIRESTORE_PROJETO tem o ID do projeto (unicesusc-cesutech), e não o número.');
    Logger.log('2. O Firestore foi criado no console do Firebase? Deve estar em');
    Logger.log('   southamerica-east1, banco (default).');
    Logger.log('3. Se o banco não for o (default), configure também FIRESTORE_BANCO.');
    return;
  }

  if (codigo === 429 || status === 'RESOURCE_EXHAUSTED') {
    Logger.log('Cota do dia estourada. O plano Spark dá 50 mil leituras e 20 mil escritas');
    Logger.log('por dia, e o contador zera à meia-noite no fuso do Pacífico (04h ou 05h aqui).');
    Logger.log('Se isso aconteceu sem uso real, alguma prova rodou em laço — veja provaVazao.');
    return;
  }

  Logger.log('Erro fora dos casos conhecidos. Na ordem:');
  Logger.log('1. Propriedade FIRESTORE_PROJETO = unicesusc-cesutech');
  Logger.log('2. Projeto Cloud associado (número 573609930291)');
  Logger.log('3. Escopos script.external_request e datastore no appsscript.json');
}

/**
 * Prova 3, a central: a unicidade passa a ser do BANCO.
 *
 * No projeto sobre Sheets, impedir a mesma pessoa de entrar duas vezes no mesmo
 * projeto custa uma varredura da coluna `hash_dedup` a cada inscrição — O(n),
 * dentro do lock, e correta apenas porque o lock existe. Se duas execuções
 * lessem a coluna antes de qualquer uma escrever, as duas concluiriam "não
 * existe" e as duas gravariam.
 *
 * Aqui a chave de dedup vira o id do documento, e quem recusa a segunda é o
 * banco, numa operação atômica.
 *
 * A chave é montada à mão porque `chaveDedup_` mora em 04_Inscricoes.gs, que
 * ainda não foi trazido. A regra reproduzida é a dele: projeto + pessoa, com
 * `hash` de 01_Utils.gs, que é a mesma função dos dois lados.
 */
function provaUnicidade() {
  var dados = {
    projeto_id: 'proj_prova',
    projeto_nome: 'PROJETO DA PROVA',
    matricula: '09110001',
    nome: 'Aluno de Teste',
    email: 'aluno.teste@exemplo.com',
    criado_em: agora()
  };

  var chave = hash(dados.projeto_id + '::' + dados.matricula);

  // Recomeço limpo: a chave é estável, então rodar duas vezes seguidas mostraria
  // "já existia" nas duas gravações e esconderia a prova. Apagar o que não
  // existe é idempotente no Firestore, então não precisa de guarda.
  excluir(COL_DEDUP, chave);

  var primeira = inserir(COL_DEDUP, dados, chave);
  var segunda = inserir(COL_DEDUP, dados, chave);
  var total = contar(COL_DEDUP, { campo: 'matricula', valor: dados.matricula });

  Logger.log('=== provaUnicidade ===');
  Logger.log('chave de dedup (projeto + matrícula) = ' + chave);
  Logger.log('1a gravação: criado=' + primeira.criado + ' jaExistia=' + primeira.jaExistia);
  Logger.log('2a gravação: criado=' + segunda.criado + ' jaExistia=' + segunda.jaExistia);
  Logger.log('documentos com matricula ' + dados.matricula + ': ' + total);

  var ok = primeira.criado && segunda.jaExistia && total === 1;
  Logger.log(ok
    ? 'OK. A segunda gravação foi recusada PELO BANCO (409 ALREADY_EXISTS), sem ' +
      'nenhuma leitura prévia e sem lock. No Sheets isso é varredura O(n) da ' +
      'coluna hash_dedup a cada inscrição.'
    : 'FALHOU. A unicidade não foi imposta pelo banco.');

  return { chave: chave, total: total, ok: ok };
}

/**
 * Prova 4: ordenar não embaralha registro.
 *
 * Na planilha, ordenar uma coluna pelo menu ordena AQUELA coluna. O nome de um
 * aluno passa a apontar para a matrícula de outro, sem erro, sem aviso e sem
 * como saber depois — é a forma mais comum de corromper dado em planilha
 * compartilhada, e não exige má intenção nenhuma.
 *
 * No banco, ordenação é da consulta, não do dado: os campos de um registro são
 * um documento, e viajam juntos por construção.
 */
function provaOrdenacaoNaoCorrompe() {
  var alunos = [
    { matricula: '09110001', nome: 'Ana Prado', curso_fase: 'ADS11' },
    { matricula: '00042000', nome: 'Bruno Lima', curso_fase: 'ADM21' },
    { matricula: '10009999', nome: 'Carla Souza', curso_fase: 'MKT31' },
    { matricula: '00500001', nome: 'Diego Rocha', curso_fase: 'AU71' },
    { matricula: '09876543', nome: 'Elisa Nunes', curso_fase: 'PMM31' }
  ];

  var esperado = {};
  alunos.forEach(function (a) {
    esperado[a.matricula] = a.nome + '|' + a.curso_fase;
    inserir(COL_ORDENACAO, a, a.matricula);
  });

  var porNome = listar(COL_ORDENACAO, { ordenarPor: 'nome', direcao: 'ASC' }).itens;
  var porMatricula = listar(COL_ORDENACAO, { ordenarPor: 'matricula', direcao: 'DESC' }).itens;

  Logger.log('=== provaOrdenacaoNaoCorrompe ===');
  Logger.log('por nome (crescente):');
  porNome.forEach(function (r) {
    Logger.log('  ' + r.matricula + '  ' + r.nome + '  ' + r.curso_fase);
  });
  Logger.log('por matrícula (decrescente):');
  porMatricula.forEach(function (r) {
    Logger.log('  ' + r.matricula + '  ' + r.nome + '  ' + r.curso_fase);
  });

  var intacto = porNome.concat(porMatricula).every(function (r) {
    return esperado[r.matricula] === r.nome + '|' + r.curso_fase;
  });

  Logger.log(intacto
    ? 'OK. Duas ordenações diferentes, e cada matrícula continua com o nome e o ' +
      'curso dela. Ordenar uma coluna na planilha faria justamente o contrário.'
    : 'FALHOU. Algum registro voltou com campo de outro.');

  return { porNome: porNome.length, porMatricula: porMatricula.length, intacto: intacto };
}

/**
 * Prova 5: o que entra é o que sai.
 *
 * A lista abaixo é o museu de coerções do Sheets, e cada linha custou depuração:
 * '09110001' vira 9110001, '21:00' vira 30/12/1899 21:00, '2002-05-09' vira um
 * objeto Date que o google.script.run não serializa e devolve `null` ao cliente.
 * `forcarFormatoTexto_` e `normalizarCelula_` existem lá só para desfazer isso.
 */
function provaTipoForte() {
  var id = uid('tipos');
  var original = {
    matricula: '09110001',
    data_nascimento: '2002-05-09',
    criado_em: '2026-08-05 16:50:00',
    horario: '21:00',
    vagas: '60',
    telefone: '+55 48 99999-0002',
    codigo: '007'
  };

  inserir(COL_TIPOS, original, id);
  var lido = ler(COL_TIPOS, id);

  Logger.log('=== provaTipoForte ===');
  var iguais = true;
  Object.keys(original).forEach(function (campo) {
    var voltou = lido ? lido[campo] : undefined;
    var ok = voltou === original[campo];
    if (!ok) iguais = false;
    Logger.log('  ' + campo + ': gravei ' + JSON.stringify(original[campo]) +
      ' / recebi ' + JSON.stringify(voltou) + (ok ? '' : '   <-- DIFERENTE'));
  });

  Logger.log(iguais
    ? 'OK. Todos os campos voltaram idênticos, como texto. No Sheets, sem ' +
      'forcarFormatoTexto_, a matrícula perderia o zero à esquerda, o horário ' +
      'viraria 30/12/1899 e a data viraria Date.'
    : 'FALHOU. Algum campo voltou diferente.');

  return lido;
}

/**
 * Prova 6: quanto o Firestore escreve por segundo, medido daqui.
 *
 * Referência: 1,2 inscrição/s no Sheets hoje, com 4 chamadas de ~200 ms dentro
 * do lock.
 *
 * Duas honestidades sobre este número:
 *
 * 1. Isto mede UMA execução gravando em sequência, não 30 execuções simultâneas.
 *    O gargalo real do evento do auditório é o teto de execuções concorrentes do
 *    Apps Script, que é da plataforma e continuaria igual com qualquer banco.
 * 2. Cota do plano Spark: 20.000 escritas por DIA, por projeto, zerando à
 *    meia-noite no fuso do Pacífico. n=20 é o padrão por isso. Rodar com n=500
 *    quatro vezes já queima 10% da cota do dia, e uma cota estourada aqui também
 *    derruba as outras provas.
 */
function provaVazao(n) {
  var total = Number(n) > 0 ? Math.floor(Number(n)) : 20;
  var carimbo = new Date().getTime();

  var inicio = new Date().getTime();
  for (var i = 0; i < total; i++) {
    inserir(COL_VAZAO, {
      projeto_id: 'proj_prova',
      matricula: 'PROVA' + carimbo + i,
      nome: 'Aluno Sintetico ' + i,
      email: 'sintetico' + i + '@exemplo.com',
      criado_em: agora()
    }, 'vazao_' + carimbo + '_' + i);
  }
  var ms = new Date().getTime() - inicio;

  var porSegundo = ms > 0 ? (total / (ms / 1000)) : 0;

  Logger.log('=== provaVazao ===');
  Logger.log(total + ' inscrições em ' + ms + ' ms');
  Logger.log('média por escrita: ' + (ms / total).toFixed(0) + ' ms');
  Logger.log('vazão: ' + porSegundo.toFixed(1) + ' inscrições/s');
  Logger.log('referência medida no Sheets hoje: 1,2 inscrições/s');
  Logger.log('Sequencial, uma execução só. Não mede concorrência — o teto de 30 ' +
    'execuções simultâneas do Apps Script continuaria valendo.');

  return { total: total, ms: ms, porSegundo: porSegundo };
}

/**
 * Apaga TUDO que as provas criaram.
 *
 * Duas guardas, porque isto é uma função de deleção em massa:
 *   1. só entram coleções cujo nome começa com `teste_`;
 *   2. `provaApagarColecao_` recusa (lançando) qualquer nome sem o prefixo,
 *      mesmo que alguém a chame direto do editor por engano.
 *
 * `config` e `log` não têm o prefixo e por isso não são tocadas — nem a linha
 * 'PROVA' que `provaConfigELog` deixou, que é registro de auditoria legítimo.
 *
 * Não existe DROP COLLECTION no Firestore: coleção é um agrupamento implícito e
 * some sozinha quando o último documento dela é apagado.
 */
function provaLimpar() {
  var colecoes = fsColecoes_().filter(function (c) {
    return String(c).indexOf(PREFIXO_PROVA) === 0;
  });

  Logger.log('=== provaLimpar ===');
  if (!colecoes.length) {
    Logger.log('Nada a apagar: nenhuma coleção com o prefixo ' + PREFIXO_PROVA + '.');
    return { colecoes: 0, documentos: 0 };
  }

  var apagados = 0;
  colecoes.forEach(function (colecao) {
    var n = provaApagarColecao_(colecao);
    apagados += n;
    Logger.log('  ' + colecao + ': ' + n + ' documento(s) apagado(s)');
  });

  Logger.log(apagados + ' documento(s) em ' + colecoes.length + ' coleção(ões).');
  Logger.log('Nenhuma coleção sem o prefixo ' + PREFIXO_PROVA + ' foi tocada.');
  return { colecoes: colecoes.length, documentos: apagados };
}

/**
 * Apaga uma coleção página a página.
 *
 * Não precisa de cursor: os documentos saem conforme são apagados, então a
 * próxima consulta já devolve o bloco seguinte. O teto de páginas é o que impede
 * um laço aberto encostar no limite de 6 minutos por execução — se sobrar coisa,
 * o log avisa e basta rodar de novo.
 */
function provaApagarColecao_(colecao) {
  if (String(colecao).indexOf(PREFIXO_PROVA) !== 0) {
    throw new Error('provaApagarColecao_ só apaga coleções com o prefixo ' +
      PREFIXO_PROVA + '. Recebi: ' + colecao);
  }

  var apagados = 0;
  for (var pagina = 0; pagina < PROVA_MAX_PAGINAS; pagina++) {
    var itens = listar(colecao, { limite: PROVA_TAMANHO_PAGINA }).itens;
    if (!itens.length) return apagados;

    itens.forEach(function (item) {
      excluir(colecao, item._id);
      apagados++;
    });
  }

  Logger.log('  ATENÇÃO: ' + colecao + ' pode ter mais documentos. Rode provaLimpar() de novo.');
  return apagados;
}

/**
 * Retrato do banco: cada projeto, o teto declarado e quantos entraram de fato.
 *
 * Existe porque o painel ainda não lista nada, e "acho que passaram três" não é
 * uma frase sobre a qual se decide. A contagem sai da mesma agregação que
 * `reservarVaga` usa para decidir a vaga — se este relatório disser ABERTO com o
 * teto estourado, o problema é a regra, e não a leitura.
 */
function diagnostico() {
  Logger.log('=== diagnostico ===');

  var projetos = listar(PROJETOS_COLECAO, {}).itens;
  if (!projetos.length) {
    Logger.log('nenhum projeto cadastrado');
    return;
  }

  projetos.forEach(function (p) {
    var inscritos = contarInscritos_(p._id);
    var teto = Number(p.vagas || 0);
    Logger.log('%s | %s | vagas=%s | inscritos=%s | %s%s',
      p._id,
      p.nome,
      teto > 0 ? String(teto) : 'ILIMITADO (vagas=0 ou em branco)',
      inscritos,
      situacaoDe_(p, inscritos),
      teto > 0 && inscritos > teto ? '  <<< TETO ESTOURADO' : '');
  });

  var total = contar(INSCRICOES_COLECAO, {});
  Logger.log('total de inscrições no banco: %s', total);
}

/**
 * Força o Google a pedir os escopos, na hora que VOCÊ escolher.
 *
 * O Apps Script só abre a tela de consentimento quando uma execução precisa de
 * um escopo que a autorização atual não cobre. `diagnostico()` e as provas só
 * tocam no Firestore — então elas passam direto, e um escopo que ainda falte só
 * seria cobrado no meio de um clique do professor. Descobrir isso com o arquivo
 * dele na mão é o pior momento possível.
 *
 * O QUE ELA ERA, e por que mudou. Até 07/08 esta função chamava
 * `SpreadsheetApp.openById` e `DocumentApp.openById` com um id inválido, só para
 * forçar o consentimento de `/auth/spreadsheets` e `/auth/documents` — os dois
 * escopos amplos que a importação exigia. Os dois saíram do manifesto (o XLSX
 * passou a ser lido dos próprios bytes e o PDF pelo export do Drive; ver
 * 05_Importacao.gs). Manter as duas linhas aqui NÃO seria inofensivo: a simples
 * menção estática a esses serviços é o que faz o Google exigir o escopo, então
 * elas sozinhas ressuscitariam exatamente o que se quis tirar. Por isso foram
 * embora, e existe teste que falha se voltarem.
 *
 * O que sobrou para forçar: `drive.file`. É o único escopo que o Firestore não
 * exercita, e ele é usado em três lugares — o temporário da importação, o OCR do
 * PDF e a galeria de banners.
 *
 * Nada aqui cria, altera ou apaga arquivo. A listagem é de UMA página com UM
 * item, e com `drive.file` ela só alcança o que este script criou: os arquivos
 * pessoais de quem instala continuam invisíveis para o sistema, inclusive para
 * esta função.
 */
function autorizar() {
  Logger.log('=== autorizar ===');
  Logger.log('Escopos do manifesto: script.external_request, datastore, ' +
    'drive.file, script.scriptapp, userinfo.email, script.send_mail.');

  // userinfo.email — quem o painel vai registrar como autor de cada ação.
  Logger.log('e-mail autorizado: %s', usuarioAtual());

  // drive.file — a chamada mais barata que exige o escopo.
  try {
    var pagina = Drive.Files.list({
      pageSize: 1,
      fields: 'files(id)',
      q: 'trashed = false',
      supportsAllDrives: true
    });
    var quantos = (pagina && pagina.files) ? pagina.files.length : 0;
    Logger.log('Drive respondeu: %s arquivo(s) deste app na primeira página.', quantos);
    Logger.log('Zero é resultado normal — significa que o app ainda não criou nada.');
  } catch (e) {
    Logger.log('Drive RECUSOU: %s', e.message);
    Logger.log('Confira se o serviço avançado está ligado (Serviços > + > Drive API v3)');
    Logger.log('e se drive.file continua no appsscript.json.');
    return;
  }

  // script.send_mail — o escopo mais novo, e o único cuja falta não aparece na
  // hora. Sem ele o sistema funciona inteiro até alguém precisar de um link de
  // acesso, que é exatamente o dia em que ninguém está olhando. Esta chamada não
  // envia nada: ela só pergunta a cota, e é o suficiente para o Google exigir a
  // concessão aqui, com a tela de consentimento aberta na frente de quem pode
  // conceder.
  try {
    var restam = MailApp.getRemainingDailyQuota();
    Logger.log('E-mail: %s envio(s) restantes hoje.', restam);
    Logger.log('É a cota que o link de acesso ao painel consome — uma mensagem por pedido.');
    if (restam <= 0) {
      Logger.log('ZERO hoje: o link por e-mail não sai até a meia-noite do Pacífico.');
      Logger.log('O botão "Entrar com o Google" não depende disto e continua valendo.');
    }
  } catch (e) {
    Logger.log('E-mail RECUSADO: %s', e.message);
    Logger.log('Confira se script.send_mail está no appsscript.json. Sem ele, o link');
    Logger.log('de acesso ao painel não é enviado — e é a porta de recuperação.');
    return;
  }

  Logger.log('Autorização completa. Se a tela de consentimento NÃO apareceu,');
  Logger.log('os escopos já estavam concedidos.');
}
