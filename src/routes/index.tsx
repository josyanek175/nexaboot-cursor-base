import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/")({
  component: IndexRedirect,
});

function IndexRedirect() {
  const { isAuthenticated, hydrated } = useAuth();
  if (!hydrated) return null;
  return <Navigate to={isAuthenticated ? "/atendimento" : "/login"} />;
}
