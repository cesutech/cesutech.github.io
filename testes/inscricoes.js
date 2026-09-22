/**
 * inscricoes.js — testa a entrada de inscrições (04_Inscricoes.gs) sem tocar no
 * Google.
 *
 * O que se prova aqui, em ordem de importância:
 *   1. a deduplicação é do BANCO, não nossa: a chave é o id do documento, a
 *      segunda gravação custa UMA requisição e não depende de lock nenhum — é o
 *      que fecha os três chamadores que rodam fora do LockService;
 *   2. a lista oficial virou leitura por id, e é consultada UMA vez por
 *      inscrição, contra duas varreduras de coluna no sistema em produção;
 *   3. as guardas do endpoint público (honeypot, tempo mínimo, sinal de origem,
 *      teto por hora) continuam recusando o que recusavam;
 *   4. a região protegida de `reservarVaga` continua custando duas requisições
 *      quando quem grava é o `gravarInscricao` de verdade, e não um dublê.
 *
 * O `LockService` falso daqui é o mínimo para (4): ele carimba quantas
 * requisições já tinham ido ao Firestore quando o lock foi obtido e devolvido. O
 * de `testes/projetos.js` é mais completo, mas aquele arquivo é um script que
 * roda e chama process.exit — não dá para importá-lo —, e `apoio.js` é
 * compartilhado com as outras fases e não é meu para mexer.
 *
 * Uso:  node testes/inscricoes.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  teste, grupo, igual, verdadeiro, resultado, criarAmbiente, criarRelogio
} = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');

// Na ordem alfabética em que o editor do Apps Script carrega os arquivos —
// 04_Inscricoes.gs vem ANTES de 04_Log.gs e de 09_Projetos.gs, e é essa ordem
// que decide qual declaração de INSCRICOES_COLECAO sobrevive.
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '03_Config.gs',
  '04_Inscricoes.gs', '04_Log.gs', '07_Auth.gs', '09_Projetos.gs'];

function ambiente(opcoes) {
  return criarAmbiente(Object.assign({ arquivos: GS, usuario: '' }, opcoes || {}));
}

/** Lock falso: carimba a fila de requisições na entrada e na saída. */
function comLock(api, falso, opcoes) {
  opcoes = opcoes || {};
  const eventos = [];

  api.LockService = {
    getScriptLock: () => ({
      waitLock() {
        if (opcoes.aoEsperar) opcoes.aoEsperar();
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

function zerar(falso) {
  falso.requisicoes.length = 0;
}

function quantas(falso, casa) {
  return falso.requisicoes.filter(casa).length;
}

const LEITURA_MATRICULA = (r) => r.metodo === 'GET' && r.url.indexOf('/matriculados/') !== -1;
const AGREGACAO = (r) => r.url.indexOf(':runAggregationQuery') !== -1;
const CONSULTA = (r) => r.url.indexOf(':runQuery') !== -1;
const ESCRITA_INSCRICAO = (r) => r.metodo === 'POST' && r.url.indexOf('/inscricoes?') !== -1;

/**
 * As ações da trilha, na ordem em que foram gravadas.
 *
 * Ordem de inserção no Map do falso, e NÃO ordem do id: o id do log carrega o
 * milissegundo mais um sufixo sorteado (`logId_` em 04_Log.gs), e duas ações do
 * mesmo teste caem no mesmo milissegundo. O mesmo cuidado de testes/projetos.js.
 */
function acoesDoLog(falso) {
  const acoes = [];
  falso.documentos.forEach((campos, chave) => {
    if (chave.indexOf('log/') === 0) acoes.push(campos.acao.stringValue);
  });
  return acoes;
}

function criarProjeto(api, id, campos) {
  api.inserir('projetos', Object.assign({
    codigo: id,
    nome: 'Projeto ' + id,
    professor: 'Marina Exemplo',
    vagas: '60',
    ativo: 'SIM',
    inscricoes_abertas: 'SIM',
    validar_matricula: 'SIM',
    ordem: '1',
    criado_em: '2026-08-05 10:00:00'
  }, campos || {}), id);
}

/** Semeia a lista oficial como a importação vai semear: id = matrícula. */
function matricular(api, matriculas) {
  matriculas.forEach((m) => {
    api.inserir('matriculados', { matricula: m, nome: 'Aluno ' + m, curso: 'ADS' }, m);
  });
}

function inscricoesGravadas(falso) {
  const ids = [];
  falso.documentos.forEach((_campos, chave) => {
    if (chave.indexOf('inscricoes/') === 0) ids.push(chave.split('/')[1]);
  });
  return ids;
}

/** O que o site manda: tudo que Cadastro.html e docs/assets/app.js preenchem. */
const BASE = {
  matricula: '9110001',
  nome: 'Maria da Silva',
  email: 'maria@exemplo.com',
  whatsapp: '48999998888',
  curso_fase: 'WORK EXPERIENCE - ADM21',
  declara_ciencia: true,
  autoriza_imagem: true,
  consentimento_lgpd: true
};

function envio(extra) {
  return Object.assign({}, BASE, extra || {});
}

// ============================================================================

console.log('\n\x1b[1mUNICESUSC CESUTECH — inscrições (04_Inscricoes.gs)\x1b[0m');

grupo('normalizarMatricula');

teste('pontuação, espaço e caixa somem; vazio continua vazio', () => {
  const { api } = ambiente();
  igual(api.normalizarMatricula(' 911-0001 '), '9110001');
  igual(api.normalizarMatricula('ads/911.0001'), 'ADS9110001');
  igual(api.normalizarMatricula(''), '');
  igual(api.normalizarMatricula(null), '');
  igual(api.normalizarMatricula(undefined), '');
});

grupo('A lista oficial virou leitura por id');

teste('matrícula na lista: uma leitura por id, e nenhuma varredura', () => {
  const { api, falso } = ambiente();
  matricular(api, ['9110001', '9110002', '9110003']);
  zerar(falso);

  igual(api.matriculaConhecida('911-0001'), true, 'a pontuação do aluno não pode importar');
  igual(falso.requisicoes.length, 1, 'uma requisição, e uma só');
  igual(quantas(falso, LEITURA_MATRICULA), 1);
  igual(quantas(falso, CONSULTA), 0, 'varrer a lista oficial é o que esta fase veio matar');
});

teste('matrícula fora da lista: false, e ainda é uma leitura só', () => {
  const { api, falso } = ambiente();
  matricular(api, ['9110001']);
  zerar(falso);

  igual(api.matriculaConhecida('9999999'), false);
  igual(falso.requisicoes.length, 1, 'o 404 do banco é a resposta, não um erro');
});

teste('matrícula vazia não chega a ir ao banco', () => {
  const { api, falso } = ambiente();
  matricular(api, ['9110001']);
  zerar(falso);

  igual(api.matriculaConhecida(''), false);
  igual(api.matriculaConhecida('///'), false, 'sem alfanumérico não sobra matrícula');
  igual(falso.requisicoes.length, 0);
});

teste('temListaOficial_ é agregação: responde sem trazer documento', () => {
  const { api, falso } = ambiente();

  igual(api.temListaOficial_(), false, 'banco vazio é semestre sem arquivo da secretaria');
  igual(quantas(falso, AGREGACAO), 1);

  matricular(api, ['9110001']);
  zerar(falso);

  igual(api.temListaOficial_(), true);
  igual(quantas(falso, CONSULTA), 0);
});

grupo('A matrícula cancelada na lista oficial — a porta pública não distingue');

/** A marca que a revisão de uma importação grava (05c_Revisao.gs), como ela grava: PATCH de 4 campos. */
function cancelar(api, matricula) {
  api.atualizarEmLote('matriculados', [{
    _id: matricula, situacao_cadastro: 'CANCELADO', cancelado_em: '2026-09-21 19:00:00',
    cancelado_por: 'prof@exemplo.com', cancelado_lote_id: '20260921T220000000Z_abc'
  }]);
}

teste('matriculaConhecida é false para o cancelado, e ainda custa UMA leitura', () => {
  // Mutação que derruba: `ler(...) !== null` sem olhar a marca — o cancelado
  // continuaria passando no formulário como se estivesse na lista.
  const { api, falso } = ambiente();
  matricular(api, ['9110001', '9110002']);
  cancelar(api, '9110001');
  zerar(falso);

  igual(api.matriculaConhecida('9110001'), false);
  igual(api.matriculaConhecida('9110002'), true, 'a marca de um não pode contaminar o outro');
  igual(quantas(falso, LEITURA_MATRICULA), 2, 'uma leitura de ponto por pergunta, como antes');
  igual(quantas(falso, CONSULTA), 0);
});

teste('cadastroCancelado_ tolera documento sem a chave, vazio e minúsculas', () => {
  const { api } = ambiente();
  igual(api.cadastroCancelado_({ nome: 'X' }), false, 'documento anterior à marca é ativo');
  igual(api.cadastroCancelado_({ situacao_cadastro: '' }), false);
  igual(api.cadastroCancelado_(null), false);
  igual(api.cadastroCancelado_({ situacao_cadastro: 'cancelado' }), true);
  igual(api.cadastroCancelado_({ situacao: 'CANCELADO' }), false,
    '`situacao` é a coluna da secretaria, e não a marca da revisão');
});

teste('BLOQUEAR responde ao cancelado a MESMA frase de "não encontrada"', () => {
  // Mutação que derruba: uma frase própria ("está cancelada") — seria um segundo
  // bit sobre uma pessoa entregue a quem consulta anonimamente.
  const { api } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  cancelar(api, '9110001');

  igual(api.checarMatriculaNaLista_('9110001', 'p_1'), api.checarMatriculaNaLista_('9999999', 'p_1'));
  verdadeiro(api.checarMatriculaNaLista_('9110001', 'p_1').indexOf('não encontrada') !== -1);
});

teste('AVISAR deixa o cancelado passar, e a inscrição entra como não conferida', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  cancelar(api, '9110001');
  api.gravarConfig('modo_validacao_matricula', 'AVISAR');
  comLock(api, falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));
  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(falso.documentos.get('inscricoes/' + r.protocolo).matricula_conferida.stringValue, 'NAO',
    'cancelado na lista de hoje não é matrícula conferida');
});

teste('a reimportação apaga a marca: o documento volta inteiro, sem os 4 campos', () => {
  // É a reativação do desenho — sem função nenhuma. Mutação que derruba:
  // `escreverEmLote` gravando com `updateMask` (viraria mescla e a marca
  // sobreviveria à lista nova).
  const { api } = ambiente();
  matricular(api, ['9110001']);
  cancelar(api, '9110001');
  igual(api.matriculaConhecida('9110001'), false);

  api.escreverEmLote('matriculados', [{ _id: '9110001', matricula: '9110001', nome: 'Aluno 9110001', lote_id: 'L2' }]);
  const doc = api.ler('matriculados', '9110001');
  igual(doc.situacao_cadastro, undefined);
  igual(doc.cancelado_em, undefined);
  igual(doc.cancelado_por, undefined);
  igual(doc.cancelado_lote_id, undefined);
  igual(api.matriculaConhecida('9110001'), true);
});

grupo('checarMatriculaNaLista_ — o switch de validação por projeto');

teste('projeto com validar_matricula=NAO passa sem consultar a lista', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_aberto', { validar_matricula: 'NAO' });
  matricular(api, ['9110001']);
  zerar(falso);

  igual(api.checarMatriculaNaLista_('9999999', 'p_aberto'), '');
  igual(quantas(falso, LEITURA_MATRICULA), 0, 'projeto aberto à comunidade não tem lista para conferir');
  igual(quantas(falso, AGREGACAO), 0);
});

// Sem esta guarda, o primeiro aluno de um semestre novo levaria "matrícula
// incorreta" só porque a secretaria ainda não mandou o arquivo.
teste('sem lista importada nunca bloqueia', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_1');

  igual(api.checarMatriculaNaLista_('9999999', 'p_1'), '');
});

teste('com lista e matrícula desconhecida, BLOQUEAR devolve a mensagem de sempre', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);

  igual(api.checarMatriculaNaLista_('9999999', 'p_1'),
    'Matrícula não encontrada na lista de alunos matriculados. ' +
    'Confira o número digitado. Se estiver certo, procure a coordenação do CESUTECH.');
});

teste('modo AVISAR deixa passar a matrícula que não está na lista', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  api.gravarConfig('modo_validacao_matricula', 'AVISAR');

  igual(api.checarMatriculaNaLista_('9999999', 'p_1'), '');
});

// A reordenação em relação ao sistema sobre Sheets: matrícula ENCONTRADA libera
// sem precisar perguntar se existe lista — ela existe, a matrícula está nela.
teste('matrícula conhecida passa sem gastar a agregação de temListaOficial_', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  zerar(falso);

  igual(api.checarMatriculaNaLista_('9110001', 'p_1'), '');
  igual(quantas(falso, LEITURA_MATRICULA), 1);
  igual(quantas(falso, AGREGACAO), 0, 'o caminho do aluno certo não paga a pergunta que não muda nada');
});

teste('sem projeto, e com projeto que não existe, assume que valida', () => {
  const { api } = ambiente();
  matricular(api, ['9110001']);

  verdadeiro(api.checarMatriculaNaLista_('9999999', '') !== '', 'sem projeto o caso comum é validar');
  verdadeiro(api.checarMatriculaNaLista_('9999999', 'p_fantasma') !== '');
});

teste('o veredito pode vir pronto de fora, e aí a lista não é lida de novo', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  zerar(falso);

  igual(api.checarMatriculaNaLista_('9110001', 'p_1', true), '');
  igual(quantas(falso, LEITURA_MATRICULA), 0, 'quem já perguntou não pergunta duas vezes');
});

grupo('Deduplicação pelo id do documento');

teste('o id do documento é a chave de dedup, e não existe campo id nem hash_dedup', () => {
  const { api, falso } = ambiente();

  const r = api.gravarInscricao(envio({ projeto_id: 'p_1', origem: 'SITE' }));

  igual(r.duplicada, false);
  igual(r.id, api.chaveDedup_(envio({ projeto_id: 'p_1' })));
  igual(inscricoesGravadas(falso), [r.id]);

  const gravado = falso.documentos.get('inscricoes/' + r.id);
  igual(gravado.id, undefined, 'campo id seria cópia livre para divergir do nome do documento');
  igual(gravado.hash_dedup, undefined, 'e hash_dedup seria a segunda cópia da mesma coisa');
  igual(gravado.matricula.stringValue, '9110001');
  igual(gravado.nome.stringValue, 'Maria da Silva');
  igual(gravado.origem.stringValue, 'SITE');
  verdadeiro(gravado.raw_json.stringValue.indexOf('9110001') !== -1, 'o payload original fica guardado');
});

// O 409 ALREADY_EXISTS foi medido contra o Firestore de verdade em 05/08/2026.
// É ele que substitui a varredura da coluna hash_dedup.
teste('a segunda gravação é recusada pelo banco: uma requisição, sem leitura prévia', () => {
  const { api, falso } = ambiente();
  const dados = envio({ projeto_id: 'p_1' });

  const primeira = api.gravarInscricao(dados);
  zerar(falso);
  const segunda = api.gravarInscricao(dados);

  igual(segunda, { id: primeira.id, duplicada: true });
  igual(falso.requisicoes.length, 1, 'só o POST que o banco recusou');
  igual(quantas(falso, CONSULTA), 0, 'nenhuma leitura para descobrir a duplicata');
  igual(inscricoesGravadas(falso).length, 1);
});

teste('o custo da dedup não cresce com o tamanho da coleção', () => {
  const { api, falso } = ambiente();
  const dados = envio({ projeto_id: 'p_1' });
  api.gravarInscricao(dados);
  for (let i = 0; i < 200; i++) {
    api.inserir('inscricoes', { projeto_id: 'p_1', matricula: 'X' + i }, 'outra_' + i);
  }
  zerar(falso);

  igual(api.gravarInscricao(dados).duplicada, true);
  igual(falso.requisicoes.length, 1, 'com 201 documentos no banco, ainda uma requisição');
});

teste('a mesma pessoa em projetos diferentes são duas inscrições', () => {
  const { api, falso } = ambiente();

  igual(api.gravarInscricao(envio({ projeto_id: 'p_1' })).duplicada, false);
  igual(api.gravarInscricao(envio({ projeto_id: 'p_2' })).duplicada, false);
  igual(inscricoesGravadas(falso).length, 2, 'o que se impede é entrar duas vezes no MESMO projeto');
});

teste('a matrícula é normalizada antes de virar chave', () => {
  const { api } = ambiente();

  api.gravarInscricao(envio({ projeto_id: 'p_1', matricula: '911-0001' }));
  igual(api.gravarInscricao(envio({ projeto_id: 'p_1', matricula: '9110001' })).duplicada, true);
});

teste('sem matrícula, o CPF é a chave; sem os dois, e-mail mais nome', () => {
  const { api } = ambiente();

  const semMatricula = { projeto_id: 'p_1', nome: 'Maria da Silva', email: 'maria@exemplo.com' };

  igual(api.gravarInscricao(Object.assign({ cpf: '529.982.247-25' }, semMatricula)).duplicada, false);
  igual(api.gravarInscricao(Object.assign({ cpf: '52998224725' }, semMatricula)).duplicada, true,
    'a pontuação do CPF não faz pessoa nova');

  const soEmail = api.gravarInscricao(semMatricula);
  igual(soEmail.duplicada, false, 'sem CPF a chave muda, então esta é outra inscrição');
  igual(api.gravarInscricao(Object.assign({}, semMatricula)).duplicada, true);
});

teste('e-mail igual com nome diferente não é a mesma pessoa', () => {
  const { api } = ambiente();
  const familia = { projeto_id: 'p_1', email: 'silva@exemplo.com' };

  igual(api.gravarInscricao(Object.assign({ nome: 'Maria da Silva' }, familia)).duplicada, false);
  igual(api.gravarInscricao(Object.assign({ nome: 'João da Silva' }, familia)).duplicada, false);
});

// O terceiro chamador de gravarInscricao no sistema sobre Sheets roda dentro do
// lock; os outros três, não. Aqui nenhum precisa: este teste não instala
// LockService nenhum no sandbox, e a segunda gravação continua sendo recusada.
teste('sem lock nenhum instalado, a duplicata continua impossível', () => {
  const { api, falso } = ambiente();
  igual(api.LockService, undefined, 'o sandbox não tem LockService, e gravarInscricao não precisa');

  const dados = envio({ projeto_id: 'p_1' });
  const a = api.gravarInscricao(dados);
  const b = api.gravarInscricao(dados);

  igual([a.duplicada, b.duplicada], [false, true]);
  igual(inscricoesGravadas(falso).length, 1);
});

grupo('outrosProjetosDe_');

teste('uma consulta só, por matrícula, ignorando o projeto atual', () => {
  const { api, falso } = ambiente();
  api.inserir('inscricoes', { projeto_id: 'p_1', projeto_nome: 'R+ Cidades', matricula: '9110001', email: 'maria@exemplo.com' }, 'i1');
  api.inserir('inscricoes', { projeto_id: 'p_2', projeto_nome: 'Arte Digital', matricula: '9110001', email: 'maria@exemplo.com' }, 'i2');
  api.inserir('inscricoes', { projeto_id: 'p_3', projeto_nome: 'Empreender', matricula: '9999999', email: 'outro@exemplo.com' }, 'i3');
  zerar(falso);

  igual(api.outrosProjetosDe_(envio({ projeto_id: 'p_2' })), ['R+ Cidades']);
  igual(quantas(falso, CONSULTA), 1, 'matrícula e e-mail não são duas consultas: a regra usa uma');
});

teste('sem matrícula, cai para o e-mail', () => {
  const { api, falso } = ambiente();
  api.inserir('inscricoes', { projeto_id: 'p_1', projeto_nome: 'R+ Cidades', matricula: '', email: 'maria@exemplo.com' }, 'i1');
  zerar(falso);

  igual(api.outrosProjetosDe_({ projeto_id: 'p_2', email: 'MARIA@Exemplo.com ' }), ['R+ Cidades']);
  igual(quantas(falso, CONSULTA), 1);
});

// A regra herdada não faz OR: com matrícula na mão, o e-mail não é consultado.
// Duas pessoas que dividem um e-mail continuam sendo duas pessoas.
teste('com matrícula, e-mail igual em outro projeto não conta', () => {
  const { api } = ambiente();
  api.inserir('inscricoes', { projeto_id: 'p_1', projeto_nome: 'R+ Cidades', matricula: '7777777', email: 'maria@exemplo.com' }, 'i1');

  igual(api.outrosProjetosDe_(envio({ projeto_id: 'p_2' })), []);
});

teste('sem matrícula e sem e-mail não consulta nada', () => {
  const { api, falso } = ambiente();
  api.inserir('inscricoes', { projeto_id: 'p_1', projeto_nome: 'R+ Cidades', matricula: '', email: '' }, 'i1');
  zerar(falso);

  igual(api.outrosProjetosDe_({ projeto_id: 'p_2', nome: 'Maria' }), []);
  igual(falso.requisicoes.length, 0);
});

// Defeito consertado, e não regra de negócio: o sistema sobre Sheets empurrava a
// inscrição sem projeto para a lista, e `projeto_nome || projeto_id` devolvia
// string vazia — o aluno lia "Você já está inscrito em ."
teste('inscrição sem projeto não vira "outro projeto"', () => {
  const { api } = ambiente();
  api.inserir('inscricoes', { projeto_id: '', projeto_nome: '', matricula: '9110001' }, 'i1');

  igual(api.outrosProjetosDe_(envio({ projeto_id: 'p_2' })), []);
});

teste('sem projeto_nome gravado, o id do projeto serve de rótulo', () => {
  const { api } = ambiente();
  api.inserir('inscricoes', { projeto_id: 'p_1', projeto_nome: '', matricula: '9110001' }, 'i1');

  igual(api.outrosProjetosDe_(envio({ projeto_id: 'p_2' })), ['p_1']);
});

// Era a última consulta SEM LIMITE do caminho público — o caminho que 500 alunos
// percorrem ao mesmo tempo. Na prática ela traz de uma a seis linhas, mas "na
// prática" não é teto: bastava um e-mail digitado errado e repetido, ou dado de
// teste esquecido no banco, para ela crescer sem freio dentro de submeterInscricao.
teste('a consulta declara limite — nada no caminho do aluno lê sem teto', () => {
  const { api, falso } = ambiente();
  api.inserir('inscricoes', { projeto_id: 'p_1', projeto_nome: 'R+ Cidades', matricula: '9110001' }, 'i1');
  zerar(falso);

  api.outrosProjetosDe_(envio({ projeto_id: 'p_2' }));

  const consulta = falso.requisicoes.filter(CONSULTA)[0].corpo.structuredQuery;
  verdadeiro(consulta.limit > 0, 'consulta sem `limit` no caminho público');
  igual(consulta.limit, 20);
});

teste('o corte não muda a resposta que importa: length e o primeiro nome', () => {
  // Quem chama usa `jaEstaEm.length` e `jaEstaEm[0]` (submeterInscricao). Cortar
  // em 20 é seguro POR ISSO, e não porque 20 seja um número bonito.
  const { api } = ambiente();
  for (let i = 1; i <= 25; i++) {
    api.inserir('inscricoes', {
      projeto_id: 'p_' + String(i).padStart(3, '0'),
      projeto_nome: 'Projeto ' + String(i).padStart(3, '0'),
      matricula: '9110001'
    }, 'i' + String(i).padStart(3, '0'));
  }

  const achados = api.outrosProjetosDe_(envio({ projeto_id: 'p_999' }));

  igual(achados.length, 20, 'o teto vale');
  igual(achados[0], 'Projeto 001', 'o primeiro é o que a mensagem ao aluno cita');
  verdadeiro(achados.length > 0, 'a resposta continua sendo "sim, está em outro projeto"');
});

grupo('Guardas do endpoint público');

teste('honeypot preenchido recusa, registra BLOQUEIO e não grava', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  comLock(api, falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1', website: 'http://spam' }));

  igual(r, { ok: false, erro: 'Não foi possível registrar a inscrição.' });
  igual(acoesDoLog(falso), ['BLOQUEIO']);
  igual(inscricoesGravadas(falso).length, 0);
});

teste('preenchido em menos de 3 segundos recusa', () => {
  const { api, falso } = ambiente();

  igual(api.verificarAntiAbuso_({ tempoPreenchimento: 900 }), 'Não foi possível registrar a inscrição.');
  verdadeiro(falso.documentos.size >= 1, 'e o bloqueio deixa rastro no log');
  igual(api.verificarAntiAbuso_({ tempoPreenchimento: 3001 }), '');
});

// A ausência do campo é o que o robô manda. Tratá-la como benigna deixava
// contornar as duas defesas simplesmente não mandando nada.
teste('envio externo sem sinal de origem recusa mandando usar o formulário do site', () => {
  const { api, falso } = ambiente();

  igual(api.verificarAntiAbuso_({ origem: 'SITE_EXTERNO' }),
    'Não foi possível registrar a inscrição. Preencha pelo formulário do site.');
  igual(acoesDoLog(falso), ['BLOQUEIO']);
});

teste('o mesmo envio pelo formulário interno passa: ele não tem como informar o tempo', () => {
  const { api } = ambiente();

  igual(api.verificarAntiAbuso_({}), '');
  igual(api.verificarAntiAbuso_({ origem: 'SITE' }), '');
});

teste('teto por hora recusa no limite, e a hora seguinte volta a aceitar', () => {
  const relogio = criarRelogio(Date.UTC(2026, 7, 5, 12, 0, 0));
  const { api } = ambiente({ relogio });
  api.gravarConfig('limite_inscricoes_hora', '2');

  igual(api.verificarAntiAbuso_({}), '');
  igual(api.verificarAntiAbuso_({}), '');
  igual(api.verificarAntiAbuso_({}),
    'Estamos recebendo muitas inscrições agora. Tente novamente em alguns minutos.');

  relogio.avancar(3600000);
  igual(api.verificarAntiAbuso_({}), '', 'a janela é a hora cheia, e ela vira sozinha');
});

// Padrão que contradiz CONFIG_PADRAO só falha no dia em que a chave não existe
// no banco — implantação nova, setup pela metade, evento do auditório.
teste('os padrões de config deste arquivo são os mesmos de CONFIG_PADRAO', () => {
  const { api } = ambiente();
  const codigo = fs.readFileSync(path.join(PASTA_GS, '04_Inscricoes.gs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const padrao = {};
  api.CONFIG_PADRAO.forEach((c) => { padrao[c.chave] = String(c.valor); });

  const usadas = [];
  const regex = /config\('([a-z_]+)',\s*'([^']*)'\)/g;
  let m;
  while ((m = regex.exec(codigo)) !== null) {
    usadas.push(m[1]);
    igual(m[2], padrao[m[1]], 'o padrão de ' + m[1] + ' no código e em CONFIG_PADRAO');
  }

  igual(usadas.sort(), ['aluno_projeto_unico', 'cadastro_aberto', 'exigir_matricula',
    'inscricoes_fim', 'inscricoes_inicio', 'limite_inscricoes_hora', 'matricula_digitos',
    'modo_validacao_matricula', 'texto_espera']);
});

grupo('validarInscricao');

teste('nome sem sobrenome, e-mail torto, matrícula curta e whatsapp curto', () => {
  const { api } = ambiente();

  igual(api.validarInscricao({ nome: 'Maria', email: 'maria@exemplo.com', matricula: '9110001', consentimento_lgpd: true }),
    ['Informe o nome completo.']);
  igual(api.validarInscricao(envio({ email: 'sem-arroba' })), ['E-mail inválido.']);
  igual(api.validarInscricao(envio({ matricula: '' })), ['Informe a matrícula.']);
  igual(api.validarInscricao(envio({ matricula: '123' })),
    ['A matrícula tem 7 dígitos. Confira o número no seu portal do aluno.']);
  igual(api.validarInscricao(envio({ whatsapp: '4899' })), ['WhatsApp inválido.']);
  igual(api.validarInscricao(envio()), []);
});

// O pedido do Prof. Mário (19/09): a matrícula digitada errada entrava pela
// faixa de 4 a 20 e depois não casava com a lista oficial. A régua agora é o
// TAMANHO EXATO, medido nas listas da secretaria — e vem da configuração, porque
// o 7 é medição, não documento.
grupo('validarInscricao — o tamanho da matrícula');

const MENSAGEM_7 = 'A matrícula tem 7 dígitos. Confira o número no seu portal do aluno.';

teste('sete dígitos passa; seis e oito sem zero recusam dizendo o tamanho certo', () => {
  const { api } = ambiente();

  igual(api.validarInscricao(envio({ matricula: '9110001' })), []);
  igual(api.validarInscricao(envio({ matricula: '911000' })), [MENSAGEM_7], 'seis dígitos');
  igual(api.validarInscricao(envio({ matricula: '91100011' })), [MENSAGEM_7], 'oito dígitos sem zero à esquerda');
  igual(api.validarInscricao(envio({ matricula: '911000111' })), [MENSAGEM_7], 'nove dígitos');
  igual(api.validarInscricao(envio({ matricula: '911000A' })), [MENSAGEM_7], 'letra no lugar de dígito');
});

teste('a mensagem diz o número, e não só "inválida" — é o que ensina a corrigir', () => {
  const { api } = ambiente();
  const erro = api.validarInscricao(envio({ matricula: '911000' }))[0];

  verdadeiro(/\b7\b/.test(erro), 'a mensagem não diz quantos dígitos são: ' + erro);
  verdadeiro(/dígitos/.test(erro), erro);
});

teste('oito dígitos COM zero à esquerda passa, e grava os sete', () => {
  // A forma da secretaria: 09110001. O aluno lê 9110001 no portal. As duas são a
  // mesma matrícula, e a chave gravada é a sem zero (`normalizarMatricula`).
  const { api, falso } = ambiente();
  matricular(api, ['9110001']);
  comLock(api, falso);

  igual(api.validarInscricao(envio({ matricula: '09110001' })), []);

  const r = api.submeterInscricao(envio({ matricula: '09110001', curso_fase: '', declara_ciencia: false }));
  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(falso.documentos.get('inscricoes/' + r.protocolo).matricula.stringValue, '9110001');
});

teste('a pontuação que o aluno digita não conta no tamanho', () => {
  const { api } = ambiente();

  igual(api.validarInscricao(envio({ matricula: '911.0001' })), []);
  igual(api.validarInscricao(envio({ matricula: ' 911-0001 ' })), []);
  igual(api.validarInscricao(envio({ matricula: '0911.0001' })), [], 'zero à esquerda e pontuação, juntos');
});

teste('zero à esquerda que esconde matrícula curta é recusado', () => {
  // `0110001` são sete dígitos na tela, mas a chave é `110001` — seis. Essa
  // matrícula não existe na lista de ninguém, e aceitá-la seria deixar passar
  // pelo tamanho o que a régua existe para barrar. `0000000` é o caso extremo:
  // vira `0`.
  const { api } = ambiente();

  igual(api.validarInscricao(envio({ matricula: '0110001' })), [MENSAGEM_7]);
  igual(api.validarInscricao(envio({ matricula: '00110001' })), [MENSAGEM_7]);
  igual(api.validarInscricao(envio({ matricula: '0000000' })), [MENSAGEM_7]);
  // E o inverso: a chave certa atrás de zeros demais também é tamanho errado —
  // o formulário aceita UM zero à esquerda, que é como a secretaria escreve, e
  // não "qualquer quantidade".
  igual(api.validarInscricao(envio({ matricula: '009110001' })), [MENSAGEM_7]);
  igual(api.validarInscricao(envio({ matricula: '000009110001' })), [MENSAGEM_7]);
});

teste('o envio recusa antes de qualquer leitura, e não grava', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  comLock(api, falso);
  api.config('cadastro_aberto', 'SIM');   // a configuração já está em cache
  zerar(falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1', matricula: '911000' }));

  igual(r, { ok: false, erro: MENSAGEM_7 });
  igual(quantas(falso, LEITURA_MATRICULA), 0, 'matrícula de tamanho errado não vale uma leitura da lista');
  igual(inscricoesGravadas(falso).length, 0);
});

teste('matricula_digitos=8 na configuração muda a régua — e a mensagem', () => {
  const { api } = ambiente();
  api.gravarConfig('matricula_digitos', '8');

  igual(api.validarInscricao(envio({ matricula: '91100011' })), []);
  igual(api.validarInscricao(envio({ matricula: '091100011' })), [], 'nove com zero à esquerda');
  igual(api.validarInscricao(envio({ matricula: '9110001' })),
    ['A matrícula tem 8 dígitos. Confira o número no seu portal do aluno.']);
});

teste('chave vazia, texto ou zero: a régua continua em 7, e o motivo vai para o console', () => {
  // A faixa de 4 a 20 é o que deixava matrícula errada passar. Uma chave torta
  // não pode reabri-la em silêncio: cai no padrão de fábrica e reclama.
  ['', 'sete', '0', '-7', '7 dígitos'].forEach((valor) => {
    const { api, registros } = ambiente();
    api.gravarConfig('matricula_digitos', valor);

    igual(api.matriculaDigitos_(), 7, 'com a chave em "' + valor + '"');
    igual(api.validarInscricao(envio({ matricula: '9110001' })), [], 'com a chave em "' + valor + '"');
    igual(api.validarInscricao(envio({ matricula: '911000' })), [MENSAGEM_7], 'com a chave em "' + valor + '"');

    if (valor === '') {
      // Vazio é "não configurado", que é o contrato de `config()` — não é erro.
      igual(registros.erros.length, 0, 'chave vazia não é defeito');
    } else {
      verdadeiro(registros.erros.some((e) => e.indexOf('matricula_digitos') === 0),
        'console com a chave em "' + valor + '": ' + registros.erros.join(' | '));
    }
  });
});

teste('o padrão de fábrica é 7, e está em UM lugar: CONFIG_PADRAO', () => {
  const { api } = ambiente();
  const semente = api.CONFIG_PADRAO.filter((c) => c.chave === 'matricula_digitos')[0];

  verdadeiro(semente, 'a chave sumiu de CONFIG_PADRAO — ela não apareceria em Configurações');
  igual(semente.valor, '7');
  verdadeiro(/zero à esquerda/i.test(semente.descricao), 'a descrição precisa dizer que o zero é aceito');
  verdadeiro(/recusa/i.test(semente.descricao), 'a descrição precisa dizer a consequência');

  // O único 7 escrito em 04_Inscricoes.gs é o padrão do `config()`, que o teste
  // dos padrões já confere. Um segundo literal seria o que envelhece sozinho.
  const codigo = fs.readFileSync(path.join(PASTA_GS, '04_Inscricoes.gs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  igual((codigo.match(/MATRICULA_DIGITOS_PADRAO|= 7\b/g) || []).length, 0,
    'apareceu um 7 escrito à mão em 04_Inscricoes.gs');
});

teste('a régua é uma função só, e o envio e a rota de conferência precisam dela', () => {
  // `erroFormatoMatricula_` é o que `validarInscricao` chama. Se a rota
  // `?api=matricula` (08_Api.gs) tiver a própria conta, o site diz uma coisa ao
  // sair do campo e o servidor diz outra no envio.
  const { api } = ambiente();

  igual(api.erroFormatoMatricula_('9110001'), '');
  igual(api.erroFormatoMatricula_('09110001'), '');
  igual(api.erroFormatoMatricula_('911000'), MENSAGEM_7);
  igual(api.erroFormatoMatricula_(''), MENSAGEM_7);
  igual(api.erroFormatoMatricula_(undefined), MENSAGEM_7);

  const codigo = fs.readFileSync(path.join(PASTA_GS, '04_Inscricoes.gs'), 'utf8');
  const validar = /function validarInscricao[\s\S]*?\n}/.exec(codigo)[0];
  verdadeiro(/erroFormatoMatricula_\(/.test(validar), 'validarInscricao deixou de usar a régua comum');
  verdadeiro(!/matricula\.length/.test(validar), 'validarInscricao voltou a ter uma conta de tamanho própria');
});

teste('o site recebe o número em ?api=config, e é o MESMO que o servidor valida', () => {
  // `dadosFormularioPublico_` (08_Api.gs) é o que monta o `maxlength` e a
  // mensagem do site. Se o número saísse de outro lugar, o site diria "tem 7" e
  // o envio recusaria com 8 — os dois lados precisam beber da mesma função.
  const amb = criarAmbiente({ arquivos: GS.concat(['08_Api.gs', '12_Disciplinas.gs']), usuario: '' });

  igual(amb.api.dadosFormularioPublico_().matriculaDigitos, 7);

  amb.api.gravarConfig('matricula_digitos', '8');
  igual(amb.api.dadosFormularioPublico_().matriculaDigitos, 8, 'a configuração não chegou ao site');

  amb.api.gravarConfig('matricula_digitos', 'sete');
  igual(amb.api.dadosFormularioPublico_().matriculaDigitos, 7, 'chave torta tem de virar o padrão também para o site');
});

teste('telefone com pontuação grava só os dígitos; nove dígitos recusa', () => {
  const { api, falso } = ambiente();
  matricular(api, ['9110001']);
  comLock(api, falso);

  igual(api.validarInscricao(envio({ whatsapp: '(48) 99999-9999' })), []);
  igual(api.validarInscricao(envio({ whatsapp: '(48) 9999-9999' })), [], 'dez dígitos: fixo com DDD');
  igual(api.validarInscricao(envio({ whatsapp: '999999999' })), ['WhatsApp inválido.'], 'nove dígitos: faltou o DDD');
  igual(api.validarInscricao(envio({ whatsapp: '(48) 99999-99999' })), ['WhatsApp inválido.'], 'doze dígitos');

  const r = api.submeterInscricao(envio({ whatsapp: '(48) 99999-9999', curso_fase: '', declara_ciencia: false }));
  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(falso.documentos.get('inscricoes/' + r.protocolo).whatsapp.stringValue, '48999999999');
});

teste('e-mail precisa de algo@algo.algo', () => {
  const { api } = ambiente();

  igual(api.validarInscricao(envio({ email: 'maria@exemplo' })), ['E-mail inválido.'], 'sem o domínio de topo');
  igual(api.validarInscricao(envio({ email: 'maria exemplo@x.com' })), ['E-mail inválido.'], 'espaço');
  igual(api.validarInscricao(envio({ email: '@exemplo.com' })), ['E-mail inválido.'], 'sem a parte local');
  igual(api.validarInscricao(envio({ email: 'MARIA@Exemplo.com ' })), [], 'caixa e espaço na ponta são normalizados');
});

teste('CPF só é conferido quando vem preenchido', () => {
  const { api } = ambiente();

  igual(api.validarInscricao(envio({ cpf: '' })), []);
  igual(api.validarInscricao(envio({ cpf: '111.111.111-11' })), ['CPF inválido.']);
  igual(api.validarInscricao(envio({ cpf: '529.982.247-25' })), []);
});

teste('curso e fase e declaração de ciência só são exigidos quando há projeto', () => {
  const { api } = ambiente();

  igual(api.validarInscricao(envio({ curso_fase: '', declara_ciencia: false })), []);
  igual(api.validarInscricao(envio({ projeto_id: 'p_1', curso_fase: '', declara_ciencia: false })),
    ['Selecione seu curso e fase.', 'É necessário declarar ciência para participar do projeto.']);
});

teste('o aviso de privacidade é exigido sempre', () => {
  const { api } = ambiente();
  igual(api.validarInscricao(envio({ consentimento_lgpd: false })),
    ['É necessário aceitar o aviso de privacidade.']);
});

teste('exigir_matricula=NAO libera inscrição sem matrícula', () => {
  const { api } = ambiente();
  api.gravarConfig('exigir_matricula', 'NAO');

  igual(api.validarInscricao(envio({ matricula: '' })), []);
});

grupo('submeterInscricao ponta a ponta');

teste('caminho feliz com projeto: grava, devolve protocolo e registra INSCRICAO_PROJETO', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { nome: 'R+ Cidades' });
  matricular(api, ['9110001']);
  const eventos = comLock(api, falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1', origem: 'SITE_EXTERNO', tempoPreenchimento: 42000 }));

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.duplicada, false);
  igual(r.mensagem, 'Inscrição registrada com sucesso.');
  igual(acoesDoLog(falso), ['INSCRICAO_PROJETO']);

  const gravado = falso.documentos.get('inscricoes/' + r.protocolo);
  igual(gravado.projeto_id.stringValue, 'p_1');
  igual(gravado.projeto_nome.stringValue, 'R+ Cidades', 'o nome vem do projeto, não do que o aluno mandou');
  igual(gravado.matricula_conferida.stringValue, 'SIM');
  igual(gravado.origem.stringValue, 'SITE_EXTERNO');
  igual(gravado.consentimento_lgpd.stringValue, 'SIM');
  igual(gravado.whatsapp.stringValue, '48999998888');
  igual(marco(eventos, 'soltou') - marco(eventos, 'pegou'), 2,
    'a região protegida continua sendo contar e gravar, com o gravarInscricao de verdade dentro');
});

// O contrato que 09_Projetos.gs escreveu em maiúsculas no cabeçalho: quem grava
// dentro do lock tem de fazer UMA escrita. A varredura de duplicata do sistema
// sobre Sheets acontecia aqui dentro, e era ela que fazia a fila crescer com o
// total de inscritos.
teste('a escrita da inscrição cai entre pegar e soltar o lock, e é a única', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  const eventos = comLock(api, falso);
  zerar(falso);

  api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  const pegou = marco(eventos, 'pegou');
  const soltou = marco(eventos, 'soltou');
  const escrita = falso.requisicoes.findIndex(ESCRITA_INSCRICAO);

  verdadeiro(escrita >= pegou && escrita < soltou,
    'a escrita foi a requisição ' + escrita + ', e a região vai de ' + pegou + ' a ' + soltou);
  igual(soltou - pegou, 2, 'contar e gravar; o log e a conferência da lista ficam de fora');
});

teste('reenvio do mesmo aluno devolve duplicada e não cria segunda inscrição', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  comLock(api, falso);

  const primeira = api.submeterInscricao(envio({ projeto_id: 'p_1' }));
  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(r, {
    ok: true,
    duplicada: true,
    mensagem: 'Você já está inscrito neste projeto. Não é preciso preencher de novo.',
    protocolo: primeira.protocolo
  });
  igual(inscricoesGravadas(falso).length, 1);
  igual(acoesDoLog(falso), ['INSCRICAO_PROJETO', 'INSCRICAO_PROJETO']);
});

teste('a lista oficial é consultada uma vez por inscrição, e a agregação nem roda', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  comLock(api, falso);
  zerar(falso);

  api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(quantas(falso, LEITURA_MATRICULA), 1, 'o sistema sobre Sheets lia a lista duas vezes');
  igual(quantas(falso, AGREGACAO), 1, 'a única agregação é a contagem de vagas de reservarVaga');
});

teste('cadastro fechado recusa antes de qualquer outra coisa', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  api.gravarConfig('cadastro_aberto', 'NAO');
  zerar(falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(r, { ok: false, erro: 'As inscrições estão encerradas no momento.' });
  igual(quantas(falso, ESCRITA_INSCRICAO), 0);
  igual(quantas(falso, LEITURA_MATRICULA), 0, 'nem a lista oficial se lê com o cadastro fechado');
});

teste('projeto esgotado devolve a recusa de reservarVaga, com a situação', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '1' });
  matricular(api, ['9110001', '9110002']);
  api.inserir('inscricoes', { projeto_id: 'p_1', matricula: '9110002' }, 'ja_estava');
  comLock(api, falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(r.ok, false);
  igual(r.situacao, 'ESGOTADO');
  igual(r.erro, 'Inscrições esgotadas. Escolha outro projeto de extensão disponível.');
  igual(inscricoesGravadas(falso).length, 1);
});

teste('sem projeto_id grava por INSCRICAO_SITE, sem pegar lock', () => {
  const { api, falso } = ambiente();
  matricular(api, ['9110001']);
  const eventos = comLock(api, falso);

  const r = api.submeterInscricao(envio({ curso_fase: '', declara_ciencia: false }));

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(eventos.length, 0, 'quem não disputa vaga não entra na fila do auditório');
  igual(acoesDoLog(falso), ['INSCRICAO_SITE']);
  igual(falso.documentos.get('inscricoes/' + r.protocolo).origem.stringValue, 'SITE');
});

teste('matrícula desconhecida com BLOQUEAR recusa apontando o campo', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110002']);
  comLock(api, falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(r.ok, false);
  igual(r.campo, 'matricula');
  verdadeiro(r.erro.indexOf('não encontrada na lista') !== -1, 'erro foi: ' + r.erro);
  igual(inscricoesGravadas(falso).length, 0);
});

teste('em modo AVISAR a inscrição entra marcada como não conferida', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110002']);
  api.gravarConfig('modo_validacao_matricula', 'AVISAR');
  comLock(api, falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(falso.documentos.get('inscricoes/' + r.protocolo).matricula_conferida.stringValue, 'NAO',
    'é isto que separa cadastro confiável de palpite');
});

teste('aluno_projeto_unico=SIM recusa quem já está em outro projeto', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  criarProjeto(api, 'p_2', { nome: 'Arte Digital Floripa' });
  matricular(api, ['9110001']);
  api.inserir('inscricoes', { projeto_id: 'p_2', projeto_nome: 'Arte Digital Floripa', matricula: '9110001' }, 'i_outra');
  api.gravarConfig('aluno_projeto_unico', 'SIM');
  comLock(api, falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(r, {
    ok: false,
    erro: 'Você já está inscrito em Arte Digital Floripa. Cada aluno pode participar de um projeto por semestre.'
  });
  igual(inscricoesGravadas(falso).length, 1);
});

teste('com aluno_projeto_unico=NAO o aviso vai junto do sucesso', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  api.inserir('inscricoes', { projeto_id: 'p_2', projeto_nome: 'Arte Digital Floripa', matricula: '9110001' }, 'i_outra');
  comLock(api, falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.aviso, 'Atenção: você também consta inscrito em Arte Digital Floripa.');
});

teste('reenvio não repete o aviso de outro projeto — nada de novo aconteceu', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  api.inserir('inscricoes', { projeto_id: 'p_2', projeto_nome: 'Arte Digital Floripa', matricula: '9110001' }, 'i_outra');
  comLock(api, falso);

  api.submeterInscricao(envio({ projeto_id: 'p_1' }));
  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(r.duplicada, true);
  igual(r.aviso, undefined);
});

// O aluno não pode receber a mensagem de erro do Firestore na tela, e o erro não
// pode sumir: ele vai para o console, que é o Stackdriver do projeto.
teste('falha do banco vira mensagem genérica, e o motivo fica no console', () => {
  const { api, falso, registros } = ambiente();
  criarProjeto(api, 'p_1');
  api.config('cadastro_aberto', 'SIM');   // aquece o cache, para o erro cair na lista oficial
  falso.forcar(500, 'INTERNAL', 'pane no servidor');

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(r, { ok: false, erro: 'Erro ao registrar. Tente novamente em instantes.' });
  verdadeiro(registros.erros.some((e) => e.indexOf('submeterInscricao') === 0), 'console: ' + registros.erros.join(' | '));
  igual(inscricoesGravadas(falso).length, 0);
});

// ============================================================================

/**
 * O período GERAL de inscrição (pedido do Prof. Mário, 19/09, item 5).
 *
 * O que se prova, em ordem: que publicar esta versão não muda nada (as duas
 * chaves vazias aceitam como sempre); que fora da janela o servidor recusa
 * DIZENDO A DATA — o contador do site é conforto, a trava é aqui; que uma chave
 * digitada torta é ignorada e anotada, e nunca fecha a inscrição; e que o
 * interruptor manual continua mandando por cima da janela.
 *
 * O relógio é o de `criarRelogio`, em UTC; `agora()` formata em -03:00, então
 * 13:00Z é '10:00' no carimbo — é contra esse texto que a janela compara.
 */
grupo('A janela geral de inscrição — ANTES, ABERTA, DEPOIS');

/** Meio-dia e dez de 05/10/2026 em Brasília: '2026-10-05 10:00:00' no carimbo. */
const MEIO_DA_JANELA = Date.UTC(2026, 9, 5, 13, 0, 0);

function ambienteNaJanela(chaves, instante) {
  const relogio = criarRelogio(instante === undefined ? MEIO_DA_JANELA : instante);
  const amb = ambiente({ relogio });
  Object.keys(chaves || {}).forEach((chave) => amb.api.gravarConfig(chave, chaves[chave]));
  criarProjeto(amb.api, 'p_1');
  matricular(amb.api, ['9110001']);
  comLock(amb.api, amb.falso);
  amb.relogio = relogio;
  return amb;
}

teste('as duas chaves vazias = SEM_JANELA, e a inscrição entra como sempre entrou', () => {
  const { api, falso } = ambienteNaJanela({});

  igual(api.janelaDeInscricao_(), { estado: 'SEM_JANELA', inicio: '', fim: '' });
  igual(api.recusaPelaJanela_(), '');

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));
  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(inscricoesGravadas(falso).length, 1);
});

teste('as chaves nascem VAZIAS em CONFIG_PADRAO — publicar no meio do semestre não fecha nada', () => {
  const { api } = ambiente();
  const padrao = {};
  api.CONFIG_PADRAO.forEach((c) => { padrao[c.chave] = c; });

  ['inscricoes_inicio', 'inscricoes_fim'].forEach((chave) => {
    verdadeiro(padrao[chave], chave + ' sumiu de CONFIG_PADRAO');
    igual(padrao[chave].valor, '', chave + ' com padrão preenchido fecharia inscrição ao publicar');
    verdadeiro(/VAZIO/.test(padrao[chave].descricao), 'a descrição precisa dizer o que vazio significa');
  });
});

teste('antes do início: recusa dizendo a data, sem ler nada além da configuração', () => {
  const { api, falso } = ambienteNaJanela({ inscricoes_inicio: '2026-10-07 08:00' });
  zerar(falso);

  igual(api.janelaDeInscricao_().estado, 'ANTES');
  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(r, { ok: false, erro: 'As inscrições abrem em 07/10/2026 às 08:00.' });
  igual(quantas(falso, ESCRITA_INSCRICAO), 0);
  igual(quantas(falso, LEITURA_MATRICULA), 0, 'nem a lista oficial se lê fora da janela');
  igual(falso.requisicoes.length, 1, 'só a configuração — a mesma leitura de cadastro_aberto');
});

teste('depois do fim: recusa dizendo a data, e nada é gravado', () => {
  const { api, falso } = ambienteNaJanela({ inscricoes_fim: '2026-10-03 18:00' });

  igual(api.janelaDeInscricao_().estado, 'DEPOIS');
  igual(api.submeterInscricao(envio({ projeto_id: 'p_1' })),
    { ok: false, erro: 'As inscrições encerraram em 03/10/2026 às 18:00.' });
  igual(inscricoesGravadas(falso).length, 0);
});

teste('dentro da janela — início e fim definidos — aceita', () => {
  const { api, falso } = ambienteNaJanela({
    inscricoes_inicio: '2026-10-01 08:00', inscricoes_fim: '2026-10-30 18:00'
  });

  igual(api.janelaDeInscricao_(),
    { estado: 'ABERTA', inicio: '2026-10-01 08:00', fim: '2026-10-30 18:00' });
  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));
  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(inscricoesGravadas(falso).length, 1);
});

teste('a janela é por MINUTO e compara texto no fuso do carimbo — nunca UTC', () => {
  // 07:59:59 em Brasília, um segundo antes de abrir: ANTES.
  const umSegundoAntes = ambienteNaJanela({ inscricoes_inicio: '2026-10-05 08:00' },
    Date.UTC(2026, 9, 5, 10, 59, 59));
  igual(umSegundoAntes.api.janelaDeInscricao_().estado, 'ANTES');

  // 08:00:00 em Brasília: aberta no minuto exato. Lido como UTC, 08:00 já
  // teria passado há três horas.
  umSegundoAntes.relogio.avancar(1000);
  igual(umSegundoAntes.api.janelaDeInscricao_().estado, 'ABERTA');

  // No minuto do fim já é DEPOIS: é o instante em que o contador do site zera.
  const noFim = ambienteNaJanela({ inscricoes_fim: '2026-10-05 10:00' });
  igual(noFim.api.janelaDeInscricao_().estado, 'DEPOIS');
  noFim.relogio.avancar(-1000);
  igual(noFim.api.janelaDeInscricao_().estado, 'ABERTA', 'um segundo antes do fim ainda aceita');
});

teste('a inscrição SEM projeto — o formulário interno — também respeita a janela', () => {
  const { api, falso } = ambienteNaJanela({ inscricoes_fim: '2026-10-03 18:00' });

  igual(api.submeterInscricao(envio({ curso_fase: '', declara_ciencia: false })).ok, false);
  igual(inscricoesGravadas(falso).length, 0);
});

teste('chave fora do formato é ignorada e anotada — nunca fecha a inscrição', () => {
  const casos = ['01/10/2026 08:00', '2026-10-01', 'amanhã', '2026-13-01 08:00', '2026-10-01 25:00'];

  casos.forEach((valor) => {
    const { api, falso, registros } = ambienteNaJanela({ inscricoes_fim: valor });

    igual(api.janelaDeInscricao_(), { estado: 'SEM_JANELA', inicio: '', fim: '' },
      '"' + valor + '" deveria ser tratado como vazio');
    verdadeiro(registros.erros.some((e) => e.indexOf('inscricoes_fim: "' + valor.slice(0, 40)) === 0),
      'sem aviso no console para "' + valor + '": ' + registros.erros.join(' | '));

    const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));
    igual(r.ok, true, '"' + valor + '" fechou a inscrição: ' + r.erro);
    igual(inscricoesGravadas(falso).length, 1);
  });
});

teste('início torto e fim certo: o fim continua valendo sozinho', () => {
  const { api } = ambienteNaJanela({ inscricoes_inicio: 'segunda', inscricoes_fim: '2026-10-03 18:00' });

  igual(api.janelaDeInscricao_(), { estado: 'DEPOIS', inicio: '', fim: '2026-10-03 18:00' });
  igual(api.submeterInscricao(envio({ projeto_id: 'p_1' })).ok, false);
});

teste('cadastro_aberto=NAO recusa por cima da janela, com a mensagem de sempre', () => {
  const { api, falso } = ambienteNaJanela({
    cadastro_aberto: 'NAO', inscricoes_inicio: '2026-10-01 08:00', inscricoes_fim: '2026-10-30 18:00'
  });

  igual(api.submeterInscricao(envio({ projeto_id: 'p_1' })),
    { ok: false, erro: 'As inscrições estão encerradas no momento.' });
  igual(inscricoesGravadas(falso).length, 0);
});

teste('a recusa da janela vem antes das guardas: não consome o teto por hora nem registra bloqueio', () => {
  const { api, falso } = ambienteNaJanela({ inscricoes_fim: '2026-10-03 18:00' });

  api.submeterInscricao(envio({ projeto_id: 'p_1' }));
  igual(api.PropertiesService.getScriptProperties().getProperty('throttle_contagem'), null,
    'a recusa da janela contou como inscrição no teto por hora');

  // Robô fora da janela leva a mensagem da janela, e não a do honeypot — e não
  // deixa BLOQUEIO na trilha: a janela fechou antes de a guarda olhar.
  const r = api.submeterInscricao(envio({ projeto_id: 'p_1', website: 'http://spam' }));
  igual(r.erro, 'As inscrições encerraram em 03/10/2026 às 18:00.');
  igual(acoesDoLog(falso), []);
});

grupo('Reenvio depois de queda de rede — a dedup é do banco');

// A pergunta que originou este bloco: "um reenvio pode gravar duas vezes?".
// Não pode, e a proteção é de CONSTRUÇÃO, não de conferência nossa: a chave do
// documento é `chaveDedup_`, o `createDocument` recusa a segunda com 409
// ALREADY_EXISTS, e `inserir` trata esse 409 como resposta — nunca como erro.
// O que faltava era o PROTOCOLO na segunda resposta.
teste('o mesmo envio três vezes grava uma vez, e devolve o MESMO protocolo', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  comLock(api, falso);

  const primeira = api.submeterInscricao(envio({ projeto_id: 'p_1' }));
  const segunda = api.submeterInscricao(envio({ projeto_id: 'p_1' }));
  const terceira = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual([primeira.ok, segunda.ok, terceira.ok], [true, true, true],
    'quem reenviou depois de perder a resposta não pode receber erro');
  igual([primeira.duplicada, segunda.duplicada, terceira.duplicada], [false, true, true]);
  igual([segunda.protocolo, terceira.protocolo], [primeira.protocolo, primeira.protocolo],
    'sem o protocolo repetido, quem perdeu a primeira resposta fica sem número nenhum');
  igual(inscricoesGravadas(falso).length, 1);
});

teste('a segunda gravação não custa leitura nem entra na conta de vagas', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '2' });
  matricular(api, ['9110001']);
  comLock(api, falso);
  api.submeterInscricao(envio({ projeto_id: 'p_1' }));
  zerar(falso);

  api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(quantas(falso, ESCRITA_INSCRICAO), 1,
    'a duplicata é descoberta pelo 409 da PRÓPRIA escrita — sem leitura prévia');
  igual(inscricoesGravadas(falso).length, 1);
  igual(api.contarInscritos_('p_1'), 1, 'o reenvio consumiu uma segunda vaga');
});

grupo('Fila de espera, ponta a ponta');

/** O documento que a inscrição gravou, direto do banco falso. */
function documento(falso, id) {
  return falso.documentos.get('inscricoes/' + id);
}

teste('com a chave em NAO, o documento gravado não ganha campo nenhum', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1');
  matricular(api, ['9110001']);
  comLock(api, falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  const gravado = documento(falso, r.protocolo);
  igual(gravado.em_espera, undefined, 'a marca só existe no documento de quem está na fila');
  igual(gravado.espera_de, undefined);
});

teste('com a chave em SIM, o excedente entra marcado e recebe protocolo', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '1' });
  matricular(api, ['9110001', '9110002']);
  api.inserir('inscricoes', { projeto_id: 'p_1', matricula: '9110002' }, 'ja_estava');
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  comLock(api, falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.em_espera, true);
  verdadeiro(r.protocolo, 'quem entra na fila também precisa de um número para mostrar');

  const gravado = documento(falso, r.protocolo);
  igual(gravado.em_espera.stringValue, 'SIM');
  igual(gravado.espera_de.stringValue, 'p_1');
  igual(api.contarInscritos_('p_1'), 1, 'a fila entrou na contagem de vagas');
});

// A frase é o ponto inteiro da peça: quem lê "esgotado" numa tela de auditório
// levanta e vai embora, e esse aluno não volta.
teste('a mensagem diz que a inscrição foi registrada, e não fala em esgotado', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '1' });
  matricular(api, ['9110001', '9110002']);
  api.inserir('inscricoes', { projeto_id: 'p_1', matricula: '9110002' }, 'ja_estava');
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  comLock(api, falso);

  const r = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  verdadeiro(r.mensagem.indexOf('registrada') !== -1, 'a frase foi: ' + r.mensagem);
  verdadeiro(r.mensagem.toLowerCase().indexOf('esgotad') === -1, 'a frase foi: ' + r.mensagem);
  verdadeiro(r.mensagem.indexOf('coordenação') !== -1,
    'a pessoa precisa saber que alguém confirma depois: ' + r.mensagem);
});

teste('o texto da espera é editável pela coordenação, como o do esgotado', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '1' });
  matricular(api, ['9110001', '9110002']);
  api.inserir('inscricoes', { projeto_id: 'p_1', matricula: '9110002' }, 'ja_estava');
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  api.gravarConfig('texto_espera', 'Você está na lista. A coordenação confirma no início do encontro.');
  comLock(api, falso);

  igual(api.submeterInscricao(envio({ projeto_id: 'p_1' })).mensagem,
    'Você está na lista. A coordenação confirma no início do encontro.');
});

// Nunca confie no que veio do navegador: o campo tem nome conhecido e viaja no
// mesmo payload que o aluno preenche.
teste('o aluno não consegue se marcar como em espera pelo payload', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '60' });
  matricular(api, ['9110001', '9110002']);
  comLock(api, falso);

  const comProjeto = api.submeterInscricao(envio({ projeto_id: 'p_1', em_espera: 'SIM' }));
  igual(documento(falso, comProjeto.protocolo).em_espera, undefined,
    'o cliente escolheu não ocupar vaga, e o servidor obedeceu');

  const semProjeto = api.submeterInscricao(envio({
    matricula: '9110002', em_espera: 'SIM', curso_fase: '', declara_ciencia: false
  }));
  igual(documento(falso, semProjeto.protocolo).em_espera, undefined,
    'o formulário interno não passa por reservarVaga, e era a porta aberta');
});

teste('reenvio de quem está na fila devolve o mesmo protocolo, sem segunda linha', () => {
  const { api, falso } = ambiente();
  criarProjeto(api, 'p_1', { vagas: '1' });
  matricular(api, ['9110001', '9110002']);
  api.inserir('inscricoes', { projeto_id: 'p_1', matricula: '9110002' }, 'ja_estava');
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  comLock(api, falso);

  const primeira = api.submeterInscricao(envio({ projeto_id: 'p_1' }));
  const segunda = api.submeterInscricao(envio({ projeto_id: 'p_1' }));

  igual(segunda.duplicada, true);
  igual(segunda.protocolo, primeira.protocolo);
  igual(api.contarEmEspera_('p_1'), 1, 'o reenvio criou uma segunda pessoa na fila');
});

grupo('Contrato com as outras fases');

// Repetido é aceitável; divergente, não: o Apps Script não reclama, a última
// declaração carregada vence em silêncio, e a contagem de vagas passaria a olhar
// uma coleção vazia — todo projeto viraria ABERTO.
teste('INSCRICOES_COLECAO tem o mesmo valor em 04_Inscricoes.gs e em 09_Projetos.gs', () => {
  const valorEm = (arquivo) => {
    const m = /var INSCRICOES_COLECAO = '([^']*)'/.exec(fs.readFileSync(path.join(PASTA_GS, arquivo), 'utf8'));
    if (!m) throw new Error(arquivo + ' não declara INSCRICOES_COLECAO');
    return m[1];
  };

  igual(valorEm('04_Inscricoes.gs'), 'inscricoes');
  igual(valorEm('09_Projetos.gs'), valorEm('04_Inscricoes.gs'));
});

teste('a contagem de vagas de 09_Projetos.gs enxerga o que gravarInscricao grava', () => {
  const { api } = ambiente();
  criarProjeto(api, 'p_1');

  api.gravarInscricao(envio({ projeto_id: 'p_1' }));
  api.gravarInscricao(envio({ projeto_id: 'p_1', matricula: '9110002' }));
  api.gravarInscricao(envio({ projeto_id: 'p_2', matricula: '9110003' }));

  igual(api.contarInscritos_('p_1'), 2, 'coleção e campo projeto_id são o contrato entre as duas fases');
  igual(api.listarProjetos(false).filter((p) => p.id === 'p_1')[0].restantes, 58);
});

// ---------------------------------------------------------------- Resultado

process.exit(resultado());
