const MIN_ATTEMPTS = 1
const MAX_ATTEMPTS = 200
const STEP = 10

interface Props {
  value: number
  onChange: (value: number) => void
  disabled: boolean
}

export function MaxAttemptsControl({ value, onChange, disabled }: Props) {
  const clamp = (n: number) => Math.min(MAX_ATTEMPTS, Math.max(MIN_ATTEMPTS, n))

  return (
    <div>
      <input
        type="number"
        min={MIN_ATTEMPTS}
        max={MAX_ATTEMPTS}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value) || MIN_ATTEMPTS))}
        disabled={disabled}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500 disabled:opacity-50"
      />
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={() => onChange(clamp(value - STEP))}
          disabled={disabled || value <= MIN_ATTEMPTS}
          className="rounded-md border border-zinc-700 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          −10
        </button>
        <button
          type="button"
          onClick={() => onChange(clamp(value + STEP))}
          disabled={disabled || value >= MAX_ATTEMPTS}
          className="rounded-md border border-zinc-700 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          +10
        </button>
      </div>
    </div>
  )
}
