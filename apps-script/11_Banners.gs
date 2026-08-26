/**
 * 11_Banners.gs — a biblioteca de imagens dos projetos.
 *
 * ------------------------------------------------------- Orçamento de leitura
 *
 * Custo no Firestore, por chamada:
 *
 *   listarBanners ... 0 leituras. É Drive puro, e é a função que o painel mais
 *                     chama (toda abertura do seletor de banner).
 *   enviarBanner .... 0 leituras. 1 escrita no Drive e 1 documento de log.
 *   removerBanner ... 2 consultas com teto de BANNERS_MAX_EM_USO documentos cada.
 *                     Quando ninguém usa o banner elas voltam vazias, e o
 *                     Firestore cobra o mínimo de 1 leitura por consulta: 2 no
 *                     total. O pior caso é 2 × BANNERS_MAX_EM_USO.
 *
 * É o arquivo mais barato do sistema porque quase nada aqui é banco: imagem não
 * mora no Firestore, mora no Drive, e o projeto guarda só o endereço dela.
 *
 * ------------------------------------------------------------- As duas fontes
 *
 * Os banners vêm de dois lugares, e isso é proposital:
 *
 *   REPOSITÓRIO  docs/assets/banners/ — servidos pelo GitHub Pages, rápidos e
 *                versionados. É onde ficam os banners oficiais que a instituição
 *                já produziu. O painel os descobre lendo o manifest.json direto
 *                do site, pelo NAVEGADOR (ver Admin.html), e por isso o Apps
 *                Script não precisa de permissão de rede para isso.
 *
 *   DRIVE        para quem não mexe em git. A coordenação sobe a imagem pelo
 *                painel, ela vira pública e o site passa a servi-la do Drive.
 *                É esta metade que este arquivo responde.
 *
 * O campo `banner` do projeto aceita as duas formas:
 *   'r-cidades.jpg'        → resolve para assets/banners/r-cidades.jpg
 *   'https://...'          → usado como está
 *
 * NÃO existe coleção `banners` no Firestore, e isso é decisão, não esquecimento.
 * A pasta do Drive já é a lista: o nome, o tamanho e a data de envio vêm dela
 * prontos. Um espelho no banco seria um segundo lugar para a mesma verdade, com
 * uma escrita por upload para mantê-lo e nenhuma pergunta que ele responda
 * melhor.
 *
 * ---------------------------------------------------- O que mudou do original
 *
 * O sistema sobre Sheets (o sistema anterior, 11_Banners.gs)
 * tinha UM toque em armazenamento, dentro de `removerBanner`:
 *
 *     var emUso = lerTudo(TAB.PROJETOS).filter(function (p) { ... })
 *
 * Ler a aba inteira para procurar uma string custava lá uma chamada à planilha.
 * Aqui custaria uma leitura COBRADA por projeto, toda vez, e a pergunta é
 * pequena: "algum projeto aponta para esta imagem?". Virou consulta filtrada —
 * ver `projetosComBanner_`, que também explica por que são duas e não uma.
 *
 * O resto do arquivo é Drive, e foi portado com a lógica intacta.
 */

var PASTA_BANNERS = 'CESUTECH — banners';
var TAMANHO_MAX_BANNER = 3 * 1024 * 1024;   // 3 MB
var TIPOS_BANNER_ACEITOS = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Quantos projetos a conferência de "banner em uso" traz por consulta.
 *
 * Vinte, contra os ~6 projetos que o CESUTECH abre por semestre: o teto nunca
 * encosta no uso real. Ele existe para o caso degenerado — um valor de `banner`
 * repetido em todos os projetos — não conseguir transformar uma remoção em
 * varredura da coleção. A mensagem avisa quando a lista sai cortada.
 */
var BANNERS_MAX_EM_USO = 20;

// ------------------------------------------------------------ Painel

/**
 * Banners que já foram enviados ao Drive. Chamado por Admin.html:748.
 *
 * `driveListar_` agora pagina até 1.000 arquivos (02b_Drive.gs) e avisa quando
 * cortou. O aviso sobe para a tela porque o modo de falha silencioso é o que
 * enganava: uma galeria curta é indistinguível de uma pasta pequena, e quem não
 * achasse o banner concluiria que ele foi apagado.
 */
function listarBanners(payload) {
  try {
    exigirAdmin(payload && payload.token);

    var arquivos = driveListar_(pastaBanners_());
    var itens = arquivos.map(function (f) {
      return {
        id: f.id,
        nome: f.name,
        url: urlPublicaDrive_(f.id),
        // O Drive devolve `size` em TEXTO, e não devolve campo nenhum para os
        // formatos nativos do Google — daí o `|| 0`, que aqui só aparece se
        // alguém largar um Documento dentro da pasta de banners.
        tamanhoKb: Math.round(Number(f.size || 0) / 1024),
        enviadoEm: dataLegivelDoDrive_(f.createdTime)
      };
    });

    return {
      ok: true,
      itens: itens,
      aviso: arquivos.truncado
        ? 'A pasta tem mais banners do que cabe nesta lista; só os ' + itens.length +
          ' mais recentes aparecem aqui. Apague os que não usa mais no Google Drive.'
        : ''
    };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Recebe a imagem em base64, grava no Drive e libera para leitura pública.
 * Devolve a URL que o site vai usar na tag <img>. Chamado por Admin.html:838.
 */
function enviarBanner(payload) {
  try {
    exigirAdmin(payload && payload.token);

    var nome = String((payload && payload.filename) || 'banner').trim();
    var tipo = String((payload && payload.mimeType) || '').toLowerCase();
    var base64 = String((payload && payload.dataBase64) || '');

    if (TIPOS_BANNER_ACEITOS.indexOf(tipo) === -1) {
      return { ok: false, erro: 'Formato não aceito. Envie JPG, PNG ou WebP.' };
    }
    if (!base64) {
      return { ok: false, erro: 'O arquivo chegou vazio. Tente enviar de novo.' };
    }

    // Medir o TEXTO antes de decodificar. Base64 gasta 4 bytes para cada 3, então
    // o tamanho da string já denuncia o excesso; decodificar um payload absurdo
    // só para medi-lo depois gasta a memória da execução com o que já se sabe
    // que vai ser recusado — e estouro de memória no Apps Script não devolve
    // mensagem de erro, devolve execução morta. A folga de 1 KB cobre o
    // enchimento do base64 e as quebras de linha, se vierem.
    if (base64.length > Math.ceil(TAMANHO_MAX_BANNER * 4 / 3) + 1024) {
      return { ok: false, erro: recusaPorTamanho_(Math.round(base64.length * 3 / 4 / 1024)) };
    }

    var bytes = Utilities.base64Decode(base64);
    if (bytes.length > TAMANHO_MAX_BANNER) {
      return { ok: false, erro: recusaPorTamanho_(Math.round(bytes.length / 1024)) };
    }

    var seguro = nomeSeguroDeBanner_(nome);
    var blob = Utilities.newBlob(bytes, tipo, seguro);
    var arquivo = driveCriarArquivo_(pastaBanners_(), blob, seguro);

    // Sem isto o navegador do aluno recebe 403 na imagem: o arquivo nasce
    // privado, e o site é anônimo.
    driveTornarPublico_(arquivo.id);

    registrar('BANNER_ENVIADO', 'banner', arquivo.id,
      arquivo.name + ' · ' + Math.round(bytes.length / 1024) + ' KB');

    return {
      ok: true,
      id: arquivo.id,
      nome: arquivo.name,
      url: urlPublicaDrive_(arquivo.id),
      tamanhoKb: Math.round(bytes.length / 1024)
    };
  } catch (err) {
    console.error('enviarBanner: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

/**
 * Manda um banner para a lixeira, depois de conferir que ninguém o usa.
 *
 * ATENÇÃO: o Admin.html não tem botão para esta função — nem o desta versão nem
 * o do sistema sobre Sheets, de onde ela veio. Hoje ela só é alcançável pelo
 * editor do Apps Script. Está portada porque a conferência de "em uso" é a regra
 * de negócio que impede um projeto de ficar com a imagem quebrada no site, e
 * escrevê-la depois, sob pressa, é como se perde a conferência.
 */
function removerBanner(payload) {
  try {
    exigirAdmin(payload && payload.token);

    var id = String((payload && payload.id) || '').trim();
    if (!id) return { ok: false, erro: 'Informe qual banner remover.' };

    var emUso = projetosComBanner_(id);
    if (emUso.length) {
      var corte = emUso.length >= BANNERS_MAX_EM_USO
        ? ' (e possivelmente outros — a conferência para em ' + BANNERS_MAX_EM_USO + ')'
        : '';
      return {
        ok: false,
        erro: 'Este banner está em uso por: ' + emUso.join(', ') + corte +
              '. Troque o banner desses projetos antes de removê-lo.'
      };
    }

    driveDescartar_(id);
    registrar('BANNER_REMOVIDO', 'banner', id, '');
    return { ok: true };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

// ------------------------------------------------------------ Internos

/**
 * Nomes dos projetos que apontam para este banner.
 *
 * São DUAS consultas, e não uma, porque `listar` aceita um `fieldFilter` só
 * (02_Repo.gs): alternar entre dois valores do mesmo campo são duas idas ao
 * banco, não um predicado OR. Os dois valores existem porque o campo `banner`
 * do projeto pode guardar as duas formas — o painel grava a URL pública (ver
 * `renderizarGaleria` no Admin.html), e o id cru é o que alguém digita à mão
 * quando mexe no projeto pelo editor. Procurar só pela URL deixaria a segunda
 * forma passar, e apagar um banner em uso quebra a imagem do projeto no site sem
 * avisar ninguém.
 *
 * Sobre índice: o filtro é por `banner` e a ordenação é a padrão do `listar`,
 * por `__name__` ASCENDENTE. Essa combinação é exatamente o que o índice
 * automático de campo único cobre, então NÃO exige índice composto declarado —
 * que é o que aconteceria se aqui se pedisse ordenação por `nome` ou por
 * `ordem`. Não peça.
 */
function projetosComBanner_(id) {
  var nomes = [];
  var vistos = {};

  // PROJETOS_COLECAO vem de 09_Projetos.gs e é lido em tempo de CHAMADA, quando
  // todos os arquivos já foram carregados. Copiar o literal para cá criaria um
  // segundo lugar para o mesmo nome, e a divergência não apareceria: a consulta
  // acharia uma coleção vazia e a remoção passaria a apagar banner em uso.
  [urlPublicaDrive_(id), id].forEach(function (valor) {
    listar(PROJETOS_COLECAO, {
      campo: 'banner',
      valor: valor,
      limite: BANNERS_MAX_EM_USO
    }).itens.forEach(function (p) {
      if (vistos[p._id]) return;
      vistos[p._id] = true;
      nomes.push(p.nome || p._id);
    });
  });

  return nomes;
}

/** Devolve o ID da pasta de banners. */
function pastaBanners_() {
  return drivePasta_('PASTA_BANNERS_ID', PASTA_BANNERS);
}

/**
 * Formato de URL que o Drive serve como imagem embutível. O link normal de
 * compartilhamento devolve a PÁGINA do Drive, não o arquivo — colocá-lo num
 * <img> resulta em imagem quebrada.
 */
function urlPublicaDrive_(id) {
  return 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1600';
}

/** Nome de arquivo previsível: sem acento, sem espaço, sem surpresa. */
function nomeSeguroDeBanner_(nome) {
  var partes = String(nome).split('.');
  var ext = partes.length > 1 ? partes.pop().toLowerCase() : 'jpg';
  var base = normalizarTexto(partes.join('.')).replace(/\s+/g, '-').slice(0, 50) || 'banner';
  return base + '.' + ext;
}

/**
 * `createdTime` do Drive é ISO em UTC. Cortá-lo no minuto, como o sistema sobre
 * Sheets fazia, mostra a hora errada em três horas para quem enviou — e um
 * banner enviado às 21h aparece com a data do dia seguinte. Converter é uma
 * linha, e o resultado é o mesmo formato de `agora()` (01_Utils.gs).
 */
function dataLegivelDoDrive_(iso) {
  if (!iso) return '';
  var data = new Date(iso);
  if (isNaN(data.getTime())) return String(iso).replace('T', ' ').slice(0, 16);
  return Utilities.formatDate(data, APP.timezone, 'yyyy-MM-dd HH:mm');
}

/** Uma recusa por tamanho, escrita uma vez só. */
function recusaPorTamanho_(kb) {
  return 'Imagem maior que 3 MB (' + kb + ' KB). ' +
    'Reduza antes de enviar — banner de site não precisa ser pesado.';
}
