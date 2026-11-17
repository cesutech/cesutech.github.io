# Dois níveis de acesso ao painel

[← README](../README.md)

Quem entra no painel é **Coordenador geral** ou **Professor**. O nível mora numa
segunda chave de configuração, `coordenadores_gerais`: todo e-mail de
`admin_emails` que não estiver nela é Professor. **Campo vazio quer dizer que
ninguém separou os níveis ainda, e nesse estado todos são coordenadores
gerais** — é o sistema como ele era antes desta divisão existir, e é por isso que
implantá-la não muda nada para ninguém até alguém promover ou rebaixar a
primeira pessoa.

O nível nunca é porta: um e-mail que esteja em `coordenadores_gerais` e não
esteja em `admin_emails` não vale nada. Quem entra continua sendo decidido só
pela lista de acesso.

**O que o Professor pode**, e é a maior parte do painel:

- as abas **Painel**, **Geral**, **Projetos**, **Disciplinas** e **Alunos**,
  inteiras para ler — inclusive a ficha de cada aluno, a lista de inscritos de
  cada projeto e a de matriculados de cada turma;
- **exportar**: o Excel e o PDF das janelas de inscritos e de turma, e o
  **CSV completo da aba Alunos**. O CSV leva nome, CPF, e-mail, telefone e data
  de nascimento de até cinco mil alunos, e isso é decisão tomada e sabida: os
  dois níveis resolvem o clique errado, não a cópia. Cada exportação deixa uma
  linha `EXPORTACAO` no Histórico, com o e-mail de quem a fez;
- marcar linhas no Geral e ver a contagem — é com ela que ele pede uma anulação
  a quem coordena.

**O que é da coordenação geral:** remover e editar projeto, anular e promover no
Geral, criar e editar disciplina, editar a ficha do aluno, incluir aluno,
importar a lista oficial, revisar e apagar importação, reconciliar, mexer em
Configurações e mexer na própria lista de acesso.

Na tela isso aparece de dois jeitos, e a regra é uma frase: **o painel esconde
destino e desabilita ação.** As quatro abas cujo conteúdo não é do Professor —
Importar lista oficial, Importações, Histórico e Configurações — **somem da
fita**, porque aba que só sabe recusar é porta pintada na parede. Os botões
pontuais que vivem dentro das telas que ele usa **ficam na tela,
desabilitados**, com o rótulo de sempre e uma frase dizendo de quem a ação é
("Remover projeto é da coordenação geral."): botão que some faz a pessoa
concluir que o sistema quebrou.

**A tela nunca é a permissão.** Quem recusa é o servidor, em toda requisição, e
um POST montado à mão no console do navegador recebe a mesma recusa que o botão
desabilitado não chega a mandar. Há um grupo inteiro de testes que entra por
esse caminho e não clica em nada.

A gestão fica em **Configurações › Quem tem acesso ao painel**, na mesma tabela
onde o e-mail entra e sai. Quem é incluído **nasce Professor** — promover é um
segundo gesto, com confirmação própria, porque padrão que se escolhe com pressa
não é padrão. **Mudar o nível de alguém encerra a sessão dessa pessoa na hora**,
como remover: sem isso a tela dela continuaria errada por até oito horas. E a
lista **nunca fica sem nenhum coordenador geral** — um painel com oito
professores é tão trancado por fora quanto um painel sem ninguém na lista de
acesso, e a saída seria a mesma: o editor do Apps Script.
