import { useState } from 'react'
import { DEFAULT_LOCATOR_MODEL, LOCATOR_MODELS } from '../../lib/locate'

interface Props {
  // '' = the default model
  value: string
  onChange: (modelId: string) => void
}

const OTHER = '\u0000other'

// Which Gemini model "find the object" asks. A real menu, so every model is
// on offer whatever is chosen now — the text field with suggestions this used
// to be only suggested what matched the text already in it, so once a model
// was picked the others could not be reached. Any other model ID can still be
// typed, through "Other model…".
export function LocatorModelPicker({ value, onChange }: Props) {
  const listed = value === '' || LOCATOR_MODELS.includes(value)
  const [typing, setTyping] = useState(!listed)
  const title =
    'The Gemini model that looks at the picture and says where things are — any one that understands images. ' +
    'gemini-4-carbon is asked to think at “low” (finding a box is a light job, and its thinking is billed); ' +
    'other models think at their own default.'
  const look =
    'rounded-full border border-zinc-700 bg-zinc-950 py-1 text-[11px] text-zinc-300 outline-none focus:border-blue-500'

  if (typing) {
    return (
      <span className="flex items-center gap-1">
        <input
          type="text"
          autoFocus
          // (what is there is the model picked before: typing replaces it)
          onFocus={(e) => e.target.select()}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="model ID"
          spellCheck={false}
          aria-label="Gemini model that finds the object (typed)"
          title={`${title} Empty: ${DEFAULT_LOCATOR_MODEL}.`}
          className={`${look} w-36 px-2.5 placeholder-zinc-600`}
        />
        <button
          type="button"
          onClick={() => setTyping(false)}
          title="Back to the list of models"
          aria-label="Back to the list of models"
          className="rounded-full border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          ▾ list
        </button>
      </span>
    )
  }
  return (
    <select
      value={value || DEFAULT_LOCATOR_MODEL}
      onChange={(e) => {
        if (e.target.value === OTHER) setTyping(true)
        else onChange(e.target.value)
      }}
      aria-label="Gemini model that finds the object"
      title={title}
      className={`${look} max-w-44 pl-2.5 pr-1`}
    >
      {LOCATOR_MODELS.map((id) => (
        <option key={id} value={id}>
          {id === DEFAULT_LOCATOR_MODEL ? `${id} (default)` : id}
        </option>
      ))}
      {/* (one typed earlier stays on offer) */}
      {!listed && <option value={value}>{value}</option>}
      <option value={OTHER}>Other model…</option>
    </select>
  )
}
