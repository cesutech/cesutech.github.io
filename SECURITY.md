# Segurança

Este repositório é o sistema de inscrição em projetos de extensão do CESUTECH
(UNICESUSC). Ele guarda e trata dado pessoal de alunos, então um problema de
segurança aqui é tratado como prioridade.

## Como relatar

Use o **relato privado de vulnerabilidade do GitHub**: na aba **Security**
deste repositório, clique em **Report a vulnerability**. O relato fica visível
só para quem mantém o projeto.

**Não abra issue pública** nem comente o problema em pull request: o código é
público, e o sistema está em uso.

## O que incluir

- o que você encontrou e onde (arquivo, rota, tela);
- como reproduzir, passo a passo;
- o que alguém conseguiria fazer com isso — ler, alterar, apagar, derrubar;
- se possível, uma sugestão de correção.

Não inclua dado pessoal real no relato. Para mostrar o problema, use dados
inventados com a mesma forma (um e-mail de exemplo, uma matrícula com o número
certo de dígitos) e acesse o mínimo necessário para demonstrá-lo.

## O que está no escopo

- o **site de inscrição** (`docs/`, publicado em cesutech.github.io);
- o **painel da coordenação** (`docs/painel/`);
- o **servidor em Google Apps Script** (`apps-script/`) e o que ele faz no
  banco de dados.

Fica de fora a infraestrutura do Google e do GitHub em si, e qualquer teste de
carga ou de negação de serviço contra o sistema em uso: ele atende alunos de
verdade, com cota diária limitada.

## O que esperar

O projeto é acadêmico, de extensão, mantido por uma equipe pequena. A intenção é
confirmar o recebimento em até **7 dias úteis**, avaliar o relato e combinar com
você o prazo da correção, que depende da gravidade. Não há programa de
recompensa. Se quiser, seu nome entra no agradecimento quando a correção for
publicada.
