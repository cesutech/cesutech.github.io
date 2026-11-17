# Decisões que explicam o resto

[← README](../README.md)

**O banco é de documentos, e não uma planilha.** A versão anterior deste sistema
guardava as inscrições numa planilha. Ali, impedir que a mesma pessoa se
inscreva duas vezes custa varrer uma coluna inteira dentro de um bloqueio, e
contar inscritos por projeto custa o mesmo. Num banco de documentos, a unicidade
é o próprio identificador do registro — a segunda gravação é recusada pelo
banco, não por uma conferência que pode chegar tarde — e a contagem é feita no
servidor.

**A vaga fecha sob bloqueio.** Contar antes de gravar não basta: duas inscrições
simultâneas contam o mesmo número e as duas passam. A reserva acontece dentro de
uma seção crítica, e é ela que garante que sessenta vagas não viram sessenta e
uma.

**O aluno não precisa de conta.** A inscrição é anônima por desenho, porque exigir
login afastaria justamente quem o programa quer alcançar. Isso tem uma
consequência que atravessa o projeto inteiro: as rotas públicas não sabem quem
está do outro lado. Por isso as que consultam o cadastro ou abrem sessão têm
freio próprio, e a inscrição e a conferência de matrícula conferem o formato
antes de consultar o cadastro. Antes disso, só a configuração é lida, e nas
rotas públicas ela vem de um cache de um minuto: uma enxurrada de requisições
recusadas não vira uma enxurrada de leituras no banco.

**O painel tem mais de uma porta.** Entrar depende de coisas que moram fora do
código — um identificador de aplicativo no console, uma origem autorizada, uma
lista de e-mails. Qualquer uma errada e ninguém entra, inclusive quem
consertaria. Por isso existem caminhos independentes de entrada: nenhum deles
pode ser desligado por quem não tem acesso.

**A trilha diz quem fez.** O painel publicado roda como a conta que o implantou,
e o Apps Script não entrega a identidade de quem está do outro lado — a coluna
**Quem** do Histórico dizia `anonimo` em toda linha. Quem sabe o e-mail é a
sessão, conferida na primeira linha de toda função do painel, e é de lá que o
nome passa a sair: quem exportou o cadastro, quem anulou, quem revisou uma
importação. Os caminhos sem sessão — o formulário do aluno, o backup diário —
continuam anônimos, porque ali não há ninguém a nomear.

**Dois níveis, e o servidor é quem cobra.** Quem tem acesso ao painel é uma
lista (`admin_emails`); quem é **coordenador geral** é outra
(`coordenadores_gerais`), e todo e-mail da primeira que não esteja na segunda é
**professor**: vê e exporta as listas de inscritos e disciplinas, e não remove
projeto, não anula, não promove, não importa lista oficial nem abre
Configurações. A segunda lista **vazia** quer dizer "ninguém separou os níveis
ainda", e nesse estado todo mundo é coordenador geral — é por isso que a mudança
não pediu migração nenhuma. O nível é lido a cada requisição, nunca guardado na
sessão, e é cobrado no **despacho**: o que não estiver na lista do professor é da
coordenação geral, então função nova nasce fechada para ele. A tela esconde e
desabilita o que não é dele, mas a tela nunca é a permissão — há teste de invasão
para cada uma das trinta e uma, chamadas pelo POST direto. O nível **não é porta**:
quem não está em `admin_emails` não entra, esteja onde estiver. E a lista nunca
fica sem nenhum coordenador geral: um painel de oito professores é tão trancado
por fora quanto uma lista de acesso vazia.

**Exportar o CSV continua sendo dos dois níveis.** É decisão tomada e sabida: o
professor exporta a lista inteira de alunos, com nome, CPF, e-mail, telefone e
nascimento. Os dois níveis resolvem o clique errado, não a cópia — e a linha
`EXPORTACAO` na trilha agora diz qual professor exportou.

**Nada de dado pessoal no repositório.** As amostras usadas nos testes são
sintéticas. O formato reproduz o do relatório da secretaria; os nomes, as
matrículas e os telefones são inventados.
