# Campanhas no celular — revisão na dev

Revisão das telas de lista, criação, detalhes, modelos, resultados, custos e templates de atendimento. Em telas pequenas, tabelas passam a cartões com rótulos; cabeçalhos, ações, formulários e abas se ajustam à largura disponível. No desktop, as tabelas continuam disponíveis.

O botão de sincronização Meta em Modelos segue a permissão administrativa já exigida pela API. Atendentes recebem orientação para procurar um administrador. Não houve alteração de permissões no servidor, regras de envio, banco ou processamento de campanhas.

Validação: compilação concluída; 25 testes de operações aprovados; quatro verificações de campanhas (permissões, início manual, templates e espera de resultados) aprovadas. Comparação de tipos: 473 diagnósticos preexistentes, nenhum novo. Auditoria de manipuladores e chamadas de API nas oito fontes TSX preservada.

Prévia local com componentes reais e respostas fictícias, sem disparos: larguras de 320 e 390 pixels, lista vazia, criação até agendamento, público, modelos e perfil de atendente. Não substitui validação em aparelho físico nem comprova implantação na EasyPanel.

Publicação desta etapa: somente dev. Para validar online, compilar o serviço web de desenvolvimento. Sem migração SQL ou compilação separada de API. Main permanece sem esta revisão até aprovação.
