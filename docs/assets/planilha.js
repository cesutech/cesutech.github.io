/**
 * planilha.js — gerador de .xlsx de verdade, no navegador, sem biblioteca.
 *
 * A restrição do projeto é a de sempre: zero dependência externa, zero custo,
 * sem CDN. Uma planilha "de verdade" (e não um .csv renomeado) exige então
 * montar o formato à mão — o que é menos assustador do que parece, porque um
 * .xlsx é só um ZIP com seis XMLs dentro.
 *
 * POR QUE NÃO CSV: o professor abre o arquivo no Excel e a matrícula 0510865
 * vira 510865, porque o Excel adivinha o tipo de cada campo do CSV e adivinha
 * errado. Matrícula maior vira notação científica. Não há como pedir ao CSV que
 * não faça isso — o formato não tem onde guardar essa informação. O .xlsx tem:
 * cada célula declara o próprio tipo, e aqui TODAS declaram texto.
 *
 * POR QUE ZIP SEM COMPRESSÃO (método STORE, 0): a especificação do ZIP permite,
 * o Excel abre normalmente, e evita escrever um deflate em JavaScript — que é a
 * única parte realmente difícil do formato. O preço é o tamanho: uma exportação
 * de 232 inscritos dá algo como 100 KB em vez de 15 KB. Para um arquivo que
 * nasce, é baixado e morre, isso não é preço nenhum.
 *
 * POR QUE inlineStr E NÃO sharedStrings: a tabela de strings compartilhadas
 * economiza espaço quando o mesmo texto se repete muito, e custa uma sétima
 * parte no pacote, mais um índice que precisa bater com o que está na célula.
 * Um índice fora de lugar produz um arquivo que abre com o conteúdo TROCADO —
 * o pior modo de falha possível aqui. Com inlineStr o texto mora na célula.
 *
 * O QUE MAIS QUEBRA ESTE FORMATO, em ordem de frequência: o `&` de um nome como
 * "Ana & Silva" entrando cru no XML. O Excel então recusa o arquivo inteiro sem
 * dizer por quê — não aponta a linha, não aponta o campo, só diz que o conteúdo
 * é ilegível. Ver `escaparXml`, que é a função mais importante deste arquivo.
 *
 * Contrato público, combinado com o painel:
 *
 *   window.Planilha.xlsx(spec)         -> Blob pronto para download
 *   window.Planilha.baixar(blob, nome) -> dispara o download
 *
 * O `spec` está documentado em `xlsx`, lá embaixo.
 */

(function () {
  'use strict';

  var TEXTO = new TextEncoder();

  // O vinho da identidade do CESUTECH, na notação do OOXML: AARRGGBB, alfa
  // primeiro. Sem o "FF" da frente o Excel lê a cor como transparente.
  var VINHO = 'FF5C2235';

  // --------------------------------------------------------------- Escape XML

  /**
   * Deixa um texto qualquer seguro para entrar num XML — e é isto que impede o
   * "arquivo corrompido" que o Excel anuncia sem explicar.
   *
   * Três coisas acontecem aqui, e as três são obrigatórias:
   *
   * 1. Os caracteres de controle SAEM. O XML 1.0 proíbe 0x00–0x08, 0x0B, 0x0C e
   *    0x0E–0x1F em qualquer posição, inclusive escapados: não existe forma de
   *    representá-los. Eles chegam colados de PDF e de planilha antiga (o 0x0B
   *    é a "quebra de linha vertical" que o Word usa), passam invisíveis por
   *    toda a tela do painel e só aparecem aqui, arruinando o pacote inteiro.
   *
   * 2. As quebras de linha viram `\n`. O leitor de XML normaliza `\r\n` e `\r`
   *    solto para `\n` de qualquer jeito, então normalizar na saída é só fazer
   *    o que já vai acontecer — a diferença é que assim o que se gravou e o que
   *    se lê de volta são a mesma coisa, e o teste pode comparar os dois.
   *
   * 3. `&` PRIMEIRO, depois os outros. Invertida, a ordem transformaria o `&`
   *    do `&lt;` recém-criado num `&amp;lt;`, e o `<` viraria o texto "&lt;".
   *
   * O `>` não precisaria de escape fora do caso `]]>`, e o `"` não precisaria
   * fora de atributo. Escapamos os quatro mesmo assim: esta função é usada em
   * conteúdo e em atributo, e uma regra única é uma regra que ninguém aplica no
   * lugar errado.
   */
  function escaparXml(valor) {
    return String(valor)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ------------------------------------------------------------------- CRC32

  /**
   * A tabela do CRC-32 (polinômio 0xEDB88320, o do ZIP), montada uma vez.
   *
   * Montada e não escrita à mão porque 256 constantes copiadas de algum lugar
   * são 256 oportunidades de errar uma, e um CRC errado faz o Excel recusar o
   * arquivo dizendo que ele está danificado — que, do ponto de vista dele, está.
   */
  var TABELA_CRC = (function () {
    var tabela = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      tabela[n] = c >>> 0;
    }
    return tabela;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = TABELA_CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // --------------------------------------------------------------------- ZIP

  // Data e hora fixas no marco zero do DOS (01/01/1980 00:00), e não o relógio
  // de agora: assim o mesmo `spec` sempre produz os mesmos bytes, o que é o que
  // permite comparar duas gerações num teste. A data que o professor vê no
  // gerenciador de arquivos é a do download, e não esta.
  var DATA_DOS = 0x0021;
  var HORA_DOS = 0x0000;

  // Bit 11 do "general purpose flag": diz que os nomes das partes estão em
  // UTF-8. Todos eles são ASCII (`xl/workbook.xml` e companhia), e em ASCII a
  // marcação é indiferente — está ligada porque é a verdade sobre como o
  // `TextEncoder` codificou, e porque o dia em que alguém acrescentar uma parte
  // com acento no nome não deve ser o dia em que se descobre que faltava isto.
  var BANDEIRA_UTF8 = 0x0800;

  /**
   * Empacota `[{nome, conteudo}]` num ZIP, todos com método STORE.
   *
   * Um ZIP é, nesta ordem: os arquivos, cada um precedido do próprio cabeçalho;
   * o diretório central, que repete os dados de cada arquivo mais o endereço
   * onde ele começa; e o fim do diretório central, que diz quantos são e onde o
   * diretório começa. O leitor entra pelo FIM — é por isso que o diretório
   * central precisa estar certo mesmo que os cabeçalhos locais estejam.
   *
   * Tudo em little-endian. Escrever um tamanho em big-endian produz um arquivo
   * que o Excel abre, encontra 16 milhões de bytes onde havia 300, e recusa.
   */
  function zipar(partes) {
    var itens = partes.map(function (p) {
      var nome = TEXTO.encode(p.nome);
      var dados = TEXTO.encode(p.conteudo);
      return { nome: nome, dados: dados, crc: crc32(dados) };
    });

    var tamanhoLocal = 0;
    var tamanhoCentral = 0;
    itens.forEach(function (item) {
      tamanhoLocal += 30 + item.nome.length + item.dados.length;
      tamanhoCentral += 46 + item.nome.length;
    });

    var saida = new Uint8Array(tamanhoLocal + tamanhoCentral + 22);
    var visao = new DataView(saida.buffer);
    var pos = 0;

    function u16(v) { visao.setUint16(pos, v, true); pos += 2; }
    function u32(v) { visao.setUint32(pos, v >>> 0, true); pos += 4; }
    function crus(b) { saida.set(b, pos); pos += b.length; }

    itens.forEach(function (item) {
      item.offset = pos;
      u32(0x04034B50);          // assinatura do cabeçalho local
      u16(20);                  // versão necessária: 2.0
      u16(BANDEIRA_UTF8);
      u16(0);                   // método 0 = STORE
      u16(HORA_DOS);
      u16(DATA_DOS);
      u32(item.crc);
      u32(item.dados.length);   // comprimido
      u32(item.dados.length);   // e original — iguais, porque STORE
      u16(item.nome.length);
      u16(0);                   // sem campo extra
      crus(item.nome);
      crus(item.dados);
    });

    var inicioCentral = pos;
    itens.forEach(function (item) {
      u32(0x02014B50);          // assinatura do diretório central
      u16(20);                  // versão de quem criou
      u16(20);                  // versão necessária
      u16(BANDEIRA_UTF8);
      u16(0);
      u16(HORA_DOS);
      u16(DATA_DOS);
      u32(item.crc);
      u32(item.dados.length);
      u32(item.dados.length);
      u16(item.nome.length);
      u16(0);                   // extra
      u16(0);                   // comentário
      u16(0);                   // disco onde começa
      u16(0);                   // atributos internos
      u32(0);                   // atributos externos
      u32(item.offset);
      crus(item.nome);
    });

    // O tamanho do diretório central, capturado ANTES de o registro final
    // começar a mover o `pos`. Calculá-lo lá embaixo, com `pos - inicioCentral`,
    // dá 12 bytes a mais — os do próprio registro já escritos — e o leitor
    // procura o começo do diretório 12 bytes antes de onde ele está, onde não há
    // assinatura nenhuma. O ZIP fica "corrompido" para o `zipfile` do Python e
    // para o Excel, e continua abrindo em qualquer leitor que confie só no
    // `offset` (foi assim que este erro passou pela primeira bateria de testes).
    var tamanhoDoCentral = pos - inicioCentral;

    u32(0x06054B50);            // fim do diretório central
    u16(0);                     // este disco
    u16(0);                     // disco do diretório
    u16(itens.length);          // entradas neste disco
    u16(itens.length);          // entradas no total
    u32(tamanhoDoCentral);
    u32(inicioCentral);
    u16(0);                     // sem comentário

    return saida;
  }

  // ----------------------------------------------------------- Peças do xlsx

  var CABECALHO_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  var NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  var NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  var CONTENT_TYPES = CABECALHO_XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  var RELS_RAIZ = CABECALHO_XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + NS_REL + '/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  var RELS_PASTA = CABECALHO_XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + NS_REL + '/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="' + NS_REL + '/styles" Target="styles.xml"/>' +
    '</Relationships>';

  // Os índices de `cellXfs` abaixo. São a única ligação entre `styles.xml` e o
  // atributo `s=` de cada célula, e é uma ligação POSICIONAL: acrescentar um
  // `<xf>` no meio da lista repinta a planilha inteira em silêncio. Acrescente
  // no fim, e some a constante nova aqui.
  var ESTILO_PADRAO = 0;
  var ESTILO_CABECALHO = 1;
  var ESTILO_TITULO = 2;
  var ESTILO_TOPO = 3;
  var ESTILO_CORPO = 4;

  // numFmtId 49 é o formato embutido "@", que é o Excel dizendo "isto é texto".
  // É cinto e suspensório junto com o `t="inlineStr"` da célula, e o que garante
  // que a matrícula continue com o zero da frente mesmo depois que o professor
  // reordenar, copiar e colar a coluna dentro do próprio Excel.
  var ESTILOS = CABECALHO_XML +
    '<styleSheet xmlns="' + NS + '">' +
    '<fonts count="4">' +
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="14"/><color rgb="' + VINHO + '"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><sz val="9"/><color rgb="FF6E6E6E"/><name val="Calibri"/><family val="2"/></font>' +
    '</fonts>' +
    // O Excel exige que as duas primeiras posições de `fills` sejam exatamente
    // "none" e "gray125", nesta ordem, mesmo que nada as use. A cor de verdade
    // é a terceira.
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="' + VINHO + '"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="5">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1">' +
    '<alignment vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">' +
    '<alignment vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1">' +
    '<alignment vertical="top" wrapText="1"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  // -------------------------------------------------------------- Utilidades

  /** 1 -> A, 26 -> Z, 27 -> AA. É base 26 sem o zero, então o -1 no meio. */
  function letraDaColuna(numero) {
    var letras = '';
    var n = numero;
    while (n > 0) {
      var resto = (n - 1) % 26;
      letras = String.fromCharCode(65 + resto) + letras;
      n = (n - resto - 1) / 26;
    }
    return letras;
  }

  /**
   * O nome da aba, dentro do que o Excel aceita.
   *
   * Ele recusa `: \ / ? * [ ]`, recusa mais de 31 caracteres e recusa nome
   * vazio — e recusa ABRINDO O ARQUIVO E RECLAMANDO, não avisando na hora de
   * gerar. Como o nome vem do painel (é o nome do projeto, escolhido pela
   * coordenação), sanear aqui é o que evita que um projeto chamado
   * "Robótica: nível I" produza um arquivo que ninguém consegue abrir.
   *
   * Os proibidos viram espaço, e não somem: "Arte/Design" tem de virar
   * "Arte Design" e não "ArteDesign", que gruda duas palavras e some com o
   * limite entre elas.
   */
  function sanearNomeDaAba(nome) {
    var limpo = String(nome === undefined || nome === null ? '' : nome)
      .replace(/[\x00-\x1F]/g, ' ')
      .replace(/[:\\/?*\[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 31)
      // O corte pode ter deixado um espaço na ponta, e o Excel também não
      // aceita aspa simples no começo nem no fim (é o delimitador dele em
      // fórmulas entre abas).
      .replace(/^['\s]+|['\s]+$/g, '');
    return limpo || 'Planilha1';
  }

  /**
   * Uma célula de texto, ou uma célula VAZIA quando não há o que escrever.
   *
   * Vazia é `<c/>` sem conteúdo — com o estilo, para a formatação da coluna não
   * quebrar no meio. O que NÃO pode acontecer é `String(undefined)` chegar aqui
   * e a planilha da coordenação sair com a palavra "undefined" em 40 células;
   * por isso a checagem é por valor, antes de qualquer conversão.
   *
   * String vazia entra no mesmo caso: `<is><t></t></is>` é uma célula que o
   * Excel considera preenchida com nada, o que atrapalha o "ir para a última
   * linha" e a contagem do próprio filtro.
   *
   * `xml:space="preserve"` sempre, e não só quando parece necessário: nome
   * digitado em formulário chega com espaço na ponta mais vezes do que se
   * imagina, e a regra "sempre" é a que ninguém aplica no lugar errado.
   */
  function celula(referencia, estilo, valor) {
    var abre = '<c r="' + referencia + '" s="' + estilo + '"';
    if (valor === null || valor === undefined || valor === '') return abre + '/>';
    return abre + ' t="inlineStr"><is><t xml:space="preserve">' +
      escaparXml(valor) + '</t></is></c>';
  }

  // ------------------------------------------------------------ A planilha

  function montarSheet(colunas, linhas, titulo, linhasDeTopo) {
    var partes = [];
    var linha = 0;

    if (titulo) {
      linha++;
      partes.push('<row r="' + linha + '" ht="21" customHeight="1">' +
        celula('A' + linha, ESTILO_TITULO, titulo) + '</row>');
    }

    linhasDeTopo.forEach(function (texto) {
      linha++;
      partes.push('<row r="' + linha + '">' +
        celula('A' + linha, ESTILO_TOPO, texto) + '</row>');
    });

    // A linha do cabeçalho NÃO é a 1 sempre que houver título ou linhas de
    // contexto — e é dela que dependem o congelamento e o autofiltro lá
    // embaixo. Fixar "A1" ali funciona no exemplo mais simples e produz, na
    // exportação real, um filtro sobre a frase "34 inscrições" e um
    // congelamento que rola o cabeçalho para fora da tela.
    // Sem espaçador entre o contexto e a tabela de propósito: assim a conta é
    // sempre 1 + título + linhas de contexto, e o respiro vem da altura maior
    // da linha do título.
    var linhaCabecalho = linha + 1;
    linha = linhaCabecalho;

    partes.push('<row r="' + linha + '" ht="20" customHeight="1">' +
      colunas.map(function (coluna, i) {
        return celula(letraDaColuna(i + 1) + linhaCabecalho, ESTILO_CABECALHO, coluna.rotulo);
      }).join('') + '</row>');

    linhas.forEach(function (registro) {
      linha++;
      var numero = linha;
      partes.push('<row r="' + numero + '">' +
        colunas.map(function (coluna, i) {
          var valor = registro ? registro[coluna.chave] : null;
          return celula(letraDaColuna(i + 1) + numero, ESTILO_CORPO, valor);
        }).join('') + '</row>');
    });

    var ultimaColuna = letraDaColuna(colunas.length);
    // Sem nenhuma linha de dado, `linha` parou no cabeçalho: a faixa da tabela
    // é o cabeçalho sozinho. É o caso do projeto sem inscrito, que precisa
    // gerar um arquivo ABRÍVEL — o professor abre, vê os títulos e entende que
    // ninguém se inscreveu, em vez de receber um arquivo quebrado.
    var ultimaLinha = linha;
    var faixa = 'A' + linhaCabecalho + ':' + ultimaColuna + ultimaLinha;

    var colunasXml = colunas.map(function (coluna, i) {
      // Coluna sem `largura` declarada cairia nos 8,43 caracteres padrão do
      // Excel, que corta todo nome pela metade. 18 é um padrão que ao menos
      // deixa o conteúdo legível sem o professor ter de arrastar nada.
      var largura = Number(coluna.largura) > 0 ? Number(coluna.largura) : 18;
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + largura +
        '" customWidth="1"/>';
    }).join('');

    // A ORDEM DOS ELEMENTOS aqui é normativa: o esquema do OOXML define
    // sequência, não conjunto. `autoFilter` DEPOIS de `sheetData`, `cols`
    // ANTES. Trocar dois de lugar produz um arquivo que o Excel recusa com a
    // mesma mensagem genérica de sempre.
    return CABECALHO_XML +
      '<worksheet xmlns="' + NS + '" xmlns:r="' + NS_REL + '">' +
      '<dimension ref="A1:' + ultimaColuna + ultimaLinha + '"/>' +
      '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="' + linhaCabecalho + '" topLeftCell="A' + (linhaCabecalho + 1) +
      '" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A' + (linhaCabecalho + 1) +
      '" sqref="A' + (linhaCabecalho + 1) + '"/>' +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' + colunasXml + '</cols>' +
      '<sheetData>' + partes.join('') + '</sheetData>' +
      '<autoFilter ref="' + faixa + '"/>' +
      '</worksheet>';
  }

  // ------------------------------------------------------------- O contrato

  /**
   * Monta o .xlsx e devolve um Blob pronto para `baixar`.
   *
   * O `spec`:
   *
   *   {
   *     aba: 'Inscritos',              // nome da aba; saneado por `sanearNomeDaAba`
   *     titulo: 'ARTE DIGITAL',        // opcional, linha em destaque acima da tabela
   *     linhasDeTopo: ['34 inscrições', 'Exportado em ...'],   // opcional
   *     colunas: [{ rotulo, chave, largura, tipo }],
   *     linhas:  [{ <chave>: valor, ... }]
   *   }
   *
   * SOBRE `tipo`: hoje toda célula sai como texto, com `tipo` ou sem ele.
   * Isso é escolha, não omissão — nenhuma coluna deste sistema entra em conta
   * aritmética, e das que existem a matrícula é a que SÓ funciona como texto
   * (ver o comentário do topo). O campo continua no contrato porque é onde uma
   * coluna futura de verdade numérica vai se declarar; enquanto ninguém a
   * escrever, `tipo: 'texto'` documenta a intenção e nada mais.
   */
  function xlsx(spec) {
    var s = spec || {};
    var colunas = s.colunas || [];
    if (!colunas.length) {
      throw new Error('Planilha.xlsx: nenhuma coluna em spec.colunas.');
    }

    var workbook = CABECALHO_XML +
      '<workbook xmlns="' + NS + '" xmlns:r="' + NS_REL + '">' +
      '<sheets><sheet name="' + escaparXml(sanearNomeDaAba(s.aba)) +
      '" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>';

    var sheet = montarSheet(
      colunas,
      s.linhas || [],
      s.titulo ? String(s.titulo) : '',
      s.linhasDeTopo || []
    );

    // A ordem das partes dentro do ZIP não é normativa para o Excel, mas
    // `[Content_Types].xml` vir primeiro é a convenção de todo gerador — e é o
    // que leitores mais preguiçosos esperam encontrar sem varrer o pacote.
    var bytes = zipar([
      { nome: '[Content_Types].xml', conteudo: CONTENT_TYPES },
      { nome: '_rels/.rels', conteudo: RELS_RAIZ },
      { nome: 'xl/workbook.xml', conteudo: workbook },
      { nome: 'xl/_rels/workbook.xml.rels', conteudo: RELS_PASTA },
      { nome: 'xl/styles.xml', conteudo: ESTILOS },
      { nome: 'xl/worksheets/sheet1.xml', conteudo: sheet }
    ]);

    return new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  /**
   * Dispara o download de um Blob. Mesmo caminho do `baixarCsv` do painel.
   *
   * O `<a>` entra no documento antes do clique e sai depois porque o Firefox
   * ignora `click()` em elemento que não está na árvore — no Chrome funciona
   * dos dois jeitos, e é justamente por isso que a versão sem `appendChild`
   * sobrevive a todo teste manual de quem usa Chrome.
   *
   * O `revokeObjectURL` no fim solta os bytes: sem ele a planilha inteira fica
   * na memória da aba até a página ser recarregada, e o painel é uma tela que o
   * professor deixa aberta o dia todo, exportando várias vezes.
   */
  function baixar(blob, nomeDoArquivo) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = nomeDoArquivo;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  window.Planilha = { xlsx: xlsx, baixar: baixar };
})();
