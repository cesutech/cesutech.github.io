/**
 * painel-navegador.js — o painel CLICADO, e a vizinhança da matrícula.
 *
 * Duas coisas que nenhum teste anterior fazia, e as duas foram escritas depois de
 * encontrar defeito de verdade:
 *
 *   1. O `<script>` do Admin.html RODA aqui, num navegador falso
 *      (`dom-painel.js`), e o `google.script.run` chama as funções `.gs` de
 *      verdade contra o Firestore falso. As duas fases anteriores entregaram a aba
 *      Disciplinas e a janela de edição do aluno dizendo, com todas as letras, que
 *      nada daquilo tinha sido executado num navegador — e o próprio repositório
 *      registra que o falso já escondeu seis defeitos que só o clique encontrou.
 *      Aqui se clica: troca-se de aba, abre-se a janela, digita-se, salva-se, e o
 *      que se afirma é o que a tela ficou mostrando;
 *
 *   2. A VIZINHANÇA DA MATRÍCULA. O 409 do banco fecha uma colisão só — a mesma
 *      pessoa no mesmo projeto. A matrícula é a chave da PESSOA e atravessa os
 *      projetos, e por isso duas situações reais terminavam com "Ficha
 *      atualizada." e nada mais: a inscrição da mesma pessoa em OUTRO projeto que
 *      fica para trás com a matrícula errada, e a matrícula nova que já pertence a
 *      outra inscrição — caso em que o cruzamento funde duas pessoas numa ficha
 *      só. Os testes daqui montam as duas com `gravarInscricao` e `reconciliar` de
 *      verdade, e falham se o aviso sumir.
 *
 * Uso:  node testes/painel-navegador.js
 */

'use strict';

const { teste, grupo, igual, verdadeiro, lancou, resultado, criarAmbiente } = require('./apoio');
const { abrirPainel, GS, semResposta, respostaHttp } = require('./dom-painel');

// ------------------------------------------------------------ Apoio local

/** O cenário do sistema: dois projetos, dois matriculados, três inscrições. */
function cadastroBase(api) {
  api.semearConfigPadrao_();
  api.inserir('projetos', {
    nome: 'Origem', vagas: '10', ativo: 'SIM', inscricoes_abertas: 'SIM',
    ordem: '1', validar_matricula: 'SIM'
  }, 'p1');
  api.inserir('projetos', {
    nome: 'Lotado', vagas: '2', ativo: 'SIM', inscricoes_abertas: 'SIM',
    ordem: '2', validar_matricula: 'SIM'
  }, 'p2');

  api.escreverEmLote('matriculados', [
    { _id: '110001', matricula: '110001', nome: 'Ana Silva', turma: 'ADS11', curso: 'ADS', lote_id: 'L1' },
    { _id: '220002', matricula: '220002', nome: 'Bruno Souza', turma: 'DIR21', curso: 'DIREITO', lote_id: 'L1' }
  ]);

  // A Ana se inscreveu com a matrícula do Bruno. É o caso que a janela de edição
  // existe para consertar.
  api.gravarInscricao({
    matricula: '220002', nome: 'Ana Silva', email: 'ana@exemplo.com',
    projeto_id: 'p1', projeto_nome: 'Origem', origem: 'SITE', curso_fase: 'ADS - 1'
  });
  api.gravarInscricao({
    matricula: '900009', nome: 'X Um', email: 'x1@exemplo.com',
    projeto_id: 'p2', projeto_nome: 'Lotado', origem: 'SITE'
  });
  api.gravarInscricao({
    matricula: '901009', nome: 'X Dois', email: 'x2@exemplo.com',
    projeto_id: 'p2', projeto_nome: 'Lotado', origem: 'SITE'
  });
  api.reconciliar();
}

/** Os ids que a tabela de alunos pôs nos botões — é por eles que se clica. */
function idsDaTabela(cena, funcao) {
  const ids = [];
  cena.html('conteudo-alunos').replace(
    new RegExp(funcao + "\\('([^']+)'\\)", 'g'),
    (m, id) => { ids.push(id); return m; }
  );
  return ids;
}

/** O aluno da tabela cujo campo bate — a linha em que o teste vai clicar. */
function alunoOnde(cena, campo, valor) {
  const alunos = cena.documentos('alunos');
  return Object.keys(alunos).find((k) => alunos[k][campo] === valor);
}

// Ambiente só de servidor, para os testes que não precisam de tela.
function servidor(semear) {
  const amb = criarAmbiente({ arquivos: GS, usuario: 'coord@exemplo.com' });
  amb.token = amb.api.criarSessao_('coord@exemplo.com');
  if (semear) semear(amb.api);
  amb.chamar = (f, p) => amb.api[f](Object.assign({ token: amb.token }, p || {}));
  return amb;
}

function inscricoesDe(amb) {
  const saida = [];
  amb.falso.documentos.forEach((v, k) => {
    if (k.indexOf('inscricoes/') !== 0) return;
    saida.push({
      id: k.slice('inscricoes/'.length),
      nome: v.nome && v.nome.stringValue,
      matricula: v.matricula && v.matricula.stringValue,
      projeto: v.projeto_nome && v.projeto_nome.stringValue
    });
  });
  return saida;
}

// ============================================================ A tela

grupo('o painel abre, e as oito abas desenham');

teste('a sessão guardada entra direto, sem passar pelo login', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  verdadeiro(cena.documento.getElementById('tela-login').classList.contains('oculto'),
    'a tela de login continuou visível');
  verdadeiro(!cena.documento.getElementById('tela-painel').classList.contains('oculto'),
    'o painel não apareceu');
});

teste('nenhuma aba estoura, e nenhuma fica em "Carregando..."', () => {
  const cena = abrirPainel({ semear: (api) => { cadastroBase(api); api.migrarDisciplinas(); } });
  const alvos = {
    painel: 'conteudo-painel', projetos: 'conteudo-projetos',
    disciplinas: 'conteudo-disciplinas', alunos: 'conteudo-alunos',
    lotes: 'conteudo-lotes', log: 'conteudo-log', config: 'conteudo-config'
  };

  Object.keys(alvos).forEach((aba) => {
    cena.js.trocarAba(aba);
    const texto = cena.texto(alvos[aba]);
    verdadeiro(texto.indexOf('Carregando') === -1, 'a aba ' + aba + ' ficou carregando');
    verdadeiro(texto.length > 0, 'a aba ' + aba + ' desenhou vazia');
  });
});

teste('a aba Alunos mostra as quatro fichas, com o botão Editar em cada linha', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('alunos');

  igual(idsDaTabela(cena, 'abrirEdicaoAluno').length, 4);
  igual(idsDaTabela(cena, 'abrirDetalhe').length, 4);
  verdadeiro(cena.texto('paginacao-alunos').indexOf('4 registro(s)') !== -1,
    'a paginação não contou as quatro: ' + cena.texto('paginacao-alunos'));
});

teste('voltar a uma aba já carregada não chama o servidor de novo', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('alunos');
  const antes = cena.chamadas.length;
  cena.js.trocarAba('painel');
  cena.js.trocarAba('alunos');
  igual(cena.chamadas.length, antes, 'a memória de aba parou de funcionar');
});

// ------------------------------------------------ A janela de edição do aluno

grupo('a janela de edição do aluno, clicada');

teste('a janela abre com o comparativo e os cinco campos preenchidos das FONTES', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('alunos');
  cena.js.abrirEdicaoAluno(alunoOnde(cena, 'matricula', '220002'));

  verdadeiro(/comparativo__coluna/.test(cena.html('modal-corpo')),
    'as duas colunas do comparativo não foram desenhadas');

  const valor = (id) => cena.documento.getElementById(id).value;
  igual(valor('ed-matricula'), '220002', 'a matrícula veio da inscrição');
  igual(valor('ed-nome'), 'Ana Silva', 'o nome digitado veio da inscrição');
  igual(valor('ed-nome-oficial'), 'Bruno Souza', 'o nome oficial veio da lista da secretaria');
  igual(valor('ed-turma'), 'DIR21', 'a turma veio da lista da secretaria');
  igual(valor('ed-projeto'), 'p1', 'o projeto veio da inscrição');
});

teste('o select de projetos traz a ocupação de cada um no rótulo', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('alunos');
  cena.js.abrirEdicaoAluno(alunoOnde(cena, 'matricula', '220002'));

  const rotulos = cena.documento.getElementById('ed-projeto').opcoes.map((o) => o.rotulo);
  igual(rotulos, ['Origem — 1/10', 'Lotado — 2/2 · Esgotado']);
});

teste('campo cuja FONTE não existe vem desabilitado — e não viaja no payload', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('alunos');

  // O Bruno, depois de a Ana ter tomado a matrícula dele, é SO_MATRICULADO: não
  // tem inscrição, logo não tem matrícula, nome digitado nem projeto editáveis.
  cena.js.abrirEdicaoAluno(alunoOnde(cena, 'status', 'SO_MATRICULADO'));

  const desabilitado = (id) => cena.documento.getElementById(id).disabled;
  verdadeiro(desabilitado('ed-matricula'), 'a matrícula ficou editável sem inscrição');
  verdadeiro(desabilitado('ed-nome'), 'o nome digitado ficou editável sem inscrição');
  verdadeiro(desabilitado('ed-projeto'), 'o projeto ficou editável sem inscrição');
  verdadeiro(!desabilitado('ed-nome-oficial'), 'o nome oficial devia ser editável');
  verdadeiro(!desabilitado('ed-turma'), 'a turma devia ser editável');

  const antes = cena.chamadas.length;
  cena.js.salvarEdicaoAluno();
  const chamada = cena.chamadas[antes];
  igual(chamada.funcao, 'editarAluno');
  const chaves = Object.keys(chamada.args[0]).sort();
  igual(chaves, ['id', 'nome_oficial', 'token', 'turma'],
    'campo desabilitado viajou no payload — o servidor teria de recusar o que a tela nem deixou editar');
});

teste('corrigir a matrícula pela tela move a inscrição e devolve o dono da antiga ao cadastro', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('alunos');
  cena.js.abrirEdicaoAluno(alunoOnde(cena, 'matricula', '220002'));

  cena.digitar('ed-matricula', '110001');
  cena.js.salvarEdicaoAluno();

  verdadeiro(cena.documento.getElementById('modal-fundo').classList.contains('oculto'),
    'a janela continuou aberta depois de salvar');
  verdadeiro(cena.texto('mensagem-global').indexOf('Ficha atualizada') !== -1,
    'a tela não confirmou: ' + cena.texto('mensagem-global'));

  const lista = cena.texto('conteudo-alunos');
  verdadeiro(/Ana Silva 110001/.test(lista), 'a Ana não aparece com a matrícula certa: ' + lista);
  verdadeiro(/Bruno Souza 220002/.test(lista), 'o Bruno não voltou ao cadastro: ' + lista);
});

teste('migrar pela tela conta a vaga, e a aba Projetos mostra 3 de 2', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('alunos');
  cena.js.abrirEdicaoAluno(alunoOnde(cena, 'matricula', '220002'));

  cena.digitar('ed-projeto', 'p2');
  cena.js.salvarEdicaoAluno();

  const aviso = cena.texto('mensagem-global');
  verdadeiro(aviso.indexOf('ficou com 3 de 2 vagas') !== -1,
    'a tela não disse o número verdadeiro: ' + aviso);
  verdadeiro(aviso.indexOf('passou do teto') !== -1, 'a tela não avisou do estouro: ' + aviso);

  cena.js.trocarAba('projetos');
  cena.js.carregarProjetos();
  verdadeiro(/Lotado 2 3 \/ 2 Esgotado/.test(cena.texto('conteudo-projetos')),
    'a aba Projetos não mostra 3 / 2: ' + cena.texto('conteudo-projetos'));
});

// ---------------------------------------------------------------------------
// A aba Projetos com a contagem DESLIGADA (`contar_ocupacao_na_lista` = NAO).
//
// O painel come da mesma `listarProjetos` que o site, então ele fica sem o
// número junto. O que se prova aqui é que a tela da coordenação diz isso — em
// vez de imprimir "null / 2", desenhar uma barra em 0% ou, pior, dar a entender
// que o teto de vagas parou de valer.
// ---------------------------------------------------------------------------

teste('com a contagem desligada, a aba Projetos não mostra número nenhum inventado', () => {
  const cena = abrirPainel({
    semear: (api) => {
      cadastroBase(api);
      api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
    }
  });
  cena.js.trocarAba('projetos');
  cena.js.carregarProjetos();

  const texto = cena.texto('conteudo-projetos');
  const html = cena.html('conteudo-projetos');
  // Só as LINHAS: o aviso do alto fala sobre esgotado e sobre a contagem, e é
  // no que a tabela diz que este teste manda.
  const tabela = texto.slice(texto.indexOf('# Projeto'));

  verdadeiro(/Lotado 2 — não contada/.test(tabela), 'a célula não disse que não contou: ' + tabela);
  verdadeiro(!/null/.test(html), 'o null vazou para a tela: ' + html);
  verdadeiro(!/0 \/ 2/.test(tabela), 'o projeto lotado apareceu como vazio: ' + tabela);
  verdadeiro(!/Esgotado/.test(tabela), 'sem contar, esgotado seria invenção: ' + tabela);
});

teste('e a aba avisa que a inscrição CONTINUA recusando projeto cheio', () => {
  const cena = abrirPainel({
    semear: (api) => {
      cadastroBase(api);
      api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
    }
  });
  cena.js.trocarAba('projetos');
  cena.js.carregarProjetos();

  const texto = cena.texto('conteudo-projetos');
  verdadeiro(texto.indexOf('contagem de ocupação está desligada') !== -1,
    'a coordenação não foi avisada da chave: ' + texto);
  verdadeiro(texto.indexOf('recusado no envio') !== -1,
    'sem esta frase, a tela deixa concluir que o teto de vagas caiu: ' + texto);
});

teste('o select da migração diz o total e assume não saber a ocupação', () => {
  const cena = abrirPainel({
    semear: (api) => {
      cadastroBase(api);
      api.gravarConfig('contar_ocupacao_na_lista', 'NAO');
    }
  });
  cena.js.trocarAba('alunos');
  cena.js.abrirEdicaoAluno(alunoOnde(cena, 'matricula', '220002'));

  const modal = cena.texto('modal-corpo');
  verdadeiro(/Lotado — 2 vagas, ocupação não contada/.test(modal),
    'quem migra aluno para projeto cheio precisa não ser convidado: ' + modal);
  verdadeiro(!/null/.test(cena.html('modal-corpo')), 'o null vazou para o select');
});

teste('com a contagem ligada — o padrão — a aba Projetos é a de sempre', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.carregarProjetos();

  const texto = cena.texto('conteudo-projetos');
  verdadeiro(/Lotado 2 2 \/ 2 Esgotado/.test(texto), 'a ocupação de sempre sumiu: ' + texto);
  verdadeiro(texto.indexOf('contagem de ocupação está desligada') === -1,
    'o aviso apareceu com a chave em SIM: ' + texto);
});

teste('o aviso da vizinhança da matrícula CHEGA À TELA, em amarelo', () => {
  const cena = abrirPainel({
    semear: (api) => {
      cadastroBase(api);
      // A mesma pessoa, o mesmo erro de matrícula, num segundo projeto.
      api.gravarInscricao({
        matricula: '220002', nome: 'Ana Silva', email: 'ana@exemplo.com',
        projeto_id: 'p2', projeto_nome: 'Lotado', origem: 'SITE'
      });
      api.reconciliar();
    }
  });
  cena.js.trocarAba('alunos');
  cena.js.abrirEdicaoAluno(alunoOnde(cena, 'matricula', '220002'));

  cena.digitar('ed-matricula', '110001');
  cena.js.salvarEdicaoAluno();

  const aviso = cena.texto('mensagem-global');
  verdadeiro(aviso.indexOf('continua em 1 outra(s) inscrição') !== -1,
    'a correção pela metade não apareceu na tela: ' + aviso);
  verdadeiro(/aviso--atencao/.test(cena.html('mensagem-global')),
    'o aviso não veio em amarelo: ' + cena.html('mensagem-global'));
});

teste('o botão Atualizar diz quando NÃO cruzou, em vez de recarregar calado', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('alunos');

  cena.js.atualizarAlunosUI();     // a primeira cruza (nada entrou desde a semeadura)
  cena.js.atualizarAlunosUI();     // a segunda tem de recusar, com o motivo

  const aviso = cena.texto('mensagem-global');
  verdadeiro(aviso.indexOf('nada entrou desde a última vez') !== -1,
    'o motivo de não ter cruzado não chegou à tela: ' + aviso);
  verdadeiro(cena.texto('conteudo-alunos').indexOf('Ana Silva') !== -1,
    'a lista não recarregou junto com a recusa');
});

// ------------------------------------------------------- A aba Disciplinas

grupo('a aba Disciplinas, clicada');

teste('"Adicionar linha" preserva o que já foi digitado', () => {
  const cena = abrirPainel({ semear: (api) => { cadastroBase(api); api.migrarDisciplinas(); } });
  cena.js.trocarAba('disciplinas');
  cena.js.abrirFormDisciplinas();

  cena.digitar('lote-c-0', 'MATEMÁTICA APLICADA');
  cena.digitar('lote-t-0', 'mat11');
  cena.js.adicionarLinhaDisciplina();

  igual(cena.documento.getElementById('lote-c-0').value, 'MATEMÁTICA APLICADA',
    'o innerHTML jogou fora o que estava digitado');
  igual(cena.documento.getElementById('lote-t-0').value, 'mat11');
  verdadeiro(cena.documento.getElementById('lote-c-1') !== null, 'a linha nova não apareceu');
});

teste('o "×" remove a linha certa e mantém as outras', () => {
  const cena = abrirPainel({ semear: (api) => { cadastroBase(api); api.migrarDisciplinas(); } });
  cena.js.trocarAba('disciplinas');
  cena.js.abrirFormDisciplinas();

  cena.digitar('lote-c-0', 'PRIMEIRA');
  cena.js.adicionarLinhaDisciplina();
  cena.digitar('lote-c-1', 'SEGUNDA');
  cena.js.adicionarLinhaDisciplina();
  cena.digitar('lote-c-2', 'TERCEIRA');

  cena.js.removerLinhaDisciplina(1);

  igual(cena.documento.getElementById('lote-c-0').value, 'PRIMEIRA');
  igual(cena.documento.getElementById('lote-c-1').value, 'TERCEIRA');
  igual(cena.documento.getElementById('lote-c-2'), null, 'sobrou linha a mais');
});

teste('duas disciplinas entram num clique só, e a tabela as mostra', () => {
  const cena = abrirPainel({ semear: (api) => { cadastroBase(api); api.migrarDisciplinas(); } });
  cena.js.trocarAba('disciplinas');
  cena.js.abrirFormDisciplinas();

  cena.digitar('lote-c-0', 'MATEMÁTICA');
  cena.digitar('lote-t-0', 'mat11');
  cena.digitar('lote-s-0', '1');
  cena.digitar('lote-a-0', '2026');
  cena.js.adicionarLinhaDisciplina();
  cena.digitar('lote-c-1', 'FÍSICA');
  cena.digitar('lote-t-1', 'FIS11');
  cena.digitar('lote-s-1', '2');
  cena.digitar('lote-a-1', '2026');

  cena.js.salvarDisciplinasUI();

  verdadeiro(cena.texto('mensagem-global').indexOf('2 disciplina(s) incluída(s)') !== -1,
    'a tela não confirmou as duas: ' + cena.texto('mensagem-global'));
  const tabela = cena.texto('conteudo-disciplinas');
  verdadeiro(/MATEMÁTICA MAT11 1 2026/.test(tabela), 'a turma não subiu para caixa alta: ' + tabela);
  verdadeiro(/FÍSICA FIS11 2 2026/.test(tabela), 'a segunda não apareceu: ' + tabela);
});

teste('linha incompleta não grava NADA, não fecha a janela e cola o erro na linha', () => {
  const cena = abrirPainel({ semear: (api) => { cadastroBase(api); api.migrarDisciplinas(); } });
  cena.js.trocarAba('disciplinas');
  const antes = Object.keys(cena.documentos('disciplinas')).length;

  cena.js.abrirFormDisciplinas();
  cena.digitar('lote-c-0', 'QUÍMICA');          // sem turma, sem semestre, sem ano
  cena.js.adicionarLinhaDisciplina();
  cena.digitar('lote-c-1', 'BIOLOGIA');
  cena.digitar('lote-t-1', 'BIO11');
  cena.digitar('lote-s-1', '1');
  cena.digitar('lote-a-1', '2026');

  cena.js.salvarDisciplinasUI();

  igual(Object.keys(cena.documentos('disciplinas')).length, antes,
    'gravou a linha completa e deixou o lote pela metade');
  verdadeiro(!cena.documento.getElementById('modal-fundo').classList.contains('oculto'),
    'a janela fechou e levou o que estava digitado junto');
  igual(cena.documento.getElementById('lote-c-0').value, 'QUÍMICA', 'o digitado se perdeu');
  igual(cena.documento.getElementById('lote-c-1').value, 'BIOLOGIA', 'o digitado se perdeu');
  verdadeiro(/erro-linha/.test(cena.html('lote-disciplinas')),
    'o erro não foi colado na linha que o causou');
});

teste('os filtros peneiram no navegador, sem uma ida a mais ao servidor', () => {
  const cena = abrirPainel({ semear: (api) => { cadastroBase(api); api.migrarDisciplinas(); } });
  cena.js.trocarAba('disciplinas');

  const antes = cena.chamadas.length;
  cena.digitar('filtro-disc-turma', 'ads11');
  cena.js.filtrarDisciplinas();

  igual(cena.chamadas.length, antes, 'o filtro foi ao servidor');
  const tabela = cena.texto('conteudo-disciplinas');
  verdadeiro(/ADS11/.test(tabela), 'o filtro escondeu a linha que devia mostrar');
  verdadeiro(!/ADM21/.test(tabela), 'o filtro não escondeu o resto: ' + tabela);

  cena.js.limparFiltroDisciplinas();
  verdadeiro(/ADM21/.test(cena.texto('conteudo-disciplinas')), 'limpar filtros não devolveu a lista');
});

teste('excluir disciplina com inscrito é recusado em AMARELO, não em vermelho', () => {
  const cena = abrirPainel({
    semear: (api) => {
      cadastroBase(api);
      api.migrarDisciplinas();
      // Uma inscrição escolhendo exatamente o rótulo de uma disciplina migrada.
      //
      // O texto tem a TURMA NA FRENTE porque é assim que `rotuloDisciplina_`
      // monta desde 12/08, e é o rótulo que o formulário grava em `curso_fase`.
      // Escrito com o formato antigo, a guarda de `removerDisciplina` não acharia
      // inscrição nenhuma e a disciplina seria apagada — que é exatamente o
      // estrago que trocar o formato causaria se houvesse inscrição gravada.
      api.gravarInscricao({
        matricula: '110001', nome: 'Ana Silva', email: 'ana@exemplo.com',
        projeto_id: 'p2', projeto_nome: 'Lotado', origem: 'SITE',
        curso_fase: 'ADM21 - WORK EXPERIENCE'
      });
    }
  });
  cena.js.trocarAba('disciplinas');

  const alvo = Object.keys(cena.documentos('disciplinas')).find((id) => {
    const d = cena.documentos('disciplinas')[id];
    return d.curso === 'WORK EXPERIENCE' && d.turma === 'ADM21';
  });

  const antes = Object.keys(cena.documentos('disciplinas')).length;
  cena.js.removerDisciplinaUI(alvo);

  igual(Object.keys(cena.documentos('disciplinas')).length, antes, 'apagou mesmo com inscrito');
  verdadeiro(/aviso--atencao/.test(cena.html('mensagem-global')),
    'a regra funcionando apareceu como erro: ' + cena.html('mensagem-global'));
});

// ============================================= As janelas de "Inscritos"

/**
 * As duas telas de relatório, CLICADAS.
 *
 * O cenário do `cadastroBase` já traz de graça o caso que interessa: a Ana Silva
 * está na lista oficial em ADS11 e se inscreveu digitando a matrícula do Bruno
 * (220002). Para a lista oficial de ADS11, portanto, ela FALTA — e a inscrição
 * dela aparece na turma do Bruno. É exatamente a divergência que a coordenação
 * precisa enxergar, e não uma montagem para o teste passar.
 */
grupo('as janelas de Inscritos, clicadas');

teste('o botão Inscritos da aba Projetos abre a janela com quem está no projeto', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');

  // O botão existe na linha, e é por ele que se clica.
  verdadeiro(/verInscritosProjeto\('p2'\)/.test(cena.html('conteudo-projetos')),
    'a linha do projeto não tem botão Inscritos');

  cena.js.verInscritosProjeto('p2');

  verdadeiro(janelaAberta(cena), 'a janela não abriu');

  // A tabela mora num filho da janela (`#insc-proj-tabela`), e não no corpo dela:
  // o campo de busca fica FORA da parte que se redesenha, senão cada tecla
  // digitada o destruiria junto com o cursor. No falso, `innerHTML` é uma string
  // POR elemento — ler o corpo da janela aqui devolveria só o cabeçalho.
  const corpo = cena.texto('insc-proj-tabela');
  verdadeiro(/X Um/.test(corpo), 'faltou quem está no projeto: ' + corpo);
  verdadeiro(/X Dois/.test(corpo), 'faltou quem está no projeto: ' + corpo);
  verdadeiro(!/Ana Silva/.test(corpo), 'trouxe quem está em OUTRO projeto: ' + corpo);
});

teste('a busca da janela peneira sem voltar ao servidor', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('p2');

  const antes = cena.chamadas.length;
  cena.digitar('insc-proj-busca', 'dois');
  cena.js.desenharInscritosProjeto();

  igual(cena.chamadas.length, antes, 'a busca foi ao servidor — cada volta relê o projeto inteiro');
  const corpo = cena.texto('insc-proj-tabela');
  verdadeiro(/X Dois/.test(corpo), 'a busca escondeu quem devia mostrar: ' + corpo);
  verdadeiro(!/X Um/.test(corpo), 'a busca não escondeu o resto: ' + corpo);
});

teste('projeto sem ninguém diz que está vazio — e não parece defeito', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('p1');   // só a Ana, com a matrícula errada

  // p1 tem uma inscrição; quem não tem nenhuma é um projeto novo.
  cena.js.fecharModal();
  cena.js.verInscritosProjeto('p9-inexistente');
  verdadeiro(/Recarregue a lista/.test(cena.texto('modal-corpo')) || !janelaAberta(cena),
    'projeto inexistente abriu uma janela sem explicação');
});

function comDisciplinaDaAna(api) {
  cadastroBase(api);
  const token = api.criarSessao_('coord@exemplo.com');
  api.incluirDisciplinas({
    token: token,
    linhas: [{ curso: 'PRATICA EXTENSIONISTA', turma: 'ADS11', semestre: '1', ano: '2026' }]
  });
}

function disciplinaDeTurma(cena, turma) {
  const todas = cena.documentos('disciplinas');
  return Object.keys(todas).find((id) => todas[id].turma === turma);
}

teste('a janela da disciplina abre na TURMA e mostra quem falta', () => {
  const cena = abrirPainel({ semear: comDisciplinaDaAna });
  cena.js.trocarAba('disciplinas');

  cena.js.verInscritosDisciplina(disciplinaDeTurma(cena, 'ADS11'));

  const corpo = cena.texto('disc-turma-tabela');
  verdadeiro(/Ana Silva/.test(corpo), 'a matriculada de ADS11 sumiu da tela: ' + corpo);
  // Ela se inscreveu com a matrícula do Bruno: para a lista oficial de ADS11,
  // ela não tem inscrição nenhuma. É o que a coordenação precisa ver.
  verdadeiro(/Sem projeto/.test(corpo), 'a lista de quem falta não apareceu: ' + corpo);
  verdadeiro(/documento\(s\) lido\(s\)/.test(cena.texto('disc-vista')),
    'a tela não diz quanto custou: ' + cena.texto('disc-vista'));
});

teste('o recorte "em projeto" esconde quem falta, e sem ir ao servidor', () => {
  const cena = abrirPainel({ semear: comDisciplinaDaAna });
  cena.js.trocarAba('disciplinas');
  cena.js.verInscritosDisciplina(disciplinaDeTurma(cena, 'ADS11'));

  const antes = cena.chamadas.length;
  cena.digitar('disc-turma-grupo', 'COM_PROJETO');
  cena.js.desenharTurmaDisciplina();

  igual(cena.chamadas.length, antes, 'o recorte foi ao servidor — cada volta relê as duas coleções');
  const depois = cena.texto('disc-turma-tabela');
  verdadeiro(!/Ana Silva/.test(depois),
    'o recorte "em projeto" continuou mostrando quem não está em nenhum: ' + depois);
  verdadeiro(/Ninguém desta turma está sem projeto|Ninguém neste recorte/.test(depois) ||
    depois.length > 0, 'o recorte esvaziou a tela sem dizer nada');
});

teste('a inscrição da Ana aparece na turma do Bruno — ninguém some do cruzamento', () => {
  // O outro lado da mesma divergência: a matrícula digitada é a do Bruno, então
  // é na turma DELE que a inscrição casa. As duas telas mostram a pessoa; nenhuma
  // a inventa onde ela não está.
  const cena = abrirPainel({
    semear: (api) => {
      comDisciplinaDaAna(api);
      const token = api.criarSessao_('coord@exemplo.com');
      api.incluirDisciplinas({
        token: token,
        linhas: [{ curso: 'PRATICA EXTENSIONISTA', turma: 'DIR21', semestre: '1', ano: '2026' }]
      });
    }
  });
  cena.js.trocarAba('disciplinas');
  cena.js.verInscritosDisciplina(disciplinaDeTurma(cena, 'DIR21'));

  const corpo = cena.texto('disc-turma-tabela');
  verdadeiro(/Bruno Souza/.test(corpo), 'o matriculado de DIR21 sumiu: ' + corpo);
  verdadeiro(/Em projeto/.test(corpo),
    'a inscrição gravada com a matrícula dele não casou com a turma dele: ' + corpo);
  verdadeiro(/Origem/.test(corpo), 'a tela não diz QUAL projeto: ' + corpo);
});

teste('a vista "Escolheram esta disciplina" continua respondendo pelo texto', () => {
  const cena = abrirPainel({ semear: comDisciplinaDaAna });
  cena.js.trocarAba('disciplinas');
  const id = disciplinaDeTurma(cena, 'ADS11');

  cena.js.verInscritosDisciplina(id);
  cena.js.trocarVistaDisciplina(id, 'texto');

  // Ninguém escolheu este rótulo — e isso não pode parecer defeito.
  const corpo = cena.texto('disc-vista');
  verdadeiro(/Ninguém escolheu esta disciplina ainda/.test(corpo), corpo);
});

// ================================ Largura, filtro e exportação das listas

/**
 * 18/08 — o que o professor pediu depois de usar a tela por uma semana.
 *
 * Três coisas, e as três nasceram do mesmo uso: as janelas de "Inscritos" são as
 * que ele abre para RESPONDER a alguém (a direção, a secretaria, o coordenador do
 * curso), e não para conferir um número. Daí a largura (a última coluna nascia
 * cortada), o filtro por curso e fase, e as duas exportações.
 *
 * A regra que os testes daqui mordem é uma frase: EXPORTA O QUE ESTÁ NA TELA, e o
 * arquivo DIZ qual recorte é esse. Uma exportação que ignore o filtro não parece
 * errada do outro lado — chega uma lista curta de uma turma cheia, sem nada que
 * denuncie o corte.
 */
grupo('as listas: largura, filtro e exportação');

/** A caixa da janela — é nela que a classe da largura entra e sai. */
function caixaDaJanela(cena) {
  return cena.documento.getElementById('modal-caixa');
}

/**
 * Um `window.Planilha` de mentira.
 *
 * O gerador de verdade (`docs/assets/planilha.js`) tem testes próprios e monta
 * bytes de .xlsx; o que interessa AQUI é o `spec` que chega nele — quais linhas,
 * quais colunas e o que o cabeçalho diz. Espionar é o único jeito de afirmar
 * sobre isso sem abrir um ZIP dentro do teste.
 */
function espionarPlanilha(cena) {
  const espiao = { specs: [], baixados: [] };
  cena.janela.Planilha = {
    xlsx: (spec) => { espiao.specs.push(spec); return { blobFalso: true }; },
    baixar: (blob, nome) => { espiao.baixados.push({ blob, nome }); }
  };
  return espiao;
}

/**
 * O clique no PDF com o banner CHEGANDO — o caminho feliz, e o mais comum.
 *
 * Desde o conserto da folha sem banner, o clique não imprime sozinho: ele monta
 * a folha e espera as imagens (ver `esperarImagens_`). Todo teste que fala do
 * CONTEÚDO da folha precisa, portanto, dizer o que a imagem fez — e o que ela
 * faz aqui é chegar. Os testes da espera em si não usam este atalho: eles
 * afirmam justamente o que acontece ENTRE as duas linhas.
 */
function imprimirPdf(cena, qual) {
  clicarExportar(cena, qual, 'pdf');
  cena.carregarImagens();
}

/** O botão da barra de exportação, achado pelo que a marcação diz que ele faz. */
function clicarExportar(cena, qual, formato) {
  // O Excel chama `exportar('projeto', 'excel')` e o PDF chama
  // `aoGravar(this, exportar, 'projeto', 'pdf')` — o PDF passa pelo botão que
  // trava porque ele pode ficar esperando o banner (ver `botoesDeExportacao`).
  // O `[(,]` aceita as duas formas sem deixar de exigir o par certo de
  // argumentos.
  cena.botaoQueChama(new RegExp("exportar[(,] ?'" + qual + "', '" + formato + "'")).click();
}

/**
 * O cenário do relatório de verdade: um projeto com banner e coordenação, e
 * gente de DUAS turmas diferentes — sem isso o filtro de curso e fase não tem o
 * que filtrar, e a folha impressa não tem topo para montar.
 *
 * O nome do meio é o caso real: aluno digita o que quer no formulário do site, e
 * `<` e `&` chegam inteiros ao banco (ver `formatarNome`, que arruma a caixa das
 * letras e não mexe na pontuação).
 */
function projetoParaRelatorio(api) {
  api.semearConfigPadrao_();
  api.inserir('projetos', {
    nome: 'ARTE DIGITAL FLORIPA', vagas: '60', ativo: 'SIM', inscricoes_abertas: 'SIM',
    ordem: '1', validar_matricula: 'NAO', professor: 'Prof. Mario',
    banner: 'arte-digital.jpg'
  }, 'pe');

  [
    { matricula: '2510865', nome: 'Ana Paula', curso: 'ADS11 - PRATICA EXTENSIONISTA' },
    { matricula: '2510866', nome: 'Bruno <Avila> & Cia', curso: 'ADS11 - PRATICA EXTENSIONISTA' },
    { matricula: '2510867', nome: 'Carla Dias', curso: 'DIR21 - WORK EXPERIENCE' }
  ].forEach((i) => {
    api.gravarInscricao({
      matricula: i.matricula, nome: i.nome, email: i.matricula + '@exemplo.com',
      whatsapp: '48999990000', projeto_id: 'pe', projeto_nome: 'ARTE DIGITAL FLORIPA',
      origem: 'SITE', curso_fase: i.curso
    });
  });
}

/** O mesmo cenário, sem banner — é o projeto recém-cadastrado. */
function projetoSemBanner(api) {
  projetoParaRelatorio(api);
  api.atualizar('projetos', 'pe', { banner: '' });
}

// ------------------------------------------------------------ A largura

teste('a janela de Inscritos abre larga — e a classe SOME quando ela fecha', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');

  cena.js.verInscritosProjeto('pe');
  verdadeiro(caixaDaJanela(cena).classList.contains('modal--largo'),
    'a janela de lista abriu com a largura de formulário — a última coluna nasce cortada');

  cena.js.fecharModal();
  verdadeiro(!caixaDaJanela(cena).classList.contains('modal--largo'),
    'a classe da largura ficou pendurada na caixa depois de fechar');

  // E a prova de que isso IMPORTA: a próxima janela é um formulário, e ele não
  // pode herdar 1180px de largura — campo largo separa o rótulo do que se digita.
  cena.js.abrirFormProjeto('pe');
  verdadeiro(!caixaDaJanela(cena).classList.contains('modal--largo'),
    'o formulário de projeto herdou a largura da janela de lista');
});

teste('a janela da disciplina também abre larga, e também limpa ao fechar', () => {
  const cena = abrirPainel({ semear: comDisciplinaDaAna });
  cena.js.trocarAba('disciplinas');

  cena.js.verInscritosDisciplina(disciplinaDeTurma(cena, 'ADS11'));
  verdadeiro(caixaDaJanela(cena).classList.contains('modal--largo'),
    'a janela da disciplina abriu estreita — são seis colunas');

  cena.js.fecharModal();
  verdadeiro(!caixaDaJanela(cena).classList.contains('modal--largo'),
    'a classe da largura sobreviveu ao fechamento');
});

// ------------------------------------------------- O filtro de curso e fase

teste('o filtro de curso e fase nasce do que a consulta trouxe, com "Todos" na frente', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  const html = cena.html('modal-corpo');
  verdadeiro(html.indexOf('<option value="">Todos</option>') !== -1,
    'a primeira opção deixou de ser "Todos": ' + html);
  verdadeiro(html.indexOf('ADS11 - PRATICA EXTENSIONISTA') !== -1, 'sumiu um curso e fase do filtro');
  verdadeiro(html.indexOf('DIR21 - WORK EXPERIENCE') !== -1, 'sumiu um curso e fase do filtro');

  // Ordenados, e sem repetir: duas pessoas de ADS11 são UMA opção.
  igual((html.match(/<option value="ADS11 - PRATICA EXTENSIONISTA"/g) || []).length, 1,
    'as duas pessoas de ADS11 viraram duas opções iguais no filtro');
  verdadeiro(html.indexOf('ADS11') < html.indexOf('DIR21'), 'as opções não vieram ordenadas');
});

teste('o filtro e a busca COMBINAM, e a contagem "N de M" reflete os dois', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  const antes = cena.chamadas.length;

  // Só o filtro: duas de três.
  cena.digitar('insc-proj-curso', 'ADS11 - PRATICA EXTENSIONISTA');
  cena.js.desenharInscritosProjeto();
  let corpo = cena.texto('insc-proj-tabela');
  verdadeiro(/2 de 3 na lista/.test(corpo), 'a contagem não seguiu o filtro: ' + corpo);
  verdadeiro(!/Carla Dias/.test(corpo), 'o filtro de curso e fase não escondeu a de outra turma');

  // Filtro E busca, juntos: uma de três — e é a busca que tira a segunda de ADS11.
  cena.digitar('insc-proj-busca', 'ana');
  cena.js.desenharInscritosProjeto();
  corpo = cena.texto('insc-proj-tabela');
  verdadeiro(/1 de 3 na lista/.test(corpo), 'a contagem não combinou os dois filtros: ' + corpo);
  verdadeiro(/Ana Paula/.test(corpo), 'a busca escondeu quem devia mostrar: ' + corpo);
  verdadeiro(!/Bruno/.test(corpo), 'a busca não peneirou dentro do filtro: ' + corpo);

  // A busca sozinha continua atravessando os cursos — os dois filtros são
  // independentes, e nenhum anula o outro.
  cena.digitar('insc-proj-curso', '');
  cena.digitar('insc-proj-busca', 'carla');
  cena.js.desenharInscritosProjeto();
  verdadeiro(/Carla Dias/.test(cena.texto('insc-proj-tabela')), 'limpar o filtro não devolveu a lista');

  igual(cena.chamadas.length, antes, 'peneirar foi ao servidor — cada volta relê o projeto inteiro');
});

teste('recorte sem ninguém explica o recorte, e não parece defeito', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  cena.digitar('insc-proj-curso', 'DIR21 - WORK EXPERIENCE');
  cena.digitar('insc-proj-busca', 'ana');
  cena.js.desenharInscritosProjeto();

  const corpo = cena.texto('insc-proj-tabela');
  verdadeiro(/Ninguém neste recorte/.test(corpo), corpo);
  verdadeiro(/curso e fase/.test(corpo), 'a frase não diz que há DOIS filtros em cima: ' + corpo);
});

// ------------------------------------------------------------ O Excel

teste('o Excel leva SÓ as linhas filtradas — e o cabeçalho nomeia o filtro', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  const planilha = espionarPlanilha(cena);
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  cena.digitar('insc-proj-curso', 'ADS11 - PRATICA EXTENSIONISTA');
  cena.js.desenharInscritosProjeto();
  clicarExportar(cena, 'projeto', 'excel');

  igual(planilha.specs.length, 1, 'o clique não gerou planilha nenhuma');
  const spec = planilha.specs[0];

  // A mutação que este teste existe para pegar: exportar `INSCRITOS_PROJETO.itens`
  // em vez do recorte. Sairiam três linhas, e a de fora do filtro seria a Carla.
  igual(spec.linhas.length, 2, 'a planilha levou gente que a tela não estava mostrando');
  verdadeiro(!spec.linhas.some((l) => l.nome === 'Carla Dias'),
    'a linha de fora do filtro entrou no arquivo');

  // E o cabeçalho DIZ o recorte — sem isso, a lista curta chega do outro lado
  // sem nada que denuncie que ela é um pedaço.
  const topo = spec.linhasDeTopo.join(' | ');
  verdadeiro(/Recorte:/.test(topo), 'o cabeçalho não diz que houve recorte: ' + topo);
  verdadeiro(topo.indexOf('ADS11 - PRATICA EXTENSIONISTA') !== -1,
    'o cabeçalho não NOMEIA o filtro aplicado: ' + topo);
  verdadeiro(/2 de 3/.test(topo), 'o cabeçalho não diz que 2 de 3 foram exportadas: ' + topo);

  // As colunas da tela, e o título que dá nome à folha.
  igual(spec.colunas.map((c) => c.rotulo).slice(0, 5),
    ['Matrícula', 'Nome', 'E-mail', 'WhatsApp', 'Curso e fase']);
  igual(spec.titulo, 'ARTE DIGITAL FLORIPA');
});

teste('sem filtro nenhum, o cabeçalho diz "todos" — e não cala', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  const planilha = espionarPlanilha(cena);
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  clicarExportar(cena, 'projeto', 'excel');

  const topo = planilha.specs[0].linhasDeTopo.join(' | ');
  verdadeiro(/Recorte: todos/.test(topo), 'filtro vazio virou silêncio: ' + topo);
  igual(planilha.specs[0].linhas.length, 3, 'sem filtro, a planilha tem de levar a lista inteira');
});

teste('o nome do arquivo é previsível e seguro — sem acento, sem espaço, sem barra', () => {
  const cena = abrirPainel({
    semear: (api) => {
      projetoParaRelatorio(api);
      api.atualizar('projetos', 'pe', { nome: 'Ação/Extensão — Ñoño 2026' });
    }
  });
  const planilha = espionarPlanilha(cena);
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  clicarExportar(cena, 'projeto', 'excel');

  const nome = planilha.baixados[0].nome;
  verdadeiro(/^[a-z0-9-]+\.xlsx$/.test(nome), 'o nome do arquivo saiu com acento, espaço ou barra: ' + nome);
  verdadeiro(nome.indexOf('inscritos-') === 0, 'o nome perdeu o prefixo que diz o que é: ' + nome);
  verdadeiro(nome.indexOf('acao-extensao') !== -1, 'o nome do projeto sumiu do arquivo: ' + nome);
  verdadeiro(/\d{4}-\d{2}-\d{2}\.xlsx$/.test(nome),
    'a data saiu do nome — duas exportações do mesmo projeto se atropelam: ' + nome);
});

teste('lista vazia NÃO gera arquivo, e a janela avisa', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  const planilha = espionarPlanilha(cena);
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  cena.digitar('insc-proj-busca', 'ninguem com esse nome');
  cena.js.desenharInscritosProjeto();
  clicarExportar(cena, 'projeto', 'excel');

  igual(planilha.specs.length, 0, 'gerou um .xlsx com cabeçalho e nenhuma linha');
  igual(planilha.baixados.length, 0, 'baixou um arquivo vazio');

  // O aviso vai para o rodapé DA JANELA, que é onde os olhos estão — o
  // `#mensagem-global` fica atrás dela (ver `destinoDoAviso`).
  const aviso = cena.html('mensagem-modal');
  verdadeiro(/aviso--atencao/.test(aviso), 'a recusa passou calada: ' + aviso);
  verdadeiro(/Não há nada para exportar/.test(cena.texto('mensagem-modal')),
    'o aviso não diz o que houve: ' + cena.texto('mensagem-modal'));
});

teste('o PDF de lista vazia também é recusado — a guarda é dos dois formatos', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  cena.digitar('insc-proj-busca', 'ninguem com esse nome');
  cena.js.desenharInscritosProjeto();
  clicarExportar(cena, 'projeto', 'pdf');

  igual(cena.impressoes.length, 0, 'mandou para o papel uma folha sem nenhuma linha');
});

teste('sem o planilha.js na página, o Excel recusa com mensagem — e o PDF continua', () => {
  // O arquivo é um `<script>` à parte de propósito, e este é o estado que isso
  // cria: a rede da faculdade o perde, o painel abre inteiro, e só este botão não
  // tem como funcionar. Silêncio aqui manda a pessoa clicar de novo.
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.janela.Planilha = undefined;
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  clicarExportar(cena, 'projeto', 'excel');
  verdadeiro(/aviso--erro/.test(cena.html('mensagem-modal')), 'a falta do gerador passou calada');
  verdadeiro(/planilha\.js/.test(cena.texto('mensagem-modal')),
    'a mensagem não diz ONDE se conserta: ' + cena.texto('mensagem-modal'));

  imprimirPdf(cena, 'projeto');
  igual(cena.impressoes.length, 1, 'a falta do gerador de Excel levou o PDF junto');
});

// ------------------------------------------------------------- O PDF

teste('o HTML impresso ESCAPA o nome do aluno — "<" e "&" não viram marcação', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  imprimirPdf(cena, 'projeto');

  igual(cena.impressoes.length, 1, 'o clique não mandou nada para o papel');
  const folha = cena.impressoes[0].html;

  // O nome chega ao banco assim: `formatarNome` arruma a caixa das letras e não
  // toca na pontuação, então o `<` e o `&` do formulário do site sobrevivem
  // inteiros até aqui.
  verdadeiro(folha.indexOf('Bruno &lt;avila&gt; &amp; Cia') !== -1,
    'o nome entrou na folha sem escapar — dado de aluno virando marcação: ' + folha.slice(0, 400));
  verdadeiro(folha.indexOf('<avila>') === -1, 'sobrou marcação crua vinda do nome do aluno');
});

teste('a folha impressa tem topo, cabeçalho que repete e rodapé com a origem', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  cena.digitar('insc-proj-curso', 'ADS11 - PRATICA EXTENSIONISTA');
  cena.js.desenharInscritosProjeto();
  imprimirPdf(cena, 'projeto');

  const folha = cena.impressoes[0].html;

  verdadeiro(/ARTE DIGITAL FLORIPA/.test(folha), 'o nome do projeto não está em destaque na folha');
  verdadeiro(/Prof\. Mario/.test(folha), 'a coordenação sumiu do topo');
  verdadeiro(/de 60 vagas ocupadas/.test(folha), 'a ocupação sumiu do topo');
  verdadeiro(/Recorte:/.test(folha) && folha.indexOf('ADS11 - PRATICA EXTENSIONISTA') !== -1,
    'a folha não diz qual recorte foi impresso');
  verdadeiro(/Exportado em \d{2}\/\d{2}\/\d{4}/.test(folha), 'a folha não tem data de exportação');

  // `<thead>` de verdade é o que faz o navegador repetir o cabeçalho em toda
  // página impressa — sem ele, a página 2 é uma tabela sem títulos de coluna.
  verdadeiro(/<thead><tr>/.test(folha), 'a tabela da folha perdeu o <thead>');
  verdadeiro(/Centro Universitário UNICESUSC/.test(folha), 'o rodapé com a origem sumiu');

  // E só o recorte foi para o papel.
  igual((folha.match(/<tr>/g) || []).length, 3, 'foram para o papel linhas que a tela não mostrava');
});

teste('projeto COM banner monta a imagem pelo caminho do site', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');
  imprimirPdf(cena, 'projeto');

  const folha = cena.impressoes[0].html;
  verdadeiro(folha.indexOf('src="../assets/banners/arte-digital.jpg"') !== -1,
    'o banner não resolveu pelo caminho do site: ' + folha.slice(0, 300));
});

teste('projeto SEM banner monta o topo sem imagem quebrada', () => {
  const cena = abrirPainel({ semear: projetoSemBanner });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');
  clicarExportar(cena, 'projeto', 'pdf');

  const folha = cena.impressoes[0].html;
  // Nem `<img>` nenhum, nem um `src` vazio — que é o que o navegador desenha
  // como ícone de imagem quebrada em cima do nome do projeto.
  verdadeiro(folha.indexOf('<img') === -1, 'montou uma imagem sem ter banner: ' + folha.slice(0, 300));
  verdadeiro(/ARTE DIGITAL FLORIPA/.test(folha), 'o topo sem banner perdeu o nome do projeto');
  verdadeiro(/Prof\. Mario/.test(folha), 'o topo sem banner perdeu a coordenação');
});

teste('imprimir troca a tela pela folha — e devolve tudo ao normal depois', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  imprimirPdf(cena, 'projeto');

  // DURANTE: a classe no `<body>` é o que faz o `@media print` esconder o painel
  // e o `.modal-fundo` — sem ela, a impressão sai com uma página preta (o fundo
  // escuro da janela é `position: fixed` por cima da página inteira).
  igual(cena.impressoes[0].classe, 'imprimindo', 'a folha foi impressa sem a classe que esconde a tela');

  // DEPOIS: o contêiner é fixo na marcação e sobrevive a tudo. Relatório
  // esquecido lá dentro é o que um Ctrl+P qualquer imprimiria, dias depois.
  igual(cena.html('area-impressao'), '', 'a folha ficou pendurada no contêiner de impressão');
  igual(String(cena.documento.body.className || ''), '',
    'a classe "imprimindo" ficou no body — imprimir o painel passaria a sair em branco');
});

// ----------------------------------- A espera pelo banner (o defeito de 18/08)

/**
 * O defeito, confirmado na produção: a folha saía com um RETÂNGULO VAZIO no
 * lugar do banner. Não era caminho errado — o arquivo responde 200 com 66.767
 * bytes —, era o instante: `window.print()` abria a caixa no mesmo milissegundo
 * em que o `<img>` nascia, e o navegador imprime o que existe naquele momento.
 *
 * Os testes daqui afirmam sobre o que acontece ENTRE o clique e a caixa, que é
 * onde a espera mora — e por isso nenhum deles usa o atalho `imprimirPdf`.
 */
teste('o banner que ainda não chegou SEGURA a impressão — a caixa abre no onload', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');
  cena.zerarTarefas();

  clicarExportar(cena, 'projeto', 'pdf');
  igual(cena.impressoes.length, 0,
    'a caixa de impressão abriu com o banner ainda na rede — é o defeito de 18/08 de volta');

  igual(cena.carregarImagens(), 1, 'a folha não montou o <img> do banner');
  igual(cena.impressoes.length, 1, 'o banner chegou e a impressão não saiu');
  verdadeiro(cena.impressoes[0].html.indexOf('<img') !== -1,
    'a folha esperou pela imagem e foi para o papel sem ela: ' + cena.impressoes[0].html.slice(0, 300));

  // O teto foi DESARMADO junto: esquecido, ele dispararia depois com o
  // contêiner já vazio — uma segunda caixa de impressão sobre folha nenhuma.
  igual(cena.tarefas.length, 0, 'o teto continuou armado depois de a imagem chegar');
  cena.rodarTarefas();
  igual(cena.impressoes.length, 1, 'alguma coisa mandou uma segunda folha para o papel');
});

teste('o banner que NUNCA responde não prende o botão: o teto imprime assim mesmo', () => {
  // Banner no Drive fora do ar, rede da faculdade travada. Folha sem banner é
  // muito melhor do que botão que não responde — a mesma escolha de
  // `LIMITE_DE_LEITURA_MS`.
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');
  cena.zerarTarefas();

  clicarExportar(cena, 'projeto', 'pdf');
  igual(cena.impressoes.length, 0, 'imprimiu sem dar chance nenhuma ao banner');

  // O VALOR do teto, fixado aqui de propósito: 30 segundos seriam um botão
  // morto na mão da coordenação, e zero seria não esperar.
  igual(cena.tarefas.length, 1, 'a espera pelo banner ficou SEM teto — o botão nunca voltaria');
  igual(cena.tarefas[0].ms, 3000, 'o teto da espera pelo banner mudou de valor');

  cena.rodarTarefas();
  igual(cena.impressoes.length, 1, 'o teto estourou e a folha não foi para o papel');
  igual(cena.html('area-impressao'), '', 'a folha ficou pendurada no contêiner depois do teto');
  igual(String(cena.documento.body.className || ''), '',
    'a classe "imprimindo" ficou no body depois do teto');
});

teste('o banner que FALHA sai da folha — o papel não leva ícone de imagem quebrada', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  clicarExportar(cena, 'projeto', 'pdf');
  igual(cena.falharImagens(), 1, 'a folha não montou o <img> do banner');

  igual(cena.impressoes.length, 1, 'a imagem falhou e a impressão nunca saiu');
  const folha = cena.impressoes[0].html;
  igual(folha.indexOf('<img'), -1,
    'a imagem quebrada foi para o papel — ícone de imagem quebrada em cima do nome do projeto: ' +
    folha.slice(0, 300));

  // E o topo continua inteiro sem ela, que é como `.impressao__banner` foi
  // desenhado (estilos.css) e como o projeto sem banner já saía.
  verdadeiro(/ARTE DIGITAL FLORIPA/.test(folha), 'o topo sem banner perdeu o nome do projeto');
  verdadeiro(/Prof\. Mario/.test(folha), 'o topo sem banner perdeu a coordenação');
  igual(cena.html('area-impressao'), '', 'a folha ficou pendurada depois da falha da imagem');
});

teste('disciplina não tem banner: as duas vistas imprimem na hora, sem esperar nada', () => {
  // Disciplina é disciplina, não projeto: a folha dela nasce sem `<img>` nenhum
  // (ver `relatorioTurmaDisciplina`). Um caminho que não tem o que esperar não
  // pode pagar espera nenhuma — nem um tique, nem o teto.
  const cena = abrirPainel({ semear: comEscolhaDaDisciplina });
  cena.js.trocarAba('disciplinas');
  const id = disciplinaDeTurma(cena, 'ADS11');
  cena.js.verInscritosDisciplina(id);
  cena.zerarTarefas();

  clicarExportar(cena, 'turma', 'pdf');
  igual(cena.impressoes.length, 1, 'a vista de turma esperou por uma imagem que não existe');
  igual(cena.tarefas.length, 0, 'a vista de turma armou um teto sem ter o que esperar');

  cena.js.trocarVistaDisciplina(id, 'texto');
  cena.zerarTarefas();

  clicarExportar(cena, 'escolheram', 'pdf');
  igual(cena.impressoes.length, 2, 'a vista "escolheram" esperou por uma imagem que não existe');
  igual(cena.tarefas.length, 0, 'a vista "escolheram" armou um teto sem ter o que esperar');
});

teste('o banner JÁ NO CACHE não custa espera nenhuma — o preço é pago uma vez só', () => {
  // Da segunda impressão em diante o arquivo já está no navegador: `complete`
  // com `naturalWidth` é isso, e esperar por ele seria cobrar de novo por um
  // trabalho que já foi feito.
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.imagensNascem('carregada');
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');
  cena.zerarTarefas();

  clicarExportar(cena, 'projeto', 'pdf');

  igual(cena.impressoes.length, 1, 'esperou por uma imagem que já estava pronta');
  igual(cena.tarefas.length, 0, 'armou o teto para uma imagem que já estava pronta');
  verdadeiro(cena.impressoes[0].html.indexOf('<img') !== -1, 'a folha do cache saiu sem o banner');
});

teste('o banner que o navegador já sabe quebrado sai da folha, e também sem espera', () => {
  // `complete` sem `naturalWidth` é a imagem que já resolveu, e resolveu mal.
  // Esperar por ela seria pagar o teto inteiro para no fim imprimir o ícone de
  // imagem quebrada.
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.imagensNascem('quebrada');
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');
  cena.zerarTarefas();

  clicarExportar(cena, 'projeto', 'pdf');

  igual(cena.impressoes.length, 1, 'esperou por uma imagem que o navegador já tinha desistido');
  igual(cena.tarefas.length, 0, 'armou o teto para uma imagem que já tinha falhado');
  igual(cena.impressoes[0].html.indexOf('<img'), -1,
    'a imagem quebrada do cache foi para o papel: ' + cena.impressoes[0].html.slice(0, 300));
});

teste('o botão do PDF diz que está preparando, e volta quando a caixa fecha', () => {
  // A espera pelo banner é muda por natureza: nada muda na tela entre o clique e
  // a caixa. É o mesmo "não sei se cliquei, se aceitou, se está pensando" que
  // `aoGravar` já resolve nos dezenove botões que gravam.
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  const botao = cena.botaoQueChama(/exportar, 'projeto', 'pdf'/);
  igual(botao.textContent, 'Exportar PDF');

  botao.click();
  igual(botao.textContent, 'Preparando a impressão...',
    'o botão ficou mudo esperando o banner');
  verdadeiro(botao.disabled, 'o botão continuou clicável durante a espera');

  // E o segundo clique não monta uma segunda folha por cima da que está
  // esperando — é o freio de verdade, o mesmo do Salvar.
  botao.click();
  igual(cena.carregarImagens(), 1, 'a folha não montou o <img> do banner');

  igual(cena.impressoes.length, 1, 'o clique duplo mandou duas folhas para o papel');
  igual(botao.textContent, 'Exportar PDF', 'o botão não voltou ao normal depois da impressão');
  igual(botao.disabled, false, 'o botão ficou travado depois de a caixa fechar');
});

teste('a limpeza acontece mesmo quando a CAIXA DE IMPRESSÃO estoura', () => {
  // O navegador pode recusar `print()` (caixa bloqueada, aba em segundo plano).
  // Se a limpeza morasse só no caminho feliz, a folha ficaria pendurada no
  // `#area-impressao` e a classe `imprimindo` no body — e o painel ficaria
  // invisível na impressão seguinte.
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  const botao = cena.botaoQueChama(/exportar, 'projeto', 'pdf'/);
  botao.click();
  cena.janela.print = () => { throw new Error('a caixa de impressão falhou'); };

  lancou(() => cena.carregarImagens(), 'a caixa de impressão falhou');

  igual(cena.html('area-impressao'), '', 'a folha ficou pendurada no contêiner');
  igual(String(cena.documento.body.className || ''), '', 'a classe "imprimindo" ficou no body');
  igual(botao.disabled, false, 'o botão ficou travado para sempre');
});

teste('a limpeza acontece mesmo quando a ESPERA estoura antes de imprimir', () => {
  // A espera é código como qualquer outro, e este teste fabrica a falha dela
  // pelo único lugar onde o falso consegue: a leitura das imagens da folha. O
  // que se afirma não é a falha — é que ela não deixa o relatório pendurado no
  // `#area-impressao`, que um Ctrl+P qualquer imprimiria dias depois.
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');

  cena.elemento('area-impressao').querySelectorAll = () => {
    throw new Error('a espera pelas imagens estourou');
  };

  const botao = cena.botaoQueChama(/exportar, 'projeto', 'pdf'/);
  lancou(() => botao.click(), 'a espera pelas imagens estourou');

  igual(cena.impressoes.length, 0, 'imprimiu depois de a espera estourar');
  igual(cena.html('area-impressao'), '', 'a folha ficou pendurada no contêiner');
  igual(String(cena.documento.body.className || ''), '', 'a classe "imprimindo" ficou no body');
  igual(botao.disabled, false, 'o botão ficou travado para sempre');
});

// ----------------------------------------- As outras duas tabelas de gente

teste('as TRÊS tabelas de gente têm os dois botões', () => {
  const cena = abrirPainel({ semear: projetoParaRelatorio });
  cena.js.trocarAba('projetos');
  cena.js.verInscritosProjeto('pe');
  verdadeiro(/exportar\('projeto', 'excel'\)/.test(cena.html('modal-corpo')), 'faltou o Excel na janela de projeto');
  // O PDF vai pelo `aoGravar` porque ele espera o banner — e é o `data-gravando`
  // que diz na tela o que está acontecendo enquanto a espera dura.
  verdadeiro(/aoGravar\(this, exportar, 'projeto', 'pdf'\)/.test(cena.html('modal-corpo')),
    'faltou o PDF na janela de projeto');
  verdadeiro(/data-gravando="Preparando a impressão\.\.\."/.test(cena.html('modal-corpo')),
    'o botão do PDF não diz o que está fazendo enquanto espera o banner');

  const outra = abrirPainel({ semear: comEscolhaDaDisciplina });
  outra.js.trocarAba('disciplinas');
  const id = disciplinaDeTurma(outra, 'ADS11');

  outra.js.verInscritosDisciplina(id);
  const turma = outra.html('disc-vista');
  verdadeiro(/exportar\('turma', 'excel'\)/.test(turma), 'faltou o Excel na vista de turma');
  verdadeiro(/aoGravar\(this, exportar, 'turma', 'pdf'\)/.test(turma), 'faltou o PDF na vista de turma');

  outra.js.trocarVistaDisciplina(id, 'texto');
  const texto = outra.html('disc-vista');
  verdadeiro(/exportar\('escolheram', 'excel'\)/.test(texto), 'faltou o Excel na vista "escolheram"');
  verdadeiro(/aoGravar\(this, exportar, 'escolheram', 'pdf'\)/.test(texto), 'faltou o PDF na vista "escolheram"');
});

/** A disciplina da Ana, agora COM alguém que escolheu o rótulo dela. */
function comEscolhaDaDisciplina(api) {
  comDisciplinaDaAna(api);
  api.gravarInscricao({
    matricula: '110001', nome: 'Ana Silva', email: 'ana@exemplo.com',
    projeto_id: 'p1', projeto_nome: 'Origem', origem: 'SITE',
    curso_fase: 'ADS11 - PRATICA EXTENSIONISTA (2026/1)'
  });
}

teste('a exportação da TURMA respeita o recorte, e o diz no cabeçalho', () => {
  const cena = abrirPainel({ semear: comEscolhaDaDisciplina });
  const planilha = espionarPlanilha(cena);
  cena.js.trocarAba('disciplinas');
  cena.js.verInscritosDisciplina(disciplinaDeTurma(cena, 'ADS11'));

  const todas = cena.js.TURMA_DISCIPLINA.itens.length;
  verdadeiro(todas > 0, 'o cenário não trouxe ninguém na turma');

  cena.digitar('disc-turma-grupo', 'COM_PROJETO');
  cena.js.desenharTurmaDisciplina();
  clicarExportar(cena, 'turma', 'excel');

  const spec = planilha.specs[0];
  const topo = spec.linhasDeTopo.join(' | ');
  verdadeiro(/Recorte:/.test(topo) && /Em projeto/.test(topo),
    'o cabeçalho não nomeia o recorte "em projeto": ' + topo);
  verdadeiro(spec.linhas.every((l) => l.situacao === 'Em projeto'),
    'a planilha levou quem o recorte estava escondendo: ' + JSON.stringify(spec.linhas));
  igual(spec.aba, 'Turma');
});

teste('o selo da folha impressa leva o TEXTO — não só a cor', () => {
  // Impressora preto-e-branco é o caso comum na secretaria. Um selo que só mude
  // de cor vira três bolinhas iguais no papel.
  const cena = abrirPainel({ semear: comEscolhaDaDisciplina });
  cena.js.trocarAba('disciplinas');
  cena.js.verInscritosDisciplina(disciplinaDeTurma(cena, 'ADS11'));

  clicarExportar(cena, 'turma', 'pdf');

  const folha = cena.impressoes[0].html;
  verdadeiro(/impressao__selo/.test(folha), 'a situação saiu sem selo nenhum');
  verdadeiro(/Em projeto|Sem projeto|Fora da lista/.test(folha),
    'o selo saiu sem texto — no papel só sobraria a cor: ' + folha.slice(0, 600));
});

teste('a vista "escolheram" exporta o que ela mostra, dizendo que não há recorte', () => {
  const cena = abrirPainel({ semear: comEscolhaDaDisciplina });
  const planilha = espionarPlanilha(cena);
  cena.js.trocarAba('disciplinas');
  const id = disciplinaDeTurma(cena, 'ADS11');

  cena.js.verInscritosDisciplina(id);
  cena.js.trocarVistaDisciplina(id, 'texto');
  clicarExportar(cena, 'escolheram', 'excel');

  const spec = planilha.specs[0];
  igual(spec.aba, 'Escolheram');
  igual(spec.linhas.length, 1, 'a planilha não trouxe quem escolheu o rótulo');
  igual(spec.linhas[0].nome, 'Ana Silva');
  verdadeiro(/Recorte: todos/.test(spec.linhasDeTopo.join(' | ')),
    'a vista sem filtro calou sobre o recorte: ' + spec.linhasDeTopo.join(' | '));
});

teste('trocar de vista esquece o dado da anterior — exportar não mistura as duas', () => {
  // As duas vistas respondem perguntas DIFERENTES sobre a mesma disciplina. Uma
  // memória que sobrevivesse à troca faria o botão da vista aberta exportar a
  // lista da vista fechada, e as duas têm colunas parecidas o bastante para
  // ninguém notar.
  const cena = abrirPainel({ semear: comEscolhaDaDisciplina });
  cena.js.trocarAba('disciplinas');
  const id = disciplinaDeTurma(cena, 'ADS11');

  cena.js.verInscritosDisciplina(id);
  verdadeiro(cena.js.TURMA_DISCIPLINA !== null, 'a vista de turma não guardou o que trouxe');
  igual(cena.js.ESCOLHERAM_DISCIPLINA, null, 'a vista de turma encheu a memória da outra');

  cena.js.trocarVistaDisciplina(id, 'texto');
  igual(cena.js.TURMA_DISCIPLINA, null, 'a memória da turma sobreviveu à troca de vista');
  verdadeiro(cena.js.ESCOLHERAM_DISCIPLINA !== null, 'a vista "escolheram" não guardou o que trouxe');

  // A volta é o caminho que esquecer não perdoa: a vista de turma pode abrir numa
  // RECUSA (turma que não casa com a lista oficial), e aí ninguém sobrescreve a
  // memória da outra — ela ficaria pendurada, falando de uma tabela que saiu da
  // tela. É por isso que quem esquece é a TROCA, e não o carregamento.
  cena.js.trocarVistaDisciplina(id, 'turma');
  igual(cena.js.ESCOLHERAM_DISCIPLINA, null,
    'a lista de "escolheram" sobreviveu à volta para a vista de turma');
});

// ======================================= A janela não leva o trabalho embora

/**
 * O QUE ESTE BLOCO PROTEGE, e por que ele nasceu com data.
 *
 * Em 11/08, cadastrando projetos para o evento de sexta, a coordenação relatou
 * duas coisas. A primeira: um clique desatento no fundo escuro fechava a janela e
 * jogava fora o cadastro inteiro — sem pergunta, sem volta, sem rascunho. O
 * `#modal-fundo` é UM só, compartilhado por sete formulários, então o conserto
 * teve de valer para os sete de uma vez.
 *
 * A guarda não pergunta sempre: ela lê a janela que está na tela e só se
 * interpõe quando há trabalho lá dentro (ver `modalTemTrabalho`, no painel). É o
 * que separa o formulário de cadastro da janela que só mostra a lista de
 * inscritos — perguntar naquela seria o atrito que ensina a confirmar sem ler.
 *
 * Os testes daqui CLICAM: o fundo é clicado com o alvo que o navegador põe no
 * evento, e o Esc entra pelo ouvinte do documento.
 */
grupo('clicar no fundo (e o Esc) não podem levar o cadastro embora');

/** O clique que fecha: o alvo é o próprio fundo, e não algo dentro da janela. */
function clicarNoFundo(cena) {
  const fundo = cena.documento.getElementById('modal-fundo');
  return fundo.disparar('click', { target: fundo });
}

function janelaAberta(cena) {
  return !cena.documento.getElementById('modal-fundo').classList.contains('oculto');
}

/** O botão Salvar da janela — o mesmo id em todas, porque só há uma por vez. */
function botaoSalvar(cena) {
  const botao = cena.documento.getElementById('modal-salvar');
  if (!botao) throw new Error('a janela aberta não desenhou botão de salvar');
  return botao;
}

/** Quantas requisições desta função saíram pela rede. */
function requisicoesDe(cena, fn) {
  return cena.requisicoesHttp.filter((r) => JSON.parse(r.corpo).fn === fn);
}

/** O formulário de projeto aberto, com dois campos preenchidos. */
function formularioDeProjetoPreenchido(cena) {
  cena.js.trocarAba('projetos');
  cena.js.abrirFormProjeto();
  cena.digitar('pj-nome', 'Robótica na praça');
  cena.digitar('pj-vagas', '35');
}

teste('com o formulário preenchido, o clique no fundo NÃO fecha e não apaga nada', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);

  cena.respostaConfirm = false;      // "não, ainda estou preenchendo"
  clicarNoFundo(cena);

  verdadeiro(janelaAberta(cena), 'o clique no fundo fechou a janela com o cadastro dentro');
  igual(cena.documento.getElementById('pj-nome').value, 'Robótica na praça',
    'o que estava digitado se perdeu');
  igual(cena.documento.getElementById('pj-vagas').value, '35');
  igual(cena.confirmacoes.length, 1, 'a janela sumiu sem perguntar nada');
});

teste('quem confirma o descarte fecha — a pergunta é uma saída, não uma prisão', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);

  cena.respostaConfirm = true;
  clicarNoFundo(cena);

  verdadeiro(!janelaAberta(cena), 'quem disse que queria descartar continuou preso na janela');
});

teste('janela que só mostra informação continua fechando na hora, sem perguntar', () => {
  // A de "Inscritos em..." não tem campo nenhum: o rodapé dela é um botão
  // "Fechar" e mais nada. Perguntar ali seria atrito à toa.
  const cena = abrirPainel({ semear: (api) => { cadastroBase(api); api.migrarDisciplinas(); } });
  cena.js.trocarAba('disciplinas');
  cena.js.verInscritosDisciplina(Object.keys(cena.documentos('disciplinas'))[0]);
  verdadeiro(janelaAberta(cena), 'a janela de inscritos não abriu');

  clicarNoFundo(cena);

  verdadeiro(!janelaAberta(cena), 'a janela de informação deixou de fechar no clique no fundo');
  igual(cena.confirmacoes, [], 'perguntou onde não havia nada a perder');
});

teste('formulário aberto e não tocado também fecha na hora', () => {
  // Abrir "Novo projeto" e desistir sem digitar não é trabalho nenhum — e uma
  // pergunta aqui seria o atrito que ensina a confirmar no automático.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.abrirFormProjeto();

  clicarNoFundo(cena);

  verdadeiro(!janelaAberta(cena), 'a janela intocada não fechou');
  igual(cena.confirmacoes, [], 'perguntou sobre um formulário em que ninguém mexeu');
});

teste('o que foi digitado ANTES de a tabela ser redesenhada continua segurando a janela', () => {
  // O caso que uma comparação com a marcação não pegaria: "Adicionar linha"
  // reescreve a tabela inteira, e o que foi digitado vira `value=` da marcação
  // NOVA. Depois disso, "está diferente do que a janela desenhou?" responderia
  // "não" sobre uma linha preenchida — e o clique no fundo a levaria embora.
  const cena = abrirPainel({ semear: (api) => { cadastroBase(api); api.migrarDisciplinas(); } });
  cena.js.trocarAba('disciplinas');
  cena.js.abrirFormDisciplinas();

  cena.digitar('lote-c-0', 'MATEMÁTICA APLICADA');
  cena.digitar('lote-t-0', 'MAT11');
  cena.js.adicionarLinhaDisciplina();

  cena.respostaConfirm = false;
  clicarNoFundo(cena);

  verdadeiro(janelaAberta(cena), 'o lote de disciplinas foi embora no clique no fundo');
  igual(cena.documento.getElementById('lote-c-0').value, 'MATEMÁTICA APLICADA');
});

teste('campo mudado sem teclado — o banner escolhido — também segura a janela', () => {
  // O outro lado da regra: escolher um banner grava o arquivo num campo
  // escondido, por código. Evento de digitação nenhum nasce daí, e é a
  // comparação com o que a janela desenhou que percebe.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.abrirFormProjeto();

  cena.js.definirBanner('capa-2026.jpg');    // o que o clique na galeria faz

  cena.respostaConfirm = false;
  clicarNoFundo(cena);

  verdadeiro(janelaAberta(cena), 'a escolha do banner foi descartada em silêncio');
  igual(cena.documento.getElementById('pj-banner').value, 'capa-2026.jpg');
});

teste('clicar DENTRO da janela não fecha coisa nenhuma — quem decide é o alvo', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);

  // No navegador o clique num campo SOBE até o fundo, e é lá que o ouvinte está.
  // O que separa um do outro é o alvo do evento.
  cena.documento.getElementById('modal-fundo')
    .disparar('click', { target: cena.elemento('modal-corpo') });

  verdadeiro(janelaAberta(cena), 'clicar dentro da janela fechou a janela');
  igual(cena.confirmacoes, [], 'perguntou por um clique que era só um clique no formulário');
});

teste('o Esc passa pela MESMA guarda do clique no fundo', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);

  cena.respostaConfirm = false;
  cena.teclar('Escape');
  verdadeiro(janelaAberta(cena), 'o Esc fechou a janela com o cadastro dentro');
  igual(cena.documento.getElementById('pj-nome').value, 'Robótica na praça');

  cena.respostaConfirm = true;
  cena.teclar('Escape');
  verdadeiro(!janelaAberta(cena), 'o Esc deixou de fechar depois de confirmado o descarte');
});

teste('o Esc fecha o seletor de banner que está POR CIMA, e não o formulário debaixo', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);
  cena.js.abrirSeletorBanner();

  cena.teclar('Escape');

  verdadeiro(cena.elemento('modal-banner').classList.contains('oculto'),
    'o seletor de banner não fechou');
  verdadeiro(janelaAberta(cena), 'o Esc atravessou o seletor e levou o formulário junto');
  igual(cena.confirmacoes, [], 'perguntou por causa de uma janela que nem era a de baixo');
});

teste('o Esc sem janela aberta não faz nada', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.teclar('Escape');
  verdadeiro(!janelaAberta(cena), 'o Esc abriu alguma coisa');
  igual(cena.confirmacoes, [], 'perguntou sobre uma janela que não estava na tela');
});

teste('"Cancelar" e "×" continuam fechando direto — quem mira neles já decidiu', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);

  cena.js.fecharModal();

  verdadeiro(!janelaAberta(cena), 'o Cancelar deixou de fechar');
  igual(cena.confirmacoes, [], 'passou a perguntar em cima de um clique deliberado');
});

// ==================================== O botão Salvar dá sinal de vida

/**
 * "Não consigo saber se cliquei, se aceitou, se está pensando."
 *
 * A segunda coisa relatada em 11/08, sobre os sete botões Salvar. As chamadas ao
 * servidor levam de 2 a 4 segundos (medidos na produção no mesmo dia), e nesse
 * tempo o botão não mudava de aparência, não recusava um segundo clique e não
 * dizia nada. O segundo clique mandava a requisição de novo — em `salvarProjeto`,
 * isso é gravar duas vezes.
 *
 * O conserto é um envelope só, `aoGravar(this, ...)`, com o botão devolvido em
 * `chamar()`. Os testes daqui clicam no botão de verdade, com a marcação de
 * verdade: um `onclick` com o nome errado falha aqui, e não no dedo de quem está
 * cadastrando.
 */
// ================================================================================
//
// O texto que o professor escreve para o aluno ler ANTES de preencher. São dois
// campos de texto na mesma janela, e eles vão para dois lugares diferentes da
// tela do aluno: `descricao` acima do formulário, `descricao_formulario` dentro
// dele. Trocá-los não daria erro nenhum — daria a orientação no lugar da chamada,
// e o aluno lendo "o primeiro encontro é dia 21/08" antes de decidir se entra.

grupo('a orientação do formulário, do painel até o projeto gravado');

/** O projeto recém-gravado, achado pelo nome. */
function projetoChamado(cena, nome) {
  const todos = cena.documentos('projetos');
  const achado = Object.keys(todos).filter((id) => todos[id].nome === nome)[0];
  if (!achado) throw new Error('não achei o projeto "' + nome + '" no banco');
  return { id: achado, campos: todos[achado] };
}

teste('a janela tem os DOIS campos, e a dica diz onde cada um aparece', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.abrirFormProjeto();

  const corpo = cena.html('modal-corpo');
  verdadeiro(/id="pj-descricao"/.test(corpo), 'o campo da descrição sumiu da janela');
  verdadeiro(/id="pj-descricao-formulario"/.test(corpo), 'o campo da orientação não está na janela');
  verdadeiro(/DENTRO do formul/.test(corpo),
    'a dica não diz que este texto aparece dentro do formulário: ' + corpo);
});

teste('o que a coordenação escreve chega ao projeto gravado', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.abrirFormProjeto();

  cena.digitar('pj-nome', 'Arte Digital Floripa');
  cena.digitar('pj-descricao', 'Oficinas de arte digital para a comunidade.');
  cena.digitar('pj-descricao-formulario',
    'Preencha os dados solicitados.\nO primeiro encontro acontece em 21/08/2026, na sala 225.');
  cena.documento.getElementById('modal-salvar').click();

  const projeto = projetoChamado(cena, 'Arte Digital Floripa');
  igual(projeto.campos.descricao, 'Oficinas de arte digital para a comunidade.');
  verdadeiro(/sala 225/.test(projeto.campos.descricao_formulario),
    'a orientação não foi gravada: ' + projeto.campos.descricao_formulario);
  verdadeiro(/\n/.test(projeto.campos.descricao_formulario),
    'a quebra de linha do professor se perdeu entre a janela e o banco');
});

teste('e reabrir a edição traz o texto de volta no campo', () => {
  // A volta é o que impede o defeito silencioso: se `listarProjetos` não
  // devolvesse o campo, ele viria vazio aqui — e o próximo Salvar gravaria vazio
  // por cima do texto que o professor escreveu.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.abrirFormProjeto();
  cena.digitar('pj-nome', 'Arte Digital Floripa');
  cena.digitar('pj-descricao-formulario', 'Leia com atenção antes de preencher.');
  cena.documento.getElementById('modal-salvar').click();

  const projeto = projetoChamado(cena, 'Arte Digital Floripa');
  cena.js.abrirFormProjeto(projeto.id);

  igual(cena.documento.getElementById('pj-descricao-formulario').value,
    'Leia com atenção antes de preencher.');
});

grupo('o botão Salvar, enquanto o servidor não responde');

teste('enquanto espera, o botão diz que está gravando e não aceita mais clique', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);

  cena.respostas.salvarProjeto = semResposta();   // os 2 a 4 segundos da produção
  const botao = botaoSalvar(cena);
  igual(botao.textContent, 'Salvar', 'o botão não nasceu com o rótulo que a tela mostra');

  botao.click();

  igual(botao.textContent, 'Salvando…', 'a espera continuou muda');
  verdadeiro(botao.disabled, 'o botão seguiu clicável no meio da gravação');
  igual(botao.getAttribute('aria-busy'), 'true', 'quem usa leitor de tela não soube da espera');
  igual(requisicoesDe(cena, 'salvarProjeto').length, 1);
});

teste('dois cliques no Salvar mandam UMA requisição só', () => {
  // O mais importante do lote. Duas requisições de `salvarProjeto` são dois
  // projetos gravados — e ninguém olhando a tela saberia dizer qual das duas.
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);
  cena.respostas.salvarProjeto = semResposta();

  const botao = botaoSalvar(cena);
  botao.click();
  botao.click();

  igual(requisicoesDe(cena, 'salvarProjeto').length, 1,
    'A REQUISIÇÃO SAIU DUAS VEZES — em salvarProjeto isso grava duas');

  // E nem por código: o freio do navegador (botão desabilitado não dispara
  // clique) tem um segundo atrás dele, para quem chegar por outro caminho.
  cena.js.aoGravar(botao, cena.js.salvarProjetoUI, null);
  igual(requisicoesDe(cena, 'salvarProjeto').length, 1,
    'o envelope aceitou uma segunda gravação com a primeira ainda em voo');
});

teste('falha de rede devolve o botão ao normal, com o erro à vista e a janela aberta', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);
  cena.respostas.salvarProjeto = null;        // a requisição morre na rede

  const botao = botaoSalvar(cena);
  botao.click();

  igual(botao.textContent, 'Salvar', 'o botão ficou preso em "Salvando…" para sempre');
  verdadeiro(!botao.disabled, 'o botão ficou travado e sem explicação nenhuma');
  igual(botao.getAttribute('aria-busy'), null, 'a tela continuou dizendo que está gravando');
  // DENTRO da janela: ela está aberta por cima do painel, e um erro escrito lá
  // atrás é um erro que ninguém lê — ver o grupo "o erro aparece onde os olhos
  // estão", mais abaixo, e o incidente de 12/08.
  verdadeiro(cena.texto('mensagem-modal').indexOf('Erro em "salvarProjeto"') !== -1,
    'a falha não chegou à janela: ' + cena.texto('mensagem-modal'));

  verdadeiro(janelaAberta(cena), 'a janela fechou e levou o cadastro junto com o erro');
  igual(cena.documento.getElementById('pj-nome').value, 'Robótica na praça');

  // O relógio andando não traz a segunda: gravação não é repetida (SO_LEITURA).
  cena.rodarTarefas(3);
  igual(requisicoesDe(cena, 'salvarProjeto').length, 1, 'a escrita foi repetida sozinha');
});

teste('recusa do servidor devolve o botão e deixa o formulário como estava', () => {
  // A recusa não é falha de rede: o servidor respondeu, e a janela CONTINUA
  // aberta para a correção. Um botão travado aqui seria um cadastro sem saída.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.abrirFormProjeto();                 // sem nome, o servidor recusa

  const botao = botaoSalvar(cena);
  botao.click();

  verdadeiro(janelaAberta(cena), 'a janela fechou em cima de uma recusa');
  igual(botao.textContent, 'Salvar', 'o botão ficou preso depois da recusa');
  verdadeiro(!botao.disabled, 'não dá para corrigir e salvar de novo com o botão travado');
  verdadeiro(cena.texto('mensagem-modal').indexOf('Informe o nome') !== -1,
    'a recusa não chegou à janela, que é onde o formulário está: ' + cena.texto('mensagem-modal'));
});

teste('a gravação que dá certo fecha a janela e grava UMA vez', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  const antes = Object.keys(cena.documentos('projetos')).length;
  formularioDeProjetoPreenchido(cena);

  botaoSalvar(cena).click();

  verdadeiro(!janelaAberta(cena), 'a janela ficou aberta depois de gravar');
  igual(Object.keys(cena.documentos('projetos')).length, antes + 1,
    'gravou uma vez a mais, ou nenhuma');
  verdadeiro(cena.texto('mensagem-global').indexOf('Projeto criado') !== -1,
    cena.texto('mensagem-global'));
});

teste('gravação que nem chega a sair não deixa o botão travado', () => {
  // Uma validação que recusa ANTES de falar com o servidor: nenhuma requisição
  // sai, e ninguém adota o botão. Sem o destravamento no fim do envelope, ele
  // ficaria "Salvando…" esperando uma resposta que nunca foi pedida.
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);
  const botao = botaoSalvar(cena);

  cena.js.aoGravar(botao, function () {});

  igual(botao.textContent, 'Salvar', 'o botão ficou travado sem requisição nenhuma em voo');
  verdadeiro(!botao.disabled);
  igual(requisicoesDe(cena, 'salvarProjeto').length, 0);
});

teste('as seis janelas que gravam desenham o MESMO botão, e ele passa pelo envelope', () => {
  const cena = abrirPainel({ semear: (api) => { cadastroBase(api); api.migrarDisciplinas(); } });
  cena.js.trocarAba('disciplinas');
  const idDisciplina = Object.keys(cena.documentos('disciplinas'))[0];
  cena.js.trocarAba('alunos');
  const idAluno = Object.keys(cena.documentos('alunos'))[0];

  const janelas = [
    ['novo projeto', () => cena.js.abrirFormProjeto(), 'salvarProjetoUI'],
    ['incluir disciplinas', () => cena.js.abrirFormDisciplinas(), 'salvarDisciplinasUI'],
    ['editar disciplina', () => cena.js.abrirEdicaoDisciplina(idDisciplina), 'salvarEdicaoDisciplinaUI'],
    ['editar aluno', () => cena.js.abrirEdicaoAluno(idAluno), 'salvarEdicaoAluno'],
    ['revisão do aluno', () => cena.js.abrirDetalhe(idAluno), 'salvarRevisao']
  ];

  janelas.forEach(function (janela) {
    janela[1]();
    const onclick = botaoSalvar(cena).getAttribute('onclick');
    igual(onclick.indexOf('aoGravar(this, ' + janela[2]), 0,
      'a janela "' + janela[0] + '" grava por fora do envelope: ' + onclick);
    cena.js.fecharModal();
  });
});

teste('a janela da coringa também, e ela é a única com outra origem', () => {
  // Fora do laço acima porque só abre onde NÃO existe coringa ativa — e
  // `migrarDisciplinas` cria uma.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('disciplinas');
  cena.js.abrirFormCoringa();

  igual(botaoSalvar(cena).getAttribute('onclick').indexOf('aoGravar(this, salvarCoringaUI'), 0,
    'a coringa grava por fora do envelope');
});

teste('o Salvar de cada parâmetro da aba Configurações também dá sinal de vida', () => {
  // O único Salvar fora da janela, e há vários na tela ao mesmo tempo: cada um
  // tem de travar sozinho, sem levar os outros junto.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('config');
  cena.respostas.salvarConfiguracao = semResposta();

  const botao = cena.documento.getElementById('salvar-cfg-vagas_padrao');
  verdadeiro(botao !== null, 'o botão de salvar o parâmetro sumiu da aba Configurações');
  botao.click();

  igual(botao.textContent, 'Salvando…');
  verdadeiro(botao.disabled);
  igual(requisicoesDe(cena, 'salvarConfiguracao').length, 1);

  botao.click();
  igual(requisicoesDe(cena, 'salvarConfiguracao').length, 1,
    'dois cliques mandaram duas gravações do mesmo parâmetro');
});

// ================================== O balão de erro não gruda entre abas

/**
 * "O balão com o erro fica ali e não sai mais, mesmo quando troco de abas...
 * acaba incomodando na visualização" — coordenação, 12/08.
 *
 * `avisar()` só se apaga sozinho no sucesso. O erro ficava para sempre, e o
 * problema não é ele durar: é ele atravessar a troca de aba. Ele descreve o que
 * aconteceu na aba anterior, e na nova acusa um problema que não existe ali.
 *
 * O que NÃO pode ser levado junto está testado aqui do lado: a nota de
 * retentativa (que fala de uma requisição ainda em voo) e a confirmação de uma
 * gravação (que vale para o sistema inteiro, e não para a aba).
 */
grupo('o erro morre ao trocar de aba — e só ele');

teste('o erro de uma aba não atravessa para a seguinte', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.respostas.listarDisciplinas = { ok: false, erro: 'Não consegui ler as disciplinas.' };

  cena.js.trocarAba('disciplinas');
  cena.js.avisar('erro', 'Não consegui ler as disciplinas.');
  verdadeiro(cena.texto('mensagem-global').indexOf('Não consegui ler') !== -1,
    'o erro nem chegou a aparecer');

  cena.js.trocarAba('alunos');

  igual(cena.texto('mensagem-global'), '',
    'o erro da aba anterior continua na tela: ' + cena.texto('mensagem-global'));
});

teste('o erro FICA enquanto a pessoa continua na aba onde ele aconteceu', () => {
  // Some antes de ser lido é pior do que ficar. Recarregar a mesma aba não é
  // troca de aba nenhuma.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.avisar('erro', 'Falha ao salvar.');

  cena.js.carregarProjetos();

  verdadeiro(cena.texto('mensagem-global').indexOf('Falha ao salvar') !== -1,
    'o erro sumiu sem a pessoa ter saído da aba');
});

teste('trocar de aba não engole a confirmação de uma gravação', () => {
  // O caminho existe: salvar um projeto escreve "Projeto criado." e a pessoa
  // clica na aba seguinte em seguida. A confirmação vale para o sistema, não
  // para a aba — e ela já se apaga sozinha em 6 s.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.abrirFormProjeto();
  cena.digitar('pj-nome', 'Robótica na praça');
  cena.documento.getElementById('modal-salvar').click();

  verdadeiro(cena.texto('mensagem-global').indexOf('Projeto criado') !== -1,
    'a gravação não confirmou nada: ' + cena.texto('mensagem-global'));

  cena.js.trocarAba('alunos');

  verdadeiro(cena.texto('mensagem-global').indexOf('Projeto criado') !== -1,
    'a troca de aba engoliu a confirmação da gravação');
});

teste('trocar de aba no meio de uma retentativa não apaga o "Tentando de novo"', () => {
  // A nota mora no mesmo elemento e fala de uma requisição que AINDA está em
  // voo — quem a apaga é a resposta, quando ela chega.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.respostas.listarLog = () => {
    delete cena.respostas.listarLog;
    return null;                       // a rede cai na primeira tentativa
  };

  cena.js.trocarAba('log');
  verdadeiro(cena.texto('mensagem-global').indexOf('Tentando de novo') !== -1,
    'a nota de retentativa nem apareceu: ' + cena.texto('mensagem-global'));

  cena.js.trocarAba('alunos');
  verdadeiro(cena.texto('mensagem-global').indexOf('Tentando de novo') !== -1,
    'a troca de aba deixou a espera muda no meio da retentativa');

  cena.rodarTarefas();
  igual(cena.texto('mensagem-global'), '', 'a nota ficou na tela depois da resposta');
});

// ============================== Todo botão que grava, e não só os de Salvar

/**
 * O QUE ESTE BLOCO PROTEGE, e o dia em que ele deixou de ser hipótese.
 *
 * Os sete botões Salvar ganharam freio em 11/08. No mesmo dia, mais tarde, a
 * coordenação tentou subir a lista oficial e levou `Failed to fetch` na
 * importação — o botão "Importando..." ficou desabilitado para sempre, porque
 * `confirmarImportacaoUI` travava à mão e destravava dentro do callback de
 * SUCESSO. A saída era recarregar a página, e recarregar joga fora o mapeamento
 * das colunas que a pessoa acabou de fazer. Ela conseguiu na segunda tentativa;
 * o evento é sexta, e essa é a tela que sobe a lista.
 *
 * A partir daqui TODA função que grava passa pelo mesmo envelope: as sete de
 * salvar, as duas da importação, as de ligar/desligar e apagar (que vivem dentro
 * de linhas de tabela redesenhadas pela própria resposta), as da lista de acesso,
 * as duas mais caras do sistema (reconciliar e sincronizar) e a exportação, que
 * grava uma linha na trilha de auditoria.
 *
 * O laço abaixo é o mesmo par de perguntas para cada um: dois cliques mandam UMA
 * requisição, e a falha do servidor devolve o botão. Escrever os dois à mão vinte
 * e seis vezes seria a mesma coisa com mais chance de esquecer um.
 */
grupo('todo botão que grava: freio no clique duplo, e volta quando falha');

/**
 * O erro que a pessoa está VENDO — no painel, no login ou dentro da janela.
 *
 * São quatro lugares possíveis porque o aviso vai para a tela que está na frente
 * (ver `destinoDoAviso`, no painel). Cada um só entra na conta quando está
 * visível: o `#mensagem-modal` de uma janela fechada existe no HTML e ninguém o
 * lê, e um teste que o contasse ficaria verde com o erro escondido — que é
 * exatamente o defeito de 12/08.
 *
 * ONDE o erro aparece é assunto do grupo "o erro aparece onde os olhos estão".
 * Aqui a pergunta é outra: a falha chegou a ALGUMA tela?
 */
function erroNaTela(cena) {
  const visivel = (id, dono) => {
    const janela = cena.documento.getElementById(dono);
    return janela && !janela.classList.contains('oculto') ? cena.texto(id) : '';
  };
  return [
    cena.texto('mensagem-global'),
    visivel('erro-login', 'erro-login'),
    visivel('mensagem-modal', 'modal-fundo'),
    visivel('status-banner', 'modal-banner')
  ].join(' ');
}

/** O passo 2 da importação, montado pela própria tela a partir de uma análise. */
function importacaoMapeada(cena, mapeamento) {
  const analise = {
    ok: true, tempId: 't1', arquivo: 'lista.xlsx', tipo: 'xlsx', totalLinhas: 2,
    cabecalhos: ['Matrícula', 'Nome', 'Turma'],
    amostra: [['110001', 'Ana Silva', 'ADS11']],
    mapeamento: mapeamento || { matricula: 0, nome: 1, turma: 2 }
  };
  cena.js.trocarAba('importar');
  cena.js.IMPORTACAO = analise;
  cena.js.montarPasso2(analise);
  return analise;
}

function semearComLote(api) {
  cadastroBase(api);
  api.inserir('lotes', {
    lote_id: 'L1', arquivo: 'lista.xlsx', tipo: 'xlsx', linhas: '2',
    importado_em: '01/08/2026', importado_por: 'coord@exemplo.com', status: 'OK'
  }, 'L1');
}

function semearComDisciplinas(api) {
  cadastroBase(api);
  api.migrarDisciplinas();
}

/** Duas pessoas na allowlist: dá para remover a OUTRA, sem cair no autologout. */
function semearComDoisAdmins(api) {
  cadastroBase(api);
  api.gravarConfig('admin_emails', 'coord@exemplo.com,outro@exemplo.com');
}

/**
 * Cada botão que grava, e como chegar até ele.
 *
 * Os que vivem em linha de tabela não têm id — são achados pelo que a marcação
 * diz que eles fazem (`cena.botaoQueChama`), que é a mesma coisa que estes testes
 * querem afirmar.
 */
const BOTOES_QUE_GRAVAM = [
  {
    nome: 'Inativar projeto', servidor: 'salvarProjeto',
    montar: (cena) => { cena.js.trocarAba('projetos'); return cena.botaoQueChama(/alternarProjetoUI/); }
  },
  {
    nome: 'Remover projeto', servidor: 'removerProjeto',
    montar: (cena) => { cena.js.trocarAba('projetos'); return cena.botaoQueChama(/removerProjetoUI/); }
  },
  {
    nome: 'Inativar disciplina', servidor: 'alternarDisciplina', semear: semearComDisciplinas,
    montar: (cena) => { cena.js.trocarAba('disciplinas'); return cena.botaoQueChama(/alternarDisciplinaUI/); }
  },
  {
    nome: 'Excluir disciplina', servidor: 'removerDisciplina', semear: semearComDisciplinas,
    montar: (cena) => { cena.js.trocarAba('disciplinas'); return cena.botaoQueChama(/removerDisciplinaUI/); }
  },
  {
    nome: 'Incluir acesso', servidor: 'incluirAdmin',
    montar: (cena) => {
      cena.js.trocarAba('config');
      cena.digitar('acesso-novo', 'novo@exemplo.com');
      return cena.botaoQueChama(/incluirAcesso/);
    }
  },
  {
    nome: 'Remover acesso', servidor: 'removerAdmin', semear: semearComDoisAdmins,
    montar: (cena) => {
      cena.js.trocarAba('config');
      return cena.botaoQueChama(/removerAcesso, 'outro@exemplo\.com'/);
    }
  },
  {
    nome: 'Apagar matriculados', servidor: 'expurgarLote', semear: semearComLote,
    montar: (cena) => { cena.js.trocarAba('lotes'); return cena.botaoQueChama(/expurgarLoteUI/); }
  },
  {
    nome: 'Reconciliar agora', servidor: 'rodarReconciliacao',
    montar: (cena) => cena.elemento('botao-reconciliar')
  },
  {
    nome: 'Sincronizar respostas do Forms', servidor: 'sincronizarForms',
    montar: (cena) => cena.elemento('botao-sincronizar')
  },
  {
    nome: 'Exportar CSV', servidor: 'exportarCsv',
    montar: (cena) => { cena.js.trocarAba('alunos'); return cena.elemento('botao-exportar'); }
  },
  {
    nome: 'Sair', servidor: 'sair',
    montar: (cena) => cena.elemento('botao-sair')
  },
  {
    nome: 'Confirmar importação', servidor: 'confirmarImportacao',
    montar: (cena) => { importacaoMapeada(cena); return cena.elemento('botao-confirmar'); }
  },
  {
    // O segundo botão que travava para sempre. Ele nasce DENTRO da resposta da
    // importação, e é o último passo antes de a lista oficial valer na tela.
    nome: 'Reconciliar depois de importar', servidor: 'rodarReconciliacao',
    montar: (cena) => {
      importacaoMapeada(cena);
      cena.respostas.confirmarImportacao = { ok: true, importadas: 2, ignoradas: 0 };
      cena.elemento('botao-confirmar').click();
      delete cena.respostas.confirmarImportacao;
      return cena.elemento('botao-reconciliar-pos');
    }
  },
  {
    nome: 'Escolher banner', servidor: 'listarBanners',
    montar: (cena) => {
      cena.js.trocarAba('projetos');
      cena.js.abrirFormProjeto();
      return cena.botaoQueChama(/abrirSeletorBanner/);
    }
  }
];

BOTOES_QUE_GRAVAM.forEach(function (caso) {
  teste('dois cliques em "' + caso.nome + '" mandam UMA requisição', () => {
    const cena = abrirPainel({ semear: caso.semear || cadastroBase });
    const botao = caso.montar(cena);
    const rotulo = botao.textContent;

    cena.respostas[caso.servidor] = semResposta();   // a resposta que não chega
    botao.click();
    botao.click();

    igual(requisicoesDe(cena, caso.servidor).length, 1,
      'A REQUISIÇÃO SAIU DUAS VEZES em "' + caso.nome + '"');
    verdadeiro(botao.disabled, 'o botão seguiu clicável durante a espera');
    verdadeiro(botao.textContent !== rotulo && botao.textContent.length > 0,
      'o botão não diz o que está fazendo: "' + botao.textContent + '"');
    igual(botao.getAttribute('aria-busy'), 'true');
  });

  teste('falha do servidor devolve "' + caso.nome + '" ao normal', () => {
    const cena = abrirPainel({ semear: caso.semear || cadastroBase });
    const botao = caso.montar(cena);
    const rotulo = botao.textContent;

    cena.respostas[caso.servidor] = null;            // a rede cai
    botao.click();

    igual(botao.textContent, rotulo, 'o botão ficou preso no rótulo da espera');
    verdadeiro(!botao.disabled, 'o botão ficou travado, e a pessoa sem saber o que houve');
    igual(botao.getAttribute('aria-busy'), null);
    verdadeiro(erroNaTela(cena).indexOf('Erro em "' + caso.servidor + '"') !== -1,
      'a falha não chegou à tela: ' + erroNaTela(cena));

    // Escrita não é repetida, e o relógio andando não muda isso.
    cena.rodarTarefas(3);
    igual(requisicoesDe(cena, caso.servidor).length, 1, 'a escrita foi repetida sozinha');
  });
});

// ======================================= O erro aparece onde os olhos estão

/**
 * O PRIMEIRO DOS DOIS DEFEITOS DE 12/08/2026, e o mais fácil de subestimar.
 *
 * A coordenação salvou um projeto, o botão ficou 32,71 s em "Salvando…" e o
 * segundo salto voltou 404 (`echo?user_content_key=... 404 3.5kB 32.71s`,
 * DevTools). O painel escreveu o erro em `#mensagem-global` — que mora no painel,
 * ATRÁS da janela aberta. O que a pessoa viu foi o botão voltar ao normal e mais
 * nada, e a conclusão foi a única possível: "o clique não pegou". Ela clicou de
 * novo, e o segundo clique criou o segundo projeto.
 *
 * A regra que estes testes guardam: com uma janela aberta, o aviso vai PARA
 * DENTRO dela. Sem janela, ele continua no painel, como sempre esteve — e a
 * confirmação de uma gravação continua no painel também, porque as gravações
 * fecham a janela antes de confirmar, e um aviso dentro da janela morre com ela.
 */
grupo('o erro aparece onde os olhos estão');

/** A gravação que o servidor executa e cuja RESPOSTA se perde na volta. */
function respostaPerdidaDepoisDeGravar(cena, fn) {
  cena.respostas[fn] = (corpo) => {
    delete cena.respostas[fn];
    // O servidor recebe a requisição e GRAVA — foi o que aconteceu na produção.
    cena.api.doPost({ postData: { type: 'text/plain;charset=utf-8', contents: JSON.stringify(corpo) } });
    // E a volta se perde: a chave de uso único do segundo salto vencendo.
    return respostaHttp(404);
  };
}

teste('com a janela aberta, o erro aparece DENTRO dela', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);
  cena.respostas.salvarProjeto = null;              // a rede cai

  botaoSalvar(cena).click();

  verdadeiro(janelaAberta(cena), 'a janela fechou e levou o erro junto');
  verdadeiro(cena.texto('mensagem-modal').indexOf('Erro em "salvarProjeto"') !== -1,
    'O ERRO FICOU ATRÁS DA JANELA — é o defeito de 12/08: ' + cena.texto('mensagem-modal'));
  igual(cena.texto('mensagem-global'), '',
    'o erro foi escrito também no painel, atrás da janela: ' + cena.texto('mensagem-global'));
});

teste('a recusa do servidor também: ela fala do formulário que está aberto', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.abrirFormProjeto();                       // sem nome, o servidor recusa

  botaoSalvar(cena).click();

  verdadeiro(cena.texto('mensagem-modal').indexOf('Informe o nome') !== -1,
    'a recusa não chegou à janela: ' + cena.texto('mensagem-modal'));
  igual(cena.texto('mensagem-global'), '', cena.texto('mensagem-global'));
});

teste('sem janela aberta, o erro continua no painel — como sempre esteve', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  cena.respostas.rodarReconciliacao = null;

  cena.elemento('botao-reconciliar').click();

  verdadeiro(cena.texto('mensagem-global').indexOf('Erro em "rodarReconciliacao"') !== -1,
    'o erro do painel sumiu da tela: ' + cena.texto('mensagem-global'));
  igual(cena.texto('mensagem-modal'), '',
    'o erro foi parar numa janela fechada, onde ninguém o lê');
});

teste('dentro da janela, o aviso NÃO rola a página de trás', () => {
  // `avisar` rola para o topo quando escreve no painel — é o que traz a mensagem
  // à vista de quem está no fim de uma lista. Dentro da janela, quem rola é o
  // `.modal-fundo`: rolar a página moveria o que está atrás, debaixo do dedo de
  // quem está lendo, e o aviso da janela já nasce colado no rodapé.
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);
  cena.respostas.salvarProjeto = null;
  cena.rolagens.length = 0;

  botaoSalvar(cena).click();
  igual(cena.rolagens.length, 0, 'o erro da janela rolou a página de trás');

  // E o do painel continua rolando: as duas metades da mesma regra.
  cena.js.fecharModal();
  cena.js.avisar('erro', 'Alguma coisa falhou no painel.');
  igual(cena.rolagens.length, 1, 'o aviso do painel deixou de trazer a tela ao topo');
});

teste('a confirmação da gravação vale para o painel — a janela já fechou', () => {
  // Todas as gravações que confirmam chamam `fecharModal()` ANTES de
  // `avisar('sucesso')`. Se a ordem invertesse, a confirmação nasceria dentro de
  // uma janela que fecha no instante seguinte — e ninguém saberia que gravou.
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);

  botaoSalvar(cena).click();

  verdadeiro(!janelaAberta(cena), 'a janela ficou aberta depois de gravar');
  verdadeiro(cena.texto('mensagem-global').indexOf('Projeto criado') !== -1,
    'a confirmação não chegou ao painel: ' + cena.texto('mensagem-global'));
});

teste('o erro da janela morre com ela — a janela seguinte não o herda', () => {
  // O `#mensagem-modal` é fixo na marcação e sobrevive à troca de conteúdo do
  // `#modal-corpo`. Sem a limpeza no `fecharModal`, o erro de um cadastro
  // reapareceria dentro do próximo formulário aberto, falando de uma tela que já
  // não existe.
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);
  cena.respostas.salvarProjeto = null;
  botaoSalvar(cena).click();
  verdadeiro(cena.texto('mensagem-modal').indexOf('Erro') !== -1, 'o erro nem apareceu');

  cena.js.fecharModal();
  cena.js.abrirFormProjeto();

  igual(cena.texto('mensagem-modal'), '',
    'a janela nova abriu com o erro da anterior dentro: ' + cena.texto('mensagem-modal'));
});

teste('com o seletor de banner aberto, o erro aparece NELE — e não na janela de trás', () => {
  // O seletor abre POR CIMA do formulário de projeto (z-index 60). Um erro
  // escrito na janela de baixo repetiria o defeito de 12/08 um andar acima.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.abrirFormProjeto();
  cena.respostas.listarBanners = null;              // a rede cai ao abrir a galeria

  cena.botaoQueChama(/abrirSeletorBanner/).click();

  verdadeiro(!cena.elemento('modal-banner').classList.contains('oculto'),
    'o seletor nem chegou a abrir');
  verdadeiro(cena.texto('status-banner').indexOf('Erro em "listarBanners"') !== -1,
    'o erro não chegou ao seletor: ' + cena.texto('status-banner'));
  igual(cena.texto('mensagem-modal'), '',
    'o erro foi escrito na janela de trás: ' + cena.texto('mensagem-modal'));
  igual(cena.texto('mensagem-global'), '', cena.texto('mensagem-global'));
});

// ============================ A escrita que deu certo e voltou como falha

/**
 * O SEGUNDO DEFEITO DE 12/08 — o grave, e o que vale para toda escrita.
 *
 * O 404 dos 32,71 segundos foi na VOLTA: o projeto já estava gravado. O painel
 * não tinha como saber disso, e ninguém tem: quando a resposta se perde, repetir
 * duplica e não repetir deixa a pessoa sem saber. Hoje existem dois "CONECTANDO
 * GERAÇÕES" no banco, com os slugs `...-o-fu` e `...-o-fu-2`.
 *
 * A saída é a chave de idempotência: o painel manda uma chave por TENTATIVA DE
 * OPERAÇÃO (`CHAVES_EM_ABERTO`), e `rotaDoPainel_` (08_Api.gs) devolve a resposta
 * guardada em vez de executar de novo. Estes testes clicam duas vezes no Salvar
 * pelo caminho de verdade — envelope, lista branca, `exigirAdmin`, `salvarProjeto`
 * e o Firestore falso — e contam DUAS coisas: quantas requisições saíram e
 * quantas vezes a função do servidor rodou.
 *
 * `cena.chamadas` é o que separa uma da outra: ele registra o que chegou ao `.gs`,
 * então "duas requisições, uma execução" é uma afirmação sobre o servidor, e não
 * sobre a tela.
 *
 * Os 32 segundos em si não são consertáveis aqui — são contenção dos 30 slots de
 * execução simultânea do Apps Script, e vão acontecer de novo com 400 pessoas no
 * auditório. O que estes testes garantem é que da próxima vez isso custe um
 * clique, e não um projeto duplicado.
 */
grupo('a chave que impede a escrita repetida');

/** Quantas vezes a função do servidor RODOU de verdade. */
function execucoesDe(cena, fn) {
  return cena.chamadas.filter((c) => c.funcao === fn).length;
}

/** A chave de idempotência que viajou em cada requisição desta função. */
function chavesDe(cena, fn) {
  return cena.requisicoesHttp
    .map((r) => JSON.parse(r.corpo))
    .filter((c) => c.fn === fn)
    .map((c) => c.idem);
}

teste('clicar de novo depois da resposta perdida NÃO grava o segundo projeto', () => {
  // O caso da produção, do começo ao fim.
  const cena = abrirPainel({ semear: cadastroBase });
  const antes = Object.keys(cena.documentos('projetos')).length;
  formularioDeProjetoPreenchido(cena);

  respostaPerdidaDepoisDeGravar(cena, 'salvarProjeto');
  botaoSalvar(cena).click();

  igual(Object.keys(cena.documentos('projetos')).length, antes + 1,
    'a encenação não gravou nada — o teste estaria provando o caso errado');
  verdadeiro(janelaAberta(cena), 'a janela fechou, e o segundo clique nem seria possível');

  // "Não pegou" — e ela clica de novo, que é o que qualquer um faria.
  botaoSalvar(cena).click();

  igual(Object.keys(cena.documentos('projetos')).length, antes + 1,
    'NASCEU O SEGUNDO PROJETO — é o dado duplicado de 12/08');
  igual(requisicoesDe(cena, 'salvarProjeto').length, 2, 'o segundo clique nem chegou a sair');
  igual(execucoesDe(cena, 'salvarProjeto'), 1,
    'o servidor executou a gravação duas vezes');
});

teste('e a segunda tentativa recebe a MESMA resposta da primeira', () => {
  // Não basta não duplicar: a pessoa precisa saber que deu certo. A resposta
  // guardada é a da execução que aconteceu, com o mesmo id de projeto.
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);

  const daPraca = () => Object.keys(cena.documentos('projetos'))
    .filter((id) => cena.documentos('projetos')[id].nome === 'Robótica na praça');

  respostaPerdidaDepoisDeGravar(cena, 'salvarProjeto');
  botaoSalvar(cena).click();
  igual(daPraca().length, 1, 'a primeira tentativa não gravou — o teste provaria outra coisa');

  botaoSalvar(cena).click();

  verdadeiro(!janelaAberta(cena), 'a janela ficou aberta depois de a gravação ser confirmada');
  verdadeiro(cena.texto('mensagem-global').indexOf('Projeto criado') !== -1,
    'a segunda tentativa não confirmou nada: ' + cena.texto('mensagem-global'));
  igual(daPraca().length, 1, 'o projeto ficou duplicado no banco');
  verdadeiro(cena.texto('conteudo-projetos').indexOf('Robótica na praça') !== -1,
    'a lista não mostra o projeto que foi criado: ' + cena.texto('conteudo-projetos'));
});

teste('a mesma operação repetida leva a MESMA chave', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);
  cena.respostas.salvarProjeto = null;              // a rede cai nas duas

  botaoSalvar(cena).click();
  botaoSalvar(cena).click();

  const chaves = chavesDe(cena, 'salvarProjeto');
  igual(chaves.length, 2, 'saíram ' + chaves.length + ' requisições, e não duas');
  verdadeiro(typeof chaves[0] === 'string' && chaves[0].length >= 8, 'chave ausente: ' + chaves[0]);
  igual(chaves[1], chaves[0],
    'A CHAVE MUDOU ENTRE AS DUAS TENTATIVAS — o servidor não teria como reconhecê-las');
});

teste('mudar o formulário é OUTRA operação: chave nova, e ela grava', () => {
  // O outro lado da regra, e o que impede a chave de virar um "grava uma vez por
  // sessão": se a pessoa corrigiu alguma coisa, ela quer que a correção aconteça.
  const cena = abrirPainel({ semear: cadastroBase });
  const antes = Object.keys(cena.documentos('projetos')).length;
  formularioDeProjetoPreenchido(cena);

  respostaPerdidaDepoisDeGravar(cena, 'salvarProjeto');
  botaoSalvar(cena).click();

  cena.digitar('pj-nome', 'Robótica na praça central');
  botaoSalvar(cena).click();

  const chaves = chavesDe(cena, 'salvarProjeto');
  verdadeiro(chaves[1] !== chaves[0], 'o formulário mudou e a chave continuou a mesma');
  igual(execucoesDe(cena, 'salvarProjeto'), 2, 'a segunda gravação não aconteceu');
  igual(Object.keys(cena.documentos('projetos')).length, antes + 2,
    'o projeto corrigido não foi gravado');
});

teste('a operação que FALHOU pode ser tentada de novo', () => {
  // A regra do servidor: guarda só o que deu certo. Uma recusa guardada viraria
  // erro permanente por dez minutos — a pessoa clicaria de novo e receberia a
  // mesma recusa sem nada ter sido tentado.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  cena.js.abrirFormProjeto();                       // sem nome: o servidor recusa

  respostaPerdidaDepoisDeGravar(cena, 'salvarProjeto');
  botaoSalvar(cena).click();
  botaoSalvar(cena).click();

  const chaves = chavesDe(cena, 'salvarProjeto');
  igual(chaves[1], chaves[0], 'a repetição não é a mesma operação para o servidor');
  igual(execucoesDe(cena, 'salvarProjeto'), 2,
    'A RECUSA FICOU GUARDADA: a segunda tentativa nem chegou a rodar');
  verdadeiro(cena.texto('mensagem-modal').indexOf('Informe o nome') !== -1,
    'a recusa da segunda tentativa não chegou à tela: ' + cena.texto('mensagem-modal'));
});

teste('depois do desfecho conhecido, o MESMO payload é uma operação NOVA', () => {
  // O QUE ESTE TESTE IMPEDE, e por que ele é o mais importante do grupo depois do
  // primeiro: se a chave ficasse presa ao CONTEÚDO — a saída óbvia, que dispensa
  // guardar estado no cliente —, dois pedidos iguais separados no tempo virariam
  // um só, e o segundo seria engolido com a tela dizendo que deu certo.
  //
  // O "Atualizar" da aba Alunos é o caso mais limpo disso no sistema: o payload
  // dele não tem nada que mude entre um clique e o outro. Clicar duas vezes é
  // pedir duas vezes, e a segunda tem uma resposta PRÓPRIA — "nada entrou desde a
  // última vez" —, que é justamente o que a coordenação clica para descobrir.
  //
  // O mesmo vale, com menos evidência, para inativar/ativar/inativar um projeto e
  // para salvar o parâmetro A, depois B, depois A de novo.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('alunos');

  cena.js.atualizarAlunosUI();
  cena.js.atualizarAlunosUI();

  const chaves = chavesDe(cena, 'atualizarAlunos');
  igual(chaves.length, 2, 'saíram ' + chaves.length + ' requisições, e não duas');
  verdadeiro(chaves[1] !== chaves[0],
    'os dois cliques levaram a MESMA chave, e são operações diferentes: ' + chaves[0]);
  igual(execucoesDe(cena, 'atualizarAlunos'), 2,
    'A SEGUNDA FOI ENGOLIDA pela resposta guardada da primeira');
  verdadeiro(cena.texto('mensagem-global').indexOf('nada entrou desde a última vez') !== -1,
    'a resposta que a segunda tinha para dar não chegou à tela: ' + cena.texto('mensagem-global'));
});

teste('leitura não consome chave — e não pode consumir', () => {
  // Uma leitura com chave teria a resposta CONGELADA por dez minutos: a aba
  // mostrando o número de antes depois de alguém ter gravado. O servidor trata a
  // chave como opaca, então esta linha do painel é a única guarda que existe.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('alunos');
  cena.js.trocarAba('log');

  // `sessaoAtiva` está aqui por outro motivo: ela é de `DE_LOGIN`, e o envelope
  // de login nem passa por `rotaDoPainel_`.
  ['sessaoAtiva', 'painelEstatisticas', 'listarAlunos', 'listarLog']
    .forEach((fn) => {
      const chaves = chavesDe(cena, fn);
      verdadeiro(chaves.length > 0, fn + ' não foi chamada — o teste não prova nada');
      chaves.forEach((chave) => {
        igual(chave, undefined, 'a leitura ' + fn + ' mandou chave de idempotência');
      });
    });

  // E a escrita manda, claro. Sem esta metade, apagar a chave inteira do painel
  // deixaria o teste acima verde. Exportar É escrita: cada exportação deixa uma
  // linha na trilha de auditoria, e por isso ela ficou fora de `SO_LEITURA`.
  cena.js.trocarAba('alunos');
  cena.elemento('botao-exportar').click();
  verdadeiro(chavesDe(cena, 'exportarCsv').length > 0, 'a exportação não saiu');
  verdadeiro(chavesDe(cena, 'exportarCsv').every((c) => typeof c === 'string' && c.length >= 8),
    'a escrita saiu sem chave: ' + JSON.stringify(chavesDe(cena, 'exportarCsv')));
});

teste('o formato da chave é o que o servidor aceita', () => {
  // As duas pontas são arquivos diferentes, publicados por caminhos diferentes
  // (GitHub Pages e Apps Script). Uma chave fora do formato não é recusada pelo
  // servidor: ela é IGNORADA, e a proteção some sem ninguém ver.
  const cena = abrirPainel({ semear: cadastroBase });
  formularioDeProjetoPreenchido(cena);
  cena.respostas.salvarProjeto = null;
  botaoSalvar(cena).click();

  const chave = chavesDe(cena, 'salvarProjeto')[0];
  verdadeiro(/^[A-Za-z0-9_-]{8,64}$/.test(chave), 'chave fora do formato: ' + chave);
  verdadeiro(cena.api.chaveIdempotente_('salvarProjeto', chave) !== '',
    'o servidor ignoraria a chave que o painel manda: ' + chave);
});

// ------------------------------------------------- A importação, de perto

/**
 * O caso da produção, encenado: `Failed to fetch` no Confirmar importação.
 *
 * O teste do laço acima já afirma que o botão volta. Este afirma o RESTO — que o
 * trabalho de mapear as colunas continua na tela —, porque é isso que fazia do
 * botão travado um problema grande: a saída era recarregar a página, e recarregar
 * apaga o mapeamento.
 */
teste('o Failed to fetch da importação não leva junto o mapeamento das colunas', () => {
  const cena = abrirPainel({ semear: cadastroBase });
  importacaoMapeada(cena);
  cena.respostas.confirmarImportacao = null;

  const botao = cena.elemento('botao-confirmar');
  botao.click();

  igual(botao.textContent, 'Confirmar importação', 'o botão ficou preso em "Importando..."');
  verdadeiro(!botao.disabled, 'ISTO é o defeito de 11/08: só recarregando a página');

  const selects = cena.documento.querySelectorAll('[data-campo]');
  const matricula = selects.filter((s) => s.getAttribute('data-campo') === 'matricula')[0];
  igual(matricula.value, '0', 'o mapeamento das colunas se perdeu');
  verdadeiro(!cena.elemento('importar-passo-2').classList.contains('oculto'),
    'a tela saiu do passo 2 por causa de uma falha de rede');
});

teste('o Confirmar não sai do lugar quando falta coluna obrigatória — e nem trava', () => {
  // A validação recusa ANTES de falar com o servidor: ninguém adota o botão, e é
  // o próprio envelope que o devolve.
  const cena = abrirPainel({ semear: cadastroBase });
  importacaoMapeada(cena, { turma: 2 });          // sem matrícula e sem nome

  const botao = cena.elemento('botao-confirmar');
  botao.click();

  igual(requisicoesDe(cena, 'confirmarImportacao').length, 0, 'subiu arquivo sem mapeamento');
  igual(botao.textContent, 'Confirmar importação', 'o botão ficou travado sem requisição em voo');
  verdadeiro(!botao.disabled);
  verdadeiro(cena.texto('mensagem-global').indexOf('Falta escolher a coluna') !== -1,
    cena.texto('mensagem-global'));
});

teste('a falha do Reconciliar de depois da importação não desfaz a importação', () => {
  // O botão volta ao normal — disso trata o laço acima. O que este teste guarda é
  // o recado: a lista oficial JÁ está gravada, e o que falta é só o cruzamento.
  // Sem isso, quem vê "falhou" na última tela conclui que perdeu a importação
  // inteira e sobe o arquivo de novo.
  const cena = abrirPainel({ semear: cadastroBase });
  importacaoMapeada(cena);
  cena.respostas.confirmarImportacao = { ok: true, importadas: 2, ignoradas: 0 };
  cena.elemento('botao-confirmar').click();

  const botao = cena.elemento('botao-reconciliar-pos');
  igual(botao.textContent, 'Reconciliar agora', 'o passo 3 não desenhou o botão de reconciliar');

  cena.respostas.rodarReconciliacao = { ok: false, erro: 'Reconciliação indisponível.' };
  botao.click();

  const tela = cena.texto('pos-importacao');
  verdadeiro(tela.indexOf('A importação continua valendo') !== -1,
    'a tela não diz que o arquivo já foi gravado: ' + tela);
});

teste('o rótulo da espera é o do próprio botão, e não um "Salvando…" para tudo', () => {
  // Importar não é salvar, e reconciliar demora o suficiente para a pessoa
  // precisar saber que vale esperar. O rótulo vem do `data-gravando` da marcação.
  const cena = abrirPainel({ semear: cadastroBase });
  importacaoMapeada(cena);
  cena.respostas.confirmarImportacao = semResposta();

  cena.elemento('botao-confirmar').click();
  igual(cena.elemento('botao-confirmar').textContent, 'Importando...');

  const outra = abrirPainel({ semear: cadastroBase });
  outra.respostas.rodarReconciliacao = semResposta();
  outra.elemento('botao-reconciliar').click();
  verdadeiro(outra.elemento('botao-reconciliar').textContent.indexOf('Reconciliando') === 0,
    'a espera mais longa do sistema virou um "Salvando…" genérico: ' +
    outra.elemento('botao-reconciliar').textContent);
});

teste('o botão de uma linha de tabela que some na resposta não estoura ao voltar', () => {
  // Inativar um projeto redesenha a tabela inteira, e o botão clicado deixa de
  // existir. O `chamar()` devolve o botão ANTES de `aoOk` disparar a recarga, e
  // mesmo assim o elemento órfão continua aceitando o rótulo de volta.
  const cena = abrirPainel({ semear: cadastroBase });
  cena.js.trocarAba('projetos');
  const botao = cena.botaoQueChama(/alternarProjetoUI/);

  botao.click();

  igual(botao.textContent, 'Inativar', 'o rótulo não voltou ao elemento que foi travado');
  verdadeiro(!botao.disabled);
  verdadeiro(cena.texto('conteudo-projetos').indexOf('Inativo') !== -1,
    'a tabela não foi redesenhada com a situação nova: ' + cena.texto('conteudo-projetos'));

  // E a linha nova traz um botão vivo, com o rótulo invertido.
  const novo = cena.botaoQueChama(/alternarProjetoUI/);
  verdadeiro(!novo.disabled, 'a tabela redesenhou com o botão travado');
});

// ==================================================== A aba Auditório
//
// O QUE ESTE BLOCO PROTEGE, e por que ele é clicado e não conferido por regex.
//
// A aba existe para um ciclo, e é o ciclo inteiro que precisa funcionar:
//
//     anular o lixo  ->  vagas liberam  ->  promover a fila  ->  aluno de verdade entra
//
// Cada metade sozinha é inútil: anular sem promover só deixa vaga vazia com gente
// esperando ao lado. Por isso o primeiro teste daqui percorre o ciclo do começo ao
// fim, pelo `doPost` de VERDADE, contra o Firestore falso — o mesmo caminho do
// dedo da coordenação, incluindo a lista branca de `funcoesDoPainel_` e o
// `exigirAdmin` de cada função.
//
// E a tela é usada num lugar específico: auditório cheio, à noite, uma pessoa, no
// celular, com pressa. É isso que faz da seleção por faixa e da confirmação com
// nomes coisas de segurança, e não de conforto — os dois testes do meio deste
// bloco são sobre isso.

grupo('a aba Auditório — o ciclo de anular, liberar e promover');

/**
 * A noite do evento, encenada: um projeto de duas vagas, dois dentro e três na
 * fila. Os carimbos são explícitos e distintos de propósito — `agora()` tem
 * resolução de SEGUNDO, e numa rajada de verdade meia dúzia de inscrições
 * dividem o mesmo segundo. Com carimbo controlado, "da mais nova para a mais
 * velha" e "em ordem de chegada" viram afirmações e não coincidências.
 *
 * A segunda inscrição é o lixo da história: ela ocupa vaga, tem nome que não é
 * nome, e é ela que a coordenação vai anular para a fila andar.
 */
function auditorioBase(api) {
  api.semearConfigPadrao_();
  api.gravarConfig('vagas_excedentes_em_espera', 'SIM');
  api.inserir('projetos', {
    nome: 'Robótica', vagas: '2', ativo: 'SIM', inscricoes_abertas: 'SIM', ordem: '1'
  }, 'p1');

  inscrever(api, 'i1', 'Ana Silva', '110001', '2026-08-14 21:00:01', false);
  inscrever(api, 'i2', 'kkkk jjjj', '999999', '2026-08-14 21:00:02', false);
  inscrever(api, 'i3', 'Bruno Souza', '110002', '2026-08-14 21:00:03', true);
  inscrever(api, 'i4', 'Carla Dias', '110003', '2026-08-14 21:00:04', true);
  inscrever(api, 'i5', 'Diego Melo', '110004', '2026-08-14 21:00:05', true);
}

/**
 * Uma inscrição gravada direto, com carimbo e marca de fila escolhidos.
 *
 * `em_espera` e `espera_de` são os dois campos que `gravarInscricao` escreve
 * junto (04_Inscricoes.gs) e que `contarEmEspera_` conta (09_Projetos.gs) —
 * escrever um sem o outro produziria um banco que o servidor nunca produz, e o
 * teste mediria uma tela sobre dados impossíveis.
 */
function inscrever(api, id, nome, matricula, quando, emEspera) {
  const campos = {
    criado_em: quando, origem: 'SITE', projeto_id: 'p1', projeto_nome: 'Robótica',
    matricula: matricula, nome: nome, email: matricula + '@exemplo.com',
    matricula_conferida: 'NAO', declara_ciencia: 'SIM', consentimento_lgpd: 'SIM'
  };
  if (emEspera) { campos.em_espera = 'SIM'; campos.espera_de = 'p1'; }
  api.inserir('inscricoes', campos, id);
}

/** Os ids que uma das duas listas do Auditório pôs nos botões, de cima para baixo. */
function idsDaLista(cena, lista) {
  const ids = [];
  cena.html('auditorio-' + lista).replace(
    new RegExp("tocarLinha\\('" + lista + "', '([^']+)'\\)", 'g'),
    (m, id) => { ids.push(id); return m; }
  );
  return ids;
}

/** Toca na enésima linha de uma lista — 1 é a de cima. O clique é o de verdade. */
function tocar(cena, lista, n) {
  const id = idsDaLista(cena, lista)[n - 1];
  if (!id) throw new Error('a lista ' + lista + ' não tem a linha ' + n);
  cena.botaoQueChama(new RegExp("tocarLinha\\('" + lista + "', '" + id + "'\\)")).click();
  return id;
}

/** As marcadas de uma lista, lidas do `aria-pressed` que a tela desenhou. */
function marcadas(cena, lista) {
  return (cena.html('auditorio-' + lista).match(/aria-pressed="true"/g) || []).length;
}

function abrirAuditorio(semear) {
  const cena = abrirPainel({ semear: semear || auditorioBase });
  cena.js.trocarAba('auditorio');
  return cena;
}

/** A inscrição, direto do banco falso — quem está lá e quem está na fila. */
function inscricaoNoBanco(cena, id) {
  return cena.documentos('inscricoes')[id] || null;
}

teste('o ciclo inteiro: anular libera a vaga, e promover preenche com quem esperava', () => {
  const cena = abrirAuditorio();

  // O estado de onde se parte: lotado, com três esperando.
  verdadeiro(cena.texto('auditorio-projetos').indexOf('2/2') !== -1,
    'o cabeçalho não mostra o projeto lotado: ' + cena.texto('auditorio-projetos'));
  verdadeiro(cena.texto('auditorio-projetos').indexOf('3 na espera') !== -1,
    cena.texto('auditorio-projetos'));
  verdadeiro(cena.texto('auditorio-alerta').indexOf('nenhuma vaga livre') !== -1,
    'sem vaga, a tela precisa dizer que é preciso anular antes: ' + cena.texto('auditorio-alerta'));

  // 1. ANULAR O LIXO. A lista vem da mais nova para a mais velha, então a
  //    inscrição inventada (21:00:02) é a quarta linha.
  const lixo = tocar(cena, 'recentes', 4);
  igual(lixo, 'i2', 'a ordem da lista mudou — a linha tocada não é a inventada');
  cena.botaoQueChama(/aoGravar\(this, anularMarcadas\)/).click();

  igual(inscricaoNoBanco(cena, 'i2'), null, 'a inscrição anulada continua ocupando vaga');
  verdadeiro(Object.keys(cena.documentos('inscricoes_anuladas')).indexOf('i2') !== -1,
    'a anulada não foi para a quarentena — sem ela não há desfazer');

  // 2. A VAGA LIBEROU, e a tela OFERECE o resto do ciclo sozinha.
  const oferta = cena.texto('auditorio-alerta');
  verdadeiro(oferta.indexOf('Cabem 1 agora') !== -1, 'a tela não contou a vaga liberada: ' + oferta);
  verdadeiro(oferta.indexOf('Promover 1 da fila') !== -1,
    'anular sem oferecer promover deixa a vaga vazia com gente esperando ao lado: ' + oferta);

  // 3. PROMOVER. Quem entra é o primeiro da fila por CHEGADA — o Bruno (21:00:03),
  //    e não o Diego, que está no topo da lista de recentes.
  cena.botaoQueChama(/aoGravar\(this, promoverQueCabem\)/).click();

  const bruno = inscricaoNoBanco(cena, 'i3');
  verdadeiro(bruno && bruno.em_espera !== 'SIM',
    'o primeiro da fila não entrou de verdade: ' + JSON.stringify(bruno));
  verdadeiro(inscricaoNoBanco(cena, 'i4').em_espera === 'SIM',
    'quem estava atrás na fila foi promovido junto — a vaga era uma só');

  // 4. E a tela volta a mostrar o estado NOVO, sem ninguém precisar recarregar.
  verdadeiro(cena.texto('auditorio-projetos').indexOf('2 na espera') !== -1,
    'o cabeçalho ficou com o número velho: ' + cena.texto('auditorio-projetos'));
});

teste('tocar na primeira e na última marca o intervalo inteiro', () => {
  // A razão de existir da faixa: uma rajada é contígua no tempo, e marcar 40
  // linhas uma a uma, em pé, no escuro, não acontece.
  const cena = abrirAuditorio();

  tocar(cena, 'recentes', 1);
  igual(marcadas(cena, 'recentes'), 1, 'o primeiro toque marcou mais de uma linha');

  tocar(cena, 'recentes', 4);
  igual(marcadas(cena, 'recentes'), 4, 'a faixa não pegou o intervalo inteiro');
  verdadeiro(cena.texto('auditorio-acoes-recentes').indexOf('4 marcada(s)') !== -1,
    'a barra de ações não conta o que está marcado: ' + cena.texto('auditorio-acoes-recentes'));
  verdadeiro(cena.texto('auditorio-acoes-recentes').indexOf('Anular 4') !== -1,
    'o número precisa estar NO BOTÃO: é a última chance de ver o tamanho do estrago');
});

teste('a faixa também sobe, e tocar numa marcada desmarca só ela', () => {
  const cena = abrirAuditorio();

  // De baixo para cima é o mesmo intervalo — quem marca não sabe (nem precisa
  // saber) qual das duas pontas tocou primeiro.
  tocar(cena, 'recentes', 5);
  tocar(cena, 'recentes', 3);
  igual(marcadas(cena, 'recentes'), 3, 'a faixa de baixo para cima não marcou o intervalo');

  // O furo: desmarcar UMA no meio, sem perder as outras. É o que permite tirar da
  // faixa o nome que a coordenação reconhece.
  tocar(cena, 'recentes', 4);
  igual(marcadas(cena, 'recentes'), 2, 'tocar numa marcada mexeu em quem não foi tocado');
});

teste('nada nasce marcado, e nenhum botão de ação nasce na tela', () => {
  // Pré-marcação é a mesma coisa que sugerir quem apagar: sob pressa, o que a
  // tela deixa pronto é o que se aperta. Aqui a tela não escolhe ninguém.
  const cena = abrirAuditorio();

  igual(marcadas(cena, 'recentes'), 0, 'a tela pré-marcou inscrições ao carregar');
  igual(marcadas(cena, 'fila'), 0, 'a tela pré-marcou gente da fila ao carregar');
  igual(cena.texto('auditorio-acoes-recentes'), '',
    'nasceu um botão de anular sem ninguém ter escolhido nada');
  igual(cena.texto('auditorio-acoes-fila'), '');

  // E nada de pontuação, nota de suspeita ou ordenação por palpite: a lista sai
  // na ordem do relógio, e a decisão é da pessoa.
  igual(idsDaLista(cena, 'recentes'), ['i5', 'i4', 'i3', 'i2', 'i1'],
    'a lista de recentes não está em ordem de chegada invertida');
  igual(idsDaLista(cena, 'fila'), ['i3', 'i4', 'i5'],
    'a fila não está em ordem de chegada — é o único critério justo que existe');
});

teste('a confirmação do anular mostra três nomes por extenso e o total', () => {
  // É a única barreira entre um toque a mais e um aluno de verdade apagado — e
  // ele não é avisado de nada, e só descobre em setembro. Número sozinho
  // ("anular 4?") não deixa ninguém perceber que marcou uma linha a mais.
  const cena = abrirAuditorio();

  tocar(cena, 'recentes', 1);
  tocar(cena, 'recentes', 4);

  cena.respostaConfirm = false;
  cena.botaoQueChama(/aoGravar\(this, anularMarcadas\)/).click();

  const pergunta = cena.confirmacoes[0];
  verdadeiro(pergunta.indexOf('Anular 4 inscrição(ões)?') !== -1, pergunta);
  ['Diego Melo', 'Carla Dias', 'Bruno Souza'].forEach((nome) => {
    verdadeiro(pergunta.indexOf(nome) !== -1, 'faltou o nome ' + nome + ': ' + pergunta);
  });
  verdadeiro(pergunta.indexOf('... e mais 1.') !== -1,
    'a pergunta mostra três nomes e precisa dizer quantos ficaram de fora: ' + pergunta);
  verdadeiro(pergunta.indexOf('NÃO é avisado') !== -1,
    'a pergunta precisa dizer o que o erro custa: ' + pergunta);

  // E dizer não é não: nada saiu, ninguém foi apagado.
  igual(cena.documentos('inscricoes_anuladas'), {},
    'a recusa no "tem certeza?" apagou gente assim mesmo');
  verdadeiro(inscricaoNoBanco(cena, 'i5') !== null, 'a inscrição sumiu depois de um cancelamento');
});

teste('a pergunta com menos de três marcadas mostra as que há, sem inventar sobra', () => {
  const cena = abrirAuditorio();
  tocar(cena, 'recentes', 1);

  cena.respostaConfirm = false;
  cena.botaoQueChama(/aoGravar\(this, anularMarcadas\)/).click();

  const pergunta = cena.confirmacoes[0];
  verdadeiro(pergunta.indexOf('Anular 1 inscrição(ões)?') !== -1, pergunta);
  verdadeiro(pergunta.indexOf('Diego Melo') !== -1, pergunta);
  igual(pergunta.indexOf('e mais'), -1, 'a pergunta inventou uma sobra que não existe: ' + pergunta);
});

teste('"promovi 3 de 3" quando só 1 cabe vira relato na tela, e em amarelo', () => {
  // O relato NÃO pode ser engolido: "promovi 1" e "promovi 1 de 3" são a mesma
  // tela verde para quem só olha a cor, e a diferença são duas pessoas que
  // continuam esperando sem ninguém saber. Amarelo porque o verde do `avisar`
  // se apaga sozinho em 6 segundos.
  const cena = abrirAuditorio();

  // Uma vaga só, e a coordenação marca a fila inteira.
  tocar(cena, 'recentes', 4);
  cena.botaoQueChama(/aoGravar\(this, anularMarcadas\)/).click();

  tocar(cena, 'fila', 1);
  tocar(cena, 'fila', 3);
  cena.botaoQueChama(/aoGravar\(this, promoverMarcadas\)/).click();

  const relato = cena.texto('mensagem-global');
  const numeros = 'Promovi 1 de 3.';
  verdadeiro(relato.indexOf(numeros) !== -1, 'os dois números não chegaram à tela: ' + relato);

  // E o que o servidor explicou sobre quem ficou vem JUNTO. A afirmação é sobre
  // a existência da explicação, e não sobre as palavras dela: a redação é de
  // 13_Auditorio.gs e pode mudar sem que esta tela esteja errada. O que não pode
  // é a tela ficar só com os números.
  const explicacao = relato.slice(relato.indexOf(numeros) + numeros.length).trim();
  verdadeiro(explicacao.length > 0,
    'a tela ficou só com os números e engoliu o que o servidor explicou: ' + relato);

  verdadeiro(cena.html('mensagem-global').indexOf('aviso--atencao') !== -1,
    'o relato com sobra saiu em verde, e o verde se apaga sozinho antes de ser lido');
});

teste('anular NAO oferece desfazer — mas diz que a inscricao ficou guardada', () => {
  // O botao de Desfazer saiu em 12/08, a pedido da coordenacao: "se foi anulado,
  // confirmou, ja era". O argumento era bom — um desfazer a mao convida a
  // confirmar sem ler, e ele so valia enquanto a tela nao recarregasse.
  //
  // O que este teste guarda e o que NAO pode sair junto: a copia de quarentena,
  // e a frase que conta dela. Sem a frase, quem anular por engano acha que
  // destruiu, e nao pede socorro a quem consegue devolver.
  const cena = abrirAuditorio();

  tocar(cena, 'recentes', 4);
  cena.botaoQueChama(/aoGravar\(this, anularMarcadas\)/).click();

  igual(inscricaoNoBanco(cena, 'i2'), null, 'a inscricao continuou de pe depois de anulada');

  const alerta = cena.texto('auditorio-alerta');
  igual(alerta.indexOf('Desfazer'), -1, 'o botao de desfazer voltou: ' + alerta);
  verdadeiro(alerta.indexOf('Anulei 1') !== -1, alerta);
  verdadeiro(/guardad/i.test(alerta),
    'a tela nao disse que a inscricao ficou guardada: ' + alerta);
  verdadeiro(/avise|socorro|cuida do sistema/i.test(alerta),
    'a tela nao disse a quem pedir para trazer de volta: ' + alerta);
});

teste('a copia de quarentena continua sendo feita ANTES de apagar', () => {
  // A rede embaixo do trapezio. Sem o botao de desfazer, ela e a UNICA coisa
  // entre um engano as 19h e um aluno que descobre em setembro que sumiu.
  const cena = abrirAuditorio();

  tocar(cena, 'recentes', 4);
  cena.botaoQueChama(/aoGravar\(this, anularMarcadas\)/).click();

  const quarentena = cena.documentos('inscricoes_anuladas');
  const ids = Object.keys(quarentena);
  igual(ids.length, 1, 'a inscricao anulada nao foi para a quarentena');
  verdadeiro(ids.indexOf('i2') !== -1, 'a copia perdeu o id original: ' + ids.join(', '));
  igual(inscricaoNoBanco(cena, 'i2'), null, 'apagou sem copiar, ou copiou e nao apagou');
});

teste('Atualizar limpa a marcação — a lista que chega é outra', () => {
  // Marcação que atravessa a recarga é marcação apontando para uma tela que
  // ninguém leu: as linhas mudaram de lugar, e o botão continuaria dizendo
  // "Anular 4".
  const cena = abrirAuditorio();

  tocar(cena, 'recentes', 1);
  tocar(cena, 'recentes', 3);
  igual(marcadas(cena, 'recentes'), 3);

  cena.elemento('auditorio-atualizar').click();

  igual(marcadas(cena, 'recentes'), 0, 'a marcação sobreviveu à recarga');
  igual(cena.texto('auditorio-acoes-recentes'), '', 'o botão de anular sobreviveu à recarga');
});

teste('quem está na fila é dito na lista de quem chegou, e não se confunde com quem entrou', () => {
  const cena = abrirAuditorio();
  const html = cena.html('auditorio-recentes');

  igual((html.match(/na espera/g) || []).length, 3,
    'a marca de fila não aparece em quem está na fila: ' + html);
  verdadeiro(cena.texto('auditorio-recentes').indexOf('Ana Silva') !== -1);
});

teste('o horário vem com SEGUNDOS — é o que denuncia a rajada', () => {
  // Uma rajada se enxerga pelo intervalo: mesmo projeto, segundos entre uma linha
  // e outra. Com "21:00" nas cinco linhas, cinco inscrições em cinco segundos e
  // cinco em cinco minutos são a mesma tela.
  const cena = abrirAuditorio();
  const texto = cena.texto('auditorio-recentes');

  ['21:00:05', '21:00:04', '21:00:03', '21:00:02', '21:00:01'].forEach((hora) => {
    verdadeiro(texto.indexOf(hora) !== -1, 'sumiu o horário ' + hora + ': ' + texto);
  });
  igual(texto.indexOf('2026-08-14'), -1,
    'a data inteira em toda linha rouba a largura da tela do celular sem dizer nada novo');
});

teste('a leitura conta o tamanho da janela que está mostrando', () => {
  // A lista tem teto. Sem dizer o tamanho da janela, quem não acha uma inscrição
  // aqui conclui que ela não existe — o modo de falha mudo, de novo.
  const cena = abrirAuditorio();
  verdadeiro(cena.texto('auditorio-recentes').indexOf('de 5 lidas') !== -1,
    cena.texto('auditorio-recentes'));
});

teste('sem fila nenhuma, o cabeçalho mostra a LOTAÇÃO em vez de ficar vazio', () => {
  // A intenção deste teste não mudou — cabeçalho vazio é indistinguível de tela
  // quebrada. O que mudou foi como ela se cumpre: `filaDeEspera` passou a
  // devolver TODOS os projetos ativos, e não só os que já têm fila.
  //
  // A razão é o que a coordenação precisa enxergar às 19h: um projeto em 58/60
  // sem fila nenhuma é justamente o que faz alguém prestar atenção. Esconder até
  // estourar é mostrar o incêndio depois de pegar fogo. Ver o cabeçalho de
  // `filaDeEspera` em 13_Auditorio.gs.
  const cena = abrirAuditorio((api) => {
    api.semearConfigPadrao_();
    api.inserir('projetos', {
      nome: 'Robótica', vagas: '10', ativo: 'SIM', inscricoes_abertas: 'SIM', ordem: '1'
    }, 'p1');
    inscrever(api, 'i1', 'Ana Silva', '110001', '2026-08-14 21:00:01', false);
  });

  const cabecalho = cena.texto('auditorio-projetos');
  verdadeiro(cabecalho.indexOf('Robótica') !== -1,
    'cabeçalho vazio é indistinguível de tela quebrada: ' + cabecalho);
  verdadeiro(/1\s*\/\s*10/.test(cabecalho), 'a lotação precisa aparecer: ' + cabecalho);
  verdadeiro(/cabem\s*9/.test(cabecalho), 'quantos cabem é o número que decide promover: ' + cabecalho);
  verdadeiro(cena.texto('auditorio-fila').indexOf('Ninguém na fila') !== -1,
    cena.texto('auditorio-fila'));
  igual(cena.texto('auditorio-alerta'), '', 'sem fila não há o que oferecer');
});

// ================================================ A vizinhança da matrícula

grupo('a matrícula é a chave da PESSOA, e o 409 só cobre o mesmo projeto');

/**
 * A mesma pessoa em dois projetos, com a matrícula errada nos dois.
 *
 * Sem o aviso, a coordenação corrige, lê "Ficha atualizada." e vai embora — e o
 * cruzamento parte a pessoa em duas fichas, uma delas ainda no nome do dono da
 * matrícula antiga, carregando o projeto que ficou para trás.
 */
teste('a inscrição que fica para trás é dita, com o projeto no nome', () => {
  const amb = servidor((api) => {
    api.semearConfigPadrao_();
    api.inserir('projetos', { nome: 'Projeto A', vagas: '10', ativo: 'SIM', inscricoes_abertas: 'SIM', ordem: '1' }, 'p1');
    api.inserir('projetos', { nome: 'Projeto B', vagas: '10', ativo: 'SIM', inscricoes_abertas: 'SIM', ordem: '2' }, 'p2');
    api.escreverEmLote('matriculados', [
      { _id: '110001', matricula: '110001', nome: 'Ana Silva', turma: 'ADS11', curso: 'ADS', lote_id: 'L1' },
      { _id: '220002', matricula: '220002', nome: 'Bruno Souza', turma: 'DIR21', curso: 'DIREITO', lote_id: 'L1' }
    ]);
    api.gravarInscricao({ matricula: '220002', nome: 'Ana Silva', email: 'ana@exemplo.com', projeto_id: 'p1', projeto_nome: 'Projeto A', origem: 'SITE' });
    api.gravarInscricao({ matricula: '220002', nome: 'Ana Silva', email: 'ana@exemplo.com', projeto_id: 'p2', projeto_nome: 'Projeto B', origem: 'SITE' });
    api.reconciliar();
  });

  const alunos = {};
  amb.falso.documentos.forEach((v, k) => { if (k.indexOf('alunos/') === 0) alunos[k.slice(7)] = v; });
  const alvo = Object.keys(alunos).find((k) => alunos[k].inscricao_id && alunos[k].inscricao_id.stringValue);

  const r = amb.chamar('editarAluno', { id: alvo, matricula: '110001' });
  verdadeiro(r.ok, 'a correção foi recusada: ' + r.erro);

  const aviso = (r.avisos || []).join(' ');
  verdadeiro(aviso.indexOf('220002 continua em 1 outra(s) inscrição') !== -1,
    'a inscrição que ficou para trás não foi dita: ' + aviso);
  verdadeiro(aviso.indexOf('"Projeto A"') !== -1 || aviso.indexOf('"Projeto B"') !== -1,
    'o aviso não nomeia o projeto onde ela ficou: ' + aviso);

  // E a trilha registra o fato, com o número — sem o nome de ninguém.
  const trilha = [];
  amb.falso.documentos.forEach((v, k) => {
    if (k.indexOf('log/') === 0 && v.acao.stringValue === 'ALUNO_EDITADO') trilha.push(v.detalhe.stringValue);
  });
  verdadeiro(trilha.join(' ').indexOf('FICARAM com a matrícula antiga') !== -1,
    'o histórico não registrou a correção parcial: ' + trilha.join(' | '));
});

/**
 * A matrícula nova já é de outra pessoa, em OUTRO projeto.
 *
 * O 409 não dispara — projetos diferentes, endereços diferentes — e a
 * reconciliação funde as duas pessoas numa ficha só, com um nome só. Nenhuma
 * inscrição se perde, e ainda assim uma pessoa some do cadastro.
 */
teste('a fusão de duas fichas é dita ANTES de a coordenação ir embora', () => {
  const amb = servidor((api) => {
    api.semearConfigPadrao_();
    api.inserir('projetos', { nome: 'Projeto A', vagas: '10', ativo: 'SIM', inscricoes_abertas: 'SIM', ordem: '1' }, 'p1');
    api.inserir('projetos', { nome: 'Projeto B', vagas: '10', ativo: 'SIM', inscricoes_abertas: 'SIM', ordem: '2' }, 'p2');
    api.escreverEmLote('matriculados', [
      { _id: '110001', matricula: '110001', nome: 'Carlos Reis', turma: 'ADS11', curso: 'ADS', lote_id: 'L1' },
      { _id: '220002', matricula: '220002', nome: 'Bruno Souza', turma: 'DIR21', curso: 'DIREITO', lote_id: 'L1' }
    ]);
    api.gravarInscricao({ matricula: '220002', nome: 'Ana Silva', email: 'ana@exemplo.com', projeto_id: 'p1', projeto_nome: 'Projeto A', origem: 'SITE' });
    api.gravarInscricao({ matricula: '110001', nome: 'Carlos Reis', email: 'carlos@exemplo.com', projeto_id: 'p2', projeto_nome: 'Projeto B', origem: 'SITE' });
    api.reconciliar();
  });

  const alunos = {};
  amb.falso.documentos.forEach((v, k) => { if (k.indexOf('alunos/') === 0) alunos[k.slice(7)] = v; });
  const daAna = Object.keys(alunos).find((k) => alunos[k].projeto && alunos[k].projeto.stringValue === 'Projeto A');

  const r = amb.chamar('editarAluno', { id: daAna, matricula: '110001' });
  verdadeiro(r.ok, 'a correção foi recusada: ' + r.erro);

  const aviso = (r.avisos || []).join(' ');
  verdadeiro(aviso.indexOf('110001 já estava em 1 inscrição') !== -1,
    'a fusão não foi avisada: ' + aviso);
  verdadeiro(aviso.indexOf('Carlos Reis') !== -1,
    'o aviso não diz de quem era a matrícula, que é o que denuncia o erro de digitação: ' + aviso);
  verdadeiro(aviso.indexOf('numa ficha só') !== -1, 'o aviso não diz o que vai acontecer: ' + aviso);

  // A fusão ACONTECE — o aviso não é uma recusa. Nenhuma inscrição se perdeu.
  igual(inscricoesDe(amb).length, 2, 'a fusão comeu uma inscrição');
});

teste('a correção limpa não inventa aviso nenhum', () => {
  const amb = servidor((api) => {
    api.semearConfigPadrao_();
    api.inserir('projetos', { nome: 'Projeto A', vagas: '10', ativo: 'SIM', inscricoes_abertas: 'SIM', ordem: '1' }, 'p1');
    api.escreverEmLote('matriculados', [
      { _id: '110001', matricula: '110001', nome: 'Ana Silva', turma: 'ADS11', curso: 'ADS', lote_id: 'L1' },
      { _id: '220002', matricula: '220002', nome: 'Bruno Souza', turma: 'DIR21', curso: 'DIREITO', lote_id: 'L1' }
    ]);
    api.gravarInscricao({ matricula: '220002', nome: 'Ana Silva', email: 'ana@exemplo.com', projeto_id: 'p1', projeto_nome: 'Projeto A', origem: 'SITE' });
    api.reconciliar();
  });

  const alunos = {};
  amb.falso.documentos.forEach((v, k) => { if (k.indexOf('alunos/') === 0) alunos[k.slice(7)] = v; });
  const alvo = Object.keys(alunos).find((k) => alunos[k].inscricao_id && alunos[k].inscricao_id.stringValue);

  const r = amb.chamar('editarAluno', { id: alvo, matricula: '110001' });
  verdadeiro(r.ok, r.erro);
  igual(r.avisos.filter((a) => a.indexOf('ATENÇÃO') === 0), [],
    'inventou aviso onde não havia vizinhança nenhuma');
});

teste('a inscrição recém-gravada não conta como vizinha de si mesma', () => {
  const amb = servidor((api) => {
    api.semearConfigPadrao_();
    api.inserir('projetos', { nome: 'Projeto A', vagas: '10', ativo: 'SIM', inscricoes_abertas: 'SIM', ordem: '1' }, 'p1');
    api.escreverEmLote('matriculados', [
      { _id: '110001', matricula: '110001', nome: 'Ana Silva', turma: 'ADS11', curso: 'ADS', lote_id: 'L1' }
    ]);
    api.gravarInscricao({ matricula: '220002', nome: 'Ana Silva', email: 'ana@exemplo.com', projeto_id: 'p1', projeto_nome: 'Projeto A', origem: 'SITE' });
    api.reconciliar();
  });

  const alunos = {};
  amb.falso.documentos.forEach((v, k) => { if (k.indexOf('alunos/') === 0) alunos[k.slice(7)] = v; });
  const alvo = Object.keys(alunos).find((k) => alunos[k].inscricao_id && alunos[k].inscricao_id.stringValue);

  const r = amb.chamar('editarAluno', { id: alvo, matricula: '110001' });
  verdadeiro((r.avisos || []).join(' ').indexOf('já estava em') === -1,
    'a própria inscrição virou vizinha: ' + (r.avisos || []).join(' '));
});

teste('a conferência da vizinhança NÃO acontece antes da escrita', () => {
  const amb = servidor((api) => {
    api.semearConfigPadrao_();
    api.inserir('projetos', { nome: 'Projeto A', vagas: '10', ativo: 'SIM', inscricoes_abertas: 'SIM', ordem: '1' }, 'p1');
    api.escreverEmLote('matriculados', [
      { _id: '110001', matricula: '110001', nome: 'Ana Silva', turma: 'ADS11', curso: 'ADS', lote_id: 'L1' }
    ]);
    api.gravarInscricao({ matricula: '220002', nome: 'Ana Silva', email: 'ana@exemplo.com', projeto_id: 'p1', projeto_nome: 'Projeto A', origem: 'SITE' });
    api.reconciliar();
  });

  const alunos = {};
  amb.falso.documentos.forEach((v, k) => { if (k.indexOf('alunos/') === 0) alunos[k.slice(7)] = v; });
  const alvo = Object.keys(alunos).find((k) => alunos[k].inscricao_id && alunos[k].inscricao_id.stringValue);

  amb.falso.requisicoes.length = 0;
  amb.chamar('editarAluno', { id: alvo, matricula: '110001' });

  // A primeira ida a `inscricoes` tem de ser a ESCRITA. Quem garante a unicidade
  // continua sendo o 409 do banco, e não uma consulta nossa.
  const primeira = amb.falso.requisicoes.filter((r) => r.url.indexOf('/inscricoes') !== -1 ||
    r.url.indexOf(':runQuery') !== -1)[0];
  verdadeiro(primeira && primeira.url.indexOf(':runQuery') === -1,
    'apareceu uma consulta antes da escrita: ' + (primeira && primeira.url));
});

teste('vizinhança que falha vira aviso, e não derruba a correção', () => {
  const amb = servidor((api) => {
    api.semearConfigPadrao_();
    api.inserir('projetos', { nome: 'Projeto A', vagas: '10', ativo: 'SIM', inscricoes_abertas: 'SIM', ordem: '1' }, 'p1');
    api.escreverEmLote('matriculados', [
      { _id: '110001', matricula: '110001', nome: 'Ana Silva', turma: 'ADS11', curso: 'ADS', lote_id: 'L1' }
    ]);
    api.gravarInscricao({ matricula: '220002', nome: 'Ana Silva', email: 'ana@exemplo.com', projeto_id: 'p1', projeto_nome: 'Projeto A', origem: 'SITE' });
    api.reconciliar();
  });

  const alunos = {};
  amb.falso.documentos.forEach((v, k) => { if (k.indexOf('alunos/') === 0) alunos[k.slice(7)] = v; });
  const alvo = Object.keys(alunos).find((k) => alunos[k].inscricao_id && alunos[k].inscricao_id.stringValue);

  // A consulta da vizinhança é a primeira coisa depois da escrita: três recusas
  // seguidas esgotam as retentativas de `fsFetch_` e a fazem estourar.
  const original = amb.api.gravarInscricaoEditada_;
  amb.api.gravarInscricaoEditada_ = function (inscricao, plano) {
    const saida = original(inscricao, plano);
    amb.falso.forcar(500, 'INTERNAL', 'consulta indisponível');
    amb.falso.forcar(500, 'INTERNAL', 'consulta indisponível');
    amb.falso.forcar(500, 'INTERNAL', 'consulta indisponível');
    return saida;
  };

  const r = amb.chamar('editarAluno', { id: alvo, matricula: '110001' });
  verdadeiro(r.ok, 'a falha da conferência derrubou a correção: ' + r.erro);
  verdadeiro((r.avisos || []).join(' ').indexOf('Não consegui conferir') !== -1,
    'a falha da conferência passou calada: ' + JSON.stringify(r.avisos));

  const inscricoes = inscricoesDe(amb);
  igual(inscricoes.length, 1, 'a inscrição se perdeu');
  igual(inscricoes[0].matricula, '110001', 'a correção não foi gravada');
});

process.exit(resultado());
