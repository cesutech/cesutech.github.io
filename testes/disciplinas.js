/**
 * disciplinas.js — testa o cadastro de disciplinas (12_Disciplinas.gs) e o
 * contrato dele com o Admin.html, sem tocar no Google.
 *
 * O que se prova aqui, em ordem de importância:
 *   1. UNICIDADE pelo banco. Duas disciplinas iguais não coexistem, e quem
 *      recusa a segunda é o 409 ALREADY_EXISTS do Firestore — não uma consulta
 *      nossa, que duas execuções simultâneas furariam. É o motivo de o id do
 *      documento ser derivado dos quatro campos.
 *   2. A ROTA PÚBLICA não fica com o `select` vazio: coleção vazia e consulta
 *      que falha caem em `cursos_fases`. Select vazio faz TODA inscrição morrer
 *      em "Selecione seu curso e fase" — já aconteceu neste sistema.
 *   3. EXCLUIR não é INATIVAR: disciplina com inscrição é recusada, e a recusa
 *      oferece a saída certa. Aluno cuja disciplina sumiu vira dado órfão.
 *   4. A CORINGA: sempre por último, uma ativa por vez, e a lista de quem a
 *      escolheu — que é o ponto inteiro dela.
 *   5. A MIGRAÇÃO reproduz o TEXTO de `cursos_fases` caractere por caractere. É
 *      isso que impede a inscrição já gravada de deixar de casar com a opção.
 *
 * O `CacheService` do `apoio.js` é de verdade (com expiração presa ao relógio),
 * então o cache da lista pública é exercitado, e não presumido.
 *
 * Uso:  node testes/disciplinas.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  teste, grupo, igual, verdadeiro, resultado, criarAmbiente, criarRelogio
} = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');
// O painel mudou de casa em 07/08: era `apps-script/Admin.html`, servido pelo
// Apps Script, e agora é `docs/painel/index.html`, servido pelo GitHub Pages.
// Os contratos abaixo são os mesmos — o arquivo é que é outro.
const ADMIN = fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'painel', 'index.html'), 'utf8');
const FONTE = fs.readFileSync(path.join(PASTA_GS, '12_Disciplinas.gs'), 'utf8');

// Na ordem alfabética em que o editor do Apps Script carrega os arquivos.
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '03_Config.gs',
  '04_Inscricoes.gs', '04_Log.gs', '07_Auth.gs', '09_Projetos.gs', '12_Disciplinas.gs'];

function ambiente(opcoes) {
  const amb = criarAmbiente(Object.assign(
    { arquivos: GS, usuario: 'coordenacao@exemplo.com' }, opcoes || {}
  ));
  amb.api.semearConfigPadrao_();
  return amb;
}

/**
 * Uma sessão de admin, montada como as três portas do painel a montam.
 *
 * `criarSessao_` é o que `autenticar`, `entrarComGoogle` e `entrarComLink`
 * chamam no último passo, e é o passo inteiro que interessa aqui: nada neste
 * arquivo é sobre COMO se entra, só sobre o que um token válido autoriza. Passar
 * pelo login de verdade obrigaria cada teste de disciplina a manter a allowlist,
 * o client id e o correio de pé — três coisas que 07_Auth.gs e 07b já provam em
 * `acesso.js`, e que aqui só teriam como quebrar por motivo alheio.
 *
 * O e-mail não é decoração: `quemMexeu_` o lê da sessão para assinar as linhas
 * do log que os testes de trilha conferem.
 */
function tokenAdmin(api) {
  return api.criarSessao_('coordenacao@exemplo.com');
}

function linha(curso, turma, semestre, ano) {
  return { curso: curso, turma: turma, semestre: semestre || '1', ano: ano || '2026' };
}

/** Inclui pelo caminho público de verdade — nada de semear o banco na mão. */
function incluir(api, token, linhas, coringa) {
  return api.incluirDisciplinas({ token: token, linhas: linhas, coringa: coringa });
}

function idDe(api, token, rotulo) {
  const achada = api.listarDisciplinas({ token: token }).itens
    .filter((d) => d.rotulo === rotulo)[0];
  if (!achada) throw new Error('não achei a disciplina "' + rotulo + '"');
  return achada.id;
}

/** Como a rota pública monta a lista — o que o aluno vê no `select`. */
function listaDoFormulario(api) {
  return api.cursosFasesAtivos_();
}

function documentosDe(falso, colecao) {
  const chaves = [];
  falso.documentos.forEach((_campos, chave) => {
    if (chave.indexOf(colecao + '/') === 0) chaves.push(chave);
  });
  return chaves;
}

function acoesDoLog(falso) {
  const acoes = [];
  falso.documentos.forEach((campos, chave) => {
    if (chave.indexOf('log/') === 0) acoes.push(campos.acao.stringValue);
  });
  return acoes;
}

// ============================================================================

console.log('\n\x1b[1mUNICESUSC CESUTECH — cadastro de disciplinas (12_Disciplinas.gs)\x1b[0m');

// ---------------------------------------------------------------- Unicidade

grupo('Unicidade — quem recusa a segunda igual é o banco');

teste('o id do documento é derivado dos quatro campos, e não sorteado', () => {
  const { api } = ambiente();
  const a = api.chaveDisciplina_({ curso: 'WORK EXPERIENCE', turma: 'ADM61', semestre: '1', ano: '2026' });
  const b = api.chaveDisciplina_({ curso: 'WORK EXPERIENCE', turma: 'ADM61', semestre: '1', ano: '2026' });
  const c = api.chaveDisciplina_({ curso: 'WORK EXPERIENCE', turma: 'ADM61', semestre: '2', ano: '2026' });

  igual(a, b, 'os mesmos quatro campos precisam dar o mesmo endereço');
  verdadeiro(a !== c, 'trocar o semestre é outra disciplina, e outro endereço');
});

teste('grafia diferente da mesma disciplina cai no mesmo endereço', () => {
  const { api } = ambiente();
  // 'Work Experience' e 'WORK EXPERIENCE' são a mesma disciplina. Duas entradas
  // dariam ao aluno duas opções que ele não sabe distinguir.
  igual(
    api.chaveDisciplina_({ curso: 'Work  Experience', turma: 'adm61', semestre: '1', ano: '2026' }),
    api.chaveDisciplina_({ curso: 'WORK EXPERIENCE', turma: 'ADM61', semestre: '1', ano: '2026' })
  );
});

teste('a segunda igual volta como jaExistia, e não vira documento novo', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);

  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61')]);
  const r = incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61')]);

  igual(r.ok, true);
  igual(r.criadas, []);
  igual(r.jaExistiam, ['ADM61 - WORK EXPERIENCE (2026/1)']);
  igual(documentosDe(falso, 'disciplinas').length, 1, 'um documento, não dois');
});

teste('quem recusa a duplicata é o 409 do banco, e não uma consulta nossa', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61')]);

  falso.requisicoes.length = 0;
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61')]);

  // Nenhuma leitura antes de gravar: a tentativa de POST É a conferência.
  // Consulta antes de escrever seria uma corrida — duas execuções leriam "não
  // existe" antes de qualquer uma gravar.
  igual(falso.requisicoes.filter((r) => r.url.indexOf(':runQuery') !== -1).length, 0,
    'não pode haver consulta de duplicidade antes da escrita');
  igual(falso.requisicoes.filter((r) => r.metodo === 'POST' && r.url.indexOf('/disciplinas') !== -1).length, 1);
});

teste('duas linhas IGUAIS no mesmo lote são erro de digitação, não duplicata do banco', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);

  const r = incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61'), linha('WORK EXPERIENCE', 'ADM61')]);

  igual(r.ok, false);
  igual(r.problemas.length, 1);
  igual(r.problemas[0].linha, 2);
  verdadeiro(r.problemas[0].erros[0].indexOf('linha 1') !== -1, r.problemas[0].erros.join(' '));
  igual(documentosDe(falso, 'disciplinas').length, 0, 'nada foi gravado');
});

// ------------------------------------------------------------ Inclusão em lote

grupo('Inclusão em lote — linha incompleta não derruba as outras');

teste('grava as várias linhas de uma vez', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);

  const r = incluir(api, token, [
    linha('WORK EXPERIENCE', 'ADM61'),
    linha('PROJETO INTERDISCIPLINAR II', 'AU61'),
    linha('PRÁTICA INTERDISCIPLINAR I', 'MKT21')
  ]);

  igual(r.ok, true);
  igual(r.criadas.length, 3);
  igual(api.listarDisciplinas({ token: token }).itens.length, 3);
});

teste('linha incompleta RECUSA o lote inteiro, e nada é gravado', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);

  // A alternativa — gravar as completas — deixaria a coordenação com um lote
  // pela metade e uma janela que ela não sabe se pode fechar. Recusar não perde
  // nada: a janela continua aberta com tudo o que foi digitado.
  const r = incluir(api, token, [
    linha('WORK EXPERIENCE', 'ADM61'),
    { curso: 'PROJETO INTERDISCIPLINAR II', turma: '', semestre: '1', ano: '2026' }
  ]);

  igual(r.ok, false);
  igual(r.problemas, [{ linha: 2, erros: ['Informe a turma.'] }]);
  igual(documentosDe(falso, 'disciplinas').length, 0,
    'a linha 1 estava completa e mesmo assim não entrou — é o contrato');
});

teste('o problema volta com o NÚMERO da linha, para a tela colar o erro nela', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);

  const r = incluir(api, token, [
    linha('WORK EXPERIENCE', 'ADM61'),
    linha('PROJETO INTERDISCIPLINAR II', 'AU61'),
    { curso: 'ALGO', turma: 'X1', semestre: '3', ano: '26' }
  ]);

  igual(r.problemas.length, 1);
  igual(r.problemas[0].linha, 3);
  igual(r.problemas[0].erros, ['Semestre deve ser 1 ou 2.', 'Ano deve ter quatro dígitos (ex.: 2026).']);
});

teste('linha inteiramente em branco é ignorada, não é erro', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);

  // O botão "+ Adicionar linha" costuma deixar uma sobrando no fim.
  const r = incluir(api, token, [
    linha('WORK EXPERIENCE', 'ADM61'),
    { curso: '', turma: '', semestre: '', ano: '' }
  ]);

  igual(r.ok, true);
  igual(r.criadas.length, 1);
});

teste('lote só com linhas em branco avisa em vez de responder sucesso vazio', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  igual(incluir(api, token, [{ curso: '', turma: '', semestre: '', ano: '' }]),
    { ok: false, erro: 'Preencha ao menos uma linha.' });
});

teste('grava uma a uma, e não em escreverEmLote — que sobrescreveria o que existe', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);

  falso.requisicoes.length = 0;
  incluir(api, token, [linha('A', 'A1'), linha('B', 'B1'), linha('C', 'C1')]);

  igual(falso.requisicoes.filter((r) => r.url.indexOf(':commit') !== -1).length, 0,
    ':commit é upsert: apagaria criado_em, criado_por e o ativo de quem já existe');
  igual(falso.requisicoes.filter((r) => r.metodo === 'POST' && r.url.indexOf('/disciplinas') !== -1).length, 3);
});

teste('uma escrita que falha no meio não apaga da resposta as que entraram', () => {
  const { api, falso, registros } = ambiente();
  const token = tokenAdmin(api);

  // A segunda linha estoura com um erro que o Repo NÃO retenta.
  falso.forcar(400, 'INVALID_ARGUMENT', 'quebrou de propósito');

  const r = incluir(api, token, [linha('A', 'A1'), linha('B', 'B1')]);

  igual(r.ok, true);
  igual(r.criadas.length + r.falharam.length, 2);
  igual(r.falharam.length, 1, 'a que falhou precisa aparecer nomeada');
  verdadeiro(registros.erros.some((e) => e.indexOf('incluirDisciplinas') === 0), registros.erros.join(' | '));
});

teste('lote acima do teto é recusado antes de gravar qualquer coisa', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);

  const muitas = [];
  for (let i = 0; i <= api.DISCIPLINAS_MAX_LOTE; i++) muitas.push(linha('C' + i, 'T' + i));

  igual(incluir(api, token, muitas).ok, false);
  igual(documentosDe(falso, 'disciplinas').length, 0);
});

teste('a inclusão registra UMA linha de log para o lote, e não uma por disciplina', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);

  incluir(api, token, [linha('A', 'A1'), linha('B', 'B1'), linha('C', 'C1')]);

  igual(acoesDoLog(falso).filter((a) => a === 'DISCIPLINAS_INCLUIDAS').length, 1);
});

// ---------------------------------------------------------------- Rótulo

grupo('O rótulo — é ele que fica gravado na inscrição');

teste('a TURMA vem na frente — é o discriminador curto', () => {
  const { api } = ambiente();
  // Pedido do professor, 12/08. A lista real tem quatro "PRÁTICA
  // INTERDISCIPLINAR EXTENSIONISTA" que só se distinguem no FIM (I, II, III, IV)
  // e pela turma: com o nome longo na frente, o aluno lê cada linha inteira até
  // achar a dele; com a turma na frente, ele varre uma coluna curta.
  igual(api.rotuloDisciplina_({ curso: 'WORK EXPERIENCE', turma: 'ADM61', semestre: '1', ano: '2026' }),
    'ADM61 - WORK EXPERIENCE (2026/1)');
});

teste('sem turma, o rótulo é o curso sozinho — sem separador pendurado na frente', () => {
  const { api } = ambiente();
  // O caso da coringa, e o das migradas de um texto que não se deixou partir.
  igual(api.rotuloDisciplina_({ curso: 'Outra: disciplina não listada', turma: '', semestre: '', ano: '' }),
    'Outra: disciplina não listada');
  igual(api.rotuloDisciplina_({ curso: 'WORK EXPERIENCE', turma: '', semestre: '1', ano: '2026' }),
    'WORK EXPERIENCE (2026/1)');
});

teste('o ano e o semestre continuam no fim, e o comportamento sem eles não mudou', () => {
  const { api } = ambiente();
  igual(api.rotuloDisciplina_({ curso: 'WORK EXPERIENCE', turma: 'ADM21', semestre: '', ano: '' }),
    'ADM21 - WORK EXPERIENCE');
  igual(api.rotuloDisciplina_({ curso: 'WORK EXPERIENCE', turma: 'ADM21', semestre: '', ano: '2026' }),
    'ADM21 - WORK EXPERIENCE (2026)', 'ano sem semestre continua entrando sozinho');
});

teste('o rótulo é DERIVADO dos campos — as já cadastradas viram o formato novo sozinhas', () => {
  // A pergunta operacional da virada de 12/08: as 16 disciplinas que já estavam
  // no banco precisam ser regravadas? Não. `rotulo` não é campo do documento —
  // `disciplinaDe_` o calcula na leitura, a partir de curso/turma/semestre/ano.
  // Gravar o rótulo seria uma cópia livre para divergir dos campos, e a virada de
  // formato exigiria um passe de escrita em toda a coleção.
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61')]);

  const id = idDe(api, token, 'ADM61 - WORK EXPERIENCE (2026/1)');
  const gravado = falso.documentos.get('disciplinas/' + id);

  igual(gravado.rotulo, undefined, 'o rótulo virou campo gravado — a virada de formato exigiria migração');
  igual(gravado.curso.stringValue, 'WORK EXPERIENCE');
  igual(gravado.turma.stringValue, 'ADM61');

  // E o ENDEREÇO também não depende do rótulo: a chave é o hash dos quatro
  // campos. Se dependesse, mudar o formato moveria todos os documentos.
  igual(id, api.chaveDisciplina_({ curso: 'WORK EXPERIENCE', turma: 'ADM61', semestre: '1', ano: '2026' }),
    'o id do documento passou a depender do formato do rótulo');
});

teste('só o servidor monta o rótulo — o painel nunca o remonta por conta própria', () => {
  // Duas montagens é o começo de duas verdades: a tela mostraria um formato e a
  // inscrição gravaria outro, e a busca por `curso_fase` deixaria de casar.
  verdadeiro(/rotuloDisciplina_/.test(FONTE), 'rotuloDisciplina_ sumiu do servidor');
  igual(/rotuloDisciplina_/.test(ADMIN), false, 'o painel montou o rótulo por conta própria');

  // A tela usa o que o servidor mandou, e o que ela desenha por campo separado
  // (as colunas Curso e Turma da tabela) não é rótulo — é coluna.
  igual(/d\.curso \+ ' - ' \+ d\.turma|d\.turma \+ ' - ' \+ d\.curso/.test(ADMIN), false,
    'o painel voltou a colar curso e turma numa string — use d.rotulo');
});

teste('o formato ANTIGO sobrevive em rotuloLegado_, e só a migração o usa', () => {
  // Ele não é decoração histórica: `partirCursoFase_` confere o próprio corte
  // remontando o texto, e `cursos_fases` está escrita no formato antigo. Conferir
  // com a régua nova faria a migração concluir que TODO corte está errado.
  const { api } = ambiente();
  igual(api.rotuloLegado_({ curso: 'WORK EXPERIENCE', turma: 'ADM21' }), 'WORK EXPERIENCE - ADM21');
  igual(api.rotuloLegado_({ curso: 'Outra: disciplina não listada', turma: '' }),
    'Outra: disciplina não listada');

  const fonte = FONTE.slice(FONTE.indexOf('function partirCursoFase_'));
  verdadeiro(/rotuloLegado_\(candidato\) === inteiro/.test(fonte),
    'a conferência do corte voltou a usar o rótulo NOVO — a migração perde as turmas em silêncio');
});

// ------------------------------------------------------------ Rota pública

grupo('A lista do formulário — só as ativas, e nunca vazia');

teste('só as ATIVAS chegam ao formulário', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('ATIVA', 'A1'), linha('DESLIGADA', 'D1')]);

  api.alternarDisciplina({ token: token, id: idDe(api, token, 'D1 - DESLIGADA (2026/1)'), ativo: false });

  igual(listaDoFormulario(api), ['A1 - ATIVA (2026/1)']);
});

teste('a consulta filtra por UM campo e não declara ordenação — sem índice composto', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('A', 'A1')]);

  falso.requisicoes.length = 0;
  api.rotulosAtivos_();

  const consulta = falso.requisicoes.filter((r) => r.url.indexOf(':runQuery') !== -1)[0];
  const q = consulta.corpo.structuredQuery;

  igual(q.where.fieldFilter.field.fieldPath, 'ativo');
  igual(q.orderBy.length, 1);
  igual(q.orderBy[0].field.fieldPath, '__name__');
  igual(q.orderBy[0].direction, 'ASCENDING',
    '__name__ DESCENDENTE devolve 400 "requires an index" — a armadilha já paga');
});

teste('coleção vazia cai em cursos_fases, e não devolve select vazio', () => {
  const { api } = ambiente();
  // Select vazio faz TODA inscrição morrer em "Selecione seu curso e fase".
  igual(listaDoFormulario(api).length, 13);
  igual(listaDoFormulario(api)[0], 'WORK EXPERIENCE - ADM21');
});

teste('consulta que FALHA também cai em cursos_fases', () => {
  const { api, falso, registros } = ambiente();
  falso.forcar(400, 'FAILED_PRECONDITION', 'The query requires an index');

  igual(listaDoFormulario(api).length, 13);
  verdadeiro(registros.erros.some((e) => e.indexOf('cursosFasesAtivos_') === 0), registros.erros.join(' | '));
});

teste('a rota pública de verdade entrega os rótulos da coleção', () => {
  const amb = criarAmbiente({ arquivos: GS.concat(['08_Api.gs']), usuario: '' });
  amb.api.semearConfigPadrao_();
  const token = tokenAdmin(amb.api);
  incluir(amb.api, token, [linha('WORK EXPERIENCE', 'ADM61')]);
  amb.api.limparCacheConfig();

  igual(amb.api.dadosFormularioPublico_().cursosFases, ['ADM61 - WORK EXPERIENCE (2026/1)']);
});

// ---------------------------------------------------------------- Cota

grupo('Cota — o que a rota do aluno passa a custar');

teste('a lista pública custa uma consulta, e a segunda chamada não vai ao banco', () => {
  const relogio = criarRelogio(new Date('2026-08-06T12:00:00Z').getTime());
  const { api, falso } = ambiente({ relogio: relogio });
  const token = tokenAdmin(api);
  incluir(api, token, [linha('A', 'A1'), linha('B', 'B1')]);

  falso.requisicoes.length = 0;
  igual(listaDoFormulario(api).length, 2);
  igual(falso.requisicoes.length, 1, 'uma consulta; ela cobra 2 documentos, um por disciplina ativa');

  falso.requisicoes.length = 0;
  igual(listaDoFormulario(api).length, 2);
  igual(falso.requisicoes.length, 0, 'a segunda responde do cache');
});

teste('o cache reabre depois de DISCIPLINAS_CACHE_S, e não guarda para sempre', () => {
  const relogio = criarRelogio(new Date('2026-08-06T12:00:00Z').getTime());
  const { api, falso } = ambiente({ relogio: relogio });
  const token = tokenAdmin(api);
  incluir(api, token, [linha('A', 'A1')]);
  listaDoFormulario(api);

  relogio.avancar((api.DISCIPLINAS_CACHE_S + 1) * 1000);
  falso.requisicoes.length = 0;
  listaDoFormulario(api);

  igual(falso.requisicoes.length, 1, 'a janela virou: a lista é montada de novo');
});

teste('o fallback NÃO é cacheado — migrar depois não fica preso por cinco minutos', () => {
  const relogio = criarRelogio(new Date('2026-08-06T12:00:00Z').getTime());
  const { api, falso } = ambiente({ relogio: relogio });

  igual(listaDoFormulario(api).length, 13, 'coleção vazia: caiu em cursos_fases');

  const token = tokenAdmin(api);
  incluir(api, token, [linha('NOVA', 'N1')]);
  falso.requisicoes.length = 0;

  igual(listaDoFormulario(api), ['N1 - NOVA (2026/1)'],
    'a lista nova aparece já, sem esperar a janela do cache virar');
});

teste('toda escrita descarta a lista pública guardada', () => {
  const relogio = criarRelogio(new Date('2026-08-06T12:00:00Z').getTime());
  const { api } = ambiente({ relogio: relogio });
  const token = tokenAdmin(api);
  incluir(api, token, [linha('A', 'A1')]);
  igual(listaDoFormulario(api), ['A1 - A (2026/1)']);

  api.alternarDisciplina({ token: token, id: idDe(api, token, 'A1 - A (2026/1)'), ativo: false });

  // Sem a invalidação, a coordenação inativaria a disciplina e ela continuaria
  // no formulário por cinco minutos, sem nenhum sinal de que sumiu do painel.
  igual(listaDoFormulario(api).length, 13, 'sobrou só o fallback: nada ativo no cadastro');
});

// ---------------------------------------------------------------- Coringa

grupo('A coringa — por último, uma só, e com a lista de quem a escolheu');

teste('aparece SEMPRE por último, nunca no meio', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);

  incluir(api, token, [{ curso: 'Outra: disciplina não listada' }], true);
  incluir(api, token, [linha('ZOOLOGIA', 'Z1'), linha('ADMINISTRAÇÃO', 'A1')]);

  const lista = listaDoFormulario(api);
  igual(lista[lista.length - 1], 'Outra: disciplina não listada',
    'saída de emergência no meio da lista é escolhida por engano');
  igual(lista, ['A1 - ADMINISTRAÇÃO (2026/1)', 'Z1 - ZOOLOGIA (2026/1)', 'Outra: disciplina não listada']);
});

teste('a coringa não precisa de turma, semestre nem ano', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  igual(incluir(api, token, [{ curso: 'Outra: disciplina não listada' }], true).criadas,
    ['Outra: disciplina não listada']);
});

teste('a coringa sem rótulo continua sendo recusada', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  igual(incluir(api, token, [{ curso: '   ' }], true), { ok: false, erro: 'Preencha ao menos uma linha.' });
});

teste('só uma coringa ATIVA por vez', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [{ curso: 'Outra: disciplina não listada' }], true);

  const r = incluir(api, token, [{ curso: 'Não achei a minha' }], true);
  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('inative a atual') !== -1, r.erro);
});

teste('inativar a primeira libera a segunda', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [{ curso: 'Outra: disciplina não listada' }], true);
  api.alternarDisciplina({ token: token, id: idDe(api, token, 'Outra: disciplina não listada'), ativo: false });

  igual(incluir(api, token, [{ curso: 'Não achei a minha' }], true).ok, true);
});

teste('reativar uma coringa velha com outra no ar é recusado', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [{ curso: 'Primeira' }], true);
  const primeira = idDe(api, token, 'Primeira');
  api.alternarDisciplina({ token: token, id: primeira, ativo: false });
  incluir(api, token, [{ curso: 'Segunda' }], true);

  // Sem a conferência na ATIVAÇÃO, este caminho poria duas coringas no
  // formulário sem nenhuma delas ter sido criada irregularmente.
  const r = api.alternarDisciplina({ token: token, id: primeira, ativo: true });
  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('Segunda') !== -1, r.erro);
});

teste('o painel lista quem escolheu a coringa — o ponto inteiro dela', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [{ curso: 'Outra: disciplina não listada' }], true);
  const id = idDe(api, token, 'Outra: disciplina não listada');

  // Gravadas pelo caminho de verdade (04_Inscricoes.gs), e não semeadas na mão:
  // o campo e o formato têm de ser os que a produção grava.
  api.gravarInscricao({
    projeto_id: 'p1', projeto_nome: 'R+ Cidades', matricula: '9110001',
    nome: 'Maria de Souza', email: 'maria@aluno.br',
    curso_fase: 'Outra: disciplina não listada'
  });
  api.gravarInscricao({
    projeto_id: 'p1', projeto_nome: 'R+ Cidades', matricula: '9110002',
    nome: 'João Lima', email: 'joao@aluno.br', curso_fase: 'Z1 - ZOOLOGIA (2026/1)'
  });

  const r = api.inscritosDaDisciplina({ token: token, id: id });
  igual(r.ok, true);
  igual(r.itens.length, 1);
  igual(r.itens[0].matricula, '9110001');
  igual(r.itens[0].nome, 'Maria de Souza');
});

teste('a lista de inscritos casa pelo TEXTO gravado, com uma consulta só', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61')]);
  const id = idDe(api, token, 'ADM61 - WORK EXPERIENCE (2026/1)');

  falso.requisicoes.length = 0;
  api.inscritosDaDisciplina({ token: token, id: id });

  const consulta = falso.requisicoes.filter((r) => r.url.indexOf(':runQuery') !== -1)[0];
  igual(consulta.corpo.structuredQuery.from[0].collectionId, 'inscricoes');
  igual(consulta.corpo.structuredQuery.where.fieldFilter.field.fieldPath, 'curso_fase');
  igual(consulta.corpo.structuredQuery.where.fieldFilter.value.stringValue,
    'ADM61 - WORK EXPERIENCE (2026/1)');
  igual(consulta.corpo.structuredQuery.limit, api.DISCIPLINAS_MAX_INSCRITOS);
});

// ------------------------------------------------------------- Cruzamento

/**
 * `matriculadosDaDisciplina` — o OUTRO lado, e o que a coordenação pergunta no
 * dia do evento: "quem de ADS11 ainda NÃO se inscreveu em projeto nenhum?".
 *
 * Nenhuma consulta sobre `inscricoes` responde isso, e é o ponto inteiro desta
 * fase: quem não se inscreveu não TEM documento em `inscricoes`. A ausência só
 * aparece cruzando com a lista de quem deveria estar lá.
 *
 * O que se prova aqui, em ordem de importância:
 *
 *   1. o casamento é pela TURMA da lista oficial, e não pelo texto `curso_fase`
 *      que o aluno escolheu — texto que ele erra e que MUDA quando a disciplina
 *      é editada;
 *   2. quem está na lista oficial e não se inscreveu aparece em SEM_PROJETO. É a
 *      resposta da pergunta;
 *   3. NINGUÉM SOME. Quem se inscreveu declarando esta disciplina e a lista
 *      oficial desta turma não tem — matrícula digitada errada, turma divergente
 *      entre os dois cadastros, inscrição sem matrícula — cai em FORA_DA_LISTA,
 *      com o que declarou à vista;
 *   4. o teto de leitura é respeitado e o corte é DITO. Aqui a varredura cortada
 *      produz falso "SEM PROJETO" — acusar de faltoso quem já se inscreveu —, e
 *      por isso o aviso é o mais duro da tela.
 */
grupo('Cruzamento — quem da turma ainda NÃO se inscreveu');

/**
 * Uma linha da lista oficial da secretaria.
 *
 * Os campos são os de IMPORTACAO_CAMPOS (05_Importacao.gs) e o id do documento é
 * a matrícula normalizada — o contrato que a importação grava. Semeado direto
 * porque 05_Importacao.gs não está no `GS` deste arquivo (ele arrasta Drive e
 * leitura de planilha); há um teste logo abaixo conferindo que os dois campos de
 * que o cruzamento depende continuam existindo lá.
 */
function matricular(api, matricula, campos) {
  const chave = api.normalizarMatricula(matricula);
  api.inserir('matriculados', Object.assign({
    nome: 'Matriculado ' + chave, cpf: '', email: chave + '@aluno.br',
    matricula: chave, telefone: '', data_nascimento: '',
    curso: 'ADS', turma: 'ADS11', situacao: 'MATRICULADO'
  }, campos || {}), chave);
  return chave;
}

function inscrever(api, campos) {
  return api.gravarInscricao(Object.assign({
    projeto_id: 'p1', projeto_nome: 'R+ Cidades', origem: 'FORMULARIO'
  }, campos));
}

function cruzar(api, token, id, turma) {
  const payload = { token: token, id: id };
  if (turma !== undefined) payload.turma = turma;
  return api.matriculadosDaDisciplina(payload);
}

/** A disciplina do cruzamento, e o id dela. */
function disciplinaDaTurma(api, token, turma) {
  incluir(api, token, [linha('PRATICA EXTENSIONISTA', turma)]);
  return idDe(api, token, turma + ' - PRATICA EXTENSIONISTA (2026/1)');
}

function linhaDe(r, nome) {
  return r.itens.filter((i) => i.nome === nome)[0] || null;
}

teste('matriculado da turma que ESTÁ em projeto aparece com o nome do projeto', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');

  matricular(api, '9110001', { nome: 'Maria de Souza' });
  inscrever(api, {
    matricula: '9110001', nome: 'Maria de Souza', email: 'maria@aluno.br',
    curso_fase: 'ADS11 - PRATICA EXTENSIONISTA (2026/1)'
  });

  const r = cruzar(api, token, id);
  igual(r.ok, true);
  igual(r.turma, 'ADS11');

  const maria = linhaDe(r, 'Maria de Souza');
  verdadeiro(maria !== null, 'a matriculada sumiu da lista');
  igual(maria.grupo, 'COM_PROJETO');
  igual(maria.projetos, 'R+ Cidades', 'a tela precisa dizer QUAL projeto');
  igual(r.resumo.comProjeto, 1);
  igual(r.resumo.semProjeto, 0);
});

teste('matriculado da turma SEM inscrição nenhuma aparece na lista de quem falta', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');

  matricular(api, '9110001', { nome: 'Maria de Souza' });
  matricular(api, '9110002', { nome: 'Joao Lima' });
  inscrever(api, {
    matricula: '9110001', nome: 'Maria de Souza',
    curso_fase: 'ADS11 - PRATICA EXTENSIONISTA (2026/1)'
  });

  const r = cruzar(api, token, id);
  const joao = linhaDe(r, 'Joao Lima');
  verdadeiro(joao !== null, 'quem não se inscreveu sumiu — é exatamente quem a tela procura');
  igual(joao.grupo, 'SEM_PROJETO');
  igual(joao.projetos, '');
  igual(r.resumo.semProjeto, 1);
  igual(r.resumo.comProjeto, 1);
});

teste('inscrição em QUALQUER projeto conta, e não só nesta disciplina', () => {
  // O aluno de ADS11 que se inscreveu escolhendo OUTRA disciplina no formulário
  // está inscrito. Contá-lo como faltoso seria mandar cobrar quem já resolveu —
  // e é o erro que casar por `curso_fase` cometeria.
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');

  matricular(api, '9110001', { nome: 'Maria de Souza' });
  inscrever(api, {
    matricula: '9110001', nome: 'Maria de Souza',
    projeto_id: 'p2', projeto_nome: 'Robótica na Praça',
    curso_fase: 'XYZ99 - OUTRA COISA (2026/1)'
  });

  const r = cruzar(api, token, id);
  const maria = linhaDe(r, 'Maria de Souza');
  igual(maria.grupo, 'COM_PROJETO');
  igual(maria.projetos, 'Robótica na Praça');
  igual(maria.declarou, 'XYZ99 - OUTRA COISA (2026/1)',
    'o que ela declarou fica à vista — é o que permite ver a divergência');
  igual(r.resumo.semProjeto, 0);
});

teste('quem se inscreveu e a lista oficial NÃO tem não some da conta', () => {
  // A decisão está escrita no cabeçalho da função: quem manda em "é desta turma"
  // é a LISTA OFICIAL. Então quem declarou esta disciplina e a lista não tem
  // aparece num terceiro grupo, com o que declarou — e não é engolido nem
  // promovido a membro da turma.
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');

  matricular(api, '9110001', { nome: 'Maria de Souza' });
  inscrever(api, {
    matricula: '9119999', nome: 'Fantasma da Matricula',
    curso_fase: 'ADS11 - PRATICA EXTENSIONISTA (2026/1)'
  });

  const r = cruzar(api, token, id);
  const fantasma = linhaDe(r, 'Fantasma da Matricula');
  verdadeiro(fantasma !== null, 'quem não está na lista oficial sumiu da tela');
  igual(fantasma.grupo, 'FORA_DA_LISTA');
  igual(fantasma.projetos, 'R+ Cidades');
  igual(r.resumo.foraDaLista, 1);
  igual(r.resumo.semProjeto, 1, 'e a Maria continua sendo quem falta');
});

teste('inscrição SEM matrícula também aparece — ela não tem como casar com ninguém', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');

  inscrever(api, {
    matricula: '', nome: 'Gente da Comunidade', email: 'gente@vizinho.br',
    curso_fase: 'ADS11 - PRATICA EXTENSIONISTA (2026/1)'
  });

  const r = cruzar(api, token, id);
  const pessoa = linhaDe(r, 'Gente da Comunidade');
  verdadeiro(pessoa !== null, 'inscrição sem matrícula foi engolida pelo cruzamento');
  igual(pessoa.grupo, 'FORA_DA_LISTA');
  igual(pessoa.matricula, '');
});

teste('turma declarada no formulário diverge da oficial: manda a OFICIAL, e a divergência fica à vista', () => {
  // O caso ambíguo, resolvido de propósito e não por acidente. O aluno consta
  // como ADS12 na secretaria e escolheu ADS11 no formulário:
  //
  //   na tela de ADS11 ..... FORA_DA_LISTA, com o que declarou ao lado
  //   na tela de ADS12 ..... COM_PROJETO, porque é ali que ele está matriculado
  //
  // As duas telas o mostram, nenhuma o inventa como membro de ADS11, e a
  // coordenação decide qual dos dois cadastros corrigir.
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const emAds11 = disciplinaDaTurma(api, token, 'ADS11');
  const emAds12 = disciplinaDaTurma(api, token, 'ADS12');

  matricular(api, '9110007', { nome: 'Aluno Divergente', turma: 'ADS12' });
  inscrever(api, {
    matricula: '9110007', nome: 'Aluno Divergente',
    curso_fase: 'ADS11 - PRATICA EXTENSIONISTA (2026/1)'
  });

  const ads11 = cruzar(api, token, emAds11);
  igual(linhaDe(ads11, 'Aluno Divergente').grupo, 'FORA_DA_LISTA',
    'a lista oficial de ADS11 não o tem — ele não pode entrar como se tivesse');
  igual(linhaDe(ads11, 'Aluno Divergente').declarou,
    'ADS11 - PRATICA EXTENSIONISTA (2026/1)');

  const ads12 = cruzar(api, token, emAds12);
  igual(linhaDe(ads12, 'Aluno Divergente').grupo, 'COM_PROJETO',
    'na turma em que ele consta, ele está inscrito');
  igual(ads12.resumo.semProjeto, 0);
});

teste('a matrícula casa com e sem o zero à esquerda', () => {
  // A lista oficial traz '09110001' e o aluno digita '9110001'. As duas formas
  // passam por `normalizarMatricula` nas DUAS pontas do cruzamento — sem isso, o
  // aluno inscrito apareceria como faltoso e como fora da lista ao mesmo tempo.
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');

  matricular(api, '09110001', { nome: 'Maria de Souza' });
  inscrever(api, {
    matricula: '9110001', nome: 'Maria de Souza',
    curso_fase: 'ADS11 - PRATICA EXTENSIONISTA (2026/1)'
  });

  const r = cruzar(api, token, id);
  igual(r.resumo.comProjeto, 1);
  igual(r.resumo.semProjeto, 0);
  igual(r.resumo.foraDaLista, 0, 'a mesma pessoa apareceu duas vezes, dos dois lados');
});

teste('a pessoa em dois projetos mostra os dois', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');

  matricular(api, '9110001', { nome: 'Maria de Souza' });
  inscrever(api, { matricula: '9110001', nome: 'Maria de Souza', projeto_id: 'p1', projeto_nome: 'R+ Cidades' });
  inscrever(api, { matricula: '9110001', nome: 'Maria de Souza', projeto_id: 'p2', projeto_nome: 'Robótica' });

  const maria = linhaDe(cruzar(api, token, id), 'Maria de Souza');
  verdadeiro(maria.projetos.indexOf('R+ Cidades') !== -1, maria.projetos);
  verdadeiro(maria.projetos.indexOf('Robótica') !== -1, maria.projetos);
});

teste('quem está na fila de espera continua contando como inscrito, e a espera é dita', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');

  matricular(api, '9110001', { nome: 'Maria de Souza' });
  inscrever(api, {
    matricula: '9110001', nome: 'Maria de Souza', em_espera: 'SIM',
    curso_fase: 'ADS11 - PRATICA EXTENSIONISTA (2026/1)'
  });

  const maria = linhaDe(cruzar(api, token, id), 'Maria de Souza');
  igual(maria.grupo, 'COM_PROJETO', 'quem está na fila JÁ se inscreveu — não é quem falta');
  verdadeiro(/em espera/.test(maria.projetos), maria.projetos);
});

// ---------------------------------------------- Os tetos, e o que eles dizem

teste('o teto da TURMA é respeitado e o corte é dito na tela', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');
  api.DISCIPLINAS_MAX_TURMA = 2;

  for (let i = 1; i <= 4; i++) matricular(api, '911000' + i, { nome: 'Aluno ' + i });

  const r = cruzar(api, token, id);
  igual(r.lidas.matriculados, 2, 'leu mais do que o teto');
  verdadeiro(/teto de 2 matriculados/.test((r.avisos || []).join(' ')),
    'a turma cortada em silêncio esconderia gente da lista de quem falta: ' + r.avisos);
});

teste('a varredura de inscrições cortada DIZ que pode inventar faltoso', () => {
  // O aviso mais duro da tela, e o motivo: uma varredura cortada faz quem se
  // inscreveu (e ficou fora do pedaço lido) aparecer como SEM PROJETO. Cobrar
  // alguém que já resolveu é o estrago que este texto existe para impedir.
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');
  api.DISCIPLINAS_BLOCO = 2;
  api.DISCIPLINAS_MAX_CRUZAMENTO = 3;

  matricular(api, '9110001', { nome: 'Maria de Souza' });
  for (let i = 1; i <= 8; i++) {
    inscrever(api, { matricula: '922000' + i, nome: 'Outro ' + i, projeto_id: 'p' + i });
  }

  const r = cruzar(api, token, id);
  igual(r.truncado, true, 'a varredura passou do teto sem dizer nada');
  verdadeiro(r.lidas.inscricoes <= 4, 'leu muito além do teto: ' + r.lidas.inscricoes);

  const aviso = (r.avisos || []).join(' ');
  verdadeiro(/SEM PROJETO sem estar/.test(aviso), aviso);
  verdadeiro(/aba Alunos/.test(aviso), 'o aviso precisa dizer para onde ir: ' + aviso);
  // A agregação só é paga aqui, para o aviso poder dizer o tamanho do buraco.
  verdadeiro(/de 8/.test(aviso), 'o aviso não diz de quantas: ' + aviso);
});

teste('a agregação do total só é paga quando a varredura foi cortada', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');
  matricular(api, '9110001', { nome: 'Maria de Souza' });

  falso.requisicoes.length = 0;
  const r = cruzar(api, token, id);

  igual(r.truncado, undefined);
  igual(falso.requisicoes.filter((q) => q.url.indexOf(':runAggregationQuery') !== -1).length, 0,
    'contou sem precisar — agregação é para número, e aqui o número já veio da lista');
});

teste('turma que a lista oficial não tem responde ZERO e diz como consertar', () => {
  // A armadilha era esta: `turma` subia para caixa alta no cadastro de
  // disciplinas e entrava na lista oficial como veio da secretaria. 'ADS11' não
  // achava 'Ads11', e a tela respondia "ninguém" sobre uma turma cheia.
  //
  // Desde 12/08 a importação normaliza (05_Importacao.gs), então uma linha em
  // caixa mista só existe se tiver sido gravada ANTES — e é isso que o aviso
  // agora manda resolver, em vez de mandar digitar a forma torta no campo.
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');
  matricular(api, '9110001', { nome: 'Maria de Souza', turma: 'Ads11' });

  const r = cruzar(api, token, id);
  igual(r.ok, true);
  igual(r.lidas.matriculados, 0);
  const aviso = (r.avisos || []).join(' ');
  verdadeiro(/comparação é exata/.test(aviso), aviso);
  verdadeiro(/reimporte o mesmo arquivo/.test(aviso),
    'o aviso precisa dizer o conserto de verdade: ' + aviso);
  verdadeiro(/ninguém desta turma pode ser contado como "sem projeto"/i.test(aviso), aviso);
});

teste('a turma digitada no painel manda na do cadastro — para olhar OUTRA turma', () => {
  // A saída manual continua existindo, e o uso dela continua o mesmo: olhar uma
  // turma diferente da que está no cadastro da disciplina (ou uma disciplina
  // cadastrada sem turma).
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');
  matricular(api, '9110001', { nome: 'Maria de Souza', turma: 'ADS12' });

  const r = cruzar(api, token, id, 'ADS12');
  igual(r.turma, 'ADS12');
  igual(r.lidas.matriculados, 1);
  igual(linhaDe(r, 'Maria de Souza').grupo, 'SEM_PROJETO');
});

teste('e o que a pessoa digita passa pela MESMA régua da importação', () => {
  // A saída de emergência não pode carregar o defeito que a escrita consertou:
  // se este campo fosse cru, quem digitasse 'ads12' receberia ZERO de uma turma
  // cheia — o mesmo "ninguém" de antes, pela outra porta.
  const { api } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');
  matricular(api, '9110001', { nome: 'Maria de Souza', turma: 'ADS12' });

  const r = cruzar(api, token, id, '  ads12  ');
  igual(r.turma, 'ADS12', 'o campo manual devolveu a forma crua para a tela');
  igual(r.lidas.matriculados, 1, 'digitar em caixa baixa voltou a responder ninguém');
  igual(linhaDe(r, 'Maria de Souza').grupo, 'SEM_PROJETO');
});

teste('o cadastro da disciplina também sobe a turma, e pela mesma função', () => {
  // As duas pontas do casamento saem de `normalizarTurma` (01_Utils.gs). Este
  // teste é o que impede uma delas de mudar sozinha — a divergência não dá erro,
  // dá lista vazia.
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('PRATICA EXTENSIONISTA', 'ads13')]);
  const id = idDe(api, token, 'ADS13 - PRATICA EXTENSIONISTA (2026/1)');
  matricular(api, '9110001', { nome: 'Maria de Souza', turma: 'ADS13' });

  const r = cruzar(api, token, id);
  igual(r.turma, 'ADS13');
  igual(r.lidas.matriculados, 1);
});

teste('disciplina sem turma (a coringa) recusa e manda para a vista que responde por ela', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [{ curso: 'Outra: disciplina não listada' }], true);
  const id = idDe(api, token, 'Outra: disciplina não listada');

  const r = cruzar(api, token, id);
  igual(r.ok, false);
  verdadeiro(/coringa não é uma turma de verdade/.test(r.erro), r.erro);
  verdadeiro(/Escolheram esta disciplina/.test(r.erro),
    'a recusa precisa dizer o que fazer em vez disso: ' + r.erro);
});

// -------------------------------------------------- O custo, e o que não faz

teste('duas consultas com UM filtro cada, nenhuma escrita, nenhum orderBy de campo', () => {
  // Filtro num campo somado a ordenação por OUTRO exige índice composto e
  // devolve `400 The query requires an index` — a cicatriz de `ultimosRegistros`
  // (04_Log.gs). E uma tela de relatório não escreve NADA, nem no log.
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');
  matricular(api, '9110001', { nome: 'Maria de Souza' });
  inscrever(api, { matricula: '9110001', nome: 'Maria de Souza' });

  falso.requisicoes.length = 0;
  cruzar(api, token, id);

  const consultas = falso.requisicoes.filter((q) => q.url.indexOf(':runQuery') !== -1);
  igual(consultas.length, 2, 'uma consulta por coleção: a turma e a varredura');

  const daTurma = consultas[0].corpo.structuredQuery;
  igual(daTurma.from[0].collectionId, 'matriculados');
  igual(daTurma.where.fieldFilter.field.fieldPath, 'turma');
  igual(daTurma.where.fieldFilter.value.stringValue, 'ADS11');
  igual(daTurma.orderBy[0].field.fieldPath, '__name__');
  igual(daTurma.orderBy[0].direction, 'ASCENDING');
  igual(daTurma.limit, api.DISCIPLINAS_MAX_TURMA);

  const varredura = consultas[1].corpo.structuredQuery;
  igual(varredura.from[0].collectionId, 'inscricoes');
  igual(varredura.where, undefined, 'a varredura não filtra — ela precisa de todas');
  igual(varredura.orderBy[0].field.fieldPath, '__name__');
  igual(varredura.limit, api.DISCIPLINAS_BLOCO);

  const escritas = falso.requisicoes.filter(
    (q) => (q.metodo === 'PATCH' || q.metodo === 'DELETE') ||
           (q.metodo === 'POST' && q.url.indexOf(':run') === -1));
  igual(escritas, [], 'um relatório escreveu no banco');
});

teste('a varredura de inscrições anda por CURSOR, e não relê a primeira página', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  const id = disciplinaDaTurma(api, token, 'ADS11');
  api.DISCIPLINAS_BLOCO = 2;

  for (let i = 1; i <= 5; i++) {
    inscrever(api, { matricula: '922000' + i, nome: 'Outro ' + i, projeto_id: 'p' + i });
  }

  falso.requisicoes.length = 0;
  const r = cruzar(api, token, id);

  igual(r.lidas.inscricoes, 5, 'a varredura perdeu ou repetiu documento');
  const paginas = falso.requisicoes
    .filter((q) => q.url.indexOf(':runQuery') !== -1)
    .map((q) => q.corpo.structuredQuery)
    .filter((q) => q.from[0].collectionId === 'inscricoes');

  igual(paginas[0].startAt, undefined, 'a primeira página não tem de onde continuar');
  verdadeiro(paginas.slice(1).every((p) => p.startAt && p.startAt.before === false),
    'as seguintes têm de continuar do cursor, e não pular por offset');
});

// ---------------------------------------------------------------- Edição

grupo('Edição — o endereço do documento muda com os campos');

teste('editar um campo move o documento e apaga o endereço velho', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM51')]);
  const antigo = idDe(api, token, 'ADM51 - WORK EXPERIENCE (2026/1)');

  const r = api.editarDisciplina({
    token: token, id: antigo,
    disciplina: linha('WORK EXPERIENCE', 'ADM61')
  });

  igual(r.ok, true);
  verdadeiro(r.id !== antigo, 'o id é derivado dos campos: mudou o campo, mudou o endereço');
  igual(documentosDe(falso, 'disciplinas').length, 1, 'o endereço velho não pode sobrar');
  igual(listaDoFormulario(api), ['ADM61 - WORK EXPERIENCE (2026/1)']);
});

teste('a edição CARREGA criado_em e criado_por para o endereço novo', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM51')]);
  const antigo = api.listarDisciplinas({ token: token }).itens[0];

  const r = api.editarDisciplina({
    token: token, id: antigo.id, disciplina: linha('WORK EXPERIENCE', 'ADM61')
  });

  const nova = api.listarDisciplinas({ token: token }).itens[0];
  igual(nova.id, r.id);
  igual(nova.criado_em, antigo.criado_em, 'sem isto, toda edição zeraria a autoria');
  igual(nova.criado_por, 'coordenacao@exemplo.com');
});

teste('a edição preserva ativo e coringa', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM51')]);
  const id = idDe(api, token, 'ADM51 - WORK EXPERIENCE (2026/1)');
  api.alternarDisciplina({ token: token, id: id, ativo: false });

  const r = api.editarDisciplina({
    token: token, id: idDe(api, token, 'ADM51 - WORK EXPERIENCE (2026/1)'),
    disciplina: linha('WORK EXPERIENCE', 'ADM61')
  });

  const nova = api.listarDisciplinas({ token: token }).itens[0];
  igual(r.ok, true);
  igual(nova.ativo, false, 'editar não pode religar o que a coordenação desligou');
});

teste('editar até colidir com uma existente é recusado, e não apaga a original', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('A', 'A1'), linha('B', 'B1')]);

  const r = api.editarDisciplina({
    token: token, id: idDe(api, token, 'B1 - B (2026/1)'), disciplina: linha('A', 'A1')
  });

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('Já existe') === 0, r.erro);
  igual(documentosDe(falso, 'disciplinas').length, 2, 'as duas continuam de pé');
});

teste('editar só a caixa das letras é PATCH no mesmo endereço', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('work experience', 'ADM61')]);
  const id = idDe(api, token, 'ADM61 - work experience (2026/1)');

  falso.requisicoes.length = 0;
  const r = api.editarDisciplina({ token: token, id: id, disciplina: linha('WORK EXPERIENCE', 'ADM61') });

  igual(r.id, id, 'a chave normaliza a caixa: mesmo endereço');
  igual(falso.requisicoes.filter((x) => x.metodo === 'DELETE').length, 0, 'nada a apagar');
});

teste('editar disciplina que sumiu não a ressuscita pela metade', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);

  // `atualizar` é PATCH, e PATCH no Firestore CRIA o documento que não existe —
  // a mesma armadilha de `salvarProjeto` (09_Projetos.gs).
  const r = api.editarDisciplina({
    token: token, id: 'nao_existe', disciplina: linha('A', 'A1')
  });

  igual(r, { ok: false, erro: 'Disciplina não encontrada. Recarregue a lista.' });
  igual(documentosDe(falso, 'disciplinas').length, 0);
});

// -------------------------------------------------------- Excluir × inativar

grupo('Excluir e inativar NÃO são a mesma coisa');

teste('inativar tira do formulário e mantém o registro', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61')]);
  const id = idDe(api, token, 'ADM61 - WORK EXPERIENCE (2026/1)');

  const r = api.alternarDisciplina({ token: token, id: id, ativo: false });

  igual(r.ok, true);
  verdadeiro(r.mensagem.indexOf('histórico continua') !== -1, r.mensagem);
  igual(documentosDe(falso, 'disciplinas').length, 1, 'o registro fica');
  igual(api.listarDisciplinas({ token: token }).itens[0].ativo, false);
});

teste('excluir disciplina sem inscrição apaga mesmo', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61')]);

  const r = api.removerDisciplina({ token: token, id: idDe(api, token, 'ADM61 - WORK EXPERIENCE (2026/1)') });

  igual(r, { ok: true, mensagem: 'Disciplina excluída.' });
  igual(documentosDe(falso, 'disciplinas').length, 0);
});

teste('excluir disciplina COM inscrição é recusado e oferece inativar', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61')]);
  const id = idDe(api, token, 'ADM61 - WORK EXPERIENCE (2026/1)');

  api.gravarInscricao({
    projeto_id: 'p1', matricula: '9110001', nome: 'Maria de Souza',
    curso_fase: 'ADM61 - WORK EXPERIENCE (2026/1)'
  });

  const r = api.removerDisciplina({ token: token, id: id });

  igual(r.ok, false);
  igual(r.inscritos, 1);
  verdadeiro(r.erro.indexOf('Inativar') !== -1, 'a recusa precisa dizer a saída: ' + r.erro);
  igual(documentosDe(falso, 'disciplinas').length, 1, 'nada foi apagado');
});

teste('a guarda conta por AGREGAÇÃO, e não trazendo as inscrições', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61')]);
  const id = idDe(api, token, 'ADM61 - WORK EXPERIENCE (2026/1)');

  falso.requisicoes.length = 0;
  api.removerDisciplina({ token: token, id: id });

  // Trazer as inscrições para contá-las custaria uma leitura por inscrito.
  igual(falso.requisicoes.filter((r) => r.url.indexOf(':runAggregationQuery') !== -1).length, 1);
  igual(falso.requisicoes.filter((r) => r.url.indexOf(':runQuery') !== -1).length, 0);
});

teste('a guarda usa a MESMA coleção que gravarInscricao escreve', () => {
  // Repetido é aceitável; divergente, não: o Apps Script não reclama de duas
  // declarações, a última carregada vence em silêncio, e a guarda passaria a
  // contar uma coleção vazia — liberando a exclusão de toda disciplina com
  // inscritos.
  const valorEm = (arquivo) => {
    const m = /var INSCRICOES_COLECAO = '([^']*)'/.exec(fs.readFileSync(path.join(PASTA_GS, arquivo), 'utf8'));
    if (!m) throw new Error(arquivo + ' não declara INSCRICOES_COLECAO');
    return m[1];
  };
  igual(valorEm('12_Disciplinas.gs'), 'inscricoes');
  igual(valorEm('12_Disciplinas.gs'), valorEm('04_Inscricoes.gs'));
});

teste('MATRICULADOS_COLECAO tem o mesmo valor nos quatro arquivos que a declaram', () => {
  // Divergir aqui é pior do que na de cima: `matriculadosDaDisciplina` cruzaria
  // contra uma coleção VAZIA e responderia que a turma inteira está sem projeto
  // — uma lista de chamada de gente para cobrar que não devia nada. E não
  // quebraria nada visível: a tela abre, a consulta responde, o número é zero.
  const valorEm = (arquivo) => {
    const m = /var MATRICULADOS_COLECAO = '([^']*)'/.exec(
      fs.readFileSync(path.join(PASTA_GS, arquivo), 'utf8'));
    if (!m) throw new Error(arquivo + ' não declara MATRICULADOS_COLECAO');
    return m[1];
  };

  igual(valorEm('12_Disciplinas.gs'), 'matriculados');
  ['04_Inscricoes.gs', '05_Importacao.gs', '06_Reconciliacao.gs'].forEach((arquivo) => {
    igual(valorEm(arquivo), valorEm('12_Disciplinas.gs'), arquivo + ' divergiu');
  });
});

teste('o cruzamento depende de dois campos da importação, e eles continuam lá', () => {
  // `turma` é a chave do casamento e `matricula` é o endereço do documento. Se a
  // importação parar de gravar um deles, esta tela não quebra — ela responde
  // ZERO, que é a resposta mais perigosa que ela tem.
  const importacao = fs.readFileSync(path.join(PASTA_GS, '05_Importacao.gs'), 'utf8');
  const m = /var IMPORTACAO_CAMPOS = \[([\s\S]*?)\];/.exec(importacao);
  verdadeiro(m !== null, 'IMPORTACAO_CAMPOS sumiu de 05_Importacao.gs');

  ['turma', 'matricula'].forEach((campo) => {
    verdadeiro(m[1].indexOf("'" + campo + "'") !== -1,
      campo + ' saiu da importação — o cruzamento da aba Disciplinas para de casar');
  });
});

// ---------------------------------------------------------------- Migração

grupo('Migração — o texto de cursos_fases não pode mudar');

teste('cria uma disciplina por opção de cursos_fases', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);

  const r = api.migrarDisciplinas();

  igual(r.criadas.length, 13);
  igual(api.listarDisciplinas({ token: token }).itens.length, 14, '13 + a coringa');
});

teste('a migração parte curso e turma sem perder um caractere — só a ORDEM muda', () => {
  // Este teste já afirmou o contrário: que o rótulo migrado era IDÊNTICO ao texto
  // de `cursos_fases`, porque inscrição guarda TEXTO e não referência. A promessa
  // caiu em 12/08 junto com a virada da turma para a frente, e caiu numa janela
  // conferida contra a produção — ZERO inscrições gravadas, nenhuma órfã.
  //
  // O que sobrou de garantia, e é o que se prova aqui: nenhuma opção PERDE
  // conteúdo na migração. Cada texto original tem de aparecer na lista nova com
  // as mesmas duas partes, na ordem nova. Uma migração que engolisse a turma
  // (gravando o texto inteiro como `curso`) passaria num teste frouxo e deixaria
  // a aba Disciplinas sem turma nenhuma para cruzar.
  const { api } = ambiente();
  const originais = api.configLista('cursos_fases');

  api.migrarDisciplinas();
  const lista = listaDoFormulario(api);

  originais.forEach((texto) => {
    const partes = api.partirCursoFase_(texto);
    const esperado = api.rotuloDisciplina_(partes);

    verdadeiro(lista.indexOf(esperado) !== -1,
      'a opção "' + texto + '" virou "' + esperado + '" e não está na lista');
    // A ida-e-volta pelo formato LEGADO tem de devolver o texto de origem: é o
    // que prova que o corte foi fiel, e não que a função desistiu dele.
    igual(api.rotuloLegado_(partes), texto, 'a migração perdeu a turma de "' + texto + '"');
    verdadeiro(partes.turma !== '', 'a turma de "' + texto + '" se perdeu no corte');
  });

  igual(lista.indexOf('ADM21 - WORK EXPERIENCE') !== -1, true,
    'a turma tem de estar na frente na lista que o aluno lê');
});

teste('parte curso e turma no último " - ", e só quando o texto volta igual', () => {
  const { api } = ambiente();
  igual(api.partirCursoFase_('WORK EXPERIENCE - ADM21'),
    { curso: 'WORK EXPERIENCE', turma: 'ADM21', semestre: '', ano: '' });

  // Nome com o separador no meio: o código da turma é o ÚLTIMO pedaço.
  igual(api.partirCursoFase_('PROJETO - INTERDISCIPLINAR - AU71').curso, 'PROJETO - INTERDISCIPLINAR');

  // Quando remontar não devolve o original (aqui a turma em caixa baixa), a
  // função desiste do corte: texto inteiro vira curso, que reproduz sempre.
  igual(api.partirCursoFase_('ALGO - adm21'), { curso: 'ALGO - adm21', turma: '', semestre: '', ano: '' });
});

teste('migrados entram SEM semestre e SEM ano — cursos_fases não os tinha', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  api.migrarDisciplinas();

  const uma = api.listarDisciplinas({ token: token }).itens
    .filter((d) => d.turma === 'ADM21')[0];

  // Chutar o ano corrente seria inventar dado de secretaria dentro de uma
  // função de migração — e mudaria o rótulo, quebrando o casamento por texto.
  igual(uma.semestre, '');
  igual(uma.ano, '');
  igual(uma.rotulo, 'ADM21 - WORK EXPERIENCE', 'a turma tem de vir na frente');
});

teste('migrados entram ATIVOS: o formulário serve a mesma lista de ontem', () => {
  const { api } = ambiente();
  const antes = listaDoFormulario(api);

  api.migrarDisciplinas();

  const depois = listaDoFormulario(api);
  igual(depois.length, antes.length + 1, 'as mesmas 13, mais a coringa');
  igual(depois[depois.length - 1], 'Outra: disciplina não listada');
});

teste('rodar de novo não duplica nem desfaz correção', () => {
  const { api, falso } = ambiente();
  const token = tokenAdmin(api);
  api.migrarDisciplinas();

  const id = idDe(api, token, 'ADM21 - WORK EXPERIENCE');
  api.alternarDisciplina({ token: token, id: id, ativo: false });

  const r = api.migrarDisciplinas();

  igual(r.criadas, []);
  igual(r.jaExistiam.length, 13);
  igual(documentosDe(falso, 'disciplinas').length, 14);
  igual(api.listarDisciplinas({ token: token }).itens.filter((d) => d.id === id)[0].ativo, false,
    'a correção da coordenação não pode ser desfeita por rodar a migração de novo');
});

teste('NÃO apaga a chave cursos_fases — ela é o fallback', () => {
  const { api } = ambiente();
  api.migrarDisciplinas();
  igual(api.configLista('cursos_fases').length, 13);
});

teste('não cria uma segunda coringa se já houver uma ativa', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [{ curso: 'Não achei a minha' }], true);

  igual(api.migrarDisciplinas().coringa, null);
  igual(api.listarDisciplinas({ token: token }).itens.filter((d) => d.coringa).length, 1);
});

teste('migrarDisciplinas é chamável do editor — o nome não termina em sublinhado', () => {
  // O editor do Apps Script não lista no seletor de função os nomes terminados
  // em '_'. Uma migração que ninguém consegue disparar não migra nada — foi
  // exatamente o que aconteceu com `semearConfigPadrao_` (ver `setup`).
  verdadeiro(/^\s*function migrarDisciplinas\(\)/m.test(FONTE));
});

// ---------------------------------------------------------------- Painel

grupo('A tela — filtro, ordem e as guardas de sessão');

teste('a lista do painel traz ativas e inativas, com a coringa por último', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [{ curso: 'Outra: disciplina não listada' }], true);
  incluir(api, token, [linha('ZOOLOGIA', 'Z1'), linha('ADMINISTRAÇÃO', 'A1')]);
  api.alternarDisciplina({ token: token, id: idDe(api, token, 'Z1 - ZOOLOGIA (2026/1)'), ativo: false });

  const itens = api.listarDisciplinas({ token: token }).itens;
  igual(itens.map((d) => d.rotulo),
    ['A1 - ADMINISTRAÇÃO (2026/1)', 'Z1 - ZOOLOGIA (2026/1)', 'Outra: disciplina não listada']);
  igual(itens[1].ativo, false);
});

teste('a lista traz os quatro campos separados, para a tela filtrar por eles', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61', '2', '2027')]);

  const d = api.listarDisciplinas({ token: token }).itens[0];
  igual([d.curso, d.turma, d.semestre, d.ano], ['WORK EXPERIENCE', 'ADM61', '2', '2027']);
  igual(d.rotulo, 'ADM61 - WORK EXPERIENCE (2027/2)');
});

teste('sem token, nenhuma das sete funções do painel responde dado', () => {
  const { api } = ambiente();
  ['listarDisciplinas', 'incluirDisciplinas', 'editarDisciplina',
    'alternarDisciplina', 'removerDisciplina', 'inscritosDaDisciplina',
    'matriculadosDaDisciplina'].forEach((funcao) => {
    const r = api[funcao]({ token: 'token-falso' });
    igual(r.ok, false, funcao + ' respondeu sem token');
    // A mensagem precisa casar com o teste do Admin.html, que derruba a sessão
    // por ela (`/Sess.o expirada|inv.lida/`).
    verdadeiro(/Sess.o expirada|inv.lida/.test(r.erro), funcao + ': ' + r.erro);
  });
});

teste('a lista cortada pelo teto DIZ que foi cortada', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);

  // A disciplina 501 sumindo sem erro faria a coordenação concluir que ela foi
  // apagada — o modo de falha que este sistema não aceita mais.
  const fonte = FONTE.replace(/var DISCIPLINAS_MAX = \d+;/, 'var DISCIPLINAS_MAX = 2;');
  verdadeiro(fonte !== FONTE, 'o teto mudou de nome; conserte este teste');

  const amb = criarAmbiente({ arquivos: GS, usuario: 'coordenacao@exemplo.com' });
  amb.api.semearConfigPadrao_();
  const t2 = tokenAdmin(amb.api);
  amb.api.DISCIPLINAS_MAX = 2;
  incluir(amb.api, t2, [linha('A', 'A1'), linha('B', 'B1'), linha('C', 'C1')]);

  const r = amb.api.listarDisciplinas({ token: t2 });
  igual(r.itens.length, 2);
  verdadeiro(r.aviso.indexOf('Há mais no cadastro') !== -1, r.aviso);
  igual(typeof token, 'string');
});

// ------------------------------------------------ Contratos com o Admin.html

grupo('O Admin.html chama, e o servidor responde');

teste('as sete funções desta aba existem e são chamadas pelo painel', () => {
  const { api } = ambiente();

  ['listarDisciplinas', 'incluirDisciplinas', 'editarDisciplina', 'alternarDisciplina',
    'removerDisciplina', 'inscritosDaDisciplina', 'matriculadosDaDisciplina'].forEach((funcao) => {
    igual(typeof api[funcao], 'function', funcao + ' não existe no servidor');
    verdadeiro(ADMIN.indexOf("chamar('" + funcao + "'") !== -1,
      'o Admin.html não chama ' + funcao + ' — o contrato mudou de um lado só');
  });
});

teste('a aba existe nas três listas que a fazem funcionar', () => {
  // Botão, seção e o `trocarAba` que as liga. Faltando qualquer uma, a aba abre
  // em branco ou não abre — sem erro nenhum no console.
  verdadeiro(ADMIN.indexOf('data-aba="disciplinas"') !== -1, 'falta o botão da aba');
  verdadeiro(ADMIN.indexOf('id="secao-disciplinas"') !== -1, 'falta a seção');

  // A lista de `trocarAba` é lida pelo NOME que interessa, e não pelas três
  // primeiras posições: a ordem das abas muda quando uma nova entra (a do
  // Auditório entrou em segundo lugar em 11/08), e um teste que dependa da ordem
  // falha por causa de uma aba que não é a dele — apontando para o lugar errado.
  const lista = /function trocarAba\(nome\)[\s\S]*?\[([^\]]*)\]/.exec(ADMIN);
  verdadeiro(lista !== null && lista[1].indexOf("'disciplinas'") !== -1,
    'trocarAba não conhece a aba');
  verdadeiro(ADMIN.indexOf("if (nome === 'disciplinas') carregarDisciplinas();") !== -1,
    'a aba não carrega nada ao ser aberta');
});

teste('as três leituras desta aba estão em SO_LEITURA, e as quatro escritas não', () => {
  const bloco = /var SO_LEITURA = \{([\s\S]*?)\};/.exec(ADMIN);
  verdadeiro(bloco !== null, 'SO_LEITURA sumiu do Admin.html');

  ['listarDisciplinas', 'inscritosDaDisciplina', 'matriculadosDaDisciplina'].forEach((f) => {
    verdadeiro(bloco[1].indexOf(f) !== -1, f + ' só lê e devia estar em SO_LEITURA');
  });
  // Escrita fora da lista é o que faz o painel esquecer as abas e recarregar.
  ['incluirDisciplinas', 'editarDisciplina', 'alternarDisciplina', 'removerDisciplina'].forEach((f) => {
    igual(bloco[1].indexOf(f), -1, f + ' grava: não pode ser tratada como leitura');
  });
});

teste('a tela usa os campos que o servidor manda, e o servidor manda todos', () => {
  const { api } = ambiente();
  const token = tokenAdmin(api);
  incluir(api, token, [linha('WORK EXPERIENCE', 'ADM61')]);
  const d = api.listarDisciplinas({ token: token }).itens[0];

  ['id', 'curso', 'turma', 'semestre', 'ano', 'rotulo', 'ativo', 'coringa'].forEach((campo) => {
    verdadeiro(Object.prototype.hasOwnProperty.call(d, campo), 'o servidor não manda ' + campo);
    verdadeiro(ADMIN.indexOf('d.' + campo) !== -1, 'o painel não usa ' + campo);
  });
});

teste('o payload que o Admin.html monta é o que o servidor lê', () => {
  // Os nomes das chaves são o contrato. Trocar `linhas` por `itens` de um lado
  // só faz o lote chegar vazio e o servidor responder "Preencha ao menos uma
  // linha" para uma janela cheia.
  verdadeiro(/chamar\('incluirDisciplinas', \{ linhas: linhas \}/.test(ADMIN));
  verdadeiro(/chamar\('incluirDisciplinas', \{ linhas: \[linha\], coringa: true \}/.test(ADMIN));
  verdadeiro(/chamar\('editarDisciplina', \{ id: id, disciplina: disciplina \}/.test(ADMIN));
  verdadeiro(/chamar\('alternarDisciplina', \{ id: id, ativo: ativar \}/.test(ADMIN));
  verdadeiro(/chamar\('removerDisciplina', \{ id: id \}/.test(ADMIN));
  verdadeiro(/chamar\('inscritosDaDisciplina', \{ id: id \}/.test(ADMIN));

  // O cruzamento manda `turma` SÓ quando ela foi digitada. Mandar sempre faria a
  // turma do cadastro viajar como se fosse escolha da coordenação, e o servidor
  // perderia como distinguir "usa a do cadastro" de "usa esta aqui".
  verdadeiro(/chamar\('matriculadosDaDisciplina', pedido,/.test(ADMIN),
    'o painel não chama matriculadosDaDisciplina');
  verdadeiro(/if \(turma !== undefined && turma !== null\) pedido\.turma = turma;/.test(ADMIN),
    'a turma digitada deixou de ser opcional no payload');
});

teste('a janela de Inscritos tem as DUAS vistas, e a da turma abre primeiro', () => {
  // As duas respondem perguntas diferentes, e a que abre é a do dia do evento.
  // Uma janela com só uma delas deixaria a outra pergunta sem tela.
  verdadeiro(/function trocarVistaDisciplina\(id, qual\)/.test(ADMIN), 'falta a troca de vista');
  verdadeiro(/if \(qual === 'turma'\) carregarTurmaDisciplina\(id\);/.test(ADMIN));
  verdadeiro(/else carregarEscolheramDisciplina\(id\);/.test(ADMIN));

  // A coringa não tem turma para cruzar — ela abre direto na vista que responde
  // por ela, em vez de abrir numa recusa.
  verdadeiro(/trocarVistaDisciplina\(id, d\.turma \? 'turma' : 'texto'\);/.test(ADMIN),
    'a janela deixou de escolher a vista pela turma da disciplina');
});

teste('o recorte e a busca filtram no NAVEGADOR, sem voltar ao servidor', () => {
  // Cada volta relê as duas coleções (ver o custo em 12_Disciplinas.gs). Trocar
  // "sem projeto" por "em projeto" não é dado novo — é outro recorte do mesmo.
  //
  // A PENEIRA MUDOU DE LUGAR (18/08) e o teste mudou junto: ela saiu do desenho
  // para `turmaDisciplinaFiltrada()`, porque as exportações precisam do MESMO
  // recorte. Se cada uma refizesse o filtro, o arquivo que a coordenação manda
  // para a direção poderia ter gente que a tela não estava mostrando.
  const fn = /function desenharTurmaDisciplina\(\)[\s\S]*?\n  \}/.exec(ADMIN);
  verdadeiro(fn !== null, 'desenharTurmaDisciplina sumiu do painel');
  igual(/chamar\(/.test(fn[0]), false, 'o filtro da tela voltou a consultar o servidor');
  verdadeiro(/turmaDisciplinaFiltrada\(\)/.test(fn[0]),
    'a tabela deixou de usar a peneira que as exportações usam');

  const peneira = /function turmaDisciplinaFiltrada\(\)[\s\S]*?\n  \}/.exec(ADMIN);
  verdadeiro(peneira !== null, 'turmaDisciplinaFiltrada sumiu do painel');
  igual(/chamar\(/.test(peneira[0]), false, 'a peneira voltou a consultar o servidor');
  verdadeiro(/TURMA_DISCIPLINA\.itens\.filter/.test(peneira[0]), 'deixou de filtrar o que já veio');

  // A tabela é redesenhada sozinha, e não a janela inteira: o campo de busca mora
  // FORA dela, senão cada tecla digitada o destruiria junto com o cursor.
  verdadeiro(/getElementById\('disc-turma-tabela'\)/.test(fn[0]),
    'o redesenho voltou a levar o campo de busca junto');
});

teste('a tela mostra quantos documentos foram lidos, e os três grupos', () => {
  // Número de leitura na tela não é curiosidade: é o que permite desconfiar da
  // conta antes de agir sobre ela.
  verdadeiro(/documento\(s\) lido\(s\)/.test(ADMIN), 'a tela deixou de dizer quanto custou');
  verdadeiro(/r\.lidas\.matriculados/.test(ADMIN) && /r\.lidas\.inscricoes/.test(ADMIN));

  // As três opções do `select`, pelo `value` — que é o que o filtro compara com
  // o `grupo` que o servidor manda.
  ['SEM_PROJETO', 'COM_PROJETO', 'FORA_DA_LISTA'].forEach((g) => {
    verdadeiro(ADMIN.indexOf('value="' + g + '"') !== -1, 'o filtro perdeu o grupo ' + g);
  });

  // Os avisos do servidor são TODOS desenhados. Mostrar só o primeiro esconderia
  // justamente o da varredura cortada, que é o que inventa faltoso.
  verdadeiro(/\(r\.avisos \|\| \[\]\)\.forEach/.test(ADMIN),
    'a tela mostra só um aviso — o do corte pode ser o segundo');
});

teste('a janela de lote lê os campos ANTES de redesenhar', () => {
  // `innerHTML` joga fora os campos, e com eles o que foi digitado. Sem a
  // leitura antes, clicar em "+ Adicionar linha" apagaria as linhas já
  // preenchidas — que é exatamente o que não podia acontecer.
  const funcoes = ['adicionarLinhaDisciplina', 'removerLinhaDisciplina'];
  funcoes.forEach((nome) => {
    const corpo = new RegExp('function ' + nome + '\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\}').exec(ADMIN);
    verdadeiro(corpo !== null, nome + ' sumiu do Admin.html');
    verdadeiro(corpo[1].indexOf('lerLinhasDisciplina()') !== -1,
      nome + ' redesenha sem ler o que foi digitado — o lote se perde');
  });
});

teste('o botão de nova linha fica embaixo, à direita', () => {
  // Pedido textual do Jonathan: "no fim, embaixo, do lado direito, um botao
  // para adicionar uma nova linha".
  const estilos = fs.readFileSync(path.join(PASTA_GS, 'Estilos.html'), 'utf8');
  verdadeiro(/\.rodape-direita \{[^}]*justify-content: flex-end/.test(estilos));
  verdadeiro(/<div class="rodape-direita">[\s\S]{0,200}adicionarLinhaDisciplina\(\)/.test(ADMIN));
});

// ---------------------------------------------------------------- Resultado

process.exit(resultado());
