# Menu organizado — dev

O menu lateral agora reúne os mesmos destinos em cinco áreas: Visão geral, Atendimento, Agenda, Marketing e automação e Equipe. Somente uma área fica expandida por vez. Ao navegar, a área da página atual abre automaticamente; páginas filhas, como modelos de campanha, mantêm o destaque correto.

Configurações fica no rodapé, com usuários, equipes e números, canais, horários, preferências, integrações N8N e logs. Empresas aparece separadamente apenas para perfis da plataforma. Os filtros de permissão existentes continuam sendo aplicados antes de renderizar os destinos. Os serviços e regras de autorização no servidor não foram alterados.

O nome é **Agenda** no menu, no título da página e na aba do navegador. O modelo de agendamento existente não foi alterado.

Contadores de mensagens não lidas permanecem nos destinos e aparecem no grupo quando ele está recolhido. Os grupos vazios não são mostrados. O menu móvel continua com fechamento por seleção, botão, Escape e controle de foco. A identidade da empresa ativa e a troca de empresa da plataforma permanecem no shell.

Validação: `node --import tsx scripts/test-sidebar-navigation.mjs` renderiza o shell real com oito perfis, verifica os 19 destinos únicos, áreas, rotas filhas e restrições por empresa/perfil. Prévia local com componentes reais e dados fictícios conferiu desktop, grupos, rodapé e gaveta móvel de 390px, inclusive fechamento ao navegar. A compilação passou; o verificador de tipos mantém 473 diagnósticos anteriores, sem erros nos arquivos desta mudança.

Publicar somente na dev para validação. Na EasyPanel, compilar apenas a web dev. Esta mudança não exige SQL nem compilação de API separada.
