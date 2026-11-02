-- Diagnóstico somente leitura. Usar a conexão do ambiente confirmado.
BEGIN READ ONLY;
SELECT current_database() AS banco, current_user AS usuario;
WITH expected(table_name,column_name) AS (VALUES
 ('company_operations_settings','company_id'),
 ('company_operations_settings','waiting_attendant_minutes'),
 ('company_operations_settings','waiting_customer_hours'),
 ('company_operations_settings','restrict_channels'),
 ('company_operations_settings','updated_at'),
 ('company_teams','id'),('company_teams','company_id'),('company_teams','name'),
 ('company_team_members','company_id'),('company_team_members','team_id'),('company_team_members','user_id'),
 ('company_channel_grants','id'),('company_channel_grants','company_id'),
 ('company_channel_grants','channel_id'),('company_channel_grants','user_id'),('company_channel_grants','team_id'),
 ('clinic_professionals','id'),('clinic_professionals','company_id'),('clinic_professionals','name'),
 ('clinic_professionals','specialty'),('clinic_professionals','duration'),('clinic_professionals','opens'),
 ('clinic_professionals','closes'),('clinic_professionals','weekdays'),
 ('clinic_appointments','id'),('clinic_appointments','company_id'),('clinic_appointments','professional_id'),
 ('clinic_appointments','contact_id'),('clinic_appointments','starts_at'),('clinic_appointments','duration'),
 ('clinic_appointments','kind'),('clinic_appointments','patient'),('clinic_appointments','phone'),
 ('clinic_appointments','service'),('clinic_appointments','status'),('clinic_appointments','reminder_hours'),
 ('clinic_appointments','reminder_copied_at'),('clinic_appointments','version'),('clinic_appointments','created_by'),
 ('clinic_appointments','created_at'),('clinic_appointments','updated_at')
)
SELECT e.table_name AS tabela,e.column_name AS coluna_ausente
FROM expected e
LEFT JOIN information_schema.columns c ON c.table_schema='public' AND c.table_name=e.table_name AND c.column_name=e.column_name
WHERE c.column_name IS NULL ORDER BY e.table_name,e.column_name;
WITH tables(name) AS (VALUES ('clinic_professionals'),('clinic_appointments'))
SELECT name AS tabela,
 CASE WHEN to_regclass('public.'||name) IS NULL THEN 'Tabela ausente'
 WHEN row_security_active(to_regclass('public.'||name)) THEN 'RLS limita este usuario; conferir a conexao do backend'
 WHEN has_table_privilege(current_user,to_regclass('public.'||name),'SELECT')
  AND has_table_privilege(current_user,to_regclass('public.'||name),'INSERT')
  AND has_table_privilege(current_user,to_regclass('public.'||name),'UPDATE') THEN 'Permissoes de leitura e gravacao disponiveis'
 ELSE 'Revisar privilegios deste usuario' END AS acesso
FROM tables;
ROLLBACK;
