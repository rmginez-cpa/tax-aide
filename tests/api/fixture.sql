-- Test fixture for authz / deadline tests. Idempotent: wipes app data except users 1-4.
TRUNCATE clients, engagements, deadlines, documents, comments, checklist_items, notifications, audit_logs, assistant_conversations RESTART IDENTITY CASCADE;
DELETE FROM users WHERE id > 4;
DELETE FROM user_sessions;
INSERT INTO clients (id, name, tin, business_type, status, income_tax_type, vat_registered, withholds_compensation, withholds_ewt, fiscal_year_start, fiscal_year_end)
VALUES (1, 'Alpha Corp', '111-111-111-000', 'corporation', 'active', 'corporate', true, true, true, 'January', 'December'),
       (2, 'Bravo Inc',  '222-222-222-000', 'corporation', 'active', 'individual', false, false, false, 'January', 'December');
SELECT setval('clients_id_seq', 2);
-- client@example.com (id 4) -> Alpha; clientb -> Bravo; orphan -> unlinked. Password for all: client123
UPDATE users SET client_id = 1 WHERE id = 4;
INSERT INTO users (id, email, name, role, password_hash, client_id)
SELECT 5, 'clientb@example.com', 'Bravo Client', 'client', password_hash, 2 FROM users WHERE id = 4;
INSERT INTO users (id, email, name, role, password_hash, client_id)
SELECT 6, 'orphan@example.com', 'Unlinked Client', 'client', password_hash, NULL FROM users WHERE id = 4;
INSERT INTO users (id, email, name, role, password_hash, client_id)
SELECT 7, 'viewer@example.com', 'Legacy Viewer', 'viewer', password_hash, 1 FROM users WHERE id = 4;
SELECT setval('users_id_seq', 7);
INSERT INTO engagements (id, client_id, title, tax_type, period, status, assigned_to, due_date, draft_return_status, source_collection_status)
VALUES (1, 1, 'BIR Form 1601C — January 2026', '1601C', 'January 2026', 'in_progress', 3, '2026-02-10', 'for_review', 'approved'),
       (2, 2, 'BIR Form 1701Q — Q1 2026', '1701Q', 'Q1 2026', 'in_progress', 3, '2026-05-15', 'in_progress', 'not_started');
SELECT setval('engagements_id_seq', 2);
INSERT INTO deadlines (id, client_id, engagement_id, title, due_date, status, priority)
VALUES (1, 1, 1, 'BIR Form 1601C — January 2026', '2026-02-10', 'pending', 'high'),
       (2, 2, 2, 'BIR Form 1701Q — Q1 2026', '2026-05-15', 'pending', 'high'),
       (3, 2, NULL, 'Bravo manual deadline', '2026-12-01', 'pending', 'low');
SELECT setval('deadlines_id_seq', 3);
INSERT INTO documents (id, client_id, engagement_id, filename, original_name, mime_type, file_size, file_url, uploaded_by, stage)
VALUES (1, 1, 1, 'a.txt', 'alpha-payroll.txt', 'text/plain', 5, '/api/documents/1/content', 3, 'source_collection'),
       (2, 2, 2, 'b.txt', 'bravo-sales.txt', 'text/plain', 5, '/api/documents/2/content', 3, 'source_collection');
SELECT setval('documents_id_seq', 2);
INSERT INTO comments (id, engagement_id, content, is_approval, author_id)
VALUES (1, 1, 'Approved Source Documents.', true, 2),
       (2, 2, 'Bravo internal note', false, 3);
SELECT setval('comments_id_seq', 2);
INSERT INTO checklist_items (id, engagement_id, label, status) VALUES (1, 1, 'Alpha payroll register', 'pending'), (2, 2, 'Bravo sales book', 'pending');
SELECT setval('checklist_items_id_seq', 2);
INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description) VALUES (3, 'create', 'client', 2, 'Created client Bravo Inc');
