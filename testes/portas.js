/**
 * portas.js — por onde se entra no servidor, e o que impede uma porta nova de
 * nascer sem ninguém ver.
 *
 * O servidor é um web app do Apps Script implantado `executeAs: USER_DEPLOYING` e
 * `access: ANYONE_ANONYMOUS` (appsscript.json): tudo o que ele executa, executa
 * com a conta de quem implantou. Por isso a pergunta deste arquivo não é "a
 * função X confere o token?" — essa é de `invasao.js` —, e sim uma anterior:
 * QUE CAMINHOS EXISTEM até as funções. As respostas que este arquivo segura:
 *
 *   1. NENHUMA RESPOSTA É PÁGINA. Página do HtmlService leva junto a ponte
 *      `google.script.run`, que fala com as funções do projeto por fora do
 *      roteador (ver "Nenhuma resposta é página", em 08_Api.gs). Não há
 *      HtmlService em nenhum `.gs`; apps-script/ só tem os `.gs` do primeiro
 *      nível e o manifesto, e o .claspignore da raiz faz o clasp enviar só isso;
 *      o manifesto só abre o web app (sem execução pela API, sem complemento);
 *      o `doGet` sem rota responde JSON — sem nada de dentro do sistema; e o
 *      repositório manda publicar atualizando a implantação do config.js, e
 *      nunca criando outra, que deixaria a antiga no ar com o código de antes —
 *      com a conta que já implanta, que é a conta com que o web app roda, e
 *      com o commit enviado na descrição da versão, que é a base com que a
 *      publicação seguinte compara o código do projeto.
 *   2. PRIVADO POR PADRÃO. No Apps Script, função global cujo nome não termina
 *      em `_` é PÚBLICA: aparece no seletor do editor, pode virar gatilho, e é o
 *      que qualquer ponte de fora alcança. Por isso a superfície pública é uma
 *      LISTA FECHADA, escrita aqui com a categoria de cada nome, e todo o resto
 *      tem o `_` no fim. Função nova nasce privada; quem a quiser pública escreve
 *      a linha abaixo — que é o momento em que se pensa se ela deveria ser. A
 *      lista é conferida pela árvore e EM EXECUÇÃO (o que ficou no objeto global
 *      depois de carregar tudo), o topo dos `.gs` só tem as formas que as duas
 *      leem, e o objeto global só é tocado num lugar.
 *   3. O NOME DO FIO NÃO É O NOME DA FUNÇÃO. O painel manda `fn: 'listarAlunos'`
 *      e quem roda é `listarAlunos_`. Os dois despachos (`funcoesDoPainel_` e
 *      `rotaDeLogin_`, 08_Api.gs) só levam a função privada, e sempre pela mesma
 *      regra — o nome do fio com o `_` no fim —, que é a regra em que os outros
 *      testes se apoiam quando precisam chegar à função a partir do nome. E o
 *      que um ANÔNIMO alcança — as ações do `doPost`, as rotas de leitura e os
 *      ramos do login — é lista fechada também, com as funções que cada um
 *      chama: a regra do nome sozinha deixaria passar uma rota nova para uma
 *      função privada perigosa. O `catch` dessas entradas só anota o erro na
 *      trilha, com um nome fixo.
 *   4. AS PÚBLICAS QUE SOBRAM SÃO CASCAS FINAS. Cada ferramenta de editor e cada
 *      gatilho é a guarda, na primeira linha, e a chamada à implementação privada
 *      — nada mais. E nenhum código do projeto chama a casca: chama a privada.
 *      Uma guarda de editor no meio do caminho do gatilho derrubaria o backup da
 *      madrugada; uma chamada interna à casca seria uma guarda que ninguém pediu.
 *   5. AS GUARDAS FUNCIONAM. `exigirDono_` só passa a execução em que a conta que
 *      pediu é a que roda, e nunca dentro de uma requisição ao web app — o que
 *      sobra, na prática, é o editor —, e `exigirGatilhoOuDono_` passa, além
 *      dela, o acionador que este projeto tem de verdade — também o instalado
 *      por outra conta, que só está na lista dela, e é com ela que ele roda. As
 *      duas recusam quando não conseguem perguntar, e recusar não escreve nada
 *      no banco. A lista por conta vale também para quem instala: os três
 *      instaladores não veem o acionador de outra conta, e o que imprimem no
 *      editor manda conferir a tela Acionadores.
 *
 * COMO OS `.gs` SÃO LIDOS: por ÁRVORE SINTÁTICA, e não por expressão regular. O
 * nome que importa aqui aparece também em comentário (o cabeçalho de 08_Api.gs
 * explica por que o HtmlService saiu) e em texto; uma regex não distingue os
 * três, e o teste ou gritaria à toa ou se calaria quando devia gritar. O parser é
 * o acorn que vem DENTRO do próprio Node (é o que o REPL usa), alcançado com
 * `--expose-internals` — é assim que o `npm test` roda este arquivo, e é o que
 * mantém a suíte sem dependência nenhuma para instalar.
 *
 * A LISTA DE ARQUIVOS É A PASTA, e nunca uma lista escrita aqui: um `.gs` novo
 * entra na varredura no dia em que nasce, que é justamente o dia em que ninguém
 * lembraria de acrescentá-lo. E a pasta é lida INTEIRA, com as subpastas, e com
 * os `.js` junto dos `.gs`: é o que o clasp envia como código.
 *
 * Uso:  node --expose-internals testes/portas.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { teste, grupo, igual, verdadeiro, resultado, criarAmbiente } = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');

const ENDERECO_DO_SITE = 'https://cesutech.github.io/';
const ENDERECO_DO_PAINEL = 'https://cesutech.github.io/painel/';

/**
 * A SUPERFÍCIE PÚBLICA, inteira. Nome que não termina em `_` e não está aqui não
 * pode existir em `.gs` nenhum.
 *
 *   web      as duas entradas HTTP do web app — e só elas falam com a internet;
 *   gatilho  o que um acionador instalado chama PELO NOME (os GATILHO_* do código,
 *            e a faxina de temporários, que o próprio comentário dela manda
 *            instalar à mão na tela de acionadores). Trocar um destes nomes
 *            quebra, calado, um gatilho que já existe no projeto;
 *   editor   o que a documentação do próprio código manda rodar à mão no editor
 *            do Apps Script: preparar o ambiente, instalar gatilho, socorro de
 *            acesso, conferência de backup, diagnósticos e as provas.
 */
const PUBLICAS = {
  doGet: 'web',
  doPost: 'web',

  reconciliarAutomatico: 'gatilho',
  aquecerWebApp: 'gatilho',
  fazerBackup: 'gatilho',
  limparTemporariosAntigos: 'gatilho',

  setup: 'editor',
  instalarGatilhoDiario: 'editor',
  instalarGatilhoAquecimento: 'editor',
  instalarGatilhoBackup: 'editor',
  conferirBackup: 'editor',
  diagnosticarImportacao: 'editor',
  migrarDisciplinas: 'editor',
  liberarMeuAcesso: 'editor',
  liberarAcesso: 'editor',
  invalidarSessoes: 'editor',
  provaConfigELog: 'editor',
  provaConectar: 'editor',
  provaUnicidade: 'editor',
  provaOrdenacaoNaoCorrompe: 'editor',
  provaTipoForte: 'editor',
  provaVazao: 'editor',
  provaAtualizarEmLote: 'editor',
  provaCommitMisto: 'editor',
  provaLimpar: 'editor',
  diagnostico: 'editor',
  autorizar: 'editor'
};

/** Os nomes de uma categoria da lista fechada. */
function daCategoria(categoria) {
  return Object.keys(PUBLICAS).filter((nome) => PUBLICAS[nome] === categoria);
}

// ------------------------------------------------------------ O parser

function carregarAcorn() {
  try {
    return require('internal/deps/acorn/acorn/dist/acorn');
  } catch (e) {
    throw new Error('Este arquivo lê os .gs com o acorn que vem dentro do Node, e ele só ' +
      'aparece com a opção --expose-internals. Rode `node --expose-internals ' +
      'testes/portas.js` (é como o `npm test` roda). Detalhe: ' + e.message);
  }
}

const acorn = carregarAcorn();

/**
 * Tudo o que há em apps-script/, em QUALQUER nível: caminhos relativos à pasta,
 * com `/` no fim para subpasta.
 *
 * Recursivo porque o clasp é: o push dele (clasp 3.3.0, o do package-lock)
 * percorre as subpastas e, sem um .claspignore, envia `.gs`, `.js`, `.ts` e
 * `.html` de qualquer uma delas. Uma varredura só do primeiro nível não veria o
 * arquivo que o clasp mandaria.
 */
function conteudoDaPasta(pasta, prefixo) {
  const saida = [];
  fs.readdirSync(pasta, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)))
    .forEach((d) => {
      const rel = (prefixo || '') + d.name;
      if (d.isDirectory()) {
        saida.push(rel + '/');
        conteudoDaPasta(path.join(pasta, d.name), rel + '/').forEach((x) => saida.push(x));
      } else {
        saida.push(rel);
      }
    });
  return saida;
}

const CONTEUDO = conteudoDaPasta(PASTA_GS);

/**
 * Todo arquivo da pasta que o Apps Script receberia como CÓDIGO (`.gs` ou `.js`,
 * em qualquer nível), já lido e com a árvore montada. Hoje são só os `.gs` do
 * primeiro nível — e o teste do grupo 1 cobra isso —, mas a varredura não supõe:
 * um `.js` que aparecesse passaria por todas as conferências deste arquivo, e não
 * só pela que diz que ele não devia estar ali.
 */
function lerGs() {
  return CONTEUDO
    .filter((rel) => /\.(gs|js)$/i.test(rel))
    .map((nome) => {
      const texto = fs.readFileSync(path.join(PASTA_GS, nome), 'utf8');
      const arvore = acorn.parse(texto, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
      return { nome, texto, arvore };
    });
}

const GS = lerGs();

/** Os filhos de um nó da árvore, na ordem em que aparecem no código. */
function filhos(no) {
  const saida = [];
  Object.keys(no).forEach((chave) => {
    if (chave === 'loc' || chave === 'type' || chave === 'start' || chave === 'end') return;
    const valor = no[chave];
    if (Array.isArray(valor)) valor.forEach((v) => { if (v && typeof v.type === 'string') saida.push(v); });
    else if (valor && typeof valor.type === 'string') saida.push(valor);
  });
  return saida;
}

/** Visita a árvore inteira; `visita(no, pai)` é chamada para todo nó. */
function andar(no, visita, pai) {
  visita(no, pai || null);
  filhos(no).forEach((f) => andar(f, visita, no));
}

function ehFuncao(no) {
  return !!no && (no.type === 'FunctionExpression' || no.type === 'ArrowFunctionExpression');
}

/**
 * As funções GLOBAIS de todos os `.gs` que a ÁRVORE enxerga: { nome, arquivo,
 * linha, no }.
 *
 * São as três formas de declarar uma função no nível do programa:
 * `function nome() {}`, `var|let|const nome = function/=>` e a atribuição solta
 * `nome = function () {}`, que no modo não estrito cria a global do mesmo jeito.
 * Só a primeira existe hoje.
 *
 * Elas NÃO são todos os jeitos de uma função global nascer — um apelido
 * (`var x = y_`), um `.bind`, uma função devolvida por outra, uma declaração
 * dentro de um bloco, `globalThis.x = ...`. Quem fecha esses é o grupo 2: a
 * conferência em execução (o que ficou de fato no objeto global depois de
 * carregar tudo), a forma do nível do programa (só função, `var` e atribuição a
 * propriedade) e o objeto global tocado num lugar só.
 *
 * `no` é a FUNÇÃO (a declaração ou a expressão atribuída), para quem precisa do
 * corpo.
 */
function funcoesGlobais() {
  const saida = [];
  GS.forEach((a) => {
    a.arvore.body.forEach((st) => {
      if (st.type === 'FunctionDeclaration') {
        saida.push({ nome: st.id.name, arquivo: a.nome, linha: st.loc.start.line, no: st });
      }
      if (st.type === 'VariableDeclaration') {
        st.declarations.forEach((d) => {
          if (d.id.type === 'Identifier' && ehFuncao(d.init)) {
            saida.push({ nome: d.id.name, arquivo: a.nome, linha: d.loc.start.line, no: d.init });
          }
        });
      }
      if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' &&
          st.expression.left.type === 'Identifier' && ehFuncao(st.expression.right)) {
        saida.push({ nome: st.expression.left.name, arquivo: a.nome, linha: st.loc.start.line, no: st.expression.right });
      }
    });
  });
  return saida;
}

/** Só as públicas: nome sem o `_` no fim. */
function publicasDeVerdade() {
  return funcoesGlobais().filter((f) => !/_$/.test(f.nome));
}

/** Um ambiente com TODOS os `.gs`, na ordem da pasta, e o ContentService falso. */
function ambienteCompleto(opcoes) {
  const amb = criarAmbiente(Object.assign({ arquivos: GS.map((a) => a.nome) }, opcoes || {}));
  amb.api.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput(texto) {
      const saida = {
        texto: String(texto),
        mime: '',
        setMimeType(m) { saida.mime = m; return saida; },
        getContent() { return saida.texto; }
      };
      return saida;
    }
  };
  return amb;
}

/**
 * Quem implantou o web app — a conta com que ele roda. A parte antes do `@` é de
 * propósito uma que não aparece em frase nenhuma: o teste da resposta sem rota
 * procura por ela sozinha também.
 */
const DONO = 'conta.que.implantou@exemplo.com';

/** O editor do Apps Script: quem pede a execução é quem a roda. */
function noEditor(opcoes) {
  return ambienteCompleto(Object.assign({ usuario: DONO, usuarioEfetivo: DONO }, opcoes || {}));
}

/** O web app anônimo: ninguém visível, e a execução com a conta de quem implantou. */
function anonimo(opcoes) {
  return ambienteCompleto(Object.assign({ usuario: '', usuarioEfetivo: DONO }, opcoes || {}));
}

// ======================================== 1. Nenhuma resposta é página

grupo('1. nenhuma resposta é página — e o HtmlService não volta');

teste('a varredura enxerga os .gs — senão os testes abaixo não provam nada', () => {
  // Uma pasta vazia, um filtro errado ou um parser que não leu nada fariam todo
  // "não existe X" deste arquivo passar sozinho.
  verdadeiro(GS.length >= 20, 'só ' + GS.length + ' .gs lidos');
  verdadeiro(GS.some((a) => a.nome === '08_Api.gs'), '08_Api.gs não foi lido');
  GS.forEach((a) => verdadeiro(a.arvore.body.length > 0, a.nome + ' veio vazio'));
});

teste('apps-script/ só tem os .gs do primeiro nível e o manifesto — e nada mais para o clasp enviar', () => {
  // A pasta inteira, em qualquer nível. Um `.html` traria de volta a página; um
  // `.js` ou um `.gs` numa subpasta seria código que o clasp envia e que, até
  // aqui, nenhuma varredura lia (um `clasp pull` grava o código como `.js`); uma
  // subpasta é onde os dois se escondem. O servidor é isto, e só isto.
  //
  // Mutação que derruba: um `.html`, um `.js` ou um `.ts` em apps-script/; um
  // `.gs` numa subpasta; qualquer subpasta.
  const fora = CONTEUDO.filter((rel) => !(/^[^/]+\.gs$/.test(rel) || rel === 'appsscript.json'));
  igual(fora, [], 'o clasp também enviaria isto — o servidor é só os .gs do primeiro nível de ' +
    'apps-script/ e o appsscript.json');
  verdadeiro(CONTEUDO.indexOf('appsscript.json') !== -1, 'o manifesto sumiu de apps-script/');
});

teste('o manifesto só abre o web app — sem execução pela API, sem complemento', () => {
  // Cada chave de entrada do appsscript.json é um caminho até as funções
  // públicas que não passa pelo `doGet` nem pelo `doPost`: `executionApi` deixa
  // chamar qualquer uma pelo nome, de fora; `addOns`, `chat` e as de
  // complemento dão gatilhos e telas próprias. A guarda das ferramentas de
  // editor (`exigirDono_`) conta com nenhuma delas existir.
  //
  // Mutação que derruba: qualquer chave nova no manifesto — `executionApi`
  // inclusive.
  const manifesto = JSON.parse(fs.readFileSync(path.join(PASTA_GS, 'appsscript.json'), 'utf8'));
  igual(Object.keys(manifesto).sort(),
    ['dependencies', 'exceptionLogging', 'oauthScopes', 'runtimeVersion', 'timeZone', 'webapp']);
  igual(manifesto.executionApi, undefined, 'o manifesto abriu a execução pela API');
});

teste('o .claspignore da raiz faz o clasp enviar só os .gs do primeiro nível e o manifesto', () => {
  // O teste acima segura o repositório; este segura o push, que é feito de uma
  // pasta local — onde pode haver um arquivo que nenhum teste viu ainda. Sem o
  // .claspignore, o clasp usa os padrões de fábrica e envia `.js`, `.ts` e
  // `.html` de qualquer subpasta.
  //
  // É um .gitignore às avessas: ignora tudo e depois DESignora o manifesto e os
  // `.gs` do primeiro nível. Os dois pares existem porque o clasp 3.3.0 compara
  // caminhos de dois jeitos — relativos a apps-script/ no push, e à raiz do
  // projeto no `--watch` —, e sem o segundo par o `--watch` deixaria de ver as
  // mudanças. O conjunto enviado foi conferido contra a coleta do próprio clasp
  // (micromatch e fdir, as bibliotecas dele), sem rede: os 21 `.gs` e o
  // manifesto, e nenhum `.js`, `.ts`, `.html` ou arquivo de subpasta.
  //
  // O clasp não tem comentário nesse arquivo (toda linha não vazia é padrão), e é
  // por isso que a explicação mora aqui. Mutação que derruba: apagar o arquivo,
  // ou afrouxar qualquer linha.
  const arquivo = path.join(__dirname, '..', '.claspignore');
  verdadeiro(fs.existsSync(arquivo), 'o .claspignore sumiu da raiz do repositório');
  igual(fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).filter((l) => l.length > 0),
    ['**/**', '!appsscript.json', '!*.gs', '!apps-script/appsscript.json', '!apps-script/*.gs']);
});

/** A seção "Publicar o servidor" do README, inteira: do título até o próximo `## `. */
function secaoPublicar() {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const inicio = readme.indexOf('## Publicar o servidor');
  verdadeiro(inicio !== -1, 'o README perdeu a seção "Publicar o servidor"');
  return readme.slice(inicio, readme.indexOf('\n## ', inicio + 1));
}

/**
 * Os passos numerados de uma seção do README, pelo número: cada um com as suas
 * linhas de continuação — as recuadas e as em branco — até a próxima linha que
 * começa na margem. É o que deixa um teste cobrar uma frase NO passo em que ela
 * vale, e não em qualquer lugar da seção.
 */
function passosDaSecao(secao) {
  const passos = {};
  let atual = null;
  secao.split('\n').forEach((linha) => {
    const numero = /^(\d+)\. /.exec(linha);
    if (numero) {
      atual = numero[1];
      passos[atual] = linha;
    } else if (atual !== null && (linha === '' || /^\s/.test(linha))) {
      passos[atual] += '\n' + linha;
    } else {
      atual = null;
    }
  });
  return passos;
}

teste('publicar é atualizar a implantação do config.js — e é isso que o repositório manda fazer', () => {
  // Tudo o que este arquivo segura vale para o código ENVIADO, e só chega ao ar
  // pela implantação que o site chama. Uma implantação nova ganha outra URL, e a
  // antiga continua respondendo com o código de antes; um envio para o projeto
  // errado "dá certo" sem mudar nada no ar. O roteiro mora no README ("Publicar
  // o servidor"), e o cabeçalho do config.js — o arquivo que quem publica abre —
  // aponta para ele.
  //
  // O roteiro é o da publicação de verdade: a suíte antes, o código do projeto
  // comparado com o git, o envio com `--force` só depois disso — o clasp 3.3.0
  // pula o envio sem ele e sai sem erro —, a saída do envio conferida, a Nova
  // versão pelo editor ou pelo clasp, e o merge no mesmo dia. A contagem do envio
  // sai da pasta: um `.gs` novo sem o README acompanhar derruba o teste.
  //
  // Mutação que derruba: o config.js voltar a mandar colar a URL de uma "Nova
  // implantação"; o README perder a conferência do destino (`list-deployments`),
  // a Nova versão na mesma implantação, o arquivamento das outras, o `npm test`,
  // a comparação com o git, o `--force`, a conferência do `Pushed N files` e do
  // `Skipping push.`, o caminho pelo clasp ou o merge no mesmo dia.
  const raiz = path.join(__dirname, '..');
  const config = fs.readFileSync(path.join(raiz, 'docs', 'assets', 'config.js'), 'utf8');
  const cabecalho = config.slice(0, config.indexOf('*/'));
  verdadeiro(/Gerenciar implantações/.test(cabecalho) && /Nova versão/.test(cabecalho),
    'o cabeçalho do config.js não diz para atualizar a implantação que já existe');
  verdadeiro(/nunca usar Implantar › Nova implantação/.test(cabecalho),
    'o cabeçalho do config.js não proíbe a implantação nova');
  verdadeiro(/arquive todas as outras/.test(cabecalho), 'o cabeçalho do config.js não manda arquivar as outras');
  igual(/Cole aqui a URL/.test(cabecalho), false, 'o config.js voltou a mandar colar a URL de uma implantação nova');
  // A receita do cabeçalho é o caminho do editor do passo 7, e leva o que ele
  // leva: a conta que já implanta e a descrição com o commit.
  const corrido = cabecalho.replace(/\n \* ?/g, ' ');
  verdadeiro(corrido.indexOf('com a conta que já implanta (README, passo 1)') !== -1,
    'o cabeçalho do config.js ensina a Nova versão sem dizer com que conta');
  verdadeiro(corrido.indexOf('Nova versão, Descrição: `Cesutech vN <sha>`') !== -1,
    'o cabeçalho do config.js ensina a Nova versão sem o commit na descrição');

  const secao = secaoPublicar();
  const quantosGs = CONTEUDO.filter((rel) => /^[^/]+\.gs$/.test(rel)).length;
  ['show-authorized-user', 'list-deployments', '**pare**', 'Nova versão', '**Nunca** use Implantar › Nova implantação',
    '**arquive todas as outras**', 'janela anônima', 'corrija para a frente', '`npm test`', 'pull`',
    'push --force', '`Pushed ' + (quantosGs + 1) + ' files`', 'os ' + quantosGs + ' `.gs`', '`Skipping push.`',
    'create-version', 'update-deployment', '-V N', 'mesmo dia'].forEach((trecho) => {
    verdadeiro(secao.indexOf(trecho) !== -1, 'a seção do README perdeu: ' + trecho);
  });
});

teste('publicar é com a conta que já implanta, porque o web app roda com ela — e o README diz qual é e como entrar com ela', () => {
  // O manifesto implanta o web app `executeAs: USER_DEPLOYING`: o `/exec` roda
  // com a conta de quem implantou, e é com ela que o servidor pega o token do
  // banco (`ScriptApp.getOAuthToken`, 02_Repo.gs), manda o link de entrada
  // (`MailApp`, 07b_LinkPorEmail.gs) e acha as pastas dos banners e dos
  // temporários no Drive — o `drive.file` só alcança o que a própria conta
  // criou, e `drivePasta_` (02b_Drive.gs), sem alcance, cria outra pasta e
  // guarda o id dela no lugar. O projeto tem mais de uma conta com acesso, e
  // fazer o passo 7 — pelo clasp ou pelo editor — com outra troca tudo isso de
  // uma vez, sem erro nenhum na hora.
  //
  // Quem publica pela primeira vez vê `Not logged in.`, e o passo 1 diz o que
  // fazer e com que conta: a dona dos acionadores que só a conta que implanta
  // tem. Os nomes citados têm de ser gatilhos da lista fechada — renomear um
  // deixaria o README mandando procurar o que não existe na tela Acionadores.
  //
  // Mutação que derruba: o passo 1 sem os gatilhos que reconhecem a conta, sem
  // a tela Acionadores, sem o `executeAs`, sem o `Not logged in.`, o
  // `login --no-localhost`, a API ligada, o **pare** ou o `logout`; um gatilho
  // citado que saiu da lista fechada; o manifesto com outro `executeAs`; o
  // caminho do editor, no passo 7, sem a conta do passo 1.
  const manifesto = JSON.parse(fs.readFileSync(path.join(PASTA_GS, 'appsscript.json'), 'utf8'));
  igual(manifesto.webapp.executeAs, 'USER_DEPLOYING',
    'o web app deixou de rodar como quem implanta, e o passo 1 do README explica uma regra que mudou');

  const passos = passosDaSecao(secaoPublicar());
  verdadeiro(passos[1] !== undefined && passos[7] !== undefined, 'o README perdeu o passo 1 ou o passo 7');

  ['fazerBackup', 'aquecerWebApp'].forEach((gatilho) => {
    igual(PUBLICAS[gatilho], 'gatilho', gatilho + ' saiu da lista de gatilhos, e o README reconhece a conta por ele');
    verdadeiro(passos[1].indexOf('`' + gatilho + '`') !== -1, 'o passo 1 não reconhece a conta pelo ' + gatilho);
  });
  ['tela Acionadores', '`executeAs: USER_DEPLOYING`', 'passo 7', '`Not logged in.`',
    '`npx @google/clasp@3.3.0 login --no-localhost`', 'https://script.google.com/home/usersettings', '**pare**',
    '`npx @google/clasp@3.3.0 logout`', 'tem de ser a que implanta hoje'].forEach((trecho) => {
    verdadeiro(passos[1].indexOf(trecho) !== -1, 'o passo 1 do README perdeu: ' + trecho);
  });
  // O acionador da reconciliação é de OUTRA conta, e reconhecer a conta que
  // implanta por ele mandaria publicar justamente com a errada.
  igual(passos[1].indexOf('reconciliarAutomatico'), -1,
    'o passo 1 reconhece a conta que implanta por um acionador que é de outra conta');

  const inicioEditor = passos[7].indexOf('- no editor');
  verdadeiro(inicioEditor !== -1, 'o passo 7 perdeu o caminho do editor');
  const editor = passos[7].slice(inicioEditor, passos[7].indexOf('- pelo clasp', inicioEditor));
  verdadeiro(editor.indexOf('conta do passo 1') !== -1, 'o caminho do editor, no passo 7, não diz com que conta');
});

teste('cada versão leva na descrição o commit enviado — e é contra ele que a publicação seguinte compara o código', () => {
  // O passo 5 compara o código que o projeto tem com o `apps-script/` de um
  // commit, e só protege alguma coisa se for o commit do último envio. A ponta
  // da `main` não é: a publicação vem antes do merge (passo 13), e a branch
  // anda depois do envio. Contra o commit errado, o passo 5 manda parar por
  // nada ou cala o que devia segurar. O `list-deployments` só mostra o id, o
  // `@N` e a descrição: por isso a descrição leva o commit, nos dois comandos
  // do clasp e no caminho do editor, e o passo 8 confere que ela chegou. As
  // versões até a 21 foram publicadas sem ele, e o README diz como reconhecê-las.
  // E o commit tem de continuar na `main` depois do merge: squash e rebase o
  // trocam por outro, e o passo 13 manda mesclar com merge commit.
  //
  // Mutação que derruba: o passo 5 voltar à `main`, ou a um `<commit>` que
  // ninguém gravou; qualquer descrição `Cesutech vN` sem o `<sha>`; o passo 4
  // sem o checkout limpo ou sem o `rev-parse`; o caminho do editor sem a
  // descrição; o passo 8 sem ela; o passo 5 sem as versões até a 21, sem a
  // versão de número mais alto, sem a retomada ou sem o `pull --versionNumber`;
  // o passo 13 sem o merge commit.
  const secao = secaoPublicar();
  const passos = passosDaSecao(secao);
  [4, 5, 7, 8].forEach((n) => verdadeiro(passos[n] !== undefined, 'o README perdeu o passo ' + n));

  const descricoes = secao.match(/Cesutech vN[^"`]*/g) || [];
  verdadeiro(descricoes.length > 0, 'o README não diz mais que descrição a versão leva');
  descricoes.forEach((d) => igual(d, 'Cesutech vN <sha>', 'uma descrição de versão sem o commit'));

  ['`git status --short apps-script`', '`git rev-parse --short HEAD`', '`<sha>`'].forEach((trecho) => {
    verdadeiro(passos[4].indexOf(trecho) !== -1, 'o passo 4 do README perdeu: ' + trecho);
  });

  ['create-version "Cesutech vN <sha>"', '-V N -d "Cesutech vN <sha>"'].forEach((trecho) => {
    verdadeiro(passos[7].indexOf(trecho) !== -1, 'o passo 7 do README perdeu: ' + trecho);
  });
  const inicioEditor = passos[7].indexOf('- no editor');
  verdadeiro(inicioEditor !== -1, 'o passo 7 perdeu o caminho do editor');
  const editor = passos[7].slice(inicioEditor, passos[7].indexOf('- pelo clasp', inicioEditor));
  verdadeiro(editor.indexOf('`Cesutech vN <sha>`') !== -1, 'o caminho do editor, no passo 7, não grava o commit na descrição');

  verdadeiro(passos[8].indexOf('`@N - Cesutech vN <sha>`') !== -1, 'o passo 8 não confere a descrição com o commit');

  ['archive <sha> apps-script', '`@N - Cesutech vN <sha>`', 'passo 2', 'até a 21',
    '`npx @google/clasp@3.3.0 list-versions`', '`npx @google/clasp@3.3.0 pull --versionNumber N`',
    'do commit do último envio', 'versão de número mais alto', '`N - Cesutech vN <sha>`',
    'retome do passo 7'].forEach((trecho) => {
    verdadeiro(passos[5].indexOf(trecho) !== -1, 'o passo 5 do README perdeu: ' + trecho);
  });
  igual(/archive <commit>/.test(passos[5]), false, 'o passo 5 voltou a comparar com um commit que ninguém gravou');
  igual(/é o da `main`/.test(passos[5]), false, 'o passo 5 voltou a comparar com a main');

  verdadeiro(passos[13] !== undefined, 'o README perdeu o passo 13');
  verdadeiro(passos[13].indexOf('**merge commit**') !== -1,
    'o passo 13 não manda mesclar com merge commit, e num squash o <sha> gravado sumiria da main');
});

teste('nenhum .gs fala com o HtmlService — nem pelo nome, nem por texto', () => {
  // O identificador cobre o uso direto (`HtmlService.createTemplateFromFile`); o
  // texto cobre o desvio (`globalThis['HtmlService']`). Comentário pode citar o
  // nome à vontade — é o que explica por que ele saiu.
  const usos = [];
  GS.forEach((a) => {
    andar(a.arvore, (no) => {
      const porNome = no.type === 'Identifier' && no.name === 'HtmlService';
      const porTexto = (no.type === 'Literal' && typeof no.value === 'string' && no.value.indexOf('HtmlService') !== -1) ||
        (no.type === 'TemplateElement' && String(no.value.cooked).indexOf('HtmlService') !== -1);
      if (porNome || porTexto) usos.push(a.nome + ':' + no.loc.start.line);
    });
  });
  igual(usos, [], 'HtmlService de volta ao servidor');
});

teste('o doGet sem rota responde JSON, e nada de dentro do sistema', () => {
  // A resposta é conferida INTEIRA: um campo a mais "por conveniência" — a
  // versão, o nome do app, o e-mail de quem implantou, o id do projeto — seria
  // informação entregue a quem só abriu um endereço.
  //
  // O HtmlService deste sandbox é uma armadilha: qualquer toque nele fica
  // anotado e estoura. Um `doGet` que voltasse a montar página cairia aqui
  // mesmo que alguém tivesse esquecido a varredura acima.
  //
  // O ambiente é o do web app de verdade: ninguém visível, e a execução com a
  // conta de quem implantou — que é o e-mail que o teste de baixo procura.
  const amb = anonimo();
  const toques = [];
  amb.api.HtmlService = new Proxy({}, {
    get(_alvo, propriedade) {
      toques.push(String(propriedade));
      throw new Error('HtmlService tocado: ' + String(propriedade));
    }
  });

  [undefined, {}, { parameter: {} }, { parameter: { p: 'admin' } }, { parameter: { p: 'cadastro' } }]
    .forEach((evento) => {
      const saida = amb.api.doGet(evento);
      igual(saida.mime, 'application/json', JSON.stringify(evento));

      const corpo = JSON.parse(saida.getContent());
      igual(Object.keys(corpo).sort(), ['mensagem', 'ok', 'painel', 'site'], JSON.stringify(evento));
      igual(corpo.ok, true);
      igual(corpo.site, ENDERECO_DO_SITE);
      igual(corpo.painel, ENDERECO_DO_PAINEL);
      verdadeiro(/é a API/.test(corpo.mensagem), corpo.mensagem);
    });

  igual(toques, [], 'o doGet tocou no HtmlService');
  igual(amb.falso.requisicoes.length, 0, 'o endereço sem rota foi ao banco');
});

teste('a resposta sem rota não carrega versão, nome do app, e-mail nem identificador', () => {
  // O teste acima confere as chaves; este confere o CONTEÚDO contra o que o
  // servidor tem de interno, para que um valor interno não entre escondido
  // dentro da frase.
  //
  // O ambiente é o do web app anônimo: o efetivo é a conta de quem implantou
  // (DONO), e é ela que uma frase "Responsável: ..." vazaria. Num ambiente com o
  // efetivo vazio, essa frase sairia sem e-mail nenhum e passaria aqui. A parte
  // antes do `@` é procurada sozinha, para o e-mail cortado não passar.
  const amb = anonimo();
  const texto = amb.api.doGet({ parameter: {} }).getContent();

  [amb.api.APP.versao, amb.api.APP.nome, DONO, DONO.split('@')[0], 'gestao@exemplo.com',
    'projeto-de-teste', amb.api.ScriptApp.getScriptId(), 'script.google.com']
    .filter(Boolean)
    .forEach((interno) => {
      igual(texto.indexOf(interno), -1, 'a resposta sem rota contou "' + interno + '"');
    });
  verdadeiro(!/@/.test(texto), 'a resposta sem rota traz um e-mail: ' + texto);
});

// ================================================ 2. Privado por padrão

grupo('2. privado por padrão — a superfície pública é a lista fechada, e só ela');

teste('a varredura acha as funções globais — e são centenas', () => {
  // Um coletor que não visse nada faria o teste seguinte comparar vazio com a
  // lista e falhar por um motivo errado; um que visse pouco esconderia a função
  // pública que nasceu no arquivo que ele pulou.
  const todas = funcoesGlobais();
  verdadeiro(todas.length > 400, 'só ' + todas.length + ' funções globais nos .gs');
  verdadeiro(todas.some((f) => f.nome === 'rotaDoPainel_'), 'rotaDoPainel_ não foi vista');
});

teste('as funções públicas são EXATAMENTE as da lista fechada', () => {
  // Mutação que derruba: tirar o `_` de qualquer função (publicá-la), criar uma
  // função nova sem `_`, ou apagar uma das públicas sem tirar a linha daqui.
  const publicas = publicasDeVerdade();
  const nomes = publicas.map((f) => f.nome).sort();
  const esperadas = Object.keys(PUBLICAS).sort();

  const sobrando = publicas.filter((f) => !PUBLICAS[f.nome]).map((f) => f.nome + ' (' + f.arquivo + ':' + f.linha + ')');
  const faltando = esperadas.filter((n) => nomes.indexOf(n) === -1);

  igual(sobrando, [], 'função pública fora da lista fechada — ponha o `_` no fim, ou escreva a linha em PUBLICAS com a categoria');
  igual(faltando, [], 'a lista fechada cita função que não existe mais');
  igual(nomes, esperadas);
});

teste('nenhum nome global é declarado duas vezes', () => {
  // Os .gs dividem um escopo só, e a última declaração carregada vence em
  // silêncio. Uma casca pública declarada de novo noutro arquivo trocaria a
  // casca guardada por outra sem guarda nenhuma.
  const vistos = {};
  const repetidos = [];
  funcoesGlobais().forEach((f) => {
    if (vistos[f.nome]) repetidos.push(f.nome + ' (' + vistos[f.nome] + ' e ' + f.arquivo + ')');
    else vistos[f.nome] = f.arquivo;
  });
  igual(repetidos, []);
});

teste('carregados os .gs, as funções globais sem `_` são EXATAMENTE a lista fechada — em execução', () => {
  // A árvore enxerga três formas de declarar; a execução enxerga o que de fato
  // ficou no objeto global depois de carregar tudo, seja qual for a forma: um
  // apelido (`var x = y_`), um `.bind`, uma função devolvida por outra, uma
  // declaração de dentro de um bloco, uma atribuição aninhada. É por esse objeto
  // que o Apps Script procura uma função pelo nome.
  //
  // O que o próprio arnês põe no ambiente — os serviços falsos e os construtores
  // de sempre — é descontado: é o ambiente sem `.gs` nenhum.
  //
  // Mutação que derruba: qualquer uma das formas acima, com nome sem `_`.
  const doArnes = new Set(Object.getOwnPropertyNames(criarAmbiente({ arquivos: [] }).api)
    .concat(['ContentService']));
  const amb = ambienteCompleto();
  const emExecucao = Object.getOwnPropertyNames(amb.api)
    .filter((nome) => !doArnes.has(nome) && !/_$/.test(nome) && typeof amb.api[nome] === 'function')
    .sort();
  igual(emExecucao.filter((nome) => !PUBLICAS[nome]), [],
    'função pública no objeto global fora da lista fechada — ponha o `_` no fim do nome');
  igual(emExecucao, Object.keys(PUBLICAS).sort());
  // O contrapeso: o objeto global tem as privadas também. Sem isto, um ambiente
  // que não carregasse nada passaria pela comparação acima só se a lista
  // estivesse vazia — e ela não está —, mas um que carregasse só parte, sim.
  verdadeiro(typeof amb.api.rotaDoPainel_ === 'function' && typeof amb.api.backupColecoes_ === 'function',
    'o ambiente não carregou os .gs inteiros');
});

teste('o nível do programa só declara — função, `var` e atribuição a propriedade', () => {
  // É o que os .gs têm hoje, e é o que faz das duas conferências acima a lista
  // inteira: com só isto no topo, todo nome global é propriedade do objeto
  // global (que a conferência em execução lê) e nasce numa forma que a árvore
  // lê. `let`, `const` e `class` no topo criam nome global que NÃO é propriedade
  // do objeto global; um bloco, um `if` ou um `try` no topo são onde uma
  // declaração se esconde da árvore.
  //
  // Mutação que derruba: `let`/`const`/`class` no topo; um bloco, `if`, `try` ou
  // laço no topo; uma chamada solta no topo.
  const ruins = [];
  GS.forEach((a) => {
    a.arvore.body.forEach((st) => {
      const ok = st.type === 'FunctionDeclaration' ||
        (st.type === 'VariableDeclaration' && st.kind === 'var') ||
        (st.type === 'ExpressionStatement' && typeof st.directive === 'string') ||
        (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' &&
          st.expression.left.type === 'MemberExpression');
      if (!ok) ruins.push(a.nome + ':' + st.loc.start.line + ' ' + st.type + (st.kind ? ' ' + st.kind : ''));
    });
  });
  igual(ruins, [], 'instrução no nível do programa fora das formas que as conferências leem');
});

/** O nó é o objeto global por um dos dois nomes dele: `globalThis` ou `this`? */
function ehObjetoGlobal(no) {
  return !!no && (no.type === 'ThisExpression' || (no.type === 'Identifier' && no.name === 'globalThis'));
}

/** O identificador está ali como NOME DE PROPRIEDADE (`x.nome`, `{ nome: 1 }`), e não como valor? */
function ehNomeDePropriedade(no, pai) {
  if (!pai) return false;
  if (pai.type === 'MemberExpression' && pai.property === no && !pai.computed) return true;
  return (pai.type === 'Property' || pai.type === 'MethodDefinition' || pai.type === 'PropertyDefinition') &&
    pai.key === no && !pai.computed && !pai.shorthand;
}

teste('o objeto global só é tocado num lugar — a leitura das *_COLECAO, no backup', () => {
  // `globalThis.x = ...` e `this.x = ...` criam função global por um caminho que
  // nenhuma conferência por nome lê; `globalThis['nome']()` chama uma casca sem
  // escrever o nome dela; `globalThis['Html' + 'Service']` chega a um serviço do
  // mesmo jeito. No modo não estrito, `this` numa função chamada solta É o objeto
  // global — e por isso ele entra na conta onde quer que apareça.
  //
  // O único uso que existe, e o único aceito, é a declaração de `escopo` em
  // `backupColecoes_` (14_Backup.gs): ela lê as constantes `*_COLECAO` para o
  // backup descobrir as coleções sozinho. E `eval` e `Function`, que transformam
  // texto em código, não aparecem em lugar nenhum. Um `this` legítimo que surgir
  // um dia (um construtor, um método) tem de ser acrescentado aqui, com o motivo.
  //
  // Mutação que derruba: `globalThis` ou `this` fora daquela declaração; `eval`;
  // `Function`.
  const permitido = aGlobal('backupColecoes_');
  const declaracao = permitido.no.body.body.filter((st) => st.type === 'VariableDeclaration' &&
    st.declarations.some((d) => d.id.type === 'Identifier' && d.id.name === 'escopo'))[0];
  verdadeiro(declaracao, 'a leitura do objeto global sumiu de backupColecoes_ — o backup descobre as coleções por ela');
  const naDeclaracao = (a, no) => a.nome === permitido.arquivo &&
    no.start >= declaracao.start && no.end <= declaracao.end;

  const toques = [];
  GS.forEach((a) => {
    andar(a.arvore, (no, pai) => {
      if (no.type === 'Identifier' && ehNomeDePropriedade(no, pai)) return;
      const global = ehObjetoGlobal(no);
      const textoViraCodigo = no.type === 'Identifier' && (no.name === 'eval' || no.name === 'Function');
      if (textoViraCodigo || (global && !naDeclaracao(a, no))) {
        toques.push(a.nome + ':' + no.loc.start.line + ' ' + (no.type === 'ThisExpression' ? 'this' : no.name));
      }
    });
  });
  igual(toques, [], 'o objeto global tocado fora da leitura das *_COLECAO');
});

// ====================================== 3. O nome do fio e a função

grupo('3. o nome do fio não é o nome da função — e os despachos só levam à privada');

/** Os `if (fn === 'x') return y_(...)` de `rotaDeLogin_`: [{ fio, funcao }]. */
function despachoDoLogin() {
  const alvo = funcoesGlobais().filter((f) => f.nome === 'rotaDeLogin_')[0];
  verdadeiro(alvo, 'rotaDeLogin_ sumiu');
  const saida = [];
  andar(alvo.no, (no) => {
    if (no.type !== 'IfStatement') return;
    const t = no.test;
    if (t.type !== 'BinaryExpression' || t.operator !== '===' || t.left.type !== 'Identifier' ||
        t.left.name !== 'fn' || t.right.type !== 'Literal') return;
    const ret = no.consequent.type === 'ReturnStatement' ? no.consequent : null;
    const chamada = ret && ret.argument && ret.argument.type === 'CallExpression' ? ret.argument : null;
    saida.push({ fio: t.right.value, funcao: chamada && chamada.callee.type === 'Identifier' ? chamada.callee.name : null });
  });
  return saida;
}

teste('o despacho do painel leva cada nome do fio à função de mesmo nome com `_`', () => {
  // Mutação que derruba: apontar uma entrada da lista branca para uma função
  // pública, ou para uma de outro nome.
  const amb = ambienteCompleto();
  const funcoes = amb.api.funcoesDoPainel_();
  const nomes = Object.keys(funcoes);
  verdadeiro(nomes.length >= 40, 'a lista branca encolheu: ' + nomes.length);

  const fora = nomes.filter((fio) => !funcoes[fio] || funcoes[fio].name !== fio + '_' ||
    amb.api[fio + '_'] !== funcoes[fio]);
  igual(fora, [], 'entrada da lista branca que não leva a nome + _');
});

teste('o despacho do login também — e cada `if` chama uma função privada', () => {
  // `rotaDeLogin_` é um `if` por nome, de propósito (ver o comentário dela); a
  // regra é a mesma do painel, conferida pela árvore.
  const ramos = despachoDoLogin();
  verdadeiro(ramos.length >= 7, 'só ' + ramos.length + ' ramos em rotaDeLogin_');
  igual(ramos.filter((r) => r.funcao !== r.fio + '_').map((r) => r.fio), [],
    'ramo de login que não leva a nome + _');
});

teste('nenhum nome do fio é o nome de uma função pública', () => {
  // A lista fechada e os despachos não se cruzam: o que o navegador alcança é
  // sempre privado, e o que é público (gatilho, ferramenta de editor) nunca é
  // alcançável pelo navegador.
  const amb = ambienteCompleto();
  const fios = Object.keys(amb.api.funcoesDoPainel_()).concat(despachoDoLogin().map((r) => r.fio));
  igual(fios.filter((fio) => PUBLICAS[fio]), []);
});

// ============================== 3b. O que um anônimo alcança, fechado

grupo('3b. o que um anônimo alcança é lista fechada — ações, rotas e login, com o que cada um chama');

/*
 * O painel tem token, lista branca, nível e os testes de invasão por trás de
 * cada função (invasao.js). As entradas ANÔNIMAS não têm nada disso: as ações do
 * `doPost`, as rotas de leitura do `doGet` e os ramos de `rotaDeLogin_` são o
 * que qualquer pessoa na internet alcança sem prova nenhuma. A regra do nome
 * (fio + `_`) não as segura — uma rota nova para uma função privada perigosa
 * cumpre essa regra sozinha. Por isso elas são escritas aqui, uma por uma, com
 * as funções do projeto que cada uma alcança direto. Rota nova, ação nova, ramo
 * novo ou uma função a mais dentro de uma delas passam por esta linha — que é o
 * momento em que se pensa se um anônimo deveria chegar lá.
 */

/** As ações do `doPost`, e as funções do projeto que cada `case` alcança. */
const ACOES_DO_POST = {
  inscricao: ['respostaJson_', 'submeterInscricao_'],
  login: ['respostaJson_', 'rotaDeLogin_'],
  painel: ['respostaJson_', 'rotaDoPainel_'],
  '(default)': ['respostaJson_']
};

/** As rotas de leitura do `doGet` (`?api=`), e as funções do projeto que cada uma alcança. */
const ROTAS_DE_LEITURA = {
  ping: ['respostaJson_'],
  config: ['dadosFormularioPublico_', 'rotaCacheada_'],
  projetos: ['contarOcupacaoNaLista_', 'listarProjetos_', 'rotaCacheada_'],
  matricula: ['conferirMatricula_', 'respostaJson_']
};

/** Os ramos de `rotaDeLogin_`: o nome do fio, e a chamada inteira que ele faz. */
const RAMOS_DO_LOGIN = {
  modoDeAcesso: 'modoDeAcesso_()',
  sessaoAtiva: 'sessaoAtiva_(corpo.token)',
  sair: 'sair_(corpo.token)',
  autenticar: 'autenticar_()',
  entrarComGoogle: 'entrarComGoogle_(corpo.idToken)',
  pedirLinkDeAcesso: 'pedirLinkDeAcesso_(corpo.email)',
  entrarComLink: 'entrarComLink_(corpo.token)'
};

/**
 * As funções DO PROJETO que aparecem como valor dentro de um nó — chamadas, e
 * também passadas adiante (`f.call(...)`, um apelido, um retorno de chamada).
 * Nome de propriedade e texto ficam de fora. Em ordem, sem repetição.
 */
function funcoesAlcancadas(no) {
  const doProjeto = new Set(funcoesGlobais().map((f) => f.nome));
  const nomes = new Set();
  andar(no, (n, pai) => {
    if (n.type !== 'Identifier' || !doProjeto.has(n.name) || ehNomeDePropriedade(n, pai)) return;
    nomes.add(n.name);
  });
  return Array.from(nomes).sort();
}

/**
 * Onde um nó chama `registrarErroInterno_` (04_Log.gs), e com que nome.
 *
 * O `catch` de uma entrada anônima só ANOTA o erro: o console e esta chamada,
 * com um nome escrito à mão. O nome é a chave do freio da trilha — vindo do
 * cliente, cada nome inventado ganharia a sua escrita —, e fora do `catch` não
 * há erro para anotar. Cada chamada sai como 'catch: <nome>' ou 'fora do catch:
 * <nome>', e o nome que não é texto fixo sai como '<não é um nome fixo>'.
 */
function anotacoesDeErro(no) {
  const catches = [];
  andar(no, (n) => { if (n.type === 'CatchClause') catches.push(n); });
  const chamadas = [];
  andar(no, (n) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || n.callee.name !== 'registrarErroInterno_') return;
    const noCatch = catches.some((c) => n.start >= c.body.start && n.end <= c.body.end);
    const primeiro = n.arguments[0];
    const nome = primeiro && primeiro.type === 'Literal' && typeof primeiro.value === 'string'
      ? primeiro.value : '<não é um nome fixo>';
    chamadas.push((noCatch ? 'catch: ' : 'fora do catch: ') + nome);
  });
  return chamadas;
}

/** O `x.y` de um nó, quando ele é exatamente isso — senão null. */
function membroSimples(no) {
  return no && no.type === 'MemberExpression' && !no.computed && no.object.type === 'Identifier' &&
    no.property.type === 'Identifier' ? no.object.name + '.' + no.property.name : null;
}

teste('as ações do doPost são exatamente inscrição, login e painel — cada uma com o que chama', () => {
  // Fora do `switch`, o doPost só alcança `registrarErroInterno_`, uma vez, no
  // `catch`, com o nome fixo da entrada.
  //
  // Mutação que derruba: uma ação nova; uma ação que passa a chamar outra
  // função; um segundo `switch`; uma função a mais fora do `switch`; a anotação
  // do erro fora do `catch` ou com um nome que não é fixo.
  const no = aGlobal('doPost').no;
  const switches = [];
  andar(no, (n) => { if (n.type === 'SwitchStatement') switches.push(n); });
  igual(switches.length, 1, 'o doPost tem de despachar por um `switch` só');

  const acoes = {};
  switches[0].cases.forEach((c) => {
    const nome = c.test === null ? '(default)' : (c.test.type === 'Literal' ? c.test.value : '<' + c.test.type + '>');
    acoes[nome] = funcoesAlcancadas({ type: 'Caso', corpo: c.consequent });
  });
  igual(acoes, ACOES_DO_POST);
  igual(funcoesAlcancadas(no.body),
    ['registrarErroInterno_', 'respostaJson_', 'rotaDeLogin_', 'rotaDoPainel_', 'submeterInscricao_'],
    'o doPost alcança uma função fora das ações');
  igual(anotacoesDeErro(no), ['catch: post'], 'a anotação do erro do doPost');
});

teste('as rotas de leitura são exatamente ping, config, projetos e matrícula — cada uma com o que chama', () => {
  // `rotaDeLeitura_` é uma sequência de `if (parametros.api === X)` e a resposta
  // da rota desconhecida, e nada mais. O nome da rota pode vir numa constante
  // (`ROTA_PING`), e é lido pelo valor dela.
  //
  // Mutação que derruba: uma rota nova (`?api=admins`); uma rota que passa a
  // chamar outra função; um `else` ou qualquer outra instrução no meio.
  const amb = ambienteCompleto();
  const no = aGlobal('rotaDeLeitura_').no;
  const corpo = no.body.body;
  const rotas = {};
  const estranhos = [];
  corpo.forEach((st, i) => {
    if (i === corpo.length - 1 && st.type === 'ReturnStatement') return;
    const t = st.type === 'IfStatement' ? st.test : null;
    const lado = t && t.type === 'BinaryExpression' && t.operator === '===' && membroSimples(t.left) === 'parametros.api'
      ? t.right : null;
    const nome = !lado ? null : (lado.type === 'Literal' ? lado.value
      : (lado.type === 'Identifier' && typeof amb.api[lado.name] === 'string' ? amb.api[lado.name] : null));
    if (typeof nome !== 'string' || st.alternate) {
      estranhos.push(st.type + ' na linha ' + st.loc.start.line);
      return;
    }
    rotas[nome] = funcoesAlcancadas(st.consequent);
  });
  igual(estranhos, [], 'instrução em rotaDeLeitura_ fora da forma `if (parametros.api === X) ...`');
  igual(rotas, ROTAS_DE_LEITURA);
  igual(funcoesAlcancadas(corpo[corpo.length - 1]), ['respostaJson_'], 'a rota desconhecida passou a fazer mais que responder');
});

teste('o doGet só alcança a rota de leitura e a resposta sem rota — e anota o erro no catch', () => {
  // Mutação que derruba: o doGet chamar qualquer outra função do projeto antes,
  // depois ou no lugar de `rotaDeLeitura_`; a anotação do erro fora do `catch`
  // ou com um nome que não é fixo.
  igual(funcoesAlcancadas(aGlobal('doGet').no.body),
    ['registrarErroInterno_', 'respostaJson_', 'respostaSemRota_', 'rotaDeLeitura_']);
  igual(anotacoesDeErro(aGlobal('doGet').no), ['catch: leitura'], 'a anotação do erro do doGet');
  igual(funcoesAlcancadas(aGlobal('respostaSemRota_').no.body), [], 'a resposta sem rota passou a chamar alguma coisa');
});

teste('o login é um `if (fn === \'nome\')` por ramo, e são exatamente os sete — com o que cada um recebe', () => {
  // A forma é o requisito (ver o comentário de `rotaDeLogin_`): o texto do fio à
  // direita de `fn ===`, sem `else`, e um `return` com a chamada; os argumentos
  // só podem ser campos do corpo. Qualquer outra forma — `'x' === fn`, `==`, um
  // `switch`, um bloco — é um ramo que as outras conferências deste arquivo não
  // leem.
  //
  // O `catch` só anota o erro (`registrarErroInterno_`, com o nome fixo).
  //
  // Mutação que derruba: um ramo novo (`gravarConfig`); um ramo escrito de outro
  // jeito; um argumento trocado; uma função a mais no `catch`.
  const no = aGlobal('rotaDeLogin_').no;
  const corpo = no.body.body;
  verdadeiro(corpo.length === 1 && corpo[0].type === 'TryStatement', 'rotaDeLogin_ deixou de ser um `try` só');
  const bloco = corpo[0].block.body;
  const ramos = {};
  const estranhos = [];
  bloco.forEach((st, i) => {
    if (i === 0 && st.type === 'VariableDeclaration' && st.declarations.length === 1 &&
        st.declarations[0].id.name === 'fn') return;
    if (i === bloco.length - 1 && st.type === 'ReturnStatement' && funcoesAlcancadas(st).length === 0) return;
    const t = st.type === 'IfStatement' && !st.alternate ? st.test : null;
    const certo = t && t.type === 'BinaryExpression' && t.operator === '===' && t.left.type === 'Identifier' &&
      t.left.name === 'fn' && t.right.type === 'Literal' && typeof t.right.value === 'string';
    const ret = certo && st.consequent.type === 'ReturnStatement' ? st.consequent.argument : null;
    if (!ret || ret.type !== 'CallExpression' || ret.callee.type !== 'Identifier') {
      estranhos.push(st.type + ' na linha ' + st.loc.start.line);
      return;
    }
    ramos[t.right.value] = ret.callee.name + '(' + ret.arguments.map((a) => membroSimples(a) || '?').join(', ') + ')';
  });
  igual(estranhos, [], 'instrução em rotaDeLogin_ fora da forma `if (fn === \'nome\') return nome_(...)`');
  igual(ramos, RAMOS_DO_LOGIN);
  igual(funcoesAlcancadas(corpo[0].block), Object.keys(RAMOS_DO_LOGIN).map((fio) => fio + '_').sort(),
    'rotaDeLogin_ alcança uma função fora dos sete ramos');
  igual(funcoesAlcancadas(corpo[0].handler), ['registrarErroInterno_'], 'o catch de rotaDeLogin_ faz mais que anotar');
  igual(anotacoesDeErro(no), ['catch: login'], 'a anotação do erro do login');
});

// ========================================== 4. As cascas, pela árvore

grupo('4. as públicas que sobram são cascas finas — a guarda na primeira linha, e mais nada');

/** A função global `nome`, com o nó dela. */
function aGlobal(nome) {
  const achada = funcoesGlobais().filter((f) => f.nome === nome)[0];
  verdadeiro(achada, nome + ' não existe nos .gs');
  return achada;
}

/** A primeira instrução do corpo é a chamada `guarda(...)`? Devolve os argumentos, ou null. */
function primeiraChamada(no, guarda) {
  const corpo = no.body && no.body.type === 'BlockStatement' ? no.body.body : [];
  const primeira = corpo[0];
  if (!primeira || primeira.type !== 'ExpressionStatement') return null;
  const ch = primeira.expression;
  if (ch.type !== 'CallExpression' || ch.callee.type !== 'Identifier' || ch.callee.name !== guarda) return null;
  return ch.arguments;
}

teste('toda ferramenta de editor começa por exigirDono_()', () => {
  // Mutação que derruba: tirar a guarda de qualquer uma, ou trocá-la de lugar.
  const editor = daCategoria('editor');
  verdadeiro(editor.length >= 20, 'a categoria editor encolheu: ' + editor.length);
  const sem = editor.filter((nome) => {
    const args = primeiraChamada(aGlobal(nome).no, 'exigirDono_');
    return args === null || args.length !== 0;
  });
  igual(sem, [], 'ferramenta de editor que não começa por exigirDono_()');
});

teste('todo gatilho começa por exigirGatilhoOuDono_(e), com o próprio evento', () => {
  // O argumento tem de ser o PRIMEIRO PARÂMETRO da função: é nele que o Apps
  // Script entrega o evento do acionador. Uma guarda chamada sem o evento — ou
  // com outra coisa — recusaria o gatilho de verdade e só aceitaria o editor.
  const gatilhos = daCategoria('gatilho');
  verdadeiro(gatilhos.length >= 3, 'a categoria gatilho encolheu');
  const sem = gatilhos.filter((nome) => {
    const no = aGlobal(nome).no;
    const args = primeiraChamada(no, 'exigirGatilhoOuDono_');
    const evento = no.params[0];
    return args === null || args.length !== 1 || !evento || evento.type !== 'Identifier' ||
      args[0].type !== 'Identifier' || args[0].name !== evento.name;
  });
  igual(sem, [], 'gatilho que não começa por exigirGatilhoOuDono_(<evento>)');
});

teste('cada casca é a guarda e a chamada à privada de mesmo nome — e nada mais', () => {
  // Duas instruções: a guarda e `return nome_(...)`. Trabalho escrito na casca
  // seria trabalho que o código de dentro não alcança (ele chama a privada), e o
  // comportamento passaria a depender de qual das duas portas foi usada. Os
  // argumentos da ferramenta de editor passam como vieram; o gatilho não passa o
  // evento adiante, porque a implementação não precisa dele.
  const ruins = [];
  daCategoria('editor').concat(daCategoria('gatilho')).forEach((nome) => {
    const no = aGlobal(nome).no;
    const corpo = no.body.body;
    const ret = corpo[1];
    const ch = ret && ret.type === 'ReturnStatement' && ret.argument && ret.argument.type === 'CallExpression'
      ? ret.argument : null;
    const esperados = PUBLICAS[nome] === 'gatilho' ? [] : no.params.map((p) => p.name);
    const passados = ch ? ch.arguments.map((a) => (a.type === 'Identifier' ? a.name : '?')) : null;
    if (corpo.length !== 2 || !ch || ch.callee.type !== 'Identifier' || ch.callee.name !== nome + '_' ||
        JSON.stringify(passados) !== JSON.stringify(esperados)) {
      ruins.push(nome);
    }
    verdadeiro(funcoesGlobais().some((f) => f.nome === nome + '_'), nome + '_ não existe');
  });
  igual(ruins, [], 'casca que não é só guarda + return nome_(...)');
});

/**
 * Toda referência a um nome público no código dos `.gs`: chamada, uso como valor.
 * Fora: a declaração da própria função, chave de objeto, propriedade de outro
 * objeto (`x.setup`) e texto — o texto dos GATILHO_* é justamente o nome
 * público, e é assim que tem de ser. Dentro, além do nome solto: a propriedade
 * do objeto global (`globalThis.setup`, `this.setup`, `globalThis['setup']`),
 * que é a mesma função por outro caminho.
 */
function referenciasAPublicas() {
  const achadas = [];
  GS.forEach((a) => {
    andar(a.arvore, (no, pai) => {
      if (no.type === 'Literal' && typeof no.value === 'string' && PUBLICAS[no.value] &&
          pai && pai.type === 'MemberExpression' && pai.computed && pai.property === no && ehObjetoGlobal(pai.object)) {
        achadas.push(no.value + ' (' + a.nome + ':' + no.loc.start.line + ')');
        return;
      }
      if (no.type !== 'Identifier' || !PUBLICAS[no.name]) return;
      if (pai && pai.type === 'FunctionDeclaration' && pai.id === no) return;
      if (pai && pai.type === 'MemberExpression' && pai.property === no && !pai.computed &&
          !ehObjetoGlobal(pai.object)) return;
      if (pai && (pai.type === 'Property' || pai.type === 'MethodDefinition' || pai.type === 'PropertyDefinition') &&
          pai.key === no && !pai.computed && !pai.shorthand) return;
      if (pai && (pai.type === 'LabeledStatement' || pai.type === 'BreakStatement' || pai.type === 'ContinueStatement')) return;
      achadas.push(no.name + ' (' + a.nome + ':' + no.loc.start.line + ')');
    });
  });
  return achadas;
}

teste('nenhum código do servidor chama ou referencia uma função pública', () => {
  // Quem chama por dentro chama a privada. Mutação que derruba: qualquer
  // `fazerBackup()` ou `liberarAcesso(...)` escrito num .gs — ou um despacho
  // que aponte para uma casca.
  igual(referenciasAPublicas(), [], 'o código do projeto chama a casca pública');
});

teste('os GATILHO_* apontam para gatilhos públicos que existem', () => {
  // Os três que o código instala, e qualquer GATILHO_* que nascer depois: o
  // acionador chama pelo nome, então o nome tem de ser público, da categoria
  // gatilho, e de uma função que exista.
  const amb = ambienteCompleto();
  const constantes = Object.keys(amb.api).filter((k) => /^GATILHO_[A-Z_]+$/.test(k)).sort();
  ['GATILHO_AQUECIMENTO', 'GATILHO_BACKUP', 'GATILHO_RECONCILIACAO'].forEach((k) => {
    verdadeiro(constantes.indexOf(k) !== -1, k + ' sumiu');
  });
  constantes.forEach((k) => {
    const nome = amb.api[k];
    igual(PUBLICAS[nome], 'gatilho', k + ' = ' + JSON.stringify(nome) + ' não é um gatilho da lista fechada');
    igual(typeof amb.api[nome], 'function', k + ' aponta para ' + nome + ', que não existe');
  });
  igual(amb.api.GATILHO_RECONCILIACAO, 'reconciliarAutomatico');
  igual(amb.api.GATILHO_AQUECIMENTO, 'aquecerWebApp');
  igual(amb.api.GATILHO_BACKUP, 'fazerBackup');
});

teste('todo acionador que o código instala é por um GATILHO_*', () => {
  // `ScriptApp.newTrigger(nome)` com um texto solto ou com o nome de uma
  // privada criaria um acionador que chama o que não deveria — ou o que não
  // existe para quem chama de fora.
  const soltos = [];
  let instalacoes = 0;
  GS.forEach((a) => {
    andar(a.arvore, (no) => {
      if (no.type !== 'CallExpression' || no.callee.type !== 'MemberExpression') return;
      const c = no.callee;
      if (c.object.type !== 'Identifier' || c.object.name !== 'ScriptApp' || c.property.name !== 'newTrigger') return;
      instalacoes++;
      const arg = no.arguments[0];
      if (!arg || arg.type !== 'Identifier' || !/^GATILHO_/.test(arg.name)) soltos.push(a.nome + ':' + no.loc.start.line);
    });
  });
  verdadeiro(instalacoes >= 3, 'só ' + instalacoes + ' instalações de acionador achadas');
  igual(soltos, []);
});

// ========================================== 5. As guardas, em ação

grupo('5. as guardas — quem passa, quem não passa, e o que a recusa custa');

/** Lança? Devolve a mensagem, ou null se passou. */
function recusa(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e.message;
  }
}

teste('exigirDono_ aceita a conta que está rodando o script — o editor', () => {
  // O contrapeso obrigatório: uma guarda que recusa tudo passaria em todos os
  // testes de recusa abaixo, e seria um projeto sem ferramenta de editor.
  igual(noEditor().api.exigirDono_(), true);
  // A mesma conta, com a caixa diferente, é a mesma conta.
  igual(noEditor({ usuario: DONO.toUpperCase() }).api.exigirDono_(), true);
});

teste('exigirDono_ recusa o web app anônimo — ativo vazio, efetivo de quem implantou', () => {
  // Mutação que derruba: aceitar o ativo vazio, ou comparar só o efetivo.
  const amb = anonimo();
  const msg = recusa(() => amb.api.exigirDono_());
  verdadeiro(msg !== null && msg.indexOf(amb.api.RECUSA_EDITOR) === 0, 'o web app anônimo passou: ' + msg);
});

teste('exigirDono_ recusa as duas contas vazias — são iguais entre si, e não provam nada', () => {
  // O Session devolve '' quando não pode dizer quem é a conta, e duas contas
  // vazias são iguais. É o `!ativo` que as recusa, e é ele que este teste segura:
  // a comparação sozinha (`ativo !== efetivo`) deixaria passar. Espaços em volta
  // são normalizados e dão no mesmo vazio.
  [{ usuario: '', usuarioEfetivo: '' }, { usuario: '   ', usuarioEfetivo: '   ' }].forEach((opcoes) => {
    const amb = ambienteCompleto(opcoes);
    const msg = recusa(() => amb.api.exigirDono_());
    verdadeiro(msg !== null && msg.indexOf(amb.api.RECUSA_EDITOR) === 0,
      JSON.stringify(opcoes) + ' passou pela guarda: ' + msg);
    // No editor, ativo vazio é o Apps Script sem entregar o e-mail, e não outra
    // pessoa: a recusa tem de dizer a quem já está lá o que conferir — e não só
    // mandá-lo para o editor onde ele já está.
    verdadeiro(/userinfo\.email/.test(msg) && /liberarAcesso/.test(msg),
      'a recusa do e-mail vazio não diz o que conferir nem onde está a saída: ' + msg);
  });
});

teste('exigirDono_ recusa outra pessoa — o ativo de alguém do domínio, o efetivo de quem implantou', () => {
  // Mutação que derruba: aceitar quando há ativo "qualquer", sem comparar.
  const amb = ambienteCompleto({ usuario: 'colega@exemplo.com', usuarioEfetivo: DONO });
  igual(recusa(() => amb.api.exigirDono_()), amb.api.RECUSA_EDITOR);
});

teste('exigirDono_ recusa quando o Apps Script não entrega as contas — falha fechada', () => {
  // `usuario: null` faz o falso de Session LANÇAR. As duas pontas: a conta que
  // pede e a conta que roda.
  [{ usuario: null, usuarioEfetivo: DONO }, { usuario: DONO, usuarioEfetivo: null }, { usuario: null, usuarioEfetivo: null }]
    .forEach((opcoes) => {
      const amb = ambienteCompleto(opcoes);
      const msg = recusa(() => amb.api.exigirDono_());
      verdadeiro(msg !== null && msg.indexOf(amb.api.RECUSA_EDITOR) === 0, JSON.stringify(opcoes) + ': ' + msg);
      verdadeiro(/userinfo\.email/.test(msg), 'a recusa não diz o que conferir: ' + msg);
    });
});

teste('exigirGatilhoOuDono_ aceita o acionador de verdade — e compara o id como TEXTO', () => {
  // O web app anônimo de propósito: o acionador passa por ser acionador, e não
  // por cair na regra do editor.
  igual(anonimo({ gatilhos: ['7311'] }).api.exigirGatilhoOuDono_({ triggerUid: '7311' }), true);
  igual(anonimo({ gatilhos: [7311] }).api.exigirGatilhoOuDono_({ triggerUid: '7311' }), true, 'número x texto');
  igual(anonimo({ gatilhos: ['7311'] }).api.exigirGatilhoOuDono_({ triggerUid: 7311 }), true, 'texto x número');
  igual(anonimo({ gatilhos: ['1', '7311', '9'] }).api.exigirGatilhoOuDono_({ triggerUid: '7311' }), true);
});

teste('exigirGatilhoOuDono_ aceita o id de 19 dígitos que chega como NÚMERO', () => {
  // O exemplo de evento da documentação do Google traz um triggerUid de 19
  // dígitos, sem aspas. Como número do JavaScript ele não cabe sem arredondar, e
  // o texto do número arredondado não é o texto do id: comparar só como texto
  // recusaria o acionador de verdade. Número contra número arredonda os dois do
  // mesmo jeito.
  //
  // Mutação que derruba: comparar só como texto.
  const ID = '4034124084959907503';
  const COMO_NUMERO = 4034124084959907503;   // o literal já nasce arredondado
  verdadeiro(String(COMO_NUMERO) !== ID, 'o teste supõe que o número arredonda');
  igual(anonimo({ gatilhos: [ID] }).api.exigirGatilhoOuDono_({ triggerUid: COMO_NUMERO }), true,
    'o acionador de verdade, com o id como número, foi recusado');

  // E o número não vira atalho: outro número é outro acionador, e NaN não é id.
  const amb = anonimo({ gatilhos: [ID] });
  igual(recusa(() => amb.api.exigirGatilhoOuDono_({ triggerUid: 4034124084959906000 })), amb.api.RECUSA_GATILHO);
  igual(recusa(() => amb.api.exigirGatilhoOuDono_({ triggerUid: NaN })), amb.api.RECUSA_GATILHO);
  // Nem um id que não é só dígitos casa por número (`Number(' 7311 ')` é 7311).
  const espacado = anonimo({ gatilhos: [' 7311 '] });
  igual(recusa(() => espacado.api.exigirGatilhoOuDono_({ triggerUid: 7311 })), espacado.api.RECUSA_GATILHO);
});

teste('exigirGatilhoOuDono_ pergunta a lista de acionadores de novo antes de recusar', () => {
  // Uma falha passageira do serviço não pode custar o backup e a reconciliação
  // do dia, que rodam uma vez só. A segunda pergunta vem depois de uma espera
  // curta — que o falso de Utilities anota em vez de dormir.
  //
  // Mutação que derruba: perguntar uma vez só, perguntar sem esperar, ou
  // perguntar mais de duas vezes.
  const amb = anonimo({ gatilhos: ['7311'], falhasDosGatilhos: 1 });
  igual(amb.api.exigirGatilhoOuDono_({ triggerUid: '7311' }), true, 'a falha passageira derrubou o acionador de verdade');
  igual(amb.esperas, [amb.api.ESPERA_ACIONADORES_MS], 'a segunda pergunta não esperou, ou esperou mais de uma vez');
  verdadeiro(amb.api.ESPERA_ACIONADORES_MS >= 500 && amb.api.ESPERA_ACIONADORES_MS <= 5000,
    'a espera saiu da faixa curta: ' + amb.api.ESPERA_ACIONADORES_MS);

  // Duas falhas seguidas são falha de verdade: recusa — e não cai na regra do
  // dono, nem para o dono no editor.
  const duas = anonimo({ gatilhos: ['7311'], falhasDosGatilhos: 2 });
  igual(recusa(() => duas.api.exigirGatilhoOuDono_({ triggerUid: '7311' })), duas.api.RECUSA_GATILHO);
  const dono = noEditor({ gatilhos: ['7311'], falhasDosGatilhos: 2 });
  igual(recusa(() => dono.api.exigirGatilhoOuDono_({ triggerUid: '7311' })), dono.api.RECUSA_GATILHO);

  // E a lista que responde de primeira não espera nada.
  const direto = anonimo({ gatilhos: ['7311'] });
  igual(direto.api.exigirGatilhoOuDono_({ triggerUid: '7311' }), true);
  igual(direto.esperas, [], 'esperou sem a lista ter falhado');
});

teste('exigirGatilhoOuDono_ recusa o evento forjado — triggerUid que o projeto não tem', () => {
  // Mutação que derruba: aceitar qualquer evento que traga `triggerUid`, sem
  // conferir contra os acionadores do projeto.
  const amb = anonimo({ gatilhos: ['7311'] });
  [{ triggerUid: '7312' }, { triggerUid: '' }, { triggerUid: null }, {}, { triggerUid: '7311 ' }, undefined]
    .forEach((evento) => {
      igual(recusa(() => amb.api.exigirGatilhoOuDono_(evento)), amb.api.RECUSA_GATILHO, JSON.stringify(evento));
    });
  // E com o projeto sem acionador nenhum, nenhum id vale.
  const vazio = anonimo();
  igual(recusa(() => vazio.api.exigirGatilhoOuDono_({ triggerUid: '7311' })), vazio.api.RECUSA_GATILHO);
});

/**
 * Os acionadores do Apps Script são de cada CONTA, e `getProjectTriggers()` só
 * devolve os da conta com que a execução roda. Em produção, o backup e o
 * aquecimento são de quem implantou, e a reconciliação diária é de OUTRA conta
 * institucional: quando o acionador dela dispara, o ativo e o efetivo são essa
 * conta, e a lista que a guarda lê é a dela.
 */
const OUTRA_CONTA = 'outra.conta@exemplo.edu.br';
const GATILHOS_POR_CONTA = {
  [DONO]: [{ id: '7311', funcao: 'fazerBackup' }, { id: '7312', funcao: 'aquecerWebApp' }],
  [OUTRA_CONTA]: [{ id: '8801', funcao: 'reconciliarAutomatico' }]
};

/** Uma linha da lista oficial, como a importação grava: id do documento = matrícula. Só a forma. */
function semearMatriculado(amb) {
  amb.api.escreverEmLote_('matriculados', [{
    _id: '9110001', matricula: '9110001', nome: 'Aluno de teste', cpf: '', email: '', telefone: '',
    data_nascimento: '', curso: 'ADS', turma: '', situacao: '', raw_json: '[]', lote_id: 'lote_teste',
    importado_em: '2026-08-01 09:00:00', importado_por: 'nome.sobrenome@exemplo.edu.br'
  }]);
}

teste('o acionador de OUTRA conta passa: a reconciliação roda como ela, lê a lista dela, e faz o trabalho', () => {
  // A execução de produção, como ela é: o ativo e o efetivo são a outra conta,
  // e a lista de acionadores é a dela — com o do evento, sem os de quem
  // implantou. A guarda passa, e a rodada grava a linha da madrugada, assinada
  // pela conta que rodou.
  //
  // Mutação que derruba: a casca não chegar ao trabalho, ou a guarda recusar o
  // acionador que é de outra conta.
  const amb = ambienteCompleto({ usuario: OUTRA_CONTA, usuarioEfetivo: OUTRA_CONTA, gatilhosPorConta: GATILHOS_POR_CONTA });
  igual(amb.api.ScriptApp.getProjectTriggers().map((g) => g.getUniqueId()), ['8801'],
    'o falso devolveu acionadores de outra conta');
  semearMatriculado(amb);

  amb.api.reconciliarAutomatico({ triggerUid: '8801' });

  const linhas = amb.api.listar_('log', {}).itens;
  igual(linhas.filter((l) => l.acao === 'ERRO').map((l) => l.detalhe), [], 'a rodada falhou');
  const rodada = linhas.filter((l) => l.acao === 'RECONCILIACAO_AUTOMATICA');
  igual(rodada.map((l) => l.detalhe), ['alunos: 1, gravados: 1'], 'a rodada não fez o trabalho');
  igual(rodada[0].usuario, OUTRA_CONTA);
  igual(amb.api.listar_('alunos', {}).itens.length, 1, 'a ficha do aluno não nasceu');
});

teste('e ela passa por ser acionador da conta que roda, e não pela regra do editor', () => {
  // A mesma execução sem o ativo, que a regra do editor recusa: o que sobra é
  // o acionador, e ele só casa porque a lista lida é a da conta efetiva.
  //
  // Mutação que derruba: a guarda deixar de conferir a lista de acionadores e
  // cair sempre na regra do editor.
  const amb = ambienteCompleto({ usuario: '', usuarioEfetivo: OUTRA_CONTA, gatilhosPorConta: GATILHOS_POR_CONTA });
  let rodou = 0;
  amb.api.reconciliarAutomatico_ = () => { rodou++; };

  verdadeiro(recusa(() => amb.api.exigirDono_()) !== null, 'o cenário devia estar fora do editor');
  amb.api.reconciliarAutomatico({ triggerUid: '8801' });
  amb.api.reconciliarAutomatico({ triggerUid: 8801 });
  igual(rodou, 2);
});

teste('o triggerUid que não está na lista da conta que roda, fora do editor, é recusado — e nada roda', () => {
  // O id de um acionador que existe, mas é de OUTRA conta: para a conta que
  // roda, não é acionador nenhum. Fora do editor não há a segunda saída.
  //
  // Mutação que derruba: a guarda aceitar qualquer `triggerUid`; ou a lista
  // lida juntar os acionadores de todas as contas.
  [
    [{ usuario: '', usuarioEfetivo: OUTRA_CONTA }, '7311', 'o id do backup de quem implantou, rodando como a outra conta'],
    [{ usuario: 'colega@exemplo.edu.br', usuarioEfetivo: OUTRA_CONTA }, '7312',
      'o id do aquecimento, pedido por uma terceira conta'],
    [{ usuario: '', usuarioEfetivo: DONO }, '8801', 'o id da reconciliação, rodando como quem implantou'],
    [{ usuario: '', usuarioEfetivo: OUTRA_CONTA }, 'forjado', 'um id que ninguém tem']
  ].forEach(([contas, uid, caso]) => {
    const amb = ambienteCompleto(Object.assign({ gatilhosPorConta: GATILHOS_POR_CONTA }, contas));
    let rodou = false;
    amb.api.reconciliarAutomatico_ = () => { rodou = true; };

    igual(recusa(() => amb.api.reconciliarAutomatico({ triggerUid: uid })), amb.api.RECUSA_GATILHO, caso);
    igual(rodou, false, caso + ': a reconciliação rodou');
    igual(amb.falso.requisicoes.length, 0, caso + ': a recusa foi ao banco');
  });
});

teste('os três instaladores só veem os acionadores da conta que roda — e o editor manda conferir a tela Acionadores', () => {
  // A mesma lista por conta, do lado de quem instala: rodando como quem
  // implantou, o acionador da OUTRA conta não está na lista, não é removido, e
  // instalar de novo deixa dois. O comportamento fica como é; quem avisa é o que
  // o editor imprime, que é a única hora em que alguém está olhando.
  //
  // Mutação que derruba: tirar o aviso de um dos três instaladores.
  [
    ['instalarGatilhoDiario_', 'reconciliarAutomatico'],
    ['instalarGatilhoBackup_', 'fazerBackup'],
    ['instalarGatilhoAquecimento_', 'aquecerWebApp']
  ].forEach(([instalador, funcao]) => {
    const amb = noEditor();
    const porConta = { [OUTRA_CONTA]: [funcao], [DONO]: [] };
    amb.api.ScriptApp = {
      getOAuthToken: () => 'token-de-mentira',
      getProjectTriggers: () => porConta[DONO].map((f) => ({ getHandlerFunction: () => f })),
      deleteTrigger: () => { throw new Error('apagou um acionador que esta conta não tem'); },
      newTrigger: (f) => {
        const construtor = {
          atHour: () => construtor, everyDays: () => construtor, everyMinutes: () => construtor,
          create: () => { porConta[DONO].push(f); }
        };
        return { timeBased: () => construtor };
      }
    };
    // O aquecimento, sem endereço, não sai para a rede.
    amb.api.urlDeAquecimento_ = () => '';
    amb.api.urlDoWebApp_ = () => '';

    amb.api[instalador]();

    igual(porConta[OUTRA_CONTA].concat(porConta[DONO]).filter((f) => f === funcao).length, 2,
      instalador + ': o cenário são dois acionadores, o de cada conta');
    const aviso = amb.registros.logger.filter((l) => /tela Acionadores/.test(l) && /de outra conta/.test(l));
    igual(aviso.length, 1, instalador + ' não manda conferir a tela Acionadores: ' + JSON.stringify(amb.registros.logger));
    verdadeiro(aviso[0].indexOf(funcao) !== -1, instalador + ': o aviso não diz qual acionador procurar: ' + aviso[0]);
  });
});

teste('exigirGatilhoOuDono_ aceita o dono no editor, com ou sem evento', () => {
  // É como se roda o primeiro backup, ou se testa o aquecimento.
  const amb = noEditor();
  igual(amb.api.exigirGatilhoOuDono_(), true);
  igual(amb.api.exigirGatilhoOuDono_({}), true);
});

teste('exigirGatilhoOuDono_ recusa quando a lista de acionadores não pode ser lida', () => {
  // `gatilhos: null` faz `getProjectTriggers` lançar. Falha fechada: na dúvida,
  // o gatilho não roda — e o dono recebe o e-mail de falha do Google.
  const amb = anonimo({ gatilhos: null });
  igual(recusa(() => amb.api.exigirGatilhoOuDono_({ triggerUid: '7311' })), amb.api.RECUSA_GATILHO);

  // E a falha da pergunta não vira "então pergunta a outra coisa": com um
  // evento de acionador na mão e a lista sem responder, nem o editor passa.
  // Mutação que derruba: engolir a exceção e cair na regra do dono.
  const dono = noEditor({ gatilhos: null });
  igual(recusa(() => dono.api.exigirGatilhoOuDono_({ triggerUid: '7311' })), dono.api.RECUSA_GATILHO);
  igual(dono.api.exigirGatilhoOuDono_(), true, 'sem evento, o dono no editor continua passando');
});

teste('recusar não escreve nada — nem banco, nem propriedade, nem trilha', () => {
  // Uma recusa que custasse escrita seria um jeito de gastar a cota do dia
  // batendo na porta errada. O aviso vai para o console, que é de graça.
  const amb = anonimo({ gatilhos: ['7311'] });
  const antes = JSON.stringify(Array.from(amb.propriedades.entries()));
  amb.falso.requisicoes.length = 0;

  recusa(() => amb.api.exigirDono_());
  recusa(() => amb.api.exigirGatilhoOuDono_({ triggerUid: 'forjado' }));

  igual(amb.falso.requisicoes.length, 0, 'a recusa foi ao banco');
  igual(JSON.stringify(Array.from(amb.propriedades.entries())), antes, 'a recusa mexeu nas propriedades');
  verdadeiro(amb.registros.erros.length >= 2, 'a recusa não deixou nem a linha do console');
});

teste('cada ferramenta de editor e cada gatilho recusam o chamador anônimo — antes de fazer qualquer coisa', () => {
  // A implementação de cada uma é trocada por um espião: se ela rodar, a guarda
  // falhou. O gatilho é tentado também com um evento forjado. Dois anônimos: o
  // web app de hoje (ativo vazio, efetivo de quem implantou) e as duas contas
  // vazias, que são iguais entre si.
  const furos = [];
  [{ usuario: '', usuarioEfetivo: DONO }, { usuario: '', usuarioEfetivo: '' }].forEach((contas) => {
    const amb = ambienteCompleto(Object.assign({ gatilhos: ['7311'] }, contas));
    const quem = JSON.stringify(contas);
    daCategoria('editor').concat(daCategoria('gatilho')).forEach((nome) => {
      let rodou = false;
      amb.api[nome + '_'] = function () { rodou = true; return 'rodou'; };
      const esperada = PUBLICAS[nome] === 'gatilho' ? amb.api.RECUSA_GATILHO : amb.api.RECUSA_EDITOR;

      const tentativas = PUBLICAS[nome] === 'gatilho'
        ? [() => amb.api[nome](), () => amb.api[nome]({ triggerUid: 'forjado' })]
        : [() => amb.api[nome](), () => amb.api[nome]('invasor@exemplo.com')];
      tentativas.forEach((t, i) => {
        const msg = recusa(t);
        if (msg === null || msg.indexOf(esperada) !== 0 || rodou) {
          furos.push(quem + ' ' + nome + ' #' + i + ': ' + (rodou ? 'RODOU' : msg));
        }
      });
    });
    igual(amb.falso.requisicoes.length, 0, quem + ': alguma recusa custou ida ao banco');
  });
  igual(furos, []);
});

teste('dentro de uma requisição ao web app, as duas guardas recusam até o dono logado', () => {
  // Pela documentação do Session, o dono que abre o /exec logado tem o ativo
  // igual ao efetivo — a regra das contas sozinha o deixaria passar. Quem recusa
  // é a marca que o doGet e o doPost põem na primeira linha. Aqui o ambiente é o
  // do dono (que passa antes da requisição), e o acionador existe de verdade.
  //
  // Mutação que derruba: tirar a marca do doGet ou do doPost, ou a pergunta à
  // marca de uma das duas guardas.
  [
    ['doGet', (amb) => amb.api.doGet({ parameter: { api: 'ping' } })],
    ['doPost', (amb) => amb.api.doPost({})]
  ].forEach(([entrada, requisitar]) => {
    const amb = noEditor({ gatilhos: ['7311'] });
    igual(amb.api.exigirDono_(), true, entrada + ': o dono no editor passa antes da requisição');
    igual(amb.api.exigirGatilhoOuDono_({ triggerUid: '7311' }), true, entrada + ': o acionador passa antes');

    requisitar(amb);

    igual(recusa(() => amb.api.exigirDono_()), amb.api.RECUSA_EDITOR, entrada + ': exigirDono_');
    igual(recusa(() => amb.api.exigirGatilhoOuDono_({ triggerUid: '7311' })), amb.api.RECUSA_GATILHO,
      entrada + ': exigirGatilhoOuDono_ com o id de um acionador de verdade');
    igual(recusa(() => amb.api.exigirGatilhoOuDono_()), amb.api.RECUSA_GATILHO, entrada + ': sem evento');
  });
});

teste('o doGet e o doPost marcam a requisição na primeira linha', () => {
  // Antes de qualquer outra instrução: uma rota que chegasse a uma casca antes da
  // marca a encontraria desligada. Pela árvore, porque a posição é o requisito.
  const ruins = ['doGet', 'doPost'].filter((nome) => {
    const primeira = aGlobal(nome).no.body.body[0];
    const ex = primeira && primeira.type === 'ExpressionStatement' ? primeira.expression : null;
    return !(ex && ex.type === 'AssignmentExpression' && ex.operator === '=' &&
      ex.left.type === 'Identifier' && ex.left.name === 'EM_REQUISICAO_WEB' &&
      ex.right.type === 'Literal' && ex.right.value === true);
  });
  igual(ruins, [], 'entrada do web app que não começa por EM_REQUISICAO_WEB = true');
  igual(ambienteCompleto().api.EM_REQUISICAO_WEB, false, 'a execução nasce marcada como requisição');
});

teste('com a guarda satisfeita, a casca entrega a implementação inteira — argumento e resposta', () => {
  // O outro lado: a casca não come argumento nem resposta. No editor para as de
  // editor; pelo acionador de verdade para os gatilhos.
  const furos = [];
  daCategoria('editor').concat(daCategoria('gatilho')).forEach((nome) => {
    const amb = PUBLICAS[nome] === 'gatilho' ? anonimo({ gatilhos: ['7311'] }) : noEditor();
    const recebidos = [];
    amb.api[nome + '_'] = function () { recebidos.push(Array.prototype.slice.call(arguments)); return { de: nome }; };

    const r = PUBLICAS[nome] === 'gatilho'
      ? amb.api[nome]({ triggerUid: '7311' })
      : amb.api[nome]('alguem@exemplo.com');
    const esperados = PUBLICAS[nome] === 'gatilho'
      ? [[]]
      : [aGlobal(nome).no.params.length ? ['alguem@exemplo.com'] : []];
    if (JSON.stringify(r) !== JSON.stringify({ de: nome }) || JSON.stringify(recebidos) !== JSON.stringify(esperados)) {
      furos.push(nome + ': ' + JSON.stringify({ r, recebidos }));
    }
  });
  igual(furos, []);
});

// ---------------------------------------------------------------- Resultado

process.exit(resultado());
