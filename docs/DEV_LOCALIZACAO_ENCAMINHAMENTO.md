# Localização e encaminhamento

Recursos validados inicialmente na dev e promovidos para a main como entrega isolada. Não requer migração nova.

## Uso

- Localização estática recebida pelo WhatsApp: cartão no atendimento, botão para abrir o Google Maps e copiar coordenadas.
- Ação Encaminhar abaixo de textos, imagens, documentos e localizações no atendimento.
- Destino WhatsApp: outra conversa disponível para o usuário; o número e o canal aparecem na seleção. O envio é uma nova cópia, sujeito às regras do canal e à janela Meta.
- Destino interno: atendente ativo da mesma empresa ou conversa/grupo do qual o remetente participa. Reutiliza chat direto existente, anexos e notificações.
- Localização encaminhada é um texto com link do mapa. Não oferece rastreamento em tempo real.
- Imagens externas: JPEG/PNG, até 5 MB; documentos externos usam a validação existente e limite conservador de 16 MB. Anexos internos: até 10 MB e formatos já permitidos pelo chat interno.
- Arquivos indisponíveis ou expirados não são substituídos por links públicos nem pela legenda.

## Proteções

O servidor lê o conteúdo original; o navegador envia apenas IDs. Origem, destino e canais são verificados na empresa da sessão. Grupos exigem participação; notas internas/eventos do sistema não podem ser encaminhados ao WhatsApp. A mensagem original não é alterada. Envios externos bem-sucedidos recebem referência de auditoria no payload do destino.

## Validação local

`node node_modules/tsx/dist/cli.mjs scripts/test-location-forward.mjs`

Usa PostgreSQL isolado em memória, sem conexão com banco de produção nem envio real. Inclui permissões, separação entre empresas, arquivos, janela Meta, payload nativo de imagem, localização, API de listagem e deduplicação de recebimento.

Regressões: test-company-isolation, test-document-send, test-meta-inbound-extract, test-meta-coexistence-regression, test-meta-webhook-parse, test-meta-media-download e test-message-media-recovery. Compilar com o build normal do projeto.

## Conferência no ambiente DEV

1. Receber localização estática e abrir o mapa; conferir as coordenadas.
2. Encaminhar texto, JPEG/PNG e PDF para outra conversa de teste, conferindo contato e canal antes de confirmar.
3. Repetir para atendente e grupo interno; conferir arquivo e notificação no destinatário.
4. Conferir que o histórico original permanece igual e que o botão não permite duplo clique durante o envio.
5. Conferir bloqueios por canal e entre duas empresas, além da janela Meta fechada.

A compilação e os testes automatizados locais não substituem essa conferência com contas reais de teste. O verificador global de tipos da dev tem erros anteriores fora desta entrega; os novos componentes e serviços não acrescentam erros próprios.
