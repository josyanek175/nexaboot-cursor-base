import { BLOCKS, type BlockType } from "@/components/automation-flow/flow-model";

export function FlowBlockLibrary({ onAdd }: { onAdd: (type: BlockType) => void }) {
  return (
    <aside className="w-56 shrink-0 overflow-y-auto border-r border-border bg-card p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Etapas</p>
      <div className="flex flex-col gap-2">
        {BLOCKS.map((block) => (
          <button
            key={block.type}
            type="button"
            onClick={() => onAdd(block.type)}
            className="rounded-2xl border border-border bg-background px-3 py-2 text-left hover:border-whatsapp"
          >
            <div className="text-sm font-medium">{block.label}</div>
            <div className="text-[11px] text-muted-foreground">{block.hint}</div>
          </button>
        ))}
      </div>
    </aside>
  );
}
