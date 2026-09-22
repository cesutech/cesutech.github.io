/**
 * site.js — os testes do site público (docs/index.html + assets/app.js).
 *
 * O que este arquivo prova, e o que ele não prova:
 *
 *   - o app.js roda de verdade, num navegador falso (`dom-falso.js`), e os
 *     testes NAVEGAM: entram num projeto, voltam, preenchem, enviam. Quando um
 *     teste diz "voltar para a lista pede os projetos de novo", ele contou as
 *     requisições que saíram;
 *   - o que é estrutura de arquivo — atributo declarado no HTML, decisão
 *     registrada em comentário, classe que existe no CSS — é conferido no
 *     TEXTO, como já fazem `api.js` e `consertos.js`;
 *   - o que SÓ o navegador prova está listado no fim deste comentário e não é
 *     testado aqui, para nenhum teste dar a impressão de cobrir o que não cobre.
 *
 * A rodada de 06/08 nasceu dos pontos levantados no uso real. O mais repetido —
 * três vezes — foi a lista que não atualizava ao voltar. O grupo "item 1" existe
 * por causa dele, e o teste que importa é "voltar para a lista pede a lista de
 * novo, sem trava de tempo".
 *
 * O grupo das caixas de aceite guarda o contrário de uma mudança: ele existe
 * para que marcá-las e travá-las — ideia levantada e recusada em 06/08 — não
 * volte por descuido.
 *
 * SÓ O NAVEGADOR PROVA:
 *   - que o cartão de vagas realmente aparece à direita, e que o resumo do
 *     comprovante cabe numa foto de celular (é layout, e aqui não há layout);
 *   - o pulso do selo "conferindo", o `prefers-reduced-motion` e qualquer coisa
 *     que dependa de CSS aplicado;
 *   - o foco, a rolagem e o aviso de "não feche esta página" do `beforeunload`;
 *   - a persistência do `localStorage` entre ABAS e entre visitas de dias
 *     diferentes. Aqui o que se prova é que a lembrança sobrevive a uma
 *     recarga da página, reabrindo o site com o mesmo armazenamento.
 *
 * E, da pergunta da TROCA DE PROJETO (22/09) — aqui se prova que o bloco existe,
 * que ele tem `role="alertdialog"` e que os dois botões estão lá; o que falta é
 * do navegador, e vale um olhar na homologação, junto do teste das duas abas:
 *   - que o leitor de tela ANUNCIA o `alertdialog` quando ele aparece no meio do
 *     formulário, e que o foco entra nele de verdade (`focus()` num elemento com
 *     `tabindex="-1"` é coisa de navegador);
 *   - que os dois botões, um sob o outro, não deixam o [Trocar para Y e cancelar
 *     X] a um polegar de distância do [Manter] no celular — é layout, e cancelar
 *     por engano é o erro que não tem desfazer pela tela do aluno.
 *
 * Uso:  node testes/site.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { teste, grupo, igual, verdadeiro, resultado } = require('./apoio');
const { abrirSite, siteCarregado, acharClicavel, PROJETOS_PADRAO } = require('./dom-falso');

const PASTA_SITE = path.join(__dirname, '..', 'docs');
const APP = fs.readFileSync(path.join(PASTA_SITE, 'assets', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(PASTA_SITE, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(PASTA_SITE, 'assets', 'estilos.css'), 'utf8');

/**
 * Preenche e envia o formulário do projeto que estiver aberto.
 *
 * Marca só os dois aceites obrigatórios e deixa a autorização de imagem EM
 * BRANCO — de propósito: é o aluno que não quer ser fotografado, e ele tem de
 * conseguir se inscrever assim. Quem quiser o contrário passa `imagem: true`.
 */
async function inscrever(cena, opcoes) {
  const cfg = opcoes || {};
  cena.clicarNoCartaoDeVagas('Quero me inscrever');
  cena.preencherFormulario(cfg.campos);
  cena.marcar('declara_ciencia', cfg.ciencia !== false);
  cena.marcar('consentimento_lgpd', cfg.lgpd !== false);
  cena.marcar('autoriza_imagem', cfg.imagem === true);
  cena.sairDoCampoMatricula();
  await cena.assentar();
  cena.enviarFormulario();
  await cena.assentar();
}

/**
 * Abre o formulário do projeto aberto e o deixa pronto para enviar, sem enviar.
 * Os dois aceites obrigatórios entram marcados; a imagem, não — se faltasse um
 * deles, o envio pararia na validação e o teste mediria a coisa errada.
 */
function prepararFormulario(cena, campos) {
  cena.clicarNoCartaoDeVagas('Quero me inscrever');
  cena.preencherFormulario(campos);
  cena.marcar('declara_ciencia');
  cena.marcar('consentimento_lgpd');
}

function contem(texto, trecho) {
  return String(texto).indexOf(trecho) !== -1;
}

async function rodar() {

  // ==================================================== item 1 — a lista renova

  grupo('item 1 — toda navegação renova a lista');

  const carga = await siteCarregado();

  teste('a carga inicial pede config e projetos, uma vez cada', () => {
    // Duas requisições, não três: a rota inicial é uma navegação e renovaria a
    // lista, mas encontra a carga inicial ocupando o lugar (ver `carregarTudo`).
    igual(carga.pedidosDe('api=config').length, 1);
    igual(carga.pedidosDe('api=projetos').length, 1);
  });

  teste('a lista aparece com os projetos e os contadores', () => {
    verdadeiro(contem(carga.texto('grade-projetos'), 'Arte Digital Floripa'));
    verdadeiro(contem(carga.texto('grade-projetos'), '50 vagas restantes'));
    igual(carga.visivel('carregando-projetos'), false);
  });

  // ---- O TESTE DO DEFEITO RELATADO ----
  const ida = await siteCarregado();
  ida.zerarPedidos();
  ida.entrarNoProjeto(0);
  await ida.assentar();
  ida.voltarParaLista();
  await ida.assentar();
  ida.entrarNoProjeto(0);
  await ida.assentar();
  ida.voltarParaLista();
  await ida.assentar();

  teste('voltar para a lista pede a lista de novo, sem trava de tempo', () => {
    // Quatro movimentos seguidos, todos dentro do mesmo segundo: quatro pedidos.
    // Com a janela de 20 segundos que existia aqui, este número era ZERO — que é
    // exatamente o que fazia o aluno voltar e reler o contador de quando entrou.
    igual(ida.pedidosDe('api=projetos').length, 4);
  });

  teste('entrar num projeto também renova — o contador do detalhe é o que decide', () => {
    // Dos quatro pedidos acima, dois são das entradas no projeto.
    igual(ida.pedidosDe('api=projetos').length, 4);
    verdadeiro(ida.visivel('tela-lista'));
  });

  const detalhe = await siteCarregado();
  detalhe.projetos[0].inscritos = 57;
  detalhe.projetos[0].restantes = 3;
  detalhe.entrarNoProjeto(0);

  teste('a tela NÃO espera a resposta: o detalhe abre na hora, com o que já tem', () => {
    verdadeiro(detalhe.visivel('tela-projeto'));
    verdadeiro(contem(detalhe.texto('cartao-vagas'), '10 de 60'));
  });

  await detalhe.assentar();

  teste('e o contador do detalhe se corrige quando a resposta chega', () => {
    verdadeiro(contem(detalhe.texto('cartao-vagas'), '57 de 60'));
  });

  const volta = await siteCarregado();
  volta.entrarNoProjeto(0);
  await volta.assentar();
  volta.projetos[0].inscritos = 57;
  volta.projetos[0].restantes = 3;
  volta.voltarParaLista();
  const antesDeChegar = volta.texto('grade-projetos');
  await volta.assentar();

  teste('a lista se corrige sozinha ao voltar, sem piscar tela em branco', () => {
    verdadeiro(contem(antesDeChegar, '50 vagas restantes'), 'antes: o número velho, e não vazio');
    verdadeiro(contem(volta.texto('grade-projetos'), '3 vagas restantes'), 'depois: o número novo');
  });

  const menu = await siteCarregado();
  menu.zerarPedidos();
  menu.clicarNoMenu(0);

  teste('clicar no menu do topo, já estando na lista, renova', () => {
    igual(menu.pedidosDe('api=projetos').length, 1);
  });

  const menuNoDetalhe = await siteCarregado();
  menuNoDetalhe.entrarNoProjeto(0);
  await menuNoDetalhe.assentar();
  menuNoDetalhe.zerarPedidos();
  menuNoDetalhe.clicarNoMenu(1);
  await menuNoDetalhe.assentar();

  teste('clicar no menu de dentro do detalhe volta para a lista e renova', () => {
    verdadeiro(menuNoDetalhe.visivel('tela-lista'));
    igual(menuNoDetalhe.pedidosDe('api=projetos').length, 1);
  });

  const popstate = await siteCarregado();
  popstate.entrarNoProjeto(0);
  await popstate.assentar();
  popstate.zerarPedidos();
  popstate.voltarDoNavegador('');
  await popstate.assentar();

  teste('o botão voltar DO NAVEGADOR também renova', () => {
    verdadeiro(popstate.visivel('tela-lista'));
    igual(popstate.pedidosDe('api=projetos').length, 1);
  });

  const falha = await siteCarregado();
  falha.projetosFalham = true;
  falha.entrarNoProjeto(0);
  await falha.assentar();
  falha.voltarParaLista();
  await falha.assentar();

  teste('falha na renovação NÃO apaga a lista nem vira "nenhum projeto disponível"', () => {
    // Este é o defeito que o comentário de `carregarTudo` descreve, pela outra
    // ponta: sistema fora do ar contado como sistema vazio. O aluno tem de
    // continuar vendo os projetos, mesmo que os números estejam velhos.
    verdadeiro(contem(falha.texto('grade-projetos'), 'Arte Digital Floripa'));
    igual(contem(falha.texto('grade-projetos'), 'Nenhum projeto disponível'), false);
  });

  teste('e o detalhe também sobrevive à falha da renovação', () => {
    verdadeiro(contem(falha.texto('grade-projetos'), 'R+ Cidades'));
  });

  const empilha = await siteCarregado();
  empilha.zerarPedidos();
  empilha.entrarNoProjeto(0);
  empilha.voltarParaLista();
  empilha.entrarNoProjeto(0);

  teste('ir e voltar depressa não empilha pedidos idênticos', () => {
    // Três movimentos antes de a primeira resposta chegar: um pedido só. Não é
    // validade de dado — é a mesma pergunta, ainda em voo.
    igual(empilha.pedidosDe('api=projetos').length, 1);
  });

  await empilha.assentar();
  empilha.voltarParaLista();

  teste('mas o movimento seguinte à resposta pede de novo', () => {
    igual(empilha.pedidosDe('api=projetos').length, 2);
  });

  teste('a trava de tempo saiu do código, e não só do caminho', () => {
    igual(contem(APP, 'VALIDADE_LISTA_MS'), false, 'a constante da trava voltou');
    igual(/listaEm/.test(APP), false, 'o carimbo de "quando a lista chegou" voltou');
  });

  // ============================================ item 2 — cartão de vagas vazio

  grupo('item 2 — o cartão de vagas nunca fica vazio');

  const vazio = await siteCarregado();
  vazio.entrarNoProjeto(0);
  await vazio.assentar();
  await inscrever(vazio);
  vazio.voltarParaLista();
  await vazio.assentar();
  vazio.entrarNoProjeto(1);
  await vazio.assentar();

  teste('depois de uma inscrição, o próximo projeto volta a mostrar o cartão', () => {
    // `concluir` esconde o cartão para o painel de sucesso ocupar o lugar, e
    // ninguém o mostrava de novo: dali em diante todo projeto aberto exibia a
    // coluna da direita vazia — a caixa branca da captura de tela.
    verdadeiro(vazio.visivel('cartao-vagas'), 'o cartão continuou escondido');
    verdadeiro(contem(vazio.texto('cartao-vagas'), '59 de 60'));
    verdadeiro(contem(vazio.texto('cartao-vagas'), 'Quero me inscrever'));
  });

  const sumiu = await siteCarregado();
  sumiu.entrarNoProjeto(0);
  await sumiu.assentar();
  sumiu.projetos = [sumiu.projetos[1]];
  sumiu.voltarDoNavegador('?projeto=ARTE');
  await sumiu.assentar();

  teste('projeto que sai da lista no meio da leitura não esvazia o cartão', () => {
    verdadeiro(contem(sumiu.texto('cartao-vagas'), '10 de 60'));
    verdadeiro(contem(sumiu.texto('cartao-vagas'), 'Quero me inscrever'));
  });

  teste('renderizarCartaoVagas se recusa a limpar o cartão sem ter com que preencher', () => {
    const trecho = /function renderizarCartaoVagas\(p\) \{\s*if \(!p\) return;/.exec(APP);
    verdadeiro(trecho, 'a guarda que impede o cartão vazio saiu do código');
  });

  // ================================================ item 3 — o comprovante

  grupo('item 3 — o cartão de inscrição registrada é o comprovante');

  const comprovante = await siteCarregado();
  comprovante.entrarNoProjeto(0);
  await comprovante.assentar();
  await inscrever(comprovante);

  teste('o cartão traz o protocolo e, abaixo dele, os dados do projeto', () => {
    verdadeiro(comprovante.visivel('painel-sucesso'));
    verdadeiro(contem(comprovante.texto('sucesso-protocolo'), 'PROTO-123'));
    verdadeiro(comprovante.visivel('sucesso-projeto'));
    igual(comprovante.texto('sucesso-projeto-nome'), 'Arte Digital Floripa');
  });

  teste('e as ORIENTAÇÕES do projeto — a foto que o aluno tira', () => {
    // Em 12/08 este cartão passou a mostrar nome + orientações, e mais nada. A
    // coordenação, o local e o horário saíram porque o texto de orientações já os
    // traz, escritos pelo próprio professor. Duas formas dos mesmos fatos obrigam
    // o aluno a conferir se elas concordam — e no dia em que discordarem, ele não
    // tem como saber qual vale.
    verdadeiro(comprovante.visivel('sucesso-projeto-orientacao'),
      'as orientações ficaram escondidas no comprovante');
    const t = comprovante.texto('sucesso-projeto-orientacao');
    verdadeiro(contem(t, 'Prof. Gilberto Martini'), t);
    verdadeiro(contem(t, '21/08/2026'), t);

    igual(comprovante.visivel('sucesso-projeto-professor'), false,
      'a coordenação voltou a aparecer separada, repetindo o que o texto já diz');
    igual(comprovante.visivel('sucesso-projeto-info'), false,
      'a ficha voltou a aparecer, repetindo local e horário');
  });

  const semFicha = await siteCarregado();
  semFicha.entrarNoProjeto(1);
  await semFicha.assentar();
  await inscrever(semFicha);

  teste('projeto sem orientações mostra só o nome, sem espaço vazio', () => {
    // O preço assumido do cartão enxuto: sem texto de orientações, o comprovante
    // fica com o nome e nada mais. É escolha da coordenação preencher — e por isso
    // o vazio precisa parecer vazio de propósito, não quebrado.
    igual(semFicha.visivel('sucesso-projeto-orientacao'), false);
    igual(semFicha.texto('sucesso-projeto-orientacao'), '');
    igual(semFicha.texto('sucesso-projeto-nome'), 'R+ Cidades');
    verdadeiro(semFicha.visivel('sucesso-projeto'), 'o cartão inteiro sumiu');
  });

  teste('o botão "Voltar aos projetos" fica FORA do cartão', () => {
    const painel = /<div id="painel-sucesso"[\s\S]*?\n        <\/div>/.exec(HTML);
    verdadeiro(painel, 'não achei o painel de sucesso no index.html');

    const fimDoCartao = painel[0].indexOf('</div>\n\n          <p class="centro"');
    const botao = painel[0].indexOf('Voltar aos projetos');
    verdadeiro(fimDoCartao !== -1, 'o cartão não fecha antes do botão');
    verdadeiro(botao > fimDoCartao, 'o botão voltou para dentro do cartão');
  });

  // ======================================= item 4 — projeto em que já está inscrito

  grupo('item 4 — o projeto em que o aluno já se inscreveu');

  const jaInscrito = await siteCarregado();
  jaInscrito.entrarNoProjeto(0);
  await jaInscrito.assentar();
  await inscrever(jaInscrito);
  jaInscrito.voltarParaLista();
  await jaInscrito.assentar();
  jaInscrito.entrarNoProjeto(0);
  await jaInscrito.assentar();

  teste('voltar ao projeto mostra "você já está inscrito" no lugar do botão', () => {
    verdadeiro(contem(jaInscrito.texto('cartao-vagas'), 'Você já está inscrito neste projeto'));
    igual(acharClicavel(jaInscrito.el('cartao-vagas'), 'Quero me inscrever'), null);
  });

  teste('e o contador continua ali, atualizado', () => {
    verdadeiro(contem(jaInscrito.texto('cartao-vagas'), '10 de 60'));
    verdadeiro(contem(jaInscrito.texto('cartao-vagas'), 'PROTO-123'), 'o protocolo some');
  });

  const guardado = jaInscrito.armazenamento.dados;

  teste('a lembrança fica no localStorage, e não em memória de página', () => {
    const bruto = guardado['cesutech.inscricoes'];
    verdadeiro(bruto, 'nada foi gravado');
    igual(JSON.parse(bruto).ARTE, 'PROTO-123');
  });

  const recarregado = await siteCarregado({ armazenamento: guardado });
  recarregado.entrarNoProjeto(0);
  await recarregado.assentar();

  teste('e sobrevive a recarregar a página', () => {
    verdadeiro(contem(recarregado.texto('cartao-vagas'), 'Você já está inscrito'));
  });

  recarregado.clicarNoCartaoDeVagas('Não foi você');

  teste('a lembrança nunca é fonte de verdade: dá para se inscrever assim mesmo', () => {
    // Computador de laboratório: o próximo aluno usa o mesmo navegador do
    // anterior. Sem esta saída, a lembrança de OUTRA pessoa tiraria dele o
    // formulário. Quem decide de verdade é o servidor.
    verdadeiro(recarregado.visivel('area-formulario'));
  });

  const semArmazenamento = await siteCarregado({ armazenamentoQuebrado: true });
  semArmazenamento.entrarNoProjeto(0);
  await semArmazenamento.assentar();

  teste('navegador com armazenamento bloqueado não derruba a tela', () => {
    verdadeiro(semArmazenamento.visivel('cartao-vagas'));
    verdadeiro(contem(semArmazenamento.texto('cartao-vagas'), 'Quero me inscrever'));
  });

  const duplicada = await siteCarregado({
    respostaEnvio: { ok: true, duplicada: true, mensagem: 'Você já está inscrito neste projeto.' }
  });
  duplicada.entrarNoProjeto(0);
  await duplicada.assentar();
  await inscrever(duplicada);

  teste('inscrição duplicada volta sem protocolo e ainda assim é lembrada', () => {
    const dados = JSON.parse(duplicada.armazenamento.dados['cesutech.inscricoes']);
    verdadeiro(Object.prototype.hasOwnProperty.call(dados, 'ARTE'), 'a duplicata não foi lembrada');
    igual(dados.ARTE, '');
  });

  // ========================= as caixas de aceite (decisão de 06/08: ficam soltas)

  grupo('as caixas de aceite — cada consentimento é escolha do aluno');

  teste('as três caixas ficam desmarcadas e editáveis no HTML', () => {
    // Marcá-las por padrão e travá-las chegou a ser levantado e foi RECUSADO
    // em 06/08/2026. Este teste é o que impede a ideia de voltar por descuido.
    ['declara_ciencia', 'autoriza_imagem', 'consentimento_lgpd'].forEach((id) => {
      const tag = new RegExp('<input[^>]*id="' + id + '"[^>]*>').exec(HTML);
      verdadeiro(tag, 'não achei a caixa ' + id);
      igual(/\bchecked\b/.test(tag[0]), false, id + ' passou a vir marcada de fábrica');
      igual(/\bdisabled\b/.test(tag[0]), false, id + ' passou a vir bloqueada');
    });
  });

  const semImagem = await siteCarregado();
  semImagem.entrarNoProjeto(0);
  await semImagem.assentar();
  await inscrever(semImagem);

  teste('quem recusa o uso da própria imagem se inscreve assim mesmo', () => {
    // É o ponto inteiro da decisão: uso de imagem é finalidade separada da
    // inscrição. O aluno que não quer ser fotografado não pode perder a vaga
    // por isso — e quem exige o quê é `validarInscricao` (04_Inscricoes.gs).
    const corpo = semImagem.corpoDoEnvio();
    igual(corpo.declara_ciencia, true);
    igual(corpo.consentimento_lgpd, true);
    igual(corpo.autoriza_imagem, false, 'a recusa de imagem não chegou como recusa');
    verdadeiro(semImagem.visivel('painel-sucesso'), 'a inscrição foi barrada por causa da imagem');
  });

  teste('o envio não abre alerta de confirmação — o aceite é o das caixas', () => {
    igual(semImagem.confirmacoes.length, 0);
    igual(/window\.confirm/.test(APP), false, 'voltou a confirmação por alerta');
  });

  const semCiencia = await siteCarregado();
  semCiencia.entrarNoProjeto(0);
  await semCiencia.assentar();
  await inscrever(semCiencia, { ciencia: false });

  teste('sem a declaração de ciência, nada é enviado', () => {
    igual(semCiencia.pedidosPost().length, 0);
    verdadeiro(semCiencia.el('erro-declaracao').classList.contains('visivel'));
  });

  const semLgpd = await siteCarregado();
  semLgpd.entrarNoProjeto(0);
  await semLgpd.assentar();
  await inscrever(semLgpd, { lgpd: false });

  teste('sem o aceite da LGPD, nada é enviado', () => {
    igual(semLgpd.pedidosPost().length, 0);
    verdadeiro(semLgpd.el('erro-lgpd').classList.contains('visivel'));
  });

  teste('o corpo do POST é montado à mão, e leva os três campos sempre', () => {
    // Serializar o formulário deixaria de fora toda caixa desmarcada, e a
    // recusa de imagem chegaria ao servidor como campo AUSENTE, não como "não".
    igual(/new FormData|\.submit\(\)/.test(APP), false, 'o site passou a serializar o formulário');
    ['declara_ciencia', 'autoriza_imagem', 'consentimento_lgpd'].forEach((campo) => {
      verdadeiro(contem(APP, "document.getElementById('" + campo + "').checked"), campo);
    });
  });

  teste('a decisão de 06/08 está registrada no ponto exato das caixas', () => {
    // Não é comentário decorativo: é o registro de que três caixas soltas são
    // escolha, e não sobra de rascunho. Quem for "simplificar" lê isto antes.
    const bloco = /<!--[\s\S]*?-->\s*<div class="campo checkbox">\s*<input type="checkbox" id="declara_ciencia">/.exec(HTML);
    verdadeiro(bloco, 'o comentário saiu de cima das caixas no index.html');
    verdadeiro(contem(bloco[0], 'DECISÃO DELIBERADA'), 'o comentário não registra mais a decisão');
    verdadeiro(contem(bloco[0], 'IMAGEM E VOZ'), 'o comentário não diz mais qual caixa é o problema');
    verdadeiro(contem(bloco[0], 'RECUSADO'), 'o comentário não diz mais que a ideia foi recusada');
    verdadeiro(contem(APP, 'decisão deliberada de 06/08/2026'), 'o app.js não aponta mais para a decisão');
  });

  // ================================================= item 6 — "conferindo..."

  grupo('item 6 — a espera da conferência de matrícula');

  const conferencia = await siteCarregado({
    // O caso que mais dói: matrícula fora da lista em modo AVISAR. O veredito
    // não é "ok", e era justamente esse que o código antigo não lembrava —
    // então cada saída do campo e cada envio pagavam a espera de novo.
    respostaMatricula: {
      ok: true, valida: true, validaProjeto: true, existe: false, listaDisponivel: true, bloqueia: false
    }
  });
  conferencia.entrarNoProjeto(0);
  await conferencia.assentar();
  prepararFormulario(conferencia);
  conferencia.zerarPedidos();

  conferencia.sairDoCampoMatricula();

  teste('enquanto espera, a tela diz o que está acontecendo', () => {
    igual(conferencia.texto('selo-matricula'), 'conferindo na lista oficial...');
    igual(conferencia.el('matricula').getAttribute('aria-busy'), 'true');
  });

  await conferencia.assentar();
  conferencia.sairDoCampoMatricula();
  await conferencia.assentar();
  conferencia.sairDoCampoMatricula();
  await conferencia.assentar();

  teste('a mesma matrícula não é conferida duas vezes', () => {
    igual(conferencia.pedidosDe('api=matricula').length, 1);
    igual(conferencia.el('matricula').getAttribute('aria-busy'), 'false');
  });

  conferencia.enviarFormulario();
  await conferencia.assentar();

  teste('e o envio aproveita o veredito em vez de esperar de novo', () => {
    igual(conferencia.pedidosDe('api=matricula').length, 1);
    igual(conferencia.pedidosPost().length, 1);
  });

  const emVoo = await siteCarregado();
  emVoo.entrarNoProjeto(0);
  await emVoo.assentar();
  prepararFormulario(emVoo);
  emVoo.zerarPedidos();
  emVoo.sairDoCampoMatricula();
  emVoo.enviarFormulario();

  teste('sair do campo e clicar em Confirmar não pergunta duas vezes', () => {
    igual(emVoo.pedidosDe('api=matricula').length, 1);
  });

  await emVoo.assentar();

  teste('e o envio acontece assim que a conferência em voo responde', () => {
    igual(emVoo.pedidosPost().length, 1);
  });

  const outraMatricula = await siteCarregado();
  outraMatricula.entrarNoProjeto(0);
  await outraMatricula.assentar();
  prepararFormulario(outraMatricula);
  outraMatricula.zerarPedidos();
  outraMatricula.sairDoCampoMatricula();
  await outraMatricula.assentar();
  outraMatricula.preencherFormulario({ matricula: '9110002' });
  outraMatricula.sairDoCampoMatricula();
  await outraMatricula.assentar();

  teste('matrícula diferente é conferida, claro', () => {
    igual(outraMatricula.pedidosDe('api=matricula').length, 2);
  });

  const indisponivel = await siteCarregado({
    respostaMatricula: { ok: true, valida: true, indisponivel: true }
  });
  indisponivel.entrarNoProjeto(0);
  await indisponivel.assentar();
  prepararFormulario(indisponivel);
  indisponivel.zerarPedidos();
  indisponivel.sairDoCampoMatricula();
  await indisponivel.assentar();
  indisponivel.sairDoCampoMatricula();
  await indisponivel.assentar();

  teste('"não deu para conferir" NÃO é lembrado — a próxima tentativa pergunta', () => {
    // Indisponibilidade é momentânea. Lembrá-la deixaria o aluno sem conferência
    // pelo resto da visita, e o teto de consultas do servidor volta ao normal na
    // virada da hora.
    igual(indisponivel.pedidosDe('api=matricula').length, 2);
    igual(indisponivel.texto('selo-matricula'), 'não foi possível conferir agora');
  });

  // ============================= a orientação que a coordenação escreve

  /**
   * `descricao_formulario` — o parágrafo que o professor escreve para o aluno
   * ler ANTES de preencher.
   *
   * Três coisas se provam aqui, e cada uma existe por um risco diferente:
   *
   *   1. o LUGAR. Entre o título "Inscrição — <projeto>" e a linha dos campos
   *      obrigatórios. Fora dali ele vira aviso que ninguém lê;
   *   2. o ESCAPAMENTO. É campo editado no painel e lido por 500 pessoas no dia
   *      do evento. HTML colado ali — por descuido ou por graça — tem de
   *      aparecer escrito, nunca rodar;
   *   3. as QUEBRAS DE LINHA. Texto puro pelo `textContent` é seguro e some com
   *      as quebras, porque o HTML colapsa espaço em branco. O parágrafo do
   *      professor pode ter três blocos, e os três precisam continuar três.
   *
   * E a quarta, que é a de não atrapalhar: projeto SEM orientação não pode
   * abrir um espaço vazio no meio do formulário nem herdar o texto do projeto
   * que o aluno acabou de visitar.
   */
  grupo('a orientação do projeto, dentro do formulário');

  const ORIENTACAO_REAL =
    'Preencha os dados solicitados para participar do projeto ARTE DIGITAL FLORIPA. ' +
    'O Prof. Gilberto Martini (coordenador) entrará em contato com você na próxima semana. ' +
    'Reiteramos que cada projeto tem limite de 60 vagas.';

  /** A lista padrão com a orientação no PRIMEIRO projeto — o segundo fica sem. */
  function projetosCom(texto) {
    const lista = JSON.parse(JSON.stringify(PROJETOS_PADRAO));
    lista[0].descricao_formulario = texto;
    return lista;
  }

  async function formularioAberto(texto) {
    const cena = await siteCarregado({ projetos: projetosCom(texto) });
    cena.entrarNoProjeto(0);
    await cena.assentar();
    cena.clicarNoCartaoDeVagas('Quero me inscrever');
    return cena;
  }

  const comOrientacao = await formularioAberto(ORIENTACAO_REAL);

  teste('o texto do projeto aparece dentro do formulário', () => {
    verdadeiro(comOrientacao.visivel('area-formulario'), 'o formulário nem abriu');
    verdadeiro(comOrientacao.visivel('form-orientacao'), 'a orientação ficou escondida');
    verdadeiro(contem(comOrientacao.texto('form-orientacao'), 'Prof. Gilberto Martini'),
      'o texto não chegou à tela: ' + comOrientacao.texto('form-orientacao'));
  });

  teste('e aparece ENTRE o título da inscrição e a linha dos obrigatórios', () => {
    // O lugar é o pedido, e ele é conferido no HTML porque aqui não há layout.
    const meio = /<h2>Inscrição[\s\S]*?<\/h2>([\s\S]*?)Campos com/.exec(HTML);
    verdadeiro(meio, 'o título ou a linha dos obrigatórios saíram do formulário');
    verdadeiro(contem(meio[1], 'id="form-orientacao"'),
      'a orientação saiu de entre o título e a linha dos campos obrigatórios');
  });

  const hostil = await formularioAberto(
    '<script>alert("oi")</script>Leia com atenção <b>antes</b> de preencher.');

  teste('HTML colado no campo aparece escrito — não é interpretado', () => {
    const el = hostil.el('form-orientacao');

    // Se o texto tivesse entrado por `innerHTML`, ele estaria AQUI — e o
    // navegador de verdade teria montado a tag em vez de mostrá-la.
    igual(el.innerHTML, '', 'o texto do banco entrou pelo innerHTML');
    igual(el.filhos.filter((f) => ['SPAN', 'BR'].indexOf(f.tagName) === -1), [],
      'nasceu na tela um elemento que veio do texto, e não do código');

    const naTela = hostil.texto('form-orientacao');
    verdadeiro(contem(naTela, '<script>'), 'a tag sumiu da tela em vez de aparecer escrita');
    verdadeiro(contem(naTela, '<b>antes</b>'), 'a marcação foi interpretada: ' + naTela);
  });

  const quebras = await formularioAberto(
    'Primeiro bloco.\nSegundo bloco.\r\n\nQuarto bloco.');

  teste('as quebras de linha aparecem, e cada <br> é montado aqui', () => {
    const el = quebras.el('form-orientacao');

    igual(el.filhos.filter((f) => f.tagName === 'BR').length, 3,
      'as quebras do professor não viraram quebras na tela');
    igual(el.filhos.filter((f) => f.tagName === 'SPAN').map((s) => s.textContent),
      ['Primeiro bloco.', 'Segundo bloco.', '', 'Quarto bloco.'],
      'cada linha é um texto próprio — e a linha em branco continua em branco');
  });

  const semOrientacao = await formularioAberto('');

  teste('projeto sem orientação não abre espaço vazio no formulário', () => {
    igual(semOrientacao.visivel('form-orientacao'), false);
    igual(semOrientacao.el('form-orientacao').filhos.length, 0);
  });

  const trocaDeProjeto = await siteCarregado({ projetos: projetosCom(ORIENTACAO_REAL) });
  trocaDeProjeto.entrarNoProjeto(0);
  await trocaDeProjeto.assentar();
  trocaDeProjeto.voltarParaLista();
  await trocaDeProjeto.assentar();
  trocaDeProjeto.entrarNoProjeto(1);          // este não tem orientação nenhuma
  await trocaDeProjeto.assentar();
  trocaDeProjeto.clicarNoCartaoDeVagas('Quero me inscrever');

  teste('o texto de um projeto não sobra na tela do projeto seguinte', () => {
    // Seria a pior versão do defeito: a orientação de OUTRO projeto, com outro
    // coordenador e outra data de encontro, no formulário que o aluno vai enviar.
    igual(trocaDeProjeto.visivel('form-orientacao'), false);
    igual(contem(trocaDeProjeto.texto('form-orientacao'), 'Gilberto'), false,
      'a orientação do projeto anterior ficou na tela');
  });

  // ============================== a ocupação que o servidor não contou

  // `contar_ocupacao_na_lista` em NAO (09_Projetos.gs) faz a rota responder sem
  // a ocupação: `inscritos` vem null e `ocupacao_contada` vem false. O que se
  // prova aqui é que a tela desenha a AUSÊNCIA — e que ela não se parece com
  // "não há ninguém", que é a leitura de um zero ou de uma barra vazia.
  grupo('a ocupação desligada aparece como ausência, e não como vazio');

  const SEM_CONTAGEM = [
    {
      id: 'p1', codigo: 'ARTE', nome: 'Arte Digital Floripa', descricao: 'Oficinas de arte digital.',
      descricao_formulario: '', professor: 'Prof. Exemplo', banner: '',
      local: 'Bloco B, sala 12', horario: 'Quartas, 19h', primeiro_encontro: '2026-08-19',
      // O projeto pode estar CHEIO, e a tela não tem como saber. É o caso que
      // decide o desenho: nada aqui pode convidar mais do que a verdade permite.
      vagas: 60, inscritos: null, ocupacao_contada: false, restantes: null,
      situacao: 'ABERTO', validar_matricula: true, ativo: true, inscricoes_abertas: true, ordem: 1
    },
    {
      id: 'p2', codigo: 'CIDADES', nome: 'R+ Cidades', descricao: 'Requalificação urbana.',
      professor: 'Profa. Ana', banner: '', local: '', horario: '', primeiro_encontro: '',
      vagas: 0, inscritos: null, ocupacao_contada: false, restantes: null,
      situacao: 'ABERTO', validar_matricula: true, ativo: true, inscricoes_abertas: true, ordem: 2
    }
  ];

  const semContagem = await siteCarregado({ projetos: SEM_CONTAGEM });

  teste('a lista mostra o TOTAL de vagas, e não um número de restantes', () => {
    const lista = semContagem.texto('grade-projetos');
    verdadeiro(contem(lista, '60 vagas no total'), 'o selo não diz o total: ' + lista);
    verdadeiro(!contem(lista, 'restante'), '"restantes" é o número que não se sabe: ' + lista);
    // Zero SOLTO, com a borda à esquerda: "60 vagas no total" tem um zero
    // dentro dele, e não é dele que se está falando.
    verdadeiro(!/(^|\s)0\b/.test(lista), 'zero na lista se lê como projeto vazio: ' + lista);
    verdadeiro(!contem(lista, 'Esgotado'), 'sem contar, esgotado seria invenção: ' + lista);
  });

  teste('projeto ilimitado continua dizendo "Inscrições abertas", e não "0 vagas"', () => {
    // As duas ausências chegam como `restantes: null` — ilimitado e não contado.
    // Distinguir as duas é a razão de `ocupacao_contada` existir.
    verdadeiro(contem(semContagem.texto('grade-projetos'), 'Inscrições abertas'),
      'o ilimitado perdeu o selo dele: ' + semContagem.texto('grade-projetos'));
  });

  semContagem.entrarNoProjeto(0);
  await semContagem.assentar();

  teste('o cartão do projeto mostra as vagas totais e diz que a ocupação não aparece', () => {
    const cartao = semContagem.texto('cartao-vagas');
    verdadeiro(contem(cartao, '60 vagas no total'), 'o total sumiu do cartão: ' + cartao);
    verdadeiro(contem(cartao, 'não está sendo exibido'), 'a tela não explicou a ausência: ' + cartao);
    verdadeiro(!contem(cartao, 'de 60 vagas preenchidas'), 'apareceu ocupação que ninguém contou: ' + cartao);
    verdadeiro(!contem(cartao, '0 de 60'), 'o zero que a peça inteira existe para não escrever: ' + cartao);
  });

  teste('A BARRA DE OCUPAÇÃO SOME — barra em 0% se lê como projeto vazio', () => {
    const classes = [];
    (function varrer(el) {
      el.filhos.forEach((f) => { classes.push(f.className || ''); varrer(f); });
    })(semContagem.el('cartao-vagas'));

    igual(classes.filter((c) => contem(c, 'vagas-barra')), [],
      'a barra continuou na tela: ' + classes.join(' | '));
  });

  teste('o botão de inscrição continua lá: quem decide a vaga é o envio', () => {
    verdadeiro(contem(semContagem.texto('cartao-vagas'), 'Quero me inscrever'),
      'sem contagem o projeto é ABERTO, e tirar o botão recusaria quem talvez coubesse');
    verdadeiro(contem(semContagem.texto('cartao-vagas'), 'avisa no envio'),
      'a frase que prepara o aluno para a recusa do servidor sumiu');
  });

  // A rota tem cache de 30s: uma resposta guardada ANTES de o campo existir
  // chega sem `ocupacao_contada`. Ela traz a ocupação de verdade, e a tela não
  // pode escondê-la por causa de um campo ausente.
  const respostaAntiga = await siteCarregado({
    projetos: [Object.assign({}, PROJETOS_PADRAO[0], { ocupacao_contada: undefined })]
  });

  teste('resposta sem o campo novo continua desenhando a ocupação que ela traz', () => {
    respostaAntiga.entrarNoProjeto(0);
    verdadeiro(contem(respostaAntiga.texto('cartao-vagas'), '10 de 60'),
      'a tela apagou uma ocupação que existia: ' + respostaAntiga.texto('cartao-vagas'));
  });

  teste('quem decide o desenho é o DADO, e não o sinalizador', () => {
    // `typeof p.inscritos === 'number'` é a conferência que não tem como ser
    // enganada por campo ausente — o sinalizador é o rótulo, o null é o fato.
    verdadeiro(/function temOcupacao\(p\) \{\s*return typeof p\.inscritos === 'number';/.test(APP),
      'a conferência da ocupação deixou de olhar o dado');
  });

  // ======================================= 13/08 — a leitura que fica pendurada

  /**
   * O QUE ESTE BLOCO PROTEGE, com as medidas do dia em que ele nasceu.
   *
   * 13/08/2026, véspera do evento. O `/exec` responde um redirecionamento para
   * `script.googleusercontent.com/macros/echo?user_content_key=...`, e é o
   * SEGUNDO salto que traz o corpo. Ele travou: 404 depois de 32,73s pendurado
   * no navegador de um aluno, e no terminal 404 em 11,9s e em 66,8s — com a
   * repetição logo em seguida respondendo em 401ms. O site já repetia leitura
   * que falha, e a repetição não ajudava em nada: sem tempo-limite ela só
   * começava quando o Google desistia sozinho, e a página inteira levou 48s.
   *
   * O tempo-limite é de 10s porque as medidas cercam esse número pelos dois
   * lados — 2 a 4s no caminho saudável, 9,25s na leitura mais lenta que DEU
   * CERTO, 12 a 67s nas travadas. Os testes daqui afirmam os dois lados: a
   * travada morre no limite e a de 9,25s passa inteira.
   *
   * O QUE ELES GUARDAM DE VERDADE é a terceira: a ESCRITA continua sem
   * tempo-limite nenhum. Abortar um `fetch` não cancela o trabalho do servidor —
   * uma inscrição abortada pode ter sido gravada, e o aluno ficaria sem saber se
   * tem vaga. Espera longa é ruim; dúvida é irreversível.
   */
  grupo('13/08 — a leitura pendurada tem hora para morrer, e a escrita não');

  const travada = await siteCarregado({ demoras: { 'api=projetos': [Infinity] } });

  teste('a leitura pendurada é abortada aos 10s, e a repetição salva a tela', () => {
    const pedidos = travada.pedidosDe('api=projetos');
    igual(pedidos.length, 2,
      'a repetição não saiu: sem tempo-limite, ela espera o Google desistir sozinho');
    igual(pedidos[0].abortada, true, 'a primeira requisição ficou pendurada sem ser abortada');
    igual(pedidos[0].abortadaEm, 10000,
      'o limite não é de 10s — abaixo disso corta leitura que ia responder, acima ' +
      'devolve ao aluno a espera que se está tirando dele');
    verdadeiro(contem(travada.texto('grade-projetos'), 'Arte Digital Floripa'),
      'a lista não chegou à tela: ' + travada.texto('grade-projetos'));
    igual(travada.visivel('carregando-projetos'), false);
  });

  const corpoTravado = await siteCarregado({
    demoras: { 'api=projetos': [{ corpo: Infinity }] }
  });

  teste('travar na leitura do CORPO também é travar — o limite cobre os dois', () => {
    // Quando os cabeçalhos chegam, o corpo ainda está sendo lido: desarmar o
    // relógio ali deixaria de fora metade das formas de ficar pendurado.
    const pedidos = corpoTravado.pedidosDe('api=projetos');
    igual(pedidos.length, 2, 'a resposta chegou, o corpo travou, e ninguém desistiu dela');
    igual(pedidos[0].abortadaEm, 10000, 'o corpo pendurado escapou do tempo-limite');
    verdadeiro(contem(corpoTravado.texto('grade-projetos'), 'Arte Digital Floripa'),
      'a lista não chegou à tela: ' + corpoTravado.texto('grade-projetos'));
  });

  const lenta = await siteCarregado({ demoras: { 'api=projetos': [9250] } });

  teste('a leitura mais lenta que já deu certo — 9,25s — NÃO é abortada', () => {
    const pedidos = lenta.pedidosDe('api=projetos');
    igual(pedidos.length, 1,
      'a leitura foi repetida: o limite está cortando resposta que ia chegar');
    igual(pedidos[0].abortada, false, 'uma resposta boa foi jogada fora pelo relógio');
    verdadeiro(contem(lenta.texto('grade-projetos'), 'Arte Digital Floripa'),
      'a lista não chegou à tela: ' + lenta.texto('grade-projetos'));
  });

  const desistiu = await siteCarregado({
    demoras: { 'api=projetos': [Infinity, Infinity, Infinity] }
  });

  teste('três travadas esgotam as tentativas e a tela diz o que já dizia', () => {
    igual(desistiu.pedidosDe('api=projetos').length, 3, 'não foram três tentativas');
    // A mensagem é a que já existia para a rede fora do ar. Tempo-limite não é
    // um desfecho novo para o aluno: é a mesma leitura que não chegou.
    verdadeiro(contem(desistiu.texto('carregando-projetos'),
      'Não conseguimos falar com o servidor agora'),
    'a tela inventou uma mensagem nova para o tempo-limite: ' +
      desistiu.texto('carregando-projetos'));
    igual(contem(desistiu.texto('grade-projetos'), 'Nenhum projeto disponível'), false,
      'sistema fora do ar contado como sistema vazio — o defeito de `carregarTudo`');
  });

  teste('o pior caso continua sendo o de sempre: 36s até desistir', () => {
    // 10s + 2s + 10s + 4s + 10s. É o mesmo que UMA travada já custava (32,73s
    // medidos) sem repetição nenhuma — o limite não piora cenário nenhum.
    igual(desistiu.relogio(), 36000,
      'o pior caso mudou de tamanho: confira o limite e as esperas entre tentativas');
  });

  const escrita = await siteCarregado();
  escrita.entrarNoProjeto(0);
  await escrita.assentar();
  escrita.demoras = { POST: [Infinity] };
  await inscrever(escrita);
  // Um minuto inteiro de relógio, seis vezes o limite das leituras.
  await escrita.avancarRelogio(60000);

  teste('a ESCRITA não ganha tempo-limite — abortar o que talvez gravou é pior', () => {
    const envios = escrita.pedidosPost();
    igual(envios.length, 1, 'a inscrição saiu mais de uma vez');
    igual(envios[0].sinal, undefined,
      'O ENVIO GANHOU UM SINAL DE ABORTO. Abortar não cancela a gravação no ' +
      'servidor: o aluno ficaria sem saber se está inscrito.');
    igual(envios[0].abortada, false, 'a inscrição foi abortada no meio do caminho');
  });

  teste('e a tela continua dizendo que o envio está em curso', () => {
    verdadeiro(escrita.visivel('status-envio'),
      'a tela parou de contar a espera do envio');
    igual(escrita.visivel('painel-sucesso'), false, 'a tela deu a inscrição por feita');
    igual(contem(escrita.texto('erro-geral'), 'Não conseguimos falar'), false,
      'a tela desistiu de uma inscrição que ainda pode estar sendo gravada');
  });

  // ============================ 13/08 — o config que não chegou trava a inscrição

  /**
   * A OUTRA METADE DO MESMO DIA. O bloco de cima prova que a leitura pendurada
   * morre aos 10s; este prova o que acontecia DEPOIS dela, na leitura que o
   * tempo-limite não salvava.
   *
   * `?api=config` era pedido UMA vez, na carga. Na noite de 13/08 cinco leituras
   * seguidas travaram: `?api=projetos` chegou na terceira tentativa e
   * `?api=config` esgotou as três e devolveu null. A partir daí
   * `ESTADO.cursosFases` ficava vazio pela sessão inteira — o select de curso e
   * fase abria sem nenhuma opção, o campo é obrigatório, e o aluno não conseguia
   * concluir a inscrição. A tela não dizia nada: ele só teria como sair disso
   * recarregando a página, e nada lhe dizia isso.
   *
   * A forma das demoras aqui é a do que se mediu: `[Infinity, Infinity,
   * Infinity]` é a rodada inteira travada, com a fila vazia depois — a repetição
   * seguinte responde na hora, como respondeu (401ms) na produção.
   */
  grupo('13/08 — o config que não chegou não pode travar a inscrição');

  const semConfig = await siteCarregado({
    demoras: { 'api=config': [Infinity, Infinity, Infinity] }
  });
  semConfig.entrarNoProjeto(0);
  await semConfig.assentar();
  semConfig.zerarPedidos();
  semConfig.clicarNoCartaoDeVagas('Quero me inscrever');

  teste('sem a lista de cursos, abrir o formulário pede a configuração DE NOVO', () => {
    igual(semConfig.pedidosDe('api=config').length, 1,
      'o formulário abriu com o select vazio e não pediu nada: é o defeito de 13/08');
    verdadeiro(contem(semConfig.texto('curso_fase'), 'Carregando os cursos'),
      'o select não diz o que está acontecendo: ' + semConfig.texto('curso_fase'));
  });

  await semConfig.assentar();

  teste('a lista chega e o select fica preenchido de verdade', () => {
    igual(semConfig.el('curso_fase').filhos.map((o) => o.textContent),
      ['Selecione seu curso e fase...', 'ADS - 1a fase', 'Direito - 3a fase'],
      'as opções não chegaram ao select');
    igual(semConfig.el('erro-curso_fase').classList.contains('visivel'), false,
      'sobrou aviso de erro embaixo de uma lista que chegou');
  });

  teste('e o que mais vem do config entra junto — inclusive o rótulo do aceite', () => {
    // A caixa de imagem é um CONSENTIMENTO: sem o texto ao lado dela, o aluno
    // estaria marcando uma caixa que não diz o que ele está autorizando.
    igual(semConfig.el('rotulo-imagem').textContent, 'Autorizo o uso da minha imagem e voz.',
      'a caixa de autorização de imagem ficou sem rótulo');
  });

  semConfig.preencherFormulario();
  semConfig.marcar('declara_ciencia');
  semConfig.marcar('consentimento_lgpd');
  semConfig.sairDoCampoMatricula();
  await semConfig.assentar();
  semConfig.enviarFormulario();
  await semConfig.assentar();

  teste('o aluno conclui a inscrição — que era exatamente o que a falha impedia', () => {
    igual(semConfig.pedidosPost().length, 1, 'a inscrição não saiu');
    igual(semConfig.corpoDoEnvio().curso_fase, 'ADS - 1a fase');
    verdadeiro(semConfig.visivel('painel-sucesso'), 'a confirmação não apareceu');
  });

  // ---- a segunda falha: a tela precisa DIZER, e o envio continua barrado ----

  const nuncaChegou = await siteCarregado({
    // Seis: as três da carga e as três da nova tentativa.
    demoras: { 'api=config': [Infinity, Infinity, Infinity, Infinity, Infinity, Infinity] }
  });
  nuncaChegou.entrarNoProjeto(0);
  await nuncaChegou.assentar();
  nuncaChegou.clicarNoCartaoDeVagas('Quero me inscrever');
  await nuncaChegou.assentar();

  teste('falhando de novo, o formulário DIZ o que houve, no lugar do silêncio', () => {
    igual(nuncaChegou.pedidosDe('api=config').length, 6,
      'não foram duas rodadas de três tentativas');
    igual(nuncaChegou.texto('erro-curso_fase'),
      'Não conseguimos carregar a lista de cursos. Recarregue a página e tente de novo.',
      'o aluno continua sem saber por que não consegue se inscrever');
    verdadeiro(nuncaChegou.el('erro-curso_fase').classList.contains('visivel'),
      'a mensagem existe mas está escondida — que é o mesmo silêncio de antes');
  });

  teste('e usa o padrão de erro que o formulário já tem, sem estética nova', () => {
    verdadeiro(contem(nuncaChegou.el('erro-curso_fase').className, 'erro-campo'),
      'o aviso saiu do padrão visual dos outros erros do formulário');
  });

  // Select sem opção nenhuma é campo em branco: é isso que o aluno tem para
  // mandar, e é por aí que o envio tem de parar.
  nuncaChegou.preencherFormulario({ curso_fase: '' });
  nuncaChegou.marcar('declara_ciencia');
  nuncaChegou.marcar('consentimento_lgpd');
  nuncaChegou.sairDoCampoMatricula();
  await nuncaChegou.assentar();
  nuncaChegou.enviarFormulario();
  await nuncaChegou.assentar();

  teste('o envio continua barrado pelo campo obrigatório vazio — sem trava nova', () => {
    igual(nuncaChegou.pedidosPost().length, 0, 'a inscrição saiu sem curso e fase');
    igual(nuncaChegou.el('curso_fase').getAttribute('aria-invalid'), 'true',
      'a validação que já existia deixou de marcar o campo');
    verdadeiro(contem(nuncaChegou.texto('erro-curso_fase'), 'Não conseguimos carregar'),
      'no envio a mensagem virou "selecione", escondendo a causa de novo');
  });

  nuncaChegou.clicarNoCartaoDeVagas('Quero me inscrever');
  await nuncaChegou.assentar();

  teste('abrir de novo tenta de novo — o lugar da busca não fica preso', () => {
    // A fila de travadas acabou: esta responde. Se `configEmVoo` não fosse
    // liberado, o aluno ficaria sem nenhum caminho a não ser o F5.
    igual(nuncaChegou.pedidosDe('api=config').length, 7, 'nenhuma tentativa nova saiu');
    verdadeiro(contem(nuncaChegou.texto('curso_fase'), 'ADS - 1a fase'),
      'a lista chegou e o select não foi preenchido: ' + nuncaChegou.texto('curso_fase'));
    igual(nuncaChegou.el('erro-curso_fase').classList.contains('visivel'), false,
      'a mensagem de falha ficou na tela depois de a lista chegar');
    igual(nuncaChegou.el('erro-curso_fase').textContent, 'Selecione seu curso e fase.',
      'o texto de falha ficou guardado no elemento e voltaria no próximo envio');
  });

  // ---- o que NÃO pode acontecer: pedir sem precisar, e pedir duas vezes ----

  const comConfig = await siteCarregado();
  comConfig.entrarNoProjeto(0);
  await comConfig.assentar();
  comConfig.zerarPedidos();
  comConfig.clicarNoCartaoDeVagas('Quero me inscrever');
  await comConfig.assentar();

  teste('com a lista na mão, abrir o formulário NÃO pede a configuração de novo', () => {
    // Sem a condição do vazio, todo aluno que abre o formulário gasta uma
    // execução do Apps Script para receber o que já está na memória — no dia em
    // que a execução é o recurso escasso.
    igual(comConfig.pedidosDe('api=config').length, 0,
      'o formulário pede o config mesmo já tendo os cursos');
    verdadeiro(contem(comConfig.texto('curso_fase'), 'Selecione seu curso e fase'),
      'o select ficou dizendo que está carregando o que já chegou');
  });

  const doisCliques = await siteCarregado({
    demoras: { 'api=config': [Infinity, Infinity, Infinity] }
  });
  doisCliques.entrarNoProjeto(0);
  await doisCliques.assentar();
  doisCliques.zerarPedidos();
  // Os dois cliques sem deixar a resposta chegar: abrir, fechar e abrir de novo
  // depressa é o que o aluno impaciente faz quando acha que a tela travou.
  doisCliques.clicarNoCartaoDeVagas('Quero me inscrever');
  doisCliques.clicarNoCartaoDeVagas('Quero me inscrever');

  teste('abrir o formulário duas vezes depressa não vira duas buscas', () => {
    igual(doisCliques.pedidosDe('api=config').length, 1,
      'saiu uma segunda busca em paralelo — duas execuções do Apps Script pelo mesmo dado');
  });

  teste('a absorção do config é uma só, e não uma cópia por caminho', () => {
    // Duas cópias da mesma atribuição seria uma delas envelhecer sozinha: o
    // campo novo entraria na carga e faltaria em quem passou pela retentativa.
    igual((APP.match(/ESTADO\.cursosFases = /g) || []).length, 1,
      'a atribuição do estado do config foi copiada — extraia `absorverConfig`');
    verdadeiro(/absorverConfig\(cfg\)/.test(APP) && /absorverConfig\(res\)/.test(APP),
      'os dois caminhos precisam passar pela mesma função de absorver o config');
  });

  // ======================= o formato dos campos (pedido do Prof. Mário, 19/09)

  /**
   * "A matrícula tem que ter a quantidade de caracteres que a matrícula tem,
   * para forçar o aluno a digitar certo." O número vem do servidor
   * (`matriculaDigitos`, em `?api=config`), e é ele que manda no `maxlength`, no
   * filtro e na mensagem. O que se prova aqui é o CONFORTO: a régua que vale é a
   * do servidor, e o último teste do grupo garante que sem o número o site não
   * barra ninguém por conta própria.
   */
  grupo('a matrícula tem o tamanho que a matrícula tem');

  /** `?api=config` com o tamanho da matrícula — o servidor de hoje. */
  function configCom(extra) {
    return {
      ok: true,
      dados: Object.assign({
        cursosFases: ['ADS - 1a fase'],
        textoLgpd: 'Concordo.', textoDeclaracao: 'Declaro.', textoImagem: 'Autorizo.',
        textoEsgotado: 'Esgotado.', exigirMatricula: true, matriculaDigitos: 7
      }, extra || {})
    };
  }

  /** Abre o formulário do projeto aberto com a config dada, sem preencher nada. */
  async function formularioCom(opcoes) {
    const cena = await siteCarregado(opcoes);
    cena.entrarNoProjeto(0);
    await cena.assentar();
    cena.clicarNoCartaoDeVagas('Quero me inscrever');
    await cena.assentar();
    cena.zerarPedidos();
    return cena;
  }

  /** Digita no campo como o aluno digita: põe o valor e dispara `input`. */
  function digitar(cena, id, valor) {
    cena.el(id).value = valor;
    cena.el(id).disparar('input');
    return cena.el(id).value;
  }

  const sete = await formularioCom({ respostaConfig: configCom() });

  teste('o campo ganha maxlength = dígitos + 1, por causa do zero à esquerda', () => {
    igual(sete.el('matricula').getAttribute('maxlength'), '8');
    igual(sete.el('matricula').getAttribute('inputmode'), 'numeric', 'o teclado do celular tem de ser o numérico');
  });

  teste('só dígito entra: letra, ponto e espaço somem ao digitar', () => {
    igual(digitar(sete, 'matricula', '91a10.00 1'), '9110001');
    igual(digitar(sete, 'matricula', 'ADS-0001'), '0001');
    igual(digitar(sete, 'matricula', ''), '');
  });

  digitar(sete, 'matricula', '911000');
  sete.sairDoCampoMatricula();
  await sete.assentar();

  teste('seis dígitos: a mensagem diz que são 7, e o servidor nem é perguntado', () => {
    verdadeiro(sete.el('erro-matricula').classList.contains('visivel'), 'a mensagem não apareceu');
    verdadeiro(contem(sete.texto('erro-matricula'), '7 dígitos'), 'a frase foi: ' + sete.texto('erro-matricula'));
    igual(sete.el('matricula').getAttribute('aria-invalid'), 'true');
    igual(sete.pedidosDe('api=matricula').length, 0, 'matrícula de tamanho errado não vale uma execução do servidor');
  });

  digitar(sete, 'matricula', '91100011');
  sete.sairDoCampoMatricula();
  await sete.assentar();

  teste('oito dígitos SEM zero à esquerda também recusa', () => {
    verdadeiro(contem(sete.texto('erro-matricula'), '7 dígitos'), 'a frase foi: ' + sete.texto('erro-matricula'));
    igual(sete.pedidosDe('api=matricula').length, 0);
  });

  digitar(sete, 'matricula', '0110001');
  sete.sairDoCampoMatricula();
  await sete.assentar();

  teste('zero à esquerda escondendo matrícula curta recusa — é a régua do servidor', () => {
    verdadeiro(contem(sete.texto('erro-matricula'), '7 dígitos'), 'a frase foi: ' + sete.texto('erro-matricula'));
    igual(sete.pedidosDe('api=matricula').length, 0);
  });

  // O navegador falso não aplica `maxlength`; o de verdade cortaria antes. A
  // régua local tem de recusar mesmo assim — o colar e o autopreencher passam
  // por cima do maxlength em navegador antigo.
  digitar(sete, 'matricula', '009110001');
  sete.sairDoCampoMatricula();
  await sete.assentar();

  teste('dois zeros à esquerda é tamanho errado, mesmo com a chave certa atrás', () => {
    verdadeiro(contem(sete.texto('erro-matricula'), '7 dígitos'), 'a frase foi: ' + sete.texto('erro-matricula'));
    igual(sete.pedidosDe('api=matricula').length, 0);
  });

  digitar(sete, 'matricula', '09110001');
  sete.sairDoCampoMatricula();
  await sete.assentar();

  teste('oito COM zero à esquerda passa no formato e vai à lista oficial', () => {
    igual(sete.pedidosDe('api=matricula').length, 1);
    igual(sete.el('erro-matricula').classList.contains('visivel'), false);
    igual(sete.texto('selo-matricula'), '✓ matrícula conferida');
  });

  digitar(sete, 'matricula', '9110001');
  sete.sairDoCampoMatricula();
  await sete.assentar();

  teste('sete dígitos passa no formato e vai à lista oficial', () => {
    igual(sete.pedidosDe('api=matricula').length, 2);
    igual(sete.el('matricula').getAttribute('aria-invalid'), 'false');
  });

  const envioCurto = await formularioCom({ respostaConfig: configCom() });
  envioCurto.preencherFormulario({ matricula: '911000' });
  envioCurto.marcar('declara_ciencia');
  envioCurto.marcar('consentimento_lgpd');
  envioCurto.enviarFormulario();
  await envioCurto.assentar();

  teste('confirmar com matrícula curta não envia nada, e aponta o campo', () => {
    igual(envioCurto.pedidosPost().length, 0, 'o POST saiu com matrícula de tamanho errado');
    verdadeiro(envioCurto.visivel('erro-geral'));
    verdadeiro(contem(envioCurto.texto('erro-matricula'), '7 dígitos'));
  });

  const oito = await formularioCom({ respostaConfig: configCom({ matriculaDigitos: 8 }) });
  digitar(oito, 'matricula', '9110001');
  oito.sairDoCampoMatricula();
  await oito.assentar();

  teste('a configuração manda: com 8 dígitos, sete é curto e a frase diz 8', () => {
    igual(oito.el('matricula').getAttribute('maxlength'), '9');
    verdadeiro(contem(oito.texto('erro-matricula'), '8 dígitos'), 'a frase foi: ' + oito.texto('erro-matricula'));
    igual(oito.pedidosDe('api=matricula').length, 0);
  });

  // ---- O TESTE QUE PROTEGE O ALUNO: sem configuração, o site não decide ----

  const semNumero = await formularioCom({
    respostaConfig: configCom({ matriculaDigitos: undefined }),
    respostaMatricula: { ok: true, valida: false, existe: false, motivo: 'FORMATO', bloqueia: true }
  });
  digitar(semNumero, 'matricula', '911000');
  semNumero.sairDoCampoMatricula();
  await semNumero.assentar();

  teste('servidor de versão antiga (sem o número): sem maxlength, e quem reprova é o servidor', () => {
    igual(semNumero.el('matricula').getAttribute('maxlength'), null, 'apareceu um maxlength sem configuração');
    igual(semNumero.pedidosDe('api=matricula').length, 1, 'a conferência tem de ir ao servidor');
    verdadeiro(semNumero.el('erro-matricula').classList.contains('visivel'));
    verdadeiro(contem(semNumero.texto('erro-matricula'), 'Matrícula inválida'),
      'sem o número, a frase é a genérica: ' + semNumero.texto('erro-matricula'));
    verdadeiro(!contem(semNumero.texto('erro-matricula'), 'dígitos'), 'o site inventou um número que não recebeu');
  });

  const configCalada = await formularioCom({ demoras: { 'api=config': [Infinity, Infinity, Infinity] } });
  digitar(configCalada, 'matricula', '911000');
  configCalada.sairDoCampoMatricula();
  await configCalada.assentar();

  teste('servidor calado na configuração: o campo funciona e a conferência sai', () => {
    igual(configCalada.el('matricula').getAttribute('maxlength'), null);
    igual(configCalada.pedidosDe('api=matricula').length, 1, 'o aluno ficou bloqueado por falta de configuração');
  });

  const lixo = await formularioCom({ respostaConfig: configCom({ matriculaDigitos: 'sete' }) });
  const zero = await formularioCom({ respostaConfig: configCom({ matriculaDigitos: 0 }) });

  teste('número torto na configuração vale como ausente', () => {
    igual(lixo.el('matricula').getAttribute('maxlength'), null);
    igual(zero.el('matricula').getAttribute('maxlength'), null);
  });

  teste('o HTML não declara maxlength na matrícula — ele é da configuração', () => {
    const campo = /<input[^>]*id="matricula"[^>]*>/.exec(HTML)[0];
    verdadeiro(!contem(campo, 'maxlength'), 'um maxlength fixo no HTML é uma segunda régua');
    verdadeiro(contem(campo, 'inputmode="numeric"'));
    verdadeiro(contem(campo, 'type="text"'), 'type=number engole o zero à esquerda');
  });

  teste('a régua local é espelho, e a do servidor continua no caminho do envio', () => {
    // O site nunca deixa de mandar a matrícula para o POST, e o servidor a
    // revalida (`validarInscricao`). Isto é conferido no texto porque é
    // contrato entre arquivos: uma mudança que "confiasse" no formulário
    // apareceria aqui.
    verdadeiro(contem(APP, 'formatoDaMatriculaServe'), 'a função de formato sumiu do app.js');
    verdadeiro(/if \(!n\) return true;/.test(APP), 'sem o número, o site precisa dizer SIM e deixar o servidor decidir');
    const gs = fs.readFileSync(path.join(__dirname, '..', 'apps-script', '04_Inscricoes.gs'), 'utf8');
    verdadeiro(contem(gs, 'function erroFormatoMatricula_'), 'a régua do servidor sumiu');
  });

  grupo('telefone e e-mail: máscara ao digitar, conferência ao sair');

  const contato = await formularioCom({ respostaConfig: configCom() });

  teste('a máscara desenha (48) 99999-9999 conforme o aluno digita', () => {
    igual(digitar(contato, 'whatsapp', '4'), '(4');
    igual(digitar(contato, 'whatsapp', '48'), '(48');
    igual(digitar(contato, 'whatsapp', '489'), '(48) 9');
    igual(digitar(contato, 'whatsapp', '48999999'), '(48) 9999-99');
    igual(digitar(contato, 'whatsapp', '4899999999'), '(48) 9999-9999', 'fixo com DDD: 10 dígitos');
    igual(digitar(contato, 'whatsapp', '48999999999'), '(48) 99999-9999');
    igual(digitar(contato, 'whatsapp', '489999999999'), '(48) 99999-9999', 'o décimo segundo dígito não entra');
    igual(digitar(contato, 'whatsapp', '(48) 99999-9999'), '(48) 99999-9999', 'colar já formatado não dobra a máscara');
  });

  teste('o teclado do celular é o de telefone', () => {
    const campo = /<input[^>]*id="whatsapp"[^>]*>/.exec(HTML)[0];
    verdadeiro(contem(campo, 'type="tel"'));
    verdadeiro(contem(campo, 'inputmode="tel"'), 'o inputmode do WhatsApp não é tel');
  });

  digitar(contato, 'whatsapp', '999999999');
  contato.el('whatsapp').disparar('blur');

  teste('nove dígitos: ao sair do campo, a mensagem aparece', () => {
    verdadeiro(contato.el('erro-whatsapp').classList.contains('visivel'));
    igual(contato.el('whatsapp').getAttribute('aria-invalid'), 'true');
  });

  digitar(contato, 'whatsapp', '48999999999');
  contato.el('whatsapp').disparar('blur');

  teste('onze dígitos: a mensagem some', () => {
    igual(contato.el('erro-whatsapp').classList.contains('visivel'), false);
  });

  digitar(contato, 'whatsapp', '');
  contato.el('whatsapp').disparar('blur');

  teste('campo em branco não é apontado ao sair — quem cobra é o envio', () => {
    igual(contato.el('erro-whatsapp').classList.contains('visivel'), false);
  });

  contato.el('email').value = 'maria@exemplo';
  contato.el('email').disparar('blur');

  teste('e-mail sem o .algo do fim é apontado ao sair do campo', () => {
    verdadeiro(contato.el('erro-email').classList.contains('visivel'));
    igual(contato.el('email').getAttribute('aria-invalid'), 'true');
  });

  contato.el('email').value = 'maria@exemplo.com';
  contato.el('email').disparar('blur');

  teste('e-mail no formato algo@algo.algo passa', () => {
    igual(contato.el('erro-email').classList.contains('visivel'), false);
    const campo = /<input[^>]*id="email"[^>]*>/.exec(HTML)[0];
    verdadeiro(contem(campo, 'type="email"'));
  });

  const enviado = await formularioCom({ respostaConfig: configCom() });
  enviado.preencherFormulario({ matricula: '09110001', whatsapp: '' });
  digitar(enviado, 'whatsapp', '48999999999');
  enviado.marcar('declara_ciencia');
  enviado.marcar('consentimento_lgpd');
  enviado.sairDoCampoMatricula();
  await enviado.assentar();
  enviado.enviarFormulario();
  await enviado.assentar();

  teste('o POST leva o telefone só com dígitos, e a matrícula como foi digitada', () => {
    const corpo = enviado.corpoDoEnvio();
    igual(corpo.whatsapp, '48999999999', 'a máscara vazou para o servidor');
    // O zero à esquerda vai junto: quem o tira é `normalizarMatricula`, no
    // servidor, que é também quem grava. O site não normaliza chave de ninguém.
    igual(corpo.matricula, '09110001');
  });

  // ================= o período de inscrição (pedido do Prof. Mário, 19/09, item 5)

  /**
   * "Contador de tempo restante; não exibir vagas restantes após o prazo —
   * mensagem 'encerrado'." O servidor manda `janela` em `?api=config` com o
   * `agora` DELE, e é a partir dele que o site conta. Por isso toda cena deste
   * bloco abre com o relógio do NAVEGADOR quatro dias atrasado
   * (`RELOGIO_ATRASADO`): é o celular com a hora errada, e tudo que o contador
   * mostrar certo, mostrou pelo relógio do servidor. A mutação "usar
   * `Date.now()` cru" faz o mesmo contador dizer seis dias onde faltam dois.
   *
   * O que se prova: os quatro estados desenham o que devem; a virada no zero
   * acontece sozinha; o formulário aberto na virada NÃO é fechado — o envio vai
   * ao servidor e é a recusa dele que aparece; e config sem `janela` é o site
   * de hoje, sem esconder nada por falta de dado.
   */
  grupo('o período de inscrição — a faixa, o selo e o botão');

  /** O servidor de hoje: `?api=config` com a janela. `agora` é o DELE. */
  function configComJanela(janela) {
    return configCom({
      janela: Object.assign({ estado: 'ABERTA', inicio: '', fim: '', agora: '2026-10-05 10:00:00' }, janela)
    });
  }

  /** O navegador abre em 01/10 às 10:00 — quatro dias antes do `agora` do servidor. */
  const RELOGIO_ATRASADO = Date.UTC(2026, 9, 1, 10, 0, 0);

  async function siteNaJanela(janela, opcoes) {
    return siteCarregado(Object.assign({
      respostaConfig: configComJanela(janela), instante: RELOGIO_ATRASADO
    }, opcoes || {}));
  }

  /** O botão de inscrever do cartão, com ou sem ouvinte — `acharClicavel` só acha com. */
  function botaoDoCartao(cena) {
    let achado = null;
    (function descer(el) {
      el.filhos.forEach((f) => {
        if (achado) return;
        if (f.tagName === 'BUTTON' && f.textContent === 'Quero me inscrever') achado = f;
        else descer(f);
      });
    })(cena.el('cartao-vagas'));
    return achado;
  }

  // ---- servidor velho: sem `janela` ----

  const semJanela = await siteCarregado({ respostaConfig: configCom(), instante: RELOGIO_ATRASADO });
  semJanela.entrarNoProjeto(0);
  await semJanela.assentar();

  teste('config sem `janela` — servidor de versão anterior — é o site de hoje', () => {
    igual(semJanela.visivel('faixa-janela'), false, 'apareceu uma faixa sem o servidor ter mandado janela');
    verdadeiro(contem(semJanela.texto('grade-projetos'), '50 vagas restantes'), 'as vagas sumiram sem dado nenhum');
    verdadeiro(contem(semJanela.texto('cartao-vagas'), '10 de 60'));
    verdadeiro(acharClicavel(semJanela.el('cartao-vagas'), 'Quero me inscrever'), 'o botão sumiu sem dado nenhum');
    igual(semJanela.intervalosVivos(), 0, 'há um contador rodando sem nada para contar');
  });

  // ---- ANTES ----

  const antes = await siteNaJanela({ estado: 'ANTES', inicio: '2026-10-07 15:12' });

  teste('ANTES: a faixa diz quando abre e quanto falta — pelo relógio do SERVIDOR', () => {
    verdadeiro(antes.visivel('faixa-janela'));
    verdadeiro(contem(antes.el('faixa-janela').className, 'aviso--atencao'), antes.el('faixa-janela').className);
    igual(antes.texto('faixa-janela-titulo'), 'As inscrições abrem em 07/10 às 15:12');
    // Do servidor (05/10 10:00) até 07/10 15:12: 2 dias, 5 horas e 12 minutos.
    // Pelo relógio do navegador, atrasado, seriam 6 dias.
    igual(antes.texto('faixa-janela-contador'), 'faltam 2 dias, 5 horas e 12 minutos');
  });

  teste('ANTES: a faixa mostra a data como dd/mm às HH:mm, e nunca o carimbo do servidor', () => {
    const titulo = antes.texto('faixa-janela-titulo');
    verdadeiro(/\b\d{2}\/\d{2} às \d{2}:\d{2}$/.test(titulo), titulo);
    igual(contem(titulo, '2026-10'), false, 'o carimbo bruto vazou para a tela: ' + titulo);
  });

  antes.entrarNoProjeto(0);
  await antes.assentar();

  teste('ANTES: os cartões mostram as vagas, e o botão existe desligado, com o motivo', () => {
    verdadeiro(contem(antes.texto('grade-projetos'), '50 vagas restantes'), 'antes de abrir as vagas continuam à mostra');
    verdadeiro(contem(antes.texto('cartao-vagas'), '10 de 60'));

    const botao = botaoDoCartao(antes);
    verdadeiro(botao, 'o botão sumiu — antes de abrir ele fica desligado, não some');
    igual(botao.disabled, true, 'O BOTÃO ESTÁ LIGADO ANTES DE A JANELA ABRIR');
    igual(acharClicavel(antes.el('cartao-vagas'), 'Quero me inscrever'), null,
      'o botão desligado tem ouvinte de clique: abriria o formulário');
    verdadeiro(contem(antes.texto('cartao-vagas'), 'As inscrições abrem em 07/10 às 15:12'),
      'o motivo não está escrito no cartão: ' + antes.texto('cartao-vagas'));
  });

  // A mesma cena com o navegador NA HORA do servidor tem de mostrar o mesmo
  // número: se os dois diferem, o contador está lendo `Date.now()` cru.
  const naHora = await siteNaJanela({ estado: 'ANTES', inicio: '2026-10-07 15:12' },
    { instante: Date.UTC(2026, 9, 5, 10, 0, 0) });

  teste('o contador conta a partir do `agora` do servidor, não do relógio do aluno', () => {
    igual(naHora.texto('faixa-janela-contador'), antes.texto('faixa-janela-contador'));
    igual(naHora.texto('faixa-janela-contador'), 'faltam 2 dias, 5 horas e 12 minutos');
  });

  // ---- ABERTA com fim ----

  const aberta = await siteNaJanela({ estado: 'ABERTA', inicio: '2026-10-01 08:00', fim: '2026-10-30 18:00' });

  teste('ABERTA com fim: a faixa diz até quando e quanto falta', () => {
    verdadeiro(contem(aberta.el('faixa-janela').className, 'aviso--sucesso'), aberta.el('faixa-janela').className);
    igual(aberta.texto('faixa-janela-titulo'), 'Inscrições abertas até 30/10 às 18:00');
    igual(aberta.texto('faixa-janela-contador'), 'faltam 25 dias e 8 horas');
  });

  aberta.entrarNoProjeto(0);
  await aberta.assentar();
  await inscrever(aberta);

  teste('ABERTA: tudo como hoje — vagas, botão, e a inscrição sai', () => {
    verdadeiro(contem(aberta.texto('grade-projetos'), '50 vagas restantes'));
    igual(aberta.pedidosPost().length, 1, 'a inscrição não saiu com a janela aberta');
    verdadeiro(aberta.visivel('painel-sucesso'));
  });

  const soInicio = await siteNaJanela({ estado: 'ABERTA', inicio: '2026-10-01 08:00' });

  teste('ABERTA sem fim não tem faixa nem contador: não há prazo a contar', () => {
    igual(soInicio.visivel('faixa-janela'), false);
    igual(soInicio.intervalosVivos(), 0);
  });

  // ---- DEPOIS ----

  const depois = await siteNaJanela({ estado: 'DEPOIS', fim: '2026-10-03 18:00' });

  teste('DEPOIS: a faixa diz encerradas, com a data', () => {
    verdadeiro(contem(depois.el('faixa-janela').className, 'aviso--erro'), depois.el('faixa-janela').className);
    igual(depois.texto('faixa-janela-titulo'), 'Inscrições encerradas');
    igual(depois.texto('faixa-janela-contador'), 'O prazo terminou em 03/10 às 18:00.');
    igual(depois.intervalosVivos(), 0, 'há um contador rodando depois do fim');
  });

  teste('DEPOIS: nenhum cartão mostra vaga — o selo vira "Encerradas"', () => {
    const lista = depois.texto('grade-projetos');
    verdadeiro(contem(lista, 'Encerradas'), lista);
    igual(contem(lista, 'vagas restantes') || contem(lista, 'vaga restante'), false,
      'VAGAS RESTANTES DEPOIS DO PRAZO: ' + lista);
    igual(contem(lista, 'no total'), false, 'o total também é número de vaga: ' + lista);
    depois.cartoes().forEach((cartao) => {
      verdadeiro(contem(cartao.className, 'cartao-projeto--indisponivel'), 'cartão aberto num semestre encerrado');
    });
  });

  depois.entrarNoProjeto(0);
  await depois.assentar();

  teste('DEPOIS: o detalhe diz encerrado, sem números e sem botão', () => {
    const cartao = depois.texto('cartao-vagas');
    igual(contem(cartao, 'de 60'), false, 'a ocupação apareceu depois do prazo: ' + cartao);
    igual(contem(cartao, 'no total'), false, cartao);
    igual(botaoDoCartao(depois), null, 'o botão continua no cartão depois do prazo');
    verdadeiro(contem(cartao, 'Inscrições encerradas'), cartao);
    verdadeiro(contem(cartao, 'terminou em 03/10 às 18:00'), cartao);
    verdadeiro(acharClicavel(depois.el('cartao-vagas'), 'Ver outros projetos'), 'sem saída para a lista');
  });

  const depoisSemContagem = await siteNaJanela({ estado: 'DEPOIS', fim: '2026-10-03 18:00' }, {
    projetos: PROJETOS_PADRAO.map((p) => Object.assign({}, p, { inscritos: null, restantes: null }))
  });

  teste('DEPOIS com a ocupação não contada: nem "60 vagas no total" aparece', () => {
    igual(contem(depoisSemContagem.texto('grade-projetos'), 'no total'), false);
    depoisSemContagem.entrarNoProjeto(0);
    igual(contem(depoisSemContagem.texto('cartao-vagas'), 'no total'), false);
  });

  const depoisEsgotado = await siteNaJanela({ estado: 'DEPOIS', fim: '2026-10-03 18:00' }, {
    projetos: [Object.assign({}, PROJETOS_PADRAO[0], { situacao: 'ESGOTADO', inscritos: 60, restantes: 0 })]
  });
  depoisEsgotado.entrarNoProjeto(0);
  await depoisEsgotado.assentar();

  teste('DEPOIS vence o esgotado: encerrou, esgotado ou não', () => {
    verdadeiro(contem(depoisEsgotado.texto('grade-projetos'), 'Encerradas'));
    igual(contem(depoisEsgotado.texto('grade-projetos'), 'Esgotado'), false);
    verdadeiro(contem(depoisEsgotado.texto('cartao-vagas'), 'Inscrições encerradas'));
    igual(contem(depoisEsgotado.texto('cartao-vagas'), 'esgotadas'), false);
  });

  const jaInscritoDepois = await siteNaJanela({ estado: 'DEPOIS', fim: '2026-10-03 18:00' }, {
    armazenamento: { 'cesutech.inscricoes': JSON.stringify({ ARTE: 'PROTO-1' }) }
  });
  jaInscritoDepois.entrarNoProjeto(0);
  await jaInscritoDepois.assentar();

  teste('DEPOIS, quem já se inscreveu continua vendo que está inscrito — mas sem "fazer outra"', () => {
    verdadeiro(contem(jaInscritoDepois.texto('cartao-vagas'), 'Você já está inscrito'));
    igual(acharClicavel(jaInscritoDepois.el('cartao-vagas'), 'Não foi você'), null,
      'a saída do computador compartilhado abriria um formulário que o servidor vai recusar');
  });

  // O config chega ANTES da lista, e com a lista fora do ar: redesenhar a lista
  // vazia por causa da janela escreveria "Nenhum projeto disponível" — a
  // mensagem de sistema VAZIO para um sistema fora do ar, o defeito de
  // `carregarTudo`, por uma porta nova.
  const listaForaDoAr = abrirSite({
    respostaConfig: configComJanela({ estado: 'DEPOIS', fim: '2026-10-03 18:00' }),
    instante: RELOGIO_ATRASADO
  });
  listaForaDoAr.projetosFalham = true;
  listaForaDoAr.carregar();
  await listaForaDoAr.assentar();

  teste('a janela não desenha a lista que ainda não chegou: fora do ar não vira "nenhum projeto"', () => {
    igual(contem(listaForaDoAr.texto('grade-projetos'), 'Nenhum projeto disponível'), false,
      listaForaDoAr.texto('grade-projetos'));
    verdadeiro(contem(listaForaDoAr.texto('carregando-projetos'), 'Não conseguimos falar com o servidor'));
    igual(listaForaDoAr.texto('faixa-janela-titulo'), 'Inscrições encerradas', 'a faixa, essa aparece');
  });

  // ---- a virada, sozinha ----

  const virando = await siteNaJanela({ estado: 'ABERTA', fim: '2026-10-05 10:12' });
  virando.entrarNoProjeto(0);
  await virando.assentar();
  const aoAbrir = virando.texto('faixa-janela-contador');
  const contadorVivo = virando.intervalosVivos();

  await virando.avancarRelogio(121000);
  virando.tique();
  const aosDoisMinutos = virando.texto('faixa-janela-contador');

  await virando.avancarRelogio(9 * 60000 + 58000);
  virando.tique();
  const aUmSegundo = virando.texto('faixa-janela-contador');
  const botaoAntesDaVirada = acharClicavel(virando.el('cartao-vagas'), 'Quero me inscrever');

  teste('o contador anda com o tique, e mostra segundos nos últimos dez minutos', () => {
    igual(aoAbrir, 'faltam 12 minutos');
    igual(contadorVivo, 1, 'o contador não está rodando');
    igual(aosDoisMinutos, 'faltam 9 minutos e 59 segundos');
    igual(aUmSegundo, 'falta 1 segundo');
  });

  await virando.avancarRelogio(1000);
  virando.tique();

  teste('ABERTA→DEPOIS: no zero a faixa vira sozinha, e os cartões e o detalhe vão junto', () => {
    verdadeiro(botaoAntesDaVirada, 'antes da virada o botão está lá');
    igual(virando.texto('faixa-janela-titulo'), 'Inscrições encerradas');
    igual(virando.texto('faixa-janela-contador'), 'O prazo terminou em 05/10 às 10:12.');
    verdadeiro(contem(virando.texto('grade-projetos'), 'Encerradas'), virando.texto('grade-projetos'));
    igual(contem(virando.texto('grade-projetos'), 'vagas restantes'), false);
    igual(botaoDoCartao(virando), null, 'o botão sobreviveu à virada');
    verdadeiro(contem(virando.texto('cartao-vagas'), 'Inscrições encerradas'));
    igual(virando.pedidosDe('api=config').length, 1, 'a virada pediu o config de novo — ela é local');
    igual(virando.intervalosVivos(), 0, 'depois do fim não há mais o que contar');
  });

  const abrindo = await siteNaJanela({ estado: 'ANTES', inicio: '2026-10-05 10:01', fim: '2026-10-30 18:00' });
  abrindo.entrarNoProjeto(0);
  await abrindo.assentar();
  const desligadoAntes = botaoDoCartao(abrindo).disabled;
  await abrindo.avancarRelogio(60000);
  abrindo.tique();

  teste('ANTES→ABERTA: o botão liga sozinho quando chega a hora', () => {
    igual(desligadoAntes, true, 'antes da hora o botão já estava ligado');
    igual(abrindo.texto('faixa-janela-titulo'), 'Inscrições abertas até 30/10 às 18:00');
    verdadeiro(contem(abrindo.el('faixa-janela').className, 'aviso--sucesso'));
    igual(botaoDoCartao(abrindo).disabled, false, 'a janela abriu e o botão continua desligado');
    igual(contem(abrindo.texto('cartao-vagas'), 'abrem em'), false, 'o motivo de esperar ficou no cartão');

    abrindo.clicarNoCartaoDeVagas('Quero me inscrever');
    verdadeiro(abrindo.visivel('area-formulario'), 'o botão ligado não abre o formulário');
  });

  const abrindoSemFim = await siteNaJanela({ estado: 'ANTES', inicio: '2026-10-05 10:01' });
  await abrindoSemFim.avancarRelogio(60000);
  abrindoSemFim.tique();

  teste('ANTES→ABERTA sem fim: a faixa some e o contador para', () => {
    igual(abrindoSemFim.visivel('faixa-janela'), false);
    igual(abrindoSemFim.intervalosVivos(), 0);
    verdadeiro(contem(abrindoSemFim.texto('grade-projetos'), '50 vagas restantes'));
  });

  // ---- o formulário aberto no instante do encerramento ----

  const noLimite = await siteNaJanela({ estado: 'ABERTA', fim: '2026-10-05 10:01' }, {
    respostaEnvio: { ok: false, erro: 'As inscrições encerraram em 05/10/2026 às 10:01.' }
  });
  noLimite.entrarNoProjeto(0);
  await noLimite.assentar();
  prepararFormulario(noLimite);
  await noLimite.avancarRelogio(61000);
  noLimite.tique();

  teste('o formulário aberto na virada continua aberto — nada de bloqueio local', () => {
    verdadeiro(contem(noLimite.texto('cartao-vagas'), 'Inscrições encerradas'), 'o cartão não virou');
    verdadeiro(noLimite.visivel('area-formulario'), 'A VIRADA FECHOU O FORMULÁRIO que o aluno estava preenchendo');
  });

  noLimite.sairDoCampoMatricula();
  await noLimite.assentar();
  noLimite.enviarFormulario();
  await noLimite.assentar();

  teste('o envio vai ao servidor, e é a recusa DELE, com a data, que aparece', () => {
    igual(noLimite.pedidosPost().length, 1, 'o site barrou o envio por conta própria');
    verdadeiro(noLimite.visivel('erro-geral'));
    igual(noLimite.texto('erro-geral'), 'As inscrições encerraram em 05/10/2026 às 10:01.');
    igual(noLimite.visivel('painel-sucesso'), false);
    verdadeiro(noLimite.visivel('area-formulario'), 'o formulário sumiu como se o projeto tivesse lotado');
  });

  // ---- o que a tela faz sem relógio do servidor ----

  const semRelogio = await siteNaJanela({ estado: 'DEPOIS', fim: '2026-10-03 18:00', agora: '' });

  teste('`agora` ilegível: a faixa mostra o estado que o servidor disse, parada e sem contador', () => {
    igual(semRelogio.texto('faixa-janela-titulo'), 'Inscrições encerradas');
    igual(contem(semRelogio.texto('grade-projetos'), 'vagas restantes'), false);
    igual(semRelogio.intervalosVivos(), 0);
  });

  teste('a mesma pergunta decide a faixa, o selo e o cartão — e é a conta do servidor', () => {
    verdadeiro((APP.match(/estadoDaJanela\(\)/g) || []).length >= 4,
      'a faixa, a lista, o selo e o cartão precisam perguntar à mesma função');
    verdadeiro(/agoraDoServidorMs\(\)/.test(APP) && !/Date\.now\(\)\s*[<>]=?\s*\w+\.(inicio|fim)Ms/.test(APP),
      'o estado está sendo decidido com Date.now() cru, e não com o relógio do servidor');
    verdadeiro(/aria-live="polite"[^>]*>/.test(/<strong id="faixa-janela-titulo"[^>]*>/.exec(HTML)[0]),
      'o título da faixa deixou de ser anunciado ao leitor de tela');
  });

  // ============================================ a troca de projeto (item 4)

  /**
   * A TROCA DE PROJETO, pelo lado do aluno.
   *
   * Com `aluno_projeto_unico=SIM` no servidor, quem já está em outro projeto não
   * recebe mais uma recusa seca: recebe uma PERGUNTA (`troca_pendente`), com o
   * formulário preenchido intacto, e a troca só acontece no segundo envio, que
   * leva `trocar_de`. Nada é gravado entre uma coisa e outra — o servidor
   * responde a pergunta sem pegar lock e sem escrever (04_Inscricoes.gs).
   *
   * O que estes testes guardam, e por que cada um existe:
   *
   *   - a pergunta é da TELA, não do navegador: nada de `window.confirm`, que
   *     não cabe o nome dos projetos e aparece descolado do formulário;
   *   - o segundo envio leva os ids que o SERVIDOR nomeou, e o site esquece do
   *     `localStorage` TUDO o que mandou em `trocar_de` em qualquer `ok:true` —
   *     senão ele continuaria dizendo "você já está inscrito", com um protocolo
   *     morto, num projeto de onde o aluno saiu;
   *   - a recusa por vaga cheia precisa dizer que NADA foi cancelado. Quem
   *     clicou em "trocar e cancelar" e lê só "inscrição não concluída" conclui
   *     que ficou sem projeto nenhum;
   *   - falha na confirmação não devolve o botão original: a pergunta continua
   *     na tela, e clicar em [Trocar] repete a rodada 2, nunca a 1.
   *
   * Os projetos e as matrículas são a FORMA do dado, nunca o dado: o falso já
   * nasce com "Arte Digital Floripa" e "R+ Cidades", e a matrícula é 9110001.
   */
  grupo('a troca de projeto — a pergunta antes de cancelar');

  const ARTE_ATIVA = {
    projeto_id: 'p1', projeto_nome: 'Arte Digital Floripa', codigo: 'ARTE', em_espera: false
  };
  // A 1ª fase: `ok:false` porque nada foi gravado, `troca_pendente` porque não é
  // erro — é uma pergunta esperando resposta.
  const PERGUNTA = {
    ok: false, troca_pendente: true,
    erro: 'Você já está inscrito em Arte Digital Floripa.',
    de: [ARTE_ATIVA]
  };
  const TROCA_FEITA = {
    ok: true, duplicada: false, protocolo: 'PROTO-NOVO',
    mensagem: 'Inscrição registrada com sucesso. ' +
      'Sua inscrição anterior em Arte Digital Floripa foi cancelada.',
    trocada: { de: [{ projeto_nome: 'Arte Digital Floripa', codigo: 'ARTE' }] }
  };
  const LEMBRANCA_DE_ARTE = { 'cesutech.inscricoes': JSON.stringify({ ARTE: 'PROTO-ANTIGO' }) };

  /** Abre o site, entra em R+ Cidades (o projeto NOVO) e envia: a rodada 1. */
  async function ateAPergunta(opcoes) {
    const cena = await siteCarregado(Object.assign({ respostaEnvio: PERGUNTA }, opcoes || {}));
    cena.entrarNoProjeto(1);
    await cena.assentar();
    await inscrever(cena);
    return cena;
  }

  const clicarEmTrocar = (cena) => cena.el('botao-trocar-projeto').disparar('click');
  const corpoDoPost = (cena, indice) => JSON.parse(cena.pedidosPost()[indice].opcoes.body);

  const pergunta = await ateAPergunta();

  teste('a pergunta ocupa o lugar do botão, e o formulário fica preenchido', () => {
    // A MUTAÇÃO QUE DERRUBA: trocar o bloco por `window.confirm`.
    verdadeiro(pergunta.visivel('bloco-troca'), 'a pergunta não apareceu');
    igual(pergunta.visivel('botao-enviar'), false, 'o botão original continuou na tela');
    igual(pergunta.confirmacoes.length, 0, 'apareceu um confirm do navegador');

    // Sem `reset()`: a confirmação é o MESMO envio outra vez, e perder o
    // preenchimento cobraria a digitação inteira por uma pergunta do site.
    igual(pergunta.el('matricula').value, '9110001');
    igual(pergunta.el('email').value, 'maria@exemplo.com');
    igual(pergunta.el('declara_ciencia').checked, true);
    verdadeiro(pergunta.visivel('area-formulario'), 'o formulário saiu da tela');
  });

  teste('ela nomeia os dois projetos, e diz o que será cancelado', () => {
    // O título, o texto e os dois botões são lidos um a um porque no DOM falso
    // os elementos do HTML são planos — não há árvore para somar o texto dos
    // filhos. Na tela eles são as quatro linhas do mesmo bloco.
    igual(pergunta.texto('bloco-troca-titulo'), 'Você já está inscrito em Arte Digital Floripa');

    const t = pergunta.texto('bloco-troca-texto');
    verdadeiro(contem(t, 'R+ Cidades'), t);
    verdadeiro(contem(t, 'Arte Digital Floripa'), t);
    verdadeiro(contem(t, 'CANCELADA'), t);
    // A promessa que o servidor cumpre com o lock: sem vaga, nada muda.
    verdadeiro(contem(t, 'nada muda'), t);

    igual(pergunta.texto('botao-manter-inscricao'), 'Manter minha inscrição em Arte Digital Floripa');
    igual(pergunta.texto('botao-trocar-projeto'),
      'Trocar para R+ Cidades e cancelar Arte Digital Floripa');
  });

  teste('é um alertdialog, recebe o foco, e mora DENTRO do #area-formulario', () => {
    // O lugar é decisão: no `#cartao-vagas` a pergunta sumiria sozinha, porque
    // `renderizarCartaoVagas` redesenha aquele bloco a cada renovação da lista.
    igual(pergunta.el('bloco-troca').getAttribute('role'), 'alertdialog');
    verdadeiro(pergunta.el('bloco-troca').focos >= 1, 'a pergunta não recebeu o foco');

    const area = HTML.indexOf('id="area-formulario"');
    const bloco = HTML.indexOf('id="bloco-troca"');
    const botao = HTML.indexOf('id="botao-enviar"');
    verdadeiro(area !== -1 && bloco !== -1 && botao !== -1, 'algum dos três ids sumiu do HTML');
    verdadeiro(bloco > area && bloco < botao,
      'o bloco da troca saiu de dentro do formulário, ou foi parar depois do botão');
  });

  // O Enter tem de ser disparado FORA do `teste`, com `assentar()` no meio: o
  // envio passa por `conferirMatricula().then(...)`, então o POST só sai numa
  // microtarefa posterior. Medir a contagem na mesma volta do laço é medir o
  // instante ANTES de o envio acontecer — e um teste desses fica verde com a
  // guarda arrancada, que é como este nasceu.
  const ANTES_DO_ENTER = pergunta.pedidosPost().length;
  pergunta.enviarFormulario();
  await pergunta.assentar();

  teste('com a pergunta na tela, dar Enter no formulário não confirma nada', () => {
    // O botão de enviar está escondido, mas o formulário continua submetendo com
    // Enter num campo — e quem aperta Enter lendo "será CANCELADA" não está
    // respondendo à pergunta. *Mutação:* tirar a guarda de `ESTADO.trocaPendente`
    // de `enviar` → sai um POST com `trocar_de` que ninguém clicou → cai.
    igual(pergunta.pedidosPost().length, ANTES_DO_ENTER);
    igual(pergunta.pedidosPost().length, 1, 'o único POST é o da rodada 1');
    igual(corpoDoPost(pergunta, 0).trocar_de, undefined,
      'o que não saiu era um cancelamento: o POST da rodada 1 não leva `trocar_de`');
  });

  // ---- a rodada 2: o mesmo envio, agora com `trocar_de`

  const emVooDaTroca = await ateAPergunta({ demoras: { POST: [0, Infinity] } });
  emVooDaTroca.respostaEnvio = TROCA_FEITA;
  clicarEmTrocar(emVooDaTroca);
  await emVooDaTroca.assentar();

  teste('[Trocar] repete o envio com os MESMOS campos e os ids do servidor', () => {
    // A MUTAÇÃO QUE DERRUBA: não mandar `trocar_de` — o servidor voltaria a
    // perguntar, para sempre, e nenhuma troca aconteceria nunca.
    igual(emVooDaTroca.pedidosPost().length, 2);

    const primeiro = corpoDoPost(emVooDaTroca, 0);
    const segundo = corpoDoPost(emVooDaTroca, 1);
    igual(segundo.trocar_de, ['p1']);
    igual(primeiro.trocar_de, undefined, 'a rodada 1 mandou trocar_de');
    ['matricula', 'nome', 'curso_fase', 'email', 'whatsapp', 'declara_ciencia',
      'consentimento_lgpd', 'autoriza_imagem'].forEach((campo) => {
      igual(segundo[campo], primeiro[campo], 'o campo ' + campo + ' mudou entre as rodadas');
    });
  });

  teste('e, enquanto ela está em voo, os botões da pergunta ficam desligados', () => {
    // Dois cliques mandariam duas confirmações, e a segunda pediria para
    // cancelar o que a primeira já cancelou.
    igual(emVooDaTroca.el('botao-trocar-projeto').disabled, true);
    igual(emVooDaTroca.el('botao-manter-inscricao').disabled, true);
    verdadeiro(emVooDaTroca.visivel('status-envio'), 'a espera não foi anunciada');
    verdadeiro(contem(emVooDaTroca.texto('status-envio'), 'Enviando sua inscrição'),
      emVooDaTroca.texto('status-envio'));
    verdadeiro(emVooDaTroca.visivel('bloco-troca'), 'a pergunta sumiu durante o envio');
  });

  const trocou = await ateAPergunta({ armazenamento: LEMBRANCA_DE_ARTE });
  trocou.respostaEnvio = TROCA_FEITA;
  clicarEmTrocar(trocou);
  await trocou.assentar();

  teste('a troca concluída mostra o protocolo NOVO e diz o que foi cancelado', () => {
    verdadeiro(trocou.visivel('painel-sucesso'), 'o comprovante não apareceu');
    verdadeiro(contem(trocou.texto('sucesso-protocolo'), 'PROTO-NOVO'), 'o protocolo novo sumiu');
    igual(contem(trocou.texto('sucesso-protocolo'), 'PROTO-ANTIGO'), false,
      'o comprovante mostrou o protocolo da inscrição cancelada');
    igual(trocou.texto('sucesso-projeto-nome'), 'R+ Cidades');

    verdadeiro(trocou.visivel('sucesso-aviso'), 'a faixa do cancelamento não apareceu');
    verdadeiro(contem(trocou.texto('sucesso-aviso'), 'anterior em Arte Digital Floripa foi cancelada'),
      trocou.texto('sucesso-aviso'));
  });

  teste('e o navegador passa a lembrar do projeto NOVO, e só dele', () => {
    // D17. A MUTAÇÃO QUE DERRUBA: não esquecer a antiga — o site continuaria
    // dizendo "você já está inscrito" num projeto que o servidor cancelou.
    const dados = JSON.parse(trocou.armazenamento.dados['cesutech.inscricoes']);
    igual(dados.CIDADES, 'PROTO-NOVO');
    igual(Object.prototype.hasOwnProperty.call(dados, 'ARTE'), false,
      'a lembrança do projeto cancelado ficou');
  });

  const semTrocada = await ateAPergunta({ armazenamento: LEMBRANCA_DE_ARTE });
  semTrocada.respostaEnvio = {
    ok: true, duplicada: true, mensagem: 'Você já está inscrito neste projeto.'
  };
  clicarEmTrocar(semTrocada);
  await semTrocada.assentar();

  teste('`ok:true` SEM `trocada` esquece a antiga do mesmo jeito', () => {
    // O caso real: a coordenação anulou a inscrição antiga entre a pergunta e a
    // confirmação, e o servidor gravou a nova direto — ou a resposta do commit
    // se perdeu e o reenvio voltou `duplicada`. Nos dois, a antiga não existe
    // mais. *Mutação:* esquecer só quando vem `trocada` → cai.
    const dados = JSON.parse(semTrocada.armazenamento.dados['cesutech.inscricoes']);
    igual(Object.prototype.hasOwnProperty.call(dados, 'ARTE'), false);
    verdadeiro(Object.prototype.hasOwnProperty.call(dados, 'CIDADES'), 'não lembrou do novo');
  });

  // ---- a vaga que acaba entre a pergunta e a confirmação

  const perdeuAVaga = await ateAPergunta();
  perdeuAVaga.respostaEnvio = {
    ok: false, situacao: 'ESGOTADO',
    erro: 'As vagas de R+ Cidades acabaram agora. Sua inscrição em Arte Digital Floripa foi mantida.',
    mantida: [ARTE_ATIVA]
  };
  clicarEmTrocar(perdeuAVaga);
  await perdeuAVaga.assentar();

  teste('vaga cheia na confirmação: o aviso diz que NADA foi cancelado', () => {
    // A MUTAÇÃO QUE DERRUBA: manter o texto de sempre ("seus dados não foram
    // registrados") — quem acabou de autorizar um cancelamento leria isso como
    // "fiquei sem os dois".
    const t = perdeuAVaga.texto('aviso-perda-vaga');
    verdadeiro(perdeuAVaga.visivel('aviso-perda-vaga'), 'o aviso não apareceu');
    // O TÍTULO é o da situação, e são três, como as do detalhe. *Mutação:* dar
    // ao título só dois ramos (o que ele tinha) → o esgotado continua certo e as
    // outras duas viram "as inscrições foram encerradas" em negrito.
    verdadeiro(contem(t, 'ficou sem vaga'), 'o título não é o do esgotado: ' + t);
    verdadeiro(contem(t, 'prazo deste projeto terminou') === false, t);
    verdadeiro(contem(t, 'saiu da lista') === false, t);
    verdadeiro(contem(t, 'continua valendo'), t);
    verdadeiro(contem(t, 'nada foi cancelado'), t);
    verdadeiro(contem(t, 'Arte Digital Floripa'), t);
    igual(perdeuAVaga.visivel('area-formulario'), false, 'o formulário ficou na tela');

    // E a pergunta foi DESMONTADA junto: o botão de sempre está de volta no
    // lugar dela, dentro do formulário fechado. *Mutação:* não zerar a troca
    // neste caminho → o formulário guarda, escondido, o bloco de uma
    // confirmação que não vale mais.
    verdadeiro(perdeuAVaga.visivel('botao-enviar'), 'o formulário guardou a pergunta morta');
    igual(perdeuAVaga.visivel('bloco-troca'), false);
  });

  perdeuAVaga.respostaEnvio = {
    ok: true, duplicada: false, mensagem: 'Inscrição registrada.', protocolo: 'PROTO-OUTRO'
  };
  perdeuAVaga.voltarParaLista();
  await perdeuAVaga.assentar();
  perdeuAVaga.entrarNoProjeto(0);
  await perdeuAVaga.assentar();
  await inscrever(perdeuAVaga);

  teste('e a confirmação morre ali: o próximo envio não leva trocar_de nenhum', () => {
    // *Mutação:* não zerar `trocaPendente` no caminho da vaga perdida → o envio
    // seguinte, noutro projeto, pediria um cancelamento que o aluno autorizou
    // para outra tela → cai.
    //
    // A contagem faz parte da afirmação: com a troca viva, o envio seguinte nem
    // sairia (o formulário se recusa a submeter enquanto há pergunta na tela), e
    // um teste que só olhasse o ÚLTIMO corpo leria o da rodada 1 e passaria.
    igual(perdeuAVaga.pedidosPost().length, 3, 'o terceiro envio não saiu');
    igual(corpoDoPost(perdeuAVaga, 2).trocar_de, undefined);
  });

  // ---- o projeto que FECHA (ou some) entre a pergunta e a confirmação

  const fechouNoMeio = await ateAPergunta();
  fechouNoMeio.respostaEnvio = {
    ok: false, situacao: 'FECHADO',
    erro: 'As inscrições de R+ Cidades foram encerradas. Sua inscrição em Arte Digital Floripa foi mantida.',
    mantida: [ARTE_ATIVA]
  };
  clicarEmTrocar(fechouNoMeio);
  await fechouNoMeio.assentar();

  teste('projeto fechado na confirmação: a abertura é a da situação, e o fecho é o mesmo', () => {
    // O servidor manda `mantida` em QUALQUER recusa por situação (não só no
    // ESGOTADO), e a frase daqui é a gêmea de `fraseDaVagaPerdida_`
    // (04_Inscricoes.gs). *Mutação:* usar a abertura do esgotado para tudo → o
    // aviso diria "as vagas acabaram" sobre um projeto que fechou a inscrição,
    // e o aluno ficaria esperando uma vaga que não vai abrir.
    const t = fechouNoMeio.texto('aviso-perda-vaga');
    verdadeiro(contem(t, 'foram encerradas'), t);
    verdadeiro(contem(t, 'acabaram agora') === false, 'a abertura do esgotado vazou: ' + t);
    verdadeiro(contem(t, 'prazo deste projeto terminou'), 'o título não é o do fechado: ' + t);
    verdadeiro(contem(t, 'ficou sem vaga') === false, 'o título do esgotado vazou: ' + t);
    verdadeiro(contem(t, 'nada foi cancelado'), t);
  });

  const desligado = await ateAPergunta();
  desligado.respostaEnvio = {
    ok: false, situacao: 'INATIVO',
    erro: 'O projeto R+ Cidades não está mais disponível. Sua inscrição em Arte Digital Floripa foi mantida.',
    mantida: [ARTE_ATIVA]
  };
  clicarEmTrocar(desligado);
  await desligado.assentar();

  teste('projeto desligado na confirmação: ele não teve as inscrições encerradas, ele sumiu', () => {
    // *Mutação:* juntar INATIVO com FECHADO numa abertura só → o aviso diz
    // "encerradas" sobre um projeto que a coordenação tirou do ar, e quem ler
    // vai procurar o prazo em vez de procurar a coordenação.
    const t = desligado.texto('aviso-perda-vaga');
    verdadeiro(contem(t, 'não está mais disponível'), t);
    // A EXCLUSÃO vale para o aviso INTEIRO, e não só para o detalhe: o título é
    // um `<strong>` no MESMO elemento, e por muito tempo ele dizia "as
    // inscrições foram encerradas" logo acima de "não está mais disponível" —
    // as duas coisas ao mesmo tempo, sobre o mesmo projeto.
    verdadeiro(contem(t, 'foram encerradas') === false, 'a abertura do fechado vazou: ' + t);
    verdadeiro(contem(t, 'saiu da lista'), 'o título não é o do projeto desligado: ' + t);
    verdadeiro(contem(t, 'acabaram agora') === false, t);
    verdadeiro(contem(t, 'nada foi cancelado'), t);
  });

  // ---- [Manter]: a saída que não escreve nada

  const manteve = await ateAPergunta();
  const postsAteAqui = manteve.pedidosPost().length;
  manteve.el('botao-manter-inscricao').disparar('click');
  await manteve.assentar();

  teste('[Manter] some com a pergunta, devolve o botão e volta para a lista', () => {
    // A MUTAÇÃO QUE DERRUBA: mandar um POST de "desisti" — não existe tal coisa,
    // e o servidor não escreveu nada que precise ser desfeito.
    igual(manteve.pedidosPost().length, postsAteAqui, 'saiu um POST de quem desistiu');
    igual(manteve.visivel('bloco-troca'), false, 'a pergunta continuou na tela');
    verdadeiro(manteve.visivel('botao-enviar'), 'o botão de enviar não voltou');
    verdadeiro(manteve.visivel('tela-lista'), 'não voltou para a lista');
  });

  // ---- a confirmação que FALHA

  const falhou = await ateAPergunta();
  falhou.respostaEnvio = {
    ok: false, erro: 'Muita gente se inscrevendo agora. Tente de novo em instantes.'
  };
  clicarEmTrocar(falhou);
  await falhou.assentar();

  teste('confirmação que falha mantém a pergunta, com os botões de volta', () => {
    // A MUTAÇÃO QUE DERRUBA: `restaurarBotao` mostrando o botão original —
    // ficariam dois caminhos na tela, um que confirma a troca e outro que
    // refaz a pergunta, e quem clicasse no de cima voltaria ao começo.
    verdadeiro(falhou.visivel('bloco-troca'), 'a pergunta sumiu com a falha');
    igual(falhou.visivel('botao-enviar'), false, 'o botão original voltou');
    igual(falhou.el('botao-trocar-projeto').disabled, false, 'o [Trocar] ficou desligado');
    igual(falhou.el('botao-manter-inscricao').disabled, false, 'o [Manter] ficou desligado');
    verdadeiro(falhou.visivel('erro-geral'), 'a falha não foi dita');
    verdadeiro(contem(falhou.texto('erro-geral'), 'Muita gente'), falhou.texto('erro-geral'));
  });

  falhou.respostaEnvio = TROCA_FEITA;
  clicarEmTrocar(falhou);
  await falhou.assentar();

  teste('e clicar em [Trocar] de novo repete a RODADA 2, não a 1', () => {
    igual(falhou.pedidosPost().length, 3);
    igual(corpoDoPost(falhou, 2).trocar_de, ['p1']);
    verdadeiro(falhou.visivel('painel-sucesso'), 'a terceira tentativa não concluiu');
  });

  // ---- a re-pergunta: outra aba mexeu no meio

  const repergunta = await ateAPergunta();
  repergunta.respostaEnvio = {
    ok: false, troca_pendente: true,
    erro: 'Você já está inscrito em Horta Comunitária.',
    de: [{ projeto_id: 'p9', projeto_nome: 'Horta Comunitária', codigo: 'HORTA', em_espera: false }]
  };
  clicarEmTrocar(repergunta);
  await repergunta.assentar();

  teste('o conjunto mudou: a pergunta é redesenhada com o que o servidor viu agora', () => {
    // O servidor reconfere dentro do lock e re-pergunta em vez de cancelar o que
    // achar (D9). A tela tem de mostrar o conjunto NOVO. *Mutação:* acrescentar
    // em vez de redesenhar → o projeto antigo continuaria escrito na pergunta.
    const t = repergunta.texto('bloco-troca-titulo') + ' ' +
      repergunta.texto('bloco-troca-texto') + ' ' +
      repergunta.texto('botao-trocar-projeto');
    verdadeiro(contem(t, 'Horta Comunitária'), t);
    igual(contem(t, 'Arte Digital Floripa'), false, 'a pergunta velha ficou na tela');
    verdadeiro(repergunta.visivel('bloco-troca'));
  });

  repergunta.respostaEnvio = TROCA_FEITA;
  clicarEmTrocar(repergunta);
  await repergunta.assentar();

  teste('e o envio seguinte leva os ids NOVOS, não os que o aluno viu primeiro', () => {
    igual(corpoDoPost(repergunta, 2).trocar_de, ['p9']);
  });

  // ---- navegar embora

  const navegou = await ateAPergunta();
  navegou.voltarParaLista();
  await navegou.assentar();
  navegou.entrarNoProjeto(0);
  await navegou.assentar();
  // A foto do estado ANTES de o formulário ser aberto de novo: é o que separa o
  // zerar de `mostrarProjeto` do zerar de `abrirFormulario`. Os dois existem, e
  // sem esta leitura um deles poderia sumir sem nada ficar vermelho.
  const aoEntrarNoOutro = {
    bloco: navegou.visivel('bloco-troca'),
    botao: navegou.visivel('botao-enviar')
  };
  navegou.respostaEnvio = {
    ok: true, duplicada: false, mensagem: 'Inscrição registrada.', protocolo: 'PROTO-TERCEIRO'
  };
  await inscrever(navegou);

  teste('entrar noutro projeto zera a troca pendente', () => {
    // A MUTAÇÃO QUE DERRUBA: não zerar — a confirmação dada para R+ Cidades
    // cancelaria a inscrição anterior num envio feito para outro projeto.
    igual(aoEntrarNoOutro.bloco, false, 'a pergunta veio junto para o outro projeto');
    verdadeiro(aoEntrarNoOutro.botao, 'o botão de enviar continuou escondido no outro projeto');
    igual(navegou.pedidosPost().length, 2, 'o envio no outro projeto não saiu');
    igual(corpoDoPost(navegou, 1).trocar_de, undefined);
    igual(navegou.visivel('bloco-troca'), false);
    verdadeiro(navegou.visivel('painel-sucesso'), 'a inscrição no outro projeto não concluiu');
  });

  const reabriu = await ateAPergunta();
  reabriu.clicarNoCartaoDeVagas('Quero me inscrever');

  teste('reabrir o formulário no mesmo projeto também desmonta a pergunta', () => {
    // O caminho é real: a pergunta está na tela, o aluno rola para cima e clica
    // de novo em "Quero me inscrever". Formulário que ABRE é formulário em
    // branco para o servidor — a resposta de uma pergunta feita sobre o que
    // estava preenchido antes não vale para o que ele digitar agora.
    // *Mutação:* tirar o `zerarTroca` de `abrirFormulario` → cai.
    igual(reabriu.visivel('bloco-troca'), false, 'a pergunta sobreviveu à reabertura');
    verdadeiro(reabriu.visivel('botao-enviar'), 'o botão de enviar não voltou');
  });

  // ---- a ressalva na lembrança local

  const lembranca = await siteCarregado({ armazenamento: LEMBRANCA_DE_ARTE });
  lembranca.entrarNoProjeto(0);
  await lembranca.assentar();

  teste('a lembrança local avisa que pode estar desatualizada', () => {
    // Quem trocou de projeto pelo celular continua vendo "você já está inscrito"
    // no computador do laboratório: o cancelamento foi no servidor, e ninguém
    // avisa este `localStorage`. *Mutação:* tirar a frase → a certeza falsa
    // volta, sem nada na tela que a contradiga.
    const t = lembranca.texto('cartao-vagas');
    verdadeiro(contem(t, 'Você já está inscrito'), t);
    verdadeiro(contem(t, 'trocou de projeto em outro aparelho'), t);
  });

  // ==================================================== estilos e acessibilidade

  grupo('o que o CSS precisa ter para nada disso ficar sem estilo');

  teste('as classes novas existem no estilos.css', () => {
    ['.ja-inscrito', '.ligacao-discreta', '.sucesso-projeto', '.vagas-nota',
      '.faixa-janela', '.faixa-janela__contador', '.vagas-nota--abaixo',
      // A pergunta da troca e o botão que cancela a inscrição anterior. Sem
      // estilo, o bloco de atenção viraria texto solto e o botão destrutivo
      // ficaria igual ao de não fazer nada.
      '.bloco-troca', '.btn--perigo'].forEach((classe) => {
      verdadeiro(contem(CSS, classe), classe + ' não tem estilo');
    });
  });

  teste('o selo "conferindo" pulsa, e o pulso morre com prefers-reduced-motion', () => {
    verdadeiro(/\.selo-matricula--carregando[^}]*animation/.test(CSS), 'o selo não pulsa');
    verdadeiro(/prefers-reduced-motion[\s\S]*animation: none !important/.test(CSS),
      'a regra que desliga animação sumiu');
  });

  process.exit(resultado());
}

rodar().catch((e) => {
  console.error('\n\x1b[31mo arquivo de testes estourou fora de um teste:\x1b[0m\n' + e.stack);
  process.exit(1);
});
