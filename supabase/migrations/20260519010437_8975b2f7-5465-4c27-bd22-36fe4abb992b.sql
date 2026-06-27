
DO $$
DECLARE fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'has_role(uuid, public.app_role)',
    'is_super_admin(uuid)',
    'is_member_of_tenant(uuid, uuid)',
    'has_tenant_role(uuid, uuid, public.app_role)',
    'can_manage_tenant(uuid, uuid)',
    'can_view_all_conversations(uuid, uuid)',
    'handle_new_user()',
    'update_updated_at_column()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;
