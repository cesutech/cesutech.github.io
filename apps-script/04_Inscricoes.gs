/**
 * 04_Inscricoes.gs — a entrada de inscrições, sobre o Firestore.
 *
 * Duas portas chegam aqui, e as duas desembocam em `gravarInscricao`:
 *   1. `submeterInscricao` COM `projeto_id` — o site hospedado no GitHub Pages,
 *      que entra por doPost e passa por `reservarVaga` (09_Projetos.gs) para
 *      disputar vaga;
 *   2. `submeterInscricao` SEM `projeto_id` — o formulário interno
 *      (Cadastro.html, por google.script.run), que não conhece projeto e não
 *      disputa vaga nenhuma.
 *
 * ------------------------------------------------- A dedup mudou de dono
 *
 * No sistema sobre Sheets (o sistema anterior, 04_Inscricoes.gs)
 * `gravarInscricao` lia a coluna `hash_dedup` inteira e a percorria em JavaScript
 * antes de gravar. O custo O(n) é o menor dos problemas. O problema é ONDE ela
 * roda: são QUATRO chamadores lá, e TRÊS ficam fora do LockService.
 *
 *   04_Inscricoes.gs:23   aoReceberRespostaForms      gatilho do Forms    FORA
 *   04_Inscricoes.gs:248  submeterInscricao, sem projeto                  FORA
 *   04_Inscricoes.gs:262  submeterInscricao, dentro de reservarVaga      DENTRO
 *   04_Inscricoes.gs:410  sincronizarRespostasForms   sincronização       FORA
 *
 * Ler-e-depois-escrever sem serialização é corrida por construção: duas execuções
 * leem a mesma coluna, nenhuma acha o hash, as duas gravam. A varredura só valia
 * como garantia no terceiro caso; nos outros três era conferência otimista, e
 * bastava um aluno reenviar o Forms enquanto a sincronização rodava para a mesma
 * pessoa entrar duas vezes.
 *
 * Aqui a chave de dedup É o id do documento, e quem recusa a segunda gravação é o
 * banco: `createDocument` com `documentId` responde 409 ALREADY_EXISTS numa
 * operação atômica, sem leitura prévia e sem lock (ver `inserir` em 02_Repo.gs —
 * medido contra o Firestore de verdade em 05/08/2026). Os quatro caminhos ficam
 * fechados de uma vez, inclusive os que ninguém serializa. E o terceiro, o único
 * que roda dentro do lock, encolhe de "varrer a coleção" para UMA escrita — que é
 * exatamente o que o cabeçalho de 09_Projetos.gs exige de quem passa `gravar`.
 *
 * Só as duas portas do topo foram portadas. As duas do Google Forms dependem de
 * `FormApp` e da aba de respostas vinculada a uma planilha, e no sistema novo não
 * existe planilha nenhuma por baixo — não é escopo desta fase, e trazê-las seria
 * inventar um caminho de dados que ninguém pediu.
 *
 * ---------------------------------------------------------- Desenho de dados
 *
 * Coleção `inscricoes`, id do documento = `chaveDedup_(dados)`. Não existe campo
 * `id` nem campo `hash_dedup` gravado: os dois seriam cópias do nome do
 * documento, livres para divergir dele. É a mesma decisão que 09_Projetos.gs
 * tomou para `projetos`, e aqui ela vem de brinde — o id JÁ é a chave de dedup.
 *
 * Dois campos só existem no documento de quem está na FILA DE ESPERA, e não
 * existem em mais ninguém: `em_espera` ('SIM') e `espera_de` (o id do projeto).
 * A ausência é o desenho — com `vagas_excedentes_em_espera` em NAO, que é o
 * padrão, o documento gravado é exatamente o de antes de a fila existir, campo
 * por campo. Quem conta os dois é `contarEmEspera_` (09_Projetos.gs); por que
 * são dois, está em `gravarInscricao`.
 *
 * O que isso custa: a chave é `hash()` (01_Utils.gs), MD5 cortado em 16 dígitos
 * hexadecimais, ou seja 64 bits. Colisão entre duas pessoas diferentes deixaria
 * de ser "linha repetida no cadastro" e passaria a ser INSCRIÇÃO PERDIDA, com o
 * aluno lendo "você já está inscrito". Com dez mil inscrições a chance é da ordem
 * de 3 em 10^12 (aniversário sobre 2^64), contra um cadastro que terá centenas.
 * O preço está aceito com o número escrito, não no escuro.
 *
 * -------------------------------------------------- Contrato com a importação
 *
 * `matriculaConhecida` deixou de ler a lista oficial inteira e virou UMA leitura
 * por id. Isso só funciona se a fase de importação gravar a coleção
 * `matriculados` com o id do documento = MATRÍCULA NORMALIZADA
 * (`normalizarMatricula`, que devolve só [A-Z0-9]).
 *
 * Consequência que a importação precisa saber: nenhum id que contenha caractere
 * fora de [A-Z0-9] é alcançável por esta função, porque a matrícula consultada
 * sempre passa por `normalizarMatricula`. Linha de lista oficial SEM matrícula —
 * que o sistema sobre Sheets aceita, desde que tenha nome — pode portanto ser
 * gravada com id sorteado sem risco de colidir com matrícula de ninguém. Ela
 * simplesmente nunca será encontrada por matrícula, que é o comportamento certo.
 *
 * `temListaOficial_` conta a coleção inteira, e é aí que a suposição aparece:
 * "existe documento em `matriculados`" passa a valer como "existe lista oficial
 * importada". No sistema sobre Sheets a pergunta era mais estreita — "existe
 * pelo menos uma matrícula não vazia" —, e a diferença aparece num caso só: uma
 * importação que não mapeou coluna de matrícula nenhuma. Lá isso deixava a
 * validação desligada; aqui ligaria a validação sobre uma lista sem matrícula, e
 * todo aluno levaria "matrícula não encontrada". Cabe à importação recusar esse
 * arquivo — é o mesmo arquivo que ela não conseguiria endereçar por id.
 *
 * ------------------------- Um projeto ATIVO por matrícula, com troca (item 4)
 *
 * Com `aluno_projeto_unico` em SIM, quem já está inscrito em OUTRO projeto ativo
 * deixa de levar uma recusa seca e passa a receber uma PERGUNTA; confirmando, a
 * inscrição anterior vai para a quarentena e a nova nasce no mesmo `:commit`.
 * Com a chave em NAO — o padrão — nada disto existe: o caminho é o de sempre,
 * requisição por requisição, com o aviso no fim.
 *
 * São DUAS FASES do MESMO POST `acao=inscricao`, e não uma rota nova:
 *
 *   1ª (sem `trocar_de`) ... a pergunta, decidida FORA do lock: uma consulta por
 *        matrícula, os projetos das achadas, e a resposta `troca_pendente` com o
 *        que seria cancelado. NENHUMA escrita, NENHUM lock — perguntar não
 *        disputa vaga com ninguém;
 *   2ª (com `trocar_de`) ... a confirmação, decidida DENTRO do lock: a consulta
 *        roda de novo, agora autoritativa, e só então se escreve.
 *
 * POR QUE A CONSULTA CORRE DE NOVO LÁ DENTRO. Fora do lock ela é cortesia: duas
 * abas do mesmo aluno com a PRIMEIRA inscrição de cada leem vazio ao mesmo tempo
 * e gravam as duas. Quem decide o conjunto que será cancelado é a leitura feita
 * depois de esperar na fila — a mesma razão pela qual `reservarVaga` conta as
 * vagas lá dentro, e não antes do `waitLock`.
 *
 * O QUE O LOCK PROTEGE E O QUE O `:commit` PROTEGE. O lock serializa a DECISÃO
 * (contar o projeto novo + ler o conjunto ativo da matrícula) contra outras
 * execuções; o `:commit` garante que o EFEITO entra inteiro ou não entra, contra
 * qualquer falha. Ele não é substituível pelo lock: o lock não impede a execução
 * de morrer entre duas escritas, e cada meio-estado é um desastre diferente — o
 * aluno sem projeto nenhum, o aluno em dois, a vaga do antigo presa.
 *
 * O E-MAIL É A PROVA DE POSSE (D4). A matrícula não é segredo: ela é quase
 * sequencial e circula em lista de chamada. Como o lado da troca é DESTRUTIVO,
 * cancelar a inscrição de alguém exige que o e-mail do envio seja o mesmo da
 * inscrição que sairia; divergindo, a recusa não nomeia projeto nenhum — dizer
 * "você está em X" a quem só acertou a matrícula seria entregar o oráculo que
 * `matriculaConhecida` se recusa a ser. E inscrição feita PELA COORDENAÇÃO não é
 * trocável pelo aluno (J4-2): o e-mail dela veio da lista oficial, e o
 * institucional é derivável da matrícula — ele não prova posse de nada.
 *
 * MATRÍCULA VAZIA DESLIGA A REGRA (§4). A identidade aqui é só a matrícula
 * normalizada: nunca o CPF, nunca o e-mail. E-mail é identidade fraca (a conta
 * da família, o autopreenchimento do laboratório) e o lado destrutivo não pode
 * assentar nela; `matricula == ''` ainda devolveria todas as
 * inscrições sem matrícula na mesma consulta. Sem matrícula, portanto, grava
 * como sempre gravou — e `trocar_de` é apagado do payload no servidor.
 *
 * CUSTO, por caminho, com a chave em SIM: inscrição comum = 7 leituras e 3 idas
 * no lock (4 com a fila ligada); a pergunta da rodada 1 = ~7-8 leituras, zero
 * escritas e ZERO lock; a confirmação da rodada 2 = ~8-9 leituras e UMA escrita
 * (o `:commit` de 3). Com a chave em NAO a conta não muda em nada — nem o número
 * de requisições, nem o documento gravado.
 */

/**
 * Coleção das inscrições.
 *
 * O nome canônico é daqui, e 09_Projetos.gs repete a declaração de propósito
 * (ver o comentário lá) para o controle de vaga não depender da ordem de
 * carregamento dos arquivos. Repetido é aceitável; DIVERGENTE é que não pode ser
 * — o Apps Script não reclama, a última declaração carregada vence em silêncio, e
 * a contagem de vagas passaria a olhar uma coleção vazia. Existe teste que lê os
 * dois arquivos e falha se os valores deixarem de ser iguais.
 */
var INSCRICOES_COLECAO = 'inscricoes';

/** Lista oficial de matriculados. Id do documento = matrícula normalizada. */
var MATRICULADOS_COLECAO = 'matriculados';

/**
 * Quem a revisão de uma importação EXCLUIU da lista oficial (21/09).
 *
 * Cópia do documento inteiro de `matriculados`, com o MESMO id, mais
 * `excluido_em`, `excluido_por` e `excluido_lote_id` — sempre copia-depois-
 * apaga, para a pessoa nunca deixar de existir em algum lugar. Só o Excluir
 * pessoa a pessoa da revisão (05c_Revisao.gs) escreve aqui, e NINGUÉM lê:
 * excluído é "não está na lista" para todo consumidor — `matriculaConhecida`,
 * a reconciliação, a aba Alunos, a Disciplinas. Restaurar é operação de console
 * (copiar de volta com `inserir`). "Apagar matriculados" (o expurgo de um lote
 * inteiro) NÃO passa por aqui: 2.500 por semestre estourariam o teto do backup
 * em três ou quatro semestres, e a vassoura de fim de semestre já tem o backup
 * diário como rede.
 *
 * SEM EXPIRAÇÃO, por decisão de 21/09: guarda nome, CPF, telefone e a linha
 * original de quem saiu, cresce às dezenas por semestre, e entra no backup
 * diário sozinha — o sufixo `_COLECAO` é o que `backupColecoes_` (14_Backup.gs)
 * procura. Uma limpeza por `excluido_em` fica anotada como possível, não feita.
 *
 * Declarada aqui, ao lado da coleção de que ela é a sombra, e não no arquivo da
 * revisão: a constante precisa existir para o backup ANTES de a revisão nascer,
 * e o nome canônico de `matriculados` também é daqui.
 */
var MATRICULADOS_EXCLUIDOS_COLECAO = 'matriculados_excluidos';

// ------------------------------------------------------------ Matrícula

/** Matrícula normalizada: só alfanumérico, caixa alta. */
function normalizarMatricula(v) {
  if (!v) return '';
  var limpa = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

  // ZERO À ESQUERDA É FORMATAÇÃO, NÃO IDENTIDADE.
  //
  // A lista oficial traz `09110700`; o aluno digita `9110700`, porque é assim
  // que o número aparece para ele — e recebia "Matrícula não encontrada". No
  // auditório isso seria uma fila de alunos convencidos de que o sistema está
  // errado, e eles estariam certos.
  //
  // Só vale para matrícula inteiramente numérica: `A0123` é outra coisa, e o
  // zero ali pode ser significativo. E sobra pelo menos um dígito, senão '000'
  // viraria string vazia, que é o valor de "não informou".
  //
  // Como `chaveDedup_` também passa por aqui, as duas formas geram a MESMA
  // chave — quem se inscreveu com zero não consegue se inscrever de novo sem
  // ele, que é o comportamento certo.
  if (/^\d+$/.test(limpa)) return limpa.replace(/^0+(?=\d)/, '');

  return limpa;
}

/**
 * Quantos dígitos a matrícula tem. Vem da configuração, e a régua NUNCA se
 * desliga.
 *
 * Por que configuração e não constante: o 7 foi medido nas listas da secretaria
 * (19/09), e não vem de documento nenhum da instituição — "se não me engano são
 * 7". No dia em que a secretaria mudar o formato, ou em que a contagem se provar
 * errada na frente de 300 alunos, a correção tem de ser uma célula em
 * Configurações e não uma implantação.
 *
 * Por que a chave inválida cai no padrão em vez de liberar tudo: a faixa de 4 a
 * 20 que existia antes é exatamente o que deixava matrícula errada passar, e o
 * pedido do Prof. Mário foi fechá-la. Uma chave apagada ou digitada errado
 * ("sete", "0") reabriria a faixa em silêncio, e ninguém perceberia até o
 * cruzamento com a lista falhar — ou seja, no fim do semestre. `backupDias_`
 * (14_Backup.gs) toma a decisão oposta com o mesmo raciocínio: lá o lado seguro
 * é NÃO agir; aqui o lado seguro é CONTINUAR validando. O erro vai para o
 * console, que é o Stackdriver do projeto, e a coordenação enxerga o valor
 * torto na própria tela de Configurações.
 *
 * O padrão de fábrica sai de CONFIG_PADRAO, e não de um segundo literal aqui:
 * o `config(chave, '7')` já é conferido contra CONFIG_PADRAO por teste, e um
 * terceiro 7 escrito à mão seria o que envelhece sozinho.
 */
function matriculaDigitos_() {
  var bruto = String(config('matricula_digitos', '7')).trim();
  if (/^[1-9]\d*$/.test(bruto)) return Number(bruto);

  var semente = '';
  CONFIG_PADRAO.forEach(function (c) {
    if (c.chave === 'matricula_digitos') semente = c.valor;
  });
  console.error('matricula_digitos: "' + bruto.slice(0, 40) + '" não é uma quantidade de ' +
    'dígitos; a matrícula continua sendo validada com ' + semente + '.');
  return Number(semente);
}

/**
 * Confere o FORMATO da matrícula digitada. Devolve '' quando ela serve, ou a
 * mensagem de recusa — que diz ao aluno o tamanho certo, porque "inválida" não
 * ensina a corrigir.
 *
 * É a régua das DUAS portas, e o contrato é que nenhuma tenha conta própria: o
 * envio (`validarInscricao`) chama daqui, e a conferência ao vivo
 * (`conferirMatricula_`, 08_Api.gs) tem de chamar daqui também. Se as duas
 * divergissem, o site diria "ok" ao sair do campo e o servidor recusaria no
 * envio — o aluno leria duas mensagens sobre o mesmo número e não saberia em
 * qual acreditar.
 *
 * São DUAS medidas, e as duas precisam bater. A chave (`normalizarMatricula`,
 * que tira o zero à esquerda) tem de ter N dígitos: é o que a lista oficial
 * guarda, e é o que o cruzamento compara. E o que o aluno DIGITOU, sem pontuação,
 * tem de ter N ou N+1: as duas formas em que a matrícula circula — a do portal
 * e a da secretaria, com o zero (ver o comentário em `normalizarMatricula`).
 *
 * Por que a segunda medida existe, se a primeira já pede N: sem ela
 * `000009110001` passaria — a chave é `9110001`, certa, mas o aluno digitou doze
 * caracteres e o formulário aceitaria qualquer quantidade de zeros. Por que a
 * primeira existe, se a segunda já pede N ou N+1: sem ela `0110001` passaria —
 * sete na tela, e a chave `110001`, de seis dígitos, que não existe na lista de
 * ninguém. Juntas, N+1 só passa quando o caractere a mais é UM zero à esquerda,
 * sem precisar dizer isso numa terceira condição.
 */
function erroFormatoMatricula_(bruta) {
  var digitos = matriculaDigitos_();
  var digitada = String(bruta || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  var soDigitos = /^\d+$/.test(digitada);
  var tamanhoCerto = digitada.length === digitos || digitada.length === digitos + 1;

  if (soDigitos && tamanhoCerto && normalizarMatricula(digitada).length === digitos) return '';

  return 'A matrícula tem ' + digitos + ' dígitos. Confira o número no seu portal do aluno.';
}

/**
 * Confere se a matrícula consta da lista oficial importada.
 *
 * DELIBERADAMENTE não devolve dado nenhum do aluno — só sim ou não.
 *
 * Um endereço que devolvesse o nome a partir da matrícula viraria um oráculo:
 * as matrículas da instituição são quase sequenciais, então varrer a faixa
 * entregaria a lista inteira de alunos. A controladora desses dados é a
 * faculdade, e a exposição seria dela. Sim/não já resolve o que se quer aqui,
 * que é impedir erro de digitação.
 *
 * Resta um bit de informação ("a matrícula X existe"), e por isso o endpoint que
 * expõe esta função tem teto de consultas por hora. Matrícula CANCELADA pela
 * revisão de uma importação responde o MESMO que inexistente — a mesma frase no
 * formulário, o mesmo corpo em `?api=matricula` (08_Api.gs). A porta da
 * coordenação (`buscarMatriculado`, `incluirInscricao`, 10_Painel.gs) é que
 * avisa, porque lá quem pergunta é gente autenticada com a lista na frente.
 *
 * O que mudou do sistema sobre
 * Sheets não é a exposição, é o NOSSO custo: era a coluna inteira da lista
 * oficial a cada conferência, e a conferência roda a cada tecla que o aluno
 * corrige. Agora é uma leitura por id — 1 documento, contra as 50 mil por dia do
 * plano Spark.
 */
function matriculaConhecida(matricula) {
  // Cancelado na lista oficial = não encontrado, para esta porta. Distinguir os
  // dois seria um segundo bit sobre uma pessoa no oráculo — "existe e está
  // cancelada" é mais do que "existe", e a régua daqui é entregar o mínimo.
  var m = fichaOficialDe_(matricula);
  return m !== null && !cadastroCancelado_(m);
}

/**
 * A ficha da lista oficial, ou null. UMA leitura de ponto — a mesma de sempre.
 *
 * Existe porque o envio faz DUAS perguntas sobre a mesma matrícula, e elas têm
 * de caber na mesma leitura: "está na lista?" (o que `matriculaConhecida`
 * responde, e o que decide `matricula_conferida`) e "foi CANCELADA pela revisão
 * de uma importação?" (`cadastroCancelado_`).
 *
 * Para a porta pública as duas são a mesma resposta de propósito — cancelado
 * responde o MESMO que inexistente, ver `matriculaConhecida`. A TROCA é que
 * precisa separá-las (N4): a inscrição nova continua possível para quem a
 * coordenação acabou de cancelar (ela não destrói nada, e já é possível hoje),
 * mas cancelar sozinho a inscrição que a coordenação incluiu à mão, não. Sem
 * esta função seriam duas leituras da mesma matrícula no mesmo envio, que é
 * exatamente o que `checarMatriculaNaLista_` documenta ter matado.
 *
 * Note o gatilho que NÃO se usa lá: `conhecida === false` pegaria também o
 * projeto aberto à comunidade (`validar_matricula = NAO`), onde §4 decidiu que a
 * regra vale pela matrícula digitada. O gatilho é a marca, e só ela.
 */
function fichaOficialDe_(matricula) {
  var alvo = normalizarMatricula(matricula);
  if (!alvo) return null;
  return ler(MATRICULADOS_COLECAO, alvo);
}

/**
 * Se este documento de `matriculados` carrega a marca de cancelamento.
 *
 * A marca são quatro campos gravados pela revisão de uma importação
 * (05c_Revisao.gs): `situacao_cadastro = 'CANCELADO'`, `cancelado_em`,
 * `cancelado_por` e `cancelado_lote_id`. Ela some pela REIMPORTAÇÃO — a lista
 * nova reescreve o documento inteiro (`escreverEmLote` substitui, 02_Repo.gs) e
 * `montarRegistro_` (05_Importacao.gs) não conhece o campo —, e é por isso que
 * não existe "reativar": quem a secretaria mandou de novo está de volta.
 *
 * ÚNICO lugar que lê o campo, e por isso ele tolera ausência: documento anterior
 * à marca não tem a chave, e `''` é ativo. `situacao` (a coluna da secretaria:
 * MATRICULADO, TRANCADO...) é OUTRO campo e não é olhado aqui — a secretaria diz
 * o que ela diz, e a marca diz o que a coordenação decidiu sobre uma lista.
 */
function cadastroCancelado_(m) {
  return String((m || {}).situacao_cadastro || '').toUpperCase() === 'CANCELADO';
}

/**
 * SIM quando existe pelo menos uma lista oficial importada.
 *
 * Agregação, e não `listar`: a resposta é um número e não precisa trazer
 * documento nenhum. A suposição que isto carrega está no cabeçalho.
 */
function temListaOficial_() {
  return contar(MATRICULADOS_COLECAO) > 0;
}

/**
 * Decide o que fazer com uma matrícula não encontrada.
 * Devolve '' quando está tudo bem, ou a mensagem de recusa.
 *
 * Guarda importante: sem lista oficial importada, NUNCA bloqueia. Do contrário
 * o primeiro aluno a se inscrever num semestre novo levaria "matrícula
 * incorreta" só porque a secretaria ainda não mandou o arquivo.
 *
 * `conhecida` vem de fora porque quem chama já precisa do mesmo veredito para
 * gravar `matricula_conferida`. No sistema sobre Sheets `matriculaConhecida` era
 * chamada DUAS vezes por inscrição — uma aqui dentro e outra logo depois, no
 * chamador — e a lista oficial era lida inteira nas duas. Aqui a resposta é
 * calculada uma vez e passa por parâmetro. Quem não tiver o veredito na mão pode
 * omitir o argumento; a conta é feita, mas só depois de o projeto dizer que
 * valida matrícula.
 *
 * A ordem das três perguntas também mudou, e não é estética: matrícula
 * ENCONTRADA libera sem precisar saber se existe lista (ela existe — a matrícula
 * está nela). Isso tira a agregação do caminho do aluno certo, que é o caso
 * comum, e a deixa só no caminho de quem digitou errado.
 */
function checarMatriculaNaLista_(matricula, projetoId, conhecida) {
  if (!projetoValidaMatricula_(projetoId)) return '';

  if (conhecida === undefined) conhecida = matriculaConhecida(matricula);
  if (conhecida) return '';

  if (!temListaOficial_()) return '';

  var modo = String(config('modo_validacao_matricula', 'BLOQUEAR')).toUpperCase();
  if (modo === 'BLOQUEAR') {
    return 'Matrícula não encontrada na lista de alunos matriculados. ' +
           'Confira o número digitado. Se estiver certo, procure a coordenação do CESUTECH.';
  }
  return '';   // modo AVISAR: passa, e a inscrição fica marcada como não conferida
}

/**
 * Se ESTE projeto exige matrícula da lista oficial.
 *
 * É decisão de projeto, não do sistema: extensão curricularizada só aceita
 * aluno matriculado, mas um projeto aberto à comunidade não teria como validar.
 *
 * Sem projeto (formulário interno), assume que valida — é o caso comum.
 *
 * Custo conhecido e aceito: esta é a primeira das DUAS leituras do documento do
 * projeto que uma inscrição faz, porque `reservarVaga` lê de novo, por dentro. As
 * duas somam 2 das ~4 leituras por inscrição, contra 50 mil por dia — e fechar a
 * repetição exigiria ou passar o projeto para dentro de 09_Projetos.gs, que não é
 * arquivo desta fase, ou um cache de execução que só existiria para isto.
 */
function projetoValidaMatricula_(projetoId) {
  if (!projetoId) return true;
  var p = projetoPorId(projetoId);
  if (!p) return true;
  // Projeto criado antes deste campo existir tem o campo vazio: vale como SIM.
  return String(p.validar_matricula).toUpperCase() !== 'NAO';
}

// ------------------------------------------------------------ Gravação

/**
 * Chave de deduplicação, que aqui é também o id do documento.
 *
 * Um aluno pode aparecer em projetos diferentes, então a chave inclui o projeto —
 * o que se quer impedir é a mesma pessoa entrar duas vezes no MESMO projeto.
 *
 * Ordem de preferência: matrícula > CPF > e-mail + nome.
 *
 * O `hash` continua no meio do caminho, e agora carrega um segundo papel: ele é
 * o que impede a matrícula do aluno de virar endereço de documento. Id de
 * documento aparece em URL de API, em log de erro e na tela de quem inspeciona o
 * banco; matrícula ali seria dado pessoal exposto por descuido de desenho, e
 * ainda deixaria a coleção enumerável por faixa de matrícula. O hash resolve os
 * dois de graça, e de quebra tem largura fixa e alfabeto seguro para a URL.
 */
function chaveDedup_(dados) {
  var matricula = normalizarMatricula(dados.matricula);
  var cpf = normalizarCpf(dados.cpf);
  var pessoa = matricula || cpf ||
    (normalizarEmail(dados.email) + '|' + chaveNome(dados.nome));

  return hash(String(dados.projeto_id || 'sem-projeto') + '::' + pessoa);
}

/**
 * Normaliza e grava uma inscrição, ignorando duplicatas.
 *
 * UMA requisição, sempre — inclusive quando a inscrição é duplicada, porque quem
 * descobre a duplicata é o 409 do banco e não uma leitura nossa. É essa promessa
 * que 09_Projetos.gs compra ao chamar isto de dentro do lock, e ela tem teste que
 * conta as requisições.
 *
 * A NORMALIZAÇÃO mora em `montarRegistroDaInscricao_`, logo abaixo, e esta
 * função é o par "monta e insere". Quem monta sem inserir é a troca de projeto:
 * lá o documento novo entra pelo `:commit` que apaga a inscrição antiga no mesmo
 * movimento.
 *
 * ---------------------------------------- O segundo argumento, e por que é um
 *
 * `pelaCoordenacao` é `{ incluido_por }` quando quem grava é `incluirInscricao`
 * (10_Painel.gs), e ausente em todos os outros chamadores. Ele muda DUAS coisas
 * no documento: entra `incluido_por`, e os três aceites vão VAZIOS — a
 * coordenação não consente pelo aluno, e 'NAO' ali afirmaria que o aluno
 * RECUSOU uma pergunta que ninguém lhe fez.
 *
 * É um ARGUMENTO, e não um campo de `dados`, porque `dados` é o payload que o
 * cliente manda: `submeterInscricao` recebe o corpo do POST inteiro, e o
 * `sincronizarRespostasForms` recebe o que o Forms trouxe. Qualquer marca posta
 * dentro de `dados` — um campo `incluido_por`, um aceite mandado como texto
 * vazio — viajaria no mesmo envelope que o aluno preenche, e o caminho público
 * passaria a gravar um documento que ele nunca gravou (a primeira versão desta
 * função fazia exatamente isso, reinterpretando `''` para todo chamador, e um
 * POST à mão com `autoriza_imagem: ''` deixava de gravar 'NAO'). Fora do
 * payload, o sinal só existe onde o código o escreve: com um argumento só, esta
 * função grava o documento de sempre, campo por campo — e é isso que o teste
 * do caminho público compara.
 */
function gravarInscricao(dados, pelaCoordenacao) {
  var chave = chaveDedup_(dados);
  var gravacao = inserir(INSCRICOES_COLECAO, montarRegistroDaInscricao_(dados, pelaCoordenacao), chave);
  return { id: chave, duplicada: gravacao.jaExistia };
}

/**
 * O DOCUMENTO da inscrição, montado e normalizado — sem gravar nada.
 *
 * Extraído de `gravarInscricao` para a troca de projeto (item 4): lá o
 * documento novo não vai por `inserir`, e sim dentro do `:commit` que apaga a
 * inscrição antiga no mesmo movimento (ver o gravador da troca, mais abaixo).
 * Sem a extração haveria uma SEGUNDA normalização do mesmo payload no mesmo
 * arquivo, e a divergência entre as duas seria descoberta no dia em que um
 * campo mudasse só de um lado.
 *
 * O SEGUNDO ARGUMENTO VIAJA INTEIRO, e isto é o ponto de extrair com dois e não
 * com um: `pelaCoordenacao` muda QUATRO campos do documento (`incluido_por`
 * entra, e os três aceites vão vazios). Uma extração de um argumento só
 * devolveria a porta da coordenação ao documento do caminho público — os
 * aceites voltariam a 'NAO', afirmando uma recusa que ninguém perguntou ao
 * aluno. A troca do aluno chama com UM argumento, de propósito: ela é do aluno,
 * e um `incluido_por` ali sairia mentindo sobre quem pôs a pessoa no projeto.
 *
 * O NOME não é `montarRegistro_` porque esse já existe, em 05_Importacao.gs,
 * montando a linha de `matriculados`. Os arquivos dividem um escopo global só:
 * o Apps Script não reclama da redeclaração, a última carregada vence em
 * silêncio (05 vem DEPOIS de 04 na ordem alfabética), e toda inscrição passaria
 * a ser montada pela função da importação. Existe teste que lê os `.gs` e falha
 * se duas funções nascerem com o mesmo nome.
 */
function montarRegistroDaInscricao_(dados, pelaCoordenacao) {
  var registro = {
    criado_em: agora(),
    origem: dados.origem || 'DESCONHECIDA',
    projeto_id: dados.projeto_id || '',
    projeto_nome: dados.projeto_nome || '',
    matricula: normalizarMatricula(dados.matricula),
    // Marca a procedência do dado: conferido contra a lista oficial, ou
    // digitado sem conferência. É o que separa cadastro confiável de palpite.
    matricula_conferida: dados.matricula_conferida || 'NAO',
    nome: formatarNome(dados.nome),
    email: normalizarEmail(dados.email),
    whatsapp: normalizarTelefone(dados.whatsapp || dados.telefone),
    curso_fase: String(dados.curso_fase || dados.curso || '').trim(),
    cpf: normalizarCpf(dados.cpf),
    data_nascimento: normalizarData(dados.data_nascimento),
    observacoes: String(dados.observacoes || '').trim(),
    // Booleano vira SIM/NAO, e QUALQUER outra coisa também: `''`, `null` e
    // `'não'` são NAO, como sempre foram. O terceiro estado, "não perguntado",
    // não nasce do valor — nasce do chamador, logo abaixo.
    declara_ciencia: dados.declara_ciencia ? 'SIM' : 'NAO',
    autoriza_imagem: dados.autoriza_imagem ? 'SIM' : 'NAO',
    consentimento_lgpd: dados.consentimento_lgpd || '',
    raw_json: dados.raw_json || JSON.stringify(dados)
  };

  // ------------------------------------------------------ Pela coordenação
  //
  // O que só existe no documento de quem entrou por `incluirInscricao` — é a
  // mesma decisão da fila de espera, logo abaixo: o caminho público não tem
  // como pedir isto, e continua gravando o documento de sempre.
  //
  // `incluido_por` diz POR QUEM (`origem: 'COORDENACAO'` já diz POR ONDE), que é
  // o que a trilha precisa quando a pergunta for "quem pôs esta pessoa neste
  // projeto". E os três aceites ficam em branco: a ficha omite o campo vazio, e
  // é assim que "não perguntado" se distingue de "não aceitou" — 'NAO' aqui
  // seria uma recusa que o aluno nunca deu.
  if (pelaCoordenacao) {
    registro.incluido_por = String(pelaCoordenacao.incluido_por || '');
    registro.declara_ciencia = '';
    registro.autoriza_imagem = '';
    registro.consentimento_lgpd = '';
  }

  // ------------------------------------------------------------ Fila de espera
  //
  // As duas marcas existem SÓ no documento de quem está na fila. Quem entrou pela
  // vaga tem o documento de sempre, campo por campo — é isso que faz a fila
  // desligada ser indistinguível do sistema de antes dela, no banco e não só no
  // comportamento.
  //
  // São dois campos para a mesma verdade, e a duplicação é deliberada:
  //   `em_espera` é o que uma pessoa lê ao abrir o documento, e o que o painel
  //               mostra;
  //   `espera_de` é o que a AGREGAÇÃO conta (`contarEmEspera_`, 09_Projetos.gs).
  //               Guarda o id do projeto porque contar "quantos esperam NESTE
  //               projeto" precisa caber num filtro de igualdade só: `projeto_id`
  //               mais `em_espera` seriam DOIS filtros, e dois filtros pedem
  //               índice composto — o passo de console que este sistema se
  //               proibiu de depender.
  //
  // Os dois são escritos aqui, juntos, na mesma escrita, a partir do mesmo
  // booleano. Divergir exigiria alguém gravar um sem o outro, e o único lugar que
  // os grava é este.
  if (String(dados.em_espera).toUpperCase() === 'SIM') {
    registro.em_espera = 'SIM';
    registro.espera_de = String(dados.projeto_id || '');
  }

  return registro;
}

/**
 * Em quais outros projetos esta pessoa já está inscrita.
 *
 * UMA consulta, e não duas: a regra herdada casa por matrícula QUANDO ela existe,
 * e só cai para o e-mail quando não existe — nunca as duas ao mesmo tempo. Sobre
 * Sheets isso ficava escondido dentro de um `||` que percorria quatro colunas
 * lidas inteiras; aqui vira a escolha do campo do filtro.
 *
 * Que fique dito, porque é a tentação óbvia: `listar` aceita UM `fieldFilter` só.
 * Procurar por matrícula OU e-mail no mesmo passo não é um predicado mais
 * complicado, são duas consultas — e duas consultas mudariam a regra de negócio,
 * não só o custo. Não é o que a produção validou.
 *
 * Filtro de igualdade em um campo, sem ordenação declarada: `listar` ordena por
 * `__name__` ASCENDENTE, que é o desempate embutido em todo índice automático de
 * campo único. Não exige índice composto — e não é a armadilha do `__name__`
 * DESCENDENTE, que exigiria (ver `ultimosRegistros` em 04_Log.gs).
 */
var INSCRICOES_OUTROS_PROJETOS_MAX = 20;

function outrosProjetosDe_(dados) {
  return inscricoesEmOutrosProjetos_(dados).map(function (i) {
    return i.projeto_nome || i.projeto_id;
  });
}

/**
 * A MESMA consulta de `outrosProjetosDe_`, devolvendo a inscrição em vez do
 * nome: `{ id, projeto_id, projeto_nome, em_espera }` por projeto.
 *
 * Existe para `buscarMatriculado` (10_Painel.gs), que precisa de mais do que o
 * nome: a janela "Incluir aluno" marca "(este projeto)" pelo ID — o nome é
 * desnormalizado na escrita, e um projeto renomeado depois da inscrição, ou
 * dois homônimos, deixariam a marca errada — e diz "(em espera)" quando a
 * pessoa está na FILA deste projeto, porque aí o Incluir promove a inscrição
 * que existe em vez de criar outra (`incluirInscricao`). `outrosProjetosDe_` continua
 * devolvendo nomes, que é o que `submeterInscricao` lê desde o primeiro
 * semestre; separar a leitura da consulta é o que deixa os chamadores
 * compartilharem o filtro sem um mudar o contrato do outro — o filtro mora em
 * `inscricoesDaPessoa_`, logo abaixo, e hoje são TRÊS os que o compartilham.
 */
function inscricoesEmOutrosProjetos_(dados) {
  return inscricoesDaPessoa_(normalizarMatricula(dados.matricula), normalizarEmail(dados.email))
    .filter(function (inscricao) {
      return String(inscricao.projeto_id) !== String(dados.projeto_id || '');
    })
    .map(function (inscricao) {
      return {
        id: String(inscricao._id || ''),
        projeto_id: String(inscricao.projeto_id),
        projeto_nome: String(inscricao.projeto_nome || ''),
        em_espera: String(inscricao.em_espera).toUpperCase() === 'SIM'
      };
    });
}

/**
 * O FILTRO, sozinho: as inscrições COM projeto desta pessoa, como `listar` as
 * trouxe — documento inteiro, `_id` e `_versao` inclusive.
 *
 * São três leitores do mesmo filtro (igualdade em `matricula`, teto de
 * `INSCRICOES_OUTROS_PROJETOS_MAX`, descarte de inscrição sem projeto) e três
 * contratos diferentes, e é por isso que o que se compartilha é ele e não a
 * projeção:
 *
 *   `outrosProjetosDe_` ......... quer NOMES (`submeterInscricao` desde o
 *                                 primeiro semestre, e `incluirInscricao`);
 *   `inscricoesEmOutrosProjetos_` quer `{id, projeto_id, projeto_nome,
 *                                 em_espera}` (a janela Incluir aluno marca
 *                                 "(este projeto)" pelo ID, porque o nome é
 *                                 desnormalizado e um projeto renomeado deixaria
 *                                 a marca errada);
 *   `inscricoesAtivasDe_` ....... quer o DOCUMENTO: `email`, que é a prova de
 *                                 posse da troca (D4); `origem`, que decide se a
 *                                 inscrição é trocável pelo aluno (J4-2); e
 *                                 sobretudo o resto dele, que é o que a cópia
 *                                 para a quarentena tem de gravar inteiro.
 *
 * Quem quiser um quarto leitor estende daqui; reinventar a consulta é como se
 * criam dois tetos e dois entendimentos de "inscrição sem projeto".
 */
function inscricoesDaPessoa_(matricula, email) {
  if (!matricula && !email) return [];

  var busca = matricula
    ? { campo: 'matricula', valor: matricula }
    : { campo: 'email', valor: email };

  // O `limite` fecha a última consulta sem teto do caminho público.
  //
  // Na prática ela traz de uma a seis linhas — são as inscrições de UMA pessoa —,
  // mas "na prática" não é teto: um e-mail digitado errado e repetido por muita
  // gente, ou um dado de teste que sobrou, faziam esta consulta crescer sem
  // limite dentro do caminho que 500 alunos percorrem ao mesmo tempo.
  //
  // Cortar é seguro aqui, e não seria em qualquer lugar: quem chama usa só
  // `length` e o PRIMEIRO nome (submeterInscricao, logo abaixo) ou o conjunto
  // inteiro de uma pessoa (a troca). Vinte inscrições da mesma pessoa já
  // respondem "sim, ela está em outro projeto" com folga de três vezes o número
  // de projetos que um semestre tem.
  busca.limite = INSCRICOES_OUTROS_PROJETOS_MAX;

  var achados = [];
  listar(INSCRICOES_COLECAO, busca).itens.forEach(function (inscricao) {
    // Inscrição sem projeto não é "outro projeto". O sistema sobre Sheets não
    // fazia esta conferência e empurrava a linha assim mesmo: `projeto_nome ||
    // projeto_id` devolvia string vazia, e o aluno lia "Você já está inscrito em
    // ." — ou era barrado por uma inscrição que não ocupa vaga em lugar nenhum.
    if (!String(inscricao.projeto_id || '').trim()) return;

    achados.push(inscricao);
  });
  return achados;
}

// ------------------------------------------- A troca de projeto (item 4)

/**
 * Os ids de PROJETO que o aluno consentiu em cancelar — o `trocar_de` do POST.
 *
 * Texto, sem barra, sem repetição, e TODOS eles: quem decide o que fazer com uma
 * lista grande demais é `submeterInscricao`, que recusa o envio INTEIRO antes de
 * ler qualquer coisa. Cortar em silêncio seria consentir por baixo do aluno —
 * ele veria a pergunta com dois projetos, clicaria uma vez, e um deles
 * continuaria de pé sem que ninguém dissesse nada.
 *
 * São ids de projeto, e não de documento: o que o aluno consente é "cancele a
 * minha inscrição NAQUELE projeto", e o protocolo da inscrição antiga nunca
 * viaja na pergunta (ele é o número que o aluno fotografou, e a rodada 1
 * acontece sem prova de posse conferida contra escrita nenhuma). A barra é
 * recusada pela mesma razão de `idsDoPayload_` (13_Auditorio.gs): id sem barra é
 * invariante deste banco, e uma barra ali mudaria a coleção alvo em vez de
 * errar — aqui o id chega a `projetoPorId` quando o projeto precisa ser lido.
 *
 * Duas funções e não uma porque o caminho público não pode depender do arquivo
 * do auditório, e porque o TETO é outro: lá ele é aplicado por quem escreve, e
 * aqui ele recusa o pedido.
 */
function idsDeTroca_(bruto) {
  if (!bruto) return [];

  var lista = Array.isArray(bruto) ? bruto : [bruto];
  var vistos = {};
  var ids = [];

  lista.forEach(function (v) {
    var id = String(v === null || v === undefined ? '' : v).trim();
    if (!id || id.indexOf('/') !== -1) return;
    // `hasOwnProperty` e não `vistos[id]`: 'constructor' e 'toString' respondem
    // verdadeiro por herança, e o id legítimo com esse nome seria descartado.
    if (Object.prototype.hasOwnProperty.call(vistos, id)) return;

    vistos[id] = true;
    ids.push(id);
  });

  return ids;
}

/**
 * As inscrições ATIVAS desta matrícula, para a regra de um projeto por aluno.
 *
 * Devolve `{ mesma, outras }`: a inscrição no projeto ALVO (é ela que responde
 * "você já está inscrito neste projeto", com o protocolo de verdade e ZERO
 * escritas) e as dos outros projetos ativos, como `listar` as trouxe — documento
 * inteiro, porque é ele que vai para a quarentena.
 *
 * SÓ PELA MATRÍCULA (D3). Sem matrícula a regra não se aplica e esta função
 * devolve vazio sem consultar nada: cair para o e-mail faria o lado DESTRUTIVO
 * assentar na identidade fraca, e `matricula == ''` traria todas as inscrições
 * sem matrícula de uma vez.
 *
 * O `ctx` carrega o mapa de projetos já lidos, e é ele que decide o preço:
 *
 *   FORA do lock ..... cada `projeto_id` distinto é lido UMA vez (0-N leituras)
 *                      e o mapa fica pronto para as respostas, que precisam do
 *                      `codigo` do projeto;
 *   DENTRO do lock ... projeto que não está no mapa é tratado como ATIVO, sem
 *                      leitura (D11). A razão não é "ela acabou de passar por
 *                      `reservarVaga`" — `incluirInscricao` grava em projeto
 *                      INATIVO sem passar por lá —, e sim o CONJUNTO CONSENTIDO:
 *                      `trocar_de` só pode nomear projetos que a rodada 1
 *                      nomeou, e esses são exatamente os que o mapa tem. Uma
 *                      inscrição que apareça entre as duas consultas cai na
 *                      re-pergunta (que aí lê o projeto faltante), nunca num
 *                      cancelamento.
 */
function inscricoesAtivasDe_(ctx) {
  var achadas = { mesma: null, outras: [] };
  if (!ctx.matricula) return achadas;

  inscricoesDaPessoa_(ctx.matricula, '').forEach(function (inscricao) {
    var projetoId = String(inscricao.projeto_id);
    if (projetoId === String(ctx.alvo)) { achadas.mesma = inscricao; return; }
    if (!projetoAtivoNaTroca_(ctx, projetoId)) return;
    achadas.outras.push(inscricao);
  });

  return achadas;
}

/** O projeto, lido no máximo uma vez por execução. Null quando não existe. */
function projetoDaTroca_(ctx, projetoId) {
  if (!Object.prototype.hasOwnProperty.call(ctx.mapa, projetoId)) {
    ctx.mapa[projetoId] = projetoPorId(projetoId);
  }
  return ctx.mapa[projetoId];
}

/**
 * Esta inscrição conta para a regra?
 *
 * Só se o projeto dela estiver ATIVO — a mesma régua de `situacaoDe_`
 * (09_Projetos.gs), com `inscritos` null porque ESGOTADO não interessa aqui:
 * quem está num projeto lotado continua inscrito nele. FECHADO também conta,
 * pelo mesmo motivo; o que sai da regra é o projeto do semestre passado, que a
 * coordenação desliga em `ativo = NAO`.
 *
 * Projeto APAGADO não é projeto ativo: não dá para perguntar sobre ele nem
 * nomeá-lo na tela, e a inscrição órfã não ocupa vaga em lugar nenhum.
 */
function projetoAtivoNaTroca_(ctx, projetoId) {
  if (ctx.dentroDoLock && !Object.prototype.hasOwnProperty.call(ctx.mapa, projetoId)) return true;

  var projeto = projetoDaTroca_(ctx, projetoId);
  return Boolean(projeto) && situacaoDe_(projeto, null) !== SITUACAO.INATIVO;
}

/**
 * O que a tela precisa saber sobre cada inscrição que seria cancelada —
 * `{ projeto_id, projeto_nome, codigo, em_espera }`, e NADA além disso.
 *
 * Sem o protocolo, de propósito: ele é o número da inscrição ANTIGA, e a
 * pergunta da rodada 1 acontece antes de qualquer escrita — devolvê-lo daria a
 * quem só acertou matrícula e e-mail um dado que ele não tinha.
 *
 * `codigo` é o do PROJETO, e é o que o site guarda no `localStorage` (ver
 * `lembrarInscricao` em docs/assets/app.js): sem ele o navegador continuaria
 * dizendo "você já está inscrito" no projeto que acabou de ser cancelado. O nome
 * vem do projeto quando ele está na mão, e não do campo desnormalizado da
 * inscrição: um projeto renomeado depois da inscrição faria a pergunta citar um
 * nome que já não existe na tela.
 */
function resumoDasAtivas_(ctx, inscricoes) {
  return inscricoes.map(function (inscricao) {
    var projetoId = String(inscricao.projeto_id);
    var projeto = projetoDaTroca_(ctx, projetoId);

    return {
      projeto_id: projetoId,
      projeto_nome: String((projeto && projeto.nome) || inscricao.projeto_nome || projetoId),
      codigo: String((projeto && projeto.codigo) || ''),
      em_espera: String(inscricao.em_espera).toUpperCase() === 'SIM'
    };
  });
}

/** Os nomes numa frase: 'X', 'X e Y', 'X, Y e Z'. */
function nomesEmTexto_(nomes) {
  if (!nomes.length) return '';
  if (nomes.length === 1) return nomes[0];
  return nomes.slice(0, -1).join(', ') + ' e ' + nomes[nomes.length - 1];
}

/** Os nomes dos projetos destas inscrições, sem ler nada. */
function nomesDasAtivas_(inscricoes) {
  return inscricoes.map(function (i) { return String(i.projeto_nome || i.projeto_id); });
}

/**
 * A PROVA DE POSSE (D4): o e-mail do envio tem de ser o da inscrição que sairia.
 *
 * A matrícula não é segredo — é quase sequencial e circula em lista de chamada —,
 * e o lado da troca é destrutivo. Sem isto, saber o número de alguém bastaria
 * para cancelar a inscrição dessa pessoa.
 *
 * A recusa NÃO NOMEIA PROJETO NENHUM, e é a mesma decisão de `matriculaConhecida`:
 * dizer "você está em X" a quem só acertou a matrícula entrega o oráculo que
 * todo o resto do sistema se recusa a ser. Quem é a pessoa de verdade lê a
 * frase, usa o e-mail da inscrição anterior e segue; quem não é, fica sem saber
 * sequer se há inscrição.
 */
function recusaDePosse_(ctx, outras) {
  var divergem = outras.some(function (inscricao) {
    return normalizarEmail(inscricao.email) !== ctx.email;
  });
  if (!divergem) return null;

  return {
    ok: false,
    campo: 'email',
    erro: 'Já existe uma inscrição com esta matrícula feita com outro e-mail. Se é você, ' +
          'use o mesmo e-mail da inscrição anterior ou procure a coordenação do CESUTECH.'
  };
}

/**
 * Inscrição feita PELA COORDENAÇÃO não é trocável pelo aluno (J4-2).
 *
 * O e-mail gravado nela veio da lista oficial (`buscarMatriculado` pré-preenche
 * de `matriculados.email`), e o institucional é `matrícula@...` — derivável da
 * matrícula, logo não prova posse de coisa alguma. A prova de posse de D4 passa
 * sem provar nada, e o aluno cancelaria sozinho a inscrição que a coordenação
 * incluiu à mão para ele.
 *
 * Aqui a recusa NOMEIA o projeto, ao contrário da de posse, e pode: ela só é
 * alcançável DEPOIS da conferência do e-mail — quem errou o e-mail já levou a
 * frase genérica e não chega a esta linha. O caminho da coordenação para mover
 * alguém é Alunos -> Editar -> Projeto, que funciona com o site fechado.
 */
function recusaDeOrigemCoordenacao_(outras) {
  var daCoordenacao = outras.filter(function (inscricao) {
    return String(inscricao.origem).toUpperCase() === 'COORDENACAO';
  });
  if (!daCoordenacao.length) return null;

  var nomes = nomesEmTexto_(nomesDasAtivas_(daCoordenacao));
  return {
    ok: false,
    erro: daCoordenacao.length === 1
      ? 'Sua inscrição no projeto ' + nomes + ' foi feita pela coordenação do CESUTECH. ' +
        'Para trocar de projeto, procure a coordenação.'
      : 'Suas inscrições nos projetos ' + nomes + ' foram feitas pela coordenação do CESUTECH. ' +
        'Para trocar de projeto, procure a coordenação.'
  };
}

/**
 * A PERGUNTA — a resposta da 1ª fase, e a re-pergunta quando o conjunto mudou.
 *
 * `troca_pendente` é o que o site usa para trocar o botão de enviar por um bloco
 * de confirmação com o formulário preenchido; `de` é o conjunto ATUAL, sempre,
 * nunca o que o aluno mandou. Ela não pega lock e não escreve nada.
 */
function perguntaDeTroca_(ctx, outras) {
  var de = resumoDasAtivas_(ctx, outras);

  return {
    ok: false,
    troca_pendente: true,
    erro: 'Você já está inscrito em ' + nomesEmTexto_(de.map(function (a) { return a.projeto_nome; })) + '.',
    de: de
  };
}

/** O nome do projeto ALVO, lido só se ainda não estiver na mão. */
function nomeDoAlvo_(ctx) {
  if (!ctx.nomeDoAlvo) {
    var projeto = projetoDaTroca_(ctx, ctx.alvo);
    ctx.nomeDoAlvo = String((projeto && projeto.nome) || '');
  }
  return ctx.nomeDoAlvo;
}

/**
 * "Não deu, e NADA foi cancelado" — a frase que a troca recusada precisa dizer,
 * porque o aluno acabou de clicar em trocar e está olhando para uma recusa.
 *
 * A abertura é da SITUAÇÃO, porque o motivo muda o que o aluno faz em seguida:
 * vaga que acabou pode voltar pela lista de espera, inscrição encerrada não
 * volta hoje, e projeto desligado não volta. O fecho é sempre o mesmo, e é ele
 * que carrega o recado: a inscrição antiga continua de pé. O site tem as mesmas
 * três aberturas em `fraseDoQueFicou` (docs/assets/app.js) — quem mexer numa
 * mexe na outra.
 */
function fraseDaVagaPerdida_(ctx, outras, situacao) {
  var alvo = nomeDoAlvo_(ctx) || 'deste projeto';
  var nomes = nomesEmTexto_(nomesDasAtivas_(outras));

  var abertura = 'As vagas de ' + alvo + ' acabaram agora. ';
  if (situacao === SITUACAO.FECHADO) abertura = 'As inscrições de ' + alvo + ' foram encerradas. ';
  else if (situacao && situacao !== SITUACAO.ESGOTADO) abertura = 'O projeto ' + alvo + ' não está mais disponível. ';

  return abertura +
    (outras.length === 1
      ? 'Sua inscrição em ' + nomes + ' foi mantida.'
      : 'Suas inscrições em ' + nomes + ' foram mantidas.');
}

/** A cópia que vai para a quarentena, com as quatro marcas da anulação. */
function copiaParaQuarentena_(inscricao, carimbo, idNova) {
  var copia = Object.assign({}, inscricao);

  copia.anulado_em = carimbo;
  // SENTINELA, e não um e-mail: os outros dois produtores da quarentena gravam
  // aqui quem clicou (a coordenação, a revisão de divergências). 'aluno' é o
  // único valor que não é endereço de ninguém, e é o que separa "o aluno trocou
  // de projeto" de "alguém anulou a inscrição dele" — ver o cabeçalho da
  // quarentena em 13_Auditorio.gs.
  copia.anulado_por = 'aluno';
  copia.anulado_motivo = 'TROCA';
  copia.trocado_para = idNova;

  return copia;
}

/**
 * O GRAVADOR da troca: o que roda DENTRO do lock de `reservarVaga`.
 *
 * `reservarVaga` já contou as vagas quando isto começa, e o `emEspera` que chega
 * é a decisão dela. Daqui para baixo, na ordem, e cada passo com a razão de
 * estar onde está:
 *
 *   G1  a consulta AUTORITATIVA, lida depois de esperar na fila. É a que impede
 *       duas abas com a primeira inscrição de cada gravarem as duas;
 *   G2  já está no projeto ALVO -> `duplicada` com o protocolo REAL e ZERO
 *       escritas (D10). É o que fecha o "ALREADY_EXISTS inalcançável": sem isto
 *       o `:commit` tentaria criar o que já existe e a resposta sairia sem saber
 *       o que aconteceu;
 *   G3  não está em mais nada -> a gravação de sempre, UMA escrita;
 *   G4  a posse de novo, contra a inscrição que nasceu entre as duas fases;
 *   G5  apareceu projeto que o aluno NÃO consentiu -> re-pergunta com o conjunto
 *       atual, sem escrita (D9). Nunca "cancelo o que eu achar";
 *   G6  o projeto novo encheu enquanto ele decidia -> recusa, e a antiga fica de
 *       pé (D8). Troca NUNCA cai em lista de espera: "sem vaga, nada muda";
 *   G7  a troca: cópia + delete + create, UMA requisição, tudo ou nada. E o 409
 *       que pode voltar dela tem DUAS leituras, que `retentou` separa: a minha
 *       própria tentativa anterior (a troca entrou) ou outra porta (nada
 *       entrou, e a antiga continua viva) — está escrito lá embaixo.
 *
 * O QUE ESTE GRAVADOR NÃO FAZ, e é decisão, não esquecimento: ele não MONTA
 * resposta. G5, G6 e G7 devolvem o conjunto de inscrições e param — nome e
 * código de projeto custam uma leitura cada (`resumoDasAtivas_`), e a resposta
 * não participa do invariante da vaga. Quem monta é `decorarSaidaDaTroca_`,
 * depois do `releaseLock`. É o que mantém a conta do cabeçalho de 09: consulta,
 * agregação e escrita, e nem uma ida a mais — qualquer projeto lido aqui dentro
 * é fila para todo aluno que está atrás.
 */
function gravadorDaTroca_(dados, ctx) {
  return function (projeto, emEspera) {
    // G0 — o nome vem do projeto lido pelo `reservarVaga`, nunca do payload, e
    // a marca de fila é a decisão de lá, honrada aqui (o contrato de 09).
    dados.projeto_nome = projeto.nome;
    dados.em_espera = emEspera ? 'SIM' : 'NAO';
    ctx.nomeDoAlvo = String(projeto.nome || '');

    // G1
    ctx.dentroDoLock = true;
    var ativas = inscricoesAtivasDe_(ctx);
    ctx.ativasNoLock = ativas.outras;

    // G2 — o aviso das outras vai junto, como o de sempre: nada foi cancelado.
    if (ativas.mesma) {
      return {
        ok: true, duplicada: true, id: ativas.mesma._id, em_espera: false,
        tambem_em: nomesDasAtivas_(ativas.outras)
      };
    }

    // G3 — exatamente o caminho de quem não está em lugar nenhum.
    if (!ativas.outras.length) {
      var gravada = gravarInscricao(dados);
      return { ok: true, duplicada: gravada.duplicada, id: gravada.id, em_espera: Boolean(emEspera) };
    }

    // G4
    var posse = recusaDePosse_(ctx, ativas.outras);
    if (posse) return posse;

    // A mesma régua de J4-2 que já rodou lá fora, repetida aqui pela razão de
    // G4: a inscrição da coordenação pode ter nascido entre as duas fases.
    var coordenacao = recusaDeOrigemCoordenacao_(ativas.outras);
    if (coordenacao) return coordenacao;

    // G5 — apareceu projeto que o aluno não consentiu. A re-pergunta precisa do
    // `codigo` de cada projeto para a tela, e ler projeto é ida ao banco: o que
    // sai daqui é o CONJUNTO, e a pergunta é montada fora do lock
    // (`decorarSaidaDaTroca_`). Escrever a resposta não participa do invariante
    // da vaga, e dentro da região é fila para todo mundo que está atrás.
    var semConsentimento = ativas.outras.filter(function (inscricao) {
      return ctx.trocarDe.indexOf(String(inscricao.projeto_id)) === -1;
    });
    if (semConsentimento.length) return { ok: false, troca_pendente: true, reperguntar: ativas.outras };

    // G6 — sem vaga, nada muda. `mantida` e a frase saem de `ctx.ativasNoLock`,
    // já fora do lock, pelo mesmo motivo de G5.
    if (emEspera) return recusaPorSituacao_(SITUACAO.ESGOTADO);

    // G7 — a matrícula CANCELADA na lista oficial não troca (N4). A recusa vem
    // aqui, e não lá em cima: só é alcançável depois da prova de posse, então
    // não conta a ninguém que a matrícula existe e está cancelada. A inscrição
    // NOVA continua possível (G3) — ela não destrói nada.
    if (ctx.cancelada) {
      return {
        ok: false,
        campo: 'matricula',
        erro: 'Sua matrícula consta como cancelada na lista oficial. ' +
              'Para mudar de projeto, procure a coordenação do CESUTECH.'
      };
    }

    var idNova = chaveDedup_(dados);
    var registro = montarRegistroDaInscricao_(dados);

    // A procedência no documento NOVO (N6), simétrica ao `trocado_para` da
    // cópia: sem ela a inscrição em Y é indistinguível de uma comum, e a única
    // trilha da troca seria a linha do log. Nenhuma escrita a mais, e campo que
    // ninguém filtra — o cuidado de `gravarInscricao` é com as marcas de fila,
    // que uma agregação conta.
    registro.trocada_de = ativas.outras.map(function (i) { return String(i._id); }).join(',');

    var carimbo = agora();
    var escritas = [];
    ativas.outras.forEach(function (inscricao) {
      // A cópia é UPSERT, sem precondição: se a coordenação anulou esta
      // inscrição entre G1 e agora, a cópia dela já está lá e esta sobrescreve.
      // `criar` aqui faria o commit inteiro voltar ALREADY_EXISTS e o aluno
      // receberia "você já estava inscrito" sem que a inscrição nova existisse.
      escritas.push({
        gravar: {
          colecao: INSCRICOES_ANULADAS_COLECAO,
          id: String(inscricao._id),
          objeto: copiaParaQuarentena_(inscricao, carimbo, idNova)
        }
      });
      // E o delete vai SEM `versao`, com a versão de graça na mão: versionado,
      // a anulação da coordenação no meio derrubaria o commit inteiro e o aluno
      // ficaria sem nada — a antiga na quarentena e a nova nunca criada. Apagar
      // o que já não existe é 200.
      escritas.push({ apagar: { colecao: INSCRICOES_COLECAO, id: String(inscricao._id) } });
    });

    // O `criar` leva `exists:false`: é o 409 de sempre, e é ele que impede a
    // troca de sobrescrever a inscrição de outra pessoa no mesmo id.
    escritas.push({ criar: { colecao: INSCRICOES_COLECAO, id: idNova, objeto: registro } });

    var escrito = escreverAtomico(escritas);

    // O 409 do `criar` diz uma coisa só: o documento de Y JÁ ESTAVA no lugar
    // quando o commit chegou. Ele NÃO diz quem o pôs lá — e são duas histórias
    // opostas, que `retentou` (02_Repo.gs) separa. Sem ler `retentou`, as duas
    // saíam com a mesma frase, e numa delas a frase era falsa.
    //
    //   COM retentativa: o 503 pode ter chegado na RESPOSTA de um `:commit` que
    //   o banco JÁ tinha aplicado — e a segunda tentativa encontrou a inscrição
    //   nova no lugar, posta por nós mesmos. `retentou` NÃO prova isso: ele diz
    //   que houve retentativa, e a coordenação pode ter gravado Y durante ela,
    //   exatamente como no ramo de baixo. As duas histórias cabem no mesmo 409,
    //   e a diferença entre elas é o que o aluno perde ou mantém.
    //
    //   Então aqui — e SÓ aqui, num caminho que exige um 503 — paga-se UMA
    //   leitura de ponto para não inventar: a inscrição antiga. O `:commit` é
    //   atômico, logo ela responde tudo. SUMIU → o commit entrou, a troca
    //   aconteceu; CONTINUA LÁ → o commit foi recusado e quem pôs Y foi outro.
    //   O preço é honesto e está no lugar certo: ~0,5 s de fila num ramo que
    //   não acontece num evento inteiro, contra dizer ao aluno que ele está em
    //   um projeto quando está em dois (ou o contrário). A leitura é de PONTO,
    //   pelo id que G1 já tem na mão — nada de consulta.
    //
    //   Quando a leitura diz que a troca ENTROU, o que não se pode é calar:
    //   este é o único ramo em que ela entra sem a resposta anunciá-la, e a
    //   linha `INSCRICAO_TROCADA` sai MESMO ASSIM, dizendo o que não se pode
    //   confirmar pela resposta. É a régua do ramo indeterminado do Auditório
    //   (13_Auditorio.gs) e do Incluir aluno (10_Painel.gs), aplicada ao
    //   terceiro escritor de `escreverAtomico`. Quem registra é
    //   `decorarComATroca_`, fora do lock, como toda escrita de log daqui.
    //
    //   SEM retentativa: alguém gravou Y entre G1 e este commit, e não é
    //   hipótese — `incluirInscricao` (10_Painel.gs) grava em `inscricoes` com a
    //   MESMA `chaveDedup_` e SEM o lock, que é a porta da coordenação. Aqui o
    //   commit inteiro foi RECUSADO: a inscrição antiga continua VIVA, a
    //   quarentena está vazia, nada foi cancelado. A resposta é a duplicada
    //   HONESTA — o aluno está em Y, por outra via — e não pode afirmar
    //   cancelamento nenhum; o `tambem_em` é o mesmo de G2, e é ele que NOMEIA a
    //   inscrição que continua de pé, para o aluno não descobrir sozinho que
    //   está em dois projetos.
    if (escrito.jaExistia) {
      // A pergunta que desempata, uma leitura de ponto: a antiga ainda está lá?
      // Sem `retentou` nem se pergunta — sem retentativa, o commit foi recusado
      // e a antiga está viva por construção.
      var trocaEntrou = escrito.retentou &&
        ativas.outras.every(function (inscricao) {
          return ler(INSCRICOES_COLECAO, String(inscricao._id)) === null;
        });

      if (trocaEntrou) {
        return {
          ok: true, duplicada: true, id: idNova, em_espera: false,
          // Só id e nome, montados aqui com o que G1 já tinha na mão: a linha do
          // log não lê projeto nenhum, e ler dentro do lock é fila para quem
          // está atrás (o contrato de `reservarVaga`).
          troca_indeterminada: {
            de: ativas.outras.map(function (inscricao) {
              return {
                id: String(inscricao._id),
                projeto_nome: String(inscricao.projeto_nome || inscricao.projeto_id)
              };
            }),
            para: ctx.nomeDoAlvo
          }
        };
      }

      return {
        ok: true, duplicada: true, id: idNova, em_espera: false,
        tambem_em: nomesDasAtivas_(ativas.outras)
      };
    }

    // Os DOCUMENTOS cancelados, como G1 os viu. O resumo que a tela lê (nome e
    // código do projeto) é montado fora do lock, em `decorarSaidaDaTroca_`: ele
    // pode custar uma leitura por projeto, e a vaga já está resolvida aqui.
    return {
      ok: true, duplicada: false, id: idNova, em_espera: false,
      trocada: { de: ativas.outras, para: ctx.nomeDoAlvo }
    };
  };
}

/**
 * A RESPOSTA DA TROCA, montada depois do `releaseLock`.
 *
 * Tudo que a tela precisa saber sobre PROJETO — nome e código — custa uma
 * leitura por projeto que ainda não está no `ctx.mapa`, e nenhuma delas tem o
 * direito de acontecer dentro da região protegida: a vaga já foi decidida, e
 * cada ida a mais lá dentro é ~0,5 s de fila para todo aluno que está atrás (o
 * contrato de `reservarVaga`, 09_Projetos.gs). Então o gravador devolve
 * CONJUNTOS de inscrição e é aqui que eles viram frase.
 *
 * Três saídas, e cada uma sabe de onde tira o conjunto:
 *
 *   a re-pergunta de G5 ..... o conjunto vem no `reperguntar`, e a resposta
 *                             inteira é reconstruída por `perguntaDeTroca_`;
 *   a recusa com situação ... `ctx.ativasNoLock` é o que a consulta de DENTRO
 *                             viu; sem ele (a recusa que nem chegou ao gravador,
 *                             como FECHADO e INATIVO, que `reservarVaga` recusa
 *                             antes do lock) vale o conjunto de fora, que é o
 *                             que o aluno tinha na tela;
 *   a troca feita ........... `trocada.de` chega com os documentos cancelados e
 *                             sai com o resumo, que é o que o site lê.
 */
function decorarSaidaDaTroca_(ctx, achadas, resultado) {
  if (resultado.reperguntar) return perguntaDeTroca_(ctx, resultado.reperguntar);

  if (!resultado.ok) {
    decorarRecusaDaTroca_(ctx, achadas, resultado);
    return resultado;
  }

  if (resultado.trocada) {
    var canceladas = resultado.trocada.de;
    resultado.trocada.de = resumoDasAtivas_(ctx, canceladas).map(function (resumo, indice) {
      return {
        id: String(canceladas[indice]._id),
        projeto_id: resumo.projeto_id,
        projeto_nome: resumo.projeto_nome,
        codigo: resumo.codigo
      };
    });
  }

  return resultado;
}

/**
 * "Nada foi cancelado" — a recusa da troca que o aluno precisa ler.
 *
 * Vale para QUALQUER situação de recusa, e não só para ESGOTADO: quem clicou em
 * [Trocar] autorizou um cancelamento, e ler "as inscrições deste projeto estão
 * encerradas" sem mais nada é concluir que ficou sem as duas. O projeto novo
 * pode ter FECHADO ou sido desligado entre a pergunta e a confirmação — e aí a
 * recusa vem de `reservarVaga`, antes do lock, sem passar pelo gravador. A
 * rodada 1 já dizia isso; a rodada 2, que é a de maior aposta, não dizia.
 *
 * ABERTO nunca chega aqui (é sucesso), e a recusa sem situação — lock estourado,
 * projeto não encontrado — não é sobre vaga e não ganha frase de vaga.
 */
function decorarRecusaDaTroca_(ctx, achadas, resultado) {
  if (!resultado.situacao || resultado.situacao === SITUACAO.ABERTO) return;

  var ativas = ctx.ativasNoLock || achadas.outras;
  if (!ativas.length) return;

  resultado.mantida = resumoDasAtivas_(ctx, ativas);
  resultado.erro = fraseDaVagaPerdida_(ctx, ativas, resultado.situacao);
}

// ------------------------------------------------------------ Janela de inscrição

/**
 * O período GERAL de inscrição (pedido do Prof. Mário, 19/09, item 5): um
 * início e um fim, em `inscricoes_inicio` e `inscricoes_fim`, por cima de tudo.
 * `cadastro_aberto` continua sendo o interruptor manual e o `inscricoes_abertas`
 * de cada projeto continua fechando o projeto sozinho (09_Projetos.gs); a
 * janela é uma camada a mais, não a substituição de nenhuma das duas.
 *
 * Devolve { estado, inicio, fim }, com o estado em ANTES, ABERTA, DEPOIS ou
 * SEM_JANELA — as duas chaves vazias — e os limites já limpos: '' quando a
 * chave está vazia OU inválida.
 *
 * A comparação é de TEXTO, e é o raciocínio de `dentroDoPeriodo_` no painel:
 * `agora()` sai em 'yyyy-MM-dd HH:mm:ss' no fuso de APP.timezone, a chave é o
 * mesmo carimbo sem os segundos, e os dois têm largura fixa com zero à esquerda
 * — comparar texto é comparar instante. `new Date('2026-10-01 08:00')` leria a
 * chave como UTC (ou como nada, dependendo do motor) e a inscrição abriria três
 * horas antes do combinado. Os 16 primeiros caracteres de `agora()` contra os
 * 16 da chave: no minuto do fim, 'HH:mm' >= 'HH:mm' já é DEPOIS — que é o
 * instante em que o contador do site chega a zero.
 *
 * Chave fora do formato é tratada como VAZIA, e o erro vai para o console: é a
 * decisão de `matriculaDigitos_` pelo outro lado. Lá o lado seguro é continuar
 * validando; aqui o lado seguro é NÃO fechar — uma data digitada torta na tela
 * de Configurações não pode encerrar a inscrição do semestre inteiro sem
 * ninguém perceber. O padrão vazio das duas chaves existe pela mesma razão:
 * publicar esta versão no meio de um semestre não muda nada.
 */
var JANELA_FORMATO = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d$/;

function limiteDaJanela_(chave, bruto) {
  var valor = String(bruto || '').trim();
  if (!valor || JANELA_FORMATO.test(valor)) return valor;

  console.error(chave + ': "' + valor.slice(0, 40) + '" não está no formato AAAA-MM-DD HH:MM; ' +
    'a chave foi ignorada e a inscrição segue sem limite desse lado.');
  return '';
}

function janelaDeInscricao_() {
  var inicio = limiteDaJanela_('inscricoes_inicio', config('inscricoes_inicio', ''));
  var fim = limiteDaJanela_('inscricoes_fim', config('inscricoes_fim', ''));
  var minuto = agora().slice(0, 16);

  var estado;
  if (!inicio && !fim) estado = 'SEM_JANELA';
  else if (inicio && minuto < inicio) estado = 'ANTES';
  else if (fim && minuto >= fim) estado = 'DEPOIS';
  else estado = 'ABERTA';

  return { estado: estado, inicio: inicio, fim: fim };
}

/** 'yyyy-MM-dd HH:mm' -> 'dd/mm/yyyy às HH:mm', para a recusa dizer a data. */
function limiteEmTexto_(limite) {
  return limite.slice(8, 10) + '/' + limite.slice(5, 7) + '/' + limite.slice(0, 4) +
    ' às ' + limite.slice(11, 16);
}

/** A recusa fora da janela, com a data — ou '' dentro dela. */
function recusaPelaJanela_() {
  var janela = janelaDeInscricao_();
  if (janela.estado === 'ANTES') return 'As inscrições abrem em ' + limiteEmTexto_(janela.inicio) + '.';
  if (janela.estado === 'DEPOIS') return 'As inscrições encerraram em ' + limiteEmTexto_(janela.fim) + '.';
  return '';
}

// ------------------------------------------------------------ Endpoint público

/**
 * Recepção do formulário público.
 * Chamada pelo site (doPost) e pelo Cadastro.html (google.script.run) — tudo é
 * revalidado aqui, porque validação de front-end é conveniência, não segurança.
 */
function submeterInscricao(dados) {
  try {
    if (config('cadastro_aberto', 'SIM').toUpperCase() !== 'SIM') {
      return { ok: false, erro: 'As inscrições estão encerradas no momento.' };
    }

    // A janela vem DEPOIS do interruptor e ANTES das guardas. O servidor é a
    // trava: o contador do site é conforto, e bastaria acertar o relógio do
    // celular para passar por ele. Até aqui só a configuração foi lida, e
    // recusar aqui não consome o teto por hora de `verificarAntiAbuso_`.
    var foraDaJanela = recusaPelaJanela_();
    if (foraDaJanela) return { ok: false, erro: foraDaJanela };

    dados = dados || {};

    var abuso = verificarAntiAbuso_(dados);
    if (abuso) return { ok: false, erro: abuso };

    var erros = validarInscricao(dados);
    if (erros.length) return { ok: false, erro: erros.join(' ') };

    // Uma consulta à lista oficial por inscrição, e uma só. As TRÊS perguntas
    // que dependem dela — "posso recusar?", "o dado é conferido?" e "esta
    // matrícula foi cancelada?" — são a MESMA leitura, e o sistema sobre Sheets
    // fazia duas varreduras da coluna para responder as duas primeiras.
    //
    // Revalidação no servidor: a checagem do navegador é conveniência para o
    // aluno, não garantia. Quem manda POST direto passaria por cima dela.
    var ficha = fichaOficialDe_(dados.matricula);
    var conhecida = ficha !== null && !cadastroCancelado_(ficha);

    var recusa = checarMatriculaNaLista_(dados.matricula, dados.projeto_id, conhecida);
    if (recusa) return { ok: false, erro: recusa, campo: 'matricula' };

    dados.matricula_conferida = conhecida ? 'SIM' : 'NAO';
    dados.origem = dados.origem || 'SITE';
    dados.consentimento_lgpd = dados.consentimento_lgpd ? 'SIM' : 'NAO';

    // Quem decide fila de espera é `reservarVaga`, contando dentro do lock — e é
    // ele que devolve a decisão logo abaixo. Zerar aqui é o mesmo cuidado que
    // `doPost` tem com `origem`: o campo tem nome conhecido, viaja no mesmo
    // payload que o aluno preenche, e sem esta linha bastaria mandar
    // `em_espera: SIM` para gravar uma inscrição marcada que nenhuma vaga
    // consumiu. Não é ataque grave; é dado sujo entrando por descuido de desenho.
    dados.em_espera = 'NAO';

    // Sem projeto: formulário interno, sem controle de vaga. Grava direto, FORA
    // de qualquer lock — e é seguro justamente porque a unicidade agora é do
    // banco, não de uma varredura serializada.
    if (!dados.projeto_id) {
      return finalizarInscricao_(gravarInscricao(dados), 'INSCRICAO_SITE');
    }

    // A REGRA DE UM PROJETO ATIVO POR MATRÍCULA (item 4). Ela depende de DUAS
    // coisas, e as duas são condição: a chave, e a matrícula. Sem matrícula a
    // regra não se aplica (§4) — e aí `trocar_de` é apagado do payload pelo
    // mesmo cuidado que `em_espera` recebe acima: campo de nome conhecido, no
    // mesmo envelope que o aluno preenche.
    var regra = String(config('aluno_projeto_unico', 'NAO')).toUpperCase() === 'SIM' &&
      normalizarMatricula(dados.matricula) !== '';

    var jaEstaEm = [];
    var ctx = null;
    var achadas = null;

    if (!regra) {
      delete dados.trocar_de;
      jaEstaEm = outrosProjetosDe_(dados);
    } else {
      var trocarDe = idsDeTroca_(dados.trocar_de);
      if (trocarDe.length > INSCRICOES_OUTROS_PROJETOS_MAX) {
        // ANTES de ler qualquer coisa, e recusando em vez de truncar: uma lista
        // desse tamanho não veio da nossa tela, e cortá-la cancelaria só parte
        // do que ela pede.
        return { ok: false, erro: 'Pedido de troca inválido. Recarregue a página e tente de novo.' };
      }

      ctx = {
        matricula: normalizarMatricula(dados.matricula),
        email: normalizarEmail(dados.email),
        alvo: String(dados.projeto_id),
        trocarDe: trocarDe,
        cancelada: ficha !== null && cadastroCancelado_(ficha),
        // O que já foi lido: projeto por id, no máximo uma vez cada.
        mapa: {},
        dentroDoLock: false,
        ativasNoLock: null,
        nomeDoAlvo: ''
      };

      // FORA DO LOCK: a pergunta. Consultar aqui é cortesia — quem decide é a
      // consulta de dentro —, mas é o que permite perguntar sem serializar
      // ninguém, e o que dá à tela o conjunto a confirmar.
      achadas = inscricoesAtivasDe_(ctx);

      // A inscrição no projeto ALVO manda em tudo, e é por isso que ela vem
      // antes: perguntar "quer trocar?" a quem já está lá é oferecer a troca de
      // um projeto por ele mesmo. Quem responde é G2, dentro do lock, com o
      // protocolo REAL e zero escritas (D10) — a mesma ordem que o gravador
      // segue, e o que faz o reenvio de quem está em dois projetos antigos
      // continuar sendo `duplicada` com o aviso, como sempre foi.
      if (!achadas.mesma && achadas.outras.length) {
        var posse = recusaDePosse_(ctx, achadas.outras);
        if (posse) return posse;

        var coordenacao = recusaDeOrigemCoordenacao_(achadas.outras);
        if (coordenacao) return coordenacao;

        if (!trocarDe.length) {
          // 1ª FASE. Antes de convidar para a troca, a situação do projeto novo:
          // convidar para uma troca impossível seria pedir uma confirmação que
          // só pode terminar em recusa. Quem decide continua sendo a contagem de
          // dentro do lock; esta é a do instante da pergunta.
          var alvo = projetoDaTroca_(ctx, ctx.alvo);
          if (alvo) {
            ctx.nomeDoAlvo = String(alvo.nome || '');
            var situacao = situacaoDe_(alvo, contarInscritos_(ctx.alvo));
            if (situacao !== SITUACAO.ABERTO) {
              // Nada foi cancelado, e a resposta diz o que continua de pé — pela
              // mesma régua da rodada 2, que é a que importa (o aluno já clicou
              // em [Trocar] lá).
              var recusaDoAlvo = recusaPorSituacao_(situacao);
              decorarRecusaDaTroca_(ctx, achadas, recusaDoAlvo);
              return recusaDoAlvo;
            }
          }
          return perguntaDeTroca_(ctx, achadas.outras);
        }

        // 2ª FASE com o conjunto já diferente do que ele viu: re-pergunta, aqui
        // fora, sem gastar o lock.
        var naoConsentidas = achadas.outras.filter(function (inscricao) {
          return trocarDe.indexOf(String(inscricao.projeto_id)) === -1;
        });
        if (naoConsentidas.length) return perguntaDeTroca_(ctx, achadas.outras);
      }
    }

    // Conferir a vaga e gravar precisam ser indivisíveis — ver 09_Projetos.gs.
    // O que entra na região protegida é só a chamada do gravador: uma escrita,
    // ou — com a regra ligada — uma consulta limitada por igualdade e uma
    // escrita (que pode ser o `:commit` da troca). Tudo que dava para decidir
    // antes já foi decidido acima.
    // `emEspera` chega decidido de dentro do lock, e é honrado aqui — é o
    // contrato que 09_Projetos.gs escreveu em maiúsculas: ignorá-lo gravaria o
    // excedente como se ele ocupasse vaga, e o projeto fecharia com mais gente do
    // que tem lugar.
    var resultado = reservarVaga(dados.projeto_id, regra
      ? gravadorDaTroca_(dados, ctx)
      : function (projeto, emEspera) {
        dados.projeto_nome = projeto.nome;
        dados.em_espera = emEspera ? 'SIM' : 'NAO';
        var r = gravarInscricao(dados);
        return { ok: true, duplicada: r.duplicada, id: r.id, em_espera: Boolean(emEspera) };
      });

    // FORA DO LOCK, e é aqui que a resposta da troca ganha nome e código de
    // projeto: o gravador devolveu conjuntos justamente para não pagar essas
    // leituras dentro da região protegida (ver `decorarSaidaDaTroca_`).
    if (regra) resultado = decorarSaidaDaTroca_(ctx, achadas, resultado);

    if (!resultado.ok) return resultado;

    // Fora do lock de propósito: o log é mais uma escrita, e ela não participa do
    // invariante da vaga. Dentro, custaria 50% a mais de fila para cada aluno.
    var saida = finalizarInscricao_(resultado, 'INSCRICAO_PROJETO');
    if (!regra && jaEstaEm.length && !resultado.duplicada) {
      saida.aviso = 'Atenção: você também consta inscrito em ' + jaEstaEm.join(', ') + '.';
    }
    return saida;
  } catch (err) {
    // A régua D-27 (`semCaminhoDeDocumento_`, 02_Repo.gs) também no console: a
    // mensagem de um `:commit` recusado carrega 'projects/<id do projeto
    // Cloud>/.../inscricoes/<hash>' — o id do projeto e o protocolo do aluno.
    console.error('submeterInscricao: ' + semCaminhoDeDocumento_(err));
    return { ok: false, erro: 'Erro ao registrar. Tente novamente em instantes.' };
  }
}

function finalizarInscricao_(r, acao) {
  registrar(acao, 'inscricao', r.id, r.duplicada ? 'duplicada' : (r.em_espera ? 'nova, em espera' : 'nova'));

  return decorarComATroca_(r, respostaDaInscricao_(r));
}

/**
 * A TRILHA e o AVISO da troca, por cima da resposta de sempre.
 *
 * A linha `INSCRICAO_TROCADA` é a única trilha DURÁVEL da troca: a cópia na
 * quarentena pode ser sobrescrita pela anulação da coordenação (e vice-versa —
 * ver o cabeçalho da quarentena em 13_Auditorio.gs), e o log não. Ela leva ids
 * e nomes de PROJETO, nenhum dado pessoal — é a mesma régua de `registrarEdicao_`
 * (10_Painel.gs): o que identifica a pessoa já está na ficha, a um clique.
 *
 * O `de` que vai para o aluno não leva o id: o protocolo da inscrição cancelada
 * morreu com ela, e o número que ele precisa guardar é o NOVO. O `codigo` vai,
 * porque é por ele que o navegador esquece o projeto antigo.
 */
function decorarComATroca_(r, saida) {
  if (r.trocada) {
    registrar('INSCRICAO_TROCADA', 'inscricao', r.id,
      'de ' + r.trocada.de.map(function (a) { return a.id; }).join(',') + ' para ' + r.id +
      ' (' + r.trocada.de.map(function (a) { return a.projeto_nome; }).join(', ') +
      ' → ' + r.trocada.para + ')');

    saida.trocada = {
      de: r.trocada.de.map(function (a) {
        return { projeto_nome: a.projeto_nome, codigo: a.codigo };
      })
    };

    var nomes = nomesEmTexto_(r.trocada.de.map(function (a) { return a.projeto_nome; }));
    saida.mensagem += r.trocada.de.length === 1
      ? ' Sua inscrição anterior em ' + nomes + ' foi cancelada.'
      : ' Suas inscrições anteriores em ' + nomes + ' foram canceladas.';
  }

  // A TROCA QUE PODE TER ENTRADO SEM NINGUÉM SABER (G7 com `retentou`): o 409
  // veio depois de uma retentativa, então o `:commit` anterior pode ter sido
  // aplicado e a troca ter acontecido. A resposta diz o que o banco MOSTRA (a
  // inscrição em Y existe — é a frase da duplicada); a trilha diz o que ele NÃO
  // confirma. A linha sai mesmo assim porque este é o único ramo em que a troca
  // entra sem nenhuma outra prova: a cópia na quarentena pode ser sobrescrita, e
  // a resposta ao aluno não anuncia cancelamento nenhum. É a régua do ramo
  // indeterminado do Auditório e do Incluir aluno, com as palavras desta porta.
  if (r.troca_indeterminada) {
    registrar('INSCRICAO_TROCADA', 'inscricao', r.id,
      'resultado INDETERMINADO: a resposta do banco se perdeu numa retentativa e a troca pode ' +
      'ter entrado — de ' +
      r.troca_indeterminada.de.map(function (a) { return a.id; }).join(',') + ' para ' + r.id +
      ' (' + r.troca_indeterminada.de.map(function (a) { return a.projeto_nome; }).join(', ') +
      ' → ' + r.troca_indeterminada.para + ')');
  }

  // O aviso de sempre, agora vindo de dentro do lock: quem reenviou para o
  // projeto em que já está continua constando em outro, e nada foi cancelado.
  if (r.tambem_em && r.tambem_em.length) {
    saida.aviso = 'Atenção: você também consta inscrito em ' + r.tambem_em.join(', ') + '.';
  }

  return saida;
}

/** As três respostas de sucesso — a duplicada, a da fila e a comum. */
function respostaDaInscricao_(r) {
  // REENVIO DEVOLVE O MESMO PROTOCOLO, e não só o mesmo "ok".
  //
  // A dedup já era do banco: a chave do documento é `chaveDedup_(dados)`, o
  // `createDocument` recusa a segunda com 409 ALREADY_EXISTS, e `inserir` trata
  // esse 409 como resposta — nunca como erro. Quem reenvia depois de uma queda de
  // rede portanto NÃO duplica, e recebe sucesso. Isso já estava certo.
  //
  // O que faltava era o número: o protocolo saía só na primeira resposta, e quem
  // perdeu a primeira (aba fechada, 3G do auditório caindo no meio do envio)
  // ficava com "você já está inscrito" e nada para mostrar na recepção. O
  // protocolo É a chave de dedup, então repeti-lo é devolver o mesmo dado, não
  // gravar de novo: nenhuma escrita, nenhuma vaga, a mesma resposta.
  if (r.duplicada) {
    return {
      ok: true,
      duplicada: true,
      mensagem: 'Você já está inscrito neste projeto. Não é preciso preencher de novo.',
      protocolo: r.id
    };
  }

  // A pessoa está INSCRITA, e a frase precisa começar por aí. Quem lê "esgotado"
  // numa tela de auditório levanta e vai embora — e esse aluno não volta.
  if (r.em_espera) {
    return {
      ok: true,
      duplicada: false,
      em_espera: true,
      mensagem: config('texto_espera', 'Inscrição registrada! Você entrou na lista de espera deste projeto: as vagas previstas já foram preenchidas, e a coordenação do CESUTECH vai confirmar a sua participação. Guarde o protocolo abaixo.'),
      protocolo: r.id
    };
  }

  return { ok: true, duplicada: false, mensagem: 'Inscrição registrada com sucesso.', protocolo: r.id };
}

/**
 * Freios contra envio automatizado.
 *
 * Com o formulário hospedado no GitHub Pages, a URL do /exec fica visível no
 * JavaScript da página. Isso é da natureza de um endpoint público de inscrição,
 * mas exige três defesas baratas — o Apps Script não expõe o IP do visitante,
 * então não dá para limitar por origem.
 *
 * Devolve string com o motivo da recusa, ou '' quando está tudo certo.
 */
function verificarAntiAbuso_(d) {
  // 1. Honeypot: campo escondido por CSS. Humano nunca preenche; robô que
  //    preenche tudo, sim.
  if (String(d.website || '').trim()) {
    registrarRecusa('BLOQUEIO', 'inscricao', '', 'honeypot preenchido', 'honeypot');
    return 'Não foi possível registrar a inscrição.';
  }

  // 2. Tempo de preenchimento: ninguém preenche matrícula, nome e e-mail em 3s.
  //
  //    A sondagem de segurança mostrou o buraco da versão anterior: tratar a
  //    AUSÊNCIA do campo como benigna deixava o robô contornar as duas defesas
  //    simplesmente não mandando nada. Quem chega pelo endpoint público tem de
  //    provar que veio do formulário.
  //
  //    A exigência vale só para SITE_EXTERNO, que é a superfície de ataque. O
  //    Cadastro.html entra por google.script.run, já dentro do Google, e não
  //    informa o tempo.
  var ms = Number(d.tempoPreenchimento || 0);

  if (String(d.origem) === 'SITE_EXTERNO' && !ms) {
    registrarRecusa('BLOQUEIO', 'inscricao', '', 'envio externo sem sinal de origem', 'sem_origem');
    return 'Não foi possível registrar a inscrição. Preencha pelo formulário do site.';
  }

  if (ms > 0 && ms < 3000) {
    registrarRecusa('BLOQUEIO', 'inscricao', '', 'preenchido em ' + ms + 'ms', 'rapido_demais');
    return 'Não foi possível registrar a inscrição.';
  }

  // 3. Teto global por hora, para uma enxurrada não encher o banco.
  //
  //    O padrão aqui tem de ser o mesmo de CONFIG_PADRAO, e no sistema sobre
  //    Sheets não era: a configuração dizia 2000 e este literal continuou em 60,
  //    de quando 60 era a paranoia da primeira versão. Enquanto a chave existe no
  //    banco ninguém percebe. O dia em que ela não existir — implantação nova,
  //    setup pela metade — é o dia do auditório, e o sistema recusaria a partir do
  //    aluno 61 com uma mensagem simpática dizendo que está tudo bem. Existe teste
  //    que compara todos os padrões deste arquivo com CONFIG_PADRAO.
  //
  //    UMA TROCA DE PROJETO CONTA DUAS: a pergunta e a confirmação são dois POST
  //    `acao=inscricao`, e os dois passam por aqui. Com 2000/hora e 300 alunos
  //    num evento, a folga continua sendo de quase sete vezes — mas quem baixar
  //    esta chave tem de contar as trocas em dobro.
  var limite = Number(config('limite_inscricoes_hora', '2000'));
  var props = PropertiesService.getScriptProperties();
  var janela = String(Math.floor(new Date().getTime() / 3600000));
  var contagem = (props.getProperty('throttle_janela') === janela)
    ? Number(props.getProperty('throttle_contagem') || 0)
    : 0;

  if (contagem >= limite) {
    registrarRecusa('BLOQUEIO', 'inscricao', '', 'teto de ' + limite + '/hora atingido', 'teto_hora');
    return 'Estamos recebendo muitas inscrições agora. Tente novamente em alguns minutos.';
  }
  props.setProperty('throttle_janela', janela);
  props.setProperty('throttle_contagem', String(contagem + 1));

  return '';
}

function validarInscricao(d) {
  var erros = [];

  if (!String(d.nome || '').trim() || String(d.nome).trim().split(/\s+/).length < 2) {
    erros.push('Informe o nome completo.');
  }
  if (!emailValido(d.email)) {
    erros.push('E-mail inválido.');
  }

  // Matrícula é a chave do aluno no CESUTECH. Não tem dígito verificador,
  // então dá para checar só o formato — e o formato é o TAMANHO, exato. A faixa
  // de 4 a 20 que ficava aqui aceitava `911001` e `91100011`, e era assim que a
  // matrícula digitada errada entrava e depois não casava com a lista oficial
  // (pedido do Prof. Mário, 19/09). A régua vive em `erroFormatoMatricula_`
  // porque a conferência ao vivo do site precisa da mesma.
  if (config('exigir_matricula', 'SIM').toUpperCase() === 'SIM') {
    if (!normalizarMatricula(d.matricula)) erros.push('Informe a matrícula.');
    else {
      var formato = erroFormatoMatricula_(d.matricula);
      if (formato) erros.push(formato);
    }
  }

  // CPF é conferido só quando vem preenchido. Nenhum formulário do CESUTECH o
  // coleta — a chave é a matrícula —, então exigi-lo seria uma trava
  // impossível de satisfazer, e foi exatamente o que aconteceu: a configuração
  // guardava exigir_cpf=SIM de quando o CPF era a chave, e toda inscrição
  // morria com "CPF inválido" sem campo onde digitá-lo.
  if (d.cpf && !cpfValido(d.cpf)) {
    erros.push('CPF inválido.');
  }

  var tel = normalizarTelefone(d.whatsapp || d.telefone);
  if (tel && (tel.length < 10 || tel.length > 11)) {
    erros.push('WhatsApp inválido.');
  }

  // Campos que só existem no formulário de projeto. O formulário interno e as
  // inscrições sem projeto não os têm, e exigi-los ali recusaria envios
  // legítimos — o mesmo erro do exigir_cpf, por outro campo.
  if (d.projeto_id) {
    if (!String(d.curso_fase || '').trim()) {
      erros.push('Selecione seu curso e fase.');
    }
    if (!d.declara_ciencia) {
      erros.push('É necessário declarar ciência para participar do projeto.');
    }
  }
  if (!d.consentimento_lgpd) {
    erros.push('É necessário aceitar o aviso de privacidade.');
  }
  return erros;
}
