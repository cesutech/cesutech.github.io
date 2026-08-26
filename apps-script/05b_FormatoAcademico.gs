/**
 * 05b_FormatoAcademico.gs — leitor do relatório "Relação de Alunos Matriculados"
 * do sistema acadêmico da UNICESUSC.
 *
 * Duas peculiaridades desse relatório justificam um leitor dedicado:
 *
 * 1. Nome e matrícula vêm no MESMO campo: `BEATRIZ EXEMPLO MARTINS (09110001)`.
 *    Sem separar, a matrícula — que é a chave do aluno — nunca entraria.
 *
 * 2. O CSV exportado dele repete o cabeçalho do relatório em TODA linha
 *    ("Relação de Alunos Matriculados com Telefone", "Telefone Res."…), e perde
 *    os telefones no caminho. O PDF, por outro lado, é texto de verdade, não
 *    digitalizado — dá para ler o telefone de lá com precisão.
 *
 * A saída é sempre uma matriz canônica com cabeçalho conhecido, que o mapeamento
 * de colunas já existente reconhece sozinho.
 */

var CABECALHO_ACADEMICO = ['Nome completo', 'Matrícula', 'Turma', 'Telefone'];

/** `NOME (12345678)` — a assinatura do relatório. */
var PADRAO_NOME_MATRICULA = /^(.*?)\s*\((\d{4,})\)\s*$/;

/**
 * A turma, como o sistema acadêmico a escreve.
 *
 * UMA constante, e não três cópias espalhadas: até 25/08 os três extratores
 * traziam `/\b[A-Z]{2,4}\d{2}\b/` escrito à mão, e três cópias de uma expressão
 * é como elas divergem sem ninguém notar.
 *
 * O ESPAÇO É OPCIONAL porque a secretaria usa as duas formas, no MESMO semestre:
 *
 *   ADS21                    (relatório de ADS)
 *   ADM 41 (MATRIZ NOVA)     (relatório de ADM)
 *
 * Sem o espaço no padrão, `ADM 41` não casava e a turma saía VAZIA nas 39 linhas
 * do arquivo — calada, porque turma vazia não é erro de importação. O estrago
 * aparecia depois e longe daqui: o cruzamento "quem da turma ainda não se
 * inscreveu" (12_Disciplinas.gs) casa `matriculados.turma` por igualdade, e
 * turma vazia responde ZERO sobre uma turma cheia. Zero ali se lê como "ninguém
 * falta se inscrever".
 *
 * O QUALIFICADOR ENTRE PARÊNTESES É PRESERVADO, e é decisão. `(MATRIZ NOVA)`
 * distingue currículos, e nada garante que não exista `(MATRIZ ANTIGA)` ao lado:
 * jogar fora colapsaria duas turmas diferentes numa só, em silêncio, que é o
 * modo de falha que este conserto existe para acabar. Guardar informação a mais
 * se desfaz depois; guardar a menos, não.
 *
 * A trava contra falso positivo é o parêntese ter de começar com LETRA. Sem ela,
 * `ADS11 (48)90001-0013` — telefone com DDD entre parênteses, que aparece neste
 * mesmo relatório, na coluna ao lado — viraria a turma `ADS11 (48)`.
 */
var PADRAO_TURMA = /\b[A-Z]{2,4} ?\d{2}\b(?: ?\([A-ZÀ-Ÿ][^)]*\))?/;

/** A mesma turma, quando ela é a CÉLULA inteira (caminho da matriz). */
var PADRAO_TURMA_CELULA = new RegExp('^(?:' + PADRAO_TURMA.source + ')$');

/**
 * A turma que houver no trecho, ou ''.
 *
 * Pública para o teste alcançar: é ela que carrega a trava do DDD, e a trava
 * some sem ninguém notar quando só se testa pelo caminho da matriz — lá a
 * célula é a turma inteira e o telefone mora em coluna própria, então a
 * armadilha nem chega a ser oferecida.
 */
function turmaDoTexto(trecho) {
  return (String(trecho === null || trecho === undefined ? '' : trecho)
    .match(PADRAO_TURMA) || [])[0] || '';
}

/**
 * Reconhece o formato pela presença de "NOME (MATRÍCULA)" em várias linhas.
 *
 * O limiar é 25%, não metade: o relatório vem com endereço da instituição,
 * título, cabeçalho de coluna e rodapé de contagem antes e depois da tabela, e
 * numa turma pequena essas linhas de enfeite chegam a ser a maioria — bem menos
 * da metade das linhas são aluno. Exigir metade rejeitaria justamente os
 * arquivos que se quer ler.
 *
 * O mínimo de duas linhas evita que um "(1234)" solto num arquivo qualquer
 * dispare o leitor errado.
 */
var MIN_LINHAS_ACADEMICO = 2;
var FRACAO_LINHAS_ACADEMICO = 0.25;

function ehFormatoAcademico_(textos) {
  var candidatos = textos.filter(function (t) { return String(t).trim(); });
  if (candidatos.length < MIN_LINHAS_ACADEMICO) return false;

  var casam = candidatos.filter(function (t) {
    return /\(\d{4,}\)/.test(String(t));
  }).length;

  return casam >= MIN_LINHAS_ACADEMICO &&
         casam >= candidatos.length * FRACAO_LINHAS_ACADEMICO;
}

/** Separa 'BEATRIZ EXEMPLO (09110001)' em nome e matrícula. */
function separarNomeMatricula_(texto) {
  var m = PADRAO_NOME_MATRICULA.exec(String(texto).trim());
  if (!m) return { nome: String(texto).trim(), matricula: '' };
  return { nome: m[1].trim(), matricula: m[2].trim() };
}

/**
 * Telefones brasileiros de 10 ou 11 dígitos numa linha solta.
 * Quando há dois, o relatório traz residencial primeiro e celular depois —
 * o celular é o que interessa para contato.
 */
function extrairTelefones_(texto) {
  // O MESMO relatório escreve o telefone de dois jeitos, e os dois aparecem no
  // ads11.pdf de 25/08:
  //
  //   48900010005        corrido
  //   (48)90001-0013     com DDD entre parênteses e hífen
  //
  // O padrão antigo (`/\b\d{10,11}\b/`) só via o primeiro, e o segundo saía como
  // telefone VAZIO — 5 dos 26 alunos do ads11, calados. Aqui os separadores são
  // aceitos e o número é reduzido a dígitos depois.
  var achados = [];
  var padrao = /\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}\b/g;
  var m;

  while ((m = padrao.exec(String(texto))) !== null) {
    var so = m[0].replace(/\D/g, '');
    if (so.length === 10 || so.length === 11) achados.push(so);
  }

  if (!achados.length) return '';

  // CELULAR GANHA DO FIXO, e não é preferência de estilo: quem coordena precisa
  // falar com o aluno, e onze dígitos é celular no Brasil (DDD + 9 + oito). O
  // relatório lista "Telefone Res." antes de "Telefone Cel.", então quando os
  // dois estão na mesma linha o último já era o celular — o desempate explícito
  // é para o caso em que eles NÃO estão na mesma linha (ver a linha de
  // continuação, em `extrairAcademicoDeTexto_`).
  var celulares = achados.filter(function (n) { return n.length === 11; });
  var lista = celulares.length ? celulares : achados;
  return lista[lista.length - 1];
}

// ------------------------------------------------------------ PDF

/**
 * Lê o texto extraído do PDF, linha a linha.
 *
 * Por que não separar por colunas: a coluna "Telefone Res." costuma vir vazia,
 * e aí o alinhamento por posição desloca tudo. Casar o padrão em cada linha é
 * imune a coluna faltando.
 */
function extrairAcademicoDeTexto_(texto) {
  var linhas = String(texto).split(/\r?\n/);
  var registros = [];
  var turmaCorrente = '';

  linhas.forEach(function (linha) {
    var bruta = linha.trim();
    if (!bruta) return;

    // Linhas de cabeçalho e rodapé do relatório não são alunos.
    if (/^\d+\s+aluno/i.test(bruta)) return;
    if (/rela..o de alunos|centro universit|telefone res|^rod\.|^\d{5}-\d{3}/i.test(bruta)) return;

    // "PROJETO INTERDISCIPLINAR I EM MULTIMÍDIA (PMM21)" — título da turma.
    // Se o que está entre parênteses NÃO é só dígito, é disciplina, não aluno.
    var entreParenteses = /\(([^)]+)\)\s*$/.exec(bruta);
    if (entreParenteses && !/^\d+$/.test(entreParenteses[1])) {
      turmaCorrente = entreParenteses[1].trim();
      return;
    }

    // A LINHA DE CONTINUAÇÃO. Quando o aluno tem telefone residencial, o
    // relatório empurra a turma e o celular para a linha de baixo:
    //
    //   LETICIA BORGES DE OLIVEIRA (09812127)                  4890001010
    //                              ADM 41 (MATRIZ NOVA)     48900010009
    //
    // Sem isto, esses alunos entram SEM TURMA — 6 dos 39 no adm41.pdf de 25/08,
    // calados, porque turma vazia não é erro de importação. E não serve usar a
    // turma do título como saída: no mesmo arquivo, a linha de continuação da
    // Roberta diz ADM 61, e não o ADM 41 do cabeçalho. A turma é dela, não do
    // relatório.
    //
    // As três condições são estreitas de propósito: linha SEM matrícula, COM
    // turma, e o último aluno lido ainda sem turma. Um cabeçalho de seção não
    // passa (o anterior já teria turma, ou não haveria anterior).
    if (!/\(\d{4,}\)/.test(bruta)) {
      var continuacao = turmaDoTexto(bruta);
      var ultimo = registros[registros.length - 1];
      if (continuacao && ultimo && !ultimo[2]) {
        ultimo[2] = continuacao;

        // E o TELEFONE dela também, quando for celular: a linha do aluno só
        // trazia o fixo (é o que empurrou a turma para baixo, afinal), e o
        // celular é o número por onde a coordenação fala com ele.
        var fone = extrairTelefones_(bruta);
        if (fone.length === 11) ultimo[3] = fone;
      }
      return;
    }

    // A matrícula fecha o bloco do nome; o que vem depois é turma e telefone.
    var corte = bruta.indexOf(')', bruta.search(/\(\d{4,}\)/));
    var parteNome = bruta.slice(0, corte + 1);
    var resto = bruta.slice(corte + 1).trim();

    var pessoa = separarNomeMatricula_(parteNome);
    if (!pessoa.nome || !pessoa.matricula) return;

    // A turma da própria linha ganha da turma do título: o relatório lista
    // aluno de outra fase cursando junto (ex.: PMM41 numa turma PMM21).
    var turmaLinha = turmaDoTexto(resto);

    registros.push([
      pessoa.nome,
      pessoa.matricula,
      turmaLinha || turmaCorrente,
      extrairTelefones_(resto)
    ]);
  });

  return registros;
}

/**
 * O mesmo relatório quando o extrator de PDF devolve TUDO numa linha só.
 *
 * `extrairAcademicoDeTexto_` corta por linha, o que pressupõe um aluno por
 * linha. Nem sempre é o caso: o OCR do Drive costuma achatar a tabela inteira
 * num parágrafo, e aí a turma inteira chega assim, um aluno atrás do outro:
 *
 *   ... Telefone Cel. BEATRIZ EXEMPLO MARTINS (09110001) PMM21 48999990001
 *   CARLOS EXEMPLO ANDRADE (09110800) PMM21 48999990002 DANIELA ...
 *
 * Os nomes, matrículas e telefones citados aqui são AMOSTRA SINTÉTICA: eles
 * reproduzem o FORMATO do relatório da secretaria, e não pessoas reais.
 *
 * Sem quebra de linha não há onde cortar, e o leitor por linha devolvia zero
 * aluno num arquivo que está inteiro ali. Aqui a matrícula é que serve de
 * tesoura: ela sempre fecha o nome e sempre abre o par turma/telefone.
 *
 * O que cada matrícula delimita:
 *
 *   [ ...lixo do cabeçalho... NOME ] (MATRICULA) [ TURMA TELEFONE PRÓXIMO_NOME ]
 *
 * Por isso o nome sai do trecho ANTERIOR e a turma e o telefone do trecho
 * SEGUINTE — e o mesmo trecho seguinte carrega o começo do próximo registro.
 */
function extrairAcademicoAchatado_(texto) {
  var plano = String(texto).replace(/\s+/g, ' ');
  var padrao = /\((\d{4,})\)/g;
  var achados = [];
  var m;

  while ((m = padrao.exec(plano)) !== null) {
    achados.push({ matricula: m[1], inicio: m.index, fim: m.index + m[0].length });
  }
  if (achados.length < MIN_LINHAS_ACADEMICO) return [];

  var registros = [];

  for (var i = 0; i < achados.length; i++) {
    var anterior = i === 0 ? 0 : achados[i - 1].fim;
    var antes = plano.slice(anterior, achados[i].inicio);
    var depois = plano.slice(achados[i].fim, i + 1 < achados.length ? achados[i + 1].inicio : plano.length);

    var nome = caudaEmMaiusculas_(antes);
    if (!nome) continue;

    registros.push([
      nome,
      achados[i].matricula,
      turmaDoTexto(depois),
      extrairTelefones_(depois)
    ]);
  }

  return registros;
}

/**
 * O nome do aluno é o rabo em MAIÚSCULAS do trecho que antecede a matrícula.
 *
 * Serve para separar o nome do lixo que vem grudado nele. No começo do
 * relatório isso é o cabeçalho ("... Telefone Res. Telefone Cel. BEATRIZ
 * EXEMPLO MARTINS"); no meio, é a turma e o telefone do aluno anterior
 * ("PMM21 48999990001 CARLOS EXEMPLO ANDRADE").
 *
 * Funciona porque o relatório grafa nome de aluno inteiramente em maiúsculas, e
 * o resto não: "Cel." tem minúscula e por isso interrompe a varredura, que é
 * exatamente o que se quer. Preposição minúscula ("de", "dos") é aceita no MEIO
 * do nome, nunca no começo.
 */
function caudaEmMaiusculas_(trecho) {
  var tokens = String(trecho).trim().split(/\s+/);
  var nome = [];

  for (var i = tokens.length - 1; i >= 0; i--) {
    var t = tokens[i];
    if (/^[A-ZÀ-ÿ][A-ZÀ-ÿ'\-]*$/.test(t) && t === t.toUpperCase()) {
      nome.unshift(t);
      continue;
    }
    // Preposição só vale se já houver sobrenome à direita — senão "de" viraria
    // o nome inteiro num trecho que não tem nome nenhum.
    if (nome.length && /^(d[aeo]s?|e)$/i.test(t)) {
      nome.unshift(t);
      continue;
    }
    break;
  }

  // Um token só costuma ser sobra de cabeçalho, não nome de gente.
  return nome.length >= 2 ? nome.join(' ') : '';
}

// ------------------------------------------------------------ CSV / planilha

/**
 * Lê a matriz de um CSV achatado.
 *
 * O export repete o cabeçalho do relatório em toda linha, então quase toda
 * coluna tem o mesmo valor do começo ao fim. A coluna que interessa é a única
 * que varia E casa com "NOME (MATRÍCULA)".
 */
function extrairAcademicoDeMatriz_(matriz) {
  var colunaPessoa = -1;
  var largura = matriz.reduce(function (m, l) { return Math.max(m, l.length); }, 0);

  for (var c = 0; c < largura; c++) {
    var casam = 0;
    var distintos = {};
    matriz.forEach(function (linha) {
      var v = String(linha[c] === undefined ? '' : linha[c]).trim();
      if (!v) return;
      distintos[v] = true;
      if (PADRAO_NOME_MATRICULA.test(v)) casam++;
    });
    // Precisa variar entre as linhas: coluna constante é cabeçalho repetido.
    if (casam >= Math.ceil(matriz.length / 2) && Object.keys(distintos).length > 1) {
      colunaPessoa = c;
      break;
    }
  }

  if (colunaPessoa === -1) return [];

  var registros = [];
  matriz.forEach(function (linha) {
    var pessoa = separarNomeMatricula_(linha[colunaPessoa]);
    if (!pessoa.nome || !pessoa.matricula) return;

    // Turma e telefone podem estar em qualquer outra coluna que varie.
    var turma = '';
    var telefone = '';
    for (var c = 0; c < largura; c++) {
      if (c === colunaPessoa) continue;
      var v = String(linha[c] === undefined ? '' : linha[c]).trim();
      if (!turma && PADRAO_TURMA_CELULA.test(v)) turma = v;
      if (!telefone) telefone = extrairTelefones_(v);
    }

    registros.push([pessoa.nome, pessoa.matricula, turma, telefone]);
  });

  return registros;
}

/**
 * Ponto de entrada: tenta ler como formato acadêmico.
 * Devolve `null` quando o arquivo não é desse formato, para o importador
 * seguir pelo caminho genérico.
 */
function tentarFormatoAcademico_(origem) {
  var registros = [];

  if (origem.texto) {
    var linhas = String(origem.texto).split(/\r?\n/).filter(function (l) { return l.trim(); });

    // Duas formas do MESMO relatório, e a escolha é por RESULTADO: roda as duas
    // e fica com a que leu MAIS alunos.
    //
    // Até 26/08 a rede só entrava quando o leitor por linha achava ZERO, e a
    // suposição por trás disso era que ele "ou funciona, ou não acha nada". O
    // modo de falha real é pior, e apareceu num PDF de 39 alunos: o OCR do Drive
    // devolveu o arquivo inteiro em SETE linhas, com os alunos colados por
    // espaço simples dentro de duas delas. O leitor por linha tira UM aluno por
    // linha — o primeiro nome dela, e o último telefone —, então achou 1. E 1
    // não é zero: a rede nunca foi acionada, e a importação entregou uma ficha
    // com o nome de um aluno e o telefone de outro, com cara de sucesso.
    //
    // Comparar o número é honesto porque os dois leem O MESMO texto e nenhum
    // inventa aluno: cada registro é uma ocorrência real de `NOME (MATRÍCULA)`.
    // Achar mais é ter lido mais do arquivo, não ser mais otimista.
    //
    // O EMPATE FICA COM O LEITOR POR LINHA, e é de propósito: quando as linhas
    // existem ele é mais preciso, porque não precisa deduzir onde o nome começa
    // (`caudaEmMaiusculas_`). O achatado só ganha quando ganha de verdade.
    var porLinha = ehFormatoAcademico_(linhas)
      ? extrairAcademicoDeTexto_(origem.texto)
      : [];
    var achatado = extrairAcademicoAchatado_(origem.texto);

    registros = achatado.length > porLinha.length ? achatado : porLinha;
    if (!registros.length) return null;
  } else if (origem.matriz) {
    var achatado = origem.matriz.map(function (l) { return l.join(' '); });
    if (!ehFormatoAcademico_(achatado)) return null;
    registros = extrairAcademicoDeMatriz_(origem.matriz);
  } else {
    return null;
  }

  if (!registros.length) return null;

  return {
    matriz: [CABECALHO_ACADEMICO].concat(registros),
    aviso: registros.length + ' aluno(s) lido(s) no formato do sistema acadêmico. ' +
           'Nome e matrícula foram separados automaticamente.'
  };
}
