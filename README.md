# CESUTECH — inscrição em projetos de extensão

Sistema de inscrição e gestão de alunos dos projetos de extensão do CESUTECH,
do Centro Universitário CESUSC.

O aluno abre o site, escolhe um projeto, confere a matrícula e se inscreve. A
coordenação acompanha as vagas, importa a lista oficial da secretaria e concilia
inscrição com matrícula por um painel de gestão.

---

## Como ele é feito

| Camada | Tecnologia |
| --- | --- |
| Interface do aluno e painel de gestão | HTML, CSS e JavaScript, sem framework |
| Hospedagem do site | GitHub Pages (conteúdo estático) |
| Lógica de servidor | Google Apps Script |
| Banco de dados | Cloud Firestore, acessado por API REST |
| Autenticação do painel | Google Identity Services e link de acesso por e-mail |
| Testes | Node.js, sem dependências externas |

Tudo dentro da camada gratuita. Não há servidor para manter, conta de serviço,
chave guardada nem cartão de crédito envolvido — o acesso ao banco usa o token
da própria execução.

---

## Decisões que explicam o resto

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
está do outro lado, então cada uma tem freio próprio e conferência de formato
antes de qualquer consulta ao banco.

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

**Nada de dado pessoal no repositório.** As amostras usadas nos testes são
sintéticas. O formato reproduz o do relatório da secretaria; os nomes, as
matrículas e os telefones são inventados.

---

## Um projeto por aluno, e a troca

A regra é opcional e vive numa chave: **`aluno_projeto_unico`**, na aba
Configurações. O padrão é **NAO**, e em NAO a **regra** não muda nada — as duas
portas apenas avisam que a pessoa já está em outro projeto, como sempre fizeram.
(Publicar o código, esse sim, muda três coisas com a chave em NAO: está no fim
desta seção.) Em **SIM**, cada matrícula participa de **um projeto ativo por
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

### Antes de virar a chave para SIM

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

### O que muda ao publicar, mesmo com a chave em NAO

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

---

## A lista oficial ao longo do semestre

Importar nunca apaga: quem sumiu do relatório novo continua na lista oficial.
Isso é deliberado — descobrir "quem ficou de fora" custaria ler a coleção
inteira a cada importação —, e por isso existem duas ferramentas separadas
para tirar alguém:

**Revisar** é o bisturi dentro do semestre. A secretaria emite um relatório
por turma, e o lote guarda essa turma (lida do cabeçalho do arquivo e conferida
no campo "Turma do relatório", no passo 2 da importação). Ao fim de cada
importação, e pelo botão **Revisar** da aba Importações, o sistema lista quem
estava no banco como aquela turma e não veio no arquivo — quem veio em outra
lista deste semestre e quem já está cancelado aparecem à parte, sem ação. Para
cada um se decide **Manter**, **Cancelar** (a matrícula some do formulário e
das listas; volta sozinha se a secretaria a reenviar) ou **Excluir** (sai do
banco, com cópia em `matriculados_excluidos`; só para quem nunca deveria ter
entrado). Cancelar e Excluir sempre anulam as inscrições da pessoa: a vaga é
liberada, e a inscrição fica na quarentena do Geral. Quem já está cancelado
não sofre ação nenhuma — a inscrição que ele tiver ganhado depois da marca
(pelo formulário de um projeto sem conferência, ou por Alunos → Incluir aluno,
que avisa) é deliberada, e tirá-la é pelo Geral.

A revisão anula **só a inscrição que traz a matrícula da pessoa**. A que o
cruzamento de Alunos ligou a ela por e-mail, CPF ou nome aparece na linha como
informação ("possível inscrição sem esta matrícula em … — confira no Geral") e
não é tocada: nome casa homônimo e e-mail casa conta de família, e anular é
destrutivo — a vaga vai para o próximo da fila, e quem não está na lista não
volta por "Incluir aluno". A coordenação confere e, se for mesmo a pessoa,
anula pelo Geral. Fica de fora até disso a inscrição que o cruzamento não
ligou a ninguém — a segunda da mesma pessoa, sem matrícula, quando a primeira
tinha, ou a feita depois do último cruzamento: ela só é vista no cruzamento
seguinte, e aí aparece em Alunos como cancelada com projeto. Depois de aplicar,
**Alunos → Atualizar** refaz o cruzamento.

Com `aluno_projeto_unico` em **SIM**, a revisão não deve rodar com a janela de
inscrição aberta — ver "Um projeto por aluno, e a troca", acima.

Um Aplicar que morre ou é recusado depois de já ter anulado ou excluído alguém
deixa trilha: a linha `LOTE_REVISADO_PARCIAL` no Histórico com as matrículas
por ação, a marca "revisão interrompida" no lote, e a resposta na tela diz de
quem era cada inscrição anulada — é por ela que se sabe quem reincluir.

**Apagar matriculados** é a vassoura entre semestres: tira do banco uma lista
antiga inteira, lote a lote. O rito da virada de semestre é importar TODAS as
listas do semestre novo, revisar lote a lote, e só então apagar os lotes do
semestre anterior — revisar antes de importar as outras turmas apontaria como
"não veio" quem só mudou de turma (a tela avisa, mas não bloqueia).

---

## Organização

```
apps-script/   a lógica de servidor e o acesso ao banco
docs/          o site publicado — formulário do aluno e painel de gestão
testes/        a suíte automatizada
```

O código é comentado em português, e os comentários explicam **por que** cada
decisão foi tomada — não o que a linha faz. Quem for mexer aqui depois vai
querer saber o motivo, não a tradução.

---

## Rodando os testes

```
npm test
```

Mais de mil testes, e nenhum precisa de rede, credencial ou conta Google: eles
carregam o código num ambiente isolado, com um banco falso em memória. Rodam em
alguns segundos.

Há um arquivo dedicado a atacar o próprio sistema — ele exercita as recusas do
controle de acesso, os limites das rotas públicas e as formas de alguém se
trancar do lado de fora. Testar que algo funciona é metade do trabalho; a outra
metade é testar que ele recusa.

---

## Licença

MIT. Use, estude, adapte.
