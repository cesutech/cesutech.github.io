/**
 * 01_Utils.gs — normalização de dados e helpers.
 *
 * A reconciliação inteira depende dessas funções: aluno digita o nome de três
 * jeitos e o CPF com e sem pontuação. Normalizar antes de comparar é o que faz
 * o cruzamento funcionar.
 */

/** Remove acentos, pontuação e espaços extras. Base de toda comparação. */
function normalizarTexto(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nome em caixa alta, sem acento, para uso como chave de comparação. */
function chaveNome(v) {
  return normalizarTexto(v).toUpperCase();
}

/** "Maria  da SILVA" -> "Maria da Silva". Preposições ficam minúsculas. */
function formatarNome(v) {
  if (!v) return '';
  var minusculas = ['de', 'da', 'do', 'das', 'dos', 'e'];
  return String(v).trim().replace(/\s+/g, ' ').toLowerCase().split(' ')
    .map(function (p, i) {
      if (i > 0 && minusculas.indexOf(p) !== -1) return p;
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(' ');
}

/** Só os dígitos do CPF. */
function normalizarCpf(v) {
  if (!v) return '';
  return String(v).replace(/\D/g, '');
}

/** Valida CPF pelos dois dígitos verificadores. */
function cpfValido(v) {
  var cpf = normalizarCpf(v);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // 111.111.111-11 e afins

  for (var t = 9; t < 11; t++) {
    var soma = 0;
    for (var i = 0; i < t; i++) soma += parseInt(cpf.charAt(i), 10) * ((t + 1) - i);
    var d = ((soma * 10) % 11) % 10;
    if (d !== parseInt(cpf.charAt(t), 10)) return false;
  }
  return true;
}

/** 000.000.000-00 para exibição. */
function formatarCpf(v) {
  var cpf = normalizarCpf(v);
  if (cpf.length !== 11) return v || '';
  return cpf.slice(0, 3) + '.' + cpf.slice(3, 6) + '.' + cpf.slice(6, 9) + '-' + cpf.slice(9);
}

function normalizarEmail(v) {
  if (!v) return '';
  return String(v).trim().toLowerCase();
}

function emailValido(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizarEmail(v));
}

/**
 * Turma -> a forma em que ela é GRAVADA e COMPARADA. 'Ads11' e ' ads 11 ' viram
 * 'ADS11' e 'ADS 11'.
 *
 * Existe por um defeito de dois lados que não se falavam: o cadastro de
 * disciplinas subia a turma para caixa alta (`normalizarDisciplina_`,
 * 12_Disciplinas.gs) e a importação da lista oficial gravava o que a secretaria
 * mandou, com um `.trim()` e mais nada (05_Importacao.gs). O cruzamento "quem da
 * turma ainda não se inscreveu" casa os dois lados por IGUALDADE — é filtro do
 * Firestore, que não sabe comparar ignorando a caixa —, então uma planilha com
 * 'Ads11' fazia a tela responder ZERO sobre uma turma cheia. Zero, ali, lê-se
 * "ninguém desta turma falta se inscrever": a mentira mais cara que aquela tela
 * pode contar, porque parece boa notícia.
 *
 * Por que UMA função e não a mesma expressão repetida: é a lição de `codigoDe_`
 * (09_Projetos.gs). Duas pontas com a mesma regra escrita duas vezes é uma ponta
 * que vai mudar sozinha, e a divergência não aparece em erro nenhum — aparece
 * numa lista vazia. Quem escreve `turma` em qualquer coleção passa por aqui:
 * cadastro de disciplina, importação da lista oficial e a correção de ficha do
 * painel.
 *
 * Caixa alta porque turma é CÓDIGO ('ADM61' = ADM, 6ª fase, turma 1), e código
 * digitado em caixa baixa é o mesmo código. Acento não se toca: não há turma
 * acentuada, e tirar acento aqui seria inventar uma regra que a secretaria não
 * conhece.
 */
function normalizarTurma(v) {
  if (v === null || v === undefined) return '';

  // O QUALIFICADOR ENTRE PARÊNTESES SAI, e o espaço TODO sai junto. A mesma
  // turma chega escrita de três jeitos, e as três têm de virar uma:
  //
  //   ADM41                    o professor digitando no cadastro de disciplinas
  //   ADM 41                   o relatório de ADM
  //   ADM 41 (MATRIZ NOVA)     o mesmo relatório, com o currículo anotado
  //
  // Até 25/08 a régua preservava o espaço simples, e as três eram turmas
  // DIFERENTES para o filtro de igualdade do Firestore. O sintoma não era erro:
  // era o cruzamento "quem da turma ainda não se inscreveu" respondendo ZERO
  // sobre uma turma cheia — e zero ali se lê como "ninguém falta se inscrever",
  // que é a conta que a coordenação usa para cobrar quem falta.
  //
  // Descartar o qualificador NÃO perde informação: cada matriculado guarda
  // `raw_json` com a linha original inteira (05_Importacao.gs), então a forma
  // como a secretaria escreveu continua no registro. O que se descarta é a
  // variação de escrita da CHAVE, que é o que uma chave não pode ter.
  //
  // O preço, dito por inteiro: `ADM 41 (MATRIZ NOVA)` e `ADM 41 (MATRIZ ANTIGA)`
  // viram a MESMA turma. Se um dia a secretaria usar o qualificador para separar
  // turmas de verdade — e não só para anotar o currículo —, esta linha é a que
  // precisa mudar, e `raw_json` é de onde o dado volta.
  return String(v)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, '')
    .toUpperCase();
}

/**
 * Nome de curso -> a forma em que ele é gravado. 'Análise  e  Desenvolvimento'
 * vira 'Análise e Desenvolvimento', e a caixa fica como está.
 *
 * O tratamento é DE PROPÓSITO mais fraco que o de `normalizarTurma`, e a
 * diferença é o que cada campo é. Turma é código, lido por máquina e comparado
 * por igualdade. Curso é nome próprio, lido por GENTE — na ficha do aluno, no
 * cartão "Alunos por curso", no CSV que a coordenação abre. Subir 'Análise e
 * Desenvolvimento de Sistemas' para caixa alta destruiria informação que ninguém
 * pediu para destruir, e num campo que nenhuma consulta casa contra outro
 * cadastro: o filtro de curso do painel compara `alunos.curso` com uma lista que
 * saiu do PRÓPRIO `alunos` (`agregados/cursos`, 06_Reconciliacao.gs) — os dois
 * lados vêm da mesma escrita e não têm como divergir na caixa.
 *
 * O que sobra é o espaço duplicado, que divergir aqui SIM tem efeito visível:
 * duas linhas no histograma de cursos para o mesmo curso. É a mesma régua que o
 * cadastro de disciplinas já aplica ao campo `curso` desde sempre.
 */
function normalizarNomeDeCurso(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().replace(/\s+/g, ' ');
}

/** Telefone só com dígitos, sem o 55 do país. */
function normalizarTelefone(v) {
  if (!v) return '';
  var d = String(v).replace(/\D/g, '');
  if (d.length > 11 && d.indexOf('55') === 0) d = d.slice(2);
  return d;
}

/** (48) 99999-9999 */
function formatarTelefone(v) {
  var d = normalizarTelefone(v);
  if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
  return v || '';
}

/**
 * Aceita Date, dd/mm/aaaa, aaaa-mm-dd e serial do Excel.
 * Devolve sempre 'aaaa-mm-dd' (ordenável como texto) ou ''.
 */
function normalizarData(v) {
  if (!v && v !== 0) return '';

  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, APP.timezone, 'yyyy-MM-dd');
  }

  // Serial do Excel/Sheets: dias desde 30/12/1899.
  if (typeof v === 'number' && v > 20000 && v < 60000) {
    var base = new Date(Date.UTC(1899, 11, 30));
    base.setUTCDate(base.getUTCDate() + Math.floor(v));
    return Utilities.formatDate(base, 'UTC', 'yyyy-MM-dd');
  }

  var s = String(v).trim();
  if (!s) return '';

  var br = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (br) {
    var ano = br[3].length === 2 ? (Number(br[3]) > 30 ? '19' + br[3] : '20' + br[3]) : br[3];
    return ano + '-' + pad2(br[2]) + '-' + pad2(br[1]);
  }

  var iso = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (iso) return iso[1] + '-' + pad2(iso[2]) + '-' + pad2(iso[3]);

  return '';
}

/** 'aaaa-mm-dd' -> 'dd/mm/aaaa' para exibição. */
function formatarData(v) {
  var d = normalizarData(v);
  if (!d) return '';
  var p = d.split('-');
  return p[2] + '/' + p[1] + '/' + p[0];
}

function pad2(n) {
  return ('0' + String(n)).slice(-2);
}

function agora() {
  return Utilities.formatDate(new Date(), APP.timezone, 'yyyy-MM-dd HH:mm:ss');
}

function uid(prefixo) {
  return (prefixo || 'id') + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

/** Hash curto e estável — usado para detectar inscrição duplicada. */
function hash(texto) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(texto), Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('').slice(0, 16);
}

/**
 * Similaridade 0..1 entre dois textos (Dice sobre bigramas).
 * Usada só para sugerir match por nome — nunca confirma sozinha.
 */
function similaridade(a, b) {
  var x = normalizarTexto(a).replace(/\s/g, '');
  var y = normalizarTexto(b).replace(/\s/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;

  var bigramas = {};
  var total = 0;
  for (var i = 0; i < x.length - 1; i++) {
    var g = x.substr(i, 2);
    bigramas[g] = (bigramas[g] || 0) + 1;
  }
  for (var j = 0; j < y.length - 1; j++) {
    var h = y.substr(j, 2);
    if (bigramas[h] > 0) {
      bigramas[h]--;
      total++;
    }
  }
  return (2 * total) / (x.length - 1 + y.length - 1);
}

/**
 * Dado um cabeçalho de planilha, adivinha a qual campo canônico ele
 * corresponde. Devolve { campo, score } ou null.
 */
function adivinharCampo(cabecalho) {
  var alvo = normalizarTexto(cabecalho);
  if (!alvo) return null;

  var melhor = null;
  Object.keys(SINONIMOS).forEach(function (campo) {
    SINONIMOS[campo].forEach(function (sin) {
      var s;
      if (alvo === sin) s = 1;
      else if (alvo.indexOf(sin) !== -1 || sin.indexOf(alvo) !== -1) s = 0.85;
      else s = similaridade(alvo, sin);

      if (s >= 0.75 && (!melhor || s > melhor.score)) melhor = { campo: campo, score: s };
    });
  });
  return melhor;
}

/** Escapa texto para interpolação segura em HTML. */
function escaparHtml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
