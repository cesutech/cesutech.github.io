/**
 * banners.js — testa 11_Banners.gs e o CONTRATO entre o Admin.html e o servidor.
 *
 * São dois assuntos no mesmo arquivo porque o segundo nasceu do primeiro: os
 * banners são a fase mais curta desta rodada, e a folga foi gasta na varredura
 * que faltava.
 *
 * ------------------------------------------------------------- Parte 1: Drive
 *
 * O que se prova, em ordem de importância:
 *
 *   1. o ORÇAMENTO: `listarBanners` e `enviarBanner` não fazem uma única
 *      requisição ao Firestore além do log, e `removerBanner` faz exatamente
 *      duas consultas, ambas filtradas e com teto — medido contando as
 *      requisições, não lendo o código;
 *   2. a conferência de "banner em uso" encontra as DUAS formas que o campo
 *      `banner` pode guardar (URL pública e id cru), porque perder uma delas
 *      apaga a imagem de um projeto que está no ar;
 *   3. nenhuma das consultas pede ordenação por campo junto com filtro (índice
 *      composto) nem `__name__` DESCENDENTE — as duas armadilhas já pagas;
 *   4. a guarda: as três funções recusam sem token ANTES de tocar em Drive ou
 *      banco;
 *   5. o arquivo enviado nasce público. Sem isso o navegador do aluno recebe 403
 *      na imagem, e o sintoma aparece no site, não no painel.
 *
 * -------------------------------------------------------- Parte 2: o contrato
 *
 * A revisão anterior encontrou 16 funções chamadas pelo painel que não existiam
 * em `.gs` nenhum. Elas passaram porque todo detector varria só os `.gs` — o
 * HTML era ponto cego. `chamadasDoAdmin()` varre o HTML e prova que cada nome
 * chamado existe no servidor.
 *
 * Ele lê a forma de chamada que o painel usa: o envelope `chamar('nome',
 * payload, ...)`. Eram DUAS até 07/08 — a outra era a cadeia crua
 * `google.script.run...`, das funções de login —, e ela sumiu junto com a
 * mudança do painel para o GitHub Pages: lá aquela API não existe.
 *
 * Pular os argumentos exige mais do que contar parênteses (eles aparecem dentro
 * de textos, de comentários e de expressões regulares), daí o pequeno analisador
 * léxico. Quando ele não consegue fechar a chamada, LANÇA em vez de devolver
 * menos nomes: um detector que erra calado é exatamente o que criou o problema
 * que este teste existe para impedir.
 *
 * ONDE ESTES TESTES NÃO ALCANÇAM, e nenhum deles prova o contrário:
 *
 *   - O Drive falso daqui é de mentira. Que `Drive.Files.create` com um blob
 *     binário e escopo `drive.file` grave a imagem, que `Permissions.create`
 *     com `type: 'anyone'` a torne visível para quem não tem conta, e que a URL
 *     `drive.google.com/thumbnail?id=...&sz=w1600` sirva a imagem para um
 *     <img> anônimo — as três coisas só o Google prova. Nenhum teste daqui
 *     depende disso, e nenhum deles pode ser citado como se provasse.
 *   - Que o Firestore de verdade aceite `banner == X` ordenado por `__name__`
 *     ASC sem índice composto declarado é leitura da documentação, não medição
 *     nossa. É a mesma família da armadilha do `__name__ DESCENDING`, que só
 *     apareceu contra o banco real.
 *   - O falso NÃO cobra leitura mínima por consulta vazia. O custo de 2 leituras
 *     do `removerBanner` sem projeto casado é conta em cima da documentação do
 *     Firestore; o que este arquivo mede é o número de CONSULTAS.
 *
 * Uso:  node testes/banners.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  teste, grupo, igual, verdadeiro, resultado, criarAmbiente
} = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');

// Na ordem alfabética em que o editor do Apps Script carrega os arquivos.
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '02b_Drive.gs',
  '03_Config.gs', '04_Log.gs', '07_Auth.gs', '09_Projetos.gs', '11_Banners.gs'];

// O painel mudou de casa em 07/08: era `apps-script/Admin.html` e agora é
// `docs/painel/index.html`, servido pelo GitHub Pages. O contrato que este
// arquivo confere — o que a tela manda e o que 11_Banners.gs lê — é o mesmo.
const ADMIN = fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'painel', 'index.html'), 'utf8');
const FONTE = fs.readFileSync(path.join(PASTA_GS, '11_Banners.gs'), 'utf8');

// ------------------------------------------------------------ Drive falso

/**
 * Drive em memória com o que os banners precisam e o de `testes/importacao.js`
 * não tem: `size` na listagem, `createdTime` sob controle do teste, conteúdo
 * BINÁRIO e registro das permissões concedidas.
 *
 * Está aqui, e não em `apoio.js`, porque `apoio.js` é o falso do Firestore —
 * subir um Drive para lá obrigaria os outros seis arquivos de teste a carregar
 * um serviço que não usam. O de `importacao.js` não foi reaproveitado porque
 * aquele arquivo não o exporta e porque ele guarda texto, não bytes.
 */
function criarDriveFalso() {
  const arquivos = new Map();
  const permissoes = [];
  const chamadas = [];
  let proximo = 1;

  return {
    arquivos,
    permissoes,
    chamadas,

    Drive: {
      Files: {
        create(recurso, blob, params) {
          chamadas.push({ metodo: 'create', recurso, params });
          const id = 'drv' + (proximo++);
          arquivos.set(id, {
            id,
            name: (recurso && recurso.name) || (blob && blob.getName()) || '',
            mimeType: (recurso && recurso.mimeType) || (blob && blob.getContentType()) || '',
            parents: (recurso && recurso.parents) || [],
            bytes: blob ? blob.getBytes() : [],
            trashed: false,
            createdTime: '2026-08-05T23:40:00.000Z'
          });
          return { id, name: arquivos.get(id).name };
        },

        get(id, params) {
          chamadas.push({ metodo: 'get', id, params });
          const f = arquivos.get(id);
          if (!f) throw new Error('File not found: ' + id);
          return { id: f.id, trashed: f.trashed };
        },

        update(recurso, id, media, params) {
          chamadas.push({ metodo: 'update', id, recurso, params });
          const f = arquivos.get(id);
          if (!f) throw new Error('File not found: ' + id);
          if (recurso && recurso.trashed !== undefined) f.trashed = recurso.trashed;
          return { id };
        },

        list(params) {
          chamadas.push({ metodo: 'list', params });
          const pai = /'([^']+)' in parents/.exec(params.q);
          const files = [];
          arquivos.forEach((f) => {
            if (f.trashed) return;
            if (pai && f.parents.indexOf(pai[1]) === -1) return;
            const item = {
              id: f.id, name: f.name, createdTime: f.createdTime, mimeType: f.mimeType
            };
            // O Drive devolve `size` em texto, e OMITE o campo nos formatos
            // nativos do Google. `size: null` no arquivo é como se pede isso.
            if (f.size !== null) item.size = String(f.size !== undefined ? f.size : f.bytes.length);
            files.push(item);
          });

          // PAGINAÇÃO, que o falso não tinha e por isso não provava nada.
          //
          // O Drive corta a resposta em `pageSize` e devolve `nextPageToken`
          // quando sobrou. `driveListar_` (02b_Drive.gs) pedia uma página de 200
          // e devolvia o que viesse: o arquivo de número 201 sumia da galeria sem
          // erro nenhum, e quem não o achasse concluiria que foi apagado. Sem
          // este pedaço, o teste da correção não teria como falhar.
          const tamanho = Number(params.pageSize) || files.length;
          const inicio = params.pageToken ? Number(params.pageToken) : 0;
          const pagina = files.slice(inicio, inicio + tamanho);
          const fim = inicio + tamanho;

          return fim < files.length
            ? { files: pagina, nextPageToken: String(fim) }
            : { files: pagina };
        }
      },

      Permissions: {
        create(recurso, id, params) {
          chamadas.push({ metodo: 'permissao', id, recurso, params });
          permissoes.push({ id, role: recurso.role, type: recurso.type });
          return {};
        }
      }
    }
  };
}

// ------------------------------------------------------------ Ambiente

function ambiente(opcoes) {
  const amb = criarAmbiente(Object.assign(
    { arquivos: GS, usuario: 'coordenacao@exemplo.com' }, opcoes || {}
  ));

  const drive = criarDriveFalso();
  amb.drive = drive;
  amb.api.Drive = drive.Drive;

  // O `Utilities` de apoio.js já traz formatDate, getUuid e computeDigest.
  // Aqui entram só os dois que os banners acrescentam.
  amb.api.Utilities.base64Decode = (b64) => {
    amb.decodificacoes++;
    return Array.from(Buffer.from(String(b64), 'base64'));
  };
  amb.api.Utilities.newBlob = (bytes, mime, nome) => ({
    getBytes: () => bytes,
    getName: () => nome || '',
    getContentType: () => mime || ''
  });

  amb.decodificacoes = 0;
  amb.token = amb.api.criarSessao_('coordenacao@exemplo.com');
  amb.zerar = () => {
    amb.falso.requisicoes.length = 0;
    amb.drive.chamadas.length = 0;
    amb.decodificacoes = 0;
  };
  return amb;
}

function chamar(amb, funcao, payload) {
  return amb.api[funcao](Object.assign({ token: amb.token }, payload || {}));
}

function consultas(falso) {
  return falso.requisicoes.filter((r) => r.url.indexOf(':runQuery') !== -1);
}

function escritas(falso) {
  // `:runQuery` e `:commit` também são POST — o que separa a escrita da pergunta
  // é o documento no caminho, não o verbo.
  return falso.requisicoes.filter(
    (r) => (r.metodo === 'POST' || r.metodo === 'PATCH') && r.url.indexOf('/documents:') === -1
  );
}

/** Último registro de log com esta ação. */
function log(api, acao) {
  const achado = api.ultimosRegistros(20).filter((r) => r.acao === acao)[0];
  if (!achado) throw new Error('o log não recebeu ' + acao);
  return achado;
}

/** Base64 de uma imagem de mentira, com o tamanho pedido em bytes. */
function imagemFalsa(bytes) {
  return Buffer.alloc(bytes, 0x42).toString('base64');
}

/** Sobe um banner e devolve a resposta. */
function enviar(amb, nome, tipo, bytes) {
  return chamar(amb, 'enviarBanner', {
    filename: nome,
    mimeType: tipo,
    dataBase64: imagemFalsa(bytes === undefined ? 1024 : bytes)
  });
}

function criarProjeto(api, id, banner) {
  api.inserir('projetos', {
    codigo: id, nome: 'Projeto ' + id, banner: banner || '',
    vagas: '60', ativo: 'true', inscricoes_abertas: 'true'
  }, id);
}

// ------------------------------------------------------------ Guarda

grupo('a guarda vem antes de qualquer efeito');

teste('as três funções recusam sem token e não tocam em Drive nem no banco', () => {
  const amb = ambiente();
  amb.zerar();

  ['listarBanners', 'enviarBanner', 'removerBanner'].forEach((funcao) => {
    const r = amb.api[funcao]({ id: 'drv1', filename: 'a.jpg', mimeType: 'image/jpeg' });
    igual(r.ok, false, funcao + ' deixou passar sem token');
    verdadeiro(/Sess.o expirada|inv.lida/.test(r.erro),
      funcao + ': a mensagem precisa casar com o teste do Admin.html, que derruba a sessão por ela');
  });

  igual(amb.drive.chamadas.length, 0, 'a recusa não pode custar uma ida ao Drive');
  igual(amb.falso.requisicoes.length, 0, 'nem uma ao Firestore');
});

teste('token de outra sessão não vale', () => {
  const amb = ambiente();
  igual(chamar(amb, 'listarBanners').ok, true);
  amb.api.sair(amb.token);
  igual(amb.api.listarBanners({ token: amb.token }).ok, false, 'o logout não derrubou o token');
});

// ------------------------------------------------------------ listarBanners

grupo('listarBanners — a galeria do Drive');

teste('pasta vazia devolve lista vazia, e não erro', () => {
  const amb = ambiente();
  // `aviso` entrou em 06/08 com a paginação de `driveListar_`: vazio quando a
  // lista veio inteira, preenchido quando o teto cortou. Ver o teste da
  // paginação, mais abaixo.
  igual(chamar(amb, 'listarBanners'), { ok: true, itens: [], aviso: '' });
});

teste('não custa uma leitura sequer no Firestore', () => {
  const amb = ambiente();
  enviar(amb, 'a.jpg', 'image/jpeg');
  amb.zerar();

  chamar(amb, 'listarBanners');
  igual(amb.falso.requisicoes.length, 0, 'a lista de banners mora no Drive; o banco não sabe dela');
});

teste('cada item traz id, nome, URL pública, tamanho e data', () => {
  const amb = ambiente();
  enviar(amb, 'Cidades Inteligentes.jpg', 'image/jpeg', 2048);

  const item = chamar(amb, 'listarBanners').itens[0];
  igual(item.nome, 'cidades-inteligentes.jpg');
  igual(item.url, 'https://drive.google.com/thumbnail?id=' + item.id + '&sz=w1600');
  igual(item.tamanhoKb, 2);
  igual(item.enviadoEm, '2026-08-05 20:40',
    'createdTime vem em UTC; a legenda do painel é para gente que está em São Paulo');
});

teste('arquivo sem `size` não vira NaN na legenda', () => {
  const amb = ambiente();
  enviar(amb, 'a.jpg', 'image/jpeg');
  // É o que o Drive faz com os formatos nativos do Google: omite o campo.
  amb.drive.arquivos.forEach((f) => { f.size = null; });

  igual(chamar(amb, 'listarBanners').itens[0].tamanhoKb, 0);
});

teste('a ordem é pedida ao Drive, e não refeita aqui', () => {
  const amb = ambiente();
  enviar(amb, 'a.jpg', 'image/jpeg');
  amb.zerar();
  chamar(amb, 'listarBanners');

  const lista = amb.drive.chamadas.filter((c) => c.metodo === 'list')[0];
  igual(lista.params.orderBy, 'createdTime desc', 'o mais novo primeiro é decisão do Drive');
  verdadeiro(lista.params.q.indexOf('trashed = false') !== -1, 'banner na lixeira não é banner');
  verdadeiro(lista.params.fields.indexOf('size') !== -1,
    'sem pedir `size` no fields, a API v3 não devolve o campo e toda legenda vira 0 KB');
  verdadeiro(lista.params.fields.indexOf('nextPageToken') !== -1,
    'sem pedir nextPageToken no fields, a API v3 não devolve o campo e a paginação vira teatro');
});

// --------------------------------------------- driveListar_ pagina de verdade

grupo('driveListar_ — a galeria não pode perder banner em silêncio');

/** Enche a pasta de banners direto no Drive falso, sem passar pelo upload. */
function encherPasta(amb, quantos) {
  const pasta = amb.api.pastaBanners_();
  for (let i = 1; i <= quantos; i++) {
    amb.drive.Drive.Files.create(
      { name: 'banner' + String(i).padStart(4, '0') + '.jpg', parents: [pasta] },
      { getBytes: () => [1, 2, 3], getName: () => '', getContentType: () => 'image/jpeg' },
      {}
    );
  }
}

teste('mais de 200 banners: a lista vem inteira, em várias páginas', () => {
  // O teto de uma página é 200. Com 450 arquivos, a versão antiga devolvia 200 e
  // dizia, pelo silêncio, que era isso que existia.
  const amb = ambiente();
  encherPasta(amb, 450);
  amb.drive.chamadas.length = 0;

  const r = chamar(amb, 'listarBanners');

  igual(r.ok, true, r.erro);
  igual(r.itens.length, 450, 'sumiram ' + (450 - r.itens.length) + ' banners sem erro nenhum');
  igual(r.aviso, '', 'coube inteira: não há o que avisar');
  igual(amb.drive.chamadas.filter((c) => c.metodo === 'list').length, 3,
    '450 em páginas de 200 = 3 idas ao Drive');
});

teste('a segunda página é pedida com o token que a primeira devolveu', () => {
  const amb = ambiente();
  encherPasta(amb, 250);
  amb.drive.chamadas.length = 0;
  chamar(amb, 'listarBanners');

  const listas = amb.drive.chamadas.filter((c) => c.metodo === 'list');
  igual(listas[0].params.pageToken, undefined, 'a primeira página não tem de onde continuar');
  igual(listas[1].params.pageToken, '200', 'sem repassar o token, o laço releria a página 1 para sempre');
});

teste('acima do teto duro, a lista sai curta mas DIZ que saiu curta', () => {
  // 1.000 é o teto de `driveListar_`. Passar disso não pode virar galeria curta
  // silenciosa — que é o modo de falha exato que este conserto tirou do sistema.
  const amb = ambiente();
  encherPasta(amb, 1100);

  const r = chamar(amb, 'listarBanners');

  igual(r.itens.length, 1000, 'o teto duro é 1.000');
  verdadeiro(r.aviso.indexOf('1000') !== -1, 'o aviso precisa dizer quantos couberam: ' + r.aviso);
  verdadeiro(r.aviso.indexOf('Drive') !== -1, 'e o que fazer a respeito: ' + r.aviso);
});

// ------------------------------------------------------------ enviarBanner

grupo('enviarBanner — o que entra na pasta');

teste('formato fora dos três aceitos é recusado antes de decodificar', () => {
  const amb = ambiente();
  amb.zerar();

  const r = enviar(amb, 'lista.pdf', 'application/pdf');
  igual(r, { ok: false, erro: 'Formato não aceito. Envie JPG, PNG ou WebP.' });
  igual(amb.decodificacoes, 0);
  igual(amb.drive.chamadas.length, 0, 'nem a pasta chegou a ser procurada');
});

teste('os três formatos do <input accept> do painel passam', () => {
  const amb = ambiente();
  ['image/jpeg', 'image/png', 'image/webp'].forEach((tipo) => {
    igual(enviar(amb, 'a.jpg', tipo).ok, true, tipo + ' foi recusado');
    verdadeiro(ADMIN.indexOf(tipo) !== -1, 'o painel nem oferece ' + tipo);
  });
});

teste('arquivo vazio devolve recado, e não estouro dentro do base64Decode', () => {
  const amb = ambiente();
  const r = chamar(amb, 'enviarBanner', { filename: 'a.jpg', mimeType: 'image/jpeg', dataBase64: '' });
  igual(r, { ok: false, erro: 'O arquivo chegou vazio. Tente enviar de novo.' });
  igual(amb.decodificacoes, 0);
});

teste('acima de 3 MB é recusado, com o tamanho na recusa', () => {
  const amb = ambiente();
  const r = enviar(amb, 'pesada.jpg', 'image/jpeg', 4 * 1024 * 1024);

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('Imagem maior que 3 MB') === 0, r.erro);
  verdadeiro(r.erro.indexOf('4096 KB') !== -1,
    'sem o tamanho, quem enviou não sabe o quanto precisa reduzir: ' + r.erro);
  igual(amb.drive.chamadas.filter((c) => c.metodo === 'create').length, 0);
});

teste('payload absurdo é medido pelo TEXTO, sem passar por base64Decode', () => {
  const amb = ambiente();
  amb.zerar();

  const r = chamar(amb, 'enviarBanner', {
    filename: 'enorme.jpg',
    mimeType: 'image/jpeg',
    dataBase64: 'A'.repeat(40 * 1024 * 1024)
  });

  igual(r.ok, false);
  verdadeiro(r.erro.indexOf('Imagem maior que 3 MB') === 0, r.erro);
  igual(amb.decodificacoes, 0,
    'decodificar 40 MB para só depois medir é como se mata a execução sem mensagem');
});

teste('o limite é 3 MB exatos: 3 MB entra, 3 MB e um byte não', () => {
  const amb = ambiente();
  igual(enviar(amb, 'no-limite.jpg', 'image/jpeg', 3 * 1024 * 1024).ok, true);
  igual(enviar(amb, 'um-a-mais.jpg', 'image/jpeg', 3 * 1024 * 1024 + 1).ok, false);
});

teste('o envio grava, torna público e devolve a URL que o <img> aceita', () => {
  const amb = ambiente();
  const r = enviar(amb, 'Ação Cidadã.JPG', 'image/jpeg', 1536);

  igual(r.ok, true);
  igual(r.nome, 'acao-cidada.jpg');
  igual(r.tamanhoKb, 2);
  igual(r.url, 'https://drive.google.com/thumbnail?id=' + r.id + '&sz=w1600');

  igual(amb.drive.permissoes, [{ id: r.id, role: 'reader', type: 'anyone' }],
    'sem permissão pública o aluno recebe 403 na imagem, e o erro aparece no site');

  const arquivo = amb.drive.arquivos.get(r.id);
  igual(arquivo.name, 'acao-cidada.jpg');
  igual(arquivo.bytes.length, 1536, 'os bytes decodificados é que vão para o Drive');
});

teste('o arquivo nasce dentro da pasta de banners, e não na raiz do Drive', () => {
  const amb = ambiente();
  const r = enviar(amb, 'a.jpg', 'image/jpeg');
  const arquivo = amb.drive.arquivos.get(r.id);

  igual(arquivo.parents.length, 1);
  igual(amb.propriedades.get('PASTA_BANNERS_ID'), arquivo.parents[0],
    'a pasta é lembrada pelo id nas propriedades; procurá-la pelo nome exigiria escopo amplo');
});

teste('a pasta é criada uma vez só, por mais envios que venham', () => {
  const amb = ambiente();
  enviar(amb, 'a.jpg', 'image/jpeg');
  const criadas = () => amb.drive.chamadas
    .filter((c) => c.metodo === 'create' && c.recurso.mimeType === 'application/vnd.google-apps.folder')
    .length;

  igual(criadas(), 1);
  enviar(amb, 'b.jpg', 'image/jpeg');
  chamar(amb, 'listarBanners');
  igual(criadas(), 1);
});

teste('nome de arquivo vira previsível: sem acento, sem espaço, sem surpresa', () => {
  const amb = ambiente();
  const casos = [
    ['Educação & Saúde.PNG', 'educacao-saude.png'],
    ['sem-extensao', 'sem-extensao.jpg'],
    ['....jpg', 'banner.jpg'],
    ['   espaços   nas   pontas .jpeg', 'espacos-nas-pontas.jpeg']
  ];
  casos.forEach((c) => {
    igual(enviar(amb, c[0], 'image/png').nome, c[1], c[0]);
  });
});

teste('nome comprido é cortado antes de virar arquivo', () => {
  const amb = ambiente();
  const r = enviar(amb, 'a'.repeat(300) + '.jpg', 'image/jpeg');
  igual(r.nome.length, 54, 'até 50 do nome, mais ".jpg"');
});

teste('o envio vai para o log com o tamanho, e o log é a única escrita no banco', () => {
  const amb = ambiente();
  amb.zerar();
  const r = enviar(amb, 'a.jpg', 'image/jpeg', 4096);

  igual(consultas(amb.falso).length, 0, 'enviar um banner não faz pergunta ao banco');
  igual(escritas(amb.falso).length, 1, 'só o log');

  const registro = log(amb.api, 'BANNER_ENVIADO');
  igual(registro.entidade, 'banner');
  igual(registro.entidade_id, r.id);
  igual(registro.detalhe, 'a.jpg · 4 KB');
});

// ------------------------------------------------------------ removerBanner

grupo('removerBanner — a conferência que impede imagem quebrada no site');

teste('banner usado pela URL não é removido', () => {
  const amb = ambiente();
  const r = enviar(amb, 'cidades.jpg', 'image/jpeg');
  criarProjeto(amb.api, 'p1', r.url);

  const resposta = chamar(amb, 'removerBanner', { id: r.id });
  igual(resposta.ok, false);
  verdadeiro(resposta.erro.indexOf('Projeto p1') !== -1, resposta.erro);
  igual(amb.drive.arquivos.get(r.id).trashed, false, 'o arquivo continua lá');
});

teste('banner usado pelo id cru também não é removido', () => {
  // O painel grava a URL, mas o campo aceita o id, e é o que alguém digita
  // mexendo no projeto pelo editor. Uma consulta só deixaria esta forma passar.
  const amb = ambiente();
  const r = enviar(amb, 'cidades.jpg', 'image/jpeg');
  criarProjeto(amb.api, 'p2', r.id);

  const resposta = chamar(amb, 'removerBanner', { id: r.id });
  igual(resposta.ok, false);
  verdadeiro(resposta.erro.indexOf('Projeto p2') !== -1, resposta.erro);
});

teste('o mesmo projeto não aparece duas vezes na lista de impedimentos', () => {
  const amb = ambiente();
  const r = enviar(amb, 'cidades.jpg', 'image/jpeg');
  criarProjeto(amb.api, 'p1', r.url);
  criarProjeto(amb.api, 'p2', r.id);

  const erro = chamar(amb, 'removerBanner', { id: r.id }).erro;
  igual(erro.split('Projeto p1').length - 1, 1, 'p1 casou nas duas consultas e foi listado duas vezes');
  verdadeiro(erro.indexOf('Projeto p2') !== -1, erro);
});

teste('banner de ninguém vai para a lixeira e entra no log', () => {
  const amb = ambiente();
  const r = enviar(amb, 'orfao.jpg', 'image/jpeg');
  criarProjeto(amb.api, 'p1', 'outro-banner.jpg');

  igual(chamar(amb, 'removerBanner', { id: r.id }), { ok: true });
  igual(amb.drive.arquivos.get(r.id).trashed, true);
  igual(log(amb.api, 'BANNER_REMOVIDO').entidade_id, r.id);
});

teste('a remoção custa DUAS consultas filtradas, e nenhuma leitura de coleção', () => {
  const amb = ambiente();
  const r = enviar(amb, 'orfao.jpg', 'image/jpeg');
  for (let i = 1; i <= 30; i++) criarProjeto(amb.api, 'p' + i, 'banner-' + i + '.jpg');
  amb.zerar();

  chamar(amb, 'removerBanner', { id: r.id });

  const feitas = consultas(amb.falso);
  igual(feitas.length, 2, 'uma por forma do campo `banner` — `listar` aceita um fieldFilter só');
  feitas.forEach((c) => {
    const q = c.corpo.structuredQuery;
    igual(q.from[0].collectionId, 'projetos');
    igual(q.where.fieldFilter.field.fieldPath, 'banner', 'sem filtro isto viraria varredura');
    igual(q.limit, 20, 'sem teto, um valor de banner repetido em tudo vira leitura da coleção');
  });
});

teste('nenhuma consulta pede índice composto nem __name__ DESCENDENTE', () => {
  const amb = ambiente();
  const r = enviar(amb, 'orfao.jpg', 'image/jpeg');
  amb.zerar();
  chamar(amb, 'removerBanner', { id: r.id });

  consultas(amb.falso).forEach((c) => {
    const q = c.corpo.structuredQuery;
    const ordem = q.orderBy[0];
    igual(ordem.field.fieldPath, '__name__',
      'filtrar por `banner` e ordenar por outro campo exige índice composto declarado');
    igual(ordem.direction, 'ASCENDING',
      '`__name__ DESCENDING` devolve 400 "The query requires an index" (04_Log.gs já pagou essa)');
  });
});

teste('id em branco é recusado sem custar nada', () => {
  const amb = ambiente();
  amb.zerar();

  igual(chamar(amb, 'removerBanner', { id: '  ' }),
    { ok: false, erro: 'Informe qual banner remover.' });
  igual(amb.falso.requisicoes.length, 0);
  igual(amb.drive.chamadas.length, 0);
});

teste('a lista de impedimentos avisa quando sai cortada', () => {
  const amb = ambiente();
  const r = enviar(amb, 'todos.jpg', 'image/jpeg');
  for (let i = 1; i <= 25; i++) criarProjeto(amb.api, 'p' + String(i).padStart(2, '0'), r.url);

  const erro = chamar(amb, 'removerBanner', { id: r.id }).erro;
  verdadeiro(erro.indexOf('a conferência para em 20') !== -1,
    'sem o aviso, "está em uso por 20 projetos" parece a lista inteira: ' + erro);
});

// ------------------------------------------------------------ Contratos

grupo('contratos que não podem divergir em silêncio');

teste('a coleção de projetos é a de 09_Projetos.gs, e não uma cópia', () => {
  const amb = ambiente();
  igual(amb.api.PROJETOS_COLECAO, 'projetos');
  igual(FONTE.indexOf("PROJETOS_COLECAO = "), -1,
    'uma segunda declaração venceria em silêncio e a remoção passaria a apagar banner em uso');
});

teste('este arquivo não invade a fase de ninguém', () => {
  ['rodarReconciliacao', 'sincronizarForms', 'analisarArquivo', 'confirmarImportacao',
    'painelEstatisticas', 'listarAlunos', 'exportarCsv'].forEach((alheia) => {
    igual(FONTE.indexOf('function ' + alheia), -1, alheia + ' é de outro arquivo desta rodada');
  });
});

teste('nada aqui usa DriveApp', () => {
  igual(FONTE.indexOf('DriveApp'), -1,
    'todo método do DriveApp exige o escopo amplo /auth/drive; o projeto declara drive.file');
  const manifesto = JSON.parse(fs.readFileSync(path.join(PASTA_GS, 'appsscript.json'), 'utf8'));
  verdadeiro((manifesto.oauthScopes || []).some((e) => /drive\.file$/.test(e)),
    'o manifesto precisa continuar pedindo drive.file — sem ele o upload não grava');
});

teste('o payload que o Admin.html manda é o que enviarBanner lê', () => {
  ['filename', 'mimeType', 'dataBase64'].forEach((campo) => {
    verdadeiro(ADMIN.indexOf(campo + ':') !== -1, 'o painel não manda ' + campo);
    verdadeiro(FONTE.indexOf('payload.' + campo) !== -1, 'o servidor não lê ' + campo);
  });
});

teste('o que listarBanners devolve é o que a galeria do painel desenha', () => {
  const amb = ambiente();
  enviar(amb, 'a.jpg', 'image/jpeg');
  const item = chamar(amb, 'listarBanners').itens[0];

  // Admin.html:757 monta o cartão com b.nome, b.url, b.tamanhoKb, b.enviadoEm e
  // b.id. Campo que faltar vira "undefined" escrito na legenda, sem erro nenhum.
  ['id', 'nome', 'url', 'tamanhoKb', 'enviadoEm'].forEach((campo) => {
    verdadeiro(item[campo] !== undefined, 'falta ' + campo);
    verdadeiro(ADMIN.indexOf('b.' + campo) !== -1, 'o painel não usa ' + campo);
  });
});

// ------------------------------------------------------------ Admin.html × .gs

grupo('o Admin.html chama, e o servidor responde');

/**
 * Pula uma lista de argumentos a partir do '(' em `i`, devolvendo o índice logo
 * depois do ')' que a fecha.
 *
 * Conhece aspas, comentários de linha e de bloco e literais de expressão
 * regular — sem isso, um parêntese dentro de uma string ou de um /regex/ zera a
 * conta e o detector passa a devolver nomes errados. Se os parênteses não
 * fecharem, LANÇA: o teste falha alto em vez de varrer menos do que devia.
 */
function pularArgumentos(texto, i) {
  if (texto[i] !== '(') throw new Error('pularArgumentos: esperava "(" em ' + i);

  let profundidade = 0;
  let anterior = '(';

  while (i < texto.length) {
    const c = texto[i];

    if (c === '"' || c === "'" || c === '`') {
      i = fimDaLiteral(texto, i, c);
      anterior = c;
      continue;
    }
    if (c === '/' && texto[i + 1] === '/') {
      i = texto.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (c === '/' && texto[i + 1] === '*') {
      const fim = texto.indexOf('*/', i + 2);
      if (fim === -1) break;
      i = fim + 2;
      continue;
    }
    // Posição de expressão regular: depois de operador ou abertura, nunca
    // depois de um valor. `a / b` é divisão; `(/ab(c/.test(x))` é regex.
    if (c === '/' && '(,=:[!&|?{};+-*%~^'.indexOf(anterior) !== -1) {
      i = fimDaRegex(texto, i);
      anterior = '/';
      continue;
    }

    if (c === '(') profundidade++;
    if (c === ')') {
      profundidade--;
      if (profundidade === 0) return i + 1;
    }
    if (!/\s/.test(c)) anterior = c;
    i++;
  }
  throw new Error('não consegui fechar os parênteses da chamada — o detector está cego, conserte-o');
}

function fimDaLiteral(texto, i, aspas) {
  for (let j = i + 1; j < texto.length; j++) {
    if (texto[j] === '\\') { j++; continue; }
    if (texto[j] === aspas) return j + 1;
  }
  throw new Error('literal de texto sem fechamento a partir de ' + i);
}

function fimDaRegex(texto, i) {
  let classe = false;
  for (let j = i + 1; j < texto.length; j++) {
    const c = texto[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') classe = true;
    else if (c === ']') classe = false;
    else if (c === '/' && !classe) return j + 1;
    else if (c === '\n') throw new Error('barra solta tratada como regex em ' + i);
  }
  throw new Error('expressão regular sem fechamento a partir de ' + i);
}

/** Pula espaços e comentários. */
function pularVazio(texto, i) {
  while (i < texto.length) {
    if (/\s/.test(texto[i])) { i++; continue; }
    if (texto[i] === '/' && texto[i + 1] === '/') {
      const fim = texto.indexOf('\n', i);
      if (fim === -1) return texto.length;
      i = fim + 1;
      continue;
    }
    if (texto[i] === '/' && texto[i + 1] === '*') {
      const fim = texto.indexOf('*/', i + 2);
      if (fim === -1) return texto.length;
      i = fim + 2;
      continue;
    }
    return i;
  }
  return i;
}

/**
 * Nomes de funções do servidor que a tela chama, e por quantas portas ela sai.
 *
 * ------------------------------------------------------- O que mudou em 07/08
 *
 * Havia DUAS formas de chamar o servidor: o envelope `chamar('nome', ...)` e a
 * cadeia crua `google.script.run.nome(...)`, esta última usada pelas funções de
 * login. Com o painel no GitHub Pages, `google.script.run` não existe mais —
 * aquela API só existe dentro de uma página servida pelo próprio Apps Script.
 * Sobrou UMA forma, e as de login passaram a entrar por ela também.
 *
 * O detector acompanhou. Ele continua fazendo as duas coisas que importam:
 *
 *   1. dizer TODO nome de função do servidor que a tela aciona, inclusive
 *      quando o nome é escolhido dentro da chamada
 *      (`chamar(cruzar ? 'atualizarAlunos' : 'listarAlunos', ...)`);
 *   2. LANÇAR quando não consegue ler o código, em vez de devolver menos nomes.
 *      Um detector que encolhe em silêncio foi exatamente como 16 funções
 *      faltando passaram batido — ver o cabeçalho deste arquivo.
 *
 * `portas` é o sucessor do contador de despacho dinâmico: quantos `fetch(` a
 * tela tem. Ele precisa ser UM. Uma segunda saída para a rede seria uma chamada
 * ao servidor sem o token injetado, sem o tratamento de sessão expirada e sem o
 * esquecimento das abas — três coisas que só existem dentro de `chamar()`, e
 * cuja falta não aparece na tela: aparece como dado velho e como sessão que não
 * cai. (O `fetch` da galeria de banners não conta: ele vai ao GitHub Pages
 * buscar um manifesto, e não ao `/exec`.)
 */
function chamadasDoAdmin(html) {
  const nomes = new Set();
  let portas = 0;

  const marca = /\bchamar\(/g;
  let m;
  while ((m = marca.exec(html)) !== null) {
    const abre = m.index + m[0].length - 1;
    const fim = pularArgumentos(html, abre);          // lança se não fechar
    const argumentos = html.slice(abre + 1, fim - 1);

    // Só o PRIMEIRO argumento: o resto da chamada carrega payload e callbacks,
    // e um `'nome'` solto lá dentro não é função do servidor.
    const primeiro = argumentos.split(',')[0];
    (primeiro.match(/'([A-Za-z_$][\w$]*)'/g) || []).forEach((n) => nomes.add(n.slice(1, -1)));
  }

  const saidas = /\bfetch\s*\(/g;
  while ((m = saidas.exec(html)) !== null) {
    // A que busca o manifesto dos banners no site é outra coisa: ela não fala
    // com o `/exec` e não carrega token nenhum.
    if (html.slice(m.index, m.index + 200).indexOf('BASE_SITE') === -1) portas++;
  }

  return { nomes: Array.from(nomes).sort(), portas };
}

/** Toda função declarada em algum `.gs`, com o arquivo onde ela nasce. */
function funcoesDoServidor() {
  const dono = {};
  fs.readdirSync(PASTA_GS).filter((f) => /\.gs$/.test(f)).sort().forEach((arquivo) => {
    const texto = fs.readFileSync(path.join(PASTA_GS, arquivo), 'utf8');
    const re = /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
    let m;
    while ((m = re.exec(texto)) !== null) {
      if (!dono[m[1]]) dono[m[1]] = [];
      dono[m[1]].push(arquivo);
    }
  });
  return dono;
}

teste('o detector enxerga as chamadas do painel, inclusive as de login', () => {
  // Prova do detector antes de usá-lo como prova de outra coisa. As de login
  // entravam pela cadeia crua do `google.script.run` e agora entram pelo mesmo
  // envelope de todo o resto — se elas sumirem daqui, é porque alguém abriu uma
  // segunda porta para a rede.
  //
  // `autenticar` saiu da lista junto com o PIN, e no lugar dela entraram as duas
  // do link por e-mail (07b_LinkPorEmail.gs): são as portas anônimas de hoje, e
  // são elas que precisam continuar visíveis para o detector.
  const achadas = chamadasDoAdmin(ADMIN);
  ['pedirLinkDeAcesso', 'entrarComLink', 'modoDeAcesso', 'sair', 'entrarComGoogle'].forEach((n) => {
    verdadeiro(achadas.nomes.indexOf(n) !== -1, 'o detector escondeu ' + n);
  });
  verdadeiro(achadas.nomes.indexOf('listarBanners') !== -1, 'o envelope escondeu listarBanners');
});

teste('o detector reprova código que ele não consegue ler', () => {
  // Um detector que devolve menos nomes quando tropeça é pior do que nenhum: foi
  // exatamente assim que 16 funções faltando passaram batido. Aqui ele lança.
  let lancou = false;
  try {
    chamadasDoAdmin("chamar('minhaFuncao', { falta: fechar");
  } catch (e) {
    lancou = true;
  }
  verdadeiro(lancou, 'parêntese sem fechamento precisa derrubar o teste, não sumir com nomes');
});

teste('parêntese dentro de texto e de regex não engana o detector', () => {
  // É o caso que existe de verdade dentro do envelope, `/Sess.o expirada|inv.lida/`.
  // Contar parênteses sem saber o que é literal faria a chamada terminar no
  // lugar errado — e a PRÓXIMA sumiria junto.
  const achadas = chamadasDoAdmin(
    "chamar('primeira', {}, function (r) { if (/^\\(a|b\\)$/.test(r)) avisar('erro :-('); });" +
    "chamar('segunda', {}, function () { console.log(') ) )'); });"
  );
  igual(achadas.nomes, ['primeira', 'segunda']);
});

teste('o painel tem UMA porta para o servidor, e ela é o envelope', () => {
  // Um segundo `fetch` para o `/exec` seria uma chamada sem token injetado, sem
  // o tratamento de sessão expirada e sem o esquecimento das abas. Nada disso
  // aparece na tela quando falta: aparece como dado velho e sessão que não cai.
  igual(chamadasDoAdmin(ADMIN).portas, 1,
    'apareceu outro fetch() falando com o servidor fora de chamar()');
});

teste('o painel não fala mais por google.script.run', () => {
  // Servido pelo GitHub Pages, aquela API simplesmente não existe: `google` na
  // página é a biblioteca de LOGIN do Google, e `google.script` é undefined —
  // um resto daquela forma no arquivo é um botão que estoura ao ser clicado.
  //
  // A busca é pela forma EXECUTÁVEL (`.algo` ou `[algo]` depois do nome), e não
  // pelo nome solto: ele aparece de propósito no texto que explica a mudança, e
  // um teste que proibisse a palavra proibiria contar a história.
  igual(/google\.script\.run\s*[.[]/.test(ADMIN), false,
    'sobrou uma chamada por google.script.run no painel — fora do Apps Script isso não roda');
});

teste('TODA função que o painel chama existe em algum .gs', () => {
  const chamadas = chamadasDoAdmin(ADMIN).nomes;
  const servidor = funcoesDoServidor();

  verdadeiro(chamadas.length >= 22, 'só ' + chamadas.length + ' chamadas: o detector regrediu');

  const faltando = chamadas.filter((n) => !servidor[n]);
  igual(faltando, [],
    'o painel chama ' + faltando.length + ' função(ões) que não existem no servidor: ' +
    faltando.join(', ') + '. O botão correspondente devolve erro genérico no navegador.');
});

teste('as duas funções desta fase estão de pé e são chamadas pelo painel', () => {
  const amb = ambiente();
  const chamadas = chamadasDoAdmin(ADMIN).nomes;

  ['listarBanners', 'enviarBanner'].forEach((funcao) => {
    igual(typeof amb.api[funcao], 'function', funcao + ' não existe');
    verdadeiro(chamadas.indexOf(funcao) !== -1, 'o Admin.html não chama ' + funcao);
  });

  igual(typeof amb.api.removerBanner, 'function');
  igual(chamadas.indexOf('removerBanner'), -1,
    'ganhou botão no painel? então este teste vira o contrário, e o payload precisa mandar `id`');
});

teste('nenhum nome de função é declarado em dois .gs', () => {
  // O Apps Script compartilha um escopo global só: duas declarações do mesmo
  // nome não dão erro, e a do arquivo carregado por último vence em silêncio.
  const repetidas = Object.keys(funcoesDoServidor())
    .filter((n) => funcoesDoServidor()[n].length > 1)
    .map((n) => n + ' (' + funcoesDoServidor()[n].join(', ') + ')');
  igual(repetidas, []);
});

process.exit(resultado());
