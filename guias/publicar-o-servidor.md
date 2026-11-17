# Publicar o servidor

[← README](../README.md)

O site e o painel (`docs/`) são publicados pelo GitHub Pages a cada merge na
`main`. O servidor (`apps-script/`) não: ele vive num projeto do Google Apps
Script, e só muda quando alguém o publica, à mão, com o
[clasp](https://github.com/google/clasp). Mesclar o pull request não publica o
servidor, e publicar o servidor não depende do merge — mas os dois vão no mesmo
dia (passo 13).

**O desenho.** O servidor só responde JSON: não serve página nenhuma, e quem
desenha as telas é o site e o painel, no Pages. O que o projeto deixa público
são o `doGet` e o `doPost`, as funções dos acionadores e as ferramentas de
editor (entre elas `setup`, `liberarMeuAcesso`, `liberarAcesso`,
`invalidarSessoes`, os instaladores dos acionadores, os diagnósticos e as
provas do banco; a lista inteira é a `PUBLICAS` de `testes/portas.js`), e cada
uma começa por uma guarda: o `doPost` só despacha uma lista fechada de ações,
as funções dos acionadores só rodam pelo acionador instalado no projeto ou pelo
editor, e as ferramentas, só pelo editor, com a conta de quem está com o
projeto aberto. Todo o resto termina em `_`, que é como o Apps Script marca a
função privada. `testes/portas.js` confere essas listas.

**O que é preciso.** Node 20 e o clasp 3.3.0 pelo `npx`
(`npx @google/clasp@3.3.0 ...`), sem instalar nada no repositório. A versão é
fixa porque as conferências dos passos 5 a 8 são as das mensagens dela. Na
raiz, um `.clasp.json` — fora do git, pelo
`.gitignore` — com o id do projeto (em Configurações do projeto, no editor):

```
{ "scriptId": "<id do projeto>", "rootDir": "apps-script" }
```

O envio leva só os `.gs` de `apps-script/` e o `appsscript.json`: o
`.claspignore` da raiz deixa o resto de fora (`.js`, `.html` e afins), e
`testes/portas.js` recusa qualquer outro arquivo ou subpasta ali. É exatamente
o que o servidor tem de ter — e é por isso que o `npm test` vem antes do envio.

**Antes de enviar, conferir o destino.** O envio substitui o código inteiro do
projeto, e um envio para o projeto errado "dá certo" sem mudar nada no ar.

1. `npx @google/clasp@3.3.0 show-authorized-user` mostra a conta que vai publicar
   (`You are logged in as <e-mail>.`), e ela tem de ser a que implanta hoje: a
   dona de `fazerBackup` e `aquecerWebApp` na tela Acionadores do editor (o
   relógio, no menu da esquerda). O web app roda como quem implantou
   (`executeAs: USER_DEPLOYING`, no `appsscript.json`), e quem faz o passo 7
   implanta: com outra conta, o banco passa a ser lido e gravado com o token
   dela, o link de entrada por e-mail sai do endereço dela, e as pastas dos
   banners e dos temporários da importação, que estão no Drive de quem
   implanta, ficam fora de alcance. Com `Not logged in.`, entre com a conta
   que implanta: `npx @google/clasp@3.3.0 login --no-localhost` mostra um
   endereço; abra-o, autorize com essa conta e cole no terminal o endereço em
   que o navegador parar (a página não carrega, e é assim mesmo). A conta
   precisa da API do Apps Script ligada, em
   https://script.google.com/home/usersettings. Se aparecer outra conta,
   **pare**: com ela, o passo 7 trocaria a conta com que o web app roda. Saia
   com `npx @google/clasp@3.3.0 logout` e entre com a certa;
2. `npx @google/clasp@3.3.0 list-deployments` lista a implantação cujo id está em
   `docs/assets/config.js` (o `endpoint`, entre `/s/` e `/exec`). Se ela não
   aparecer, **pare**: o `.clasp.json` aponta para outro projeto. A lista traz
   também a implantação de teste, com `@HEAD`: ela não aparece em Gerenciar
   implantações, e fica;
3. no editor, Implantar › Gerenciar implantações mostra a mesma implantação, e
   a tela Execuções mostra o projeto em uso: `aquecerWebApp` a cada cinco
   minutos, que é o acionador, e as chamadas do site e do painel, como App da
   Web — anônimas, com a função, a versão e o status de cada uma (50 por
   página).

**Antes de enviar, conferir o código.**

4. `npm test` no mesmo checkout que vai ser enviado, com a suíte inteira verde
   e nada por commitar em `apps-script/` (`git status --short apps-script`
   vazio): o envio leva o `apps-script/` do commit em que o checkout está, e
   `git rev-parse --short HEAD` dá o `<sha>` dele, que o passo 7 grava;
5. compare o que o projeto tem agora com o git. Numa pasta vazia, fora do
   repositório, um `.clasp.json` com o mesmo `scriptId`:

   ```
   { "scriptId": "<id do projeto>", "rootDir": ".", "scriptExtensions": [".gs"] }
   ```

   e ali `npx @google/clasp@3.3.0 pull` baixa, pela API do Apps Script, o
   código que o projeto tem, com os mesmos nomes do repositório. Compare com o
   `apps-script/` do commit do último envio: o `<sha>` que o passo 7 gravou na
   descrição da versão de número mais alto, que
   `npx @google/clasp@3.3.0 list-versions` mostra (`N - Cesutech vN <sha>`).
   Vale a versão mais alta, e não a da implantação do `config.js` que a lista
   do passo 2 mostra (`@N - Cesutech vN <sha>`): depois de uma volta a uma
   versão anterior, a implantação aponta para trás, e o código do projeto
   continua o do último envio. A comparação:

   ```
   git -C <repositório> archive <sha> apps-script | tar -x -C <outra pasta vazia>
   diff -r -x .clasp.json <outra pasta vazia>/apps-script .
   ```

   Os `.gs` têm de ser iguais, e o `appsscript.json` só pode diferir pela
   quebra de linha do fim. Qualquer outra diferença é código mexido direto no
   editor, que o envio apagaria: **pare**, e leve a mudança para o git antes.

   Esse commit não é, necessariamente, a ponta da `main`: a publicação vem
   antes do merge (passo 13), e a branch pode ganhar commits depois do envio.
   As versões até a 21 foram publicadas antes desta regra, sem o `<sha>` na
   descrição. Uma versão sem o `<sha>` se
   reconhece pelo código: `npx @google/clasp@3.3.0 pull --versionNumber N`,
   numa terceira pasta com o mesmo `.clasp.json`, baixa o dela. E se a
   publicação anterior parou depois do passo 6 e antes do fim do 7, o projeto
   já tem o código daquele envio, sem versão: compare com o `<sha>` do passo 4
   daquela vez e, se for igual, retome do passo 7. Sem commit com o mesmo
   `apps-script/`, **pare**.

**Publicar.**

6. `npx @google/clasp@3.3.0 push --force` envia o código. O `--force` só depois do
   passo 5, e é ele que faz o envio acontecer: o clasp 3.3.0 vê o manifesto do
   projeto diferente do local (a quebra de linha do fim), pergunta se pode
   sobrescrevê-lo e, sem o `--force` — com Enter, ou fora de um terminal
   interativo —, não envia nada e sai sem erro. Confira a saída:
   `Pushed 22 files` e a lista, só com `apps-script/*.gs` e
   `apps-script/appsscript.json` (hoje, os 21 `.gs` e o manifesto). Se aparecer
   `Skipping push.`, **pare**: nada foi enviado, e uma Nova versão agora
   publicaria o código antigo;
7. a Nova versão, na implantação do `config.js`, com a descrição
   `Cesutech vN <sha>`: N é o número da versão nova, e o `<sha>`, o do passo
   4 — é por ele que a próxima publicação sabe com que commit comparar (passo
   5). Por um dos dois caminhos, e a URL não muda em nenhum deles:
   - no editor, aberto com a conta do passo 1: Implantar › Gerenciar
     implantações › a implantação do `config.js` › editar (o lápis) › Versão:
     **Nova versão**, Descrição: `Cesutech vN <sha>` › Implantar;
   - pelo clasp: `npx @google/clasp@3.3.0 create-version "Cesutech vN <sha>"`, que
     responde `Created version N`, e depois
     `npx @google/clasp@3.3.0 update-deployment <id da implantação do config.js> -V N -d "Cesutech vN <sha>"`.

   **Nunca** use Implantar › Nova implantação, nem o `create-deployment` do
   clasp: a implantação nova ganha outra URL, e a antiga continua servindo a
   versão anterior;
8. `npx @google/clasp@3.3.0 list-deployments` mostra a implantação do `config.js`
   com `@N - Cesutech vN <sha>`;
9. ainda em Gerenciar implantações, **arquive todas as outras** implantações,
   de qualquer tipo. Uma implantação presa a uma versão antiga responde com o
   código daquela versão até ser arquivada.

Os acionadores — backup, aquecimento e reconciliação — rodam na implantação de
teste, que é o código do último envio, e não numa versão: do passo 6 em diante
eles já rodam o código novo, e o site e o painel, só a partir do passo 7. Por
isso o passo 7 vem logo depois do 6.

**Depois, numa janela anônima.**

10. o endereço `/exec` sem parâmetros responde só um JSON com os endereços do
    site e do painel;
11. o site: os cartões dos projetos aparecem e a conferência de matrícula
    responde — sem enviar inscrição de verdade;
12. o painel: entrar, abrir cada aba e esperar cada uma carregar. No editor, em
    Execuções, as chamadas de App da Web destes passos aparecem com a versão
    nova.

**No mesmo dia, mesclar o pull request.**

13. o site e o painel no ar são os da `main`: até o merge, o painel é o antigo,
    falando com o servidor novo, e o que ele diz sobre o servidor pode não
    valer mais. Mescle com **merge commit** (Create a merge commit), e não por
    squash nem por rebase: os dois trocam o commit por outro, e o `<sha>` que
    o passo 7 gravou sumiria da `main`, que é onde a próxima publicação o
    procura (passo 5). Depois do merge, espere o GitHub Pages publicar e
    repita os passos 11 e 12.

**Se algo quebrar,** corrija para a frente, num commit novo, e publique de novo.
O erro das rotas do site e do login, e o que escapar de uma função do painel,
fica no Histórico do painel como `ERRO_INTERNO`, com o nome da rota no começo
do detalhe; o erro que uma função do painel trata aparece na própria tela.
Voltar a implantação para uma versão anterior só com o OK explícito de quem
responde pelo sistema, e pelo menor tempo possível: as versões até a 20 são
anteriores ao desenho descrito no começo deste guia.
