/**
 * PostgreSQL falso compartilhado pelos testes de inbox e outbox.
 *
 * Guarda as linhas fora do processo de teste e, principalmente, tem semântica
 * transacional de verdade: se o callback de `begin` lançar, tudo que foi
 * escrito na transação é desfeito. É isso que permite testar honestamente que
 * a falha no INSERT da outbox desfaz o INSERT da inbox.
 */

export function createStore() {
  return { rows: [], outbox: [] };
}

export function makeSql(store, options = {}) {
  const state = {
    unsafeCalls: [],
    queries: [],
    commits: 0,
    rollbacks: 0,
    committedAt: 0,
    insertValues: null,
    outboxInsertValues: null,
  };

  const tx = (strings, ...values) => {
    const text = strings.join("|");
    state.queries.push(text);

    if (text.includes("INSERT INTO public.webhook_inbox")) {
      if (options.failOnInsert) {
        return Promise.reject(new Error(options.failMessage ?? "db down"));
      }
      state.insertValues = values;
      const [
        provider,
        eventType,
        companyId,
        channelId,
        instanceName,
        externalEventId,
        externalMessageId,
        conversationKey,
        deduplicationKey,
        payload,
        requestHeaders,
      ] = values;

      const exists = store.rows.find(
        (r) => r.provider === provider && r.deduplication_key === deduplicationKey,
      );
      if (exists) return Promise.resolve([]);

      const row = {
        id: `inbox-${store.rows.length + 1}`,
        provider,
        event_type: eventType,
        company_id: companyId,
        channel_id: channelId,
        instance_name: instanceName,
        external_event_id: externalEventId,
        external_message_id: externalMessageId,
        conversation_key: conversationKey,
        deduplication_key: deduplicationKey,
        payload,
        request_headers: requestHeaders,
        status: "pending",
        received_at: new Date().toISOString(),
      };
      store.rows.push(row);
      return Promise.resolve([{ id: row.id, received_at: row.received_at }]);
    }

    if (text.includes("FROM public.webhook_inbox")) {
      const [provider, deduplicationKey] = values;
      const found = store.rows.find(
        (r) => r.provider === provider && r.deduplication_key === deduplicationKey,
      );
      return Promise.resolve(found ? [{ id: found.id, received_at: found.received_at }] : []);
    }

    if (text.includes("INSERT INTO public.webhook_outbox")) {
      if (options.failOnOutboxInsert) {
        return Promise.reject(new Error(options.outboxFailMessage ?? "outbox indisponivel"));
      }
      state.outboxInsertValues = values;
      const [inboxId, exchangeName, routingKey, messagePayload] = values;

      const exists = store.outbox.find(
        (r) => r.inbox_id === inboxId && r.routing_key === routingKey,
      );
      if (exists) return Promise.resolve([]);

      const row = {
        id: `outbox-${store.outbox.length + 1}`,
        inbox_id: inboxId,
        exchange_name: exchangeName,
        routing_key: routingKey,
        message_payload: messagePayload,
        status: "pending",
        attempts: 0,
      };
      store.outbox.push(row);
      return Promise.resolve([{ id: row.id }]);
    }

    if (text.includes("FROM public.webhook_outbox")) {
      const [inboxId, routingKey] = values;
      const found = store.outbox.find(
        (r) => r.inbox_id === inboxId && r.routing_key === routingKey,
      );
      return Promise.resolve(found ? [{ id: found.id }] : []);
    }

    return Promise.resolve([]);
  };

  tx.unsafe = (q) => {
    state.unsafeCalls.push(q);
    return Promise.resolve([]);
  };

  const sql = {
    begin: async (fn) => {
      if (options.failOnBegin) {
        throw new Error(options.failMessage ?? "connection terminated");
      }
      // Snapshot para ROLLBACK: as tabelas só recebem append na ingestão.
      const snapshotRows = store.rows.slice();
      const snapshotOutbox = store.outbox.slice();
      try {
        const result = await fn(tx);
        if (options.commitDelayMs) {
          await new Promise((r) => setTimeout(r, options.commitDelayMs));
        }
        state.commits += 1;
        state.committedAt = Date.now();
        return result;
      } catch (e) {
        store.rows.length = 0;
        store.rows.push(...snapshotRows);
        store.outbox.length = 0;
        store.outbox.push(...snapshotOutbox);
        state.rollbacks += 1;
        throw e;
      }
    },
  };

  return { sql, state };
}
