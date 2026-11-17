# Um projeto por aluno, e a troca

[← README](../README.md)

A regra é opcional e vive numa chave: **`aluno_projeto_unico`**, na aba
Configurações. O padrão é **NAO**, e em NAO a **regra** não muda nada — as duas
portas apenas avisam que a pessoa já está em outro projeto, como sempre fizeram.
(Publicar o código, esse sim, muda cinco coisas com a chave em NAO: está no fim
deste guia.) Em **SIM**, cada matrícula participa de **um projeto ativo por
semestre**, e a regra vale nas **duas portas**:

**No formulário do aluno**, quem já está em outro projeto não é recusado: o site
pergunta, e a confirmação **troca** — a inscrição anterior é cancelada e a nova
nasce no lugar, tudo numa escrita só (ou entra inteira, ou não entra). Três
condições para a troca acontecer: o **e-mail** do envio tem de ser o mesmo da
inscrição anterior (é a prova de posse; divergiu, a recusa não diz sequer o nome
do projeto), a inscrição anterior **não** pode ter sido feita pela coordenação
(essa é migrada por Alunos → Editar → Projeto) e o projeto novo tem de ter
**vaga na hora de confirmar** — sem vaga, nada muda e a anterior continua
valendo. Matrícula cancelada na lista oficial não troca; ela é mandada à
coordenação.

**No painel, em Incluir aluno**, incluir quem já está em outro projeto passa a
**perguntar** antes de gravar — e a coordenação inclui do mesmo jeito se
confirmar. A porta da coordenação nunca é barrada (é a régua da janela, do teto
e do anti-abuso); o que ela não pode é criar duplicidades novas caladas depois
de a chave ser virada.

**O que a troca deixa para trás.** A inscrição cancelada vai para a quarentena,
com o motivo `TROCA` e um ponteiro para o protocolo novo — é o Desfazer da aba
Geral que a traz de volta, e ele **recusa** devolvê-la se a pessoa já estiver em
outro projeto ativo. O protocolo do aluno MUDA na troca: o antigo morre, e a
recepção não o acha mais pela tela. A inscrição nova aparece no Geral com o selo
**"trocou de projeto"**; a que a coordenação incluiu à mão, com **"incluída pela
coordenação"**.

**A lembrança do site é por navegador.** O aluno que trocou de projeto noutro
aparelho continua vendo "você já está inscrito em X" no aparelho antigo — o site
diz isso na tela. É o desenho: a lembrança é local, e o que vale é o banco.

**Migrar pelo painel não é a mesma coisa que trocar.** Alunos → Editar → Projeto
move a inscrição — mesmo documento, endereço novo — e, de propósito, **estoura o
teto** do projeto de destino (a coordenação decide, vendo a ocupação no select) e
**não deixa cópia na quarentena** (não houve cancelamento). Só a atomicidade é
igual nas duas.

## Antes de virar a chave para SIM

1. **Medir o `:commit` misto contra o banco de verdade**: rodar
   `provaCommitMisto()` pelo editor do Apps Script (`20_Prova.gs`, ao lado das
   outras provas). Copiar + apagar + criar com `exists:false` aplica os três;
   com o id novo já ocupado, o commit inteiro volta ALREADY_EXISTS e nada é
   aplicado. Se o banco divergir do que o falso dos testes imita, corrigem-se o
   falso e a primitiva — nunca o contrário.
2. **Pré-voo nas matrículas já gravadas**: varrer as inscrições (o backup do dia
   serve) por matrícula diferente da normalizada (zero à esquerda gravado antes
   do corte) ou de tamanho diferente de `matricula_digitos`. Sem isso a regra
   passa por baixo, em silêncio, exatamente na base existente.
3. **Projetos do semestre passado em `ativo=NAO`** — a regra só olha projeto
   ativo.
4. **A lista de quem está em 2+ projetos nas mãos da coordenação.** A regra é só
   para frente: ninguém é migrado nem apagado por script, e quem escolhe qual
   fica é o professor. A reconciliação já mostra a lista; entram nela também as
   inscrições que a revisão apontou **sem a matrícula** (casadas por e-mail, CPF
   ou nome), porque para a regra elas são invisíveis.
5. **Homologação com duas abas**: duas primeiras inscrições ao mesmo tempo, e uma
   troca confirmada nas duas.
6. **Virar a chave pela tela de Configurações.** É o último passo, e é o único
   que liga a regra — mas não é o único que muda alguma coisa: o que vem logo
   abaixo já vale desde a publicação.

## O que muda ao publicar, mesmo com a chave em NAO

Estas coisas não dependem da chave, e valem a partir do deploy:

1. **Promover da fila passa a recusar a corrida em vez de sobrescrever calado.**
   Vale nas duas portas que promovem — a aba **Geral** (lote de até 200) e
   **Incluir aluno** (uma). Cada escrita leva a versão que o SERVIDOR acabou de
   ler, ao montar a promoção (a tela manda só os ids, como sempre mandou); se
   qualquer inscrição do lote mudou entre essa leitura e a gravação (outra aba
   editou, a coordenação anulou, o aluno trocou de projeto), o banco recusa o
   lote **inteiro**,
   **ninguém** é promovido, e a resposta manda recarregar: *"a lista da tela é
   de antes"* na aba Geral, *"a ficha é de antes"* no Incluir. Antes, a
   promoção gravava por cima do que tivesse mudado. O preço é dito: um lote de
   200 volta inteiro quando **uma** das 200 mudou — clicar de novo depois de
   recarregar é mais barato do que promover por cima.
2. **Alunos → Editar → Projeto move a inscrição num `:commit` só.** Eram duas
   requisições (criar no endereço novo, apagar o velho) e uma janela entre elas
   em que a inscrição existia nos dois lugares; agora é uma, tudo ou nada. Se o
   endereço novo já estiver ocupado, a edição é recusada e o documento velho
   **continua vivo**.
3. **A aba Geral mostra a procedência de cada inscrição** — o selo de quem foi
   incluído pela coordenação (`incluido_por`) e, quando houver, o de quem veio
   de uma troca (`trocada_de`, que só nasce com a chave em SIM).
4. **O aviso de vaga perdida diz QUAL das três coisas aconteceu.** É texto que
   todo aluno lê, inclusive com a regra desligada: o título passa de duas
   aberturas para três — *o projeto ficou sem vaga* (esgotou), *este projeto não
   recebe mais inscrições* (a coordenação fechou as inscrições dele) e *este
   projeto saiu da lista* (foi inativado) —, e deixa de repetir a frase que vem
   logo abaixo.
5. **Toda recusa de escrita sai sem o caminho do documento.** As mensagens que
   vinham do banco carregavam `projects/<projeto>/databases/...`; agora passam
   pela mesma régua do resto do sistema antes de virar tela, resposta ou log.

Com a chave em **SIM** é que entra a regra em si: a pergunta e a troca no
formulário do aluno, a pergunta antes de gravar no Incluir aluno, a recusa da
troca para quem tem matrícula cancelada ou inscrição feita pela coordenação, e a
guarda da restauração no Geral.

**Regra operacional, com a chave em SIM:** não rode a **Revisão de divergências**
com a janela de inscrição aberta. Entre a releitura e o apaga da revisão passam
segundos a minutos, e é essa janela que faz a troca de um aluno e a anulação da
coordenação se atropelarem — o aluno fica correto nos dois sentidos, mas a
trilha de quem anulou o quê se perde (ela sobrevive no Histórico, na linha
`INSCRICAO_TROCADA`).
