/**
 * reconciliacao.js — prova o cruzamento (06_Reconciliacao.gs) sem tocar no Google.
 *
 * O que se prova aqui, em ordem de importância:
 *
 *   1. UPSERT POR DIFERENÇA. Rodar duas vezes com o mesmo dado não faz NENHUMA
 *      escrita na segunda — nem de aluno, nem de agregado, nem de log. É o teste
 *      que existe para impedir o retorno do `substituirTudo`: o desenho antigo
 *      gastava ~5.000 operações por rodada e, em oito cliques, deixava as
 *      INSCRIÇÕES sem cota de escrita até a meia-noite do Pacífico.
 *   2. ID DETERMINÍSTICO. Mesma pessoa, mesmo documento, sempre — inclusive
 *      quando ela sai da lista oficial e entra pela inscrição, que é a transição
 *      que no desenho antigo criava documento novo e órfão.
 *   3. O CONTRATO COM O PAINEL. `matricula_id` e `inscricao_id` são endereços de
 *      verdade (leitura de ponto), `cpf` e `email` existem mesmo vazios, e não há
 *      campo `id`. Quando 10_Painel.gs está presente, o teste exercita
 *      `resolverAluno` e `detalheAluno` de verdade sobre o que este arquivo grava.
 *   4. A cascata, degrau por degrau, com os limiares que vieram da produção.
 *   5. A sincronização do Forms, inclusive o que ela NÃO faz sem `form_id`.
 *
 * O Firestore falso e o relator vêm de `apoio.js`. O que está aqui e não lá é o
 * `FormApp` falso, porque `apoio.js` é compartilhado com as outras fases.
 *
 * Uso:  node testes/reconciliacao.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  teste, grupo, igual, verdadeiro, resultado, criarAmbiente, criarRelogio
} = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');

// Ordem alfabética, a mesma em que o editor do Apps Script carrega os arquivos.
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '03_Config.gs',
  '04_Inscricoes.gs', '04_Log.gs', '06_Reconciliacao.gs', '07_Auth.gs'];

const TEM_PAINEL = fs.existsSync(path.join(PASTA_GS, '10_Painel.gs'));

// ------------------------------------------------------------ Apoio local

/**
 * Ambiente com sessão de administrador já aberta.
 *
 * O relógio é sempre controlado: `agora()` carimba `atualizado_em`, e provar que
 * ele NÃO mudou quando nada mudou exige poder fazer o tempo andar de propósito.
 */
function ambiente(opcoes) {
  opcoes = opcoes || {};
  const relogio = criarRelogio(Date.UTC(2026, 7, 6, 12, 0, 0));
  const amb = criarAmbiente({
    arquivos: opcoes.arquivos || GS,
    usuario: 'coordenacao@exemplo.com',
    relogio: relogio
  });
  amb.relogio = relogio;
  amb.token = amb.api.criarSessao_('coordenacao@exemplo.com');
  return amb;
}

/**
 * Grava uma linha da lista oficial como a importação grava: id do documento = a
 * matrícula normalizada. Usar o mesmo caminho de escrita é o que faz este teste
 * valer como contrato, e não como simulação.
 */
function semearMatriculado(amb, dados) {
  const reg = Object.assign({
    lote_id: 'lote_teste', importado_em: '2026-08-01 09:00:00', importado_por: 'coordenacao@exemplo.com',
    nome: '', cpf: '', email: '', matricula: '', telefone: '',
    data_nascimento: '', curso: '', turma: '', situacao: '', raw_json: '[]'
  }, dados);

  reg.matricula = amb.api.normalizarMatricula(reg.matricula);
  reg._id = reg.matricula;
  amb.api.escreverEmLote('matriculados', [reg]);
  return reg;
}

/** Grava uma inscrição pelo caminho de verdade — a chave de dedup é a real. */
function semearInscricao(amb, dados) {
  return amb.api.gravarInscricao(dados);
}

/**
 * Uma requisição é escrita quando não é consulta.
 *
 * `:runQuery` e `:runAggregationQuery` também são POST — contar POST cru diria
 * que toda rodada escreve, e o teste mais importante deste arquivo passaria a
 * medir a coisa errada.
 */
function ehEscrita(r) {
  if (r.metodo === 'PATCH' || r.metodo === 'DELETE') return true;
  if (r.metodo !== 'POST') return false;
  return !/:runQuery|:runAggregationQuery|:listCollectionIds/.test(r.url);
}

function escritasDesde(amb, marca) {
  return amb.falso.requisicoes.slice(marca).filter(ehEscrita);
}

function requisicoesDesde(amb, marca) {
  return amb.falso.requisicoes.slice(marca);
}

/** Os alunos gravados, como o painel os leria. */
function alunosGravados(amb) {
  return amb.api.listar('alunos', {}).itens;
}

function alunoPorNome(amb, nome) {
  const achados = alunosGravados(amb).filter((a) => a.nome === nome);
  if (achados.length !== 1) {
    throw new Error('esperava 1 aluno chamado "' + nome + '", achei ' + achados.length);
  }
  return achados[0];
}

// ------------------------------------------------------------ Forms falso

function criarResposta(registro) {
  return {
    getTimestamp: () => new Date(registro.quando),
    getItemResponses: () => Object.keys(registro.campos).map((titulo) => ({
      getItem: () => ({ getTitle: () => titulo }),
      getResponse: () => registro.campos[titulo]
    }))
  };
}

/**
 * FormApp com o pouco que a sincronização usa: abrir por id e listar respostas a
 * partir de um instante. O filtro por data é o comportamento que a marca d'água
 * depende de existir.
 */
function criarFormsFalso(respostas) {
  return {
    openById(id) {
      if (id !== 'form-ok') throw new Error('No item with the given ID could be found');
      return {
        getResponses(desde) {
          return respostas
            .filter((r) => !desde || new Date(r.quando).getTime() > desde.getTime())
            .sort((a, b) => (a.quando < b.quando ? -1 : 1))
            .map(criarResposta);
        }
      };
    }
  };
}

/**
 * O "Carimbo de data/hora" está aqui de propósito.
 *
 * A API do Forms não o devolve como item de resposta, mas a aba vinculada ao
 * formulário o traz como primeira coluna, e é dela que sai o CSV que alguém
 * acaba importando. Ele casa com "matrícula" por 0,85 — 'ra' é sinônimo, de
 * "registro acadêmico", e "hora" contém 'ra'. Se a pergunta certa não vencer
 * pelo score, a matrícula do aluno vira a data de envio e a cascata inteira
 * desanda por nome.
 */
const RESPOSTAS_FORMS = [
  {
    quando: '2026-08-01T12:00:00.000Z',
    campos: {
      'Carimbo de data/hora': '01/08/2026 09:00:00',
      'Nome completo': 'Ana Paula Souza',
      'E-mail': 'ANA@exemplo.com',
      'Matrícula': '091.100-01',
      'Seu WhatsApp': '(48) 99999-1111',
      'Autorizo o uso dos meus dados (LGPD)': 'Sim, autorizo'
    }
  },
  {
    quando: '2026-08-02T12:00:00.000Z',
    campos: {
      'Nome completo': 'Bruno Lima',
      'E-mail': 'bruno@exemplo.com',
      'Matrícula': '09110002'
    }
  }
];

// ------------------------------------------------------------ O conserto

grupo('upsert por diferença — o teste que não pode ficar vermelho');

teste('a segunda rodada com o mesmo dado não faz NENHUMA escrita', () => {
  // É o invariante inteiro deste arquivo. O desenho antigo (`substituirTudo` +
  // `uid('alu')` novo a cada rodada) gastaria aqui 2 escritas + 2 exclusões, e a
  // reconciliação roda no botão, em toda importação e em toda sincronização.
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', curso: 'ADS', turma: 'ADS11' });
  semearMatriculado(amb, { nome: 'Bruno Lima', matricula: '09110002', curso: 'ADM' });
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001', projeto_id: 'p1', projeto_nome: 'R+ CIDADES' });

  amb.api.reconciliar();

  const marca = amb.falso.requisicoes.length;
  amb.relogio.avancar(3600 * 1000);
  const resumo = amb.api.reconciliar();

  igual(escritasDesde(amb, marca).length, 0, 'a segunda rodada escreveu');
  igual(resumo.escritos, 0);
  igual(resumo.inalterados, 2);
  igual(resumo.removidos, 0);
});

teste('nem o log é escrito quando nada mudou', () => {
  // O log é uma escrita como qualquer outra, e sai da mesma cota das inscrições.
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  amb.api.reconciliar();

  const antes = amb.api.contar('log');
  amb.api.reconciliar();
  igual(amb.api.contar('log'), antes, 'rodada sem mudança anotou no log');
});

teste('a primeira rodada grava em bloco, não um documento por vez', () => {
  const amb = ambiente();
  for (let i = 0; i < 30; i++) {
    semearMatriculado(amb, { nome: 'Aluno Numero ' + i, matricula: '0911' + (1000 + i) });
  }

  const marca = amb.falso.requisicoes.length;
  const resumo = amb.api.reconciliar();

  igual(resumo.total, 30);
  igual(resumo.escritos, 30);
  // 30 alunos num commit, 1 agregado de cursos, 1 log. Trinta requisições de
  // escrita não caberiam nos 6 minutos de execução (ver `fsToken_`, 02_Repo.gs).
  igual(escritasDesde(amb, marca).length, 3);
});

teste('atualizado_em só muda quando o conteúdo muda', () => {
  // É o detalhe que faz a diferença fechar em zero: se `atualizado_em` entrasse
  // na comparação, todo documento seria diferente em toda rodada.
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  amb.api.reconciliar();
  const primeiro = alunoPorNome(amb, 'Ana Paula Souza').atualizado_em;

  amb.relogio.avancar(2 * 3600 * 1000);
  amb.api.reconciliar();
  igual(alunoPorNome(amb, 'Ana Paula Souza').atualizado_em, primeiro, 'carimbo mexeu à toa');

  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', turma: 'ADS21' });
  amb.api.reconciliar();
  const depois = alunoPorNome(amb, 'Ana Paula Souza');
  igual(depois.turma, 'ADS21');
  verdadeiro(depois.atualizado_em !== primeiro, 'mudou o dado e o carimbo ficou parado');
});

teste('mudar um aluno reescreve só ele', () => {
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', curso: 'ADS' });
  semearMatriculado(amb, { nome: 'Bruno Lima', matricula: '09110002', curso: 'ADS' });
  amb.api.reconciliar();

  // Turma, e não curso: mexer no curso mexeria também no agregado, e o teste
  // deixaria de medir só a diferença de alunos.
  semearMatriculado(amb, { nome: 'Bruno Lima', matricula: '09110002', curso: 'ADS', turma: 'B' });

  const marca = amb.falso.requisicoes.length;
  const resumo = amb.api.reconciliar();

  igual(resumo.escritos, 1);
  igual(resumo.inalterados, 1);
  const commits = requisicoesDesde(amb, marca).filter((r) => /:commit/.test(r.url));
  igual(commits.length, 1, 'esperava um commit só');
  igual(commits[0].corpo.writes.length, 1, 'o commit levou aluno que não mudou');
});

// ------------------------------------------------------------ Identidade

grupo('id determinístico, derivado da matrícula');

teste('o id do aluno é o mesmo em rodadas diferentes', () => {
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  amb.api.reconciliar();
  const primeiro = alunoPorNome(amb, 'Ana Paula Souza')._id;

  amb.api.reconciliar();
  igual(alunoPorNome(amb, 'Ana Paula Souza')._id, primeiro);
  igual(amb.api.contar('alunos'), 1, 'a segunda rodada criou documento novo');
});

teste('o id sai da matrícula: os dois lados da mesma pessoa são um documento só', () => {
  const amb = ambiente();
  const chave = amb.api.chaveAluno_(amb.api.chaveDePessoa_({ matricula: '091.100-01' }));

  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001', projeto_id: 'p1' });
  amb.api.reconciliar();

  igual(amb.api.contar('alunos'), 1);
  igual(alunoPorNome(amb, 'Ana Paula Souza')._id, chave, 'o id não veio da matrícula');
});

teste('quem estava só na lista oficial vira confirmado no MESMO documento', () => {
  // É a transição que o desenho antigo pagava com uma exclusão e uma criação por
  // aluno. No dia do auditório são centenas de alunos fazendo isso de uma vez.
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  amb.api.reconciliar();

  const antes = alunoPorNome(amb, 'Ana Paula Souza');
  igual(antes.status, 'SO_MATRICULADO');

  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001', projeto_id: 'p1', projeto_nome: 'R+ CIDADES' });

  const marca = amb.falso.requisicoes.length;
  const resumo = amb.api.reconciliar();
  const depois = alunoPorNome(amb, 'Ana Paula Souza');

  igual(depois._id, antes._id, 'o documento trocou de endereço');
  igual(depois.status, 'CONFIRMADO');
  igual(depois.projeto, 'R+ CIDADES');
  igual(resumo.removidos, 0);
  igual(requisicoesDesde(amb, marca).filter((r) => r.metodo === 'DELETE').length, 0,
    'a transição apagou documento');
});

teste('a mesma pessoa em dois projetos é uma linha com os dois projetos', () => {
  // Divergência assumida em relação ao sistema sobre Sheets, que produzia duas
  // linhas — e marcava a segunda como SO_INSCRITO, porque o matriculado já tinha
  // sido consumido pela primeira.
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });

  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001', projeto_id: 'p1', projeto_nome: 'R+ CIDADES' });
  amb.relogio.avancar(60 * 1000);
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001', projeto_id: 'p2', projeto_nome: 'CESUTECH DIGITAL' });

  const resumo = amb.api.reconciliar();
  const aluno = alunoPorNome(amb, 'Ana Paula Souza');

  igual(resumo.total, 1);
  igual(resumo.juntadas, 1);
  igual(aluno.status, 'CONFIRMADO', 'a segunda inscrição rebaixou a pessoa');
  igual(aluno.projeto, 'R+ CIDADES | CESUTECH DIGITAL');
});

teste('a segunda inscrição da mesma pessoa não rouba o matriculado de outra', () => {
  // A cascata marca em `usados` quem consumiu. Rodá-la para a segunda inscrição
  // de alguém que já tem linha faria ela descer os degraus — o dela já está
  // consumido — e casar por e-mail de família com OUTRA pessoa, que perderia a
  // linha de SO_MATRICULADO sem nada explicar.
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', email: 'familia@exemplo.com' });
  semearMatriculado(amb, { nome: 'Pedro Souza', matricula: '09110002', email: 'familia@exemplo.com' });

  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'familia@exemplo.com', matricula: '09110001', projeto_id: 'p1', projeto_nome: 'Primeiro' });
  amb.relogio.avancar(60 * 1000);
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'familia@exemplo.com', matricula: '09110001', projeto_id: 'p2', projeto_nome: 'Segundo' });

  const resumo = amb.api.reconciliar();
  igual(resumo.total, 2);
  igual(alunoPorNome(amb, 'Pedro Souza').status, 'SO_MATRICULADO');
  igual(alunoPorNome(amb, 'Ana Paula Souza').projeto, 'Primeiro | Segundo');
});

teste('a inscrição mais antiga é a que manda no resto da linha', () => {
  const amb = ambiente();
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'antiga@exemplo.com', matricula: '09110001', projeto_id: 'p1', projeto_nome: 'Primeiro' });
  amb.relogio.avancar(24 * 3600 * 1000);
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'nova@exemplo.com', matricula: '09110001', projeto_id: 'p2', projeto_nome: 'Segundo' });

  amb.api.reconciliar();
  const aluno = alunoPorNome(amb, 'Ana Paula Souza');
  igual(aluno.email, 'antiga@exemplo.com');
  igual(aluno.projeto, 'Primeiro | Segundo');
});

teste('inscrição sem nada que identifique ainda ganha linha própria', () => {
  // Sem chave de pessoa, duas linhas em branco cairiam no mesmo documento e uma
  // sumiria calada. O id de origem garante que cada uma apareça para revisão.
  const amb = ambiente();
  amb.api.inserir('inscricoes', { criado_em: '2026-08-01 09:00:00', nome: '', email: '', cpf: '', matricula: '' }, 'sem_um');
  amb.api.inserir('inscricoes', { criado_em: '2026-08-01 09:01:00', nome: '', email: '', cpf: '', matricula: '' }, 'sem_dois');

  const resumo = amb.api.reconciliar();
  igual(resumo.total, 2);
  igual(resumo.so_inscrito, 2);
});

// ------------------------------------------------------------ Cascata

grupo('a cascata de casamento, degrau por degrau');

function comLista(amb) {
  semearMatriculado(amb, {
    nome: 'Ana Paula Souza', matricula: '09110001', cpf: '52998224725',
    email: 'ana@unicesusc.br', data_nascimento: '2003-04-15', curso: 'ADS', turma: 'ADS11'
  });
  return amb;
}

teste('0. matrícula igual confirma', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Ana P Souza', email: 'outro@exemplo.com', matricula: '091.100-01' });
  amb.api.reconciliar();

  const a = alunoPorNome(amb, 'Ana Paula Souza');
  igual(a.status, 'CONFIRMADO');
  igual(a.metodo_match, 'Matrícula');
  igual(a.score_match, '1');
  igual(a.curso, 'ADS', 'a lista oficial manda no curso');
});

teste('0b. matrícula igual com nome de outra pessoa vira divergência', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Joao Carlos Pereira', email: 'joao@exemplo.com', matricula: '09110001' });
  amb.api.reconciliar();

  const a = alunoPorNome(amb, 'Ana Paula Souza');
  igual(a.status, 'DIVERGENCIA');
  igual(a.metodo_match, 'Matrícula (nome diverge)');
});

teste('1. CPF igual confirma', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@provedor.com', cpf: '529.982.247-25' });
  amb.api.reconciliar();
  igual(alunoPorNome(amb, 'Ana Paula Souza').metodo_match, 'CPF');
});

teste('1b. CPF igual com nome de outra pessoa vira divergência', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Joao Carlos Pereira', email: 'joao@exemplo.com', cpf: '52998224725' });
  amb.api.reconciliar();
  igual(alunoPorNome(amb, 'Ana Paula Souza').status, 'DIVERGENCIA');
});

teste('2. e-mail igual confirma, com score 0.9', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ANA@unicesusc.br' });
  amb.api.reconciliar();

  const a = alunoPorNome(amb, 'Ana Paula Souza');
  igual(a.metodo_match, 'E-mail');
  igual(a.score_match, '0.9');
});

teste('2b. e-mail igual com CPFs diferentes vira divergência', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@unicesusc.br', cpf: '11144477735' });
  amb.api.reconciliar();

  const a = alunoPorNome(amb, 'Ana Paula Souza');
  igual(a.status, 'DIVERGENCIA');
  igual(a.metodo_match, 'E-mail (CPF diverge)');
});

teste('3. nome mais data de nascimento confirma', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'ana paula souza', email: 'outra@exemplo.com', data_nascimento: '15/04/2003' });
  amb.api.reconciliar();
  igual(alunoPorNome(amb, 'Ana Paula Souza').metodo_match, 'Nome + nascimento');
});

teste('4. nome exato e único NÃO confirma sozinho', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'outra@exemplo.com' });
  amb.api.reconciliar();

  const a = alunoPorNome(amb, 'Ana Paula Souza');
  igual(a.status, 'DIVERGENCIA');
  igual(a.metodo_match, 'Nome exato');
});

teste('4b. homônimos na lista oficial não escolhem ninguém', () => {
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Maria Silva', matricula: '09110001' });
  semearMatriculado(amb, { nome: 'Maria Silva', matricula: '09110002' });
  semearInscricao(amb, { nome: 'Maria Silva', email: 'maria@exemplo.com' });

  const resumo = amb.api.reconciliar();
  igual(resumo.divergencia, 1);
  igual(resumo.so_matriculado, 2, 'os dois homônimos continuam sem dono');

  const inscrita = alunosGravados(amb).filter((a) => a.status === 'DIVERGENCIA')[0];
  igual(inscrita.metodo_match, 'Nome ambíguo (2 iguais)');
  igual(inscrita.matricula_id, '', 'apontou para um dos homônimos por chute');
});

teste('5. nome parecido sugere, e nunca confirma', () => {
  const amb = comLista(ambiente());
  // 'Anna' contra 'Ana' dá 0,96 de similaridade e passa o limiar de 0,88;
  // 'Sousa' contra 'Souza' dá 0,83 e NÃO passa — o limiar da produção é
  // apertado de propósito, e trocar o teste por um nome mais distante
  // esconderia isso.
  semearInscricao(amb, { nome: 'Anna Paula Souza', email: 'outra@exemplo.com' });
  amb.api.reconciliar();

  const a = alunoPorNome(amb, 'Ana Paula Souza');
  igual(a.status, 'DIVERGENCIA');
  verdadeiro(a.metodo_match.indexOf('Nome aproximado') === 0, a.metodo_match);
});

teste('quem não casa com nada fica SO_INSCRITO', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Carlos Eduardo Mendes', email: 'carlos@exemplo.com', matricula: '09999999' });
  const resumo = amb.api.reconciliar();

  igual(resumo.so_inscrito, 1);
  igual(resumo.so_matriculado, 1);
  igual(alunoPorNome(amb, 'Carlos Eduardo Mendes').metodo_match, '');
});

teste('um matriculado não é usado por duas inscrições', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@unicesusc.br' });
  amb.relogio.avancar(60 * 1000);
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'sosia@exemplo.com', cpf: '11144477735' });

  const resumo = amb.api.reconciliar();
  igual(resumo.total, 2, 'as duas inscrições têm chave de pessoa diferente');
  igual(resumo.confirmado, 1, 'o mesmo matriculado casou duas vezes');
});

teste('o telefone da lista oficial socorre quem nunca se inscreveu', () => {
  // O sistema sobre Sheets deixava o SO_MATRICULADO sem telefone nenhum, que é
  // justamente o aluno que a coordenação precisa procurar.
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', telefone: '(48) 99999-1111' });
  amb.api.reconciliar();
  igual(alunoPorNome(amb, 'Ana Paula Souza').telefone, '48999991111');
});

// ------------------------------------------------------------ Decisão humana

grupo('a decisão da coordenação sobrevive à rodada seguinte');

function revisar(amb, id, status) {
  amb.api.atualizar('alunos', id, {
    status: status,
    observacoes: 'conferido na secretaria',
    revisado_por: 'coordenacao@exemplo.com',
    revisado_em: '2026-08-06 10:00:00',
    atualizado_em: '2026-08-06 10:00:00'
  });
}

teste('status revisado à mão não volta ao que a cascata calculou', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'outra@exemplo.com' });
  amb.api.reconciliar();

  const id = alunoPorNome(amb, 'Ana Paula Souza')._id;
  igual(alunoPorNome(amb, 'Ana Paula Souza').status, 'DIVERGENCIA');
  revisar(amb, id, 'CONFIRMADO');

  amb.api.reconciliar();
  const depois = alunoPorNome(amb, 'Ana Paula Souza');
  igual(depois.status, 'CONFIRMADO');
  igual(depois.observacoes, 'conferido na secretaria');
  igual(depois.revisado_por, 'coordenacao@exemplo.com');
});

teste('e a rodada que a preserva não escreve nada', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'outra@exemplo.com' });
  amb.api.reconciliar();
  revisar(amb, alunoPorNome(amb, 'Ana Paula Souza')._id, 'CONFIRMADO');

  const marca = amb.falso.requisicoes.length;
  amb.api.reconciliar();
  igual(escritasDesde(amb, marca).length, 0);
});

teste('dado novo na lista oficial entra sem apagar a revisão', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'outra@exemplo.com' });
  amb.api.reconciliar();
  revisar(amb, alunoPorNome(amb, 'Ana Paula Souza')._id, 'CONFIRMADO');

  semearMatriculado(amb, {
    nome: 'Ana Paula Souza', matricula: '09110001', cpf: '52998224725',
    email: 'ana@unicesusc.br', data_nascimento: '2003-04-15', curso: 'ADS', turma: 'ADS31'
  });
  const resumo = amb.api.reconciliar();

  const depois = alunoPorNome(amb, 'Ana Paula Souza');
  igual(resumo.escritos, 1);
  igual(depois.turma, 'ADS31');
  igual(depois.status, 'CONFIRMADO');
  igual(depois.revisado_por, 'coordenacao@exemplo.com');
});

teste('a revisão é casada por documento, não por nome parecido', () => {
  // O sistema sobre Sheets indexava as decisões por "CPF, ou e-mail, ou nome":
  // dois alunos sem CPF e sem e-mail com o mesmo nome herdavam a decisão um do
  // outro. Aqui a decisão está no documento que o cálculo vai substituir.
  const amb = ambiente();
  semearInscricao(amb, { nome: 'Maria Silva', email: 'maria1@exemplo.com', matricula: '09110001' });
  semearInscricao(amb, { nome: 'Maria Silva', email: 'maria2@exemplo.com', matricula: '09110002' });
  amb.api.reconciliar();

  const alunos = alunosGravados(amb);
  igual(alunos.length, 2);
  revisar(amb, alunos[0]._id, 'CONFIRMADO');
  amb.api.reconciliar();

  const depois = alunosGravados(amb);
  igual(depois.filter((a) => a.revisado_por).length, 1, 'a decisão vazou para a homônima');
});

// ------------------------------------------------------------ O cancelado

grupo('o cancelado da lista oficial — status próprio, e só sem inscrição');

/** A marca como `aplicarRevisao` (05c_Revisao.gs) a grava: PATCH dos 4 campos. */
function cancelarNaLista(amb, matricula) {
  amb.api.atualizarEmLote('matriculados', [{
    _id: amb.api.normalizarMatricula(matricula),
    situacao_cadastro: 'CANCELADO', cancelado_em: '2026-09-21 19:00:00',
    cancelado_por: 'coordenacao@exemplo.com', cancelado_lote_id: '20260921T220000000Z_abc'
  }]);
}

teste('cancelado SEM inscrição vira CANCELADO, com a marca e a data copiadas', () => {
  // Mutação que derruba: manter SO_MATRICULADO no laço dos só-matriculados —
  // a pessoa que a lista oficial cancelou continuaria em "Todos" como se
  // faltasse se inscrever.
  const amb = comLista(ambiente());
  cancelarNaLista(amb, '09110001');
  const resumo = amb.api.reconciliar();

  const ana = alunoPorNome(amb, 'Ana Paula Souza');
  igual(ana.status, 'CANCELADO');
  igual(ana.situacao_cadastro, 'CANCELADO');
  igual(ana.cancelado_em, '2026-09-21 19:00:00');
  igual(ana.curso, 'ADS', 'a ficha continua carregando curso e turma da lista');
  igual(resumo.cancelado, 1);
  igual(resumo.so_matriculado, 0);
});

teste('cancelado COM inscrição fica com o status da cascata — ocupa vaga — e a marca viaja', () => {
  // Mutação que derruba: esconder o cancelado do índice da cascata — a inscrição
  // dele viraria SO_INSCRITO e perderia curso e turma. Ou: dar CANCELADO a quem
  // tem inscrição — sumiria de "Todos" ocupando vaga.
  const amb = comLista(ambiente());
  cancelarNaLista(amb, '09110001');
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001', projeto_id: 'p1' });
  const resumo = amb.api.reconciliar();

  const ana = alunoPorNome(amb, 'Ana Paula Souza');
  igual(ana.status, 'CONFIRMADO');
  igual(ana.situacao_cadastro, 'CANCELADO');
  igual(ana.cancelado_em, '2026-09-21 19:00:00');
  igual(ana.turma, 'ADS11');
  igual(resumo.cancelado, 0);
  igual(resumo.confirmado, 1);
});

teste('a segunda rodada sobre o cancelado não escreve nada', () => {
  const amb = comLista(ambiente());
  cancelarNaLista(amb, '09110001');
  amb.api.reconciliar();

  const marca = amb.falso.requisicoes.length;
  amb.api.reconciliar();
  igual(escritasDesde(amb, marca).length, 0);
});

teste('fichas anteriores à marca NÃO são reescritas por causa dos dois campos novos', () => {
  // `''` contra AUSENTE é igual em `mudou_`. Mutação que derruba: gravar
  // `situacao_cadastro` como algo diferente de '' para o ativo — os 2.500
  // existentes seriam regravados na primeira rodada depois do deploy.
  const amb = comLista(ambiente());
  amb.api.reconciliar();
  const id = alunoPorNome(amb, 'Ana Paula Souza')._id;

  // Uma ficha "de antes": sem as duas chaves, como a rodada anterior gravava.
  const bruto = amb.falso.documentos.get('alunos/' + id);
  delete bruto.situacao_cadastro;
  delete bruto.cancelado_em;

  const marca = amb.falso.requisicoes.length;
  amb.api.reconciliar();
  igual(escritasDesde(amb, marca).length, 0, 'a ficha antiga foi reescrita só para ganhar as chaves vazias');
});

teste('a revisão humana não segura o cancelado, e as observações ficam', () => {
  // Mutação que derruba: `preservarRevisao_` restaurando `atual.status` também
  // quando o calculado é CANCELADO — a pessoa que saiu da lista continuaria
  // "Confirmada". Ou: pular a função inteira para o CANCELADO — as observações
  // da coordenação sumiriam junto.
  // A inscrição leva a MESMA matrícula da lista: é o que faz a ficha ter o
  // mesmo id com e sem inscrição (`chaveDePessoa_` = 'mat:9110001'). Sem isso a
  // ficha de depois seria OUTRO documento, e não haveria o que preservar.
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'outra@exemplo.com', matricula: '09110001' });
  amb.api.reconciliar();
  const id = alunoPorNome(amb, 'Ana Paula Souza')._id;
  revisar(amb, id, 'DIVERGENCIA');
  amb.api.reconciliar();
  igual(alunoPorNome(amb, 'Ana Paula Souza').status, 'DIVERGENCIA', 'a decisão humana vale enquanto a pessoa está na lista');

  // A inscrição some (anulada pela revisão) e a lista cancela a pessoa.
  amb.api.excluir('inscricoes', alunoPorNome(amb, 'Ana Paula Souza').inscricao_id);
  cancelarNaLista(amb, '09110001');
  amb.api.reconciliar();

  const cancelada = alunoPorNome(amb, 'Ana Paula Souza');
  igual(cancelada._id, id, 'a ficha tem de ser a mesma');
  igual(cancelada.status, 'CANCELADO');
  igual(cancelada.observacoes, 'conferido na secretaria');
  igual(cancelada.revisado_por, 'coordenacao@exemplo.com');
});

teste('reativada pela reimportação, a ficha sai de CANCELADO (não fica presa) e guarda as observações', () => {
  // O gravado é CANCELADO e há `revisado_por`: restaurar `atual.status` deixaria
  // a ficha em CANCELADO para sempre, com a pessoa de volta na lista. Mutação
  // que derruba: tirar `atual.status !== CANCELADO` de `preservarRevisao_`.
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'outra@exemplo.com', matricula: '09110001' });
  amb.api.reconciliar();
  const id = alunoPorNome(amb, 'Ana Paula Souza')._id;
  revisar(amb, id, 'DIVERGENCIA');
  amb.api.excluir('inscricoes', alunoPorNome(amb, 'Ana Paula Souza').inscricao_id);
  cancelarNaLista(amb, '09110001');
  amb.api.reconciliar();
  igual(alunoPorNome(amb, 'Ana Paula Souza').status, 'CANCELADO');

  // A reimportação: o documento da lista volta inteiro, sem a marca.
  comLista(amb);
  amb.api.reconciliar();

  const voltou = alunoPorNome(amb, 'Ana Paula Souza');
  igual(voltou.status, 'SO_MATRICULADO', 'o status recalculado tem de vencer o CANCELADO gravado');
  igual(voltou.situacao_cadastro, '');
  igual(voltou.cancelado_em, '');
  igual(voltou.observacoes, 'conferido na secretaria');
  igual(voltou.revisado_por, 'coordenacao@exemplo.com');
});

teste('o histograma de cursos não conta o cancelado', () => {
  // Mutação que derruba: tirar o `return` de `atualizarAgregadoDeCursos_` —
  // o cartão "Alunos por curso" fecharia com um total que a aba Alunos não mostra.
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', curso: 'ADS' });
  semearMatriculado(amb, { nome: 'Bruno Lima', matricula: '09110002', curso: 'ADS' });
  cancelarNaLista(amb, '09110002');
  amb.api.reconciliar();

  igual(amb.api.ler('agregados', 'cursos').ADS, '1');
});

// ------------------------------------------------------------ Remoções

grupo('linhas sem origem — apagar é o caminho perigoso');

teste('linha que perdeu as duas origens é apagada', () => {
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  semearMatriculado(amb, { nome: 'Bruno Lima', matricula: '09110002' });
  amb.api.reconciliar();
  igual(amb.api.contar('alunos'), 2);

  amb.api.excluir('matriculados', amb.api.normalizarMatricula('09110002'));
  const resumo = amb.api.reconciliar();

  igual(resumo.removidos, 1);
  igual(resumo.aviso, '');
  igual(amb.api.contar('alunos'), 1);
  igual(alunosGravados(amb)[0].nome, 'Ana Paula Souza');
});

teste('cadastro calculado vazio NÃO apaga o que está gravado', () => {
  // Duas coleções de origem vazias é falha de leitura ou coleção esvaziada sem
  // querer — nunca "todos os alunos sumiram". Apagar levaria junto as
  // divergências já resolvidas.
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  amb.api.reconciliar();

  amb.api.excluir('matriculados', amb.api.normalizarMatricula('09110001'));
  const resumo = amb.api.reconciliar();

  igual(resumo.removidos, 0);
  igual(amb.api.contar('alunos'), 1);
  verdadeiro(resumo.aviso.indexOf('Não apaguei nada') === 0, resumo.aviso);
});

teste('remoção em massa é recusada, e a rodada continua atualizando', () => {
  const amb = ambiente();
  for (let i = 0; i < 4; i++) {
    semearMatriculado(amb, { nome: 'Aluno Numero ' + i, matricula: '0911050' + i });
  }
  amb.api.reconciliar();

  amb.api.RECONCILIACAO_MAX_REMOCOES = 1;
  for (let i = 1; i < 4; i++) amb.api.excluir('matriculados', amb.api.normalizarMatricula('0911050' + i));
  semearMatriculado(amb, { nome: 'Aluno Numero 0', matricula: '09110500', turma: 'NOVA' });

  const resumo = amb.api.reconciliar();
  igual(resumo.removidos, 0);
  igual(resumo.escritos, 1, 'recusar a remoção não pode recusar a atualização');
  verdadeiro(resumo.aviso.indexOf('3 linhas') === 0, resumo.aviso);
  igual(amb.api.contar('alunos'), 4);
});

// ------------------------------------------------- O incremental de uma pessoa

grupo('reconciliarPessoa_ — a mesma ficha da rodada, por 2 a 4 requisições');

/** A ficha, sem o carimbo do banco: `_versao` conta escritas, não conteúdo. */
function fichaDaMatricula(amb, matricula) {
  const ficha = amb.api.ler('alunos', amb.api.chaveAluno_('mat:' + amb.api.normalizarMatricula(matricula)));
  if (!ficha) return null;

  // Chaves ordenadas: o que se compara é CAMPO A CAMPO, e não a ordem em que
  // dois caminhos diferentes montaram o mesmo documento.
  const comparavel = {};
  Object.keys(ficha).sort().forEach((campo) => {
    if (campo !== '_versao') comparavel[campo] = ficha[campo];
  });
  return comparavel;
}

/**
 * O MESMO cenário em dois ambientes: num deles a rodada inteira, no outro só o
 * incremental. É a única forma honesta de provar equivalência — comparar os dois
 * documentos, e não uma lista de campos que alguém lembrou de conferir.
 *
 * O relógio dos dois ambientes começa igual e anda igual, então `atualizado_em`
 * também entra na comparação em vez de ser perdoado.
 */
function doisCaminhos(caso) {
  const rodada = ambiente();
  const incremental = ambiente();

  [rodada, incremental].forEach((amb) => {
    caso.semear(amb);
    if (caso.cruzarAntes) amb.api.reconciliar();
    caso.novidade(amb);
  });

  rodada.api.reconciliar();
  const r = incremental.api.reconciliarPessoa_(caso.matricula);
  return { rodada: rodada, incremental: incremental, resultado: r };
}

/** Os quatro casos que o incremental decide sozinho — os quatro do dia a dia. */
const CASOS_SEGUROS = [
  {
    nome: 'matrícula exata, ficha nova',
    matricula: '09110001',
    semear: (amb) => { comLista(amb); },
    novidade: (amb) => {
      semearInscricao(amb, {
        nome: 'Ana P Souza', email: 'ana@exemplo.com', matricula: '091.100-01',
        projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
      });
    }
  },
  {
    nome: 'SO_MATRICULADO vira CONFIRMADO — o caso do auditório',
    matricula: '09110001',
    cruzarAntes: true,
    semear: (amb) => { comLista(amb); },
    novidade: (amb) => {
      semearInscricao(amb, {
        nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
        projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
      });
    }
  },
  {
    nome: 'segunda inscrição de quem já tem ficha: os projetos se somam',
    matricula: '09110001',
    cruzarAntes: true,
    semear: (amb) => {
      comLista(amb);
      semearInscricao(amb, {
        nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
        projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
      });
    },
    novidade: (amb) => {
      amb.relogio.avancar(60 * 1000);
      semearInscricao(amb, {
        nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
        projeto_id: 'p2', projeto_nome: 'CESUTECH DIGITAL'
      });
    }
  },
  {
    nome: 'sem inscrição e cancelado na lista oficial',
    matricula: '09110001',
    cruzarAntes: true,
    semear: (amb) => { comLista(amb); },
    novidade: (amb) => { cancelarNaLista(amb, '09110001'); }
  }
];

CASOS_SEGUROS.forEach((caso) => {
  teste('o incremental produz a MESMA ficha da rodada — ' + caso.nome, () => {
    // É o teste que autoriza os outros: enquanto ele passar, o incremental não é
    // um segundo entendimento de status, é a mesma cascata com menos leitura.
    // Mutação que derruba: reescrever o degrau 0 à mão; esquecer
    // `juntarProjetos_`; esquecer `cadastroCancelado_`; trocar `preservarRevisao_`
    // de lugar.
    const { rodada, incremental, resultado } = doisCaminhos(caso);

    igual(resultado.feito, true, resultado.motivo);
    igual(resultado.escreveu, true, 'a ficha mudou e o incremental não gravou');
    igual(fichaDaMatricula(incremental, caso.matricula), fichaDaMatricula(rodada, caso.matricula));
    igual(incremental.api.contar('alunos'), rodada.api.contar('alunos'),
      'o incremental criou ou deixou de criar documento');
  });
});

teste('e a rodada seguinte, sobre o que o incremental gravou, não escreve nada', () => {
  // A prova de que os dois caminhos convergem no BANCO, e não só na memória: se o
  // incremental gravasse um campo diferente, a rodada de auditoria reescreveria a
  // ficha e `escritos` seria 1. Mutação que derruba: qualquer divergência de
  // conteúdo entre `reconciliarPessoa_` e `reconciliar`.
  const amb = comLista(ambiente());
  semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });

  igual(amb.api.reconciliarPessoa_('09110001').escreveu, true);
  igual(amb.api.reconciliar().escritos, 0, 'a rodada discordou do incremental');
});

teste('o incremental duas vezes seguidas é UMA escrita', () => {
  // O upsert por diferença do arquivo inteiro, aplicado a uma pessoa: a segunda
  // chamada lê, compara e não grava. Mutação que derruba: tirar `mudou_`.
  const amb = comLista(ambiente());
  semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });

  let marca = amb.falso.requisicoes.length;
  igual(amb.api.reconciliarPessoa_('09110001').escreveu, true);
  igual(escritasDesde(amb, marca).length, 1, 'a primeira chamada tinha de gravar exatamente uma vez');

  marca = amb.falso.requisicoes.length;
  amb.relogio.avancar(3600 * 1000);
  const segunda = amb.api.reconciliarPessoa_('09110001');

  igual(segunda.feito, true);
  igual(segunda.escreveu, false);
  igual(escritasDesde(amb, marca).length, 0, 'a segunda chamada escreveu');
});

teste('depois da rodada completa, com o mesmo dado, o incremental não escreve', () => {
  const amb = comLista(ambiente());
  semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });
  amb.api.reconciliar();

  const marca = amb.falso.requisicoes.length;
  igual(amb.api.reconciliarPessoa_('09110001').escreveu, false);
  igual(escritasDesde(amb, marca).length, 0);
});

teste('o custo é o do cabeçalho: 2 consultas, 1 leitura de ponto e 1 escrita', () => {
  // O número que justifica a peça inteira: a rodada custa três coleções, este
  // custa quatro requisições. Mutação que derruba: chamar `reconciliar()` daqui,
  // ou reler o matriculado que o chamador já leu.
  const amb = comLista(ambiente());
  // O id do documento na lista oficial é a matrícula NORMALIZADA — o zero à
  // esquerda é formatação, e `normalizarMatricula` o tira (04_Inscricoes.gs).
  const oficial = amb.api.ler('matriculados', '9110001');
  semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });

  const marca = amb.falso.requisicoes.length;
  amb.api.reconciliarPessoa_('09110001', { matriculado: oficial });
  const feitas = requisicoesDesde(amb, marca);

  igual(feitas.filter((r) => /:runQuery/.test(r.url)).length, 2, 'as inscrições da pessoa e as fichas da matrícula');
  igual(feitas.filter((r) => r.metodo === 'GET').length, 1, 'a ficha que a consulta não trouxe — é dela que vem o _versao');
  igual(escritasDesde(amb, marca).length, 1);
  igual(feitas.length, 4);

  // Filtro num campo com ordenação por OUTRO exige índice COMPOSTO, e o plano é
  // Spark: as duas consultas filtram por igualdade e deixam a ordem em
  // `__name__`. A cronológica é feita na memória, como na rodada.
  feitas.filter((r) => /:runQuery/.test(r.url)).forEach((r) => {
    igual(r.corpo.structuredQuery.orderBy[0].field.fieldPath, '__name__');
    igual(r.corpo.structuredQuery.where.fieldFilter.op, 'EQUAL');
  });
});

teste('a ficha JÁ CASADA vem da consulta, e não custa leitura de ponto nenhuma', () => {
  // SO_MATRICULADO e CONFIRMADO gravam `matricula_id`, então a consulta do G3 já
  // trouxe a ficha atual — com o `_versao` junto. Mutação que derruba: ler sempre
  // por id (uma leitura por inclusão, todo dia, para reler o que já está na mão).
  const amb = comLista(ambiente());
  amb.api.reconciliar();
  // O id do documento na lista oficial é a matrícula NORMALIZADA — o zero à
  // esquerda é formatação, e `normalizarMatricula` o tira (04_Inscricoes.gs).
  const oficial = amb.api.ler('matriculados', '9110001');
  semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });

  const marca = amb.falso.requisicoes.length;
  igual(amb.api.reconciliarPessoa_('09110001', { matriculado: oficial }).escreveu, true);
  igual(requisicoesDesde(amb, marca).filter((r) => r.metodo === 'GET').length, 0);
  igual(requisicoesDesde(amb, marca).length, 3, 'duas consultas e a escrita');
});

teste('a decisão da coordenação sobrevive ao incremental, e ele não grava por causa dela', () => {
  // `preservarRevisao_` na MESMA posição da rodada. Mutação que derruba: tirá-la,
  // ou escrever sem ter lido a ficha atual — nos dois casos o status humano, as
  // observações e o "revisado por" sumiriam em silêncio, e `escreveu` viraria true.
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Joao Carlos Pereira', email: 'joao@exemplo.com', matricula: '09110001' });
  amb.api.reconciliar();

  const id = alunosGravados(amb)[0]._id;
  igual(alunosGravados(amb)[0].status, 'DIVERGENCIA', 'o cenário precisa nascer em divergência');
  revisar(amb, id, 'CONFIRMADO');

  const marca = amb.falso.requisicoes.length;
  const r = amb.api.reconciliarPessoa_('09110001');

  igual(r.feito, true);
  igual(r.escreveu, false, 'a decisão humana não muda nada, logo não há o que gravar');
  igual(escritasDesde(amb, marca).length, 0);

  const ficha = amb.api.ler('alunos', id);
  igual(ficha.status, 'CONFIRMADO');
  igual(ficha.observacoes, 'conferido na secretaria');
  igual(ficha.revisado_por, 'coordenacao@exemplo.com');
  igual(ficha.revisado_em, '2026-08-06 10:00:00');
});

teste('o CANCELADO da lista oficial passa por cima do status humano — e some quando a pessoa volta', () => {
  // Os DOIS ramos de `preservarRevisao_`, pelo incremental. Mutação que derruba:
  // inverter qualquer um deles — a pessoa cancelada continuaria "Confirmada" na
  // tela, ou a reimportada ficaria presa em CANCELADO para sempre.
  const amb = comLista(ambiente());
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'outra@exemplo.com', matricula: '09110001' });
  amb.api.reconciliar();
  const id = alunosGravados(amb)[0]._id;
  revisar(amb, id, 'DIVERGENCIA');

  amb.api.excluir('inscricoes', amb.api.ler('alunos', id).inscricao_id);
  cancelarNaLista(amb, '09110001');
  igual(amb.api.reconciliarPessoa_('09110001').status, 'CANCELADO');
  igual(amb.api.ler('alunos', id).observacoes, 'conferido na secretaria', 'a observação some junto com o status');

  // A reimportação devolve o documento da lista sem a marca.
  comLista(amb);
  igual(amb.api.reconciliarPessoa_('09110001').status, 'SO_MATRICULADO');
  igual(amb.api.ler('alunos', id).revisado_por, 'coordenacao@exemplo.com');
});

teste('G1 — sem matrícula, declina com ZERO requisições', () => {
  // O incremental é só da chave `mat:`. Mutação que derruba: aceitar `cpf:` ou
  // `pes:` — os dois exigem consulta que não existe barata, e o degrau 5 varre a
  // lista inteira.
  const amb = comLista(ambiente());
  const marca = amb.falso.requisicoes.length;

  const r = amb.api.reconciliarPessoa_('');

  igual(r.feito, false);
  igual(r.escreveu, false);
  igual(r.motivo, 'esta inscrição não tem matrícula');
  igual(requisicoesDesde(amb, marca).length, 0);
});

teste('G2 — matrícula fora da lista oficial declina, e com o matriculado na mão custa ZERO', () => {
  // `undefined` é "leia você"; `null` é "eu li e não existe". Confundir os dois
  // custaria uma leitura por inclusão para reler o que o chamador acabou de ler.
  // Mutação que derruba: consultar as inscrições antes de conferir a lista.
  const amb = comLista(ambiente());

  let marca = amb.falso.requisicoes.length;
  const semNada = amb.api.reconciliarPessoa_('09119999');
  igual(semNada.feito, false);
  igual(semNada.motivo, 'a matrícula não está na lista oficial importada');
  igual(requisicoesDesde(amb, marca).length, 1, 'a leitura de ponto da lista oficial, e nada mais');

  marca = amb.falso.requisicoes.length;
  const jaLido = amb.api.reconciliarPessoa_('09119999', { matriculado: null });
  igual(jaLido.feito, false);
  igual(jaLido.motivo, 'a matrícula não está na lista oficial importada');
  igual(requisicoesDesde(amb, marca).length, 0, 'o chamador já tinha lido: não pode custar nada');
});

teste('G3 — outra ficha já usa esta matrícula: declina sem escrever', () => {
  // Acontece quando a rodada casou este matriculado com uma pessoa de chave
  // diferente (CPF, e-mail, nome). Mutação que derruba: apagar a consulta do G3 —
  // nasceria a SEGUNDA ficha da mesma pessoa, que é o defeito que o id
  // determinístico existe para não ter.
  const amb = comLista(ambiente());
  amb.api.inserir('alunos', {
    nome: 'Ana Paula Souza', cpf: '', email: '', telefone: '', data_nascimento: '',
    matricula: '09110001', matricula_conferida: 'SIM', projeto: '', curso: '', turma: '',
    situacao: '', status: 'CONFIRMADO', metodo_match: 'CPF', score_match: '1',
    inscricao_id: '', matricula_id: '9110001', revisado_por: '', revisado_em: '',
    observacoes: '', situacao_cadastro: '', cancelado_em: '', atualizado_em: ''
  }, 'ficha_de_outra_chave');

  const marca = amb.falso.requisicoes.length;
  const r = amb.api.reconciliarPessoa_('09110001');

  igual(r.feito, false);
  igual(r.motivo, 'outra ficha do cadastro já usa esta matrícula');
  igual(escritasDesde(amb, marca).length, 0);
  igual(amb.api.contar('alunos'), 1, 'nasceu uma segunda ficha para a mesma pessoa');
});

teste('G4 — cruzamento que não é do degrau 0 declina, em vez de gravar um palpite', () => {
  // A guarda existe para o dia em que alguém mexer em `casar_`: a surpresa vira
  // declínio, e não ficha errada. Mutação que derruba: trocar a conferência do
  // método por uma asserção — ou por nada.
  const amb = comLista(ambiente());
  semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });
  amb.api.casar_ = () => ({ matriculado: null, metodo: 'Nome exato', score: 0.7, status: 'DIVERGENCIA' });

  const marca = amb.falso.requisicoes.length;
  const r = amb.api.reconciliarPessoa_('09110001');

  igual(r.feito, false);
  igual(r.motivo, 'o cruzamento desta matrícula não é decidível sozinho');
  igual(escritasDesde(amb, marca).length, 0);
});

teste('G5 — matrícula em inscrições demais declina em vez de gravar uma ficha pela metade', () => {
  // Página cheia não é "trouxe o começo". Mutação que derruba: ignorar
  // `pagina.cursor` — a ficha sairia com os vinte primeiros projetos e sem os
  // outros, e ninguém veria diferença na tela.
  const amb = comLista(ambiente());
  for (let i = 1; i <= amb.api.RECONCILIACAO_PESSOA_MAX_INSCRICOES; i++) {
    semearInscricao(amb, {
      nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
      projeto_id: 'p' + i, projeto_nome: 'Projeto ' + i
    });
    amb.relogio.avancar(60 * 1000);
  }

  const marca = amb.falso.requisicoes.length;
  const r = amb.api.reconciliarPessoa_('09110001');

  igual(r.feito, false);
  igual(r.motivo, 'esta matrícula aparece em inscrições demais para eu conferir uma a uma');
  igual(escritasDesde(amb, marca).length, 0);
});

teste('os projetos entram na ordem de CHEGADA, a mesma da rodada — e não na ordem do id', () => {
  // A consulta volta ordenada por `__name__`, que é o hash da dedup: sem
  // `porChegada_`, a ficha diria que a pessoa entrou primeiro no projeto errado e
  // o resto dela (e-mail, protocolo) viria da inscrição errada. Mutação que
  // derruba: ordenar pelo id do documento.
  const amb = comLista(ambiente());
  const primeira = semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'antiga@exemplo.com', matricula: '09110001',
    projeto_id: 'p2', projeto_nome: 'CESUTECH DIGITAL'
  });
  amb.relogio.avancar(60 * 1000);
  const segunda = semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'nova@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });

  // O cenário só tem sentido com as duas ordens DIFERENTES — senão o teste
  // passaria com a ordenação errada e não provaria nada.
  verdadeiro(String(primeira.id) > String(segunda.id),
    'a inscrição mais ANTIGA precisa ter o id maior: ' + primeira.id + ' vs ' + segunda.id);

  amb.api.reconciliarPessoa_('09110001');
  const ficha = alunosGravados(amb)[0];

  igual(ficha.projeto, 'CESUTECH DIGITAL | R+ CIDADES');
  igual(ficha.inscricao_id, primeira.id, 'a inscrição mais antiga é a que manda no resto da ficha');
  igual(ficha.email, 'antiga@exemplo.com');
});

teste('inscrição SEM projeto entra na conta, como na rodada', () => {
  // `inscricoesDaPessoa_` (04_Inscricoes.gs) pula inscrição sem `projeto_id` — o
  // formulário interno grava uma —, e a rodada não pula nada. Mutação que
  // derruba: reusar aquela consulta: a ficha passaria a sair da inscrição errada.
  const amb = comLista(ambiente());
  const interna = semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'interna@exemplo.com', matricula: '09110001'
  });
  amb.relogio.avancar(60 * 1000);
  semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'site@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });

  amb.api.reconciliarPessoa_('09110001');
  const ficha = alunosGravados(amb)[0];

  igual(ficha.inscricao_id, interna.id, 'a inscrição sem projeto é a mais antiga: é dela que a ficha sai');
  igual(ficha.email, 'interna@exemplo.com');
  igual(ficha.projeto, 'R+ CIDADES');
  igual(amb.api.reconciliar().escritos, 0, 'a rodada discordou do incremental');
});

teste('o incremental NÃO escreve o histograma de cursos', () => {
  // Um delta não é idempotente, e o documento é truncado no top-100 com desempate
  // por nome — histograma errado não parece errado. Mutação que derruba: chamar
  // `atualizarAgregadoDeCursos_` daqui.
  const amb = comLista(ambiente());
  semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });

  const marca = amb.falso.requisicoes.length;
  igual(amb.api.reconciliarPessoa_('09110001').escreveu, true);
  // A lista é tirada ANTES da conferência: ler o agregado para conferir é, ele
  // mesmo, uma requisição.
  const feitas = requisicoesDesde(amb, marca);

  igual(amb.api.ler('agregados', 'cursos'), null, 'o incremental escreveu o agregado');
  igual(feitas.filter((r) => JSON.stringify(r).indexOf('agregados') !== -1).length, 0,
    'o incremental nem leu o agregado');
});

teste('o incremental NUNCA apaga ficha', () => {
  // Remoção é global por construção: só quem perdeu as DUAS origens sai, e o teto
  // de `planejarRemocoes_` existe para não levar junto decisão humana. Mutação que
  // derruba: mandar apagar a ficha órfã que este cenário deixa para trás.
  const amb = comLista(ambiente());
  amb.api.reconciliar();
  const id = alunosGravados(amb)[0]._id;

  // A pessoa sai da lista oficial e não tem inscrição: a rodada apagaria a ficha.
  amb.api.excluir('matriculados', '9110001');

  const marca = amb.falso.requisicoes.length;
  const r = amb.api.reconciliarPessoa_('09110001');

  igual(r.feito, false);
  igual(r.motivo, 'a matrícula não está na lista oficial importada');
  igual(requisicoesDesde(amb, marca).filter((q) => q.metodo === 'DELETE').length, 0);
  verdadeiro(amb.api.ler('alunos', id), 'a ficha foi apagada pelo incremental');
});

teste('a ficha mudou entre a leitura e a escrita: declina, e o documento gravado é o do OUTRO', () => {
  // A precondição de versão, que é a diferença entre `escreverAtomico` e o upsert
  // cego. Mutação que derruba: trocar por `escreverEmLote` — a escrita passaria
  // por cima do que a outra aba gravou, sem ninguém saber.
  const amb = comLista(ambiente());
  semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });
  amb.api.reconciliar();
  const id = alunosGravados(amb)[0]._id;

  // Alguém grava DEPOIS da leitura da ficha e ANTES da escrita: `preservarRevisao_`
  // é o último ponto em que as duas já estão em mãos.
  const original = amb.api.preservarRevisao_;
  amb.api.preservarRevisao_ = function (novo, atual) {
    amb.api.preservarRevisao_ = original;
    original(novo, atual);
    amb.api.atualizar('alunos', id, { observacoes: 'escrito por outra aba' });
  };

  // Alguma mudança, para o incremental querer gravar.
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', turma: 'ADS31' });
  const r = amb.api.reconciliarPessoa_('09110001');

  igual(r.feito, false);
  igual(r.motivo, 'a ficha mudou enquanto eu recalculava');
  igual(amb.api.ler('alunos', id).observacoes, 'escrito por outra aba', 'a escrita do outro foi sobrescrita');
});

teste('a ficha NOVA apareceu entre a leitura e a escrita: declina, e o documento do OUTRO fica intacto', () => {
  // O gêmeo do teste acima para o ramo que roda em TODA primeira inclusão — o
  // `criar` com `exists: false`. O de cima só exercita o UPDATE (com `_versao`),
  // que é o caso raro; este é o comum, e ficava sem guarda nenhuma.
  //
  // Duas mutações caem aqui, e as duas deixavam a suíte inteira verde:
  //   1. trocar o `criar` por um `gravar` com `versao: atual ? atual._versao : ''`
  //      — `escreverAtomico` sem versão não põe precondição, vira upsert cego e
  //      APAGA a decisão humana que o outro acabou de gravar;
  //   2. ignorar o `jaExistia` da resposta — o `criar` recusado NÃO lança (volta
  //      `{ jaExistia: true }`), então o incremental diria `feito: true` sobre uma
  //      escrita que o banco recusou, e a tela anunciaria "A ficha em Alunos já
  //      está atualizada" sobre a ficha de outra pessoa.
  const amb = comLista(ambiente());
  semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });
  const id = amb.api.chaveAluno_('mat:' + amb.api.normalizarMatricula('09110001'));
  igual(amb.api.ler('alunos', id), null, 'o cenário exige a ficha AINDA não existindo: é o ramo do `criar`');

  // Outro escritor — a rodada das 5h, o Atualizar de outra aba, uma importação —
  // cria a ficha no mesmo endereço depois da leitura. `preservarRevisao_` é o
  // último ponto em que o incremental já leu tudo e ainda não gravou.
  const original = amb.api.preservarRevisao_;
  amb.api.preservarRevisao_ = function (calculado, atual) {
    amb.api.preservarRevisao_ = original;
    original(calculado, atual);
    amb.api.escreverEmLote('alunos', [{
      _id: id, nome: 'Ana Paula Souza', matricula_id: '9110001', matricula: '09110001',
      status: 'DIVERGENCIA', observacoes: 'conferir a matrícula na secretaria',
      revisado_por: 'coordenacao@exemplo.com', revisado_em: '2026-09-22 10:00:00'
    }]);
  };

  const r = amb.api.reconciliarPessoa_('09110001');

  igual(r.feito, false);
  igual(r.escreveu, false);
  igual(r.motivo, 'a ficha mudou enquanto eu recalculava');

  const ficha = amb.api.ler('alunos', id);
  igual(ficha.status, 'DIVERGENCIA', 'a escrita passou POR CIMA do documento do outro');
  igual(ficha.observacoes, 'conferir a matrícula na secretaria');
  igual(ficha.revisado_por, 'coordenacao@exemplo.com');
});

teste('`criar` recusado DEPOIS de uma retentativa não afirma que foi outro: ali não se pode afirmar nada', () => {
  // A régua é do próprio repositório (`escritaIndeterminada_`, 02_Repo.gs): com
  // `retentou` verdadeiro há DOIS estados possíveis — ou outra pessoa criou a
  // ficha, ou o primeiro `:commit` entrou e só a resposta se perdeu, e a ficha
  // que "já existia" é a MINHA. Quem recebe isso não pode afirmar nenhum dos
  // dois, e o `catch` logo abaixo já ordena indeterminado ANTES de corrida pela
  // mesma razão; o `jaExistia` não lança, e vinha usando a frase da corrida nos
  // dois mundos.
  //
  // A diferença é a frase que a coordenação lê: "a ficha mudou enquanto eu
  // recalculava" manda procurar quem mexeu; "não consegui confirmar a gravação"
  // manda reler, que é a única coisa verdadeira a fazer.
  //
  // Mutação que derruba: voltar a uma frase só para os dois mundos.
  const amb = comLista(ambiente());
  semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });
  amb.api.escreverAtomico = () => ({ aplicado: false, jaExistia: true, retentou: true, id: '', escritas: 1 });

  const r = amb.api.reconciliarPessoa_('09110001');

  igual(r.feito, false);
  igual(r.escreveu, false);
  igual(r.motivo, 'não consegui confirmar a gravação da ficha');
});

teste('erro na escrita vira declínio, e não estouro', () => {
  // A promessa do contrato: `reconciliarPessoa_` NUNCA lança — quem a chama já
  // gravou a inscrição, e um erro aqui não pode virar "Falha ao incluir" na tela.
  // Mutação que derruba: deixar o erro subir.
  const amb = comLista(ambiente());
  semearInscricao(amb, {
    nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001',
    projeto_id: 'p1', projeto_nome: 'R+ CIDADES'
  });
  amb.api.escreverAtomico = () => { throw new Error('a rede caiu no meio'); };

  const r = amb.api.reconciliarPessoa_('09110001');

  igual(r.feito, false);
  igual(r.escreveu, false);
  igual(r.motivo, 'não consegui gravar a ficha');
  verdadeiro(amb.registros.erros.some((linha) => /reconciliarPessoa_/.test(linha)),
    'o erro tem de ficar no console de execução: ' + JSON.stringify(amb.registros.erros));
});

teste('erro na LEITURA também vira declínio, com o motivo certo', () => {
  // O `catch` de fora cobre as duas consultas e as leituras de ponto: elas falham
  // por rede e por cota, e a tela precisa de uma frase verdadeira — nada foi
  // gravado. Mutação que derruba: cobrir só a escrita.
  const amb = comLista(ambiente());
  amb.api.listar = () => { throw new Error('cota diária de leitura esgotada'); };

  const r = amb.api.reconciliarPessoa_('09110001');

  igual(r.feito, false);
  igual(r.motivo, 'não consegui ler o cadastro para recalcular a ficha');
});

// ------------------------------------------------------------ Contrato

grupo('contrato com 10_Painel.gs');

teste('os três endereços do detalhe do aluno são leituras de ponto', () => {
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', curso: 'ADS' });
  const inscricao = semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001', projeto_id: 'p1' });
  amb.api.reconciliar();

  const aluno = alunoPorNome(amb, 'Ana Paula Souza');
  verdadeiro(amb.api.ler('alunos', aluno._id) !== null, 'o id do aluno não endereça o documento');
  // O endereço é a matrícula NORMALIZADA — sem o zero à esquerda, que é
  // formatação e não identidade (ver normalizarMatricula em 04_Inscricoes.gs).
  igual(aluno.matricula_id, '9110001');
  igual(aluno.inscricao_id, inscricao.id);
  verdadeiro(amb.api.ler('matriculados', aluno.matricula_id) !== null, 'matricula_id não é endereço');
  verdadeiro(amb.api.ler('inscricoes', aluno.inscricao_id) !== null, 'inscricao_id não é endereço');
});

teste('cpf e email existem em todo documento, mesmo vazios', () => {
  // `painelEstatisticas` conta "com CPF" como total menos os que têm `cpf`
  // igual a vazio, e no Firestore campo AUSENTE não casa com igualdade. Omitir a
  // chave faria o painel anunciar 100% de CPF em silêncio.
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  amb.api.reconciliar();

  const bruto = amb.falso.documentos.get('alunos/' + alunoPorNome(amb, 'Ana Paula Souza')._id);
  verdadeiro(bruto.cpf !== undefined, 'o campo cpf não foi gravado');
  verdadeiro(bruto.email !== undefined, 'o campo email não foi gravado');
  igual(bruto.cpf.stringValue, '');
  igual(amb.api.contar('alunos', { campo: 'cpf', valor: '' }), 1);
});

teste('não existe campo id — o id é o nome do documento', () => {
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  amb.api.reconciliar();

  const bruto = amb.falso.documentos.get('alunos/' + alunoPorNome(amb, 'Ana Paula Souza')._id);
  igual(bruto.id, undefined, 'campo id gravado é uma cópia livre para divergir');
});

teste('ALUNOS_COLECAO tem o mesmo valor em 06_Reconciliacao.gs e em 10_Painel.gs', () => {
  // Mesmo cuidado de INSCRICOES_COLECAO (testes/inscricoes.js): o Apps Script não
  // reclama de duas declarações, a última carregada vence em silêncio, e a
  // reconciliação passaria a escrever numa coleção que o painel não lê.
  const arquivos = ['06_Reconciliacao.gs'].concat(TEM_PAINEL ? ['10_Painel.gs'] : []);
  const valores = arquivos.map((arquivo) => {
    const m = /var ALUNOS_COLECAO = '([^']*)'/.exec(fs.readFileSync(path.join(PASTA_GS, arquivo), 'utf8'));
    if (!m) throw new Error(arquivo + ' não declara ALUNOS_COLECAO');
    return m[1];
  });
  igual(valores[0], 'alunos');
  valores.forEach((v) => igual(v, valores[0]));
});

if (TEM_PAINEL) {
  teste('o painel de verdade lê, detalha e resolve o que a reconciliação grava', () => {
    // Contrato exercitado com o código das DUAS fases. Enquanto o id do aluno e
    // os dois endereços não forem os que 10_Painel.gs espera, a aba Alunos abre
    // vazia ou o modal de revisão erra o documento — sem erro nenhum na tela.
    const amb = ambiente({
      arquivos: ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '03_Config.gs',
        '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs', '06_Reconciliacao.gs',
        '07_Auth.gs', '09_Projetos.gs', '10_Painel.gs']
    });
    semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', curso: 'ADS' });
    semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001', projeto_id: 'p1' });
    amb.api.reconciliar();

    const lista = amb.api.listarAlunos({ token: amb.token });
    igual(lista.ok, true);
    igual(lista.itens.length, 1);
    igual(lista.cursos, ['ADS'], 'o filtro de curso saiu do agregado que a reconciliação grava');

    const id = lista.itens[0].id;
    const detalhe = amb.api.detalheAluno({ token: amb.token, id: id });
    igual(detalhe.ok, true);
    verdadeiro(detalhe.inscricao !== null && detalhe.inscricao !== undefined, 'a inscrição não foi achada');
    verdadeiro(detalhe.matriculado !== null && detalhe.matriculado !== undefined, 'o matriculado não foi achado');

    igual(amb.api.resolverAluno({ token: amb.token, id: id, status: 'DIVERGENCIA', observacoes: 'ver' }).ok, true);
    amb.api.reconciliar();
    igual(alunoPorNome(amb, 'Ana Paula Souza').status, 'DIVERGENCIA', 'a rodada desfez a revisão do painel');

    const stats = amb.api.painelEstatisticas({ token: amb.token });
    igual(stats.dados.total, 1);
    igual(stats.dados.qualidade.percMatricula, 100, 'a inscrição trouxe matrícula, e é ela a chave medida');
    igual(stats.dados.porCurso, [{ curso: 'ADS', total: 1 }]);
  });
}

// ------------------------------------------------------------ Agregado

grupo('agregados/cursos — o GROUP BY que o Firestore não tem');

teste('um campo por curso, e o rótulo de quem não tem curso é um nome de verdade', () => {
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', curso: 'ADS' });
  semearMatriculado(amb, { nome: 'Bruno Lima', matricula: '09110002', curso: 'ADS' });
  semearMatriculado(amb, { nome: 'Carla Dias', matricula: '09110003' });
  amb.api.reconciliar();

  const doc = amb.api.ler('agregados', 'cursos');
  igual(doc.ADS, '2');
  igual(doc['(sem curso)'], '1', 'nome de campo vazio não é endereçável no Firestore');
});

teste('histograma igual não custa escrita', () => {
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', curso: 'ADS' });
  amb.api.reconciliar();

  const marca = amb.falso.requisicoes.length;
  amb.api.reconciliar();
  igual(requisicoesDesde(amb, marca).filter((r) => /:commit/.test(r.url)).length, 0);
});

teste('curso que sumiu some do documento', () => {
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', curso: 'ADS' });
  amb.api.reconciliar();
  verdadeiro(amb.api.ler('agregados', 'cursos').ADS !== undefined);

  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', curso: 'ADM' });
  amb.api.reconciliar();

  const doc = amb.api.ler('agregados', 'cursos');
  igual(doc.ADM, '1');
  igual(doc.ADS, undefined, 'o update sem máscara tinha de substituir o documento inteiro');
});

teste('o teto de cursos protege o documento de um mapeamento errado', () => {
  const amb = ambiente();
  amb.api.RECONCILIACAO_MAX_CURSOS = 3;
  for (let i = 0; i < 6; i++) {
    semearMatriculado(amb, { nome: 'Aluno Numero ' + i, matricula: '0911050' + i, curso: 'CURSO ' + i });
  }
  amb.api.reconciliar();

  const doc = amb.api.ler('agregados', 'cursos');
  const cursos = Object.keys(doc).filter((k) => k.charAt(0) !== '_' && k !== 'atualizado_em');
  igual(cursos.length, 3);
});

// ------------------------------------------------------------ Orçamento

grupo('orçamento de leitura — o número do cabeçalho, medido');

teste('a rodada lê as três coleções e o agregado, e nada mais', () => {
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001', projeto_id: 'p1' });
  amb.api.reconciliar();

  const marca = amb.falso.requisicoes.length;
  amb.api.reconciliar();

  const leituras = requisicoesDesde(amb, marca);
  igual(leituras.length, 4, leituras.map((r) => r.metodo + ' ' + r.url.split('/documents')[1]).join(' | '));
  igual(leituras.filter((r) => /:runQuery/.test(r.url)).length, 3);
  igual(leituras.filter((r) => r.metodo === 'GET').length, 1);
});

teste('nenhuma consulta declara ordenação por campo — só __name__', () => {
  // Filtro num campo com ordenação por OUTRO exige índice composto, e ordenar por
  // `criado_em` na consulta perderia inscrições empatadas no segundo, na virada
  // da página. A ordem cronológica é feita na memória.
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  amb.api.reconciliar();

  amb.falso.requisicoes.filter((r) => /:runQuery/.test(r.url)).forEach((r) => {
    igual(r.corpo.structuredQuery.orderBy[0].field.fieldPath, '__name__');
    igual(r.corpo.structuredQuery.orderBy[0].direction, 'ASCENDING');
  });
});

teste('coleção acima do teto recusa a rodada inteira, em vez de reconciliar pela metade', () => {
  const amb = ambiente();
  amb.api.RECONCILIACAO_BLOCO = 2;
  amb.api.RECONCILIACAO_TETO = 2;
  for (let i = 0; i < 5; i++) {
    semearMatriculado(amb, { nome: 'Aluno Numero ' + i, matricula: '0911050' + i });
  }

  const r = amb.api.rodarReconciliacao({ token: amb.token });
  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('matriculados') !== -1, r.erro);
  igual(amb.api.contar('alunos'), 0, 'gravou com dado pela metade');
});

// ------------------------------------------------------------ Painel

grupo('rodarReconciliacao — o botão do painel');

teste('sem token, não roda', () => {
  const amb = ambiente();
  const r = amb.api.rodarReconciliacao({});
  igual(r.ok, false);
  verdadeiro(/Sess.o expirada/.test(r.erro), r.erro);
});

teste('devolve os quatro números que a tela mostra (Admin.html:554)', () => {
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  semearMatriculado(amb, { nome: 'Bruno Lima', matricula: '09110002' });
  semearInscricao(amb, { nome: 'Ana Paula Souza', email: 'ana@exemplo.com', matricula: '09110001', projeto_id: 'p1' });
  semearInscricao(amb, { nome: 'Carla Dias', email: 'carla@exemplo.com', matricula: '09999999', projeto_id: 'p1' });

  const r = amb.api.rodarReconciliacao({ token: amb.token });
  igual(r.ok, true);
  igual(r.resumo.confirmado, 1);
  igual(r.resumo.so_matriculado, 1);
  igual(r.resumo.so_inscrito, 1);
  igual(r.resumo.divergencia, 0);
  igual(r.resumo.total, 3);
});

teste('com os dois arquivos carregados, a importação NÃO chama a reconciliação', () => {
  // Este teste provava o contrário até 06/08: que `resumoReconciliacao_`
  // (05_Importacao.gs) rodava `reconciliar()` no fim de toda importação para
  // desenhar quatro cartões. Era o acoplamento perigoso — importar 2.500 linhas e
  // reconciliar 5.500 documentos na MESMA execução de 6 minutos, ~23 idas ao
  // Firestore, com os dados já gravados quando a tela dissesse "falhou".
  //
  // O que se prova agora é a separação: os dois arquivos convivem, a
  // reconciliação continua alcançável por `rodarReconciliacao` — que é o que o
  // botão do passo 3 chama —, e a função de costura não existe mais.
  const amb = ambiente({
    arquivos: ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '02b_Drive.gs', '03_Config.gs',
      '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs', '06_Reconciliacao.gs', '07_Auth.gs']
  });
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });

  igual(typeof amb.api.resumoReconciliacao_, 'undefined',
    'a costura entre importação e reconciliação foi desfeita de propósito');
  igual(typeof amb.api.rodarReconciliacao, 'function',
    'e o botão do passo 3 precisa continuar tendo o que chamar');

  const r = amb.api.rodarReconciliacao({ token: amb.token });
  igual(r.ok, true, r.erro);
  igual(r.resumo.so_matriculado, 1);
});

teste('expurgarLote e reconciliar convivem: apagar a lista velha muda os números', () => {
  // O expurgo é a saída de emergência de `matriculados` (05_Importacao.gs). Quem
  // some da lista oficial e não se inscreveu deixa de existir para a
  // reconciliação — que é exatamente o efeito desejado, e o que impede
  // `colecaoCompleta_` de bater no teto de 8.000 com o passar dos semestres.
  const amb = ambiente({
    arquivos: ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '02b_Drive.gs', '03_Config.gs',
      '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs', '06_Reconciliacao.gs', '07_Auth.gs']
  });
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001', lote_id: 'L_VELHO' });
  semearMatriculado(amb, { nome: 'Bruno Lima', matricula: '09110002', lote_id: 'L_VELHO' });

  igual(amb.api.rodarReconciliacao({ token: amb.token }).resumo.so_matriculado, 2);

  const e = amb.api.expurgarLote({ token: amb.token, loteId: 'L_VELHO' });
  igual(e.ok, true, e.erro);
  igual(e.apagados, 2);

  igual(amb.api.rodarReconciliacao({ token: amb.token }).resumo.total, 0,
    'sem lista oficial e sem inscrições, não sobra aluno nenhum');
});

// -------------------------------------------------------- A rodada das 5h

grupo('reconciliarAutomatico — a conferência diária');

teste('a linha do log diz quantos foram gravados, e não "undefined"', () => {
  // `reconciliar()` devolve `escritos` (o resumo lá embaixo), e esta linha lia
  // `gravados` — um campo que nunca existiu. A rodada das 5h vinha anotando
  // "gravados: undefined" todo dia desde que o gatilho nasceu, justamente na
  // única linha que diz se a madrugada fez alguma coisa.
  //
  // Mutação que derruba: voltar a `r.gravados`.
  const amb = ambiente();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });
  semearMatriculado(amb, { nome: 'Bruno Lima', matricula: '09110002' });

  amb.api.reconciliarAutomatico();

  const linhas = amb.api.listar('log', {}).itens.filter((l) => l.acao === 'RECONCILIACAO_AUTOMATICA');
  igual(linhas.length, 1, 'a rodada automática não deixou trilha');
  igual(linhas[0].detalhe, 'alunos: 2, gravados: 2');
});

teste('a rodada que falha vira linha de ERRO, e não e-mail diário para o dono do script', () => {
  const amb = ambiente();
  amb.api.reconciliar = () => { throw new Error('a coleção "matriculados" passou de 8000 documentos'); };

  amb.api.reconciliarAutomatico();

  const erros = amb.api.listar('log', {}).itens.filter((l) => l.acao === 'ERRO');
  igual(erros.length, 1);
  verdadeiro(/passou de 8000/.test(erros[0].detalhe), erros[0].detalhe);
});

// ------------------------------------------------------------ Forms

grupo('sincronizarForms — o que dá para fazer sem planilha-container');

function comForms(respostas) {
  const amb = ambiente();
  amb.api.gravarConfig('form_id', 'form-ok');
  amb.api.FormApp = criarFormsFalso(respostas || RESPOSTAS_FORMS);
  return amb;
}

teste('sem form_id, diz que não há de onde ler — e não finge que procurou', () => {
  // O plano B do sistema sobre Sheets é varrer a aba "Respostas ao formulário".
  // Aqui não existe planilha nenhuma por baixo: o caminho não é difícil, é
  // impossível, e devolver "0 novas" seria mentira.
  const amb = ambiente();
  const r = amb.api.sincronizarForms({ token: amb.token });

  igual(r.ok, true);
  igual(r.resultado.novas, 0);
  verdadeiro(r.resultado.aviso.indexOf('form_id') !== -1, r.resultado.aviso);
  verdadeiro(r.resultado.aviso.indexOf('planilha') !== -1, 'o aviso não explica a perda');
});

teste('com form_id, traz as respostas e adivinha as perguntas', () => {
  const amb = comForms();
  const r = amb.api.sincronizarForms({ token: amb.token });

  igual(r.ok, true);
  igual(r.resultado.novas, 2);
  igual(r.resultado.duplicadas, 0);

  const inscricoes = amb.api.listar('inscricoes', {}).itens;
  igual(inscricoes.length, 2);
  const ana = inscricoes.filter((i) => i.matricula === '9110001')[0];
  igual(ana.nome, 'Ana Paula Souza');
  igual(ana.email, 'ana@exemplo.com');
  igual(ana.whatsapp, '48999991111');
  igual(ana.origem, 'GOOGLE_FORMS');
  igual(ana.consentimento_lgpd, 'SIM');
});

teste('a pergunta que casa melhor vence, mesmo chegando depois', () => {
  // Regra trocada em relação ao sistema sobre Sheets, que ficava com a primeira
  // pergunta a casar. Ver o comentário em `mapearParaInscricao`.
  const amb = comForms();
  amb.api.sincronizarForms({ token: amb.token });

  const ana = amb.api.listar('inscricoes', {}).itens.filter((i) => i.nome === 'Ana Paula Souza')[0];
  // '091.100-01' no formulário -> normalizada para '9110001': a pontuação sai
  // e o zero à esquerda também, porque é formatação e não identidade.
  igual(ana.matricula, '9110001', 'o carimbo de data/hora tomou o lugar da matrícula');
});

teste('a segunda sincronização não tenta gravar as mesmas respostas', () => {
  // Sem a marca d'água, cada clique custaria uma tentativa de escrita por
  // resposta já conhecida — e o botão fica ao lado do de reconciliar.
  const amb = comForms();
  amb.api.sincronizarForms({ token: amb.token });

  const marca = amb.falso.requisicoes.length;
  const r = amb.api.sincronizarForms({ token: amb.token });

  igual(r.resultado.novas, 0);
  igual(r.resultado.duplicadas, 0);
  igual(escritasDesde(amb, marca).length, 0);
});

teste('completo=true ignora a marca e refaz o histórico', () => {
  const amb = comForms();
  amb.api.sincronizarForms({ token: amb.token });

  const r = amb.api.sincronizarForms({ token: amb.token, completo: true });
  igual(r.resultado.novas, 0);
  igual(r.resultado.duplicadas, 2, 'a varredura completa não releu as respostas');
});

teste('resposta nova entra e a marca avança para o carimbo dela', () => {
  const respostas = RESPOSTAS_FORMS.slice();
  const amb = comForms(respostas);
  amb.api.sincronizarForms({ token: amb.token });

  respostas.push({
    quando: '2026-08-05T12:00:00.000Z',
    campos: { 'Nome completo': 'Carla Dias', 'E-mail': 'carla@exemplo.com', 'Matrícula': '09110003' }
  });

  const r = amb.api.sincronizarForms({ token: amb.token });
  igual(r.resultado.novas, 1);
  igual(r.resultado.duplicadas, 0);
  igual(amb.propriedades.get('sync_forms_ate'), '2026-08-05T12:00:00.000Z');
});

teste('nada novo não dispara a reconciliação', () => {
  // A reconciliação custa milhares de leituras e não tem o que recalcular.
  const amb = comForms();
  amb.api.sincronizarForms({ token: amb.token });

  const marca = amb.falso.requisicoes.length;
  amb.api.sincronizarForms({ token: amb.token });
  igual(requisicoesDesde(amb, marca).filter((r) => /alunos/.test(r.url)).length, 0);
});

teste('resposta que não identifica ninguém é contada à parte, não como duplicada', () => {
  // Todas colapsariam na mesma chave de dedup e só a primeira entraria; as
  // outras voltariam como "duplicada", que é mentira.
  const amb = comForms([
    { quando: '2026-08-01T12:00:00.000Z', campos: { 'Observações': 'oi' } },
    { quando: '2026-08-02T12:00:00.000Z', campos: { 'Observações': 'tchau' } }
  ]);

  const r = amb.api.sincronizarForms({ token: amb.token });
  igual(r.resultado.ignoradas, 2);
  igual(r.resultado.novas, 0);
  igual(r.resultado.duplicadas, 0);
});

teste('form_id errado devolve aviso que ensina o caminho, e cita o escopo CERTO', () => {
  // `FormApp` exige um escopo que o appsscript.json NÃO declara hoje. O professor
  // precisa ler o motivo, não "Falha na sincronização".
  //
  // A mensagem citava `/auth/forms.responses.readonly`, que é escopo da API REST
  // do Google Forms. Este código não usa a API REST: usa o serviço `FormApp` do
  // Apps Script, que a plataforma amarra a `/auth/forms`. Quem seguisse a
  // instrução acrescentaria um escopo que não destrava nada — e concluiria, com
  // razão para o que estava vendo, que o problema era outro.
  const amb = comForms();
  amb.api.gravarConfig('form_id', 'form-que-nao-existe');

  const r = amb.api.sincronizarForms({ token: amb.token });
  igual(r.ok, true);
  verdadeiro(r.resultado.aviso.indexOf('https://www.googleapis.com/auth/forms') !== -1,
    r.resultado.aviso);
  verdadeiro(r.resultado.aviso.indexOf('forms.responses.readonly') === -1,
    'o escopo da API REST não destrava o FormApp: ' + r.resultado.aviso);
});

teste('sem FormApp disponível, avisa em vez de estourar', () => {
  const amb = ambiente();
  amb.api.gravarConfig('form_id', 'form-ok');

  const r = amb.api.sincronizarForms({ token: amb.token });
  igual(r.ok, true);
  verdadeiro(r.resultado.aviso.indexOf('appsscript.json') !== -1, r.resultado.aviso);
});

teste('a sincronização reconcilia quando entrou resposta nova', () => {
  const amb = comForms();
  semearMatriculado(amb, { nome: 'Ana Paula Souza', matricula: '09110001' });

  const r = amb.api.sincronizarForms({ token: amb.token });
  igual(r.resultado.novas, 2);
  igual(amb.api.contar('alunos'), 2, 'a reconciliação não rodou depois da sincronização');
  igual(alunoPorNome(amb, 'Ana Paula Souza').status, 'CONFIRMADO');
});

teste('sem token, não sincroniza', () => {
  const amb = comForms();
  const r = amb.api.sincronizarForms({});
  igual(r.ok, false);
  verdadeiro(/Sess.o expirada/.test(r.erro), r.erro);
});

process.exit(resultado());
