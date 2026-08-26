/**
 * CESUTECH — Cadastro e Gestão de Alunos
 * 00_Config.gs — constantes, schema das abas e parâmetros do sistema.
 *
 * O Google Sheets é o banco. Cada aba é uma "tabela" e o schema abaixo é a
 * definição dela: a ordem das chaves é a ordem das colunas na planilha.
 */

var APP = {
  nome: 'CESUTECH — Cadastro de Alunos',
  versao: '0.1.0',
  timezone: 'America/Sao_Paulo'
};

/** Nomes das abas (tabelas). */
var TAB = {
  PROJETOS: 'Projetos',
  INSCRICOES: 'Inscricoes',
  MATRICULADOS: 'Matriculados',
  ALUNOS: 'Alunos',
  LOTES: 'Lotes',
  LOG: 'Log',
  CONFIG: 'Config'
};

/**
 * Schema de cada tabela. `key` vira o nome da propriedade nos objetos que o
 * Repo devolve; `label` é o cabeçalho humano gravado na linha 1.
 */
var SCHEMA = {};

/**
 * Um projeto de extensão do CESUTECH. Cada um tem professor responsável e
 * limite de vagas — hoje o limite é uma frase no formulário pedindo ao aluno
 * que se autopolicie; aqui ele é conferido no servidor.
 */
SCHEMA[TAB.PROJETOS] = [
  { key: 'id', label: 'ID' },
  { key: 'codigo', label: 'Código' },
  { key: 'nome', label: 'Nome do projeto' },
  { key: 'descricao', label: 'Descrição' },
  { key: 'professor', label: 'Professor responsável' },
  { key: 'banner', label: 'Banner (arquivo)' },
  { key: 'email_professor', label: 'E-mail do professor' },
  { key: 'vagas', label: 'Vagas' },
  { key: 'local', label: 'Local' },
  { key: 'horario', label: 'Horário' },
  { key: 'primeiro_encontro', label: 'Primeiro encontro' },
  { key: 'ativo', label: 'Ativo' },
  { key: 'inscricoes_abertas', label: 'Inscrições abertas' },
  { key: 'validar_matricula', label: 'Validar matrícula' },
  { key: 'ordem', label: 'Ordem' },
  { key: 'criado_em', label: 'Criado em' },
  { key: 'atualizado_em', label: 'Atualizado em' },
  { key: 'criado_por', label: 'Criado por' }
];

/**
 * Campos espelhados do formulário de inscrição em papel que estes projetos já
 * usavam — é dele que vem a ordem das colunas, e manter a ordem é o que permite
 * conferir a tela contra a folha sem procurar campo.
 * A chave do aluno é a MATRÍCULA, não o CPF: é institucional, estável e não é
 * dado sensível. CPF fica como campo opcional, para o caso de projeto aberto à
 * comunidade, onde não existe matrícula.
 */
SCHEMA[TAB.INSCRICOES] = [
  { key: 'id', label: 'ID' },
  { key: 'criado_em', label: 'Recebido em' },
  { key: 'origem', label: 'Origem' },
  { key: 'projeto_id', label: 'Projeto (ID)' },
  { key: 'projeto_nome', label: 'Projeto' },
  { key: 'matricula', label: 'Matrícula' },
  { key: 'matricula_conferida', label: 'Matrícula conferida' },
  { key: 'nome', label: 'Nome completo' },
  { key: 'email', label: 'E-mail' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'curso_fase', label: 'Curso e fase' },
  { key: 'cpf', label: 'CPF' },
  { key: 'data_nascimento', label: 'Data de nascimento' },
  { key: 'observacoes', label: 'Observações' },
  { key: 'declara_ciencia', label: 'Declara ciência' },
  { key: 'autoriza_imagem', label: 'Autoriza imagem e voz' },
  { key: 'consentimento_lgpd', label: 'Consentimento LGPD' },
  { key: 'hash_dedup', label: 'Hash (dedup)' },
  { key: 'raw_json', label: 'Payload original' }
];

SCHEMA[TAB.MATRICULADOS] = [
  { key: 'id', label: 'ID' },
  { key: 'lote_id', label: 'Lote' },
  { key: 'importado_em', label: 'Importado em' },
  { key: 'importado_por', label: 'Importado por' },
  { key: 'nome', label: 'Nome completo' },
  { key: 'cpf', label: 'CPF' },
  { key: 'email', label: 'E-mail' },
  { key: 'matricula', label: 'Matrícula' },
  { key: 'telefone', label: 'Telefone' },
  { key: 'data_nascimento', label: 'Data de nascimento' },
  { key: 'curso', label: 'Curso' },
  { key: 'turma', label: 'Turma' },
  { key: 'situacao', label: 'Situação' },
  { key: 'raw_json', label: 'Linha original' }
];

SCHEMA[TAB.ALUNOS] = [
  { key: 'id', label: 'ID' },
  { key: 'cpf', label: 'CPF' },
  { key: 'nome', label: 'Nome completo' },
  { key: 'email', label: 'E-mail' },
  { key: 'telefone', label: 'Telefone' },
  { key: 'data_nascimento', label: 'Data de nascimento' },
  { key: 'matricula', label: 'Matrícula' },
  { key: 'matricula_conferida', label: 'Matrícula conferida' },
  { key: 'projeto', label: 'Projeto' },
  { key: 'curso', label: 'Curso' },
  { key: 'turma', label: 'Turma' },
  { key: 'situacao', label: 'Situação' },
  { key: 'status', label: 'Status reconciliação' },
  { key: 'metodo_match', label: 'Método do match' },
  { key: 'score_match', label: 'Score' },
  { key: 'inscricao_id', label: 'ID inscrição' },
  { key: 'matricula_id', label: 'ID matrícula' },
  { key: 'revisado_por', label: 'Revisado por' },
  { key: 'revisado_em', label: 'Revisado em' },
  { key: 'observacoes', label: 'Observações' },
  { key: 'atualizado_em', label: 'Atualizado em' }
];

SCHEMA[TAB.LOTES] = [
  { key: 'lote_id', label: 'Lote' },
  { key: 'arquivo', label: 'Arquivo' },
  { key: 'tipo', label: 'Tipo' },
  { key: 'linhas', label: 'Linhas importadas' },
  { key: 'importado_em', label: 'Importado em' },
  { key: 'importado_por', label: 'Importado por' },
  { key: 'mapeamento_json', label: 'Mapeamento de colunas' },
  { key: 'status', label: 'Status' }
];

SCHEMA[TAB.LOG] = [
  { key: 'timestamp', label: 'Quando' },
  { key: 'usuario', label: 'Quem' },
  { key: 'acao', label: 'Ação' },
  { key: 'entidade', label: 'Entidade' },
  { key: 'entidade_id', label: 'ID' },
  { key: 'detalhe', label: 'Detalhe' }
];

SCHEMA[TAB.CONFIG] = [
  { key: 'chave', label: 'Chave' },
  { key: 'valor', label: 'Valor' },
  { key: 'descricao', label: 'Descrição' }
];

/** Estados possíveis da reconciliação inscrição × lista oficial. */
var STATUS = {
  CONFIRMADO: 'CONFIRMADO',
  SO_INSCRITO: 'SO_INSCRITO',
  SO_MATRICULADO: 'SO_MATRICULADO',
  DIVERGENCIA: 'DIVERGENCIA'
};

var STATUS_LABEL = {
  CONFIRMADO: 'Confirmado',
  SO_INSCRITO: 'Só inscrito',
  SO_MATRICULADO: 'Só matriculado',
  DIVERGENCIA: 'Divergência'
};

/** Configuração default, gravada na aba Config no primeiro setup. */
var CONFIG_PADRAO = [
  { chave: 'admin_emails', valor: '', descricao: 'E-mails autorizados no painel, separados por vírgula. É a lista que vale para as DUAS portas: o botão "Entrar com o Google" e o link por e-mail. Lista vazia = ninguém entra; a saída é rodar liberarAcesso("email") no editor do Apps Script.' },
  { chave: 'url_painel', valor: 'https://cesutech.github.io/painel/', descricao: 'Endereço do painel. Serve para montar o link de acesso enviado por e-mail. Muda quando o repositório trocar de casa (para cesutech.github.io) — e é config, e não código, justamente para essa troca não exigir reimplantar o Apps Script.' },
  { chave: 'url_exec', valor: '', descricao: 'Endereço /exec desta implantação, e SÓ para o gatilho que mantém a instância acordada (08_Api.gs). Deixe VAZIA: o sistema descobre o endereço sozinho por ScriptApp.getService().getUrl(). Ela existe para o caso em que o que vem de lá não é o /exec público — um endereço terminado em /dev, ou a forma /a/macros/<domínio>/, que pedem sessão do Google e fariam o ping anônimo receber uma tela de login em vez de acordar o sistema. Preencha com o MESMO endereço que o site usa (docs/assets/config.js, chave endpoint); rodar instalarGatilhoAquecimento() no editor diz se é preciso.' },
  { chave: 'form_id', valor: '', descricao: 'ID do Google Forms de inscrição (opcional — só se quiser manter o Forms atual).' },
  { chave: 'cadastro_aberto', valor: 'SIM', descricao: 'SIM/NAO — controla se o formulário público aceita novas inscrições.' },
  { chave: 'cursos_fases', valor: [
      'WORK EXPERIENCE - ADM21', 'WORK EXPERIENCE - ADM31', 'WORK EXPERIENCE - ADM41', 'WORK EXPERIENCE - ADM51',
      'PRÁTICA INTERDISCIPLINAR EXTENSIONISTA I - ADS11', 'PRÁTICA INTERDISCIPLINAR EXTENSIONISTA II - ADS21',
      'PRÁTICA INTERDISCIPLINAR EXTENSIONISTA III - ADS31', 'PRÁTICA INTERDISCIPLINAR IV - ADS41',
      'PROJETO INTERDISCIPLINAR II - AU71', 'PROJETO INTERDISCIPLINAR IV - AU91',
      'PRÁTICA INTERDISCIPLINAR I - MKT21', 'PRÁTICA INTERDISCIPLINAR II - MKT31',
      'PROJETO INTERDISCIPLINAR II EM MULTIMÍDIA - PMM31'
    ].join('|'), descricao: 'Opções de "Curso e fase", separadas por |. Extraídas do formulário atual do CESUTECH.' },
  { chave: 'vagas_padrao', valor: '60', descricao: 'Vagas sugeridas ao criar um projeto novo. 0 = ilimitado.' },
  { chave: 'modo_validacao_matricula', valor: 'BLOQUEAR', descricao: 'O que fazer quando o projeto valida matrícula e ela não está na lista: BLOQUEAR (recusa) ou AVISAR (aceita e marca como não conferida). Ligar/desligar é por projeto. Sem lista importada, nunca bloqueia.' },
  { chave: 'limite_consultas_matricula_hora', valor: '5000', descricao: 'Teto de consultas de matrícula por hora. Cada aluno consome 1 a 3 (erra e corrige). Num evento com 500 alunos, 300 acabaria nos primeiros minutos e a conferência pararia de funcionar.' },
  { chave: 'exigir_matricula', valor: 'SIM', descricao: 'SIM/NAO — matrícula é a chave do aluno. Desligue só para projeto aberto à comunidade.' },
  { chave: 'exigir_cpf', valor: 'NAO', descricao: 'SIM/NAO — o formulário do CESUTECH não pede CPF; a chave é a matrícula.' },
  { chave: 'aluno_projeto_unico', valor: 'NAO', descricao: 'SIM impede o mesmo aluno de se inscrever em mais de um projeto. NAO apenas sinaliza no painel.' },
  { chave: 'texto_declaracao', valor: 'Declaro que recebi informações sobre as Atividades de Curricularização da Extensão e desejo participar deste projeto.', descricao: 'Texto da declaração de ciência, obrigatória na inscrição.' },
  { chave: 'texto_imagem', valor: 'Autorizo o uso de minha imagem e voz para fins de registro, avaliação e divulgação acadêmica das Atividades de Curricularização da Extensão (ACE), resguardados meus direitos de imagem e o estrito cumprimento da LGPD e das diretrizes éticas do UNICESUSC.', descricao: 'Texto da autorização de imagem e voz (opcional para o aluno).' },
  { chave: 'texto_esgotado', valor: 'Inscrições esgotadas. Escolha outro projeto de extensão disponível.', descricao: 'Mensagem exibida no lugar do botão quando o projeto lota.' },
  { chave: 'texto_lgpd', valor: 'Autorizo o uso dos meus dados pessoais para fins de cadastro, matrícula e comunicação sobre o curso, conforme a Lei nº 13.709/2018 (LGPD).', descricao: 'Texto do aviso de privacidade exibido no formulário.' },
  { chave: 'limite_inscricoes_hora', valor: '2000', descricao: 'Teto de inscrições por hora. Freio de último recurso contra envio automatizado — quem barra robô de verdade é o honeypot e o tempo mínimo de preenchimento. 60 era paranoia e 600 ficou apertado: um teste de carga com 500 envios mais retentativas encostou no teto. 2000 dá folga para o evento do auditório.' },
  { chave: 'vagas_excedentes_em_espera', valor: 'NAO', descricao: 'SIM faz quem chega depois da última vaga entrar em LISTA DE ESPERA em vez de levar "esgotado": a inscrição é gravada, marcada, e NÃO conta como vaga ocupada. NAO (padrão) é o comportamento de sempre — passou das vagas, recusa. Vale só para o esgotado: projeto fechado ou inativo continua recusando. Com SIM, cada projeto passa a custar DUAS agregações por contagem em vez de uma.' },
  { chave: 'texto_espera', valor: 'Inscrição registrada! Você entrou na lista de espera deste projeto: as vagas previstas já foram preenchidas, e a coordenação do CESUTECH vai confirmar a sua participação. Guarde o protocolo abaixo.', descricao: 'Mensagem que o aluno lê quando entra na lista de espera (vagas_excedentes_em_espera=SIM). Ele ESTÁ inscrito, e é isso que a frase precisa dizer primeiro — quem lê "esgotado" vai embora do auditório.' },
  { chave: 'contar_ocupacao_na_lista', valor: 'SIM', descricao: 'CHAVE DE DIAGNÓSTICO, para uso curto e supervisionado. SIM (padrão) é o comportamento de sempre. NAO faz a LISTA de projetos parar de contar quantos já se inscreveram: a rota deixa de fazer uma agregação por projeto e responde sem a ocupação, para medir quanto do tempo de carregamento é a contagem. A INSCRIÇÃO NÃO É AFETADA — reservarVaga continua contando dentro do lock e continua recusando quem chega em projeto cheio, com a mesma mensagem de esgotado; o que se desliga é o número MOSTRADO, nunca a decisão sobre a vaga. Com NAO o site mostra o total de vagas sem a ocupação e sem a barra (nunca "0 / 60"), e o projeto lotado aparece como aberto até o aluno enviar — quem recusa é o servidor, no envio. O painel também fica sem o número, e diz isso na tela. A rota tem cache de 30s: ligar e desligar leva até meio minuto para aparecer.' },
  { chave: 'backup_dias', valor: '15', descricao: 'Por quantos dias os backups diários ficam guardados no Drive (14_Backup.gs). Passado esse prazo o arquivo vai para a lixeira — e é também o prazo em que uma cópia do nome, matrícula, e-mail e telefone de todo mundo deixa de existir por lá. O mais recente NUNCA é apagado, mesmo mais velho que a janela. Campo vazio, zero, negativo ou texto NÃO recicla nada e diz por quê no log: apagar por suposição é o que este número existe para evitar.' },
  { chave: 'backup_ligado', valor: 'SIM', descricao: 'SIM/NAO — desliga o backup diário sem mexer no acionador, que é o jeito reversível de pausar (quem apaga o gatilho precisa lembrar de reinstalá-lo, e ninguém lembra). Em NAO nada é gravado E nada é reciclado: o sistema para de fazer cópias, não passa a apagar as que tem. Qualquer valor que não seja um NAO explícito mantém o backup ligado.' }
];

/**
 * Sinônimos usados para adivinhar o mapeamento de colunas de planilhas
 * importadas e de perguntas do Google Forms. Comparação é feita sobre o texto
 * normalizado (minúsculo, sem acento, sem pontuação).
 */
var SINONIMOS = {
  matricula: ['matricula', 'n matricula', 'numero de matricula', 'ra', 'registro academico', 'codigo do aluno', 'matricula do aluno'],
  nome: ['nome', 'nome completo', 'aluno', 'nome do aluno', 'nome aluno', 'estudante', 'participante', 'nome do estudante'],
  whatsapp: ['whatsapp', 'whats', 'celular whatsapp', 'seu whatsapp'],
  curso_fase: ['curso e fase', 'curso fase', 'curso e semestre', 'disciplina', 'curso e turma'],
  cpf: ['cpf', 'cpf do aluno', 'documento', 'cpf n', 'n cpf', 'cpf numero'],
  email: ['email', 'e mail', 'e-mail', 'endereco de email', 'email do aluno', 'correio eletronico', 'endereco de e mail'],
  telefone: ['telefone', 'celular', 'fone', 'whatsapp', 'contato', 'telefone celular', 'tel'],
  data_nascimento: ['data de nascimento', 'nascimento', 'dt nascimento', 'data nasc', 'nascido em', 'data de nasc'],
  curso: ['curso', 'curso pretendido', 'curso desejado', 'modulo', 'oficina', 'turma curso'],
  turma: ['turma', 'classe', 'grupo', 'turno turma', 'disciplina', 'codigo da turma'],
  turno: ['turno', 'periodo', 'horario'],
  escolaridade: ['escolaridade', 'nivel de ensino', 'grau de instrucao', 'formacao'],
  situacao: ['situacao', 'status', 'situacao matricula', 'condicao'],
  observacoes: ['observacoes', 'observacao', 'obs', 'comentarios']
};
