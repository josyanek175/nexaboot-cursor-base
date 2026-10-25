import { createFileRoute } from "@tanstack/react-router";

// Legacy public demo seeding could replace existing users and passwords.
// It must never write to a deployed database, regardless of environment flags.
const disabled = () =>
  Response.json(
    {
      error: "demo_seed_disabled",
      message: "Cadastro de demonstração desativado. Use a administração da plataforma.",
    },
    { status: 410 },
  );
export const Route = createFileRoute("/api/admin/seed-demo")({
  server: { handlers: { GET: disabled, POST: disabled } },
});
