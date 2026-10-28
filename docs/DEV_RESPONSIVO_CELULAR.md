# Revisão de uso no celular — dev

## Ajustes

- Comunicação interna: lista e conversa ocupam telas separadas abaixo de 1024 px, com botão de voltar. No desktop, as duas colunas continuam disponíveis.
- Mensagens, nomes longos e anexos respeitam a largura disponível. Campo de envio e controles de anexo/envio têm espaço para toque.
- Rascunhos internos ficam separados por conversa enquanto a página permanece aberta. Atualizações periódicas não forçam a leitura para o fim. Resultado de envio não é inserido em outro chat ao navegar durante a operação.
- Menu principal: cabeçalho móvel próprio, sem botão sobreposto aos conteúdos, fechamento explícito/Escape e controle de foco. Menu fechado sai da navegação por teclado.
- Altura da aplicação acompanha a área visível do navegador móvel com `visualViewport`; mantém alternativa com `100dvh`. Não intercepta ampliação por gesto.
- Atendimento WhatsApp: limites de largura/altura, campo de texto em linha própria no celular e painel de detalhes/ações acessível por botão e janela lateral. Painel desktop permanece no desktop.
- Janelas compartilhadas e edição de usuários/grupos têm limite de altura e rolagem. Importação de contatos distribui os indicadores em duas colunas no celular.
- Páginas comuns permitem rolagem dentro da aplicação; formulários móveis têm campos com fonte de 16 px. Cabeçalho/tabela de usuários se ajustam a larguras pequenas.

Nenhuma alteração de API, banco, regras de permissão ou envio de WhatsApp. Publicação somente na dev, junto do conteúdo que já estava nessa branch. Compilar o serviço web da dev; não executar SQL.

## Verificação

- Prévia local com componentes React reais e API simulada, sem usar dados de clientes nem enviar mensagens reais.
- Larguras de referência: 320, 390, 768 e 1366 px.
- Conferência de lista/conversa, textos extensos, voltar, rascunho separado, abertura/fechamento do menu e janela de nova conversa.
- Testes isolados de grupos internos, permissões por número e ciclo do fluxo.
- Compilação web; comparação de tipos com o código anterior. O projeto já apresenta diagnósticos de tipos preexistentes; a comparação não identificou novos diagnósticos nesta alteração.

## Validação após compilar a dev

1. Em um celular, abrir o menu, entrar em Comunicação Interna e selecionar uma conversa.
2. Digitar, abrir/fechar o teclado e conferir campo de envio e último balão. Girar o aparelho.
3. Voltar e abrir outra conversa: o texto digitado deve permanecer apenas na conversa original.
4. Ler mensagens antigas enquanto a atualização periódica ocorre: a leitura deve permanecer no local.
5. Conferir anexos e criação de conversa/grupo com participantes de teste.
6. Em Atendimento, abrir Detalhes e ações e conferir acesso a responsável, transferência e finalização.
7. Conferir rolagem de Usuários, Contatos, Grupos e páginas com conteúdo extenso.

Prévia em larguras de celular não substitui teste do teclado físico no Safari/iPhone e Chrome/Android. A revisão cobre a estrutura comum e os problemas encontrados nesses módulos; não certifica cada operação de todas as telas, nem inclui um redesenho do construtor visual de fluxos.
