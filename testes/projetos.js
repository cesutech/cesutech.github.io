/**
 * projetos.js — testa projetos e controle de vagas (09_Projetos.gs) sem tocar no
 * Google.
 *
 * O que se prova aqui, em ordem de importância:
 *   1. a contagem de inscritos é lida DENTRO da região serializada — é o que
 *      impede a vaga 61 de ser vendida quando só existem 60;
 *   2. as quatro recusas por situação (não encontrado, inativo, fechado,
 *      esgotado) continuam com as mesmas mensagens do sistema em produção;
 *   3. o CRUD do painel não ressuscita projeto excluído nem apaga projeto com
 *      inscritos.
 *
 * O `LockService` não existe no sandbox de `apoio.js`, e não foi acrescentado
 * lá: um lock falso que só entra e sai não provaria nada. O daqui carimba, a
 * cada entrada e saída, QUANTAS requisições já tinham ido ao Firestore — é isso
 * que permite afirmar que a agregação caiu dentro da região protegida, e não
 * antes dela. Ele também sabe simular a execução vizinha que termina de gravar
 * enquanto esperamos na fila.
 *
 * Uso:  node testes/projetos.js
 */

'use strict';

const {
  teste, grupo, igual, verdadeiro, lancou, resultado, criarAmbiente
} = require('./apoio');

const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '03_Config.gs', '04_Log.gs',
  '07_Auth.gs', '09_Projetos.gs'];

function ambiente(opcoes) {
  return criarAmbiente(Object.assign({ arquivos: GS, usuario: '' }, opcoes || {}));
}

/**
 * Lock falso com memória.
 *
 * `requisicao` guarda o tamanho da fila de requisições no instante do evento —
 * o índice da próxima chamada ao Firestore. Comparar esse número com o índice da
 * agregação é o que transforma "confio que está dentro do lock" em prova.
 *
 * opcoes:
 *   aoEsperar  roda enquanto esperamos o lock — a execução vizinha gravando
 *   falhar     `waitLock` estoura, como quando a fila passa de TIMEOUT_LOCK_MS
 */
function comLock(api, falso, opcoes) {
  opcoes = opcoes || {};
  const eventos = [];

  api.LockService = {
    getScriptLock: () => ({
      waitLock(ms) {
        eventos.push({ tipo: 'pediu', ms: ms, requisicao: falso.requisicoes.length });
        if (opcoes.aoEsperar) opcoes.aoEsperar();
        if (opcoes.falhar) throw new Error('Could not obtain lock in 90000 ms.');
        eventos.push({ tipo: 'pegou', requisicao: falso.requisicoes.length });
      },
      releaseLock() {
        eventos.push({ tipo: 'soltou', requisicao: falso.requisicoes.length });
      }
    })
  };

  return eventos;
}

function marco(eventos, tipo) {
  const achado = eventos.filter((e) => e.tipo === tipo)[0];
  if (!achado) throw new Error('o lock nunca recebeu "' + tipo + '"');
  return achado.requisicao;
}

/** Índice da primeira requisição que casa com o teste. -1 quando não houve. */
function indiceDaRequisicao(falso, casa) {
  for (let i = 0; i < falso.requisicoes.length; i++) {
    if (casa(falso.requisicoes[i])) return i;
  }
  return -1;
}

function quantasAgregacoes(falso) {
  return falso.requisicoes.filter((r) => r.url.indexOf(':runAggregationQuery') !== -1).length;
}

function criarProjeto(api, id, campos) {
  api.inserir('projetos', Object.assign({
    codigo: id,
    nome: 'Projeto ' + id,
    descricao: '',
    professor: 'Marina Exemplo',
    email_professor: 'marina@exemplo.com',
    banner: '',
    vagas: '60',
    local: 'Auditório',
    horario: '19:00',
    primeiro_encontro: '2026-08-20',
    ativo: 'SIM',
    inscricoes_abertas: 'SIM',
    validar_matricula: 'SIM',
    ordem: '1',
    criado_em: '2026-08-05 10:00:00',
    criado_por: 'coordenacao@exemplo.com',
    atualizado_em: '2026-08-05 10:00:00'
  }, campos || {}), id);
}

function inscrever(api, projetoId, quantas) {
  for (let i = 0; i < quantas; i++) {
    api.inserir('inscricoes', { projeto_id: projetoId, nome: 'Aluno ' + i }, projetoId + '_i' + i);
  }
}

/** Grava uma inscrição como a fase de inscrições vai gravar: uma escrita só. */
function gravador(api, projetoId, id) {
  return function (projeto) {
    const r = api.inserir('inscricoes', { projeto_id: projetoId, projeto_nome: projeto.nome }, id);
    return { ok: true, duplicada: r.jaExistia, id: id };
  };
}

/**
 * Uma sessão de admin, montada como as três portas do painel a montam.
 *
 * `criarSessao_` é o último passo de `autenticar`, `entrarComGoogle` e
 * `entrarComLink`, e é o único que este arquivo precisa: nada aqui é sobre COMO
 * se entra, só sobre o que `exigirAdmin` deixa passar com um token na mão. Entrar
 * pelo login de verdade traria junto a allowlist, o client id e o correio — três
 * dependências que `acesso.js` já prova e que aqui só teriam como quebrar por
 * motivo alheio a projetos.
 *
 * Também não escreve LOGIN na trilha, e isso é o que deixa `acoesDoLog` medir só
 * o que a função sob teste gravou.
 */
function tokenAdmin(api) {
  return api.criarSessao_('coordenacao@exemplo.com');
}

/**
 * As ações da trilha, na ordem em que foram gravadas.
 *
 * Ordem de inserção no Map do falso, e NÃO ordem do id: o id do log carrega o
 * milissegundo mais um sufixo sorteado (ver `logId_` em 04_Log.gs), e duas ações
 * do mesmo teste caem no mesmo milissegundo. Ordenar por id faria o sorteio
 * decidir o resultado do teste — que passaria ou falharia por sorte.
 */
function acoesDoLog(falso) {
  const acoes = [];
  falso.documentos.forEach((campos, chave) => {
    if (chave.indexOf('log/') === 0) acoes.push(campos.acao.stringValue);
  });
  return acoes;
}

// ============================================================================

console.log('\n\x1b[1mUNICESUSC CESUTECH — projetos e controle de vagas (09_Projetos.gs)\x1b[0m');

grupo('A vaga é conferida DENTRO da região protegida');

// Este é o teste que justifica o arquivo inteiro. A execução vizinha termina de
// gravar a última vaga enquanto estamos na fila do lock; quem contasse antes de
// esperar veria 0 inscritos, passaria pela conferência e venderia a vaga 2 de um
// projeto de 1 vaga.
teste('inscrição que chega enquanto esperamos o lock é contada, e esgota o projeto', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '1' });

  comLock(api, falso, {
    aoEsperar: () => { inscrever(api, 'proj_1', 1); }
  });

  const r = api.reservarVaga('proj_1', () => { throw new Error('não podia ter chamado gravar'); });

  igual(r.ok, false);
  igual(r.situacao, 'ESGOTADO');
  igual(falso.documentos.size, 2, 'só o projeto e a inscrição da execução vizinha');
});

teste('a agregação e a escrita caem entre pegar e soltar o lock; a leitura do projeto, fora', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '60' });
  falso.requisicoes.length = 0;

  const eventos = comLock(api, falso);
  const r = api.reservarVaga('proj_1', gravador(api, 'proj_1', 'insc_1'));
  igual(r.ok, true);

  const pegou = marco(eventos, 'pegou');
  const soltou = marco(eventos, 'soltou');

  const agregacao = indiceDaRequisicao(falso, (q) => q.url.indexOf(':runAggregationQuery') !== -1);
  const escrita = indiceDaRequisicao(falso, (q) => q.metodo === 'POST' && q.url.indexOf('/inscricoes?') !== -1);
  const leituraProjeto = indiceDaRequisicao(falso, (q) => q.metodo === 'GET' && q.url.indexOf('/projetos/') !== -1);

  verdadeiro(agregacao >= pegou && agregacao < soltou,
    'a contagem foi a requisição ' + agregacao + ', e a região vai de ' + pegou + ' a ' + soltou);
  verdadeiro(escrita >= pegou && escrita < soltou,
    'a escrita foi a requisição ' + escrita + ', e a região vai de ' + pegou + ' a ' + soltou);
  verdadeiro(leituraProjeto !== -1 && leituraProjeto < pegou,
    'ler o projeto não participa do invariante e não pode entrar na fila: foi ' + leituraProjeto);
});

teste('a região protegida custa duas chamadas ao Firestore, não a coleção inteira', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '60' });
  inscrever(api, 'proj_1', 40);
  falso.requisicoes.length = 0;

  const eventos = comLock(api, falso);
  api.reservarVaga('proj_1', gravador(api, 'proj_1', 'insc_1'));

  igual(marco(eventos, 'soltou') - marco(eventos, 'pegou'), 2,
    'contar e gravar — o tamanho não pode crescer com o total de inscritos');
});

teste('lock não obtido: recusa dizendo que nada se perdeu, sem gravar e sem soltar', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1');

  const eventos = comLock(api, falso, { falhar: true });
  const r = api.reservarVaga('proj_1', () => { throw new Error('não podia ter chamado gravar'); });

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('não foram perdidos') !== -1, 'mensagem foi: ' + r.erro);
  igual(eventos.filter((e) => e.tipo === 'soltou').length, 0, 'não se solta lock que não se pegou');
  igual(falso.documentos.size, 1, 'só o projeto');
});

teste('gravar lançando não deixa o lock preso', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1');

  const eventos = comLock(api, falso);
  lancou(() => api.reservarVaga('proj_1', () => { throw new Error('Firestore 503'); }), '503');

  igual(eventos.filter((e) => e.tipo === 'soltou').length, 1);
});

teste('o tempo de espera pelo lock é o TIMEOUT_LOCK_MS do arquivo', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1');

  const eventos = comLock(api, falso);
  api.reservarVaga('proj_1', gravador(api, 'proj_1', 'insc_1'));

  igual(eventos[0].ms, api.TIMEOUT_LOCK_MS);
  igual(api.TIMEOUT_LOCK_MS, 90000);
});

grupo('As quatro recusas por situação');

teste('projeto que não existe: recusa sem situacao e sem entrar na fila do lock', () => {
  const { api, falso } = ambiente();
  const eventos = comLock(api, falso);

  const r = api.reservarVaga('proj_fantasma', () => { throw new Error('não podia ter gravado'); });

  igual(r, { ok: false, erro: 'Projeto não encontrado.' });
  igual(eventos.length, 0, 'recusa que não depende da contagem não serializa ninguém');
});

teste('projeto inativo: recusa com INATIVO, sem lock', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { ativo: 'NAO' });
  const eventos = comLock(api, falso);

  const r = api.reservarVaga('proj_1', () => { throw new Error('não podia ter gravado'); });

  igual(r, { ok: false, erro: 'Este projeto não está disponível.', situacao: 'INATIVO' });
  igual(eventos.length, 0);
});

teste('inscrições encerradas: recusa com FECHADO, sem lock', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { inscricoes_abertas: 'NAO' });
  const eventos = comLock(api, falso);

  const r = api.reservarVaga('proj_1', () => { throw new Error('não podia ter gravado'); });

  igual(r, { ok: false, erro: 'As inscrições para este projeto estão encerradas.', situacao: 'FECHADO' });
  igual(eventos.length, 0);
});

// Esgotado é a única das quatro que só se descobre contando — e por isso é a
// única que paga o lock antes de recusar.
teste('projeto cheio: recusa com ESGOTADO, e essa passou pelo lock', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '2' });
  inscrever(api, 'proj_1', 2);
  const eventos = comLock(api, falso);

  const r = api.reservarVaga('proj_1', () => { throw new Error('não podia ter gravado'); });

  igual(r.ok, false);
  igual(r.situacao, 'ESGOTADO');
  igual(r.erro, 'Inscrições esgotadas. Escolha outro projeto de extensão disponível.');
  igual(eventos.filter((e) => e.tipo === 'soltou').length, 1, 'e o lock foi devolvido');
});

teste('o texto do esgotado é o que a coordenação escreveu em texto_esgotado', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '1' });
  inscrever(api, 'proj_1', 1);
  api.gravarConfig('texto_esgotado', 'Turma cheia. Procure a coordenação do CESUTECH.');
  comLock(api, falso);

  igual(api.reservarVaga('proj_1', () => ({ ok: true })).erro,
    'Turma cheia. Procure a coordenação do CESUTECH.');
});

// ============================================================================
// A fila de espera — `vagas_excedentes_em_espera`
//
// A régua deste bloco inteiro: com a chave em NAO, NADA muda. É o modo que o
// evento de sexta vai rodar, e é o modo que o teste de carga aprovou. Os testes
// de cima deste arquivo continuam sendo a prova disso — este bloco existe para
// provar que o modo novo não empresta nada ao antigo.
// ============================================================================

grupo('Fila de espera: com a chave em NAO, o sistema é o de sempre');

/** Grava como `submeterInscricao` grava: honrando o segundo argumento. */
function gravadorComEspera(api, projetoId, id) {
  return function (projeto, emEspera) {
    const campos = { projeto_id: projetoId, projeto_nome: projeto.nome };
    if (emEspera) { campos.em_espera = 'SIM'; campos.espera_de = projetoId; }
    const r = api.inserir('inscricoes', campos, id);
    return { ok: true, duplicada: r.jaExistia, id: id, em_espera: Boolean(emEspera) };
  };
}

teste('o padrão de CONFIG_PADRAO é NAO — ninguém liga a fila por engano', () => {
  const { api } = ambiente();
  const padrao = api.CONFIG_PADRAO.filter((c) => c.chave === 'vagas_excedentes_em_espera')[0];

  verdadeiro(padrao !== undefined, 'a chave sumiu de CONFIG_PADRAO');
  igual(padrao.valor, 'NAO');
  igual(api.esperaLigada_(), false, 'e sem a chave no banco a resposta também é não');
});

teste('com a chave em NAO, o esgotado continua recusando e nada é gravado', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '2' });
  inscrever(api, 'proj_1', 2);
  comLock(api, falso);

  const r = api.reservarVaga('proj_1', gravadorComEspera(api, 'proj_1', 'insc_nova'));

  igual(r.ok, false);
  igual(r.situacao, 'ESGOTADO');
  igual(api.ler('inscricoes', 'insc_nova'), null, 'a recusa não pode ter gravado nada');
  igual(api.contarInscritos_('proj_1'), 2);
});

teste('com a chave em NAO, a contagem é UMA agregação — a de sempre', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '60' });
  inscrever(api, 'proj_1', 3);
  api.config('cadastro_aberto');          // o cache de config, quente como em produção
  falso.requisicoes.length = 0;

  igual(api.contarInscritos_('proj_1'), 3);
  igual(quantasAgregacoes(falso), 1, 'a segunda agregação só existe com a fila ligada');
  igual(falso.requisicoes.length, 1, 'e nenhuma leitura de configuração a mais');
});

teste('com a chave em NAO, a região protegida continua custando duas chamadas', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '60' });
  const eventos = comLock(api, falso);

  api.reservarVaga('proj_1', gravadorComEspera(api, 'proj_1', 'insc_1'));

  igual(marco(eventos, 'soltou') - marco(eventos, 'pegou'), 2,
    'contar e gravar — a pergunta da fila não pode entrar na fila do lock');
});

grupo('Fila de espera: com a chave em SIM');

teste('o excedente é ACEITO e marcado, em vez de recusado', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '2', nome: 'R+ Cidades' });
  inscrever(api, 'proj_1', 2);
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  comLock(api, falso);

  const r = api.reservarVaga('proj_1', gravadorComEspera(api, 'proj_1', 'insc_espera'));

  igual(r.ok, true, 'o aluno foi recusado: ' + r.erro);
  igual(r.em_espera, true);

  const gravada = api.ler('inscricoes', 'insc_espera');
  igual(gravada.em_espera, 'SIM');
  igual(gravada.espera_de, 'proj_1', 'é este campo que a agregação conta');
});

// O número da tela é o mesmo que decide a vaga. Se a espera entrasse nele, a
// fila se realimentaria: cada pessoa em espera empurraria a próxima para a
// espera, e o site anunciaria um projeto mais cheio do que ele está.
teste('quem está em espera NÃO conta como vaga ocupada', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '2' });
  inscrever(api, 'proj_1', 2);
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  comLock(api, falso);

  api.reservarVaga('proj_1', gravadorComEspera(api, 'proj_1', 'e1'));
  api.reservarVaga('proj_1', gravadorComEspera(api, 'proj_1', 'e2'));
  api.reservarVaga('proj_1', gravadorComEspera(api, 'proj_1', 'e3'));

  igual(api.contarInscritos_('proj_1'), 2, 'a contagem de vagas cresceu com a fila');
  igual(api.contarEmEspera_('proj_1'), 3);

  const p = api.listarProjetos(false)[0];
  igual(p.inscritos, 2, 'o site mostraria um projeto mais cheio do que ele está');
  igual(p.restantes, 0);
  igual(p.situacao, 'ESGOTADO', 'e continua esgotado para quem conta vaga');
});

teste('a fila de um projeto não conta na do outro', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '1' });
  criarProjeto(api, 'proj_2', { vagas: '1' });
  inscrever(api, 'proj_1', 1);
  inscrever(api, 'proj_2', 1);
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  comLock(api, falso);

  api.reservarVaga('proj_1', gravadorComEspera(api, 'proj_1', 'e1'));

  igual(api.contarEmEspera_('proj_1'), 1);
  igual(api.contarEmEspera_('proj_2'), 0);
  igual(api.contarInscritos_('proj_2'), 1);
});

// A marca vale para ESGOTADO e para mais nada. Projeto fechado continua fechado
// — e essas duas recusas nem chegam ao lock.
teste('INATIVO e FECHADO continuam recusando com a fila ligada', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_off', { ativo: 'NAO' });
  criarProjeto(api, 'p_fechado', { inscricoes_abertas: 'NAO' });
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  const eventos = comLock(api, falso);

  igual(api.reservarVaga('p_off', () => { throw new Error('não podia ter gravado'); }),
    { ok: false, erro: 'Este projeto não está disponível.', situacao: 'INATIVO' });
  igual(api.reservarVaga('p_fechado', () => { throw new Error('não podia ter gravado'); }),
    { ok: false, erro: 'As inscrições para este projeto estão encerradas.', situacao: 'FECHADO' });
  igual(eventos.length, 0, 'nenhuma das duas depende da contagem, e nenhuma serializa ninguém');
});

teste('quem entra pela fila não dispara o aviso de PROJETO_ESGOTADO de novo', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '1' });
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  comLock(api, falso);

  api.reservarVaga('proj_1', gravadorComEspera(api, 'proj_1', 'i1'));
  igual(acoesDoLog(falso), ['PROJETO_ESGOTADO'], 'a última vaga avisa uma vez');

  api.reservarVaga('proj_1', gravadorComEspera(api, 'proj_1', 'e1'));
  api.reservarVaga('proj_1', gravadorComEspera(api, 'proj_1', 'e2'));
  igual(acoesDoLog(falso), ['PROJETO_ESGOTADO'],
    'o aviso sairia uma vez por pessoa na fila, até o fim do evento');
});

teste('com a fila ligada, a região protegida custa três chamadas — e isso é o preço', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '60' });
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  const eventos = comLock(api, falso);

  api.reservarVaga('proj_1', gravadorComEspera(api, 'proj_1', 'insc_1'));

  igual(marco(eventos, 'soltou') - marco(eventos, 'pegou'), 3,
    'contar, descontar a fila e gravar — e a leitura da configuração fica FORA');
});

grupo('As 60 vagas fecham em 60, nos dois modos');

/**
 * O invariante inteiro, exercitado como o auditório o exercita.
 *
 * 70 pessoas disputam 60 vagas, e nas dez primeiras esperas uma execução VIZINHA
 * termina de gravar — é a corrida que o lock existe para serializar. O que se conta
 * no fim é `contarInscritos_`: 60, nem 61.
 *
 * `vizinha` grava direto na coleção, sem passar por `reservarVaga`, porque é
 * assim que uma execução paralela aparece para quem está esperando na fila: o
 * documento já está lá quando o lock finalmente vem.
 */
function disputar(api, falso, quantos, vagas) {
  criarProjeto(api, 'proj_1', { vagas: String(vagas) });

  let vizinhas = 0;
  comLock(api, falso, {
    // Uma inscrição vizinha entra enquanto os dez primeiros esperam na fila.
    // Quem contasse ANTES do `waitLock` não a veria, e venderia vaga a mais.
    aoEsperar: () => {
      if (vizinhas >= 10) return;
      api.inserir('inscricoes', { projeto_id: 'proj_1' }, 'vizinha_' + vizinhas);
      vizinhas++;
    }
  });

  const saida = { ok: 0, espera: 0, recusadas: 0 };
  for (let i = 0; i < quantos; i++) {
    const r = api.reservarVaga('proj_1', gravadorComEspera(api, 'proj_1', 'insc_' + i));
    if (!r.ok) saida.recusadas++;
    else if (r.em_espera) saida.espera++;
    else saida.ok++;
  }
  saida.vizinhas = vizinhas;
  return saida;
}

teste('modo NAO: 70 tentativas mais 10 vizinhas em 60 vagas fecham em exatamente 60', () => {
  const { api, falso } = ambiente();
  const r = disputar(api, falso, 70, 60);

  igual(api.contarInscritos_('proj_1'), 60, 'o projeto fechou com um número que não é 60');
  igual(r.ok + r.vizinhas, 60, 'as gravações aceitas somam mais do que as vagas');
  verdadeiro(r.recusadas > 0, 'ninguém foi recusado num projeto que lotou');
  igual(r.espera, 0, 'com a chave em NAO não existe espera');
});

teste('modo SIM: as mesmas 60 vagas fecham em 60, e o excedente vira fila', () => {
  const { api, falso } = ambiente();
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  const r = disputar(api, falso, 70, 60);

  igual(api.contarInscritos_('proj_1'), 60,
    'a fila entrou na conta de vagas — é assim que o projeto fecha com 61');
  igual(r.ok + r.vizinhas, 60, 'alguém ocupou vaga sem que houvesse vaga');
  igual(r.recusadas, 0, 'com a fila ligada ninguém é recusado por esgotado');
  verdadeiro(r.espera > 0, 'ninguém entrou na fila num projeto que lotou');
  igual(api.contarEmEspera_('proj_1'), r.espera, 'a marca da fila não bate com o que foi aceito');
});

grupo('Caminho feliz');

teste('vaga livre: grava e devolve o resultado de quem gravou', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '60', nome: 'R+ Cidades' });
  inscrever(api, 'proj_1', 10);
  comLock(api, falso);

  const r = api.reservarVaga('proj_1', gravador(api, 'proj_1', 'insc_1'));

  igual(r, { ok: true, duplicada: false, id: 'insc_1' });
  igual(api.contarInscritos_('proj_1'), 11);
  igual(api.ler('inscricoes', 'insc_1').projeto_nome, 'R+ Cidades', 'o projeto chega em quem grava');
});

teste('vagas 0 é ilimitado: 500 inscritos e ainda entra', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '0' });
  inscrever(api, 'proj_1', 500);
  comLock(api, falso);

  igual(api.reservarVaga('proj_1', gravador(api, 'proj_1', 'insc_1')).ok, true);
});

teste('a última vaga registra PROJETO_ESGOTADO; a penúltima, não', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '3' });
  inscrever(api, 'proj_1', 1);
  comLock(api, falso);

  api.reservarVaga('proj_1', gravador(api, 'proj_1', 'insc_2'));
  igual(acoesDoLog(falso), [], 'ainda sobra uma vaga');

  api.reservarVaga('proj_1', gravador(api, 'proj_1', 'insc_3'));
  igual(acoesDoLog(falso), ['PROJETO_ESGOTADO']);
});

teste('inscrição duplicada não avisa esgotamento — ela não ocupou vaga', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '2' });
  inscrever(api, 'proj_1', 1);
  comLock(api, falso);

  // Mesmo id de documento da que já existe: é assim que a dedup do Firestore
  // recusa a segunda, sem varrer nada.
  const r = api.reservarVaga('proj_1', gravador(api, 'proj_1', 'proj_1_i0'));

  igual(r.duplicada, true);
  igual(acoesDoLog(falso), []);
  igual(api.contarInscritos_('proj_1'), 1, 'e nenhuma vaga foi consumida');
});

grupo('listarProjetos');

teste('ordena por ordem e, no empate, por nome; embute inscritos e restantes', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_b', { nome: 'Empreender com Propósito', ordem: '2', vagas: '60' });
  criarProjeto(api, 'p_a', { nome: 'Arte Digital Floripa', ordem: '2', vagas: '60' });
  criarProjeto(api, 'p_c', { nome: 'R+ Cidades', ordem: '1', vagas: '60' });
  inscrever(api, 'p_c', 4);

  const lista = api.listarProjetos(false);

  igual(lista.map((p) => p.nome), ['R+ Cidades', 'Arte Digital Floripa', 'Empreender com Propósito']);
  igual(lista[0].id, 'p_c', 'o id vem do nome do documento');
  igual(lista[0].inscritos, 4);
  igual(lista[0].restantes, 56);
  igual(lista[0].situacao, 'ABERTO');
});

// A ordem numérica não sai do `orderBy` da consulta: `ordem` está gravada como
// texto, e ordenação de texto poria o 10 antes do 2.
teste('ordem 10 vem depois de ordem 2, e não antes', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_10', { nome: 'Décimo', ordem: '10' });
  criarProjeto(api, 'p_2', { nome: 'Segundo', ordem: '2' });

  igual(api.listarProjetos(false).map((p) => p.nome), ['Segundo', 'Décimo']);
});

teste('apenasPublicos esconde o inativo e não gasta agregação com ele', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { ativo: 'SIM' });
  criarProjeto(api, 'p_2', { ativo: 'NAO' });
  criarProjeto(api, 'p_3', { ativo: 'SIM' });
  falso.requisicoes.length = 0;

  const publicos = api.listarProjetos(true);
  igual(publicos.map((p) => p.id), ['p_1', 'p_3']);
  igual(quantasAgregacoes(falso), 2, 'contar inscrito de projeto que ninguém vê é leitura paga à toa');

  falso.requisicoes.length = 0;
  igual(api.listarProjetos(false).length, 3);
  igual(quantasAgregacoes(falso), 3);
});

teste('vagas reduzidas abaixo do que já entrou: restantes 0, nunca negativo', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '5' });
  inscrever(api, 'p_1', 8);

  const p = api.listarProjetos(false)[0];
  igual(p.inscritos, 8);
  igual(p.restantes, 0);
  igual(p.situacao, 'ESGOTADO');
});

teste('vagas 0 devolve restantes null — ilimitado não é zero', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '0' });
  igual(api.listarProjetos(false)[0].restantes, null);
});

teste('validar_matricula vazio vale como SIM; NAO vale como NAO', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_1', { validar_matricula: '' });
  criarProjeto(api, 'p_2', { validar_matricula: 'NAO' });

  const lista = api.listarProjetos(false);
  igual(lista.filter((p) => p.id === 'p_1')[0].validar_matricula, true);
  igual(lista.filter((p) => p.id === 'p_2')[0].validar_matricula, false);
});

teste('inscricoes_abertas viaja separado de situacao — INATIVO não zera a informação', () => {
  // O painel deduzia a caixa "Inscrições abertas" de `situacao !== 'FECHADO'`.
  // Como `situacaoDe_` devolve INATIVO antes de olhar `inscricoes_abertas`, todo
  // projeto desativado aparecia com a caixa MARCADA — e salvar reabria as
  // inscrições em silêncio. Atinge em cheio o projeto que `removerProjeto`
  // desativa por ter inscritos, que é justamente o que se fecha de propósito.
  const { api } = ambiente();
  criarProjeto(api, 'p_off', { ativo: 'NAO', inscricoes_abertas: 'NAO' });
  criarProjeto(api, 'p_off_abertas', { ativo: 'NAO', inscricoes_abertas: 'SIM' });
  criarProjeto(api, 'p_fechado', { ativo: 'SIM', inscricoes_abertas: 'NAO' });

  const porId = {};
  api.listarProjetos(false).forEach((p) => { porId[p.id] = p; });

  igual(porId.p_off.situacao, 'INATIVO');
  igual(porId.p_off.inscricoes_abertas, false,
    'a informação existe no banco e tem de chegar à tela sem passar por situacao');
  igual(porId.p_off_abertas.situacao, 'INATIVO');
  igual(porId.p_off_abertas.inscricoes_abertas, true, 'os dois estados são independentes');
  igual(porId.p_fechado.situacao, 'FECHADO');
  igual(porId.p_fechado.inscricoes_abertas, false);
});

teste('projeto desativado por ter inscritos volta com as inscrições ainda fechadas', () => {
  // O ciclo inteiro: removerProjeto desativa e fecha; a tela relê; o que ela
  // mostra na caixa é o que o banco tem, e não o que ela deduziu.
  const { api } = ambiente();
  criarProjeto(api, 'p_1', { ativo: 'SIM', inscricoes_abertas: 'SIM' });
  inscrever(api, 'p_1', 3);

  const r = api.removerProjeto({ token: tokenAdmin(api), id: 'p_1' });
  igual(r.desativado, true, r.erro);

  const p = api.listarProjetos(false)[0];
  igual(p.ativo, false);
  igual(p.inscricoes_abertas, false, 'editar este projeto não pode reabrir as inscrições dele');
});

teste('inscricoes_abertas usa a MESMA régua de situacaoDe_, e vazio é fechado', () => {
  // Aqui a régua não é a de `validar_matricula` (vazio vale como SIM). Vazio já
  // deixa o projeto FECHADO para quem quer se inscrever; devolver `true` faria a
  // caixa aparecer marcada e o próximo Salvar ABRIRIA as inscrições sozinho — o
  // mesmo bug que este campo veio consertar, entrando pela outra porta.
  const { api } = ambiente();
  criarProjeto(api, 'p_1', { ativo: 'SIM', inscricoes_abertas: '' });

  const p = api.listarProjetos(false)[0];
  igual(p.situacao, 'FECHADO');
  igual(p.inscricoes_abertas, false, 'a caixa da tela não pode discordar da situação real');
});

teste('banco sem projeto nenhum devolve lista vazia, sem chamar agregação', () => {
  const { api, falso } = ambiente();
  igual(api.listarProjetos(true), []);
  igual(quantasAgregacoes(falso), 0);
});

teste('projetoPorId devolve null para id que não existe', () => {
  const { api } = ambiente();
  igual(api.projetoPorId('nao-existe'), null);
  igual(api.projetoPorId(''), null);
});

// ============================================================================
// O TEMPO da lista — medido em IDAS ao banco, não em requisições
//
// Medição de 12/08/2026 contra o servidor real: `?api=projetos` com o cache da
// rota frio custava 6,03 / 6,12 / 6,30 s, contra 1,7 a 2,0 s de piso da
// plataforma (uma rota que não toca no banco). Os quatro segundos eram FILA
// INDIANA: seis projetos custavam a consulta da coleção, a leitura da
// configuração e SEIS agregações, cada uma esperando a anterior.
//
// O que o Firestore COBRA não mudou — as mesmas agregações, o mesmo orçamento de
// leitura de 08_Api.gs, e os testes de cota deste repositório continuam medindo
// os mesmos números. O que mudou é quantas vezes se espera pela rede, e é isso
// que `falso.idas` mede.
// ============================================================================

grupo('A lista custa uma ida, e não uma por projeto');

/** Quantas vezes se foi ao UrlFetchApp, e com quantas requisições em cada. */
function idasDe(falso) {
  return falso.idas.slice();
}

teste('seis projetos custam três idas ao banco — antes eram oito', () => {
  const { api, falso } = ambiente();
  for (let i = 1; i <= 6; i++) criarProjeto(api, 'p' + i, { ordem: String(i) });
  inscrever(api, 'p1', 5);
  inscrever(api, 'p3', 60);

  // Cache de configuração frio, como em produção: cada requisição HTTP do web
  // app é uma execução nova, com o escopo global zerado.
  api.limparCacheConfig();
  falso.requisicoes.length = 0;
  falso.idas.length = 0;

  const lista = api.listarProjetos(true);

  igual(idasDe(falso), [1, 1, 6],
    'a consulta da coleção, a configuração e UM lote com as seis contagens');
  igual(quantasAgregacoes(falso), 6, 'o Firestore cobra as mesmas seis agregações de antes');
  igual(lista.length, 6);
});

teste('as contagens da lista são as mesmas que decidem a vaga', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '60', ordem: '1' });
  criarProjeto(api, 'p_2', { vagas: '60', ordem: '2' });
  criarProjeto(api, 'p_3', { vagas: '60', ordem: '3' });
  inscrever(api, 'p_1', 7);
  inscrever(api, 'p_3', 60);

  const lista = api.listarProjetos(true);

  // Ponto a ponto contra `contarInscritos_`, que é a função que `reservarVaga`
  // usa dentro do lock. Uma lista rápida com número errado é pior do que uma
  // lista lenta.
  lista.forEach((p) => igual(p.inscritos, api.contarInscritos_(p.id), p.id));
  igual(lista.map((p) => p.inscritos), [7, 0, 60], 'e cada contagem foi para o SEU projeto');
  igual(lista.map((p) => p.situacao), ['ABERTO', 'ABERTO', 'ESGOTADO']);
});

// Se a resposta com erro virasse zero, o projeto lotado apareceria como "0 de
// 60" — o cartão mais convidativo da tela —, e o aluno só descobriria no envio.
// Uma tela que não carrega ele recarrega; uma tela que mente sobre vaga, não.
teste('agregação que falha derruba a lista, e não vira "0 de 60" na tela', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '60', ordem: '1' });
  criarProjeto(api, 'p_2', { vagas: '60', ordem: '2' });
  inscrever(api, 'p_1', 60);
  inscrever(api, 'p_2', 60);

  // Falha PARCIAL: a primeira contagem volta boa, a segunda volta com erro.
  const fetchAllOriginal = falso.UrlFetchApp.fetchAll;
  api.UrlFetchApp = {
    fetch: falso.UrlFetchApp.fetch,
    fetchAll(lote) {
      const respostas = fetchAllOriginal(lote);
      respostas[1] = {
        getResponseCode: () => 400,
        getContentText: () => JSON.stringify({
          error: { code: 400, status: 'INVALID_ARGUMENT', message: 'the query requires an index' }
        })
      };
      return respostas;
    }
  };

  const e = lancou(() => api.listarProjetos(true), 'INVALID_ARGUMENT');
  verdadeiro(e.message.indexOf('runAggregationQuery') !== -1, 'erro foi: ' + e.message);
});

teste('com a fila ligada, as 2P contagens vão no MESMO lote', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '2', ordem: '1' });
  criarProjeto(api, 'p_2', { vagas: '1', ordem: '2' });
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  comLock(api, falso);

  // Números DIFERENTES em cada projeto, e filas de tamanhos diferentes: com
  // 1 e 1 dos dois lados, subtrair a fila do projeto errado dá o mesmo
  // resultado, e o teste passaria com o índice trocado.
  inscrever(api, 'p_1', 2);
  inscrever(api, 'p_2', 1);
  api.reservarVaga('p_1', gravadorComEspera(api, 'p_1', 'e1'));
  api.reservarVaga('p_2', gravadorComEspera(api, 'p_2', 'e2'));
  api.reservarVaga('p_2', gravadorComEspera(api, 'p_2', 'e3'));

  api.limparCacheConfig();
  falso.requisicoes.length = 0;
  falso.idas.length = 0;

  const lista = api.listarProjetos(true);

  igual(idasDe(falso), [1, 1, 4],
    'ligar a fila custa leitura a mais, como sempre custou — mas não espera a mais');
  igual(quantasAgregacoes(falso), 4, 'duas contagens e duas subtrações da fila');
  igual(lista.map((p) => p.inscritos), [2, 1],
    'a fila de cada projeto tem de sair da contagem DELE');
  lista.forEach((p) => igual(p.inscritos, api.contarInscritos_(p.id), p.id));
});

// A régua da peça inteira: o caminho que decide a vaga não foi tocado. Ele conta
// UM projeto, com `contar()`, uma requisição por ida — se um dia mandar lote,
// alguém terá trocado o invariante das vagas por tempo de tela.
teste('reservarVaga não manda lote: dentro do lock é uma requisição por ida', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'proj_1', { vagas: '60' });
  const eventos = comLock(api, falso);
  falso.idas.length = 0;

  api.reservarVaga('proj_1', gravador(api, 'proj_1', 'insc_1'));

  igual(idasDe(falso).filter((tamanho) => tamanho !== 1), [],
    'alguma ida levou lote no caminho da inscrição');
  igual(marco(eventos, 'soltou') - marco(eventos, 'pegou'), 2,
    'e a região protegida continua custando contar e gravar');
});

// ============================================================================
// A CHAVE DE DIAGNÓSTICO — `contar_ocupacao_na_lista`
//
// Ela desliga a contagem da LISTA para medir quanto do tempo de carregamento é
// a agregação. A régua deste bloco tem duas metades, e a segunda é a que importa:
//
//   1. com a chave em SIM, nada muda — o resto do arquivo é a prova disso;
//   2. com a chave em NAO, a ausência da ocupação é uma AUSÊNCIA (null), nunca um
//      zero, e a DECISÃO sobre a vaga continua inteira: `reservarVaga` conta
//      dentro do lock e recusa o projeto cheio do mesmo jeito.
//
// O teste que decide a peça é "com a chave em NAO, o projeto cheio continua
// recusando". Se um dia ele falhar, a chave virou um jeito de vender vaga que
// não existe.
// ============================================================================

grupo('Chave de diagnóstico: com a chave em SIM, tudo como hoje');

teste('o padrão de CONFIG_PADRAO é SIM — ninguém desliga a ocupação por engano', () => {
  const { api } = ambiente();
  const padrao = api.CONFIG_PADRAO.filter((c) => c.chave === 'contar_ocupacao_na_lista')[0];

  verdadeiro(padrao !== undefined, 'a chave sumiu de CONFIG_PADRAO');
  igual(padrao.valor, 'SIM');
  igual(api.contarOcupacaoNaLista_(), true, 'e sem a chave no banco a lista continua contando');
});

// Chave escrita torta pelo painel não pode desligar a ocupação do site.
teste('só um NAO explícito desliga; qualquer outro valor conta', () => {
  const { api } = ambiente();

  api.gravarConfig('contar_ocupacao_na_lista', 'talvez');
  api.limparCacheConfig();
  igual(api.contarOcupacaoNaLista_(), true);

  api.gravarConfig('contar_ocupacao_na_lista', 'nao');
  api.limparCacheConfig();
  igual(api.contarOcupacaoNaLista_(), false, 'e minúsculo desliga, como todas as outras chaves');
});

teste('com a chave em SIM, a lista é idêntica à de hoje', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '60', ordem: '1' });
  criarProjeto(api, 'p_2', { vagas: '2', ordem: '2' });
  inscrever(api, 'p_1', 7);
  inscrever(api, 'p_2', 2);
  api.gravarConfig('contar_ocupacao_na_lista', 'SIM');
  api.limparCacheConfig();
  falso.requisicoes.length = 0;

  const lista = api.listarProjetos(true);

  igual(lista.map((p) => p.inscritos), [7, 2]);
  igual(lista.map((p) => p.restantes), [53, 0]);
  igual(lista.map((p) => p.situacao), ['ABERTO', 'ESGOTADO']);
  igual(lista.map((p) => p.ocupacao_contada), [true, true]);
  igual(quantasAgregacoes(falso), 2, 'as mesmas agregações de sempre');
});

grupo('Chave de diagnóstico: com a chave em NAO, NENHUMA agregação');

teste('seis projetos, zero agregações e duas idas ao banco — eram três', () => {
  const { api, falso } = ambiente();
  for (let i = 1; i <= 6; i++) criarProjeto(api, 'p' + i, { ordem: String(i) });
  inscrever(api, 'p1', 5);
  inscrever(api, 'p3', 60);
  api.gravarConfig('contar_ocupacao_na_lista', 'NAO');

  // Cache de configuração frio, como em produção: cada requisição HTTP do web
  // app é uma execução nova, com o escopo global zerado.
  api.limparCacheConfig();
  falso.requisicoes.length = 0;
  falso.idas.length = 0;

  const lista = api.listarProjetos(true);

  igual(quantasAgregacoes(falso), 0, 'a chave não desligou a contagem — é isto que ela existe para fazer');
  igual(idasDe(falso), [1, 1], 'a consulta da coleção e a configuração, e mais nada');
  igual(falso.requisicoes.length, 2, 'duas requisições, e o número não cresce com o de projetos');
  igual(lista.length, 6, 'a lista tem de continuar chegando inteira');
});

// O coração da peça. Zero é um número; devolvê-lo faria o site anunciar
// "0 / 60" em projeto que pode estar cheio — o cartão mais convidativo da tela.
teste('a resposta NÃO traz inscritos 0: traz null, e diz que não contou', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_cheio', { vagas: '2', ordem: '1' });
  criarProjeto(api, 'p_vazio', { vagas: '60', ordem: '2' });
  criarProjeto(api, 'p_ilimitado', { vagas: '0', ordem: '3' });
  inscrever(api, 'p_cheio', 2);
  api.gravarConfig('contar_ocupacao_na_lista', 'NAO');

  const lista = api.listarProjetos(true);

  igual(lista.map((p) => p.inscritos), [null, null, null]);
  igual(lista.filter((p) => p.inscritos === 0).length, 0, 'zero no lugar do que não se contou');
  igual(lista.map((p) => p.restantes), [null, null, null], 'restantes viraria 2 e 60 — vaga inventada');
  igual(lista.map((p) => p.ocupacao_contada), [false, false, false]);
  igual(lista.map((p) => p.vagas), [2, 60, 0], 'o TOTAL de vagas continua viajando: é ele que a tela mostra');
});

// A consequência aceita, escrita como teste para ninguém descobri-la em produção.
teste('sem contagem não existe ESGOTADO — e o aluno só descobre no envio', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_cheio', { vagas: '2' });
  inscrever(api, 'p_cheio', 2);
  api.gravarConfig('contar_ocupacao_na_lista', 'NAO');

  igual(api.listarProjetos(true)[0].situacao, 'ABERTO',
    'dizer ESGOTADO sem contar seria inventar; dizer ABERTO é o que sobra');

  api.gravarConfig('contar_ocupacao_na_lista', 'SIM');
  api.limparCacheConfig();
  igual(api.listarProjetos(true)[0].situacao, 'ESGOTADO', 'e a chave em SIM devolve o número na hora');
});

teste('INATIVO e FECHADO não dependem da contagem, e continuam aparecendo', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_off', { ativo: 'NAO' });
  criarProjeto(api, 'p_fechado', { inscricoes_abertas: 'NAO' });
  api.gravarConfig('contar_ocupacao_na_lista', 'NAO');

  const porId = {};
  api.listarProjetos(false).forEach((p) => { porId[p.id] = p; });

  igual(porId.p_off.situacao, 'INATIVO');
  igual(porId.p_fechado.situacao, 'FECHADO');
});

// A chave é da tela. Quem conta vaga não a consulta — nem por engano, nem por
// dentro de `contarInscritos_`.
teste('contarInscritos_ ignora a chave: quem decide vaga continua contando', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '60' });
  inscrever(api, 'p_1', 3);
  api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
  api.config('cadastro_aberto');            // o cache de config, quente como em produção
  falso.requisicoes.length = 0;

  igual(api.contarInscritos_('p_1'), 3);
  igual(quantasAgregacoes(falso), 1, 'a contagem que decide vaga foi desligada junto');
});

grupo('Chave de diagnóstico: a DECISÃO sobre a vaga não muda');

// O teste mais importante do bloco. Com a chave desligada o site mostra o
// projeto como aberto; quem chega nele cheio TEM de ser recusado assim mesmo.
teste('com a chave em NAO, o projeto cheio continua recusando com ESGOTADO', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '2' });
  inscrever(api, 'p_1', 2);
  api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
  const eventos = comLock(api, falso);

  const r = api.reservarVaga('p_1', () => { throw new Error('não podia ter gravado'); });

  igual(r.ok, false);
  igual(r.situacao, 'ESGOTADO');
  igual(r.erro, 'Inscrições esgotadas. Escolha outro projeto de extensão disponível.');
  igual(eventos.filter((e) => e.tipo === 'soltou').length, 1, 'e o lock foi devolvido');
  igual(api.contarInscritos_('p_1'), 2, 'a recusa não pode ter gravado nada');
});

teste('com a chave em NAO, a última vaga ainda é vendida uma vez só', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '3' });
  inscrever(api, 'p_1', 2);
  api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
  comLock(api, falso);

  igual(api.reservarVaga('p_1', gravador(api, 'p_1', 'insc_1')).ok, true, 'a última vaga foi negada');
  igual(api.reservarVaga('p_1', gravador(api, 'p_1', 'insc_2')).ok, false, 'a vaga 4 de 3 foi vendida');
  igual(api.contarInscritos_('p_1'), 3);
});

teste('com a chave em NAO, a região protegida continua custando duas chamadas', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '60' });
  api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
  const eventos = comLock(api, falso);

  api.reservarVaga('p_1', gravador(api, 'p_1', 'insc_1'));

  igual(marco(eventos, 'soltou') - marco(eventos, 'pegou'), 2,
    'contar e gravar — a chave da tela não pode entrar na fila do lock');
});

teste('com a chave em NAO, 70 tentativas em 60 vagas fecham em exatamente 60', () => {
  const { api, falso } = ambiente();
  api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
  const r = disputar(api, falso, 70, 60);

  igual(api.contarInscritos_('proj_1'), 60, 'o projeto fechou com um número que não é 60');
  igual(r.ok + r.vizinhas, 60, 'as gravações aceitas somam mais do que as vagas');
  verdadeiro(r.recusadas > 0, 'ninguém foi recusado num projeto que lotou');
});

// As duas chaves são independentes, e a de diagnóstico não pode emprestar nada
// para a fila: quem entra em espera continua não ocupando vaga.
teste('com as duas chaves ligadas, a fila continua funcionando como funciona', () => {
  const { api, falso } = ambiente();
  api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  const r = disputar(api, falso, 70, 60);

  igual(api.contarInscritos_('proj_1'), 60, 'a fila entrou na conta de vagas');
  igual(r.recusadas, 0, 'com a fila ligada ninguém é recusado por esgotado');
  verdadeiro(r.espera > 0, 'ninguém entrou na fila num projeto que lotou');
  igual(api.contarEmEspera_('proj_1'), r.espera);
});

grupo('CRUD do painel');

teste('sem token válido, salvar e remover são recusados', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');

  const r = api.salvarProjeto({ token: 'inventado', projeto: { nome: 'Novo', vagas: 60 } });
  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('Sessão') === 0, 'erro foi: ' + r.erro);

  igual(api.removerProjeto({ token: '', id: 'p_1' }).ok, false);
  igual(falso.documentos.size, 1, 'nada foi criado nem apagado');
});

teste('criar grava com o id do projeto como id do documento, e sem campo id', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);

  const r = api.salvarProjeto({
    token: token,
    projeto: {
      nome: 'R+ Cidades', professor: 'Marina Exemplo', email_professor: 'Marina@Exemplo.com ',
      vagas: 60, ativo: true, inscricoes_abertas: true, ordem: 1
    }
  });

  igual(r.ok, true, 'erro foi: ' + r.erro);
  verdadeiro(r.id.indexOf('proj_') === 0, 'id foi ' + r.id);

  const gravado = falso.documentos.get('projetos/' + r.id);
  verdadeiro(gravado !== undefined, 'o documento tem de morar em projetos/<id do projeto>');
  igual(gravado.id, undefined, 'id repetido como campo é cópia livre para divergir do documento');
  igual(gravado.codigo.stringValue, 'r-cidades');
  igual(gravado.email_professor.stringValue, 'marina@exemplo.com');
  igual(gravado.criado_por.stringValue, 'anonimo');
  verdadeiro(gravado.criado_em.stringValue.length === 19, 'criado_em foi ' + gravado.criado_em.stringValue);
  igual(acoesDoLog(falso), ['PROJETO_CRIADO']);
});

teste('editar preserva criado_em e criado_por, que não vão no payload', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  criarProjeto(api, 'p_1', { nome: 'Nome Velho', criado_por: 'coordenacao@exemplo.com' });

  const r = api.salvarProjeto({
    token: token,
    projeto: { id: 'p_1', nome: 'Nome Novo', vagas: 30, ativo: true, inscricoes_abertas: false }
  });

  igual(r, { ok: true, id: 'p_1' });
  const gravado = falso.documentos.get('projetos/p_1');
  igual(gravado.nome.stringValue, 'Nome Novo');
  igual(gravado.vagas.stringValue, '30');
  igual(gravado.inscricoes_abertas.stringValue, 'NAO');
  igual(gravado.criado_por.stringValue, 'coordenacao@exemplo.com', 'a updateMask tinha de ter preservado');
  igual(gravado.criado_em.stringValue, '2026-08-05 10:00:00');
});

// PATCH no Firestore CRIA o documento que não existe. Sem a conferência de
// existência, um painel aberto desde antes da exclusão ressuscitaria o projeto
// pela metade — sem criado_em, sem criado_por, e sem ninguém saber de onde veio.
teste('editar projeto excluído é recusado, e não recria o documento', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);

  const r = api.salvarProjeto({
    token: token,
    projeto: { id: 'proj_que_sumiu', nome: 'Zumbi', vagas: 60, ativo: true }
  });

  igual(r, { ok: false, erro: 'Projeto não encontrado. Recarregue a lista.' });
  igual(falso.documentos.get('projetos/proj_que_sumiu'), undefined);
});

/**
 * `descricao_formulario` — a orientação que o aluno lê DENTRO do formulário.
 *
 * É campo do projeto como outro qualquer, e o que estes testes guardam é o
 * caminho de ida e volta inteiro: o painel grava, a leitura devolve. A volta
 * importa mais do que parece — o painel manda o projeto INTEIRO de volta ao
 * inativar (ver `alternarProjetoUI`), então um campo que não voltasse em
 * `listarProjetos` seria apagado no primeiro clique em Inativar, sem erro nenhum.
 */
teste('a orientação do formulário é gravada, e o texto chega inteiro', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  const texto = 'Preencha os dados para participar do projeto ARTE DIGITAL FLORIPA.\n\n' +
    'O primeiro encontro acontece em 21/08/2026, às 19:00h, na sala 225.';

  const r = api.salvarProjeto({
    token: token,
    projeto: { nome: 'Arte Digital Floripa', vagas: 60, ativo: true, descricao_formulario: '  ' + texto + '  ' }
  });

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(falso.documentos.get('projetos/' + r.id).descricao_formulario.stringValue, texto,
    'as pontas foram aparadas, mas as quebras do meio são do professor');
});

teste('e ela volta na leitura — sem isso, Inativar apagaria o texto', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  criarProjeto(api, 'p_1', { descricao_formulario: 'Leia antes de preencher.' });

  const lido = api.listarProjetos(false)[0];
  igual(lido.descricao_formulario, 'Leia antes de preencher.');

  // O caminho do Inativar: o painel devolve o que leu, com `ativo` invertido.
  api.salvarProjeto({ token: token, projeto: Object.assign({}, lido, { ativo: false }) });
  igual(api.listarProjetos(false)[0].descricao_formulario, 'Leia antes de preencher.',
    'inativar o projeto comeu a orientação do formulário');
});

teste('projeto sem orientação nenhuma devolve string vazia, e não indefinido', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_1');

  igual(api.listarProjetos(false)[0].descricao_formulario, '');
});

teste('validação recusa nome vazio, nome longo demais, vagas negativa e e-mail torto', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);

  igual(api.salvarProjeto({ token: token, projeto: { nome: '  ', vagas: 60 } }).erro,
    'Informe o nome do projeto.');
  verdadeiro(api.salvarProjeto({ token: token, projeto: { nome: 'x'.repeat(121), vagas: 60 } })
    .erro.indexOf('máximo 120') !== -1);
  verdadeiro(api.salvarProjeto({ token: token, projeto: { nome: 'Ok', vagas: -1 } })
    .erro.indexOf('0 (ilimitado)') !== -1);
  verdadeiro(api.salvarProjeto({ token: token, projeto: { nome: 'Ok', vagas: 60, email_professor: 'arroba-nenhum' } })
    .erro.indexOf('E-mail do professor') !== -1);

  // A orientação viaja em TODA resposta de `?api=projetos`, que é a rota que o
  // evento inteiro pede. Um edital colado ali entraria na carga pública sem
  // ninguém perceber; recusar com a frase na tela é melhor que gravar calado.
  verdadeiro(api.salvarProjeto({
    token: token, projeto: { nome: 'Ok', vagas: 60, descricao_formulario: 'x'.repeat(2001) }
  }).erro.indexOf('máximo 2000') !== -1);
  igual(api.salvarProjeto({
    token: token, projeto: { nome: 'Ok', vagas: 60, descricao_formulario: 'x'.repeat(2000) }
  }).ok, true, 'o teto recusou um texto do tamanho exato do limite');
});

teste('remover projeto sem inscritos exclui de verdade', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  criarProjeto(api, 'p_1');

  const r = api.removerProjeto({ token: token, id: 'p_1' });

  igual(r, { ok: true, desativado: false, mensagem: 'Projeto excluído.' });
  igual(falso.documentos.get('projetos/p_1'), undefined);
  igual(acoesDoLog(falso), ['PROJETO_EXCLUIDO']);
});

teste('remover projeto com inscritos desativa e preserva o documento', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  criarProjeto(api, 'p_1');
  inscrever(api, 'p_1', 7);

  const r = api.removerProjeto({ token: token, id: 'p_1' });

  igual(r.ok, true);
  igual(r.desativado, true);
  verdadeiro(r.mensagem.indexOf('7 inscrito(s)') !== -1, 'mensagem foi: ' + r.mensagem);

  const gravado = falso.documentos.get('projetos/p_1');
  igual(gravado.ativo.stringValue, 'NAO');
  igual(gravado.inscricoes_abertas.stringValue, 'NAO');
  igual(gravado.nome.stringValue, 'Projeto p_1', 'desativar não pode mexer no resto');
  igual(acoesDoLog(falso), ['PROJETO_DESATIVADO']);
});

teste('remover projeto que não existe é recusado', () => {
  const { api } = ambiente();
  igual(api.removerProjeto({ token: tokenAdmin(api), id: 'p_9' }),
    { ok: false, erro: 'Projeto não encontrado.' });
});

grupo('Código do projeto (a URL do site)');

// Regressão: o sistema sobre Sheets comparava o candidato COM hífen contra os
// códigos gravados passados por normalizarTexto, que troca hífen por espaço.
// 'r-cidades' nunca casava com 'r cidades', a checagem não reprovava ninguém e
// dois projetos de mesmo nome saíam com o mesmo código.
teste('dois projetos de mesmo nome não recebem o mesmo código', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);

  const primeiro = api.salvarProjeto({ token: token, projeto: { nome: 'R+ Cidades', vagas: 60 } });
  const segundo = api.salvarProjeto({ token: token, projeto: { nome: 'R+ CIDADES', vagas: 60 } });

  igual(api.projetoPorId(primeiro.id).codigo, 'r-cidades');
  igual(api.projetoPorId(segundo.id).codigo, 'r-cidades-2');
});

teste('editar um projeto não faz ele disputar código consigo mesmo', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  criarProjeto(api, 'p_1', { nome: 'R+ Cidades', codigo: 'r-cidades' });

  api.salvarProjeto({ token: token, projeto: { id: 'p_1', nome: 'R+ Cidades', vagas: 60 } });

  igual(api.projetoPorId('p_1').codigo, 'r-cidades');
});

teste('acento, pontuação e tamanho viram um código de URL', () => {
  const { api } = ambiente();
  igual(api.gerarCodigo_('Conectando Gerações — Edição 2026'), 'conectando-geracoes-edicao-2026');
  igual(api.gerarCodigo_('  '), 'projeto', 'nome sem letra nenhuma ainda precisa de link');
  igual(api.gerarCodigo_('a'.repeat(80)).length, 40, 'teto de 40 caracteres');
});

// ---------------------------------------------------------------- Resultado

process.exit(resultado());
