import { createForgeInboxV5TablesSql } from './forge-inbox-schema-project-event-tables'

/**
 * One UPDATE keeps an enabled policy resuming its work and turns a disabled one into finished
 * deliveries: nothing ever claims pending+cancelled, so such a row would hold its slot and body.
 */
const FORGE_PROJECT_EVENT_POLICY_INVALIDATION_TRIGGER_SQL = `CREATE TRIGGER project_event_policy_decision_invalidation AFTER UPDATE ON project_event_policies
BEGIN
  UPDATE project_event_decisions SET superseded = 1 WHERE delivery_id IN (
    SELECT id FROM webhook_deliveries WHERE host_id = NEW.host_id AND state IN ('pending', 'parked')
      AND binding_id IN (SELECT binding_id FROM project_event_repo_links
        WHERE host_id = NEW.host_id AND repo_id = NEW.repo_id));
  UPDATE webhook_deliveries SET
    decision_state = CASE WHEN json_extract(NEW.policy_json, '$.enabled')
      THEN 'queued' ELSE 'cancelled' END,
    state = CASE WHEN json_extract(NEW.policy_json, '$.enabled') THEN 'pending' ELSE 'failed' END,
    last_error_code = CASE WHEN json_extract(NEW.policy_json, '$.enabled')
      THEN NULL ELSE 'policy-disabled' END,
    body = CASE WHEN json_extract(NEW.policy_json, '$.enabled') THEN body ELSE x'' END,
    finished_at = CASE WHEN json_extract(NEW.policy_json, '$.enabled')
      THEN finished_at ELSE COALESCE(finished_at, admitted_at) END,
    decision_token = NULL, next_attempt_at = NULL, attempts = 0,
    policy_generation = NEW.generation, parked_reason = NULL
    WHERE host_id = NEW.host_id AND state IN ('pending', 'parked') AND decision_state <> 'cancelled'
      AND binding_id IN (SELECT binding_id FROM project_event_repo_links
        WHERE host_id = NEW.host_id AND repo_id = NEW.repo_id);
END;`

export function migrateForgeInboxToV6Sql(): string {
  return `
ALTER TABLE webhook_deliveries ADD COLUMN decision_state TEXT
  CHECK (decision_state IN ('queued', 'processing', 'retry', 'blocked', 'decided', 'cancelled'));
ALTER TABLE webhook_deliveries ADD COLUMN decision_token TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN decision_started_at INTEGER;
ALTER TABLE webhook_deliveries ADD COLUMN decision_generation INTEGER;
ALTER TABLE webhook_deliveries ADD COLUMN decision_repo_id TEXT;
ALTER TABLE project_event_decisions RENAME TO project_event_decisions_v5;
CREATE TABLE project_event_decisions (
  id INTEGER PRIMARY KEY,
  host_id TEXT NOT NULL,
  delivery_id INTEGER NOT NULL REFERENCES webhook_deliveries (id),
  policy_generation INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('jev', 'laya')),
  model TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('record_only', 'notify', 'wait', 'fetch_context', 'dispatch_agent', 'ask_user')),
  confidence REAL NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  decided_at INTEGER NOT NULL,
  attempt_token TEXT UNIQUE,
  input_fingerprint TEXT,
  input_version INTEGER,
  duration_ms INTEGER,
  superseded INTEGER NOT NULL DEFAULT 0
);
INSERT INTO project_event_decisions (id, host_id, delivery_id, policy_generation, provider,
  model, action, confidence, input_tokens, output_tokens, decided_at)
SELECT id, host_id, delivery_id, policy_generation, provider, model, action, confidence,
  input_tokens, output_tokens, decided_at FROM project_event_decisions_v5;
DROP TABLE project_event_decisions_v5;
CREATE UNIQUE INDEX project_event_decisions_current
  ON project_event_decisions (delivery_id, policy_generation) WHERE superseded = 0;
UPDATE webhook_deliveries SET decision_state = CASE
  WHEN EXISTS (SELECT 1 FROM project_event_decisions WHERE delivery_id = webhook_deliveries.id)
    THEN 'decided'
  WHEN state = 'done' THEN 'cancelled'
  WHEN state = 'parked' THEN 'blocked'
  ELSE 'queued' END WHERE binding_id IS NOT NULL;
CREATE INDEX webhook_deliveries_decision_due
  ON webhook_deliveries (host_id, decision_state, next_attempt_at, id) WHERE binding_id IS NOT NULL;
${FORGE_PROJECT_EVENT_POLICY_INVALIDATION_TRIGGER_SQL}
CREATE TRIGGER project_event_link_decision_invalidation AFTER DELETE ON project_event_repo_links
BEGIN
  UPDATE project_event_decisions SET superseded = 1 WHERE delivery_id IN (
    SELECT id FROM webhook_deliveries WHERE host_id = OLD.host_id AND binding_id = OLD.binding_id
      AND state IN ('pending', 'parked'));
  UPDATE webhook_deliveries SET decision_state = 'blocked', decision_token = NULL,
    next_attempt_at = NULL, state = 'parked', parked_reason = 'awaiting-policy',
    last_error_code = 'missing-link'
    WHERE host_id = OLD.host_id AND binding_id = OLD.binding_id AND state IN ('pending', 'parked')
      AND decision_state <> 'cancelled';
END;
CREATE TRIGGER project_event_relink_decision_resume AFTER INSERT ON project_event_repo_links
BEGIN
  UPDATE webhook_deliveries SET decision_state = 'queued', state = 'pending',
    policy_generation = (SELECT generation FROM project_event_policies
      WHERE host_id = NEW.host_id AND repo_id = NEW.repo_id),
    attempts = 0, next_attempt_at = NULL, parked_reason = NULL
    WHERE host_id = NEW.host_id AND binding_id = NEW.binding_id AND state = 'parked'
      AND decision_state = 'blocked' AND EXISTS (SELECT 1 FROM project_event_policies
        WHERE host_id = NEW.host_id AND repo_id = NEW.repo_id AND json_extract(policy_json, '$.enabled'));
END;
CREATE TRIGGER project_event_new_policy_decision_resume AFTER INSERT ON project_event_policies
BEGIN
  UPDATE webhook_deliveries SET decision_state = 'queued', state = 'pending',
    policy_generation = NEW.generation, parked_reason = NULL, next_attempt_at = NULL
    WHERE host_id = NEW.host_id AND state = 'parked' AND decision_state = 'blocked'
      AND json_extract(NEW.policy_json, '$.enabled')
      AND binding_id IN (SELECT binding_id FROM project_event_repo_links
        WHERE host_id = NEW.host_id AND repo_id = NEW.repo_id);
END;
`
}

export function createForgeInboxV6TablesSql(): string {
  return `${createForgeInboxV5TablesSql()}\n${migrateForgeInboxToV6Sql()}`
}

/** A recorded decision becomes a claimable action; record_only is already finished when recorded. */
export function migrateForgeInboxToV7Sql(): string {
  return `
ALTER TABLE project_event_decisions ADD COLUMN item_id INTEGER REFERENCES items (id);
ALTER TABLE project_event_decisions ADD COLUMN action_state TEXT NOT NULL DEFAULT 'queued'
  CHECK (action_state IN ('queued', 'processing', 'blocked', 'awaiting-event', 'done', 'cancelled'));
ALTER TABLE project_event_decisions ADD COLUMN action_token TEXT;
ALTER TABLE project_event_decisions ADD COLUMN action_started_at INTEGER;
ALTER TABLE project_event_decisions ADD COLUMN action_finished_at INTEGER;
ALTER TABLE project_event_decisions ADD COLUMN last_error_code TEXT;
ALTER TABLE project_event_decisions ADD COLUMN run_id INTEGER;
CREATE UNIQUE INDEX project_event_decisions_action_token
  ON project_event_decisions (action_token) WHERE action_token IS NOT NULL;
CREATE INDEX project_event_decisions_action_due
  ON project_event_decisions (host_id, action_state, id);
-- Rows written before actions existed already had their effect (or never will): replaying them as
-- queued actions would re-notify or re-dispatch events the user has long since seen.
UPDATE project_event_decisions SET
  action_state = CASE WHEN action = 'record_only' THEN 'done' ELSE 'cancelled' END,
  last_error_code = CASE WHEN action = 'record_only' THEN NULL ELSE 'pre-action-upgrade' END;
-- A cancelled action can never settle its delivery, whose pending row would hold queue capacity and
-- its payload forever. Deliveries still awaiting a decision have no decision row and stay pending.
UPDATE webhook_deliveries SET state = 'failed', last_error_code = 'pre-action-upgrade',
  body = x'', next_attempt_at = NULL, finished_at = COALESCE(finished_at, admitted_at)
WHERE state = 'pending' AND EXISTS (
  SELECT 1 FROM project_event_decisions d
  WHERE d.delivery_id = webhook_deliveries.id AND d.action_state = 'cancelled');
`
}

export function createForgeInboxV7TablesSql(): string {
  return `${createForgeInboxV6TablesSql()}\n${migrateForgeInboxToV7Sql()}`
}

/**
 * A later event on the same item wakes a parked wait: the old decision must be superseded because
 * the v6 unique index allows only one live decision per delivery and generation. Re-deciding under
 * the binding's current enabled generation is what makes the wait observe the change it waited for.
 * A missing policy or link leaves the delivery parked rather than inventing work; a disabled policy
 * was already finished by the policy invalidation trigger.
 */
export function migrateForgeInboxToV8Sql(): string {
  return `
CREATE INDEX IF NOT EXISTS project_event_decisions_delivery
  ON project_event_decisions (delivery_id);
-- The trigger body lives in the V6 migration, so a database that ran it still needs the fixed shape.
DROP TRIGGER IF EXISTS project_event_policy_decision_invalidation;
${FORGE_PROJECT_EVENT_POLICY_INVALIDATION_TRIGGER_SQL}
CREATE TRIGGER project_event_wait_wake AFTER INSERT ON events
BEGIN
  UPDATE project_event_decisions SET superseded = 1
  WHERE item_id = NEW.item_id AND action_state = 'awaiting-event' AND superseded = 0
    AND EXISTS (
      SELECT 1 FROM webhook_deliveries w
      JOIN project_event_repo_links l ON l.binding_id = w.binding_id AND l.host_id = w.host_id
      JOIN project_event_policies p ON p.host_id = l.host_id AND p.repo_id = l.repo_id
      WHERE w.id = project_event_decisions.delivery_id
        AND w.host_id = project_event_decisions.host_id
        AND w.state = 'parked' AND w.decision_state = 'decided'
        AND json_extract(p.policy_json, '$.enabled'));
  UPDATE webhook_deliveries SET state = 'pending', decision_state = 'queued',
    decision_token = NULL, next_attempt_at = NULL, attempts = 0, parked_reason = NULL,
    policy_generation = (
      SELECT p.generation FROM project_event_repo_links l
      JOIN project_event_policies p ON p.host_id = l.host_id AND p.repo_id = l.repo_id
      WHERE l.binding_id = webhook_deliveries.binding_id
        AND l.host_id = webhook_deliveries.host_id
        AND json_extract(p.policy_json, '$.enabled'))
  WHERE state = 'parked' AND decision_state = 'decided'
    AND EXISTS (
      SELECT 1 FROM project_event_decisions d
      WHERE d.delivery_id = webhook_deliveries.id
        AND d.host_id = webhook_deliveries.host_id
        AND d.item_id = NEW.item_id AND d.action_state = 'awaiting-event' AND d.superseded = 1)
    AND EXISTS (
      SELECT 1 FROM project_event_repo_links l
      JOIN project_event_policies p ON p.host_id = l.host_id AND p.repo_id = l.repo_id
      WHERE l.binding_id = webhook_deliveries.binding_id
        AND l.host_id = webhook_deliveries.host_id
        AND json_extract(p.policy_json, '$.enabled'));
END;
`
}

export function createForgeInboxV8TablesSql(): string {
  return `${createForgeInboxV7TablesSql()}\n${migrateForgeInboxToV8Sql()}`
}
