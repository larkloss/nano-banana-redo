import { useState } from 'react'

interface Props {
  apiKey: string
  onChange: (key: string) => void
}

export function ApiKeySection({ apiKey, onChange }: Props) {
  const [show, setShow] = useState(false)
  const [draft, setDraft] = useState(apiKey)
  const dirty = draft !== apiKey

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">API key</span>
        <span className={`text-[10px] ${apiKey ? 'text-emerald-400' : 'text-amber-400'}`}>
          {apiKey ? 'Key set' : 'Key missing'}
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
          onClick={() => onChange(draft)}
          disabled={!dirty}
          className="rounded-md bg-blue-600 px-2.5 py-1.5 text-[10px] font-medium text-white hover:bg-blue-500 disabled:cursor-default disabled:opacity-40"
        >
          Save
        </button>
      </div>
      <p className="text-[10px] leading-snug text-zinc-600">
        Stored in this browser's localStorage and sent directly to the Gemini API. Fine for personal
        use — never deploy this app publicly with your key.
      </p>
    </div>
  )
}
