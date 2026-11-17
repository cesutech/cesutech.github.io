# A lista oficial ao longo do semestre

[← README](../README.md)

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
inscrição aberta — ver [Um projeto por aluno, e a troca](um-projeto-por-aluno.md).

Um Aplicar que morre ou é recusado depois de já ter anulado ou excluído alguém
deixa trilha: a linha `LOTE_REVISADO_PARCIAL` no Histórico com as matrículas
por ação, a marca "revisão interrompida" no lote, e a resposta na tela diz de
quem era cada inscrição anulada — é por ela que se sabe quem reincluir.

**Apagar matriculados** é a vassoura entre semestres: tira do banco uma lista
antiga inteira, lote a lote. O rito da virada de semestre é importar TODAS as
listas do semestre novo, revisar lote a lote, e só então apagar os lotes do
semestre anterior — revisar antes de importar as outras turmas apontaria como
"não veio" quem só mudou de turma (a tela avisa, mas não bloqueia).
