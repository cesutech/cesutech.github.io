/**
 * consertos.js — os testes dos consertos de 06/08, um por achado da revisão.
 *
 * Por que um arquivo separado em vez de espalhar nos outros nove: cada teste
 * daqui existe porque uma coisa ESPECÍFICA estava errada, e o valor dele é dizer
 * qual. Espalhados, eles viram linhas anônimas no meio de 445 outras e, no dia em
 * que alguém "simplificar" um deles, ninguém sabe o que se perdeu. Aqui cada
 * grupo cita o item da revisão, e o comentário conta o que acontecia ANTES.
 *
 * Todos falham no código de ontem. Foi assim que foram escritos: primeiro o
 * teste vermelho contra o arquivo original, depois o conserto.
 *
 * Uso:  node testes/consertos.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { teste, grupo, igual, verdadeiro, resultado } = require('./apoio');

const PASTA_GS = path.join(__dirname, '..', 'apps-script');

// O painel mudou de casa em 07/08: era `apps-script/Admin.html`, servido pelo
// Apps Script, e agora é `docs/painel/index.html`, servido pelo GitHub Pages. Os
// consertos abaixo continuam sendo os mesmos e continuam morando na tela — o que
// mudou foi o arquivo onde ela está.
const ADMIN = fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'painel', 'index.html'), 'utf8');
const MANIFESTO = JSON.parse(fs.readFileSync(path.join(PASTA_GS, 'appsscript.json'), 'utf8'));

// Este arquivo não carrega os `.gs` num sandbox: o que ele prova é sobre o
// TEXTO do código e do manifesto — escopo declarado, frase que o professor lê,
// contrato entre o Admin.html e o servidor. O comportamento em execução de cada
// conserto está provado no arquivo da fase dele (importacao.js, painel.js,
// projetos.js, inscricoes.js, banners.js, config-log.js, reconciliacao.js).
function todosOsGs() {
  return fs.readdirSync(PASTA_GS)
    .filter((n) => n.slice(-3) === '.gs')
    .map((n) => ({ nome: n, texto: fs.readFileSync(path.join(PASTA_GS, n), 'utf8') }));
}

// ============================================================ IMPEDE 1
//
// Os escopos. O manifesto lista `oauthScopes` explicitamente, e quando faz isso
// o Apps Script NÃO acrescenta os que o código usaria — o script autoriza só o
// que está escrito. `SpreadsheetApp` e `DocumentApp` são serviços "fáceis", que
// a plataforma amarra a um escopo próprio, e nenhum dos dois estava declarado:
// a importação por XLSX (o formato que a coordenação mais manda) e a por PDF
// morriam por autorização no primeiro uso, com os 445 testes verdes — porque
// nenhum falso tem noção de escopo.
//
// Em 06/08 o conserto foi DECLARAR os dois escopos. Em 07/08 o Jonathan olhou o
// que estava concedendo — todas as planilhas e todos os documentos da conta
// dele, para ler um arquivo que o próprio sistema tinha acabado de criar — e
// pediu outro caminho. Os dois escopos saíram, e o que este grupo prova mudou de
// "o escopo está declarado" para "o serviço não é mais chamado, em .gs nenhum".

grupo('IMPEDE 1 — todo serviço do Apps Script usado tem escopo declarado');

/**
 * Serviço -> escopo que a plataforma exige dele.
 *
 * A lista é curta de propósito: só os serviços que amarram escopo e que este
 * projeto poderia querer usar. Serviço novo que entre no código sem entrar aqui
 * não é pego por este teste — por isso o teste seguinte, do inventário, existe.
 */
const ESCOPO_DO_SERVICO = {
  SpreadsheetApp: 'https://www.googleapis.com/auth/spreadsheets',
  DocumentApp: 'https://www.googleapis.com/auth/documents',
  DriveApp: 'https://www.googleapis.com/auth/drive',
  FormApp: 'https://www.googleapis.com/auth/forms',
  GmailApp: 'https://www.googleapis.com/auth/gmail.send',
  MailApp: 'https://www.googleapis.com/auth/script.send_mail',
  CalendarApp: 'https://www.googleapis.com/auth/calendar',
  SlidesApp: 'https://www.googleapis.com/auth/presentations'
};

/**
 * Onde cada serviço é REALMENTE chamado.
 *
 * Comentário não conta: 02b_Drive.gs explica o DriveApp em prosa por três
 * parágrafos e não o usa mais. Só linha de código vale, então o texto é limpo de
 * comentários e de literais antes da varredura — senão a própria mensagem de
 * erro que cita "FormApp" acusaria uso de FormApp.
 */
function usosDeServico() {
  const usos = {};

  todosOsGs().forEach(({ nome, texto }) => {
    const codigo = texto
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');

    Object.keys(ESCOPO_DO_SERVICO).forEach((servico) => {
      // `FormApp.openById(` conta; `typeof FormApp` não, que é a guarda de
      // ausência e roda sem escopo nenhum.
      const chamada = new RegExp('\\b' + servico + '\\s*\\.\\s*[A-Za-z_]');
      if (chamada.test(codigo)) {
        if (!usos[servico]) usos[servico] = [];
        if (usos[servico].indexOf(nome) === -1) usos[servico].push(nome);
      }
    });
  });

  return usos;
}

/**
 * Serviços usados DE PROPÓSITO sem escopo, porque o caminho é opcional e
 * degrada com uma mensagem que explica o que falta.
 *
 * Isto é uma decisão, não um esquecimento: `/auth/forms` dá acesso a TODOS os
 * formulários da conta, e a sincronização com o Forms é plano B do sistema que
 * este projeto substitui. Quem quiser ligá-la acrescenta o escopo e some daqui.
 */
const DESLIGADOS_DE_PROPOSITO = { FormApp: '06_Reconciliacao.gs' };

teste('nenhum serviço é chamado sem o escopo dele no appsscript.json', () => {
  const usos = usosDeServico();
  const declarados = MANIFESTO.oauthScopes;

  Object.keys(usos).forEach((servico) => {
    if (DESLIGADOS_DE_PROPOSITO[servico]) return;

    const escopo = ESCOPO_DO_SERVICO[servico];
    verdadeiro(
      declarados.indexOf(escopo) !== -1,
      servico + ' é usado em ' + usos[servico].join(', ') + ' e o manifesto não declara ' +
      escopo + ' — em produção isso é erro de autorização, não erro de teste'
    );
  });
});

teste('serviço desligado de propósito degrada em vez de estourar na cara do professor', () => {
  const usos = usosDeServico();

  Object.keys(DESLIGADOS_DE_PROPOSITO).forEach((servico) => {
    if (!usos[servico]) return;

    verdadeiro(MANIFESTO.oauthScopes.indexOf(ESCOPO_DO_SERVICO[servico]) === -1,
      servico + ' ganhou escopo: tire-o da lista de desligados de propósito');

    // Sem o escopo, a chamada LANÇA em produção. O que impede isso de virar
    // "Erro desconhecido" na tela é o catch com a mensagem que nomeia o escopo.
    const texto = fs.readFileSync(path.join(PASTA_GS, DESLIGADOS_DE_PROPOSITO[servico]), 'utf8');
    verdadeiro(/catch\s*\([\s\S]{0,400}avisoDeEscopoDoForms_/.test(texto),
      'a chamada de ' + servico + ' precisa estar dentro de um catch que explique o escopo');
  });
});

// Os dois testes abaixo já exigiram o CONTRÁRIO: que `/auth/spreadsheets` e
// `/auth/documents` estivessem declarados, porque a importação precisava deles.
// Em 07/08 o Jonathan pediu para não conceder acesso a todas as planilhas e
// todos os documentos dele, e os dois caminhos foram reescritos sem esses
// serviços — XLSX lido dos próprios bytes, PDF pelo export do Drive.
//
// Este é o teste que impede o escopo de voltar sem ninguém perceber. Uma única
// linha com `SpreadsheetApp.` ou `DocumentApp.` em qualquer `.gs` faz o Google
// exigir o escopo de novo, e a quebra apareceria em produção, na autorização —
// longe do commit que a causou. É por isso que ele varre TODOS os arquivos, e
// não só 05_Importacao.gs.

const SERVICOS_BANIDOS = ['SpreadsheetApp', 'DocumentApp'];

teste('nenhum .gs volta a chamar SpreadsheetApp ou DocumentApp', () => {
  const usos = usosDeServico();

  SERVICOS_BANIDOS.forEach((servico) => {
    igual(usos[servico], undefined,
      servico + ' voltou (em ' + (usos[servico] || []).join(', ') + '). Ele exige ' +
      ESCOPO_DO_SERVICO[servico] + ', que dá acesso a TUDO daquele tipo na conta de ' +
      'quem instala. Se for mesmo necessário, é decisão do Jonathan e passa por ' +
      'declarar o escopo no manifesto — não por acidente.');
  });
});

teste('os dois escopos amplos não estão mais no manifesto', () => {
  SERVICOS_BANIDOS.forEach((servico) => {
    verdadeiro(MANIFESTO.oauthScopes.indexOf(ESCOPO_DO_SERVICO[servico]) === -1,
      ESCOPO_DO_SERVICO[servico] + ' voltou ao appsscript.json');
  });

  // Cada escopo tem dono declarado, e a lista é conferida INTEIRA: escopo novo
  // que entre sem alguém decidir isso deixa este teste vermelho.
  //
  //   datastore                Firestore, que é o banco;
  //   drive.file               só os arquivos que este app criou (OCR do PDF);
  //   script.external_request   as chamadas REST ao Firestore e ao tokeninfo;
  //   script.scriptapp          a URL da implantação, que vai dentro do link;
  //   script.send_mail          o link por e-mail (07b_LinkPorEmail.gs). Entrou
  //                             em 11/08 junto com a remoção do PIN: sem ele,
  //                             `MailApp.sendEmail` não roda e a porta de
  //                             recuperação do painel não existe;
  //   userinfo.email            quem está logado, para a trilha e a allowlist.
  igual(MANIFESTO.oauthScopes.slice().sort(), [
    'https://www.googleapis.com/auth/datastore',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/script.send_mail',
    'https://www.googleapis.com/auth/userinfo.email'
  ]);
});

teste('o XLSX é lido dos bytes, e não por um serviço com escopo', () => {
  const texto = fs.readFileSync(path.join(PASTA_GS, '05_Importacao.gs'), 'utf8');
  const codigo = texto.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  verdadeiro(/Utilities\.unzip\(/.test(codigo), 'o .xlsx é um ZIP e é assim que ele abre');
  verdadeiro(/XmlService\.parse\(/.test(codigo), 'e os XML de dentro se leem assim');
  // Ler ZIP e XML é manipulação de bytes que já estão na mão: nenhum dos dois
  // serviços aparece na tabela de escopos porque nenhum dos dois exige um.
  verdadeiro(ESCOPO_DO_SERVICO.Utilities === undefined);
  verdadeiro(ESCOPO_DO_SERVICO.XmlService === undefined);
});

teste('o PDF continua exportando o texto do OCR pelo Drive', () => {
  const importacao = fs.readFileSync(path.join(PASTA_GS, '05_Importacao.gs'), 'utf8');
  const drive = fs.readFileSync(path.join(PASTA_GS, '02b_Drive.gs'), 'utf8');

  verdadeiro(/driveExportarTexto_\(doc\.id\)/.test(importacao),
    'o texto do Documento criado pelo OCR precisa sair pelo export');
  verdadeiro(/function driveExportarTexto_\s*\(/.test(drive));
  // O arquivo é criado pelo próprio app, e é isso que faz drive.file bastar.
  verdadeiro(MANIFESTO.oauthScopes.indexOf('https://www.googleapis.com/auth/drive.file') !== -1);
});

teste('autorizar() não ressuscita os escopos que acabaram de sair', () => {
  // Ela existia para FORÇAR o consentimento dos dois escopos amplos, chamando
  // `SpreadsheetApp.openById` e `DocumentApp.openById` com id inválido. Se
  // essas duas linhas ficassem, elas sozinhas fariam o Google exigir os escopos
  // de novo — a menção estática basta.
  const prova = fs.readFileSync(path.join(PASTA_GS, '20_Prova.gs'), 'utf8');
  const autorizar = /function autorizar\(\)[\s\S]*?\n}/.exec(prova);
  verdadeiro(autorizar, 'autorizar() sumiu; se foi de propósito, apague este teste junto');

  verdadeiro(/Drive\.Files\.list\(/.test(autorizar[0]),
    'sobrou drive.file para forçar, e é o único escopo que o Firestore não exercita');
  verdadeiro(/pageSize: 1/.test(autorizar[0]),
    'listar uma página inteira para provar autorização é gastar sem motivo');
  verdadeiro(!/Files\.create|Files\.update|Permissions/.test(autorizar[0]),
    'autorizar() não pode criar, alterar nem compartilhar nada');
});

teste('o DriveApp não é mais chamado — a reserva de driveLerTexto_ não podia socorrer', () => {
  // A reserva chamava DriveApp num projeto com escopo `drive.file`. Ela falharia
  // por autorização justamente nas vezes em que fosse acionada, trocando o erro
  // verdadeiro do Drive por "permissões não são suficientes".
  const usos = usosDeServico();
  igual(usos.DriveApp, undefined,
    'voltou a usar DriveApp: ou declare /auth/drive (escopo AMPLO) ou não use');
  verdadeiro(MANIFESTO.oauthScopes.indexOf('https://www.googleapis.com/auth/drive') === -1,
    'o escopo amplo do Drive não pode entrar sem alguém decidir isso de propósito');
  verdadeiro(MANIFESTO.oauthScopes.indexOf('https://www.googleapis.com/auth/drive.file') !== -1);
});

teste('o Forms está DESLIGADO, e a mensagem manda procurar o escopo certo', () => {
  // Ela citava `/auth/forms.responses.readonly`, que é da API REST do Forms.
  // Este código usa `FormApp`, que a plataforma amarra a `/auth/forms`.
  const texto = fs.readFileSync(path.join(PASTA_GS, '06_Reconciliacao.gs'), 'utf8');
  const aviso = /function avisoDeEscopoDoForms_[\s\S]*?\n}/.exec(texto)[0];

  verdadeiro(aviso.indexOf('auth/forms.responses.readonly') === -1,
    'a mensagem ainda manda acrescentar o escopo da API REST, que não destrava o FormApp');
  verdadeiro(aviso.indexOf('https://www.googleapis.com/auth/forms') !== -1);
  verdadeiro(MANIFESTO.oauthScopes.indexOf('https://www.googleapis.com/auth/forms') === -1,
    'se o Forms for ligado de propósito, este teste é o lugar de registrar a decisão');
});

// ============================================================ IMPEDE 2
//
// A importação chamava `reconciliar()` antes de responder, para o passo 3 já
// mostrar os quatro números. As duas passavam a dividir UMA execução de 6
// minutos: ~7 idas ao Firestore da importação mais 16 a 21 da reconciliação.
// Estourar aí é o pior modo de falha do sistema, porque não é limpo — os
// matriculados JÁ estão gravados e o temporário JÁ foi descartado, e mesmo assim
// a tela diz "Falha na importação". O professor reenvia, e são mais 2.500
// escritas num dia que tem 20.000.

grupo('IMPEDE 2 — o passo 3 pede a reconciliação em vez de fazê-la escondido');

teste('o servidor não expõe mais a costura entre os dois', () => {
  const texto = fs.readFileSync(path.join(PASTA_GS, '05_Importacao.gs'), 'utf8');
  const codigo = texto.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  verdadeiro(codigo.indexOf('resumoReconciliacao_') === -1,
    'a função de costura voltou');
  verdadeiro(!/\breconciliar\s*\(/.test(codigo),
    '05_Importacao.gs voltou a chamar reconciliar() — as duas dividem a execução de novo');
});

teste('o painel não lê mais r.reconciliacao, e ganhou o botão', () => {
  // A conferência é sobre a RESPOSTA DA IMPORTAÇÃO, e por isso olha só o trecho
  // dela. Ela era uma busca pelo texto `r.reconciliacao` no arquivo inteiro, e
  // isso deixou de servir quando o botão Atualizar da aba Alunos passou a receber
  // o resultado do cruzamento dentro da própria resposta (`atualizarAlunos`,
  // 10_Painel.gs) — ali o acoplamento é o desejado: uma execução em vez de duas,
  // e nada de dado gravado dependendo dele.
  const importacao = /chamar\('confirmarImportacao'[\s\S]*?\n  \}/.exec(ADMIN);
  verdadeiro(importacao !== null, 'o passo 3 da importação mudou de forma');
  verdadeiro(importacao[0].indexOf('r.reconciliacao') === -1,
    'a tela ainda espera o resumo vindo dentro da resposta da importação');
  verdadeiro(ADMIN.indexOf('reconciliarAposImportar') !== -1,
    'sem o botão, o passo 3 termina com a reconciliação por fazer e ninguém avisado');
  verdadeiro(/Falta o último passo/.test(ADMIN),
    'o professor precisa ler que falta um passo, não deduzir');
});

teste('o botão do passo 3 chama a função que existe no servidor', () => {
  const trecho = /function reconciliarAposImportar[\s\S]*?\n  }/.exec(ADMIN)[0];
  verdadeiro(/chamar\('rodarReconciliacao'/.test(trecho), trecho.slice(0, 200));

  const painel = fs.readFileSync(path.join(PASTA_GS, '06_Reconciliacao.gs'), 'utf8');
  verdadeiro(/function rodarReconciliacao\s*\(/.test(painel));
});

teste('falha na reconciliação diz que a importação continua valendo', () => {
  // A confusão que o acoplamento criava: dado gravado, tela dizendo que falhou.
  const trecho = /function reconciliarAposImportar[\s\S]*?\n  }/.exec(ADMIN)[0];
  verdadeiro(/A reconciliação falhou/.test(trecho));
  verdadeiro(/importação continua valendo/.test(trecho), trecho);
});

// ============================================================ IMPEDE 3 e 4
//
// `matriculados` só crescia, e a caixa "Substituir a lista oficial anterior"
// dizia "Marcado: apaga tudo que foi importado antes" — o contrário do que o
// código faz. Era a única frase do painel capaz de fazer a coordenação decidir
// errado sobre dado real.

grupo('IMPEDE 3 e 4 — o expurgo existe, e a caixa parou de mentir');

teste('a caixa não promete mais apagar', () => {
  const bloco = /<input type="checkbox" id="substituir">[\s\S]*?<\/div>/.exec(ADMIN)[0];

  verdadeiro(bloco.indexOf('apaga tudo que foi importado antes') === -1,
    'a frase que mentia voltou');
  verdadeiro(/não apaga nada/.test(bloco), bloco);
  verdadeiro(/Importações/.test(bloco),
    'quem quer apagar de verdade precisa saber para onde ir');
});

teste('a aba Importações oferece o expurgo, e o servidor responde', () => {
  verdadeiro(/expurgarLoteUI/.test(ADMIN), 'sem botão, a saída de emergência não existe na prática');
  verdadeiro(/chamar\('expurgarLote'/.test(ADMIN));

  const importacao = fs.readFileSync(path.join(PASTA_GS, '05_Importacao.gs'), 'utf8');
  verdadeiro(/function expurgarLote\s*\(/.test(importacao));
});

teste('a tela conta antes de perguntar, e pergunta antes de apagar', () => {
  const trecho = /function expurgarLoteUI[\s\S]*?\n  }\n/.exec(ADMIN)[0];

  verdadeiro(/contarApenas: true/.test(trecho),
    'perguntar "tem certeza?" sem o número é pedir decisão às cegas sobre a lista oficial');
  verdadeiro(/confirm\(/.test(trecho), 'apagar em massa sem confirmação não pode');
  verdadeiro(trecho.indexOf('c.total') < trecho.indexOf('confirm('),
    'o número tem de estar na frase da confirmação, não depois dela');
  verdadeiro(/não tem desfazer/.test(trecho), trecho);
});

teste('a mensagem de recusa de colecaoCompleta_ agora tem um caminho de verdade', () => {
  // Ela mandava "Reduza a coleção (lotes antigos de matriculados são o caso
  // comum)" sem existir função, botão ou caminho para reduzir — a instrução
  // apontava para um lugar que não existia.
  const recon = fs.readFileSync(path.join(PASTA_GS, '06_Reconciliacao.gs'), 'utf8');
  const recusa = /'A coleção "' \+ colecao[\s\S]*?\);/.exec(recon);
  verdadeiro(recusa, 'a mensagem de recusa sumiu; este teste precisa de outra âncora');

  verdadeiro(/Apagar matriculados/.test(recusa[0]),
    'a recusa tem de nomear o botão que resolve: ' + recusa[0]);
  verdadeiro(/Importações/.test(recusa[0]), 'e a aba onde ele está');

  const importacao = fs.readFileSync(path.join(PASTA_GS, '05_Importacao.gs'), 'utf8');
  verdadeiro(/function expurgarLote\s*\(/.test(importacao),
    'sem expurgo, a recusa da reconciliação vira um beco sem saída');
  verdadeiro(/Apagar matriculados/.test(ADMIN),
    'e o botão precisa existir na tela com esse mesmo nome');
});

// ============================================================ INCOMODA 6, 7, 8, 10, 12

grupo('INCOMODA — o que a tela mostrava errado');

teste('6 · a matrícula é obrigatória na tela, e o telefone tem onde ser mapeado', () => {
  const bloco = /var CAMPOS_IMPORTACAO = \[[\s\S]*?\];/.exec(ADMIN)[0];

  verdadeiro(/\{ chave: 'matricula'[^}]*obrigatorio: true/.test(bloco),
    'o servidor recusa o arquivo sem matrícula DEPOIS do upload; a tela tem de pedir antes');
  verdadeiro(/chave: 'telefone'/.test(bloco),
    '05b_FormatoAcademico.gs extrai telefone e a tela descartava por não ter a linha');
});

teste('6 · o Confirmar confere todo campo obrigatório, e não só o nome', () => {
  // O corte era em `botao.disabled = true;` — a linha que travava o botão à mão.
  // Ela saiu em 11/08: quem trava é o `aoGravar` da marcação e quem destrava é o
  // `chamar()`, porque o destravamento daqui só acontecia no sucesso e um
  // `Failed to fetch` deixava "Importando..." travado para sempre. A conferência
  // que este teste guarda não mudou uma vírgula; mudou onde ela termina, que
  // agora é a chamada ao servidor.
  const trecho = /function confirmarImportacaoUI[\s\S]*?chamar\('confirmarImportacao'/.exec(ADMIN)[0];

  verdadeiro(/c\.obrigatorio/.test(trecho),
    'a conferência precisa sair da lista, senão o próximo campo obrigatório é esquecido');
  verdadeiro(trecho.indexOf("mapeamento.nome === undefined") === -1,
    'a conferência de um campo só voltou');
});

teste('7 · o aviso da importação é desenhado', () => {
  // `r.aviso` traz "N linhas sem matrícula foram ignoradas", "N repetidas" e o
  // aviso do substituir. O servidor sempre mandou; a tela nunca desenhou.
  const trecho = /irParaPasso\(3\);[\s\S]*?pos-importacao'\)\.innerHTML/.exec(ADMIN)[0];
  verdadeiro(/r\.aviso/.test(trecho), 'os números descartados sumiam sem deixar rastro');
});

teste('8 · o aviso da reconciliação chega à tela, nos dois lugares', () => {
  // "N linhas ficaram sem origem e NÃO foram apagadas" ia só para o log.
  const botao = /function reconciliarAgora[\s\S]*?\n  }/.exec(ADMIN)[0];
  verdadeiro(/s\.aviso/.test(botao), 'aba Painel: ' + botao.slice(0, 120));

  const passo3 = /function reconciliarAposImportar[\s\S]*?\n  }/.exec(ADMIN)[0];
  verdadeiro(/s\.aviso/.test(passo3), 'passo 3 da importação');
});

teste('10 · o painel e o servidor concordam sobre onde o painel mora', () => {
  // Duas metades do mesmo endereço, escritas em arquivos diferentes: o painel
  // usa BASE_SITE para montar seus próprios links, e o servidor usa o padrão de
  // `url_painel` para montar o LINK DE ACESSO que vai por e-mail.
  //
  // Divergir não quebra nada visível: o painel continua abrindo, os testes
  // continuam verdes, e o sintoma aparece só quando alguém não consegue entrar e
  // pede um link — que chega apontando para um endereço que não é este. É o tipo
  // de erro que se descobre no pior dia possível, com a pessoa já trancada do
  // lado de fora.
  const linha = /var BASE_SITE = '([^']+)'/.exec(ADMIN);
  verdadeiro(linha, 'BASE_SITE sumiu');

  const config = fs.readFileSync(path.join(PASTA_GS, '00_Config.gs'), 'utf8');
  const padrao = /chave: 'url_painel', valor: '([^']+)'/.exec(config);
  verdadeiro(padrao, 'o padrão de url_painel sumiu de CONFIG_PADRAO');

  const origem = (u) => (/^https:\/\/[^/]+/.exec(u) || [''])[0];
  igual(origem(padrao[1]), origem(linha[1]),
    'o painel diz ' + linha[1] + ' e o link por e-mail diria ' + padrao[1]);

  // E nenhum dos dois pode apontar para o sistema anterior, sobre planilha.
  verdadeiro(!/github\.io\/cesutech$/.test(linha[1]),
    'aponta para o site do sistema ANTIGO: ' + linha[1]);
});

teste('12 · a caixa de inscrições lê o campo, e não deduz da situação', () => {
  const bloco = /id="pj-abertas"[\s\S]{0,120}/.exec(ADMIN)[0];

  verdadeiro(/p\.inscricoes_abertas/.test(bloco), bloco);
  verdadeiro(bloco.indexOf("p.situacao !== 'FECHADO'") === -1,
    'deduzir de situacao reabre em silêncio as inscrições de todo projeto INATIVO');

  const projetos = fs.readFileSync(path.join(PASTA_GS, '09_Projetos.gs'), 'utf8');
  verdadeiro(/inscricoes_abertas: String\(p\.inscricoes_abertas\)/.test(projetos),
    'e o servidor precisa mandar o campo, senão a tela não tem o que ler');
});

// ---------------------------------------------------------------- Resultado

process.exit(resultado());
