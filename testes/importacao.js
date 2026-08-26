/**
 * importacao.js — testa a importação da lista oficial (05_Importacao.gs) sem
 * tocar no Google.
 *
 * O que se prova aqui, em ordem de importância:
 *   1. O CONTRATO. O que a importação grava é lido por `matriculaConhecida`
 *      (04_Inscricoes.gs) — o teste grava pela importação de verdade e consulta
 *      pela função de verdade, com a matrícula digitada com pontuação, como o
 *      aluno digita. Se o id do documento deixar de ser a matrícula normalizada,
 *      este arquivo fica vermelho; era o único jeito de essa quebra não passar
 *      com os testes verdes e derrubar todas as inscrições em produção.
 *   2. A importação NÃO LÊ o Firestore. Nenhum GET, nenhum runQuery — a cota de
 *      leitura é do caminho público, e o painel não pode comê-la.
 *   3. Reimportar não duplica e não apaga: mesma chave, mesmo documento.
 *   4. Commit parcial é RELATADO, não escondido: o número de gravados é o real,
 *      o lote registra PARCIAL e o arquivo temporário sobrevive para a retomada.
 *   5. Arquivo sem matrícula é recusado inteiro, porque uma lista oficial sem
 *      matrícula ligaria o bloqueio de 04_Inscricoes.gs sobre uma lista que não
 *      reconhece ninguém.
 *
 * O Firestore falso e o relator vêm de `apoio.js`. O que está aqui e não lá são
 * os serviços que só a importação usa — Drive, base64, parseCsv —, porque
 * `apoio.js` é compartilhado com as outras fases e não é meu para mexer.
 *
 * Uso:  node testes/importacao.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  teste, grupo, igual, verdadeiro, resultado, criarAmbiente
} = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');

// Ordem alfabética, a mesma em que o editor do Apps Script carrega os arquivos.
// `12_Disciplinas.gs` entrou em 12/08 por causa de um grupo só: o da turma como
// chave de comparação. O cruzamento da disciplina é o LEITOR do campo que a
// importação grava, e provar a normalização sem ele seria provar meia ponta —
// a que nunca esteve quebrada.
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '02b_Drive.gs',
  '03_Config.gs', '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs',
  '05b_FormatoAcademico.gs', '07_Auth.gs', '12_Disciplinas.gs'];

const TOKEN = 'token-de-sessao';

// ------------------------------------------------------------ Serviços falsos

/**
 * Blob do Apps Script, com o que este arquivo usa.
 *
 * `setContentType` devolve o próprio blob (é encadeável no Apps Script de
 * verdade) e GUARDA o tipo, porque o falso do `Utilities.unzip` recusa blob que
 * não se declare zip — que é o comportamento real e o motivo de
 * `partesDoXlsx_` chamar setContentType antes de desempacotar.
 */
function criarBlob(conteudo, mime, nome) {
  const bytes = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo), 'utf8');
  let tipo = mime || '';

  const blob = {
    getName: () => nome || '',
    getBytes: () => bytes,
    getContentType: () => tipo,
    setContentType: (novo) => { tipo = novo; return blob; },
    getDataAsString: () => bytes.toString('utf8')
  };
  return blob;
}

/**
 * Drive em memória, com o pouco que 02b_Drive.gs usa: criar, listar e mandar
 * para a lixeira pelo serviço avançado, e BAIXAR/EXPORTAR por HTTP.
 *
 * Por que as duas leituras de conteúdo são HTTP e não método do serviço
 * avançado: porque é assim em produção. O serviço avançado do Apps Script não
 * carrega mídia — `Drive.Files.get(id, {alt:'media'})` é entregue como erro
 * mesmo voltando 200, e a assinatura de `Drive.Files.export` na v3 devolve
 * `void`. Um falso que respondesse `Drive.Files.export(id, 'text/plain')` com o
 * texto certinho seria exatamente o tipo de falso que já nos enganou: ele
 * provaria um caminho que não existe.
 *
 * Daí este falso NÃO oferecer `Drive.Files.export`. O que ele atende são as duas
 * URLs de verdade, com os erros de verdade — inclusive o 403 que o Drive devolve
 * quando alguém pede `alt=media` num Documento nativo, ou `export` num arquivo
 * que não é nativo.
 */
const DRIVE_REST = 'https://www.googleapis.com/drive/v3/files/';
const MIME_DOC = 'application/vnd.google-apps.document';

function criarDriveFalso() {
  const arquivos = new Map();
  const fetches = [];
  let proximo = 1;
  // O que o OCR "leu". Fica sob controle do teste porque a qualidade do OCR não
  // é o que se prova aqui — o encadeamento é.
  let ocr = '';

  function existente(id) {
    const f = arquivos.get(id);
    if (!f || f.trashed) {
      const erro = new Error('File not found: ' + id);
      erro.status = 'NOT_FOUND';
      throw erro;
    }
    return f;
  }

  function resposta(codigo, texto) {
    return { getResponseCode: () => codigo, getContentText: () => texto };
  }

  function erro(codigo, motivo, mensagem) {
    return resposta(codigo, JSON.stringify({
      error: { code: codigo, message: mensagem, errors: [{ reason: motivo }] }
    }));
  }

  return {
    arquivos,
    fetches,
    definirOcr(texto) { ocr = texto; },

    Drive: {
      Files: {
        create(recurso, blob, params) {
          const id = 'drv_' + (proximo++);
          arquivos.set(id, {
            id,
            name: (recurso && recurso.name) || (blob && blob.getName()) || '',
            mimeType: (recurso && recurso.mimeType) || 'text/plain',
            parents: (recurso && recurso.parents) || [],
            conteudo: blob ? blob.getDataAsString('UTF-8') : '',
            trashed: false,
            createdTime: new Date().toISOString()
          });
          return { id, name: arquivos.get(id).name, params };
        },
        get(id, params) {
          const f = existente(id);
          if (params && params.alt === 'media') {
            // Ver o comentário do topo: o serviço avançado não baixa mídia.
            throw new Error('Empty response. O serviço avançado não carrega mídia — ' +
              'baixe por HTTP (driveBaixarTexto_).');
          }
          return { id: f.id, trashed: f.trashed };
        },
        update(recurso, id, media, params) {
          const f = arquivos.get(id);
          if (!f) throw new Error('File not found: ' + id);
          if (recurso && recurso.trashed !== undefined) f.trashed = recurso.trashed;
          return { id, params };
        },
        list(params) {
          const pai = /'([^']+)' in parents/.exec(params.q || '');
          const files = [];
          arquivos.forEach((f) => {
            if (f.trashed) return;
            if (pai && f.parents.indexOf(pai[1]) === -1) return;
            files.push({ id: f.id, name: f.name, createdTime: f.createdTime, mimeType: f.mimeType });
          });
          return { files };
        }
      },
      Permissions: { create() { return {}; } }
    },

    /** Responde as duas URLs REST que o Drive expõe e o serviço avançado não. */
    atender(url, opcoes) {
      fetches.push({ url, opcoes });

      const cabecalhos = (opcoes && opcoes.headers) || {};
      if (String(cabecalhos.Authorization || '').indexOf('Bearer ') !== 0) {
        return erro(401, 'required', 'Login Required.');
      }
      if (!opcoes.muteHttpExceptions) {
        throw new Error('sem muteHttpExceptions o cliente não consegue ler o corpo do erro');
      }

      const exportar = new RegExp('^' + DRIVE_REST + '([^/?]+)/export\\?mimeType=(.+)$').exec(url);
      if (exportar) {
        const f = arquivos.get(decodeURIComponent(exportar[1]));
        if (!f || f.trashed) return erro(404, 'notFound', 'File not found.');
        if (f.mimeType.indexOf('application/vnd.google-apps.') !== 0) {
          return erro(403, 'fileNotExportable', 'Export only supports Docs Editors files.');
        }
        if (decodeURIComponent(exportar[2]) !== 'text/plain') {
          return erro(400, 'badRequest', 'Unsupported export mimeType.');
        }
        return resposta(200, f.mimeType === MIME_DOC ? ocr : f.conteudo);
      }

      const media = new RegExp('^' + DRIVE_REST + '([^/?]+)\\?alt=media$').exec(url);
      if (media) {
        const f = arquivos.get(decodeURIComponent(media[1]));
        if (!f || f.trashed) return erro(404, 'notFound', 'File not found.');
        if (f.mimeType.indexOf('application/vnd.google-apps.') === 0) {
          return erro(403, 'fileNotDownloadable',
            'Only files with binary content can be downloaded. Use Export with Docs Editors files.');
        }
        return resposta(200, f.conteudo);
      }

      return erro(404, 'notFound', 'rota não atendida pelo falso: ' + url);
    }
  };
}

// ------------------------------------------------- ZIP e XML, para o .xlsx

/**
 * Um .xlsx é um ZIP, e o teste monta um ZIP DE VERDADE — cabeçalho local,
 * diretório central, CRC-32 e tudo. Podia ser mais fácil fingir o `unzip` e
 * entregar os XML direto, e seria fingir demais: a montagem real é o que prova
 * que os caminhos das partes ('xl/sharedStrings.xml') são os que o parser
 * procura, e que o blob que chega em `Utilities.unzip` é mesmo um zip.
 *
 * O que este arquivo NÃO prova, e nenhum teste daqui pode: que o
 * `Utilities.unzip` do Google aceite este blob. Ver o cabeçalho do grupo XLSX.
 */
const TABELA_CRC = (() => {
  const tabela = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[i] = c;
  }
  return tabela;
})();

function crc32(buffer) {
  let c = 0 ^ -1;
  for (let i = 0; i < buffer.length; i++) {
    c = (c >>> 8) ^ TABELA_CRC[(c ^ buffer[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

/** ZIP sem compressão (método 0). `entradas`: [{ nome, texto }]. */
function zipar(entradas) {
  const locais = [];
  const central = [];
  let deslocamento = 0;

  entradas.forEach((entrada) => {
    const nome = Buffer.from(entrada.nome, 'utf8');
    const dados = Buffer.from(entrada.texto, 'utf8');
    const crc = crc32(dados);

    const local = Buffer.alloc(30 + nome.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);          // método 0 = guardado
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dados.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nome.length, 26);
    nome.copy(local, 30);

    const registro = Buffer.alloc(46 + nome.length);
    registro.writeUInt32LE(0x02014b50, 0);
    registro.writeUInt16LE(20, 4);
    registro.writeUInt16LE(20, 6);
    registro.writeUInt16LE(0, 10);
    registro.writeUInt32LE(crc, 16);
    registro.writeUInt32LE(dados.length, 20);
    registro.writeUInt32LE(dados.length, 24);
    registro.writeUInt16LE(nome.length, 28);
    registro.writeUInt32LE(deslocamento, 42);
    nome.copy(registro, 46);

    locais.push(local, dados);
    central.push(registro);
    deslocamento += local.length + dados.length;
  });

  const diretorio = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);

  return Buffer.concat([...locais, diretorio, fim]);
}

/** Lê os cabeçalhos locais do ZIP acima. É o `Utilities.unzip` do falso. */
function desziparGuardado(buffer) {
  const entradas = [];
  let i = 0;

  while (i + 30 <= buffer.length && buffer.readUInt32LE(i) === 0x04034b50) {
    if (buffer.readUInt16LE(i + 8) !== 0) throw new Error('o zip do teste é só guardado');
    const tamanho = buffer.readUInt32LE(i + 18);
    const tamNome = buffer.readUInt16LE(i + 26);
    const tamExtra = buffer.readUInt16LE(i + 28);
    const nome = buffer.slice(i + 30, i + 30 + tamNome).toString('utf8');
    const inicio = i + 30 + tamNome + tamExtra;

    entradas.push({ nome, dados: buffer.slice(inicio, inicio + tamanho) });
    i = inicio + tamanho;
  }

  if (!entradas.length) throw new Error('Invalid argument: blob (não é um zip)');
  return entradas;
}

/**
 * `XmlService` o suficiente para os XML do OOXML: elementos, atributos, texto,
 * tag vazia, comentário, CDATA e as cinco entidades.
 *
 * NAMESPACE, e é a parte que importa: este falso guarda o nome LOCAL, sem
 * prefixo, e não modela Namespace nenhum. Isso não é preguiça — é o contrato que
 * 05_Importacao.gs escolheu. Lá a leitura é toda por `getName()`, justamente
 * porque `getChild('row')` sem passar o Namespace devolve null quando o
 * documento tem namespace padrão, que é o caso de todo .xlsx. Se alguém trocar
 * aquela leitura por `getChild`/`getChildren` com nome, este falso continuaria
 * verde e a produção devolveria planilha vazia — por isso os XML deste arquivo
 * declaram os namespaces de verdade, e por isso um dos testes usa prefixo `x:`.
 */
function analisarXml(texto) {
  const pilha = [];
  let raiz = null;
  let i = 0;

  const desescapar = (t) => t
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

  const local = (nome) => nome.split(':').pop();

  function montar(corpo) {
    const nome = local(/^([^\s/]+)/.exec(corpo)[1]);
    const atributos = [];
    const padrao = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m = padrao.exec(corpo);
    while (m) {
      const valor = desescapar(m[3] !== undefined ? m[3] : m[4]);
      const chave = local(m[1]);
      atributos.push({ getName: () => chave, getValue: () => valor });
      m = padrao.exec(corpo);
    }

    const filhos = [];
    let conteudo = '';
    const elemento = {
      getName: () => nome,
      getAttributes: () => atributos,
      getChildren: () => filhos,
      // getText() do XmlService devolve o texto DIRETO do elemento, e não o dos
      // descendentes — é por isso que `textoDoSi_` desce até cada <t>.
      getText: () => conteudo,
      _filho: (f) => filhos.push(f),
      _texto: (t) => { conteudo += t; }
    };
    return elemento;
  }

  while (i < texto.length) {
    const abre = texto.indexOf('<', i);
    if (abre === -1) break;
    if (abre > i && pilha.length) pilha[pilha.length - 1]._texto(desescapar(texto.slice(i, abre)));

    if (texto.slice(abre, abre + 4) === '<!--') { i = texto.indexOf('-->', abre) + 3; continue; }
    if (texto.slice(abre, abre + 9) === '<![CDATA[') {
      const fimCdata = texto.indexOf(']]>', abre);
      if (pilha.length) pilha[pilha.length - 1]._texto(texto.slice(abre + 9, fimCdata));
      i = fimCdata + 3;
      continue;
    }

    const fecha = texto.indexOf('>', abre);
    if (fecha === -1) break;
    const corpo = texto.slice(abre + 1, fecha);
    i = fecha + 1;

    if (corpo.charAt(0) === '?' || corpo.charAt(0) === '!') continue;
    if (corpo.charAt(0) === '/') { pilha.pop(); continue; }

    const vazio = corpo.charAt(corpo.length - 1) === '/';
    const elemento = montar(vazio ? corpo.slice(0, -1) : corpo);

    if (pilha.length) pilha[pilha.length - 1]._filho(elemento);
    else if (!raiz) raiz = elemento;
    if (!vazio) pilha.push(elemento);
  }

  if (!raiz) throw new Error('XML sem elemento raiz');
  return raiz;
}

/**
 * `Utilities.parseCsv` o suficiente: separador configurável, aspas duplas e
 * aspas escapadas por duplicação. O Apps Script devolve matriz de strings.
 */
function parseCsv(texto, separador) {
  const sep = separador || ',';
  const linhas = [];
  let campo = '';
  let linha = [];
  let dentroDeAspas = false;

  const fecharCampo = () => { linha.push(campo); campo = ''; };
  const fecharLinha = () => { fecharCampo(); linhas.push(linha); linha = []; };

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];

    if (dentroDeAspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') dentroDeAspas = false;
      else campo += c;
      continue;
    }

    if (c === '"') dentroDeAspas = true;
    else if (c === sep) fecharCampo();
    else if (c === '\r') { /* CRLF: o \n fecha a linha */ }
    else if (c === '\n') fecharLinha();
    else campo += c;
  }
  if (campo !== '' || linha.length) fecharLinha();

  return linhas;
}

/**
 * Ambiente completo: os `.gs`, o Drive falso, os serviços que a importação usa e
 * uma sessão de administrador já válida.
 */
function ambiente(opcoes) {
  opcoes = opcoes || {};
  const amb = criarAmbiente(Object.assign(
    { arquivos: GS, usuario: 'prof@unicesusc.br' },
    opcoes
  ));

  const drive = criarDriveFalso();
  amb.drive = drive;
  amb.api.Drive = drive.Drive;

  // GOOGLE_SHEETS saiu junto com a conversão do XLSX: o falso só oferece o que o
  // código ainda usa, senão ele deixa de dizer o que o código faz.
  amb.api.MimeType = { GOOGLE_DOCS: MIME_DOC, PLAIN_TEXT: 'text/plain' };

  // As leituras de conteúdo do Drive saem por HTTP (ver `criarDriveFalso`), e
  // precisam ser desviadas ANTES do UrlFetchApp do apoio.js: se caíssem lá, elas
  // entrariam em `falso.requisicoes` e os testes de orçamento contariam um GET
  // do Drive como leitura do Firestore. A cota que eles vigiam é a do banco.
  const fetchFirestore = amb.falso.UrlFetchApp.fetch;
  amb.roteador = {
    fetch(url, opcoes) {
      if (String(url).indexOf('https://www.googleapis.com/drive/') === 0) {
        return drive.atender(url, opcoes);
      }
      return fetchFirestore(url, opcoes);
    },
    // O Drive é lido um arquivo por vez; quem manda lote é só o Firestore.
    fetchAll: (lote) => amb.falso.UrlFetchApp.fetchAll(lote)
  };
  amb.api.UrlFetchApp = amb.roteador;

  // O Utilities do apoio.js já tem formatDate, getUuid e computeDigest; aqui
  // entram só os que a importação acrescenta.
  amb.api.Utilities.base64Decode = (b64) => Buffer.from(String(b64), 'base64');
  amb.api.Utilities.newBlob = (conteudo, mime, nome) => criarBlob(conteudo, mime, nome);
  amb.api.Utilities.parseCsv = parseCsv;

  // O Apps Script recusa desempacotar um blob que não se declara zip, e é por
  // isso que `partesDoXlsx_` chama setContentType antes. Sem esta recusa aqui, a
  // linha do setContentType poderia sumir sem nenhum teste ficar vermelho.
  amb.api.Utilities.unzip = (blob) => {
    if (blob.getContentType() !== 'application/zip') {
      throw new Error('Invalid argument: blob. Esperava application/zip, recebi "' +
        blob.getContentType() + '"');
    }
    return desziparGuardado(blob.getBytes())
      .map((e) => criarBlob(e.dados, 'application/xml', e.nome));
  };

  amb.api.XmlService = {
    parse: (texto) => ({ getRootElement: () => analisarXml(texto) })
  };

  // Sessão válida sem passar pelo PIN: `exigirAdmin` só olha a propriedade.
  amb.propriedades.set('sess_' + TOKEN, JSON.stringify({
    email: 'prof@unicesusc.br',
    expira_em: new Date().getTime() + 3600000
  }));

  return amb;
}

// ------------------------------------------------------------ Atalhos

function base64De(texto) {
  return Buffer.from(texto, 'utf8').toString('base64');
}

function analisar(api, texto, nome) {
  return api.analisarArquivo({
    token: TOKEN,
    filename: nome || 'lista.csv',
    mimeType: 'text/csv',
    dataBase64: base64De(texto)
  });
}

/** Analisa e confirma em sequência, que é como o painel usa as duas funções. */
function importar(api, texto, opcoes) {
  opcoes = opcoes || {};
  const analise = analisar(api, texto, opcoes.nome);
  if (!analise.ok) return { analise, resultado: analise };

  return {
    analise,
    resultado: api.confirmarImportacao({
      token: TOKEN,
      tempId: analise.tempId,
      arquivo: analise.arquivo,
      tipo: analise.tipo,
      mapeamento: opcoes.mapeamento || analise.mapeamento,
      substituir: !!opcoes.substituir
    })
  };
}

function chaves(falso, colecao) {
  return Array.from(falso.documentos.keys()).filter((k) => k.indexOf(colecao + '/') === 0);
}

function documento(falso, colecao, id) {
  const campos = falso.documentos.get(colecao + '/' + id);
  if (!campos) return null;
  const obj = {};
  Object.keys(campos).forEach((k) => { obj[k] = campos[k].stringValue; });
  return obj;
}

function quantas(falso, casa) {
  return falso.requisicoes.filter(casa).length;
}

const COMMIT = (r) => r.metodo === 'POST' && r.url.indexOf(':commit') !== -1;
const LEITURA = (r) => r.metodo === 'GET' ||
  r.url.indexOf(':runQuery') !== -1 ||
  r.url.indexOf(':runAggregationQuery') !== -1;

const CABECALHO = 'Nome completo;Matrícula;Curso;Turma\n';

function csv(linhas) {
  return CABECALHO + linhas.join('\n') + '\n';
}

const CSV_TRES = csv([
  'BEATRIZ EXEMPLO MARTINS;09110001;Administração;ADM21',
  'BRUNO EXEMPLO DA SILVA;09110002;Marketing;MKT31',
  'CARLA EXEMPLO;09110003;Multimídia;PMM31'
]);

// ------------------------------------------------------------ O contrato

grupo('O contrato com 04_Inscricoes.gs');

// O teste que este arquivo existe para ter. Grava pela importação de verdade,
// consulta pela função de verdade: se o id do documento parar de ser a matrícula
// normalizada, `matriculaConhecida` passa a devolver false para todo mundo e,
// com modo_validacao_matricula=BLOQUEAR, nenhum aluno consegue se inscrever.
teste('o que a importação grava, matriculaConhecida encontra', () => {
  const { api } = ambiente();

  const r = importar(api, CSV_TRES).resultado;
  igual(r.ok, true, 'importação: ' + r.erro);
  igual(r.importadas, 3);

  verdadeiro(api.matriculaConhecida('09110001'), 'matrícula da primeira linha');
  verdadeiro(api.matriculaConhecida('09110003'), 'matrícula da última linha');
  igual(api.matriculaConhecida('99999999'), false, 'quem não está na lista');
});

teste('encontra mesmo com a matrícula digitada com pontuação e espaço', () => {
  const { api } = ambiente();
  importar(api, CSV_TRES);

  // É assim que o aluno digita, e é por isso que as duas pontas passam por
  // `normalizarMatricula`: a importação para formar o id, o formulário para
  // consultar.
  verdadeiro(api.matriculaConhecida(' 091.100-01 '), 'pontuação e espaço');
  verdadeiro(api.matriculaConhecida('09110001\n'), 'quebra de linha colada');
});

teste('o id do documento É a matrícula normalizada', () => {
  const { api, falso } = ambiente();
  importar(api, csv(['MARIA DA SILVA;091-100.04;Administração;ADM21']));

  igual(chaves(falso, 'matriculados'), ['matriculados/9110004']);
});

teste('temListaOficial_ passa a responder SIM depois da importação', () => {
  const { api } = ambiente();

  igual(api.temListaOficial_(), false, 'antes de importar não existe lista');
  importar(api, CSV_TRES);
  igual(api.temListaOficial_(), true);
});

teste('MATRICULADOS_COLECAO tem o mesmo valor em 04_Inscricoes.gs e em 05_Importacao.gs', () => {
  const valorEm = (arquivo) => {
    const m = /var MATRICULADOS_COLECAO = '([^']*)'/.exec(
      fs.readFileSync(path.join(PASTA_GS, arquivo), 'utf8'));
    if (!m) throw new Error(arquivo + ' não declara MATRICULADOS_COLECAO');
    return m[1];
  };

  igual(valorEm('04_Inscricoes.gs'), 'matriculados');
  igual(valorEm('05_Importacao.gs'), valorEm('04_Inscricoes.gs'));
});

teste('a matrícula também é gravada como campo, e igual ao id', () => {
  const { api, falso } = ambiente();
  importar(api, CSV_TRES);

  const doc = documento(falso, 'matriculados', '9110001');
  igual(doc.matricula, '9110001', 'a CHAVE, sem o zero à esquerda');
  igual(doc.matricula_oficial, '09110001', 'a forma OFICIAL, que o aluno vê no documento dele');
  igual(doc.nome, 'Beatriz Exemplo Martins', 'nome formatado');
  igual(doc.turma, 'ADM21');
});

// O painel abre o comparativo "Lista oficial (importada)" lendo campo por campo
// do documento de matriculado (10_Painel.gs, `resolverAluno`/detalhe). Campo que
// eu renomear aqui vira célula vazia lá, sem erro nenhum — daí o formato ficar
// escrito num teste, e não só no schema herdado de 00_Config.gs.
teste('o documento de matriculado tem o formato que as outras fases leem', () => {
  const { api, falso } = ambiente();
  importar(api, CSV_TRES);

  igual(Object.keys(documento(falso, 'matriculados', '9110001')).sort(), [
    'cpf', 'curso', 'data_nascimento', 'email', 'importado_em', 'importado_por',
    'lote_id', 'matricula', 'matricula_oficial', 'nome', 'raw_json', 'situacao', 'telefone', 'turma'
  ]);
});

// ---------------------------------------------- A turma é chave de comparação

/**
 * O contrato com 12_Disciplinas.gs — e o motivo de este arquivo carregar a
 * disciplina no `GS`.
 *
 * O cruzamento "quem da turma ainda não se inscreveu" casa `matriculados.turma`
 * com a turma da disciplina por FILTRO DE IGUALDADE do Firestore. Os dois lados
 * eram normalizados de jeitos diferentes: o cadastro de disciplinas subia para
 * caixa alta, a importação gravava com um `.trim()` e mais nada. Uma planilha
 * com 'Ads11' fazia a tela responder ZERO sobre uma turma cheia — e zero, ali,
 * lê-se "ninguém falta se inscrever".
 *
 * O conserto é da ESCRITA, e é por isso que ele é provado aqui: importa de
 * verdade e cruza de verdade, as duas pontas na mesma execução. Provar só que a
 * gravação sobe para caixa alta deixaria de fora a metade que interessa.
 */
grupo('A turma é chave de comparação, e a importação a normaliza');

teste('turma "Ads11" da secretaria é gravada ADS11', () => {
  const { api, falso } = ambiente();
  importar(api, csv(['MARIA DE SOUZA;09110001;Análise e Desenvolvimento;Ads11']));

  igual(documento(falso, 'matriculados', '9110001').turma, 'ADS11');
});

teste('TODO espaço some da turma — as três escritas viram uma chave só', () => {
  const { api, falso } = ambiente();
  importar(api, csv([
    'MARIA DE SOUZA;09110001;ADS;  ads  11  ',
    'JOAO DA SILVA;09110002;ADM;ADM 41',
    'ANA PEREIRA;09110003;ADM;ADM 41 (MATRIZ NOVA)'
  ]));

  // Até 25/08 a régua preservava o espaço simples e isto era 'ADS 11' — uma
  // turma DIFERENTE de 'ADS11' para o filtro de igualdade do Firestore, e o
  // sintoma era o cruzamento respondendo zero sobre turma cheia.
  igual(documento(falso, 'matriculados', '9110001').turma, 'ADS11');
  igual(documento(falso, 'matriculados', '9110002').turma, 'ADM41');
  igual(documento(falso, 'matriculados', '9110003').turma, 'ADM41',
    'o qualificador de currículo tem de sair da CHAVE');
});

teste('a linha original sobrevive em raw_json — é o que torna o descarte reversível', () => {
  const { api, falso } = ambiente();
  importar(api, csv(['ANA PEREIRA;09110003;ADM;ADM 41 (MATRIZ NOVA)']));

  const doc = documento(falso, 'matriculados', '9110003');
  igual(doc.turma, 'ADM41');
  verdadeiro(doc.raw_json.indexOf('MATRIZ NOVA') !== -1,
    'o qualificador sumiu do registro — descartar da chave não pode apagar do arquivo');
});

teste('o CURSO não sobe para caixa alta — é nome próprio, e gente lê', () => {
  // A régua dele é a do cadastro de disciplinas: colapsa espaço, preserva a
  // caixa. Subir 'Análise e Desenvolvimento de Sistemas' para caixa alta
  // destruiria informação que nenhuma consulta pediu — o filtro de curso do
  // painel compara `alunos.curso` com uma lista que saiu do próprio `alunos`.
  const { api, falso } = ambiente();
  importar(api, csv(['MARIA DE SOUZA;09110001;Análise  e  Desenvolvimento de Sistemas;ADS11']));

  igual(documento(falso, 'matriculados', '9110001').curso,
    'Análise e Desenvolvimento de Sistemas');
});

teste('importada como "Ads11", ela é achada pelo cruzamento da disciplina ADS11', () => {
  // O teste que o conserto existe para ter: as duas pontas de verdade, na mesma
  // execução. Antes de 12/08 este cruzamento respondia `lidas.matriculados: 0` —
  // com a tela dizendo, em letras tranquilas, que ninguém daquela turma faltava
  // se inscrever.
  const { api } = ambiente();
  importar(api, csv(['MARIA DE SOUZA;09110001;ADS;Ads11']));

  api.incluirDisciplinas({
    token: TOKEN,
    linhas: [{ curso: 'PRATICA EXTENSIONISTA', turma: 'ADS11', semestre: '1', ano: '2026' }]
  });
  const disciplina = api.listarDisciplinas({ token: TOKEN }).itens[0];

  const r = api.matriculadosDaDisciplina({ token: TOKEN, id: disciplina.id });

  igual(r.ok, true, r.erro);
  igual(r.lidas.matriculados, 1, 'a turma da lista oficial não casou com a do cadastro');
  igual(r.resumo.semProjeto, 1, 'quem falta se inscrever tem de aparecer');
  igual(r.itens[0].nome, 'Maria de Souza');
  igual(r.avisos, [], 'nada a avisar: a turma foi encontrada');
});

teste('a mesma régua nos dois lados, e ela mora num lugar só', () => {
  // A lição de `codigoDe_` (09_Projetos.gs): a mesma regra escrita duas vezes é
  // uma ponta que muda sozinha, e a divergência não aparece em erro nenhum —
  // aparece numa lista vazia. Foi assim que este defeito nasceu.
  const fonte = (arquivo) => fs.readFileSync(path.join(PASTA_GS, arquivo), 'utf8');

  verdadeiro(/reg\.turma = normalizarTurma\(/.test(fonte('05_Importacao.gs')),
    'a importação parou de usar normalizarTurma — a turma volta a divergir do cadastro');
  verdadeiro(/turma: normalizarTurma\(/.test(fonte('12_Disciplinas.gs')),
    'o cadastro de disciplinas parou de usar normalizarTurma');
  verdadeiro(/function normalizarTurma\(/.test(fonte('01_Utils.gs')),
    'normalizarTurma sumiu de 01_Utils.gs');
});

// ------------------------------------------------------------ Orçamento

grupo('Orçamento de cota');

teste('analisarArquivo não toca no Firestore', () => {
  const { api, falso } = ambiente();

  const r = analisar(api, CSV_TRES);
  igual(r.ok, true, r.erro);
  igual(falso.requisicoes.length, 0, 'o passo 1 vive no Drive, não no banco');
});

teste('confirmarImportacao não LÊ nenhum documento', () => {
  const { api, falso } = ambiente();

  importar(api, CSV_TRES);
  igual(quantas(falso, LEITURA), 0, 'requisições: ' +
    falso.requisicoes.map((r) => r.metodo + ' ' + r.url.split('/documents')[1]).join(' | '));
});

teste('3 linhas custam 1 commit, mais o lote e o log', () => {
  const { api, falso } = ambiente();

  importar(api, CSV_TRES);
  igual(quantas(falso, COMMIT), 1, 'um bloco só');
  igual(chaves(falso, 'lotes').length, 1);
  igual(chaves(falso, 'log').length, 1);
});

teste('1.200 linhas viram 3 commits de no máximo 500 escritas', () => {
  const { api, falso } = ambiente();

  const linhas = [];
  for (let i = 0; i < 1200; i++) {
    linhas.push('ALUNO NUMERO ' + i + ';' + (2000000 + i) + ';Administração;ADM21');
  }

  const r = importar(api, csv(linhas)).resultado;
  igual(r.ok, true, r.erro);
  igual(r.importadas, 1200);
  igual(quantas(falso, COMMIT), 3);

  const maior = falso.requisicoes.filter(COMMIT)
    .reduce((m, req) => Math.max(m, req.corpo.writes.length), 0);
  igual(maior, 500, 'o limite do :commit é 500 e é da API, não nosso');
});

teste('arquivo acima do teto é recusado no passo 1, antes de gastar escrita', () => {
  const { api, falso } = ambiente();

  const linhas = [];
  for (let i = 0; i <= api.IMPORTACAO_MAX_LINHAS; i++) {
    linhas.push('ALUNO ' + i + ';' + (3000000 + i) + ';Administração;ADM21');
  }

  const r = analisar(api, csv(linhas));
  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('20.000') !== -1, 'a recusa explica a cota: ' + r.erro);
  igual(falso.requisicoes.length, 0, 'nada foi escrito');
});

// ------------------------------------------------------------ Recusas

grupo('O que a importação recusa');

teste('sem coluna de matrícula, recusa o arquivo inteiro', () => {
  const { api, falso } = ambiente();

  // O caso que o cabeçalho de 04_Inscricoes.gs manda recusar: uma lista sem
  // matrícula faria `temListaOficial_()` responder SIM e o modo BLOQUEAR
  // passaria a recusar TODO ALUNO, porque nenhuma matrícula seria encontrada.
  const r = importar(api, CSV_TRES, { mapeamento: { nome: 0, curso: 2 } }).resultado;

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('Matrícula') !== -1, r.erro);
  igual(chaves(falso, 'matriculados').length, 0, 'nada entrou');
  igual(api.temListaOficial_(), false);
});

teste('sem coluna de nome, recusa', () => {
  const { api } = ambiente();
  const r = importar(api, CSV_TRES, { mapeamento: { matricula: 1 } }).resultado;

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('Nome completo') !== -1, r.erro);
});

teste('arquivo em que nenhuma linha tem matrícula utilizável é recusado', () => {
  const { api, falso } = ambiente();

  // Matrícula de 3 dígitos: a mesma régua de `validarInscricao`, que recusaria
  // o aluno antes mesmo de o banco ser consultado.
  const r = importar(api, csv(['MARIA DA SILVA;123;Administração;ADM21'])).resultado;

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('sem matrícula utilizável') !== -1, r.erro);
  igual(chaves(falso, 'matriculados').length, 0);
});

teste('linhas sem nome e sem matrícula são contadas, e as boas entram', () => {
  const { api } = ambiente();

  const r = importar(api, csv([
    'BEATRIZ EXEMPLO;09110001;Administração;ADM21',
    ';09110099;Administração;ADM21',
    'SEM MATRICULA NENHUMA;;Administração;ADM21',
    'BRUNO EXEMPLO;09110002;Marketing;MKT31'
  ])).resultado;

  igual(r.ok, true, r.erro);
  igual(r.importadas, 2);
  igual(r.ignoradas, 1, 'a tela diz "ignoradas por não terem nome" — tem de ser só essa');
  igual(r.semMatricula, 1);
  verdadeiro(r.aviso.indexOf('matrícula') !== -1, 'o aviso conta o que a tela não conta');
});

teste('sem token válido, nada acontece', () => {
  const { api, falso } = ambiente();

  const r = api.analisarArquivo({ filename: 'lista.csv', dataBase64: base64De(CSV_TRES) });
  igual(r.ok, false);
  verdadeiro(/Sess.o expirada/.test(r.erro), r.erro);

  const c = api.confirmarImportacao({ tempId: 'drv_1', mapeamento: { nome: 0, matricula: 1 } });
  igual(c.ok, false);
  igual(falso.requisicoes.length, 0);
});

teste('formato não suportado é recusado com o nome da extensão', () => {
  const { api } = ambiente();
  const r = analisar(api, 'qualquer coisa', 'lista.docx');

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('.docx') !== -1, r.erro);
});

teste('arquivo só com cabeçalho é recusado', () => {
  const { api } = ambiente();
  const r = analisar(api, CABECALHO);

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('linhas de dados') !== -1, r.erro);
});

teste('pré-visualização expirada não vira importação vazia', () => {
  const { api } = ambiente();
  const r = api.confirmarImportacao({
    token: TOKEN, tempId: 'drv_inexistente', mapeamento: { nome: 0, matricula: 1 }
  });

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('expirou') !== -1, r.erro);
});

// ------------------------------------------------------------ Upsert

grupo('Reimportar: upsert que não apaga e não duplica');

teste('reimportar o mesmo arquivo não cria documento novo', () => {
  const { api, falso } = ambiente();

  importar(api, CSV_TRES);
  igual(chaves(falso, 'matriculados').length, 3);

  const r = importar(api, CSV_TRES).resultado;
  igual(r.ok, true, r.erro);
  igual(chaves(falso, 'matriculados').length, 3, 'mesma chave, mesmo documento');
});

teste('reimportar atualiza o dado que mudou', () => {
  const { api, falso } = ambiente();

  importar(api, csv(['CARLA EXEMPLO;09110003;Multimídia;PMM31']));
  igual(documento(falso, 'matriculados', '9110003').turma, 'PMM31');

  importar(api, csv(['CARLA EXEMPLO DA COSTA;09110003;Multimídia;PMM41']));
  const doc = documento(falso, 'matriculados', '9110003');
  igual(doc.turma, 'PMM41');
  igual(doc.nome, 'Carla Exemplo da Costa');
});

teste('"substituir" não apaga quem ficou de fora, e diz isso', () => {
  const { api, falso } = ambiente();

  importar(api, CSV_TRES);
  const r = importar(api, csv(['NOVA ALUNA;09110010;Administração;ADM21']),
    { substituir: true }).resultado;

  igual(r.ok, true, r.erro);
  igual(r.substituiu, false, 'a resposta não pode deixar acreditar que apagou');
  verdadeiro(r.aviso.indexOf('NÃO apagou') !== -1, r.aviso);
  verdadeiro(api.matriculaConhecida('09110001'), 'quem já estava continua na lista');
  igual(chaves(falso, 'matriculados').length, 4);
});

teste('matrícula repetida no arquivo vira UMA escrita, e vale a última linha', () => {
  const { api, falso } = ambiente();

  // O relatório acadêmico repete o aluno que cursa duas disciplinas. Duas
  // escritas no mesmo documento dentro de um `:commit` são recusadas pelo
  // Firestore — o lote inteiro cairia.
  const r = importar(api, csv([
    'BRUNO EXEMPLO;09110002;Marketing;MKT21',
    'BRUNO EXEMPLO;09110002;Marketing;MKT31'
  ])).resultado;

  igual(r.ok, true, r.erro);
  igual(r.importadas, 1);
  igual(r.repetidas, 1);
  igual(documento(falso, 'matriculados', '9110002').turma, 'MKT31');

  const escritas = falso.requisicoes.filter(COMMIT)[0].corpo.writes;
  igual(escritas.length, 1, 'um documento, uma escrita');
});

// ------------------------------------------------------------ Commit parcial

grupo('Commit parcial');

/**
 * Intercepta o `:commit` de número `qual` e devolve erro não retentável.
 * Não substitui o Firestore falso: só se põe na frente dele.
 */
function falharNoCommit(amb, qual) {
  const original = amb.api.UrlFetchApp.fetch;
  let commits = 0;

  amb.api.UrlFetchApp = {
    fetch(url, opcoes) {
      if (String(url).indexOf(':commit') !== -1) {
        commits++;
        if (commits === qual) {
          amb.falso.requisicoes.push({ metodo: 'POST', url, corpo: JSON.parse(opcoes.payload) });
          return {
            getResponseCode: () => 400,
            getContentText: () => JSON.stringify({
              error: { code: 400, status: 'INVALID_ARGUMENT', message: 'falha simulada no bloco ' + qual }
            })
          };
        }
      }
      return original(url, opcoes);
    }
  };
}

teste('a gravação que para no meio relata quantos entraram, e não finge', () => {
  const amb = ambiente();
  const { api, falso } = amb;

  const linhas = [];
  for (let i = 0; i < 1200; i++) {
    linhas.push('ALUNO NUMERO ' + i + ';' + (2000000 + i) + ';Administração;ADM21');
  }

  const analise = analisar(api, csv(linhas));
  falharNoCommit(amb, 2);

  const r = api.confirmarImportacao({
    token: TOKEN, tempId: analise.tempId, arquivo: analise.arquivo,
    tipo: analise.tipo, mapeamento: analise.mapeamento
  });

  igual(r.ok, false, 'importação pela metade não é sucesso');
  igual(r.importadas, 500, 'o primeiro bloco entrou de verdade');
  igual(r.previstas, 1200);
  verdadeiro(r.erro.indexOf('500 de 1200') !== -1, r.erro);
  verdadeiro(r.erro.indexOf('mesmo arquivo') !== -1, 'a mensagem tem de ensinar a retomada');
  igual(chaves(falso, 'matriculados').length, 500);
  verdadeiro(api.matriculaConhecida('2000000'), 'quem entrou, entrou');
});

teste('o lote fica registrado como PARCIAL, e o temporário sobrevive para a retomada', () => {
  const amb = ambiente();
  const { api, falso, drive } = amb;

  const linhas = [];
  for (let i = 0; i < 600; i++) {
    linhas.push('ALUNO NUMERO ' + i + ';' + (2000000 + i) + ';Administração;ADM21');
  }

  const analise = analisar(api, csv(linhas));
  falharNoCommit(amb, 1);

  const r = api.confirmarImportacao({
    token: TOKEN, tempId: analise.tempId, mapeamento: analise.mapeamento, arquivo: 'parcial.csv'
  });

  igual(r.ok, false);
  igual(r.importadas, 0);

  const lote = documento(falso, 'lotes', r.loteId);
  igual(lote.status, 'PARCIAL');
  igual(lote.linhas, '0');
  igual(lote.previstas, '600');

  igual(drive.arquivos.get(analise.tempId).trashed, false,
    'o temporário é o que permite confirmar de novo sem reenviar o arquivo');

  // E a retomada funciona: mesmo tempId, sem o interceptador do commit. Volta o
  // roteador, e não o UrlFetchApp cru do apoio.js — o passo 2 precisa do Drive
  // para reler o temporário.
  amb.api.UrlFetchApp = amb.roteador;
  const segunda = api.confirmarImportacao({
    token: TOKEN, tempId: analise.tempId, mapeamento: analise.mapeamento, arquivo: 'parcial.csv'
  });
  igual(segunda.ok, true, segunda.erro);
  igual(segunda.importadas, 600);
});

// ------------------------------------------------------------ Lote e trilha

grupo('Lote e trilha');

teste('cada importação registra quem, quando, quantos e o arquivo', () => {
  const { api, falso } = ambiente();

  const r = importar(api, CSV_TRES, { nome: 'matriculados-2026-2.csv' }).resultado;
  const lote = documento(falso, 'lotes', r.loteId);

  igual(lote.arquivo, 'matriculados-2026-2.csv');
  igual(lote.linhas, '3');
  igual(lote.importado_por, 'prof@unicesusc.br');
  igual(lote.status, 'ATUALIZOU');
  igual(lote.substituir_pedido, 'NAO');
  verdadeiro(lote.importado_em.length === 19, 'hora local legível: ' + lote.importado_em);
  igual(JSON.parse(lote.mapeamento_json).matricula, 1);
});

teste('o lote guarda o pedido de substituir separado do que foi feito', () => {
  const { api, falso } = ambiente();
  const r = importar(api, CSV_TRES, { substituir: true }).resultado;

  const lote = documento(falso, 'lotes', r.loteId);
  igual(lote.substituir_pedido, 'SIM');
  igual(lote.status, 'ATUALIZOU', 'o que foi FEITO foi upsert, e o registro não pode dizer outra coisa');
});

teste('o id do lote é ordenável e o campo criado_em conta a mesma hora', () => {
  const { api, falso } = ambiente();
  const r = importar(api, CSV_TRES).resultado;

  const lote = documento(falso, 'lotes', r.loteId);
  igual(r.loteId.indexOf(lote.criado_em), 0, 'o id começa pelo carimbo de criado_em');
  verdadeiro(/^\d{8}T\d{9}Z_[0-9a-f]{6}$/.test(r.loteId), 'id do lote: ' + r.loteId);
});

teste('a importação aparece no log', () => {
  const { api, falso } = ambiente();
  const r = importar(api, CSV_TRES).resultado;

  const registros = chaves(falso, 'log').map((k) => documento(falso, 'log', k.split('/')[1]));
  const importacao = registros.filter((l) => l.acao === 'IMPORTACAO')[0];

  verdadeiro(importacao, 'nenhum registro IMPORTACAO no log');
  igual(importacao.entidade_id, r.loteId);
  verdadeiro(importacao.detalhe.indexOf('3 matriculados') !== -1, importacao.detalhe);
});

teste('o temporário é descartado quando a importação dá certo', () => {
  const { api, drive } = ambiente();
  const { analise } = importar(api, CSV_TRES);

  igual(drive.arquivos.get(analise.tempId).trashed, true,
    'o temporário guarda a lista inteira de alunos; não fica parado no Drive');
});

teste('limparTemporariosAntigos remove o que passou de um dia', () => {
  const { api, drive } = ambiente();
  analisar(api, CSV_TRES);

  const antigo = Array.from(drive.arquivos.values())[1];
  antigo.createdTime = new Date(new Date().getTime() - 48 * 3600 * 1000).toISOString();

  igual(api.limparTemporariosAntigos(), 1);
  igual(antigo.trashed, true);
});

// ------------------------------------------------------------ Leitura do arquivo

grupo('Leitura do arquivo e mapeamento');

teste('CSV com ponto e vírgula (Excel pt-BR) é lido em colunas', () => {
  const { api } = ambiente();
  const r = analisar(api, CSV_TRES);

  igual(r.ok, true, r.erro);
  igual(r.cabecalhos, ['Nome completo', 'Matrícula', 'Curso', 'Turma']);
  igual(r.totalLinhas, 3);
  igual(r.amostra.length, 3);
  igual(r.tipo, 'CSV');
});

teste('CSV com vírgula e campo entre aspas também', () => {
  const { api } = ambiente();
  const r = analisar(api, 'Nome,Matrícula\n"SILVA, MARIA DA",09110001\n');

  igual(r.ok, true, r.erro);
  igual(r.amostra[0], ['SILVA, MARIA DA', '09110001']);
});

teste('a amostra vem completada até a largura do cabeçalho', () => {
  const { api } = ambiente();
  // Linha curta: sem completar, a tela imprimiria "undefined" na coluna que falta.
  const r = analisar(api, 'Nome;Matrícula;Turma\nMARIA DA SILVA;09110001\n');

  igual(r.ok, true, r.erro);
  igual(r.amostra[0], ['MARIA DA SILVA', '09110001', '']);
});

teste('a amostra mostra no máximo 8 linhas, e o total é o de verdade', () => {
  const { api } = ambiente();

  const linhas = [];
  for (let i = 0; i < 30; i++) linhas.push('ALUNO ' + i + ';' + (2000000 + i) + ';Adm;ADM21');
  const r = analisar(api, csv(linhas));

  igual(r.amostra.length, 8);
  igual(r.totalLinhas, 30);
});

teste('o mapeamento é adivinhado pelos cabeçalhos', () => {
  const { api } = ambiente();
  const r = analisar(api, CSV_TRES);

  igual(r.mapeamento.nome, 0);
  igual(r.mapeamento.matricula, 1);
  igual(r.mapeamento.curso, 2);
  igual(r.mapeamento.turma, 3);
});

/**
 * A turma com ESPAÇO, e o qualificador de currículo.
 *
 * Estes casos não são inventados: saíram dos dois PDFs que o Prof. Mário
 * importou em 25/08 e que trouxeram 1 ou 2 alunos de listas de 26 e 39. A
 * secretaria escreve as duas formas no MESMO semestre — `ADS21` no relatório de
 * ADS e `ADM 41 (MATRIZ NOVA)` no de ADM —, e o padrão antigo
 * (`/\b[A-Z]{2,4}\d{2}\b/`) só casava a primeira.
 *
 * O estrago era calado: turma vazia não é erro de importação, e o sintoma
 * aparecia longe daqui — no cruzamento da aba Disciplinas, que casa
 * `matriculados.turma` por igualdade e responde ZERO sobre uma turma cheia.
 */
grupo('a turma do relatório acadêmico — espaço, qualificador e a armadilha do DDD');

teste('turma com ESPAÇO é lida (ADM 41), e não sai vazia', () => {
  const { api, falso } = ambiente();
  const texto = [
    'Relação de Alunos Matriculados,Coluna',
    'x,NOEMI WEBER (09920158),ADM 41,48900010001',
    'x,TIAGO ZANETTI (09921431),ADM 41,48900010004'
  ].join('\n') + '\n';

  const r = analisar(api, texto, 'adm.csv');
  igual(r.ok, true, r.erro);
  const c = api.confirmarImportacao({
    token: TOKEN, tempId: r.tempId, arquivo: r.arquivo, tipo: r.tipo, mapeamento: r.mapeamento
  });
  igual(c.ok, true, c.erro);
  // Extraída como 'ADM 41' e gravada como 'ADM41': o extrator lê o que o
  // relatório escreve, e `normalizarTurma` reduz à chave. O que importa aqui é
  // que NÃO saiu vazia, que era o defeito.
  igual(documento(falso, 'matriculados', '9920158').turma, 'ADM41');
});

teste('turma com qualificador cai na MESMA chave da turma sem ele', () => {
  const { api, falso } = ambiente();
  const texto = [
    'Relação de Alunos Matriculados,Coluna',
    'x,NOEMI WEBER (09920158),ADM 41 (MATRIZ NOVA),48900010001',
    'x,PATRICIA LOPES FIGUEIREDO (09342914),ADM 31 (MATRIZ NOVA),48900010002'
  ].join('\n') + '\n';

  const r = analisar(api, texto, 'adm.csv');
  const c = api.confirmarImportacao({
    token: TOKEN, tempId: r.tempId, arquivo: r.arquivo, tipo: r.tipo, mapeamento: r.mapeamento
  });
  igual(c.ok, true, c.erro);
  // A CHAVE não carrega o qualificador: é isso que faz o cruzamento casar com o
  // 'ADM41' que o professor digita no cadastro de disciplinas. O qualificador
  // continua no `raw_json` da linha.
  igual(documento(falso, 'matriculados', '9920158').turma, 'ADM41');
  // Fases diferentes continuam SEPARADAS — o que sai é o qualificador, não o número.
  igual(documento(falso, 'matriculados', '9342914').turma, 'ADM31');
});

/**
 * Direto na régua, e não pela importação inteira: no caminho da MATRIZ a célula
 * é a turma sozinha e o telefone mora em coluna própria, então a armadilha nem
 * chega a ser oferecida — um teste só de ponta a ponta passava verde com a trava
 * removida. Aqui o trecho é o que os caminhos de TEXTO recebem de verdade.
 */
/**
 * O OCR do Drive achata a tabela, e o leitor por linha ACHA UM.
 *
 * Recorte fiel do que o `diagnosticarImportacao` capturou em 26/08 contra o
 * adm41.pdf: 3.084 caracteres em SETE linhas, com os 39 alunos colados por
 * espaço simples dentro de duas delas.
 *
 * O leitor por linha tira UM aluno por linha — o primeiro nome, e o último
 * telefone —, então de duas linhas cheias ele tirava 1 ficha, com o nome de um
 * aluno e o telefone de OUTRO. E 1 não é zero: a rede do texto achatado só
 * entrava quando o resultado era zero, e nunca foi acionada.
 */
grupo('o texto achatado do OCR — quando o leitor por linha acha UM em vez de zero');

function ocrAchatado() {
  return [
    'CENTRO UNIVERSITÁRIO CESUSC - UNICESUSC   ',
    'ADM 41 (MATRIZ NOVA) - 2026/2 Relação de Alunos Matriculados com Telefone ',
    'WORK EXPERIENCE (ADM 41 (MATRIZ NOVA)) Telefone Res. Telefone Cel. ' +
      'PATRICIA LOPES FIGUEIREDO (09342914) ADM 31 (MATRIZ NOVA) 48900010002 ' +
      'JULIANA BEATRIZ DOS REIS (09921426) ADM 41 (MATRIZ NOVA) 48900010003',
    'RICARDO ANTONIO PEREIRA DA COSTA (09921827) ADM 31 (MATRIZ NOVA) (48)90001-0014 ' +
      'ISADORA CAMPOS NOGUEIRA (09910910) ADM 41 (MATRIZ NOVA) 48900010011',
    '39 aluno(s) matriculado(s) na disciplina'
  ].join('\n');
}

teste('o despachante fica com quem leu MAIS alunos, e não com o primeiro que respondeu', () => {
  const { api } = ambiente();
  const texto = ocrAchatado();

  // As duas estratégias, lado a lado: é a diferença entre elas que o
  // despachante tem de enxergar.
  // UM. É o mesmo número que apareceu na tela do professor — "1 aluno(s) lido(s)
  // no formato do sistema acadêmico" — e é o que torna o defeito traiçoeiro:
  // não é zero, então a rede antiga não entrava. A linha do cabeçalho da
  // disciplina é descartada antes, e sobra uma linha de alunos que rende 1.
  igual(api.extrairAcademicoDeTexto_(texto).length, 1, 'o leitor por linha tira 1 por linha');
  igual(api.extrairAcademicoAchatado_(texto).length, 4, 'o achatado lê todos');

  const r = api.tentarFormatoAcademico_({ texto: texto, matriz: null });
  igual(r.matriz.length - 1, 4, 'o despachante ficou com o leitor errado');
});

teste('a ficha NÃO sai com o nome de um aluno e o telefone de outro', () => {
  const { api } = ambiente();
  const r = api.tentarFormatoAcademico_({ texto: ocrAchatado(), matriz: null });
  const primeiro = r.matriz.slice(1).find(function (l) { return /RICARDO/.test(l[0]); });

  // Era este o estrago: o leitor por linha pegava o primeiro nome da linha e o
  // ÚLTIMO telefone dela — o do último aluno da mesma linha, outra pessoa.
  igual(primeiro[1], '09921827');
  igual(primeiro[3], '48900010014', 'ficou com o telefone de outro aluno');
  igual(api.normalizarTurma(primeiro[2]), 'ADM31');
});

teste('EMPATE fica com o leitor por linha, e o NOME é a diferença', () => {
  const { api } = ambiente();
  // Uma linha por aluno. As duas estratégias acham os mesmos DOIS, mas não os
  // mesmos nomes: o achatado deduz onde o nome começa varrendo as maiúsculas
  // para trás (`caudaEmMaiusculas_`), e no PRIMEIRO aluno do texto ele engole a
  // palavra anterior — 'UNICESUSC THIAGO MENDES CARVALHO'. O leitor por linha
  // não precisa deduzir nada: a linha já começa no nome.
  //
  // É por isso que o empate fica com ele, e este teste é o que impede alguém de
  // trocar `>` por `>=` achando que dá no mesmo.
  const texto = [
    'CENTRO UNIVERSITÁRIO CESUSC - UNICESUSC',
    'THIAGO MENDES CARVALHO (09910738)   ADS11   48900010016',
    'RAFAEL GONÇALVES ANDRADE NUNES (09920880)   ADS11   21900010017'
  ].join('\n');

  igual(api.extrairAcademicoDeTexto_(texto).length, 2);
  igual(api.extrairAcademicoAchatado_(texto).length, 2, 'as duas têm de EMPATAR');
  igual(api.extrairAcademicoAchatado_(texto)[0][0], 'UNICESUSC THIAGO MENDES CARVALHO',
    'o achatado deixou de errar o nome — o empate perdeu o sentido');

  const r = api.tentarFormatoAcademico_({ texto: texto, matriz: null });
  igual(r.matriz.length - 1, 2);
  igual(r.matriz[1][0], 'THIAGO MENDES CARVALHO', 'o empate ficou com o leitor errado');
});

teste('o telefone FORMATADO é lido, e o CELULAR ganha do fixo', () => {
  const { api } = ambiente();

  // As duas escritas convivem no mesmo ads11.pdf. A antiga só via a corrida, e
  // 5 dos 26 alunos saíam sem telefone nenhum — calados.
  igual(api.extrairTelefones_('48900010005'), '48900010005', 'corrido');
  igual(api.extrairTelefones_('(48)90001-0013'), '48900010013', 'formatado');

  // A linha da Rafaela: fixo E celular, os dois formatados. Onze dígitos é
  // celular no Brasil, e é por ele que a coordenação fala com o aluno.
  igual(api.extrairTelefones_('(48)8000-1020   (48)90001-0012'), '48900010012',
    'ficou com o fixo');

  // E TAMBÉM quando a ordem inverte. No relatório de hoje "Telefone Res." vem
  // antes de "Telefone Cel.", então pegar o último já daria o celular — este
  // caso é o que torna o desempate por onze dígitos carregar peso, em vez de
  // ser enfeite que acerta por acidente da ordem das colunas.
  igual(api.extrairTelefones_('(48)90001-0012   (48)8000-1020'), '48900010012',
    'a ordem das colunas decidiu, e não o tipo do número');

  igual(api.extrairTelefones_('4890001010'), '4890001010', 'só fixo continua valendo');
  igual(api.extrairTelefones_(''), '');
  igual(api.extrairTelefones_('ADS11'), '', 'turma não é telefone');
});

teste('a linha de baixo entrega o CELULAR de quem só tinha o fixo', () => {
  const { api } = ambiente();
  const texto = [
    'CENTRO UNIVERSITÁRIO CESUSC - UNICESUSC',
    'NOEMI WEBER (09920158)                     ADM 41 (MATRIZ NOVA)     48900010001',
    'MARIANA APARECIDA DE ALMEIDA TEIXEIRA (09910446)  4890001008',
    '                                               ADM 61 (MATRIZ NOVA)     48900010007'
  ].join('\n');

  const linhas = api.extrairAcademicoDeTexto_(texto);
  igual(linhas[1][3], '48900010007', 'ficou com o fixo da linha de cima');
});

teste('a linha de baixo NÃO troca celular por fixo', () => {
  const { api } = ambiente();
  const texto = [
    'CENTRO UNIVERSITÁRIO CESUSC - UNICESUSC',
    'NOEMI WEBER (09920158)   ADM 41 (MATRIZ NOVA)   48900010001',
    'LETICIA BORGES (09812127)    48900010009',
    '                             ADM 31 (MATRIZ NOVA)   4890001015'
  ].join('\n');

  const linhas = api.extrairAcademicoDeTexto_(texto);
  igual(linhas[1][3], '48900010009', 'o fixo da linha de baixo atropelou o celular');
  igual(api.normalizarTurma(linhas[1][2]), 'ADM31', 'a turma ainda tinha de vir');
});

teste('aluno com telefone residencial tem a turma na LINHA DE BAIXO, e ela é lida', () => {
  const { api } = ambiente();
  // O recorte exato do adm41.pdf: quando há telefone residencial, o relatório
  // empurra turma e celular para a linha seguinte. Sem tratar isso, 6 dos 39
  // alunos entravam SEM TURMA — calados.
  const texto = [
    'CENTRO UNIVERSITÁRIO CESUSC - UNICESUSC',
    'NOEMI WEBER (09920158)                     ADM 41 (MATRIZ NOVA)     48900010001',
    'LETICIA BORGES DE OLIVEIRA (09812127)             4890001010',
    '                                               ADM 41 (MATRIZ NOVA)     48900010009',
    'MARIANA APARECIDA DE ALMEIDA TEIXEIRA (09910446)  4890001008',
    '                                               ADM 61 (MATRIZ NOVA)     48900010007'
  ].join('\n');

  const linhas = api.extrairAcademicoDeTexto_(texto);
  igual(linhas.length, 3, 'a linha de continuação não pode virar um aluno');
  igual(api.normalizarTurma(linhas[0][2]), 'ADM41');
  igual(api.normalizarTurma(linhas[1][2]), 'ADM41', 'a turma da linha de baixo não foi lida');
  // A Roberta é ADM 61, e não o ADM 41 do cabeçalho: por isso a turma sai da
  // linha de continuação, e não do título do relatório.
  igual(api.normalizarTurma(linhas[2][2]), 'ADM61', 'pegou a turma do cabeçalho, não a dela');
});

teste('a linha de continuação NÃO sobrescreve a turma de quem já tem', () => {
  const { api } = ambiente();
  const texto = [
    'CENTRO UNIVERSITÁRIO CESUSC - UNICESUSC',
    'NOEMI WEBER (09920158)   ADM 41 (MATRIZ NOVA)   48900010001',
    'LETICIA BORGES (09812127)    ADM 31 (MATRIZ NOVA)   4890001010',
    '                             ADM 99 (LIXO)          48900010009'
  ].join('\n');

  const linhas = api.extrairAcademicoDeTexto_(texto);
  igual(api.normalizarTurma(linhas[1][2]), 'ADM31', 'a continuação atropelou uma turma boa');
});

teste('a régua da turma: espaço, qualificador, e o DDD que NÃO pode entrar', () => {
  const { api } = ambiente();

  igual(api.turmaDoTexto('ADS21   48900010005'), 'ADS21');
  igual(api.turmaDoTexto('ADM 41   4890001010'), 'ADM 41', 'turma com espaço');
  igual(api.turmaDoTexto('ADM 41 (MATRIZ NOVA)   48900010001'), 'ADM 41 (MATRIZ NOVA)',
    'o qualificador de currículo tem de vir junto');

  // A linha real do ads11.pdf. `(48)` é a armadilha: sem exigir que o
  // qualificador comece com LETRA, a turma sairia 'ADS11 (48)'.
  igual(api.turmaDoTexto('ADS11   (48)90001-0013'), 'ADS11', 'o DDD entrou na turma');
  igual(api.turmaDoTexto('ADS11 (48)90001-0013'), 'ADS11', 'o DDD entrou na turma (colado)');

  igual(api.turmaDoTexto('   48900010005'), '', 'telefone sozinho não é turma');
  igual(api.turmaDoTexto(''), '');
  igual(api.turmaDoTexto(null), '');
});

teste('TELEFONE COM DDD ENTRE PARÊNTESES não vira parte da turma', () => {
  const { api, falso } = ambiente();
  // Estas duas linhas existem no ads11.pdf real: o mesmo relatório mistura os
  // dois formatos de telefone, e `(48)` é a armadilha óbvia do qualificador
  // entre parênteses — sem a trava de "tem de começar com letra", a turma sairia
  // `ADS11 (48)`. O telefone vem em coluna própria, como o relatório o entrega.
  const texto = [
    'Relação de Alunos Matriculados,Coluna',
    'x,GUSTAVO TELLES MORAES (09911506),ADS11,(48)90001-0013',
    'x,MATTEO FRANCESCO ALVES BARBIERI (09911495),ADS11,(48)90001-0019'
  ].join('\n') + '\n';

  const r = analisar(api, texto, 'ads.csv');
  const c = api.confirmarImportacao({
    token: TOKEN, tempId: r.tempId, arquivo: r.arquivo, tipo: r.tipo, mapeamento: r.mapeamento
  });
  igual(c.ok, true, c.erro);
  igual(documento(falso, 'matriculados', '9911506').turma, 'ADS11', 'o DDD entrou na turma');
});

teste('turma sem espaço continua lida como sempre foi', () => {
  const { api, falso } = ambiente();
  const texto = [
    'Relação de Alunos Matriculados,Coluna',
    'x,HELENA SOARES CARDOSO PINTO (09911439),ADS21,48900010005',
    'x,CLARA REGINA DUARTE MELO (09920360),ADS21,48900010006'
  ].join('\n') + '\n';

  const r = analisar(api, texto, 'ads.csv');
  const c = api.confirmarImportacao({
    token: TOKEN, tempId: r.tempId, arquivo: r.arquivo, tipo: r.tipo, mapeamento: r.mapeamento
  });
  igual(c.ok, true, c.erro);
  igual(documento(falso, 'matriculados', '9911439').turma, 'ADS21');
});

teste('o relatório do sistema acadêmico é reconhecido e separado', () => {
  const { api, falso } = ambiente();

  // O CSV desse relatório repete o cabeçalho em toda linha e traz nome e
  // matrícula no mesmo campo. 05b_FormatoAcademico.gs trata os dois.
  const texto = [
    'Relação de Alunos Matriculados,Coluna',
    'Relação de Alunos Matriculados,BEATRIZ EXEMPLO MARTINS (09110001)',
    'Relação de Alunos Matriculados,BRUNO EXEMPLO DA SILVA (09110002)',
    'Relação de Alunos Matriculados,CARLA EXEMPLO (09110003)'
  ].join('\n') + '\n';

  const r = analisar(api, texto, 'relatorio.csv');
  igual(r.ok, true, r.erro);
  verdadeiro(r.tipo.indexOf('formato acadêmico') !== -1, r.tipo);
  igual(r.cabecalhos, ['Nome completo', 'Matrícula', 'Turma', 'Telefone']);

  const c = api.confirmarImportacao({
    token: TOKEN, tempId: r.tempId, arquivo: r.arquivo, tipo: r.tipo, mapeamento: r.mapeamento
  });
  igual(c.ok, true, c.erro);
  igual(c.importadas, 3);
  verdadeiro(api.matriculaConhecida('09110002'), 'nome e matrícula foram separados');
  igual(documento(falso, 'matriculados', '9110002').nome, 'Bruno Exemplo da Silva');
});

teste('coluna fora do schema no mapeamento não contamina o documento', () => {
  const { api, falso } = ambiente();

  importar(api, CSV_TRES, { mapeamento: { nome: 0, matricula: 1, lote_id: 2, _id: 3 } });

  const doc = documento(falso, 'matriculados', '9110001');
  verdadeiro(doc.lote_id.indexOf('Z_') !== -1, 'lote_id é do sistema, não da planilha: ' + doc.lote_id);
  igual(chaves(falso, 'matriculados'), ['matriculados/9110001', 'matriculados/9110002',
    'matriculados/9110003'], 'o id continua sendo a matrícula');
});

teste('data e telefone entram normalizados', () => {
  const { api, falso } = ambiente();

  const r = importar(api, 'Nome;Matrícula;Data de nascimento;Telefone\n' +
    'MARIA DA SILVA;09110001;09/05/2002;(48) 99999-8888\n');

  igual(r.resultado.ok, true, r.resultado.erro);
  const doc = documento(falso, 'matriculados', '9110001');
  igual(doc.data_nascimento, '2002-05-09', 'data ordenável como texto');
  igual(doc.telefone, '48999998888');
});

teste('a linha original é guardada em raw_json', () => {
  const { api, falso } = ambiente();
  importar(api, csv(['BEATRIZ EXEMPLO MARTINS;09110001;Administração;ADM21']));

  igual(JSON.parse(documento(falso, 'matriculados', '9110001').raw_json),
    ['BEATRIZ EXEMPLO MARTINS', '09110001', 'Administração', 'ADM21']);
});

// ------------------------------------------------------------ Reconciliação

grupo('A importação NÃO reconcilia — são duas execuções');

// Estes três testes trocaram de lado em 06/08. Antes eles provavam que
// `confirmarImportacao` chamava `reconciliar()` e repassava os quatro números.
// Provar isso era provar o problema: as duas coisas dividiam UMA execução de 6
// minutos, ~23 idas ao Firestore numa só, e estourar deixava os matriculados
// gravados com a tela dizendo "Falha na importação" — do que o professor
// concluiria, corretamente para o que ele vê, que precisa reenviar o arquivo.
// Ver o cabeçalho de 05_Importacao.gs.

teste('confirmarImportacao não chama reconciliar(), nem quando ela existe', () => {
  const { api } = ambiente();
  let chamadas = 0;
  api.reconciliar = () => { chamadas++; return { confirmado: 3 }; };

  const r = importar(api, CSV_TRES).resultado;

  igual(r.ok, true, r.erro);
  igual(chamadas, 0, 'a reconciliação não pode dividir a execução com a importação');
});

teste('a resposta pede o passo seguinte em vez de fingir que já rodou', () => {
  const { api } = ambiente();
  const r = importar(api, CSV_TRES).resultado;

  igual(r.precisaReconciliar, true);
  igual(r.reconciliacao, undefined,
    'quatro zeros num cartão seriam indistinguíveis de "reconciliei e não achei ninguém"');
});

teste('a importação inteira cabe em requisições de escrita, sem uma leitura', () => {
  // O motivo de a separação valer a pena: sozinha, a importação é curta e
  // previsível. É o que se perde ao pendurar a reconciliação nela.
  const { api, falso } = ambiente();
  const antes = falso.requisicoes.length;
  importar(api, CSV_TRES);

  const feitas = falso.requisicoes.slice(antes);
  igual(feitas.filter(LEITURA).length, 0, 'a cota de leitura é do caminho público');
  verdadeiro(feitas.length <= 4,
    'a importação inteira em ' + feitas.length + ' requisições; passou disso, a conta do ' +
    'cabeçalho mudou e o risco de estourar os 6 minutos voltou');
});

// ------------------------------------------------------------ Expurgo

grupo('expurgarLote — a saída que faltava para matriculados diminuir');

// Até 06/08 `matriculados` só crescia: a gravação é upsert, `excluir` nunca era
// chamada nesta coleção, e não havia botão nem função para reduzi-la. Como
// `colecaoCompleta_` recusa acima de 8.000 documentos, o quarto semestre pararia
// a reconciliação — e a mensagem de recusa mandava "reduza a coleção" sem
// existir com o quê. Estes testes provam o caminho e, principalmente, provam que
// ele NÃO leva junto quem ainda está na lista.

/** O lote_id gravado — é o campo por onde o expurgo pega. */
function loteDe(falso, matricula) {
  return documento(falso, 'matriculados', matricula).lote_id;
}

teste('apaga os matriculados daquela importação, e só eles', () => {
  const { api, falso } = ambiente();
  const primeira = importar(api, CSV_TRES).resultado;

  igual(chaves(falso, 'matriculados').length, 3);

  const r = api.expurgarLote({ token: TOKEN, loteId: primeira.loteId });

  igual(r.ok, true, r.erro);
  igual(r.apagados, 3);
  igual(chaves(falso, 'matriculados'), [], 'a coleção tinha de esvaziar');
});

teste('quem voltou na lista NOVA não é tocado pelo expurgo da VELHA', () => {
  // É a propriedade que torna o expurgo por lote seguro, e ela não é escolha de
  // implementação: o upsert é endereçado pela matrícula, então reimportar
  // SOBRESCREVE o `lote_id` de quem voltou. Apagar o lote velho atinge, por
  // construção, exatamente quem não voltou.
  const { api, falso } = ambiente();

  const velho = importar(api, CSV_TRES).resultado;
  const novo = importar(api, csv([
    'BEATRIZ EXEMPLO MARTINS;09110001;Administração;ADM22',
    'DANIEL EXEMPLO;09110004;Marketing;MKT31'
  ])).resultado;

  igual(loteDe(falso, '9110001'), novo.loteId, 'quem voltou pertence ao lote novo');
  igual(loteDe(falso, '9110002'), velho.loteId, 'quem não voltou continua no velho');

  const r = api.expurgarLote({ token: TOKEN, loteId: velho.loteId });

  igual(r.apagados, 2, 'só BRUNO e CARLA, que não vieram na lista nova');
  igual(chaves(falso, 'matriculados').sort(),
    ['matriculados/9110001', 'matriculados/9110004'],
    'a lista oficial vigente continua inteira');
});

teste('contarApenas responde o número sem apagar e sem varrer', () => {
  // A tela pergunta isto ANTES de pedir confirmação: perguntar "tem certeza?"
  // sem o número seria pedir uma decisão às cegas sobre a lista oficial.
  const { api, falso } = ambiente();
  const lote = importar(api, CSV_TRES).resultado.loteId;

  const antes = falso.requisicoes.length;
  const r = api.expurgarLote({ token: TOKEN, loteId: lote, contarApenas: true });
  const feitas = falso.requisicoes.slice(antes);

  igual(r.ok, true);
  igual(r.total, 3);
  igual(r.apagados, 0);
  igual(chaves(falso, 'matriculados').length, 3, 'contar não pode apagar');
  igual(feitas.length, 1, 'uma agregação, nada além');
  verdadeiro(feitas[0].url.indexOf(':runAggregationQuery') !== -1);
});

teste('expurgo de lote já vazio não erra, e explica por quê', () => {
  const { api } = ambiente();
  const lote = importar(api, CSV_TRES).resultado.loteId;
  api.expurgarLote({ token: TOKEN, loteId: lote });

  const r = api.expurgarLote({ token: TOKEN, loteId: lote });
  igual(r.ok, true);
  igual(r.apagados, 0);
  verdadeiro(/mais nova/.test(r.mensagem),
    'a mensagem tem de cobrir o caso "todos voltaram numa lista nova": ' + r.mensagem);
});

teste('as inscrições NÃO são apagadas junto', () => {
  // O expurgo mexe na lista oficial, não no que o aluno enviou. Se levasse as
  // inscrições junto, a reconciliação seguinte apagaria alunos com decisão
  // humana registrada — trabalho que não se recupera.
  const { api, falso } = ambiente();
  const lote = importar(api, CSV_TRES).resultado.loteId;

  api.inserir('inscricoes', { matricula: '09110001', nome: 'BEATRIZ' }, 'insc1');
  api.expurgarLote({ token: TOKEN, loteId: lote });

  igual(chaves(falso, 'inscricoes'), ['inscricoes/insc1']);
});

teste('o lote vira EXPURGADO em vez de sumir, e o log registra', () => {
  const { api, falso } = ambiente();
  const lote = importar(api, CSV_TRES).resultado.loteId;

  api.expurgarLote({ token: TOKEN, loteId: lote });

  igual(documento(falso, 'lotes', lote).status, 'EXPURGADO',
    'a trilha de quem importou o quê não pode ser apagada pelo expurgo');
  verdadeiro(chaves(falso, 'log').some((k) => {
    const d = falso.documentos.get(k);
    return d.acao && d.acao.stringValue === 'LOTE_EXPURGADO';
  }), 'apagar em massa tem de deixar rastro');
});

teste('apaga em blocos de 500, e não uma requisição por documento', () => {
  // 2.500 exclusões uma a uma seriam 2.500 requisições — muito além dos 6
  // minutos de execução. É a razão de `excluirEmLote` existir.
  const { api, falso } = ambiente();
  const linhas = [];
  for (let i = 0; i < 1200; i++) {
    linhas.push('ALUNO NUMERO ' + i + ';' + (900000 + i) + ';Administração;ADM21');
  }
  const lote = importar(api, csv(linhas)).resultado.loteId;

  const antes = falso.requisicoes.length;
  const r = api.expurgarLote({ token: TOKEN, loteId: lote });
  const commits = falso.requisicoes.slice(antes).filter(COMMIT);

  igual(r.apagados, 1200);
  igual(commits.length, 3, '1200 em blocos de 500 = 3 commits');
  igual(chaves(falso, 'matriculados').length, 0);
});

teste('sem sessão de administrador, não apaga nada', () => {
  const { api, falso } = ambiente();
  const lote = importar(api, CSV_TRES).resultado.loteId;

  const r = api.expurgarLote({ token: 'token-inventado', loteId: lote });

  igual(r.ok, false);
  igual(chaves(falso, 'matriculados').length, 3);
});

teste('sem lote informado, recusa antes de custar leitura', () => {
  const { api, falso } = ambiente();
  const antes = falso.requisicoes.length;

  const r = api.expurgarLote({ token: TOKEN, loteId: '  ' });

  igual(r.ok, false);
  igual(falso.requisicoes.length, antes, 'recusa não pode custar consulta');
});

teste('a consulta do expurgo não pede índice composto nem __name__ DESCENDENTE', () => {
  const { api, falso } = ambiente();
  const lote = importar(api, CSV_TRES).resultado.loteId;

  const antes = falso.requisicoes.length;
  api.expurgarLote({ token: TOKEN, loteId: lote });

  falso.requisicoes.slice(antes).forEach((r) => {
    const q = r.corpo && (r.corpo.structuredQuery ||
      (r.corpo.structuredAggregationQuery && r.corpo.structuredAggregationQuery.structuredQuery));
    if (!q || !q.orderBy) return;

    q.orderBy.forEach((o) => {
      verdadeiro(!(o.field.fieldPath === '__name__' && o.direction === 'DESCENDING'),
        '__name__ DESCENDENTE devolve 400 "The query requires an index"');
      if (q.where) {
        igual(o.field.fieldPath, '__name__',
          'filtrar num campo e ordenar por OUTRO exige índice composto declarado à mão');
      }
    });
  });
});

// ------------------------------------------------------------ XLSX

/**
 * Monta um .xlsx mínimo, com os namespaces de verdade.
 *
 *   abas      nomes, em ordem de ABA (não de arquivo)
 *   alvos     o XML de cada aba, relativo a `xl/` — padrão worksheets/sheetN.xml
 *   textos    a tabela compartilhada: string, ou { runs: [...] } para texto
 *             partido em pedaços formatados
 *   linhas    matriz de células: { ref, t, s, v } ou { ref, inline }
 *   formatos  numFmts personalizados, { id: 'codigo' }
 *   estilos   cellXfs, na ordem: lista de numFmtId
 *   folha     XML da primeira aba escrito à mão, quando o teste precisa disso
 *   sem       partes a NÃO incluir ('sharedStrings', 'workbook', 'rels', 'styles')
 */
function montarXlsx(opcoes) {
  opcoes = opcoes || {};
  const abas = opcoes.abas || ['Plan1'];
  const alvos = opcoes.alvos || abas.map((_a, i) => 'worksheets/sheet' + (i + 1) + '.xml');
  const textos = opcoes.textos || [];
  const linhas = opcoes.linhas || [];
  const estilos = opcoes.estilos || [0];
  const formatos = opcoes.formatos || {};
  const sem = opcoes.sem || [];

  const escapar = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const declaracao = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  const celula = (c) => {
    if (c.inline !== undefined) {
      return '<c r="' + c.ref + '" t="inlineStr"><is><t>' + escapar(c.inline) + '</t></is></c>';
    }
    return '<c r="' + c.ref + '"' + (c.t ? ' t="' + c.t + '"' : '') +
      (c.s !== undefined ? ' s="' + c.s + '"' : '') + '><v>' + escapar(c.v) + '</v></c>';
  };

  const folha = opcoes.folha || (declaracao +
    '<worksheet xmlns="' + NS_PLANILHA + '"><sheetData>' +
    linhas.map((celulas, i) => '<row r="' + (i + 1) + '">' +
      celulas.map(celula).join('') + '</row>').join('') +
    '</sheetData></worksheet>');

  const entradas = [{ nome: 'xl/' + alvos[0], texto: folha }];

  // As abas de trás existem só para provar que a primeira é escolhida por
  // workbook.xml, e não por ordem de arquivo.
  alvos.slice(1).forEach((alvo) => {
    entradas.push({
      nome: 'xl/' + alvo,
      texto: declaracao + '<worksheet xmlns="' + NS_PLANILHA + '"><sheetData/></worksheet>'
    });
  });

  if (sem.indexOf('sharedStrings') === -1 && textos.length) {
    entradas.push({
      nome: 'xl/sharedStrings.xml',
      texto: declaracao + '<sst xmlns="' + NS_PLANILHA + '" count="' + textos.length + '">' +
        textos.map((t) => (typeof t === 'string'
          ? '<si><t>' + escapar(t) + '</t></si>'
          : '<si>' + t.runs.map((r) => '<r><rPr><b/></rPr><t>' + escapar(r) + '</t></r>').join('') + '</si>'
        )).join('') + '</sst>'
    });
  }

  if (sem.indexOf('workbook') === -1) {
    entradas.push({
      nome: 'xl/workbook.xml',
      texto: declaracao + '<workbook xmlns="' + NS_PLANILHA + '" xmlns:r="' + NS_RELS_DOC + '">' +
        '<sheets>' + abas.map((nome, i) =>
          '<sheet name="' + escapar(nome) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'
        ).join('') + '</sheets></workbook>'
    });
  }

  if (sem.indexOf('rels') === -1) {
    entradas.push({
      nome: 'xl/_rels/workbook.xml.rels',
      texto: declaracao + '<Relationships xmlns="' + NS_RELS_PKG + '">' +
        alvos.map((alvo, i) => '<Relationship Id="rId' + (i + 1) + '" Target="' + alvo +
          '" Type="' + NS_RELS_DOC + '/worksheet"/>').join('') + '</Relationships>'
    });
  }

  if (sem.indexOf('styles') === -1) {
    const personalizados = Object.keys(formatos);
    entradas.push({
      nome: 'xl/styles.xml',
      texto: declaracao + '<styleSheet xmlns="' + NS_PLANILHA + '">' +
        (personalizados.length
          ? '<numFmts count="' + personalizados.length + '">' + personalizados.map((id) =>
            '<numFmt numFmtId="' + id + '" formatCode="' + escapar(formatos[id]) + '"/>').join('') +
            '</numFmts>'
          : '') +
        '<cellXfs count="' + estilos.length + '">' +
        estilos.map((id) => '<xf numFmtId="' + id + '" xfId="0"/>').join('') +
        '</cellXfs></styleSheet>'
    });
  }

  return zipar(entradas);
}

const NS_PLANILHA = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_RELS_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_RELS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function analisarBinario(api, bytes, nome, mime) {
  return api.analisarArquivo({
    token: TOKEN,
    filename: nome,
    mimeType: mime || MIME_XLSX,
    dataBase64: Buffer.from(bytes).toString('base64')
  });
}

/** A matriz que o passo 1 leu: cabeçalhos mais as linhas da amostra. */
function lido(r) {
  return [r.cabecalhos].concat(r.amostra);
}

grupo('XLSX lido dos bytes — sem SpreadsheetApp e sem escopo de planilha');

// O QUE ESTE GRUPO NÃO PROVA, e não tem como: que o `Utilities.unzip` do Google
// aceite o blob de um .xlsx de verdade, e que os arquivos que ele devolve se
// chamem 'xl/sharedStrings.xml'. O zip daqui é montado por este arquivo e aberto
// por este arquivo — o que ele prova é o PARSER, que é onde mora a lógica que
// erra em silêncio. Cinco minutos com um .xlsx real na aba Importar fecham a
// outra metade.

teste('o .xlsx não passa mais pelo Drive: nada é convertido, nada é criado', () => {
  const { api, falso, drive } = ambiente();

  const r = analisarBinario(api, montarXlsx({
    textos: ['Nome completo', 'Matrícula', 'BEATRIZ EXEMPLO MARTINS'],
    linhas: [
      [{ ref: 'A1', t: 's', v: '0' }, { ref: 'B1', t: 's', v: '1' }],
      [{ ref: 'A2', t: 's', v: '2' }, { ref: 'B2', v: '9110001' }]
    ]
  }), 'lista.xlsx');

  igual(r.ok, true, r.erro);
  igual(r.tipo, 'XLSX');
  igual(falso.requisicoes.length, 0, 'o passo 1 continua sem tocar no banco');

  // Sobra a pasta de temporários e o JSON temporário. O que sumiu é o terceiro:
  // a cópia convertida em Google Sheets, que custava upload, conversão e
  // descarte a cada arquivo analisado.
  const tipos = Array.from(drive.arquivos.values()).map((f) => f.mimeType).sort();
  igual(tipos, ['application/vnd.google-apps.folder', 'text/plain']);
});

teste('célula t="s" vira o texto da tabela compartilhada', () => {
  const { api } = ambiente();

  const r = analisarBinario(api, montarXlsx({
    textos: ['Nome completo', 'Matrícula', 'Curso', 'BEATRIZ EXEMPLO MARTINS', 'Administração'],
    linhas: [
      [{ ref: 'A1', t: 's', v: '0' }, { ref: 'B1', t: 's', v: '1' }, { ref: 'C1', t: 's', v: '2' }],
      [{ ref: 'A2', t: 's', v: '3' }, { ref: 'B2', v: '9110001' }, { ref: 'C2', t: 's', v: '4' }]
    ]
  }), 'lista.xlsx');

  igual(lido(r), [
    ['Nome completo', 'Matrícula', 'Curso'],
    ['BEATRIZ EXEMPLO MARTINS', '9110001', 'Administração']
  ]);
});

// O teste que este grupo existe para ter. O .xlsx OMITE a célula vazia: a linha
// da Carla tem A, B e D, e traz três <c>. Empilhá-los na ordem em que aparecem
// jogaria a turma dela para a coluna do CURSO — a planilha inteira sairia
// deslocada a partir da primeira célula em branco, sem erro nenhum, e o
// professor confirmaria a importação com os dados trocados de coluna.
teste('célula vazia no meio da linha não desloca as de depois', () => {
  const { api } = ambiente();

  const r = analisarBinario(api, montarXlsx({
    textos: ['Nome', 'Matrícula', 'Curso', 'Turma', 'CARLA EXEMPLO', 'PMM31', 'BRUNO EXEMPLO',
      'Marketing', 'MKT31'],
    linhas: [
      [{ ref: 'A1', t: 's', v: '0' }, { ref: 'B1', t: 's', v: '1' },
        { ref: 'C1', t: 's', v: '2' }, { ref: 'D1', t: 's', v: '3' }],
      // Sem curso: o <c> de C2 simplesmente não existe no arquivo.
      [{ ref: 'A2', t: 's', v: '4' }, { ref: 'B2', v: '9110003' }, { ref: 'D2', t: 's', v: '5' }],
      [{ ref: 'A3', t: 's', v: '6' }, { ref: 'B3', v: '9110002' },
        { ref: 'C3', t: 's', v: '7' }, { ref: 'D3', t: 's', v: '8' }]
    ]
  }), 'lista.xlsx');

  igual(lido(r), [
    ['Nome', 'Matrícula', 'Curso', 'Turma'],
    ['CARLA EXEMPLO', '9110003', '', 'PMM31'],
    ['BRUNO EXEMPLO', '9110002', 'Marketing', 'MKT31']
  ]);
});

teste('linha que começa fora da coluna A é alinhada pela referência', () => {
  const { api } = ambiente();

  const r = analisarBinario(api, montarXlsx({
    textos: ['Nome', 'Matrícula', 'CARLA EXEMPLO'],
    linhas: [
      [{ ref: 'A1', t: 's', v: '0' }, { ref: 'B1', t: 's', v: '1' }],
      [{ ref: 'B2', v: '9110003' }]
    ]
  }), 'lista.xlsx');

  igual(lido(r), [['Nome', 'Matrícula'], ['', '9110003']]);
});

teste('coluna depois de Z é contada certo (AA = 27ª)', () => {
  const { api } = ambiente();

  const r = analisarBinario(api, montarXlsx({
    textos: ['Nome', 'Longe', 'CARLA EXEMPLO', 'aqui'],
    linhas: [
      [{ ref: 'A1', t: 's', v: '0' }, { ref: 'AA1', t: 's', v: '1' }],
      [{ ref: 'A2', t: 's', v: '2' }, { ref: 'AA2', t: 's', v: '3' }]
    ]
  }), 'lista.xlsx');

  igual(r.ok, true, r.erro);
  igual(r.cabecalhos.length, 27);
  igual(r.cabecalhos[0], 'Nome');
  igual(r.cabecalhos[26], 'Longe');
  igual(r.amostra[0][26], 'aqui');
});

teste('nome partido em pedaços formatados volta inteiro', () => {
  const { api } = ambiente();

  // Uma palavra em negrito no meio do nome parte o texto em vários <r> dentro do
  // mesmo <si>. Ler só o primeiro truncaria o nome do aluno.
  const r = analisarBinario(api, montarXlsx({
    textos: ['Nome', { runs: ['BEATRIZ ', 'EXEMPLO ', 'MARTINS'] }],
    linhas: [[{ ref: 'A1', t: 's', v: '0' }], [{ ref: 'A2', t: 's', v: '1' }]]
  }), 'lista.xlsx');

  igual(lido(r), [['Nome'], ['BEATRIZ EXEMPLO MARTINS']]);
});

teste('texto guardado dentro da célula (inlineStr) também é lido', () => {
  const { api } = ambiente();

  const r = analisarBinario(api, montarXlsx({
    sem: ['sharedStrings'],
    linhas: [
      [{ ref: 'A1', inline: 'Nome' }, { ref: 'B1', inline: 'Matrícula' }],
      [{ ref: 'A2', inline: 'CARLA EXEMPLO' }, { ref: 'B2', inline: '09110003' }]
    ]
  }), 'lista.xlsx');

  igual(lido(r), [['Nome', 'Matrícula'], ['CARLA EXEMPLO', '09110003']]);
});

teste('data com formato de data vira aaaa-mm-dd, e número continua número', () => {
  const { api } = ambiente();

  // 37385 é 09/05/2002. O estilo 1 aponta para o formato embutido 14 (data
  // curta); o estilo 0 é geral. Sem olhar o estilo, a data de nascimento
  // chegaria à tela como "37385" e `normalizarData` devolveria vazio.
  const r = analisarBinario(api, montarXlsx({
    textos: ['Nascimento', 'Matrícula'],
    estilos: [0, 14],
    linhas: [
      [{ ref: 'A1', t: 's', v: '0' }, { ref: 'B1', t: 's', v: '1' }],
      [{ ref: 'A2', s: 1, v: '37385' }, { ref: 'B2', s: 0, v: '9110001' }]
    ]
  }), 'lista.xlsx');

  igual(lido(r), [['Nascimento', 'Matrícula'], ['2002-05-09', '9110001']]);
});

teste('hora pura sai como hora, e não como uma data de 1899', () => {
  const { api } = ambiente();

  const r = analisarBinario(api, montarXlsx({
    textos: ['Horário'],
    estilos: [0, 21],
    linhas: [[{ ref: 'A1', t: 's', v: '0' }], [{ ref: 'A2', s: 1, v: '0.875' }]]
  }), 'lista.xlsx');

  igual(lido(r), [['Horário'], ['21:00:00']]);
});

teste('formato personalizado com palavra entre aspas não vira data', () => {
  const { api } = ambiente();

  // '#,##0 "meses"' tem "m" e "s" na PALAVRA, não no formato. Sem limpar os
  // literais, a matrícula 9110001 sairia como uma data de 9042.
  const r = analisarBinario(api, montarXlsx({
    textos: ['Matrícula', 'Nascimento'],
    formatos: { 164: '#,##0 "meses"', 165: 'dd/mm/yyyy' },
    estilos: [0, 164, 165],
    linhas: [
      [{ ref: 'A1', t: 's', v: '0' }, { ref: 'B1', t: 's', v: '1' }],
      [{ ref: 'A2', s: 1, v: '9110001' }, { ref: 'B2', s: 2, v: '37385' }]
    ]
  }), 'lista.xlsx');

  igual(lido(r), [['Matrícula', 'Nascimento'], ['9110001', '2002-05-09']]);
});

teste('a primeira aba é a do workbook, e não o primeiro arquivo do zip', () => {
  const { api } = ambiente();

  // A aba 1 mora em 'worksheets/sheet7.xml'. Um leitor que fosse direto em
  // sheet1.xml leria a aba ERRADA — e importar a planilha errada não parece
  // defeito, parece arquivo errado.
  const r = analisarBinario(api, montarXlsx({
    abas: ['Matriculados', 'Rascunho'],
    alvos: ['worksheets/sheet7.xml', 'worksheets/sheet1.xml'],
    textos: ['Nome', 'CARLA EXEMPLO'],
    linhas: [[{ ref: 'A1', t: 's', v: '0' }], [{ ref: 'A2', t: 's', v: '1' }]]
  }), 'lista.xlsx');

  igual(lido(r), [['Nome'], ['CARLA EXEMPLO']]);
  verdadeiro(r.aviso.indexOf('"Matriculados"') !== -1, r.aviso);
});

teste('mais de uma aba avisa qual foi lida', () => {
  const { api } = ambiente();

  const r = analisarBinario(api, montarXlsx({
    abas: ['Matriculados', 'Trancados', 'Formandos'],
    textos: ['Nome', 'CARLA EXEMPLO'],
    linhas: [[{ ref: 'A1', t: 's', v: '0' }], [{ ref: 'A2', t: 's', v: '1' }]]
  }), 'lista.xlsx');

  verdadeiro(r.aviso.indexOf('3 abas') !== -1, r.aviso);
  verdadeiro(r.aviso.indexOf('Matriculados') !== -1, r.aviso);
});

teste('XML com prefixo de namespace é lido igual', () => {
  const { api } = ambiente();

  // A armadilha do XmlService: `getChild('row')` sem passar o Namespace devolve
  // null em documento com namespace, e a leitura por nome local atravessa os
  // dois casos. Arquivo que passou por outra ferramenta chega assim.
  const r = analisarBinario(api, montarXlsx({
    sem: ['sharedStrings'],
    folha: '<?xml version="1.0"?><x:worksheet xmlns:x="' + NS_PLANILHA + '"><x:sheetData>' +
      '<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Nome</x:t></x:is></x:c></x:row>' +
      '<x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>CARLA EXEMPLO</x:t></x:is></x:c></x:row>' +
      '</x:sheetData></x:worksheet>'
  }), 'lista.xlsx');

  igual(lido(r), [['Nome'], ['CARLA EXEMPLO']]);
});

teste('sem workbook.xml legível, cai na primeira planilha do zip em vez de recusar', () => {
  const { api } = ambiente();

  const r = analisarBinario(api, montarXlsx({
    sem: ['workbook', 'rels'],
    textos: ['Nome', 'CARLA EXEMPLO'],
    linhas: [[{ ref: 'A1', t: 's', v: '0' }], [{ ref: 'A2', t: 's', v: '1' }]]
  }), 'lista.xlsx');

  igual(lido(r), [['Nome'], ['CARLA EXEMPLO']]);
  igual(r.aviso, '', 'uma aba só: nada a avisar');
});

teste('arquivo que não é um pacote de XML é recusado falando do .xls antigo', () => {
  const { api } = ambiente();

  const r = analisarBinario(api, Buffer.from('isto não é um zip', 'utf8'), 'lista.xls');

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('.xls antigo') !== -1, r.erro);
  verdadeiro(r.erro.indexOf('CSV') !== -1, 'a saída tem de estar na mensagem: ' + r.erro);
});

teste('o blob é declarado como zip antes de desempacotar', () => {
  const { api } = ambiente();

  // O Apps Script recusa `Utilities.unzip` num blob que chega com o tipo do
  // upload. O falso reproduz essa recusa; sem a linha do setContentType, este
  // teste (e a importação de verdade) quebram.
  const fonte = fs.readFileSync(path.join(PASTA_GS, '05_Importacao.gs'), 'utf8');
  verdadeiro(/Utilities\.unzip\(blob\.setContentType\('application\/zip'\)\)/.test(fonte), fonte
    .split('\n').filter((l) => l.indexOf('unzip') !== -1).join('\n'));

  const r = analisarBinario(api, montarXlsx({
    sem: ['sharedStrings'],
    linhas: [[{ ref: 'A1', inline: 'Nome' }], [{ ref: 'A2', inline: 'CARLA' }]]
  }), 'lista.xlsx', 'application/octet-stream');
  igual(r.ok, true, r.erro);
});

teste('de ponta a ponta: o xlsx importado é o que matriculaConhecida encontra', () => {
  const { api, falso } = ambiente();

  const analise = analisarBinario(api, montarXlsx({
    textos: ['Nome completo', 'Matrícula', 'BEATRIZ EXEMPLO MARTINS', 'CARLA EXEMPLO'],
    linhas: [
      [{ ref: 'A1', t: 's', v: '0' }, { ref: 'B1', t: 's', v: '1' }],
      [{ ref: 'A2', t: 's', v: '2' }, { ref: 'B2', inline: '091.100-01' }],
      [{ ref: 'A3', t: 's', v: '3' }, { ref: 'B3', inline: '09110003' }]
    ]
  }), 'matriculados.xlsx');

  igual(analise.ok, true, analise.erro);

  const r = api.confirmarImportacao({
    token: TOKEN, tempId: analise.tempId, arquivo: analise.arquivo,
    tipo: analise.tipo, mapeamento: analise.mapeamento
  });

  igual(r.ok, true, r.erro);
  igual(r.importadas, 2);
  verdadeiro(api.matriculaConhecida('09110001'), 'matrícula com pontuação na planilha');
  verdadeiro(api.matriculaConhecida('09110003'));
  igual(documento(falso, 'matriculados', '9110001').nome, 'Beatriz Exemplo Martins');
});

// ------------------------------------------------------------ PDF

grupo('PDF — OCR do Drive, texto pelo export, sem DocumentApp');

teste('o texto do OCR chega pelo export, e o Documento é descartado depois', () => {
  const { api, drive } = ambiente();

  drive.definirOcr('Nome\tMatrícula\nCARLA EXEMPLO\t09110003\nBRUNO EXEMPLO\t09110002\n');

  const r = analisarBinario(api, Buffer.from('%PDF-1.4 finge', 'utf8'), 'lista.pdf',
    'application/pdf');

  igual(r.ok, true, r.erro);
  igual(r.tipo, 'PDF');
  igual(lido(r), [
    ['Nome', 'Matrícula'],
    ['CARLA EXEMPLO', '09110003'],
    ['BRUNO EXEMPLO', '09110002']
  ]);

  const documentos = Array.from(drive.arquivos.values())
    .filter((f) => f.mimeType === MIME_DOC);
  igual(documentos.length, 1, 'um Documento de OCR');
  igual(documentos[0].trashed, true,
    'o OCR guarda a lista de alunos inteira; não pode ficar parado no Drive');
});

teste('a exportação é a rota /export, e não alt=media', () => {
  const { api, drive } = ambiente();

  drive.definirOcr('Nome\nCARLA EXEMPLO\n');
  analisarBinario(api, Buffer.from('%PDF', 'utf8'), 'lista.pdf', 'application/pdf');

  const doDocumento = drive.fetches.filter((f) => f.url.indexOf('/export?') !== -1);
  igual(doDocumento.length, 1, drive.fetches.map((f) => f.url).join(' | '));
  verdadeiro(doDocumento[0].url.indexOf('mimeType=text%2Fplain') !== -1, doDocumento[0].url);
  // `alt=media` num Documento nativo é 403 no Drive de verdade ("only files with
  // binary content can be downloaded"), e o falso responde igual.
  verdadeiro(doDocumento[0].url.indexOf('alt=media') === -1);
});

teste('export que falha não deixa o Documento do OCR para trás', () => {
  const { api, drive } = ambiente();

  // O falso recusa mimeType diferente de text/plain; aqui a falha vem de fora,
  // trocando o token por um que o Drive não aceita.
  const roteador = api.UrlFetchApp;
  api.UrlFetchApp = {
    fetch(url, opcoes) {
      if (url.indexOf('/export?') !== -1) {
        return { getResponseCode: () => 500, getContentText: () => '{"error":{"code":500}}' };
      }
      return roteador.fetch(url, opcoes);
    }
  };

  const r = analisarBinario(api, Buffer.from('%PDF', 'utf8'), 'lista.pdf', 'application/pdf');

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('500') !== -1, r.erro);

  const documentos = Array.from(drive.arquivos.values()).filter((f) => f.mimeType === MIME_DOC);
  igual(documentos[0].trashed, true, 'o descarte é no finally, e vale também quando dá errado');
});

// ------------------------------------------------------------ Temporário

grupo('O temporário é lido por HTTP, e não pelo serviço avançado');

teste('o passo 2 relê o temporário com alt=media e o token do script', () => {
  const { api, drive } = ambiente();

  importar(api, CSV_TRES);

  const leituras = drive.fetches.filter((f) => f.url.indexOf('alt=media') !== -1);
  igual(leituras.length, 1, drive.fetches.map((f) => f.url).join(' | '));
  igual(leituras[0].opcoes.headers.Authorization, 'Bearer token-de-mentira');
  verdadeiro(leituras[0].opcoes.muteHttpExceptions,
    'sem isso o cliente não consegue ler o corpo do erro do Drive');
});

teste('token negado pelo Drive vira "a pré-visualização expirou", e não erro cru', () => {
  const { api } = ambiente();

  const analise = analisar(api, CSV_TRES);
  const roteador = api.UrlFetchApp;
  api.UrlFetchApp = {
    fetch(url, opcoes) {
      if (url.indexOf('alt=media') !== -1) {
        return { getResponseCode: () => 403, getContentText: () => '{"error":{"code":403}}' };
      }
      return roteador.fetch(url, opcoes);
    }
  };

  const r = api.confirmarImportacao({
    token: TOKEN, tempId: analise.tempId, mapeamento: analise.mapeamento
  });

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('expirou') !== -1, r.erro);
});

grupo('PDF achatado — o relatório em que o OCR devolve tudo numa linha');

// AMOSTRA SINTÉTICA, do cabeçalho ao rodapé: instituição, endereço, telefone,
// CEP, nomes e matrículas são todos INVENTADOS. O que este bloco reproduz é a
// ESTRUTURA do relatório — cinco linhas de miolo institucional antes da tabela,
// a tabela achatada num parágrafo só, e um rodapé de contagem. Nenhum aluno e
// nenhum endereço real aparecem aqui, e é assim que tem de continuar, porque
// este repositório é público.
//
// O caso que ele guarda: quando o OCR do Drive achata a tabela inteira num
// parágrafo, o leitor por linha (extrairAcademicoDeTexto_) devolve ZERO aluno
// num arquivo cheio deles, e a tela diz "Nenhuma linha utilizável".
const PDF_ACHATADO = [
  'CENTRO UNIVERSITÁRIO EXEMPLO - UNIEXEMPLO',
  'Rua das Amostras, 100 - Bairro Ficticio - Fone: 48 3333-0000',
  '88000-000 - Cidade Exemplo - Santa Catarina -',
  'PMM21 - 2026/2 Relação de Alunos Matriculados com Telefone',
  'PROJETO INTERDISCIPLINAR I EM MULTIMÍDIA (PMM21) Telefone Res. Telefone Cel. ' +
    'BEATRIZ EXEMPLO MARTINS (09110001) PMM21 48999990001 ' +
    'CARLOS EXEMPLO ANDRADE (09110800) PMM21 48999990002 ' +
    'DANIELA EXEMPLO NOGUEIRA (09110900) PMM41 48999990003',
  '3 aluno(s) matriculado(s) na disciplina'
].join('\n');

teste('o leitor por linha nao acha nada — e e por isso que o achatado existe', () => {
  const { api } = ambiente();
  igual(api.extrairAcademicoDeTexto_(PDF_ACHATADO).length, 0);
});

teste('o achatado le os tres alunos, com nome, matricula, turma e telefone', () => {
  const { api } = ambiente();
  igual(api.extrairAcademicoAchatado_(PDF_ACHATADO), [
    ['BEATRIZ EXEMPLO MARTINS', '09110001', 'PMM21', '48999990001'],
    ['CARLOS EXEMPLO ANDRADE', '09110800', 'PMM21', '48999990002'],
    ['DANIELA EXEMPLO NOGUEIRA', '09110900', 'PMM41', '48999990003']
  ]);
});

teste('o cabecalho do relatorio nao vira nome — "Cel." interrompe a leitura', () => {
  const { api } = ambiente();
  const primeiro = api.extrairAcademicoAchatado_(PDF_ACHATADO)[0];
  verdadeiro(primeiro[0].indexOf('Telefone') === -1, 'nome contaminado: ' + primeiro[0]);
  verdadeiro(primeiro[0].indexOf('Cel') === -1, 'nome contaminado: ' + primeiro[0]);
});

teste('a turma da LINHA ganha da turma do titulo', () => {
  const { api } = ambiente();
  // DANIELA cursa PMM41 dentro de uma turma PMM21 — aluno de outra fase junto.
  igual(api.extrairAcademicoAchatado_(PDF_ACHATADO)[2][2], 'PMM41');
});

teste('tentarFormatoAcademico_ cai no achatado sozinho', () => {
  const { api } = ambiente();
  const r = api.tentarFormatoAcademico_({ texto: PDF_ACHATADO });

  verdadeiro(r, 'devolveu null — o relatorio nao foi reconhecido');
  igual(r.matriz[0], ['Nome completo', 'Matrícula', 'Turma', 'Telefone']);
  igual(r.matriz.length, 4, 'cabecalho + 3 alunos');
});

teste('texto sem aluno nenhum continua devolvendo null', () => {
  const { api } = ambiente();
  igual(api.tentarFormatoAcademico_({ texto: 'Relatório vazio\nsem ninguém aqui' }), null);
});

grupo('zero à esquerda — formatação, não identidade');

// O caso apareceu no primeiro teste com uma lista oficial: o relatório traz a
// matrícula com o zero (aqui, sintética: `09110700`), o aluno digita `9110700`
// porque é assim que o número aparece para ele, e recebia "Matrícula não
// encontrada" — o formato do relatório é o que importa. Com 500 alunos
// no auditório seria uma fila de gente convencida de que o sistema errou — e
// eles estariam certos.

teste('as duas formas normalizam para a mesma chave', () => {
  const { api } = ambiente();
  igual(api.normalizarMatricula('09110700'), '9110700');
  igual(api.normalizarMatricula('9110700'), '9110700');
  igual(api.normalizarMatricula('0009110700'), '9110700');
});

teste('matrícula com letra NÃO perde o zero — ali ele pode significar algo', () => {
  const { api } = ambiente();
  igual(api.normalizarMatricula('A0123'), 'A0123');
  igual(api.normalizarMatricula('0A123'), '0A123');
});

teste('matrícula toda de zeros sobra um dígito, e não vira vazio', () => {
  const { api } = ambiente();
  // '' é o valor de "não informou"; devolver isso faria o sistema tratar a
  // matrícula como ausente em vez de inválida.
  igual(api.normalizarMatricula('000'), '0');
});

teste('quem foi importado com zero é encontrado por quem digita sem', () => {
  const { api } = ambiente();
  importar(api, csv(['BEATRIZ EXEMPLO MARTINS;09110700;Multimídia;PMM21']));

  verdadeiro(api.matriculaConhecida('9110700'), 'digitou sem o zero');
  verdadeiro(api.matriculaConhecida('09110700'), 'digitou com o zero');
  verdadeiro(api.matriculaConhecida('091.107-00'), 'digitou com pontuação');
  verdadeiro(!api.matriculaConhecida('9110701'), 'matrícula que não existe continua recusada');
});

teste('a forma OFICIAL fica guardada para o painel exibir', () => {
  const { api, falso } = ambiente();
  importar(api, csv(['BEATRIZ EXEMPLO MARTINS;09110700;Multimídia;PMM21']));

  const doc = documento(falso, 'matriculados', '9110700');
  igual(doc.matricula, '9110700', 'a chave');
  igual(doc.matricula_oficial, '09110700', 'o que a secretaria emitiu');
});

teste('a chave de dedup é a mesma com e sem o zero', () => {
  const { api } = ambiente();
  // Sem isto, quem se inscreveu com o zero conseguiria se inscrever de novo sem
  // ele — duas vagas para a mesma pessoa, com o banco achando que está certo.
  igual(
    api.chaveDedup_({ projeto_id: 'p1', matricula: '09110700' }),
    api.chaveDedup_({ projeto_id: 'p1', matricula: '9110700' })
  );
});

// ---------------------------------------------------------------- Resultado

process.exit(resultado());
