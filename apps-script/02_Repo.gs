/**
 * 02_Repo.gs — a camada de dados. Cliente REST do Cloud Firestore.
 *
 * Este arquivo é o ÚNICO caminho de dados do sistema. Não existe planilha por
 * baixo, não existe segundo repositório: tudo que é lido ou gravado passa por
 * `inserir`, `ler`, `listar`, `atualizar`, `excluir`, `contar`,
 * `escreverEmLote`, `excluirEmLote`, `atualizarEmLote` e `escreverAtomico`
 * (mais `contarVarios`, que é `contar` em paralelo). Se uma função de negócio
 * precisa tocar em dado, ela chama uma destas.
 *
 * Todas menos uma são recortes do mesmo pedido: um verbo, uma coleção.
 * `escreverAtomico` é a exceção e a única escrita multidocumento atômica que
 * existe aqui — verbos e coleções diferentes num `:commit` só, tudo ou nada.
 *
 * A API pública é deliberadamente a mesma que o projeto irmão
 * (o sistema anterior, sobre Google Sheets) expõe sobre o Google Sheets. Lá
 * `lerTudo`/`inserir`/`atualizar`/`excluirLinha` fazem, sobre abas, o que
 * `listar`/`inserir`/`atualizar`/`excluir` fazem aqui sobre coleções. Manter os
 * nomes é o que permite trazer as regras de negócio de lá com desvio de chamada,
 * e não com reescrita.
 *
 * Por que REST e não uma biblioteca pronta: o Apps Script não tem serviço
 * avançado de Firestore. As bibliotecas de terceiros que existem exigem colar
 * uma chave de conta de serviço nas propriedades do script — uma credencial
 * permanente, de fora do domínio, guardada em texto. `ScriptApp.getOAuthToken()`
 * devolve o token da própria execução, que expira sozinho e carrega exatamente
 * os escopos autorizados. É a mesma escolha que 02b_Drive.gs fez: chamada mais
 * verbosa, mas sem credencial parada em lugar nenhum.
 *
 * Pré-requisitos que NÃO estão neste arquivo (ver README.md):
 *   - escopos `script.external_request` e `datastore` no appsscript.json
 *   - propriedade de script FIRESTORE_PROJETO
 */

var FS_HOST = 'https://firestore.googleapis.com/v1';

/**
 * Teto rígido de tentativas por chamada.
 *
 * Três, e não "até dar certo": o web app roda dentro do limite de 6 minutos por
 * execução e de 30 execuções simultâneas. Um laço aberto sob indisponibilidade
 * do Firestore consumiria as duas cotas e derrubaria o formulário inteiro para
 * quem nem estava com problema. Falhar rápido devolve o slot.
 */
var FS_MAX_TENTATIVAS = 3;
var FS_ESPERA_BASE_MS = 400;

/** Limite duro do `:commit`. Acima disso a API recusa o lote inteiro. */
var FS_LOTE_MAXIMO = 500;

/**
 * O que vale retentar.
 *
 * 429 (cota estourada) e 503 (indisponível) são transitórios por definição.
 * ABORTED chega como HTTP 409 e significa disputa por escrita — o mesmo evento
 * que no projeto sobre Sheets obriga o `LockService` a serializar tudo, só que
 * aqui o banco resolve e só pede para tentar de novo.
 *
 * Cuidado: 409 também é ALREADY_EXISTS, que NÃO deve ser retentado — é a
 * unicidade funcionando. Por isso a decisão olha o `status` do corpo, não só o
 * código HTTP.
 */
var FS_CODIGOS_RETENTAVEIS = [429, 503];
var FS_STATUS_RETENTAVEL = 'ABORTED';

// ---------------------------------------------------------------- Configuração

/**
 * ID do projeto Cloud onde o Firestore vive.
 *
 * Fica nas propriedades do script, nunca no código: o diretório `docs/` deste
 * repositório é servido pelo GitHub Pages, e id de projeto é o começo da trilha
 * para quem quiser sondar.
 */
function fsProjeto_() {
  var id = PropertiesService.getScriptProperties().getProperty('FIRESTORE_PROJETO');
  if (id) return String(id).trim();

  throw new Error(
    'Firestore não configurado. No editor do Apps Script: Configurações do projeto > ' +
    'Propriedades do script > adicionar FIRESTORE_PROJETO com o ID do projeto do ' +
    'Firebase (algo como unicesusc-cesutech-4f2a). Passo a passo em README.md.'
  );
}

/** Firestore aceita vários bancos por projeto; o primeiro chama-se `(default)`. */
function fsBanco_() {
  var banco = PropertiesService.getScriptProperties().getProperty('FIRESTORE_BANCO');
  return (banco && String(banco).trim()) || '(default)';
}

/** Raiz de todo caminho da API. Os `:métodos` são colados direto nela. */
function fsRaiz_() {
  return FS_HOST + '/' + fsRecurso_();
}

/**
 * O NOME DE RECURSO da coleção-raiz: `projects/.../databases/.../documents`.
 *
 * Parece a mesma coisa que `fsRaiz_()` sem o host, e é — mas a distinção não é
 * estética, e confundir as duas custou um erro em produção:
 *
 *   400 INVALID_ARGUMENT: Document name "https://firestore.googleapis.com/v1/
 *   projects/.../documents/alunos/c5a5..." lacks "projects" at index 0
 *
 * `UrlFetchApp` precisa de URL, com host. O CORPO de `:commit` precisa de nome
 * de recurso, sem host — o campo `name` de cada escrita e o alvo de cada
 * `delete` têm de começar literalmente em `projects/`. Como as duas coisas se
 * pareciam, o mesmo valor foi usado nos dois lugares e o lote inteiro era
 * recusado.
 *
 * O falso dos testes não pegava: ele extraía o id com `split('/documents/')[1]`,
 * que funciona igual com host ou sem.
 */
function fsRecurso_() {
  return 'projects/' + fsProjeto_() + '/databases/' + fsBanco_() + '/documents';
}

// ---------------------------------------------------------------- Transporte

/**
 * Única porta de saída para o Firestore. Todo o resto do arquivo passa por aqui.
 *
 * `muteHttpExceptions: true` é o que permite tratar 404 e 409 como resposta em
 * vez de exceção — sem isso, "documento não existe" e "documento já existe"
 * chegariam como o mesmo erro genérico do UrlFetchApp, sem corpo para inspecionar.
 */
/**
 * O token OAuth da execução, obtido UMA vez.
 *
 * Medição de 05/08/2026, com a instância quente, contra o mesmo banco:
 *
 *   rota sem Firestore ......  1,7 s
 *   1 chamada ao Firestore ... 18,1 s
 *   2 chamadas ............... 33,7 s
 *   3 chamadas ............... 30,2 s
 *   a mesma escrita no EDITOR . 0,375 s
 *
 * O custo cresce por CHAMADA, e some quando a execução é do editor. A única
 * coisa que muda entre os dois contextos e acontece a cada chamada é esta: o
 * web app roda como `USER_DEPLOYING` disparado por acesso ANÔNIMO, e pedir o
 * token nesse contexto não é a operação barata que é numa sessão interativa.
 *
 * Guardar numa variável de topo basta porque o escopo global do Apps Script
 * nasce zerado a cada execução — não há risco de um token vazar de uma
 * requisição para outra, nem de servir depois de expirar.
 *
 * SE ESTA HIPÓTESE ESTIVER ERRADA, o sintoma é claro: o tempo continua
 * crescendo por chamada mesmo com o token em cache. Aí o custo é do
 * `UrlFetchApp` em si nesse contexto, e a saída passa a ser reduzir o NÚMERO de
 * chamadas por requisição, não o preço de cada uma.
 */
var FS_TOKEN = null;

function fsToken_() {
  if (!FS_TOKEN) FS_TOKEN = ScriptApp.getOAuthToken();
  return FS_TOKEN;
}

function fsFetch_(metodo, caminho, corpo) {
  var opcoes = {
    method: String(metodo).toLowerCase(),
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + fsToken_() },
    muteHttpExceptions: true
  };
  if (corpo !== undefined && corpo !== null) opcoes.payload = JSON.stringify(corpo);

  var url = fsRaiz_() + caminho;
  var erro = null;

  // Laço fechado de propósito: no máximo FS_MAX_TENTATIVAS voltas, sempre.
  for (var tentativa = 1; tentativa <= FS_MAX_TENTATIVAS; tentativa++) {
    var resposta = UrlFetchApp.fetch(url, opcoes);
    var codigo = resposta.getResponseCode();
    var texto = resposta.getContentText();

    if (codigo >= 200 && codigo < 300) return texto ? JSON.parse(texto) : {};

    erro = fsErro_(codigo, texto, metodo, caminho);
    if (!fsValeRetentar_(erro)) throw erro;
    if (tentativa < FS_MAX_TENTATIVAS) Utilities.sleep(fsEspera_(tentativa));
  }

  throw erro;
}

/**
 * VÁRIAS requisições ao mesmo caminho, disparadas de uma vez só.
 *
 * Medição de 12/08/2026 contra o servidor real, na rota `?api=projetos`:
 *
 *   rota que não toca no banco ......  1,7 - 2,0 s   (piso da plataforma)
 *   ?api=projetos com cache quente ..  1,85 - 2,08 s
 *   ?api=projetos com cache frio ....  6,03 / 6,12 / 6,30 s
 *
 * Os quatro segundos de diferença eram SEQUÊNCIA, e não volume: seis projetos
 * custavam sete idas ao Firestore em fila indiana — a consulta da coleção mais
 * uma agregação por projeto —, cada uma esperando a anterior a ~550 ms. É o
 * segundo sintoma previsto no comentário de FS_TOKEN, logo acima: com o token
 * já em cache, o que sobra é o preço de CADA chamada neste contexto, e a saída
 * passa a ser reduzir o NÚMERO de chamadas por requisição.
 *
 * `UrlFetchApp.fetchAll` dispara todas juntas e devolve as respostas NA MESMA
 * ORDEM dos pedidos. É essa garantia de ordem que deixa casar resposta com
 * pedido sem carregar identificador nenhum de ida e volta.
 *
 * O que ele NÃO muda: cada requisição continua sendo cobrada pelo Firestore
 * exatamente como antes. O que cai é o tempo de parede, não o orçamento de
 * leitura de 08_Api.gs.
 *
 * O token é lido UMA vez, aqui, e o mesmo cabeçalho vai em todas as requisições
 * do lote. Pedi-lo por requisição é o erro que já custou 15 s por chamada neste
 * projeto — a história está no comentário de FS_TOKEN.
 *
 * ------------------------------------------------------------- Falha parcial
 *
 * Qualquer uma das N respostas pode vir com erro, e a decisão aqui é a MESMA de
 * `fsFetch_`: retentar o que vale retentar — só as que falharam, e não o lote
 * inteiro — e lançar o que não vale. Resposta de erro nunca vira valor de
 * retorno.
 *
 * A tentação é a outra: devolver o que deu certo e pôr zero no que falhou. Numa
 * contagem de vagas isso é o pior resultado possível — o projeto lotado
 * apareceria como "0 de 60 inscritos", que é o cartão mais convidativo da tela,
 * e o aluno só descobriria no envio. Lançar é, além do mais, o que já acontece
 * hoje: no laço sequencial uma agregação que falha derruba a rota inteira. A
 * tela que não carrega o aluno recarrega; a tela que mente sobre vaga, não.
 */
function fsFetchAll_(metodo, caminho, corpos) {
  if (!corpos || !corpos.length) return [];

  var url = fsRaiz_() + caminho;
  var autorizacao = 'Bearer ' + fsToken_();

  var saida = new Array(corpos.length);
  var pendentes = corpos.map(function (_corpo, indice) { return indice; });
  var erro = null;

  // Mesmo teto de `fsFetch_`, pelo mesmo motivo: o web app tem 6 minutos e 30
  // execuções simultâneas, e um laço aberto sob indisponibilidade consome as
  // duas cotas.
  for (var tentativa = 1; tentativa <= FS_MAX_TENTATIVAS && pendentes.length; tentativa++) {
    var respostas = UrlFetchApp.fetchAll(pendentes.map(function (indice) {
      return {
        url: url,
        method: String(metodo).toLowerCase(),
        contentType: 'application/json',
        headers: { Authorization: autorizacao },
        muteHttpExceptions: true,
        payload: JSON.stringify(corpos[indice])
      };
    }));

    var restantes = [];
    for (var i = 0; i < pendentes.length; i++) {
      // Se o `fetchAll` devolvesse fora de ordem ou a menos, isto estoura em vez
      // de casar resposta com o pedido errado. Erro alto é o resultado seguro.
      var codigo = respostas[i].getResponseCode();
      var texto = respostas[i].getContentText();

      if (codigo >= 200 && codigo < 300) {
        saida[pendentes[i]] = texto ? JSON.parse(texto) : {};
        continue;
      }

      erro = fsErro_(codigo, texto, metodo, caminho);
      if (!fsValeRetentar_(erro)) throw erro;
      restantes.push(pendentes[i]);
    }

    pendentes = restantes;
    if (pendentes.length && tentativa < FS_MAX_TENTATIVAS) Utilities.sleep(fsEspera_(tentativa));
  }

  if (pendentes.length) throw erro;
  return saida;
}

/**
 * Recuo exponencial com sorteio.
 *
 * O sorteio não é enfeite: no pico do auditório são dezenas de execuções
 * disparadas pelo mesmo clique coletivo. Recuo puramente exponencial faz todas
 * voltarem no mesmo milissegundo e reproduzirem a disputa que causou o erro.
 */
function fsEspera_(tentativa) {
  var base = FS_ESPERA_BASE_MS * Math.pow(2, tentativa - 1);
  return base + Math.floor(Math.random() * (FS_ESPERA_BASE_MS / 2));
}

/**
 * Traduz a resposta de erro da API em um Error legível.
 *
 * O corpo vem como {error:{code,status,message}}. `status` é o nome simbólico
 * (NOT_FOUND, ALREADY_EXISTS, ABORTED) e é ele que carrega a informação útil —
 * o código HTTP sozinho não distingue os dois sentidos de 409.
 */
function fsErro_(codigo, texto, metodo, caminho) {
  var detalhe = {};
  try {
    var corpo = JSON.parse(texto);
    detalhe = (corpo && corpo.error) || {};
  } catch (e) {
    // 502 de proxy e página de erro do Google voltam em HTML, não em JSON.
  }

  var status = detalhe.status || '';
  var mensagem = detalhe.message || String(texto || '').slice(0, 200);

  // A query string é cortada: `updateMask.fieldPaths` repetido enche o log sem
  // acrescentar nada ao diagnóstico.
  var erro = new Error(
    'Firestore ' + codigo + (status ? ' ' + status : '') + ' em ' +
    String(metodo).toUpperCase() + ' ' + String(caminho).split('?')[0] + ': ' + mensagem
  );
  erro.codigo = detalhe.code || codigo;
  erro.status = status;
  return erro;
}

/**
 * A mensagem de erro SEM o caminho do documento — o que pode sair para a tela
 * e para o log de execução.
 *
 * `fsErro_` (acima) monta a mensagem com o texto do Firestore, e esse texto
 * carrega o caminho inteiro: 'projects/<id do projeto>/databases/(default)/
 * documents/matriculados/9110001'. O caminho é duas coisas que não saem
 * daqui: a matrícula (o id do documento) e o id do projeto Cloud — o começo
 * da trilha para quem quiser sondar (ver `fsProjeto_`). Mora ao lado de quem
 * monta a mensagem, e não em quem a mostra, para todo ramo de erro que
 * responde ou loga ter a mesma régua (decisão D-27; a revisão, 05c, e o
 * Auditório, 13, passam por aqui). Aceita o Error ou só o texto.
 */
function semCaminhoDeDocumento_(erro) {
  var texto = (erro && erro.message) || erro || 'erro desconhecido';
  return String(texto).replace(/projects\/\S+/g, '(documento)');
}

function fsValeRetentar_(erro) {
  if (erro.status === FS_STATUS_RETENTAVEL) return true;
  return FS_CODIGOS_RETENTAVEIS.indexOf(Number(erro.codigo)) !== -1;
}

// ---------------------------------------------------------------- Conversores

/**
 * TUDO é gravado como `stringValue` nesta versão. É deliberado, e não preguiça.
 *
 * O Firestore tem tipos de verdade, mas o JSON do REST não os devolve fiéis:
 * `integerValue` volta como texto ('60', não 60, porque JSON não representa
 * int64 com segurança) e `timestampValue` volta em ISO-8601 com Z ('2026-08-05T
 * 19:00:00Z'), em UTC, não no fuso do app. Quem lê teria de saber o tipo de cada
 * campo para desfazer isso — que é exatamente o que `normalizarCelula_` faz no
 * Repo sobre Sheets do projeto atual, e exatamente o problema que se quer parar
 * de ter.
 *
 * O sistema inteiro já trata dado como texto: data em 'aaaa-mm-dd', matrícula
 * com zero à esquerda, horário livre, SIM/NAO em vez de booleano. Gravar assim
 * mantém o contrato existente e permite trazer as regras de negócio do projeto
 * atual sem remodelar o schema no mesmo movimento.
 *
 * Tipagem forte fica para depois, quando as regras já estiverem de pé. Aí vale a
 * pena, porque aí dá para usar range query e ordenação numérica.
 */
function fsValor_(v) {
  if (v === null || v === undefined) return { stringValue: '' };
  if (typeof v === 'object') return { stringValue: JSON.stringify(v) };
  return { stringValue: String(v) };
}

/**
 * Objeto do sistema -> documento do Firestore.
 * Chaves com `_` na frente são metadados de leitura (`_id`, `_nome`), o mesmo
 * papel do `_linha` que o Repo sobre Sheets acrescenta. Não voltam para o banco.
 */
function paraDocumento_(objeto) {
  var campos = {};
  Object.keys(objeto || {}).forEach(function (chave) {
    if (chave.charAt(0) === '_') return;
    campos[chave] = fsValor_(objeto[chave]);
  });
  return { fields: campos };
}

/**
 * Documento do Firestore -> objeto do sistema.
 * Devolve sempre texto, inclusive quando o campo veio tipado — é o mesmo
 * contrato de `lerTudo` no projeto atual, que garante que nada além de string
 * circula pelo `google.script.run`.
 *
 * `_versao` é o `updateTime` que o banco carimbou na última escrita do
 * documento — metadado de leitura como `_id` e `_nome` (prefixo `_`: não volta
 * para o banco, não entra em backup nem em máscara). Quem relê um documento e
 * quer gravar SÓ se ele ainda for aquele passa a versão de volta em
 * `atualizarEmLote`/`excluirEmLote`, e o `:commit` recusa se alguém escreveu
 * no meio tempo. Vem tanto de `ler` quanto de `listar` (o `:runQuery` devolve
 * o documento inteiro, com o carimbo).
 */
function paraObjeto_(documento) {
  if (!documento) return null;

  var obj = { _id: fsIdDe_(documento.name), _nome: documento.name || '', _versao: documento.updateTime || '' };
  var campos = documento.fields || {};
  Object.keys(campos).forEach(function (chave) {
    obj[chave] = fsTexto_(campos[chave]);
  });
  return obj;
}

/** Desembrulha um Value do Firestore para texto, seja qual for o tipo dele. */
function fsTexto_(valor) {
  if (!valor) return '';
  if (valor.stringValue !== undefined) return valor.stringValue;
  if (valor.nullValue !== undefined) return '';

  var tipo = Object.keys(valor)[0];
  if (tipo === undefined) return '';

  var bruto = valor[tipo];
  return (bruto !== null && typeof bruto === 'object') ? JSON.stringify(bruto) : String(bruto);
}

/** O nome de um documento é o caminho inteiro; o id é o último pedaço dele. */
function fsIdDe_(nome) {
  if (!nome) return '';
  var partes = String(nome).split('/');
  return partes[partes.length - 1];
}

function fsIdAleatorio_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 20);
}

// ---------------------------------------------------------------- Escrita

/**
 * Insere um documento. Com `idOpcional`, o id VIRA a chave única.
 *
 * É aqui que mora a diferença que interessa. No projeto sobre Sheets,
 * `gravarInscricao` varre a coluna `hash_dedup` inteira em JavaScript antes de
 * gravar — O(n) por inscrição, dentro do lock, e sujeito a duas execuções lerem
 * a mesma coluna antes de qualquer uma escrever. Passando `chaveDedup_(dados)`
 * como id do documento, quem garante a unicidade é o banco, numa operação
 * atômica.
 *
 * O endpoint `createDocument` carrega a precondição de não-existência no próprio
 * verbo: ele nunca sobrescreve, e devolve 409 ALREADY_EXISTS quando o id já está
 * ocupado. (A forma explícita da mesma coisa é `currentDocument:{exists:false}`
 * no `:commit`; aqui ela seria redundante.)
 *
 * Duplicata é resultado esperado, não falha: devolve `jaExistia` em vez de
 * lançar, do mesmo jeito que `gravarInscricao` devolve `duplicada`.
 */
function inserir(colecao, objeto, idOpcional) {
  var caminho = '/' + encodeURIComponent(colecao);
  if (idOpcional) caminho += '?documentId=' + encodeURIComponent(idOpcional);

  try {
    var documento = fsFetch_('post', caminho, paraDocumento_(objeto));
    return { criado: true, jaExistia: false, id: fsIdDe_(documento.name) };
  } catch (e) {
    if (e.status !== 'ALREADY_EXISTS') throw e;
    return { criado: false, jaExistia: true, id: idOpcional };
  }
}

/**
 * Atualiza campos de um documento existente.
 *
 * A `updateMask` não é opcional: sem ela o PATCH substitui o documento inteiro e
 * apaga silenciosamente todo campo que não veio no corpo. É o mesmo cuidado que
 * o Repo sobre Sheets toma ao reler a linha antes de gravar — só que aqui a
 * releitura não é necessária, porque a máscara diz ao banco o que preservar.
 */
function atualizar(colecao, id, objeto) {
  var documento = paraDocumento_(objeto);
  var chaves = Object.keys(documento.fields);
  if (!chaves.length) return 0;

  var mascara = chaves.map(function (k) {
    return 'updateMask.fieldPaths=' + encodeURIComponent(k);
  }).join('&');

  fsFetch_(
    'patch',
    '/' + encodeURIComponent(colecao) + '/' + encodeURIComponent(id) + '?' + mascara,
    documento
  );
  return chaves.length;
}

/** Remove um documento. Idempotente: apagar o que não existe responde 200. */
function excluir(colecao, id) {
  fsFetch_('delete', '/' + encodeURIComponent(colecao) + '/' + encodeURIComponent(id));
}

/**
 * Gravação em massa, em blocos de 500.
 *
 * 500 é limite da API, não escolha nossa: o `:commit` recusa o lote inteiro
 * acima disso. É o equivalente ao `setValues` em bloco da importação — uma
 * chamada por linha seria lenta demais para milhares de matriculados.
 *
 * `update` sem precondição é upsert: cria ou sobrescreve. É o que se quer numa
 * carga de lista oficial, onde reimportar o mesmo arquivo deve dar o mesmo
 * resultado. Quem precisa de unicidade usa `inserir`.
 */
function escreverEmLote(colecao, objetos) {
  if (!objetos || !objetos.length) return 0;

  // Nome de RECURSO, sem host — ver fsRecurso_(). URL aqui faz o :commit
  // recusar o lote inteiro com INVALID_ARGUMENT.
  var raiz = fsRecurso_();
  var gravados = 0;

  for (var inicio = 0; inicio < objetos.length; inicio += FS_LOTE_MAXIMO) {
    var bloco = objetos.slice(inicio, inicio + FS_LOTE_MAXIMO);
    var escritas = bloco.map(function (objeto) {
      var documento = paraDocumento_(objeto);
      documento.name = raiz + '/' + colecao + '/' + (objeto._id || fsIdAleatorio_());
      return { update: documento };
    });

    fsFetch_('post', ':commit', { writes: escritas });
    gravados += bloco.length;
  }
  return gravados;
}

/**
 * PATCH em massa, em blocos de 500 — o `atualizar` de muitos documentos numa
 * requisição, e com uma precondição que `atualizar` não tem.
 *
 * Nasceu para a revisão de divergências (05c_Revisao.gs): cancelar N alunos da
 * lista oficial é gravar QUATRO campos em N documentos que já existem. Os dois
 * caminhos que já havia servem mal, cada um por um motivo:
 *
 *   `atualizar` ........ um PATCH por documento — N requisições em fila, e um
 *                        PATCH no Firestore CRIA o documento que não existe: a
 *                        tela de revisão aberta desde antes de uma exclusão
 *                        gravaria um matriculado fantasma só com a marca;
 *   `escreverEmLote` ... um `:commit`, mas `update` SEM `updateMask` substitui o
 *                        documento inteiro — para não perder nome, CPF e
 *                        `raw_json` seria preciso reler cada documento e mandar
 *                        tudo de volta, e o que foi relido pode já estar velho
 *                        quando chega (uma reimportação no meio do caminho seria
 *                        sobrescrita pelo retrato de antes).
 *
 * Aqui cada escrita leva `updateMask.fieldPaths` = exatamente as chaves do
 * objeto (só elas mudam; o resto do documento fica como está, sem releitura) e
 * uma PRECONDIÇÃO, que depende do que o objeto traz:
 *
 *   com `_versao` ..... `currentDocument: { updateTime: _versao }` — o documento
 *                       tem de existir E estar no mesmo carimbo em que foi lido
 *                       (`paraObjeto_` o traz de toda leitura). Um documento
 *                       reescrito no meio tempo — a reimportação que trouxe a
 *                       pessoa de volta, um Editar — faz o `:commit` voltar 400
 *                       FAILED_PRECONDITION. `exists:true` não distingue "o
 *                       mesmo documento" de "o documento reescrito", e é essa a
 *                       diferença entre marcar quem sumiu e marcar quem acabou
 *                       de voltar;
 *   sem `_versao` ..... `currentDocument: { exists: true }` — se algum documento
 *                       do bloco sumiu, o `:commit` volta 404 NOT_FOUND.
 *
 * Nos dois casos o BLOCO INTEIRO não é aplicado. Não é limitação, é a garantia
 * que se quer: "alguém foi reimportado ou excluído enquanto a tela estava
 * aberta" é a resposta certa, e não meio lote gravado.
 *
 * `_id` é obrigatório em todo objeto e é conferido ANTES de qualquer requisição:
 * um patch sem endereço não tem o que atualizar, e sortear um id (como
 * `escreverEmLote` faz) só criaria uma escrita fadada ao 404 — ou, sem a
 * precondição, um fantasma. Objeto sem campo nenhum além dos metadados é pulado
 * (não há o que mandar), e não conta no total devolvido.
 *
 * Idempotente por construção — aplicar o mesmo patch duas vezes deixa o mesmo
 * documento —, o que é o que torna seguro passar pela retentativa de `fsFetch_`.
 * Como os irmãos, NÃO é atômico ENTRE blocos: cada bloco de 500 é tudo ou nada,
 * e o segundo pode falhar depois de o primeiro ter entrado. Devolve quantos
 * patches foram enviados.
 */
function atualizarEmLote(colecao, objetos) {
  if (!objetos || !objetos.length) return 0;

  // Nome de RECURSO, sem host — ver fsRecurso_().
  var raiz = fsRecurso_();
  var escritas = [];

  objetos.forEach(function (objeto) {
    if (!objeto || !objeto._id) {
      throw new Error('atualizarEmLote: todo objeto precisa de _id — um patch sem endereço não tem o que atualizar');
    }
    var documento = paraDocumento_(objeto);
    var chaves = Object.keys(documento.fields);
    if (!chaves.length) return;

    documento.name = raiz + '/' + colecao + '/' + objeto._id;
    escritas.push({
      update: documento,
      updateMask: { fieldPaths: chaves },
      currentDocument: fsPrecondicao_(objeto)
    });
  });

  for (var inicio = 0; inicio < escritas.length; inicio += FS_LOTE_MAXIMO) {
    fsFetch_('post', ':commit', { writes: escritas.slice(inicio, inicio + FS_LOTE_MAXIMO) });
  }
  return escritas.length;
}

/**
 * A precondição de uma escrita em lote, a partir do que o objeto traz.
 *
 * Com `_versao` (o `updateTime` lido por `paraObjeto_`), o banco só aplica se o
 * documento ainda estiver naquele carimbo; sem ela, só exige que exista. É o
 * mesmo par para o patch e para o delete.
 */
function fsPrecondicao_(objeto) {
  var versao = String((objeto && objeto._versao) || '');
  return versao ? { updateTime: versao } : { exists: true };
}

/**
 * Remoção em massa, em blocos de 500 — o espelho de `escreverEmLote`.
 *
 * Existe por um motivo só, e é bom que seja o único: `expurgarLote`
 * (05_Importacao.gs) precisa apagar milhares de matriculados de uma lista velha,
 * e `excluir()` um a um seriam 2.500 requisições, muito além dos 6 minutos de
 * execução. Em blocos são 5.
 *
 * Cada item é um id (texto) OU um objeto `{ _id, _versao }` lido do banco. Com
 * a versão, o delete leva `currentDocument: { updateTime }` e o banco recusa o
 * bloco inteiro (400 FAILED_PRECONDITION) se o documento foi reescrito depois
 * da leitura — a revisão (05c_Revisao.gs) apaga o matriculado que RELEU, e não
 * o que uma reimportação acabou de gravar no mesmo id. Sem versão o delete é o
 * de sempre: sem precondição, apagar o que não existe é 200.
 *
 * Como o `escreverEmLote`, NÃO é atômico entre blocos: o terceiro pode falhar
 * depois de dois terem apagado. Aqui isso é aceitável de um jeito que não era na
 * importação — apagar é idempotente, e repetir a operação termina o serviço sem
 * efeito colateral. Por isso devolve quantos SAÍRAM, e quem chama relata o
 * número real em vez de prometer o pedido.
 */
function excluirEmLote(colecao, ids) {
  if (!ids || !ids.length) return 0;

  // Nome de RECURSO, sem host — ver fsRecurso_().
  var raiz = fsRecurso_();
  var apagados = 0;

  for (var inicio = 0; inicio < ids.length; inicio += FS_LOTE_MAXIMO) {
    var bloco = ids.slice(inicio, inicio + FS_LOTE_MAXIMO);
    var escritas = bloco.map(function (item) {
      var objeto = (item && typeof item === 'object') ? item : { _id: item };
      if (!objeto._id) throw new Error('excluirEmLote: todo item precisa de id');
      var escrita = { delete: raiz + '/' + colecao + '/' + objeto._id };
      if (objeto._versao) escrita.currentDocument = { updateTime: String(objeto._versao) };
      return escrita;
    });

    fsFetch_('post', ':commit', { writes: escritas });
    apagados += bloco.length;
  }
  return apagados;
}

/**
 * VÁRIOS verbos, VÁRIAS coleções, UM `:commit`: tudo entra ou nada entra.
 *
 * É a única escrita multidocumento ATÔMICA do sistema, e existe por um par que
 * não pode ser dividido: a troca de projeto do aluno (item 4) copia a inscrição
 * antiga para `inscricoes_anuladas`, APAGA a antiga em `inscricoes` e CRIA a
 * nova — três escritas, duas coleções. Partir isso em requisições separadas não
 * é resolvido pelo lock: o lock serializa a decisão, mas não impede a execução
 * de morrer entre duas escritas, e cada meio-estado possível é um desastre
 * diferente (o aluno sem projeto nenhum, o aluno em dois, a vaga do antigo
 * presa). O `:commit` é o que garante o EFEITO inteiro contra qualquer falha.
 *
 * Nenhuma das primitivas em lote acima serve, e é bom dizer por quê antes que
 * alguém tente de novo: `escreverEmLote` é update-only e sem precondição
 * nenhuma; `atualizarEmLote` é PATCH de UMA coleção e sempre com precondição;
 * `excluirEmLote` é delete-only. Nenhuma delas MISTURA verbos, e nenhuma
 * atravessa coleções na mesma chamada. Marcar a antiga como anulada no próprio
 * documento, em vez de apagá-la, também está fechado: `contarInscritos_`
 * (09_Projetos.gs) conta por igualdade em `projeto_id` só, e um segundo filtro
 * pediria índice composto.
 *
 * Os três verbos, e a precondição de cada um:
 *
 *   { criar:  { colecao, id, objeto } } ........ update + `exists:false` — o
 *                 mesmo 409 de `inserir`, na forma explícita: o `createDocument`
 *                 que `inserir` usa é um endpoint próprio, e dentro de um
 *                 `:commit` a precondição tem de vir escrita;
 *   { gravar: { colecao, id, objeto, versao } } . update sem `updateMask`, isto
 *                 é, o documento INTEIRO: upsert, cria ou substitui. Com
 *                 `versao`, leva `currentDocument: { updateTime }` e o banco só
 *                 aplica se o documento ainda estiver naquele carimbo; SEM
 *                 `versao`, vai sem precondição nenhuma — nem `exists:true`;
 *   { apagar: { colecao, id, versao } } ........ delete, com a mesma escolha de
 *                 precondição. Sem `versao` é idempotente: apagar o que não
 *                 existe é 200.
 *
 * POR QUE A VERSÃO É PARÂMETRO E NÃO `fsPrecondicao_(objeto)`. Esta é a
 * primeira primitiva que escreve em mais de uma COLEÇÃO na mesma chamada, e
 * `_versao` é carimbo de UM documento de UMA coleção. A cópia da troca é um
 * objeto lido de `inscricoes` e gravado em `inscricoes_anuladas` sob o mesmo
 * id: `fsPrecondicao_` mandaria o `updateTime` do documento ERRADO, e a troca
 * morreria em FAILED_PRECONDITION; e o fallback `exists:true` dela quebraria
 * esse mesmo upsert na primeira troca de todas, quando a cópia ainda não
 * existe. Por isso quem chama diz explicitamente qual carimbo vale, e
 * `fsPrecondicao_` fica intocada (a revisão de divergências depende dela).
 *
 * E é de propósito que o `apagar` da troca vá SEM `versao`, mesmo com a versão
 * de graça na mão: se a coordenação anulou a inscrição antiga entre a consulta
 * e o commit, um delete versionado derrubaria o commit INTEIRO e o aluno
 * ficaria sem nada — a antiga já na quarentena e a nova nunca criada.
 *
 * As três guardas, todas antes de qualquer requisição:
 *
 *   não FATIA em blocos de 500 — lança acima de `FS_LOTE_MAXIMO`. Os irmãos
 *   fatiam porque são idempotentes e ninguém prometeu atomicidade entre blocos;
 *   aqui fatiar transformaria "um commit" em dois, e a promessa cairia junto
 *   com a conta de idas dentro do lock (são 3, e não podem virar 4);
 *
 *   no máximo UM `criar` por chamada — o 409 não diz QUAL escrita falhou, e a
 *   mensagem que diria é justamente a que sai daqui sem o caminho do documento.
 *   Com um `criar` só, `{ jaExistia: true }` é inequívoco;
 *
 *   duas escritas no MESMO documento são recusadas — o Firestore recusa o
 *   commit inteiro ('Document cannot be written more than once per
 *   transaction'), e é mais barato e mais claro recusar aqui, com o nome do
 *   defeito, do que gastar a ida para receber um INVALID_ARGUMENT genérico.
 *
 * Retorno simétrico a `inserir`, porque a unicidade é a mesma: ALREADY_EXISTS
 * é resultado esperado e volta como `{ jaExistia: true }` sem lançar; qualquer
 * outra recusa (NOT_FOUND, FAILED_PRECONDITION) lança. 429, 503 e ABORTED já
 * são retentados por `fsFetch_`, e isto aqui não muda nada disso — o que ele
 * traz de volta é um caso REGISTRADO E NÃO RESOLVIDO: se o 503 vier na resposta
 * de um commit que o banco JÁ aplicou, a retentativa recebe ALREADY_EXISTS e
 * esta função responde `jaExistia`. Quem chama trata como "já estava lá", que é
 * a leitura certa do estado do banco, ainda que a primeira resposta tenha sido
 * perdida.
 *
 * A MEDIR contra o banco de verdade (20_Prova.gs, ao lado de
 * `provaAtualizarEmLote`): os status exatos das precondições DENTRO de um
 * `:commit` misto. O falso dos testes imita `exists:false` com o documento no
 * lugar como 409 ALREADY_EXISTS, `exists:true` em documento ausente como 404
 * NOT_FOUND e `updateTime` divergente como 400 FAILED_PRECONDITION. Se o banco
 * divergir, corrigem-se o falso e esta função — nunca o contrário.
 *
 * Devolve `{ aplicado, jaExistia, id, escritas }`. `id` é o do `criar`, quando
 * houve um — e como há no máximo um, ele é o único que o 409 pode ter recusado.
 */
function escreverAtomico(escritas) {
  if (!escritas || !escritas.length) return { aplicado: false, jaExistia: false, id: '', escritas: 0 };

  if (escritas.length > FS_LOTE_MAXIMO) {
    throw new Error(
      'escreverAtomico: ' + escritas.length + ' escritas passam do limite de ' + FS_LOTE_MAXIMO +
      ' de um :commit, e fatiar quebraria a atomicidade que esta função promete'
    );
  }

  // Nome de RECURSO, sem host — ver fsRecurso_().
  var raiz = fsRecurso_();
  var enderecos = {};
  var idCriado = '';
  var writes = [];

  escritas.forEach(function (pedido) {
    var criar = pedido && pedido.criar;
    var gravar = pedido && pedido.gravar;
    var apagar = pedido && pedido.apagar;
    var alvo = criar || gravar || apagar;

    if (!alvo || (criar && gravar) || (criar && apagar) || (gravar && apagar)) {
      throw new Error('escreverAtomico: cada escrita é UM de { criar }, { gravar } ou { apagar }');
    }
    if (!alvo.colecao || !alvo.id) {
      throw new Error('escreverAtomico: toda escrita precisa de colecao e id — escrita sem endereço não tem alvo');
    }

    // O endereço, e não o id: duas coleções podem ter o mesmo id de propósito, e
    // é exatamente o caso da troca (a cópia da quarentena guarda o id da
    // inscrição). As mensagens das guardas nomeiam a coleção e não o id, porque
    // o id de uma inscrição é o PROTOCOLO do aluno e isto aqui pode virar log.
    var endereco = alvo.colecao + '/' + alvo.id;
    if (enderecos[endereco]) {
      throw new Error(
        'escreverAtomico: duas escritas no mesmo documento (' + alvo.colecao +
        ') na mesma chamada — o Firestore recusa o commit inteiro'
      );
    }
    enderecos[endereco] = true;

    if (apagar) {
      var remocao = { delete: raiz + '/' + apagar.colecao + '/' + apagar.id };
      if (apagar.versao) remocao.currentDocument = { updateTime: String(apagar.versao) };
      writes.push(remocao);
      return;
    }

    if (criar && idCriado) {
      throw new Error('escreverAtomico: no máximo um `criar` por chamada — com dois, ALREADY_EXISTS não diz qual documento já existia');
    }

    var documento = paraDocumento_(alvo.objeto);
    documento.name = raiz + '/' + alvo.colecao + '/' + alvo.id;

    var escrita = { update: documento };
    if (criar) {
      idCriado = criar.id;
      escrita.currentDocument = { exists: false };
    } else if (gravar.versao) {
      escrita.currentDocument = { updateTime: String(gravar.versao) };
    }
    writes.push(escrita);
  });

  try {
    fsFetch_('post', ':commit', { writes: writes });
  } catch (e) {
    if (e.status === 'ALREADY_EXISTS') {
      return { aplicado: false, jaExistia: true, id: idCriado, escritas: writes.length };
    }
    // A mensagem do Firestore carrega o caminho inteiro do documento recusado —
    // o id do projeto Cloud e, numa inscrição, o protocolo do aluno. Quem chama
    // responde e loga, então a régua D-27 vale já na saída daqui
    // (`semCaminhoDeDocumento_`). `status` e `codigo` seguem intactos: é por
    // eles que se decide, nunca pelo texto.
    var limpo = new Error(semCaminhoDeDocumento_(e));
    limpo.status = e.status;
    limpo.codigo = e.codigo;
    throw limpo;
  }

  return { aplicado: true, jaExistia: false, id: idCriado, escritas: writes.length };
}

// ---------------------------------------------------------------- Leitura

/** Lê um documento pelo id. Devolve null quando não existe. */
function ler(colecao, id) {
  try {
    return paraObjeto_(
      fsFetch_('get', '/' + encodeURIComponent(colecao) + '/' + encodeURIComponent(id))
    );
  } catch (e) {
    if (e.status === 'NOT_FOUND') return null;
    throw e;
  }
}

/**
 * Consulta uma coleção. Equivale ao `lerTudo` do projeto atual, mas sem trazer
 * tudo.
 *
 * opcoes: { campo, valor, ordenarPor, direcao, limite, cursor }
 * Devolve { itens, cursor } — o cursor volta preenchido só quando a página veio
 * cheia, ou seja, quando pode haver próxima.
 *
 * Armadilha operacional: filtro por um campo somado a ordenação por OUTRO exige
 * índice composto. O Firestore recusa a consulta com FAILED_PRECONDITION e a
 * mensagem de erro traz o link que cria o índice em um clique. Vale conhecer
 * antes de descobrir isso no dia do evento.
 */
function listar(colecao, opcoes) {
  opcoes = opcoes || {};

  // Sem ordenação explícita o Firestore usa o id do documento; declarar isso
  // deixa a paginação por cursor funcionar do mesmo jeito nos dois casos.
  var campoOrdem = opcoes.ordenarPor || '__name__';

  var consulta = {
    from: [{ collectionId: colecao }],
    orderBy: [{
      field: { fieldPath: campoOrdem },
      direction: String(opcoes.direcao || 'ASC').toUpperCase() === 'DESC' ? 'DESCENDING' : 'ASCENDING'
    }]
  };

  if (opcoes.campo) {
    consulta.where = {
      fieldFilter: {
        field: { fieldPath: opcoes.campo },
        op: 'EQUAL',
        value: fsValor_(opcoes.valor)
      }
    };
  }
  if (opcoes.limite) consulta.limit = opcoes.limite;

  // `before: false` significa "comece DEPOIS deste valor" — paginação por
  // cursor, não por offset. Offset faz o banco varrer e cobrar as linhas
  // puladas; o cursor salta direto no índice, e o custo da página 50 é igual
  // ao da página 1.
  if (opcoes.cursor) consulta.startAt = { values: opcoes.cursor, before: false };

  var resposta = fsFetch_('post', ':runQuery', { structuredQuery: consulta });

  var itens = [];
  var ultimo = null;
  (resposta || []).forEach(function (linha) {
    // A resposta é um stream: entradas sem `document` são só sinal de progresso
    // da varredura, e ignorá-las é obrigatório.
    if (!linha || !linha.document) return;
    ultimo = linha.document;
    itens.push(paraObjeto_(linha.document));
  });

  var paginaCheia = Boolean(opcoes.limite) && itens.length === opcoes.limite;
  return {
    itens: itens,
    cursor: (ultimo && paginaCheia) ? fsCursor_(ultimo, campoOrdem) : null
  };
}

/**
 * Monta o cursor da próxima página a partir do último documento desta.
 * Os valores do cursor têm de casar, na ordem, com os campos do `orderBy`.
 */
function fsCursor_(documento, campoOrdem) {
  if (campoOrdem === '__name__') return [{ referenceValue: documento.name }];
  var campos = documento.fields || {};
  return [campos[campoOrdem] || { nullValue: null }];
}

/**
 * Conta documentos sem trazê-los.
 *
 * No projeto sobre Sheets isto custa uma leitura de coluna inteira em
 * `contarInscritosPorProjeto_`, dentro do lock. Aqui a agregação roda no
 * servidor e devolve um número; o tráfego não cresce com o total de inscritos.
 *
 * Repare no `fsTexto_` embaixo: a contagem chega como `integerValue: "37"`, em
 * texto. É a demonstração viva do motivo de o conversor gravar tudo como string.
 */
function contar(colecao, filtro) {
  return fsTotalContado_(fsFetch_('post', ':runAggregationQuery', consultaDeContagem_(colecao, filtro)));
}

/**
 * A mesma contagem de `contar`, para VÁRIOS filtros, em uma ida só.
 *
 * pedidos: [{ colecao, campo, valor }] — devolve [n1, n2, ...] NA MESMA ORDEM.
 *
 * Existe porque contar N coisas custava N idas em fila indiana, e essa fila era
 * o tempo de carregar a lista de projetos (ver `fsFetchAll_`). Cada pedido
 * continua sendo uma agregação de UM filtro de igualdade — o índice automático
 * que o Firestore já mantém —, então nada aqui pede passo de console.
 *
 * NÃO substitui `contar`: quem conta uma coisa só continua chamando ela, e é o
 * caso de `reservarVaga` (09_Projetos.gs), que conta dentro do lock e não pode
 * ter o desenho mexido por causa de tela nenhuma. As duas passam pelo MESMO
 * montador de consulta e pelo mesmo leitor de resposta, logo abaixo, para não
 * existir uma segunda maneira de contar — que seria uma segunda verdade sobre
 * vagas.
 */
function contarVarios(pedidos) {
  if (!pedidos || !pedidos.length) return [];

  var corpos = pedidos.map(function (pedido) {
    return consultaDeContagem_(pedido.colecao, pedido);
  });

  return fsFetchAll_('post', ':runAggregationQuery', corpos).map(fsTotalContado_);
}

/** O corpo de um `:runAggregationQuery` que conta com no máximo um filtro. */
function consultaDeContagem_(colecao, filtro) {
  var consulta = { from: [{ collectionId: colecao }] };

  if (filtro && filtro.campo) {
    consulta.where = {
      fieldFilter: {
        field: { fieldPath: filtro.campo },
        op: 'EQUAL',
        value: fsValor_(filtro.valor)
      }
    };
  }

  return {
    structuredAggregationQuery: {
      structuredQuery: consulta,
      aggregations: [{ alias: 'total', count: {} }]
    }
  };
}

/** O número dentro da resposta da agregação — que chega em TEXTO, ver acima. */
function fsTotalContado_(resposta) {
  var total = 0;
  (resposta || []).forEach(function (linha) {
    var campos = linha && linha.result && linha.result.aggregateFields;
    if (campos && campos.total) total = Number(fsTexto_(campos.total));
  });
  return total;
}

/**
 * Nomes das coleções que existem no banco.
 * Só a primeira página (100). É o bastante para inspeção e limpeza manual, e
 * evita um laço de paginação que ninguém mais usaria.
 */
function fsColecoes_() {
  var resposta = fsFetch_('post', ':listCollectionIds', { pageSize: 100 });
  return (resposta && resposta.collectionIds) || [];
}
