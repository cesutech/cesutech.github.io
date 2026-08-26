/**
 * backup.js — prova 14_Backup.gs sem tocar no Google.
 *
 * O que se prova, em ordem de importância:
 *
 *   1. A TRANCA. Coleção que falha no meio (e arquivo que não passa na
 *      conferência) NÃO produzem "o backup de hoje", e a reciclagem NÃO roda.
 *      É o teste mais importante do arquivo: backup quebrado somado a limpeza
 *      funcionando é um sistema que apaga todas as próprias cópias em
 *      `backup_dias` dias, sozinho e em silêncio. Aqui a prova não é "os
 *      arquivos continuam lá" — é que `Drive.Files.update({trashed:true})` não
 *      foi chamado NENHUMA vez.
 *   2. NUNCA ZERO. O mais recente sobrevive mesmo sendo mais velho que a janela
 *      inteira.
 *   3. `backup_dias` torto não vira exclusão: vazio, zero, negativo e texto
 *      passam pelos quatro casos, e nos quatro nada é apagado.
 *   4. O que não casa com o padrão do nome não é tocado — nem os quase-casos,
 *      que são os que enganam (extensão trocada, data com um dígito, prefixo
 *      parecido).
 *   5. A lista de coleções se descobre sozinha: constante `*_COLECAO` nova entra
 *      no arquivo sem ninguém editar uma segunda lista, e coleção que existe só
 *      no banco entra também.
 *   6. O arquivo é restaurável: cada documento leva o id, e as contagens do
 *      cabeçalho batem com o que foi lido.
 *
 * ONDE ESTES TESTES NÃO ALCANÇAM, e nenhum deles prova o contrário:
 *
 *   - O Drive daqui é de mentira. Que `Drive.Files.create` com um blob de vários
 *     MB e escopo `drive.file` grave o arquivo inteiro, que `?alt=media` devolva
 *     exatamente os mesmos bytes, e que o escopo restrito realmente esconda os
 *     arquivos de terceiros — as três coisas só o Google prova. A conferência
 *     por releitura existe justamente porque a primeira delas pode falhar em
 *     produção sem falhar aqui.
 *   - O teto de ~6 minutos de execução é simulado fazendo o relógio andar a cada
 *     requisição. Isso prova que o freio DISPARA e o que ele faz quando dispara;
 *     não prova quanto tempo o backup leva de verdade.
 *   - O Firestore falso não cobra leitura mínima nem tem limite de tamanho de
 *     documento. As contas de cota do cabeçalho de 14_Backup.gs são aritmética
 *     sobre a documentação, não medição nossa.
 *
 * Uso:  node testes/backup.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  teste, grupo, igual, verdadeiro, lancou, resultado, criarAmbiente, criarRelogio
} = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');

/**
 * Na ordem alfabética em que o editor do Apps Script carrega os arquivos.
 *
 * São muitos porque a descoberta de coleções lê as constantes `*_COLECAO` do
 * escopo global, e as dez moram espalhadas por sete arquivos. Carregar só o que
 * 14_Backup.gs "usa" provaria a descoberta contra uma lista que o próprio teste
 * montou — que é exatamente o erro que a descoberta existe para não cometer.
 */
const GS = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '02b_Drive.gs',
  '03_Config.gs', '04_Inscricoes.gs', '04_Log.gs', '05_Importacao.gs',
  '06_Reconciliacao.gs', '09_Projetos.gs', '12_Disciplinas.gs',
  '13_Auditorio.gs', '14_Backup.gs'];

const FONTE = fs.readFileSync(path.join(PASTA_GS, '14_Backup.gs'), 'utf8');

const DRIVE_REST = 'https://www.googleapis.com/drive/v3/files/';

/** O código sem comentário nenhum. Comentário explica; só linha viva acusa. */
function semComentarios(texto) {
  return texto.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** As dez de hoje. A lista está aqui para ser CONFERIDA, nunca para ser usada. */
const DEZ_COLECOES = ['agregados', 'alunos', 'config', 'disciplinas', 'inscricoes',
  'inscricoes_anuladas', 'log', 'lotes', 'matriculados', 'projetos'];

const DIA_MS = 24 * 60 * 60 * 1000;

// 18/08/2026, 9h da manhã em Brasília (12h UTC).
const INSTANTE = Date.UTC(2026, 7, 18, 12, 0, 0);
const HOJE = '2026-08-18';

// ------------------------------------------------------------ Blob e Drive

function criarBlob(conteudo, mime, nome) {
  const texto = String(conteudo);
  return {
    getName: () => nome || '',
    getContentType: () => mime || '',
    getDataAsString: () => texto,
    getBytes: () => Buffer.from(texto, 'utf8')
  };
}

/**
 * Drive em memória com o que 02b_Drive.gs usa: criar, listar (PAGINANDO) e
 * mandar para a lixeira pelo serviço avançado, e BAIXAR por HTTP.
 *
 * A leitura de conteúdo é HTTP porque é assim em produção: o serviço avançado do
 * Apps Script não carrega mídia (ver o cabeçalho de 02b_Drive.gs). Um falso que
 * respondesse `Drive.Files.get(id, {alt:'media'})` com o texto certinho provaria
 * um caminho que não existe — e a conferência por releitura, que é a razão de
 * este arquivo existir, estaria provada contra ficção.
 *
 * `corromper` é o que permite testar a regra 6 de verdade: ele troca o que a
 * releitura devolve, simulando gravação truncada. Sem ele, `backupConferir_`
 * nunca teria como reprovar nada.
 */
function criarDriveFalso(relogio) {
  const arquivos = new Map();
  const chamadas = [];
  let proximo = 1;
  let corromper = null;

  function agoraIso() {
    return new Date(relogio.agora()).toISOString();
  }

  function resposta(codigo, texto) {
    return { getResponseCode: () => codigo, getContentText: () => texto };
  }

  const api = {
    arquivos,
    chamadas,

    /** Quantas vezes alguma coisa foi para a lixeira. É o contador da tranca. */
    descartes() {
      return chamadas.filter((c) => c.metodo === 'update' &&
        c.recurso && c.recurso.trashed === true).length;
    },

    /** Os arquivos vivos de uma pasta, como a coordenação os veria. */
    vivos(pastaId) {
      const saida = [];
      arquivos.forEach((f) => {
        if (f.trashed) return;
        if (pastaId && f.parents.indexOf(pastaId) === -1) return;
        saida.push(f);
      });
      return saida;
    },

    nomesVivos(pastaId) {
      return api.vivos(pastaId).map((f) => f.name).sort();
    },

    porNome(nome) {
      let achado = null;
      arquivos.forEach((f) => { if (!f.trashed && f.name === nome) achado = f; });
      return achado;
    },

    /** Semeia um arquivo já existente na pasta, com data de criação escolhida. */
    semear(pastaId, nome, conteudo, criadoEm) {
      const id = 'drv' + (proximo++);
      arquivos.set(id, {
        id,
        name: nome,
        mimeType: 'application/json',
        parents: [pastaId],
        conteudo: conteudo === undefined ? '{}' : conteudo,
        trashed: false,
        createdTime: criadoEm || agoraIso()
      });
      return id;
    },

    /** A PRÓXIMA leitura por HTTP devolve isto em vez do conteúdo real. */
    corromperProximaLeitura(texto) { corromper = texto; },

    Drive: {
      Files: {
        create(recurso, blob, params) {
          chamadas.push({ metodo: 'create', recurso, params });
          const id = 'drv' + (proximo++);
          arquivos.set(id, {
            id,
            name: (recurso && recurso.name) || (blob && blob.getName()) || '',
            mimeType: (recurso && recurso.mimeType) ||
              (blob && blob.getContentType()) || 'application/octet-stream',
            parents: (recurso && recurso.parents) || [],
            conteudo: blob ? blob.getDataAsString('UTF-8') : '',
            trashed: false,
            createdTime: agoraIso()
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
          const pai = /'([^']+)' in parents/.exec(params.q || '');
          const files = [];
          arquivos.forEach((f) => {
            if (f.trashed) return;
            if (pai && f.parents.indexOf(pai[1]) === -1) return;
            files.push({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              createdTime: f.createdTime,
              size: String(f.conteudo.length)
            });
          });

          // `orderBy: 'createdTime desc'` é o que 02b_Drive.gs pede, e a ordem
          // importa aqui: é ela que faz o truncamento da listagem cortar sempre
          // pela ponta VELHA. Um falso que devolvesse em ordem de inserção
          // esconderia isso.
          files.sort((a, b) => (a.createdTime < b.createdTime ? 1 : -1));

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
          return {};
        }
      }
    },

    /** A única rota REST que 14_Backup.gs usa: baixar o conteúdo. */
    atender(url, opcoes) {
      chamadas.push({ metodo: 'http', url });

      const cabecalhos = (opcoes && opcoes.headers) || {};
      if (String(cabecalhos.Authorization || '').indexOf('Bearer ') !== 0) {
        return resposta(401, JSON.stringify({ error: { code: 401, message: 'Login Required.' } }));
      }

      const media = new RegExp('^' + DRIVE_REST + '([^/?]+)\\?alt=media$').exec(url);
      if (!media) {
        return resposta(404, JSON.stringify({ error: { code: 404, message: 'rota não atendida: ' + url } }));
      }

      const f = arquivos.get(decodeURIComponent(media[1]));
      if (!f || f.trashed) {
        return resposta(404, JSON.stringify({ error: { code: 404, message: 'File not found.' } }));
      }

      if (corromper !== null) {
        const texto = corromper;
        corromper = null;
        return resposta(200, texto);
      }
      return resposta(200, f.conteudo);
    }
  };

  return api;
}

/**
 * ScriptApp com acionadores de mentira, no molde de `testes/api.js`.
 *
 * `getOAuthToken` é preservado porque o Repo o usa em toda ida ao Firestore E
 * `driveBaixarTexto_` o usa em toda leitura do Drive: trocar o objeto inteiro
 * deixaria o sandbox sem banco e sem conferência.
 */
function scriptAppComGatilhos(amb) {
  const instalados = [];
  const oauth = amb.api.ScriptApp.getOAuthToken;

  amb.api.ScriptApp = {
    getOAuthToken: oauth,
    // Cópia: o instalador percorre a lista APAGANDO, e apagar da lista que se
    // está percorrendo é como um gatilho sobra sem ninguém ver.
    getProjectTriggers: () => instalados.slice(),
    deleteTrigger(g) {
      const i = instalados.indexOf(g);
      if (i !== -1) instalados.splice(i, 1);
    },
    newTrigger(handler) {
      const gatilho = { hora: null, dias: 0, getHandlerFunction: () => handler };
      const construtor = {
        atHour(h) { gatilho.hora = h; return construtor; },
        everyDays(n) { gatilho.dias = n; return construtor; },
        create() { instalados.push(gatilho); return gatilho; }
      };
      return { timeBased: () => construtor };
    }
  };

  return instalados;
}

// ------------------------------------------------------------ Ambiente

function ambiente(opcoes) {
  opcoes = opcoes || {};
  const relogio = criarRelogio(opcoes.instante === undefined ? INSTANTE : opcoes.instante);
  const amb = criarAmbiente({
    arquivos: GS,
    usuario: opcoes.usuario === undefined ? 'coordenacao@exemplo.com' : opcoes.usuario,
    relogio
  });

  amb.relogio = relogio;
  const drive = criarDriveFalso(relogio);
  amb.drive = drive;
  amb.api.Drive = drive.Drive;
  amb.api.Utilities.newBlob = (conteudo, mime, nome) => criarBlob(conteudo, mime, nome);

  // Quanto o relógio anda a cada ida ao Firestore. Zero no caso normal; é isto
  // que faz o prazo de execução estourar quando o teste quer.
  amb.msPorRequisicao = 0;

  // Quando não é null, a consulta a esta coleção falha com 500. É como se
  // provoca "uma coleção quebrou no meio" sem mexer no código de produção.
  amb.colecaoQuebrada = null;

  const fetchFirestore = amb.falso.UrlFetchApp.fetch;
  const roteador = {
    fetch(url, o) {
      if (String(url).indexOf('https://www.googleapis.com/drive/') === 0) {
        return drive.atender(url, o);
      }
      if (amb.msPorRequisicao) relogio.avancar(amb.msPorRequisicao);

      if (amb.colecaoQuebrada && o && o.payload) {
        const corpo = JSON.parse(o.payload);
        const alvo = corpo.structuredQuery && corpo.structuredQuery.from &&
          corpo.structuredQuery.from[0].collectionId;
        if (alvo === amb.colecaoQuebrada) {
          return {
            getResponseCode: () => 500,
            getContentText: () => JSON.stringify({
              error: { code: 500, status: 'INTERNAL', message: 'algo explodiu no meio da leitura' }
            })
          };
        }
      }
      return fetchFirestore(url, o);
    },
    fetchAll: (lote) => amb.falso.UrlFetchApp.fetchAll(lote)
  };
  amb.api.UrlFetchApp = roteador;

  amb.gatilhos = scriptAppComGatilhos(amb);

  // A pasta é criada aqui para o teste poder semear arquivos nela. Isso já é uma
  // chamada ao Drive, e ela seria contada como "o backup criou um arquivo" nos
  // testes que provam que NADA foi criado. Zerado depois de montar.
  amb.pasta = amb.api.pastaBackup_();
  amb.drive.chamadas.length = 0;
  return amb;
}

/** Semeia as duas chaves do painel. Sem elas, `backup_dias` está VAZIA. */
function configurar(amb, dias, ligado) {
  if (dias !== undefined) amb.api.gravarConfig('backup_dias', String(dias));
  if (ligado !== undefined) amb.api.gravarConfig('backup_ligado', String(ligado));
}

/** Um documento em cada uma das dez coleções, com um campo reconhecível. */
function semearBanco(amb, quantos) {
  const n = quantos || 2;
  DEZ_COLECOES.forEach((colecao) => {
    for (let i = 1; i <= n; i++) {
      amb.api.inserir(colecao, {
        criado_em: '2026080' + i + 'T100000000Z',
        marca: colecao + '-' + i
      }, colecao + '_doc' + i);
    }
  });
}

/** O nome do arquivo de um dia. Montado aqui à mão, de propósito: se o código
 *  mudar o padrão sem querer, estes testes têm de ficar vermelhos. */
function nomeDe(data) {
  return 'cesutech-backup-' + data + '.json';
}

/** 'AAAA-MM-DD' de N dias atrás, a partir de HOJE. */
function diasAtras(n) {
  const d = new Date(Date.UTC(2026, 7, 18) - n * DIA_MS);
  return d.toISOString().slice(0, 10);
}

/** Semeia backups antigos na pasta, com data de criação coerente com o nome. */
function semearBackupsAntigos(amb, listaDeDias) {
  return listaDeDias.map((n) => amb.drive.semear(
    amb.pasta,
    nomeDe(diasAtras(n)),
    JSON.stringify({ completo: true, data: diasAtras(n) }),
    new Date(Date.UTC(2026, 7, 18) - n * DIA_MS).toISOString()
  ));
}

/** O conteúdo do backup de hoje, já parseado. */
function arquivoDeHoje(amb) {
  const f = amb.drive.porNome(nomeDe(HOJE));
  verdadeiro(f, 'não existe arquivo ' + nomeDe(HOJE) + ' na pasta');
  return JSON.parse(f.conteudo);
}

// ============================================================ O caminho feliz

grupo('o backup do dia — o que ele copia e o que ele promete');

teste('grava as dez coleções, com o id de cada documento', () => {
  const amb = ambiente();
  semearBanco(amb, 2);

  const r = amb.api.fazerBackup();
  igual(r.ok, true, r.erro);

  const arquivo = arquivoDeHoje(amb);
  igual(arquivo.colecoes, DEZ_COLECOES, 'as coleções do arquivo');
  igual(arquivo.completo, true);

  DEZ_COLECOES.forEach((colecao) => {
    const docs = arquivo.documentos[colecao];
    verdadeiro(docs && docs.length >= 2, colecao + ' veio com ' + (docs && docs.length));
    docs.forEach((d) => {
      verdadeiro(d.id, 'documento sem id em ' + colecao);
      verdadeiro(d.campos && d.campos.marca !== undefined,
        'os campos não vieram em ' + colecao);
    });
  });

  // O id do documento fica FORA de `campos`. `projetos` tem um campo chamado
  // `id` (00_Config.gs); achatar os dois faria um sobrescrever o outro e quem
  // restaurasse gravaria no documento errado sem receber erro nenhum.
  const umProjeto = arquivo.documentos.projetos[0];
  igual(umProjeto.id, 'projetos_doc1');
  igual(umProjeto.campos.id, undefined, 'o id do documento vazou para dentro de campos');
});

teste('a contagem do cabeçalho bate com o que foi lido, coleção por coleção', () => {
  const amb = ambiente();
  semearBanco(amb, 3);
  // Uma coleção com tamanho diferente das outras: contagem que "bate" porque
  // todas têm o mesmo número não prova nada.
  amb.api.inserir('inscricoes', { criado_em: '20260809T100000000Z', marca: 'extra' }, 'i_extra');

  const r = amb.api.fazerBackup();
  igual(r.ok, true, r.erro);

  const arquivo = arquivoDeHoje(amb);
  let soma = 0;
  DEZ_COLECOES.forEach((colecao) => {
    igual(arquivo.contagem[colecao], arquivo.documentos[colecao].length,
      'cabeçalho x array em ' + colecao);
    soma += arquivo.documentos[colecao].length;
  });

  igual(arquivo.contagem.inscricoes, 4, 'a coleção com um a mais');
  igual(arquivo.contagem.projetos, 3);
  igual(arquivo.total, soma, 'o total do cabeçalho');
  igual(r.total, soma, 'o total do resumo');
});

teste('o cabeçalho diz quando, quem, o tamanho e que há dado pessoal', () => {
  const amb = ambiente();
  semearBanco(amb, 1);

  const r = amb.api.fazerBackup();
  const arquivo = arquivoDeHoje(amb);

  igual(arquivo.gerado_por, 'coordenacao@exemplo.com');
  igual(arquivo.data, HOJE);
  igual(arquivo.arquivo, nomeDe(HOJE));
  igual(arquivo.contem_dado_pessoal, true);
  igual(arquivo.formato, 1);
  verdadeiro(/^2026-08-18 09:00/.test(arquivo.gerado_em), arquivo.gerado_em);
  verdadeiro(r.tamanho_kb >= 0 && typeof r.tamanho_kb === 'number', 'o tamanho foi medido');
});

teste('o arquivo é JSON puro e o Drive é avisado disso', () => {
  const amb = ambiente();
  semearBanco(amb, 1);
  amb.api.fazerBackup();

  const f = amb.drive.porNome(nomeDe(HOJE));
  igual(f.mimeType, 'application/json');
  // Sem compactar: quem restaura num dia ruim abre com o que tiver à mão.
  igual(f.conteudo.charAt(0), '{');
  igual(JSON.parse(f.conteudo).sistema, 'CESUTECH');
});

teste('grava a trilha de auditoria do backup, uma linha só', () => {
  const amb = ambiente();
  semearBanco(amb, 1);
  const antes = amb.api.contar('log');

  amb.api.fazerBackup();

  const registros = amb.api.listar('log', { ordenarPor: 'criado_em', direcao: 'DESC', limite: 5 }).itens;
  const backup = registros.filter((l) => l.acao === 'BACKUP');
  igual(backup.length, 1, 'uma linha de BACKUP');
  igual(amb.api.contar('log'), antes + 1, 'e nenhuma outra');
  verdadeiro(/"total":/.test(backup[0].detalhe), backup[0].detalhe);
});

teste('o arquivo NÃO é tornado público — nem por engano, nem por herança', () => {
  const amb = ambiente();
  semearBanco(amb, 1);
  amb.api.fazerBackup();

  igual(amb.drive.chamadas.filter((c) => c.metodo === 'permissao').length, 0,
    'alguma permissão foi concedida a um arquivo com CPF de aluno dentro');
  // Sobre o CÓDIGO, e não sobre o texto: o cabeçalho de 14_Backup.gs explica em
  // prosa por que essa função não é chamada aqui, e uma busca crua acusaria a
  // própria explicação. É a mesma limpeza que `usosDeServico` faz em
  // testes/consertos.js.
  igual(semComentarios(FONTE).indexOf('driveTornarPublico_'), -1,
    '14_Backup.gs CHAMA driveTornarPublico_ — ela existe para os banners');
});

// ============================================================ A conferência

grupo('a conferência — backup que nunca foi lido de volta é esperança');

teste('relê do Drive depois de gravar, e é releitura de verdade (HTTP)', () => {
  const amb = ambiente();
  semearBanco(amb, 1);
  amb.api.fazerBackup();

  const leituras = amb.drive.chamadas.filter((c) => c.metodo === 'http');
  igual(leituras.length, 1, 'o arquivo foi lido de volta exatamente uma vez');
  verdadeiro(/\?alt=media$/.test(leituras[0].url), leituras[0].url);
});

teste('gravação truncada é PEGA, o arquivo vai para a lixeira e o dia falha', () => {
  const amb = ambiente();
  configurar(amb, 15);
  semearBanco(amb, 2);
  const antigos = semearBackupsAntigos(amb, [40, 60]);

  // O Drive aceitou e guardou menos do que foi enviado. É o modo de falha que
  // a conferência existe para pegar, e o único jeito de ele aparecer aqui.
  amb.drive.corromperProximaLeitura('{"completo":true,"documentos"');

  const r = amb.api.fazerBackup();
  igual(r.ok, false);
  verdadeiro(/passou na conferência/.test(r.erro), r.erro);

  igual(amb.drive.porNome(nomeDe(HOJE)), null, 'o arquivo reprovado ficou na pasta');
  igual(amb.drive.nomesVivos(amb.pasta).length, 2, 'os antigos foram mexidos');
  antigos.forEach((id) => igual(amb.drive.arquivos.get(id).trashed, false));
});

/**
 * Os defeitos que a comparação de texto NÃO pega, porque não são de transporte:
 * o arquivo chega inteirinho e mente. Só a conferência de CONTAGEM os encontra,
 * e por isso ela é exercitada direto, com o texto do arquivo igual ao que foi
 * "enviado" — que é a única maneira de o primeiro teste (bytes) sair da frente.
 */
[
  ['o cabeçalho conta mais do que o array tem',
    { completo: true, contagem: { projetos: 9 }, total: 9, documentos: { projetos: [{ id: 'a' }] } },
    { projetos: 1 }, ['projetos'], 'cabeçalho'],
  ['o array tem menos do que foi lido do banco',
    { completo: true, contagem: { projetos: 1 }, total: 1, documentos: { projetos: [{ id: 'a' }] } },
    { projetos: 2 }, ['projetos'], 'foram lidos'],
  // Com o cabeçalho e o total CONCORDANDO entre si e mentindo juntos: é o único
  // caso em que a contagem do array é a última linha de defesa.
  ['o array encolheu e o cabeçalho combinou a história',
    { completo: true, contagem: { projetos: 2 }, total: 1, documentos: { projetos: [{ id: 'a' }] } },
    { projetos: 2 }, ['projetos'], 'foram lidos'],
  ['uma coleção sumiu do arquivo',
    { completo: true, contagem: {}, total: 0, documentos: {} },
    { projetos: 0 }, ['projetos'], 'não está no arquivo'],
  ['o arquivo não se diz completo',
    { completo: false, contagem: { projetos: 0 }, total: 0, documentos: { projetos: [] } },
    { projetos: 0 }, ['projetos'], 'completo'],
  ['há documento sem id',
    { completo: true, contagem: { projetos: 1 }, total: 1, documentos: { projetos: [{ campos: {} }] } },
    { projetos: 1 }, ['projetos'], 'sem id'],
  ['o total do cabeçalho não é a soma',
    { completo: true, contagem: { projetos: 1 }, total: 7, documentos: { projetos: [{ id: 'a' }] } },
    { projetos: 1 }, ['projetos'], 'não é a soma']
].forEach(([rotulo, conteudo, contagem, colecoes, trecho]) => {
  teste('a conferência reprova quando ' + rotulo, () => {
    const amb = ambiente();
    const texto = JSON.stringify(conteudo);
    const id = amb.drive.semear(amb.pasta, nomeDe(HOJE), texto);

    const saida = amb.api.backupConferir_(id, texto, contagem, colecoes);
    igual(saida.ok, false, 'passou: ' + JSON.stringify(saida));
    verdadeiro(saida.motivo.indexOf(trecho) !== -1, saida.motivo);
  });
});

teste('e aprova quando tudo bate', () => {
  const amb = ambiente();
  const conteudo = {
    completo: true,
    contagem: { projetos: 2, log: 0 },
    total: 2,
    documentos: { projetos: [{ id: 'a', campos: {} }, { id: 'b', campos: {} }], log: [] }
  };
  const texto = JSON.stringify(conteudo);
  const id = amb.drive.semear(amb.pasta, nomeDe(HOJE), texto);

  igual(amb.api.backupConferir_(id, texto, { projetos: 2, log: 0 }, ['projetos', 'log']),
    { ok: true, motivo: '', total: 2 });
});

teste('a conferência reprova conteúdo TROCADO, que nenhuma contagem enxerga', () => {
  const amb = ambiente();

  // Mesmo tamanho, mesma estrutura, mesmas contagens, mesmos ids — e o nome de
  // uma aluna com uma letra diferente. É a corrupção que só a comparação do
  // texto inteiro pega, e é por isso que ela existe além das contagens.
  const enviado = JSON.stringify({
    completo: true, contagem: { alunos: 1 }, total: 1,
    documentos: { alunos: [{ id: 'a1', campos: { nome: 'Ana Paula Souza' } }] }
  });
  const guardado = enviado.replace('Ana Paula Souza', 'Ana Pauia Souza');
  igual(guardado.length, enviado.length, 'o teste precisa dos dois do mesmo tamanho');

  const id = amb.drive.semear(amb.pasta, nomeDe(HOJE), guardado);
  const saida = amb.api.backupConferir_(id, enviado, { alunos: 1 }, ['alunos']);

  igual(saida.ok, false, 'aprovou um arquivo com o conteúdo trocado');
  verdadeiro(/não é o que foi enviado/.test(saida.motivo), saida.motivo);
});

teste('a conferência reprova quando o arquivo nem existe mais no Drive', () => {
  const amb = ambiente();
  const id = amb.drive.semear(amb.pasta, nomeDe(HOJE), '{}');
  amb.drive.arquivos.get(id).trashed = true;

  const saida = amb.api.backupConferir_(id, '{}', {}, []);
  igual(saida.ok, false);
  verdadeiro(/reler/.test(saida.motivo), saida.motivo);
});

teste('documento sem id derruba o backup em vez de virar arquivo inútil', () => {
  const amb = ambiente();
  lancou(() => amb.api.backupDocumento_({ nome: 'Ana' }), 'sem id');
  lancou(() => amb.api.backupDocumento_({ _id: '', nome: 'Ana' }), 'sem id');
  igual(amb.api.backupDocumento_({ _id: 'x1', _nome: 'p/x1', nome: 'Ana' }),
    { id: 'x1', campos: { nome: 'Ana' } });
});

// ============================================================ A TRANCA

grupo('A TRANCA — sem backup de hoje, a reciclagem não roda');

teste('coleção que falha no meio: nada é gravado e NADA é apagado', () => {
  const amb = ambiente();
  configurar(amb, 15);
  semearBanco(amb, 2);
  const antigos = semearBackupsAntigos(amb, [30, 45, 60, 90]);

  // `matriculados` é a nona das dez na ordem alfabética: oito coleções já foram
  // lidas quando ela explode. É exatamente o "no meio" que interessa.
  amb.colecaoQuebrada = 'matriculados';

  const r = amb.api.fazerBackup();
  igual(r.ok, false);
  verdadeiro(/matriculados/.test(r.erro), r.erro);
  verdadeiro(r.total > 0, 'o teste não provou nada: nenhuma coleção chegou a ser lida');

  // A prova não é "os arquivos continuam lá" — é que ninguém CHAMOU a exclusão.
  igual(amb.drive.descartes(), 0, 'alguma coisa foi para a lixeira');
  igual(amb.drive.porNome(nomeDe(HOJE)), null, 'saiu arquivo de um backup que falhou');
  igual(amb.drive.nomesVivos(amb.pasta).length, 4);
  antigos.forEach((id) => igual(amb.drive.arquivos.get(id).trashed, false));
});

teste('o backup que falhou também não deixa arquivo PARCIAL com cara de completo', () => {
  const amb = ambiente();
  semearBanco(amb, 2);
  amb.colecaoQuebrada = 'inscricoes';

  amb.api.fazerBackup();

  // Nenhum arquivo, de nome nenhum: nem `...-parcial.json`, nem rascunho.
  igual(amb.drive.nomesVivos(amb.pasta), []);
  igual(amb.drive.chamadas.filter((c) => c.metodo === 'create').length, 0,
    'algo foi criado no Drive durante um backup que falhou');
});

teste('a falha vai para a trilha e para o console — backup calado não existe', () => {
  const amb = ambiente();
  semearBanco(amb, 1);
  amb.colecaoQuebrada = 'alunos';

  amb.api.fazerBackup();

  const erros = amb.api.listar('log', { ordenarPor: 'criado_em', direcao: 'DESC', limite: 5 })
    .itens.filter((l) => l.acao === 'ERRO');
  igual(erros.length, 1);
  verdadeiro(/backup do dia falhou/.test(erros[0].detalhe), erros[0].detalhe);
  verdadeiro(amb.registros.erros.some((m) => /fazerBackup/.test(m)), 'nada no console');
});

teste('o gatilho não recebe exceção: fazerBackup engole e relata', () => {
  const amb = ambiente();
  amb.colecaoQuebrada = 'config';

  // Gatilho que lança manda e-mail de falha para o dono do script todo dia.
  const r = amb.api.fazerBackup();
  igual(r.ok, false);
  verdadeiro(typeof r.erro === 'string' && r.erro.length > 0);
});

teste('a reciclagem exige recibo — sem ele, ou com um de outro dia, não apaga', () => {
  const amb = ambiente();
  configurar(amb, 15);
  semearBackupsAntigos(amb, [1, 40, 60]);

  // A tranca não é a ordem das linhas em fazerBackup: é esta condição, e ela
  // continua valendo mesmo se alguém chamar a reciclagem direto.
  [undefined, null, {}, { ok: false, data: HOJE }, { ok: true, data: '' },
    { ok: true, data: '2026-08-17' }].forEach((recibo) => {
    const saida = amb.api.backupReciclar_(recibo);
    igual(saida.rodou, false, 'rodou com recibo ' + JSON.stringify(recibo));
    igual(saida.apagados, 0);
  });

  igual(amb.drive.descartes(), 0);
  igual(amb.drive.nomesVivos(amb.pasta).length, 3);
});

// ============================================================ A reciclagem

grupo('a reciclagem — o que sai, o que fica e o que nunca é tocado');

teste('apaga o que passou de backup_dias e mantém a janela inteira', () => {
  const amb = ambiente();
  configurar(amb, 15);
  semearBanco(amb, 1);
  semearBackupsAntigos(amb, [1, 5, 14, 15, 20, 60]);

  const r = amb.api.fazerBackup();
  igual(r.ok, true, r.erro);
  igual(r.reciclagem.rodou, true, r.reciclagem.motivo);

  // Janela de 15 dias CONTANDO HOJE: ficam hoje e os 14 anteriores.
  igual(amb.drive.nomesVivos(amb.pasta), [
    nomeDe(diasAtras(14)), nomeDe(diasAtras(5)), nomeDe(diasAtras(1)), nomeDe(HOJE)
  ].sort());
  igual(r.reciclagem.apagados, 3);
});

teste('backup_dias muda a janela, e o número é obedecido', () => {
  const amb = ambiente();
  configurar(amb, 3);
  semearBanco(amb, 1);
  semearBackupsAntigos(amb, [1, 2, 3, 4]);

  amb.api.fazerBackup();

  igual(amb.drive.nomesVivos(amb.pasta),
    [nomeDe(diasAtras(2)), nomeDe(diasAtras(1)), nomeDe(HOJE)].sort());
});

teste('NUNCA ZERO: o mais recente fica, mesmo mais velho que a janela inteira', () => {
  const amb = ambiente();
  configurar(amb, 15);
  // Sistema parado dois meses: TODOS os arquivos estão fora da janela. Só se
  // chega neste estado pela reciclagem chamada com um recibo de hoje sobre uma
  // pasta sem o arquivo de hoje — e é justamente aí que a regra tem de valer.
  semearBackupsAntigos(amb, [40, 55, 70]);

  const saida = amb.api.backupReciclar_({ ok: true, data: HOJE, id: 'seja-la-qual-for' });
  igual(saida.rodou, true);
  igual(saida.apagados, 2);
  igual(saida.preservado, nomeDe(diasAtras(40)), 'o preservado tem de ser o mais NOVO');
  igual(amb.drive.nomesVivos(amb.pasta), [nomeDe(diasAtras(40))]);
});

teste('com um arquivo só na pasta, não apaga nada e diz que não apagou', () => {
  const amb = ambiente();
  configurar(amb, 1);
  semearBackupsAntigos(amb, [365]);

  const saida = amb.api.backupReciclar_({ ok: true, data: HOJE, id: 'x' });
  igual(saida.apagados, 0);
  igual(amb.drive.descartes(), 0);
  igual(amb.drive.nomesVivos(amb.pasta).length, 1);
});

teste('a exclusão é LIXEIRA, e não sumiço: 30 dias de arrependimento', () => {
  const amb = ambiente();
  configurar(amb, 5);
  const ids = semearBackupsAntigos(amb, [1, 90]);

  amb.api.backupReciclar_({ ok: true, data: HOJE, id: 'x' });

  igual(amb.drive.arquivos.get(ids[1]).trashed, true, 'o velho não foi para a lixeira');
  verdadeiro(amb.drive.arquivos.has(ids[1]), 'o arquivo foi destruído em vez de ir para a lixeira');
  const update = amb.drive.chamadas.filter((c) => c.metodo === 'update');
  igual(update.length, 1);
  igual(update[0].recurso, { trashed: true });
});

// ============================================================ backup_dias torto

grupo('backup_dias torto — parâmetro digitado errado não vira exclusão');

[
  ['vazio', ''],
  ['zero', '0'],
  ['negativo', '-7'],
  ['texto', 'quinze'],
  ['quase número', '15 dias'],
  ['fracionário', '7.5'],
  ['só espaços', '   ']
].forEach(([rotulo, valor]) => {
  teste('backup_dias ' + rotulo + ' (' + JSON.stringify(valor) + ') não apaga NADA', () => {
    const amb = ambiente();
    configurar(amb, valor);
    semearBanco(amb, 1);
    semearBackupsAntigos(amb, [30, 200, 400]);

    const r = amb.api.fazerBackup();
    igual(r.ok, true, 'o backup em si tem de continuar acontecendo');
    igual(r.reciclagem.rodou, false);
    verdadeiro(/backup_dias/.test(r.reciclagem.motivo), r.reciclagem.motivo);

    igual(amb.drive.descartes(), 0, 'apagou com backup_dias ' + rotulo);
    igual(amb.drive.nomesVivos(amb.pasta).length, 4, 'os antigos mais o de hoje');
  });
});

teste('a chave AUSENTE também não apaga — vazio não é interpretado como o padrão', () => {
  const amb = ambiente();
  // Nada de `configurar`: a coleção `config` está vazia, que é o estado de uma
  // instalação onde ninguém semeou CONFIG_PADRAO ainda.
  semearBanco(amb, 1);
  semearBackupsAntigos(amb, [90]);

  const r = amb.api.fazerBackup();
  igual(r.ok, true);
  igual(r.reciclagem.rodou, false);
  verdadeiro(/vazio/.test(r.reciclagem.motivo), r.reciclagem.motivo);
  igual(amb.drive.descartes(), 0);
});

teste('o padrão de fábrica é 15 e ele está em CONFIG_PADRAO, com as duas chaves', () => {
  const amb = ambiente();
  const padroes = {};
  amb.api.CONFIG_PADRAO.forEach((c) => { padroes[c.chave] = c; });

  igual(padroes.backup_dias.valor, '15');
  igual(padroes.backup_ligado.valor, 'SIM');
  // A tela de Configurações lista as chaves de CONFIG_PADRAO com a descrição
  // daqui (lerConfiguracoes, 10_Painel.gs). Descrição vazia = parâmetro que
  // ninguém sabe para que serve.
  verdadeiro(padroes.backup_dias.descricao.length > 80);
  verdadeiro(padroes.backup_ligado.descricao.length > 80);
});

// ============================================================ O padrão do nome

grupo('o padrão do nome — a segunda tranca, depois do escopo drive.file');

teste('arquivo que não casa com o padrão não é apagado nem lido', () => {
  const amb = ambiente();
  configurar(amb, 1);

  // Todos com data de criação antiquíssima: pela idade, todos seriam apagados.
  // O que os salva é só o nome.
  const alheios = [
    'notas do professor.json',
    'backup-2020-01-01.json',
    'cesutech-backup-2020-01-01.txt',
    'cesutech-backup-2020-1-1.json',
    'cesutech-backup-2020-01-01.json.bak',
    'CESUTECH-BACKUP-2020-01-01.json',
    'cesutech-backup-2020-01-01Xjson'
  ].map((nome) => amb.drive.semear(amb.pasta, nome, '{}', '2020-01-01T00:00:00.000Z'));

  semearBackupsAntigos(amb, [1, 400]);
  amb.api.backupReciclar_({ ok: true, data: HOJE, id: 'x' });

  alheios.forEach((id) => igual(amb.drive.arquivos.get(id).trashed, false,
    'apagou ' + amb.drive.arquivos.get(id).name));
  igual(amb.drive.descartes(), 1, 'só o backup velho de verdade sai');
});

teste('o reconhecedor de nome e o montador de nome falam do mesmo padrão', () => {
  const amb = ambiente();
  igual(amb.api.backupNomeDoDia_('2026-08-18'), 'cesutech-backup-2026-08-18.json');
  igual(amb.api.backupDataDoNome_(amb.api.backupNomeDoDia_('2026-08-18')), '2026-08-18');
  igual(amb.api.backupDataDoNome_('cesutech-backup-2026-08-18.json'), '2026-08-18');
  ['', null, 'qualquer.json', 'cesutech-backup-.json', 'cesutech-backup-2026-08.json',
    'x-cesutech-backup-2026-08-18.json'].forEach((n) => {
    igual(amb.api.backupDataDoNome_(n), '', 'reconheceu ' + JSON.stringify(n));
  });
});

// ============================================================ Desligado

grupo('backup_ligado — desligar sem apagar o gatilho');

teste('em NAO, não grava e não apaga', () => {
  const amb = ambiente();
  configurar(amb, 15, 'NAO');
  semearBanco(amb, 2);
  semearBackupsAntigos(amb, [30, 90, 365]);
  const requisicoesAntes = amb.falso.requisicoes.length;

  const r = amb.api.fazerBackup();
  igual(r.ok, false);
  igual(r.ligado, false);

  igual(amb.drive.porNome(nomeDe(HOJE)), null, 'gravou com o backup desligado');
  igual(amb.drive.descartes(), 0, 'apagou com o backup desligado');
  igual(amb.drive.chamadas.filter((c) => c.metodo === 'create').length, 0);

  // E não lê o banco inteiro para descobrir que está desligado: a única
  // requisição é a da própria configuração.
  igual(amb.falso.requisicoes.length - requisicoesAntes, 1, 'leu o banco à toa');
});

teste('qualquer coisa que não seja NAO mantém o backup ligado', () => {
  ['SIM', 'sim', 'S', '', 'talvez', 'NÃO'].forEach((valor) => {
    const amb = ambiente();
    configurar(amb, undefined, valor);
    semearBanco(amb, 1);
    igual(amb.api.fazerBackup().ok, true, 'com backup_ligado=' + JSON.stringify(valor));
  });
});

teste('nao minúsculo também desliga', () => {
  const amb = ambiente();
  configurar(amb, undefined, 'nao');
  semearBanco(amb, 1);
  igual(amb.api.fazerBackup().ligado, false);
});

// ============================================================ A descoberta

grupo('a lista de coleções se descobre sozinha');

teste('constante *_COLECAO nova entra no backup sem ninguém editar segunda lista', () => {
  const amb = ambiente();
  semearBanco(amb, 1);

  // Uma coleção que nasce amanhã: a constante existe e o banco ainda está vazio.
  // Ela tem de aparecer no arquivo mesmo assim — a lista vazia é informação
  // ("estava vazia"), e o silêncio seria "esqueci dela".
  amb.api.PARECERES_COLECAO = 'pareceres';

  const r = amb.api.fazerBackup();
  igual(r.ok, true, r.erro);

  const arquivo = arquivoDeHoje(amb);
  verdadeiro(arquivo.colecoes.indexOf('pareceres') !== -1, 'a coleção nova ficou de fora');
  igual(arquivo.documentos.pareceres, []);
  igual(arquivo.contagem.pareceres, 0);
});

teste('coleção com dados no banco e sem constante nenhuma também entra', () => {
  const amb = ambiente();
  semearBanco(amb, 1);
  // Criada à mão no console, ou sobrada de uma versão antiga do código. Tem
  // gente dentro, e é o que importa.
  amb.api.inserir('recibos_antigos', { nome: 'Ana', cpf: '00011122233' }, 'r1');

  const arquivo = (amb.api.fazerBackup(), arquivoDeHoje(amb));
  verdadeiro(arquivo.colecoes.indexOf('recibos_antigos') !== -1);
  igual(arquivo.documentos.recibos_antigos.length, 1);
  igual(arquivo.documentos.recibos_antigos[0].campos.nome, 'Ana');
});

teste('as dez de hoje são descobertas, e nenhuma está escrita em 14_Backup.gs', () => {
  const amb = ambiente();
  igual(amb.api.backupColecoes_(), DEZ_COLECOES);

  // A prova de que não há segunda lista: os nomes das coleções não aparecem
  // como literal no código do arquivo. `log` é a exceção declarada — e mesmo ela
  // entra por LOG_COLECAO, não pelo texto 'log'.
  const codigo = semComentarios(FONTE);
  DEZ_COLECOES.forEach((colecao) => {
    igual(codigo.indexOf("'" + colecao + "'"), -1,
      "14_Backup.gs escreve '" + colecao + "' à mão — é a segunda lista voltando");
  });
  verdadeiro(codigo.indexOf('LOG_COLECAO') !== -1, 'o log é tratado pela constante');
});

teste('se o banco não souber dizer quais coleções existem, o backup falha (e não apaga)', () => {
  const amb = ambiente();
  configurar(amb, 15);
  semearBanco(amb, 1);
  semearBackupsAntigos(amb, [90]);

  // A configuração é lida ANTES da descoberta das coleções; sem aquecer o cache
  // dela aqui, o erro forçado cairia na leitura errada e o teste provaria outra
  // coisa.
  amb.api.lerConfig();

  // Copiar sem saber o que havia para copiar não é backup. Falhar aqui é seguro:
  // a reciclagem não roda e amanhã tenta de novo.
  amb.falso.forcar(500, 'INTERNAL', 'listCollectionIds indisponível');

  const r = amb.api.fazerBackup();
  igual(r.ok, false);
  verdadeiro(/coleções do banco/.test(r.erro), r.erro);
  igual(amb.drive.descartes(), 0);
  igual(amb.drive.nomesVivos(amb.pasta).length, 1);
});

// ============================================================ O log

grupo('o log — a única coleção que cresce sem teto');

teste('entram os mais RECENTES até o teto, e o arquivo diz que foi limitado', () => {
  const amb = ambiente();
  amb.api.BACKUP_LOG_MAX = 3;

  for (let i = 1; i <= 9; i++) {
    amb.api.inserir('log', {
      criado_em: '2026081' + i + 'T100000000Z',
      acao: 'EVENTO_' + i
    }, 'log_' + i);
  }

  const r = amb.api.fazerBackup();
  igual(r.ok, true, r.erro);

  const arquivo = arquivoDeHoje(amb);
  igual(arquivo.documentos.log.length, 3);
  igual(arquivo.documentos.log.map((d) => d.campos.acao), ['EVENTO_9', 'EVENTO_8', 'EVENTO_7'],
    'guardou os mais VELHOS em vez dos mais recentes');

  igual(arquivo.log_limitado, true);
  igual(arquivo.log_teto, 3);
  igual(r.log_limitado, true);
  verdadeiro(arquivo.avisos.length === 1 && /teto de 3 registros/.test(arquivo.avisos[0]),
    JSON.stringify(arquivo.avisos));
});

teste('o corte do log NÃO torna o backup incompleto — é política, não falha', () => {
  const amb = ambiente();
  configurar(amb, 15);
  amb.api.BACKUP_LOG_MAX = 2;
  semearBanco(amb, 3);
  semearBackupsAntigos(amb, [90]);

  const r = amb.api.fazerBackup();
  igual(r.ok, true, r.erro);
  igual(arquivoDeHoje(amb).completo, true);
  // E a reciclagem roda: um log cortado por decisão continua sendo o backup do
  // dia. Se ele desqualificasse o arquivo, o sistema pararia de reciclar para
  // sempre no dia em que o log passasse do teto.
  igual(r.reciclagem.rodou, true, r.reciclagem.motivo);
});

teste('log dentro do teto não gera aviso nenhum', () => {
  const amb = ambiente();
  amb.api.BACKUP_LOG_MAX = 50;
  semearBanco(amb, 2);

  const r = amb.api.fazerBackup();
  igual(r.log_limitado, false);
  igual(arquivoDeHoje(amb).avisos, []);
});

teste('não paga leitura por documento de log que não entra no arquivo', () => {
  const amb = ambiente();
  amb.api.BACKUP_LOG_MAX = 2;
  for (let i = 1; i <= 20; i++) {
    amb.api.inserir('log', { criado_em: '20260818T1000000' + (10 + i) + 'Z' }, 'log_' + i);
  }

  amb.falso.requisicoes.length = 0;
  amb.api.fazerBackup();

  const consultasDeLog = amb.falso.requisicoes.filter((r) =>
    r.corpo && r.corpo.structuredQuery &&
    r.corpo.structuredQuery.from[0].collectionId === 'log');
  igual(consultasDeLog.length, 1, 'uma consulta basta para pegar 2 registros');
  igual(consultasDeLog[0].corpo.structuredQuery.limit, 2,
    'pediu mais do que o teto e jogou fora o que sobrou — leitura é a cota escassa');
});

// ============================================================ Prazo e teto

grupo('os freios de tempo e de tamanho');

teste('prazo estourado: nada é gravado, e a mensagem diz onde parou', () => {
  const amb = ambiente();
  configurar(amb, 15);
  semearBanco(amb, 1);
  semearBackupsAntigos(amb, [90]);

  // Cada ida ao banco custando 40 segundos: a execução não chega ao fim das dez
  // coleções dentro dos 4 minutos de prazo.
  amb.msPorRequisicao = 40000;

  const r = amb.api.fazerBackup();
  igual(r.ok, false);
  verdadeiro(/tempo acabou/.test(r.erro), r.erro);
  igual(amb.drive.chamadas.filter((c) => c.metodo === 'create').length, 0);
  igual(amb.drive.descartes(), 0);
});

teste('teto de documentos estourado: nada é gravado e nada é apagado', () => {
  const amb = ambiente();
  configurar(amb, 15);
  amb.api.BACKUP_TETO_DOCUMENTOS = 5;
  semearBanco(amb, 2);
  semearBackupsAntigos(amb, [90]);

  const r = amb.api.fazerBackup();
  igual(r.ok, false);
  verdadeiro(/passou de 5 documentos/.test(r.erro), r.erro);
  igual(amb.drive.nomesVivos(amb.pasta).length, 1);
  igual(amb.drive.descartes(), 0);
});

teste('coleção grande demais para uma rodada derruba o backup nomeando a coleção', () => {
  const amb = ambiente();
  amb.api.RECONCILIACAO_TETO = 2;   // o teto de colecaoCompleta_, reaproveitado
  amb.api.RECONCILIACAO_BLOCO = 1;
  semearBanco(amb, 5);

  const r = amb.api.fazerBackup();
  igual(r.ok, false);
  // A mensagem de colecaoCompleta_ fala em reconciliação; o embrulho daqui diz
  // QUAL coleção parou o backup, que é a informação que faltava.
  verdadeiro(/A coleção "agregados" não pôde ser lida inteira/.test(r.erro) ||
    /a coleção "agregados" não pôde ser lida inteira/.test(r.erro), r.erro);
});

// ============================================================ Duas vezes no dia

grupo('rodar duas vezes no mesmo dia');

teste('não deixa dois arquivos do dia, e o do dia não é apagado', () => {
  const amb = ambiente();
  configurar(amb, 15);
  semearBanco(amb, 1);

  const primeiro = amb.api.fazerBackup();
  igual(primeiro.ok, true, primeiro.erro);

  // Entre as duas rodadas o banco mudou: a segunda tem de ser a que fica.
  amb.api.inserir('inscricoes', { criado_em: '20260818T120000000Z', marca: 'nova' }, 'i_nova');
  const segundo = amb.api.fazerBackup();

  igual(segundo.ok, true, segundo.erro);
  igual(segundo.substituidos, 1, 'o arquivo anterior do dia não foi recolhido');

  const doDia = [];
  amb.drive.arquivos.forEach((f) => { if (!f.trashed && f.name === nomeDe(HOJE)) doDia.push(f); });
  igual(doDia.length, 1, 'ficaram dois arquivos com o mesmo nome na pasta');
  igual(doDia[0].id, segundo.id, 'ficou o antigo em vez do novo');

  const arquivo = JSON.parse(doDia[0].conteudo);
  igual(arquivo.contagem.inscricoes, 2, 'o arquivo que sobrou é o desatualizado');
  igual(amb.api.contar('log') > 0, true);
});

teste('a substituição só acontece DEPOIS de o novo passar na conferência', () => {
  const amb = ambiente();
  semearBanco(amb, 1);
  const primeiro = amb.api.fazerBackup();
  igual(primeiro.ok, true);

  // A segunda rodada grava e reprova. O arquivo bom da manhã não pode ser a
  // vítima — é a mesma disciplina da quarentena do auditório: copia, confere,
  // só então apaga.
  amb.drive.corromperProximaLeitura('lixo');
  const segundo = amb.api.fazerBackup();

  igual(segundo.ok, false);
  const vivos = amb.drive.vivos(amb.pasta);
  igual(vivos.length, 1);
  igual(vivos[0].id, primeiro.id, 'o backup bom foi substituído por um reprovado');
});

// ============================================================ O gatilho

grupo('o gatilho diário');

teste('instala um, e rodar de novo continua sendo um', () => {
  const amb = ambiente();

  amb.api.instalarGatilhoBackup();
  igual(amb.gatilhos.length, 1);
  igual(amb.gatilhos[0].getHandlerFunction(), 'fazerBackup');
  igual(amb.gatilhos[0].dias, 1);

  amb.api.instalarGatilhoBackup();
  amb.api.instalarGatilhoBackup();
  igual(amb.gatilhos.length, 1, 'gatilho duplicado é invisível até alguém procurar');
});

teste('não colide com a reconciliação das 5h nem com a virada da cota', () => {
  const amb = ambiente();
  amb.api.instalarGatilhoBackup();

  // A cota do Spark vira à meia-noite do Pacífico (4h ou 5h aqui) e a
  // reconciliação roda entre 5h e 6h. O backup vem depois das duas coisas.
  igual(amb.gatilhos[0].hora, 6);
  verdadeiro(amb.api.BACKUP_HORA > 5, 'o backup passaria por cima da reconciliação');
});

teste('não mexe nos gatilhos dos outros', () => {
  const amb = ambiente();
  amb.api.instalarGatilhoAquecimento = undefined;
  amb.gatilhos.push({ getHandlerFunction: () => 'reconciliarAutomatico' });
  amb.gatilhos.push({ getHandlerFunction: () => 'aquecerWebApp' });

  amb.api.instalarGatilhoBackup();

  igual(amb.gatilhos.map((g) => g.getHandlerFunction()).sort(),
    ['aquecerWebApp', 'fazerBackup', 'reconciliarAutomatico']);
});

// ============================================================ conferirBackup

grupo('conferirBackup — relata, e não restaura');

teste('roda sem argumento nenhum (o botão Executar não passa argumentos)', () => {
  const amb = ambiente();
  semearBanco(amb, 2);
  amb.api.fazerBackup();

  igual(amb.api.conferirBackup.length, 0, 'a função declara parâmetro');

  const r = amb.api.conferirBackup();
  igual(r.ok, true);
  igual(r.arquivo, nomeDe(HOJE));
  igual(r.completo, true);
});

teste('compara o arquivo com o banco de hoje, coleção por coleção', () => {
  const amb = ambiente();
  semearBanco(amb, 2);
  amb.api.fazerBackup();

  // O mundo andou depois do backup: mais três inscrições.
  for (let i = 1; i <= 3; i++) {
    amb.api.inserir('inscricoes', { criado_em: '20260818T13000000' + i + 'Z' }, 'nova_' + i);
  }

  const r = amb.api.conferirBackup();
  const porColecao = {};
  r.linhas.forEach((l) => { porColecao[l.colecao] = l; });

  igual(porColecao.inscricoes.arquivo, 2);
  igual(porColecao.inscricoes.banco, 5, 'crescer depois do backup é o normal');
  igual(porColecao.matriculados.arquivo, 2);
  igual(porColecao.matriculados.banco, 2);
});

teste('coleção que existe hoje e não está no backup aparece marcada', () => {
  const amb = ambiente();
  semearBanco(amb, 1);
  amb.api.fazerBackup();

  // Nasceu depois do backup — e é justamente o caso que interessa descobrir.
  amb.api.inserir('convenios', { nome: 'Prefeitura' }, 'c1');

  const r = amb.api.conferirBackup();
  const convenios = r.linhas.filter((l) => l.colecao === 'convenios')[0];
  verdadeiro(convenios, 'a coleção nova não apareceu no relatório');
  igual(convenios.ausente, true);
  igual(convenios.arquivo, null);
  igual(convenios.banco, 1);
});

teste('NÃO escreve nada: nem no banco, nem no Drive', () => {
  const amb = ambiente();
  semearBanco(amb, 2);
  amb.api.fazerBackup();

  const documentosAntes = JSON.stringify(Array.from(amb.falso.documentos.keys()).sort());
  amb.falso.requisicoes.length = 0;
  amb.drive.chamadas.length = 0;

  amb.api.conferirBackup();

  igual(JSON.stringify(Array.from(amb.falso.documentos.keys()).sort()), documentosAntes,
    'o banco mudou durante uma CONFERÊNCIA');
  igual(amb.falso.requisicoes.filter((r) =>
    r.metodo === 'PATCH' || r.metodo === 'DELETE' || /:commit$/.test(r.url) ||
    (r.metodo === 'POST' && r.corpo && r.corpo.fields)).length, 0,
    'houve escrita no banco');
  igual(amb.drive.chamadas.filter((c) => c.metodo === 'create' || c.metodo === 'update').length, 0,
    'mexeu em arquivo do Drive');
});

teste('conta o banco em UMA ida, com agregação — conferir é barato', () => {
  const amb = ambiente();
  semearBanco(amb, 2);
  amb.api.fazerBackup();

  amb.falso.idas.length = 0;
  amb.api.conferirBackup();

  const agregacoes = amb.falso.requisicoes.filter((r) => /:runAggregationQuery/.test(r.url));
  igual(agregacoes.length, 10, 'uma agregação por coleção');
  verdadeiro(amb.falso.idas.indexOf(10) !== -1,
    'as dez contagens foram em fila indiana em vez de um fetchAll só');
});

teste('pasta vazia: diz o que fazer em vez de estourar', () => {
  const amb = ambiente();
  const r = amb.api.conferirBackup();
  igual(r.ok, false);
  verdadeiro(/nenhum backup/.test(r.motivo), r.motivo);
});

teste('arquivo ilegível é o pior resultado, e ele é DITO', () => {
  const amb = ambiente();
  semearBanco(amb, 1);
  amb.api.fazerBackup();
  amb.drive.corromperProximaLeitura('isto não é json');

  const r = amb.api.conferirBackup();
  igual(r.ok, false);
  verdadeiro(/não é legível/.test(r.motivo), r.motivo);
});

teste('confere o MAIS RECENTE, e a idade vem do nome e não do Drive', () => {
  const amb = ambiente();
  semearBanco(amb, 1);
  amb.api.fazerBackup();

  // Um arquivo com nome antigo criado AGORA — uma cópia restaurada da lixeira,
  // por exemplo. Quem manda é o conteúdo do nome, não o carimbo do Drive.
  amb.drive.semear(amb.pasta, nomeDe('2020-01-01'),
    JSON.stringify({ completo: true, data: '2020-01-01', colecoes: [], documentos: {} }),
    new Date(amb.relogio.agora() + 1000).toISOString());

  igual(amb.api.conferirBackup().arquivo, nomeDe(HOJE));
});

process.exit(resultado());
