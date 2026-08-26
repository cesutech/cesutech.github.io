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

**Nada de dado pessoal no repositório.** As amostras usadas nos testes são
sintéticas. O formato reproduz o do relatório da secretaria; os nomes, as
matrículas e os telefones são inventados.

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
