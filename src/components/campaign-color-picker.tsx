import { CAMPAIGN_COLOR_PALETTE, DEFAULT_CAMPAIGN_COLOR } from "@/lib/campaign-color";

type Props = {
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
};

export function CampaignColorPicker({ value, onChange, disabled }: Props) {
  const current = value || DEFAULT_CAMPAIGN_COLOR;

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground">Cor da campanha</label>
      <div className="flex flex-wrap gap-2">
        {CAMPAIGN_COLOR_PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            disabled={disabled}
            title={c}
            onClick={() => onChange(c)}
            className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-105 disabled:opacity-50 ${
              current.toUpperCase() === c.toUpperCase()
                ? "border-foreground ring-2 ring-ring ring-offset-2"
                : "border-transparent"
            }`}
            style={{ backgroundColor: c }}
          />
        ))}
        <label
          className={`relative flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-input bg-background text-[10px] text-muted-foreground ${
            disabled ? "pointer-events-none opacity-50" : ""
          }`}
          title="Cor personalizada"
        >
          +
          <input
            type="color"
            disabled={disabled}
            value={current}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Cor exibida na fila de respostas e no atendimento. Atual: <code>{current}</code>
      </p>
    </div>
  );
}
