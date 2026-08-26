/**
 * 02b_Drive.gs — acesso ao Drive pelo serviço AVANÇADO (API v3).
 *
 * Por que não usar DriveApp, que seria mais simples:
 *
 * O DriveApp é o serviço "fácil" do Apps Script, mas a plataforma marca seus
 * métodos como exigindo o escopo AMPLO `/auth/drive` — mesmo quando a operação
 * em si é inofensiva, como criar uma pasta nova. Com o escopo restrito deste
 * projeto (`drive.file`, que alcança só o que o próprio script cria), qualquer
 * DriveApp.createFolder / createFile falha com "permissões não são suficientes".
 *
 * O serviço avançado não tem essa amarração: ele respeita o escopo de verdade.
 * Com `drive.file` dá para criar, listar, compartilhar e apagar os arquivos do
 * próprio app — e nada mais. É exatamente o comportamento desejado: o sistema
 * nunca enxerga os arquivos pessoais de quem instala.
 *
 * Preço: chamadas mais verbosas. Elas ficam todas aqui, e o resto do código
 * continua lendo bem.
 *
 * Uma exceção, e ela tem motivo: BAIXAR CONTEÚDO (`driveLerTexto_`,
 * `driveExportarTexto_`) não passa pelo serviço avançado, porque ele não sabe
 * carregar mídia. Essas duas vão por HTTP, com o mesmo escopo. Está explicado em
 * `driveBaixarTexto_`.
 */

var MIME_PASTA = 'application/vnd.google-apps.folder';

/**
 * Pasta criada uma vez e lembrada pelo ID.
 * Buscar por nome varreria o Drive inteiro e exigiria escopo amplo — daí
 * guardar o ID nas propriedades do script.
 */
function drivePasta_(chaveProp, nome) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(chaveProp);

  if (id) {
    try {
      var atual = Drive.Files.get(id, { fields: 'id,trashed', supportsAllDrives: true });
      if (atual && !atual.trashed) return atual.id;
    } catch (e) {
      // Apagada de vez ou fora de alcance: cai adiante e recria.
    }
  }

  var nova = Drive.Files.create(
    { name: nome, mimeType: MIME_PASTA },
    null,
    { fields: 'id', supportsAllDrives: true }
  );
  props.setProperty(chaveProp, nova.id);
  return nova.id;
}

/** Cria um arquivo dentro da pasta e devolve { id, name }. */
function driveCriarArquivo_(pastaId, blob, nome) {
  return Drive.Files.create(
    { name: nome || blob.getName(), parents: [pastaId] },
    blob,
    { fields: 'id,name', supportsAllDrives: true }
  );
}

/**
 * Lista o conteúdo de uma pasta, PAGINANDO até o teto.
 * Com `drive.file`, esta consulta só enxerga o que o próprio app criou — que é
 * justamente o conjunto que interessa.
 *
 * Antes ela pedia uma página de 200 e devolvia o que viesse. O modo de falha era
 * o pior tipo: o banner de número 201 sumia da galeria sem erro nenhum, e quem
 * olhasse a tela concluiria que o arquivo não existe mais. Agora ela dá a volta
 * pelo `nextPageToken` e, quando o teto realmente aparece, isso é DITO — o
 * chamador recebe `truncado` em vez de uma lista curta que se passa por completa.
 *
 * Teto de 1.000: uma pasta de banners com mais que isso é sintoma de outra coisa,
 * e varrer o Drive inteiro numa chamada de painel não é o que se quer.
 */
var DRIVE_LISTAR_TETO = 1000;
var DRIVE_LISTAR_PAGINA = 200;

function driveListar_(pastaId) {
  var arquivos = [];
  var pageToken = null;

  do {
    var resposta = Drive.Files.list({
      q: "'" + pastaId + "' in parents and trashed = false",
      fields: 'nextPageToken,files(id,name,size,createdTime,mimeType)',
      orderBy: 'createdTime desc',
      pageSize: DRIVE_LISTAR_PAGINA,
      pageToken: pageToken || undefined,
      supportsAllDrives: true
    });

    arquivos = arquivos.concat((resposta && resposta.files) ? resposta.files : []);
    pageToken = (resposta && resposta.nextPageToken) || null;
  } while (pageToken && arquivos.length < DRIVE_LISTAR_TETO);

  arquivos.truncado = Boolean(pageToken);
  return arquivos;
}

/** Libera leitura pública — sem isso o navegador do aluno recebe 403 na imagem. */
function driveTornarPublico_(id) {
  Drive.Permissions.create(
    { role: 'reader', type: 'anyone' },
    id,
    { supportsAllDrives: true }
  );
}

/**
 * Endereço da API do Drive. As duas leituras de CONTEÚDO abaixo não passam pelo
 * serviço avançado; ver o comentário de `driveBaixarTexto_`.
 */
var DRIVE_API = 'https://www.googleapis.com/drive/v3/files/';

/**
 * Baixa o CONTEÚDO de um arquivo, por HTTP, com o token do próprio script.
 *
 * Por que não pelo serviço avançado, que é o padrão do resto deste arquivo: o
 * serviço avançado do Apps Script sabe falar metadados (create, get, list,
 * update, permissions) e NÃO sabe baixar mídia. `Drive.Files.get(id, {alt:
 * 'media'})` é o caso conhecido — a chamada volta 200 e mesmo assim é entregue
 * como erro —, e `Drive.Files.export(id, 'text/plain')` é o mesmo problema com
 * outro nome: a assinatura gerada para a v3 devolve `void`, então não existe
 * texto para pegar. Os dois são caminho de metadado tentando carregar bytes.
 *
 * O que sobra é o que o resto deste sistema já faz o dia inteiro com o Firestore
 * (02_Repo.gs): um GET com `Authorization: Bearer`. Os dois escopos que isso
 * exige — `drive.file` e `script.external_request` — já estão declarados, e
 * `drive.file` alcança exatamente os arquivos que este app criou, que são os
 * únicos que ele lê. Nada de escopo novo.
 *
 * O token sai de `fsToken_()` (02_Repo.gs) de propósito: pedir
 * `ScriptApp.getOAuthToken()` por CHAMADA custava ~15s cada no web app anônimo, e
 * essa medição é o motivo daquele cache existir. O nome dele diz Firestore, mas o
 * token é do script inteiro — é o mesmo para o Drive.
 *
 * Aqui havia um `catch` que caía para `DriveApp.getFileById`. Era uma reserva que
 * NUNCA poderia socorrer ninguém: pelo motivo explicado no topo deste arquivo, o
 * DriveApp exige o escopo amplo `/auth/drive`, que o manifesto não declara — a
 * reserva falharia por autorização exatamente nas vezes em que fosse chamada, e
 * trocaria o erro verdadeiro do Drive por "permissões não são suficientes", que
 * manda quem for depurar procurar no lugar errado. Sem reserva, o erro que sobe é
 * o que aconteceu de fato.
 */
function driveBaixarTexto_(url, oQue) {
  var resposta = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + fsToken_() },
    muteHttpExceptions: true
  });

  var codigo = resposta.getResponseCode();
  var texto = resposta.getContentText();
  if (codigo >= 200 && codigo < 300) return texto;

  // O corpo do erro do Drive é JSON e pode ser longo; o que interessa (código e
  // `message`) vem no começo.
  throw new Error(oQue + ': o Drive respondeu HTTP ' + codigo + ' — ' +
    String(texto).slice(0, 300));
}

/** Baixa o conteúdo de um arquivo comum (o JSON temporário da importação). */
function driveLerTexto_(id) {
  return driveBaixarTexto_(
    DRIVE_API + encodeURIComponent(id) + '?alt=media',
    'Não consegui ler o arquivo temporário'
  );
}

/**
 * Exporta um arquivo NATIVO do Google (Documento, Planilha) como texto puro.
 *
 * É o que substituiu `DocumentApp.openById(...).getBody().getText()` na
 * importação por PDF. O `DocumentApp` exige `/auth/documents` — TODOS os
 * documentos de quem instala — para ler UM arquivo que o próprio app acabou de
 * criar com o OCR. O endpoint de export faz a mesma leitura aceitando
 * `drive.file`, que é o escopo que já temos e que só enxerga o que criamos.
 */
function driveExportarTexto_(id) {
  return driveBaixarTexto_(
    DRIVE_API + encodeURIComponent(id) + '/export?mimeType=' + encodeURIComponent('text/plain'),
    'Não consegui exportar o texto do OCR'
  );
}

function driveDescartar_(id) {
  Drive.Files.update({ trashed: true }, id, null, { supportsAllDrives: true });
}
