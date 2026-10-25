import { PGlite } from "@electric-sql/pglite";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import ts from "typescript";
const require = createRequire(import.meta.url);
export function tsLoader(overrides = {}) {
  const cache = new Map();
  function load(path) {
    path = resolve(path);
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    const code = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    new Function("require", "module", "exports", code)(
      (name) => {
        if (name in overrides) return overrides[name];
        if (name.startsWith("@/") || name.startsWith(".")) {
          const base = name.startsWith("@/")
            ? resolve("src", name.slice(2))
            : resolve(dirname(path), name);
          const found = [base, base + ".ts", base + ".tsx"].find(existsSync);
          if (!found) throw new Error("Unresolved test import: " + name);
          return load(found);
        }
        return require(name);
      },
      module,
      module.exports,
    );
    return module.exports;
  }
  return load;
}
export async function isolatedPostgres() {
  const pg = new PGlite();
  await pg.waitReady;
  const marker = Symbol("sql-fragment");
  function adapter(connection) {
    function db(strings, ...values) {
      if (!strings?.raw) return db;
      const q = {
        [marker]: true,
        strings,
        values,
        then(onValue, onError) {
          const params = [];
          function render(query) {
            return query.strings.reduce((out, part, index) => {
              if (index === query.values.length) return out + part;
              const value = query.values[index];
              if (value?.[marker]) return out + part + render(value);
              params.push(
                value instanceof Date
                  ? value.toISOString()
                  : value && typeof value === "object" && !Array.isArray(value)
                    ? JSON.stringify(value)
                    : value,
              );
              return out + part + "$" + params.length;
            }, "");
          }
          return connection
            .query(render(q), params)
            .then((r) => r.rows)
            .then(onValue, onError);
        },
      };
      return q;
    }
    db.begin = (fn) => connection.transaction((tx) => fn(adapter(tx)));
    db.unsafe = (query, params = []) => connection.query(query, params).then((r) => r.rows);
    return db;
  }
  const db = adapter(pg);
  await pg.exec(`
    CREATE TABLE companies(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,active boolean DEFAULT true,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES companies(id),name text,email text,password_hash text,role text,active boolean DEFAULT true,tenant_id text DEFAULT 'default',updated_at timestamptz DEFAULT now());
    CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES companies(id),name text,phone text,external_jid text,name_source text,reference text,whatsapp_profile_name text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE internal_chats(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES companies(id),name text,type text,created_by uuid,created_at timestamptz DEFAULT now());
    CREATE TABLE internal_chat_members(chat_id uuid REFERENCES internal_chats(id),user_id uuid REFERENCES users(id),last_read_at timestamptz,PRIMARY KEY(chat_id,user_id));
    CREATE TABLE whatsapp_channels(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES companies(id),name text,channel_type text DEFAULT 'meta',active boolean DEFAULT true,deleted_at timestamptz);
    CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES companies(id),contact_id uuid REFERENCES contacts(id),whatsapp_channel_id uuid REFERENCES whatsapp_channels(id),status text,unread_count integer DEFAULT 0,last_message_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),campaign_reply_campaign_id uuid,campaign_service_status text);
    CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid REFERENCES conversations(id),direction text,message_type text,message_text text,from_me boolean,status text,sent_by_user_id uuid,sent_by_name text,external_message_id text,raw_payload jsonb,created_at timestamptz DEFAULT now());
    CREATE TABLE conversation_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid REFERENCES conversations(id),user_id uuid,active boolean DEFAULT true,assigned_at timestamptz DEFAULT now(),unassigned_at timestamptz);
    CREATE TABLE automation_sessions(conversation_id uuid PRIMARY KEY,company_id uuid,flow_id uuid,contact_id uuid,channel_id uuid,step_id text,status text,collected jsonb DEFAULT '{}',source text,updated_at timestamptz DEFAULT now());
  `);
  await pg.exec(readFileSync("scripts/migrations/20261025_company_operations.sql", "utf8"));
  return { pg, db };
}
