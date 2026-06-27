import { Construction } from "lucide-react";

export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-accent text-accent-foreground">
          <Construction className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <p className="mt-4 text-xs text-muted-foreground">
          Este módulo será detalhado nas próximas fases do projeto.
        </p>
      </div>
    </div>
  );
}
