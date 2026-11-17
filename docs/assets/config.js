/**
 * config.js — o endereço do servidor e o client id do botão do Google.
 *
 * O `endpoint` é a URL /exec da implantação do web app, e ela NÃO muda quando o
 * servidor é publicado de novo. Publicar é atualizar a implantação que já
 * existe, com a conta que já implanta (guias/publicar-o-servidor.md, passo 1)
 * — Implantar › Gerenciar implantações › editar (o lápis) › Versão: Nova versão,
 * Descrição: `Cesutech vN <sha>` › Implantar —, e nunca usar Implantar › Nova implantação:
 * a implantação nova ganha outra URL, e a antiga continua respondendo com o
 * código antigo. Pelo mesmo motivo, arquive todas as outras implantações que
 * existirem no projeto, de qualquer tipo. O passo a passo — o envio do código
 * vem antes da Nova versão — está em guias/publicar-o-servidor.md.
 *
 * Esta linha só muda se a implantação de produção for substituída de propósito
 * (outra conta, outro projeto) — e aí no mesmo dia em que a antiga é arquivada.
 *
 * A URL é pública por natureza (é o endereço para onde o formulário envia),
 * então não é segredo — mas veja verificarAntiAbuso_() em 04_Inscricoes.gs para
 * entender as defesas que existem por trás.
 */
window.CESUTECH_CONFIG = {
  // Implantação do web app do projeto institucional `cesutech-ext`, dentro da
  // organização unicesusc.edu.br. Criada em 11/08/2026.
  //
  // Nunca troque pela URL do projeto em produção
  // (o sistema anterior, sobre Google Sheets): este site passaria a gravar na
  // planilha real do CESUTECH, por um front-end que ainda não foi validado.
  // Os dois sistemas existem lado a lado justamente para isso não acontecer.
  //
  // Ao criar uma implantação NOVA (e não atualizar esta), o Google emite outra
  // URL e a antiga continua respondendo a versão velha — até ser arquivada. Se o
  // site começar a se comportar como uma versão anterior do código, é aqui que
  // se olha primeiro, e depois em Implantar › Gerenciar implantações.
  endpoint: 'https://script.google.com/macros/s/AKfycbyRw4yCZ_gjD_yWDW_TTTWuBjoqu5v3H-871_gDT6-2KoBsMD4iUjXLew3a0rkD4PhXSQ/exec',

  // ------------------------------------------------------- Painel de gestão
  //
  // O client id OAuth do botão "Entrar com o Google" (docs/painel/). Ele é
  // PÚBLICO por construção: identifica o aplicativo, não autoriza nada. Quem
  // autoriza é a lista de origens registrada no console do Google, e quem
  // verifica o token é o servidor (`verificarIdTokenGoogle_`, 07_Auth.gs).
  //
  // ELE NÃO É A FONTE DA VERDADE. O valor que vale é a propriedade
  // GOOGLE_CLIENT_ID nas Propriedades do script, porque é contra ELA que o
  // servidor compara o `aud` do token; o painel pede esse valor ao servidor
  // (`modoDeAcesso`) e usa o que vier de lá. Esta linha serve para (1) o valor
  // ficar escrito onde se lê o repositório e (2) socorro se a implantação for
  // antiga demais para devolvê-lo. Se os dois divergirem, o painel avisa na
  // tela em vez de desenhar um botão que recusaria todo mundo.
  //
  // Vazio = sem botão do Google, e a tela de login diz isso com todas as
  // letras, apontando onde criar a propriedade. Quem precisar entrar nesse
  // estado usa o link por e-mail (07b_LinkPorEmail.gs), que não depende de
  // client id nenhum — e é exatamente para isto que ele existe.
  googleClientId: '',

  // O ÚNICO texto de reserva que o site usa de verdade (app.js, `textoLgpd`):
  // ele aparece enquanto `?api=config` não respondeu, e o que vier do servidor
  // toma o lugar dele.
  //
  // Havia aqui duas listas a mais — cursos e turnos — anunciadas como reserva
  // para quando o endpoint estivesse fora do ar. Elas saíram em 13/08/2026 e a
  // ausência é a correção: NENHUMA linha do site as lia, então a promessa do
  // comentário era falsa, e os nomes eram os do sistema anterior (sobre Sheets).
  // Ligá-las hoje gravaria na inscrição um curso que não existe mais — pior que
  // o campo vazio, porque o erro chegaria à secretaria como se fosse escolha do
  // aluno. Curso e fase vêm da coleção `disciplinas`, pelo `?api=config`, e a
  // resposta que não chega tem conserto próprio no site (`renovarConfig`, que
  // pede de novo quando o aluno abre o formulário e avisa na tela se falhar).
  textoLgpdPadrao:
    'Autorizo o uso dos meus dados pessoais para fins de cadastro, matrícula e ' +
    'comunicação sobre o curso, conforme a Lei nº 13.709/2018 (LGPD).',

  contato: {
    email: 'cesutech@unicesusc.edu.br',
    instituicao: 'Unicesusc'
  }
};
