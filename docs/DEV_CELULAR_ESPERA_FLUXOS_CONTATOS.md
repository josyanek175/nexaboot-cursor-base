# Espera, Fluxos e Contatos no celular

Publicação somente na dev. Compilar o serviço web da dev; sem SQL, migração ou mudança no serviço separado de API. As regras de acesso, o formato do fluxo e os contratos de persistência permanecem os existentes.

## Tempo de espera

A fila atual e o relatório por atendente usam cartões abaixo de 768 px, com rótulos junto aos valores. Nomes extensos, telefone, espera e data da última mensagem ficam legíveis sem depender de uma tabela lateral. A partir de 768 px, as tabelas são mantidas com rolagem horizontal quando necessária. Filtros de datas e indicadores se ajustam a telas estreitas.

## Fluxos

Abaixo de 1280 px, as etapas são listadas em cartões, mostrando os destinos das opções. A escolha da etapa inicial permanece disponível. Adicionar etapa, editar e configurar abrem painéis próprios, com altura limitada à área visível e rolagem. O simulador respeita a largura e a altura da tela. A barra de controles distribui nome, status, ajustes, teste, salvar e publicar em linhas menores. Essa adaptação inclui tablets e janelas menores, evitando comprimir três painéis lado a lado.

No computador, biblioteca, desenho ramificado e editor lateral continuam disponíveis. A visualização móvel usa os mesmos componentes e a mesma definição do fluxo; não altera os caminhos ou o motor de automação.

## Contatos

Abaixo de 768 px, a lista mostra cartões com nome, telefone, e-mail, referência, status, tags e ações de editar/inativar. A busca ocupa a largura disponível. Novo contato e importação continuam usando os manipuladores existentes.

O formulário de edição usa uma coluna no celular e limita a altura com rolagem. A janela de importação também respeita a área disponível. A tabela permanece nas telas maiores.

## Verificação

- Compilação web concluída.
- 25 suítes de operações passaram, incluindo definições de fluxo, simulador/motor, histórico, grupos internos e permissões.
- 20 cenários adicionais de dashboard por número passaram, incluindo o filtro da fila, histórico, médias e agentes da espera.
- Comparação de tipos: 473 diagnósticos já existentes, 473 após a alteração, sem novos diagnósticos.
- Prévia local com os componentes reais e APIs simuladas em 320, 390, 1024 e 1366 px. Sem dados reais, alterações em contatos reais, publicação de fluxo real ou mensagens externas.
- Conferência de cartões da espera e fila vazia; edição/cancelamento, janela de importação e busca sem resultados em Contatos; abertura de edição, inclusão de etapa, alteração de texto, salvamento/reabertura na API simulada, configurações e caminho de compra no simulador de Fluxos. Biblioteca, desenho e editor lateral conferidos em 1366 px.

## Validação após compilar a dev

1. Abrir Tempo de espera, rolar até Fila atual e conferir todas as informações de um cartão e a seção por atendente.
2. Em Fluxos, editar um fluxo de teste, adicionar uma etapa, selecionar destinos e testar as opções antes de salvar/publicar o fluxo de teste.
3. Em Contatos, buscar um nome/e-mail, abrir e cancelar uma edição e conferir a importação sem usar dados de clientes reais.
4. Conferir teclado, rotação e rolagem em um celular real. A prévia em larguras móveis não certifica o comportamento de cada modelo de iPhone/Android.

O pedido de instalação do NexaBoot como aplicativo fica separado desta revisão de layout; nenhum instalador, service worker ou cache offline foi adicionado neste ajuste.
