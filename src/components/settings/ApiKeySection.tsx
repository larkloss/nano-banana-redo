import { useState } from 'react'

interface Props {
  apiKeys: [string, string]
  onChange: (index: 0 | 1, key: string) => void
}

export function ApiKeySection({ apiKeys, onChange }: Props) {
  return (
    <div className="space-y-3">
      <KeyInput
        label="API key 1"
        value={apiKeys[0]}
        onSave={(key) => onChange(0, key)}
      />
      <KeyInput
        label="API key 2 · optional"
        hint="Adds a second parallel generation lane"
        value={apiKeys[1]}
        onSave={(key) => onChange(1, key)}
      />
      <p className="text-[10px] leading-snug text-zinc-600">
        Keys are stored in this browser's localStorage and sent directly to the Gemini API. Fine
        for personal use — never deploy this app publicly with your keys. For real double
        throughput, the two keys must belong to different Google Cloud projects (rate limits are
        per project, not per key).
      </p>
    </div>
  )
}

function KeyInput({
  label,
  hint,
  value,
  onSave,
}: {
  label: string
  hint?: string
  value: string
  onSave: (key: string) => void
}) {
  const [show, setShow] = useState(false)
  const [draft, setDraft] = useState(value)
  const dirty = draft !== value

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">{label}</span>
        <span className={`text-[10px] ${value ? 'text-emerald-400' : 'text-zinc-600'}`}>
          {value ? 'Key set' : 'Key missing'}
        </span>
      </div>
      <div className="flex gap-1.5">
        <input
          type={show ? 'text' : 'password'}
          value={draft}
          onChange={(e) => setDraft(e.target.value.trim())}
          placeholder="AIza…"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="rounded-md border border-zinc-700 px-2 py-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
          title={show ? 'Hide key' : 'Show key'}
        >
          {show ? 'Hide' : 'Show'}
        </button>
        <button
          type="button"
          onClick={() => onSave(draft)}
          disabled={!dirty}
          className="rounded-md bg-blue-600 px-2.5 py-1.5 text-[10px] font-medium text-white hover:bg-blue-500 disabled:cursor-default disabled:opacity-40"
        >
          Save
        </button>
      </div>
      {hint && <p className="mt-1 text-[10px] text-zinc-600">{hint}</p>}
    </div>
  )
}
