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
 * Uso:  node testes/site.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { teste, grupo, igual, verdadeiro, resultado } = require('./apoio');
const { siteCarregado, acharClicavel, PROJETOS_PADRAO } = require('./dom-falso');

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

  // ==================================================== estilos e acessibilidade

  grupo('o que o CSS precisa ter para nada disso ficar sem estilo');

  teste('as classes novas existem no estilos.css', () => {
    ['.ja-inscrito', '.ligacao-discreta', '.sucesso-projeto', '.vagas-nota'].forEach((classe) => {
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
