/**
 * planilha.js — os testes do gerador de .xlsx (docs/assets/planilha.js).
 *
 * A pergunta que este arquivo responde não é "o código rodou sem estourar" — é
 * "o Excel abre o que saiu daqui". São coisas muito diferentes: um `&` cru numa
 * célula não estoura nada, produz bytes, produz um Blob com tamanho plausível, e
 * o Excel recusa o arquivo inteiro com uma mensagem que não diz nada.
 *
 * Por isso todo teste daqui DESCOMPACTA o ZIP gerado e olha o XML de dentro. O
 * leitor está logo abaixo (`lerZip`) e cabe em trinta linhas porque o gerador usa
 * método STORE: extrair é ler os bytes entre os cabeçalhos. Ele entra pelo FIM do
 * pacote, pelo diretório central, que é por onde um leitor de ZIP de verdade
 * entra — assim um diretório central errado é pego aqui, e não pelo professor.
 *
 * O CRC também é recalculado, por uma implementação DIFERENTE da do gerador:
 * lá é tabela de 256 entradas, aqui é bit a bit. Conferir a tabela contra ela
 * mesma não provaria nada.
 *
 * O QUE ESTE ARQUIVO NÃO PROVA: que o Excel de verdade abre. Isso se prova
 * abrindo, e a aproximação mais honesta que existe sem o Excel é validar os XMLs
 * com um parser independente — feito fora daqui, com `zipfile` + `ElementTree`
 * do Python, sobre um arquivo de exemplo com dados sujos.
 *
 * Uso:  node testes/planilha.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { teste, grupo, igual, verdadeiro, lancou, resultado } = require('./apoio');

const ARQUIVO = path.join(__dirname, '..', 'docs', 'assets', 'planilha.js');
const CODIGO = fs.readFileSync(ARQUIVO, 'utf8');

// ------------------------------------------------------------ O navegador

/**
 * O mínimo de navegador para o `planilha.js` rodar, e nada além disso.
 *
 * O `Blob` é falso de propósito. O do Node existe, mas só entrega os bytes por
 * Promise (`arrayBuffer()`), e isso tornaria assíncrono todo teste daqui para
 * provar exatamente a mesma coisa: o que interessa são os BYTES que chegam ao
 * construtor, e eles chegam prontos. O falso guarda o que recebeu, inclusive o
 * `type` — que é o que faz o sistema operacional abrir o arquivo no Excel.
 */
function ambiente() {
  const registro = { urls: [], revogados: [], criados: [], anexados: [], removidos: [] };

  const documento = {
    body: {
      appendChild(el) { registro.anexados.push(el); },
      removeChild(el) { registro.removidos.push(el); }
    },
    createElement(tag) {
      const el = { tag, cliques: 0, click() { el.cliques++; } };
      registro.criados.push(el);
      return el;
    }
  };

  const janela = {};
  const contexto = {
    window: janela,
    document: documento,
    TextEncoder, TextDecoder, DataView, Uint8Array, Uint32Array,
    String, Number, Math, JSON, Error, Array, Object, Boolean, RegExp,
    isNaN, parseInt, parseFloat,
    console: { log() {}, error() {} },
    Blob: function (partes, opcoes) {
      this.partes = partes;
      this.type = (opcoes || {}).type;
    },
    URL: {
      createObjectURL(blob) {
        registro.urls.push(blob);
        return 'blob:falso/' + registro.urls.length;
      },
      revokeObjectURL(url) { registro.revogados.push(url); }
    }
  };
  contexto.globalThis = contexto;

  vm.runInContext(CODIGO, vm.createContext(contexto), { filename: 'docs/assets/planilha.js' });
  return { Planilha: janela.Planilha, registro };
}

// ------------------------------------------------------------ Leitor de ZIP

/** CRC-32 bit a bit, sem tabela — a segunda opinião sobre o CRC do gerador. */
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Abre o ZIP pelo diretório central, como faz qualquer leitor de verdade, e
 * confere de passagem que o cabeçalho local de cada parte está onde o diretório
 * disse que estaria.
 */
function lerZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p) => v.getUint16(p, true);
  const u32 = (p) => v.getUint32(p, true);
  const texto = (ini, fim) => new TextDecoder().decode(bytes.subarray(ini, fim));

  // Sem comentário no fim do pacote, o "end of central directory" são os
  // últimos 22 bytes exatos.
  const eocd = bytes.length - 22;
  if (u32(eocd) !== 0x06054B50) throw new Error('não achei o fim do diretório central');

  const total = u16(eocd + 10);
  const tamanhoCentral = u32(eocd + 12);
  const inicioCentral = u32(eocd + 16);

  // O `zipfile` do Python (e o Excel) NÃO confiam só no offset: eles usam o
  // tamanho declarado para achar o começo do diretório, e um tamanho errado por
  // 12 bytes manda o leitor para o meio do nada. A primeira versão deste leitor
  // ignorava o campo, e por isso deu tudo verde num pacote que o Python recusava
  // com "Bad magic number for central directory". A conferência ficou.
  if (inicioCentral + tamanhoCentral !== eocd) {
    throw new Error('o diretório central declara ' + tamanhoCentral + ' bytes a partir de ' +
      inicioCentral + ', o que não termina no fim do diretório (' + eocd + ')');
  }

  let p = inicioCentral;
  const partes = [];

  for (let i = 0; i < total; i++) {
    if (u32(p) !== 0x02014B50) throw new Error('entrada ' + i + ' do diretório central inválida');
    const metodo = u16(p + 10);
    const crc = u32(p + 16);
    const comprimido = u32(p + 20);
    const tamanho = u32(p + 24);
    const nome = texto(p + 46, p + 46 + u16(p + 28));
    const offset = u32(p + 42);
    p += 46 + u16(p + 28) + u16(p + 30) + u16(p + 32);

    if (u32(offset) !== 0x04034B50) throw new Error('cabeçalho local ausente em ' + nome);
    const inicio = offset + 30 + u16(offset + 26) + u16(offset + 28);
    const dados = bytes.subarray(inicio, inicio + tamanho);
    partes.push({
      nome, metodo, crc, comprimido, tamanho, dados,
      // O cabeçalho local repete o que o diretório central diz. Leitores
      // diferentes acreditam em um ou no outro, então os dois têm de contar a
      // mesma história — e é por isso que estes vêm separados.
      metodoLocal: u16(offset + 8),
      crcLocal: u32(offset + 14),
      dataLocal: u16(offset + 12),
      horaLocal: u16(offset + 10),
      texto: new TextDecoder().decode(dados)
    });
  }

  if (p !== eocd) throw new Error('sobraram ' + (eocd - p) + ' bytes no diretório central');
  return partes;
}

// ------------------------------------------------------------ Atalhos

const { Planilha } = ambiente();

function gerar(spec) {
  const blob = Planilha.xlsx(spec);
  const partes = lerZip(blob.partes[0]);
  const mapa = {};
  partes.forEach((parte) => { mapa[parte.nome] = parte; });
  return { blob, partes, mapa, sheet: mapa['xl/worksheets/sheet1.xml'].texto };
}

/** O elemento `<c>` inteiro de uma referência, inclusive quando é vazio. */
function celulaDe(sheet, referencia) {
  const inicio = sheet.indexOf('<c r="' + referencia + '"');
  if (inicio === -1) return null;
  const vazia = sheet.indexOf('/>', inicio);
  const abre = sheet.indexOf('>', inicio);
  if (vazia !== -1 && vazia === abre - 1) return sheet.slice(inicio, vazia + 2);
  return sheet.slice(inicio, sheet.indexOf('</c>', inicio) + 4);
}

/** O `&amp;` de volta a `&` — o outro lado da ida e volta do escape. */
function desescapar(texto) {
  return texto
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** O texto que uma célula guarda, já desescapado. `null` quando ela é vazia. */
function textoDa(celula) {
  if (!celula) return null;
  const m = /<t[^>]*>([\s\S]*?)<\/t>/.exec(celula);
  return m ? desescapar(m[1]) : null;
}

/**
 * O `<xf>` que uma célula de verdade aponta — resolvido pelo `s=` dela, e não
 * escolhido à mão pelo teste.
 *
 * A ligação entre a célula e o estilo é POSICIONAL, e é aí que mora o engano:
 * procurar `wrapText` no arquivo inteiro dá verde mesmo quando quem tem
 * `wrapText` é o cabeçalho e quem precisa dele é o corpo. Este caminho pergunta
 * pela célula.
 */
function estiloDaCelula(estilos, celula) {
  const indice = Number(/ s="(\d+)"/.exec(celula)[1]);
  const bloco = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(estilos)[1];
  const xfs = bloco.match(/<xf [\s\S]*?(?:\/>|<\/xf>)/g);
  return xfs[indice];
}

const COLUNAS = [
  { rotulo: 'Matrícula', chave: 'matricula', largura: 14, tipo: 'texto' },
  { rotulo: 'Nome', chave: 'nome', largura: 34 },
  { rotulo: 'E-mail', chave: 'email', largura: 30 }
];

const SIMPLES = {
  aba: 'Inscritos',
  colunas: COLUNAS,
  linhas: [
    { matricula: '2510865', nome: 'Ana Paula', email: 'ana@exemplo.br' },
    { matricula: '2510866', nome: 'Bruno Costa', email: 'bruno@exemplo.br' }
  ]
};

// ==================================================== O pacote

grupo('o pacote — um ZIP que um leitor de ZIP consegue abrir');

teste('tem exatamente as seis partes do xlsx mínimo', () => {
  const { partes } = gerar(SIMPLES);
  igual(partes.map((p) => p.nome).sort(), [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml'
  ]);
});

teste('o CRC de cada parte bate com o CRC recalculado do conteúdo', () => {
  // A conferência que o Excel faz antes de qualquer outra coisa. Um CRC errado
  // aqui é o arquivo "danificado" que ele recusa sem explicar.
  gerar(SIMPLES).partes.forEach((parte) => {
    igual(parte.crc, crc32(parte.dados), 'CRC de ' + parte.nome);
  });
});

teste('todas as partes usam método STORE, com tamanho comprimido igual ao original', () => {
  gerar(SIMPLES).partes.forEach((parte) => {
    igual(parte.metodo, 0, 'método de ' + parte.nome + ' no diretório central');
    // Anunciar DEFLATE e entregar bytes crus faz o leitor tentar inflar o XML e
    // recusar o pacote — e o cabeçalho local é onde metade dos leitores olha.
    igual(parte.metodoLocal, 0, 'método de ' + parte.nome + ' no cabeçalho local');
    igual(parte.crcLocal, parte.crc, 'CRC de ' + parte.nome + ' divergindo entre os dois lugares');
    igual(parte.comprimido, parte.tamanho, 'tamanhos de ' + parte.nome);
    igual(parte.tamanho, parte.dados.length, 'tamanho declarado de ' + parte.nome);
  });
});

teste('a data no ZIP é fixa no marco zero do DOS', () => {
  // É o que torna a saída reproduzível: dois arquivos com o mesmo conteúdo têm
  // de ser os mesmos bytes. `new Date()` aqui quebra isso — e quebra devagar,
  // porque uma data capturada na carga do arquivo engana quem comparar duas
  // gerações do mesmo processo.
  gerar(SIMPLES).partes.forEach((parte) => {
    igual(parte.dataLocal, 0x0021, 'data de ' + parte.nome + ' (01/01/1980)');
    igual(parte.horaLocal, 0, 'hora de ' + parte.nome);
  });
});

teste('o fim do pacote descreve o diretório central com exatidão', () => {
  // O erro que a primeira versão do gerador cometia: declarar o tamanho do
  // diretório central 12 bytes maior que o real (os bytes do próprio registro
  // final, já escritos quando a conta foi feita). O pacote continuava abrindo em
  // leitor que só usa o offset — e o `zipfile` do Python, que usa os dois, dizia
  // "Bad magic number for central directory". O Excel também usa os dois.
  const bytes = Planilha.xlsx(SIMPLES).partes[0];
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;

  igual(v.getUint32(eocd, true), 0x06054B50, 'assinatura do fim do diretório');
  igual(v.getUint16(eocd + 8, true), 6, 'entradas neste disco');
  igual(v.getUint16(eocd + 10, true), 6, 'entradas no total');
  igual(v.getUint32(eocd + 16, true) + v.getUint32(eocd + 12, true), eocd,
    'offset + tamanho do diretório central têm de cair exatamente no fim dele');
});

teste('o mesmo spec produz sempre os mesmos bytes', () => {
  // Data e hora fixas no ZIP. Se alguém trocar por `new Date()`, dois arquivos
  // iguais deixam de ser iguais e este teste é quem conta.
  const a = Planilha.xlsx(SIMPLES).partes[0];
  const b = Planilha.xlsx(SIMPLES).partes[0];
  igual(Array.from(a), Array.from(b));
});

teste('o Blob sai com o tipo MIME do xlsx', () => {
  // É o que faz o sistema operacional abrir no Excel em vez de perguntar.
  igual(gerar(SIMPLES).blob.type,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

teste('as partes obrigatórias apontam umas para as outras', () => {
  const { mapa } = gerar(SIMPLES);
  verdadeiro(mapa['_rels/.rels'].texto.indexOf('Target="xl/workbook.xml"') !== -1);
  verdadeiro(mapa['xl/_rels/workbook.xml.rels'].texto
    .indexOf('Target="worksheets/sheet1.xml"') !== -1);
  verdadeiro(mapa['xl/_rels/workbook.xml.rels'].texto.indexOf('Target="styles.xml"') !== -1);
  verdadeiro(mapa['[Content_Types].xml'].texto
    .indexOf('PartName="/xl/worksheets/sheet1.xml"') !== -1);
});

// ==================================================== O escape

grupo('o escape — o que impede o arquivo que o Excel recusa');

teste('nome com &, <, > e aspas sobrevive à ida e à volta', () => {
  const nome = 'Ana & Cia <Ltda> "Filial"';
  const { sheet } = gerar({
    aba: 'Inscritos', colunas: COLUNAS,
    linhas: [{ matricula: '1', nome: nome, email: 'a@b.c' }]
  });

  // Ida: nenhum dos quatro entrou cru no XML.
  const celula = celulaDe(sheet, 'B2');
  verdadeiro(celula.indexOf('&amp;') !== -1, celula);
  verdadeiro(celula.indexOf('&lt;') !== -1, celula);
  verdadeiro(celula.indexOf('&gt;') !== -1, celula);
  verdadeiro(celula.indexOf('&quot;') !== -1, celula);

  // Volta: e o que o Excel vai ler é exatamente o que entrou.
  igual(textoDa(celula), nome);
});

teste('o & vira &amp; e não &amp;amp; — a ordem do escape', () => {
  // Escapar `<` antes de `&` produziria `&amp;lt;` a partir de um `<` inocente.
  const { sheet } = gerar({
    aba: 'X', colunas: COLUNAS,
    linhas: [{ matricula: '1', nome: 'A & B', email: 'a@b.c' }]
  });
  const celula = celulaDe(sheet, 'B2');
  verdadeiro(celula.indexOf('&amp;amp;') === -1, celula);
  igual(textoDa(celula), 'A & B');
});

teste('acento atravessa o pacote inteiro, em UTF-8', () => {
  const { sheet } = gerar({
    aba: 'X', colunas: COLUNAS,
    linhas: [{ matricula: '1', nome: 'João Conceição Müller', email: 'j@ç.br' }]
  });
  igual(textoDa(celulaDe(sheet, 'B2')), 'João Conceição Müller');
});

teste('caractere de controle no meio de um campo não aparece no XML', () => {
  // Colados de PDF e de planilha antiga (o 0x0B é a quebra vertical do Word).
  // O XML 1.0 não tem como representá-los, nem escapados: ou saem aqui, ou o
  // pacote inteiro fica ilegível.
  const sujo = 'Ma\u0000ri\u000Ba\u001F Silva';
  const { sheet, mapa } = gerar({
    aba: 'X', colunas: COLUNAS,
    linhas: [{ matricula: '1', nome: sujo, email: 'm@s.br' }]
  });

  igual(textoDa(celulaDe(sheet, 'B2')), 'Maria Silva');

  const cru = mapa['xl/worksheets/sheet1.xml'].dados;
  for (let i = 0; i < cru.length; i++) {
    const b = cru[i];
    const proibido = b <= 0x08 || b === 0x0B || b === 0x0C || (b >= 0x0E && b <= 0x1F);
    verdadeiro(!proibido, 'byte proibido 0x' + b.toString(16) + ' na posição ' + i);
  }
});

teste('nenhum & solto sobra em nenhum XML do pacote', () => {
  const { partes } = gerar({
    aba: 'A & B', titulo: 'Relatório & cia',
    linhasDeTopo: ['34 inscrições & 0 na fila'],
    colunas: COLUNAS,
    linhas: [{ matricula: '1', nome: '& & &', email: 'a&b@c.br' }]
  });
  const solto = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  partes.forEach((parte) => {
    verdadeiro(!solto.test(parte.texto), '& solto em ' + parte.nome);
  });
});

teste('quebra de linha fica na célula, com preserve e wrapText', () => {
  const { sheet, mapa } = gerar({
    aba: 'X', colunas: COLUNAS,
    linhas: [{ matricula: '1', nome: 'Rua A, 10\nCentro', email: 'a@b.c' }]
  });
  const celula = celulaDe(sheet, 'B2');
  verdadeiro(celula.indexOf('xml:space="preserve"') !== -1, celula);
  igual(textoDa(celula), 'Rua A, 10\nCentro');

  // O estilo QUE ESTA CÉLULA APONTA. Procurar `wrapText` no arquivo inteiro dá
  // verde com o wrapText só no cabeçalho — e aí a quebra está no arquivo e não
  // aparece na tela do professor.
  const xf = estiloDaCelula(mapa['xl/styles.xml'].texto, celula);
  verdadeiro(xf.indexOf('wrapText="1"') !== -1, 'o estilo do corpo perdeu o wrapText: ' + xf);
});

teste('\\r\\n vira \\n, e não duas quebras', () => {
  // O leitor de XML normaliza de qualquer jeito. Normalizar na saída é o que faz
  // o que se gravou e o que se lê de volta serem a mesma coisa.
  const { sheet } = gerar({
    aba: 'X', colunas: COLUNAS,
    linhas: [{ matricula: '1', nome: 'Rua A\r\nCentro\rFpolis', email: 'a@b.c' }]
  });
  igual(textoDa(celulaDe(sheet, 'B2')), 'Rua A\nCentro\nFpolis');
});

teste('espaço na ponta do nome não some', () => {
  const { sheet } = gerar({
    aba: 'X', colunas: COLUNAS,
    linhas: [{ matricula: '1', nome: '  Ana  ', email: 'a@b.c' }]
  });
  igual(textoDa(celulaDe(sheet, 'B2')), '  Ana  ');
});

// ==================================================== As células

grupo('as células — tudo texto, e vazio é vazio');

teste('matrícula com zero à esquerda continua com o zero', () => {
  // O motivo de o arquivo não ser um CSV.
  const { sheet } = gerar({
    aba: 'X', colunas: COLUNAS,
    linhas: [{ matricula: '0510865', nome: 'Ana', email: 'a@b.c' }]
  });
  igual(textoDa(celulaDe(sheet, 'A2')), '0510865');
});

teste('a célula da matrícula é inlineStr, e nunca numérica', () => {
  const { sheet } = gerar({
    aba: 'X', colunas: COLUNAS,
    linhas: [{ matricula: '0510865', nome: 'Ana', email: 'a@b.c' }]
  });
  const celula = celulaDe(sheet, 'A2');
  verdadeiro(celula.indexOf('t="inlineStr"') !== -1, celula);
  verdadeiro(celula.indexOf('t="n"') === -1, celula);
  verdadeiro(!/<v>/.test(celula), 'valor numérico é <v>, e aqui não pode haver nenhum: ' + celula);
});

teste('matrícula longa não vira notação científica', () => {
  const { sheet } = gerar({
    aba: 'X', colunas: COLUNAS,
    linhas: [{ matricula: '20251086500001', nome: 'Ana', email: 'a@b.c' }]
  });
  igual(textoDa(celulaDe(sheet, 'A2')), '20251086500001');
  verdadeiro(celulaDe(sheet, 'A2').indexOf('t="inlineStr"') !== -1);
});

teste('número entregue como número também sai como texto', () => {
  // Nenhuma coluna deste sistema entra em conta aritmética, e o painel entrega o
  // que o servidor mandou — que às vezes é number.
  const { sheet } = gerar({
    aba: 'X', colunas: COLUNAS,
    linhas: [{ matricula: 2510865, nome: 'Ana', email: 'a@b.c' }]
  });
  const celula = celulaDe(sheet, 'A2');
  igual(textoDa(celula), '2510865');
  verdadeiro(celula.indexOf('t="inlineStr"') !== -1, celula);
});

teste('null e undefined viram célula vazia, nunca a palavra "null"', () => {
  const { sheet } = gerar({
    aba: 'X', colunas: COLUNAS,
    linhas: [{ matricula: null, nome: undefined, email: 'a@b.c' }]
  });
  igual(textoDa(celulaDe(sheet, 'A2')), null);
  igual(textoDa(celulaDe(sheet, 'B2')), null);
  igual(textoDa(celulaDe(sheet, 'C2')), 'a@b.c');
  verdadeiro(sheet.indexOf('null') === -1, 'a palavra "null" está no XML');
  verdadeiro(sheet.indexOf('undefined') === -1, 'a palavra "undefined" está no XML');
});

teste('chave que não existe no registro vira célula vazia', () => {
  const { sheet } = gerar({
    aba: 'X',
    colunas: COLUNAS.concat([{ rotulo: 'Turma', chave: 'turma', largura: 10 }]),
    linhas: [{ matricula: '1', nome: 'Ana', email: 'a@b.c' }]
  });
  igual(celulaDe(sheet, 'D2'), '<c r="D2" s="4"/>');
});

teste('a célula vazia mantém o estilo do corpo', () => {
  // Sem o estilo, a faixa de formatação da coluna quebra no meio da tabela.
  const { sheet } = gerar({
    aba: 'X', colunas: COLUNAS,
    linhas: [{ matricula: '', nome: 'Ana', email: 'a@b.c' }]
  });
  verdadeiro(/<c r="A2" s="\d+"\/>/.test(celulaDe(sheet, 'A2')), celulaDe(sheet, 'A2'));
});

teste('os rótulos vão para a linha do cabeçalho, na ordem do spec', () => {
  const { sheet } = gerar(SIMPLES);
  igual(textoDa(celulaDe(sheet, 'A1')), 'Matrícula');
  igual(textoDa(celulaDe(sheet, 'B1')), 'Nome');
  igual(textoDa(celulaDe(sheet, 'C1')), 'E-mail');
});

teste('cada linha do spec vira uma linha da planilha, na ordem', () => {
  const { sheet } = gerar(SIMPLES);
  igual(textoDa(celulaDe(sheet, 'B2')), 'Ana Paula');
  igual(textoDa(celulaDe(sheet, 'B3')), 'Bruno Costa');
  igual((sheet.match(/<row /g) || []).length, 3);
});

teste('a 27ª coluna é AA, e não [', () => {
  // Base 26 sem zero. Somar 65 direto passa do Z e cai na pontuação.
  const colunas = [];
  for (let i = 1; i <= 28; i++) colunas.push({ rotulo: 'c' + i, chave: 'c' + i, largura: 8 });
  const { sheet } = gerar({ aba: 'X', colunas, linhas: [{ c27: 'vinte e sete' }] });
  igual(textoDa(celulaDe(sheet, 'AA1')), 'c27');
  igual(textoDa(celulaDe(sheet, 'AA2')), 'vinte e sete');
  verdadeiro(sheet.indexOf('ref="A1:AB2"') !== -1, 'dimension parou antes da última coluna');
});

// ==================================================== O cabeçalho

grupo('o cabeçalho — congelado e filtrado NA LINHA CERTA');

teste('sem título nem contexto, o cabeçalho é a linha 1', () => {
  const { sheet } = gerar(SIMPLES);
  verdadeiro(sheet.indexOf('<autoFilter ref="A1:C3"/>') !== -1, sheet.slice(-300));
  verdadeiro(sheet.indexOf('ySplit="1"') !== -1);
  verdadeiro(sheet.indexOf('topLeftCell="A2"') !== -1);
});

teste('com título e três linhas de contexto, o cabeçalho é a linha 5', () => {
  // O teste que pega quem fixou "A1": aqui a linha 1 é o título, e um filtro
  // sobre ele filtraria a frase "34 inscrições" em vez da tabela.
  const { sheet } = gerar({
    aba: 'Inscritos',
    titulo: 'ARTE DIGITAL FLORIPA',
    linhasDeTopo: [
      '34 inscrições · 34 ocupando vaga de 60',
      'Filtro aplicado: curso e fase = PMM21',
      'Exportado em 17/08/2026 20:31'
    ],
    colunas: COLUNAS,
    linhas: SIMPLES.linhas
  });

  igual(textoDa(celulaDe(sheet, 'A1')), 'ARTE DIGITAL FLORIPA');
  igual(textoDa(celulaDe(sheet, 'A4')), 'Exportado em 17/08/2026 20:31');
  igual(textoDa(celulaDe(sheet, 'A5')), 'Matrícula');
  igual(textoDa(celulaDe(sheet, 'B6')), 'Ana Paula');

  verdadeiro(sheet.indexOf('<autoFilter ref="A5:C7"/>') !== -1,
    'autoFilter não está na linha do cabeçalho: ' + /<autoFilter[^>]*>/.exec(sheet));
  verdadeiro(sheet.indexOf('ySplit="5"') !== -1,
    'congelamento errado: ' + /<pane[^>]*>/.exec(sheet));
  verdadeiro(sheet.indexOf('topLeftCell="A6"') !== -1);
});

teste('só título, sem linhas de contexto: cabeçalho na linha 2', () => {
  const { sheet } = gerar({
    aba: 'X', titulo: 'ARTE DIGITAL', colunas: COLUNAS, linhas: SIMPLES.linhas
  });
  igual(textoDa(celulaDe(sheet, 'A2')), 'Matrícula');
  verdadeiro(sheet.indexOf('<autoFilter ref="A2:C4"/>') !== -1);
  verdadeiro(sheet.indexOf('ySplit="2"') !== -1);
});

teste('só linhas de contexto, sem título: cabeçalho na linha 3', () => {
  const { sheet } = gerar({
    aba: 'X', linhasDeTopo: ['uma', 'duas'], colunas: COLUNAS, linhas: SIMPLES.linhas
  });
  igual(textoDa(celulaDe(sheet, 'A1')), 'uma');
  igual(textoDa(celulaDe(sheet, 'A3')), 'Matrícula');
  verdadeiro(sheet.indexOf('ySplit="3"') !== -1);
  verdadeiro(sheet.indexOf('<autoFilter ref="A3:C5"/>') !== -1);
});

teste('o congelamento é frozen e desce uma linha abaixo do cabeçalho', () => {
  const { sheet } = gerar({ aba: 'X', titulo: 'T', colunas: COLUNAS, linhas: SIMPLES.linhas });
  const pane = /<pane[^>]*>/.exec(sheet)[0];
  verdadeiro(pane.indexOf('state="frozen"') !== -1, pane);
  verdadeiro(pane.indexOf('activePane="bottomLeft"') !== -1, pane);
  verdadeiro(pane.indexOf('topLeftCell="A3"') !== -1, pane);
});

// ==================================================== A forma

grupo('a forma — o que o OOXML exige e o Excel não perdoa');

teste('cols vem antes de sheetData, e autoFilter depois', () => {
  // O esquema define SEQUÊNCIA. Fora de ordem, o Excel recusa com a mesma
  // mensagem genérica de "conteúdo ilegível".
  const { sheet } = gerar(SIMPLES);
  verdadeiro(sheet.indexOf('<cols>') < sheet.indexOf('<sheetData>'), 'cols depois de sheetData');
  verdadeiro(sheet.indexOf('<sheetData>') < sheet.indexOf('<autoFilter'),
    'autoFilter antes de sheetData');
  verdadeiro(sheet.indexOf('<dimension') < sheet.indexOf('<sheetViews>'),
    'dimension depois de sheetViews');
  verdadeiro(sheet.indexOf('<sheetViews>') < sheet.indexOf('<cols>'), 'sheetViews depois de cols');
});

teste('a largura declarada vira col customWidth, e a omitida ganha um padrão', () => {
  const { sheet } = gerar({
    aba: 'X',
    colunas: [
      { rotulo: 'Matrícula', chave: 'matricula', largura: 14 },
      { rotulo: 'Nome', chave: 'nome' }
    ],
    linhas: []
  });
  verdadeiro(sheet.indexOf('<col min="1" max="1" width="14" customWidth="1"/>') !== -1, sheet);
  // Sem padrão, a coluna sairia com os 8,43 do Excel e cortaria todo nome.
  const segunda = /<col min="2"[^>]*>/.exec(sheet)[0];
  verdadeiro(/width="(\d+)"/.test(segunda) &&
    Number(/width="(\d+)"/.exec(segunda)[1]) >= 12, segunda);
});

teste('o cabeçalho é negrito, branco e com o vinho da identidade', () => {
  const { mapa } = gerar(SIMPLES);
  const estilos = mapa['xl/styles.xml'].texto;
  verdadeiro(estilos.indexOf('FF5C2235') !== -1, 'o vinho #5C2235 sumiu de styles.xml');
  verdadeiro(/<font><b\/><sz val="11"\/><color rgb="FFFFFFFF"\/>/.test(estilos),
    'a fonte do cabeçalho deixou de ser negrito branco');
  verdadeiro(/patternType="solid"><fgColor rgb="FF5C2235"/.test(estilos),
    'o preenchimento do cabeçalho deixou de ser sólido');
});

teste('as duas primeiras fills são none e gray125, na ordem que o Excel exige', () => {
  const estilos = gerar(SIMPLES).mapa['xl/styles.xml'].texto;
  const fills = /<fills[^>]*>([\s\S]*?)<\/fills>/.exec(estilos)[1];
  verdadeiro(fills.indexOf('<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>') === 0, fills);
});

teste('a célula da matrícula aponta um estilo com o formato de texto do Excel', () => {
  // Cinto e suspensório junto com o inlineStr: é o que segura o zero da frente
  // depois que o professor copia e cola a coluna dentro do próprio Excel.
  // Resolvido pelo `s=` da célula, e não procurado solto no arquivo.
  const { sheet, mapa } = gerar(SIMPLES);
  const xf = estiloDaCelula(mapa['xl/styles.xml'].texto, celulaDe(sheet, 'A2'));
  verdadeiro(xf.indexOf('numFmtId="49"') !== -1, 'numFmtId 49 é o "@" (texto): ' + xf);
  verdadeiro(xf.indexOf('applyNumberFormat="1"') !== -1,
    'sem applyNumberFormat o Excel ignora o numFmtId: ' + xf);
});

teste('a célula do cabeçalho aponta o estilo com o fundo vinho', () => {
  const { sheet, mapa } = gerar(SIMPLES);
  const xf = estiloDaCelula(mapa['xl/styles.xml'].texto, celulaDe(sheet, 'A1'));
  verdadeiro(/fillId="2"/.test(xf) && xf.indexOf('applyFill="1"') !== -1,
    'o cabeçalho parou de apontar o preenchimento vinho: ' + xf);
  verdadeiro(/fontId="1"/.test(xf) && xf.indexOf('applyFont="1"') !== -1,
    'o cabeçalho parou de apontar a fonte negrito branca: ' + xf);
});

teste('a contagem declarada em cellXfs bate com os xf de verdade', () => {
  // O Excel lê o `count` e o usa. Acrescentar um estilo sem somar aqui produz
  // um arquivo que ele "repara" sozinho — descartando a formatação inteira.
  const estilos = gerar(SIMPLES).mapa['xl/styles.xml'].texto;
  const bloco = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(estilos);
  igual((bloco[2].match(/<xf /g) || []).length, Number(bloco[1]));
});

teste('a dimension cobre da primeira à última célula', () => {
  const { sheet } = gerar({
    aba: 'X', titulo: 'T', linhasDeTopo: ['a'], colunas: COLUNAS, linhas: SIMPLES.linhas
  });
  verdadeiro(sheet.indexOf('<dimension ref="A1:C5"/>') !== -1, /<dimension[^>]*>/.exec(sheet)[0]);
});

// ==================================================== A aba

grupo('o nome da aba — saneado antes de o Excel reclamar');

teste('caractere proibido vira espaço, sem grudar as palavras', () => {
  const { mapa } = gerar({ aba: 'Robótica: nível I', colunas: COLUNAS, linhas: [] });
  const nome = /<sheet name="([^"]*)"/.exec(mapa['xl/workbook.xml'].texto)[1];
  igual(nome, 'Robótica nível I');
});

teste('todos os sete proibidos saem', () => {
  const { mapa } = gerar({ aba: 'a:b\\c/d?e*f[g]h', colunas: COLUNAS, linhas: [] });
  const nome = /<sheet name="([^"]*)"/.exec(mapa['xl/workbook.xml'].texto)[1];
  igual(nome, 'a b c d e f g h');
});

teste('nome com mais de 31 caracteres é cortado em 31', () => {
  const { mapa } = gerar({
    aba: 'Projeto de Extensao em Arte Digital de Florianopolis',
    colunas: COLUNAS, linhas: []
  });
  const nome = /<sheet name="([^"]*)"/.exec(mapa['xl/workbook.xml'].texto)[1];
  igual(nome.length, 31);
  igual(nome, 'Projeto de Extensao em Arte Dig');
});

teste('o corte não deixa espaço nem aspa na ponta', () => {
  // O Excel também recusa aspa simples no começo e no fim (é o delimitador dele
  // em fórmulas entre abas), e o corte em 31 às vezes cai logo depois de um
  // espaço.
  const { mapa } = gerar({
    aba: "'Projeto de Extensao em Arte  Digital'", colunas: COLUNAS, linhas: []
  });
  const nome = /<sheet name="([^"]*)"/.exec(mapa['xl/workbook.xml'].texto)[1];
  verdadeiro(!/^['\s]|['\s]$/.test(nome), '[' + nome + ']');
});

teste('aba ausente ou vazia ganha um nome, porque o Excel não aceita vazio', () => {
  [undefined, '', '   ', ':::'].forEach((aba) => {
    const { mapa } = gerar({ aba, colunas: COLUNAS, linhas: [] });
    const nome = /<sheet name="([^"]*)"/.exec(mapa['xl/workbook.xml'].texto)[1];
    verdadeiro(nome.length > 0, 'aba ' + JSON.stringify(aba) + ' virou nome vazio');
  });
});

teste('nome de aba com & é escapado no atributo', () => {
  const { mapa } = gerar({ aba: 'Arte & Design', colunas: COLUNAS, linhas: [] });
  verdadeiro(mapa['xl/workbook.xml'].texto.indexOf('name="Arte &amp; Design"') !== -1,
    mapa['xl/workbook.xml'].texto);
});

// ==================================================== Os extremos

grupo('os extremos — o projeto sem inscrito e a exportação grande');

teste('zero linhas gera arquivo válido, só com o cabeçalho', () => {
  // O projeto em que ninguém se inscreveu ainda. O professor precisa abrir, ver
  // os títulos e entender que está vazio — e não receber um arquivo quebrado.
  const { partes, sheet } = gerar({ aba: 'Inscritos', colunas: COLUNAS, linhas: [] });
  igual(partes.length, 6);
  igual(textoDa(celulaDe(sheet, 'A1')), 'Matrícula');
  igual((sheet.match(/<row /g) || []).length, 1);
  verdadeiro(sheet.indexOf('<autoFilter ref="A1:C1"/>') !== -1,
    'a faixa do filtro tem de ser o cabeçalho sozinho: ' + /<autoFilter[^>]*>/.exec(sheet));
  verdadeiro(sheet.indexOf('<dimension ref="A1:C1"/>') !== -1);
  partes.forEach((parte) => igual(parte.crc, crc32(parte.dados), 'CRC de ' + parte.nome));
});

teste('zero linhas com título e contexto continua coerente', () => {
  const { sheet } = gerar({
    aba: 'X', titulo: 'ARTE', linhasDeTopo: ['0 inscrições'], colunas: COLUNAS, linhas: []
  });
  verdadeiro(sheet.indexOf('<autoFilter ref="A3:C3"/>') !== -1, /<autoFilter[^>]*>/.exec(sheet)[0]);
  verdadeiro(sheet.indexOf('ySplit="3"') !== -1);
});

teste('spec sem colunas é recusado na hora, e não vira arquivo ilegível', () => {
  lancou(() => Planilha.xlsx({ aba: 'X', colunas: [], linhas: [] }), 'coluna');
  lancou(() => Planilha.xlsx({ aba: 'X', linhas: [] }), 'coluna');
});

teste('232 linhas com dados sujos ainda produzem CRCs corretos', () => {
  const linhas = [];
  for (let i = 0; i < 232; i++) {
    linhas.push({
      matricula: '0' + String(2510000 + i),
      nome: 'Aluno & Cia <' + i + '> "aspas" ção',
      email: i % 7 === 0 ? null : 'aluno' + i + '@exemplo.br'
    });
  }
  const { partes, sheet } = gerar({
    aba: 'Inscritos', titulo: 'ARTE DIGITAL FLORIPA',
    linhasDeTopo: ['232 inscrições', 'Exportado em 18/08/2026'],
    colunas: COLUNAS, linhas
  });
  partes.forEach((parte) => igual(parte.crc, crc32(parte.dados), 'CRC de ' + parte.nome));
  igual((sheet.match(/<row /g) || []).length, 232 + 3 + 1);
  igual(textoDa(celulaDe(sheet, 'A236')), '0' + String(2510231));
  verdadeiro(sheet.indexOf('<autoFilter ref="A4:C236"/>') !== -1,
    /<autoFilter[^>]*>/.exec(sheet)[0]);
});

// ==================================================== O download

grupo('baixar — o mesmo caminho do baixarCsv do painel');

teste('cria o link, clica, tira do documento e solta a URL', () => {
  const { Planilha: P, registro } = ambiente();
  const blob = P.xlsx(SIMPLES);
  P.baixar(blob, 'cesutech_inscritos.xlsx');

  igual(registro.criados.length, 1);
  igual(registro.criados[0].tag, 'a');
  igual(registro.criados[0].download, 'cesutech_inscritos.xlsx');
  igual(registro.criados[0].cliques, 1);
  // O Firefox ignora click() em elemento fora da árvore — sem o appendChild o
  // download simplesmente não acontece lá, e acontece no Chrome de quem testou.
  igual(registro.anexados.length, 1);
  igual(registro.removidos.length, 1);
  // Sem o revoke a planilha inteira fica na memória da aba, e o painel é uma
  // tela que o professor deixa aberta o dia todo.
  igual(registro.revogados, [registro.criados[0].href]);
});

teste('o contrato público é exatamente xlsx e baixar', () => {
  const { Planilha: P } = ambiente();
  igual(Object.keys(P).sort(), ['baixar', 'xlsx']);
  igual(typeof P.xlsx, 'function');
  igual(typeof P.baixar, 'function');
});

teste('o arquivo não deixa nada além de window.Planilha para trás', () => {
  // Ele é carregado por <script src> no painel, no mesmo escopo global de tudo.
  const registro = [];
  const janela = new Proxy({}, {
    set(alvo, chave, valor) { registro.push(chave); alvo[chave] = valor; return true; }
  });
  const contexto = {
    window: janela, document: { body: {}, createElement: () => ({}) },
    TextEncoder, DataView, Uint8Array, Uint32Array, String, Number, Math, JSON,
    Error, Array, Object, Boolean, RegExp, isNaN, parseInt, parseFloat,
    Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL() {} }
  };
  contexto.globalThis = contexto;
  const sandbox = vm.createContext(contexto);
  vm.runInContext(CODIGO, sandbox, { filename: 'planilha.js' });

  igual(registro, ['Planilha']);
  verdadeiro(sandbox.crc32 === undefined, 'crc32 vazou para o global');
  verdadeiro(sandbox.escaparXml === undefined, 'escaparXml vazou para o global');
});

teste('o arquivo não carrega nada de fora — a regra do projeto', () => {
  verdadeiro(!/https?:\/\/(?!schemas\.openxmlformats\.org)/.test(CODIGO),
    'só as URLs de namespace do OOXML podem aparecer, e elas nunca são buscadas');
  verdadeiro(CODIGO.indexOf('require(') === -1);
  verdadeiro(CODIGO.indexOf('import ') === -1);
});

// ---------------------------------------------------------------- Resultado

process.exit(resultado());
