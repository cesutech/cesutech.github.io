/**
 * config-log.js — testa a configuração (03_Config.gs) e a trilha de auditoria
 * (04_Log.gs) sem tocar no Google.
 *
 * O que está sendo provado aqui é o que 07_Auth.gs precisa para rodar:
 * `config()`, `usuarioAtual()` e `registrar()` existem, respondem o contrato do
 * projeto sobre Sheets e custam o mínimo de leitura possível. O último grupo
 * carrega 07_Auth.gs e 07b_LinkPorEmail.gs e faz um login inteiro pelo link por
 * e-mail — é a prova de que não sobrou função órfã depois que o PIN saiu.
 *
 * Uso:  node testes/config-log.js
 */

'use strict';

const crypto = require('crypto');

const {
  RAIZ, teste, grupo, igual, verdadeiro, resultado, criarAmbiente, criarRelogio, ultima
} = require('./apoio');

const GS_BASE = ['00_Config.gs', '01_Utils.gs', '02_Repo.gs', '03_Config.gs', '04_Log.gs'];
const GS_COM_AUTH = GS_BASE.concat(['07_Auth.gs', '07b_LinkPorEmail.gs']);

/** 2026-08-05T22:50:12.123Z — 19:50:12 em São Paulo. */
const INSTANTE = Date.UTC(2026, 7, 5, 22, 50, 12, 123);

function ambiente(opcoes) {
  return criarAmbiente(Object.assign({ arquivos: GS_BASE }, opcoes || {}));
}

/** Campos de um documento gravado no falso, já desembrulhados para texto. */
function campos(falso, chave) {
  const documento = falso.documentos.get(chave) || {};
  const obj = {};
  Object.keys(documento).forEach((c) => { obj[c] = documento[c].stringValue; });
  return obj;
}

function chavesDaColecao(falso, colecao) {
  return Array.from(falso.documentos.keys()).filter((k) => k.indexOf(colecao + '/') === 0).sort();
}

/**
 * Ambiente com 07_Auth.gs, 07b_LinkPorEmail.gs e um correio de mentira.
 *
 * O `apoio.js` não tem MailApp nem SHA-256 — ele nasceu antes das duas coisas
 * existirem no projeto —, então os dois são montados aqui:
 *
 *   MailApp    guarda as mensagens em vez de enviá-las, e a cota de envio é
 *              regulável: `enviarLink_` desiste quando ela zera, e esse ramo só
 *              se exercita se o teste puder zerá-la;
 *   SHA-256    o falso de `apoio.js` responde MD5 para qualquer algoritmo. O
 *              tamanho do digest não muda o comportamento de `impressaoDoLink_`,
 *              mas um teste que confere hash tem de conferir o hash de verdade.
 */
function ambienteComLink(opcoes) {
  opcoes = opcoes || {};
  const amb = criarAmbiente({ arquivos: GS_COM_AUTH, usuario: opcoes.usuario === undefined ? '' : opcoes.usuario });

  amb.api.Utilities.DigestAlgorithm.SHA_256 = 'SHA_256';
  const digestPadrao = amb.api.Utilities.computeDigest;
  amb.api.Utilities.computeDigest = (algoritmo, texto) => {
    if (algoritmo !== 'SHA_256') return digestPadrao(algoritmo, texto);
    return Array.from(crypto.createHash('sha256').update(String(texto), 'utf8').digest())
      .map((b) => (b > 127 ? b - 256 : b));
  };

  const correio = { enviados: [], cota: 100 };
  amb.api.MailApp = {
    getRemainingDailyQuota: () => correio.cota,
    sendEmail(mensagem) { correio.enviados.push(mensagem); correio.cota--; }
  };
  amb.correio = correio;

  return amb;
}

/** O token que viajou dentro do corpo da última mensagem. */
function tokenDoEmail(amb) {
  const corpo = amb.correio.enviados[amb.correio.enviados.length - 1].body;
  const achado = /\?entrar=([0-9a-f]{64})/.exec(corpo);
  verdadeiro(achado !== null, 'o corpo do e-mail não trouxe link nenhum:\n' + corpo);
  return achado[1];
}

// ============================================================================

console.log('\n\x1b[1mUNICESUSC CESUTECH — configuração e log (03_Config.gs, 04_Log.gs)\x1b[0m');

grupo('Configuração: um documento só, lido uma vez por execução');

teste('lerConfig lê UM documento, e o segundo pedido não vai à rede', () => {
  const { api, falso } = ambiente();
  api.atualizar('config', 'geral', { cadastro_aberto: 'SIM' });
  falso.requisicoes.length = 0;

  igual(api.lerConfig(), { cadastro_aberto: 'SIM' });
  igual(api.lerConfig(), { cadastro_aberto: 'SIM' });

  igual(falso.requisicoes.length, 1, 'a segunda leitura tem de vir do cache');
  igual(ultima(falso).url, RAIZ + '/config/geral');
});

teste('config() chamada cinco vezes custa uma leitura, não cinco', () => {
  const { api, falso } = ambiente();
  api.atualizar('config', 'geral', { vagas_padrao: '60', cadastro_aberto: 'SIM' });
  falso.requisicoes.length = 0;

  for (let i = 0; i < 5; i++) api.config('vagas_padrao', '30');
  igual(falso.requisicoes.length, 1);
});

teste('metadados do Repo (_id, _nome) não viram chave de configuração', () => {
  const { api } = ambiente();
  api.atualizar('config', 'geral', { cadastro_aberto: 'SIM' });

  igual(Object.keys(api.lerConfig()), ['cadastro_aberto']);
});

teste('chave ausente e chave vazia devolvem o padrão; sem padrão, devolvem \'\'', () => {
  const { api } = ambiente();
  api.atualizar('config', 'geral', { form_id: '' });

  igual(api.config('chave_que_nunca_existiu', 'padrão'), 'padrão', 'ausente');
  igual(api.config('form_id', 'nenhum'), 'nenhum', 'vazia vale como ausente');
  igual(api.config('form_id'), '', 'sem padrão');
});

teste('banco vazio não quebra: lerConfig devolve {} e config devolve o padrão', () => {
  const { api } = ambiente();
  igual(api.lerConfig(), {});
  igual(api.config('cadastro_aberto', 'SIM'), 'SIM');
});

grupo('Configuração: gravação');

teste('gravarConfig mexe em um campo só, cria o documento e não relê o banco', () => {
  const { api, falso } = ambiente();
  api.gravarConfig('cadastro_aberto', 'NAO');

  igual(falso.requisicoes.length, 1, 'gravar não pode custar uma leitura antes');
  igual(ultima(falso).metodo, 'PATCH');
  igual(ultima(falso).url, RAIZ + '/config/geral?updateMask.fieldPaths=cadastro_aberto');
  igual(campos(falso, 'config/geral'), { cadastro_aberto: 'NAO' });
});

teste('gravar uma chave não apaga as outras do documento', () => {
  const { api, falso } = ambiente();
  api.gravarConfig('cadastro_aberto', 'SIM');
  api.gravarConfig('vagas_padrao', '60');
  api.gravarConfig('cadastro_aberto', 'NAO');

  igual(campos(falso, 'config/geral'), { cadastro_aberto: 'NAO', vagas_padrao: '60' });
});

teste('depois de gravar, config() responde o valor novo sem nova leitura', () => {
  const { api, falso } = ambiente();
  api.lerConfig();
  falso.requisicoes.length = 0;

  api.gravarConfig('cadastro_aberto', 'NAO');
  igual(api.config('cadastro_aberto', 'SIM'), 'NAO');
  igual(falso.requisicoes.length, 1, 'só o PATCH');
});

teste('limparCacheConfig obriga a próxima leitura a ir ao banco', () => {
  const { api, falso } = ambiente();
  api.lerConfig();
  api.limparCacheConfig();
  falso.requisicoes.length = 0;

  api.lerConfig();
  igual(falso.requisicoes.length, 1);
  igual(ultima(falso).metodo, 'GET');
});

// ---------------------------------------------------------------------------
// CONFIG_SEGREDOS ficou VAZIO quando o PIN saiu do sistema, e o mecanismo
// continua de pé (03_Config.gs explica por quê). Os três testes abaixo o
// exercitam FINGINDO que `form_id` é segredo: não há segredo de verdade hoje, e
// um mecanismo sem teste é um mecanismo que ninguém descobre estar quebrado no
// dia em que voltar a haver um — que é justamente o dia em que ele importa.
//
// `form_id` foi escolhida porque está em CONFIG_PADRAO: é o que permite provar
// também que `semearConfigPadrao_` não semeia segredo.
const SEGREDO_DE_MENTIRA = 'FORM_ID_SECRETO';

function ambienteComSegredo() {
  const amb = ambiente();
  amb.api.CONFIG_SEGREDOS.form_id = SEGREDO_DE_MENTIRA;
  return amb;
}

grupo('CONFIG_SEGREDOS: o mapa esvaziou, o mecanismo não');

teste('o mapa de segredos está vazio — nenhuma chave de hoje mora fora do banco', () => {
  const { api } = ambiente();
  igual(Object.keys(api.CONFIG_SEGREDOS), [],
    'apareceu um segredo: confira se lerConfiguracoes e salvarConfiguracao o escondem');
});

teste('chave marcada como segredo não fala com o Firestore — vai para a propriedade', () => {
  const { api, falso, propriedades } = ambienteComSegredo();
  api.gravarConfig('form_id', 4321);

  igual(falso.requisicoes.length, 0, 'nenhuma chamada ao banco');
  igual(propriedades.get(SEGREDO_DE_MENTIRA), '4321');
  igual(falso.documentos.has('config/geral'), false,
    'segredo no documento que o formulário público lê é segredo de todo mundo');
});

teste('config() de um segredo lê a propriedade, e sem ela devolve o padrão', () => {
  const { api, propriedades } = ambienteComSegredo();
  igual(api.config('form_id', ''), '', 'sem a propriedade');

  propriedades.set(SEGREDO_DE_MENTIRA, '4321');
  igual(api.config('form_id', ''), '4321');
});

teste('valor plantado no documento é ignorado — a fonte é a propriedade', () => {
  const { api, propriedades } = ambienteComSegredo();
  api.atualizar('config', 'geral', { form_id: '0000' });
  propriedades.set(SEGREDO_DE_MENTIRA, '4321');

  igual(api.config('form_id', ''), '4321');
});

grupo('semearConfigPadrao_');

teste('semeia CONFIG_PADRAO inteiro numa escrita só', () => {
  const { api, falso } = ambiente();
  const criadas = api.semearConfigPadrao_();

  const esperadas = api.CONFIG_PADRAO.map((c) => c.chave);

  igual(criadas, esperadas);
  igual(Object.keys(campos(falso, 'config/geral')).sort(), esperadas.slice().sort());
  igual(falso.requisicoes.filter((r) => r.metodo === 'PATCH').length, 1, 'um PATCH para tudo');
});

teste('e deixa de fora o que estiver em CONFIG_SEGREDOS', () => {
  const { api, falso, propriedades } = ambienteComSegredo();
  const criadas = api.semearConfigPadrao_();

  igual(criadas.indexOf('form_id'), -1, 'segredo semeado é segredo com valor padrão conhecido');
  igual(campos(falso, 'config/geral').form_id, undefined);
  igual(propriedades.has(SEGREDO_DE_MENTIRA), false, 'nem na propriedade: segredo não nasce pronto');
});

teste('a descrição da chave fica no código, não no banco', () => {
  const { api, falso } = ambiente();
  api.semearConfigPadrao_();

  const gravados = Object.keys(campos(falso, 'config/geral'));
  igual(gravados.filter((c) => c.indexOf('descricao') !== -1), []);
  igual(campos(falso, 'config/geral').cadastro_aberto, 'SIM');
});

teste('NÃO sobrescreve o que a coordenação já mudou', () => {
  const { api, falso } = ambiente();
  api.gravarConfig('texto_esgotado', 'Turma lotada, procure a coordenação.');
  api.gravarConfig('cadastro_aberto', 'NAO');

  const criadas = api.semearConfigPadrao_();

  igual(criadas.indexOf('texto_esgotado'), -1, 'chave existente não pode ser recriada');
  igual(campos(falso, 'config/geral').texto_esgotado, 'Turma lotada, procure a coordenação.');
  igual(campos(falso, 'config/geral').cadastro_aberto, 'NAO');
});

teste('semear duas vezes seguidas: a segunda não escreve nada', () => {
  const { api, falso } = ambiente();
  api.semearConfigPadrao_();
  const escritas = falso.requisicoes.length;

  igual(api.semearConfigPadrao_(), []);
  igual(falso.requisicoes.length, escritas, 'a segunda passada não pode custar escrita');
});

grupo('configLista');

teste('cursos_fases semeado vira lista de opções, sem espaço sobrando', () => {
  const { api } = ambiente();
  api.semearConfigPadrao_();

  const cursos = api.configLista('cursos_fases');
  igual(cursos.length, 13);
  igual(cursos[0], 'WORK EXPERIENCE - ADM21');
  igual(cursos[12], 'PROJETO INTERDISCIPLINAR II EM MULTIMÍDIA - PMM31');
});

teste('separador com espaço em volta e item vazio não viram opção', () => {
  const { api } = ambiente();
  api.gravarConfig('turnos', ' Matutino | Noturno ||');

  igual(api.configLista('turnos'), ['Matutino', 'Noturno']);
});

teste('chave inexistente devolve lista vazia, não [\'\']', () => {
  const { api } = ambiente();
  igual(api.configLista('turnos'), []);
});

grupo('Log: o id carrega a hora');

teste('registrar grava os campos da trilha, com hora local legível', () => {
  const relogio = criarRelogio(INSTANTE);
  const { api, falso } = ambiente({ relogio, usuario: 'gestao@exemplo.com' });

  api.registrar('LOGIN', 'painel', 'gestao@exemplo.com', 'via link por e-mail');

  const chave = chavesDaColecao(falso, 'log')[0];
  igual(campos(falso, chave), {
    // `criado_em` é o campo por onde `ultimosRegistros` ordena, e é o mesmo
    // carimbo que abre o id — se um dia divergirem, a ordem da tela deixa de
    // bater com a ordem do id.
    criado_em: '20260805T225012123Z',
    timestamp: '2026-08-05 19:50:12',
    usuario: 'gestao@exemplo.com',
    acao: 'LOGIN',
    entidade: 'painel',
    entidade_id: 'gestao@exemplo.com',
    detalhe: 'via link por e-mail',
    expira_em: '2027-08-05T22:50:12.123Z'
  });
});

teste('o id começa pelo carimbo UTC, sem separador, e traz sufixo aleatório', () => {
  const relogio = criarRelogio(INSTANTE);
  const { api, falso } = ambiente({ relogio });
  api.registrar('LOGIN', 'painel', 'x', '');

  const id = chavesDaColecao(falso, 'log')[0].split('/')[1];
  verdadeiro(/^20260805T225012123Z_[0-9a-f]{6}$/.test(id), 'id foi ' + id);
});

teste('ids gravados em instantes diferentes ordenam como o tempo ordena', () => {
  const relogio = criarRelogio(INSTANTE);
  const { api, falso } = ambiente({ relogio });

  const acoes = ['PRIMEIRA', 'SEGUNDA', 'TERCEIRA'];
  acoes.forEach((acao) => {
    api.registrar(acao, 'painel', '', '');
    relogio.avancar(1500);
  });

  // Ordem alfabética dos ids tem de bater com a ordem de gravação — é isso que
  // permite trocar "varrer a coleção" por orderBy + limit.
  const ids = chavesDaColecao(falso, 'log');
  igual(ids.slice().sort(), ids);
  igual(ids.map((k) => campos(falso, k).acao), acoes);
});

teste('dois registros no mesmo milissegundo não se perdem', () => {
  const relogio = criarRelogio(INSTANTE);
  const { api, falso } = ambiente({ relogio });

  // Sem o sufixo aleatório, o segundo `inserir` bateria em ALREADY_EXISTS e o
  // evento sumiria — colisão de id aqui não é registro duplicado, é registro
  // perdido.
  api.registrar('LOGIN', 'painel', '', '');
  api.registrar('LOGIN_FALHOU', 'painel', '', '');

  igual(chavesDaColecao(falso, 'log').length, 2);
});

// Ordena por `criado_em`, NÃO por `__name__`. O Firestore real recusa
// `__name__` DESC com 400 "The query requires an index": o índice automático
// desse campo só cobre ascendente. Campo comum ganha os dois sentidos de graça.
// Descoberto rodando contra o banco de verdade, não contra este falso — que
// aceitava as duas formas sem reclamar.
teste('ultimosRegistros ordena por criado_em decrescente com limite, sem exigir índice', () => {
  const relogio = criarRelogio(INSTANTE);
  const { api, falso } = ambiente({ relogio });

  ['PRIMEIRA', 'SEGUNDA', 'TERCEIRA'].forEach((acao) => {
    api.registrar(acao, 'painel', '', '');
    relogio.avancar(1000);
  });

  const ultimos = api.ultimosRegistros(2);
  igual(ultimos.map((r) => r.acao), ['TERCEIRA', 'SEGUNDA']);
  igual(ultima(falso).corpo.structuredQuery, {
    from: [{ collectionId: 'log' }],
    orderBy: [{ field: { fieldPath: 'criado_em' }, direction: 'DESCENDING' }],
    limit: 2
  });
});

teste('ultimosRegistros tem teto e padrão — ninguém pede a coleção inteira', () => {
  const { api, falso } = ambiente();
  api.ultimosRegistros();
  igual(ultima(falso).corpo.structuredQuery.limit, 50, 'padrão');

  api.ultimosRegistros(99999);
  igual(ultima(falso).corpo.structuredQuery.limit, 500, 'teto');
});

grupo('Log: falhar registrando não pode derrubar a operação');

teste('Firestore fora do ar: registrar não lança, e o erro vai para o console', () => {
  const { api, falso, registros } = ambiente();
  falso.forcar(500, 'INTERNAL', 'backend error');

  api.registrar('INSCRICAO', 'inscricoes', 'insc_1', 'aluno gravado');

  igual(chavesDaColecao(falso, 'log').length, 0, 'o log não foi gravado');
  igual(registros.erros.length, 1, 'mas o console soube');
  verdadeiro(registros.erros[0].indexOf('Falha ao registrar log') === 0, registros.erros[0]);
});

teste('sem FIRESTORE_PROJETO, registrar continua sem lançar', () => {
  const { api } = ambiente({ projeto: null });
  api.registrar('LOGIN', 'painel', '', '');
});

teste('detalhe em objeto vira JSON; detalhe ausente vira {}', () => {
  const { api, falso } = ambiente();
  api.registrar('IMPORTACAO', 'lotes', 'lote_1', { linhas: 320, arquivo: 'turmas.xlsx' });
  api.registrar('LOGIN', 'painel', '');

  const [primeiro, segundo] = chavesDaColecao(falso, 'log')
    .map((k) => campos(falso, k))
    .sort((a, b) => (a.acao < b.acao ? -1 : 1));

  igual(primeiro.detalhe, '{"linhas":320,"arquivo":"turmas.xlsx"}');
  igual(segundo.detalhe, '{}');
});

grupo('usuarioAtual');

teste('devolve o e-mail da sessão quando o Google o mostra', () => {
  const { api } = ambiente({ usuario: 'gestao@exemplo.com' });
  igual(api.usuarioAtual(), 'gestao@exemplo.com');
});

teste('conta comum em web app anônimo: e-mail vazio vira \'anonimo\'', () => {
  const { api } = ambiente({ usuario: '' });
  igual(api.usuarioAtual(), 'anonimo');
});

teste('Session lançando (sem escopo autorizado) também vira \'anonimo\'', () => {
  const { api } = ambiente({ usuario: null });
  igual(api.usuarioAtual(), 'anonimo');
});

grupo('07_Auth.gs e 07b_LinkPorEmail.gs rodam — nenhuma função órfã sobrou');

teste('login por LINK devolve token, e o LOGIN fica na trilha COM NOME', () => {
  // O PIN gravava 'anonimo' em `usuario` e em `entidade_id`, e um registro de
  // auditoria que não identifica ninguém não é registro. O link identifica
  // exatamente um endereço da allowlist — é a diferença que justificou a troca.
  const amb = ambienteComLink();
  amb.api.semearConfigPadrao_();
  amb.api.gravarConfig('admin_emails', 'gestao@exemplo.com');

  igual(amb.api.pedirLinkDeAcesso('Gestao@Exemplo.com').ok, true);
  igual(amb.correio.enviados.length, 1);

  const r = amb.api.entrarComLink(tokenDoEmail(amb));

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.via, 'link');
  igual(r.usuario, 'gestao@exemplo.com');
  verdadeiro(r.token && r.token.length > 20, 'token foi ' + r.token);
  verdadeiro(amb.propriedades.has('sess_' + r.token), 'a sessão deveria estar guardada');
  igual(amb.api.sessaoAtiva(r.token), { ok: true });

  // Sem ordenar: os dois registros podem cair no mesmo milissegundo, e aí quem
  // decide a ordem do id é o sufixo aleatório. Ordem de log tem teste próprio,
  // com relógio na mão; o que importa aqui é que as duas linhas existam.
  const trilha = chavesDaColecao(amb.falso, 'log').map((k) => campos(amb.falso, k));
  igual(trilha.map((l) => l.acao).sort(), ['LINK_ENVIADO', 'LOGIN']);

  const login = trilha.filter((l) => l.acao === 'LOGIN')[0];
  igual(login.detalhe, 'via link por e-mail');
  igual(login.entidade_id, 'gestao@exemplo.com');
});

teste('link inventado é recusado, sem token e sem linha de LOGIN', () => {
  const amb = ambienteComLink();
  amb.api.gravarConfig('admin_emails', 'gestao@exemplo.com');

  const r = amb.api.entrarComLink('f'.repeat(64));

  igual(r.ok, false);
  igual(r.token, undefined);
  verdadeiro(/não vale mais/.test(r.erro), r.erro);
  igual(chavesDaColecao(amb.falso, 'log').length, 0, 'chutar link não pode virar escrita');
});

teste('conta na allowlist entra pela identidade da implantação, quando ela existe', () => {
  // O caminho 1 de `autenticar()`, que hoje nunca dispara em produção
  // (USER_DEPLOYING + conta Gmail comum devolve 'anonimo') e vale numa
  // implantação Workspace. Ele perdeu o argumento junto com o PIN.
  const amb = ambienteComLink({ usuario: 'gestao@exemplo.com' });
  amb.api.gravarConfig('admin_emails', 'Gestao@Exemplo.com, outra@exemplo.com');

  const r = amb.api.autenticar();

  igual(r.ok, true, 'erro foi: ' + r.erro);
  igual(r.via, 'email');
  igual(r.usuario, 'gestao@exemplo.com');
  igual(chavesDaColecao(amb.falso, 'log').map((k) => campos(amb.falso, k).detalhe),
    ['via identidade da implantação']);
});

teste('sem identidade visível, autenticar aponta o botão do Google e não pede segredo', () => {
  const amb = ambienteComLink();
  amb.api.semearConfigPadrao_();

  const r = amb.api.autenticar();

  igual(r.ok, false);
  verdadeiro(/Entrar com o Google/.test(r.erro), r.erro);
  igual(/PIN/i.test(r.erro), false, 'a frase ainda manda digitar um PIN que não existe: ' + r.erro);
});

teste('modoDeAcesso avisa que a allowlist está vazia', () => {
  const amb = ambienteComLink();
  amb.api.semearConfigPadrao_();

  igual(amb.api.modoDeAcesso(), {
    ok: true,
    identidadeVisivel: false,
    usuario: '',
    // O único estado em que NENHUMA das duas portas remotas funciona: o botão do
    // Google recusaria todo mundo e não há endereço para onde mandar link. A
    // tela precisa deste bit para dizer a saída (`liberarAcesso()` no editor).
    allowlistVazia: true,
    // E o mesmo motivo pelo outro lado: sem lista, pedir link não vira e-mail
    // nenhum, e oferecer o campo seria prometer uma mensagem que não vem.
    linkDisponivel: false,
    // Sem client id e sem allowlist, o botão do Google não é anunciado: ele
    // recusaria todo mundo, e o professor concluiria que a conta dele é o
    // problema. `clientId` sai mesmo assim porque é o navegador que precisa
    // dele — e ele é público por construção.
    google: { disponivel: false, clientId: '' }
  });
});

teste('e não devolve mais modo, pedePin nem googleProvado', () => {
  // Os três nasceram do PIN. Enquanto o painel novo não é implantado, a página
  // antiga ainda lê `pedePin` — e ler `undefined` é o que a faz esconder o campo
  // em vez de mostrar um campo que não tem para onde enviar.
  const amb = ambienteComLink();
  amb.api.semearConfigPadrao_();

  const m = amb.api.modoDeAcesso();
  ['modo', 'pedePin', 'googleProvado'].forEach((campo) => {
    igual(m[campo], undefined, 'a tela de login ainda recebe "' + campo + '"');
  });
});

grupo('registrarRecusa: recusa em massa não vira escrita em massa');

// Este grupo existe por causa de um buraco que os 213 testes anteriores não
// pegavam, e não pegavam por um motivo específico: o `apoio.js` não tinha
// CacheService. `registrarRecusa` engolia a ausência no catch e caía no registro
// direto, então tudo passava sem exercitar uma linha do agrupamento. O falso
// ganhou um CacheService com expiração presa ao relógio para estes testes.

teste('a primeira recusa da janela grava; as seguintes, não', () => {
  const { api, falso } = criarAmbiente({ arquivos: GS_BASE, relogio: criarRelogio(INSTANTE) });

  for (let i = 0; i < 50; i++) {
    api.registrarRecusa('BLOQUEIO', 'inscricao', '', 'honeypot preenchido', 'honeypot');
  }

  igual(chavesDaColecao(falso, 'log').length, 1, '50 recusas, 1 documento');
});

teste('cada motivo tem a própria janela — um não abafa o outro', () => {
  const { api, falso } = criarAmbiente({ arquivos: GS_BASE, relogio: criarRelogio(INSTANTE) });

  api.registrarRecusa('BLOQUEIO', 'inscricao', '', 'honeypot', 'honeypot');
  api.registrarRecusa('BLOQUEIO', 'inscricao', '', 'honeypot', 'honeypot');
  api.registrarRecusa('BLOQUEIO', 'inscricao', '', 'sem origem', 'sem_origem');
  api.registrarRecusa('BLOQUEIO', 'inscricao', '', 'rápido demais', 'rapido_demais');

  igual(chavesDaColecao(falso, 'log').length, 3, 'três motivos, três documentos');
});

teste('a janela reabre, e a gravação seguinte diz quantas foram engolidas', () => {
  const relogio = criarRelogio(INSTANTE);
  const { api, falso } = criarAmbiente({ arquivos: GS_BASE, relogio });

  api.registrarRecusa('BLOQUEIO', 'inscricao', '', 'honeypot', 'honeypot');
  for (let i = 0; i < 9; i++) {
    api.registrarRecusa('BLOQUEIO', 'inscricao', '', 'honeypot', 'honeypot');
  }

  relogio.avancar(601 * 1000);
  api.registrarRecusa('BLOQUEIO', 'inscricao', '', 'honeypot', 'honeypot');

  const detalhes = chavesDaColecao(falso, 'log').map((k) => campos(falso, k).detalhe);
  igual(detalhes.length, 2, 'duas janelas, dois documentos');
  verdadeiro(
    detalhes.some((d) => d.indexOf('+9 iguais desde a última anotação') !== -1),
    'a segunda anotação conta as engolidas: ' + JSON.stringify(detalhes)
  );
});

teste('sem CacheService, registra direto — perder a trilha é pior que a escrita', () => {
  const ambiente = criarAmbiente({ arquivos: GS_BASE, relogio: criarRelogio(INSTANTE) });
  delete ambiente.api.CacheService;

  ambiente.api.registrarRecusa('BLOQUEIO', 'inscricao', '', 'honeypot', 'honeypot');
  ambiente.api.registrarRecusa('BLOQUEIO', 'inscricao', '', 'honeypot', 'honeypot');

  igual(chavesDaColecao(ambiente.falso, 'log').length, 2, 'sem cache, cada recusa grava');
});

// ---------------------------------------------------------------- Resultado

process.exit(resultado());
