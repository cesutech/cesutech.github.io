# Configurar o ambiente do zero

[← README](../README.md)

Este guia monta o sistema numa conta Google e num repositório novos. Para
publicar uma versão nova num ambiente que já existe, o guia é outro:
[Publicar o servidor](publicar-o-servidor.md).

## O que é preciso

- **Uma conta Google que vai implantar o web app.** O web app roda com ela
  (`executeAs: USER_DEPLOYING`, no `appsscript.json`): o banco é lido e gravado
  com o token dela, e o Drive dela guarda os banners, os temporários da
  importação e os backups. Trocar essa conta depois é trocar tudo isso junto.
- **Node 20**, para os testes e para o clasp 3.3.0
  (`npx @google/clasp@3.3.0 ...`).
- **Um repositório no GitHub**, com o GitHub Pages.

## 1. O banco: Firebase e Firestore

1. Com a conta que vai implantar, crie um projeto no Firebase. Ele é também um
   projeto do Google Cloud.
2. Crie o Cloud Firestore no modo nativo, com o banco `(default)` na região
   `southamerica-east1`.
3. O servidor fala com o banco por REST, com o token OAuth da conta que executa
   o código. Esse acesso é governado pelo IAM do projeto, e não pelas regras de
   segurança do Firestore, que podem negar tudo. A conta que criou o projeto já
   é dona dele; qualquer outra conta que execute o código precisa ser convidada
   pelo IAM.

## 2. O projeto do Apps Script

1. Com a mesma conta, crie um projeto do Apps Script e associe-o ao projeto do
   Google Cloud do Firebase, em Configurações do projeto › Projeto do Google
   Cloud.
2. Envie o código com o clasp, como no
   [passo 6 da publicação](publicar-o-servidor.md): o `.clasp.json` na raiz,
   fora do git, com o id do projeto e `"rootDir": "apps-script"`, e depois
   `npx @google/clasp@3.3.0 push --force`.
3. Em Configurações do projeto › Propriedades do script, crie:

   | Propriedade | Obrigatória | O que guarda |
   | --- | --- | --- |
   | `FIRESTORE_PROJETO` | sim | o id do projeto do Firebase |
   | `FIRESTORE_BANCO` | não | o banco; sem ela, `(default)` |
   | `GOOGLE_CLIENT_ID` | só para o botão do Google | o client id do passo 3 |

   Os ids das pastas do Drive e as sessões do painel são gravados pelo próprio
   script.
4. No editor, rode `autorizar()`, que abre a tela de permissões dos escopos do
   manifesto, e depois `setup()`. O `setup()` semeia a configuração padrão no
   banco e relata o projeto do Firestore, o client id e a lista de acesso. Se a
   conexão com o banco falhar, `provaConectar()` diz qual pré-requisito falta.

## 3. A entrada pela conta Google

Este passo é opcional. Sem ele, o botão do Google não aparece, e a entrada pelo
link por e-mail continua funcionando.

1. No console do Google Cloud, em APIs e serviços › Credenciais, crie um ID do
   cliente OAuth do tipo Aplicativo da Web, com a origem do painel autorizada,
   por exemplo `https://<organização>.github.io`.
2. Grave o client id na propriedade `GOOGLE_CLIENT_ID`. O painel o recebe do
   servidor; o `googleClientId` de `docs/assets/config.js` fica vazio, como
   reserva.

## 4. A primeira implantação

1. No editor, Implantar › Nova implantação › App da Web, executando como **eu**
   e com acesso de **qualquer pessoa**. É a única vez que se usa Nova
   implantação: daí em diante, toda publicação é uma Nova versão nesta mesma
   implantação ([Publicar o servidor](publicar-o-servidor.md)).
2. Copie a URL `/exec` para o `endpoint` de `docs/assets/config.js`.

## 5. O site e o painel

1. No GitHub, em Settings › Pages, escolha GitHub Actions como fonte. O workflow
   `publicar-site.yml` publica a pasta `docs/` a cada push na `main`.
2. Ligue o relato privado de vulnerabilidade, na aba Security. É o canal que o
   [SECURITY.md](../SECURITY.md) indica.

## 6. Quem entra no painel

No editor, `liberarMeuAcesso()` inclui na lista de acesso a conta que está no
editor e abre uma sessão para ela. `liberarAcesso("pessoa@dominio")` inclui
outra conta. Depois disso, as pessoas entram e saem pela tela Configurações ›
Quem tem acesso, e o [guia dos níveis](niveis-de-acesso.md) explica o resto.

## 7. Os acionadores

No editor, rode os três instaladores. O acionador roda com a conta que o
instalou, então cada um deve ser instalado pela conta que vai responder por ele.

| Instalador | Acionador | Quando roda |
| --- | --- | --- |
| `instalarGatilhoDiario()` | `reconciliarAutomatico` | todo dia, entre 5h e 6h |
| `instalarGatilhoBackup()` | `fazerBackup` | todo dia, entre 6h e 7h |
| `instalarGatilhoAquecimento()` | `aquecerWebApp` | a cada 5 minutos |

O `instalarGatilhoAquecimento()` faz um ping na hora e diz se o endereço
respondeu. A limpeza dos temporários da importação (`limparTemporariosAntigos`)
não tem instalador: quem quiser que ela rode sozinha a instala pela tela
Acionadores do editor.

## 8. Conferir

- `npm test` na raiz do repositório.
- O site e o painel abertos numa janela anônima, como nos passos 10 a 12 do
  guia [Publicar o servidor](publicar-o-servidor.md).
- No editor, `diagnostico()` lista vagas e inscritos e, depois do primeiro
  backup, `conferirBackup()` confere o arquivo gravado no Drive.
