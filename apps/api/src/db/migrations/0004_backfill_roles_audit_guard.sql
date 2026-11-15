-- Workspaces made before roles existed get the default roles (the same as DEFAULT_ROLES in
-- packages/shared/src/permissions.ts), and their owners move onto the Owner role.

INSERT INTO roles (workspace_id, key, name, description, permissions)
SELECT w.id, r.key, r.name, r.description, r.permissions
FROM workspaces w
CROSS JOIN (VALUES
  ('owner', 'Owner', 'Everything, including making other owners.',
    ARRAY['workspace.manage','members.view','members.invite','members.manage','roles.manage','audit.view','finance.view','finance.edit','finance.post']::text[]),
  ('admin', 'Admin', 'Everything except changing owners.',
    ARRAY['workspace.manage','members.view','members.invite','members.manage','roles.manage','audit.view','finance.view','finance.edit','finance.post']::text[]),
  (NULL, 'Accountant', 'Runs the books: posts, voids and files reports.',
    ARRAY['members.view','audit.view','finance.view','finance.edit','finance.post']::text[]),
  (NULL, 'Bookkeeper', 'Prepares drafts for an accountant to post.',
    ARRAY['members.view','finance.view','finance.edit']::text[]),
  (NULL, 'Viewer', 'Can look but not change anything.',
    ARRAY['members.view','finance.view']::text[])
) AS r(key, name, description, permissions)
WHERE NOT EXISTS (SELECT 1 FROM roles x WHERE x.workspace_id = w.id);
--> statement-breakpoint

UPDATE memberships m
SET role_id = r.id
FROM roles r
WHERE r.workspace_id = m.workspace_id AND r.key = 'owner' AND m.role_id IS NULL;
--> statement-breakpoint

UPDATE workspaces SET street = registered_address WHERE street = '';
--> statement-breakpoint

-- The audit log is append-only, like posted entries (see 0002). The same purge escape hatch lets
-- a whole workspace be deleted.
CREATE FUNCTION erp_audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF erp_purging() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'The audit log can''t be changed or deleted.' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint

CREATE TRIGGER audit_log_guard BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION erp_audit_log_guard();
