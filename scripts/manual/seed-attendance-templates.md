# Configurar presets de atendimento (manual)

Após sincronizar templates Meta (`Canais` → sync templates) e existir a linha em `meta_message_templates` com `status = APPROVED`:

1. Abra **Campanhas → Modelos** não — use **Atendimento templates** em `/campanhas/templates-atendimento` (ou a rota admin criada).
2. Selecione o template Meta sincronizado.
3. Defina nome amigável, descrição, variables (labels / source / required) e ative.

Não há seed automático dos 14 textos de exemplo. Cadastre na Meta primeiro; depois vincule o `meta_template_id` real.
