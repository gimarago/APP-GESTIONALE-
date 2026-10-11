/* Apply a confirmed shared snapshot without rebuilding the legacy document.
 * Server data and local writes are fenced by the host before entering here.
 * Business observers must not replay transactions already committed remotely. */
(() => {
  'use strict';
  const cloud = window.WorkshopCloud, schema = window.WorkshopCloudSchema, records = window.WorkshopCloudRecords;
  const equal = (left, right) => records.stable(left) === records.stable(right);
  const notify = (name, detail) => {document.dispatchEvent(new CustomEvent(name, {detail}));if(cloud.failed)throw Error('Impossibile applicare tutti i dati ricevuti.');};
  function updateRow(row, incoming) {
    const attrs = incoming.a || {};
    for (const {name} of [...row.attributes]) if (!Object.hasOwn(attrs, name)) row.removeAttribute(name);
    for (const [name, value] of Object.entries(attrs)) if (row.getAttribute(name) !== value) row.setAttribute(name, value);
    row.replaceChildren(...(incoming.c || []).map(cloud.deserialize));
  }
  cloud.apply = async (state, previous) => {
    const roots = [], fields = [], storageKeys = schema.storageKeys.filter(key => state.storage[key] !== previous.storage[key]);
    // Prepare and validate nodes before touching the displayed document.
    for (const selector of schema.selectors) {
      const before = previous.dom[selector] || [], after = state.dom[selector] || [];
      if (equal(before, after)) continue;
      const root = document.querySelector(selector);
      if (!root) throw Error('Sezione dati non disponibile: ' + selector);
      if (records.rows.includes(selector)) {
        const old = new Map(before.map(node => [node.a['data-cloud-id'], node]));
        const incoming = new Map(after.map(node => [node.a['data-cloud-id'], node]));
        const current = new Map([...root.children].filter(node => node.dataset.cloudId).map(node => [node.dataset.cloudId, node]));
        const changed = after.filter(node => !equal(old.get(node.a['data-cloud-id']), node));
        const additions = new Map(changed.filter(node => !current.has(node.a['data-cloud-id'])).map(node => [node.a['data-cloud-id'], cloud.deserialize(node)]));
        // Validation also covers changed descendants of retained row objects.
        for (const node of changed) if (current.has(node.a['data-cloud-id'])) cloud.deserialize(node);
        roots.push({selector, root, incoming, current, changed, additions});
      } else roots.push({selector, root, children:after.map(cloud.deserialize)});
    }
    for (const id of schema.fields) if (state.fields[id] !== previous.fields[id]) fields.push(id);
    const detail = {selectors:roots.map(item => item.selector), rowIds:Object.fromEntries(roots.filter(item=>item.changed).map(item=>[item.selector,item.changed.map(node=>node.a['data-cloud-id'])])), fields, storageKeys};
    cloud.beginApply(state);
    try {
      // Stateful modules re-read shared storage before DOM observers can run.
      notify('workshop-cloud-state-loading', detail);
      for (const item of roots) {
        if (item.children) { item.root.replaceChildren(...item.children); continue; }
        for (const [id, row] of item.current) if (!item.incoming.has(id)) row.remove();
        for (const node of item.changed) {
          const id = node.a['data-cloud-id'], row = item.current.get(id);
          if (row) updateRow(row, node);
          else item.root.append(item.additions.get(id));
        }
      }
      for (const id of fields) { const field = document.getElementById(id); if (field) field.value = state.fields[id] || ''; }
      notify('workshop-cloud-state-applied', detail);
      // Legacy visual decorators use microtasks and short timers (up to 80 ms).
      // Keep transaction replay suppressed until they have settled. No document
      // navigation or loading screen is involved, and unchanged rows stay put.
      await new Promise(resolve => setTimeout(resolve, 100));
      notify('workshop-cloud-state-settled', detail);
      await new Promise(resolve => setTimeout(resolve, 0));
      return cloud.capture();
    } finally { cloud.endApply(); }
  };
})();
