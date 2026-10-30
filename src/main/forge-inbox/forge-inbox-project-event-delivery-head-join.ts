/**
 * The delivery's binding, reported event (`d`) and item (`i`), shared by every head lookup.
 * Callers supply `FROM webhook_deliveries w`; `e` stays free for the item's latest event.
 */
export const PROJECT_EVENT_DELIVERY_HEAD_JOIN_SQL = `
  JOIN project_bindings b ON b.binding_id = w.binding_id
  JOIN deliveries dl ON dl.host_id = w.host_id AND dl.dedupe_key = w.dedupe_key
    AND dl.instance_id = 'gitlab:' || b.gitlab_host
  JOIN events d ON d.id = dl.event_id
  JOIN items i ON i.id = d.item_id`
