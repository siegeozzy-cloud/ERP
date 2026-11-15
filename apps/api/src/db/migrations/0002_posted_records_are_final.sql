-- Posted records are final (docs/plan.md, architecture rule 3).
--
-- The app never edits or deletes a posted journal entry, invoice, bill or payment. These triggers
-- make that true even for a bug, a script or someone at a SQL prompt: mistakes are corrected with a
-- reversing entry or by voiding, and the original stays on the books.
--
-- The one escape hatch is `SET LOCAL erp.purge = 'on'` inside a transaction, for deleting a whole
-- workspace (its rows go with it by cascade). Nothing else sets it.

CREATE FUNCTION erp_purging() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('erp.purge', true), '') = 'on'
$$;
--> statement-breakpoint

-- Journal entries: a draft may change freely. Posting checks the entry balances. After that the
-- only change allowed is recording, once, which entry reversed it.
CREATE FUNCTION erp_journal_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  debits bigint;
  credits bigint;
BEGIN
  IF erp_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'Posted journal entries can''t be deleted. Reverse them instead.' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'posted' THEN
      RAISE EXCEPTION 'Journal entries are created as drafts and posted once their lines are in.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.status = 'posted' THEN
    IF OLD.reversed_by_id IS NULL AND NEW.reversed_by_id IS NOT NULL
       AND (to_jsonb(NEW) - 'reversed_by_id') = (to_jsonb(OLD) - 'reversed_by_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Posted journal entries can''t be changed. Reverse them instead.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'posted' THEN
    SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0) INTO debits, credits FROM journal_lines WHERE entry_id = NEW.id;
    IF debits <> credits OR debits = 0 THEN
      RAISE EXCEPTION 'Journal entry doesn''t balance: debits % and credits % (centavos).', debits, credits USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER journal_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION erp_journal_entries_guard();
--> statement-breakpoint

-- Journal lines belong to their entry: once it's posted, none can be added, changed or removed.
CREATE FUNCTION erp_journal_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status journal_status;
BEGIN
  IF erp_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO parent_status FROM journal_entries WHERE id = OLD.entry_id;
    IF parent_status = 'posted' THEN
      RAISE EXCEPTION 'Lines of a posted journal entry can''t be changed.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT status INTO parent_status FROM journal_entries WHERE id = NEW.entry_id;
  IF parent_status = 'posted' THEN
    RAISE EXCEPTION 'Lines of a posted journal entry can''t be changed.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER journal_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION erp_journal_lines_guard();
--> statement-breakpoint

-- Invoices and bills: a draft may change. A posted one may only be voided (its number stays used,
-- as EOPT expects). A void one is final. Neither can be deleted.
CREATE FUNCTION erp_documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF erp_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Posted documents can''t be deleted. Void them instead.' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'posted' THEN
    IF NEW.status = 'void' AND (to_jsonb(NEW) - 'status' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'updated_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Posted documents can''t be changed. Void them instead.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'Void documents can''t be changed.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER sales_invoices_guard BEFORE UPDATE OR DELETE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION erp_documents_guard();
--> statement-breakpoint

CREATE TRIGGER bills_guard BEFORE UPDATE OR DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION erp_documents_guard();
--> statement-breakpoint

-- Document lines follow their invoice or bill: only a draft's lines can change.
CREATE FUNCTION erp_document_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status document_status;
BEGIN
  IF erp_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    IF OLD.invoice_id IS NOT NULL THEN
      SELECT status INTO parent_status FROM sales_invoices WHERE id = OLD.invoice_id;
    ELSE
      SELECT status INTO parent_status FROM bills WHERE id = OLD.bill_id;
    END IF;
    IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
      RAISE EXCEPTION 'Lines of a posted document can''t be changed.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT status INTO parent_status FROM sales_invoices WHERE id = NEW.invoice_id;
  ELSE
    SELECT status INTO parent_status FROM bills WHERE id = NEW.bill_id;
  END IF;
  IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
    RAISE EXCEPTION 'Lines of a posted document can''t be changed.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER document_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON document_lines
  FOR EACH ROW EXECUTE FUNCTION erp_document_lines_guard();
--> statement-breakpoint

-- Payments are posted when recorded. They may only be voided, once, and never deleted.
CREATE FUNCTION erp_payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF erp_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payments can''t be deleted. Void them instead.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'posted' AND NEW.status = 'void' AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Payments can''t be changed. Void them instead.' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint

CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION erp_payments_guard();
